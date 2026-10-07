// Headless evaluation of every demo on the build VM (never on the Mac):
//   node --experimental-strip-types e2e/eval.ts [--fast] [--n 30] [--clean 15] [--demos search,editor]
//        [--modes off,guard,heal] [--workers 8] [--model <url>|cdn] [--no-shots] [--shots-only]
// Serves dist/ under a GitHub-Pages-like sub-path, runs each trial in a fresh page with real keyboard and mouse
// input (Playwright), lets the page's own oracle score it, and writes results.json, results.md and screenshots.
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serveStatic } from "./serve.ts";
import { summarizeDemo, type DemoSummary, type ModeSummary } from "../src/shared/aggregate.ts";
import type { DemoId, GcMode, Step, TrialKind, TrialResult } from "../src/shared/types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALL_DEMOS: DemoId[] = ["search", "editor", "checkout", "status", "board", "decisions"];
const ALL_MODES: GcMode[] = ["off", "guard", "heal"];

// ------------------------------------------------------------------------------------------------ options
const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const FAST = flag("fast");
const N = Number(opt("n", FAST ? "4" : "30"));
const CLEAN = Number(opt("clean", String(FAST ? 2 : Math.ceil(N / 2))));
const DEMOS = opt("demos", ALL_DEMOS.join(",")).split(",").filter(Boolean) as DemoId[];
const MODES = opt("modes", ALL_MODES.join(",")).split(",").filter(Boolean) as GcMode[];
const WORKERS = Number(opt("workers", "8"));
const SEED_BASE = Number(opt("seed-base", "1000"));
const BASE = opt("base", "/genclass/");
const PORT = Number(opt("port", "4173"));
const TRIAL_TIMEOUT = Number(opt("trial-timeout", "180000"));
const SHOTS = !flag("no-shots");
const SHOTS_ONLY = flag("shots-only");
const OUT = opt("out", ROOT);
const DIST = `${ROOT}dist/`;
// The model directory can live outside the synced tree (scripts/vm.sh deletes untracked files on sync).
const MODEL_DIR = opt("model-dir", process.env.GENCLASS_MODEL_DIR ?? "");
const localModel = existsSync(`${DIST}genclass-model/model.json`) || (MODEL_DIR !== "" && existsSync(`${MODEL_DIR}/model.json`));
const MODEL = opt("model", localModel ? "genclass-model/" : "cdn");
const SITE = `http://127.0.0.1:${PORT}${BASE}`;
/** Experiment: policy.holdBudgetMs for every GenClass page (results go to results-budget<ms>.*). */
const BUDGET = opt("budget", "");
/** Free-form label for a run (e.g. the model under test): results-<tag>.json / .md, not shipped with the site. */
const TAG = opt("tag", "").replace(/[^a-zA-Z0-9._-]+/g, "-");
const SUFFIX = [TAG ? `-${TAG}` : "", BUDGET ? `-budget${BUDGET}` : ""].join("");

interface Job {
  demo: DemoId;
  mode: GcMode;
  kind: TrialKind;
  seed: number;
}

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------- Playwright step driver
type W = { __trial?: any; __trialError?: string; __demo?: any };

async function exists(page: Page, sel: string, waitMs: number): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    const ok = await page
      .evaluate((s) => {
        const el = document.querySelector(s) as HTMLButtonElement | null;
        if (!el) return false;
        const cs = getComputedStyle(el);
        return !el.disabled && cs.visibility !== "hidden" && cs.display !== "none";
      }, sel)
      .catch(() => false);
    if (ok) return true;
    if (Date.now() - t0 > waitMs) return false;
    await sleep(40);
  }
}

