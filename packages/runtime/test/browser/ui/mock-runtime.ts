// A scripted implementation of the public Runtime interface for the devtools screenshots and the UI/adapter
// unit tests. It is NOT the runtime: it only records calls, replays what a test tells it to emit, and models the
// documented store semantics the adapters rely on (CONTRACT §4):
//   - set(value | fn) computes the proposal against the current value;
//   - writes made synchronously inside runtime.user(...) are never held;
//   - other writes are held while `holdWrites` is on, and when applied later a functional update re-runs
//     against the value at apply time, then io.set(result) is called;
//   - a discarded (dropped) write never reaches io.set and nobody is notified.

import type {
  ActionRecord,
  AdapterHandle,
  AdapterIO,
  Answer,
  AnswerOf,
  Atom,
  Clock,
  Decision,
  EventKind,
  Explanation,
  Guarded,
  Mode,
  ModelStatus,
  Op,
  Plugin,
  PluginApi,
  Question,
  Report,
  RtEvent,
  Runtime,
  RuntimeEvents,
  Situation,
  StoreIO,
  StoreOptions,
  UserAction,
} from "../../../src/types.js";

export class MockClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    return setTimeout(fn, ms);
  }
  clearTimeout(h: unknown): void {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  }
  afterTask(fn: () => void): void {
    setTimeout(fn, 0);
  }
}

interface Held {
  store: string;
  run(): void;
}

export class MockRuntime implements Runtime {
  readonly clock = new MockClock();
  readonly ready: Promise<void> = Promise.resolve();
  status: ModelStatus = { state: "off" };
  mode: Mode = "guard";
  events: RtEvent[] = [];
  decs: Decision[] = [];
  acts: ActionRecord[] = [];
  explanations = new Map<string, Explanation>();
  sit: Situation | null = null;
  ops: Op[] = [];
  plugins: Plugin[] = [];
  /** Hold every write made outside a synchronous user handler until flushHeld()/dropHeld(). */
  holdWrites = false;
  readonly calls = { setMode: [] as Mode[], situation: 0, explain: [] as string[], sets: [] as string[] };

  private heldQ: Held[] = [];
  private subsByStore = new Map<string, Set<unknown>>();
  private writers = new Map<string, (v: unknown) => void>();
  private listeners = new Map<string, Set<(v: unknown) => void>>();
  private seq = 0;
  private opSeq = 0;
  private inUser = 0;

  // ---------------------------------------------------------------------------------------- controls

