// Batch 3 fixes not covered by REVIEW's tests: SIM requests a–f, plugin built-ins through the policy gate, rate
// warnings, ask() after destroy, init never throws, provider timeouts, the `transient` label.
import { describe, expect, it, vi } from "vitest";
import { createRuntime, DEFAULT_DIAGNOSES, GenClass, GenClassUnavailableError } from "../src/index.js";
import { isIdSegment, isSensitiveName, normalizePath } from "../src/util.js";
import type { Report } from "../src/types.js";
import { FakeClock, ManualDecider, choice, defaultScript, setup } from "./helpers.js";

describe("SIM a: redaction by field semantics", () => {
  it("a kanban card's value is kept; card numbers, passwords, tokens are not", () => {
    for (const n of ["password", "newPassword", "cardNumber", "card_no", "cvv", "CVC", "ssn", "iban", "apiKey", "accessToken", "sessionId", "otp", "authorization"]) expect(isSensitiveName(n)).toBe(true);
    for (const n of ["card", "cards", "author", "passengers", "tokens", "pinned", "session", "key", "keyboard", "column"]) expect(isSensitiveName(n)).toBe(false);
  });

  it("user values typed into a field described as a kanban card are recorded", async () => {
    const { rt, clock } = setup();
    rt.user({ kind: "change", target: 'card "Incident spike"', value: "done" });
    rt.user({ kind: "type", target: 'input "Card number"', value: "4242 4242" });
    await clock.flush();
    const ops = [...rt.ops.byId.values()].filter((o) => o.kind === "user");
    expect(ops[0].detail).toBe('"done"');
    expect(ops[1].detail).toBe('"[redacted]"');
  });
});

