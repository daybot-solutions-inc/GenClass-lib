// Executes one scenario: either the ideal world (no runtime, zero latency, no failures, exactly-once, only
// intended user actions) or the real world on the real runtime with a recording decider that forces actions by
// decision index. Records client-state snapshots (for time-integrated divergence), the final client and server
// state, decisions (state + questions exactly as handed to the decider), ask probes and the sim's knowledge.

import { AppEnv, PlainBackend, type SimGlobal, type StoreBackend } from "../app/env.js";
import { FEATURES } from "../app/features/index.js";
import type { FeatureClient, Relation, WorldCtx } from "../app/feature.js";
import { Kit } from "../app/kit.js";
import { VirtualLoop } from "../loop.js";
import { BASE_URL, IDEAL_PROFILE, Network, type NetEntry } from "../net/network.js";
import { API_STYLES, Db, VirtualServer, type ServerSnapshot } from "../net/server.js";
import { diagnose, type Subject } from "../oracle/diagnose.js";
import { Knowledge, type SimOp, type SimWrite } from "../oracle/knowledge.js";
import { hashAll, Rng } from "../rng.js";
import { PASSIVE, type Answer, type DecisionProvider, type EvaluateRequest, type JevState, type Question } from "../types.js";
import type { Scenario } from "../world/scenario.js";
import type { RuntimeFactory, RuntimeLike, SituationLike } from "./rt.js";

export interface Snapshot {
  t: number;
  state: Record<string, unknown>;
}

export interface DecisionRec {
  k: number;
  t: number;
  trigger: string;
  state: JevState;
  questions: Record<string, Question>;
  actions: string[];
  chosen: string;
  explored: boolean;
  diagnosis?: string;
  subject: { kind: Subject["kind"]; ref?: number; how: string };
  fakeDiagnosis?: boolean;
  /** JSON of state+questions for prefix-equality checks. */
  fp: string;
}

export interface AskRec {
  t: number;
  state: JevState;
  /** Facts about the trace at that instant (sim knowledge), for programmatic questions. */
  facts: AskFacts;
}

export interface AskFacts {
  now: number;
  inflight: { sig: string; method: string; age: number; write: boolean; feature: string }[];
  recent: { sig: string; method: string; status?: number; outcome: string; t: number; td: number }[];
  lastUserAt: number;
  userWaitingMs: number;
  stores: Record<string, unknown>;
  errorsShown: number;
  lastSave?: { ok: boolean; t: number };
  searchFresh?: boolean;
  route: string;
}

export interface ExplorePolicy {
  /** Return an action (must be applicable) for decision k, or undefined for passive. */
  choose(rec: Omit<DecisionRec, "chosen" | "explored" | "fp">, rng: Rng): string | undefined;
}

export interface RunOptions {
  ideal: boolean;
  factory?: RuntimeFactory;
  /** Forced actions by decision index (real runs). */
  forced?: Map<number, string>;
  /** Decisions >= this index take the passive action (counterfactual future). Default: none forced. */
  explore?: ExplorePolicy;
  /** Record decision states (base run). */
  record?: boolean;
  /** Probe runtime.situation("ask") at the scenario's ask times. */
  probeAsk?: boolean;
  /** Stop recording fingerprints after this index (cf runs check the prefix up to k). */
  fpUpTo?: number;
  /** Stop the run at this virtual time (counterfactual runs end at decision + horizon). Default scn.tEnd. */
  tStop?: number;
  /** Record the server state over time (ideal run: costs compare the server at decision + horizon). */
  serverTimeline?: boolean;
}

export interface RunResult {
  ideal: boolean;
  snapshots: Snapshot[];
  final: Record<string, unknown>;
  server: ServerSnapshot;
  decisions: DecisionRec[];
  asks: AskRec[];
  know: Knowledge;
  netLog: NetEntry[];
  shownErrors: number;
  uncaught: number;
  shownErrorTimes: number[];
  uncaughtTimes: number[];
  userOpMs: number;
  serverCounts: Map<string, number>;
  internalErrors: unknown[];
  tasks: number;
  tEnd: number;
  /** Time the run stopped (tEnd or tStop). */
  tStop: number;
  serverTimeline?: { t: number; server: ServerSnapshot }[];
  weights: Map<string, Record<string, number>>;
  relations: Relation[];
  storeFeature: Map<string, string>;
}

