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

async function profile(factory: RuntimeFactory): Promise<void> {
  const { FEATURES } = await import("../app/features/index.js");
  const rows: [string, number, number, number, number][] = [];
  for (const kind of Object.keys(FEATURES)) {
    let ms = 0;
    let tasks = 0;
    let decs = 0;
    let snaps = 0;
    const n = Number(opt("--per", "4"));
    for (let i = 0; i < n; i++) {
      const scn = buildScenario(9100000 + i, { kinds: [kind] });
      const t0 = performance.now();
      const r = await runScenario(scn, { ideal: false, factory, record: true });
      ms += performance.now() - t0;
      tasks += r.tasks;
      decs += r.decisions.length;
      snaps += r.snapshots.length;
    }
    rows.push([kind, ms / n, tasks / n, decs / n, snaps / n]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  for (const [k, ms, t, d, sn] of rows) console.log(`${k.padEnd(14)} ${ms.toFixed(0).padStart(6)} ms/run  ${t.toFixed(0).padStart(7)} tasks  ${d.toFixed(0).padStart(5)} decisions  ${sn.toFixed(0).padStart(6)} snapshots`);
}

/** S2: P(accidental | gap to the previous identical user action), measured on the scenario generator. */
async function repeatPrior(n: number): Promise<void> {
  const { repeatOfIndex } = await import("../run/latent.js");
  const edges = [100, 200, 500, 1000, 2000, 3000];
  const acc = edges.map(() => 0);
  const tot = edges.map(() => 0);
  for (let seed = 1; seed <= n; seed++) {
    const scn = buildScenario(seed);
    const rep = repeatOfIndex(scn.steps);
    scn.steps.forEach((s, i) => {
      const j = rep[i];
      if (j === undefined || s.when) return;
      const g = s.t - scn.steps[j]!.t;
      const b = edges.findIndex((e) => g <= e);
      if (b < 0) return;
      tot[b]!++;
      if (s.intent.accidental) acc[b]!++;
    });
  }
  edges.forEach((e, b) => console.log(`gap <= ${e} ms: ${tot[b]} repeats, accidental ${(acc[b]! / Math.max(1, tot[b]!)).toFixed(3)}`));
}

async function main(): Promise<void> {
  if (args.includes("--repeat-prior")) return repeatPrior(Number(opt("--repeat-prior", "20000")));
  const factory: RuntimeFactory = fake ? createFakeRuntime : await realRuntimeFactory();
  if (args.includes("--profile")) return profile(factory);
  const byTrig: Record<string, number> = {};
  const how: Record<string, number> = {};
  const diag: Record<string, number> = {};
  const errs: string[] = [];
  const roles: Record<string, number> = {};
  const pushWrites: Record<string, number> = {};
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
    for (const w of r.know.writes) if (w.role === "push") pushWrites[w.feature] = (pushWrites[w.feature] ?? 0) + 1;
    for (const d of r.decisions) {
      if (d.trigger === "mutation" && d.subject.ref !== undefined) {
        const w = r.know.getWrite(d.subject.ref);
        const k = `${w?.role}:${d.diagnosis}`;
        roles[k] = (roles[k] ?? 0) + 1;
      }
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
  console.log("mutation subject roles", Object.fromEntries(Object.entries(roles).sort((a, b) => b[1] - a[1])));
  console.log("push writes proposed", pushWrites);
  if (errs.length) console.log("internal errors:\n" + errs.join("\n---\n"));
  if (cf) {
    const t0 = performance.now();
    const tj = await import("../gen/trajectory.js");
    const times: [number, number, string][] = [];
    tj.resetCostMs();
    let rows = 0;
    const drops: Record<string, number> = {};
    for (let seed = from; seed < from + seeds; seed++) {
      const ts = performance.now();
      const out = await generateTrajectory(seed, { factory, runtimeName: fake ? "fake" : "real", maxPoints: 6, askRows: true, testKeep: 1, exploreScale: 1 });
      const sc = buildScenario(seed);
      times.push([performance.now() - ts, seed, `${sc.features.map((f) => f.kind).join("+")} ${(sc.tUser / 1000).toFixed(0)}s runs=${out.runs} rows=${out.rows.length} decisions=${out.decisions}`]);
      rows += out.rows.length;
      for (const [k, v] of Object.entries(out.drops)) drops[k] = (drops[k] ?? 0) + v;
      if (out.skipped) console.log(`seed ${seed} skipped: ${out.skipped}`);
    }
    const s = (performance.now() - t0) / 1000;
    times.sort((a, b) => b[0] - a[0]);
    for (const [ms, sd, d] of times.slice(0, 8)) console.log(`slow seed ${sd}: ${(ms / 1000).toFixed(1)} s ${d}`);
    const tot = times.reduce((a, b) => a + b[0], 0);
    console.log(`top 10% of seeds = ${((times.slice(0, Math.ceil(times.length / 10)).reduce((a, b) => a + b[0], 0) / tot) * 100).toFixed(0)}% of time`);
    console.log(`trajectories: rows=${rows} in ${s.toFixed(1)} s (${(rows / s).toFixed(1)} rows/s single thread), runCost ${(tj.costMs / 1000).toFixed(1)} s, drops=${JSON.stringify(drops)}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
