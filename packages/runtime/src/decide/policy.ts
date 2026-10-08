// Policy gate for non-passive actions (CONTRACT §8). Let A = the applicable non-passive actions the mode permits
// (observe: none; guard: guard tier; heal: guard + heal), minus denied ones (only allowed ones when `allow` is
// set). The candidate is the most probable action in A; it runs only if the summed calibrated probability of A
// reaches the candidate's tier threshold (two good actions such as discard/defer may split the mass), the model's
// top diagnosis is not `expected` (unless requireDiagnosis is false), it is under the rate limit and the decision
// arrived within the hold budget. Otherwise the passive action runs and `reason` says why. Precision first.

import type { Aggressiveness, EffectiveGates, GateKind, GateSource, GateTier, Mode, ModelGate, PolicyOptions, Tier, TriggerKind } from "../types.js";

export const DEFAULT_THRESHOLDS = { report: 0.6, guard: 0.9, heal: 0.8 } as const;
/** gain gate: margins in cost units when neither the app nor the model sets them, and the default τ. */
export const DEFAULT_GAIN_MARGINS = { guard: 2, heal: 2 } as const;
export const DEFAULT_TAU_GAIN = 1;
/** Probabilities are clamped to at least this before taking log ratios. */
export const MIN_PROB = 1e-6;

export interface PolicyConfig {
  /** policy.thresholds with the defaults filled in (what applies when the model ships no gate). */
  thresholds: { report: number; guard: number; heal: number };
  /** The app's own overrides (they win over the model's gate). */
  overrides: { report?: number; guard?: number; heal?: number };
  allow?: Set<string>;
  deny: Set<string>;
  holdBudgetMs: number | "auto";
  holdUserWrites: boolean;
  holdWrites: boolean;
  maxActionsPerMinute: number;
  requireDiagnosis: boolean;
  /** Lower-cased header names that make a non-idempotent request safe to repeat. */
  idempotencyHeaders: Set<string>;
}

export const DEFAULT_IDEMPOTENCY_HEADERS = ["Idempotency-Key", "X-Idempotency-Key"];

export function policyConfig(p: PolicyOptions | undefined): PolicyConfig {
  const t = p?.thresholds ?? {};
  const overrides: PolicyConfig["overrides"] = {};
  for (const k of ["report", "guard", "heal"] as const) if (typeof t[k] === "number" && Number.isFinite(t[k])) overrides[k] = t[k];
  const c: PolicyConfig = {
    thresholds: { report: overrides.report ?? DEFAULT_THRESHOLDS.report, guard: overrides.guard ?? DEFAULT_THRESHOLDS.guard, heal: overrides.heal ?? DEFAULT_THRESHOLDS.heal },
    overrides,
    deny: new Set(p?.deny ?? []),
    holdBudgetMs: p?.holdBudgetMs ?? "auto",
    holdUserWrites: p?.holdUserWrites ?? false,
    holdWrites: p?.holdWrites ?? false,
    maxActionsPerMinute: p?.maxActionsPerMinute ?? 60,
    requireDiagnosis: p?.requireDiagnosis ?? true,
    idempotencyHeaders: new Set((Array.isArray(p?.idempotencyHeaders) ? p!.idempotencyHeaders : DEFAULT_IDEMPOTENCY_HEADERS).filter((h) => typeof h === "string" && h.trim()).map((h) => h.trim().toLowerCase())),
  };
  if (p?.allow) c.allow = new Set(p.allow);
  return c;
}

const TRIGGERS: TriggerKind[] = ["mutation", "request", "delivery", "failure", "stall", "inconsistency", "transition", "error", "ask"];
const isProb = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** A tier's values: probabilities in [0, 1] for the mass gate, any finite margin (cost units) for the gain gate. */
function parseTier(raw: unknown, ok: (x: unknown) => x is number): GateTier | undefined {
  if (ok(raw)) return { default: raw };
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { default?: unknown; byTrigger?: unknown };
  const out: GateTier = {};
  if (ok(r.default)) out.default = r.default;
  if (r.byTrigger && typeof r.byTrigger === "object") {
    const by: Partial<Record<TriggerKind, number>> = {};
    for (const k of TRIGGERS) {
      const v = (r.byTrigger as Record<string, unknown>)[k];
      if (ok(v)) by[k] = v;
    }
    if (Object.keys(by).length) out.byTrigger = by;
  }
  return out.default !== undefined || out.byTrigger ? out : undefined;
}

