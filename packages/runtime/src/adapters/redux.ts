// @genclass/runtime/redux: a store enhancer that routes every state change through the GenClass pipeline.
//
//   const store = createStore(reducer, compose(applyMiddleware(thunk), genclassEnhancer(GenClass.runtime, { name: "app" })));
//   // Redux Toolkit:  configureStore({ reducer, enhancers: (d) => d().concat(genclassEnhancer(rt, { name: "app" })) })
//
// The store is registered with runtime.guard(name, …), so its state appears in situations and every change is
// traced as a mutation with its cause (the user action, request or timer that dispatched it). A dispatch is
// previewed through the reducer once; the runtime then decides when it applies:
//   - synchronous dispatches from user handlers, no-op dispatches and GenClass's own writes apply immediately;
//   - a salient async dispatch (e.g. a stale response) may be held until the model decides; it is then applied by
//     dispatching the original action through the store's own dispatch (reducers, subscribers and devtools see the
//     real action, once), deferred, or dropped (never reaching reducers or subscribers).
// Put the enhancer last in compose() (innermost) so middleware see each action once, at dispatch time.

import type { Action, Reducer, StoreEnhancer, StoreEnhancerStoreCreator } from "redux";
import type { Runtime, StoreOptions } from "../types.js";

export interface GenclassEnhancerOptions<S = unknown> extends StoreOptions<S> {
  /** Store name used in situations, facts and devtools (e.g. "app", "cart"). */
  name: string;
}

/** Action GenClass uses to write a whole state back (rollback, resync, undo). Visible in Redux DevTools. */
export const GENCLASS_REPLACE = "@@genclass/REPLACE";

interface Proposal {
  value: unknown;
  action: Action;
  prev: unknown;
}

const isAction = (a: unknown): a is Action => typeof a === "object" && a !== null && typeof (a as { type?: unknown }).type === "string";

/**
 * Redux store enhancer. With `runtime` null/undefined (GenClass not initialised or disabled) the store is
 * returned unchanged.
 */
export function genclassEnhancer<S = unknown>(runtime: Runtime | null | undefined, options: GenclassEnhancerOptions<S>): StoreEnhancer {
  const enhancer = (createStore: StoreEnhancerStoreCreator) =>
    (reducer: Reducer<unknown, Action, unknown>, preloadedState?: unknown) => {
      let current = reducer;
      // A state the pipeline already computed for (action, prev): the wrapped reducer returns it instead of
      // running the reducer a second time when the original action is finally dispatched.
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
      /** Dispatch `action` whose reducer result from `prev` is already known (the reducer is not run again). */
      const dispatchKnown = (action: Action, prev: unknown, next: unknown): Action => {
        ready = { action, prev, next };
        try {
          return raw(action);
        } finally {
          ready = null;
        }
      };
      const proposals: Proposal[] = [];
      const remember = (p: Proposal): void => {
        proposals.push(p);
        if (proposals.length > 64) proposals.shift();
      };
      const take = (v: unknown): Proposal | undefined => {
        for (let i = proposals.length - 1; i >= 0; i--) {
          if (Object.is(proposals[i].value, v)) return proposals.splice(i, 1)[0];
        }
        return undefined;
      };
      const { name, ...storeOpts } = options;
      const guarded = runtime.guard<unknown>(
        name,
        {
          get: () => store.getState(),
          set: (v) => {
            // Commit: dispatch the original action (its reducer result is already known), or write a GenClass value.
            const p = take(v);
            if (!p || store.getState() !== p.prev) {
              raw({ type: GENCLASS_REPLACE, state: v } as Action);
              return;
            }
            dispatchKnown(p.action, p.prev, v);
          },
          subscribe: (fn) => store.subscribe(fn),
        },
        storeOpts as StoreOptions<unknown>,
      );

      const dispatch = (action: unknown): unknown => {
        if (!isAction(action)) return raw(action as Action); // thunks etc. (when this enhancer is outermost)
        const state = store.getState();
        const next = current(state, action);
        if (next === state) return dispatchKnown(action, state, next); // no change: plain dispatch, subscribers notified as usual
        guarded.set((prev: unknown) => {
          const value = prev === state ? next : current(prev, action);
          remember({ value, action, prev });
          return value;
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
