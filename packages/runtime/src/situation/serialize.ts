// Situation serializer (CONTRACT §6): the Jev state object with keys in a fixed order, arrays of strings
// rendered one per line, within a character budget. The budget sets every section's size (compact at 1,100
// chars: top facts, ≤ 2 in-flight, ≤ 3 timeline lines, ≤ 3 state fields, 1 stats line; full at 2,400 chars: 12
// facts, 6 in-flight, 16 timeline lines, 8 state fields, 4 stats lines; linear in between). If the shaped state is
// still over budget: drop timeline lines (oldest first), then state lines, then facts (least informative first),
// then in-flight and stats lines, then shorten facts. Deterministic.

import type { JevState } from "../types.js";
import { truncate } from "../util.js";

/** Full budget ≈ 1,000 tokens of the GenClass tokenizer for this kind of text (≈ 2.4 chars per token, measured). */
export const STATE_CHAR_BUDGET = 2400;
export const COMPACT_BUDGET = 1100;
/** Smallest budget honoured (a trigger sentence and one fact). */
export const MIN_BUDGET = 500;

export interface SituationParts {
  app: string;
  trigger: string;
  facts: string[];
  in_flight: string[];
  timeline: string[];
  state: string[];
  stats: string[];
}

export interface SectionLimits {
  facts: number;
  in_flight: number;
  timeline: number;
  state: number;
  stats: number;
  line: { app: number; trigger: number; facts: number; in_flight: number; timeline: number; state: number; stats: number };
}

/** Full-budget limits (CONTRACT §6). */
export const LIMITS = { facts: 12, in_flight: 6, timeline: 16, state: 8, stats: 4 } as const;

/** Section sizes for a budget: compact at ≤ 1,100 chars, full at ≥ 2,400, linear in between. */
export function sectionLimits(budget: number = STATE_CHAR_BUDGET): SectionLimits {
  const r = Math.min(1, Math.max(0, (budget - COMPACT_BUDGET) / (STATE_CHAR_BUDGET - COMPACT_BUDGET)));
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * r);
  return {
    facts: lerp(6, LIMITS.facts),
    in_flight: lerp(2, LIMITS.in_flight),
    timeline: lerp(3, LIMITS.timeline),
    state: lerp(3, LIMITS.state),
    stats: lerp(1, LIMITS.stats),
    line: {
      app: lerp(60, 120),
      trigger: lerp(180, 240),
      facts: lerp(220, 260),
      in_flight: lerp(90, 120),
      timeline: lerp(100, 140),
      state: lerp(100, 150),
      stats: lerp(110, 140),
    },
  };
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

export function toJevState(p: SituationParts, budget: number = STATE_CHAR_BUDGET): JevState {
  const b = Math.max(MIN_BUDGET, Math.round(budget));
  const L = sectionLimits(b);
  const parts = {
    app: truncate(p.app || "unknown", L.line.app),
    trigger: truncate(p.trigger, L.line.trigger),
    facts: p.facts.slice(0, L.facts).map((s) => truncate(s, L.line.facts)),
    in_flight: p.in_flight.slice(0, L.in_flight).map((s) => truncate(s, L.line.in_flight)),
    timeline: p.timeline.slice(-L.timeline).map((s) => truncate(s, L.line.timeline)),
    state: p.state.slice(0, L.state).map((s) => truncate(s, L.line.state)),
    stats: p.stats.slice(0, L.stats).map((s) => truncate(s, L.line.stats)),
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
    while (size > b && arr.length > floor) {
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
  if (size > b) {
    // one over-long fact or trigger: shorten them to fit
    const over = size - b;
    parts.facts = parts.facts.map((f) => truncate(f, Math.max(60, f.length - over)));
    st = build();
    size = stateChars(st);
    if (size > b) {
      parts.trigger = truncate(parts.trigger, Math.max(60, parts.trigger.length - (size - b)));
      st = build();
    }
  }
  return st;
}
