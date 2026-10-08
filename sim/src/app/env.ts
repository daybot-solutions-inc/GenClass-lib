// What app programs see. Programs are real async closures; they talk to the world only through this
// environment: `fetch` (the runtime-instrumented global fetch in real runs), timers (through the same `global`
// object, so the runtime's timers observer can wrap them), stores (runtime atoms in real runs, plain atoms in the
// ideal run), a live push channel, and `uncaught` for errors that would reach window.onerror.

import type { Rng } from "../rng.js";
import type { Knowledge, SimOp, SimWrite } from "../oracle/knowledge.js";

export interface AtomLike<T> {
  readonly name: string;
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: (v: T) => void): () => void;
}

export interface StoreOpts {
  resync?: () => Promise<unknown> | unknown;
  /** Per top-level field weight in the divergence metric (default 1). */
  weights?: Record<string, number>;
}

export interface WriteMeta {
  role: string;
  feature: string;
  op?: SimOp;
  intent?: number;
  key?: string;
  anomaly?: string;
  classify?: () => string | undefined;
}

export interface Store<T> {
  readonly name: string;
  get(): T;
  set(next: T | ((prev: T) => T), meta: WriteMeta): void;
}

export interface StoreBackend {
  atom<T>(name: string, initial: T, opts?: { resync?: () => Promise<unknown> | unknown }): AtomLike<T>;
}

/** The `global` object handed to the runtime (fetch/timers are instrumented in place by the runtime). */
export interface SimGlobal {
  addEventListener: (type: string, fn: (e: Event) => void) => void;
  removeEventListener: (type: string, fn: (e: Event) => void) => void;
  dispatchEvent: (e: Event) => boolean;
  navigator: { onLine: boolean; userAgent: string };
  localStorage: Storage;
  fetch: (input: unknown, init?: RequestInit) => Promise<Response>;
  setTimeout: (fn: () => void, ms?: number) => unknown;
  clearTimeout: (h: unknown) => void;
  setInterval: (fn: () => void, ms?: number) => unknown;
  clearInterval: (h: unknown) => void;
  location: { href: string; pathname: string; search: string; origin: string; host: string };
  document: { title: string; visibilityState?: string; hidden?: boolean };
  [k: string]: unknown;
}

export interface RegisteredStore {
  name: string;
  feature: string;
  atom: AtomLike<unknown>;
  weights: Record<string, number>;
}

/** The runtime's default `policy.idempotencyHeaders` (situation-v2.2). */
export const IDEMPOTENCY_HEADERS = ["idempotency-key", "x-idempotency-key"];

export class AppEnv {
  readonly stores: RegisteredStore[] = [];
  /** Results of app requests by sim op id (ideal-world exactly-once sharing). */
  readonly results = new Map<number, Promise<import("./kit.js").CallResult>>();
  dirty = true;
  uncaughtCount = 0;
  private pushSub: (topic: string, fn: (msg: unknown) => void) => () => void;
  onUncaught: ((err: unknown, source: string) => void) | null = null;

  constructor(
    readonly ideal: boolean,
    readonly G: SimGlobal,
    readonly backend: StoreBackend,
    readonly know: Knowledge,
    readonly rng: Rng,
    pushSub: (topic: string, fn: (msg: unknown) => void) => () => void,
    readonly nowFn: () => number,
  ) {
    this.pushSub = pushSub;
  }

  now(): number {
    return this.nowFn();
  }

  setTimeout(fn: () => void, ms: number): unknown {
    return this.G.setTimeout(fn, ms);
  }

  clearTimeout(h: unknown): void {
    this.G.clearTimeout(h);
  }

  setInterval(fn: () => void, ms: number): unknown {
    return this.G.setInterval(fn, ms);
  }

