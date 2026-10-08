// Structural mirror of the runtime's model seam (packages/runtime/src/types.ts, CONTRACT §2/§8). The sim keeps its
// own copy so it compiles independently of CORE's in-flux API; TypeScript's structural typing makes the two
// interchangeable at the createRuntime boundary.

export type JevState = Record<string, unknown>;

export type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface NoulAnswer { type: "noul"; noul: number }
export interface ChoiceAnswer { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
export interface ScoreAnswer { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type TriggerKind =
  | "mutation" | "request" | "delivery" | "failure" | "stall" | "inconsistency" | "transition" | "error" | "ask";

export interface ModelStatus { state: "off" | "loading" | "ready" | "error"; model?: string; error?: string }

/** Structured subject (requested from CORE in sim/NEEDS.md §1). Every field optional: the sim degrades gracefully. */
export interface SubjectInfo {
  kind?: string;
  op?: number;
  mutation?: number;
  store?: string;
  paths?: string[];
  cause?: number;
  error?: unknown;
  invariant?: string;
  [k: string]: unknown;
}

export interface EvaluateRequest {
  trigger: TriggerKind;
  state: JevState;
  questions: Record<string, Question>;
  priority?: number;
  subject?: SubjectInfo | unknown;
  [k: string]: unknown;
}

export interface DecisionProvider {
  readonly status: ModelStatus;
  ready(): Promise<void>;
  evaluate(req: EvaluateRequest): Promise<Record<string, Answer>>;
  onStatus?(fn: (s: ModelStatus) => void): () => void;
  dispose?(): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  afterTask(fn: () => void): void;
}

/** Passive action per trigger (CONTRACT §6: the first listed action). */
export const PASSIVE: Record<string, string> = {
  mutation: "apply",
  request: "send",
  delivery: "deliver",
  failure: "deliver",
  stall: "wait",
  inconsistency: "ignore",
  transition: "ignore",
  error: "ignore",
};

export const DIAGNOSES = [
  "expected", "stale", "conflict", "duplicate", "inconsistent", "failing", "slow", "overload", "unusual", "transient",
] as const;
export type Diagnosis = (typeof DIAGNOSES)[number];

/** CONTRACT-D row. */
export interface Row {
  id: string;
  split: "train" | "dev" | "test";
  family: string;
  state: JevState;
  questions: Record<string, Question>;
  labels: Record<string, Label>;
  meta: Record<string, unknown>;
}

export type Label =
  | { type: "choice"; label: string }
  | { type: "choice"; dist: Record<string, number> }
  | { type: "noul"; p: number }
  | { type: "score"; level: number }
  | { type: "score"; dist: number[] };
