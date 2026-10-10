// @vitest-environment happy-dom
// Invariant suite, automatically discovered state (InitOptions.autoState; src/discover/react.ts, redux.ts; CONTRACT §4
// observed-only stores). Guarantee: React component state and Redux-DevTools-`connect` stores (Zustand's devtools
// middleware) are observe-only. GenClass records their changes but never holds, drops, reverts, rolls back or
// resyncs them, whatever the model answers. The model is an Adversary (probability 1 on the most disruptive offered
// action) in heal mode at the eager profile, every situation consulted, store holds on, and only the state actions
// permitted (so request-level actions such as block cannot change what the app receives).
import { afterEach, describe, expect, it } from "vitest";
import "../discover-register.js";
import { createStore as createZustand } from "zustand/vanilla";
import { devtools } from "zustand/middleware";
import { createRuntime } from "../../src/index.js";
import type { RuntimeImpl } from "../../src/runtime.js";
import { drain, FakeClock, FakeServer } from "../helpers.js";
import { loadReact } from "../discover-react-load.js";
import { Adversary, harmful } from "./adversary.js";

const G = globalThis as unknown as Record<string, unknown>;
const realFetch = G.fetch;
const OBSERVE = { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false };
const STATE_ACTIONS = ["discard", "defer", "rollback", "resync"];
let cleanup: (() => void)[] = [];

afterEach(async () => {
  for (const c of cleanup.splice(0)) {
    try {
      c();
    } catch {
      /* ignore */
    }
  }
  G.fetch = realFetch;
  delete G.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  for (const k of ["__REDUX_DEVTOOLS_EXTENSION_COMPOSE__", "__REDUX_DEVTOOLS_EXTENSION__"]) delete G[k];
  document.body.innerHTML = "";
  await drain();
});

const settle = () => drain(8);

interface Run {
  rt: RuntimeImpl | null;
  adv: Adversary | null;
  text: string;
  bag: { items: string[]; total: number };
  /** Every value the Zustand store held right after each app write, next to what the app wrote. */
  zustandWrites: { wrote: unknown; held: unknown }[];
}

/** A typeahead in React state and a cart in a Zustand devtools store, fed by out-of-order responses. */
async function app(withGenClass: boolean): Promise<Run> {
  const clock = new FakeClock();
  const server = new FakeServer(clock);
  G.fetch = server.fetch;
  delete G.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  for (const k of ["__REDUX_DEVTOOLS_EXTENSION_COMPOSE__", "__REDUX_DEVTOOLS_EXTENSION__"]) delete G[k];
  let rt: RuntimeImpl | null = null;
  let adv: Adversary | null = null;
  if (withGenClass) {
    adv = new Adversary(harmful);
    adv.clock = clock;
    rt = createRuntime({
      clock,
      global: globalThis,
      decider: adv,
      mode: "heal",
      aggressiveness: "eager",
      triage: "always",
      breaker: false,
      report: "silent",
      autoState: true,
      policy: { holdWrites: true, allow: STATE_ACTIONS },
      observe: OBSERVE,
    }) as RuntimeImpl;
    const r = rt;
    cleanup.push(() => r.destroy());
    // an app invariant that never holds: inconsistency triggers on the discovered stores (rollback candidates)
    rt.expect("cart total matches items", () => false);
  }
  const R = loadReact(false);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = R.client.createRoot(container) as { render(n: unknown): void; unmount(): void };
  cleanup.push(() => root.unmount());
  const { createElement: h, useState } = R.React;
  let setResults!: (v: unknown) => void;
  function Typeahead() {
    const [results, s] = useState<string[]>([]);
    setResults = s as never;
    return h("ol", null, results.join("|"));
  }
  root.render(h(Typeahead));
  await settle();
  const bag = createZustand<{ items: string[]; total: number }>()(devtools(() => ({ items: [] as string[], total: 0 }), { name: "bag" }));
  const zustandWrites: Run["zustandWrites"] = [];
  server.on("GET", "/api/cities", ({ url }) => {
    const q = url.searchParams.get("q") ?? "";
    return { body: { items: [`${q}-1`] }, latency: q === "pa" ? 300 : 50 };
  });
  server.on("GET", "/api/price", ({ url }) => {
    const i = url.searchParams.get("i") ?? "";
    return { body: { item: i, price: i.length }, latency: i === "slow" ? 400 : 40 };
  });
  const search = (q: string) =>
    (G.fetch as typeof fetch)(`/api/cities?q=${q}`)
      .then((r) => r.json())
      .then((d: { items: string[] }) => setResults(d.items));
  const add = (i: string) =>
    (G.fetch as typeof fetch)(`/api/price?i=${i}`)
      .then((r) => r.json())
      .then((d: { item: string; price: number }) => {
        const next = { items: [...bag.getState().items, d.item], total: bag.getState().total + d.price };
        bag.setState(next);
        zustandWrites.push({ wrote: next, held: { ...bag.getState() } });
      });
  for (let round = 0; round < 3; round++) {
    void search("p");
    void add("rice");
    await clock.advance(200);
    await settle();
    // "pa" and "slow" answer after "par" and "tea": their writes land over newer state
    void search("pa");
    void add("slow");
    await clock.advance(10);
    void search("par");
    void add("tea");
    await clock.advance(1000);
    await settle();
    await clock.advance(1000);
    await settle();
  }
  return { rt, adv, text: container.textContent ?? "", bag: { ...bag.getState() }, zustandWrites };
}

describe("invariant: discovered React and Zustand state is observe-only", () => {
  it("heal, a hostile model, store holds on, every situation consulted: the app's React and Zustand state equal the run without GenClass", async () => {
    const base = await app(false);
    for (const c of cleanup.splice(0)) c();
    const run = await app(true);
    const rt = run.rt!;
    expect(run.text).toBe(base.text);
    expect(run.bag).toEqual(base.bag);
    // every Zustand write held exactly what the app wrote, at once (never held or dropped)
    expect(run.zustandWrites.length).toBe(base.zustandWrites.length);
    for (const w of run.zustandWrites) expect(w.held).toEqual(w.wrote);
    // both stores were discovered, as observed-only (not writable)
    const found = rt.stores().filter((s) => s.source);
    expect(found.map((s) => s.name).sort()).toEqual(["Typeahead", "bag"]);
    expect(found.every((s) => s.kind === "observed" && !s.writable)).toBe(true);
    // the model was consulted about their writes, but no state action was ever offered on them or ran
    const mutations = run.adv!.calls.filter((c) => c.trigger === "mutation");
    expect(mutations.length).toBeGreaterThan(0);
    for (const m of mutations) {
      expect(m.notOffered?.discard).toMatch(/observed only/);
      expect(m.notOffered?.defer).toMatch(/observed only/);
    }
    expect(run.adv!.calls.some((c) => c.trigger === "inconsistency")).toBe(true);
    expect(rt.interventions().filter((a) => STATE_ACTIONS.includes(a.action) && a.trigger !== "delivery")).toEqual([]);
    // a delivery discard may run on a response (its writes to registered stores could be dropped), but it never drops a
    // write to discovered state: the hub only records those
    expect(rt.interventions().flatMap((a) => a.dropped ?? [])).toEqual([]);
    // GenClass never wrote a discovered field: every write in their logs comes from the app's own ops
    const hub = rt.internals.hub;
    for (const s of found)
      for (const f of hub.get(s.name)!.fields.values())
        for (const e of f.log) expect(e.writer === null || !rt.internals.ops.get(e.writer)?.genclass).toBe(true);
  });
});
