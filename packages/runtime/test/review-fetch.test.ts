// REVIEW: fetch observer findings. Each test describes required behaviour; a failing test demonstrates a bug.
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { FakeClock, ManualDecider, ScriptedDecider, defaultScript, setup } from "./helpers.js";

const ONLY_FETCH = { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false };

function headless(fetchImpl: (input: unknown, init?: Record<string, unknown>) => Promise<Response>, script = defaultScript()) {
  const clock = new FakeClock();
  const g: Record<string, unknown> = { fetch: fetchImpl, Response, location: { href: "http://app.test/", pathname: "/", search: "" } };
  const decider = new ScriptedDecider(script);
  const rt = createRuntime({ clock, global: g, decider, mode: "guard", report: "silent", observe: ONLY_FETCH }) as RuntimeImpl;
  return { clock, g, decider, rt, fetch: (u: unknown, i?: RequestInit) => (g.fetch as (u: unknown, i?: RequestInit) => Promise<Response>)(u, i) };
}

describe("review: request identity", () => {
  it("two different POST bodies sent as Request objects are not 'identical' (no coalesce of distinct orders)", async () => {
    const { rt, clock, server, fetch, decider } = setup({ script: defaultScript({ request: { diagnosis: "duplicate", action: "coalesce" } }) });
    server.on("POST", "/api/orders", ({ n }) => ({ status: 201, body: { order: n }, latency: 200 }));
    const got: unknown[] = [];
    const order = (sku: string) =>
      rt.user({ kind: "click", target: `button "Buy ${sku}"` }, () => {
        // e.g. ky and other wrappers always pass a Request object
        const req = new Request("http://app.test/api/orders", { method: "POST", body: JSON.stringify({ sku }), headers: { "content-type": "application/json" } });
        void fetch(req as unknown as string).then(async (r) => got.push({ sku, body: await r.json(), mark: r.headers.get("x-genclass") }));
      });
    order("A");
    await clock.advance(50);
    order("B");
    await clock.advance(1000);
    const facts = decider.calls.filter((c) => c.trigger === "request").flatMap((c) => c.state.facts as string[]);
    expect({ identicalFact: facts.some((f) => /identical POST \/api\/orders/.test(f)), hits: server.hits.get("POST /api/orders"), got }).toEqual({
      identicalFact: false,
      hits: 2,
      got: [
        { sku: "A", body: { order: 1 }, mark: null },
        { sku: "B", body: { order: 2 }, mark: null },
      ],
    });
  });

  it("contract gap: concurrent Range requests for different byte ranges of one URL are not 'identical'", async () => {
    const { clock, server, fetch, decider } = setup({ script: defaultScript({ request: { diagnosis: "duplicate", action: "coalesce" } }) });
    // the fake server ignores headers; the n-th hit stands for the n-th requested range
    server.on("GET", "/files/doc.pdf", ({ n }) => ({ status: 206, body: `chunk-${n - 1}`, latency: 200 }));
    const chunks: unknown[] = [];
    void fetch("/files/doc.pdf", { headers: { range: "bytes=0-65535" } }).then(async (r) => chunks.push(await r.json()));
    await clock.advance(20);
    void fetch("/files/doc.pdf", { headers: { range: "bytes=65536-131071" } }).then(async (r) => chunks.push(await r.json()));
    await clock.advance(1000);
    expect(decider.calls.filter((c) => c.trigger === "request")).toHaveLength(0);
    expect(server.hits.get("GET /files/doc.pdf")).toBe(2);
    expect(chunks).toEqual(["chunk-0", "chunk-1"]);
  });
});

describe("review: coalesce never hangs the app's fetch", () => {
  it("coalescing with an opaque (status 0) response still settles the second fetch", async () => {
    let clockRef: FakeClock | null = null;
    const h = headless(
      () => new Promise<Response>((res) => clockRef!.setTimeout(() => res(Response.error()), 100)), // opaque/no-cors-like: status 0
      defaultScript({ request: { diagnosis: "duplicate", action: "coalesce" } }),
    );
    clockRef = h.clock;
    void h.fetch("http://cdn.test/pixel.gif", { mode: "no-cors" }).catch(() => undefined);
    await h.clock.advance(10);
    let settled = false;
    h.fetch("http://cdn.test/pixel.gif", { mode: "no-cors" }).then(
      () => (settled = true),
      () => (settled = true),
    );
    await h.clock.advance(10_000);
    const a = h.rt.interventions().find((x) => x.action === "coalesce");
    expect({ coalesced: !!a, error: a?.error, settled }).toEqual({ coalesced: true, error: undefined, settled: true });
  });

  it("coalescing with a still-streaming identical response does not wait for the whole stream", async () => {
    const enc = new TextEncoder();
    const h = headless(
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(enc.encode('{"event":"hello"}\n')); // an NDJSON feed that stays open
              },
            }),
            { headers: { "content-type": "application/x-ndjson" } },
          ),
        ),
      defaultScript({ request: { diagnosis: "duplicate", action: "coalesce" } }),
    );
    const first = await h.fetch("http://app.test/api/feed");
    expect(first.status).toBe(200);
    await h.clock.advance(100);
    let settled = false;
    h.fetch("http://app.test/api/feed").then(
      () => (settled = true),
      () => (settled = true),
    );
    await h.clock.advance(10_000);
    expect(h.rt.decisions().map((d) => d.ran)).toContain("coalesce");
    expect(settled).toBe(true);
  });
});

