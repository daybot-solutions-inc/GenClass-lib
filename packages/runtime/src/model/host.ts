// ModelHost: the DecisionProvider backed by the local GenClass model. Inference runs in a module Worker by default
// (`new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`, the pattern Vite and webpack bundle)
// and falls back to running inline on the main thread when the Worker cannot be created or never comes up.
//
// - Preload: "eager" starts at creation, "idle" (default) after the page load event when the browser is idle
//   (requestIdleCallback, 2 s timeout), "lazy" on the first ready()/evaluate()/load().
// - evaluate() never waits for the model: while it is not ready the call rejects at once with ModelNotReadyError
//   (the runtime then fails open and runs the passive action).
// - One inference at a time; queued requests run by priority (higher first, FIFO within a priority); every request
//   has a timeout (also while queued) and a full queue evicts the lowest-priority, oldest request.

import { browserClock } from "../clock.js";
import type { Answer, Clock, DecisionProvider, EvaluateRequest, ModelOptions } from "../types.js";
import type { BackendLoadOptions, LatencyStats, ModelBackend, ModelHostStatus, OrtBuild } from "./backend.js";
import type { OrtLike } from "./engine.js";
import {
  ModelBusyError,
  ModelDisposedError,
  ModelInputError,
  ModelLoadError,
  ModelNotReadyError,
  ModelTimeoutError,
  deserializeError,
  errorMessage,
  serializeError,
} from "./errors.js";
import { blockedFetch, violationOf, type CspViolation } from "./blocked.js";
import type { DevicePreference, GpuInfo } from "./loader.js";
import type { EvaluateOk, FromWorker, ToWorker } from "./protocol.js";
import { toJsonValue } from "./serialize.js";

export type { ModelHostStatus } from "./backend.js";
export type { EvaluateOk } from "./protocol.js";

/** Where the runtime model is published (the @genclass/runtime-model npm package on jsDelivr). */
export const DEFAULT_MODEL_BASE_URL = "https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.2.0/files/";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_QUEUE = 32;
const HELLO_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 2_000;
const LOAD_EVENT_WAIT_MS = 5_000;
/** A loading worker that sends nothing for this long is considered stuck (e.g. inside a broken WebGPU driver). */
const LOAD_STALL_MS = 180_000;
/** status.latency covers this many recent evaluations; listeners hear about changes at most every LATENCY_EMIT_MS. */
const LATENCY_WINDOW = 20;
const LATENCY_EMIT_MS = 5_000;

/** Minimal Worker surface the host uses (tests pass a fake). */
export interface WorkerLike {
  postMessage(m: ToWorker): void;
  terminate(): void;
  addEventListener(type: "message", fn: (ev: { data: FromWorker }) => void): void;
  addEventListener(type: "error" | "messageerror", fn: (ev: unknown) => void): void;
}

export interface ModelHostOptions extends ModelOptions {
  /** Native fetch for the inline fallback (the runtime passes the one it captured before instrumenting). */
  fetch?: typeof fetch;
  /** Timers for preload scheduling and timeouts (default: the real clock). */
  clock?: Clock;
  /** Default per-request timeout, also while queued. Default 10 s. */
  timeoutMs?: number;
  /** Most requests waiting behind the running one. Default 32. */
  maxQueue?: number;
  /** Skip the warm-up pass at load (tests). */
  warmup?: boolean;
  /** WASM threads cap when crossOriginIsolated (default 4). */
  maxThreads?: number;
  /** Tests: create the worker (return null to force the inline path). */
  workerFactory?: () => WorkerLike | null;
  /** Inline path: how to load onnxruntime-web (default: dynamic import of onnxruntime-web/webgpu or /wasm). */
  ortLoader?: (build: OrtBuild) => Promise<OrtLike>;
  /** Inline path: WebGPU probe override (tests). */
  probeGpu?: () => Promise<GpuInfo>;
  /** Worker startup budget before falling back inline. Default 15 s. */
  helloTimeoutMs?: number;
  /** A loading worker silent for this long is treated as stuck (retried once on WASM). Default 180 s. */
  loadStallMs?: number;
}

export type ModelEvaluateRequest = EvaluateRequest & { timeoutMs?: number };

export interface ModelHostStats {
  requests: number;
  completed: number;
  failed: number;
  timeouts: number;
  busy: number;
  notReady: number;
  /** Wall time of the last completed request (queue wait included). */
  lastMs?: number;
  /** Forward-pass time of the last completed request. */
  lastForwardMs?: number;
}

