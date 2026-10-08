"""Soft-label CONTRACT-D rows with a (teacher) checkpoint: batched forward, calibrated probabilities as labels.

    python training/label_teacher.py --ckpt models/t150-g1 --in data/unlab/shard07.jsonl --out data/tl/shard07.jsonl \
        [--calibration out/cal/t150-g1-simAe.json] [--qids action,diagnosis] [--batch 32] [--threads 16]

For every row, every question (or only --qids) gets a teacher label: choice → {"type":"choice","dist":{label: p}},
score → {"type":"score","dist":[...]}, noul → {"type":"noul","p": p}, using the checkpoint's calibration.json or
--calibration. Gold labels already present are kept unless --overwrite. `meta.teacher` records the checkpoint name,
and per question the top probability, the margin to the runner-up, and the summed non-passive action mass.
Resumable: an existing --out file is continued after its last complete line (rows are processed in input order).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path.home() / "jev"))

PASSIVE = {"apply", "send", "deliver", "wait", "ignore"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", type=Path, required=True)
    ap.add_argument("--in", dest="inp", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--calibration", type=Path, default=None)
    ap.add_argument("--qids", default=None, help="comma list; default all questions")
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--threads", type=int, default=16)
    ap.add_argument("--max-len", type=int, default=2048)
    ap.add_argument("--overwrite", action="store_true", help="replace gold labels too")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    import torch

    from jev_local.engine.encoder.calibrate import calibrate_logits, header_key
    from jev_local.engine.encoder.engine import load_checkpoint
    from jev_local.engine.encoder.heads import build_plan
    from jev_local.engine.encoder.tokenize_pack import Packer, collate_tree
    from jev_local.train.train import encode_example, train_buckets

    torch.set_num_threads(args.threads)
    enc, heads, tok, calib, meta = load_checkpoint(args.ckpt, "cpu", torch.float32, encoder="banded")
    if args.calibration:
        calib = json.loads(args.calibration.read_text())
    packer = Packer(tok, max_len=args.max_len, buckets=train_buckets(args.max_len))
    only = set(args.qids.split(",")) if args.qids else None

    done = 0
    if args.out.is_file():
        with args.out.open("rb") as f:
            data = f.read()
        done = data.count(b"\n")
        if data and not data.endswith(b"\n"):  # drop a torn last line
            keep = data[: data.rfind(b"\n") + 1]
            args.out.write_bytes(keep)
    lines = args.inp.read_text().splitlines()
    if args.limit is not None:
        lines = lines[: args.limit]
    todo = lines[done:]
    t0 = time.time()
    n_tok = 0
    with args.out.open("a") as fout, torch.inference_mode():
        for s in range(0, len(todo), args.batch):
            objs = [json.loads(x) for x in todo[s: s + args.batch]]
            rows, owners = [], []
            for i, ex in enumerate(objs):
                ex_q = {q: v for q, v in ex["questions"].items() if only is None or q in only}
                if not ex_q:
                    continue
                shell = {"id": ex.get("id"), "state": ex["state"], "questions": ex_q, "labels": {}}
                for r in encode_example(shell, packer, args.max_len):
                    rows.append(r)
                    owners.append(i)
            out_lab: dict[int, dict] = {i: {} for i in range(len(objs))}
            info: dict[int, dict] = {i: {} for i in range(len(objs))}
            if rows:
                packs = [r.pack for r in rows]
                b = collate_tree(packs, packer.pad_id, enc.window, "cpu")
                plan = build_plan(packs, b.row_offsets, "cpu")
                o = heads(enc(b), plan)
                n_tok += b.n_tokens
                host = {k: (getattr(o, k).float().numpy() if getattr(o, k) is not None else None)
                        for k in ("choice", "score", "noul")}
                for ref in plan.refs:
                    qi = ref.qi
                    i = owners[ref.row]
                    z = host["noul"][ref.group: ref.group + 1] if qi.kind == "noul" else host[qi.kind][ref.group, : len(qi.labels)]
                    p = calibrate_logits(qi.kind, header_key(qi.header), z.astype(np.float64), calib)
                    if qi.kind == "noul":
                        out_lab[i][qi.qid] = {"type": "noul", "p": round(float(p[0]), 5)}
                        info[i][qi.qid] = {"p": round(float(p[0]), 4)}
                        continue
                    ps = [round(float(x), 5) for x in p]
                    srt = sorted(ps, reverse=True)
                    rec = {"top": srt[0], "margin": round(srt[0] - (srt[1] if len(srt) > 1 else 0.0), 4)}
                    if qi.kind == "choice":
                        out_lab[i][qi.qid] = {"type": "choice", "dist": dict(zip(qi.labels, ps))}
                        if qi.qid == "action":
                            rec["non_passive_mass"] = round(sum(x for l, x in zip(qi.labels, ps) if l not in PASSIVE), 4)
                    else:
                        out_lab[i][qi.qid] = {"type": "score", "dist": ps}
                    info[i][qi.qid] = rec
            for i, ex in enumerate(objs):
                labels = dict(ex.get("labels") or {})
                for q, lab in out_lab[i].items():
                    if args.overwrite or q not in labels:
                        labels[q] = lab
                m = dict(ex.get("meta") or {})
                m["teacher"] = {"ckpt": args.ckpt.name, **info[i]}
                ex["labels"] = labels
                ex["meta"] = m
                fout.write(json.dumps(ex, ensure_ascii=False) + "\n")
            fout.flush()
    dt = time.time() - t0
    print(json.dumps({"rows": len(todo), "resumed_after": done, "seconds": round(dt, 1),
                      "tokens_per_s": round(n_tok / max(dt, 1e-9))}))


if __name__ == "__main__":
    main()
