#!/usr/bin/env bash
# Put this checkout's packages/runtime/dist into Troy's installed @genclass/runtime (or restore the original), then
# rebuild Troy. Only node_modules and .next change; Troy's tracked files are untouched.
#   bench/heal/troy/swap-runtime.sh use|restore
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../../.." && pwd)"
troy="${TROY_DIR:-$HOME/troy-bot-genclass}"
pkg="$(cd "$troy/apps/web/node_modules/@genclass/runtime" && pwd -P)"
case "${1:-}" in
  use)
    [ -d "$pkg/dist.orig" ] || mv "$pkg/dist" "$pkg/dist.orig"
    rm -rf "$pkg/dist"; cp -R "$root/packages/runtime/dist" "$pkg/dist" ;;
  restore)
    [ -d "$pkg/dist.orig" ] && { rm -rf "$pkg/dist"; mv "$pkg/dist.orig" "$pkg/dist"; } ;;
  *) echo "usage: swap-runtime.sh use|restore"; exit 2 ;;
esac
(cd "$troy" && NEXT_PUBLIC_GENCLASS_DEBUG=1 pnpm --filter web build >/dev/null)
echo "troy rebuilt with $( [ "$1" = use ] && echo "the runtime from $root" || echo "its original runtime" )"
