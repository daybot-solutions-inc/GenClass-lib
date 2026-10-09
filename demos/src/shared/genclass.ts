// The one place the demos create the runtime. App code is identical in every mode:
//   off   -> GenClass.init({ mode: "observe", model: false })   (installed, never changes anything; the baseline)
//   observe -> GenClass.init({ mode: "observe", model: { baseUrl } }) (the runtime's default: reports only)
//   guard -> GenClass.init({ mode: "guard", model: { baseUrl } })
//   heal  -> GenClass.init({ mode: "heal",  model: { baseUrl } })
// Telemetry is always off here (telemetry: false): demo and benchmark traffic must never reach the collector.
import { GenClass } from "@genclass/runtime";
import type { ActionRecord, Decision, InitOptions, Plugin, Report, Runtime } from "@genclass/runtime";
import { attachTrace, newTrace, traceHooks, type Trace } from "./trace.ts";
import type { GcMode, GcStats } from "./types.ts";

declare const __RUNTIME_KIND__: string;
export const RUNTIME_KIND: "real" | "shim" = typeof __RUNTIME_KIND__ !== "undefined" && __RUNTIME_KIND__ === "shim" ? "shim" : "real";

export interface GcSession {
  gc: Runtime;
  mode: GcMode;
  decisions: Decision[];
  detections: Decision[];
  actions: ActionRecord[];
  reports: Report[];
  initAt: number;
  readyAt: number | null;
  trace: Trace | null;
}

export function startGenClass(
  mode: GcMode,
  opts: { baseUrl?: string; plugins?: Plugin[]; debug?: boolean; holdBudgetMs?: number; trace?: boolean; aggressiveness?: number | string; ortWasmPaths?: string; situationBudget?: number; thresholds?: { guard: number; heal: number } },
): GcSession {
  const policy =
    opts.holdBudgetMs || opts.thresholds
      ? { ...(opts.holdBudgetMs ? { holdBudgetMs: opts.holdBudgetMs } : {}), ...(opts.thresholds ? { thresholds: opts.thresholds } : {}) }
      : undefined;
  // Investigation only: the runtime's creation hooks (CreateOptions.hooks), forwarded by GenClass.init.
  const trace = opts.trace ? newTrace() : null;
  const extra = (trace ? { hooks: traceHooks(trace) } : {}) as Partial<InitOptions>;
  const gc =
    mode === "off"
      ? GenClass.init({ mode: "observe", model: false, plugins: opts.plugins, policy, telemetry: false, ...extra })
      : GenClass.init({
          mode,
          telemetry: false,
          ...(opts.aggressiveness !== undefined ? { aggressiveness: opts.aggressiveness as InitOptions["aggressiveness"] } : {}),
          ...(opts.situationBudget !== undefined ? { situation: { budget: opts.situationBudget } } : {}),
          model: { ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), ...(opts.ortWasmPaths ? { ortWasmPaths: opts.ortWasmPaths } : {}), preload: "eager" },
          plugins: opts.plugins,
          debug: opts.debug,
          policy,
          ...extra,
        });
  if (trace) {
    attachTrace(gc, trace);
    window.__gcTrace = trace;
    // investigation runs only: the runtime itself (explain(), decisions()), never in measured runs
    (window as unknown as { __gc?: Runtime }).__gc = gc;
  }
  const s: GcSession = {
    gc,
    mode,
    decisions: [],
    detections: [],
    actions: [],
    reports: [],
    initAt: performance.now(),
    readyAt: null,
    trace,
  };
  gc.on("decide", (d) => s.decisions.push(d));
  gc.on("detect", (d) => s.detections.push(d));
  gc.on("act", (a) => s.actions.push(a));
  gc.on("report", (r) => s.reports.push(r));
  gc.ready.then(
    () => (s.readyAt = performance.now()),
    () => {},
  );
  return s;
}

export function statusText(gc: Runtime): string {
  const st = gc.status;
  if (st.state === "off") return "off";
  if (st.state === "ready") return `ready${st.device ? ` · ${st.device}` : ""}${st.variant ? ` ${st.variant}` : ""}`;
  if (st.state === "loading") {
    const p = st.progress;
    return p && p.total ? `loading ${Math.round((p.loaded / p.total) * 100)}%` : "loading";
  }
  return `error${st.error ? `: ${st.error}` : ""}`;
}

export function collectStats(s: GcSession): GcStats {
  const notExecuted: Record<string, number> = {};
  const diagnoses: Record<string, number> = {};
  const triggers: Record<string, number> = {};
  for (const d of s.decisions) {
    diagnoses[d.diagnosis] = (diagnoses[d.diagnosis] ?? 0) + 1;
    triggers[d.trigger] = (triggers[d.trigger] ?? 0) + 1;
    if (!d.executed && d.reason) {
      // "probability 0.42 is below the guard threshold 0.9" -> "probability # is below the guard threshold #"
      const key = d.reason.replace(/\d+(\.\d+)?/g, "#");
      notExecuted[key] = (notExecuted[key] ?? 0) + 1;
    }
  }
  const st = s.gc.status;
  return {
    runtime: RUNTIME_KIND,
    isolated: typeof crossOriginIsolated !== "undefined" ? crossOriginIsolated : false,
    status: st.state,
    model: st.model,
    device: st.device,
    variant: st.variant,
    threads: (st as { threads?: number }).threads,
    situationBudget: s.gc.situationBudget(),
    loadMs: st.loadMs ?? (s.readyAt !== null ? Math.round(s.readyAt - s.initAt) : undefined),
    decisions: s.decisions.length,
    detections: s.detections.length,
    findings: s.detections.map((d) => `${d.trigger}:${d.diagnosis}`),
    triggers,
    gates: s.decisions.map(
      (d) =>
        `${d.trigger}:${d.diagnosis}:${d.candidate ?? "-"}:${d.gain !== undefined ? Math.round(d.gain * 100) / 100 : "-"}/${d.margin ?? d.threshold ?? "-"}:${d.executed ? "ran" : "no"}`,
    ),
    notExecuted,
    interventions: s.actions.map((a) => ({ action: a.action, tier: a.tier, trigger: a.trigger, changed: a.changed, at: a.at })),
    decisionLatencyMs: s.decisions.map((d) => Math.round(d.latencyMs * 10) / 10),
    diagnoses,
  };
}
