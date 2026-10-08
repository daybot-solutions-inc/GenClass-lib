"""Collect raw action/diagnosis logits and (if the checkpoint has one) gain-head predictions for eval_gain.py.

    python training/collect_gain.py --ckpt models/r17-t1h --in data/simAe/test.jsonl --out out/records/r17-t1h__simAe__test.gain.jsonl

Writes one record per standing question (`action`, `diagnosis`) per row in eval_runtime's record format
({id, qid, kind, labels, logits, target}) plus `gain_pred` (per option, raw head output) for `action` when the
checkpoint has a gain head. Resumable by line count; rows are processed in input order.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path.home() / "jev"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", type=Path, required=True)
    ap.add_argument("--in", dest="inp", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--threads", type=int, default=16)
    ap.add_argument("--max-len", type=int, default=2048)
    ap.add_argument("--amp", action="store_true", help="bf16 autocast for the forward (CPU)")
    a = ap.parse_args()
    import torch

    from jev_local.engine.encoder.engine import load_checkpoint
    from jev_local.engine.encoder.heads import build_plan
    from jev_local.engine.encoder.tokenize_pack import Packer, collate_tree
    from jev_local.train.train import encode_example, train_buckets

    torch.set_num_threads(a.threads)
    enc, heads, tok, _, _ = load_checkpoint(a.ckpt, "cpu", torch.float32, encoder="banded")
    packer = Packer(tok, max_len=a.max_len, buckets=train_buckets(a.max_len))
    lines = a.inp.read_text().splitlines()
    with a.out.open("w") as fout, torch.inference_mode():
        for s in range(0, len(lines), a.batch):
            objs = [json.loads(x) for x in lines[s: s + a.batch]]
            rows = []
            for ex in objs:
                q = {k: v for k, v in ex["questions"].items() if k in ("action", "diagnosis")}
                if not q:
                    continue
                lab = {k: v for k, v in (ex.get("labels") or {}).items() if k in q}
                rows += encode_example({"id": ex["id"], "state": ex["state"], "questions": q, "labels": lab}, packer, a.max_len)
            if not rows:
                continue
            packs = [r.pack for r in rows]
            b = collate_tree(packs, packer.pad_id, enc.window, "cpu")
            plan = build_plan(packs, b.row_offsets, "cpu")
            with torch.autocast("cpu", dtype=torch.bfloat16, enabled=a.amp):
                o = heads(enc(b), plan)
            ch = o.choice.float().numpy()
            gn = o.gain.float().numpy() if o.gain is not None else None
            for ref in plan.refs:
                qi = ref.qi
                if qi.kind != "choice":
                    continue
                row = rows[ref.row]
                K = len(qi.labels)
                t = row.targets.get(qi.qid)
                rec = {"id": row.example_id, "qid": qi.qid, "kind": "choice", "labels": list(qi.labels),
                       "logits": [float(x) for x in ch[ref.group, :K]],
                       "target": (t.dist if t is not None else [1.0 / K] * K), "header": ""}
                if gn is not None and qi.qid == "action":
                    rec["gain_pred"] = [round(float(x), 4) for x in gn[ref.group, :K]]
                fout.write(json.dumps(rec) + "\n")
    print("done", a.out)


if __name__ == "__main__":
    main()
