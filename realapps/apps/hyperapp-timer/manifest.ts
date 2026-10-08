import type { AppManifest } from "../../src/shared/manifest.js";

const timers = [
  { id: 210, project: "Harbour rebrand", client: "Harbour & Co", running: true, seconds: 1520 },
  { id: 211, project: "Tidewater website", client: "Tidewater Hotels", running: false, seconds: 5410 },
  { id: 212, project: "Northlight annual report", client: "Northlight Trust", running: false, seconds: 960 },
  { id: 213, project: "Internal: hiring", client: "Studio", running: false, seconds: 300 },
];

const manifest: AppManifest = {
  name: "hyperapp-timer",
  title: "Studio timesheet",
  framework: "hyperapp",
  libs: ["hyperapp@2", "effects/subscriptions", "fetch", "rt.guard(dispatch middleware)"],
  domain: "time-tracking",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "timers", seed: timers, pageSize: 50, envelope: "items", actions: { toggle: { toggle: "running" }, log: { inc: "seconds" } } }],
  },
  variants: {
    toggleMode: ["set", "toggle"],
    toggleGuard: [true, false],
    pull: ["pending-aware", "blind", "blind"],
    logMode: ["absolute", "increment"],
    total: ["derive", "tick-only"],
  },
  affordances: [
    { id: "toggle", kind: "click", sel: ".timer button.toggle", nth: 5, intent: "nth", weight: 5, mode: "accumulate", dblclickP: 0.2, impatientP: 0.15 },
    { id: "project", kind: "select", sel: "select[name=project]", values: ["Harbour rebrand", "Tidewater website", "Northlight annual report", "Internal: hiring"], weight: 0.8, mode: "replace", then: ["add"] },
    { id: "add", kind: "click", sel: "button.add-timer", weight: 0.4, mode: "accumulate", dblclickP: 0.15 },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.7, mode: "replace", dblclickP: 0.1 },
  ],
  external: [
    // the phone app logs a block of time, and stops a timer someone forgot
    { kind: "action", target: "timers", verb: "log", by: 300, perMin: 0.5 },
    { kind: "action", target: "timers", verb: "toggle", perMin: 0.4 },
  ],
  weights: { "timesheet.project": 0.3, "timesheet.toggling": 0.1, "timesheet.adding": 0.1, "timesheet.loaded": 0.1, "timesheet.error": 0 },
  relations: [
    {
      name: "total == sum(timers.seconds)",
      fields: ["timesheet.total", "timesheet.timers"],
      check: (s) => !s.timesheet || !Array.isArray(s.timesheet.timers) || s.timesheet.total === s.timesheet.timers.reduce((a: number, t: { seconds: number }) => a + Number(t.seconds || 0), 0),
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [30000, 70000],
};
export default manifest;
