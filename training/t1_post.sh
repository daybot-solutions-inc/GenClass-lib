#!/bin/bash
# Run detached on a T1 run's rank-0 node: wait for the final servable, collect SIM test/dev logits (eval_sim.sh, which also
# writes the standard report + calibration), then the expected-gain evaluation (eval_gain.py) with the run's label τ.
#   bash training/t1_post.sh r17-t1g10 1.0
set -u
cd ~/gcl-train
M="$1"; TAU="$2"
PY=$HOME/jev/.venv/bin/python
export PYTHONPATH=$HOME/jev:$HOME/gcl-train/training HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false
until python3 -c "import json,sys; sys.exit(0 if json.load(open('models/$M/meta.json')).get('final') else 1)" 2>/dev/null; do sleep 30; done
sleep 10
EVAL_THREADS=12 bash training/eval_sim.sh simAe "$M" > logs/t1-eval-$M.log 2>&1
$PY training/eval_gain.py --rows data/simAe/test.jsonl \
  --model "$M=out/records/${M}__simAe__test.jsonl:out/cal/$M-simAe.json:$TAU" --out out/eval/gain-$M.json > logs/t1-gain-$M.log 2>&1
touch out/.t1-done-$M
