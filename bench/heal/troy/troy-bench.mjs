// Troy (troy.daybot.ca dev copy, ~/troy-bot-genclass, branch dev/genclass) under injected network faults.
//
// Local only. Drives the production build (`next start -H 127.0.0.1`) in headless Chromium with real input, injects
// faults with Playwright route interception (the page and GenClass see them as real network behaviour), and scores
// each trial from the server's truth, read through the context's own request API (same visitor cookie; invisible to
// the page, so GenClass never observes the oracle).
//
// Modes: off (?genclass=off: nothing installed, the baseline), observe, guard, heal. The mode, aggressiveness and
// `telemetry: false` are forced through window.GENCLASS_CONFIG (a setter installed before any page script merges our
// override into whatever the app's genclass.config.ts assigns). Every request to a host other than 127.0.0.1 is
// aborted and counted (none expected: the model and ORT are self-hosted in public/genclass-model/).
//
//   node bench/heal/troy/troy-bench.mjs [--base http://127.0.0.1:3000] [--modes off,observe,guard,heal]
//        [--reps 3] [--scenarios a,b] [--aggr balanced] [--workers 3] [--out file.json] [--tag name]
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const PW = process.env.PLAYWRIGHT_MODULE ?? `${process.env.HOME}/GenClass-lib-merge/node_modules/playwright/index.mjs`;
const { chromium } = await import(PW);
const BASE = opt("base", "http://127.0.0.1:3000");
const MODES = opt("modes", "off,observe,guard,heal").split(",");
const REPS = Number(opt("reps", "3"));
const WORKERS = Number(opt("workers", "3"));
const AGGR = opt("aggr", "");
const TAG = opt("tag", "");
const OUT = opt("out", "");
/** Extra GenClass.init options for the GenClass modes, as JSON (e.g. '{"policy":{"idempotencyBodyFields":["request_id"]}}'). */
const EXTRA = JSON.parse(opt("config", "{}"));
const TABLE = "7";
const DISH = /^Farmer Skillet/;
const DISH2 = /^Belgian Waffle/;
/** Reading time after each page load (the model loads in ~1 s; decisions before it is ready fail open). */
const BROWSE_MS = Number(opt("browse", "2500"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ------------------------------------------------------------------------------------------------ helpers
async function serverOrder(ctx) {
  // the visitor cookie is Secure: the API request context does not send it over http, so pass it explicitly
  const cookie = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const r = await ctx.request.get(`${BASE}/api/orders/current`, { headers: { accept: "application/json", cookie } });
  const j = await r.json().catch(() => ({}));
  return j.order ?? null;
}
const lines = (o) => o?.lines ?? [];
const qtyOf = (o, re) => lines(o).filter((l) => re.test(l.name ?? "")).reduce((a, l) => a + (l.quantity ?? 1), 0);

async function openDish(page, re) {
  await page.getByRole("button", { name: re }).first().click();
  const add = page.locator('[data-action="add_to_order"]').first();
  await add.waitFor({ state: "visible", timeout: 8000 });
  // required choice groups: pick the first option of each
  for (const g of await page.locator("[data-add-to-order] fieldset").all()) {
    const r = g.locator('[role="radio"]').first();
    if (await r.count()) await r.click();
  }
  return add;
}
async function chipCount(page) {
  const t = await page.locator('[data-order-chip="menu"]').first().textContent({ timeout: 50 }).catch(() => null);
  const m = t && t.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}
async function closeSheet(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(250);
}

/** Open a page and give the guest a moment to read it (and GenClass time to load its model, as in real use). */
async function visit(page, href) {
  await page.goto(href);
  await sleep(BROWSE_MS);
}

/** Wait until pred() or timeout; returns ms waited or null. */
async function until(pred, timeout = 8000, step = 25) {
  const t0 = now();
  while (now() - t0 < timeout) {
    if (await pred()) return now() - t0;
    await sleep(step);
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ faults
/** Lost commit: the request reaches the server (side effects stay), the client gets a 502. First n matching only. */
function lostCommit(ctx, method, re, n = 1) {
  let left = n;
  return ctx.route(re, async (route) => {
    if (route.request().method() !== method || left <= 0) return route.fallback();
    left--;
    await route.fetch().catch(() => null);
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Bad gateway" } }) });
  });
}
/** Transient 5xx before handling (no side effects). */
function transient(ctx, method, re, n = 1, status = 503) {
  let left = n;
  return ctx.route(re, async (route) => {
    if (route.request().method() !== method || left <= 0) return route.fallback();
    left--;
    await sleep(120);
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Service unavailable" } }) });
  });
}
/** Slow: delay every matching response (fetched first, so the content is what the server said at send time). */
function slow(ctx, method, re, ms) {
  return ctx.route(re, async (route) => {
    if (method !== "*" && route.request().method() !== method) return route.fallback();
    const res = await route.fetch().catch(() => null);
    await sleep(ms);
    if (!res) return route.abort();
    await route.fulfill({ response: res });
  });
}

// ------------------------------------------------------------------------------------------------ scenarios
// Each returns { bug: boolean, reasons: string[], latencyMs?: number, metrics }. kind: clean | fault.
const SCENARIOS = {
  /** Clean: add one dish. */
  "add-once": {
    kind: "clean",
    async run({ page, ctx, url }) {
      await visit(page, url("/menu"));
      const add = await openDish(page, DISH);
      const t0 = now();
      await add.click();
      const lat = await until(async () => (await chipCount(page)) >= 1, 8000);
      await sleep(1200);
      const o = await serverOrder(ctx);
      const q = qtyOf(o, DISH);
      const reasons = [];
      if (q !== 1) reasons.push(`server qty ${q} (want 1)`);
      if (lat === null) reasons.push("chip never showed the order");
      return { bug: reasons.length > 0, reasons, latencyMs: lat === null ? null : lat, metrics: { qty: q }, t0 };
    },
  },
  /** Clean: two different dishes in a row. */
  "add-two": {
    kind: "clean",
    async run({ page, ctx, url }) {
      await visit(page, url("/menu"));
      let add = await openDish(page, DISH);
      await add.click();
      await until(async () => (await chipCount(page)) >= 1, 8000);
      await closeSheet(page);
      add = await openDish(page, DISH2);
      const t0 = now();
      await add.click();
      const lat = await until(async () => (await chipCount(page)) >= 2, 8000);
      await sleep(1200);
      const o = await serverOrder(ctx);
      const q1 = qtyOf(o, DISH), q2 = qtyOf(o, DISH2);
      const reasons = [];
      if (q1 !== 1 || q2 !== 1) reasons.push(`server qty ${q1}+${q2} (want 1+1)`);
      if ((await chipCount(page)) !== 2) reasons.push(`chip shows ${await chipCount(page)} (want 2)`);
      return { bug: reasons.length > 0, reasons, latencyMs: lat, metrics: { qty: q1 + q2 }, t0 };
    },
  },
  /** Clean: the ticket page with two lines; the guest removes one; the 5 s poll keeps running. */
  "order-remove": {
    kind: "clean",
    async run({ page, ctx, url }) {
      await seedOrder(page, ctx, url);
      await visit(page, url("/order"));
      return removeAndWatch(page, ctx, { wait: 6500 });
    },
  },
  /** Fault: the add commits on the server, the response is lost (502); the guest taps Add again. */
  "add-lost-commit": {
    kind: "fault",
    async run({ page, ctx, url }) {
      await visit(page, url("/menu"));
      await lostCommit(ctx, "POST", /\/api\/orders\/current\/items$/);
      const add = await openDish(page, DISH);
      await add.click();
      await until(async () => (await page.locator('[data-add-to-order] [role="alert"]').count()) > 0, 6000);
      await sleep(900);
      const t0 = now();
      if (await add.isVisible().catch(() => false)) await add.click().catch(() => {});
      const lat = await until(async () => (await chipCount(page)) >= 1, 8000);
      await sleep(1500);
      const o = await serverOrder(ctx);
      const q = qtyOf(o, DISH);
      const reasons = [];
      if (q > 1) reasons.push(`duplicate order: server qty ${q} (want 1)`);
      if (q === 0) reasons.push("order lost");
      const shown = await chipCount(page);
      if (shown !== q) reasons.push(`chip shows ${shown}, server has ${q}`);
      return { bug: reasons.length > 0, reasons, latencyMs: lat, metrics: { qty: q, shown }, t0 };
    },
  },
  /** Fault: the first add fails with a 503 before the server handles it; the guest taps Add again. */
  "add-transient-5xx": {
    kind: "fault",
    async run({ page, ctx, url }) {
      await visit(page, url("/menu"));
      await transient(ctx, "POST", /\/api\/orders\/current\/items$/);
      const add = await openDish(page, DISH);
      await add.click();
      await until(async () => (await page.locator('[data-add-to-order] [role="alert"]').count()) > 0, 6000);
      await sleep(900);
      const t0 = now();
      if (await add.isVisible().catch(() => false)) await add.click().catch(() => {});
      const lat = await until(async () => (await chipCount(page)) >= 1, 8000);
      await sleep(1500);
      const o = await serverOrder(ctx);
      const q = qtyOf(o, DISH);
      const reasons = [];
      if (q !== 1) reasons.push(`server qty ${q} (want 1)`);
      return { bug: reasons.length > 0, reasons, latencyMs: lat, metrics: { qty: q }, t0 };
    },
  },
  /** Fault: slow add (2.5 s); an impatient guest double-taps. */
  "add-slow-doubletap": {
    kind: "fault",
    async run({ page, ctx, url }) {
      await visit(page, url("/menu"));
      await slow(ctx, "POST", /\/api\/orders\/current\/items$/, 2500);
      const add = await openDish(page, DISH);
      const t0 = now();
      await add.click();
      await sleep(140);
      await add.click({ timeout: 400 }).catch(() => {});
      const lat = await until(async () => (await chipCount(page)) >= 1, 9000);
      await sleep(1500);
      const o = await serverOrder(ctx);
      const q = qtyOf(o, DISH);
      const reasons = [];
      if (q !== 1) reasons.push(`server qty ${q} (want 1)`);
      return { bug: reasons.length > 0, reasons, latencyMs: lat, metrics: { qty: q }, t0 };
    },
  },
  /** Fault: out of order. A ticket poll is answered late (3 s) with the pre-removal ticket, after the DELETE's answer. */
  "order-poll-reorder": {
    kind: "fault",
    async run({ page, ctx, url }) {
      await seedOrder(page, ctx, url);
      let held = 0;
      await ctx.route(/\/api\/orders\/current(\?.*)?$/, async (route) => {
        if (route.request().method() !== "GET" || held >= 1) return route.fallback();
        held++;
        const res = await route.fetch().catch(() => null);
        await sleep(3000);
        if (!res) return route.abort();
        await route.fulfill({ response: res });
      });
      await visit(page, url("/order"));
      // the first poll goes out ~5 s after load and is held 3 s; remove a line while it is held
      return removeAndWatch(page, ctx, { before: 5600, wait: 5000 });
    },
  },
  /** Fault: the removal fails once with 503 (not handled); the guest taps × again. */
  "order-remove-5xx": {
    kind: "fault",
    async run({ page, ctx, url }) {
      await seedOrder(page, ctx, url);
      await transient(ctx, "DELETE", /\/api\/orders\/current\/items\/[^/]+$/);
      await visit(page, url("/order"));
      return removeAndWatch(page, ctx, { retry: true, wait: 6500 });
    },
  },
  /** Fault: every order API answer is 900 ms slow; add two dishes quickly. */
  "slow-all": {
    kind: "fault",
    async run({ page, ctx, url }) {
      await visit(page, url("/menu"));
      await slow(ctx, "*", /\/api\/orders\//, 900);
      let add = await openDish(page, DISH);
      await add.click();
      await until(async () => (await chipCount(page)) >= 1, 9000);
      await closeSheet(page);
      add = await openDish(page, DISH2);
      const t0 = now();
      await add.click();
      const lat = await until(async () => (await chipCount(page)) >= 2, 9000);
      await sleep(1500);
      const o = await serverOrder(ctx);
      const q1 = qtyOf(o, DISH), q2 = qtyOf(o, DISH2);
      const reasons = [];
      if (q1 !== 1 || q2 !== 1) reasons.push(`server qty ${q1}+${q2} (want 1+1)`);
      const shown = await chipCount(page);
      if (shown !== q1 + q2) reasons.push(`chip shows ${shown}, server has ${q1 + q2}`);
      return { bug: reasons.length > 0, reasons, latencyMs: lat, metrics: { qty: q1 + q2 }, t0 };
    },
  },
};

/** Two dishes through the API (same visitor cookie), so /order opens with a ticket. */
async function seedOrder(page, ctx, url) {
  await visit(page, url("/menu"));
  for (const re of [DISH, DISH2]) {
    const add = await openDish(page, re);
    await add.click();
    await sleep(700);
    await closeSheet(page);
  }
  await until(async () => (await chipCount(page)) >= 2, 6000);
}

/** On /order: remove the first line; watch the ticket for stale content (the removed line shown again). */
async function removeAndWatch(page, ctx, { before = 1200, wait = 6000, retry = false } = {}) {
  await page.locator("li[data-line]").first().waitFor({ timeout: 8000 }).catch(() => {});
  await sleep(before);
  const lineSel = "li[data-line]:not([data-removed])";
  const n0 = await page.locator(lineSel).count();
  const rm = page.locator("li[data-line]:not([data-removed]) button").first();
  const t0 = now();
  await rm.click({ timeout: 3000 }).catch(() => {});
  let stale = 0, sawOne = false, staleMs = 0;
  let removedAt = null;
  const tEnd = now() + wait;
  while (now() < tEnd) {
    const n = await page.locator(lineSel).count();
    if (n < n0) {
      if (removedAt === null) removedAt = now() - t0;
      sawOne = true;
    } else if (sawOne && n >= n0) {
      stale++;
      staleMs += 50;
    }
    if (retry && !sawOne && now() - t0 > 2200 && now() - t0 < 2300) await rm.click({ timeout: 1000 }).catch(() => {});
    await sleep(50);
  }
  const o = await serverOrder(ctx);
  const nServer = lines(o).length;
  const nShown = await page.locator(lineSel).count();
  const reasons = [];
  if (nShown !== nServer) reasons.push(`ticket shows ${nShown} lines, server has ${nServer}`);
  if (staleMs >= 400) reasons.push(`removed line shown again for ${staleMs} ms`);
  if (nServer !== Math.max(0, n0 - 1)) reasons.push(`server has ${nServer} lines (want ${n0 - 1})`);
  return { bug: reasons.length > 0, reasons, latencyMs: removedAt, metrics: { n0, nServer, nShown, staleMs }, t0 };
}

function urlFor(mode) {
  return (path) => {
    const u = new URL(path, BASE);
    u.searchParams.set("t", TABLE);
    if (mode === "off") u.searchParams.set("genclass", "off");
    return u.href;
  };
}

// ------------------------------------------------------------------------------------------------ trial
const EXTERNAL = new Set();
async function trial(browser, scenario, mode, rep) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (r) => {
    EXTERNAL.add(new URL(r.request().url()).origin);
    return r.abort();
  });
  const override = mode === "off" ? null : { ...EXTRA, mode, telemetry: false, debug: true, ...(AGGR ? { aggressiveness: AGGR } : {}) };
  await ctx.addInitScript((ov) => {
    if (!ov) return;
    let cur = { ...ov };
    Object.defineProperty(globalThis, "GENCLASS_CONFIG", {
      configurable: true,
      get: () => cur,
      set: (v) => {
        cur = { ...(v || {}), ...ov, model: { ...((v && v.model) || {}), ...(ov.model || {}) } };
      },
    });
  }, override);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  const sc = SCENARIOS[scenario];
  let res;
  const started = Date.now();
  try {
    res = await sc.run({ page, ctx, url: urlFor(mode) });
  } catch (e) {
    res = { bug: false, error: String(e).slice(0, 300), reasons: ["harness error"] };
  }
  let gc = null;
  if (mode !== "off") {
    gc = await page
      .evaluate(() => {
        const g = window.__genclass;
        if (!g) return null;
        const s = g.summary();
        const ds = g.decisions();
        const byTrig = {};
        for (const d of ds) byTrig[d.trigger] = (byTrig[d.trigger] ?? 0) + 1;
        return {
          status: g.status.state,
          mode: g.mode,
          aggr: g.aggressiveness,
          decisions: ds.length,
          byTrigger: byTrig,
          detections: Object.values(s.detections ?? {}).reduce((a, b) => a + b, 0),
          detectionKinds: s.detections,
          interventions: g.interventions().map((a) => ({ action: a.action, tier: a.tier, trigger: a.trigger, ok: a.ok, changed: a.changed })),
          notExecuted: ds.filter((d) => !d.executed && d.reason).map((d) => `${d.trigger}:${d.action}:${String(d.reason).replace(/\d+(\.\d+)?/g, "#")}`),
          diagnoses: ds.map((d) => `${d.trigger}:${d.diagnosis}:${d.action}${d.executed ? "!" : ""}`),
        };
      })
      .catch((e) => ({ evalError: String(e).slice(0, 200) }));
  }
  await ctx.close();
  return { scenario, kind: sc.kind, mode, rep, ms: Date.now() - started, ...res, pageErrors: errors, gc };
}

// ------------------------------------------------------------------------------------------------ main
const scenarios = opt("scenarios", Object.keys(SCENARIOS).join(",")).split(",").filter(Boolean);
const jobs = [];
for (let rep = 0; rep < REPS; rep++) for (const s of scenarios) for (const m of MODES) jobs.push([s, m, rep]);
const browser = await chromium.launch({ headless: true });
const results = [];
let next = 0;
async function worker(w) {
  while (next < jobs.length) {
    const [s, m, rep] = jobs[next++];
    const r = await trial(browser, s, m, rep);
    results.push(r);
    const acts = r.gc?.interventions?.length ?? 0;
    console.log(`[${results.length}/${jobs.length}] ${s} ${m} #${rep}: ${r.error ? "ERROR " + r.error : r.bug ? "BUG " + r.reasons.join("; ") : "ok"} lat=${r.latencyMs == null ? "–" : Math.round(r.latencyMs)} dec=${r.gc?.decisions ?? 0} det=${r.gc?.detections ?? 0} acts=${acts}${acts ? " " + r.gc.interventions.map((a) => a.action).join(",") : ""}`);
  }
}
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
await browser.close();

// ------------------------------------------------------------------------------------------------ summary
const sum = {};
for (const r of results) {
  const k = `${r.scenario}|${r.mode}`;
  const s = (sum[k] ??= { scenario: r.scenario, kind: r.kind, mode: r.mode, n: 0, bugs: 0, errors: 0, lat: [], decisions: 0, detections: 0, interventions: 0, actions: {} });
  s.n++;
  if (r.error) s.errors++;
  else if (r.bug) s.bugs++;
  if (r.latencyMs != null) s.lat.push(r.latencyMs);
  s.decisions += r.gc?.decisions ?? 0;
  s.detections += r.gc?.detections ?? 0;
  s.interventions += r.gc?.interventions?.length ?? 0;
  for (const a of r.gc?.interventions ?? []) s.actions[a.action] = (s.actions[a.action] ?? 0) + 1;
}
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : null);
const rows = Object.values(sum).map((s) => ({ ...s, latP50: med(s.lat), lat: undefined }));
console.log("\n| scenario | kind | mode | bugs/n | errors | latency p50 (ms) | decisions | detections | interventions |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const s of rows) console.log(`| ${s.scenario} | ${s.kind} | ${s.mode} | ${s.bugs}/${s.n} | ${s.errors} | ${s.latP50 == null ? "–" : Math.round(s.latP50)} | ${s.decisions} | ${s.detections} | ${s.interventions}${Object.keys(s.actions).length ? " (" + Object.entries(s.actions).map(([k, v]) => `${k} ${v}`).join(", ") + ")" : ""} |`);
console.log(EXTERNAL.size ? `blocked external origins: ${[...EXTERNAL].join(", ")}` : "no external requests");
if (OUT) {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), tag: TAG, base: BASE, aggr: AGGR || "default", config: EXTRA, modes: MODES, reps: REPS, summary: rows, external: [...EXTERNAL], raw: results }, null, 1));
}
