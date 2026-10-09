"""Training data for the v2c student round (runtime v2.2/v2.3 conventions on existing rows).

    # workbench, from SIM's collected gold gz shards (keeps meta.patterns long enough for the retry rule):
    python training/prep_v2c.py simraw --src data/sim2raw --out data/s3/sim2r [--keep-inconsistency 0.6]
    # (`sim` = same from already-prepared shards, whose meta.patterns were dropped → every POST/PATCH counts as unkeyed)
    # workbench, from SIM's on-policy batch (gz shards + manifest):
    python training/prep_v2c.py onpol --src data/onparaw --name onpa

`sim`: applies the situation-v2.2 retry applicability to each row (see fit_gates.retry_unoffered_v22: POST/PATCH without
an idempotency key → `retry` leaves the action question's criteria and its label; the remaining label mass is
renormalised, or — if retry held all of it — becomes one-hot on the cheapest remaining action incl. premium), and keeps
only a deterministic share of `inconsistency`-trigger rows (v2.3 no longer raises most coincidental relations).
`onpol`: same retry rule (uses `meta.request` when present: method + idempotency-key header), splits train rows into
data/s3/<name> (ordinary) and data/s3/<name>x (false_intervention, ran_harm > 1 or miss — up-weighted by the mixture),
and writes eval sets data/<name>e/{dev,test}.jsonl (8k / 20k) + _t0..3 / _d0..1 shards.
"""

from __future__ import annotations

import argparse
import gzip
import json
import random
import zlib
from multiprocessing import Pool
from pathlib import Path

from fit_gates import PREM, retry_unoffered_v22


def retry_unoffered(r: dict) -> bool:
    m = r.get("meta") or {}
    req = m.get("request")
    if isinstance(req, dict) and req.get("method"):
        meth = str(req["method"]).upper()
        if meth in ("GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"):
            return False
        hdrs = {str(h).lower() for h in (req.get("headers") or [])}
        return not (req.get("idempotencyKey") or hdrs & {"idempotency-key", "x-idempotency-key"})
    return retry_unoffered_v22(r.get("state"), m)


def apply_retry_rule(r: dict) -> bool:
    q = (r.get("questions") or {}).get("action")
    if not q or "retry" not in (q.get("criteria") or {}) or not retry_unoffered(r):
        return False
    q["criteria"] = {k: v for k, v in q["criteria"].items() if k != "retry"}
    lab = (r.get("labels") or {}).get("action")
    if lab and isinstance(lab.get("dist"), dict):
        d = {k: v for k, v in lab["dist"].items() if k != "retry"}
        s = sum(d.values())
        if s > 1e-6:
            lab["dist"] = {k: round(v / s, 6) for k, v in d.items()}
        else:
            m = r.get("meta") or {}
            costs, tiers = m.get("costs") or {}, m.get("tiers") or {}
            opts = [k for k in d if k in costs]
            best = min(opts, key=lambda a: costs[a] + PREM.get(tiers.get(a, "heal"), 0.5)) if opts else m.get("passive")
            lab["dist"] = {k: (1.0 if k == best else 0.0) for k in d}
    elif lab and lab.get("label") == "retry":
        lab["label"] = (r.get("meta") or {}).get("passive")
    (r.setdefault("meta", {}))["v22_retry_removed"] = True
    return True


def keep_row(r: dict, keep_inc: float) -> bool:
    if (r.get("meta") or {}).get("trigger") != "inconsistency":
        return True
    return zlib.crc32(str(r.get("id")).encode()) % 10_000 < keep_inc * 10_000


def do_sim(args: tuple) -> tuple[int, int, int]:
    src, dst, keep_inc = args
    n = kept = changed = 0
    with open(src) as f, open(dst, "w") as g:
        for line in f:
            r = json.loads(line)
            n += 1
            if not keep_row(r, keep_inc):
                continue
            changed += apply_retry_rule(r)
            kept += 1
            g.write(json.dumps(r, ensure_ascii=False) + "\n")
    return n, kept, changed


def do_simraw(args: tuple) -> tuple[int, int, int]:
    """Collected SIM gold gz shard → k train shards, retry rule (needs meta.patterns, dropped afterwards), fewer
    inconsistency rows."""
    src, out, i, k, keep_inc = args
    outs = [open(out / f"shard{i * k + j:03d}.jsonl", "w") for j in range(k)]
    n = kept = changed = 0
    with gzip.open(src, "rt") as f:
        for line in f:
            r = json.loads(line)
            n += 1
            if not keep_row(r, keep_inc):
                continue
            changed += apply_retry_rule(r)
            m = r.get("meta") or {}
            for key in ("cost_parts", "patterns", "adjusted", "se", "program_family"):
                m.pop(key, None)
            outs[kept % k].write(json.dumps(r, ensure_ascii=False) + "\n")
            kept += 1
    for o in outs:
        o.close()
    return n, kept, changed


