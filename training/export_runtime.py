"""Export a (pruned-vocabulary) GenClass checkpoint to the runtime model directory.

RUN ON A VM (imports torch/onnx). From ~/gcl-train:

    $PY training/export_runtime.py --ckpt models/r32-s1 --out out/export-r32 --name genclass-runtime-r32 \
        --version 0.1.0 [--requests reqs.json | --data-rows a.jsonl,b.jsonl] [--calibration cal.json]

Graph = scripts/genclass_export.py's ExportModel (same inputs/outputs as the GenClass v0.1 ONNX, imported, not
copied, so the original exporter stays the single source of the graph), then:

    <name>-q8.onnx    WASM: weight-only MatMulNBits 8-bit (block 32, symmetric) on every MatMul + int8 token
                      embeddings (Gather int8 -> Cast fp32 -> Mul by a per-row fp32 scale gathered by the same ids)
    <name>-fp16.onnx  WebGPU (shader-f16): fp16 weights/compute, fp32 inputs/outputs, int8 token embeddings
                      (Gather int8 -> Cast fp16 -> Mul fp16 scale)
    tokenizer.json, calibration.json, meta.json, model.json (card format genclass-runtime-model/1, sha256 + bytes)
    parity.json (vs PyTorch), pack_fixtures.json + torch_fixtures.json (JS parity), requests.json

The fp32 reference export stays in --out/ref/ (not part of the card).
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path.home() / "jev"))
sys.path.insert(0, str(Path.home() / "jev" / "scripts"))

CARD_FORMAT = "genclass-runtime-model/1"
OUTPUTS = ["choice_logits", "score_logits", "noul_logits"]


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------------------------------------------ graph surgery


def quantize_embedding(model, vocab: int, out_dtype: str = "float32") -> dict:
    """Replace the token-embedding Gather on a [vocab, d] initializer by an int8 table + per-row scale.

    Symmetric per-row: scale = max|row| / 127 (rows of zeros get scale 1), q = clip(rint(w / scale), -127, 127).
    Returns stats {max_abs_err, mean_abs_err, rows, d}."""
    from onnx import TensorProto, helper, numpy_helper

    g = model.graph
    inits = {i.name: i for i in g.initializer}
    target = None
    for n in g.node:
        if n.op_type == "Gather" and n.input[0] in inits:
            dims = list(inits[n.input[0]].dims)
            if len(dims) == 2 and dims[0] == vocab:
                target = n
                break
    if target is None:
        raise ValueError(f"no Gather over a [{vocab}, d] initializer found")
    users = [n for n in g.node if target.input[0] in n.input]
    if len(users) != 1:
        raise ValueError(f"embedding table used by {len(users)} nodes; expected 1")
    w = numpy_helper.to_array(inits[target.input[0]]).astype(np.float32)
    scale = np.abs(w).max(axis=1, keepdims=True) / 127.0
    scale[scale == 0] = 1.0
    q = np.clip(np.rint(w / scale), -127, 127).astype(np.int8)
    err = np.abs(q.astype(np.float32) * scale - w)
    to = TensorProto.FLOAT if out_dtype == "float32" else TensorProto.FLOAT16
    sdt = np.float32 if out_dtype == "float32" else np.float16
    base = target.input[0]
    q_init = numpy_helper.from_array(q, base + "_int8")
    s_init = numpy_helper.from_array(scale.astype(sdt), base + "_rowscale")
    g.initializer.remove(inits[base])
    g.initializer.extend([q_init, s_init])
    ids, out = target.input[1], target.output[0]
    axis = [a for a in target.attribute if a.name == "axis"]
    kw = {"axis": helper.get_attribute_value(axis[0])} if axis else {}
    nodes = [
        helper.make_node("Gather", [q_init.name, ids], [out + "_q"], name=target.name + "_q", **kw),
        helper.make_node("Cast", [out + "_q"], [out + "_f"], name=target.name + "_cast", to=to),
        helper.make_node("Gather", [s_init.name, ids], [out + "_s"], name=target.name + "_scale", **kw),
        helper.make_node("Mul", [out + "_f", out + "_s"], [out], name=target.name + "_dequant"),
    ]
    pos = list(g.node).index(target)
    g.node.remove(target)
    for k, nd in enumerate(nodes):
        g.node.insert(pos + k, nd)
    return {"rows": int(w.shape[0]), "d": int(w.shape[1]), "max_abs_err": float(err.max()),
            "mean_abs_err": float(err.mean()), "max_scale": float(scale.max())}


def gemm_to_matmul(m) -> int:
    """Gemm(A, W, b) (transA=0, alpha=beta=1, W an initializer) -> MatMul(A, W') + Add(b), so the weight-only
    quantizer (MatMul only) also covers 2-D Linear layers such as the noul head's first layer (2.9 MB in fp32)."""
    from onnx import helper, numpy_helper

    g = m.graph
    inits = {i.name: i for i in g.initializer}
    done = 0
    for n in list(g.node):
        if n.op_type != "Gemm" or n.input[1] not in inits:
            continue
        at = {a.name: helper.get_attribute_value(a) for a in n.attribute}
        if at.get("transA", 0) or float(at.get("alpha", 1.0)) != 1.0 or float(at.get("beta", 1.0)) != 1.0:
            continue
        w = numpy_helper.to_array(inits[n.input[1]])
        if at.get("transB", 0):
            w = w.T
        new_w = numpy_helper.from_array(np.ascontiguousarray(w), n.input[1] + "_mm")
        g.initializer.append(new_w)
        if sum(n.input[1] in x.input for x in g.node) == 1:
            g.initializer.remove(inits[n.input[1]])
        has_bias = len(n.input) > 2 and n.input[2]
        mm_out = n.output[0] + "_mm" if has_bias else n.output[0]
        nodes = [helper.make_node("MatMul", [n.input[0], new_w.name], [mm_out], name=n.name + "_mm")]
        if has_bias:
            nodes.append(helper.make_node("Add", [mm_out, n.input[2]], [n.output[0]], name=n.name + "_bias"))
        pos = list(g.node).index(n)
        g.node.remove(n)
        for k, nd in enumerate(nodes):
            g.node.insert(pos + k, nd)
        done += 1
    return done


def make_q8(src: Path, dst: Path, vocab: int, block: int = 32) -> dict:
    import onnx
    from onnx import numpy_helper
    from onnxruntime.quantization.matmul_nbits_quantizer import DefaultWeightOnlyQuantConfig, MatMulNBitsQuantizer

    m = onnx.load(str(src))
    n_gemm = gemm_to_matmul(m)
    cfg = DefaultWeightOnlyQuantConfig(block_size=block, is_symmetric=True, bits=8, op_types_to_quantize=("MatMul",),
                                       quant_axes=(("MatMul", 0),))
    qz = MatMulNBitsQuantizer(m, algo_config=cfg)
    qz.process()
    m = qz.model.model
    left = [n.name for n in m.graph.node if n.op_type == "MatMul" and any(i.name in n.input for i in m.graph.initializer)]
    st = quantize_embedding(m, vocab, "float32")
    # WebGPU without shader-f16 (MODEL README): the q8 variant must not contain any fp16 tensor or fp16 cast
    from onnx import TensorProto
    f16_inits = [i.name for i in m.graph.initializer if i.data_type == TensorProto.FLOAT16]
    f16_casts = [n.name for n in m.graph.node if n.op_type == "Cast" and
                 any(a.name == "to" and a.i == TensorProto.FLOAT16 for a in n.attribute)]
    if f16_inits or f16_casts:
        raise ValueError(f"q8 graph contains fp16 tensors {f16_inits[:3]} / casts {f16_casts[:3]}")
    st["fp16_free"] = True
    st["matmul_unquantized_with_weight"] = left
    st["matmulnbits"] = sum(1 for n in m.graph.node if n.op_type == "MatMulNBits")
    st["gemm_converted"] = n_gemm
    st["fp32_initializer_mb"] = round(sum(numpy_helper.to_array(i).nbytes for i in m.graph.initializer
                                          if i.data_type == 1) / 1e6, 3)
    onnx.checker.check_model(m)
    onnx.save(m, str(dst))
    return st


def make_fp16(src16: Path, dst: Path, vocab: int) -> dict:
    import onnx

    m = onnx.load(str(src16))
    st = quantize_embedding(m, vocab, "float16")
    onnx.checker.check_model(m)
    onnx.save(m, str(dst))
    return st


# ------------------------------------------------------------------------------------------------ requests


def requests_from_rows(paths: list[Path], n_per_file: int, max_tokens: int, packer, seed: int = 0) -> list[dict]:
    from jev_local.schema import question_from_json
    from jev_local.serialize import question_block, state_segments

    rng = np.random.default_rng(seed)
    out = []
    for p in paths:
        lines = p.read_text().splitlines()
        idx = rng.permutation(len(lines))
        k = 0
        for i in idx:
            r = json.loads(lines[i])
            qs = {q: question_from_json(v) for q, v in r["questions"].items()}
            n = packer.count(state_segments(r["state"]), [question_block(q, v) for q, v in qs.items()])
            if n > max_tokens:
                continue
            out.append({"id": r["id"], "state": r["state"], "questions": r["questions"], "tokens": n})
            k += 1
            if k >= n_per_file:
                break
    return out


# ------------------------------------------------------------------------------------------------ main


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--name", default="genclass-runtime")
    ap.add_argument("--version", default="0.1.0")
    ap.add_argument("--requests", type=Path, default=None)
    ap.add_argument("--data-rows", default=None, help="comma list of jsonl files to sample parity requests from")
    ap.add_argument("--n-per-file", type=int, default=40)
    ap.add_argument("--calibration", type=Path, default=None, help="calibration.json to ship (default: the ckpt's)")
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--threads", type=int, default=16)
    ap.add_argument("--block", type=int, default=32)
    args = ap.parse_args()

    import onnx
    import onnxruntime as ort
    import torch

    from genclass_export import ExportModel, plan_inputs, unpack  # the original exporter (unchanged)
    from jev_local.engine.encoder.calibrate import calibrate_logits, header_key
    from jev_local.engine.encoder.engine import FastEngine, load_checkpoint
    from jev_local.engine.encoder.tokenize_pack import MARKERS, Packer
    from jev_local.schema import question_from_json
    from jev_local.serialize import question_block, state_segments

    torch.set_num_threads(args.threads)
    out = args.out.expanduser()
    ref = out / "ref"
    ref.mkdir(parents=True, exist_ok=True)
    enc, heads, tok, calib, meta = load_checkpoint(args.ckpt, "cpu", torch.float32, encoder="reference")
    if args.calibration:
        calib = json.loads(args.calibration.read_text())
    vocab = int(enc.backbone.get_input_embeddings().num_embeddings)
    model = ExportModel(enc, heads).eval()
    packer = Packer(tok, max_len=8192)

    if args.requests:
        reqs = json.loads(args.requests.read_text())
    else:
        paths = [Path(x).expanduser() for x in (args.data_rows or "").split(",") if x]
        reqs = requests_from_rows(paths, args.n_per_file, 1500, packer)
    (out / "requests.json").write_text(json.dumps(reqs))
    packs, blocks_all = [], []
    for r in reqs:
        qs = {k: question_from_json(v) for k, v in r["questions"].items()}
        blocks = [question_block(k, q) for k, q in qs.items()]
        packs.append(packer.pack(state_segments(r["state"]), blocks))
        blocks_all.append(blocks)

    feeds0 = plan_inputs(max(packs, key=lambda p: len(p.q_index)))
    names = list(feeds0)
    dyn = {"input_ids": {1: "L"}, "position_ids": {1: "L"}, "q_group": {1: "L"}, "i_group": {1: "L"},
           "choice_q": {0: "G"}, "choice_items": {0: "G", 1: "K"}, "score_q": {0: "S"}, "score_items": {0: "S", 1: "K2"},
           "noul_q": {0: "M"}, "noul_t": {0: "M"}, "noul_f": {0: "M"},
           "choice_logits": {0: "G", 1: "K"}, "score_logits": {0: "S", 1: "K2"}, "noul_logits": {0: "M"}}
    targs = tuple(torch.from_numpy(feeds0[n]) for n in names)
    t0 = time.time()
    fp32, fp16_raw = ref / f"{args.name}-fp32.onnx", ref / f"{args.name}-fp16-fullemb.onnx"
    with torch.no_grad():
        torch.onnx.export(model, targs, str(fp32), input_names=names, output_names=OUTPUTS, dynamic_axes=dyn,
                          opset_version=args.opset, do_constant_folding=True, dynamo=False)
        m16 = copy.deepcopy(model).half().eval()
        torch.onnx.export(m16, targs, str(fp16_raw), input_names=names, output_names=OUTPUTS, dynamic_axes=dyn,
                          opset_version=args.opset, do_constant_folding=True, dynamo=False)
    onnx.checker.check_model(onnx.load(str(fp32)))
    q8_path, f16_path = out / f"{args.name}-q8.onnx", out / f"{args.name}-fp16.onnx"
    st_q8 = make_q8(fp32, q8_path, vocab, args.block)
    st_16 = make_fp16(fp16_raw, f16_path, vocab)
    print(f"exported in {time.time() - t0:.1f}s; q8 {q8_path.stat().st_size / 1e6:.1f} MB, "
          f"fp16 {f16_path.stat().st_size / 1e6:.1f} MB", flush=True)

    # ---------------------------------------------------------------- parity vs PyTorch
    so = ort.SessionOptions()
    so.intra_op_num_threads = args.threads
    variants = {"fp32": fp32, "fp16": f16_path, "q8": q8_path}
    sessions = {v: ort.InferenceSession(str(p), so, providers=["CPUExecutionProvider"]) for v, p in variants.items()}
    so1 = ort.SessionOptions()
    so1.intra_op_num_threads = 1
    s1 = {v: ort.InferenceSession(str(p), so1, providers=["CPUExecutionProvider"]) for v, p in variants.items()
          if v in ("q8", "fp16")}
    eng = FastEngine(args.ckpt, device="cpu", dtype=torch.float32, encoder="banded", threads=args.threads)
    if args.calibration:
        eng.calib = calib
    stats = {v: {"max_abs_logit": 0.0, "max_abs_prob": 0.0, "argmax_agree": 0, "argmax_total": 0, "noul_side_agree": 0,
                 "noul_total": 0, "gate08_agree": 0, "gate09_agree": 0, "gate_total": 0, "ms": [], "ms_1t": []}
             for v in sessions}
    pack_fx, torch_fx = [], []
    for r, p, blocks in zip(reqs, packs, blocks_all):
        qs = {k: question_from_json(v) for k, v in r["questions"].items()}
        refl = eng.evaluate_logits(r["state"], qs)
        ref_logits = {q: np.asarray(v["logits"], np.float64) for q, v in refl.items()}
        ref_probs = {b.qid: calibrate_logits(b.kind, header_key(b.header), ref_logits[b.qid], calib) for b in blocks}
        feeds = plan_inputs(p)
        for v, sess in sessions.items():
            t1 = time.perf_counter()
            o = sess.run(None, feeds)
            stats[v]["ms"].append((time.perf_counter() - t1) * 1e3)
            if v in s1:
                t1 = time.perf_counter()
                s1[v].run(None, feeds)
                stats[v]["ms_1t"].append((time.perf_counter() - t1) * 1e3)
            got = unpack(p, o)
            s = stats[v]
            for b in blocks:
                q = b.qid
                s["max_abs_logit"] = max(s["max_abs_logit"], float(np.abs(got[q] - ref_logits[q]).max()))
                gp = calibrate_logits(b.kind, header_key(b.header), got[q], calib)
                rp = ref_probs[q]
                s["max_abs_prob"] = max(s["max_abs_prob"], float(np.abs(gp - rp).max()))
                if b.kind == "noul":
                    s["noul_total"] += 1
                    s["noul_side_agree"] += int((gp[0] >= 0.5) == (rp[0] >= 0.5))
                else:
                    s["argmax_total"] += 1
                    s["argmax_agree"] += int(int(np.argmax(gp)) == int(np.argmax(rp)))
                    if b.kind == "choice":
                        s["gate_total"] += 1
                        same = int(np.argmax(gp)) == int(np.argmax(rp))
                        s["gate08_agree"] += int(same and (gp.max() >= 0.8) == (rp.max() >= 0.8))
                        s["gate09_agree"] += int(same and (gp.max() >= 0.9) == (rp.max() >= 0.9))
        pack_fx.append({"id": r["id"], "input_ids": p.input_ids, "position_ids": p.position_ids, "q_group": p.q_group,
                        "i_group": p.i_group, "n_state": p.n_state,
                        "q_index": {q: {"kind": qi.kind, "header": qi.header, "labels": list(qi.labels), "q_pos": qi.q_pos,
                                        "item_pos": list(qi.item_pos)} for q, qi in p.q_index.items()}})
        torch_fx.append({"id": r["id"], "logits": {q: v.tolist() for q, v in ref_logits.items()},
                         "probs": {q: v.tolist() for q, v in ref_probs.items()},
                         "header_key": {b.qid: header_key(b.header) for b in blocks}})
    lens = [p.length for p in packs]
    for v in stats:
        ms, ms1 = stats[v].pop("ms"), stats[v].pop("ms_1t")
        stats[v]["ort_cpu_ms_p50"] = round(float(np.median(ms)), 2)
        if ms1:
            stats[v]["ort_cpu_1thread_ms_p50"] = round(float(np.median(ms1)), 2)
        stats[v]["file_mb"] = round(variants[v].stat().st_size / 1e6, 2)
        for k, tk in (("argmax", "argmax_total"), ("noul_side", "noul_total"), ("gate08", "gate_total"),
                      ("gate09", "gate_total")):
            if stats[v][tk]:
                stats[v][f"{k}_rate"] = round(stats[v][f"{k}_agree"] / stats[v][tk], 4)
    stats["n_requests"] = len(reqs)
    stats["tokens"] = {"min": min(lens), "median": int(np.median(lens)), "max": max(lens)}
    stats["embedding_q8"] = st_q8
    stats["embedding_fp16"] = st_16
    (out / "parity.json").write_text(json.dumps(stats, indent=2))
    (out / "pack_fixtures.json").write_text(json.dumps(pack_fx))
    (out / "torch_fixtures.json").write_text(json.dumps(torch_fx))

    # ---------------------------------------------------------------- model directory
    shutil.copy(args.ckpt / "backbone" / "tokenizer.json", out / "tokenizer.json")
    (out / "calibration.json").write_text(json.dumps(calib, indent=2))
    pr = meta.get("vocab_pruned") or {}
    vocab_map = tok.get_vocab()
    meta_out = {
        "name": f"{args.name}-{args.version}", "source_checkpoint": str(args.ckpt), "max_len": int(meta.get("max_len") or 1536),
        "max_total": 8192, "window": model.window, "hidden_size": model.d, "layer_types": model.layer_types,
        "markers": {m: vocab_map[m] for m in MARKERS}, "cls_id": tok.cls_token_id, "sep_id": tok.sep_token_id,
        "pad_id": tok.pad_token_id, "vocab_size": vocab, "merges_kept": pr.get("merges_kept"),
        "inputs": names, "outputs": OUTPUTS, "embedding_quant": "int8-rowwise-symmetric",
        "matmul_quant": f"MatMulNBits-8bit-b{args.block}-symmetric (q8); fp16 weights (fp16)",
        "license": "Apache-2.0",
    }
    (out / "meta.json").write_text(json.dumps(meta_out, indent=2))

    def spec(p: Path, **kw) -> dict:
        return {"file": p.name, "bytes": p.stat().st_size, "sha256": sha256(p), **kw}

    card = {"format": CARD_FORMAT, "name": args.name, "version": args.version, "license": "Apache-2.0",
            "variants": {"q8": spec(q8_path, provider="wasm"),
                         "fp16": spec(f16_path, provider="webgpu", needs="shader-f16")},
            "files": {"tokenizer": spec(out / "tokenizer.json"), "calibration": spec(out / "calibration.json"),
                      "meta": spec(out / "meta.json")}}
    (out / "model.json").write_text(json.dumps(card, indent=2))
    print(json.dumps({k: stats[k] for k in ("fp32", "fp16", "q8")}, indent=1))
    print(json.dumps(card, indent=1))


if __name__ == "__main__":
    main()
