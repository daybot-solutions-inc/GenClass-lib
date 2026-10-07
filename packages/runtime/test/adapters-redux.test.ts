// Redux enhancer: dispatch passthrough, held dispatches applied later through the original dispatch (reducer
// runs once, subscribers notified once), drops, middleware order, thunks, replaceReducer, GenClass writes.
import { applyMiddleware, compose, legacy_createStore as createStore, type Middleware, type Reducer, type StoreEnhancer, type UnknownAction } from "redux";
import { describe, expect, it, vi } from "vitest";
import { genclassEnhancer, GENCLASS_REPLACE } from "../src/adapters/redux.js";
import { MockRuntime } from "./browser/ui/mock-runtime.js";
import { defaultScript, ManualDecider, setup } from "./helpers.js";

interface S {
  query: string;
  results: string[];
  count: number;
}
const initial: S = { query: "", results: [], count: 0 };

function makeReducer() {
  const calls: string[] = [];
  const reducer = vi.fn((s: S = initial, a: UnknownAction): S => {
    calls.push(a.type);
    switch (a.type) {
      case "query":
        return { ...s, query: a.q as string };
      case "results":
        return { ...s, results: a.items as string[] };
      case "inc":
        return { ...s, count: s.count + 1 };
      default:
        return s;
    }
  });
  return { reducer: reducer as unknown as Reducer<S, UnknownAction, S>, calls };
}

const typesOf = (calls: string[]) => calls.filter((t) => !t.startsWith("@@redux/"));

