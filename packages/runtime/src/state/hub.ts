// StoreHub (CONTRACT §4): registered stores, per-field versions with write logs, the mutation pipeline
// (propose -> gate -> hold -> apply in proposal order per store), recent changes for repetition facts.
//
// Apply semantics of a write that waited (held, or queued behind a held write):
//   - functional updates re-run against the value at apply time;
//   - value writes are re-applied as a patch of the fields they changed (so a user's newer input to another
//     field of the same store survives); if the store value did not change meanwhile, the value is used as is.
// User-sync writes (inside a user handler's task) and GenClass action writes bypass the queue and never wait.
// A functional update that may be held must not change live state before the decision: if the updater mutated
// the stored value in place, the change is detached into a copy and the live value is restored (when it cannot
// be restored exactly, the write is applied at once and marked as not holdable).

import type { Clock, Change, StoreIO, StoreOptions } from "../types.js";
import type { Context } from "../trace/context.js";
import type { EventLog } from "../trace/events.js";
import type { OpRec } from "../trace/ops.js";
import { describe, isPlainObject, type Redactor } from "../util.js";
import { changeText, cloneValue, diffLeaves, flatten, patchValue, type FieldChange, type Leaf } from "./fields.js";

export { changeText } from "./fields.js";

const HIST = 16;
const LOG = 512;
const RECENT_MS = 10_000;
const RECENT_MAX = 256;

export interface FieldHist {
  v: number;
  seq: number;
  writer: number | null;
  /** Root op of the writer's chain. */
  root: number | null;
  user: boolean;
  t: number;
  delta: string;
  before: unknown;
  after: unknown;
  beforeLeaf?: Leaf;
  afterLeaf?: Leaf;
  mutation: number;
}

/** Compact write log entry (counts and versions beyond the rich 16-entry history). */
export interface LogEntry {
  seq: number;
  v: number;
  t: number;
  writer: number | null;
  root: number | null;
  user: boolean;
  mutation: number;
}

export interface FieldState {
  path: string;
  v: number;
  writer: number | null;
  t: number;
  seq: number;
  /** The last 16 writes with values. */
  hist: FieldHist[];
  /** The last 512 writes (seq ascending). */
  log: LogEntry[];
  /** The current value is known to be suspicious (situation v2, F9); cleared by the next write. */
  mark?: StaleMark;
  /** Store version before this field's first change (churn: changes / store writes since). */
  born?: number;
}

/** A numeric field that changed in at least this share of its store's writes (over ≥ BUSY_MIN_WRITES) is busy. */
export const BUSY_RATIO = 0.8;
export const BUSY_MIN_WRITES = 10;

/** Why a field's current value may be stale: written over newer data, by a very slow response, after an ambiguous failure, ... */
export interface StaleMark {
  t: number;
  op: number | null;
  /** "written by the response to GET /x (#6), which was delivered over newer data from …" */
  why: string;
}

export interface RecentChange {
  t: number;
  seq: number;
  store: string;
  /** Sorted changed paths joined with "," */
  paths: string;
  /** Hash of paths + deltas: equal for "the same change" applied again. */
  key: string;
  writer: number | null;
  root: number | null;
  user: boolean;
  mutation: number;
}

export type Verdict = "apply" | "discard" | "defer";

export interface MutationRec {
  id: number;
  store: string;
  changes: FieldChange[];
  cause: OpRec | null;
  root: number | undefined;
  t: number;
  /** Value at proposal time (for patch semantics). */
  base: unknown;
  /** Previewed value at proposal time. */
  preview: unknown;
  /** Leaves of the preview. */
  leaves?: Map<string, Leaf>;
  fn?: (prev: unknown) => unknown;
  /** Custom commit (guard io.set, redux dispatch, zustand set). Receives the computed next value. */
  commit?: (next: unknown) => void;
  userSync: boolean;
  genclass: boolean;
  defers: number;
  state: "queued" | "held" | "resolved" | "done";
  verdict?: Verdict;
  /** Set when the write was applied or dropped. */
  outcome?: "applied" | "discarded" | "deferred" | "failed";
  /** When applied: the time, the global sequence number and the changes actually made (for a late revert). */
  appliedAt?: number;
  appliedSeq?: number;
  applied?: FieldChange[];
  /** Why the write could not be held (e.g. the updater changed the stored value in place). */
  unholdable?: string;
}

