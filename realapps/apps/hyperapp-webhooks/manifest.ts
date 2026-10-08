import type { AppManifest } from "../../src/shared/manifest.js";

const endpoints = ["https://hooks.acme.io/billing", "https://erp.example.com/ingest", "https://slack-relay.dev/notify"];
const events = ["invoice.paid", "invoice.failed", "customer.created", "subscription.updated", "refund.issued"];
const deliveries = Array.from({ length: 36 }, (_, i) => {
  const failed = (i * 7) % 5 === 0 || i % 11 === 3;
  return { id: 9100 + i, endpoint: endpoints[i % 3], event: events[(i * 3) % 5], status: failed ? "failed" : "succeeded", code: failed ? [500, 502, 0][i % 3] : 200, attempts: 1 + (i % 2), at: `2026-03-31T${String(10 + Math.floor(i / 6)).padStart(2, "0")}:${String((i * 9) % 60).padStart(2, "0")}:00.000Z` };
});

const manifest: AppManifest = {
  name: "hyperapp-webhooks",
  title: "Webhook deliveries",
  framework: "hyperapp",
  libs: ["hyperapp@2", "effects/subscriptions", "fetch"],
  domain: "webhook-delivery-logs",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "deliveries", seed: deliveries, filters: ["status", "endpoint"], envelope: "results", pageSize: 8, actions: { redeliver: { inc: "attempts", by: 1, set: { status: "pending" } } } },
    ],
  },
  variants: {
    pageSeq: ["latest", "blind"],
    redeliverGuard: ["pending", "none"],
    redeliverRetry: ["none", "auto-retry"],
    bulkResult: ["per-item", "assume-all"],
    poll: ["chain", "interval"],
  },
  affordances: [
    { id: "tab", kind: "click", sel: "nav.tabs button", text: ["All", "Failed", "Failed", "Succeeded"], weight: 1.2, mode: "replace", key: "filter" },
    { id: "endpoint", kind: "select", sel: "select[name=endpoint]", values: ["all", ...endpoints], weight: 0.6, mode: "replace", key: "filter" },
    { id: "page", kind: "click", sel: "nav.pages button", nth: 4, weight: 2, mode: "replace", key: "page" },
    { id: "redeliver", kind: "click", sel: "tr.delivery button.redeliver", nth: 5, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "tr.delivery button.redeliver" },
    { id: "bulk", kind: "click", sel: "button.redeliver-all", weight: 1, mode: "accumulate", dblclickP: 0.1, impatientP: 0.2, requires: "button.redeliver-all:not([disabled])" },
  ],
  external: [
    { kind: "update", target: "deliveries", perMin: 12, where: { status: "pending" }, data: [{ status: "succeeded", code: 200 }, { status: "failed", code: 503 }, { status: "succeeded", code: 200 }] },
    { kind: "create", target: "deliveries", perMin: 3, data: [{ endpoint: endpoints[0], event: "invoice.paid", status: "succeeded", code: 200, attempts: 1, at: "2026-04-01T09:00:00.000Z" }, { endpoint: endpoints[1], event: "customer.created", status: "failed", code: 502, attempts: 1, at: "2026-04-01T09:00:00.000Z" }, { endpoint: endpoints[2], event: "refund.issued", status: "failed", code: 0, attempts: 1, at: "2026-04-01T09:00:00.000Z" }] },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
