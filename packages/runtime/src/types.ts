// Public and shared types of @genclass/runtime. CORE owns this file; the model-facing section is the seam
// between the runtime (CORE) and the model host (MODEL, src/model/**). Change that section only together.

// ----------------------------------------------------------------------------------------------- model seam

/** Jev wire state: an object of named text segments (strings, string arrays, or nested JSON-able values). */
export type JevState = Record<string, unknown>;

export type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface NoulAnswer {
  type: "noul";
  /** Calibrated P(true). */
  noul: number;
}
export interface ChoiceAnswer<L extends string = string> {
  type: "choice";
  choice: L;
  /** (k * max p - 1) / (k - 1): 0 for a uniform distribution, 1 for a certain one. */
  confidence: number;
  /** Calibrated probability per label, in criteria order. */
  probabilities: Record<L, number>;
}
export interface ScoreAnswer {
  type: "score";
  /** Expected level (sum of i * p_i). */
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type AnswerOf<Q extends Question> = Q extends { type: "noul" }
  ? NoulAnswer
  : Q extends { type: "choice"; criteria: infer C }
    ? ChoiceAnswer<Extract<keyof C, string>>
    : Q extends { type: "score" }
      ? ScoreAnswer
      : never;

export type TriggerKind =
  | "mutation"
  | "request"
  | "delivery"
  | "failure"
  | "stall"
  | "inconsistency"
  | "transition"
  | "error"
  | "ask";

export interface ModelStatus {
  state: "off" | "loading" | "ready" | "error" | "skipped" | "unloaded" | "disabled";
  /** skipped / unloaded / disabled: why. */
  reason?: string;
  /** runtime.status only: the effective mode (requested mode demoted by sample, breaker, route). */
  effectiveMode?: ModeOrOff;
  /** runtime.status only: this session may act (false when sampled out). */
  sampled?: boolean;
  breaker?: { tripped: boolean; at?: number; reason?: string };
  /**
   * runtime.status only: what is in force on the current route. `mode` is the effective mode there (the same as
   * effectiveMode: the requested mode, demoted by sampling, the breaker and the matching `routes[]` rule) and
   * `aggressiveness` the effective level (min of the global and the rule's). With a matching rule: `rule` (its
   * index in `routes`) and `ceiling` (the mode that rule caps the route at; rules only ever lower the mode).
   */
  scope?: { route?: string; mode: ModeOrOff; aggressiveness: number; rule?: number; ceiling?: ModeOrOff };
  modelBudget?: { decisionsLastMinute: number; dropped: number };
  /** Download progress while loading (bytes). */
  progress?: { loaded: number; total: number };
  device?: "webgpu" | "wasm";
  variant?: string;
  /** Model card name. */
  model?: string;
  loadMs?: number;
  error?: string;
  /** What the load is doing now (model host). */
  phase?: "card" | "download" | "runtime" | "session" | "warmup";
  /** Model card version. */
  version?: string;
  /** Size of the loaded variant file. */
  bytes?: number;
  /**
   * The loaded variant's sha256 as listed in the model card (model.json), which the download (or the Cache Storage
   * entry) was verified against; absent when the card lists none. Recorded in every audit entry (rt.audit()).
   */
  sha256?: string;
  /** The variant came from Cache Storage (no download). */
  fromCache?: boolean;
  /** WASM threads (1 unless the page is crossOriginIsolated). */
  threads?: number;
  /** Duration of the warm-up forward pass. */
  warmupMs?: number;
  /** Inference runs in a Worker (false: inline on the main thread). */
  worker?: boolean;
  /** Why the Worker was not used (inline fallback). */
  workerError?: string;
  /**
   * state "error" only: the browser blocked a model or onnxruntime-web download (a Content-Security-Policy, else
   * probably one: see src/model/blocked.ts). The runtime then prints one warning naming the origin and the fix.
   */
  blocked?: { url: string; origin: string; csp: boolean; directive?: string };
  /** What the WebGPU probe found. */
  gpu?: string;
  /** Plans that failed before the one that loaded (or all of them, on error). */
  attempts?: { variant: string; device: string; error: string }[];
  /** onnxruntime-web version. */
  ort?: string;
  /** Data-derived gate thresholds shipped with the model (meta.json `gate`), validated. */
  gate?: ModelGate;
  /** runtime.status only: the aggressiveness level in force (0 cautious … 1 eager). */
  aggressiveness?: number;
}

/** Thresholds of one tier: a default and optional per-trigger values. */
export interface GateTier {
  default?: number;
  byTrigger?: Partial<Record<TriggerKind, number>>;
}

/**
 * The model's own gate (meta.json `gate`). `kind: "mass"` (default): guard/heal are probability thresholds for the
 * summed probability of the permitted actions. `kind: "gain"`: guard/heal are margins in cost units for the best
 * action's estimated gain over the passive action, ĝ(a) = tauGain · ln(p(a) / p(passive)).
 */
export interface ModelGate {
  kind?: GateKind;
  /** Per-aggressiveness gates; when present they replace the top-level values (see InitOptions.aggressiveness). */
  profiles?: GateProfiles;
  /** gain kind: τ, the scale from log-probability ratios to cost units (default 1). */
  tauGain?: number;
  report?: number;
  guard?: GateTier;
  heal?: GateTier;
}

export type GateKind = "mass" | "gain";

/** How eagerly GenClass acts: a named level or a number in [0, 1] (0 cautious, 0.5 balanced, 1 eager). */
export type Aggressiveness = "cautious" | "balanced" | "eager" | number;

/** meta.json `gate.profiles`: one gate per named level (each mass or gain kind, report included). */
export interface GateProfiles {
  cautious?: ModelGate;
  balanced?: ModelGate;
  eager?: ModelGate;
}

/** Where an effective threshold comes from: the app's policy.thresholds, the model's meta gate, or the defaults. */
export type GateSource = "policy" | "model" | "default";

/**
 * The thresholds the §8 gate uses (for one trigger kind, or the defaults when none is given). `kind` "mass": guard/heal
 * are probability thresholds; "gain": margins in cost units (and `tauGain`). `report` is always a probability.
 */
export interface EffectiveGates {
  kind: GateKind;
  /** runtime.gates() only: the effective mode on the current route (observe/off: no gate here leads to an action). */
  mode?: ModeOrOff;
  /** The aggressiveness level in force (0 cautious … 1 eager) and its name when it is one of the three. */
  aggressiveness: number;
  level?: "cautious" | "balanced" | "eager";
  /** "profiles": the model's per-level gates; "scaled": its single gate (or the defaults) shifted by the level. */
  levelSource: "profiles" | "scaled";
  /** gain kind only. */
  tauGain?: number;
  trigger?: TriggerKind;
  report: number;
  guard: number;
  heal: number;
  source: { report: GateSource; guard: GateSource; heal: GateSource };
}

/**
 * Structured reference to what is being decided. For non-model providers (tests, the sim); never serialized into
 * `state`, and the model host ignores it.
 */
export interface SubjectRef {
  kind: TriggerKind;
  /**
   * request / failure / stall / transition / delivery: the subject op (delivery: the fetch op or the WebSocket /
   * EventSource message op); error: the ambient op when it was thrown.
   */
  op?: number;
  /** mutation: the held mutation id. */
  mutation?: number;
  /** mutation / inconsistency / transition: the store concerned (first one when several). */
  store?: string;
  /** Fields involved. */
  paths?: string[];
  /** mutation: the op that caused the write. */
  cause?: number;
  /** error: the raw error object (identity preserved). */
  error?: unknown;
  /** inconsistency: the violated relation, as text. */
  invariant?: string;
}

export interface EvaluateRequest {
  trigger: TriggerKind;
  state: JevState;
  questions: Record<string, Question>;
  /** Higher runs first when several requests are queued (held writes/requests use 2, background 0). */
  priority?: number;
  /** What is being decided (tests/sim). Never part of the model input. */
  subject?: SubjectRef;
  /**
   * Built-in actions of this trigger that are not offered here, with the reason (= `Situation.notOffered`; tests/sim).
   * Never part of the model input; the model host ignores it.
   */
  notOffered?: Record<string, string>;
  /** Drop the request if it cannot be answered within this many ms (queued requests are not computed). */
  timeoutMs?: number;
}

/** The seam between the runtime and whatever answers its questions: the local model, a test double, the sim. */
export interface DecisionProvider {
  readonly status: ModelStatus;
  /** Resolves when evaluate() can be called; rejects if the model cannot load. */
  ready(): Promise<void>;
  evaluate(req: EvaluateRequest): Promise<Record<string, Answer>>;
  onStatus?(fn: (s: ModelStatus) => void): () => void;
  dispose?(): void;
}

// ------------------------------------------------------------------------------------------- clock (§3)

/** All time and scheduling used by the runtime. The sim injects a virtual clock; browsers use `browserClock`. */
export interface Clock {
  /** Milliseconds, monotonic. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  /** Run fn after the current macrotask's microtasks drain. */
  afterTask(fn: () => void): void;
}

// --------------------------------------------------------------------------------------- trace (§3)

export type EventKind =
  | "user"
  | "op.start"
  | "op.end"
  | "state"
  | "error"
  | "nav"
  | "perf"
  | "storage"
  | "custom"
  | "decision"
  | "action";

export interface RtEvent {
  seq: number;
  t: number;
  kind: EventKind;
  name: string;
  /** The op this event belongs to (op.start/op.end: the op; state: the writing op; user: the user op). */
  op?: number;
  /** The causal parent op. */
  cause?: number;
  data?: Record<string, unknown>;
}

export type OpKind = "user" | "fetch" | "xhr" | "ws" | "task" | "timer" | "genclass";
export type OpStatus = "ok" | "error" | "aborted" | "blocked";

export interface Op {
  id: number;
  kind: OpKind;
  /** Signature with ids normalised, e.g. "GET /api/items/:id", 'click button "Add"'. */
  name: string;
  /** e.g. "?q=rea" or a body summary. */
  detail?: string;
  start: number;
  end?: number;
  status?: OpStatus;
  /** HTTP status, or an error name such as "TypeError" / "timeout". */
  code?: number | string;
  /** Parent op (the ambient op when this one started). */
  cause?: number;
  /** Root op of the causal chain (itself when it has no cause). */
  root?: number;
  attempt: number;
  /** store.path -> field version when this op started. Filled lazily for the fields the runtime looks at. */
  reads: Map<string, number>;
  /** Hash of method + url + body for requests. */
  identity?: string;
  meta?: Record<string, unknown>;
}

/** A user action, recorded as an instantaneous op. The DOM observer and the sim use the same entry point. */
export interface UserAction {
  kind: "click" | "type" | "change" | "submit" | "key" | "nav" | (string & {});
  /** Element description, e.g. 'button "Place order"', 'input "Search"'. */
  target?: string;
  /** Typed/selected value (already redacted by the caller when sensitive). */
  value?: string;
  key?: string;
  /** True when the value is sensitive (password field): it is never recorded. */
  sensitive?: boolean;
  /** Clicks: the browser's click count (MouseEvent.detail; 2 for the second click of a double click). */
  clicks?: number;
  data?: Record<string, unknown>;
}

// --------------------------------------------------------------------------------------- state (§4)

export interface StoreOptions<T> {
  /** App capability: reload this store from its source. Enables the `resync` action for the store. */
  resync?: () => Promise<unknown> | unknown;
  /** Default true. false: writes to this store are never held (still traced). */
  hold?: boolean;
  /** Custom one-line description of the value for situations. */
  describe?: (v: T) => string;
}

export interface Atom<T> {
  readonly name: string;
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  update(fn: (prev: T) => T): void;
  subscribe(fn: (v: T) => void): () => void;
}

/** A store the app owns (any get/set/subscribe source) whose writes go through the GenClass pipeline. */
export type Guarded<T> = Atom<T>;

export interface StoreIO<T> {
  get(): T;
  set(v: T): void;
  subscribe?(fn: () => void): () => void;
}

/** A store owned by a state library (redux, zustand): GenClass reads it and the adapter commits writes. */
export interface AdapterIO<T> {
  get(): T;
  /** Optional: lets GenClass write the store directly (rollback). Without it, rollback skips this store. */
  set?(v: T): void;
  /** Changes made outside `propose` are recorded (never held). */
  subscribe?(fn: () => void): () => void;
}

export interface AdapterHandle<T> {
  readonly name: string;
  /**
   * Propose a write: `fn` (or `value`) previews the next state; `commit` performs it on the library store
   * (called synchronously when the write is not held, later when it is, never when it is discarded).
   */
  propose(w: { fn?: (prev: T) => T; value?: T; commit: (next: T) => void }): void;
  dispose(): void;
}

export interface Change {
  path: string;
  before: unknown;
  after: unknown;
}

// ------------------------------------------------------------------------------------- options (§2, §8)

export type Mode = "observe" | "guard" | "heal";
export type Tier = "passive" | "guard" | "heal";
export type ObserverName = "fetch" | "xhr" | "user" | "errors" | "nav" | "storage" | "perf" | "websocket" | "eventsource" | "timers";

export interface PolicyOptions {
  /**
   * Overrides of the gate thresholds, in the active gate kind: with the default "mass" gate guard/heal are
   * probabilities (defaults 0.9 / 0.8); when the model ships a "gain" gate they are margins in cost units (defaults
   * 2 / 2). `report` is always a probability (default 0.6). Unset values use the model's own gate (meta.json `gate`,
   * per trigger kind then its default), else the defaults.
   */
  thresholds?: { report?: number; guard?: number; heal?: number };
  /** Action names. When set, only these non-passive actions may run. */
  allow?: string[];
  deny?: string[];
  /**
   * Max time a write/request waits for the model. Default "auto": clamp(1.5 × median of the last 20 model
   * latencies (the model's warm-up time before any), 150, 800) ms.
   */
  holdBudgetMs?: number | "auto";
  /** Default false. */
  holdUserWrites?: boolean;
  /**
   * Request headers that make a non-idempotent request (POST, PATCH, ...) safe to repeat, so that `retry` may be
   * offered for it (case-insensitive). Default ["Idempotency-Key", "X-Idempotency-Key"]. Request-id or tracing
   * headers are not idempotency keys.
   */
  idempotencyHeaders?: string[];
  /**
   * Opt-in (default none): top-level JSON body fields that carry an idempotency key the server deduplicates on (for
   * example ["request_id"] when a repeated POST with the same request_id is answered from the first one). A
   * non-idempotent request whose JSON object body has one of them may be repeated, so `retry` may be offered.
   * Only name fields the server really deduplicates on: a retry of a request that already committed is otherwise a
   * duplicate.
   */
  idempotencyBodyFields?: string[];
  /**
   * Default false: store writes are never held (decisions about responses and messages are taken at the network
   * boundary; salient writes not covered by such a decision are decided in the background and may be reverted
   * under the late-revert rules). true (opt-in): salient writes wait for the model, without ever reordering a
   * store's writes, and reads inside the writing chain see the pending value.
   */
  holdWrites?: boolean;
  /** Default 60 non-passive actions per minute; beyond it the passive action runs and a warning is emitted. */
  /** @deprecated use actionLimits.perMinute */
  maxActionsPerMinute?: number;
  /** Default { perMinute: 60, perSubject: 10, perSession: 200 }. */
  actionLimits?: ActionLimits;
  /**
   * Default true: a non-passive action also requires the model's top diagnosis to be something other than
   * `expected`. The sim passes false to force actions on benign situations when measuring counterfactuals.
   */
  requireDiagnosis?: boolean;
}

/** Overrides of the wording the model sees. */
export interface Vocabulary {
  /** Replaces the diagnosis vocabulary (label -> description). Plugin labels are still added. */
  diagnoses?: Record<string, string>;
  /** Replaces descriptions of built-in actions (name -> description). */
  actions?: Partial<Record<string, string>>;
}

/** Synchronous creation hooks (advanced: tests and the sim). */
export interface RuntimeHooks {
  /** Called synchronously when an op is created (inside the instrumented fetch call, before any await). */
  opCreated?(op: Op): void;
  /** Called synchronously inside atom.set / guarded set / adapter writes, before gating. */
  mutationProposed?(m: { id: number; store: string; paths: string[]; cause?: number; changes: Change[] }): void;
}

export interface ModelOptions {
  baseUrl?: string;
  device?: "auto" | "webgpu" | "wasm";
  worker?: boolean;
  preload?: "eager" | "idle" | "lazy";
  ortWasmPaths?: string;
  cacheName?: string;
  /**
   * Whether to load the model on this device. Default `{ saveData: "lazy" }` (Save-Data connections load lazily).
   * false / "skip" → no download (status.state "skipped"); "lazy" → preload "lazy". Unknown values count as allowed.
   */
  loadIf?: { minDeviceMemoryGB?: number; saveData?: "skip" | "lazy" | "ignore" } | ((env: DeviceEnv) => boolean | "lazy");
  /** Run inference on the main thread when the worker cannot start (default true). */
  inlineFallback?: boolean;
  /** WASM threads (default "auto" = min(4, max(1, cores - 1))). */
  threads?: number | "auto";
  /** Per-evaluation timeout in ms (default 10,000). */
  timeoutMs?: number;
  /** Model evaluations per sliding minute (default 30; Infinity disables). Over it, decisions fail open. */
  maxDecisionsPerMinute?: number;
  /** Tear the model down after this long without an evaluation (default false); it reloads from cache on demand. */
  unloadAfterIdleMs?: number | false;
}

export interface DeviceEnv {
  deviceMemoryGB?: number;
  /** navigator.userAgentData.mobile (Chromium browsers; undefined elsewhere, e.g. Safari). */
  mobile?: boolean;
  saveData?: boolean;
  effectiveType?: string;
  cores?: number;
  webgpu: boolean;
}

export type ModeOrOff = Mode | "off";

/** URL prefix or glob ("https://api.x/v1/orders*" or "/v1/orders*", which also matches the path), RegExp, or predicate. */
export type RequestMatcher = string | RegExp | ((r: { url: string; method: string; channel: "fetch" | "xhr" | "ws" | "sse" }) => boolean);

export interface RouteRule {
  /** Exact path or glob ("/admin/*"), RegExp, or predicate over the route. */
  match: string | RegExp | ((route: string) => boolean);
  /** Demote only. */
  mode?: ModeOrOff;
  /** Demote only. */
  aggressiveness?: Aggressiveness;
}

export interface RequestScope {
  /** Pass-through: not observed at all (no op, no hold). */
  ignore?: RequestMatcher[];
  /**
   * Observed and reported, but never held, delayed, retried, replayed, hedged, coalesced, served from cache or
   * discarded; neither are the state writes its response callbacks make (the request's causal chain). Recommended for
   * payment, checkout and sign-in endpoints. A string "preset:payments" or "preset:auth" stands for that preset's
   * matchers (`protectPreset()`, `PROTECT_PRESETS`), for JSON configs.
   */
  protect?: Array<RequestMatcher | `preset:${string}`>;
  /** Cross-origin requests are always passive; "ignore" also stops observing them. Default "observe". */
  crossOrigin?: "observe" | "ignore";
  /** Names for endpoints in reports and sinks ([A-Za-z0-9 _-], ≤ 5 words, ≤ 40 chars). */
  labels?: Array<{ match: RequestMatcher; label: string }>;
  /** Show labels to the model (default false). */
  labelsToModel?: boolean;
  /** Your trace id for a request, stamped on reports and sink records; never shown to the model. */
  correlate?: (r: { url: string; method: string; headers: Record<string, string> }) => string | undefined;
}

export interface EnabledSource {
  get(): boolean;
  subscribe(cb: (on: boolean) => void): () => void;
}

export interface BreakerOptions {
  /** Undos within windowMs that trip it (default 2). */
  undos?: number;
  /** Errors on an acted-on subject within attributionMs after the action (default 3). */
  errorsAfterAction?: number;
  attributionMs?: number;
  windowMs?: number;
  downgradeTo?: "observe" | "guard";
  persist?: "session" | false;
}

export interface ActionLimits {
  /** Max non-passive actions across the session within any 60 s (default 60). */
  perMinute?: number;
  /** Max non-passive actions on the same subject (store field / endpoint signature) within any 60 s (default 10). */
  perSubject?: number;
  /** Absolute cap on non-passive actions per session (default 200). */
  perSession?: number;
}

export interface ActionRequest {
  action: string;
  tier: "guard" | "heal";
  trigger: TriggerKind;
  subject: string;
  diagnosis: string;
  p: number;
  decisionId: string;
  route?: string;
  label?: string;
}

export type SinkKind = "detection" | "intervention" | "undo" | "breaker" | "summary" | "error";

export interface SinkRecord {
  schema: 1;
  kind: SinkKind;
  id: string;
  ts: number;
  sessionId: string;
  tags: Record<string, string | number | boolean>;
  correlationId?: string;
  mode: ModeOrOff;
  sampled: boolean;
  diagnosis?: string;
  p?: number;
  action?: string;
  tier?: Tier;
  trigger?: TriggerKind;
  label?: string;
  changed?: string[];
  undone?: boolean;
  shadow?: { action: string; tier: Tier; wouldPass: boolean; reason?: string };
  reason?: string;
  summary?: SessionSummary;
  evidence?: { message?: string; trigger?: TriggerKind; subject?: string; timeline?: string[] };
}

export type SinkFn = (r: SinkRecord) => void | Promise<void>;
export interface SinkObject {
  send: SinkFn;
  kinds?: SinkKind[];
  /** Session-deterministic; never drops intervention / undo / breaker. */
  sampleRate?: number;
  /** Add redacted evidence (message, trigger, subject, timeline). Default false. */
  evidence?: boolean;
  flush?(): Promise<void>;
}
export type Sink = SinkFn | SinkObject;

export interface SessionSummary {
  startedAt: number;
  durationMs: number;
  detections: Record<string, number>;
  interventions: Record<string, number>;
  undos: number;
  lateReverts: number;
  denied: Record<string, number>;
  shadow: Record<string, number>;
  model: { state: ModelStatus["state"]; p50Ms?: number; p95Ms?: number; decisions: number; dropped: number; hiddenSkipped: number };
  heldMs: { total: number; max: number };
  errors: number;
}

/** What an audit entry records (rt.audit()). */
export type AuditKind = "decision" | "action" | "undo" | "breaker" | "control";

/** The model an audit entry was decided with (from rt.status at the time). */
export interface AuditModel {
  /** Model card name, else the provider's variant or "custom"; "none" without a provider. */
  name: string;
  state: ModelStatus["state"];
  version?: string;
  variant?: string;
  device?: "webgpu" | "wasm";
  /** The sha256 the loaded variant was verified against (model.json), when the card lists one. */
  sha256?: string;
}

/** The gate values a decision was compared with (OPTIONS-SPEC §0.4; decide/policy.ts -> gate). */
export interface AuditGate {
  kind: GateKind;
  /** The report threshold and the tier thresholds (mass) or margins (gain) in force for this trigger. */
  thresholds: { report: number; guard: number; heal: number };
  /** Where each came from: the app's policy, the model's meta gate, or the defaults. */
  source: { report: GateSource; guard: GateSource; heal: GateSource };
  /** The most probable action the mode and policy permitted. */
  candidate?: string;
  /** Summed probability of the permitted actions (mass kind). */
  mass?: number;
  /** The threshold the candidate's tier needed (mass kind). */
  threshold?: number;
  /** gain kind: ĝ of the candidate and the margin it needed. */
  gain?: number;
  margin?: number;
}

/**
 * One entry of the audit trail (rt.audit(), InitOptions.audit.sink). JSON-serialisable (no functions), built from
 * values the runtime already has; it never feeds a decision, never changes what the model reads and is never sent
 * anywhere by GenClass. URL query and fragment values in `subject`, `changed` and `error` are replaced with "…".
 */
export interface AuditEntry {
  schema: 1;
  /** 1, 2, 3, … per runtime, without gaps (the in-memory buffer drops the oldest entries first). */
  seq: number;
  /** Runtime clock time (ms). */
  at: number;
  kind: AuditKind;
  sessionId: string;
  /** The effective mode for the subject (decision, action, undo) or for the session (breaker, control). */
  mode: ModeOrOff;
  /** The mode the app asked for (rt.mode). */
  requestedMode: Mode;
  /** The aggressiveness level in force (0 cautious … 1 eager) and its name when it is a named profile. */
  aggressiveness: number;
  profile?: "cautious" | "balanced" | "eager";
  model: AuditModel;
  decisionId?: string;
  actionId?: string;
  trigger?: TriggerKind;
  subject?: string;
  label?: string;
  correlationId?: string;
  /** decision: the model's diagnosis and its probability, the action it ranked first and its probabilities. */
  diagnosis?: string;
  diagnosisConfidence?: number;
  proposed?: string;
  probabilities?: Record<string, number>;
  /** decision: the action that ran (the passive one unless the gate let `candidate` through); action/undo: the action. */
  ran?: string;
  executed?: boolean;
  tier?: Tier;
  /** Why the passive action ran instead (protected, cross-origin, scope, vetoed, limit:*, threshold, mode, ...). */
  reason?: string;
  gate?: AuditGate;
  /** decision: whether the subject waited for it, the hold budget then, the model's latency. */
  held?: boolean;
  holdBudgetMs?: number;
  latencyMs?: number;
  shadow?: { action: string; tier: Tier; wouldPass: boolean; reason?: string };
  /** action: whether it worked, what it changed, whether it can be undone, late revert, the paths it dropped. */
  ok?: boolean;
  error?: string;
  changed?: string;
  undoable?: boolean;
  late?: boolean;
  dropped?: string[];
  /** undo: true when rt.disable({ undo: true }) rolled it back (not counted by the breaker). */
  byRuntime?: boolean;
  breaker?: { tripped: boolean; reason: "undos" | "errors" | "reset"; decisionIds: string[]; counts: { undos: number; errors: number } };
  /** control: what changed (setMode, setAggressiveness, pause, resume, enabled, disable) and from/to. */
  control?: { what: "setMode" | "setAggressiveness" | "pause" | "resume" | "enabled" | "disable"; from?: string | number; to?: string | number };
}

/** InitOptions.audit: the in-memory audit trail and an optional sink for the app's own logging. */
export interface AuditOptions {
  /** Entries kept in memory for rt.audit() (default 1,000, at most 10,000; 0 keeps none, the sink still gets all). */
  size?: number;
  /** Receives every entry, in order, on a microtask after it is recorded (never on a hold path); errors are swallowed. */
  sink?: (e: AuditEntry) => void;
}

/** Where an op was created: its effective mode and aggressiveness, protection, and report-only names. */
export interface OpScope {
  mode: ModeOrOff;
  aggressiveness: number;
  protected: boolean;
  crossOrigin: boolean;
  label?: string;
  /** requests.labelsToModel: the label may appear in situation text. */
  labelToModel?: boolean;
  route?: string;
  correlationId?: string;
}

export interface InitOptions {
  /**
   * Default "observe": reports what GenClass sees and would do, and never holds, delays or changes anything.
   * "guard" (opt-in) takes minimal guard-tier actions at very high confidence; "heal" is experimental.
   */
  mode?: Mode;
  /** false: no model (observe-only). */
  model?: ModelOptions | false;
  /** Bring your own decision provider instead of the local model. */
  decider?: DecisionProvider | null;
  /** Default "console". "interventions": the console prints only actions, undos, breaker trips and errors. */
  report?: "console" | "interventions" | "silent" | ((r: Report) => void);
  /** Default true. A predicate / Promise / subscribable flag; while false nothing is decided or downloaded. */
  enabled?: boolean | (() => boolean | Promise<boolean>) | EnabledSource;
  /** Fraction of sessions allowed to act (default 1); the rest observe. */
  sample?: number;
  /** Per-route mode and aggressiveness (demote only); the first matching rule wins. */
  routes?: RouteRule[];
  requests?: RequestScope;
  /** Automatic downgrade after undos or errors that follow actions (default on). */
  breaker?: BreakerOptions | false;
  /** Record what this higher mode would have done, without doing it (default false). */
  shadow?: "guard" | "heal" | false;
  /** Synchronous last veto before an action runs: return false (or throw) to veto. */
  onBeforeAction?: (a: ActionRequest) => boolean | void;
  /** "report": call the hook and record its verdict but act anyway (default "enforce"). */
  vetoMode?: "enforce" | "report";
  /** Structured, redacted records for your telemetry. */
  sinks?: Sink[];
  /** Session id and tags stamped on records (never shown to the model). */
  session?: { id?: string; tags?: Record<string, string | number | boolean> };
  /**
   * The audit trail (rt.audit()): every decision, action, undo, breaker event and control change, with the mode,
   * profile, gate values and model hash in force. Always on in memory (1,000 entries); `sink` ships entries to your
   * own logging. Never shown to the model and never sent anywhere by GenClass. packages/runtime/INTERCEPTION.md.
   */
  audit?: AuditOptions;
  /**
   * Observers to install (default: all, `timers` only with a document). `untrustedEvents` (default false): record
   * synthetic DOM events (isTrusted false) as user actions too, for in-page test harnesses.
   */
  observe?: Partial<Record<ObserverName | "untrustedEvents", boolean>>;
  /** Default "salient". */
  triage?: "salient" | "always";
  policy?: PolicyOptions;
  /**
   * Default: values whose leaf field names a secret (password, token, secret, cvv, card number, ssn, iban, api key,
   * ...), never a whole store by its name (`auth.loading` stays visible, `auth.token` is redacted).
   */
  redact?: (path: string, value: unknown, kind?: "state" | "url" | "header" | "input") => unknown;
  plugins?: Plugin[];
  /** Events kept, default 500. */
  historySize?: number;
  /** Console logging of every decision. */
  debug?: boolean;
  /**
   * Learned state (transition profiles): persist: true / "local" (localStorage) or "session" (sessionStorage); default
   * false. `key` default "genclass:learn"; `version` (default session.tags.release at init) discards stale state.
   */
  learn?: { persist?: boolean | "local" | "session"; key?: string; version?: string };
  /** Override the diagnosis vocabulary and action descriptions the model sees. */
  vocabulary?: Vocabulary;
  /** Quiet time after the last mutation before a settled point (default 60 ms). */
  settleMs?: number;
  /**
   * How eagerly GenClass fixes client-side errors (default "balanced"). A number in [0, 1] interpolates (0 cautious,
   * 0.5 balanced, 1 eager). Selects the model's gate profile; explicit policy.thresholds still win. The URL parameter
   * `?genclass-aggr=cautious|balanced|eager|<number>` overrides it; `runtime.setAggressiveness()` changes it later.
   */
  aggressiveness?: Aggressiveness;
  /**
   * Size of the situation text the model reads, in characters. Default "auto": by device from the model status
   * (webgpu 2,400; wasm 1,000 at 1 thread to 2,000 at 4 threads, linear; unknown device 2,400).
   */
  situation?: { budget?: number | "auto" };
  /**
   * Anonymous diagnostics sent to the GenClass maintainers to improve the model (packages/runtime/TELEMETRY.md):
   * session info, every decision (trigger, the redacted situation text the model read, its calibrated answers, the
   * gate and what ran), action outcomes, detections, model errors and periodic counts. Never raw input values, cookies,
   * headers or storage. **Default: on with `GenClass.init()` in a browser** (one console notice per page); off in
   * Node/SSR and with `createRuntime()` unless set here. Off with `false`, `?genclass=no-telemetry` (or `off`),
   * `localStorage["genclass.telemetry"] = "off"`, or when the browser sends Global Privacy Control
   * (`navigator.globalPrivacyControl === true`).
   */
  telemetry?: boolean | TelemetryOptions;
  /**
   * Automatic state discovery: find the app's state without registering stores. **Default: on in the zero-code
   * entries** (`@genclass/runtime/auto*`, the script tag); off with `GenClass.init()` / `createRuntime()` unless set
   * here. Must be installed before the framework loads (the one line first). Covers React ≥ 16.8 component state
   * (useState, useReducer, useSyncExternalStore, class state, via the React DevTools hook), Redux / Redux Toolkit stores
   * (via the Redux DevTools compose/enhancer globals: full adapters) and Zustand `devtools` stores (via the Redux
   * DevTools `connect` API). Discovered React and Zustand state is observed only: GenClass sees its writes and their
   * causes (detections, delivery decisions) but never holds, drops or reverts them. `false` or an object turning
   * single sources off (`{ react: false }`). Also `<meta name="genclass" content="autostate=off">`.
   */
  autoState?: boolean | AutoStateOptions;
}

/** InitOptions.autoState as an object: each source defaults to on. */
export interface AutoStateOptions {
  /** React state via the React DevTools hook. Default true. */
  react?: boolean;
  /** Redux / Redux Toolkit stores via the Redux DevTools compose and enhancer globals (full adapter). Default true. */
  redux?: boolean;
  /** Zustand `devtools` stores (and other stores reporting to the Redux DevTools `connect` API). Default true. */
  zustand?: boolean;
  /** Vue 3 + Pinia: not implemented yet (ignored). */
  pinia?: boolean;
}

/** runtime.stores(): one registered or discovered store. */
export interface StoreInfo {
  readonly name: string;
  /** atom, guard, adapter (registered or a discovered Redux store), observed (discovered, observed only). */
  readonly kind: "atom" | "guard" | "adapter" | "observed";
  /** How it was discovered: "react", "redux", "devtools" (a Redux DevTools `connect` client such as Zustand); unset when registered by the app. */
  readonly source?: string;
  /** GenClass can write it (rollback, chain revert); false for observed-only stores. */
  readonly writable: boolean;
  /** Fields (flattened paths) and the number of recorded writes. */
  readonly fields: number;
  readonly version: number;
}

/** InitOptions.telemetry as an object (enables telemetry). */
export interface TelemetryOptions {
  /** Collector URL (default DEFAULT_TELEMETRY_ENDPOINT). */
  endpoint?: string;
  /** Fraction of page sessions that send (0..1, default 1), drawn once per page load. */
  sample?: number;
  /** Batch interval in ms (default 10,000). Batches are also sent on pagehide / when the tab is hidden. */
  flushMs?: number;
  /** Max events per request (default 100; requests are also kept under 60 KB for keepalive/sendBeacon). */
  maxBatch?: number;
  /** situation (default true): include the redacted situation text the model read in decision events. */
  include?: { situation?: boolean };
  /** Advanced (tests, custom pipelines): replaces the network transport. Errors are swallowed. */
  transport?: TelemetryTransport;
}

export interface TelemetryTransport {
  /** `beacon`: the page is going away (pagehide / hidden); prefer navigator.sendBeacon. */
  send(url: string, body: string, o: { beacon: boolean }): void | Promise<unknown>;
}

/** runtime.telemetry: whether this page sends diagnostics, and why not. */
export interface TelemetryStatus {
  readonly enabled: boolean;
  /** Off: "option", "headless", "url", "localStorage", "gpc", "sampled-out", "no-crypto", "no-transport", "kill-switch". */
  readonly reason?: string;
  readonly endpoint?: string;
  /** Random per page load (not persisted). */
  readonly sessionId?: string;
  /** Send what is queued now (resolves when the requests settle; never rejects). */
  flush(): Promise<void>;
}

export interface CreateOptions extends InitOptions {
  /** Default browserClock. */
  clock?: Clock;
  /** The object whose fetch/XMLHttpRequest/addEventListener/... are instrumented. Default globalThis. */
  global?: object;
  /** App title and route for situations. Default: global.document.title and global.location.pathname. */
  app?: () => { title?: string; route?: string };
  /** Synchronous creation hooks (advanced: tests and the sim). */
  hooks?: RuntimeHooks;
}

// ----------------------------------------------------------------------------------------- questions (§2)

export interface AskOptions {
  about?: "now" | number | string;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------------- situations (§5, §6)

export type FactKind =
  | "provenance"
  | "versions"
  | "inputs"
  | "concurrency"
  | "repetition"
  | "outcome"
  | "baseline"
  | "invariant"
  | "transition"
  | "error"
  | "delta"
  | "cache"
  | "request"
  | "plugin";

export interface Fact {
  text: string;
  kind: FactKind;
  /** Neutral facts never make a situation salient (triage). */
  neutral: boolean;
}

/** What the model sees for a trigger. */
export interface Situation {
  trigger: TriggerKind;
  /** One sentence naming the subject. */
  subject: string;
  state: JevState;
  questions: Record<string, Question>;
  /** Applicable actions, passive first. */
  actions: string[];
  /** Built-in actions of this trigger that are not offered here, with the reason (debugging; not sent to the model). */
  notOffered?: Record<string, string>;
  /** Whether triage would consult the model. */
  salient: boolean;
  facts: string[];
  /** Compact questions (budget ≤ 1,400 chars): bare diagnosis labels and action names. */
  compact: boolean;
  /** The situation budget in characters. */
  budget: number;
}

export interface RequestInfo {
  method: string;
  url: string;
  signature: string;
  identity: string;
  idempotent: boolean;
  replayable: boolean;
  /** The request carries one of `policy.idempotencyHeaders` (it may be repeated safely although its method is not idempotent). */
  idempotencyKey?: boolean;
  /** Ops of identical requests in flight. */
  identicalInFlight: number[];
  /** A cached good response exists for this request. */
  cached: boolean;
}

/** The draft situation handed to plugins (facts and applicability). */
export interface SituationDraft {
  trigger: TriggerKind;
  subject: string;
  now: number;
  /** Subject op (request/failure/stall/transition), cause op (mutation), ambient op (error). */
  op?: Op;
  root?: Op;
  /** Stores concerned by the subject. */
  stores: string[];
  mutation?: { id: number; store: string; changes: Change[] };
  request?: RequestInfo;
  /** delivery: the fields the operation is predicted to write (normalised paths) and those with newer data. */
  delivery?: { channel: "response" | "websocket" | "eventsource"; predicted: string[]; conflicts: string[] };
  failure?: { kind: "network" | "timeout" | "http"; status?: number; message?: string };
  error?: { name: string; message: string; source?: string };
  invariants?: { id: string; text: string }[];
  facts: Fact[];
  inFlight: Op[];
}

// -------------------------------------------------------------------------------------- decisions (§8)

export interface Decision {
  /** "d<n>" */
  id: string;
  trigger: TriggerKind;
  subject: string;
  at: number;
  latencyMs: number;
  model: string;
  diagnosis: string;
  diagnosisConfidence: number;
  diagnosisProbabilities: Record<string, number>;
  /** The action the model chose (highest probability). */
  action: string;
  /** probabilities[action]. */
  confidence: number;
  probabilities: Record<string, number>;
  /** True when `action` ran as chosen. */
  executed: boolean;
  /** Why the passive action ran instead (mode, threshold, diagnosis, deny, rate, budget). */
  reason?: string;
  facts: string[];
  /** Tier of `action`. */
  tier: Tier;
  /** The most probable action the mode and policy permit (what GenClass would have done). */
  candidate?: string;
  /** Summed probability of the permitted actions (the gate compares it with the candidate's tier threshold). */
  mass?: number;
  /** The gate kind in force ("mass" or "gain", from the model's meta.json). */
  gateKind?: GateKind;
  /** mass kind: the threshold `mass` was compared with (the candidate's tier, for this trigger kind). */
  threshold?: number;
  /** gain kind: ĝ of the candidate, tauGain · ln(p(candidate) / p(passive)), and the margin it was compared with. */
  gain?: number;
  margin?: number;
  /** Where the threshold or margin came from. */
  thresholdSource?: GateSource;
  /** The effective mode for this decision's subject. */
  effectiveMode?: ModeOrOff;
  /** shadow option: what the shadow mode would have done with the same answer. */
  shadow?: { action: string; tier: Tier; wouldPass: boolean; reason?: string };
  /** The action that actually ran. */
  ran: string;
  /** Every answer the model gave (including plugin standing questions). */
  answers: Record<string, Answer>;
  /** Structured reference to the subject (same as EvaluateRequest.subject). */
  subjectRef?: SubjectRef;
}

export type Detection = Decision;

export interface ActionRecord {
  /** "a<n>" */
  id: string;
  decisionId: string;
  action: string;
  tier: Tier;
  trigger: TriggerKind;
  subject: string;
  at: number;
  ok: boolean;
  error?: string;
  /** Exactly what GenClass altered, in one sentence. */
  changed: string;
  /** Reverses the action when it is reversible (discard: apply the dropped write now; rollback: restore). */
  undo?: () => void;
  /** The subject had already proceeded (hold budget expired): the action reverted it afterwards. */
  late?: boolean;
  /** delivery `discard`: store paths whose writes by the delivered operation's chain were dropped so far. */
  dropped?: string[];
}

export interface Report {
  kind: "detect" | "intervene" | "status" | "undo" | "breaker" | "error";
  message: string;
  decision?: Decision;
  action?: ActionRecord;
  /** Effective mode at the decision. */
  mode?: ModeOrOff;
  correlationId?: string;
  label?: string;
  session?: { id: string; tags: Record<string, string | number | boolean> };
}

export interface Explanation {
  /** The console line for this decision/action (as printed with report: "console"). */
  message: string;
  decision: Decision;
  situationText: string;
  facts: string[];
  timeline: string[];
  answers: Record<string, Answer>;
  action?: ActionRecord;
  changed?: string;
  /** The gate thresholds in force for this decision's trigger when it was decided. */
  gates?: EffectiveGates;
}

// ----------------------------------------------------------------------------------------- plugins (§9)

export interface ActionContext {
  readonly trigger: TriggerKind;
  readonly decision: Decision;
  readonly situation: SituationDraft;
  readonly runtime: Runtime;
  /** Run a built-in action applicable to this trigger (e.g. "discard", "retry") from a custom action. */
  builtin(name: string): Promise<boolean>;
  /** Describe exactly what this action altered (ActionRecord.changed). */
  describe(changed: string): void;
  /** Register how to undo this action (ActionRecord.undo). */
  onUndo(fn: () => void): void;
}

export interface ActionDef {
  name: string;
  description: string;
  on: TriggerKind[];
  /** Default "heal". */
  tier?: Exclude<Tier, "passive">;
  risk?: "low" | "medium" | "high";
  applicable?(sit: SituationDraft): boolean;
  run(ctx: ActionContext): void | Promise<void>;
}

export interface StandingQuestionContext {
  decision: Decision;
  situation: SituationDraft;
  runtime: Runtime;
}

export interface StandingQuestion {
  id: string;
  on: TriggerKind[];
  question: Question;
  /** true: ask on every trigger of these kinds, even when triage finds nothing salient. */
  always?: boolean;
  onAnswer?(a: Answer, ctx: StandingQuestionContext): void;
}

export interface PluginApi {
  readonly runtime: Runtime;
  readonly clock: Clock;
  emit(name: string, data?: Record<string, unknown>): void;
  /** Start an op (cause = the ambient op). Returns its id. */
  recordOp(kind: OpKind, name: string, meta?: { detail?: string; identity?: string; data?: Record<string, unknown> }): number;
  endOp(id: number, status?: OpStatus, info?: { code?: number | string; error?: unknown }): void;
  /** Run fn with the given op as the ambient op. */
  runInOp<T>(id: number, fn: () => T): T;
  user: Runtime["user"];
  reportError: Runtime["reportError"];
  on: Runtime["on"];
  stores: { names(): string[]; get(name: string): unknown };
}

export interface Plugin {
  name: string;
  setup?(api: PluginApi): void | (() => void);
  facts?(sit: SituationDraft): string[];
  actions?: ActionDef[];
  questions?: StandingQuestion[];
  diagnoses?: Record<string, string>;
}

// ---------------------------------------------------------------------------------------- runtime (§2)

export interface RuntimeEvents {
  detect: Detection;
  decide: Decision;
  act: ActionRecord;
  event: RtEvent;
  status: ModelStatus;
  report: Report;
  shadow: { decisionId: string; action: string; tier: Tier; wouldPass: boolean; reason?: string };
  breaker: { tripped: boolean; reason: "undos" | "errors" | "reset"; decisionIds: string[]; counts: { undos: number; errors: number } };
  limit: { kind: "perMinute" | "perSubject" | "perSession"; subject: string };
  modelBudget: { decisionsLastMinute: number; dropped: number };
}

export interface Runtime {
  /** Resolves when the model is loaded (immediately when there is no model). Accessing it starts a lazy load. */
  readonly ready: Promise<void>;
  readonly status: ModelStatus;
  readonly mode: Mode;

