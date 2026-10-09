// Late revert window (heal/overnight): a write that applied before its decision may be reverted only within
// LATE_REVERT_MS (800 ms) of applying. In the demos benchmark, reverts decided ~0.9–2 s after their write turned
// correct runs into visible bugs (the user had been looking at the new value; the revert was a second change).
import { describe, expect, it } from "vitest";
import { LATE_REVERT_MS } from "../src/runtime.js";
import { defaultScript, ManualDecider, setup } from "./helpers.js";

const stale = defaultScript({ mutation: { diagnosis: "stale", action: "discard" } });

async function lateDecision(afterMs: number) {
  const manual = new ManualDecider();
  const { rt, clock } = setup({ decider: manual, triage: "always" });
  const a = rt.atom("a", { v: 0 });
  void rt.op("w", () => a.set({ v: 7 }));
  await clock.advance(afterMs);
  manual.answer(stale);
  await clock.flush();
  return { a, rt };
}

describe("late revert window (CONTRACT §13 situation-v2)", () => {
  it("is 800 ms", () => {
    expect(LATE_REVERT_MS).toBe(800);
  });

  it("a decision 0.5 s after the write applied still reverts it", async () => {
    const { a, rt } = await lateDecision(500);
    expect(a.get().v).toBe(0);
    expect(rt.interventions()[0]?.late).toBe(true);
  });

  it("a decision 1 s after the write applied leaves it (too late to revert)", async () => {
    const { a, rt } = await lateDecision(1000);
    expect(a.get().v).toBe(7);
    expect(rt.interventions()).toHaveLength(0);
    expect(rt.decisions()[0].reason).toMatch(/^too late to revert: decided 1\.00s after the write applied$/);
  });
});
