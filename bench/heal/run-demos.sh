#!/usr/bin/env bash
# Healing benchmark, part 1: the six demos (demos/) under the Playwright trial harness, local only.
#   bench/heal/run-demos.sh <tag> [extra eval.ts args, e.g. --aggr eager --modes guard,heal]
# Needs: packages/runtime built (npx tsup), a local model directory (see README.md), Chromium for Playwright.
# Telemetry is off in every demo mode (demos/src/shared/genclass.ts) and every non-127.0.0.1 request is aborted.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tag="${1:?usage: run-demos.sh <tag> [eval.ts args]}"; shift
model="${GENCLASS_MODEL_DIR:-$root/.cache-model/runtime-model-0.2.0}"
[ -f "$model/model.json" ] || { echo "no model at $model (node packages/runtime/bin/genclass-runtime.mjs fetch-model $model --variant q8 --ort wasm)"; exit 2; }
out="$here/results/demos"
mkdir -p "$out"
(cd "$root/demos" && npm run build >/dev/null)
cd "$root/demos"
node --experimental-strip-types e2e/eval.ts --n "${N:-10}" --clean "${CLEAN:-5}" --workers "${WORKERS:-5}" --no-shots \
  --model-dir "$model" --tag "$tag" --out "$out" "$@" 2>&1 | tee "$out/$tag.log"
