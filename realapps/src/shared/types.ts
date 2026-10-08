// Types shared by the in-page world (src/world) and the Node harness (src/harness).

// ------------------------------------------------------------------------------------------- mock server

export type IdStyle = "num" | "uuid" | "slug" | "prefixed";
export type Envelope = "items" | "data" | "bare" | "results";

export interface CollectionSpec {
  name: string;
  /** URL segment (default: name). */
  path?: string;
  seed: Record<string, unknown>[];
  idStyle?: IdStyle;
  /** PUT/PATCH must carry the current `version` (body.version or If-Match), else 409 with the current item. */
  versioned?: boolean;
  /** Fields matched by ?q= (case-insensitive substring). */
  search?: string[];
  /** Fields filterable by ?<field>=<value>. */
  filters?: string[];
  /** Page size for ?page= / ?offset=&limit= (default 20). */
  pageSize?: number;
  envelope?: Envelope;
  /** Relative, non-idempotent actions: POST <base>/<path>/:id/<verb>. */
  actions?: Record<string, { inc?: string; by?: number; toggle?: string; set?: Record<string, unknown> }>;
  /** Publish changes on the WebSocket topic `<name>`. */
  live?: boolean;
  /** Requests need a valid bearer token (spec.auth). */
  protected?: boolean;
  /** Fields whose value must be unique across items: a create/update that collides answers 409. */
  unique?: string[];
  /** Fields a create must carry (non-empty): otherwise 422. */
  required?: string[];
}

export interface ServerSpec {
  /** API prefix, e.g. "/api". */
  base: string;
  collections: CollectionSpec[];
  docs?: { name: string; init: Record<string, unknown>; versioned?: boolean; live?: boolean; protected?: boolean }[];
  counters?: { name: string; init: number; live?: boolean }[];
  auth?: { ttlMs: number; rotate: boolean };
  /** Cart summary endpoints over a cart collection with {productId, qty, price}. */
  cart?: { collection: string };
  /** Named server extensions implemented in src/world/ext (e.g. "conduit"). */
  ext?: string[];
  /** Extension options. */
  extOpts?: Record<string, unknown>;
  /** Response envelope for collections without their own. */
  envelope?: Envelope;
}

// ------------------------------------------------------------------------------------------ chaos profile

export interface Lat {
  median: number;
  sigma: number;
}
export type OutageMode = "503" | "500" | "502" | "neterr" | "hang" | "empty";
export interface Window {
  start: number;
  end: number;
}
export interface NetProfile {
  ideal: boolean;
  byKind: Record<"read" | "write" | "auth" | "bulk", Lat>;
  /** Per-signature latency personalities. */
  latency: Record<string, Lat>;
  spikeP: number;
  spikeMul: [number, number];
  /** Random 5xx probability per request. */
  transientP: number;
  /** Probability a transient 5xx on a write happens after the write committed. */
  postCommitP: number;
  netErrP: number;
  /** A hung request answers 504 after this long. */
  gatewayMs: number;
  outages: (Window & { endpoints: string[] | "*"; mode: OutageMode })[];
  slow: (Window & { endpoints: string[] | "*"; mul: number })[];
  capacity?: { perSec: number; mode: "503" | "429" | "latency" };
  rateLimits: Record<string, { perSec: number; retryAfter: boolean }>;
  replicaLag?: { ms: number; p: number };
  bugs: (Window & { endpoint: string; kind: "drop-field" | "null-field" | "empty-list" | "html"; field: string })[];
  push: Lat;
  /** WebSocket drops (server closes with 1006 and refuses reconnects while down). */
  wsDrops: { t: number; downMs: number }[];
}

// ----------------------------------------------------------------------------------------- user session

export type StepKind = "click" | "dblclick" | "type" | "clear" | "select" | "check" | "key" | "hover";

export interface Step {
  i: number;
  /** Scheduled virtual time (ms). The driver runs a step at max(t, previous step done). */
  t: number;
  kind: StepKind;
  /** CSS selector; ">>>" descends into shadow roots. */
  sel: string;
  /** Keep only elements whose text contains this. */
  text?: string;
  /** Which match (index into the matches, modulo their count); default 0. */
  nth?: number;
  /** type: text to type; select: option value or label. */
  value?: string;
  key?: string;
  /** Per-key delays for typing (ms between keystrokes). */
  keyMs?: number[];
  /** Typing: clear the field first. */
  clear?: boolean;
  /** Typing: press Enter at the end. */
  enter?: boolean;
  intent: { key: string; mode: "replace" | "accumulate"; affordance: string };
  /** A repeat with no new intent (double click, impatient re-click). Skipped in the ideal run. */
  accidental?: boolean;
  repeatOf?: number;
  /** Only run if a request is in flight (impatient re-click). */
  when?: "inflight";
  /** Wait up to this long (ms) for the element to appear. Default 2000. */
  waitMs?: number;
  /** Visible-element precondition checked when the step runs (skip at once when absent). */
  requires?: string;
  requiresText?: string;
  /** Index of the first step of this follow-up chain: when that step was skipped, this one is skipped too. */
  head?: number;
}

