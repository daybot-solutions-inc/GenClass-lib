import { describe, expect, it } from "vitest";
import { ManualDecider, defaultScript, setup } from "./helpers.js";

const discard = defaultScript({ mutation: { diagnosis: "stale", action: "discard" } });
const apply = defaultScript({ mutation: { diagnosis: "expected", action: "apply" } });

describe("atoms and the mutation pipeline (CONTRACT §4)", () => {
  it("writes made synchronously inside a user handler are never held", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always" });
    const a = rt.atom("q", "");
    rt.user({ kind: "type", target: 'input "Q"', value: "x" }, () => a.set("x"));
    expect(a.get()).toBe("x");
    expect(manual.pending.length).toBe(0);
    await clock.flush();
  });

  it("async writes are held while the model decides, then applied", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always" });
    const a = rt.atom("v", 0);
    await rt.op("load", async () => {
      await Promise.resolve();
    });
    await clock.flush();
    rt.op("save", () => a.set(5));
    expect(a.get()).toBe(0); // held
    expect(manual.pending.length).toBe(1);
    manual.answer(apply);
    await clock.flush();
    expect(a.get()).toBe(5);
  });

  it("a held write fails open after holdBudgetMs; a late discard reverts exactly that write", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always", policy: { holdBudgetMs: 120 } });
    const a = rt.atom("v", 0);
    void rt.op("w", () => a.set(1));
    await clock.advance(119);
    expect(a.get()).toBe(0);
    await clock.advance(2);
    expect(a.get()).toBe(1); // fail-open: applied
    await clock.advance(300);
    manual.answer(discard); // decided 0.3 s after it applied
    await clock.flush();
    expect(a.get()).toBe(0);
    const d = rt.decisions()[0];
    expect(d.action).toBe("discard");
    expect(d.executed).toBe(true);
    const rec = rt.interventions()[0];
    expect(rec.late).toBe(true);
    expect(rec.changed).toMatch(/^Reverted the write to v from task w \(#\d+\) \(decided 0\.30s after it applied\); v is back to 0\.$/);
    expect(rt.explain(rec.id)!.message).toMatch(/^\[GenClass\] Reverted a stale write: /);
    rec.undo!();
    expect(a.get()).toBe(1);
  });

  it("a late discard does not revert a write whose fields changed since (superseded) or after 2 s", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always", policy: { holdBudgetMs: 100 } });
    const a = rt.atom("v", 0);
    void rt.op("w", () => a.set(1));
    await clock.advance(150);
    rt.user({ kind: "click", target: "button" }, () => a.set(2)); // newer write to the same field
    await clock.flush();
    manual.answer(discard);
    await clock.flush();
    expect(a.get()).toBe(2);
    expect(rt.decisions()[0].executed).toBe(false);
    expect(rt.decisions()[0].reason).toMatch(/^superseded: v changed again after the write applied/);
    // too late: the runtime stops waiting for the answer 2 s after the hold budget (no decision is recorded)
    const b = rt.atom("b", 0);
    void rt.op("w2", () => b.set(1));
    await clock.advance(2500);
    manual.answer(discard);
    await clock.flush();
    expect(b.get()).toBe(1);
    expect(rt.decisions()).toHaveLength(1);
  });

  it("a late discard does not revert a write when the same chain wrote again after it", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always", policy: { holdBudgetMs: 100 } });
    const a = rt.atom("a", 0);
    const b = rt.atom("b", 0);
    // a subscriber derives b from a (a write made synchronously in the same chain when a applies)
    a.subscribe((v) => b.set(v * 10));
    void rt.op("w", () => a.set(1));
    await clock.advance(250); // a applied (fail-open); its subscriber's write to b (same chain) applied too
    expect(b.get()).toBe(10);
    while (manual.pending.length) manual.answer(discard);
    await clock.flush();
    const d = rt.decisions().find((x) => x.subjectRef?.store === "a")!;
    expect(d.executed).toBe(false);
    expect(d.reason).toMatch(/the same operation chain wrote b\.?\w* after this write applied/);
    expect(a.get()).toBe(1);
  });

  it("a late defer/apply is only recorded", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always", policy: { holdBudgetMs: 100 } });
    const a = rt.atom("v", 0);
    void rt.op("w", () => a.set(1));
    await clock.advance(150);
    manual.answer(defaultScript({ mutation: { diagnosis: "conflict", action: "defer" } }));
    await clock.flush();
    expect(a.get()).toBe(1);
    expect(rt.decisions()[0].reason).toMatch(/after the hold budget expired/);
  });

  it("provider errors (not ready, too many tokens, timeout, busy) fail open at once", async () => {
    for (const code of ["not_ready", "max_tokens_exceeded", "timeout", "busy"]) {
      const { rt, clock, decider } = setup({ triage: "always" });
      decider.script = () => {
        throw Object.assign(new Error(code), { code });
      };
      const a = rt.atom("v", 0);
      void rt.op("w", () => a.set(1));
      await clock.flush();
      expect(a.get()).toBe(1);
      expect(rt.decisions().length).toBe(0);
      expect(clock.now()).toBe(1000); // no time passed: not held until the budget
    }
  });

  it("applies held and queued writes in proposal order per store", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual });
    const a = rt.atom("list", [] as number[]);
    // make the first write salient: an identical additive change applied just before
    void rt.op("add", () => a.set((l) => [...l, 1]));
    await clock.flush();
    void rt.op("add", () => a.set((l) => [...l, 1])); // identical delta -> salient -> held
    expect(manual.pending.length).toBe(1);
    void rt.op("other", () => a.set((l) => [...l, 2])); // neutral but queued behind the held write
    expect(a.get()).toEqual([1]);
    manual.answer(apply);
    await clock.flush();
    expect(a.get()).toEqual([1, 1, 2]);
  });

  it("functional updates re-run against the value at apply time", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always" });
    const n = rt.atom("n", 0);
    void rt.op("inc", () => n.update((x) => x + 1));
    expect(n.get()).toBe(0);
    rt.user({ kind: "click", target: "button" }, () => n.set(10)); // user write goes first
    expect(n.get()).toBe(10);
    manual.answer(apply);
    await clock.flush();
    expect(n.get()).toBe(11);
  });

  it("held value writes are re-applied as patches over newer user input", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always" });
    const s = rt.atom("search", { query: "r", results: [] as string[] });
    const base = s.get();
    void rt.op("results", () => s.set({ ...base, results: ["react"] }));
    rt.user({ kind: "type", target: 'input "Search"', value: "re" }, () => s.set({ ...s.get(), query: "re" }));
    manual.answer(apply);
    await clock.flush();
    expect(s.get()).toEqual({ query: "re", results: ["react"] });
  });

  it("discard drops the write (the caller is not notified); undo applies it", async () => {
    const { rt, clock } = setup({ triage: "always", script: discard });
    const a = rt.atom("v", "old");
    let notified = 0;
    a.subscribe(() => notified++);
    void rt.op("late", () => a.set("stale"));
    await clock.flush();
    expect(a.get()).toBe("old");
    expect(notified).toBe(0);
    const rec = rt.interventions()[0];
    expect(rec.action).toBe("discard");
    expect(rec.changed).toMatch(/Dropped the write to v/);
    rec.undo!();
    expect(a.get()).toBe("stale");
    // the undo write is a GenClass write: never gated
    expect(rt.decisions().length).toBe(1);
  });

  it("defer re-decides after the related in-flight operations settle (max 2 defers)", async () => {
    const { rt, clock, server, fetch, decider } = setup({ triage: "always", script: defaultScript({ mutation: { diagnosis: "conflict", action: "defer" } }) });
    server.on("GET", "/api/x", ({ n }) => ({ body: n, latency: n === 1 ? 300 : 50 }));
    const a = rt.atom("x", 0);
    const load = () =>
      rt.user({ kind: "click", target: "button" }, () => {
        void (async () => {
          const v = (await (await fetch("/api/x")).json()) as number;
          a.set(v);
        })();
      });
    load();
    await clock.advance(10);
    load();
    await clock.advance(2000);
    // writes were deferred up to twice, then applied
    const muts = decider.calls.filter((c) => c.trigger === "mutation");
    expect(muts.length).toBeGreaterThanOrEqual(2);
    expect(rt.interventions().every((r) => r.action === "defer")).toBe(true);
    expect([1, 2]).toContain(a.get());
    const last = muts[muts.length - 1];
    expect(Object.keys((last.questions.action as { criteria: object }).criteria)).not.toContain("defer");
  });

  it("stores with hold: false are never held", async () => {
    const manual = new ManualDecider();
    const { rt } = setup({ decider: manual, triage: "always" });
    const a = rt.atom("fast", 0, { hold: false });
    void rt.op("w", () => a.set(1));
    expect(a.get()).toBe(1);
    expect(manual.pending.length).toBe(0);
  });

  it("guard() writes through io.set and records external changes without holding", async () => {
    const { rt, clock } = setup();
    let value = { n: 1 };
    const subs = new Set<() => void>();
    const io = {
      get: () => value,
      set: (v: { n: number }) => {
        value = v;
        subs.forEach((f) => f());
      },
      subscribe: (f: () => void) => (subs.add(f), () => subs.delete(f)),
    };
    const g = rt.guard("ext", io);
    g.set({ n: 2 });
    expect(value).toEqual({ n: 2 });
    io.set({ n: 3 }); // external change
    expect(g.get()).toEqual({ n: 3 });
    const writes = rt.history().filter((e) => e.kind === "state" && e.name === "ext");
    expect(writes.length).toBe(2);
    expect(rt.hub.get("ext")!.fields.get("ext.n")!.v).toBe(2);
    await clock.flush();
  });

  it("atom() with an existing name returns the same store", () => {
    const { rt } = setup();
    const a = rt.atom("same", 1);
    a.set(2);
    const b = rt.atom("same", 99);
    expect(b.get()).toBe(2);
  });

  it("records field versions, writers and histories", async () => {
    const { rt, clock } = setup();
    const c = rt.atom("cart", { items: [] as number[], total: 0 });
    rt.user({ kind: "click", target: 'button "Add"' }, () => c.set({ items: [1], total: 5 }));
    await clock.flush();
    const f = rt.hub.field("cart.total")!;
    expect(f.v).toBe(1);
    expect(rt.ops.get(f.writer)!.kind).toBe("user");
    expect(rt.hub.field("cart.items")!.hist[0].delta).toMatch(/^a:\+/);
  });
});
