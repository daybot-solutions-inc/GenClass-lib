// Bridge a runtime atom into Vue reactivity (the Vue equivalent of useSyncExternalStore).
import { shallowRef, onScopeDispose, getCurrentScope, type ShallowRef } from "vue";
import type { Atom } from "@genclass/runtime";

export function useAtom<T>(atom: Atom<T>): ShallowRef<T> {
  const r = shallowRef(atom.get());
  const off = atom.subscribe((v) => (r.value = v));
  if (getCurrentScope()) onScopeDispose(off);
  return r;
}
