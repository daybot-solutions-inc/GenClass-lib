// Headless Chromium runner: one browser per worker process, a fresh page per run (init script = run config +
// world bundle), contexts recycled every N runs. Apps are served from memory at https://app.example.com/ through
// request interception (a secure context with no port in any URL; every other host fails DNS).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext } from "playwright";
import type { RunConfig, RunResult } from "../shared/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DIST = join(HERE, "..");
let WORLD: string | null = null;
function world(): string {
  if (!WORLD) WORLD = readFileSync(join(DIST, "world.js"), "utf8");
  return WORLD;
}

/** Every app is served from this origin (secure context, no port): request interception, no real network. */
export const ORIGIN = "https://app.example.com";
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon" };
const fileCache = new Map<string, Buffer | null>();
function appFile(app: string, path: string): { body: Buffer; type: string } | null {
  const clean = path.replace(/\?.*$/, "").replace(/\.\.+/g, "");
  let f = join(DIST, "apps", app, clean === "/" ? "index.html" : clean);
  let body = fileCache.get(f);
  if (body === undefined) {
    body = existsSync(f) && !f.endsWith("/") ? readFileSync(f) : null;
    fileCache.set(f, body);
  }
  if (!body) {
    // SPA fallback: any unknown path is the app's index.html
    f = join(DIST, "apps", app, "index.html");
    body = fileCache.get(f) ?? (existsSync(f) ? readFileSync(f) : null);
    if (body) fileCache.set(f, body);
  }
  if (!body) return null;
  const ext = f.split(".").pop() ?? "";
  return { body, type: TYPES[ext] ?? "application/octet-stream" };
}

export class Runner {
  private browser: Browser | null = null;
  private ctx: BrowserContext | null = null;
  private runs = 0;
  totalRuns = 0;
  realMs = 0;
  /** Time split (ms): page creation, navigation + app load, in-page session, close. */
  phases = { page: 0, load: 0, session: 0, close: 0 };
  constructor(private readonly port: number) {}

  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      // every host except *.localhost fails to resolve: images/fonts an app links to never load on real time
      args: ["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE *.localhost , EXCLUDE localhost , EXCLUDE 127.0.0.1", "--disable-gpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=1024"],
    });
  }

  private async context(): Promise<BrowserContext> {
    if (!this.ctx || this.runs >= 60) {
      await this.ctx?.close().catch(() => undefined);
      this.ctx = await this.browser!.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce", serviceWorkers: "block", javaScriptEnabled: true });
      this.runs = 0;
    }
    this.runs++;
    return this.ctx;
  }

  async run(cfg: RunConfig, timeoutMs = 180000): Promise<RunResult> {
    if (!this.browser) await this.start();
    const t0 = Date.now();
    const ctx = await this.context();
    const page = await ctx.newPage();
    const t1 = Date.now();
    this.phases.page += t1 - t0;
    let t2 = t1;
    let t3 = t1;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.length < 5 && errors.push(String(e?.message ?? e).slice(0, 300)));
    page.on("crash", () => errors.push("page crashed"));
    try {
      await page.addInitScript({ content: `window.__RW_CFG=${JSON.stringify(cfg)};\n${world()}` });
      await page.route(`${ORIGIN}/**`, (route) => {
        const f = appFile(cfg.app, new URL(route.request().url()).pathname);
        return f ? route.fulfill({ status: 200, body: f.body, contentType: f.type }) : route.fulfill({ status: 404, body: "not found" });
      });
      await page.goto(`${ORIGIN}/`, { waitUntil: "load", timeout: 60000 });
      t2 = Date.now();
      this.phases.load += t2 - t1;
      let timer: NodeJS.Timeout | undefined;
      const json = await Promise.race([
        page.evaluate(() => (window as unknown as { __RW: { start(): Promise<string> } }).__RW.start()),
        new Promise<string>((_, rej) => (timer = setTimeout(() => rej(new Error(`run timeout ${timeoutMs} ms`)), timeoutMs))),
      ]).finally(() => clearTimeout(timer));
      t3 = Date.now();
      this.phases.session += t3 - t2;
      const res = JSON.parse(json) as RunResult;
      if (errors.length) res.internalErrors.push(...errors.map((e) => `pageerror: ${e}`));
      return res;
    } catch (e) {
      return { runId: cfg.runId, ok: false, error: String((e as Error)?.message ?? e).slice(0, 500), tStop: cfg.tStop, tasks: 0, realMs: Date.now() - t0, decisions: [], snapshots: [], initial: { t: 0 }, net: [], server: { collections: {}, docs: {}, counters: {} }, errorEpisodes: [], uncaught: [], userOps: [], stepsRun: 0, stepsSkipped: 0, internalErrors: errors, wsMessages: 0 };
    } finally {
      this.totalRuns++;
      const t4 = Date.now();
      await page.close().catch(() => undefined);
      this.phases.close += Date.now() - t4;
      this.realMs += Date.now() - t0;
    }
  }

  async close(): Promise<void> {
    await this.ctx?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }
}
