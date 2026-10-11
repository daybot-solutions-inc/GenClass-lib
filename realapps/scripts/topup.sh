#!/bin/bash
# Production top-up on a frozen runtime tag (Mac side; ssh/rsync/az only):
#   realapps/scripts/topup.sh TAG BATCH SEED0 TRAJ_PER_NODE "nodes" "app,list"
#   NODE_APPS="c01=a,b c10=a,b c11=c,d" ... overrides the app list per node, NODE_N="c11=6000" the trajectory count
#   (one process for all nodes => az calls stay serial)
# Starts each node (one az call at a time), syncs + builds against TAG, runs gen.js with the apps, then pulls each
# batch to train:/data/real-out/<BATCH><n>/ and deallocates the node after a verified copy.
set -uo pipefail
TAG="$1"; BATCH="$2"; SEED0="$3"; N="$4"; NODES="$5"; APPS="$6"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AZ="${AZVM:-$ROOT/scripts/azvm.sh}"
i=0
for h in $NODES; do
  timeout 300 az vm start -g rg-jev-train -n vm-jev-$h -o none && echo "$h started"
done
for h in $NODES; do until timeout 20 $AZ $h true 2>/dev/null; do sleep 10; done; done
for h in $NODES; do (TAG=$TAG T=3000 "$ROOT/realapps/scripts/cluster.sh" setup $h > /tmp/rw-setup-$h.log 2>&1 &); done
for h in $NODES; do until grep -qE "setup ok|rror" /tmp/rw-setup-$h.log 2>/dev/null; do sleep 15; done; tail -1 /tmp/rw-setup-$h.log; done
for h in $NODES; do
  i=$((i+1))
  A="$APPS"
  for kv in ${NODE_APPS:-}; do [ "${kv%%=*}" = "$h" ] && A="${kv#*=}"; done
  NN=$N
  for kv in ${NODE_N:-}; do [ "${kv%%=*}" = "$h" ] && NN="${kv#*=}"; done
  "$ROOT/realapps/scripts/cluster.sh" run $h $BATCH$i $((SEED0 + i*1000000)) $NN 70 --test-keep 0.5 --apps "$A"
done
i=0
left=""
for h in $NODES; do i=$((i+1)); left="$left $h:$BATCH$i"; done
while [ -n "$left" ]; do
  next=""
  for e in $left; do
    h=${e%%:*}; b=${e##*:}
    if timeout 60 $AZ $h "grep -q 'done:' ~/gcl/real-out/$b/gen.log" 2>/dev/null; then
      echo "$(date -u +%H:%M) $h $b: $(timeout 60 $AZ $h "tail -1 ~/gcl/real-out/$b/gen.log")"
      IPN=$(awk -v h=$h '$1==h{print $3}' ~/.jev-local/azure_hosts)
      timeout 1800 $AZ $h "cd ~/gcl/real-out && tar cf /tmp/$b.tar $b && cd /tmp && { setsid nohup python3 -m http.server 8899 </dev/null >/dev/null 2>&1 & echo \$! > /tmp/httpd.pid; }; sleep 2; echo served"
      if timeout 3600 $AZ train "cd /data/real-out && rm -rf $b && curl -sf http://$IPN:8899/$b.tar | tar x && test -f $b/done.txt && echo pulled $b: \$(cat $b/*.jsonl | wc -l) lines"; then
        timeout 60 $AZ $h "kill \$(cat /tmp/httpd.pid) 2>/dev/null; rm -f /tmp/httpd.pid /tmp/$b.tar; true"
        timeout 300 az vm deallocate -g rg-jev-train -n vm-jev-$h -o none && echo "$(date -u +%H:%M) $h deallocated"
      else
        echo "$h $b COPY FAILED: node left running"
      fi
    else next="$next $e"; fi
  done
  left=$(echo $next)
  [ -n "$left" ] && sleep 120
done
echo ALL DONE
