#!/bin/bash
# One node's share of q8-ONNX logit collection: rows with line_no % K == I of every SET:SPLIT, P collect_onnx.py
# processes, records → out/records/parts/<MQ>__<SET>__<SPLIT>.<I>.jsonl (served on :8808); touches out/.oparts-done-<MQ>-<I>.
#   bash training/collect_onnx_parts.sh r17-v2d out/export-r17-v2d/genclass-runtime-r17-q8.onnx 6 2 "sim2e:dev ..."
set -u
cd ~/gcl-train
M="$1"; ONNX="$2"; K="$3"; I="$4"; SETS="$5"; P=${PROCS:-8}; T=$(( 80 / P )); MQ="$M-q8"
PY=$HOME/jev/.venv/bin/python
export PYTHONPATH=$HOME/jev:$HOME/gcl-train/training HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=$T
mkdir -p out/records/parts /tmp/co-$M logs
rm -f /tmp/co-$M/*
for st in $SETS; do
  S=${st%%:*}; SP=${st##*:}
  awk -v k=$K -v i=$I '(NR - 1) % k == i' data/$S/$SP.jsonl > /tmp/co-$M/$S.$SP.mine
  split -n l/$P -d -a 1 /tmp/co-$M/$S.$SP.mine /tmp/co-$M/$S.$SP.chunk
done
ls /tmp/co-$M/*.chunk* | xargs -P $P -I{} sh -c "$PY training/collect_onnx.py --ckpt models/$M --onnx $ONNX --in {} --out {}.rec --threads $T > {}.log 2>&1"
for st in $SETS; do
  S=${st%%:*}; SP=${st##*:}
  cat /tmp/co-$M/$S.$SP.chunk*.rec > out/records/parts/${MQ}__${S}__${SP}.$I.jsonl
done
IP=$(hostname -I | awk '{print $1}')
ss -ltn | grep -q ':8808 ' || (setsid nohup python3 -m http.server 8808 --bind "$IP" --directory /home/azureuser/gcl-train/out/records/parts > /tmp/x8808.log 2>&1 < /dev/null &)
touch out/.oparts-done-$MQ-$I
