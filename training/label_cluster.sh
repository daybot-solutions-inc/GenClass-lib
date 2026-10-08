#!/bin/bash
# Teacher soft-labelling across nodes (embarrassingly parallel, resumable per shard).
#   training/label_cluster.sh WB TEACHER CAL SRC_DIR OUT_BUCKET "nodes" [PROCS_PER_NODE] [QIDS]
#   WB       workbench host holding ~/gcl-train/models/TEACHER, ~/gcl-train/CAL and ~/gcl-train/SRC_DIR/*.jsonl
#   TEACHER  servable checkpoint dir name under models/ (e.g. t150-v2a)
#   CAL      calibration json path relative to ~/gcl-train (e.g. out/cal/t150-v2a-simv2e.json)
#   SRC_DIR  directory of unlabeled shards relative to ~/gcl-train (e.g. data/unlab/v2a)
#   OUT_BUCKET  labelled shards land in ~/gcl-train/data/s3/OUT_BUCKET/ on each node, then are gathered on WB
# Each node pulls the teacher + its share of shards from WB over http, runs PROCS_PER_NODE label_teacher.py processes
# (80 / PROCS threads each), touches ~/gcl-train/.label-OUT_BUCKET-done when finished. Re-running resumes.
set -euo pipefail
WB="${1:?wb}"; TEACHER="${2:?teacher}"; CAL="${3:?cal}"; SRC="${4:?src dir}"; OUT="${5:?out bucket}"; NODES="${6:?nodes}"
PROCS="${7:-8}"; QIDS="${8:-action,diagnosis}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WBIP=$(awk -v h="$WB" '$1==h {print $3}' "$HOME/.jev-local/azure_hosts")
THREADS=$(( 80 / PROCS ))
# serve teacher + shards from the workbench (port 8805)
TIMEOUT=600 "$HERE/node.sh" "$WB" "cd ~/gcl-train && mkdir -p ~/xfer/label && tar cf ~/xfer/label/teacher-$TEACHER.tar models/$TEACHER $CAL && \
  ln -sfn ~/gcl-train/$SRC ~/xfer/label/src-$OUT && (ss -ltn | grep -q ':8805 ' || (setsid nohup python3 -m http.server 8805 \
  --bind $WBIP --directory /home/azureuser/xfer/label > /tmp/xfer8805.log 2>&1 < /dev/null &)); sleep 1; ls $SRC | grep -c jsonl"
SHARDS=$(TIMEOUT=60 "$HERE/node.sh" "$WB" "ls ~/gcl-train/$SRC | grep jsonl" | tr '\n' ' ')
set -- $NODES; N=$#
i=0
for n in $NODES; do
  mine=$(echo $SHARDS | tr ' ' '\n' | awk -v k=$N -v j=$i 'NR % k == j')
  list=$(echo $mine | tr '\n' ' ')
  TIMEOUT=120 "$HERE/node.sh" "$n" "cd ~/gcl-train && mkdir -p data/s3/$OUT logs && rm -f .label-$OUT-done && cat > /tmp/label-$OUT.sh <<'EOS'
set -u
cd ~/gcl-train
curl -sS --fail http://$WBIP:8805/teacher-$TEACHER.tar | tar x
mkdir -p data/label-src-$OUT
for s in $list; do [ -s data/label-src-$OUT/\$s ] || curl -sS --fail -o data/label-src-$OUT/\$s http://$WBIP:8805/src-$OUT/\$s; done
ls data/label-src-$OUT/*.jsonl | xargs -P $PROCS -I{} sh -c 'b=\$(basename {}); \$PY training/label_teacher.py --ckpt models/$TEACHER \
  --calibration $CAL --in {} --out data/s3/$OUT/\$b --qids $QIDS --batch 32 --threads $THREADS > logs/label-$OUT-\$b.log 2>&1'
touch .label-$OUT-done
EOS
(setsid nohup bash /tmp/label-$OUT.sh > logs/label-$OUT.log 2>&1 < /dev/null &); echo \"$n: \$(echo $list | wc -w) shards\""
  i=$((i + 1))
done
