"""Curriculum generator tests (run on a VM: imports jev_local for schema/label validation).

    cd ~/gcl-train && PYTHONPATH=~/jev ~/jev/.venv/bin/python -m pytest -q training/tests/test_curriculum.py
"""

from __future__ import annotations

import random
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parents[1] / "curriculum"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(Path.home() / "jev"))

import generate as G  # noqa: E402
from fmt import TEMPLATES, held_count, pick_from  # noqa: E402
from vocab import DOMAINS, TEST_DOMAINS  # noqa: E402


def _rows(split: str, n: int, seed: int = 0) -> list[dict]:
    rng = random.Random(f"t{seed}:{split}")
    out = []
    while len(out) < n:
        r = G.make_row(rng, split)
        if r is not None:
            out.append(r)
    return out


def test_all_rows_valid_and_deterministic():
    a = _rows("train", 400, 1)
    b = _rows("train", 400, 1)
    assert [r["state"] for r in a] == [r["state"] for r in b]
    bad = [G._validate(r) for r in a]
    assert not any(bad), [x for x in bad if x][:3]


def test_test_split_uses_only_heldout_domains():
    tr = _rows("train", 300, 2)
    te = _rows("test", 300, 2)
    assert all(r["meta"]["domain"] not in TEST_DOMAINS for r in tr)
    assert all(r["meta"]["domain"] in TEST_DOMAINS for r in te)
    assert 0.15 <= len(TEST_DOMAINS) / len(DOMAINS) <= 0.3


def test_heldout_templates_never_in_train_picks():
    rng = random.Random(0)
    for key, items in TEMPLATES.items():
        h = held_count(len(items))
        if not h:
            continue
        held = set(items[-h:])
        for _ in range(200):
            assert pick_from(rng, items, False) not in held


def test_decision_labels_consistent():
    rows = [r for r in _rows("train", 1500, 3) if r["meta"].get("kind") == "decision"]
    assert len(rows) > 500
    passive = Counter()
    for r in rows:
        if "action" not in r["questions"]:  # one applicable action: not asked (like the runtime)
            assert "action" not in r["labels"]
            continue
        q = r["questions"]["action"]
        lab = r["labels"]["action"]
        if "label" in lab:
            assert lab["label"] in q["criteria"]
        else:
            assert abs(sum(lab["dist"].values()) - 1) < 1e-6 and set(lab["dist"]) <= set(q["criteria"])
        d = r["labels"]["diagnosis"]
        assert (d.get("label") or max(d["dist"], key=d["dist"].get)) in r["questions"]["diagnosis"]["criteria"]
        assert r["meta"]["passive"] in q["criteria"]
        passive[r["meta"]["passive_best"]] += 1
    frac = passive[True] / sum(passive.values())
    assert 0.45 <= frac <= 0.75, frac  # benign look-alikes must be abundant (precision first)


def test_stale_vs_benign_versions_semantics():
    """In typeahead/detail scenarios the `v_newer` primitive must agree with the decision label."""
    rows = [r for r in _rows("train", 3000, 4) if r["meta"].get("kind") == "decision"
            and r["meta"]["case"].split("/")[0] in ("typeahead", "detail") and "v_newer" in r["labels"]]
    assert rows
    for r in rows:
        newer = r["labels"]["v_newer"]["p"] == 1.0
        case = r["meta"]["case"].split("/")[1]
        if case == "stale":
            assert newer, r["meta"]["case"]
        if case in ("fresh", "older_between", "same_root", "moved_inflight"):
            assert not newer, r["meta"]["case"]


def test_runtime_rows_situation_v2():
    """rt.py mirrors the frozen `situation-v2` renderer: deliveries appear, labels map to the runtime's actions, the
    situation fits the 2,400-char full budget. Pure Python (no jev_local import)."""
    import rows as R
    import rt
    from app import App
    from fmt import Style

    seen = Counter()
    for i in range(1500):
        rng = random.Random(f"rt2:{i}")
        app = App(rng, rng.choice(G.TRAIN_DOMAINS))
        st = Style.make(rng, False)
        trig = rng.choices(list(G.TRIGGERS), [w for _, w in G.TRIGGERS.values()])[0]
        sc = G.TRIGGERS[trig][0](rng, app, st)
        r = R.decision_row(sc, app, st, rng, 1.0)
        m = r["meta"]
        if m["style"] != "runtime":
            continue
        seen[m["trigger"]] += 1
        assert rt.size_chars(r["state"]) <= rt.STATE_CHAR_BUDGET
        if "action" in r["questions"]:
            crit = r["questions"]["action"]["criteria"]
            lab = r["labels"]["action"]
            assert (lab.get("label") or max(lab["dist"], key=lab["dist"].get)) in crit
            assert m["passive"] in crit
            assert set(crit) <= set(rt.TRIGGER_ACTIONS[m["trigger"]])
        if m["trigger"] == "delivery":
            assert "about to be delivered" in r["state"]["trigger"]
    assert seen["delivery"] > 0 and seen["mutation"] > 0
