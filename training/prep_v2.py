"""Prepare a collected SIM batch (gz shards + manifest, `sim/scripts/cluster/collect.py`) for training and evaluation.

    python training/prep_v2.py --src data/sim2raw --name sim2 [--shards-per-file 8] [--workers 32]

Writes (relative to ~/gcl-train):
  data/s3/<name>/shardNNN.jsonl       train rows (trainer stream bucket <name>), heavy meta dropped
  data/<name>e/{dev,test}.jsonl       eval set: ≈ 8k dev rows, ≈ 20k test rows (test = SIM's held-out split)
  data/<name>f/{dev,test}.jsonl       held-out-features eval set: ≈ 20k test rows whose family contains a
                                      TEST_FEATURES feature (same dev rows for calibration)
  data/<name>{e,f}_t{0..3}/test.jsonl, data/<name>{e,f}_d{0,1}/dev.jsonl   shards for eval_sim.sh
Sampling is by crc32(id), so it is deterministic and independent of shard order.
"""

from __future__ import annotations

import argparse
import gzip
import json
import random
import zlib
from multiprocessing import Pool
from pathlib import Path

DROP_TRAIN = ("cost_parts", "patterns", "adjusted", "se", "program_family")
TEST_FEATURES = {"swcache", "presence", "cascade", "saga", "prefetch", "permissions"}  # sim/src/world/scenario.ts


def h(rid: str) -> int:
    return zlib.crc32(rid.encode()) % 100_000


def do_train(args: tuple) -> int:
    src, out_dir, base, k = args
    outs = [open(out_dir / f"shard{base + i:03d}.jsonl", "w") for i in range(k)]
    n = 0
    with gzip.open(src, "rt") as f:
        for line in f:
            r = json.loads(line)
            m = r.get("meta") or {}
            for key in DROP_TRAIN:
                m.pop(key, None)
            outs[n % k].write(json.dumps(r, ensure_ascii=False) + "\n")
            n += 1
    for o in outs:
        o.close()
    return n


def do_eval(args: tuple) -> tuple[list[str], list[str], int]:
    src, split, rate_e, rate_f = args
    e, f_, n = [], [], 0
    with gzip.open(src, "rt") as f:
        for line in f:
            n += 1
            rid = line[line.index('"id"') + 5:].split('"')[1]
            x = h(rid)
            if x >= max(rate_e, rate_f):
                continue
            r = json.loads(line)
            if x < rate_e:
                e.append(line)
            if split == "test" and x < rate_f:
                fam = str(r.get("family") or (r.get("meta") or {}).get("family") or "")
                if any(k in TEST_FEATURES for k in fam.split("+")):
                    f_.append(line)
    return e, f_, n


def write_set(root: Path, name: str, dev: list[str], test: list[str]) -> None:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "dev.jsonl").write_text("".join(dev))
    (d / "test.jsonl").write_text("".join(test))
    for i in range(4):
        (root / f"{name}_t{i}").mkdir(exist_ok=True)
        (root / f"{name}_t{i}" / "test.jsonl").write_text("".join(test[i::4]))
    for i in range(2):
        (root / f"{name}_d{i}").mkdir(exist_ok=True)
        (root / f"{name}_d{i}" / "dev.jsonl").write_text("".join(dev[i::2]))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--root", type=Path, default=Path("data"))
    ap.add_argument("--shards-per-file", type=int, default=8)
    ap.add_argument("--workers", type=int, default=32)
    ap.add_argument("--test-rows", type=int, default=20_000)
    ap.add_argument("--dev-rows", type=int, default=8_000)
    a = ap.parse_args()
    man = json.loads((a.src / "manifest.json").read_text())
    rows = man["rows"]
    out = a.root / "s3" / a.name
    out.mkdir(parents=True, exist_ok=True)
    trains = sorted(a.src.glob("train-*.jsonl.gz"))
    k = a.shards_per_file
    # held-out-feature rows are a minority of test: oversample 6x, then cut to --test-rows
    rate_te = max(1, round(100_000 * a.test_rows / max(rows["test"], 1)))
    rate_dev = max(1, round(100_000 * a.dev_rows / max(rows["dev"], 1)))
    rate_tf = min(100_000, rate_te * 6)
    jobs_eval = [(str(p), "test", rate_te, rate_tf) for p in sorted(a.src.glob("test-*.jsonl.gz"))]
    jobs_eval += [(str(p), "dev", rate_dev, 0) for p in sorted(a.src.glob("dev-*.jsonl.gz"))]
    with Pool(a.workers) as pool:
        ev = pool.map_async(do_eval, jobs_eval)
        n_train = sum(pool.map(do_train, [(str(p), out, i * k, k) for i, p in enumerate(trains)]))
        ev = ev.get()
    test_e, test_f, dev = [], [], []
    for (e, f_, _), job in zip(ev, jobs_eval):
        if job[1] == "test":
            test_e += e
            test_f += f_
        else:
            dev += e
    rng = random.Random(7)
    rng.shuffle(test_f)
    test_f = test_f[: a.test_rows]
    write_set(a.root, f"{a.name}e", dev, test_e)
    write_set(a.root, f"{a.name}f", dev, test_f)
    print(json.dumps({"train_rows": n_train, "train_shards": len(trains) * k, "eval_test": len(test_e),
                      "eval_dev": len(dev), "heldout_feature_test": len(test_f)}))


if __name__ == "__main__":
    main()
