// @vitest-environment happy-dom
// Automatic Redux / Redux Toolkit / Zustand discovery (InitOptions.autoState; src/discover/redux.ts) through the
// Redux DevTools globals. Redux Toolkit is not installed here: `configureStore` below follows RTK 2's source
// (composeWithDevTools read at module evaluation, `devTools` on by default, applyMiddleware + an extra enhancer).
import { applyMiddleware, compose, createStore, legacy_createStore, type Middleware, type Reducer, type StoreEnhancer } from "redux";
import { createStore as createZustand } from "zustand/vanilla";
import { devtools } from "zustand/middleware";
import { afterEach, describe, expect, it } from "vitest";
import "../src/discover/index.js"; // registers autoState (the zero-code entries do this)
import { createRuntime } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { drain, FakeClock, ScriptedDecider, defaultScript } from "./helpers.js";

const G = globalThis as unknown as Record<string, unknown>;
const W = (typeof window !== "undefined" ? window : globalThis) as unknown as Record<string, unknown>;
const OFF = { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false };
let rt: RuntimeImpl | null = null;

function start(autoState: unknown = true): RuntimeImpl {
  for (const k of ["__REDUX_DEVTOOLS_EXTENSION_COMPOSE__", "__REDUX_DEVTOOLS_EXTENSION__"]) {
    delete G[k];
    delete W[k];
  }
  rt = createRuntime({ clock: new FakeClock(), global: W, decider: new ScriptedDecider(defaultScript()), mode: "observe", report: "silent", autoState: autoState as never, observe: OFF }) as RuntimeImpl;
  return rt;
}

afterEach(async () => {
  rt?.destroy();
  rt = null;
  for (const k of ["__REDUX_DEVTOOLS_EXTENSION_COMPOSE__", "__REDUX_DEVTOOLS_EXTENSION__"]) {
    delete G[k];
    delete W[k];
  }
  await drain();
});

interface Cart {
  items: string[];
  total: number;
}
type CartAction = { type: "add"; item: string; price: number } | { type: "noop" };
const cart: Reducer<Cart, CartAction> = (s = { items: [], total: 0 }, a) => (a.type === "add" ? { items: [...s.items, a.item], total: s.total + a.price } : s);

/** Redux Toolkit 2's configureStore, reduced to its devtools path. */
function rtkLike() {
  const w = W as { __REDUX_DEVTOOLS_EXTENSION_COMPOSE__?: (...a: unknown[]) => unknown };
  // evaluated once, at "module load" (RTK: src/devtoolsExtension.ts)
  const composeWithDevTools =
    typeof window !== "undefined" && w.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__
      ? w.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__
      : function (...args: unknown[]) {
          if (args.length === 0) return undefined;
          if (typeof args[0] === "object") return compose;
          return (compose as (...f: unknown[]) => unknown)(...args);
        };
  return function configureStore<S, A extends { type: string }>(o: { reducer: Reducer<S, A>; middleware?: Middleware[]; devTools?: boolean | { name?: string }; extra?: StoreEnhancer[] }) {
    const middlewareEnhancer = applyMiddleware(...(o.middleware ?? []));
    let finalCompose: (...f: unknown[]) => unknown = compose as never;
    if (o.devTools ?? true) finalCompose = composeWithDevTools({ trace: false, ...(typeof o.devTools === "object" && o.devTools) }) as never;
    const enhancers = [middlewareEnhancer, ...(o.extra ?? [])];
    return createStore(o.reducer as never, finalCompose(...enhancers) as StoreEnhancer) as unknown as import("redux").Store<S, A>;
  };
}

