#!/usr/bin/env node
// Compat runner: packs this checkout's @genclass/runtime, installs it into every compat app, builds the app
// (production build), boots it in headless Chromium and runs the scenario set per app x data layer x mode
// (off / observe / guard / heal) x seed. Writes compat/results/<date>.json and compat/RESULTS.md.
// Linux only (the Azure VM; never on the 8 GB Mac). See compat/README.md.
//
//   npm run compat -- [--apps react-vite,next-app] [--layers state,swr] [--scenarios a,b] [--modes off,observe,guard,heal]
//                     [--seeds 5] [--seed-start 1] [--workers 16] [--no-pack] [--no-install] [--no-build]
//                     [--boot-only] [--no-control] [--out results/x.json] [--report RESULTS.md]
//   Without --out: results/<date>.json and RESULTS.md (the public page). With --out: <out>.json and <out>.md, unless
//   --report names the page.
//   COMPAT_MODEL_DIR   a local copy of the runtime's default model (`genclass-runtime fetch-model <dir> --variant q8
//                      --ort wasm`), served in place of jsDelivr (default /data/compat/model/runtime-model-0.2.0)
//
// "off" is the app with GenClass installed and switched off by the documented kill switch (?genclass=off). "offR"
// is a second off run of the same seed (control): it measures how deterministic the app and harness are, so a
// difference between a mode and off can be told from noise.

import { chromium } from "@playwright/test";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APPS } from "./harness/apps.mjs";
import { createBackend } from "./harness/backend.mjs";
import { startFront } from "./harness/front.mjs";
import { SCENARIOS, domSnapshotFn } from "./harness/scenarios.mjs";
import { writeReport } from "./harness/report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const RUNTIME = join(REPO, "packages/runtime");
const PACK = join(HERE, ".pack");
const TGZ = join(PACK, "genclass-runtime.tgz");
const PKG_X = join(PACK, "pkg", "package");
const MODEL = process.env.COMPAT_MODEL_DIR || "/data/compat/model/runtime-model-0.2.0";
const ORT = join(MODEL, "ort");

// ------------------------------------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const list = (name, def) => (opt(name, null) ? opt(name).split(",").filter(Boolean) : def);
const APP_NAMES = list("apps", Object.keys(APPS));
const LAYER_FILTER = list("layers", null);
const SCEN_FILTER = list("scenarios", null);
const MODES = list("modes", ["off", "observe", "guard", "heal"]);
const SEEDS = Number(opt("seeds", 5));
const SEED0 = Number(opt("seed-start", 1));
const WORKERS = Number(opt("workers", 16));
const CONTROL = !flag("no-control") && MODES.includes("off");
const DATE = new Date().toISOString().slice(0, 10);
const OUT = resolve(HERE, opt("out", `results/${DATE}.json`));
/** The public page is rewritten only by `--report RESULTS.md` or a default full run; other runs write <out>.md. */
const REPORT = resolve(HERE, opt("report", opt("out", null) ? OUT.replace(/\.json$/, "") + ".md" : "RESULTS.md"));

/** The Content-Security-Policy of the CSP boot check: what the app itself needs plus the README's additions for GenClass. */
const CSP_BUNDLED =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; " +
  "connect-src 'self' ws: https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:";
const CSP_CDN =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob:; " +
  "connect-src 'self' ws: https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:";

// ---------------------------------------------------------------------------------------------- helpers
const ENV = { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", NEXT_TELEMETRY_DISABLED: "1", NG_CLI_ANALYTICS: "false", SVELTEKIT_TELEMETRY_DISABLED: "1" };
function sh(cmd, cwd, { timeout = 1_200_000 } = {}) {
  const t0 = Date.now();
  try {
    const out = execSync(cmd, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], env: ENV, maxBuffer: 64 << 20 });
    return { ok: true, out, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`, ms: Date.now() - t0 };
  }
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });
async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}
const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));

async function startAppServer(app, dir) {
  if (app.serve.static) return { upstream: null, staticDir: join(dir, app.serve.static), stop: async () => {}, log: () => "" };
  const port = await freePort();
  const env = { ...ENV, ...Object.fromEntries(Object.entries(app.serve.env ?? {}).map(([k, v]) => [k, fill(v, { port })])) };
  let out = "";
  const child = spawn(fill(app.serve.cmd, { port }), { cwd: dir, shell: true, detached: true, env });
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const upstream = `http://127.0.0.1:${port}`;
  const stop = async () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* gone */
    }
    await sleep(600);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  };
  if (!(await waitHttp(upstream, 120_000))) {
    await stop();
    throw new Error(`server did not start: ${app.serve.cmd}\n${out.slice(-2000)}`);
  }
  return { upstream, staticDir: null, stop, log: () => out };
}

