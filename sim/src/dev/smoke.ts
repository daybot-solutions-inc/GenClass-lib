// Dev tool: run base runs on many seeds and report what the runtime produced.
//   node sim/dist/smoke.js [--seeds 40] [--from 1] [--fake] [--show trigger] [--cf]
import { createFakeRuntime } from "../run/fake-runtime.js";
import { realRuntimeFactory, type RuntimeFactory } from "../run/rt.js";
import { runScenario } from "../run/runner.js";
import { buildScenario } from "../world/scenario.js";
import { generateTrajectory } from "../gen/trajectory.js";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1]! : d;
};
const seeds = Number(opt("--seeds", "40"));
const from = Number(opt("--from", "1"));
const show = opt("--show", "");
const fake = args.includes("--fake");
const cf = args.includes("--cf");

async function main(): Promise<void> {
  const factory: RuntimeFactory = fake ? createFakeRuntime : await realRuntimeFactory();
  const byTrig: Record<string, number> = {};
  const how: Record<string, number> = {};
  const diag: Record<string, number> = {};
  const errs: string[] = [];
  const shown = new Set<string>();
  let runs = 0;
  let ms = 0;
  let tasks = 0;
  for (let seed = from; seed < from + seeds; seed++) {
    const scn = buildScenario(seed);
    const t0 = performance.now();
    const r = await runScenario(scn, { ideal: false, factory, record: true, probeAsk: true });
    ms += performance.now() - t0;
    runs++;
    tasks += r.tasks;
    for (const e of r.internalErrors) if (errs.length < 8) errs.push(`seed ${seed}: ${String((e as Error)?.stack ?? e).slice(0, 600)}`);
    for (const d of r.decisions) {
      byTrig[d.trigger] = (byTrig[d.trigger] ?? 0) + 1;
      how[`${d.trigger}:${d.subject.how}`] = (how[`${d.trigger}:${d.subject.how}`] ?? 0) + 1;
      diag[`${d.trigger}:${d.diagnosis ?? "?"}`] = (diag[`${d.trigger}:${d.diagnosis ?? "?"}`] ?? 0) + 1;
      if (show && (show === "all" || show === d.trigger) && !shown.has(d.trigger + (d.diagnosis ?? ""))) {
        shown.add(d.trigger + (d.diagnosis ?? ""));
        console.log(`\n=== seed ${seed} k=${d.k} ${d.trigger} diag=${d.diagnosis} actions=${d.actions.join(",")} subject=${JSON.stringify(d.subject)}`);
        console.log(JSON.stringify(d.state, null, 1).slice(0, 3000));
      }
    }
    if (show === "ask" && r.asks.length && shown.size < 2) {
      shown.add(`ask${seed}`);
      console.log(`\n=== seed ${seed} ask`);
      console.log(JSON.stringify(r.asks[0]!.state, null, 1).slice(0, 2500));
    }
  }
  console.log(`\nruns=${runs} avg_ms=${(ms / runs).toFixed(1)} avg_tasks=${(tasks / runs).toFixed(0)}`);
  console.log("decisions by trigger", byTrig);
  console.log("correlation", how);
  console.log("diagnoses", diag);
  if (errs.length) console.log("internal errors:\n" + errs.join("\n---\n"));
  if (cf) {
    const t0 = performance.now();
    let rows = 0;
    const drops: Record<string, number> = {};
    for (let seed = from; seed < from + Math.min(seeds, 20); seed++) {
      const out = await generateTrajectory(seed, { factory, runtimeName: fake ? "fake" : "real", maxPoints: 4, askRows: true, testKeep: 1, exploreScale: 1 });
      rows += out.rows.length;
      for (const [k, v] of Object.entries(out.drops)) drops[k] = (drops[k] ?? 0) + v;
      if (out.skipped) console.log(`seed ${seed} skipped: ${out.skipped}`);
    }
    const s = (performance.now() - t0) / 1000;
    console.log(`trajectories: rows=${rows} in ${s.toFixed(1)} s (${(rows / s).toFixed(1)} rows/s single thread) drops=${JSON.stringify(drops)}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
