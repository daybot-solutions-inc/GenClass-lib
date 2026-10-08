// Flattening store values into dotted fields (CONTRACT §4: top-level-first paths, arrays are one field),
// change detection, change deltas (for "identical change" repetition facts), patches (re-applying a held value
// write on top of newer state) and change summaries.
//
// Flattening is incremental: given the previous leaves, unchanged arrays and keyed collections are recognised by
// element references (O(n) reference comparisons, no hashing) plus a sampled re-hash of a few elements that kept
// their reference (to catch in-place mutation of elements); only new or changed elements are hashed. Every
// element of an array counts, however long. Plain objects with more than 32 keys (entity maps such as `byId`) are
// one field ("collection"), like arrays, so big normalized stores stay a bounded number of fields.

import { describe, fnv1a, hashValue, isPlainObject, kindOf, plural, truncate, type Redactor } from "../util.js";

export const MAX_DEPTH = 4;
export const MAX_FIELDS_PER_STORE = 200;
/** Plain objects with more keys than this are one field (a keyed collection). */
export const MAX_KEYS_EXPAND = 32;
const SAMPLES = 8;
const ID_KEYS = ["id", "_id", "key", "uuid", "slug", "name", "title", "label"];

export interface Leaf {
  /** Primitives: the value. Arrays: a shallow copy of the elements. Collections: a shallow copy of the object. */
  value: unknown;
  hash: string;
  kind: string;
  /** Array length / collection size (-1 for others). */
  len: number;
  /** Arrays: per-element hashes. */
  elems?: string[];
  /** Collections: keys in order and per-key value hashes. */
  keys?: string[];
  khash?: Map<string, string>;
  /** Collections: the live object the leaf was computed from (same reference: cheap unchanged check). */
  src?: object;
}

function primHash(v: unknown): string {
  switch (typeof v) {
    case "string":
      return v.length <= 64 ? "s:" + v : `S:${fnv1a(v)}:${v.length}`;
    case "number":
      return "n:" + String(v);
    case "boolean":
      return v ? "b:1" : "b:0";
    case "undefined":
      return "u";
    case "bigint":
      return "i:" + String(v);
    case "symbol":
      return "y:" + String(v);
    case "function":
      return "f";
  }
  return v === null ? "null" : "o:" + hashValue(v);
}

function valueHash(v: unknown): string {
  return v !== null && typeof v === "object" ? "o:" + hashValue(v) : primHash(v);
}

function samplePositions(n: number): number[] {
  if (n <= SAMPLES) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>([0, n - 1]);
  for (let j = 1; out.size < SAMPLES && j < SAMPLES; j++) out.add(Math.floor((j * n) / SAMPLES));
  return [...out];
}

const isObj = (x: unknown): x is object => x !== null && typeof x === "object";

/** An array leaf, reusing the previous leaf's element hashes for elements whose reference is unchanged. */
/** True when a few elements that kept their reference still hash the same (no in-place mutation seen). */
function sampleClean(get: (i: number) => unknown, old: (i: number) => unknown, hash: (i: number) => string | undefined, n: number): boolean {
  for (const i of samplePositions(n)) {
    const el = get(i);
    if (isObj(el) && old(i) === el && valueHash(el) !== hash(i)) return false;
  }
  return true;
}

function arrayLeaf(arr: unknown[], prev: Leaf | undefined): Leaf {
  const n = arr.length;
  const p = prev && prev.kind === "array" && prev.elems && Array.isArray(prev.value) ? prev : undefined;
  const refs = p ? (p.value as unknown[]) : undefined;
  // fast path: same length, every element the same reference, sampled elements unchanged -> the previous leaf
  if (p && refs!.length === n) {
    let same = true;
    for (let i = 0; i < n; i++)
      if (refs![i] !== arr[i]) {
        same = false;
        break;
      }
    if (same && sampleClean((i) => arr[i], (i) => refs![i], (i) => p.elems![i], n)) return p;
  }
  const elems: string[] = new Array(n);
  let same = !!p && refs!.length === n;
  let byRef: Map<unknown, string> | null = null;
  for (let i = 0; i < n; i++) {
    const el = arr[i];
    if (refs && i < refs.length && refs[i] === el) {
      elems[i] = p!.elems![i];
      continue;
    }
    same = false;
    if (refs && isObj(el)) {
      if (!byRef) {
        byRef = new Map();
        refs.forEach((r, j) => {
          if (isObj(r)) byRef!.set(r, p!.elems![j]);
        });
      }
      const h = byRef.get(el);
      if (h !== undefined) {
        elems[i] = h;
        continue;
      }
    }
    elems[i] = valueHash(el);
  }
  // elements that kept their reference may have been mutated in place: re-check a few of them
  if (refs && n > 0) {
    for (const i of samplePositions(n)) {
      const el = arr[i];
      if (isObj(el) && i < refs.length && refs[i] === el && valueHash(el) !== elems[i]) {
        for (let j = 0; j < n; j++) if (isObj(arr[j])) elems[j] = valueHash(arr[j]);
        same = false;
        break;
      }
    }
  }
  if (same && p) return p;
  return { value: arr.slice(), hash: fnv1a(`a${n}|${elems.join(",")}`), kind: "array", len: n, elems };
}

