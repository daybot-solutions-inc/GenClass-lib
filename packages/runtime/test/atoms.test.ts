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

  it("a held write fails open after holdBudgetMs", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always", policy: { holdBudgetMs: 120 } });
    const a = rt.atom("v", 0);
    void rt.op("w", () => a.set(1));
    await clock.advance(119);
    expect(a.get()).toBe(0);
    await clock.advance(2);
    expect(a.get()).toBe(1);
    manual.answer(discard); // arrives late: recorded, not executed
    await clock.flush();
    const d = rt.decisions()[0];
    expect(d.action).toBe("discard");
    expect(d.executed).toBe(false);
    expect(d.reason).toMatch(/hold budget/);
    expect(a.get()).toBe(1);
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
