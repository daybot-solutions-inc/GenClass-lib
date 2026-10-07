// The slice of the runtime API the sim uses (CONTRACT §2/§8), and how it is loaded. Data generation always uses
// the real `createRuntime` from @genclass/runtime; the fake runtime (test/fake-runtime.ts) exists only so the sim's
// own unit tests can run without it.

import type { Clock, DecisionProvider, JevState, Question } from "../types.js";

export interface AtomLike<T> {
  readonly name: string;
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: (v: T) => void): () => void;
}

export interface SituationLike {
  trigger?: string;
  subject?: unknown;
  state: JevState;
  questions: Record<string, Question>;
  actions?: string[];
  salient?: boolean;
  facts?: string[];
}

export interface RuntimeLike {
  atom<T>(name: string, initial: T, opts?: { resync?: () => Promise<unknown> | unknown }): AtomLike<T>;
  user<T>(action: { kind: string; target?: string; value?: string }, handler?: () => T): T | undefined;
  reportError(error: unknown, info?: { source?: string }): void;
  situation(trigger?: string): SituationLike;
  on(type: string, fn: (v: unknown) => void): () => void;
  destroy(): void;
  decisions?(n?: number): unknown[];
  inflight?(): unknown[];
}

export interface RuntimeHooksLike {
  opCreated?(op: { id: number; kind: string; name: string; cause?: number }): void;
  mutationProposed?(m: { id: number; store: string; paths: string[]; cause?: number }): void;
}

export interface RuntimeOptions {
  clock: Clock;
  global: object;
  decider: DecisionProvider;
  /** Diagnosis vocabulary override (label -> description), through the runtime's `vocabulary.diagnoses`. */
  diagnoses?: Record<string, string>;
  /** Action description overrides, through the runtime's `vocabulary.actions`. */
  actions?: Record<string, string>;
  hooks?: RuntimeHooksLike;
  app: () => { title?: string; route?: string };
}

export type RuntimeFactory = (o: RuntimeOptions) => RuntimeLike;

/** Options passed to createRuntime for every sim run. */
export function createOptions(o: RuntimeOptions): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    clock: o.clock,
    global: o.global,
    decider: o.decider,
    model: false,
    mode: "heal",
    report: "silent",
    observe: { fetch: true, timers: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false },
    triage: "salient",
    policy: { thresholds: { report: 0, guard: 0, heal: 0 }, holdBudgetMs: 1e9, maxActionsPerMinute: 1e9, requireDiagnosis: false },
    historySize: 500,
    app: o.app,
  };
  const vocabulary: Record<string, unknown> = {};
  if (o.diagnoses) vocabulary.diagnoses = o.diagnoses;
  if (o.actions) vocabulary.actions = o.actions;
  if (Object.keys(vocabulary).length) opts.vocabulary = vocabulary;
  if (o.hooks) opts.hooks = o.hooks;
  return opts;
}

let cached: RuntimeFactory | null = null;

/** Load the real runtime's createRuntime (throws if it is not available). */
export async function realRuntimeFactory(): Promise<RuntimeFactory> {
  if (cached) return cached;
  // Non-literal specifier: the sim compiles without the runtime's type declarations (CORE's API is in flux).
  const spec = process.env.GENCLASS_RUNTIME ?? "@genclass/runtime";
  const mod = (await import(spec)) as unknown as { createRuntime?: (o: Record<string, unknown>) => RuntimeLike };
  if (typeof mod.createRuntime !== "function") throw new Error("@genclass/runtime does not export createRuntime yet");
  const create = mod.createRuntime;
  cached = (o) => create(createOptions(o));
  return cached;
}
