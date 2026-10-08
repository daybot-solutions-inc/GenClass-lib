import type { AppManifest } from "../../src/shared/manifest.js";

const E: [string, string, string, number][] = [
  ["checkout-button-color", "Checkout button colour", "running", 50], ["onboarding-video", "Onboarding video", "paused", 20],
  ["pricing-annual-default", "Annual plan preselected", "running", 30], ["search-ranking-v2", "Search ranking v2", "running", 10],
  ["empty-state-copy", "Empty state copy", "draft", 0], ["trial-length-21", "21-day trial", "paused", 25],
];
const experiments = E.map(([key, name, status, traffic], i) => ({ id: 60 + i, key, name, status, traffic }));
const metrics: Record<string, unknown>[] = [];
experiments.forEach((e, i) => ["control", "variant"].forEach((arm, j) => metrics.push({ id: 600 + i * 2 + j, experimentId: e.id, arm, users: 1200 + i * 310 + j * 45, conversions: 96 + i * 11 + j * (i % 2 ? 9 : -4) })));

const manifest: AppManifest = {
  name: "rx-experiments",
  title: "Experiments",
  framework: "vanilla",
  libs: ["rxjs", "rxjs/ajax", "fromFetch", "rt.atom"],
  domain: "ab-experiments",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "experiments", seed: experiments, versioned: true, filters: ["status"], envelope: "items", pageSize: 20 },
      { name: "metrics", seed: metrics, filters: ["experimentId"], envelope: "items", pageSize: 10, actions: { hit: { inc: "conversions", by: 3 } } },
    ],
  },
  variants: {
    metricsMap: ["switch", "merge"],
    toggleMap: ["exhaust", "merge"],
    trafficSave: ["concat", "merge"],
    versioned: [true, false],
    pollMs: [4000, 2500],
  },
  affordances: [
    { id: "select", kind: "click", sel: "li.exp button.select", nth: 6, weight: 3, mode: "replace", key: "exp" },
    { id: "toggle", kind: "click", sel: "li.exp button.toggle", nth: 6, weight: 2.5, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.25, requires: "li.exp button.toggle" },
    { id: "traffic", kind: "type", sel: "input[name=traffic]", values: ["25", "50", "5", "100", "75"], clear: true, weight: 2, mode: "replace", after: ["select"], requires: "form.traffic:not([hidden])", then: ["saveTraffic"] },
    { id: "saveTraffic", kind: "click", sel: "form.traffic button.save", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.2 },
  ],
  external: [
    { kind: "action", target: "metrics", perMin: 8, verb: "hit" },
    { kind: "update", target: "experiments", perMin: 1.5, where: { status: "running" }, data: [{ traffic: 40 }, { status: "paused" }] },
  ],
  weights: { "console.error": 0, "console.notice": 0, "console.saving": 0.1, "console.metricsLoading": 0.1 },
  relations: [{ name: "metrics belong to the selected experiment", fields: ["console.metrics", "console.selected"], check: (s) => !s.console || s.console.metricsLoading || s.console.metrics.every((m: { experimentId: number }) => m.experimentId === s.console.selected) }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