/** A keyed-collection (or empty object) leaf, reusing per-key hashes for values whose reference is unchanged. */
function objectLeaf(obj: Record<string, unknown>, prev: Leaf | undefined): Leaf {
  const keys = Object.keys(obj);
  const p = prev && prev.kind === "object" && prev.khash && isPlainObject(prev.value) ? prev : undefined;
  const old = p ? (p.value as Record<string, unknown>) : undefined;
  // fastest path: the very same object as last time, same key count and last key, sampled values unchanged
  if (p && old && obj === p.src && p.keys!.length === keys.length && keys[keys.length - 1] === p.keys![keys.length - 1]) {
    const pk = p.keys!;
    const n = keys.length;
    let same = true;
    for (const i of samplePositions(n)) {
      if (keys[i] !== pk[i] || old[keys[i]] !== obj[keys[i]]) {
        same = false;
        break;
      }
    }
    if (same && sampleClean((i) => obj[keys[i]], (i) => old[keys[i]], (i) => p.khash!.get(keys[i]), n)) return p;
  }
  // fast path: same keys in the same order, every value the same reference, sampled values unchanged
  if (p && old && p.keys!.length === keys.length) {
    let same = true;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (p.keys![i] !== k || old[k] !== obj[k]) {
        same = false;
        break;
      }
    }
    if (same && sampleClean((i) => obj[keys[i]], (i) => old[keys[i]], (i) => p.khash!.get(keys[i]), keys.length)) return p.src === obj ? p : { ...p, src: obj };
  }
  const khash = new Map<string, string>();
  let same = !!p && p.keys!.length === keys.length;
  keys.forEach((k, i) => {
    const v = obj[k];
    if (old && Object.prototype.hasOwnProperty.call(old, k) && old[k] === v) {
      khash.set(k, p!.khash!.get(k)!);
      if (same && p!.keys![i] !== k) same = false;
    } else {
      khash.set(k, valueHash(v));
      same = false;
    }
  });
  if (old && keys.length) {
    const ks = samplePositions(keys.length).map((i) => keys[i]);
    for (const k of ks) {
      const v = obj[k];
      if (isObj(v) && old[k] === v && valueHash(v) !== khash.get(k)) {
        for (const kk of keys) if (isObj(obj[kk])) khash.set(kk, valueHash(obj[kk]));
        same = false;
        break;
      }
    }
  }
  if (same && p) return { ...p, src: obj };
  const hash = fnv1a(`c${keys.length}|${keys.map((k) => `${k}=${khash.get(k)}`).join(",")}`);
  return { value: { ...obj }, hash, kind: "object", len: keys.length, keys, khash, src: obj };
}

/** A leaf for any value (incremental when the previous leaf of the same path is given). */
export function leafOf(v: unknown, prev?: Leaf): Leaf {
  if (Array.isArray(v)) return arrayLeaf(v, prev);
  if (isPlainObject(v)) return objectLeaf(v, prev);
  if (isObj(v)) return { value: v, hash: "o:" + hashValue(v), kind: kindOf(v), len: -1 };
  return { value: v, hash: primHash(v), kind: kindOf(v), len: -1 };
}

