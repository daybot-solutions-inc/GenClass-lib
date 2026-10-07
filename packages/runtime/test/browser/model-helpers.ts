// Shared helpers of the model browser specs: static server, test-app driver, PyTorch fixtures, latency requests.
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG = resolve(HERE, "..", "..");
export const APP = join(HERE, ".build", "app");
const FIX = join(PKG, "test", "fixtures", "model");
export const MODEL_DIR = process.env.GENCLASS_MODEL_DIR ? resolve(process.env.GENCLASS_MODEL_DIR) : resolve(PKG, "..", "..", ".cache-model");
export const HAVE_MODEL = existsSync(join(MODEL_DIR, "model.json"));
const RESULTS_DIR = join(PKG, "test-results", "browser");

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
export const requests = HAVE_MODEL ? readJson(join(FIX, "requests50.json")) : [];
export const packs = HAVE_MODEL ? readJson(join(FIX, "pack_fixtures.json")) : [];
export const torch = HAVE_MODEL ? readJson(join(FIX, "torch_fixtures.json")) : [];
export const card = HAVE_MODEL ? readJson(join(MODEL_DIR, "model.json")) : null;

type Srv = Awaited<ReturnType<typeof startServer>>;

/** Starts the static server for the spec file (beforeAll/afterAll) and returns accessors. */
export function useServer() {
  let srv: Srv | null = null;
  test.beforeAll(async () => {
    srv = await startServer({ appDir: APP, modelDir: MODEL_DIR });
  });
  test.afterAll(async () => {
    await srv?.close();
  });
  return {
    get url(): string {
      return (srv as Srv).url;
    },
    served: (re: RegExp): number => (srv as Srv).log.filter((e) => re.test(e.path)).length,
    clearLog: (): void => {
      (srv as Srv).log.length = 0;
    },
  };
}

/** Writes (merges) test-results/browser/<name>.json. */
export function saveResults(name: string, data: Record<string, unknown>): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const f = join(RESULTS_DIR, `${name}.json`);
  const prev = existsSync(f) ? readJson(f) : {};
  writeFileSync(f, JSON.stringify({ ...prev, ...data }, null, 2));
}

export async function openApp(browser: Browser, base: string, opts: { coi?: boolean; context?: BrowserContext } = {}): Promise<{ page: Page; logs: string[] }> {
  const ctx = opts.context ?? (await browser.newContext());
  const page = await ctx.newPage();
  const logs: string[] = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`${base}${opts.coi ? "/coi" : ""}/app/index.html`);
  await expect(page.locator("#state")).toHaveText("ready");
  return { page, logs };
}

export const create = (page: Page, o: Record<string, unknown>) => page.evaluate((x) => (window as any).GC.create(x), o);
export const ready = (page: Page) => page.evaluate(() => (window as any).GC.ready());
export const evaluate = (page: Page, req: unknown) => page.evaluate((r) => (window as any).GC.evaluate(r), req);
export const evaluateDetailed = (page: Page, req: unknown) => page.evaluate((r) => (window as any).GC.evaluateDetailed(r), req);
export const events = (page: Page) => page.evaluate(() => (window as any).GC.events());
export const statusOf = (page: Page) => page.evaluate(() => (window as any).GC.status());

/** Fixture request i with choice criteria in Python's label order (plain objects keep it: no integer-like labels). */
export function fixtureRequest(i: number) {
  const r = requests[i];
  const qs: Record<string, unknown> = {};
  for (const [qid, q] of Object.entries<any>(r.questions)) {
    qs[qid] = q.type === "choice" ? { ...q, criteria: Object.fromEntries(packs[i].q_index[qid].labels.map((l: string) => [l, q.criteria[l] ?? null])) } : q;
  }
  return { trigger: "ask", state: r.state, questions: qs, timeoutMs: 120_000 };
}

/** Compare answers with the PyTorch reference: decision agreement and max |p - p_torch|. */
export function compare(i: number, answers: Record<string, any>) {
  let agree = 0;
  let total = 0;
  let maxProb = 0;
  const diffs: string[] = [];
  for (const [qid, ref] of Object.entries<number[]>(torch[i].probs)) {
    const a = answers[qid];
    let same: boolean;
    if (a.type === "noul") {
      maxProb = Math.max(maxProb, Math.abs(a.noul - ref[0]));
      same = a.noul >= 0.5 === ref[0] >= 0.5;
      if (!same) diffs.push(`${requests[i].id}/${qid}: noul ${a.noul.toFixed(3)} vs torch ${ref[0].toFixed(3)}`);
    } else {
      const got = Object.values<number>(a.probabilities);
      got.forEach((x, j) => (maxProb = Math.max(maxProb, Math.abs(x - ref[j]))));
      const g = got.indexOf(Math.max(...got));
      const t = ref.indexOf(Math.max(...ref));
      same = g === t;
      if (!same) diffs.push(`${requests[i].id}/${qid}: argmax ${g} (p=${got[g].toFixed(3)}, torch p=${ref[g].toFixed(3)}) vs torch ${t} (p=${ref[t].toFixed(3)}, got p=${got[t].toFixed(3)})`);
      if (a.type === "choice") expect(Object.keys(a.probabilities)).toEqual(packs[i].q_index[qid].labels);
    }
    agree += Number(same);
    total++;
  }
  if (diffs.length) console.log(`[parity] decisions that differ from PyTorch: ${diffs.join("; ")}`);
  return { agree, total, maxProb };
}

