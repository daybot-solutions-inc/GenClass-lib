// Batch 7: `retry` (and `hedge`) are offered by HTTP semantics. Idempotent methods (GET, HEAD, OPTIONS, PUT, DELETE)
// may be repeated; any other method (POST, PATCH, ...) only when the request carries an idempotency key header
// (policy.idempotencyHeaders, default Idempotency-Key / X-Idempotency-Key; request ids are not keys). Every built-in
// action that is not offered is listed with its reason in `situation.notOffered`.
import { describe, expect, it } from "vitest";
import type { EvaluateRequest } from "../src/types.js";
import { defaultScript, setup } from "./helpers.js";

const actionsOf = (r: EvaluateRequest | undefined) => Object.keys(((r?.questions.action ?? { criteria: {} }) as { criteria: Record<string, unknown> }).criteria);
const NO_KEY = /^POST is not idempotent and the request has no idempotency key header \(idempotency-key, x-idempotency-key\)$/;

async function failOnce(method: string, headers?: Record<string, string>, policy?: { idempotencyHeaders?: string[] }, asRequest = false) {
  const s = setup({ mode: "heal", triage: "always", script: defaultScript({ failure: { diagnosis: "transient", action: "retry" } }), ...(policy ? { policy } : {}) });
  s.server.on(method, "/api/orders", ({ n }) => (n === 1 ? { status: 500, body: {}, latency: 20 } : { status: 201, body: { id: 1 }, latency: 20 }));
  const init: RequestInit = { method, body: method === "GET" || method === "HEAD" ? undefined : '{"sku":"A1"}', ...(headers ? { headers } : {}) };
  const p = asRequest ? s.fetch(new Request("http://app.test/api/orders", init) as unknown as string) : s.fetch("/api/orders", init);
  let status = 0;
  void p.then((r) => (status = r.status), () => (status = -1));
  await s.clock.advance(2000);
  const f = s.decider.calls.find((c) => c.trigger === "failure");
  return { s, f, status, hits: s.server.hits.get(`${method} /api/orders`) ?? 0, notOffered: s.rt.situation("failure").notOffered ?? {} };
}

describe("retry by HTTP semantics", () => {
  it("a POST without an idempotency key is never retried (the 500 may have been applied)", async () => {
    const r = await failOnce("POST");
    expect(actionsOf(r.f)).not.toContain("retry");
    expect(r.notOffered.retry).toMatch(NO_KEY);
    expect(r.hits).toBe(1);
    expect(r.status).toBe(500);
  });

  it("EvaluateRequest.notOffered carries the same reasons to the provider (never in the model's state)", async () => {
    const r = await failOnce("POST");
    expect(r.f!.notOffered).toEqual(r.notOffered);
    expect(r.f!.notOffered!.retry).toMatch(NO_KEY);
    expect(r.f!.notOffered!.serve_cached).toBe("POST responses are never served from cache");
    expect(JSON.stringify(r.f!.state)).not.toContain("idempotency key");
    const ok = await failOnce("PUT");
    expect(ok.f!.notOffered?.retry).toBeUndefined();
  });

  it("a request id or tracing header is not an idempotency key", async () => {
    const r = await failOnce("POST", { "X-Request-Id": "abc", traceparent: "00-1-2-01" });
    expect(actionsOf(r.f)).not.toContain("retry");
    expect(r.notOffered.retry).toMatch(NO_KEY);
  });

  it("a POST with Idempotency-Key (headers object or a Request) may be retried", async () => {
    for (const asRequest of [false, true]) {
      const r = await failOnce("POST", { "Idempotency-Key": "order-7f3" }, undefined, asRequest);
      expect(actionsOf(r.f)).toContain("retry");
      expect(r.notOffered.retry).toBeUndefined();
      expect(r.hits).toBe(2);
      expect(r.status).toBe(201);
    }
    const x = await failOnce("PATCH", { "x-idempotency-key": "k1" });
    expect(actionsOf(x.f)).toContain("retry");
  });

  it("idempotent methods may be retried without a key", async () => {
    for (const m of ["PUT", "DELETE", "GET"]) {
      const r = await failOnce(m);
      expect(actionsOf(r.f)).toContain("retry");
    }
  });

  it("policy.idempotencyHeaders replaces the header list (case-insensitive)", async () => {
    const policy = { idempotencyHeaders: ["X-Dedupe-Token"] };
    const custom = await failOnce("POST", { "x-dedupe-token": "t" }, policy);
    expect(actionsOf(custom.f)).toContain("retry");
    const std = await failOnce("POST", { "Idempotency-Key": "k" }, policy);
    expect(actionsOf(std.f)).not.toContain("retry");
    expect(std.notOffered.retry).toMatch(/\(x-dedupe-token\)$/);
  });

  it("hedge stays GET-only; the reason is listed", async () => {
    const s = setup({ mode: "heal", triage: "always" });
    s.server.on("POST", "/api/report", ({ n }) => ({ status: 200, body: {}, latency: n === 6 ? 20_000 : 50 }));
    for (let i = 0; i < 6; i++) {
      void s.fetch("/api/report", { method: "POST", body: "{}", headers: { "Idempotency-Key": `k${i}` } }).catch(() => undefined);
      await s.clock.advance(300);
    }
    await s.clock.advance(2000);
    expect(s.rt.situation("stall").notOffered?.hedge).toBe("only GET requests are hedged (POST)");
    await s.clock.advance(20_000);
  });
});