/** Execute scripted steps with real input. `hooks` false = interactive page (no trial harness). */
async function runSteps(page: Page, steps: Step[], harness: boolean): Promise<string[]> {
  const timeouts: string[] = [];
  const check = (c: string) => (harness ? page.evaluate((cond) => (window as unknown as W).__trial.check(cond), c) : Promise.resolve(false));
  for (const s of steps) {
    switch (s.k) {
      case "wait":
        await page.waitForTimeout(s.ms);
        break;
      case "mark":
        if (harness) await page.evaluate((n) => (window as unknown as W).__trial.mark(n), s.name);
        break;
      case "chaos":
        if (harness) await page.evaluate((p) => (window as unknown as W).__trial.chaos(p), s.patch);
        else await page.evaluate((p) => (window as unknown as W).__demo?.setChaos(p), s.patch);
        break;
      case "server":
        if (harness) await page.evaluate(([a, x]) => (window as unknown as W).__trial.server(a, x), [s.action, s.args] as const);
        else await page.evaluate(([a, x]) => (window as unknown as W).__demo?.world(a, x), [s.action, s.args] as const);
        break;
      case "until": {
        if (!harness) {
          await page.waitForTimeout(Math.min(1500, s.timeout));
          break;
        }
        const ok = await page
          .waitForFunction((c) => (window as unknown as W).__trial.check(c), s.cond, { timeout: s.timeout, polling: 25 })
          .then(() => true)
          .catch(() => false);
        if (!ok) timeouts.push(s.cond);
        break;
      }
      case "focus":
        await page.locator(s.sel).first().focus({ timeout: 3000 }).catch(() => {});
        break;
      case "caret":
        await page
          .evaluate(
            ([sel, pos]) => {
              const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
              if (!el) return;
              el.focus();
              const p = pos === "end" ? el.value.length : pos === "start" ? 0 : Math.min(Number(pos), el.value.length);
              el.setSelectionRange(p, p);
            },
            [s.sel, s.pos] as const,
          )
          .catch(() => {});
        break;
      case "type": {
        const focused = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), s.sel).catch(() => false);
        if (!focused) await page.locator(s.sel).first().focus({ timeout: 3000 }).catch(() => {});
        for (let i = 0; i < s.text.length; i++) {
          await page.waitForTimeout(s.delays[i] ?? 90);
          const ch = s.text[i];
          if (ch === "\n") await page.keyboard.press("Enter");
          else await page.keyboard.type(ch);
        }
        break;
      }
      case "key":
        for (const d of s.delays) {
          await page.waitForTimeout(d);
          await page.keyboard.press(s.key);
        }
        break;
      case "click": {
        if (s.unless && (await check(s.unless))) break;
        const count = s.count ?? 1;
        for (let i = 0; i < count; i++) {
          if (!(await exists(page, s.sel, i === 0 ? 1500 : 200))) break;
          await page
            .locator(s.sel)
            .first()
            .click({ timeout: 2000 })
            .catch(() => {});
          if (i < count - 1) await page.waitForTimeout(s.gap ?? 120);
        }
        break;
      }
    }
  }
  return timeouts;
}

// ----------------------------------------------------------------------------------------------- trials
function trialUrl(j: Job): string {
  const u = new URL(`${j.demo}/`, SITE);
  u.searchParams.set("embed", "trial");
  u.searchParams.set("mode", j.mode);
  u.searchParams.set("kind", j.kind);
  u.searchParams.set("seed", String(j.seed));
  u.searchParams.set("run", Math.random().toString(36).slice(2, 9));
  u.searchParams.set("model", MODEL);
  if (BUDGET) u.searchParams.set("budget", BUDGET);
  return u.href;
}

function failed(j: Job, error: string): TrialResult {
  return {
    demo: j.demo,
    mode: j.mode,
    kind: j.kind,
    seed: j.seed,
    label: "–",
    durationMs: 0,
    bug: false,
    reasons: [],
    metrics: {},
    driver: "playwright",
    error,
    gc: { runtime: "real", status: "error", decisions: 0, detections: 0, notExecuted: {}, interventions: [], decisionLatencyMs: [], diagnoses: {} },
  };
}

