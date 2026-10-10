#!/usr/bin/env node
// Checks the starter templates (templates/*) against this checkout's packed runtime (compat/.pack, from run.mjs):
// copy, point @genclass/runtime at the tarball, npm install, npm run build (each template's own build, type check
// included), then in headless Chromium:
//   prod  the production server: the model loads, the search box works, no console errors, no overlay;
//         with ?genclass=off nothing is installed
//   dev   the dev server: the devtools overlay mounts, no console errors
// Linux only (the VM). Telemetry is opted out through localStorage["genclass.telemetry"] = "off" (the template code
// is not changed); every request to another host is blocked, the model is served from COMPAT_MODEL_DIR.
//
//   node templates-check.mjs [--only react-vite,nextjs] [--out /path/templates.json]

import { chromium } from "@playwright/test";
import { execSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const TGZ = join(HERE, ".pack/genclass-runtime.tgz");
const MODEL = process.env.COMPAT_MODEL_DIR || "/data/compat/model/runtime-model-0.2.0";
const WORK = process.env.COMPAT_TEMPLATES_DIR || "/data/compat/templates";
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const ONLY = opt("only", null)?.split(",");
const OUT = opt("out", join(WORK, "templates-check.json"));
const ENV = { ...process.env, CI: "1", NO_COLOR: "1", NEXT_TELEMETRY_DISABLED: "1", SVELTEKIT_TELEMETRY_DISABLED: "1" };

const TEMPLATES = {
  "react-vite": { prod: "npx vite preview --host 127.0.0.1 --strictPort --port {port}", dev: "npx vite --host 127.0.0.1 --strictPort --port {port}" },
  nextjs: { prod: "npx next start -H 127.0.0.1 -p {port}", dev: "npx next dev -H 127.0.0.1 -p {port}" },
  "vue-vite": { prod: "npx vite preview --host 127.0.0.1 --strictPort --port {port}", dev: "npx vite --host 127.0.0.1 --strictPort --port {port}" },
  sveltekit: { prod: "npx vite preview --host 127.0.0.1 --strictPort --port {port}", dev: "npx vite dev --host 127.0.0.1 --strictPort --port {port}" },
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, cwd) => {
  try {
    return { ok: true, out: execSync(cmd, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 900_000, maxBuffer: 64 << 20 }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });

async function serve(cmd, cwd) {
  const port = await freePort();
  let out = "";
  const child = spawn(cmd.replace("{port}", port), { cwd, shell: true, detached: true, env: ENV });
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
    await sleep(500);
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  };
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return { url, stop, log: () => out };
    } catch { /* not up */ }
    await sleep(500);
  }
  await stop();
  throw new Error(`server did not start: ${cmd}\n${out.slice(-1500)}`);
}

