// Invariant miner (CONTRACT §4): generic templates over flattened fields of all stores, learned online at
// settled points. A candidate is created when it holds non-trivially, becomes learned after holding at >= 3
// settled snapshots where one of its fields changed, and is dropped for good if violated while learning.
// Learned invariants that break at a settled point are reported (once per episode by the runtime).
// No domain knowledge: the templates apply to whatever fields exist. Fields under id-like keys (dynamic
// collections) are skipped, and a candidate whose field disappeared is not evaluated.

import type { Violation } from "../situation/env.js";
import { describe, defaultRedact, fmtNum, isIdSegment, isPlainObject } from "../util.js";
import type { Leaf } from "./fields.js";

export const LEARN_AFTER = 3;
const MAX_NUMERIC = 64;
const MAX_SCALAR = 96;
const MAX_ARRAYS = 24;
const MAX_COLUMNS = 8;
const MAX_CANDIDATES = 4000;

type Tpl = "eq" | "len" | "sum" | "sumprod" | "nonneg" | "in" | "unique" | "type" | "nonnull";

interface Cand {
  id: string;
  tpl: Tpl;
  text: string;
  a?: string;
  b?: string;
  B?: string;
  f?: string;
  g?: string;
  /** Leaf paths whose change counts as "an involved field changed". */
  watch: string[];
  held: number;
  learned: boolean;
  typeKind?: string;
}

interface Expectation {
  name: string;
  pred: () => boolean;
}

export function numEq(a: number, b: number): boolean {
  if (a === b) return true;
  const d = Math.abs(a - b);
  if (d <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))) return true;
  return d < 0.0051 && Math.round(a * 100) === Math.round(b * 100);
}

function dynamicPath(p: string): boolean {
  return p.split(".").some((s) => isIdSegment(s));
}

function column(arr: unknown[], k: string): unknown[] {
  return arr.map((x) => (isPlainObject(x) ? x[k] : undefined));
}

export class InvariantMiner {
  private cands = new Map<string, Cand>();
  private dropped = new Set<string>();
  private changed = new Set<string>();
  private expects = new Map<string, Expectation>();
  private violated: Violation[] = [];
  /** Settled points observed. */
  points = 0;

  noteChanged(paths: string[]): void {
    for (const p of paths) this.changed.add(p);
  }

  addExpect(name: string, pred: () => boolean): () => void {
    const e = { name, pred };
    this.expects.set(name, e);
    return () => {
      if (this.expects.get(name) === e) this.expects.delete(name);
    };
  }

  current(): Violation[] {
    return this.violated;
  }

  learned(): { id: string; text: string; held: number }[] {
    return [...this.cands.values()].filter((c) => c.learned).map((c) => ({ id: c.id, text: c.text, held: c.held }));
  }

  candidates(): number {
    return this.cands.size;
  }

  /** Evaluate a candidate on leaves: true / false / null (not applicable: a field is missing). */
  private holds(c: Cand, L: Map<string, Leaf>): boolean | null {
    const val = (p: string | undefined) => (p === undefined ? undefined : L.get(p));
    switch (c.tpl) {
      case "eq": {
        const a = val(c.a);
        const b = val(c.b);
        if (!a || !b) return null;
        if (typeof a.value === "number" && typeof b.value === "number") return numEq(a.value, b.value);
        return a.value === b.value;
      }
      case "len": {
        const a = val(c.a);
        const B = val(c.B);
        if (!a || !B || B.kind !== "array" || typeof a.value !== "number") return null;
        return a.value === (B.value as unknown[]).length;
      }
      case "sum":
      case "sumprod": {
        const a = val(c.a);
        const B = val(c.B);
        if (!a || !B || B.kind !== "array" || typeof a.value !== "number") return null;
        const arr = B.value as unknown[];
        let s = 0;
        for (const x of arr) {
          if (!isPlainObject(x)) return false;
          const f = x[c.f!];
          const g = c.tpl === "sumprod" ? x[c.g!] : 1;
          if (typeof f !== "number" || typeof g !== "number") return false;
          s += f * g;
        }
        return numEq(a.value, s);
      }
      case "nonneg": {
        const a = val(c.a);
        if (!a || typeof a.value !== "number") return a ? a.value === null || a.value === undefined ? null : false : null;
        return a.value >= 0;
      }
      case "in": {
        const a = val(c.a);
        const B = val(c.B);
        if (!a || !B || B.kind !== "array") return null;
        if (a.value === null || a.value === undefined || a.value === "") return null;
        return column(B.value as unknown[], c.f!).some((v) => v === a.value);
      }
      case "unique": {
        const B = val(c.B);
        if (!B || B.kind !== "array") return null;
        const col = column(B.value as unknown[], c.f!);
        const seen = new Set<unknown>();
        for (const v of col) {
          if (v === undefined || v === null) continue;
          if (seen.has(v)) return false;
          seen.add(v);
        }
        return true;
      }
      case "type": {
        const a = val(c.a);
        if (!a) return null;
        if (a.kind === "null" || a.kind === "undefined") return null;
        return a.kind === c.typeKind;
      }
      case "nonnull": {
        const a = val(c.a);
        if (!a) return null;
        return a.value !== null && a.value !== undefined;
      }
    }
  }

