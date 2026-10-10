// Invariant suite, observe mode and repeated user actions (CONTRACT §13 default mode; OPTIONS-SPEC §0.4 gate).
//   - observe never changes what the app sees, nor when: every request goes out when the app sends it, every answer
//     and every store write reaches the app exactly as in a run without GenClass, whatever the model answers;
//   - a repeated deliberate user action is never coalesced unless the mode permits coalesce, policy allows it, the
//     endpoint is not protected, and the model's probability clears the gate.
import { describe, expect, it } from "vitest";
import type { Mode } from "../../src/types.js";
import { ManualDecider, setup, type Setup } from "../helpers.js";
import { Adversary, harmful, insist, ran } from "./adversary.js";

/** Everything the app can observe, with virtual timestamps: answers (status, body, headers), store values, sends. */
async function appTrace(s: Setup): Promise<string[]> {
  const out: string[] = [];
  const t = () => s.clock.now();
  s.server.on("GET", "/api/search", ({ url }) => {
    const q = url.searchParams.get("q") ?? "";
    return { body: { q, items: [`${q}-1`] }, latency: q === "a" ? 600 : 100 };
  });
  s.server.on("GET", "/api/feed", ({ n }) => ({ body: { n }, latency: 300 }));
  s.server.on("POST", "/api/orders", ({ n }) => (n === 1 ? { status: 500, body: { error: "x" }, latency: 40 } : { status: 201, body: { id: n }, latency: 40 }));
  s.server.on("PUT", "/api/flaky", ({ n }) => (n % 2 ? { error: "network", latency: 30 } : { status: 200, body: {}, latency: 30 }));
  s.server.on("GET", "/api/slow", { body: { ok: 1 }, latency: 15_000 });
  const st = s.rt.atom("search", { items: [] as string[], feed: 0 });
  st.subscribe((v) => out.push(`${t()} state ${JSON.stringify(v)}`));
  const answer = async (label: string, p: Promise<Response>) => {
    try {
      const r = await p;
      const text = await r.text();
      out.push(`${t()} ${label} ${r.status} ${r.headers.get("x-genclass") ?? "-"} ${text}`);
      return text;
    } catch (e) {
      out.push(`${t()} ${label} threw ${(e as Error).name}`);
      return null;
    }
  };
  const search = (q: string) =>
    s.rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
      void answer(`search ${q}`, s.fetch(`/api/search?q=${q}`)).then((txt) => txt && st.set((v) => ({ ...v, items: JSON.parse(txt).items })));
    });
  search("z");
  await s.clock.advance(300);
  search("a");
  await s.clock.advance(20);
  search("ab");
  // identical GETs in flight (coalesce / serve_cached candidates)
  for (let i = 0; i < 3; i++) void answer(`feed ${i}`, s.fetch("/api/feed")).then((txt) => txt && st.set((v) => ({ ...v, feed: JSON.parse(txt).n })));
  // a failing POST (retry candidate), a flaky idempotent PUT (retry), a stall (hedge, serve_cached)
  void answer("order", s.fetch("/api/orders", { method: "POST", body: "{}" }));
  void answer("flaky", s.fetch("/api/flaky", { method: "PUT", body: "{}" }));
  void answer("slow", s.fetch("/api/slow"));
  await s.clock.advance(30_000);
  for (const l of s.server.log) out.push(`${l.t} sent ${l.method} ${l.path}`);
  return out;
}

describe("invariant: observe mode never changes delivery timing or content", () => {
  for (const [name, pick] of [
    ["the most disruptive action", harmful],
    ["block", insist("block")],
    ["serve_cached", insist("serve_cached")],
    ["coalesce", insist("coalesce")],
  ] as const) {
    it(`a model that always answers ${name} (every situation consulted): the app's trace equals the run without GenClass`, async () => {
      const base = await appTrace(setup({ enabled: false }));
      const adv = new Adversary(pick);
      const s = setup({ mode: undefined, triage: "always", decider: adv, aggressiveness: "eager" });
      adv.clock = s.clock;
      const trace = await appTrace(s);
      expect(trace).toEqual(base);
      expect(ran(s.rt)).toEqual([]);
      expect(s.rt.decisions().length).toBeGreaterThan(0);
      expect(s.rt.decisions().every((d) => !d.executed || d.tier === "passive")).toBe(true);
    });
  }

  it("a model that never answers changes nothing either", async () => {
    const base = await appTrace(setup({ enabled: false }));
    const s = setup({ mode: undefined, triage: "always", decider: new ManualDecider() });
    expect(await appTrace(s)).toEqual(base);
  });

  it("shadow: 'heal' only records what heal would do; the app's trace is unchanged", async () => {
    const base = await appTrace(setup({ enabled: false }));
    const adv = new Adversary(harmful);
    const s = setup({ mode: undefined, shadow: "heal", triage: "always", decider: adv });
    adv.clock = s.clock;
    const trace = await appTrace(s);
    expect(trace).toEqual(base);
    expect(s.rt.decisions().some((d) => d.shadow?.wouldPass)).toBe(true);
  });
});

