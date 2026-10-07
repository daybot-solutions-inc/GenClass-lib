// Transition profiles (CONTRACT §4): for every op signature (and user-action target), counts over its
// completions of the store fields its causal chain wrote, each written value's kind, the response status class,
// the number of writes and a duration bucket. A completed op whose shape component was seen in < 1% of >= 20
// previous completions is unusual. Generic: no knowledge of what any field or op means.

import type { ChainWrite } from "../trace/ops.js";

export const MIN_COMPLETIONS = 20;
export const RARE = 0.01;

export interface Profile {
  sig: string;
  n: number;
  /** Sorted written-field set ("" = wrote nothing) -> count. */
  sets: Record<string, number>;
  /** field -> value kind -> count (over completions that wrote the field). */
  kinds: Record<string, Record<string, number>>;
  /** field -> number of completions that wrote it. */
  wrote: Record<string, number>;
  status: Record<string, number>;
  writes: Record<string, number>;
  dur: Record<string, number>;
}

export interface Shape {
  set: string;
  fields: string[];
  kinds: Record<string, string>;
  status: string;
  writes: string;
  dur: string;
}

export interface Unusual {
  /** Which component is rare. */
  component: "set" | "kind" | "status" | "writes";
  field?: string;
  /** Times the observed value was seen before, and the previous completions considered. */
  seen: number;
  of: number;
  /** The most common previous value and its count. */
  usual: string;
  usualCount: number;
  observed: string;
}

/**
 * The value kind compared across completions: the type, and for arrays empty vs non-empty. The length change
 * (grew/shrank) is deliberately not part of it: a short last page or a removal is ordinary (precision).
 */
export function kindLabel(w: ChainWrite): string {
  if (w.kind === "array") return w.len1 === 0 ? "empty array" : "non-empty array";
  if (w.kind === "object") return "object";
  return w.kind;
}

const MAX_SETS = 64;
const MAX_FIELDS = 128;

/** Keep a count map to `max` keys by dropping the least frequent (ties: oldest). */
function capCounts(rec: Record<string, number>, max: number): void {
  const keys = Object.keys(rec);
  if (keys.length <= max) return;
  keys.sort((a, b) => rec[a] - rec[b]);
  for (const k of keys.slice(0, keys.length - max)) delete rec[k];
}

export function writesBucket(n: number): string {
  return n === 0 ? "0" : n === 1 ? "1" : n === 2 ? "2" : n <= 4 ? "3-4" : "5+";
}

export function durBucket(ms: number): string {
  if (ms < 50) return "<50ms";
  if (ms < 200) return "50-200ms";
  if (ms < 1000) return "0.2-1s";
  if (ms < 5000) return "1-5s";
  return ">5s";
}

export function shapeOf(chain: Map<string, ChainWrite> | undefined, writes: number, status: string, durMs: number): Shape {
  const fields = chain ? [...chain.keys()].sort() : [];
  const kinds: Record<string, string> = {};
  for (const f of fields) kinds[f] = kindLabel(chain!.get(f)!);
  return { set: fields.join(","), fields, kinds, status, writes: writesBucket(writes), dur: durBucket(durMs) };
}

function top(rec: Record<string, number>): [string, number] {
  let best = "";
  let n = -1;
  for (const k of Object.keys(rec).sort()) if (rec[k] > n) [best, n] = [k, rec[k]];
  return [best, Math.max(0, n)];
}

export class Profiles {
  readonly bySig = new Map<string, Profile>();

  get(sig: string): Profile | undefined {
    return this.bySig.get(sig);
  }

  /** Compare a shape against the profile (before adding it). */
  check(sig: string, s: Shape): Unusual[] {
    const p = this.bySig.get(sig);
    if (!p || p.n < MIN_COMPLETIONS) return [];
    const out: Unusual[] = [];
    const rare = (seen: number, of: number) => of >= MIN_COMPLETIONS && seen < RARE * of;
    const setSeen = p.sets[s.set] ?? 0;
    const [usualSet, usualSetCount] = top(p.sets);
    // precision: an op that usually changes nothing (e.g. a poll of stable data) changing something is normal
    if (rare(setSeen, p.n) && usualSet !== "") {
      out.push({ component: "set", seen: setSeen, of: p.n, usual: usualSet, usualCount: usualSetCount, observed: s.set });
    }
    for (const f of s.fields) {
      const of = p.wrote[f] ?? 0;
      const seen = p.kinds[f]?.[s.kinds[f]] ?? 0;
      if (of >= MIN_COMPLETIONS && rare(seen, of)) {
        const [u, c] = top(p.kinds[f] ?? {});
        out.push({ component: "kind", field: f, seen, of, usual: u, usualCount: c, observed: s.kinds[f] });
      }
    }
    const st = p.status[s.status] ?? 0;
    if (rare(st, p.n)) {
      const [u, c] = top(p.status);
      out.push({ component: "status", seen: st, of: p.n, usual: u, usualCount: c, observed: s.status });
    }
    const wr = p.writes[s.writes] ?? 0;
    const [usualWrites, usualWritesCount] = top(p.writes);
    if (rare(wr, p.n) && usualWrites !== "0" && !out.some((x) => x.component === "set")) {
      out.push({ component: "writes", seen: wr, of: p.n, usual: usualWrites, usualCount: usualWritesCount, observed: s.writes });
    }
    return out;
  }

  add(sig: string, s: Shape): void {
    let p = this.bySig.get(sig);
    if (!p) {
      p = { sig, n: 0, sets: {}, kinds: {}, wrote: {}, status: {}, writes: {}, dur: {} };
      this.bySig.set(sig, p);
      if (this.bySig.size > 2000) {
        const first = this.bySig.keys().next().value;
        if (first !== undefined) this.bySig.delete(first);
      }
    }
    p.n++;
    p.sets[s.set] = (p.sets[s.set] ?? 0) + 1;
    capCounts(p.sets, MAX_SETS);
    for (const f of s.fields) {
      p.wrote[f] = (p.wrote[f] ?? 0) + 1;
      const k = (p.kinds[f] ??= {});
      k[s.kinds[f]] = (k[s.kinds[f]] ?? 0) + 1;
    }
    if (Object.keys(p.wrote).length > MAX_FIELDS) {
      capCounts(p.wrote, MAX_FIELDS);
      for (const f of Object.keys(p.kinds)) if (!(f in p.wrote)) delete p.kinds[f];
    }
    p.status[s.status] = (p.status[s.status] ?? 0) + 1;
    p.writes[s.writes] = (p.writes[s.writes] ?? 0) + 1;
    p.dur[s.dur] = (p.dur[s.dur] ?? 0) + 1;
  }

  toJSON(): Profile[] {
    return [...this.bySig.values()];
  }

  load(list: unknown): void {
    if (!Array.isArray(list)) return;
    for (const p of list as Profile[]) {
      if (p && typeof p.sig === "string" && typeof p.n === "number") this.bySig.set(p.sig, p);
    }
  }
}
