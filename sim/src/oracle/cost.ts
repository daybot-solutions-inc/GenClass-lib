// Divergence of client/server state from the intended (ideal-run) state, the run cost, and soft action labels.
//
// cost(run) = A·∫ D(t) dt (decision time .. +10 s horizon, seconds)          time-integrated client divergence
//           + R·∫ (#violated app relations) dt + Rf·(#violated at the end)   internal consistency
//           + Fc·D(final) + S(final)                                         final client / weighted server divergence
//           + E·(user-visible error episodes) + U·(uncaught errors)          errors the ideal run does not have
//           + W·(requests beyond the ideal run, per endpoint)                wasted / duplicate requests
//           + L·(seconds user-initiated operations were pending)             added latency
// D(t) = Σ_store Σ_field w_field · d(real, ideal) with d ∈ [0,1]; lists compare as multisets of item content
// (ids, versions, temp markers ignored), so the same intent yields equal content in every run.

import { canonical, type Item, type ServerSnapshot } from "../net/server.js";
import type { RunResult, Snapshot } from "../run/runner.js";

export const W = {
  /** Per second of full client divergence, integrated over [decision, decision + horizon]. */
  area: 1.0,
  horizonMs: 10000,
  /** "Final" client/server state is compared at decision + finalMs (or the scenario end). */
  finalMs: 15000,
  /** Client state still wrong at the end (until the user reloads). */
  finalClient: 4.0,
  /** Persistent server damage: per extra/missing collection item (duplicate orders, lost creates). */
  serverItem: 25.0,
  /** Per differing document field / counter unit on the server. */
  serverField: 6.0,
  shownError: 1.5,
  uncaught: 1.0,
  /** Per second a relation the app maintains (total = Σ items, counts, badges) is violated in the client state. */
  relation: 0.8,
  /** Per relation still violated at decision + finalMs. */
  relationFinal: 2.0,
  wasted: 0.08,
  latency: 0.25,
} as const;

/**
 * Label parameters. Each action's cost (per future) gets a tier premium (precision first). An action whose mean
 * cost is within `tieEps` of the passive action's is a practical tie and is pinned to passive + `exactTie`. Then
 * p_a ∝ exp(−gap_a / τ_a) with gap_a = mean over futures of (adjusted cost_a − adjusted cost_best) and
 * τ_a = tau0 + seMul · SE of that paired difference: clear-cut cases are sharp, cases whose futures disagree stay
 * soft.
 */
export const LABEL = {
  tier: { passive: 0, guard: 0.25, heal: 0.5 } as Record<string, number>,
  exactTie: 1.5,
  tieEps: 0.05,
  tau0: 0.1,
  seMul: 1.0,
};

export const TIER: Record<string, "passive" | "guard" | "heal"> = {
  apply: "passive", send: "passive", deliver: "passive", wait: "passive", ignore: "passive",
  discard: "guard", defer: "guard", coalesce: "guard", delay: "guard",
  block: "heal", serve_cached: "heal", retry: "heal", hedge: "heal", rollback: "heal", resync: "heal",
};

const VOLATILE = new Set(["id", "version", "rev", "revision", "etag", "updatedAt", "updated_at", "clientId", "pending", "seq"]);

function contentKey(x: unknown): string {
  if (x && typeof x === "object" && !Array.isArray(x)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as object)) if (!VOLATILE.has(k)) o[k] = v;
    return canonical(o);
  }
  return canonical(x);
}

function multisetDist(a: unknown[], b: unknown[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const m = new Map<string, number>();
  for (const x of a) {
    const k = contentKey(x);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  let diff = 0;
  for (const x of b) {
    const k = contentKey(x);
    const n = m.get(k) ?? 0;
    if (n > 0) m.set(k, n - 1);
    else diff++;
  }
  for (const n of m.values()) diff += n;
  return Math.min(1, diff / Math.max(a.length, b.length, 1));
}

export function valueDist(a: unknown, b: unknown, depth = 0): number {
  if (a === b) return 0;
  if (Array.isArray(a) && Array.isArray(b)) return multisetDist(a, b);
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b) && depth < 3) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    let n = 0;
    let s = 0;
    for (const k of keys) {
      if (VOLATILE.has(k)) continue;
      n++;
      s += valueDist((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1);
    }
    return n ? s / n : 0;
  }
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9 ? 0 : 1;
  return canonical(a) === canonical(b) ? 0 : 1;
}