// ------------------------------------------------------------------------------------------ prepare
function packRuntime() {
  mkdirSync(PACK, { recursive: true });
  if (!flag("no-pack")) {
    const b = sh("npx tsup", RUNTIME);
    if (!b.ok) throw new Error(`runtime build failed\n${b.out.slice(-3000)}`);
    for (const f of readdirSync(PACK)) if (f.endsWith(".tgz")) rmSync(join(PACK, f));
    const p = sh(`npm pack --silent --pack-destination ${JSON.stringify(PACK)}`, RUNTIME);
    if (!p.ok) throw new Error(`npm pack failed\n${p.out.slice(-2000)}`);
    const name = p.out.trim().split("\n").pop();
    renameSync(join(PACK, name), TGZ);
    rmSync(join(PACK, "pkg"), { recursive: true, force: true });
    mkdirSync(join(PACK, "pkg"), { recursive: true });
    execSync(`tar -xzf ${JSON.stringify(TGZ)} -C ${JSON.stringify(join(PACK, "pkg"))}`);
  }
  return JSON.parse(readFileSync(join(PKG_X, "package.json"), "utf8")).version;
}

function installApp(dir) {
  // a fresh copy of the tarball every run (npm caches file: tarballs by integrity, the lockfile is off)
  rmSync(join(dir, "node_modules/@genclass"), { recursive: true, force: true });
  rmSync(join(dir, "node_modules/.package-lock.json"), { force: true });
  return sh("npm install --no-audit --no-fund --loglevel=error", dir, { timeout: 1_500_000 });
}

function versionsOf(dir, names) {
  const v = {};
  for (const n of ["@genclass/runtime", ...names]) {
    try {
      v[n] = JSON.parse(readFileSync(join(dir, "node_modules", n, "package.json"), "utf8")).version;
    } catch {
      v[n] = null;
    }
  }
  return v;
}

