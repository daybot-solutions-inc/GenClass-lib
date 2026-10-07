#!/bin/bash
# Pull a finished SIM run from the train VM to c01, shard it for the trainer, and bundle it for the nodes.
#   training/import_sim.sh SIM_OUT_DIR_ON_TRAIN_VM NAME
#   e.g. training/import_sim.sh /home/azureuser/gcl/sim/sim/out/r1m sim1
# Result on c01: ~/gcl-train/data/s2/NAME/shard*.jsonl (train, 64 shards), ~/gcl-train/data/NAME/{dev,test}.jsonl,
# ~/xfer/s2_NAME.tar (served on 10.0.0.6:8799 for the training nodes).
set -euo pipefail
SRC="${1:?sim out dir on the train VM}"; NAME="${2:?name}"
HERE="$(cd "$(dirname "$0")" && pwd)"
JEV="$(cd "$HERE/../.." && pwd)"
# serve the SIM dir from the train VM on its private address (read-only http.server, port 8802)
TIMEOUT=120 "$JEV/scripts/azvm.sh" train "ls -la $SRC && (ss -ltn | grep -q ':8802 ' && pkill -f 'http.server 880[2]' || true); \
  (setsid nohup python3 -m http.server 8802 --bind 10.0.0.4 --directory $SRC > /tmp/xfer8802.log 2>&1 < /dev/null &); sleep 1; ss -ltn | grep 8802"
TIMEOUT=1800 "$HERE/node.sh" c01 "set -e; cd ~/gcl-train && mkdir -p data/$NAME data/s2/$NAME && \
  for s in train dev test; do curl -sS --fail -o data/$NAME/\$s.jsonl http://10.0.0.4:8802/\$s.jsonl; done && \
  curl -sS --fail -o data/$NAME/stats.json http://10.0.0.4:8802/stats.json || true; \
  wc -l data/$NAME/*.jsonl && rm -f data/s2/$NAME/shard*.jsonl && \
  split -n l/64 -d -a 2 --additional-suffix=.jsonl data/$NAME/train.jsonl data/s2/$NAME/shard && rm data/$NAME/train.jsonl && \
  tar cf ~/xfer/s2_$NAME.tar data/s2/$NAME && ls -la ~/xfer/s2_$NAME.tar"
TIMEOUT=60 "$JEV/scripts/azvm.sh" train "pkill -f 'http.server 880[2]' || true"
