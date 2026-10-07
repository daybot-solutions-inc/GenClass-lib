// Feature combinators: each feature is a small real app slice (stores, endpoints, async handlers, user actions)
// with randomised knobs that choose correct guards or injected defects. Programs compose 1-3 features.

import type { Rng } from "../rng.js";
import type { ApiStyle, Db, VirtualServer } from "../net/server.js";
import type { AppEnv } from "./env.js";
import type { Kit } from "./kit.js";
import type { Naming } from "./naming.js";
import type { Domain, Entity } from "./vocab.js";

export type UiKind = "click" | "type" | "change" | "submit" | "key" | "nav";

export interface StepIntent {
  kind: string;
  key: string;
  mode: "replace" | "accumulate";
  accidental: boolean;
}

export interface UserStep {
  t: number;
  feature: string;
  action: string;
  ui: { kind: UiKind; target: string; value?: string };
  args?: Record<string, unknown>;
  intent: StepIntent;
  /** Condition (feature-defined) checked at step time; the step is skipped when false. */
  when?: string;
  /** Index (within the session) of the step this one repeats. */
  repeatOf?: number;
}

export interface WorldCtx {
  db: Db;
  server: VirtualServer;
  publish(topic: string, msg: unknown): void;
  now(): number;
}

export interface ExternalEvent {
  t: number;
  feature: string;
  desc: string;
  apply(w: WorldCtx): void;
}

/** A relation the app intends to maintain between store fields (ground truth for `inconsistent`). */
export interface Relation {
  fields: string[];
  desc: string;
  /** Does the relation hold in this client snapshot (store name -> value)? */
  check: (stores: Record<string, unknown>) => boolean;
}

type Obj = Record<string, unknown>;
const near = (a: unknown, b: unknown) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.011;
/** Helpers to write relation checks. */
export const rel = {
  field(stores: Obj, path: string): unknown {
    const [store, ...rest] = path.split(".");
    let v: unknown = stores[store!];
    for (const k of rest) v = v && typeof v === "object" ? (v as Obj)[k] : undefined;
    return v;
  },
  near,
};

export interface FeatureCtx {
  rng: Rng;
  domain: Domain;
  entity: Entity;
  naming: Naming;
  api: ApiStyle;
  id: string;
  /** Route (view) the feature lives on. */
  route: string;
}

export interface FeatureClient {
  init?(): void;
  /** Handle a user step; `intent` is the intent id the runner recorded for it. */
  handle(step: UserStep, intent: number): void;
  cond?(name: string): boolean;
}

export interface FeatureDef<S> {
  kind: string;
  make(ctx: FeatureCtx): S;
  /** Structural signature of the variant (guards/defects/shape), for families and held-out patterns. */
  pattern(spec: S): string[];
  server(spec: S, srv: VirtualServer, db: Db): void;
  client(spec: S, env: AppEnv, kit: Kit): FeatureClient;
  session(spec: S, user: UserModel, win: { t0: number; t1: number }): UserStep[];
  external?(spec: S, rng: Rng, win: { t0: number; t1: number }): ExternalEvent[];
  relations?(spec: S): Relation[];
}

// ------------------------------------------------------------------------------------------------ user model

export interface Persona {
  /** Median ms between keystrokes. */
  keyMs: number;
  keySigma: number;
  /** Median think time between actions. */
  thinkMs: number;
  /** P(accidental double click) per click. */
  doubleClickP: number;
  /** P(re-clicking a button whose operation is still pending), checked at the impatience time. */
  impatientP: number;
  impatienceMs: number;
  /** P(typo + backspace) per word. */
  typoP: number;
}

export function randomPersona(rng: Rng): Persona {
  return {
    keyMs: rng.float(70, 210),
    keySigma: rng.float(0.25, 0.6),
    thinkMs: rng.float(500, 2600),
    doubleClickP: rng.weighted([[0, 3], [0.06, 3], [0.18, 2], [0.4, 1]] as const),
    impatientP: rng.weighted([[0, 3], [0.3, 3], [0.7, 2]] as const),
    impatienceMs: rng.float(900, 3500),
    typoP: rng.float(0, 0.25),
  };
}

