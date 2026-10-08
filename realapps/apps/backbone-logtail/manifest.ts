import type { AppManifest } from "../../src/shared/manifest.js";

const services = ["api", "worker", "db"];
const msgs: Record<string, string[]> = {
  api: ["GET /v1/orders 200 41ms", "POST /v1/checkout 201 180ms", "GET /v1/users/me 401 3ms", "rate limit hit for tenant acme", "GET /v1/search 200 512ms"],
  worker: ["job email.send completed", "job invoice.render retry 2/5", "job export.csv failed: timeout", "queue depth 37", "job thumbnails completed"],
  db: ["slow query 1.8s on orders_by_customer", "connection pool 18/20", "replica lag 2.4s", "vacuum finished on events", "deadlock detected, retrying"],
};
const levelOf = (m: string) => (/failed|deadlock|401/.test(m) ? "error" : /slow|retry|lag|rate limit|pool/.test(m) ? "warn" : "info");
const logs = Array.from({ length: 45 }, (_, i) => {
  const service = services[i % 3]!;
  const msg = msgs[service]![(i * 7) % 5]!;
  return { id: 5000 + i, service, level: levelOf(msg), msg, createdAt: `2026-03-31T23:${String(15 + i).padStart(2, "0")}:00.000Z` };
});
const fresh = [
  { service: "api", level: "info", msg: "GET /v1/cart 200 22ms" },
  { service: "api", level: "error", msg: "POST /v1/checkout 502 upstream reset" },
  { service: "worker", level: "warn", msg: "job webhook.deliver retry 1/5" },
  { service: "worker", level: "info", msg: "job report.daily completed" },
  { service: "db", level: "warn", msg: "replica lag 3.1s" },
  { service: "db", level: "error", msg: "could not serialize access, retrying" },
  { service: "api", level: "info", msg: "GET /v1/products 200 64ms" },
  { service: "worker", level: "info", msg: "queue depth 12" },
];

const manifest: AppManifest = {
  name: "backbone-logtail",
  title: "Log tail",
  framework: "backbone",
  libs: ["backbone", "underscore", "jquery", "Backbone.sync($.ajax)", "WebSocket"],
  domain: "log-viewer",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "logs", seed: logs, live: true, filters: ["level", "service"], search: ["msg"], envelope: "items", pageSize: 15 },
      { name: "pins", seed: [], unique: ["logId"], required: ["logId"], envelope: "items", pageSize: 50 },
    ],
  },
  variants: {
    older: ["dedupe", "blind"],
    olderGuard: ["pending", "none"],
    filterFetch: ["abort-previous", "none"],
    reconnect: ["resync", "naive"],
    pause: ["buffer", "drop"],
  },
  affordances: [
    { id: "level", kind: "select", sel: "select[name=level]", values: ["all", "warn", "error"], weight: 1, mode: "replace" },
    { id: "service", kind: "select", sel: "select[name=service]", values: ["all", ...services], weight: 0.8, mode: "replace" },
    { id: "older", kind: "click", sel: "button.older", weight: 2, mode: "accumulate", dblclickP: 0.2, impatientP: 0.25, requires: "button.older:not([disabled])" },
    { id: "pause", kind: "click", sel: "button.pause", weight: 1, mode: "replace", key: "live" },
    { id: "pin", kind: "click", sel: "li.line button.pin", nth: 6, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.1, impatientP: 0.1, requires: "li.line button.pin" },
  ],
  external: [{ kind: "create", target: "logs", perMin: 24, data: fresh }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
