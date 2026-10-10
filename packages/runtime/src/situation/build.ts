// Situation assembly (CONTRACT §5, §6): subject sentence, facts, in-flight ops, timeline, relevant state, stats,
// applicable actions, standing questions and triage. The single implementation used by the runtime and the sim.

import type {
  ActionDef,
  Fact,
  Question,
  Situation,
  SituationDraft,
  StandingQuestion,
  SubjectRef,
  Tier,
  TriggerKind,
  Vocabulary,
} from "../types.js";
import { toChanges } from "../state/hub.js";
import type { OpRec } from "../trace/ops.js";
import { describe, fmtNum, secs, truncate } from "../util.js";
import { eventLine, opLabel, opPhrase } from "./describe.js";
import type { ReqMeta, SitEnv, SubjectSpec } from "./env.js";
import { computeFacts, MAX_FACTS, orderFacts, predictedText } from "./facts.js";
import { actionDescription, BUILTIN_ACTIONS, buildQuestions, COMPACT_QUESTIONS_BUDGET, TRIGGER_ACTIONS } from "./questions.js";
import { sectionLimits, STATE_CHAR_BUDGET, toJevState, type SectionLimits, type SituationParts } from "./serialize.js";

export interface BuildOptions {
  vocab?: Vocabulary;
  diagnoses: Record<string, string>;
  customActions: ActionDef[];
  questions: StandingQuestion[];
  pluginFacts: { name: string; fn: (d: SituationDraft) => string[] }[];
  triage: "salient" | "always";
  /** Situation size in characters (default 2,400). */
  budget?: number;
}

export interface ActionOption {
  name: string;
  tier: Tier;
  description: string;
  custom?: ActionDef;
}

export interface BuiltSituation {
  spec: SubjectSpec;
  draft: SituationDraft;
  situation: Situation;
  actions: ActionOption[];
  facts: Fact[];
  parts: SituationParts;
  salient: boolean;
  /** Standing questions asked on this trigger. */
  standing: StandingQuestion[];
  /** A standing question with `always` applies: consult even when nothing is salient. */
  forced: boolean;
  subjectRef: SubjectRef;
}

// ----------------------------------------------------------------------------------------------- subject

function failureShort(f: { kind: string; status?: number }): string {
  return f.kind === "http" ? `HTTP ${f.status}` : f.kind === "timeout" ? "timed out" : "network error";
}

export function subjectOf(env: SitEnv, s: SubjectSpec): { sentence: string; subject: string } {
  const now = env.now();
  switch (s.trigger) {
    case "mutation": {
      const paths = s.m.changes.map((c) => c.path);
      const p = paths.length > 3 ? `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more` : paths.join(", ") || s.m.store;
      const from = s.m.cause ? ` from ${opLabel(s.m.cause)}` : "";
      return { sentence: `A write to ${p}${from} is about to be applied.`, subject: `write to ${p}${from}` };
    }
    case "request":
      return { sentence: `${opLabel(s.op)} is about to be sent.`, subject: opLabel(s.op) };
    case "delivery": {
      if (s.channel === "response")
        return { sentence: `The response to ${opLabel(s.op)} arrived and is about to be delivered; ${predictedText(s)}.`, subject: `response to ${opLabel(s.op)}` };
      const what = `${s.channel === "websocket" ? "WebSocket" : "server-sent"} message ${s.message?.path ?? ""} (#${s.op.id})`.replace(/\s+/g, " ");
      return { sentence: `A ${what} arrived and is about to be delivered; ${predictedText(s)}.`, subject: `${what} ${s.message?.summary ?? ""}`.trim() };
    }
    case "failure":
      return { sentence: `${opLabel(s.op)} failed (${failureShort(s.failure)}) and the app has not seen the failure yet.`, subject: `${opLabel(s.op)} (${failureShort(s.failure)})` };
    case "stall":
      return { sentence: `${opLabel(s.op)} has been waiting ${secs(now - s.op.start)} for a response.`, subject: `${opLabel(s.op)}, waiting ${secs(now - s.op.start)}` };
    case "inconsistency": {
      const v = s.violations[0];
      const more = s.violations.length > 1 ? ` (and ${s.violations.length - 1} more)` : "";
      return { sentence: `The relation ${v ? v.text : "?"}${more} no longer holds now that the app is settled.`, subject: `relation ${v ? v.text : "?"}${more}` };
    }
    case "transition":
      return { sentence: `${opLabel(s.op)} completed with a state change unlike its usual ones.`, subject: `${opLabel(s.op)} state change` };
    case "error":
      return { sentence: `An uncaught ${s.error.name} was thrown: ${truncate(s.error.message, 120)}`, subject: `${s.error.name}: ${truncate(s.error.message, 80)}` };
    case "ask": {
      if (typeof s.about === "number") {
        const op = env.ops.get(s.about);
        return { sentence: `The developer asks about ${opLabel(op)}.`, subject: `question about ${opLabel(op)}` };
      }
      if (s.about !== "now") return { sentence: `The developer asks about the store ${s.about}.`, subject: `question about ${s.about}` };
      return { sentence: "The developer asks about the app right now.", subject: "question about the app" };
    }
  }
}

