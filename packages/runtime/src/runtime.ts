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
import { cloneValue, flatten, normalizeLeafKind, type FieldChange, type Leaf } from "./state/fields.js";
import { InvariantMiner } from "./state/invariants.js";
import { Baselines } from "./learn/baselines.js";
import { Profiles, shapeOf } from "./learn/profiles.js";
import { buildSituation, relatedInFlight, type BuildOptions, type BuiltSituation } from "./situation/build.js";
import { computeFacts } from "./situation/facts.js";
import type { ChainWriteInfo, DeliverySpec, ErrorInfo, ReqMeta, SitEnv, SubjectSpec, Violation } from "./situation/env.js";
import { conflictsOn, matchFields, predictedWrites } from "./situation/conflicts.js";
import { installEventSource } from "./observe/eventsource.js";
import { opLabel } from "./situation/describe.js";
import { BUILTIN_ACTIONS, diagnosisVocabulary, PASSIVE } from "./situation/questions.js";
import { STATE_CHAR_BUDGET, stateText } from "./situation/serialize.js";
import { DeciderQueue } from "./decide/decider.js";
import { gate, holdBudget, permittedActions, policyConfig, RateLimiter, restriction, type PolicyConfig } from "./decide/policy.js";
import { decisionLine, detectionLine, interventionLine, Reporter } from "./decide/report.js";
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
import { defaultRedact, normalizeFieldPath, plural, secs, truncate, type Redactor } from "./util.js";

