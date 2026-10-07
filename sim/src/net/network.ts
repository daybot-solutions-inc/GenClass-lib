// Virtual network between the app and the virtual server. `fetch` returns real Node `Response` objects after
// virtual latency, honours AbortSignal, rejects with TypeError on network errors, and models timeouts, outages,
// slow periods, spikes, overload, rate limits, replica lag and server bugs. Randomness is keyed by
// (scenario seed, request identity, occurrence of that identity) so removing or adding one request in a
// counterfactual run does not shift the latency/failure draws of unrelated requests.

import type { VirtualLoop } from "../loop.js";
import { hashAll, Rng } from "../rng.js";
import { canonical, type ServerResponse, type VirtualServer } from "./server.js";

export const BASE_URL = "https://app.example.test";

export interface Win {
  start: number;
  end: number;
}
export type OutageMode = "503" | "500" | "502" | "neterr" | "hang" | "empty";
export interface Outage extends Win {
  endpoints: string[] | "*";
  mode: OutageMode;
}
export interface SlowPeriod extends Win {
  endpoints: string[] | "*";
  mul: number;
}
export type BugKind = "drop-field" | "null-field" | "empty-list" | "stale-replica" | "html";
export interface ServerBug extends Win {
  endpoint: string;
  kind: BugKind;
  field?: string;
}
export interface Lat {
  median: number;
  sigma: number;
}

export interface NetProfile {
  ideal: boolean;
  /** Per-signature latency overrides. */
  latency: Record<string, Lat>;
  byKind: Record<"read" | "write" | "auth" | "upload" | "bulk", Lat>;
  spikeP: number;
  spikeMul: [number, number];
  /** Random 5xx probability per request. */
  transientP: number;
  /** Share of random 500s that happen after the server committed the write. */
  postCommitP: number;
  netErrP: number;
  /** Gateway timeout (504) after this many ms in flight. */
  gatewayMs: number;
  outages: Outage[];
  slow: SlowPeriod[];
  bugs: ServerBug[];
  /** Server-wide capacity: arrivals per second beyond which requests degrade. */
  capacity?: { perSec: number; mode: "503" | "429" | "latency" };
  rateLimits: Record<string, { perSec: number; retryAfter: boolean }>;
  /** Tests: exact latency for a request (method, path+search, occurrence); undefined = use the model. */
  latencyFn?: (method: string, pathAndSearch: string, occurrence: number) => number | undefined;
  replicaLag?: { ms: number; p: number };
  push: { median: number; sigma: number };
}

export const IDEAL_PROFILE: NetProfile = {
  ideal: true,
  latency: {},
  byKind: {
    read: { median: 0, sigma: 0 },
    write: { median: 0, sigma: 0 },
    auth: { median: 0, sigma: 0 },
    upload: { median: 0, sigma: 0 },
    bulk: { median: 0, sigma: 0 },
  },
  spikeP: 0,
  spikeMul: [1, 1],
  transientP: 0,
  postCommitP: 0,
  netErrP: 0,
  gatewayMs: 1e12,
  outages: [],
  slow: [],
  bugs: [],
  rateLimits: {},
  push: { median: 0, sigma: 0 },
};

/** Why a request ended the way it did (sim knowledge, used for diagnosis labels). */
export type NetCause =
  | "ok"
  | "transient"
  | "outage"
  | "overload"
  | "ratelimit"
  | "spike"
  | "slow-period"
  | "gateway-timeout"
  | "bug"
  | "replica-lag"
  | "neterr"
  | "aborted"
  | "notfound";

export const SIM_OP_HEADER = "x-sim-op";

export interface NetEntry {
  id: number;
  /** App-level op (sim knowledge) that issued the request, from the stripped x-sim-op header. */
  simOp?: number;
  t0: number;
  method: string;
  path: string;
  search: string;
  signature: string;
  identity: string;
  occurrence: number;
  feature: string;
  idempotent: boolean;
  kind: string;
  latency: number;
  /** Arrival at the server (side effects happen then), if it arrived. */
  ta?: number;
  /** Response delivered / rejected at. */
  td?: number;
  status?: number;
  outcome: "pending" | "ok" | "http-error" | "neterr" | "aborted";
  cause: NetCause;
  committed: boolean;
  slowCause?: "spike" | "slow-period" | "overload";
}

