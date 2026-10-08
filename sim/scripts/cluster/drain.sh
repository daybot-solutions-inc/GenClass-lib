#!/bin/bash
# Mac-side: as each node finishes RUN, pull its parts onto the train VM (/data/sim-out/OUT) and deallocate it
# (one az call at a time); when all are done, build the merged shards + manifest from every pulled node.
#   drain.sh RUN OUTNAME host=ip[=gate] ...
# FINAL=N (with host=ip=gate): a node that finishes with fewer than N rows is relaunched on-policy with that gate and
# --rows N (resumable parts: finished parts are kept) instead of being drained.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
AZVM=/Users/meharkhanna/jev/scripts/azvm.sh
RUN="$1"; OUT="$2"; shift 2
left=("$@")
while [ "${#left[@]}" -gt 0 ]; do
  next=()
  for hp in "${left[@]}"; do
    h="${hp%%=*}"; rest="${hp#*=}"; ip="${rest%%=*}"; gate=""; [ "$rest" != "$ip" ] && gate="${rest#*=}"
    l=$(timeout 40 "$AZVM" "$h" "tail -n 1 ~/simgen/out/$RUN.log" 2>/dev/null | tail -n 1 || true)
    rows=$(echo "$l" | sed -n 's/.* \([0-9][0-9]*\) rows in .*/\1/p')
    if [[ "$l" == *"session done"* && -n "${FINAL:-}" && -n "$gate" && -n "$rows" && "$rows" -lt "$FINAL" ]]; then
      echo "$(date -u +%H:%M) $h at $rows rows: relaunching to $FINAL ($gate)"
      REFRESH=0 timeout 600 bash "$HERE/bigrun.sh" onpol "$RUN" "$gate" "$FINAL" "$h" 2>&1 | grep -E "started|already|fail"
      next+=("$hp"); continue
    fi
    case "$l" in
      *"session done"*)
        echo "$(date -u +%H:%M) $h done: $l"
        (cd "$ROOT" && TIMEOUT=1800 scripts/vm.sh exec sim "cd ~/gcl/sim && python3 sim/scripts/cluster/collect.py $RUN /data/sim-out/$OUT $ip 2>&1 | tail -1")
        timeout 400 bash "$HERE/orchestrate.sh" stop "$h"
        echo "$(date -u +%H:%M) $h pulled (deallocation subject to the claim check above)" ;;
      *) next+=("$hp") ;;
    esac
  done
  left=("${next[@]+"${next[@]}"}")
  [ "${#left[@]}" -gt 0 ] && sleep 90
done
cd "$ROOT" && TIMEOUT=3000 scripts/vm.sh exec sim "cd ~/gcl/sim && python3 sim/scripts/cluster/collect.py $RUN /data/sim-out/$OUT --local /data/sim-out/$OUT/raw/* 2>&1 | tail -3 && python3 sim/scripts/onpolicy_report.py /data/sim-out/$OUT --examples 5 --out /data/sim-out/$OUT/onpolicy_report.json > /data/sim-out/$OUT/onpolicy_report.md 2>&1; cat /data/sim-out/$OUT/manifest.json | head -12"
echo "ALL DONE $(date -u +%H:%M)"
