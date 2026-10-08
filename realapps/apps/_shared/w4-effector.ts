// Register an effector store with GenClass (rt.guard over getState / updates) and get back a write function that
// applies an updater through the guarded handle: async results go through GenClass's pipeline, while UI events can
// keep updating the store directly with `.on()` (traced only).
import { createEvent, type StoreWritable } from "effector";
import { rt } from "./genclass";

export function guardStore<T>(name: string, $s: StoreWritable<T>): (fn: (prev: T) => T) => void {
  const replaced = createEvent<T>();
  $s.on(replaced, (_, v) => v);
  const g = rt.guard<T>(name, { get: () => $s.getState(), set: (v) => replaced(v), subscribe: (fn) => $s.updates.watch(() => fn()) });
  return (fn) => g.update(fn);
}
