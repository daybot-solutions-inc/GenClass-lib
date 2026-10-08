// In-page network: fetch, XMLHttpRequest and WebSocket backed by the mock server, on virtual time. Every random
// draw for a request is keyed by (seed, future salt, request identity, occurrence of that identity), so forcing an
// action at one decision does not shift the latencies or failures of unrelated requests. A request reaches the
// server at t0 + 0.45·L and answers at t0 + L. The ideal network has zero latency and no chaos, and answers an
// identical non-idempotent request repeated within 1 s with no user step in between from the first one's result
// (exactly-once).

import type { NetProfile, NetRec } from "../shared/types.js";
import type { VirtualLoop } from "./loop.js";
import { hashAll, type MockServer, type Publish, type SReq } from "./server.js";

const u01 = (...k: (string | number | undefined)[]) => hashAll(...k) / 4294967296;
function normal(...k: (string | number | undefined)[]): number {
  const u = Math.max(1e-9, u01(...k, "n1"));
  const v = u01(...k, "n2");
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type Outcome =
  | { kind: "response"; status: number; statusText: string; headers: Record<string, string>; body: string | null }
  | { kind: "neterr"; message: string }
  | { kind: "aborted"; timeout?: boolean };

const STATUS_TEXT: Record<number, string> = { 200: "OK", 201: "Created", 204: "No Content", 207: "Multi-Status", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 408: "Request Timeout", 409: "Conflict", 422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };

export interface Pending {
  rec: NetRec;
  abort(timeout?: boolean): void;
}

export interface SendCtx {
  init?: object;
  xhr?: object;
}

export class Network {
  log: NetRec[] = [];
  /** Future salt (set when the counterfactual decision is answered). */
  salt: number | undefined;
  private occ = new Map<string, number>();
  private arrivals: { t: number; sig: string }[] = [];
  private recent = new Map<string, { t: number; out: Outcome; id: number }>();
  /** Time of the latest user step (ideal exactly-once rule). */
  lastStepT = -1;
  wsDownUntil = -1;
  sockets = new Set<VWebSocketLike>();
  private pubSeq = 0;
  private sockSeq = 0;
  onSend: ((rec: NetRec, ctx: SendCtx) => void) | null = null;
  onSettle: ((rec: NetRec) => void) | null = null;
  /** Called right before a WebSocket message is dispatched (probe correlation). */
  onWsMessage: ((m: { topic: string; msg: Record<string, unknown>; t: number } | null) => void) | null = null;

  constructor(
    readonly loop: VirtualLoop,
    readonly server: MockServer,
    readonly P: NetProfile,
    readonly seed: number,
    readonly ideal: boolean,
    readonly origin: string,
  ) {
    server.onPublish = (p) => this.publish(p);
  }

  private key(identity: string, n: number, label: string): number {
    return u01(this.seed, this.salt ?? 0, identity, n, label);
  }

  inflight(): number {
    let n = 0;
    for (let i = this.log.length - 1; i >= 0 && i >= this.log.length - 200; i--) if (this.log[i]!.td === undefined && this.log[i]!.outcome === "pending") n++;
    return n;
  }

  /** Start a request. `deliver` receives the outcome exactly once (unless aborted first, then with "aborted"). */
  start(method: string, rawUrl: string, headers: Record<string, string>, raw: string, transport: "fetch" | "xhr", ctx: SendCtx, deliver: (o: Outcome) => void): Pending {
    const loop = this.loop;
    const t0 = loop.now;
    let url: URL;
    try {
      url = new URL(rawUrl, this.origin + "/");
    } catch {
      url = new URL(this.origin + "/");
    }
    method = method.toUpperCase();
    let path = url.pathname;
    let m = this.server.match(method, path);
    if (!m) {
      // APIs mounted under another prefix (e.g. https://host/v2/api/...): match from the API base on
      const i = path.indexOf(this.server.B + "/");
      if (i > 0) {
        const p2 = path.slice(i);
        const m2 = this.server.match(method, p2);
        if (m2) {
          m = m2;
          path = p2;
        }
      }
    }
    const sig = m ? m.ep.sig : `${method} ${path}`;
    const kind = m ? m.ep.kind : "read";
    const idempotent = m ? m.ep.idempotent : method === "GET";
    const identity = `${method} ${url.pathname}${url.search} ${raw}`;
    const n = (this.occ.get(identity) ?? 0) + 1;
    this.occ.set(identity, n);
    const rec: NetRec = { id: this.log.length, method, url: url.pathname + url.search, sig, t0, outcome: "pending", idempotent, transport, bodyKey: raw.length <= 200 ? raw : `${raw.length}b:${hashAll(raw)}` };
    if (Object.keys(headers).some((k) => k.toLowerCase() === "idempotency-key")) rec.idem = true;
    this.log.push(rec);
    this.onSend?.(rec, ctx);
    let done = false;
    const tasks: { cancelled: boolean }[] = [];
    const finish = (o: Outcome) => {
      if (done) return;
      done = true;
      rec.td = loop.now;
      if (o.kind === "response") {
        rec.status = o.status;
        if (rec.outcome === "pending") rec.outcome = o.status >= 400 ? "http-error" : "ok";
      } else if (o.kind === "neterr") rec.outcome = "neterr";
      else rec.outcome = o.timeout ? "timeout" : "aborted";
      this.onSettle?.(rec);
      deliver(o);
    };
    const pending: Pending = {
      rec,
      abort: (timeout?: boolean) => {
        if (done) return;
        for (const t of tasks) t.cancelled = true;
        finish({ kind: "aborted", ...(timeout ? { timeout: true } : {}) });
      },
    };
    let headersLc: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) headersLc[k.toLowerCase()] = v;
    let parsed: unknown = undefined;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = Object.fromEntries(new URLSearchParams(raw));
      }
    }
    const sreq: SReq = { method, path, query: url.searchParams, headers: headersLc, body: parsed, raw };
    const respond = (status: number, body: unknown, hdrs: Record<string, string> = {}, html = false): Outcome => ({
      kind: "response",
      status,
      statusText: STATUS_TEXT[status] ?? "",
      headers: { "content-type": html ? "text/html" : "application/json", ...hdrs },
      body: status === 204 || body === null ? (status === 204 ? null : "null") : html ? String(body) : JSON.stringify(body),
    });

    // ------------------------------------------------------------------------------------------ ideal
    if (this.ideal) {
      const prev = !idempotent ? this.recent.get(identity) : undefined;
      if (prev && t0 - prev.t <= 1000 && this.lastStepT <= prev.t) {
        rec.dedupedOf = prev.id;
        tasks.push(loop.schedule(0, () => finish(prev.out), "net"));
        return pending;
      }
      tasks.push(
        loop.schedule(0, () => {
          rec.ta = loop.now;
          this.server.bulkFail = null;
          const res = this.server.handle(sreq, Infinity);
          rec.committed = res.wrote;
          const out = respond(res.status, res.body, res.headers);
          if (!idempotent) this.recent.set(identity, { t: t0, out, id: rec.id });
          finish(out);
        }, "net"),
      );
      return pending;
    }

    // ------------------------------------------------------------------------------------------ chaos
    const P = this.P;
    const lat = P.latency[sig] ?? P.byKind[kind] ?? P.byKind.read;
    let L = lat.median * Math.exp(lat.sigma * normal(this.seed, this.salt ?? 0, identity, n, "lat"));
    if (this.key(identity, n, "spike") < P.spikeP) {
      L *= P.spikeMul[0] + this.key(identity, n, "spikemul") * (P.spikeMul[1] - P.spikeMul[0]);
      rec.slowCause = "spike";
    }
    const matches = (eps: string[] | "*") => eps === "*" || eps.includes(sig);
    for (const s of P.slow)
      if (t0 >= s.start && t0 < s.end && matches(s.endpoints)) {
        L *= s.mul;
        rec.slowCause = "slow-period";
      }
    const recentArrivals = (since: number, onlySig?: string) => {
      let c = 0;
      for (let i = this.arrivals.length - 1; i >= 0; i--) {
        const a = this.arrivals[i]!;
        if (a.t <= since) break;
        if (!onlySig || a.sig === onlySig) c++;
      }
      return c;
    };
    if (P.capacity && P.capacity.mode === "latency" && recentArrivals(t0 - 1000) >= P.capacity.perSec) {
      L *= 4;
      rec.slowCause = "overload";
    }
    L = Math.min(60000, Math.max(3, L));
    const tArr = t0 + 0.45 * L;
    tasks.push(
      loop.at(tArr, () => {
        const ta = loop.now;
        rec.ta = ta;
        this.arrivals.push({ t: ta, sig });
        if (this.arrivals.length > 4000) this.arrivals.splice(0, 2000);
        const tDel = t0 + L;
        const later = (o: Outcome, at = tDel) => tasks.push(loop.at(at, () => finish(o), "net"));
        // outages
        const o = P.outages.find((x) => ta >= x.start && ta < x.end && matches(x.endpoints));
        if (o && !(o.mode === "empty" && method === "GET")) {
          rec.cause = "outage";
          if (o.mode === "hang") {
            rec.outcome = "hang";
            later(respond(504, { error: "gateway timeout" }), ta + P.gatewayMs);
          } else if (o.mode === "neterr" || o.mode === "empty") later({ kind: "neterr", message: "Failed to fetch" }, ta + 5);
          else later(respond(Number(o.mode), { error: "service unavailable" }));
          return;
        }
        // rate limits and capacity
        const rl = P.rateLimits[sig];
        if (rl && recentArrivals(ta - 1000, sig) > rl.perSec) {
          rec.cause = "ratelimit";
          later(respond(429, { error: "rate limited" }, rl.retryAfter ? { "retry-after": "1" } : {}));
          return;
        }
        if (P.capacity && P.capacity.mode !== "latency" && recentArrivals(ta - 1000) > P.capacity.perSec) {
          rec.cause = "overload";
          later(respond(Number(P.capacity.mode), { error: "over capacity" }, P.capacity.mode === "429" ? { "retry-after": "1" } : {}));
          return;
        }
        const write = method !== "GET" && method !== "HEAD";
        const handle = (asOf: number) => {
          if (kind === "bulk") {
            const ids = Array.isArray((parsed as { ids?: unknown[] })?.ids) ? ((parsed as { ids: unknown[] }).ids.map(String)) : [];
            const failP = Math.max(P.transientP * 2, 0.04);
            this.server.bulkFail = new Set(ids.filter((id) => this.key(identity, n, `bulk:${id}`) < failP));
          } else this.server.bulkFail = null;
          const r = this.server.handle(sreq, asOf);
          this.server.bulkFail = null;
          rec.committed = r.wrote;
          return r;
        };
        // transient 5xx / network errors (some after the write committed)
        if (this.key(identity, n, "transient") < P.transientP) {
          rec.cause = "transient";
          if (write && this.key(identity, n, "postcommit") < P.postCommitP) handle(Infinity);
          later(respond([500, 502, 503][Math.floor(this.key(identity, n, "code") * 3)]!, { error: "internal error" }));
          return;
        }
        if (this.key(identity, n, "neterr") < P.netErrP) {
          rec.cause = "transient";
          if (write && this.key(identity, n, "postcommit") < 0.5) handle(Infinity);
          later({ kind: "neterr", message: "Failed to fetch" });
          return;
        }
        // replica lag
        let asOf = Infinity;
        if (!write && P.replicaLag && this.key(identity, n, "lag") < P.replicaLag.p) {
          asOf = ta - P.replicaLag.ms;
          rec.cause = "replica-lag";
        }
        const res = handle(asOf);
        let body = res.body;
        let html = false;
        if (o && o.mode === "empty" && res.list) {
          rec.cause = "outage";
          body = emptyLists(body);
        }
        const bug = P.bugs.find((b) => b.endpoint === sig && ta >= b.start && ta < b.end);
        if (bug && method === "GET" && res.status < 300) {
          rec.cause = "bug";
          if (bug.kind === "html") {
            html = true;
            body = "<!doctype html><html><body><h1>Service temporarily unavailable</h1></body></html>";
          } else body = applyBug(body, bug.kind, bug.field);
        }
        later(respond(res.status, body, res.headers ?? {}, html));
      }, "net"),
    );
    return pending;
  }

  // ------------------------------------------------------------------------------------------ websockets
  publish(p: Publish): void {
    const seq = this.pubSeq++;
    for (const s of this.sockets) {
      if (s.readyState !== 1 || !s.wants(p.topic)) continue;
      const d = this.ideal ? 0 : Math.max(1, this.P.push.median * Math.exp(this.P.push.sigma * normal(this.seed, this.salt ?? 0, "push", p.topic, seq, s.sid)));
      const at = Math.max(this.loop.now + d, s.lastDelivery);
      s.lastDelivery = at;
      this.loop.at(at, () => {
        if (s.readyState !== 1) return;
        this.onWsMessage?.({ topic: p.topic, msg: p.msg, t: this.loop.now });
        try {
          s.receive(JSON.stringify(p.msg));
        } finally {
          this.onWsMessage?.(null);
        }
      }, "ws");
    }
  }

  nextSocketId(): number {
    return this.sockSeq++;
  }

  dropSockets(downMs: number): void {
    this.wsDownUntil = this.loop.now + downMs;
    for (const s of [...this.sockets]) s.drop();
  }
}

