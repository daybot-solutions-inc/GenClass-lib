// @vitest-environment happy-dom
// React bindings with react-dom: shared named state, held writes applied later (or never), StrictMode, live
// decision feeds; first against a scripted runtime, then against the real runtime with a hand-released decider.
import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GenClassProvider,
  getGenClassAtom,
  useAtom,
  useGenClass,
  useGenClassDecisions,
  useGenClassInterventions,
  useGenClassState,
  useGenClassStatus,
} from "../src/adapters/react.js";
import type { Runtime } from "../src/types.js";
import { MockRuntime, makeAction, makeDecision } from "./browser/ui/mock-runtime.js";
import { defaultScript, ManualDecider, setup } from "./helpers.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement;

function render(node: ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const text = (sel: string): string | null | undefined => container.querySelector(sel)?.textContent;
const withRt = (rt: Runtime | null, ...children: ReactNode[]) => createElement(GenClassProvider, { runtime: rt }, ...children);

describe("useGenClassState", () => {
  it("shares one runtime atom per name and re-renders every user of it", () => {
    const rt = new MockRuntime();
    const atomSpy = vi.spyOn(rt, "atom");
    function Counter({ id }: { id: string }) {
      const [n, setN] = useGenClassState("count", 0);
      return createElement("button", { id, onClick: () => setN((v) => v + 1) }, String(n));
    }
    render(withRt(rt, createElement(Counter, { id: "a" }), createElement(Counter, { id: "b" })));
    expect(text("#a")).toBe("0");
    act(() => rt.user({ kind: "click", target: 'button "+"' }, () => (container.querySelector("#a") as HTMLButtonElement).click()));
    expect(text("#a")).toBe("1");
    expect(text("#b")).toBe("1");
    expect(atomSpy).toHaveBeenCalledTimes(1);
    expect(getGenClassAtom<number>(rt, "count")?.get()).toBe(1);
    expect(rt.events.filter((e) => e.kind === "state" && e.name === "count")).toHaveLength(1);
  });

  it("shows a held write only when the runtime applies it, and never when it drops it", () => {
    const rt = new MockRuntime();
    rt.holdWrites = true;
    let set!: (v: string | ((p: string) => string)) => void;
    function Results() {
      const [v, s] = useGenClassState("search", "react results");
      set = s;
      return createElement("span", { id: "v" }, v);
    }
    render(withRt(rt, createElement(Results)));
    act(() => set("stale results")); // an async write (no user handler): held
    expect(text("#v")).toBe("react results");
    expect(rt.heldCount).toBe(1);
    act(() => rt.dropHeld()); // discard
    expect(text("#v")).toBe("react results");

    act(() => set((p) => `${p} + page 2`)); // held functional update…
    act(() => rt.user({ kind: "type" }, () => set("typed"))); // …a user write lands first…
    expect(text("#v")).toBe("typed");
    act(() => rt.flushHeld()); // …and the held update re-runs on top of it
    expect(text("#v")).toBe("typed + page 2");
  });

  it("is StrictMode-safe: one atom, balanced subscriptions, working updates", () => {
    const rt = new MockRuntime();
    const atomSpy = vi.spyOn(rt, "atom");
    const init = vi.fn(() => ({ items: [] as string[] }));
    let set!: (v: { items: string[] } | ((p: { items: string[] }) => { items: string[] })) => void;
    function Cart() {
      const [cart, s] = useGenClassState("cart", init);
      set = s;
      return createElement("i", { id: "n" }, String(cart.items.length));
    }
    render(createElement(StrictMode, null, withRt(rt, createElement(Cart), createElement(Cart))));
    expect(atomSpy).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(rt.subscribers("cart")).toBe(2);
    act(() => rt.user({ kind: "click" }, () => set((c) => ({ items: [...c.items, "lamp"] }))));
    expect(text("#n")).toBe("1");
    act(() => root!.unmount());
    root = null;
    expect(rt.subscribers("cart")).toBe(0);
  });

  it("falls back to plain React state without a runtime", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let set!: (v: number) => void;
    function C() {
      const [v, s] = useGenClassState("x", () => 41);
      set = s;
      return createElement("b", { id: "x" }, String(v));
    }
    render(withRt(null, createElement(C)));
    expect(text("#x")).toBe("41");
    act(() => set(42));
    expect(text("#x")).toBe("42");
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain("no runtime");
    info.mockRestore();
  });
});

