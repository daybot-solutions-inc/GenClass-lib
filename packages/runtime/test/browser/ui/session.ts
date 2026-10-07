// A scripted store app running on the REAL runtime (createRuntime) under virtual time, for the devtools
// integration tests and the README screenshots. Runs in Node (vitest) and in the browser (Playwright page).
//
// Pieces: a virtual clock (macrotasks by virtual time; after each one a real task boundary drains microtasks,
// then afterTask hooks run), a fake backend (fetch with virtual latencies), a rule-based test decider standing in
// for the model (it reads the facts the runtime wrote, like any DecisionProvider), and a small app using atoms.

import { createRuntime } from "../../../src/index.js";
import type { Answer, ChoiceAnswer, Clock, DecisionProvider, EvaluateRequest, ModelStatus, Runtime } from "../../../src/types.js";

// ------------------------------------------------------------------------------------------------- clock

export class VirtualClock implements Clock {
  t = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;
  private after: (() => void)[] = [];
  constructor(private readonly turn: () => Promise<void>) {}
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
  /** End of a macrotask: let microtasks (and body reads) settle, then run afterTask hooks, until stable. */
  async settle(): Promise<void> {
    for (let i = 0; i < 64; i++) {
      for (let k = 0; k < 4; k++) await this.turn();
      if (!this.after.length) return;
      const a = this.after;
      this.after = [];
      for (const f of a) f();
    }
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await this.settle();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await this.settle();
    }
    this.t = end;
    await this.settle();
  }
}

/** A real task boundary: setImmediate in Node, MessageChannel in browsers. */
export function realTurn(): () => Promise<void> {
  const g = globalThis as { setImmediate?: (fn: () => void) => void };
  if (typeof g.setImmediate === "function") return () => new Promise((r) => g.setImmediate!(r));
  const ch = new MessageChannel();
  const q: (() => void)[] = [];
  ch.port1.onmessage = () => q.shift()?.();
  return () =>
    new Promise<void>((r) => {
      q.push(r);
      ch.port2.postMessage(0);
    });
}

// ----------------------------------------------------------------------------------------------- backend

interface Reply {
  status?: number;
  body?: unknown;
  latency: number;
}

interface Item {
  id: number;
  name: string;
  price: number;
  qty: number;
}

const CATALOG: Item[] = [
  { id: 17, name: "Desk lamp", price: 20.99, qty: 1 },
  { id: 23, name: "Monitor arm", price: 41.99, qty: 1 },
  { id: 31, name: "Keyboard tray", price: 21.99, qty: 1 },
  { id: 38, name: "Cable box", price: 14.5, qty: 1 },
  { id: 42, name: "Footrest", price: 32.0, qty: 1 },
  { id: 47, name: "Webcam light", price: 18.75, qty: 1 },
  { id: 53, name: "Desk mat", price: 24.9, qty: 1 },
];
const PACKAGES = ["react", "react-dom", "react-router", "react-query", "readable-stream", "readline", "reakit", "realm", "redux", "reselect", "recoil", "remix"];

const totalOf = (items: Item[]): number => items.reduce((s, it) => s + it.price * it.qty, 0);

class Backend {
  cart: Item[] = [{ ...CATALOG[0], qty: 3 }, { ...CATALOG[1] }];
  statusDown = false;
  partialCart = false;
  recsLatency = 300;
  searchLatency: Record<string, number> = {};
  private orderId = 5520;
  private adds = 0;

  constructor(private readonly clock: VirtualClock) {}

  fetch = (input: unknown, init?: Record<string, unknown>): Promise<Response> => {
    const method = String(init?.method ?? "GET").toUpperCase();
    const url = new URL(typeof input === "string" ? input : String((input as { url?: string }).url ?? input), "https://acme.test/");
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const r = this.route(method, url, body);
    return new Promise<Response>((resolve) => {
      this.clock.setTimeout(() => {
        resolve(new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } }));
      }, r.latency);
    });
  };

  private route(method: string, url: URL, body: Record<string, unknown> | null): Reply {
    const key = `${method} ${url.pathname}`;
    switch (key) {
      case "GET /api/session":
        return { body: { user: { id: 42, name: "Mehar" }, flags: { beta: true } }, latency: 140 };
      case "GET /api/cart":
        return { body: { items: this.cart, total: totalOf(this.cart) }, latency: 120 };
      case "POST /api/cart": {
        const id = Number(body?.id);
        if (body?.op === "add") this.cart = [...this.cart, { ...CATALOG.find((c) => c.id === id)!, qty: 1 + (this.adds++ % 3) }];
        else this.cart = this.cart.filter((c) => c.id !== id);
        // the injected server bug: a partial response without the total
        return { body: this.partialCart ? { items: this.cart } : { items: this.cart, total: totalOf(this.cart) }, latency: 110 + (id % 5) * 9 };
      }
      case "POST /api/orders":
        return { status: 201, body: { id: ++this.orderId, status: "created", total: 84.97 }, latency: 420 };
      case "GET /api/search": {
        const q = url.searchParams.get("q") ?? "";
        return { body: { q, items: PACKAGES.filter((p) => p.startsWith(q)).map((name) => ({ name })) }, latency: this.searchLatency[q] ?? 180 };
      }
      case "GET /api/status":
        return this.statusDown ? { status: 503, body: { error: "unavailable" }, latency: 48 } : { body: { ok: true, services: 6 }, latency: 52 };
      case "GET /api/recommendations":
        return { body: { items: ["Desk mat", "Cable box"] }, latency: this.recsLatency };
      default:
        return { status: 404, body: { error: "not found" }, latency: 30 };
    }
  }
}

