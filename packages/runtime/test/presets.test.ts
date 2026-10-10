// requests.protect presets (src/presets.ts; OPTIONS-SPEC §4.4): opt-in URL matchers for money and identity flows.
// They only narrow (protected subjects are observed, never acted on); "preset:<name>" strings work in JSON configs.
import { describe, expect, it, vi } from "vitest";
import { PROTECT_PRESETS, protectPreset } from "../src/index.js";
import { expandPresets } from "../src/presets.js";
import { compileMatchers } from "../src/util/match.js";
import { setup } from "./helpers.js";
import { Adversary, insist, ran } from "./invariants/adversary.js";

const matches = (list: (string | RegExp)[], url: string, method = "POST") => !!compileMatchers(list, "match").match({ url, method, channel: "fetch" });

describe("protect presets (OPTIONS-SPEC §4.4)", () => {
  const pay = protectPreset("payments");
  const auth = protectPreset("auth");

  it.each([
    "http://app.test/api/checkout",
    "http://app.test/api/checkout/session?id=1",
    "http://app.test/create-payment-intent",
    "http://app.test/v1/payment_intents",
    "https://api.stripe.com/v1/charges",
    "http://app.test/api/orders/12/refund",
    "http://app.test/billing/invoices.json",
    "http://app.test/api/subscriptions",
    "http://app.test/wallet",
    "https://pay.example.com/session",
  ])("payments matches %s", (url) => expect(matches(pay, url)).toBe(true));

  it.each(["http://app.test/api/search?q=pay", "http://app.test/api/products", "http://app.test/api/paypalish-theme", "http://app.test/api/display", "http://app.test/api/recorder"])(
    "payments does not match %s",
    (url) => expect(matches(pay, url)).toBe(false),
  );

  it.each(["http://app.test/api/login", "http://app.test/oauth/token", "http://app.test/auth/callback", "http://app.test/api/sign-up", "http://app.test/users/password/reset", "http://app.test/mfa/verify"])(
    "auth matches %s",
    (url) => expect(matches(auth, url)).toBe(true),
  );

  it.each(["http://app.test/api/authors", "http://app.test/api/tokenizer-demo", "http://app.test/api/feed"])("auth does not match %s", (url) => expect(matches(auth, url)).toBe(false));

  it("protectPreset() returns fresh copies (every preset without names)", () => {
    const all = protectPreset();
    expect(all).toHaveLength(Object.values(PROTECT_PRESETS).flat().length);
    expect(all[0]).not.toBe(PROTECT_PRESETS.payments[0]);
  });

  it('"preset:<name>" strings expand; an unknown name is dropped with a warning', () => {
    const warn = vi.fn();
    const out = expandPresets(["/api/cart", "preset:payments", "preset:nope"], warn)!;
    expect(out[0]).toBe("/api/cart");
    expect(out.slice(1).every((m) => m instanceof RegExp)).toBe(true);
    expect(out).toHaveLength(1 + PROTECT_PRESETS.payments.length);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown preset "preset:nope"'));
  });

  it('requests.protect: ["preset:payments"] keeps a failing checkout POST observe-only in heal, while the same model acts elsewhere', async () => {
    const adv = new Adversary(insist("retry"));
    const s = setup({ mode: "heal", triage: "always", decider: adv, breaker: false, requests: { protect: ["preset:payments"] }, policy: { idempotencyHeaders: ["Idempotency-Key"] } });
    adv.clock = s.clock;
    s.server.on("POST", "/api/checkout", { status: 503, body: {}, latency: 10 });
    s.server.on("POST", "/api/notes", ({ n }) => (n === 1 ? { status: 503, body: {}, latency: 10 } : { status: 201, body: {}, latency: 10 }));
    const headers = { "Idempotency-Key": "k1" };
    const pa = s.fetch("/api/checkout", { method: "POST", body: "{}", headers });
    const pb = s.fetch("/api/notes", { method: "POST", body: "{}", headers });
    await s.clock.advance(5000);
    const [a, b] = await Promise.all([pa, pb]);
    expect(a.status).toBe(503);
    expect(s.server.hits.get("POST /api/checkout")).toBe(1);
    expect(b.status).toBe(201);
    expect(s.server.hits.get("POST /api/notes")).toBe(2);
    expect(ran(s.rt)).toEqual(["failure:retry"]);
    expect(s.rt.decisions().some((d) => d.reason === "protected")).toBe(true);
  });
});