function makeGlobal(loop: VirtualLoop, net: Network, title: string): SimGlobal {
  const intervals = new Set<{ cancelled: boolean; task: unknown }>();
  const url = new URL(BASE_URL);
  const G: SimGlobal = {
    fetch: net.fetch,
    setTimeout: (fn: () => void, ms?: number) => loop.schedule(ms ?? 0, fn, "app"),
    clearTimeout: (h: unknown) => loop.cancel(h),
    setInterval: (fn: () => void, ms?: number) => {
      const h = { cancelled: false, task: null as unknown };
      const period = Math.max(1, ms ?? 0);
      const tick = () => {
        if (h.cancelled) return;
        h.task = loop.schedule(period, tick, "app");
        fn();
      };
      h.task = loop.schedule(period, tick, "app");
      intervals.add(h);
      return h;
    },
    clearInterval: (h: unknown) => {
      const x = h as { cancelled: boolean; task: unknown } | null;
      if (!x) return;
      x.cancelled = true;
      loop.cancel(x.task);
    },
    location: { href: `${url.origin}/`, pathname: "/", search: "", origin: url.origin, host: url.host },
    document: { title },
  };
  return G;
}

function answerFor(q: Question, choice?: string): Answer {
  if (q.type === "noul") return { type: "noul", noul: 0.5 };
  if (q.type === "score") {
    const probs: Record<string, number> = {};
    q.criteria.forEach((c, i) => (probs[String(i)] = i === 0 ? 1 : 0));
    return { type: "score", score: 0, confidence: 1, probabilities: probs };
  }
  const keys = Object.keys(q.criteria);
  const c = choice && keys.includes(choice) ? choice : keys[0]!;
  const probabilities: Record<string, number> = {};
  for (const k of keys) probabilities[k] = k === c ? 1 : 0;
  return { type: "choice", choice: c, confidence: 1, probabilities };
}

