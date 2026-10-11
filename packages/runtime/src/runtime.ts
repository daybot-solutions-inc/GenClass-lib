// Runtime: wires trace, state, learn, situation and decide together (CONTRACT §2-§9).

import type {
  TelemetryStatus,
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
  StoreInfo,
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
  EffectiveGates,
  Aggressiveness,
  ActionRequest,
  ModeOrOff,
  OpScope,
  RouteRule,
  RequestScope,
  SessionSummary,
  SinkRecord,
  SinkKind,
  EnabledSource,
  AuditEntry,
  AuditKind,
  AuditModel,
} from "./types.js";
import { AuditLog, type AuditDraft } from "./decide/audit.js";
import { expandPresets } from "./presets.js";
import { Breaker, breakerConfig } from "./decide/breaker.js";
import { SinkDispatcher, SummaryTracker } from "./decide/summary.js";
import { compileMatchers, compileValued, hash32, routeMatches, sanitizeLabel, type CompiledMatcher, type MatchInput } from "./util/match.js";
import { browserClock } from "./clock.js";
import { GenClassUnavailableError } from "./errors.js";
import { EventLog } from "./trace/events.js";
import { OpRegistry, type OpRec, type StartOpts } from "./trace/ops.js";
import { Context, LazyOp } from "./trace/context.js";
import { StoreHub, toChanges, type MutationRec, type StoreRec, type Verdict } from "./state/hub.js";
import { cloneValue, flatten, normalizeLeafKind, type FieldChange, type Leaf } from "./state/fields.js";
import { InvariantMiner } from "./state/invariants.js";
import { Baselines } from "./learn/baselines.js";
import { Cadence } from "./learn/cadence.js";
import { analyzeBody, createdIds, vhash } from "./situation/content.js";
import { commitAmbiguity, failureOf, hostOfSig } from "./situation/evidence.js";
import { Profiles, shapeOf } from "./learn/profiles.js";
import { buildSituation, deliveryDroppable, relatedInFlight, type BuildOptions, type BuiltSituation } from "./situation/build.js";
import { computeFacts, NO_BASELINE_STALL_MS } from "./situation/facts.js";
import type { ChainWriteInfo, CreateRec, DeliverySpec, ErrorInfo, OutcomeRec, ReqMeta, SitEnv, SubjectSpec, Violation } from "./situation/env.js";
import { conflictsOn, matchFields, predictedWrites } from "./situation/conflicts.js";
import { installEventSource } from "./observe/eventsource.js";
import { opLabel } from "./situation/describe.js";
import { BUILTIN_ACTIONS, diagnosisVocabulary, PASSIVE, TRIGGER_ACTIONS } from "./situation/questions.js";
import { STATE_CHAR_BUDGET, stateText } from "./situation/serialize.js";
import { DeciderQueue } from "./decide/decider.js";
import { aggressivenessLevel, effectiveGates, gate, holdBudget, parseGate, permittedActions, policyConfig, RateLimiter, restriction, type PolicyConfig } from "./decide/policy.js";
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
import { defaultRedact, normalizeFieldPath, plural, ratio, secs, truncate, type Redactor } from "./util.js";
import { blockedMessage } from "./model/blocked.js";
import type { ReactDiscovery } from "./discover/react.js";
import type { ReduxDiscovery } from "./discover/redux.js";
import { discoveryRegistry } from "./discover/registry.js";
import type { Captured, DiscoveryHost, ObservedStore, WalkStats } from "./discover/types.js";

const DECISIONS_KEPT = 200;
/**
 * A write that applied before its decision arrived (not held, or its hold budget expired) can still be reverted this
 * long after it applied. 800 ms (the hold budget's ceiling, HOLD_MAX_MS) since heal/overnight, was 2,000 ms: in the
 * demos benchmark every late revert decided ≥ 0.88 s after its write ended in a user-visible bug (5 of 5, two of
 * them on clean runs where the reverted write was the right answer), while those decided ≤ 0.65 s were mostly fixes.
 * After about a second the user has been looking at the new value; reverting it is a second visible change.
 */
export const LATE_REVERT_MS = 800;
/** Non-held triggers (stall, inconsistency, transition, error) are not worth answering after this long. */
const BACKGROUND_DEADLINE_MS = 5000;
/** A delivery `discard` keeps dropping the chain's writes over newer data for this long. */
const DISCARD_MARK_MS = 10_000;
/** A salient delivery waits at most this long for its body (a buffered clone) before deciding without it. */
const BODY_WAIT_MS = 100;
/** Stores the user wrote this recently are not checked for relations at a settled point (typing bursts). */
const TYPING_BURST_SETTLE_MS = 1000;
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
  gates: EffectiveGates;
  /** The subject waited for this decision (false: decided in the background). */
  held: boolean;
  budget: number;
  compact: boolean;
  /** Automatically discovered state had been recorded when this situation was built (telemetry leaves its text out). */
  autoState: boolean;
}

/** Internal observation points for telemetry (src/telemetry): counts only, never input to a decision. */
export interface RuntimeTap {
  modelError?(e: unknown): void;
  /** A salient situation ran the passive action without an answer: "not-ready", "no-answer", "error". */
  failOpen?(reason: string, trigger: TriggerKind): void;
}

type Listeners = { [K in keyof RuntimeEvents]: Set<(v: RuntimeEvents[K]) => void> };

const MODE_RANK: Record<ModeOrOff, number> = { off: 0, observe: 1, guard: 2, heal: 3 };
function minMode(a: ModeOrOff, b: ModeOrOff): ModeOrOff {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}
/** Actions this recent can still be rolled back by rt.disable({ undo: true }). */
const UNDO_WINDOW_MS = 60_000;