export interface GateResult {
  /** Promise of the verdict when the write is held; undefined when it may apply now. */
  held?: Promise<Verdict>;
}

export interface StoreRec {
  name: string;
  value: unknown;
  version: number;
  fields: Map<string, FieldState>;
  leaves: Map<string, Leaf>;
  opts: StoreOptions<unknown>;
  io?: StoreIO<unknown>;
  subs: Set<(v: unknown) => void>;
  queue: MutationRec[];
  unsubscribeIO?: () => void;
  /** Suppress external-change detection while we commit through io.set. */
  committing: boolean;
  kind: "atom" | "guard" | "adapter" | "observed";
  /** GenClass can write it directly (rollback); false for adapter stores without a setter and observed stores. */
  writable: boolean;
  /** Where an automatically discovered store came from ("react", "redux", "zustand", "devtools"); unset when registered by the app. */
  source?: string;
}

export interface HubHooks {
  gate(m: MutationRec): GateResult;
  /** Not holding writes: called before a write that could have been held applies (decide in the background). */
  observeWrite?(m: MutationRec): void;
  /** Paths of this write to drop (delivery `discard`: writes over newer data), or null. */
  filter?(m: MutationRec): Set<string> | null;
  /** Some (or all) changes of a write were dropped by `filter`. */
  dropped?(m: MutationRec, dropped: FieldChange[], applied: boolean): void;
  /** Whether a write to this store could be held right now (decides whether live state must be protected). */
  mayHold(s: StoreRec): boolean;
  /** Resolves when the in-flight ops related to a deferred write have settled. */
  waitRelated(m: MutationRec): Promise<void>;
  applied(m: MutationRec | null, store: StoreRec, changes: FieldChange[], writer: OpRec | null): void;
  discarded(m: MutationRec): void;
  proposed?(m: MutationRec): void;
  /** An app setter/reducer/subscriber threw while GenClass applied a write later. */
  appError?(e: unknown, source: string): void;
}

export class StoreHub {
  readonly stores = new Map<string, StoreRec>();
  /** Global applied-change sequence number. */
  seq = 0;
  private mid = 0;
  readonly recent: RecentChange[] = [];
  readonly mutations = new Map<number, MutationRec>();
  hooks!: HubHooks;
  holdUserWrites = false;
  /** Opt-in store-write holds (policy.holdWrites). Default false: writes always apply in the caller's stack. */
  holdWrites = false;
  /** When false (paused / destroyed) every write applies immediately. */
  gating = true;
  private snapCache = new Map<string, { version: number; ref: unknown; seq: number; clone: unknown }>();

  constructor(
    private readonly clock: Clock,
    private readonly ctx: Context,
    private readonly events: EventLog,
    private readonly redact: () => Redactor,
  ) {}

  register(name: string, kind: StoreRec["kind"], initial: unknown, opts: StoreOptions<unknown>, io?: StoreIO<unknown>): StoreRec {
    const prev = this.stores.get(name);
    if (prev) {
      prev.unsubscribeIO?.();
      this.stores.delete(name);
    }
    const s: StoreRec = {
      name,
      value: initial,
      version: 0,
      fields: new Map(),
      leaves: flatten(name, initial),
      opts,
      subs: new Set(),
      queue: [],
      committing: false,
      kind,
      writable: kind === "observed" ? false : kind !== "adapter" || typeof io?.set === "function",
    };
    if (io) s.io = io;
    for (const path of s.leaves.keys()) s.fields.set(path, { path, v: 0, writer: null, t: this.clock.now(), seq: this.seq, hist: [], log: [], born: 0 });
    this.stores.set(name, s);
    if (io?.subscribe) {
      s.unsubscribeIO = io.subscribe(() => {
        if (!s.committing) this.external(s);
      });
    }
    return s;
  }

  unregister(name: string): void {
    const s = this.stores.get(name);
    if (!s) return;
    s.unsubscribeIO?.();
    this.stores.delete(name);
    this.snapCache.delete(name);
  }

  get(name: string): StoreRec | undefined {
    return this.stores.get(name);
  }

