#!/bin/bash
# Runs detached ON the train VM: wait until a rank-0 node serves export-MODEL.tar (final_post.sh), then unpack it into
# ~/gcl/train-out/ROUND/SUB/, verify bytes + sha256 against model.json, and run the onnxruntime-web/node check.
#   setsid nohup bash pull_on_train.sh 10.0.0.7 r32-final1 final1 r32 > ~/gcl/train-out/pull-r32.log 2>&1 &
set -u
IP="$1"; M="$2"; ROUND="$3"; SUB="$4"
D=~/gcl/train-out/$ROUND/$SUB
for i in $(seq 1 400); do
  if curl -sf -o /tmp/export-$M.tar "http://$IP:8801/export-$M.tar"; then break; fi
  sleep 30
done
rm -rf "$D" && mkdir -p "$D" && tar xf /tmp/export-$M.tar --strip-components 1 -C "$D" && rm -f /tmp/export-$M.tar
cd "$D" && python3 -c "
import json, hashlib
c = json.load(open('model.json'))
for v in list(c['variants'].values()) + list(c['files'].values()):
    print(v['file'], v['bytes'], 'sha256 ok' if hashlib.sha256(open(v['file'], 'rb').read()).hexdigest() == v['sha256'] else 'SHA MISMATCH')
"
mkdir -p ~/gcl/train-out/ortweb && cd ~/gcl/train-out/ortweb && ln -sfn ~/gcl/model/node_modules node_modules
PATH=$HOME/node/bin:$PATH node validate.mjs "$D" q8 120 > /dev/null 2>&1
python3 -c "
import json
r = json.load(open('$D/ortweb_report_q8.json'))
for x in r['results']:
    print(x.get('backend'), x.get('argmax_agree'), '/', x.get('argmax_total'), 'max|dz|', round(x.get('max_abs_logit', -1), 3),
          'est_ms', x.get('est_ms_at_seq_tokens'), x.get('error', '')[:160])
"
echo DONE