/** Flatten a store value into path -> leaf. Paths start with the store name. */
export function flatten(store: string, value: unknown, prev?: Map<string, Leaf>): Map<string, Leaf> {
  const out = new Map<string, Leaf>();
  const walk = (v: unknown, path: string, depth: number) => {
    if (isPlainObject(v)) {
      const keys = Object.keys(v);
      if (keys.length > 0 && keys.length <= MAX_KEYS_EXPAND && depth < MAX_DEPTH && out.size + keys.length <= MAX_FIELDS_PER_STORE) {
        for (const k of keys) walk(v[k], `${path}.${k}`, depth + 1);
        return;
      }
      out.set(path, objectLeaf(v, prev?.get(path)));
      return;
    }
    out.set(path, leafOf(v, prev?.get(path)));
  };
  walk(value, store, 0);
  return out;
}

export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
  beforeLeaf: Leaf | undefined;
  afterLeaf: Leaf | undefined;
  /** Delta signature, e.g. "n:+1", "a:+h1,h2|-", "v:<hash>". */
  delta: string;
}

export function diffLeaves(before: Map<string, Leaf>, after: Map<string, Leaf>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const [path, a] of after) {
    const b = before.get(path);
    if (!b || b.hash !== a.hash) out.push(mkChange(path, b, a));
  }
  for (const [path, b] of before) {
    if (!after.has(path)) out.push(mkChange(path, b, undefined));
  }
  return out;
}

function mkChange(path: string, b: Leaf | undefined, a: Leaf | undefined): FieldChange {
  return { path, before: b?.value, after: a?.value, beforeLeaf: b, afterLeaf: a, delta: deltaOf(b, a) };
}

/** A delta signature that is equal for "the same change" applied again (same added items, same increment). */
export function deltaOf(b: Leaf | undefined, a: Leaf | undefined): string {
  if (!a) return "x:removed";
  if (b && a.kind === "number" && b.kind === "number") {
    const d = (a.value as number) - (b.value as number);
    return `n:${Number.isFinite(d) ? Number(d.toPrecision(12)) : String(d)}`;
  }
  if (b && a.kind === "array" && b.kind === "array" && a.elems && b.elems) {
    const { added, removed } = multisetDiff(b.elems, a.elems);
    if (added.length || removed.length) return `a:+${added.sort().join(",")}|-${removed.sort().join(",")}`;
    return `o:${a.hash}`;
  }
  if (b && a.kind === "object" && b.kind === "object" && a.khash && b.khash) {
    const parts: string[] = [];
    for (const [k, h] of a.khash) {
      const bh = b.khash.get(k);
      if (bh === undefined) parts.push(`+${k}=${h}`);
      else if (bh !== h) parts.push(`~${k}=${h}`);
    }
    for (const k of b.khash.keys()) if (!a.khash.has(k)) parts.push(`-${k}`);
    return `c:${parts.sort().join(",")}`;
  }
  return `v:${a.hash}`;
}

export function multisetDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const counts = new Map<string, number>();
  for (const h of before) counts.set(h, (counts.get(h) ?? 0) + 1);
  const added: string[] = [];
  for (const h of after) {
    const c = counts.get(h) ?? 0;
    if (c > 0) counts.set(h, c - 1);
    else added.push(h);
  }
  const removed: string[] = [];
  for (const [h, c] of counts) for (let i = 0; i < c; i++) removed.push(h);
  return { added, removed };
}

/** Elements of `after` that are not in `before` (by hash), in order. */
export function addedElements(before: Leaf | undefined, after: Leaf | undefined): unknown[] {
  if (!after || after.kind !== "array" || !after.elems) return [];
  const counts = new Map<string, number>();
  for (const h of before?.elems ?? []) counts.set(h, (counts.get(h) ?? 0) + 1);
  const out: unknown[] = [];
  const arr = after.value as unknown[];
  after.elems.forEach((h, i) => {
    const c = counts.get(h) ?? 0;
    if (c > 0) counts.set(h, c - 1);
    else out.push(arr[i]);
  });
  return out;
}

// --------------------------------------------------------------------------------------------- summaries

function idKey(o: Record<string, unknown>): string | undefined {
  return ID_KEYS.find((k) => k in o && (typeof o[k] === "string" || typeof o[k] === "number"));
}

