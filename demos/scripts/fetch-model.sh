#!/usr/bin/env bash
# Download a GenClass model directory for self-hosting next to the demos (gitignored).
#   bash scripts/fetch-model.sh [dir] [baseUrl] [variant]
# Defaults: public/genclass-model, the v0.1 GenClass release, q8 only (the WASM variant; the VM has no GPU).
# Uses the runtime's CLI (packages/runtime/bin/genclass-runtime.mjs); falls back to curl.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${1:-public/genclass-model}"
FROM="${2:-https://github.com/MeharPro/GenClass/releases/download/v0.1.0/}"
VARIANT="${3:-q8}"
CLI=../packages/runtime/bin/genclass-runtime.mjs
mkdir -p "$DIR"
if [ -f "$CLI" ] && node "$CLI" fetch-model "$DIR" --from "$FROM" --variant "$VARIANT"; then
  node "$CLI" info "$DIR" || true
  exit 0
fi
echo "runtime CLI unavailable or failed; downloading with curl" >&2
for f in model.json genclass-q8.onnx tokenizer.json calibration.json meta.json; do
  [ -s "$DIR/$f" ] || curl -fsSL --retry 3 -o "$DIR/$f" "$FROM$f"
done
ls -la "$DIR"