  read(s: StoreRec): unknown {
    return s.io ? s.io.get() : s.value;
  }

  // ------------------------------------------------------------------------------------------- pipeline

  /** Propose a write. `fn` (functional) or `value`; `commit` writes through to the underlying store. */
  propose(s: StoreRec, w: { fn?: (prev: unknown) => unknown; value?: unknown; commit?: (next: unknown) => void }): MutationRec | null {
    const cause = this.ctx.op();
    const base = this.read(s);
    const userSync = this.ctx.isUserSync(cause);
    const genclass = !!cause?.genclass;
    const bypass = (userSync && !this.holdUserWrites) || genclass || s.opts.hold === false || !this.gating;
    const guarded = !bypass && this.hooks.mayHold(s);
    const pv = this.previewOf(s, w, base, guarded);
    const changes = diffLeaves(s.leaves, pv.leaves);
    const m: MutationRec = {
      id: ++this.mid,
      store: s.name,
      changes,
      cause,
      root: cause?.root,
      t: this.clock.now(),
      base,
      preview: pv.preview,
      leaves: pv.leaves,
      userSync,
      genclass,
      defers: 0,
      state: "queued",
    };
    if (w.fn && !pv.detached) m.fn = w.fn;
    if (w.commit) m.commit = w.commit;
    if (pv.unholdable) m.unholdable = pv.unholdable;
    this.hooks.proposed?.(m);
    // delivery `discard`: drop exactly the changes this write would make over newer data
    if (changes.length && !genclass && this.hooks.filter && !this.applyFilter(s, m, base)) return m;
    if (m.changes.length === 0 || bypass || pv.unholdable) {
      // never waits: applied now, in the caller's stack (app errors propagate to the caller, as without GenClass);
      // earlier held writes of this store apply first, in order (a hold never reorders the app's writes)
      if (this.holdWrites && s.queue.length) this.flushQueue(s);
      this.commit(s, m, true);
      return m;
    }
    if (!this.holdWrites) {
      // no store holds: the situation is built now (as of this proposal), the write applies now, the model decides
      // in the background (detection; a late revert under the strict rules)
      try {
        this.hooks.observeWrite?.(m);
      } catch {
        /* observation never blocks a write */
      }
      this.commit(s, m, true);
      return m;
    }
    this.mutations.set(m.id, m);
    if (this.mutations.size > 512) {
      for (const [id, x] of this.mutations) {
        if (this.mutations.size <= 256) break;
        if (x.state === "done") this.mutations.delete(id);
      }
    }
    s.queue.push(m);
    this.gateAndQueue(s, m);
    return m;
  }

  /** The value a write would produce, computed without changing live state when the write may be held. */
  private previewOf(
    s: StoreRec,
    w: { fn?: (prev: unknown) => unknown; value?: unknown },
    base: unknown,
    guarded: boolean,
  ): { preview: unknown; leaves: Map<string, Leaf>; detached?: boolean; unholdable?: string } {
    if (!w.fn) return { preview: w.value, leaves: flatten(s.name, w.value, s.leaves) };
    const preview = w.fn(base);
    if (!guarded) return { preview, leaves: flatten(s.name, preview, s.leaves) };
    const live = flatten(s.name, base, s.leaves);
    const mutated = diffLeaves(s.leaves, live);
    if (!mutated.length) return { preview, leaves: preview === base ? live : flatten(s.name, preview, s.leaves) };
    // the updater changed the stored value in place: detach its result, then restore the live value
    let detached: unknown;
    let ok = true;
    try {
      detached = cloneValue(preview);
    } catch {
      ok = false;
    }
    if (ok) ok = this.restoreInPlace(s, base, mutated);
    if (!ok) return { preview, leaves: flatten(s.name, preview, s.leaves), unholdable: "the update changed the stored value in place, so it could not be held" };
    return { preview: detached, leaves: flatten(s.name, detached, s.leaves), detached: true };
  }

