// Runtime: wires trace, state, learn, situation and decide together (CONTRACT §2-§9).

import type {
  ActionContext,
  ActionDef,
  AdapterHandle,
  AdapterIO,
  ActionRecord,
  Answer,
  AnswerOf,
  AskOptions,
  Atom,
  ChoiceAnswer,
  Clock,
  CreateOptions,
  Decision,
  DecisionProvider,
  Explanation,
  Guarded,
  Mode,
  ModelStatus,
  Op,
  OpKind,
  OpStatus,
  Plugin,
  PluginApi,
  Question,
  Report,
  RtEvent,
  Runtime,
  RuntimeEvents,
  RuntimeHooks,
  Situation,
  SituationDraft,
  StandingQuestion,
  StoreIO,
  StoreOptions,
  Tier,
  TriggerKind,
  UserAction,
  Vocabulary,
} from "./types.js";
import { browserClock } from "./clock.js";
import { GenClassUnavailableError } from "./errors.js";
import { EventLog } from "./trace/events.js";
import { OpRegistry, type OpRec, type StartOpts } from "./trace/ops.js";
import { Context, LazyOp } from "./trace/context.js";
import { StoreHub, toChanges, type MutationRec, type StoreRec, type Verdict } from "./state/hub.js";
import { cloneValue, flatten, normalizeLeafKind, type FieldChange } from "./state/fields.js";
import { InvariantMiner } from "./state/invariants.js";
import { Baselines } from "./learn/baselines.js";
import { Profiles, shapeOf } from "./learn/profiles.js";
import { buildSituation, type BuildOptions, type BuiltSituation } from "./situation/build.js";
import { computeFacts } from "./situation/facts.js";
import type { ErrorInfo, ReqMeta, SitEnv, SubjectSpec, Violation } from "./situation/env.js";
import { opLabel } from "./situation/describe.js";
import { BUILTIN_ACTIONS, diagnosisVocabulary, PASSIVE } from "./situation/questions.js";
import { stateText } from "./situation/serialize.js";
import { DeciderQueue } from "./decide/decider.js";
import { gate, policyConfig, RateLimiter, type PolicyConfig } from "./decide/policy.js";
import { detectionLine, interventionLine, Reporter } from "./decide/report.js";
import type { ActionEffect, Controller, EndOpts, NetHost, TriggerOpts } from "./decide/exec.js";
import { ResponseCache } from "./observe/cache.js";
import { installFetch } from "./observe/fetch.js";
import { installXHR } from "./observe/xhr.js";
import { installDomUser } from "./observe/dom-user.js";
import { installErrors } from "./observe/errors.js";
import { installNav } from "./observe/nav.js";
import { installStorage } from "./observe/storage.js";
import { installPerf } from "./observe/perf.js";
import { installWebSocket } from "./observe/websocket.js";
import { installTimers } from "./observe/timers.js";
import { defaultRedact, normalizeFieldPath, secs, truncate, type Redactor } from "./util.js";

const DECISIONS_KEPT = 200;
const STALL_MIN_MS = 500;
const LONG_RUNNING_MS = 10_000;
const PROFILED: ReadonlySet<OpKind> = new Set<OpKind>(["fetch", "xhr", "user", "task", "ws"]);
const TYPING_BURST_MS = 1000;
const PROFILE_KEY = "genclass.profiles.v1";

interface ExplainRec {
  decision: Decision;
  situationText: string;
  facts: string[];
  timeline: string[];
  answers: Record<string, Answer>;
  action?: ActionRecord;
}

type Listeners = { [K in keyof RuntimeEvents]: Set<(v: RuntimeEvents[K]) => void> };

export interface RuntimeInternals {
  readonly hub: StoreHub;
  readonly ops: OpRegistry;
  readonly events: EventLog;
  readonly base: Baselines;
  readonly profiles: Profiles;
  readonly miner: InvariantMiner;
  readonly ctx: Context;
  readonly clock: Clock;
}

export class RuntimeImpl implements Runtime {
  readonly clock: Clock;
  readonly global: Record<string, unknown>;
  readonly events: EventLog;
  readonly ops = new OpRegistry();
  readonly ctx: Context;
  readonly hub: StoreHub;
  readonly base = new Baselines();
  readonly profiles = new Profiles();
  readonly miner = new InvariantMiner();
  readonly cache = new ResponseCache();

  private readonly queue: DeciderQueue;
  private readonly reporter: Reporter;
  private readonly policy: PolicyConfig;
  private readonly rate: RateLimiter;
  private readonly redactFn: Redactor;
  private readonly triage: "salient" | "always";
  private readonly vocab: Vocabulary | undefined;
  private readonly hooks: RuntimeHooks;
  private readonly settleMs: number;
  private readonly appFn: (() => { title?: string; route?: string }) | undefined;
  private readonly debug: boolean;
  private readonly persist: boolean;
  private _mode: Mode;
  private paused = false;
  private destroyed = false;
  private decider: DecisionProvider | null;
  private _ready: Promise<void> | null = null;
  private readonly ownsDecider: boolean;
  private listeners: Listeners = { detect: new Set(), decide: new Set(), act: new Set(), event: new Set(), status: new Set(), report: new Set() };
  private uninstall: (() => void)[] = [];
  private plugins = new Map<Plugin, { cleanup?: () => void }>();
  private customActions: ActionDef[] = [];
  private standing: StandingQuestion[] = [];
  private decisionsBuf: Decision[] = [];
  private actionsBuf: ActionRecord[] = [];
  private explainMap = new Map<string, ExplainRec>();
  private lastBuilt: Partial<Record<TriggerKind, BuiltSituation>> = {};
  private storeWriters = new Map<string, Map<string, number>>();
  private identicalMap = new Map<string, OpRec[]>();
  private errorsRecent: { key: string; t: number; op?: number }[] = [];
  private settleTimer: unknown = null;
  private toProfile: OpRec[] = [];
  /** Recent snapshots at which every learned invariant held (newest last). */
  private snaps: { t: number; seq: number; values: Map<string, unknown> }[] = [];
  private get lastConsistentSnap(): { t: number; seq: number; values: Map<string, unknown> } | null {
    return this.snaps.length ? this.snaps[this.snaps.length - 1] : null;
  }
  private snapshotBefore(seq: number): { t: number; seq: number; values: Map<string, unknown> } | null {
    for (let i = this.snaps.length - 1; i >= 0; i--) if (this.snaps[i].seq <= seq) return this.snaps[i];
    return null;
  }
  private episode = new Set<string>();
  /** Violations whose rollback the developer undid: not raised again until they hold at a settled point. */
  private muted = new Set<string>();
  private nextDecision = 0;
  private nextAction = 0;
  private lastTyping: { e: RtEvent; target: string; t: number } | null = null;
  private persistTimer: unknown = null;
  private readonly env: SitEnv;

