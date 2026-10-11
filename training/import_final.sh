#!/bin/bash
# Pull a frozen-runtime SIM run from the train VM to c01 and prepare everything the final round needs:
#   data/s3/<NAME>/shard*.jsonl            train split, 64 shards (trainer input; bucket name = NAME)
#   data/<NAME>e/{dev,test}.jsonl           eval sets: 8k random dev rows, 20k random test rows (held-out domains)
#   data/<NAME>e_t{0..3}/test.jsonl, data/<NAME>e_d{0,1}/dev.jsonl   shards for parallel logit collection
#   ~/xfer/final_<NAME>.tar                 data/s3 + eval sets + training/ (served on 10.0.0.6:8799 for the nodes)
#   training/import_final.sh /home/azureuser/gcl/sim/sim/out/final-a simA
set -euo pipefail
SRC="${1:?sim out dir on the train VM}"; NAME="${2:?bucket name}"
WB="${WB:-c01}"                                                     # workbench host (c01 or e.g. c12)
WBIP=$(awk -v h="$WB" '$1==h {print $3}' "$HOME/.jev-local/azure_hosts")
FILES="${FILES:-train dev test}"
PORT="${PORT:-8802}"                                                 # train-VM http port (one per source dir)
HERE="$(cd "$(dirname "$0")" && pwd)"
JEV="$(cd "$HERE/.." && pwd)"   # repo root (scripts/azvm.sh)
# serve SRC from the train VM (no pkill here: the remote shell's own command line contains the pattern)
timeout 120 "$JEV/scripts/azvm.sh" train "ls -la $SRC/*.jsonl; ss -ltn | grep -q ':${PORT} ' || \
  (setsid nohup python3 -m http.server ${PORT} --bind 10.0.0.4 --directory $SRC > /tmp/xfer${PORT}.log 2>&1 < /dev/null &); \
  sleep 2; ss -ltn | grep ':${PORT} ' || true" || true
TIMEOUT=2400 "$HERE/node.sh" "$WB" "set -e; cd ~/gcl-train && rm -rf data/$NAME data/s3/$NAME data/${NAME}e data/${NAME}e_* && \
  mkdir -p data/$NAME data/s3/$NAME data/${NAME}e && \
  for s in $FILES; do curl -sS --fail -o data/$NAME/\$s.jsonl http://10.0.0.4:${PORT}/\$s.jsonl; done && \
  (curl -sS --fail -o data/$NAME/stats.json http://10.0.0.4:${PORT}/stats.json || true) && wc -l data/$NAME/*.jsonl && \
  split -n l/64 -d -a 2 --additional-suffix=.jsonl data/$NAME/train.jsonl data/s3/$NAME/shard && rm data/$NAME/train.jsonl && \
  shuf -n 20000 --random-source=<(yes 7) data/$NAME/test.jsonl > data/${NAME}e/test.jsonl && \
  shuf -n 8000 --random-source=<(yes 8) data/$NAME/dev.jsonl > data/${NAME}e/dev.jsonl && \
  for i in 0 1 2 3; do mkdir -p data/${NAME}e_t\$i; done && split -n l/4 -d -a 1 data/${NAME}e/test.jsonl /tmp/${NAME}t && \
  for i in 0 1 2 3; do mv /tmp/${NAME}t\$i data/${NAME}e_t\$i/test.jsonl; done && \
  for i in 0 1; do mkdir -p data/${NAME}e_d\$i; done && split -n l/2 -d -a 1 data/${NAME}e/dev.jsonl /tmp/${NAME}d && \
  for i in 0 1; do mv /tmp/${NAME}d\$i data/${NAME}e_d\$i/dev.jsonl; done && \
  tar cf ~/xfer/final_$NAME.tar data/s3 data/${NAME}e data/${NAME}e_* data/cur4 training && ls -la ~/xfer/final_$NAME.tar && \
  (ss -ltn | grep -q ':8799 ' || (setsid nohup python3 -m http.server 8799 --bind $WBIP --directory /home/azureuser/xfer \
   > /tmp/xfer8799.log 2>&1 < /dev/null &)); sleep 1; ss -ltn | grep 8799"
# (the train VM's http.server on :${PORT} is left running; stop it with: pkill -f "http.server 880[2]")
