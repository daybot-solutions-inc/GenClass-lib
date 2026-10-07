"""Tests for training/prune_vocab.py. Run on a VM (needs torch/tokenizers and the v1 checkpoint):

    cd ~/gcl-train && PYTHONPATH=~/jev ~/jev/.venv/bin/python -m pytest -q training/tests/test_prune_vocab.py

Paths: GC_V1_CKPT (default ~/jev/models/jev-local-fast), GC_BASE_32M (default ~/jev/models/base/ettin-encoder-32m).
"""

from __future__ import annotations

import json
import os
import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path.home() / "jev"))

import prune_vocab as pv  # noqa: E402

V1 = Path(os.environ.get("GC_V1_CKPT", Path.home() / "jev/models/jev-local-fast"))
BASE32 = Path(os.environ.get("GC_BASE_32M", Path.home() / "jev/models/base/ettin-encoder-32m"))
need_v1 = pytest.mark.skipif(not (V1 / "backbone/tokenizer.json").is_file(), reason="v1 checkpoint missing")

SAMPLES = [
    "GET /api/search?q=rea started 1.82 s ago; search.results v7 -> v9 written by GET /api/search?q=react.",
    'POST /api/orders {"items":[{"sku":"A-1","qty":2}],"total":59.97} 503 Service Unavailable (retry-after: 5)',
    "TypeError: Cannot read properties of undefined (reading 'map') at CartList (cart.tsx:42:17)",
    "cart.total == sum(cart.items[*].price * cart.items[*].qty) violated: 59.97 vs 79.96",
    "Ünïcödé façade — naïve café: 日本語のテキスト, 한국어, emoji 🚀🔥, math ∑∫√",
    "tabs\tand\nnewlines\r\n  and    many     spaces        and control \x01\x02\x7f bytes",
    "0xDEADBEEF 3.14159e-10 1,234,567.89 -42 +7 2026-10-07T13:01:59Z 192.168.0.1 user@example.com",
    "[Q] [O] [CLS] [SEP] <|endoftext|> |||IP_ADDRESS||| [unused5] markers must not be forged",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "camelCaseIdentifier snake_case_name kebab-case-name SCREAMING_CASE dotted.path.to.field[3].qty",
]


def _rand_strings(n: int, seed: int = 0) -> list[str]:
    rng = random.Random(seed)
    pools = [
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:/?&=_-+*#@!()[]{}<>'\"",
        "éèêëàâäôöûüçñßøåæœ€£¥©®°±µ¶·¿¡",
        "日本語中文한국어Русскийعربيहिन्दीΕλληνικά",
        "🚀🔥✨😀👍🏽👨‍👩‍👧",
        "\t\n\r \x00\x01\x1b\x7f",
    ]
    out = []
    for _ in range(n):
        k = rng.randint(1, 60)
        out.append("".join(rng.choice(rng.choice(pools)) for _ in range(k)))
    return out


@need_v1
def test_layout_matches_ettin():
    tj = json.loads((V1 / "backbone/tokenizer.json").read_text())
    lay = pv.vocab_layout(tj)
    assert len(lay["base_ids"]) == 243 and lay["base_ids"][0] == 2 and lay["base_ids"][-1] == 244
    assert lay["merged_ids"][:3] == [245, 246, 247]
    assert all(i == 245 + k for k, i in enumerate(lay["merged_ids"]))


@need_v1
@pytest.mark.parametrize("n", [4000, 8000, 16000])
def test_pruned_tokenizer_encodes_everything(n):
    tj = json.loads((V1 / "backbone/tokenizer.json").read_text())
    new_tj, keep = pv.prune_tokenizer_json(tj, n)
    full, pruned = pv._load_backend(tj), pv._load_backend(new_tj)
    V = len(keep)
    assert V == 2 + 243 + n + (len(tj["added_tokens"]) - 2)  # 0/1 are added tokens too
    texts = SAMPLES + _rand_strings(400, seed=n)
    for t in texts:
        a = full.encode(t, add_special_tokens=False)
        b = pruned.encode(t, add_special_tokens=False)
        assert all(0 <= i < V for i in b.ids), t
        # byte-level: both decode to the same text (the same bytes survive; NFC applies to both)
        assert pruned.decode(b.ids, skip_special_tokens=False) == full.decode(a.ids, skip_special_tokens=False), t
        assert len(b.ids) >= len(a.ids)
    # ids below the first dropped merge are unchanged; specials and markers moved but kept
    for tok, i in tj["model"]["vocab"].items():
        if i < 245 + n:
            assert new_tj["model"]["vocab"][tok] == i
    added = {a["content"]: a for a in new_tj["added_tokens"]}
    for m in ("[Q]", "[O]", "[L]", "[T]", "[F]", "[CLS]", "[SEP]", "[PAD]", "[MASK]", "[UNK]"):
        assert added[m]["special"] and added[m]["id"] >= 245 + n
    # markers in user text are never matched (encode_special_tokens), like the Packer
    ids = pruned.encode("[Q] option [O]", add_special_tokens=False).ids
    assert added["[Q]"]["id"] not in ids and added["[O]"]["id"] not in ids


