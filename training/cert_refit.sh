#!/bin/bash
# Mac-side: refit gates + gate.report for already-exported models on q8 outputs with REAL's certification dev set
# (train:/data/real-out/v23-cert) and shipping-gate-only on-policy rows (coordinator, 11:55).
#   training/cert_refit.sh "r17-v2c:c09:mass r17-v2d:c08:mass r17-v2dT:c06:gain" "c02 c03 c04 c05"
# Assumes each model's R0 holds models/M, out/export-M (q8) and its q8 records from dist_post3.sh; c09 is the
# workbench serving data on :8805. Writes the new gates into out/export-M/meta.json (+ model.json), out/gates/M-q8-cert*.json,
# and an h2h summary (training/h2h.py) per model into $SCRATCH/h2h-cert-M.json.
set -euo pipefail
SPECS="${1:?model:r0:kind ...}"; HELPERS="${2:?helper nodes}"
HERE="$(cd "$(dirname "$0")" && pwd)"; JEV="$(cd "$HERE/../.." && pwd)"
SCR="${SCRATCH:-/tmp}"
ip() { awk -v h="$1" '$1==h {print $3}' "$HOME/.jev-local/azure_hosts"; }
# 1. cert set on the workbench → data/certd/dev.jsonl (+ tar)
timeout 120 "$JEV/scripts/azvm.sh" train "ss -ltn | grep -q ':8804 ' || (setsid nohup python3 -m http.server 8804 --bind 10.0.0.4 --directory /data/real-out > /tmp/xfer8804.log 2>&1 < /dev/null &); sleep 1; ls /data/real-out/v23-cert/"
if [ -z "${SKIP_IMPORT:-}" ]; then
SUBS=$(timeout 60 "$JEV/scripts/azvm.sh" train "cd /data/real-out/v23-cert && for d in */; do test -f \$d/done.txt && echo -n \"\${d%/} \"; done")
echo "cert parts: $SUBS"
TIMEOUT=1200 "$HERE/node.sh" c09 "set -e; rm -rf data/certraw; mkdir -p data/certraw data/certd logs; for d in $SUBS; do curl -sS --fail -o data/certraw/\$d.jsonl http://10.0.0.4:8804/v23-cert/\$d/dev.jsonl || rm -f data/certraw/\$d.jsonl; done; \
  python3 - <<'PY'
import json, glob
ev = set()
for f in ('data/realev/test.jsonl', 'data/realev3/test.jsonl'):
    ev |= {json.loads(l)['id'] for l in open(f)}
out = []
for f in sorted(glob.glob('data/certraw/*.jsonl')):
    for l in open(f):
        if json.loads(l)['id'] not in ev:
            out.append(l)
open('data/certd/dev.jsonl', 'w').writelines(out)
print('cert rows', len(out))
PY
  tar cf ~/xfer/certd.tar data/certd; ls -la ~/xfer/certd.tar"
