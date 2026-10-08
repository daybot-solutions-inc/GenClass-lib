#!/bin/bash
# After v2_post.sh (eval + export): data-derived gates → out/export-M/meta.json, re-tar the export for delivery.
#   bash training/gates_post.sh r17-v2b        (fetches the SIM dev gate set from GATESRC if missing)
set -u
cd ~/gcl-train
M="$1"; GATESRC="${GATESRC:-http://10.0.0.14:8805/sim2g.tar}"
until test -f out/.post-done-$M; do sleep 30; done
test -f data/sim2g/dev.jsonl || (curl -sS --fail "$GATESRC" | tar x)
GATE_THREADS=5 bash training/collect_gate_set.sh "$M" > logs/gate-collect-$M.log 2>&1
bash training/gates_for.sh "$M" --write > logs/gates-$M.log 2>&1
mkdir -p ~/xfer && tar cf ~/xfer/export-$M.tar --exclude=ref -C ~/gcl-train/out export-$M
touch out/.gates-done-$M
