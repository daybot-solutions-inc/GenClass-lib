#!/usr/bin/env node
// End-to-end proof (train VM only; never on the Mac): a fresh Vite app installs the LOCAL @genclass/runtime tarball
// and the LOCAL @genclass/runtime-model tarball, and runs in headless Chromium (WASM). The app has a classic
// typeahead bug: it writes whatever response arrives last. Requests to the runtime's default model URL
// (https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/*) are answered from
// node_modules/@genclass/runtime-model/files/, onnxruntime-web's wasm from node_modules/onnxruntime-web/dist/, and the
// search API by page.route with per-query delays. Per mode (observe, guard):
//   A. clean typing, one key per settled response      -> expect 0 model calls
//   B. clean fast typing, responses in order            -> expect 0 model calls
//   C. out-of-order: an older response lands after a newer one (N trials) -> the decision, its diagnosis,
//      whether GenClass acted, what the user sees at the end, and the latency of each decision
//
//   RUNTIME_TGZ=... MODEL_TGZ=... node scripts/e2e.mjs        (WORK=/data/install/model-e2e, TRIALS=6)

import { chromium } from "@playwright/test";
import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "../../runtime/test/install/server.mjs";

const RUNTIME_TGZ = resolve(process.env.RUNTIME_TGZ ?? "");
const MODEL_TGZ = resolve(process.env.MODEL_TGZ ?? "");
const WORK = resolve(process.env.WORK || "/data/install/model-e2e");
const TRIALS = Number(process.env.TRIALS || 6);
for (const [k, v] of [["RUNTIME_TGZ", RUNTIME_TGZ], ["MODEL_TGZ", MODEL_TGZ]]) if (!v.endsWith(".tgz") || !existsSync(v)) throw new Error(`set ${k} to a .tgz`);

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", env: { ...process.env, CI: "1", npm_config_fund: "false", npm_config_audit: "false" } });

// ------------------------------------------------------------------------------------------------- app

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
sh("npx --yes create-vite@latest app --template vanilla-ts --no-interactive --no-immediate", WORK);
const APP = join(WORK, "app");
sh("npm install", APP);
sh(`npm install ${JSON.stringify(RUNTIME_TGZ)} ${JSON.stringify(MODEL_TGZ)}`, APP);
let versions = {};
try {
  const ls = JSON.parse(sh("npm ls @genclass/runtime @genclass/runtime-model onnxruntime-web vite --json --all", APP));
  const find = (deps, name) => deps?.[name]?.version ?? Object.values(deps ?? {}).map((d) => find(d.dependencies, name)).find(Boolean);
  versions = Object.fromEntries(["@genclass/runtime", "@genclass/runtime-model", "onnxruntime-web", "vite"].map((n) => [n, find(ls.dependencies, n)]));
} catch (e) {
  versions = { error: String(e.message).slice(0, 200) };
}

writeFileSync(
  join(APP, "index.html"),
  `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Typeahead</title></head>
  <body>
    <input id="q" aria-label="Search packages" autocomplete="off" />
    <ul id="results"></ul>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`,
);
writeFileSync(
  join(APP, "src", "main.ts"),
  `import genclass from "@genclass/runtime/auto";

// A typeahead with the classic bug: whichever response arrives last wins.
const search = genclass.atom("search", { query: "", results: [] as string[] });
const input = document.querySelector<HTMLInputElement>("#q")!;
const list = document.querySelector<HTMLUListElement>("#results")!;

search.subscribe((s) => {
  list.replaceChildren(...s.results.map((r) => Object.assign(document.createElement("li"), { textContent: r })));
  list.dataset.for = s.results.length ? s.results[0].split(" · ")[0] : "";
});

input.addEventListener("input", async () => {
  const q = input.value;
  search.set((s) => ({ ...s, query: q }));
  const res = await fetch(\`/api/search?q=\${encodeURIComponent(q)}\`);
  const data = (await res.json()) as { results: string[] };
  search.set((s) => ({ ...s, results: data.results }));
});

(window as unknown as { __rt: typeof genclass }).__rt = genclass;
`,
);
const build = sh("npm run build 2>&1", APP);
const dist = join(APP, "dist");
const MODEL_FILES = join(APP, "node_modules", "@genclass", "runtime-model", "files");
const ORT_DIST = join(APP, "node_modules", "onnxruntime-web", "dist");

// ------------------------------------------------------------------------------------------ self-hosting