export interface ModelHost extends DecisionProvider {
  readonly status: ModelHostStatus;
  readonly stats: Readonly<ModelHostStats>;
  ready(): Promise<void>;
  /** Starts loading now (any preload mode); after a failed load it tries again. */
  load(): Promise<void>;
  evaluate(req: ModelEvaluateRequest): Promise<Record<string, Answer>>;
  /** Like evaluate, with the model id, token usage and timings. */
  evaluateDetailed(req: ModelEvaluateRequest): Promise<EvaluateOk>;
  /** Token counts of a state (and questions) with the loaded tokenizer: stateTokens, positions needed, total. */
  measure(state: unknown, questions?: unknown): Promise<{ stateTokens: number; positions: number; total: number }>;
  onStatus(fn: (s: ModelHostStatus) => void): () => void;
  dispose(): void;
}

// ------------------------------------------------------------------------------------------- transports

interface Transport {
  readonly inWorker: boolean;
  send(m: ToWorker): void;
  close(): void;
}

class InlineTransport implements Transport {
  readonly inWorker = false;
  /**
   * The backend (tokenizer, packer, engine, loader) is imported on first use: the inline path is the rare fallback
   * (no Worker), so this code stays out of the app's first-load bundle (it ships in the worker chunk anyway).
   */
  private readonly backend: Promise<ModelBackend>;
  private closed = false;

  constructor(
    private readonly onMessage: (m: FromWorker) => void,
    env: { fetch: typeof fetch; clock: Clock; ort: (build: OrtBuild) => Promise<OrtLike>; probeGpu?: () => Promise<GpuInfo> },
  ) {
    let cachesRef: CacheStorage | null = null;
    try {
      cachesRef = (globalThis as { caches?: CacheStorage }).caches ?? null;
    } catch {
      cachesRef = null;
    }
    this.backend = import("./backend.js").then(
      (m) =>
        new m.ModelBackend({
          ort: env.ort,
          fetch: env.fetch,
          caches: cachesRef,
          clock: env.clock,
          emit: (status) => this.deliver({ type: "status", status }),
          inWorker: false,
          ...(env.probeGpu ? { probeGpu: env.probeGpu } : {}),
        }),
    );
    this.backend.catch((e: unknown) => this.deliver({ type: "status", status: { state: "error", error: `could not load the model code: ${errorMessage(e)}`, worker: false } }));
  }

  private deliver(m: FromWorker): void {
    if (!this.closed) this.onMessage(m);
  }

