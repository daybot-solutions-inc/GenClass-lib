import { describe, expect, it } from "vitest";
import { Baselines } from "../src/learn/baselines.js";
import { Profiles, shapeOf } from "../src/learn/profiles.js";
import { defaultScript, setup } from "./helpers.js";

describe("baselines", () => {
  it("latency median/p95 over recent completions, after 5 samples", () => {
    const b = new Baselines();
    for (let i = 1; i <= 4; i++) {
      b.start("GET /a", i * 1000);
      b.end("GET /a", i * 1000 + 100, 100 * i, true, "200", false);
    }
    expect(b.latency("GET /a")).toBeUndefined();
    b.start("GET /a", 5000);
    b.end("GET /a", 5500, 500, true, "200", false);
    expect(b.latency("GET /a")).toEqual({ n: 5, median: 300, p95: 500 });
  });

  it("EWMA error rate, failure streak, outcomes, last success", () => {
    const b = new Baselines();
    b.end("GET /s", 100, 10, true, "200", false);
    for (let i = 0; i < 3; i++) b.end("GET /s", 200 + i, 10, false, "503", true);
    const st = b.stats("GET /s")!;
    expect(st.failStreak).toBe(3);
    expect(st.outcomes).toEqual(["200", "!503", "!503", "!503"]);
    expect(b.failureCounts("GET /s")).toEqual({ failed: 3, of: 4 });
    expect(st.lastSuccess).toBe(100);
    expect(st.errEwma).toBeCloseTo(1 - 0.9 ** 3, 5);
    b.end("GET /s", 300, 10, true, "200", false);
    expect(b.stats("GET /s")!.failStreak).toBe(0);
    // aborted requests are not outcomes
    b.end("GET /s", 400, 10, false, "aborted", false);
    expect(b.stats("GET /s")!.count).toBe(5);
  });

  it("request frequency vs the usual rate", () => {
    const b = new Baselines();
    for (let t = 0; t < 60_000; t += 5000) b.start("GET /poll", t);
    for (let t = 60_000; t < 70_000; t += 400) b.start("GET /poll", t);
    const r = b.rate("GET /poll", 70_000);
    expect(r.recent).toBe(24); // starts strictly after now - 10 s
    expect(r.usual).toBeCloseTo(2, 0);
  });

  it("identical-request gaps", () => {
    const b = new Baselines();
    b.start("GET /x", 0, "id1");
    b.start("GET /x", 1000, "id1");
    b.start("GET /x", 2000, "id1");
    expect(b.identity("id1")).toMatchObject({ last: 2000, n: 3, gapEwma: 1000 });
  });
});

describe("transition profiles", () => {
  const chain = (fields: [string, string][]) => new Map(fields.map(([f, k]) => [f, { kind: k, len0: k === "array" ? 1 : -1, len1: k === "array" ? 2 : -1 }]));

  it("flags a write set seen in < 1% of ≥ 20 completions, with counts", () => {
    const p = new Profiles();
    const normal = shapeOf(chain([["cart.items", "array"], ["cart.total", "number"]]), 1, "2xx", 80);
    for (let i = 0; i < 19; i++) p.add("POST /api/cart", normal);
    const odd = shapeOf(chain([["cart.items", "array"]]), 1, "2xx", 80);
    expect(p.check("POST /api/cart", odd)).toEqual([]); // < 20 completions
    p.add("POST /api/cart", normal);
    const u = p.check("POST /api/cart", odd);
    expect(u).toEqual([{ component: "set", seen: 0, of: 20, usual: "cart.items,cart.total", usualCount: 20, observed: "cart.items" }]);
  });

  it("does not flag an op that usually writes nothing when it writes something", () => {
    const p = new Profiles();
    for (let i = 0; i < 40; i++) p.add("GET /api/status", shapeOf(undefined, 0, "2xx", 50));
    expect(p.check("GET /api/status", shapeOf(chain([["status.up", "boolean"]]), 1, "2xx", 50))).toEqual([]);
  });

  it("flags a value kind never seen for a field, and a status class", () => {
    const p = new Profiles();
    const s = (k: string, status = "2xx") => shapeOf(chain([["list.items", k]]), 1, status, 50);
    for (let i = 0; i < 30; i++) p.add("GET /api/items", s("array"));
    expect(p.check("GET /api/items", s("null")).map((x) => x.component)).toEqual(["kind"]);
    expect(p.check("GET /api/items", s("array", "4xx")).map((x) => x.component)).toEqual(["status"]);
    expect(p.check("GET /api/items", s("array"))).toEqual([]);
  });

  it("raises a transition trigger at a settled point; rollback restores the state from before the op", async () => {
    const { rt, clock, server, fetch, decider } = setup({ mode: "heal", script: defaultScript({ transition: { diagnosis: "unusual", action: "rollback" } }) });
    let empty = false;
    server.on("GET", "/api/items", ({ n }) => ({ body: empty ? [] : [n, n + 1], latency: 40 }));
    const list = rt.atom("list", { items: [] as number[], loaded: false });
    const load = () =>
      rt.user({ kind: "click", target: 'button "Refresh"' }, () => {
        void (async () => {
          const items = (await (await fetch("/api/items")).json()) as number[];
          list.set({ items, loaded: true });
        })();
      });
    for (let i = 0; i < 21; i++) {
      load();
      await clock.advance(1000);
    }
    empty = true;
    load();
    await clock.advance(1000);
    const calls = decider.calls.filter((c) => c.trigger === "transition");
    expect(calls.length).toBe(1);
    expect((calls[0].state.facts as string[])[0]).toBe("In the previous 21 completions of GET /api/items that wrote list.items, it wrote a non-empty array (21 of 21 times); this time it wrote an empty array.");
    expect(list.get().items).toEqual([21, 22]);
    expect(rt.interventions()[0].changed).toMatch(/^Restored list\.items to their values before user clicked button "Refresh" \(#\d+\) \(the transition's chain wrote them\)\.$/);
  });
});
