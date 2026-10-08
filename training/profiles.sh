#!/bin/bash
# Aggressiveness profiles for model M (node-side; needs the q8 records from dist_post3.sh + the cert set):
#   bash training/profiles.sh r17-v2dT gain [--write]
# Fits cautious / balanced / eager gates + gate.report on q8 dev records (sim2g, shipping-gate on-policy a/b dev, REAL
# eval rows outside REAL's test split, REAL dev, REAL certification set as `realp`), cluster-robust Wilson bounds at the
# limit (margin 1.0), tier-default fallback (error: default if its point estimates hold, else never); verifies on q8
# test records. Writes out/gates/M-q8-<profile>{,-report}.json and out/profiles-M.json (summary); with --write puts
# `gate` = balanced + `gate.profiles` = {cautious, balanced, eager} into out/export-M/meta.json and refreshes model.json.
set -u
cd ~/gcl-train
M="$1"; KIND="$2"; MQ="$M-q8"; R=out/records; E=out/export-$M; C=$E/calibration.json
PY=$HOME/jev/.venv/bin/python
export PYTHONPATH=$HOME/jev:$HOME/gcl-train/training
FIT="--fit sim=data/sim2g/dev.jsonl:$R/${MQ}__sim2g__dev.jsonl --fit sim=data/onpbd/dev.jsonl:$R/${MQ}__onpbd__dev.jsonl:::gate=shipping --fit sim=data/onpad/dev.jsonl:$R/${MQ}__onpad__dev.jsonl:::gate=shipping --fit real=data/realev/test.jsonl:$R/${MQ}__realev__test.jsonl:notest:not=inconsistency --fit real=data/realev3/test.jsonl:$R/${MQ}__realev3__test.jsonl:notest:only=inconsistency --fit realc=data/real2e/dev.jsonl:$R/${MQ}__real2e__dev.jsonl --fit realp=data/certd/dev.jsonl:$R/${MQ}__certd__dev.jsonl"
TEST="--test sim=data/onpbe/test.jsonl:$R/${MQ}__onpbe__test.jsonl:::gate=shipping --test sim=data/sim2e/test.jsonl:$R/${MQ}__sim2e__test.jsonl --test sim=data/sim2f/test.jsonl:$R/${MQ}__sim2f__test.jsonl --test sim=data/sim3e/test.jsonl:$R/${MQ}__sim3e__test.jsonl --test sim=data/onpae/test.jsonl:$R/${MQ}__onpae__test.jsonl:::gate=shipping --test real=data/realev/test.jsonl:$R/${MQ}__realev__test.jsonl:test:not=inconsistency --test real=data/realev3/test.jsonl:$R/${MQ}__realev3__test.jsonl:test:only=inconsistency --test realc=data/real2e/test.jsonl:$R/${MQ}__real2e__test.jsonl"
RFIT="--fit sim=data/sim2g/dev.jsonl:$R/${MQ}__sim2g__dev.jsonl --fit simb=data/onpbd/dev.jsonl:$R/${MQ}__onpbd__dev.jsonl:::gate=shipping --fit sima=data/onpad/dev.jsonl:$R/${MQ}__onpad__dev.jsonl:::gate=shipping --fit real=data/realev/test.jsonl:$R/${MQ}__realev__test.jsonl:notest --fit real=data/realev3/test.jsonl:$R/${MQ}__realev3__test.jsonl:notest --fit realp=data/certd/dev.jsonl:$R/${MQ}__certd__dev.jsonl"
RTEST="--test simonpb=data/onpbe/test.jsonl:$R/${MQ}__onpbe__test.jsonl:::gate=shipping --test sim2e=data/sim2e/test.jsonl:$R/${MQ}__sim2e__test.jsonl --test sim2f=data/sim2f/test.jsonl:$R/${MQ}__sim2f__test.jsonl --test sim3e=data/sim3e/test.jsonl:$R/${MQ}__sim3e__test.jsonl --test real2e=data/real2e/test.jsonl:$R/${MQ}__real2e__test.jsonl --test realev=data/realev/test.jsonl:$R/${MQ}__realev__test.jsonl:test --test realev3=data/realev3/test.jsonl:$R/${MQ}__realev3__test.jsonl:test"
declare -A GL=( [cautious]='{"guard": {"fir": 0.001, "harm": 0.002}, "heal": {"fir": 0.005, "harm": 0.01}}'
                [balanced]='{"guard": {"fir": 0.003, "harm": 0.003}, "heal": {"fir": 0.01, "harm": 0.01}}'
                [eager]='{"guard": {"fir": 0.01, "harm": 0.01}, "heal": {"fir": 0.03, "harm": 0.03}}' )
declare -A RL=( [cautious]='{"real_benign": 0.01, "sim_expected": 0.02}'
                [balanced]='{"real_benign": 0.02, "sim_expected": 0.03}'
                [eager]='{"real_benign": 0.05, "sim_expected": 0.06}' )