function subjectOp(env: SitEnv, s: SubjectSpec): OpRec | undefined {
  switch (s.trigger) {
    case "mutation":
      return s.m.cause ?? undefined;
    case "request":
    case "delivery":
    case "failure":
    case "stall":
    case "transition":
      return s.op;
    case "error":
      return s.op ?? undefined;
    case "ask":
      return typeof s.about === "number" ? env.ops.get(s.about) : undefined;
    default:
      return undefined;
  }
}

function involvedStores(env: SitEnv, s: SubjectSpec): string[] {
  const set = new Set<string>();
  const add = (p: string) => set.add(p.split(".")[0]);
  switch (s.trigger) {
    case "mutation":
      set.add(s.m.store);
      break;
    case "inconsistency":
      for (const v of s.violations) for (const f of v.fields) add(f);
      break;
    case "transition":
      for (const f of s.op.chain?.keys() ?? []) add(f);
      break;
    case "delivery":
      for (const f of s.predicted.patterns) add(f);
      break;
    case "error":
      if (s.op) for (const x of env.hub.changedSince(s.op.startSeq)) add(x.path);
      break;
    case "request":
    case "failure":
    case "stall":
      for (const [store] of env.storeWriters.get(s.op.name) ?? []) set.add(store);
      break;
    case "ask":
      if (typeof s.about === "string" && s.about !== "now") set.add(s.about);
      break;
  }
  return [...set].filter((x) => env.hub.get(x));
}

function involvedFields(s: SubjectSpec): string[] {
  switch (s.trigger) {
    case "mutation":
      return s.m.changes.map((c) => c.path);
    case "delivery":
      return [...s.conflicts.map((c) => c.path), ...s.matched];
    case "inconsistency":
      return s.violations.flatMap((v) => v.fields);
    case "transition":
      return [...(s.op.chain?.keys() ?? [])];
    default:
      return [];
  }
}

// ----------------------------------------------------------------------------------------------- sections

function timelineLines(env: SitEnv, s: SubjectSpec, subj: OpRec | undefined, stores: string[], L: SectionLimits): string[] {
  const now = env.now();
  const recent = env.events.last(96);
  const rel = new Set<number>();
  if (subj) {
    rel.add(subj.id);
    for (const a of env.ops.ancestors(subj)) rel.add(a.id);
  }
  const sig = subj && subj.kind !== "user" ? subj.name : undefined;
  const isRelevant = (e: (typeof recent)[number]): boolean => {
    if (e.kind === "user" || e.kind === "error" || e.kind === "action" || e.kind === "nav") return true;
    if (e.kind === "state") return stores.includes(String(e.data?.store ?? e.name));
    if (e.op !== undefined) {
      if (rel.has(e.op)) return true;
      const o = env.ops.get(e.op);
      if (o) {
        if (sig && o.name === sig) return true;
        if (subj && (o.root === subj.root || env.ops.isAncestorOrSelf(subj, o))) return true;
        if (stores.length && stores.some((st) => (env.storeWriters.get(o.name)?.get(st) ?? 0) > 0)) return true;
      }
    }
    return false;
  };
  const lines: { seq: number; line: string; relevant: boolean }[] = [];
  for (const e of recent) {
    const line = eventLine(e, now, (id) => env.ops.get(id));
    if (line) lines.push({ seq: e.seq, line, relevant: isRelevant(e) });
  }
  const relevant = lines.filter((l) => l.relevant).slice(-L.timeline);
  let picked = relevant;
  if (picked.length < L.timeline) {
    const extra = lines.filter((l) => !l.relevant).slice(-(L.timeline - picked.length));
    picked = [...picked, ...extra].sort((a, b) => a.seq - b.seq);
  }
  void s;
  return picked.map((l) => l.line);
}

