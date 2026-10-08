#!/bin/bash
# Prepare the open-source app corpus on a VM (never on the Mac): clone each app at its pinned commit into
# $RW_OSS_DIR (default ~/gcl/real-cache/oss/<name>), install its production dependencies (plus the build toolchain
# its `build` kind needs), apply the GenClass integration patch (patch_oss.py), and build into
# realapps/dist/apps/<name>/ (index.html + bundle.js). Build kinds (oss.json "build"):
#   esbuild        built later by build.mjs from the manifest's entry
#   vite-*         Vite with corpus/vite.oss.config.mjs (vue, vue2, solid, svelte3, rescript after `rescript build`)
#   angular, elm, ember, purescript   the app's own compiler (ng build, elm make, ember build, spago build), then
#                  corpus/rebundle.mjs re-bundles its output into one bundle (dynamic imports inlined)
#   webcomponents  esbuild via corpus/rebundle.mjs with the app's own index.html
#   angularjs      corpus/build_angularjs.mjs (the app's gulpfile steps without gulp 3)
# Idempotent; run from realapps/:  bash corpus/prepare_oss.sh [name ...]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RA="$(cd "$HERE/.." && pwd)"
OSS="${RW_OSS_DIR:-$HOME/gcl/real-cache/oss}"
mkdir -p "$OSS"
# the physical path: Vite's HTML plugin breaks when the project root is reached through a symlink
# (~/gcl/real-cache -> /data/real-cache on the train VM)
OSS="$(cd "$OSS" && pwd -P)"
export PATH="$HOME/node/bin:$PATH"
names=("$@")
# "name@range" of the app's own devDependencies (its build toolchain), read from its package.json
devdeps() { python3 -c 'import json,sys; dd=json.load(open(sys.argv[1])).get("devDependencies",{}); print(" ".join(k+"@"+dd[k] for k in sys.argv[2:]))' "$d/package.json" "$@"; }
npm_add() { (cd "$d" && timeout 900 npm install --no-save --ignore-scripts --no-audit --no-fund --legacy-peer-deps --loglevel=error "$@" >/dev/null); }
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
  python3 "$HERE/patch_oss.py" --preinstall "$name" "$d"
  if [ -f "$d/package.json" ] && [ ! -d "$d/node_modules" ]; then
    (cd "$d" && rm -f package-lock.json && timeout 900 npm install --omit=dev --ignore-scripts --no-audit --no-fund --legacy-peer-deps --loglevel=error >/dev/null)
  fi
  case "$build" in
    vite-vue) [ -d "$d/node_modules/@vitejs/plugin-vue" ] || (cd "$d" && timeout 600 npm install --no-save --ignore-scripts --no-audit --no-fund --legacy-peer-deps --loglevel=error vite@6 @vitejs/plugin-vue@5 >/dev/null) ;;
    vite-solid) [ -d "$d/node_modules/vite-plugin-solid" ] || (cd "$d" && timeout 600 npm install --no-save --ignore-scripts --no-audit --no-fund --legacy-peer-deps --loglevel=error vite@6 vite-plugin-solid@2 >/dev/null) ;;
    vite-vue2) [ -d "$d/node_modules/@vitejs/plugin-vue2" ] || (cd "$d" && timeout 600 npm install --no-save --ignore-scripts --no-audit --no-fund --legacy-peer-deps --loglevel=error vite@7 @vitejs/plugin-vue2@2 >/dev/null) ;;
    vite-rescript) [ -x "$d/node_modules/.bin/rescript" ] || npm_add $(devdeps rescript) vite@6 ;;
    vite-svelte3) [ -d "$d/node_modules/@sveltejs/vite-plugin-svelte" ] || npm_add $(devdeps svelte) vite@4 @sveltejs/vite-plugin-svelte@2 ;;
    # AngularJS: the 1.5 line the code targets (package.json "^1.5.0-rc.2"); 1.6+ dropped pre-assigned component
    # bindings, which the app's controllers read in their constructors
    angularjs) grep -q '"version": "1.5.11"' "$d/node_modules/angular/package.json" || npm_add angular@1.5.11 ;;
    # webpack 4 (the app's bundler) polyfilled Node builtins with node-libs-browser; markdown-js requires "util"
    webcomponents) [ -d "$d/node_modules/util" ] || npm_add util@0.11 ;;
    # Ember: the whole toolchain is in devDependencies
    ember) [ -d "$d/node_modules/ember-cli" ] || (cd "$d" && timeout 1500 npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps --loglevel=error >/dev/null) ;;
    angular) [ -d "$d/node_modules/@angular/build" ] || npm_add $(devdeps @angular/build @angular/cli @angular/compiler-cli typescript) ;;
  esac
  python3 "$HERE/patch_oss.py" "$name" "$d"
  if [[ "$build" == vite-rescript ]]; then
    # ReScript sources -> in-source .bs.js ES modules (the app's own compiler), then the Vite build below
    (cd "$d" && timeout 600 ./node_modules/.bin/rescript build >/tmp/rw_oss_res.$$ 2>&1) || { tail -40 /tmp/rw_oss_res.$$; exit 1; }
    rm -f /tmp/rw_oss_res.$$
  fi
  if [[ "$build" == vite-* ]]; then
    out="$RA/dist/apps/$name"
    (cd "$d" && RW_SRC="$d" RW_OUT="$out" RW_RT="${RW_RUNTIME_SRC:-$RA/../packages/runtime/src}" RW_SHARED="$RA/apps/_shared/genclass.ts" RW_KIND="$build" \
      timeout 600 node "$d/node_modules/vite/bin/vite.js" build --config "$HERE/vite.oss.config.mjs")
    ls -la "$out" | head -5
  fi
  # apps built by their own toolchain, then re-bundled into one module (corpus/rebundle.mjs)
  out="$RA/dist/apps/$name"
  log="/tmp/rw_oss_build.$$"
  case "$build" in
    angular)
      (cd "$d" && NG_CLI_ANALYTICS=false timeout 900 node node_modules/@angular/cli/bin/ng.js build --output-hashing=none >"$log" 2>&1) || { tail -40 "$log"; exit 1; }
      node "$HERE/rebundle.mjs" "$(ls -d "$d"/dist/*/browser | head -1)" main.js "$out" ;;
    elm)
      # the official Elm 0.19.1 compiler binary (what the `elm` npm package installs), kept next to the clones
      ELM="$OSS/../bin/elm"
      if [ ! -x "$ELM" ]; then
        mkdir -p "$(dirname "$ELM")"
        timeout 300 curl -fsSL https://github.com/elm/compiler/releases/download/0.19.1/binary-for-linux-64-bit.gz | gunzip > "$ELM.tmp"
        chmod +x "$ELM.tmp" && mv "$ELM.tmp" "$ELM"
      fi
      (cd "$d" && timeout 900 "$ELM" make src/Main.elm --optimize --output=elm.js >"$log" 2>&1) || { tail -40 "$log"; exit 1; }
      node "$HERE/rebundle.mjs" "$d" rw-main.js "$out" "$d/index.html" ;;
    webcomponents)
      # plain ES modules (webpack + babel-loader in the repo); esbuild bundles them with the app's own page, whose
      # body holds the layout elements (<c-nav>, <router-outlet>, <c-footer>)
      node "$HERE/rebundle.mjs" "$d" app/index.js "$out" "$d/app/index.html" ;;
    ember)
      # ember-cli 3.24 on current Node: no worker pool (JOBS=1; its workerpool predates Node 22's IPC API) and the
      # legacy OpenSSL provider for webpack 4's md4 hashes (ember-auto-import)
      (cd "$d" && NODE_OPTIONS=--openssl-legacy-provider JOBS=1 timeout 1200 node node_modules/ember-cli/bin/ember build --environment=production >"$log" 2>&1) || { tail -40 "$log"; exit 1; }
      node "$HERE/rebundle.mjs" --scripts "$d/dist" "$out" ;;
    purescript)
      # the app's toolchain (its nix flake pins purs + spago-unstable): purs 0.15.15 (official release binary) and
      # spago 0.93 (npm), kept next to the clones; `spago build` compiles to output/, the app's index.js imports Main
      PURS_DIR="$OSS/../bin/purs-0.15.15"
      SPAGO_DIR="$OSS/../bin/spago"
      if [ ! -x "$PURS_DIR/purescript/purs" ]; then
        mkdir -p "$PURS_DIR"
        timeout 300 curl -fsSL https://github.com/purescript/purescript/releases/download/v0.15.15/linux64.tar.gz | tar xz -C "$PURS_DIR"
      fi
      [ -d "$SPAGO_DIR/node_modules/spago" ] || (mkdir -p "$SPAGO_DIR" && cd "$SPAGO_DIR" && timeout 600 npm install --no-audit --no-fund --loglevel=error spago@0.93 >/dev/null)
      (cd "$d" && PATH="$PURS_DIR/purescript:$SPAGO_DIR/node_modules/.bin:$PATH" timeout 1500 spago build >"$log" 2>&1) || { tail -40 "$log"; exit 1; }
      node "$HERE/rebundle.mjs" "$d" index.js "$out" "$d/dist/index.html" ;;
    angularjs)
      # the app's gulpfile (templatecache + babelify es2015 + ng-annotate) re-run without gulp 3; esbuild bundles
      node "$HERE/build_angularjs.mjs" "$d" "$out" ;;
  esac
  rm -f "$log"
done < /tmp/rw_oss_list.$$
rm -f /tmp/rw_oss_list.$$
