import { describe, expect, it } from "vitest";
import { holdBudget, policyConfig } from "../src/decide/policy.js";
import { sectionLimits, stateChars, stateText } from "../src/situation/serialize.js";
import type { EvaluateRequest } from "../src/types.js";
import { ManualDecider, defaultScript, setup, type Setup } from "./helpers.js";

async function typeahead(s: Setup) {
  const { rt, clock, server, fetch } = s;
  server.on("GET", "/api/search", ({ url }) => ({ body: { q: url.searchParams.get("q") }, latency: url.searchParams.get("q") === "rea" ? 900 : 120 }));
  const search = rt.atom("search", { query: "", results: [] as string[] });
  const type = (q: string) =>
    rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
      search.set((v) => ({ ...v, query: q }));
      void (async () => {
        const res = await fetch(`/api/search?q=${q}`);
        const data = (await res.json()) as { q: string };
        search.set((v) => ({ ...v, results: [`${data.q}-1`, `${data.q}-2`] }));
      })();
    });
  type("r");
  await clock.advance(80);
  type("re");
  await clock.advance(70);
  type("rea");
  await clock.advance(90);
  type("reac");
  await clock.advance(3000);
}

function count(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

describe("situation budget (latency)", () => {
  it("section limits: compact at 1,100, full at 3,200, linear in between", () => {
    expect(sectionLimits(1100)).toMatchObject({ facts: 6, in_flight: 2, timeline: 3, state: 3, stats: 1 });
    expect(sectionLimits(2000)).toMatchObject({ facts: 9, in_flight: 4, timeline: 9, state: 5, stats: 2 });
    expect(sectionLimits(3200)).toMatchObject({ facts: 12, in_flight: 6, timeline: 16, state: 8, stats: 4 });
    expect(sectionLimits(500)).toEqual(sectionLimits(1100));
  });

  for (const budget of [1100, 2000]) {
    it(`a ${budget}-char budget shapes every section and keeps the most informative facts`, async () => {
      const s = setup({ situation: { budget }, script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }) });
      await typeahead(s);
      const req = s.decider.calls.filter((c) => c.trigger === "mutation").pop()!;
      const L = sectionLimits(budget);
      expect(stateChars(req.state)).toBeLessThanOrEqual(budget);
      expect(count(req.state.facts)).toBeGreaterThanOrEqual(1);
      expect(count(req.state.facts)).toBeLessThanOrEqual(L.facts);
      expect(count(req.state.in_flight)).toBeLessThanOrEqual(L.in_flight);
      expect(count(req.state.timeline)).toBeLessThanOrEqual(L.timeline);
      expect(count(req.state.state)).toBeLessThanOrEqual(L.state);
      expect(count(req.state.stats)).toBeLessThanOrEqual(L.stats);
      expect((req.state.facts as string[])[0]).toMatch(/^search\.results was written once by other operations since this write's cause \(#\d+\) started/);
      console.log(`==== mutation at ${budget} chars (${stateChars(req.state)}) ====\n${stateText(req.state)}\n`);
    });
  }

  it("the same inputs at the same budget are byte-identical (deterministic)", async () => {
    const run = async () => {
      const s = setup({ situation: { budget: 1100 } });
      await typeahead(s);
      return JSON.stringify(s.decider.calls.map((c) => c.state));
    };
    expect(await run()).toBe(await run());
  });

  it('"auto" picks the budget from the model status: webgpu 3,200; wasm 1,100 + 300 per extra thread', () => {
    const s = setup();
    s.decider.status = { state: "ready", device: "webgpu" };
    expect(s.rt.situationBudget()).toBe(3200);
    s.decider.status = { state: "ready", device: "wasm", threads: 1 };
    expect(s.rt.situationBudget()).toBe(1100);
    s.decider.status = { state: "ready", device: "wasm", threads: 4 };
    expect(s.rt.situationBudget()).toBe(2000);
    s.decider.status = { state: "ready", device: "wasm", threads: 16 };
    expect(s.rt.situationBudget()).toBe(2000);
    s.decider.status = { state: "ready" };
    expect(s.rt.situationBudget()).toBe(3200);
    const fixed = setup({ situation: { budget: 1500 } });
    fixed.decider.status = { state: "ready", device: "webgpu" };
    expect(fixed.rt.situationBudget()).toBe(1500);
  });

  it("max_tokens_exceeded shrinks automatic budgets for later situations", async () => {
    const s = setup({ triage: "always" });
    s.decider.status = { state: "ready", device: "webgpu" };
    s.decider.script = () => {
      throw Object.assign(new Error("too long"), { code: "max_tokens_exceeded" });
    };
    const a = s.rt.atom("a", 0);
    void s.rt.op("w", () => a.set(1));
    await s.clock.flush();
    expect(s.rt.situationBudget()).toBe(2560);
  });
});

describe("hold budget", () => {
  it('"auto": clamp(1.5 × median of recent latencies (warm-up time before any), 150, 800), else 300', () => {
    const c = policyConfig({});
    expect(holdBudget(c, [], undefined)).toBe(300);
    expect(holdBudget(c, [], 400)).toBe(600);
    expect(holdBudget(c, [], 900)).toBe(800);
    expect(holdBudget(c, [10, 20, 30], 900)).toBe(150);
    expect(holdBudget(c, [200, 220, 240, 1000], undefined)).toBe(345);
    expect(holdBudget(policyConfig({ holdBudgetMs: 50 }), [400], 400)).toBe(50);
  });

  it("the runtime measures provider latency and adapts the hold budget", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always" });
    manual.status = { state: "ready", warmupMs: 200 };
    expect(rt.holdBudgetMs()).toBe(300);
    const a = rt.atom("a", 0);
    for (let i = 1; i <= 3; i++) {
      void rt.op("w", () => a.set(i));
      await clock.advance(100);
      manual.answer(defaultScript());
      await clock.flush();
    }
    expect(rt.holdBudgetMs()).toBe(150);
  });

  it("held requests carry timeoutMs = the time left in the hold budget; expired queued requests are never computed", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always", policy: { holdBudgetMs: 200 } });
    const a = rt.atom("a", 0);
    const b = rt.atom("b", 0);
    void rt.op("w1", () => a.set(1));
    void rt.op("w2", () => b.set(1)); // queued behind w1
    expect(manual.pending.length).toBe(1);
    const first: EvaluateRequest = manual.pending[0].req;
    expect(first.timeoutMs).toBe(200 + 2000); // held write: budget + late-revert window
    await clock.advance(2300);
    manual.answer(defaultScript()); // w1 answered after w2's deadline passed
    await clock.flush();
    expect(manual.pending.length).toBe(0); // w2 was dropped, not computed
    expect(b.get()).toBe(1); // and it applied (fail-open)
  });

  it("held requests (fetch) carry the remaining budget without a late window", async () => {
    const { rt, clock, server, fetch, decider } = setup({ triage: "always", policy: { holdBudgetMs: 250 } });
    server.on("GET", "/api/x", { body: 1, latency: 5 });
    const p = fetch("/api/x");
    await clock.advance(50);
    await p;
    const req = decider.calls.find((c) => c.trigger === "request")!;
    expect(req.timeoutMs).toBe(250);
    void rt;
  });
});