export const PARITY_IDS = [0, 7, 13, 21, 29, 36, 42, 49];

/** Parity over several fixture requests on a ready page. */
export async function parityRun(page: Page, ids = PARITY_IDS) {
  let agree = 0;
  let total = 0;
  let maxProb = 0;
  for (const i of ids) {
    const r = await evaluate(page, fixtureRequest(i));
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const c = compare(i, r.answers);
    agree += c.agree;
    total += c.total;
    maxProb = Math.max(maxProb, c.maxProb);
  }
  return { requests: ids.length, agree, total, maxProb };
}

// ---------------------------------------------------------------------------------------------- latency

/** A situation-shaped state (runtime trigger "mutation") with `lines` timeline entries. */
export function situation(lines: number, seed = 1) {
  const ev = [
    'user click "Refresh"',
    "GET /api/orders/:id started",
    "user input orders.note",
    "PATCH /api/orders/:id started",
    "PATCH /api/orders/:id ok 200 in 182 ms",
    "state orders.items v6 (3 items)",
    "GET /api/inventory?sku=:id ok 200 in 95 ms",
    "state inventory.stock v12",
  ];
  return {
    app: "Orders dashboard (route /orders/:id)",
    trigger: "A write to orders.items by GET /api/orders/:id (started 1.24 s ago) is about to apply.",
    facts: [
      'GET /api/orders/:id started 1.24 s ago, caused by a click on "Refresh" (user action #41).',
      "orders.items was at version 4 when GET /api/orders/:id started and is at version 6 now.",
      "Versions 5 and 6 of orders.items were written by PATCH /api/orders/:id, which started 0.42 s after it.",
      "An identical GET /api/orders/:id finished 0.31 s ago (same user action).",
      "orders.total was written 0.05 s ago by the PATCH; the write would change it from 42.5 to 37.0.",
      "GET /api/orders/:id usually takes 180 ms (p95 420 ms); this one took 1,240 ms (6.9x the median).",
    ],
    in_flight: ["PATCH /api/orders/:id (0.42 s)", "GET /api/orders/:id (1.24 s)"],
    timeline: Array.from({ length: lines }, (_, i) => `-${(lines * 0.11 - i * 0.11 + (seed % 3) * 0.01).toFixed(2)}s ${ev[(i + seed) % ev.length]} (op #${100 + i})`),
    state: ["orders.items: 3 items (ids 17, 18, 21)", "orders.total: 42.5", 'orders.note: "leave at the door"', "inventory.stock: {sku-17: 4, sku-18: 0}"],
    stats: ["GET /api/orders/:id: median 180 ms, p95 420 ms, 2% errors over 317 calls", "PATCH /api/orders/:id: median 160 ms, p95 300 ms"],
  };
}

/** The two standing questions of a mutation trigger: diagnosis (8 options) and action (4 options). */
export const QUESTIONS = {
  diagnosis: {
    type: "choice",
    instructions: "What is going on with this write?",
    criteria: {
      expected: "normal behaviour, nothing is wrong",
      stale: "outdated data or an older operation is about to replace newer state",
      conflict: "concurrent operations are competing over the same state or resource",
      duplicate: "the same change or request is happening again without a new intent",
      inconsistent: "the state contradicts itself or relationships it normally keeps",
      failing: "an operation keeps failing or its failures follow a pattern",
      slow: "an operation is far slower than usual",
      overload: "work is being triggered far more often than usual",
    },
  },
  action: {
    type: "choice",
    instructions: "What should the runtime do with this write?",
    criteria: {
      apply: "let this write update the state now",
      discard: "drop this write and keep the current state",
      defer: "hold this write until the related in-flight operations finish, then decide again",
      ignore: "leave the state as it is",
    },
  },
};

/** A request whose state packs to about `target` tokens (measured with the loaded tokenizer). */
export async function sizedRequest(page: Page, target: number) {
  let lo = 1;
  let hi = 200;
  let best = { lines: 1, tokens: 0 };
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = await page.evaluate(([s, q]) => (window as any).GC.measure(s, q), [situation(mid), QUESTIONS] as const);
    if (Math.abs(m.stateTokens - target) < Math.abs(best.tokens - target)) best = { lines: mid, tokens: m.stateTokens };
    if (m.stateTokens < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return { req: { trigger: "mutation", state: situation(best.lines), questions: QUESTIONS, priority: 2 }, stateTokens: best.tokens };
}

export const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

/** Warm forward/wall medians for ~600- and ~1,000-token states (2 choice questions, 8 + 4 options). */
export async function benchSizes(page: Page, label: string, runs = 10) {
  const out: Record<string, unknown> = {};
  for (const target of [600, 1000]) {
    const { req, stateTokens } = await sizedRequest(page, target);
    const b = await page.evaluate(([r, n]) => (window as any).GC.bench(r, n), [req, runs] as const);
    out[`state${target}`] = {
      stateTokens,
      sequenceTokens: b.usage.input_tokens,
      forwardMsMedian: Math.round(median(b.forward)),
      wallMsMedian: Math.round(median(b.wall)),
      forwardMsMin: Math.round(Math.min(...b.forward)),
    };
    console.log(
      `[latency ${label}] ~${target}-token state (${stateTokens} state / ${b.usage.input_tokens} sequence tokens, 2 choice questions 8+4 options): forward median ${Math.round(median(b.forward))} ms, wall median ${Math.round(median(b.wall))} ms`,
    );
  }
  return out;
}
