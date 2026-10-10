// Audit trail (rt.audit(), InitOptions.audit): one structured, JSON-serialisable entry per decision, action, undo,
// breaker event and control change (mode, aggressiveness, pause/resume, enabled, disable), each stamped with the
// mode in force, the aggressiveness profile, the gate values and the model (name, version, variant, device, the
// sha256 its file was verified against). It is a record of what the runtime did, built from values the runtime
// already has: it never feeds a decision and never changes what the model reads. URL query and fragment values in
// free text (subjects, `changed`, errors) are replaced with "…" (as in sink evidence), so entries can be shipped to
// the app's own logging. Bounded in memory (default 1,000 entries, oldest dropped); the optional sink receives every
// entry, in order, on a microtask (never on a hold path); sink errors are swallowed (one warning a minute). Nothing
// here is ever sent anywhere by GenClass.

import type { AuditEntry, AuditOptions, Clock } from "../types.js";

export const AUDIT_SCHEMA = 1;
export const AUDIT_DEFAULT_SIZE = 1000;
export const AUDIT_MAX_SIZE = 10_000;

export type AuditDraft = Omit<AuditEntry, "schema" | "seq">;

/** A deep, plain copy (entries hold only JSON values). */
function copy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class AuditLog {
  private buf: AuditEntry[] = [];
  private seq = 0;
  private readonly size: number;
  private readonly sink: ((e: AuditEntry) => void) | undefined;
  private pending: AuditEntry[] = [];
  private scheduled = false;
  private lastErr = -Infinity;

  constructor(
    o: AuditOptions | undefined,
    private readonly clock: Clock,
    private readonly warn: (msg: string) => void,
  ) {
    const n = o?.size;
    this.size = typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(AUDIT_MAX_SIZE, Math.floor(n)) : AUDIT_DEFAULT_SIZE;
    this.sink = typeof o?.sink === "function" ? o.sink : undefined;
  }

  /** Record an entry (never throws). */
  push(d: AuditDraft): void {
    let e: AuditEntry;
    try {
      e = copy({ schema: AUDIT_SCHEMA, seq: this.seq + 1, ...d } as AuditEntry);
    } catch {
      return; // an entry that cannot be serialised is not recorded (runtime values always can)
    }
    this.seq++;
    if (this.size > 0) {
      this.buf.push(e);
      if (this.buf.length > this.size) this.buf.splice(0, this.buf.length - this.size);
    }
    if (!this.sink) return;
    this.pending.push(e);
    if (this.scheduled) return;
    this.scheduled = true;
    void Promise.resolve().then(() => this.drain());
  }

  /** The last `n` entries (all kept by default), oldest first, as copies. */
  list(n?: number): AuditEntry[] {
    const out = typeof n === "number" && n >= 0 ? this.buf.slice(Math.max(0, this.buf.length - Math.floor(n))) : this.buf.slice();
    return out.map(copy);
  }

  /** Deliver queued entries to the sink now (also on destroy). */
  drain(): void {
    this.scheduled = false;
    const batch = this.pending;
    this.pending = [];
    if (!this.sink) return;
    for (const e of batch) {
      try {
        this.sink(copy(e));
      } catch (err) {
        const now = this.clock.now();
        if (now - this.lastErr >= 60_000) {
          this.lastErr = now;
          this.warn(`the audit sink failed: ${(err as Error)?.message ?? err}`);
        }
      }
    }
  }
}
