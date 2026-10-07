// @genclass/runtime public facade (CONTRACT §2).
//
//   import { GenClass } from "@genclass/runtime";
//   GenClass.init();

import type { Clock, CreateOptions, DecisionProvider, InitOptions, Mode, ModelOptions, ModelStatus, ObserverName, Runtime } from "./types.js";
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

function makeHost(m: ModelOptions, fetchFn: typeof fetch | undefined, clock: Clock | undefined): DecisionProvider {
  try {
    return createModelHost({ ...m, ...(fetchFn ? { fetch: fetchFn } : {}), ...(clock ? { clock } : {}) });
  } catch (e) {
    return failedProvider(`model host unavailable: ${(e as Error)?.message ?? e}`);
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
    decider = makeHost(options.model, nf, options.clock);
  }
  return new RuntimeImpl({ ...options, decider: decider ?? null, ownsDecider: owns });
}

const MODES: readonly Mode[] = ["observe", "guard", "heal"];
const ALL_OFF: Record<ObserverName, boolean> = { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false };

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
    const mode = ks && (MODES as readonly string[]).includes(ks) ? (ks as Mode) : options.mode;
    if (typeof g.window !== "object" || typeof g.document !== "object") {
      // Not a browser (SSR, Node, workers): never instrument a server's fetch or load the model there.
      current = createRuntime({ ...options, observe: ALL_OFF, model: false, decider: options.decider ?? null, report: options.report ?? "silent", ...(mode ? { mode } : {}) });
      return current;
    }
    const o: CreateOptions = { ...options };
    if (mode) o.mode = mode;
    if (options.decider === undefined && options.model !== false) o.model = options.model ?? {};
    current = createRuntime(o);
    return current;
  }
}

export default GenClass;
