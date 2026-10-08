// Console reporting (CONTRACT §0.5, §8): one plain-English line per detection and per intervention, built from
// the decision's facts with generic templates (reporting only, never decisions), followed by a collapsed group
// with the evidence. Identical repeats within a minute are summarised as "×N in the last minute".

import type { ActionRecord, Clock, Decision, Explanation, Report, TriggerKind } from "../types.js";

const NOUN: Record<TriggerKind, string> = {
  mutation: "write",
  request: "request",
  delivery: "response",
  failure: "request failure",
  stall: "slow request",
  inconsistency: "state",
  transition: "state change",
  error: "error",
  ask: "question",
};

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

function an(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

function p2(x: number | undefined): string {
  return x === undefined || !Number.isFinite(x) ? "?" : x.toFixed(2);
}

function noun(d: Decision): string {
  const n = d.trigger === "delivery" && !d.subject.startsWith("response") ? "message" : NOUN[d.trigger];
  if (d.diagnosis === "expected") return an(n);
  if (d.trigger === "inconsistency" && d.diagnosis === "inconsistent") return "inconsistent state";
  return an(`${d.diagnosis} ${n}`);
}

function topFact(d: Decision): string {
  const f = d.facts.find((x) => !/^This (write|request) (comes from|has no known cause)/.test(x)) ?? d.facts[0] ?? "";
  return f.endsWith(".") ? f : f + ".";
}

export function interventionLine(d: Decision, a: ActionRecord): string {
  const lead = a.late ? "Reverted" : LEAD[a.action] ?? "Handled";
  return `[GenClass] ${lead} ${noun(d)}: ${topFact(d)} ${a.changed}${a.ok ? "" : ` (failed: ${a.error ?? "error"})`} (${d.diagnosis}, ${p2(d.diagnosisConfidence)}; ${a.action} ${p2(d.confidence)})`;
}

export function detectionLine(d: Decision): string {
  let why = "";
  if (d.reason && !d.executed) {
    const would = d.candidate && d.candidate !== d.action && d.mass !== undefined ? `${d.candidate} ${p2(d.mass)} for permitted actions` : `${d.action} ${p2(d.confidence)}`;
    why = ` Not acted on (would have done ${would}): ${d.reason}.`;
  }
  return `[GenClass] Flagged ${noun(d)}: ${topFact(d)}${why} (${d.diagnosis}, ${p2(d.diagnosisConfidence)})`;
}

/** A decision that was neither a detection nor an intervention (for explain()). */
export function decisionLine(d: Decision): string {
  const ran = d.ran === d.action ? d.ran : `${d.ran} (the model chose ${d.action}${d.reason ? `; ${d.reason}` : ""})`;
  return `[GenClass] Checked ${d.subject}: ${d.diagnosis} (${p2(d.diagnosisConfidence)}); ran ${ran}.`;
}

type Sink = "console" | "silent" | ((r: Report) => void);

const WINDOW_MS = 60_000;

export class Reporter {
  /** Open dedupe windows: the first report printed, repeats counted, a summary printed when the window ends. */
  private seen = new Map<string, { n: number; first: Report; timer: unknown }>();

  constructor(
    private sink: Sink,
    private readonly clock: Clock,
    private readonly explain: (id: string) => Explanation | null,
    private readonly listener?: (r: Report) => void,
  ) {}

  setSink(s: Sink): void {
    this.sink = s;
  }

  private key(kind: string, d: Decision | undefined, a: ActionRecord | undefined): string {
    const subj = (d?.subject ?? "").replace(/#\d+/g, "#").replace(/\d+(\.\d+)?/g, "n");
    return `${kind}|${a?.action ?? d?.action ?? ""}|${d?.diagnosis ?? ""}|${d?.trigger ?? ""}|${subj}`;
  }

  /** True when the report should be printed now (first of its window); repeats are counted for the summary. */
  private dedupe(k: string, r: Report): boolean {
    const s = this.seen.get(k);
    if (s) {
      s.n++;
      return false;
    }
    const timer = this.clock.setTimeout(() => this.flush(k), WINDOW_MS);
    this.seen.set(k, { n: 0, first: r, timer });
    return true;
  }

  /** End of a dedupe window: print how many identical reports were folded. */
  private flush(k: string): void {
    const s = this.seen.get(k);
    this.seen.delete(k);
    if (!s || s.n === 0 || typeof this.sink !== "string" || this.sink !== "console") return;
    const con = (globalThis as { console?: Console }).console;
    const line = `${s.first.message} (×${s.n} more in the last minute)`;
    (s.first.kind === "intervene" ? con?.warn ?? con?.log : con?.info ?? con?.log)?.call(con, line);
  }

  dispose(): void {
    for (const s of this.seen.values()) this.clock.clearTimeout(s.timer);
    this.seen.clear();
  }

  emit(r: Report): void {
    try {
      this.listener?.(r);
    } catch {
      /* listeners never break reporting */
    }
    const sink = this.sink;
    if (sink === "silent") return;
    if (typeof sink === "function") {
      try {
        sink(r);
      } catch {
        /* reporting never breaks the app */
      }
      return;
    }
    if (r.kind !== "status" && !this.dedupe(this.key(r.kind, r.decision, r.action), r)) return;
    const con = (globalThis as { console?: Console }).console;
    if (!con) return;
    const line = r.message;
    if (r.kind === "status") {
      con.info?.(line);
      return;
    }
    const ev = r.action ? this.explain(r.action.id) : r.decision ? this.explain(r.decision.id) : null;
    if (ev && typeof con.groupCollapsed === "function") {
      con.groupCollapsed(line);
      con.log("Facts:\n  " + ev.facts.join("\n  "));
      if (ev.timeline.length) con.log("Timeline:\n  " + ev.timeline.join("\n  "));
      con.log("Situation sent to the model:\n" + ev.situationText);
      con.log("Answers:", ev.answers);
      if (r.action) {
        con.log(`Changed: ${r.action.changed}`);
        con.log(r.action.undo ? `Undo: GenClass.runtime.interventions().find(a => a.id === "${r.action.id}").undo()` : "Undo: not reversible");
        con.log(`Deny this action: GenClass.init({ policy: { deny: ["${r.action.action}"] } })`);
      }
      con.log(`explain: GenClass.runtime.explain("${r.action?.id ?? r.decision?.id}")`);
      con.groupEnd();
    } else {
      (r.kind === "intervene" ? con.warn ?? con.log : con.info ?? con.log).call(con, line);
    }
  }
}
