// Overhead of GenClass (and of automatic state discovery) in Troy's production build: one guest flow per run in
// mobile Chromium with 4x CPU throttling, per variant:
//   off        ?genclass=off (nothing installed)
//   noauto     GenClass on, autoState: false (forced through window.GENCLASS_CONFIG)
//   on         GenClass on, the app's own setup (the one line: autoState on)
// Flow: /menu (read 2.5 s, switch tabs, open a dish, add it, close), then /order (watch the 5 s ticket poll).
// Per run: first-load JS of /menu (bytes on the wire before the load event), main-thread JS heap after a forced GC,
// long tasks (> 50 ms) and their total, React commit walks (count, p50/p95/max ms, over-budget) and discovered stores.
// Local only: requests to any host but 127.0.0.1 are aborted; telemetry is forced off.
//
//   node bench/heal/troy/overhead.mjs [--base http://127.0.0.1:3100] [--runs 5] [--variants off,noauto,on] [--out f.json]
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const PW = process.env.PLAYWRIGHT_MODULE ?? `${process.env.HOME}/GenClass-lib-merge/node_modules/playwright/index.mjs`;
const { chromium } = await import(PW);
const BASE = opt("base", "http://127.0.0.1:3100");
const RUNS = Number(opt("runs", "5"));
const VARIANTS = opt("variants", "off,noauto,on").split(",");
const OUT = opt("out", "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXTERNAL = new Set();

async function run(browser, variant) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (r) => {
    EXTERNAL.add(new URL(r.request().url()).origin);
    return r.abort();
  });
  await ctx.addInitScript(() => {
    const lt = (globalThis.__lt = []);
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) lt.push(e.duration);
      }).observe({ type: "longtask", buffered: true });
    } catch {
      /* ignore */
    }
  });
  const ov = variant === "off" ? null : { telemetry: false, ...(variant === "noauto" ? { autoState: false } : {}) };
  await ctx.addInitScript((o) => {
    if (!o) return;
    let cur = { ...o };
    Object.defineProperty(globalThis, "GENCLASS_CONFIG", { configurable: true, get: () => cur, set: (v) => (cur = { ...(v || {}), ...o, model: { ...((v && v.model) || {}) } }) });
  }, ov);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const reqType = new Map();
  let loaded = false;
  let jsBytes = 0;
  cdp.on("Network.requestWillBeSent", (e) => reqType.set(e.requestId, { type: e.type, early: !loaded }));
  cdp.on("Network.loadingFinished", (e) => {
    const r = reqType.get(e.requestId);
    if (r && r.early && r.type === "Script") jsBytes += e.encodedDataLength;
  });
  const q = (p) => `${BASE}${p}${p.includes("?") ? "&" : "?"}t=7${variant === "off" ? "&genclass=off" : ""}`;
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(q("/menu"), { waitUntil: "load" });
  loaded = true;
  const firstLoadKB = Math.round(jsBytes / 102.4) / 10;
  await sleep(2500);
  // browse: menu tabs, a dish, add it, close
  for (const name of [/Specials/i, /Halal/i, /Menu/i]) {
    const tab = page.getByRole("tab", { name }).first();
    if (await tab.count().catch(() => 0)) await tab.click().catch(() => {});
    await sleep(300);
  }
  await page.getByRole("button", { name: /^Farmer Skillet/ }).first().click().catch(() => {});
  const add = page.locator('[data-action="add_to_order"]').first();
  await add.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
  for (const g of await page.locator("[data-add-to-order] fieldset").all()) {
    const r = g.locator('[role="radio"]').first();
    if (await r.count()) await r.click().catch(() => {});
  }
  await add.click().catch(() => {});
  await sleep(1500);
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(500);
  await page.goto(q("/order"), { waitUntil: "load" });
  await sleep(7000);
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const heap = await cdp.send("Runtime.getHeapUsage").catch(() => null);
  const m = await page.evaluate(() => {
    const g = window.__genclass;
    const lt = globalThis.__lt ?? [];
    const st = g && typeof g.discoveryStats === "function" ? g.discoveryStats() : null;
    return {
      longTasks: lt.length,
      longTaskMs: Math.round(lt.reduce((a, b) => a + b, 0)),
      decisions: g ? g.decisions().length : null,
      stores: g && typeof g.stores === "function" ? g.stores().map((x) => `${x.name}:${x.kind}${x.source ? "/" + x.source : ""}:${x.fields}f:${x.version}w`) : [],
      walk: st?.react ? { commits: st.react.commits, overBudget: st.react.overBudget, visited: st.react.visited, samples: st.react.samples } : null,
    };
  });
  await ctx.close();
  return { variant, firstLoadKB, heapMB: heap ? Math.round((heap.usedSize / 1048576) * 100) / 100 : null, errors, ...m };
}

const browser = await chromium.launch({ headless: true });
const results = [];
for (let i = 0; i < RUNS; i++)
  for (const v of VARIANTS) {
    const r = await run(browser, v);
    results.push(r);
    const w = r.walk;
    console.log(`[${results.length}] ${v}: firstLoad ${r.firstLoadKB} KB, heap ${r.heapMB} MB, long tasks ${r.longTasks} (${r.longTaskMs} ms)${w ? `, commits ${w.commits}, walk total ${w.samples.reduce((a, b) => a + b, 0).toFixed(2)} ms` : ""}, stores ${r.stores.length}${r.errors.length ? ", page errors " + r.errors.length : ""}`);
  }
await browser.close();

const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : null);
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))] : null);
const summary = {};
for (const v of VARIANTS) {
  const rs = results.filter((r) => r.variant === v);
  const samples = rs.flatMap((r) => r.walk?.samples ?? []);
  summary[v] = {
    runs: rs.length,
    firstLoadKB: med(rs.map((r) => r.firstLoadKB)),
    heapMB: med(rs.map((r) => r.heapMB).filter((x) => x != null)),
    longTasks: med(rs.map((r) => r.longTasks)),
    longTaskMs: med(rs.map((r) => r.longTaskMs)),
    commits: med(rs.map((r) => r.walk?.commits ?? 0)),
    walkP50: pct(samples, 0.5),
    walkP95: pct(samples, 0.95),
    walkMax: samples.length ? Math.max(...samples) : null,
    walkTotalMsPerRun: med(rs.map((r) => (r.walk?.samples ?? []).reduce((a, b) => a + b, 0))),
    overBudget: rs.reduce((a, r) => a + (r.walk?.overBudget ?? 0), 0),
    stores: [...new Set(rs.flatMap((r) => r.stores.map((s) => s.split(":").slice(0, 2).join(":"))))],
    pageErrors: rs.reduce((a, r) => a + r.errors.length, 0),
  };
}
console.log(JSON.stringify(summary, null, 1));
console.log(EXTERNAL.size ? `blocked external origins: ${[...EXTERNAL].join(", ")}` : "no external requests");
if (OUT) {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, runs: RUNS, summary, external: [...EXTERNAL], raw: results }, null, 1));
}
