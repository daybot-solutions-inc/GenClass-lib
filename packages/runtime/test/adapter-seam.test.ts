import { describe, expect, it } from "vitest";
import { ManualDecider, defaultScript, setup } from "./helpers.js";

type S = { count: number; items: string[] };
type A = { type: "add"; item: string } | { type: "reset" };

function miniStore(initial: S) {
  let state = initial;
  const subs = new Set<() => void>();
  const reducer = (s: S, a: A): S => (a.type === "add" ? { count: s.count + 1, items: [...s.items, a.item] } : { count: 0, items: [] });
  return {
    reducer,
    getState: () => state,
    dispatch: (a: A) => {
      state = reducer(state, a);
      subs.forEach((f) => f());
    },
    replace: (s: S) => {
      state = s;
      subs.forEach((f) => f());
    },
    subscribe: (f: () => void) => (subs.add(f), () => subs.delete(f)),
  };
}

describe("runtime.adapter (seam for redux/zustand adapters)", () => {
  it("previews with the reducer, holds async writes, commits through the library", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always" });
    const store = miniStore({ count: 0, items: [] });
    const h = rt.adapter("shop", { get: store.getState, subscribe: store.subscribe });
    const dispatch = (a: A) => h.propose({ fn: (prev) => store.reducer(prev, a), commit: () => store.dispatch(a) });
    // user-sync dispatch: committed immediately
    rt.user({ kind: "click", target: "button" }, () => dispatch({ type: "add", item: "a" }));
    expect(store.getState().count).toBe(1);
    await clock.flush(); // end of the click's task
    // async dispatch: held until the decision
    void rt.op("sync", () => dispatch({ type: "add", item: "b" }));
    expect(store.getState().count).toBe(1);
    manual.answer(defaultScript({ mutation: { diagnosis: "expected", action: "apply" } }));
    await clock.flush();
    expect(store.getState().items).toEqual(["a", "b"]);
    const f = rt.hub.field("shop.count")!;
    expect(f.v).toBe(2);
  });

  it("a discarded write is never committed", async () => {
    const { rt, clock } = setup({ triage: "always", script: defaultScript({ mutation: { diagnosis: "duplicate", action: "discard" } }) });
    const store = miniStore({ count: 0, items: [] });
    const h = rt.adapter("shop", { get: store.getState, subscribe: store.subscribe });
    let commits = 0;
    void rt.op("sync", () =>
      h.propose({
        fn: (prev) => store.reducer(prev, { type: "add", item: "x" }),
        commit: () => {
          commits++;
          store.dispatch({ type: "add", item: "x" });
        },
      }),
    );
    await clock.flush();
    expect(commits).toBe(0);
    expect(store.getState().count).toBe(0);
  });

  it("changes made directly on the library store are recorded, never held", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always" });
    const store = miniStore({ count: 0, items: [] });
    rt.adapter("shop", { get: store.getState, subscribe: store.subscribe });
    store.dispatch({ type: "add", item: "z" });
    expect(rt.hub.field("shop.items")!.v).toBe(1);
    expect(manual.pending.length).toBe(0);
    await clock.flush();
  });

  it("rollback is offered only when the adapter can set the store", async () => {
    const run = async (withSet: boolean) => {
      const { rt, clock, decider } = setup({ mode: "heal", script: defaultScript({ inconsistency: { diagnosis: "inconsistent", action: "rollback" } }) });
      const store = miniStore({ count: 0, items: [] });
      rt.adapter("shop", { get: store.getState, subscribe: store.subscribe, ...(withSet ? { set: store.replace } : {}) });
      for (const it of ["a", "b", "c", "d"]) {
        rt.user({ kind: "click", target: "button" }, () => store.dispatch({ type: "add", item: it }));
        await clock.advance(200);
      }
      rt.user({ kind: "click", target: "button" }, () => store.replace({ ...store.getState(), items: [...store.getState().items, "bug"] }));
      await clock.advance(200);
      const call = decider.calls.find((c) => c.trigger === "inconsistency")!;
      return { store, call };
    };
    const a = await run(true);
    expect(Object.keys((a.call.questions.action as { criteria: object }).criteria)).toContain("rollback");
    expect(a.store.getState().items).toEqual(["a", "b", "c", "d"]);
    const b = await run(false);
    expect(b.call.questions.action).toBeUndefined(); // only "ignore" remains
    expect(b.store.getState().items.length).toBe(5);
  });
});
