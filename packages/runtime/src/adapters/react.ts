// @genclass/runtime/react: React bindings.
//
//   const [results, setResults] = useGenClassState("search.results", []);   // a runtime atom, traced and guarded
//   const [cart, setCart] = useAtom(cartAtom);                               // any Atom<T> you created yourself
//   const runtime = useGenClass();                                           // the current runtime
//   const decisions = useGenClassDecisions();                                // live decisions for app-level UIs
//
// The current runtime is the one from the nearest <GenClassProvider runtime={…}>, else GenClass.runtime (set by
// GenClass.init()). Without any runtime (not initialised, server rendering) useGenClassState behaves exactly like
// React's useState, so the app keeps working. Writes go through the runtime's pipeline: a write GenClass holds
// (a salient async write waiting for a decision) shows up in React when it is applied, and never if it is dropped.

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";
import { GenClass } from "../index.js";
import type { ActionRecord, Atom, Decision, ModelStatus, Runtime, RuntimeEvents, StoreOptions } from "../types.js";

const Ctx = createContext<Runtime | null | undefined>(undefined);

export interface GenClassProviderProps {
  /** The runtime for this subtree (e.g. from createRuntime()). null: explicitly no GenClass below. */
  runtime: Runtime | null;
  children?: ReactNode;
}

/** Provide an explicit runtime to a subtree (tests, several runtimes, SSR). Optional: GenClass.runtime is the default. */
export function GenClassProvider({ runtime, children }: GenClassProviderProps): ReactElement {
  return createElement(Ctx.Provider, { value: runtime }, children);
}

function useRuntimeOrNull(): Runtime | null {
  const fromCtx = useContext(Ctx);
  return fromCtx === undefined ? GenClass.runtime : fromCtx;
}

/** The current GenClass runtime. Throws when there is none (call GenClass.init() or use <GenClassProvider>). */
export function useGenClass(): Runtime {
  const rt = useRuntimeOrNull();
  if (!rt) throw new Error("[GenClass] No runtime: call GenClass.init() before rendering, or wrap the tree in <GenClassProvider runtime={…}>.");
  return rt;
}

// One atom per name per runtime, shared by every component that uses the name (and safe under StrictMode's
// double render: the registry makes creation idempotent).
const registry = new WeakMap<Runtime, Map<string, Atom<unknown>>>();

function atomFor<T>(rt: Runtime, name: string, initial: T | (() => T), opts: StoreOptions<T> | undefined): Atom<T> {
  let byName = registry.get(rt);
  if (!byName) registry.set(rt, (byName = new Map()));
  let a = byName.get(name) as Atom<T> | undefined;
  if (!a) {
    a = rt.atom<T>(name, typeof initial === "function" ? (initial as () => T)() : initial, opts);
    byName.set(name, a as Atom<unknown>);
  }
  return a;
}

/** The atom useGenClassState(name) uses on this runtime, if a component created it (for code outside React). */
export function getGenClassAtom<T>(runtime: Runtime, name: string): Atom<T> | undefined {
  return registry.get(runtime)?.get(name) as Atom<T> | undefined;
}

const noop = (): void => {};
let warned = false;

/**
 * useState backed by a named runtime atom: the value is shared by every component using the same name, writes
 * are traced (with their causes) and go through GenClass's guard pipeline. `initial` (or a lazy initializer) is
 * used when the atom is created; `opts` (resync, hold, describe) too.
 */
export function useGenClassState<T>(name: string, initial: T | (() => T), opts?: StoreOptions<T>): [T, Dispatch<SetStateAction<T>>] {
  const rt = useRuntimeOrNull();
  const atom = rt ? atomFor(rt, name, initial, opts) : null;
  if (!rt && !warned) {
    warned = true;
    (globalThis as { console?: Console }).console?.info?.(`[GenClass] useGenClassState("${name}"): no runtime (GenClass.init() not called); using plain React state.`);
  }
  // Without a runtime this is plain React state (initialised only then).
  const [local, setLocal] = useState<T>(() => (atom ? (undefined as T) : typeof initial === "function" ? (initial as () => T)() : initial));
  const subscribe = useCallback((cb: () => void) => (atom ? atom.subscribe(() => cb()) : noop), [atom]);
  const get = useCallback(() => (atom ? atom.get() : undefined), [atom]);
  const value = useSyncExternalStore(subscribe, get, get);
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      if (atom) atom.set(next as T | ((prev: T) => T));
      else setLocal(next);
    },
    [atom],
  );
  return [atom ? (value as T) : local, set];
}

/** Subscribe to any Atom<T> (from runtime.atom or runtime.guard): [value, set], like useState. */
export function useAtom<T>(atom: Atom<T>): [T, (next: T | ((prev: T) => T)) => void] {
  const subscribe = useCallback((cb: () => void) => atom.subscribe(() => cb()), [atom]);
  const get = useCallback(() => atom.get(), [atom]);
  const value = useSyncExternalStore(subscribe, get, get);
  const set = useCallback((next: T | ((prev: T) => T)) => atom.set(next), [atom]);
  return [value, set];
}

/** A cached snapshot of a runtime list that refreshes when any of `events` fires. */
function useRuntimeList<T>(events: (keyof RuntimeEvents)[], read: (rt: Runtime) => T[], deps: unknown[]): T[] {
  const rt = useRuntimeOrNull();
  const feed = useMemo(() => {
    let version = 0;
    let at = -1;
    let cached: T[] = [];
    return {
      subscribe(cb: () => void): () => void {
        if (!rt) return noop;
        const offs = events.map((e) =>
          rt.on(e, () => {
            version++;
            cb();
          }),
        );
        version++; // anything that happened before subscribing
        return () => offs.forEach((off) => off());
      },
      get(): T[] {
        if (at !== version) {
          at = version;
          try {
            cached = rt ? read(rt) : [];
          } catch {
            cached = [];
          }
        }
        return cached;
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt, ...deps]);
  return useSyncExternalStore(feed.subscribe, feed.get, feed.get);
}

/** Recent model decisions (oldest first, as runtime.decisions(limit)), live. For app-level UIs. */
export function useGenClassDecisions(limit = 50): Decision[] {
  return useRuntimeList(["decide", "act"], (rt) => rt.decisions(limit), [limit]);
}

/** Recent interventions (non-passive actions that ran, oldest first), live. Each may carry undo(). */
export function useGenClassInterventions(limit = 50): ActionRecord[] {
  return useRuntimeList(["act"], (rt) => rt.interventions(limit), [limit]);
}

const OFF: ModelStatus = { state: "off" };

/** The model status (loading progress, device, ready/error), live. */
export function useGenClassStatus(): ModelStatus {
  const rt = useRuntimeOrNull();
  // Snapshots must be stable: a status object may be rebuilt or mutated in place, so key it by its content.
  const cache = useMemo(() => ({ key: "", value: OFF }), [rt]);
  const subscribe = useCallback((cb: () => void) => (rt ? rt.on("status", () => cb()) : noop), [rt]);
  const get = useCallback((): ModelStatus => {
    const s = rt ? rt.status : OFF;
    const key = `${s.state}|${s.progress?.loaded}|${s.progress?.total}|${s.device}|${s.variant}|${s.model}|${s.loadMs}|${s.error}`;
    if (key !== cache.key) {
      cache.key = key;
      cache.value = { ...s, ...(s.progress ? { progress: { ...s.progress } } : {}) };
    }
    return cache.value;
  }, [rt, cache]);
  return useSyncExternalStore(subscribe, get, get);
}
