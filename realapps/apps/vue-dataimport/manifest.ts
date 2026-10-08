import type { AppManifest } from "../../src/shared/manifest.js";

const imports = [
  { id: 300, file: "leads-feb.csv", rows: 75, received: 75, status: "done", errors: 0, commits: 1, createdAt: "2026-03-28T10:00:00.000Z" },
  { id: 301, file: "partners.csv", rows: 50, received: 50, status: "invalid", errors: 4, commits: 0, createdAt: "2026-03-30T15:20:00.000Z" },
  { id: 302, file: "newsletter-q1.csv", rows: 100, received: 100, status: "valid", errors: 0, commits: 0, createdAt: "2026-03-31T09:40:00.000Z" },
  { id: 303, file: "event-badges.csv", rows: 25, received: 25, status: "done", errors: 0, commits: 1, createdAt: "2026-03-31T11:05:00.000Z" },
];

const manifest: AppManifest = {
  name: "vue-dataimport",
  title: "Contact import",
  framework: "vue",
  libs: ["vue", "defineComponent(template)", "fetch", "rt.atom", "useAtom"],
  domain: "data-import",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      {
        name: "imports",
        seed: imports,
        required: ["file", "rows"],
        filters: ["status"],
        envelope: "items",
        pageSize: 20,
        actions: { batch: { inc: "received", by: 25 }, validate: { set: { status: "validating" } }, commit: { inc: "commits", by: 1, set: { status: "committing" } } },
      },
    ],
  },
  variants: {
    batchRetry: ["idempotency-key", "blind", "none"],
    validateWhen: ["after-upload", "early"],
    commitGuard: ["state", "none"],
    poll: ["chain", "interval"],
    history: ["refetch", "stale"],
  },
  affordances: [
    { id: "file", kind: "select", sel: "select[name=file]", values: ["contacts-march.csv", "webinar-signups.csv", "trade-show-leads.csv"], weight: 1.5, mode: "replace", then: ["upload"] },
    { id: "upload", kind: "click", sel: "button.upload", weight: 1.2, mode: "accumulate", dblclickP: 0.15, impatientP: 0.2, requires: "button.upload:not([disabled])" },
    { id: "commit", kind: "click", sel: "li.job button.commit", nth: 3, weight: 1.8, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.3, requires: "li.job button.commit:not([disabled])" },
    { id: "revalidate", kind: "click", sel: "li.job button.revalidate", nth: 2, weight: 0.8, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.job button.revalidate:not([disabled])" },
    { id: "dismiss", kind: "click", sel: "li.job button.dismiss", nth: 2, weight: 0.7, mode: "accumulate", intent: "nth", requires: "li.job button.dismiss" },
    { id: "view", kind: "click", sel: "li.import button.view", nth: 4, weight: 1.2, mode: "replace", key: "detail" },
  ],
  external: [
    { kind: "update", target: "imports", perMin: 12, where: { status: "validating" }, data: [{ status: "valid", errors: 0 }, { status: "valid", errors: 0 }, { status: "invalid", errors: 3 }] },
    { kind: "update", target: "imports", perMin: 10, where: { status: "committing" }, data: [{ status: "done" }] },
  ],
  weights: { "importer.error": 0, "importer.notice": 0, "importer.busy": 0.1, "importer.starting": 0.1, "importer.file": 0.3 },
  relations: [{ name: "validation only after the whole file is in", fields: ["importer.jobs"], check: (s) => !s.importer || s.importer.jobs.every((j: { status: string; received: number; rows: number }) => j.status === "uploading" || j.received >= j.rows) }],
  errorSelector: "[role=alert]",
  build: { vueCompiler: true },
  sessionMs: [25000, 60000],
};
export default manifest;
