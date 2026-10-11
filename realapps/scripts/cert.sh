#!/bin/bash
# Certification dev set (dev-split scenarios only, no exploration) on a frozen runtime tag. Mac side: ssh/rsync/az only.
#   realapps/scripts/cert.sh TAG "c12:clean:40000000:5000 c13:chaos:50000000:5000 ..." [GO_FILE]
# Each entry is HOST:MODE:SEED0:N (MODE clean|chaos, N accepted dev seeds). One process for all nodes, so az calls
# stay serial. Per node: start, cluster lock protocol (pgrep for other agents' generators/trainers, then the on-node
# lock ~/.gcl-claim/owner; a busy or locked node is skipped), sync + build against TAG. If GO_FILE is given, runs
# start only once it exists (smoke-test first). Each part lands in train:/data/real-out/v23-cert/cert-MODE-HOST/;
# after a verified copy the lock is removed and the node deallocated (unless another agent's job appeared on it).
set -uo pipefail
TAG="$1"; PLAN="$2"; GO="${3:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AZ="${AZVM:-$ROOT/scripts/azvm.sh}"
DEST=/data/real-out/v23-cert
LOG=${CERT_LOG:-/tmp}
BUSY='sim/dist/ge[n]|realapps.*gen[.]js|jev_local[.]train[.]trai[n]'
ok=""
for e in $PLAN; do
  h=${e%%:*}
  timeout 300 az vm start -g rg-jev-train -n vm-jev-$h -o none && echo "$(date -u +%T) $h started"
  until timeout 20 $AZ $h true 2>/dev/null; do sleep 10; done
  claim=$(timeout 60 $AZ $h "if pgrep -f '$BUSY' >/dev/null; then echo BUSY; elif mkdir ~/.gcl-claim 2>/dev/null; then echo \"REAL v23-cert \$(date -u +%FT%TZ)\" > ~/.gcl-claim/owner; echo CLAIMED; else echo \"LOCKED \$(cat ~/.gcl-claim/owner 2>/dev/null)\"; fi")
  echo "$(date -u +%T) $h: $claim"
  if [ "$claim" = CLAIMED ]; then
    ok="$ok $e"
    (TAG=$TAG T=3000 "$ROOT/realapps/scripts/cluster.sh" setup $h > $LOG/rw-cert-setup-$h.log 2>&1 &)
  fi
done
for e in $ok; do h=${e%%:*}; until grep -qE "setup ok|rror" $LOG/rw-cert-setup-$h.log 2>/dev/null; do sleep 15; done; echo "$h: $(tail -1 $LOG/rw-cert-setup-$h.log)"; done
if [ -n "$GO" ]; then echo "$(date -u +%T) waiting for $GO"; until [ -f "$GO" ]; do sleep 10; done; fi
for e in $ok; do
  IFS=: read -r h mode seed n <<< "$e"
  "$ROOT/realapps/scripts/cluster.sh" run $h cert-$mode-$h $seed $n 70 --split dev --cert $mode --max-points 100000 --unlabeled 0 --diag-only 1000 --no-ask
done
left="$ok"
retry=""
while [ -n "$left" ]; do
  next=""
  for e in $left; do
    IFS=: read -r h mode seed n <<< "$e"
    b=cert-$mode-$h
    if timeout 60 $AZ $h "grep -q 'done:' ~/gcl/real-out/$b/gen.log" 2>/dev/null; then
      echo "$(date -u +%T) $h $b: $(timeout 60 $AZ $h "tail -1 ~/gcl/real-out/$b/gen.log")"
      IPN=$(awk -v h=$h '$1==h{print $3}' ~/.jev-local/azure_hosts)
      timeout 1800 $AZ $h "cd ~/gcl/real-out && tar cf /tmp/$b.tar $b && cd /tmp && { setsid nohup python3 -m http.server 8899 </dev/null >/dev/null 2>&1 & echo \$! > /tmp/httpd.pid; }; sleep 2; echo served"
      if timeout 3600 $AZ train "mkdir -p $DEST && cd $DEST && rm -rf $b && curl -sf http://$IPN:8899/$b.tar | tar x && test -f $b/done.txt && grep -q 'done:' $b/gen.log && echo pulled $b: \$(cat $b/*.jsonl | wc -l) rows"; then
        timeout 60 $AZ $h "kill \$(cat /tmp/httpd.pid) 2>/dev/null; rm -f /tmp/httpd.pid /tmp/$b.tar; grep -q '^REAL v23-cert' ~/.gcl-claim/owner 2>/dev/null && rm -rf ~/.gcl-claim; true"
        if timeout 60 $AZ $h "pgrep -f '$BUSY' >/dev/null || test -d ~/.gcl-claim" 2>/dev/null; then
          echo "$(date -u +%T) $h: another agent's job or lock appeared, NOT deallocated"
        else
          if timeout 900 az vm deallocate -g rg-jev-train -n vm-jev-$h -o none; then echo "$(date -u +%T) $h lock released, deallocated"
          else echo "$(date -u +%T) $h DEALLOCATE FAILED (retried at the end)"; retry="$retry $h"; fi
        fi
      else
        echo "$(date -u +%T) $h $b COPY FAILED: node left running, lock kept"
      fi
    else next="$next $e"; fi
  done
  left=$(echo $next)
  [ -n "$left" ] && sleep 60
done
for h in $retry; do
  if timeout 60 $AZ $h "pgrep -f '$BUSY' >/dev/null || test -d ~/.gcl-claim" 2>/dev/null; then echo "$h: claimed by another agent meanwhile, NOT deallocated"; continue; fi
  timeout 900 az vm deallocate -g rg-jev-train -n vm-jev-$h -o none && echo "$(date -u +%T) $h deallocated (retry)" || echo "$h STILL RUNNING: deallocate by hand"
done
echo "$(date -u +%T) ALL DONE"
