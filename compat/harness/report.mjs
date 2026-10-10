// Turns a compat results JSON into compat/RESULTS.md, the public compatibility page (genclass.dev/docs/compatibility).
// Also runnable on its own:  node compat/harness/report.mjs compat/results/<date>.json [out.md]
//
// Per (app, layer, scenario, seed) every mode is paired with `off` (GenClass installed, switched off by ?genclass=off).
//   observe ✓     every seed: final DOM and server state identical to a run without GenClass (off, or the control
//                 offR when the app is racy on that seed), no new console/page errors, model ready
//   guard/heal ✓  every seed: no bug introduced (oracle), identical to a run without GenClass wherever that was correct,
//                 no new errors,
//                 model ready
// A trial that did not complete, or a mode trial whose model never became ready, makes the cell ✗ (never hidden).

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { APPS } from "./apps.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const SC = Object.keys(SCENARIOS);
const MODE_ORDER = ["observe", "guard", "heal"];
const same = (a, b) => JSON.stringify({ d: a?.dom ?? null, s: a?.server ?? null }) === JSON.stringify({ d: b?.dom ?? null, s: b?.server ?? null });
const normErr = (e) => String(e).replace(/\d+/g, "#").replace(/https?:\/\/127\.0\.0\.1:#/g, "");
const isHydration = (e) => /hydrat|did not match|NG0?50\d|Text content does not match|server rendered|mismatch/i.test(e);
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "–");

function newErrors(m, o) {
  const base = new Set((o?.errors ?? []).map(normErr));
  return (m.errors ?? []).filter((e) => !base.has(normErr(e)));
}

function domDiff(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a?.dom ?? {}), ...Object.keys(b?.dom ?? {})])) {
    const x = JSON.stringify(a?.dom?.[k] ?? null);
    const y = JSON.stringify(b?.dom?.[k] ?? null);
    if (x !== y) out.push(`DOM ${k}: off ${y.slice(0, 120)} vs ${x.slice(0, 120)}`);
  }
  for (const k of new Set([...Object.keys(a?.server ?? {}), ...Object.keys(b?.server ?? {})])) {
    const x = JSON.stringify(a?.server?.[k] ?? null);
    const y = JSON.stringify(b?.server?.[k] ?? null);
    if (x !== y) out.push(`server ${k}: off ${y.slice(0, 120)} vs ${x.slice(0, 120)}`);
  }
  return out;
}

const nonPassive = (e) => e.k === "act" && e.tier !== "passive";