function inFlightLines(env: SitEnv, subj: OpRec | undefined, L: SectionLimits): string[] {
  const now = env.now();
  const ops = [...env.ops.inFlight].filter((o) => o.kind !== "user" && o !== subj);
  const score = (o: OpRec) => (subj && o.name === subj.name ? 0 : subj && o.root === subj.root ? 1 : 2);
  ops.sort((a, b) => score(a) - score(b) || a.start - b.start);
  return ops.slice(0, L.in_flight).map((o) => {
    const by = o.cause !== undefined ? `, by #${o.cause}` : "";
    return `${truncate(opPhrase(o), 80)} (#${o.id}) ${secs(now - o.start)} so far${by}`;
  });
}

function stateLines(env: SitEnv, s: SubjectSpec, stores: string[], L: SectionLimits): string[] {
  const now = env.now();
  const first = involvedFields(s);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    if (seen.has(path) || out.length >= L.state) return;
    seen.add(path);
    const f = env.hub.field(path);
    const store = env.hub.get(path.split(".")[0]);
    const leaf = env.hub.leaf(path);
    if (!leaf) return; // parent paths of expanded objects, removed fields
    const v = leaf ? leaf.value : undefined;
    const val = store?.opts.describe && path === store.name ? truncate(String(store.opts.describe(v)), 90) : describe(v, path, env.redact, 90);
    const meta = f && f.v ? ` (v${f.v}${f.writer !== null ? `, by #${f.writer}` : ""} ${secs(now - f.t)} ago)` : " (v0)";
    out.push(`${path} = ${val}${meta}`);
  };
  for (const p of first) add(p);
  const rest: { path: string; seq: number }[] = [];
  for (const st of stores) {
    const rec = env.hub.get(st);
    if (!rec) continue;
    if (rec.opts.describe && !seen.has(rec.name)) {
      if (out.length < L.state) {
        out.push(`${rec.name} = ${truncate(String(rec.opts.describe(env.hub.read(rec))), 110)} (v${rec.version})`);
        seen.add(rec.name);
      }
      continue;
    }
    for (const f of rec.fields.values()) rest.push({ path: f.path, seq: f.seq });
  }
  rest.sort((a, b) => b.seq - a.seq);
  for (const r of rest) add(r.path);
  if (!out.length && s.trigger === "ask" && s.about === "now") {
    const all: { path: string; seq: number }[] = [];
    for (const rec of env.hub.stores.values()) for (const f of rec.fields.values()) all.push({ path: f.path, seq: f.seq });
    all.sort((a, b) => b.seq - a.seq);
    for (const r of all) add(r.path);
  }
  return out;
}

function statsLines(env: SitEnv, subj: OpRec | undefined, L: SectionLimits): string[] {
  const now = env.now();
  const sigs: string[] = [];
  if (subj && (subj.kind === "fetch" || subj.kind === "xhr" || subj.kind === "ws" || subj.kind === "task")) sigs.push(subj.name);
  for (const o of env.ops.inFlight) if ((o.kind === "fetch" || o.kind === "xhr") && !sigs.includes(o.name)) sigs.push(o.name);
  const out: string[] = [];
  for (const sig of sigs) {
    if (out.length >= L.stats) break;
    const st = env.base.stats(sig);
    if (!st || st.count === 0) continue;
    const lat = env.base.latency(sig);
    const r = env.base.rate(sig, now);
    const parts = [`${st.count} done`];
    if (lat) parts.push(`median ${secs(lat.median)}`, `p95 ${secs(lat.p95)}`);
    const fc = env.base.failureCounts(sig);
    parts.push(`${fc.failed} of last ${fc.of} failed`);
    parts.push(`${r.recent} in last 10s${r.usual !== undefined ? ` (usual ${fmtNum(r.usual)})` : ""}`);
    out.push(`${sig}: ${parts.join(", ")}`);
  }
  return out;
}

// --------------------------------------------------------------------------------------------- actions

/**
 * Whether repeating a request is safe by HTTP semantics: idempotent methods (GET, HEAD, OPTIONS, PUT, DELETE, TRACE)
 * always; any other method (POST, PATCH, ...) only with an idempotency key header (`policy.idempotencyHeaders`).
 * Null when safe, else why not.
 */
