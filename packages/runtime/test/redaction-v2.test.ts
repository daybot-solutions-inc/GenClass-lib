// Redaction leaks fixed after 0.1.0-alpha.1: (1) the F2 fact ("would replace text the user typed") diffed raw strings,
// printing characters of a value the redactor hides; (2) under a strong secret-named container (`cvv`, `otp`, `pin`,
// `password`), numbers, bigints and arrays were shown (only strings were redacted).
import { describe as group, expect, it } from "vitest";
import { changeText, redactedStringDiff } from "../src/state/fields.js";
import type { EvaluateRequest } from "../src/types.js";
import { REDACTED, defaultRedact, describe, isSensitivePath, type Redactor } from "../src/util.js";
import { setup, type Setup } from "./helpers.js";

const factsOf = (r: EvaluateRequest | undefined) => ((r?.state.facts as string[] | undefined) ?? []).join("\n");
const deliveries = (s: Setup) => s.decider.calls.filter((c) => c.trigger === "delivery");

const SECRET_A = "correct horse battery staple tango";
const SECRET_B = "correct horse battery staple tango foxtrot";

/**
 * An autosave of `<store>.<field>` that echoes the saved text back after 400 ms while the user keeps typing: the
 * delivery would replace text the user typed (F2). Returns the facts of the first delivery request.
 */
async function f2Facts(opts: { store: string; field: string; redact?: Redactor }): Promise<string> {
  const s = setup(opts.redact ? { redact: opts.redact } : {});
  s.server.on("PUT", "/api/save", ({ body }) => {
    const sent = JSON.parse(body ?? "{}") as Record<string, string>;
    return { body: { [opts.field]: sent[opts.field].trim() }, latency: 400 };
  });
  const st = s.rt.atom(opts.store, { [opts.field]: `${SECRET_A} ` } as Record<string, string>);
  const save = () =>
    void s.rt.op("autosave", async () => {
      const d = (await (await s.fetch("/api/save", { method: "PUT", body: JSON.stringify({ [opts.field]: st.get()[opts.field] }) })).json()) as Record<string, string>;
      st.set({ [opts.field]: d[opts.field] });
    });
  save(); // teaches the signature's write set (the server trims the trailing space)
  await s.clock.advance(600);
  save();
  await s.clock.advance(100);
  for (const t of [`${SECRET_A} f`, `${SECRET_A} foxt`, SECRET_B]) {
    s.rt.user({ kind: "type", target: `input "${opts.field}"`, value: t }, () => st.set({ [opts.field]: t }));
    await s.clock.advance(80);
  }
  await s.clock.advance(1000);
  const req = deliveries(s)[0];
  expect(req).toBeDefined();
  return factsOf(req);
}

