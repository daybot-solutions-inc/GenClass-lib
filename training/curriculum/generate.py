"""Generate the stage-1 curriculum as CONTRACT-D jsonl (train/dev/test), in parallel, deterministic per seed.

    python training/curriculum/generate.py --out ~/gcl-train/data/cur1 --n 600000 --seed 1 --workers 64

Splits: test rows come only from held-out domains (vocab.TEST_DOMAINS) and may use held-out paraphrase templates;
dev rows are a random slice of train domains with train templates. Every row is validated with the jev_local schema
and the trainer's own label parser before it is written (bad rows are counted and dropped).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from collections import Counter, defaultdict
from multiprocessing import Pool
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(Path.home() / "jev"))

import rows as R  # noqa: E402
import scen_ops  # noqa: E402
import scen_state  # noqa: E402
import scenarios  # noqa: E402
import standalone as S  # noqa: E402
from app import App  # noqa: E402
from fmt import Style, js_numbers  # noqa: E402
from vocab import DOMAINS, TEST_DOMAINS  # noqa: E402

TRIGGERS = {"mutation": (scenarios.mutation, 0.26), "request": (scen_ops.request, 0.20),
            "failure": (scen_ops.failure, 0.18), "stall": (scen_ops.stall, 0.12),
            "inconsistency": (scen_state.inconsistency, 0.09), "transition": (scen_state.transition, 0.08),
            "error": (scen_state.error, 0.07)}
KINDS = (("decision", 0.58), ("ask", 0.14), ("json", 0.10), ("http", 0.08), ("js", 0.04), ("decide", 0.06))

TRAIN_DOMAINS = [d for d in DOMAINS if d.key not in TEST_DOMAINS]
HELD_DOMAINS = [d for d in DOMAINS if d.key in TEST_DOMAINS]


P_RUNTIME = float(os.environ.get("GC_P_RUNTIME", "0"))


def make_row(rng: random.Random, split: str) -> dict | None:
    test = split == "test"
    dom = rng.choice(HELD_DOMAINS if test else TRAIN_DOMAINS)
    app = App(rng, dom)
    st = Style.make(rng, test)
    kind = rng.choices([k for k, _ in KINDS], [w for _, w in KINDS])[0]
    if kind in ("decision", "ask"):
        trig = rng.choices(list(TRIGGERS), [w for _, w in TRIGGERS.values()])[0]
        sc = TRIGGERS[trig][0](rng, app, st)
        return R.decision_row(sc, app, st, rng, P_RUNTIME) if kind == "decision" else R.ask_row(sc, app, st, rng)
    if kind == "json":
        return S.json_invariants(rng, app, st)
    if kind == "http":
        return S.http_semantics(rng, app, st)
    if kind == "js":
        return S.js_errors(rng, app, st)
    return S.described_options(rng, app, st)


def _validate(row: dict) -> str | None:
    from jev_local.schema import question_from_json
    from jev_local.serialize import question_block, state_segments
    from jev_local.train.train import parse_target

    try:
        state_segments(row["state"])
        blocks = {qid: question_block(qid, question_from_json(q)) for qid, q in row["questions"].items()}
    except Exception as e:  # noqa: BLE001
        return f"schema: {e}"
    for qid, lab in row["labels"].items():
        if qid not in blocks:
            return f"label for unknown qid {qid}"
        if parse_target(blocks[qid], lab) is None:
            return f"bad label {qid}: {lab}"
    if not row["labels"]:
        return "no labels"
    return None


def work(args: tuple) -> dict:
    split, chunk, n, seed, out_dir = args
    rng = random.Random(f"{seed}:{split}:{chunk}")
    path = Path(out_dir) / f".{split}.{chunk:05d}.jsonl"
    stats = {"rows": 0, "bad": Counter(), "family": Counter(), "trigger": Counter(), "passive": Counter(),
             "action_gold": Counter(), "diag_gold": Counter(), "errors": Counter()}
    with path.open("w") as f:
        i = 0
        tries = 0
        while i < n and tries < n * 3:
            tries += 1
            try:
                row = make_row(rng, split)
            except Exception as e:  # noqa: BLE001  (a generator bug: count it, keep going, never emit)
                stats["errors"][f"{type(e).__name__}: {str(e)[:80]}"] += 1
                continue
            if row is None:
                continue
            bad = _validate(row)
            if bad:
                stats["bad"][bad[:80]] += 1
                continue
            rid = f"cur-{split}-{chunk:05d}-{i:06d}"
            out = {"id": rid, "split": split, "family": row["family"], "state": js_numbers(row["state"]),
                   "questions": js_numbers(row["questions"]), "labels": row["labels"], "meta": row["meta"]}
            f.write(json.dumps(out, ensure_ascii=False) + "\n")
            i += 1
            m = row["meta"]
            stats["family"][row["family"].rsplit("/", 1)[0]] += 1
            if m.get("kind") == "decision":
                stats["trigger"][m["trigger"]] += 1
                stats["passive"][f"{m['trigger']}:{int(m['passive_best'])}"] += 1
                stats["action_gold"][f"{m['trigger']}:{m['action_canonical']}"] += 1
                stats["diag_gold"][f"{m['trigger']}:{m['diag_gold']}"] += 1
        stats["rows"] = i
    return {"split": split, "chunk": chunk, "path": str(path), "stats": {k: (dict(v) if isinstance(v, Counter) else v)
                                                                         for k, v in stats.items()}}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--n", type=int, default=600_000, help="train rows")
    ap.add_argument("--dev", type=int, default=None, help="dev rows (default 2%% of n, min 2000)")
    ap.add_argument("--test", type=int, default=None, help="test rows (default 4%% of n, min 4000)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 8)
    ap.add_argument("--chunk", type=int, default=5000)
    ap.add_argument("--p-runtime", type=float, default=0.0,
                    help="share of decision rows rendered exactly like @genclass/runtime (rt.py)")
    args = ap.parse_args()
    os.environ["GC_P_RUNTIME"] = str(args.p_runtime)  # read by workers (spawned or forked after this point)
    global P_RUNTIME
    P_RUNTIME = args.p_runtime
    out = args.out.expanduser()
    out.mkdir(parents=True, exist_ok=True)
    n_dev = args.dev if args.dev is not None else max(2000, args.n // 50)
    n_test = args.test if args.test is not None else max(4000, args.n // 25)
    jobs = []
    for split, n in (("train", args.n), ("dev", n_dev), ("test", n_test)):
        for c in range(0, n, args.chunk):
            jobs.append((split, c // args.chunk, min(args.chunk, n - c), args.seed, str(out)))
    t0 = time.time()
    with Pool(args.workers) as pool:
        res = pool.map(work, jobs, chunksize=1)
    total = defaultdict(lambda: defaultdict(Counter))
    for split in ("train", "dev", "test"):
        parts = sorted((r for r in res if r["split"] == split), key=lambda r: r["chunk"])
        with (out / f"{split}.jsonl").open("w") as f:
            for r in parts:
                with open(r["path"]) as g:
                    for line in g:
                        f.write(line)
                os.remove(r["path"])
                for k, v in r["stats"].items():
                    if isinstance(v, dict):
                        total[split][k].update(v)
                    else:
                        total[split][k]["n"] += v
    summary = {"seconds": round(time.time() - t0, 1), "args": {k: str(v) for k, v in vars(args).items()},
               "test_domains": sorted(TEST_DOMAINS)}
    for split, d in total.items():
        summary[split] = {k: dict(sorted(v.items())) for k, v in d.items()}
        pas = d["passive"]
        by_t = {}
        for t in TRIGGERS:
            a, b = pas.get(f"{t}:1", 0), pas.get(f"{t}:0", 0)
            if a + b:
                by_t[t] = round(a / (a + b), 3)
        summary[split]["passive_best_fraction"] = by_t
    (out / "stats.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps({s: {"rows": summary[s]["rows"]["n"], "bad": sum(summary[s]["bad"].values()),
                          "errors": sum(summary[s]["errors"].values()), "passive": summary[s]["passive_best_fraction"]}
                      for s in ("train", "dev", "test") if s in summary}, indent=1))
    print(f"done in {summary['seconds']} s -> {out}")


if __name__ == "__main__":
    main()
