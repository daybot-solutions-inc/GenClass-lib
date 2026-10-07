// Policy gate for non-passive actions (CONTRACT §8). Every check must pass, else the passive action runs and
// `reason` says why. Precision first: when in doubt, do nothing and report.

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
  action: string;
  tier: Tier;
  probability: number;
  diagnosis: string;
  mode: Mode;
  inBudget: boolean;
  paused: boolean;
  now: number;
}

/** null = the action may run; otherwise the reason the passive action runs instead. */
export function gate(c: PolicyConfig, rate: RateLimiter, g: GateInput): string | null {
  if (g.tier === "passive") return null;
  if (g.paused) return "GenClass is paused";
  if (!modeAllows(g.mode, g.tier)) return g.mode === "observe" ? "observe mode never changes execution" : `${g.mode} mode does not allow ${g.tier}-tier actions`;
  if (!g.inBudget) return "the decision arrived after the hold budget expired";
  if (c.requireDiagnosis && g.diagnosis === "expected") return "the model's diagnosis is expected";
  const th = g.tier === "guard" ? c.thresholds.guard : c.thresholds.heal;
  if (!(g.probability >= th)) return `probability ${g.probability.toFixed(2)} is below the ${g.tier} threshold ${th}`;
  if (c.deny.has(g.action)) return `${g.action} is denied by policy`;
  if (c.allow && !c.allow.has(g.action)) return `${g.action} is not in policy.allow`;
  if (rate.full(g.now)) return `rate limit: ${c.maxActionsPerMinute} actions in the last minute`;
  return null;
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