// the package layout works with the runtime's own downloader: fetch-model from a server of files/, then info
const modelSrv = await serve({ mounts: { "/model/": MODEL_FILES } });
// (asynchronously: the file server runs in this process)
const run = async (cmd) => (await promisify(exec)(cmd, { cwd: APP, maxBuffer: 16 << 20 })).stdout;
let selfHost;
try {
  const fetched = await run(`npx genclass-runtime fetch-model public/genclass-model --from ${modelSrv.url}/model/ 2>&1`);
  const info = await run("npx genclass-runtime info public/genclass-model 2>&1");
  selfHost = { ok: !/MISMATCH|MISSING|WARNING/.test(info), fetched: fetched.trim().split("\n"), info: info.trim().split("\n") };
} catch (e) {
  selfHost = { ok: false, error: String(e.message).slice(0, 500) };
}
await modelSrv.close();

// --------------------------------------------------------------------------------------------- browser

const site = await serve({ mounts: { "/": dist } });
const browser = await chromium.launch();
const results = { versions, build: build.split("\n").filter((l) => /built in|dist\//.test(l)), selfHost, modes: {} };
console.log(`versions ${JSON.stringify(versions)}`);
console.log(`self-hosting (fetch-model + info): ${selfHost.ok ? "ok" : "FAILED"}\n  ${(selfHost.info ?? [selfHost.error]).join("\n  ")}`);

async function runMode(mode) {
  const ctx = await browser.newContext();
  const served = [];
  await ctx.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\//, (r) => {
    const u = new URL(r.request().url());
    let m;
    if ((m = /^\/npm\/@genclass\/runtime-model@0\.1\.0\/files\/([^/]+)$/.exec(u.pathname))) {
      served.push(m[1]);
      return r.fulfill({ path: join(MODEL_FILES, m[1]), headers: { "access-control-allow-origin": "*", "content-type": "application/octet-stream" } });
    }
    if ((m = /^\/npm\/onnxruntime-web@[^/]+\/dist\/([^/]+)$/.exec(u.pathname))) return r.fulfill({ path: join(ORT_DIST, m[1]), headers: { "access-control-allow-origin": "*" } });
    return r.abort();
  });
  const delays = new Map();
  const apiLog = [];
  await ctx.route(`${site.url}/api/search**`, async (r) => {
    const q = new URL(r.request().url()).searchParams.get("q") ?? "";
    const delay = delays.get(q) ?? 40;
    const t0 = Date.now();
    await new Promise((res) => setTimeout(res, delay));
    apiLog.push({ q, delay, at: t0 });
    const body = JSON.stringify({ query: q, results: q ? [1, 2, 3].map((i) => `${q} · result ${i}`) : [] });
    await r.fulfill({ status: 200, contentType: "application/json", body });
  });
  const page = await ctx.newPage();
  const consoleLines = [];
  const errors = [];
  page.on("console", (m) => {
    if (m.text().startsWith("[GenClass]")) consoleLines.push(m.text());
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${site.url}/?genclass=${mode}`);
  await page.waitForFunction(() => ["ready", "error"].includes(window.__rt?.status?.state), null, { timeout: 180_000 });
  const status = await page.evaluate(() => {
    const s = window.__rt.status;
    return { state: s.state, mode: window.__rt.mode, device: s.device, variant: s.variant, model: s.model, version: s.version, worker: s.worker, threads: s.threads, loadMs: s.loadMs, warmupMs: s.warmupMs, latency: s.latency, error: s.error, budget: window.__rt.holdBudgetMs(), situationChars: window.__rt.situationBudget() };
  });
  // the thresholds in force: r17-v2b ships its own (meta.json gate), so every source must be "model"
  status.gates = await page.evaluate(() => Object.fromEntries([undefined, "delivery", "mutation", "request", "stall", "failure"].map((t) => [t ?? "default", window.__rt.gates(t)])));
  await page.evaluate(() => {
    window.__ev = [];
    for (const k of ["decide", "detect", "act"]) window.__rt.on(k, (x) => window.__ev.push({ k, id: x.id, decisionId: x.decisionId }));
  });
  const decisions = () => page.evaluate(() => window.__rt.decisions(500).map((d) => ({ id: d.id, trigger: d.trigger, subject: d.subject, diagnosis: d.diagnosis, diagnosisConfidence: d.diagnosisConfidence, action: d.action, confidence: d.confidence, candidate: d.candidate, mass: d.mass, executed: d.executed, reason: d.reason, latencyMs: d.latencyMs, tier: d.tier, threshold: d.threshold, thresholdSource: d.thresholdSource, reportThreshold: window.__rt.gates(d.trigger).report })));
  const events = () => page.evaluate(() => window.__ev.slice());
  const shown = () => page.evaluate(() => document.getElementById("results").dataset.for);
  const settle = (ms) => page.waitForTimeout(ms);
  const input = page.locator("#q");
  const clear = async () => {
    await input.fill("");
    await settle(400);
  };

  // A. clean typing: each keystroke's response lands before the next key
  const out = { status, served: [...new Set(served)] };
  let before = (await decisions()).length;
  await input.click();
  for (const ch of "react") {
    await page.keyboard.type(ch);
    await settle(350);
  }
  out.cleanSlow = { keys: 5, modelCalls: (await decisions()).length - before, shown: await shown() };

  // B. clean fast typing: keys 60 ms apart, every response 120 ms, so they overlap but land in order
  await clear();
  before = (await decisions()).length;
  for (const q of ["s", "sv", "sve", "svel", "svelt", "svelte"]) delays.set(q, 120);
  await page.keyboard.type("svelte", { delay: 60 });
  await settle(1500);
  out.cleanFast = { keys: 6, modelCalls: (await decisions()).length - before, shown: await shown() };

  // C. out-of-order: the response for the older query lands ~1.4 s after the newer one
  const words = ["angular", "preact", "vitest", "lodash", "express", "webpack", "postcss", "eslint"];
  out.trials = [];
  for (let i = 0; i < TRIALS; i++) {
    const w = words[i % words.length];
    await clear();
    const slowPrefix = w.slice(0, w.length - 2);
    for (const ch of slowPrefix) {
      await page.keyboard.type(ch);
      await settle(250);
    }
    const older = w.slice(0, w.length - 1);
    delays.set(older, 1500);
    delays.set(w, 80);
    const evBefore = (await events()).length;
    const decBefore = (await decisions()).length;
    await page.keyboard.type(w[w.length - 2]); // older query, slow response
    await settle(150);
    await page.keyboard.type(w[w.length - 1]); // newer query, fast response
    await page.waitForFunction((q) => document.getElementById("results").dataset.for === q, w, { timeout: 5000 }).catch(() => undefined);
    const shownAfterNewer = await shown();
    await settle(1500 + 2500); // the older response lands, then any late decision
    const ds = (await decisions()).slice(decBefore);
    const ev = (await events()).slice(evBefore);
    const acted = ev.filter((e) => e.k === "act");
    out.trials.push({
      word: w,
      older,
      newer: w,
      shownAfterNewer,
      shownAtEnd: await shown(),
      correctAtEnd: (await shown()) === w,
      decisions: ds,
      detections: ev.filter((e) => e.k === "detect").length,
      // a detection is exactly a decision whose top diagnosis is not "expected" with p >= gate.report
      detectionsByRule: ds.filter((d) => d.diagnosis !== "expected" && d.diagnosisConfidence >= d.reportThreshold).length,
      detectedIds: ev.filter((e) => e.k === "detect").map((e) => e.id),
      actions: acted.length,
    });
  }
  out.consoleLines = consoleLines.slice(0, 40);
  out.errors = errors;
  out.apiCalls = apiLog.length;
  await ctx.close();
  return out;
}

try {
  for (const mode of ["observe", "guard"]) {
    console.log(`=== ${mode}`);
    const r = await runMode(mode);
    results.modes[mode] = r;
    const s = r.status;
    console.log(`model ${s.state} ${s.model ?? ""} ${s.version ?? ""} device=${s.device} variant=${s.variant} worker=${s.worker} threads=${s.threads} load=${s.loadMs}ms warmup=${s.warmupMs}ms holdBudget=${s.budget}ms situation=${s.situationChars} chars ${s.error ?? ""}`);
    console.log(`served from the default URL path: ${r.served.join(", ")}`);
    for (const [t, g] of Object.entries(s.gates)) console.log(`gates ${t.padEnd(8)} report ${g.report} (${g.source.report})  guard ${g.guard} (${g.source.guard})  heal ${g.heal} (${g.source.heal})`);
    console.log(`clean slow typing: ${r.cleanSlow.modelCalls} model calls; clean fast typing: ${r.cleanFast.modelCalls} model calls`);
    for (const t of r.trials) {
      const d = t.decisions.map((x) => `${x.trigger}:${x.diagnosis} ${x.diagnosisConfidence?.toFixed(2)} -> ${x.action} ${x.confidence?.toFixed(2)}${x.executed ? " EXECUTED" : ""} ${Math.round(x.latencyMs)}ms [threshold ${x.threshold ?? "-"} ${x.thresholdSource ?? ""}]${x.reason ? ` (${x.reason})` : ""}`).join(" | ");
      console.log(`trial ${t.word}: decisions=${t.decisions.length} detections=${t.detections} (by gate.report rule ${t.detectionsByRule}) actions=${t.actions} shown=${t.shownAtEnd} correct=${t.correctAtEnd} :: ${d}`);
    }
    if (r.errors.length) console.log(`console errors: ${r.errors.slice(0, 5).join(" | ")}`);
  }
} finally {
  await browser.close();
  await site.close();
}
const outFile = join(process.env.INSTALL_OUT || WORK, "model-e2e-results.json");
writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`results -> ${outFile}`);
