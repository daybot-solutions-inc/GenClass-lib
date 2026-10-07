import { describe, expect, it } from "vitest";
import { STATE_CHAR_BUDGET, stateChars, stateText, toJevState } from "../src/situation/serialize.js";
import type { EvaluateRequest } from "../src/types.js";
import { defaultScript, setup, type Setup } from "./helpers.js";

const KEYS = ["app", "trigger", "facts", "in_flight", "timeline", "state", "stats"];

function check(req: EvaluateRequest) {
  expect(Object.keys(req.state)).toEqual(KEYS);
  const facts = req.state.facts as string[];
  expect(Array.isArray(facts)).toBe(true);
  expect(facts.length).toBeLessThanOrEqual(12);
  if (Array.isArray(req.state.timeline)) expect((req.state.timeline as string[]).length).toBeLessThanOrEqual(16);
  if (Array.isArray(req.state.state)) expect((req.state.state as string[]).length).toBeLessThanOrEqual(8);
  expect(stateChars(req.state)).toBeLessThanOrEqual(STATE_CHAR_BUDGET);
  expect(req.questions.diagnosis).toBeDefined();
}

function show(name: string, req: EvaluateRequest) {
  const qs = Object.entries(req.questions)
    .map(([k, q]) => `${k} (${q.type}): ${q.instructions}\n    ${q.type === "choice" ? Object.entries(q.criteria).map(([l, d]) => `${l}: ${d}`).join("\n    ") : ""}`)
    .join("\n  ");
  console.log(`==== ${name} ====\n${stateText(req.state)}\nquestions:\n  ${qs}\n`);
}

async function typeahead(s: Setup) {
  const { rt, clock, server, fetch } = s;
  server.on("GET", "/api/search", ({ url }) => ({ body: { q: url.searchParams.get("q") }, latency: url.searchParams.get("q") === "rea" ? 900 : 120 }));
  const search = rt.atom("search", { query: "", results: [] as string[] });
  const type = (q: string) =>
    rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
      search.set((v) => ({ ...v, query: q }));
      void (async () => {
        const res = await fetch(`/api/search?q=${q}`);
        const data = (await res.json()) as { q: string };
        search.set((v) => ({ ...v, results: [`${data.q}-1`, `${data.q}-2`] }));
      })();
    });
  type("r");
  await clock.advance(80);
  type("re");
  await clock.advance(70);
  type("rea");
  await clock.advance(90);
  type("reac");
  await clock.advance(3000);
}

