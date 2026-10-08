// REVIEW: mutation pipeline / store hub findings. Each test describes the behaviour the contract requires; a
// failing test demonstrates a bug.
import { describe, expect, it } from "vitest";
import { ManualDecider, defaultScript, setup } from "./helpers.js";

describe("review: held value writes are re-applied as a patch", () => {
  it("a held write that fills a previously empty object keeps it when another field changed meanwhile", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always" });
    const s = rt.atom("profile", { query: "", data: {} as Record<string, unknown> });
    // async (non-user) value write: gated, held for the model
    s.set({ ...s.get(), data: { name: "Ada" } });
    expect(manual.pending.length).toBe(1);
    // meanwhile the user edits another field of the same store (user-sync write: applied at once)
    rt.user({ kind: "type", target: 'input "Search"', value: "x" }, () => s.set((v) => ({ ...v, query: "x" })));
    expect(s.get().query).toBe("x");
    manual.answer(defaultScript()); // expected / apply
    await clock.flush();
    // the held write must land as written (patched on top of the user's newer query)
    expect(s.get()).toEqual({ query: "x", data: { name: "Ada" } });
  });

  it("a write queued behind a held one keeps its new nested object", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always", policy: { holdBudgetMs: 1000 } });
    const s = rt.atom("ent", { a: 0, byId: {} as Record<string, unknown> });
    s.set({ ...s.get(), a: 1 }); // W1 held
    s.set({ ...s.get(), byId: { "7": { title: "x" } } }); // W2 proposed while W1 is held (base: a = 0)
    manual.answer(defaultScript()); // W1 apply
    await clock.flush();
    manual.answer(defaultScript()); // W2 apply
    await clock.flush();
    expect(s.get()).toEqual({ a: 1, byId: { "7": { title: "x" } } });
  });
});

describe("review: late revert (batch 2) and its undo", () => {
  it("undo of a late revert restores the write exactly (write that filled an empty object)", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always", policy: { holdBudgetMs: 100 } });
    const s = rt.atom("profile", { data: {} as Record<string, unknown> });
    s.set({ data: { name: "Ada" } }); // held
    await clock.advance(150); // budget expired: applied (fail-open)
    const applied = JSON.stringify(s.get());
    manual.answer(defaultScript({ mutation: { diagnosis: "stale", action: "discard" } })); // late discard -> revert
    await clock.flush();
    const reverted = JSON.stringify(s.get());
    const rec = rt.interventions().at(-1);
    rec?.undo?.(); // the developer clicks undo: re-apply the write
    expect({ applied, late: rec?.late, reverted, afterUndo: s.get() }).toEqual({
      applied: '{"data":{"name":"Ada"}}',
      late: true,
      reverted: '{"data":{}}',
      afterUndo: { data: { name: "Ada" } },
    });
  });
});

describe("review: in-place mutation", () => {
  it("an in-place array push is described with its real before/after", () => {
    const { rt } = setup({ decider: null });
    const cart = rt.atom("cart", { items: [1, 2] as number[] });
    cart.set((c) => {
      c.items.push(3); // common app pattern (mutable update)
      return c;
    });
    const ev = rt.history().find((e) => e.kind === "state")!;
    expect((ev.data!.summary as string[])[0]).toMatch(/2 items.*→ 3 items|2 → 3 items/);
  });
});

describe("review: in-place updater while held", () => {
  it("a held in-place update is not visible before it applies, and discard really drops it", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always", policy: { holdWrites: true } });
    const cart = rt.atom("cart", { items: [1] as number[] });
    cart.set((c) => {
      c.items.push(2); // mutable update inside the updater
      return c;
    });
    const whileHeld = cart.get().items.length; // API.md: get() while a write is held returns the current value
    manual.answer(defaultScript({ mutation: { diagnosis: "duplicate", action: "discard" } }));
    await clock.flush();
    expect({ whileHeld, afterDiscard: cart.get().items.length, discarded: rt.interventions().map((a) => a.action) }).toEqual({
      whileHeld: 1,
      afterDiscard: 1,
      discarded: ["discard"],
    });
  });
});

