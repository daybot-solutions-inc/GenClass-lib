// Decider queue (CONTRACT §8): one evaluation at a time, highest priority first (held writes/requests), a small
// cache of identical requests, deadlines (a request whose deadline passed while queued is dropped, never
// computed; the time left is passed to the provider as `timeoutMs`), latency samples for the automatic hold
// budget, and fail-open on any provider error (not ready, too many tokens, timeout, busy, ...).

import type { Answer, Clock, DecisionProvider, EvaluateRequest } from "../types.js";
import { fnv1a, stableStringify } from "../util.js";

export interface DecideResult {
  answers: Record<string, Answer>;
  /** Provider time (dispatch to answer), 0 for cache hits. */
  latencyMs: number;
  /** Time spent waiting in this queue. */
  waitMs: number;
  cached: boolean;
}

interface QueueItem {
  req: EvaluateRequest;
  /** Absolute clock time after which the answer is useless. */
  deadline?: number;
  resolve: (r: DecideResult | null) => void;
  seq: number;
  t0: number;
}

const CACHE_MAX = 64;
const CACHE_TTL = 30_000;
const MAX_QUEUE = 32;
const LATENCY_SAMPLES = 20;
/** A provider that has not answered after this long (or the request's deadline) is abandoned: the slot frees up. */
export const PROVIDER_TIMEOUT_MS = 10_000;

export class DeciderQueue {
  private q: QueueItem[] = [];
  private busy = false;
  private seq = 0;
  private cache = new Map<string, { t: number; answers: Record<string, Answer> }>();
  private lat: number[] = [];
  disposed = false;

  constructor(
    private readonly clock: Clock,
    private readonly provider: () => DecisionProvider | null,
    private readonly onError?: (e: unknown) => void,
  ) {}

  get length(): number {
    return this.q.length;
  }

  /** Provider latencies of the last 20 computed evaluations (oldest first). */
  latencies(): number[] {
    return [...this.lat];
  }

  submit(req: EvaluateRequest, deadline?: number): Promise<DecideResult | null> {
    return new Promise((resolve) => {
      const item: QueueItem = { req, resolve, seq: ++this.seq, t0: this.clock.now() };
      if (deadline !== undefined) item.deadline = deadline;
      this.q.push(item);
      if (this.q.length > MAX_QUEUE) {
        // drop the lowest-priority, oldest item
        let worst = 0;
        for (let i = 1; i < this.q.length; i++) {
          const a = this.q[i];
          const b = this.q[worst];
          if ((a.req.priority ?? 0) < (b.req.priority ?? 0) || ((a.req.priority ?? 0) === (b.req.priority ?? 0) && a.seq < b.seq)) worst = i;
        }
        const [dropped] = this.q.splice(worst, 1);
        dropped.resolve(null);
      }
      this.pump();
    });
  }

  private next(): QueueItem | undefined {
    if (!this.q.length) return undefined;
    let best = 0;
    for (let i = 1; i < this.q.length; i++) {
      const a = this.q[i];
      const b = this.q[best];
      if ((a.req.priority ?? 0) > (b.req.priority ?? 0) || ((a.req.priority ?? 0) === (b.req.priority ?? 0) && a.seq < b.seq)) best = i;
    }
    return this.q.splice(best, 1)[0];
  }

  private pump(): void {
    while (!this.busy && !this.disposed) {
      const item = this.next();
      if (!item) return;
      const now = this.clock.now();
      if (item.deadline !== undefined && now >= item.deadline) {
        item.resolve(null);
        continue;
      }
      const p = this.provider();
      if (!p || p.status.state !== "ready") {
        item.resolve(null);
        continue;
      }
      const key = fnv1a(item.req.trigger + "\u0000" + stableStringify(item.req.state) + "\u0000" + stableStringify(item.req.questions));
      const hit = this.cache.get(key);
      if (hit && now - hit.t <= CACHE_TTL) {
        item.resolve({ answers: hit.answers, latencyMs: 0, waitMs: now - item.t0, cached: true });
        continue;
      }
      this.dispatch(p, item, key, now);
    }
  }

  private dispatch(p: DecisionProvider, item: QueueItem, key: string, t1: number): void {
    this.busy = true;
    let settled = false;
    // runtime-side timeout: a provider that never answers must not block every later decision
    const limit = item.deadline !== undefined ? Math.max(1, item.deadline - t1) : PROVIDER_TIMEOUT_MS;
    const timer = this.clock.setTimeout(() => {
      this.onError?.(Object.assign(new Error("the decision provider did not answer in time"), { code: "timeout" }));
      done(null);
    }, limit);
    const done = (r: DecideResult | null) => {
      if (settled) return;
      settled = true;
      this.clock.clearTimeout(timer);
      this.busy = false;
      item.resolve(r);
      this.pump();
    };
    const req: EvaluateRequest = item.deadline !== undefined ? { ...item.req, timeoutMs: Math.max(1, item.deadline - t1) } : item.req;
    let pr: Promise<Record<string, Answer>>;
    try {
      pr = p.evaluate(req);
    } catch (e) {
      this.onError?.(e);
      done(null);
      return;
    }
    Promise.resolve(pr).then(
      (answers) => {
        if (answers && typeof answers === "object") {
          const t2 = this.clock.now();
          this.cache.set(key, { t: t2, answers });
          if (this.cache.size > CACHE_MAX) {
            const first = this.cache.keys().next().value;
            if (first !== undefined) this.cache.delete(first);
          }
          this.lat.push(t2 - t1);
          if (this.lat.length > LATENCY_SAMPLES) this.lat.shift();
          done({ answers, latencyMs: t2 - t1, waitMs: t1 - item.t0, cached: false });
        } else done(null);
      },
      (e) => {
        this.onError?.(e);
        done(null);
      },
    );
  }

  clear(): void {
    const q = this.q;
    this.q = [];
    for (const it of q) it.resolve(null);
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}
