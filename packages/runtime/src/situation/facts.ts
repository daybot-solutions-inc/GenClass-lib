// Facts (CONTRACT §5): short English sentences computed the same way for every situation of a trigger kind,
// stating relations explicitly and with numbers. `neutral: false` marks facts that make a situation salient for
// triage (cost filter only: no fact ever selects a diagnosis or an action).

import type { Fact, FactKind } from "../types.js";
import type { FieldHist, MutationRec } from "../state/hub.js";
import { changeText } from "../state/hub.js";
import { addedElements, leafOf } from "../state/fields.js";
import type { OpRec } from "../trace/ops.js";
import { outcomeLabel } from "../learn/baselines.js";
import { describe, fmtNum, ordinal, plural, ratio, secs, truncate } from "../util.js";
import { opLabel, opPhrase, statusText } from "./describe.js";
import type { DeliverySpec, FailureInfo, ReqMeta, SitEnv, SubjectSpec, Violation } from "./env.js";
import { matchFields, newerConflict, pendingConflict } from "./conflicts.js";
import { analyzeBody, compareField, contentFacts, pendingRevertFacts, rywFacts } from "./content.js";
import { cadenceFact, commitAmbiguity, markFacts, repeatEvidence, scopeFacts } from "./evidence.js";
import type { Unusual } from "../learn/profiles.js";

export const MAX_FACTS = 12;
const WINDOW = 10_000;

const RANK: Record<FactKind, number> = {
  invariant: 0,
  transition: 0,
  error: 0,
  versions: 1,
  repetition: 2,
  inputs: 3,
  outcome: 4,
  baseline: 5,
  concurrency: 6,
  provenance: 7,
  request: 8,
  cache: 9,
  delta: 10,
  plugin: 11,
};

function fact(text: string, kind: FactKind, neutral: boolean): Fact {
  return { text, kind, neutral };
}

