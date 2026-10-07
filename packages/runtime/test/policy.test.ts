import { describe, expect, it } from "vitest";
import { gate, policyConfig, RateLimiter, modeAllows } from "../src/decide/policy.js";
import { defaultScript, setup } from "./helpers.js";

const base = { action: "discard", tier: "guard" as const, probability: 0.95, diagnosis: "stale", mode: "guard" as const, inBudget: true, paused: false, now: 0 };

describe("policy gate (CONTRACT §8)", () => {
  it("passes a confident guard action in guard mode", () => {
    const c = policyConfig({});
    expect(gate(c, new RateLimiter(() => 60), base)).toBeNull();
  });

  it("mode tiers: observe allows nothing, guard only guard-tier, heal both", () => {
    expect(modeAllows("observe", "guard")).toBe(false);
    expect(modeAllows("guard", "guard")).toBe(true);
    expect(modeAllows("guard", "heal")).toBe(false);
    expect(modeAllows("heal", "heal")).toBe(true);
    expect(modeAllows("observe", "passive")).toBe(true);
    const c = policyConfig({});
    const r = new RateLimiter(() => 60);
    expect(gate(c, r, { ...base, mode: "observe" })).toMatch(/observe mode/);
    expect(gate(c, r, { ...base, tier: "heal", action: "rollback" })).toMatch(/guard mode does not allow heal-tier/);
    expect(gate(c, r, { ...base, tier: "heal", action: "rollback", mode: "heal", probability: 0.85 })).toBeNull();
  });

  it("thresholds apply to probabilities[action] per tier (defaults 0.9 guard, 0.8 heal)", () => {
    const c = policyConfig({});
    const r = new RateLimiter(() => 60);
    expect(gate(c, r, { ...base, probability: 0.89 })).toMatch(/below the guard threshold 0.9/);
    expect(gate(c, r, { ...base, mode: "heal", tier: "heal", action: "retry", probability: 0.79 })).toMatch(/below the heal threshold 0.8/);
    const c2 = policyConfig({ thresholds: { guard: 0.5 } });
    expect(gate(c2, r, { ...base, probability: 0.6 })).toBeNull();
  });

  it("requires a diagnosis other than expected unless requireDiagnosis is false", () => {
    const r = new RateLimiter(() => 60);
    expect(gate(policyConfig({}), r, { ...base, diagnosis: "expected" })).toMatch(/diagnosis is expected/);
    expect(gate(policyConfig({ requireDiagnosis: false }), r, { ...base, diagnosis: "expected" })).toBeNull();
  });

  it("deny and allow lists", () => {
    const r = new RateLimiter(() => 60);
    expect(gate(policyConfig({ deny: ["discard"] }), r, base)).toMatch(/denied/);
    expect(gate(policyConfig({ allow: ["coalesce"] }), r, base)).toMatch(/not in policy.allow/);
    expect(gate(policyConfig({ allow: ["discard"] }), r, base)).toBeNull();
  });

  it("budget and pause", () => {
    const r = new RateLimiter(() => 60);
    expect(gate(policyConfig({}), r, { ...base, inBudget: false })).toMatch(/hold budget/);
    expect(gate(policyConfig({}), r, { ...base, paused: true })).toMatch(/paused/);
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
