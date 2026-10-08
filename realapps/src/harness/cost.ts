// Cost of a run against the ideal run, mirroring sim/src/oracle/cost.ts term by term (same weights W, same soft
// label rule from sim's actionLabel). Differences, all because the apps are real:
//   - client state = the stores the app registered with the runtime (atoms, adapters, guards) PLUS the visible
//     DOM text (multiset of lines, weight `domWeight`, default 1). Observe-only apps have the DOM term only;
//   - user-visible error episodes = appearances of the app's error UI (errorSelector, default [role=alert]);
//   - pending user operations = requests whose causal root is a scripted user step;
//   - server items compare by content with timestamps ignored (the mock server stamps createdAt/updatedAt).

import { W } from "../../../sim/src/oracle/cost.js";
import type { AppManifest, Relation } from "../shared/manifest.js";
import type { NetRec, RunResult, ServerSnap, SnapshotRec } from "../shared/types.js";

// sim's valueDist (sim/src/oracle/cost.ts), with creation/update timestamps also treated as volatile: the mock
// server stamps createdAt on every create, so the same intent created a little later must still compare equal.
const VOL = new Set(["id", "version", "rev", "revision", "etag", "updatedAt", "updated_at", "createdAt", "created_at", "clientId", "client_id", "tempId", "pending", "seq"]);
function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
function ckey(x: unknown): string {
  if (x && typeof x === "object" && !Array.isArray(x)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as object)) if (!VOL.has(k)) o[k] = v;
    return canon(o);
  }
  return canon(x);
}
function multisetDist(a: unknown[], b: unknown[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const m = new Map<string, number>();
  for (const x of a) {
    const k = ckey(x);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  let diff = 0;
  for (const x of b) {
    const k = ckey(x);
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
      if (VOL.has(k)) continue;
      n++;
      s += valueDist((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1);
    }
    return n ? s / n : 0;
  }
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9 ? 0 : 1;
  return canon(a) === canon(b) ? 0 : 1;
}

export interface State {
  t: number;
  stores: Record<string, unknown>;
  dom: string[];
  err: number;
}

const parseCache = new Map<string, unknown>();
function parse(j: string): unknown {
  let v = parseCache.get(j);
  if (v === undefined) {
    try {
      v = JSON.parse(j);
    } catch {
      v = null;
    }
    if (parseCache.size > 20000) parseCache.clear();
    parseCache.set(j, v);
  }
  return v;
}

/** Reconstruct full states from the initial state and the delta snapshots. */
export function states(r: RunResult): State[] {
  const out: State[] = [];
  let cur: State = { t: r.initial.t, stores: {}, dom: r.initial.d ?? [], err: r.initial.e ?? 0 };
  for (const [k, v] of Object.entries(r.initial.s ?? {})) cur.stores[k] = parse(v);
  out.push(cur);
  for (const s of r.snapshots) {
    const next: State = { t: s.t, stores: { ...cur.stores }, dom: s.d ?? cur.dom, err: s.e ?? cur.err };
    for (const [k, v] of Object.entries(s.s ?? {})) next.stores[k] = parse(v);
    out.push(next);
    cur = next;
  }
  return out;
}

export function stateAt(ss: State[], t: number): State {
  let lo = 0;
  let hi = ss.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ss[mid]!.t <= t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ss[best]!;
}

function weightOf(m: AppManifest, store: string, field?: string): number {
  const w = m.weights ?? {};
  if (field !== undefined && w[`${store}.${field}`] !== undefined) return w[`${store}.${field}`]!;
  return w[store] ?? 1;
}

export function relationBroken(rel: Relation, stores: Record<string, unknown>): boolean {
  try {
    return !rel.check(stores as Record<string, any>);
  } catch {
    return false;
  }
}

/** Weighted divergence of a client state from the ideal one. */
export function clientDist(real: State, ideal: State, m: AppManifest): number {
  let d = 0;
  const bad = new Set<string>();
  for (const r of m.relations ?? []) if (relationBroken(r, real.stores)) bad.add(r.fields[0]!);
  for (const path of bad) {
    const [store, field] = path.split(".");
    d += weightOf(m, store!, field);
  }
  const names = new Set([...Object.keys(real.stores), ...Object.keys(ideal.stores)]);
  for (const store of names) {
    const rv = real.stores[store];
    const iv = ideal.stores[store];
    if (rv === iv) continue;
    if (rv && iv && typeof rv === "object" && typeof iv === "object" && !Array.isArray(rv) && !Array.isArray(iv)) {
      const keys = new Set([...Object.keys(rv as object), ...Object.keys(iv as object)]);
      for (const k of keys) {
        const wk = weightOf(m, store, k);
        if (wk <= 0 || bad.has(`${store}.${k}`)) continue;
        const a = (rv as Record<string, unknown>)[k];
        const b = (iv as Record<string, unknown>)[k];
        if (a === b) continue;
        d += wk * valueDist(a, b);
      }
    } else d += weightOf(m, store) * valueDist(rv, iv);
  }
  const dw = m.domWeight ?? 1;
  if (dw > 0 && (real.dom.length || ideal.dom.length)) d += dw * valueDist(real.dom, ideal.dom);
  return d;
}

export function divergenceArea(real: State[], ideal: State[], from: number, to: number, m: AppManifest): number {
  const times = new Set<number>([from]);
  for (const s of real) if (s.t > from && s.t < to) times.add(s.t);
  for (const s of ideal) if (s.t > from && s.t < to) times.add(s.t);
  const ts = [...times].sort((a, b) => a - b);
  let area = 0;
  const cache = new Map<string, number>();
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!;
    const t2 = i + 1 < ts.length ? ts[i + 1]! : to;
    if (t2 <= t) continue;
    const a = stateAt(real, t);
    const b = stateAt(ideal, t);
    const key = `${a.t}|${b.t}`;
    let d = cache.get(key);
    if (d === undefined) {
      d = clientDist(a, b, m);
      cache.set(key, d);
    }
    area += (d * (t2 - t)) / 1000;
  }
  return area;
}

const VOLATILE = new Set(["id", "version", "rev", "revision", "etag", "updatedAt", "updated_at", "createdAt", "created_at", "clientId", "client_id", "tempId", "pending", "seq"]);
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
function contentKey(x: unknown): string {
  if (x && typeof x === "object" && !Array.isArray(x)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as object)) if (!VOLATILE.has(k)) o[k] = v;
    return canonical(o);
  }
  return canonical(x);
}

