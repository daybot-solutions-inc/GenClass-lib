// StoreHub (CONTRACT §4): registered stores, per-field versions with short histories, the mutation pipeline
// (propose -> gate -> hold -> apply in proposal order per store), recent changes for repetition facts.
//
// Apply semantics of a write that waited (held, or queued behind a held write):
//   - functional updates re-run against the value at apply time;
//   - value writes are re-applied as a patch of the fields they changed (so a user's newer input to another
//     field of the same store survives); if the store value did not change meanwhile, the value is used as is.
// User-sync writes (inside a user handler's task) and GenClass action writes bypass the queue and never wait.

import type { Clock, Change, StoreIO, StoreOptions } from "../types.js";
import type { Context } from "../trace/context.js";
import type { EventLog } from "../trace/events.js";
import type { OpRec } from "../trace/ops.js";
import { describe, type Redactor } from "../util.js";
import { cloneValue, diffLeaves, flatten, leafOf, patchValue, type FieldChange, type Leaf } from "./fields.js";

const HIST = 16;
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
  mutation: number;
}

export interface FieldState {
  path: string;
  v: number;
  writer: number | null;
  t: number;
  seq: number;
  hist: FieldHist[];
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
  fn?: (prev: unknown) => unknown;
  /** Custom commit (guard io.set, redux dispatch, zustand set). Receives the computed next value. */
  commit?: (next: unknown) => void;
  userSync: boolean;
  genclass: boolean;
  defers: number;
  state: "queued" | "held" | "resolved" | "done";
  verdict?: Verdict;
  /** Set when the write was applied or dropped. */
  outcome?: "applied" | "discarded" | "deferred";
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
  kind: "atom" | "guard" | "adapter";
  /** GenClass can write it directly (rollback); false for adapter stores without a setter. */
  writable: boolean;
}

