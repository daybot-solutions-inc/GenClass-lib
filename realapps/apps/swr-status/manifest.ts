import type { AppManifest } from "../../src/shared/manifest.js";

const names = ["api-gateway", "auth", "billing", "search", "notifications", "storage", "payments", "reports"];
const regions = ["us-east", "eu-west", "ap-south"];
const services = names.map((name, i) => ({ id: 500 + i, name, region: regions[i % 3], status: i === 2 ? "degraded" : "operational", latencyMs: 40 + ((i * 37) % 160), uptime: 99.9 - (i % 4) * 0.05 }));
const incidents = [
  { id: 801, serviceId: 502, title: "Invoice PDFs failing", severity: 2, status: "open", level: 1 },
  { id: 802, serviceId: 500, title: "Elevated 502s in eu-west", severity: 1, status: "open", level: 1 },
  { id: 803, serviceId: 503, title: "Slow autocomplete", severity: 3, status: "acknowledged", level: 1 },
  { id: 804, serviceId: 506, title: "Card declines spike", severity: 1, status: "open", level: 2 },
  { id: 805, serviceId: 502, title: "Retry queue backlog", severity: 3, status: "open", level: 1 },
  { id: 806, serviceId: 505, title: "Upload timeouts", severity: 2, status: "open", level: 1 },
  { id: 807, serviceId: 501, title: "MFA codes delayed", severity: 2, status: "open", level: 1 },
  { id: 808, serviceId: 504, title: "Email bounces rising", severity: 3, status: "open", level: 1 },
  { id: 809, serviceId: 507, title: "Nightly export late", severity: 3, status: "acknowledged", level: 1 },
  { id: 810, serviceId: 507, title: "Dashboard tiles empty", severity: 2, status: "open", level: 1 },
];

const manifest: AppManifest = {
  name: "swr-status",
  title: "Service status",
  framework: "react",
  libs: ["react", "swr", "fetch", "rt.atom"],
  domain: "ops",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "services", seed: services, envelope: "bare", filters: ["status"], pageSize: 50 },
      { name: "incidents", seed: incidents, envelope: "items", filters: ["serviceId", "status"], pageSize: 50, actions: { ack: { set: { status: "acknowledged" } }, escalate: { inc: "level", by: 1 } } },
    ],
  },
  variants: {
    refreshInterval: [5000, 2000, 10000],
    errorRetryCount: [3, 10, 1],
    dedupingInterval: [2000, 0, 500],
    actionGuard: ["disable", "none"],
    ackUpdate: ["revalidate", "optimistic", "optimistic-no-rollback"],
  },
  affordances: [
    { id: "inspect", kind: "click", sel: ".service button.inspect", nth: 8, weight: 3, mode: "replace" },
    { id: "filter", kind: "select", sel: "select[name=status]", values: ["all", "all", "operational", "operational", "degraded", "down"], weight: 1.2, mode: "replace" },
    { id: "ack", kind: "click", sel: ".incident button.ack", nth: 3, weight: 2.5, mode: "accumulate", intent: "nth", after: ["inspect"], dblclickP: 0.15, impatientP: 0.25 },
    { id: "escalate", kind: "click", sel: ".incident button.escalate", nth: 3, weight: 1.5, mode: "accumulate", intent: "nth", after: ["inspect"], dblclickP: 0.15, impatientP: 0.2 },
    { id: "refresh", kind: "click", sel: "button.refresh-now", weight: 0.8, mode: "replace", dblclickP: 0.1 },
    { id: "close", kind: "click", sel: "button.close-detail", weight: 0.5, mode: "replace", after: ["inspect"] },
  ],
  external: [
    { kind: "update", target: "services", perMin: 6, data: [{ status: "degraded", latencyMs: 640 }, { status: "operational", latencyMs: 85 }, { status: "down", latencyMs: 0 }, { latencyMs: 230 }] },
    { kind: "create", target: "incidents", perMin: 1.2, data: [{ serviceId: 501, title: "Login latency", severity: 2, status: "open", level: 1 }, { serviceId: 504, title: "Push delivery delayed", severity: 3, status: "open", level: 1 }, { serviceId: 500, title: "TLS handshake errors", severity: 1, status: "open", level: 1 }] },
    { kind: "action", target: "incidents", verb: "ack", perMin: 0.8 },
  ],
  weights: { "ui.busy": 0.1, "ui.error": 0, "ui.lastAction": 0.2 },
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