function inWin(w: Win, t: number): boolean {
  return t >= w.start && t < w.end;
}
function epMatch(eps: string[] | "*", sig: string): boolean {
  return eps === "*" || eps.includes(sig);
}

export interface PushSub {
  topic: string;
  fn: (msg: unknown) => void;
}

export class Network {
  readonly log: NetEntry[] = [];
  private occ = new Map<string, number>();
  private arrivals: number[] = [];
  private arrivalsBySig = new Map<string, number[]>();
  private subs: PushSub[] = [];
  private pushSeq = 0;
  /** Requests in flight at the network level. */
  inflight = 0;

  constructor(
    private readonly loop: VirtualLoop,
    readonly server: VirtualServer,
    readonly profile: NetProfile,
    private readonly seed: number,
  ) {
    server.now = () => loop.now();
    server.publish = (topic, msg) => this.publish(topic, msg);
  }

  // ------------------------------------------------------------------------------------------- push channel

  subscribe(topic: string, fn: (msg: unknown) => void): () => void {
    const s = { topic, fn };
    this.subs.push(s);
    return () => {
      this.subs = this.subs.filter((x) => x !== s);
    };
  }

  private lastPush = new Map<string, number>();

  /** Server → client message; delivered after push latency (0 in the ideal world), in order per topic. */
  publish(topic: string, msg: unknown): void {
    const n = this.pushSeq++;
    const text = JSON.stringify(msg);
    const now = this.loop.now();
    const d = this.profile.ideal ? 0 : new Rng(hashAll(this.seed, "push", topic, n)).lognormal(this.profile.push.median, this.profile.push.sigma);
    const at = Math.max(now + d, this.lastPush.get(topic) ?? 0);
    this.lastPush.set(topic, at);
    for (const s of this.subs.slice()) {
      if (s.topic !== topic) continue;
      this.loop.at(at, () => {
        if (this.subs.includes(s)) s.fn(JSON.parse(text));
      }, "app");
    }
  }

  /** Entry delivered (resolved/rejected to the app side) in the current macrotask, for failure correlation. */
  lastDelivered: NetEntry | null = null;

  // ------------------------------------------------------------------------------------------------- fetch

