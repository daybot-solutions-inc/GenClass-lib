// REVIEW: per-event and per-settled-point cost with big stores. Logs the measured numbers; thresholds are the
// budgets a drop-in library should stay within (writes happen per keystroke; a settled point is a main-thread task).
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

function shop(n: number) {
  const items = Array.from({ length: n }, (_, i) => ({
    id: i,
    sku: `SKU-${i}`,
    name: `Item ${i}`,
    price: (i % 97) + 0.5,
    qty: (i % 5) + 1,
    stock: i % 13,
    rating: (i % 50) / 10,
    weight: i % 7,
  }));
  return { items, filter: "", page: 1, pageSize: 50, total: n, selected: 3, cartCount: 2, cartTotal: 10.5, maxPrice: 97.5, minPrice: 0.5, version: 1 };
}

function entities(n: number) {
  const byId: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) byId[`u${i}x`] = { id: i, name: `User ${i}`, email: `u${i}@example.com`, age: 20 + (i % 50), active: i % 2 === 0 };
  return { entities: { byId }, ui: { query: "" } };
}

const ms = (f: () => void, reps: number): number => {
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) f();
  return (performance.now() - t0) / reps;
};

describe("review: cost with big stores (5,000 items)", () => {
  it("user-sync write (keystroke) on a store holding a 5,000-item array", () => {
    const { rt } = setup({ decider: null });
    const s = rt.atom("shop", shop(5000));
    let k = 0;
    const per = ms(() => rt.user({ kind: "type", target: 'input "Filter"', value: `q${k}` }, () => s.set((v) => ({ ...v, filter: `q${k++}` }))), 50);
    console.log(`[review] user write, atom with 5,000-item array: ${per.toFixed(2)} ms/write`);
    expect(per).toBeLessThan(1);
  });

  it("async write (gated, facts computed) on a store holding a 5,000-item array", () => {
    const { rt } = setup(); // ready decider: every async write is triaged
    const s = rt.atom("shop", shop(5000));
    let k = 0;
    const per = ms(() => s.set((v) => ({ ...v, filter: `q${k++}` })), 50);
    console.log(`[review] async write, atom with 5,000-item array: ${per.toFixed(2)} ms/write`);
    expect(per).toBeLessThan(2);
  });

  it("redux-style dispatch on a normalized store with 5,000 entities", () => {
    const { rt } = setup();
    let state = entities(5000);
    const subs = new Set<() => void>();
    const h = rt.adapter("app", { get: () => state, set: (v) => void (state = v as typeof state), subscribe: (fn) => (subs.add(fn), () => subs.delete(fn)) });
    let k = 0;
    const user = ms(
      () =>
        rt.user({ kind: "type", target: 'input "Search"' }, () =>
          h.propose({ fn: (p) => ({ ...(p as typeof state), ui: { query: `q${k++}` } }), commit: (n) => ((state = n as typeof state), subs.forEach((f) => f())) }),
        ),
      30,
    );
    const asyncW = ms(() => h.propose({ fn: (p) => ({ ...(p as typeof state), ui: { query: `r${k++}` } }), commit: (n) => ((state = n as typeof state), subs.forEach((f) => f())) }), 30);
    console.log(`[review] redux-style dispatch, 5,000 entities: user ${user.toFixed(2)} ms, async ${asyncW.toFixed(2)} ms; fields tracked: ${rt.internals.hub.get("app")!.fields.size}`);
    expect(user).toBeLessThan(1);
    expect(asyncW).toBeLessThan(2);
  });

  it("settled point with a 5,000-item store (atom changed / adapter unchanged)", async () => {
    const { rt, clock } = setup({ decider: null });
    const s = rt.atom("shop", shop(5000));
    const small = rt.atom("small", { n: 0 });
    // learn a bit first
    for (let i = 0; i < 6; i++) {
      s.set((v) => ({ ...v, filter: `f${i}`, selected: (v.selected + 1) % 50 }));
      await clock.advance(100);
    }
    let k = 0;
    const atomChanged = ms(() => {
      s.set((v) => ({ ...v, filter: `g${k++}` }));
      rt.settled();
    }, 10);
    let adapterState = shop(5000);
    rt.adapter("shop2", { get: () => adapterState, set: (v) => void (adapterState = v as typeof adapterState) });
    const adapterUnchanged = ms(() => {
      small.set({ n: k++ });
      rt.settled();
    }, 10);
    console.log(
      `[review] settled point: atom 5,000 items (changed) ${atomChanged.toFixed(1)} ms; + unchanged adapter 5,000 items ${adapterUnchanged.toFixed(1)} ms; candidates ${rt.internals.miner.candidates()}`,
    );
    expect(atomChanged).toBeLessThan(16);
    expect(adapterUnchanged).toBeLessThan(16);
  });
});
