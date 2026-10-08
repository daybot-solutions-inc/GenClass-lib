// Evidence facts (situation v2, SIM's separability proposals F5–F7, F9): generic, cheap, deterministic.
//
//   F9  provenance of known-stale values: a field whose current value was written over newer data, by a very slow
//       response, after an ambiguous failure, or before a live channel went down (marks set by the runtime);
//   F6  the learned cadence of a request signature (on a schedule / debounced after user input);
//   F5  failure scope across the endpoints of an origin, the browser's offline state, and commit ambiguity of a
//       failed non-GET request;
//   F7  repeat-action evidence: same element, the browser's click count, a request still in flight, UI changes
//       between the two actions.

import type { Fact, UserAction } from "../types.js";
import type { LatencyBaseline } from "../learn/baselines.js";
import type { OpRec } from "../trace/ops.js";
import { plural, secs } from "../util.js";
import type { FailureInfo, SitEnv } from "./env.js";

const SCOPE_MS = 10_000;

function fact(text: string, kind: Fact["kind"], neutral: boolean): Fact {
  return { text, kind, neutral };
}

/** F9: fields among `paths` whose current value carries a stale mark (at most `max`). */
export function markFacts(env: SitEnv, paths: Iterable<string>, now: number, max = 2): Fact[] {
  const out: Fact[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (seen.has(p) || out.length >= max) continue;
    seen.add(p);
    const m = env.hub.field(p)?.mark;
    if (m) out.push(fact(`${p} holds a value written ${secs(now - m.t)} ago ${m.why}; nothing has rewritten it since.`, "versions", true));
  }
  return out;
}

/** F6: the learned schedule or debounce of a signature. */
export function cadenceFact(env: SitEnv, sig: string, now: number): Fact | null {
  const c = env.cadence(sig, now);
  if (!c) return null;
  if (c.kind === "periodic") {
    const d = c.next - now;
    return fact(`${sig} runs on a schedule: every ${secs(c.period)} (last ${plural(c.intervals, "interval")}); the next run is ${d >= 0 ? `due in ${secs(d)}` : `${secs(-d)} overdue`}.`, "baseline", true);
  }
  return fact(`${sig} is usually sent ${secs(c.delay)} after the user's last input (${c.matching} of the last ${c.of}): a later edit is followed by a new request.`, "baseline", true);
}

/** "same-origin" or the host of a cross-origin signature ("GET api.x.io/v1/items"). */
export function hostOfSig(sig: string): string {
  const where = sig.slice(sig.indexOf(" ") + 1);
  if (where.startsWith("/")) return "same-origin";
  const i = where.indexOf("/");
  return i < 0 ? where : where.slice(0, i);
}

/** F5: failures (or normal answers) of the other endpoints of the same origin in the last 10 s; offline. */
export function scopeFacts(env: SitEnv, sig: string, now: number): Fact[] {
  const out: Fact[] = [];
  const host = hostOfSig(sig);
  const where = host === "same-origin" ? "this origin" : host;
  const recent = env.outcomes().filter((o) => now - o.t <= SCOPE_MS && o.host === host && o.sig !== sig);
  const failed = recent.filter((o) => !o.ok);
  if (failed.length) {
    const sigs = [...new Set(failed.map((o) => o.sig))];
    const items = failed
      .slice(-2)
      .map((o) => `${o.sig} ${o.outcome === "network" ? "network error" : o.outcome}`)
      .join(", ");
    const ok = recent.length - failed.length;
    out.push(fact(`${plural(sigs.length, "other endpoint")} of ${where} failed in the last 10s (${plural(failed.length, "failure")}, latest: ${items})${ok ? `; ${plural(ok, "other request")} succeeded` : ""}.`, "outcome", true));
  } else if (recent.length) {
    const sigs = new Set(recent.map((o) => o.sig));
    out.push(fact(`The other endpoints of ${where} answered normally in the last 10s (${plural(recent.length, "request")} to ${plural(sigs.size, "endpoint")}).`, "outcome", true));
  }
  if (env.online() === false) out.push(fact("The browser reports that it is offline (navigator.onLine is false).", "outcome", true));
  return out;
}