  send(m: ToWorker): void {
    // Asynchronous like postMessage, so callers never re-enter the host synchronously.
    this.backend.then(
      (backend) => {
        if (this.closed) return;
        switch (m.type) {
          case "load":
            backend.load(m.options).catch(() => undefined);
            break;
          case "evaluate":
            backend.evaluate(m.state, m.questions).then(
              (r) => this.deliver({ type: "result", id: m.id, ok: true, value: { answers: r.answers, model: r.model, usage: r.usage, timings: r.timings } }),
              (e) => this.deliver({ type: "result", id: m.id, ok: false, error: serializeError(e) }),
            );
            break;
          case "measure":
            try {
              this.deliver({ type: "result", id: m.id, ok: true, value: backend.measure(m.state, m.questions) });
            } catch (e) {
              this.deliver({ type: "result", id: m.id, ok: false, error: serializeError(e) });
            }
            break;
          case "dispose":
            this.close();
            break;
        }
      },
      (e: unknown) => {
        if ((m.type === "evaluate" || m.type === "measure") && !this.closed) this.deliver({ type: "result", id: m.id, ok: false, error: serializeError(e) });
      },
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.backend.then((b) => b.dispose(), () => undefined);
  }
}

class WorkerTransport implements Transport {
  readonly inWorker = true;
  constructor(private readonly worker: WorkerLike) {}
  send(m: ToWorker): void {
    this.worker.postMessage(m);
  }
  close(): void {
    try {
      this.worker.postMessage({ type: "dispose" });
    } catch {
      // already gone
    }
    this.worker.terminate();
  }
}

function defaultWorkerFactory(): WorkerLike | null {
  if (typeof Worker === "undefined") return null;
  return new Worker(new URL("./worker.js", import.meta.url), { type: "module" }) as unknown as WorkerLike;
}

/** Both specifiers are static strings so bundlers split them; only the one the plans need is loaded. */
const defaultOrtLoader = async (build: OrtBuild): Promise<OrtLike> =>
  (build === "webgpu" ? await import("onnxruntime-web/webgpu") : await import("onnxruntime-web/wasm")) as unknown as OrtLike;

// ------------------------------------------------------------------------------------------------- host

interface Job {
  id: number;
  seq: number;
  priority: number;
  state: unknown;
  questions: unknown;
  t0: number;
  timer: unknown;
  settled: boolean;
  resolve: (v: EvaluateOk) => void;
  reject: (e: Error) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class Host implements ModelHost {
  private st: ModelHostStatus = { state: "off" };
  private readonly listeners = new Set<(s: ModelHostStatus) => void>();
  private transport: Transport | null = null;
  private started = false;
  private disposed = false;
  private hello = false;
  private workerError: string | null = null;
  private wasmRetried = false;
  private priorAttempts: NonNullable<ModelHostStatus["attempts"]> = [];
  private stallTimer: unknown = null;
  private activeOptions!: BackendLoadOptions;
  private readonly lat: { ms: number; tokens: number }[] = [];
  private lastLatencyEmit = -Infinity;
  private helloTimer: unknown = null;
  private idleCancel: (() => void) | null = null;
  private readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private nextId = 1;
  private seq = 0;
  private queue: Job[] = [];
  private running: Job | null = null;
  private readonly measures = new Map<number, Pending>();
  private readonly clock: Clock;
  private readonly loadOptions: BackendLoadOptions;
  private readonly st0: ModelHostStats = { requests: 0, completed: 0, failed: 0, timeouts: 0, busy: 0, notReady: 0 };
  /** CSP violations seen while loading (page and worker), for status.blocked. */
  private readonly violations: CspViolation[] = [];
  private cspOff: (() => void) | null = null;

  constructor(private readonly opts: ModelHostOptions) {
    this.clock = opts.clock ?? browserClock;
    this.loadOptions = {
      baseUrl: resolveBaseUrl(opts.baseUrl ?? DEFAULT_MODEL_BASE_URL),
      device: (opts.device ?? "auto") as DevicePreference,
      ...(opts.ortWasmPaths ? { ortWasmPaths: resolveBaseUrl(opts.ortWasmPaths) } : {}),
      ...(opts.cacheName ? { cacheName: opts.cacheName } : {}),
      ...(opts.warmup === false ? { warmup: false } : {}),
      ...(opts.maxThreads ? { maxThreads: opts.maxThreads } : {}),
    };
    const preload = opts.preload ?? "idle";
    if (preload === "eager") this.start();
    else if (preload === "idle") this.idleCancel = scheduleIdle(() => this.start(), this.clock);
  }

  get status(): ModelHostStatus {
    return this.st;
  }

  get stats(): Readonly<ModelHostStats> {
    return this.st0;
  }

  onStatus(fn: (s: ModelHostStatus) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    const s = this.st;
    for (const fn of [...this.listeners]) {
      try {
        fn(s);
      } catch {
        // listeners never break the host
      }
    }
  }

  private setStatus(s: ModelHostStatus): void {
    if (s.state === "error" && !s.blocked) {
      const b = blockedFetch(s.error, this.violations, pageOrigin());
      if (b) s = { ...s, blocked: b };
    }
    if (s.state === "ready") this.stopCspWatch();
    this.st = s;
    this.notify();
    if (s.state === "ready") this.settleReady(null);
    else if (s.state === "error") this.settleReady(new ModelLoadError(s.error ?? "the GenClass model failed to load", s.attempts ?? []));
  }

  private settleReady(err: Error | null): void {
    const w = this.readyWaiters;
    this.readyWaiters = [];
    for (const x of w) err ? x.reject(err) : x.resolve();
  }

  // -------------------------------------------------------------------------------------- loading

  /** The page's securitypolicyviolation events while the model loads (inline downloads, a blocked worker). */
  private watchCsp(): void {
    if (this.cspOff) return;
    const d = (globalThis as { document?: { addEventListener?: (t: string, f: (e: unknown) => void) => void; removeEventListener?: (t: string, f: (e: unknown) => void) => void } }).document;
    if (!d?.addEventListener) return;
    const fn = (ev: unknown) => {
      const v = violationOf(ev);
      if (v && this.violations.length < 16) this.violations.push(v);
    };
    d.addEventListener("securitypolicyviolation", fn);
    this.cspOff = () => d.removeEventListener?.("securitypolicyviolation", fn);
  }

  private stopCspWatch(): void {
    this.cspOff?.();
    this.cspOff = null;
  }

  /** Creates the transport (worker, else inline) and starts the load. */
  private start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.idleCancel?.();
    this.idleCancel = null;
    this.watchCsp();
    if (this.opts.worker !== false) {
      let w: WorkerLike | null = null;
      try {
        w = (this.opts.workerFactory ?? defaultWorkerFactory)();
      } catch {
        w = null; // CSP, file://, bundler without worker support...
      }
      if (w) {
        this.useWorker(w);
        return;
      }
    }
    this.useInline();
  }