export function repeatUnsafe(env: SitEnv, req: ReqMeta): string | null {
  if (req.idempotent) return null;
  const keys = env.idempotencyHeaders();
  if (req.headers?.some((h) => keys.has(h))) return null;
  // opt-in (policy.idempotencyBodyFields): a key field in the JSON body that the server deduplicates on
  const fields = env.idempotencyBodyFields?.();
  if (fields?.size && req.bodyKeys?.some((k) => fields.has(k))) return null;
  return `${req.method} is not idempotent and the request has no idempotency key header (${[...keys].join(", ") || "none configured"})`;
}

/** Why a built-in action is not offered for this subject (null when it is). */
export function builtinUnavailable(env: SitEnv, s: SubjectSpec, name: string): string | null {
  const why = (ok: boolean, reason: string): string | null => (ok ? null : reason);
  switch (s.trigger) {
    case "mutation":
      if (env.observedOnly?.(s.m.store)) return `${s.m.store} is observed only: GenClass cannot hold, drop or revert its writes`;
      return why(name !== "defer" || s.m.defers < 2, "the write was already deferred twice");
    case "delivery":
      if (name === "discard") return why(deliveryDroppable(env, [...s.conflicts.map((c) => c.path), ...s.matched]), "the fields it would write are in observed-only stores (GenClass cannot drop those writes)");
      if (name === "defer") {
        if (s.defers >= 2) return "the delivery was already deferred twice";
        return why(relatedInFlight(env, s.op, s.matched).length > 0, "no related operation is in flight");
      }
      return null;
    case "request":
      if (name === "coalesce") {
        if (s.req.transport !== "fetch") return "coalescing is only available for fetch";
        return why(env.canCoalesce(s.req.identity, s.op.id), "no identical request is in flight or just finished with a shareable response");
      }
      if (name === "serve_cached") {
        if (s.req.method !== "GET") return `${s.req.method} responses are never served from cache`;
        return why(!!env.cached(s.req.identity), "no cached response exists for this request");
      }
      return null;
    case "failure":
      if (name === "retry") {
        if (s.req.transport !== "fetch") return "XMLHttpRequest failures reach the app directly (detection only)";
        if (!s.req.replayable) return "the request body cannot be replayed";
        if (s.op.attempt >= 4) return "the request was already attempted 4 times";
        return repeatUnsafe(env, s.req);
      }
      if (name === "serve_cached") {
        if (s.req.transport !== "fetch") return "XMLHttpRequest failures reach the app directly (detection only)";
        if (s.req.method !== "GET") return `${s.req.method} responses are never served from cache`;
        return why(!!env.cached(s.req.identity), "no cached response exists for this request");
      }
      return null;
    case "stall":
      if (name === "hedge") {
        if (s.req.transport !== "fetch") return "hedging is only available for fetch";
        if (s.req.method !== "GET") return `only GET requests are hedged (${s.req.method})`;
        if (!s.req.replayable) return "the request cannot be replayed";
        return repeatUnsafe(env, s.req);
      }
      if (name === "serve_cached") {
        if (s.req.transport !== "fetch") return "serving from cache is only available for fetch";
        if (s.req.method !== "GET") return `${s.req.method} responses are never served from cache`;
        return why(!!env.cached(s.req.identity), "no cached response exists for this request");
      }
      return null;
    default:
      return builtinApplicable(env, s, name) ? null : notApplicableReason(s, name);
  }
}

function notApplicableReason(s: SubjectSpec, name: string): string {
  if (name === "resync") return "no involved store has a resync handler";
  if (name === "rollback") return s.trigger === "inconsistency" ? "no consistent snapshot of a writable involved store exists" : "the operation's own chain wrote no state that can be restored";
  return "not applicable here";
}

/** Applicability of the state actions (inconsistency, transition, error triggers). */
function builtinApplicable(env: SitEnv, s: SubjectSpec, name: string): boolean {
  switch (s.trigger) {
    case "inconsistency": {
      const stores = [...new Set(s.violations.flatMap((v) => v.fields.map((f) => f.split(".")[0])))];
      if (name === "rollback") return !!env.lastConsistent() && stores.some((st) => env.writable(st));
      if (name === "resync") return stores.some((st) => env.resyncable(st));
      return true;
    }
    case "transition": {
      const stores = [...new Set([...(s.op.chain?.keys() ?? [])].map((f) => f.split(".")[0]))];
      if (name === "rollback") return revertableChain(env, s.op);
      if (name === "resync") return stores.some((st) => env.resyncable(st));
      return true;
    }
    case "error":
      // rollback only when the failing op's own chain wrote state (and only that state is restored)
      if (name === "rollback") return !!s.op && revertableChain(env, s.op);
      return true;
    case "ask":
      return false;
    default:
      return true;
  }
}

