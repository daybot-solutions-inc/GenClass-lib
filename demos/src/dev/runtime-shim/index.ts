// DEVELOPMENT STAND-IN for @genclass/runtime, used only while packages/runtime has no build (vite.config.ts
// aliases it when packages/runtime/dist is missing or GENCLASS_SHIM=1). It implements the public API shape from
// docs/runtime/CONTRACT.md §2 with observe-only behaviour: stores work, nothing is ever held, asked or changed.
// Trial results produced with it are labelled runtime: "shim" and only count as the no-GenClass baseline.
import type {
  ActionDef,
  ActionRecord,
  AnswerOf,
  AskOptions,
  Atom,
  Decision,
  Explanation,
  InitOptions,
  Mode,
  ModelStatus,
  Op,
  Plugin,
  Question,
  RtEvent,
  Runtime,
  RuntimeEvents,
  Situation,
  StandingQuestion,
  StoreIO,
  StoreOptions,
  TriggerKind,
  UserAction,
} from "../../../../packages/runtime/src/types.ts";

export type * from "../../../../packages/runtime/src/types.ts";

export class GenClassUnavailableError extends Error {
  constructor(message = "GenClass model is not available (observe-only)") {
    super(message);
    this.name = "GenClassUnavailableError";
  }
}

type Listener<K extends keyof RuntimeEvents> = (v: RuntimeEvents[K]) => void;

class ShimRuntime implements Runtime {
  readonly ready = Promise.resolve();
  readonly status: ModelStatus = { state: "off" };
  mode: Mode;
  private listeners = new Map<string, Set<(v: unknown) => void>>();
  private events: RtEvent[] = [];
  private seq = 0;
  private stores = new Map<string, Atom<unknown>>();

  constructor(private opts: InitOptions) {
    this.mode = opts.mode ?? "guard";
  }

  private push(kind: RtEvent["kind"], name: string, data?: Record<string, unknown>) {
    const e: RtEvent = { seq: ++this.seq, t: performance.now(), kind, name, data };
    this.events.push(e);
    if (this.events.length > (this.opts.historySize ?? 500)) this.events.shift();
    this.fire("event", e);
  }

  private fire<K extends keyof RuntimeEvents>(type: K, v: RuntimeEvents[K]) {
    for (const fn of this.listeners.get(type) ?? []) fn(v);
  }

  atom<T>(name: string, initial: T, _opts?: StoreOptions<T>): Atom<T> {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    const self = this;
    const a: Atom<T> = {
      name,
      get: () => value,
      set(next) {
        const v = typeof next === "function" ? (next as (p: T) => T)(value) : next;
        if (Object.is(v, value)) return;
        value = v;
        self.push("state", name);
        for (const fn of subs) fn(value);
      },
      update(fn) {
        a.set(fn(value));
      },
      subscribe(fn) {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    };
    this.stores.set(name, a as Atom<unknown>);
    return a;
  }

  guard<T>(name: string, io: StoreIO<T>, _opts?: StoreOptions<T>): Atom<T> {
    const self = this;
    return {
      name,
      get: () => io.get(),
      set(next) {
        const v = typeof next === "function" ? (next as (p: T) => T)(io.get()) : next;
        io.set(v);
        self.push("state", name);
      },
      update(fn) {
        this.set(fn(io.get()));
      },
      subscribe(fn) {
        return io.subscribe ? io.subscribe(() => fn(io.get())) : () => {};
      },
    };
  }

  expect(_name: string, _predicate: () => boolean): () => void {
    return () => {};
  }

  ask<Q extends Question>(_q: Q, _opts?: AskOptions): Promise<AnswerOf<Q>> {
    return Promise.reject(new GenClassUnavailableError());
  }

  decide<L extends string>(_question: string, _options: Record<L, string>, _opts?: AskOptions): Promise<L> {
    return Promise.reject(new GenClassUnavailableError());
  }

  on<K extends keyof RuntimeEvents>(type: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn as (v: unknown) => void);
    return () => set!.delete(fn as (v: unknown) => void);
  }

  async op<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    this.push("op.start", name);
    try {
      return await fn();
    } finally {
      this.push("op.end", name);
    }
  }

  emit(name: string, data?: Record<string, unknown>): void {
    this.push("custom", name, data);
  }

  user<T>(action: UserAction, handler?: () => T): T | undefined {
    this.push("user", `${action.kind} ${action.target ?? ""}`.trim());
    return handler?.();
  }

  reportError(error: unknown): void {
    this.push("error", String(error));
  }

  use(plugin: Plugin): () => void {
    const off = plugin.setup?.({
      runtime: this,
      clock: { now: () => performance.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as number), afterTask: (f) => queueMicrotask(f) },
      emit: (n, d) => this.emit(n, d),
      recordOp: () => ++this.seq,
      endOp: () => {},
      runInOp: (_id, fn) => fn(),
      user: (a, h) => this.user(a, h),
      reportError: (e) => this.reportError(e),
      on: (t, f) => this.on(t, f),
      stores: { names: () => [...this.stores.keys()], get: (n) => this.stores.get(n)?.get() },
    });
    return () => {
      if (typeof off === "function") off();
    };
  }

  action(_def: ActionDef): () => void {
    return () => {};
  }

  question(_def: StandingQuestion): () => void {
    return () => {};
  }

  situation(trigger: TriggerKind = "ask"): Situation {
    return { trigger, subject: "now", state: {}, questions: {}, actions: [], salient: false, facts: [] };
  }

  explain(_id: string): Explanation | null {
    return null;
  }

  history(n = 50): RtEvent[] {
    return this.events.slice(-n);
  }

  decisions(_n?: number): Decision[] {
    return [];
  }

  interventions(_n?: number): ActionRecord[] {
    return [];
  }

  inflight(): Op[] {
    return [];
  }

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  pause(): void {}
  resume(): void {}
  destroy(): void {
    this.listeners.clear();
  }
}

let current: ShimRuntime | null = null;

export const GenClass = {
  init(options: InitOptions = {}): Runtime {
    if (!current) {
      current = new ShimRuntime(options);
      for (const p of options.plugins ?? []) current.use(p);
      console.info("[GenClass] development stand-in runtime (observe-only); the real runtime is not built yet.");
    }
    return current;
  },
  get runtime(): Runtime | null {
    return current;
  },
  destroy(): void {
    current?.destroy();
    current = null;
  },
};

export function createRuntime(options: InitOptions = {}): Runtime {
  return new ShimRuntime(options);
}