  constructor(o: CreateOptions & { decider?: DecisionProvider | null; ownsDecider?: boolean } = {}) {
    this.clock = o.clock ?? browserClock;
    this.global = (o.global ?? globalThis) as Record<string, unknown>;
    this.events = new EventLog(o.historySize ?? 500);
    this.ctx = new Context(this.clock);
    this.redactFn = o.redact ?? defaultRedact;
    this.hub = new StoreHub(this.clock, this.ctx, this.events, () => this.redactFn);
    this.policy = policyConfig(o.policy);
    this.hub.holdUserWrites = this.policy.holdUserWrites;
    this.rate = new RateLimiter(() => this.policy.maxActionsPerMinute);
    this._mode = o.mode ?? "guard";
    this.triage = o.triage ?? "salient";
    this.vocab = o.vocabulary;
    this.hooks = o.hooks ?? {};
    this.settleMs = o.settleMs ?? 60;
    this.appFn = o.app;
    this.debug = !!o.debug;
    this.persist = !!o.learn?.persist;
    this.decider = o.decider ?? null;
    this.ownsDecider = !!o.ownsDecider;
    this.queue = new DeciderQueue(this.clock, () => this.decider, (e) => this.log("model error", e));
    this.reporter = new Reporter(o.report ?? "console", this.clock, (id) => this.explain(id), (r) => this.fire("report", r));
    this.env = this.makeEnv();
    this.hub.hooks = {
      gate: (m) => this.gateMutation(m),
      waitRelated: (m) => this.waitRelated(m),
      applied: (m, s, changes, writer) => this.onApplied(m, s, changes, writer),
      discarded: () => this.scheduleSettle(),
      proposed: (m) => {
        try {
          const h: { id: number; store: string; paths: string[]; cause?: number; changes: ReturnType<typeof toChanges> } = {
            id: m.id,
            store: m.store,
            paths: m.changes.map((c) => c.path),
            changes: toChanges(m.changes),
          };
          if (m.cause) h.cause = m.cause.id;
          this.hooks.mutationProposed?.(h);
        } catch {
          /* hooks never break the app */
        }
      },
    };
    this.events.onEvent((e) => this.fire("event", e));
    if (this.decider?.onStatus) {
      const off = this.decider.onStatus((s) => {
        this.fire("status", s);
        if (s.state === "ready") this.reporter.emit({ kind: "status", message: `[GenClass] Model ready (${[s.model, s.device, s.variant].filter(Boolean).join(", ")}${s.loadMs !== undefined ? `, ${secs(s.loadMs)}` : ""}). Mode: ${this._mode}.` });
        if (s.state === "error") this.reporter.emit({ kind: "status", message: `[GenClass] Model unavailable (${s.error ?? "error"}); observing only.` });
      });
      this.uninstall.push(off);
    }
    if (this.persist) this.loadProfiles();
    this.installObservers(o.observe ?? {});
    for (const p of o.plugins ?? []) this.use(p);
  }

  // ------------------------------------------------------------------------------------------ observers

  private installObservers(obs: Partial<Record<string, boolean>>): void {
    const g = this.global;
    const on = (k: string, def = true) => (obs[k] === undefined ? def : !!obs[k]);
    const host = this.netHost();
    const add = (f: (() => void) | null) => {
      if (f) this.uninstall.push(f);
    };
    const browserLike = typeof g.document === "object" && g.document !== null;
    if (on("timers", browserLike)) add(installTimers(this.timerHost()));
    if (on("fetch")) add(installFetch(host));
    if (on("xhr")) add(installXHR(host));
    if (on("websocket")) add(installWebSocket(this.wsHost()));
    if (on("user")) add(installDomUser(g, this));
    if (on("errors")) add(installErrors(g, this));
    if (on("nav")) add(installNav(g, this, (route) => this.events.push(this.clock.now(), "nav", route, { data: { route } })));
    if (on("storage")) add(installStorage(g, (area, op, key) => this.onStorage(area, op, key)));
    if (on("perf")) add(installPerf(g, (name, duration) => this.events.push(this.clock.now(), "perf", name, { data: { duration } })));
  }

  private netHost(): NetHost {
    return {
      clock: this.clock,
      ctx: this.ctx,
      global: this.global,
      cache: this.cache,
      redact: () => this.redactFn,
      baseHref: () => {
        const loc = this.global.location as { href?: string } | undefined;
        return typeof loc?.href === "string" ? loc.href : undefined;
      },
      startOp: (kind, name, o) => this.startOp(kind, name, o),
      endOp: (op, status, o) => this.endOp(op, status, o),
      gated: (op) => !this.paused && !this.destroyed && !op.genclass,
      trigger: (spec, ctl, opts) => this.trigger(spec, ctl, opts),
      watchStall: (op, req, ctl) => this.watchStall(op, req, ctl),
      failureStreak: (sig) => this.base.stats(sig)?.failStreak ?? 0,
      emit: (name, data, op) => this.events.push(this.clock.now(), "custom", name, { ...(op ? { op: op.id } : {}), ...(data ? { data } : {}) }),
    };
  }

  private timerHost() {
    return {
      global: this.global,
      ctx: this.ctx,
      lazyTimer: (parent: OpRec | LazyOp | null, label: string) =>
        new LazyOp(() => {
          const cause = parent instanceof LazyOp ? parent.materialize() : parent;
          return this.startOp("timer", label, { cause, instant: true });
        }),
    };
  }

  private wsHost() {
    return {
      global: this.global,
      ctx: this.ctx,
      redact: () => this.redactFn,
      baseHref: () => (this.global.location as { href?: string } | undefined)?.href,
      startOp: (name: string, o: Omit<StartOpts, "startSeq" | "t">) => this.startOp("ws", name, o),
      endOp: (op: OpRec, status: OpStatus, eo?: EndOpts) => this.endOp(op, status, eo),
      event: (name: string, data: Record<string, unknown>, op?: OpRec) => this.events.push(this.clock.now(), "custom", name, { ...(op ? { op: op.id } : {}), data }),
    };
  }

  private onStorage(area: string, op: string, key: string): void {
    const amb = this.ctx.op();
    const redacted = this.redactFn(key, key) !== key ? "[redacted]" : key;
    this.events.push(this.clock.now(), "storage", `${area}.${op}`, { ...(amb ? { op: amb.id } : {}), data: { key: redacted } });
  }

  // ---------------------------------------------------------------------------------------------- ops

  startOp(kind: OpKind, name: string, o: Omit<StartOpts, "startSeq" | "t"> = {}): OpRec {
    const t = this.clock.now();
    const cause = o.cause !== undefined ? o.cause : this.ctx.op();
    const op = this.ops.start(kind, name, { ...o, cause, startSeq: this.hub.seq, t });
    // instant user / ws-message / GenClass ops have their own events (user, custom, action)
    if (!op.instant || kind === "timer" || kind === "task") {
      const data: Record<string, unknown> = { kind };
      if (op.detail) data.detail = op.detail;
      if (op.instant) data.instant = true;
      this.events.push(t, "op.start", name, { op: op.id, ...(op.cause !== undefined ? { cause: op.cause } : {}), data });
    }
    if ((kind === "fetch" || kind === "xhr") && !op.genclass) {
      this.base.start(name, t, op.identity);
      if (op.identity) {
        const list = this.identicalMap.get(op.identity) ?? [];
        list.push(op);
        while (list.length > 12 || (list.length && t - list[0].start > 10_000 && list[0].end !== undefined)) list.shift();
        this.identicalMap.set(op.identity, list);
        if (this.identicalMap.size > 512) {
          const first = this.identicalMap.keys().next().value;
          if (first !== undefined) this.identicalMap.delete(first);
        }
      }
    }
    // instant ops are complete at creation: profile them at the next settled point (their chains finish by then)
    if (op.instant && PROFILED.has(kind) && !op.genclass) this.queueProfile(op);
    try {
      this.hooks.opCreated?.(op);
    } catch {
      /* hooks never break the app */
    }
    return op;
  }

