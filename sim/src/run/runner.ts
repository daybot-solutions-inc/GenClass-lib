// Executes one scenario: either the ideal world (no runtime, zero latency, no failures, exactly-once, only
// intended user actions) or the real world on the real runtime with a recording decider that forces actions by
// decision index. Records client-state snapshots (for time-integrated divergence), the final client and server
// state, decisions (state + questions exactly as handed to the decider), ask probes and the sim's knowledge.

import { AppEnv, PlainBackend, pushIds, pushIdsByData, type SimGlobal, type StoreBackend } from "../app/env.js";
import { FEATURES } from "../app/features/index.js";
import type { FeatureClient, Relation, WorldCtx } from "../app/feature.js";
import { Kit } from "../app/kit.js";
import { VirtualLoop } from "../loop.js";
import { BASE_URL, IDEAL_PROFILE, Network, type NetEntry } from "../net/network.js";
import { API_STYLES, Db, VirtualServer, type ServerSnapshot } from "../net/server.js";
import { diagnose, type Subject } from "../oracle/diagnose.js";
import { Knowledge, type SimOp, type SimWrite } from "../oracle/knowledge.js";
import { PROBE, ProbeState, probeAfter, probeDecision, type Probe } from "../oracle/probe.js";
import { futureProfile, futureStepTimes, idealRepeatSkips, S2, type FutureSpec } from "./latent.js";
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
  /** On-policy runs: the model's answers, its own action choice, and what the runtime's gate actually ran. */
  modelProbs?: Record<string, number>;
  modelDiagnosis?: string;
  modelChoice?: string;
  ran?: string;
  subjKey?: string;
  /** Feature kind the subject belongs to (sim knowledge), for per-feature stats. */
  feature?: string;
  /** `delivery` decisions: diagnosis = verdict of the first write this op / push caused (filled after the run). */
  diagFrom?: { op?: number; push?: number };
  /** SIM_PROBE=1: separability probes (oracle/probe.ts). */
  probe?: Probe;
  probeSubj?: { op?: number; write?: number };
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
  /** On-policy: answers come from this model through the runtime's production gate (heal mode, default thresholds). */
  onPolicy?: { model: DecisionProvider };
  /**
   * Re-seeded future: from decision `k` on (ideal runs: k = -1, i.e. from time `t`), network draws, push latencies,
   * model latencies and the times of other users' events after `t` use `salt`. The prefix stays byte-identical.
   */
  future?: FutureSpec;
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

/** The run's knowledge, for push-id bookkeeping inside the virtual socket. */
const knowRef: { current: Knowledge | null } = { current: null };

/** A WebSocket over the network's push channel (`wss://host/ws/<topic path>`); instrumentable by the runtime. */
function makeWebSocketClass(loop: VirtualLoop, net: Network, ideal: boolean): unknown {
  class VirtualWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly url: string;
    readonly protocol = "";
    readonly extensions = "";
    bufferedAmount = 0;
    binaryType = "blob";
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    private unsub: (() => void) | null = null;
    constructor(url: string | URL) {
      super();
      this.url = String(url);
      const topic = new URL(this.url).pathname.replace(/^\/ws\//, "").split("/").map(decodeURIComponent).join("/");
      const connectMs = ideal ? 0 : 40 + (topic.length % 7) * 10;
      const drops = ideal ? [] : net.profile.socketDrops ?? [];
      loop.schedule(connectMs, () => {
        if (this.readyState !== 0) return;
        const now = loop.now();
        if (drops.some((w) => now >= w.start && now < w.end)) {
          // the server refuses connections during a drop window
          this.readyState = 3;
          const err = new Event("error");
          this.dispatchEvent(err);
          this.onerror?.(err);
          const ev = Object.assign(new Event("close"), { code: 1006 });
          this.dispatchEvent(ev);
          this.onclose?.(ev);
          return;
        }
        for (const w of drops) {
          if (w.start > now) {
            loop.at(w.start, () => {
              if (this.readyState !== 1) return;
              this.readyState = 3;
              this.unsub?.();
              const ev = Object.assign(new Event("close"), { code: 1006 });
              this.dispatchEvent(ev);
              this.onclose?.(ev);
            }, "net");
            break;
          }
        }
        this.readyState = 1;
        this.unsub = net.subscribe(topic, (msg) => {
          if (this.readyState !== 1) return;
          const data = JSON.stringify(msg);
          const ev = new MessageEvent("message", { data });
          const k = knowRef.current;
          const id = k ? k.nextPush++ : 0;
          pushIds.set(ev, id);
          pushIdsByData.set(data, id);
          if (pushIdsByData.size > 2000) pushIdsByData.delete(pushIdsByData.keys().next().value!);
          if (k) k.deliveringPush = id;
          try {
            this.dispatchEvent(ev);
            this.onmessage?.(ev);
          } finally {
            if (k) k.deliveringPush = null;
          }
        });
        const ev = new Event("open");
        this.dispatchEvent(ev);
        this.onopen?.(ev);
      }, "net");
    }
    send(_data: unknown): void {
      /* client -> server messages are not modelled */
    }
    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.unsub?.();
      const ev = Object.assign(new Event("close"), { code: 1000 });
      this.dispatchEvent(ev);
      this.onclose?.(ev);
    }
  }
  return VirtualWebSocket;
}