/**
 * Weighted divergence of a client snapshot from the ideal one. The derived field of every app relation that the real
 * state violates (a total that does not match its items, a stale count) counts as fully wrong even if it happens to
 * equal the ideal value: a value that contradicts the state it summarises is not correct.
 */
export function clientDist(real: Record<string, unknown>, ideal: Record<string, unknown>, weights: Map<string, Record<string, number>>, relations: RunResult["relations"] = []): number {
  let d = 0;
  const bad = new Set<string>();
  for (const r of relations) {
    try {
      if (!r.check(real)) bad.add(r.fields[0]!);
    } catch {
      /* ignore */
    }
  }
  for (const path of bad) {
    const [store, field] = path.split(".");
    const w = weights.get(store!) ?? {};
    d += w[field!] ?? 1;
  }
  for (const [store, rv] of Object.entries(real)) {
    const iv = ideal[store];
    if (rv === iv) continue;
    const w = weights.get(store) ?? {};
    if (rv && iv && typeof rv === "object" && typeof iv === "object" && !Array.isArray(rv)) {
      const keys = new Set([...Object.keys(rv as object), ...Object.keys(iv as object)]);
      for (const k of keys) {
        const wk = w[k] ?? 1;
        if (wk <= 0) continue;
        if (bad.has(`${store}.${k}`)) continue;
        const a = (rv as Record<string, unknown>)[k];
        const b = (iv as Record<string, unknown>)[k];
        if (a === b) continue;
        d += wk * valueDist(a, b);
      }
    } else d += valueDist(rv, iv);
  }
  return d;
}

/** ∫ D(t) dt over [from, to] (seconds), with both runs' states piecewise constant between snapshots. */
export function divergenceArea(real: Snapshot[], ideal: Snapshot[], from: number, to: number, weights: Map<string, Record<string, number>>, init: Record<string, unknown>, relations: RunResult["relations"] = []): number {
  const times = new Set<number>([from]);
  for (const s of real) if (s.t > from && s.t < to) times.add(s.t);
  for (const s of ideal) if (s.t > from && s.t < to) times.add(s.t);
  const ts = [...times].sort((a, b) => a - b);
  let ri = -1;
  let ii = -1;
  const at = (arr: Snapshot[], idx: number, t: number): number => {
    while (idx + 1 < arr.length && arr[idx + 1]!.t <= t) idx++;
    return idx;
  };
  let area = 0;
  const cache = new Map<string, number>();
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!;
    const t2 = i + 1 < ts.length ? ts[i + 1]! : to;
    if (t2 <= t) continue;
    ri = at(real, ri, t);
    ii = at(ideal, ii, t);
    const key = `${ri}|${ii}`;
    let d = cache.get(key);
    if (d === undefined) {
      d = clientDist(ri >= 0 ? real[ri]!.state : init, ii >= 0 ? ideal[ii]!.state : init, weights, relations);
      cache.set(key, d);
    }
    area += (d * (t2 - t)) / 1000;
  }
  return area;
}

/** Weighted server divergence: W.serverItem per extra/missing item, W.serverField per doc field / counter unit. */
export function serverDist(a: ServerSnapshot, b: ServerSnapshot): number {
  let d = 0;
  const cols = new Set([...Object.keys(a.collections), ...Object.keys(b.collections)]);
  for (const c of cols) {
    const x = a.collections[c] ?? {};
    const y = b.collections[c] ?? {};
    let extra = 0;
    let changed = 0;
    for (const id of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const p = x[id];
      const q = y[id];
      if (!p || !q) extra++;
      else if (contentKey(p) !== contentKey(q)) changed++;
    }
    d += W.serverItem * Math.min(5, extra) + W.serverField * Math.min(5, changed);
  }
  const docs = new Set([...Object.keys(a.docs), ...Object.keys(b.docs)]);
  for (const k of docs) {
    const x = a.docs[k] ?? {};
    const y = b.docs[k] ?? {};
    let n = 0;
    for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) if (canonical(x[f]) !== canonical(y[f])) n++;
    d += W.serverField * Math.min(3, n);
  }
  const ctr = new Set([...Object.keys(a.counters), ...Object.keys(b.counters)]);
  for (const k of ctr) {
    if (/beats$/.test(k)) continue; // heartbeat counters depend on timing only
    d += W.serverField * Math.min(3, Math.abs((a.counters[k] ?? 0) - (b.counters[k] ?? 0)));
  }
  return d;
}