pids=()
for P in cautious balanced eager; do
  ( $PY training/fit_gates.py --kind $KIND --tau-gain 1.0 --cal $C $FIT $TEST --limits "${GL[$P]}" --margin 1.0 --fallback default \
      --boot 200 --out out/gates/$MQ-$P.json > logs/gates-$MQ-$P.log 2>&1
    $PY training/fit_report.py --cal $C $RFIT $RTEST --limits "${RL[$P]}" --margin 1.0 --out out/gates/$MQ-$P-report.json \
      > logs/report-$MQ-$P.log 2>&1 ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
$PY - "$M" "$KIND" "${3:-}" <<'PY'
import json, sys, hashlib
from pathlib import Path
M, KIND = sys.argv[1], sys.argv[2]
write = "--write" in sys.argv[3:]
MQ = M + "-q8"
o = Path("out")
prof, summ = {}, {}
for P in ("cautious", "balanced", "eager"):
    g = json.loads((o / "gates" / f"{MQ}-{P}.json").read_text())
    r = json.loads((o / "gates" / f"{MQ}-{P}-report.json").read_text())
    gate = ({"kind": "gain", "tauGain": 1.0} if KIND == "gain" else {}) | g["gate"] | {"report": r["report"]}
    prof[P] = gate
    s = {"limits": {"action": g["limits"], "report": r["limits"]}}
    for mode in ("guard", "heal"):
        a = g["test"][mode]["ALL"]
        s[mode] = {k: (round(100 * a[k], 3) if a.get(k) is not None else None) for k in
                   ("fired_sim", "fir_sim", "fir_real", "harm_sim", "harm_real", "recall_clear", "recall_real_actions", "gain_captured")}
        s[mode]["ci95"] = {k: [round(100 * x, 3) for x in v] for k, v in a.get("ci95", {}).items()
                           if k in ("fir_sim", "harm_sim", "recall_clear", "gain_captured")}
        s[mode]["by_trigger"] = {t: {"fir_sim": (round(100 * v["fir_sim"], 2) if v.get("fir_sim") is not None else None),
                                     "gain": (round(100 * v["gain_captured"], 1) if v.get("gain_captured") is not None else None)}
                                 for t, v in g["test"][mode].items() if not t.startswith("ALL")}
    rr = str(r["report"])
    det = {}
    for n, sets in r["test"].items():
        if rr not in sets:
            continue
        x = sets[rr]
        det[n] = {"detected": x["detected"], "precision": x["precision_all"]}
        for k in ("false_on_real_benign", "false_on_expected"):
            if k in x:
                det[n][k] = round(100 * x[k][0] / max(x[k][1], 1), 2)
        if "realev_cases" in x:
            det[n]["right"] = x["realev_cases"]
        det[n]["per_class_recall"] = {c: v["recall"] for c, v in x["per_class"].items() if v.get("gold_rows", 0) >= 50}
    s["report"] = {"r": r["report"], "test": det}
    s["notes"] = g.get("notes")
    summ[P] = s
(o / f"profiles-{M}.json").write_text(json.dumps({"model": M, "profiles": prof, "summary": summ}, indent=1))
if write:
    E = o / f"export-{M}"
    meta = json.loads((E / "meta.json").read_text())
    meta["gate"] = dict(prof["balanced"]) | {"profiles": prof}
    meta["gate_fit"] = {
        "source": "fitted on outputs of the shipped q8 ONNX file; dev = SIM sim2g + shipping-gate on-policy a/b dev + REAL eval rows outside REAL's test split + REAL dev + REAL certification set (v23-cert); verified on held-out test",
        "rule": "per tier x trigger, lowest threshold whose cluster-robust (trajectory) 95% Wilson upper bounds meet each FIR/harm limit (no extra margin); per-trigger only where the trigger's dev evidence certifies, else the tier default; error: default if its point estimates hold, else never",
        "limits": {P: summ[P]["limits"] for P in summ}}
    (E / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    card = json.loads((E / "model.json").read_text())
    for v in list(card["variants"].values()) + list(card["files"].values()):
        b = (E / v["file"]).read_bytes()
        v["bytes"], v["sha256"] = len(b), hashlib.sha256(b).hexdigest()
    (E / "model.json").write_text(json.dumps(card, indent=1) + "\n")
print(json.dumps({P: {"gate": prof[P], "guard": {k: summ[P]["guard"][k] for k in ("fir_sim", "harm_sim", "recall_clear", "recall_real_actions", "gain_captured")},
                      "heal": {k: summ[P]["heal"][k] for k in ("fir_sim", "harm_sim", "recall_clear", "recall_real_actions", "gain_captured")},
                      "report": summ[P]["report"]["r"]} for P in summ}, indent=1))
PY
touch out/.profiles-done-$M
