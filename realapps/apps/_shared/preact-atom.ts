// Mirror a runtime atom into a Preact signal: components read `sig.value` and re-render on change; every write
// still goes through the atom (the source of truth GenClass sees).
import { signal, type ReadonlySignal } from "@preact/signals";
import type { Atom } from "@genclass/runtime";

export function atomSignal<T>(atom: Atom<T>): ReadonlySignal<T> {
  const s = signal<T>(atom.get());
  atom.subscribe((v) => {
    s.value = v;
  });
  return s;
}