function emptyLists(b: unknown): unknown {
  if (Array.isArray(b)) return [];
  if (b && typeof b === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b as object)) o[k] = Array.isArray(v) ? [] : k === "total" || k === "count" || k.endsWith("Count") ? 0 : v;
    return o;
  }
  return b;
}

function applyBug(b: unknown, kind: string, field: string): unknown {
  if (kind === "empty-list") return emptyLists(b);
  const fix = (x: unknown): unknown => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return x;
    const o = { ...(x as Record<string, unknown>) };
    const keys = Object.keys(o);
    const f = keys.includes(field) ? field : keys.find((k) => k !== "id" && typeof o[k] !== "object") ?? field;
    if (kind === "drop-field") delete o[f];
    else o[f] = null;
    return o;
  };
  if (Array.isArray(b)) return b.map(fix);
  if (b && typeof b === "object") {
    const o = { ...(b as Record<string, unknown>) };
    let touched = false;
    for (const [k, v] of Object.entries(o))
      if (Array.isArray(v)) {
        o[k] = v.map(fix);
        touched = true;
      }
    return touched ? o : fix(o);
  }
  return b;
}

export interface VWebSocketLike {
  readyState: number;
  sid: number;
  lastDelivery: number;
  wants(topic: string): boolean;
  receive(data: string): void;
  drop(): void;
}

// ------------------------------------------------------------------------------------------- MockResponse

export function makeResponseClass(R: typeof Response): typeof Response {
  class MockResponse extends R {
    #raw: BodyInit | null;
    #init: ResponseInit;
    #url: string;
    constructor(body?: BodyInit | null, init?: ResponseInit, url = "") {
      super(body ?? null, init);
      this.#raw = body ?? null;
      this.#init = init ?? {};
      this.#url = url;
    }
    override get url(): string {
      return this.#url;
    }
    override clone(): Response {
      if (this.bodyUsed) throw new TypeError("Failed to execute 'clone' on 'Response': Response body is already used");
      const raw = this.#raw;
      // strings / buffers can be shared without tee-ing a stream (keeps body reads in microtasks)
      if (raw === null || typeof raw === "string" || raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
        const copy = raw instanceof ArrayBuffer ? raw.slice(0) : ArrayBuffer.isView(raw) ? (raw as Uint8Array).slice() : raw;
        const h = new Headers(this.headers);
        return new MockResponse(copy, { status: this.status, statusText: this.statusText, headers: h }, this.#url);
      }
      return super.clone();
    }
  }
  return MockResponse as unknown as typeof Response;
}