describe("SIM b–d: state lines and summaries", () => {
  it("parent paths of expanded objects never print as undefined; an item change shows the changed key", async () => {
    const { rt, clock, decider } = setup({ triage: "always" });
    const s = rt.atom("monitor", { kpis: {} as Record<string, number>, rows: [{ id: "a", status: "open" }, { id: "b", status: "open" }] });
    rt.user({ kind: "click", target: "button" }, () => s.set((v) => ({ ...v, kpis: { p95: 343 } })));
    await clock.flush();
    void rt.op("sync", () => s.set((v) => ({ ...v, rows: v.rows.map((r) => (r.id === "b" ? { ...r, status: "done" } : r)) })));
    await clock.flush();
    const req = decider.calls.at(-1)!;
    const state = (req.state.state as string[]).join("\n");
    expect(state).not.toMatch(/= undefined/);
    expect(state).toContain("monitor.kpis.p95 = 343");
    const facts = (req.state.facts as string[]).join("\n");
    expect(facts).toContain('This write would change monitor.rows: 2 items, 1 changed: {id: "b", status: "open" → "done"}.');
  });

  it('"changed N times and is back to V" instead of "6 → 6"', async () => {
    const { rt, clock, server, fetch, decider } = setup({ triage: "always" });
    server.on("GET", "/api/order", { body: { total: 9 }, latency: 500 });
    const order = rt.atom("order", { itemCount: 6, total: 0 });
    void rt.op("load", async () => {
      const r = (await (await fetch("/api/order")).json()) as { total: number };
      order.set((o) => ({ ...o, total: r.total }));
    });
    await clock.advance(50);
    rt.user({ kind: "click", target: 'button "+"' }, () => order.set((o) => ({ ...o, itemCount: 7 })));
    await clock.advance(50);
    rt.user({ kind: "click", target: 'button "-"' }, () => order.set((o) => ({ ...o, itemCount: 6 })));
    await clock.advance(1000);
    const req = decider.calls.find((c) => c.trigger === "mutation" && (c.state.trigger as string).includes("order.total"))!;
    const facts = (req.state.facts as string[]).join("\n");
    expect(facts).toMatch(/order\.itemCount changed twice since this write's cause \(#\d+\) started and is back to 6, last by user clicked button "-"/);
  });
});

describe("SIM e: short slug ids in signatures (conservative)", () => {
  it("normalises slugs, keeps words with a number suffix and versions", () => {
    expect(normalizePath("/api/tasks/tasks-1cam")).toBe("/api/tasks/:id");
    expect(normalizePath("/api/u/x7k2p/orders/ab12cd")).toBe("/api/u/:id/orders/:id");
    expect(normalizePath("/api/v2/items/PPBqWA9")).toBe("/api/v2/items/:id");
    for (const seg of ["sha256", "oauth2", "ipv4", "item42", "v1beta1", "html5", "x86_64", "utf-8"]) expect(isIdSegment(seg)).toBe(false);
  });
});

describe("SIM f: a remote write over a pending local change is salient", () => {
  it("names the in-flight request of the user action that wrote the field", async () => {
    const { rt, clock, server, fetch, decider } = setup();
    server.on("PATCH", "/api/cards/7", { body: { ok: true }, latency: 800 });
    const board = rt.atom("board", { card7: "todo" });
    // the user moves the card (optimistic local write) and the save is in flight
    rt.user({ kind: "click", target: 'button "Move to done"' }, () => {
      board.set((b) => ({ ...b, card7: "done" }));
      void fetch("/api/cards/7", { method: "PATCH", body: '{"column":"done"}' });
    });
    await clock.advance(100);
    // a push message (another client, older state) arrives and the app applies it
    await rt.op("ws message", () => board.set((b) => ({ ...b, card7: "doing" })));
    await clock.flush();
    const req = decider.calls.find((c) => c.trigger === "mutation")!;
    expect(req).toBeDefined();
    expect((req.state.facts as string[])[0]).toMatch(/^board\.card7 has a pending local change: user clicked button "Move to done" \(#\d+\) wrote it 0\.10s ago and its PATCH \/api\/cards\/:id \{column: "done"\} \(#\d+\) is still in flight; this write comes from task ws message \(#\d+\), which started after that user action\.$/);
    await clock.advance(2000);
  });
});

describe("plugins: built-in actions go through the policy gate", () => {
  it("ctx.builtin returns false for an action the mode or policy does not permit", async () => {
    const results: boolean[] = [];
    const { rt, clock } = setup({
      triage: "always",
      mode: "heal",
      policy: { deny: ["discard"] },
      script: (req) => ({
        diagnosis: choice("stale", Object.keys((req.questions.diagnosis as { criteria: object }).criteria)),
        action: choice("custom", Object.keys((req.questions.action as { criteria: object }).criteria)),
      }),
    });
    rt.action({ name: "custom", description: "x", on: ["mutation"], tier: "guard", run: async (ctx) => void results.push(await ctx.builtin("discard"), await ctx.builtin("defer")) });
    const a = rt.atom("a", 1);
    void rt.op("w", () => a.set(2));
    await clock.flush();
    expect(results[0]).toBe(false); // denied
    expect(results[1]).toBe(true); // defer is permitted
  });
});

describe("reports", () => {
  it("the rate-limit warning is emitted once per minute", async () => {
    const reports: Report[] = [];
    const { clock, server, fetch } = setup({ triage: "always", report: (r) => reports.push(r), policy: { maxActionsPerMinute: 1 }, script: defaultScript({ request: { diagnosis: "overload", action: "delay" } }) });
    server.on("GET", "/api/x", { body: 1, latency: 5 });
    for (let i = 0; i < 5; i++) {
      const p = fetch("/api/x");
      await clock.advance(2000);
      await p;
    }
    expect(reports.filter((r) => r.kind === "status" && /Rate limit/.test(r.message))).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  it("ask() after destroy rejects with reason destroyed", async () => {
    const { rt } = setup();
    rt.destroy();
    await expect(rt.ask({ type: "noul", instructions: "?" })).rejects.toMatchObject({ reason: "destroyed" });
    await expect(rt.ask({ type: "noul", instructions: "?" })).rejects.toBeInstanceOf(GenClassUnavailableError);
  });

  it("createRuntime never throws on read-only globals (the observer is skipped)", () => {
    const g: Record<string, unknown> = { location: { href: "http://x/", pathname: "/", search: "" } };
    Object.defineProperty(g, "fetch", { value: () => Promise.resolve(new Response("x")), writable: false, enumerable: true });
    const rt = createRuntime({ clock: new FakeClock(), global: g, decider: null, report: "silent" });
    expect(typeof rt.atom).toBe("function");
    rt.destroy();
  });

  it("GenClass.init never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rt = GenClass.init({ model: false, report: "silent", plugins: [{ name: "bad", setup: () => { throw new Error("boom"); } }], observe: { fetch: false, timers: false } });
    expect(rt).toBeDefined();
    GenClass.destroy();
    warn.mockRestore();
  });

  it("a provider that never answers does not block later decisions", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always", policy: { holdBudgetMs: 100 } });
    const a = rt.atom("a", 0);
    void rt.op("w1", () => a.set(1)); // dispatched; never answered
    void rt.op("w2", () => a.set(2)); // queued behind it
    expect(manual.pending).toHaveLength(1);
    await clock.advance(2200); // budget (100) + late-revert window (2000): the runtime gives up on w1
    expect(manual.pending.length).toBeGreaterThanOrEqual(1);
    expect(a.get()).toBe(2);
  });
});

describe("vocabulary", () => {
  it("has the transient label after unusual", () => {
    const labels = Object.keys(DEFAULT_DIAGNOSES);
    expect(labels.slice(-2)).toEqual(["unusual", "transient"]);
    expect(DEFAULT_DIAGNOSES.transient).toBe("a one-off failure that is likely to succeed if tried again");
  });
});
