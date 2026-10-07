// Zustand middleware: set/setState through the pipeline with Zustand's semantics (merge, replace, functional),
// held writes applied later on top of newer state (or dropped), extra set() args, GenClass writes.
import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { genclass } from "../src/adapters/zustand.js";
import type { Runtime } from "../src/types.js";
import { MockRuntime } from "./browser/ui/mock-runtime.js";
import { defaultScript, ManualDecider, setup } from "./helpers.js";

interface Search {
  query: string;
  results: string[];
  setQuery(q: string): void;
  setResults(r: string[]): void;
}

function makeStore(rt: Runtime | null) {
  return createStore<Search>()(
    genclass(rt, "search")((set) => ({
      query: "",
      results: [],
      setQuery: (q) => set({ query: q }),
      setResults: (r) => set((s) => ({ ...s, results: r })),
    })),
  );
}

describe("genclass zustand middleware (scripted runtime)", () => {
  it("applies writes through the pipeline with zustand's merge semantics", () => {
    const rt = new MockRuntime();
    const store = makeStore(rt);
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().setQuery("re");
    expect(store.getState().query).toBe("re");
    expect(typeof store.getState().setResults).toBe("function"); // merged, actions kept
    expect(listener).toHaveBeenCalledTimes(1);
    expect(rt.calls.sets).toEqual(["search"]);
    store.setState({ results: ["a"] }); // external setState goes through too
    expect(store.getState()).toMatchObject({ query: "re", results: ["a"] });
    expect(rt.calls.sets).toEqual(["search", "search"]);
  });

  it("holds async writes and applies them later on top of newer state; drops discarded ones", () => {
    const rt = new MockRuntime();
    rt.holdWrites = true;
    const store = makeStore(rt);
    const listener = vi.fn();
    store.subscribe(listener);
    store.getState().setResults(["rea results"]); // held
    expect(store.getState().results).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    rt.user({ kind: "type" }, () => store.getState().setQuery("react")); // user write: now
    expect(store.getState().query).toBe("react");
    rt.flushHeld();
    expect(store.getState()).toMatchObject({ query: "react", results: ["rea results"] }); // newer query kept
    expect(listener).toHaveBeenCalledTimes(2);

    store.getState().setResults(["stale"]);
    rt.dropHeld();
    expect(store.getState().results).toEqual(["rea results"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("supports replace, functional updates, no-ops and extra set() arguments", () => {
    const rt = new MockRuntime();
    const outerCalls: unknown[][] = [];
    const spyMw = (creator: Parameters<ReturnType<typeof genclass>>[0]) =>
      ((set: (...a: unknown[]) => void, get: unknown, api: unknown) =>
        (creator as unknown as (s: unknown, g: unknown, a: unknown) => unknown)(
          (...a: unknown[]) => {
            outerCalls.push(a);
            return set(...a);
          },
          get,
          api,
        )) as unknown as typeof creator;
    const store = createStore<{ n: number }>()(
      spyMw(
        genclass(rt, "counter")(() => ({ n: 0 })) as never,
      ) as never,
    );
    store.setState((s) => ({ n: s.n + 1 }));
    expect(store.getState().n).toBe(1);
    store.setState({ n: 5 }, true);
    expect(store.getState()).toEqual({ n: 5 });
    const before = store.getState();
    store.setState((s) => s); // no-op keeps the same object
    expect(store.getState()).toBe(before);
    (store.setState as (p: unknown, r?: boolean, name?: string) => void)({ n: 6 }, false, "counter/set");
    expect(outerCalls[outerCalls.length - 1]).toEqual([{ n: 6 }, true, "counter/set"]);
  });

  it("lets GenClass write the whole state back (rollback, resync)", () => {
    const rt = new MockRuntime();
    const store = makeStore(rt);
    store.getState().setQuery("x");
    const snapshot = { ...store.getState(), query: "" };
    rt.genclassWrite("search", snapshot);
    expect(store.getState()).toBe(snapshot);
  });

  it("runs the creator unchanged without a runtime", () => {
    const store = makeStore(null);
    store.getState().setQuery("q");
    expect(store.getState().query).toBe("q");
  });
});

describe("genclass zustand middleware + the real runtime", () => {
  it("holds a salient async set for the model; apply and discard behave like Zustand would", async () => {
    const decider = new ManualDecider();
    const S = setup({ decider, triage: "always" });
    const store = makeStore(S.rt);
    const listener = vi.fn();
    store.subscribe(listener);

    S.rt.user({ kind: "type", target: 'input "Search"', value: "react" }, () => store.getState().setQuery("react"));
    expect(store.getState().query).toBe("react");
    expect(decider.pending).toHaveLength(0);
    await S.clock.flush(); // end of the user's task: later async work is not part of the user action

    await S.rt.op("load", async () => store.getState().setResults(["react", "react-dom"]));
    await S.clock.flush();
    expect(decider.pending.map((p) => p.req.trigger)).toEqual(["mutation"]);
    expect(store.getState().results).toEqual([]);
    decider.answer();
    await S.clock.flush();
    expect(store.getState().results).toEqual(["react", "react-dom"]);

    await S.rt.op("load", async () => store.getState().setResults(["rea"]));
    await S.clock.flush();
    decider.answer(defaultScript({ mutation: { diagnosis: "stale", action: "discard", p: 0.97 } }));
    await S.clock.flush();
    expect(store.getState().results).toEqual(["react", "react-dom"]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(S.rt.interventions().map((a) => a.action)).toEqual(["discard"]);
    const states = S.rt.history().filter((e) => e.kind === "state");
    expect(states.map((e) => e.data?.paths)).toEqual([["search.query"], ["search.results"]]);
    S.rt.destroy();
  });
});