export async function runScenario(scn: Scenario, o: RunOptions): Promise<RunResult> {
  const loop = new VirtualLoop();
  const db = new Db(scn.idStyle, `db-${scn.seed}`);
  const server = new VirtualServer(db);
  const relations: Relation[] = [];
  for (const f of scn.features) {
    const def = FEATURES[f.kind]!;
    def.server(f.spec, server, db);
    if (def.relations) relations.push(...def.relations(f.spec));
  }
  const network = new Network(loop, server, o.ideal ? IDEAL_PROFILE : scn.net, hashAll("net", scn.seed));
  const G = makeGlobal(loop, network, scn.appTitle);
  const know = new Knowledge();
  know.now = () => loop.now();
  network.onSend = (e) => {
    if (e.simOp !== undefined) {
      const op = know.getOp(e.simOp);
      if (op) (op.net ??= []).push(e.id);
    }
  };
  const decisions: DecisionRec[] = [];
  const asks: AskRec[] = [];
  let runtime: RuntimeLike | null = null;
  let lastError: unknown = null;
  let env: AppEnv;
  const appRng = new Rng(hashAll("app", scn.seed));

  // ------------------------------------------------------------------------------------- decider (real)
  let k = 0;
  const exploreRng = new Rng(hashAll("explore", scn.seed));
  const decider: DecisionProvider = {
    status: { state: "ready", model: "genclass-sim" },
    ready: () => Promise.resolve(),
    evaluate: (req: EvaluateRequest) => {
      const idx = k++;
      const t = loop.now();
      const questions = req.questions;
      const aq = questions.action;
      const actions = aq && aq.type === "choice" ? Object.keys(aq.criteria) : [];
      const subject = correlate(req);
      let diag: string | undefined;
      try {
        diag = diagnose(req.trigger, subject.s, { know, network, relations, now: t, stores: () => env.snapshot() });
      } catch {
        diag = undefined;
      }
      const passive = PASSIVE[req.trigger] ?? actions[0] ?? "";
      let chosen = o.forced?.get(idx);
      let explored = false;
      const base = { k: idx, t, trigger: req.trigger, state: req.state, questions, actions, subject: { kind: subject.s.kind, how: subject.how, ...(subject.ref !== undefined ? { ref: subject.ref } : {}) }, ...(diag !== undefined ? { diagnosis: diag } : {}) };
      if (chosen === undefined && o.explore) {
        const c = o.explore.choose(base, exploreRng.fork(idx));
        if (c && actions.includes(c) && c !== passive) {
          chosen = c;
          explored = true;
        }
      }
      if (chosen === undefined || !actions.includes(chosen)) chosen = actions.includes(passive) ? passive : actions[0] ?? passive;
      // The guard/heal gate requires a non-"expected" top diagnosis for non-passive actions (unless the runtime
      // supports policy.requireDiagnosis = false). Answer with the sim's label; when it is "expected" and a
      // non-passive action is forced, answer with another label and flag it.
      let ansDiag = diag ?? "expected";
      let fake = false;
      const dq = questions.diagnosis;
      if (chosen !== passive && ansDiag === "expected" && dq && dq.type === "choice") {
        const keys = Object.keys(dq.criteria).filter((x) => x !== "expected");
        ansDiag = keys.includes("unusual") ? "unusual" : keys[0] ?? "expected";
        fake = true;
      }
      const answers: Record<string, Answer> = {};
      for (const [qid, q] of Object.entries(questions)) {
        if (qid === "action") answers[qid] = answerFor(q, chosen);
        else if (qid === "diagnosis") answers[qid] = answerFor(q, ansDiag);
        else answers[qid] = answerFor(q);
      }
      if (o.record || (o.fpUpTo !== undefined && idx <= o.fpUpTo)) {
        const rec: DecisionRec = { ...base, chosen, explored, fp: o.fpUpTo !== undefined || o.record ? JSON.stringify([req.trigger, req.state, questions]) : "" };
        if (fake) rec.fakeDiagnosis = true;
        if (!o.record) {
          rec.state = {};
          rec.questions = {};
        }
        decisions.push(rec);
      }
      const ms = new Rng(hashAll("model-latency", scn.seed, idx)).lognormal(scn.modelMs, 0.35);
      return new Promise((resolve) => loop.schedule(ms, () => resolve(answers), "runtime"));
    },
  };

  /** Runtime-issued ops (retry, hedge, resync) map to the app op of their causal parent when it is a request. */
  const rtParents = new Map<number, number>();
  function rtOpViaCause(id: number): number | undefined {
    let cur: number | undefined = id;
    for (let i = 0; i < 6 && cur !== undefined; i++) {
      const sim = know.rtOps.get(cur);
      if (sim !== undefined) return sim;
      cur = rtParents.get(cur);
    }
    return undefined;
  }
  function correlate(req: EvaluateRequest): { s: Subject; how: string; ref?: number } {
    const sub = (req.subject && typeof req.subject === "object" ? req.subject : null) as Record<string, unknown> | null;
    const trig = req.trigger;
    if (trig === "mutation") {
      if (sub && typeof sub.mutation === "number" && know.rtMutations.has(sub.mutation)) {
        const w = know.getWrite(know.rtMutations.get(sub.mutation));
        if (w) return { s: { kind: "write", write: w }, how: "subject", ref: w.id };
      }
      if (know.writing) return { s: { kind: "write", write: know.writing }, how: "sync", ref: know.writing.id };
      return { s: { kind: "unknown" }, how: "none" };
    }
    if (trig === "request" || trig === "failure" || trig === "stall" || trig === "transition") {
      if (sub && typeof sub.op === "number") {
        const simId = know.rtOps.get(sub.op) ?? rtOpViaCause(sub.op);
        const op = know.getOp(simId);
        if (op) {
          const net = trig === "failure" && network.lastDelivered && network.lastDelivered.simOp === op.id ? network.lastDelivered : undefined;
          return { s: { kind: "op", op, ...(net ? { net } : {}) }, how: "subject", ref: op.id };
        }
      }
      if (trig === "transition" && sub && typeof sub.op === "number") {
        // A user action or timer op: its chain's app ops are the ops whose runtime op descends from it.
        const root = sub.op;
        const chain = know.ops.filter((x) => {
          let cur = x.rtOp;
          for (let i = 0; i < 8 && cur !== undefined; i++) {
            if (cur === root) return true;
            cur = know.rtParents.get(cur);
          }
          return false;
        });
        const intent = know.rtUserOps.get(root);
        return { s: { kind: "chain", chain, ...(intent !== undefined ? { intent } : {}) }, how: "chain" };
      }
      if (trig === "request" && know.callingOp) return { s: { kind: "op", op: know.callingOp }, how: "sync", ref: know.callingOp.id };
      if (trig === "failure" && network.lastDelivered) {
        const e = network.lastDelivered;
        const op = e.simOp !== undefined ? know.getOp(e.simOp) : undefined;
        if (op) return { s: { kind: "op", op, net: e }, how: "delivered", ref: op.id };
      }
      return { s: { kind: "unknown" }, how: "none" };
    }
    if (trig === "error") {
      const err = sub && "error" in sub ? sub.error : lastError;
      return { s: { kind: "error", error: err }, how: sub && "error" in sub ? "subject" : "last" };
    }
    if (trig === "inconsistency") {
      const paths = sub && Array.isArray(sub.paths) ? (sub.paths as string[]).join(" ") : "";
      const inv = sub && typeof sub.invariant === "string" ? `${sub.invariant} ${paths}` : extractTriggerText(req.state);
      return { s: { kind: "invariant", invariant: inv }, how: sub ? "subject" : "text" };
    }
    return { s: { kind: "unknown" }, how: "none" };
  }

  // --------------------------------------------------------------------------------------------- world
  let backend: StoreBackend;
  if (o.ideal) backend = new PlainBackend();
  else {
    if (!o.factory) throw new Error("real runs need a runtime factory");
    runtime = o.factory({
      clock: loop.clockFor("runtime"),
      global: G,
      decider,
      ...(scn.diagnoses ? { diagnoses: scn.diagnoses } : {}),
      ...(scn.actionWords ? { actions: scn.actionWords } : {}),
      // Exact correlation: the runtime creates the fetch op synchronously inside the app's fetch call and the
      // mutation synchronously inside atom.set, while the sim's ambient tag (callingOp / writing) is set.
      hooks: {
        opCreated(op) {
          if (op.cause !== undefined) {
            rtParents.set(op.id, op.cause);
            know.rtParents.set(op.id, op.cause);
          }
          if (op.kind === "user" && know.callingIntent !== null) know.rtUserOps.set(op.id, know.callingIntent);
          const c = know.callingOp;
          if (c && (op.kind === "fetch" || op.kind === "xhr") && c.rtOp === undefined) {
            know.rtOps.set(op.id, c.id);
            c.rtOp = op.id;
          }
        },
        mutationProposed(m) {
          const w = know.writing;
          if (w && w.store === m.store && w.rtMutation === undefined) {
            know.rtMutations.set(m.id, w.id);
            w.rtMutation = m.id;
          }
        },
      },
      app: () => ({ title: scn.appTitle, route: env?.route ?? "/" }),
    });
    const rt = runtime;
    backend = { atom: (name, initial, opts) => rt.atom(name, initial, opts) };
  }
  env = new AppEnv(o.ideal, G, backend, know, appRng, (topic, fn) => network.subscribe(topic, fn), () => loop.now());
  const storeFeature = new Map<string, string>();
  env.onUncaught = (err, source) => {
    lastError = err;
    if (runtime) runtime.reportError(err, { source });
  };
  loop.onAppError = (e) => {
    if (e && typeof e === "object" && !know.errors.has(e)) know.tagError(e, { cause: "handler-threw", feature: "?", diagnosis: "failing" });
    env.uncaught(e, "window.onerror");
  };
  const clients = new Map<string, FeatureClient>();
  const api = API_STYLES.find((a) => a.name === scn.api) ?? API_STYLES[0]!;
  env.setRoute(scn.features[0]?.route ?? "/");
  for (const f of scn.features) {
    const def = FEATURES[f.kind]!;
    const kit = new Kit(env, f.id, api);
    clients.set(f.id, def.client(f.spec, env, kit));
  }
  for (const s of env.stores) storeFeature.set(s.name, s.feature);
  const world: WorldCtx = { db, server, publish: (t, m) => network.publish(t, m), now: () => loop.now() };

  // Snapshots of the client-visible state after every settled macrotask that changed it.
  const snapshots: Snapshot[] = [];
  const serverTimeline: { t: number; server: ServerSnapshot }[] | undefined = o.serverTimeline ? [] : undefined;
  let lastWrites = -1;
  loop.onSettled = () => {
    if (env.dirty) {
      env.dirty = false;
      snapshots.push({ t: loop.now(), state: env.snapshot() });
    }
    if (serverTimeline && db.writes !== lastWrites) {
      lastWrites = db.writes;
      serverTimeline.push({ t: loop.now(), server: db.snapshot() });
    }
  };
  if (serverTimeline) {
    lastWrites = db.writes;
    serverTimeline.push({ t: 0, server: db.snapshot() });
  }

  // Initial load.
  loop.at(0, () => {
    for (const c of clients.values()) c.init?.();
  }, "app");
  // User steps.
  const lastIntent = new Map<string, number>();
  for (const st of scn.steps) {
    if (o.ideal && (st.intent.accidental || st.when)) continue;
    loop.at(st.t, () => {
      const client = clients.get(st.feature);
      if (!client) return;
      if (st.when && !(client.cond?.(st.when) ?? false)) return;
      const lk = `${st.feature}|${st.action}|${st.intent.key}`;
      const rep = st.intent.accidental ? lastIntent.get(lk) : undefined;
      const it = know.intent({ feature: st.feature, kind: st.intent.kind, key: st.intent.key, mode: st.intent.mode, accidental: st.intent.accidental, ...(rep !== undefined ? { repeatOf: rep } : {}) });
      if (!st.intent.accidental) lastIntent.set(lk, it.id);
      const act: { kind: string; target?: string; value?: string } = { kind: st.ui.kind, target: st.ui.target };
      if (st.ui.value !== undefined) act.value = st.ui.value;
      if (runtime) {
        know.callingIntent = it.id;
        try {
          runtime.user(act, () => {
            know.callingIntent = null;
            client.handle(st, it.id);
          });
        } finally {
          know.callingIntent = null;
        }
      } else client.handle(st, it.id);
    }, "user");
  }
  // External events (other users, metric changes).
  for (const ev of scn.external) loop.at(ev.t, () => ev.apply(world), "sim");
  // Ask probes.
  if (!o.ideal && o.probeAsk && runtime) {
    const rt = runtime;
    for (const t of scn.askTimes) {
      loop.at(t, () => {
        let sit: SituationLike;
        try {
          sit = rt.situation("ask");
        } catch (e) {
          loop.internalErrors.push(e);
          return;
        }
        asks.push({ t: loop.now(), state: sit.state, facts: askFacts(loop.now(), know, network, env) });
      }, "sim");
    }
  }

  const tStop = Math.min(scn.tEnd, o.tStop ?? scn.tEnd);
  await loop.settle();
  await loop.runUntil(tStop);
  // Final state.
  const final = env.snapshot();
  const userOpMs = know.ops.filter((op) => !op.background).reduce((a, op) => a + ((op.tEnd ?? tStop) - op.t0), 0);
  const weights = new Map<string, Record<string, number>>();
  for (const s of env.stores) weights.set(s.name, s.weights);
  const res: RunResult = {
    ideal: o.ideal,
    snapshots,
    final,
    server: db.snapshot(),
    decisions,
    asks,
    know,
    netLog: network.log,
    shownErrors: know.shownErrors,
    uncaught: env.uncaughtCount,
    shownErrorTimes: know.shownErrorTimes,
    uncaughtTimes: env.uncaughtTimes,
    userOpMs,
    serverCounts: network.serverCounts(),
    internalErrors: loop.internalErrors,
    tasks: loop.tasksRun,
    tEnd: scn.tEnd,
    tStop,
    ...(serverTimeline ? { serverTimeline } : {}),
    weights,
    relations,
    storeFeature,
  };
  try {
    runtime?.destroy();
  } catch {
    /* ignore */
  }
  return res;
}

