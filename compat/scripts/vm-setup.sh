#!/bin/bash
# One-time setup on a Linux machine (the Azure train VM), from the repository root:
#   scripts/vm.sh run compat 'bash compat/scripts/vm-setup.sh'
# Node >= 22.22.3 (Angular 22's minimum; we use 24 LTS), the root workspace (runtime build tools), the compat
# harness (Playwright + Chromium) and a local copy of the runtime's default model (@genclass/runtime-model@0.2.0,
# q8 + ONNX Runtime wasm), which the runner serves in place of jsDelivr.
set -uo pipefail
LOGS=${COMPAT_LOGS:-/data/compat/logs}
MODEL_DIR=${COMPAT_MODEL_DIR:-/data/compat/model/runtime-model-0.2.0}
mkdir -p "$LOGS"
node -v
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund > "$LOGS/npm-ci.log" 2>&1; echo "root npm ci: $?"
(cd compat && npm install --no-audit --no-fund --loglevel=error > "$LOGS/compat-install.log" 2>&1; echo "compat install: $?"; npx playwright install chromium > "$LOGS/playwright.log" 2>&1; echo "chromium: $?")
(cd packages/runtime && npx tsup > "$LOGS/runtime-build.log" 2>&1); echo "runtime build: $?"
if [ ! -f "$MODEL_DIR/model.json" ]; then
  node packages/runtime/bin/genclass-runtime.mjs fetch-model "$MODEL_DIR" --variant q8 --ort wasm 2>&1 | tail -5
fi
ls "$MODEL_DIR" "$MODEL_DIR/ort" 2>&1 | head -20
