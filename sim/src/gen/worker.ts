// Worker thread: receives seed batches, generates trajectories, appends rows to its own shard files and reports
// compact statistics to the parent.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { createFakeRuntime } from "../run/fake-runtime.js";
import { realRuntimeFactory, type RuntimeFactory } from "../run/rt.js";
import { generateTrajectory, type GenOptions } from "./trajectory.js";

interface Init {
  id: number;
  out: string;
  fake: boolean;
  maxPoints: number;
  askRows: boolean;
  testKeep: number;
  exploreScale: number;
}

const init = workerData as Init;

async function main(): Promise<void> {
  let factory: RuntimeFactory;
  let runtimeName = "real";
  if (init.fake) {
    factory = createFakeRuntime;
    runtimeName = "fake";
  } else factory = await realRuntimeFactory();
  const opts: GenOptions = { factory, runtimeName, maxPoints: init.maxPoints, askRows: init.askRows, testKeep: init.testKeep, exploreScale: init.exploreScale };
  const dir = join(init.out, "shards");
  mkdirSync(dir, { recursive: true });
  parentPort!.on("message", async (msg: { seeds?: number[]; stop?: boolean }) => {
    if (msg.stop) {
      process.exit(0);
    }
    for (const seed of msg.seeds ?? []) {
      let res;
      try {
        res = await generateTrajectory(seed, opts);
      } catch (e) {
        parentPort!.postMessage({ type: "error", seed, error: String((e as Error)?.stack ?? e).slice(0, 2000) });
        continue;
      }
      const bySplit: Record<string, string[]> = {};
      for (const r of res.rows) (bySplit[r.split] ??= []).push(JSON.stringify(r));
      for (const [split, lines] of Object.entries(bySplit)) appendFileSync(join(dir, `${split}.w${init.id}.jsonl`), lines.join("\n") + "\n");
      const lens = res.rows.map((r) => Math.round((JSON.stringify(r.state).length + JSON.stringify(r.questions).length) / 3.6));
      parentPort!.postMessage({
        type: "traj",
        seed,
        split: res.split,
        rows: res.rows.length,
        rowTriggers: res.rows.map((r) => String(r.meta.trigger)),
        rowSplits: res.rows.map((r) => r.split),
        askKinds: res.rows.filter((r) => r.meta.trigger === "ask").flatMap((r) => r.meta.kinds as string[]),
        askLabels: res.rows.filter((r) => r.meta.trigger === "ask").flatMap((r) => Object.entries(r.labels).map(([q, l]) => `${q}=${JSON.stringify("p" in l ? l.p : "level" in l ? l.level : "label" in l ? l.label : "")}`)),
        lens,
        points: res.points,
        drops: res.drops,
        runs: res.runs,
        decisions: res.decisions,
        ms: res.ms,
        skipped: res.skipped ?? null,
        features: res.rows[0]?.meta.features ?? null,
        domain: res.rows[0]?.meta.domain ?? null,
        family: res.rows[0]?.meta.family ?? null,
      });
    }
    parentPort!.postMessage({ type: "idle" });
  });
  parentPort!.postMessage({ type: "ready" });
}

main().catch((e) => {
  parentPort!.postMessage({ type: "fatal", error: String((e as Error)?.stack ?? e) });
});
