// Oracle sanity on hand-built mini programs (CONTRACT §11 / task list): the counterfactual costs must prefer the
// obviously right action, and diagnoses must match the sim's intent knowledge.

import { describe, expect, it } from "vitest";
import { actionLabel } from "../src/oracle/cost.js";
import { pointCosts } from "../src/gen/trajectory.js";
import { argmin, find, mini, runBoth, step, testFactory } from "./helpers.js";

const typeQ = (t: number, v: string) => step(t, "type", { kind: "type", target: 'input "Search products"', value: v }, { kind: "query", key: "f0.query", mode: "replace" });
const searchPatch = (items: string[]) => ({
  guard: "none",
  debounce: 0,
  cache: false,
  minLen: 0,
  loadingFlag: false,
  totalField: false,
  onError: "show",
  timeoutMs: 0,
  nameField: "title",
  items: items.map((n) => ({ title: n })),
});
const ITEMS = ["lamp", "label", "ladder", "lilac", "lol", "lambda", "lame"];

describe("oracle", () => {
  it("stale overwrite: discard is best", async () => {
    const { factory } = await testFactory();
    const scn = mini("search", searchPatch(ITEMS), {
      steps: [typeQ(1000, "l"), typeQ(1100, "la")],
      latency: (_m, p) => (p.includes("=la") ? 100 : p.includes("=l") ? 900 : undefined),
    });
    const { ideal, base } = await runBoth(scn, factory);
    const d = find(base, (x) => x.trigger === "mutation");
    expect(d, "a held write decision").toBeTruthy();
    expect(d!.diagnosis).toBe("stale");
    const pc = await pointCosts(scn, ideal, base, d!, factory);
    expect(pc.drop).toBeUndefined();
    expect(argmin(pc.costs)).toBe("discard");
    expect(actionLabel(pc.costs, "apply").best).toBe("discard");
  });

  it("single-point counterfactual credits discarding ONE stale write even if a later stale write lands", async () => {
    const { factory } = await testFactory();
    const scn = mini("search", searchPatch(ITEMS), {
      steps: [typeQ(1000, "l"), typeQ(1100, "la"), typeQ(1200, "lam")],
      latency: (_m, p) => (p.includes("=lam") ? 100 : p.includes("=la") ? 2400 : p.includes("=l") ? 4200 : undefined),
      duration: 8000,
    });
    const { ideal, base } = await runBoth(scn, factory);
    const muts = base.decisions.filter((x) => x.trigger === "mutation");
    expect(muts.length).toBeGreaterThanOrEqual(2);
    const first = muts[0]!; // "la" results landing after "lam"
    expect(first.diagnosis).toBe("stale");
    const pc = await pointCosts(scn, ideal, base, first, factory);
    // Final state is wrong either way ("l" lands later and is applied under the passive future),
    // yet discarding this one write keeps the right results on screen longer.
    expect(pc.parts.discard!.finalClient).toBeCloseTo(pc.parts.apply!.finalClient, 6);
    expect(pc.costs.discard!).toBeLessThan(pc.costs.apply!);
    // defer can be cheaper still: held until the even staler response lands, then applied over it.
    expect(["discard", "defer"]).toContain(argmin(pc.costs));
  });

  it("intentional double add: send/apply is best and diagnosis is expected", async () => {
    const { factory } = await testFactory();
    const bump = (t: number) => step(t, "bump", { kind: "click", target: 'button "Upvote lamp"' }, { kind: "bump", key: "f0.bump.0" }, { item: 0 });
    const scn = mini("counter", { endpoint: "increment", echo: "none", retry: "none", nameField: "title", items: [{ title: "lamp", votes: 3 }], field: "votes" }, {
      steps: [bump(1000), bump(1500)],
      latency: (m) => (m === "POST" ? 800 : undefined),
    });
    const { ideal, base } = await runBoth(scn, factory);
    const d = find(base, (x) => x.trigger === "request");
    expect(d, "a request decision for the second identical POST").toBeTruthy();
    expect(d!.diagnosis).toBe("expected");
    const pc = await pointCosts(scn, ideal, base, d!, factory);
    expect(argmin(pc.costs)).toBe("send");
    if ("coalesce" in pc.costs) expect(pc.costs.coalesce!).toBeGreaterThan(pc.costs.send! + 1);
  });

  it("duplicate non-idempotent POST after a timeout whose first attempt committed: block/coalesce beat send", async () => {
    const { factory } = await testFactory();
    const steps = [
      step(500, "input", { kind: "type", target: 'input "Title"', value: "m" }, { key: "f0.draft.title", mode: "replace" }, { field: "title" }),
      step(600, "input", { kind: "type", target: 'input "Title"', value: "mu" }, { key: "f0.draft.title", mode: "replace" }, { field: "title" }),
      step(700, "input", { kind: "type", target: 'input "Title"', value: "mug" }, { key: "f0.draft.title", mode: "replace" }, { field: "title" }),
      step(1000, "submit", { kind: "submit", target: 'button "List product"' }, { kind: "create", key: "f0.create" }),
    ];
    const scn = mini("form", { retry: "no-key", retryOn: "timeout", timeoutMs: 1000, idemKey: false, disable: false, optimistic: false, onSuccess: "append", countField: false, onError: "show", fields: [{ name: "title", kind: "text", lo: 0, hi: 0, dec: 0 }], seed: [] }, {
      steps,
      latency: (m, _p, occ) => (m === "POST" ? (occ === 0 ? 1500 : 300) : undefined),
    });
    const { ideal, base } = await runBoth(scn, factory);
    const d = find(base, (x) => x.trigger === "request");
    expect(d, "a request decision for the retried POST").toBeTruthy();
    expect(d!.diagnosis).toBe("duplicate");
    const pc = await pointCosts(scn, ideal, base, d!, factory);
    const alt = Math.min(pc.costs.block ?? Infinity, pc.costs.coalesce ?? Infinity);
    expect(alt).toBeLessThan(pc.costs.send!);
    expect(["block", "coalesce"]).toContain(actionLabel(pc.costs, "send").best);
  });

  it("failure streak during an outage: delay/serve_cached beat send", async () => {
    const { factory } = await testFactory();
    const scn = mini("poll", { mode: "chain", intervalMs: 1000, skipIfInflight: true, onFail: "ignore", timeoutMs: 0, seqGuard: false, changes: 0 }, {
      steps: [],
      duration: 12000,
      outages: [{ start: 3000, end: 9000, endpoints: "*", mode: "503" }],
    });
    const { ideal, base } = await runBoth(scn, factory);
    const reqs = base.decisions.filter((x) => x.trigger === "request" && x.t > 4000 && x.t < 8000);
    expect(reqs.length).toBeGreaterThan(0);
    const d = reqs[0]!;
    expect(d.diagnosis).toBe("failing");
    const pc = await pointCosts(scn, ideal, base, d, factory);
    const alt = Math.min(pc.costs.delay ?? Infinity, pc.costs.serve_cached ?? Infinity);
    expect(alt).toBeLessThan(pc.costs.send!);
  });

  it("benign concurrency: apply is best", async () => {
    const { factory } = await testFactory();
    const add = (t: number, i: number) => step(t, "add", { kind: "click", target: `button "Add to cart ${i}"` }, { kind: "add", key: `f0.add.${i}` }, { product: i });
    const scn = mini("cart", { mode: "server", rollback: true, recompute: "always", addGuard: false, badgeStore: null }, {
      steps: [add(1000, 0), add(1100, 1)],
      latency: (m, _p, occ) => (m === "POST" ? (occ === 0 ? 600 : 300) : undefined),
    });
    const { ideal, base } = await runBoth(scn, factory);
    const d = find(base, (x) => x.trigger === "mutation");
    expect(d, "a held write decision for the second echo").toBeTruthy();
    expect(d!.diagnosis).toBe("expected");
    const pc = await pointCosts(scn, ideal, base, d!, factory);
    expect(actionLabel(pc.costs, "apply").best).toBe("apply");
  });

  it("exact ties favour the passive action", () => {
    const l = actionLabel({ apply: 1.234, discard: 1.234, defer: 1.234 }, "apply");
    expect(l.best).toBe("apply");
    expect(l.dist.apply!).toBeGreaterThan(0.95);
    const l2 = actionLabel({ send: 3, coalesce: 0.5, delay: 3.2, block: 9 }, "send");
    expect(l2.best).toBe("coalesce");
    const sum = Object.values(l2.dist).reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(0.999);
    expect(sum).toBeLessThan(1.001);
  });
});