  emitTo<K extends keyof RuntimeEvents>(type: K, v: RuntimeEvents[K]): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(v);
  }

  setStatus(s: ModelStatus): void {
    this.status = s;
    this.emitTo("status", s);
  }

  event(kind: EventKind, name: string, extra: { t?: number; op?: number; cause?: number; data?: Record<string, unknown> } = {}): RtEvent {
    const e: RtEvent = { seq: ++this.seq, t: extra.t ?? this.clock.t, kind, name };
    if (extra.op !== undefined) e.op = extra.op;
    if (extra.cause !== undefined) e.cause = extra.cause;
    if (extra.data !== undefined) e.data = extra.data;
    this.events.push(e);
    this.emitTo("event", e);
    return e;
  }

  /** Record a decision; emits decide, and detect when the diagnosis is reportable. */
  decision(d: Decision): Decision {
    this.decs.push(d);
    this.emitTo("decide", d);
    const p = d.diagnosisProbabilities?.[d.diagnosis] ?? d.diagnosisConfidence;
    if (d.diagnosis !== "expected" && p >= 0.6) this.emitTo("detect", d);
    return d;
  }

  act(a: ActionRecord): ActionRecord {
    this.acts.push(a);
    this.emitTo("act", a);
    return a;
  }

  report(r: Report): void {
    this.emitTo("report", r);
  }

  get heldCount(): number {
    return this.heldQ.length;
  }

  /** Apply held writes in proposal order (functional updates re-run against the value at apply time). */
  flushHeld(): void {
    const q = this.heldQ;
    this.heldQ = [];
    for (const h of q) h.run();
  }

  /** Discard held writes (the `discard` action): nothing is applied, nobody is notified. */
  dropHeld(): void {
    this.heldQ = [];
  }

  listenerCount(type: keyof RuntimeEvents): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** A write GenClass itself makes (rollback, resync): goes straight to the store's io.set. */
  genclassWrite(store: string, v: unknown): void {
    const w = this.writers.get(store);
    if (!w) throw new Error(`store ${store} cannot be written by GenClass`);
    w(v);
  }

  /** Current subscribers of a store's atom/guard handle. */
  subscribers(store: string): number {
    return this.subsByStore.get(store)?.size ?? 0;
  }

  // ------------------------------------------------------------------------------------- Runtime API

  on<K extends keyof RuntimeEvents>(type: K, fn: (v: RuntimeEvents[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    const f = fn as (v: unknown) => void;
    set.add(f);
    return () => {
      set.delete(f);
    };
  }

  atom<T>(name: string, initial: T, opts?: StoreOptions<T>): Atom<T> {
    let v = initial;
    return this.guard(name, { get: () => v, set: (x) => void (v = x) }, opts);
  }

  guard<T>(name: string, io: StoreIO<T>, opts: StoreOptions<T> = {}): Guarded<T> {
    this.writers.set(name, io.set as (v: unknown) => void);
    const subs = new Set<(v: T) => void>();
    this.subsByStore.set(name, subs as Set<unknown>);
    let last = io.get();
    const notify = (): void => {
      const v = io.get();
      if (Object.is(v, last)) return;
      last = v;
      for (const fn of [...subs]) fn(v);
    };
    io.subscribe?.(notify);
    const resolve = (next: T | ((p: T) => T)): T => (typeof next === "function" ? (next as (p: T) => T)(io.get()) : next);
    const apply = (v: T): void => {
      io.set(v);
      this.event("state", name, { data: { store: name } });
      notify();
    };
    const set = (next: T | ((p: T) => T)): void => {
      this.calls.sets.push(name);
      const proposal = resolve(next);
      if (Object.is(proposal, io.get())) return;
      if (this.holdWrites && this.inUser === 0 && opts.hold !== false) {
        this.heldQ.push({ store: name, run: () => apply(resolve(next)) });
        return;
      }
      apply(proposal);
    };
    return {
      name,
      get: () => io.get(),
      set,
      update: (fn) => set(fn),
      subscribe: (fn) => {
        subs.add(fn);
        return () => {
          subs.delete(fn);
        };
      },
    };
  }

  adapter<T>(name: string, io: AdapterIO<T>, opts: StoreOptions<T> = {}): AdapterHandle<T> {
    if (io.set) this.writers.set(name, io.set as (v: unknown) => void);
    return {
      name,
      propose: (w) => {
        this.calls.sets.push(name);
        const resolve = (): T => (w.fn ? w.fn(io.get()) : (w.value as T));
        const apply = (v: T): void => {
          const before = io.get();
          w.commit(v);
          if (!Object.is(io.get(), before)) this.event("state", name, { data: { store: name } });
        };
        const proposal = resolve();
        if (!Object.is(proposal, io.get()) && this.holdWrites && this.inUser === 0 && opts.hold !== false) {
          this.heldQ.push({ store: name, run: () => apply(resolve()) });
          return;
        }
        apply(proposal);
      },
      dispose: () => {
        this.writers.delete(name);
      },
    };
  }

  expect(): () => void {
    return () => {};
  }

  ask<Q extends Question>(_q: Q): Promise<AnswerOf<Q>> {
    return Promise.reject(new Error("mock runtime: no model"));
  }

  decide<L extends string>(_question: string, options: Record<L, string>): Promise<L> {
    return Promise.resolve(Object.keys(options)[0] as L);
  }

  async op<T>(_name: string, fn: () => Promise<T> | T): Promise<T> {
    return fn();
  }

  emit(name: string, data?: Record<string, unknown>): void {
    this.event("custom", name, { data });
  }

  user<T>(action: UserAction, handler?: () => T): T | undefined {
    const id = ++this.opSeq;
    this.event("user", `${action.kind}${action.target ? ` ${action.target}` : ""}`, { op: id, data: action.value ? { value: action.value } : undefined });
    this.inUser++;
    try {
      return handler?.();
    } finally {
      this.inUser--;
    }
  }

  reportError(error: unknown, info?: { source?: string }): void {
    const e = error as { name?: string; message?: string };
    this.event("error", e?.name ?? "Error", { data: { message: String(e?.message ?? error), source: info?.source } });
  }

  use(plugin: Plugin): () => void {
    this.plugins.push(plugin);
    const api: PluginApi = {
      runtime: this,
      clock: this.clock,
      emit: (n, d) => this.emit(n, d),
      recordOp: () => ++this.opSeq,
      endOp: () => {},
      runInOp: (_id, fn) => fn(),
      user: (a, h) => this.user(a, h),
      reportError: (e, i) => this.reportError(e, i),
      on: (t, f) => this.on(t, f),
      stores: { names: () => [], get: () => undefined },
    };
    const dispose = plugin.setup?.(api);
    return () => {
      this.plugins = this.plugins.filter((p) => p !== plugin);
      if (typeof dispose === "function") dispose();
    };
  }

  action(): () => void {
    return () => {};
  }

  question(): () => void {
    return () => {};
  }

  situation(): Situation {
    this.calls.situation++;
    if (!this.sit) throw new Error("no situation scripted");
    return this.sit;
  }

  explain(id: string): Explanation | null {
    this.calls.explain.push(id);
    return this.explanations.get(id) ?? null;
  }

  history(n = 500): RtEvent[] {
    return this.events.slice(-n);
  }

  decisions(n = 200): Decision[] {
    return this.decs.slice(-n);
  }

  interventions(n = 200): ActionRecord[] {
    return this.acts.slice(-n);
  }

  inflight(): Op[] {
    return this.ops;
  }

  holdBudgetMs(): number {
    return 300;
  }

  situationBudget(): number {
    return 3200;
  }

  setMode(m: Mode): void {
    this.calls.setMode.push(m);
    this.mode = m;
  }

  pause(): void {}
  resume(): void {}
  destroy(): void {
    this.listeners.clear();
  }
}

// ------------------------------------------------------------------------------------------- builders

let dn = 0;
let an = 0;

export function choice(probs: Record<string, number>): Answer {
  const entries = Object.entries(probs);
  const [top, p] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  const k = entries.length;
  return { type: "choice", choice: top, confidence: k > 1 ? (k * p - 1) / (k - 1) : 1, probabilities: probs };
}

export function makeDecision(p: Partial<Decision> & { diagnosisProbabilities: Record<string, number>; probabilities: Record<string, number> }): Decision {
  const dx = choice(p.diagnosisProbabilities) as Extract<Answer, { type: "choice" }>;
  const ax = choice(p.probabilities) as Extract<Answer, { type: "choice" }>;
  const action = p.action ?? ax.choice;
  return {
    id: p.id ?? `d${++dn}`,
    trigger: p.trigger ?? "mutation",
    subject: p.subject ?? "",
    at: p.at ?? 0,
    latencyMs: p.latencyMs ?? 31,
    model: p.model ?? "genclass-runtime-0.1",
    diagnosis: p.diagnosis ?? dx.choice,
    diagnosisConfidence: p.diagnosisConfidence ?? dx.confidence,
    diagnosisProbabilities: p.diagnosisProbabilities,
    action,
    confidence: p.confidence ?? p.probabilities[action] ?? 0,
    probabilities: p.probabilities,
    executed: p.executed ?? false,
    reason: p.reason,
    facts: p.facts ?? [],
    tier: p.tier ?? "passive",
    ran: p.ran ?? action,
    answers: p.answers ?? { diagnosis: dx, action: ax },
  };
}

export function makeAction(d: Decision, p: Partial<ActionRecord> = {}): ActionRecord {
  return {
    id: p.id ?? `a${++an}`,
    decisionId: d.id,
    action: p.action ?? d.action,
    tier: p.tier ?? d.tier,
    trigger: p.trigger ?? d.trigger,
    subject: p.subject ?? d.subject,
    at: p.at ?? d.at + 1,
    ok: p.ok ?? true,
    error: p.error,
    changed: p.changed ?? "",
    undo: p.undo,
  };
}
