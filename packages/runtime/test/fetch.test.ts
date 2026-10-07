import { describe, expect, it } from "vitest";
import { MAX_BODY, MAX_ENTRIES } from "../src/observe/cache.js";
import { ManualDecider, defaultScript, setup } from "./helpers.js";

describe("fetch observer", () => {
  it("plain traffic makes no model call (triage neutrality)", async () => {
    const { rt, clock, server, fetch, decider } = setup();
    server.on("GET", "/api/a", { body: 1, latency: 40 });
    server.on("GET", "/api/b", { body: 2, latency: 40 });
    const s = rt.atom("s", { a: 0, b: 0 });
    for (let i = 0; i < 3; i++) {
      rt.user({ kind: "click", target: `button "${i}"` }, () => {
        void (async () => {
          const a = (await (await fetch("/api/a")).json()) as number;
          s.set((v) => ({ ...v, a }));
          const b = (await (await fetch("/api/b")).json()) as number;
          s.set((v) => ({ ...v, b }));
        })();
      });
      await clock.advance(5000);
    }
    expect(s.get()).toEqual({ a: 1, b: 2 });
    expect(decider.calls.length).toBe(0);
    expect(rt.decisions().length).toBe(0);
  });

  it("app reads its own response body; GenClass reads a clone", async () => {
    const { clock, server, fetch } = setup();
    server.on("GET", "/api/x", { body: { hello: "world" }, latency: 10 });
    const p = fetch("/api/x");
    await clock.advance(20);
    const res = await p;
    const c = res.clone();
    expect(await res.json()).toEqual({ hello: "world" });
    expect(await c.text()).toBe('{"hello":"world"}');
    expect(res.headers.get("x-genclass")).toBeNull();
  });

  it("coalesce: a duplicate POST in flight reuses the first response", async () => {
    const { rt, clock, server, fetch, decider } = setup({ script: defaultScript({ request: { diagnosis: "duplicate", action: "coalesce" } }) });
    server.on("POST", "/api/orders", ({ n }) => ({ status: 201, body: { order: n }, latency: 200 }));
    const out: unknown[] = [];
    const submit = () =>
      rt.user({ kind: "click", target: 'button "Place order"' }, () => {
        void fetch("/api/orders", { method: "POST", body: JSON.stringify({ sku: "A1", qty: 1 }) }).then(async (r) => {
          out.push({ status: r.status, mark: r.headers.get("x-genclass"), body: await r.json() });
        });
      });
    submit();
    await clock.advance(90);
    submit();
    await clock.advance(1000);
    expect(server.hits.get("POST /api/orders")).toBe(1);
    expect(out).toEqual([
      { status: 201, mark: null, body: { order: 1 } },
      { status: 201, mark: "coalesced", body: { order: 1 } },
    ]);
    const req = decider.calls.find((c) => c.trigger === "request")!;
    expect(Object.keys((req.questions.action as { criteria: object }).criteria)).toContain("coalesce");
    const a = rt.interventions()[0];
    expect(a.action).toBe("coalesce");
    expect(a.tier).toBe("guard");
    expect(a.changed).toMatch(/reused the 201 response of the identical request #\d+/);
  });

  it("block answers 503 with x-genclass: blocked (heal mode)", async () => {
    const { clock, server, fetch } = setup({ mode: "heal", triage: "always", script: defaultScript({ request: { diagnosis: "overload", action: "block" } }) });
    server.on("GET", "/api/poll", { body: 1, latency: 10 });
    const p = fetch("/api/poll");
    await clock.advance(50);
    const r = await p;
    expect(r.status).toBe(503);
    expect(r.headers.get("x-genclass")).toBe("blocked");
    expect(server.hits.get("GET /api/poll") ?? 0).toBe(0);
  });

  it("guard mode never runs heal-tier actions", async () => {
    const { rt, clock, server, fetch } = setup({ mode: "guard", triage: "always", script: defaultScript({ request: { diagnosis: "overload", action: "block" } }) });
    server.on("GET", "/api/poll", { body: 1, latency: 10 });
    const p = fetch("/api/poll");
    await clock.advance(50);
    expect((await p).status).toBe(200);
    const d = rt.decisions()[0];
    expect(d.action).toBe("block");
    expect(d.executed).toBe(false);
    expect(d.reason).toMatch(/guard mode does not allow heal-tier actions/);
  });

  it("serve_cached answers from the last good GET response", async () => {
    const { clock, server, fetch, decider } = setup({ mode: "heal", triage: "always" });
    server.on("GET", "/api/cfg", ({ n }) => ({ body: { v: n }, latency: 20 }));
    const first = fetch("/api/cfg");
    await clock.advance(100);
    expect(await (await first).json()).toEqual({ v: 1 });
    decider.script = defaultScript({ request: { diagnosis: "failing", action: "serve_cached" } });
    const second = fetch("/api/cfg");
    await clock.advance(100);
    const r = await second;
    expect(r.headers.get("x-genclass")).toBe("cached");
    expect(await r.json()).toEqual({ v: 1 });
    expect(server.hits.get("GET /api/cfg")).toBe(1);
  });

  it("delay waits min(250 ms · 2^streak, 8 s) before sending", async () => {
    const { clock, server, fetch } = setup({ triage: "always", script: defaultScript({ request: { diagnosis: "overload", action: "delay" } }) });
    server.on("GET", "/api/x", { body: 1, latency: 10 });
    const t0 = clock.now();
    const p = fetch("/api/x");
    await clock.advance(1000);
    await p;
    expect(server.log[0].t - t0).toBe(250);
  });

  it("failure: retry re-issues the request with backoff; the app sees the retry's result", async () => {
    const { rt, clock, server, fetch } = setup({ mode: "heal", script: defaultScript({ failure: { diagnosis: "failing", action: "retry" } }) });
    server.on("GET", "/api/flaky", ({ n }) => (n === 1 ? { status: 503, body: { err: 1 }, latency: 30 } : { status: 200, body: { ok: true }, latency: 30 }));
    const p = fetch("/api/flaky");
    await clock.advance(1000);
    const r = await p;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(server.hits.get("GET /api/flaky")).toBe(2);
    // backoff 200 ms after the first failure (attempt 1)
    expect(server.log[1].t - server.log[0].t).toBe(30 + 200);
    const ops = [...rt.ops.byId.values()].filter((o) => o.name === "GET /api/flaky");
    expect(ops.map((o) => o.attempt)).toEqual([1, 2]);
    expect(rt.interventions()[0].action).toBe("retry");
  });

  it("failure: retry is not offered when the body cannot be replayed", async () => {
    const { clock, server, fetch, decider } = setup({ mode: "heal" });
    server.on("POST", "/api/up", { status: 500, latency: 10 });
    const stream = new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array([1, 2])), c.close()) });
    const p = fetch("/api/up", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await clock.advance(100);
    expect((await p).status).toBe(500);
    const f = decider.calls.find((c) => c.trigger === "failure")!;
    const q = f.questions.action as { criteria: Record<string, string> } | undefined;
    expect(q ? Object.keys(q.criteria) : []).not.toContain("retry");
  });

  it("failure: a network error is held then delivered as the original rejection", async () => {
    const { clock, server, fetch, decider } = setup();
    server.on("GET", "/api/down", { error: "network", latency: 10 });
    const p = fetch("/api/down");
    let err: unknown;
    p.catch((e) => (err = e));
    await clock.advance(100);
    expect(err).toBeInstanceOf(TypeError);
    expect(decider.calls.some((c) => c.trigger === "failure")).toBe(true);
  });

  it("failure gate fails open after the hold budget (heal mode: retry is permitted, so the failure is held)", async () => {
    const manual = new ManualDecider();
    const { clock, server, fetch } = setup({ decider: manual, mode: "heal" });
    server.on("GET", "/api/e", { status: 500, latency: 10 });
    let status = 0;
    void fetch("/api/e").then((r) => (status = r.status));
    await clock.advance(10 + 299);
    expect(status).toBe(0);
    await clock.advance(2);
    expect(status).toBe(500);
  });

  it("request gate fails open after the hold budget", async () => {
    const manual = new ManualDecider();
    const { clock, server, fetch } = setup({ decider: manual, triage: "always" });
    server.on("GET", "/api/x", { body: 1, latency: 10 });
    const t0 = clock.now();
    const p = fetch("/api/x");
    await clock.advance(500);
    await p;
    expect(server.log[0].t - t0).toBe(300);
  });

  it("stall: hedge sends a second identical request and the first answer wins", async () => {
    const { rt, clock, server, fetch } = setup({ mode: "heal", script: defaultScript({ stall: { diagnosis: "slow", action: "hedge" } }) });
    server.on("GET", "/api/report", ({ n }) => ({ body: { n }, latency: n === 6 ? 20_000 : 50 }));
    for (let i = 0; i < 5; i++) {
      const p = fetch("/api/report");
      await clock.advance(100);
      await p;
    }
    const t0 = clock.now();
    let got: unknown;
    void fetch("/api/report").then(async (r) => (got = await r.json()));
    await clock.advance(1000);
    expect(got).toEqual({ n: 7 });
    expect(clock.now() - t0).toBeLessThan(20_000);
    const st = rt.decisions().find((d) => d.trigger === "stall")!;
    expect(st.action).toBe("hedge");
    expect(rt.interventions().some((a) => a.action === "hedge")).toBe(true);
  });

  it("aborting before send rejects with the signal's reason and records aborted", async () => {
    const { rt, clock, server, fetch } = setup();
    server.on("GET", "/api/x", { body: 1, latency: 100 });
    const ac = new AbortController();
    const p = fetch("/api/x", { signal: ac.signal });
    let err: unknown;
    p.catch((e) => (err = e));
    await clock.advance(10);
    ac.abort();
    await clock.advance(200);
    expect((err as Error).name).toBe("AbortError");
    const op = [...rt.ops.byId.values()].find((o) => o.kind === "fetch")!;
    expect(op.status).toBe("aborted");
  });

  it("TimeoutError aborts are failures (timeout)", async () => {
    const { rt, clock, server, fetch, decider } = setup();
    server.on("GET", "/api/slow", { body: 1, latency: 5000 });
    const ac = new AbortController();
    const p = fetch("/api/slow", { signal: ac.signal });
    p.catch(() => undefined);
    await clock.advance(100);
    ac.abort(new DOMException("timed out", "TimeoutError"));
    await clock.advance(400);
    const op = [...rt.ops.byId.values()].find((o) => o.kind === "fetch")!;
    expect(op.code).toBe("timeout");
    expect(decider.calls.some((c) => c.trigger === "failure")).toBe(true);
  });

  it("the response cache keeps ≤ 64 entries and skips bodies over 256 KB", async () => {
    const { rt, clock, server, fetch } = setup();
    server.on("GET", "/api/big", { body: "x".repeat(MAX_BODY + 10), latency: 5 });
    server.on("GET", "/api/item", ({ url }) => ({ body: { id: url.searchParams.get("id") }, latency: 5 }));
    const big = fetch("/api/big");
    await clock.advance(50);
    await (await big).text();
    for (let i = 0; i < MAX_ENTRIES + 6; i++) {
      const p = fetch(`/api/item?id=${i}`);
      await clock.advance(20);
      await (await p).json();
    }
    const ids = [...rt.ops.byId.values()].filter((o) => o.kind === "fetch").map((o) => o.identity!);
    const cached = ids.filter((id) => rt.cache.peek(id));
    expect(cached.length).toBe(MAX_ENTRIES);
    expect(rt.cache.peek(ids[0])).toBeUndefined();
  });

  it("destroy() restores the original fetch", () => {
    const { rt, g, server } = setup();
    expect(g.fetch).not.toBe(server.fetch);
    rt.destroy();
    expect(g.fetch).toBe(server.fetch);
  });
});
