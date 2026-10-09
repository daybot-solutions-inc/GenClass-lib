"""Observe-mode detection quality and the shipped `gate.report` threshold (fitted on dev, verified on test).

    python training/fit_report.py --cal out/export-M/calibration.json \
        --fit  sim=data/sim2g/dev.jsonl:out/records/M__sim2g__dev.jsonl \
        --fit  real=data/realev/test.jsonl:out/records/M__realev__test.jsonl:notest \
        --test sim2e=data/sim2e/test.jsonl:out/records/M__sim2e__test.jsonl \
        --test sim2f=data/sim2f/test.jsonl:out/records/M__sim2f__test.jsonl \
        --test real2e=data/real2e/test.jsonl:out/records/M__real2e__test.jsonl \
        --test realev=data/realev/test.jsonl:out/records/M__realev__test.jsonl:test \
        --out out/gates/M-report.json [--write-meta out/export-M]

A Detection (runtime observe mode): top calibrated diagnosis ≠ expected and its probability ≥ report threshold r.
Per set and threshold r ∈ 0.50…0.95: per diagnosis class precision (detections of c whose gold diagnosis is c) and
recall (gold-c rows detected as c); the false-detection rate on REAL clean-benign + benign-salient rows (any detection)
and on SIM passive-best rows (any detection), plus on gold-`expected` rows; REAL eval categories: share detected with
the category's diagnosis (stale-overwrite → stale, duplicate-submit → duplicate, genuine-break → inconsistent) and
with any diagnosis. Sets named sim* use SIM passive-best rows, real* REAL rows; `realev` rows carry eval_case.
`gate.report` = the lowest r with false detections ≤ 1% on REAL clean + benign-salient rows and ≤ 2% on SIM
passive-best rows on the fit (dev) data — one-sided 95% Wilson upper bounds, at r and every grid value above it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path

import numpy as np

GRID = [round(0.50 + 0.05 * i, 2) for i in range(10)] + [0.97, 0.99]
LIM = {"real_benign": 0.01, "sim_expected": 0.02}
BENIGN = {"clean-benign", "benign-salient"}
DEV_MARGIN = 0.8  # the dev fit must meet 0.8 × each limit (coordinator, 08:00: no test-informed choices)
CASE_DIAG = {"stale-overwrite": "stale", "duplicate-submit": "duplicate", "genuine-break": "inconsistent"}


def wilson_upper(k: int, n: int, z: float = 1.645) -> float:
    if n == 0:
        return 0.0
    ph = k / n
    den = 1 + z * z / n
    return (ph + z * z / (2 * n) + z * np.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n))) / den


def softmax(z, tau):
    z = np.asarray(z, np.float64) / tau
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


def load(spec: str, cal: dict) -> tuple[str, list[dict]]:
    name, rest = spec.split("=", 1)
    parts = rest.split(":")
    filt = parts[2] if len(parts) > 2 else ""
    trig_in = trig_out = None
    want_gate = parts[4].split("=", 1)[1] if len(parts) > 4 and parts[4].startswith("gate=") else None
    if len(parts) > 3 and parts[3]:
        k, _, v = parts[3].partition("=")
        trig_in, trig_out = (set(v.split(",")), None) if k == "only" else (None, set(v.split(",")))
    rows = {}
    with open(parts[0]) as f:
        for line in f:
            r = json.loads(line)
            lab = (r.get("labels") or {}).get("diagnosis") or {}
            gold = lab.get("label")
            if gold is None and lab.get("dist"):
                gold = max(lab["dist"], key=lab["dist"].get)
            rows[r["id"]] = (r.get("split"), r.get("meta") or {}, gold)
    out = []
    with open(parts[1]) as f:
        for line in f:
            q = json.loads(line)
            if q["qid"] != "diagnosis" or q["id"] not in rows:
                continue
            split, m, gold = rows[q["id"]]
            if (filt == "test" and split != "test") or (filt == "notest" and split == "test"):
                continue
            trg = m.get("trigger")
            if (trig_in is not None and trg not in trig_in) or (trig_out is not None and trg in trig_out):
                continue
            if want_gate is not None and m.get("gate") != want_gate:
                continue
            bh = cal.get("by_header") or {}
            p = softmax(q["logits"], float(bh[q.get("header")]) if q.get("header") in bh else float(cal.get("choice", 1.0)))
            k = int(p.argmax())
            pb = m.get("passive_best")
            out.append({"cluster": (f"traj:{m.get('seed')}" if name.startswith("realp") else f"row:{q['id']}"),
                        "benign_gold": name.startswith("realp") and gold == "expected" and bool(pb),
                        "top": q["labels"][k], "p": float(p[k]), "gold": gold, "passive_best": bool(pb) if pb is not None else None,
                        "case": m.get("eval_case"), "trigger": m.get("trigger")})
    return name, out


def table(items: list[dict], r: float, is_sim: bool) -> dict:
    det = [it["top"] != "expected" and it["p"] >= r for it in items]
    res: dict = {"rows": len(items), "detected": round(sum(det) / max(len(items), 1), 4)}
    pc, pt, rc, rt = defaultdict(int), defaultdict(int), defaultdict(int), defaultdict(int)
    for it, d in zip(items, det):
        if it["gold"] and it["gold"] != "expected":
            rt[it["gold"]] += 1
            rc[it["gold"]] += int(d and it["top"] == it["gold"])
        if d:
            pt[it["top"]] += 1
            pc[it["top"]] += int(it["top"] == it["gold"])
    res["per_class"] = {c: {"precision": round(pc[c] / pt[c], 4) if pt[c] else None, "detections": pt[c],
                            "recall": round(rc[c] / rt[c], 4) if rt[c] else None, "gold_rows": rt[c]}
                        for c in sorted(set(pt) | set(rt))}
    tot_d = sum(pt.values())
    res["precision_all"] = round(sum(pc.values()) / tot_d, 4) if tot_d else None
    exp_rows = [d for it, d in zip(items, det) if it["gold"] == "expected"]
    res["false_on_expected"] = [sum(exp_rows), len(exp_rows)]
    if is_sim:
        pbr = [d for it, d in zip(items, det) if it["passive_best"]]
        res["false_on_sim_passive"] = [sum(pbr), len(pbr)]
    ben = [(it["cluster"], d) for it, d in zip(items, det) if it["case"] in BENIGN or (it.get("benign_gold"))]
    if ben:
        cl = {}
        for c, d in ben:  # cluster-robust (cert-set trajectories count once)
            cl[c] = cl.get(c, False) or d
        res["false_on_real_benign"] = [sum(cl.values()), len(cl)]
        cases = defaultdict(lambda: [0, 0, 0])
        for it, d in zip(items, det):
            if it["case"]:
                c = cases[it["case"]]
                c[0] += int(d and it["top"] == CASE_DIAG.get(it["case"], "?"))
                c[1] += int(d)
                c[2] += 1
        res["realev_cases"] = {k: {"detected_right": round(v[0] / v[2], 4), "detected_any": round(v[1] / v[2], 4), "rows": v[2]}
                               for k, v in sorted(cases.items())}
    return res


def fit(fit_sets: dict[str, list[dict]]) -> tuple[float, dict]:
    curve = {}
    best = 1.0
    for r in reversed(GRID):
        sim_k = sim_n = ben_k = ben_n = 0
        for name, items in fit_sets.items():
            t = table(items, r, name.startswith("sim"))
            if name.startswith("sim"):  # gold-`expected` rows (see module doc: passive-best rows are mostly real anomalies)
                sim_k += t["false_on_expected"][0]
                sim_n += t["false_on_expected"][1]
            if "false_on_real_benign" in t:
                ben_k += t["false_on_real_benign"][0]
                ben_n += t["false_on_real_benign"][1]
        ub_s, ub_b = wilson_upper(sim_k, sim_n), wilson_upper(ben_k, ben_n)
        curve[r] = {"sim_expected": [sim_k, sim_n, round(ub_s, 5)], "real_benign": [ben_k, ben_n, round(ub_b, 5)]}
        if ub_s > DEV_MARGIN * LIM["sim_expected"] or ub_b > DEV_MARGIN * LIM["real_benign"]:
            break
        best = r
    return best, curve


def write_meta(export: Path, r: float) -> None:
    meta_p = export / "meta.json"
    meta = json.loads(meta_p.read_text())
    meta.setdefault("gate", {})["report"] = r
    meta.setdefault("gate_fit", {})["report_rule"] = ("lowest top-diagnosis probability with false detections ≤ 1% on REAL "
                                                       "clean+benign-salient and ≤ 2% on SIM passive-best dev rows (95% UB)")
    meta_p.write_text(json.dumps(meta, indent=2) + "\n")
    card_p = export / "model.json"
    if card_p.exists():
        card = json.loads(card_p.read_text())
        b = meta_p.read_bytes()
        for v in card.get("files", {}).values():
            if v.get("file") == "meta.json":
                v["bytes"], v["sha256"] = len(b), hashlib.sha256(b).hexdigest()
        card_p.write_text(json.dumps(card, indent=1) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cal", type=Path, required=True)
    ap.add_argument("--fit", action="append", required=True)
    ap.add_argument("--test", action="append", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--write-meta", type=Path, default=None)
    ap.add_argument("--limits", default=None, help='JSON {"real_benign": .., "sim_expected": ..}')
    ap.add_argument("--margin", type=float, default=None)
    a = ap.parse_args()
    global LIM, DEV_MARGIN
    if a.limits:
        LIM = json.loads(a.limits)
    if a.margin is not None:
        DEV_MARGIN = a.margin
    cal = json.loads(a.cal.read_text())
    fit_sets = {f"{n}#{i}": it for i, (n, it) in enumerate(load(s, cal) for s in a.fit)}  # names may repeat
    test_sets = {}
    for n, it in (load(s, cal) for s in a.test):
        test_sets[n if n not in test_sets else f"{n}#{len(test_sets)}"] = it
    r, curve = fit(fit_sets)
    res = {"report": r, "limits": LIM, "fit_curve": curve, "test": {}}
    for name, items in test_sets.items():
        res["test"][name] = {str(t): table(items, t, name.startswith("sim")) for t in GRID}
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(res, indent=1))
    if a.write_meta:
        write_meta(a.write_meta, r)
    print(f"gate.report = {r}")
    for t in sorted({0.6, r} & set(GRID)):
        print(f"\n== report threshold {t}")
        for name, sets in res["test"].items():
            x = sets[str(t)]
            fd = []
            for k in ("false_on_real_benign", "false_on_sim_passive", "false_on_expected"):
                if k in x:
                    fd.append(f"{k} {100 * x[k][0] / max(x[k][1], 1):.2f}% ({x[k][0]}/{x[k][1]})")
            print(f"  {name}: detected {100 * x['detected']:.2f}%, precision {x['precision_all']}; " + "; ".join(fd))
            print("    " + ", ".join(f"{c} P {v['precision']} R {v['recall']} (n {v['gold_rows']})" for c, v in x["per_class"].items()))
            if "realev_cases" in x:
                print("    " + ", ".join(f"{c}: right {v['detected_right']} any {v['detected_any']}" for c, v in x["realev_cases"].items()))


if __name__ == "__main__":
    main()
