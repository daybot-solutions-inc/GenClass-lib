// Devtools building blocks: a tiny DOM helper, inline icons, and display formatting. Reporting only: nothing
// here decides anything, it only renders what the runtime reports. Runtime-provided text is always set with
// textContent (never innerHTML); innerHTML is used only for the constant SVG markup below.

import type { Answer, Decision, RtEvent } from "../types.js";

let D: Document;
export const setDoc = (d: Document): void => {
  D = d;
};

export type Kid = Node | string | number | false | null | undefined | Kid[];

/** h("div", { class, text, onclick, "aria-x": … }, ...children) */
export function h(tag: string, props?: Record<string, unknown> | null, ...kids: Kid[]): HTMLElement {
  const el = D.createElement(tag);
  if (props)
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (k === "text") el.textContent = String(v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  add(el, kids);
  return el;
}

export function add(el: Node, kids: Kid[]): void {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) add(el, c);
    else el.appendChild(typeof c === "object" ? c : D.createTextNode(String(c)));
  }
}

function svg(markup: string): Element {
  const t = D.createElement("template");
  t.innerHTML = markup;
  return t.content.firstElementChild as Element;
}

const ICONS = {
  shield: '<path d="M12 3.2 5 6v5.3c0 4.2 2.9 7.5 7 8.7 4.1-1.2 7-4.5 7-8.7V6z"/><path d="m9.2 11.9 2 2 3.8-3.9"/>',
  eye: '<path d="M2.6 12S6 5.8 12 5.8 21.4 12 21.4 12 18 18.2 12 18.2 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.7"/>',
  pulse: '<path d="M3 12.5h3.6l2.2-5.6 4.4 11 2.2-5.4H21"/>',
  scan: '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="2.6"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  play: '<path d="M8 5.6v12.8L18.2 12z"/>',
  clear: '<circle cx="12" cy="12" r="8.2"/><path d="m6.3 6.3 11.4 11.4"/>',
  min: '<path d="M6 12h12"/>',
  chev: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  undo: '<path d="M9 13.5 4.5 9 9 4.5"/><path d="M4.5 9h10a5.5 5.5 0 0 1 0 11H11"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.6c0 .9.8 1.7 1.7 1.7h2.3"/>',
  check: '<path d="m5.5 12.5 4 4 9-9"/>',
  alert: '<path d="M12 4.2 3 19.5h18z"/><path d="M12 10.2v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="8.2"/><path d="M12 11v5M12 8h.01"/>',
};
export type IconName = keyof typeof ICONS;

export const icon = (name: IconName, cls = "i"): Element =>
  svg(`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`);

let markN = 0;
/** The GenClass mark: the brand's blue-violet tile with a white trace line. Unique gradient id per instance. */
export function mark(): Element {
  const id = `gcm${++markN}`;
  return svg(
    `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f6cf2"/><stop offset="1" stop-color="#7b3cf0"/></linearGradient></defs><rect width="24" height="24" rx="7" fill="url(#${id})"/><path d="M5 12.6h3.1l2-4.8 3.5 9 2-4.2H19" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="19" cy="12.6" r="1.6" fill="#ffd166"/></svg>`,
  );
}

// ------------------------------------------------------------------------------------------- formatting

export const pct = (p: number | undefined): string => (p == null || !Number.isFinite(p) ? "–" : `${Math.round(p * 100)}%`);

export const mb = (bytes: number): string => (bytes / 1048576).toFixed(bytes >= 1048576 * 100 ? 0 : 1);