  endOp(op: OpRec, status: OpStatus, o: EndOpts = {}): void {
    if (op.end !== undefined && !this.ops.inFlight.has(op)) return;
    const t = this.clock.now();
    this.ops.end(op, t, status, o.code, o.errorText);
    const data: Record<string, unknown> = { status };
    if (o.code !== undefined) data.code = o.code;
    if (o.synthetic) data.synthetic = true;
    this.events.push(t, "op.end", op.name, { op: op.id, data });
    if ((op.kind === "fetch" || op.kind === "xhr") && !o.synthetic && !op.genclass) {
      const outcome = status === "aborted" ? "aborted" : o.code !== undefined ? String(o.code) : status;
      const ok = status === "ok" && (typeof o.code !== "number" || o.code < 400);
      this.base.end(op.name, t, t - op.start, ok, outcome, !!o.failure);
    }
    if (PROFILED.has(op.kind) && !op.genclass && status !== "aborted" && !o.synthetic) this.queueProfile(op);
    this.scheduleSettle();
  }

  private queueProfile(op: OpRec): void {
    this.toProfile.push(op);
    if (this.toProfile.length > 2000) this.toProfile.shift();
  }

  // ------------------------------------------------------------------------------------------- triggers

  private buildOpts(): BuildOptions {
    const pluginFacts: BuildOptions["pluginFacts"] = [];
    const diag: Record<string, string>[] = [];
    for (const p of this.plugins.keys()) {
      if (p.facts) pluginFacts.push({ name: p.name, fn: p.facts.bind(p) });
      if (p.diagnoses) diag.push(p.diagnoses);
    }
    const o: BuildOptions = {
      diagnoses: diagnosisVocabulary(this.vocab, diag),
      customActions: this.customActions,
      questions: this.standing,
      pluginFacts,
      triage: this.triage,
    };
    if (this.vocab) o.vocab = this.vocab;
    return o;
  }

  /** Side-effect free situation building (apart from caching op.reads). */
  build(spec: SubjectSpec): BuiltSituation {
    return buildSituation(this.env, spec, this.buildOpts());
  }

  /** Whether triggers should even be built: a provider exists and could answer now or lazily. */
  private consultable(): boolean {
    if (this.paused || this.destroyed || !this.decider) return false;
    const st = this.decider.status.state;
    return st === "ready" || st === "off";
  }

  trigger(spec: SubjectSpec, ctl: Controller, opts: TriggerOpts): void {
    let passiveRan = false;
    const passive = () => {
      if (passiveRan) return;
      passiveRan = true;
      try {
        ctl.passive();
      } catch (e) {
        this.log("passive action failed", e);
      }
    };
    if (!this.consultable()) return passive();
    let built: BuiltSituation;
    try {
      // cheap first pass: facts only; the full situation is built only when it will be used
      const facts = computeFacts(this.env, spec);
      const forced = this.standing.some((q) => q.always && q.on.includes(spec.trigger));
      if (this.triage === "salient" && !forced && facts.every((f) => f.neutral)) return passive();
      built = buildSituation(this.env, spec, this.buildOpts(), facts);
    } catch (e) {
      this.log("situation build failed", e);
      return passive();
    }
    this.lastBuilt[spec.trigger] = built;
    if (!built.salient && !built.forced) return passive();
    const provider = this.decider!;
    if (provider.status.state !== "ready") {
      // lazy preload: the first salient situation starts loading; this one fails open
      void this.ready;
      return passive();
    }
    const waits = opts.hold && this._mode !== "observe";
    if (opts.hold && !waits) passive();
    let expired = false;
    let budgetTimer: unknown = null;
    if (waits) {
      budgetTimer = this.clock.setTimeout(() => {
        expired = true;
        passive();
      }, this.policy.holdBudgetMs);
    }
    const t0 = this.clock.now();
    this.queue
      .submit(
        { trigger: spec.trigger, state: built.situation.state, questions: built.situation.questions, priority: opts.priority, subject: built.subjectRef },
        () => expired,
      )
      .then((res) => {
        if (budgetTimer !== null) this.clock.clearTimeout(budgetTimer);
        if (this.destroyed) return passive();
        if (!res) return passive();
        this.onDecision(built, res.answers, this.clock.now() - t0, ctl, passive, { waits, expired, passiveRan: () => passiveRan, hold: opts.hold });
      })
      .catch((e) => {
        this.log("decision failed", e);
        passive();
      });
  }

