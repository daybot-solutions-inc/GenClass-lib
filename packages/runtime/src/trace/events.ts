// Event ring buffer (CONTRACT §3).

import type { EventKind, RtEvent } from "../types.js";

export class EventLog {
  private buf: (RtEvent | undefined)[];
  private head = 0; // index of the next write
  private count = 0;
  private seq = 0;
  private listeners = new Set<(e: RtEvent) => void>();

  constructor(readonly size: number) {
    this.buf = new Array(Math.max(16, size));
  }

  push(t: number, kind: EventKind, name: string, extra?: { op?: number; cause?: number; data?: Record<string, unknown> }): RtEvent {
    const e: RtEvent = { seq: ++this.seq, t, kind, name };
    if (extra?.op !== undefined) e.op = extra.op;
    if (extra?.cause !== undefined) e.cause = extra.cause;
    if (extra?.data !== undefined) e.data = extra.data;
    this.buf[this.head] = e;
    this.head = (this.head + 1) % this.buf.length;
    if (this.count < this.buf.length) this.count++;
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* listeners never break tracing */
      }
    }
    return e;
  }

  /** Notify listeners again after an event was updated in place (typing bursts). */
  touch(e: RtEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* ignore */
      }
    }
  }

  /** The last n events, oldest first. */
  last(n = this.count): RtEvent[] {
    const k = Math.min(n, this.count);
    const out: RtEvent[] = new Array(k);
    const L = this.buf.length;
    for (let i = 0; i < k; i++) out[i] = this.buf[(this.head - k + i + L) % L] as RtEvent;
    return out;
  }

  /** Events with t >= since, oldest first. */
  since(since: number): RtEvent[] {
    const all = this.last();
    let i = all.length;
    while (i > 0 && all[i - 1].t >= since) i--;
    return all.slice(i);
  }

  get length(): number {
    return this.count;
  }

  onEvent(fn: (e: RtEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  clear(): void {
    this.buf = new Array(this.buf.length);
    this.head = 0;
    this.count = 0;
  }
}
