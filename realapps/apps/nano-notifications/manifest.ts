import type { AppManifest } from "../../src/shared/manifest.js";

const rows: [string, string, boolean][] = [
  ["mention", "Priya mentioned you in “Q3 capacity plan”", false],
  ["review", "Review requested: payments-api #482", false],
  ["deploy", "web-frontend v2.14.0 deployed to production", true],
  ["comment", "Leo commented on “Onboarding checklist”", false],
  ["billing", "Your invoice for March is ready", true],
  ["mention", "Sam mentioned you in #incidents", false],
  ["review", "Review requested: search-indexer #77", true],
  ["deploy", "Rollback of api-gateway v5.2.1 completed", false],
  ["comment", "Ana replied to your comment on RFC-19", true],
  ["mention", "Kofi mentioned you in “Design crit notes”", false],
  ["deploy", "nightly-etl failed on step 3", false],
  ["billing", "Seat count changed to 42", true],
];
const notifications = rows.map(([kind, title, read], i) => ({ id: 6600 + i, kind, title, read, createdAt: new Date(Date.UTC(2026, 2, 31, 18, 0) - i * 47 * 60000).toISOString() }));

const manifest: AppManifest = {
  name: "nano-notifications",
  title: "Notifications",
  framework: "vanilla",
  libs: ["nanostores", "fetch", "rt.guard"],
  domain: "notifications",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "notifications", seed: notifications, pageSize: 30, envelope: "items" }],
  },
  variants: {
    bulkResult: ["per-item", "assume-all"],
    unread: ["derive", "incremental"],
    poll: ["keep-pending", "replace", "replace"],
    bulkLock: [true, false],
  },
  affordances: [
    { id: "toggleRead", kind: "click", sel: ".note button.toggle-read", nth: 8, intent: "nth", weight: 4, mode: "accumulate", requires: ".note button.toggle-read", dblclickP: 0.12 },
    { id: "markAll", kind: "click", sel: "button.mark-all", weight: 1.5, mode: "accumulate", dblclickP: 0.2, impatientP: 0.25 },
    { id: "dismiss", kind: "click", sel: ".note button.dismiss", nth: 8, intent: "nth", weight: 1.2, mode: "accumulate", requires: ".note button.dismiss", dblclickP: 0.1 },
    { id: "filter", kind: "select", sel: "select[name=filter]", values: ["all", "unread", "mention", "review", "deploy", "all"], weight: 1.2, mode: "replace" },
  ],
  external: [
    {
      kind: "create",
      target: "notifications",
      perMin: 3,
      data: [
        { kind: "mention", title: "Jo mentioned you in “Sprint 22 goals”", read: false },
        { kind: "deploy", title: "worker-pool v1.9.3 deployed to staging", read: false },
        { kind: "review", title: "Review requested: mobile-app #1290", read: false },
        { kind: "comment", title: "Mia commented on “Pricing page copy”", read: false },
      ],
    },
    // read on the phone
    { kind: "update", target: "notifications", perMin: 1.2, data: [{ read: true }] },
  ],
  weights: { "inbox.filter": 0.3, "inbox.busy": 0.1, "inbox.loaded": 0.1, "inbox.notice": 0.1, "inbox.error": 0 },
  relations: [
    {
      name: "unread == count(items where not read)",
      fields: ["inbox.unread", "inbox.items"],
      check: (s) => !s.inbox || !Array.isArray(s.inbox.items) || s.inbox.unread === s.inbox.items.filter((n: { read: boolean }) => !n.read).length,
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
