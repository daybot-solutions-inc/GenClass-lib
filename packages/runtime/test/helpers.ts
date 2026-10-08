// Test helpers for CORE tests: a deterministic fake clock with a macrotask/microtask/afterTask model, a scripted
// DecisionProvider, and a virtual HTTP server exposed as a fetch function.

import type { Answer, ChoiceAnswer, Clock, DecisionProvider, EvaluateRequest, ModelStatus } from "../src/types.js";

const realSetImmediate = (globalThis as unknown as { setImmediate: (fn: () => void) => void }).setImmediate;

/** Let pending microtasks (and Node nextTicks) run. */
export async function drain(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => realSetImmediate(r));
}

export class FakeClock implements Clock {
  t = 1000;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;
  private after: (() => void)[] = [];

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  afterTask(fn: () => void): void {
    this.after.push(fn);
  }
  get pending(): number {
    return this.timers.length;
  }
  /** End of the current macrotask: drain microtasks, then run afterTask hooks (repeat until stable). */
  async flush(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await drain();
      if (!this.after.length) return;
      const a = this.after;
      this.after = [];
      for (const f of a) f();
    }
  }
  /** Advance virtual time, running due timers in order, each as its own macrotask. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await this.flush();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await this.flush();
    }
    this.t = end;
    await this.flush();
  }
  /** Run timers until none remain (bounded by maxMs of virtual time). */
  async runAll(maxMs = 120_000): Promise<void> {
    const stop = this.t + maxMs;
    while (this.timers.length && this.t < stop) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      await this.advance(Math.max(0, this.timers[0].at - this.t));
    }
  }
}

export function choice<L extends string>(label: L, labels: string[], p = 0.97): ChoiceAnswer<L> {
  const k = labels.length;
  const rest = k > 1 ? (1 - p) / (k - 1) : 0;
  const probabilities = {} as Record<L, number>;
  for (const l of labels) probabilities[l as L] = l === label ? p : rest;
  return { type: "choice", choice: label, confidence: k > 1 ? (k * p - 1) / (k - 1) : 1, probabilities };
}

type Script = (req: EvaluateRequest) => Record<string, Answer> | Promise<Record<string, Answer>>;

export class ScriptedDecider implements DecisionProvider {
  status: ModelStatus = { state: "ready", model: "scripted" };
  calls: EvaluateRequest[] = [];
  constructor(public script: Script = defaultScript()) {}
  ready(): Promise<void> {
    return Promise.resolve();
  }
  evaluate(req: EvaluateRequest): Promise<Record<string, Answer>> {
    this.calls.push(req);
    return Promise.resolve(this.script(req));
  }
}

/** Answer every trigger with the given diagnosis/action (falling back to the passive action if not offered). */
export function defaultScript(pick: Partial<Record<string, { diagnosis: string; action?: string; p?: number }>> = {}): Script {
  return (req) => {
    const out: Record<string, Answer> = {};
    const want = pick[req.trigger] ?? { diagnosis: "expected" };
    const dq = req.questions.diagnosis;
    if (dq && dq.type === "choice") out.diagnosis = choice(want.diagnosis, Object.keys(dq.criteria), want.p ?? 0.97);
    const aq = req.questions.action;
    if (aq && aq.type === "choice") {
      const labels = Object.keys(aq.criteria);
      const a = want.action && labels.includes(want.action) ? want.action : labels[0];
      out.action = choice(a, labels, want.p ?? 0.97);
    }
    for (const [qid, q] of Object.entries(req.questions)) {
      if (qid in out) continue;
      if (q.type === "noul") out[qid] = { type: "noul", noul: 0.9 };
      else if (q.type === "choice") out[qid] = choice(Object.keys(q.criteria)[0], Object.keys(q.criteria));
      else out[qid] = { type: "score", score: 1, confidence: 0.5, probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), 1 / q.criteria.length])) };
    }
    return out;
  };
}

export interface Route {
  status?: number;
  body?: unknown;
  latency?: number;
  error?: "network";
  headers?: Record<string, string>;
}

