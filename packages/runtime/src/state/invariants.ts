// Invariant miner (CONTRACT §4): generic templates over flattened fields of all stores, learned online at
// settled points. A candidate is created when it holds non-trivially, becomes learned after holding at >= 3
// settled snapshots where one of its fields changed, and is dropped for good if violated while learning.
// Learned invariants that break at a settled point are reported (once per episode by the runtime).
// No domain knowledge: the templates apply to whatever fields exist. Fields under id-like keys (dynamic
// collections) are skipped, and a candidate whose field disappeared is not evaluated.
//
// Precision: `a != null` is only proposed for fields never seen null (initial value included) and needs 6
// supporting snapshots (closing a selection is not an inconsistency). Per-array statistics (column sums, products,
// value sets, group counts) are computed once per array version, so settled points stay cheap with large stores.
//
// Relation quality (situation v2, SIM's F8): `a == b` only between fields whose names share a meaningful word, never
// between version counters / offsets (batch 8; batch 5 allowed unrelated names after 3 distinct values); `a ∈ B[*].k` with numbers needs an id column (`selectedId ∈ items[*].id`), never
// `tally.approved ∈ items[*].days`. New template: count by group, `a == count(B[*].k == v)` (a badge or a per-lane
// counter), proposed when the names relate or learned over 3 distinct counts.
//
// Precision (batch 8, REAL's 158 apps):
//   - selections: `a ∈ B[*].k`, and `a == b` where a field is an id/selection, are vacuous while the selection is a
//     sentinel (0, -1 or any negative number, "", null): nothing is selected;
//   - `B[*].k unique` only for the row's own id column (id, _id, uuid, key, slug) with ≥ 3 rows, or columns whose
//     values are all id-shaped (uuids, long hex, slugs) with ≥ 5 rows; never foreign keys (`partId`);
//   - envelope metadata (page, offset, limit, cursor, next/prev, hasMore, ...; and total/count next to them) never
//     enters a relation; `a == b` needs related names (a shared meaningful word); aggregates (`a == len(B)`,
//     sums) need an aggregate-like name for `a` (count, total, sum, size, amount, ...) or a word shared with B/f;
//     membership `a ∈ B[*].k` only for a selection field (selected/active/current/...) into the list's own id column
//     (id, _id, uuid, key, slug); sums never over id or version columns; count by group only for a counter named
//     after the group (`counts.done`, `doneCount`);
//   - busy scalar counters (numbers that change on nearly every write of their store) only enter derived relations
//     (len, sum, sum of products, count by group), never equality or membership;
//   - the runtime skips stores the user wrote within the last second (typing bursts): neither checked nor learned.

import type { Violation } from "../situation/env.js";
import { describe, fmtNum, isIdSegment, isPlainObject, type Redactor } from "../util.js";
import type { Leaf } from "./fields.js";

export const LEARN_AFTER = 3;
export const LEARN_AFTER_NONNULL = 6;
const MAX_NUMERIC = 64;
const MAX_SCALAR = 96;
const MAX_ARRAYS = 24;
const MAX_COLUMNS = 8;
const MAX_CANDIDATES = 4000;
const MAX_DROPPED = 50_000;

type Tpl = "eq" | "len" | "sum" | "sumprod" | "nonneg" | "in" | "unique" | "type" | "nonnull" | "count";

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
  /** count: the group value. */
  v?: string | number | boolean;
  /** Distinct values of `a` it held over (weakly supported relations need `minDistinct` of them). */
  vals?: Set<string>;
  minDistinct?: number;
}

const TOTAL_WORDS = new Set(["total", "count"]);
const SENTINEL = (v: unknown): boolean => v === null || v === undefined || v === "" || (typeof v === "number" && v <= 0);

const GENERIC_WORDS = new Set(["value", "values", "data", "n", "num", "number", "state", "current", "item", "items", "list", "the", "of", "is", "has"]);
const VERSION_WORDS = /^(version|versions|revision|rev|seq|sequence|offset|page|cursor|index|idx|tick|epoch|generation|nonce|timestamp|ts|time|updated|created|at|ms)$/;
const ID_COLUMN = /^(id|_id|uuid|key|slug|code)$|(Id|_id|ID)$/;

