#!/bin/bash
# Mac-side: evaluate + export + fit gates for a finished student, spreading logit collection over the run's nodes.
#   GATE_KIND=mass|gain [T1_TAU=1.0] training/dist_post.sh r17-v2d genclass-runtime-r17 2.0.0-rc4 c08 "c02 c03 c04 c05 c13"
# R0 (rank 0, holds models/M): eval_sim.sh sim2e with per-header temperatures (HEADER_CAL=1) → out/cal/M-sim2e.json
# (the shipped calibration). Helpers: collect_parts.sh (bf16 action+diagnosis logits) for every other set; R0 gathers
# the parts, writes reports (eval_runtime with the shipped calibration, eval_real for both REAL eval sets, eval_gain),
# exports, fits the gates (`gate.kind`) + gate.report with the 0.8× dev margin, writes them into the export's
# meta.json and serves the export tar on :8801. Logs: R0:~/gcl-train/logs/dist-post-M.log; done flag out/.dist-done-M.
set -euo pipefail
M="${1:?model}"; NAME="${2:?export name}"; VER="${3:?version}"; R0="${4:?rank0}"; HELPERS="${5:?helper nodes}"
KIND="${GATE_KIND:-mass}"; T1="${T1_TAU:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ip() { awk -v h="$1" '$1==h {print $3}' "$HOME/.jev-local/azure_hosts"; }
R0IP=$(ip "$R0")
SETS="sim2f:test sim2f:dev real2e:test real2e:dev realev:test realev3:test onpae:test onpae:dev sim3e:test sim3e:dev real3e:test real3e:dev sim2g:dev"
until TIMEOUT=30 "$HERE/node.sh" "$R0" "python3 -c \"import json,sys; sys.exit(0 if json.load(open('models/$M/meta.json')).get('final') else 1)\"" >/dev/null 2>&1; do sleep 30; done
sleep 20
for n in $R0 $HELPERS; do TIMEOUT=300 "$HERE/node.sh" "$n" sync >/dev/null 2>&1 & done; wait
TIMEOUT=300 "$HERE/node.sh" "$R0" "mkdir -p ~/xfer logs && tar cf ~/xfer/m-$M.tar models/$M && (ss -ltn | grep -q ':8807 ' || \
  (setsid nohup python3 -m http.server 8807 --bind $R0IP --directory /home/azureuser/xfer > /tmp/x8807.log 2>&1 < /dev/null &)); \
  (HEADER_CAL=1 EVAL_THREADS=10 setsid nohup bash training/eval_sim.sh sim2e $M > logs/dist-sim2e-$M.log 2>&1 < /dev/null &); echo r0 started"
set -- $HELPERS; K=$#
i=0
for n in $HELPERS; do
  TIMEOUT=900 "$HERE/node.sh" "$n" "test -f data/sim2g/dev.jsonl || (curl -sS --fail http://10.0.0.14:8805/sim2g.tar | tar x); \
    rm -rf models/$M out/.parts-done-$M-$i out/records/parts/${M}__*; curl -sS --fail http://$R0IP:8807/m-$M.tar | tar x && \
    (setsid nohup bash training/collect_parts.sh $M $K $i \"$SETS\" > logs/parts-$M.log 2>&1 < /dev/null &); echo $n started $i" &
  i=$((i + 1))
done
wait
i=0
for n in $HELPERS; do
  until TIMEOUT=30 "$HERE/node.sh" "$n" "test -f out/.parts-done-$M-$i" >/dev/null 2>&1; do sleep 20; done
  echo "$n done"; i=$((i + 1))
