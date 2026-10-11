#!/bin/bash
# situation-v2 import (run from the Mac): serve a collected SIM batch from the train VM, then on the workbench (detached):
# download the gz shards, prep_v2.py (train shards + eval sets incl. held-out features), the v2 curriculum replay
# (cur5: 300k rows, 80% runtime-exact), and a tar for the training nodes served on WB:8799.
#   training/import_v2.sh /data/sim-out/v2-gold sim2            (WB=c02 PORT=8803 by default)
# Progress: logs/import-<name>.log on the workbench; done flag ~/xfer/.done-<name>.
set -euo pipefail
SRC="${1:?collected sim dir on the train VM}"; NAME="${2:?bucket name}"
WB="${WB:-c02}"; PORT="${PORT:-8803}"
WBIP=$(awk -v h="$WB" '$1==h {print $3}' "$HOME/.jev-local/azure_hosts")
HERE="$(cd "$(dirname "$0")" && pwd)"
JEV="$(cd "$HERE/.." && pwd)"   # repo root (scripts/azvm.sh)
timeout 120 "$JEV/scripts/azvm.sh" train "ss -ltn | grep -q ':${PORT} ' || \
  (setsid nohup python3 -m http.server ${PORT} --bind 10.0.0.4 --directory $SRC > /tmp/xfer${PORT}.log 2>&1 < /dev/null &); \
  sleep 2; ss -ltn | grep ':${PORT} ' || true; ls $SRC | grep -c gz"
FILES=$(timeout 60 "$JEV/scripts/azvm.sh" train "cd $SRC && ls *.jsonl.gz manifest.json" | tr '\n' ' ')
TIMEOUT=120 "$HERE/node.sh" "$WB" "mkdir -p logs ~/xfer data/${NAME}raw && cat > /tmp/import-$NAME.sh <<'EOS'
set -eu
cd ~/gcl-train
export PYTHONPATH=\$HOME/jev:\$HOME/gcl-train/training
PY=\$HOME/jev/.venv/bin/python
echo \"start \$(date -u +%T)\"
for f in $FILES; do echo \$f; done | xargs -P 12 -I{} curl -sS --fail -o data/${NAME}raw/{} http://10.0.0.4:${PORT}/{}
echo \"downloaded \$(date -u +%T)\"; du -sh data/${NAME}raw
rm -rf data/s3/$NAME data/${NAME}e data/${NAME}e_* data/${NAME}f data/${NAME}f_*
\$PY training/prep_v2.py --src data/${NAME}raw --name $NAME --workers 40
echo \"prepped \$(date -u +%T)\"
if [ ! -d data/s3/cur5 ]; then
  rm -rf /tmp/cur5 && cd training && \$PY -m curriculum.generate --out /tmp/cur5 --n 300000 --seed 15 --p-runtime 0.8 --workers 64 && cd ..
  mkdir -p data/s3/cur5 data/cur5e && split -n l/32 -d -a 2 --additional-suffix=.jsonl /tmp/cur5/train.jsonl data/s3/cur5/shard
  cp /tmp/cur5/dev.jsonl /tmp/cur5/test.jsonl data/cur5e/
fi
echo \"curriculum \$(date -u +%T)\"
tar cf ~/xfer/v2_$NAME.tar data/s3/$NAME data/s3/cur5 data/${NAME}e data/${NAME}e_* data/${NAME}f data/${NAME}f_* data/cur5e
ls -la ~/xfer/v2_$NAME.tar
(ss -ltn | grep -q ':8799 ' || (setsid nohup python3 -m http.server 8799 --bind $WBIP --directory /home/azureuser/xfer > /tmp/xfer8799.log 2>&1 < /dev/null &))
touch ~/xfer/.done-$NAME
echo \"done \$(date -u +%T)\"
EOS
setsid nohup bash /tmp/import-$NAME.sh > logs/import-$NAME.log 2>&1 < /dev/null & echo launched"