describe("review: field versions in facts", () => {
  it("counts every write since the cause started, even past the 16-entry history", async () => {
    const { rt, clock, server, fetch, decider } = setup();
    server.on("GET", "/api/slow", { body: "server", latency: 5000 });
    const s = rt.atom("doc", { v: "init" });
    // X starts first
    const px = fetch("/api/slow")
      .then((r) => r.json())
      .then((t) => s.set((v) => ({ ...v, v: t as string })));
    await clock.advance(10);
    // 20 writes by other operations while X is in flight
    for (let i = 1; i <= 20; i++) {
      await rt.op(`edit`, () => s.set((v) => ({ ...v, v: `local ${i}` })));
      await clock.advance(50);
    }
    await clock.advance(6000);
    await px;
    const call = decider.calls.find((c) => c.trigger === "mutation" && (c.state.trigger as string).includes("GET /api/slow"));
    expect(call).toBeDefined();
    const fact = (call!.state.facts as string[]).find((f) => f.startsWith("doc.v was written"));
    expect(fact).toBeDefined();
    // ground truth: 20 writes by others, version 0 -> 20
    expect(fact).toContain("written 20 times by other operations");
    expect(fact).toContain("(version 0 → 20)");
  });
});

describe("review: large arrays", () => {
  it("a change deep inside a 2,000-item array is recorded as a write", () => {
    const { rt } = setup({ decider: null });
    const items = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `item ${i}`, price: i % 50 }));
    const s = rt.atom("list", { items });
    const v0 = rt.internals.hub.field("list.items")!.v;
    s.set((v) => ({ items: v.items.map((x, i) => (i === 1500 ? { ...x, price: 999 } : x)) }));
    expect(s.get().items[1500].price).toBe(999);
    expect(rt.history().filter((e) => e.kind === "state")).toHaveLength(1);
    expect(rt.internals.hub.field("list.items")!.v).toBe(v0 + 1);
  });
});

describe("review: a commit that throws", () => {
  it("does not strand later writes to the same store (or block settled points forever)", async () => {
    const prev = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    const unhandled: unknown[] = [];
    process.on("unhandledRejection", (e) => unhandled.push(e));
    try {
      const manual = new ManualDecider();
      const { rt, clock, server, fetch } = setup({ decider: manual, policy: { holdBudgetMs: 5000 } });
      server.on("GET", "/api/x", { body: { a: 666 }, latency: 200 });
      let value = { a: 0, b: 0 };
      const subs = new Set<() => void>();
      const s = rt.guard("s", {
        get: () => value,
        set: (v) => {
          if (v.a === 666) throw new Error("app setter rejects a = 666"); // an app bug in a setter/reducer
          value = v;
          subs.forEach((f) => f());
        },
        subscribe: (fn) => {
          subs.add(fn);
          return () => subs.delete(fn);
        },
      });
      // X starts, Y writes s.a, then X's write to s.a is salient (written by another op since X started): held
      void fetch("/api/x")
        .then((r) => r.json())
        .then((d) => s.set((v) => ({ ...v, a: (d as { a: number }).a })));
      await clock.advance(50);
      await rt.op("y", () => s.set((v) => ({ ...v, a: 1 })));
      await clock.advance(200);
      expect(manual.pending.length).toBe(1); // X's write held
      // Z writes another field: not salient, applies right after the held write (proposal order)
      await rt.op("z", () => s.set((v) => ({ ...v, b: 1 })));
      expect(manual.pending.length).toBe(1);
      manual.answer(defaultScript()); // apply X's write -> the app's setter throws
      await clock.advance(100);
      // Z's write is legitimate and must still apply; nothing may stay pending forever
      expect(s.get().b).toBe(1);
      expect(rt.internals.hub.pending()).toHaveLength(0);
    } finally {
      process.removeAllListeners("unhandledRejection");
      for (const l of prev) process.on("unhandledRejection", l as (...a: unknown[]) => void);
    }
  });
});
