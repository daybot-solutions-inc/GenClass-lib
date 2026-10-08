// Development probe for one scenario:
//   node dist/harness/debug.js --app react-search --seed 3            ideal + base run summary, first situations
//   node dist/harness/debug.js --app react-search --seed 3 --twice    determinism: base run twice, compare
//   node dist/harness/debug.js --app react-search --seed 3 --traj     full trajectory (rows) for this seed
//   --show N   print N decision situations    --steps   print the session    --clean   clean scenario

import { createHash } from "node:crypto";
import { APPS } from "./apps.gen.js";
import { Runner } from "./browser.js";
import { serverDist, states } from "./cost.js";
import { buildScenario } from "./scenario.js";
import { generateTrajectory, runConfig } from "./trajectory.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : "true";
};
const appName = arg("app");
const seed = Number(arg("seed", "1"));
const runner = new Runner(0);
await runner.start();
if (arg("det")) {
  // determinism sweep: base run twice per seed, every app (or --app), report any difference
  const [a0, b0] = String(arg("det")).split("-").map(Number);
  const pool = appName ? APPS.filter((a) => appName.split(",").includes(a.name)) : APPS;
  const hash2 = (x: unknown) => createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 12);
  let bad = 0;
  let n = 0;
  for (let sd = a0!; sd <= b0!; sd++) {
    for (const app of pool) {
      const sc = buildScenario(sd, [app]);
      const id0 = await runner.run(runConfig(sc, { runId: "d0", ideal: true }));
      const r1 = await runner.run(runConfig(sc, { runId: "d1", record: true, explore: sc.explore, pins: id0.pins ?? {} }));
      const r2 = await runner.run(runConfig(sc, { runId: "d2", record: true, explore: sc.explore, pins: id0.pins ?? {} }));
      n++;
      const same = r1.ok && r2.ok && hash2(r1.decisions.map((d) => d.fp)) === hash2(r2.decisions.map((d) => d.fp)) && hash2(r1.snapshots) === hash2(r2.snapshots) && hash2(r1.net) === hash2(r2.net) && hash2(r1.server) === hash2(r2.server);
      if (!same) {
        bad++;
        console.log(`MISMATCH app=${app.name} seed=${sd} ok=${r1.ok}/${r2.ok} decisions=${r1.decisions.length}/${r2.decisions.length} err=${r1.error ?? ""}${r2.error ?? ""}`);
      }
    }
  }
  console.log(`determinism: ${n - bad}/${n} identical`);
  await runner.close();
  process.exit(0);
}
if (arg("interference")) {
  // GenClass must not change an app when its model always picks the passive action: compare the same scenario with
  // the runtime in observe mode (never changes execution) and in heal mode with an all-passive decider.
  const [a0, b0] = String(arg("interference")).split("-").map(Number);
  const pool = appName ? APPS.filter((a) => appName.split(",").includes(a.name)) : APPS;
  const per: Record<string, { n: number; diff: number; dom: number; server: number; note: string[] }> = {};
  for (let sd = a0!; sd <= b0!; sd++) {
    for (const app of pool) {
      const sc = buildScenario(sd, [app], arg("clean") ? { clean: true } : {});
      const id0 = await runner.run(runConfig(sc, { runId: "i0", ideal: true }));
      const obs = await runner.run(runConfig(sc, { runId: "obs", mode: "observe", pins: id0.pins ?? {} }));
      const heal = await runner.run(runConfig(sc, { runId: "heal", mode: "heal", pins: id0.pins ?? {} }));
      const r = (per[app.name] ??= { n: 0, diff: 0, dom: 0, server: 0, note: [] });
      r.n++;
      const so = states(obs);
      const sh = states(heal);
      const fo = so[so.length - 1]!;
      const fh = sh[sh.length - 1]!;
      const domDiff = JSON.stringify(fo.dom) !== JSON.stringify(fh.dom);
      // content comparison (timestamps ignored): holds shift createdAt/updatedAt without changing what was stored
      const srvDiff = serverDist(obs.server, heal.server) > 0;
      if (domDiff || srvDiff) {
        r.diff++;
        if (domDiff) r.dom++;
        if (srvDiff) r.server++;
        if (r.note.length < 2) r.note.push(`seed ${sd}: steps ${obs.stepsRun}/${obs.stepsSkipped} vs ${heal.stepsRun}/${heal.stepsSkipped}; dom ${fo.dom.length} vs ${fh.dom.length} lines`);
      }
    }
  }
  let tot = 0;
  let bad = 0;
  for (const [a, r] of Object.entries(per)) {
    tot += r.n;
    bad += r.diff;
    console.log(`${a.padEnd(28)} ${r.diff}/${r.n} changed (dom ${r.dom}, server ${r.server}) ${r.note.join(" | ")}`);
  }
  console.log(`interference: ${bad}/${tot} runs changed by GenClass with an all-passive model`);
  await runner.close();
  process.exit(0);
}
const scn = buildScenario(seed, appName ? APPS.filter((a) => a.name === appName) : APPS, arg("clean") ? { clean: true } : {});
console.log(`app=${scn.app.name} split=${scn.split} chaos=${scn.chaos} variant=${JSON.stringify(scn.variant)} tEnd=${Math.round(scn.tEnd)} steps=${scn.steps.length} ext=${scn.external.length} budget=${scn.budget} explore=${scn.explore}`);
if (arg("steps")) for (const s of scn.steps) console.log(`  step ${s.i} t=${Math.round(s.t)} ${s.kind} ${s.sel}${s.text ? ` "${s.text}"` : ""}${s.value !== undefined ? ` value=${JSON.stringify(s.value)}` : ""}${s.accidental ? " ACCIDENTAL" : ""}${s.when ? ` when=${s.when}` : ""}`);
const hash = (x: unknown) => createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 12);
if (arg("traj")) {
  const t = await generateTrajectory(seed, APPS, runner, { maxPoints: 6, futures: 3, adaptive: true, testKeep: 1, ...(appName ? { apps: [appName] } : {}), ...(arg("clean") ? { clean: true } : {}) });
  const st = t.steps;
  console.log(`traj runs=${t.runs} realMs=${t.realMs} runMs=${t.runMs} decisions=${t.decisions} rows=${t.rows.length} drops=${JSON.stringify(t.drops)} notes=${JSON.stringify(t.notes)} skipped=${t.skipped ?? ""}`);
  if (st) console.log(`steps base ran=${st.ran} skipped=${st.skipped} ${JSON.stringify(st.why)}; ideal skipped=${st.idealSkipped} ${JSON.stringify(st.idealWhy)}${st.ran === 0 ? "  DEAD SESSION" : ""}`);
  for (const p of t.points) console.log(`   ${p.trigger} diag=${p.diagnosis} best=${p.best} npm=${p.nonPassiveMass} harm=${JSON.stringify(p.harm)} gain=${p.gain} K=${p.futures}`);
  for (const r of t.rows.slice(0, Number(arg("show", "3")))) {
    console.log("----", r.id, JSON.stringify(r.labels), JSON.stringify((r.meta as Record<string, unknown>).costs), (r.meta as Record<string, unknown>).diag_why);
    console.log(JSON.stringify(r.state, null, 1).slice(0, 3000));
  }
} else {
  const ideal = await runner.run(runConfig(scn, { runId: "ideal", ideal: true }));
  if (arg("dom-at")) {
    const ist = states(ideal);
    for (const t of String(arg("dom-at")).split(",").map(Number)) {
      const s0 = ist.filter((x) => x.t <= t).pop();
      console.log(`ideal dom@${t}: ${s0?.dom.slice(0, 40).join(" | ")}`);
    }
    for (const r of ideal.net.slice(0, 30)) console.log(`  net ${Math.round(r.t0)} ${r.method} ${r.url} -> ${r.status ?? r.outcome}`);
  }
  console.log(`ideal ok=${ideal.ok} err=${ideal.error ?? ""} tasks=${ideal.tasks} realMs=${ideal.realMs} snaps=${ideal.snapshots.length} net=${ideal.net.length} steps=${ideal.stepsRun}/${ideal.stepsSkipped} ${JSON.stringify(ideal.skipWhy ?? {})} internal=${ideal.internalErrors.slice(0, 3).join(" | ")}`);
  const base = await runner.run(runConfig(scn, { runId: "base", record: true, explore: scn.explore, pins: ideal.pins ?? {}, ...(arg("mode") ? { mode: String(arg("mode")) } : {}) }));
  console.log(`base ok=${base.ok} err=${base.error ?? ""} tasks=${base.tasks} realMs=${base.realMs} snaps=${base.snapshots.length} net=${base.net.length} decisions=${base.decisions.length} steps=${base.stepsRun}/${base.stepsSkipped} ${JSON.stringify(base.skipWhy ?? {})} ws=${base.wsMessages} uncaught=${base.uncaught.length} errEp=${base.errorEpisodes.length} internal=${base.internalErrors.slice(0, 3).join(" | ")}`);
  const trig: Record<string, number> = {};
  const diag: Record<string, number> = {};
  for (const d of base.decisions) {
    trig[d.trigger] = (trig[d.trigger] ?? 0) + 1;
    diag[`${d.trigger}:${d.diagnosis ?? "?"}(${d.diagWhy})`] = (diag[`${d.trigger}:${d.diagnosis ?? "?"}(${d.diagWhy})`] ?? 0) + 1;
  }
  console.log("triggers", JSON.stringify(trig));
  console.log("diagnoses", JSON.stringify(diag));
  const corr = base.net.filter((r) => r.rtOp !== undefined).length;
  console.log(`net correlated ${corr}/${base.net.length}; user-rooted ${base.net.filter((r) => r.step !== undefined).length}`);
  const st = states(base);
  console.log(`final stores: ${JSON.stringify(st[st.length - 1]!.stores).slice(0, 600)}`);
  console.log(`final dom: ${st[st.length - 1]!.dom.slice(0, 12).join(" | ")}`);
  for (const d of base.decisions.slice(0, Number(arg("show", "2")))) {
    console.log(`---- #${d.k} t=${Math.round(d.t)} ${d.trigger} actions=${d.actions.join(",")} chosen=${d.chosen} diag=${d.diagnosis} (${d.diagWhy}${d.diagTrace ? ` ${d.diagTrace}` : ""}) subject=${JSON.stringify(d.subject)}`);
    console.log(JSON.stringify(d.state, null, 1).slice(0, 2500));
  }
  if (arg("force")) {
    // run the counterfactual with action A forced at decision K (--force K:A) and print its DOM over time
    const [k, a] = String(arg("force")).split(":");
    const d = base.decisions[Number(k)]!;
    const forced: [number, string][] = [...base.decisions.filter((x) => x.k < Number(k) && x.explored).map((x) => [x.k, x.chosen] as [number, string]), [Number(k), a!]];
    const cf = await runner.run(runConfig(scn, { runId: "cf", forced, fpUpTo: Number(k), pins: ideal.pins ?? {}, tStop: Math.min(scn.tEnd, d.t + 15000) }));
    const cst = states(cf);
    const ist = states(ideal);
    const bst = states(base);
    for (const t of [d.t + 1000, d.t + 5000, d.t + 14000]) {
      const pick = (ss: typeof cst) => ss.filter((x) => x.t <= t).pop()?.dom.slice(0, 14).join(" | ");
      console.log(`@${Math.round(t)} ideal: ${pick(ist)}`);
      console.log(`@${Math.round(t)} base : ${pick(bst)}`);
      console.log(`@${Math.round(t)} ${a}: ${pick(cst)}`);
    }
    console.log(`cf steps ${cf.stepsRun}/${cf.stepsSkipped} skippedAt ${JSON.stringify(cf.skippedAt)}; base skippedAt ${JSON.stringify(base.skippedAt)}; ideal skippedAt ${JSON.stringify(ideal.skippedAt)}`);
  }
  if (arg("twice")) {
    const again = await runner.run(runConfig(scn, { runId: "base2", record: true, explore: scn.explore, pins: ideal.pins ?? {} }));
    const a = base.decisions.map((d) => d.fp);
    const b = again.decisions.map((d) => d.fp);
    let firstDiff = -1;
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      if (a[i] !== b[i]) {
        firstDiff = i;
        break;
      }
    console.log(`determinism: decisions ${a.length} vs ${b.length}, first diff ${firstDiff}; snapshots ${hash(base.snapshots)} vs ${hash(again.snapshots)}; net ${hash(base.net)} vs ${hash(again.net)}; server ${hash(base.server)} vs ${hash(again.server)}`);
    if (firstDiff >= 0) {
      console.log("A:", JSON.stringify(base.decisions[firstDiff]?.state).slice(0, 1500));
      console.log("B:", JSON.stringify(again.decisions[firstDiff]?.state).slice(0, 1500));
    }
  }
}
console.log(`runner: ${runner.totalRuns} runs, ${runner.realMs} ms, phases ${JSON.stringify(runner.phases)}`);
await runner.close();
process.exit(0);
