import type { AppManifest } from "../../src/shared/manifest.js";

const manifest: AppManifest = {
  name: "lit-expenses",
  title: "Expense report",
  framework: "lit",
  libs: ["lit", "LitElement(shadow DOM)", "fetch", "rt.atom", "AtomController"],
  domain: "expense-reports",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "reports", seed: [{ id: 3301, title: "March client visit", status: "submitted", total: 18450 }], filters: ["status"], envelope: "items", actions: { submit: { set: { status: "submitted" } } } },
      { name: "receipts", seed: [], required: ["reportId", "merchant"], filters: ["reportId", "status"], envelope: "items", pageSize: 40, actions: { ocr: { set: { status: "scanning" } } } },
    ],
  },
  variants: {
    total: ["derive", "incremental"],
    attachGuard: ["pending", "none"],
    submit: ["after-scans", "early"],
    poll: ["pending-aware", "blind"],
    remove: ["optimistic-rollback", "optimistic"],
  },
  affordances: [
    { id: "pick", kind: "select", sel: "expense-app >>> select[name=receipt]", values: ["Air Canada", "Hotel Le Germain", "Uber", "Bistro 990", "Staples", "Porter Airlines"], weight: 3, mode: "replace", requires: "expense-app >>> select[name=receipt]", then: ["attach"] },
    { id: "attach", kind: "click", sel: "expense-app >>> button.attach", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.2, requires: "expense-app >>> button.attach:not([disabled])" },
    { id: "remove", kind: "click", sel: "expense-app >>> li.receipt button.remove", nth: 4, weight: 0.8, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "expense-app >>> li.receipt button.remove" },
    { id: "submit", kind: "click", sel: "expense-app >>> button.submit", weight: 1, mode: "accumulate", dblclickP: 0.15, impatientP: 0.25, requires: "expense-app >>> button.submit:not([disabled])" },
    { id: "newReport", kind: "click", sel: "expense-app >>> button.new-report", weight: 1, mode: "accumulate", after: ["submit"], requires: "expense-app >>> button.new-report" },
  ],
  external: [{ kind: "update", target: "receipts", perMin: 14, where: { status: "scanning" }, data: [{ status: "read" }, { status: "read" }, { status: "read" }, { status: "unreadable" }] }],
  weights: { "expenses.error": 0, "expenses.notice": 0, "expenses.attaching": 0.1, "expenses.pending": 0.1, "expenses.submitting": 0.1, "expenses.pick": 0.3 },
  relations: [
    { name: "report total = receipt amounts", fields: ["expenses.total", "expenses.receipts"], check: (s) => !s.expenses || s.expenses.total === s.expenses.receipts.reduce((a: number, r: { amount: number }) => a + r.amount, 0) },
    { name: "a submitted report has only read receipts", fields: ["expenses.status", "expenses.receipts"], check: (s) => !s.expenses || s.expenses.status !== "submitted" || s.expenses.receipts.every((r: { status: string }) => r.status === "read") },
  ],
  errorSelector: "expense-app >>> [role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
