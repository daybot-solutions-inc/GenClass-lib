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
for m in playwright-core @playwright typescript happy-dom @rolldown 'lightningcss*' @esbuild esbuild vite vitest @vitest rollup @rollup tsup @types react-dom; do EX+=(--exclude="node_modules/$m"); done
# onnxruntime-node (on-policy inference): only the linux-x64 binary.
for p in darwin win32 linux/arm64; do EX+=(--exclude="node_modules/onnxruntime-node/bin/napi-v6/$p"); done
# MODEL_DIR: a TRAIN export to ship as model/<MODEL_NAME> (on-policy runs: --on-policy ~/simgen/model/<MODEL_NAME>).
MX=()
if [ -n "${MODEL_DIR:-}" ]; then
  MODEL_NAME="${MODEL_NAME:-$(basename "$MODEL_DIR")}"
  STAGE="$OUT/stage"; rm -rf "$STAGE"; mkdir -p "$STAGE/model/$MODEL_NAME"
  cp "$MODEL_DIR"/{model.json,meta.json,tokenizer.json,calibration.json} "$MODEL_DIR"/*-q8.onnx "$STAGE/model/$MODEL_NAME/"
  MX=(-C "$STAGE" model)
fi
tar czf "$OUT/simbundle.tgz.tmp" "${EX[@]}" --transform "s,^${DIST},sim/dist," node_modules packages/runtime/dist packages/runtime/package.json "$DIST" sim/package.json sim/scripts -C "$HOME" node "${MX[@]}"
mv "$OUT/simbundle.tgz.tmp" "$OUT/simbundle.tgz"
sha256sum "$OUT/simbundle.tgz" | tee "$OUT/simbundle.sha256"
ls -la "$OUT"
if ! ss -ltn | grep -q ':8810 '; then
  (setsid nohup python3 -m http.server 8810 --bind 10.0.0.4 --directory "$OUT" > /tmp/simbundle-serve.log 2>&1 < /dev/null &)
  sleep 1
fi
ss -ltn | grep 8810
