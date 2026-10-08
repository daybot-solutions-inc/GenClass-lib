// Content facts (situation v2, SIM's separability proposals F1–F3 and read-your-writes): what a response (or a
// write) would put into the fields its operation writes, compared with what is there now and what was there when
// the operation started. Generic: values are located in a response body by item ids and key paths, compared by
// value hashes, joined item by item on an id key. Statements are about the response's own content ("the response has
// …"), so a transformation by the app can only make a fact uninformative, never false.
//
//   F1  the incoming value equals the value a newer write replaced ("would put back …"), per field or per item cell;
//       the newer writes touched other items than the ones this response changes;
//   F2  the incoming value would replace text the user typed after the operation started (diff-centred preview);
//   F3  the incoming values equal the current ones (the response changes nothing): such a delivery is not salient;
//   RYW a list reloaded after a create lacks the created item, or holds it twice.

import type { Fact } from "../types.js";
import type { FieldHist } from "../state/hub.js";
import { leafOf, redactedStringDiff } from "../state/fields.js";
import type { OpRec } from "../trace/ops.js";
import { describe, isIdSegment, isPlainObject, kindOf, plural, secs } from "../util.js";
import { opLabel } from "./describe.js";
import type { CreateRec, SitEnv } from "./env.js";
import type { Conflict } from "./conflicts.js";

const ITEM_ID = ["id", "_id", "uuid", "slug", "key"];
const MAX_NODES = 20_000;
const MAX_DEPTH = 8;
const MAX_ITEMS = 2000;
export const RYW_WINDOW_MS = 10_000;

type Obj = Record<string, unknown>;

function fact(text: string, kind: Fact["kind"], neutral: boolean): Fact {
  return { text, kind, neutral };
}

/** Value hash, the same one store fields use (deep, cheap for primitives). */
export function vhash(v: unknown): string {
  return leafOf(v).hash;
}

function itemIdKey(o: Obj): string | undefined {
  return ITEM_ID.find((k) => typeof o[k] === "string" || typeof o[k] === "number");
}

// --------------------------------------------------------------------------------------------- body index

export interface BodyIndex {
  root: unknown;
  /** Properties outside arrays: key path from the root and value. */
  props: { keys: string[]; value: unknown }[];
  /** Objects with an id key, anywhere in the body, by id. */
  ids: Map<string, Obj[]>;
  /** Arrays outside other arrays. */
  arrays: { keys: string[]; value: unknown[] }[];
  /** Objects outside arrays (keyed update messages: `{card: "c1", col: "done"}`). */
  objects: Obj[];
}

export function indexBody(root: unknown): BodyIndex {
  const ix: BodyIndex = { root, props: [], ids: new Map(), arrays: [], objects: [] };
  let nodes = 0;
  const walk = (v: unknown, keys: string[], inArray: boolean, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return;
    if (Array.isArray(v)) {
      if (!inArray) ix.arrays.push({ keys, value: v });
      for (let i = 0; i < v.length && i < MAX_ITEMS; i++) walk(v[i], keys, true, depth + 1);
      return;
    }
    if (!isPlainObject(v)) return;
    if (!inArray && ix.objects.length < 64) ix.objects.push(v);
    const k = itemIdKey(v);
    if (k) {
      const id = String(v[k]);
      const list = ix.ids.get(id);
      if (list) list.push(v);
      else ix.ids.set(id, [v]);
    }
    for (const key of Object.keys(v)) {
      const ks = [...keys, key];
      if (!inArray) ix.props.push({ keys: ks, value: v[key] });
      walk(v[key], ks, inArray, depth + 1);
    }
  };
  walk(root, [], false, 0);
  return ix;
}

