// @vitest-environment happy-dom
// Automatic React state discovery (InitOptions.autoState; src/discover/react.ts) with the real react / react-dom
// (development build here; discover-react-prod.test.ts runs the production build). React is loaded after the runtime,
// as with the one line first: the runtime installs the DevTools hook, react-dom injects into it.
import { afterEach, describe, expect, it } from "vitest";
import "./discover-register.js"; // registers autoState (the zero-code entries do this)
import { createRuntime } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { defaultScript, drain, FakeClock, FakeServer, ScriptedDecider } from "./helpers.js";
import { loadReact, type ReactMods } from "./discover-react-load.js";

interface Env {
  rt: RuntimeImpl;
  clock: FakeClock;
  server: FakeServer;
  decider: ScriptedDecider;
  R: ReactMods;
  container: HTMLElement;
  root: { render(n: unknown): void; unmount(): void };
}

const G = globalThis as unknown as Record<string, unknown>;
let env: Env | null = null;
const realFetch = G.fetch;

function start(opts: { prod?: boolean; mode?: "observe" | "guard"; autoState?: unknown; script?: ConstructorParameters<typeof ScriptedDecider>[0]; telemetry?: unknown; triage?: "always" } = {}): Env {
  const clock = new FakeClock();
  const server = new FakeServer(clock);
  G.fetch = server.fetch;
  delete G.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const decider = new ScriptedDecider(opts.script ?? defaultScript());
  const rt = createRuntime({
    clock,
    global: globalThis,
    decider,
    mode: opts.mode ?? "observe",
    report: "silent",
    autoState: (opts.autoState ?? true) as never,
    ...(opts.telemetry ? { telemetry: opts.telemetry as never } : {}),
    ...(opts.triage ? { triage: opts.triage } : {}),
    observe: { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false },
  }) as RuntimeImpl;
  const R = loadReact(!!opts.prod);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = R.client.createRoot(container) as Env["root"];
  env = { rt, clock, server, decider, R, container, root };
  return env;
}

afterEach(async () => {
  if (env) {
    try {
      env.root.unmount();
    } catch {
      /* ignore */
    }
    env.rt.destroy();
  }
  env = null;
  G.fetch = realFetch;
  document.body.innerHTML = "";
  await drain();
});

/** Let React's scheduler (setImmediate in Node) render and commit. */
async function settle(): Promise<void> {
  await drain(8);
}