// ------------------------------------------------------------------------------------------- browser
/** Runs in the page before any app script: the harness probe (a GenClass plugin that only listens). */
function probe(cfg) {
  const C = (window.__compat = { events: [], csp: [], rt: null });
  document.addEventListener("securitypolicyviolation", (e) => C.csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  if (cfg.off) return;
  const ev = (k, o) => {
    if (C.events.length < 3000) C.events.push(Object.assign({ k }, o));
  };
  const conf = Object.assign({ telemetry: false }, cfg.extra || {});
  if (cfg.mode) conf.mode = cfg.mode;
  conf.plugins = [
    {
      name: "compat-probe",
      setup(api) {
        C.rt = api.runtime;
        C.storesApi = api.stores;
        api.on("decide", (d) =>
          ev("decide", { id: d.id, trigger: d.trigger, subject: d.subject, diagnosis: d.diagnosis, dconf: Math.round(d.diagnosisConfidence * 100) / 100, action: d.action, candidate: d.candidate, executed: d.executed, tier: d.tier, reason: d.reason }),
        );
        api.on("detect", (d) => ev("detect", { id: d.id, trigger: d.trigger, subject: d.subject, diagnosis: d.diagnosis, action: d.action, executed: d.executed }));
        api.on("act", (a) => ev("act", { id: a.id, action: a.action, tier: a.tier, trigger: a.trigger, subject: a.subject, ok: a.ok, changed: a.changed, late: !!a.late, error: a.error }));
      },
    },
  ];
  window.GENCLASS_CONFIG = conf;
}

/** Page-side: what GenClass found and did, read after the trial (`shapes`: also the top-level shape of each store). */
function readProbe(shapes = false) {
  const C = window.__compat;
  const rt = C?.rt;
  const st = rt?.status;
  let stores = [];
  try {
    stores = rt ? rt.stores().map((s) => ({ name: s.name, kind: s.kind, source: s.source ?? null, fields: s.fields, version: s.version })) : [];
    if (shapes && C.storesApi) {
      const shape = (v, d) => {
        if (Array.isArray(v)) return `array(${v.length})${v.length && d < 2 ? ` of ${shape(v[0], d + 1)}` : ""}`;
        if (v && typeof v === "object") return d >= 2 ? "object" : `{${Object.keys(v).slice(0, 12).map((k) => `${k}: ${shape(v[k], d + 1)}`).join(", ")}}`;
        return typeof v;
      };
      for (const s of stores) s.shape = shape(C.storesApi.get(s.name), 0).slice(0, 600);
    }
  } catch {
    /* introspection failed: recorded as none */
  }
  const native = (f) => typeof f === "function" && /\[native code\]/.test(Function.prototype.toString.call(f));
  return {
    events: C?.events ?? [],
    csp: C?.csp ?? [],
    stores,
    status: st ? { state: st.state, effectiveMode: st.effectiveMode, device: st.device } : null,
    // fetch alone is not proof: SvelteKit wraps window.fetch itself in production
    fetchNative: native(window.fetch),
    globalsNative: native(window.WebSocket) && native(window.EventSource) && native(window.setTimeout),
  };
}

const NETWORK_NOISE = /Failed to load resource|net::ERR_|EventSource's response|WebSocket connection to/;

async function newPage(browser, { off, mode, extra }) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const blocked = [];
  await context.route(
    (u) => u.hostname !== "127.0.0.1" && u.hostname !== "localhost",
    (r) => {
      const u = new URL(r.request().url());
      let m;
      if (u.hostname === "cdn.jsdelivr.net") {
        // the script tag and the files it loads (the packed tarball stands in for the CDN)
        if ((m = /^\/npm\/@genclass\/runtime(?:@[^/]+)?\/?$/.exec(u.pathname))) return r.fulfill({ path: join(PKG_X, "dist/genclass.global.min.js"), contentType: "text/javascript", headers: { "access-control-allow-origin": "*" } });
        if ((m = /^\/npm\/@genclass\/runtime(?:@[^/]+)?\/(.+)$/.exec(u.pathname))) return r.fulfill({ path: join(PKG_X, m[1]), contentType: "text/javascript", headers: { "access-control-allow-origin": "*" } });
        if ((m = /^\/npm\/@genclass\/runtime-model@[^/]+\/files\/(.+)$/.exec(u.pathname))) return r.fulfill({ path: join(MODEL, m[1]), headers: { "access-control-allow-origin": "*" } });
        if ((m = /^\/npm\/onnxruntime-web@[^/]+\/dist\/(.+)$/.exec(u.pathname))) return r.fulfill({ path: join(ORT, m[1]), headers: { "access-control-allow-origin": "*" } });
      }
      blocked.push(u.origin + u.pathname);
      return r.abort();
    },
  );
  await context.addInitScript(probe, { off, mode, extra });
  const page = await context.newPage();
  const consoleLines = [];
  const errors = [];
  const noise = [];
  const onErr = (t) => (NETWORK_NOISE.test(t) ? noise : errors).push(t.slice(0, 600));
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message).slice(0, 400)}`));
  page.on("console", (m) => {
    const t = m.text();
    if (consoleLines.length < 400) consoleLines.push(`${m.type()}: ${t.slice(0, 600)}`);
    if (m.type() === "error" && !/favicon/.test(`${t} ${m.location()?.url ?? ""}`)) onErr(t);
  });
  page.on("worker", (w) => w.on("console", (m) => m.type() === "error" && onErr(`worker: ${m.text()}`)));
  return { context, page, consoleLines, errors, noise, blocked };
}

async function waitModel(page, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(() => {
      const st = window.__compat?.rt?.status;
      return st ? { state: st.state, device: st.device, loadMs: st.loadMs, error: st.error, effectiveMode: st.effectiveMode } : null;
    });
    if (s && (s.state === "ready" || s.state === "error" || s.state === "disabled" || s.state === "skipped")) return { ...s, waitedMs: Date.now() - t0 };
    await sleep(150);
  }
  return { state: "timeout", waitedMs: Date.now() - t0 };
}

/** Waits until neither the mock server nor GenClass has anything in flight and the scenario's DOM is quiet. */
async function settle(page, backend, { quietMs, maxMs }) {
  const t0 = Date.now();
  let last = null;
  let since = Date.now();
  while (Date.now() - t0 < maxMs) {
    const dom = JSON.stringify(await page.evaluate(domSnapshotFn));
    const held = await page.evaluate(() => {
      try {
        // requests GenClass has not released yet (held, delayed, deferred); sockets and streams are long-lived
        return window.__compat?.rt ? window.__compat.rt.inflight().filter((o) => o.kind === "fetch" || o.kind === "xhr").length : 0;
      } catch {
        return 0;
      }
    });
    const busy = backend.inflight() > 0 || held > 0;
    if (dom !== last || busy) {
      if (dom !== last) last = dom;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return { settled: true, ms: Date.now() - t0 };
    await sleep(100);
  }
  return { settled: false, ms: Date.now() - t0 };
}

const urlFor = (front, layer, scenario, off) => `${front.url}/?s=${scenario}&layer=${layer}${off ? "&genclass=off" : ""}`;

const isGenclassLine = (l) => /\[GenClass\]/.test(l);

async function runTrial(w, app, t) {
  const sc = SCENARIOS[t.scenario];
  const off = t.mode === "off" || t.mode === "offR";
  w.backend.reset({ seed: t.seed, scenario: t.scenario });
  const r = { app: app.name, layer: t.layer, scenario: t.scenario, mode: t.mode, seed: t.seed };
  const t0 = Date.now();
  const { context, page, consoleLines, errors, noise, blocked } = await newPage(w.browser, { off, mode: off ? null : t.mode });
  try {
    await page.goto(urlFor(w.front, t.layer, t.scenario, off), { waitUntil: "load", timeout: 60_000 });
    await page.waitForSelector('#compat[data-ready="1"]', { timeout: 30_000 });
    if (!off) r.model = await waitModel(page);
    await settle(page, w.backend, { quietMs: 300, maxMs: 8_000 });
    await sc.drive(page, { seed: t.seed, context });
    r.settle = await settle(page, w.backend, { quietMs: 900, maxMs: 25_000 });
    r.dom = await page.evaluate(domSnapshotFn);
    r.server = w.backend.snapshot();
    r.bug = sc.oracle(r.dom, r.server, { seed: t.seed });
    Object.assign(r, await page.evaluate(readProbe, !!process.env.COMPAT_SHAPES));
    r.ok = true;
  } catch (e) {
    r.ok = false;
    r.error = String(e?.message ?? e).slice(0, 1500);
    try {
      r.dom = await page.evaluate(domSnapshotFn);
    } catch {
      /* page gone */
    }
  }
  r.errors = errors;
  r.noise = noise.length;
  r.genclassConsole = consoleLines.filter(isGenclassLine).filter((l) => /^(error|warning)/.test(l));
  r.blocked = blocked;
  r.ms = Date.now() - t0;
  await context.close().catch(() => {});
  return r;
}

// ------------------------------------------------------------------------------------------ boot checks
async function bootChecks(w, app) {
  const layer = Object.keys(app.layers).find((l) => !LAYER_FILTER || LAYER_FILTER.includes(l)) ?? Object.keys(app.layers)[0];
  const scen = app.layers[layer].scenarios.includes("h") ? "h" : app.layers[layer].scenarios[0];
  const out = { layer };
  const visit = async (name, { off = false, extra = null, csp = false, check }) => {
    w.backend.reset({ seed: 1, scenario: scen });
    if (csp) w.front.setCsp(app.cdn ? CSP_CDN : CSP_BUNDLED);
    const { context, page, consoleLines, errors, blocked } = await newPage(w.browser, { off, mode: null, extra });
    const r = {};
    try {
      await page.goto(urlFor(w.front, layer, scen, off), { waitUntil: "load", timeout: 60_000 });
      await page.waitForSelector('#compat[data-ready="1"]', { timeout: 30_000 });
      r.ready = true;
      await check(page, r);
      const p = await page.evaluate(readProbe);
      r.fetchNative = p.fetchNative;
      r.globalsNative = p.globalsNative;
      r.csp = p.csp;
      r.stores = p.stores;
      r.workers = page.workers().map((x) => x.url().replace(/^.*\//, ""));
    } catch (e) {
      r.error = String(e?.message ?? e).slice(0, 1200);
    }
    r.errors = errors;
    r.genclass = consoleLines.filter(isGenclassLine).slice(0, 12);
    r.genclassProblems = consoleLines.filter(isGenclassLine).filter((l) => /^(error|warning)/.test(l));
    r.blocked = blocked;
    if (csp) w.front.setCsp(null);
    await context.close().catch(() => {});
    out[name] = r;
  };
  await visit("boot", {
    check: async (page, r) => {
      r.model = await waitModel(page);
      r.mode = await page.evaluate(() => window.__compat?.rt?.mode ?? null);
      await sleep(1000);
    },
  });
  await visit("killswitch", { off: true, check: async () => sleep(1500) });
  await visit("devtools", {
    extra: { devtools: true },
    check: async (page, r) => {
      r.overlay = !!(await page.waitForSelector("genclass-devtools", { state: "attached", timeout: 20_000 }).catch(() => null));
      r.model = await waitModel(page);
      await sleep(1000);
    },
  });
  await visit("csp", {
    csp: true,
    check: async (page, r) => {
      r.model = await waitModel(page);
      await sleep(1000);
    },
  });
  const clean = (x) => x.errors.length === 0 && x.genclassProblems.length === 0 && x.blocked.length === 0;
  out.boot.pass = !!(out.boot.ready && out.boot.model?.state === "ready" && !out.boot.fetchNative && !out.boot.globalsNative && out.boot.csp.length === 0 && clean(out.boot));
  // the kill switch: nothing installed (WebSocket, EventSource and timers are the browser's own; no model worker)
  out.killswitch.pass = !!(out.killswitch.ready && out.killswitch.globalsNative && (out.killswitch.workers ?? []).length === 0 && out.killswitch.errors.length === 0 && out.killswitch.blocked.length === 0);
  out.devtools.pass = !!(out.devtools.ready && out.devtools.overlay && clean(out.devtools));
  out.csp.pass = !!(out.csp.ready && out.csp.model?.state === "ready" && out.csp.csp.length === 0 && clean(out.csp));
  if (app.ssr) out.ssr = await ssrCheck(w, layer, scen);
  return out;
}

/** SSR: the page is server-rendered with GenClass installed, and importing the one line on the server is inert. */
async function ssrCheck(w, layer, scen) {
  const r = {};
  try {
    const page = await fetch(`${w.front.url}/?s=${scen}&layer=${layer}`);
    const html = await page.text();
    r.pageStatus = page.status;
    r.serverRendered = /data-ssr="1"/.test(html) && /id="compat"/.test(html);
    const chk = await fetch(`${w.front.url}/ssr-check`);
    r.checkStatus = chk.status;
    const body = await chk.text();
    try {
      r.check = JSON.parse(body);
    } catch {
      r.check = null;
      r.body = body.slice(0, 800);
    }
    const c = r.check;
    r.pass = r.pageStatus === 200 && r.serverRendered && r.checkStatus === 200 && !!c && c.error == null && c.fetchSame === true && c.state !== "ready" && c.state !== "loading" && c.stores === 0 && (c.globalsAdded ?? []).length === 0;
  } catch (e) {
    r.error = String(e?.message ?? e).slice(0, 1000);
    r.pass = false;
  }
  return r;
}

// ---------------------------------------------------------------------------------------------- main
async function runApp(name, results) {
  const app = { name, ...APPS[name] };
  const dir = join(HERE, app.dir);
  const rec = (results.apps[name] = { title: app.title, install: app.install, layers: Object.fromEntries(Object.entries(app.layers).map(([k, v]) => [k, v.title])), steps: {} });
  log(`=== ${name}`);
  if (existsSync(join(dir, "package.json"))) {
    if (!flag("no-install")) {
      const i = installApp(dir);
      rec.steps.install = { ok: i.ok, ms: i.ms, out: i.ok ? undefined : i.out.slice(-3000) };
      log(`${name}: install ${i.ok ? "ok" : "FAILED"} ${Math.round(i.ms / 1000)}s`);
      if (!i.ok) return;
    }
    rec.versions = versionsOf(dir, app.versions);
  } else {
    rec.versions = { "@genclass/runtime": results.meta.runtime };
  }
  if (app.build && !flag("no-build")) {
    const b = sh(app.build, dir);
    rec.steps.build = { ok: b.ok, ms: b.ms, out: b.ok ? undefined : b.out.slice(-4000), warnings: b.ok ? (b.out.match(/.*(genclass|warn).*/gi) ?? []).slice(0, 20) : undefined };
    log(`${name}: build ${b.ok ? "ok" : "FAILED"} ${Math.round(b.ms / 1000)}s`);
    if (!b.ok) return;
  }
  let server;
  try {
    server = await startAppServer(app, dir);
  } catch (e) {
    rec.steps.serve = { ok: false, error: e.message.slice(0, 3000) };
    log(`${name}: serve FAILED`);
    return;
  }
  rec.steps.serve = { ok: true };
  const workers = [];
  try {
    for (let i = 0; i < WORKERS; i++) {
      const backend = createBackend();
      const front = await startFront({ backend, upstream: server.upstream, staticDir: server.staticDir });
      const browser = await chromium.launch();
      workers.push({ backend, front, browser });
    }
    rec.boot = await bootChecks(workers[0], app);
    log(`${name}: boot ${["boot", "killswitch", "devtools", "csp", "ssr"].map((k) => `${k}=${rec.boot[k] ? (rec.boot[k].pass ? "ok" : "FAIL") : "-"}`).join(" ")}`);
    if (flag("boot-only")) return;

    const queue = [];
    const modes = CONTROL ? [...MODES, "offR"] : MODES;
    for (const [layer, L] of Object.entries(app.layers)) {
      if (LAYER_FILTER && !LAYER_FILTER.includes(layer)) continue;
      for (const s of L.scenarios) {
        if (SCEN_FILTER && !SCEN_FILTER.includes(s)) continue;
        for (let seed = SEED0; seed < SEED0 + SEEDS; seed++) for (const mode of modes) queue.push({ layer, scenario: s, mode, seed });
      }
    }
    let done = 0;
    const total = queue.length;
    await Promise.all(
      workers.map(async (w) => {
        for (;;) {
          const t = queue.shift();
          if (!t) return;
          let r;
          try {
            r = await runTrial(w, app, t);
          } catch (e) {
            r = { app: name, ...t, ok: false, error: String(e?.stack ?? e).slice(0, 1500) };
          }
          results.trials.push(r);
          done++;
          if (!r.ok || done % 50 === 0 || done === total) log(`${name}: ${done}/${total}${r.ok ? "" : ` FAILED ${t.layer}/${t.scenario}/${t.mode}/${t.seed}: ${r.error?.slice(0, 200)}`}`);
        }
      }),
    );
  } finally {
    for (const w of workers) {
      await w.browser.close().catch(() => {});
      await w.front.close().catch(() => {});
      w.backend.close();
    }
    rec.serverLog = server.log().split("\n").filter((l) => /genclass|error|warn/i.test(l)).slice(0, 40);
    await server.stop();
  }
}

async function main() {
  if (!existsSync(join(MODEL, "model.json"))) throw new Error(`no model at ${MODEL} (see compat/README.md)`);
  const version = packRuntime();
  log(`@genclass/runtime ${version} packed at ${TGZ}`);
  const card = JSON.parse(readFileSync(join(MODEL, "model.json"), "utf8"));
  const results = {
    meta: {
      at: new Date().toISOString(),
      runtime: version,
      model: card.version ?? null,
      modelName: card.name ?? null,
      node: process.version,
      chromium: null,
      commit: process.env.COMPAT_COMMIT || null,
      seeds: [SEED0, SEED0 + SEEDS - 1],
      modes: MODES,
      control: CONTROL,
      workers: WORKERS,
      args: argv,
      csp: { bundled: CSP_BUNDLED, cdn: CSP_CDN },
    },
    apps: {},
    trials: [],
  };
  {
    const b = await chromium.launch();
    results.meta.chromium = b.version();
    await b.close();
  }
  mkdirSync(dirname(OUT), { recursive: true });
  for (const name of APP_NAMES) {
    if (!APPS[name]) {
      log(`unknown app ${name}`);
      continue;
    }
    try {
      await runApp(name, results);
    } catch (e) {
      results.apps[name] = { ...(results.apps[name] ?? {}), error: String(e?.stack ?? e).slice(0, 3000) };
      log(`${name}: ERROR ${e?.message}`);
    }
    writeFileSync(OUT, JSON.stringify(results));
  }
  writeFileSync(OUT, JSON.stringify(results));
  const md = writeReport(results, { jsonPath: OUT, mdPath: REPORT });
  log(`results: ${OUT}\n${md.summary}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
