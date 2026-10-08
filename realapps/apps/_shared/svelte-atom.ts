// A runtime atom as a Svelte store (the store contract: subscribe returns an unsubscriber, set/update).
import type { Atom } from "@genclass/runtime";

export function atomStore<T>(a: Atom<T>) {
  return {
    subscribe(run: (v: T) => void): () => void {
      run(a.get());
      return a.subscribe(run);
    },
    set: (v: T) => a.set(v),
    update: (fn: (v: T) => T) => a.update(fn),
  };
}
