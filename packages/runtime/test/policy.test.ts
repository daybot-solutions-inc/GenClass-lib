import { describe, expect, it } from "vitest";
import { gate, policyConfig, RateLimiter, modeAllows, permittedActions } from "../src/decide/policy.js";
import { defaultScript, setup } from "./helpers.js";

const MUT = [
  { name: "apply", tier: "passive" as const },
  { name: "discard", tier: "guard" as const },
  { name: "defer", tier: "guard" as const },
];
const REQ = [
  { name: "send", tier: "passive" as const },
  { name: "coalesce", tier: "guard" as const },
  { name: "delay", tier: "guard" as const },
  { name: "block", tier: "heal" as const },
];
const base = {
  actions: MUT,
  probabilities: { apply: 0.03, discard: 0.95, defer: 0.02 } as Record<string, number>,
  top: "discard",
  diagnosis: "stale",
  mode: "guard" as const,
  paused: false,
  now: 0,
};
const rl = () => new RateLimiter(() => 60);

describe("policy gate (CONTRACT §8)", () => {
  it("runs the most probable permitted action when the permitted mass reaches its tier threshold", () => {
    const g = gate(policyConfig({}), rl(), base);
    expect(g).toMatchObject({ run: "discard", candidate: "discard", reason: null });
    expect(g.mass).toBeCloseTo(0.97);
  });

  it("two good actions may split the mass (discard 0.5 + defer 0.45 runs discard in guard mode)", () => {
    const g = gate(policyConfig({}), rl(), { ...base, probabilities: { apply: 0.05, discard: 0.5, defer: 0.45 } });
    expect(g.run).toBe("discard");
    expect(g.mass).toBeCloseTo(0.95);
  });

  it("mode tiers: observe permits nothing, guard only guard-tier, heal both", () => {
    expect(modeAllows("observe", "guard")).toBe(false);
    expect(modeAllows("guard", "guard")).toBe(true);
    expect(modeAllows("guard", "heal")).toBe(false);
    expect(modeAllows("heal", "heal")).toBe(true);
    expect(modeAllows("observe", "passive")).toBe(true);
    const c = policyConfig({});
    expect(permittedActions(c, "observe", REQ).map((a) => a.name)).toEqual([]);
    expect(permittedActions(c, "guard", REQ).map((a) => a.name)).toEqual(["coalesce", "delay"]);
    expect(permittedActions(c, "heal", REQ).map((a) => a.name)).toEqual(["coalesce", "delay", "block"]);
    const observe = gate(c, rl(), { ...base, mode: "observe" });
    expect(observe).toMatchObject({ run: null, candidate: null, reason: "observe mode never changes execution" });
    const blk = { ...base, actions: REQ, probabilities: { send: 0.04, coalesce: 0.01, delay: 0.02, block: 0.93 }, top: "block" };
    expect(gate(c, rl(), blk)).toMatchObject({ run: null, candidate: "delay", reason: "guard mode does not allow heal-tier actions" });
    expect(gate(c, rl(), { ...blk, mode: "heal" })).toMatchObject({ run: "block", reason: null });
  });

  it("thresholds apply to the permitted mass per tier (defaults 0.9 guard, 0.8 heal)", () => {
    const c = policyConfig({});
    const low = gate(c, rl(), { ...base, probabilities: { apply: 0.12, discard: 0.8, defer: 0.08 } });
    expect(low.run).toBeNull();
    expect(low.reason).toBe("probability 0.88 for the permitted actions (discard, defer) is below the guard threshold 0.9");
    const heal = { ...base, mode: "heal" as const, actions: REQ, top: "block", probabilities: { send: 0.21, coalesce: 0, delay: 0, block: 0.79 } };
    expect(gate(c, rl(), heal).reason).toBe("probability 0.79 for the permitted actions (coalesce, delay, block) is below the heal threshold 0.8");
    expect(gate(policyConfig({ thresholds: { guard: 0.5 } }), rl(), { ...base, probabilities: { apply: 0.4, discard: 0.6, defer: 0 } }).run).toBe("discard");
  });

  it("no reason when the model itself chose the passive action", () => {
    const g = gate(policyConfig({}), rl(), { ...base, top: "apply", probabilities: { apply: 0.7, discard: 0.2, defer: 0.1 } });
    expect(g).toMatchObject({ run: null, candidate: "discard", reason: null });
  });

  it("requires a diagnosis other than expected unless requireDiagnosis is false", () => {
    expect(gate(policyConfig({}), rl(), { ...base, diagnosis: "expected" }).reason).toBe("the model's diagnosis is expected");
    expect(gate(policyConfig({ requireDiagnosis: false }), rl(), { ...base, diagnosis: "expected" }).run).toBe("discard");
  });

  it("deny and allow lists remove actions from the permitted set", () => {
    expect(gate(policyConfig({ deny: ["discard"] }), rl(), base)).toMatchObject({ run: null, candidate: "defer", reason: "discard is denied by policy" });
    expect(gate(policyConfig({ allow: ["coalesce"] }), rl(), base)).toMatchObject({ run: null, candidate: null, reason: "discard is not in policy.allow" });
    expect(gate(policyConfig({ allow: ["discard"] }), rl(), base).run).toBe("discard");
  });

  it("pause", () => {
    expect(gate(policyConfig({}), rl(), { ...base, paused: true }).reason).toBe("GenClass is paused");
  });

  it("rate limit: beyond maxActionsPerMinute the passive action runs", async () => {
    const { rt, clock, server, fetch } = setup({ triage: "always", policy: { maxActionsPerMinute: 2 }, script: defaultScript({ request: { diagnosis: "overload", action: "delay" } }) });
    server.on("GET", "/api/x", { body: 1, latency: 5 });
    for (let i = 0; i < 4; i++) {
      const p = fetch("/api/x");
      await clock.advance(2000);
      await p;
    }
    const ds = rt.decisions().filter((d) => d.trigger === "request");
    expect(ds.map((d) => d.executed)).toEqual([true, true, false, false]);
    expect(ds[2].reason).toMatch(/rate limit/);
    expect(rt.interventions().length).toBe(2);
    // the window slides
    await clock.advance(61_000);
    const p = fetch("/api/x");
    await clock.advance(2000);
    await p;
    expect(rt.decisions().filter((d) => d.trigger === "request").pop()!.executed).toBe(true);
  });

  it("observe mode never holds: writes and requests proceed while decisions are still reported", async () => {
    const { rt, clock, server, fetch } = setup({ mode: "observe", triage: "always", script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" }, request: { diagnosis: "overload", action: "block" } }) });
    server.on("GET", "/api/x", { body: 1, latency: 5 });
    const a = rt.atom("a", 0);
    void rt.op("w", () => a.set(1));
    expect(a.get()).toBe(1); // applied synchronously, not held
    const t0 = clock.now();
    const p = fetch("/api/x");
    await clock.advance(50);
    await p;
    expect(server.log[0].t).toBe(t0);
    const ds = rt.decisions();
    expect(ds.length).toBe(2);
    expect(ds.every((d) => !d.executed && /observe mode/.test(d.reason ?? ""))).toBe(true);
    expect(rt.interventions().length).toBe(0);
  });

  it("setMode switches tiers at runtime", async () => {
    const { rt, clock } = setup({ mode: "observe", triage: "always", script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }) });
    const a = rt.atom("a", 0);
    rt.setMode("guard");
    expect(rt.mode).toBe("guard");
    void rt.op("w", () => a.set(1));
    await clock.flush();
    expect(a.get()).toBe(0);
  });

  it("pause() stops consulting the model; resume() restores it", async () => {
    const { rt, clock, decider } = setup({ triage: "always" });
    const a = rt.atom("a", 0);
    rt.pause();
    void rt.op("w", () => a.set(1));
    expect(a.get()).toBe(1);
    expect(decider.calls.length).toBe(0);
    rt.resume();
    void rt.op("w", () => a.set(2));
    await clock.flush();
    expect(decider.calls.length).toBe(1);
  });

  it("while the model is loading every trigger fails open immediately (no record)", async () => {
    const { rt, decider } = setup({ triage: "always" });
    decider.status = { state: "loading" };
    const a = rt.atom("a", 0);
    void rt.op("w", () => a.set(1));
    expect(a.get()).toBe(1);
    expect(decider.calls.length).toBe(0);
    expect(rt.decisions().length).toBe(0);
  });

  it("a detection is emitted when the top diagnosis is not expected and ≥ thresholds.report", async () => {
    const { rt, clock } = setup({ mode: "observe", triage: "always", script: defaultScript({ mutation: { diagnosis: "stale", action: "apply", p: 0.65 } }) });
    const seen: string[] = [];
    rt.on("detect", (d) => seen.push(d.diagnosis));
    const a = rt.atom("a", 0);
    void rt.op("w", () => a.set(1));
    await clock.flush();
    expect(seen).toEqual(["stale"]);
    const d = rt.decisions()[0];
    expect(d.confidence).toBeCloseTo(0.65);
    expect(d.diagnosisConfidence).toBeCloseTo(0.65);
  });
});