describe("autoState React (CONTRACT §4: observed-only stores)", () => {
  it("installs the DevTools hook before react-dom and taps its renderer", async () => {
    const e = start();
    const hook = G.__REACT_DEVTOOLS_GLOBAL_HOOK__ as { _genclass?: boolean; renderers: Map<number, unknown> };
    expect(hook._genclass).toBe(true);
    expect(hook.renderers.size).toBeGreaterThan(0);
    expect(e.rt.discoveryStats()?.react?.tapped).toBe(1);
  });

  it("records a component's useState change in an observed store named after it, with the op that called setState", async () => {
    const e = start();
    const { createElement: h, useState } = e.R.React;
    let set!: (v: unknown) => void;
    function SearchPage() {
      const [q, setQ] = useState("");
      const [results, setResults] = useState<string[]>([]);
      set = setResults as never;
      return h("div", null, q, results.join(","));
    }
    e.root.render(h(SearchPage));
    await settle();
    // mounting alone registers nothing
    expect(e.rt.stores().filter((s) => s.source === "react")).toEqual([]);
    const ops = e.rt.internals.ops;
    const opA = e.rt.startOp("fetch", "GET /api/search", { cause: null });
    e.rt.internals.ctx.run(opA, () => set(["Paris", "Pau"]));
    // the commit happens later, in React's scheduler task, where no op is ambient
    e.rt.internals.ctx.clear();
    await settle();
    const st = e.rt.stores().find((s) => s.name === "SearchPage");
    expect(st).toMatchObject({ kind: "observed", source: "react", writable: false });
    const f = e.rt.internals.hub.field("SearchPage.state1");
    expect(f?.writer).toBe(opA.id);
    expect(e.rt.internals.hub.valueAt("SearchPage.state1")).toEqual(["Paris", "Pau"]);
    expect(e.rt.internals.hub.valueAt("SearchPage.state0")).toBe("");
    expect(ops.get(opA.id)).toBe(opA);
    expect(e.container.textContent).toBe("Paris,Pau");
  });

  it("keeps setters stable across renders (effects depending on them do not re-run)", async () => {
    const e = start();
    const { createElement: h, useState, useEffect } = e.R.React;
    let runs = 0;
    let bump!: () => void;
    function Counter() {
      const [n, setN] = useState(0);
      useEffect(() => {
        runs++;
      }, [setN]);
      bump = () => setN((x: number) => x + 1);
      return h("span", null, String(n));
    }
    e.root.render(h(Counter));
    await settle();
    for (let i = 0; i < 3; i++) {
      bump();
      await settle();
    }
    expect(e.container.textContent).toBe("3");
    expect(runs).toBe(1);
    expect(e.rt.internals.hub.valueAt("Counter.state0")).toBe(3);
  });

  it("attributes each hook to its own writer when two ops' updates commit together", async () => {
    const e = start();
    const { createElement: h, useState } = e.R.React;
    let setA!: (v: unknown) => void;
    let setB!: (v: unknown) => void;
    function Board() {
      const [a, sa] = useState("a0");
      const [b, sb] = useState("b0");
      setA = sa as never;
      setB = sb as never;
      return h("i", null, a + b);
    }
    e.root.render(h(Board));
    await settle();
    const op1 = e.rt.startOp("fetch", "GET /api/a", { cause: null });
    const op2 = e.rt.startOp("fetch", "GET /api/b", { cause: null });
    e.rt.internals.ctx.run(op1, () => setA("a1"));
    e.rt.internals.ctx.run(op2, () => setB("b1"));
    e.rt.internals.ctx.clear();
    await settle();
    const hub = e.rt.internals.hub;
    expect(hub.field("Board.state0")?.writer).toBe(op1.id);
    expect(hub.field("Board.state1")?.writer).toBe(op2.id);
    // two writes, in the order the app made them
    expect(hub.get("Board")?.version).toBe(2);
  });

  it("marks user-sync writes as user writes", async () => {
    const e = start();
    const { createElement: h, useState } = e.R.React;
    let setQ!: (v: unknown) => void;
    function Box() {
      const [q, s] = useState("");
      setQ = s as never;
      return h("b", null, q);
    }
    e.root.render(h(Box));
    await settle();
    e.rt.user({ kind: "type", target: 'input "Search"', value: "pa" }, () => setQ("pa"));
    await settle();
    const hist = e.rt.internals.hub.field("Box.state0")?.hist ?? [];
    expect(hist.at(-1)?.user).toBe(true);
  });

  it("observes class component state and useReducer, skips internals, elements and anonymous components", async () => {
    const e = start();
    const { createElement: h, useReducer, useState, Component } = e.R.React;
    let inc!: () => void;
    let setEl!: (v: unknown) => void;
    let setAnon!: (v: unknown) => void;
    let cls!: { setState(s: unknown): void };
    function Cart() {
      const [s, dispatch] = useReducer((st: { n: number }, a: string) => (a === "inc" ? { n: st.n + 1 } : st), { n: 0 });
      const [el, se] = useState<unknown>(null);
      inc = () => dispatch("inc");
      setEl = se as never;
      return h("u", null, String(s.n), el as never);
    }
    class Wizard extends Component<object, { step: number; title: string }> {
      state = { step: 1, title: "Start" };
      render() {
        cls = this as never;
        return h("p", null, String(this.state.step));
      }
    }
    const Anon = (() => () => {
      const [x, s] = useState(0);
      setAnon = s as never;
      return h("s", null, String(x));
    })();
    function ErrorBoundary() {
      const [n, s] = useState(0);
      void s;
      return h("em", null, String(n));
    }
    e.root.render(h("div", null, h(Cart), h(Wizard), h(Anon), h(ErrorBoundary)));
    await settle();
    inc();
    setEl(h("b", null, "x"));
    setAnon(5);
    cls.setState({ step: 2 });
    await settle();
    const hub = e.rt.internals.hub;
    expect(hub.valueAt("Cart.state0.n")).toBe(1);
    expect(hub.valueAt("Cart.state1")).toBeNull(); // a React element is not app data: the field keeps its last data value
    expect(hub.field("Cart.state1")?.v).toBe(0);
    expect(hub.valueAt("Wizard.step")).toBe(2);
    expect(hub.valueAt("Wizard.title")).toBe("Start");
    const names = e.rt.stores().map((s) => s.name);
    expect(names).not.toContain("ErrorBoundary");
    expect(names.some((n) => n.startsWith("Anon"))).toBe(false);
  });

  it("caps instances per component type (Item, Item_2, Item_3) and frees a slot on unmount", async () => {
    const e = start();
    const { createElement: h, useState } = e.R.React;
    const sets: ((v: unknown) => void)[] = [];
    function Item({ i }: { i: number }) {
      const [v, s] = useState(0);
      sets[i] = s as never;
      return h("li", null, String(v));
    }
    e.root.render(h("ul", null, [0, 1, 2, 3, 4].map((i) => h(Item, { key: i, i }))));
    await settle();
    for (const s of sets) s(1);
    await settle();
    const names = e.rt.stores().filter((s) => s.source === "react").map((s) => s.name).sort();
    expect(names).toEqual(["Item", "Item_2", "Item_3"]);
    // unmount the first three: a later instance reuses a freed slot's store
    e.root.render(h("ul", null, [3, 4].map((i) => h(Item, { key: i, i }))));
    await settle();
    sets[3](7);
    await settle();
    const vals = ["Item", "Item_2", "Item_3"].map((n) => e.rt.internals.hub.valueAt(`${n}.state0`));
    expect(vals).toContain(7);
  });

  it("redacts a state that holds what a password input holds", async () => {
    const e = start();
    const { createElement: h, useState } = e.R.React;
    let setPw!: (v: unknown) => void;
    function Login() {
      const [pw, s] = useState("");
      setPw = s as never;
      return h("input", { type: "password", value: pw, onChange: () => {} });
    }
    e.root.render(h(Login));
    await settle();
    setPw("hunter2");
    await settle();
    const hub = e.rt.internals.hub;
    expect(hub.valueAt("Login.state0")).toBe("[redacted]");
    setPw("hunter22");
    await settle();
    expect(hub.valueAt("Login.state0")).toBe("[redacted]");
    expect(JSON.stringify(e.rt.history())).not.toContain("hunter2");
  });

  it("is off by default with createRuntime and with autoState: { react: false }", async () => {
    const e = start({ autoState: { react: false } });
    expect(G.__REACT_DEVTOOLS_GLOBAL_HOOK__).toBeUndefined();
    expect(e.rt.discoveryStats()?.react).toBeNull();
  });

  it("chains onto an existing DevTools hook and calls it first", async () => {
    const calls: string[] = [];
    const renderers = new Map<number, unknown>();
    G.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers,
      supportsFiber: true,
      inject(r: unknown) {
        calls.push("inject");
        renderers.set(1, r);
        return 1;
      },
      onCommitFiberRoot() {
        calls.push("commit");
      },
      onCommitFiberUnmount() {},
    };
    const clock = new FakeClock();
    const rt = createRuntime({ clock, global: globalThis, decider: null, report: "silent", autoState: true, observe: { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false } }) as RuntimeImpl;
    const R = loadReact(false);
    const c = document.createElement("div");
    const root = R.client.createRoot(c) as Env["root"];
    let set!: (v: unknown) => void;
    function Panel() {
      const [v, s] = R.React.useState(0);
      set = s as never;
      return R.React.createElement("i", null, String(v));
    }
    root.render(R.React.createElement(Panel));
    await settle();
    set(4);
    await settle();
    expect(calls[0]).toBe("inject");
    expect(calls.filter((x) => x === "commit").length).toBeGreaterThanOrEqual(2);
    expect(rt.internals.hub.valueAt("Panel.state0")).toBe(4);
    root.unmount();
    rt.destroy();
    delete G.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  });

  it("never throws into React when recording fails, and turns itself off after repeated errors", async () => {
    const e = start();
    const { createElement: h, useState } = e.R.React;
    let set!: (v: unknown) => void;
    function Widget() {
      const [v, s] = useState(0);
      set = s as never;
      return h("i", null, String(v));
    }
    e.root.render(h(Widget));
    await settle();
    const hub = e.rt.internals.hub as unknown as { observe: () => never };
    const orig = hub.observe;
    hub.observe = () => {
      throw new Error("boom");
    };
    for (let i = 1; i <= 6; i++) {
      set(i);
      await settle();
    }
    hub.observe = orig;
    expect(e.container.textContent).toBe("6");
    expect(e.rt.discoveryStats()?.react?.errors).toBe(5);
  });
});

