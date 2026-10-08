// Version conflicts at the network boundary (situation v2). Generic happens-before facts, no domain knowledge:
//
//   predicted write set P of an operation: the store fields (normalised paths) its signature's causal chain wrote in
//   past completions (transition profile), else what the last completed operation of that signature wrote, else
//   unknown;
//   a NEWER-DATA conflict on field F for operation X: F's value now differs from its value when X started, and a
//   newer operation (started after X, outside X's chain, not a user action itself) wrote it since X started;
//   a PENDING LOCAL CHANGE on F: a chain rooted at a user action wrote F recently and an operation of that chain is
//   still in flight, with a signature different from X's (an optimistic update not yet confirmed). A user action
//   that started a newer request of X's own signature (typeahead keystrokes, autosave edits) is not a conflict:
//   that newer request will deliver after X.
//
// Inputs that moved, or a newer request of the same signature still in flight, are never conflicts by themselves. While
// such a newer request is in flight, newer-data conflicts are not reported either: it will write these fields again
// (situation v2: delivery salience needs newer data that is applied and final; the in-flight request stays a fact).

import type { FieldHist, LogEntry } from "../state/hub.js";
import type { OpRec } from "../trace/ops.js";
import { normalizeFieldPath } from "../util.js";
import type { SitEnv } from "./env.js";

export const PENDING_WINDOW_MS = 10_000;
const MAX_MATCHED = 64;

export interface Predicted {
  patterns: string[];
  source: "profile" | "last" | "unknown";
  /** profile: completions that wrote any of these fields / completions seen. */
  seen: number;
  of: number;
}

export interface Conflict {
  path: string;
  kind: "newer" | "pending";
  /** newer: the newest writer outside X's chain; pending: the user action. */
  writer?: OpRec;
  /** pending: the in-flight op of the user's chain. */
  pendingOp?: OpRec;
  /** Writes by other chains since X started (newer) or the age of the user's write (pending). */
  count: number;
  t: number;
}

/** What an op's signature is predicted to write (normalised paths). */
export function predictedWrites(env: SitEnv, op: OpRec): Predicted {
  const sig = op.kind === "user" ? `user ${op.name}` : op.name;
  const p = env.profiles.get(sig);
  if (p && p.n > 0) {
    const patterns = Object.keys(p.wrote).sort();
    if (patterns.length) {
      const seen = p.n - (p.sets[""] ?? 0);
      return { patterns, source: "profile", seen, of: p.n };
    }
  }
  const last = env.lastChain(op.name);
  if (last && last.length) return { patterns: [...last].sort(), source: "last", seen: 1, of: 1 };
  return { patterns: [], source: "unknown", seen: 0, of: 0 };
}

/** Current leaf paths matching normalised patterns (bounded). */
export function matchFields(env: SitEnv, patterns: string[]): string[] {
  if (!patterns.length) return [];
  const set = new Set(patterns);
  const stores = new Set(patterns.map((p) => p.split(".")[0]));
  const out: string[] = [];
  for (const name of stores) {
    const s = env.hub.get(name);
    if (!s) continue;
    for (const path of s.leaves.keys()) {
      if (set.has(path) || set.has(normalizeFieldPath(path))) {
        out.push(path);
        if (out.length >= MAX_MATCHED) return out;
      }
    }
  }
  return out;
}

function inChain(env: SitEnv, x: OpRec, writer: number | null): boolean {
  if (writer === null) return false;
  const w = env.ops.get(writer);
  if (!w) return false;
  return env.ops.isAncestorOrSelf(x, w) || env.ops.isAncestorOrSelf(w, x);
}

/** F's value now differs from its value when X started (unknown history counts as changed). */
function netChanged(env: SitEnv, x: OpRec, path: string, log: LogEntry[]): boolean {
  if (!log.length) return false;
  const f = env.hub.field(path);
  const first: FieldHist | undefined = f?.hist.find((h) => h.seq === log[0].seq);
  const cur = env.hub.leaf(path);
  if (!first) return true;
  const before = first.beforeLeaf;
  if (!before || !cur) return before !== cur;
  return before.hash !== cur.hash;
}

/** A request of x's signature that started after x is still in flight (it will write x's fields again). */
export function newerSameSignature(env: SitEnv, x: OpRec): boolean {
  if (x.kind !== "fetch" && x.kind !== "xhr") return false;
  for (const o of env.ops.inFlight) if (o !== x && o.name === x.name && o.kind === x.kind && o.start > x.start) return true;
  return false;
}

/** Newer-data conflict on `path` for operation `x` (null when none). */
export function newerConflict(env: SitEnv, x: OpRec, path: string): Conflict | null {
  if (newerSameSignature(env, x)) return null;
  const log = env.hub.logSince(path, x.startSeq).filter((e) => !inChain(env, x, e.writer));
  if (!log.length) return null;
  let newest: OpRec | undefined;
  for (const e of log) {
    if (e.user || e.writer === null) continue;
    const w = env.ops.get(e.writer);
    if (!w || w.kind === "user" || w.start <= x.start) continue;
    newest = w;
  }
  if (!newest || !netChanged(env, x, path, log)) return null;
  return { path, kind: "newer", writer: newest, count: log.length, t: log[log.length - 1].t };
}

/** Pending local change on `path` that `x` (or a write with no op, x null) would overwrite. */
export function pendingConflict(env: SitEnv, x: OpRec | null, path: string, now: number): Conflict | null {
  const f = env.hub.field(path);
  if (!f) return null;
  const myRoot = x ? x.root ?? x.id : null;
  for (let i = f.hist.length - 1; i >= 0; i--) {
    const h = f.hist[i];
    if (now - h.t > PENDING_WINDOW_MS) break;
    if (h.root === null || h.root === myRoot) continue;
    const rootOp = env.ops.get(h.root);
    if (!rootOp || rootOp.kind !== "user") continue;
    let pending: OpRec | undefined;
    for (const o of env.ops.inFlight) {
      if (o.root === h.root && o.kind !== "user" && (!x || o.name !== x.name)) {
        pending = o;
        break;
      }
    }
    if (!pending) continue;
    return { path, kind: "pending", writer: rootOp, pendingOp: pending, count: 1, t: h.t };
  }
  return null;
}

/** All conflicts on the given concrete fields for operation `x` (newer-data first). */
export function conflictsOn(env: SitEnv, x: OpRec, paths: string[], now: number): Conflict[] {
  const out: Conflict[] = [];
  for (const p of paths) {
    const c = newerConflict(env, x, p) ?? pendingConflict(env, x, p, now);
    if (c) out.push(c);
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "newer" ? -1 : 1));
}
