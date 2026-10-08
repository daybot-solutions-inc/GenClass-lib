#!/bin/bash
# Scaffold fresh projects with each framework's own generator (non-interactive), dependencies installed, under
# $SCAFFOLDS (default /data/install/scaffolds). Existing scaffolds are kept (delete a directory to regenerate it).
# A failure is recorded in $SCAFFOLDS/<name>.status and the others continue.
#
#   bash test/install/scaffold.sh [name ...]      # default: all
set -uo pipefail
SCAFFOLDS="${SCAFFOLDS:-/data/install/scaffolds}"
mkdir -p "$SCAFFOLDS"
cd "$SCAFFOLDS" || exit 2
export CI=1 npm_config_yes=true npm_config_fund=false npm_config_audit=false NEXT_TELEMETRY_DISABLED=1 ASTRO_TELEMETRY_DISABLED=1 NG_CLI_ANALYTICS=false

# pnpm without changing the machine: pnpm 10 installed under $SCAFFOLDS/.pnpm, on PATH for these tests only
SHIM="$SCAFFOLDS/.bin"; mkdir -p "$SHIM"
[ -x "$SCAFFOLDS/.pnpm/node_modules/.bin/pnpm" ] || npm install --silent --prefix "$SCAFFOLDS/.pnpm" pnpm@10 >/dev/null 2>&1
ln -sf "$SCAFFOLDS/.pnpm/node_modules/.bin/pnpm" "$SHIM/pnpm"
export PATH="$SHIM:$PATH"

ALL=(vite-react-ts vite-react-pnpm vite-vue vite-svelte-ts next-app next-pages-js cra sveltekit astro nuxt react-router angular plain-html)
NAMES=("$@")
[ ${#NAMES[@]} -eq 0 ] && NAMES=("${ALL[@]}")

scaffold() {
  local name="$1"
  case "$name" in
    vite-react-ts) npx --yes create-vite@latest "$name" --template react-ts --no-interactive --no-immediate && (cd "$name" && npm install) ;;
    vite-react-pnpm) npx --yes create-vite@latest "$name" --template react-ts --no-interactive --no-immediate && (cd "$name" && pnpm install) ;;
    vite-vue) npx --yes create-vite@latest "$name" --template vue --no-interactive --no-immediate && (cd "$name" && npm install) ;;
    vite-svelte-ts) npx --yes create-vite@latest "$name" --template svelte-ts --no-interactive --no-immediate && (cd "$name" && npm install) ;;
    next-app) npx --yes create-next-app@latest "$name" --yes --ts --app --eslint --tailwind --use-npm --disable-git ;;
    next-pages-js) npx --yes create-next-app@latest "$name" --yes --js --no-app --no-tailwind --no-eslint --no-src-dir --use-npm --disable-git ;;
    cra) npx --yes create-react-app@latest "$name" ;;
    sveltekit) npx --yes sv@latest create "$name" --template minimal --types ts --no-add-ons --install npm ;;
    astro) npm create --yes astro@latest -- "$name" --template minimal --install --no-git --skip-houston --yes ;;
    nuxt) npx --yes nuxi@latest init "$name" --template minimal --packageManager npm --gitInit=false --force --no-modules || npx --yes nuxi@latest init "$name" --packageManager npm --gitInit=false --force ;;
    react-router) npx --yes create-react-router@latest "$name" --yes --no-git-init --install ;;
    # the latest CLI may need a newer Node than the VM's; Angular 20 runs on Node 20.19+/22.12+
    angular) npx --yes @angular/cli@latest new "$name" --defaults --skip-git --ssr=false --package-manager npm || { rm -rf "$name"; npx --yes @angular/cli@20 new "$name" --defaults --skip-git --ssr=false --package-manager npm; } ;;
    plain-html)
      mkdir -p "$name" && cat > "$name/index.html" <<'H'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Plain page</title>
    <script src="app.js" defer></script>
  </head>
  <body>
    <input aria-label="Search" id="q"><ul id="out"></ul>
  </body>
</html>
H
      cat > "$name/about.html" <<'H'
<!doctype html><html><head><meta charset="utf-8"><title>About</title></head><body><p>About</p></body></html>
H
      cat > "$name/app.js" <<'J'
document.getElementById("q").addEventListener("input", async (e) => {
  const r = await fetch("data:application/json," + encodeURIComponent(JSON.stringify([e.target.value + "-1"])));
  document.getElementById("out").textContent = (await r.json()).join(",");
});
J
      ;;
    *) echo "unknown scaffold $name"; return 2 ;;
  esac
}

for name in "${NAMES[@]}"; do
  if [ -f "$name.status" ] && grep -q '^ok' "$name.status" && [ -d "$name" ]; then echo "keep $name"; continue; fi
  rm -rf "$name"
  start=$(date +%s)
  echo "=== scaffold $name"
  if scaffold "$name" > "$name.log" 2>&1 && [ -d "$name" ]; then
    echo "ok $(( $(date +%s) - start ))s $(cd "$name" && node -e 'const p=require("./package.json");const d={...p.dependencies,...p.devDependencies};console.log(["next","vite","react-scripts","@sveltejs/kit","astro","nuxt","@angular/core","react-router","react","vue","svelte"].filter(k=>d[k]).map(k=>k+"@"+d[k]).join(" "))' 2>/dev/null)" > "$name.status"
  else
    echo "failed $(( $(date +%s) - start ))s: $(tail -3 "$name.log" | tr '\n' ' ')" > "$name.status"
  fi
  cat "$name.status"
done