  private onDecision(
    built: BuiltSituation,
    answers: Record<string, Answer>,
    latencyMs: number,
    ctl: Controller,
    passive: () => void,
    st: { waits: boolean; expired: boolean; passiveRan: () => boolean; hold: boolean },
  ): void {
    const trigger = built.spec.trigger;
    const passiveName = PASSIVE[trigger];
    const act = answers.action as ChoiceAnswer | undefined;
    const dg = answers.diagnosis as ChoiceAnswer | undefined;
    const probabilities: Record<string, number> = act?.probabilities ? { ...act.probabilities } : { [passiveName]: 1 };
    const action = act?.choice && built.actions.some((a) => a.name === act.choice) ? act.choice : passiveName;
    const confidence = probabilities[action] ?? (act ? act.confidence : 1);
    const diagnosis = dg?.choice ?? "expected";
    const diagnosisProbabilities: Record<string, number> = dg?.probabilities ? { ...dg.probabilities } : { expected: 1 };
    const diagnosisConfidence = diagnosisProbabilities[diagnosis] ?? dg?.confidence ?? 0;
    const opt = built.actions.find((a) => a.name === action);
    const tier: Tier = opt?.tier ?? "passive";
    const now = this.clock.now();
    let reason: string | null = null;
    if (tier !== "passive") {
      if (st.hold && !st.waits) reason = "observe mode never changes execution";
      else if (st.hold && (st.expired || st.passiveRan())) reason = "the decision arrived after the hold budget expired";
      else
        reason = gate(this.policy, this.rate, {
          action,
          tier,
          probability: confidence,
          diagnosis,
          mode: this._mode,
          inBudget: true,
          paused: this.paused,
          now,
        });
      if (reason?.startsWith("rate limit")) this.reporter.emit({ kind: "status", message: `[GenClass] Rate limit reached (${this.policy.maxActionsPerMinute} actions/minute): running passive actions until it clears.` });
    }
    const willRun = tier !== "passive" && reason === null;
    const decision: Decision = {
      id: `d${++this.nextDecision}`,
      trigger,
      subject: built.situation.subject,
      at: now,
      latencyMs,
      model: this.decider?.status.model ?? this.decider?.status.variant ?? "custom",
      diagnosis,
      diagnosisConfidence,
      diagnosisProbabilities,
      action,
      confidence,
      probabilities,
      executed: tier === "passive" ? true : willRun,
      facts: built.situation.facts,
      tier,
      ran: willRun ? action : passiveName,
      answers,
      subjectRef: built.subjectRef,
    };
    if (reason) decision.reason = reason;
    this.decisionsBuf.push(decision);
    if (this.decisionsBuf.length > DECISIONS_KEPT) this.decisionsBuf.shift();
    const rec: ExplainRec = { decision, situationText: stateText(built.situation.state), facts: built.situation.facts, timeline: built.parts.timeline, answers };
    this.explainMap.set(decision.id, rec);
    if (this.explainMap.size > DECISIONS_KEPT * 2) {
      const first = this.explainMap.keys().next().value;
      if (first !== undefined) this.explainMap.delete(first);
    }
    this.events.push(now, "decision", trigger, { data: { id: decision.id, diagnosis, action, executed: decision.executed } });
    if (this.debug) this.log(`decision ${decision.id}`, decision);
    this.fire("decide", decision);
    const detected = diagnosis !== "expected" && diagnosisConfidence >= this.policy.thresholds.report;
    if (detected) this.fire("detect", decision);
    // standing questions
    for (const q of built.standing) {
      const a = answers[q.id];
      if (a && q.onAnswer) {
        try {
          q.onAnswer(a, { decision, situation: built.draft, runtime: this });
        } catch (e) {
          this.log(`standing question ${q.id} failed`, e);
        }
      }
    }
    if (!willRun) {
      if (st.hold || tier === "passive" || reason) passive();
      if (detected) this.reporter.emit({ kind: "detect", message: detectionLine(decision), decision });
      return;
    }
    // execute the non-passive action
    this.rate.take(now);
    const def = opt?.custom;
    const finish = (eff: ActionEffect | null, err?: unknown) => {
      const record: ActionRecord = {
        id: `a${++this.nextAction}`,
        decisionId: decision.id,
        action,
        tier,
        trigger,
        subject: decision.subject,
        at: this.clock.now(),
        ok: !err,
        changed: eff?.changed ?? (err ? `Tried to ${action} ${decision.subject} but it failed; the passive action ran instead.` : `Ran ${action}.`),
      };
      if (err) record.error = err instanceof Error ? err.message : String(err);
      if (eff?.undo) {
        const undo = eff.undo;
        let undone = false;
        record.undo = () => {
          if (undone) return;
          undone = true;
          this.runAsGenClass("undo", () => undo());
          this.events.push(this.clock.now(), "action", "undo", { data: { text: `undid ${action} (${record.id})`, id: record.id } });
        };
      }
      this.actionsBuf.push(record);
      if (this.actionsBuf.length > DECISIONS_KEPT) this.actionsBuf.shift();
      rec.action = record;
      this.explainMap.set(record.id, rec);
      this.events.push(record.at, "action", action, { data: { text: record.changed, id: record.id, decision: decision.id, ok: record.ok } });
      this.fire("act", record);
      this.reporter.emit({ kind: "intervene", message: interventionLine(decision, record), decision, action: record });
    };
    try {
      let r: ActionEffect | Promise<ActionEffect>;
      if (def) r = this.runCustom(def, decision, built, ctl);
      else r = ctl.run(action);
      Promise.resolve(r).then(
        (eff) => finish(eff),
        (e) => {
          passive();
          finish(null, e);
        },
      );
    } catch (e) {
      passive();
      finish(null, e);
    }
  }

  private runCustom(def: ActionDef, decision: Decision, built: BuiltSituation, ctl: Controller): Promise<ActionEffect> {
    let changed = "";
    let undo: (() => void) | undefined;
    let tookOver = false;
    const ctx: ActionContext = {
      trigger: built.spec.trigger,
      decision,
      situation: built.draft,
      runtime: this,
      builtin: async (name: string) => {
        if (!BUILTIN_ACTIONS[name] || !built.actions.some((a) => a.name === name)) return false;
        if (name === PASSIVE[built.spec.trigger]) {
          ctl.passive();
          tookOver = true;
          return true;
        }
        const eff = await ctl.run(name);
        tookOver = true;
        if (!changed) changed = eff.changed;
        if (eff.undo && !undo) undo = eff.undo;
        return true;
      },
      describe: (c: string) => {
        changed = c;
      },
      onUndo: (fn: () => void) => {
        undo = fn;
      },
    };
    return Promise.resolve()
      .then(() => this.runAsGenClass(def.name, () => def.run(ctx)))
      .then(() => {
        if (!tookOver) ctl.passive();
        const eff: ActionEffect = { changed: changed || `Ran the custom action ${def.name}.` };
        if (undo) eff.undo = undo;
        return eff;
      });
  }

  /** Run fn inside a GenClass op: its writes and requests are never gated. */
  runAsGenClass<T>(name: string, fn: () => T): T {
    const op = this.startOp("genclass", name, { cause: null, instant: true });
    return this.ctx.run(op, fn);
  }

  // ------------------------------------------------------------------------------------------ mutations

  private gateMutation(m: MutationRec): { held?: Promise<Verdict> } {
    if (!this.consultable()) return {};
    let resolveV!: (v: Verdict) => void;
    const held = new Promise<Verdict>((r) => (resolveV = r));
    let sync = true;
    let syncVerdict: Verdict | null = null;
    const settle = (v: Verdict) => {
      if (sync) syncVerdict = v;
      resolveV(v);
    };
    const ctl: Controller = {
      passive: () => settle("apply"),
      run: (action) => {
        if (action === "discard") {
          settle("discard");
          const paths = m.changes.map((c) => c.path).join(", ");
          const s = this.hub.get(m.store);
          return {
            changed: `Dropped the write to ${paths}${m.cause ? ` from ${opLabel(m.cause)}` : ""}; ${m.store} stays at version ${s?.version ?? 0}.`,
            undo: () => {
              const st = this.hub.get(m.store);
              if (st) this.hub.commit(st, { ...m, userSync: false, genclass: true, state: "resolved" });
            },
          };
        }
        if (action === "defer") {
          settle("defer");
          return { changed: `Held the write to ${m.changes.map((c) => c.path).join(", ")} until the related in-flight operations finish, to decide again.` };
        }
        throw new Error(`unsupported action ${action}`);
      },
    };
    this.trigger({ trigger: "mutation", m }, ctl, { hold: true, priority: 2 });
    sync = false;
    if (syncVerdict === "apply") return {};
    if (syncVerdict) return { held: Promise.resolve(syncVerdict) };
    return { held };
  }

