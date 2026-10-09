#!/usr/bin/env bash
# Build the demos against the current packages/runtime/dist and keep the result as bench/heal/.dist/<name>/, so a
# long eval can serve a fixed build while the runtime keeps changing. Records the runtime fingerprint and git sha.
#   bench/heal/snapshot-demos.sh <name>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../.." && pwd)"
name="${1:?usage: snapshot-demos.sh <name>}"
(cd "$root/packages/runtime" && npx tsup >/dev/null)
dest="$here/.dist/$name"; rm -rf "$dest"; mkdir -p "$here/.dist"
(cd "$root/demos" && DEMOS_OUT_DIR="$dest" npm run build >/dev/null)
node -e '
const fs=require("fs"),c=require("crypto"),p=require("path");
const d=process.argv[1]+"/packages/runtime/dist";
const files=fs.readdirSync(d,{recursive:true}).map(String).filter(f=>f.endsWith(".js")).sort();
const h=c.createHash("sha256"); for(const f of files) h.update(f).update(fs.readFileSync(p.join(d,f)));
const v=JSON.parse(fs.readFileSync(process.argv[1]+"/packages/runtime/package.json")).version;
const sha=require("child_process").execSync("git -C "+process.argv[1]+" rev-parse --short HEAD").toString().trim();
const dirty=require("child_process").execSync("git -C "+process.argv[1]+" status --porcelain packages/runtime/src").toString().trim()?"+dirty":"";
fs.writeFileSync(process.argv[2]+"/runtime-build.json", JSON.stringify({version:v, dist:h.digest("hex").slice(0,12), git: sha+dirty}));
console.log(fs.readFileSync(process.argv[2]+"/runtime-build.json","utf8"));
' "$root" "$dest"
