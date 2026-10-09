// Session summary (rt.summary()) and sink dispatch (OPTIONS-SPEC §4.11). Sink records are minimal by default (no
// situation text, no URLs, no values; only paths in `changed`). Dispatch is queued (a microtask batch, then idle
// time) and never runs on a decision or hold path; sink errors are swallowed.

import type { Clock, ModelStatus, SessionSummary, Sink, SinkKind, SinkObject, SinkRecord } from "../types.js";
import { hash32 } from "../util/match.js";

export class SummaryTracker {
  readonly s: SessionSummary;
  private lat: number[] = [];
  constructor(private readonly clock: Clock) {
    this.s = {
      startedAt: clock.now(),
      durationMs: 0,
      detections: {},
      interventions: {},
      undos: 0,
      lateReverts: 0,
      denied: {},
      shadow: {},
      model: { state: "off", decisions: 0, dropped: 0, hiddenSkipped: 0 },
      heldMs: { total: 0, max: 0 },
      errors: 0,
    };
  }
  inc(rec: Record<string, number>, k: string): void {
    rec[k] = (rec[k] ?? 0) + 1;
  }
  decision(latencyMs: number): void {
    this.s.model.decisions++;
    this.lat.push(latencyMs);
    if (this.lat.length > 200) this.lat.shift();
  }
  held(ms: number): void {
    this.s.heldMs.total += ms;
    this.s.heldMs.max = Math.max(this.s.heldMs.max, ms);
  }
  snapshot(state: ModelStatus["state"]): SessionSummary {
    const a = [...this.lat].sort((x, y) => x - y);
    const q = (p: number) => (a.length ? a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))] : undefined);
    const p50 = q(0.5);
    const p95 = q(0.95);
    return {
      ...this.s,
      durationMs: this.clock.now() - this.s.startedAt,
      detections: { ...this.s.detections },
      interventions: { ...this.s.interventions },
      denied: { ...this.s.denied },
      shadow: { ...this.s.shadow },
      heldMs: { ...this.s.heldMs },
      model: { ...this.s.model, state, ...(p50 !== undefined ? { p50Ms: p50 } : {}), ...(p95 !== undefined ? { p95Ms: p95 } : {}) },
    };
  }
}

const NEVER_DROPPED = new Set<SinkKind>(["intervention", "undo", "breaker"]);

interface SinkEntry {
  o: SinkObject;
  n: number;
  lastErr: number;
}

export class SinkDispatcher {
  private sinks: SinkEntry[];
  private queue: SinkRecord[] = [];
  private scheduled = false;
  private seq = 0;

  constructor(
    sinks: Sink[] | undefined,
    private readonly clock: Clock,
    private readonly global: Record<string, unknown>,
    private readonly onError: (msg: string) => void,
  ) {
    this.sinks = (sinks ?? []).filter(Boolean).map((s) => ({ o: typeof s === "function" ? { send: s } : s, n: 0, lastErr: -Infinity }));
  }

  get size(): number {
    return this.sinks.length;
  }

  nextId(): string {
    return `r${++this.seq}`;
  }

  /** Whether a sink wants evidence fields. */
  wantsEvidence(): boolean {
    return this.sinks.some((s) => s.o.evidence);
  }

  push(r: SinkRecord): void {
    if (!this.sinks.length) return;
    this.queue.push(r);
    if (this.scheduled) return;
    this.scheduled = true;
    void Promise.resolve().then(() => {
      const ric = this.global.requestIdleCallback as ((fn: () => void, o?: { timeout: number }) => unknown) | undefined;
      if (typeof ric === "function") {
        try {
          ric.call(this.global, () => this.drain(), { timeout: 1000 });
          return;
        } catch {
          /* fall through */
        }
      }
      this.drain();
    });
  }

  /** Deliver everything queued now (also used on pagehide). */
  drain(): void {
    this.scheduled = false;
    const batch = this.queue;
    this.queue = [];
    for (const r of batch) {
      for (const s of this.sinks) {
        if (s.o.kinds && !s.o.kinds.includes(r.kind)) continue;
        const idx = s.n++;
        if (!NEVER_DROPPED.has(r.kind) && typeof s.o.sampleRate === "number" && s.o.sampleRate < 1) {
          if (hash32(`${r.sessionId}:${idx}`) / 4294967296 >= Math.max(0, s.o.sampleRate)) continue;
        }
        const rec: SinkRecord = s.o.evidence ? r : stripEvidence(r);
        try {
          const p = s.o.send(rec);
          if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch((e) => this.err(s, e));
        } catch (e) {
          this.err(s, e);
        }
      }
    }
  }

  private err(s: SinkEntry, e: unknown): void {
    const now = this.clock.now();
    if (now - s.lastErr < 60_000) return;
    s.lastErr = now;
    this.onError(`a sink failed: ${(e as Error)?.message ?? e}`);
  }

  async flush(): Promise<void> {
    this.drain();
    for (const s of this.sinks) {
      try {
        await s.o.flush?.();
      } catch (e) {
        this.err(s, e);
      }
    }
  }
}

function stripEvidence(r: SinkRecord): SinkRecord {
  if (!r.evidence) return r;
  const { evidence: _e, ...rest } = r;
  return rest;
}
