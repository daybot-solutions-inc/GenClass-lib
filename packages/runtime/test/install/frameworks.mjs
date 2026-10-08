// Real-framework install test (VM only): for each scaffold made by scaffold.sh,
//   copy it -> `npx <tarball> init --yes --from <tarball>` -> init again (must change nothing) -> build ->
//   production server + headless Chromium -> dev server + Chromium -> `npx <tarball> remove --yes` -> every file
//   back byte for byte.
// In Chromium the jsDelivr defaults (the model package, which is not published yet, and onnxruntime-web's wasm) are
// served from local copies, so "[GenClass] Model ready" proves the framework bundled the model worker.
//
//   TGZ=/data/install/genclass-runtime-<v>.tgz node test/install/frameworks.mjs [name ...]
//   SCAFFOLDS (default /data/install/scaffolds), WORK (default /data/install/work), GENCLASS_MODEL_DIR,
//   INSTALL_OUT (results directory, default /data/install), SKIP_DEV=1

import { chromium } from "@playwright/test";
import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..", "..");
const TGZ = resolve(process.env.TGZ ?? "");
const SCAFFOLDS = process.env.SCAFFOLDS || "/data/install/scaffolds";
const WORK = process.env.WORK || "/data/install/work";
const OUT = process.env.INSTALL_OUT || "/data/install";
const MODEL = resolve(process.env.GENCLASS_MODEL_DIR || join(homedir(), "gcl/model/.cache-model"));
const ORT = dirname(createRequire(join(PKG, "package.json")).resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm"));
if (!existsSync(TGZ) || !TGZ.endsWith(".tgz")) throw new Error("set TGZ to the packed tarball");

const IGNORE = /(^|\/)(node_modules|\.git|\.next|dist|build|out|\.svelte-kit|\.astro|\.output|\.nuxt|\.angular|\.vite|\.react-router|\.cache|coverage|\.turbo)(\/|$)|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|next-env\.d\.ts|tsconfig\.tsbuildinfo)$/;

// The extracted tarball, served as a CDN for the plain-HTML project.
const PKG_X = join(WORK, "_pkg");
rmSync(PKG_X, { recursive: true, force: true });
mkdirSync(PKG_X, { recursive: true });
execSync(`tar -xzf ${JSON.stringify(TGZ)} -C ${JSON.stringify(PKG_X)}`);
const cdn = await serve({ mounts: { "/pkg/": join(PKG_X, "package") }, cors: true });
// npx caches by spec: a fresh file name per run so it never runs an older build. `npx file:<tgz> init` picks the
// package's only bin exactly like `npx @genclass/runtime init`.
const RUN_TGZ = join(PKG_X, `genclass-runtime-${Date.now()}.tgz`);
cpSync(TGZ, RUN_TGZ);
const NPX = (args) => `npx --yes ${JSON.stringify(`file:${RUN_TGZ}`)} ${args}`;

// pnpm (scaffold.sh installs it under SCAFFOLDS/.pnpm): init must find it on PATH like on a developer's machine
process.env.PATH = `${join(SCAFFOLDS, ".bin")}:${process.env.PATH}`;