  /** Undo an in-place mutation of `base` using the recorded leaves. True when the live value matches them again. */
  private restoreInPlace(s: StoreRec, base: unknown, mutated: FieldChange[]): boolean {
    for (const c of mutated) {
      const segs = c.path.split(".").slice(1);
      const old = c.beforeLeaf;
      if (segs.length === 0) {
        if (Array.isArray(base) && old && Array.isArray(old.value)) {
          base.length = 0;
          base.push(...(old.value as unknown[]));
          continue;
        }
        if (isPlainObject(base) && old && isPlainObject(old.value)) {
          for (const k of Object.keys(base)) delete base[k];
          Object.assign(base, old.value);
          continue;
        }
        return false;
      }
      let parent: unknown = base;
      for (let i = 0; i < segs.length - 1; i++) {
        parent = isPlainObject(parent) ? parent[segs[i]] : undefined;
        if (!isPlainObject(parent)) return false;
      }
      if (!isPlainObject(parent)) return false;
      const key = segs[segs.length - 1];
      const cur = parent[key];
      if (!old) delete parent[key];
      else if (old.kind === "array" && Array.isArray(cur) && Array.isArray(old.value)) {
        cur.length = 0;
        cur.push(...(old.value as unknown[]));
      } else if (old.kind === "object" && isPlainObject(cur) && isPlainObject(old.value)) {
        for (const k of Object.keys(cur)) if (!(k in old.value)) delete cur[k];
        Object.assign(cur, old.value);
      } else parent[key] = old.value;
    }
    return diffLeaves(s.leaves, flatten(s.name, base, s.leaves)).length === 0;
  }

  /** Drop the changes `filter` names. Returns false when nothing is left to apply (the write is dropped). */
  private applyFilter(s: StoreRec, m: MutationRec, base: unknown): boolean {
    const drop = this.hooks.filter!(m);
    if (!drop || !drop.size) return true;
    const dropped = m.changes.filter((c) => drop.has(c.path));
    if (!dropped.length) return true;
    const keep = m.changes.filter((c) => !drop.has(c.path));
    if (!keep.length) {
      m.state = "done";
      m.outcome = "discarded";
      this.hooks.dropped?.(m, dropped, false);
      return false;
    }
    // A library write (redux dispatch, zustand set) is applied in part too: its commit receives the patched value
    // (the redux enhancer dispatches the original action with that state as the reducer's result; zustand replaces
    // the state with it). Applying it whole here made a delivery `discard` a silent no-op on those stores.
    const p = patchValue(
      s.name,
      base,
      keep.map((c) => ({ path: c.path, after: c.after, removed: c.afterLeaf === undefined })),
    );
    if (!p.ok) return true;
    m.base = base;
    m.preview = p.value;
    m.leaves = flatten(s.name, p.value, s.leaves);
    m.changes = diffLeaves(s.leaves, m.leaves);
    delete m.fn;
    this.hooks.dropped?.(m, dropped, true);
    return true;
  }

  /** Apply every queued or held write of a store now, in proposal order (their decisions may still revert them). */
  flushQueue(s: StoreRec): void {
    for (const q of s.queue) {
      if (q.state !== "resolved") {
        q.state = "resolved";
        q.verdict = "apply";
      }
    }
    this.drain(s);
  }

  /**
   * Read-your-writes while holding (holdWrites): the store value as the chain `root` sees it, with its own pending
   * writes applied on top. Undefined when the chain has no pending write.
   */
  pendingView(s: StoreRec, root: number | null | undefined): unknown {
    if (!this.holdWrites || !s.queue.length || root === null || root === undefined) return undefined;
    let v = this.read(s);
    let any = false;
    for (const m of s.queue) {
      if (m.root !== root || m.state === "done") continue;
      const p = patchValue(
        s.name,
        v,
        m.changes.map((c) => ({ path: c.path, after: c.after, removed: c.afterLeaf === undefined })),
      );
      if (p.ok) {
        v = p.value;
        any = true;
      }
    }
    return any ? v : undefined;
  }

  private gateAndQueue(s: StoreRec, m: MutationRec): void {
    let g: GateResult;
    try {
      g = this.hooks.gate(m);
    } catch {
      g = {};
    }
    if (!g.held) {
      m.state = "resolved";
      m.verdict = "apply";
      this.drain(s);
      return;
    }
    m.state = "held";
    g.held.then(
      (v) => {
        m.state = "resolved";
        m.verdict = v;
        this.drain(s);
      },
      () => {
        m.state = "resolved";
        m.verdict = "apply";
        this.drain(s);
      },
    );
  }

