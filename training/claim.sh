#!/bin/bash
# Node claim protocol (coordinator, 09:05): check for other agents' processes, then claim with a lock dir on the node.
#   training/claim.sh claim  NODE JOB     → exit 0 if claimed (or already ours), 1 if another agent holds it
#   training/claim.sh release NODE        → remove our lock (before deallocating)
#   training/claim.sh show NODE
set -u
MODE="$1"; N="$2"; JOB="${3:-}"
JEV="$(cd "$(dirname "$0")/.." && pwd)"   # repo root (scripts/azvm.sh)
case "$MODE" in
  claim)
    timeout 30 "$JEV/scripts/azvm.sh" "$N" "others=\$(pgrep -fa 'sim/dist/ge[n]|realapps.*gen.j[s]' | head -3); \
      if [ -n \"\$others\" ]; then echo \"BUSY: \$others\"; exit 1; fi; \
      if mkdir ~/.gcl-claim 2>/dev/null; then echo \"TRAIN $JOB \$(date -u +%FT%TZ)\" > ~/.gcl-claim/owner; echo claimed; exit 0; fi; \
      o=\$(cat ~/.gcl-claim/owner 2>/dev/null); case \"\$o\" in TRAIN*) echo \"TRAIN $JOB \$(date -u +%FT%TZ)\" > ~/.gcl-claim/owner; echo \"ours (was: \$o)\"; exit 0;; esac; \
      if pgrep -f 'sim/dist/ge[n]|realapps.*gen.j[s]' >/dev/null; then echo \"HELD: \$o\"; exit 1; fi; \
      echo \"TRAIN $JOB \$(date -u +%FT%TZ)\" > ~/.gcl-claim/owner; echo \"taken over stale claim (\$o)\"; exit 0" ;;
  release)
    timeout 30 "$JEV/scripts/azvm.sh" "$N" "o=\$(cat ~/.gcl-claim/owner 2>/dev/null); case \"\$o\" in TRAIN*) rm -rf ~/.gcl-claim; echo released;; *) echo \"not ours: \$o\";; esac" ;;
  show)
    timeout 30 "$JEV/scripts/azvm.sh" "$N" "cat ~/.gcl-claim/owner 2>/dev/null || echo unclaimed" ;;
esac
