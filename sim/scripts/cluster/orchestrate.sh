#!/bin/bash
# Mac-side orchestration of distributed SIM generation (ssh via /Users/meharkhanna/jev/scripts/azvm.sh).
# Strictly ONE az call at a time, each wrapped in a timeout (each az process takes ~1 GB on the Mac).
#   orchestrate.sh start  c01 c02 ...                 az vm start, one at a time
#   orchestrate.sh run    RUN MODE ROWS_PER_NODE c01 c02 ...   start a job on each node (disjoint seed ranges)
#   orchestrate.sh status RUN c01 c02 ...             last progress line per node
#   orchestrate.sh kill   RUN c01 ...                 stop the job (finished parts are kept; resumable)
#   orchestrate.sh stop   c01 c02 ...                 az vm deallocate, one at a time
# Seed ranges: node cNN gets BASE(MODE) + NN * 100,000,000 (data = 12); gold 1e9, unlabeled 3e9, onpolicy 5e9.
set -euo pipefail
AZVM=/Users/meharkhanna/jev/scripts/azvm.sh
HERE="$(cd "$(dirname "$0")" && pwd)"
idx() { case "$1" in data) echo 12 ;; c*) echo $((10#${1#c})) ;; *) echo "bad host $1" >&2; exit 2 ;; esac; }
vmname() { case "$1" in data) echo vm-jev-data ;; *) echo "vm-jev-$1" ;; esac; }
cmd="${1:?start|run|status|kill|stop}"; shift
case "$cmd" in
  start) for h in "$@"; do echo "== start $h"; timeout 300 az vm start -g rg-jev-train -n "$(vmname "$h")" -o none || echo "start $h failed"; done ;;
  stop) for h in "$@"; do echo "== deallocate $h"; timeout 300 az vm deallocate -g rg-jev-train -n "$(vmname "$h")" -o none || echo "deallocate $h failed"; done ;;
  run)
    RUN="$1"; MODE="$2"; ROWS="$3"; shift 3
    case "$MODE" in gold) BASE=1000000000 ;; unlabeled) BASE=3000000000 ;; onpolicy:*) BASE=5000000000 ;; *) echo "bad mode" >&2; exit 2 ;; esac
    for h in "$@"; do
      SEED=$((BASE + $(idx "$h") * 100000000))
      echo "== $h: $RUN $MODE seeds from $SEED"
      timeout 1200 "$AZVM" "$h" "bash -s -- $RUN $MODE $SEED $ROWS" < "$HERE/node_start.sh" || echo "run on $h failed"
    done ;;
  status) RUN="$1"; shift; for h in "$@"; do echo "== $h: $(timeout 40 "$AZVM" "$h" "tail -n 1 ~/simgen/out/$RUN.log 2>/dev/null; ls ~/simgen/out/$RUN/parts 2>/dev/null | grep -c '\.json\$'" 2>/dev/null | tr '\n' ' ')"; done ;;
  kill) RUN="$1"; shift; for h in "$@"; do timeout 40 "$AZVM" "$h" "pkill -f 'simgen/sim/dist/gen[.]js.*$RUN' || true"; done ;;
  *) echo "unknown command" >&2; exit 2 ;;
esac
