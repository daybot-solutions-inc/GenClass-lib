// Circuit breaker (OPTIONS-SPEC §4.5): demotes the mode after undos, or after errors on the subject of a recent
// action. Correlation by subject and time only (a demotion signal, not a bug rule). Only reset() clears a trip.

import type { BreakerOptions, Clock } from "../types.js";

export interface BreakerConfig {
  undos: number;
  errorsAfterAction: number;
  attributionMs: number;
  windowMs: number;
  downgradeTo: "observe" | "guard";
  persist: "session" | false;
}

export function breakerConfig(o: BreakerOptions | false | undefined): BreakerConfig | null {
  if (o === false) return null;
  const n = (x: unknown, d: number) => (typeof x === "number" && x > 0 ? x : d);
  return {
    undos: n(o?.undos, 2),
    errorsAfterAction: n(o?.errorsAfterAction, 3),
    attributionMs: n(o?.attributionMs, 5000),
    windowMs: n(o?.windowMs, 600_000),
    downgradeTo: o?.downgradeTo === "guard" ? "guard" : "observe",
    persist: o?.persist === false ? false : "session",
  };
}

const KEY = "genclass:breaker";

export interface TripInfo {
  at: number;
  reason: "undos" | "errors";
  decisionIds: string[];
}

export class Breaker {
  private undos: { t: number; d: string }[] = [];
  private errors: { t: number; d: string }[] = [];
  private actions: { t: number; keys: string[]; d: string }[] = [];
  tripped: TripInfo | null = null;

  constructor(
    readonly cfg: BreakerConfig,
    private readonly clock: Clock,
    private readonly storage: () => Storage | undefined,
    private readonly onTrip: (t: TripInfo, counts: { undos: number; errors: number }) => void,
  ) {
    if (cfg.persist === "session") {
      try {
        const raw = storage()?.getItem(KEY);
        if (raw) this.tripped = JSON.parse(raw) as TripInfo;
      } catch {
        /* memory only */
      }
    }
  }

  private prune(now: number): void {
    const w = this.cfg.windowMs;
    this.undos = this.undos.filter((x) => now - x.t <= w);
    this.errors = this.errors.filter((x) => now - x.t <= w);
    this.actions = this.actions.filter((x) => now - x.t <= Math.max(w, this.cfg.attributionMs));
  }

  /** A non-passive action ran on these subject keys. */
  action(decisionId: string, keys: string[]): void {
    this.actions.push({ t: this.clock.now(), keys, d: decisionId });
    if (this.actions.length > 256) this.actions.shift();
  }

  undo(decisionId: string): void {
    const now = this.clock.now();
    this.prune(now);
    this.undos.push({ t: now, d: decisionId });
    if (!this.tripped && this.undos.length >= this.cfg.undos) this.trip("undos", this.undos.map((x) => x.d));
  }

  /** An error or failed request on these subject keys: counted when an action on one of them ran within attributionMs. */
  error(keys: string[]): void {
    const now = this.clock.now();
    this.prune(now);
    const hit = [...this.actions].reverse().find((a) => now - a.t <= this.cfg.attributionMs && a.keys.some((k) => keys.includes(k)));
    if (!hit) return;
    this.errors.push({ t: now, d: hit.d });
    if (!this.tripped && this.errors.length >= this.cfg.errorsAfterAction) this.trip("errors", this.errors.map((x) => x.d));
  }

  private trip(reason: "undos" | "errors", ids: string[]): void {
    this.tripped = { at: this.clock.now(), reason, decisionIds: [...new Set(ids)] };
    if (this.cfg.persist === "session") {
      try {
        this.storage()?.setItem(KEY, JSON.stringify(this.tripped));
      } catch {
        /* memory only */
      }
    }
    this.onTrip(this.tripped, { undos: this.undos.length, errors: this.errors.length });
  }

  reset(): void {
    this.tripped = null;
    this.undos = [];
    this.errors = [];
    try {
      this.storage()?.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }

  counts(): { undos: number; errors: number } {
    return { undos: this.undos.length, errors: this.errors.length };
  }
}