const NOT_PROCESSED = new Set([502, 503, 429, 408]);

/**
 * F5 commit ambiguity of a failed request that changes server state: whether the server may have applied it.
 * `ambiguous` is true when it may have (a 5xx other than 502/503, or a network error / timeout no earlier than the
 * usual answer time). Null for GET/HEAD/OPTIONS.
 */
export function commitAmbiguity(method: string, f: FailureInfo, lat: LatencyBaseline | undefined): { text: string; ambiguous: boolean } | null {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return null;
  const usual = lat ? lat.median : undefined;
  if (f.kind === "http") {
    const s = f.status ?? 0;
    if (NOT_PROCESSED.has(s)) return { text: `This ${m} failed with HTTP ${s}, a status servers and gateways usually return without processing the request.`, ambiguous: false };
    if (s < 500) return null;
    if (usual !== undefined && f.durMs < usual * 0.5) return { text: `This ${m} failed with HTTP ${s} after ${secs(f.durMs)}, well before its usual ${secs(usual)}.`, ambiguous: false };
    return { text: `This ${m} failed with HTTP ${s} after ${secs(f.durMs)}${usual !== undefined ? ` (usual ${secs(usual)})` : ""}: the server may have applied it before failing.`, ambiguous: true };
  }
  const what = f.kind === "timeout" ? "timed out" : "failed with a network error";
  if (usual !== undefined && f.durMs < usual * 0.5) return { text: `This ${m} ${what} after ${secs(f.durMs)}, well before its usual ${secs(usual)}.`, ambiguous: false };
  return { text: `This ${m} ${what} after ${secs(f.durMs)}${usual !== undefined ? `, no earlier than its usual ${secs(usual)}` : ""}: the server may have received and applied it.`, ambiguous: true };
}

/** The failure of a completed request op, for commit ambiguity (null when it did not fail). */
export function failureOf(op: OpRec): FailureInfo | null {
  if (op.status !== "error" || op.end === undefined) return null;
  const durMs = op.end - op.start;
  if (typeof op.code === "number") return { kind: "http", status: op.code, durMs };
  return { kind: op.code === "timeout" ? "timeout" : "network", durMs };
}

function actionOf(u: OpRec): UserAction | undefined {
  return (u.meta as { action?: UserAction } | undefined)?.action;
}

/**
 * F7: evidence about a repeated user action (u1 earlier, u2 later): the same element, the browser's click count
 * (double click), the first action's request still in flight, what the app changed between the two.
 */
export function repeatEvidence(env: SitEnv, u1: OpRec, u2: OpRec, firstReq?: OpRec): Fact {
  if (u1.start > u2.start) [u1, u2] = [u2, u1];
  const parts: string[] = [];
  const a1 = actionOf(u1);
  const a2 = actionOf(u2);
  if (u1.name === u2.name && a1?.target) parts.push(`both are ${a1.kind}s on ${a1.target}`);
  const clicks = a2?.clicks;
  if (typeof clicks === "number" && clicks >= 2) parts.push(`the browser counted #${u2.id} as click ${clicks} of a multi-click (MouseEvent.detail)`);
  if (firstReq && firstReq.start <= u2.start && (firstReq.end === undefined || firstReq.end > u2.start)) parts.push(`the request of #${u1.id} (#${firstReq.id}) was still in flight at #${u2.id}`);
  const between = new Set<string>();
  for (const x of env.hub.changedSince(u1.startSeq)) for (const h of x.hist) if (h.seq > u1.startSeq && h.seq <= u2.startSeq) between.add(x.path);
  parts.push(between.size ? `between them the app wrote ${[...between].slice(0, 2).join(", ")}${between.size > 2 ? ` and ${between.size - 2} more` : ""}` : "the app changed no state between them");
  return fact(`User actions #${u1.id} and #${u2.id}, ${secs(u2.start - u1.start)} apart: ${parts.join("; ")}.`, "repetition", true);
}
