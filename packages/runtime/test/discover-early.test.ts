// @vitest-environment happy-dom
// `import "@genclass/runtime/discover"` first, GenClass.init({ autoState: true }) later (after React, Redux and
// Zustand were loaded and their stores created, before the first render): the early install attaches to the runtime.
import "../src/discover/entry.js";
import { applyMiddleware, compose, legacy_createStore, type StoreEnhancer } from "redux";
import { createStore as createZustand } from "zustand/vanilla";
import { devtools } from "zustand/middleware";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { drain, FakeClock } from "./helpers.js";
import { loadReact } from "./discover-react-load.js";

const W = window as unknown as Record<string, unknown>;
const OFF = { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false };

describe("autoState via @genclass/runtime/discover (early install)", () => {
  it("records React state, Redux and Zustand stores created before GenClass.init", async () => {
    expect((W.__REACT_DEVTOOLS_GLOBAL_HOOK__ as { _genclass?: boolean })._genclass).toBe(true);
    // the app's modules: React, a Redux store (devtools compose), a Zustand store (devtools)
    const R = loadReact(false);
    const composeEnhancers = (W.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ as typeof compose) || compose;
    const store = legacy_createStore((s: { n: number } = { n: 0 }, a: { type: string }) => (a.type === "inc" ? { n: s.n + 1 } : s), composeEnhancers(applyMiddleware()) as StoreEnhancer);
    const z = createZustand<{ open: boolean }>()(devtools(() => ({ open: false }), { name: "ui" }));
    z.setState({ open: true });
    // main: GenClass.init later
    const rt = createRuntime({ clock: new FakeClock(), global: globalThis, decider: null, report: "silent", autoState: true, observe: OFF }) as RuntimeImpl;
    const c = document.createElement("div");
    const root = R.client.createRoot(c);
    let set!: (v: unknown) => void;
    function Basket() {
      const [items, s] = R.React.useState([]);
      set = s;
      return R.React.createElement("i", null, String(items.length));
    }
    root.render(R.React.createElement(Basket));
    await drain(8);
    const op = rt.startOp("fetch", "GET /api/basket", { cause: null });
    rt.internals.ctx.run(op, () => {
      set(["naan"]);
      store.dispatch({ type: "inc" });
      z.setState({ open: false });
    });
    rt.internals.ctx.clear();
    await drain(8);
    const hub = rt.internals.hub;
    expect(hub.field("Basket.state0")?.writer).toBe(op.id);
    expect(rt.stores().find((s) => s.name === "redux")).toMatchObject({ kind: "observed", source: "redux" });
    expect(hub.field("redux.n")?.writer).toBe(op.id);
    expect(hub.valueAt("ui.open")).toBe(false);
    expect(hub.field("ui.open")?.writer).toBe(op.id);
    root.unmount();
    rt.destroy();
    // detached: a later runtime can attach again
    const rt2 = createRuntime({ clock: new FakeClock(), global: globalThis, decider: null, report: "silent", autoState: true, observe: OFF }) as RuntimeImpl;
    expect(rt2.discoveryStats()?.react).not.toBeNull();
    rt2.destroy();
  });
});
