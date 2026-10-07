import { describe, expect, it } from "vitest";
import { InvariantMiner } from "../src/state/invariants.js";
import { flatten } from "../src/state/fields.js";
import { defaultScript, setup } from "./helpers.js";

type Item = { id: number; price: number; qty: number };

function leaves(stores: Record<string, unknown>) {
  const m = new Map();
  for (const [k, v] of Object.entries(stores)) for (const [p, l] of flatten(k, v)) m.set(p, l);
  return m;
}

describe("invariant miner (CONTRACT §4)", () => {
  it("learns len/sum/equality relations after 3 settled changes and drops falsified candidates", () => {
    const m = new InvariantMiner();
    const cart = (items: Item[], extra = 0) => ({
      items,
      count: items.length,
      total: items.reduce((s, i) => s + i.price * i.qty, 0) + extra,
      badge: items.length,
    });
    const states = [
      cart([{ id: 1, price: 2, qty: 1 }]),
      cart([{ id: 1, price: 2, qty: 2 }]),
      cart([{ id: 1, price: 2, qty: 2 }, { id: 2, price: 5, qty: 1 }]),
      cart([{ id: 2, price: 5, qty: 3 }]),
      cart([{ id: 2, price: 5, qty: 3 }, { id: 3, price: 1, qty: 1 }]),
      cart([{ id: 2, price: 5, qty: 3 }, { id: 3, price: 1, qty: 1 }, { id: 4, price: 2, qty: 2 }]),
    ];
    for (const s of states) {
      m.noteChanged(["cart.items", "cart.count", "cart.total", "cart.badge"]);
      expect(m.observe(leaves({ cart: s }), 0).violations).toEqual([]);
    }
    const learned = m.learned().map((x) => x.text);
    expect(learned).toContain("cart.count == len(cart.items)");
    expect(learned).toContain("cart.total == sum(cart.items[*].price * cart.items[*].qty)");
    expect(learned).toContain("cart.count == cart.badge");
    expect(learned).toContain("cart.items[*].id unique");
    // a violation
    m.noteChanged(["cart.total"]);
    const bad = { ...cart([{ id: 2, price: 5, qty: 3 }]), total: 99 };
    const v = m.observe(leaves({ cart: bad }), 0).violations;
    expect(v.map((x) => x.text)).toContain("cart.total == sum(cart.items[*].price * cart.items[*].qty)");
    expect(v.find((x) => x.text.startsWith("cart.total"))!.values).toMatch(/cart\.total = 99, sum\(.*\) = 15/);
  });

  it("does not learn relations from fields that never changed together", () => {
    const m = new InvariantMiner();
    for (let i = 1; i <= 5; i++) {
      m.noteChanged(["a.x"]);
      m.observe(leaves({ a: { x: i, y: 7 } }), 0);
    }
    expect(m.learned().map((x) => x.text)).not.toContain("a.y >= 0");
    expect(m.learned().map((x) => x.text)).toContain("a.x >= 0");
  });

  it("skips fields under id-like keys (dynamic collections)", () => {
    const m = new InvariantMiner();
    for (let i = 1; i <= 4; i++) {
      m.noteChanged(["db.byId"]);
      m.observe(leaves({ db: { byId: { [String(100 + i)]: { title: "t" + i } } } }), 0);
    }
    expect(m.learned().some((x) => x.text.includes("byId"))).toBe(false);
  });
});

describe("inconsistency trigger and rollback", () => {
  it("raises once per violation episode at a settled point; rollback restores the last consistent state", async () => {
    const { rt, clock, decider } = setup({ mode: "heal", script: defaultScript({ inconsistency: { diagnosis: "inconsistent", action: "rollback" } }) });
    const cart = rt.atom("cart", { items: [] as Item[], count: 0, total: 0 });
    const add = (it: Item) =>
      rt.user({ kind: "click", target: 'button "Add"' }, () => {
        const items = [...cart.get().items, it];
        cart.set({ items, count: items.length, total: items.reduce((s, i) => s + i.price * i.qty, 0) });
      });
    for (let i = 1; i <= 4; i++) {
      add({ id: i, price: i, qty: 1 });
      await clock.advance(200);
    }
    expect(rt.miner.learned().map((x) => x.text)).toContain("cart.count == len(cart.items)");
    // an inconsistent write (a buggy code path forgets count and total)
    rt.user({ kind: "click", target: 'button "Quick add"' }, () => cart.set({ ...cart.get(), items: [...cart.get().items, { id: 9, price: 9, qty: 1 }] }));
    await clock.advance(200);
    const calls = decider.calls.filter((c) => c.trigger === "inconsistency");
    expect(calls.length).toBe(1);
    const facts = (calls[0].state.facts as string[]).join("\n");
    expect(facts).toMatch(/cart\.count == len\(cart\.items\) no longer holds: cart\.count = 4, len\(cart\.items\) = 5/);
    // rollback ran (heal mode): back to 4 items
    expect(cart.get().items.length).toBe(4);
    expect(cart.get().count).toBe(4);
    const rec = rt.interventions()[0];
    expect(rec.action).toBe("rollback");
    rec.undo!();
    expect(cart.get().items.length).toBe(5);
    // the episode continues (still violated): no second trigger
    await clock.advance(500);
    expect(decider.calls.filter((c) => c.trigger === "inconsistency").length).toBe(1);
  });

  it("ignores transient states between writes that are not settled", async () => {
    const { rt, clock, decider } = setup();
    const s = rt.atom("s", { items: [] as number[], count: 0 });
    for (let i = 1; i <= 6; i++) {
      // two separate writes 10 ms apart: the intermediate state violates count == len(items), but is never settled
      rt.user({ kind: "click", target: "button" }, () => s.set({ ...s.get(), items: [...s.get().items, i] }));
      await clock.advance(10);
      rt.user({ kind: "click", target: "button" }, () => s.set({ ...s.get(), count: s.get().items.length }));
      await clock.advance(200);
    }
    expect(rt.miner.learned().map((x) => x.text)).toContain("s.count == len(s.items)");
    expect(decider.calls.filter((c) => c.trigger === "inconsistency").length).toBe(0);
  });

  it("expect() predicates are checked from the start", async () => {
    const { rt, clock, decider } = setup();
    const a = rt.atom("a", 1);
    rt.expect("a stays positive", () => a.get() > 0);
    rt.user({ kind: "click", target: "button" }, () => a.set(-1));
    await clock.advance(200);
    const call = decider.calls.find((c) => c.trigger === "inconsistency")!;
    expect((call.state.facts as string[])[0]).toBe('The developer invariant "a stays positive" no longer holds.');
  });
});