  atom<T>(name: string, initial: T, opts?: StoreOptions<T>): Atom<T>;
  guard<T>(name: string, io: StoreIO<T>, opts?: StoreOptions<T>): Guarded<T>;
  /** For state-library adapters (redux, zustand): register a store whose writes the adapter commits. */
  adapter<T>(name: string, io: AdapterIO<T>, opts?: StoreOptions<T>): AdapterHandle<T>;
  expect(name: string, predicate: () => boolean): () => void;

  ask<Q extends Question>(q: Q, opts?: AskOptions): Promise<AnswerOf<Q>>;
  decide<L extends string>(question: string, options: Record<L, string>, opts?: AskOptions): Promise<L>;

  on<K extends keyof RuntimeEvents>(type: K, fn: (v: RuntimeEvents[K]) => void): () => void;

  op<T>(name: string, fn: () => Promise<T> | T, meta?: Record<string, unknown>): Promise<T>;
  emit(name: string, data?: Record<string, unknown>): void;
  user<T>(action: UserAction, handler?: () => T): T | undefined;
  reportError(error: unknown, info?: { source?: string }): void;

  use(plugin: Plugin): () => void;
  action(def: ActionDef): () => void;
  question(def: StandingQuestion): () => void;

  situation(trigger?: TriggerKind): Situation;
  explain(id: string): Explanation | null;
  history(n?: number): RtEvent[];
  decisions(n?: number): Decision[];
  interventions(n?: number): ActionRecord[];
  /**
   * The audit trail, oldest first (the last `n` entries; all kept by default, up to InitOptions.audit.size, 1,000):
   * every decision, action, undo, breaker trip/reset and control change (setMode, setAggressiveness, pause, resume,
   * enabled, disable) as JSON-serialisable AuditEntry copies, each with the mode, profile, gate values and the
   * model's name, version and sha256 in force. Keeps working after destroy(); `JSON.stringify(rt.audit())` exports it.
   */
  audit(n?: number): AuditEntry[];
  /** In-flight ops (introspection). */
  inflight(): Op[];
  /** Registered and automatically discovered stores (introspection). */
  stores(): StoreInfo[];
  /** The current hold budget in ms (policy.holdBudgetMs, "auto" by default). */
  holdBudgetMs(): number;
  /** The current situation size in characters (situation.budget, "auto" by default). */
  situationBudget(): number;
  /** The gate thresholds in force for a trigger kind (policy overrides, else the model's meta gate, else defaults). */
  gates(trigger?: TriggerKind): EffectiveGates;
  /** The aggressiveness level in force (0 cautious … 1 eager). */
  readonly aggressiveness: number;
  /** Change how eagerly GenClass acts (a named level or a number in [0, 1]). */
  setAggressiveness(a: Aggressiveness): void;
  setMode(mode: Mode): void;
  /** Turn GenClass off for this page: releases holds, uninstalls observers; `undo: true` rolls back recent actions. */
  disable(o?: { undo?: boolean }): void;
  /** Counts for this session. */
  summary(): SessionSummary;
  /** Replace the session id and merge tags (later records only). */
  setSession(p: { id?: string; tags?: Record<string, string | number | boolean> }): void;
  readonly breaker: { reset(): void; readonly tripped: boolean };
  readonly learn: { clear(): void };
  pause(): void;
  resume(): void;
  destroy(): void;
  /** Anonymous diagnostics for this page (InitOptions.telemetry). */
  readonly telemetry?: TelemetryStatus;
}
