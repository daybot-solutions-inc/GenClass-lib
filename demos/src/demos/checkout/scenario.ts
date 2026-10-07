import { Rng } from "../../shared/rng.ts";
import { CLEAN_CHAOS, sampleChaos } from "../../shared/scenario-kit.ts";
import type { Scenario, Step, TrialKind } from "../../shared/types.ts";
import { PRODUCTS } from "../../server/worlds/checkout.ts";

export function checkoutScenario(seed: number, kind: TrialKind): Scenario {
  const rng = new Rng(`checkout:${kind}:${seed}`);
  const calm = kind === "clean";
  const gap = () => (calm ? rng.range(600, 1300) : rng.range(90, 700));
  const fastGap = () => (calm ? rng.range(550, 900) : rng.range(80, 260));
  const steps: Step[] = [{ k: "until", cond: "loaded", timeout: 10000 }, { k: "wait", ms: rng.range(400, 900) }];
  const labels: string[] = [];

  const picks = rng.shuffle(PRODUCTS.slice()).slice(0, rng.int(2, 4));
  const qty: Record<string, number> = {};
  for (const p of picks) {
    steps.push({ k: "click", sel: `[data-testid="add-${p.sku}"]` });
    qty[p.sku] = 1;
    if (!calm && rng.chance(0.25) && p.stock > 1) {
      steps.push({ k: "wait", ms: rng.range(120, 300) });
      steps.push({ k: "click", sel: `[data-testid="add-${p.sku}"]` });
      qty[p.sku]++;
    }
    steps.push({ k: "wait", ms: gap() });
  }
  labels.push(`${picks.length} products`);

  // Quantity changes on one or two lines (rapid clicks under stress).
  for (const p of rng.shuffle(picks.slice()).slice(0, rng.int(1, 2))) {
    const room = p.stock - qty[p.sku];
    const n = Math.min(room, rng.int(1, 3));
    for (let i = 0; i < n; i++) {
      steps.push({ k: "click", sel: `[data-testid="inc-${p.sku}"]` });
      qty[p.sku]++;
      steps.push({ k: "wait", ms: fastGap() });
    }
    if (n) labels.push(`+${n} ${p.sku}`);
  }
  if (rng.chance(0.3)) {
    const p = rng.pick(picks);
    steps.push({ k: "click", sel: `[data-testid="dec-${p.sku}"]` });
    qty[p.sku]--;
    labels.push(`−1 ${p.sku}`);
    steps.push({ k: "wait", ms: gap() });
  }

  // Review, then check out.
  steps.push({ k: "wait", ms: calm ? rng.range(1500, 2500) : rng.range(500, 1800) });
  steps.push({ k: "mark", name: "order" });
  const style = calm ? "once" : rng.weighted([["double", 0.35], ["impatient", 0.3], ["once", 0.35]] as const);
  if (style === "double") {
    steps.push({ k: "click", sel: '[data-testid="place-order"]', count: 2, gap: rng.range(70, 180) });
    labels.push("double-click order");
  } else if (style === "impatient") {
    steps.push({ k: "click", sel: '[data-testid="place-order"]' });
    steps.push({ k: "wait", ms: rng.range(1200, 2600) });
    steps.push({ k: "click", sel: '[data-testid="place-order"]', unless: "orderDone" });
    labels.push("impatient re-click");
  } else {
    steps.push({ k: "click", sel: '[data-testid="place-order"]' });
    labels.push("one click");
  }
  steps.push({ k: "until", cond: "orderDone", timeout: 20000 });
  steps.push({ k: "wait", ms: 900 });

  const chaos = calm
    ? CLEAN_CHAOS
    : sampleChaos(
        rng,
        { latency: [150, 700], jitter: [100, 500], failRate: [0.03, 0.2], commitFailRate: [0.02, 0.12], timeoutRate: [0, 0.06], spikeRate: [0, 0.1] },
        { hangMs: 6500, spikeFactor: 5 },
      );

  return { seed, kind, chaos, params: {}, steps, intent: { orders: 1, qty }, label: labels.join(", ") };
}
