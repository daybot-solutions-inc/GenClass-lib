#!/bin/bash
# T1 gain-head variant: run detached on the run's rank-0 node. Waits for the final servable, runs the standard SIM
# evaluation (report + calibration), collects action/diagnosis logits + gain-head predictions on the simAe test shards
# (collect_gain.py, in parallel), then eval_gain.py (gate policies + head>m policies).
#   bash training/t1h_post.sh r17-t1h
set -u
cd ~/gcl-train
M="$1"
PY=$HOME/jev/.venv/bin/python
export PYTHONPATH=$HOME/jev:$HOME/gcl-train/training HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false
until python3 -c "import json,sys; sys.exit(0 if json.load(open('models/$M/meta.json')).get('final') else 1)" 2>/dev/null; do sleep 30; done
sleep 10
EVAL_THREADS=12 bash training/eval_sim.sh simAe "$M" > logs/t1-eval-$M.log 2>&1
pids=()
for D in data/simAe_t*; do
  OMP_NUM_THREADS=12 $PY training/collect_gain.py --ckpt models/$M --in $D/test.jsonl --threads 12 \
    --out out/records/${M}__$(basename $D)__test.gain.jsonl > logs/t1-collect-$M-$(basename $D).log 2>&1 &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
cat out/records/${M}__simAe_t*__test.gain.jsonl > out/records/${M}__simAe__test.gain.jsonl
$PY training/eval_gain.py --rows data/simAe/test.jsonl \
  --model "$M=out/records/${M}__simAe__test.gain.jsonl:out/cal/$M-simAe.json" --out out/eval/gain-$M.json > logs/t1-gain-$M.log 2>&1
touch out/.t1-done-$M