async function visit(browser, url, { type = false, wantOverlay = null }) {
  const ctx = await browser.newContext();
  const blocked = [];
  await ctx.route((u) => u.hostname !== "127.0.0.1" && u.hostname !== "localhost", (r) => {
    const u = new URL(r.request().url());
    let m;
    if (u.hostname === "cdn.jsdelivr.net") {
      if ((m = /^\/npm\/@genclass\/runtime-model@[^/]+\/files\/(.+)$/.exec(u.pathname))) return r.fulfill({ path: join(MODEL, m[1]), headers: { "access-control-allow-origin": "*" } });
      if ((m = /^\/npm\/onnxruntime-web@[^/]+\/dist\/(.+)$/.exec(u.pathname))) return r.fulfill({ path: join(MODEL, "ort", m[1]), headers: { "access-control-allow-origin": "*" } });
    }
    blocked.push(u.origin + u.pathname);
    return r.abort();
  });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("genclass.telemetry", "off");
    } catch { /* storage blocked */ }
  });
  const page = await ctx.newPage();
  const consoleLines = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`.slice(0, 400)));
  page.on("console", (m) => {
    consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 400));
    if (m.type() === "error" && !/favicon|Failed to load resource: the server responded with a status of 404/.test(m.text())) errors.push(m.text().slice(0, 400));
  });
  const r = {};
  try {
    await page.goto(url, { waitUntil: "load", timeout: 90_000 });
    if (type) {
      await page.waitForSelector("input", { timeout: 30_000 });
      const t0 = Date.now();
      while (Date.now() - t0 < 30_000 && !consoleLines.some((l) => /\[GenClass\] Model ready/.test(l))) await sleep(200);
      r.modelReady = consoleLines.some((l) => /\[GenClass\] Model ready/.test(l));
      await page.click("input");
      await page.keyboard.type("san", { delay: 60 });
      await sleep(2500);
      r.results = await page.$$eval("li", (els) => els.map((e) => e.textContent));
    } else await sleep(3000);
    if (wantOverlay !== null) r.overlay = !!(await page.waitForSelector("genclass-devtools", { state: "attached", timeout: wantOverlay ? 30_000 : 1_500 }).catch(() => null));
    r.disabled = consoleLines.some((l) => /\[GenClass\] Disabled by \?genclass=off/.test(l));
  } catch (e) {
    r.error = String(e?.message ?? e).slice(0, 800);
  }
  r.errors = errors;
  r.blocked = blocked;
  r.genclass = consoleLines.filter((l) => /\[GenClass\]/.test(l)).slice(0, 8);
  await ctx.close();
  return r;
}

async function checkTemplate(name, browser) {
  const t = TEMPLATES[name];
  const dir = join(WORK, name);
  const rec = { name };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(REPO, "templates", name), dir, { recursive: true, filter: (s) => !/node_modules|\.next|\.svelte-kit|dist/.test(s) });
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkg.dependencies["@genclass/runtime"] = `file:${TGZ}`;
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  const inst = sh("npm install --no-audit --no-fund --loglevel=error", dir);
  rec.install = inst.ok ? "ok" : inst.out.slice(-1500);
  if (!inst.ok) return rec;
  const build = sh("npm run build", dir);
  rec.build = build.ok ? "ok" : build.out.slice(-2500);
  if (!build.ok) return rec;
  rec.versions = Object.fromEntries(Object.keys(pkg.dependencies).concat(Object.keys(pkg.devDependencies ?? {})).map((n) => {
    try {
      return [n, JSON.parse(readFileSync(join(dir, "node_modules", n, "package.json"), "utf8")).version];
    } catch {
      return [n, null];
    }
  }));
  for (const kind of ["prod", "dev"]) {
    let s;
    try {
      s = await serve(t[kind], dir);
      const main = await visit(browser, `${s.url}/`, { type: true, wantOverlay: kind === "dev" });
      const off = kind === "prod" ? await visit(browser, `${s.url}/?genclass=off`, { type: false }) : null;
      rec[kind] = { main, off };
      rec[kind].pass =
        !main.error && main.modelReady && (main.results ?? []).length > 0 && main.errors.length === 0 && main.blocked.length === 0 && main.overlay === (kind === "dev") && (!off || (off.disabled && off.errors.length === 0));
    } catch (e) {
      rec[kind] = { pass: false, error: String(e?.message ?? e).slice(0, 1500) };
    } finally {
      await s?.stop();
    }
    log(`${name} ${kind}: ${rec[kind].pass ? "ok" : "FAIL"}`);
  }
  return rec;
}

async function main() {
  if (!existsSync(TGZ)) throw new Error(`no packed runtime at ${TGZ}: run run.mjs first (it packs)`);
  mkdirSync(WORK, { recursive: true });
  const browser = await chromium.launch();
  const out = { at: new Date().toISOString(), runtime: JSON.parse(execSync(`tar -xzOf ${JSON.stringify(TGZ)} package/package.json`, { encoding: "utf8" })).version, templates: {} };
  for (const name of Object.keys(TEMPLATES)) {
    if (ONLY && !ONLY.includes(name)) continue;
    log(`=== ${name}`);
    out.templates[name] = await checkTemplate(name, browser);
    writeFileSync(OUT, JSON.stringify(out, null, 2));
  }
  await browser.close();
  for (const [n, r] of Object.entries(out.templates)) log(`${n}: install ${r.install === "ok" ? "ok" : "FAIL"}, build ${r.build === "ok" ? "ok" : r.build ? "FAIL" : "-"}, prod ${r.prod?.pass ? "ok" : "FAIL"}, dev ${r.dev?.pass ? "ok" : "FAIL"}`);
  log(`written ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
