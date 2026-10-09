#!/usr/bin/env node
// Verifies the PUBLIC demo site (App Service) in headless Chromium: HTTPS, landing page, Service Worker mock backend,
// cross-origin isolation, and scripted trials of one demo in guard mode (and off, for comparison) with the model from
// the public npm CDN. Runs on vm-genclass-ci from a GenClass-lib checkout that has @playwright/test installed:
//   cd ~/demos-build/GenClass-lib && node /path/to/verify-site.mjs https://genclass-demos-9dc31e.azurewebsites.net/ \
//     [--demo search] [--seeds 3] [--modes off,guard] [--out verify.json]
// The step runner mirrors demos/e2e/eval.ts (real keyboard/mouse input, the trial harness scores the run).
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const SITE = new URL(argv.find((a) => a.startsWith("https://")) ?? "https://genclass-demos-9dc31e.azurewebsites.net/");
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const DEMO = opt("demo", "search");
const SEEDS = Number(opt("seeds", "3"));
const MODES = opt("modes", "off,guard").split(",");
const OUT = opt("out", "verify-site.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSteps(page, steps) {
  const check = (c) => page.evaluate((cond) => window.__trial.check(cond), c);
  for (const s of steps) {
    if (s.k === "wait") await page.waitForTimeout(s.ms);
    else if (s.k === "mark") await page.evaluate((n) => window.__trial.mark(n), s.name);
    else if (s.k === "chaos") await page.evaluate((p) => window.__trial.chaos(p), s.patch);
    else if (s.k === "server") await page.evaluate(([a, x]) => window.__trial.server(a, x), [s.action, s.args]);
    else if (s.k === "until") await page.waitForFunction((c) => window.__trial.check(c), s.cond, { timeout: s.timeout, polling: 25 }).catch(() => {});
    else if (s.k === "focus") await page.locator(s.sel).first().focus({ timeout: 3000 }).catch(() => {});
    else if (s.k === "caret")
      await page
        .evaluate(([sel, pos]) => {
          const el = document.querySelector(sel);
          if (!el) return;
          el.focus();
          const p = pos === "end" ? el.value.length : pos === "start" ? 0 : Math.min(Number(pos), el.value.length);
          el.setSelectionRange(p, p);
        }, [s.sel, s.pos])
        .catch(() => {});
    else if (s.k === "type") {
      const focused = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), s.sel).catch(() => false);
      if (!focused) await page.locator(s.sel).first().focus({ timeout: 3000 }).catch(() => {});
      for (let i = 0; i < s.text.length; i++) {
        await page.waitForTimeout(s.delays[i] ?? 90);
        if (s.text[i] === "\n") await page.keyboard.press("Enter");
        else await page.keyboard.type(s.text[i]);
      }
    } else if (s.k === "key") for (const d of s.delays) (await page.waitForTimeout(d), await page.keyboard.press(s.key));
    else if (s.k === "click") {
      if (s.unless && (await check(s.unless))) continue;
      for (let i = 0; i < (s.count ?? 1); i++) {
        await page.locator(s.sel).first().click({ timeout: 2000 }).catch(() => {});
        if (i < (s.count ?? 1) - 1) await page.waitForTimeout(s.gap ?? 120);
      }
    }
  }
}

const browser = await chromium.launch();
const out = { site: SITE.href, at: new Date().toISOString(), demo: DEMO, checks: {}, trials: [] };
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  const res = await page.goto(SITE.href, { waitUntil: "load", timeout: 120000 });
  out.checks.landing = { status: res?.status(), https: SITE.protocol === "https:", title: await page.title() };
  const build = await (await ctx.request.get(new URL("build.json", SITE).href)).json().catch(() => null);
  out.checks.build = build;
  await page.goto(new URL(`${DEMO}/?mode=guard`, SITE).href, { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 60000 }).catch(() => {});
  await sleep(3000); // the first visit reloads once to become cross-origin isolated
  out.checks.demoPage = await page.evaluate(() => ({ sw: !!navigator.serviceWorker?.controller, crossOriginIsolated: self.crossOriginIsolated, secure: isSecureContext }));
  out.checks.pageErrors = errors;

  for (const mode of MODES)
    for (let i = 0; i < SEEDS; i++) {
      const u = new URL(`${DEMO}/`, SITE);
      for (const [k, v] of Object.entries({ embed: "trial", mode, kind: "chaos", seed: String(1000 + i), run: Math.random().toString(36).slice(2, 9), model: "cdn" })) u.searchParams.set(k, v);
      const t = await ctx.newPage();
      const modelUrls = new Set();
      t.on("request", (r) => {
        if (/genclass\/runtime-model@|onnxruntime-web@/.test(r.url())) modelUrls.add(r.url().replace(/[^/]*$/, ""));
      });
      try {
        await t.goto(u.href, { waitUntil: "domcontentloaded", timeout: 60000 });
        await t.waitForFunction(() => window.__trial || window.__trialError, null, { timeout: 150000, polling: 100 });
        const err = await t.evaluate(() => window.__trialError);
        if (err) throw new Error(err);
        const steps = await t.evaluate(() => window.__trial.steps);
        await t.evaluate(() => window.__trial.begin());
        await runSteps(t, steps);
        const r = await t.evaluate(() => window.__trial.finish("playwright"));
        out.trials.push({ mode, seed: 1000 + i, label: r.label, bug: r.bug, reasons: r.reasons, gc: { runtime: r.gc?.runtime, status: r.gc?.status, decisions: r.gc?.decisions, detections: r.gc?.detections, interventions: (r.gc?.interventions ?? []).length, latencyMs: r.gc?.decisionLatencyMs }, modelFrom: [...modelUrls] });
      } catch (e) {
        out.trials.push({ mode, seed: 1000 + i, error: String(e.message ?? e).split("\n")[0].slice(0, 300) });
      }
      await t.close();
      console.log(JSON.stringify(out.trials.at(-1)));
    }
} finally {
  await browser.close();
}
const by = (m) => out.trials.filter((t) => t.mode === m && !t.error);
out.summary = Object.fromEntries(MODES.map((m) => [m, { trials: by(m).length, bugs: by(m).filter((t) => t.bug).length, interventions: by(m).reduce((s, t) => s + (t.gc.interventions || 0), 0), modelStatus: [...new Set(by(m).map((t) => t.gc.status))] }]));
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ checks: out.checks, summary: out.summary }));
