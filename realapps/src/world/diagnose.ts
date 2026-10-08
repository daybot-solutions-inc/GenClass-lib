// Diagnosis labels from harness knowledge at decision time (mirrors sim/src/oracle/diagnose.ts, CONTRACT §11):
// the scripted user's intents (which steps are accidental, which were superseded by a newer step on the same
// intent key), the mock server's own record of why a request failed or was slow (outage, transient, spike, slow
// period, rate limit, overload, replica lag, server bug, committed-then-failed), WebSocket messages and the
// runtime's causal chains (used only to connect a write or request to its step/message/request). Never from the
// runtime's facts or text. Relation checks (partial updates, genuine invariant breaks) need the app's declared
// relations, so they are finished in Node (src/harness/labels.ts) and flagged here with `why`.

import type { NetRec } from "../shared/types.js";
import type { Probe, UserOpInfo } from "./probe.js";

export interface Diag {
  label?: string;
  why: string;
}

const NOISE = /ResizeObserver loop|Script error\.|Non-Error promise rejection captured|AbortError|The operation was aborted|signal is aborted/i;

function superseded(p: Probe, u: UserOpInfo, now: number): boolean {
  const st = p.stepOf(u.step);
  if (!st || st.intent.mode !== "replace") return false;
  // a later keystroke of the same typing step
  if (st.kind === "type") {
    for (let s = u.sub + 1; s < u.sub + 400; s++) {
      const t = p.subTimes.get(`${u.step}:${s}`);
      if (t === undefined) break;
      if (t <= now) return true;
    }
  }
  for (const r of p.stepsRan) {
    if (r.i <= u.step || r.t > now) continue;
    const s2 = p.stepOf(r.i);
    if (s2 && !s2.accidental && s2.intent.key === st.intent.key) return true;
  }
  return false;
}

function clientRate(p: Probe, sig: string, now: number, win = 2000): number {
  let n = 0;
  const log = p.net.log;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (e.t0 < now - win) break;
    if (e.sig === sig) n++;
  }
  return n / (win / 1000);
}

function failureOf(p: Probe, r: NetRec | undefined, now: number): string {
  if (!r) return "transient";
  // the probe counts a failure when the response is delivered to the runtime (before the failure trigger)
  const streak = (p.streak.get(r.sig) ?? 0) + (r.td === undefined ? 1 : 0);
  if (r.cause === "outage") return "failing";
  if (r.outcome === "timeout" || r.outcome === "hang" || r.status === 504) {
    if (r.slowCause === "slow-period" || r.slowCause === "overload") return "slow";
    return streak >= 2 ? "slow" : "transient";
  }
  if (r.cause === "ratelimit" || r.cause === "overload") return clientRate(p, r.sig, now) >= 3 ? "overload" : "failing";
  if (r.cause === "bug") return "unusual";
  return streak >= 2 ? "failing" : "transient";
}

/** Entity ids named in a WebSocket message. */
function msgEntity(m: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (m.id !== undefined) out.push(String(m.id));
  const it = m.item as Record<string, unknown> | null | undefined;
  if (it && it.id !== undefined) out.push(String(it.id));
  if (m.slug !== undefined) out.push(String(m.slug));
  return out;
}