  readonly fetch = (input: unknown, init?: RequestInit): Promise<Response> => {
    const req = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : req ? req.url : String(input);
    const method = String(init?.method ?? req?.method ?? "GET").toUpperCase();
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? req?.headers ?? undefined);
    const simOp = headers.get(SIM_OP_HEADER);
    headers.delete(SIM_OP_HEADER);
    const signal = (init?.signal ?? req?.signal ?? null) as AbortSignal | null;
    const bodyInit = init?.body;
    if (bodyInit === undefined && req && method !== "GET" && method !== "HEAD") {
      // Body of a Request object: reading it settles in microtasks (same virtual instant).
      return req
        .clone()
        .text()
        .then((raw) => this.send(href, method, headers, raw, signal, simOp));
    }
    const raw = bodyInit === undefined || bodyInit === null ? "" : typeof bodyInit === "string" ? bodyInit : String(bodyInit);
    return this.send(href, method, headers, raw, signal, simOp);
  };

  /** Called synchronously when a request enters the network (after the runtime let it through). */
  onSend: ((e: NetEntry) => void) | null = null;

  private send(href: string, method: string, headers: Headers, raw: string, signal: AbortSignal | null, simOp: string | null): Promise<Response> {
    const url = new URL(href, BASE_URL);
    const t0 = this.loop.now();
    const identity = `${method} ${url.pathname}${url.search} ${raw}`;
    const occurrence = this.occ.get(identity) ?? 0;
    this.occ.set(identity, occurrence + 1);
    const meta = this.server.meta(method, url.pathname);
    const signature = meta?.signature ?? `${method} ${url.pathname}`;
    const P = this.profile;
    const r = new Rng(hashAll(this.seed, identity, occurrence));
    const kind = meta?.kind ?? "read";
    let latency = 0;
    let slowCause: NetEntry["slowCause"];
    if (!P.ideal) {
      const lat = P.latency[signature] ?? P.byKind[kind];
      latency = r.lognormal(lat.median, lat.sigma);
      for (const s of P.slow) {
        if (inWin(s, t0) && epMatch(s.endpoints, signature)) {
          latency *= s.mul;
          slowCause = "slow-period";
        }
      }
      if (r.next() < P.spikeP) {
        latency *= r.float(P.spikeMul[0], P.spikeMul[1]);
        slowCause = "spike";
      }
      if (P.capacity && P.capacity.mode === "latency") {
        const load = this.recentArrivals(t0, 1000);
        if (load > P.capacity.perSec) {
          latency *= 1 + (load - P.capacity.perSec) / Math.max(1, P.capacity.perSec);
          slowCause = "overload";
        }
      }
      latency = Math.max(1, latency);
      const fixed = P.latencyFn?.(method, url.pathname + url.search, occurrence);
      if (fixed !== undefined) latency = fixed;
    } else {
      r.next();
      r.next();
    }
    const e: NetEntry = {
      id: this.log.length,
      t0,
      method,
      path: url.pathname,
      search: url.search,
      signature,
      identity,
      occurrence,
      feature: meta?.feature ?? "?",
      idempotent: meta?.idempotent ?? method === "GET",
      kind,
      latency,
      outcome: "pending",
      cause: "ok",
      committed: false,
    };
    if (slowCause) e.slowCause = slowCause;
    if (simOp) e.simOp = Number(simOp);
    this.log.push(e);
    this.inflight++;
    if (this.onSend) this.onSend(e);

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      let deliver: unknown = null;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.inflight--;
        e.td = this.loop.now();
        this.lastDelivered = e;
        this.loop.afterTask(() => {
          if (this.lastDelivered === e) this.lastDelivered = null;
        });
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        if (settled) return;
        this.loop.cancel(deliver);
        e.outcome = "aborted";
        if (e.cause === "ok") e.cause = "aborted";
        const reason = signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
        finish(() => reject(reason));
      };
      if (signal) {
        if (signal.aborted) {
          e.outcome = "aborted";
          e.cause = "aborted";
          finish(() => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError")));
          return;
        }
        signal.addEventListener("abort", onAbort);
      }
      const up = latency * 0.35;
      const down = latency * 0.6;
      const proc = latency * 0.05;
      const respond = (res: ServerResponse, at: number, cause: NetCause) => {
        e.status = res.status;
        e.cause = cause;
        e.outcome = res.status >= 400 ? "http-error" : "ok";
        deliver = this.loop.schedule(Math.max(0, at - this.loop.now()), () => {
          finish(() => resolve(makeResponse(res, url.href)));
        }, "net");
      };
      const netError = (at: number, cause: NetCause) => {
        e.cause = cause;
        deliver = this.loop.schedule(Math.max(0, at - this.loop.now()), () => {
          e.outcome = "neterr";
          finish(() => reject(new TypeError("Failed to fetch")));
        }, "net");
      };
      // Arrival at the server.
      this.loop.schedule(up, () => {
        const ta = this.loop.now();
        e.ta = ta;
        this.noteArrival(signature, ta);
        if (P.ideal) {
          const out = this.process(e, method, url, headers, raw, ta);
          e.committed = out.committed;
          respond(out.res, ta, out.res.status === 404 ? "notfound" : "ok");
          return;
        }
        const gw = t0 + P.gatewayMs;
        // Outages.
        const outage = P.outages.find((o) => inWin(o, ta) && epMatch(o.endpoints, signature));
        if (outage) {
          switch (outage.mode) {
            case "neterr":
              return netError(ta + 5 + down * 0.2, "outage");
            case "hang":
              e.cause = "outage";
              return respond({ status: 504, body: { error: "gateway_timeout" } }, gw, "outage");
            case "empty": {
              if (method === "GET") {
                const out = this.process(e, method, url, headers, raw, ta, "empty-list");
                return respond(out.res, ta + proc + down, "outage");
              }
              return respond({ status: 503, body: { error: "unavailable" } }, ta + 3 + down * 0.3, "outage");
            }
            default:
              return respond({ status: Number(outage.mode), body: { error: "unavailable" } }, ta + 3 + down * 0.3, "outage");
          }
        }
        // Capacity / overload.
        if (P.capacity && P.capacity.mode !== "latency") {
          const load = this.recentArrivals(ta, 1000);
          if (load > P.capacity.perSec) {
            const st = P.capacity.mode === "429" ? 429 : 503;
            const h: Record<string, string> = st === 429 ? { "retry-after": "1" } : {};
            return respond({ status: st, body: { error: "overloaded" }, headers: h }, ta + 2 + down * 0.3, "overload");
          }
        }
        // Per-endpoint rate limits.
        const rl = P.rateLimits[signature];
        if (rl) {
          const n = this.recentArrivalsBySig(signature, ta, 1000);
          if (n > rl.perSec) {
            const h: Record<string, string> = rl.retryAfter ? { "retry-after": String(1 + (n % 2)) } : {};
            return respond({ status: 429, body: { error: "rate_limited" }, headers: h }, ta + 2 + down * 0.3, "ratelimit");
          }
        }
        // Random transient failures and network errors.
        if (r.next() < P.transientP) {
          const post = method !== "GET" && r.next() < P.postCommitP;
          if (post) {
            const out = this.process(e, method, url, headers, raw, ta);
            e.committed = out.committed;
          }
          const st = post ? 500 : r.pick([500, 502, 503]);
          return respond({ status: st, body: { error: "server_error" } }, ta + proc + down, "transient");
        }
        if (r.next() < P.netErrP) {
          if (r.bool(0.5)) {
            const out = this.process(e, method, url, headers, raw, ta);
            e.committed = out.committed;
          }
          return netError(ta + proc + down * r.next(), "neterr");
        }
        // Normal processing (with possible bugs / replica lag).
        const bug = P.bugs.find((b) => inWin(b, ta) && b.endpoint === signature);
        const out = this.process(e, method, url, headers, raw, ta, bug?.kind, bug?.field);
        e.committed = out.committed;
        const tResp = ta + proc + down;
        if (tResp > gw) {
          return respond({ status: 504, body: { error: "gateway_timeout" } }, gw, "gateway-timeout");
        }
        const cause: NetCause = out.lagged ? "replica-lag" : bug ? "bug" : slowCause ?? (out.res.status === 404 ? "notfound" : "ok");
        respond(out.res, tResp, cause);
      }, "net");
    });
  }

  private process(
    e: NetEntry,
    method: string,
    url: URL,
    headers: Headers,
    raw: string,
    t: number,
    bug?: string,
    field?: string,
  ): { res: ServerResponse; committed: boolean; lagged: boolean } {
    let body: unknown = undefined;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const hm = new Map<string, string>();
    headers.forEach((v, k) => hm.set(k.toLowerCase(), v));
    const P = this.profile;
    let lagged = false;
    // Replica lag: a read soon after a write to the same resource may observe the pre-write state.
    let restore: (() => void) | null = null;
    const meta = this.server.meta(method, url.pathname);
    const lagMs = bug === "stale-replica" ? 2500 : P.replicaLag && new Rng(hashAll(this.seed, "lag", e.identity, e.occurrence)).next() < P.replicaLag.p ? P.replicaLag.ms : 0;
    if (!P.ideal && method === "GET" && meta?.resource && lagMs > 0) {
      restore = this.applyLag(meta.resource, t, lagMs);
      lagged = restore !== null;
    }
    const { res } = this.server.handle({ method, path: url.pathname, query: url.searchParams, headers: hm, body, rawBody: raw, t, identity: e.identity });
    if (restore) restore();
    const last = this.server.log[this.server.log.length - 1];
    const committed = !!last && last.committed && method !== "GET";
    if (bug && res.status < 400) mutateForBug(res, bug, field);
    return { res, committed, lagged };
  }

  /** Temporarily swap a resource to its lagged value; returns a restore function (or null if not lagging). */
  private applyLag(resource: string, t: number, lagMs: number): (() => void) | null {
    const db = this.server.db;
    const old = db.laggedKey(resource, t, lagMs);
    if (old === undefined) return null;
    const kind = resource.slice(0, 1);
    const name = resource.slice(2);
    if (kind === "c") {
      const c = db.collection(name);
      const saveItems = c.items;
      const saveOrder = c.order;
      const items = JSON.parse(old) as Record<string, unknown>[];
      c.items = new Map(items.map((it) => [String(it.id), it as never]));
      c.order = items.map((it) => String(it.id));
      return () => {
        c.items = saveItems;
        c.order = saveOrder;
      };
    }
    if (kind === "d") {
      const prev = db.docs.get(name);
      const lagged = JSON.parse(old);
      if (!lagged) return null;
      db.docs.set(name, lagged);
      return () => {
        if (prev) db.docs.set(name, prev);
      };
    }
    const prevN = db.counters.get(name);
    db.counters.set(name, JSON.parse(old) as number);
    return () => {
      if (prevN !== undefined) db.counters.set(name, prevN);
    };
  }

  private noteArrival(sig: string, t: number): void {
    this.arrivals.push(t);
    if (this.arrivals.length > 512) this.arrivals.splice(0, 256);
    let a = this.arrivalsBySig.get(sig);
    if (!a) {
      a = [];
      this.arrivalsBySig.set(sig, a);
    }
    a.push(t);
    if (a.length > 256) a.splice(0, 128);
  }

  private recentArrivals(t: number, win: number): number {
    let n = 0;
    for (let i = this.arrivals.length - 1; i >= 0 && this.arrivals[i]! > t - win; i--) n++;
    return n;
  }

  private recentArrivalsBySig(sig: string, t: number, win: number): number {
    const a = this.arrivalsBySig.get(sig);
    if (!a) return 0;
    let n = 0;
    for (let i = a.length - 1; i >= 0 && a[i]! > t - win; i--) n++;
    return n;
  }

  /** Requests (count) per signature that reached the server. */
  serverCounts(): Map<string, number> {
    const m = new Map<string, number>();
    for (const e of this.log) if (e.ta !== undefined) m.set(e.signature, (m.get(e.signature) ?? 0) + 1);
    return m;
  }

  /** Has a request with this identity been committed by the server before time t? */
  committedBefore(identity: string, t: number): boolean {
    return this.log.some((e) => e.identity === identity && e.committed && (e.ta ?? Infinity) <= t);
  }
}

