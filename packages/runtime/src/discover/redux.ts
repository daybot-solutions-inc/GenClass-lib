// Automatic Redux / Redux Toolkit / Zustand discovery (InitOptions.autoState.redux, .zustand) through the Redux
// DevTools globals that these libraries look for:
//
// - `window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__` (Redux Toolkit's configureStore reads it at module evaluation when
//   `devTools` is on, its default; also `composeWithDevTools`, and `compose` setups that test for it) and
//   `window.__REDUX_DEVTOOLS_EXTENSION__()` (the enhancer form): a store created through either gets GenClass's Redux
//   enhancer (src/adapters/redux.ts) innermost, exactly as a manual `genclassEnhancer`: a full adapter (its writes can be
//   held, dropped, rolled back and resynced like any registered store). Named after the devtools `name` option, else
//   `redux` (`redux_2`, ... for more stores).
// - `window.__REDUX_DEVTOOLS_EXTENSION__.connect(options)` (Zustand's `devtools` middleware, and other libraries that
//   report to Redux DevTools): every state they send is recorded in an OBSERVED-ONLY store (`options.name`, else
//   `store`), attributed to the op that made the change (`send` is called synchronously after the change). Functions
//   in the state (Zustand's actions) are left out.
//
// The real Redux DevTools extension, when installed, keeps working: every call is forwarded to it first and its
// enhancer stays outermost. Nothing here ever throws into the app; once the runtime is destroyed the shims pass
// everything through unchanged (a store created then is not registered).

import { genclassEnhancer } from "../adapters/redux.js";
import type { Runtime } from "../types.js";
import type { Captured, DiscoveryHost, ObservedStore } from "./types.js";
import { storeBase } from "./types.js";

const COMPOSE_KEY = "__REDUX_DEVTOOLS_EXTENSION_COMPOSE__";
const EXT_KEY = "__REDUX_DEVTOOLS_EXTENSION__";

type AnyFn = (...a: unknown[]) => unknown;
type AnyObj = Record<string, unknown>;

export interface ReduxDiscoveryHost extends DiscoveryHost {
  /** The runtime stores are registered with (null while none is attached: everything passes through). */
  readonly runtime: Runtime | null;
}

export interface ReduxDiscovery {
  uninstall(): void;
  /** Turn the sources on or off after installation (a runtime attaching to an early install). */
  configure(o: { redux: boolean; connect: boolean }): void;
  /** A runtime attached: Redux stores created before it are registered now, observed only. */
  attached(): void;
  stats(): { reduxStores: string[]; connected: string[] };
}

function compose(...fs: unknown[]): AnyFn {
  const fns = fs.filter((f): f is AnyFn => typeof f === "function");
  if (!fns.length) return (x: unknown) => x;
  if (fns.length === 1) return fns[0];
  return fns.reduce((a, b) => (...args: unknown[]) => a(b(...args)));
}

/** A state without its functions (Zustand keeps its actions in the state). */
function dataOf(state: unknown): unknown {
  if (!state || typeof state !== "object" || Array.isArray(state)) return state;
  const proto = Object.getPrototypeOf(state);
  if (proto !== Object.prototype && proto !== null) return state;
  let out: AnyObj | null = null;
  for (const k of Object.keys(state)) {
    if (typeof (state as AnyObj)[k] === "function") {
      out ??= { ...(state as AnyObj) };
      delete out[k];
    }
  }
  return out ?? state;
}

