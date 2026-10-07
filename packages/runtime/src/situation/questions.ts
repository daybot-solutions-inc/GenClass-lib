// Standing questions, the action catalogue (descriptions + tiers, CONTRACT §7) and the diagnosis vocabulary
// (CONTRACT §6). The wording here is what the model reads; the sim uses this module unchanged.

import type { Question, Tier, TriggerKind, Vocabulary } from "../types.js";

export interface BuiltinAction {
  name: string;
  tier: Tier;
  description: string;
}

export const BUILTIN_ACTIONS: Record<string, BuiltinAction> = {
  apply: { name: "apply", tier: "passive", description: "let this write update the state now" },
  discard: { name: "discard", tier: "guard", description: "drop this write and keep the current state" },
  defer: { name: "defer", tier: "guard", description: "hold this write until the related in-flight operations finish, then decide again" },
  send: { name: "send", tier: "passive", description: "send the request now" },
  coalesce: { name: "coalesce", tier: "guard", description: "do not send; reuse the result of the identical request that is in flight or just finished" },
  delay: { name: "delay", tier: "guard", description: "wait before sending, backing off so the service can recover" },
  block: { name: "block", tier: "heal", description: "do not send; fail this request immediately" },
  serve_cached: { name: "serve_cached", tier: "heal", description: "answer with the last successful response for this request instead" },
  deliver: { name: "deliver", tier: "passive", description: "pass the failure to the application as it is" },
  retry: { name: "retry", tier: "heal", description: "retry the request after a short backoff" },
  wait: { name: "wait", tier: "passive", description: "keep waiting for the request" },
  hedge: { name: "hedge", tier: "heal", description: "send a second identical request and use whichever answers first" },
  ignore: { name: "ignore", tier: "passive", description: "leave the state as it is" },
  rollback: { name: "rollback", tier: "heal", description: "restore the affected state to its last consistent snapshot" },
  resync: { name: "resync", tier: "heal", description: "reload the affected state from its source" },
};

/** Built-in actions per trigger, passive first (CONTRACT §6). */
export const TRIGGER_ACTIONS: Record<TriggerKind, string[]> = {
  mutation: ["apply", "discard", "defer"],
  request: ["send", "coalesce", "delay", "block", "serve_cached"],
  failure: ["deliver", "retry", "serve_cached"],
  stall: ["wait", "hedge", "serve_cached"],
  inconsistency: ["ignore", "rollback", "resync"],
  transition: ["ignore", "rollback", "resync"],
  error: ["ignore", "rollback"],
  ask: [],
};

export const PASSIVE: Record<TriggerKind, string> = {
  mutation: "apply",
  request: "send",
  failure: "deliver",
  stall: "wait",
  inconsistency: "ignore",
  transition: "ignore",
  error: "ignore",
  ask: "",
};

export const ACTION_INSTRUCTIONS: Record<TriggerKind, string> = {
  mutation: "What should the runtime do with this write?",
  request: "What should the runtime do with this request?",
  failure: "What should the runtime do with this failed request?",
  stall: "What should the runtime do with this slow request?",
  inconsistency: "What should the runtime do about this inconsistent state?",
  transition: "What should the runtime do about this unusual state change?",
  error: "What should the runtime do about this error?",
  ask: "",
};

export const DIAGNOSIS_INSTRUCTIONS = "What is happening here?";

export const DEFAULT_DIAGNOSES: Record<string, string> = {
  expected: "normal behaviour, nothing is wrong",
  stale: "outdated data or an older operation is about to replace newer state",
  conflict: "concurrent operations are competing over the same state or resource",
  duplicate: "the same change or request is happening again without a new intent",
  inconsistent: "the state contradicts itself or relationships it normally keeps",
  failing: "an operation keeps failing or its failures follow a pattern",
  slow: "an operation is far slower than usual",
  overload: "work is being triggered far more often than usual",
  unusual: "this differs from how the same operation normally behaves",
  transient: "a one-off failure that is likely to succeed if tried again",
};

/** Situations at or below this many characters use compact questions (bare labels and action names). */
export const COMPACT_QUESTIONS_BUDGET = 1400;
/** In compact questions a vocabulary override description is kept only up to this length. */
const COMPACT_DESC_MAX = 24;

export function diagnosisVocabulary(vocab: Vocabulary | undefined, pluginLabels: Record<string, string>[]): Record<string, string> {
  const base: Record<string, string> = { ...(vocab?.diagnoses ?? DEFAULT_DIAGNOSES) };
  if (!("expected" in base)) base.expected = DEFAULT_DIAGNOSES.expected;
  for (const p of pluginLabels) for (const [k, v] of Object.entries(p)) if (!(k in base)) base[k] = v;
  // "expected" always first: it is the passive diagnosis.
  const { expected, ...rest } = base;
  return { expected, ...rest };
}

export function actionDescription(name: string, vocab: Vocabulary | undefined, custom?: string): string {
  return vocab?.actions?.[name] ?? custom ?? BUILTIN_ACTIONS[name]?.description ?? name;
}

/**
 * The standing questions for a trigger. `compact` (small situation budgets): diagnosis options are bare labels and
 * action options bare names (null descriptions, rendered as the label by the packer), except vocabulary overrides
 * of at most 24 characters. Same instructions either way.
 */
export function buildQuestions(
  trigger: TriggerKind,
  actions: { name: string; description: string }[],
  diagnoses: Record<string, string>,
  extra: Record<string, Question>,
  compact = false,
  vocab?: Vocabulary,
): Record<string, Question> {
  const qs: Record<string, Question> = {};
  if (trigger === "ask") return { ...extra };
  const short = (override: string | undefined): string | null => (override && override.length <= COMPACT_DESC_MAX ? override : null);
  const dcrit: Record<string, string | null> = {};
  for (const [label, desc] of Object.entries(diagnoses)) dcrit[label] = compact ? short(vocab?.diagnoses?.[label]) : desc;
  qs.diagnosis = { type: "choice", instructions: DIAGNOSIS_INSTRUCTIONS, criteria: dcrit };
  if (actions.length > 1) {
    const criteria: Record<string, string | null> = {};
    for (const a of actions) criteria[a.name] = compact ? short(vocab?.actions?.[a.name]) : a.description;
    qs.action = { type: "choice", instructions: ACTION_INSTRUCTIONS[trigger], criteria };
  }
  for (const [k, q] of Object.entries(extra)) if (!(k in qs)) qs[k] = q;
  return qs;
}
