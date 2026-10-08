import { describe, expect, it } from "vitest";
import type { UserStep } from "../src/app/feature.js";
import { IDEAL_PROFILE, type NetProfile } from "../src/net/network.js";
import { futureProfile, futureStepTimes, idealRepeatSkips, repeatPrior } from "../src/run/latent.js";

const step = (t: number, target = 'button "Like"', extra: Partial<UserStep> = {}): UserStep => ({
  t,
  feature: "f0",
  action: "like",
  ui: { kind: "click", target },
  intent: { kind: "bump", key: "f0.like.0", mode: "accumulate", accidental: false },
  ...extra,
});

describe("S2 futures (latent re-draws)", () => {
  it("re-draws only what lies after the decision: windows and user steps", () => {
    const P: NetProfile = { ...IDEAL_PROFILE, ideal: false, outages: [{ start: 1000, end: 2000, endpoints: "*", mode: "503" }, { start: 5000, end: 9000, endpoints: "*", mode: "503" }, { start: 8000, end: 12000, endpoints: "*", mode: "neterr" }], slow: [], bugs: [] };
    const f = { k: 3, salt: 42, t: 6000 };
    const Q = futureProfile(P, f);
    expect(Q.outages[0]).toEqual(P.outages[0]); // over before t
    expect(Q.outages[1]!.start).toBe(5000); // running at t: same start, re-drawn end after t
    expect(Q.outages[1]!.end).toBeGreaterThan(6000);
    expect(Q.outages[2]!.start).toBeGreaterThanOrEqual(6000); // starts later: re-drawn start, same length
    expect(Q.outages[2]!.end - Q.outages[2]!.start).toBeCloseTo(4000, 6);
    expect(futureProfile(P, { ...f, noLatent: true })).toBe(P);
    const steps = [step(1000), step(5000), step(7000), step(7100), step(9000)];
    const ts = futureStepTimes(steps, f);
    expect(ts.slice(0, 2)).toEqual([1000, 5000]);
    expect(ts[2]!).toBeGreaterThan(6000);
    expect(ts[3]!).toBeGreaterThan(ts[2]!);
    expect(ts[4]!).toBeGreaterThan(ts[3]!);
    expect(futureStepTimes(steps, { ...f, salt: 43 })).not.toEqual(ts);
  });

  it("draws the hidden intent of earlier repeats from its posterior (ideal runs only)", () => {
    expect(repeatPrior(80)).toBeGreaterThan(0.5);
    expect(repeatPrior(1500)).toBeLessThan(0.5);
    expect(repeatPrior(9000)).toBeUndefined();
    const steps = [step(1000), step(1080, 'button "Like"', { intent: { kind: "bump", key: "f0.like.0", mode: "accumulate", accidental: true } }), step(8000), step(8090)];
    let skipped = 0;
    for (let salt = 1; salt <= 400; salt++) {
      const m = idealRepeatSkips(steps, { k: -1, salt, t: 5000 });
      expect(m.has(0)).toBe(false);
      expect(m.has(3)).toBe(false); // after t: future, not a prefix latent
      if (m.get(1)) skipped++;
    }
    expect(skipped / 400).toBeGreaterThan(0.6);
    expect(skipped / 400).toBeLessThan(0.9);
  });
});