function mutateForBug(res: ServerResponse, bug: string, field?: string): void {
  const b = res.body;
  const eachItem = (fn: (it: Record<string, unknown>) => void) => {
    const visit = (v: unknown, depth: number): void => {
      if (depth > 3 || v === null || typeof v !== "object") return;
      if (Array.isArray(v)) {
        for (const x of v) if (x && typeof x === "object" && !Array.isArray(x)) fn(x as Record<string, unknown>);
        return;
      }
      for (const x of Object.values(v as object)) visit(x, depth + 1);
    };
    visit(b, 0);
    if (b && typeof b === "object" && !Array.isArray(b) && field && field in (b as object)) fn(b as Record<string, unknown>);
  };
  switch (bug) {
    case "drop-field":
      eachItem((it) => {
        if (field) delete it[field];
      });
      break;
    case "null-field":
      eachItem((it) => {
        if (field) it[field] = null;
      });
      break;
    case "empty-list": {
      const empty = (v: unknown, depth: number): unknown => {
        if (Array.isArray(v)) return [];
        if (v && typeof v === "object" && depth < 2) {
          const o: Record<string, unknown> = {};
          for (const [k, x] of Object.entries(v)) o[k] = typeof x === "number" && /count|total/i.test(k) ? 0 : empty(x, depth + 1);
          return o;
        }
        return v;
      };
      res.body = empty(b, 0);
      break;
    }
    case "html":
      res.body = undefined;
      res.headers = { ...(res.headers ?? {}), "content-type": "text/html" };
      (res as ServerResponse & { html?: string }).html = "<!doctype html><title>502 Bad Gateway</title>";
      break;
  }
}

export function makeResponse(res: ServerResponse, href: string): Response {
  const headers: Record<string, string> = { "content-type": "application/json", ...(res.headers ?? {}) };
  const html = (res as ServerResponse & { html?: string }).html;
  const noBody = res.status === 204 || res.status === 304;
  const text = noBody ? null : html !== undefined ? html : res.body === undefined ? "" : JSON.stringify(res.body);
  const r = new Response(text, { status: res.status, headers });
  try {
    Object.defineProperty(r, "url", { value: href });
  } catch {
    /* ignore */
  }
  return r;
}

export { canonical };