describe("genclassEnhancer (scripted runtime)", () => {
  it("passes dispatches straight through when nothing is held", () => {
    const rt = new MockRuntime();
    const { reducer, calls } = makeReducer();
    const store = createStore(reducer, genclassEnhancer(rt, { name: "app" }));
    const seen: S[] = [];
    store.subscribe(() => seen.push(store.getState()));
    expect(store.dispatch({ type: "query", q: "re" })).toEqual({ type: "query", q: "re" });
    expect(store.getState().query).toBe("re");
    expect(seen).toHaveLength(1);
    expect(typesOf(calls)).toEqual(["query"]); // the reducer ran once (the preview became the state)
    expect(rt.calls.sets).toEqual(["app"]);
    expect(rt.events.filter((e) => e.kind === "state")).toHaveLength(1);
  });

  it("holds an async dispatch, then applies the original action once; subscribers are notified once", () => {
    const rt = new MockRuntime();
    rt.holdWrites = true;
    const { reducer, calls } = makeReducer();
    const store = createStore(reducer, genclassEnhancer(rt, { name: "app" }));
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch({ type: "results", items: ["react"] });
    expect(store.getState().results).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(rt.heldCount).toBe(1);
    rt.flushHeld();
    expect(store.getState().results).toEqual(["react"]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(typesOf(calls)).toEqual(["results"]); // previewed once, not re-run on apply
  });

  it("re-runs a held action on top of state that moved meanwhile", () => {
    const rt = new MockRuntime();
    rt.holdWrites = true;
    const { reducer, calls } = makeReducer();
    const store = createStore(reducer, genclassEnhancer(rt, { name: "app" }));
    store.dispatch({ type: "inc" }); // held
    rt.user({ kind: "type" }, () => store.dispatch({ type: "query", q: "react" })); // applies now
    expect(store.getState()).toEqual({ query: "react", results: [], count: 0 });
    rt.flushHeld();
    expect(store.getState()).toEqual({ query: "react", results: [], count: 1 });
    expect(typesOf(calls)).toEqual(["inc", "query", "inc"]); // the held one re-ran against the new state
  });

  it("drops a discarded dispatch: no reducer, no subscriber", () => {
    const rt = new MockRuntime();
    rt.holdWrites = true;
    const { reducer, calls } = makeReducer();
    const store = createStore(reducer, genclassEnhancer(rt, { name: "app" }));
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch({ type: "results", items: ["stale"] });
    rt.dropHeld();
    expect(store.getState().results).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(typesOf(calls)).toEqual(["results"]); // the preview only
  });

  it("lets middleware see each action once, at dispatch time, and passes thunks through", () => {
    const rt = new MockRuntime();
    rt.holdWrites = true;
    const { reducer } = makeReducer();
    const logged: string[] = [];
    const logger: Middleware = () => (next) => (action) => {
      logged.push((action as UnknownAction).type);
      return next(action);
    };
    const thunk: Middleware = (api) => (next) => (action) => (typeof action === "function" ? (action as (d: typeof api.dispatch) => unknown)(api.dispatch) : next(action));
    const store = createStore(reducer, compose(applyMiddleware(thunk, logger), genclassEnhancer(rt, { name: "app" })));
    store.dispatch(((dispatch: (a: UnknownAction) => void) => dispatch({ type: "inc" })) as unknown as UnknownAction);
    expect(logged).toEqual(["inc"]);
    expect(store.getState().count).toBe(0);
    rt.flushHeld();
    expect(store.getState().count).toBe(1);
    expect(logged).toEqual(["inc"]);
  });

  it("dispatches no-op actions normally (subscribers notified, nothing traced)", () => {
    const rt = new MockRuntime();
    const { reducer, calls } = makeReducer();
    const store = createStore(reducer, genclassEnhancer(rt, { name: "app" }));
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch({ type: "unknown" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(rt.calls.sets).toEqual([]);
    expect(typesOf(calls)).toEqual(["unknown"]);
  });

  it("keeps working after replaceReducer", () => {
    const rt = new MockRuntime();
    const { reducer } = makeReducer();
    const store = createStore(reducer, genclassEnhancer(rt, { name: "app" }));
    const doubled: Reducer<S, UnknownAction, S> = (s = initial, a) => (a.type === "inc" ? { ...s, count: s.count + 2 } : s);
    store.replaceReducer(doubled);
    store.dispatch({ type: "inc" });
    expect(store.getState().count).toBe(2);
  });

  it("shows inner enhancers (e.g. Redux DevTools) the real action at apply time, and GenClass writes as REPLACE", () => {
    const rt = new MockRuntime();
    rt.holdWrites = true;
    const { reducer, calls } = makeReducer();
    const log: string[] = [];
    const recorder: StoreEnhancer = (next) => (r, p) => {
      const s = next(r, p);
      return {
        ...s,
        dispatch: ((a: UnknownAction) => {
          log.push(a.type);
          return s.dispatch(a);
        }) as typeof s.dispatch,
      };
    };
    const store = createStore(reducer, compose(genclassEnhancer(rt, { name: "app" }), recorder) as StoreEnhancer);
    store.dispatch({ type: "results", items: ["react"] });
    expect(log.filter((t) => !t.startsWith("@@redux/"))).toEqual([]);
    rt.flushHeld();
    expect(log.filter((t) => !t.startsWith("@@redux/"))).toEqual(["results"]);
    rt.genclassWrite("app", { query: "", results: [], count: 7 }); // e.g. a rollback to a consistent snapshot
    expect(log[log.length - 1]).toBe(GENCLASS_REPLACE);
    expect(store.getState()).toEqual({ query: "", results: [], count: 7 });
    expect(typesOf(calls)).toEqual(["results"]); // REPLACE never reaches the app's reducer
  });

  it("returns the store unchanged without a runtime", () => {
    const { reducer } = makeReducer();
    const store = createStore(reducer, genclassEnhancer(null, { name: "app" }));
    store.dispatch({ type: "inc" });
    expect(store.getState().count).toBe(1);
  });
});

describe("genclassEnhancer + the real runtime", () => {
  function make() {
    const decider = new ManualDecider();
    const S = setup({ decider, triage: "always" });
    const { reducer } = makeReducer();
    const store = createStore(reducer, genclassEnhancer(S.rt, { name: "app" }));
    return { S, decider, store };
  }

  it("applies user-handler dispatches immediately and traces the store", () => {
    const { S, decider, store } = make();
    S.rt.user({ kind: "type", target: 'input "Search"', value: "re" }, () => store.dispatch({ type: "query", q: "re" }));
    expect(store.getState().query).toBe("re");
    expect(decider.pending).toHaveLength(0);
    const ev = S.rt.history().filter((e) => e.kind === "state");
    expect(ev.map((e) => e.data?.paths)).toEqual([["app.query"]]);
    expect(ev[0].data?.user).toBe(true);
    S.rt.destroy();
  });

  it("holds an async dispatch for the model; apply notifies subscribers once, discard never", async () => {
    const { S, decider, store } = make();
    const listener = vi.fn();
    store.subscribe(listener);
    await S.rt.op("load", async () => {
      store.dispatch({ type: "results", items: ["react"] });
    });
    await S.clock.flush();
    expect(decider.pending.map((p) => p.req.trigger)).toEqual(["mutation"]);
    expect(store.getState().results).toEqual([]);
    decider.answer(); // expected → apply
    await S.clock.flush();
    expect(store.getState().results).toEqual(["react"]);
    expect(listener).toHaveBeenCalledTimes(1);

    await S.rt.op("load", async () => {
      store.dispatch({ type: "results", items: ["stale"] });
    });
    await S.clock.flush();
    decider.answer(defaultScript({ mutation: { diagnosis: "stale", action: "discard", p: 0.97 } }));
    await S.clock.flush();
    expect(store.getState().results).toEqual(["react"]);
    expect(listener).toHaveBeenCalledTimes(1);
    const [a] = S.rt.interventions();
    expect(a.action).toBe("discard");
    a.undo?.(); // the dropped dispatch, applied after all
    await S.clock.flush();
    expect(store.getState().results).toEqual(["stale"]);
    expect(listener).toHaveBeenCalledTimes(2);
    S.rt.destroy();
  });
});