  /** Apply/drop resolved writes at the head of the store's queue, in proposal order. Never throws. */
  private drain(s: StoreRec): void {
    while (s.queue.length && s.queue[0].state === "resolved") {
      const m = s.queue.shift()!;
      const v = m.verdict ?? "apply";
      try {
        if (v === "discard") {
          m.state = "done";
          m.outcome = "discarded";
          this.hooks.discarded(m);
        } else if (v === "defer" && m.defers < 2) {
          m.state = "done";
          m.outcome = "deferred";
          this.defer(s, m);
        } else {
          this.commit(s, m, false);
        }
      } catch (e) {
        this.hooks.appError?.(e, `applying a write to ${s.name}`);
      }
    }
  }

  private defer(s: StoreRec, m: MutationRec): void {
    const again = () => {
      if (!this.stores.has(s.name)) return;
      // Re-propose as a new proposal at the end of the queue, keeping the original intent and cause.
      const base = this.read(s);
      let preview: unknown;
      try {
        preview = m.fn ? m.fn(cloneValue(base)) : this.patched(s, m, base);
      } catch {
        preview = m.preview;
      }
      const leaves = flatten(s.name, preview, s.leaves);
      const r: MutationRec = {
        ...m,
        changes: diffLeaves(s.leaves, leaves),
        base,
        preview,
        leaves,
        defers: m.defers + 1,
        state: "queued",
        t: this.clock.now(),
      };
      delete r.verdict;
      delete r.outcome;
      this.mutations.set(r.id, r);
      if (r.changes.length === 0 || !this.gating) {
        this.commit(s, r, false);
        return;
      }
      s.queue.push(r);
      this.gateAndQueue(s, r);
    };
    this.hooks.waitRelated(m).then(again, again);
  }

  /** Value of a waiting value-write applied as a patch on top of `current`. */
  private patched(s: StoreRec, m: MutationRec, current: unknown): unknown {
    if (current === m.base) return m.preview;
    const p = patchValue(
      s.name,
      current,
      m.changes.map((c) => ({ path: c.path, after: c.after, removed: c.afterLeaf === undefined })),
    );
    return p.ok ? p.value : m.preview;
  }

  /**
   * Apply a mutation now, with its cause as the ambient op (subscribers' writes join its chain). `rethrow`: the
   * caller is the app's own set() call (errors propagate as without GenClass); otherwise errors are reported.
   */
  commit(s: StoreRec, m: MutationRec, rethrow: boolean): void {
    const current = this.read(s);
    let next: unknown;
    let leaves: Map<string, Leaf> | undefined;
    if (current === m.base) {
      next = m.preview;
      leaves = m.leaves;
    } else {
      try {
        next = m.fn ? m.fn(current) : this.patched(s, m, current);
      } catch (e) {
        if (rethrow) throw e;
        this.hooks.appError?.(e, `re-running an update of ${s.name}`);
        next = m.preview;
      }
    }
    m.state = "done";
    const changes = this.ctx.run(m.cause, () => this.write(s, next, m.cause, m, m.commit, rethrow, leaves));
    if (changes === null) {
      m.outcome = "failed";
      return;
    }
    m.outcome = "applied";
    m.appliedAt = this.clock.now();
    m.applied = changes;
  }

  /**
   * Write a value through (atom: internal; guard/adapters: commit) and record the changes. Returns null when the
   * app's setter threw (reported, or rethrown when `rethrow`).
   */
  write(
    s: StoreRec,
    next: unknown,
    writer: OpRec | null,
    m: MutationRec | null,
    commit?: (next: unknown) => void,
    rethrow = false,
    leaves?: Map<string, Leaf>,
  ): FieldChange[] | null {
    if (commit || s.io) {
      s.committing = true;
      try {
        if (commit) commit(next);
        else s.io!.set(next);
      } catch (e) {
        s.committing = false;
        if (rethrow) throw e;
        this.hooks.appError?.(e, `the setter of ${s.name}`);
        return null;
      } finally {
        s.committing = false;
      }
      const after = this.read(s);
      if (after !== next) leaves = undefined;
      next = after;
    }
    return this.record(s, next, writer, m, leaves);
  }

