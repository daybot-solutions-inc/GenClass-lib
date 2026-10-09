#!/bin/bash
# Nightly GenClass CI, unprivileged part (runs as azureuser on vm-genclass-ci; called by nightly.sh).
# Tests the PUBLISHED npm packages, not the repo's source:
#   1. clone/pull GenClass-lib `runtime` (for the e2e harness and its static server)
#   2. npm pack @genclass/runtime@latest @genclass/runtime-model@latest
#   3. packages/runtime-model/scripts/e2e.mjs: fresh Vite app + both tarballs + headless Chromium (observe/guard)
#   4. infra/ci/smoke-published.sh: the npm smoke test (fresh Vite app, devtools, Chromium) on the published tarball
#   5. infra/ci/summarize.mjs -> $OUT/ci-result.json
# Usage: run-tests.sh <out-dir>
set -uo pipefail
OUT="${1:?out dir}"
REPO="${GENCLASS_REPO_DIR:-/var/lib/genclass-ci/GenClass-lib}"
BRANCH="${GENCLASS_BRANCH:-runtime}"
CI_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT/pkgs"
exec > >(tee -a "$OUT/run.log") 2>&1
export CI=1 npm_config_fund=false npm_config_audit=false ONNXRUNTIME_NODE_INSTALL=skip
T0=$(date +%s)
echo "== $(date -u +%FT%TZ) GenClass nightly CI on $(hostname)"

if [ -d "$REPO/.git" ]; then
  git -C "$REPO" fetch --quiet origin "$BRANCH" && git -C "$REPO" reset --quiet --hard "origin/$BRANCH" && git -C "$REPO" clean -fdq -e node_modules
else
  git clone --quiet --branch "$BRANCH" https://github.com/daybot-solutions-inc/GenClass-lib.git "$REPO"
fi
COMMIT=$(git -C "$REPO" rev-parse --short HEAD)
echo "repo $BRANCH @ $COMMIT"

# Harness deps only (@playwright/test for e2e.mjs). The lockfile install is the reproducible path.
( cd "$REPO" && npm ci --no-audit --no-fund --loglevel=error ) || { echo "npm ci failed"; NPM_FAIL=1; }

( cd "$OUT/pkgs" && rm -f ./*.tgz && npm pack --silent @genclass/runtime@latest @genclass/runtime-model@latest ) > "$OUT/pkgs/pack.txt" || echo "npm pack failed"
RUNTIME_TGZ=$(ls "$OUT"/pkgs/genclass-runtime-[0-9]*.tgz 2>/dev/null | head -1)
MODEL_TGZ=$(ls "$OUT"/pkgs/genclass-runtime-model-*.tgz 2>/dev/null | head -1)
echo "runtime $RUNTIME_TGZ"; echo "model   $MODEL_TGZ"

E2E_RC=99
if [ -n "$RUNTIME_TGZ" ] && [ -n "$MODEL_TGZ" ] && [ -z "${NPM_FAIL:-}" ]; then
  ( cd "$REPO/packages/runtime-model" && RUNTIME_TGZ="$RUNTIME_TGZ" MODEL_TGZ="$MODEL_TGZ" WORK="$OUT/e2e" INSTALL_OUT="$OUT" \
      TRIALS="${TRIALS:-6}" timeout 3000 node scripts/e2e.mjs ) > "$OUT/e2e.log" 2>&1
  E2E_RC=$?
fi
echo "e2e exit $E2E_RC"; tail -40 "$OUT/e2e.log" 2>/dev/null

SMOKE_RC=99
if [ -n "$RUNTIME_TGZ" ]; then
  timeout 1200 bash "$CI_DIR/smoke-published.sh" "$RUNTIME_TGZ" > "$OUT/smoke.log" 2>&1
  SMOKE_RC=$?
fi
echo "smoke exit $SMOKE_RC"; tail -5 "$OUT/smoke.log"

rm -rf "$OUT/e2e/app/node_modules"   # keep the built app + results, drop ~300 MB of deps
node "$CI_DIR/summarize.mjs" --out "$OUT" --commit "$COMMIT" --e2e-rc "$E2E_RC" --smoke-rc "$SMOKE_RC" \
  --runtime-tgz "$RUNTIME_TGZ" --model-tgz "$MODEL_TGZ" --seconds "$(( $(date +%s) - T0 ))"
