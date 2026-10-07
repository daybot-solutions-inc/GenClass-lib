"""Prune a GenClass checkpoint's (or an HF ettin base's) BPE vocabulary to its first N merges.

The ettin / ModernBERT tokenizer is a byte-level BPE (GPT-2 pre-tokenizer, NFC normalizer). Its ids are laid out as

    0..1         two added tokens (|||IP_ADDRESS|||, <|padding|>)
    2..244       the base byte characters (243 of 256 byte symbols occur)
    245..50253   the result of merge 0..50008, in merge order
    50254..      added tokens: whitespace runs, |||EMAIL_ADDRESS|||, <|endoftext|>, [UNK] [CLS] [SEP] [PAD] [MASK],
                 [unused0..82], and (GenClass checkpoints) the [Q] [O] [L] [T] [F] markers

Keeping the first N merges is closed under composition (every merge's parts are base symbols or results of earlier
merges; checked), and every string still encodes: BPE simply stops before the first dropped merge, so a word falls
back to shorter pieces, down to single byte symbols. Kept ids keep their relative order, so ids 0..244+N are
unchanged and only the added tokens move down to 245+N.. (the [Q]..[F] marker ids change: runtime code must read
them from tokenizer.json / meta.json, never hardcode them).

The model side is a row slice of the input embedding table (`emb[keep_ids]`); nothing else in the network depends on
the vocabulary (the GenClass heads read hidden states at marker positions; ModernBertModel has no LM head).

Usage (on a VM: needs torch/safetensors/tokenizers):
    # a GenClass fast-engine checkpoint (backbone/ + heads.safetensors + calibration.json + meta.json)
    python training/prune_vocab.py prune --src models/jev-local-fast --out models/r32-v16k --merges 16000
    # an HF base (config.json + model.safetensors + tokenizer files); markers are added later by init_model
    python training/prune_vocab.py prune --src models/base/ettin-encoder-17m --out models/base/ettin-17m-v16k --merges 16000
    # tokens-per-char inflation report on runtime-like text
    python training/prune_vocab.py analyze --src models/jev-local-fast --texts a.jsonl b.txt --merges 8000,12000,16000
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import shutil
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence

# ---------------------------------------------------------------------------- tokenizer.json surgery


def _merge_parts(m: Any) -> tuple[str, str]:
    if isinstance(m, (list, tuple)):
        return m[0], m[1]
    a, b = m.split(" ", 1)
    return a, b


def vocab_layout(tj: dict) -> dict:
    """Classify the ids of a byte-level BPE tokenizer.json: base symbols, merge results, added tokens."""
    model = tj["model"]
    if model.get("type") != "BPE":
        raise ValueError(f"not a BPE tokenizer: {model.get('type')}")
    vocab: dict[str, int] = model["vocab"]
    merges = [_merge_parts(m) for m in model["merges"]]
    added = {a["id"]: a for a in tj.get("added_tokens", [])}
    merged_ids = []
    for a, b in merges:
        t = a + b
        if t not in vocab:
            raise ValueError(f"merge result {t!r} is not in the vocabulary")
        merged_ids.append(vocab[t])
    if len(set(merged_ids)) != len(merged_ids):
        raise ValueError("two merges produce the same token; first-N pruning would be ambiguous")
    merged = set(merged_ids)
    base_ids = sorted(i for t, i in vocab.items() if i not in merged and i not in added)
    return {"vocab": vocab, "merges": merges, "merged_ids": merged_ids, "base_ids": base_ids, "added": added,
            "n_total": 1 + max([*vocab.values(), *added.keys()])}


def prune_tokenizer_json(tj: dict, n_merges: int) -> tuple[dict, list[int]]:
    """-> (pruned tokenizer.json, keep_ids) where keep_ids[new_id] = old_id (old ids in increasing order)."""
    lay = vocab_layout(tj)
    merges, merged_ids = lay["merges"], lay["merged_ids"]
    n = min(int(n_merges), len(merges))
    keep_tokens = {t for t, i in lay["vocab"].items() if i in set(lay["base_ids"])}
    for a, b in merges[:n]:
        if a not in keep_tokens or b not in keep_tokens:
            raise ValueError(f"merges are not closed under composition at {a!r}+{b!r}")
        keep_tokens.add(a + b)
    keep_old = set(lay["base_ids"]) | set(merged_ids[:n]) | set(lay["added"])
    # added tokens that also sit in model.vocab (|||IP_ADDRESS|||, whitespace runs, ...) are kept with them
    keep_ids = sorted(keep_old)
    remap = {old: new for new, old in enumerate(keep_ids)}

    out = copy.deepcopy(tj)
    out["model"]["vocab"] = {t: remap[i] for t, i in lay["vocab"].items() if i in remap}
    out["model"]["merges"] = [list(m) if isinstance(m, (list, tuple)) else m for m in tj["model"]["merges"][:n]]
    for a in out.get("added_tokens", []):
        a["id"] = remap[a["id"]]
    _remap_ids_in_place(out.get("post_processor"), remap)
    if isinstance(out.get("padding"), dict) and "pad_id" in out["padding"]:
        out["padding"]["pad_id"] = remap.get(out["padding"]["pad_id"], out["padding"]["pad_id"])
    return out, keep_ids


def _remap_ids_in_place(node: Any, remap: dict[int, int]) -> None:
    """TemplateProcessing special_tokens carry explicit ids: {"[CLS]": {"id": "[CLS]", "ids": [50281], ...}}."""
    if isinstance(node, dict):
        if "ids" in node and isinstance(node["ids"], list) and all(isinstance(x, int) for x in node["ids"]):
            node["ids"] = [remap[x] for x in node["ids"]]
        for v in node.values():
            _remap_ids_in_place(v, remap)
    elif isinstance(node, list):
        for v in node:
            _remap_ids_in_place(v, remap)


def remap_tokenizer_config(cfg: dict, remap: dict[int, int]) -> dict:
    out = copy.deepcopy(cfg)
    atd = out.get("added_tokens_decoder")
    if isinstance(atd, dict):
        out["added_tokens_decoder"] = {str(remap[int(k)]): v for k, v in atd.items() if int(k) in remap}
    return out


CONFIG_ID_KEYS = ("pad_token_id", "bos_token_id", "eos_token_id", "cls_token_id", "sep_token_id", "mask_token_id",
                  "unk_token_id", "decoder_start_token_id")


def remap_model_config(cfg: dict, remap: dict[int, int], vocab_size: int) -> dict:
    out = dict(cfg)
    out["vocab_size"] = vocab_size
    for k in CONFIG_ID_KEYS:
        if isinstance(out.get(k), int) and out[k] in remap:
            out[k] = remap[out[k]]
    return out


# ---------------------------------------------------------------------------- weights


def _embedding_keys(sd_keys: Iterable[str], shapes: dict[str, tuple[int, ...]], old_vocab: int) -> list[str]:
    """Every tensor indexed by token id: the [V, d] input table (and, in MLM bases, a tied [V, d] decoder weight
    and its [V] bias)."""
    keys = [k for k in sd_keys if len(shapes[k]) in (1, 2) and shapes[k][0] == old_vocab]
    if not any(len(shapes[k]) == 2 for k in keys):
        raise ValueError(f"no [vocab={old_vocab}, d] tensor in the backbone weights")
    return keys


def _read_weights(src: Path) -> tuple[dict, dict | None]:
    import torch

    if src.suffix == ".safetensors":
        from safetensors import safe_open

        tensors = {}
        with safe_open(str(src), framework="pt") as f:
            meta = f.metadata()
            for k in f.keys():
                tensors[k] = f.get_tensor(k)
        return tensors, meta
    sd = torch.load(str(src), map_location="cpu", weights_only=True)  # pytorch_model.bin (ettin HF bases)
    return {k: v.clone().contiguous() for k, v in sd.items()}, {"format": "pt"}


def slice_weights(src: Path, dst: Path, keep_ids: Sequence[int], old_vocab: int) -> list[str]:
    """Slice one weights file (safetensors or pytorch .bin) to the kept ids; always writes safetensors."""
    from safetensors.torch import save_file
    import torch

    idx = torch.tensor(list(keep_ids), dtype=torch.long)
    tensors, meta = _read_weights(src)
    shapes = {k: tuple(v.shape) for k, v in tensors.items()}
    keys = _embedding_keys(tensors, shapes, old_vocab)
    for k in keys:
        tensors[k] = tensors[k].index_select(0, idx).contiguous()
    save_file(tensors, str(dst), metadata=meta)
    return keys


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def prune_hf_dir(src: Path, dst: Path, n_merges: int) -> dict:
    """An HF model dir (config.json, *.safetensors, tokenizer.json, tokenizer_config.json, ...) -> pruned copy."""
    tj = json.loads((src / "tokenizer.json").read_text())
    new_tj, keep_ids = prune_tokenizer_json(tj, n_merges)
    remap = {old: new for new, old in enumerate(keep_ids)}
    cfg = json.loads((src / "config.json").read_text())
    old_vocab = int(cfg["vocab_size"])
    n_tok = vocab_layout(tj)["n_total"]
    if n_tok != old_vocab:
        # ettin bases pad the embedding table beyond the tokenizer (50368 rows, 50368 ids here: equal); a checkpoint
        # whose table is bigger than its tokenizer keeps only tokenizer rows.
        print(f"[prune] note: tokenizer has {n_tok} ids, embedding table {old_vocab} rows", file=sys.stderr)
    dst.mkdir(parents=True, exist_ok=True)
    files = sorted(src.glob("*.safetensors"))
    if not files and (src / "pytorch_model.bin").is_file():
        files = [src / "pytorch_model.bin"]
    if not files:
        raise FileNotFoundError(f"{src}: no *.safetensors or pytorch_model.bin")
    emb_keys = []
    for f in files:
        out_name = f.name if f.suffix == ".safetensors" else "model.safetensors"
        try:
            emb_keys += slice_weights(f, dst / out_name, keep_ids, old_vocab)
        except ValueError:
            shutil.copy2(f, dst / f.name)  # a shard without the embedding table
    if not emb_keys:
        raise ValueError("embedding table not found in any shard")
    (dst / "config.json").write_text(json.dumps(remap_model_config(cfg, remap, len(keep_ids)), indent=2))
    (dst / "tokenizer.json").write_text(json.dumps(new_tj, ensure_ascii=False))
    if (src / "tokenizer_config.json").is_file():
        tc = json.loads((src / "tokenizer_config.json").read_text())
        (dst / "tokenizer_config.json").write_text(json.dumps(remap_tokenizer_config(tc, remap), indent=2))
    for extra in ("special_tokens_map.json", "generation_config.json", "README.md", "LICENSE"):
        if (src / extra).is_file():
            shutil.copy2(src / extra, dst / extra)
    info = {"merges_kept": min(n_merges, len(tj["model"]["merges"])), "merges_total": len(tj["model"]["merges"]),
            "vocab_old": old_vocab, "vocab_new": len(keep_ids), "embedding_keys": emb_keys,
            "source": str(src), "source_tokenizer_sha256": _sha256(src / "tokenizer.json")}
    (dst / "prune.json").write_text(json.dumps(info, indent=2))
    return info


def prune_checkpoint(src: Path, dst: Path, n_merges: int) -> dict:
    """A GenClass fast-engine checkpoint -> pruned checkpoint (heads/calibration unchanged, meta annotated)."""
    if not (src / "backbone").is_dir():
        raise FileNotFoundError(f"{src}: not a fast-engine checkpoint (no backbone/)")
    tmp = dst.parent / f".{dst.name}.tmp"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    info = prune_hf_dir(src / "backbone", tmp / "backbone", n_merges)
    for f in ("heads.safetensors", "calibration.json"):
        if (src / f).is_file():
            shutil.copy2(src / f, tmp / f)
    meta = json.loads((src / "meta.json").read_text()) if (src / "meta.json").is_file() else {}
    meta["vocab_pruned"] = {k: info[k] for k in ("merges_kept", "merges_total", "vocab_old", "vocab_new")}
    meta["pruned_from"] = str(src)
    (tmp / "meta.json").write_text(json.dumps(meta, indent=2))
    if dst.exists():
        shutil.rmtree(dst)
    tmp.rename(dst)
    return info


# ---------------------------------------------------------------------------- analysis


def _load_backend(tj: dict):
    from tokenizers import Tokenizer

    t = Tokenizer.from_str(json.dumps(tj))
    t.encode_special_tokens = True  # Packer semantics: user text never produces special ids
    return t


def iter_texts(paths: Sequence[Path], limit_rows: int = 2000) -> Iterable[str]:
    """Texts the packer would tokenize: state segments ("key: text"), question headers and items."""
    sys.path.insert(0, str(Path.home() / "jev"))
    from jev_local.schema import question_from_json
    from jev_local.serialize import question_block, state_segments

    for p in paths:
        p = Path(p)
        if p.suffix == ".txt":
            yield from (ln.rstrip("\n") for ln in p.open() if ln.strip())
            continue
        with p.open() as f:
            for n, line in enumerate(f):
                if n >= limit_rows:
                    break
                obj = json.loads(line)
                for s in state_segments(obj["state"]):
                    yield f"{s.key}: {s.text}" if s.key else s.text
                for qid, q in obj.get("questions", {}).items():
                    b = question_block(qid, question_from_json(q))
                    yield b.header
                    yield from b.items


def analyze(src: Path, groups: dict[str, Sequence[Path]], merges: Sequence[int], limit_rows: int = 2000) -> dict:
    tdir = src / "backbone" if (src / "backbone").is_dir() else src
    tj = json.loads((tdir / "tokenizer.json").read_text())
    full = _load_backend(tj)
    n_full_merges = len(tj["model"]["merges"])
    report: dict = {"source": str(src), "merges_total": n_full_merges, "groups": {}}
    pruned = {n: _load_backend(prune_tokenizer_json(tj, n)[0]) for n in merges}
    for name, paths in groups.items():
        texts = list(iter_texts(paths, limit_rows))
        chars = sum(len(t) for t in texts)
        base = sum(len(e.ids) for e in full.encode_batch(texts, add_special_tokens=False))
        g = {"texts": len(texts), "chars": chars, "tokens_full": base, "tokens_per_char_full": round(base / max(chars, 1), 4),
             "by_merges": {}}
        for n, tk in pruned.items():
            c = sum(len(e.ids) for e in tk.encode_batch(texts, add_special_tokens=False))
            g["by_merges"][str(n)] = {"tokens": c, "tokens_per_char": round(c / max(chars, 1), 4),
                                      "inflation": round(c / max(base, 1) - 1, 4)}
        report["groups"][name] = g
    return report


# ---------------------------------------------------------------------------- CLI


def main(argv: Sequence[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="prune_vocab.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prune")
    p.add_argument("--src", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--merges", type=int, required=True)
    a = sub.add_parser("analyze")
    a.add_argument("--src", type=Path, required=True)
    a.add_argument("--group", action="append", default=[], help="name=path1,path2 (jsonl rows or .txt lines)")
    a.add_argument("--merges", default="8000,12000,16000,24000,32000")
    a.add_argument("--limit-rows", type=int, default=2000)
    a.add_argument("--out", type=Path, default=None)
    args = ap.parse_args(argv)
    if args.cmd == "prune":
        if (args.src / "backbone").is_dir():
            info = prune_checkpoint(args.src, args.out, args.merges)
        else:
            info = prune_hf_dir(args.src, args.out, args.merges)
        print(json.dumps(info, indent=2))
    else:
        groups = {}
        for g in args.group:
            name, paths = g.split("=", 1)
            groups[name] = [Path(x) for x in paths.split(",") if x]
        rep = analyze(args.src, groups, [int(x) for x in args.merges.split(",")], args.limit_rows)
        txt = json.dumps(rep, indent=2)
        if args.out:
            args.out.write_text(txt)
        print(txt)


if __name__ == "__main__":
    main()
