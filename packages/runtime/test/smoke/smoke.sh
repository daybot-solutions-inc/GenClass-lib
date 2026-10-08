#!/bin/bash
# Pack @genclass/runtime, install the tarball into a fresh Vite app, build it, and load it in headless Chromium.
# Run from packages/runtime on the VM: bash test/smoke/smoke.sh
set -euo pipefail
PKG="$(pwd)"
npm run build >/dev/null
TGZ="$PKG/$(npm pack --silent | tail -1)"
APP="$(mktemp -d)/app"
mkdir -p "$APP/src"
cd "$APP"
cat > package.json <<'J'
{ "name": "smoke-app", "private": true, "type": "module", "scripts": { "build": "vite build" } }
J
cat > index.html <<'H'
<!doctype html><html><head><meta charset="utf-8"><title>smoke</title></head>
<body><input aria-label="Search" id="q"><ul id="out"></ul><script type="module" src="/src/main.js"></script></body></html>
H
cat > src/main.js <<'M'
import { GenClass } from "@genclass/runtime";
import { mountDevtools } from "@genclass/runtime/devtools";
const rt = GenClass.init({ model: false, report: "console" });
const results = rt.atom("search.results", []);
results.subscribe((v) => { document.getElementById("out").textContent = v.join(","); });
document.getElementById("q").addEventListener("input", async (e) => {
  const r = await fetch("data:application/json," + encodeURIComponent(JSON.stringify([e.target.value + "-1"])));
  results.set(await r.json());
});
mountDevtools(rt);
window.__smoke = { rt, ok: true };
M
npm install --no-audit --no-fund --silent "$TGZ" vite@8 @playwright/test@1.63.0 >/dev/null
npx vite build >/dev/null
cat > check.mjs <<'C'
import { chromium } from "@playwright/test";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const root = path.resolve("dist");
const srv = http.createServer((q, s) => { let f = path.join(root, q.url === "/" ? "index.html" : q.url.split("?")[0]);
  if (!fs.existsSync(f)) { s.statusCode = 404; return s.end(); }
  s.setHeader("content-type", f.endsWith(".js") ? "text/javascript" : "text/html"); s.end(fs.readFileSync(f)); }).listen(4191);
const b = await chromium.launch(); const p = await b.newPage(); const errs = [];
p.on("pageerror", (e) => errs.push(String(e))); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await p.goto("http://localhost:4191/"); await p.waitForFunction(() => window.__smoke?.ok);
await p.fill("#q", "rea"); await p.waitForFunction(() => document.getElementById("out").textContent === "rea-1");
const info = await p.evaluate(() => ({ status: __smoke.rt.status.state, events: __smoke.rt.history().length,
  devtools: !!document.querySelector("genclass-devtools") }));
console.log(JSON.stringify({ info, errs }));
await b.close(); srv.close();
if (errs.length || !info.devtools || info.events < 3) process.exit(1);
C
node check.mjs
echo "SMOKE OK: $TGZ"
