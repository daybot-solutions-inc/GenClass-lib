#!/bin/bash
# Mac-side post-processing where every shipped number comes from the SHIPPED q8 ONNX file (coordinator, 10:40):
#   GATE_KIND=mass|gain [T1_TAU=1.0] training/dist_post3.sh r17-v2d genclass-runtime-r17 2.0.0-rc4 c08 "c02 c03 c04 c05 c13"
# 1. R0 exports (q8: MatMulNBits 8-bit, block 16 — parity fix; fp16) — calibration placeholder for now.
# 2. R0 + helpers collect q8 logits (onnxruntime CPU = onnxruntime-node/WASM kernels) on every dev/test set.
# 3. R0: temperatures (per kind + per header) fitted on q8 sim2e dev → the export's calibration.json; reports from q8
#    records (eval_runtime / eval_real / eval_gain); action gates (`gate.kind`) + gate.report fitted on q8 dev records
#    (sim2g + on-policy a/b dev + REAL dev), verified on q8 test records; meta.json + model.json hashes refreshed.
# Done flag R0:~/gcl-train/out/.post3-done-M; export tar served on R0:8801.
set -euo pipefail
M="${1:?model}"; NAME="${2:?export name}"; VER="${3:?version}"; R0="${4:?rank0}"; HELPERS="${5:?helper nodes}"
KIND="${GATE_KIND:-mass}"; T1="${T1_TAU:-}"; MQ="$M-q8"
HERE="$(cd "$(dirname "$0")" && pwd)"; JEV="$(cd "$HERE/../.." && pwd)"
ip() { awk -v h="$1" '$1==h {print $3}' "$HOME/.jev-local/azure_hosts"; }
R0IP=$(ip "$R0")
SETS="sim2e:test sim2e:dev sim2f:test real2e:test real2e:dev realev:test realev3:test onpae:test onpae:dev sim3e:test sim3e:dev real3e:test real3e:dev sim2g:dev onpbd:dev onpad:dev onpbe:test"
until TIMEOUT=30 "$HERE/node.sh" "$R0" "python3 -c \"import json,sys; sys.exit(0 if json.load(open('models/$M/meta.json')).get('final') else 1)\"" >/dev/null 2>&1; do sleep 30; done
sleep 30
for n in $R0 $HELPERS; do TIMEOUT=300 "$HERE/node.sh" "$n" sync >/dev/null 2>&1 & done; wait
echo "$(date -u +%T) exporting"
TIMEOUT=1800 "$HERE/node.sh" "$R0" "set -e; for t in gatefix sim2g; do :; done; \
  test -f data/onpbd/dev.jsonl || (curl -sS --fail http://10.0.0.14:8805/gatefix.tar | tar x --exclude=models); \
  test -f data/sim2g/dev.jsonl || (curl -sS --fail http://10.0.0.14:8805/sim2g.tar | tar x); \
  rm -rf out/export-$M; \$PY training/export_runtime.py --ckpt models/$M --out out/export-$M --name $NAME --version $VER \
    --calibration models/$M/calibration.json --data-rows data/sim2e/dev.jsonl,data/cur5e/dev.jsonl --n-per-file 60 \
    --threads 60 --block 16 > logs/post3-export-$M.log 2>&1; \
  mkdir -p ~/xfer && tar cf ~/xfer/q8-$M.tar models/$M out/export-$M/$NAME-q8.onnx && (ss -ltn | grep -q ':8807 ' || \
  (setsid nohup python3 -m http.server 8807 --bind $R0IP --directory /home/azureuser/xfer > /tmp/x8807.log 2>&1 < /dev/null &)); ls -la ~/xfer/q8-$M.tar"
