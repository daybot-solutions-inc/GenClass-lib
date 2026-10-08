// @genclass/runtime public facade (CONTRACT §2).
//
//   import { GenClass } from "@genclass/runtime";
//   GenClass.init();

import type { Clock, CreateOptions, DecisionProvider, DeviceEnv, EvaluateRequest, InitOptions, Mode, ModelOptions, ModelStatus, ObserverName, Runtime } from "./types.js";
import { browserClock } from "./clock.js";
import { RuntimeImpl } from "./runtime.js";
import { createModelHost } from "./model/host.js";

export * from "./types.js";
export { browserClock } from "./clock.js";
export { GenClassUnavailableError } from "./errors.js";
export { createModelHost, DEFAULT_MODEL_BASE_URL } from "./model/host.js";
export type { ModelHost, ModelHostOptions, ModelHostStatus, ModelHostStats, ModelEvaluateRequest } from "./model/host.js";
export {
  GenClassModelError,
  ModelNotReadyError,
  MaxTokensExceededError,
  ModelInputError,
  ModelUnsupportedError,
  ModelTimeoutError,
  ModelAbortedError,
  ModelBusyError,
  ModelDisposedError,
  ModelLoadError,
  ModelIntegrityError,
  ModelInferenceError,
} from "./model/errors.js";
export type { ModelErrorCode, LoadAttempt } from "./model/errors.js";
export { stateText, stateChars, sectionLimits, STATE_CHAR_BUDGET, COMPACT_BUDGET } from "./situation/serialize.js";
export { BUILTIN_ACTIONS, TRIGGER_ACTIONS, PASSIVE, DEFAULT_DIAGNOSES } from "./situation/questions.js";
export { describeElement } from "./observe/dom-user.js";
export { RuntimeImpl } from "./runtime.js";

/** fetch as it was when this module loaded: the model host downloads with it, so GenClass never observes itself. */
const NATIVE_FETCH: typeof fetch | undefined =
  typeof (globalThis as { fetch?: unknown }).fetch === "function" ? (globalThis.fetch as typeof fetch).bind(globalThis) : undefined;

function failedProvider(message: string): DecisionProvider {
  const err = new Error(message);
  const status: ModelStatus = { state: "error", error: message };
  return {
    status,
    ready: () => Promise.reject(err),
    evaluate: () => Promise.reject(err),
  };
}

function skippedProvider(reason: string): DecisionProvider {
  const err = new Error(`model skipped: ${reason}`);
  return { status: { state: "skipped", reason }, ready: () => Promise.reject(err), evaluate: () => Promise.reject(err) };
}

/** What the page can tell about the device (OPTIONS-SPEC §4.15). Unknown values stay undefined (= allowed). */
export function deviceEnv(g: Record<string, unknown>): DeviceEnv {
  const nav = (g.navigator ?? {}) as { deviceMemory?: number; hardwareConcurrency?: number; gpu?: unknown; connection?: { saveData?: boolean; effectiveType?: string } };
  const env: DeviceEnv = { webgpu: !!nav.gpu };
  if (typeof nav.deviceMemory === "number") env.deviceMemoryGB = nav.deviceMemory;
  if (typeof nav.hardwareConcurrency === "number") env.cores = nav.hardwareConcurrency;
  if (typeof nav.connection?.saveData === "boolean") env.saveData = nav.connection.saveData;
  if (typeof nav.connection?.effectiveType === "string") env.effectiveType = nav.connection.effectiveType;
  return env;
}

/** loadIf → "load" | "lazy" | skip reason. A throwing predicate counts as allowed. */
export function evalLoadIf(m: ModelOptions, env: DeviceEnv, warn: (s: string) => void): "load" | "lazy" | { skip: string } {
  const li = m.loadIf ?? { saveData: "lazy" as const };
  if (typeof li === "function") {
    try {
      const v = li(env);
      return v === "lazy" ? "lazy" : v === false ? { skip: "loadIf" } : "load";
    } catch (e) {
      warn(`model.loadIf threw (${(e as Error)?.message ?? e}); loading anyway.`);
      return "load";
    }
  }
  if (typeof li.minDeviceMemoryGB === "number" && typeof env.deviceMemoryGB === "number" && env.deviceMemoryGB < li.minDeviceMemoryGB) return { skip: "device-memory" };
  const sd = li.saveData ?? "lazy";
  if (env.saveData === true && sd === "skip") return { skip: "save-data" };
  if (env.saveData === true && sd === "lazy") return "lazy";
  return "load";
}

