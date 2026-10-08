#!/bin/bash
# Build the self-contained SIM generator bundle on the train VM and serve it to the cluster (private network).
#   bash sim/scripts/cluster/bundle.sh          # from the train VM slot (~/gcl/sim); needs sim/dist and runtime dist built
# Result: ~/xfer-sim/simbundle.tgz (node 22 + runtime dist + sim dist + needed node_modules), served on 10.0.0.4:8810.
set -euo pipefail
SLOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$HOME/xfer-sim"
mkdir -p "$OUT"
cd "$SLOT"
# DIST: the built sim directory to ship as sim/dist (default sim/dist; e.g. sim/out/next while another run uses dist)
DIST="${DIST:-sim/dist}"
test -f "$DIST/gen.js" && test -f "$DIST/model-host/host.js" && test -f packages/runtime/dist/index.js
EX=()
for m in onnxruntime-node playwright-core @playwright typescript happy-dom @rolldown 'lightningcss*' @esbuild esbuild vite vitest @vitest rollup @rollup tsup @types react-dom; do EX+=(--exclude="node_modules/$m"); done
tar czf "$OUT/simbundle.tgz.tmp" "${EX[@]}" --transform "s,^${DIST},sim/dist," node_modules packages/runtime/dist packages/runtime/package.json "$DIST" sim/package.json sim/scripts -C "$HOME" node
mv "$OUT/simbundle.tgz.tmp" "$OUT/simbundle.tgz"
sha256sum "$OUT/simbundle.tgz" | tee "$OUT/simbundle.sha256"
ls -la "$OUT"
if ! ss -ltn | grep -q ':8810 '; then
  (setsid nohup python3 -m http.server 8810 --bind 10.0.0.4 --directory "$OUT" > /tmp/simbundle-serve.log 2>&1 < /dev/null &)
  sleep 1
fi
ss -ltn | grep 8810