async function runTrial(ctx: BrowserContext, j: Job): Promise<TrialResult> {
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
  const work = (async () => {
    await page.goto(trialUrl(j), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => (window as unknown as W).__trial || (window as unknown as W).__trialError, null, { timeout: 150000, polling: 100 });
    const err = await page.evaluate(() => (window as unknown as W).__trialError);
    if (err) throw new Error(err);
    const steps = (await page.evaluate(() => (window as unknown as W).__trial.steps)) as Step[];
    await page.evaluate(() => (window as unknown as W).__trial.begin());
    const timeouts = await runSteps(page, steps, true);
    const r = (await page.evaluate(() => (window as unknown as W).__trial.finish("playwright"))) as TrialResult;
    if (timeouts.length) r.metrics.untilTimeouts = timeouts.length;
    if (pageErrors.length) r.metrics.pageErrors = pageErrors.length;
    return r;
  })();
  try {
    return await Promise.race([work, sleep(TRIAL_TIMEOUT).then(() => failed(j, `trial timed out after ${TRIAL_TIMEOUT / 1000} s`))]);
  } catch (e) {
    return failed(j, (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300));
  } finally {
    await page.close().catch(() => {});
  }
}

function planJobs(): Job[] {
  const jobs: Job[] = [];
  for (let i = 0; i < Math.max(N, CLEAN); i++) {
    for (const demo of DEMOS) {
      if (i < N) for (const mode of MODES) jobs.push({ demo, mode, kind: "chaos", seed: SEED_BASE + i });
      if (i < CLEAN) for (const mode of MODES) jobs.push({ demo, mode, kind: "clean", seed: SEED_BASE + 500 + i });
    }
  }
  return jobs;
}

