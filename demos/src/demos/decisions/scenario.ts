import { Rng } from "../../shared/rng.ts";
import type { Chaos } from "../../shared/chaos.ts";
import { CALM_TYPIST, CLEAN_CHAOS, FAST_TYPIST, sampleChaos, typeSteps } from "../../shared/scenario-kit.ts";
import type { Scenario, Step, TrialKind } from "../../shared/types.ts";

const BODY = '[data-testid="journal-body"]';
const NOTES = [
  " Wind picked up after noon.",
  " Saw two ptarmigan near the tarn.",
  " Water filter is clogging again.",
  " Camp at 2,140 m, clear skies.",
  " Left knee holding up fine.",
  " Need more fuel for tomorrow.",
];

type Moment = "backup-busy" | "backup-idle" | "photos" | "health" | "leave-inflight" | "leave-saved" | "leave-failed";

export function decisionsScenario(seed: number, kind: TrialKind): Scenario {
  const rng = new Rng(`decisions:${kind}:${seed}`);
  const calm = kind === "clean";
  const style = calm ? CALM_TYPIST : { ...FAST_TYPIST, typoRate: 0.02 };
  const steps: Step[] = [{ k: "until", cond: "loaded", timeout: 10000 }, { k: "wait", ms: rng.range(2500, 4000) }];

  let condition = "healthy";
  let chaos: Partial<Chaos> = CLEAN_CHAOS;
  if (!calm) {
    condition = rng.pick(["healthy", "slow", "flaky", "failing"]);
    chaos =
      condition === "healthy"
        ? sampleChaos(rng, { latency: [50, 140], jitter: [10, 60] })
        : condition === "slow"
          ? sampleChaos(rng, { latency: [650, 1300], jitter: [150, 450], spikeRate: [0.05, 0.15] }, { spikeFactor: 3 })
          : condition === "flaky"
            ? sampleChaos(rng, { latency: [150, 400], jitter: [80, 250], failRate: [0.25, 0.45] })
            : sampleChaos(rng, { latency: [200, 500], jitter: [100, 300], failRate: [0.6, 0.85] });
  }

  const pool: Moment[] = calm ? ["backup-idle", "photos", "health", "leave-saved"] : ["backup-busy", "backup-idle", "photos", "health", "leave-inflight", "leave-saved", "leave-failed"];
  const moments = rng.shuffle(pool.slice()).slice(0, calm ? 3 : rng.int(3, 4));
  // Leaving ends a visit; keep it last.
  moments.sort((a, b) => Number(a.startsWith("leave")) - Number(b.startsWith("leave")));

  const type = () => {
    steps.push({ k: "caret", sel: BODY, pos: "end" });
    steps.push(...typeSteps(rng, BODY, rng.pick(NOTES), style));
  };
  const leaveAndReturn = () => {
    steps.push({ k: "click", sel: '[data-testid="leave"]' });
    steps.push({ k: "until", cond: "leaveAnswered", timeout: 6000 });
    steps.push({ k: "wait", ms: rng.range(400, 900) });
    steps.push({ k: "click", sel: '[data-testid="stay"]', unless: "noConfirm" });
    steps.push({ k: "click", sel: '[data-testid="reopen"]', unless: "notClosed" });
  };

  for (const m of moments) {
    switch (m) {
      case "backup-busy":
        type();
        steps.push({ k: "wait", ms: rng.range(80, 300) });
        steps.push({ k: "click", sel: '[data-testid="backup"]' });
        steps.push({ k: "wait", ms: rng.range(1500, 2500) });
        break;
      case "backup-idle":
        steps.push({ k: "wait", ms: rng.range(3500, 5000) });
        steps.push({ k: "click", sel: '[data-testid="backup"]' });
        steps.push({ k: "wait", ms: rng.range(1500, 2500) });
        break;
      case "photos":
        steps.push({ k: "click", sel: '[data-testid="load-photos"]' });
        steps.push({ k: "wait", ms: rng.range(1800, 3000) });
        break;
      case "health":
        steps.push({ k: "click", sel: '[data-testid="health"]' });
        steps.push({ k: "wait", ms: rng.range(1200, 2000) });
        break;
      case "leave-inflight":
        type();
        // The autosave fires 800 ms after the last key; leave while it is on its way.
        steps.push({ k: "wait", ms: rng.range(850, 1050) });
        leaveAndReturn();
        break;
      case "leave-saved":
        type();
        steps.push({ k: "wait", ms: calm ? rng.range(2500, 3500) : rng.range(3500, 5000) });
        leaveAndReturn();
        break;
      case "leave-failed":
        steps.push({ k: "chaos", patch: { routes: { "journal/save": { failRate: 1 } } } });
        type();
        steps.push({ k: "wait", ms: rng.range(2500, 3500) });
        leaveAndReturn();
        steps.push({ k: "chaos", patch: { routes: { "journal/save": { failRate: 0 } } } });
        break;
    }
  }
  steps.push({ k: "wait", ms: 800 });

  return { seed, kind, chaos, params: {}, steps, intent: { condition, moments }, label: `${condition}: ${moments.join(", ")}` };
}