  /** Whether a holding relation says something on these leaves (coincidences on tiny inputs do not count). */
  private nonTrivial(c: Cand, L: Map<string, Leaf>): boolean {
    const a = c.a ? L.get(c.a) : undefined;
    const B = c.B ? L.get(c.B) : undefined;
    const n = B && Array.isArray(B.value) ? B.value.length : 0;
    switch (c.tpl) {
      case "eq":
        return !!a && a.value !== 0 && a.value !== "" && a.value !== false;
      case "len":
        return n > 0;
      case "sum":
      case "sumprod":
        return n > 0 && !!a && a.value !== 0;
      case "in":
      case "unique":
        return n >= 2;
      case "nonneg":
        return !!a && typeof a.value === "number" && a.value > 0;
      default:
        return true;
    }
  }

  private valuesText(c: Cand, L: Map<string, Leaf>): string {
    const show = (p: string | undefined) => {
      const l = p ? L.get(p) : undefined;
      return l ? describe(l.value, p!, defaultRedact, 40) : "missing";
    };
    switch (c.tpl) {
      case "eq":
        return `${c.a} = ${show(c.a)}, ${c.b} = ${show(c.b)}`;
      case "len": {
        const B = L.get(c.B!);
        return `${c.a} = ${show(c.a)}, len(${c.B}) = ${B && Array.isArray(B.value) ? B.value.length : "?"}`;
      }
      case "sum":
      case "sumprod": {
        const B = L.get(c.B!);
        let s = 0;
        if (B && Array.isArray(B.value))
          for (const x of B.value) if (isPlainObject(x)) s += (Number(x[c.f!]) || 0) * (c.tpl === "sumprod" ? Number(x[c.g!]) || 0 : 1);
        const expr = c.tpl === "sum" ? `sum(${c.B}[*].${c.f})` : `sum(${c.B}[*].${c.f} * ${c.B}[*].${c.g})`;
        return `${c.a} = ${show(c.a)}, ${expr} = ${fmtNum(s)}`;
      }
      case "nonneg":
      case "nonnull":
        return `${c.a} = ${show(c.a)}`;
      case "type": {
        const l = L.get(c.a!);
        return `${c.a} is ${l?.kind ?? "missing"} (was ${c.typeKind})`;
      }
      case "in":
        return `${c.a} = ${show(c.a)}, not among ${c.B}[*].${c.f}`;
      case "unique":
        return `${c.B}[*].${c.f} has duplicates`;
    }
  }

  private changedNow = new Set<string>();

  private involved(watch: string[], changed: Set<string>): boolean {
    for (const p of watch) {
      if (changed.has(p)) return true;
      for (const x of changed) if (x.startsWith(p + ".")) return true;
    }
    return false;
  }

  private leavesNow: Map<string, Leaf> = new Map();

  private add(c: Omit<Cand, "held" | "learned">): void {
    if (this.cands.size >= MAX_CANDIDATES || this.cands.has(c.id) || this.dropped.has(c.id)) return;
    const cand: Cand = { ...c, held: 0, learned: false };
    if (!this.nonTrivial(cand, this.leavesNow)) return;
    // the snapshot that creates a candidate counts as its first one when one of its fields changed
    cand.held = this.involved(c.watch, this.changedNow) ? 1 : 0;
    cand.learned = cand.held >= LEARN_AFTER;
    this.cands.set(c.id, cand);
  }

