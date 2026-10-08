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
    dt.unmount();
    s.rt.destroy();
  });
});
