// The one place the demos create the runtime. App code is identical in every mode:
//   off   -> GenClass.init({ mode: "observe", model: false })   (installed, never changes anything; the baseline)
//   guard -> GenClass.init({ mode: "guard", model: { baseUrl } }) (the default)
//   heal  -> GenClass.init({ mode: "heal",  model: { baseUrl } })
import { GenClass } from "@genclass/runtime";
import type { ActionRecord, Decision, Plugin, Report, Runtime } from "@genclass/runtime";
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
}

export function startGenClass(mode: GcMode, opts: { baseUrl?: string; plugins?: Plugin[]; debug?: boolean; holdBudgetMs?: number }): GcSession {
  const policy = opts.holdBudgetMs ? { holdBudgetMs: opts.holdBudgetMs } : undefined;
  const gc =
    mode === "off"
      ? GenClass.init({ mode: "observe", model: false, plugins: opts.plugins, policy })
      : GenClass.init({
          mode,
          model: { ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}), preload: "eager" },
          plugins: opts.plugins,
          debug: opts.debug,
          policy,
        });
  const s: GcSession = {
    gc,
    mode,
    decisions: [],
    detections: [],
    actions: [],
    reports: [],
    initAt: performance.now(),
    readyAt: null,
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
  for (const d of s.decisions) {
    diagnoses[d.diagnosis] = (diagnoses[d.diagnosis] ?? 0) + 1;
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
    loadMs: st.loadMs ?? (s.readyAt !== null ? Math.round(s.readyAt - s.initAt) : undefined),
    decisions: s.decisions.length,
    detections: s.detections.length,
    notExecuted,
    interventions: s.actions.map((a) => ({ action: a.action, tier: a.tier, trigger: a.trigger, changed: a.changed, at: a.at })),
    decisionLatencyMs: s.decisions.map((d) => Math.round(d.latencyMs * 10) / 10),
    diagnoses,
  };
}
