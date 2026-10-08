// Browser checks for the script-tag build (dist/genclass.global*.js) and the /auto entry, in headless Chromium.
// Run on the VM after `npx tsup` (packages/runtime): node test/install/cdn-check.mjs
//   GENCLASS_MODEL_DIR  a model directory (default ~/gcl/model/.cache-model)
//
// The page and the "CDN" are different origins (http://localhost:A and http://127.0.0.1:B, the CDN sending CORS
// headers like jsDelivr), so the model worker must start from a Blob URL and import its module cross-origin.

import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..", "..");
const DIST = join(PKG, "dist");
const MODEL = resolve(process.env.GENCLASS_MODEL_DIR || join(homedir(), "gcl/model/.cache-model"));
const ORT = dirname(createRequire(join(PKG, "package.json")).resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm"));
const VERSION = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version;
const ORT_VERSION = JSON.parse(readFileSync(join(ORT, "..", "package.json"), "utf8")).version;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const work = mkdtempSync(join(process.env.INSTALL_TMP || tmpdir(), "gc-cdn-"));
const pages = join(work, "pages");
mkdirSync(pages, { recursive: true });

// ------------------------------------------------------------------------------------------- servers

const cdn = await serve({ mounts: { "/pkg/dist/": DIST, "/model/": MODEL, "/ort/": ORT }, cors: true });
const CDN = cdn.url; // http://127.0.0.1:B
const site = await serve({ mounts: { "/": pages }, coi: (p) => p.startsWith("/coi") });
const SITE = site.url.replace("127.0.0.1", "localhost"); // another origin
const SCRIPT = `${CDN}/pkg/dist/genclass.global.min.js`;

const APP = `
<input aria-label="Search" id="q"><ul id="out"></ul>
<script>
  document.getElementById("q").addEventListener("input", async (e) => {
    const r = await fetch("data:application/json," + encodeURIComponent(JSON.stringify([e.target.value + "-1"])));
    document.getElementById("out").textContent = (await r.json()).join(",");
  });
</script>`;
const page = (name, head, body = APP) => writeFileSync(join(pages, name), `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>\n${head}\n</head><body>${body}</body></html>\n`);

const tag = (attrs) => `<script src="${SCRIPT}" ${attrs}></script>`;
const modelAttrs = `data-model="${CDN}/model/" data-ort="${CDN}/ort/" data-preload="eager"`;
page("basic.html", tag(`data-mode="observe" data-devtools ${modelAttrs}`));
mkdirSync(join(pages, "coi"), { recursive: true });
writeFileSync(join(pages, "coi", "index.html"), readFileSync(join(pages, "basic.html"), "utf8"));
page("default-urls.html", tag(`data-preload="eager"`));
page("manual.html", tag(`data-manual ${modelAttrs}`));
page("inline.html", `<meta http-equiv="Content-Security-Policy" content="worker-src 'none'">\n${tag(modelAttrs)}`);
page("meta.html", `<meta name="genclass" content="mode=heal, devtools=local">\n<script>window.GENCLASS_CONFIG = { report: "console" };</script>\n${tag(modelAttrs)}`);
page("twice.html", `${tag(modelAttrs)}\n${tag(modelAttrs)}`);
page("unversioned.html", `<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime" data-preload="eager" data-mode="observe"></script>`);

// /auto through a bundler (esbuild, the way build.mjs bundles the worker): main + worker entries
const autoDir = join(pages, "auto");
mkdirSync(autoDir, { recursive: true });
writeFileSync(join(work, "auto-main.js"), `import rt from "@genclass/runtime/auto";\nwindow.__auto = { rt, mode: rt.mode };\n`);
await build({
  entryPoints: { main: join(work, "auto-main.js"), worker: join(DIST, "worker.js") },
  bundle: true,
  format: "esm",
  splitting: true,
  outdir: autoDir,
  entryNames: "[name]",
  platform: "browser",
  target: "es2022",
  logLevel: "error",
  alias: { "@genclass/runtime/auto": join(DIST, "auto.js") },
});
writeFileSync(
  join(autoDir, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><title>auto</title>
<meta name="genclass" content="mode=observe, devtools">
<script>window.GENCLASS_CONFIG = { model: { baseUrl: "${CDN}/model/", ortWasmPaths: "${CDN}/ort/", preload: "eager" } };</script>
<script type="module" src="./main.js"></script></head><body>${APP}</body></html>\n`,
);

// --------------------------------------------------------------------------------------------- browser

const browser = await chromium.launch();

async function open(url, { route = false, wait = "ready" } = {}) {
  const ctx = await browser.newContext();
  const errors = [];
  const consoleLines = [];
  const requests = [];
  if (route) {
    // the defaults (jsDelivr) served from local copies: the published model package does not exist yet
    await ctx.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\//, (r) => {
      const u = new URL(r.request().url());
      let m;
      if ((m = /^\/npm\/@genclass\/runtime-model@[^/]+\/files\/(.+)$/.exec(u.pathname))) return r.fulfill({ path: join(MODEL, m[1]), headers: { "access-control-allow-origin": "*" } });
      if ((m = /^\/npm\/onnxruntime-web@[^/]+\/dist\/(.+)$/.exec(u.pathname))) return r.fulfill({ path: join(ORT, m[1]), headers: { "access-control-allow-origin": "*" } });
      if ((m = /^\/npm\/@genclass\/runtime(?:@[^/]+)?(\/.*)?$/.exec(u.pathname))) {
        const rest = !m[1] || m[1] === "/" ? "/dist/genclass.global.min.js" : m[1];
        return r.fulfill({ path: join(PKG, rest), headers: { "access-control-allow-origin": "*", "content-type": "text/javascript" } });
      }
      return r.abort();
    });
  }
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`pageerror: ${e}`));
  p.on("console", (m) => {
    consoleLines.push(`${m.type()}: ${m.text()}`);
    if (m.type() === "error") errors.push(m.text());
  });
  p.on("request", (r) => requests.push(r.url()));
  p.on("worker", (w) => w.on("console", (m) => m.type() === "error" && errors.push(`worker: ${m.text()}`)));
  await p.goto(url);
  if (wait === "ready") {
    await p
      .waitForFunction(() => {
        const s = window.GenClass?.runtime?.status?.state;
        return s === "ready" || s === "error";
      }, null, { timeout: 120_000 })
      .catch(() => undefined);
  }
  const close = () => ctx.close();
  return { p, errors, consoleLines, requests, close };
}

const status = (p) => p.evaluate(() => ({ ...window.GenClass?.runtime?.status, progress: undefined, attempts: window.GenClass?.runtime?.status?.attempts }));

try {
  // A. cross-origin script tag, observe mode, devtools, model from the CDN origin
  {
    const t = await open(`${SITE}/basic.html`);
    const s = await status(t.p);
    const info = await t.p.evaluate(() => ({
      version: window.GenClass?.version,
      mode: window.GenClass?.runtime?.mode,
      devtools: !!document.querySelector("genclass-devtools"),
      fetchWrapped: !/\[native code\]/.test(Function.prototype.toString.call(window.fetch)),
    }));
    check("A script tag exposes window.GenClass", info.version === VERSION, `version ${info.version}`);
    check("A data-mode=observe applied", info.mode === "observe");
    check("A model ready in a cross-origin Blob worker", s.state === "ready" && s.worker === true && !s.workerError, `${s.state} worker=${s.worker} device=${s.device} variant=${s.variant} ${s.error ?? ""} ${s.workerError ?? ""}`);
    check("A fetch instrumented", info.fetchWrapped);
    await t.p.fill("#q", "rea");
    await t.p.waitForFunction(() => document.getElementById("out").textContent === "rea-1");
    const dec = await t.p.evaluate(() => window.GenClass.runtime.decide("Is the user typing right now?", { yes: "the user is typing", no: "the user is idle" }, { timeoutMs: 30000 }).then((x) => x, (e) => `ERR ${e.message}`));
    check("A decide() answered by the model through the worker", dec === "yes" || dec === "no", String(dec));
    await t.p.waitForSelector("genclass-devtools", { timeout: 10_000 }).catch(() => undefined);
    check("A data-devtools mounted the overlay", await t.p.evaluate(() => !!document.querySelector("genclass-devtools")));
    check("A console says Model ready", t.consoleLines.some((l) => l.includes("[GenClass] Model ready")));
    check("A no console errors", t.errors.length === 0, t.errors.slice(0, 3).join(" | "));
    check("A worker module and ORT loaded from the CDN origin", t.requests.some((u) => u === `${CDN}/pkg/dist/cdn/worker.js`) && t.requests.some((u) => u.startsWith(`${CDN}/pkg/dist/cdn/ort-`)), "");
    await t.close();
  }

  // B. crossOriginIsolated page: WASM threads in the Blob worker, ORT glue preloaded from the ORT directory
  {
    const t = await open(`${SITE}/coi/`);
    const s = await status(t.p);
    const coi = await t.p.evaluate(() => self.crossOriginIsolated);
    check("B crossOriginIsolated page: model ready with WASM threads", coi && s.state === "ready" && s.worker === true && (s.threads ?? 1) > 1, `coi=${coi} ${s.state} threads=${s.threads} ${s.error ?? ""}`);
    check("B no console errors", t.errors.length === 0, t.errors.slice(0, 3).join(" | "));
    await t.close();
  }

  // C. default URLs (no data-model / data-ort) with the jsDelivr requests served locally
  {
    const t = await open(`${SITE}/default-urls.html`, { route: true });
    const s = await status(t.p);
    check("C default model + ORT URLs (jsDelivr, routed) load in the worker", s.state === "ready" && s.worker === true, `${s.state} ${s.error ?? ""}`);
    check("C no console errors", t.errors.length === 0, t.errors.slice(0, 3).join(" | "));
    await t.close();
  }

  // D. kill switch
  {
    const t = await open(`${SITE}/basic.html?genclass=off`, { wait: "none" });
    await t.p.waitForTimeout(1500);
    const info = await t.p.evaluate(() => ({ state: window.GenClass?.runtime?.status?.state, devtools: !!document.querySelector("genclass-devtools"), fetchNative: /\[native code\]/.test(Function.prototype.toString.call(window.fetch)) }));
    check("D ?genclass=off installs nothing (no worker, no overlay, native fetch)", info.state === "off" && !info.devtools && info.fetchNative && !t.requests.some((u) => u.includes("/cdn/worker.js")), JSON.stringify(info));
    await t.close();
  }

  // E. data-manual
  {
    const t = await open(`${SITE}/manual.html`, { wait: "none" });
    const before = await t.p.evaluate(() => ({ has: typeof window.GenClass?.init === "function", runtime: window.GenClass?.runtime }));
    await t.p.evaluate(() => window.GenClass.init({ mode: "heal", model: { preload: "eager" } }));
    await t.p.waitForFunction(() => ["ready", "error"].includes(window.GenClass.runtime.status.state), null, { timeout: 120_000 });
    const s = await status(t.p);
    const mode = await t.p.evaluate(() => window.GenClass.runtime.mode);
    check("E data-manual: no init until GenClass.init()", before.has && before.runtime === null);
    check("E manual GenClass.init() gets the CDN worker", s.state === "ready" && s.worker === true && mode === "heal", `${s.state} ${mode} ${s.error ?? ""}`);
    await t.close();
  }

  // F. CSP forbids workers: the host runs the model inline, loading ORT from the CDN
  {
    const t = await open(`${SITE}/inline.html`);
    const s = await status(t.p);
    check("F worker-src 'none': inline fallback loads ORT from the CDN", s.state === "ready" && s.worker === false, `${s.state} worker=${s.worker} ${s.workerError ?? ""} ${s.error ?? ""}`);
    await t.close();
  }

  // G. meta config + window.GENCLASS_CONFIG; devtools=local on localhost
  {
    const t = await open(`${SITE}/meta.html`);
    await t.p.waitForSelector("genclass-devtools", { timeout: 10_000 }).catch(() => undefined);
    const info = await t.p.evaluate(() => ({ mode: window.GenClass.runtime.mode, devtools: !!document.querySelector("genclass-devtools") }));
    check("G <meta name=genclass> mode=heal, devtools=local", info.mode === "heal" && info.devtools, JSON.stringify(info));
    await t.close();
  }

  // H. the tag twice: one runtime
  {
    const t = await open(`${SITE}/twice.html`);
    const n = await t.p.evaluate(() => document.querySelectorAll("genclass-devtools").length);
    const s = await status(t.p);
    check("H script tag twice: one runtime, no errors", s.state === "ready" && n === 0 && t.errors.length === 0, `${s.state} ${t.errors[0] ?? ""}`);
    await t.close();
  }

  // I. unversioned jsDelivr URL: files are taken from the same version
  {
    const t = await open(`${SITE}/unversioned.html`, { route: true });
    const s = await status(t.p);
    const base = await t.p.evaluate(() => window.GenClass?.base);
    check("I unversioned jsDelivr URL pins the worker to this version", base === `https://cdn.jsdelivr.net/npm/@genclass/runtime@${VERSION}/dist/` && s.state === "ready", `${base} ${s.state} ${s.error ?? ""}`);
    check("I ORT wasm from jsDelivr onnxruntime-web at the bundled version", t.requests.some((u) => u.includes(`onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded`)));
    await t.close();
  }

  // J. /auto through a bundler: meta config, GENCLASS_CONFIG model options, default export
  {
    const t = await open(`${SITE}/auto/`, { wait: "none" });
    await t.p.waitForFunction(() => window.__auto, null, { timeout: 30_000 });
    await t.p.waitForFunction(() => ["ready", "error"].includes(window.__auto.rt.status.state), null, { timeout: 120_000 }).catch(() => undefined);
    await t.p.waitForSelector("genclass-devtools", { timeout: 10_000 }).catch(() => undefined);
    const info = await t.p.evaluate(() => ({ mode: window.__auto.mode, state: window.__auto.rt.status.state, worker: window.__auto.rt.status.worker, devtools: !!document.querySelector("genclass-devtools"), error: window.__auto.rt.status.error }));
    check("J /auto: default export is the runtime, meta mode applied", info.mode === "observe");
    check("J /auto: model ready in the bundled worker (GENCLASS_CONFIG model options)", info.state === "ready" && info.worker === true, `${info.state} ${info.error ?? ""}`);
    check("J /auto: meta devtools mounted the overlay", info.devtools);
    check("J /auto: no console errors", t.errors.length === 0, t.errors.slice(0, 3).join(" | "));
    await t.close();
  }
} finally {
  await browser.close();
  await cdn.close();
  await site.close();
  if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
}

// K. SSR: importing /auto in Node installs nothing
{
  const { execFileSync } = await import("node:child_process");
  const outText = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const before = globalThis.fetch;
    const m = await import(${JSON.stringify(join(DIST, "auto.js"))});
    const o = await import(${JSON.stringify(join(DIST, "auto", "observe.js"))});
    console.log(JSON.stringify({ same: globalThis.fetch === before, state: m.default.status.state, sameRt: m.default === o.default, hasGenClass: typeof m.GenClass.init }));
  `], { encoding: "utf8" });
  const r = JSON.parse(outText.trim().split("\n").pop());
  check("K SSR: /auto in Node leaves fetch alone, inert runtime", r.same && r.state === "off" && r.sameRt && r.hasGenClass === "function", JSON.stringify(r));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
writeFileSync(join(process.env.INSTALL_OUT || HERE, "cdn-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exitCode = failed.length ? 1 : 0;
