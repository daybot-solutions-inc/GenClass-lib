// Invariant suite, network boundary (CONTRACT §7, §8; OPTIONS-SPEC §4.4). Each test names a guarantee the runtime
// keeps by itself, whatever the model answers: the model here is an Adversary (probability 1 on the most disruptive
// action, offered or not, with a non-"expected" diagnosis), the mode is heal (everything permitted) at the eager
// profile with every situation consulted (triage "always"). See packages/runtime/INTERCEPTION.md for the action
// preconditions these tests pin down.
import { describe, expect, it } from "vitest";
import type { ActionRequest, Answer, EvaluateRequest, Mode } from "../../src/types.js";
import { FakeClock, ManualDecider, defaultScript, setup, type Setup } from "../helpers.js";
import { Adversary, harmful, insist, ran } from "./adversary.js";

const HOSTILE = { mode: "heal" as const, aggressiveness: "eager" as const, triage: "always" as const, breaker: false as const };

function hostile(pick = harmful, extra: Parameters<typeof setup>[0] = {}): Setup & { adv: Adversary } {
  const adv = new Adversary(pick);
  const s = setup({ ...HOSTILE, decider: adv, ...extra });
  adv.clock = s.clock;
  return { ...s, adv };
}

/** Settle a promise into a plain record of what the app saw, and when. */
function watch(s: Setup, p: Promise<Response>): { t?: number; status?: number; error?: string; marked?: string | null } {
  const out: { t?: number; status?: number; error?: string; marked?: string | null } = {};
  p.then(
    (r) => Object.assign(out, { t: s.clock.now(), status: r.status, marked: r.headers.get("x-genclass") }),
    (e: unknown) => Object.assign(out, { t: s.clock.now(), error: String((e as Error)?.name ?? e) }),
  );
  return out;
}

const hits = (s: Setup, key: string) => s.server.hits.get(key) ?? 0;

describe("invariant: a non-idempotent request without an idempotency key is never sent twice", () => {
  for (const method of ["POST", "PATCH"]) {
    for (const failure of ["http", "network"] as const) {
      it(`${method}, ${failure} failure, model insists on retry → sent once, the app gets the original failure`, async () => {
        const s = hostile(insist("retry"));
        s.server.on(method, "/api/orders", failure === "http" ? { status: 503, body: {}, latency: 20 } : { error: "network", latency: 20 });
        const seen = watch(s, s.fetch("/api/orders", { method, body: '{"sku":"A1"}', headers: { "content-type": "application/json", "X-Request-Id": "r1" } }));
        await s.clock.advance(20_000);
        expect(hits(s, `${method} /api/orders`)).toBe(1);
        if (failure === "http") expect(seen.status).toBe(503);
        else expect(seen.error).toBe("TypeError");
        expect(ran(s.rt)).not.toContain("failure:retry");
        // the model was asked (detection) but retry was never offered to it, with the reason recorded
        const f = s.adv.calls.find((c) => c.trigger === "failure");
        expect(f?.notOffered?.retry).toMatch(/is not idempotent and the request has no idempotency key header/);
      });
    }
  }

  it("a POST as a Request object, model insists on retry → sent once", async () => {
    const s = hostile(insist("retry"));
    s.server.on("POST", "/api/orders", { status: 500, body: {}, latency: 20 });
    const seen = watch(s, s.fetch(new Request("http://app.test/api/orders", { method: "POST", body: '{"sku":"A1"}' }) as unknown as string));
    await s.clock.advance(20_000);
    expect(hits(s, "POST /api/orders")).toBe(1);
    expect(seen.status).toBe(500);
  });

  it("a stalled POST, model insists on hedge → never duplicated", async () => {
    const s = hostile(insist("hedge"));
    s.server.on("POST", "/api/report", { status: 200, body: {}, latency: 30_000 });
    const seen = watch(s, s.fetch("/api/report", { method: "POST", body: "{}" }));
    await s.clock.advance(40_000);
    expect(hits(s, "POST /api/report")).toBe(1);
    expect(seen.status).toBe(200);
  });

  it("control: the same hostile model does retry an idempotent PUT (the adversary is effective)", async () => {
    const s = hostile(insist("retry"));
    s.server.on("PUT", "/api/orders", ({ n }) => (n === 1 ? { status: 503, body: {}, latency: 20 } : { status: 200, body: {}, latency: 20 }));
    const seen = watch(s, s.fetch("/api/orders", { method: "PUT", body: "{}" }));
    await s.clock.advance(20_000);
    expect(hits(s, "PUT /api/orders")).toBe(2);
    expect(seen.status).toBe(200);
  });
});