/** Weighted server divergence (sim's serverDist with timestamps ignored). */
export function serverDist(a: ServerSnap, b: ServerSnap): number {
  let d = 0;
  for (const c of new Set([...Object.keys(a.collections), ...Object.keys(b.collections)])) {
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
  for (const k of new Set([...Object.keys(a.docs), ...Object.keys(b.docs)])) {
    const x = (a.docs[k] ?? {}) as Record<string, unknown>;
    const y = (b.docs[k] ?? {}) as Record<string, unknown>;
    let n = 0;
    for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) if (!VOLATILE.has(f) && canonical(x[f]) !== canonical(y[f])) n++;
    d += W.serverField * Math.min(3, n);
  }
  for (const k of new Set([...Object.keys(a.counters), ...Object.keys(b.counters)])) d += W.serverField * Math.min(3, Math.abs((a.counters[k] ?? 0) - (b.counters[k] ?? 0)));
  return d;
}

function serverAt(ideal: RunResult, t: number): ServerSnap {
  const tl = ideal.serverTimeline;
  if (!tl || !tl.length) return ideal.server;
  let best = tl[0]!;
  for (const x of tl) {
    if (x.t <= t) best = x;
    else break;
  }
  return best.server;
}

function relationViolation(ss: State[], rels: Relation[], from: number, to: number): { area: number; final: number } {
  if (!rels.length) return { area: 0, final: 0 };
  const count = (st: State) => rels.filter((r) => relationBroken(r, st.stores)).length;
  let area = 0;
  let cur = stateAt(ss, from);
  let t = from;
  for (const s of ss) {
    if (s.t <= from) continue;
    if (s.t >= to) break;
    area += (count(cur) * (s.t - t)) / 1000;
    cur = s;
    t = s.t;
  }
  area += (count(cur) * (to - t)) / 1000;
  return { area, final: count(stateAt(ss, to)) };
}

