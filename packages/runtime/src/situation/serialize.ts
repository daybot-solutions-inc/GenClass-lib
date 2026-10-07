// Situation serializer (CONTRACT §6): the Jev state object with keys in a fixed order, arrays of strings
// rendered one per line, within a character budget that keeps the packed state under ~1,000 model tokens.
// Truncation order: timeline (oldest first), then state (least relevant first), then facts (least informative
// first), then over-long lines.

import type { JevState } from "../types.js";
import { truncate } from "../util.js";

/** ≈ 1,000 tokens of the GenClass tokenizer for this kind of text (≈ 3.2 chars per token). */
export const STATE_CHAR_BUDGET = 3200;

export const LIMITS = { facts: 12, in_flight: 6, timeline: 16, state: 8, stats: 4 } as const;
const LINE = { app: 120, trigger: 240, facts: 260, in_flight: 120, timeline: 140, state: 150, stats: 140 } as const;

export interface SituationParts {
  app: string;
  trigger: string;
  facts: string[];
  in_flight: string[];
  timeline: string[];
  state: string[];
  stats: string[];
}

const KEYS = ["app", "trigger", "facts", "in_flight", "timeline", "state", "stats"] as const;

function segText(v: unknown): string {
  if (Array.isArray(v)) return v.join("\n");
  return String(v);
}

/** Characters of the rendered state ("key: text" segments, one separator each). */
export function stateChars(state: JevState): number {
  let n = 0;
  for (const [k, v] of Object.entries(state)) n += k.length + 2 + segText(v).length + 1;
  return n;
}

/** The text the model reads for a state (segments joined with newlines), for logs and explain(). */
export function stateText(state: JevState): string {
  return Object.entries(state)
    .map(([k, v]) => (Array.isArray(v) ? `${k}:\n${v.map((x) => `  ${x}`).join("\n")}` : `${k}: ${segText(v)}`))
    .join("\n");
}

export function toJevState(p: SituationParts, budget = STATE_CHAR_BUDGET): JevState {
  const parts = {
    app: truncate(p.app || "unknown", LINE.app),
    trigger: truncate(p.trigger, LINE.trigger),
    facts: p.facts.slice(0, LIMITS.facts).map((s) => truncate(s, LINE.facts)),
    in_flight: p.in_flight.slice(0, LIMITS.in_flight).map((s) => truncate(s, LINE.in_flight)),
    timeline: p.timeline.slice(-LIMITS.timeline).map((s) => truncate(s, LINE.timeline)),
    state: p.state.slice(0, LIMITS.state).map((s) => truncate(s, LINE.state)),
    stats: p.stats.slice(0, LIMITS.stats).map((s) => truncate(s, LINE.stats)),
  };
  const build = (): JevState => {
    const st: JevState = {};
    for (const k of KEYS) {
      const v = parts[k];
      if (Array.isArray(v)) st[k] = v.length ? [...v] : "none";
      else st[k] = v;
    }
    return st;
  };
  let st = build();
  let size = stateChars(st);
  const shrink = (arr: string[], fromStart: boolean, floor: number) => {
    while (size > budget && arr.length > floor) {
      if (fromStart) arr.shift();
      else arr.pop();
      st = build();
      size = stateChars(st);
    }
  };
  shrink(parts.timeline, true, 0);
  shrink(parts.state, false, 0);
  shrink(parts.facts, false, 1);
  shrink(parts.in_flight, false, 0);
  shrink(parts.stats, false, 0);
  if (size > budget) {
    // pathological: one over-long fact; cut lines to fit
    const over = size - budget;
    parts.facts = parts.facts.map((f) => truncate(f, Math.max(40, f.length - over)));
    st = build();
  }
  return st;
}
