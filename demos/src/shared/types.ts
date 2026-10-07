import type { Chaos } from "./chaos.ts";
import type { DemoId } from "./protocol.ts";

export type { DemoId };

/** Demo mode: off = runtime installed in observe mode with no model (the baseline). */
export type GcMode = "off" | "guard" | "heal";
export const MODES: GcMode[] = ["off", "guard", "heal"];

/** chaos = randomized environment chaos and stressed user behaviour; clean = no chaos, calm user, app is correct. */
export type TrialKind = "chaos" | "clean";

/** Scripted user/session steps. Executed by the synthetic in-page driver or by Playwright with real input. */
export type Step =
  | { k: "type"; sel: string; text: string; delays: number[] }
  | { k: "key"; sel: string; key: "Backspace" | "Enter" | "Escape" | "Tab" | "ArrowLeft" | "ArrowRight"; delays: number[] }
  | { k: "click"; sel: string; count?: number; gap?: number; unless?: string }
  | { k: "focus"; sel: string }
  | { k: "caret"; sel: string; pos: "end" | "start" | number }
  | { k: "wait"; ms: number }
  | { k: "until"; cond: string; timeout: number }
  | { k: "chaos"; patch: Partial<Chaos> }
  | { k: "server"; action: string; args?: unknown }
  | { k: "mark"; name: string };

export interface Scenario {
  seed: number;
  kind: TrialKind;
  chaos: Partial<Chaos>;
  /** Parameters for the server world (e.g. teammate activity). */
  params: Record<string, unknown>;
  steps: Step[];
  /** What the scripted user intends; read only by the oracle. */
  intent: Record<string, unknown>;
  /** Short label for tables ("typo + correction", "impatient double click"). */
  label: string;
}

export interface Score {
  bug: boolean;
  reasons: string[];
  metrics: Record<string, number>;
}

export interface InterventionSummary {
  action: string;
  tier: string;
  trigger: string;
  changed: string;
  at: number;
}

export interface GcStats {
  runtime: "real" | "shim";
  /** The page was cross-origin isolated (WASM threads possible). */
  isolated?: boolean;
  status: string;
  /** Model name/version as reported by the runtime (ModelStatus.model). */
  model?: string;
  device?: string;
  variant?: string;
  loadMs?: number;
  decisions: number;
  detections: number;
  /** Decisions whose non-passive action was not executed, by reason. */
  notExecuted: Record<string, number>;
  interventions: InterventionSummary[];
  decisionLatencyMs: number[];
  diagnoses: Record<string, number>;
}

export interface TrialResult extends Score {
  demo: DemoId;
  mode: GcMode;
  kind: TrialKind;
  seed: number;
  label: string;
  durationMs: number;
  gc: GcStats;
  driver: "synthetic" | "playwright";
  error?: string;
}
