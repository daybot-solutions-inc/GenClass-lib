// Bridge a runtime atom into a Solid signal (the atom stays the source of truth; the signal mirrors it).
import { createSignal, getOwner, onCleanup, type Accessor } from "solid-js";
import type { Atom } from "@genclass/runtime";

export function atomSignal<T>(atom: Atom<T>): Accessor<T> {
  const [get, set] = createSignal<T>(atom.get(), { equals: false });
  const off = atom.subscribe((v) => set(() => v));
  if (getOwner()) onCleanup(off);
  return get;
}
