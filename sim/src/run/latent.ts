// S2: counterfactual futures re-draw what a runtime cannot observe at the labelled decision (time t), so a label is
// the expected cost given the observable situation rather than a hindsight verdict:
//   - the user's own next steps (timing): a per-future tempo and per-gap jitter for every step after t;
//   - outage / offline / slow / socket-drop / server-bug windows: the remaining length of a window already running at
//     t, and the start of windows that begin later;
//   - prefix latents (network.ts): whether an ambiguous failed write committed, the remaining time of requests in
//     flight at t, and the server-side draws of requests that arrive after t;
//   - the hidden intent of repeated user actions before t (accidental vs intended), drawn from its posterior given
//     the observable gap; only the ideal run changes (the clicks are the same).
// Every draw is keyed by the future's salt; the prefix the runtime saw stays byte-identical (pointCosts checks it).

import type { UserStep } from "../app/feature.js";
import type { NetProfile, Win } from "../net/network.js";
import { hashAll, Rng } from "../rng.js";

export interface FutureSpec {
  /** Decisions >= k use the salt (real runs); -1 for ideal runs. */
  k: number;
  salt: number;
  /** Time of the labelled decision. */
  t: number;
  /** Re-draw network/timing randomness only (fallback when a latent re-draw changed an observed prefix). */
  noLatent?: boolean;
  /** Ideal runs: indices of conditional user steps that fired in the base run before t. */
  fired?: number[];
}

export const S2 = typeof process === "undefined" || process.env.SIM_S2 !== "0";

function redrawWin<W extends Win>(w: W, t: number, rng: Rng): W {
  if (w.end <= t) return w;
  if (w.start <= t) {
    // Running at t: its remaining length is unknown to the client.
    const rem = (w.end - t) * rng.lognormal(1, 0.7);
    return { ...w, end: t + Math.max(200, rem) };
  }
  // Starts later: when is part of the future.
  const len = w.end - w.start;
  const start = t + (w.start - t) * rng.lognormal(1, 0.5);
  return { ...w, start, end: start + len };
}

/** The network profile of a re-seeded future (windows re-drawn after t). */
export function futureProfile(P: NetProfile, f: FutureSpec | undefined): NetProfile {
  if (!f || f.noLatent || !S2 || P.ideal) return P;
  const r = new Rng(hashAll("future-windows", f.salt));
  const map = <W extends Win>(ws: W[] | undefined, tag: string): W[] | undefined => ws?.map((w, i) => redrawWin(w, f.t, r.fork(`${tag}${i}`)));
  return {
    ...P,
    outages: map(P.outages, "o") ?? [],
    slow: map(P.slow, "s") ?? [],
    bugs: map(P.bugs, "b") ?? [],
    ...(P.offline ? { offline: map(P.offline, "off") } : {}),
    ...(P.socketDrops ? { socketDrops: map(P.socketDrops, "sd") } : {}),
  };
}

/** Step times in a re-seeded future: steps after t keep their order; the user's tempo and each gap are re-drawn. */
export function futureStepTimes(steps: UserStep[], f: FutureSpec | undefined): number[] {
  const ts = steps.map((s) => s.t);
  if (!f || f.noLatent || !S2) return ts;
  const r = new Rng(hashAll("future-steps", f.salt));
  const tempo = r.lognormal(1, 0.15);
  let prevOld = f.t;
  let prevNew = f.t;
  const order = steps.map((_, i) => i).sort((a, b) => steps[a]!.t - steps[b]!.t || a - b);
  for (const i of order) {
    const t0 = steps[i]!.t;
    if (t0 <= f.t) continue;
    const gap = t0 - prevOld;
    const g = gap * tempo * new Rng(hashAll("future-gap", f.salt, i)).lognormal(1, 0.2);
    const tn = prevNew + g;
    ts[i] = tn;
    prevOld = t0;
    prevNew = tn;
  }
  return ts;
}

/**
 * P(accidental | gap to the previous identical user action), from the sim's own user model (measured with
 * `node sim/dist/smoke.js --repeat-prior 4000`: activations only, conditional re-clicks only when they fired). Buckets: upper bound of the gap in ms.
 */
export const REPEAT_PRIOR: [number, number][] = [
  [100, 0.74],
  [200, 0.67],
  [500, 0.17],
  [1000, 0.23],
  [2000, 0.2],
  [3000, 0.06],
];

export function repeatPrior(gapMs: number): number | undefined {
  for (const [ub, p] of REPEAT_PRIOR) if (gapMs <= ub) return p;
  return undefined;
}

/** A discrete activation (click, submit, Enter/Space): the kind of action a user repeats by accident. */
function activation(s: UserStep): boolean {
  return s.ui.kind === "click" || s.ui.kind === "submit" || (s.ui.kind === "key" && (s.ui.value === "Enter" || s.ui.value === "Space"));
}

/** Index of the previous identical activation (same feature, action, key and target) within 3 s, per step. */
export function repeatOfIndex(steps: UserStep[]): (number | undefined)[] {
  const last = new Map<string, number>();
  return steps.map((s, i) => {
    if (!activation(s)) return undefined;
    const k = `${s.feature}|${s.action}|${s.intent.key}|${s.ui.target}`;
    const j = last.get(k);
    last.set(k, i);
    return j !== undefined && s.t - steps[j]!.t <= 3000 ? j : undefined;
  });
}

/**
 * Ideal run of a re-seeded future: for repeated actions before t (no `when` condition), the hidden intent is drawn
 * from its posterior. Returns, per step index, whether the ideal run skips it (undefined = default rule).
 */
export function idealRepeatSkips(steps: UserStep[], f: FutureSpec | undefined): Map<number, boolean> {
  const out = new Map<number, boolean>();
  if (!f || f.noLatent || !S2) return out;
  const rep = repeatOfIndex(steps);
  const fired = new Set(f.fired ?? []);
  steps.forEach((s, i) => {
    const j = rep[i];
    // Conditional re-clicks (impatience) count only if they fired in the base run (the ideal cannot evaluate them).
    if (j === undefined || s.t > f.t || (s.when && !fired.has(i))) return;
    const p = repeatPrior(s.t - steps[j]!.t);
    if (p === undefined) return;
    out.set(i, new Rng(hashAll("future-intent", f.salt, i)).next() < p);
  });
  return out;
}
