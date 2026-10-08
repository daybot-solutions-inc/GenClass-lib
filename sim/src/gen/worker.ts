// Worker thread: receives seed batches, generates trajectories, appends rows to its own shard files and reports
// compact statistics to the parent.

import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
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
  mode?: "gold" | "unlabeled" | "onpolicy";
  modelDir?: string;
  gate?: "shipping" | "explore";
}

const init = workerData as Init;

async function main(): Promise<void> {
  let factory: RuntimeFactory;
  let runtimeName = "real";
  if (init.fake) {
    factory = createFakeRuntime;
    runtimeName = "fake";
  } else factory = await realRuntimeFactory();
  const opts: GenOptions = { factory, runtimeName, maxPoints: init.maxPoints, askRows: init.askRows, testKeep: init.testKeep, exploreScale: init.exploreScale, mode: init.mode ?? "gold" };
  if (init.mode === "onpolicy") {
    const { loadModelDecider } = await import("../run/onpolicy.js");
    const m = await loadModelDecider(init.modelDir!);
    opts.model = m.host;
    opts.modelName = m.name;
    opts.gate = init.gate ?? "shipping";
  }
  const dir = join(init.out, "shards");
  mkdirSync(dir, { recursive: true });
  const partsDir = join(init.out, "parts");
  parentPort!.on("message", async (msg: { seeds?: number[]; stop?: boolean; part?: number }) => {
    if (msg.stop) {
      process.exit(0);
    }
    // Parts mode: all rows of this seed range go to part files, renamed into place only when the part is complete.
    const part = msg.part;
    const partRows: Record<string, number> = {};
    const partName = part === undefined ? "" : `part-${String(part).padStart(6, "0")}`;
    if (part !== undefined) mkdirSync(partsDir, { recursive: true });
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
      for (const [split, lines] of Object.entries(bySplit)) {
        if (part !== undefined) {
          appendFileSync(join(partsDir, `${partName}.${split}.jsonl.tmp`), lines.join("\n") + "\n");
          partRows[split] = (partRows[split] ?? 0) + lines.length;
        } else appendFileSync(join(dir, `${split}.w${init.id}.jsonl`), lines.join("\n") + "\n");
      }
      const lens = res.rows.map((r) => Math.round((JSON.stringify(r.state).length + JSON.stringify(r.questions).length) / 3.6));
      parentPort!.postMessage({
        type: "traj",
        seed,
        split: res.split,
        rows: res.rows.length,
        rowTriggers: res.rows.map((r) => String(r.meta.trigger)),
        rowSplits: res.rows.map((r) => r.split),
        rowBudgets: res.rows.map((r) => Number(r.meta.budget ?? 0)),
        stateChars: res.rows.map((r) => JSON.stringify(r.state).length),
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
    if (part !== undefined) {
      for (const split of Object.keys(partRows)) {
        const tmp = join(partsDir, `${partName}.${split}.jsonl.tmp`);
        if (existsSync(tmp)) renameSync(tmp, join(partsDir, `${partName}.${split}.jsonl`));
      }
      const seeds = msg.seeds ?? [];
      writeFileSync(join(partsDir, `${partName}.json`), JSON.stringify({ part, seeds: [seeds[0], seeds[seeds.length - 1]], rows: partRows }));
      parentPort!.postMessage({ type: "part-done", part, rows: partRows });
    }
    parentPort!.postMessage({ type: "idle" });
  });
  parentPort!.postMessage({ type: "ready" });
}

main().catch((e) => {
  parentPort!.postMessage({ type: "fatal", error: String((e as Error)?.stack ?? e) });
});
