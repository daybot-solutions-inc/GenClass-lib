"""REAL eval set (realapps/scripts/evalset.py: rows with meta.eval_case / meta.eval_expect) under the runtime gate.

    python training/eval_real.py --rows data/realev/test.jsonl \
        --model r17-v2a=out/records/r17-v2a__realev__test.jsonl:out/cal/r17-v2a-sim2e.json [--out out/eval/real-r17-v2a.json]

Per case and per mode (guard = guard-tier actions permitted; heal = guard + heal), CONTRACT §8 gate: candidate = argmax
calibrated p over permitted non-passive actions A, run iff Σ_A p ≥ threshold (guard 0.9 / heal 0.8; also 0.5/0.7 for
the curve) and top diagnosis ≠ expected. Reports:
  passive cases (clean-benign, benign-salient): fired share = false-intervention rate (any action is wrong)
  action cases (stale-overwrite, duplicate-submit, genuine-break): recall = fired with an expected action,
  wrong-action share = fired with a non-expected action; plus argmax accuracy (top action ∈ expected, all actions).
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np

PERMIT = {"guard": ("guard",), "heal": ("guard", "heal")}
TH = {"guard": (0.9, 0.7, 0.5), "heal": (0.8, 0.7, 0.5)}


def softmax(z, tau):
    z = np.asarray(z, np.float64) / tau
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


def evaluate(rows: dict, recs: dict, cal: dict) -> dict:
    tau = float(cal.get("choice", 1.0))
    out: dict = {}
    for mode in ("guard", "heal"):
        st = defaultdict(lambda: defaultdict(float))
        for rid, q in recs.items():
            if rid not in rows or "action" not in q:
                continue
            m = rows[rid]
            case, expect = m.get("eval_case"), set(m.get("eval_expect") or [])
            tiers = m.get("tiers") or {}
            ra = q["action"]
            names = list(ra["labels"])
            passive = m.get("passive") or next((a for a, t in tiers.items() if t == "passive"), None)
            bh = cal.get("by_header") or {}
            p = softmax(ra["logits"], float(bh.get(ra.get("header"), tau)))
            top = names[int(p.argmax())]
            top_d = None
            if "diagnosis" in q:
                rd = q["diagnosis"]
                top_d = list(rd["labels"])[int(softmax(rd["logits"], float(bh.get(rd.get("header"), tau))).argmax())]
            A = [a for a in names if a != passive and tiers.get(a, "heal") in PERMIT[mode]]
            keys = [case, "ALL"] + ([f"{case} [test split]"] if m.get("_split") == "test" else [])
            idx = {a: i for i, a in enumerate(names)}
            mass = float(sum(p[idx[a]] for a in A)) if A else 0.0
            cand = max(A, key=lambda a: p[idx[a]]) if A else None
            for key in keys:
                s = st[key]
                s["rows"] += 1
                s["argmax_ok"] += int(top in expect)
                for t in TH[mode]:
                    fired = bool(A) and mass >= t and top_d != "expected"
                    s[f"fired@{t}"] += int(fired)
                    s[f"hit@{t}"] += int(fired and cand in expect)
        res = {}
        for case, s in st.items():
            n = max(s["rows"], 1)
            r = {"rows": int(s["rows"]), "argmax_acc": round(s["argmax_ok"] / n, 4)}
            for t in TH[mode]:
                r[f"fired@{t}"] = round(s[f"fired@{t}"] / n, 4)
                r[f"recall@{t}"] = round(s[f"hit@{t}"] / n, 4)
            res[case] = r
        out[mode] = res
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=Path, required=True)
    ap.add_argument("--model", action="append", required=True, help="name=records.jsonl:calibration.json")
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args()
    rows = {}
    with a.rows.open() as f:
        for line in f:
            r = json.loads(line)
            rows[r["id"]] = {**(r.get("meta") or {}), "_split": r.get("split")}
    report = {}
    for spec in a.model:
        name, rest = spec.split("=", 1)
        rec_path, _, cal_path = rest.partition(":")
        recs: dict = defaultdict(dict)
        with open(rec_path) as f:
            for line in f:
                r = json.loads(line)
                if r["qid"] in ("action", "diagnosis"):
                    recs[r["id"]][r["qid"]] = r
        cal = json.loads(Path(cal_path).read_text()) if cal_path else {}
        report[name] = evaluate(rows, recs, cal)
    txt = json.dumps(report, indent=1)
    if a.out:
        a.out.write_text(txt)
    for name, r in report.items():
        for mode, cases in r.items():
            th = TH[mode]
            print(f"\n{name} [{mode}]  case: rows argmax | fired@{th[0]} recall@{th[0]} | fired@{th[2]} recall@{th[2]}")
            for case, x in sorted(cases.items()):
                print(f"  {case:18s} {x['rows']:6d} {x['argmax_acc']:.3f} | {x[f'fired@{th[0]}']:.4f} {x[f'recall@{th[0]}']:.4f}"
                      f" | {x[f'fired@{th[2]}']:.4f} {x[f'recall@{th[2]}']:.4f}")


if __name__ == "__main__":
    main()
