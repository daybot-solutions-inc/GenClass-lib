// The default mode is observe: with no `mode`, GenClass reports what it sees and never holds, delays or changes
// anything, even when the model is sure, and even when the model never answers. guard is opt-in.

import { afterEach, describe, expect, it } from "vitest";
import { GenClass } from "../src/index.js";
import type { Detection } from "../src/types.js";
import { ManualDecider, defaultScript, setup } from "./helpers.js";

/** A minimal redux-like store for the adapter seam. */
function counterStore() {
  let state = { count: 0 };
  const subs = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (f: () => void) => (subs.add(f), () => subs.delete(f)),
    inc: (s: { count: number }) => ({ count: s.count + 1 }),
    commit(next: { count: number }) {
      state = next;
      subs.forEach((f) => f());
    },
  };
}

describe("default mode is observe (MVP)", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  afterEach(() => {
    GenClass.destroy();
    delete g.location;
  });

  it("createRuntime without a mode starts in observe", () => {
    const { rt } = setup({ mode: undefined }); // the test harness otherwise defaults to guard
    expect(rt.mode).toBe("observe");
  });

  it("GenClass.init without a mode starts in observe; guard is opt-in (option or ?genclass=guard)", () => {
    const opts = { model: false as const, report: "silent" as const, observe: { fetch: false, timers: false } };
    expect(GenClass.init(opts).mode).toBe("observe");
    GenClass.destroy();
    expect(GenClass.init({ ...opts, mode: "guard" }).mode).toBe("guard");
    GenClass.destroy();
    g.location = { search: "?genclass=guard", href: "http://x/?genclass=guard", pathname: "/" };
    expect(GenClass.init(opts).mode).toBe("guard");
  });

  it("never holds writes or requests even when the model is sure; findings are still reported", async () => {
    const { rt, clock, server, fetch } = setup({
      mode: undefined,
      triage: "always",
      script: defaultScript({ mutation: { diagnosis: "stale", action: "discard", p: 0.99 }, request: { diagnosis: "overload", action: "block", p: 0.99 } }),
    });
    const detections: Detection[] = [];
    rt.on("detect", (d) => detections.push(d));
    server.on("GET", "/api/x", { body: 1, latency: 5 });
    const a = rt.atom("a", 0);
    void rt.op("w", () => a.set(1));
    expect(a.get()).toBe(1); // applied synchronously
    const t0 = clock.now();
    const p = fetch("/api/x");
    await clock.advance(5);
    expect((await p).status).toBe(200);
    expect(server.log[0].t).toBe(t0); // sent at once
    await clock.flush();
    expect(a.get()).toBe(1);
    const ds = rt.decisions();
    expect(ds.map((d) => d.trigger).sort()).toEqual(["mutation", "request"]);
    expect(ds.every((d) => !d.executed)).toBe(true);
    expect(rt.interventions()).toEqual([]);
    expect(detections.map((d) => d.diagnosis).sort()).toEqual(["overload", "stale"]);
  });

  it("never waits for the model: with a model that never answers, nothing is delayed", async () => {
    const manual = new ManualDecider();
    const { rt, clock, server, fetch } = setup({ mode: undefined, decider: manual, triage: "always" });
    server.on("GET", "/api/ok", { body: 1, latency: 5 });
    server.on("GET", "/api/fail", { status: 500, body: { error: "boom" }, latency: 5 });

    const a = rt.atom("a", 0);
    void rt.op("w", () => a.set(1));
    expect(a.get()).toBe(1);

    const store = counterStore();
    const h = rt.adapter("shop", { get: store.getState, subscribe: store.subscribe });
    void rt.op("sync", () => h.propose({ fn: (prev) => store.inc(prev as { count: number }), commit: (n) => store.commit(n as { count: number }) }));
    expect(store.getState().count).toBe(1); // an async adapter write is committed at once (guard would hold it)

    const t0 = clock.now();
    const ok = fetch("/api/ok");
    const fail = fetch("/api/fail");
    await clock.advance(5);
    expect((await ok).status).toBe(200);
    expect((await fail).status).toBe(500); // the failure is delivered as is, not held for a retry decision
    expect(server.log.map((l) => l.t)).toEqual([t0, t0]);

    expect(manual.pending.length).toBeGreaterThan(0); // the model is still asked, in the background
    expect(rt.interventions()).toEqual([]);
  });
});