const DECISIONS_KEPT = 200;
/** A held write that applied because its hold budget expired can still be reverted this long after it applied. */
const LATE_REVERT_MS = 2000;
/** Non-held triggers (stall, inconsistency, transition, error) are not worth answering after this long. */
const BACKGROUND_DEADLINE_MS = 5000;
/** A delivery `discard` keeps dropping the chain's writes over newer data for this long. */
const DISCARD_MARK_MS = 10_000;
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
  readonly miner: InvariantMiner;
  readonly cache: ResponseCache;

  private readonly queue: DeciderQueue;
  private readonly reporter: Reporter;
  private readonly policy: PolicyConfig;
  private readonly rate: RateLimiter;
  private readonly redactFn: Redactor;
  private readonly triage: "salient" | "always";
  private readonly vocab: Vocabulary | undefined;
  private readonly hooks: RuntimeHooks;
  private readonly settleMs: number;
  private readonly budgetOpt: number | "auto";
  private budgetScale = 1;
  private uniq = 0;
  private rateWarnedAt = -Infinity;
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
  private lastChainMap = new Map<string, string[]>();
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
    this.miner = new InvariantMiner(() => this.redactFn);
    this.cache = new ResponseCache(this.clock);
    this.policy = policyConfig(o.policy);
    this.hub.holdUserWrites = this.policy.holdUserWrites;
    this.hub.holdWrites = this.policy.holdWrites;
    this.rate = new RateLimiter(() => this.policy.maxActionsPerMinute);
    this._mode = o.mode ?? "guard";
    this.triage = o.triage ?? "salient";
    this.vocab = o.vocabulary;
    this.hooks = o.hooks ?? {};
    this.settleMs = o.settleMs ?? 60;
    this.budgetOpt = o.situation?.budget ?? "auto";
    this.appFn = o.app;
    this.debug = !!o.debug;
    this.persist = !!o.learn?.persist;
    this.decider = o.decider ?? null;
    this.ownsDecider = !!o.ownsDecider;
    this.queue = new DeciderQueue(this.clock, () => this.decider, (e) => {
      // the model could not fit the situation: use smaller automatic budgets from now on
      if ((e as { code?: string })?.code === "max_tokens_exceeded") this.budgetScale = Math.max(0.5, this.budgetScale * 0.8);
      this.log("model error", e);
    });
    this.reporter = new Reporter(o.report ?? "console", this.clock, (id) => this.explain(id), (r) => this.fire("report", r));
    this.env = this.makeEnv();
    this.hub.hooks = {
      gate: (m) => this.gateMutation(m),
      mayHold: () => this.hub.holdWrites && this.consultable() && this._mode !== "observe",
      observeWrite: (m) => this.observeWrite(m),
      filter: (m) => this.dropFilter(m),
      dropped: (m, dropped, applied) => this.onDropped(m, dropped, applied),
      appError: (e, source) => this.reportError(e, { source }),
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
    // init must never throw: a failing installer (read-only global, exotic environment) is skipped
    const add = (f: (() => void) | null) => {
      if (f) this.uninstall.push(f);
    };
    const tryAdd = (name: string, install: () => (() => void) | null) => {
      try {
        add(install());
      } catch (e) {
        this.log(`the ${name} observer could not be installed; skipped`, e);
      }
    };
    const browserLike = typeof g.document === "object" && g.document !== null;
    if (on("timers", browserLike)) tryAdd("timers", () => installTimers(this.timerHost()));
    if (on("fetch")) tryAdd("fetch", () => installFetch(host));
    if (on("xhr")) tryAdd("xhr", () => installXHR(host));
    if (on("websocket")) tryAdd("websocket", () => installWebSocket(this.wsHost()));
    if (on("eventsource")) tryAdd("eventsource", () => installEventSource(this.wsHost()));
    if (on("user"))
      tryAdd("user", () =>
        installDomUser(g, {
          untrusted: on("untrustedEvents", false),
          user: (a, h) => this.user(a, h),
          ambientKind: () => {
            const c = this.ctx.peek();
            if (!c) return null;
            return c instanceof LazyOp ? "timer" : c.kind;
          },
          runningKind: () => {
            const c = this.ctx.running;
            if (!c) return null;
            return c instanceof LazyOp ? "timer" : c.kind;
          },
        }),
      );
    if (on("errors")) tryAdd("errors", () => installErrors(g, this));
    if (on("nav")) tryAdd("nav", () => installNav(g, this, (route) => this.events.push(this.clock.now(), "nav", route, { data: { route } })));
    if (on("storage")) tryAdd("storage", () => installStorage(g, (area, op, key) => this.onStorage(area, op, key)));
    if (on("perf")) tryAdd("perf", () => installPerf(g, (name, duration) => this.events.push(this.clock.now(), "perf", name, { data: { duration } })));
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
      uniqueId: () => `uniq:${++this.uniq}`,
      deliver: (o, release) => this.runDelivery({ op: o.op, channel: "response", req: o.req, status: o.status }, release),
      setIdentity: (op, req, identity) => {
        if (op.identity === identity) return;
        op.identity = identity;
        req.identity = identity;
        this.registerIdentity(op);
      },
      emit: (name, data, op) => this.events.push(this.clock.now(), "custom", name, { ...(op ? { op: op.id } : {}), ...(data ? { data } : {}) }),
    };
  }

  private timerHost() {
    return {
      global: this.global,
      ctx: this.ctx,
      lazyTimer: (parent: OpRec | null, label: string) => new LazyOp(parent, (cause) => this.startOp("timer", label, { cause, instant: true })),
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
      deliverMessage: (o: { op: OpRec; channel: "websocket" | "eventsource"; message: { path: string; summary: string }; queuedAhead: number }, release: () => void) =>
        this.runDelivery(o, release),
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
      this.base.start(name, t);
      if (op.identity) this.registerIdentity(op);
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

  /** Register a request op under its identity (identical-request facts, gaps between identical requests). */
  private registerIdentity(op: OpRec): void {
    const id = op.identity;
    if (!id || op.genclass || id.startsWith("uniq:")) return;
    this.base.noteIdentity(id, op.start);
    const list = this.identicalMap.get(id) ?? [];
    list.push(op);
    while (list.length > 12 || (list.length && this.clock.now() - list[0].start > 10_000 && list[0].end !== undefined)) list.shift();
    this.identicalMap.set(id, list);
    if (this.identicalMap.size > 512) {
      const first = this.identicalMap.keys().next().value;
      if (first !== undefined) this.identicalMap.delete(first);
    }
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
      budget: this.situationBudget(),
    };
    if (this.vocab) o.vocab = this.vocab;
    return o;
  }

  /**
   * Situation size in characters: the configured number, or "auto" by the model's device: webgpu 2,400 (≈ 1,000
   * tokens); wasm 1,000 at 1 thread to 2,000 at 4 threads (linear); unknown device (custom providers) 2,400.
   */
  situationBudget(): number {
    if (typeof this.budgetOpt === "number") return this.budgetOpt;
    const st = this.decider?.status;
    let b: number = STATE_CHAR_BUDGET;
    if (st?.device === "wasm") {
      const threads = Math.min(4, Math.max(1, st.threads ?? 1));
      b = 1000 + Math.round(((threads - 1) * 1000) / 3);
    }
    return Math.round(b * this.budgetScale);
  }

  /** The current hold budget in ms (policy.holdBudgetMs, "auto" by default). */
  holdBudgetMs(): number {
    return holdBudget(this.policy, this.queue.latencies(), this.decider?.status.warmupMs);
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
    // Never hold when no non-passive action is permitted for this trigger in this mode (and policy): the subject
    // proceeds at once and the decision is still made in the background, for detection.
    const permitted = permittedActions(this.policy, this._mode, built.actions);
    // Never hold when nothing could be done, or when the model is not expected to answer within the hold budget
    // (decide in the background instead: detection, late revert)
    const waits = opts.hold && permitted.length > 0 && !this.paused && this.expectedLatency() <= this.holdBudgetMs();
    if (!waits) passive();
    let expired = false;
    let budgetTimer: unknown = null;
    const t0 = this.clock.now();
    const budget = this.holdBudgetMs();
    if (waits) {
      budgetTimer = this.clock.setTimeout(() => {
        expired = true;
        passive();
      }, budget);
    }
    // deadline for the answer: held subjects need it within the hold budget (a held write may still be reverted
    // shortly after it applied); background decisions within a few seconds
    const lateOk = waits && !!ctl.revert;
    const deadline = waits ? t0 + budget + (lateOk ? LATE_REVERT_MS : 0) : t0 + BACKGROUND_DEADLINE_MS;
    this.queue
      .submit(
        { trigger: spec.trigger, state: built.situation.state, questions: built.situation.questions, priority: waits ? opts.priority : Math.min(opts.priority, 1), subject: built.subjectRef },
        deadline,
        ctl.stale ? () => !!ctl.stale!() : undefined,
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
    const top = act?.choice && built.actions.some((a) => a.name === act.choice) ? act.choice : passiveName;
    const diagnosis = dg?.choice ?? "expected";
    const diagnosisProbabilities: Record<string, number> = dg?.probabilities ? { ...dg.probabilities } : { expected: 1 };
    const diagnosisConfidence = diagnosisProbabilities[diagnosis] ?? dg?.confidence ?? 0;
    const now = this.clock.now();
    const offered = built.actions.map((a) => ({ name: a.name, tier: a.tier }));
    const g = gate(this.policy, this.rate, { actions: offered, probabilities, top, diagnosis, mode: this._mode, paused: this.paused, now });
    let reason: string | null = g.reason;
    let run: string | null = g.run;
    let late = false;
    // the subject already went its way (write applied, response delivered, request sent): an action now is late
    const proceeded = ctl.proceeded ? ctl.proceeded() : st.hold && (st.expired || st.passiveRan());
    if (trigger === "delivery" && !proceeded) {
      const op = (built.spec as DeliverySpec).op;
      if (op.delivery) op.delivery.decided = true;
    }
    const custom = run ? built.actions.find((a) => a.name === run)?.custom : undefined;
    if (run && proceeded && !custom) {
      if (run === "discard" && ctl.revert && ctl.revertable) {
        // late revert: the write already applied; revert exactly that write when nothing depends on it
        const why = ctl.revertable();
        if (why) {
          reason = why;
          run = null;
        } else late = true;
      } else {
        reason = st.waits ? "the decision arrived after the hold budget expired" : "the subject was not held (decided in the background)";
        run = null;
      }
    }
    if (reason?.startsWith("rate limit") && now - this.rateWarnedAt > 60_000) {
      this.rateWarnedAt = now;
      this.reporter.emit({ kind: "status", message: `[GenClass] Rate limit reached (${this.policy.maxActionsPerMinute} actions/minute): running passive actions until it clears.` });
    }
    const action = run ?? top;
    const opt = built.actions.find((a) => a.name === action);
    const tier: Tier = opt?.tier ?? "passive";
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
      confidence: probabilities[action] ?? 0,
      probabilities,
      executed: run !== null || tier === "passive",
      facts: built.situation.facts,
      tier,
      ran: run ?? passiveName,
      answers,
      subjectRef: built.subjectRef,
      mass: g.mass,
    };
    if (g.candidate) decision.candidate = g.candidate;
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
    if (!run) {
      passive();
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
      if (late) record.late = true;
      eff?.onRecord?.(record);
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
      if (late) r = ctl.revert!();
      else if (def) r = this.runCustom(def, decision, built, ctl);
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
        const b = BUILTIN_ACTIONS[name];
        if (!b || !built.actions.some((a) => a.name === name)) return false;
        if (name === PASSIVE[built.spec.trigger]) {
          ctl.passive();
          tookOver = true;
          return true;
        }
        // the same policy as the model's own choices: mode tier, deny/allow, rate limit; and the subject must not
        // have proceeded already (a write that applied cannot be discarded by a custom action)
        if (this.paused || restriction(this.policy, this._mode, { name, tier: b.tier }) !== null) return false;
        if (ctl.proceeded?.()) return false;
        const t = this.clock.now();
        if (this.rate.full(t)) return false;
        this.rate.take(t);
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

  /** The controller of a write: discard/defer while held, late revert once applied. */
  private mutationController(m: MutationRec, settle: ((v: Verdict) => void) | null): Controller {
    const superseded = (): boolean => {
      if (m.outcome === "discarded") return true;
      if (m.outcome !== "applied" || !m.applied) return false;
      for (const c of m.applied) {
        const f = this.hub.field(c.path);
        const last = f?.log[f.log.length - 1];
        if (!last || last.mutation !== m.id) return true;
      }
      return false;
    };
    return {
      passive: () => settle?.("apply"),
      proceeded: () => m.state === "done",
      stale: superseded,
      run: (action) => {
        if (!settle) throw new Error("the write was not held");
        if (action === "discard") {
          settle("discard");
          const paths = m.changes.map((c) => c.path).join(", ");
          const s = this.hub.get(m.store);
          return {
            changed: `Dropped the write to ${paths}${m.cause ? ` from ${opLabel(m.cause)}` : ""}; ${m.store} stays at version ${s?.version ?? 0}.`,
            undo: () => {
              const st = this.hub.get(m.store);
              if (st) this.hub.commit(st, { ...m, userSync: false, genclass: true, state: "resolved" }, false);
            },
          };
        }
        if (action === "defer") {
          settle("defer");
          return { changed: `Held the write to ${m.changes.map((c) => c.path).join(", ")} until the related in-flight operations finish, to decide again.` };
        }
        throw new Error(`unsupported action ${action}`);
      },
      revertable: () => {
        if (m.appliedAt === undefined) return "the write has not applied yet";
        const age = this.clock.now() - m.appliedAt;
        if (age > LATE_REVERT_MS) return `too late to revert: decided ${secs(age)} after the write applied`;
        return this.hub.revertable(m);
      },
      revert: () => {
        const age = this.clock.now() - (m.appliedAt ?? this.clock.now());
        const changes = this.runAsGenClass("revert", () => this.hub.revert(m, this.ctx.op()));
        if (!changes) throw new Error("the write could not be reverted");
        const paths = (m.applied ?? []).map((c) => c.path);
        const shown = paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");
        const back = changes
          .slice(0, 2)
          .map((c) => `${c.path} is back to ${this.hub.describeValue(c.path, c.after)}`)
          .join("; ");
        return {
          changed: `Reverted the write to ${shown}${m.cause ? ` from ${opLabel(m.cause)}` : ""} (decided ${secs(age)} after it applied)${back ? `; ${back}` : ""}.`,
          undo: () => {
            this.hub.reapply(m, this.ctx.op());
          },
        };
      },
    };
  }

  /** policy.holdWrites (opt-in): a salient write waits for the model (never reordering the store's writes). */
  private gateMutation(m: MutationRec): { held?: Promise<Verdict> } {
    if (!this.consultable() || this.covered(m)) return {};
    let resolveV!: (v: Verdict) => void;
    const held = new Promise<Verdict>((r) => (resolveV = r));
    let sync = true;
    let syncVerdict: Verdict | null = null;
    const settle = (v: Verdict) => {
      if (sync) syncVerdict = v;
      resolveV(v);
    };
    this.trigger({ trigger: "mutation", m }, this.mutationController(m, settle), { hold: true, priority: 2 });
    sync = false;
    if (syncVerdict === "apply") return {};
    if (syncVerdict) return { held: Promise.resolve(syncVerdict) };
    return { held };
  }

  /** Default (no store holds): a write about to apply is triaged now and decided in the background. */
  private observeWrite(m: MutationRec): void {
    if (!this.consultable() || m.genclass || this.covered(m)) return;
    this.trigger({ trigger: "mutation", m }, this.mutationController(m, null), { hold: false, priority: 1 });
  }

  /** The write's causal chain went through the delivery gate, which predicted these fields and decided in time. */
  private covered(m: MutationRec): boolean {
    if (this.triage === "always") return false; // every trigger is asked
    let op: OpRec | undefined = m.cause ?? undefined;
    for (let n = 0; op && n < 16; n++) {
      const d = op.delivery;
      if (d) {
        if (!d.known) return false;
        const all = m.changes.every((c) => d.patterns.has(c.path) || d.patterns.has(normalizeFieldPath(c.path)));
        return all && (!d.salient || d.decided);
      }
      op = this.ops.get(op.cause);
    }
    return false;
  }

  /**
   * Expected time for a new decision: the usual provider latency for it and every decision queued ahead of it, plus
   * the one being computed (at least as long as it has already taken). Infinite while the provider is not answering
   * (its last evaluation timed out): holding would only add latency.
   */
  private expectedLatency(): number {
    if (this.queue.stuck) return Infinity;
    const lat = this.queue.latencies();
    let base: number;
    if (lat.length) {
      const a = [...lat].sort((x, y) => x - y);
      base = a[Math.floor((a.length - 1) / 2)];
    } else base = this.decider?.status.warmupMs ?? 0;
    const current = this.queue.computing ? Math.max(base, this.clock.now() - this.queue.computingSince) : 0;
    return base * (1 + this.queue.waiting) + current;
  }

  // ----------------------------------------------------------------------------------------------- delivery

  /**
   * The delivery gate: a response (or push message) for op X is about to reach the app. Salient when a field X's
   * signature writes has newer data or a pending local change; then the delivery waits for the model (only extra
   * latency). discard: deliver, but drop the writes X's chain makes over newer data; defer: wait for the related
   * in-flight operations, then decide again (twice at most).
   */
  runDelivery(
    o: { op: OpRec; channel: "response" | "websocket" | "eventsource"; req?: ReqMeta; status?: number; message?: { path: string; summary: string }; queuedAhead?: number },
    release: () => void,
    defers = 0,
  ): void {
    let released = false;
    const rel = () => {
      if (released) return;
      released = true;
      release();
    };
    const op = o.op;
    if (!this.consultable() || this.paused || this.destroyed || op.genclass) return rel();
    const now = this.clock.now();
    const predicted = predictedWrites(this.env, op);
    const matched = matchFields(this.env, predicted.patterns);
    const conflicts = conflictsOn(this.env, op, matched, now);
    op.delivery = { patterns: new Set(predicted.patterns), known: predicted.source !== "unknown", salient: conflicts.length > 0, decided: false };
    const spec: DeliverySpec = { trigger: "delivery", op, channel: o.channel, predicted, matched, conflicts, defers, queuedAhead: o.queuedAhead ?? 0 };
    if (o.req) spec.req = o.req;
    if (o.status !== undefined) spec.status = o.status;
    if (o.message) spec.message = o.message;
    const what = o.channel === "response" ? `the response to ${opLabel(op)}` : `message ${opLabel(op)}`;
    const ctl: Controller = {
      passive: rel,
      proceeded: () => released,
      stale: () => released,
      run: (action) => {
        if (released) throw new Error("already delivered");
        if (action === "discard") {
          const protect = new Set(conflicts.map((c) => c.path));
          const mark: NonNullable<OpRec["discardMark"]> = { protect, until: this.clock.now() + DISCARD_MARK_MS, dropped: [] };
          op.discardMark = mark;
          rel();
          const shown = [...protect].slice(0, 3).join(", ");
          return {
            changed: `Delivered ${what} and dropped the state changes it makes over newer data${shown ? ` (${shown})` : ""}.`,
            onRecord: (r) => {
              r.dropped = [...new Set(mark.dropped.map((d) => d.path))];
              mark.onDrop = (paths) => r.dropped!.push(...paths.filter((p) => !r.dropped!.includes(p)));
            },
            undo: () => {
              mark.until = 0;
              const values = new Map<string, { value: unknown; removed: boolean }>();
              for (const d of mark.dropped) values.set(d.path, { value: d.after, removed: d.removed });
              if (values.size) this.hub.restoreFields(values, this.ctx.op());
            },
          };
        }
        if (action === "defer") {
          const related = relatedInFlight(this.env, op, matched);
          const t0 = this.clock.now();
          return this.waitOps(related).then(() => {
            this.runDelivery(o, release, defers + 1);
            return { changed: `Held ${what} for ${secs(this.clock.now() - t0)} until ${plural(related.length, "related operation")} finished, then decided again.` };
          });
        }
        throw new Error(`unsupported action ${action}`);
      },
    };
    this.trigger(spec, ctl, { hold: true, priority: 2 });
  }

  /** Writes of a chain marked by delivery `discard` that would land over newer data. */
  private dropFilter(m: MutationRec): Set<string> | null {
    if (m.genclass || m.userSync) return null;
    const now = this.clock.now();
    let x: OpRec | undefined = m.cause ?? undefined;
    for (let n = 0; x && n < 16; n++) {
      if (x.discardMark && x.discardMark.until >= now) break;
      x = this.ops.get(x.cause);
    }
    if (!x || !x.discardMark || x.discardMark.until < now) return null;
    const mark = x.discardMark;
    const drop = new Set<string>();
    for (const c of m.changes) if (mark.protect.has(c.path) || this.writtenOver(x, c.path)) drop.add(c.path);
    return drop;
  }

  /** Since x started, a user action or a newer operation (outside x's chain) wrote this field. */
  private writtenOver(x: OpRec, path: string): boolean {
    for (const e of this.hub.logSince(path, x.startSeq)) {
      if (e.writer === null) continue;
      const w = this.ops.get(e.writer);
      if (!w || this.ops.isAncestorOrSelf(x, w) || this.ops.isAncestorOrSelf(w, x)) continue;
      if (e.user || w.kind === "user" || w.start > x.start) return true;
      const root = this.ops.get(e.root);
      if (root && root.kind === "user" && root.start > x.start) return true;
    }
    return false;
  }

  private onDropped(m: MutationRec, dropped: FieldChange[], applied: boolean): void {
    let x: OpRec | undefined = m.cause ?? undefined;
    for (let n = 0; x && n < 16 && !x.discardMark; n++) x = this.ops.get(x.cause);
    const paths = dropped.map((c) => c.path);
    if (x?.discardMark) {
      for (const c of dropped) x.discardMark.dropped.push({ path: c.path, after: c.after, removed: c.afterLeaf === undefined });
      x.discardMark.onDrop?.(paths);
    }
    const text = `dropped the write of ${paths.join(", ")}${m.cause ? ` by ${opLabel(m.cause)}` : ""} over newer data${applied ? " (its other changes applied)" : ""}`;
    this.events.push(this.clock.now(), "action", "dropped", { ...(m.cause ? { op: m.cause.id } : {}), data: { text, paths, op: x?.id ?? null, mutation: m.id } });
  }

  /** Resolves when all these ops ended (10 s at most). */
  private waitOps(ops: OpRec[]): Promise<void> {
    const pending = new Set(ops.filter((o) => o.end === undefined));
    if (!pending.size) return Promise.resolve();
    return new Promise((resolve) => {
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
          if (!c.afterLeaf) continue; // a container that became expanded (or a removed field) is not a write target
          const key = normalizeFieldPath(c.path);
          const prev = acc.get(key);
          const k1 = normalizeLeafKind(c.afterLeaf);
          acc.set(key, { kind: k1, len0: prev ? prev.len0 : c.beforeLeaf?.len ?? -1, len1: c.afterLeaf?.len ?? -1 });
        }
        if (op.kind !== "user") {
          this.lastChainMap.set(op.name, [...acc.keys()]);
          if (this.lastChainMap.size > 1000) {
            const first = this.lastChainMap.keys().next().value;
            if (first !== undefined) this.lastChainMap.delete(first);
          }
        }
      }
    }
    this.miner.noteChanged(changes.map((c) => c.path));
    this.miner.noteValues(changes.map((c) => [c.path, c.afterLeaf] as [string, Leaf | undefined]));
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
    // fresh: violated now but not at the previous settled point (a new episode)
    const brokeNow = res.violations.filter((v) => !this.episode.has(v.id));
    const fresh = brokeNow.filter((v) => !this.muted.has(v.id));
    this.episode = ids;
    // A consistent snapshot is a settled state where nothing newly broke: violations that already lingered at the
    // previous settled point (reported once, then accepted) do not block later snapshots, so a rollback never
    // restores an ancient state because of one benign lingering violation.
    if (brokeNow.length === 0) {
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
        if (action === "rollback") return this.revertChain(op, "transition");
        if (action === "resync") return this.resync(stores);
        throw new Error(`unsupported action ${action}`);
      },
    };
    this.trigger({ trigger: "transition", op, unusual, shape }, ctl, { hold: false, priority: 0 });
  }

  /** Fields written by an op's causal chain since its root started (see SitEnv.chainWrites). */
  chainWrites(op: OpRec): ChainWriteInfo[] {
    const root = this.ops.rootOf(op);
    const rootId = root.id;
    const since = root.startSeq;
    const out: ChainWriteInfo[] = [];
    for (const x of this.hub.changedSince(since)) {
      const f = this.hub.field(x.path);
      if (!f) continue;
      const entries = f.log.filter((e) => e.seq > since);
      const mine = entries.filter((e) => e.root === rootId);
      if (!mine.length) continue;
      const first = f.hist.find((h) => h.seq === mine[0].seq);
      const info: ChainWriteInfo = { path: x.path, count: mine.length, lastIsChain: entries[entries.length - 1].root === rootId };
      if (first) info.before = { value: first.before, removed: first.beforeLeaf === undefined };
      out.push(info);
    }
    return out;
  }

  /**
   * Rollback for error/transition triggers: restore exactly the fields the op's own causal chain wrote (and that
   * nobody overwrote since) to their values before the chain's first write. Other chains' writes (user input in
   * another field, other requests) are never touched. Undo restores the values replaced.
   */
  revertChain(op: OpRec, why: string): ActionEffect {
    const targets = this.chainWrites(op).filter((w) => w.lastIsChain && w.before !== undefined && this.hub.get(w.path.split(".")[0])?.writable);
    if (!targets.length) throw new Error("the chain wrote nothing that can be restored");
    const values = new Map<string, { value: unknown; removed: boolean }>();
    const current = new Map<string, { value: unknown; removed: boolean }>();
    for (const w of targets) {
      values.set(w.path, w.before!);
      const leaf = this.hub.leaf(w.path);
      current.set(w.path, { value: leaf?.value, removed: leaf === undefined });
    }
    const restored = this.runAsGenClass("rollback", () => this.hub.restoreFields(values, this.ctx.op()));
    if (!restored.length) throw new Error("nothing to restore: the fields already hold their earlier values");
    const root = this.ops.rootOf(op);
    return {
      changed: `Restored ${restored.slice(0, 4).join(", ")}${restored.length > 4 ? ` and ${restored.length - 4} more` : ""} to their values before ${opLabel(root)} (the ${why}'s chain wrote them).`,
      undo: () => {
        this.hub.restoreFields(current, this.ctx.op());
      },
    };
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
        if (changes && changes.length) restored.push(`${name} (${changes.map((c) => c.path).slice(0, 3).join(", ")})`);
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
        for (const [k, l] of m.leaves ?? flatten(store, m.preview, this.hub.get(store)?.leaves)) leaves.set(k, l);
        return this.miner.preview(leaves, m.changes.map((c) => c.path));
      },
      canCoalesce: (id, self) => !!this.cache.shareable(id, self, this.clock.now()),
      resyncable: (store) => typeof this.hub.get(store)?.opts.resync === "function",
      chainWrites: (op) => this.chainWrites(op),
      lastChain: (sig) => this.lastChainMap.get(sig),
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
    } else {
      s = this.hub.register(name, "atom", initial, opts as StoreOptions<unknown>);
      this.miner.noteValues(s.leaves);
    }
    return this.handle<T>(s);
  }

  guard<T>(name: string, io: StoreIO<T>, opts: StoreOptions<T> = {}): Guarded<T> {
    const s = this.hub.register(name, "guard", io.get(), opts as StoreOptions<unknown>, io as StoreIO<unknown>);
    this.miner.noteValues(s.leaves);
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
    this.miner.noteValues(s.leaves);
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
      get: () => {
        // holdWrites: inside the writing chain, read your own pending writes
        if (hub.holdWrites && s.queue.length) {
          const amb = rt.ctx.peek();
          const op = amb instanceof LazyOp ? amb.nearest : amb;
          const v = hub.pendingView(s, op ? op.root ?? op.id : null);
          if (v !== undefined) return v as T;
        }
        return hub.read(s) as T;
      },
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
    if (this.destroyed) throw new GenClassUnavailableError("destroyed", "this GenClass runtime was destroyed");
    const p = this.decider;
    if (!p) throw new GenClassUnavailableError("off", "GenClass has no model (model: false)");
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
    const sub = this.queue.submit(
      { trigger: "ask", state: built.situation.state, questions, priority: 1, subject: built.subjectRef },
      opts.timeoutMs !== undefined ? this.clock.now() + opts.timeoutMs : undefined,
    );
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
    const ctl: Controller = {
      passive: () => undefined,
      run: (action) => {
        if (action === "rollback" && op) return this.revertChain(op, "error");
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
    const d = r.decision;
    const detected = d.diagnosis !== "expected" && d.diagnosisConfidence >= this.policy.thresholds.report;
    const message = r.action ? interventionLine(d, r.action) : detected ? detectionLine(d) : decisionLine(d);
    const e: Explanation = { message, decision: d, situationText: r.situationText, facts: r.facts, timeline: r.timeline, answers: r.answers };
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
    this.reporter.dispose();
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