  private useWorker(w: WorkerLike, options: BackendLoadOptions = this.loadOptions): void {
    const t = new WorkerTransport(w);
    this.transport = t;
    this.activeOptions = options;
    this.lat.length = 0;
    this.hello = false;
    w.addEventListener("message", (ev) => {
      if (this.transport === t) this.onMessage(ev.data);
    });
    const failEarly = (why: string) => {
      if (this.transport !== t) return;
      if (!this.hello) {
        // The worker never came up: run inline instead.
        this.clock.clearTimeout(this.helloTimer);
        t.close();
        this.useInline(why, options);
        return;
      }
      // Died while setting up WebGPU: one more try on WASM in a fresh worker.
      const st = this.st;
      if (st.state === "loading" && st.device === "webgpu") {
        const attempts = [...(st.attempts ?? []), { variant: st.variant ?? "?", device: "webgpu", error: why }];
        if (this.retryOnWasm({ ...st, state: "error", error: why, attempts })) return;
      }
      this.onWorkerCrash(why);
    };
    w.addEventListener("error", (ev) => {
      // Keep our worker's failures out of the page's error stream (and the runtime's error observer).
      (ev as { preventDefault?: () => void } | null)?.preventDefault?.();
      failEarly(errorMessage((ev as { message?: string } | null)?.message ?? ev));
    });
    w.addEventListener("messageerror", () => failEarly("worker message could not be deserialized"));
    this.helloTimer = this.clock.setTimeout(() => failEarly("the model worker did not start in time"), this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    this.setStatus({ ...(this.st.state === "loading" ? this.st : {}), state: "loading", worker: true });
    t.send({ type: "load", options });
    this.armStallWatch();
  }

  /** While a worker loads, every status message re-arms this; silence means the worker is stuck. */
  private armStallWatch(): void {
    this.clock.clearTimeout(this.stallTimer);
    this.stallTimer = null;
    if (!this.transport?.inWorker || this.st.state !== "loading" || this.disposed) return;
    this.stallTimer = this.clock.setTimeout(() => this.onStall(), this.opts.loadStallMs ?? LOAD_STALL_MS);
  }

  private onStall(): void {
    if (this.st.state !== "loading" || !this.transport?.inWorker) return;
    const where = `${this.st.phase ?? "start-up"}${this.st.device ? ` on ${this.st.device}` : ""}`;
    const error = `the model worker stopped responding while loading (${where})`;
    const attempts = [...(this.st.attempts ?? [])];
    if (this.st.device === "webgpu") attempts.push({ variant: this.st.variant ?? "?", device: "webgpu", error: "stalled" });
    if (this.retryOnWasm({ ...this.st, state: "error", error, attempts })) return;
    this.onWorkerCrash(error);
  }

  private useInline(why?: string, options: BackendLoadOptions = this.loadOptions): void {
    if (this.disposed) return;
    const t = new InlineTransport((m) => {
      if (this.transport === t) this.onMessage(m);
    }, {
      fetch: this.opts.fetch ?? globalThis.fetch.bind(globalThis),
      clock: this.clock,
      ort: this.opts.ortLoader ?? defaultOrtLoader,
      ...(this.opts.probeGpu ? { probeGpu: this.opts.probeGpu } : {}),
    });
    this.transport = t;
    this.activeOptions = options;
    this.lat.length = 0;
    if (why) this.workerError = why;
    this.setStatus({ state: "loading", worker: false, ...(why ? { workerError: why } : {}) });
    t.send({ type: "load", options });
  }

  /**
   * A worker whose load failed after a WebGPU attempt may hold an onnxruntime stuck in WebGPU: start over once in
   * a fresh worker on WASM only. Returns true when the retry started (the error is not published).
   */
  private retryOnWasm(s: ModelHostStatus): boolean {
    if (this.wasmRetried || !this.transport?.inWorker || this.loadOptions.device === "wasm") return false;
    if (!(s.attempts ?? []).some((a) => a.device === "webgpu")) return false;
    this.wasmRetried = true;
    this.priorAttempts = [...(s.attempts ?? [])];
    this.clock.clearTimeout(this.stallTimer);
    this.transport.close();
    this.transport = null;
    let w: WorkerLike | null = null;
    try {
      w = (this.opts.workerFactory ?? defaultWorkerFactory)();
    } catch {
      w = null;
    }
    const options: BackendLoadOptions = { ...this.loadOptions, device: "wasm" };
    this.st = { ...s, state: "loading", error: undefined };
    delete this.st.error;
    if (w) this.useWorker(w, options);
    else this.useInline("could not start a second worker", options);
    return true;
  }

  private onWorkerCrash(why: string): void {
    const err = why.startsWith("the model worker") ? why : `the model worker crashed: ${why}`;
    this.clock.clearTimeout(this.stallTimer);
    this.transport?.close();
    this.transport = null;
    this.started = false; // load() may try again
    this.setStatus({ state: "error", error: err, worker: true });
    if (this.running) this.finish(this.running, new ModelLoadError(err));
    this.running = null;
    for (const j of this.queue.splice(0)) this.finish(j, new ModelNotReadyError(err));
    for (const [id] of this.measures) this.failMeasure(id, new ModelNotReadyError(err));
  }

  private onMessage(m: FromWorker): void {
    if (this.disposed) return;
    switch (m.type) {
      case "csp":
        if (this.violations.length < 16) this.violations.push(m.violation);
        break;
      case "hello":
        this.hello = true;
        this.clock.clearTimeout(this.helloTimer);
        break;
      case "status": {
        if (m.status.state === "error" && this.retryOnWasm(m.status)) break;
        const transportWorker = this.transport?.inWorker ?? false;
        const attempts = this.priorAttempts.length ? [...this.priorAttempts, ...(m.status.attempts ?? [])] : m.status.attempts;
        this.setStatus({
          ...m.status,
          worker: transportWorker,
          ...(attempts?.length ? { attempts } : {}),
          ...(this.workerError && !transportWorker ? { workerError: this.workerError } : {}),
        });
        this.armStallWatch();
        if (m.status.state === "ready" || m.status.state === "error") this.pump();
        break;
      }
      case "result": {
        const meas = this.measures.get(m.id);
        if (meas) {
          this.measures.delete(m.id);
          m.ok ? meas.resolve(m.value) : meas.reject(deserializeError(m.error));
          return;
        }
        const j = this.running;
        if (!j || j.id !== m.id) return; // a result for a request that was re-sent elsewhere
        this.running = null;
        if (j.settled) {
          // answered after its timeout: the slot is free again, the caller already moved on
        } else if (m.ok) {
          const v = m.value as EvaluateOk;
          this.st0.completed++;
          this.st0.lastMs = this.clock.now() - j.t0;
          this.st0.lastForwardMs = v.timings?.forward;
          this.recordLatency(v);
          this.finish(j, null, v);
        } else {
          this.st0.failed++;
          this.finish(j, deserializeError(m.error));
        }
        this.pump();
        break;
      }
    }
  }

  /** Rolling inference-time stats for status.latency (adaptive hold budgets and situation sizes). */
  private recordLatency(v: EvaluateOk): void {
    const ms = Number(v.timings?.total);
    const tokens = Number(v.usage?.input_tokens);
    if (!(ms >= 0) || !(tokens > 0)) return;
    this.lat.push({ ms, tokens });
    if (this.lat.length > LATENCY_WINDOW) this.lat.shift();
    const rank = (xs: number[], p: number) => {
      const a = [...xs].sort((x, y) => x - y);
      return a[Math.max(0, Math.ceil(p * a.length) - 1)];
    };
    const latency: LatencyStats = {
      p50: Math.round(rank(this.lat.map((x) => x.ms), 0.5)),
      p90: Math.round(rank(this.lat.map((x) => x.ms), 0.9)),
      n: this.lat.length,
      tokensP50: rank(this.lat.map((x) => x.tokens), 0.5),
      msPerToken: Math.round(rank(this.lat.map((x) => x.ms / x.tokens), 0.5) * 1000) / 1000,
      source: "evaluations",
    };
    this.st = { ...this.st, latency };
    const now = this.clock.now();
    if (this.lat.length === 1 || now - this.lastLatencyEmit >= LATENCY_EMIT_MS) {
      this.lastLatencyEmit = now;
      this.notify();
    }
  }

  ready(): Promise<void> {
    if (this.disposed) return Promise.reject(new ModelDisposedError());
    if (this.st.state === "ready") return Promise.resolve();
    if (this.st.state === "error" && this.started) {
      return Promise.reject(new ModelLoadError(this.st.error ?? "the GenClass model failed to load", this.st.attempts ?? []));
    }
    const p = new Promise<void>((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
    this.start();
    return p;
  }

  load(): Promise<void> {
    if (this.disposed) return Promise.reject(new ModelDisposedError());
    if (this.st.state === "error") {
      if (this.transport) {
        const p = new Promise<void>((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
        this.setStatus({ state: "loading", worker: this.transport.inWorker });
        this.transport.send({ type: "load", options: this.activeOptions });
        this.armStallWatch();
        return p;
      }
      this.started = false;
    }
    return this.ready();
  }

  // ------------------------------------------------------------------------------------ evaluation

  evaluate(req: ModelEvaluateRequest): Promise<Record<string, Answer>> {
    return this.evaluateDetailed(req).then((r) => r.answers);
  }

  evaluateDetailed(req: ModelEvaluateRequest): Promise<EvaluateOk> {
    if (this.disposed) return Promise.reject(new ModelDisposedError());
    this.st0.requests++;
    if (this.st.state !== "ready") {
      this.st0.notReady++;
      this.start(); // lazy: the first request starts the load; it still fails open now
      const msg = this.st.state === "error" ? `the GenClass model failed to load: ${this.st.error}` : `the GenClass model is ${this.st.state === "off" ? "not loaded" : "still loading"}`;
      return Promise.reject(new ModelNotReadyError(msg, { state: this.st.state }));
    }
    let state: unknown;
    try {
      state = toJsonValue(req.state);
    } catch (e) {
      this.st0.failed++;
      return Promise.reject(e);
    }
    return new Promise<EvaluateOk>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        seq: this.seq++,
        priority: Number(req.priority ?? 0) || 0,
        state,
        questions: req.questions,
        t0: this.clock.now(),
        timer: null,
        settled: false,
        resolve,
        reject,
      };
      const ms = req.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      job.timer = this.clock.setTimeout(() => this.timeout(job, ms), ms);
      const max = Math.max(0, this.opts.maxQueue ?? DEFAULT_MAX_QUEUE);
      if (this.queue.length >= max) {
        // Evict the lowest-priority, oldest request (possibly this one).
        let victim: Job = job;
        for (const q of this.queue) if (q.priority < victim.priority || (q.priority === victim.priority && q.seq < victim.seq)) victim = q;
        if (victim === job && this.running) {
          this.st0.busy++;
          this.finish(job, new ModelBusyError(this.queue.length));
          return;
        }
        if (victim !== job) {
          this.queue.splice(this.queue.indexOf(victim), 1);
          this.st0.busy++;
          this.finish(victim, new ModelBusyError(this.queue.length));
        }
      }
      this.queue.push(job);
      this.pump();
    });
  }

  private timeout(job: Job, ms: number): void {
    if (job.settled) return;
    this.st0.timeouts++;
    const qi = this.queue.indexOf(job);
    if (qi >= 0) this.queue.splice(qi, 1);
    // A running job keeps the slot until the backend answers (one inference at a time).
    this.finish(job, new ModelTimeoutError(ms));
  }

  private finish(job: Job, err: Error | null, value?: EvaluateOk): void {
    if (job.settled) return;
    job.settled = true;
    this.clock.clearTimeout(job.timer);
    if (err) job.reject(err);
    else job.resolve(value as EvaluateOk);
  }

  /** Sends the next job (highest priority, then oldest) when nothing is running. */
  private pump(): void {
    if (this.running || !this.transport || this.disposed) return;
    if (this.st.state !== "ready") {
      if (this.st.state === "error") for (const j of this.queue.splice(0)) this.finish(j, new ModelNotReadyError(`the GenClass model failed to load: ${this.st.error}`));
      return;
    }
    while (this.queue.length) {
      let bi = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i];
        const b = this.queue[bi];
        if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) bi = i;
      }
      const job = this.queue.splice(bi, 1)[0];
      if (job.settled) continue;
      try {
        this.transport.send({ type: "evaluate", id: job.id, state: job.state, questions: job.questions });
      } catch (e) {
        // e.g. DataCloneError: questions that cannot cross to the worker
        this.st0.failed++;
        this.finish(job, new ModelInputError(`cannot send the request to the model: ${errorMessage(e)}`));
        continue;
      }
      this.running = job;
      return;
    }
  }

