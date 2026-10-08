// Diagnosis labels from the sim's own knowledge (CONTRACT §11): superseded intent → stale; competing current
// intents → conflict; repeated intent effect → duplicate; broken derived relation → inconsistent; failure
// streak / outage → failing; latency anomaly → slow; rate anomaly → overload; an op behaving unlike its usual
// transition shape because of a genuine anomaly → unusual; otherwise expected.

import type { Relation } from "../app/feature.js";
import type { NetEntry, Network } from "../net/network.js";
import { sigOf, type ErrorTag, type Knowledge, type SimOp, type SimWrite } from "./knowledge.js";

export interface Subject {
  kind: "write" | "op" | "error" | "invariant" | "chain" | "unknown";
  /** transition on a user action / timer: the app ops in its causal chain. */
  chain?: SimOp[];
  intent?: number;
  write?: SimWrite;
  op?: SimOp;
  net?: NetEntry;
  error?: unknown;
  invariant?: string;
}

export interface DiagCtx {
  know: Knowledge;
  network: Network;
  relations: Relation[];
  now: number;
  /** Current client snapshot (store -> value). */
  stores?: () => Record<string, unknown>;
}

const DATA_ROLES = new Set(["results", "echo", "refetch", "poll-result", "view-data", "append", "data", "load", "confirm", "created", "push", "cache", "resync", "conflict-refetch", "bulk-result", "presence", "swr-cache", "clear", "placed"]);

function clientRate(net: Network, sig: string, now: number, win = 2000): number {
  let n = 0;
  for (let i = net.log.length - 1; i >= 0; i--) {
    const e = net.log[i]!;
    if (e.t0 < now - win) break;
    if (e.signature === sig) n++;
  }
  return n / (win / 1000);
}

function netOf(op: SimOp | undefined, net: Network): NetEntry | undefined {
  if (!op?.net?.length) return undefined;
  return net.log[op.net[op.net.length - 1]!];
}

/**
 * Failure diagnosis (failure triggers, and errors/transitions caused by a failed op):
 *   timeout / gateway timeout: transient when a latency spike caused it (a retry would be fast again), slow when a
 *     slow period or overload did;
 *   outage (any mode, including hangs): failing (a retry will not succeed while it lasts);
 *   429/503 load shedding: overload when the client itself sends >= 3 requests/s (or a storm code path), else failing;
 *   server bug: unusual;
 *   random 5xx / network error: failing when it continues a streak (>= 2 in a row), else transient.
 */
export function diagnoseFailure(op: SimOp | undefined, e: NetEntry | undefined, ctx: DiagCtx): string {
  const { know, network, now } = ctx;
  const sig = e?.signature ?? (op ? sigOf(op) : "?");
  const streak = (op ? know.streak.get(sigOf(op)) ?? 0 : 0) + 1;
  const cause = e?.cause ?? "transient";
  if (cause === "outage" || cause === "offline") return "failing";
  if (op?.outcome === "timeout" || cause === "gateway-timeout" || e?.abortReason === "TimeoutError") {
    if (e?.slowCause === "slow-period" || e?.slowCause === "overload") return "slow";
    return streak >= 2 ? "slow" : "transient";
  }
  if (cause === "overload" || cause === "ratelimit") return clientRate(network, sig, now) >= 3 || op?.anomaly === "storm" ? "overload" : "failing";
  if (cause === "bug") return "unusual";
  if (op?.anomaly === "storm") return "overload";
  return streak >= 2 ? "failing" : "transient";
}