/** Register the mock server worker in a fresh context and wait until pages come up cross-origin isolated. */
async function warmUp(ctx: BrowserContext): Promise<boolean> {
  const page = await ctx.newPage();
  try {
    await page.goto(new URL(`search/?mode=off`, SITE).href, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => crossOriginIsolated && document.querySelector(".app-body > *"), null, { timeout: 30000, polling: 200 });
    return true;
  } catch {
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

async function runTrials(browser: Browser): Promise<TrialResult[]> {
  const queue = planJobs();
  const total = queue.length;
  const results: TrialResult[] = [];
  const t0 = Date.now();
  log(`${total} trials · ${DEMOS.length} demos · modes ${MODES.join("/")} · ${N} chaos + ${CLEAN} clean per mode · ${WORKERS} workers · model ${MODEL_LABEL} (${MODEL})${TAG ? ` · tag ${TAG}` : ""}`);
  await mkdir(`${ROOT}e2e/.out`, { recursive: true });
  await Promise.all(
    Array.from({ length: WORKERS }, async (_, w) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      if (!(await warmUp(ctx))) log(`w${w}: warm-up did not reach cross-origin isolation`);
      while (queue.length) {
        const j = queue.shift()!;
        const r = await runTrial(ctx, j);
        results.push(r);
        const done = results.length;
        const tag = r.error ? `ERROR ${r.error}` : `${r.bug ? "BUG" : "ok "} acts=${r.gc.interventions.length} dec=${r.gc.decisions} ${r.reasons.join("; ").slice(0, 120)}`;
        log(`[${done}/${total}] w${w} ${j.demo} ${j.mode} ${j.kind} #${j.seed}: ${tag}`);
        if (done % 12 === 0 || done === total) {
          const rate = (Date.now() - t0) / done;
          log(`… ${Math.round((rate * (total - done)) / 60000)} min left`);
          await writeFile(`${ROOT}e2e/.out/partial.json`, JSON.stringify(results));
        }
      }
      await ctx.close();
    }),
  );
  return results;
}

// ---------------------------------------------------------------------------------------------- reports
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const ms = (x: number | null) => (x === null || !Number.isFinite(x) ? "–" : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${Math.round(x)} ms`);
const TITLES: Record<DemoId, string> = {
  search: "Search typeahead",
  editor: "Notes autosave",
  checkout: "Cart & checkout",
  status: "Service status",
  board: "Team board",
  decisions: "Runtime decisions",
};

interface ServedCard {
  name?: string;
  version?: string;
  variants?: Record<string, { file?: string; bytes?: number; sha256?: string }>;
  source: string;
}

/** The model card the pages are served (local directory or URL), recorded with the results. */
async function servedCard(): Promise<ServedCard | null> {
  try {
    if (MODEL === "cdn") return { source: "the runtime's default CDN" };
    if (MODEL === "genclass-model/") {
      const dir = existsSync(`${DIST}genclass-model/model.json`) ? `${DIST}genclass-model` : MODEL_DIR;
      const card = JSON.parse(await readFile(`${dir}/model.json`, "utf8")) as ServedCard;
      return { name: card.name, version: card.version, variants: card.variants, source: dir };
    }
    const res = await fetch(new URL("model.json", MODEL.endsWith("/") ? MODEL : MODEL + "/"));
    if (!res.ok) return { source: MODEL };
    const card = (await res.json()) as ServedCard;
    return { name: card.name, version: card.version, variants: card.variants, source: MODEL };
  } catch {
    return null;
  }
}
const CARD = await servedCard();
const MODEL_LABEL = CARD?.name ? `${CARD.name} ${CARD.version ?? ""}`.trim() : MODEL;
/** The v0.1 extension model (a general classifier), as opposed to a runtime-trained model. */
const IS_V01 = CARD?.name === "genclass-model" && (CARD.version ?? "").startsWith("0.1");

function modelNote(results: TrialResult[]): { name: string; note: string; status: string; runtime: string } {
  const runtime = [...new Set(results.map((r) => r.gc.runtime))].join("+") || "unknown";
  const on = results.filter((r) => r.mode !== "off");
  const statuses = [...new Set(on.map((r) => r.gc.status))];
  const variants = [...new Set(on.map((r) => [r.gc.device, r.gc.variant].filter(Boolean).join(" ")).filter(Boolean))];
  const reported = [...new Set(on.map((r) => r.gc.model).filter(Boolean))].join(", ");
  const name = reported || MODEL_LABEL;
  const iso = on.length ? on.filter((r) => r.gc.isolated).length / on.length : 0;
  const threads = iso > 0.95 ? "cross-origin isolated (WASM threads available)" : iso > 0 ? `cross-origin isolated in ${Math.round(iso * 100)}% of runs` : "not cross-origin isolated (single-threaded WASM)";
  let note: string;
  if (runtime.includes("shim")) {
    note = "Measured with a development stand-in for @genclass/runtime (observe-only, no model): every mode is the no-GenClass baseline.";
  } else if (!statuses.includes("ready")) {
    note = `The model did not load in these runs (status: ${statuses.join(", ") || "n/a"}), so Guard and Heal acted passively.`;
  } else {
    note = `Model: ${name}${variants.length ? ` on ${variants.join(", ")}` : ""}, ${threads}.${
      IS_V01
        ? " The v0.1 GenClass model is a general classifier that was not trained for runtime decisions; these numbers measure the runtime and the demos with it, not the runtime-specialist model."
        : ""
    }`;
  }
  return { name, note, status: statuses.join("+"), runtime };
}

function mdTable(summaries: DemoSummary[]): string {
  const rows = summaries.map((s) => {
    const m = s.modes;
    const br = (x?: ModeSummary) => (x ? `${pct(x.chaos.rate)} (${x.chaos.k}/${x.chaos.n})` : "–");
    const fi = (x?: ModeSummary) => (x ? `${x.falseInterventions} in ${x.cleanTrialsWithIntervention}/${x.cleanTrials}` : "–");
    const lat = (x?: ModeSummary) => (x ? ms(x.latencyMs) : "–");
    const fx = (x?: ModeSummary) => (x && x.mode !== "off" ? `${x.fixed}/${x.introduced}` : "–");
    return `| ${TITLES[s.demo]} | ${br(m.off)} | ${br(m.guard)} | ${br(m.heal)} | ${fi(m.guard)} | ${fi(m.heal)} | ${fx(m.guard)} | ${fx(m.heal)} | ${lat(m.off)} / ${lat(m.guard)} / ${lat(m.heal)} | ${ms(m.guard?.decisionP50 ?? null)} / ${ms(m.heal?.decisionP50 ?? null)} |`;
  });
  return [
    "| Demo | Bug rate Off | Guard | Heal | False interventions (clean) Guard | Heal | Fixed/introduced vs Off: Guard | Heal | User latency p50 (clean) Off / Guard / Heal | Model decision p50 Guard / Heal |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function mdDemo(s: DemoSummary, results: TrialResult[]): string {
  const lines = [`## ${TITLES[s.demo]} (\`${s.demo}\`)`, ""];
  for (const mode of ALL_MODES) {
    const m = s.modes[mode];
    if (!m) continue;
    const acts = Object.entries(m.actions).map(([a, n]) => `${a} ×${n}`).join(", ") || "none";
    const nx = Object.entries(m.notExecuted).map(([a, n]) => `${a} ×${n}`).join(", ") || "none";
    lines.push(
      `- **${mode}**: bug rate ${pct(m.chaos.rate)} (${m.chaos.k}/${m.chaos.n}, 95% CI ${pct(m.chaos.lo)}–${pct(m.chaos.hi)}) under chaos; ${pct(m.clean.rate)} (${m.clean.k}/${m.clean.n}) on clean runs. ` +
        `False interventions on clean runs: **${m.falseInterventions}** (in ${m.cleanTrialsWithIntervention}/${m.cleanTrials} runs). ` +
        `${mode !== "off" ? `Paired with Off: fixed ${m.fixed}, introduced ${m.introduced} of ${m.paired}. ` : ""}` +
        `Interventions per chaos trial ${m.interventionsPerChaosTrial.toFixed(2)}; decisions per trial ${m.decisionsPerTrial.toFixed(1)}; detections per trial ${m.detectionsPerTrial.toFixed(1)}; model decision latency p50 ${ms(m.decisionP50)}, p95 ${ms(m.decisionP95)}; user-visible latency p50 ${ms(m.latencyMs)} clean, ${ms(m.latencyChaosMs)} chaos. Actions: ${acts}. Chosen but not run: ${nx}.${m.errors ? ` Errors: ${m.errors}.` : ""}`,
    );
  }
  const keys = new Set<string>();
  for (const m of Object.values(s.modes)) for (const k of Object.keys(m?.metrics ?? {})) keys.add(k);
  if (keys.size) {
    lines.push("", `| metric (mean) | ${ALL_MODES.filter((x) => s.modes[x]).join(" | ")} |`, `|---|${ALL_MODES.filter((x) => s.modes[x]).map(() => "---").join("|")}|`);
    for (const k of [...keys].sort()) {
      lines.push(
        `| ${k} | ${ALL_MODES.filter((x) => s.modes[x])
          .map((x) => {
            const v = s.modes[x]!.metrics[k];
            return v === null || v === undefined || !Number.isFinite(v) ? "–" : Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
          })
          .join(" | ")} |`,
      );
    }
  }
  const reasons = new Map<string, number>();
  for (const r of results.filter((x) => x.demo === s.demo && x.bug && x.mode === "off")) for (const why of r.reasons) reasons.set(why.replace(/[0-9.]+/g, "#"), (reasons.get(why.replace(/[0-9.]+/g, "#")) ?? 0) + 1);
  if (reasons.size) {
    lines.push("", "Most common bugs with GenClass Off:");
    for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5)) lines.push(`- ${why} (×${n})`);
  }
  lines.push("");
  return lines.join("\n");
}

