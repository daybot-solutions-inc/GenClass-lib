// Decider queue (CONTRACT §8): one evaluation at a time, highest priority first (held writes/requests), a small
// cache of identical requests, and fail-open on any provider error.

import type { Answer, Clock, DecisionProvider, EvaluateRequest } from "../types.js";
import { fnv1a, stableStringify } from "../util.js";

export interface QueueItem {
  req: EvaluateRequest;
  /** Items whose hold expired may be dropped when other work is waiting. */
  expired?: () => boolean;
  resolve: (r: { answers: Record<string, Answer>; latencyMs: number; cached: boolean } | null) => void;
  seq: number;
}

const CACHE_MAX = 64;
const CACHE_TTL = 30_000;
const MAX_QUEUE = 32;

export class DeciderQueue {
  private q: QueueItem[] = [];
  private busy = false;
  private seq = 0;
  private cache = new Map<string, { t: number; answers: Record<string, Answer> }>();
  disposed = false;

  constructor(
    private readonly clock: Clock,
    private readonly provider: () => DecisionProvider | null,
    private readonly onError?: (e: unknown) => void,
  ) {}

  get length(): number {
    return this.q.length;
  }

  submit(req: EvaluateRequest, expired?: () => boolean): Promise<{ answers: Record<string, Answer>; latencyMs: number; cached: boolean } | null> {
    return new Promise((resolve) => {
      const item: QueueItem = { req, resolve, seq: ++this.seq };
      if (expired) item.expired = expired;
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
    if (this.busy || this.disposed) return;
    const item = this.next();
    if (!item) return;
    if (item.expired?.() && this.q.length > 0) {
      item.resolve(null);
      this.pump();
      return;
    }
    const p = this.provider();
    if (!p || p.status.state !== "ready") {
      item.resolve(null);
      this.pump();
      return;
    }
    const key = fnv1a(item.req.trigger + "\u0000" + stableStringify(item.req.state) + "\u0000" + stableStringify(item.req.questions));
    const hit = this.cache.get(key);
    const t0 = this.clock.now();
    if (hit && t0 - hit.t <= CACHE_TTL) {
      item.resolve({ answers: hit.answers, latencyMs: 0, cached: true });
      this.pump();
      return;
    }
    this.busy = true;
    let settled = false;
    const done = (r: { answers: Record<string, Answer>; latencyMs: number; cached: boolean } | null) => {
      if (settled) return;
      settled = true;
      this.busy = false;
      item.resolve(r);
      this.pump();
    };
    let pr: Promise<Record<string, Answer>>;
    try {
      pr = p.evaluate(item.req);
    } catch (e) {
      this.onError?.(e);
      done(null);
      return;
    }
    Promise.resolve(pr).then(
      (answers) => {
        if (answers && typeof answers === "object") {
          this.cache.set(key, { t: this.clock.now(), answers });
          if (this.cache.size > CACHE_MAX) {
            const first = this.cache.keys().next().value;
            if (first !== undefined) this.cache.delete(first);
          }
          done({ answers, latencyMs: this.clock.now() - t0, cached: false });
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