function nameWords(path: string): string[] {
  const last = path.split(".").pop() ?? path;
  return last
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase().replace(/(ies)$/, "y").replace(/s$/, ""));
}

/** Whether two field names (last segments) share a meaningful word ("cart.total" / "summary.total"). */
function relatedNames(a: string, b: string): boolean {
  const A = new Set(nameWords(a).filter((w) => !GENERIC_WORDS.has(w)));
  return nameWords(b).some((w) => !GENERIC_WORDS.has(w) && A.has(w));
}

function versionLike(path: string): boolean {
  return nameWords(path).some((w) => VERSION_WORDS.test(w));
}

const AGGREGATE_WORDS = new Set(["count", "total", "sum", "length", "len", "size", "num", "number", "amount", "balance", "subtotal", "quantity", "qty", "tally"]);

/**
 * Whether `a` can name an aggregate of list B (column f): an aggregate word (count, total, sum, size, amount, ...),
 * or a word shared with the list or the column (`cartItems` / `items`). `ill.active == len(ill.hits)` is a coincidence.
 */
function aggregateName(a: string, B: string, f?: string): boolean {
  const ws = rawWords(a).map((w) => w.replace(/(ies)$/, "y").replace(/s$/, ""));
  if (ws.some((w) => AGGREGATE_WORDS.has(w)) || /^n[A-Z]/.test(a.split(".").pop() ?? "")) return true;
  return relatedNames(a, B) || (f !== undefined && relatedNames(a, f));
}

const SELECTION_WORDS = new Set(["selected", "selection", "active", "current", "focused", "focus", "chosen", "picked", "highlighted", "editing", "open", "opened"]);
const PRIMARY_ID = /^(id|_id|uuid|key|slug)$/;

/** A selection: the field (or its parent) is named selected / active / current / focused / ... (`ui.selectedId`, `crm.current`). */
function selectionName(path: string): boolean {
  const segs = path.split(".");
  const ws = [...rawWords(segs[segs.length - 1] ?? ""), ...(segs.length > 2 ? rawWords(segs[segs.length - 2]) : [])];
  return ws.some((w) => SELECTION_WORDS.has(w));
}

/** `counts.done == count(status == "done")`: the field's own words (minus count/total/...) are the group value's words. */
function groupName(a: string, value: string): boolean {
  const own = rawWords(a).filter((w) => !AGGREGATE_WORDS.has(w) && !GENERIC_WORDS.has(w));
  const want = rawWords(value);
  return own.length > 0 && own.length === want.length && own.every((w, i) => w === want[i]);
}

/** The field names a selection or an id (`selectedId`, `activeKey`, `current.id`). */
function idLike(path: string): boolean {
  const last = path.split(".").pop() ?? path;
  return ID_COLUMN.test(last) || nameWords(path).some((w) => w === "selected" || w === "active" || w === "current");
}

