// Development stand-in for @genclass/runtime/react (see index.ts).
import { useMemo, useSyncExternalStore } from "react";
import { GenClass } from "./index.ts";
import type { Atom, Runtime, StoreOptions } from "../../../../packages/runtime/src/types.ts";

const atoms = new Map<string, Atom<unknown>>();

export function useGenClass(): Runtime {
  const rt = GenClass.runtime;
  if (!rt) throw new Error("GenClass.init() has not been called");
  return rt;
}

export function useAtom<T>(atom: Atom<T>): [T, Atom<T>["set"]] {
  const v = useSyncExternalStore(
    (cb) => atom.subscribe(() => cb()),
    () => atom.get(),
    () => atom.get(),
  );
  return [v, atom.set];
}

export function useGenClassState<T>(name: string, initial: T, opts?: StoreOptions<T>): [T, Atom<T>["set"]] {
  const rt = useGenClass();
  const atom = useMemo(() => {
    let a = atoms.get(name) as Atom<T> | undefined;
    if (!a) {
      a = rt.atom(name, initial, opts);
      atoms.set(name, a as Atom<unknown>);
    }
    return a;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, rt]);
  return useAtom(atom);
}