export class UserModel {
  constructor(
    readonly rng: Rng,
    readonly p: Persona,
    readonly feature: string,
  ) {}

  think(mul = 1): number {
    return Math.max(120, this.rng.lognormal(this.p.thinkMs * mul, 0.5));
  }

  key(): number {
    return Math.max(25, this.rng.lognormal(this.p.keyMs, this.p.keySigma));
  }

  /**
   * Type `text` into an input that already contains `prefix`. One step per keystroke (value = full input text),
   * occasional typo + backspace. Returns steps and end time.
   */
  type(t: number, prefix: string, text: string, target: string, action: string, key: string, args?: Record<string, unknown>): { steps: UserStep[]; t: number } {
    const steps: UserStep[] = [];
    let cur = prefix;
    const push = (v: string) => {
      t += this.key();
      cur = v;
      const s: UserStep = { t, feature: this.feature, action, ui: { kind: "type", target, value: v }, intent: { kind: action, key, mode: "replace", accidental: false } };
      if (args) s.args = args;
      steps.push(s);
    };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch !== " " && this.rng.next() < this.p.typoP / 6) {
        push(cur + String.fromCharCode(97 + this.rng.int(0, 25)));
        t += this.rng.float(80, 400);
        push(cur.slice(0, -1));
      }
      push(cur + ch);
      if (ch === " " && this.rng.bool(0.3)) t += this.rng.float(150, 700);
    }
    return { steps, t };
  }

  /** A click with optional accidental double click and impatient re-click (conditional on `pendingCond`). */
  click(
    t: number,
    target: string,
    action: string,
    intent: { kind: string; key: string; mode?: "replace" | "accumulate" },
    opts: { args?: Record<string, unknown>; pendingCond?: string; kind?: UiKind; value?: string; doubleP?: number } = {},
  ): { steps: UserStep[]; t: number } {
    const mode = intent.mode ?? "accumulate";
    const base: UserStep = {
      t,
      feature: this.feature,
      action,
      ui: { kind: opts.kind ?? "click", target },
      intent: { kind: intent.kind, key: intent.key, mode, accidental: false },
    };
    if (opts.value !== undefined) base.ui.value = opts.value;
    if (opts.args) base.args = opts.args;
    const steps: UserStep[] = [base];
    const dp = opts.doubleP ?? this.p.doubleClickP;
    if (this.rng.next() < dp) {
      const d: UserStep = { ...base, t: t + this.rng.float(45, 190), intent: { ...base.intent, accidental: true }, repeatOf: -1 };
      steps.push(d);
    }
    if (opts.pendingCond && this.rng.next() < this.p.impatientP) {
      const n = this.rng.int(1, 3);
      let tt = t + this.p.impatienceMs * this.rng.float(0.7, 1.4);
      for (let i = 0; i < n; i++) {
        steps.push({ ...base, t: tt, intent: { ...base.intent, accidental: true }, when: opts.pendingCond, repeatOf: -1 });
        tt += this.rng.float(300, 1500);
      }
    }
    return { steps, t };
  }
}

/** Pick an item name from entity words. */
export function itemName(rng: Rng, e: Entity, i: number): string {
  const w = e.words;
  if (w.length === 0) return `${e.s} ${i + 1}`;
  const a = w[i % w.length]!;
  if (i < w.length) return a;
  return `${a} ${rng.pick(w)}`;
}

export function numIn(rng: Rng, lo: number, hi: number, dec: number): number {
  const v = rng.float(lo, hi);
  const f = 10 ** dec;
  return Math.round(v * f) / f;
}

/** Round money-like values to cents (app code uses this for derived totals). */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