async function writeReports(results: TrialResult[]) {
  const summaries = DEMOS.map((d) => summarizeDemo(d, results));
  const meta = modelNote(results);
  const json = {
    generatedAt: new Date().toISOString(),
    runtime: meta.runtime,
    model: { name: meta.name, note: meta.note, status: meta.status, baseUrl: MODEL, card: CARD, tag: TAG || undefined },
    driver: "playwright (real keyboard and mouse input), headless Chromium",
    policy: BUDGET ? { holdBudgetMs: Number(BUDGET), note: "experiment: hold budget raised from the default 300 ms" } : "runtime defaults",
    trials: { chaos: N, clean: CLEAN },
    modes: MODES,
    seeds: { chaos: `${SEED_BASE}..${SEED_BASE + N - 1}`, clean: `${SEED_BASE + 500}..${SEED_BASE + 500 + CLEAN - 1}` },
    definitions: {
      bugRate: "share of chaos trials where the demo's oracle found a bug",
      falseInterventions: "non-passive actions GenClass took on clean runs (no chaos, calm user, correct app behaviour); each one is a false positive",
      fixedIntroduced: "paired with Off on the same chaos seed: bugs that disappeared / appeared",
      latency: "the demo's user-visible latency metric (see README), median over clean runs",
      decisionLatency: "time the runtime waited for a model decision",
    },
    demos: Object.fromEntries(summaries.map((s) => [s.demo, s.modes])),
    raw: results,
  };
  await writeFile(`${OUT}/results${SUFFIX}.json`, JSON.stringify(json, null, 1));
  // A compact copy (no raw trials) for the landing page; ship it with the built site right away.
  const { raw: _raw, ...summary } = json;
  await writeFile(`${OUT}/results${SUFFIX}-summary.json`, JSON.stringify(summary));
  if (!SUFFIX) await copyFile(`${OUT}/results-summary.json`, `${DIST}results-summary.json`).catch(() => {});
  else log(`tagged run: results${SUFFIX}.* are not shipped with the site (rename to results.* to publish)`);
  const md = [
    "# GenClass Runtime demos: trial results",
    "",
    `Generated ${json.generatedAt} on the build VM. Runtime: **${meta.runtime}**. ${meta.note}${BUDGET ? ` **Experiment:** policy.holdBudgetMs = ${BUDGET} ms (default 300 ms), so slow model decisions can still act; this is not the default configuration.` : ""}`,
    "",
    `Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). ${N} chaos trials and ${CLEAN} clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.`,
    "",
    mdTable(summaries),
    "",
    ...summaries.map((s) => mdDemo(s, results)),
    "## How to reproduce",
    "",
    "```bash",
    "scripts/vm.sh run demos 'setsid nohup bash demos/scripts/vm-eval.sh > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'",
    "# or, on any machine: npm install && npm run build -w @genclass/runtime && cd demos && npm run fetch-model && npm run build && npm run eval",
    "```",
    "",
  ].join("\n");
  await writeFile(`${OUT}/results${SUFFIX}.md`, md);
  log(`wrote ${OUT}/results${SUFFIX}.json and results${SUFFIX}.md`);
}

