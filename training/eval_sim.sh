#!/bin/bash
# Run on c01: SIM evaluation of one or more checkpoints with parallel logit collection.
#   bash training/eval_sim.sh NAME model1 [model2 ...]      (data/NAME/{dev,test}.jsonl and shards data/NAME_t*/, data/NAME_d*/)
# HEADER_CAL=1 also writes per-header (standing-question) temperatures into the calibration (used by the runtime).
# Collects raw logits per shard (6 threads each), merges them into out/records/<model>__NAME__{test,dev}.jsonl, then runs
# eval_runtime.py once per model on the merged records: temperatures fitted on dev, metrics on test, calibration written
# to out/cal/<model>-NAME.json.
set -u
cd ~/gcl-train
PY=$HOME/jev/.venv/bin/python
T=${EVAL_THREADS:-6}
export PYTHONPATH=$HOME/jev:$HOME/gcl-train/training HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=$T
NAME="$1"; shift
mkdir -p out/eval out/cal out/records logs
pids=()
for M in "$@"; do
  for D in data/${NAME}_t* data/${NAME}_d*; do
    S=$( [ -f "$D/test.jsonl" ] && echo test || echo dev )
    $PY training/eval_runtime.py --ckpt models/$M --data "$D" --split $S --threads $T --batch 32 \
        --records-dir out/records --out out/eval/.shard-$M-$(basename "$D").json > logs/eval-$M-$(basename "$D").log 2>&1 &
    pids+=($!)
  done
done
for p in "${pids[@]}"; do wait "$p"; done
for M in "$@"; do
  cat out/records/${M}__${NAME}_t*__test.jsonl > out/records/${M}__${NAME}__test.jsonl
  cat out/records/${M}__${NAME}_d*__dev.jsonl > out/records/${M}__${NAME}__dev.jsonl
  $PY training/eval_runtime.py --ckpt models/$M --data data/$NAME --split test --fit-split dev --records-dir out/records \
      --out out/eval/$M-$NAME.json --write-calibration out/cal/$M-$NAME.json ${HEADER_CAL:+--header-calibration} \
      > logs/eval-$M-$NAME.log 2>&1
done
touch out/eval/.done-sim-$NAME
