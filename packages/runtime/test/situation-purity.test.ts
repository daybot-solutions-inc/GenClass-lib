// situation() is side-effect free (CONTRACT §13): building a situation for any trigger kind consumes no op ids,
// records no events or decisions, writes nothing, schedules nothing and calls no provider. The devtools "Now" view
// calls runtime.situation() every second and the sim / realapps probes rely on it, so a probe must never change
// what happens later (op ids included).
import { describe, expect, it } from "vitest";
import type { RuntimeImpl } from "../src/runtime.js";
import type { TriggerKind } from "../src/types.js";
import { FakeClock, defaultScript, setup, type Setup } from "./helpers.js";
import { runStoreSession } from "./browser/ui/session.js";

const KINDS: TriggerKind[] = ["mutation", "request", "delivery", "failure", "stall", "inconsistency", "transition", "error", "ask"];

class FakeWS extends EventTarget {
  static all: FakeWS[] = [];
  constructor(public url: string) {
    super();
    FakeWS.all.push(this);
  }
  send() {}
}

function counters(s: Setup) {
  const rt = s.rt;
  const last = rt.history(1)[0];
  return {
    nextOp: rt.ops.peekNextId,
    ops: rt.ops.byId.size,
    inFlight: rt.ops.inFlight.size,
    events: last ? last.seq : 0,
    decisions: rt.decisions().length,
    actions: rt.interventions().length,
    hub: rt.hub.seq,
    timers: s.clock.pending,
    calls: s.decider.calls.length,
  };
}

/** Build a situation for every trigger kind seen so far (and "ask"); assert nothing changed. */
function probe(s: Setup, seen: Set<TriggerKind>): void {
  const before = counters(s);
  const rt = s.rt as RuntimeImpl & { lastBuilt: Partial<Record<TriggerKind, { spec: Parameters<RuntimeImpl["build"]>[0] }>> };
  rt.situation();
  rt.situation("ask");
  for (const k of KINDS) {
    rt.situation(k);
    const b = rt.lastBuilt[k];
    if (b) {
      rt.build(b.spec); // rebuild from scratch: facts, content comparison, evidence, cadence
      seen.add(k);
    }
  }
  rt.build({ trigger: "ask", about: "now" });
  rt.build({ trigger: "ask", about: "cart" });
  expect(counters(s)).toEqual(before);
}

