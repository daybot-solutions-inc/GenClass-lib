#!/bin/bash
# Mac-side driver for the big situation-v2 runs (strictly one az call at a time; every remote call has a timeout).
#   bigrun.sh start NODES...           az vm start --no-wait per node, then wait until each answers ssh
#   bigrun.sh unl   RUN ROWS NODES...  unlabeled job per node (SEED_BASE 16e9 + NN*1e8), refreshes the bundle
#   bigrun.sh gold  RUN ROWS NODES...  gold job per node (SEED_BASE 11e9 + NN*1e8)
#   bigrun.sh onpol RUN GATE ROWS NODES...  on-policy (DAgger) job per node; GATE shipping|explore
#   bigrun.sh wait  RUN NODES...       poll until every node's job printed "parts session done"
#   bigrun.sh ips   NODES...           private IPs (for collect.py on the train VM)
# Collection runs on the train VM: python3 sim/scripts/cluster/collect.py RUN /data/sim-out/RUN <ip> <ip> ...
# Stop nodes with orchestrate.sh stop NODES... as soon as their parts are collected.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AZVM=/Users/meharkhanna/jev/scripts/azvm.sh
cmd="${1:?start|unl|gold|wait|ips}"; shift
case "$cmd" in
  start)
    bash "$HERE/orchestrate.sh" start-nowait "$@"
    for h in "$@"; do
      for i in $(seq 1 40); do
        if timeout 30 "$AZVM" "$h" true > /dev/null 2>&1; then echo "$h up"; break; fi
        sleep 15
      done
    done ;;
  unl) RUN="$1"; ROWS="$2"; shift 2; SEED_BASE=16000000000 REFRESH=1 bash "$HERE/orchestrate.sh" run "$RUN" unlabeled "$ROWS" "$@" ;;
  gold) RUN="$1"; ROWS="$2"; shift 2; SEED_BASE=11000000000 bash "$HERE/orchestrate.sh" run "$RUN" gold "$ROWS" "$@" ;;
  # onpol RUN GATE ROWS NODES...: on-policy with the bundled model (MODEL_NAME, default r17-v2a); seed bases
  # shipping 22e9, explore 24e9 (+ NN*1e8).
  onpol)
    RUN="$1"; G="$2"; ROWS="$3"; shift 3
    case "$G" in shipping) SB=22000000000 ;; explore) SB=24000000000 ;; *) echo "gate: shipping|explore" >&2; exit 2 ;; esac
    SEED_BASE=$SB GATE=$G MAXP="${MAXP:-10}" REFRESH="${REFRESH:-1}" bash "$HERE/orchestrate.sh" run "$RUN" "onpolicy:/home/azureuser/simgen/model/${MODEL_NAME:-r17-v2a}" "$ROWS" "$@" ;;
  wait)
    RUN="$1"; shift
    left=("$@")
    while [ "${#left[@]}" -gt 0 ]; do
      next=()
      for h in "${left[@]}"; do
        l=$(timeout 40 "$AZVM" "$h" "tail -n 1 ~/simgen/out/$RUN.log" 2>/dev/null | tail -n 1 || true)
        case "$l" in *"session done"*) echo "$h: $l" ;; *) next+=("$h") ;; esac
      done
      left=("${next[@]+"${next[@]}"}")
      [ "${#left[@]}" -gt 0 ] && { echo "$(date -u +%H:%M:%S) waiting: ${left[*]}"; sleep 60; }
    done ;;
  ips) for h in "$@"; do timeout 30 "$AZVM" "$h" "hostname -I | awk '{print \$1}'" 2>/dev/null | tail -n 1; done ;;
  *) echo "unknown command" >&2; exit 2 ;;
esac
