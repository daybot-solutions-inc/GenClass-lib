#!/bin/bash
# Set up a fresh VM for realapps generation (runs ON the VM, idempotent): node 22, npm deps, Playwright's
# headless Chromium (+ system libraries), the open-source app corpus, and every bundle.
#   bash ~/gcl/real/realapps/scripts/node_setup.sh
set -euo pipefail
NODE_V=v22.22.0
if [ ! -x "$HOME/node/bin/node" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-x64.tar.xz" | tar -xJ -C "$HOME"
  rm -rf "$HOME/node" && mv "$HOME/node-$NODE_V-linux-x64" "$HOME/node"
fi
export PATH="$HOME/node/bin:$PATH"
cd "$HOME/gcl/real/realapps"
npm install --no-audit --no-fund --ignore-scripts --loglevel=error
if ! ls "$HOME/.cache/ms-playwright" 2>/dev/null | grep -q chromium_headless_shell; then
  npx playwright install --only-shell chromium
fi
# system libraries Chromium needs (no-op when present)
if ! ldd "$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-*/headless_shell | head -1)" 2>/dev/null | grep -q "not found"; then :; else
  sudo -n env PATH="$PATH" npx playwright install-deps chromium >/dev/null
fi
bash corpus/prepare_oss.sh
node build.mjs | tail -3
echo "setup ok on $(hostname): $(nproc) vCPU, $(free -g | awk '/Mem/ {print $2}') GB"
