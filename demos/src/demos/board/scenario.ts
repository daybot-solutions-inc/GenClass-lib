import { Rng } from "../../shared/rng.ts";
import { CLEAN_CHAOS, sampleChaos } from "../../shared/scenario-kit.ts";
import type { Scenario, Step, TrialKind } from "../../shared/types.ts";
import { BOARD_SEED, COLUMNS, type ColumnId } from "../../server/worlds/board.ts";

const ORDER = COLUMNS.map((c) => c.id);

export function boardScenario(seed: number, kind: TrialKind): Scenario {
  const rng = new Rng(`board:${kind}:${seed}`);
  const calm = kind === "clean";
  const col: Record<string, ColumnId> = Object.fromEntries(BOARD_SEED.map(([id, , c]) => [id, c]));
  const ids = BOARD_SEED.map(([id]) => id);
  const focus = rng.shuffle(ids.slice()).slice(0, rng.int(2, 3));
  const steps: Step[] = [{ k: "until", cond: "loaded", timeout: 10000 }, { k: "wait", ms: rng.range(600, 1200) }];
  let conflicts = 0;
  let bursts = 0;

  const moveOnce = (id: string, dir?: "left" | "right"): boolean => {
    const i = ORDER.indexOf(col[id]);
    const d = dir ?? (i === 0 ? "right" : i === ORDER.length - 1 ? "left" : rng.chance(0.65) ? "right" : "left");
    const j = d === "right" ? i + 1 : i - 1;
    if (j < 0 || j >= ORDER.length) return false;
    steps.push({ k: "click", sel: `[data-testid="mv-${d}-${id}"]` });
    col[id] = ORDER[j];
    return true;
  };

  const n = calm ? rng.int(4, 6) : rng.int(6, 10);
  for (let m = 0; m < n; m++) {
    const id = rng.chance(0.6) ? rng.pick(focus) : rng.pick(ids);
    if (!moveOnce(id)) continue;
    if (!calm && rng.chance(0.35)) {
      // Changed their mind: move the same card again right away.
      steps.push({ k: "wait", ms: rng.range(110, 260) });
      if (moveOnce(id)) bursts++;
    }
    if (!calm && rng.chance(0.3)) {
      // A teammate grabs the same card at the same time.
      steps.push({ k: "server", action: "teammateMove", args: { card: id } });
      conflicts++;
    }
    steps.push({ k: "wait", ms: calm ? rng.range(900, 1600) : rng.range(150, 900) });
  }
  steps.push({ k: "mark", name: "lastMove" });
  steps.push({ k: "wait", ms: 1500 });

  const chaos = calm
    ? CLEAN_CHAOS
    : sampleChaos(rng, { latency: [150, 600], jitter: [100, 500], reorder: [0.3, 0.9], failRate: [0.03, 0.15], spikeRate: [0, 0.08] }, { spikeFactor: 4 });

  return {
    seed,
    kind,
    chaos,
    params: { teamEveryMs: calm ? 7000 : rng.range(2000, 4000) },
    steps,
    intent: {},
    label: `${n} moves${bursts ? `, ${bursts} quick re-moves` : ""}${conflicts ? `, ${conflicts} conflicts` : ""}`,
  };
}