describe("autoState React: delivery decisions on discovered state (situation-v2 delivery trigger)", () => {
  it("decides an out-of-order response that would write over newer React state", async () => {
    const e = start();
    const { createElement: h, useState } = e.R.React;
    let setResults!: (v: unknown) => void;
    function Typeahead() {
      const [results, s] = useState<string[]>([]);
      setResults = s as never;
      return h("ol", null, results.join("|"));
    }
    e.root.render(h(Typeahead));
    await settle();
    let n = 0;
    e.server.on("GET", "/api/cities", (r) => {
      n++;
      const q = r.url.searchParams.get("q");
      return { body: { q, items: [`${q}-1`] }, latency: n === 2 ? 300 : n === 3 ? 50 : 50 };
    });
    const search = (q: string) =>
      (G.fetch as typeof fetch)(`/api/cities?q=${q}`)
        .then((r) => r.json())
        .then((d: { items: string[] }) => setResults(d.items));
    // warm-up: the runtime learns what this request's chain writes
    void search("p");
    await e.clock.advance(100);
    await settle();
    expect(e.rt.internals.hub.field("Typeahead.state0")?.writer).not.toBeNull();
    // "pa" is slow, "par" is fast: the "pa" response arrives over the newer "par" results
    void search("pa");
    await e.clock.advance(10);
    void search("par");
    await e.clock.advance(100);
    await settle();
    expect(e.container.textContent).toBe("par-1");
    await e.clock.advance(400);
    await settle();
    await e.clock.advance(50);
    const delivery = e.rt.decisions().filter((d) => d.trigger === "delivery");
    expect(delivery.length).toBeGreaterThanOrEqual(1);
    // observed-only: a delivery discard is never offered on React state; defer only when related work is in flight
    const notOffered = e.decider.calls.filter((c) => c.trigger === "delivery").map((c) => c.notOffered ?? {});
    expect(notOffered.some((no) => typeof no.discard === "string" && no.discard.includes("observed-only"))).toBe(true);
    expect(e.container.textContent).toBe("pa-1"); // observe never changes what the app does
  });

  it("offers no write action on a mutation of an observed store, even in guard mode", async () => {
    const e = start({ mode: "guard" });
    const { createElement: h, useState } = e.R.React;
    let set!: (v: unknown) => void;
    function Feed() {
      const [items, s] = useState<number[]>([]);
      set = s as never;
      return h("ol", null, items.join(","));
    }
    e.root.render(h(Feed));
    await settle();
    (e.rt as unknown as { triage: string }).triage = "always";
    const op = e.rt.startOp("fetch", "GET /api/feed", { cause: null });
    e.rt.internals.ctx.run(op, () => set([1, 2]));
    e.rt.internals.ctx.clear();
    await settle();
    await e.clock.advance(10);
    const m = e.decider.calls.find((c) => c.trigger === "mutation");
    expect(m).toBeTruthy();
    expect(Object.keys(m!.notOffered ?? {})).toEqual(expect.arrayContaining(["discard", "defer"]));
    expect(e.rt.interventions()).toEqual([]);
    expect(e.container.textContent).toBe("1,2");
  });
});

