// Worst-case models for the invariant suite (test/invariants/*.test.ts). The runtime's guarantees must hold when the
// model is wrong or hostile, so these providers answer every situation with an alarming diagnosis and probability 1
// on a non-passive action: the most disruptive one offered, a fixed one, or one that was not offered at all
// (an out-of-vocabulary answer). They never answer late unless asked to; ManualDecider (helpers.ts) covers "never".

import type { Answer, ChoiceAnswer, DecisionProvider, EvaluateRequest, ModelStatus } from "../../src/types.js";
import { PASSIVE } from "../../src/situation/questions.js";
import type { FakeClock } from "../helpers.js";

/** Most disruptive first: what a hostile model would reach for when offered. */
export const HARMFUL_ORDER = ["discard", "block", "serve_cached", "retry", "coalesce", "hedge", "rollback", "resync", "delay", "defer"];

export type Pick = (req: EvaluateRequest, offered: string[]) => string;

/** The most disruptive offered non-passive action (else the passive one). */
export const harmful: Pick = (req, offered) => HARMFUL_ORDER.find((a) => offered.includes(a)) ?? offered.find((a) => a !== PASSIVE[req.trigger]) ?? offered[0];

/** Always this action, offered or not (probability 1 on it: an out-of-vocabulary answer when it is not offered). */
export const insist =
  (action: string): Pick =>
  () =>
    action;

function certain(choice: string, labels: string[]): ChoiceAnswer {
  const probabilities: Record<string, number> = {};
  for (const l of labels) probabilities[l] = 0;
  probabilities[choice] = 1;
  return { type: "choice", choice, confidence: 1, probabilities };
}

export class Adversary implements DecisionProvider {
  status: ModelStatus = { state: "ready", model: "adversary" };
  calls: EvaluateRequest[] = [];
  /** Answer after this many ms of the fake clock (0: at once). */
  latencyMs = 0;
  clock?: FakeClock;
  constructor(public pick: Pick = harmful) {}
  ready(): Promise<void> {
    return Promise.resolve();
  }
  evaluate(req: EvaluateRequest): Promise<Record<string, Answer>> {
    this.calls.push(req);
    const out: Record<string, Answer> = {};
    for (const [qid, q] of Object.entries(req.questions)) {
      if (q.type === "choice") {
        const labels = Object.keys(q.criteria);
        if (qid === "diagnosis") out[qid] = certain(labels.find((l) => l !== "expected") ?? labels[0], labels);
        else if (qid === "action") out[qid] = certain(this.pick(req, labels), labels);
        else out[qid] = certain(labels[labels.length - 1], labels);
      } else if (q.type === "noul") out[qid] = { type: "noul", noul: 1 };
      else out[qid] = { type: "score", score: 1, confidence: 1, probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 0 ? 1 : 0])) };
    }
    if (this.latencyMs > 0 && this.clock) {
      const c = this.clock;
      return new Promise((resolve) => c.setTimeout(() => resolve(out), this.latencyMs));
    }
    return Promise.resolve(out);
  }
}

/** The non-passive actions that ran (ok or not), as "trigger:action". */
export function ran(rt: { interventions(): { trigger: string; action: string; ok: boolean }[] }): string[] {
  return rt.interventions().map((a) => `${a.trigger}:${a.action}${a.ok ? "" : "(failed)"}`);
}