group("F2 on a field the redactor hides", () => {
  it("default redactor: a secret-named field shows [redacted] on both sides, never a diff of the raw text", async () => {
    const facts = await f2Facts({ store: "vault", field: "passphrase" });
    expect(facts).toMatch(/The response would replace text the user typed into vault\.passphrase after #\d+ started \(3 user writes, the last [\d.]+s ago\): \[redacted\] → \[redacted\]\./);
    expect(facts).not.toContain("foxtrot");
    expect(facts).not.toContain("staple");
  });

  it("custom redactor: a field it hides is rendered with its replacement, not diffed", async () => {
    const redact: Redactor = (p, v) => (p === "doc.body" ? "<hidden>" : v);
    const facts = await f2Facts({ store: "doc", field: "body", redact });
    expect(facts).toMatch(/would replace text the user typed into doc\.body after #\d+ started \(3 user writes, the last [\d.]+s ago\): <hidden> → <hidden>\./);
    expect(facts).not.toContain("foxtrot");
  });

  it("a field the redactor leaves alone keeps the diff-centred preview (model-visible text unchanged)", async () => {
    const facts = await f2Facts({ store: "doc", field: "body" });
    expect(facts).toMatch(/would replace text the user typed into doc\.body after #\d+ started \(3 user writes, the last [\d.]+s ago\): "…y staple tango foxtrot" → "…y staple tango" \(removes " foxtrot"\)\./);
  });

  it("redactedStringDiff diffs only values both sides of which pass the redactor unchanged", () => {
    const id: Redactor = (_p, v) => v;
    expect(redactedStringDiff("doc.body", SECRET_B, SECRET_A, id)?.text).toBe('"…y staple tango foxtrot" → "…y staple tango" (removes " foxtrot")');
    expect(redactedStringDiff("form.password", SECRET_B, SECRET_A, defaultRedact)).toBeNull();
    // only one side hidden (a custom redactor that hides by value) is still not diffed
    const byValue: Redactor = (_p, v) => (typeof v === "string" && v.includes("foxtrot") ? REDACTED : v);
    expect(redactedStringDiff("doc.body", SECRET_B, SECRET_A, byValue)).toBeNull();
    expect(redactedStringDiff("doc.body", 1, 2, id)).toBeNull();
    expect(changeText({ path: "form.password", before: SECRET_B, after: SECRET_A }, defaultRedact)).toBe("[redacted] → [redacted]");
    expect(changeText({ path: "doc.body", before: SECRET_B, after: SECRET_A }, byValue)).toBe(`[redacted] → ${JSON.stringify(SECRET_A)}`);
  });
});

group("default redactor under a strong secret-named container", () => {
  it("redacts numbers, bigints and arrays as well as strings", () => {
    const r = defaultRedact;
    expect(r("payment.cvv.value", 123)).toBe(REDACTED);
    expect(r("login.otp.code", 123456)).toBe(REDACTED);
    expect(r("lock.pin.value", 1234)).toBe(REDACTED);
    expect(r("lock.pin.value", 1234n)).toBe(REDACTED);
    expect(r("account.password.history", ["hunter1", "hunter2"])).toBe(REDACTED);
    expect(r("account.password.history", [111, 222])).toBe(REDACTED);
    expect(r("credentials.password.value", "hunter2")).toBe(REDACTED); // unchanged
    expect(r("users.3.password.attempts.0", 7)).toBe(REDACTED); // array indices are skipped
  });

  it("keeps booleans, null and undefined visible, and plain objects are still judged key by key", () => {
    const r = defaultRedact;
    expect(r("login.otp.sent", true)).toBe(true);
    expect(r("lock.pin.value", null)).toBe(null);
    expect(r("lock.pin.value", undefined)).toBe(undefined);
    expect(r("payment.cvv", { length: 3 })).toEqual({ length: 3 });
    expect(isSensitivePath("account.password", { history: [1] })).toBe(false);
  });

  it("keeps the broad-container behaviour: only opaque credential-looking strings are redacted", () => {
    const r = defaultRedact;
    expect(r("auth.expiresAt", 1767225600000)).toBe(1767225600000);
    expect(r("auth.retries", 3)).toBe(3);
    expect(r("auth.roles", ["admin", "editor"])).toEqual(["admin", "editor"]);
    expect(r("session.user.id", 42)).toBe(42);
    expect(r("auth.tokens.kind", "bearer")).toBe("bearer");
    expect(r("auth.tokens.access", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ")).toBe(REDACTED);
  });

  it("is unchanged outside secret-named containers", () => {
    const r = defaultRedact;
    expect(r("cart.items.3.qty", 2)).toBe(2);
    expect(r("board.cards", ["a"])).toEqual(["a"]);
    expect(r("map.pins", [1, 2])).toEqual([1, 2]);
    expect(r("trip.passengers.count", 4)).toBe(4);
    expect(r("auth.loading", 0)).toBe(0);
  });

  it("a number change under a strong container renders [redacted] in change text, in place of the digits", () => {
    expect(changeText({ path: "lock.pin.value", before: 1234, after: 5678 }, defaultRedact)).toBe(`${REDACTED} → ${REDACTED}`);
    expect(changeText({ path: "cart.items.3.qty", before: 1, after: 2 }, defaultRedact)).toBe("1 → 2");
  });

  it("describe() of a store hides those values", () => {
    // describe() prints two levels of keys, so these objects are shallow enough for the values to be rendered.
    expect(describe({ value: 1234, set: true }, "lock.pin", defaultRedact, 400)).toBe(`{value: ${REDACTED}, set: true}`);
    expect(describe({ cvv: { value: 123 } }, "payment", defaultRedact, 400)).toBe(`{cvv: {value: ${REDACTED}}}`);
    expect(describe({ history: [111, 222], hint: "x" }, "account.password", defaultRedact, 400)).toBe(`{history: ${REDACTED}, hint: ${REDACTED}}`);
    expect(describe({ pin: { value: 1234 } }, "lock", (_p, v) => v, 400)).toBe("{pin: {value: 1234}}"); // the same shape, unredacted
    expect(describe(1234, "lock.pin.value", defaultRedact)).toBe(REDACTED);
    expect(describe(["hunter1", "hunter2"], "account.password.history", defaultRedact)).toBe(REDACTED);
    expect(describe(true, "lock.pin.set", defaultRedact)).toBe("true");
  });
});
