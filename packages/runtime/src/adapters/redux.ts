// @genclass/runtime/redux: a store enhancer that routes every state change through the GenClass pipeline.
//
//   // Redux Toolkit:
//   configureStore({ reducer, enhancers: (getDefault) => getDefault().concat(genclassEnhancer(GenClass.runtime, { name: "app" })) });
//   // createStore: alone, or composed (Redux's compose() cannot infer composed enhancer types, hence the cast)
//   createStore(reducer, genclassEnhancer(GenClass.runtime, { name: "app" }));
//   createStore(reducer, compose(applyMiddleware(thunk), genclassEnhancer(GenClass.runtime, { name: "app" })) as StoreEnhancer);
//
// The store is registered with runtime.adapter(name, …): its state appears in situations and every change is traced
// as a mutation with its cause (the user action, request or timer that dispatched it). A dispatch is previewed
// through the reducer once; the runtime then decides when it applies:
//   - dispatches from user handlers (same task), no-op dispatches and GenClass's own writes apply immediately;
//   - a salient async dispatch (e.g. a stale response) may be held until the model decides; it is then applied by
//     dispatching the original action through the store's own dispatch (reducers, subscribers and Redux DevTools
//     see the real action, once), deferred, or dropped (never reaching reducers or subscribers).
// GenClass writes whole states back (rollback, resync) with the visible action "@@genclass/REPLACE".
// Put the enhancer last in compose() (innermost) so middleware see each action once, at dispatch time.

import type { Action, Reducer, StoreEnhancer, StoreEnhancerStoreCreator } from "redux";
import type { Runtime, StoreOptions } from "../types.js";

export interface GenclassEnhancerOptions<S = unknown> extends StoreOptions<S> {
  /** Store name used in situations, facts and devtools (e.g. "app", "cart"). */
  name: string;
}

/** Action GenClass uses to write a whole state back (rollback, resync). Visible in Redux DevTools. */
export const GENCLASS_REPLACE = "@@genclass/REPLACE";

const isAction = (a: unknown): a is Action => typeof a === "object" && a !== null && typeof (a as { type?: unknown }).type === "string";

/**
 * Redux store enhancer (Redux 4/5, Redux Toolkit). With `runtime` null/undefined (GenClass not initialised or
 * disabled) the store is returned unchanged.
 */
export function genclassEnhancer<S = unknown>(runtime: Runtime | null | undefined, options: GenclassEnhancerOptions<S>): StoreEnhancer {
  const enhancer =
    (createStore: StoreEnhancerStoreCreator) =>
    (reducer: Reducer<unknown, Action, unknown>, preloadedState?: unknown) => {
      let current = reducer;
      // A state the pipeline already computed for (action, prev): the wrapped reducer returns it instead of running
      // the reducer again when the original action is dispatched.
      let ready: { action: Action; prev: unknown; next: unknown } | null = null;
      const wrapped = (state: unknown, action: Action): unknown => {
        if (action.type === GENCLASS_REPLACE) return (action as Action & { state: unknown }).state;
        const r = ready;
        if (r && r.action === action && r.prev === state) {
          ready = null;
          return r.next;
        }
        return current(state, action);
      };
      const store = createStore(wrapped as Reducer<unknown, Action, unknown>, preloadedState);
      if (!runtime) return store;

      const raw = store.dispatch.bind(store) as (a: Action) => Action;
      /** Dispatch `action` whose reducer result from the current state is already known. */
      const dispatchKnown = (action: Action, next: unknown): Action => {
        ready = { action, prev: store.getState(), next };
        try {
          return raw(action);
        } finally {
          ready = null;
        }
      };
      const { name, ...storeOpts } = options;
      const handle = runtime.adapter<unknown>(
        name,
        {
          get: () => store.getState(),
          set: (v) => void raw({ type: GENCLASS_REPLACE, state: v } as Action),
          subscribe: (fn) => store.subscribe(fn),
        },
        storeOpts as StoreOptions<unknown>,
      );

      const dispatch = (action: unknown): unknown => {
        if (!isAction(action)) return raw(action as Action); // thunks etc. (when this enhancer is outermost)
        const state = store.getState();
        const next = current(state, action);
        if (next === state) return dispatchKnown(action, next); // no change: a plain dispatch (subscribers notified)
        handle.propose({
          // preview now; re-run only if the state moved before the write applies
          fn: (prev: unknown) => (prev === state ? next : current(prev, action)),
          commit: (value: unknown) => void dispatchKnown(action, value),
        });
        return action;
      };

      return {
        ...store,
        dispatch,
        replaceReducer(nextReducer: Reducer<unknown, Action, unknown>) {
          current = nextReducer;
          store.replaceReducer(wrapped as Reducer<unknown, Action, unknown>);
        },
      };
    };
  return enhancer as unknown as StoreEnhancer;
}