/** Per user step the UI never let the user perform (realapps addition; the sim's users act on intents directly). */
export const BLOCKED = 1.0;

export interface CostBreakdown {
  blocked: number;
  total: number;
  area: number;
  finalClient: number;
  finalServer: number;
  relationS: number;
  relationFinal: number;
  shownErrors: number;
  uncaught: number;
  wasted: number;
  latencyS: number;
}

export function runCost(real: RunResult, ideal: RunResult, realStates: State[], idealStates: State[], from: number, tEnd: number, m: AppManifest): CostBreakdown {
  const stop = Math.min(tEnd, from + W.finalMs, real.tStop);
  const area = divergenceArea(realStates, idealStates, from, Math.min(stop, from + W.horizonMs), m);
  const finalClient = clientDist(stateAt(realStates, stop), stateAt(idealStates, stop), m);
  // a run that went on past `stop` (the base run standing in for the passive counterfactual) is read at `stop`
  const finalServer = serverDist(real.tStop > stop && real.serverTimeline?.length ? serverAt(real, stop) : real.server, serverAt(ideal, stop));
  const within = (ts: number[]) => ts.filter((t) => t >= from && t <= stop).length;
  // shown errors: for store apps, writes that put an error message into a store (counted when proposed, so a branch
  // never wins by dropping the message); for observe-only apps, appearances of the error UI
  const errs = (r: RunResult) => (m.integration === "stores" ? r.errorWrites ?? r.errorEpisodes : r.errorEpisodes);
  const shownErrors = Math.max(0, within(errs(real)) - within(errs(ideal)));
  // blocked user intents: steps whose element never appeared, beyond the ideal run's
  const blocked = Math.max(0, within(real.skippedAt ?? []) - within(ideal.skippedAt ?? []));
  const uncaught = Math.max(0, within(real.uncaught) - within(ideal.uncaught));
  const count = (log: NetRec[]) => {
    const mm = new Map<string, number>();
    for (const e of log) if (e.ta !== undefined && e.dedupedOf === undefined && e.ta >= from && e.ta <= stop) mm.set(e.sig, (mm.get(e.sig) ?? 0) + 1);
    return mm;
  };
  const rc = count(real.net);
  const ic = count(ideal.net);
  let wasted = 0;
  for (const [sig, n] of rc) wasted += Math.max(0, n - (ic.get(sig) ?? 0));
  let latencyMs = 0;
  for (const [a0, b0] of real.userOps) {
    const a = Math.max(a0, from);
    const b = Math.min(b0 ?? stop, stop);
    if (b > a) latencyMs += b - a;
  }
  const latencyS = latencyMs / 1000;
  const rels = m.relations ?? [];
  const rv = relationViolation(realStates, rels, from, Math.min(stop, from + W.horizonMs));
  const rf = relationViolation(realStates, rels, stop, stop).final;
  const total = W.area * area + W.finalClient * finalClient + finalServer + W.shownError * shownErrors + W.uncaught * uncaught + W.wasted * wasted + W.latency * latencyS + W.relation * rv.area + W.relationFinal * rf + BLOCKED * blocked;
  return { total, area, finalClient, finalServer, relationS: rv.area, relationFinal: rf, shownErrors, uncaught, wasted, latencyS, blocked };
}
