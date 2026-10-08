// One trajectory = one scenario: ideal run (intended outcome) -> base run on the real runtime with exploration
// (records every decision's state/questions) -> for sampled decision points k and each applicable action a: a
// counterfactual run with the base run's explored choices before k, `a` forced at k and the passive action after
// k, over up to K paired futures -> cost -> soft action label (sim's actionLabel) and diagnosis. Each
// counterfactual must reproduce the base run's decisions 0..k byte for byte (prefix check), else it is dropped.

import { actionLabel, TIER, W } from "../../../sim/src/oracle/cost.js";
import { hashAll, Rng } from "../../../sim/src/rng.js";
import { transformQuestions } from "../../../sim/src/run/transform.js";
import { askQuestions } from "../../../sim/src/ask/questions.js";
import type { Runner } from "./browser.js";
import { runCost, states, type CostBreakdown, type State } from "./cost.js";
import { diagnosisFromOutcome, finishDiagnosis, S1_GAP } from "./labels.js";
import { buildScenario, type Scenario } from "./scenario.js";
import type { AppManifest } from "../shared/manifest.js";
import type { DecisionRec, RunConfig, RunResult } from "../shared/types.js";

import { PASSIVE as RT_PASSIVE } from "@rt/questions";
import { readFileSync, existsSync } from "node:fs";
import { DIST } from "./browser.js";
import { join } from "node:path";

/** Passive action per trigger from the runtime build in use; unknown triggers: the first offered action. */
export const PASSIVE: Record<string, string> = { ...(RT_PASSIVE as Record<string, string>) };
const passiveOf = (t: string, actions: string[]) => PASSIVE[t] || actions[0]!;
/** Runtime tag the apps were built with (build.mjs: RW_RUNTIME_TAG). */
export const RUNTIME_TAG = existsSync(join(DIST, "runtime-tag.txt")) ? readFileSync(join(DIST, "runtime-tag.txt"), "utf8").trim() : "unknown";
const TRIGGER_W: Record<string, number> = { mutation: 1, request: 1, failure: 1.6, stall: 2.2, inconsistency: 3, transition: 3, error: 2.2 };
// real observers (perf off: long-task timing is real time); the harness's input events are synthetic
export const OBSERVE = { fetch: true, xhr: true, user: true, errors: true, nav: true, storage: true, perf: false, websocket: true, timers: true, untrustedEvents: true };