// --------------------------------------------------------------------------------------- repeated user actions

/** The user clicks "Add to cart" `n` times, `gap` ms apart; each click POSTs the identical body. */
async function addToCart(s: Setup, n: number, gap: number): Promise<{ sent: number; answers: string[] }> {
  s.server.on("POST", "/api/cart", ({ n: k }) => ({ status: 201, body: { line: k }, latency: 300 }));
  const answers: string[] = [];
  for (let i = 0; i < n; i++) {
    s.rt.user({ kind: "click", target: 'button "Add to cart"' }, () => {
      void s.fetch("/api/cart", { method: "POST", body: '{"sku":"A1","qty":1}', headers: { "content-type": "application/json" } }).then(
        (r) => answers.push(`${r.status} ${r.headers.get("x-genclass") ?? "-"}`),
        () => answers.push("threw"),
      );
    });
    await s.clock.advance(gap);
  }
  await s.clock.advance(10_000);
  return { sent: s.server.hits.get("POST /api/cart") ?? 0, answers };
}

describe("invariant: a repeated deliberate user action is coalesced only when mode, policy, protection and the gate all allow it", () => {
  const blocked: [string, Mode | undefined, Parameters<typeof setup>[0]][] = [
    ["observe mode", undefined, {}],
    ["policy.deny: ['coalesce']", "guard", { policy: { deny: ["coalesce"] } }],
    ["policy.allow without coalesce", "guard", { policy: { allow: ["discard", "defer"] } }],
    ["a protected endpoint", "heal", { requests: { protect: ["/api/cart"] } }],
    ["the gate threshold above the model's probability", "guard", { policy: { thresholds: { guard: 1.01 } } }],
    ["onBeforeAction veto", "guard", { onBeforeAction: (a: { action: string }) => a.action !== "coalesce" }],
  ];
  for (const [name, mode, extra] of blocked) {
    it(`${name}: three clicks send three requests, even when the model insists on coalesce`, async () => {
      const adv = new Adversary(insist("coalesce"));
      const s = setup({ mode, triage: "always", decider: adv, breaker: false, ...extra });
      adv.clock = s.clock;
      const r = await addToCart(s, 3, 100);
      expect(r.sent).toBe(3);
      expect(r.answers).toEqual(["201 -", "201 -", "201 -"]);
      expect(ran(s.rt)).not.toContain("request:coalesce");
    });
  }

  it("documented residual risk: in guard mode, with everything allowing it and a model at probability 1, an identical POST within the coalescing window is coalesced (no undo exists for it)", async () => {
    const adv = new Adversary(insist("coalesce"));
    const s = setup({ mode: "guard", triage: "always", decider: adv, breaker: false });
    adv.clock = s.clock;
    const r = await addToCart(s, 2, 100);
    expect(r.sent).toBe(1);
    expect([...r.answers].sort()).toEqual(["201 -", "201 coalesced"]);
    const rec = s.rt.interventions().find((a) => a.action === "coalesce")!;
    expect(rec.undo).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------- request bodies, observe mode

describe("invariant: observe mode never delays a request, also one whose body GenClass reads for its identity", () => {
  const cases: [string, () => [unknown, RequestInit | undefined]][] = [
    ["a Request object with a body", () => [new Request("http://app.test/api/orders", { method: "POST", body: '{"sku":"A1"}' }), undefined]],
    ["a Blob body", () => ["/api/orders", { method: "POST", body: new Blob(['{"sku":"A1"}']) }]],
  ];
  for (const [name, mk] of cases) {
    it(`${name}: sent synchronously inside fetch(), exactly as without GenClass, while the model insists on block`, async () => {
      const adv = new Adversary(insist("block"));
      const s = setup({ mode: undefined, triage: "always", decider: adv });
      adv.clock = s.clock;
      s.server.on("POST", "/api/orders", { status: 201, body: { id: 1 }, latency: 30 });
      const before = s.server.log.length;
      const t0 = s.clock.now();
      const [input, init] = mk();
      const p = s.fetch(input as string, init);
      expect(s.server.log.length).toBe(before + 1); // already sent: no microtask, no body read first
      let status = 0;
      let at = 0;
      void p.then((r) => {
        status = r.status;
        at = s.clock.now();
      });
      await s.clock.advance(1000);
      expect(status).toBe(201);
      expect(at).toBe(t0 + 30);
      expect(ran(s.rt)).toEqual([]);
      // still decided in the background (detection), once the identity was read from the body
      expect(adv.calls.some((c) => c.trigger === "request")).toBe(true);
    });
  }
});