type Handler = (req: { method: string; url: URL; body: string | null; n: number }) => Route;

/** A virtual server: fetch resolves after `latency` ms of fake-clock time. */
export class FakeServer {
  routes = new Map<string, Handler>();
  hits = new Map<string, number>();
  log: { method: string; path: string; t: number }[] = [];
  constructor(private clock: FakeClock) {}

  on(method: string, path: string, h: Handler | Route): this {
    this.routes.set(`${method.toUpperCase()} ${path}`, typeof h === "function" ? h : () => h);
    return this;
  }

  fetch = (input: unknown, init?: Record<string, unknown>): Promise<Response> => {
    const method = String(init?.method ?? (input as Request)?.method ?? "GET").toUpperCase();
    const raw = typeof input === "string" ? input : (input as Request)?.url ?? String(input);
    const url = new URL(raw, "http://app.test/");
    const key = `${method} ${url.pathname}`;
    const n = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, n);
    this.log.push({ method, path: url.pathname + url.search, t: this.clock.now() });
    const h = this.routes.get(key);
    const body = typeof init?.body === "string" ? init.body : null;
    const r: Route = h ? h({ method, url, body, n }) : { status: 404, body: { error: "not found" } };
    const signal = init?.signal as AbortSignal | undefined;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = this.clock.setTimeout(() => {
        if (r.error === "network") return reject(new TypeError("Failed to fetch"));
        resolve(new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } }));
      }, r.latency ?? 50);
      signal?.addEventListener("abort", () => {
        this.clock.clearTimeout(timer);
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      });
    });
  };
}

/** A minimal headless global with an instrumentable fetch. */
export function makeGlobal(server: FakeServer, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fetch: server.fetch,
    Response,
    location: { href: "http://app.test/search", pathname: "/search", search: "" },
    document: undefined,
    ...extra,
  };
}

import { createRuntime } from "../src/index.js";
import type { CreateOptions } from "../src/types.js";
import type { RuntimeImpl } from "../src/runtime.js";

export interface Setup {
  clock: FakeClock;
  server: FakeServer;
  g: Record<string, unknown>;
  decider: ScriptedDecider;
  rt: RuntimeImpl;
  fetch: (u: string, i?: RequestInit) => Promise<Response>;
}

/** A headless runtime on a fake clock and a fake server (fetch observer on, others off unless asked). */
export function setup(opts: Partial<CreateOptions> & { script?: Script; extraGlobal?: Record<string, unknown> } = {}): Setup {
  const clock = new FakeClock();
  const server = new FakeServer(clock);
  const g = makeGlobal(server, opts.extraGlobal ?? {});
  const decider = new ScriptedDecider(opts.script ?? defaultScript());
  const { script: _s, extraGlobal: _e, ...rest } = opts;
  const rt = createRuntime({
    clock,
    global: g,
    decider,
    // Most CORE tests exercise interventions, so the harness keeps guard; the product default is observe.
    mode: "guard",
    report: "silent",
    observe: { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false },
    ...rest,
  }) as RuntimeImpl;
  return { clock, server, g, decider, rt, fetch: (u, i) => (g.fetch as typeof fetch)(u, i) };
}

/** A decider whose answers the test releases by hand (to control timing and order). */
export class ManualDecider implements DecisionProvider {
  status: ModelStatus = { state: "ready", model: "manual" };
  pending: { req: EvaluateRequest; resolve: (a: Record<string, Answer>) => void; reject: (e: unknown) => void }[] = [];
  ready(): Promise<void> {
    return Promise.resolve();
  }
  evaluate(req: EvaluateRequest): Promise<Record<string, Answer>> {
    return new Promise((resolve, reject) => this.pending.push({ req, resolve, reject }));
  }
  /** Answer the oldest pending request with the script. */
  answer(script: Script = defaultScript()): EvaluateRequest {
    const p = this.pending.shift();
    if (!p) throw new Error("nothing pending");
    p.resolve(script(p.req) as Record<string, Answer>);
    return p.req;
  }
}
