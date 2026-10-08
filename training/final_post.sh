#!/bin/bash
# Run detached on a model's rank-0 node after training: SIM eval (calibration fitted on dev, metrics on test), then the
# export with that calibration. Writes out/eval/<M>-simAe.json, out/cal/<M>-simAe.json, out/export-<M>/, and touches
# out/.post-done-<M>.
#   bash training/final_post.sh r17-final1 genclass-runtime-r17 1.0.0-rc1
set -u
cd ~/gcl-train
M="$1"; NAME="$2"; VER="$3"
PY=$HOME/jev/.venv/bin/python
export PYTHONPATH=$HOME/jev:$HOME/gcl-train/training HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false
EVAL_THREADS=12 bash training/eval_sim.sh simAe "$M" > logs/final-eval-$M.log 2>&1
$PY training/export_runtime.py --ckpt models/$M --out out/export-$M --name "$NAME" --version "$VER" \
    --calibration out/cal/$M-simAe.json --data-rows data/simAe/dev.jsonl,data/cur4/dev.jsonl --n-per-file 60 --threads 24 \
    > logs/final-export-$M.log 2>&1
touch out/.post-done-$M
# serve the export (without the fp32 reference) for the train VM's puller (training/pull_on_train.sh)
mkdir -p ~/xfer && tar cf ~/xfer/export-$M.tar --exclude=ref -C ~/gcl-train/out export-$M
IP=$(hostname -I | awk '{print $1}')
ss -ltn | grep -q ':8801 ' || (setsid nohup python3 -m http.server 8801 --bind "$IP" --directory /home/azureuser/xfer \
  > /tmp/xfer8801.log 2>&1 < /dev/null &)
touch out/.served-$M
