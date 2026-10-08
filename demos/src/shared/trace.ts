// Investigation-only tracing (?trace=1 on trial pages, `eval.ts --trace`): every write proposed to a GenClass
// store, when and in which order it was applied, the ops behind it and the decisions about it. Uses the runtime's
// documented hook `hooks.mutationProposed` (CreateOptions), which GenClass.init forwards to createRuntime.
// Off by default: normal runs and the published results never carry this instrumentation.
import type { Change, Runtime } from "@genclass/runtime";

export interface TraceProposal {
  id: number;
  /** performance.now() at proposal (same clock as the runtime's event times). */
  t: number;
  store: string;
  paths: string[];
  cause?: number;
  changes: { path: string; before: unknown; after: unknown }[];
}

export interface TraceApply {
  t: number;
  mutation: number;
  store: string;
  paths: string[];
  user: boolean;
  op?: number;
  summary: string[];
}

export interface TraceDecision {
  id: string;
  trigger: string;
  subject: string;
  at: number;
  latencyMs: number;
  action: string;
  candidate?: string;
  mass?: number;
  executed: boolean;
  reason?: string;
  diagnosis: string;
  mutation?: number;
  op?: number;
}

export interface TraceOp {
  kind: string;
  name: string;
  t: number;
  cause?: number;
}

export interface Trace {
  /** performance.timeOrigin, to convert to the oracle's epoch times. */
  origin: number;
  proposals: TraceProposal[];
  applies: TraceApply[];
  decisions: TraceDecision[];
  ops: Record<number, TraceOp>;
}

const short = (v: unknown): unknown => {
  if (v === null || typeof v !== "object") return typeof v === "string" && v.length > 60 ? v.slice(0, 60) + "…" : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 160 ? s.slice(0, 160) + "…" : JSON.parse(s);
  } catch {
    return String(v);
  }
};

export function newTrace(): Trace {
  return { origin: performance.timeOrigin, proposals: [], applies: [], decisions: [], ops: {} };
}

/** The hooks object to pass to GenClass.init (forwarded to createRuntime). */
export function traceHooks(trace: Trace) {
  return {
    mutationProposed(m: { id: number; store: string; paths: string[]; cause?: number; changes: Change[] }) {
      trace.proposals.push({
        id: m.id,
        t: performance.now(),
        store: m.store,
        paths: m.paths.slice(0, 12),
        cause: m.cause,
        changes: m.changes.slice(0, 12).map((c) => ({ path: c.path, before: short(c.before), after: short(c.after) })),
      });
    },
  };
}

/** Subscribe to the runtime's events and decisions. */
export function attachTrace(gc: Runtime, trace: Trace): void {
  gc.on("event", (e) => {
    if (e.kind === "state") {
      const d = (e.data ?? {}) as { store?: string; paths?: string[]; mutation?: number; user?: boolean; summary?: string[] };
      trace.applies.push({ t: e.t, mutation: d.mutation ?? 0, store: d.store ?? e.name, paths: (d.paths ?? []).slice(0, 12), user: !!d.user, op: e.op, summary: d.summary ?? [] });
    } else if ((e.kind === "op.start" || e.kind === "user") && e.op !== undefined && !trace.ops[e.op]) {
      trace.ops[e.op] = { kind: e.kind, name: e.name, t: e.t, cause: e.cause };
    }
  });
  gc.on("decide", (d) => {
    const ref = (d as unknown as { subjectRef?: { mutation?: number; op?: number } }).subjectRef;
    const extra = d as unknown as { candidate?: string; mass?: number };
    trace.decisions.push({
      id: d.id,
      trigger: d.trigger,
      subject: d.subject.slice(0, 160),
      at: d.at,
      latencyMs: Math.round(d.latencyMs),
      action: d.action,
      candidate: extra.candidate,
      mass: extra.mass,
      executed: d.executed,
      reason: d.reason,
      diagnosis: d.diagnosis,
      mutation: ref?.mutation,
      op: ref?.op,
    });
  });
}

declare global {
  interface Window {
    __gcTrace?: Trace;
  }
}