/**
 * The model's gate from meta.json `gate` (`{ kind?, tauGain?, report?, guard: { default, byTrigger? }, heal: {...} }`;
 * a bare number for a tier means its default). kind "mass" (default): tier values are probabilities in [0, 1];
 * kind "gain": tier values are margins (any finite number) and tauGain > 0. Invalid values and unknown trigger kinds
 * are ignored. Undefined when nothing valid is left.
 */
export function parseGate(raw: unknown): ModelGate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const base = parseSingleGate(raw);
  const pr = (raw as { profiles?: unknown }).profiles;
  if (pr && typeof pr === "object") {
    const profiles: NonNullable<ModelGate["profiles"]> = {};
    for (const k of LEVEL_NAMES) {
      const g = parseSingleGate((pr as Record<string, unknown>)[k]);
      if (g) profiles[k] = g;
    }
    if (Object.keys(profiles).length) return { ...(base ?? {}), profiles };
  }
  return base;
}

const LEVEL_NAMES = ["cautious", "balanced", "eager"] as const;
const LEVEL_AT = { cautious: 0, balanced: 0.5, eager: 1 } as const;

/** Aggressiveness as a number in [0, 1] ("balanced" for anything invalid). */
export function aggressivenessLevel(a: Aggressiveness | string | undefined | null): number {
  if (typeof a === "number" && Number.isFinite(a)) return Math.min(1, Math.max(0, a));
  if (typeof a === "string") {
    if (a in LEVEL_AT) return LEVEL_AT[a as keyof typeof LEVEL_AT];
    const n = Number(a);
    if (a.trim() !== "" && Number.isFinite(n)) return Math.min(1, Math.max(0, n));
  }
  return 0.5;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function tierAt(m: ModelGate | undefined, k: "guard" | "heal", trigger: TriggerKind | undefined): number | undefined {
  const t = m?.[k];
  return (trigger ? t?.byTrigger?.[trigger] : undefined) ?? t?.default;
}

/**
 * The single gate for an aggressiveness level from the model's profiles: a named level's own profile, or, between two
 * levels, the nearer profile's kind with thresholds/margins (and report, tauGain) interpolated linearly when both
 * profiles have the same kind. Undefined without profiles.
 */
export function profileGate(model: ModelGate | undefined, level: number, trigger?: TriggerKind): ModelGate | undefined {
  const P = model?.profiles;
  if (!P) return undefined;
  const have = LEVEL_NAMES.filter((n) => P[n]).map((n) => ({ at: LEVEL_AT[n], g: P[n]! }));
  if (!have.length) return undefined;
  let lo = have[0];
  let hi = have[have.length - 1];
  for (const h of have) {
    if (h.at <= level) lo = h;
    if (h.at >= level && hi.at >= h.at) hi = h;
  }
  if (level <= have[0].at) return have[0].g;
  if (level >= have[have.length - 1].at) return have[have.length - 1].g;
  if (lo === hi || lo.at === hi.at) return lo.g;
  const t = (level - lo.at) / (hi.at - lo.at);
  const near = t < 0.5 ? lo.g : hi.g;
  if ((lo.g.kind ?? "mass") !== (hi.g.kind ?? "mass")) return near;
  const out: ModelGate = {};
  if (near.kind) out.kind = near.kind;
  if (lo.g.tauGain !== undefined || hi.g.tauGain !== undefined) out.tauGain = lerp(lo.g.tauGain ?? DEFAULT_TAU_GAIN, hi.g.tauGain ?? DEFAULT_TAU_GAIN, t);
  const dflt = (near.kind === "gain" ? DEFAULT_GAIN_MARGINS : DEFAULT_THRESHOLDS) as { guard: number; heal: number };
  for (const k of ["guard", "heal"] as const) out[k] = { default: lerp(tierAt(lo.g, k, trigger) ?? dflt[k], tierAt(hi.g, k, trigger) ?? dflt[k], t) };
  if (lo.g.report !== undefined || hi.g.report !== undefined) out.report = lerp(lo.g.report ?? DEFAULT_THRESHOLDS.report, hi.g.report ?? DEFAULT_THRESHOLDS.report, t);
  return out;
}

function parseSingleGate(raw: unknown): ModelGate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { kind?: unknown; tauGain?: unknown; report?: unknown; guard?: unknown; heal?: unknown };
  const g: ModelGate = {};
  const gain = r.kind === "gain";
  if (gain) g.kind = "gain";
  if (gain && isNum(r.tauGain) && r.tauGain > 0) g.tauGain = r.tauGain;
  if (isProb(r.report)) g.report = r.report;
  const guard = parseTier(r.guard, gain ? isNum : isProb);
  const heal = parseTier(r.heal, gain ? isNum : isProb);
  if (guard) g.guard = guard;
  if (heal) g.heal = heal;
  return Object.keys(g).length ? g : undefined;
}

