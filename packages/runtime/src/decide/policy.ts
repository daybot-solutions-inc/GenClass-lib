// Policy gate for non-passive actions (CONTRACT §8). Let A = the applicable non-passive actions the mode permits
// (observe: none; guard: guard tier; heal: guard + heal), minus denied ones (only allowed ones when `allow` is
// set). The candidate is the most probable action in A; it runs only if the summed calibrated probability of A
// reaches the candidate's tier threshold (two good actions such as discard/defer may split the mass), the model's
// top diagnosis is not `expected` (unless requireDiagnosis is false), it is under the rate limit and the decision
// arrived within the hold budget. Otherwise the passive action runs and `reason` says why. Precision first.

import type { Mode, PolicyOptions, Tier } from "../types.js";

export interface PolicyConfig {
  thresholds: { report: number; guard: number; heal: number };
  allow?: Set<string>;
  deny: Set<string>;
  holdBudgetMs: number | "auto";
  holdUserWrites: boolean;
  maxActionsPerMinute: number;
  requireDiagnosis: boolean;
}

export function policyConfig(p: PolicyOptions | undefined): PolicyConfig {
  const t = p?.thresholds ?? {};
  const c: PolicyConfig = {
    thresholds: { report: t.report ?? 0.6, guard: t.guard ?? 0.9, heal: t.heal ?? 0.8 },
    deny: new Set(p?.deny ?? []),
    holdBudgetMs: p?.holdBudgetMs ?? "auto",
    holdUserWrites: p?.holdUserWrites ?? false,
    maxActionsPerMinute: p?.maxActionsPerMinute ?? 60,
    requireDiagnosis: p?.requireDiagnosis ?? true,
  };
  if (p?.allow) c.allow = new Set(p.allow);
  return c;
}

export function modeAllows(mode: Mode, tier: Tier): boolean {
  if (tier === "passive") return true;
  if (mode === "observe") return false;
  if (mode === "guard") return tier === "guard";
  return true;
}

/** Why an action may not run under this mode and policy (null when it is permitted). */
export function restriction(c: PolicyConfig, mode: Mode, a: { name: string; tier: Tier }): string | null {
  if (a.tier === "passive") return null;
  if (!modeAllows(mode, a.tier)) return mode === "observe" ? "observe mode never changes execution" : `${mode} mode does not allow ${a.tier}-tier actions`;
  if (c.deny.has(a.name)) return `${a.name} is denied by policy`;
  if (c.allow && !c.allow.has(a.name)) return `${a.name} is not in policy.allow`;
  return null;
}

/** A: the applicable non-passive actions this mode and policy permit. */
export function permittedActions<T extends { name: string; tier: Tier }>(c: PolicyConfig, mode: Mode, actions: T[]): T[] {
  return actions.filter((a) => a.tier !== "passive" && restriction(c, mode, a) === null);
}

export class RateLimiter {
  private ts: number[] = [];
  constructor(private readonly perMinute: () => number) {}
  /** Would one more action exceed the limit at time t? */
  full(t: number): boolean {
    this.ts = this.ts.filter((x) => x > t - 60_000);
    return this.ts.length >= this.perMinute();
  }
  take(t: number): void {
    this.ts.push(t);
  }
  count(t: number): number {
    this.ts = this.ts.filter((x) => x > t - 60_000);
    return this.ts.length;
  }
}

export interface GateInput {
  /** Every offered action with its tier (passive included). */
  actions: { name: string; tier: Tier }[];
  probabilities: Record<string, number>;
  /** The model's choice (argmax over all offered actions). */
  top: string;
  diagnosis: string;
  mode: Mode;
  paused: boolean;
  now: number;
}

export interface GateOutcome {
  /** The action to run (non-passive), or null for the passive action. */
  run: string | null;
  /** The most probable permitted action (what GenClass would have done). */
  candidate: string | null;
  /** Summed probability of the permitted actions. */
  mass: number;
  /** Why the passive action runs when the model preferred acting (null when it chose passive or the action runs). */
  reason: string | null;
}

export function gate(c: PolicyConfig, rate: RateLimiter, g: GateInput): GateOutcome {
  const A = permittedActions(c, g.mode, g.actions);
  const p = (name: string) => g.probabilities[name] ?? 0;
  let candidate: string | null = null;
  for (const a of A) if (candidate === null || p(a.name) > p(candidate)) candidate = a.name;
  const mass = A.reduce((s, a) => s + p(a.name), 0);
  const topTier = g.actions.find((a) => a.name === g.top)?.tier ?? "passive";
  const wanted = topTier !== "passive"; // a reason is only given when the model's own choice does not run
  const no = (reason: string | null): GateOutcome => ({ run: null, candidate, mass, reason: wanted ? reason : null });
  if (g.paused) return no("GenClass is paused");
  if (!candidate) {
    const top = g.actions.find((a) => a.name === g.top);
    return no(top ? restriction(c, g.mode, top) ?? "no action is permitted" : "no action is permitted");
  }
  const tier = g.actions.find((a) => a.name === candidate)!.tier;
  const th = tier === "guard" ? c.thresholds.guard : c.thresholds.heal;
  if (!(mass >= th)) {
    const top = g.actions.find((a) => a.name === g.top);
    const r = top && top.tier !== "passive" ? restriction(c, g.mode, top) : null;
    return no(r ?? `probability ${mass.toFixed(2)} for the permitted actions (${A.map((a) => a.name).join(", ")}) is below the ${tier} threshold ${th}`);
  }
  if (c.requireDiagnosis && g.diagnosis === "expected") return { ...no("the model's diagnosis is expected"), reason: "the model's diagnosis is expected" };
  if (rate.full(g.now)) return { ...no(null), reason: `rate limit: ${c.maxActionsPerMinute} actions in the last minute` };
  return { run: candidate, candidate, mass, reason: null };
}

export const HOLD_MIN_MS = 150;
export const HOLD_MAX_MS = 800;
export const HOLD_FALLBACK_MS = 300;

/**
 * The hold budget: the configured number, or "auto" = clamp(1.5 × median of recent model latencies (the model's
 * warm-up time before any), 150, 800) ms; 300 ms when nothing is known yet.
 */
export function holdBudget(c: PolicyConfig, latencies: number[], warmupMs: number | undefined): number {
  if (typeof c.holdBudgetMs === "number") return Math.max(0, c.holdBudgetMs);
  let base: number | undefined;
  if (latencies.length) {
    const a = [...latencies].sort((x, y) => x - y);
    base = a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  } else if (typeof warmupMs === "number" && warmupMs > 0) base = warmupMs;
  if (base === undefined) return HOLD_FALLBACK_MS;
  return Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, Math.round(1.5 * base)));
}