set -- $R0 $HELPERS; K=$#
i=0
for n in $R0 $HELPERS; do
  TIMEOUT=900 "$HERE/node.sh" "$n" "test -f data/sim2g/dev.jsonl || (curl -sS --fail http://10.0.0.14:8805/sim2g.tar | tar x); \
    test -f data/onpbd/dev.jsonl || (curl -sS --fail http://10.0.0.14:8805/gatefix.tar | tar x --exclude=models); \
    ([ \"$n\" = \"$R0\" ] || (rm -rf models/$M out/export-$M && curl -sS --fail http://$R0IP:8807/q8-$M.tar | tar x)) && \
    rm -f out/.oparts-done-$MQ-$i && (setsid nohup bash training/collect_onnx_parts.sh $M out/export-$M/$NAME-q8.onnx $K $i \"$SETS\" \
    > logs/oparts-$M.log 2>&1 < /dev/null &); echo $n started $i" &
  i=$((i + 1))
done
wait
i=0
for n in $R0 $HELPERS; do
  until TIMEOUT=30 "$HERE/node.sh" "$n" "test -f out/.oparts-done-$MQ-$i" >/dev/null 2>&1; do sleep 20; done
  echo "$(date -u +%T) $n done"; i=$((i + 1))
done
IPS=$(for n in $R0 $HELPERS; do ip "$n"; done | tr '\n' ' ')
SCR="${SCRATCH:-/tmp}"
cat > "$SCR/post3-$M.sh" <<EOS
set -u
cd ~/gcl-train
export PYTHONPATH=\$HOME/jev:\$HOME/gcl-train/training HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false
PY=\$HOME/jev/.venv/bin/python
M=$M; MQ=$MQ; R=out/records; E=out/export-$M
i=0
for ip in $IPS; do for st in $SETS; do S=\${st%%:*}; SP=\${st##*:}; f=\${MQ}__\${S}__\${SP}.\$i.jsonl
  [ -s out/records/parts/\$f ] || curl -sS --fail -o out/records/parts/\$f http://\$ip:8808/\$f; done; i=\$((i+1)); done
for st in $SETS; do S=\${st%%:*}; SP=\${st##*:}; cat out/records/parts/\${MQ}__\${S}__\${SP}.*.jsonl > \$R/\${MQ}__\${S}__\${SP}.jsonl; done
ln -sfn \$HOME/gcl-train/models/\$M models/\$MQ
mkdir -p out/eval out/cal out/gates
\$PY training/eval_runtime.py --ckpt models/\$MQ --data data/sim2e --split test --fit-split dev --records-dir \$R --out out/eval/\$MQ-sim2e.json \
  --write-calibration out/cal/\$MQ-sim2e.json --header-calibration > logs/eval-\$MQ-sim2e.log 2>&1
C=out/cal/\$MQ-sim2e.json
for S in sim2f real2e onpae sim3e real3e; do
  \$PY training/eval_runtime.py --ckpt models/\$MQ --data data/\$S --split test --calibration \$C --records-dir \$R --out out/eval/\$MQ-\$S.json > logs/eval-\$MQ-\$S.log 2>&1
done
\$PY training/eval_real.py --rows data/realev/test.jsonl --model \$MQ=\$R/\${MQ}__realev__test.jsonl:\$C --out out/eval/real-\$MQ.json > logs/real-\$MQ.log 2>&1
\$PY training/eval_real.py --rows data/realev3/test.jsonl --model \$MQ=\$R/\${MQ}__realev3__test.jsonl:\$C --out out/eval/real3-\$MQ.json > logs/real3-\$MQ.log 2>&1
for S in sim2e onpae; do
  \$PY training/eval_gain.py --rows data/\$S/test.jsonl --model "\$MQ=\$R/\${MQ}__\${S}__test.jsonl:\$C${T1:+:$T1}" --out out/eval/gain-\$MQ-\$S.json > logs/gain-\$MQ-\$S.log 2>&1
done
cp \$C \$E/calibration.json
FIT="--fit sim=data/sim2g/dev.jsonl:\$R/\${MQ}__sim2g__dev.jsonl --fit sim=data/onpbd/dev.jsonl:\$R/\${MQ}__onpbd__dev.jsonl --fit sim=data/onpad/dev.jsonl:\$R/\${MQ}__onpad__dev.jsonl --fit real=data/realev/test.jsonl:\$R/\${MQ}__realev__test.jsonl:notest:not=inconsistency --fit real=data/realev3/test.jsonl:\$R/\${MQ}__realev3__test.jsonl:notest:only=inconsistency --fit realc=data/real2e/dev.jsonl:\$R/\${MQ}__real2e__dev.jsonl"
TEST="--test sim=data/onpbe/test.jsonl:\$R/\${MQ}__onpbe__test.jsonl --test sim=data/sim2e/test.jsonl:\$R/\${MQ}__sim2e__test.jsonl --test sim=data/sim2f/test.jsonl:\$R/\${MQ}__sim2f__test.jsonl --test sim=data/sim3e/test.jsonl:\$R/\${MQ}__sim3e__test.jsonl --test sim=data/onpae/test.jsonl:\$R/\${MQ}__onpae__test.jsonl --test real=data/realev/test.jsonl:\$R/\${MQ}__realev__test.jsonl:test:not=inconsistency --test real=data/realev3/test.jsonl:\$R/\${MQ}__realev3__test.jsonl:test:only=inconsistency --test realc=data/real2e/test.jsonl:\$R/\${MQ}__real2e__test.jsonl"
\$PY training/fit_gates.py --kind $KIND --tau-gain ${T1:-1.0} --cal \$C \$FIT \$TEST --out out/gates/\$MQ.json --write-meta \$E > logs/gates-\$MQ.log 2>&1
\$PY training/fit_report.py --cal \$C --fit sim=data/sim2g/dev.jsonl:\$R/\${MQ}__sim2g__dev.jsonl --fit simb=data/onpbd/dev.jsonl:\$R/\${MQ}__onpbd__dev.jsonl --fit sima=data/onpad/dev.jsonl:\$R/\${MQ}__onpad__dev.jsonl \
  --fit real=data/realev/test.jsonl:\$R/\${MQ}__realev__test.jsonl:notest:not=inconsistency --fit real=data/realev3/test.jsonl:\$R/\${MQ}__realev3__test.jsonl:notest:only=inconsistency \
  --test simonpb=data/onpbe/test.jsonl:\$R/\${MQ}__onpbe__test.jsonl --test sim2e=data/sim2e/test.jsonl:\$R/\${MQ}__sim2e__test.jsonl --test sim2f=data/sim2f/test.jsonl:\$R/\${MQ}__sim2f__test.jsonl \
  --test sim3e=data/sim3e/test.jsonl:\$R/\${MQ}__sim3e__test.jsonl --test real2e=data/real2e/test.jsonl:\$R/\${MQ}__real2e__test.jsonl \
  --test realev=data/realev/test.jsonl:\$R/\${MQ}__realev__test.jsonl:test --test realev3=data/realev3/test.jsonl:\$R/\${MQ}__realev3__test.jsonl:test \
  --out out/gates/\$MQ-report.json --write-meta \$E > logs/report-\$MQ.log 2>&1
python3 - <<PY
import json
p = "\$E/meta.json"; m = json.load(open(p))
m.setdefault("gate_fit", {})["source"] = "fitted and verified on outputs of the shipped q8 ONNX file (onnxruntime CPU), calibration fitted on q8 sim2e dev (per kind + per header)"
open(p, "w").write(json.dumps(m, indent=2) + "\n")
PY
\$PY training/refresh_card.py \$E > logs/card-\$M.log 2>&1
mkdir -p ~/xfer && tar cf ~/xfer/export-\$M.tar --exclude=ref -C ~/gcl-train/out export-\$M
IP=\$(hostname -I | awk '{print \$1}')
ss -ltn | grep -q ':8801 ' || (setsid nohup python3 -m http.server 8801 --bind "\$IP" --directory /home/azureuser/xfer > /tmp/xfer8801.log 2>&1 < /dev/null &)
touch out/.post3-done-\$M
EOS
timeout 60 "$JEV/scripts/azvm.sh" "$R0" --put "$SCR/post3-$M.sh" /tmp/post3-$M.sh
TIMEOUT=60 "$HERE/node.sh" "$R0" "(setsid nohup bash /tmp/post3-$M.sh > logs/post3-$M.log 2>&1 < /dev/null &); echo r0 post launched"
echo "$(date -u +%T) launched R0 post"