describe("autoState Redux (CONTRACT §4: discovered stores are full adapters)", () => {
  it("configureStore (RTK, devTools default on) gets GenClass's enhancer innermost: a controllable store named redux", () => {
    const r = start();
    const configureStore = rtkLike();
    const seen: string[] = [];
    const logger: Middleware = () => (next) => (a) => {
      seen.push((a as { type: string }).type);
      return next(a);
    };
    const store = configureStore({ reducer: cart, middleware: [logger] });
    const op = r.startOp("fetch", "POST /api/cart", { cause: null });
    r.internals.ctx.run(op, () => store.dispatch({ type: "add", item: "naan", price: 3 }));
    expect(store.getState()).toEqual({ items: ["naan"], total: 3 });
    expect(seen).toEqual(["add"]); // middleware sees the action once
    const info = r.stores().find((s) => s.name === "redux");
    expect(info).toMatchObject({ kind: "adapter", source: "redux", writable: true });
    expect(r.internals.hub.field("redux.total")?.writer).toBe(op.id);
    expect(r.discoveryStats()?.redux?.reduxStores).toEqual(["redux"]);
  });

  it("names stores after the devtools name option, deduplicates, and leaves devTools: false alone", () => {
    const r = start();
    const configureStore = rtkLike();
    configureStore({ reducer: cart, devTools: { name: "Shop cart" } });
    configureStore({ reducer: cart, devTools: { name: "Shop cart" } });
    configureStore({ reducer: cart, devTools: false });
    expect(r.stores().map((s) => s.name).sort()).toEqual(["Shop_cart", "Shop_cart_2"]);
  });

  it("createStore + compose with window.__REDUX_DEVTOOLS_EXTENSION__() and with the compose global", () => {
    const r = start();
    const ext = (W.__REDUX_DEVTOOLS_EXTENSION__ as () => StoreEnhancer)();
    const s1 = legacy_createStore(cart as never, compose(applyMiddleware(), ext) as StoreEnhancer);
    const composeEnhancers = (W.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ as typeof compose) || compose;
    const s2 = legacy_createStore(cart as never, composeEnhancers(applyMiddleware()) as StoreEnhancer);
    s1.dispatch({ type: "add", item: "a", price: 1 } as never);
    s2.dispatch({ type: "add", item: "b", price: 2 } as never);
    expect(r.internals.hub.valueAt("redux.total")).toBe(1);
    expect(r.internals.hub.valueAt("redux_2.total")).toBe(2);
  });

  it("forwards to the real Redux DevTools extension (its enhancer outermost, its compose used)", () => {
    const calls: string[] = [];
    const realEnh: StoreEnhancer = (next) => (reducer, pre) => {
      calls.push("real-enhancer");
      return (next as (r: unknown, p: unknown) => ReturnType<typeof legacy_createStore>)(reducer, pre) as never;
    };
    const realCompose = (...a: unknown[]) => {
      calls.push("real-compose");
      if (a.length === 1 && typeof a[0] === "object") return (...f: unknown[]) => (compose as (...x: unknown[]) => unknown)(realEnh, ...f);
      return (compose as (...x: unknown[]) => unknown)(realEnh, ...a);
    };
    const real = Object.assign(() => realEnh, { connect: () => ({ init: () => calls.push("real-init"), send: () => calls.push("real-send"), subscribe: () => () => {} }) });
    W.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ = realCompose;
    W.__REDUX_DEVTOOLS_EXTENSION__ = real;
    rt = createRuntime({ clock: new FakeClock(), global: W, decider: null, report: "silent", autoState: true, observe: OFF }) as RuntimeImpl;
    const configureStore = rtkLike();
    const store = configureStore({ reducer: cart });
    store.dispatch({ type: "add", item: "dal", price: 9 });
    expect(calls).toEqual(["real-compose", "real-enhancer"]);
    expect(rt.internals.hub.valueAt("redux.total")).toBe(9);
    rt.destroy();
    expect(W.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__).toBe(realCompose);
    expect(W.__REDUX_DEVTOOLS_EXTENSION__).toBe(real);
    rt = null;
  });

  it("restores the globals and passes through once destroyed; autoState: { redux: false } installs no compose shim", () => {
    const r = start();
    const configureStore = rtkLike();
    r.destroy();
    expect(W.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__).toBeUndefined();
    const store = configureStore({ reducer: cart });
    store.dispatch({ type: "add", item: "x", price: 1 });
    expect(store.getState().total).toBe(1);
    rt = null;
    const r2 = start({ redux: false });
    expect(W.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__).toBeUndefined();
    expect(typeof (W.__REDUX_DEVTOOLS_EXTENSION__ as { connect?: unknown })?.connect).toBe("function");
    void r2;
  });
});

describe("autoState Zustand devtools (observed only)", () => {
  interface Bag {
    items: string[];
    open: boolean;
    add(i: string): void;
  }
  it("records the devtools-connected store as observed state, functions left out, writer = the setter's op", () => {
    const r = start();
    const store = createZustand<Bag>()(
      devtools((set) => ({ items: [], open: false, add: (i) => set((s) => ({ items: [...s.items, i] }), false, "add") }), { name: "bag" }),
    );
    const info = r.stores().find((s) => s.name === "bag");
    expect(info).toMatchObject({ kind: "observed", source: "devtools", writable: false });
    const op = r.startOp("fetch", "GET /api/bag", { cause: null });
    r.internals.ctx.run(op, () => store.getState().add("rice"));
    expect(store.getState().items).toEqual(["rice"]);
    const hub = r.internals.hub;
    expect(hub.valueAt("bag.items")).toEqual(["rice"]);
    expect(hub.field("bag.items")?.writer).toBe(op.id);
    expect(hub.field("bag.add")).toBeUndefined();
    expect(r.discoveryStats()?.redux?.connected).toEqual(["bag"]);
  });

  it("an unnamed store is called store; autoState: { zustand: false } records nothing", () => {
    const r = start();
    const s = createZustand<{ n: number }>()(devtools(() => ({ n: 1 })));
    s.setState({ n: 2 });
    expect(r.internals.hub.valueAt("store.n")).toBe(2);
    r.destroy();
    rt = null;
    const r2 = start({ zustand: false });
    const s2 = createZustand<{ n: number }>()(devtools(() => ({ n: 1 }), { name: "z" }));
    s2.setState({ n: 5 });
    expect(r2.stores()).toEqual([]);
    expect(s2.getState().n).toBe(5);
  });
});
