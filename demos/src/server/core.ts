// Mock server core: one "world" per page session (the interactive page and every trial iframe get their own),
// a tiny router, the chaos/latency model and live event streams. Runs inside the Service Worker.
import { Rng, hashString } from "../shared/rng.ts";
import { CALM, mergeChaos, resolveChaos, sampleEventDelay, sampleTiming, type Chaos } from "../shared/chaos.ts";
import type { DemoId, EventEntry, LogEntry } from "../shared/protocol.ts";

export const now = (): number => performance.timeOrigin + performance.now();
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const enc = new TextEncoder();

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  raw: string;
  headers: Headers;
  params: string[];
  entry: LogEntry;
}

export interface Res {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  /** Extra server time in ms (scaled by slowdowns). */
  work?: number;
  /** Short description of the side effect, recorded in the log. */
  effect?: string;
}

export interface Route<S> {
  method: string;
  pattern: RegExp;
  /** Route key for chaos rules and logs, e.g. "status/payments". */
  key: (m: RegExpMatchArray) => string;
  handle?: (w: World<S>, req: Req) => Res;
  /** Live stream route (server-sent events). */
  stream?: boolean;
}

export interface WorldDef<S> {
  demo: DemoId;
  create(rng: Rng, params: Record<string, unknown>): S;
  routes: Route<S>[];
  snapshot(w: World<S>): unknown;
  start?(w: World<S>): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action?(w: World<S>, name: string, args: any): unknown;
}