describe("review: memory bounds", () => {
  it("buffered response bodies stay within the contract's cache bound (64 x 256 KB)", async () => {
    const { rt, clock, server, fetch } = setup();
    const big = "x".repeat(200 * 1024);
    const N = 20;
    for (let i = 0; i < N; i++) server.on("GET", `/api/r${i}`, { body: big, latency: 10 });
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < N; i++) {
        const p = fetch(`/api/r${i}?x=1`);
        await clock.advance(20);
        await (await p).text();
      }
      await clock.advance(5000);
    }
    const recent = (rt.cache as unknown as { recent: Map<string, { body: Promise<{ body: ArrayBuffer } | null> }[]> }).recent;
    let bytes = 0;
    for (const list of recent.values()) for (const e of list) bytes += (await e.body)?.body.byteLength ?? 0;
    const good = (rt.cache as unknown as { good: Map<string, { body: ArrayBuffer }> }).good;
    for (const b of good.values()) bytes += b.body.byteLength;
    console.log(`[review] response buffers retained: ${(bytes / 1048576).toFixed(1)} MB (contract bound 16 MB)`);
    expect(bytes).toBeLessThanOrEqual(64 * 256 * 1024);
  });

  it("does not leave an abort listener on a long-lived AbortSignal for every finished request", async () => {
    let clockRef: FakeClock | null = null;
    const h = headless(() => new Promise<Response>((res) => clockRef!.setTimeout(() => res(new Response("ok")), 10)));
    clockRef = h.clock;
    const ctrl = new AbortController(); // e.g. one controller per page/component
    for (let i = 0; i < 50; i++) {
      const p = h.fetch(`http://app.test/api/item?i=${i}`, { signal: ctrl.signal });
      await h.clock.advance(20);
      await (await p).text();
    }
    expect(getEventListeners(ctrl.signal, "abort").length).toBe(0);
  });
});

describe("review: destroy()", () => {
  it("after destroy, GenClass does no work even if another library wrapped fetch on top of it", async () => {
    const { rt, clock, server, g } = setup();
    server.on("GET", "/api/x", { body: { a: 1 }, latency: 10 });
    const gcFetch = g.fetch as typeof fetch;
    g.fetch = (input: RequestInfo | URL, init?: RequestInit) => gcFetch(input, init); // e.g. an APM wrapper installed later
    rt.destroy();
    const ops0 = rt.internals.ops.byId.size;
    const p = (g.fetch as typeof fetch)("/api/x");
    await clock.advance(50);
    await (await p).json();
    expect(rt.internals.ops.byId.size).toBe(ops0);
    expect((rt.cache as unknown as { recent: Map<string, unknown> }).recent.size).toBe(0);
  });
});

describe("review: holds in guard mode (default)", () => {
  it("a failed response is not held for the model when the mode allows no failure action", async () => {
    // failure actions: deliver (passive), retry (heal), serve_cached (heal): guard mode can only deliver
    const manual = new ManualDecider();
    const { clock, server, fetch } = setup({ decider: manual, mode: "guard" });
    server.on("GET", "/api/x", { status: 503, body: 0, latency: 50 });
    let at = -1;
    const t0 = clock.now();
    void fetch("/api/x").then(() => (at = clock.now() - t0));
    await clock.advance(1000);
    // the app should see the 503 when it arrives (+50 ms), not after the hold budget
    expect(at).toBe(50);
  });
});

describe("review: keepalive", () => {
  it("a keepalive request (page-unload save) reaches the network inside the fetch() call, even when salient", async () => {
    const { clock, server, fetch } = setup();
    server.on("POST", "/api/draft", { status: 204, latency: 10 });
    void fetch("/api/draft", { method: "POST", body: '{"text":"hello"}', keepalive: true }); // autosave
    await clock.advance(100);
    // pagehide handler: the same save again, keepalive so it survives the unload
    void fetch("/api/draft", { method: "POST", body: '{"text":"hello"}', keepalive: true });
    const sentSync = server.hits.get("POST /api/draft");
    expect(sentSync).toBe(2); // the page may be gone after this task: the request must already be on the wire
    await clock.advance(1000);
  });
});

describe("review: request facts", () => {
  it("for a failure, a newer identical request is described as started after it", async () => {
    const { clock, server, fetch, decider } = setup();
    server.on("GET", "/api/data", ({ n }) => (n === 1 ? { status: 503, body: 0, latency: 500 } : { status: 200, body: 1, latency: 2000 }));
    void fetch("/api/data"); // A: fails at +500
    await clock.advance(100);
    void fetch("/api/data"); // B: started 0.10 s AFTER A, still in flight when A fails
    await clock.advance(3000);
    const call = decider.calls.find((c) => c.trigger === "failure")!;
    expect(call).toBeDefined();
    const fact = (call.state.facts as string[]).find((f) => /identical GET \/api\/data/.test(f))!;
    expect(fact).toBeDefined();
    expect(fact).not.toMatch(/started 0\.10s before this one/);
    expect(fact).toMatch(/started 0\.10s after this one/);
  });

  it("'error rate X% over N requests' matches the outcomes it lists", async () => {
    const { clock, server, fetch, decider } = setup();
    server.on("GET", "/api/status", ({ n }) => (n <= 2 ? { status: 200, body: 1, latency: 10 } : { status: 503, body: 0, latency: 10 }));
    for (let i = 0; i < 5; i++) {
      const p = fetch("/api/status");
      await clock.advance(2000);
      await p;
    }
    const last = decider.calls.filter((c) => c.trigger === "failure").at(-1)!;
    const fact = (last.state.facts as string[]).find((f) => /error rate/.test(f))!;
    // outcomes 200, 200, 503, 503, 503: 3 of 5 failed
    expect(fact).toMatch(/recent outcomes: 200, 200, 503, 503, 503/);
    expect(fact).toMatch(/error rate 60% over 5 requests/);
  });
});
