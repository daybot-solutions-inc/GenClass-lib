// Delivery triage (situation-v2, heal/overnight): fan-out siblings are not "newer data". Requests of one endpoint
// signature started by the same operation (one timer tick polling several items) complete in arbitrary order; a
// shared field they all write (updatedAt) made every sibling look stale, so a correct polling dashboard asked the
// model about most responses (and held them in guard/heal). Overlapping rounds (a response of an older tick landing
// after the newer tick's) stay salient.
import { describe, expect, it } from "vitest";
import { fanOutSibling } from "../src/runtime.js";
import { FakeClock, setup, type Setup } from "./helpers.js";

function timers(holder: { clock?: FakeClock }) {
  return {
    setTimeout: (fn: () => void, ms: number) => holder.clock!.setTimeout(fn, ms),
    clearTimeout: (h: unknown) => holder.clock!.clearTimeout(h),
  };
}

function board(s: Setup, latency: (id: string, n: number) => number) {
  const ids = ["api", "auth", "cdn", "search"];
  const st = s.rt.atom("board", { services: {} as Record<string, { status: string; n: number }>, updatedAt: 0 });
  for (const id of ids) s.server.on("GET", `/api/status/${id}`, ({ n }) => ({ body: { id, status: "operational", n }, latency: latency(id, n) }));
  const setT = s.g.setTimeout as (f: () => void, ms: number) => unknown;
  /** One poll round: a timer tick that fetches every service at once (no await between them). */
  const round = () =>
    setT(() => {
      for (const id of ids) {
        s.clock.t += 0.02; // a real clock moves while the callback issues its requests
        void (async () => {
          const d = (await (await s.fetch(`/api/status/${id}`)).json()) as { id: string; status: string; n: number };
          st.set((v) => ({ services: { ...v.services, [d.id]: { status: d.status, n: d.n } }, updatedAt: v.updatedAt + 1 }));
        })();
      }
    }, 0);
  return { st, round };
}

describe("delivery triage: fan-out siblings (CONTRACT §13 situation-v2)", () => {
  it("one tick polling several services, answering in any order, asks the model nothing", async () => {
    const holder: { clock?: FakeClock } = {};
    const s = setup({ observe: { fetch: true, timers: true }, extraGlobal: timers(holder) });
    holder.clock = s.clock;
    const lat: Record<string, number> = { api: 120, auth: 40, cdn: 90, search: 60 };
    const b = board(s, (id, n) => lat[id] + ((n * 37) % 50));
    let afterFirst = 0;
    for (let i = 0; i < 4; i++) {
      b.round();
      await s.clock.advance(2000);
      if (i === 0) afterFirst = s.decider.calls.length;
    }
    expect(Object.keys(b.st.get().services)).toHaveLength(4);
    expect(s.decider.calls.filter((c) => c.trigger === "delivery")).toHaveLength(0);
    // writes of a signature's first completion (nothing predicted yet) are triaged as writes, not deliveries:
    // only the first round may ask about them
    expect(s.decider.calls.slice(afterFirst)).toHaveLength(0);
    s.rt.destroy();
  });

  it("an older round's response landing after the newer round's is still decided", async () => {
    const holder: { clock?: FakeClock } = {};
    const s = setup({ observe: { fetch: true, timers: true }, extraGlobal: timers(holder) });
    holder.clock = s.clock;
    // round 2 (n = 2) of `api` is answered in 1.5 s: round 3's api lands first
    const b = board(s, (id, n) => (id === "api" && n === 2 ? 1500 : 50));
    b.round();
    await s.clock.advance(2000);
    b.round(); // api #2: slow
    await s.clock.advance(400);
    b.round(); // api #3: fast, applied before api #2 arrives
    await s.clock.advance(3000);
    const del = s.decider.calls.filter((c) => c.trigger === "delivery");
    expect(del.length).toBeGreaterThanOrEqual(1);
    expect(del.some((c) => /GET \/api\/status\/api/.test(String(c.state.trigger)))).toBe(true);
    s.rt.destroy();
  });

  it("fanOutSibling: same direct cause and kind, started together", () => {
    const x = { cause: 7, kind: "fetch", start: 1000 };
    expect(fanOutSibling(x, { cause: 7, kind: "fetch", start: 1000.3 })).toBe(true);
    expect(fanOutSibling(x, { cause: 8, kind: "fetch", start: 1000.3 })).toBe(false);
    expect(fanOutSibling(x, { cause: 7, kind: "xhr", start: 1000.3 })).toBe(false);
    expect(fanOutSibling(x, { cause: 7, kind: "fetch", start: 1500 })).toBe(false); // the same op, later: not a burst
    expect(fanOutSibling({ ...x, cause: undefined }, { cause: undefined, kind: "fetch", start: 1000 })).toBe(false);
    expect(fanOutSibling(x, undefined)).toBe(false);
  });
});