def flagged(m: dict) -> bool:
    h = m.get("ran_harm")
    return bool(m.get("false_intervention")) or bool(m.get("miss")) or (isinstance(h, (int, float)) and h > 1)


def do_onpol(args: tuple) -> dict:
    src, out_a, out_x, i, k = args
    outs_a = [open(out_a / f"shard{i * k + j:03d}.jsonl", "w") for j in range(k)]
    outs_x = [open(out_x / f"shard{i * k + j:03d}.jsonl", "w") for j in range(k)]
    st = {"rows": 0, "flagged": 0, "retry_removed": 0}
    with gzip.open(src, "rt") as f:
        for line in f:
            r = json.loads(line)
            st["rows"] += 1
            st["retry_removed"] += apply_retry_rule(r)
            m = r.get("meta") or {}
            for key in ("cost_parts", "patterns", "adjusted", "se", "program_family"):
                m.pop(key, None)
            fl = flagged(m)
            st["flagged"] += fl
            (outs_x if fl else outs_a)[st["rows"] % k].write(json.dumps(r, ensure_ascii=False) + "\n")
    for o in outs_a + outs_x:
        o.close()
    return st


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["sim", "simraw", "onpol"])
    ap.add_argument("--in", dest="inp", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--src", type=Path)
    ap.add_argument("--name", default="onpa")
    ap.add_argument("--root", type=Path, default=Path("data"))
    ap.add_argument("--keep-inconsistency", type=float, default=0.6)
    ap.add_argument("--workers", type=int, default=64)
    a = ap.parse_args()
    if a.mode == "simraw":
        a.out.mkdir(parents=True, exist_ok=True)
        trains = sorted(a.src.glob("train-*.jsonl.gz"))
        with Pool(min(a.workers, len(trains))) as p:
            res = p.map(do_simraw, [(str(f), a.out, i, 8, a.keep_inconsistency) for i, f in enumerate(trains)])
        print(json.dumps({"rows": sum(x[0] for x in res), "kept": sum(x[1] for x in res), "retry_removed": sum(x[2] for x in res)}))
        return
    if a.mode == "sim":
        a.out.mkdir(parents=True, exist_ok=True)
        files = sorted(a.inp.glob("*.jsonl"))
        with Pool(a.workers) as p:
            res = p.map(do_sim, [(str(f), str(a.out / f.name), a.keep_inconsistency) for f in files])
        print(json.dumps({"rows": sum(x[0] for x in res), "kept": sum(x[1] for x in res), "retry_removed": sum(x[2] for x in res)}))
        return
    out_a, out_x = a.root / "s3" / a.name, a.root / "s3" / f"{a.name}x"
    for d in (out_a, out_x):
        d.mkdir(parents=True, exist_ok=True)
    trains = sorted(a.src.glob("train-*.jsonl.gz"))
    with Pool(min(a.workers, len(trains))) as p:
        res = p.map(do_onpol, [(str(f), out_a, out_x, i, 16) for i, f in enumerate(trains)])
    # eval sets (retry rule applied: what v2.2 would offer)
    def sample(split: str, n: int) -> list[str]:
        rows = []
        for f in sorted(a.src.glob(f"{split}-*.jsonl.gz")):
            with gzip.open(f, "rt") as g:
                rows += g.readlines()
        random.Random(11).shuffle(rows)
        out = []
        for line in rows[:n]:
            r = json.loads(line)
            apply_retry_rule(r)
            out.append(json.dumps(r, ensure_ascii=False) + "\n")
        return out
    test, dev = sample("test", 20_000), sample("dev", 8_000)
    e = a.root / f"{a.name}e"
    e.mkdir(parents=True, exist_ok=True)
    (e / "test.jsonl").write_text("".join(test))
    (e / "dev.jsonl").write_text("".join(dev))
    for i in range(4):
        (a.root / f"{a.name}e_t{i}").mkdir(exist_ok=True)
        (a.root / f"{a.name}e_t{i}" / "test.jsonl").write_text("".join(test[i::4]))
    for i in range(2):
        (a.root / f"{a.name}e_d{i}").mkdir(exist_ok=True)
        (a.root / f"{a.name}e_d{i}" / "dev.jsonl").write_text("".join(dev[i::2]))
    print(json.dumps({k: sum(x[k] for x in res) for k in res[0]} | {"eval_test": len(test), "eval_dev": len(dev)}))


if __name__ == "__main__":
    main()
