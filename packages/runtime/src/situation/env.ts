// What situation building reads from the runtime, and the subject of each trigger. The runtime implements
// SitEnv from its live trace; nothing in src/situation/* mutates runtime state (situation() is side-effect free
// apart from caching field versions in op.reads).

import type { Profiles, Shape, Unusual } from "../learn/profiles.js";
import type { Baselines } from "../learn/baselines.js";
import type { FieldHist, MutationRec, StoreHub } from "../state/hub.js";
import type { EventLog } from "../trace/events.js";
import type { OpRec, OpRegistry } from "../trace/ops.js";
import type { Conflict, Predicted } from "./conflicts.js";
import type { ContentResult } from "./content.js";
import type { CadenceInfo } from "../learn/cadence.js";
import type { Redactor } from "../util.js";

export interface ReqMeta {
  method: string;
  url: string;
  signature: string;
  identity: string;
  idempotent: boolean;
  replayable: boolean;
  bodyBytes?: number;
  transport: "fetch" | "xhr";
  /** Request header names, lower-cased (idempotency keys for `retry`). */
  headers?: string[];
}

export interface FailureInfo {
  kind: "network" | "timeout" | "http";
  status?: number;
  statusText?: string;
  message?: string;
  durMs: number;
}

export interface Violation {
  id: string;
  text: string;
  fields: string[];
  values: string;
  /** Settled points at which it held before. */
  held: number;
  developer?: boolean;
}

export interface ErrorInfo {
  name: string;
  message: string;
  source?: string;
  raw: unknown;
  key: string;
}

export interface DeliverySpec {
  trigger: "delivery";
  /** The fetch op whose response arrived, or the message op. */
  op: OpRec;
  channel: "response" | "websocket" | "eventsource";
  req?: ReqMeta;
  /** Response status (responses). */
  status?: number;
  /** Message summary and channel path (messages). */
  message?: { path: string; summary: string };
  predicted: Predicted;
  /** Concrete fields matching the prediction. */
  matched: string[];
  conflicts: Conflict[];
  /** Times this delivery was already deferred. */
  defers: number;
  /** Messages of the same channel already held ahead of this one. */
  queuedAhead: number;
  /** The parsed JSON body of the response/message, when it was read (salient deliveries only). */
  body?: unknown;
  /** Its comparison with the predicted fields (computed once at the gate). */
  content?: ContentResult;
}

/** A create response seen recently (read-your-writes). */
export interface CreateRec {
  op: OpRec;
  /** When the response arrived. */
  t: number;
  status: number;
  ids: string[];
  /** Keys of the created object (to match the lists it belongs to). */
  keys: string[];
}

/** A completed request (any signature), for failure scope across endpoints. */
export interface OutcomeRec {
  t: number;
  sig: string;
  /** "same-origin" or the host of a cross-origin request. */
  host: string;
  ok: boolean;
  outcome: string;
}

export type SubjectSpec =
  | { trigger: "mutation"; m: MutationRec }
  | { trigger: "request"; op: OpRec; req: ReqMeta }
  | DeliverySpec
  | { trigger: "failure"; op: OpRec; req: ReqMeta; failure: FailureInfo }
  | { trigger: "stall"; op: OpRec; req: ReqMeta }
  | { trigger: "inconsistency"; violations: Violation[] }
  | { trigger: "transition"; op: OpRec; unusual: Unusual[]; shape: Shape }
  | { trigger: "error"; error: ErrorInfo; op: OpRec | null }
  | { trigger: "ask"; about: "now" | number | string };

export interface CachedInfo {
  t: number;
  status: number;
}

export interface SitEnv {
  now(): number;
  ops: OpRegistry;
  hub: StoreHub;
  base: Baselines;
  profiles: Profiles;
  events: EventLog;
  redact: Redactor;
  app(): { title?: string; route?: string };
  /** Cached good response for a GET identity. */
  cached(identity: string): CachedInfo | undefined;
  /** Recent ops (last 10 s, in flight or finished) with this request identity, oldest first. */
  identical(identity: string): OpRec[];
  /** Last snapshot at which all learned invariants held. */
  lastConsistent(): { t: number; seq: number } | null;
  /** Latest consistent snapshot taken at or before global mutation sequence `seq`. */
  consistentBefore(seq: number): { t: number; seq: number } | null;
  /** signature -> store -> times its chain wrote the store. */
  storeWriters: Map<string, Map<string, number>>;
  /** Recent errors (last 10 s). */
  recentErrors(): { key: string; t: number; op?: number }[];
  /** Currently violated learned invariants (for ask). */
  violations(): Violation[];
  /** Learned invariants that involve any of these fields, evaluated on hypothetical leaves (mutation preview). */
  previewInvariants?(m: MutationRec): Violation[];
  /** Whether a field history entry was written by the op `a`'s own chain. */
  writtenByChain?(a: OpRec, h: FieldHist): boolean;
  /** An identical request is in flight or just finished with a shareable response. */
  canCoalesce(identity: string, selfId: number): boolean;
  /** The store has a resync handler. */
  resyncable(store: string): boolean;
  /** GenClass can write the store directly (rollback). */
  writable(store: string): boolean;
  /** Fields written by an op's causal chain (its root's chain) since the root started. */
  chainWrites(op: OpRec): ChainWriteInfo[];
  /** Normalised fields the last completed op of this signature (its chain) wrote, if any. */
  lastChain(sig: string): string[] | undefined;
  /** Create responses of the last 10 s (read-your-writes). */
  creates(): CreateRec[];
  /** Learned schedule / debounce of a request signature. */
  cadence(sig: string, now: number): CadenceInfo | undefined;
  /** Completed requests of the last 30 s across signatures. */
  outcomes(): OutcomeRec[];
  /** navigator.onLine, when the global has it. */
  online(): boolean | undefined;
  /** policy.idempotencyHeaders, lower-cased. */
  idempotencyHeaders(): Set<string>;
}

export interface ChainWriteInfo {
  path: string;
  /** Writes by the chain. */
  count: number;
  /** The chain made the latest write to the field (nobody overwrote it since). */
  lastIsChain: boolean;
  /** The value before the chain's first write (unknown when that write is older than the 16-entry history). */
  before?: { value: unknown; removed: boolean };
}