describe("invariant: an action the runtime did not offer never runs (out-of-vocabulary answers)", () => {
  for (const action of ["retry", "block", "serve_cached", "rollback", "hedge", "self_destruct"]) {
    it(`guard mode, the model puts probability 1 on ${action} for every trigger → nothing runs`, async () => {
      const s = hostile(insist(action), { mode: "guard" });
      s.server.on("GET", "/api/x", ({ n }) => (n % 2 ? { status: 500, body: {}, latency: 10 } : { status: 200, body: { v: n }, latency: 10 }));
      for (let i = 0; i < 4; i++) {
        void s.fetch("/api/x").catch(() => undefined);
        await s.clock.advance(1000);
      }
      expect(ran(s.rt)).toEqual([]);
      expect(s.rt.decisions().length).toBeGreaterThan(0);
      expect(s.rt.decisions().every((d) => d.ran === d.action || !d.executed || d.tier === "passive")).toBe(true);
    });
  }
});

describe("invariant: requests.protect endpoints are never held, delayed, retried, replayed, hedged, coalesced, cached or discarded", () => {
  function protectedApp(): Setup & { adv: Adversary; vetoes: ActionRequest[] } {
    const vetoes: ActionRequest[] = [];
    const adv = new Adversary(harmful);
    const s = setup({ ...HOSTILE, decider: adv, requests: { protect: ["/api/pay"] }, onBeforeAction: (a) => (vetoes.push(a), undefined) });
    adv.clock = s.clock;
    return { ...s, adv, vetoes };
  }

  it("identical GETs, a keyed POST that fails, and a stall: every request goes out synchronously inside fetch() and every answer reaches the app at network time", async () => {
    const s = protectedApp();
    s.server.on("GET", "/api/pay/status", { body: { ok: true }, latency: 40 });
    s.server.on("POST", "/api/pay", ({ n }) => (n === 1 ? { status: 503, body: {}, latency: 30 } : { status: 200, body: {}, latency: 30 }));
    s.server.on("GET", "/api/pay/slow", { body: { ok: true }, latency: 25_000 });
    const sentSync: boolean[] = [];
    const call = (u: string, i?: RequestInit) => {
      const before = s.server.log.length;
      const p = s.fetch(u, i);
      sentSync.push(s.server.log.length === before + 1);
      return watch(s, p);
    };
    const t0 = s.clock.now();
    const a = call("/api/pay/status");
    await s.clock.advance(60); // a finished: cached and shareable for the next identical GET
    const b = call("/api/pay/status");
    const c = call("/api/pay", { method: "POST", body: "{}", headers: { "Idempotency-Key": "k1" } });
    const d = call("/api/pay/slow");
    await s.clock.advance(30_000);
    expect(sentSync).toEqual([true, true, true, true]);
    expect(a).toMatchObject({ t: t0 + 40, status: 200, marked: null });
    expect(b).toMatchObject({ t: t0 + 60 + 40, status: 200, marked: null });
    expect(c).toMatchObject({ t: t0 + 60 + 30, status: 503 });
    expect(d).toMatchObject({ t: t0 + 60 + 25_000, status: 200 });
    expect(hits(s, "GET /api/pay/status")).toBe(2);
    expect(hits(s, "POST /api/pay")).toBe(1);
    expect(hits(s, "GET /api/pay/slow")).toBe(1);
    expect(ran(s.rt)).toEqual([]);
    expect(s.vetoes).toEqual([]); // onBeforeAction is never even asked about a protected subject
    const reasons = s.rt.decisions().map((x) => x.reason);
    expect(reasons).toContain("protected");
  });

  it("a protected Request object with a body is sent synchronously too (no identity read before sending)", async () => {
    const s = protectedApp();
    s.server.on("POST", "/api/pay", { status: 200, body: {}, latency: 30 });
    const before = s.server.log.length;
    const p = s.fetch(new Request("http://app.test/api/pay", { method: "POST", body: '{"amount":1}' }) as unknown as string);
    expect(s.server.log.length).toBe(before + 1);
    const seen = watch(s, p);
    await s.clock.advance(100);
    expect(seen.status).toBe(200);
    expect(ran(s.rt)).toEqual([]);
  });

  it("a stale out-of-order protected response is delivered at network time and its writes are never reverted", async () => {
    const s = protectedApp();
    s.server.on("GET", "/api/pay/quote", ({ url }) => ({ body: { q: url.searchParams.get("q") }, latency: url.searchParams.get("q") === "1" ? 500 : 50 }));
    const quote = s.rt.atom("quote", { q: "" });
    const arrived: Record<string, number> = {};
    const load = (q: string) =>
      s.rt.user({ kind: "click", target: `button "${q}"` }, () => {
        void s.fetch(`/api/pay/quote?q=${q}`).then(async (r) => {
          arrived[q] = s.clock.now();
          const body = (await r.json()) as { q: string };
          quote.set({ q: body.q });
        });
      });
    const t0 = s.clock.now();
    load("1");
    await s.clock.advance(10);
    load("2");
    await s.clock.advance(3000);
    expect(arrived).toEqual({ "1": t0 + 500, "2": t0 + 10 + 50 });
    expect(quote.get()).toEqual({ q: "1" }); // exactly what the app does without GenClass (the stale write applies)
    expect(ran(s.rt)).toEqual([]);
  });

  /** A checkout quote whose response callback writes the state later, through a timer (a debounced UI update). */
  async function quoteViaTimer(protect: boolean): Promise<{ s: Setup; quote: { get(): { q: string } } }> {
    const ref: { clock?: FakeClock } = {};
    const adv = new Adversary(harmful);
    const s = setup({
      ...HOSTILE,
      decider: adv,
      policy: { holdWrites: true },
      ...(protect ? { requests: { protect: ["preset:payments"] } } : {}),
      observe: { fetch: true, timers: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false },
      extraGlobal: { setTimeout: (fn: () => void, ms: number) => ref.clock!.setTimeout(fn, ms) },
    });
    ref.clock = s.clock;
    adv.clock = s.clock;
    s.server.on("GET", "/api/checkout/quote", ({ url }) => ({ body: { q: url.searchParams.get("q") }, latency: url.searchParams.get("q") === "1" ? 500 : 50 }));
    const quote = s.rt.atom("quote", { q: "" });
    const later = s.g.setTimeout as (fn: () => void, ms: number) => unknown;
    const load = (q: string) =>
      s.rt.user({ kind: "click", target: `button "${q}"` }, () => {
        void s
          .fetch(`/api/checkout/quote?q=${q}`)
          .then((r) => r.json())
          .then((b: { q: string }) => later(() => quote.set({ q: b.q }), 5))
          .catch(() => undefined); // heal may answer 503 (block) with an empty body: the app ignores it
      });
    load("0");
    await s.clock.advance(1500); // learns what the quote's chain writes
    load("1");
    await s.clock.advance(10);
    load("2");
    await s.clock.advance(5000);
    return { s, quote };
  }

  it("the protection covers the response's causal chain: a write its callback makes later (through a timer) is never held, dropped or reverted", async () => {
    const { s, quote } = await quoteViaTimer(true);
    expect(quote.get()).toEqual({ q: "1" }); // the app's own (stale) outcome, exactly as without GenClass
    expect(ran(s.rt)).toEqual([]);
    const timerOps = s.rt.history().filter((e) => e.kind === "op.start" && e.name.startsWith("timer"));
    expect(timerOps.length).toBeGreaterThan(0);
    expect(s.rt.decisions().filter((d) => d.trigger === "mutation").every((d) => d.reason === "protected" || d.ran === "apply")).toBe(true);
  });

  it("control: without requests.protect the same hostile model does act on that write (the adversary is effective)", async () => {
    const { s } = await quoteViaTimer(false);
    expect(ran(s.rt).length).toBeGreaterThan(0);
  });
});

