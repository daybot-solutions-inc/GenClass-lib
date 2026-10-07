"""Test-only variants of a q8 GenClass model that differ only in how the token-embedding table is stored, to check
which encodings onnxruntime-web's WebGPU provider runs on adapters without shader-f16 (test/browser/model-webgpu.spec.ts).

    ~/jev/.venv/bin/python packages/runtime/test/fixtures/model/make_webgpu_variants.py \
        --src ~/gcl-cache/model-v0.1 --out ~/gcl-cache/webgpu-variants

Writes one model directory per variant (runtime card with a single q8 variant + the source's tokenizer, calibration
and meta):
    f32emb   fp32 table: Gather(fp32)                                 (the q8 export stores fp16 + Cast)
    i8emb    int8 table + per-row fp32 scale: Gather(int8) -> Cast -> Mul(Gather(scale))
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def find_embedding(m: onnx.ModelProto):
    inits = {i.name: i for i in m.graph.initializer}
    for n in m.graph.node:
        if n.op_type == "Gather" and n.input[0] in inits:
            w = inits[n.input[0]]
            if len(w.dims) == 2 and w.dims[0] > 10000:
                cast = next((c for c in m.graph.node if c.op_type == "Cast" and c.input and c.input[0] == n.output[0]), None)
                return n, w, cast
    raise SystemExit("no embedding Gather found")


def f32emb(m: onnx.ModelProto) -> onnx.ModelProto:
    g, w, cast = find_embedding(m)
    arr = numpy_helper.to_array(w).astype(np.float32)
    m.graph.initializer.remove(w)
    m.graph.initializer.append(numpy_helper.from_array(arr, w.name))
    if cast is not None:  # Cast(fp32 -> fp32) would be an identity; route the Gather straight to the Cast's output
        out = cast.output[0]
        m.graph.node.remove(cast)
        g.output[0] = out
    return m


def i8emb(m: onnx.ModelProto) -> onnx.ModelProto:
    g, w, cast = find_embedding(m)
    arr = numpy_helper.to_array(w).astype(np.float32)
    scale = np.maximum(np.abs(arr).max(axis=1, keepdims=True), 1e-8) / 127.0
    q = np.clip(np.rint(arr / scale), -127, 127).astype(np.int8)
    out = cast.output[0] if cast is not None else g.output[0]
    ids = g.input[1]
    m.graph.initializer.remove(w)
    m.graph.initializer.extend([numpy_helper.from_array(q, "tok_emb_q8"), numpy_helper.from_array(scale.astype(np.float32), "tok_emb_scale")])
    idx = list(m.graph.node).index(g)
    for n in [x for x in (cast, g) if x is not None]:
        m.graph.node.remove(n)
    new = [
        helper.make_node("Gather", ["tok_emb_q8", ids], ["tok_emb_q8_rows"], name="tok_emb_gather_q8", axis=0),
        helper.make_node("Cast", ["tok_emb_q8_rows"], ["tok_emb_rows_f32"], name="tok_emb_cast", to=TensorProto.FLOAT),
        helper.make_node("Gather", ["tok_emb_scale", ids], ["tok_emb_row_scale"], name="tok_emb_gather_scale", axis=0),
        helper.make_node("Mul", ["tok_emb_rows_f32", "tok_emb_row_scale"], [out], name="tok_emb_dequant"),
    ]
    for k, n in enumerate(new):
        m.graph.node.insert(idx + k, n)
    return m


VARIANTS = {"f32emb": f32emb, "i8emb": i8emb}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, required=True, help="model directory with a q8 variant (runtime card)")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    src = args.src.expanduser()
    card = json.loads((src / "model.json").read_text())
    q8 = src / card["variants"]["q8"]["file"]
    for name, fn in VARIANTS.items():
        d = args.out.expanduser() / name
        d.mkdir(parents=True, exist_ok=True)
        m = fn(onnx.load(str(q8)))
        onnx.checker.check_model(m)
        f = d / f"genclass-q8-{name}.onnx"
        onnx.save(m, str(f))
        files = {}
        for role in ("tokenizer", "calibration", "meta"):
            fn_ = card["files"][role]["file"]
            shutil.copy(src / fn_, d / fn_)
            b = (d / fn_).read_bytes()
            files[role] = {"file": fn_, "bytes": len(b), "sha256": hashlib.sha256(b).hexdigest()}
        b = f.read_bytes()
        out = {
            "format": "genclass-runtime-model/1",
            "name": f"{card['name']}-{name}",
            "version": card["version"],
            "variants": {"q8": {"file": f.name, "bytes": len(b), "sha256": hashlib.sha256(b).hexdigest(), "provider": "wasm"}},
            "files": files,
        }
        (d / "model.json").write_text(json.dumps(out, indent=2))
        print(f"{name}: {f} ({len(b) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