/** Milliseconds as "412 ms", "1.82 s", "12.3 s", "2m 05s". */
export function dur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Runtime clock time (ms since start) as "12.48s" or "1:05.3". */
export function clockT(t: number): string {
  const s = Math.max(0, t) / 1000;
  if (s < 100) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

export function ago(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1500) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Report templates (display only). They mirror the runtime's console wording (src/decide/report.ts) and are used
// when the runtime's own report sentence is not available to the overlay.
const LEAD: Record<string, string> = {
  discard: "Prevented",
  defer: "Held back",
  coalesce: "Prevented",
  delay: "Slowed down",
  block: "Stopped",
  serve_cached: "Recovered from",
  retry: "Recovered from",
  hedge: "Worked around",
  rollback: "Repaired",
  resync: "Repaired",
};
const NOUN: Record<string, string> = {
  mutation: "write",
  request: "request",
  failure: "failed request",
  stall: "slow request",
  inconsistency: "state",
  transition: "state change",
  error: "error",
  ask: "question",
};
const ADJ: Record<string, string> = { conflict: "conflicting", overload: "excessive" };

/** "stale write", "slow request", "inconsistent state", "duplicate request" … */
export function phrase(diagnosis: string | undefined, trigger: string | undefined): string {
  const n = NOUN[trigger ?? ""] ?? trigger ?? "event";
  if (!diagnosis || diagnosis === "expected") return n;
  if (trigger === "failure" && diagnosis === "failing") return "failing request";
  const adj = ADJ[diagnosis] ?? diagnosis.replace(/_/g, " ");
  return n.startsWith(adj) ? n : `${adj} ${n}`;
}

const article = (p: string): string => (/(^|\s)state$/.test(p) ? p : `${/^[aeiou]/i.test(p) ? "an" : "a"} ${p}`);

/** Intervention headline, e.g. "Prevented a stale write", "Slowed down a failing request". */
export function actTitle(action: string, diagnosis?: string, trigger?: string): string {
  const lead = LEAD[action];
  if (!lead) return `Ran ${action.replace(/_/g, " ")}`;
  return `${lead} ${article(phrase(diagnosis, trigger))}`;
}

/** Detection headline, e.g. "Unusual state change", "Slow request". */
export const diagTitle = (diagnosis: string | undefined, trigger?: string): string => cap(phrase(diagnosis, trigger));

/** The fact the runtime leads its console line with: the first that is not plain provenance. */
export function topFact(facts: string[] | undefined): string {
  if (!facts?.length) return "";
  return facts.find((f) => !/^This (write|request) (comes from|has no known cause)/.test(f)) ?? facts[0];
}

/** Group key for repeated detections (same trigger, diagnosis, action and subject shape). */
export const repeatKey = (d: Decision): string =>
  `${d.trigger}|${d.diagnosis}|${d.action}|${d.subject.replace(/#\d+/g, "#").replace(/\d+(\.\d+)?/g, "n")}`;

/** Colour family of a diagnosis chip. */
export function diagTone(d: string | undefined): string {
  switch (d) {
    case "expected":
      return "ok";
    case "failing":
    case "inconsistent":
      return "bad";
    case "slow":
    case "overload":
      return "warn";
    default:
      return "brand";
  }
}

/**
 * The runtime's report sentence split into a headline and a body:
 * "[GenClass] Prevented a stale write: <fact> <changed> (stale, 0.97; discard 0.98)".
 */
export function splitReport(msg: string | undefined, changed?: string): { title: string; body: string } {
  if (!msg) return { title: "", body: "" };
  let m = msg
    .split("\n")[0]
    .replace(/^\s*\[GenClass\]\s*/, "")
    .replace(/\s*\(×\d+[^)]*\)\s*$/, "")
    .replace(/\s*\([\w-]+, ?[\d.?]+(?:; ?[\w-]+ [\d.?]+)?\)\s*$/, "")
    .replace(/\s*Not acted on \([^)]*\):.*$/, "")
    .trim();
  if (changed && m.endsWith(changed)) m = m.slice(0, -changed.length).trim();
  const i = m.indexOf(": ");
  return i > 2 && i < 64 ? { title: m.slice(0, i), body: m.slice(i + 2) } : { title: "", body: m };
}

/** Diagnosis probability of a decision (calibrated). */
export const diagP = (d: Decision): number => d.diagnosisProbabilities?.[d.diagnosis] ?? d.diagnosisConfidence;

/** Answer as [label, probability] pairs, most probable first. */
export function answerRows(a: Answer): [string, number][] {
  if (a.type === "noul") return [["true", a.noul], ["false", 1 - a.noul]];
  return Object.entries(a.probabilities ?? {})
    .map(([k, v]) => [k, Number(v) || 0] as [string, number])
    .sort((x, y) => y[1] - x[1]);
}

// ---------------------------------------------------------------------------------------------- events

export type Group = "user" | "op" | "state" | "error" | "gc" | "other";

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function opKind(e: RtEvent): string | undefined {
  return str(e.data?.kind) ?? str(e.data?.opKind);
}

export function groupOf(e: RtEvent): Group {
  switch (e.kind) {
    case "user":
      return "user";
    case "op.start":
    case "op.end":
      return opKind(e) === "genclass" ? "gc" : "op";
    case "state":
      return "state";
    case "error":
      return "error";
    case "decision":
    case "action":
      return "gc";
    default:
      return "other";
  }
}