done
IPS=$(for n in $HELPERS; do ip "$n"; done | tr '\n' ' ')
SCR="${SCRATCH:-/tmp}"
cat > "$SCR/dist-post-$M.sh" <<EOS
set -u
cd ~/gcl-train
export PYTHONPATH=\$HOME/jev:\$HOME/gcl-train/training HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false
PY=\$HOME/jev/.venv/bin/python
M=$M; R=out/records
mkdir -p out/records/parts out/eval out/cal out/gates
i=0
for ip in $IPS; do for st in $SETS; do S=\${st%%:*}; SP=\${st##*:}
  curl -sS --fail -o out/records/parts/\${M}__\${S}__\${SP}.\$i.jsonl http://\$ip:8808/\${M}__\${S}__\${SP}.\$i.jsonl; done; i=\$((i+1)); done
for st in $SETS; do S=\${st%%:*}; SP=\${st##*:}; cat out/records/parts/\${M}__\${S}__\${SP}.*.jsonl > \$R/\${M}__\${S}__\${SP}.jsonl; done
sleep 60
until test -f out/eval/\$M-sim2e.json && ! pgrep -f "eval_sim.sh sim2[e] \$M" >/dev/null; do sleep 20; done
C=out/cal/\$M-sim2e.json
for S in sim2f real2e onpae sim3e real3e; do
  \$PY training/eval_runtime.py --ckpt models/\$M --data data/\$S --split test --calibration \$C --records-dir \$R --out out/eval/\$M-\$S.json > logs/eval-\$M-\$S.log 2>&1
done
\$PY training/eval_real.py --rows data/realev/test.jsonl --model \$M=\$R/\${M}__realev__test.jsonl:\$C --out out/eval/real-\$M.json > logs/v2-real-\$M.log 2>&1
\$PY training/eval_real.py --rows data/realev3/test.jsonl --model \$M=\$R/\${M}__realev3__test.jsonl:\$C --out out/eval/real3-\$M.json > logs/v2-real3-\$M.log 2>&1
\$PY training/eval_gain.py --rows data/sim2e/test.jsonl --model "\$M=\$R/\${M}__sim2e__test.jsonl:\$C${T1:+:$T1}" --out out/eval/gain-\$M-sim2e.json > logs/v2-gain-\$M.log 2>&1
\$PY training/eval_gain.py --rows data/onpae/test.jsonl --model "\$M=\$R/\${M}__onpae__test.jsonl:\$C${T1:+:$T1}" --out out/eval/gain-\$M-onpae.json > logs/v2-gain-onpa-\$M.log 2>&1
\$PY training/export_runtime.py --ckpt models/\$M --out out/export-\$M --name $NAME --version $VER --calibration \$C \
  --data-rows data/sim2e/dev.jsonl,data/cur5e/dev.jsonl --n-per-file 60 --threads 24 > logs/v2-export-\$M.log 2>&1
FIT="--fit sim=data/sim2g/dev.jsonl:\$R/\${M}__sim2g__dev.jsonl --fit real=data/realev/test.jsonl:\$R/\${M}__realev__test.jsonl:notest:not=inconsistency --fit real=data/realev3/test.jsonl:\$R/\${M}__realev3__test.jsonl:notest:only=inconsistency --fit realc=data/real2e/dev.jsonl:\$R/\${M}__real2e__dev.jsonl"
TEST="--test sim=data/sim2e/test.jsonl:\$R/\${M}__sim2e__test.jsonl --test sim=data/sim2f/test.jsonl:\$R/\${M}__sim2f__test.jsonl --test sim=data/sim3e/test.jsonl:\$R/\${M}__sim3e__test.jsonl --test real=data/realev/test.jsonl:\$R/\${M}__realev__test.jsonl:test:not=inconsistency --test real=data/realev3/test.jsonl:\$R/\${M}__realev3__test.jsonl:test:only=inconsistency --test realc=data/real2e/test.jsonl:\$R/\${M}__real2e__test.jsonl"
\$PY training/fit_gates.py --kind $KIND --tau-gain ${T1:-1.0} --cal \$C \$FIT \$TEST --test sim=data/onpae/test.jsonl:\$R/\${M}__onpae__test.jsonl --out out/gates/\$M.json --write-meta out/export-\$M > logs/gates-\$M.log 2>&1
\$PY training/fit_report.py --cal \$C --fit sim=data/sim2g/dev.jsonl:\$R/\${M}__sim2g__dev.jsonl \
  --fit real=data/realev/test.jsonl:\$R/\${M}__realev__test.jsonl:notest:not=inconsistency --fit real=data/realev3/test.jsonl:\$R/\${M}__realev3__test.jsonl:notest:only=inconsistency \
  --test sim2e=data/sim2e/test.jsonl:\$R/\${M}__sim2e__test.jsonl --test sim2f=data/sim2f/test.jsonl:\$R/\${M}__sim2f__test.jsonl \
  --test sim3e=data/sim3e/test.jsonl:\$R/\${M}__sim3e__test.jsonl --test real2e=data/real2e/test.jsonl:\$R/\${M}__real2e__test.jsonl \
  --test realev=data/realev/test.jsonl:\$R/\${M}__realev__test.jsonl:test --test realev3=data/realev3/test.jsonl:\$R/\${M}__realev3__test.jsonl:test \
  --out out/gates/\$M-report.json --write-meta out/export-\$M > logs/report-\$M.log 2>&1
mkdir -p ~/xfer && tar cf ~/xfer/export-\$M.tar --exclude=ref -C ~/gcl-train/out export-\$M
IP=\$(hostname -I | awk '{print \$1}')
ss -ltn | grep -q ':8801 ' || (setsid nohup python3 -m http.server 8801 --bind "\$IP" --directory /home/azureuser/xfer > /tmp/xfer8801.log 2>&1 < /dev/null &)
touch out/.dist-done-\$M
EOS
timeout 60 "$HERE/../../scripts/azvm.sh" "$R0" --put "$SCR/dist-post-$M.sh" /tmp/dist-post-$M.sh
TIMEOUT=60 "$HERE/node.sh" "$R0" "(setsid nohup bash /tmp/dist-post-$M.sh > logs/dist-post-$M.log 2>&1 < /dev/null &); echo r0 post launched"
