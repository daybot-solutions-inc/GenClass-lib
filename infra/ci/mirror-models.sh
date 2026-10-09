#!/bin/bash
# Mirror every published version of @genclass/runtime-model (and the @genclass/runtime tarballs) into the storage
# account's public `models` container. Idempotent: versions already mirrored are skipped. Run by nightly.sh (root,
# after `az login --identity`), so new releases are mirrored the night they are published.
#   models/npm/<package>/<version>.tgz                 the exact npm tarballs (archive)
#   models/runtime-model/<version>/files/<file>        unpacked model files, usable as  GenClass.init({ model: { baseUrl } })
#     https://<account>.blob.core.windows.net/models/runtime-model/<version>/files/
# Usage: mirror-models.sh <storage-account>
set -euo pipefail
ACC="${1:?storage account}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
exists() { az storage blob exists --auth-mode login --account-name "$ACC" -c models -n "$1" --query exists -o tsv 2>/dev/null; }
up() { az storage blob upload --auth-mode login --account-name "$ACC" -c models -n "$1" -f "$2" --overwrite --no-progress --only-show-errors --output none; }

for PKG in @genclass/runtime-model @genclass/runtime; do
  SHORT="${PKG#@genclass/}"
  for V in $(npm view "$PKG" versions --json 2>/dev/null | jq -r 'if type=="array" then .[] else . end'); do
    [ "$(exists "npm/$SHORT/$V.tgz")" = "true" ] && continue
    (cd "$WORK" && npm pack --silent "$PKG@$V" > /dev/null)
    TGZ="$(ls "$WORK"/genclass-"$SHORT"-"$V".tgz)"
    up "npm/$SHORT/$V.tgz" "$TGZ"
    if [ "$SHORT" = "runtime-model" ]; then
      mkdir -p "$WORK/x" && tar -xzf "$TGZ" -C "$WORK/x"
      if [ -d "$WORK/x/package/files" ]; then
        az storage blob upload-batch --auth-mode login --account-name "$ACC" -d models --destination-path "runtime-model/$V/files" \
          -s "$WORK/x/package/files" --overwrite --no-progress --only-show-errors --output none
      fi
      rm -rf "$WORK/x"
    fi
    rm -f "$TGZ"
    echo "mirrored $PKG@$V"
  done
done