export function installReduxDiscovery(host: ReduxDiscoveryHost, opts: { redux: boolean; connect: boolean }): ReduxDiscovery | null {
  const o = { ...opts };
  const g = host.global as AnyObj;
  if (typeof g.document !== "object" || !g.document) return null;
  let active = true;
  const reduxStores: string[] = [];
  const connected: string[] = [];
  const restore: (() => void)[] = [];

  const realCompose = g[COMPOSE_KEY] as AnyFn | undefined;
  const realExt = g[EXT_KEY] as (AnyFn & AnyObj) | undefined;

  const early: { want: string; store: AnyObj }[] = [];

  /** GenClass's enhancer, registered under a free name when the store is created. */
  const gcEnhancer = (opts: unknown): AnyFn => {
    const want = storeBase((opts as AnyObj | null | undefined)?.name) || "redux";
    return (createStore: unknown) =>
      (...args: unknown[]) => {
        const cs = createStore as AnyFn;
        const runtime = host.runtime;
        if (!active || !o.redux) return cs(...args);
        if (!runtime) {
          // created before any runtime (early install, GenClass.init later): observed once one attaches
          const store = cs(...args) as AnyObj;
          early.push({ want, store });
          return store;
        }
        let name: string | null = null;
        try {
          name = host.freeName(want);
        } catch {
          name = null;
        }
        if (!name) return cs(...args);
        let enhanced: AnyFn;
        try {
          enhanced = (genclassEnhancer(runtime, { name }) as unknown as (c: unknown) => AnyFn)(cs);
        } catch (e) {
          host.log("Redux discovery: could not wrap a store", e);
          return cs(...args);
        }
        const store = enhanced(...args);
        try {
          host.tag(name, "redux");
          reduxStores.push(name);
        } catch {
          /* ignore */
        }
        return store;
      };
  };

  /** compose with GenClass's enhancer innermost (middleware see each action once, at dispatch time). */
  const composeWith = (opts: unknown, funcs: unknown[]): unknown => {
    if (!active || !o.redux) {
      if (realCompose) return opts !== undefined ? (realCompose(opts) as AnyFn)(...funcs) : realCompose(...funcs);
      return compose(...funcs);
    }
    const all = [...funcs, gcEnhancer(opts)];
    if (realCompose) {
      try {
        return opts !== undefined ? (realCompose(opts) as AnyFn)(...all) : realCompose(...all);
      } catch (e) {
        host.log("Redux discovery: the Redux DevTools compose failed", e);
      }
    }
    return compose(...all);
  };

  const composeShim = function (...funcs: unknown[]): unknown {
    // composeWithDevTools(options) returns a compose; composeWithDevTools(...enhancers) composes them
    if (funcs.length === 1 && funcs[0] !== null && typeof funcs[0] === "object") {
      const opts = funcs[0];
      return (...fs: unknown[]) => composeWith(opts, fs);
    }
    return composeWith(undefined, funcs);
  };

  // ------------------------------------------------------------------------------------- connect (Zustand)

  const connect = (options: unknown): AnyObj => {
    let real: AnyObj | null = null;
    try {
      real = realExt && typeof realExt.connect === "function" ? ((realExt.connect as AnyFn)(options) as AnyObj) : null;
    } catch (e) {
      host.log("Redux discovery: the Redux DevTools connect failed", e);
    }
    const call = (k: string, a: unknown[]): unknown => {
      const f = real?.[k];
      return typeof f === "function" ? (f as AnyFn).apply(real, a) : undefined;
    };
    const want = storeBase((options as AnyObj | null | undefined)?.name) || "store";
    let st: ObservedStore | null = null;
    let failed = false;
    /** The last state seen while no runtime was attached (early install): the store's initial value later. */
    let last: unknown;
    const seen = (state: unknown, w: Captured | null) => {
      if (!active || failed || !o.connect || state === undefined) return;
      try {
        const v = dataOf(state);
        if (!st) {
          if (!host.runtime) {
            last = v;
            return;
          }
          st = host.observed(want, last !== undefined ? last : v, "devtools");
          if (!st) {
            failed = true;
            return;
          }
          connected.push(st.name);
          if (last === undefined) return;
        }
        st.write(v, w);
      } catch (e) {
        failed = true;
        host.log("Redux discovery: recording a connected store failed", e);
      }
    };
    return {
      init(state: unknown, ...rest: unknown[]) {
        const r = call("init", [state, ...rest]);
        seen(state, null);
        return r;
      },
      send(action: unknown, state: unknown, ...rest: unknown[]) {
        const r = call("send", [action, state, ...rest]);
        if (state !== undefined && state !== null) {
          let w: Captured | null = null;
          try {
            w = host.capture();
          } catch {
            /* commit-less write */
          }
          seen(state, w);
        }
        return r;
      },
      subscribe(listener: unknown) {
        const u = call("subscribe", [listener]);
        return typeof u === "function" ? u : () => {};
      },
      unsubscribe(...a: unknown[]) {
        return call("unsubscribe", a);
      },
      error(...a: unknown[]) {
        return call("error", a);
      },
    };
  };

  const extShim = function (opts?: unknown): unknown {
    let realEnh: unknown = null;
    try {
      realEnh = realExt ? realExt(opts) : null;
    } catch (e) {
      host.log("Redux discovery: the Redux DevTools enhancer failed", e);
    }
    if (!active || !o.redux) return realEnh ?? ((x: unknown) => x);
    const gc = gcEnhancer(opts);
    return typeof realEnh === "function" ? compose(realEnh, gc) : gc;
  } as AnyFn & AnyObj;
  // the rest of the extension API, forwarded (or no-ops)
  for (const k of ["open", "updateStore", "notifyErrors", "disconnect", "send", "listen"]) {
    const f = realExt?.[k];
    extShim[k] = typeof f === "function" ? (...a: unknown[]) => (f as AnyFn).apply(realExt, a) : () => undefined;
  }
  extShim.connect = (options: unknown) => connect(options);
  extShim._genclass = true;

  const define = (key: string, value: unknown, prev: unknown): void => {
    try {
      g[key] = value;
      restore.push(() => {
        if (g[key] !== value) return;
        if (prev === undefined) delete g[key];
        else g[key] = prev;
      });
    } catch (e) {
      host.log(`Redux discovery: could not set window.${key}`, e);
    }
  };
  if (o.redux) define(COMPOSE_KEY, composeShim, realCompose);
  if (o.redux || o.connect) define(EXT_KEY, extShim, realExt);

  return {
    attached() {
      for (const { want, store } of early.splice(0)) {
        try {
          const getState = store.getState as AnyFn;
          const st = host.observed(want, getState(), "redux");
          if (!st) continue;
          reduxStores.push(st.name);
          (store.subscribe as AnyFn)(() => {
            if (!active || !host.runtime) return;
            try {
              st.write(getState(), host.capture());
            } catch {
              /* never break a dispatch */
            }
          });
        } catch (e) {
          host.log("Redux discovery: could not observe an early store", e);
        }
      }
    },
    configure(c) {
      o.redux = c.redux;
      o.connect = c.connect;
    },
    uninstall() {
      active = false;
      for (const r of restore) {
        try {
          r();
        } catch {
          /* ignore */
        }
      }
    },
    stats() {
      return { reduxStores: reduxStores.slice(), connected: connected.slice() };
    },
  };
}