const vitePreview = "npx vite preview --port {port} --strictPort --host 127.0.0.1";
const viteDev = "npx vite --port {port} --strictPort --host 127.0.0.1";
const FRAMEWORKS = {
  "vite-react-ts": { build: "npm run build", prod: vitePreview, dev: viteDev },
  "vite-react-pnpm": { build: "pnpm run build", prod: vitePreview, dev: viteDev },
  "vite-vue": { build: "npm run build", prod: vitePreview, dev: viteDev },
  "vite-svelte-ts": { build: "npm run build", prod: vitePreview, dev: viteDev },
  "next-app": { build: "npm run build", prod: "npx next start -p {port} -H 127.0.0.1", dev: "npx next dev -p {port} -H 127.0.0.1" },
  "next-app-layout": { scaffold: "next-app", init: ["--strategy", "layout"], build: "npm run build", prod: "npx next start -p {port} -H 127.0.0.1", dev: "npx next dev -p {port} -H 127.0.0.1" },
  "next-pages-js": { build: "npm run build", prod: "npx next start -p {port} -H 127.0.0.1", dev: "npx next dev -p {port} -H 127.0.0.1" },
  "next-pages-legacy": { scaffold: "next-pages-js", init: ["--strategy", "pages"], build: "npm run build", prod: "npx next start -p {port} -H 127.0.0.1", dev: null },
  cra: { build: "npm run build", prod: { static: "build" }, dev: "npx react-scripts start", env: { BROWSER: "none", PORT: "{port}", HOST: "127.0.0.1" } },
  sveltekit: { build: "npm run build", prod: vitePreview, dev: "npx vite dev --port {port} --strictPort --host 127.0.0.1" },
  astro: { build: "npm run build", prod: "npx astro preview --port {port} --host 127.0.0.1", dev: "npx astro dev --port {port} --host 127.0.0.1" },
  nuxt: { build: "npm run build", prod: "node .output/server/index.mjs", dev: "npx nuxi dev --port {port} --host 127.0.0.1", env: { PORT: "{port}", HOST: "127.0.0.1", NITRO_PORT: "{port}", NITRO_HOST: "127.0.0.1" } },
  "react-router": { build: "npm run build", prod: "npx react-router-serve ./build/server/index.js", dev: "npx react-router dev --port {port} --host 127.0.0.1", env: { PORT: "{port}", HOST: "127.0.0.1" } },
  angular: { build: "npx ng build", prod: { static: "dist/*/browser" }, dev: "npx ng serve --port {port} --host 127.0.0.1" },
  "plain-html": { build: null, prod: { static: "." }, dev: null, prodDevtools: true, init: ["--cdn", `${cdn.url}/pkg/dist/genclass.global.min.js`] },
};

// -------------------------------------------------------------------------------------------- helpers

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
function snapshot(dir) {
  const files = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (IGNORE.test(rel)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files[rel] = sha(readFileSync(p));
    }
  };
  walk(dir);
  return files;
}
function diffSnap(a, b) {
  const changed = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) changed.push(`${k}${!(k in a) ? " (new)" : !(k in b) ? " (deleted)" : ""}`);
  return changed.sort();
}

