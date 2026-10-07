// Canonical text serialization of state and questions: port of jev_local/serialize.py (via the GenClass
// extension's core/serialize.js). The trainer runs the Python original on the JSON rows the sim writes, so this
// port renders every value exactly as Python renders it *after a JSON round trip*: undefined keys disappear,
// NaN/Infinity become null, Dates become strings, numbers print like Python ints/floats.
//
// Questions use the Jev wire shape {type, instructions, criteria}. Choice criteria may be a plain object or a Map
// (a Map keeps the order of integer-like labels, which plain objects would sort first).

import type { Question } from "../types.js";
import { ModelInputError } from "./errors.js";
import { pyNumber, pyStrip } from "./pyutil.js";

export const MAX_ARRAY_SEGMENTS = 64;

export const DEFAULT_NOUL_INSTR = "Is the statement true of the state?";
export const DEFAULT_CHOICE_INSTR = "Which option best fits the state?";
export const DEFAULT_SCORE_INSTR = "Which level best describes the state?";

export interface Segment {
  /** "" for a bare string state, the object key, or "[i]" for array items. */
  key: string;
  text: string;
}

export type BlockKind = "noul" | "choice" | "score";

export interface QBlock {
  qid: string;
  kind: BlockKind;
  /** Instructions text (question ids are never shown to the model, as in Jev). */
  header: string;
  /** choice: "label: desc" | "label"; score: level texts; noul: [true, false] criteria. */
  items: string[];
  /** choice labels / score "0".."n-1" / noul ["true", "false"]. */
  labels: string[];
}

/** A question whose choice criteria may also be given as a Map (label order preserved). */
export type WireQuestion =
  | Question
  | { type: "choice"; instructions?: unknown; criteria: Map<string, unknown> | Record<string, unknown> }
  | { type: "noul"; instructions?: unknown; criteria?: { true?: unknown; false?: unknown } | null }
  | { type: "score"; instructions?: unknown; criteria: unknown[] };

// ------------------------------------------------------------------------------------------- JSON semantics

/**
 * The value Python sees after `json.loads(JSON.stringify(v))`, keeping Maps (as ordered maps) so choice criteria
 * survive. Throws ModelInputError for values JSON cannot carry (BigInt, cycles).
 */
export function toJsonValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === "string" || t === "boolean") return v;
  if (t === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Map) {
    const m = new Map<string, unknown>();
    for (const [k, x] of v) if (x !== undefined && typeof x !== "function" && typeof x !== "symbol") m.set(String(k), toJsonValue(x));
    return m;
  }
  try {
    const s = JSON.stringify(v);
    return s === undefined ? null : (JSON.parse(s) as unknown);
  } catch (e) {
    throw new ModelInputError(`state is not JSON-serializable: ${(e as Error).message}`);
  }
}

