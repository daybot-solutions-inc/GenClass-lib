#!/bin/bash
# REAL v2 batches → training bucket + eval sets, on the workbench (detached). Source: train:/data/real-out (served on
# 10.0.0.4:8804). Builds:
#   data/s3/real2/shardNN.jsonl     gold train rows of the given batches (32 shards)
#   data/real2e/{dev,test}.jsonl     ≈ 8k dev + ≈ 20k test rows (REAL's held-out framework/apps live in test)
#   data/realev/test.jsonl           REAL's unambiguous-case eval set (EVALDIR/real_eval.jsonl), + data/realev_t{0..3}
#   data/s3/realunl/                 unlabeled train rows (for teacher labelling)
#   ~/xfer/v2_real2.tar
#   training/import_real.sh "v2c1 v2c2 v2c3 v2c4" v2-eval          (WB=c02)
set -euo pipefail
BATCHES="${1:?batch dirs under /data/real-out}"; EVALDIR="${2:-v2-eval}"
WB="${WB:-c02}"; PORT=8804
HERE="$(cd "$(dirname "$0")" && pwd)"
JEV="$(cd "$HERE/../.." && pwd)"
timeout 120 "$JEV/scripts/azvm.sh" train "ss -ltn | grep -q ':${PORT} ' || \
  (setsid nohup python3 -m http.server ${PORT} --bind 10.0.0.4 --directory /data/real-out > /tmp/xfer${PORT}.log 2>&1 < /dev/null &); \
  sleep 1; for b in $BATCHES; do ls /data/real-out/\$b/done.txt /data/real-out/\$b/train.jsonl; done; ls /data/real-out/$EVALDIR/real_eval.jsonl || true"
TIMEOUT=120 "$HERE/node.sh" "$WB" "mkdir -p logs && cat > /tmp/import-real.sh <<'EOS'
set -eu
cd ~/gcl-train
echo \"start \$(date -u +%T)\"
rm -rf data/realraw data/s3/real2 data/real2e data/realev data/realev_* data/s3/realunl
mkdir -p data/realraw data/s3/real2 data/real2e data/realev data/s3/realunl
for b in $BATCHES; do for s in train dev test unlabeled-train; do
  curl -sS --fail -o data/realraw/\$b.\$s.jsonl http://10.0.0.4:${PORT}/\$b/\$s.jsonl || echo \"missing \$b/\$s\"; done; done
cat data/realraw/*.train.jsonl | shuf --random-source=<(yes 3) > /tmp/real_train.jsonl
split -n l/32 -d -a 2 --additional-suffix=.jsonl /tmp/real_train.jsonl data/s3/real2/shard && rm /tmp/real_train.jsonl
cat data/realraw/*.test.jsonl | shuf -n 20000 --random-source=<(yes 4) > data/real2e/test.jsonl
cat data/realraw/*.dev.jsonl | shuf -n 8000 --random-source=<(yes 5) > data/real2e/dev.jsonl
for i in 0 1 2 3; do mkdir -p data/real2e_t\$i; awk -v k=\$i 'NR % 4 == k' data/real2e/test.jsonl > data/real2e_t\$i/test.jsonl; done
for i in 0 1; do mkdir -p data/real2e_d\$i; awk -v k=\$i 'NR % 2 == k' data/real2e/dev.jsonl > data/real2e_d\$i/dev.jsonl; done
(curl -sS --fail -o data/realev/test.jsonl http://10.0.0.4:${PORT}/$EVALDIR/real_eval.jsonl && \
  for i in 0 1 2 3; do mkdir -p data/realev_t\$i; awk -v k=\$i 'NR % 4 == k' data/realev/test.jsonl > data/realev_t\$i/test.jsonl; done) || echo \"no eval set yet\"
cat data/realraw/*.unlabeled-train.jsonl > /tmp/real_unl.jsonl && split -n l/32 -d -a 2 --additional-suffix=.jsonl /tmp/real_unl.jsonl data/s3/realunl/shard && rm /tmp/real_unl.jsonl || true
wc -l data/s3/real2/* | tail -1; wc -l data/real2e/*.jsonl data/realev/test.jsonl 2>/dev/null; wc -l data/s3/realunl/* | tail -1
tar cf ~/xfer/v2_real2.tar data/s3/real2 data/real2e data/real2e_* \$(ls -d data/realev data/realev_* 2>/dev/null)
ls -la ~/xfer/v2_real2.tar; touch ~/xfer/.done-real2
echo \"done \$(date -u +%T)\"
EOS
setsid nohup bash /tmp/import-real.sh > logs/import-real.log 2>&1 < /dev/null & echo launched"
