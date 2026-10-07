// One trajectory = one scenario. Ideal run (intended outcome) → base run on the real runtime with an exploration
// policy (records every decision's state/questions) → for each sampled decision point k and each applicable action
// a: a counterfactual run with the base run's choices before k, `a` forced at k and the passive action after k →
// cost → soft action label; diagnosis from the sim's knowledge at decision time; ask rows from probes.

import { askQuestions } from "../ask/questions.js";
import { actionLabel, runCost, TIER, W, type CostBreakdown } from "../oracle/cost.js";
import { hashAll, Rng } from "../rng.js";
import { runScenario, type DecisionRec, type ExplorePolicy, type RunResult } from "../run/runner.js";
import type { RuntimeFactory } from "../run/rt.js";
import { transformQuestions } from "../run/transform.js";
import { PASSIVE, type Label, type Row } from "../types.js";
import { buildScenario, splitOf, type Scenario } from "../world/scenario.js";

export interface GenOptions {
  factory: RuntimeFactory;
  runtimeName: string;
  /** Max labelled decision points per trajectory. */
  maxPoints: number;
  askRows: boolean;
  /** Keep only this fraction of test trajectories (test is large because of hold-outs). */
  testKeep: number;
  /** Probability of an exploratory (non-passive) action per decision in the base run (per-trajectory scale). */
  exploreScale: number;
}

export interface PointStat {
  trigger: string;
  diagnosis?: string;
  best: string;
  passiveBest: boolean;
  /** cost increase vs passive for each non-passive action (for harm reporting). */
  harm: Record<string, number>;
  costs: Record<string, number>;
  split: string;
  explored: boolean;
  correlated: boolean;
}

export interface TrajectoryOut {
  seed: number;
  rows: Row[];
  points: PointStat[];
  drops: Record<string, number>;
  runs: number;
  decisions: number;
  ms: number;
  split: string;
  skipped?: string;
}

const TRIGGER_W: Record<string, number> = { mutation: 1, request: 1, failure: 1.6, stall: 2.2, inconsistency: 3, transition: 3, error: 2.2 };