describe("situations per trigger (CONTRACT §5, §6)", () => {
  it("mutation: a stale response about to overwrite newer results", async () => {
    const s = setup({ script: defaultScript({ mutation: { diagnosis: "stale", action: "discard" } }) });
    await typeahead(s);
    const req = s.decider.calls.filter((c) => c.trigger === "mutation").pop()!;
    check(req);
    show("mutation", req);
    expect(s.rt.hub.get("search")!.value).toEqual({ query: "reac", results: ["reac-1", "reac-2"] });
    expect((req.state.facts as string[])[0]).toMatch(/^search\.results was written once by other operations since this write's cause \(#\d+\) started \(v0 → v1\), last \d\.\d\ds ago by GET \/api\/search\?q=reac \(#\d+\), which started 0\.09s after #\d+, from a later user action \(#\d+\)\.$/);
    expect(req.subject).toMatchObject({ kind: "mutation", store: "search", paths: ["search.results"] });
  });

  it("request: an identical POST while the first is in flight", async () => {
    const s = setup();
    s.server.on("POST", "/api/orders", { status: 201, body: { ok: true }, latency: 400 });
    const cart = s.rt.atom("cart", { items: [{ sku: "A1", qty: 2 }], total: 24 });
    const submit = () =>
      s.rt.user({ kind: "click", target: 'button "Place order"' }, () => {
        void s.fetch("/api/orders", { method: "POST", body: JSON.stringify({ items: cart.get().items, card: "4242" }) });
      });
    submit();
    await s.clock.advance(120);
    submit();
    await s.clock.advance(1000);
    const req = s.decider.calls.find((c) => c.trigger === "request")!;
    check(req);
    show("request", req);
    expect((req.state.facts as string[]).join("\n")).toMatch(/1 identical POST \/api\/orders request in the last 10s: #\d+ in flight/);
    expect(JSON.stringify(req.state)).not.toContain("4242");
  });

  it("failure: a polled endpoint failing several times in a row", async () => {
    const s = setup();
    s.server.on("GET", "/api/status", ({ n }) => (n <= 3 ? { body: { up: true }, latency: 60 } : { status: 503, body: { err: "down" }, latency: 60 }));
    const status = s.rt.atom("status", { up: false, checked: 0 });
    for (let i = 0; i < 6; i++) {
      void s.rt.op("poll", async () => {
        const r = await s.fetch("/api/status");
        if (r.ok) status.set({ up: true, checked: i });
      });
      await s.clock.advance(2000);
    }
    const calls = s.decider.calls.filter((c) => c.trigger === "failure");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const req = calls[2];
    check(req);
    show("failure", req);
    expect((req.state.facts as string[]).join("\n")).toMatch(/3rd GET \/api\/status failure in a row/);
  });

  it("stall: a request far past its learned latency", async () => {
    const s = setup();
    s.server.on("GET", "/api/report/42", ({ n }) => ({ body: { n }, latency: n === 8 ? 30_000 : 200 + n * 10 }));
    for (let i = 0; i < 8; i++) {
      void s.rt.op("refresh", () => s.fetch("/api/report/42"));
      await s.clock.advance(5000);
    }
    const req = s.decider.calls.find((c) => c.trigger === "stall")!;
    check(req);
    show("stall", req);
    expect((req.state.facts as string[])[0]).toMatch(/has been in flight for \d+\.\d+s; GET \/api\/report\/:id usually takes/);
  });

  it("inconsistency: a learned relation breaks at a settled point", async () => {
    const s = setup();
    const cart = s.rt.atom("cart", { items: [] as { id: number; price: number; qty: number }[], total: 0 });
    const add = (id: number, price: number) =>
      s.rt.user({ kind: "click", target: 'button "Add to cart"' }, () => {
        const items = [...cart.get().items, { id, price, qty: 1 }];
        cart.set({ items, total: items.reduce((t, i) => t + i.price * i.qty, 0) });
      });
    add(1, 10);
    await s.clock.advance(300);
    add(2, 5);
    await s.clock.advance(300);
    add(3, 7);
    await s.clock.advance(300);
    s.server.on("PATCH", "/api/cart/3", { body: { qty: 2 }, latency: 150 });
    s.rt.user({ kind: "click", target: 'button "+"' }, () => {
      void (async () => {
        const r = await s.fetch("/api/cart/3", { method: "PATCH", body: JSON.stringify({ qty: 2 }) });
        const { qty } = (await r.json()) as { qty: number };
        cart.set((c) => ({ ...c, items: c.items.map((i) => (i.id === 3 ? { ...i, qty } : i)) })); // forgets the total
      })();
    });
    await s.clock.advance(1000);
    const req = s.decider.calls.find((c) => c.trigger === "inconsistency")!;
    check(req);
    show("inconsistency", req);
    expect((req.state.facts as string[])[0]).toMatch(/cart\.total == sum\(cart\.items\[\*\]\.price \* cart\.items\[\*\]\.qty\) no longer holds: cart\.total = 22, sum\(.*\) = 29/);
    expect(Object.keys((req.questions.action as { criteria: object }).criteria)).toEqual(["ignore", "rollback"]);
  });

  it("transition: an op whose write set differs from its learned profile", async () => {
    const s = setup();
    const cart = s.rt.atom("cart", { items: [] as number[], total: 0 });
    let broken = false;
    s.server.on("POST", "/api/cart", ({ n }) => ({ status: 200, body: { item: n, price: 3 }, latency: 80 }));
    const add = () =>
      s.rt.user({ kind: "click", target: 'button "Add"' }, () => {
        void (async () => {
          const r = await s.fetch("/api/cart", { method: "POST", body: "{}" });
          const { item, price } = (await r.json()) as { item: number; price: number };
          if (broken) cart.set((c) => ({ ...c, items: [...c.items, item] }));
          else cart.set((c) => ({ items: [...c.items, item], total: c.total + price }));
        })();
      });
    for (let i = 0; i < 22; i++) {
      add();
      await s.clock.advance(400);
    }
    broken = true;
    add();
    await s.clock.advance(400);
    const ts = s.decider.calls.filter((c) => c.trigger === "transition");
    expect(ts.length).toBe(1); // the request's anomaly; its ancestor (the click) is not reported twice
    const req = ts[0];
    check(req);
    show("transition", req);
    expect((req.state.facts as string[])[0]).toMatch(/^In the previous 22 completions of POST \/api\/cart its chain wrote cart\.items and cart\.total \(22 of 22 times\); this time it wrote only cart\.items\./);
  });

  it("error: an uncaught error during a request chain", async () => {
    const s = setup();
    s.server.on("GET", "/api/profile", { body: { name: null }, latency: 100 });
    const profile = s.rt.atom("profile", { name: "Ada", loaded: false });
    s.rt.user({ kind: "click", target: 'link "Profile"' }, () => {
      void (async () => {
        const r = await s.fetch("/api/profile");
        const p = (await r.json()) as { name: string | null };
        profile.set({ name: p.name as string, loaded: true });
        try {
          (p.name as unknown as string).toUpperCase();
        } catch (e) {
          s.rt.reportError(e);
        }
      })();
    });
    await s.clock.advance(500);
    const req = s.decider.calls.find((c) => c.trigger === "error")!;
    check(req);
    show("error", req);
    expect((req.state.facts as string[])[0]).toMatch(/^Uncaught TypeError: /);
  });

  it("ask: the situation about now is side-effect free", async () => {
    const s = setup();
    await typeahead(s);
    const before = { ops: s.rt.ops.byId.size, events: s.rt.history().length };
    const sit = s.rt.situation();
    const again = s.rt.situation();
    expect(sit.state).toEqual(again.state);
    expect({ ops: s.rt.ops.byId.size, events: s.rt.history().length }).toEqual(before);
    console.log(`==== ask (situation now) ====\n${stateText(sit.state)}\n`);
    expect(sit.trigger).toBe("ask");
  });
});

describe("serializer", () => {
  it("keeps the state within the character budget: timeline first, then state, then facts", () => {
    const long = (n: number, w: number) => Array.from({ length: n }, (_, i) => `${i} ${"word ".repeat(w)}`);
    const st = toJevState({ app: "App — /x", trigger: "t", facts: long(12, 40), in_flight: long(6, 10), timeline: long(16, 20), state: long(8, 20), stats: long(2, 10) });
    expect(stateChars(st)).toBeLessThanOrEqual(STATE_CHAR_BUDGET);
    expect(st.timeline).toBe("none");
    const small = toJevState({ app: "a", trigger: "t", facts: ["f"], in_flight: [], timeline: long(16, 3), state: long(8, 3), stats: [] });
    expect((small.timeline as string[]).length).toBe(16);
    expect(small.in_flight).toBe("none");
    expect(small.stats).toBe("none");
  });
});

describe("determinism", () => {
  it("the same scripted inputs on a fake clock give identical situations", async () => {
    const run = async () => {
      const s = setup();
      await typeahead(s);
      s.server.on("POST", "/api/orders", { status: 201, body: { ok: true }, latency: 300 });
      for (let i = 0; i < 2; i++) {
        s.rt.user({ kind: "click", target: 'button "Order"' }, () => void s.fetch("/api/orders", { method: "POST", body: "{}" }));
        await s.clock.advance(50);
      }
      await s.clock.advance(2000);
      return JSON.stringify(s.decider.calls.map((c) => ({ t: c.trigger, s: c.state, q: c.questions })));
    };
    const a = await run();
    const b = await run();
    expect(a.length).toBeGreaterThan(100);
    expect(a).toBe(b);
  });
});
