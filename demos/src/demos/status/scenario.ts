import { Rng } from "../../shared/rng.ts";
import type { Chaos, RouteChaos } from "../../shared/chaos.ts";
import { CLEAN_CHAOS, sampleChaos } from "../../shared/scenario-kit.ts";
import type { Scenario, Step, TrialKind } from "../../shared/types.ts";
import { SERVICES } from "../../server/worlds/status.ts";

export function statusScenario(seed: number, kind: TrialKind): Scenario {
  const rng = new Rng(`status:${kind}:${seed}`);
  const calm = kind === "clean";
  const ids = SERVICES.map((s) => s.id);

  // True incidents the dashboard should show (the same in clean and chaos runs of a seed family).
  const incidents = [];
  const n = rng.int(1, 2);
  for (let i = 0; i < n; i++) {
    incidents.push({
      svc: rng.pick(ids),
      status: rng.chance(0.4) ? "down" : "degraded",
      at: Math.round(rng.range(3000, 9000)),
      dur: Math.round(rng.range(3500, 7000)),
    });
  }

  const steps: Step[] = [{ k: "until", cond: "loaded", timeout: 10000 }, { k: "wait", ms: rng.range(2000, 3500) }];
  const labels = [incidents.map((i) => `${i.svc} ${i.status}`).join(" + ")];
  let chaos: Partial<Chaos> = CLEAN_CHAOS;

  if (calm) {
    steps.push({ k: "click", sel: '[data-testid="refresh"]' });
    steps.push({ k: "wait", ms: rng.range(9000, 12000) });
  } else {
    const routes: Record<string, Partial<RouteChaos>> = {};
    for (const id of rng.shuffle(ids.slice()).slice(0, rng.int(1, 3))) routes[`status/${id}`] = { failRate: Math.round(rng.range(0.25, 0.6) * 100) / 100 };
    const slow = rng.pick(ids);
    routes[`status/${slow}`] = { ...(routes[`status/${slow}`] ?? {}), spikeRate: Math.round(rng.range(0.15, 0.4) * 100) / 100, spikeFactor: rng.int(5, 9) };
    chaos = sampleChaos(rng, { latency: [80, 320], jitter: [50, 260], failRate: [0, 0.06] }, { routes, timeoutRate: 0.02, hangMs: 6000 });
    labels.push(`${Object.keys(routes).length} flaky routes`);

    // The user notices something and mashes Refresh.
    steps.push({ k: "click", sel: '[data-testid="refresh"]', count: rng.int(1, 3), gap: rng.range(150, 450) });
    steps.push({ k: "wait", ms: rng.range(1500, 3000) });
    // The status API for one service goes down for a few seconds (the service itself is fine).
    if (rng.chance(0.7)) {
      const target = rng.pick(ids);
      const dur = rng.range(4000, 8000);
      steps.push({ k: "chaos", patch: { routes: { [`status/${target}`]: { outage: true } } } });
      steps.push({ k: "wait", ms: dur });
      steps.push({ k: "chaos", patch: { routes: { [`status/${target}`]: { outage: false } } } });
      labels.push(`${target} API outage ${(dur / 1000).toFixed(1)} s`);
    } else {
      steps.push({ k: "wait", ms: rng.range(4000, 7000) });
    }
    steps.push({ k: "wait", ms: rng.range(3000, 5000) });
  }

  return { seed, kind, chaos, params: { incidents, randomIncidents: false }, steps, intent: { incidents }, label: labels.join(", ") };
}