interface Stream {
  id: number;
  clientId: string;
  ctl: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

export function json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  if (status === 204) return new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export class World<S = unknown> {
  readonly created = now();
  /**
   * Randomness for route handlers. During a request this is that request's own generator (see rngFor), so
   * handlers draw from it too; outside requests it is the world's base generator.
   */
  rng: Rng;
  private readonly baseRng: Rng;
  /** Occurrence counters for common random numbers (see rngFor). */
  private occurrences = new Map<string, number>();
  /** Separate stream for world scripts (teammates, incidents) so request timing does not shift them. */
  readonly scriptRng: Rng;
  state: S;
  chaos: Chaos;
  readonly log: LogEntry[] = [];
  readonly events: EventEntry[] = [];
  private streams = new Set<Stream>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private streamSeq = 0;
  inflight = 0;
  pendingDeliveries = 0;
  lastActivity = now();
  private reqSeq = 0;
  private eventSeq = 0;
  disposed = false;
  /** Scripted activity (teammates, incidents) stops when the session ends; deliveries continue. */
  frozen = false;

  constructor(
    readonly def: WorldDef<S>,
    readonly sid: string,
    readonly seed: number,
    readonly params: Record<string, unknown>,
    chaos: Partial<Chaos> | undefined,
  ) {
    this.baseRng = new Rng(seed ^ 0x5eed);
    this.rng = this.baseRng;
    this.scriptRng = new Rng(seed ^ 0xc0ffee);
    this.chaos = mergeChaos({ ...CALM, routes: {} }, chaos);
    this.state = def.create(new Rng(seed), params);
  }

  get demo(): DemoId {
    return this.def.demo;
  }

  start(): void {
    this.def.start?.(this);
  }

  setChaos(patch: Partial<Chaos>, replace = false): void {
    this.chaos = replace ? mergeChaos({ ...CALM, routes: {} }, patch) : mergeChaos(this.chaos, patch);
  }

  /**
   * Common random numbers: the n-th occurrence of the same logical request (or live event) gets the same draws in
   * every run of a seed, whatever else happened before it. So when GenClass shifts timing (holding a write or a
   * request), the network's behaviour for each request stays the same and paired comparisons measure GenClass,
   * not a re-rolled network.
   */
  rngFor(key: string): Rng {
    const n = (this.occurrences.get(key) ?? 0) + 1;
    this.occurrences.set(key, n);
    return new Rng(hashString(`${this.seed}|${key}|${n}`));
  }

  /** Timers owned by the world (cleared on dispose). */
  after(ms: number, fn: () => void): void {
    const h = setTimeout(() => {
      this.timers.delete(h);
      if (!this.disposed) fn();
    }, Math.max(0, ms));
    this.timers.add(h);
  }

  every(ms: number, fn: () => void): void {
    const tick = () => {
      fn();
      this.after(ms, tick);
    };
    this.after(ms, tick);
  }

  /** Timer for scripted world activity: does nothing once the session is frozen. */
  script(ms: number, fn: () => void): void {
    this.after(ms, () => {
      if (!this.frozen) fn();
    });
  }

  /**
   * Publish a live event to every open stream, each delivery delayed independently (may reorder). `key` identifies
   * the logical event for common random numbers (default: its type and data).
   */
  publish(type: string, data: Record<string, unknown>, key?: string): EventEntry {
    const entry: EventEntry = { seq: ++this.eventSeq, type, t: now(), data, deliveredAt: [] };
    this.events.push(entry);
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
    const c = resolveChaos(this.chaos, `${this.def.demo}/events`);
    const payload = enc.encode(`id: ${entry.seq}\ndata: ${JSON.stringify({ seq: entry.seq, type, ...data })}\n\n`);
    const erng = this.rngFor(`event ${type} ${key ?? JSON.stringify(data)}`);
    for (const s of this.streams) {
      if (s.closed) continue;
      this.pendingDeliveries++;
      this.after(sampleEventDelay(erng, c), () => {
        this.pendingDeliveries--;
        if (s.closed) return;
        try {
          s.ctl.enqueue(payload);
          entry.deliveredAt.push(now());
        } catch {
          s.closed = true;
        }
      });
    }
    return entry;
  }

  openStream(clientId: string): Response {
    let stream!: Stream;
    const body = new ReadableStream<Uint8Array>({
      start: (ctl) => {
        stream = { id: ++this.streamSeq, clientId, ctl, closed: false };
        this.streams.add(stream);
        ctl.enqueue(enc.encode(`retry: 1000\n: connected ${stream.id}\n\n`));
      },
      cancel: () => {
        stream.closed = true;
        this.streams.delete(stream);
      },
    });
    const ka = () => {
      if (stream.closed || this.disposed) return;
      try {
        stream.ctl.enqueue(enc.encode(`: keep-alive\n\n`));
      } catch {
        stream.closed = true;
        return;
      }
      this.after(15000, ka);
    };
    this.after(15000, ka);
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  }

  get openStreams(): number {
    let n = 0;
    for (const s of this.streams) if (!s.closed) n++;
    return n;
  }

  dispose(): void {
    this.disposed = true;
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
    for (const s of this.streams) {
      s.closed = true;
      try {
        s.ctl.close();
      } catch {
        /* already closed */
      }
    }
    this.streams.clear();
  }

  private match(method: string, path: string): { route: Route<S>; m: RegExpMatchArray } | null {
    for (const route of this.def.routes) {
      if (route.method !== method) continue;
      const m = path.match(route.pattern);
      if (m) return { route, m };
    }
    return null;
  }

  async handle(request: Request, url: URL, path: string, clientId: string): Promise<Response> {
    const method = request.method.toUpperCase();
    const found = this.match(method, path);
    const entry: LogEntry = {
      id: ++this.reqSeq,
      method,
      path,
      query: url.search,
      route: found ? found.route.key(found.m) : "unknown",
      t0: now(),
      outcome: "pending",
    };
    this.log.push(entry);
    if (this.log.length > 6000) this.log.splice(0, this.log.length - 6000);
    this.lastActivity = entry.t0;

    if (!found) {
      entry.status = 404;
      entry.outcome = "client-error";
      entry.tEnd = now();
      return json(404, { error: `No route for ${method} ${path}` });
    }
    const c = resolveChaos(this.chaos, entry.route);

    if (found.route.stream) {
      if (c.offline) {
        entry.outcome = "network";
        entry.tEnd = now();
        return Response.error();
      }
      if (c.outage) {
        entry.status = 503;
        entry.outcome = "rejected";
        entry.tEnd = now();
        return json(503, { error: "Service unavailable" });
      }
      entry.status = 200;
      entry.outcome = "ok";
      entry.tEnd = now();
      return this.openStream(clientId);
    }

    const raw = method === "GET" || method === "HEAD" ? "" : await request.text();
    if (raw) entry.body = raw.length > 400 ? raw.slice(0, 400) + "…" : raw;
    let body: unknown = undefined;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    try {
      request.signal?.addEventListener("abort", () => {
        entry.aborted = true;
      });
    } catch {
      /* signal not supported */
    }

    // Every random draw for this request, made up front from its own generator (common random numbers).
    const rrng = this.rngFor(`${method} ${path}${url.search} ${raw}`);
    const t = sampleTiming(rrng, c);
    const draw = {
      fail: rrng.float(),
      failCode: rrng.pick([500, 502, 503]),
      commitFail: rrng.float(),
      commitCode: rrng.pick([502, 504]),
      hang: rrng.float(),
      handlerSeed: Math.floor(rrng.float() * 4294967296),
    };
    this.inflight++;
    try {
      entry.spike = t.spike;
      if (c.offline) {
        await sleep(Math.min(t.up, 150));
        entry.outcome = "network";
        entry.tEnd = now();
        return Response.error();
      }
      await sleep(t.up);
      if (this.disposed) return Response.error();
      if (c.outage) {
        await sleep(t.down);
        entry.status = 503;
        entry.outcome = "rejected";
        entry.tEnd = now();
        return json(503, { error: "Service unavailable" });
      }
      if (c.failRate > 0 && draw.fail < c.failRate) {
        const code = draw.failCode;
        await sleep(t.down);
        entry.status = code;
        entry.outcome = "rejected";
        entry.tEnd = now();
        return json(code, { error: code === 500 ? "Internal server error" : code === 502 ? "Bad gateway" : "Service unavailable" });
      }

      let res: Res;
      this.rng = new Rng(draw.handlerSeed);
      try {
        res = found.route.handle!(this, {
          method,
          path,
          query: url.searchParams,
          body,
          raw,
          headers: request.headers,
          params: found.m.slice(1),
          entry,
        });
      } catch (e) {
        res = { status: 500, json: { error: String(e) } };
      } finally {
        this.rng = this.baseRng;
      }
      entry.tHandled = now();
      entry.effect = res.effect;
      let down = t.down + (res.work ?? 0) * (t.spike ? Math.max(1, c.spikeFactor) : 1);

      if (res.status < 400 && c.commitFailRate > 0 && draw.commitFail < c.commitFailRate) {
        const code = draw.commitCode;
        await sleep(code === 504 ? Math.max(down, c.hangMs * 0.5) : down);
        entry.status = code;
        entry.outcome = "lost";
        entry.tEnd = now();
        return json(code, { error: code === 504 ? "Gateway timeout" : "Bad gateway" });
      }
      if (c.timeoutRate > 0 && draw.hang < c.timeoutRate) down += c.hangMs;
      await sleep(down);
      entry.status = res.status;
      entry.outcome = res.status < 400 ? "ok" : "client-error";
      entry.tEnd = now();
      return json(res.status, res.json ?? null, res.headers);
    } finally {
      this.inflight--;
      this.lastActivity = now();
    }
  }

  /** Resolve when no request is in flight (and no live event is waiting for delivery) for idleMs. */
  async quiet(idleMs: number, timeoutMs: number, ignoreStreams = false): Promise<{ quiet: boolean; waited: number }> {
    const t0 = now();
    for (;;) {
      const busy = this.inflight > 0 || (!ignoreStreams && this.pendingDeliveries > 0);
      if (!busy && now() - this.lastActivity >= idleMs) return { quiet: true, waited: now() - t0 };
      if (now() - t0 > timeoutMs) return { quiet: false, waited: now() - t0 };
      await sleep(20);
    }
  }
}
