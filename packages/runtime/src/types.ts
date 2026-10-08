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
  state: "off" | "loading" | "ready" | "error";
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
  /** What the WebGPU probe found. */
  gpu?: string;
  /** Plans that failed before the one that loaded (or all of them, on error). */
  attempts?: { variant: string; device: string; error: string }[];
  /** onnxruntime-web version. */
  ort?: string;
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
  /** Defaults: report 0.6, guard 0.9, heal 0.8. */
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
   * Default false: store writes are never held (decisions about responses and messages are taken at the network
   * boundary; salient writes not covered by such a decision are decided in the background and may be reverted
   * under the late-revert rules). true (opt-in): salient writes wait for the model, without ever reordering a
   * store's writes, and reads inside the writing chain see the pending value.
   */
  holdWrites?: boolean;
  /** Default 60 non-passive actions per minute; beyond it the passive action runs and a warning is emitted. */
  maxActionsPerMinute?: number;
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
}

export interface InitOptions {
  /** Default "guard". observe never changes execution. */
  mode?: Mode;
  /** false: no model (observe-only). */
  model?: ModelOptions | false;
  /** Bring your own decision provider instead of the local model. */
  decider?: DecisionProvider | null;
  /** Default "console". */
  report?: "console" | "silent" | ((r: Report) => void);
  /** Default: all true (where the global supports them). */
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
  redact?: (path: string, value: unknown) => unknown;
  plugins?: Plugin[];
  /** Events kept, default 500. */
  historySize?: number;
  /** Console logging of every decision. */
  debug?: boolean;
  /** Transition profiles: persist to localStorage (default false). */
  learn?: { persist?: boolean };
  /** Override the diagnosis vocabulary and action descriptions the model sees. */
  vocabulary?: Vocabulary;
  /** Quiet time after the last mutation before a settled point (default 60 ms). */
  settleMs?: number;
  /**
   * Size of the situation text the model reads, in characters. Default "auto": by device from the model status
   * (webgpu 2,400; wasm 1,000 at 1 thread to 2,000 at 4 threads, linear; unknown device 2,400).
   */
  situation?: { budget?: number | "auto" };
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
  kind: "detect" | "intervene" | "status";
  message: string;
  decision?: Decision;
  action?: ActionRecord;
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
  /** In-flight ops (introspection). */
  inflight(): Op[];
  /** The current hold budget in ms (policy.holdBudgetMs, "auto" by default). */
  holdBudgetMs(): number;
  /** The current situation size in characters (situation.budget, "auto" by default). */
  situationBudget(): number;
  setMode(mode: Mode): void;
  pause(): void;
  resume(): void;
  destroy(): void;
}
