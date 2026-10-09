#!/bin/bash
# Mac-side orchestration of distributed SIM generation (ssh via /Users/meharkhanna/jev/scripts/azvm.sh).
# Strictly ONE az call at a time, each wrapped in a timeout (each az process takes ~1 GB on the Mac).
#   orchestrate.sh start  c01 c02 ...                 az vm start, one at a time (waits for each)
#   orchestrate.sh start-nowait c01 c02 ...           az vm start --no-wait, one call at a time (returns fast)
#   orchestrate.sh run    RUN MODE ROWS_PER_NODE c01 c02 ...   start a job on each node (disjoint seed ranges)
#   orchestrate.sh status RUN c01 c02 ...             last progress line per node
#   orchestrate.sh kill   RUN c01 ...                 stop the job (finished parts are kept; resumable)
#   orchestrate.sh stop   c01 c02 ...                 az vm deallocate, one at a time (only nodes no other agent
#                                                     uses; releases SIM's ~/.gcl-claim lock first; FORCE=1 overrides)
# run claims each node first (claim.sh) and skips nodes where another agent's lock or processes are live.
# Seed ranges: node cNN gets BASE(MODE) + NN * 100,000,000 (data = 12); gold 1e9, unlabeled 3e9, onpolicy 5e9
# (situation v1). Situation-v2 runs pass SEED_BASE (gold 11e9, unlabeled 16e9, onpolicy 22e9; checks 19e9) so ranges never
# meet v1 seeds. REFRESH=1 makes nodes re-fetch the bundle (needed after every rebuild).
set -euo pipefail
AZVM=/Users/meharkhanna/jev/scripts/azvm.sh
HERE="$(cd "$(dirname "$0")" && pwd)"
idx() { case "$1" in data) echo 12 ;; c*) echo $((10#${1#c})) ;; *) echo "bad host $1" >&2; exit 2 ;; esac; }
vmname() { case "$1" in data) echo vm-jev-data ;; *) echo "vm-jev-$1" ;; esac; }
cmd="${1:?start|run|status|kill|stop}"; shift
case "$cmd" in
  start) for h in "$@"; do echo "== start $h"; timeout 300 az vm start -g rg-jev-train -n "$(vmname "$h")" -o none || echo "start $h failed"; done ;;
  start-nowait) for h in "$@"; do echo "== start (no wait) $h"; timeout 120 az vm start --no-wait -g rg-jev-train -n "$(vmname "$h")" -o none || echo "start $h failed"; done ;;
  # Claim protocol (lead, 2026-10-08): never deallocate a node another agent is using (lock or processes; FORCE=1
  # overrides); release SIM's lock before deallocating.
  stop) for h in "$@"; do
      out=$(timeout 40 "$AZVM" "$h" "bash -s -- check" < "$HERE/claim.sh" 2>/dev/null) && rc=0 || rc=$?
      if [ "$rc" -eq 3 ] && [ "${FORCE:-0}" != 1 ]; then echo "== $h NOT deallocated: $(echo "$out" | tail -n 1)"; continue; fi
      timeout 40 "$AZVM" "$h" "bash -s -- release" < "$HERE/claim.sh" > /dev/null 2>&1 || true
      echo "== deallocate $h"; timeout 300 az vm deallocate -g rg-jev-train -n "$(vmname "$h")" -o none || echo "deallocate $h failed"
    done ;;
  run)
    RUN="$1"; MODE="$2"; ROWS="$3"; shift 3
    case "$MODE" in gold) BASE=1000000000 ;; unlabeled) BASE=3000000000 ;; onpolicy:*) BASE=5000000000 ;; *) echo "bad mode" >&2; exit 2 ;; esac
    BASE="${SEED_BASE:-$BASE}"
    for h in "$@"; do
      SEED=$((BASE + $(idx "$h") * 100000000))
      echo "== $h: $RUN $MODE seeds from $SEED"
      cl=$(timeout 40 "$AZVM" "$h" "bash -s -- claim $RUN" < "$HERE/claim.sh" 2>/dev/null) && crc=0 || crc=$?
      if [ "$crc" -eq 3 ]; then echo "skipped $h: $(echo "$cl" | tail -n 1)"; continue; fi
      timeout 1200 "$AZVM" "$h" "REFRESH=${REFRESH:-0} GATE=${GATE:-} MAXP=${MAXP:-} bash -s -- $RUN $MODE $SEED $ROWS" < "$HERE/node_start.sh" || echo "run on $h failed"
    done ;;
  status) RUN="$1"; shift; for h in "$@"; do echo "== $h: $(timeout 40 "$AZVM" "$h" "tail -n 1 ~/simgen/out/$RUN.log 2>/dev/null; ls ~/simgen/out/$RUN/parts 2>/dev/null | grep -c '\.json\$'" 2>/dev/null | tr '\n' ' ')"; done ;;
  kill) RUN="$1"; shift; for h in "$@"; do timeout 40 "$AZVM" "$h" "pkill -f 'simgen/sim/dist/gen[.]js.*$RUN' || true"; done ;;
  *) echo "unknown command" >&2; exit 2 ;;
esac
