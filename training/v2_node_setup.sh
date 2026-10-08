#!/bin/bash
# Prepare one node for v2 training: wait for ssh, sync code (training/ + jev_local), pull the v2 data tar from the
# workbench (WB, default c02) unless already present.   training/v2_node_setup.sh c05 [TAR=v2_sim2.tar]
set -u
N="$1"; TAR="${TAR:-v2_sim2.tar}"; WB="${WB:-c02}"
HERE="$(cd "$(dirname "$0")" && pwd)"; JEV="$(cd "$HERE/../.." && pwd)"
WBIP=$(awk -v h="$WB" '$1==h {print $3}' "$HOME/.jev-local/azure_hosts")
for i in $(seq 1 30); do timeout 20 "$JEV/scripts/azvm.sh" "$N" true >/dev/null 2>&1 && break; sleep 10; done
TIMEOUT=300 "$HERE/node.sh" "$N" sync >/dev/null 2>&1 || echo "$N training sync failed"
timeout 300 "$JEV/scripts/azvm.sh" "$N" --sync >/dev/null 2>&1 || echo "$N jev sync failed"
TIMEOUT=1200 "$HERE/node.sh" "$N" "test -f data/.have-$TAR || (curl -sS --fail http://$WBIP:8799/$TAR | tar x && touch data/.have-$TAR); \
  ls data/s3 | tr '\n' ' '; ls data/s3/sim2 | wc -l"