export interface ExternalEvent {
  t: number;
  kind: "create" | "update" | "delete" | "action" | "doc" | "counter";
  target: string;
  /** update/delete/action: index of the item (modulo the collection size at that time). */
  index?: number;
  data?: Record<string, unknown>;
  verb?: string;
  by?: number;
}

// ------------------------------------------------------------------------------------------- run config

export interface RunConfig {
  runId: string;
  seed: number;
  app: string;
  ideal: boolean;
  /** decision index -> forced action. */
  forced: [number, string][];
  /** Exploration probability (diagnosis != expected; a quarter elsewhere). 0 = none. */
  explore: number;
  /** Record full decision states (base run). */
  record: boolean;
  /** Record fingerprints of decisions <= this index (counterfactual runs). -1: none. */
  fpUpTo: number;
  tStop: number;
  /** Record snapshots from this virtual time (earlier ones only as the latest state before it). */
  snapFrom: number;
  future?: { k: number; salt: number; t: number };
  server: ServerSpec;
  net: NetProfile;
  steps: Step[];
  external: ExternalEvent[];
  vocab: { diagnoses?: Record<string, string>; actions?: Record<string, string> } | null;
  budget: number;
  modelMs: number;
  variant: Record<string, unknown>;
  domRoot: string;
  errorSelector: string;
  epoch: number;
  /** Runtime observers (real ones, minus nondeterministic perf). */
  observe: Record<string, boolean>;
  /** Integration of the runtime for this app ("stores" | "observe"). */
  integration: string;
  /** Run the initial load at this time (ms). */
  loadAt: number;
  /** Runtime mode for non-ideal runs (default "heal"; debugging only). */
  mode?: string;
  /** Divergence weights from the manifest ("store" or "store.field"); diagnosis ignores fields weighted <= 0.1. */
  weights?: Record<string, number>;
  /** Intent pins from the ideal run: step index -> identity tokens of the item the ideal user acted on. Other runs
   * act on the visible element whose item matches best (the same intent), not on the same list position. */
  pins?: Record<number, string[]>;
  /** Base run: probe runtime.situation("ask") at these times (developer-question rows). */
  askTimes?: number[];
}

/** Facts about the trace at an ask probe (same shape as sim/src/run/runner.ts AskFacts). */
export interface AskFacts {
  now: number;
  inflight: { sig: string; method: string; age: number; write: boolean; feature: string }[];
  recent: { sig: string; method: string; status?: number; outcome: string; t: number; td: number }[];
  lastUserAt: number;
  userWaitingMs: number;
  stores: Record<string, unknown>;
  errorsShown: number;
  lastSave?: { ok: boolean; t: number };
  route: string;
}

// ------------------------------------------------------------------------------------------- run result

export interface SnapshotRec {
  t: number;
  /** Changed stores only (JSON strings); reconstruct by carrying forward. */
  s?: Record<string, string>;
  /** Visible DOM text lines (when changed). */
  d?: string[];
  /** Error UI elements present. */
  e?: number;
}

export interface NetRec {
  id: number;
  method: string;
  url: string;
  sig: string;
  t0: number;
  /** Arrival at the server. */
  ta?: number;
  /** Delivered to the client. */
  td?: number;
  status?: number;
  outcome: "pending" | "ok" | "http-error" | "neterr" | "aborted" | "hang" | "timeout";
  cause?: string;
  committed?: boolean;
  slowCause?: string;
  idempotent: boolean;
  transport: "fetch" | "xhr";
  /** Runtime op id (when correlated). */
  rtOp?: number;
  /** Harness step that is the root cause (when known). */
  step?: number;
  bodyKey: string;
  dedupedOf?: number;
  /** The request carried an Idempotency-Key header. */
  idem?: boolean;
}

export interface DecisionRec {
  k: number;
  t: number;
  trigger: string;
  actions: string[];
  chosen: string;
  explored: boolean;
  diagnosis?: string;
  diagWhy?: string;
  diagTrace?: string;
  /** Hash of JSON([trigger, state, questions]). */
  fp: string;
  state?: Record<string, unknown>;
  questions?: Record<string, unknown>;
  subject: Record<string, unknown>;
}

export interface RunResult {
  runId: string;
  ok: boolean;
  error?: string;
  tStop: number;
  tasks: number;
  realMs: number;
  decisions: DecisionRec[];
  snapshots: SnapshotRec[];
  initial: SnapshotRec;
  net: NetRec[];
  server: ServerSnap;
  serverTimeline?: { t: number; server: ServerSnap }[];
  errorEpisodes: number[];
  /** Proposed writes that put an error message into a store (counted even when GenClass drops the write). */
  errorWrites?: number[];
  /** Steps skipped because their element never appeared (blocked user intents). */
  skippedAt?: number[];
  uncaught: number[];
  /** Pending intervals of requests rooted in a user step: [start, end|null]. */
  userOps: [number, number | null][];
  stepsRun: number;
  stepsSkipped: number;
  internalErrors: string[];
  wsMessages: number;
  asks?: { t: number; state: Record<string, unknown>; facts: AskFacts }[];
  /** Ideal run: identity tokens of the item each step acted on (see RunConfig.pins). */
  pins?: Record<number, string[]>;
}

export interface ServerSnap {
  collections: Record<string, Record<string, unknown>>;
  docs: Record<string, Record<string, unknown>>;
  counters: Record<string, number>;
}