/**
 * A delivery `discard` acts at the store (it drops the chain's writes over newer data), so it can only work when one of
 * the fields the delivery would write is not in an observed-only store (whose writes already happened in the app).
 */
export function deliveryDroppable(env: SitEnv, paths: string[]): boolean {
  if (!paths.length || !env.observedOnly) return true;
  return paths.some((p) => !env.observedOnly!(p.split(".")[0]));
}

/** In-flight ops (outside x's chain) with x's signature, or whose chains wrote one of these fields' stores. */
export function relatedInFlight(env: SitEnv, x: OpRec, fields: string[]): OpRec[] {
  const stores = new Set(fields.map((f) => f.split(".")[0]));
  const out: OpRec[] = [];
  for (const o of env.ops.inFlight) {
    if (o === x || o.kind === "user" || env.ops.isAncestorOrSelf(o, x) || env.ops.isAncestorOrSelf(x, o)) continue;
    if (o.name === x.name || [...stores].some((st) => (env.storeWriters.get(o.name)?.get(st) ?? 0) > 0)) out.push(o);
  }
  return out;
}

/** The op's chain wrote fields that nobody overwrote since and whose earlier value is known. */
function revertableChain(env: SitEnv, op: OpRec): boolean {
  return env.chainWrites(op).some((w) => w.lastIsChain && w.before !== undefined && env.writable(w.path.split(".")[0]));
}

// ----------------------------------------------------------------------------------------------- build

export function buildSituation(env: SitEnv, s: SubjectSpec, o: BuildOptions, precomputed?: Fact[]): BuiltSituation {
  const now = env.now();
  const budget = o.budget ?? STATE_CHAR_BUDGET;
  const L = sectionLimits(budget);
  const { sentence, subject } = subjectOf(env, s);
  const subj = subjectOp(env, s);
  const stores = involvedStores(env, s);
  let facts = precomputed ? [...precomputed] : computeFacts(env, s);
  const inFlightOps = [...env.ops.inFlight].filter((x) => x.kind !== "user");
  const draft: SituationDraft = {
    trigger: s.trigger,
    subject,
    now,
    stores,
    facts,
    inFlight: inFlightOps,
  };
  if (subj) {
    draft.op = subj;
    const root = env.ops.rootOf(subj);
    if (root) draft.root = root;
  }
  if (s.trigger === "mutation") draft.mutation = { id: s.m.id, store: s.m.store, changes: toChanges(s.m.changes) };
  if (s.trigger === "delivery") draft.delivery = { channel: s.channel, predicted: s.predicted.patterns, conflicts: s.conflicts.map((c) => c.path) };
  if (s.trigger === "request" || s.trigger === "failure" || s.trigger === "stall" || (s.trigger === "delivery" && s.req)) {
    const req = s.trigger === "delivery" ? s.req! : s.req;
    draft.request = {
      method: req.method,
      url: req.url,
      signature: req.signature,
      identity: req.identity,
      idempotent: req.idempotent,
      replayable: req.replayable,
      ...(!req.idempotent && repeatUnsafe(env, req) === null ? { idempotencyKey: true } : {}),
      identicalInFlight: env.identical(req.identity).filter((x) => x.end === undefined && x.id !== s.op.id).map((x) => x.id),
      cached: !!env.cached(req.identity),
    };
  }
  if (s.trigger === "failure") draft.failure = { kind: s.failure.kind, ...(s.failure.status !== undefined ? { status: s.failure.status } : {}), ...(s.failure.message ? { message: s.failure.message } : {}) };
  if (s.trigger === "error") draft.error = { name: s.error.name, message: s.error.message, ...(s.error.source ? { source: s.error.source } : {}) };
  if (s.trigger === "inconsistency") draft.invariants = s.violations.map((v) => ({ id: v.id, text: v.text }));
  // plugin facts (neutral)
  for (const pf of o.pluginFacts) {
    try {
      for (const t of pf.fn(draft) ?? []) if (typeof t === "string" && t.trim()) facts.push({ text: truncate(t.trim(), 240), kind: "plugin", neutral: true });
    } catch {
      /* a plugin's facts never break situation building */
    }
  }
  // all ordered facts (≤ 12) are kept for reports and explain(); the budget decides how many the model reads
  facts = orderFacts(facts).slice(0, MAX_FACTS);
  draft.facts = facts;
  // actions
  const actions: ActionOption[] = [];
  const notOffered: Record<string, string> = {};
  for (const name of TRIGGER_ACTIONS[s.trigger]) {
    const no = builtinUnavailable(env, s, name);
    if (no) {
      notOffered[name] = no;
      continue;
    }
    const b = BUILTIN_ACTIONS[name];
    actions.push({ name, tier: b.tier, description: actionDescription(name, o.vocab, undefined, s.trigger) });
  }
  for (const def of o.customActions) {
    if (!def.on.includes(s.trigger) || actions.some((a) => a.name === def.name)) continue;
    let ok = true;
    try {
      ok = def.applicable ? !!def.applicable(draft) : true;
    } catch {
      ok = false;
    }
    if (ok) actions.push({ name: def.name, tier: def.tier ?? "heal", description: actionDescription(def.name, o.vocab, def.description), custom: def });
  }
  // questions
  const standing = o.questions.filter((q) => q.on.includes(s.trigger));
  const extra: Record<string, Question> = {};
  for (const q of standing) extra[q.id] = q.question;
  const compact = budget <= COMPACT_QUESTIONS_BUDGET;
  const questions = buildQuestions(s.trigger, actions, o.diagnoses, extra, compact, o.vocab);
  // sections
  const parts: SituationParts = {
    app: appText(env),
    trigger: sentence,
    facts: facts.map((f) => f.text),
    in_flight: inFlightLines(env, subj, L),
    timeline: timelineLines(env, s, subj, stores, L),
    state: stateLines(env, s, stores, L),
    stats: statsLines(env, subj, L),
  };
  const state = toJevState(parts, budget);
  const salient = o.triage === "always" || s.trigger === "ask" || facts.some((f) => !f.neutral);
  const situation: Situation = {
    trigger: s.trigger,
    subject,
    state,
    questions,
    actions: actions.map((a) => a.name),
    ...(Object.keys(notOffered).length ? { notOffered } : {}),
    salient,
    facts: facts.map((f) => f.text),
    compact,
    budget,
  };
  return { spec: s, draft, situation, actions, facts, parts, salient, standing, forced: standing.some((q) => q.always), subjectRef: subjectRef(s) };
}