describe("invariant: the hold budget is a hard ceiling on the latency a hold adds", () => {
  /** A fetch on the fake clock whose body arrives `bodyDelay` ms after the headers (a streamed body). */
  function streaming(ref: { clock?: FakeClock; sent: Record<string, number> }, latency: (q: string) => number, bodyDelay: number) {
    return (input: unknown): Promise<Response> => {
      const url = new URL(String(input), "http://app.test/");
      const q = url.searchParams.get("q") ?? "";
      const clock = ref.clock!;
      ref.sent[q] = clock.now();
      return new Promise<Response>((resolve) => {
        clock.setTimeout(() => {
          const bytes = new TextEncoder().encode(JSON.stringify({ q, items: [`${q}-1`] }));
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              clock.setTimeout(() => {
                c.enqueue(bytes);
                c.close();
              }, bodyDelay);
            },
          });
          resolve(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
        }, latency(q));
      });
    };
  }

  /** Answers every trigger at once with the passive action, except deliveries: those are never answered. */
  class SilentOnDelivery extends ManualDecider {
    override evaluate(req: EvaluateRequest): Promise<Record<string, Answer>> {
      if (req.trigger === "delivery") return new Promise(() => undefined);
      return Promise.resolve(defaultScript()(req) as Record<string, Answer>);
    }
  }

  for (const budget of [150, 300]) {
    it(`a stale delivery with a slow body and a model that never answers: released within holdBudgetMs (${budget} ms) of arriving`, async () => {
      const ref: { clock?: FakeClock; sent: Record<string, number> } = { sent: {} };
      const s = setup({ mode: "guard", decider: new SilentOnDelivery(), policy: { holdBudgetMs: budget }, extraGlobal: { fetch: streaming(ref, (q) => (q === "a" ? 600 : 100), 300) } });
      ref.clock = s.clock;
      const st = s.rt.atom("search", { items: [] as string[] });
      const resolved: Record<string, number> = {};
      const load = (q: string) =>
        s.rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
          void s.fetch(`/api/search?q=${q}`).then(async (r) => {
            resolved[q] = s.clock.now();
            const d = (await r.json()) as { items: string[] };
            st.set({ items: d.items });
          });
        });
      load("z");
      await s.clock.advance(1500); // z learns the write set
      // a (slow) then ab: ab's result is applied before a's response arrives, so a's delivery is over newer data; a's
      // body then takes 300 ms, longer than the 100 ms the gate waits for a body before deciding
      load("a");
      await s.clock.advance(20);
      load("ab");
      await s.clock.advance(5000);
      const added = resolved.a - (ref.sent.a + 600); // after the response arrived
      expect(added).toBeGreaterThan(0); // it was held (salient, guard, a model expected in time)
      expect(added).toBeLessThanOrEqual(budget);
    });
  }

  it("a salient request whose body must be read first, with a model that never answers, is sent within holdBudgetMs of the fetch() call", async () => {
    const manual = new ManualDecider();
    const s = setup({ mode: "guard", decider: manual, triage: "always", policy: { holdBudgetMs: 200 } });
    s.server.on("POST", "/api/x", { body: {}, latency: 10 });
    const clock = s.clock;
    // a streamed request body that takes 1 s to produce: the identity read gives up after 100 ms
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        clock.setTimeout(() => {
          c.enqueue(new TextEncoder().encode("{}"));
          c.close();
        }, 1000);
      },
    });
    const t0 = s.clock.now();
    void s.fetch(new Request("http://app.test/api/x", { method: "POST", body, duplex: "half" } as RequestInit) as unknown as string).catch(() => undefined);
    await s.clock.advance(2000);
    expect(s.server.log.length).toBe(1);
    expect(s.server.log[0].t - t0).toBeLessThanOrEqual(200);
  });
});

