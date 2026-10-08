// One trajectory = one scenario. Ideal run (intended outcome) → base run on the real runtime with an exploration
// policy (records every decision's state/questions) → for each sampled decision point k and each applicable action
// a: a counterfactual run with the base run's choices before k, `a` forced at k and the passive action after k →
// cost → soft action label; diagnosis from the sim's knowledge at decision time; ask rows from probes.

import { askQuestions } from "../ask/questions.js";
import { clientDivergenceAt, divergedFieldsAt, actionLabel, runCost, TIER, W, type CostBreakdown } from "../oracle/cost.js";
import { hashAll, Rng } from "../rng.js";
import { S2, type FutureSpec } from "../run/latent.js";
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
  /** Counterfactual futures per labelled decision (paired across actions). Default 3. */
  futures?: number;
  /** Only run the extra futures when some non-passive action beats passive by > 0.05 in the first. Default true. */
  adaptive?: boolean;
  /**
   * "gold": counterfactual action labels (default). "unlabeled": base run only; every decision point becomes a row
   * with its state/questions and the gold diagnosis (sim knowledge) but no action label (~10x cheaper), for teacher
   * labelling and distillation.
   */
  mode?: "gold" | "unlabeled" | "onpolicy";
  /** On-policy mode: the model (runtime model host) that decides in the base run. */
  model?: import("../types.js").DecisionProvider;
  /** Unlabeled mode: max decision rows per trajectory (default 40). */
  maxUnlabeled?: number;
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
  /** Label mass on non-passive actions. */
  nonPassiveMass: number;
  /** Mean raw cost of passive minus the cheapest action's (≥ 0). */
  gain: number;
  futures: number;
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

const TRIGGER_W: Record<string, number> = { mutation: 1, delivery: 1.2, request: 1, failure: 1.6, stall: 2.2, inconsistency: 3, transition: 3, error: 2.2 };

function explorePolicy(scale: number, rngT: Rng): ExplorePolicy | undefined {
  const eps = rngT.weighted([[0, 4], [0.08, 3], [0.2, 2]] as const) * scale;
  if (eps <= 0) return undefined;
  return {
    choose(rec, rng) {
      const passive = PASSIVE[rec.trigger] ?? rec.actions[0];
      const others = rec.actions.filter((a) => a !== passive);
      if (!others.length) return undefined;
      // Exploration is concentrated where the sim sees a problem (keeps fake-diagnosis answers rare).
      // Delivery diagnoses are only known after the run; the runtime asks only on salient deliveries.
      const p = rec.trigger === "delivery" ? eps / 2 : rec.diagnosis && rec.diagnosis !== "expected" ? eps : eps / 4;
      return rng.next() < p ? rng.pick(others) : undefined;
    },
  };
}

/** On-policy: favour points where the model acted (false-intervention candidates) or stayed passive on a problem. */
function pickOnPolicy(decs: DecisionRec[], max: number, rng: Rng): DecisionRec[] {
  const cands = decs.filter((d) => d.actions.length >= 2);
  const w = (d: DecisionRec) => {
    const passive = PASSIVE[d.trigger] ?? d.actions[0];
    if (d.ran && d.ran !== passive) return 4;
    if (d.modelChoice && d.modelChoice !== passive) return 3;
    if (d.diagnosis && d.diagnosis !== "expected") return 2;
    return 1;
  };
  const chosen: DecisionRec[] = [];
  const pool = cands.slice();
  while (chosen.length < max && pool.length) {
    const ws = pool.map(w);
    let r = rng.next() * ws.reduce((a, b) => a + b, 0);
    let i = 0;
    for (; i < pool.length - 1; i++) {
      r -= ws[i]!;
      if (r < 0) break;
    }
    chosen.push(pool[i]!);
    pool.splice(i, 1);
  }
  return chosen.sort((a, b) => a.k - b.k);
}

/** Dense trajectories (storms) are labelled only in their first DENSE_K decisions: replay cost grows with k. */
const DENSE_K = 600;

