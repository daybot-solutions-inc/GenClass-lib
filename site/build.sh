#!/bin/sh
# Build genclass.dev into public/ using a local virtualenv (.venv, gitignored) that has the `markdown` package.
# Usage: ./build.sh            (then: npx --yes wrangler@4 deploy)
set -eu
cd "$(dirname "$0")"
[ -x .venv/bin/python3 ] || python3 -m venv .venv
.venv/bin/python3 -c 'import markdown' 2>/dev/null || .venv/bin/pip install -q markdown==3.7
exec .venv/bin/python3 build.py "$@"
