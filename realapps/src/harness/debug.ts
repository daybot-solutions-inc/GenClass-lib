// Development probe for one scenario:
//   node dist/harness/debug.js --app react-search --seed 3            ideal + base run summary, first situations
//   node dist/harness/debug.js --app react-search --seed 3 --twice    determinism: base run twice, compare
//   node dist/harness/debug.js --app react-search --seed 3 --traj     full trajectory (rows) for this seed
//   --show N   print N decision situations    --steps   print the session    --clean   clean scenario

import { createHash } from "node:crypto";
import { APPS } from "./apps.gen.js";
import { Runner } from "./browser.js";
import { states } from "./cost.js";
import { buildScenario } from "./scenario.js";
import { serveApps } from "./serve.js";
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
const port = Number(arg("port", String(8700 + (process.pid % 90))));
const server = await serveApps(join(HERE, "..", "apps"), port);
const runner = new Runner(port);
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
      const r1 = await runner.run(runConfig(sc, { runId: "d1", record: true, explore: sc.explore }));
      const r2 = await runner.run(runConfig(sc, { runId: "d2", record: true, explore: sc.explore }));
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
  server.close();
  process.exit(0);
}
const scn = buildScenario(seed, appName ? APPS.filter((a) => a.name === appName) : APPS, arg("clean") ? { clean: true } : {});
console.log(`app=${scn.app.name} split=${scn.split} chaos=${scn.chaos} variant=${JSON.stringify(scn.variant)} tEnd=${Math.round(scn.tEnd)} steps=${scn.steps.length} ext=${scn.external.length} budget=${scn.budget} explore=${scn.explore}`);
if (arg("steps")) for (const s of scn.steps) console.log(`  step ${s.i} t=${Math.round(s.t)} ${s.kind} ${s.sel}${s.text ? ` "${s.text}"` : ""}${s.value !== undefined ? ` value=${JSON.stringify(s.value)}` : ""}${s.accidental ? " ACCIDENTAL" : ""}${s.when ? ` when=${s.when}` : ""}`);
const hash = (x: unknown) => createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 12);
if (arg("traj")) {
  const t = await generateTrajectory(seed, APPS, runner, { maxPoints: 6, futures: 3, adaptive: true, testKeep: 1, ...(appName ? { apps: [appName] } : {}), ...(arg("clean") ? { clean: true } : {}) });
  console.log(`traj runs=${t.runs} realMs=${t.realMs} runMs=${t.runMs} decisions=${t.decisions} rows=${t.rows.length} drops=${JSON.stringify(t.drops)} skipped=${t.skipped ?? ""}`);
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
  console.log(`ideal ok=${ideal.ok} err=${ideal.error ?? ""} tasks=${ideal.tasks} realMs=${ideal.realMs} snaps=${ideal.snapshots.length} net=${ideal.net.length} steps=${ideal.stepsRun}/${ideal.stepsSkipped} internal=${ideal.internalErrors.slice(0, 3).join(" | ")}`);
  const base = await runner.run(runConfig(scn, { runId: "base", record: true, explore: scn.explore }));
  console.log(`base ok=${base.ok} err=${base.error ?? ""} tasks=${base.tasks} realMs=${base.realMs} snaps=${base.snapshots.length} net=${base.net.length} decisions=${base.decisions.length} steps=${base.stepsRun}/${base.stepsSkipped} ws=${base.wsMessages} uncaught=${base.uncaught.length} errEp=${base.errorEpisodes.length} internal=${base.internalErrors.slice(0, 3).join(" | ")}`);
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
    console.log(`---- #${d.k} t=${Math.round(d.t)} ${d.trigger} actions=${d.actions.join(",")} chosen=${d.chosen} diag=${d.diagnosis} (${d.diagWhy}) subject=${JSON.stringify(d.subject)}`);
    console.log(JSON.stringify(d.state, null, 1).slice(0, 2500));
  }
  if (arg("twice")) {
    const again = await runner.run(runConfig(scn, { runId: "base2", record: true, explore: scn.explore }));
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
server.close();
process.exit(0);