const OP_LABEL: Record<string, string> = { fetch: "net", xhr: "net", ws: "ws", task: "task", timer: "timer", genclass: "gc", user: "user" };
const KIND_LABEL: Record<string, string> = {
  user: "user",
  state: "state",
  error: "error",
  nav: "nav",
  perf: "perf",
  storage: "store",
  custom: "event",
  decision: "model",
  action: "action",
};

export function kindLabel(e: RtEvent): string {
  if (e.kind === "op.start" || e.kind === "op.end") return OP_LABEL[opKind(e) ?? ""] ?? "op";
  return KIND_LABEL[e.kind] ?? e.kind;
}

const quote = (v: string): string => (v.startsWith('"') ? v : `"${v.length > 40 ? v.slice(0, 39) + "…" : v}"`);

/** Main line of an activity row. */
export function eventText(e: RtEvent): string {
  const d = e.data ?? {};
  let s = e.name;
  switch (e.kind) {
    case "op.start":
    case "op.end": {
      const detail = str(d.detail);
      if (detail && !s.includes(detail)) s += detail.startsWith("?") ? detail : ` ${detail}`;
      return s;
    }
    case "user": {
      const v = str(d.value);
      if (v) s += ` = ${quote(v)}`;
      const n = num(d.count);
      return n && n > 1 ? `${s} (${n} keystrokes)` : s;
    }
    case "state": {
      const paths = Array.isArray(d.paths) ? d.paths : Array.isArray(d.changes) ? (d.changes as { path?: string }[]).map((c) => c?.path) : null;
      const ps = paths?.filter((p): p is string => typeof p === "string");
      return ps?.length ? `${ps.slice(0, 3).join(", ")}${ps.length > 3 ? ` +${ps.length - 3}` : ""}` : s;
    }
    case "error": {
      const m = str(d.message);
      return m ? (m.startsWith(s) ? m : `${s}: ${m}`) : s;
    }
    case "decision": {
      const dg = str(d.diagnosis);
      const ac = str(d.action);
      return `${s}${dg ? ` · ${dg}` : ""}${ac ? ` → ${ac}` : ""}${d.executed === false ? " (not run)" : ""}`;
    }
    case "action": {
      const t = str(d.text);
      return t ? `${s} · ${t}` : s;
    }
    case "storage": {
      const k = str(d.key);
      return k ? `${s} ${k}` : s;
    }
    default: {
      const sum = str(d.summary);
      return sum && !s.includes(sum) ? `${s} · ${sum}` : s;
    }
  }
}

/** Duration of an op.end event: explicit data, else end minus start. */
export function opDuration(e: RtEvent, start?: number): number | undefined {
  const d = e.data ?? {};
  return num(d.ms) ?? num(d.duration) ?? num(d.durationMs) ?? (start != null ? e.t - start : undefined);
}

/** Status of an op.end event: [text, tone]. */
export function opStatus(e: RtEvent): [string, string] {
  const d = e.data ?? {};
  const status = str(d.status);
  const code = d.code ?? d.httpStatus;
  const c = typeof code === "number" || typeof code === "string" ? String(code) : "";
  if (status === "error") return [c || "error", "bad"];
  if (status === "aborted") return ["aborted", "dim"];
  if (status === "blocked") return [c ? `blocked ${c}` : "blocked", "brand"];
  if (typeof code === "number" && code >= 400) return [c, "bad"];
  return [c || status || "done", "ok"];
}

/** Compact "key: value" lines for an expanded activity row; `name` resolves op ids to descriptions. */
export function dataLines(e: RtEvent, name?: (op: number) => string | undefined): string {
  const out: string[] = [`${e.kind} · ${e.name}`];
  if (e.op != null) out.push(`op: #${e.op}`);
  if (e.cause != null) {
    const n = name?.(e.cause);
    out.push(`cause: #${e.cause}${n ? ` ${n}` : ""}`);
  }
  for (const [k, v] of Object.entries(e.data ?? {})) {
    let s: string;
    try {
      s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
    out.push(`${k}: ${s.length > 300 ? s.slice(0, 299) + "…" : s}`);
  }
  out.push(`seq: ${e.seq}`);
  return out.join("\n");
}

/** A JevState value as display lines. */
export function linesOf(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : safeJson(x)));
  if (typeof v === "string") return v.split("\n").filter((l) => l.trim() !== "");
  return [safeJson(v)];
}

export function safeJson(v: unknown, space?: number): string {
  try {
    return JSON.stringify(v, null, space) ?? String(v);
  } catch {
    return String(v);
  }
}