  /**
   * A write to an observed-only store (kind "observed": discovered React state, a store connected through the Redux
   * DevTools API). It already happened in the app, so GenClass never holds, filters, applies or reverts it: it is
   * recorded with the writer captured when the app made it (`user`: made in a user handler's task) and, like any write
   * that could not wait, decided in the background (detection only: an observed-only store offers no write actions).
   */
  observe(s: StoreRec, next: unknown, writer: OpRec | null, user: boolean): FieldChange[] {
    const leaves = flatten(s.name, next, s.leaves);
    const changes = diffLeaves(s.leaves, leaves);
    const genclass = !!writer?.genclass;
    const m: MutationRec = {
      id: ++this.mid,
      store: s.name,
      changes,
      cause: writer,
      root: writer?.root,
      t: this.clock.now(),
      base: s.value,
      preview: next,
      leaves,
      userSync: user,
      genclass,
      defers: 0,
      state: "queued",
    };
    if (changes.length) {
      this.hooks.proposed?.(m);
      const bypass = (user && !this.holdUserWrites) || genclass || s.opts.hold === false || !this.gating;
      if (!bypass) {
        try {
          this.hooks.observeWrite?.(m);
        } catch {
          /* observation never blocks a write */
        }
      }
    }
    m.state = "done";
    const applied = this.ctx.run(writer, () => this.record(s, next, writer, m, leaves));
    m.outcome = "applied";
    m.appliedAt = this.clock.now();
    m.applied = applied;
    return applied;
  }

  /** A change made outside the pipeline (guarded store changed by its owner): recorded, never held. */
  external(s: StoreRec): void {
    const v = this.read(s);
    this.record(s, v, this.ctx.op(), null);
  }

  /** Record a new value: bump field versions, logs, recent changes, emit the state event, notify subscribers. */
  record(s: StoreRec, next: unknown, writer: OpRec | null, m: MutationRec | null, precomputed?: Map<string, Leaf>): FieldChange[] {
    const leaves = precomputed ?? flatten(s.name, next, s.leaves);
    const changes = diffLeaves(s.leaves, leaves);
    const prevValue = s.value;
    s.value = next;
    s.leaves = leaves;
    if (changes.length === 0) {
      // an app's set() always notifies subscribers, as an ordinary store would (even for a mutable-style update
      // GenClass could not see); external changes were already announced by their store
      if (next !== prevValue || m) this.notify(s);
      return changes;
    }
    const t = this.clock.now();
    const seq = ++this.seq;
    if (m) m.appliedSeq = seq;
    s.version++;
    const user = m ? m.userSync : this.ctx.isUserSync(writer);
    const root = writer ? writer.root ?? writer.id : null;
    const mid = m ? m.id : 0;
    for (const c of changes) {
      let f = s.fields.get(c.path);
      if (!f) {
        f = { path: c.path, v: 0, writer: null, t, seq: 0, hist: [], log: [], born: s.version - 1 };
        s.fields.set(c.path, f);
      } else if (f.born === undefined) f.born = s.version - 1;
      f.v++;
      f.writer = writer ? writer.id : null;
      f.t = t;
      f.seq = seq;
      f.mark = undefined;
      const h: FieldHist = { v: f.v, seq, writer: f.writer, root, user, t, delta: c.delta, before: c.before, after: c.after, mutation: mid };
      if (c.beforeLeaf) h.beforeLeaf = c.beforeLeaf;
      if (c.afterLeaf) h.afterLeaf = c.afterLeaf;
      f.hist.push(h);
      if (f.hist.length > HIST) f.hist.shift();
      f.log.push({ seq, v: f.v, t, writer: f.writer, root, user, mutation: mid });
      if (f.log.length > LOG) f.log.splice(0, f.log.length - LOG);
    }
    const paths = changes.map((c) => c.path).sort();
    const key = paths.join(",") + "|" + changes.map((c) => `${c.path}=${c.delta}`).sort().join(";");
    this.recent.push({ t, seq, store: s.name, paths: paths.join(","), key, writer: writer ? writer.id : null, root, user, mutation: mid });
    while (this.recent.length > RECENT_MAX || (this.recent.length && this.recent[0].t < t - RECENT_MS)) this.recent.shift();
    const redact = this.redact();
    const summary = changes.slice(0, 3).map((c) => `${c.path}: ${changeText(c, redact)}`);
    this.events.push(t, "state", s.name, {
      ...(writer ? { op: writer.id } : {}),
      data: { store: s.name, paths, mutation: mid, user, summary },
    });
    this.hooks.applied(m, s, changes, writer);
    this.notify(s);
    return changes;
  }

