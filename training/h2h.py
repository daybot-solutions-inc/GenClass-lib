"""One model's head-to-head summary from its q8-based post-processing outputs (dist_post3.sh + report_fix.sh).
    python training/h2h.py r17-v2d            → JSON on stdout"""
import json
import sys
from pathlib import Path

M = sys.argv[1]
MQ = f"{M}-q8"
o = Path("out")
res: dict = {"model": M}
meta = json.loads((o / f"export-{M}" / "meta.json").read_text())
res["gate"] = meta.get("gate")
par = json.loads((o / f"export-{M}" / "parity.json").read_text())
res["parity"] = {k: {"argmax": f"{par[k]['argmax_agree']}/{par[k]['argmax_total']}", "gate08": par[k].get("gate08_rate"),
                     "gate09": par[k].get("gate09_rate"), "max_dp": round(par[k]["max_abs_prob"], 4), "mb": par[k]["file_mb"]}
                 for k in ("q8", "fp16")}
acc = {}
for s in ("sim2e", "sim2f", "sim3e", "real2e", "onpae", "real3e"):
    p = o / "eval" / f"{MQ}-{s}.json"
    if p.exists():
        r = json.loads(p.read_text())
        d = r.get("decisions_kind") or {}
        q = (r.get("questions_kind") or {})
        acc[s] = {k: (round(100 * v, 1) if isinstance(v, float) else v) for k, v in
                  {"action": (q.get("action") or {}).get("acc"), "diagnosis": (q.get("diagnosis") or {}).get("acc")}.items()}
res["acc"] = acc
g = json.loads((o / "gates" / f"{MQ}.json").read_text())
pick = ("fired_sim", "fir_sim", "fir_real", "harm_sim", "harm_real", "recall_clear", "recall_real_actions", "gain_captured")
res["gates_test"] = {}
for mode in ("guard", "heal"):
    t = g["test"][mode]
    row = {k: (round(100 * t["ALL"][k], 3) if t["ALL"].get(k) is not None else None) for k in pick}
    row["ci95"] = {k: [round(100 * x, 3) for x in v] for k, v in t["ALL"].get("ci95", {}).items() if k in ("fir_sim", "gain_captured", "recall_clear")}
    row["by_trigger_fir_sim"] = {tr: (round(100 * v["fir_sim"], 2) if v.get("fir_sim") is not None else None) for tr, v in t.items()
                                 if not tr.startswith("ALL")}
    row["by_trigger_gain"] = {tr: (round(100 * v["gain_captured"], 1) if v.get("gain_captured") is not None else None)
                              for tr, v in t.items() if not tr.startswith("ALL")}
    res["gates_test"][mode] = row
rp = json.loads((o / "gates" / f"{MQ}-report.json").read_text())
r = str(rp["report"])
det = {}
for n, s in rp["test"].items():
    if r not in s:
        continue
    x = s[r]
    det[n] = {"detected": x["detected"], "precision": x["precision_all"]}
    for k in ("false_on_real_benign", "false_on_expected"):
        if k in x:
            det[n][k] = round(100 * x[k][0] / max(x[k][1], 1), 2)
    if "realev_cases" in x:
        det[n]["right"] = {c: v["detected_right"] for c, v in x["realev_cases"].items()}
res["report"] = {"r": rp["report"], "test": det}
for name in ("real", "real3"):
    p = o / "eval" / f"{name}-{MQ}.json"
    if p.exists():
        rr = json.loads(p.read_text())[MQ]
        res[f"{name}_fixed_heal"] = {c: {"argmax": v["argmax_acc"], "fired@0.8": v.get("fired@0.8"), "recall@0.8": v.get("recall@0.8")}
                                     for c, v in rr["heal"].items() if "[" not in c}
print(json.dumps(res, indent=1))