/**
 * The thresholds in force for a trigger kind: the app's policy.thresholds override, else the model's meta gate (the
 * trigger's own value, then the tier default), else the defaults (report 0.6, guard 0.9, heal 0.8).
 */
export function effectiveGates(c: PolicyConfig, raw: ModelGate | undefined, trigger?: TriggerKind, level = 0.5): EffectiveGates {
  // the model's gate for this aggressiveness: its profiles, else its single gate (or the defaults) shifted by the level
  const fromProfiles = profileGate(raw, level, trigger);
  const model = fromProfiles ?? raw;
  const kind: GateKind = model?.kind === "gain" ? "gain" : "mass";
  // without profiles: cautious = +0.05 on thresholds / +1 on margins, eager = −0.05 / −1 (linear in the level)
  const shift = fromProfiles ? 0 : (0.5 - level) * 2 * (kind === "gain" ? 1 : 0.05);
  const clampT = (x: number) => {
    const r = Math.round(x * 1e9) / 1e9; // keep 0.9 + 0.05 = 0.95 exactly
    return kind === "gain" ? Math.max(0, r) : Math.min(1, Math.max(0, r));
  };
  const defaults = kind === "gain" ? DEFAULT_GAIN_MARGINS : DEFAULT_THRESHOLDS;
  // the app's overrides are read in the active gate kind (probabilities for "mass", margins for "gain")
  const tier = (k: "guard" | "heal"): [number, GateSource] => {
    const o = c.overrides[k];
    if (o !== undefined) return [o, "policy"];
    const m = model?.[k];
    const v = (trigger ? m?.byTrigger?.[trigger] : undefined) ?? m?.default;
    if (v !== undefined) return [clampT(v + shift), "model"];
    return [clampT(defaults[k] + shift), "default"];
  };
  const [guard, gs] = tier("guard");
  const [heal, hs] = tier("heal");
  const [report, rs]: [number, GateSource] = c.overrides.report !== undefined ? [c.overrides.report, "policy"] : model?.report !== undefined ? [model.report, "model"] : [DEFAULT_THRESHOLDS.report, "default"];
  const out: EffectiveGates = { kind, aggressiveness: level, levelSource: fromProfiles ? "profiles" : "scaled", report, guard, heal, source: { report: rs, guard: gs, heal: hs } };
  const name = LEVEL_NAMES.find((n) => LEVEL_AT[n] === level);
  if (name) out.level = name;
  if (kind === "gain") out.tauGain = model?.tauGain ?? DEFAULT_TAU_GAIN;
  if (trigger) out.trigger = trigger;
  return out;
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
  /** The tier thresholds in force for this trigger (default: policy.thresholds with defaults). */
  thresholds?: { guard: number; heal: number };
  /** The gate kind (default "mass"); "gain" reads `thresholds` as margins in cost units and needs `tauGain`. */
  kind?: GateKind;
  tauGain?: number;
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
  /** The threshold (mass) or margin (gain) the candidate was compared with (its tier), when there was a candidate. */
  threshold?: number;
  thresholdTier?: "guard" | "heal";
  kind: GateKind;
  /** gain kind: ĝ of the candidate. */
  gain?: number;
}

