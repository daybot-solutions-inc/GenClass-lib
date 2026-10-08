"""Expected-gain evaluation of gate policies (T1, sim/SEPARABILITY.md §5/§7) from cached logits.

    python training/eval_gain.py --rows data/simAe/test.jsonl \
        --model r17-final1=out/records/r17-final1__simAe__test.jsonl:out/cal/r17-final1-simAe.json \
        --model r17-t1g10=out/records/...:out/cal/...:1.0 [--out out/eval/gain.json]

Per SIM decision row (with `meta.cost_futures`), using SIM's definitions (premium guard 0.25 / heal 0.5):
  gain(a) = mean_f c(passive) − mean_f c(a) − premium;  classes clear / benign / mild exactly as separability.py;
  oracle = Σ max(0, max_a gain(a)) over the mode's permitted actions.
Policies (guard mode = guard-tier actions only; heal mode = guard + heal):
  gate@t        CONTRACT §8: candidate = argmax p over permitted non-passive A, fire iff Σ_A p ≥ t and top diagnosis
                ≠ expected (t = 0.9 guard / 0.8 heal are the runtime's; others for the curve)
  gate@t-nodiag same without the diagnosis condition (`policy.requireDiagnosis: false`)
  gain>m        for T1 models (label τ given after the calibration path): ĝ(a) = τ·(z_a − z_passive) on the RAW logits
                (= τ·ln(p(a)/p(passive)) at temperature 1); fire the argmax ĝ over A if ĝ > m
  head>m        for gain-head checkpoints (records with `gain_pred`): fire the argmax predicted gain over A if > m
Metrics: fired share, recall on clear rows (fired with their best action), benign rows fired, harmful share (fired
true gain < −1, over all rows), gain captured (Σ true gain of fired actions ÷ oracle), net gain per row, and FIR against
the hard label (passive-best rows fired) for continuity with EVAL.md.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np

PREM = {"passive": 0.0, "guard": 0.25, "heal": 0.5}
PERMIT = {"guard": ("guard",), "heal": ("guard", "heal")}


def softmax(z, tau):
    z = np.asarray(z, np.float64) / tau
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


def load_recs(path: Path) -> dict[str, dict]:
    by = defaultdict(dict)
    with path.open() as f:
        for line in f:
            r = json.loads(line)
            if r["qid"] in ("action", "diagnosis"):
                by[r["id"]][r["qid"]] = r
    return by


def classify(m: dict, permitted: list[str], passive: str):
    cf = m.get("cost_futures") or {k: [v] for k, v in (m.get("costs") or {}).items()}
    tiers = m.get("tiers") or {}
    if passive not in cf:
        return None
    K = min(len(v) for v in cf.values())
    gaps, bests = [], []
    for f in range(K):
        cand = [(cf[a][f] + PREM.get(tiers.get(a, "heal"), 0.5), a) for a in permitted if a != passive and a in cf]
        if not cand:
            return None
        c, a = min(cand)
        gaps.append(cf[passive][f] - c)
        bests.append(a)
    g = sum(gaps) / K
    if g >= 2 and min(gaps) > 0 and len(set(bests)) == 1:
        return "clear", bests[0]
    if max(gaps) <= 0:
        return "benign", None
    return "mild", None


def evaluate(rows: dict, recs: dict, cal: dict, t1_tau: float | None) -> dict:
    tau_c = float(cal.get("choice", 1.0))
    out = {}
    for mode in ("guard", "heal"):
        policies = {f"gate@{t}": [] for t in (0.5, 0.6, 0.7, 0.8, 0.9, 0.95)}
        policies.update({f"gate@{t}-nodiag": [] for t in (0.5, 0.7, 0.8, 0.9, 0.95)})
        if t1_tau:
            policies.update({f"gain>{m}": [] for m in (0, 0.5, 1, 2, 3, 4)})
        has_head = any("gain_pred" in q.get("action", {}) for q in list(recs.values())[:50])
        if has_head:
            policies.update({f"head>{m}": [] for m in (0, 0.5, 1, 2, 3, 4)})
            policies.update({f"head>{m}+diag": [] for m in (0.5, 1, 2)})
        n = n_clear = n_benign = 0
        oracle = 0.0
        n_passive_label = 0
        stats = {k: {"fired": 0, "clear_hit": 0, "benign_fired": 0, "harmful": 0, "gain": 0.0, "fir_label": 0}
                 for k in policies}
        for rid, q in recs.items():
            if "action" not in q or "diagnosis" not in q or rid not in rows:
                continue
            m = rows[rid]
            tiers = m.get("tiers") or {}
            passive = m.get("passive") or next((a for a, t in tiers.items() if t == "passive"), None)
            ra, rd = q["action"], q["diagnosis"]
            names = list(ra["labels"])
            if passive not in names:
                continue
            permitted = [a for a in names if a == passive or tiers.get(a, "heal") in PERMIT[mode]]
            cls = classify(m, permitted, passive)
            if cls is None:
                continue
            cf = m.get("cost_futures") or {k: [v] for k, v in (m.get("costs") or {}).items()}
            cp = sum(cf[passive]) / len(cf[passive])
            gains = {a: cp - sum(cf[a]) / len(cf[a]) - PREM.get(tiers.get(a, "heal"), 0.5)
                     for a in permitted if a != passive and a in cf}
            if not gains:
                continue
            n += 1
            oracle += max(0.0, max(gains.values()))
            n_clear += cls[0] == "clear"
            n_benign += cls[0] == "benign"
            p = softmax(ra["logits"], tau_c)
            pd = softmax(rd["logits"], tau_c)
            top_d = list(rd["labels"])[int(pd.argmax())]
            idx = {a: i for i, a in enumerate(names)}
            A = [a for a in gains if a in idx]
            mass = float(sum(p[idx[a]] for a in A))
            cand = max(A, key=lambda a: p[idx[a]])
            gold = names[int(np.asarray(ra["target"]).argmax())]
            passive_label = gold == passive
            n_passive_label += passive_label
            fires = {}
            for t in (0.5, 0.6, 0.7, 0.8, 0.9, 0.95):
                fires[f"gate@{t}"] = cand if (mass >= t and top_d != "expected") else None
                if f"gate@{t}-nodiag" in policies:
                    fires[f"gate@{t}-nodiag"] = cand if mass >= t else None
            if t1_tau:
                z = ra["logits"]  # raw logits: the T1 targets make z_a − z_passive ≈ gain(a)/τ (dev calibration is fitted to SIM labels)
                gh = {a: t1_tau * (float(z[idx[a]]) - float(z[idx[passive]])) for a in A}
                best = max(gh, key=gh.get)
                for mg in (0, 0.5, 1, 2, 3, 4):
                    fires[f"gain>{mg}"] = best if gh[best] > mg else None
            if has_head and "gain_pred" in ra:
                gp = {a: float(ra["gain_pred"][idx[a]]) for a in A}
                bh = max(gp, key=gp.get)
                for mg in (0, 0.5, 1, 2, 3, 4):
                    fires[f"head>{mg}"] = bh if gp[bh] > mg else None
                for mg in (0.5, 1, 2):
                    fires[f"head>{mg}+diag"] = bh if (gp[bh] > mg and top_d != "expected") else None
            for k, a in fires.items():
                if a is None:
                    continue
                s = stats[k]
                s["fired"] += 1
                s["clear_hit"] += int(cls[0] == "clear" and cls[1] == a)
                s["benign_fired"] += int(cls[0] == "benign")
                s["harmful"] += int(gains[a] < -1)
                s["gain"] += gains[a]
                s["fir_label"] += int(passive_label)
        res = {"rows": n, "clear": n_clear, "benign": n_benign, "oracle_gain_per_row": round(oracle / max(n, 1), 4),
               "policies": {}}
        for k, s in stats.items():
            res["policies"][k] = {
                "fired_share": round(s["fired"] / max(n, 1), 4),
                "recall_clear": round(s["clear_hit"] / max(n_clear, 1), 4),
                "benign_fired": round(s["benign_fired"] / max(n_benign, 1), 4),
                "harmful_share": round(s["harmful"] / max(n, 1), 5),
                "gain_captured": round(s["gain"] / max(oracle, 1e-9), 4),
                "net_gain_per_row": round(s["gain"] / max(n, 1), 4),
                "fir_label": round(s["fir_label"] / max(n_passive_label, 1), 5),
            }
        out[mode] = res
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=Path, required=True)
    ap.add_argument("--model", action="append", required=True, help="name=records.jsonl:calibration.json[:t1_tau]")
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args()
    rows = {}
    with a.rows.open() as f:
        for line in f:
            r = json.loads(line)
            rows[r["id"]] = r.get("meta") or {}
    report = {}
    for spec in a.model:
        name, rest = spec.split("=", 1)
        parts = rest.split(":")
        recs = load_recs(Path(parts[0]))
        cal = json.loads(Path(parts[1]).read_text()) if len(parts) > 1 and parts[1] else {}
        t1 = float(parts[2]) if len(parts) > 2 else None
        report[name] = evaluate(rows, recs, cal, t1)
    txt = json.dumps(report, indent=1)
    if a.out:
        a.out.write_text(txt)
    for name, r in report.items():
        for mode in ("guard", "heal"):
            x = r[mode]
            print(f"\n{name} [{mode}] rows {x['rows']} clear {x['clear']} benign {x['benign']} oracle/row {x['oracle_gain_per_row']}")
            print(f"  {'policy':18s} fired  recall_clear benign_fired harmful  gain_capt net/row  FIR(label)")
            for k, v in x["policies"].items():
                print(f"  {k:18s} {v['fired_share']:.4f} {v['recall_clear']:.4f}       {v['benign_fired']:.4f}       "
                      f"{v['harmful_share']:.5f}  {v['gain_captured']:+.4f}  {v['net_gain_per_row']:+.4f}  {v['fir_label']:.5f}")


if __name__ == "__main__":
    main()
