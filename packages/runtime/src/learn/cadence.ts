// Learned cadence of request signatures (situation v2, SIM's F6): whether a signature runs on a schedule (polling,
// interval autosave) and when the next run is due, or is sent a steady delay after the user's last input
// (debounced saves and searches). It tells the model whether a stale value will be replaced by itself soon.
// Deterministic (times come from the injected clock); bounded per signature and in signatures.

const KEEP = 9;
const MAX_SIGS = 500;
/** Interval runs within ±25% of the median interval count as periodic. */
const TOLERANCE = 0.25;
const MIN_PERIOD_MS = 250;

export type CadenceInfo =
  | { kind: "periodic"; period: number; intervals: number; last: number; next: number }
  | { kind: "debounced"; delay: number; matching: number; of: number };

interface SigCadence {
  /** Starts not caused by a user action (background: timers, intervals, sockets). */
  background: number[];
  /** Delay from the user action to the start, for starts a timer made after a user action. */
  delays: number[];
  /** Starts directly or indirectly caused by user actions (for "k of the last n"). */
  userStarts: number;
}

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

export class Cadence {
  private sigs = new Map<string, SigCadence>();

  private sig(sig: string): SigCadence {
    let s = this.sigs.get(sig);
    if (!s) {
      s = { background: [], delays: [], userStarts: 0 };
      this.sigs.set(sig, s);
      if (this.sigs.size > MAX_SIGS) {
        const first = this.sigs.keys().next().value;
        if (first !== undefined) this.sigs.delete(first);
      }
    }
    return s;
  }

  /**
   * A request of `sig` started at `t`. `userDelay`: time since the user action that caused it when a timer
   * (debounce) stands between them; `user`: the chain began with a user action.
   */
  note(sig: string, t: number, o: { user: boolean; userDelay?: number }): void {
    const s = this.sig(sig);
    if (!o.user) {
      s.background.push(t);
      if (s.background.length > KEEP) s.background.shift();
      return;
    }
    s.userStarts = Math.min(s.userStarts + 1, KEEP);
    if (o.userDelay !== undefined) {
      s.delays.push(o.userDelay);
      if (s.delays.length > KEEP - 1) s.delays.shift();
    }
  }

  get(sig: string, now: number): CadenceInfo | undefined {
    const s = this.sigs.get(sig);
    if (!s) return undefined;
    const b = s.background;
    if (b.length >= 4) {
      const iv: number[] = [];
      for (let i = 1; i < b.length; i++) iv.push(b[i] - b[i - 1]);
      const m = median(iv);
      const fit = iv.filter((x) => Math.abs(x - m) <= TOLERANCE * m).length;
      const last = b[b.length - 1];
      // a schedule that stopped (no run for 3 periods) is not a schedule any more
      if (m >= MIN_PERIOD_MS && fit >= Math.ceil(iv.length * 0.75) && now - last <= 3 * m) return { kind: "periodic", period: m, intervals: iv.length, last, next: last + m };
    }
    if (s.delays.length >= 3) {
      const m = median(s.delays);
      const matching = s.delays.filter((x) => Math.abs(x - m) <= Math.max(50, TOLERANCE * m)).length;
      if (m >= 100 && matching >= Math.ceil(s.delays.length * 0.75)) return { kind: "debounced", delay: m, matching, of: s.delays.length };
    }
    return undefined;
  }
}
