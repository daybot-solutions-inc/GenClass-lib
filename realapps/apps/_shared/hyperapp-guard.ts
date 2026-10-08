// Register a Hyperapp 2 app's state with the runtime. Hyperapp keeps its state private, so a dispatch middleware
// mirrors every state the app commits, and rt.guard writes (GenClass's own, or the app's async results routed
// through the handle) are dispatched back into the app as plain states.
import type { Atom } from "@genclass/runtime";
import { rt } from "./genclass";

type Dispatch = (action: unknown, props?: unknown) => unknown;

export function hyperappGuard<S>(name: string, init: S): { middleware: (d: Dispatch) => Dispatch; store: Atom<S> } {
  let state = init;
  let inner: Dispatch | null = null;
  const subs = new Set<() => void>();
  const commit = (next: S) => {
    if (next === state) return;
    state = next;
    for (const fn of [...subs]) fn();
  };
  const middleware = (d: Dispatch): Dispatch => {
    const wrapped: Dispatch = (action, props) => {
      // a committed state is either a plain state or [state, ...effects]; functions and [action, payload] recurse
      if (Array.isArray(action) ? typeof action[0] !== "function" : typeof action !== "function") commit((Array.isArray(action) ? action[0] : action) as S);
      return d(action, props);
    };
    inner = wrapped;
    return wrapped;
  };
  const store = rt.guard<S>(name, {
    get: () => state,
    set: (v) => {
      if (inner) inner(v);
      else commit(v);
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  });
  return { middleware, store };
}
