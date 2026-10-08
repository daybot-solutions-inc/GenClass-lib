#!/bin/bash
# Fit (dev) + verify (test) the data-derived gates for model M on its node and, with --write, put them into
# out/export-M/meta.json (+ model.json hash). Needs out/records for sim2g dev (collect_gate_set.sh), sim2e/sim2f test,
# realev and real2e (eval_sim.sh / eval_real_sets.sh).      bash training/gates_for.sh r17-v2a [--write]
set -u
cd ~/gcl-train
M="$1"; R=out/records
W=(); [ "${2:-}" = "--write" ] && W=(--write-meta out/export-$M)
mkdir -p out/gates
$HOME/jev/.venv/bin/python training/fit_gates.py --cal out/cal/$M-sim2e.json \
  --fit sim=data/sim2g/dev.jsonl:$R/${M}__sim2g__dev.jsonl \
  --fit real=data/realev/test.jsonl:$R/${M}__realev__test.jsonl:notest \
  --fit realc=data/real2e/dev.jsonl:$R/${M}__real2e__dev.jsonl \
  --test sim=data/sim2e/test.jsonl:$R/${M}__sim2e__test.jsonl \
  --test sim=data/sim2f/test.jsonl:$R/${M}__sim2f__test.jsonl \
  --test real=data/realev/test.jsonl:$R/${M}__realev__test.jsonl:test \
  --test realc=data/real2e/test.jsonl:$R/${M}__real2e__test.jsonl \
  --out out/gates/$M.json "${W[@]}"
# observe-mode detections: gate.report (fit on dev, verify on test) → same meta.json
$HOME/jev/.venv/bin/python training/fit_report.py --cal out/cal/$M-sim2e.json \
  --fit sim=data/sim2g/dev.jsonl:$R/${M}__sim2g__dev.jsonl \
  --fit real=data/realev/test.jsonl:$R/${M}__realev__test.jsonl:notest \
  --test sim2e=data/sim2e/test.jsonl:$R/${M}__sim2e__test.jsonl \
  --test sim2f=data/sim2f/test.jsonl:$R/${M}__sim2f__test.jsonl \
  --test real2e=data/real2e/test.jsonl:$R/${M}__real2e__test.jsonl \
  --test realev=data/realev/test.jsonl:$R/${M}__realev__test.jsonl:test \
  --out out/gates/$M-report.json "${W[@]}"
