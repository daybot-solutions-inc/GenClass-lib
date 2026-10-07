// How ops and events are named in facts, timelines and console reports. One implementation, used by the runtime
// and the sim.

import type { RtEvent, UserAction } from "../types.js";
import type { OpRec } from "../trace/ops.js";
import { rel, secs, truncate } from "../util.js";

/** "user typed "re" into input "Search"" (no id). */
export function userPhrase(op: OpRec): string {
  const a = (op.meta?.action ?? {}) as UserAction;
  const target = a.target ?? "";
  const val = op.detail ?? "";
  switch (a.kind) {
    case "click":
      return `user clicked ${target || "the page"}`;
    case "type":
      return `user typed ${val || "text"}${target ? ` into ${target}` : ""}`;
    case "change":
      return `user changed ${target || "a field"}${val ? ` to ${val}` : ""}`;
    case "submit":
      return `user submitted ${target || "a form"}`;
    case "key":
      return `user pressed ${a.key ?? "a key"}${target ? ` in ${target}` : ""}`;
    case "nav":
    case "navigate":
      return `user navigated to ${target || val || "a page"}`;
    default:
      return `user ${a.kind ?? "action"}${target ? ` ${target}` : ""}${val ? ` ${val}` : ""}`;
  }
}

/** Short name of an op without id: "GET /api/search?q=re", "user clicked button "Add"", "interval 5.00s". */
export function opPhrase(op: OpRec): string {
  switch (op.kind) {
    case "user":
      return userPhrase(op);
    case "fetch":
    case "xhr":
      return `${op.name}${op.detail ?? ""}`;
    case "timer":
      return op.name;
    case "ws":
      return op.name;
    case "task":
      return `task ${op.name}${op.detail ? ` ${op.detail}` : ""}`;
    case "genclass":
      return `GenClass ${op.name}`;
  }
  return op.name;
}

/** "GET /api/search?q=re (#14)" */
export function opLabel(op: OpRec | undefined | null): string {
  if (!op) return "an earlier operation";
  return `${truncate(opPhrase(op), 90)} (#${op.id})`;
}

export function statusText(op: OpRec): string {
  if (op.status === "aborted") return "aborted";
  if (op.status === "blocked") return "blocked";
  if (typeof op.code === "number") return String(op.code);
  if (op.code === "timeout") return "timed out";
  if (op.code === "network") return "network error";
  if (op.status === "error") return op.errorText ? `error (${truncate(op.errorText, 40)})` : "error";
  return op.status ?? "pending";
}

/** One timeline line for an event, relative to `now`. */
export function eventLine(e: RtEvent, now: number, op: (id: number | undefined) => OpRec | undefined): string | null {
  const t = rel(e.t - now);
  const d = e.data ?? {};
  switch (e.kind) {
    case "user": {
      const o = op(e.op);
      const count = typeof d.count === "number" && d.count > 1 ? d.count : 0;
      const first = typeof d.first === "number" ? d.first : undefined;
      const ids = count && first !== undefined && first !== e.op ? `${count} keystrokes, #${first}–#${e.op}` : `#${e.op}`;
      return `${t} ${o ? userPhrase(o) : e.name} (${ids})`;
    }
    case "op.start": {
      const o = op(e.op);
      if (!o || o.kind === "user") return null;
      const by = o.cause !== undefined ? `, by #${o.cause}` : "";
      const att = o.attempt > 1 ? `, attempt ${o.attempt}` : "";
      return `${t} start ${truncate(opPhrase(o), 80)} (#${o.id}${by}${att})`;
    }
    case "op.end": {
      const o = op(e.op);
      if (!o) return `${t} end ${e.name}`;
      const dur = o.end !== undefined ? ` in ${secs(o.end - o.start)}` : "";
      return `${t} end ${truncate(opPhrase(o), 80)} (#${o.id}): ${statusText(o)}${dur}`;
    }
    case "state": {
      const summary = Array.isArray(d.summary) ? (d.summary as string[]).join("; ") : e.name;
      const by = e.op !== undefined ? ` (by #${e.op}${d.user ? ", user" : ""})` : "";
      return `${t} write ${truncate(summary, 110)}${by}`;
    }
    case "error":
      return `${t} error ${truncate(String(d.message ?? e.name), 100)}${e.op !== undefined ? ` (during #${e.op})` : ""}`;
    case "nav":
      return `${t} navigate ${truncate(String(d.route ?? e.name), 60)}`;
    case "storage":
      return `${t} ${e.name}${d.key ? ` ${truncate(String(d.key), 40)}` : ""}`;
    case "perf":
      return `${t} ${e.name}${typeof d.duration === "number" ? ` ${Math.round(d.duration)}ms` : ""}`;
    case "custom": {
      const extra = d.summary ? ` ${truncate(String(d.summary), 60)}` : "";
      return `${t} event ${truncate(e.name, 60)}${extra}${e.op !== undefined ? ` (#${e.op})` : ""}`;
    }
    case "action":
      return `${t} GenClass ${truncate(String(d.text ?? e.name), 100)}`;
    case "decision":
      return null;
  }
  return null;
}