describe("autoState React: devtools overlay and telemetry", () => {
  it("the overlay's Now view lists discovered stores as observed only", async () => {
    const e = start();
    const { createElement: h, useState } = e.R.React;
    let set!: (v: unknown) => void;
    function Checkout() {
      const [step, s] = useState(1);
      set = s as never;
      return h("i", null, String(step));
    }
    e.root.render(h(Checkout));
    await settle();
    set(2);
    await settle();
    const { mountDevtools } = await import("../src/devtools/index.js");
    const dt = mountDevtools(e.rt, { collapsed: false, tab: "now" });
    await new Promise((r) => setTimeout(r, 40));
    const text = dt.element!.shadowRoot!.querySelector('[data-part="stores"]')?.textContent ?? "";
    expect(text).toContain("Checkout: discovered (react), observed only, 1 field, 1 write");
    dt.unmount();
  });

  it("telemetry sends discovered state like registered stores and marks the decision autoState", async () => {
    const sent: { events: { t: string; situation?: string; autoState?: boolean }[] }[] = [];
    const transport = { send: (_u: string, body: string) => void sent.push(JSON.parse(body)) };
    const e = start({ telemetry: { transport, flushMs: 1000 }, triage: "always" });
    const { createElement: h, useState } = e.R.React;
    let set!: (v: unknown) => void;
    function Basket() {
      const [items, s] = useState<string[]>([]);
      set = s as never;
      return h("i", null, items.join(","));
    }
    e.root.render(h(Basket));
    await settle();
    const op = e.rt.startOp("fetch", "GET /api/basket", { cause: null });
    e.rt.internals.ctx.run(op, () => set(["naan"]));
    e.rt.internals.ctx.clear();
    await settle();
    await e.clock.advance(1500);
    await e.rt.telemetry?.flush();
    const decisions = sent.flatMap((b) => b.events).filter((x) => x.t === "decision");
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((d) => d.autoState === true)).toBe(true);
    expect(decisions.some((d) => d.situation?.includes("Basket.state0"))).toBe(true);
  });
});

