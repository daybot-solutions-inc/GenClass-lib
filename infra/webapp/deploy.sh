#!/bin/bash
# Build the demo site from GenClass-lib `runtime` and zip-deploy it to the App Service web app.
# Runs on vm-genclass-ci (never on the Mac). The VM's managed identity has Website Contributor on the web app.
#   bash deploy.sh [webapp-name] [resource-group]
# The demos load the model from the runtime's default public CDN (VITE_GENCLASS_MODEL_URL=cdn ->
# https://cdn.jsdelivr.net/npm/@genclass/runtime-model@<pinned>/files/), not from a copy on this site.
set -euo pipefail
APP="${1:-genclass-demos-9dc31e}"
RG="${2:-rg-genclass-hub}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${DEMOS_SRC:-$HOME/demos-build/GenClass-lib}"
export CI=1 npm_config_fund=false npm_config_audit=false ONNXRUNTIME_NODE_INSTALL=skip

if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q origin runtime && git -C "$SRC" reset -q --hard origin/runtime
else mkdir -p "$(dirname "$SRC")" && git clone -q --branch runtime https://github.com/daybot-solutions-inc/GenClass-lib.git "$SRC"; fi
cd "$SRC"
echo "building demos at $(git rev-parse --short HEAD)"
npm install --no-audit --no-fund --loglevel=error
npm run build -w @genclass/runtime
VITE_GENCLASS_MODEL_URL=cdn npm run build -w @genclass/demos

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r demos/dist "$STAGE/site"
cp "$HERE/server.mjs" "$STAGE/server.mjs"
printf '{ "name": "genclass-demos-site", "private": true, "type": "module", "scripts": { "start": "node server.mjs" } }\n' > "$STAGE/package.json"
(cd "$STAGE" && zip -qr ../site.zip . && mv ../site.zip "$STAGE/site.zip")
ls -lh "$STAGE/site.zip"

az login --identity --output none
az webapp deploy -g "$RG" -n "$APP" --src-path "$STAGE/site.zip" --type zip --restart true --track-status false --output none
echo "deployed: https://$APP.azurewebsites.net/"