/** Parse a response/message body as JSON (≤ 256 KB of text). undefined when it is not JSON. */
export function parseJsonBody(text: string | null | undefined, max = 256 * 1024): unknown {
  if (typeof text !== "string" || !text || text.length > max) return undefined;
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

function itemsCompatible(cur: unknown[], inc: unknown[]): boolean {
  const a = cur.find((x) => x !== null && x !== undefined);
  const b = inc.find((x) => x !== null && x !== undefined);
  if (a === undefined || b === undefined) return true; // an empty side: decided by uniqueness
  if (kindOf(a) !== kindOf(b)) return false;
  if (!isPlainObject(a) || !isPlainObject(b)) return true;
  const ka = itemIdKey(a);
  if (ka && ka === itemIdKey(b)) return true;
  const A = new Set(Object.keys(a));
  const B = Object.keys(b);
  const shared = B.filter((k) => A.has(k)).length;
  return shared > 0 && shared / new Set([...A, ...B]).size >= 0.5;
}

function compatible(cur: unknown, v: unknown): boolean {
  if (cur === null || cur === undefined || v === null || v === undefined) return true;
  const kc = kindOf(cur);
  if (kc !== kindOf(v)) return false;
  if (Array.isArray(cur)) return itemsCompatible(cur, v as unknown[]);
  return true;
}

/** The single value all candidates agree on (by hash), else undefined. */
function agreed<T>(xs: T[]): T | undefined {
  if (!xs.length) return undefined;
  const h = vhash(xs[0]);
  for (let i = 1; i < xs.length; i++) if (vhash(xs[i]) !== h) return undefined;
  return xs[0];
}

const MISSING = Symbol("missing");

function getIn(o: unknown, keys: string[]): unknown {
  let cur = o;
  for (const k of keys) {
    if (!isPlainObject(cur) || !(k in cur)) return MISSING;
    cur = cur[k];
  }
  return cur;
}

export interface Located {
  path: string;
  value: unknown;
  /** Where in the body: "items", "item c1's status", "the response body". */
  where: string;
}

/** The value a response body holds for a store field (by item id, key path, or the one fitting array), or null. */
export function locate(ix: BodyIndex, path: string, current: unknown): Located | null {
  const segs = path.split(".").slice(1);
  // 1. an item of a keyed collection, by id
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    const objs = ix.ids.get(seg);
    if (!objs || !(i > 0 || isIdSegment(seg) || /\d/.test(seg))) continue;
    const o = agreed(objs);
    if (o === undefined) return null;
    const rest = segs.slice(i + 1);
    const v = getIn(o, rest);
    if (v === MISSING || !compatible(current, v)) return null;
    return { path, value: v, where: `item ${seg}${rest.length ? `'s ${rest.join(".")}` : ""}` };
  }
  // 1b. a keyed update ({card: "c1", col: "done"} for board.cards.c1): the object naming the key as a value, and its
  //     one other property of the field's kind
  const lastSeg = segs[segs.length - 1];
  if (segs.length >= 2 && lastSeg && (isIdSegment(lastSeg) || /\d/.test(lastSeg)) && current !== null && typeof current !== "object") {
    const hits: unknown[] = [];
    for (const o of ix.objects) {
      const keyProp = Object.keys(o).find((k) => o[k] === lastSeg);
      if (!keyProp) continue;
      const others = Object.keys(o).filter((k) => k !== keyProp && typeof o[k] === typeof current);
      if (others.length === 1) hits.push(o[others[0]]);
    }
    const v = agreed(hits);
    if (v !== undefined) return { path, value: v, where: `the update for ${lastSeg}` };
  }
  // 2. the same key path (longest common suffix), outside arrays
  if (segs.length) {
    const last = segs[segs.length - 1];
    let best = 0;
    let cands: { keys: string[]; value: unknown }[] = [];
    for (const p of ix.props) {
      if (p.keys[p.keys.length - 1] !== last || !compatible(current, p.value)) continue;
      let n = 1;
      while (n < p.keys.length && n < segs.length && p.keys[p.keys.length - 1 - n] === segs[segs.length - 1 - n]) n++;
      if (n > best) {
        best = n;
        cands = [p];
      } else if (n === best) cands.push(p);
    }
    if (cands.length) {
      const v = agreed(cands.map((c) => c.value));
      return v === undefined ? null : { path, value: v, where: cands[0].keys.join(".") };
    }
  }
  // 3. a list: the body's one array of the same kind of items (the most shared ids when several fit)
  if (Array.isArray(current)) {
    const fits = ix.arrays.filter((a) => itemsCompatible(current, a.value));
    let pick = fits.length === 1 ? fits[0] : undefined;
    if (fits.length > 1) {
      const ids = new Set(current.filter(isPlainObject).map((o) => (itemIdKey(o) ? String(o[itemIdKey(o)!]) : "")).filter(Boolean));
      const score = (a: unknown[]) => a.filter((o) => isPlainObject(o) && itemIdKey(o) && ids.has(String(o[itemIdKey(o)!]))).length;
      const ranked = fits.map((a) => ({ a, n: score(a.value) })).sort((x, y) => y.n - x.n);
      if (ranked[0].n > 0 && ranked[0].n > ranked[1].n) pick = ranked[0].a;
    }
    return pick ? { path, value: pick.value, where: pick.keys.length ? pick.keys.join(".") : "the response body" } : null;
  }
  // 4. a store holding a primitive, and a primitive body
  if (!segs.length && !isPlainObject(ix.root) && !Array.isArray(ix.root) && compatible(current, ix.root)) return { path, value: ix.root, where: "the response body" };
  return null;
}

// --------------------------------------------------------------------------------------------- comparison

export interface ItemCmp {
  idKey: string;
  /** Cells the incoming list would set back to their value when the operation started. */
  reverts: { id: string; key: string; incoming: unknown; current: unknown }[];
  changedCells: number;
  changedItems: number;
  added: number;
  removed: number;
  /** Items changed since the operation started (by anyone). */
  newer: string[];
  /** The incoming copies of those items equal the store's. */
  newerSame: boolean;
}

export interface Cmp {
  path: string;
  incoming: unknown;
  current: unknown;
  same: boolean;
  /** Value when the operation started (known when the 16-entry history covers it). */
  start?: { value: unknown };
  /** Writes since the operation started by other chains (rich history). */
  others: FieldHist[];
  /** The latest such write whose replaced value the incoming value equals. */
  revertOf?: FieldHist;
  /** User writes since the operation started (string fields). */
  user?: { n: number; last: FieldHist };
  items?: ItemCmp;
}

function sameChain(env: SitEnv, a: OpRec, writer: number | null): boolean {
  if (writer === null) return false;
  const w = env.ops.get(writer);
  return !!w && (env.ops.isAncestorOrSelf(a, w) || env.ops.isAncestorOrSelf(w, a));
}

function itemMap(arr: unknown[], key: string): Map<string, Obj> | null {
  const m = new Map<string, Obj>();
  for (const x of arr.slice(0, MAX_ITEMS)) {
    if (!isPlainObject(x)) return null;
    const v = x[key];
    if (typeof v !== "string" && typeof v !== "number") return null;
    m.set(String(v), x);
  }
  return m;
}

function compareItems(cur: unknown[], inc: unknown[], start: unknown[] | undefined): ItemCmp | undefined {
  const sample = [...cur, ...inc].find(isPlainObject);
  const key = sample ? itemIdKey(sample) : undefined;
  if (!key) return undefined;
  const C = itemMap(cur, key);
  const I = itemMap(inc, key);
  if (!C || !I) return undefined;
  const S = start ? itemMap(start, key) : null;
  const out: ItemCmp = { idKey: key, reverts: [], changedCells: 0, changedItems: 0, added: 0, removed: 0, newer: [], newerSame: true };
  for (const [id, ci] of C) {
    const ii = I.get(id);
    if (!ii) {
      out.removed++;
      continue;
    }
    let changed = false;
    const si = S?.get(id);
    for (const k of Object.keys(ci)) {
      if (k === key || !(k in ii)) continue;
      const hi = vhash(ii[k]);
      if (hi === vhash(ci[k])) continue;
      changed = true;
      out.changedCells++;
      if (si && k in si && vhash(si[k]) === hi) out.reverts.push({ id, key: k, incoming: ii[k], current: ci[k] });
    }
    if (changed) out.changedItems++;
  }
  for (const id of I.keys()) if (!C.has(id)) out.added++;
  if (S) {
    for (const [id, ci] of C) {
      const si = S.get(id);
      if (si && vhash(si) === vhash(ci)) continue;
      out.newer.push(id);
      const ii = I.get(id);
      if (!ii || Object.keys(ci).some((k) => k in ii && vhash(ii[k]) !== vhash(ci[k]))) out.newerSame = false;
    }
  }
  return out;
}

/** Compare an incoming value for a field with its current value and its history since `x` started. */
export function compareField(env: SitEnv, x: OpRec, path: string, incoming: unknown, current: unknown = env.hub.valueAt(path)): Cmp {
  const same = vhash(incoming) === vhash(current);
  const hist = env.hub.writesSince(path, x.startSeq);
  const log = env.hub.logSince(path, x.startSeq);
  const out: Cmp = { path, incoming, current, same, others: hist.filter((h) => !sameChain(env, x, h.writer)) };
  if (!log.length) out.start = { value: current };
  else if (hist.length && hist[0].seq === log[0].seq) out.start = { value: hist[0].before };
  if (!same) {
    const hi = vhash(incoming);
    for (let i = out.others.length - 1; i >= 0; i--) {
      const h = out.others[i];
      if (vhash(h.before) === hi) {
        out.revertOf = h;
        break;
      }
    }
    if (typeof current === "string" && typeof incoming === "string") {
      const us = out.others.filter((h) => h.user || env.ops.get(h.root)?.kind === "user");
      if (us.length) out.user = { n: us.length, last: us[us.length - 1] };
    }
    if (Array.isArray(current) && Array.isArray(incoming)) {
      const items = compareItems(current, incoming, out.start && Array.isArray(out.start.value) ? out.start.value : undefined);
      if (items) out.items = items;
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------------- facts

export interface ContentResult {
  located: Located[];
  cmps: Cmp[];
  /** Every predicted field was found and equals the current value. */
  noChange: boolean;
}

/** Locate and compare the predicted fields of a delivering op in its response body. */
export function analyzeBody(env: SitEnv, x: OpRec, body: unknown, fields: string[]): ContentResult {
  const ix = indexBody(body);
  const located: Located[] = [];
  for (const f of fields.slice(0, 32)) {
    const l = locate(ix, f, env.hub.valueAt(f));
    if (l) located.push(l);
  }
  const cmps = located.map((l) => compareField(env, x, l.path, l.value));
  return { located, cmps, noChange: fields.length > 0 && located.length === fields.length && cmps.every((c) => c.same) };
}

const show = (env: SitEnv, path: string, v: unknown, n = 40) => describe(v, path, env.redact, n);

function writerText(env: SitEnv, h: FieldHist): string {
  const w = env.ops.get(h.writer);
  return w ? opLabel(w) : h.user ? "a user action" : "an operation that is no longer tracked";
}

function startedText(env: SitEnv, x: OpRec, h: FieldHist): string {
  const w = env.ops.get(h.writer);
  if (!w || w.start === x.start) return "";
  return ` (it started ${w.start > x.start ? "after" : "before"} #${x.id})`;
}

/**
 * F1/F2/F3 facts for compared fields. `subject` is "The response" (delivery) or "This write" (mutation); conflicts
 * come first, at most 3 fields.
 */
export function contentFacts(env: SitEnv, x: OpRec, cmps: Cmp[], subject: "The response" | "This message" | "This write", now: number, all?: { fields: string[] }): Fact[] {
  const out: Fact[] = [];
  const verb = subject === "This write" ? "applying it" : "delivering it";
  const own = subject === "This write" ? "this write's" : subject === "This message" ? "this message's" : "this response's";
  const ordered = [...cmps].sort((a, b) => Number(!!b.revertOf || !!b.user || !!b.items?.reverts.length) - Number(!!a.revertOf || !!a.user || !!a.items?.reverts.length));
  let shown = 0;
  for (const c of ordered) {
    if (c.same || shown >= 3) continue;
    const it = c.items;
    if (it) {
      if (it.reverts.length) {
        const r = it.reverts[0];
        const more = it.reverts.length > 1 ? ` and ${plural(it.reverts.length - 1, "more cell")}` : "";
        out.push(fact(`${subject} would put back ${r.key} = ${show(env, `${c.path}.${r.key}`, r.incoming, 24)} for item ${r.id} of ${c.path}${more}: the store has ${show(env, `${c.path}.${r.key}`, r.current, 24)}, changed since #${x.id} started; ${verb} would undo that change.`, "versions", false));
        shown++;
      } else if (it.newer.length && it.newerSame) {
        out.push(fact(`The newer writes to ${c.path} changed only ${plural(it.newer.length, "item")} (${it.newer.slice(0, 3).join(", ")}); ${own} copy of ${it.newer.length === 1 ? "it" : "them"} equals the store.`, "versions", true));
        shown++;
      }
      const parts: string[] = [];
      if (it.changedCells) parts.push(`change ${plural(it.changedCells, "cell")} in ${plural(it.changedItems, "item")}`);
      if (it.added) parts.push(`add ${plural(it.added, "item")}`);
      if (it.removed) parts.push(`remove ${plural(it.removed, "item")}`);
      if (parts.length) out.push(fact(`Joined by ${it.idKey} with ${c.path}, ${subject.toLowerCase()} would ${parts.join(", ")}.`, "delta", true));
      continue;
    }
    if (c.user) {
      const d = redactedStringDiff(c.path, c.current, c.incoming, env.redact);
      const change = d ? d.text : `${show(env, c.path, c.current)} → ${show(env, c.path, c.incoming)}`;
      const last = c.user.last;
      out.push(fact(`${subject} would replace text the user typed into ${c.path} after #${x.id} started (${plural(c.user.n, "user write")}, the last ${secs(now - last.t)} ago): ${change}.`, "versions", false));
      shown++;
      continue;
    }
    if (c.revertOf) {
      const h = c.revertOf;
      out.push(fact(`${subject} has ${c.path} = ${show(env, c.path, c.incoming)}, the value that ${writerText(env, h)} replaced with ${show(env, c.path, h.after)} ${secs(now - h.t)} ago${startedText(env, x, h)}; ${verb} would put the older value back.`, "versions", false));
      shown++;
      continue;
    }
    if (c.others.length) {
      const st = c.start ? `, nor the value when #${x.id} started` : "";
      out.push(fact(`${subject} has ${c.path} = ${show(env, c.path, c.incoming)}: neither the current value ${show(env, c.path, c.current)}${st}.`, "versions", true));
      shown++;
    }
  }
  const same = cmps.filter((c) => c.same).map((c) => c.path);
  if (same.length) {
    const list = same.length <= 3 ? same.join(", ") : `${same.slice(0, 3).join(", ")} and ${same.length - 3} more`;
    const everything = all && all.fields.length > 0 && same.length === all.fields.length;
    out.push(fact(everything ? `${subject} matches the current values of everything it is predicted to write (${list}): ${verb} changes nothing.` : `${subject} has the current value of ${list}.`, "delta", true));
  }
  return out;
}

/**
 * F1 for a pending local change: the incoming value equals the value the user's (unconfirmed) change replaced, so
 * delivering it would undo the user's change while the user's own request is still in flight.
 */
export function pendingRevertFacts(env: SitEnv, conflicts: Conflict[], cmps: Cmp[], subject: string, now: number): Fact[] {
  const out: Fact[] = [];
  for (const c of conflicts) {
    if (c.kind !== "pending" || !c.writer || out.length >= 2) continue;
    const cmp = cmps.find((x) => x.path === c.path);
    if (!cmp || cmp.same) continue;
    const hist = env.hub.field(c.path)?.hist ?? [];
    let h: FieldHist | undefined;
    for (let i = hist.length - 1; i >= 0 && !h; i--) if (hist[i].root === c.writer.id) h = hist[i];
    if (!h || vhash(h.before) !== vhash(cmp.incoming)) continue;
    out.push(
      fact(
        `${subject} has ${c.path} = ${show(env, c.path, cmp.incoming)}, the value before ${opLabel(c.writer)} changed it to ${show(env, c.path, h.after)} ${secs(now - h.t)} ago${c.pendingOp ? ` (its ${opLabel(c.pendingOp)} is still in flight)` : ""}; delivering it would undo the user's change.`,
        "versions",
        false,
      ),
    );
  }
  return out;
}

// ----------------------------------------------------------------------------------------- read your writes

/** Ids a create response returned: the root object's id, a single wrapped object's id ({article: {slug}}), or items. */
export function createdIds(body: unknown): { ids: string[]; keys: string[] } | null {
  const pick = (o: Obj) => {
    const k = itemIdKey(o);
    return k ? { id: String(o[k]), keys: Object.keys(o) } : null;
  };
  if (Array.isArray(body)) {
    const xs = body.filter(isPlainObject).slice(0, 20).map(pick).filter((x): x is { id: string; keys: string[] } => !!x);
    return xs.length ? { ids: xs.map((x) => x.id), keys: xs[0].keys } : null;
  }
  if (!isPlainObject(body)) return null;
  const own = pick(body);
  if (own) return { ids: [own.id], keys: own.keys };
  const objs = Object.values(body).filter(isPlainObject);
  if (objs.length === 1) {
    const inner = pick(objs[0]);
    if (inner) return { ids: [inner.id], keys: inner.keys };
  }
  return null;
}

function shapeFits(items: unknown[], keys: string[]): boolean {
  const o = items.find(isPlainObject);
  if (!o) return true;
  const A = new Set(Object.keys(o));
  const shared = keys.filter((k) => A.has(k)).length;
  return shared > 0 && shared / new Set([...A, ...keys]).size >= 0.4;
}

/**
 * Read-your-writes: a list that was (re)loaded after a create lacks the created item, or holds it twice. `lists`
 * are store arrays (or a response's arrays, `fromResponse`), `loadedBy` the op whose data they hold.
 */
export function rywFacts(env: SitEnv, lists: { path: string; value: unknown[]; loadedBy?: OpRec; fromResponse?: boolean }[], now: number): Fact[] {
  const out: Fact[] = [];
  const creates = env.creates().filter((c) => now - c.t <= RYW_WINDOW_MS);
  if (!creates.length) return out;
  for (const l of lists) {
    const o = l.value.find(isPlainObject);
    const key = o ? itemIdKey(o) : undefined;
    if (!key) continue;
    for (const c of creates) {
      if (!shapeFits(l.value, c.keys)) continue;
      for (const id of c.ids.slice(0, 5)) {
        let n = 0;
        for (const x of l.value) if (isPlainObject(x) && String(x[key]) === id) n++;
        const what = `${opLabel(c.op)} created item ${JSON.stringify(id)} ${secs(now - c.t)} ago (${c.status})`;
        const where = l.fromResponse ? "This response's list" : l.path;
        if (n >= 2) out.push(fact(`${where} contains item ${JSON.stringify(id)} ${n === 2 ? "twice" : `${n} times`}; ${what}.`, "versions", false));
        else if (n === 0 && l.loadedBy && l.loadedBy.start >= c.t)
          out.push(fact(`${where} was loaded by ${opLabel(l.loadedBy)}, which started ${secs(l.loadedBy.start - c.t)} after ${what}, and does not contain it.`, "versions", false));
        if (out.length >= 2) return out;
      }
    }
  }
  return out;
}

export type { CreateRec };
