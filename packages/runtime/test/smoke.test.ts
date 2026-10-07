import { describe, expect, it } from "vitest";
import { createRuntime, stateText } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { FakeClock, FakeServer, ScriptedDecider, defaultScript, makeGlobal } from "./helpers.js";

function setup(script = defaultScript()) {
  const clock = new FakeClock();
  const server = new FakeServer(clock);
  const g = makeGlobal(server);
  const decider = new ScriptedDecider(script);
  const rt = createRuntime({ clock, global: g, decider, report: "silent", observe: { fetch: true } }) as RuntimeImpl;
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

  it("holds a stale write, asks the model and discards it in guard mode", async () => {
    const { rt, clock, server, fetch, decider } = setup(defaultScript({ mutation: { diagnosis: "stale", action: "discard", p: 0.97 } }));
    server.on("GET", "/api/search", ({ url }) => ({ body: { q: url.searchParams.get("q") }, latency: url.searchParams.get("q") === "r" ? 400 : 100 }));
    const results = rt.atom("search", { query: "", results: "" });
    const type = (q: string) =>
      rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
        results.set((s) => ({ ...s, query: q }));
        void (async () => {
          const res = await fetch(`/api/search?q=${q}`);
          const data = (await res.json()) as { q: string };
          results.set((s) => ({ ...s, results: data.q }));
        })();
      });
    type("r");
    await clock.advance(50);
    type("re");
    await clock.advance(1000);
    expect(results.get().results).toBe("re");
    expect(decider.calls.length).toBeGreaterThan(0);
    const d = rt.decisions().find((x) => x.trigger === "mutation")!;
    expect(d.action).toBe("discard");
    expect(d.executed).toBe(true);
    expect(rt.interventions().length).toBe(1);
    const call = decider.calls.find((c) => c.trigger === "mutation")!;
    console.log("---- mutation situation ----\n" + stateText(call.state));
    expect(call.subject?.kind).toBe("mutation");
  });
});