fi
for spec in $SPECS; do
  M=${spec%%:*}; rest=${spec#*:}; R0=${rest%%:*}; KIND=${rest##*:}; MQ="$M-q8"; R0IP=$(ip "$R0")
  NODES="$R0 $HELPERS"; set -- $NODES; K=$#
  TIMEOUT=600 "$HERE/node.sh" "$R0" "mkdir -p ~/xfer logs && tar cf ~/xfer/q8c-$M.tar models/$M out/export-$M/genclass-runtime-r17-q8.onnx && \
    (ss -ltn | grep -q ':8807 ' || (setsid nohup python3 -m http.server 8807 --bind $R0IP --directory /home/azureuser/xfer > /tmp/x8807.log 2>&1 < /dev/null &)); \
    test -f data/certd/dev.jsonl || curl -sS --fail http://10.0.0.14:8805/certd.tar | tar x; echo ok"
  i=0
  for n in $NODES; do
    TIMEOUT=900 "$HERE/node.sh" "$n" "mkdir -p logs; test -f data/certd/dev.jsonl || curl -sS --fail http://10.0.0.14:8805/certd.tar | tar x; \
      ([ \"$n\" = \"$R0\" ] || (rm -rf models/$M out/export-$M && curl -sS --fail http://$R0IP:8807/q8c-$M.tar | tar x)) && \
      rm -f out/.oparts-done-$MQ-$i && (setsid nohup bash training/collect_onnx_parts.sh $M out/export-$M/genclass-runtime-r17-q8.onnx $K $i 'certd:dev' \
      > logs/oparts-cert-$M.log 2>&1 < /dev/null &); echo $n started $i" &
    i=$((i + 1))
  done
  wait
  i=0
  for n in $NODES; do
    until TIMEOUT=30 "$HERE/node.sh" "$n" "test -f out/.oparts-done-$MQ-$i" >/dev/null 2>&1; do sleep 15; done; i=$((i + 1))
  done
  IPS=$(for n in $NODES; do ip "$n"; done | tr '\n' ' ')
  cat > "$SCR/cert-$M.sh" <<EOS
set -u
cd ~/gcl-train
export PYTHONPATH=\$HOME/jev:\$HOME/gcl-train/training
PY=\$HOME/jev/.venv/bin/python
M=$M; MQ=$MQ; R=out/records; E=out/export-$M; C=\$E/calibration.json
i=0; for ip in $IPS; do f=\${MQ}__certd__dev.\$i.jsonl; curl -sS --fail -o out/records/parts/\$f http://\$ip:8808/\$f; i=\$((i+1)); done
cat out/records/parts/\${MQ}__certd__dev.*.jsonl > \$R/\${MQ}__certd__dev.jsonl
FIT="--fit sim=data/sim2g/dev.jsonl:\$R/\${MQ}__sim2g__dev.jsonl --fit sim=data/onpbd/dev.jsonl:\$R/\${MQ}__onpbd__dev.jsonl:::gate=shipping --fit sim=data/onpad/dev.jsonl:\$R/\${MQ}__onpad__dev.jsonl:::gate=shipping --fit real=data/realev/test.jsonl:\$R/\${MQ}__realev__test.jsonl:notest:not=inconsistency --fit real=data/realev3/test.jsonl:\$R/\${MQ}__realev3__test.jsonl:notest:only=inconsistency --fit realc=data/real2e/dev.jsonl:\$R/\${MQ}__real2e__dev.jsonl --fit realp=data/certd/dev.jsonl:\$R/\${MQ}__certd__dev.jsonl"
TEST="--test sim=data/onpbe/test.jsonl:\$R/\${MQ}__onpbe__test.jsonl:::gate=shipping --test sim=data/sim2e/test.jsonl:\$R/\${MQ}__sim2e__test.jsonl --test sim=data/sim2f/test.jsonl:\$R/\${MQ}__sim2f__test.jsonl --test sim=data/sim3e/test.jsonl:\$R/\${MQ}__sim3e__test.jsonl --test sim=data/onpae/test.jsonl:\$R/\${MQ}__onpae__test.jsonl:::gate=shipping --test real=data/realev/test.jsonl:\$R/\${MQ}__realev__test.jsonl:test:not=inconsistency --test real=data/realev3/test.jsonl:\$R/\${MQ}__realev3__test.jsonl:test:only=inconsistency --test realc=data/real2e/test.jsonl:\$R/\${MQ}__real2e__test.jsonl"
\$PY training/fit_gates.py --kind $KIND --tau-gain 1.0 --cal \$C \$FIT \$TEST --out out/gates/\$MQ.json --write-meta \$E > logs/gates-cert-\$MQ.log 2>&1
\$PY training/fit_report.py --cal \$C --fit sim=data/sim2g/dev.jsonl:\$R/\${MQ}__sim2g__dev.jsonl --fit simb=data/onpbd/dev.jsonl:\$R/\${MQ}__onpbd__dev.jsonl:::gate=shipping --fit sima=data/onpad/dev.jsonl:\$R/\${MQ}__onpad__dev.jsonl:::gate=shipping \
  --fit real=data/realev/test.jsonl:\$R/\${MQ}__realev__test.jsonl:notest --fit real=data/realev3/test.jsonl:\$R/\${MQ}__realev3__test.jsonl:notest --fit realp=data/certd/dev.jsonl:\$R/\${MQ}__certd__dev.jsonl \
  --test simonpb=data/onpbe/test.jsonl:\$R/\${MQ}__onpbe__test.jsonl:::gate=shipping --test sim2e=data/sim2e/test.jsonl:\$R/\${MQ}__sim2e__test.jsonl --test sim2f=data/sim2f/test.jsonl:\$R/\${MQ}__sim2f__test.jsonl \
  --test sim3e=data/sim3e/test.jsonl:\$R/\${MQ}__sim3e__test.jsonl --test real2e=data/real2e/test.jsonl:\$R/\${MQ}__real2e__test.jsonl \
  --test realev=data/realev/test.jsonl:\$R/\${MQ}__realev__test.jsonl:test --test realev3=data/realev3/test.jsonl:\$R/\${MQ}__realev3__test.jsonl:test \
  --out out/gates/\$MQ-report.json --write-meta \$E > logs/report-cert-\$MQ.log 2>&1
python3 - <<PY
import json
p = "\$E/meta.json"; m = json.load(open(p))
m.setdefault("gate_fit", {})["source"] = ("fitted and verified on outputs of the shipped q8 ONNX file; dev adds REAL's certification set (v23-cert); "
                                         "on-policy rows only from the shipping-gate policy")
open(p, "w").write(json.dumps(m, indent=2) + "\n")
PY
\$PY training/refresh_card.py \$E > logs/card-\$M.log 2>&1
tar cf ~/xfer/export-\$M.tar --exclude=ref -C ~/gcl-train/out export-\$M
touch out/.cert-done-\$M
EOS
  timeout 60 "$JEV/scripts/azvm.sh" "$R0" --put "$SCR/cert-$M.sh" /tmp/cert-$M.sh
  TIMEOUT=1800 "$HERE/node.sh" "$R0" "bash /tmp/cert-$M.sh; python3 training/h2h.py $M" > "$SCR/h2h-cert-$M.json"
  echo "$(date -u +%T) $M done"
done