export interface HubHooks {
  gate(m: MutationRec): GateResult;
  /** Resolves when the in-flight ops related to a deferred write have settled. */
  waitRelated(m: MutationRec): Promise<void>;
  applied(m: MutationRec | null, store: StoreRec, changes: FieldChange[], writer: OpRec | null): void;
  discarded(m: MutationRec): void;
  proposed?(m: MutationRec): void;
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
  /** When false (paused / destroyed) every write applies immediately. */
  gating = true;

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
      writable: kind !== "adapter" || typeof io?.set === "function",
    };
    if (io) s.io = io;
    for (const path of s.leaves.keys()) s.fields.set(path, { path, v: 0, writer: null, t: this.clock.now(), seq: this.seq, hist: [] });
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
    let preview: unknown;
    try {
      preview = w.fn ? w.fn(base) : w.value;
    } catch (e) {
      throw e; // errors in updater functions surface to the caller, as without GenClass
    }
    const changes = diffLeaves(s.leaves, flatten(s.name, preview));
    const m: MutationRec = {
      id: ++this.mid,
      store: s.name,
      changes,
      cause,
      root: cause?.root,
      t: this.clock.now(),
      base,
      preview,
      userSync: this.ctx.isUserSync(cause),
      genclass: !!cause?.genclass,
      defers: 0,
      state: "queued",
    };
    if (w.fn) m.fn = w.fn;
    if (w.commit) m.commit = w.commit;
    this.hooks.proposed?.(m);
    // Writes that never wait: no-ops, user-sync writes, GenClass writes, non-holdable stores, gating off.
    const bypass =
      changes.length === 0 ||
      (m.userSync && !this.holdUserWrites) ||
      m.genclass ||
      s.opts.hold === false ||
      !this.gating;
    if (bypass) {
      this.commit(s, m);
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

  /** Apply/drop resolved writes at the head of the store's queue, in proposal order. */
  private drain(s: StoreRec): void {
    while (s.queue.length && s.queue[0].state === "resolved") {
      const m = s.queue.shift()!;
      const v = m.verdict ?? "apply";
      if (v === "discard") {
        m.state = "done";
        m.outcome = "discarded";
        this.hooks.discarded(m);
      } else if (v === "defer" && m.defers < 2) {
        m.state = "done";
        m.outcome = "deferred";
        this.defer(s, m);
      } else {
        this.commit(s, m);
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
        preview = m.fn ? m.fn(base) : this.patched(s, m, base);
      } catch {
        preview = m.preview;
      }
      const r: MutationRec = {
        ...m,
        changes: diffLeaves(s.leaves, flatten(s.name, preview)),
        base,
        preview,
        defers: m.defers + 1,
        state: "queued",
        t: this.clock.now(),
      };
      delete r.verdict;
      delete r.outcome;
      this.mutations.set(r.id, r);
      if (r.changes.length === 0 || !this.gating) {
        this.commit(s, r);
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

  /** Apply a mutation now. */
  commit(s: StoreRec, m: MutationRec): void {
    const current = this.read(s);
    let next: unknown;
    try {
      next = m.fn ? (current === m.base ? m.preview : m.fn(current)) : this.patched(s, m, current);
    } catch {
      next = m.preview;
    }
    m.state = "done";
    m.outcome = "applied";
    this.write(s, next, m.cause, m, m.commit);
  }

  /** Write a value through (atom: internal; guard/adapters: commit) and record the changes. */
  write(s: StoreRec, next: unknown, writer: OpRec | null, m: MutationRec | null, commit?: (next: unknown) => void): FieldChange[] {
    if (commit || s.io) {
      s.committing = true;
      try {
        if (commit) commit(next);
        else s.io!.set(next);
      } finally {
        s.committing = false;
      }
      next = this.read(s);
    }
    return this.record(s, next, writer, m);
  }

  /** A change made outside the pipeline (guarded store changed by its owner): recorded, never held. */
  external(s: StoreRec): void {
    const v = this.read(s);
    this.record(s, v, this.ctx.op(), null);
  }

  /** Record a new value: bump field versions, recent changes, emit the state event, notify subscribers. */
  record(s: StoreRec, next: unknown, writer: OpRec | null, m: MutationRec | null): FieldChange[] {
    const leaves = flatten(s.name, next);
    const changes = diffLeaves(s.leaves, leaves);
    s.value = next;
    s.leaves = leaves;
    if (changes.length === 0) {
      this.notify(s);
      return changes;
    }
    const t = this.clock.now();
    const seq = ++this.seq;
    s.version++;
    const user = m ? m.userSync : this.ctx.isUserSync(writer);
    const root = writer ? writer.root ?? writer.id : null;
    for (const c of changes) {
      let f = s.fields.get(c.path);
      if (!f) {
        f = { path: c.path, v: 0, writer: null, t, seq: 0, hist: [] };
        s.fields.set(c.path, f);
      }
      f.v++;
      f.writer = writer ? writer.id : null;
      f.t = t;
      f.seq = seq;
      f.hist.push({ v: f.v, seq, writer: f.writer, root, user, t, delta: c.delta, before: c.before, after: c.after, mutation: m ? m.id : 0 });
      if (f.hist.length > HIST) f.hist.shift();
    }
    const paths = changes.map((c) => c.path).sort();
    const key = paths.join(",") + "|" + changes.map((c) => `${c.path}=${c.delta}`).sort().join(";");
    this.recent.push({ t, seq, store: s.name, paths: paths.join(","), key, writer: writer ? writer.id : null, root, user, mutation: m ? m.id : 0 });
    while (this.recent.length > RECENT_MAX || (this.recent.length && this.recent[0].t < t - RECENT_MS)) this.recent.shift();
    const redact = this.redact();
    const summary = changes.slice(0, 3).map((c) => `${c.path}: ${changeText(c, redact)}`);
    this.events.push(t, "state", s.name, {
      ...(writer ? { op: writer.id } : {}),
      data: { store: s.name, paths, mutation: m ? m.id : 0, user, summary },
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
        // subscriber errors are app errors: rethrow asynchronously so they are not swallowed
        this.clock.setTimeout(() => {
          throw e;
        }, 0);
      }
    }
  }

  // ------------------------------------------------------------------------------------------- queries

  field(path: string): FieldState | undefined {
    const store = path.split(".")[0];
    return this.stores.get(store)?.fields.get(path);
  }

  /** Version of a field at global sequence number `seq` (its value as of an op's start). */
  versionAt(path: string, seq: number): number {
    const f = this.field(path);
    if (!f) return 0;
    for (let i = f.hist.length - 1; i >= 0; i--) if (f.hist[i].seq <= seq) return f.hist[i].v;
    return f.hist.length ? f.hist[0].v - 1 : f.v;
  }

  /** Writes to a field after global sequence number `seq`. */
  writesSince(path: string, seq: number): FieldHist[] {
    const f = this.field(path);
    return f ? f.hist.filter((h) => h.seq > seq) : [];
  }

  /** Fields of all stores changed after `seq`. */
  changedSince(seq: number): { path: string; hist: FieldHist[] }[] {
    const out: { path: string; hist: FieldHist[] }[] = [];
    for (const s of this.stores.values())
      for (const f of s.fields.values()) {
        if (f.seq > seq) out.push({ path: f.path, hist: f.hist.filter((h) => h.seq > seq) });
      }
    return out;
  }

  /** Pending (held or queued) mutations across stores. */
  pending(): MutationRec[] {
    const out: MutationRec[] = [];
    for (const s of this.stores.values()) out.push(...s.queue);
    return out;
  }

  private snapCache = new Map<string, { version: number; value: unknown }>();

  /** Current values of every store, deep-cloned (stores unchanged since the last snapshot reuse their clone). */
  snapshot(): Map<string, unknown> {
    const m = new Map<string, unknown>();
    for (const s of this.stores.values()) {
      const c = this.snapCache.get(s.name);
      if (c && c.version === s.version && s.kind === "atom") {
        m.set(s.name, c.value);
        continue;
      }
      const v = cloneValue(this.read(s));
      this.snapCache.set(s.name, { version: s.version, value: v });
      m.set(s.name, v);
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

export function changeText(c: Pick<FieldChange, "before" | "after" | "path"> & { beforeLeaf?: Leaf; afterLeaf?: Leaf }, redact: Redactor): string {
  const b = c.beforeLeaf ?? leafOf(c.before);
  const a = c.afterLeaf ?? leafOf(c.after);
  if (a.kind === "array" && b.kind === "array" && a.elems && b.elems) {
    const full = `${describe(c.before, c.path, redact, 44)} → ${describe(c.after, c.path, redact, 44)}`;
    if (full.length <= 70) return full;
    const ba = c.before as unknown[];
    const aa = c.after as unknown[];
    // element-level diff (multiset by hash), elements described individually
    const count = new Map<string, number>();
    for (const h of b.elems) count.set(h, (count.get(h) ?? 0) + 1);
    const added: unknown[] = [];
    a.elems.forEach((h, i) => {
      const n = count.get(h) ?? 0;
      if (n > 0) count.set(h, n - 1);
      else added.push(aa[i]);
    });
    const removed: unknown[] = [];
    const left = new Map(count);
    b.elems.forEach((h, i) => {
      const n = left.get(h) ?? 0;
      if (n > 0) {
        left.set(h, n - 1);
        removed.push(ba[i]);
      }
    });
    const el = (v: unknown) => describe(v, c.path, redact, 48);
    if (!added.length && !removed.length) return `${a.len} items, reordered`;
    if (added.length && added.length === removed.length && a.len === b.len)
      return `${a.len} items, ${added.length} changed: ${el(removed[0])} → ${el(added[0])}${added.length > 1 ? ", …" : ""}`;
    const parts: string[] = [];
    if (added.length) parts.push(`added ${el(added[0])}${added.length > 1 ? ` and ${added.length - 1} more` : ""}`);
    if (removed.length) parts.push(`removed ${el(removed[0])}${removed.length > 1 ? ` and ${removed.length - 1} more` : ""}`);
    return `${b.len} → ${a.len} items: ${parts.join("; ")}`;
  }
  return `${describe(c.before, c.path, redact, 36)} → ${describe(c.after, c.path, redact, 36)}`;
}

export function toChanges(cs: FieldChange[]): Change[] {
  return cs.map((c) => ({ path: c.path, before: c.before, after: c.after }));
}
