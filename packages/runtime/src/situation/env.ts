// What situation building reads from the runtime, and the subject of each trigger. The runtime implements
// SitEnv from its live trace; nothing in src/situation/* mutates runtime state (situation() is side-effect free
// apart from caching field versions in op.reads).

import type { Profiles, Shape, Unusual } from "../learn/profiles.js";
import type { Baselines } from "../learn/baselines.js";
import type { FieldHist, MutationRec, StoreHub } from "../state/hub.js";
import type { EventLog } from "../trace/events.js";
import type { OpRec, OpRegistry } from "../trace/ops.js";
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

export type SubjectSpec =
  | { trigger: "mutation"; m: MutationRec }
  | { trigger: "request"; op: OpRec; req: ReqMeta }
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
}
