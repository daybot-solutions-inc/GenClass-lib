#!/bin/bash
# The whole install test on the VM (run from packages/runtime; the Mac never runs this):
#   build + pack -> CLI unit tests -> CDN / auto browser checks -> scaffold real projects -> init/build/browse/remove each.
#   bash test/install/run-all.sh [framework ...]
# Outputs in $INSTALL_OUT (default /data/install): genclass-runtime-<v>.tgz, cdn-results.json, frameworks-results.json.
set -uo pipefail
export INSTALL_OUT="${INSTALL_OUT:-/data/install}" INSTALL_TMP="${INSTALL_TMP:-/data/install/tmp}"
mkdir -p "$INSTALL_OUT" "$INSTALL_TMP"
npm run build > "$INSTALL_OUT/build.log" 2>&1 || { echo "build failed: $INSTALL_OUT/build.log"; exit 1; }
TGZ="$INSTALL_OUT/$(npm pack --silent --pack-destination "$INSTALL_OUT" | tail -1)"
echo "tarball $TGZ ($(du -h "$TGZ" | cut -f1))"
npx vitest run test/install || echo "CLI unit tests failed"
node test/install/cdn-check.mjs || echo "CDN checks failed"
bash test/install/scaffold.sh
TGZ="$TGZ" node test/install/frameworks.mjs "$@"
