// REVIEW: timers observer (lazy timer ops). A failing test demonstrates a bug.
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { FakeClock } from "./helpers.js";

const ONLY_TIMERS = { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: true };

/** A global whose setTimeout queues callbacks we run by hand (each call = one macrotask). */
function timerWorld() {
  const q: (() => void)[] = [];
  const g: Record<string, unknown> = {
    setTimeout: (fn: () => void) => {
      q.push(fn);
      return q.length;
    },
    clearTimeout: () => undefined,
    location: { href: "http://app.test/", pathname: "/", search: "" },
  };
  const clock = new FakeClock();
  const rt = createRuntime({ clock, global: g, decider: null, report: "silent", observe: ONLY_TIMERS }) as RuntimeImpl;
  const setT = (fn: () => void, ms: number) => (g.setTimeout as (f: () => void, m: number) => unknown)(fn, ms);
  return { q, g, clock, rt, setT };
}

describe("review: recursive setTimeout loops", () => {
  it("a long idle loop (e.g. a clock/heartbeat) does not make the next state write throw", () => {
    const { q, rt, setT } = timerWorld();
    const s = rt.atom("s", 0);
    const N = 200_000; // ~55 min of a 60 Hz setTimeout loop, or ~2.3 days of a 1 s heartbeat
    let i = 0;
    let err: unknown = null;
    const tick = () => {
      i++;
      if (i < N) setT(tick, 16);
      else {
        try {
          s.set(1); // the loop finally touches state
        } catch (e) {
          err = e;
        }
      }
    };
    setT(tick, 16);
    while (q.length) q.shift()!();
    expect(String(err)).toBe("null");
    expect(s.get()).toBe(1);
  });

  it("a polling loop does not retain every past tick's op forever", async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc !== "function") {
      console.log("[review] skipped: run with NODE_OPTIONS=--expose-gc");
      return;
    }
    const { q, rt, clock, setT } = timerWorld();
    const s = rt.atom("s", 0);
    let first: WeakRef<object> | null = null;
    let i = 0;
    const tick = () => {
      i++;
      setT(tick, 1000); // "schedule the next poll first", then do this one's work
      s.set(i); // materializes this tick's timer op
      if (i === 1) {
        const w = rt.history().find((e) => e.kind === "state")!;
        first = new WeakRef(rt.internals.ops.get(w.op)!);
      }
    };
    setT(tick, 1000);
    for (let k = 0; k < 5000; k++) q.shift()!(); // 5,000 ticks; the op registry prunes ops beyond 2,000
    await clock.flush();
    await new Promise((r) => setImmediate(r));
    gc();
    await new Promise((r) => setImmediate(r));
    gc();
    expect(rt.internals.ops.get(1)).toBeUndefined(); // pruned from the registry
    expect(first!.deref()).toBeUndefined(); // ...and not retained elsewhere
  });
});
