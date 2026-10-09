// Aggregation of trial results (shared by the in-page trial panel and the Playwright eval; no DOM).
import type { DemoId, GcMode, TrialResult } from "./types.ts";

export interface Rate {
  n: number;
  k: number;
  rate: number;
  lo: number;
  hi: number;
}

export interface ModeSummary {
  mode: GcMode;
  chaos: Rate;
  clean: Rate;
  /** Non-passive actions that ran on clean runs (every one is a false positive). */
  falseInterventions: number;
  /** Detections (reported findings) on clean trials, where the app is correct: every one is a false finding. */
  falseFindings: number;
  cleanTrialsWithFinding: number;
  /** Detections per chaos trial (findings where something may be wrong). */
  findingsPerChaosTrial: number;
  cleanTrialsWithIntervention: number;
  cleanTrials: number;
  interventionsPerChaosTrial: number;
  decisionsPerTrial: number;
  detectionsPerTrial: number;
  /** Median of the demo's user-visible latency metric on clean runs. */
  latencyMs: number | null;
  /** Same on chaos runs. */
  latencyChaosMs: number | null;
  /** Model decision latency over all decisions. */
  decisionP50: number | null;
  decisionP95: number | null;
  /** Paired with Off on the same chaos seeds: bugs fixed and bugs introduced. */
  fixed: number;
  introduced: number;
  paired: number;
  /** Decisions whose chosen action did not run, by reason. */
  notExecuted: Record<string, number>;
  actions: Record<string, number>;
  errors: number;
  runtime: string;
  modelStatus: string;
  metrics: Record<string, number | null>;
}

export interface DemoSummary {
  demo: DemoId;
  modes: Partial<Record<GcMode, ModeSummary>>;
  trials: number;
}

/** Wilson score interval (95%). */
export function wilson(k: number, n: number): Rate {
  if (n === 0) return { n, k, rate: 0, lo: 0, hi: 0 };
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const m = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { n, k, rate: p, lo: Math.max(0, c - m), hi: Math.min(1, c + m) };
}

export function quantile(xs: number[], q: number): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}

function mean(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function summarizeMode(all: TrialResult[], mode: GcMode): ModeSummary | undefined {
  const rs = all.filter((r) => r.mode === mode);
  if (!rs.length) return undefined;
  const chaos = rs.filter((r) => r.kind === "chaos");
  const clean = rs.filter((r) => r.kind === "clean");
  const offChaos = new Map(all.filter((r) => r.mode === "off" && r.kind === "chaos").map((r) => [r.seed, r]));
  let fixed = 0;
  let introduced = 0;
  let paired = 0;
  if (mode !== "off") {
    for (const r of chaos) {
      const o = offChaos.get(r.seed);
      if (!o || o.error || r.error) continue;
      paired++;
      if (o.bug && !r.bug) fixed++;
      if (!o.bug && r.bug) introduced++;
    }
  }
  const notExecuted: Record<string, number> = {};
  const actions: Record<string, number> = {};
  for (const r of rs) {
    for (const [k, v] of Object.entries(r.gc.notExecuted)) notExecuted[k] = (notExecuted[k] ?? 0) + v;
    for (const a of r.gc.interventions) actions[a.action] = (actions[a.action] ?? 0) + 1;
  }
  const metricKeys = new Set<string>();
  for (const r of rs) for (const k of Object.keys(r.metrics)) metricKeys.add(k);
  const metrics: Record<string, number | null> = {};
  for (const k of metricKeys) {
    metrics[`chaos.${k}`] = mean(chaos.map((r) => r.metrics[k]));
    metrics[`clean.${k}`] = mean(clean.map((r) => r.metrics[k]));
  }
  const ok = (r: TrialResult) => !r.error;
  const lat = rs.flatMap((r) => r.gc.decisionLatencyMs);
  const statuses = [...new Set(rs.map((r) => r.gc.status))];
  return {
    mode,
    chaos: wilson(chaos.filter((r) => ok(r) && r.bug).length, chaos.filter(ok).length),
    clean: wilson(clean.filter((r) => ok(r) && r.bug).length, clean.filter(ok).length),
    falseInterventions: clean.reduce((a, r) => a + r.gc.interventions.length, 0),
    falseFindings: clean.reduce((a, r) => a + r.gc.detections, 0),
    cleanTrialsWithFinding: clean.filter((r) => r.gc.detections > 0).length,
    findingsPerChaosTrial: chaos.length ? chaos.reduce((a, r) => a + r.gc.detections, 0) / chaos.length : 0,
    cleanTrialsWithIntervention: clean.filter((r) => r.gc.interventions.length > 0).length,
    cleanTrials: clean.length,
    interventionsPerChaosTrial: chaos.length ? chaos.reduce((a, r) => a + r.gc.interventions.length, 0) / chaos.length : 0,
    decisionsPerTrial: rs.reduce((a, r) => a + r.gc.decisions, 0) / rs.length,
    detectionsPerTrial: rs.reduce((a, r) => a + r.gc.detections, 0) / rs.length,
    latencyMs: quantile(
      clean.map((r) => r.metrics.latencyMs),
      0.5,
    ),
    latencyChaosMs: quantile(
      chaos.map((r) => r.metrics.latencyMs),
      0.5,
    ),
    decisionP50: quantile(lat, 0.5),
    decisionP95: quantile(lat, 0.95),
    fixed,
    introduced,
    paired,
    notExecuted,
    actions,
    errors: rs.filter((r) => r.error).length,
    runtime: [...new Set(rs.map((r) => r.gc.runtime))].join("+"),
    modelStatus: statuses.join("+"),
    metrics,
  };
}

export function summarizeDemo(demo: DemoId, results: TrialResult[]): DemoSummary {
  const rs = results.filter((r) => r.demo === demo);
  return {
    demo,
    trials: rs.length,
    modes: {
      off: summarizeMode(rs, "off"),
      observe: summarizeMode(rs, "observe"),
      guard: summarizeMode(rs, "guard"),
      heal: summarizeMode(rs, "heal"),
    },
  };
}
