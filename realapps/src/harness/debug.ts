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
/** --variant k=v[,k2=v2]: force feature flags (numbers and booleans parsed). */
function applyVariant(sc: { variant: Record<string, unknown>; patterns: string[]; app: { name: string } }): void {
  const v = process.argv[process.argv.indexOf("--variant") + 1];
  if (!process.argv.includes("--variant") || !v) return;
  for (const kv of v.split(",")) {
    const [k, raw] = kv.split("=");
    if (!k || raw === undefined) continue;
    const val: unknown = raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
    sc.variant[k] = val;
    sc.patterns = sc.patterns.filter((p) => !p.startsWith(`${sc.app.name}/${k}:`)).concat(`${sc.app.name}/${k}:${raw}`);
  }
}
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1] : "true";
};
const appName = arg("app");
const seed = Number(String(arg("seed", "1")).split("-")[0]);
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
      applyVariant(sc);
      const id0 = await runner.run(runConfig(sc, { runId: "d0", ideal: true }));
      const r1 = await runner.run(runConfig(sc, { runId: "d1", record: true, explore: sc.explore, pins: id0.pins ?? {}, altPicks: id0.altPicks ?? {} }));
      const r2 = await runner.run(runConfig(sc, { runId: "d2", record: true, explore: sc.explore, pins: id0.pins ?? {}, altPicks: id0.altPicks ?? {} }));
      n++;
      const same = r1.ok && r2.ok && hash2(r1.decisions.map((d) => d.fp)) === hash2(r2.decisions.map((d) => d.fp)) && hash2(r1.snapshots) === hash2(r2.snapshots) && hash2(r1.net) === hash2(r2.net) && hash2(r1.server) === hash2(r2.server);
      if (!same) {
        const la = r1.stepLog ?? [];
        const lb = r2.stepLog ?? [];
        const di = la.findIndex((x, j) => x !== lb[j]);
        if (di >= 0) console.log(`  first step difference: A ${la[di]} | B ${lb[di]}`);
        const na = r1.net.map((r) => `${Math.round(r.t0)} ${r.method} ${r.url}`);
        const nb = r2.net.map((r) => `${Math.round(r.t0)} ${r.method} ${r.url}`);
        const ni = na.findIndex((x, j) => x !== nb[j]);
        if (ni >= 0) {
          console.log(`  first net difference: A ${na[ni]} | B ${nb[ni]}`);
          const tt = Math.min(Number(na[ni]?.split(" ")[0] ?? 1e9), Number(nb[ni]?.split(" ")[0] ?? 1e9));
          const near = (l: string[]) => l.filter((x) => Math.abs(Number(x.split("@")[1]!.split(" ")[0]) - tt) < 4000);
          console.log(`  A steps near: ${near(la).join(" || ")}`);
          console.log(`  B steps near: ${near(lb).join(" || ")}`);
          console.log(`  A net near: ${na.filter((x) => Math.abs(Number(x.split(" ")[0]) - tt) < 4000).join(" || ")}`);
          console.log(`  B net near: ${nb.filter((x) => Math.abs(Number(x.split(" ")[0]) - tt) < 4000).join(" || ")}`);
        }
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
      applyVariant(sc);
      const id0 = await runner.run(runConfig(sc, { runId: "i0", ideal: true }));
      const obs = await runner.run(runConfig(sc, { runId: "obs", mode: "observe", pins: id0.pins ?? {}, altPicks: id0.altPicks ?? {} }));
      const heal = await runner.run(runConfig(sc, { runId: "heal", mode: "heal", pins: id0.pins ?? {}, altPicks: id0.altPicks ?? {} }));
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
        const na = obs.net.map((x) => `${Math.round(x.t0)} ${x.method} ${x.url}`);
        const nb = heal.net.map((x) => `${Math.round(x.t0)} ${x.method} ${x.url}`);
        const ni = na.findIndex((x, j) => x.split(" ").slice(1).join(" ") !== (nb[j] ?? "").split(" ").slice(1).join(" "));
        if (r.note.length < 2 && ni >= 0) r.note.push(`seed ${sd}: first differing request #${ni}: observe ${na[ni]} | heal ${nb[ni] ?? "-"}`);
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
const scn = buildScenario(seed, appName ? APPS.filter((a) => appName.split(",").includes(a.name)) : APPS, arg("clean") ? { clean: true } : {});
applyVariant(scn);
console.log(`app=${scn.app.name} split=${scn.split} chaos=${scn.chaos} variant=${JSON.stringify(scn.variant)} tEnd=${Math.round(scn.tEnd)} steps=${scn.steps.length} ext=${scn.external.length} budget=${scn.budget} explore=${scn.explore}`);
if (arg("steps")) for (const s of scn.steps) console.log(`  step ${s.i} t=${Math.round(s.t)} ${s.kind} ${s.sel}${s.text ? ` "${s.text}"` : ""}${s.value !== undefined ? ` value=${JSON.stringify(s.value)}` : ""}${s.accidental ? " ACCIDENTAL" : ""}${s.when ? ` when=${s.when}` : ""}`);
const hash = (x: unknown) => createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 12);
if (arg("traj") && (String(arg("seed", "1")).includes("-") || (appName ?? "").includes(","))) {
  // lists: --app a,b,c --seed 1-5 --traj  -> one summary line per (app, seed)
  const [s0, s1] = String(arg("seed", "1")).split("-").map(Number);
  let rows = 0;
  let dead = 0;
  let nearly = 0;
  let drops = 0;
  for (const a of (appName ?? "").split(",").filter(Boolean)) {
    for (let sd = s0!; sd <= (s1 ?? s0)!; sd++) {
      const t = await generateTrajectory(sd, APPS, runner, { maxPoints: 6, futures: 3, adaptive: true, testKeep: 1, apps: [a], ...(arg("clean") ? { clean: true } : {}) });
      const st = t.steps;
      const flag = !st ? "" : st.ran === 0 ? " DEAD SESSION" : st.skipped > 3 * st.ran && st.idealSkipped * 2 < st.ran + st.skipped ? " NEARLY DEAD" : "";
      if (flag.includes("DEAD SESSION")) dead++;
      if (flag.includes("NEARLY")) nearly++;
      rows += t.rows.length;
      drops += Object.values(t.drops).reduce((x, y) => x + y, 0);
      console.log(`${a} seed ${sd}: rows=${t.rows.length} decisions=${t.decisions} drops=${JSON.stringify(t.drops)} notes=${JSON.stringify(t.notes)} steps ran=${st?.ran} skipped=${st?.skipped} ${JSON.stringify(st?.why ?? {})} ideal-skipped=${st?.idealSkipped}${flag}${t.skipped ? ` skipped=${t.skipped}` : ""}`);
    }
  }
  console.log(`traj summary: rows=${rows} drops=${drops} dead=${dead} nearly-dead=${nearly}`);
  await runner.close();
  process.exit(0);
}
if (arg("traj")) {
  const t = await generateTrajectory(seed, APPS, runner, { maxPoints: 6, futures: 3, adaptive: true, testKeep: 1, ...(appName ? { apps: [appName] } : {}), ...(arg("clean") ? { clean: true } : {}) });
  const st = t.steps;
  console.log(`traj runs=${t.runs} realMs=${t.realMs} runMs=${t.runMs} decisions=${t.decisions} rows=${t.rows.length} drops=${JSON.stringify(t.drops)} notes=${JSON.stringify(t.notes)} skipped=${t.skipped ?? ""}`);
  if (st) console.log(`steps base ran=${st.ran} skipped=${st.skipped} ${JSON.stringify(st.why)}; ideal skipped=${st.idealSkipped} ${JSON.stringify(st.idealWhy)}${st.ran === 0 ? "  DEAD SESSION" : st.skipped > 3 * st.ran && st.idealSkipped * 2 < st.ran + st.skipped ? "  NEARLY DEAD (> 75% of base steps skipped, ideal healthy)" : ""}`);
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
  const base = await runner.run(runConfig(scn, { runId: "base", record: true, explore: scn.explore, pins: ideal.pins ?? {}, altPicks: ideal.altPicks ?? {}, ...(arg("ask-check") ? {} : { askTimes: scn.askTimes }), ...(arg("mode") ? { mode: String(arg("mode")) } : {}) }));
  console.log(`base ok=${base.ok} err=${base.error ?? ""} tasks=${base.tasks} realMs=${base.realMs} snaps=${base.snapshots.length} net=${base.net.length} decisions=${base.decisions.length} steps=${base.stepsRun}/${base.stepsSkipped} ${JSON.stringify(base.skipWhy ?? {})} ws=${base.wsMessages} uncaught=${base.uncaught.length} errEp=${base.errorEpisodes.length} internal=${base.internalErrors.slice(0, 3).join(" | ")}`);
  if (arg("steps")) {
    console.log(`ideal steps:\n  ${(ideal.stepLog ?? []).join("\n  ")}`);
    console.log(`base steps:\n  ${(base.stepLog ?? []).join("\n  ")}`);
  }
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
    const cf = await runner.run(runConfig(scn, { runId: "cf", forced, fpUpTo: Number(k), pins: ideal.pins ?? {}, altPicks: ideal.altPicks ?? {}, askTimes: scn.askTimes, tStop: Math.min(scn.tEnd, d.t + 15000) }));
    const cst = states(cf);
    const ist = states(ideal);
    const bst = states(base);
    for (const t of [d.t + 1000, d.t + 5000, d.t + 14000]) {
      const pick = (ss: typeof cst) => ss.filter((x) => x.t <= t).pop()?.dom.slice(0, 14).join(" | ");
      console.log(`@${Math.round(t)} ideal: ${pick(ist)}`);
      console.log(`@${Math.round(t)} base : ${pick(bst)}`);
      console.log(`@${Math.round(t)} ${a}: ${pick(cst)}`);
    }
    const cfd = cf.decisions.find((x) => x.k === Number(k));
    console.log(`prefix: base fp ${d.fp} cf fp ${cfd?.fp} ${cfd?.fp === d.fp ? "SAME" : "DIFFERENT"} (cf decisions ${cf.decisions.length})`);
    if (cfd && cfd.fp !== d.fp) console.log(`cf trigger: ${cfd.trigger} t=${Math.round(cfd.t)} subject=${JSON.stringify(cfd.subject)}`);
    console.log(`cf steps ${cf.stepsRun}/${cf.stepsSkipped} skippedAt ${JSON.stringify(cf.skippedAt)}; base skippedAt ${JSON.stringify(base.skippedAt)}; ideal skippedAt ${JSON.stringify(ideal.skippedAt)}`);
  }
  if (arg("ask-check")) {
    // runtime.situation("ask") must be side-effect free: the same run with and without ask probes
    const withAsk = await runner.run(runConfig(scn, { runId: "ask", record: true, explore: scn.explore, pins: ideal.pins ?? {}, askTimes: scn.askTimes }));
    const a = base.decisions.map((d) => d.fp);
    const b = withAsk.decisions.map((d) => d.fp);
    const i = a.findIndex((x, j) => x !== b[j]);
    console.log(`ask-check: probes at ${scn.askTimes.map(Math.round).join(",")}; decisions ${a.length} vs ${b.length}; first diff ${i}${i >= 0 ? ` at t=${Math.round(base.decisions[i]!.t)}` : ""}`);
    if (i >= 0) {
      console.log("without:", JSON.stringify(base.decisions[i]!.state).slice(0, 1500));
      console.log("with   :", JSON.stringify(withAsk.decisions[i]!.state).slice(0, 1500));
    }
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
