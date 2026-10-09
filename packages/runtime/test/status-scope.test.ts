// runtime.status.scope and runtime.gates() report what is in force on the current route (Troy trial, 2026-10-09:
// status read `scope: { mode: "heal", aggressiveness: 1 }` while the page ran in observe; that was the route ceiling).
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("status.scope", () => {
  it("without a route rule: the effective mode and aggressiveness, no rule or ceiling", () => {
    const { rt } = setup({ mode: "observe" });
    expect(rt.status.effectiveMode).toBe("observe");
    expect(rt.status.scope).toEqual({ route: "/search", mode: "observe", aggressiveness: rt.aggressiveness });
    expect(rt.gates().mode).toBe("observe");
  });

  it("follows setMode", () => {
    const { rt } = setup({ mode: "observe" });
    rt.setMode("guard");
    expect(rt.status.scope?.mode).toBe("guard");
    expect(rt.gates("delivery").mode).toBe("guard");
  });

  it("with a matching rule: the demoted mode, the rule index and its ceiling", () => {
    const { rt } = setup({ mode: "guard", routes: [{ match: "/other", mode: "off" }, { match: "/search", mode: "observe", aggressiveness: "cautious" }] });
    expect(rt.status.scope).toMatchObject({ route: "/search", mode: "observe", rule: 1, ceiling: "observe", aggressiveness: 0 });
    expect(rt.status.effectiveMode).toBe("observe");
    expect(rt.gates().mode).toBe("observe");
  });

  it("a rule above the global mode cannot raise it: scope.mode stays the global mode", () => {
    const { rt } = setup({ mode: "observe", routes: [{ match: "/search", mode: "heal" }] });
    expect(rt.status.scope).toMatchObject({ mode: "observe", rule: 0, ceiling: "heal" });
  });
});