/** A mixed app that raises every trigger kind (triage "always"), probed (or not) in every kind of context. */
async function scenario(withProbes: boolean): Promise<{ trace: string[]; seen: Set<TriggerKind> }> {
  const holder: { clock?: FakeClock } = {};
  const s = setup({
    triage: "always",
    mode: "heal",
    script: defaultScript({ delivery: { diagnosis: "expected" } }),
    observe: { fetch: true, websocket: true, timers: true, errors: false },
    extraGlobal: {
      WebSocket: FakeWS,
      setTimeout: (fn: () => void, ms: number) => holder.clock!.setTimeout(fn, ms),
      clearTimeout: (h: unknown) => holder.clock!.clearTimeout(h),
    },
  });
  holder.clock = s.clock;
  const seen = new Set<TriggerKind>();
  const p = () => {
    if (withProbes) probe(s, seen);
  };
  const { rt, server, clock } = s;
  const setT = s.g.setTimeout as (f: () => void, ms: number) => unknown;
  let statusN = 0;
  server.on("GET", "/api/search", ({ url }) => {
    const q = url.searchParams.get("q") ?? "";
    return { body: { query: q, items: [{ id: `${q}1`, name: q }] }, latency: q === "ca" ? 700 : 80 };
  });
  server.on("GET", "/api/status", () => (++statusN >= 7 && statusN <= 8 ? { status: 503, latency: 30 } : { body: { ok: true, n: statusN }, latency: statusN === 10 ? 3000 : 60 }));
  server.on("POST", "/api/cart", ({ body }) => ({ status: 201, body: { id: `c${(body ?? "").length}`, ...JSON.parse(body ?? "{}") }, latency: 90 }));
  const search = rt.atom("search", { query: "", items: [] as { id: string; name: string }[] });
  const cart = rt.atom("cart", { items: [] as { id: string; qty: number }[], count: 0 });
  const status = rt.atom("status", { ok: true, n: 0 });
  const ws = new (s.g.WebSocket as typeof FakeWS)("ws://app.test/live");
  ws.addEventListener("message", (e) => {
    p(); // inside a message dispatch (message op ambient)
    const m = JSON.parse((e as MessageEvent).data as string) as { n: number };
    status.set((v) => ({ ...v, n: m.n }));
  });
  const sock = FakeWS.all[FakeWS.all.length - 1];
  sock.dispatchEvent(new Event("open")); // the connection op ends (settled points need nothing in flight)

  // typeahead with an out-of-order response (delivery with a buffered JSON body), probes everywhere
  for (const q of ["c", "ca", "cat"]) {
    rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
      p(); // inside a user handler
      search.set((v) => ({ ...v, query: q }));
      setT(() => {
        p(); // inside a timer callback (lazy timer op ambient)
        void s.fetch(`/api/search?q=${q}`).then(async (r) => {
          p(); // after a response settled (fetch op ambient)
          const d = (await r.json()) as { items: { id: string; name: string }[] };
          search.set((v) => ({ ...v, items: d.items }));
        });
      }, 20);
    });
    await clock.advance(60);
  }
  await clock.advance(1000);
  p();
  // a cart with a learned relation (count == len(items)), then broken (inconsistency); a create (read-your-writes)
  for (let i = 0; i < 4; i++) {
    void rt.op("add", async () => {
      const r = (await (await s.fetch("/api/cart", { method: "POST", body: JSON.stringify({ qty: i + 1 }) })).json()) as { id: string; qty: number };
      cart.set((c) => ({ items: [...c.items, r], count: c.items.length + 1 }));
    });
    await clock.advance(300);
    p();
  }
  await rt.op("bug", () => cart.set((c) => ({ ...c, count: c.count + 5 })));
  await clock.advance(300);
  p();
  // polling with failures (failure), a slow one (stall), a push message (delivery over a websocket)
  for (let i = 0; i < 11; i++) {
    void rt.op("poll", async () => {
      p(); // inside a task
      const r = await s.fetch("/api/status");
      if (r.ok) status.set((await r.json()) as { ok: boolean; n: number });
    });
    sock.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ n: 100 + i }) }));
    await clock.advance(500);
    p();
  }
  await clock.advance(4000);
  // an error and a transition (an op unlike its 20 earlier completions)
  server.on("GET", "/api/count", ({ n }) => ({ body: { n }, latency: 40 }));
  for (let i = 0; i < 23; i++) {
    void s.fetch("/api/count").then(async (r) => {
      const d = (await r.json()) as { n: number };
      if (i === 22) search.set((v) => ({ ...v, query: `n${d.n}` }));
      else status.set((v) => ({ ...v, n: d.n }));
    });
    await clock.advance(200);
  }
  await rt.op("crash", () => rt.reportError(new TypeError("boom")));
  await clock.advance(500);
  p();
  const trace = [
    ...[...rt.ops.byId.values()].map((o) => `op #${o.id} ${o.kind} ${o.name} cause=${o.cause ?? "-"} ${o.status ?? ""}`),
    ...rt.history().map((e) => `ev ${e.seq} ${e.kind} ${e.name} op=${e.op ?? "-"}`),
    ...rt.decisions().map((d) => `dec ${d.id} ${d.trigger} ${d.subject} ${d.action} ${d.facts.join(" | ")}`),
    ...s.decider.calls.map((c) => `call ${c.trigger} ${JSON.stringify(c.state)}`),
    JSON.stringify([...rt.hub.stores.values()].map((x) => x.value)),
  ];
  rt.destroy();
  return { trace, seen };
}

describe("situation() is side-effect free", () => {
  it("building situations for every trigger kind, in every context, changes no counter and no later id", async () => {
    const plain = await scenario(false);
    const probed = await scenario(true);
    expect([...probed.seen].sort()).toEqual(KINDS.filter((k) => k !== "ask").sort());
    expect(probed.trace).toEqual(plain.trace);
  });

  it("polling the runtime like the devtools overlay (every microtask turn) changes no decision, hold or id", async () => {
    const snapshot = async (poll: boolean) => {
      let rt: import("../src/types.js").Runtime | null = null;
      const g = globalThis as { setImmediate?: (fn: () => void) => void };
      const turn = () =>
        new Promise<void>((r) =>
          g.setImmediate!(() => {
            if (poll && rt) {
              rt.situation();
              rt.inflight();
              for (const d of rt.decisions(5)) rt.explain(d.id);
              rt.interventions();
              rt.history(50);
            }
            r();
          }),
        );
      const S = await runStoreSession({ turn, onRuntime: (x) => (rt = x) });
      const r = S.rt as RuntimeImpl;
      const out = {
        decisions: r.decisions().map((d) => `${d.id} ${d.trigger} ${d.subject} ${d.action} ${d.executed} ${d.reason ?? ""}`),
        actions: r.interventions().map((a) => `${a.id} ${a.action} ${a.changed}`),
        ops: [...r.ops.byId.values()].map((o) => `#${o.id} ${o.name} ${o.status ?? ""} ${o.end ?? ""}`),
        events: r.history().map((e) => `${e.seq} ${e.kind} ${e.name} ${e.t}`),
        nextOp: r.ops.peekNextId,
      };
      r.destroy();
      return out;
    };
    const quiet = await snapshot(false);
    const polled = await snapshot(true);
    expect(polled).toEqual(quiet);
    expect(quiet.actions.length).toBeGreaterThan(0); // the story does hold and act
  }, 60_000);
});