// -------------------------------------------------------------------------------------------- screenshots
const SHOT_PRESET: Record<DemoId, string> = { search: "Busy", editor: "Busy", checkout: "Flaky", status: "Flaky", board: "Busy", decisions: "Busy" };

async function shootDemo(ctx: BrowserContext, demo: DemoId, file: string, full: boolean, overlayOpen = true) {
  const page = await ctx.newPage();
  const u = new URL(`${demo}/`, SITE);
  u.searchParams.set("mode", "guard");
  if (overlayOpen) u.searchParams.set("devtools", "open");
  u.searchParams.set("model", MODEL);
  await page.goto(u.href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-body > *", { timeout: 60000 });
  await page
    .waitForFunction(() => {
      const s = document.querySelector(".model-status") as HTMLElement | null;
      return s && s.dataset.state !== "loading";
    }, null, { timeout: 90000, polling: 250 })
    .catch(() => {});
  await page.getByRole("button", { name: SHOT_PRESET[demo], exact: true }).click().catch(() => {});
  await page.waitForTimeout(400);
  const steps = (await page.evaluate(() => (window as unknown as W).__demo?.scenario(1003, "chaos").steps).catch(() => null)) as Step[] | null;
  if (steps) await runSteps(page, steps.slice(0, 40), false).catch(() => {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: file, fullPage: full });
  await page.close();
}

/** Exercise the in-page trial runner (iframes + synthetic DOM events) and capture its results table. */
async function shootTrialsUI(ctx: BrowserContext, demo: DemoId, file: string): Promise<void> {
  const page = await ctx.newPage();
  const u = new URL(`${demo}/`, SITE);
  u.searchParams.set("mode", "guard");
  u.searchParams.set("model", MODEL);
  if (BUDGET) u.searchParams.set("budget", BUDGET);
  await page.goto(u.href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-body > *", { timeout: 60000 });
  await page.locator("#trials select").selectOption("3");
  await page.getByRole("button", { name: "Run trials" }).click();
  const t0 = Date.now();
  await page.waitForFunction(() => /trials in \d+ s/.test(document.querySelector("#trials .trial-progress .line span")?.textContent ?? ""), null, {
    timeout: 900000,
    polling: 1000,
  });
  log(`in-page trial runner (${demo}): done in ${Math.round((Date.now() - t0) / 1000)} s`);
  const rows = await page.locator("#trials .trial-log tbody tr").count();
  const errors = await page.locator("#trials .trial-log .badge-warn").count();
  log(`in-page trial runner: ${rows} trials, ${errors} errors`);
  await page.locator("#trials").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.locator("#trials").screenshot({ path: file });
  await page.close();
}

async function screenshots(browser: Browser) {
  const dir = `${ROOT}screenshots`;
  await mkdir(dir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme, deviceScaleFactor: 1 });
    const suffix = theme === "dark" ? "-dark" : "";
    const page = await ctx.newPage();
    await page.goto(SITE, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${dir}/index${suffix}.png` });
    if (theme === "light") await page.screenshot({ path: `${dir}/index-full.png`, fullPage: true });
    await page.close();
    for (const demo of DEMOS) {
      try {
        await shootDemo(ctx, demo, `${dir}/${demo}${suffix}.png`, false);
        if (theme === "light") {
          await shootDemo(ctx, demo, `${dir}/${demo}-page.png`, false, false);
          await shootDemo(ctx, demo, `${dir}/${demo}-full.png`, true, false);
        }
        log(`screenshot ${demo}${suffix}`);
      } catch (e) {
        log(`screenshot ${demo}${suffix} failed: ${String(e).split("\n")[0]}`);
      }
    }
    if (theme === "light" && !flag("no-trials-ui")) {
      await shootTrialsUI(ctx, "search", `${dir}/search-trials.png`).catch((e) => log(`in-page trial runner failed: ${String(e).split("\n")[0]}`));
    }
    await ctx.close();
  }
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await mobile.newPage();
  await p.goto(SITE, { waitUntil: "networkidle" });
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${dir}/index-mobile.png` });
  await p.close();
  await shootDemo(mobile, "search", `${dir}/search-mobile.png`, false).catch(() => {});
  await mobile.close();
}

// ------------------------------------------------------------------------------------------------- main
if (!existsSync(`${DIST}index.html`)) {
  console.error("dist/ is missing: run `npm run build` first");
  process.exit(2);
}
if (MODEL === "genclass-model/" && !localModel) log("warning: no dist/genclass-model/; Guard/Heal will run without a model");
const server = await serveStatic(DIST, BASE, PORT, MODEL_DIR ? { "genclass-model": MODEL_DIR } : {});
log(`serving ${DIST} at ${SITE}`);
const browser = await chromium.launch({ headless: true });
try {
  if (!SHOTS_ONLY) {
    const results = await runTrials(browser);
    await writeReports(results);
  }
  if (SHOTS || SHOTS_ONLY) await screenshots(browser);
} finally {
  await browser.close();
  server.close();
}
const prev = SHOTS_ONLY ? null : await readFile(`${OUT}/results${SUFFIX}.md`, "utf8").catch(() => null);
if (prev) console.log("\n" + prev.split("\n").slice(0, 16).join("\n"));
