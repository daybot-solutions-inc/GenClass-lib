#!/bin/bash
# Mac-side: evaluate a big (teacher) checkpoint quickly by spreading logit collection over many nodes.
#   training/teacher_eval.sh t150-v2a c12 "c12 c14 c15 c16 c17 c18 c19 c20 c21 c22 c23"
# RANK0 holds models/M; every node gets it over http (:8807), runs collect_parts.sh on its share; RANK0 gathers the
# parts and runs eval_runtime (sim2e: temperatures fitted on dev; sim2f, real2e), eval_real (realev) and eval_gain.
set -euo pipefail
M="${1:?model}"; R0="${2:?rank0 node}"; NODES="${3:?nodes}"
SETS="sim2e:test sim2e:dev sim2f:test real2e:test real2e:dev realev:test"
HERE="$(cd "$(dirname "$0")" && pwd)"
R0IP=$(awk -v h="$R0" '$1==h {print $3}' "$HOME/.jev-local/azure_hosts")
set -- $NODES; K=$#
TIMEOUT=600 "$HERE/node.sh" "$R0" "mkdir -p ~/xfer && tar cf ~/xfer/$M.tar models/$M && (ss -ltn | grep -q ':8807 ' || \
  (setsid nohup python3 -m http.server 8807 --bind $R0IP --directory /home/azureuser/xfer > /tmp/x8807.log 2>&1 < /dev/null &)); sleep 1; ls -la ~/xfer/$M.tar"
i=0
for n in $NODES; do
  TIMEOUT=120 "$HERE/node.sh" "$n" sync >/dev/null 2>&1 || true
  TIMEOUT=900 "$HERE/node.sh" "$n" "rm -f out/.parts-done-$M-$i; ([ \"$n\" = \"$R0\" ] || (rm -rf models/$M && curl -sS --fail http://$R0IP:8807/$M.tar | tar x)) && \
    (setsid nohup bash training/collect_parts.sh $M $K $i \"$SETS\" > logs/parts-$M.log 2>&1 < /dev/null &); echo $n started $i" &
  i=$((i + 1))
done
wait
i=0
for n in $NODES; do
  until TIMEOUT=30 "$HERE/node.sh" "$n" "test -f out/.parts-done-$M-$i" >/dev/null 2>&1; do sleep 20; done
  echo "$n done"; i=$((i + 1))
done
IPS=$(for n in $NODES; do awk -v h="$n" '$1==h {print $3}' "$HOME/.jev-local/azure_hosts"; done | tr '\n' ' ')
TIMEOUT=7200 "$HERE/node.sh" "$R0" "set -e; cd ~/gcl-train; i=0; for ip in $IPS; do for st in $SETS; do S=\${st%%:*}; SP=\${st##*:}; \
  [ -s out/records/parts/${M}__\${S}__\${SP}.\$i.jsonl ] || curl -sS --fail -o out/records/parts/${M}__\${S}__\${SP}.\$i.jsonl http://\$ip:8808/${M}__\${S}__\${SP}.\$i.jsonl; done; i=\$((i+1)); done; \
  for st in $SETS; do S=\${st%%:*}; SP=\${st##*:}; cat out/records/parts/${M}__\${S}__\${SP}.*.jsonl > out/records/${M}__\${S}__\${SP}.jsonl; done; \
  mkdir -p out/eval out/cal; \
  \$PY training/eval_runtime.py --ckpt models/$M --data data/sim2e --split test --fit-split dev --records-dir out/records --out out/eval/$M-sim2e.json --write-calibration out/cal/$M-sim2e.json > logs/eval-$M-sim2e.log 2>&1; \
  \$PY training/eval_runtime.py --ckpt models/$M --data data/sim2f --split test --calibration out/cal/$M-sim2e.json --records-dir out/records --out out/eval/$M-sim2f.json > logs/eval-$M-sim2f.log 2>&1; \
  \$PY training/eval_runtime.py --ckpt models/$M --data data/real2e --split test --fit-split dev --records-dir out/records --out out/eval/$M-real2e.json > logs/eval-$M-real2e.log 2>&1; \
  \$PY training/eval_real.py --rows data/realev/test.jsonl --model $M=out/records/${M}__realev__test.jsonl:out/cal/$M-sim2e.json --out out/eval/real-$M.json > logs/v2-real-$M.log 2>&1; \
  \$PY training/eval_gain.py --rows data/sim2e/test.jsonl --model $M=out/records/${M}__sim2e__test.jsonl:out/cal/$M-sim2e.json --out out/eval/gain-$M-sim2e.json > logs/v2-gain-$M.log 2>&1; \
  python3 training/report.py $M-sim2e=out/eval/$M-sim2e.json $M-sim2f=out/eval/$M-sim2f.json $M-real2e=out/eval/$M-real2e.json | sed -n 1,16p"
