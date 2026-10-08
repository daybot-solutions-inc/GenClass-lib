#!/bin/bash
# Prepare the open-source app corpus on a VM (never on the Mac): clone each app at its pinned commit into
# $RW_OSS_DIR (default ~/gcl/real-cache/oss/<name>), install its production dependencies, apply the GenClass
# integration patch (patch_oss.py), and build Vite apps into realapps/dist/apps/<name>/ (esbuild apps are built by
# build.mjs). Idempotent; run from realapps/:  bash corpus/prepare_oss.sh [name ...]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RA="$(cd "$HERE/.." && pwd)"
OSS="${RW_OSS_DIR:-$HOME/gcl/real-cache/oss}"
mkdir -p "$OSS"
export PATH="$HOME/node/bin:$PATH"
names=("$@")
python3 - "$HERE/oss.json" > /tmp/rw_oss_list.$$ <<'PY'
import json, sys
for a in json.load(open(sys.argv[1])):
    print(a["name"], a["repo"], a["commit"], a["build"], a["deps"])
PY
while read -r name repo commit build deps; do
  if [ ${#names[@]} -gt 0 ] && [[ ! " ${names[*]} " =~ " ${name} " ]]; then continue; fi
  d="$OSS/$name"
  echo "== $name ($repo@${commit:0:8})"
  if [ ! -d "$d/.git" ]; then
    rm -rf "$d"
    timeout 300 git clone -q "https://github.com/$repo" "$d"
  fi
  git -C "$d" checkout -q -f "$commit"
  git -C "$d" clean -q -fd -e node_modules
  if [ ! -d "$d/node_modules" ]; then
    (cd "$d" && rm -f package-lock.json && timeout 900 npm install --omit=dev --ignore-scripts --no-audit --no-fund --legacy-peer-deps --loglevel=error >/dev/null)
  fi
  case "$build" in
    vite-vue) [ -d "$d/node_modules/@vitejs/plugin-vue" ] || (cd "$d" && timeout 600 npm install --no-save --ignore-scripts --no-audit --no-fund --legacy-peer-deps --loglevel=error vite@6 @vitejs/plugin-vue@5 >/dev/null) ;;
    vite-solid) [ -d "$d/node_modules/vite-plugin-solid" ] || (cd "$d" && timeout 600 npm install --no-save --ignore-scripts --no-audit --no-fund --legacy-peer-deps --loglevel=error vite@6 vite-plugin-solid@2 >/dev/null) ;;
  esac
  python3 "$HERE/patch_oss.py" "$name" "$d"
  if [[ "$build" == vite-* ]]; then
    out="$RA/dist/apps/$name"
    (cd "$d" && RW_SRC="$d" RW_OUT="$out" RW_RT="$RA/../packages/runtime/src" RW_SHARED="$RA/apps/_shared/genclass.ts" RW_KIND="$build" \
      timeout 600 node "$d/node_modules/vite/bin/vite.js" build --config "$HERE/vite.oss.config.mjs")
    ls -la "$out" | head -5
  fi
done < /tmp/rw_oss_list.$$
rm -f /tmp/rw_oss_list.$$
