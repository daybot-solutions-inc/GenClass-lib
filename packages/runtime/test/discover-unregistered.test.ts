// @vitest-environment happy-dom
// GenClass.init() / createRuntime() setups do not carry the discovery code: autoState: true without
// `import "@genclass/runtime/discover"` warns once and installs nothing (the main entry stays as small as before).
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { FakeClock } from "./helpers.js";

describe("autoState without the discovery module", () => {
  it("warns and installs nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rt = createRuntime({ clock: new FakeClock(), global: globalThis, decider: null, report: "silent", autoState: true, observe: { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false } }) as RuntimeImpl;
    expect((globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__).toBeUndefined();
    expect(rt.discoveryStats()).toBeNull();
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain('import "@genclass/runtime/discover"');
    rt.destroy();
    warn.mockRestore();
  });
});
