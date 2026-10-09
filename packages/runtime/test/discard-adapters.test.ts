// Delivery `discard` through the state-library adapters (CONTRACT §13, situation-v2 delivery trigger): the chain's
// write is applied without the changes over newer data, also when the write is a Redux dispatch or a Zustand set()
// that changes other fields too. Before heal/overnight, such a partly stale library write was applied whole
// (StoreHub.applyFilter fell open for any write with a commit), so the discard was a silent no-op while its record
// named the fields as dropped.
import { legacy_createStore as createStore, type Reducer, type UnknownAction } from "redux";
import { createStore as createZustand } from "zustand/vanilla";
import { describe, expect, it } from "vitest";
import { genclassEnhancer } from "../src/adapters/redux.js";
import { genclass } from "../src/adapters/zustand.js";
import { defaultScript, setup, type Setup } from "./helpers.js";

const stale = defaultScript({ delivery: { diagnosis: "stale", action: "discard" }, mutation: { diagnosis: "stale", action: "discard" } });

interface S {
  items: string[];
  loaded: Record<string, boolean>;
}
const initial: S = { items: [], loaded: {} };

function server(s: Setup) {
  s.server.on("GET", "/api/search", ({ url }) => {
    const q = url.searchParams.get("q") ?? "";
    return { body: { q, items: [`${q}-1`] }, latency: q === "a" ? 600 : 100 };
  });
}

/** z (learns the write set), then a slow "a" and a fast "ab": a's response arrives over newer data. */
async function race(s: Setup, apply: (d: { q: string; items: string[] }) => void) {
  const load = (q: string) =>
    s.rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
      void (async () => {
        const d = (await (await s.fetch(`/api/search?q=${q}`)).json()) as { q: string; items: string[] };
        apply(d);
      })();
    });
  load("z");
  await s.clock.advance(300);
  load("a");
  await s.clock.advance(20);
  load("ab");
  await s.clock.advance(1000);
}

describe("delivery discard through adapters (CONTRACT §13 situation-v2)", () => {
  it("redux: a dispatch that also changes other fields is applied without the stale ones", async () => {
    const s = setup({ script: stale });
    server(s);
    const reducer = ((st: S = initial, a: UnknownAction): S =>
      a.type === "results" ? { items: a.items as string[], loaded: { ...st.loaded, [a.q as string]: true } } : st) as unknown as Reducer<S, UnknownAction, S>;
    const store = createStore(reducer, genclassEnhancer(s.rt, { name: "search" }));
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getState().items.join(",")));
    await race(s, (d) => store.dispatch({ type: "results", q: d.q, items: d.items }));
    expect(store.getState().items).toEqual(["ab-1"]); // the stale results were dropped
    expect(store.getState().loaded).toEqual({ z: true, ab: true, a: true }); // the rest of the dispatch applied
    expect(seen).not.toContain("a-1"); // never shown, not even for a moment
    const rec = s.rt.interventions()[0];
    expect(rec.action).toBe("discard");
    expect(rec.dropped).toEqual(["search.items"]);
    rec.undo!();
    expect(store.getState().items).toEqual(["a-1"]);
    s.rt.destroy();
  });

  it("zustand: a set() that also changes other fields is applied without the stale ones", async () => {
    const s = setup({ script: stale });
    server(s);
    const store = createZustand<S & { put(d: { q: string; items: string[] }): void }>()(
      genclass(s.rt, "search")((set) => ({
        ...initial,
        put: (d) => set((st) => ({ items: d.items, loaded: { ...st.loaded, [d.q]: true } })),
      })) as never,
    );
    const seen: string[] = [];
    store.subscribe((st) => seen.push(st.items.join(",")));
    await race(s, (d) => store.getState().put(d));
    expect(store.getState().items).toEqual(["ab-1"]);
    expect(store.getState().loaded).toEqual({ z: true, ab: true, a: true });
    expect(typeof store.getState().put).toBe("function"); // the replace kept the actions
    expect(seen).not.toContain("a-1");
    const rec = s.rt.interventions()[0];
    expect(rec.action).toBe("discard");
    expect(rec.dropped).toEqual(["search.items"]);
    s.rt.destroy();
  });

  it("a write whose every change is stale is still dropped whole (no dispatch at all)", async () => {
    const s = setup({ script: stale });
    server(s);
    let reduced = 0;
    const reducer = ((st: S = initial, a: UnknownAction): S => {
      if (a.type !== "results") return st;
      reduced++;
      return { ...st, items: a.items as string[] };
    }) as unknown as Reducer<S, UnknownAction, S>;
    const store = createStore(reducer, genclassEnhancer(s.rt, { name: "search" }));
    await race(s, (d) => store.dispatch({ type: "results", q: d.q, items: d.items }));
    expect(store.getState().items).toEqual(["ab-1"]);
    expect(reduced).toBe(3); // previews only: z, a (previewed, dropped), ab
    s.rt.destroy();
  });
});
