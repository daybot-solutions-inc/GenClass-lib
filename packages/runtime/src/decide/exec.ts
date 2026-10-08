// The seam between the decision flow and the subject of a trigger. Each observer (fetch, XHR, hub, miner)
// implements a Controller for its subject: `passive()` lets it proceed unchanged, `run(action)` performs a
// built-in action and says exactly what changed.

import type { Clock } from "../types.js";
import type { Context } from "../trace/context.js";
import type { OpRec, StartOpts } from "../trace/ops.js";
import type { Redactor } from "../util.js";
import type { ReqMeta, SubjectSpec } from "../situation/env.js";
import type { ResponseCache } from "../observe/cache.js";

export interface ActionEffect {
  /** One sentence: exactly what GenClass altered. */
  changed: string;
  undo?: () => void;
  /** Called with the ActionRecord once it exists (effects that keep acting later, e.g. delivery discard). */
  onRecord?: (r: import("../types.js").ActionRecord) => void;
}

export interface Controller {
  /** Run the passive action (let the subject proceed unchanged). Called at most once. */
  passive(): void;
  /** Run a built-in action. Throw (or reject) when it cannot be performed; the passive action then runs. */
  run(action: string): ActionEffect | Promise<ActionEffect>;
  /**
   * Late revert (held writes only): the hold budget expired and the write applied; a `discard` decided afterwards
   * reverts exactly that write. `revertable()` returns null when it can, else the reason it cannot.
   */
  revertable?(): string | null;
  revert?(): ActionEffect;
  /** The subject already proceeded (write applied, request sent, response delivered): actions now come too late. */
  proceeded?(): boolean;
  /** A queued decision about this subject is no longer worth computing (delivered, superseded, aborted). */
  stale?(): boolean;
}

export interface TriggerOpts {
  /** The subject waits for the decision (held write/request/failure). */
  hold: boolean;
  priority: number;
}

export interface EndOpts {
  code?: number | string;
  errorText?: string;
  /** Counts as a failure in baselines (network error, timeout, 5xx/429/408). */
  failure?: boolean;
  /** Answered by GenClass (cache, coalesce, block): not a real round trip, kept out of latency baselines. */
  synthetic?: boolean;
}

/** What network observers need from the runtime. */
export interface NetHost {
  readonly clock: Clock;
  readonly ctx: Context;
  readonly global: Record<string, unknown>;
  readonly cache: ResponseCache;
  redact(): Redactor;
  baseHref(): string | undefined;
  startOp(kind: "fetch" | "xhr" | "ws", name: string, o: Omit<StartOpts, "startSeq" | "t">): OpRec;
  endOp(op: OpRec, status: "ok" | "error" | "aborted" | "blocked", o?: EndOpts): void;
  /** True when triggers may be raised for this op (not paused, not a GenClass-issued request). */
  gated(op: OpRec): boolean;
  trigger(spec: SubjectSpec, ctl: Controller, opts: TriggerOpts): void;
  /** Schedule the stall check for an in-flight request; returns a cancel function. */
  watchStall(op: OpRec, req: ReqMeta, ctl: () => Controller): () => void;
  failureStreak(sig: string): number;
  emit(name: string, data?: Record<string, unknown>, op?: OpRec): void;
  /**
   * A response is about to reach the app: the delivery gate. `release` delivers it (now or after a decision);
   * called at most once; synchronously when nothing is salient.
   */
  deliver(o: { op: OpRec; req: ReqMeta; status: number; body?: () => Promise<unknown> }, release: () => void): void;
  /** A successful response arrived (any method): its parsed JSON body, read from a clone, for read-your-writes. */
  noteResponse?(o: { op: OpRec; req: ReqMeta; status: number; body: () => Promise<unknown> }): void;
  /** A request identity that matches nothing else (bodies that cannot be read cheaply). */
  uniqueId(): string;
  /** Set a request's identity once known (after reading its body) and register it. */
  setIdentity(op: OpRec, req: ReqMeta, identity: string): void;
}