describe("invariant: a sequential sync loop is never reordered or duplicated", () => {
  async function run(enabled: boolean, mode: Mode, extra: Parameters<typeof setup>[0] = {}): Promise<{ order: string[]; state: unknown }> {
    const adv = new Adversary(harmful);
    const s = setup({ ...HOSTILE, triage: "salient", mode, decider: adv, enabled, extraGlobal: { navigator: { onLine: false } }, ...extra });
    adv.clock = s.clock;
    const order: string[] = [];
    let online = false;
    s.server.on("POST", "/api/sync", ({ body }) => {
      if (!online) return { error: "network", latency: 5 };
      const id = String((JSON.parse(body ?? "{}") as { id: string }).id);
      order.push(id);
      return { status: 201, body: { id, saved: true }, latency: 30 + (order.length % 3) * 40 };
    });
    const outbox = s.rt.atom("outbox", { pending: ["1", "2", "3", "4", "5"], synced: [] as string[] });
    const flush = async () => {
      while (outbox.get().pending.length) {
        const id = outbox.get().pending[0];
        let r: Response;
        try {
          r = await s.fetch("/api/sync", { method: "POST", body: JSON.stringify({ id }), headers: { "content-type": "application/json" } });
        } catch {
          return; // offline: try again later
        }
        if (!r.ok) return;
        const d = (await r.json()) as { id: string };
        outbox.set((v) => ({ pending: v.pending.slice(1), synced: [...v.synced, d.id] }));
      }
    };
    void flush(); // offline: fails
    await s.clock.advance(1000);
    online = true;
    (s.g.navigator as { onLine: boolean }).onLine = true;
    void flush();
    await s.clock.advance(20_000);
    return { order, state: outbox.get() };
  }

  it("guard, offline → online: items reach the server once each, in the app's order; the app's view equals the run without GenClass", async () => {
    const base = await run(false, "guard");
    const guarded = await run(true, "guard");
    expect(base.order).toEqual(["1", "2", "3", "4", "5"]);
    expect(guarded.order).toEqual(base.order);
    expect(guarded.state).toEqual(base.state);
  });

  it("heal (a hostile model may block requests): whatever is sent is sent once, in the app's order", async () => {
    const r = await run(true, "heal");
    expect(r.order).toEqual(["1", "2", "3", "4", "5"].slice(0, r.order.length));
  });

  it("requests.protect on the sync endpoint: also with every write consulted (triage 'always'), nothing in the loop is acted on", async () => {
    const base = await run(false, "guard");
    const r = await run(true, "guard", { triage: "always", requests: { protect: ["/api/sync"] } });
    expect(r.order).toEqual(base.order);
    expect(r.state).toEqual(base.state);
  });

  it("documented residual risk: with every write consulted (triage 'always') a hostile model can late-revert the loop's own bookkeeping write, so the app re-sends; policy.actionLimits.perSubject bounds it", async () => {
    const r = await run(true, "guard", { triage: "always", policy: { actionLimits: { perSubject: 2 } } });
    // each revert costs two actions on the subject (the delivery discard and the late revert): one repeat per minute
    expect(r.order.length).toBeGreaterThan(5);
    expect(r.order.length).toBeLessThanOrEqual(5 + 2);
  });
});