function explorePolicy(scale: number, rngT: Rng): ExplorePolicy | undefined {
  const eps = rngT.weighted([[0, 4], [0.08, 3], [0.2, 2]] as const) * scale;
  if (eps <= 0) return undefined;
  return {
    choose(rec, rng) {
      const passive = PASSIVE[rec.trigger] ?? rec.actions[0];
      const others = rec.actions.filter((a) => a !== passive);
      if (!others.length) return undefined;
      // Exploration is concentrated where the sim sees a problem (keeps fake-diagnosis answers rare).
      const p = rec.diagnosis && rec.diagnosis !== "expected" ? eps : eps / 4;
      return rng.next() < p ? rng.pick(others) : undefined;
    },
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

export async function generateTrajectory(seed: number, o: GenOptions): Promise<TrajectoryOut> {
  const t0 = performance.now();
  const scn: Scenario = buildScenario(seed);
  const split = splitOf(scn);
  const out: TrajectoryOut = { seed, rows: [], points: [], drops: {}, runs: 0, decisions: 0, ms: 0, split };
  const drop = (k: string) => (out.drops[k] = (out.drops[k] ?? 0) + 1);
  const R = new Rng(hashAll("traj", seed));
  if (split === "test" && R.fork("testkeep").next() >= o.testKeep) {
    out.skipped = "test-subsample";
    return out;
  }
  const ideal = await runScenario(scn, { ideal: true, serverTimeline: true });
  out.runs++;
  if (ideal.internalErrors.length) {
    drop("ideal-internal-error");
    out.skipped = "ideal-error";
    return out;
  }
  const explore = explorePolicy(o.exploreScale, R.fork("explore"));
  const base = await runScenario(scn, { ideal: false, factory: o.factory, record: true, probeAsk: o.askRows, ...(explore ? { explore } : {}) });
  out.runs++;
  out.decisions = base.decisions.length;
  if (base.internalErrors.length) {
    drop("base-internal-error");
    out.skipped = `base-error: ${String((base.internalErrors[0] as Error)?.stack ?? base.internalErrors[0]).slice(0, 300)}`;
    return out;
  }
  const meta0 = { seed, domain: scn.domain, family: scn.family, chaos: scn.chaos, runtime: o.runtimeName, features: scn.features.map((f) => f.kind), patterns: scn.patterns };
  // -------------------------------------------------------------------------------------- decision rows
  const points = pickPoints(base.decisions, o.maxPoints, R.fork("points"));
  for (const p of points) {
    const passive = PASSIVE[p.trigger] ?? p.actions[0]!;
    const forcedPrefix = new Map<number, string>();
    for (const d of base.decisions) if (d.k < p.k && d.explored) forcedPrefix.set(d.k, d.chosen);
    const pc = await pointCosts(scn, ideal, base, p, o.factory);
    out.runs += pc.runs;
    if (pc.drop) drop(pc.drop);
    const ok = !pc.drop;
    const costs = pc.costs;
    const parts = pc.parts;
    if (!ok) continue;
    const lab = actionLabel(costs, passive);
    const harm: Record<string, number> = {};
    for (const a of p.actions) if (a !== passive) harm[a] = Math.round((costs[a]! - costs[passive]!) * 1e3) / 1e3;
    const tr = transformQuestions(p.questions, lab.dist, passive, lab.best, R.fork("transform", p.k));
    const labels: Record<string, Label> = { action: { type: "choice", dist: tr.dist ?? lab.dist } };
    const diag = p.diagnosis;
    const dq = tr.questions.diagnosis;
    if (diag && dq && dq.type === "choice" && diag in dq.criteria && p.subject.kind !== "unknown") labels.diagnosis = { type: "choice", label: diag };
    else if (diag && dq && dq.type === "choice" && !(diag in dq.criteria)) drop("diagnosis-not-in-vocab");
    else if (!diag || p.subject.kind === "unknown") drop("diagnosis-uncorrelated");
    const row: Row = {
      id: `sim-${seed}-d${p.k}`,
      split,
      family: `${scn.family}/${p.trigger}`,
      state: p.state,
      questions: tr.questions,
      labels,
      meta: {
        ...meta0,
        trigger: p.trigger,
        decision: p.k,
        t: Math.round(p.t),
        explored_before: [...forcedPrefix.keys()].length,
        best: lab.best,
        passive_best: lab.passiveBest,
        costs,
        adjusted: lab.adjusted,
        cost_parts: Object.fromEntries(Object.entries(parts).map(([a, c]) => [a, { area: r3(c.area), final_client: r3(c.finalClient), final_server: r3(c.finalServer), errors: c.shownErrors, uncaught: c.uncaught, wasted: c.wasted, latency_s: r3(c.latencyS) }])),
        tiers: Object.fromEntries(p.actions.map((a) => [a, TIER[a] ?? "heal"])),
        diagnosis: diag ?? null,
        subject: p.subject,
        transform: tr.variant,
        ...(p.fakeDiagnosis ? { fake_diagnosis: true } : {}),
      },
    };
    out.rows.push(row);
    out.points.push({ trigger: p.trigger, ...(diag ? { diagnosis: diag } : {}), best: lab.best, passiveBest: lab.passiveBest, harm, costs, split, explored: forcedPrefix.size > 0, correlated: p.subject.kind !== "unknown" });
  }
  // ------------------------------------------------------------------------------------------- ask rows
  if (o.askRows) {
    base.asks.forEach((a, i) => {
      const qs = askQuestions(a, R.fork("ask", i));
      if (!qs.length) return;
      const questions: Row["questions"] = {};
      const labels: Record<string, Label> = {};
      for (const q of qs) {
        questions[q.qid] = q.question;
        labels[q.qid] = q.label;
      }
      out.rows.push({
        id: `sim-${seed}-a${i}`,
        split,
        family: `${scn.family}/ask`,
        state: a.state,
        questions,
        labels,
        meta: { ...meta0, trigger: "ask", t: Math.round(a.t), kinds: qs.map((q) => q.kind) },
      });
    });
  }
  out.ms = performance.now() - t0;
  return out;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Counterfactual costs of every applicable action at decision point `p` of the base run. */
export async function pointCosts(
  scn: Scenario,
  ideal: RunResult,
  base: RunResult,
  p: DecisionRec,
  factory: RuntimeFactory,
): Promise<{ costs: Record<string, number>; parts: Record<string, CostBreakdown>; runs: number; drop?: string; results: Record<string, RunResult> }> {
  const forcedPrefix = new Map<number, string>();
  for (const d of base.decisions) if (d.k < p.k && d.explored) forcedPrefix.set(d.k, d.chosen);
  const costs: Record<string, number> = {};
  const parts: Record<string, CostBreakdown> = {};
  const results: Record<string, RunResult> = {};
  let runs = 0;
  for (const a of p.actions) {
    const forced = new Map(forcedPrefix);
    forced.set(p.k, a);
    let cf: RunResult;
    try {
      cf = await runScenario(scn, { ideal: false, factory, forced, fpUpTo: p.k, tStop: p.t + W.finalMs });
    } catch {
      return { costs, parts, runs, drop: "cf-exception", results };
    }
    runs++;
    if (cf.internalErrors.length) return { costs, parts, runs, drop: "cf-internal-error", results };
    // Replay check: every decision up to k must be byte-identical to the base run.
    const mine = cf.decisions.filter((d) => d.k <= p.k);
    if (mine.length !== p.k + 1 || mine.some((d) => d.fp !== base.decisions[d.k]?.fp)) return { costs, parts, runs, drop: "prefix-mismatch", results };
    const c = runCost(cf, ideal, p.t, scn.tEnd);
    costs[a] = Math.round(c.total * 1e4) / 1e4;
    parts[a] = c;
    results[a] = cf;
  }
  return { costs, parts, runs, results };
}