/** Query and fragment values of URLs in free text → "…" (sink evidence, OPTIONS-SPEC §4.10). */
export function redactUrlText(t: string): string {
  return String(t).replace(/([?&#][^=&#\s"]+)=([^&#\s"]*)/g, (_m, k: string) => `${k}=…`);
}

/** The op a decision's subject is about (its trigger op, a write's cause, an error's ambient op). */
function subjectOpOf(spec: SubjectSpec): OpRec | null {
  switch (spec.trigger) {
    case "mutation":
      return spec.m.cause ?? null;
    case "request":
    case "failure":
    case "stall":
    case "delivery":
    case "transition":
      return spec.op;
    case "error":
      return spec.op ?? null;
    default:
      return null;
  }
}

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


/** Fan-out siblings start within this window of each other (one callback issuing several requests). */
export const FANOUT_WINDOW_MS = 100;

/**
 * A writer that is x's fan-out sibling: a request of the same kind (fetch, xhr) started by the same direct cause
 * within FANOUT_WINDOW_MS of x (one timer tick or user action fetching several items at once). See runDelivery.
 */
export function fanOutSibling(
  x: { cause?: number | null; kind: string; start: number },
  w: { cause?: number | null; kind: string; start: number } | undefined,
): boolean {
  return !!w && x.cause !== undefined && x.cause !== null && w.cause === x.cause && w.kind === x.kind && Math.abs(w.start - x.start) <= FANOUT_WINDOW_MS;
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
  /** Automatic state discovery (InitOptions.autoState; src/discover). */
  private discovered: { react: ReactDiscovery | null; redux: ReduxDiscovery | null } | null = null;
  private captureSeq = 0;
  private decider: DecisionProvider | null;
  private _ready: Promise<void> | null = null;
  private readonly ownsDecider: boolean;
  private listeners: Listeners = {
    detect: new Set(),
    decide: new Set(),
    act: new Set(),
    event: new Set(),
    status: new Set(),
    report: new Set(),
    shadow: new Set(),
    breaker: new Set(),
    limit: new Set(),
    modelBudget: new Set(),
  };
  // ---- configuration extensions (OPTIONS-SPEC)
  /** "on", "pending" (an async enabled predicate: pass-through), "off" (an EnabledSource flipped off), "disabled". */
  private enabledState: "on" | "pending" | "off" | "disabled" = "on";
  private sampled = true;
  private routes: RouteRule[] = [];
  private routeScope: { route?: string; rule?: number; mode: ModeOrOff; aggressiveness: number } = { mode: "heal", aggressiveness: 1 };
  private requestsOpt: RequestScope = {};
  private mIgnore!: CompiledMatcher<true>;
  private mProtect!: CompiledMatcher<true>;
  private mLabels!: CompiledMatcher<string>;
  private breakerImpl: Breaker | null = null;
  private shadowMode: "guard" | "heal" | false = false;
  private onBeforeAction: ((a: ActionRequest) => boolean | void) | undefined;
  private vetoMode: "enforce" | "report" = "enforce";
  private hookWarnedAt = -Infinity;
  private limitWarned = new Map<string, number>();
  private sinks!: SinkDispatcher;
  private auditLog!: AuditLog;
  private sum!: SummaryTracker;
  private sessionId = "";
  private sessionTags: Record<string, string | number | boolean> = {};
  /** Held subjects' passive callbacks: released unchanged on disable, breaker trip, hidden tab. */
  private heldPassives = new Set<() => void>();
  private learnStore: "local" | "session" | null = null;
  private learnKey = "genclass:learn";
  private learnVersion: string | undefined;
  private reportMode: "console" | "interventions" | "silent" | "fn" = "console";
  private uninstall: (() => void)[] = [];
  private teardowns: (() => void)[] = [];
  /** Telemetry observation points (src/telemetry). */
  tap: RuntimeTap | null = null;
  /** runtime.telemetry (set by createRuntime). */
  telemetry?: TelemetryStatus;
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
  /** Learned schedules / debounces of request signatures (F6). */
  private readonly cadence = new Cadence();
  /** Create responses of the last 10 s (read-your-writes). */
  private createsBuf: CreateRec[] = [];
  /** Completed requests of the last 30 s across signatures (failure scope, F5). */
  private outcomesBuf: OutcomeRec[] = [];
  /** Live channels that went down: path -> when and why (F9 marks when they come back). */
  private channelsDown = new Map<string, { t: number; code: number | string; channel: "websocket" | "eventsource" }>();
  /** Deliveries released without waiting whose background decision is pending: it covers their chain's writes. */
  private deliveryPending = new WeakSet<OpRec>();
  /** Deliveries released without a hold whose content analysis waits for the body: cut short at their chain's first write. */
  private deliveryAnalysis = new Map<OpRec, () => void>();

  constructor(o: CreateOptions & { decider?: DecisionProvider | null; ownsDecider?: boolean } = {}) {
    this.clock = o.clock ?? browserClock;
    this.global = (o.global ?? globalThis) as Record<string, unknown>;
    this.events = new EventLog(o.historySize ?? 500);
    this.ctx = new Context(this.clock);
    // built-in secret-name redaction always runs first; a custom function can only redact further (OPTIONS-SPEC §4.10)
    const custom = o.redact;
    this.redactFn = custom
      ? (path: string, value: unknown, kind?: "state" | "url" | "header" | "input") => {
          const b = defaultRedact(path, value);
          try {
            return custom(path, b, kind);
          } catch {
            return "[redacted]";
          }
        }
      : defaultRedact;
    this.hub = new StoreHub(this.clock, this.ctx, this.events, () => this.redactFn);
    this.miner = new InvariantMiner(
      () => this.redactFn,
      (p) => this.hub.busy(p),
    );
    this.cache = new ResponseCache(this.clock);
    this.policy = policyConfig(o.policy);
    this.hub.holdUserWrites = this.policy.holdUserWrites;
    this.hub.holdWrites = this.policy.holdWrites;
    this.rate = new RateLimiter(() => this.policy.actionLimits);
    this.debug = !!o.debug;
    // URL overrides only demote, unless debug (OPTIONS-SPEC §3)
    const url = this.urlParams();
    this._mode = o.mode ?? "observe";
    const um = url.get("genclass-mode");
    if (um === "observe" || um === "guard" || um === "heal") if (this.debug || MODE_RANK[um] <= MODE_RANK[this._mode]) this._mode = um;
    if (o.policy?.maxActionsPerMinute !== undefined && o.policy?.actionLimits?.perMinute !== undefined) this.warn("policy.maxActionsPerMinute is deprecated and ignored when actionLimits.perMinute is set.");
    this.triage = o.triage ?? "salient";
    this.vocab = o.vocabulary;
    this.hooks = o.hooks ?? {};
    this.settleMs = o.settleMs ?? 60;
    // aggressiveness: the URL override (?genclass-aggr=…) may only lower it, unless debug
    this._aggr = aggressivenessLevel(o.aggressiveness);
    const ua = url.get("genclass-aggr");
    if (ua) {
      const v = aggressivenessLevel(ua);
      if (this.debug || v <= this._aggr) this._aggr = v;
    }
    this.budgetOpt = o.situation?.budget ?? "auto";
    this.appFn = o.app;
    this.persist = !!o.learn?.persist;
    this.learnStore = o.learn?.persist === "session" ? "session" : o.learn?.persist ? "local" : null;
    if (o.learn?.key) this.learnKey = o.learn.key;
    const rel = o.session?.tags?.release;
    this.learnVersion = o.learn?.version ?? (rel !== undefined ? String(rel) : undefined);
    this.decider = o.decider ?? null;
    this.ownsDecider = !!o.ownsDecider;
    this.queue = new DeciderQueue(this.clock, () => this.decider, (e) => {
      // the model could not fit the situation: use smaller automatic budgets from now on
      if ((e as { code?: string })?.code === "max_tokens_exceeded") this.budgetScale = Math.max(0.5, this.budgetScale * 0.8);
      this.log("model error", e);
      try {
        this.tap?.modelError?.(e);
      } catch {
        /* telemetry never breaks the runtime */
      }
    });
    // model.maxDecisionsPerMinute: default 30 for the built-in model; custom providers only when set
    const mo = o.model && typeof o.model === "object" ? o.model : undefined;
    const mdpm = mo?.maxDecisionsPerMinute ?? (mo && o.ownsDecider ? 30 : undefined);
    if (typeof mdpm === "number" && mdpm > 0) this.queue.perMinute = mdpm;
    this.queue.onBudget = (b) => {
      this.sum.s.model.dropped = b.dropped;
      this.fire("modelBudget", b);
    };
    this.reportMode = typeof o.report === "function" ? "fn" : (o.report ?? "console");
    this.reporter = new Reporter(o.report === "interventions" ? "console" : o.report ?? "console", this.clock, (id) => this.explain(id), (r) => this.fire("report", r));
    // session, sinks, summary
    this.sum = new SummaryTracker(this.clock);
    this.sessionId = typeof o.session?.id === "string" && o.session.id ? o.session.id.slice(0, 128) : this.newSessionId();
    this.sessionTags = this.cleanTags(o.session?.tags ?? {});
    this.sinks = new SinkDispatcher(o.sinks, this.clock, this.global, (m) => this.warn(m));
    this.auditLog = new AuditLog(o.audit, this.clock, (m) => this.warn(m));
    // sample: the session's bucket is decided once and frozen (sessionStorage)
    this.sampled = this.sampleBucket(o.sample, url.get("genclass-sample"));
    // routes, requests
    this.routes = Array.isArray(o.routes) ? o.routes : [];
    this.requestsOpt = o.requests ?? {};
    this.mIgnore = compileMatchers(this.requestsOpt.ignore as never, "nomatch");
    // "preset:payments" / "preset:auth" strings stand for those presets' matchers (src/presets.ts)
    this.mProtect = compileMatchers(expandPresets(this.requestsOpt.protect, (m) => this.warn(m)) as never, "match");
    const labels: { match: never; value: string }[] = [];
    let labelWarned = false;
    for (const l of this.requestsOpt.labels ?? []) {
      const { label, changed } = sanitizeLabel(l?.label ?? "");
      if (changed && !labelWarned) {
        labelWarned = true;
        this.warn("requests.labels: labels are names only ([A-Za-z0-9 _-], ≤ 5 words, ≤ 40 chars); other characters were stripped.");
      }
      if (label) labels.push({ match: l.match as never, value: label });
    }
    this.mLabels = compileValued(labels, "nomatch");
    // breaker, shadow, veto
    const bc = breakerConfig(o.breaker);
    if (bc)
      this.breakerImpl = new Breaker(bc, this.clock, () => this.storage("session"), (t, counts) => this.onBreakerTrip(t.reason, t.decisionIds, counts));
    this.shadowMode = o.shadow === "guard" || o.shadow === "heal" ? o.shadow : false;
    this.onBeforeAction = typeof o.onBeforeAction === "function" ? o.onBeforeAction : undefined;
    this.vetoMode = o.vetoMode === "report" ? "report" : "enforce";
    this.computeScope();
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
        if (this.deliveryAnalysis.size) this.finalizeDeliveries(m.cause);
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
      // the model host also notifies while it stays ready (latency stats after the first decision, then every 5 s):
      // the "Model ready" line is printed when the model becomes ready, not on each of those updates
      let wasReady = false;
      const off = this.decider.onStatus((s) => {
        this.fire("status", s);
        const becameReady = s.state === "ready" && !wasReady;
        wasReady = s.state === "ready";
        if (becameReady) this.emitReport({ kind: "status", message: `[GenClass] Model ready (${[s.model, s.device, s.variant].filter(Boolean).join(", ")}${s.loadMs !== undefined ? `, ${secs(s.loadMs)}` : ""}). Mode: ${this._mode}.` });
        // a blocked download (CSP, most often): one warning naming the origin and the fix, instead of the bare error
        if (s.state === "error" && s.blocked) this.warnOnce("model-blocked", blockedMessage(s.blocked));
        else if (s.state === "error") this.emitReport({ kind: "status", message: `[GenClass] Model unavailable (${s.error ?? "error"}); observing only.` });
      });
      this.uninstall.push(off);
    }
    if (this.persist) this.loadProfiles();
    // enabled (OPTIONS-SPEC §4.1): false installs nothing; a predicate, Promise or flag runs pass-through until true
    const en = o.enabled;
    if (en === false) {
      this.enabledState = "disabled";
      return;
    }
    this.installObservers(o.observe ?? {});
    if (o.autoState) this.installDiscovery(o.autoState);
    for (const p of o.plugins ?? []) this.use(p);
    if (en !== undefined && en !== true) this.followEnabled(en);
    const g = this.global as { addEventListener?: (t: string, fn: () => void) => void; removeEventListener?: (t: string, fn: () => void) => void };
    if (typeof g.addEventListener === "function") {
      let sent = false;
      const end = () => {
        if (sent) return;
        sent = true;
        this.emitSummary();
      };
      const vis = () => {
        if (this.hidden()) end();
      };
      try {
        g.addEventListener("pagehide", end);
        (this.global.document as EventTarget | undefined)?.addEventListener?.("visibilitychange", vis);
        this.uninstall.push(() => {
          g.removeEventListener?.("pagehide", end);
          (this.global.document as EventTarget | undefined)?.removeEventListener?.("visibilitychange", vis);
        });
      } catch {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------------- configuration extensions (OPTIONS-SPEC)

  private urlParams(): URLSearchParams {
    try {
      const search = (this.global.location as { search?: unknown } | undefined)?.search;
      if (typeof search === "string" && search) return new URLSearchParams(search);
    } catch {
      /* no URL */
    }
    return new URLSearchParams();
  }

  private warn(msg: string): void {
    const con = (this.global.console as Console | undefined) ?? (globalThis as { console?: Console }).console;
    con?.warn?.(`[GenClass] ${msg}`);
  }

  private storage(kind: "local" | "session"): Storage | undefined {
    try {
      return (kind === "local" ? this.global.localStorage : this.global.sessionStorage) as Storage | undefined;
    } catch {
      return undefined;
    }
  }

  private newSessionId(): string {
    try {
      const c = this.global.crypto as { randomUUID?: () => string } | undefined;
      if (typeof c?.randomUUID === "function") return c.randomUUID();
    } catch {
      /* fall through */
    }
    return `s${hash32(`${this.clock.now()}:${String(this.global.location ? (this.global.location as { href?: string }).href : "")}`).toString(36)}`;
  }

  /** Session tags: redacted by name, ≤ 20 keys, keys and values ≤ 64 chars. */
  private cleanTags(t: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    for (const [k0, v] of Object.entries(t ?? {})) {
      if (Object.keys(out).length >= 20) break;
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
      const k = k0.slice(0, 64);
      const r = this.redactFn(`session.tags.${k}`, v, "state");
      out[k] = typeof r === "string" ? r.slice(0, 64) : typeof r === "number" || typeof r === "boolean" ? r : "[redacted]";
    }
    return out;
  }

  /** The session's act/observe bucket (OPTIONS-SPEC §4.2): hash(session id) < sample, frozen in sessionStorage. */
  private sampleBucket(sample: number | undefined, urlSample: string | null): boolean {
    if (urlSample === "0") return false;
    if (urlSample === "1" && this.debug) return true;
    if (sample === undefined) return true;
    let p = Number(sample);
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      this.warn(`sample must be between 0 and 1 (got ${sample}); clamped.`);
      p = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 1;
    }
    if (p >= 1) return true;
    const ss = this.storage("session");
    try {
      const saved = ss?.getItem("genclass:bucket");
      if (saved === "act" || saved === "observe") return saved === "act";
    } catch {
      /* deterministic within the page */
    }
    const act = hash32(this.sessionId) / 4294967296 < p;
    try {
      ss?.setItem("genclass:bucket", act ? "act" : "observe");
    } catch {
      /* ignore */
    }
    return act;
  }

  private currentRoute(): string {
    const loc = this.global.location as { pathname?: string } | undefined;
    return typeof loc?.pathname === "string" ? loc.pathname : "/";
  }

  /** Route scope (OPTIONS-SPEC §4.3): the first matching rule, demote only. Recomputed on navigation. */
  computeScope(): void {
    const route = this.currentRoute();
    let mode: ModeOrOff = "heal";
    let aggr = 1;
    let rule: number | undefined;
    for (let i = 0; i < this.routes.length; i++) {
      const r = this.routes[i];
      if (!r || !routeMatches(r.match, route)) continue;
      rule = i;
      if (r.mode === "off" || r.mode === "observe" || r.mode === "guard" || r.mode === "heal") {
        if (MODE_RANK[r.mode] > MODE_RANK[this._mode]) {
          if (!this.routeWarned.has(i)) {
            this.routeWarned.add(i);
            this.warn(`routes[${i}] asks for mode ${r.mode} above the global mode ${this._mode}: route rules can only lower it.`);
          }
        } else mode = r.mode;
      }
      if (r.aggressiveness !== undefined) aggr = aggressivenessLevel(r.aggressiveness);
      break;
    }
    this.routeScope = { route, ...(rule !== undefined ? { rule } : {}), mode, aggressiveness: aggr };
  }
  private routeWarned = new Set<number>();

  /** min(global mode, sample cap, breaker cap): the session-wide part of the effective mode. */
  private sessionMode(): ModeOrOff {
    if (this.enabledState !== "on") return "off";
    let m: ModeOrOff = this._mode;
    if (!this.sampled) m = minMode(m, "observe");
    if (this.breakerImpl?.tripped) m = minMode(m, this.breakerImpl.cfg.downgradeTo);
    return m;
  }

  /** The effective mode for a subject: the session part and the op's snapshotted route scope. */
  effectiveMode(op?: OpRec | null): ModeOrOff {
    return minMode(this.sessionMode(), op?.scope?.mode ?? this.routeScope.mode);
  }

  /** The effective aggressiveness for a subject: min(global, route scope). */
  private effectiveAggr(op?: OpRec | null): number {
    return Math.min(this._aggr, op?.scope?.aggressiveness ?? this.routeScope.aggressiveness);
  }

  /** Scope of a new op (snapshotted). Network ops pass what their observer computed. */
  private defaultScope(): OpScope {
    const rs = this.routeScope;
    return { mode: rs.mode, aggressiveness: rs.aggressiveness, protected: false, crossOrigin: false, ...(rs.route ? { route: rs.route } : {}) };
  }

  /** A network request's scope, or "ignore" (pass-through, OPTIONS-SPEC §4.4). */
  scopeOf(r: MatchInput & { headers?: Record<string, string> }): OpScope | "ignore" {
    const cross = this.isCrossOrigin(r.url);
    if (cross && this.requestsOpt.crossOrigin === "ignore") return "ignore";
    if (this.mIgnore.match(r)) return "ignore";
    const sc = this.defaultScope();
    sc.crossOrigin = cross;
    sc.protected = !!this.mProtect.match(r);
    const label = this.mLabels.match(r);
    if (label) {
      sc.label = label;
      if (this.requestsOpt.labelsToModel === true) sc.labelToModel = true;
    }
    if (this.requestsOpt.correlate) {
      try {
        const v = this.requestsOpt.correlate({ url: r.url, method: r.method, headers: r.headers ?? {} });
        if (typeof v === "string" && v) {
          const red = this.redactFn("correlationId", v, "header");
          sc.correlationId = String(red).slice(0, 128);
        }
      } catch {
        /* undefined */
      }
    }
    return sc;
  }

  private isCrossOrigin(url: string): boolean {
    try {
      const loc = this.global.location as { href?: string } | undefined;
      if (!loc?.href) return false;
      const base = new URL(loc.href);
      const u = new URL(url, base);
      if (/^wss?:$/.test(u.protocol)) return u.host !== base.host;
      return u.origin !== base.origin;
    } catch {
      return false;
    }
  }

  private hidden(): boolean {
    try {
      return (this.global.document as { visibilityState?: string } | undefined)?.visibilityState === "hidden";
    } catch {
      return false;
    }
  }

  /** Release every held subject unchanged (disable, breaker trip, hidden tab). */
  private releaseHolds(): void {
    for (const p of [...this.heldPassives]) {
      try {
        p();
      } catch {
        /* ignore */
      }
    }
    this.heldPassives.clear();
    for (const s of this.hub.stores.values()) if (s.queue.length) this.hub.flushQueue(s);
  }

  private followEnabled(en: Exclude<NonNullable<CreateOptions["enabled"]>, boolean>): void {
    const set = (on: boolean) => {
      if (this.destroyed || this.enabledState === "disabled") return;
      const from = this.enabledState;
      if (on) {
        this.enabledState = "on";
        if (from !== "on") this.auditControl("enabled", from, "on");
        this.fire("status", this.status);
        return;
      }
      this.enabledState = "off";
      if (from !== "off") this.auditControl("enabled", from, "off");
      this.releaseHolds();
      this.fire("status", this.status);
    };
    if (typeof en === "function") {
      this.enabledState = "pending";
      let r: boolean | Promise<boolean>;
      try {
        r = en();
      } catch (e) {
        this.warn(`enabled() threw (${(e as Error)?.message ?? e}); GenClass stays disabled.`);
        this.enabledState = "off";
        return;
      }
      if (r && typeof (r as Promise<boolean>).then === "function")
        (r as Promise<boolean>).then(
          (v) => set(!!v),
          (e) => {
            this.warn(`enabled() rejected (${(e as Error)?.message ?? e}); GenClass stays disabled.`);
            set(false);
          },
        );
      else set(!!r);
      return;
    }
    const src = en as EnabledSource;
    try {
      set(!!src.get());
      const off = src.subscribe((v) => set(!!v));
      if (typeof off === "function") this.uninstall.push(off);
    } catch (e) {
      this.warn(`enabled source failed (${(e as Error)?.message ?? e}); GenClass stays disabled.`);
      this.enabledState = "off";
    }
  }

  // ------------------------------------------------------------------------------------------- audit trail

  /** The model in force now, for audit entries (never throws). */
  private auditModel(): AuditModel {
    const st = this.decider?.status;
    if (!st) return { name: "none", state: "off" };
    const m: AuditModel = { name: st.model ?? st.variant ?? "custom", state: st.state };
    if (st.version) m.version = st.version;
    if (st.variant) m.variant = st.variant;
    if (st.device) m.device = st.device;
    if (st.sha256) m.sha256 = st.sha256;
    return m;
  }

  /** The common part of an audit entry. */
  private auditBase(kind: AuditKind, mode: ModeOrOff, aggr: number, op?: OpRec | null): AuditDraft {
    const profile = aggr === 0 ? "cautious" : aggr === 0.5 ? "balanced" : aggr === 1 ? "eager" : undefined;
    const d: AuditDraft = { at: this.clock.now(), kind, sessionId: this.sessionId, mode, requestedMode: this._mode, aggressiveness: aggr, model: this.auditModel() };
    if (profile) d.profile = profile;
    if (op?.scope?.label) d.label = op.scope.label;
    if (op?.scope?.correlationId) d.correlationId = op.scope.correlationId;
    return d;
  }

  /** Record an audit entry built by `make` (the audit trail never breaks the runtime). */
  private pushAudit(make: () => AuditDraft): void {
    try {
      this.auditLog.push(make());
    } catch (e) {
      this.log("audit entry failed", e);
    }
  }

  private auditControl(what: NonNullable<AuditEntry["control"]>["what"], from?: string | number, to?: string | number): void {
    this.pushAudit(() => ({ ...this.auditBase("control", this.sessionMode(), this._aggr), control: { what, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) } }));
  }

  private onBreakerTrip(reason: "undos" | "errors", ids: string[], counts: { undos: number; errors: number }): void {
    this.releaseHolds();
    this.pushAudit(() => ({ ...this.auditBase("breaker", this.sessionMode(), this._aggr), breaker: { tripped: true, reason, decisionIds: [...ids], counts: { ...counts } } }));
    this.fire("breaker", { tripped: true, reason, decisionIds: ids, counts });
    const msg = `[GenClass] Circuit breaker tripped (${reason}: ${counts.undos} undos, ${counts.errors} errors after actions); mode capped at ${this.breakerImpl?.cfg.downgradeTo}. rt.breaker.reset() clears it.`;
    this.warn(msg.replace(/^\[GenClass\] /, ""));
    this.emitReport({ kind: "breaker", message: msg });
    this.fire("status", this.status);
  }

  /** Subject keys an action or an error is attributed to (breaker, perSubject limits): op signatures and stores. */
  private subjectKeys(spec: SubjectSpec): string[] {
    const keys: string[] = [];
    const op = subjectOpOf(spec);
    if (op) keys.push(op.name);
    if (spec.trigger === "mutation") keys.push(`store:${spec.m.store}`);
    return keys;
  }

  /** Every report goes through here: decorated (mode, session, labels), printed, counted and sent to sinks. */
  private emitReport(r: Report, op?: OpRec | null): void {
    const sub = op ?? (r.decision ? this.opOfDecision(r.decision) : null);
    const out: Report = { ...r, mode: r.decision?.effectiveMode ?? this.effectiveMode(sub), session: { id: this.sessionId, tags: { ...this.sessionTags } } };
    if (sub?.scope?.correlationId) out.correlationId = sub.scope.correlationId;
    if (sub?.scope?.label) out.label = sub.scope.label;
    if (this.reportMode === "interventions" && !(r.kind === "intervene" || r.kind === "undo" || r.kind === "breaker" || r.kind === "error")) this.fire("report", out);
    else this.reporter.emit(out);
    if (r.kind === "detect" && r.decision) this.sum.inc(this.sum.s.detections, r.decision.diagnosis);
    if (r.kind === "intervene" && r.action) {
      this.sum.inc(this.sum.s.interventions, r.action.action);
      if (r.action.late) this.sum.s.lateReverts++;
    }
    if (r.kind === "undo") this.sum.s.undos++;
    if (r.kind === "error") this.sum.s.errors++;
    const kind: SinkKind | null = r.kind === "detect" ? "detection" : r.kind === "intervene" ? "intervention" : r.kind === "status" ? null : r.kind;
    if (kind) this.sinks.push(this.toSinkRecord(kind, out, sub));
  }

  private opOfDecision(d: Decision): OpRec | null {
    const id = d.subjectRef?.op ?? d.subjectRef?.cause;
    return typeof id === "number" ? this.ops.get(id) ?? null : null;
  }

  private toSinkRecord(kind: SinkKind, r: Report, op: OpRec | null | undefined): SinkRecord {
    const d = r.decision;
    const a = r.action;
    const rec: SinkRecord = { schema: 1, kind, id: this.sinks.nextId(), ts: this.clock.now(), sessionId: this.sessionId, tags: { ...this.sessionTags }, mode: r.mode ?? this.sessionMode(), sampled: this.sampled };
    if (r.correlationId) rec.correlationId = r.correlationId;
    if (r.label) rec.label = r.label;
    if (d) {
      rec.diagnosis = d.diagnosis;
      rec.p = d.confidence;
      rec.trigger = d.trigger;
      if (d.reason) rec.reason = d.reason;
      if (d.shadow) rec.shadow = { ...d.shadow };
    }
    if (a) {
      rec.action = a.action;
      rec.tier = a.tier;
      const paths = a.dropped ?? (d?.subjectRef?.paths ?? []);
      if (paths.length) rec.changed = [...paths];
    }
    if (kind === "undo") rec.undone = true;
    if (this.sinks.wantsEvidence()) {
      const ex = a ? this.explain(a.id) : d ? this.explain(d.id) : null;
      rec.evidence = {
        message: redactUrlText(r.message),
        ...(d ? { trigger: d.trigger, subject: redactUrlText(d.subject) } : {}),
        ...(ex ? { timeline: ex.timeline.map(redactUrlText) } : {}),
      };
    }
    void op;
    return rec;
  }

  private emitSummary(): void {
    const summary = this.summary();
    this.sinks.push({ schema: 1, kind: "summary", id: this.sinks.nextId(), ts: this.clock.now(), sessionId: this.sessionId, tags: { ...this.sessionTags }, mode: this.sessionMode(), sampled: this.sampled, summary });
    void this.sinks.flush();
  }

  summary(): SessionSummary {
    const s = this.sum.snapshot(this.decider?.status.state ?? "off");
    s.model.dropped = this.queue.budget().dropped;
    return s;
  }

  setSession(p: { id?: string; tags?: Record<string, string | number | boolean> }): void {
    if (typeof p?.id === "string" && p.id) this.sessionId = p.id.slice(0, 128);
    if (p?.tags) this.sessionTags = this.cleanTags({ ...this.sessionTags, ...p.tags });
  }

  get breaker(): { reset(): void; readonly tripped: boolean } {
    const b = this.breakerImpl;
    return {
      reset: () => {
        if (!b) return;
        const was = !!b.tripped;
        b.reset();
        if (was) {
          this.pushAudit(() => ({ ...this.auditBase("breaker", this.sessionMode(), this._aggr), breaker: { tripped: false, reason: "reset", decisionIds: [], counts: { undos: 0, errors: 0 } } }));
          this.fire("breaker", { tripped: false, reason: "reset", decisionIds: [], counts: { undos: 0, errors: 0 } });
          this.fire("status", this.status);
        }
      },
      get tripped() {
        return !!b?.tripped;
      },
    };
  }

  get learn(): { clear(): void } {
    return {
      clear: () => {
        this.profiles.bySig.clear();
        for (const k of ["local", "session"] as const) {
          try {
            this.storage(k)?.removeItem(this.learnKey);
          } catch {
            /* ignore */
          }
        }
      },
    };
  }

  /** Turn GenClass off for this page (OPTIONS-SPEC §4.1). `undo: true` rolls back actions still in their undo window. */
  disable(o: { undo?: boolean } = {}): void {
    if (this.enabledState === "disabled" && this.destroyed) return;
    if (o.undo) {
      const now = this.clock.now();
      for (const a of [...this.actionsBuf].reverse()) {
        if (!a.undo || now - a.at > UNDO_WINDOW_MS) continue;
        this.internalUndo = true;
        try {
          a.undo();
        } catch {
          /* ignore */
        } finally {
          this.internalUndo = false;
        }
      }
    }
    this.releaseHolds();
    this.auditControl("disable", this.enabledState, o.undo ? "disabled (undo)" : "disabled");
    this.enabledState = "disabled";
    this.destroy();
  }
  private internalUndo = false;

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
    if (on("nav"))
      tryAdd("nav", () =>
        installNav(g, this, (route) => {
          this.events.push(this.clock.now(), "nav", route, { data: { route } });
          this.computeScope();
        }),
      );
    if (on("storage")) tryAdd("storage", () => installStorage(g, (area, op, key) => this.onStorage(area, op, key)));
    if (on("perf")) tryAdd("perf", () => installPerf(g, (name, duration) => this.events.push(this.clock.now(), "perf", name, { data: { duration } })));
  }

  // ------------------------------------------------------------------------------- automatic state discovery

  /**
   * InitOptions.autoState: React (DevTools hook), Redux / RTK (Redux DevTools compose/enhancer: full adapters),
   * Zustand and other Redux DevTools `connect` clients (observed only). Installed synchronously, in a browser only.
   */
  private installDiscovery(opt: NonNullable<CreateOptions["autoState"]>): void {
    const g = this.global;
    if (typeof g.document !== "object" || g.document === null || typeof g.window !== "object") return;
    const inst = discoveryRegistry.installers;
    if (!inst) {
      this.warn('autoState needs the discovery code: use @genclass/runtime/auto or the script tag, or import "@genclass/runtime/discover" before GenClass.init().');
      return;
    }
    const on = (k: "react" | "redux" | "zustand") => (typeof opt === "object" ? opt[k] !== false : true);
    const host: DiscoveryHost & { runtime: Runtime } = {
      global: g,
      clock: this.clock,
      runtime: this,
      capture: () => {
        const a = this.ctx.peek();
        return { amb: a, user: a !== null && !(a instanceof LazyOp) && this.ctx.isUserSync(a), seq: ++this.captureSeq };
      },
      observed: (base, initial, source) => this.observedStore(base, initial, source),
      freeName: (base) => this.freeStoreName(base),
      tag: (name, source) => {
        const s = this.hub.get(name);
        if (s) s.source = source;
      },
      log: (m, e) => this.log(m, e),
    };
    const d: { react: ReactDiscovery | null; redux: ReduxDiscovery | null } = { react: null, redux: null };
    const early = discoveryRegistry.early;
    if (early && !early.host.attached) {
      // installed when @genclass/runtime/discover was evaluated (before the framework): attach to it
      early.host.attach(host);
      if (on("react")) d.react = early.react;
      else early.react?.uninstall();
      d.redux = early.redux;
      early.redux?.configure({ redux: on("redux"), connect: on("zustand") });
      if (on("redux")) early.redux?.attached();
      this.discovered = d;
      this.uninstall.push(() => early.host.detach(host));
      return;
    }
    try {
      if (on("react")) d.react = inst.react(host);
    } catch (e) {
      this.log("React state discovery could not be installed; skipped", e);
    }
    try {
      if (on("redux") || on("zustand")) d.redux = inst.redux(host, { redux: on("redux"), connect: on("zustand") });
    } catch (e) {
      this.log("Redux state discovery could not be installed; skipped", e);
    }
    this.discovered = d;
    this.uninstall.push(() => {
      d.react?.uninstall();
      d.redux?.uninstall();
    });
  }

  /** A store name derived from `base` that no store uses yet (`base`, `base_2`, ... `base_99`). */
  private freeStoreName(base: string): string | null {
    const b = base || "store";
    if (!this.hub.get(b)) return b;
    for (let i = 2; i < 100; i++) if (!this.hub.get(`${b}_${i}`)) return `${b}_${i}`;
    return null;
  }

  /** Register an observed-only store (kind "observed") under a free name; null after 64 discovered stores. */
  private observedStore(base: string, initial: unknown, source: string): ObservedStore | null {
    if (this.destroyed) return null;
    let n = 0;
    for (const s of this.hub.stores.values()) if (s.kind === "observed") n++;
    if (n >= 64) return null;
    const name = this.freeStoreName(base);
    if (!name) return null;
    const s = this.hub.register(name, "observed", initial, {});
    s.source = source;
    this.miner.noteValues(s.leaves);
    const hub = this.hub;
    const rt = this;
    return {
      name,
      write(value: unknown, w: Captured | null) {
        // gone when the runtime was destroyed or the app registered a store with this name since
        if (rt.destroyed || hub.get(name) !== s) return;
        let op: OpRec | null = null;
        let user = false;
        if (w) {
          const a = w.amb as OpRec | LazyOp | null;
          op = a instanceof LazyOp ? a.materialize() : a;
          user = w.user;
        }
        hub.observe(s, value, op, user);
      },
    };
  }

  /** Registered and discovered stores (introspection; the devtools overlay lists them). */
  stores(): StoreInfo[] {
    const out: StoreInfo[] = [];
    for (const s of this.hub.stores.values()) {
      const i: { name: string; kind: StoreRec["kind"]; source?: string; writable: boolean; fields: number; version: number } = {
        name: s.name,
        kind: s.kind,
        writable: s.writable,
        fields: s.leaves.size,
        version: s.version,
      };
      if (s.source) i.source = s.source;
      out.push(i);
    }
    return out;
  }

  /** State discovery counters (internal: tests, benchmarks): React commit walks and the stores found. */
  discoveryStats(): { react: (WalkStats & { renderers: number; tapped: number; components: number }) | null; redux: { reduxStores: string[]; connected: string[] } | null } | null {
    const d = this.discovered;
    if (!d) return null;
    return { react: d.react?.stats() ?? null, redux: d.redux?.stats() ?? null };
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
      gated: (op) => !this.paused && !this.destroyed && !op.genclass && this.enabledState === "on" && op.scope?.mode !== "off",
      mayHold: (op) => this.requestHoldable(op),
      scopeOf: (r) => this.scopeOf(r),
      trigger: (spec, ctl, opts) => this.trigger(spec, ctl, opts),
      watchStall: (op, req, ctl) => this.watchStall(op, req, ctl),
      failureStreak: (sig) => this.base.stats(sig)?.failStreak ?? 0,
      uniqueId: () => `uniq:${++this.uniq}`,
      deliver: (o, release) => {
        // an observer whose body is already in memory (XHR) exposes it synchronously as `body.now`
        const now = (o.body as { now?: () => unknown } | undefined)?.now;
        this.runDelivery({ op: o.op, channel: "response", req: o.req, status: o.status, ...(o.body ? { body: o.body } : {}), ...(typeof now === "function" ? { bodyNow: now } : {}) }, release);
      },
      noteResponse: (o) => this.noteResponse(o),
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
      scopeOf: (r: MatchInput) => this.scopeOf(r),
      redact: () => this.redactFn,
      baseHref: () => (this.global.location as { href?: string } | undefined)?.href,
      startOp: (name: string, o: Omit<StartOpts, "startSeq" | "t">) => this.startOp("ws", name, o),
      endOp: (op: OpRec, status: OpStatus, eo?: EndOpts) => this.endOp(op, status, eo),
      event: (name: string, data: Record<string, unknown>, op?: OpRec) => this.events.push(this.clock.now(), "custom", name, { ...(op ? { op: op.id } : {}), data }),
      deliverMessage: (
        o: { op: OpRec; channel: "websocket" | "eventsource"; message: { path: string; summary: string }; queuedAhead: number; body?: () => Promise<unknown>; bodyNow?: () => unknown },
        release: () => void,
      ) => this.runDelivery(o, release),
      channel: (state: "down" | "up", channel: "websocket" | "eventsource", path: string, code?: number | string) => this.onChannel(state, channel, path, code),
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
    op.scope = o.scope ?? this.defaultScope();
    // requests.protect covers a protected request's causal chain: what its response callbacks do (writes, timers,
    // follow-up requests) is observed only, like the request itself (snapshotted here, as every scope)
    if (cause && cause.scope?.protected && !op.scope.protected) op.scope = { ...op.scope, protected: true };
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
      // cadence: background (schedule) vs a steady delay after a user action through a timer (debounce)
      const u = this.ops.userOf(op);
      const viaTimer = !!cause && cause.kind === "timer";
      this.cadence.note(name, t, { user: !!u, ...(u && viaTimer ? { userDelay: t - u.start } : {}) });
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
      // breaker: a failed request (≥ 500 or a network error) on a recently acted-on subject
      if (o.failure && (typeof o.code !== "number" || o.code >= 500)) this.breakerImpl?.error([op.name]);
      if (status !== "aborted") {
        this.outcomesBuf.push({ t, sig: op.name, host: hostOfSig(op.name), ok: !o.failure, outcome });
        while (this.outcomesBuf.length > 128 || (this.outcomesBuf.length && t - this.outcomesBuf[0].t > 30_000)) this.outcomesBuf.shift();
      }
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
    return holdBudget(this.policy, this.queue.latencies(), this.warmLatency());
  }

  /** Side-effect free situation building (apart from caching op.reads). */
  build(spec: SubjectSpec): BuiltSituation {
    return buildSituation(this.env, spec, this.buildOpts());
  }

  /** Whether triggers should even be built: a provider exists and could answer now or lazily. */
  private consultable(): boolean {
    if (this.paused || this.destroyed || !this.decider || this.enabledState !== "on") return false;
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
    const subjectOp = subjectOpOf(spec);
    const effMode = this.effectiveMode(subjectOp);
    // a route scope "off": ops there are recorded, never decided
    if (effMode === "off") return passive();
    // hidden tab: held subjects are released at once, background situations are not evaluated (OPTIONS-SPEC §5.1)
    if (this.hidden() && spec.trigger !== "ask") {
      if (!opts.hold) this.sum.s.model.hiddenSkipped++;
      return passive();
    }
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
      this.tapFailOpen("not-ready", spec.trigger);
      return passive();
    }
    // gate steps 1–3: protected, cross-origin or off/observe-scoped subjects are never acted on (nor held)
    const block = this.blockOf(subjectOp);
    if (block) {
      const no: Record<string, string> = { ...(built.situation.notOffered ?? {}) };
      for (const a of built.actions) if (a.tier !== "passive") no[a.name] = block;
      built.situation.notOffered = no;
    }
    // Never hold when no non-passive action is permitted for this trigger in this mode (and policy): the subject
    // proceeds at once and the decision is still made in the background, for detection.
    const permitted = block ? [] : permittedActions(this.policy, effMode as Mode, built.actions);
    // holdBudgetMs is a hard ceiling on a subject's total added latency, deferred re-decisions included
    const t0 = this.clock.now();
    const budget = Math.min(this.holdBudgetMs(), opts.heldSince !== undefined ? this.holdBudgetMs() - (t0 - opts.heldSince) : Infinity);
    if (opts.hold && opts.heldSince !== undefined && budget <= 0) {
      this.sum.inc(this.sum.s.denied, "limit:hold");
      return passive();
    }
    // Never hold when nothing could be done, or when the model is not expected to answer within the hold budget
    // (decide in the background instead: detection, late revert)
    const waits = opts.hold && permitted.length > 0 && !this.paused && this.expectedLatency() <= budget;
    // A delivery that does not wait while its chain's writes can still be discarded or late-reverted by their own
    // decisions (guard, heal: it was not held only because the model would not answer in time): those writes are
    // decided on their own, as before, and the delivery itself only when a question forces it (covering nothing).
    const writesAct = !waits && spec.trigger === "delivery" && this.writesCanAct(effMode as Mode) && deliveryDroppable(this.env, spec.matched);
    if (writesAct && !built.forced && this.triage !== "always") return passive();
    // Otherwise (observe, no permitted action) it is decided in the background: while that decision is pending, its
    // chain's predicted writes are covered by it (no second, mutation decision about the same writes). Registered
    // before the passive action, which may run the app's listeners (and their writes) synchronously.
    const background = !waits && spec.trigger === "delivery" && !writesAct ? spec.op : null;
    if (background) this.deliveryPending.add(background);
    if (!waits) passive();
    else this.heldPassives.add(passive);
    let expired = false;
    let budgetTimer: unknown = null;
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
    // A delivery's controller is stale once the delivery was released: that only makes a queued decision useless
    // when the delivery waits for it. A delivery released without waiting is still decided (detection, reports,
    // standing questions); the decision cannot act any more (see onDecision).
    const stale = ctl.stale && (waits || spec.trigger !== "delivery") ? () => !!ctl.stale!() : undefined;
    this.queue
      .submit(
        {
          trigger: spec.trigger,
          state: built.situation.state,
          questions: built.situation.questions,
          priority: waits ? opts.priority : Math.min(opts.priority, 1),
          subject: built.subjectRef,
          ...(built.situation.notOffered ? { notOffered: { ...built.situation.notOffered } } : {}),
        },
        deadline,
        stale,
      )
      .then((res) => {
        if (budgetTimer !== null) this.clock.clearTimeout(budgetTimer);
        this.heldPassives.delete(passive);
        if (waits) this.sum.held(this.clock.now() - (opts.heldSince ?? t0));
        try {
          if (this.destroyed) return passive();
          if (!res) {
            this.tapFailOpen("no-answer", spec.trigger);
            return passive();
          }
          this.sum.decision(res.latencyMs);
          this.onDecision(built, res.answers, this.clock.now() - t0, ctl, passive, { waits, covers: background !== null, expired, passiveRan: () => passiveRan, hold: opts.hold, budget, block, subjectOp });
        } finally {
          // decided (onDecision marked the delivery decided) or dropped (its later writes are decided on their own)
          if (background) this.deliveryPending.delete(background);
        }
      })
      .catch((e) => {
        this.log("decision failed", e);
        if (background) this.deliveryPending.delete(background);
        this.tapFailOpen("error", spec.trigger);
        passive();
      });
  }

  private onDecision(
    built: BuiltSituation,
    answers: Record<string, Answer>,
    latencyMs: number,
    ctl: Controller,
    passive: () => void,
    st: {
      waits: boolean;
      covers: boolean;
      expired: boolean;
      passiveRan: () => boolean;
      hold: boolean;
      budget?: number;
      block?: "protected" | "cross-origin" | "scope" | null;
      subjectOp?: OpRec | null;
    },
  ): void {
    const trigger = built.spec.trigger;
    const subjectOp = st.subjectOp ?? subjectOpOf(built.spec);
    const effMode = this.effectiveMode(subjectOp);
    const subjectKey = this.subjectKeys(built.spec)[0];
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
    const gates = this.gatesAt(trigger, this.effectiveAggr(subjectOp));
    const gin = {
      actions: offered,
      probabilities,
      top,
      diagnosis,
      mode: (effMode === "off" ? "observe" : effMode) as Mode,
      paused: this.paused,
      now,
      thresholds: { guard: gates.guard, heal: gates.heal },
      kind: gates.kind,
      ...(gates.tauGain !== undefined ? { tauGain: gates.tauGain } : {}),
      ...(st.block ? { block: st.block } : {}),
      ...(subjectKey !== undefined ? { subject: subjectKey } : {}),
    };
    const g = gate(this.policy, this.rate, gin);
    // shadow (OPTIONS-SPEC §4.6): the same answer through gate steps 1–6 at a higher mode, dry run
    let shadow: Decision["shadow"];
    if (this.shadowMode && MODE_RANK[this.shadowMode] > MODE_RANK[effMode]) {
      const scopeBlock = subjectOp?.scope && (subjectOp.scope.mode === "off" || subjectOp.scope.mode === "observe") ? "scope" : null;
      const sg = gate(this.policy, this.rate, { ...gin, mode: this.shadowMode, ...(st.block ?? scopeBlock ? { block: (st.block ?? scopeBlock)! } : {}) });
      const sa = sg.candidate ?? top;
      const stier = built.actions.find((a) => a.name === sa)?.tier ?? "passive";
      if (stier !== "passive" || sg.run) {
        shadow = { action: sa, tier: stier, wouldPass: !!sg.run, ...(sg.reason ? { reason: sg.reason } : {}) };
        this.sum.inc(this.sum.s.shadow, sg.run ? `would-${sa}` : `blocked:${sg.reason ?? "gate"}`);
      }
    }
    if (g.limitKind) this.onLimit(g.limitKind, subjectKey ?? built.situation.subject);
    let reason: string | null = g.reason;
    let run: string | null = g.run;
    let late = false;
    // the subject already went its way (write applied, response delivered, request sent): an action now is late
    const proceeded = ctl.proceeded ? ctl.proceeded() : st.hold && (st.expired || st.passiveRan());
    // a delivery decided while held, or decided in the background when it covers its chain's writes (see trigger):
    // its chain's predicted writes are covered by this decision (a held delivery released at its budget is not: its
    // writes are decided on their own)
    if (trigger === "delivery" && (!proceeded || st.covers)) {
      const op = (built.spec as DeliverySpec).op;
      if (op.delivery) op.delivery.decided = true;
    }
    const custom = run ? built.actions.find((a) => a.name === run)?.custom : undefined;
    // a delivery that was already released can only take the passive action (custom actions included)
    if (run && proceeded && (!custom || trigger === "delivery")) {
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
    if (reason?.startsWith("limit:perMinute") && now - this.rateWarnedAt > 60_000) {
      this.rateWarnedAt = now;
      this.emitReport({ kind: "status", message: `[GenClass] Rate limit reached (${this.policy.actionLimits.perMinute} actions/minute): running passive actions until it clears.` });
    }
    const decisionId = `d${++this.nextDecision}`;
    // onBeforeAction (OPTIONS-SPEC §4.7): the app's synchronous last veto; its time counts against the hold budget
    if (run && this.onBeforeAction) {
      const rtier = (built.actions.find((a) => a.name === run)?.tier ?? "guard") as "guard" | "heal";
      const req: ActionRequest = { action: run, tier: rtier, trigger, subject: built.situation.subject, diagnosis, p: probabilities[run] ?? 0, decisionId };
      if (subjectOp?.scope?.route) req.route = subjectOp.scope.route;
      if (subjectOp?.scope?.label) req.label = subjectOp.scope.label;
      const h0 = this.clock.now();
      let veto = false;
      try {
        const r = this.onBeforeAction(req);
        if (r === false) veto = true;
        else if (r !== true && r !== undefined) this.warnOnce("hook-return", "onBeforeAction must return true, false or undefined synchronously; the action proceeds.");
      } catch (e) {
        veto = true;
        this.warn(`onBeforeAction threw (${(e as Error)?.message ?? e}); the action is vetoed.`);
      }
      const hookMs = this.clock.now() - h0;
      if (hookMs > 5 && this.clock.now() - this.hookWarnedAt > 60_000) {
        this.hookWarnedAt = this.clock.now();
        this.warn(`onBeforeAction took ${hookMs} ms (keep it under 5 ms: it adds latency to held requests).`);
      }
      if (veto && this.vetoMode === "enforce") {
        run = null;
        reason = "vetoed";
      } else if (veto) reason = "would-veto";
      if (run && st.waits && !late && st.budget !== undefined && latencyMs + hookMs > st.budget) {
        run = null;
        reason = "limit:hold";
      }
    }
    if (!run && reason) this.sum.inc(this.sum.s.denied, reason.split(" ")[0]);
    const action = run ?? top;
    const opt = built.actions.find((a) => a.name === action);
    const tier: Tier = opt?.tier ?? "passive";
    const decision: Decision = {
      id: decisionId,
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
    decision.effectiveMode = effMode;
    if (shadow) decision.shadow = shadow;
    decision.gateKind = gates.kind;
    if (g.threshold !== undefined && g.thresholdTier) {
      if (gates.kind === "gain") {
        decision.margin = g.threshold;
        if (g.gain !== undefined) decision.gain = g.gain;
      } else decision.threshold = g.threshold;
      decision.thresholdSource = gates.source[g.thresholdTier];
    }
    if (reason) decision.reason = reason;
    this.decisionsBuf.push(decision);
    if (this.decisionsBuf.length > DECISIONS_KEPT) this.decisionsBuf.shift();
    const auditAggr = gates.aggressiveness;
    this.pushAudit(() => {
      const ag: NonNullable<AuditEntry["gate"]> = { kind: gates.kind, thresholds: { report: gates.report, guard: gates.guard, heal: gates.heal }, source: { ...gates.source } };
      if (g.candidate) ag.candidate = g.candidate;
      if (gates.kind === "gain") {
        if (g.gain !== undefined) ag.gain = g.gain;
        if (g.threshold !== undefined) ag.margin = g.threshold;
      } else {
        ag.mass = g.mass;
        if (g.threshold !== undefined) ag.threshold = g.threshold;
      }
      return {
        ...this.auditBase("decision", effMode, auditAggr, subjectOp),
        decisionId: decision.id,
        trigger,
        subject: redactUrlText(decision.subject),
        diagnosis,
        diagnosisConfidence,
        proposed: top,
        probabilities: { ...probabilities },
        ran: decision.ran,
        executed: decision.executed,
        tier,
        ...(reason ? { reason } : {}),
        gate: ag,
        held: st.waits,
        ...(st.budget !== undefined ? { holdBudgetMs: st.budget } : {}),
        latencyMs,
        ...(shadow ? { shadow: { ...shadow } } : {}),
      };
    });
    const rec: ExplainRec = {
      decision,
      situationText: stateText(built.situation.state),
      facts: built.situation.facts,
      timeline: built.parts.timeline,
      answers,
      gates,
      held: st.waits,
      budget: built.situation.budget,
      compact: built.situation.compact,
      autoState: this.discoveredWrites(),
    };
    this.explainMap.set(decision.id, rec);
    if (this.explainMap.size > DECISIONS_KEPT * 2) {
      const first = this.explainMap.keys().next().value;
      if (first !== undefined) this.explainMap.delete(first);
    }
    this.events.push(now, "decision", trigger, { data: { id: decision.id, diagnosis, action, executed: decision.executed } });
    if (this.debug) this.log(`decision ${decision.id}`, decision);
    this.fire("decide", decision);
    if (shadow) {
      this.fire("shadow", { decisionId: decision.id, ...shadow });
      if (this.debug) this.log(`shadow ${this.shadowMode}: ${shadow.wouldPass ? `would run ${shadow.action}` : `would not act (${shadow.reason ?? "gate"})`}`);
    }
    const detected = diagnosis !== "expected" && diagnosisConfidence >= gates.report;
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
      if (detected) this.emitReport({ kind: "detect", message: detectionLine(decision), decision });
      return;
    }
    // execute the non-passive action
    this.rate.take(now, subjectKey);
    this.breakerImpl?.action(decision.id, this.subjectKeys(built.spec));
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
          this.emitReport({ kind: "undo", message: `[GenClass] Undid ${action} (${record.id}).`, decision, action: record }, subjectOp);
          const byRuntime = this.internalUndo;
          this.pushAudit(() => ({ ...this.auditBase("undo", this.effectiveMode(subjectOp), auditAggr, subjectOp), decisionId: decision.id, actionId: record.id, trigger, subject: redactUrlText(record.subject), ran: action, tier, byRuntime }));
          // an undo by the app or the user is a signal for the breaker (not rt.disable({ undo: true }))
          if (!this.internalUndo) this.breakerImpl?.undo(decision.id);
        };
      }
      this.pushAudit(() => ({
        ...this.auditBase("action", effMode, auditAggr, subjectOp),
        decisionId: decision.id,
        actionId: record.id,
        trigger,
        subject: redactUrlText(record.subject),
        ran: action,
        tier,
        ok: record.ok,
        ...(record.error ? { error: redactUrlText(record.error) } : {}),
        changed: redactUrlText(record.changed),
        undoable: !!record.undo,
        ...(record.late ? { late: true } : {}),
        ...(record.dropped ? { dropped: [...record.dropped] } : {}),
      }));
      this.actionsBuf.push(record);
      if (this.actionsBuf.length > DECISIONS_KEPT) this.actionsBuf.shift();
      rec.action = record;
      this.explainMap.set(record.id, rec);
      this.events.push(record.at, "action", action, { data: { text: record.changed, id: record.id, decision: decision.id, ok: record.ok } });
      this.fire("act", record);
      this.emitReport({ kind: "intervene", message: interventionLine(decision, record), decision, action: record });
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
        const sop = subjectOpOf(built.spec);
        const em = this.effectiveMode(sop);
        if (this.paused || em === "off" || this.blockOf(sop) || restriction(this.policy, em as Mode, { name, tier: b.tier }) !== null) return false;
        if (ctl.proceeded?.()) return false;
        const t = this.clock.now();
        const key = this.subjectKeys(built.spec)[0];
        if (this.rate.check(t, key)) return false;
        this.rate.take(t, key);
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
    // holdBudgetMs is a ceiling on the write's total added latency: a deferred write's re-decisions share its budget
    m.heldSince ??= this.clock.now();
    this.trigger({ trigger: "mutation", m }, this.mutationController(m, settle), { hold: true, priority: 2, ...(m.defers > 0 ? { heldSince: m.heldSince } : {}) });
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

  /**
   * The write's causal chain went through the delivery gate, which predicted these fields and decided in time (or
   * is deciding in the background: the delivery did not wait for its decision).
   */
  private covered(m: MutationRec): boolean {
    if (this.triage === "always") return false; // every trigger is asked
    let op: OpRec | undefined = m.cause ?? undefined;
    for (let n = 0; op && n < 16; n++) {
      const d = op.delivery;
      if (d) {
        if (!d.known) return false;
        const all = m.changes.every((c) => d.patterns.has(c.path) || d.patterns.has(normalizeFieldPath(c.path)));
        return all && (!d.salient || d.decided || this.deliveryPending.has(op));
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
  /**
   * The model's latency before any real decision: the warm pass timed after the pipelines compiled (WebGPU compiles
   * on the first pass, so the first pass alone would read as seconds and the first salient request after load would
   * never be held), else the warm-up pass itself.
   */
  private warmLatency(): number {
    const st = this.decider?.status;
    const warm = st?.latency?.p50;
    if (typeof warm === "number" && warm > 0) return warm;
    return st?.warmupMs ?? 0;
  }

  private expectedLatency(): number {
    if (this.queue.stuck) return Infinity;
    const lat = this.queue.latencies();
    let base: number;
    if (lat.length) {
      const a = [...lat].sort((x, y) => x - y);
      base = a[Math.floor((a.length - 1) / 2)];
    } else base = this.warmLatency();
    const current = this.queue.computing ? Math.max(base, this.clock.now() - this.queue.computingSince) : 0;
    return base * (1 + this.queue.waiting) + current;
  }

  // ----------------------------------------------------------------------------------------------- delivery

  /**
   * The delivery gate: a response (or push message) for op X is about to reach the app. Salient when a field X's
   * signature writes has newer data or a pending local change; then the delivery waits for the model (only extra
   * latency). discard: deliver, but drop the writes X's chain makes over newer data; defer: wait for the related
   * in-flight operations, then decide again (twice at most).
   *
   * When no hold is possible (observe mode, no permitted action, the model not ready or not expected to answer within
   * the hold budget), the delivery is released synchronously, before any body read: the app gets it exactly as
   * without GenClass. The content analysis and the decision follow in the background (detection, reports, standing
   * questions), still on the state the delivery was released into: a body already in memory (`bodyNow`: XHR,
   * WebSocket, EventSource) is analyzed right away, before the app's listeners run; a body still being read (fetch)
   * is not waited for past the first write of the delivery's chain (decided without it then). In guard or heal mode
   * (the model too slow to hold for), the chain's writes keep their own decisions (late revert) instead: see trigger().
   */
  runDelivery(
    o: {
      op: OpRec;
      channel: "response" | "websocket" | "eventsource";
      req?: ReqMeta;
      status?: number;
      message?: { path: string; summary: string };
      queuedAhead?: number;
      body?: () => Promise<unknown>;
      /** The same body, synchronously, when it is already in memory. */
      bodyNow?: () => unknown;
    },
    release: () => void,
    defers = 0,
    heldSince?: number,
  ): void {
    let released = false;
    const rel = () => {
      if (released) return;
      released = true;
      release();
    };
    const op = o.op;
    // protected / ignored-scope / off-scope subjects pass at once: no body read, no hold, zero added latency
    if (!this.consultable() || this.paused || this.destroyed || op.genclass || op.scope?.protected || op.scope?.mode === "off") return rel();
    const since = heldSince ?? this.clock.now();
    const now = this.clock.now();
    const predicted = predictedWrites(this.env, op);
    const matched = matchFields(this.env, predicted.patterns);
    const conflicts = conflictsOn(this.env, op, matched, now);
    // salience (situation v2): newer data that is already applied (a newer request of the same signature still in
    // flight makes newer-data conflicts neutral, see conflicts.ts); a pending local change or text the user typed
    // only when the body shows the response would overwrite it (put back the older value / replace the text)
    // Triage: a newer-data conflict whose writer is a fan-out sibling (a request started by the same operation at the
    // same moment: one timer tick or user action fetching several items) is not salient. Siblings are concurrent peers
    // of one intent, so their completion order is arbitrary rather than older vs newer (a status board polling six
    // services that each also write a shared `updatedAt` made every round look stale). Only salience changes: when the
    // delivery is decided for another reason, its situation still lists every conflict.
    const newer = conflicts.filter((c) => c.kind === "newer" && !fanOutSibling(op, c.writer));
    const pending = conflicts.filter((c) => c.kind === "pending");
    op.delivery = { patterns: new Set(predicted.patterns), known: predicted.source !== "unknown", salient: newer.length > 0, decided: false };
    const spec: DeliverySpec = { trigger: "delivery", op, channel: o.channel, predicted, matched, conflicts, defers, queuedAhead: o.queuedAhead ?? 0 };
    if (o.req) spec.req = o.req;
    if (o.status !== undefined) spec.status = o.status;
    if (o.message) spec.message = o.message;
    const what = o.channel === "response" ? `the response to ${opLabel(op)}` : `message ${opLabel(op)}`;
    /**
     * Delivered over newer data (or a pending local change) without a decision to drop it: its chain's writes to
     * those fields are marked as possibly stale (F9).
     */
    const markOverNewer = () => {
      if (!conflicts.length || !op.delivery?.salient) return;
      const c0 = conflicts[0];
      op.delivery.overNewer = { paths: new Set(conflicts.map((c) => c.path)), by: c0.writer ? opLabel(c0.writer) : "a newer operation", kind: c0.kind };
    };
    const ctl: Controller = {
      passive: () => {
        if (!released) markOverNewer();
        rel();
      },
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
          // the wait is part of the hold: it never exceeds what is left of the hold budget
          const remaining = Math.max(0, this.holdBudgetMs() - (t0 - since));
          return this.waitOps(related, remaining).then(() => {
            if (this.clock.now() - since >= this.holdBudgetMs()) {
              this.sum.inc(this.sum.s.denied, "limit:hold");
              rel();
            } else this.runDelivery(o, release, defers + 1, since);
            return { changed: `Held ${what} for ${secs(this.clock.now() - t0)} until ${plural(related.length, "related operation")} finished, then decided again.` };
          });
        }
        throw new Error(`unsupported action ${action}`);
      },
    };
    // text fields the user typed into after this op started: salient only if the body would replace that text (F2)
    const typed = matched.filter((p) => typeof this.hub.valueAt(p) === "string" && this.hub.writesSince(p, op.startSeq).some((h) => h.user && !this.inChainOf(op, h.writer)));
    const always = this.triage === "always" || this.standing.some((q) => q.always && q.on.includes("delivery"));
    if (!conflicts.length && !typed.length && !always) return rel();
    // No hold is possible: deliver now, before any body read; analyze and decide in the background (see above)
    const background = !this.deliveryHoldable(op, matched, defers, since);
    if (background) rel();
    /** Decide without (more) content: newer applied data is salient; pending changes and typed text need the body. */
    const settle = (salient: boolean) => {
      if (op.delivery) op.delivery.salient = salient;
      if (background) {
        // already delivered: the passive action, then the decision for detection only (it cannot act)
        markOverNewer();
        if (salient || always) this.trigger(spec, ctl, { hold: false, priority: 2 });
        return;
      }
      if (!salient && !always) return rel();
      if (released) return;
      // holdBudgetMs is a ceiling on the delivery's total added latency: the wait for its body above counts against it.
      // Nothing left of it: deliver now and decide in the background (detection), like a delivery that cannot be held
      if (defers === 0 && this.holdBudgetMs() - (this.clock.now() - since) <= 0) {
        markOverNewer();
        rel();
        this.trigger(spec, ctl, { hold: false, priority: 2 });
        return;
      }
      this.trigger(spec, ctl, { hold: true, priority: 2, heldSince: since });
    };
    if (!o.body) return settle(newer.length > 0);
    let done = false;
    let timer: unknown = null;
    const finish = (body: unknown) => {
      if (done) return;
      done = true;
      if (timer !== null) this.clock.clearTimeout(timer);
      if (background) this.deliveryAnalysis.delete(op);
      if (body === undefined || this.destroyed) return settle(newer.length > 0);
      try {
        spec.body = body;
        spec.content = analyzeBody(this.env, op, body, matched);
        const by = new Map(spec.content.cmps.map((c) => [c.path, c]));
        // newer data: unless the response already equals it (F3); not located → assume it would change it
        const liveNewer = newer.filter((c) => !by.get(c.path)?.same);
        // a pending local change: only when the response puts back the value the user's change replaced (F1)
        const livePending = pending.filter((c) => {
          const cmp = by.get(c.path);
          if (!cmp || cmp.same || !c.writer) return false;
          const hist = this.hub.field(c.path)?.hist ?? [];
          let h: (typeof hist)[number] | undefined;
          for (let i = hist.length - 1; i >= 0 && !h; i--) if (hist[i].root === c.writer.id) h = hist[i];
          return !!h && vhash(h.before) === vhash(cmp.incoming);
        });
        // text typed since the request started: only when the response would replace it (F2)
        const liveTyped = typed.filter((p) => by.has(p) && !by.get(p)!.same);
        const salient = liveNewer.length > 0 || livePending.length > 0 || liveTyped.length > 0;
        if (!salient && conflicts.length && conflicts.every((c) => by.get(c.path)?.same)) this.events.push(this.clock.now(), "custom", "delivery.unchanged", { op: op.id, data: { paths: conflicts.map((c) => c.path) } });
        return settle(salient);
      } catch (e) {
        this.log("content analysis failed", e);
        return settle(newer.length > 0);
      }
    };
    if (background && o.bodyNow) {
      // the body is in memory: analyze it now, before the app's listeners run (and never break the delivery)
      let body: unknown;
      try {
        body = o.bodyNow();
      } catch {
        body = undefined;
      }
      try {
        finish(body);
      } catch (e) {
        this.log("background delivery analysis failed", e);
      }
      return;
    }
    // read the body first (a clone, bounded in time)
    timer = this.clock.setTimeout(() => finish(undefined), BODY_WAIT_MS);
    // the delivery's chain is about to write: decide now, without the body (see finalizeDeliveries). Without newer
    // data, only the body could tell whether it puts back what a pending local change replaced or replaces typed
    // text (F1/F2): the delivery is not decided then, and its chain's writes are decided on their own (mutation
    // triggers: covered() never covers a salient, undecided delivery's writes)
    if (background)
      this.deliveryAnalysis.set(op, () => {
        if (newer.length || always) return finish(undefined);
        if (done) return;
        done = true;
        if (timer !== null) this.clock.clearTimeout(timer);
        if (op.delivery) op.delivery.salient = true;
      });
    let p: Promise<unknown>;
    try {
      p = o.body();
    } catch {
      p = Promise.resolve(undefined);
    }
    p.then(finish, () => finish(undefined));
  }

  /**
   * Whether a delivery could wait for its decision at all (what trigger() requires before holding): never in observe
   * mode or while paused, nor while the model is not ready, nor when mode and policy permit no non-passive delivery
   * action, nor when the model is not expected to answer within the hold budget.
   */
  private deliveryHoldable(op: OpRec, matched: string[], defers: number, since: number): boolean {
    const mode = this.effectiveMode(op);
    if (mode === "off" || mode === "observe" || this.paused || this.decider?.status.state !== "ready" || this.blockOf(op) || this.hidden()) return false;
    const permitted = (name: string, tier: Tier) => tier !== "passive" && restriction(this.policy, mode, { name, tier }) === null;
    let any = false;
    for (const name of TRIGGER_ACTIONS.delivery) {
      const b = BUILTIN_ACTIONS[name];
      if (!b || !permitted(name, b.tier)) continue;
      // defer is offered only when related work is in flight (and twice at most)
      if (name === "defer" && (defers >= 2 || !relatedInFlight(this.env, op, matched).length)) continue;
      // discard drops writes at the store: never for fields that are all in observed-only stores
      if (name === "discard" && !deliveryDroppable(this.env, matched)) continue;
      any = true;
      break;
    }
    // custom actions: their applicable() needs the situation, so a permitted one counts as possible
    if (!any) any = this.customActions.some((d) => d.on.includes("delivery") && permitted(d.name, d.tier ?? "heal"));
    // the hold budget is a ceiling on the delivery's total added latency, deferred re-decisions included
    const budget = this.holdBudgetMs() - (defers > 0 ? this.clock.now() - since : 0);
    return any && budget > 0 && this.expectedLatency() <= budget;
  }

  /**
   * Whether a request could wait for its decision at all (fetch reads a Request body for its identity only then):
   * never in observe mode or while paused, hidden or the model is not ready, nor for a protected, cross-origin or
   * off/observe-scoped op. Conservative: trigger() may still decide not to hold it.
   */
  private requestHoldable(op: OpRec): boolean {
    if (!this.consultable() || this.hidden() || this.decider?.status.state !== "ready") return false;
    const mode = this.effectiveMode(op);
    return mode !== "off" && mode !== "observe" && !this.blockOf(op);
  }

  /** Whether a write's own decision could still change it (discard while held, late revert once applied). */
  private writesCanAct(mode: Mode): boolean {
    return !this.paused && mode !== "observe" && restriction(this.policy, mode, BUILTIN_ACTIONS.discard) === null;
  }

  /**
   * A write is about to apply: deliveries in its causal chain that were released without a hold and whose content
   * analysis still waits for the body are decided now, without it, so the situation shows the state they were
   * delivered into (not their own writes).
   */
  private finalizeDeliveries(cause: OpRec | null): void {
    let op: OpRec | undefined = cause ?? undefined;
    for (let n = 0; op && n < 16; n++) {
      const cut = this.deliveryAnalysis.get(op);
      if (cut) {
        this.deliveryAnalysis.delete(op);
        try {
          cut();
        } catch (e) {
          this.log("background delivery analysis failed", e);
        }
      }
      op = this.ops.get(op.cause);
    }
  }

  private inChainOf(x: OpRec, writer: number | null): boolean {
    const w = writer === null ? undefined : this.ops.get(writer);
    return !!w && (this.ops.isAncestorOrSelf(x, w) || this.ops.isAncestorOrSelf(w, x));
  }

  /** A successful response to a create (POST, or 201): remember the ids it returned (read-your-writes). */
  private noteResponse(o: { op: OpRec; req: ReqMeta; status: number; body: () => Promise<unknown> }): void {
    if (o.req.method !== "POST" && o.status !== 201) return;
    const t = this.clock.now();
    let p: Promise<unknown>;
    try {
      p = o.body();
    } catch {
      return;
    }
    p.then(
      (b) => {
        const c = createdIds(b);
        if (!c || this.destroyed) return;
        this.createsBuf.push({ op: o.op, t, status: o.status, ids: c.ids, keys: c.keys });
        const now = this.clock.now();
        while (this.createsBuf.length > 16 || (this.createsBuf.length && now - this.createsBuf[0].t > 30_000)) this.createsBuf.shift();
      },
      () => undefined,
    );
  }

  /** A live channel went down / came back: fields its messages wrote may have missed updates meanwhile (F9). */
  private onChannel(state: "down" | "up", channel: "websocket" | "eventsource", path: string, code?: number | string): void {
    const key = `${channel} ${path}`;
    const now = this.clock.now();
    if (state === "down") {
      if (!this.channelsDown.has(key)) this.channelsDown.set(key, { t: now, code: code ?? "closed", channel });
      return;
    }
    const d = this.channelsDown.get(key);
    if (!d) return;
    this.channelsDown.delete(key);
    const sigs = channel === "websocket" ? [`WS message ${path}`] : [...this.lastChainMap.keys()].filter((k) => k.startsWith("SSE ") && k.endsWith(` ${path}`));
    const fields = new Set<string>();
    for (const sig of sigs) for (const f of matchFields(this.env, this.lastChainMap.get(sig) ?? [])) fields.add(f);
    const how = typeof d.code === "number" ? `closed ${d.code}` : d.code === "network" ? "connection error" : String(d.code);
    const why = `by ${channel === "websocket" ? "WebSocket" : "server-sent"} messages on ${path}; the channel then was down for ${secs(now - d.t)} (${how}), so updates sent meanwhile may be missing`;
    for (const f of fields) {
      const st = this.hub.field(f);
      if (st && st.t <= d.t) this.hub.markField(f, { t: st.t, op: st.writer, why });
    }
  }

  /** F9: marks on the fields a write just set when its chain makes the value suspicious. */
  private markWrites(changes: FieldChange[], writer: OpRec): void {
    const now = this.clock.now();
    const chain = [writer, ...this.ops.ancestors(writer, 8)];
    for (const op of chain) {
      let paths = changes.filter((c) => c.afterLeaf !== undefined).map((c) => c.path);
      if (!paths.length) return;
      let why: string | null = null;
      const d = op.delivery?.overNewer;
      if (d) {
        const hit = paths.filter((p) => d.paths.has(p));
        if (hit.length) {
          paths = hit;
          const src = op.kind === "fetch" || op.kind === "xhr" ? `the response to ${opLabel(op)}` : `the message ${opLabel(op)}`;
          why = `by ${src}, which was delivered over ${d.kind === "pending" ? "a pending local change of" : "newer data from"} ${d.by}`;
        }
      }
      if (!why && (op.kind === "fetch" || op.kind === "xhr") && op.end !== undefined && !op.genclass) {
        const lat = this.base.latency(op.name);
        const dur = op.end - op.start;
        if (op.status === "ok" && lat && dur >= 5 * lat.median && dur - lat.median >= 300) why = `by the response to ${opLabel(op)}, which took ${secs(dur)} (${ratio(dur, lat.median)} its usual ${secs(lat.median)})`;
        else if (op.status === "error") {
          const f = failureOf(op);
          const c = f ? commitAmbiguity(op.method ?? op.name.split(" ")[0], f, lat) : null;
          if (f && c?.ambiguous) why = `after ${opLabel(op)} failed (${f.kind === "http" ? `HTTP ${f.status}` : f.kind === "timeout" ? "timed out" : "network error"} after ${secs(f.durMs)}), although the server may have applied it`;
        }
      }
      if (why) {
        for (const p of paths) this.hub.markField(p, { t: now, op: op.id, why });
        return;
      }
    }
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

  /**
   * Since x started, a user action or a newer operation (outside x's chain) wrote this field. GenClass's own writes
   * (a late revert, a rollback, an undo) are not newer data: counting them made one revert drop every later write of
   * x's chain to the field for the whole mark.
   */
  private writtenOver(x: OpRec, path: string): boolean {
    for (const e of this.hub.logSince(path, x.startSeq)) {
      if (e.writer === null) continue;
      const w = this.ops.get(e.writer);
      if (!w || w.genclass || this.ops.isAncestorOrSelf(x, w) || this.ops.isAncestorOrSelf(w, x)) continue;
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
  private waitOps(ops: OpRec[], maxMs: number = LONG_RUNNING_MS): Promise<void> {
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
      const timer = this.clock.setTimeout(finish, Math.min(maxMs, LONG_RUNNING_MS));
    });
  }

  /** A deferred write waits for its related in-flight ops, at most what is left of its hold budget (10 s at most). */
  private waitRelated(m: MutationRec): Promise<void> {
    const left = m.heldSince !== undefined ? Math.max(0, this.holdBudgetMs() - (this.clock.now() - m.heldSince)) : LONG_RUNNING_MS;
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
      const timer = this.clock.setTimeout(finish, Math.min(left, LONG_RUNNING_MS));
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
    if (writer && !writer.genclass) {
      try {
        this.markWrites(changes, writer);
      } catch (e) {
        this.log("marking writes failed", e);
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
    // stores written by typing within the last second (a typing burst): relations on them are neither checked nor
    // learned now; another settled point follows once the burst is over
    const typing = new Set<string>();
    let lastUserWrite = -Infinity;
    for (const r of this.hub.recent) {
      if (!r.user || now - r.t > TYPING_BURST_SETTLE_MS) continue;
      const root = this.ops.get(r.root);
      if ((root?.meta as { action?: UserAction } | undefined)?.action?.kind !== "type") continue;
      typing.add(r.store);
      lastUserWrite = Math.max(lastUserWrite, r.t);
    }
    if (typing.size) {
      if (this.settleTimer !== null) this.clock.clearTimeout(this.settleTimer);
      this.settleTimer = this.clock.setTimeout(() => {
        this.settleTimer = null;
        this.settled();
      }, Math.max(1, lastUserWrite + TYPING_BURST_SETTLE_MS + 1 - now));
    }
    // invariants
    const leaves = this.hub.allLeaves();
    const res = this.miner.observe(leaves, now, typing);
    const ids = new Set(res.violations.map((v) => v.id));
    for (const id of this.episode) if (res.skipped.has(id)) ids.add(id); // an episode lasts through a skipped check
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
      const shape = shapeOf(this.withoutBusy(op.chain), op.chainWrites ?? 0, this.statusClass(op), op.end - op.start);
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

  /** A chain's write set without busy scalar counters that are not explicitly derived (sum/len relations keep theirs). */
  private withoutBusy(chain: OpRec["chain"]): OpRec["chain"] {
    if (!chain) return chain;
    let out: OpRec["chain"] | undefined;
    for (const k of chain.keys()) {
      if (k.includes(":") || !this.miner.busyCounter(k)) continue;
      out ??= new Map(chain);
      out.delete(k);
    }
    return out ?? chain;
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
    // without a latency baseline (fewer than 5 completions) a request is checked once it has been in flight 10 s
    const at = lat ? Math.max(4 * lat.median, 2 * lat.p95, STALL_MIN_MS) : NO_BASELINE_STALL_MS;
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
      // read-only (situation building never changes runtime state): pruning happens when errors are recorded
      recentErrors: () => {
        const now = this.clock.now();
        return this.errorsRecent.filter((e) => now - e.t <= 10_000);
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
      observedOnly: (store) => this.hub.get(store)?.kind === "observed",
      creates: () => this.createsBuf,
      cadence: (sig, now) => this.cadence.get(sig, now),
      outcomes: () => this.outcomesBuf,
      online: () => {
        const n = this.global.navigator as { onLine?: unknown } | undefined;
        return typeof n?.onLine === "boolean" ? n.onLine : undefined;
      },
      idempotencyHeaders: () => this.policy.idempotencyHeaders,
      idempotencyBodyFields: () => this.policy.idempotencyBodyFields,
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
    const base: ModelStatus = this.decider ? this.decider.status : { state: "off" };
    const out: ModelStatus = {
      ...base,
      aggressiveness: this._aggr,
      effectiveMode: this.effectiveMode(),
      sampled: this.sampled,
      breaker: this.breakerImpl?.tripped ? { tripped: true, at: this.breakerImpl.tripped.at, reason: this.breakerImpl.tripped.reason } : { tripped: false },
      // what is in force on the current route: the effective mode and aggressiveness (route rules can only lower
      // them), plus the matching routes[] rule and its cap. routeScope.mode alone is a ceiling ("heal" without a
      // rule), which read as if the page ran in heal mode.
      scope: {
        ...(this.routeScope.route ? { route: this.routeScope.route } : {}),
        mode: this.effectiveMode(),
        aggressiveness: this.effectiveAggr(),
        ...(this.routeScope.rule !== undefined ? { rule: this.routeScope.rule, ceiling: this.routeScope.mode } : {}),
      },
      modelBudget: this.queue.budget(),
    };
    if (this.enabledState === "disabled" || this.enabledState === "off") {
      out.state = "disabled";
      out.reason = this.enabledState === "off" ? "enabled is false" : "disabled";
    }
    return out;
  }

  /** The gate thresholds in force for a trigger kind: policy overrides, else the model's meta gate, else defaults. */
  gates(trigger?: TriggerKind): EffectiveGates {
    return { ...this.gatesAt(trigger, this.effectiveAggr()), mode: this.effectiveMode() };
  }

  private gatesAt(trigger: TriggerKind | undefined, level: number): EffectiveGates {
    return effectiveGates(this.policy, parseGate(this.decider?.status.gate), trigger, level);
  }

  /** Gate steps 1–3 for a subject op: protected, cross-origin, or created under an off/observe route scope. */
  private blockOf(op: OpRec | null | undefined): "protected" | "cross-origin" | "scope" | null {
    const sc = op?.scope;
    if (!sc) return null;
    if (sc.protected) return "protected";
    if (sc.crossOrigin) return "cross-origin";
    if (sc.mode === "off" || sc.mode === "observe") return "scope";
    return null;
  }

  private onLimit(kind: "perMinute" | "perSubject" | "perSession", subject: string): void {
    this.fire("limit", { kind, subject });
    const now = this.clock.now();
    if (now - (this.limitWarned.get(kind) ?? -Infinity) < 60_000) return;
    this.limitWarned.set(kind, now);
    this.warn(`action limit reached (${kind}); running passive actions until it clears.`);
  }

  private warned = new Set<string>();
  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(msg);
  }

  private _aggr = 0.5;

  get aggressiveness(): number {
    return this._aggr;
  }

  setAggressiveness(a: Aggressiveness): void {
    const from = this._aggr;
    this._aggr = aggressivenessLevel(a);
    this.auditControl("setAggressiveness", from, this._aggr);
    this.emitReport({ kind: "status", message: `[GenClass] Aggressiveness set to ${this._aggr}.` });
    this.fire("status", this.status);
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
    if (value !== undefined && (a.sensitive || this.redactFn(target, value, "input") !== value)) value = "[redacted]";
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
    while (this.errorsRecent.length > 64 || (this.errorsRecent.length && t - this.errorsRecent[0].t > 10_000)) this.errorsRecent.shift();
    this.events.push(t, "error", e.name, { ...(op ? { op: op.id } : {}), data: { message: `${e.name}: ${truncate(e.message, 120)}`, ...(e.source ? { source: e.source } : {}) } });
    const ctl: Controller = {
      passive: () => undefined,
      run: (action) => {
        if (action === "rollback" && op) return this.revertChain(op, "error");
        throw new Error(`unsupported action ${action}`);
      },
    };
    if (op) this.breakerImpl?.error([op, ...this.ops.ancestors(op, 8)].map((x) => x.name));
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

  /**
   * Telemetry (src/telemetry): what explain() has plus whether the subject waited, and whether automatically
   * discovered state had been recorded (its text then stays out of telemetry: it was not registered by the app). Internal.
   */
  decisionInfo(id: string): { situationText: string; held: boolean; budget: number; compact: boolean; gates: EffectiveGates; autoState: boolean } | null {
    const r = this.explainMap.get(id);
    return r ? { situationText: r.situationText, held: r.held, budget: r.budget, compact: r.compact, gates: r.gates, autoState: r.autoState } : null;
  }

  /** Some automatically discovered store has recorded a write. */
  private discoveredWrites(): boolean {
    if (!this.discovered) return false;
    for (const s of this.hub.stores.values()) if (s.source && s.version > 0) return true;
    return false;
  }

  /** Run fn first when the runtime is destroyed (telemetry's final flush). Internal. */
  addTeardown(fn: () => void): void {
    this.teardowns.push(fn);
  }

  private tapFailOpen(reason: string, trigger: TriggerKind): void {
    try {
      this.tap?.failOpen?.(reason, trigger);
    } catch {
      /* telemetry never breaks the runtime */
    }
  }

  explain(id: string): Explanation | null {
    const r = this.explainMap.get(id);
    if (!r) return null;
    const d = r.decision;
    const detected = d.diagnosis !== "expected" && d.diagnosisConfidence >= r.gates.report;
    const message = r.action ? interventionLine(d, r.action) : detected ? detectionLine(d) : decisionLine(d);
    const e: Explanation = { message, decision: d, situationText: r.situationText, facts: r.facts, timeline: r.timeline, answers: r.answers, gates: r.gates };
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

  audit(n?: number): AuditEntry[] {
    return this.auditLog.list(n);
  }

  inflight(): Op[] {
    return [...this.ops.inFlight];
  }

  setMode(mode: Mode): void {
    if (mode !== "observe" && mode !== "guard" && mode !== "heal") return;
    const from = this._mode;
    this._mode = mode;
    this.computeScope();
    this.auditControl("setMode", from, mode);
    this.emitReport({ kind: "status", message: `[GenClass] Mode set to ${mode}.` });
    this.fire("status", this.status);
  }

  pause(): void {
    if (!this.paused && !this.destroyed) this.auditControl("pause");
    this.paused = true;
    this.hub.gating = false;
  }

  resume(): void {
    if (this.destroyed) return;
    if (this.paused) this.auditControl("resume");
    this.paused = false;
    this.hub.gating = true;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const t of this.teardowns.splice(0)) {
      try {
        t();
      } catch {
        /* ignore */
      }
    }
    this.destroyed = true;
    this.hub.gating = false;
    this.queue.dispose();
    this.deliveryAnalysis.clear();
    this.reporter.dispose();
    this.auditLog.drain(); // entries recorded so far reach the audit sink (rt.audit() keeps working after destroy)
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
      const st = this.storage(this.learnStore ?? "local");
      const raw = st?.getItem(this.learnKey) ?? (this.learnStore === "local" && this.learnKey === "genclass:learn" ? st?.getItem(PROFILE_KEY) : null);
      if (!raw) return;
      const v = JSON.parse(raw) as { version?: string; profiles?: unknown } | unknown;
      if (v && typeof v === "object" && "profiles" in (v as object)) {
        const w = v as { version?: string; profiles: unknown };
        // a release/version change discards what was learned under the old one
        if (w.version !== this.learnVersion) {
          st?.removeItem(this.learnKey);
          return;
        }
        this.profiles.load(w.profiles as never);
      } else if (this.learnVersion === undefined) this.profiles.load(v as never);
    } catch {
      /* ignore */
    }
  }

  private saveProfilesSoon(): void {
    if (this.persistTimer !== null) return;
    this.persistTimer = this.clock.setTimeout(() => {
      this.persistTimer = null;
      try {
        this.storage(this.learnStore ?? "local")?.setItem(this.learnKey, JSON.stringify({ version: this.learnVersion, profiles: this.profiles.toJSON() }));
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