class MemStorage {
  private m = new Map<string, string>();
  onWrite: ((key: string | null, oldValue: string | null, newValue: string | null) => void) | null = null;
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  /** A write by another tab: update the shared value without this tab's own observer seeing a local write. */
  external(k: string, v: string | null): { oldValue: string | null } {
    const oldValue = this.getItem(k);
    if (v === null) this.m.delete(k);
    else this.m.set(k, v);
    return { oldValue };
  }
}

/** BroadcastChannel hub: channels by name; messages from other tabs are delivered in a later task. */
function makeBroadcast(loop: VirtualLoop): { cls: unknown; post(name: string, msg: unknown): void } {
  const subs = new Map<string, Set<{ onmessage: ((e: MessageEvent) => void) | null; listeners: Set<(e: MessageEvent) => void> }>>();
  class VirtualBroadcastChannel {
    onmessage: ((e: MessageEvent) => void) | null = null;
    listeners = new Set<(e: MessageEvent) => void>();
    constructor(readonly name: string) {
      if (!subs.has(name)) subs.set(name, new Set());
      subs.get(name)!.add(this);
    }
    postMessage(_m: unknown): void {
      /* other tabs are simulated; this tab's own posts reach no one in the sim */
    }
    addEventListener(_t: string, fn: (e: MessageEvent) => void): void {
      this.listeners.add(fn);
    }
    close(): void {
      subs.get(this.name)?.delete(this);
    }
  }
  return {
    cls: VirtualBroadcastChannel,
    post(name, msg) {
      const text = JSON.stringify(msg);
      loop.schedule(1, () => {
        for (const c of subs.get(name) ?? []) {
          const ev = new MessageEvent("message", { data: JSON.parse(text) });
          c.onmessage?.(ev);
          for (const fn of c.listeners) fn(ev);
        }
      }, "app");
    },
  };
}