function appText(env: SitEnv): string {
  let a: { title?: string; route?: string } = {};
  try {
    a = env.app() ?? {};
  } catch {
    /* ignore */
  }
  const title = (a.title ?? "").trim();
  const route = (a.route ?? "").trim();
  if (title && route) return `${title} — ${route}`;
  return title || route || "unknown";
}

export function subjectRef(s: SubjectSpec): SubjectRef {
  switch (s.trigger) {
    case "mutation": {
      const r: SubjectRef = { kind: "mutation", mutation: s.m.id, store: s.m.store, paths: s.m.changes.map((c) => c.path) };
      if (s.m.cause) r.cause = s.m.cause.id;
      return r;
    }
    case "request":
    case "failure":
    case "stall":
      return { kind: s.trigger, op: s.op.id };
    case "delivery": {
      const r: SubjectRef = { kind: "delivery", op: s.op.id };
      const paths = s.conflicts.length ? s.conflicts.map((c) => c.path) : s.matched;
      if (paths.length) {
        r.paths = paths;
        r.store = paths[0].split(".")[0];
      }
      return r;
    }
    case "transition": {
      const paths = [...(s.op.chain?.keys() ?? [])];
      const r: SubjectRef = { kind: "transition", op: s.op.id, paths };
      if (paths.length) r.store = paths[0].split(".")[0];
      return r;
    }
    case "inconsistency": {
      const v = s.violations[0];
      const paths = s.violations.flatMap((x) => x.fields);
      const r: SubjectRef = { kind: "inconsistency", paths };
      if (paths.length) r.store = paths[0].split(".")[0];
      if (v) r.invariant = v.text;
      return r;
    }
    case "error": {
      const r: SubjectRef = { kind: "error", error: s.error.raw };
      if (s.op) r.op = s.op.id;
      return r;
    }
    case "ask": {
      const r: SubjectRef = { kind: "ask" };
      if (typeof s.about === "number") r.op = s.about;
      else if (s.about !== "now") r.store = s.about;
      return r;
    }
  }
}

export function isTrigger(x: unknown): x is TriggerKind {
  return typeof x === "string" && x in TRIGGER_ACTIONS;
}