/** `{id: 3, qty: 1 → 2}`: the item's id and the keys whose values differ (≤ 3). */
export function elementDiff(x: unknown, y: unknown, path: string, redact: Redactor): string {
  if (isPlainObject(x) && isPlainObject(y)) {
    const parts: string[] = [];
    const id = idKey(y) ?? idKey(x);
    if (id && x[id] === y[id]) parts.push(`${id}: ${describe(y[id], `${path}.${id}`, redact, 24)}`);
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])];
    let changed = 0;
    for (const k of keys) {
      if (k === id && x[k] === y[k]) continue;
      if (valueHash(x[k]) === valueHash(y[k])) continue;
      changed++;
      if (changed <= 3) parts.push(`${k}: ${describe(x[k], `${path}.${k}`, redact, 24)} → ${describe(y[k], `${path}.${k}`, redact, 24)}`);
    }
    if (changed > 3) parts.push(`+${changed - 3} more changed`);
    return `{${parts.join(", ")}}`;
  }
  return `${describe(x, path, redact, 40)} → ${describe(y, path, redact, 40)}`;
}

/** One-line description of a change, e.g. `3 → 4 items: added {id: 9, …}`, `"r" → "re"`, `3 items, 1 changed: {id: 3, qty: 1 → 2}`. */
export function changeText(c: Pick<FieldChange, "before" | "after" | "path"> & { beforeLeaf?: Leaf; afterLeaf?: Leaf }, redact: Redactor): string {
  const b = c.beforeLeaf ?? leafOf(c.before);
  const a = c.afterLeaf ?? leafOf(c.after);
  const el = (v: unknown) => describe(v, c.path, redact, 48);
  if (a.kind === "array" && b.kind === "array" && a.elems && b.elems) {
    const full = `${describe(c.before, c.path, redact, 44)} → ${describe(c.after, c.path, redact, 44)}`;
    const ba = b.value as unknown[];
    const aa = a.value as unknown[];
    if (a.len === b.len) {
      const idx: number[] = [];
      for (let i = 0; i < a.len; i++) if (a.elems[i] !== b.elems[i]) idx.push(i);
      if (idx.length === 0) return `${a.len} items, unchanged`;
      const { added } = multisetDiff(b.elems, a.elems);
      if (added.length === 0) return `${a.len} items, reordered`;
      if (idx.length <= Math.max(1, a.len / 2)) {
        const more = idx.length > 1 ? `, and ${idx.length - 1} more` : "";
        return `${a.len} items, ${idx.length} changed: ${elementDiff(ba[idx[0]], aa[idx[0]], c.path, redact)}${more}`;
      }
      return full.length <= 90 ? full : `${a.len} items, ${idx.length} changed`;
    }
    if (full.length <= 70) return full;
    const added = addedElements(b, a);
    const removedN = Math.max(0, b.len - (a.len - added.length));
    const parts: string[] = [];
    if (added.length) parts.push(`added ${el(added[0])}${added.length > 1 ? ` and ${added.length - 1} more` : ""}`);
    if (removedN) parts.push(`removed ${plural(removedN, "item")}`);
    return `${b.len} → ${a.len} items${parts.length ? `: ${parts.join("; ")}` : ""}`;
  }
  if (a.kind === "object" && b.kind === "object" && a.khash && b.khash) {
    const av = a.value as Record<string, unknown>;
    const bv = b.value as Record<string, unknown>;
    const addedK = [...a.khash.keys()].filter((k) => !b.khash!.has(k));
    const removedK = [...b.khash.keys()].filter((k) => !a.khash!.has(k));
    const changedK = [...a.khash.keys()].filter((k) => b.khash!.has(k) && b.khash!.get(k) !== a.khash!.get(k));
    const parts: string[] = [];
    if (addedK.length) parts.push(`added ${addedK[0]}: ${el(av[addedK[0]])}${addedK.length > 1 ? ` and ${addedK.length - 1} more` : ""}`);
    if (changedK.length) parts.push(`changed ${changedK[0]}: ${elementDiff(bv[changedK[0]], av[changedK[0]], c.path, redact)}${changedK.length > 1 ? ` and ${changedK.length - 1} more` : ""}`);
    if (removedK.length) parts.push(`removed ${removedK.slice(0, 2).join(", ")}${removedK.length > 2 ? ` and ${removedK.length - 2} more` : ""}`);
    return `${b.len} → ${a.len} entries${parts.length ? `: ${parts.join("; ")}` : ""}`;
  }
  if (typeof c.before === "string" && typeof c.after === "string" && Object.is(redact(c.path, c.after), c.after) && Object.is(redact(c.path, c.before), c.before)) {
    const d = stringDiff(c.before, c.after);
    if (d) return d.text;
  }
  return `${describe(c.before, c.path, redact, 36)} → ${describe(c.after, c.path, redact, 36)}`;
}

