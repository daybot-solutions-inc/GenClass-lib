// Row validity and label-distribution sanity over a batch of random trajectories.

import { describe, expect, it } from "vitest";
import { generateTrajectory } from "../src/gen/trajectory.js";
import { transformQuestions } from "../src/run/transform.js";
import { Rng } from "../src/rng.js";
import type { Row } from "../src/types.js";
import { buildScenario, splitOf } from "../src/world/scenario.js";
import { testFactory } from "./helpers.js";

describe("rows", () => {
  it("random trajectories produce valid CONTRACT-D rows", async () => {
    const { factory, name } = await testFactory();
    const rows: Row[] = [];
    const drops: Record<string, number> = {};
    let errors = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const out = await generateTrajectory(seed, { factory, runtimeName: name, maxPoints: 4, askRows: true, testKeep: 1, exploreScale: 1 });
      rows.push(...out.rows);
      for (const [k, v] of Object.entries(out.drops)) drops[k] = (drops[k] ?? 0) + v;
      if (out.skipped && out.skipped.startsWith("base-error")) {
        errors++;
        console.log(out.skipped);
      }
    }
    expect(errors).toBe(0);
    expect(drops["prefix-mismatch"] ?? 0).toBe(0);
    expect(rows.length).toBeGreaterThan(40);
    const triggers = new Set(rows.map((r) => String(r.meta.trigger)));
    expect(triggers.has("ask")).toBe(true);
    expect([...triggers].filter((t) => t !== "ask").length).toBeGreaterThanOrEqual(2);
    for (const r of rows) {
      expect(["train", "dev", "test"]).toContain(r.split);
      expect(typeof r.id).toBe("string");
      expect(JSON.stringify(r.state)).not.toContain("x-request-id");
      expect(JSON.stringify(r.state)).not.toMatch(/req-[0-9a-f]{8}-/);
      for (const [qid, l] of Object.entries(r.labels)) {
        const q = r.questions[qid];
        expect(q, `${r.id} label ${qid} has a question`).toBeTruthy();
        if (l.type === "choice" && "dist" in l) {
          const s = Object.values(l.dist).reduce((a, b) => a + b, 0);
          expect(Math.abs(s - 1)).toBeLessThan(0.01);
          for (const k of Object.keys(l.dist)) expect(Object.keys((q as { criteria: object }).criteria)).toContain(k);
        }
        if (l.type === "choice" && "label" in l) expect(Object.keys((q as { criteria: object }).criteria)).toContain(l.label);
        if (l.type === "score" && "level" in l) expect(l.level).toBeLessThan((q as { criteria: unknown[] }).criteria.length);
        if (l.type === "noul") expect([0, 1]).toContain(l.p);
      }
    }
    // S1: a gold `expected` diagnosis never comes with a clear non-passive win.
    for (const r of rows) {
      const m = r.meta as { diagnosis?: string; passive_best?: boolean; passive?: string; adjusted?: Record<string, number> };
      if (m.diagnosis === "expected" && m.passive_best === false && m.passive && m.adjusted) expect(m.adjusted[m.passive]!, r.id).toBeLessThan(1);
    }
    const dec = rows.filter((r) => r.meta.trigger !== "ask");
    const passiveBest = dec.filter((r) => r.meta.passive_best === true).length / Math.max(1, dec.length);
    console.log(`rows=${rows.length} decision=${dec.length} passive-best=${passiveBest.toFixed(2)} drops=${JSON.stringify(drops)}`);
    expect(passiveBest).toBeGreaterThan(0.2);
  });

  it("splits hold out domains and families; transform renormalises dropped options", () => {
    const splits: Record<string, number> = {};
    for (let seed = 1; seed <= 400; seed++) {
      const s = buildScenario(seed);
      const sp = splitOf(s);
      splits[sp] = (splits[sp] ?? 0) + 1;
    }
    expect(splits.test).toBeGreaterThan(40);
    expect(splits.train).toBeGreaterThan(150);
    const q = { action: { type: "choice" as const, instructions: "x", criteria: { send: "a", coalesce: "b", delay: "c", block: "d" } } };
    for (let i = 0; i < 200; i++) {
      const t = transformQuestions(q, { send: 0.1, coalesce: 0.7, delay: 0.1, block: 0.1 }, "send", "coalesce", new Rng(i));
      const crit = (t.questions.action as { criteria: Record<string, unknown> }).criteria;
      expect(Object.keys(crit)).toContain("send");
      expect(Object.keys(crit)).toContain("coalesce");
      const s = Object.values(t.dist!).reduce((a, b) => a + b, 0);
      expect(Math.abs(s - 1)).toBeLessThan(0.01);
      for (const k of Object.keys(t.dist!)) expect(Object.keys(crit)).toContain(k);
    }
  });
});
