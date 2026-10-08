#!/bin/bash
# REAL evaluations for a model on its node (after eval_sim.sh sim2e wrote out/cal/<M>-sim2e.json):
#   real2e  random REAL held-out sample (temperatures fitted on REAL dev, like the SIM sets)
#   realev  REAL's unambiguous-case eval set, scored with the SIM-fitted calibration (what ships) → eval_real.py
#   bash training/eval_real_sets.sh r17-v2a
set -u
cd ~/gcl-train
M="$1"
PY=$HOME/jev/.venv/bin/python
export PYTHONPATH=$HOME/jev:$HOME/gcl-train/training HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false
[ -d data/real2e ] && EVAL_THREADS=10 bash training/eval_sim.sh real2e "$M"
if [ -f data/realev/test.jsonl ]; then
  pids=()
  for D in data/realev_t*; do
    OMP_NUM_THREADS=16 $PY training/eval_runtime.py --ckpt models/$M --data $D --split test --threads 16 --batch 32 \
      --records-dir out/records --calibration out/cal/$M-sim2e.json --out out/eval/.shard-$M-$(basename $D).json \
      > logs/eval-$M-$(basename $D).log 2>&1 &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p"; done
  cat out/records/${M}__realev_t*__test.jsonl > out/records/${M}__realev__test.jsonl
  $PY training/eval_runtime.py --ckpt models/$M --data data/realev --split test --records-dir out/records \
    --calibration out/cal/$M-sim2e.json --out out/eval/$M-realev.json > logs/eval-$M-realev.log 2>&1
  $PY training/eval_real.py --rows data/realev/test.jsonl --model "$M=out/records/${M}__realev__test.jsonl:out/cal/$M-sim2e.json" \
    --out out/eval/real-$M.json
fi
touch out/.real-done-$M
