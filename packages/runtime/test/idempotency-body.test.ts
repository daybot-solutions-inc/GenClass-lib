// policy.idempotencyBodyFields (opt-in, heal/overnight): a POST whose JSON body carries an idempotency key the server
// deduplicates on (e.g. request_id) may be repeated, so `retry` is offered for it. Default none: nothing changes.
import { describe, expect, it } from "vitest";
import type { EvaluateRequest } from "../src/types.js";
import { jsonObjectKeys } from "../src/observe/fetch.js";
import { defaultScript, setup } from "./helpers.js";

const actionsOf = (r: EvaluateRequest | undefined) => Object.keys(((r?.questions.action ?? { criteria: {} }) as { criteria: Record<string, unknown> }).criteria);

async function failOnce(body: string, policy?: { idempotencyBodyFields?: string[] }) {
  const s = setup({ mode: "heal", triage: "always", script: defaultScript({ failure: { diagnosis: "transient", action: "retry" } }), ...(policy ? { policy } : {}) });
  s.server.on("POST", "/api/orders", ({ n }) => (n === 1 ? { status: 502, body: {}, latency: 20 } : { status: 201, body: { id: 1 }, latency: 20 }));
  let status = 0;
  void s.fetch("/api/orders", { method: "POST", body, headers: { "content-type": "application/json" } }).then((r) => (status = r.status), () => (status = -1));
  await s.clock.advance(2000);
  const f = s.decider.calls.find((c) => c.trigger === "failure");
  return { f, status, hits: s.server.hits.get("POST /api/orders") ?? 0, notOffered: s.rt.situation("failure").notOffered ?? {} };
}

describe("policy.idempotencyBodyFields (opt-in retry of keyed POSTs)", () => {
  it("default: a request_id in the body is not an idempotency key (no retry offered)", async () => {
    const r = await failOnce('{"request_id":"r1","items":[1]}');
    expect(actionsOf(r.f)).not.toContain("retry");
    expect(r.notOffered.retry).toMatch(/^POST is not idempotent/);
    expect(r.hits).toBe(1);
    expect(r.status).toBe(502);
  });

  it("configured: the body field makes the POST repeatable; the retry gets the second answer", async () => {
    const r = await failOnce('{"request_id":"r1","items":[1]}', { idempotencyBodyFields: ["Request_ID"] });
    expect(actionsOf(r.f)).toContain("retry");
    expect(r.notOffered.retry).toBeUndefined();
    expect(r.hits).toBe(2);
    expect(r.status).toBe(201);
  });

  it("configured, but the body lacks the field (or is not a JSON object): unchanged", async () => {
    for (const body of ['{"items":[1]}', '[{"request_id":"r1"}]', "request_id=r1"]) {
      const r = await failOnce(body, { idempotencyBodyFields: ["request_id"] });
      expect(actionsOf(r.f)).not.toContain("retry");
      expect(r.hits).toBe(1);
    }
  });

  it("the model's state text is identical with and without the option (only the offered actions differ)", async () => {
    const a = await failOnce('{"request_id":"r1","items":[1]}');
    const b = await failOnce('{"request_id":"r1","items":[1]}', { idempotencyBodyFields: ["request_id"] });
    expect(JSON.stringify(b.f!.state)).toBe(JSON.stringify(a.f!.state));
  });

  it("jsonObjectKeys: top-level keys of small JSON objects only", () => {
    expect(jsonObjectKeys(' {"A":1,"b":{"c":2}} ')).toEqual(["a", "b"]);
    expect(jsonObjectKeys("[1]")).toBeUndefined();
    expect(jsonObjectKeys("{oops")).toBeUndefined();
    expect(jsonObjectKeys("x".repeat(10))).toBeUndefined();
  });
});