  private waitRelated(m: MutationRec): Promise<void> {
    const C = m.cause;
    const related = [...this.ops.inFlight].filter((o) => {
      if (C && (this.ops.isAncestorOrSelf(o, C) || this.ops.isAncestorOrSelf(C, o))) return false;
      if (C && o.name === C.name && o.kind === C.kind) return true;
      return (this.storeWriters.get(o.name)?.get(m.store) ?? 0) > 0;
    });
    if (!related.length) return Promise.resolve();
    return new Promise((resolve) => {
      const pending = new Set(related);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        off();
        this.clock.clearTimeout(timer);
        resolve();
      };
      const off = this.ops.onEnd((op) => {
        pending.delete(op);
        if (!pending.size) finish();
      });
      const timer = this.clock.setTimeout(finish, LONG_RUNNING_MS);
    });
  }

  private onApplied(m: MutationRec | null, s: StoreRec, changes: FieldChange[], writer: OpRec | null): void {
    if (writer) {
      writer.wrote++;
      (writer.storesWritten ??= new Set()).add(s.name);
      // learned associations: which op signatures' chains write which stores; transition-profile accumulators
      const chain: OpRec[] = [writer, ...this.ops.ancestors(writer, 8)];
      const sigs = new Set<string>();
      for (const op of chain) {
        if (op.genclass) continue;
        if (!sigs.has(op.name)) {
          sigs.add(op.name);
          const mm = this.storeWriters.get(op.name) ?? new Map<string, number>();
          mm.set(s.name, (mm.get(s.name) ?? 0) + 1);
          this.storeWriters.set(op.name, mm);
          if (this.storeWriters.size > 1000) {
            const first = this.storeWriters.keys().next().value;
            if (first !== undefined) this.storeWriters.delete(first);
          }
        }
        if (!PROFILED.has(op.kind) || op.profiled) continue;
        const acc = (op.chain ??= new Map());
        op.chainWrites = (op.chainWrites ?? 0) + 1;
        for (const c of changes) {
          const key = normalizeFieldPath(c.path);
          const prev = acc.get(key);
          const k1 = normalizeLeafKind(c.afterLeaf);
          acc.set(key, { kind: k1, len0: prev ? prev.len0 : c.beforeLeaf?.len ?? -1, len1: c.afterLeaf?.len ?? -1 });
        }
      }
    }
    this.miner.noteChanged(changes.map((c) => c.path));
    void m;
    this.scheduleSettle();
  }

  // ------------------------------------------------------------------------------------- settled points

  private scheduleSettle(): void {
    if (this.destroyed) return;
    if (this.settleTimer !== null) this.clock.clearTimeout(this.settleTimer);
    this.settleTimer = this.clock.setTimeout(() => {
      this.settleTimer = null;
      this.settled();
    }, this.settleMs);
  }

  private busy(): boolean {
    const now = this.clock.now();
    for (const op of this.ops.inFlight) if (now - op.start < LONG_RUNNING_MS) return true;
    return this.hub.pending().length > 0;
  }

  /** A settled point: learn invariants and transition profiles, raise inconsistency/transition triggers. */
  settled(): void {
    if (this.destroyed || this.busy()) return;
    const now = this.clock.now();
    // invariants
    const leaves = this.hub.allLeaves();
    const res = this.miner.observe(leaves, now);
    const ids = new Set(res.violations.map((v) => v.id));
    for (const id of [...this.muted]) if (!ids.has(id)) this.muted.delete(id);
    const fresh = res.violations.filter((v) => !this.episode.has(v.id) && !this.muted.has(v.id));
    this.episode = ids;
    if (res.violations.length === 0) {
      const last = this.lastConsistentSnap;
      if (last && last.seq === this.hub.seq) last.t = now;
      else {
        this.snaps.push({ t: now, seq: this.hub.seq, values: this.hub.snapshot() });
        if (this.snaps.length > 8) this.snaps.shift();
      }
    }
    if (fresh.length) this.raiseInconsistency(fresh);
    // transition profiles
    const list = this.toProfile;
    this.toProfile = [];
    const flagged: { op: OpRec; unusual: ReturnType<Profiles["check"]>; shape: ReturnType<typeof shapeOf> }[] = [];
    for (const op of list) {
      if (op.profiled || op.end === undefined) continue;
      op.profiled = true;
      const shape = shapeOf(op.chain, op.chainWrites ?? 0, this.statusClass(op), op.end - op.start);
      const sig = op.kind === "user" ? `user ${op.name}` : op.name;
      const unusual = this.profiles.check(sig, shape);
      this.profiles.add(sig, shape);
      if (unusual.length && !op.triggered?.has("transition")) flagged.push({ op, unusual, shape });
    }
    // one anomaly, one trigger: when an op and one of its descendants are both unusual, keep the descendant
    for (const f of flagged) {
      if (flagged.some((g) => g !== f && this.ops.isAncestorOrSelf(f.op, g.op))) continue;
      (f.op.triggered ??= new Set()).add("transition");
      this.raiseTransition(f.op, f.unusual, f.shape);
    }
    if (this.persist && list.length) this.saveProfilesSoon();
  }

  private statusClass(op: OpRec): string {
    if (typeof op.code === "number") return `${Math.floor(op.code / 100)}xx`;
    if (op.code === "timeout" || op.code === "network") return op.code;
    return op.status ?? "ok";
  }

  private raiseInconsistency(vs: Violation[]): void {
    const stores = [...new Set(vs.flatMap((v) => v.fields.map((f) => f.split(".")[0])))];
    const ctl: Controller = {
      passive: () => undefined,
      run: (action) => {
        if (action === "rollback") return this.rollback(stores, vs.map((v) => v.id));
        if (action === "resync") return this.resync(stores);
        throw new Error(`unsupported action ${action}`);
      },
    };
    this.trigger({ trigger: "inconsistency", violations: vs }, ctl, { hold: false, priority: 1 });
  }

  private raiseTransition(op: OpRec, unusual: ReturnType<Profiles["check"]>, shape: ReturnType<typeof shapeOf>): void {
    const stores = [...new Set([...(op.chain?.keys() ?? [])].map((f) => f.split(".")[0]))].filter((s) => this.hub.get(s));
    const ctl: Controller = {
      passive: () => undefined,
      run: (action) => {
        if (action === "rollback") return this.rollback(stores, [], this.ops.rootOf(op).startSeq);
        if (action === "resync") return this.resync(stores);
        throw new Error(`unsupported action ${action}`);
      },
    };
    this.trigger({ trigger: "transition", op, unusual, shape }, ctl, { hold: false, priority: 0 });
  }

  /** Restore stores to the last consistent snapshot (cause = a GenClass op); undo restores the values replaced. */
  rollback(stores: string[], violationIds: string[] = [], beforeSeq?: number): ActionEffect {
    const snap = beforeSeq === undefined ? this.lastConsistentSnap : this.snapshotBefore(beforeSeq);
    if (!snap) throw new Error("no consistent snapshot");
    const targets = stores.length ? stores : [...snap.values.keys()];
    const before = new Map<string, unknown>();
    const restored: string[] = [];
    this.runAsGenClass("rollback", () => {
      for (const name of targets) {
        const s = this.hub.get(name);
        if (!s || !s.writable || !snap.values.has(name)) continue;
        before.set(name, cloneValue(this.hub.read(s)));
        const changes = this.hub.write(s, cloneValue(snap.values.get(name)), this.ctx.op(), null);
        if (changes.length) restored.push(`${name} (${changes.map((c) => c.path).slice(0, 3).join(", ")})`);
      }
    });
    if (!restored.length) throw new Error("nothing to restore: the affected stores already match the snapshot");
    return {
      changed: `Restored ${restored.join("; ")} to the consistent state from ${secs(this.clock.now() - snap.t)} ago.`,
      undo: () => {
        for (const id of violationIds) this.muted.add(id);
        for (const [name, v] of before) {
          const s = this.hub.get(name);
          if (s) this.hub.write(s, v, this.ctx.op(), null);
        }
      },
    };
  }

  resync(stores: string[]): Promise<ActionEffect> {
    const targets = stores.map((n) => this.hub.get(n)).filter((s): s is StoreRec => !!s && typeof s.opts.resync === "function");
    if (!targets.length) return Promise.reject(new Error("no resync handler"));
    return Promise.all(targets.map((s) => this.runAsGenClass("resync", () => Promise.resolve(s.opts.resync!())))).then(() => ({
      changed: `Reloaded ${targets.map((s) => s.name).join(", ")} from ${targets.length === 1 ? "its" : "their"} source (resync handler).`,
    }));
  }

  // ---------------------------------------------------------------------------------------------- stall

  private watchStall(op: OpRec, req: ReqMeta, ctl: () => Controller): () => void {
    const lat = this.base.latency(req.signature);
    if (!lat) return () => undefined;
    const at = Math.max(4 * lat.median, 2 * lat.p95, STALL_MIN_MS);
    const h = this.clock.setTimeout(() => {
      if (op.end !== undefined || this.destroyed || op.triggered?.has("stall")) return;
      (op.triggered ??= new Set()).add("stall");
      this.trigger({ trigger: "stall", op, req }, ctl(), { hold: false, priority: 1 });
    }, at);
    return () => this.clock.clearTimeout(h);
  }

  // ------------------------------------------------------------------------------------------ situation env

  private makeEnv(): SitEnv {
    return {
      now: () => this.clock.now(),
      ops: this.ops,
      hub: this.hub,
      base: this.base,
      profiles: this.profiles,
      events: this.events,
      redact: this.redactFn,
      app: () => this.appInfo(),
      cached: (id) => {
        const b = this.cache.peek(id);
        return b ? { t: b.t, status: b.status } : undefined;
      },
      identical: (id) => (this.identicalMap.get(id) ?? []).filter((o) => this.clock.now() - o.start <= 10_000 || o.end === undefined),
      lastConsistent: () => (this.lastConsistentSnap ? { t: this.lastConsistentSnap.t, seq: this.lastConsistentSnap.seq } : null),
      consistentBefore: (seq) => {
        const sn = this.snapshotBefore(seq);
        return sn ? { t: sn.t, seq: sn.seq } : null;
      },
      storeWriters: this.storeWriters,
      recentErrors: () => {
        const now = this.clock.now();
        this.errorsRecent = this.errorsRecent.filter((e) => now - e.t <= 10_000);
        return this.errorsRecent;
      },
      violations: () => this.miner.current(),
      previewInvariants: (m) => {
        const leaves = this.hub.allLeaves();
        const store = m.store;
        for (const k of [...leaves.keys()]) if (k === store || k.startsWith(store + ".")) leaves.delete(k);
        for (const [k, l] of flatten(store, m.preview)) leaves.set(k, l);
        return this.miner.preview(leaves, m.changes.map((c) => c.path));
      },
      canCoalesce: (id, self) => !!this.cache.shareable(id, self, this.clock.now()),
      resyncable: (store) => typeof this.hub.get(store)?.opts.resync === "function",
      writable: (store) => !!this.hub.get(store)?.writable,
    };
  }

  private appInfo(): { title?: string; route?: string } {
    if (this.appFn) return this.appFn();
    const doc = this.global.document as { title?: string } | undefined;
    const loc = this.global.location as { pathname?: string } | undefined;
    const r: { title?: string; route?: string } = {};
    if (typeof doc?.title === "string") r.title = doc.title;
    if (typeof loc?.pathname === "string") r.route = loc.pathname;
    return r;
  }

  // ------------------------------------------------------------------------------------------ public API

  get ready(): Promise<void> {
    if (!this.decider) return Promise.resolve();
    if (!this._ready) {
      let p: Promise<void>;
      try {
        p = Promise.resolve(this.decider.ready());
      } catch (e) {
        p = Promise.reject(e);
      }
      p.catch(() => undefined);
      this._ready = p;
    }
    return this._ready;
  }

  get status(): ModelStatus {
    return this.decider ? this.decider.status : { state: "off" };
  }

  get mode(): Mode {
    return this._mode;
  }

  get internals(): RuntimeInternals {
    return { hub: this.hub, ops: this.ops, events: this.events, base: this.base, profiles: this.profiles, miner: this.miner, ctx: this.ctx, clock: this.clock };
  }

  atom<T>(name: string, initial: T, opts: StoreOptions<T> = {}): Atom<T> {
    const existing = this.hub.get(name);
    let s: StoreRec;
    if (existing && existing.kind === "atom") {
      s = existing;
      if (opts.resync || opts.describe || opts.hold !== undefined) s.opts = { ...s.opts, ...(opts as StoreOptions<unknown>) };
    } else s = this.hub.register(name, "atom", initial, opts as StoreOptions<unknown>);
    return this.handle<T>(s);
  }

  guard<T>(name: string, io: StoreIO<T>, opts: StoreOptions<T> = {}): Guarded<T> {
    const s = this.hub.register(name, "guard", io.get(), opts as StoreOptions<unknown>, io as StoreIO<unknown>);
    return this.handle<T>(s);
  }

  adapter<T>(name: string, io: AdapterIO<T>, opts: StoreOptions<T> = {}): AdapterHandle<T> {
    const sio: StoreIO<unknown> = {
      get: () => io.get(),
      set: (v) => {
        if (!io.set) throw new Error(`store ${name} cannot be written by GenClass`);
        io.set(v as T);
      },
    };
    if (io.subscribe) sio.subscribe = (fn) => io.subscribe!(fn);
    const s = this.hub.register(name, "adapter", io.get(), opts as StoreOptions<unknown>, sio);
    s.writable = typeof io.set === "function";
    const hub = this.hub;
    const rt = this;
    return {
      name,
      propose(w) {
        const commit = (next: unknown) => w.commit(next as T);
        if (rt.destroyed) {
          const next = w.fn ? w.fn(io.get()) : (w.value as T);
          hub.write(s, next, null, null, commit);
          return;
        }
        const pw: { fn?: (p: unknown) => unknown; value?: unknown; commit: (n: unknown) => void } = { commit };
        if (w.fn) pw.fn = w.fn as (p: unknown) => unknown;
        else pw.value = w.value;
        hub.propose(s, pw);
      },
      dispose() {
        if (hub.get(name) === s) hub.unregister(name);
      },
    };
  }

  private handle<T>(s: StoreRec): Atom<T> {
    const hub = this.hub;
    const rt = this;
    return {
      name: s.name,
      get: () => hub.read(s) as T,
      set(next: T | ((prev: T) => T)) {
        if (rt.destroyed) {
          const v = typeof next === "function" ? (next as (p: T) => T)(hub.read(s) as T) : next;
          hub.write(s, v, null, null);
          return;
        }
        if (typeof next === "function") hub.propose(s, { fn: next as (p: unknown) => unknown });
        else hub.propose(s, { value: next });
      },
      update(fn: (prev: T) => T) {
        this.set(fn);
      },
      subscribe(fn: (v: T) => void) {
        const f = fn as (v: unknown) => void;
        s.subs.add(f);
        return () => s.subs.delete(f);
      },
    };
  }

  expect(name: string, predicate: () => boolean): () => void {
    return this.miner.addExpect(name, predicate);
  }

  async ask<Q extends Question>(q: Q, opts: AskOptions = {}): Promise<AnswerOf<Q>> {
    const p = this.decider;
    if (!p || this.destroyed) throw new GenClassUnavailableError("off", "GenClass has no model (model: false)");
    if (p.status.state !== "ready") {
      const wait = this.ready;
      if (opts.timeoutMs !== undefined) {
        let h: unknown;
        const to = new Promise<never>((_, rej) => {
          h = this.clock.setTimeout(() => rej(new GenClassUnavailableError("timeout", "the model did not load in time")), opts.timeoutMs!);
        });
        try {
          await Promise.race([wait, to]);
        } finally {
          this.clock.clearTimeout(h);
        }
      } else await wait.catch((e) => Promise.reject(new GenClassUnavailableError("error", `the model failed to load: ${(e as Error)?.message ?? e}`)));
    }
    if (p.status.state !== "ready") throw new GenClassUnavailableError("error", `the model is ${p.status.state}`);
    const about = opts.about ?? "now";
    const built = this.build({ trigger: "ask", about });
    const questions = { answer: q } as Record<string, Question>;
    const sub = this.queue.submit({ trigger: "ask", state: built.situation.state, questions, priority: 1, subject: built.subjectRef });
    let res;
    if (opts.timeoutMs !== undefined) {
      let h: unknown;
      const to = new Promise<null>((resolve) => {
        h = this.clock.setTimeout(() => resolve(null), opts.timeoutMs!);
      });
      res = await Promise.race([sub, to]);
      this.clock.clearTimeout(h);
      if (!res) throw new GenClassUnavailableError("timeout", "the model did not answer in time");
    } else res = await sub;
    if (!res || !res.answers.answer) throw new GenClassUnavailableError("error", "the model could not answer");
    return res.answers.answer as AnswerOf<Q>;
  }

  async decide<L extends string>(question: string, options: Record<L, string>, opts?: AskOptions): Promise<L> {
    const a = await this.ask({ type: "choice", instructions: question, criteria: options as Record<string, string> }, opts);
    return (a as ChoiceAnswer).choice as L;
  }

  on<K extends keyof RuntimeEvents>(type: K, fn: (v: RuntimeEvents[K]) => void): () => void {
    const set = this.listeners[type] as Set<(v: RuntimeEvents[K]) => void>;
    set.add(fn);
    if (type === "report") {
      // route reports to listeners too
    }
    return () => set.delete(fn);
  }

  private fire<K extends keyof RuntimeEvents>(type: K, v: RuntimeEvents[K]): void {
    for (const fn of [...(this.listeners[type] as Set<(v: RuntimeEvents[K]) => void>)]) {
      try {
        fn(v);
      } catch (e) {
        this.log(`listener for ${type} failed`, e);
      }
    }
  }

  op<T>(name: string, fn: () => Promise<T> | T, meta?: Record<string, unknown>): Promise<T> {
    const detail = typeof meta?.detail === "string" ? meta.detail : undefined;
    const o = this.startOp("task", name, { ...(detail ? { detail } : {}), ...(meta ? { meta } : {}) });
    let r: Promise<T> | T;
    try {
      r = this.ctx.run(o, fn);
    } catch (e) {
      this.endOp(o, "error", { errorText: (e as Error)?.message ?? String(e) });
      return Promise.reject(e);
    }
    return Promise.resolve(r).then(
      (v) => {
        this.endOp(o, "ok");
        this.ctx.stick(o);
        return v;
      },
      (e) => {
        this.endOp(o, "error", { errorText: (e as Error)?.message ?? String(e) });
        this.ctx.stick(o);
        throw e;
      },
    );
  }

  emit(name: string, data?: Record<string, unknown>): void {
    const op = this.ctx.op();
    const d: Record<string, unknown> = {};
    if (data) {
      for (const [k, v] of Object.entries(data)) d[k] = this.redactFn(k, v);
      d.summary = truncate(
        Object.entries(d)
          .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join(" "),
        80,
      );
    }
    this.events.push(this.clock.now(), "custom", name, { ...(op ? { op: op.id } : {}), ...(data ? { data: d } : {}) });
  }

  user<T>(action: UserAction, handler?: () => T): T | undefined {
    const t = this.clock.now();
    const a: UserAction = { ...action, kind: action.kind ?? (action as { action?: string }).action ?? "action" };
    const target = a.target ?? "";
    let value = a.value;
    if (value !== undefined && (a.sensitive || this.redactFn(target, value) !== value)) value = "[redacted]";
    const detail = value !== undefined ? JSON.stringify(truncate(String(value), 40)) : undefined;
    const name = `${a.kind}${target ? ` ${target}` : ""}`;
    const op = this.startOp("user", name, { cause: null, instant: true, ...(detail ? { detail } : {}), meta: { action: { ...a, ...(value !== undefined ? { value } : {}) } } });
    const last = this.lastTyping;
    if (a.kind === "type" && last && last.target === target && t - last.t <= TYPING_BURST_MS && this.lastUserEvent === last.e) {
      const e = last.e;
      const d = e.data as Record<string, unknown>;
      d.count = (d.count as number) + 1;
      d.value = detail;
      d.lastT = t;
      e.op = op.id;
      last.t = t;
      this.events.touch(e);
    } else {
      const e = this.events.push(t, "user", name, { op: op.id, data: { kind: a.kind, target, ...(detail ? { value: detail } : {}), count: 1, first: op.id } });
      this.lastUserEvent = e;
      this.lastTyping = a.kind === "type" ? { e, target, t } : null;
    }
    this.ctx.stickUser(op);
    if (!handler) return undefined;
    return this.ctx.run(op, handler);
  }
  private lastUserEvent: RtEvent | null = null;

  reportError(error: unknown, info: { source?: string } = {}): void {
    if (this.destroyed) return;
    const e = normalizeError(error, info.source);
    const op = this.ctx.op();
    const t = this.clock.now();
    const rec: { key: string; t: number; op?: number } = { key: e.key, t };
    if (op) rec.op = op.id;
    this.errorsRecent.push(rec);
    if (this.errorsRecent.length > 64) this.errorsRecent.shift();
    this.events.push(t, "error", e.name, { ...(op ? { op: op.id } : {}), data: { message: `${e.name}: ${truncate(e.message, 120)}`, ...(e.source ? { source: e.source } : {}) } });
    const root = op ? this.ops.rootOf(op) : null;
    const stores = root ? [...new Set(this.hub.changedSince(root.startSeq).map((x) => x.path.split(".")[0]))] : [];
    const ctl: Controller = {
      passive: () => undefined,
      run: (action) => {
        if (action === "rollback") return this.rollback(stores, [], root ? root.startSeq : undefined);
        throw new Error(`unsupported action ${action}`);
      },
    };
    this.trigger({ trigger: "error", error: e, op: op ?? null }, ctl, { hold: false, priority: 0 });
  }

  use(plugin: Plugin): () => void {
    if (this.plugins.has(plugin)) return () => this.unuse(plugin);
    const entry: { cleanup?: () => void } = {};
    this.plugins.set(plugin, entry);
    for (const a of plugin.actions ?? []) this.customActions.push(a);
    for (const q of plugin.questions ?? []) this.standing.push(q);
    if (plugin.setup) {
      try {
        const c = plugin.setup(this.pluginApi());
        if (typeof c === "function") entry.cleanup = c;
      } catch (e) {
        this.log(`plugin ${plugin.name} setup failed`, e);
      }
    }
    return () => this.unuse(plugin);
  }

  private unuse(plugin: Plugin): void {
    const entry = this.plugins.get(plugin);
    if (!entry) return;
    this.plugins.delete(plugin);
    this.customActions = this.customActions.filter((a) => !(plugin.actions ?? []).includes(a));
    this.standing = this.standing.filter((q) => !(plugin.questions ?? []).includes(q));
    try {
      entry.cleanup?.();
    } catch {
      /* ignore */
    }
  }

  private pluginApi(): PluginApi {
    return {
      runtime: this,
      clock: this.clock,
      emit: (name, data) => this.emit(name, data),
      recordOp: (kind, name, meta) => {
        const o: Omit<StartOpts, "startSeq" | "t"> = {};
        if (meta?.detail) o.detail = meta.detail;
        if (meta?.identity) o.identity = meta.identity;
        if (meta?.data) o.meta = meta.data;
        return this.startOp(kind, name, o).id;
      },
      endOp: (id, status = "ok", info) => {
        const op = this.ops.get(id);
        if (!op) return;
        const eo: EndOpts = {};
        if (info?.code !== undefined) eo.code = info.code;
        if (info?.error !== undefined) eo.errorText = (info.error as Error)?.message ?? String(info.error);
        this.endOp(op, status, eo);
      },
      runInOp: (id, fn) => {
        const op = this.ops.get(id);
        return op ? this.ctx.run(op, fn) : fn();
      },
      user: (a, h) => this.user(a, h),
      reportError: (e, i) => this.reportError(e, i),
      on: (t, fn) => this.on(t, fn),
      stores: { names: () => [...this.hub.stores.keys()], get: (n) => (this.hub.get(n) ? this.hub.read(this.hub.get(n)!) : undefined) },
    };
  }

  action(def: ActionDef): () => void {
    this.customActions.push(def);
    return () => {
      this.customActions = this.customActions.filter((a) => a !== def);
    };
  }

  question(def: StandingQuestion): () => void {
    this.standing.push(def);
    return () => {
      this.standing = this.standing.filter((q) => q !== def);
    };
  }

  situation(trigger?: TriggerKind): Situation {
    if (trigger && trigger !== "ask" && this.lastBuilt[trigger]) return this.lastBuilt[trigger]!.situation;
    const built = this.build({ trigger: "ask", about: "now" });
    if (trigger && trigger !== "ask") return { ...built.situation, trigger };
    return built.situation;
  }

  explain(id: string): Explanation | null {
    const r = this.explainMap.get(id);
    if (!r) return null;
    const e: Explanation = { decision: r.decision, situationText: r.situationText, facts: r.facts, timeline: r.timeline, answers: r.answers };
    if (r.action) {
      e.action = r.action;
      e.changed = r.action.changed;
    }
    return e;
  }

  history(n?: number): RtEvent[] {
    return this.events.last(n);
  }

  decisions(n = DECISIONS_KEPT): Decision[] {
    return this.decisionsBuf.slice(-n);
  }

  interventions(n = DECISIONS_KEPT): ActionRecord[] {
    return this.actionsBuf.slice(-n);
  }

  inflight(): Op[] {
    return [...this.ops.inFlight];
  }

  setMode(mode: Mode): void {
    if (mode !== "observe" && mode !== "guard" && mode !== "heal") return;
    this._mode = mode;
    this.reporter.emit({ kind: "status", message: `[GenClass] Mode set to ${mode}.` });
    this.fire("status", this.status);
  }

  pause(): void {
    this.paused = true;
    this.hub.gating = false;
  }

  resume(): void {
    if (this.destroyed) return;
    this.paused = false;
    this.hub.gating = true;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hub.gating = false;
    this.queue.dispose();
    if (this.settleTimer !== null) this.clock.clearTimeout(this.settleTimer);
    if (this.persistTimer !== null) this.clock.clearTimeout(this.persistTimer);
    for (const u of this.uninstall.reverse()) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.uninstall = [];
    for (const p of [...this.plugins.keys()]) this.unuse(p);
    for (const s of this.hub.stores.values()) s.unsubscribeIO?.();
    this.ctx.clear();
    if (this.ownsDecider) {
      try {
        this.decider?.dispose?.();
      } catch {
        /* ignore */
      }
    }
  }

  /** Report sink for a custom destination at runtime (devtools). */
  setReport(sink: "console" | "silent" | ((r: Report) => void)): void {
    this.reporter.setSink(sink);
  }

  // ---------------------------------------------------------------------------------------------- misc

  private log(msg: string, e?: unknown): void {
    if (!this.debug) return;
    const con = (globalThis as { console?: Console }).console;
    con?.debug?.(`[GenClass] ${msg}`, e ?? "");
  }

  private loadProfiles(): void {
    try {
      const ls = this.global.localStorage as Storage | undefined;
      const raw = ls?.getItem(PROFILE_KEY);
      if (raw) this.profiles.load(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }

  private saveProfilesSoon(): void {
    if (this.persistTimer !== null) return;
    this.persistTimer = this.clock.setTimeout(() => {
      this.persistTimer = null;
      try {
        const ls = this.global.localStorage as Storage | undefined;
        ls?.setItem(PROFILE_KEY, JSON.stringify(this.profiles.toJSON()));
      } catch {
        /* quota or privacy mode */
      }
    }, 5000);
  }
}

export function normalizeError(error: unknown, source?: string): ErrorInfo {
  let name = "Error";
  let message = "";
  if (error instanceof Error || (typeof error === "object" && error !== null && "message" in error)) {
    const e = error as { name?: string; message?: string };
    name = e.name || "Error";
    message = String(e.message ?? "");
  } else if (typeof error === "string") message = error;
  else {
    try {
      message = JSON.stringify(error) ?? String(error);
    } catch {
      message = String(error);
    }
  }
  const key = `${name}:${message.replace(/\d+/g, "n").slice(0, 120)}`;
  const info: ErrorInfo = { name, message, raw: error, key };
  if (source) info.source = source;
  return info;
}

export type { SituationDraft, BuiltSituation };