function pickPoints(decs: DecisionRec[], max: number, rng: Rng): DecisionRec[] {
  const cands = decs.filter((d) => d.actions.length >= 2 && d.k < DENSE_K);
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
  if (o.mode === "unlabeled") return unlabeledTrajectory(scn, split, out, R, o, t0);
  const ideal = await runScenario(scn, { ideal: true, serverTimeline: true });
  out.runs++;
  if (ideal.internalErrors.length) {
    drop("ideal-internal-error");
    out.skipped = "ideal-error";
    return out;
  }
  const onp = o.mode === "onpolicy" && o.model;
  const explore = onp ? undefined : explorePolicy(o.exploreScale, R.fork("explore"));
  const base = onp
    ? await runScenario(scn, { ideal: false, factory: o.factory, record: true, probeAsk: false, onPolicy: { model: o.model! } })
    : await runScenario(scn, { ideal: false, factory: o.factory, record: true, probeAsk: o.askRows, ...(explore ? { explore } : {}) });
  out.runs++;
  out.decisions = base.decisions.length;
  if (base.internalErrors.length) {
    drop("base-internal-error");
    out.skipped = `base-error: ${String((base.internalErrors[0] as Error)?.stack ?? base.internalErrors[0]).slice(0, 300)}`;
    return out;
  }
  const meta0 = metaOf(scn, o);
  // -------------------------------------------------------------------------------------- decision rows
  const points = onp ? pickOnPolicy(base.decisions, o.maxPoints, R.fork("points")) : pickPoints(base.decisions, o.maxPoints, R.fork("points"));
  for (const p of points) {
    const passive = PASSIVE[p.trigger] ?? p.actions[0]!;
    const forcedPrefix = new Map<number, string>();
    for (const d of base.decisions) if (d.k < p.k && d.explored) forcedPrefix.set(d.k, d.chosen);
    const pc = await pointCosts(scn, ideal, base, p, o.factory, o.futures ?? 3, o.adaptive ?? true);
    if (p.probe) p.probe.l_div_now = Math.round(clientDivergenceAt(base, ideal, p.t) * 1000) / 1000;
    out.runs += pc.runs;
    if (pc.fallbacks) out.drops["info:latent-fallback"] = (out.drops["info:latent-fallback"] ?? 0) + pc.fallbacks;
    if (pc.drop) drop(pc.drop);
    const ok = !pc.drop;
    const futures = pc.costs;
    const parts = pc.parts;
    if (!ok) continue;
    const costs: Record<string, number> = {};
    for (const [a, xs] of Object.entries(futures)) costs[a] = Math.round((xs.reduce((x, y) => x + y, 0) / xs.length) * 1e4) / 1e4;
    const lab = actionLabel(futures, passive);
    const harm: Record<string, number> = {};
    for (const a of p.actions) if (a !== passive) harm[a] = Math.round((costs[a]! - costs[passive]!) * 1e3) / 1e3;
    const tr = transformQuestions(p.questions, lab.dist, passive, lab.best, R.fork("transform", p.k));
    const labels: Record<string, Label> = { action: { type: "choice", dist: tr.dist ?? lab.dist } };
    // S1: never `expected` where acting clearly wins; name what the action repairs or prevents.
    let diag = p.diagnosis;
    let diagS1: string | undefined;
    if ((diag === undefined || diag === "expected") && p.subject.kind !== "unknown" && !lab.passiveBest && (lab.adjusted[passive] ?? 0) >= S1_GAP) {
      const c = diagnosisFromOutcome(base, ideal, p, lab.best);
      diag = c.diag;
      diagS1 = c.source;
    }
    const dq = tr.questions.diagnosis;
    if (diag && dq && dq.type === "choice" && diag in dq.criteria && p.subject.kind !== "unknown") labels.diagnosis = { type: "choice", label: diag };
    else if (diag && dq && dq.type === "choice" && !(diag in dq.criteria)) drop("diagnosis-not-in-vocab");
    else if (!diag || p.subject.kind === "unknown") drop("diagnosis-uncorrelated");
    const row: Row = {
      id: `${onp ? "p" : "sim"}-${seed}-d${p.k}`,
      split,
      family: `${scn.family}/${p.trigger}`,
      state: p.state,
      questions: tr.questions,
      labels,
      meta: {
        ...meta0,
        trigger: p.trigger,
        passive,
        subject_feature: p.feature ?? null,
        decision: p.k,
        t: Math.round(p.t),
        explored_before: [...forcedPrefix.keys()].length,
        best: lab.best,
        passive_best: lab.passiveBest,
        costs,
        cost_futures: futures,
        futures: futures[passive]?.length ?? 1,
        adjusted: lab.adjusted,
        se: lab.se,
        non_passive_mass: lab.nonPassiveMass,
        cost_parts: Object.fromEntries(Object.entries(parts).map(([a, c]) => [a, { area: r3(c.area), final_client: r3(c.finalClient), final_server: r3(c.finalServer), relation_s: r3(c.relationS), relation_final: c.relationFinal, errors: c.shownErrors, uncaught: c.uncaught, wasted: c.wasted, latency_s: r3(c.latencyS) }])),
        tiers: Object.fromEntries(p.actions.map((a) => [a, TIER[a] ?? "heal"])),
        diagnosis: diag ?? null,
        ...(diagS1 ? { diagnosis_s1: diagS1, diagnosis_subject: p.diagnosis ?? null } : {}),
        subject: p.subject,
        transform: tr.variant,
        ...(p.fakeDiagnosis ? { fake_diagnosis: true } : {}),
        ...(p.probe ? { probe: p.probe } : {}),
        ...(onp
          ? {
              on_policy: true,
              model_probs: p.modelProbs ?? null,
              model_choice: p.modelChoice ?? null,
              model_diagnosis: p.modelDiagnosis ?? null,
              ran: p.ran ?? passive,
              false_intervention: (p.ran ?? passive) !== passive && lab.passiveBest,
              miss: (p.ran ?? passive) === passive && !lab.passiveBest && lab.nonPassiveMass >= 0.9,
            }
          : {}),
      },
    };
    out.rows.push(row);
    out.points.push({ trigger: p.trigger, ...(diag ? { diagnosis: diag } : {}), best: lab.best, passiveBest: lab.passiveBest, harm, costs, split, explored: forcedPrefix.size > 0, correlated: p.subject.kind !== "unknown", nonPassiveMass: lab.nonPassiveMass, gain: Math.round((costs[passive]! - Math.min(...Object.values(costs))) * 1e3) / 1e3, futures: futures[passive]?.length ?? 1 });
  }
  // ------------------------------------------------------------------------------- diagnosis-only rows
  // Decisions with a single applicable action (e.g. a harmless uncaught error whose chain wrote nothing) carry
  // only the diagnosis question: no counterfactuals needed. Keep up to 3 per trajectory.
  const single = base.decisions.filter((d) => d.actions.length < 2 && d.diagnosis && d.subject.kind !== "unknown");
  for (const d of R.fork("single").sample(single, 3)) {
    const dq = d.questions.diagnosis;
    if (!dq || dq.type !== "choice" || !(d.diagnosis! in dq.criteria)) continue;
    out.rows.push({
      id: `sim-${seed}-s${d.k}`,
      split,
      family: `${scn.family}/${d.trigger}`,
      state: d.state,
      questions: d.questions,
      labels: { diagnosis: { type: "choice", label: d.diagnosis! } },
      meta: { ...meta0, trigger: d.trigger, passive: PASSIVE[d.trigger] ?? d.actions[0] ?? null, subject_feature: d.feature ?? null, decision: d.k, t: Math.round(d.t), diagnosis: d.diagnosis, diagnosis_only: true, subject: d.subject },
    });
  }
  // ------------------------------------------------------------------------------------------- ask rows
  if (o.askRows && !onp) {
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

/**
 * Counterfactual costs of every applicable action at decision point `p` of the base run, over K paired futures:
 * future 0 keeps all randomness; futures 1..K-1 re-seed everything drawn after the decision (network, pushes,
 * model latency, other users' timing) with a salt shared by all actions (common random numbers). Each future is a
 * separate run whose decision prefix must be byte-identical to the base run.
 */
/** Wall time spent in runCost (profiling). */
export let costMs = 0;
export function resetCostMs(): void {
  costMs = 0;
}

/** S1: a clear non-passive win (passive's label gap, premiums included) at least this large never keeps `expected`. */
export const S1_GAP = 1.0;

/**
 * S1 diagnosis for a point whose subject looks normal but where an action clearly wins: the cause of what the action
 * repairs or prevents.
 *   a) fields already wrong at the decision (vs the ideal run): the verdict of the last non-`expected` write to them;
 *   b) the subject repeats an accidental user action (any body, e.g. a toggle clicked back): duplicate;
 *   c) coalesce/block of a request with an identical one in flight or just answered: duplicate;
 *   d) fields already wrong with no named cause: inconsistent (inconsistency/transition) or stale (the client holds
 *      older data than the intended state);
 *   e) otherwise: unusual.
 */
export function diagnosisFromOutcome(base: RunResult, ideal: RunResult, p: DecisionRec, best: string): { diag: string; source: string } {
  const know = base.know;
  const fields = divergedFieldsAt(base, ideal, p.t);
  let bestW: { t: number; diag: string } | undefined;
  for (const f of fields) {
    const [store, field] = f.split(".");
    for (let i = know.writes.length - 1; i >= 0; i--) {
      const w = know.writes[i]!;
      if (w.t > p.t || w.store !== store) continue;
      if (field && w.fields && !w.fields.includes(field)) continue;
      if (w.diag && w.diag !== "expected" && (!bestW || w.t > bestW.t)) bestW = { t: w.t, diag: w.diag };
      break;
    }
  }
  if (bestW) return { diag: bestW.diag, source: "a-write" };
  const ref = p.subject.ref;
  const op = p.subject.kind === "op" ? know.getOp(ref) : p.subject.kind === "write" ? know.getOp(know.getWrite(ref)?.op) : undefined;
  const it = know.getIntent(op?.intent ?? (p.subject.kind === "write" ? know.getWrite(ref)?.intent : undefined));
  if (it?.accidental || it?.repeatOf !== undefined || op?.dupOf !== undefined) return { diag: "duplicate", source: "b-repeat" };
  if (op && p.trigger === "request" && (best === "coalesce" || best === "block")) {
    const twin = know.ops.some((x) => x.id !== op.id && x.method === op.method && x.url === op.url && x.body === op.body && x.t0 <= op.t0 && (x.tEnd === undefined || x.tEnd > p.t - 10000));
    if (twin) return { diag: "duplicate", source: "c-twin" };
  }
  if (fields.length) return { diag: p.trigger === "inconsistency" || p.trigger === "transition" ? "inconsistent" : "stale", source: "d-diverged" };
  return { diag: "unusual", source: "e-other" };
}

/** Futures whose latent re-draw changed an observed prefix and were re-run with network/timing randomness only. */
export let latentFallbacks = 0;

export async function pointCosts(
  scn: Scenario,
  ideal: RunResult,
  base: RunResult,
  p: DecisionRec,
  factory: RuntimeFactory,
  K = 3,
  adaptive = true,
): Promise<{ costs: Record<string, number[]>; parts: Record<string, CostBreakdown>; runs: number; drop?: string; results: Record<string, RunResult>; fallbacks?: number }> {
  const forcedPrefix = new Map<number, string>();
  for (const d of base.decisions) if (d.k < p.k && d.explored) forcedPrefix.set(d.k, d.chosen);
  const costs: Record<string, number[]> = {};
  const parts: Record<string, CostBreakdown> = {};
  const results: Record<string, RunResult> = {};
  let runs = 0;
  const passive = PASSIVE[p.trigger] ?? p.actions[0]!;
  const laterExternal = scn.external.some((e) => e.t > p.t);
  let fallbacks = 0;
  /** One paired future: every action under the same world. "mismatch" when a replayed prefix differs. */
  const runFuture = async (j: number, noLatent: boolean): Promise<Record<string, { c: CostBreakdown; r: RunResult }> | string> => {
    const future: FutureSpec | undefined = j === 0 ? undefined : { k: p.k, salt: hashAll("future", scn.seed, p.k, j), t: p.t, ...(noLatent ? { noLatent } : {}) };
    let idealJ = ideal;
    // S2 re-draws the user's later steps and hidden intents, so the ideal of a re-seeded future is re-run.
    if (future && (laterExternal || (S2 && !noLatent))) {
      idealJ = await runScenario(scn, { ideal: true, serverTimeline: true, future: { ...future, k: -1, fired: base.firedSteps.filter((i) => scn.steps[i]!.t <= p.t) } });
      runs++;
    }
    const out: Record<string, { c: CostBreakdown; r: RunResult }> = {};
    for (const a of p.actions) {
      const forced = new Map(forcedPrefix);
      forced.set(p.k, a);
      let cf: RunResult;
      try {
        cf = await runScenario(scn, { ideal: false, factory, forced, fpUpTo: p.k, tStop: p.t + W.finalMs, ...(future ? { future } : {}) });
      } catch {
        return "cf-exception";
      }
      runs++;
      if (cf.internalErrors.length) return "cf-internal-error";
      // Replay check: every decision up to k must be byte-identical to the base run.
      const mine = cf.decisions.filter((d) => d.k <= p.k);
      if (mine.length !== p.k + 1 || mine.some((d) => d.fp !== base.decisions[d.k]?.fp)) return "prefix-mismatch";
      const tc = performance.now();
      out[a] = { c: runCost(cf, idealJ, p.t, scn.tEnd), r: cf };
      costMs += performance.now() - tc;
    }
    return out;
  };
  const gainOf = (j: number): number => {
    const cp = costs[passive]?.[j];
    return cp === undefined ? 0 : Math.max(...p.actions.filter((a) => a !== passive).map((a) => cp - (costs[a]?.[j] ?? cp)));
  };
  for (let j = 0; j < Math.max(1, K); j++) {
    if (adaptive && j >= 1) {
      // S2: always look at one re-seeded future (the hidden state may favour an action the base world does not);
      // the third and later futures only when some action gains in a future seen so far.
      const minK = S2 ? 2 : 1;
      if (j >= minK && !(Math.max(...Array.from({ length: j }, (_, i) => gainOf(i))) > 0.05)) break;
    }
    let res = await runFuture(j, false);
    if (res === "prefix-mismatch" && j > 0 && S2) {
      latentFallbacks++;
      fallbacks++;
      res = await runFuture(j, true);
    }
    if (typeof res === "string") return { costs, parts, runs, drop: res, results, fallbacks };
    for (const a of p.actions) {
      const { c, r } = res[a]!;
      (costs[a] ??= []).push(Math.round(c.total * 1e4) / 1e4);
      if (j === 0) {
        parts[a] = c;
        results[a] = r;
      }
    }
  }
  return { costs, parts, runs, results, fallbacks };
}

/** Meta shared by every row of a trajectory (TRAIN reads domain, program_family, clean, chaos, budget). */
export function metaOf(scn: Scenario, o: GenOptions): Record<string, unknown> {
  return {
    seed: scn.seed,
    domain: scn.domain,
    family: scn.family,
    program_family: scn.family,
    chaos: scn.chaos,
    clean: scn.clean === true,
    persona: scn.persona.kind,
    budget: scn.budget,
    runtime: o.runtimeName,
    features: scn.features.map((f) => f.kind),
    patterns: scn.patterns,
  };
}

/** Unlabeled mode: one base run; every decision point is a row (gold diagnosis, no action label); ask rows too. */
async function unlabeledTrajectory(scn: Scenario, split: string, out: TrajectoryOut, R: Rng, o: GenOptions, t0: number): Promise<TrajectoryOut> {
  const explore = explorePolicy(o.exploreScale * 1.5, R.fork("explore"));
  const base = await runScenario(scn, { ideal: false, factory: o.factory, record: true, probeAsk: true, ...(explore ? { explore } : {}) });
  out.runs++;
  out.decisions = base.decisions.length;
  if (base.internalErrors.length) {
    out.drops["base-internal-error"] = (out.drops["base-internal-error"] ?? 0) + 1;
    out.skipped = `base-error: ${String((base.internalErrors[0] as Error)?.stack ?? base.internalErrors[0]).slice(0, 300)}`;
    return out;
  }
  const meta0 = { ...metaOf(scn, o), unlabeled: true };
  const decs = base.decisions.length > (o.maxUnlabeled ?? 40) ? R.fork("unl").sample(base.decisions, o.maxUnlabeled ?? 40).sort((a, b) => a.k - b.k) : base.decisions;
  for (const d of decs) {
    const passive = PASSIVE[d.trigger] ?? d.actions[0] ?? "";
    const tr = transformQuestions(d.questions, undefined, passive, passive, R.fork("transform", d.k));
    const labels: Record<string, Label> = {};
    const dq = tr.questions.diagnosis;
    if (d.diagnosis && dq && dq.type === "choice" && d.diagnosis in dq.criteria && d.subject.kind !== "unknown") labels.diagnosis = { type: "choice", label: d.diagnosis };
    out.rows.push({
      id: `u-${scn.seed}-d${d.k}`,
      split: split as Row["split"],
      family: `${scn.family}/${d.trigger}`,
      state: d.state,
      questions: tr.questions,
      labels,
      meta: { ...meta0, trigger: d.trigger, passive, subject_feature: d.feature ?? null, decision: d.k, t: Math.round(d.t), diagnosis: d.diagnosis ?? null, actions: d.actions, ran: d.chosen, explored: d.explored, subject: d.subject, transform: tr.variant },
    });
  }
  base.asks.forEach((a, i) => {
    const qs = askQuestions(a, R.fork("ask", i));
    if (!qs.length) return;
    const questions: Row["questions"] = {};
    const labels: Record<string, Label> = {};
    for (const q of qs) {
      questions[q.qid] = q.question;
      labels[q.qid] = q.label;
    }
    out.rows.push({ id: `u-${scn.seed}-a${i}`, split: split as Row["split"], family: `${scn.family}/ask`, state: a.state, questions, labels, meta: { ...meta0, trigger: "ask", t: Math.round(a.t), kinds: qs.map((q) => q.kind) } });
  });
  out.ms = performance.now() - t0;
  return out;
}
