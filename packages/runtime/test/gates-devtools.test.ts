// @vitest-environment happy-dom
// Batch 6: the devtools "Now" view shows the gate thresholds in force (defaults and the model's per-trigger values).
import { describe, expect, it } from "vitest";
import { mountDevtools } from "../src/devtools/index.js";
import type { ModelStatus } from "../src/types.js";
import { setup } from "./helpers.js";

const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

describe("devtools Now view: gates", () => {
  it("lists the effective thresholds and where they come from", async () => {
    const s = setup({ policy: { thresholds: { heal: 0.85 } } });
    s.decider.status = { state: "ready", model: "m", gate: { report: 0.4, guard: { default: 0.6, byTrigger: { delivery: 0.5 } } } } as ModelStatus;
    const dt = mountDevtools(s.rt, { collapsed: false });
    const sr = dt.element!.shadowRoot!;
    await frame();
    (sr.querySelector('[data-tab="now"]') as HTMLElement).click();
    await frame();
    const text = sr.querySelector(".now")?.textContent ?? "";
    expect(text).toContain("default: guard 0.6 (model) · heal 0.85 (policy) · report 0.4 (model)");
    expect(text).toContain("delivery: guard 0.5 (model) · heal 0.85 (policy) · report 0.4 (model)");
    expect(text).toContain("kind: mass (summed probability of the permitted actions)");
    dt.unmount();
    s.rt.destroy();
  });

  it("shows the gain gate kind, τ and margins", async () => {
    const s = setup();
    s.decider.status = { state: "ready", model: "m", gate: { kind: "gain", tauGain: 1.5, guard: { default: 3 }, heal: { default: 5 } } } as ModelStatus;
    const dt = mountDevtools(s.rt, { collapsed: false });
    const sr = dt.element!.shadowRoot!;
    await frame();
    (sr.querySelector('[data-tab="now"]') as HTMLElement).click();
    await frame();
    const text = sr.querySelector(".now")?.textContent ?? "";
    expect(text).toContain("kind: gain (per-action gain over the passive action, τ 1.5)");
    expect(text).toContain("default: guard margin 3 (model) · heal margin 5 (model) · report 0.6 (default)");
    dt.unmount();
    s.rt.destroy();
  });
});
