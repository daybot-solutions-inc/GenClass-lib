// Online baselines per op signature (CONTRACT §5): count, latency median/p95 from a sliding window of recent
// completions, EWMA error rate, failure streak, recent outcomes, request frequency vs the usual rate, and gaps
// between identical requests. Everything is computed from the injected clock (deterministic).

const LAT_WINDOW = 64;
const START_WINDOW = 128;
const WINDOW_MS = 10_000;
const ERR_ALPHA = 0.1;
const MIN_LAT_SAMPLES = 5;
const MAX_SIGS = 1000;

export interface SigStats {
  sig: string;
  count: number;
  failures: number;
  lat: number[];
  starts: number[];
  errEwma: number;
  failStreak: number;
  outcomes: string[];
  lastSuccess?: number;
  lastFailure?: number;
  firstStart: number;
}

export interface LatencyBaseline {
  n: number;
  median: number;
  p95: number;
}

export interface RateBaseline {
  /** Starts in the last 10 s. */
  recent: number;
  /** Usual starts per 10 s, when enough history exists. */
  usual?: number;
}

export interface IdentityStats {
  last: number;
  n: number;
  gapEwma?: number;
}

export class Baselines {
  readonly sigs = new Map<string, SigStats>();
  readonly ids = new Map<string, IdentityStats>();

  private get(sig: string, t: number): SigStats {
    let s = this.sigs.get(sig);
    if (!s) {
      s = { sig, count: 0, failures: 0, lat: [], starts: [], errEwma: 0, failStreak: 0, outcomes: [], firstStart: t };
      this.sigs.set(sig, s);
      if (this.sigs.size > MAX_SIGS) {
        const first = this.sigs.keys().next().value;
        if (first !== undefined) this.sigs.delete(first);
      }
    }
    return s;
  }

  stats(sig: string): SigStats | undefined {
    return this.sigs.get(sig);
  }

  start(sig: string, t: number, identity?: string): void {
    const s = this.get(sig, t);
    s.starts.push(t);
    if (s.starts.length > START_WINDOW) s.starts.shift();
    if (identity) {
      const i = this.ids.get(identity);
      if (!i) {
        this.ids.set(identity, { last: t, n: 1 });
        if (this.ids.size > 1024) {
          const first = this.ids.keys().next().value;
          if (first !== undefined) this.ids.delete(first);
        }
      } else {
        const gap = t - i.last;
        i.gapEwma = i.gapEwma === undefined ? gap : i.gapEwma * 0.8 + gap * 0.2;
        i.last = t;
        i.n++;
      }
    }
  }

  /** outcome: "200", "503", "timeout", "network", "error", "aborted" */
  end(sig: string, t: number, latency: number, ok: boolean, outcome: string, countsAsFailure: boolean): void {
    const s = this.get(sig, t);
    if (outcome === "aborted") return;
    s.count++;
    s.outcomes.push(outcome);
    if (s.outcomes.length > 8) s.outcomes.shift();
    if (countsAsFailure) {
      s.failures++;
      s.failStreak++;
      s.lastFailure = t;
      s.errEwma = s.errEwma * (1 - ERR_ALPHA) + ERR_ALPHA;
    } else {
      s.failStreak = 0;
      if (ok) s.lastSuccess = t;
      s.errEwma = s.errEwma * (1 - ERR_ALPHA);
      s.lat.push(latency);
      if (s.lat.length > LAT_WINDOW) s.lat.shift();
    }
  }

  latency(sig: string): LatencyBaseline | undefined {
    const s = this.sigs.get(sig);
    if (!s || s.lat.length < MIN_LAT_SAMPLES) return undefined;
    const a = [...s.lat].sort((x, y) => x - y);
    const q = (p: number) => a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
    return { n: s.lat.length, median: q(0.5), p95: q(0.95) };
  }

  rate(sig: string, now: number): RateBaseline {
    const s = this.sigs.get(sig);
    if (!s) return { recent: 0 };
    const cut = now - WINDOW_MS;
    let recent = 0;
    let older = 0;
    let oldest = Infinity;
    for (const t of s.starts) {
      if (t > cut) recent++;
      else {
        older++;
        if (t < oldest) oldest = t;
      }
    }
    const span = cut - oldest;
    if (older >= 3 && span >= 20_000) return { recent, usual: (older / span) * WINDOW_MS };
    return { recent };
  }

  identity(id: string): IdentityStats | undefined {
    return this.ids.get(id);
  }

  /** Recent latencies (newest last) for display. */
  snapshot(): { sig: string; count: number; median?: number; p95?: number; errorRate: number; failStreak: number }[] {
    return [...this.sigs.values()].map((s) => {
      const l = this.latency(s.sig);
      return { sig: s.sig, count: s.count, median: l?.median, p95: l?.p95, errorRate: s.errEwma, failStreak: s.failStreak };
    });
  }
}
