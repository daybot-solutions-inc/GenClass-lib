// Explicit, documented post-transform of the runtime's standing questions for training rows (CONTRACT §11:
// "randomise the action option order/subsets and the diagnosis description paraphrases/subsets per row").
// Wording is randomised *through the runtime* per trajectory (CreateOptions.vocabulary.diagnoses / .actions, see
// world/scenario.ts; paraphrases below), so description text is exactly what the runtime builds. This transform
// only does what the runtime has no option for (mirror exactly):
//   - 50% of rows: unchanged (the runtime's order).
//   - otherwise: action option order shuffled with p = 0.5 (the GenClass heads are order-invariant; harmless);
//     with p = 0.12, one non-passive action that is not the label's best is dropped (needs >= 3 options; this
//     mirrors `policy.deny`), and the soft label is renormalised over the remaining options.
// The instructions text and descriptions are never changed here.

import type { Rng } from "../rng.js";
import type { Question } from "../types.js";

export const ACTION_PARA: Record<string, string[]> = {
  apply: ["apply this write to the state", "let the update go through", "accept this change now"],
  discard: ["throw this write away and keep what is there", "ignore this update; keep the current state", "drop the incoming change"],
  defer: ["wait for the related requests to finish before deciding on this write", "postpone this write until in-flight work completes", "hold the change until the overlapping operations settle"],
  send: ["let the request go out as is", "send it now", "proceed with this request"],
  coalesce: ["reuse the response of the identical request instead of sending another", "piggyback on the matching request already in flight", "merge with the identical in-flight request"],
  delay: ["back off before sending so the service can recover", "send it later, after a pause", "wait a little and then send"],
  block: ["refuse to send this request and fail it right away", "cancel the request immediately", "stop this request from being sent"],
  serve_cached: ["respond with the last good response for this request", "use the cached result instead of the network", "answer from the cache"],
  deliver: ["let the application see the failure", "pass the error through unchanged", "report the failure to the app"],
  retry: ["try the request again after a short wait", "re-send the request after backing off", "attempt the request once more"],
  wait: ["keep waiting for the response", "let the request continue", "do nothing and keep waiting"],
  hedge: ["fire a duplicate request and take the first answer", "race a second identical request against this one", "send a backup copy of the request"],
  ignore: ["leave things as they are", "take no action", "do not change the state"],
  rollback: ["restore the state to its last consistent snapshot", "undo back to the last known-good state", "revert the affected state"],
  resync: ["reload the affected state from its source", "refetch the state from the server", "resynchronise the store"],
};

export interface Transformed {
  questions: Record<string, Question>;
  dist?: Record<string, number>;
  variant: string;
}

export function transformQuestions(qs: Record<string, Question>, dist: Record<string, number> | undefined, passive: string, best: string, rng: Rng): Transformed {
  if (rng.bool(0.5)) return { questions: qs, ...(dist ? { dist } : {}), variant: "default" };
  const out: Record<string, Question> = {};
  let nd = dist ? { ...dist } : undefined;
  const parts: string[] = [];
  for (const [qid, q] of Object.entries(qs)) {
    if (qid !== "action" || q.type !== "choice") {
      out[qid] = q;
      continue;
    }
    let keys = Object.keys(q.criteria);
    if (keys.length >= 3 && rng.bool(0.12)) {
      const droppable = keys.filter((k) => k !== passive && k !== best);
      if (droppable.length) {
        const d = rng.pick(droppable);
        keys = keys.filter((k) => k !== d);
        parts.push(`drop:${d}`);
        if (nd) {
          delete nd[d];
          const z = Object.values(nd).reduce((a, b) => a + b, 0) || 1;
          for (const k of Object.keys(nd)) nd[k] = Math.round((nd[k]! / z) * 1e4) / 1e4;
        }
      }
    }
    if (rng.bool(0.5)) {
      keys = rng.shuffle(keys);
      parts.push("shuffle");
    }
    const crit: Record<string, string | null> = {};
    for (const k of keys) crit[k] = q.criteria[k] ?? null;
    out[qid] = { type: "choice", instructions: q.instructions, criteria: crit };
  }
  return { questions: out, ...(nd ? { dist: nd } : {}), variant: parts.join(",") || "default" };
}
