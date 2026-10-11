#!/bin/bash
# Copy a finished export (out/export-MODEL on its rank-0 node, without the fp32 reference) to the train VM
# ~/gcl/train-out/ROUND/SUB/ (outside the agents' synced slots), verify sizes/hashes against model.json, and run the
# onnxruntime-web / onnxruntime-node check there (node_modules borrowed read-only from the MODEL slot via a symlink).
#   training/deliver_final.sh r17-final1 c09 final1 r17
set -euo pipefail
M="${1:?model}"; NODE="${2:?node}"; ROUND="${3:?round dir}"; SUB="${4:?subdir}"
HERE="$(cd "$(dirname "$0")" && pwd)"
JEV="$(cd "$HERE/.." && pwd)"   # repo root (scripts/azvm.sh)
PRIV=$(awk -v h="$NODE" '$1==h {print $3}' "$HOME/.jev-local/azure_hosts")
TIMEOUT=300 "$HERE/node.sh" "$NODE" "mkdir -p ~/xfer && tar cf ~/xfer/export-$M.tar --exclude=ref -C ~/gcl-train/out export-$M && \
  (ss -ltn | grep -q ':8801 ' || (setsid nohup python3 -m http.server 8801 --bind $PRIV --directory /home/azureuser/xfer \
   > /tmp/xfer8801.log 2>&1 < /dev/null &)); sleep 1; ls -la ~/xfer/export-$M.tar"
TIMEOUT=600 "$JEV/scripts/azvm.sh" train "set -e; D=~/gcl/train-out/$ROUND/$SUB; rm -rf \$D && mkdir -p \$D && \
  curl -sS --fail http://$PRIV:8801/export-$M.tar | tar x --strip-components 1 -C \$D && \
  ls -la \$D | head -20 && (cd \$D && python3 -c \"import json,hashlib; c=json.load(open('model.json')); \
[print(v['file'], v['bytes'], hashlib.sha256(open(v['file'],'rb').read()).hexdigest()==v['sha256']) for v in list(c['variants'].values())+list(c['files'].values())]\")"
TIMEOUT=600 "$JEV/scripts/azvm.sh" train "set -e; mkdir -p ~/gcl/train-out/ortweb && cd ~/gcl/train-out/ortweb && \
  ln -sfn ~/gcl/model/node_modules node_modules && cat > validate.mjs" < "$HERE/ortweb/validate.mjs"
TIMEOUT=900 "$JEV/scripts/azvm.sh" train "cd ~/gcl/train-out/ortweb && PATH=\$HOME/node/bin:\$PATH node validate.mjs ~/gcl/train-out/$ROUND/$SUB q8 120 \
  > /dev/null 2>&1; python3 -c \"import json; r=json.load(open('/home/azureuser/gcl/train-out/$ROUND/$SUB/ortweb_report_q8.json')); \
[print(x.get('backend'), x.get('argmax_agree'), '/', x.get('argmax_total'), 'max|dz|', round(x.get('max_abs_logit', -1), 3), \
'est_ms', x.get('est_ms_at_seq_tokens'), x.get('error', '')[:160]) for x in r['results']]\""
