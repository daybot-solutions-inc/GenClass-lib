"""Python reference outputs for the TypeScript model ports (packages/runtime/src/model).

Run on the VM (needs the jev venv: tokenizers, numpy, pydantic) from the repo root:

    ~/jev/.venv/bin/python packages/runtime/test/fixtures/model/make_py_fixtures.py \
        --tokenizer <model dir>/tokenizer.json --out packages/runtime/test/fixtures/model/py_fixtures.json

Sections:
    serialize   jev_local.serialize state_segments / question_block on edge-case JSON values
    tokenize    HF tokenizers ids (add_special_tokens=False, encode_special_tokens=True) on edge-case strings
    calibrate   jev_local.engine.encoder.calibrate.calibrate_logits with v1 and v2 calibration files
    confidence  jev_local.confidence choice/score confidence and score value

Inputs are plain JSON with integral numbers written as ints, so `json.loads(JSON.stringify(x))` in the runtime
path gives Python exactly the values used here.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(ROOT))

from tokenizers import Tokenizer  # noqa: E402

from jev_local.confidence import choice_confidence, score_confidence, score_value  # noqa: E402
from jev_local.engine.encoder.calibrate import calibrate_logits, header_key  # noqa: E402
from jev_local.schema import question_from_json  # noqa: E402
from jev_local.serialize import question_block, state_segments  # noqa: E402

STATES = [
    "  plain string state  ",
    "",
    {"app": "Shop, route /cart", "facts": ["first fact", "second fact", "", "  padded  "], "n": 3},
    {"ints": 42, "neg": -7, "zero": 0, "big": 10**16, "max_safe": 2**53 - 1, "huge": 1e21, "huge2": 1.5e+22},
    {"floats": 0.1, "f2": 1.5, "f3": -2.25, "tiny": 1e-05, "tiny2": 0.000123, "tiny3": 1.5e-07, "tiny4": 0.0001,
     "edge": 0.00012345678901234, "pi": 3.141592653589793, "neg_tiny": -3.2e-06, "large": 1.5e+300, "small": 5e-324},
    {"bools": True, "f": False, "none": None, "empty": "", "space": "   "},
    {"nested": {"a": 1, "b": [1, 2, {"c": None}], "d": {"e": "x"}}, "list_mixed": [1, "two", 3.5, None, True]},
    {"list_of_dicts": [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}], "strings": ["x", "y"], "empty_list": []},
    {"dict_value": {"price": 9.99, "items": ["a", "b"], "meta": {"k": "v"}, "flag": False, "nil": None, "f": 1e-06}},
    {"unicode": "café — naïve 東京 😀  nbsp em", "ws": "\t tab and newline \n", "nel": "\u0085x\u0085"},
    {"feff": "﻿bom", "ctrl": "a\u001cb\u001f", "crlf": "line1\r\nline2"},
    [f"item {i}" for i in range(70)],
    [1, 2.5, None, "x", {"a": 1}, ["p", "q"], [1, "z"]],
    {"arr_strings_with_empty": ["a", "", "b"], "arr_nested": [["a"], ["b", "c"]]},
    {"quote": 'he said "hi" \\ backslash', "json_like": '{"a": 1}', "unicode_escape": " sep "},
    {"timeline": ["-1.24s user click \"Refresh\"", "-0.05s state orders.items v6"], "stats": "none"},
    {"float_keys": {"x": 1e+22, "y": 2.5e-5, "z": -0.0001, "w": 123.456}},
]

QUESTIONS = [
    {"type": "noul", "instructions": "Is it true?"},
    {"type": "noul", "instructions": "  ", "criteria": {"true": "yes it is", "false": ""}},
    {"type": "noul", "instructions": {"q": "dict instructions", "n": 2}, "criteria": {"true": ["a", "b"]}},
    {"type": "choice", "instructions": "Pick one", "criteria": {"apply": "let it apply", "discard": None, "defer": "defer", "x": "  "}},
    {"type": "choice", "instructions": "", "criteria": {"a": {"desc": "nested", "n": 1}, "b": ["l1", "l2"], "c": [1, 2]}},
    {"type": "score", "instructions": "Rate it", "criteria": ["low", "  mid  ", {"level": "high"}, ["x", "y"]]},
    {"type": "score", "instructions": None, "criteria": ["only"]},
]

TEXTS = [
    "", " ", "  ", "a", "hello world", " leading", "trailing ", "a  b", "a   b", "a\tb", "a\nb", "a\n\nb", "a \n b",
    "line1\r\nline2", "x" + " " * 30 + "y", " " * 25, "tab\t\tdouble", "trailing spaces   ", "\n", "\n\n\n",
    "it's they're we've I'm you'll he'd IT'S", "don't 'quoted' ''", "12345 3.14 -1.24s 1,000,000 0.0001 1e-05",
    "GET /api/orders/:id?q=rea&x=1 (started 1.8 s ago)", "https://example.com/a/b?c=d#e", "{\"a\": 1, \"b\": [1, 2]}",
    "café — naïve 東京 😀", "é (combining acute) vs é", "Å Å Å", "ﬁ ligature", "👩‍👩‍👧 family",
    "مرحبا بالعالم", "Привет, мир!", "한국어 텍스트", "ไทย", " nbsp ", "em space", "ideo　space",
    "nel\u0085x", "bom﻿x", "zw​sp", "ls ps ", "ctrl\u0001\u001f", "→ ← ↑ … — –",
    "[CLS] [SEP] [Q] [O] [L] [T] [F] [PAD] [MASK] [UNK]", "click [Q] Delete all", "|||EMAIL_ADDRESS||| |||PHONE_NUMBER||| |||IP_ADDRESS|||",
    "[unused0] [unused12] [unused99]", "x|||EMAIL_ADDRESS|||y", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "orders.items: 3 items (ids 17, 18, 21) → 2 items", "!!!???...,,,;;;", "$100.00 €5 £3 ¥7", "under_score camelCase kebab-case",
    "UPPER lower MiXeD", "\U0001F600\U0001F601\U0001F602", "\U00010348 gothic", "a\u0000b",
]


def bytes_to_unicode_chars() -> list[str]:
    bs = list(range(33, 127)) + list(range(161, 173)) + list(range(174, 256))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return [chr(c) for c in cs]


def prune_tokenizer(tj: dict, n_merges: int) -> dict:
    """Pruned vocabulary like the runtime model's export: the 256 byte tokens, the first n merges and every added
    token, renumbered by old id. Mirrors pruneTokenizer() in test/model/helpers.ts."""
    model = tj["model"]
    merges = model["merges"][:n_merges]
    # bytes that never occur in UTF-8 (0xC0, 0xC1, 0xF5-0xFF) may be absent from the vocab
    keep = {c for c in bytes_to_unicode_chars() if c in model["vocab"]}
    for m in merges:
        a, b = m if isinstance(m, list) else m.split(" ")
        keep.add(a + b)
    added = tj.get("added_tokens", [])
    old = {s: model["vocab"][s] for s in keep}
    for t in added:
        old[t["content"]] = t["id"]
    new = {s: i for i, (s, _) in enumerate(sorted(old.items(), key=lambda kv: kv[1]))}
    added_contents = {t["content"] for t in added}
    vocab = {s: new[s] for s in model["vocab"] if s in keep or s in added_contents}
    out = dict(tj)
    out["added_tokens"] = [{**t, "id": new[t["content"]]} for t in added]
    out["model"] = {**model, "vocab": vocab, "merges": merges}
    return out


def vocab_digest(tj: dict) -> str:
    import hashlib

    lines = [f"{t}\t{i}" for t, i in tj["model"]["vocab"].items()] + [f"+{t['content']}\t{t['id']}" for t in tj["added_tokens"]]
    return hashlib.sha256("\n".join(sorted(lines)).encode("utf-8")).hexdigest()


def seg_list(state):
    return [[s.key, s.text] for s in state_segments(state)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokenizer", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    out: dict = {}

    out["serialize"] = {
        "states": [{"state": s, "segments": seg_list(s)} for s in STATES],
        "questions": [],
    }
    for i, q in enumerate(QUESTIONS):
        b = question_block(f"q{i}", question_from_json(q))
        out["serialize"]["questions"].append({"question": q, "kind": b.kind, "header": b.header, "items": list(b.items), "labels": list(b.labels)})

    tok = Tokenizer.from_file(str(args.tokenizer))
    tok.encode_special_tokens = True
    rng = random.Random(7)
    texts = list(TEXTS)
    # random byte soup over printable ASCII + some unicode, to exercise merges
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;'\"!?-_/\\()[]{}<>@#$%^&*+=|~`\n\t" + "éüßøåç東京😀—…→"
    for _ in range(40):
        texts.append("".join(rng.choice(alphabet) for _ in range(rng.randint(1, 80))))
    out["tokenize"] = [{"text": t, "ids": tok.encode(t, add_special_tokens=False).ids} for t in texts]

    # The same texts with a pruned vocabulary (runtime-model style: 16,364 tokens, markers at the end).
    full = json.loads(args.tokenizer.read_text())
    n_merges = 16000  # 243 byte tokens + 16,000 merges + 121 added = 16,364 (markers 16359..16363), as TRAIN prunes
    pruned = prune_tokenizer(full, n_merges)
    ptok = Tokenizer.from_str(json.dumps(pruned))
    ptok.encode_special_tokens = True
    out["pruned"] = {
        "n_merges": n_merges,
        "vocab_size": 1 + max([*pruned["model"]["vocab"].values(), *(t["id"] for t in pruned["added_tokens"])]),
        "digest": vocab_digest(pruned),
        "markers": {m: ptok.token_to_id(m) for m in ("[Q]", "[O]", "[L]", "[T]", "[F]", "[CLS]", "[SEP]")},
        "texts": [{"text": t, "ids": ptok.encode(t, add_special_tokens=False).ids} for t in texts],
    }

    calib_v1 = json.loads((args.tokenizer.parent / "calibration.json").read_text()) if (args.tokenizer.parent / "calibration.json").exists() else {"noul": 1.4, "choice": 0.7, "score": 0.9, "by_header": {}}
    headers = ["What should the runtime do with this write?", "What is going on?", "Is the statement true of the state?", "Rate it"]
    calib_v2 = {
        "noul": 1.3, "choice": 0.8, "score": 0.9,
        "by_header": {header_key(headers[0]): 0.66},
        "version": 2, "bucket_clamp": [0.5, 5.0],
        "by_bucket": {"choice:2": 0.9, "choice:6-10": 1.7, "score:3-5": 1.2},
        "tau_k": {"choice": [0.7, 0.15], "score": [0.95, -0.4]},
        "noul_platt": {"a": 0.8, "b": -0.25},
    }
    cases = []
    for calib_name, calib in (("v1", calib_v1), ("v2", calib_v2)):
        for _ in range(60):
            kind = rng.choice(["noul", "choice", "score"])
            k = 1 if kind == "noul" else rng.choice([2, 3, 4, 5, 6, 8, 10, 11, 20, 31, 64, 101, 200])
            header = rng.choice(headers + ["Some other header %d" % rng.randint(0, 9)])
            logits = [round(rng.uniform(-12, 12), 6) for _ in range(k)]
            p = calibrate_logits(kind, header_key(header), logits, calib)
            cases.append({"calib": calib_name, "kind": kind, "header": header, "header_key": header_key(header), "logits": logits, "probs": [float(x) for x in p]})
    out["calibrate"] = {"calibrations": {"v1": calib_v1, "v2": calib_v2}, "cases": cases}

    conf = []
    for _ in range(80):
        k = rng.choice([1, 2, 3, 4, 5, 7, 10])
        raw = [rng.random() ** 3 for _ in range(k)]
        if rng.random() < 0.2:
            raw[rng.randrange(k)] = raw[0]  # ties
        s = sum(raw)
        p = [x / s for x in raw]
        conf.append({"p": p, "choice_confidence": choice_confidence(p), "score_confidence": score_confidence(p), "score": score_value(p)})
    out["confidence"] = conf

    args.out.write_text(json.dumps(out, ensure_ascii=False))
    print(f"wrote {args.out}: {len(out['serialize']['states'])} states, {len(out['tokenize'])} texts, {len(cases)} calibration cases, {len(conf)} confidence cases")


if __name__ == "__main__":
    main()