describe("useAtom, useGenClass and the live feeds", () => {
  it("subscribes to an existing atom", () => {
    const rt = new MockRuntime();
    const cart = rt.atom("cart", { total: 0 });
    let set!: (v: { total: number }) => void;
    function Total() {
      const [c, s] = useAtom(cart);
      set = s;
      return createElement("b", { id: "t" }, String(c.total));
    }
    render(createElement(Total));
    act(() => rt.user({ kind: "click" }, () => cart.set({ total: 84.97 })));
    expect(text("#t")).toBe("84.97");
    act(() => rt.user({ kind: "click" }, () => set({ total: 0 })));
    expect(cart.get().total).toBe(0);
  });

  it("useGenClass returns the provided runtime and throws without one", () => {
    const rt = new MockRuntime();
    const out: string[] = [];
    function Probe() {
      try {
        out.push(useGenClass() === rt ? "rt" : "other");
      } catch (e) {
        out.push((e as Error).message);
      }
      return null;
    }
    render(withRt(rt, createElement(Probe)));
    act(() => root!.unmount());
    root = null;
    render(createElement(Probe));
    expect(out[0]).toBe("rt");
    expect(out[out.length - 1]).toContain("No runtime");
  });

  it("useGenClassDecisions / Interventions / Status update live with stable snapshots", () => {
    const rt = new MockRuntime();
    let renders = 0;
    function Feed() {
      const ds = useGenClassDecisions(10);
      const as = useGenClassInterventions();
      const s = useGenClassStatus();
      renders++;
      return createElement("i", { id: "f" }, `${ds.length}/${as.length}/${s.state}${s.progress ? ` ${s.progress.loaded}` : ""}`);
    }
    render(withRt(rt, createElement(Feed)));
    expect(text("#f")).toBe("0/0/off");
    const d = makeDecision({ id: "d1", trigger: "request", at: 5, diagnosisProbabilities: { duplicate: 0.95, expected: 0.05 }, probabilities: { coalesce: 0.96, send: 0.04 }, tier: "guard", executed: true });
    act(() => void rt.decision(d));
    expect(text("#f")).toBe("1/0/off");
    act(() => void rt.act(makeAction(d, { id: "a1", changed: "Reused the response." })));
    expect(text("#f")).toBe("1/1/off");
    // a provider that mutates its status object in place still re-renders
    const status = { state: "loading" as const, progress: { loaded: 1, total: 10 } };
    act(() => rt.setStatus(status));
    expect(text("#f")).toBe("1/1/loading 1");
    status.progress.loaded = 5;
    act(() => rt.emitTo("status", status));
    expect(text("#f")).toBe("1/1/loading 5");
    expect(renders).toBeLessThan(12);
  });
});

describe("react + the real runtime", () => {
  it("holds a salient async write until the model answers; discard keeps the screen as it was", async () => {
    const decider = new ManualDecider();
    const S = setup({ decider, triage: "always", observe: { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false } });
    S.server.on("GET", "/api/search", ({ url }) => ({ body: { items: [`${url.searchParams.get("q")} results`] }, latency: 80 }));
    let set!: (v: string[]) => void;
    function Results() {
      const [items, s] = useGenClassState<string[]>("results", []);
      set = s;
      return createElement("ul", { id: "r" }, items.join(","));
    }
    render(withRt(S.rt, createElement(Results)));

    const load = (q: string) =>
      S.fetch(`/api/search?q=${q}`)
        .then((r) => r.json())
        .then((d: { items: string[] }) => set(d.items));
    // 1) apply
    await act(async () => {
      void load("react");
      await S.clock.flush();
    });
    expect(decider.pending.map((p) => p.req.trigger)).toEqual(["request"]);
    decider.answer(); // send
    await act(async () => S.clock.advance(100));
    expect(decider.pending.map((p) => p.req.trigger)).toEqual(["mutation"]);
    expect(text("#r")).toBe(""); // held
    await act(async () => {
      decider.answer(); // expected → apply
      await S.clock.flush();
    });
    expect(text("#r")).toBe("react results");

    // 2) discard
    await act(async () => {
      void load("rea");
      await S.clock.flush();
    });
    decider.answer();
    await act(async () => S.clock.advance(100));
    await act(async () => {
      decider.answer(defaultScript({ mutation: { diagnosis: "stale", action: "discard", p: 0.97 } }));
      await S.clock.flush();
    });
    expect(text("#r")).toBe("react results");
    expect(S.rt.interventions().map((a) => a.action)).toEqual(["discard"]);

    // undo applies the dropped write after all
    await act(async () => {
      S.rt.interventions()[0].undo?.();
      await S.clock.flush();
    });
    expect(text("#r")).toBe("rea results");
    S.rt.destroy();
  });

  it("never holds writes made synchronously in a user handler", async () => {
    const decider = new ManualDecider();
    const S = setup({ decider, triage: "always" });
    let set!: (v: string) => void;
    function Q() {
      const [q, s] = useGenClassState("query", "");
      set = s;
      return createElement("b", { id: "q" }, q);
    }
    render(withRt(S.rt, createElement(Q)));
    act(() => S.rt.user({ kind: "type", target: 'input "Search"', value: "re" }, () => set("re")));
    expect(text("#q")).toBe("re");
    expect(decider.pending.length).toBe(0);
    S.rt.destroy();
  });
});
