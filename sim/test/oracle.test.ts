// Oracle sanity on hand-built mini programs (CONTRACT §11 / task list): the counterfactual costs must prefer the
// obviously right action, and diagnoses must match the sim's intent knowledge.

import { describe, expect, it } from "vitest";
import { actionLabel } from "../src/oracle/cost.js";
import { pointCosts as pointCostsK } from "../src/gen/trajectory.js";

/** Mean cost per action over the counterfactual futures (tests compare means). */
async function pointCosts(...args: Parameters<typeof pointCostsK>) {
  const r = await pointCostsK(...args);
  const costs: Record<string, number> = {};
  for (const [a, xs] of Object.entries(r.costs)) costs[a] = xs.reduce((x, y) => x + y, 0) / xs.length;
  return { ...r, costs, futures: r.costs };
}
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
    // situation v2: the stale response is decided at the network boundary (delivery), before the app writes.
    const d = find(base, (x) => x.trigger === "delivery");
    expect(d, "a delivery decision").toBeTruthy();
    expect(d!.diagnosis).toBe("stale");
    const pc = await pointCosts(scn, ideal, base, d!, factory);
    expect(pc.drop).toBeUndefined();
    expect(argmin(pc.costs)).toBe("discard");
    expect(actionLabel(pc.futures, "deliver").best).toBe("discard");
  });

  it("single-point counterfactual credits discarding ONE stale write even if a later stale write lands", async () => {
    const { factory } = await testFactory();
    const scn = mini("search", searchPatch(ITEMS), {
      steps: [typeQ(1000, "l"), typeQ(1100, "la"), typeQ(1200, "lam")],
      latency: (_m, p) => (p.includes("=lam") ? 100 : p.includes("=la") ? 2400 : p.includes("=l") ? 4200 : undefined),
      duration: 8000,
    });
    const { ideal, base } = await runBoth(scn, factory);
    const dels = base.decisions.filter((x) => x.trigger === "delivery");
    expect(dels.length).toBeGreaterThanOrEqual(2);
    const first = dels[0]!; // "la" results landing after "lam"
    expect(first.diagnosis).toBe("stale");
    const pc = await pointCosts(scn, ideal, base, first, factory);
    // Final state is wrong either way ("l" lands later and is delivered under the passive future),
    // yet discarding this one response's stale write keeps the right results on screen longer.
    expect(pc.parts.discard!.finalClient).toBeCloseTo(pc.parts.deliver!.finalClient, 6);
    expect(pc.costs.discard!).toBeLessThan(pc.costs.deliver!);
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
    expect(["block", "coalesce"]).toContain(actionLabel(pc.futures, "send").best);
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
    // Situation v2 asks only on newer-data conflicts / pending local changes: two independent adds usually raise no
    // question at all (the best outcome for benign concurrency). When one is asked, passive must win.
    const d = find(base, (x) => x.trigger === "delivery" || x.trigger === "mutation");
    if (!d) {
      expect(base.decisions.filter((x) => x.trigger === "delivery" || x.trigger === "mutation").length).toBe(0);
      return;
    }
    expect(d.diagnosis).toBe("expected");
    const pc = await pointCosts(scn, ideal, base, d!, factory);
    const passive = d!.trigger === "delivery" ? "deliver" : "apply";
    expect(actionLabel(pc.futures, passive).best).toBe(passive);
  });

  it("labels are sharp when futures agree and soft when they disagree", () => {
    // Clear-cut: discard beats apply by ~1 cost unit in every future.
    const clear = actionLabel({ apply: [3.0, 3.1, 2.9], discard: [2.0, 2.1, 1.9], defer: [2.9, 3.0, 2.8] }, "apply");
    expect(clear.best).toBe("discard");
    expect(clear.nonPassiveMass).toBeGreaterThan(0.95);
    // Same mean advantage but the futures disagree wildly: stays soft.
    const unsure = actionLabel({ apply: [3.0, 3.0, 3.0], discard: [0.0, 6.0, 0.0], defer: [3.0, 3.0, 3.0] }, "apply");
    expect(unsure.dist.apply!).toBeGreaterThan(0.15);
    // Benign: interventions are slightly harmful in every future: passive gets nearly all the mass.
    const benign = actionLabel({ apply: [1.0, 1.0, 1.0], discard: [1.3, 1.2, 1.4], defer: [1.1, 1.08, 1.12] }, "apply");
    expect(benign.dist.apply!).toBeGreaterThan(0.9);
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

describe("oracle (needs the real runtime: invariant miner, settled points)", () => {
  const real = process.env.SIM_RUNTIME === "real";
  it.runIf(real)("invariant break from a partial update: rollback/resync beat ignore", async () => {
    const { factory } = await testFactory();
    const add = (t: number, i: number) => step(t, "add", { kind: "click", target: `button "Add to cart ${i}"` }, { kind: "add", key: `f0.add.${i}` }, { product: i });
    const scn = mini("cart", { mode: "optimistic", rollback: true, recompute: "skip-rollback", addGuard: false, badgeStore: null }, {
      steps: [add(1000, 0), add(2500, 1), add(4000, 2), add(5500, 3), add(7500, 4)],
      outages: [{ start: 7400, end: 8200, endpoints: "*", mode: "503" }],
      duration: 12000,
    });
    const { ideal, base } = await runBoth(scn, factory);
    const d = find(base, (x) => x.trigger === "inconsistency");
    expect(d, "an inconsistency decision after the rollback path skipped the totals").toBeTruthy();
    expect(d!.diagnosis).toBe("inconsistent");
    const pc = await pointCosts(scn, ideal, base, d!, factory);
    if (process.env.SIM_DEBUG) {
      console.log(JSON.stringify(d!.state, null, 1));
      console.log(JSON.stringify(pc.parts, null, 1));
      for (const [a, r] of Object.entries(pc.results)) console.log(a, JSON.stringify(r.snapshots.filter((x) => x.t >= d!.t).slice(0, 4).map((x) => [x.t, x.state])));
      console.log("ideal", JSON.stringify(ideal.snapshots.filter((x) => x.t >= d!.t - 3000).slice(0, 4).map((x) => [x.t, x.state])));
    }
    const fix = Math.min(pc.costs.rollback ?? Infinity, pc.costs.resync ?? Infinity);
    expect(fix).toBeLessThan(pc.costs.ignore!);
  });

  it.runIf(real)("duplicate token refresh from concurrent 401s: coalesce beats send", async () => {
    const { factory } = await testFactory();
    const open = (t: number) => step(t, "open-all", { kind: "click", target: 'button "Sync"' }, { kind: "open", key: "f0.open", mode: "replace" });
    const scn = mini("auth", { singleFlight: false, ttlMs: 2000 }, { steps: [open(3000)], duration: 8000 });
    const { ideal, base } = await runBoth(scn, factory);
    const d = find(base, (x) => x.trigger === "request" && x.diagnosis === "duplicate");
    expect(d, "a request decision for the second refresh").toBeTruthy();
    const pc = await pointCosts(scn, ideal, base, d!, factory);
    expect(pc.costs.coalesce).toBeDefined();
    expect(pc.costs.coalesce!).toBeLessThan(pc.costs.send!);
  });
});
