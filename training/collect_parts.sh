#!/bin/bash
# One node's share of a distributed logit collection (big models, e.g. the teacher): rows with line_no % K == I of
# every SET:SPLIT, 8 collect_gain.py processes (bf16), records → out/records/parts/<M>__<SET>__<SPLIT>.<I>.jsonl,
# served on :8808 for the gathering node; touches out/.parts-done-<M>-<I>.
#   bash training/collect_parts.sh t150-v2a 11 3 "sim2e:test sim2e:dev sim2f:test real2e:test real2e:dev realev:test"
set -u
cd ~/gcl-train
M="$1"; K="$2"; I="$3"; SETS="$4"; P=${PROCS:-8}; T=$(( 80 / P ))
PY=$HOME/jev/.venv/bin/python
export PYTHONPATH=$HOME/jev:$HOME/gcl-train/training HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=$T
mkdir -p out/records/parts /tmp/cp-$M logs
for st in $SETS; do
  S=${st%%:*}; SP=${st##*:}
  awk -v k=$K -v i=$I '(NR - 1) % k == i' data/$S/$SP.jsonl > /tmp/cp-$M/$S.$SP.mine
  split -n l/$P -d -a 1 /tmp/cp-$M/$S.$SP.mine /tmp/cp-$M/$S.$SP.chunk
done
ls /tmp/cp-$M/*.chunk* | xargs -P $P -I{} sh -c "$PY training/collect_gain.py --ckpt models/$M --in {} --out {}.rec --threads $T --amp > {}.log 2>&1"
for st in $SETS; do
  S=${st%%:*}; SP=${st##*:}
  cat /tmp/cp-$M/$S.$SP.chunk*.rec > out/records/parts/${M}__${S}__${SP}.$I.jsonl
done
IP=$(hostname -I | awk '{print $1}')
ss -ltn | grep -q ':8808 ' || (setsid nohup python3 -m http.server 8808 --bind "$IP" --directory /home/azureuser/gcl-train/out/records/parts > /tmp/x8808.log 2>&1 < /dev/null &)
touch out/.parts-done-$M-$I
