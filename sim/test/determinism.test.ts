// Determinism: same seed → identical rows; replay with the same forced decisions reproduces every prefix.

import { describe, expect, it } from "vitest";
import { generateTrajectory, type GenOptions } from "../src/gen/trajectory.js";
import { runScenario } from "../src/run/runner.js";
import { buildScenario } from "../src/world/scenario.js";
import { testFactory } from "./helpers.js";

describe("determinism", () => {
  it("same seed → identical rows and final states", async () => {
    const { factory, name } = await testFactory();
    const o: GenOptions = { factory, runtimeName: name, maxPoints: 3, askRows: true, testKeep: 1, exploreScale: 1 };
    for (const seed of [11, 12, 13]) {
      const a = await generateTrajectory(seed, o);
      const b = await generateTrajectory(seed, o);
      expect(JSON.stringify(a.rows)).toBe(JSON.stringify(b.rows));
      expect(a.drops["prefix-mismatch"] ?? 0).toBe(0);
      const s = buildScenario(seed);
      const r1 = await runScenario(s, { ideal: false, factory, record: true });
      const r2 = await runScenario(s, { ideal: false, factory, record: true });
      expect(JSON.stringify(r1.final)).toBe(JSON.stringify(r2.final));
      expect(JSON.stringify(r1.server)).toBe(JSON.stringify(r2.server));
      expect(r1.decisions.map((d) => d.fp)).toEqual(r2.decisions.map((d) => d.fp));
    }
  });

  it("replay with forced decisions reproduces every prefix exactly", async () => {
    const { factory } = await testFactory();
    let checked = 0;
    for (let seed = 100; seed < 130 && checked < 12; seed++) {
      const s = buildScenario(seed);
      const base = await runScenario(s, { ideal: false, factory, record: true });
      if (base.decisions.length < 2) continue;
      for (const k of [0, Math.floor(base.decisions.length / 2), base.decisions.length - 1]) {
        const d = base.decisions[k]!;
        for (const a of d.actions) {
          const forced = new Map<number, string>([[k, a]]);
          const cf = await runScenario(s, { ideal: false, factory, forced, fpUpTo: k });
          const mine = cf.decisions.filter((x) => x.k <= k);
          expect(mine.length).toBe(k + 1);
          for (const x of mine) expect(x.fp).toBe(base.decisions[x.k]!.fp);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});