export function diagnose(trigger: string, s: Subject, ctx: DiagCtx): string | undefined {
  const { know, network } = ctx;
  switch (trigger) {
    case "mutation": {
      const w = s.write;
      if (!w) return undefined;
      const c = w.classify?.();
      if (c) return c;
      const op = know.getOp(w.op);
      const e = netOf(op, network);
      if (w.anomaly === "partial") return "inconsistent";
      if (w.anomaly === "shape" || w.anomaly === "empty" || e?.cause === "bug" || (e?.cause === "outage" && e.status !== undefined && e.status < 400)) return "unusual";
      const intent = know.getIntent(w.intent ?? op?.intent);
      if (op?.dupOf !== undefined || intent?.accidental) return "duplicate";
      if (e?.cause === "replica-lag") return "stale";
      if (intent && DATA_ROLES.has(w.role) && know.superseded(intent.id)) return "stale";
      // A late async write that would overwrite fields the user changed after its operation started.
      if (op && w.role !== "input" && w.fields?.some((f) => (know.userFieldTime.get(`${w.store}.${f}`) ?? -1) > op.t0)) return "stale";
      if (w.role === "push" && w.key) {
        const local = know.ops.find((o) => o.key === w.key && o.tEnd === undefined && !o.background);
        if (local) return "conflict";
      }
      return "expected";
    }
    case "request": {
      const o = s.op;
      if (!o) return undefined;
      const c = o.classify?.();
      if (c) return c;
      const intent = know.getIntent(o.intent);
      if (o.dupOf !== undefined || intent?.accidental) return "duplicate";
      if (o.retryOf !== undefined && !o.idempotent) {
        const orig = know.getOp(o.retryOf);
        const committed = orig?.net?.some((id) => network.log[id]?.committed);
        if (committed) return "duplicate";
      }
      if (o.anomaly === "storm" || clientRate(network, sigOf(o), ctx.now) >= 6) return "overload";
      if (intent && !o.background && know.superseded(intent.id)) return "stale";
      if ((know.streak.get(sigOf(o)) ?? 0) >= 2) return "failing";
      return "expected";
    }
    case "failure":
      return diagnoseFailure(s.op, s.net ?? netOf(s.op, network), ctx);
    case "stall": {
      const e = s.net ?? netOf(s.op, network);
      if (!e) return s.op ? "slow" : undefined;
      const o = network.profile.outages.find((x) => (e.ta ?? e.t0) >= x.start && (e.ta ?? e.t0) < x.end && (x.endpoints === "*" || x.endpoints.includes(e.signature)));
      if (o) return "failing";
      if (e.slowCause === "overload") return "overload";
      return "slow";
    }
    case "inconsistency": {
      // Genuine only when a relation the app maintains is violated right now and involves the flagged fields;
      // otherwise the runtime learned a coincidental relation (e.g. "values unique", "x != null").
      const st = ctx.stores?.() ?? {};
      const inv = s.invariant ?? "";
      const refs = fieldRefs(inv);
      const broken = ctx.relations.filter((r) => {
        try {
          return !r.check(st);
        } catch {
          return false;
        }
      });
      const overlap = broken.some((r) => refs.some((x) => r.fields.some((f) => f === x || f.startsWith(x + ".") || x.startsWith(f + ".") || x.startsWith(f + "["))));
      return overlap ? "inconsistent" : "expected";
    }
    case "transition": {
      // Genuine deviations (failures, server bugs, outage-emptied data, partial updates) vs benign changes
      // (legitimately empty results, a new branch of the app).
      const ops = s.op ? [s.op] : s.chain ?? [];
      if (!s.op && s.kind !== "chain") return undefined;
      let failed: string | undefined;
      for (const o of ops) {
        const entries = (o.net ?? []).map((id) => network.log[id]).filter(Boolean) as NetEntry[];
        if (entries.some((e) => e.cause === "bug" || e.cause === "replica-lag" || (e.cause === "outage" && (e.status ?? 0) < 400))) return "unusual";
        if (know.writes.some((w) => w.op === o.id && (w.anomaly === "partial" || w.anomaly === "shape"))) return "unusual";
        if (o.outcome && o.outcome !== "ok" && o.outcome !== "aborted") failed = diagnoseFailure(o, netOf(o, network), ctx);
      }
      if (s.intent !== undefined && know.writes.some((w) => w.intent === s.intent && (w.anomaly === "partial" || w.anomaly === "shape"))) return "unusual";
      return failed ?? "expected";
    }
    case "error": {
      const tag: ErrorTag | undefined = s.error && typeof s.error === "object" ? know.errors.get(s.error as object) : undefined;
      if (!tag) return "expected";
      if (tag.diagnosis === "expected") return "expected";
      const op = know.getOp(tag.op);
      if (op) {
        if (op.outcome === "parse-error") return "unusual";
        return diagnoseFailure(op, netOf(op, network), ctx);
      }
      return tag.diagnosis;
    }
    default:
      return undefined;
  }
}

/** Does a runtime invariant description refer only to fields of a relation the app maintains? */
export function relationMatches(r: Relation, text: string): boolean {
  const refs = fieldRefs(text);
  if (refs.length === 0) return false;
  const base = r.fields.map((f) => f.split(/[.[]/).slice(0, 2).join("."));
  return refs.every((x) => base.some((b) => x === b || x.startsWith(b + ".") || x.startsWith(b + "[")));
}

export function fieldRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) out.add(`${m[1]}.${m[2]}`);
  return [...out];
}
