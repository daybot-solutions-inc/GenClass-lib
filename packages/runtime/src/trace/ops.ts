// Ops registry (CONTRACT §3): every async operation, user action and GenClass action is an Op with a causal
// parent, a root, start/end times and the global mutation sequence number at start (used to answer "what was
// the version of field X when this op started").

import type { Op, OpKind, OpStatus, TriggerKind } from "../types.js";

/** Writes made by an op's causal chain (for transition profiles). */
export interface ChainWrite {
  /** Value kind of the last write. */
  kind: string;
  /** Array length before the chain's first write (-1 when not an array). */
  len0: number;
  /** Array length after the chain's last write (-1 when not an array). */
  len1: number;
}

export interface OpRec extends Op {
  /** Global applied-mutation sequence number when the op started. */
  startSeq: number;
  method?: string;
  url?: string;
  /** Error message/name for failed ops. */
  errorText?: string;
  /** Instantaneous op (user action, timer tick, ws message). */
  instant?: boolean;
  /** Number of mutations applied with this op as the direct cause. */
  wrote: number;
  /** Stores written with this op as the direct cause. */
  storesWritten?: Set<string>;
  /** Transition-profile accumulator for this op's causal chain (undefined when not profiled). */
  chain?: Map<string, ChainWrite>;
  chainWrites?: number;
  /** True once the op's transition shape was folded into its profile. */
  profiled?: boolean;
  /** Triggers already raised with this op as the subject. */
  triggered?: Set<TriggerKind>;
  /** Root op is a GenClass action: never gated, never profiled. */
  genclass?: boolean;
  /** Children count (diagnostic). */
  children: number;
}

export interface StartOpts {
  detail?: string;
  cause?: OpRec | null;
  identity?: string;
  attempt?: number;
  meta?: Record<string, unknown>;
  instant?: boolean;
  method?: string;
  url?: string;
  startSeq: number;
  t: number;
}

const MAX_OPS = 2000;
const KEEP_OPS = 1500;

export class OpRegistry {
  private nextId = 1;
  readonly byId = new Map<number, OpRec>();
  readonly inFlight = new Set<OpRec>();
  private endListeners = new Set<(op: OpRec) => void>();

  start(kind: OpKind, name: string, o: StartOpts): OpRec {
    const cause = o.cause ?? null;
    const id = this.nextId++;
    const op: OpRec = {
      id,
      kind,
      name,
      start: o.t,
      attempt: o.attempt ?? 1,
      reads: new Map(),
      startSeq: o.startSeq,
      wrote: 0,
      children: 0,
    };
    if (o.detail) op.detail = o.detail;
    if (o.identity) op.identity = o.identity;
    if (o.meta) op.meta = o.meta;
    if (o.method) op.method = o.method;
    if (o.url) op.url = o.url;
    if (cause) {
      op.cause = cause.id;
      op.root = cause.root ?? cause.id;
      cause.children++;
      if (cause.genclass || cause.kind === "genclass") op.genclass = true;
    } else {
      op.root = id;
    }
    if (kind === "genclass") op.genclass = true;
    if (o.instant) {
      op.instant = true;
      op.end = o.t;
      op.status = "ok";
    } else {
      this.inFlight.add(op);
    }
    this.byId.set(id, op);
    if (this.byId.size > MAX_OPS) this.prune();
    return op;
  }

  end(op: OpRec, t: number, status: OpStatus, code?: number | string, errorText?: string): void {
    if (op.end !== undefined && !this.inFlight.has(op)) return;
    op.end = t;
    op.status = status;
    if (code !== undefined) op.code = code;
    if (errorText) op.errorText = errorText;
    this.inFlight.delete(op);
    for (const fn of this.endListeners) {
      try {
        fn(op);
      } catch {
        /* ignore */
      }
    }
  }

  onEnd(fn: (op: OpRec) => void): () => void {
    this.endListeners.add(fn);
    return () => this.endListeners.delete(fn);
  }

  get(id: number | undefined | null): OpRec | undefined {
    return id === undefined || id === null ? undefined : this.byId.get(id);
  }

  /** Ancestors from the direct cause upwards (bounded). */
  ancestors(op: OpRec, max = 12): OpRec[] {
    const out: OpRec[] = [];
    let cur = this.get(op.cause);
    while (cur && out.length < max) {
      out.push(cur);
      cur = this.get(cur.cause);
    }
    return out;
  }

  /** True when `a` is `b` or one of b's ancestors. */
  isAncestorOrSelf(a: OpRec, b: OpRec): boolean {
    if (a === b) return true;
    let cur = this.get(b.cause);
    let n = 0;
    while (cur && n++ < 16) {
      if (cur === a) return true;
      cur = this.get(cur.cause);
    }
    return false;
  }

  /** The nearest user op in the chain (self included). */
  userOf(op: OpRec | undefined | null): OpRec | undefined {
    let cur: OpRec | undefined = op ?? undefined;
    let n = 0;
    while (cur && n++ < 16) {
      if (cur.kind === "user") return cur;
      cur = this.get(cur.cause);
    }
    return undefined;
  }

  rootOf(op: OpRec): OpRec {
    return this.get(op.root) ?? op;
  }

  private prune(): void {
    for (const [id, op] of this.byId) {
      if (this.byId.size <= KEEP_OPS) break;
      if (this.inFlight.has(op)) continue;
      this.byId.delete(id);
    }
  }
}