function extractTriggerText(state: JevState): string {
  const t = state.trigger;
  const f = state.facts;
  return [typeof t === "string" ? t : "", Array.isArray(f) ? f.join(" ") : typeof f === "string" ? f : ""].join(" ");
}

function askFacts(now: number, know: Knowledge, net: Network, env: AppEnv): AskFacts {
  const inflight = net.log
    .filter((e) => e.td === undefined)
    .map((e) => ({ sig: e.signature, method: e.method, age: now - e.t0, write: e.method !== "GET", feature: e.feature }));
  const recent = net.log
    .filter((e) => e.td !== undefined && e.td >= now - 15000)
    .map((e) => ({ sig: e.signature, method: e.method, ...(e.status !== undefined ? { status: e.status } : {}), outcome: e.outcome, t: e.t0, td: e.td! }));
  const userIntents = know.intents.filter((i) => i.t <= now);
  const lastUserAt = userIntents.length ? userIntents[userIntents.length - 1]!.t : -1;
  const pendingUser = know.ops.filter((op) => !op.background && op.tEnd === undefined);
  const userWaitingMs = pendingUser.length ? Math.max(...pendingUser.map((op) => now - op.t0)) : 0;
  const saves = know.ops.filter((op) => op.role === "save" && op.tEnd !== undefined);
  const lastSave = saves.length ? { ok: saves[saves.length - 1]!.outcome === "ok", t: saves[saves.length - 1]!.tEnd! } : undefined;
  const out: AskFacts = { now, inflight, recent, lastUserAt, userWaitingMs, stores: env.snapshot(), errorsShown: know.shownErrors, route: env.route };
  if (lastSave) out.lastSave = lastSave;
  return out;
}

export type { SimOp, SimWrite };
