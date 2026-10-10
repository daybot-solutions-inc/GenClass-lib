// @vitest-environment happy-dom
// Automatic React state discovery against React's production build (minified internals, no dev-only hooks):
// the DevTools hook injection, the dispatcher tap and the commit walk work the same way.
import { afterEach, describe, expect, it } from "vitest";
import "./discover-register.js"; // registers autoState (the zero-code entries do this)
import { createRuntime } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { drain, FakeClock } from "./helpers.js";
import { loadReact } from "./discover-react-load.js";

const G = globalThis as unknown as Record<string, unknown>;
let rt: RuntimeImpl | null = null;

afterEach(async () => {
  rt?.destroy();
  rt = null;
  delete G.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  document.body.innerHTML = "";
  await drain();
});

const OFF = { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false };

describe("autoState React, production build (CONTRACT §4)", () => {
  it("records state changes with the writer captured at setState, across a scheduler task", async () => {
    delete G.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    rt = createRuntime({ clock: new FakeClock(), global: globalThis, decider: null, report: "silent", autoState: true, observe: OFF }) as RuntimeImpl;
    const R = loadReact(true);
    expect(R.React.version).toMatch(/^19\./);
    const c = document.createElement("div");
    document.body.appendChild(c);
    const root = R.client.createRoot(c);
    let set!: (v: unknown) => void;
    function OrderChip() {
      const [order, s] = R.React.useState(null);
      set = s;
      return R.React.createElement("span", null, order ? String((order as { lines: number }).lines) : "-");
    }
    root.render(R.React.createElement(OrderChip));
    await drain(8);
    expect(rt.discoveryStats()?.react?.tapped).toBe(1);
    const op = rt.startOp("fetch", "GET /api/order", { cause: null });
    rt.internals.ctx.run(op, () => set({ lines: 2, total: 31.5 }));
    rt.internals.ctx.clear();
    await drain(8);
    expect(c.textContent).toBe("2");
    expect(rt.internals.hub.valueAt("OrderChip.state0.lines")).toBe(2);
    expect(rt.internals.hub.field("OrderChip.state0.total")?.writer).toBe(op.id);
    root.unmount();
  });

  it("a renderer that injected before GenClass (late install) is observed with commit-time attribution", async () => {
    const renderers = new Map<number, unknown>();
    const commits: unknown[] = [];
    const hook = {
      renderers,
      supportsFiber: true,
      inject(r: unknown) {
        renderers.set(renderers.size + 1, r);
        return renderers.size;
      },
      onCommitFiberRoot(_id: number, root: unknown) {
        commits.push(root);
      },
      onCommitFiberUnmount() {},
    };
    G.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
    const R = loadReact(true);
    const c = document.createElement("div");
    const root = R.client.createRoot(c);
    let set!: (v: unknown) => void;
    function Late() {
      const [v, s] = R.React.useState(0);
      set = s;
      return R.React.createElement("i", null, String(v));
    }
    root.render(R.React.createElement(Late));
    await drain(8);
    rt = createRuntime({ clock: new FakeClock(), global: globalThis, decider: null, report: "silent", autoState: true, observe: OFF }) as RuntimeImpl;
    expect(rt.discoveryStats()?.react?.tapped).toBe(0);
    expect(rt.discoveryStats()?.react?.renderers).toBe(1);
    set(3);
    await drain(8);
    expect(rt.internals.hub.valueAt("Late.state0")).toBe(3);
    expect(commits.length).toBeGreaterThanOrEqual(2);
    root.unmount();
  });
});
