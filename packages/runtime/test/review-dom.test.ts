// @vitest-environment happy-dom
// REVIEW: DOM user-action observer. A failing test demonstrates a bug.
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { FakeClock } from "./helpers.js";

const OFF = { fetch: false, xhr: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false };

describe("review: DOM observer privacy and attribution", () => {
  let rt: RuntimeImpl | null = null;
  afterEach(() => {
    rt?.destroy();
    rt = null;
  });

  it("never records a password field's value, even when the field has no label/placeholder/name", async () => {
    document.body.innerHTML = `<form><span>Password</span><input type="password" id="pw"><button id="go">Sign in</button></form>`;
    const clock = new FakeClock();
    rt = createRuntime({ clock, global: window, decider: null, report: "silent", observe: { ...OFF, user: true } }) as RuntimeImpl;
    const pw = document.getElementById("pw") as HTMLInputElement;
    pw.value = "hunter2";
    pw.dispatchEvent(new Event("input", { bubbles: true }));
    pw.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    pw.click();
    const recorded = JSON.stringify(rt.history()) + JSON.stringify(rt.situation().state) + JSON.stringify([...rt.ops.byId.values()].map((o) => [o.name, o.detail, o.meta]));
    expect(recorded).not.toContain("hunter2");
    await clock.flush();
  });

  it("a programmatic element.click() made by app code inside an op is not recorded as a user action", async () => {
    document.body.innerHTML = `<button id="dl">Download</button>`;
    const clock = new FakeClock();
    rt = createRuntime({ clock, global: window, decider: null, report: "silent", observe: { ...OFF, user: true } }) as RuntimeImpl;
    const s = rt.atom("exports", 0);
    await rt.op("export", () => {
      (document.getElementById("dl") as HTMLButtonElement).click(); // e.g. triggering a download link
      s.set(1); // the op's own write
    });
    const w = rt.history().find((e) => e.kind === "state")!;
    expect(rt.ops.get(w.op)!.kind).toBe("task");
    expect(rt.history().filter((e) => e.kind === "user")).toHaveLength(0);
    await clock.flush();
  });
});
