#!/usr/bin/env bash
# Download a GenClass model directory for self-hosting next to the demos (gitignored).
#   bash scripts/fetch-model.sh [dir] [baseUrl] [variant]
# Defaults: public/genclass-model, the v0.1 GenClass release, q8 only (the WASM variant; the VM has no GPU).
# Uses the runtime's CLI (packages/runtime/bin/genclass-runtime.mjs: follows redirects, verifies sha256, writes a
# normalised model.json); falls back to curl, downloading exactly the files the source model.json lists.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${1:-public/genclass-model}"
FROM="${2:-https://github.com/MeharPro/GenClass/releases/download/v0.1.0/}"
case "$FROM" in */) ;; *) FROM="$FROM/" ;; esac
VARIANT="${3:-q8}"
CLI=../packages/runtime/bin/genclass-runtime.mjs
mkdir -p "$DIR"
if [ -f "$CLI" ] && node "$CLI" fetch-model "$DIR" --from "$FROM" --variant "$VARIANT"; then
  node "$CLI" info "$DIR" || true
  exit 0
fi
echo "runtime CLI unavailable or failed; downloading with curl" >&2
curl -fsSL --retry 3 -o "$DIR/model.json" "${FROM}model.json"
FILES=$(node -e '
  const card = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const want = process.argv[2];
  const out = new Set();
  for (const [name, v] of Object.entries(card.variants || {})) if (want === "all" || name === want) out.add(typeof v === "string" ? v : v.file);
  for (const v of Object.values(card.files || {})) out.add(typeof v === "string" ? v : v.file);
  for (const f of card.bundled || []) out.add(f);
  if (!card.files && !card.bundled) ["tokenizer.json", "calibration.json", "meta.json"].forEach((f) => out.add(f));
  console.log([...out].filter(Boolean).join("\n"));
' "$DIR/model.json" "$VARIANT")
for f in $FILES; do
  [ -s "$DIR/$f" ] || curl -fsSL --retry 3 -o "$DIR/$f" "$FROM$f"
done
ls -la "$DIR"