/** json.dumps(v, ensure_ascii=False, separators=(", ", ": ")) of a JSON value. */
export function pyJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return Number.isFinite(v) ? pyNumber(v) : "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyJson).join(", ")}]`;
  if (v instanceof Map) return `{${[...v].map(([k, x]) => `${JSON.stringify(String(k))}: ${pyJson(x)}`).join(", ")}}`;
  if (typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(", ")}}`;
  return JSON.stringify(String(v));
}

const isObj = (e: unknown): e is Record<string, unknown> | Map<string, unknown> =>
  e !== null && typeof e === "object" && !Array.isArray(e);
const entriesOf = (e: Record<string, unknown> | Map<string, unknown>): [string, unknown][] =>
  e instanceof Map ? [...e] : Object.entries(e);
const allStrings = (a: unknown[]): boolean => a.every((x) => typeof x === "string");

// --------------------------------------------------------------------------------------------- entries

/** entry_text: render an entry (str | dict | list | None | scalar) as compact, stable text. */
export function entryText(e: unknown): string {
  if (e === null || e === undefined) return "";
  if (typeof e === "string") return pyStrip(e);
  if (Array.isArray(e)) {
    if (allStrings(e)) return e.map(entryText).filter((p) => p).join("; ");
    return pyJson(e);
  }
  if (isObj(e)) {
    const lines: string[] = [];
    for (const [k, v] of entriesOf(e)) {
      const nested = isObj(v) || (Array.isArray(v) && !allStrings(v));
      lines.push(nested ? `${k}: ${pyJson(v)}` : `${k}: ${entryText(v)}`);
    }
    return lines.join(" | ");
  }
  if (typeof e === "boolean") return e ? "True" : "False";
  if (typeof e === "number") return Number.isFinite(e) ? pyNumber(e) : "";
  return String(e);
}

function valueText(v: unknown): string {
  if (Array.isArray(v) && allStrings(v)) return v.join("\n"); // element lists etc. read one per line
  return entryText(v);
}

/** state_segments: one segment per top-level key of an object state, per array item, or one for a string. */
export function stateSegments(state: unknown, maxItems = MAX_ARRAY_SEGMENTS): Segment[] {
  const s = toJsonValue(state);
  if (typeof s === "string") return [{ key: "", text: pyStrip(s) }];
  if (Array.isArray(s)) {
    const segs = s.slice(0, maxItems).map((x, i) => ({ key: `[${i}]`, text: entryText(x) }));
    if (s.length > maxItems) segs.push({ key: `[${maxItems}:]`, text: s.slice(maxItems).map(entryText).join("\n") });
    return segs;
  }
  if (isObj(s)) return entriesOf(s).map(([k, v]) => ({ key: String(k), text: valueText(v) }));
  if (s === null) return [{ key: "", text: "None" }];
  if (typeof s === "boolean") return [{ key: "", text: s ? "True" : "False" }];
  if (typeof s === "number") return [{ key: "", text: pyNumber(s) }];
  return [{ key: "", text: String(s) }];
}

/** Packer.segment_text. */
export const segmentText = (s: Segment): string => (s.key ? `${s.key}: ${s.text}` : s.text);

/** state_text: the whole state as one document (the decoder engine's view; handy for logs and devtools). */
export function stateText(state: unknown): string {
  return stateSegments(state)
    .map((s) => (s.key ? `${s.key}:\n${s.text}` : s.text))
    .join("\n\n");
}

// -------------------------------------------------------------------------------------------- questions

function bareLabel(label: string, desc: unknown): boolean {
  if (desc === null || desc === undefined) return true;
  if (typeof desc === "string") {
    const d = pyStrip(desc);
    return d === "" || d === pyStrip(label);
  }
  return false;
}

/** Choice criteria as ordered [label, description] pairs (object or Map). */
export function criteriaEntries(c: unknown): [string, unknown][] {
  if (c instanceof Map) return [...c].map(([k, v]) => [String(k), v]);
  if (c && typeof c === "object" && !Array.isArray(c)) return Object.entries(c as Record<string, unknown>);
  return [];
}

/** question_block: header plus items (choice options, score levels, or noul true/false criteria). */
export function questionBlock(qid: string, q: WireQuestion): QBlock {
  if (!q || typeof q !== "object") throw new ModelInputError(`question ${qid} is not an object`);
  const instructions = toJsonValue((q as { instructions?: unknown }).instructions);
  if (q.type === "noul") {
    const c = q.criteria as { true?: unknown; false?: unknown } | null | undefined;
    const t = c ? entryText(toJsonValue(c.true)) : "";
    const f = c ? entryText(toJsonValue(c.false)) : "";
    return { qid, kind: "noul", header: entryText(instructions) || DEFAULT_NOUL_INSTR, items: [t || "yes", f || "no"], labels: ["true", "false"] };
  }
  if (q.type === "choice") {
    const crit = criteriaEntries(q.criteria);
    if (!crit.length) throw new ModelInputError(`choice question ${qid} has no options`);
    const labels = crit.map(([l]) => l);
    const items = crit.map(([lab, desc]) => {
      const d = toJsonValue(desc);
      return bareLabel(lab, d) ? lab : `${lab}: ${entryText(d)}`;
    });
    return { qid, kind: "choice", header: entryText(instructions) || DEFAULT_CHOICE_INSTR, items, labels };
  }
  if (q.type === "score") {
    if (!Array.isArray(q.criteria) || !q.criteria.length) throw new ModelInputError(`score question ${qid} has no levels`);
    const items = q.criteria.map((c) => entryText(toJsonValue(c)));
    return { qid, kind: "score", header: entryText(instructions) || DEFAULT_SCORE_INSTR, items, labels: items.map((_, i) => String(i)) };
  }
  throw new ModelInputError(`unsupported question type ${String((q as { type?: unknown }).type)} for ${qid}`);
}

/** Question entries in request order (object or Map). */
export function questionEntries(questions: unknown): [string, WireQuestion][] {
  if (questions instanceof Map) return [...questions].map(([k, v]) => [String(k), v as WireQuestion]);
  if (questions && typeof questions === "object") return Object.entries(questions as Record<string, WireQuestion>);
  throw new ModelInputError("questions must be an object of qid -> question");
}