function makeGlobal(loop: VirtualLoop, net: Network, title: string, ideal: boolean): SimGlobal {
  const intervals = new Set<{ cancelled: boolean; task: unknown }>();
  const url = new URL(BASE_URL);
  const target = new EventTarget();
  const G: SimGlobal = {
    addEventListener: (type: string, fn: (e: Event) => void) => target.addEventListener(type, fn),
    removeEventListener: (type: string, fn: (e: Event) => void) => target.removeEventListener(type, fn),
    dispatchEvent: (e: Event) => target.dispatchEvent(e),
    navigator: { onLine: true, userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36" },
    localStorage: new MemStorage() as unknown as Storage,
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
    document: { title, visibilityState: "visible", hidden: false },
    WebSocket: makeWebSocketClass(loop, net, ideal),
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
  const network = new Network(loop, server, o.ideal ? IDEAL_PROFILE : futureProfile(scn.net, o.future), hashAll("net", scn.seed));
  if (!o.ideal && o.future && !o.future.noLatent && S2) network.latent = { salt: o.future.salt, t: o.future.t };
  const G = makeGlobal(loop, network, scn.appTitle, o.ideal);
  const hub = makeBroadcast(loop);
  G.BroadcastChannel = hub.cls;
  const storage = G.localStorage as unknown as MemStorage;
  const know = new Knowledge();
  know.now = () => loop.now();
  knowRef.current = know;
  const probeState = PROBE && o.record && !o.ideal ? new ProbeState(know, (store) => env.stores.find((x) => x.name === store)?.weights ?? {}) : null;
  if (probeState) know.probe = probeState;
  // Every write gets its diagnosis at proposal time (the mutation rules); delivery decisions reuse it.
  know.onWrite = (w) => {
    try {
      const d = diagnose("mutation", { kind: "write", write: w }, { know, network, relations, now: loop.now(), stores: () => env.snapshot() });
      if (d) w.diag = d;
    } catch {
      /* ignore */
    }
  };
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
  /** On-policy: decisions awaiting the runtime's `decide` event (what the gate actually ran). */
  const pendingRan: DecisionRec[] = [];
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
      const diagFrom = req.trigger === "delivery" ? (subject.how === "push" ? { push: subject.ref! } : subject.s.op ? { op: subject.s.op.id } : undefined) : undefined;
      const fid = subject.s.write?.feature ?? subject.s.op?.feature ?? subject.s.chain?.[0]?.feature ?? (subject.s.error && typeof subject.s.error === "object" ? know.errors.get(subject.s.error as object)?.feature : undefined);
      const featureKind = scn.features.find((f) => f.id === fid)?.kind;
      const base = { k: idx, t, trigger: req.trigger, state: req.state, questions, actions, subject: { kind: subject.s.kind, how: subject.how, ...(subject.ref !== undefined ? { ref: subject.ref } : {}) }, ...(diag !== undefined ? { diagnosis: diag } : {}), ...(featureKind ? { feature: featureKind } : {}), ...(diagFrom ? { diagFrom } : {}) };
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
        if (probeState) {
          try {
            rec.probe = probeDecision(req.trigger, subject.s, know, network, probeState, t);
            rec.probeSubj = { ...(subject.s.op ? { op: subject.s.op.id } : {}), ...(subject.s.write ? { write: subject.s.write.id } : {}) };
          } catch {
            /* analysis only */
          }
        }
        if (fake) rec.fakeDiagnosis = true;
        if (!o.record) {
          rec.state = {};
          rec.questions = {};
        }
        decisions.push(rec);
      }
      if (o.future && idx === o.future.k) network.future = o.future.salt;
      const fut = o.future && idx > o.future.k ? o.future.salt : undefined;
      const ms = new Rng(fut === undefined ? hashAll("model-latency", scn.seed, idx) : hashAll("model-latency", scn.seed, idx, fut)).lognormal(scn.modelMs, 0.35);
      if (o.onPolicy) {
        const rec = decisions[decisions.length - 1];
        const subj = req.subject && typeof req.subject === "object" ? { ...(req.subject as Record<string, unknown>) } : {};
        delete subj.error;
        const key = `${req.trigger}|${JSON.stringify(subj)}`;
        if (rec && rec.k === idx) {
          rec.subjKey = key;
          pendingRan.push(rec);
        }
        const p = o.onPolicy.model.evaluate({ trigger: req.trigger, state: req.state, questions: req.questions, ...(req.subject !== undefined ? { subject: req.subject } : {}) });
        loop.hold(p);
        return p.then((ans) => {
          if (rec && rec.k === idx) {
            const a = ans.action;
            if (a && a.type === "choice") {
              rec.modelProbs = a.probabilities;
              rec.modelChoice = a.choice;
            }
            const dg = ans.diagnosis;
            if (dg && dg.type === "choice") rec.modelDiagnosis = dg.choice;
          }
          return new Promise<Record<string, Answer>>((resolve) => loop.schedule(ms, () => resolve(ans), "runtime"));
        });
      }
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
    if (trig === "delivery") {
      if (sub && typeof sub.op === "number") {
        const simId = know.rtOps.get(sub.op) ?? rtOpViaCause(sub.op);
        const op = know.getOp(simId);
        if (op) return { s: { kind: "op", op }, how: "subject", ref: op.id };
        const push = know.rtPushOps.get(sub.op);
        if (push !== undefined) return { s: { kind: "push" as Subject["kind"] }, how: "push", ref: push };
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
      budget: scn.budget,
      ...(o.onPolicy ? { production: true } : {}),
      // Exact correlation: the runtime creates the fetch op synchronously inside the app's fetch call and the
      // mutation synchronously inside atom.set, while the sim's ambient tag (callingOp / writing) is set.
      hooks: {
        opCreated(op) {
          if (know.deliveringPush !== null && op.kind === "ws") know.rtPushOps.set(op.id, know.deliveringPush);
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
    if (o.onPolicy) {
      rt.on("decide", (v: unknown) => {
        const d = v as { trigger: string; subjectRef?: Record<string, unknown>; ran?: string; executed?: boolean; action?: string };
        const subj = d.subjectRef ? { ...d.subjectRef } : {};
        delete subj.error;
        const key = `${d.trigger}|${JSON.stringify(subj)}`;
        const i = pendingRan.findIndex((r) => r.subjKey === key);
        if (i < 0) return;
        const rec = pendingRan.splice(i, 1)[0]!;
        const passive = PASSIVE[rec.trigger] ?? rec.actions[0] ?? "";
        const ran = d.ran ?? (d.executed && d.action ? d.action : passive);
        rec.ran = ran;
        // Replays force what actually ran, exactly like explored actions in base runs.
        rec.chosen = ran;
        rec.explored = ran !== passive;
      });
    }
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
  env.skewMs = o.ideal ? 0 : scn.skewMs ?? 0;
  env.blocker = (ms) => loop.advance(ms);
  const world: WorldCtx = {
    db,
    server,
    publish: (t, m) => network.publish(t, m),
    now: () => loop.now(),
    otherTab: {
      setItem: (key, value) => {
        const { oldValue } = storage.external(key, value);
        G.dispatchEvent(Object.assign(new Event("storage"), { key, newValue: value, oldValue, url: G.location.href }));
      },
      removeItem: (key) => {
        const { oldValue } = storage.external(key, null);
        G.dispatchEvent(Object.assign(new Event("storage"), { key, newValue: null, oldValue, url: G.location.href }));
      },
      broadcast: (channel, msg) => hub.post(channel, msg),
    },
  };
  // Connectivity: offline windows flip navigator.onLine and fire offline/online events.
  if (!o.ideal) {
    for (const w of network.profile.offline ?? []) {
      loop.at(w.start, () => {
        G.navigator.onLine = false;
        G.dispatchEvent(new Event("offline"));
      }, "sim");
      loop.at(w.end, () => {
        G.navigator.onLine = true;
        G.dispatchEvent(new Event("online"));
      }, "sim");
    }
  }
  // Tab visibility / focus changes (the user switching tabs).
  for (const ev of scn.windowEvents ?? []) {
    loop.at(ev.t, () => {
      const hidden = ev.type === "blur";
      G.document.visibilityState = hidden ? "hidden" : "visible";
      G.document.hidden = hidden;
      G.dispatchEvent(new Event("visibilitychange"));
      G.dispatchEvent(new Event(hidden ? "blur" : "focus"));
    }, "sim");
  }

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
  const stepT = futureStepTimes(scn.steps, o.future);
  const idealSkip = o.ideal ? idealRepeatSkips(scn.steps, o.future) : new Map<number, boolean>();
  for (const [si, st] of scn.steps.entries()) {
    if (o.ideal && (idealSkip.get(si) ?? (st.intent.accidental || !!st.when))) continue;
    loop.at(stepT[si]!, () => {
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
  // External events (other users, metric changes). In a re-seeded future, events after the decision time move
  // later by 0-600 ms (other people's timing is part of the future's randomness).
  scn.external.forEach((ev, i) => {
    let t = ev.t;
    if (o.future && t > o.future.t) t += new Rng(hashAll("ext-jitter", o.future.salt, i)).float(0, 600);
    loop.at(t, () => ev.apply(world), "sim");
  });
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
  // Delivery decisions: the diagnosis is the verdict of the first write the delivered op / push caused.
  for (const d of decisions) {
    if (!d.diagFrom) continue;
    const w = know.writes.find((x) => (d.diagFrom!.op !== undefined && x.op === d.diagFrom!.op) || (d.diagFrom!.push !== undefined && x.push === d.diagFrom!.push));
    d.diagnosis = w?.diag ?? d.diagnosis ?? "expected";
  }
  if (probeState) for (const d of decisions) if (d.probe && d.probeSubj) probeAfter(d.trigger, d.t, d.probe, d.probeSubj, know, probeState);
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
