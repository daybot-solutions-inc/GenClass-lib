#!/bin/sh
# Build genclass.dev into public/ using a local virtualenv (.venv, gitignored) that has the `markdown` package.
# Usage: ./build.sh            (then: npx --yes wrangler@4 deploy)
set -eu
cd "$(dirname "$0")"
[ -x .venv/bin/python3 ] || python3 -m venv .venv
.venv/bin/python3 -c 'import markdown' 2>/dev/null || .venv/bin/pip install -q markdown==3.7
# Refuse to build a page that pins a runtime version the CDN does not have yet (the live demo would load a 404).
RT=$(sed -n 's/^RT = "\([^"]*\)".*/\1/p' build.py)
code=$(curl -s -o /dev/null -w '%{http_code}' "https://cdn.jsdelivr.net/npm/@genclass/runtime@$RT/package.json" || echo 000)
if [ "$code" != "200" ]; then
  echo "build.py pins @genclass/runtime@$RT but the CDN answers $code for it: publish it first (or fix RT)" >&2
  exit 1
fi
exec .venv/bin/python3 build.py "$@"
