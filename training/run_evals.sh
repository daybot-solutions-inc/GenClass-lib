#!/bin/bash
# Run on c01 (detached by the caller): every eval job for the given models in parallel, 10 threads each.
#   bash training/run_evals.sh TAG model1 model2 ...      (models under ~/gcl-train/models/)
# Writes out/eval/<model>-<set>.json and out/cal/<model>.json (per-kind temperatures fitted on rt1 dev).
set -u
cd ~/gcl-train
PY=$HOME/jev/.venv/bin/python
export PYTHONPATH=$HOME/jev:$HOME/gcl-train/training HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=10
TAG="$1"; shift
mkdir -p out/eval out/cal logs
pids=()
for M in "$@"; do
  ( $PY training/eval_runtime.py --ckpt models/$M --data data/rt1 --split test --fit-split dev --threads 10 --batch 32 --records-dir out/records \
      --out out/eval/$M-rt1.json --write-calibration out/cal/$M.json > logs/eval-$M-rt1.log 2>&1;
    $PY training/eval_runtime.py --ckpt models/$M --data data/simsample --split test --threads 10 --batch 32 --records-dir out/records \
      --calibration out/cal/$M.json --out out/eval/$M-sim.json > logs/eval-$M-sim.log 2>&1 ) &
  pids+=($!)
  $PY training/eval_runtime.py --ckpt models/$M --data data/cur1 --split test --fit-split dev --threads 10 --batch 32 --records-dir out/records \
      --out out/eval/$M-cur1.json > logs/eval-$M-cur1.log 2>&1 &
  pids+=($!)
  $PY training/eval_runtime.py --ckpt models/$M --data data/cur2 --split test --threads 10 --batch 32 --records-dir out/records \
      --out out/eval/$M-cur2.json > logs/eval-$M-cur2.log 2>&1 &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
touch out/eval/.done-$TAG
