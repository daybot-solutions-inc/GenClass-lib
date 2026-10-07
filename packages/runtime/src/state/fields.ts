// Flattening store values into dotted fields (CONTRACT §4: top-level-first paths, arrays are one field),
// change detection by stable hashes, change deltas (for "identical change" repetition facts) and patches
// (re-applying a held value write on top of newer state).

import { fnv1a, hashValue, isPlainObject, kindOf, stableStringify } from "../util.js";

export const MAX_DEPTH = 4;
export const MAX_FIELDS_PER_STORE = 200;
const MAX_ELEMS = 500;

export interface Leaf {
  value: unknown;
  hash: string;
  kind: string;
  /** Array length (-1 for non-arrays). */
  len: number;
  /** Element hashes for arrays (first MAX_ELEMS). */
  elems?: string[];
}

/** Flatten a store value into path -> leaf. Paths start with the store name. */
export function flatten(store: string, value: unknown): Map<string, Leaf> {
  const out = new Map<string, Leaf>();
  const walk = (v: unknown, path: string, depth: number) => {
    if (isPlainObject(v) && depth < MAX_DEPTH && out.size < MAX_FIELDS_PER_STORE) {
      const keys = Object.keys(v);
      if (keys.length > 0) {
        for (const k of keys) walk(v[k], `${path}.${k}`, depth + 1);
        return;
      }
    }
    out.set(path, leafOf(v));
  };
  walk(value, store, 0);
  return out;
}

export function leafOf(v: unknown): Leaf {
  if (Array.isArray(v)) {
    const elems: string[] = [];
    for (let i = 0; i < v.length && i < MAX_ELEMS; i++) elems.push(hashValue(v[i]));
    const hash = fnv1a(`${v.length}|${elems.join(",")}${v.length > MAX_ELEMS ? "|" + stableStringify(v.slice(MAX_ELEMS), 4096) : ""}`);
    return { value: v, hash, kind: "array", len: v.length, elems };
  }
  return { value: v, hash: hashValue(v), kind: kindOf(v), len: -1 };
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

/**
 * Re-apply a value write as a patch of the paths it changed, on top of the current value. Used when a held or
 * queued write is applied after other writes (e.g. user input) changed other fields of the same store.
 * Returns undefined when the structure does not allow a patch (caller falls back to the full value).
 */
export function patchValue(store: string, current: unknown, changes: { path: string; after: unknown; removed: boolean }[]): { ok: true; value: unknown } | { ok: false } {
  if (changes.some((c) => c.path === store)) {
    const c = changes.find((x) => x.path === store)!;
    return { ok: true, value: c.after };
  }
  if (!isPlainObject(current)) return { ok: false };
  const root: Record<string, unknown> = { ...current };
  for (const c of changes) {
    const segs = c.path.split(".").slice(1);
    let obj: Record<string, unknown> = root;
    let ok = true;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i];
      const child = obj[k];
      if (child === undefined && !c.removed) {
        obj[k] = {};
      } else if (!isPlainObject(child)) {
        ok = false;
        break;
      } else {
        obj[k] = { ...child };
      }
      obj = obj[k] as Record<string, unknown>;
    }
    if (!ok) return { ok: false };
    const last = segs[segs.length - 1];
    if (c.removed) delete obj[last];
    else obj[last] = c.after;
  }
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