  notify(s: StoreRec): void {
    for (const fn of [...s.subs]) {
      try {
        fn(s.value);
      } catch (e) {
        this.hooks.appError?.(e, `a subscriber of ${s.name}`);
      }
    }
  }

  // ------------------------------------------------------------------------------------------- late revert

  /** null when the applied write `m` can be reverted exactly, else why not. */
  revertable(m: MutationRec): string | null {
    const s = this.stores.get(m.store);
    if (!s) return "the store is gone";
    if (m.outcome !== "applied" || !m.applied || m.appliedSeq === undefined) return "the write was not applied";
    if (!s.writable) return `${m.store} cannot be written by GenClass`;
    if (!m.applied.length) return "the write changed nothing";
    for (const c of m.applied) {
      const f = s.fields.get(c.path);
      const last = f?.log[f.log.length - 1];
      if (!f || !last || last.mutation !== m.id) return `superseded: ${c.path} changed again after the write applied`;
    }
    const root = m.cause ? m.cause.root ?? m.cause.id : null;
    if (root !== null) {
      const later = this.recent.find((r) => r.seq > m.appliedSeq! && r.root === root && r.mutation !== m.id);
      if (later) return `the same operation chain wrote ${later.paths} after this write applied; reverting only this write would leave them inconsistent`;
    }
    return null;
  }

  /** Revert an applied write by restoring the values it replaced. Returns the changes made, or null if impossible. */
  revert(m: MutationRec, writer: OpRec | null): FieldChange[] | null {
    const s = this.stores.get(m.store);
    if (!s || !m.applied) return null;
    const p = patchValue(
      s.name,
      this.read(s),
      m.applied.map((c) => ({ path: c.path, after: c.before, removed: c.beforeLeaf === undefined })),
    );
    if (!p.ok) return null;
    return this.write(s, p.value, writer, null);
  }

  /** Re-apply the changes of a reverted write (undo of a late revert). */
  reapply(m: MutationRec, writer: OpRec | null): FieldChange[] | null {
    const s = this.stores.get(m.store);
    if (!s || !m.applied) return null;
    const p = patchValue(
      s.name,
      this.read(s),
      m.applied.map((c) => ({ path: c.path, after: c.after, removed: c.afterLeaf === undefined })),
    );
    if (!p.ok) return null;
    return this.write(s, p.value, writer, null);
  }

  /** Restore fields to given values (chain reverts and their undo), store by store. Returns the paths restored. */
  restoreFields(values: Map<string, { value: unknown; removed: boolean }>, writer: OpRec | null): string[] {
    const byStore = new Map<string, { path: string; after: unknown; removed: boolean }[]>();
    for (const [path, v] of values) {
      const store = path.split(".")[0];
      const list = byStore.get(store) ?? [];
      list.push({ path, after: v.value, removed: v.removed });
      byStore.set(store, list);
    }
    const done: string[] = [];
    for (const [name, list] of byStore) {
      const s = this.stores.get(name);
      if (!s || !s.writable) continue;
      const p = patchValue(name, this.read(s), list);
      if (!p.ok) continue;
      const ch = this.write(s, p.value, writer, null);
      if (ch) done.push(...ch.map((c) => c.path));
    }
    return done;
  }

  // ------------------------------------------------------------------------------------------- queries

  /**
   * A busy scalar counter: a number field that changes on nearly every write of its store (≥ 80 % of ≥ 10 writes
   * since it first changed): ticks, request counters, timestamps. Relations and transition shapes ignore it.
   */
  busy(path: string): boolean {
    const store = this.stores.get(path.split(".")[0]);
    const f = store?.fields.get(path);
    if (!store || !f || f.born === undefined) return false;
    const leaf = store.leaves.get(path);
    if (!leaf || leaf.kind !== "number") return false;
    const writes = store.version - f.born;
    return writes >= BUSY_MIN_WRITES && f.v >= BUSY_RATIO * writes;
  }

