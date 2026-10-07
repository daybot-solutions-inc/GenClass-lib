import { Rng } from "../../shared/rng.ts";
import { CALM_TYPIST, CLEAN_CHAOS, FAST_TYPIST, sampleChaos, typeSteps } from "../../shared/scenario-kit.ts";
import type { Scenario, Step, TrialKind } from "../../shared/types.ts";
import { TYPED_TARGETS } from "../../server/data/cities.ts";

const INPUT = '[data-testid="search-input"]';

export function searchScenario(seed: number, kind: TrialKind): Scenario {
  const rng = new Rng(`search:${kind}:${seed}`);
  const style = kind === "clean" ? CALM_TYPIST : { ...FAST_TYPIST, median: rng.range(110, 210) };
  const steps: Step[] = [{ k: "click", sel: INPUT }, { k: "wait", ms: rng.range(300, 700) }];
  const queries: string[] = [];
  const labels: string[] = [];

  const rounds = rng.chance(kind === "clean" ? 0.3 : 0.45) ? 2 : 1;
  for (let r = 0; r < rounds; r++) {
    const city = rng.pick(TYPED_TARGETS);
    const text = rng.chance(0.7) ? city.toLowerCase() : city;
    // Most people stop typing once the right city shows up; some type it all.
    const stopAt = rng.chance(0.5) ? text.length : Math.max(3, Math.min(text.length, rng.int(4, text.length)));
    const typed = text.slice(0, stopAt);
    if (r > 0) {
      // Clear the field (select-all + Backspace equivalent: one Backspace per char, fast).
      steps.push({ k: "caret", sel: INPUT, pos: "end" });
      const prev = queries[queries.length - 1];
      steps.push({ k: "key", sel: INPUT, key: "Backspace", delays: prev.split("").map(() => rng.range(40, 90)) });
      steps.push({ k: "wait", ms: rng.range(250, 600) });
      labels.push("cleared");
    }
    steps.push(...typeSteps(rng, INPUT, typed, style));
    queries.push(typed);
    steps.push({ k: "mark", name: `typed${r}` });
    if (r === rounds - 1) steps.push({ k: "mark", name: "lastKey" });
    // Look at the results.
    steps.push({ k: "wait", ms: rng.range(1600, 2600) });
    labels.push(`“${typed}”`);
  }

  const chaos =
    kind === "clean"
      ? CLEAN_CHAOS
      : sampleChaos(rng, { latency: [120, 650], jitter: [80, 550], reorder: [0, 0.7], spikeRate: [0, 0.12], failRate: [0, 0.04] }, { spikeFactor: 4 });

  return {
    seed,
    kind,
    chaos,
    params: {},
    steps,
    intent: { finalQuery: queries[queries.length - 1], queries },
    label: labels.join(" → "),
  };
}