  clearInterval(h: unknown): void {
    this.G.clearInterval(h);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => this.G.setTimeout(r, ms));
  }

  /** Call the (instrumented) global fetch, marking which app op is calling so the runtime op can be correlated. */
  fetch(url: string, init: RequestInit | undefined, op: SimOp): Promise<Response> {
    const k = this.know;
    k.callingOp = op;
    try {
      const h = new Headers(init?.headers ?? {});
      op.idemKey = IDEMPOTENCY_HEADERS.some((n) => h.has(n));
      return this.G.fetch(url, init);
    } finally {
      k.callingOp = null;
    }
  }

  subscribe(topic: string, fn: (msg: unknown) => void): () => void {
    return this.pushSub(topic, fn);
  }

  /** Open a live channel: a WebSocket to wss://<host>/ws/<path> whose JSON messages go to fn. */
  socket(path: string, fn: (msg: unknown) => void): void {
    const WS = this.G.WebSocket as (new (url: string) => EventTarget) | undefined;
    if (!WS) {
      this.pushSub(path, fn);
      return;
    }
    const ws = new WS(`wss://${this.G.location.host}/ws/${path.split("/").map(encodeURIComponent).join("/")}`);
    const know = this.know;
    ws.addEventListener("message", (e) => {
      // Tag writes made by this handler with the push message they come from (delivery-decision diagnosis).
      const id = pushIds.get(e) ?? pushIdsByData.get(String((e as MessageEvent).data)) ?? null;
      const prev = know.currentPush;
      know.currentPush = id;
      try {
        fn(JSON.parse(String((e as MessageEvent).data)));
      } finally {
        know.currentPush = prev;
      }
    });
  }

  store<T>(name: string, feature: string, initial: T, opts: StoreOpts = {}): Store<T> {
    const atomOpts: { resync?: () => Promise<unknown> | unknown } = {};
    if (opts.resync) atomOpts.resync = opts.resync;
    const atom = this.backend.atom<T>(name, initial, atomOpts);
    atom.subscribe(() => {
      this.dirty = true;
    });
    this.stores.push({ name, feature, atom: atom as AtomLike<unknown>, weights: opts.weights ?? {} });
    const know = this.know;
    return {
      name,
      get: () => atom.get(),
      set: (next, meta) => {
        const w: Omit<SimWrite, "id" | "t"> = { store: name, feature: meta.feature, role: meta.role };
        if (meta.op) w.op = meta.op.id;
        const intent = meta.intent ?? meta.op?.intent;
        if (intent !== undefined) w.intent = intent;
        const key = meta.key ?? meta.op?.key;
        if (key !== undefined) w.key = key;
        const anomaly = meta.anomaly ?? meta.op?.anomaly;
        if (anomaly) w.anomaly = anomaly;
        if (meta.classify) w.classify = meta.classify;
        // Top-level fields this write changes relative to the current value (updaters are pure).
        let cur: unknown;
        let nv: unknown;
        try {
          cur = atom.get() as unknown;
          nv = (typeof next === "function" ? (next as (p: T) => T)(atom.get()) : next) as unknown;
          if (cur && nv && typeof cur === "object" && typeof nv === "object" && !Array.isArray(cur)) {
            const f: string[] = [];
            for (const k of new Set([...Object.keys(cur as object), ...Object.keys(nv as object)])) {
              if ((cur as Record<string, unknown>)[k] !== (nv as Record<string, unknown>)[k]) f.push(k);
            }
            w.fields = f;
          }
        } catch {
          /* ignore */
        }
        const rec = know.write(w);
        if (know.probe) {
          try {
            know.probe.onWrite(rec, cur, nv);
          } catch {
            /* analysis only */
          }
        }
        if (meta.role === "input" && rec.fields) for (const f of rec.fields) know.userFieldTime.set(`${name}.${f}`, know.now());
        if (know.onWrite) know.onWrite(rec);
        know.writing = rec;
        try {
          atom.set(next);
        } finally {
          know.writing = null;
        }
      },
    };
  }

  /** Fixed wall-clock epoch for timestamps (deterministic). */
  static readonly EPOCH = Date.UTC(2026, 9, 7, 14, 0, 0);
  /** Client clock skew (ms): the device clock is off by this much. */
  skewMs = 0;
  /** Wall-clock time as the client's (possibly skewed) clock reads it. */
  clientNow(): number {
    return AppEnv.EPOCH + this.nowFn() + this.skewMs;
  }
  /** A long task: block the main thread for `ms`. */
  busy(ms: number): void {
    this.blocker?.(ms);
  }
  blocker: ((ms: number) => void) | null = null;
  on(type: string, fn: (e: Event) => void): void {
    this.G.addEventListener(type, fn);
  }
  get online(): boolean {
    return this.G.navigator.onLine;
  }
  /** Open a BroadcastChannel (multi-tab sync) if the platform has one. */
  channel(name: string, fn: (msg: unknown) => void): { post(msg: unknown): void } {
    const BC = this.G.BroadcastChannel as (new (n: string) => { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null }) | undefined;
    if (!BC) return { post: () => undefined };
    const bc = new BC(name);
    bc.onmessage = (e) => fn(e.data);
    return { post: (m) => bc.postMessage(m) };
  }

  /** Client-side navigation (history.pushState): updates location for the runtime's `app` section. */
  setRoute(path: string): void {
    const L = this.G.location;
    L.pathname = path;
    L.search = "";
    L.href = `${L.origin}${path}`;
    this.route = path;
  }
  route = "/";

  /** An error that escapes the app (window.onerror / unhandledrejection). */
  uncaughtTimes: number[] = [];
  uncaught(err: unknown, source = "unhandledrejection"): void {
    this.uncaughtCount++;
    this.uncaughtTimes.push(this.now());
    if (this.onUncaught) this.onUncaught(err, source);
  }

  snapshot(): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (const s of this.stores) o[s.name] = s.atom.get();
    return o;
  }
}

/** Plain atoms for the ideal run (and for tests). */
export class PlainBackend implements StoreBackend {
  atom<T>(name: string, initial: T): AtomLike<T> {
    let v = initial;
    const subs = new Set<(v: T) => void>();
    return {
      name,
      get: () => v,
      set: (next) => {
        const nv = typeof next === "function" ? (next as (p: T) => T)(v) : next;
        if (Object.is(nv, v)) return;
        v = nv;
        for (const fn of subs) fn(v);
      },
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    };
  }
}

/** Push ids of message events dispatched by the virtual socket (by event object, and by payload as a fallback). */
export const pushIds = new WeakMap<object, number>();
export const pushIdsByData = new Map<string, number>();