describe("autoState React: cost bounds", () => {
  it("walks only re-rendered fibers: one row of 500 changes, the other rows' subtrees are not entered", async () => {
    const e = start();
    const { createElement: h, useState, memo } = e.R.React;
    const sets: ((v: unknown) => void)[] = [];
    const Row = memo(function Row({ i }: { i: number }) {
      const [v, s] = useState(0);
      sets[i] = s as never;
      return h("li", null, h("span", null, h("b", null, String(v))));
    });
    e.root.render(h("ul", null, Array.from({ length: 500 }, (_, i) => h(Row, { key: i, i }))));
    await settle();
    const before = e.rt.discoveryStats()!.react!;
    sets[250](1);
    await settle();
    const after = e.rt.discoveryStats()!.react!;
    expect(after.commits - before.commits).toBe(1);
    // React clones the changed row's 500 siblings (each compared in O(1)); none of their 1,500 descendants is visited
    expect(after.visited - before.visited).toBeLessThan(520);
    expect(e.rt.internals.hub.valueAt("Row.state0")).toBe(1);
  });

  it("stops a commit walk at the time budget", async () => {
    const e = start();
    const { createElement: h, useState } = e.R.React;
    const sets: ((v: unknown) => void)[] = [];
    function Cell({ i }: { i: number }) {
      const [v, s] = useState(0);
      sets[i] = s as never;
      return h("td", null, String(v));
    }
    let bumpAll!: () => void;
    function Grid() {
      const [n, s] = useState(0);
      bumpAll = () => s((x: number) => x + 1);
      return h("tr", { "data-n": n }, Array.from({ length: 200 }, (_, i) => h(Cell, { key: i, i })));
    }
    e.root.render(h(Grid));
    await settle();
    // every clock read now costs 0.2 ms: the walk gives up after its 1 ms budget
    const clock = e.clock as unknown as { now(): number; t: number };
    const now = clock.now.bind(clock);
    clock.now = () => (clock.t += 0.2, now());
    bumpAll();
    await settle();
    clock.now = now;
    const st = e.rt.discoveryStats()!.react!;
    expect(st.overBudget).toBeGreaterThanOrEqual(1);
    expect(st.visited).toBeLessThan(400);
  });

  it("leaves a foreign dispatcher's own lookups to it (React DevTools' inspection Proxy keeps throwing its own error)", () => {
    start();
    const hook = G.__REACT_DEVTOOLS_GLOBAL_HOOK__ as { inject(r: unknown): number };
    const ref: { H: unknown } = { H: null };
    hook.inject({ currentDispatcherRef: ref, rendererPackageName: "test" });
    const target = { useState: (v: unknown) => [v, () => {}], useReducer: (_r: unknown, v: unknown) => [v, () => {}], useContext: () => "ctx" };
    const proxy = new Proxy(target, {
      get(t, k) {
        if (Object.prototype.hasOwnProperty.call(t, k)) return (t as Record<PropertyKey, unknown>)[k];
        throw Object.assign(new Error(`Missing method in Dispatcher: ${String(k)}`), { name: "ReactDebugToolsUnsupportedHookError" });
      },
    });
    ref.H = proxy;
    const d = ref.H as Record<string, (...a: unknown[]) => unknown>;
    expect(d.useContext()).toBe("ctx");
    expect(() => d.useMemoCache).toThrow(/Missing method in Dispatcher/);
    const [, set1] = d.useState(1) as [unknown, unknown];
    expect(typeof set1).toBe("function");
    ref.H = null;
    expect(ref.H).toBeNull();
  });
});

