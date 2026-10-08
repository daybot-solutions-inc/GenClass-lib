#!/bin/bash
# Run detached on a v2 model's rank-0 node: waits for the final servable, then SIM eval on the held-out test sample
# (sim2e) and the held-out-features sample (sim2f) (temperatures fitted on dev), expected-gain metrics (eval_gain.py),
# the export with the sim2e calibration, and serves the export tar on :8801.
#   bash training/v2_post.sh r17-v2a genclass-runtime-r17 2.0.0-rc1 [T1_TAU]
# Also (when present): REAL held-out sample real2e (eval_sim.sh) and REAL's unambiguous-case eval set realev
# (eval_runtime.py with the sim2e calibration + eval_real.py).
set -u
cd ~/gcl-train
M="$1"; NAME="$2"; VER="$3"; T1TAU="${4:-}"
PY=$HOME/jev/.venv/bin/python
export PYTHONPATH=$HOME/jev:$HOME/gcl-train/training HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false
mkdir -p logs out/eval out/cal
until python3 -c "import json,sys; sys.exit(0 if json.load(open('models/$M/meta.json')).get('final') else 1)" 2>/dev/null; do sleep 30; done
sleep 10
EVAL_THREADS=10 bash training/eval_sim.sh sim2e "$M" > logs/v2-eval-$M-e.log 2>&1
EVAL_THREADS=10 bash training/eval_sim.sh sim2f "$M" > logs/v2-eval-$M-f.log 2>&1
$PY training/eval_gain.py --rows data/sim2e/test.jsonl \
  --model "$M=out/records/${M}__sim2e__test.jsonl:out/cal/$M-sim2e.json${T1TAU:+:$T1TAU}" \
  --out out/eval/gain-$M-sim2e.json > logs/v2-gain-$M.log 2>&1
bash training/eval_real_sets.sh "$M" > logs/v2-real-$M.log 2>&1
touch out/.eval-done-$M
$PY training/export_runtime.py --ckpt models/$M --out out/export-$M --name "$NAME" --version "$VER" \
    --calibration out/cal/$M-sim2e.json --data-rows data/sim2e/dev.jsonl,data/cur5e/dev.jsonl --n-per-file 60 --threads 24 \
    > logs/v2-export-$M.log 2>&1
mkdir -p ~/xfer && tar cf ~/xfer/export-$M.tar --exclude=ref -C ~/gcl-train/out export-$M
IP=$(hostname -I | awk '{print $1}')
ss -ltn | grep -q ':8801 ' || (setsid nohup python3 -m http.server 8801 --bind "$IP" --directory /home/azureuser/xfer \
  > /tmp/xfer8801.log 2>&1 < /dev/null &)
touch out/.post-done-$M
