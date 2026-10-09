import { afterEach, describe, expect, it, vi } from "vitest";
import { GenClass } from "../src/index.js";
import type { Report } from "../src/types.js";
import { defaultScript, setup } from "./helpers.js";

describe("reporting, explain, undo (CONTRACT §0.5, §8)", () => {
  it("one plain-English line per intervention, built from the facts; explain(id) returns the evidence", async () => {
    const reports: Report[] = [];
    const { rt, clock } = setup({ triage: "always", policy: { holdWrites: true }, report: (r) => reports.push(r), script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }) });
    const a = rt.atom("profile", { name: "Ada" });
    void rt.op("load", () => a.set({ name: "Bob" }));
    await clock.flush();
    expect(reports.length).toBe(1);
    const r = reports[0];
    expect(r.kind).toBe("intervene");
    expect(r.message).toMatch(/^\[GenClass\] Prevented a stale write: .* Dropped the write to profile\.name from task load \(#\d+\); profile stays at version 0\. \(stale, 0\.97; discard 0\.97\)$/);
    const ex = rt.explain(r.action!.id)!;
    expect(ex.message).toBe(r.message);
    expect(rt.explain(r.decision!.id)!.message).toBe(r.message);
    expect(ex.decision.id).toBe(r.decision!.id);
    expect(ex.situationText).toMatch(/^app: \/search\ntrigger: A write to profile\.name from task load/);
    expect(ex.changed).toBe(r.action!.changed);
    expect(ex.answers.action).toBeDefined();
    expect(rt.explain("nope")).toBeNull();
  });

  it("without store holds (the default) a discarded write is reverted late and reported as such", async () => {
    const reports: Report[] = [];
    const { rt, clock } = setup({ triage: "always", report: (r) => reports.push(r), script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }) });
    const a = rt.atom("profile", { name: "Ada" });
    void rt.op("load", () => a.set({ name: "Bob" }));
    expect(a.get()).toEqual({ name: "Bob" }); // applied at once
    await clock.flush();
    expect(a.get()).toEqual({ name: "Ada" });
    expect(reports.map((r) => r.kind)).toEqual(["intervene"]);
    expect(reports[0].message).toMatch(/^\[GenClass\] Reverted a stale write: .* Reverted the write to profile\.name from task load \(#\d+\) \(decided 0\.00s after it applied\); profile\.name is back to "Ada"\. \(stale, 0\.97; discard 0\.97\)$/);
    expect(rt.interventions()[0].late).toBe(true);
  });

  it("detections that did not act say why", async () => {
    const reports: Report[] = [];
    const { rt, clock } = setup({ mode: "guard", triage: "always", report: (r) => reports.push(r), script: defaultScript({ mutation: { diagnosis: "stale", action: "discard", p: 0.7 } }) });
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    expect(reports[0].kind).toBe("detect");
    expect(reports[0].message).toMatch(/^\[GenClass\] Flagged a stale write: .* Not acted on \(would have done discard 0\.70\): probability 0\.85 for the permitted actions \(discard, defer\) is below the guard threshold 0\.9\. \(stale, 0\.70\)$/);
  });

  it("console output: a collapsed group with the evidence; repeats are summarised when the minute ends", async () => {
    const group = vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const end = vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { rt, clock } = setup({ triage: "always", policy: { holdWrites: true }, report: "console", script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }) });
    const a = rt.atom("a", 1);
    for (let i = 0; i < 3; i++) {
      void rt.op("w", () => a.set(i + 10));
      await clock.advance(1000);
    }
    expect(group).toHaveBeenCalledTimes(1);
    expect(String(group.mock.calls[0][0])).toMatch(/^\[GenClass\] Prevented a stale write/);
    const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/Situation sent to the model:/);
    expect(logged).toMatch(/Undo: GenClass\.runtime\.interventions\(\)\.find/);
    expect(logged).toMatch(/Deny this action: GenClass\.init\(\{ policy: \{ deny: \["discard"\] \} \}\)/);
    await clock.advance(61_000);
    // the two folded repeats are summarised when the window ends, even if nothing else happens
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[GenClass\] Prevented a stale write: .*\(×2 more in the last minute\)$/);
    void rt.op("w", () => a.set(99));
    await clock.advance(10);
    expect(group).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(2);
    group.mockRestore();
    log.mockRestore();
    end.mockRestore();
    warn.mockRestore();
  });

  it("on('decide'|'detect'|'act'|'event') listeners fire and unsubscribe", async () => {
    const { rt, clock } = setup({ triage: "always", script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }) });
    const seen: string[] = [];
    const offs = [rt.on("decide", () => seen.push("decide")), rt.on("detect", () => seen.push("detect")), rt.on("act", () => seen.push("act"))];
    let events = 0;
    const offE = rt.on("event", () => events++);
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    expect(seen).toEqual(["decide", "detect", "act"]);
    expect(events).toBeGreaterThan(2);
    offs.forEach((f) => f());
    offE();
    void rt.op("w", () => a.set(3));
    await clock.flush();
    expect(seen.length).toBe(3);
  });
});

describe("GenClass.init and the kill switch", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  afterEach(() => {
    GenClass.destroy();
    delete g.location;
  });

  it("init is idempotent and destroy clears the runtime", () => {
    const a = GenClass.init({ model: false, report: "silent", observe: { fetch: false, timers: false } });
    const b = GenClass.init();
    expect(a).toBe(b);
    expect(GenClass.runtime).toBe(a);
    expect(a.status.state).toBe("off");
    GenClass.destroy();
    expect(GenClass.runtime).toBeNull();
  });

  it("?genclass=off installs nothing and says so once", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    g.location = { search: "?genclass=off", href: "http://x/?genclass=off", pathname: "/" };
    const origFetch = g.fetch;
    const rt = GenClass.init({ model: false });
    expect(g.fetch).toBe(origFetch);
    expect(rt.mode).toBe("observe");
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(/Disabled by \?genclass=off/);
    info.mockRestore();
  });

  it("?genclass=heal promotes only with debug; ?genclass=observe demotes", () => {
    g.location = { search: "?genclass=heal", href: "http://x/?genclass=heal", pathname: "/" };
    let rt = GenClass.init({ model: false, report: "silent", mode: "guard", observe: { fetch: false, timers: false } });
    expect(rt.mode).toBe("guard");
    GenClass.destroy();
    rt = GenClass.init({ model: false, report: "silent", mode: "guard", debug: true, observe: { fetch: false, timers: false } });
    expect(rt.mode).toBe("heal");
    GenClass.destroy();
    g.location = { search: "?genclass=observe", href: "http://x/?genclass=observe", pathname: "/" };
    rt = GenClass.init({ model: false, report: "silent", mode: "guard", observe: { fetch: false, timers: false } });
    expect(rt.mode).toBe("observe");
  });
});