describe("autoState React: names in production builds", () => {
  it("names a minified component's store after the element it renders; skips error boundaries", async () => {
    const e = start();
    const { createElement: h, useState, Component } = e.R.React;
    let setA!: (v: unknown) => void;
    let setB!: (v: unknown) => void;
    let boundary!: { setState(s: unknown): void };
    const t = function () {
      const [n, s] = useState(0);
      setA = s as never;
      return h("a", { "data-state": "open", "data-order-chip": "menu" }, String(n));
    };
    Object.defineProperty(t, "name", { value: "t" });
    const Xe = function () {
      const [n, s] = useState(0);
      setB = s as never;
      return h("section", { "aria-label": "Live cart" }, String(n));
    };
    Object.defineProperty(Xe, "name", { value: "Xe" });
    class Guard extends Component<{ children?: unknown }, { error: unknown; path: string }> {
      static getDerivedStateFromError(error: unknown) {
        return { error };
      }
      state = { error: null, path: "/" };
      render() {
        boundary = this as never;
        return this.props.children as never;
      }
    }
    e.root.render(h(Guard, null, h(t), h(Xe)));
    await settle();
    setA(1);
    setB(2);
    boundary.setState({ path: "/menu" });
    await settle();
    const names = e.rt.stores().map((s) => s.name).sort();
    expect(names).toEqual(["liveCart", "orderChip"]);
    expect(e.rt.internals.hub.valueAt("orderChip.state0")).toBe(1);
  });
});
