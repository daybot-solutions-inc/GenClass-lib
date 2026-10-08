"""Action/diagnosis logits from the SHIPPED ONNX file (onnxruntime CPU, the same kernels as onnxruntime-node/-web WASM),
packed exactly like the export's parity check (= the runtime packer), in eval_runtime's record format.

    python training/collect_onnx.py --ckpt models/M --onnx out/export-M/genclass-runtime-r17-q8.onnx \
        --in data/sim2e/dev.jsonl --out out/records/M-q8__sim2e__dev.jsonl [--threads 10]

`--ckpt` only provides the tokenizer (identical to the export's tokenizer.json). Records: {id, qid, kind, labels, logits,
target, header} with header = header_key(question header) as the runtime's calibration lookup uses it.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path.home() / "jev"))
sys.path.insert(0, str(Path.home() / "jev" / "scripts"))


def target_of(lab: dict | None, labels: list[str]) -> list[float]:
    K = len(labels)
    if not lab:
        return [1.0 / K] * K
    if isinstance(lab.get("dist"), dict):
        v = [float(lab["dist"].get(x, 0.0)) for x in labels]
        s = sum(v)
        return [x / s for x in v] if s > 0 else [1.0 / K] * K
    if lab.get("label") in labels:
        return [1.0 if x == lab["label"] else 0.0 for x in labels]
    return [1.0 / K] * K


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", type=Path, required=True)
    ap.add_argument("--onnx", type=Path, required=True)
    ap.add_argument("--in", dest="inp", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--threads", type=int, default=10)
    ap.add_argument("--qids", default="action,diagnosis")
    a = ap.parse_args()
    import onnxruntime as ort

    from genclass_export import plan_inputs, unpack
    from jev_local.engine.encoder.calibrate import header_key
    from jev_local.engine.encoder.engine import load_checkpoint
    from jev_local.engine.encoder.tokenize_pack import Packer
    from jev_local.schema import question_from_json
    from jev_local.serialize import question_block, state_segments
    import torch

    torch.set_num_threads(1)
    _, _, tok, _, _ = load_checkpoint(a.ckpt, "cpu", torch.float32, encoder="reference")
    packer = Packer(tok, max_len=8192)
    so = ort.SessionOptions()
    so.intra_op_num_threads = a.threads
    sess = ort.InferenceSession(str(a.onnx), so, providers=["CPUExecutionProvider"])
    only = set(a.qids.split(","))
    n = 0
    with a.inp.open() as fin, a.out.open("w") as fout:
        for line in fin:
            r = json.loads(line)
            qs = {k: question_from_json(v) for k, v in (r.get("questions") or {}).items() if k in only}
            if not qs:
                continue
            blocks = [question_block(k, q) for k, q in qs.items()]
            p = packer.pack(state_segments(r["state"]), blocks)
            got = unpack(p, sess.run(None, plan_inputs(p)))
            for b in blocks:
                qi = p.q_index[b.qid]
                labels = list(qi.labels)
                fout.write(json.dumps({"id": r["id"], "qid": b.qid, "kind": qi.kind, "labels": labels,
                                       "logits": [float(x) for x in np.asarray(got[b.qid]).reshape(-1)[:len(labels)]],
                                       "target": target_of((r.get("labels") or {}).get(b.qid), labels),
                                       "header": header_key(b.header)}) + "\n")
            n += 1
    print(json.dumps({"rows": n, "out": str(a.out)}))


if __name__ == "__main__":
    main()
