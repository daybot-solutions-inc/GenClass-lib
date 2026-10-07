import { Rng } from "../../shared/rng.ts";
import { CALM_TYPIST, CLEAN_CHAOS, FAST_TYPIST, sampleChaos, typeSteps } from "../../shared/scenario-kit.ts";
import type { Scenario, Step, TrialKind } from "../../shared/types.ts";

const BODY = '[data-testid="note-body"]';

const SENTENCES = [
  "Ask Priya about the staging certificate.",
  "Move the retro to Thursday afternoon.",
  "Benchmark the cold start on the old laptop.",
  "The webhook retries need a jitter.",
  "Write down why we picked Postgres.",
  "Follow up on the accessibility audit.",
  "Pair on the flaky date picker test.",
  "Remember to rotate the API keys.",
  "Draft the launch tweet, keep it short.",
  "Compare the two pricing pages side by side.",
  "Check whether the CDN purges on deploy.",
  "Add a section on rollbacks to the runbook.",
];

export function editorScenario(seed: number, kind: TrialKind): Scenario {
  const rng = new Rng(`editor:${kind}:${seed}`);
  const style = kind === "clean" ? CALM_TYPIST : { ...FAST_TYPIST, median: rng.range(120, 200), typoRate: 0.04 };
  const steps: Step[] = [{ k: "click", sel: BODY }, { k: "caret", sel: BODY, pos: "end" }, { k: "wait", ms: rng.range(300, 700) }];
  const bursts = rng.int(2, 4);
  let typed = "";
  for (let b = 0; b < bursts; b++) {
    const sentence = (b === 0 ? "\n" : " ") + rng.pick(SENTENCES);
    steps.push({ k: "caret", sel: BODY, pos: "end" });
    steps.push(...typeSteps(rng, BODY, sentence, style));
    typed += sentence;
    // A pause: reading back, thinking. Short pauses overlap with in-flight saves.
    if (b < bursts - 1) steps.push({ k: "wait", ms: kind === "clean" ? rng.range(900, 2600) : rng.range(250, 2200) });
  }
  steps.push({ k: "mark", name: "lastKey" });
  steps.push({ k: "wait", ms: rng.range(1200, 2000) });

  const chaos =
    kind === "clean"
      ? CLEAN_CHAOS
      : sampleChaos(rng, { latency: [250, 900], jitter: [150, 700], reorder: [0.15, 0.8], failRate: [0, 0.1], spikeRate: [0, 0.1] }, { spikeFactor: 4 });

  return {
    seed,
    kind,
    chaos,
    params: {},
    steps,
    intent: { noteId: "n1", typed },
    label: `${bursts} bursts, ${typed.length} chars`,
  };
}