export interface Row {
  id: string;
  split: string;
  family: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  labels: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface PointStat {
  trigger: string;
  diagnosis?: string;
  best: string;
  passiveBest: boolean;
  harm: Record<string, number>;
  nonPassiveMass: number;
  gain: number;
  futures: number;
  split: string;
  app: string;
}

export interface TrajectoryOut {
  seed: number;
  app: string;
  split: string;
  rows: Row[];
  points: PointStat[];
  drops: Record<string, number>;
  notes: Record<string, number>;
  /** Base-run steps that ran / were skipped (by reason), and the ideal run's skips: dead sessions show up here. */
  steps?: { ran: number; skipped: number; why: Record<string, number>; idealSkipped: number; idealWhy: Record<string, number> };
  runs: number;
  decisions: number;
  realMs: number;
  runMs: number;
  skipped?: string;
}

export interface GenOptions {
  maxPoints: number;
  futures: number;
  adaptive: boolean;
  testKeep: number;
  /** Only these apps (names). */
  apps?: string[];
  clean?: boolean;
  /** Unlabeled rows per trajectory (default 40; 0 = none). */
  unlabeled?: number;
  /** Developer-question rows from ask probes (default true). */
  ask?: boolean;
}

export function runConfig(scn: Scenario, o: Partial<RunConfig> & { runId: string }): RunConfig {
  return {
    seed: scn.seed,
    app: scn.app.name,
    ideal: false,
    forced: [],
    explore: 0,
    record: false,
    fpUpTo: -1,
    tStop: scn.tEnd,
    snapFrom: 0,
    server: scn.app.server,
    net: o.ideal ? { ...scn.net, ideal: true } : scn.net,
    steps: scn.steps,
    external: scn.external,
    vocab: scn.vocab,
    budget: scn.budget,
    modelMs: scn.modelMs,
    variant: scn.variant,
    domRoot: scn.app.domRoot ?? "body",
    errorSelector: scn.app.errorSelector ?? "[role=alert]",
    epoch: scn.epoch,
    observe: OBSERVE,
    ...(scn.app.weights ? { weights: scn.app.weights } : {}),
    integration: scn.app.integration,
    loadAt: 0,
    ...o,
  };
}

function pickPoints(decs: DecisionRec[], max: number, rng: Rng): DecisionRec[] {
  const cands = decs.filter((d) => d.actions.length >= 2);
  if (cands.length <= max) return cands;
  const chosen: DecisionRec[] = [];
  const pool = cands.slice();
  while (chosen.length < max && pool.length) {
    const w = pool.map((d) => (TRIGGER_W[d.trigger] ?? 1) * (d.diagnosis && d.diagnosis !== "expected" ? 1.5 : 1));
    let r = rng.next() * w.reduce((a, b) => a + b, 0);
    let i = 0;
    for (; i < pool.length - 1; i++) {
      r -= w[i]!;
      if (r < 0) break;
    }
    chosen.push(pool[i]!);
    pool.splice(i, 1);
  }
  return chosen.sort((a, b) => a.k - b.k);
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export async function generateTrajectory(seed: number, apps: AppManifest[], runner: Runner, o: GenOptions): Promise<TrajectoryOut> {
  const t0 = Date.now();
  const pool = o.apps?.length ? apps.filter((a) => o.apps!.includes(a.name)) : apps;
  const scn = buildScenario(seed, pool, o.clean ? { clean: true } : {});
  const out: TrajectoryOut = { seed, app: scn.app.name, split: scn.split, rows: [], points: [], drops: {}, notes: {}, runs: 0, decisions: 0, realMs: 0, runMs: 0 };
  const drop = (k: string) => (out.drops[k] = (out.drops[k] ?? 0) + 1);
  /** Not drops: the row is kept (without a diagnosis label when the sampled vocabulary lacks it). */
  const note = (k: string) => (out.notes[k] = (out.notes[k] ?? 0) + 1);
  const R = new Rng(hashAll("realapps-traj", seed));
  if (scn.split === "test" && R.fork("testkeep").next() >= o.testKeep) {
    out.skipped = "test-subsample";
    return out;
  }
  const run = async (cfg: RunConfig): Promise<RunResult> => {
    const r = await runner.run(cfg);
    out.runs++;
    out.runMs += r.realMs;
    return r;
  };
  const ideal = await run(runConfig(scn, { runId: `${seed}-ideal`, ideal: true }));
  if (!ideal.ok) {
    drop("ideal-error");
    out.skipped = `ideal-error: ${ideal.error ?? ideal.internalErrors[0]}`;
    out.realMs = Date.now() - t0;
    return out;
  }
  const idealStates = states(ideal);
  // the ideal run defines the user's intents: every other run acts on the same items (RunConfig.pins)
  const pins = ideal.pins ?? {};
  const base = await run(runConfig(scn, { runId: `${seed}-base`, record: true, explore: scn.explore, pins, ...(o.ask === false ? {} : { askTimes: scn.askTimes }) }));
  out.decisions = base.decisions.length;
  if (!base.ok) {
    drop("base-error");
    out.skipped = `base-error: ${base.error ?? base.internalErrors[0]}`;
    out.realMs = Date.now() - t0;
    return out;
  }
  const baseStates = states(base);
  out.steps = { ran: base.stepsRun, skipped: base.stepsSkipped, why: base.skipWhy ?? {}, idealSkipped: ideal.stepsSkipped, idealWhy: ideal.skipWhy ?? {} };
  const meta0 = {
    source: "realapps",
    seed,
    app: scn.app.name,
    framework: scn.app.framework,
    libs: scn.app.libs,
    integration: scn.app.integration,
    domain: scn.app.domain,
    program_family: scn.family,
    family: scn.family,
    patterns: scn.patterns,
    chaos: scn.chaos,
    clean: scn.clean,
    budget: scn.budget,
    runtime: RUNTIME_TAG,
    browser: "chromium-headless",
    ...(scn.app.source ? { oss: scn.app.source.repo } : {}),
  };
  // ------------------------------------------------------------------------------------- decision rows
  const points = pickPoints(base.decisions, o.maxPoints, R.fork("points"));
  for (const p of points) {
    const passive = passiveOf(p.trigger, p.actions);
    const forcedPrefix: [number, string][] = base.decisions.filter((d) => d.k < p.k && d.explored).map((d) => [d.k, d.chosen]);
    const laterExplored = base.decisions.some((d) => d.k >= p.k && d.explored);
    const costs: Record<string, number[]> = {};
    const parts: Record<string, CostBreakdown> = {};
    let passiveStates: State[] | null = null;
    let dropped: string | undefined;
    for (let j = 0; j < Math.max(1, o.futures) && !dropped; j++) {
      if (j === 1 && o.adaptive) {
        const cp = costs[passive]?.[0];
        const gain = cp === undefined ? 0 : Math.max(...p.actions.filter((a) => a !== passive).map((a) => cp - (costs[a]?.[0] ?? cp)));
        if (!(gain > 0.05)) break;
      }
      const future = j === 0 ? undefined : { k: p.k, salt: hashAll("future", seed, p.k, j), t: p.t };
      let idealJ = ideal;
      let idealJStates = idealStates;
      if (future && scn.external.some((e) => e.t > p.t)) {
        idealJ = await run(runConfig(scn, { runId: `${seed}-ideal-f${j}-${p.k}`, ideal: true, pins, future: { k: -1, salt: future.salt, t: p.t } }));
        if (!idealJ.ok) {
          dropped = "ideal-future-error";
          break;
        }
        idealJStates = states(idealJ);
      }
      for (const a of p.actions) {
        let cf: RunResult;
        let cfStates: State[];
        if (a === passive && j === 0 && p.chosen === passive && !laterExplored) {
          // the base run already is the passive counterfactual (no exploration from k on)
          cf = base;
          cfStates = baseStates;
        } else {
          const forced: [number, string][] = [...forcedPrefix, [p.k, a]];
          cf = await run(runConfig(scn, { runId: `${seed}-cf-${p.k}-${a}-${j}`, forced, fpUpTo: p.k, pins, tStop: Math.min(scn.tEnd, p.t + W.finalMs), snapFrom: Math.max(0, p.t - 1), ...(future ? { future } : {}) }));
          if (!cf.ok) {
            dropped = "cf-error";
            break;
          }
          const mine = cf.decisions.filter((d) => d.k <= p.k);
          if (mine.length !== p.k + 1 || mine.some((d) => d.fp !== base.decisions[d.k]?.fp)) {
            dropped = "prefix-mismatch";
            break;
          }
          cfStates = states(cf);
        }
        const c = runCost(cf, idealJ, cfStates, idealJStates, p.t, scn.tEnd, scn.app);
        (costs[a] ??= []).push(Math.round(c.total * 1e4) / 1e4);
        if (j === 0) {
          parts[a] = c;
          if (a === passive) passiveStates = cfStates;
        }
      }
    }
    if (dropped) {
      drop(dropped);
      continue;
    }
    const mean: Record<string, number> = {};
    for (const [a, xs] of Object.entries(costs)) mean[a] = Math.round((xs.reduce((x, y) => x + y, 0) / xs.length) * 1e4) / 1e4;
    const lab = actionLabel(costs, passive);
    const harm: Record<string, number> = {};
    for (const a of p.actions) if (a !== passive) harm[a] = Math.round((mean[a]! - mean[passive]!) * 1e3) / 1e3;
    let diag = finishDiagnosis(p, scn.app, baseStates, passiveStates);
    const diagSubject = diag;
    // S1: never `expected` where acting clearly wins (sim/README.md "The oracle")
    let diagS1: string | undefined;
    if ((diag === undefined || diag === "expected") && !lab.passiveBest && (lab.adjusted[passive] ?? 0) >= S1_GAP) {
      const c = diagnosisFromOutcome(p, base.decisions, baseStates, idealStates, scn.app, lab.best);
      diag = c.diag;
      diagS1 = c.source;
    }
    const qs = p.questions as Record<string, never>;
    const tr = transformQuestions(qs, lab.dist, passive, lab.best, R.fork("transform", p.k));
    const labels: Record<string, unknown> = { action: { type: "choice", dist: tr.dist ?? lab.dist } };
    const dq = tr.questions.diagnosis as { type: string; criteria: Record<string, unknown> } | undefined;
    if (diag && dq && dq.type === "choice" && diag in dq.criteria) labels.diagnosis = { type: "choice", label: diag };
    else if (diag && dq && !(diag in dq.criteria)) note(`diagnosis-not-in-vocab:${diag}`);
    else if (!diag) note("diagnosis-uncorrelated");
    out.rows.push({
      id: `real-${scn.app.name}-${seed}-d${p.k}`,
      split: scn.split,
      family: `${scn.family}/${p.trigger}`,
      state: p.state!,
      questions: tr.questions as Record<string, unknown>,
      labels,
      meta: {
        ...meta0,
        trigger: p.trigger,
        decision: p.k,
        t: Math.round(p.t),
        explored_before: forcedPrefix.length,
        best: lab.best,
        passive_best: lab.passiveBest,
        passive,
        costs: mean,
        cost_futures: costs,
        futures: costs[passive]?.length ?? 1,
        adjusted: lab.adjusted,
        se: lab.se,
        non_passive_mass: lab.nonPassiveMass,
        cost_parts: Object.fromEntries(Object.entries(parts).map(([a, c]) => [a, { area: r3(c.area), final_client: r3(c.finalClient), final_server: r3(c.finalServer), relation_s: r3(c.relationS), relation_final: c.relationFinal, errors: c.shownErrors, uncaught: c.uncaught, wasted: c.wasted, latency_s: r3(c.latencyS), blocked: c.blocked }])),
        tiers: Object.fromEntries(p.actions.map((a) => [a, TIER[a] ?? "heal"])),
        diagnosis: diag ?? null,
        diag_why: p.diagWhy,
        ...(p.diagTrace ? { diag_trace: p.diagTrace } : {}),
        ...(diagS1 ? { diagnosis_s1: diagS1, diagnosis_subject: diagSubject ?? null } : {}),
        subject: p.subject,
        transform: tr.variant,
      },
    });
    out.points.push({ trigger: p.trigger, ...(diag ? { diagnosis: diag } : {}), best: lab.best, passiveBest: lab.passiveBest, harm, nonPassiveMass: lab.nonPassiveMass, gain: Math.round((mean[passive]! - Math.min(...Object.values(mean))) * 1e3) / 1e3, futures: costs[passive]?.length ?? 1, split: scn.split, app: scn.app.name });
  }
  // ------------------------------------------------------------------------------------------- ask rows
  // Programmatic developer questions about the trace (sim's generators, exact answers from harness knowledge;
  // each checks its evidence is in the situation text).
  (base.asks ?? []).forEach((a, i) => {
    const qs = askQuestions(a as never, R.fork("ask", i));
    if (!qs.length) return;
    const questions: Record<string, unknown> = {};
    const labels: Record<string, unknown> = {};
    for (const q of qs) {
      questions[q.qid] = q.question;
      labels[q.qid] = q.label;
    }
    out.rows.push({ id: `real-${scn.app.name}-${seed}-a${i}`, split: scn.split, family: `${scn.family}/ask`, state: a.state, questions, labels, meta: { ...meta0, trigger: "ask", t: Math.round(a.t), kinds: qs.map((q) => q.kind) } });
  });
  // ---------------------------------------------------------------------------------------- unlabeled rows
  // Every other base-run decision with >= 2 actions (no counterfactuals): the situation, the questions as the runtime
  // asked them, and the gold diagnosis; the action is left to the teacher (meta.unlabeled, as in SIM's batches).
  if (o.unlabeled !== 0) {
    const used = new Set(points.map((p) => p.k));
    const pool = base.decisions.filter((d) => d.state && d.actions.length >= 2 && !used.has(d.k));
    for (const d of R.fork("unlabeled").sample(pool, o.unlabeled ?? 40).sort((a, b) => a.k - b.k)) {
      const passive = passiveOf(d.trigger, d.actions);
      const diag = finishDiagnosis(d, scn.app, baseStates, d.chosen === passive && !base.decisions.some((x) => x.k >= d.k && x.explored) ? baseStates : null);
      const dq = (d.questions as Record<string, { type: string; criteria: Record<string, unknown> }> | undefined)?.diagnosis;
      const labels: Record<string, unknown> = {};
      if (diag && dq && dq.type === "choice" && diag in dq.criteria) labels.diagnosis = { type: "choice", label: diag };
      out.rows.push({
        id: `real-${scn.app.name}-${seed}-u${d.k}`,
        split: scn.split,
        family: `${scn.family}/${d.trigger}`,
        state: d.state!,
        questions: d.questions!,
        labels,
        meta: { ...meta0, trigger: d.trigger, decision: d.k, t: Math.round(d.t), passive, unlabeled: true, ...(d.repeat ? { repeat: true } : {}), diagnosis: diag ?? null, diag_why: d.diagWhy, explored_before: base.decisions.filter((x) => x.k < d.k && x.explored).length, base_choice: d.chosen, subject: d.subject },
      });
    }
  }
  // ------------------------------------------------------------------------------- diagnosis-only rows
  const single = base.decisions.filter((d) => d.actions.length < 2 && d.state);
  for (const d of R.fork("single").sample(single, 3)) {
    const diag = finishDiagnosis(d, scn.app, baseStates, null);
    const dq = (d.questions as Record<string, { type: string; criteria: Record<string, unknown> }> | undefined)?.diagnosis;
    if (!diag || !dq || dq.type !== "choice" || !(diag in dq.criteria)) continue;
    out.rows.push({
      id: `real-${scn.app.name}-${seed}-s${d.k}`,
      split: scn.split,
      family: `${scn.family}/${d.trigger}`,
      state: d.state!,
      questions: d.questions!,
      labels: { diagnosis: { type: "choice", label: diag } },
      meta: { ...meta0, trigger: d.trigger, decision: d.k, t: Math.round(d.t), diagnosis: diag, diag_why: d.diagWhy, diagnosis_only: true, subject: d.subject },
    });
  }
  out.realMs = Date.now() - t0;
  return out;
}