  /** Create candidates that hold non-trivially on these leaves. */
  private propose(L: Map<string, Leaf>): void {
    const numeric: [string, number][] = [];
    const scalar: [string, Leaf][] = [];
    const arrays: [string, unknown[]][] = [];
    for (const [p, l] of L) {
      if (dynamicPath(p)) continue;
      if (l.kind === "number" && Number.isFinite(l.value as number)) {
        if (numeric.length < MAX_NUMERIC) numeric.push([p, l.value as number]);
      }
      if ((l.kind === "number" || l.kind === "string") && scalar.length < MAX_SCALAR) scalar.push([p, l]);
      if (l.kind === "array" && arrays.length < MAX_ARRAYS) arrays.push([p, l.value as unknown[]]);
      // per-field templates
      if (l.kind !== "null" && l.kind !== "undefined") {
        this.add({ id: `type:${p}`, tpl: "type", text: `typeof ${p} stable`, a: p, watch: [p], typeKind: l.kind });
        this.add({ id: `nonnull:${p}`, tpl: "nonnull", text: `${p} != null`, a: p, watch: [p] });
      }
      if (l.kind === "number" && (l.value as number) > 0) this.add({ id: `nonneg:${p}`, tpl: "nonneg", text: `${p} >= 0`, a: p, watch: [p] });
    }
    // a == b (non-trivial: equal, non-zero / non-empty values)
    for (let i = 0; i < scalar.length; i++)
      for (let j = i + 1; j < scalar.length; j++) {
        const [pa, la] = scalar[i];
        const [pb, lb] = scalar[j];
        if (la.kind !== lb.kind || la.value === 0 || la.value === "") continue;
        const same = la.kind === "number" ? numEq(la.value as number, lb.value as number) : la.value === lb.value;
        if (same) this.add({ id: `eq:${pa}:${pb}`, tpl: "eq", text: `${pa} == ${pb}`, a: pa, b: pb, watch: [pa, pb] });
      }
    for (const [B, arr] of arrays) {
      if (!arr.length) continue;
      const objs = arr.filter(isPlainObject) as Record<string, unknown>[];
      const keys = objs.length === arr.length ? Object.keys(objs[0]).slice(0, 32) : [];
      const numCols = keys.filter((k) => objs.every((o) => typeof o[k] === "number")).slice(0, MAX_COLUMNS);
      const scalarCols = keys.filter((k) => objs.every((o) => typeof o[k] === "number" || typeof o[k] === "string")).slice(0, MAX_COLUMNS);
      for (const [a, av] of numeric) {
        if (av === 0) continue;
        if (av === arr.length) this.add({ id: `len:${a}:${B}`, tpl: "len", text: `${a} == len(${B})`, a, B, watch: [a, B] });
        for (const f of numCols) {
          const s = objs.reduce((x, o) => x + (o[f] as number), 0);
          if (numEq(av, s)) this.add({ id: `sum:${a}:${B}:${f}`, tpl: "sum", text: `${a} == sum(${B}[*].${f})`, a, B, f, watch: [a, B] });
          for (const g of numCols) {
            if (g <= f) continue;
            const sp = objs.reduce((x, o) => x + (o[f] as number) * (o[g] as number), 0);
            if (numEq(av, sp)) this.add({ id: `sumprod:${a}:${B}:${f}:${g}`, tpl: "sumprod", text: `${a} == sum(${B}[*].${f} * ${B}[*].${g})`, a, B, f, g, watch: [a, B] });
          }
        }
      }
      for (const k of scalarCols) {
        const col = objs.map((o) => o[k]);
        if (arr.length >= 2 && new Set(col).size === col.length) this.add({ id: `unique:${B}:${k}`, tpl: "unique", text: `${B}[*].${k} unique`, B, f: k, watch: [B] });
        for (const [a, l] of scalar) {
          if (a.startsWith(B + ".") || l.value === "" || l.value === 0) continue;
          if (col.some((v) => v === l.value)) this.add({ id: `in:${a}:${B}:${k}`, tpl: "in", text: `${a} ∈ ${B}[*].${k}`, a, B, f: k, watch: [a, B] });
        }
      }
    }
  }

  /** A settled point. Returns the learned invariants (and developer expectations) violated now. */
  observe(L: Map<string, Leaf>, _now: number): { violations: Violation[] } {
    this.points++;
    const changed = this.changed;
    this.changed = new Set();
    const violations: Violation[] = [];
    for (const c of [...this.cands.values()]) {
      const h = this.holds(c, L);
      if (h === null) continue;
      const involved = this.involved(c.watch, changed);
      if (c.learned) {
        if (h) {
          if (involved) c.held++;
        } else violations.push({ id: c.id, text: c.text, fields: fieldsOf(c), values: this.valuesText(c, L), held: c.held });
      } else if (!h) {
        this.cands.delete(c.id);
        this.dropped.add(c.id);
      } else if (involved && this.nonTrivial(c, L)) {
        c.held++;
        if (c.held >= LEARN_AFTER) c.learned = true;
      }
    }
    this.changedNow = changed;
    this.leavesNow = L;
    this.propose(L);
    this.changedNow = new Set();
    this.leavesNow = new Map();
    for (const e of this.expects.values()) {
      let ok = true;
      try {
        ok = !!e.pred();
      } catch {
        ok = false;
      }
      if (!ok) violations.push({ id: `expect:${e.name}`, text: e.name, fields: [], values: "the predicate returned false", held: 0, developer: true });
    }
    this.violated = violations;
    return { violations };
  }

  /** Learned invariants touching `paths` that would be violated on hypothetical leaves. */
  preview(L: Map<string, Leaf>, paths: string[]): Violation[] {
    const out: Violation[] = [];
    for (const c of this.cands.values()) {
      if (!c.learned) continue;
      if (!c.watch.some((w) => paths.some((p) => p === w || p.startsWith(w + ".") || w.startsWith(p + ".")))) continue;
      if (this.holds(c, L) === false) out.push({ id: c.id, text: c.text, fields: fieldsOf(c), values: this.valuesText(c, L), held: c.held });
    }
    return out;
  }
}

function fieldsOf(c: Cand): string[] {
  const out: string[] = [];
  if (c.a) out.push(c.a);
  if (c.b) out.push(c.b);
  if (c.B) out.push(c.B);
  return out;
}
