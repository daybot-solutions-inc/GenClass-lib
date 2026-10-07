"""Tests for training/export_runtime.py (run on a VM; uses the small R17 random-head checkpoint):

    cd ~/gcl-train && PYTHONPATH=~/jev:~/gcl-train/training ~/jev/.venv/bin/python -m pytest -q training/tests/test_export_runtime.py

GC_R17_INIT (default ~/gcl-train/models/r17-v16k-init).
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path.home() / "jev"))
sys.path.insert(0, str(Path.home() / "jev" / "scripts"))

import export_runtime as E  # noqa: E402

R17 = Path(os.environ.get("GC_R17_INIT", Path.home() / "gcl-train/models/r17-v16k-init"))
need = pytest.mark.skipif(not (R17 / "backbone").is_dir(), reason="R17 init checkpoint missing")


def _tiny_gather_model(V: int = 50, d: int = 8, seed: int = 0):
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    rng = np.random.default_rng(seed)
    w = (rng.standard_normal((V, d)) * rng.uniform(0.01, 3, size=(V, 1))).astype(np.float32)
    w[3] = 0.0  # an all-zero row must survive (scale guard)
    W = numpy_helper.from_array(w, "emb")
    g = helper.make_graph([helper.make_node("Gather", ["emb", "ids"], ["out"], axis=0)], "g",
                          [helper.make_tensor_value_info("ids", TensorProto.INT64, [1, None])],
                          [helper.make_tensor_value_info("out", TensorProto.FLOAT, [1, None, d])], [W])
    return helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)], ir_version=10), w


def test_int8_embedding_is_close_and_valid(tmp_path):
    import onnx
    import onnxruntime as ort

    m, w = _tiny_gather_model()
    st = E.quantize_embedding(m, 50, "float32")
    onnx.checker.check_model(m)
    p = tmp_path / "q.onnx"
    onnx.save(m, str(p))
    ids = np.arange(50, dtype=np.int64)[None]
    got = ort.InferenceSession(str(p), providers=["CPUExecutionProvider"]).run(None, {"ids": ids})[0][0]
    scale = np.abs(w).max(axis=1, keepdims=True) / 127
    scale[scale == 0] = 1
    assert np.all(np.abs(got - w) <= scale / 2 + 1e-7)
    assert np.all(got[3] == 0)
    assert st["rows"] == 50 and st["max_abs_err"] <= float(scale.max() / 2 + 1e-7)


def test_gemm_rewrite_preserves_outputs(tmp_path):
    import onnx
    import onnxruntime as ort
    from onnx import TensorProto, helper, numpy_helper

    rng = np.random.default_rng(1)
    W = rng.standard_normal((6, 10)).astype(np.float32)  # transB=1: [N, K]
    b = rng.standard_normal(6).astype(np.float32)
    g = helper.make_graph([helper.make_node("Gemm", ["x", "W", "b"], ["y"], transB=1)], "g",
                          [helper.make_tensor_value_info("x", TensorProto.FLOAT, [None, 10])],
                          [helper.make_tensor_value_info("y", TensorProto.FLOAT, [None, 6])],
                          [numpy_helper.from_array(W, "W"), numpy_helper.from_array(b, "b")])
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)], ir_version=10)
    x = rng.standard_normal((3, 10)).astype(np.float32)
    ref = x @ W.T + b
    assert E.gemm_to_matmul(m) == 1
    onnx.checker.check_model(m)
    p = tmp_path / "m.onnx"
    onnx.save(m, str(p))
    got = ort.InferenceSession(str(p), providers=["CPUExecutionProvider"]).run(None, {"x": x})[0]
    assert np.allclose(got, ref, atol=1e-5)
    assert [n.op_type for n in m.graph.node] == ["MatMul", "Add"]


@need
def test_export_end_to_end(tmp_path):
    reqs = []
    for i in range(6):
        reqs.append({"id": f"r{i}",
                     "state": {"app": "Shop — /cart", "trigger": f"GET /api/items (#{10 + i}) is about to be sent.",
                               "facts": ["GET is idempotent.", f"GET /api/items was requested {i + 3} times in the last 10s."],
                               "in_flight": "none", "timeline": ["-0.10s user clicked button \"Reload\" (#9)"],
                               "state": "none", "stats": "none"},
                     "questions": {"diagnosis": {"type": "choice", "instructions": "What is happening here?",
                                                 "criteria": {"expected": "normal behaviour, nothing is wrong",
                                                              "overload": "work is being triggered far more often than usual"}},
                                   "action": {"type": "choice", "instructions": "What should the runtime do with this request?",
                                              "criteria": {"send": "send the request now", "delay": "wait before sending"}},
                                   "n": {"type": "noul", "instructions": "Is the request idempotent?"},
                                   "s": {"type": "score", "instructions": "How busy?", "criteria": ["calm", "busy", "storm"]}}})
    rp = tmp_path / "reqs.json"
    rp.write_text(json.dumps(reqs))
    out = tmp_path / "export"
    env = {**os.environ, "PYTHONPATH": f"{Path.home() / 'jev'}:{Path(__file__).resolve().parents[1]}"}
    subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / "export_runtime.py"), "--ckpt", str(R17),
                    "--out", str(out), "--name", "t17", "--version", "0.0.0", "--requests", str(rp), "--threads", "4"],
                   check=True, env=env, capture_output=True)
    card = json.loads((out / "model.json").read_text())
    assert card["format"] == "genclass-runtime-model/1"
    for spec in [*card["variants"].values(), *card["files"].values()]:
        p = out / spec["file"]
        assert p.stat().st_size == spec["bytes"]
        assert hashlib.sha256(p.read_bytes()).hexdigest() == spec["sha256"]
    meta = json.loads((out / "meta.json").read_text())
    tj = json.loads((out / "tokenizer.json").read_text())
    added = {a["content"]: a["id"] for a in tj["added_tokens"]}
    assert all(meta["markers"][m] == added[m] for m in ("[Q]", "[O]", "[L]", "[T]", "[F]"))
    assert meta["cls_id"] == added["[CLS]"] and meta["sep_id"] == added["[SEP]"]
    par = json.loads((out / "parity.json").read_text())
    assert par["fp32"]["max_abs_logit"] < 1e-3
    assert par["q8"]["max_abs_logit"] < 0.5 and par["fp16"]["max_abs_logit"] < 0.5  # random heads: small logits
    assert card["variants"]["q8"]["bytes"] < 12e6  # R17 with the pruned vocabulary
