import { describe, expect, it } from "vitest";
import { createRuntime, stateText } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { FakeClock, FakeServer, ScriptedDecider, defaultScript, makeGlobal } from "./helpers.js";

function setup(script = defaultScript()) {
  const clock = new FakeClock();
  const server = new FakeServer(clock);
  const g = makeGlobal(server);
  const decider = new ScriptedDecider(script);
  const rt = createRuntime({ clock, global: g, decider, mode: "guard", report: "silent", observe: { fetch: true } }) as RuntimeImpl;
  return { clock, server, g, decider, rt, fetch: (u: string, i?: RequestInit) => (g.fetch as typeof fetch)(u, i) };
}

describe("smoke", () => {
  it("atoms apply synchronously when nothing is salient", () => {
    const { rt, decider } = setup();
    const a = rt.atom("cart", { items: [] as number[], total: 0 });
    a.set({ items: [1], total: 1 });
    expect(a.get()).toEqual({ items: [1], total: 1 });
    a.update((p) => ({ ...p, total: p.total + 1 }));
    expect(a.get().total).toBe(2);
    expect(decider.calls.length).toBe(0);
    const ev = rt.history().filter((e) => e.kind === "state");
    expect(ev.length).toBe(2);
  });

  it("propagates context through real awaits: user -> fetch -> json -> set", async () => {
    const { rt, clock, server, fetch } = setup();
    server.on("GET", "/api/items", { body: [{ id: 1 }], latency: 80 });
    const items = rt.atom("items", [] as unknown[]);
    let done = false;
    rt.user({ kind: "click", target: 'button "Load"' }, () => {
      void (async () => {
        const res = await fetch("/api/items");
        const data = await res.json();
        items.set(data);
        done = true;
      })();
    });
    await clock.advance(200);
    expect(done).toBe(true);
    const st = rt.history().find((e) => e.kind === "state" && e.name === "items")!;
    const fetchOp = rt.ops.get(st.op)!;
    expect(fetchOp.kind).toBe("fetch");
    expect(fetchOp.name).toBe("GET /api/items");
    const root = rt.ops.get(fetchOp.root)!;
    expect(root.kind).toBe("user");
  });

  it("holds a stale response, asks the model and drops its stale writes in guard mode", async () => {
    const { rt, clock, server, fetch, decider } = setup(defaultScript({ delivery: { diagnosis: "stale", action: "discard", p: 0.97 } }));
    server.on("GET", "/api/search", ({ url }) => ({ body: { q: url.searchParams.get("q") }, latency: url.searchParams.get("q") === "r" ? 400 : 100 }));
    const results = rt.atom("search", { query: "", results: "" });
    let loading = 0;
    const type = (q: string) =>
      rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
        results.set((s) => ({ ...s, query: q }));
        loading++;
        void (async () => {
          const res = await fetch(`/api/search?q=${q}`);
          const data = (await res.json()) as { q: string };
          loading--;
          results.set((s) => ({ ...s, results: data.q }));
        })();
      });
    type("r");
    await clock.advance(50);
    type("re");
    await clock.advance(1000);
    expect(results.get()).toEqual({ query: "re", results: "re" });
    expect(loading).toBe(0); // the app saw the response (only its stale write was dropped)
    const d = rt.decisions().find((x) => x.trigger === "delivery" && x.action !== "deliver")!;
    expect(d.action).toBe("discard");
    expect(d.executed).toBe(true);
    expect(rt.interventions().length).toBe(1);
    expect(rt.interventions()[0].dropped).toEqual(["search.results"]);
    const calls = decider.calls.filter((c) => c.trigger === "delivery");
    expect(calls).toHaveLength(1); // the in-order response ("re") never asked
    const call = calls[0];
    console.log("---- delivery situation ----\n" + stateText(call.state));
    expect(call.subject?.kind).toBe("delivery");
  });
});