  measure(state: unknown, questions?: unknown): Promise<{ stateTokens: number; positions: number; total: number }> {
    if (this.disposed) return Promise.reject(new ModelDisposedError());
    if (this.st.state !== "ready" || !this.transport) {
      this.start();
      return Promise.reject(new ModelNotReadyError());
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.measures.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.transport?.send({ type: "measure", id, state: toJsonValue(state), ...(questions !== undefined ? { questions } : {}) });
      } catch (e) {
        this.failMeasure(id, e as Error);
      }
    });
  }

  private failMeasure(id: number, e: Error): void {
    const p = this.measures.get(id);
    if (!p) return;
    this.measures.delete(id);
    p.reject(e);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.idleCancel?.();
    this.stopCspWatch();
    this.clock.clearTimeout(this.helloTimer);
    this.clock.clearTimeout(this.stallTimer);
    const err = new ModelDisposedError();
    if (this.running) this.finish(this.running, err);
    this.running = null;
    for (const j of this.queue.splice(0)) this.finish(j, err);
    for (const [id] of this.measures) this.failMeasure(id, err);
    this.transport?.close();
    this.transport = null;
    this.settleReady(err);
    this.st = { state: "off" };
    for (const fn of [...this.listeners]) {
      try {
        fn(this.st);
      } catch {
        // ignore
      }
    }
    this.listeners.clear();
  }
}