function rawWords(path: string): string[] {
  const last = path.split(".").pop() ?? path;
  return last
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Pagination metadata by name: page, offset, limit, cursor, pageSize, perPage, hasMore, next, ... */
function paginationName(path: string): boolean {
  const ws = rawWords(path);
  if (ws.some((w) => w === "page" || w === "pages" || w === "offset" || w === "limit" || w === "cursor" || w === "pager" || w === "pagination" || w === "skip" || w === "take")) return true;
  const joined = ws.join(" ");
  return /^(has more|has next|next|prev|previous|per page)$/.test(joined) || /\b(has more|next cursor|per page|page size)\b/.test(joined);
}

/** A total/count field next to pagination metadata (a response envelope's total, not this page's size). */
function envelopeField(path: string, L: Map<string, Leaf>, cache: Map<string, boolean>): boolean {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  let r = paginationName(path);
  if (!r && rawWords(path).some((w) => TOTAL_WORDS.has(w) || /count$|total$/.test(w))) {
    const parent = path.slice(0, path.lastIndexOf("."));
    for (const p of L.keys()) {
      if (p !== path && p.startsWith(parent + ".") && p.indexOf(".", parent.length + 1) < 0 && paginationName(p)) {
        r = true;
        break;
      }
    }
  }
  cache.set(path, r);
  return r;
}

/** Id-shaped string values (uuids, long hex, slug ids): evidence that a column identifies rows. */
function idShaped(v: unknown): boolean {
  return typeof v === "string" && isIdSegment(v);
}

interface Expectation {
  name: string;
  pred: () => boolean;
}

/** Statistics of one array version (cached per leaf object; unchanged arrays reuse their leaf). */
interface ArrayStats {
  n: number;
  /** Every element is a plain object. */
  objs: boolean;
  numCols: string[];
  scalarCols: string[];
  sums: Map<string, number>;
  prods: Map<string, number>;
  sets: Map<string, Set<unknown>>;
  unique: Map<string, boolean>;
  /** Group counts per column: value -> number of items. */
  groups: Map<string, Map<unknown, number>>;
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

export class InvariantMiner {
  private cands = new Map<string, Cand>();
  private dropped = new Set<string>();
  private changed = new Set<string>();
  private expects = new Map<string, Expectation>();
  private violated: Violation[] = [];
  private nullSeen = new Set<string>();
  private statsCache = new WeakMap<Leaf, ArrayStats>();
  private changedNow = new Set<string>();
  private leavesNow: Map<string, Leaf> = new Map();
  /** Settled points observed. */
  points = 0;

  /** Envelope-metadata cache for the leaves being proposed on (reset per settled point). */
  private envCache = new Map<string, boolean>();

  constructor(
    private readonly redact: () => Redactor = () => (_p, v) => v,
    /** Busy scalar counters (numbers that change on nearly every write of their store). */
    private readonly busy: (path: string) => boolean = () => false,
  ) {}

  private envelope(p: string, L: Map<string, Leaf>): boolean {
    return envelopeField(p, L, this.envCache);
  }

  /** A field explicitly derived from a list: the left side of a learned len / sum / sum-of-products / count relation. */
  derived(path: string): boolean {
    for (const c of this.cands.values()) if (c.learned && c.a === path && (c.tpl === "len" || c.tpl === "sum" || c.tpl === "sumprod" || c.tpl === "count")) return true;
    return false;
  }

  /** A busy scalar counter that is not explicitly derived: kept out of equality, membership and transition shapes. */
  busyCounter(path: string): boolean {
    return this.busy(path) && !this.derived(path);
  }

  noteChanged(paths: string[]): void {
    for (const p of paths) this.changed.add(p);
  }

  /** Record fields that hold null/undefined (at registration and on every write): they never get `a != null`. */
  noteValues(leaves: Iterable<[string, Leaf | undefined]>): void {
    for (const [p, l] of leaves) {
      if (!l || l.value === null || l.value === undefined) {
        this.nullSeen.add(p);
        const c = this.cands.get(`nonnull:${p}`);
        if (c && !c.learned) this.drop(c.id);
      }
    }
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

  private drop(id: string): void {
    this.cands.delete(id);
    if (this.dropped.size >= MAX_DROPPED) this.dropped.clear();
    this.dropped.add(id);
  }

  private stats(l: Leaf): ArrayStats | null {
    if (l.kind !== "array" || !Array.isArray(l.value)) return null;
    let st = this.statsCache.get(l);
    if (st) return st;
    const arr = l.value as unknown[];
    const objs = arr.length > 0 && arr.every((x) => isPlainObject(x));
    let numCols: string[] = [];
    let scalarCols: string[] = [];
    const sums = new Map<string, number>();
    if (objs) {
      const os = arr as Record<string, unknown>[];
      const keys = Object.keys(os[0]).slice(0, 32);
      numCols = keys.filter((k) => os.every((o) => typeof o[k] === "number")).slice(0, MAX_COLUMNS);
      scalarCols = keys.filter((k) => os.every((o) => typeof o[k] === "number" || typeof o[k] === "string")).slice(0, MAX_COLUMNS);
      for (const k of numCols) {
        let s = 0;
        for (const o of os) s += o[k] as number;
        sums.set(k, s);
      }
    }
    st = { n: arr.length, objs, numCols, scalarCols, sums, prods: new Map(), sets: new Map(), unique: new Map(), groups: new Map() };
    this.statsCache.set(l, st);
    return st;
  }

  private prod(l: Leaf, st: ArrayStats, f: string, g: string): number {
    const key = `${f}*${g}`;
    let v = st.prods.get(key);
    if (v === undefined) {
      v = 0;
      for (const o of l.value as Record<string, unknown>[]) v += (o[f] as number) * (o[g] as number);
      st.prods.set(key, v);
    }
    return v;
  }

  private colSet(l: Leaf, st: ArrayStats, k: string): Set<unknown> {
    let s = st.sets.get(k);
    if (!s) {
      s = new Set();
      for (const o of l.value as unknown[]) if (isPlainObject(o)) s.add(o[k]);
      st.sets.set(k, s);
    }
    return s;
  }

  /** Items per value of a string/boolean column (null when the column has more than 8 values). */
  private colGroups(l: Leaf, st: ArrayStats, k: string): Map<unknown, number> | null {
    let g = st.groups.get(k);
    if (!g) {
      g = new Map();
      for (const o of l.value as unknown[]) {
        const v = isPlainObject(o) ? o[k] : undefined;
        if (typeof v !== "string" && typeof v !== "boolean") continue;
        g.set(v, (g.get(v) ?? 0) + 1);
      }
      st.groups.set(k, g);
    }
    return g.size > 0 && g.size <= 8 ? g : null;
  }

  private colUnique(l: Leaf, st: ArrayStats, k: string): boolean {
    let u = st.unique.get(k);
    if (u === undefined) {
      const seen = new Set<unknown>();
      u = true;
      for (const o of l.value as unknown[]) {
        const v = isPlainObject(o) ? o[k] : undefined;
        if (v === undefined || v === null) continue;
        if (seen.has(v)) {
          u = false;
          break;
        }
        seen.add(v);
      }
      st.unique.set(k, u);
    }
    return u;
  }

  /** Evaluate a candidate on leaves: true / false / null (not applicable: a field is missing). */
  private holds(c: Cand, L: Map<string, Leaf>): boolean | null {
    const val = (p: string | undefined) => (p === undefined ? undefined : L.get(p));
    switch (c.tpl) {
      case "eq": {
        const a = val(c.a);
        const b = val(c.b);
        if (!a || !b) return null;
        // a selection/id field holding a sentinel: nothing is selected, the relation says nothing
        if ((idLike(c.a!) || idLike(c.b!)) && (SENTINEL(a.value) || SENTINEL(b.value))) return null;
        if (typeof a.value === "number" && typeof b.value === "number") return numEq(a.value, b.value);
        return a.value === b.value;
      }
      case "len": {
        const a = val(c.a);
        const B = val(c.B);
        if (!a || !B || B.kind !== "array" || typeof a.value !== "number") return null;
        return a.value === B.len;
      }
      case "sum":
      case "sumprod": {
        const a = val(c.a);
        const B = val(c.B);
        if (!a || !B || B.kind !== "array" || typeof a.value !== "number") return null;
        if (B.len === 0) return numEq(a.value, 0);
        const st = this.stats(B);
        if (!st || !st.objs || !st.numCols.includes(c.f!) || (c.tpl === "sumprod" && !st.numCols.includes(c.g!))) return false;
        const s = c.tpl === "sum" ? st.sums.get(c.f!)! : this.prod(B, st, c.f!, c.g!);
        return numEq(a.value, s);
      }
      case "nonneg": {
        const a = val(c.a);
        if (!a) return null;
        if (a.value === null || a.value === undefined) return null;
        if (idLike(c.a!) && SENTINEL(a.value)) return null; // -1: nothing selected
        return typeof a.value === "number" && a.value >= 0;
      }
      case "in": {
        const a = val(c.a);
        const B = val(c.B);
        if (!a || !B || B.kind !== "array") return null;
        if (SENTINEL(a.value)) return null; // nothing selected (0, -1, "", null)
        const st = this.stats(B);
        if (!st || !st.objs) return false;
        return this.colSet(B, st, c.f!).has(a.value);
      }
      case "count": {
        const a = val(c.a);
        const B = val(c.B);
        if (!a || !B || B.kind !== "array" || typeof a.value !== "number") return null;
        let n = 0;
        for (const o of B.value as unknown[]) if (isPlainObject(o) && o[c.f!] === c.v) n++;
        return a.value === n;
      }
      case "unique": {
        const B = val(c.B);
        if (!B || B.kind !== "array") return null;
        const st = this.stats(B);
        if (!st || !st.objs) return true;
        return this.colUnique(B, st, c.f!);
      }
      case "type": {
        const a = val(c.a);
        if (!a) return null;
        if (a.kind === "null" || a.kind === "undefined") return null;
        if (idLike(c.a!) && SENTINEL(a.value)) return null; // a cleared selection ("" for a numeric id)
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
    const n = B && B.kind === "array" ? B.len : 0;
    switch (c.tpl) {
      case "eq":
        return !!a && a.value !== 0 && a.value !== "" && a.value !== false;
      case "len":
        return n > 0;
      case "sum":
      case "sumprod":
        return n > 0 && !!a && a.value !== 0;
      case "in":
        return n >= 2;
      case "unique":
        return this.uniqueEvidence(c.f!, B);
      case "count":
        return n >= 2 && !!a && typeof a.value === "number" && a.value > 0;
      case "nonneg":
        return !!a && typeof a.value === "number" && a.value > 0;
      default:
        return true;
    }
  }

  /**
   * Enough evidence that a column identifies rows: the row's own id column (id, _id, uuid, key, slug) with ≥ 3 rows,
   * or id-shaped values with ≥ 5 rows. Foreign keys (`partId`, `user_id`) repeat across rows: never.
   */
  private uniqueEvidence(k: string, B: Leaf | undefined): boolean {
    if (!B || B.kind !== "array" || !Array.isArray(B.value)) return false;
    const n = B.len;
    if (PRIMARY_ID.test(k)) return n >= 3;
    if (ID_COLUMN.test(k) || n < 5) return false;
    for (const o of B.value as unknown[]) if (!isPlainObject(o) || !idShaped(o[k])) return false;
    return true;
  }

  private valuesText(c: Cand, L: Map<string, Leaf>): string {
    const redact = this.redact();
    const show = (p: string | undefined) => {
      const l = p ? L.get(p) : undefined;
      return l ? describe(l.value, p!, redact, 40) : "missing";
    };
    switch (c.tpl) {
      case "eq":
        return `${c.a} = ${show(c.a)}, ${c.b} = ${show(c.b)}`;
      case "len": {
        const B = L.get(c.B!);
        return `${c.a} = ${show(c.a)}, len(${c.B}) = ${B && B.kind === "array" ? B.len : "?"}`;
      }
      case "sum":
      case "sumprod": {
        const B = L.get(c.B!);
        let s = 0;
        if (B && Array.isArray(B.value))
          for (const x of B.value) if (isPlainObject(x)) s += (Number(x[c.f!]) || 0) * (c.tpl === "sumprod" ? Number(x[c.g!]) || 0 : 1);
        const expr = c.tpl === "sum" ? `sum(${c.B}[*].${c.f})` : `sum(${c.B}[*].${c.f} * ${c.B}[*].${c.g})`;
        const r = redact(`${c.B}.${c.f}`, s);
        return `${c.a} = ${show(c.a)}, ${expr} = ${r !== s ? String(r) : fmtNum(s)}`;
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
      case "count": {
        const B = L.get(c.B!);
        let n = 0;
        if (B && Array.isArray(B.value)) for (const o of B.value) if (isPlainObject(o) && o[c.f!] === c.v) n++;
        return `${c.a} = ${show(c.a)}, count(${c.B}[*].${c.f} == ${JSON.stringify(c.v)}) = ${n}`;
      }
      case "unique":
        return `${c.B}[*].${c.f} has duplicates`;
    }
  }

  private involved(watch: string[], changed: Set<string>): boolean {
    for (const p of watch) {
      if (changed.has(p)) return true;
      for (const x of changed) if (x.startsWith(p + ".")) return true;
    }
    return false;
  }

  private add(c: Omit<Cand, "held" | "learned">): void {
    if (this.cands.size >= MAX_CANDIDATES || this.cands.has(c.id) || this.dropped.has(c.id)) return;
    const cand: Cand = { ...c, held: 0, learned: false };
    if (!this.nonTrivial(cand, this.leavesNow)) return;
    // the snapshot that creates a candidate counts as its first one when one of its fields changed
    cand.held = this.involved(c.watch, this.changedNow) ? 1 : 0;
    if (cand.minDistinct && cand.held) this.noteDistinct(cand, this.leavesNow);
    cand.learned = this.supported(cand);
    this.cands.set(c.id, cand);
  }

  private noteDistinct(c: Cand, L: Map<string, Leaf>): void {
    const a = c.a ? L.get(c.a) : undefined;
    if (!a) return;
    (c.vals ??= new Set()).add(a.hash);
  }

  private supported(c: Cand): boolean {
    return c.held >= this.need(c) && (!c.minDistinct || (c.vals?.size ?? 0) >= c.minDistinct);
  }

  private need(c: Cand): number {
    return c.tpl === "nonnull" ? LEARN_AFTER_NONNULL : LEARN_AFTER;
  }

  /** Create candidates that hold non-trivially on these leaves. */
  private propose(L: Map<string, Leaf>): void {
    const numeric: [string, number][] = [];
    const scalar: [string, Leaf][] = [];
    const arrays: [string, Leaf][] = [];
    this.envCache = new Map();
    for (const [p, l] of L) {
      if (dynamicPath(p)) continue;
      const env = (l.kind === "number" || l.kind === "string") && this.envelope(p, L);
      // envelope metadata never enters a relation; busy counters only enter derived ones (len, sum, count by group)
      if (l.kind === "number" && Number.isFinite(l.value as number) && !env) {
        if (numeric.length < MAX_NUMERIC) numeric.push([p, l.value as number]);
      }
      if ((l.kind === "number" || l.kind === "string") && !env && !this.busyCounter(p) && scalar.length < MAX_SCALAR) scalar.push([p, l]);
      if (l.kind === "array" && arrays.length < MAX_ARRAYS) arrays.push([p, l]);
      // per-field templates
      if (l.kind !== "null" && l.kind !== "undefined") {
        this.add({ id: `type:${p}`, tpl: "type", text: `typeof ${p} stable`, a: p, watch: [p], typeKind: l.kind });
        // selections are cleared to null when nothing is selected: never `!= null`
        if (!this.nullSeen.has(p) && !idLike(p)) this.add({ id: `nonnull:${p}`, tpl: "nonnull", text: `${p} != null`, a: p, watch: [p] });
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
        if (!same) continue;
        // equality needs semantically compatible names (a shared meaningful word), never version counters
        if (!relatedNames(pa, pb) || versionLike(pa) || versionLike(pb)) continue;
        if ((idLike(pa) || idLike(pb)) && SENTINEL(la.value)) continue;
        this.add({ id: `eq:${pa}:${pb}`, tpl: "eq", text: `${pa} == ${pb}`, a: pa, b: pb, watch: [pa, pb] });
      }
    for (const [B, leaf] of arrays) {
      if (!leaf.len) continue;
      const st = this.stats(leaf);
      if (!st) continue;
      for (const [a, av] of numeric) {
        if (av === 0) continue;
        // aggregates need a compatible name: a count/total/sum-like word, or a word shared with the list or column
        if (av === leaf.len && aggregateName(a, B)) this.add({ id: `len:${a}:${B}`, tpl: "len", text: `${a} == len(${B})`, a, B, watch: [a, B] });
        if (!st.objs) continue;
        for (const f of st.numCols) {
          if (ID_COLUMN.test(f) || versionLike(f)) continue; // ids and versions are never summed
          if (numEq(av, st.sums.get(f)!) && aggregateName(a, B, f)) this.add({ id: `sum:${a}:${B}:${f}`, tpl: "sum", text: `${a} == sum(${B}[*].${f})`, a, B, f, watch: [a, B] });
          for (const g of st.numCols) {
            if (g <= f || ID_COLUMN.test(g) || versionLike(g)) continue;
            if (numEq(av, this.prod(leaf, st, f, g)) && aggregateName(a, B)) this.add({ id: `sumprod:${a}:${B}:${f}:${g}`, tpl: "sumprod", text: `${a} == sum(${B}[*].${f} * ${B}[*].${g})`, a, B, f, g, watch: [a, B] });
          }
        }
      }
      if (!st.objs) continue;
      for (const k of st.scalarCols) {
        if (this.uniqueEvidence(k, leaf) && this.colUnique(leaf, st, k)) this.add({ id: `unique:${B}:${k}`, tpl: "unique", text: `${B}[*].${k} unique`, B, f: k, watch: [B] });
        const set = this.colSet(leaf, st, k);
        for (const [a, l] of scalar) {
          if (a.startsWith(B + ".") || SENTINEL(l.value)) continue;
          // membership: a selection must name an existing row, so only a selection field (selected/active/current/...)
          // in the list's own id column. A value matching another column (a filter equal to a kind, a title in a list
          // of titles, an id from another entity or a foreign key) is a coincidence.
          if (!PRIMARY_ID.test(k) || !selectionName(a) || versionLike(a)) continue;
          if (set.has(l.value)) this.add({ id: `in:${a}:${B}:${k}`, tpl: "in", text: `${a} ∈ ${B}[*].${k}`, a, B, f: k, watch: [a, B] });
        }
      }
      // count by group: a number equal to the items of one group of a string/boolean column
      for (const k of Object.keys((leaf.value as Record<string, unknown>[])[0] ?? {}).slice(0, MAX_COLUMNS)) {
        const groups = this.colGroups(leaf, st, k);
        if (!groups) continue;
        for (const [gv, n] of groups) {
          if (n < 1 || groups.size < 2) continue;
          for (const [a, av] of numeric) {
            if (av !== n || a.startsWith(B + ".") || versionLike(a)) continue;
            // the counter is named after the group (`counts.done`, `doneCount`, `perPerson.Lena`)
            if (typeof gv !== "string" || !groupName(a, gv)) continue;
            this.add({ id: `count:${a}:${B}:${k}:${String(gv)}`, tpl: "count", text: `${a} == count(${B}[*].${k} == ${JSON.stringify(gv)})`, a, B, f: k, v: gv, watch: [a, B] });
          }
        }
      }
    }
  }

  /** A settled point. Returns the learned invariants (and developer expectations) violated now. */
  /**
   * A settled point. Returns the learned invariants (and developer expectations) violated now. Candidates touching a
   * store in `skip` (the user wrote it within the last second: mid-typing) are neither checked nor learned this time
   * (their ids are in `skipped`); those stores' fields propose nothing new.
   */
  observe(L: Map<string, Leaf>, _now: number, skip?: Set<string>): { violations: Violation[]; skipped: Set<string> } {
    this.points++;
    const changed = this.changed;
    const skipped = new Set<string>();
    const touches = (c: Cand) => !!skip?.size && fieldsOf(c).some((f) => skip.has(f.split(".")[0]));
    // changes to skipped stores stay pending until those stores are checked
    this.changed = new Set();
    if (skip?.size) for (const p of changed) if (skip.has(p.split(".")[0])) this.changed.add(p);
    const violations: Violation[] = [];
    for (const c of [...this.cands.values()]) {
      if (touches(c)) {
        skipped.add(c.id);
        continue;
      }
      // equality and membership never hold on busy counters (only derived relations do)
      if ((c.tpl === "eq" || c.tpl === "in") && ((c.a && this.busyCounter(c.a)) || (c.b && this.busyCounter(c.b)))) {
        this.drop(c.id);
        continue;
      }
      const h = this.holds(c, L);
      if (h === null) continue;
      const involved = this.involved(c.watch, changed);
      if (c.learned) {
        if (h) {
          if (involved) c.held++;
        } else violations.push({ id: c.id, text: c.text, fields: fieldsOf(c), values: this.valuesText(c, L), held: c.held });
      } else if (!h) {
        this.drop(c.id);
      } else if (involved && this.nonTrivial(c, L)) {
        c.held++;
        if (c.minDistinct) this.noteDistinct(c, L);
        if (this.supported(c)) c.learned = true;
      }
    }
    this.changedNow = changed;
    let PL = L;
    if (skip?.size) {
      PL = new Map();
      for (const [p, l] of L) if (!skip.has(p.split(".")[0])) PL.set(p, l);
    }
    this.leavesNow = PL;
    this.propose(PL);
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
    return { violations, skipped };
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