export function diagnose(p: Probe, trigger: string, subject: Record<string, unknown>, now: number): Diag {
  switch (trigger) {
    case "mutation": {
      const mid = subject.mutation as number | undefined;
      const w = mid !== undefined ? p.writes.get(mid) : undefined;
      const cause = (subject.cause as number | undefined) ?? w?.cause;
      if (cause === undefined) return { label: "expected", why: "no-cause" };
      const nets = p.netsOfChain(cause);
      if (nets.some((r) => r.cause === "bug" || (r.cause === "outage" && (r.status ?? 0) < 400))) return { label: "unusual", why: "bug-or-empty" };
      const u = p.rootUser(cause);
      const st = u ? p.stepOf(u.step) : undefined;
      if (st?.accidental) return { label: "duplicate", why: "accidental-step" };
      if (nets.some((r) => r.cause === "replica-lag")) return { label: "stale", why: "replica-lag" };
      const ws = p.rootWs(cause);
      const fromAsync = nets.length > 0 || !!ws;
      if (u && fromAsync && superseded(p, u, now)) return { label: "stale", why: "superseded-intent" };
      if (fromAsync && w) {
        const chain = p.chain(cause);
        const start = Math.min(...chain.map((o) => o.start));
        for (const path of w.paths) {
          const tu = p.userFieldTime.get(path);
          if (tu !== undefined && tu > start) return { label: "stale", why: `user-changed ${path}` };
        }
      }
      if (ws) {
        const ids = msgEntity(ws.msg);
        if (ids.length) {
          for (const r of p.net.log) {
            if (r.td !== undefined || r.method === "GET" || r.step === undefined) continue;
            if (ids.some((id) => r.url.split("?")[0]!.split("/").includes(id))) return { label: "conflict", why: "push-vs-pending-local" };
          }
        }
      }
      return { label: "expected", why: "rel-check" };
    }
    case "request": {
      const opId = subject.op as number | undefined;
      const op = opId !== undefined ? p.ops.get(opId) : undefined;
      if (!op) return { why: "uncorrelated" };
      const u = p.rootUser(op.id);
      const st = u ? p.stepOf(u.step) : undefined;
      if (st?.accidental) return { label: "duplicate", why: "accidental-step" };
      const sig = (() => {
        const m = p.server.match((op.method ?? "GET").toUpperCase(), (() => {
          try {
            return new URL(op.url ?? "", p.w.location.origin + "/").pathname;
          } catch {
            return "";
          }
        })());
        return m ? m.ep.sig : `${op.method} ${op.url}`;
      })();
      const method = (op.method ?? "GET").toUpperCase();
      let url = "";
      try {
        const x = new URL(op.url ?? "", p.w.location.origin + "/");
        url = x.pathname + x.search;
      } catch {
        url = op.url ?? "";
      }
      // identical requests: in flight or recent, same root step (app duplicate) or a retry of a committed write
      for (let i = p.net.log.length - 1; i >= 0; i--) {
        const r = p.net.log[i]!;
        if (r.t0 < now - 10000) break;
        if (r.method !== method || r.url !== url || r.rtOp === op.id) continue;
        const sameRoot = u !== undefined && r.step === u.step && (r.td === undefined || now - r.td < 1000);
        if (sameRoot && (method !== "GET" || r.td === undefined)) return { label: "duplicate", why: "same-root-identical" };
        if (method !== "GET" && method !== "PUT" && method !== "DELETE" && r.committed && r.outcome !== "ok" && r.td !== undefined) return { label: "duplicate", why: "retry-after-commit" };
      }
      if (clientRate(p, sig, now) >= 6) return { label: "overload", why: "rate" };
      if (u && superseded(p, u, now)) return { label: "stale", why: "superseded-intent" };
      if ((p.streak.get(sig) ?? 0) >= 2) return { label: "failing", why: "streak" };
      return { label: "expected", why: "none" };
    }
    case "failure": {
      const opId = subject.op as number | undefined;
      const r = opId !== undefined ? p.netOfOp.get(opId) : undefined;
      if (!r) return { why: "uncorrelated" };
      return { label: failureOf(p, r, now), why: `failure ${r.cause ?? r.outcome}` };
    }
    case "stall": {
      const opId = subject.op as number | undefined;
      const r = opId !== undefined ? p.netOfOp.get(opId) : undefined;
      if (!r) return { why: "uncorrelated" };
      const o = p.net.P.outages.find((x) => (r.ta ?? r.t0) >= x.start && (r.ta ?? r.t0) < x.end && (x.endpoints === "*" || x.endpoints.includes(r.sig)));
      if (o || r.cause === "outage") return { label: "failing", why: "outage" };
      if (r.slowCause === "overload") return { label: "overload", why: "overload" };
      return { label: "slow", why: `slow ${r.slowCause ?? ""}` };
    }
    case "inconsistency":
      return { label: "expected", why: "rel-check" };
    case "transition": {
      const opId = subject.op as number | undefined;
      if (opId === undefined) return { why: "uncorrelated" };
      // the op and every request in the chain it started
      const nets: NetRec[] = [];
      for (const [id, r] of p.netOfOp) {
        if (p.chain(id).some((o) => o.id === opId)) nets.push(r);
      }
      if (nets.some((r) => r.cause === "bug" || r.cause === "replica-lag" || (r.cause === "outage" && (r.status ?? 0) < 400))) return { label: "unusual", why: "bug-lag-empty" };
      const failed = nets.filter((r) => r.outcome !== "ok" && r.outcome !== "aborted" && r.outcome !== "pending");
      if (failed.length) return { label: failureOf(p, failed[failed.length - 1], now), why: "failed-chain" };
      return { label: "expected", why: "rel-check" };
    }
    case "error": {
      const msg = String(subject.error ?? "");
      if (NOISE.test(msg)) return { label: "expected", why: "noise" };
      const opId = subject.op as number | undefined;
      const nets = opId !== undefined ? p.netsOfChain(opId) : [];
      const bad = nets.find((r) => r.cause === "bug" || r.outcome !== "ok");
      if (bad) return { label: bad.cause === "bug" ? "unusual" : failureOf(p, bad, now), why: `error-from ${bad.cause ?? bad.outcome}` };
      if (/JSON|Unexpected token|is not valid JSON/i.test(msg)) return { label: "unusual", why: "parse" };
      return { label: "failing", why: "handler-threw" };
    }
    default:
      return { why: "unknown-trigger" };
  }
}
