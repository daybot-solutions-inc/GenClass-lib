// @genclass/runtime/zustand: middleware that routes a Zustand store's writes through the GenClass pipeline.
//
//   const useCart = create<Cart>()(genclass(GenClass.runtime, "cart")((set) => ({ items: [], add: (i) => set((s) => ({ items: [...s.items, i] })) })));
//   // with devtools:  create<Cart>()(devtools(genclass(rt, "cart")(creator)))
//
// The store is registered with runtime.adapter(name, …): its state appears in situations and every set() is traced
// as a mutation with its cause. set() and store.setState() keep Zustand's semantics (partial merge, replace,
// functional updates, extra arguments such as devtools action names); a write the runtime holds is applied later
// through the original set (merged on top of the state at that time, so newer fields are kept) or dropped.
// With `runtime` null/undefined the creator runs unchanged.

import type { StateCreator, StoreMutatorIdentifier } from "zustand";
import type { AdapterHandle, Runtime, StoreOptions } from "../types.js";

type Genclass = <T, Mps extends [StoreMutatorIdentifier, unknown][] = [], Mcs extends [StoreMutatorIdentifier, unknown][] = []>(
  initializer: StateCreator<T, Mps, Mcs>,
) => StateCreator<T, Mps, Mcs>;

type AnySet = (partial: unknown, replace?: boolean, ...rest: unknown[]) => void;

export function genclass(runtime: Runtime | null | undefined, name: string, opts?: StoreOptions<unknown>): Genclass {
  const impl =
    <T>(initializer: StateCreator<T, [], []>): StateCreator<T, [], []> =>
    (set, get, api) => {
      if (!runtime) return initializer(set, get, api);
      const outer = set as unknown as AnySet;
      let handle: AdapterHandle<T> | null = null;
      const gset: AnySet = (partial, replace, ...rest) => {
        if (!handle) return outer(partial, replace, ...rest); // set() during the store's own creation
        handle.propose({
          fn: (prev: T) => {
            const next = typeof partial === "function" ? (partial as (s: T) => unknown)(prev) : partial;
            if (Object.is(next, prev)) return prev;
            const whole = replace ?? (typeof next !== "object" || next === null);
            return (whole ? next : Object.assign({}, prev, next)) as T;
          },
          commit: (value: T) => outer(value, true, ...rest),
        });
      };
      api.setState = gset as unknown as typeof api.setState;
      const initial = initializer(gset as unknown as typeof set, get, api);
      handle = runtime.adapter<T>(
        name,
        {
          // Zustand assigns its state after the creator returns: until then the initial state is the state.
          get: () => (api.getState() ?? initial) as T,
          set: (v) => outer(v, true),
          subscribe: (fn) => api.subscribe(() => fn()),
        },
        opts as StoreOptions<T> | undefined,
      );
      return initial;
    };
  return impl as unknown as Genclass;
}