// ----------------------------------------------------------------------------------------------- decider

const factsOf = (req: EvaluateRequest): string => {
  const f = req.state.facts;
  return Array.isArray(f) ? f.join("\n") : String(f ?? "");
};

/** Spread the remaining mass over the other labels with decreasing weights (reads like a real softmax). */
function answer(labels: string[], top: string, p: number): ChoiceAnswer {
  const pick = labels.includes(top) ? top : labels[0];
  const rest = labels.filter((l) => l !== pick);
  const probabilities: Record<string, number> = { [pick]: p };
  let left = 1 - p;
  rest.forEach((l, i) => {
    const share = i === rest.length - 1 ? left : left * 0.62;
    probabilities[l] = share;
    left -= share;
  });
  const k = labels.length;
  return { type: "choice", choice: pick, confidence: k > 1 ? (k * p - 1) / (k - 1) : 1, probabilities };
}

type Verdict = [diagnosis: string, pd: number, action: string | null, pa: number];

/** Stand-in for the model: maps the runtime's facts to answers (test double, like any custom DecisionProvider). */
function judge(req: EvaluateRequest): Verdict {
  const f = factsOf(req);
  switch (req.trigger) {
    case "mutation":
      if (/An identical change[^\n]*applied (0\.\d+|1\.\d+)s ago/.test(f)) return ["duplicate", 0.94, "discard", 0.95];
      if (/by other operations since/.test(f) && /later user action/.test(f)) return ["stale", 0.97, "discard", 0.98];
      return ["expected", 0.96, null, 0.97];
    case "request":
      if (/identical [^\n]* request[^\n]*in flight/.test(f) && !/failed in a row/.test(f)) return ["duplicate", 0.95, "coalesce", 0.96];
      if (/The last ([4-9]|\d\d) [^\n]* failed in a row/.test(f)) return ["failing", 0.91, "delay", 0.93];
      return ["expected", 0.95, null, 0.96];
    case "failure":
      return /\b(2nd|3rd|[4-9]th) .* failure in a row/.test(f) ? ["failing", 0.78, null, 0.88] : ["expected", 0.71, null, 0.9];
    case "stall":
      return ["slow", 0.84, "hedge", 0.71];
    case "transition":
      return ["unusual", 0.88, "rollback", 0.64];
    case "inconsistency":
      return ["inconsistent", 0.9, "rollback", 0.58];
    default:
      return ["expected", 0.9, null, 0.9];
  }
}

export const READY: ModelStatus = {
  state: "ready",
  device: "webgpu",
  variant: "fp16",
  model: "genclass-runtime-0.1",
  loadMs: 1240,
  progress: { loaded: 24_740_000, total: 24_740_000 },
};

