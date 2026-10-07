// REVIEW: precision of learned invariants and transition profiles on ordinary app behaviour. These tests show
// salient triggers raised for benign situations (the model is then consulted, and in heal mode may roll back).
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

describe("review: transition profiles", () => {
  it("a short last page of a paginated list is not an unusual transition", async () => {
    const { rt, clock, server, fetch, decider } = setup();
    server.on("GET", "/api/items", ({ url }) => {
      const p = Number(url.searchParams.get("page"));
      const n = p === 21 ? 3 : 10;
      return { body: Array.from({ length: n }, (_, i) => ({ id: p * 100 + i, title: `item ${p}.${i}` })), latency: 20 };
    });
    const list = rt.atom("list", { items: [] as unknown[], page: 0 });
    for (let p = 1; p <= 21; p++) {
      rt.user({ kind: "click", target: 'button "Next page"' }, () => {
        void fetch(`/api/items?page=${p}`)
          .then((r) => r.json())
          .then((items) => list.set((v) => ({ ...v, items: items as unknown[], page: p })));
      });
      await clock.advance(1000);
    }
    const tr = decider.calls.filter((c) => c.trigger === "transition");
    if (tr.length) console.log("[review] transition raised:\n  " + (tr[0].state.facts as string[]).join("\n  "));
    expect(tr).toHaveLength(0);
  });
});

describe("review: keyed collections with non-numeric keys", () => {
  it("an op that adds an entity under a new key (e.g. 'm21') is not an unusual transition every time", async () => {
    const { rt, clock, decider } = setup();
    const chat = rt.atom("chat", { byId: {} as Record<string, { text: string }> });
    for (let i = 1; i <= 25; i++) {
      await rt.op("receive", () => chat.set((v) => ({ byId: { ...v.byId, [`m${i}`]: { text: `hello ${i}` } } })));
      await clock.advance(200);
    }
    const tr = decider.calls.filter((c) => c.trigger === "transition");
    if (tr.length) console.log(`[review] ${tr.length} transition triggers; first:\n  ` + (tr[0].state.facts as string[])[0]);
    expect(tr).toHaveLength(0);
  });
});

async function selectThenClose(withEdits: boolean) {
  const s = setup();
  const { rt, clock } = s;
  const ui = rt.atom("ui", { selectedId: null as number | null });
  const doc = rt.atom("doc", { text: "" });
  for (const id of [5, 7, 9]) {
    rt.user({ kind: "click", target: `row "${id}"` }, () => ui.set({ selectedId: id }));
    await clock.advance(200);
  }
  rt.user({ kind: "key", key: "Escape" }, () => ui.set({ selectedId: null }));
  await clock.advance(200);
  const snaps = () => (rt as unknown as { snaps: { t: number; seq: number }[] }).snaps;
  const before = snaps().at(-1)!;
  if (withEdits)
    for (let i = 0; i < 5; i++) {
      rt.user({ kind: "type", target: 'textarea "Doc"', value: `v${i}` }, () => doc.set({ text: `v${i}` }));
      await clock.advance(200);
    }
  return { ...s, before, after: snaps().at(-1)! };
}

describe("review: learned invariants", () => {
  it("closing a selection (null) after selecting three items is not an inconsistency", async () => {
    const { decider } = await selectThenClose(false);
    const inc = decider.calls.filter((c) => c.trigger === "inconsistency");
    if (inc.length) console.log("[review] inconsistency raised:\n  " + (inc[0].state.facts as string[]).join("\n  "));
    expect(inc).toHaveLength(0);
  });

  it("design risk (contract §4): one lingering benign violation freezes lastConsistent for every store", async () => {
    const { before, after, rt } = await selectThenClose(true);
    // five later user edits to an unrelated store: no newer consistent snapshot exists, so a rollback offered
    // later (inconsistency / transition / error) restores the pre-Escape state of whatever store it targets
    console.log(`[review] newest consistent snapshot seq ${after.seq} (hub seq now ${rt.internals.hub.seq})`);
    expect(after.seq).toBeGreaterThan(before.seq);
  });
});