function hostOptions(m: ModelOptions, env: DeviceEnv): Record<string, unknown> {
  const { loadIf: _l, inlineFallback: _i, threads, timeoutMs, maxDecisionsPerMinute: _d, unloadAfterIdleMs: _u, ...rest } = m;
  const out: Record<string, unknown> = { ...rest };
  if (typeof threads === "number" && threads >= 1) out.maxThreads = Math.floor(threads);
  else if (threads === "auto" && typeof env.cores === "number") out.maxThreads = Math.min(4, Math.max(1, env.cores - 1));
  if (typeof timeoutMs === "number" && timeoutMs > 0) out.timeoutMs = timeoutMs;
  // inlineFallback:false needs a host option (src/model/**, not CORE): flagged, passed through for the host to honour.
  if (m.inlineFallback === false) out.inlineFallback = false;
  return out;
}

function makeHost(m: ModelOptions, fetchFn: typeof fetch | undefined, clock: Clock | undefined, g: Record<string, unknown> = globalThis as never): DecisionProvider {
  try {
    const env = deviceEnv(g);
    const warn = (s: string) => (g.console as Console | undefined)?.warn?.(`[GenClass] ${s}`);
    const li = evalLoadIf(m, env, warn);
    if (typeof li === "object") return skippedProvider(li.skip);
    const mo: ModelOptions = li === "lazy" ? { ...m, preload: "lazy" } : m;
    const create = () => createModelHost({ ...(hostOptions(mo, env) as ModelOptions), ...(fetchFn ? { fetch: fetchFn } : {}), ...(clock ? { clock } : {}) });
    const idle = m.unloadAfterIdleMs;
    if (typeof idle === "number" && idle > 0) return new IdleUnloadProvider(create, idle, clock ?? browserClock);
    return create();
  } catch (e) {
    return failedProvider(`model host unavailable: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * model.unloadAfterIdleMs (OPTIONS-SPEC §4.18): tears the host down after `idleMs` without an evaluation (state
 * "unloaded"); the next evaluation starts a reload from the cache and is itself rejected (fail open: released unchanged).
 */
export class IdleUnloadProvider implements DecisionProvider {
  private host: DecisionProvider | null;
  private timer: unknown = null;
  private subs = new Set<(s: ModelStatus) => void>();
  private unsub: (() => void) | null = null;
  constructor(
    private readonly create: () => DecisionProvider,
    private readonly idleMs: number,
    private readonly clock: Clock,
  ) {
    this.host = this.attach(create());
    this.arm();
  }
  private attach(h: DecisionProvider): DecisionProvider {
    this.unsub = h.onStatus?.((s) => this.subs.forEach((f) => f(s))) ?? null;
    return h;
  }
  private arm(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => this.unload(), this.idleMs);
  }
  private unload(): void {
    this.timer = null;
    const h = this.host;
    if (!h) return;
    this.host = null;
    this.unsub?.();
    this.unsub = null;
    h.dispose?.();
    const s = this.status;
    this.subs.forEach((f) => f(s));
  }
  get status(): ModelStatus {
    return this.host ? this.host.status : { state: "unloaded" };
  }
  ready(): Promise<void> {
    if (!this.host) this.host = this.attach(this.create());
    return this.host.ready();
  }
  evaluate(req: EvaluateRequest): ReturnType<DecisionProvider["evaluate"]> {
    this.arm();
    if (!this.host) {
      this.host = this.attach(this.create());
      return Promise.reject(new Error("model reloading after idle unload"));
    }
    return this.host.evaluate(req);
  }
  onStatus(fn: (s: ModelStatus) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  dispose(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.unsub?.();
    this.host?.dispose?.();
    this.host = null;
  }
}


/** Advanced/headless runtime (sim, tests, SSR). No model unless `model` options or a `decider` are given. */
export function createRuntime(options: CreateOptions = {}): Runtime {
  let decider: DecisionProvider | null | undefined = options.decider;
  let owns = false;
  if (decider === undefined && options.model && typeof options.model === "object") {
    owns = true;
    const g = (options.global ?? globalThis) as { fetch?: typeof fetch };
    const nf = options.global ? (typeof g.fetch === "function" ? g.fetch.bind(g) : undefined) : NATIVE_FETCH;
    decider = makeHost(options.model, nf, options.clock, (options.global ?? globalThis) as never);
  }
  return new RuntimeImpl({ ...options, decider: decider ?? null, ownsDecider: owns });
}

const MODES: readonly Mode[] = ["observe", "guard", "heal"];
const ALL_OFF: Record<ObserverName, boolean> = { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false };

/** `?genclass=off|observe|guard|heal` in the URL, or localStorage.genclass. */
function killSwitch(g: Record<string, unknown>): string | null {
  let v: string | null = null;
  try {
    const loc = g.location as { search?: string } | undefined;
    if (loc?.search) v = new URLSearchParams(loc.search).get("genclass");
  } catch {
    /* ignore */
  }
  if (!v) {
    try {
      const ls = g.localStorage as Storage | undefined;
      v = ls?.getItem("genclass") ?? null;
    } catch {
      /* ignore */
    }
  }
  return v ? v.trim().toLowerCase() : null;
}

let current: Runtime | null = null;

export const GenClass = {
  /** Install GenClass (idempotent: a second call returns the same runtime). Never throws. */
  init(options: InitOptions = {}): Runtime {
    if (current) return current;
    try {
      return initUnsafe(options);
    } catch (e) {
      const g = globalThis as unknown as Record<string, unknown>;
      (g.console as Console | undefined)?.warn?.(`[GenClass] Could not start (${(e as Error)?.message ?? e}); running without it.`);
      current = createRuntime({ observe: ALL_OFF, decider: null, report: "silent", mode: "observe" });
      return current;
    }
  },
  get runtime(): Runtime | null {
    return current;
  },
  /** Uninstall observers, terminate the model worker. */
  destroy(): void {
    const r = current;
    current = null;
    r?.destroy();
  },
};

function initUnsafe(options: InitOptions): Runtime {
  {
    const g = globalThis as unknown as Record<string, unknown>;
    const ks = killSwitch(g);
    if (ks === "off") {
      (g.console as Console | undefined)?.info?.('[GenClass] Disabled by ?genclass=off or localStorage.genclass = "off": nothing is installed.');
      current = createRuntime({ observe: ALL_OFF, model: false, decider: null, report: "silent", mode: "observe" });
      return current;
    }
    // the kill switch may only demote (OPTIONS-SPEC §3), unless debug
    const rank = (m: string | undefined) => (m === "heal" ? 2 : m === "guard" ? 1 : 0);
    const base = options.mode ?? "guard";
    const mode = ks && (MODES as readonly string[]).includes(ks) && (options.debug || rank(ks) <= rank(base)) ? (ks as Mode) : options.mode;
    if (typeof g.window !== "object" || typeof g.document !== "object") {
      // Not a browser (SSR, Node, workers): never instrument a server's fetch or load the model there.
      current = createRuntime({ ...options, observe: ALL_OFF, model: false, decider: options.decider ?? null, report: options.report ?? "silent", ...(mode ? { mode } : {}) });
      return current;
    }
    const o: CreateOptions = { ...options };
    if (mode) o.mode = mode;
    if (options.decider === undefined && options.model !== false && options.enabled !== false) {
      o.model = options.model ?? {};
      // a dynamic enabled source: never download before it says on
      if (typeof options.enabled === "function" || (typeof options.enabled === "object" && options.enabled)) o.model = { ...o.model, preload: "lazy" };
    }
    current = createRuntime(o);
    return current;
  }
}

export default GenClass;