export class SessionDecider implements DecisionProvider {
  status: ModelStatus;
  private subs = new Set<(s: ModelStatus) => void>();
  constructor(
    private readonly clock: Clock,
    status: ModelStatus = READY,
  ) {
    this.status = status;
  }
  ready(): Promise<void> {
    return Promise.resolve();
  }
  setStatus(s: ModelStatus): void {
    this.status = s;
    for (const fn of this.subs) fn(s);
  }
  onStatus(fn: (s: ModelStatus) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  evaluate(req: EvaluateRequest): Promise<Record<string, Answer>> {
    const [diagnosis, pd, action, pa] = judge(req);
    const out: Record<string, Answer> = {};
    for (const [qid, q] of Object.entries(req.questions)) {
      if (q.type !== "choice") continue;
      const labels = Object.keys(q.criteria);
      if (qid === "diagnosis") out[qid] = answer(labels, diagnosis, pd);
      else if (qid === "action") out[qid] = answer(labels, action ?? labels[0], action ? pa : 0.97);
      else out[qid] = answer(labels, labels[0], 0.9);
    }
    const latency = 22 + (factsOf(req).length % 17);
    return new Promise((resolve) => this.clock.setTimeout(() => resolve(out), latency));
  }
}

// ---------------------------------------------------------------------------------------------------- app

export interface Session {
  rt: Runtime;
  clock: VirtualClock;
  backend: Backend;
  decider: SessionDecider;
  stores: { search: { get(): { query: string; results: { name: string }[] } } };
  /** The app's user actions, to keep driving it after the scripted story. */
  app: { typeSearch(q: string): void; placeOrder(): void; poll(): Promise<unknown> };
}

export interface SessionOptions {
  /** Stop after the warm-up (no story): for the "model loading" screenshot. */
  warmupOnly?: boolean;
  status?: ModelStatus;
  turn?: () => Promise<void>;
}

const OBSERVE = { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false };

export async function runStoreSession(opts: SessionOptions = {}): Promise<Session> {
  const clock = new VirtualClock(opts.turn ?? realTurn());
  clock.t = 400;
  const backend = new Backend(clock);
  const decider = new SessionDecider(clock, opts.status ?? READY);
  let route = "/search";
  const g: Record<string, unknown> = { fetch: backend.fetch, Response, location: { href: "https://acme.test/search", pathname: "/search", search: "" } };
  const rt = createRuntime({ clock, global: g, decider, report: "silent", observe: OBSERVE, app: () => ({ title: "Acme Store", route }) });
  const http = g.fetch as typeof fetch;
  const json = (path: string, init?: RequestInit) => http(path, init).then((r) => r.json());

  const session = rt.atom("session", { user: null as unknown, flags: {} as Record<string, boolean> });
  const search = rt.atom("search", { query: "", results: [] as { name: string }[] });
  const cart = rt.atom("cart", { items: [] as Item[], total: 0 });
  const orders = rt.atom("orders", { list: [] as { id: number; status: string }[] });
  const status = rt.atom("status", { ok: true, services: 6 });
  const recs = rt.atom("recs", { items: [] as string[] });

  const click = (target: string, fn: () => void) => rt.user({ kind: "click", target }, fn);
  const typeSearch = (q: string) =>
    rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
      search.update((s) => ({ ...s, query: q }));
      json(`/api/search?q=${encodeURIComponent(q)}`).then((d: { items: { name: string }[] }) => search.update((s) => ({ ...s, results: d.items })));
    });
  const cartOp = (op: "add" | "remove", id: number) =>
    click(`button "${op === "add" ? "Add to cart" : "Remove"}"`, () => {
      json("/api/cart", { method: "POST", body: JSON.stringify({ op, id }) }).then((c: { items: Item[]; total?: number }) =>
        cart.set({ items: c.items, total: c.total ?? cart.get().total }),
      );
    });
  const poll = () =>
    http("/api/status").then((r) => (r.ok ? r.json().then((s: { ok: boolean; services: number }) => status.set(s)) : status.update((s) => ({ ...s, ok: false }))));
  const loadRecs = () => json("/api/recommendations?for=cart").then((d: { items: string[] }) => recs.set({ items: d.items }));
  const placeOrder = () =>
    click('button "Place order"', () => {
      json("/api/orders", { method: "POST", body: JSON.stringify({ items: 3, total: 84.97 }) }).then((o: { id: number; status: string }) =>
        orders.update((s) => ({ list: [...s.list, { id: o.id, status: o.status }] })),
      );
    });

  // ---- warm-up: ordinary traffic the runtime learns from (baselines, transition profiles, invariants)
  json("/api/session").then((d: { user: unknown; flags: Record<string, boolean> }) => session.set(d));
  json("/api/cart").then((c: { items: Item[]; total: number }) => cart.set(c));
  await clock.advance(600);
  route = "/cart";
  const ids = [31, 38, 42, 47, 53];
  for (let i = 0; i < 24; i++) {
    cartOp(i % 2 === 0 ? "add" : "remove", ids[Math.floor(i / 2) % ids.length]);
    if (i % 4 === 1) void poll();
    if (i % 5 === 2) void loadRecs();
    await clock.advance(560);
  }
  const done = (): Session => ({ rt, clock, backend, decider, stores: { search }, app: { typeSearch, placeOrder, poll } });
  if (opts.warmupOnly) return done();

  // ---- 1. a flaky status service: failures, then GenClass backs off the next poll
  backend.statusDown = true;
  for (let i = 0; i < 4; i++) {
    void poll();
    await clock.advance(2000);
  }
  void poll(); // after 4 failures in a row: held back (delay), then sent once the service is back
  await clock.advance(400);
  backend.statusDown = false;
  await clock.advance(6600);

  // ---- 2. the cart server returns a partial response: an unusual transition and a broken derived total
  backend.partialCart = true;
  cartOp("remove", 23);
  await clock.advance(900);
  backend.partialCart = false;

  // ---- 3. double submit
  placeOrder();
  await clock.advance(90);
  placeOrder();
  await clock.advance(1400);

  // ---- 4. a request stalls far past its usual latency
  backend.recsLatency = 9000;
  click('button "Recommendations"', () => void loadRecs());
  await clock.advance(1700);

  // ---- 5. search typeahead: the slow response for "rea" arrives after the one for "react"
  route = "/search";
  backend.searchLatency = { rea: 1820, react: 210 };
  typeSearch("rea");
  await clock.advance(390);
  typeSearch("react");
  await clock.advance(1700);

  // ---- 6. an error in a handler
  rt.user({ kind: "change", target: 'input "Qty"', value: "3" }, () => {
    cart.update((c) => ({ ...c, items: c.items.map((it, i) => (i === 0 ? { ...it, qty: 3 } : it)) }));
    rt.reportError(new TypeError("Cannot read properties of undefined (reading 'price')"), { source: "cart.tsx:88" });
  });
  await clock.advance(1100);
  return done();
}
