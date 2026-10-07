#!/usr/bin/env bash
# Full pipeline on the build VM, from the repo root of a vm.sh slot:
#   scripts/vm.sh run demos 'setsid nohup bash demos/scripts/vm-eval.sh --fast > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
# Arguments are passed to e2e/eval.ts (--fast, --n, --clean, --demos, --modes, --workers, --tag, --no-shots, ...).
#
# Which model the GenClass pages load:
#   (default)                                   the v0.1 GenClass release, downloaded once to ~/gcl/models/genclass-v0.1
#   GENCLASS_MODEL_FROM=<release base url>      download that model directory (runtime CLI) and serve it locally
#   GENCLASS_MODEL_DIR=<dir>                    serve an existing model directory (must contain model.json)
#   GENCLASS_MODEL_URL=<url>|cdn                serve nothing; pages fetch the model from that URL (CORS needed)
#   GENCLASS_MODEL_VARIANT=q8|fp16|all          variants to download (default q8: the VM has no GPU)
# Model directories live outside the synced tree because scripts/vm.sh mirrors the repo with rsync --delete.
set -uo pipefail
cd "$(dirname "$0")/../.."
V01="https://github.com/MeharPro/GenClass/releases/download/v0.1.0/"
MODEL_FROM="${GENCLASS_MODEL_FROM:-$V01}"
if [ "$MODEL_FROM" = "$V01" ]; then default_dir="$HOME/gcl/models/genclass-v0.1"
else default_dir="$HOME/gcl/models/$(printf '%s' "$MODEL_FROM" | sed -E 's#^https?://##; s#[^a-zA-Z0-9._-]+#_#g' | cut -c1-90)"
fi
MODEL_DIR="${GENCLASS_MODEL_DIR:-$default_dir}"
step() { echo "=== $(date +%T) $*"; }

step "npm install"
npm install --no-audit --no-fund || exit 1
step "build @genclass/runtime"
npm run build -w @genclass/runtime || echo "RUNTIME_BUILD_FAILED (demos fall back to the stand-in only if dist is missing)"

EXTRA=()
if [ -n "${GENCLASS_MODEL_URL:-}" ]; then
  step "model: pages load ${GENCLASS_MODEL_URL}"
  EXTRA=(--model "$GENCLASS_MODEL_URL")
else
  step "model: ${MODEL_FROM} -> ${MODEL_DIR}"
  [ -s "$MODEL_DIR/model.json" ] || bash demos/scripts/fetch-model.sh "$MODEL_DIR" "$MODEL_FROM" "${GENCLASS_MODEL_VARIANT:-q8}" || exit 1
fi

cd demos
step "build demos"
npm run build || exit 1
step "typecheck"
npm run typecheck || echo "TYPECHECK_FAILED"
if [ "${SKIP_EVAL:-0}" != "1" ]; then
  step "eval ${EXTRA[*]} $*"
  GENCLASS_MODEL_DIR="$MODEL_DIR" node --experimental-strip-types e2e/eval.ts "${EXTRA[@]}" "$@"
fi
step "done"