function sh(cmd, cwd, { timeout = 900_000, env = {} } = {}) {
  const t0 = Date.now();
  try {
    const out = execSync(cmd, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", NG_CLI_ANALYTICS: "false", ...env }, maxBuffer: 64 << 20 });
    return { ok: true, out, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`, ms: Date.now() - t0, code: e.status };
  }
}

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
    await new Promise((r) => setTimeout(r, 750));
  }
  return false;
}

const fill = (s, port) => String(s).replace(/\{port\}/g, String(port));

/** Starts a server command (or a static server); returns { url, stop, log }. */
async function startServer(spec, cwd, env = {}) {
  const port = await freePort();
  if (typeof spec === "object" && spec.static) {
    let root = join(cwd, spec.static);
    if (spec.static.includes("*")) {
      const [a, b] = spec.static.split("*");
      const base = join(cwd, a);
      const sub = readdirSync(base).find((d) => existsSync(join(base, d, b)));
      root = join(base, sub ?? "", b);
    }
    const s = await serve({ mounts: { "/": root }, port, fallback: join(root, "index.html") });
    return { url: s.url, stop: () => s.close(), log: () => "" };
  }
  let log = "";
  const e = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fill(v, port)]));
  const child = spawn(fill(spec, port), { cwd, shell: true, detached: true, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", NG_CLI_ANALYTICS: "false", ...e } });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  const up = await waitHttp(url, 240_000);
  const stop = async () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* gone */
    }
    await new Promise((r) => setTimeout(r, 800));
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  };
  if (!up) {
    await stop();
    throw new Error(`server did not start: ${fill(spec, port)}\n${log.slice(-1500)}`);
  }
  return { url, stop, log: () => log };
}

let browser;
async function visit(url, { expectDevtools }) {
  const ctx = await browser.newContext();
  await ctx.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\//, (r) => {
    const u = new URL(r.request().url());
    let m;
    if ((m = /^\/npm\/@genclass\/runtime-model@[^/]+\/files\/(.+)$/.exec(u.pathname))) return r.fulfill({ path: join(MODEL, m[1]), headers: { "access-control-allow-origin": "*" } });
    if ((m = /^\/npm\/onnxruntime-web@[^/]+\/dist\/(.+)$/.exec(u.pathname))) return r.fulfill({ path: join(ORT, m[1]), headers: { "access-control-allow-origin": "*" } });
    return r.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  const lines = [];
  const workers = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    lines.push(`${m.type()}: ${m.text()}`);
    if (m.type() === "error" && !/favicon/.test(`${m.text()} ${m.location()?.url ?? ""}`)) errors.push(m.text());
  });
  page.on("worker", (w) => {
    workers.push(w.url());
    w.on("console", (m) => m.type() === "error" && errors.push(`worker: ${m.text()}`));
  });
  const r = {};
  try {
    await page.goto(url, { waitUntil: "load", timeout: 120_000 });
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000 && !lines.some((l) => l.includes("[GenClass] Model ready") || l.includes("[GenClass] Model unavailable"))) await page.waitForTimeout(500);
    if (expectDevtools) await page.waitForSelector("genclass-devtools", { timeout: 30_000, state: "attached" }).catch(() => undefined);
    else await page.waitForTimeout(1500);
    Object.assign(
      r,
      await page.evaluate(() => ({
        fetchWrapped: !/\[native code\]/.test(Function.prototype.toString.call(window.fetch)),
        devtools: !!document.querySelector("genclass-devtools"),
      })),
    );
  } catch (e) {
    errors.push(`visit: ${e.message}`);
  }
  r.modelReady = lines.find((l) => l.includes("[GenClass] Model ready"))?.replace(/^info: /, "") ?? null;
  r.modelUnavailable = lines.find((l) => l.includes("[GenClass] Model unavailable")) ?? null;
  r.workers = workers;
  r.errors = errors;
  await ctx.close();
  return r;
}

// ----------------------------------------------------------------------------------------------- run

async function runOne(name) {
  const fw = FRAMEWORKS[name];
  const res = { name, steps: {} };
  const scaffoldName = fw.scaffold ?? name;
  const src = join(SCAFFOLDS, scaffoldName);
  const status = existsSync(`${src}.status`) ? readFileSync(`${src}.status`, "utf8").trim() : "missing";
  res.scaffold = status;
  if (!status.startsWith("ok") || !existsSync(src)) {
    res.skipped = `scaffold ${scaffoldName}: ${status}`;
    return res;
  }
  const dir = join(WORK, name);
  rmSync(dir, { recursive: true, force: true });
  cpSync(src, dir, { recursive: true, verbatimSymlinks: true });
  const before = snapshot(dir);
  const pkgBefore = existsSync(join(dir, "package.json")) ? readFileSync(join(dir, "package.json"), "utf8") : null;

  const initCmd = NPX(`init --yes --from ${JSON.stringify(RUN_TGZ)} ${(fw.init ?? []).map((a) => JSON.stringify(a)).join(" ")}`);
  const init = sh(initCmd, dir);
  const afterInit = snapshot(dir);
  res.steps.init = { ok: init.ok, ms: init.ms, changed: diffSnap(before, afterInit), out: init.ok ? undefined : init.out.slice(-3000) };
  res.initOutput = init.out;
  if (!init.ok) return res;

  const again = sh(initCmd, dir);
  const afterAgain = snapshot(dir);
  res.steps.idempotent = { ok: again.ok && /Nothing to do/.test(again.out) && diffSnap(afterInit, afterAgain).length === 0, changed: diffSnap(afterInit, afterAgain) };

  if (fw.build) {
    const b = sh(fw.build, dir, { timeout: 1_200_000 });
    res.steps.build = { ok: b.ok, ms: b.ms, out: b.ok ? undefined : b.out.slice(-4000) };
  }
  if (!fw.build || res.steps.build.ok) {
    try {
      const s = await startServer(fw.prod, dir, fw.env);
      try {
        res.steps.prod = await visit(`${s.url}/`, { expectDevtools: false });
      } finally {
        await s.stop();
      }
    } catch (e) {
      res.steps.prod = { error: e.message.slice(0, 3000) };
    }
  }
  if (fw.dev && !process.env.SKIP_DEV) {
    try {
      const s = await startServer(fw.dev, dir, fw.env);
      try {
        // A dev server's first load may re-optimize newly added dependencies and reload (Vite); judge a warm load
        // and keep the cold one's errors in the results.
        const cold = await visit(`${s.url}/`, { expectDevtools: true });
        res.steps.dev = await visit(`${s.url}/`, { expectDevtools: true });
        res.steps.dev.coldErrors = cold.errors;
        res.steps.dev.coldWorkers = cold.workers.length;
      } finally {
        await s.stop();
      }
    } catch (e) {
      res.steps.dev = { error: e.message.slice(0, 3000) };
    }
  }

  const rm = sh(NPX("remove --yes"), dir);
  const afterRemove = snapshot(dir);
  const pkgAfter = existsSync(join(dir, "package.json")) ? readFileSync(join(dir, "package.json"), "utf8") : null;
  res.steps.remove = {
    ok: rm.ok,
    restored: diffSnap(before, afterRemove).length === 0,
    mismatched: diffSnap(before, afterRemove),
    packageJsonByteEqual: pkgBefore === pkgAfter,
    out: rm.ok ? undefined : rm.out.slice(-2000),
  };
  return res;
}

function verdict(r) {
  if (r.skipped) return "SKIP";
  const s = r.steps;
  // production builds never mount the overlay; the plain-HTML tag uses data-devtools="local", which does on 127.0.0.1
  const prodOk = s.prod && !s.prod.error && s.prod.modelReady && s.prod.fetchWrapped && s.prod.devtools === !!FRAMEWORKS[r.name].prodDevtools && s.prod.errors.length === 0;
  const devOk = !s.dev || (!s.dev.error && s.dev.devtools && s.dev.fetchWrapped && s.dev.errors.length === 0);
  const ok = s.init?.ok && s.idempotent?.ok && (s.build === undefined || s.build.ok) && prodOk && devOk && s.remove?.ok && s.remove?.restored;
  return ok ? "PASS" : "FAIL";
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(FRAMEWORKS);
mkdirSync(WORK, { recursive: true });
browser = await chromium.launch();
const all = [];
const resultsFile = join(OUT, "frameworks-results.json");
try {
  for (const name of names) {
    if (!FRAMEWORKS[name]) {
      console.log(`unknown framework ${name}`);
      continue;
    }
    console.log(`=== ${name}`);
    let r;
    try {
      r = await runOne(name);
    } catch (e) {
      r = { name, error: e.stack };
    }
    r.verdict = r.error ? "FAIL" : verdict(r);
    all.push(r);
    const s = r.steps ?? {};
    console.log(
      `${r.verdict} ${name}: ${r.skipped ?? ""}${r.error ? `error ${r.error.slice(0, 300)}` : ""} init=${s.init?.ok} changed=[${s.init?.changed?.join(", ") ?? ""}] idempotent=${s.idempotent?.ok} build=${s.build ? `${s.build.ok} ${Math.round(s.build.ms / 1000)}s` : "-"} ` +
        `prod={ready:${!!s.prod?.modelReady} workers:${s.prod?.workers?.length ?? "-"} fetch:${s.prod?.fetchWrapped} devtools:${s.prod?.devtools} errors:${s.prod?.errors?.length ?? s.prod?.error ?? "-"}} ` +
        `dev={ready:${!!s.dev?.modelReady} workers:${s.dev?.workers?.length ?? "-"} devtools:${s.dev?.devtools} errors:${s.dev?.errors?.length ?? s.dev?.error ?? "-"} coldErrors:${s.dev?.coldErrors?.length ?? "-"}} ` +
        `remove={restored:${s.remove?.restored} pkg.json bytes:${s.remove?.packageJsonByteEqual}}`,
    );
    writeFileSync(resultsFile, JSON.stringify({ at: new Date().toISOString(), tgz: TGZ, results: all }, null, 2));
  }
} finally {
  await browser.close();
  await cdn.close();
}
const failed = all.filter((r) => r.verdict === "FAIL").length;
console.log(`\n${all.filter((r) => r.verdict === "PASS").length} pass, ${failed} fail, ${all.filter((r) => r.verdict === "SKIP").length} skipped -> ${resultsFile}`);
process.exitCode = failed ? 1 : 0;