export function computeCells(results) {
  const by = new Map();
  for (const t of results.trials) by.set(`${t.app}|${t.layer}|${t.scenario}|${t.mode}|${t.seed}`, t);
  const cells = new Map();
  const seeds = [...new Set(results.trials.map((t) => t.seed))].sort((a, b) => a - b);
  const combos = new Set(results.trials.map((t) => `${t.app}|${t.layer}|${t.scenario}`));
  for (const combo of combos) {
    const [app, layer, scenario] = combo.split("|");
    const kind = SCENARIOS[scenario].kind;
    const offTrials = seeds.map((s) => by.get(`${combo}|off|${s}`)).filter(Boolean);
    const offCell = {
      app, layer, scenario, mode: "off", kind, runs: offTrials.length,
      failed: offTrials.filter((t) => !t.ok).length,
      bugs: offTrials.filter((t) => t.ok && t.bug).length,
      errors: offTrials.filter((t) => (t.errors ?? []).length).length,
      issues: [],
    };
    for (const t of offTrials) {
      if (!t.ok) offCell.issues.push(`seed ${t.seed}: trial failed: ${t.error}`);
      for (const e of t.errors ?? []) offCell.issues.push(`seed ${t.seed}: console/page error: ${e.slice(0, 200)}`);
    }
    offCell.pass = offCell.runs > 0 && offCell.failed === 0 && offCell.errors === 0;
    const ctl = seeds.map((s) => [by.get(`${combo}|offR|${s}`), by.get(`${combo}|off|${s}`), s]).filter(([r, o]) => r && o && r.ok && o.ok);
    offCell.controlRuns = ctl.length;
    offCell.controlEqual = ctl.filter(([r, o]) => same(r, o)).length;
    offCell.controlDiffs = ctl.filter(([r, o]) => !same(r, o)).map(([r, o, s]) => `seed ${s}: ${domDiff(r, o).slice(0, 3).join("; ")}`);
    cells.set(`${combo}|off`, offCell);
    for (const mode of MODE_ORDER) {
      const pairs = seeds.map((s) => [by.get(`${combo}|${mode}|${s}`), by.get(`${combo}|off|${s}`), s, by.get(`${combo}|offR|${s}`)]).filter(([m]) => m);
      if (!pairs.length) continue;
      const c = { app, layer, scenario, mode, kind, runs: pairs.length, failed: 0, notReady: 0, bugs: 0, fixed: 0, introduced: 0, equal: 0, equalControlOnly: 0, unequalClean: 0, newErrors: 0, detections: 0, decisions: 0, executed: 0, actions: {}, diagnoses: {}, issues: [], notes: [] };
      for (const [m, o, s, oR] of pairs) {
        if (!m.ok) {
          c.failed++;
          c.issues.push(`seed ${s}: trial failed: ${m.error}`);
          continue;
        }
        if (m.model?.state !== "ready") {
          c.notReady++;
          c.issues.push(`seed ${s}: model ${m.model?.state ?? "?"} (${m.model?.error ?? ""})`);
        }
        const ev = m.events ?? [];
        c.decisions += ev.filter((e) => e.k === "decide").length;
        const det = ev.filter((e) => e.k === "detect");
        c.detections += det.length;
        for (const e of det) c.diagnoses[`${e.trigger}:${e.diagnosis}`] = (c.diagnoses[`${e.trigger}:${e.diagnosis}`] ?? 0) + 1;
        const acts = ev.filter(nonPassive);
        c.executed += acts.length;
        for (const a of acts) {
          const k = `${a.trigger}:${a.action}${a.late ? " (late)" : ""}${a.ok ? "" : " (failed)"}`;
          c.actions[k] = (c.actions[k] ?? 0) + 1;
        }
        if (m.bug) c.bugs++;
        const gcErr = (m.genclassConsole ?? []).filter((l) => /^error/.test(l));
        const ne = o ? newErrors(m, o) : (m.errors ?? []);
        if (ne.length || gcErr.length) {
          c.newErrors++;
          c.issues.push(`seed ${s}: new console/page errors: ${[...ne, ...gcErr].slice(0, 3).map((e) => e.slice(0, 200)).join(" | ")}`);
        }
        if (!o || !o.ok) {
          c.issues.push(`seed ${s}: no valid off run to compare with`);
          c.failed++;
          continue;
        }
        // The baseline is both runs without GenClass on this seed (off and the control offR). When they disagree, the
        // app itself is racy on that seed: a mode run equal to either of them is what the app does without GenClass.
        const base = [o, oR].filter((b) => b && b.ok);
        const eqOff = same(m, o);
        const eq = base.some((b) => same(m, b));
        if (eq) c.equal++;
        if (eq && !eqOff) {
          c.equalControlOnly++;
          c.notes.push(`seed ${s}: differs from the first run without GenClass but equals the second (the app is racy on this seed: ${domDiff(oR, o).slice(0, 2).join("; ")})`);
        }
        const baseBug = base.every((b) => b.bug);
        const baseClean = base.every((b) => !b.bug);
        if (baseBug && !m.bug) {
          c.fixed++;
          if (acts.length) c.fixedByAction = (c.fixedByAction ?? 0) + 1;
          else c.fixedNoAction = (c.fixedNoAction ?? 0) + 1;
          c.notes.push(`seed ${s}: fixed (${acts.map((a) => `${a.trigger}:${a.action}`).join(", ") || "no action recorded"}); off: ${o.bug}`);
        }
        if (baseClean && m.bug) {
          c.introduced++;
          c.issues.push(`seed ${s}: bug introduced: ${m.bug}; actions: ${acts.map((a) => `${a.trigger}:${a.action} (${a.changed ?? ""})`).join(" / ") || "none"}`);
        }
        if (!eq && (mode === "observe" || baseClean)) {
          c.unequalClean++;
          if (!(baseClean && m.bug)) c.issues.push(`seed ${s}: differs from off: ${domDiff(m, o).slice(0, 4).join("; ")}; actions: ${acts.map((a) => `${a.trigger}:${a.action}`).join(", ") || "none"}`);
        }
        if (!eq && !baseClean && m.bug) c.notes.push(`seed ${s}: still buggy, but differs from off: ${m.bug}`);
      }
      c.pass = c.failed === 0 && c.notReady === 0 && c.newErrors === 0 && c.introduced === 0 && c.unequalClean === 0;
      cells.set(`${combo}|${mode}`, c);
    }
  }
  return cells;
}