export interface StringDiff {
  /** Characters of `before` that `after` does not have (between the common prefix and suffix). */
  removed: string;
  /** Characters of `after` that `before` does not have. */
  added: string;
  /** `"…sword shield market lib" → "…sword shield" (removes " market lib")`: both sides centred on the difference. */
  text: string;
}

/**
 * A diff-centred change of a long string: truncating both sides to the same prefix would hide the difference, so
 * both previews start a little before the first differing character. Null for short strings (shown whole).
 */
export function stringDiff(before: string, after: string, width = 30): StringDiff | null {
  if (before === after || (before.length <= width && after.length <= width)) return null;
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const removed = before.slice(p, before.length - s);
  const added = after.slice(p, after.length - s);
  const start = Math.max(0, p - 14);
  const win = (x: string) => JSON.stringify(`${start > 0 ? "…" : ""}${x.slice(start, start + width)}${start + width < x.length ? "…" : ""}`);
  const q = (x: string) => JSON.stringify(truncate(x, 28));
  const what = !added ? `removes ${q(removed)}` : !removed ? `inserts ${q(added)}` : `replaces ${q(removed)} with ${q(added)}`;
  return { removed, added, text: `${win(before)} → ${win(after)} (${what})` };
}

// ------------------------------------------------------------------------------------------------ patches

/**
 * Re-apply a value write as a patch of the paths it changed, on top of the current value. Used when a held or
 * queued write is applied after other writes (e.g. user input) changed other fields of the same store, and for
 * reverting/re-applying a write. Removals are applied first, and a path is never removed when a change targets
 * something beneath it (an empty object being filled). Returns ok: false when the structure does not allow a patch.
 */
export function patchValue(store: string, current: unknown, changes: { path: string; after: unknown; removed: boolean }[]): { ok: true; value: unknown } | { ok: false } {
  const whole = changes.find((x) => x.path === store);
  if (whole) return { ok: true, value: whole.after };
  if (!isPlainObject(current)) return { ok: false };
  const sets = changes.filter((c) => !c.removed);
  const removals = changes.filter((c) => c.removed && !sets.some((t) => t.path.startsWith(c.path + ".")));
  const root: Record<string, unknown> = { ...current };
  const copied = new Set<object>([root]);
  const apply = (c: { path: string; after: unknown; removed: boolean }): boolean => {
    const segs = c.path.split(".").slice(1);
    let obj: Record<string, unknown> = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i];
      const child = obj[k];
      if (child === undefined || child === null) {
        if (c.removed) return true; // nothing to remove
        obj[k] = {};
      } else if (!isPlainObject(child)) {
        return false;
      } else if (!copied.has(child)) {
        obj[k] = { ...child };
      }
      obj = obj[k] as Record<string, unknown>;
      copied.add(obj);
    }
    const last = segs[segs.length - 1];
    if (c.removed) delete obj[last];
    else obj[last] = c.after;
    return true;
  };
  for (const c of removals) if (!apply(c)) return { ok: false };
  for (const c of sets) if (!apply(c)) return { ok: false };
  return { ok: true, value: root };
}

/** Deep clone for snapshots (structuredClone when available; references kept for uncloneable values). */
export function cloneValue<T>(v: T): T {
  const sc = (globalThis as { structuredClone?: (x: unknown) => unknown }).structuredClone;
  if (sc) {
    try {
      return sc(v) as T;
    } catch {
      /* fall through */
    }
  }
  return manualClone(v, 0) as T;
}

function manualClone(v: unknown, depth: number): unknown {
  if (depth > 32 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => manualClone(x, depth + 1));
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, manualClone(x, depth + 1)]));
  if (v instanceof Set) return new Set([...v].map((x) => manualClone(x, depth + 1)));
  if (!isPlainObject(v)) return v;
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(v)) o[k] = manualClone((v as Record<string, unknown>)[k], depth + 1);
  return o;
}

/** Value kind recorded in transition profiles. */
export function normalizeLeafKind(l: Leaf | undefined): string {
  return l ? l.kind : "undefined";
}