  /** Mark a field's current value as suspicious (until its next write). */
  markField(path: string, mark: StaleMark): void {
    const f = this.field(path);
    if (f) f.mark = mark;
  }

  field(path: string): FieldState | undefined {
    const store = path.split(".")[0];
    return this.stores.get(store)?.fields.get(path);
  }

  /** Version of a field at global sequence number `seq` (exact for the last 512 writes). */
  versionAt(path: string, seq: number): number {
    const f = this.field(path);
    if (!f) return 0;
    const log = f.log;
    let lo = 0;
    let hi = log.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (log[mid].seq <= seq) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (ans >= 0) return log[ans].v;
    return log.length ? log[0].v - 1 : f.v;
  }

  /** All logged writes to a field after `seq` (up to the last 512). */
  logSince(path: string, seq: number): LogEntry[] {
    const f = this.field(path);
    return f ? f.log.filter((e) => e.seq > seq) : [];
  }

  /** Rich history entries (values) of writes to a field after `seq` (the last 16 writes at most). */
  writesSince(path: string, seq: number): FieldHist[] {
    const f = this.field(path);
    return f ? f.hist.filter((h) => h.seq > seq) : [];
  }

  /** Fields of all stores changed after `seq`, with their rich history entries since then. */
  changedSince(seq: number): { path: string; hist: FieldHist[]; count: number }[] {
    const out: { path: string; hist: FieldHist[]; count: number }[] = [];
    for (const s of this.stores.values())
      for (const f of s.fields.values()) {
        if (f.seq > seq) out.push({ path: f.path, hist: f.hist.filter((h) => h.seq > seq), count: f.log.filter((e) => e.seq > seq).length });
      }
    return out;
  }

  /** Pending (held or queued) mutations across stores. */
  pending(): MutationRec[] {
    const out: MutationRec[] = [];
    for (const s of this.stores.values()) out.push(...s.queue);
    return out;
  }

  /**
   * Current values of every store, deep-cloned. A store unchanged since the last snapshot reuses its clone; for a
   * plain-object store, top-level keys whose fields did not change reuse their previous clone.
   */
  snapshot(): Map<string, unknown> {
    const m = new Map<string, unknown>();
    for (const s of this.stores.values()) {
      const ref = this.read(s);
      const c = this.snapCache.get(s.name);
      if (c && c.version === s.version && c.ref === ref) {
        m.set(s.name, c.clone);
        continue;
      }
      let clone: unknown;
      if (c && isPlainObject(ref) && isPlainObject(c.clone)) {
        const changedKeys = new Set<string>();
        for (const f of s.fields.values()) if (f.seq > c.seq) changedKeys.add(f.path.split(".")[1] ?? "");
        const prevClone = c.clone as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(ref)) out[k] = !changedKeys.has(k) && k in prevClone ? prevClone[k] : cloneValue(ref[k]);
        clone = out;
      } else clone = cloneValue(ref);
      this.snapCache.set(s.name, { version: s.version, ref, seq: this.seq, clone });
      m.set(s.name, clone);
    }
    for (const k of [...this.snapCache.keys()]) if (!this.stores.has(k)) this.snapCache.delete(k);
    return m;
  }

  /** All leaves of all stores (for the invariant miner). */
  allLeaves(): Map<string, Leaf> {
    const m = new Map<string, Leaf>();
    for (const s of this.stores.values()) for (const [p, l] of s.leaves) m.set(p, l);
    return m;
  }

  valueAt(path: string): unknown {
    const store = path.split(".")[0];
    return this.stores.get(store)?.leaves.get(path)?.value;
  }

  leaf(path: string): Leaf | undefined {
    const store = path.split(".")[0];
    return this.stores.get(store)?.leaves.get(path);
  }

  describeValue(path: string, v: unknown): string {
    return describe(v, path, this.redact());
  }
}

export function toChanges(cs: FieldChange[]): Change[] {
  return cs.map((c) => ({ path: c.path, before: c.before, after: c.after }));
}