/** Automatic state discovery per (app, layer): what rt.stores() reported at the end of each mode trial. */
export function discovery(results) {
  const out = new Map();
  for (const t of results.trials) {
    if (!t.ok || !MODE_ORDER.includes(t.mode)) continue;
    const k = `${t.app}|${t.layer}`;
    const d = out.get(k) ?? { trials: 0, withSource: {}, names: {}, writable: 0 };
    d.trials++;
    const sources = new Set((t.stores ?? []).filter((s) => s.source).map((s) => s.source));
    for (const s of sources) d.withSource[s] = (d.withSource[s] ?? 0) + 1;
    for (const s of t.stores ?? []) if (s.source) d.names[`${s.name} (${s.source}${s.kind === "observed" ? "" : `, ${s.kind}`})`] = 1;
    if ((t.stores ?? []).some((s) => s.source && s.kind !== "observed")) d.writable++;
    out.set(k, d);
  }
  return out;
}

const anchor = (...p) => p.join("-").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
const SOURCE_TEXT = { react: "React state", redux: "the Redux store", devtools: "the Zustand stores (devtools `connect`)" };

export function writeReport(results, { jsonPath, mdPath }) {
  const cells = computeCells(results);
  const disc = discovery(results);
  const L = [];
  const appsRun = Object.keys(results.apps);
  const rel = (p) => relative(dirname(mdPath), p);
  const m = results.meta;
  const trials = results.trials.length;
  const failedTrials = results.trials.filter((t) => !t.ok).length;
  const modeCells = [...cells.values()].filter((c) => c.mode !== "off");
  const passCells = modeCells.filter((c) => c.pass).length;
  const offCells = [...cells.values()].filter((c) => c.mode === "off");
  const layersRun = [];
  for (const name of appsRun) for (const layer of Object.keys(APPS[name]?.layers ?? {})) if (results.trials.some((t) => t.app === name && t.layer === layer)) layersRun.push([name, layer]);
  const legitCells = modeCells.filter((c) => c.kind === "legit");
  const introduced = modeCells.reduce((a, c) => a + c.introduced, 0);
  const fixed = modeCells.reduce((a, c) => a + c.fixed, 0);
  const bugRuns = (mode) => modeCells.filter((c) => c.mode === mode && c.kind === "bug");
  const offBugs = offCells.filter((c) => c.kind === "bug").reduce((a, c) => a + c.bugs, 0);
  const offBugRuns = offCells.filter((c) => c.kind === "bug").reduce((a, c) => a + c.runs, 0);
  const actsOnLegit = legitCells.filter((c) => c.mode !== "observe").reduce((a, c) => a + c.executed, 0);
  const legitActRuns = legitCells.filter((c) => c.mode !== "observe").reduce((a, c) => a + c.runs, 0);
  const obsLegit = legitCells.filter((c) => c.mode === "observe");
  const falseFindings = obsLegit.reduce((a, c) => a + c.detections, 0);
  const seedsN = m.seeds[1] - m.seeds[0] + 1;

  // ------------------------------------------------------------------------------------------------ intro
  L.push("# Compatibility");
  L.push("");
  L.push(
    `Does adding GenClass break your app? This page answers that for ${appsRun.length} small, idiomatic apps (${appsRun.map((n) => APPS[n]?.title ?? n).join("; ")}) and ${layersRun.length} data layers, each installed with the one line from the README and driven through the same eight scenarios in headless Chromium, ${seedsN} seed${seedsN === 1 ? "" : "s"} each, in every mode. It is generated by a script from a run on ${m.at.slice(0, 10)}; nothing here is edited by hand except the notes marked *Analysis*, and every ✗ is listed with its details below.`,
  );
  L.push("");
  L.push("**Summary**");
  L.push("");
  L.push(`- **${passCells} of ${modeCells.length}** (app × data layer × scenario × mode) cells are ✓: GenClass in that mode left the app as correct as it was without GenClass, on every seed. Observe mode (the default) must leave the final page and server state *identical* to a run without GenClass.${modeCells.some((c) => c.equalControlOnly) ? ` (Each seed runs twice without GenClass. Where those two runs differ, the app itself is racy on that seed, and a mode run equal to either counts as unchanged: ${modeCells.reduce((a, c) => a + c.equalControlOnly, 0)} mode runs, listed under [Determinism control](#determinism-control).)` : ""}`);
  L.push(`- **Bugs introduced: ${introduced}** across ${modeCells.reduce((a, c) => a + c.runs, 0)} mode runs. Non-passive actions on correct apps (scenarios c to h, guard + heal): **${actsOnLegit}** in ${legitActRuns} runs.`);
  const fixedBy = {};
  for (const c of modeCells) if (c.fixedByAction) fixedBy[`${c.mode}, ${APPS[c.app]?.layers[c.layer]?.title ?? c.layer} (${APPS[c.app]?.title ?? c.app}), scenario ${c.scenario}, ${Object.keys(c.actions).join(", ")}`] = c.fixedByAction;
  const fixedText = Object.entries(fixedBy).map(([k, v]) => `${v} × ${k}`).join("; ");
  const byAction = modeCells.reduce((a, c) => a + (c.fixedByAction ?? 0), 0);
  const noAction = modeCells.reduce((a, c) => a + (c.fixedNoAction ?? 0), 0);
  L.push(`- **Bugs fixed by an action: ${byAction}${fixedText ? ` (${fixedText})` : ""}.** The two scenarios with a latent bug (a stale typeahead, a double submit) showed it in ${offBugs} of ${offBugRuns} runs without GenClass; guard left ${bugRuns("guard").reduce((a, c) => a + c.bugs, 0)} and heal ${bugRuns("heal").reduce((a, c) => a + c.bugs, 0)} of the same runs buggy. GenClass acts only when its model is confident, and with the shipped model that is rare: it reports far more than it fixes (see [Model quality](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/packages/runtime/README.md#model-quality)).${noAction ? ` In ${noAction} more runs a bug of the app did not show with GenClass although GenClass took no action: GenClass changed the timing of a race in the app (listed at the end of the page).` : ""}`);
  // findings on correct apps: the ones about a failure the scenario injects on purpose, and the rest (false findings)
  let injected = 0;
  const falseBy = {};
  for (const c of obsLegit) {
    const inj = SCENARIOS[c.scenario].injects;
    for (const [k, v] of Object.entries(c.diagnoses)) {
      if (inj && k.startsWith(`${inj.trigger}:`)) injected += v;
      else falseBy[`${k} in ${c.scenario}`] = (falseBy[`${k} in ${c.scenario}`] ?? 0) + v;
    }
  }
  const falseN = Object.values(falseBy).reduce((a, v) => a + v, 0);
  const injWhat = Object.entries(SCENARIOS).filter(([, s]) => s.injects).map(([k, s]) => `${s.injects.what} in ${k}`).join(", ");
  L.push(`- **Observe-mode findings on correct apps: ${falseFindings}** in ${obsLegit.reduce((a, c) => a + c.runs, 0)} runs (scenarios c to h). ${injected} of them report the failure a scenario injects on purpose (${injWhat}), which the app handles correctly; **${falseN} are false findings** (${Object.entries(falseBy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(", ") || "none"}). Findings change nothing in observe mode; they are listed per cell in [What GenClass reported and did](#what-genclass-reported-and-did).`);
  L.push("");
  L.push(`Versions: \`@genclass/runtime\` ${m.runtime} packed from this repository${m.commit ? ` (commit \`${m.commit}\`)` : ""}, model \`${m.modelName ?? "?"}\` ${m.model ?? "?"} (the default model, WASM, balanced profile), headless Chromium ${m.chromium}, Node ${m.node}. Framework versions are in the first table.`);
  L.push("");

  // ------------------------------------------------------------------------------------------ frameworks
  L.push("## Frameworks");
  L.push("");
  L.push("Each app is built for production and served the way it would be in production (static files, `next start`, the SvelteKit Node adapter, Angular's SSR server). *Boots clean*: the model loads, fetch is instrumented, no console errors or GenClass warnings, no request leaves the machine. *Kill switch*: with `?genclass=off` nothing is installed (WebSocket, EventSource and timers are the browser's own, no model worker) and the app works. *Devtools*: the overlay mounts. *CSP*: the app still boots clean (model ready, no violation) under a Content-Security-Policy that adds only what the README asks for, sent with the HTML page (*page*) or with every response, scripts and the model worker included, as many production servers do (*every response*). *SSR*: the page is rendered on the server with GenClass installed, and importing the one line on the server returns an inert runtime (server `fetch` untouched, no globals added).");
  L.push("");
  L.push("| app | where the one line goes | versions | builds | boots clean | kill switch | devtools | CSP (page) | CSP (every response) | SSR inert | hydration errors |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const name of appsRun) {
    const a = results.apps[name];
    const b = a.boot ?? {};
    const v = Object.entries(a.versions ?? {}).filter(([, x]) => x).map(([k, x]) => `${k} ${x}`).join(", ");
    const yes = (x) => (x === undefined ? "–" : x ? "✓" : `[✗](#${anchor("boot", name)})`);
    const ib = a.error ? `[✗](#${anchor("boot", name)})` : ["install", "build", "serve"].some((k) => a.steps?.[k]?.ok === false) ? `[✗](#${anchor("boot", name)})` : "✓";
    const hyd = results.trials.filter((t) => t.app === name).flatMap((t) => (t.errors ?? []).filter(isHydration)).length;
    L.push(`| ${APPS[name]?.title ?? name} | ${a.install ?? APPS[name]?.install ?? ""} | ${v} | ${ib} | ${yes(b.boot?.pass)} | ${yes(b.killswitch?.pass)} | ${yes(b.devtools?.pass)} | ${yes(b.csp?.pass)} | ${yes(b.cspAll?.pass)} | ${APPS[name]?.ssr ? yes(b.ssr?.pass) : "–"} | ${APPS[name]?.ssr ? hyd : "–"} |`);
  }
  L.push("");
  L.push(`CSP used (bundled apps): \`${m.csp?.bundled ?? m.csp}\`. Script-tag app: \`${m.csp?.cdn ?? m.csp}\`.`);
  L.push("");

  // ------------------------------------------------------------------------------------------------ matrix
  L.push("## Never-worse matrix");
  L.push("");
  L.push("Each cell shows **observe · guard · heal** for one data layer and one scenario. ✓ means: on every seed, that mode left the app at least as correct as the same run without GenClass (observe: identical final DOM and server state; guard and heal: no bug introduced, and identical wherever the run without GenClass was correct; a seed runs twice without GenClass, and either run counts), with no new console errors and the model loaded. Click a ✗ for the details.");
  L.push("");
  L.push(`| app | data layer | ${SC.map((s) => `${s}`).join(" | ")} |`);
  L.push(`|---|---|${SC.map(() => "---").join("|")}|`);
  for (const [name, layer] of layersRun) {
    const row = SC.map((s) => {
      const ms = MODE_ORDER.map((mo) => cells.get(`${name}|${layer}|${s}|${mo}`));
      if (ms.every((c) => !c)) return "–";
      return ms.map((c, i) => (!c ? "–" : c.pass ? "✓" : `[✗](#${anchor(name, layer, s, MODE_ORDER[i])})`)).join(" · ");
    });
    L.push(`| ${APPS[name]?.title ?? name} | ${APPS[name].layers[layer].title} | ${row.join(" | ")} |`);
  }
  L.push("");
  L.push("### Scenarios");
  L.push("");
  L.push("Every app implements the same eight screens against the same seeded mock backend. Latency is drawn from the seed per request, so every mode of a seed sees the same network.");
  L.push("");
  L.push("| | scenario | what the runner does | the app is |");
  L.push("|---|---|---|---|");
  for (const [k, s] of Object.entries(SCENARIOS)) L.push(`| ${k} | ${s.name} | ${s.what} | ${s.kind === "bug" ? "written the common, naive way: it can show the bug" : "correct: GenClass must not change the outcome"} |`);
  L.push("");

  // ------------------------------------------------------------------------------------------- discovery
  L.push("## Automatic state discovery");
  L.push("");
  L.push("With the one line, GenClass looks for the app's state on its own (React, Redux, Zustand through the Redux DevTools API). Found state lets it compare a late response with newer data already on screen. Per data layer: what `runtime.stores()` reported at the end of each GenClass run.");
  L.push("");
  L.push("| app | data layer | the layer's state | found | stores seen (source) |");
  L.push("|---|---|---|---|---|");
  for (const [name, layer] of layersRun) {
    const d = disc.get(`${name}|${layer}`);
    const want = APPS[name].layers[layer].discovery;
    const names = Object.keys(d?.names ?? {});
    const shown = names.length ? `${names.slice(0, 6).join(", ")}${names.length > 6 ? `, … (${names.length})` : ""}` : "none";
    let found;
    if (!d) found = "–";
    else if (want) {
      const n = d.withSource[want] ?? 0;
      found = n === d.trials ? `✓ ${SOURCE_TEXT[want]} (${n}/${d.trials} runs)` : `✗ ${SOURCE_TEXT[want]} in ${n}/${d.trials} runs ([why](#${anchor("discovery", name, layer)}))`;
    } else found = `not covered${d.withSource.react ? ` (React component state found in ${d.withSource.react}/${d.trials} runs)` : ""}`;
    const what = want ? SOURCE_TEXT[want] : layer === "tanstack" ? "TanStack Query cache" : layer === "swr" ? "SWR cache" : layer === "apollo" ? "Apollo cache" : layer === "pinia" ? "Pinia stores" : layer === "stores" ? "Svelte stores" : layer === "signals" ? "Solid signals" : name === "angular" ? "Angular signals" : "plain objects / the DOM";
    L.push(`| ${APPS[name]?.title ?? name} | ${APPS[name].layers[layer].title} | ${what} | ${found} | ${shown} |`);
  }
  L.push("");
  L.push("*Not covered* means the README does not claim discovery for that kind of state: GenClass then sees the network and user input, and decisions that depend on the app's state are not made. With TanStack Query, SWR and Apollo the cache itself is not a store, but the React component state GenClass finds includes what each component reads from it (the `useQuery` / `useSWR` result: data and status), observed only. Production builds minify component names, so React stores are named after an element the component renders (`compat` is the page root's `id`).");
  L.push("");

  // ------------------------------------------------------------------------------- detections and actions
  L.push("## What GenClass reported and did");
  L.push("");
  L.push("Per cell: user-visible bugs without GenClass (`off`, out of the seeds run) and in each mode, then observe detections / guard actions / heal actions summed over seeds. A bug is what a user would see (stale results, a duplicate on the server, a lost note); oracles read only the page and the mock server's state, never GenClass. *Fixed*: buggy without GenClass, correct in the mode (same seed). *Introduced*: correct without GenClass, buggy in the mode. In guard and heal GenClass may hold a response for a moment while its model decides (observe never does); on a seed that was already buggy this can change which stale answer ends up on screen without fixing it (listed at the end of the page).");
  L.push("");
  L.push(`| app | data layer | ${SC.join(" | ")} |`);
  L.push(`|---|---|${SC.map(() => "---").join("|")}|`);
  for (const [name, layer] of layersRun) {
    const row = SC.map((s) => {
      const off = cells.get(`${name}|${layer}|${s}|off`);
      if (!off) return "–";
      const o = cells.get(`${name}|${layer}|${s}|observe`);
      const g = cells.get(`${name}|${layer}|${s}|guard`);
      const h = cells.get(`${name}|${layer}|${s}|heal`);
      const bugs = [`off ${off.bugs}/${off.runs}`, g ? `g ${g.bugs}${g.fixed ? ` (fixed ${g.fixed})` : ""}${g.introduced ? ` (**introduced ${g.introduced}**)` : ""}` : null, h ? `h ${h.bugs}${h.fixed ? ` (fixed ${h.fixed})` : ""}${h.introduced ? ` (**introduced ${h.introduced}**)` : ""}` : null].filter(Boolean).join(", ");
      return `${off.kind === "bug" || off.bugs || g?.bugs || h?.bugs ? `bugs ${bugs}<br>` : ""}${o?.detections ?? "–"} / ${g?.executed ?? "–"} / ${h?.executed ?? "–"}`;
    });
    L.push(`| ${APPS[name]?.title ?? name} | ${layer} | ${row.join(" | ")} |`);
  }
  L.push("");
  const acted = modeCells.filter((c) => Object.keys(c.actions).length || Object.keys(c.diagnoses).length);
  if (acted.length) {
    L.push("<details><summary>Every detection and action (trigger:diagnosis, trigger:action)</summary>");
    L.push("");
    for (const c of acted) {
      const d = Object.entries(c.diagnoses).map(([k, v]) => `${k} ×${v}`).join(", ");
      const a = Object.entries(c.actions).map(([k, v]) => `${k} ×${v}`).join(", ");
      L.push(`- ${c.app} / ${c.layer} / ${c.scenario} / ${c.mode}: ${d ? `detections ${d}` : ""}${d && a ? "; " : ""}${a ? `actions ${a}` : ""}`);
    }
    L.push("");
    L.push("</details>");
    L.push("");
  }

  // ---------------------------------------------------------------------------------------- determinism
  const ctl = offCells.filter((c) => c.controlRuns);
  if (ctl.length) {
    const eqc = ctl.reduce((a, c) => a + c.controlEqual, 0);
    const n = ctl.reduce((a, c) => a + c.controlRuns, 0);
    L.push("## Determinism control");
    L.push("");
    L.push(`Every seed also ran twice without GenClass. ${eqc} of ${n} pairs (${pct(eqc, n)}) ended identical (final DOM and server state), so a difference between a mode and \`off\` is almost always a real difference${eqc < n ? ". The exceptions below are races in the apps themselves (they also happen without GenClass); in those seeds a mode run is compared with both runs without GenClass" : ""}.`);
    L.push("");
    for (const c of ctl.filter((x) => x.controlEqual < x.controlRuns)) L.push(`- ${c.app} / ${c.layer} / ${c.scenario}: ${c.controlEqual}/${c.controlRuns} identical (${c.controlDiffs.slice(0, 2).join(" | ").slice(0, 400)})`);
    if (eqc < n) L.push("");
  }

  // -------------------------------------------------------------------------------------------- details
  L.push("## Details for every ✗");
  L.push("");
  // Optional analysis written after the run by whoever investigated a ✗ (<json>.notes.json: { "<anchor>": "text" }).
  // It is labelled as such and never changes a ✓ or ✗.
  let notes = {};
  try {
    notes = JSON.parse(readFileSync(jsonPath.replace(/\.json$/, ".notes.json"), "utf8"));
  } catch {
    /* no notes */
  }
  const analysis = (key) => {
    if (!notes[key]) return;
    L.push(`*Analysis (written after the run):* ${notes[key]}`);
    L.push("");
  };
  let any = false;
  for (const name of appsRun) {
    const a = results.apps[name];
    const b = a.boot ?? {};
    const bad = ["boot", "killswitch", "devtools", "csp", "cspAll", "ssr"].filter((k) => b[k] && !b[k].pass);
    if (a.error || bad.length || ["install", "build", "serve"].some((k) => a.steps?.[k]?.ok === false)) {
      any = true;
      L.push(`### ${anchor("boot", name)}`);
      L.push("");
      if (a.error) L.push("```\n" + a.error.slice(0, 1500) + "\n```");
      for (const k of ["install", "build", "serve"]) if (a.steps?.[k]?.ok === false) L.push(`${k} failed:\n\n\`\`\`\n${(a.steps[k].out ?? a.steps[k].error ?? "").slice(-1500)}\n\`\`\``);
      for (const k of bad) L.push(`- ${k}: \`${JSON.stringify({ ...b[k], genclass: undefined, stores: undefined }).slice(0, 900)}\``);
      L.push("");
    }
  }
  for (const [name, layer] of layersRun) {
    const d = disc.get(`${name}|${layer}`);
    const want = APPS[name].layers[layer].discovery;
    if (!d || !want || (d.withSource[want] ?? 0) === d.trials) continue;
    any = true;
    L.push(`### ${anchor("discovery", name, layer)}`);
    L.push("");
    L.push(`${APPS[name].title} / ${APPS[name].layers[layer].title}: ${SOURCE_TEXT[want]} was found in ${d.withSource[want] ?? 0} of ${d.trials} runs. Stores seen: ${Object.keys(d.names).join(", ") || "none"}.`);
    L.push("");
    analysis(anchor("discovery", name, layer));
  }
  for (const c of modeCells.filter((x) => !x.pass)) {
    any = true;
    L.push(`### ${anchor(c.app, c.layer, c.scenario, c.mode)}`);
    L.push("");
    L.push(`${APPS[c.app]?.title ?? c.app} / ${APPS[c.app]?.layers[c.layer]?.title ?? c.layer} / scenario ${c.scenario} (${SCENARIOS[c.scenario].name}) / ${c.mode}: ${c.runs} runs, ${c.failed} incomplete, ${c.notReady} model not ready, ${c.introduced} bugs introduced, ${c.unequalClean} ${c.mode === "observe" ? "not identical to the runs without GenClass" : "differ from a correct run without GenClass"}, ${c.newErrors} with new console errors.`);
    L.push("");
    for (const i of c.issues.slice(0, 12)) L.push(`- ${i.replace(/\n/g, " ").replace(/\|/g, "\\|").slice(0, 600)}`);
    L.push("");
    analysis(anchor(c.app, c.layer, c.scenario, c.mode));
  }
  for (const c of offCells.filter((x) => !x.pass)) {
    any = true;
    L.push(`### off: ${c.app} / ${c.layer} / ${c.scenario}`);
    L.push("");
    L.push("The run without GenClass had console errors or did not complete (the app or the harness, not GenClass):");
    L.push("");
    for (const i of c.issues.slice(0, 8)) L.push(`- ${i.replace(/\n/g, " ").replace(/\|/g, "\\|").slice(0, 600)}`);
    L.push("");
  }
  if (!any) L.push("None.");
  L.push("");
  const fixedNotes = modeCells.filter((c) => c.notes.length);
  if (fixedNotes.length) {
    L.push("<details><summary>Fixes and changed outcomes on buggy seeds</summary>");
    L.push("");
    for (const c of fixedNotes) for (const n of c.notes.slice(0, 6)) L.push(`- ${c.app} / ${c.layer} / ${c.scenario} / ${c.mode}: ${n.slice(0, 400)}`);
    L.push("");
    L.push("</details>");
    L.push("");
  }

  // ------------------------------------------------------------------------------------------------ method
  L.push("## Method");
  L.push("");
  L.push(`- **Apps.** One small app per framework under [\`compat/apps/\`](https://github.com/daybot-solutions-inc/GenClass-lib/tree/main/compat/apps), written idiomatically for each data layer (no GenClass API anywhere: only the one line). They install \`@genclass/runtime\` from a tarball packed from this repository (\`npm pack\`), so the matrix tests the code as it would be published.`);
  L.push("- **Backend.** One seeded mock server for every app ([`compat/harness/backend.mjs`](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/compat/harness/backend.mjs)): REST, a GraphQL endpoint, a WebSocket and EventSource streams on the app's own origin. It injects latency and failures per scenario; nothing in it knows about GenClass.");
  L.push("- **A trial.** A fresh browser context loads the page (`?genclass=off` for the run without GenClass; otherwise the mode through `window.GENCLASS_CONFIG`, telemetry off), waits until the model is ready, drives the scenario with real (trusted) keyboard and mouse input, waits until nothing is in flight and the page has been quiet for 0.9 s, then reads the page and the server's state.");
  L.push(`- **Pairing.** Every mode run is compared with the run without GenClass on the same seed. ${seedsN} seeds per cell, plus a second run without GenClass per seed as a determinism control.`);
  L.push("- **Isolation.** Every request to another host is blocked and counted; the model files and ONNX Runtime are served from a local copy of the files the runtime would fetch from jsDelivr, and the script-tag app gets the packed tarball in place of the CDN.");
  L.push("- **Not tuned.** The runtime and the model are not changed or tuned for these apps, and the apps are not used for training.");
  L.push("- **Limits.** Small apps, one machine, headless Chromium only (no Firefox or Safari), WASM inference (no GPU), production builds only. Each cell has few seeds; read single differences as signals to investigate, not rates.");
  L.push("");
  L.push("## Reproduce");
  L.push("");
  L.push("On Linux with Node ≥ 22.22.3 (Angular 22's minimum) and about 4 GB free:");
  L.push("");
  L.push("```bash");
  L.push("git clone https://github.com/daybot-solutions-inc/GenClass-lib && cd GenClass-lib");
  L.push("npm ci && (cd compat && npm install && npx playwright install --with-deps chromium)");
  L.push("node packages/runtime/bin/genclass-runtime.mjs fetch-model .cache-model/runtime-model-0.2.0 --variant q8 --ort wasm");
  L.push(`COMPAT_MODEL_DIR=$PWD/.cache-model/runtime-model-0.2.0 npm --prefix compat run compat -- --seeds ${seedsN}`);
  L.push("```");
  L.push("");
  L.push(`This rebuilds the runtime, packs it, installs it into every app, builds and serves each app, runs every trial and writes \`compat/results/<date>.json\` and this page. \`--apps\`, \`--layers\`, \`--scenarios\`, \`--modes\` and \`--workers\` narrow a run. This page was generated from [\`${basename(jsonPath)}\`](${rel(jsonPath)}) (${trials} trials, ${failedTrials} did not complete; ${m.workers} parallel browsers).`);
  L.push("");
  writeFileSync(mdPath, L.join("\n"));
  return { summary: `${passCells}/${modeCells.length} mode cells pass; ${failedTrials} incomplete trials of ${trials}`, cells };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const jsonPath = process.argv[2];
  const results = JSON.parse(readFileSync(jsonPath, "utf8"));
  const here = dirname(fileURLToPath(import.meta.url));
  const r = writeReport(results, { jsonPath, mdPath: process.argv[3] ?? join(here, "..", "RESULTS.md") });
  console.log(r.summary);
}
