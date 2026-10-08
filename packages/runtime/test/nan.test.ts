import { describe as d, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";

d("NaN in state", () => {
  it("builds situations without recursing (describe() used !== which is always true for NaN)", () => {
    const rt = createRuntime({ model: false, report: "silent" });
    const a = rt.atom("calc", { total: NaN, items: [{ price: NaN }] });
    a.set({ total: Number.NaN, items: [{ price: 0 / 0 }] });
    const sit = rt.situation("ask");
    expect(JSON.stringify(sit.state)).toContain("NaN");
    rt.destroy();
  });
});