/**
 * The passive action's probability: as given, else the mass the model left over (probabilities sum to 1), clamped to
 * at least MIN_PROB.
 */
export function passiveProb(probabilities: Record<string, number>, passive: string | undefined): number {
  const given = passive !== undefined ? probabilities[passive] : undefined;
  if (typeof given === "number" && Number.isFinite(given)) return Math.max(MIN_PROB, given);
  let rest = 1;
  for (const [k, v] of Object.entries(probabilities)) if (k !== passive && Number.isFinite(v)) rest -= v;
  return Math.max(MIN_PROB, rest);
}

/** ĝ(a) = τ · ln(p(a) / p(passive)), probabilities clamped to ≥ MIN_PROB. */
export function gainOf(tau: number, pa: number, pPassive: number): number {
  return tau * Math.log(Math.max(MIN_PROB, pa) / Math.max(MIN_PROB, pPassive));
}

export function gate(c: PolicyConfig, rate: RateLimiter, g: GateInput): GateOutcome {
  const kind: GateKind = g.kind ?? "mass";
  const A = permittedActions(c, g.mode, g.actions);
  const p = (name: string) => g.probabilities[name] ?? 0;
  let candidate: string | null = null;
  for (const a of A) if (candidate === null || p(a.name) > p(candidate)) candidate = a.name;
  const mass = A.reduce((s, a) => s + p(a.name), 0);
  const topTier = g.actions.find((a) => a.name === g.top)?.tier ?? "passive";
  const wanted = topTier !== "passive"; // a reason is only given when the model's own choice does not run
  const no = (reason: string | null): GateOutcome => ({ run: null, candidate, mass, reason: wanted ? reason : null, kind });
  if (g.paused) return no("GenClass is paused");
  if (!candidate) {
    const top = g.actions.find((a) => a.name === g.top);
    return no(top ? restriction(c, g.mode, top) ?? "no action is permitted" : "no action is permitted");
  }
  const tier = g.actions.find((a) => a.name === candidate)!.tier as "guard" | "heal";
  const T = g.thresholds ?? c.thresholds;
  const th = tier === "guard" ? T.guard : T.heal;
  const top = g.actions.find((a) => a.name === g.top);
  const topRestriction = top && top.tier !== "passive" ? restriction(c, g.mode, top) : null;
  let at: { threshold: number; thresholdTier: "guard" | "heal"; gain?: number };
  if (kind === "gain") {
    // per-action gain over the passive action, in cost units; the best permitted action must clear its tier's margin
    const passive = g.actions.find((a) => a.tier === "passive")?.name;
    const pp = passiveProb(g.probabilities, passive);
    const gain = gainOf(g.tauGain ?? 1, p(candidate), pp);
    at = { threshold: th, thresholdTier: tier, gain };
    if (!(gain > th)) return { ...no(topRestriction ?? `gain ${round2(gain)} of ${candidate} over ${passive ?? "the passive action"} is not above the ${tier} margin ${round2(th)}`), ...at };
  } else {
    at = { threshold: th, thresholdTier: tier };
    if (!(mass >= th)) return { ...no(topRestriction ?? `probability ${mass.toFixed(2)} for the permitted actions (${A.map((a) => a.name).join(", ")}) is below the ${tier} threshold ${round2(th)}`), ...at };
  }
  if (c.requireDiagnosis && g.diagnosis === "expected") return { ...no("the model's diagnosis is expected"), reason: "the model's diagnosis is expected", ...at };
  if (rate.full(g.now)) return { ...no(null), reason: `rate limit: ${c.maxActionsPerMinute} actions in the last minute`, ...at };
  return { run: candidate, candidate, mass, reason: null, kind, ...at };
}

function round2(x: number): string {
  return String(Math.round(x * 100) / 100);
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
