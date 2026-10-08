#!/bin/bash
# Action/diagnosis logits on the 104k-row SIM dev sample (data/sim2g_d0..15) for gate fitting (fit_gates.py).
#   bash training/collect_gate_set.sh r17-v2a      → out/records/<M>__sim2g__dev.jsonl
set -u
cd ~/gcl-train
M="$1"; T=${GATE_THREADS:-5}
PY=$HOME/jev/.venv/bin/python
export PYTHONPATH=$HOME/jev:$HOME/gcl-train/training HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=$T
mkdir -p out/records logs
pids=()
for D in data/sim2g_d*; do
  $PY training/collect_gain.py --ckpt models/$M --in $D/dev.jsonl --threads $T \
    --out out/records/${M}__$(basename $D)__dev.gain.jsonl > logs/gate-collect-$M-$(basename $D).log 2>&1 &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
cat out/records/${M}__sim2g_d*__dev.gain.jsonl > out/records/${M}__sim2g__dev.jsonl
touch out/.gate-collect-done-$M