@need_v1
def test_unchanged_tokenization_gives_identical_outputs(tmp_path):
    import numpy as np
    import torch

    from jev_local.engine.encoder.engine import FastEngine
    from jev_local.schema import question_from_json

    n = 16000
    dst = tmp_path / "r32-v16k"
    info = pv.prune_checkpoint(V1, dst, n)
    assert info["vocab_new"] == 245 + n + 119
    tj = json.loads((V1 / "backbone/tokenizer.json").read_text())
    full = pv._load_backend(tj)
    new_tj = json.loads((dst / "backbone/tokenizer.json").read_text())
    pruned = pv._load_backend(new_tj)
    keep = sorted(set(range(245 + n)) | {a["id"] for a in tj["added_tokens"]})
    remap = {o: k for k, o in enumerate(keep)}
    common = ("the user clicked save and the request to the server returned an error after a short time while "
              "another request was still running so the page shows old data from before the change")

    def unchanged(t: str) -> bool:
        return all(i < 245 + n or i >= 50254 for i in full.encode(t, add_special_tokens=False).ids)

    words = [w for w in common.split() if unchanged(w) and unchanged(" " + w)]
    assert len(words) >= 20
    rng = random.Random(1)
    reqs = []
    for r in range(6):
        st = {"a": "the main page", "b": " ".join(rng.sample(words, 12)),
              "c": ". ".join(" ".join(rng.sample(words, 10)) for _ in range(4))}
        qs = {"action": {"type": "choice", "instructions": "what should the page do now",
                         "criteria": {"ok": "let the change happen", "drop": "drop the change and keep the old data",
                                      "wait": "wait for the other request"}},
              "old": {"type": "noul", "instructions": "is the data on the page old"},
              "lvl": {"type": "score", "instructions": "how bad is the error", "criteria": ["none", "small", "big"]}}
        reqs.append((st, qs))
    # every text in these requests tokenizes identically (after id remap) under both tokenizers
    from jev_local.serialize import question_block, state_segments
    for st, qs in reqs:
        texts = [f"{s.key}: {s.text}" for s in state_segments(st)]
        for qid, q in qs.items():
            b = question_block(qid, question_from_json(q))
            texts += [b.header, *b.items]
        for t in texts:
            assert unchanged(t), t
            a = [remap[i] for i in full.encode(t, add_special_tokens=False).ids]
            assert a == pruned.encode(t, add_special_tokens=False).ids, t
    e_full = FastEngine(V1, device="cpu", dtype=torch.float32, encoder="banded")
    e_new = FastEngine(dst, device="cpu", dtype=torch.float32, encoder="banded")
    worst = 0.0
    for st, qs in reqs:
        q = {k: question_from_json(v) for k, v in qs.items()}
        la, lb = e_full.evaluate_logits(st, q), e_new.evaluate_logits(st, q)
        for k in la:
            worst = max(worst, float(np.abs(np.array(la[k]["logits"]) - np.array(lb[k]["logits"])).max()))
    assert worst < 1e-4, worst


@pytest.mark.skipif(not (BASE32 / "tokenizer.json").is_file(), reason="ettin-32m base missing")
def test_hf_base_prune_then_init_model(tmp_path):
    import torch

    from jev_local.engine.encoder.engine import init_model
    from jev_local.engine.encoder.tokenize_pack import MARKERS, Packer
    from jev_local.serialize import Segment, QBlock

    dst = tmp_path / "ettin32-v8k"
    info = pv.prune_hf_dir(BASE32, dst, 8000)
    enc, heads, tok = init_model(str(dst), seed=0, encoder="banded")
    V = info["vocab_new"]
    assert len(tok) == V + len(MARKERS)
    assert enc.backbone.get_input_embeddings().num_embeddings == V + len(MARKERS)
    vocab = tok.get_vocab()
    assert [vocab[m] for m in MARKERS] == list(range(V, V + len(MARKERS)))
    p = Packer(tok, max_len=512)
    pk = p.pack([Segment("facts", "GET /api/items failed 3 times in a row")],
                [QBlock("q", "choice", "what now", ("send", "delay"), ("send", "delay"))])
    assert max(pk.input_ids) < V + len(MARKERS)
    with torch.no_grad():
        from jev_local.engine.encoder.tokenize_pack import collate_tree
        from jev_local.engine.encoder.heads import build_plan
        tb = collate_tree([pk], p.pad_id, enc.window)
        out = heads(enc(tb), build_plan([pk], tb.row_offsets))
    assert out.choice is not None and torch.isfinite(out.choice[:, :2]).all()