/** Non-neutral first, then by kind rank; stable. */
export function orderFacts(fs: Fact[]): Fact[] {
  return fs
    .map((f, i) => ({ f, i }))
    .sort((a, b) => Number(a.f.neutral) - Number(b.f.neutral) || RANK[a.f.kind] - RANK[b.f.kind] || a.i - b.i)
    .map((x) => x.f);
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

function sameChain(env: SitEnv, a: OpRec, writer: number | null): boolean {
  if (writer === null) return false;
  const w = env.ops.get(writer);
  if (!w) return false;
  return env.ops.isAncestorOrSelf(a, w) || env.ops.isAncestorOrSelf(w, a);
}

function writerOpText(env: SitEnv, ref: OpRec, w: OpRec | undefined, user: boolean): string {
  if (!w) return user ? "a user action" : "an operation that is no longer tracked";
  return `${opLabel(w)}, which ${startedRel(w, ref)}${userRelation(env, ref, w)}`;
}

/** ", from a later user action (#13)" | ", from the same user action (#11)" | "" */
function userRelation(env: SitEnv, ref: OpRec, w: OpRec | undefined): string {
  if (!w) return "";
  const uw = env.ops.userOf(w);
  const ur = env.ops.userOf(ref);
  if (!uw) return "";
  if (ur && uw.id === ur.id) return `, from the same user action (#${uw.id})`;
  if (uw.start > ref.start || (ur && uw.start > ur.start)) return `, from a later user action (#${uw.id})`;
  return `, from an earlier user action (#${uw.id})`;
}

/** "started 0.09s after #6" */
function startedRel(w: OpRec, ref: OpRec): string {
  const d = w.start - ref.start;
  if (d === 0) return `started at the same time as #${ref.id}`;
  return `started ${secs(Math.abs(d))} ${d > 0 ? "after" : "before"} #${ref.id}`;
}

function provenance(env: SitEnv, what: string, op: OpRec | null | undefined, now: number): Fact {
  if (!op) return fact(`${what} has no known cause: no operation was active when it started.`, "provenance", true);
  const root = env.ops.rootOf(op);
  let p = `${what} comes from ${opLabel(op)}, started ${secs(now - op.start)} ago`;
  if (op.end !== undefined && !op.instant) p += `, ended ${secs(now - op.end)} ago with ${statusText(op)}`;
  if (root && root.id !== op.id) p += `; its chain began with ${opLabel(root)}`;
  return fact(p + ".", "provenance", true);
}

function deltaPhrase(env: SitEnv, c: { path: string; before: unknown; after: unknown; delta: string }): string {
  if (c.delta.startsWith("n:")) {
    const d = Number(c.delta.slice(2));
    return `${d >= 0 ? "+" : ""}${fmtNum(d)}`;
  }
  if (c.delta.startsWith("a:")) {
    const added = addedElements(leafOf(c.before), leafOf(c.after));
    if (added.length) return `added ${plural(added.length, "item")} ${describe(added[0], c.path, env.redact, 50)}`;
    const b = Array.isArray(c.before) ? c.before.length : 0;
    const a = Array.isArray(c.after) ? c.after.length : 0;
    return `removed ${plural(Math.max(0, b - a), "item")}`;
  }
  return `set to ${describe(c.after, c.path, env.redact, 50)}`;
}

/** Additive changes (numeric deltas, added/removed array items) change the result when repeated. */
function additive(delta: string): boolean {
  return delta.startsWith("n:") || delta.startsWith("a:");
}

// ---------------------------------------------------------------------------------------------- mutation

/**
 * Version facts for the fields an operation X (the cause of a write, or a delivered response's operation) writes:
 * non-neutral only for a newer-data conflict (a newer operation wrote the field since X started and its value
 * changed) or a pending local change (an unconfirmed optimistic write of a user action); writes by older
 * operations, by X's own chain, or by user actions alone are neutral.
 */
function versionFacts(env: SitEnv, X: OpRec, paths: string[], ref: string, now: number): Fact[] {
  const out: Fact[] = [];
  for (const path of paths) {
    const vStart = env.hub.versionAt(path, X.startSeq);
    X.reads.set(path, vStart);
    const vNow = env.hub.field(path)?.v ?? 0;
    const log = env.hub.logSince(path, X.startSeq);
    const others = log.filter((e) => !sameChain(env, X, e.writer));
    const pending = pendingConflict(env, X, path, now);
    if (pending) {
      out.push(
        fact(
          `${path} has a pending local change: ${opLabel(pending.writer)} wrote it ${secs(now - pending.t)} ago and its ${opLabel(pending.pendingOp)} is still in flight; ${ref} ${X.start > pending.writer!.start ? "started after that user action" : "started before that user action"}.`,
          "versions",
          false,
        ),
      );
    }
    if (others.length) {
      const last = others[others.length - 1];
      const conflict = newerConflict(env, X, path) !== null;
      out.push(
        fact(
          `${path} was written ${times(others.length)} by other operations since ${ref} started (version ${vStart} → ${vNow}), last ${secs(now - last.t)} ago by ${writerOpText(env, X, env.ops.get(last.writer), last.user)}.`,
          "versions",
          !conflict,
        ),
      );
    } else if (log.length) {
      out.push(fact(`${path} was written ${times(log.length)} by ${ref}'s own chain since it started (version ${vStart} → ${vNow}).`, "versions", true));
    } else if (!pending) {
      out.push(fact(`${path} has not changed since ${ref} started (version ${vNow}).`, "versions", true));
    }
  }
  return out;
}

/** Other fields of the given stores that changed since X started, by other chains (always neutral). */
function movedFacts(env: SitEnv, X: OpRec, exclude: string[], stores: string[], ref: string): Fact[] {
  const out: Fact[] = [];
  const moved = env.hub
    .changedSince(X.startSeq)
    .filter((x) => !exclude.includes(x.path) && env.hub.leaf(x.path) !== undefined)
    .map((x) => {
      const log = env.hub.logSince(x.path, X.startSeq).filter((e) => !sameChain(env, X, e.writer));
      return { ...x, log, hist: x.hist.filter((h) => !sameChain(env, X, h.writer)) };
    })
    .filter((x) => x.log.length > 0)
    .map((x) => ({ ...x, same: stores.includes(x.path.split(".")[0]), user: x.log.some((e) => e.user) }))
    .sort((a, b) => Number(b.same) - Number(a.same) || Number(b.user) - Number(a.user) || b.log[b.log.length - 1].seq - a.log[a.log.length - 1].seq);
  for (const x of moved.slice(0, 2)) {
    const last = x.log[x.log.length - 1];
    const cur = env.hub.valueAt(x.path);
    const w = env.ops.get(last.writer);
    const by = w ? `${opLabel(w)} ${secs(Math.max(0, last.t - X.start))} after #${X.id} started` : "an untracked writer";
    const n = x.log.length;
    const curText = describe(cur, x.path, env.redact, 40);
    const firstH = x.hist.length && x.hist[0].seq === x.log[0].seq ? x.hist[0] : undefined;
    let what: string;
    if (!firstH) what = `${x.path} changed ${times(n)} since ${ref} started (now ${curText})`;
    else {
      const beforeText = describe(firstH.before, x.path, env.redact, 40);
      what = beforeText === curText ? `${x.path} changed ${times(n)} since ${ref} started and is back to ${curText}` : `${x.path} changed since ${ref} started: ${beforeText} → ${curText}${n > 1 ? ` (${n} writes)` : ""}`;
    }
    out.push(fact(`${what}, last by ${by}.`, "inputs", true));
  }
  return out;
}

/** In-flight ops with X's signature or that usually write these stores (always neutral). */
function concurrencyFacts(env: SitEnv, X: OpRec, stores: string[], ref: string): Fact[] {
  const out: Fact[] = [];
  const chainIds = new Set([X.id, ...env.ops.ancestors(X).map((a) => a.id)]);
  const others = [...env.ops.inFlight].filter((o) => !chainIds.has(o.id) && !env.ops.isAncestorOrSelf(X, o) && o.kind !== "user");
  const same = others.filter((o) => o.name === X.name && o.kind === X.kind);
  if (same.length) {
    const newer = same.filter((o) => o.start > X.start);
    const items = same.slice(0, 3).map((o) => `#${o.id} ${truncate(o.detail ?? "", 30)} ${startedRel(o, X)}`.replace(/\s+/g, " "));
    out.push(fact(`${plural(same.length, `other ${X.name} operation`)} ${same.length === 1 ? "is" : "are"} in flight (${newer.length} newer than ${ref}): ${items.join("; ")}.`, "concurrency", true));
  }
  for (const store of stores.slice(0, 2)) {
    const writers = others.filter((o) => !same.includes(o) && (env.storeWriters.get(o.name)?.get(store) ?? 0) > 0);
    if (!writers.length) continue;
    const o = writers[0];
    out.push(
      fact(
        `${opLabel(o)} is in flight and its chain wrote ${store} ${times(env.storeWriters.get(o.name)!.get(store)!)} before${writers.length > 1 ? ` (${writers.length - 1} more such ops in flight)` : ""}.`,
        "concurrency",
        true,
      ),
    );
  }
  return out;
}

function mutationFacts(env: SitEnv, m: MutationRec, now: number): Fact[] {
  const out: Fact[] = [];
  const C = m.cause;
  const written = m.changes.map((c) => c.path);
  out.push(provenance(env, "This write", C, now));
  if (C) {
    const ref = `this write's cause (#${C.id})`;
    const Ref = `This write's cause (#${C.id})`;
    out.push(...versionFacts(env, C, written.slice(0, 3), ref, now));
    // what this write puts back / overwrites (F1, F2), item by item for lists
    const cmps = m.changes.filter((c) => c.afterLeaf !== undefined).slice(0, 6).map((c) => compareField(env, C, c.path, c.after, c.before));
    out.push(...contentFacts(env, C, cmps, "This write", now));
    const net = netOf(env, C);
    const lists = m.changes.filter((c) => Array.isArray(c.after)).map((c) => ({ path: c.path, value: c.after as unknown[], ...(net ? { loadedBy: net } : {}) }));
    out.push(...rywFacts(env, lists, now));
    if (net && net.kind !== "user") {
      const cf = cadenceFact(env, net.name, now);
      if (cf) out.push(cf);
    }
    out.push(...movedFacts(env, C, written, [m.store], ref));
    out.push(...concurrencyFacts(env, C, [m.store], ref));
    // baseline: latency of the cause
    if ((C.kind === "fetch" || C.kind === "xhr") && C.end !== undefined) {
      const lat = C.end - C.start;
      const b = env.base.latency(C.name);
      if (b) {
        const slow = lat > 3 * b.median && lat - b.median >= 100;
        out.push(fact(`${Ref} took ${secs(lat)}, ${ratio(lat, b.median)} its usual ${secs(b.median)} (p95 ${secs(b.p95)}).`, "baseline", !slow));
      }
      if (C.status === "error") out.push(fact(`${Ref} failed (${statusText(C)}) before this write.`, "outcome", true));
    }
  } else {
    // no cause: an unconfirmed optimistic change of a user action is the only version fact
    for (const path of written.slice(0, 3)) {
      const pending = pendingConflict(env, null, path, now);
      if (pending)
        out.push(fact(`${path} has a pending local change: ${opLabel(pending.writer)} wrote it ${secs(now - pending.t)} ago and its ${opLabel(pending.pendingOp)} is still in flight; this write has no known cause.`, "versions", false));
    }
  }
  if (m.unholdable) out.push(fact(`This write could not be held: ${m.unholdable}.`, "outcome", true));
  out.push(...markFacts(env, written, now));
  // repetition: the same change (same store, paths and delta) applied recently
  const key = written.slice().sort().join(",") + "|" + m.changes.map((c) => `${c.path}=${c.delta}`).sort().join(";");
  const reps = env.hub.recent.filter((r) => r.key === key && now - r.t <= WINDOW);
  if (reps.length && m.changes.length) {
    const last = reps[reps.length - 1];
    const w = env.ops.get(last.writer);
    const add = m.changes.some((c) => additive(c.delta));
    let relation = "";
    if (C && w) {
      const u1 = env.ops.userOf(C);
      const u2 = env.ops.userOf(w);
      if (u1 && u2 && u1.id === u2.id) relation = `; both come from the same user action (#${u1.id})`;
      else if (u1 && u2) {
        relation = `; they come from separate user actions ${secs(Math.abs(u1.start - u2.start))} apart`;
        out.push(repeatEvidence(env, u2, u1));
      }
    }
    const what = deltaPhrase(env, m.changes[0]);
    out.push(
      fact(
        `An identical change to ${written.join(", ")} (${what}) was applied ${reps.length === 1 ? "" : `${reps.length} times in the last 10s, last `}${secs(now - last.t)} ago by ${opLabel(w)}${relation}.`,
        "repetition",
        !add,
      ),
    );
  }
  // pending writes ahead in the same store
  const s = env.hub.get(m.store);
  const ahead = s ? s.queue.filter((x) => x.id !== m.id && x.id < m.id).length : 0;
  if (ahead) out.push(fact(`${plural(ahead, "earlier write")} to ${m.store} ${ahead === 1 ? "is" : "are"} still waiting for a decision.`, "concurrency", true));
  // learned invariants this write would break (neutral: transient breaks are common between two writes)
  const broken = env.previewInvariants?.(m) ?? [];
  for (const v of broken.slice(0, 2)) out.push(fact(`Applying this write would break the learned relation ${v.text} (${v.values}); it held at ${v.held} settled points.`, "invariant", true));
  // value delta
  for (const c of m.changes.slice(0, 3)) out.push(fact(`This write would change ${c.path}: ${changeText(c, env.redact)}.`, "delta", true));
  if (m.defers) out.push(fact(`This write was already deferred ${times(m.defers)}.`, "outcome", true));
  return out;
}

/** The nearest request or message op in a chain (the source of the data a write carries). */
function netOf(env: SitEnv, op: OpRec): OpRec | undefined {
  let x: OpRec | undefined = op;
  for (let i = 0; x && i < 16; i++) {
    if (x.kind === "fetch" || x.kind === "xhr" || x.kind === "ws") return x;
    x = env.ops.get(x.cause);
  }
  return undefined;
}

/** Store fields among `paths` that hold lists, with the op whose chain last wrote each (read-your-writes). */
function storeLists(env: SitEnv, paths: string[]): { path: string; value: unknown[]; loadedBy?: OpRec }[] {
  const out: { path: string; value: unknown[]; loadedBy?: OpRec }[] = [];
  for (const p of new Set(paths)) {
    const v = env.hub.valueAt(p);
    if (!Array.isArray(v)) continue;
    const w = env.ops.get(env.hub.field(p)?.writer ?? undefined);
    const net = w ? netOf(env, w) : undefined;
    out.push({ path: p, value: v, ...(net ? { loadedBy: net } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- delivery

function fieldListText(fs: string[]): string {
  if (!fs.length) return "nothing";
  const shown = fs.slice(0, 4);
  const rest = fs.length - shown.length;
  const list = shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return rest > 0 ? `${list} (+${rest} more)` : list;
}

/** "its operation usually writes …" / "messages like it usually write …" / unknown. */
export function predictedText(s: DeliverySpec): string {
  const p = s.predicted;
  const who = s.channel === "response" ? "its operation" : "messages like it";
  const verb = s.channel === "response" ? "writes" : "write";
  if (p.source === "profile") return `${who} usually ${verb} ${fieldListText(p.patterns)}`;
  if (p.source === "last") return `${who} last wrote ${fieldListText(p.patterns)}`;
  return s.channel === "response" ? "no earlier completion shows which state it writes" : "no earlier message shows which state it writes";
}

function deliveryFacts(env: SitEnv, s: DeliverySpec, now: number): Fact[] {
  const out: Fact[] = [];
  const X = s.op;
  const ref = s.channel === "response" ? `its operation (#${X.id})` : `this message (#${X.id})`;
  if (s.channel === "response") {
    const dur = X.end !== undefined ? X.end - X.start : now - X.start;
    out.push(fact(`The response to ${opLabel(X)} arrived after ${secs(dur)}${s.status !== undefined ? ` (${s.status})` : ""}${s.defers ? ` and was held ${times(s.defers)} already` : ""}; the app has not seen it yet.`, "provenance", true));
    const cause = env.ops.get(X.cause);
    if (cause) out.push(provenance(env, "This request", cause, now));
  } else {
    out.push(fact(`A ${s.channel === "websocket" ? "WebSocket" : "server-sent"} message (#${X.id}) ${s.message?.summary ?? ""} arrived on ${s.message?.path ?? "a stream"}${s.defers ? ` and was held ${times(s.defers)} already` : ""}; the app has not seen it yet.`.replace(/\s+/g, " "), "provenance", true));
    if (s.queuedAhead) out.push(fact(`${plural(s.queuedAhead, "earlier message")} of this channel ${s.queuedAhead === 1 ? "is" : "are"} held ahead of it (order is kept).`, "concurrency", true));
  }
  // the predicted write set is in the trigger sentence; the profile's counts are the only extra information
  const p = s.predicted;
  if (p.source === "profile") out.push(fact(`In ${p.of} earlier completions of ${X.name} its chain wrote ${fieldListText(p.patterns)} (${p.seen} of ${p.of} wrote state).`, "transition", true));
  // version facts over the predicted fields: conflicts first
  const conflicted = s.conflicts.map((c) => c.path);
  const rest = s.matched.filter((f) => !conflicted.includes(f) && env.hub.logSince(f, X.startSeq).length > 0);
  out.push(...versionFacts(env, X, [...conflicted, ...rest].slice(0, 3), ref, now));
  // the response's content against the predicted fields (F1–F3), lists against recent creates (read-your-writes)
  const content = s.content ?? (s.body !== undefined ? analyzeBody(env, X, s.body, s.matched) : undefined);
  if (content) {
    const subject = s.channel === "response" ? "The response" : "This message";
    out.push(...pendingRevertFacts(env, s.conflicts, content.cmps, subject, now));
    out.push(...contentFacts(env, X, content.cmps, subject, now, { fields: s.matched }));
    out.push(...rywFacts(env, content.located.filter((l) => Array.isArray(l.value)).map((l) => ({ path: l.path, value: l.value as unknown[], loadedBy: X, fromResponse: true })), now));
  }
  out.push(...markFacts(env, [...conflicted, ...s.matched], now));
  const cf = cadenceFact(env, X.name, now);
  if (cf) out.push(cf);
  const stores = [...new Set(s.matched.map((f) => f.split(".")[0]))];
  out.push(...movedFacts(env, X, s.matched, stores, ref));
  out.push(...concurrencyFacts(env, X, stores, ref));
  if (s.req) {
    const st = env.base.stats(s.req.signature);
    const lat = env.base.latency(s.req.signature);
    if (lat && X.end !== undefined) out.push(fact(`${s.req.signature} usually answers in ${secs(lat.median)} (p95 ${secs(lat.p95)}).`, "baseline", true));
    if (st && st.failStreak > 0) out.push(fact(`The ${plural(st.failStreak, `${s.req.signature} request`)} before this one failed in a row.`, "outcome", true));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- requests

function failureText(f: FailureInfo): string {
  if (f.kind === "http") return `HTTP ${f.status}${f.statusText ? ` ${f.statusText}` : ""}`;
  if (f.kind === "timeout") return "timed out";
  return `network error${f.message ? ` (${truncate(f.message, 50)})` : ""}`;
}

function outcomesText(list: string[]): string {
  return list
    .slice(-5)
    .map((o) => {
      const l = outcomeLabel(o);
      return l === "network" ? "network error" : l;
    })
    .join(", ");
}

/** "error rate 60% over 5 requests (3 failed)" from real counts over the recent outcomes. */
function errorRateText(env: SitEnv, sig: string): string {
  const { failed, of } = env.base.failureCounts(sig);
  if (!of) return "no completed requests yet";
  return `error rate ${Math.round((failed / of) * 100)}% over ${plural(of, "request")} (${failed} failed)`;
}

function requestCommon(env: SitEnv, trigger: "request" | "failure" | "stall", op: OpRec, req: ReqMeta, now: number): Fact[] {
  const out: Fact[] = [];
  const self = trigger === "request" ? `This request (#${op.id})` : `The request (#${op.id})`;
  const cause = env.ops.get(op.cause);
  out.push(provenance(env, "This request", cause ?? null, now));
  if (op.attempt > 1) out.push(fact(`${self} is attempt ${op.attempt}: it was already retried ${times(op.attempt - 1)}.`, "outcome", true));
  // repetition by identity
  const ident = env.identical(req.identity).filter((o) => o.id !== op.id && now - o.start <= WINDOW && o.attempt === 1);
  if (ident.length) {
    const inflight = ident.filter((o) => o.end === undefined);
    const items = ident
      .slice(-3)
      .map((o) =>
        o.end === undefined
          ? `#${o.id} in flight (started ${secs(now - o.start)} ago)`
          : `#${o.id} ${o.status === "ok" ? "answered" : "ended"} ${statusText(o)} ${secs(now - (o.end ?? now))} ago`,
      );
    const last = ident[ident.length - 1];
    const u1 = env.ops.userOf(op);
    const u2 = env.ops.userOf(last);
    let rel = `#${last.id} started ${secs(Math.abs(op.start - last.start))} ${last.start > op.start ? "after" : "before"} this one`;
    if (u1 && u2 && u1.id === u2.id) rel += `, from the same user action (#${u1.id})`;
    else if (u1 && u2) {
      rel += `; they come from separate user actions ${secs(Math.abs(u1.start - u2.start))} apart`;
      out.push(repeatEvidence(env, u2, u1, last));
    }
    else if (!u1 && !u2) rel += ", neither from a user action";
    const gap = Math.abs(op.start - last.start);
    const id = env.base.identity(req.identity);
    const usualGap = id?.gapEwma;
    const close = inflight.length > 0 || gap < Math.min(2000, usualGap !== undefined && id!.n > 3 ? usualGap * 0.5 : 2000);
    const listed = ident.length > 3 ? ` (latest 3: ${items.join("; ")})` : `: ${items.join("; ")}`;
    out.push(fact(`${plural(ident.length, `identical ${req.signature} request`)} in the last 10s${listed}; ${rel}.`, "repetition", trigger === "request" ? !close : true));
  }
  // same signature, different input, in flight
  const sameSig = [...env.ops.inFlight].filter((o) => o.id !== op.id && o.name === op.name && o.identity !== req.identity);
  if (sameSig.length) {
    const items = sameSig.slice(0, 3).map((o) => `#${o.id}${o.detail ? ` ${truncate(o.detail, 30)}` : ""} (${startedRel(o, op)})`);
    out.push(fact(`${plural(sameSig.length, `other ${req.signature} request`)} with different input ${sameSig.length === 1 ? "is" : "are"} in flight: ${items.join("; ")}.`, "concurrency", true));
  }
  const st = env.base.stats(req.signature);
  // failure streak / outcome history
  if (st && st.failStreak > 0 && trigger !== "failure") {
    const ls = st.lastSuccess !== undefined ? `last success ${secs(now - st.lastSuccess)} ago` : "no success yet";
    out.push(
      fact(
        `The last ${plural(st.failStreak, `${req.signature} request`)} failed in a row (${outcomesText(st.outcomes)}); ${ls}.`,
        "outcome",
        trigger === "request" ? st.failStreak < 2 : true,
      ),
    );
  } else if (st && st.count > 0 && trigger === "stall") {
    out.push(fact(`Recent ${req.signature} outcomes: ${outcomesText(st.outcomes)}.`, "outcome", true));
  }
  // frequency vs usual
  const r = env.base.rate(req.signature, now);
  if (r.usual !== undefined && r.recent >= 3) {
    const hot = r.recent >= 5 && r.recent >= 3 * r.usual;
    out.push(fact(`${req.signature} was requested ${times(r.recent)} in the last 10s; usually ${fmtNum(r.usual)} per 10s (${ratio(r.recent, r.usual)}).`, "baseline", !hot));
  } else if (r.recent >= 3) {
    out.push(fact(`${req.signature} was requested ${times(r.recent)} in the last 10s (no usual rate learned yet).`, "baseline", true));
  }
  // latency / error rate baseline
  const lat = env.base.latency(req.signature);
  if (lat && trigger !== "stall") {
    out.push(fact(`${req.signature} usually answers in ${secs(lat.median)} (p95 ${secs(lat.p95)}, ${lat.n} samples); ${errorRateText(env, req.signature)}.`, "baseline", true));
  }
  // cache
  const c = req.method === "GET" ? env.cached(req.identity) : undefined;
  if (c) out.push(fact(`A cached ${c.status} response from ${secs(now - c.t)} ago exists for this request.`, "cache", true));
  // method semantics
  const body = req.method === "GET" || req.method === "HEAD" ? "" : req.replayable ? `; its body (${req.bodyBytes ?? 0} bytes) can be replayed` : "; its body cannot be replayed";
  out.push(fact(`${req.method} ${req.idempotent ? "is" : "is not"} idempotent${body}.`, "request", true));
  return out;
}

function failureFacts(env: SitEnv, op: OpRec, req: ReqMeta, f: FailureInfo, now: number): Fact[] {
  const st = env.base.stats(req.signature);
  const streak = st?.failStreak ?? 1;
  const out: Fact[] = [fact(`The request #${op.id} failed: ${failureText(f)} after ${secs(f.durMs)}; the app has not seen the failure yet.`, "outcome", false)];
  if (st) {
    const ls = st.lastSuccess !== undefined ? `last success ${secs(now - st.lastSuccess)} ago` : "no success yet";
    out.push(
      fact(
        `This is the ${ordinal(Math.max(1, streak))} ${req.signature} failure in a row (recent outcomes: ${outcomesText(st.outcomes)}; ${ls}); ${errorRateText(env, req.signature)}.`,
        "outcome",
        true,
      ),
    );
  }
  // writes the failing chain already made
  const cw = env.chainWrites(op);
  if (cw.length) out.push(fact(`Before this failure its chain wrote ${cw.slice(0, 4).map((w) => w.path).join(", ")}.`, "outcome", true));
  // whether the server may have applied it (F5), the failure's scope across endpoints, the endpoint's schedule (F6)
  const commit = commitAmbiguity(req.method, f, env.base.latency(req.signature));
  if (commit) out.push(fact(commit.text, "outcome", true));
  out.push(...scopeFacts(env, req.signature, now));
  const cf = cadenceFact(env, req.signature, now);
  if (cf) out.push(cf);
  return [...out, ...requestCommon(env, "failure", op, req, now)];
}

function stallFacts(env: SitEnv, op: OpRec, req: ReqMeta, now: number): Fact[] {
  const lat = env.base.latency(req.signature);
  const waited = now - op.start;
  const out: Fact[] = [];
  if (lat) out.push(fact(`The request #${op.id} has been in flight for ${secs(waited)}; ${req.signature} usually takes ${secs(lat.median)} (p95 ${secs(lat.p95)}, ${lat.n} samples), ${ratio(waited, lat.median)} the median.`, "baseline", false));
  else out.push(fact(`The request #${op.id} has been in flight for ${secs(waited)}.`, "baseline", false));
  const slowPeers = [...env.ops.inFlight].filter((o) => o.id !== op.id && o.name === op.name && lat && now - o.start > 3 * lat.median);
  if (slowPeers.length) out.push(fact(`${plural(slowPeers.length, `other ${req.signature} request`)} ${slowPeers.length === 1 ? "is" : "are"} also running past 3× the usual latency.`, "concurrency", true));
  out.push(...scopeFacts(env, req.signature, now));
  const cf = cadenceFact(env, req.signature, now);
  if (cf) out.push(cf);
  return [...out, ...requestCommon(env, "stall", op, req, now)];
}

// ---------------------------------------------------------------------------------- inconsistency / transition

function lastConsistentFact(env: SitEnv, now: number, before?: OpRec): Fact {
  const lc = before ? env.consistentBefore(before.startSeq) : env.lastConsistent();
  if (!lc) return fact(before ? `No consistent snapshot from before #${before.id} started exists.` : "No consistent snapshot has been recorded yet.", "invariant", true);
  const writes = env.hub.changedSince(lc.seq).reduce((n, x) => n + x.count, 0);
  const what = before ? `The last consistent state from before #${before.id} started` : "The last consistent state";
  return fact(`${what} is ${secs(now - lc.t)} old; ${plural(writes, "field write")} happened since.`, "invariant", true);
}

function inconsistencyFacts(env: SitEnv, vs: Violation[], now: number): Fact[] {
  const out: Fact[] = [];
  const lc = env.lastConsistent();
  for (const v of vs.slice(0, 3)) {
    out.push(
      fact(
        v.developer ? `The developer invariant "${v.text}" no longer holds.` : `The learned relation ${v.text} no longer holds: ${v.values}. It held at ${v.held} settled points before.`,
        "invariant",
        false,
      ),
    );
    // the latest writes to the involved fields since the last consistent snapshot
    const since = lc ? lc.seq : 0;
    const hs: { path: string; h: FieldHist }[] = [];
    for (const p of v.fields) for (const h of env.hub.writesSince(p, since)) hs.push({ path: p, h });
    hs.sort((a, b) => b.h.seq - a.h.seq);
    for (const { path, h } of hs.slice(0, 2)) {
      const w = env.ops.get(h.writer);
      out.push(fact(`${path} was written ${secs(now - h.t)} ago by ${opLabel(w)}${h.user ? " (user)" : ""}: ${changeText({ path, before: h.before, after: h.after }, env.redact)}.`, "versions", true));
    }
  }
  // values known to be suspicious (F9), lists reloaded after a create (read-your-writes)
  const fields = vs.flatMap((v) => v.fields);
  out.push(...markFacts(env, fields, now));
  out.push(...rywFacts(env, storeLists(env, fields), now));
  out.push(lastConsistentFact(env, now));
  const inflight = env.ops.inFlight.size;
  out.push(fact(inflight ? `${plural(inflight, "operation")} ${inflight === 1 ? "is" : "are"} in flight.` : "No operations are in flight (the app is settled).", "concurrency", true));
  return out;
}

function fieldsText(set: string): string {
  if (!set) return "nothing";
  const fs = set.split(",");
  return fs.length === 1 ? fs[0] : `${fs.slice(0, -1).join(", ")} and ${fs[fs.length - 1]}`;
}

function article(kind: string): string {
  if (kind === "null") return "null";
  if (kind === "undefined") return "undefined";
  return /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`;
}

function unusualText(sig: string, u: Unusual): string {
  const n = `In the previous ${u.of} completions of ${sig}`;
  switch (u.component) {
    case "set": {
      const usual = new Set(u.usual ? u.usual.split(",") : []);
      const obs = u.observed ? u.observed.split(",") : [];
      const subset = obs.length > 0 && obs.every((f) => usual.has(f)) && obs.length < usual.size;
      return `${n} its chain wrote ${fieldsText(u.usual)} (${u.usualCount} of ${u.of} times); this time it wrote ${subset ? "only " : ""}${fieldsText(u.observed)}${u.seen ? ` (seen ${times(u.seen)} before)` : ""}.`;
    }
    case "kind":
      return `${n} that wrote ${u.field}, it wrote ${article(u.usual)} (${u.usualCount} of ${u.of} times); this time it wrote ${article(u.observed)}.`;
    case "status":
      return `${n} it ended with ${u.usual} (${u.usualCount} of ${u.of} times); this time it ended with ${u.observed}.`;
    case "writes":
      return `${n} its chain made ${u.usual} write(s) (${u.usualCount} of ${u.of} times); this time it made ${u.observed}.`;
  }
}

function transitionFacts(env: SitEnv, op: OpRec, unusual: Unusual[], now: number): Fact[] {
  const out: Fact[] = unusual.slice(0, 3).map((u) => fact(unusualText(op.kind === "user" ? opPhrase(op) : op.name, u), "transition", false));
  const dur = op.end !== undefined ? op.end - op.start : 0;
  out.push(provenance(env, `The completed ${op.kind === "user" ? "user action" : "operation"} #${op.id}`, op.cause !== undefined ? env.ops.get(op.cause) : op, now));
  if (op.kind === "fetch" || op.kind === "xhr") {
    const lat = env.base.latency(op.name);
    out.push(fact(`It ended ${secs(now - (op.end ?? now))} ago with ${statusText(op)} after ${secs(dur)}${lat ? ` (usual ${secs(lat.median)})` : ""}.`, "baseline", true));
  }
  if (op.chain) {
    for (const [f] of [...op.chain].slice(0, 3)) {
      const v = env.hub.valueAt(f);
      if (v !== undefined || env.hub.field(f)) out.push(fact(`${f} is now ${describe(v, f, env.redact, 60)}.`, "delta", true));
    }
    const concrete = matchFields(env, [...op.chain.keys()]);
    out.push(...markFacts(env, concrete, now));
    out.push(...rywFacts(env, storeLists(env, concrete), now));
  }
  out.push(lastConsistentFact(env, now, env.ops.rootOf(op)));
  return out;
}

// ---------------------------------------------------------------------------------------------- errors / ask

function errorFacts(env: SitEnv, e: { name: string; message: string; source?: string; key: string }, op: OpRec | null, now: number): Fact[] {
  const out: Fact[] = [fact(`Uncaught ${e.name}: ${truncate(e.message, 120)}${e.source ? ` (at ${truncate(e.source, 60)})` : ""}.`, "error", false)];
  if (op) {
    const root = env.ops.rootOf(op);
    out.push(fact(`It was thrown while ${opLabel(op)} was active, ${secs(now - op.start)} after it started${root.id !== op.id ? `; that chain began with ${opLabel(root)}` : ""}.`, "provenance", true));
    const writes = env.chainWrites(op);
    if (writes.length) {
      const overwritten = writes.filter((w) => !w.lastIsChain).length;
      out.push(
        fact(
          `Its chain wrote ${writes.slice(0, 4).map((w) => w.path).join(", ")} before the error${overwritten ? ` (${overwritten} of them overwritten since by other operations)` : ""}.`,
          "versions",
          true,
        ),
      );
      out.push(...markFacts(env, writes.map((w) => w.path), now));
    } else out.push(fact("Its chain wrote no state before the error.", "versions", true));
  } else out.push(fact("No operation was active when it was thrown.", "provenance", true));
  const same = env.recentErrors().filter((x) => x.key === e.key);
  if (same.length > 1) out.push(fact(`The same error happened ${times(same.length)} in the last 10s.`, "repetition", true));
  out.push(lastConsistentFact(env, now, op ? env.ops.rootOf(op) : undefined));
  return out;
}

function askFacts(env: SitEnv, about: "now" | number | string, now: number): Fact[] {
  const out: Fact[] = [];
  if (typeof about === "number") {
    const op = env.ops.get(about);
    if (!op) return [fact(`Operation #${about} is not known.`, "provenance", true)];
    out.push(provenance(env, `Operation #${op.id} (${truncate(opPhrase(op), 60)})`, env.ops.get(op.cause) ?? op, now));
    if (op.end === undefined) out.push(fact(`It has been in flight for ${secs(now - op.start)}.`, "baseline", true));
    else out.push(fact(`It ended ${secs(now - op.end)} ago with ${statusText(op)} after ${secs(op.end - op.start)}.`, "outcome", true));
    const lat = env.base.latency(op.name);
    if (lat) out.push(fact(`${op.name} usually takes ${secs(lat.median)} (p95 ${secs(lat.p95)}).`, "baseline", true));
    if (op.chain?.size) out.push(fact(`Its chain wrote ${[...op.chain.keys()].slice(0, 5).join(", ")}.`, "versions", true));
    return out;
  }
  if (typeof about === "string" && about !== "now") {
    const s = env.hub.get(about);
    if (!s) return [fact(`Store ${about} is not registered.`, "provenance", true)];
    const fs = [...s.fields.values()].sort((a, b) => b.seq - a.seq).slice(0, 6);
    for (const f of fs) {
      const w = env.ops.get(f.writer);
      out.push(fact(`${f.path} is at version ${f.v}${f.v ? `, last written ${secs(now - f.t)} ago by ${opLabel(w)}` : ""}.`, "versions", true));
    }
    return out;
  }
  const inflight = [...env.ops.inFlight].filter((o) => o.kind !== "user");
  if (inflight.length) {
    const oldest = inflight.reduce((a, b) => (a.start <= b.start ? a : b));
    out.push(fact(`${plural(inflight.length, "operation")} ${inflight.length === 1 ? "is" : "are"} in flight; the oldest is ${opLabel(oldest)} (${secs(now - oldest.start)}).`, "concurrency", true));
  } else out.push(fact("No operations are in flight.", "concurrency", true));
  for (const s of env.base.sigs.values()) {
    if (s.failStreak > 0 && s.lastFailure !== undefined && now - s.lastFailure < 30_000)
      out.push(fact(`The last ${plural(s.failStreak, `${s.sig} request`)} failed in a row (${outcomesText(s.outcomes)}).`, "outcome", true));
  }
  const errs = env.recentErrors();
  if (errs.length) out.push(fact(`${plural(errs.length, "error")} happened in the last 10s.`, "error", true));
  for (const v of env.violations().slice(0, 2)) out.push(fact(`The learned relation ${v.text} does not hold: ${v.values}.`, "invariant", true));
  const reps = env.hub.recent.filter((r) => now - r.t <= WINDOW);
  const seen = new Map<string, number>();
  for (const r of reps) seen.set(r.key, (seen.get(r.key) ?? 0) + 1);
  for (const [k, n] of seen) if (n > 1) out.push(fact(`An identical change to ${k.split("|")[0]} was applied ${times(n)} in the last 10s.`, "repetition", true));
  return out;
}

// ---------------------------------------------------------------------------------------------- entry

export function computeFacts(env: SitEnv, s: SubjectSpec): Fact[] {
  const now = env.now();
  switch (s.trigger) {
    case "mutation":
      return mutationFacts(env, s.m, now);
    case "request":
      return requestCommon(env, "request", s.op, s.req, now);
    case "delivery":
      return deliveryFacts(env, s, now);
    case "failure":
      return failureFacts(env, s.op, s.req, s.failure, now);
    case "stall":
      return stallFacts(env, s.op, s.req, now);
    case "inconsistency":
      return inconsistencyFacts(env, s.violations, now);
    case "transition":
      return transitionFacts(env, s.op, s.unusual, now);
    case "error":
      return errorFacts(env, s.error, s.op, now);
    case "ask":
      return askFacts(env, s.about, now);
  }
}