/** ∫ (number of violated app relations) dt over [from, to] in seconds, and the count violated at `to`. */
export function relationViolation(snaps: Snapshot[], relations: RunResult["relations"], from: number, to: number, init: Record<string, unknown>): { area: number; final: number } {
  if (!relations.length) return { area: 0, final: 0 };
  const count = (st: Record<string, unknown>) => {
    let n = 0;
    for (const r of relations) {
      try {
        if (!r.check(st)) n++;
      } catch {
        /* ignore */
      }
    }
    return n;
  };
  let area = 0;
  let cur = stateAt(snaps, from, init);
  let t = from;
  for (const s of snaps) {
    if (s.t <= from) continue;
    if (s.t >= to) break;
    area += (count(cur) * (s.t - t)) / 1000;
    cur = s.state;
    t = s.t;
  }
  area += (count(cur) * (to - t)) / 1000;
  return { area, final: count(stateAt(snaps, to, init)) };
}

export interface CostBreakdown {
  total: number;
  relationS: number;
  relationFinal: number;
  area: number;
  finalClient: number;
  finalServer: number;
  shownErrors: number;
  uncaught: number;
  wasted: number;
  latencyS: number;
}

function stateAt(snaps: Snapshot[], t: number, init: Record<string, unknown>): Record<string, unknown> {
  let lo = 0;
  let hi = snaps.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snaps[mid]!.t <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best >= 0 ? snaps[best]!.state : init;
}

/** Client divergence from the ideal run at time t (analysis probes: how wrong the client already is). */
export function clientDivergenceAt(real: RunResult, ideal: RunResult, t: number): number {
  const init = real.snapshots.length ? real.snapshots[0]!.state : real.final;
  return clientDist(stateAt(real.snapshots, t, init), stateAt(ideal.snapshots, t, init), real.weights, real.relations);
}

/** Ideal server state at time t (from the ideal run's server timeline). */
function serverAt(ideal: RunResult, t: number): ServerSnapshot {
  const tl = ideal.serverTimeline;
  if (!tl || tl.length === 0) return ideal.server;
  let best = tl[0]!;
  for (const x of tl) {
    if (x.t <= t) best = x;
    else break;
  }
  return best.server;
}

/**
 * Cost of a (counterfactual) run against the ideal run, counting what happens from `from` (the decision time) to
 * `from + W.finalMs` (or the scenario end): the decision's local consequences, not far-future ripple effects.
 */