/** The page's origin (null outside a page). */
function pageOrigin(): string | null {
  try {
    const o = (globalThis as { location?: { origin?: string } }).location?.origin;
    return typeof o === "string" && o !== "null" ? o : null;
  } catch {
    return null;
  }
}

function resolveBaseUrl(u: string): string {
  const href = (globalThis as { location?: { href?: string } }).location?.href;
  try {
    return href ? new URL(u, href).href : new URL(u).href;
  } catch {
    return u;
  }
}

/** Runs fn once the page has loaded and the browser is idle (2 s at most), using the injected clock otherwise. */
function scheduleIdle(fn: () => void, clock: Clock): () => void {
  const g = globalThis as {
    document?: { readyState?: string };
    addEventListener?: (t: string, f: () => void, o?: unknown) => void;
    removeEventListener?: (t: string, f: () => void) => void;
    requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (h: number) => void;
  };
  let cancelled = false;
  let idleHandle: number | null = null;
  let timer: unknown = null;
  let waitTimer: unknown = null;
  const run = () => {
    if (cancelled) return;
    cancelled = true;
    fn();
  };
  const whenIdle = () => {
    if (cancelled) return;
    clock.clearTimeout(waitTimer);
    g.removeEventListener?.("load", whenIdle);
    if (typeof g.requestIdleCallback === "function") idleHandle = g.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    else timer = clock.setTimeout(run, IDLE_TIMEOUT_MS / 2);
  };
  if (g.document && g.document.readyState !== "complete" && typeof g.addEventListener === "function") {
    g.addEventListener("load", whenIdle, { once: true });
    waitTimer = clock.setTimeout(whenIdle, LOAD_EVENT_WAIT_MS);
  } else whenIdle();
  return () => {
    cancelled = true;
    clock.clearTimeout(timer);
    clock.clearTimeout(waitTimer);
    g.removeEventListener?.("load", whenIdle);
    if (idleHandle !== null) g.cancelIdleCallback?.(idleHandle);
  };
}

/** The DecisionProvider of the local GenClass model. */
export function createModelHost(opts: ModelHostOptions = {}): ModelHost {
  return new Host(opts);
}
