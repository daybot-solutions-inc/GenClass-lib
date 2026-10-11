import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { handle, MAX_BODY_BYTES, MAX_EVENTS, validate } from "../src/index.js";

function bucket() {
  const puts: { key: string; body: Uint8Array }[] = [];
  return {
    puts,
    BUCKET: {
      async put(key: string, value: ArrayBuffer | Uint8Array) {
        puts.push({ key, body: value instanceof Uint8Array ? value : new Uint8Array(value) });
      },
    },
  };
}

const batch = (over: Record<string, unknown> = {}) => ({
  schema: "genclass-telemetry/1",
  sid: "abcdEFGH12345678",
  sent: 1000,
  runtime: "0.1.0-beta.3",
  model: "0.1.0",
  events: [{ t: "session", seq: 0 }, { t: "decision", seq: 1, situation: "x" }],
  ...over,
});

function post(body: string, headers: Record<string, string> = { "content-type": "text/plain;charset=UTF-8" }) {
  const r = new Request("https://c.example/v1/events", { method: "POST", body, headers });
  Object.defineProperty(r, "cf", { value: { country: "CA", city: "Toronto", asn: 1 } });
  return r;
}

const opts = { now: () => new Date("2026-10-08T12:00:00Z"), uuid: () => "u-1" };

describe("collector", () => {
  it("rate limit: a client over its budget gets 429 and nothing is stored; a failing limiter lets the batch through", async () => {
    const keys: string[] = [];
    const limited = { ...bucket(), LIMIT: { async limit({ key }: { key: string }) { keys.push(key); return { success: false }; } } };
    const req = post(JSON.stringify(batch()));
    req.headers.set("cf-connecting-ip", "203.0.113.9");
    const res = await handle(req, limited, opts);
    expect(res.status).toBe(429);
    expect(limited.puts).toHaveLength(0);
    expect(keys).toEqual(["203.0.113.9"]);
    const broken = { ...bucket(), LIMIT: { async limit() { throw new Error("limiter down"); } } };
    expect((await handle(post(JSON.stringify(batch())), broken, opts)).status).toBe(202);
    expect(broken.puts).toHaveLength(1);
  });

  it("health", async () => {
    const res = await handle(new Request("https://c.example/v1/health"), bucket(), opts);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("stores a valid batch as gzip JSONL with receivedAt and country only, dropping unknown fields", async () => {
    const env = bucket();
    const req = post(JSON.stringify(batch({ extra: "drop me" })), {
      "content-type": "text/plain",
      "user-agent": "UA-SECRET",
      cookie: "c=SECRET",
      "x-forwarded-for": "1.2.3.4",
    });
    const res = await handle(req, env, opts);
    expect(res.status).toBe(202);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(env.puts).toHaveLength(1);
    expect(env.puts[0]!.key).toBe("events/dt=2026-10-08/rt=0.1.0-beta.3/model=0.1.0/u-1.jsonl.gz");
    const text = gunzipSync(env.puts[0]!.body).toString("utf8");
    expect(text).not.toMatch(/SECRET|1\.2\.3\.4|drop me|Toronto/);
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      sid: "abcdEFGH12345678", runtime: "0.1.0-beta.3", model: "0.1.0", sent: 1000,
      receivedAt: "2026-10-08T12:00:00.000Z", country: "CA", event: { t: "session", seq: 0 },
    });
  });

  it("accepts application/json and sanitises path labels", async () => {
    const env = bucket();
    const res = await handle(post(JSON.stringify(batch({ runtime: "../evil", model: null })), { "content-type": "application/json" }), env, opts);
    expect(res.status).toBe(202);
    expect(env.puts[0]!.key).toBe("events/dt=2026-10-08/rt=unknown/model=none/u-1.jsonl.gz");
  });

  it("rejects oversized, malformed and wrong content types", async () => {
    const env = bucket();
    const big = JSON.stringify(batch({ events: [{ t: "x", pad: "a".repeat(MAX_BODY_BYTES) }] }));
    expect((await handle(post(big), env, opts)).status).toBe(413);
    expect((await handle(post("{not json"), env, opts)).status).toBe(400);
    expect((await handle(post(JSON.stringify(batch({ schema: "v0" }))), env, opts)).status).toBe(400);
    expect((await handle(post(JSON.stringify(batch({ events: [] }))), env, opts)).status).toBe(400);
    expect((await handle(post(JSON.stringify(batch({ events: [{ nope: 1 }] }))), env, opts)).status).toBe(400);
    expect((await handle(post("{}", { "content-type": "application/x-www-form-urlencoded" }), env, opts)).status).toBe(415);
    expect(env.puts).toHaveLength(0);
  });

  it("caps events per batch", () => {
    const events = Array.from({ length: MAX_EVENTS + 1 }, () => ({ t: "x" }));
    expect(validate(batch({ events }))).toMatch(/at most/);
    expect(typeof validate(batch({ events: events.slice(1) }))).toBe("object");
  });

  it("answers CORS preflight", async () => {
    const res = await handle(new Request("https://c.example/v1/events", { method: "OPTIONS" }), bucket(), opts);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