export function runCost(real: RunResult, ideal: RunResult, from: number, tEnd: number): CostBreakdown {
  const stop = Math.min(tEnd, from + W.finalMs, real.tStop);
  const init = real.snapshots.length ? real.snapshots[0]!.state : real.final;
  const area = divergenceArea(real.snapshots, ideal.snapshots, from, Math.min(stop, from + W.horizonMs), real.weights, init, real.relations);
  const finalClient = clientDist(stateAt(real.snapshots, stop, init), stateAt(ideal.snapshots, stop, init), real.weights, real.relations);
  const finalServer = serverDist(real.tStop <= stop ? real.server : real.server, serverAt(ideal, stop));
  const within = (ts: number[]) => ts.filter((t) => t >= from && t <= stop).length;
  const shownErrors = Math.max(0, within(real.shownErrorTimes) - within(ideal.shownErrorTimes));
  const uncaught = Math.max(0, within(real.uncaughtTimes) - within(ideal.uncaughtTimes));
  const count = (log: RunResult["netLog"]) => {
    const m = new Map<string, number>();
    for (const e of log) if (e.ta !== undefined && e.ta >= from && e.ta <= stop) m.set(e.signature, (m.get(e.signature) ?? 0) + 1);
    return m;
  };
  const rc = count(real.netLog);
  const ic = count(ideal.netLog);
  let wasted = 0;
  for (const [sig, n] of rc) wasted += Math.max(0, n - (ic.get(sig) ?? 0));
  let latencyMs = 0;
  for (const op of real.know.ops) {
    if (op.background) continue;
    const a = Math.max(op.t0, from);
    const b = Math.min(op.tEnd ?? stop, stop);
    if (b > a) latencyMs += b - a;
  }
  const latencyS = latencyMs / 1000;
  const rv = relationViolation(real.snapshots, real.relations, from, Math.min(stop, from + W.horizonMs), init);
  const rf = relationViolation(real.snapshots, real.relations, stop, stop, init).final;
  const total =
    W.area * area + W.finalClient * finalClient + finalServer + W.shownError * shownErrors + W.uncaught * uncaught + W.wasted * wasted + W.latency * latencyS + W.relation * rv.area + W.relationFinal * rf;
  return { total, relationS: rv.area, relationFinal: rf, area, finalClient, finalServer, shownErrors, uncaught, wasted, latencyS };
}

export interface ActionLabel {
  dist: Record<string, number>;
  best: string;
  /** Mean adjusted cost (premiums, tie rule) relative to the best action. */
  adjusted: Record<string, number>;
  /** Standard error of each action's paired difference to the best action over futures (0 with one future). */
  se: Record<string, number>;
  passiveBest: boolean;
  /** Probability mass on non-passive actions. */
  nonPassiveMass: number;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Soft action label from per-action costs (one number, or one per counterfactual future: paired by index). */
export function actionLabel(costs: Record<string, number | number[]>, passive: string): ActionLabel {
  const arr: Record<string, number[]> = {};
  for (const [a, c] of Object.entries(costs)) arr[a] = Array.isArray(c) ? c : [c];
  const actions = Object.keys(arr);
  const K = Math.min(...actions.map((a) => arr[a]!.length));
  const cp = arr[passive];
  const meanP = cp ? mean(cp.slice(0, K)) : undefined;
  const adj: Record<string, number[]> = {};
  for (const a of actions) {
    const prem = LABEL.tier[TIER[a] ?? "heal"] ?? LABEL.tier.heal!;
    const xs = arr[a]!.slice(0, K);
    if (a !== passive && cp && meanP !== undefined && Math.abs(mean(xs) - meanP) < LABEL.tieEps) adj[a] = cp.slice(0, K).map((x) => x + LABEL.exactTie);
    else adj[a] = xs.map((x) => x + prem);
  }
  let best = actions.includes(passive) ? passive : actions[0]!;
  for (const a of actions) if (mean(adj[a]!) < mean(adj[best]!) - 1e-12) best = a;
  const raw: Record<string, number> = {};
  const rel: Record<string, number> = {};
  const se: Record<string, number> = {};
  let z = 0;
  for (const a of actions) {
    const d = adj[a]!.map((x, j) => x - adj[best]![j]!);
    const gap = Math.max(0, mean(d));
    const e = K > 1 ? sd(d) / Math.sqrt(K) : 0;
    const tau = LABEL.tau0 + LABEL.seMul * e;
    raw[a] = Math.exp(-gap / tau);
    z += raw[a]!;
    rel[a] = Math.round(gap * 1000) / 1000;
    se[a] = Math.round(e * 1000) / 1000;
  }
  const dist: Record<string, number> = {};
  for (const a of actions) dist[a] = Math.round((raw[a]! / z) * 1e4) / 1e4;
  const nonPassiveMass = Math.round(actions.filter((a) => a !== passive).reduce((acc, a) => acc + dist[a]!, 0) * 1e4) / 1e4;
  return { dist, best, adjusted: rel, se, passiveBest: best === passive, nonPassiveMass };
}
