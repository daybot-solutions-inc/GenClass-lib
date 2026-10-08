import type { AppManifest } from "../../src/shared/manifest.js";

const manifest: AppManifest = {
  name: "xstate-loan",
  title: "Loan application",
  framework: "react",
  libs: ["react", "xstate@5", "@xstate/react", "fromPromise", "fromCallback", "fetch", "AbortController", "rt.atom"],
  domain: "loan-application",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "applications", seed: [{ id: 7001, name: "Jordan Lee", income: 64000, amount: 15000, status: "approved", submissions: 1 }], filters: ["status"], envelope: "data", actions: { submit: { inc: "submissions", by: 1, set: { status: "submitted" } } } },
      { name: "documents", seed: [], required: ["applicationId", "kind"], filters: ["applicationId", "status"], envelope: "data", pageSize: 30, actions: { scan: { set: { status: "scanning" } } } },
    ],
  },
  variants: {
    submitGuard: ["state", "none"],
    submitKey: ["per-application", "none"],
    docRetry: ["idempotency-key", "blind", "none"],
    scanPoll: ["invoke", "leak"],
    decision: ["poll-until-final", "poll-once"],
  },
  affordances: [
    { id: "fullname", kind: "type", sel: "form.applicant input[name=fullname]", values: ["Sam Rivera", "Priya Natarajan", "Alex Chen"], clear: true, weight: 0.5, mode: "replace", requires: "form.applicant", then: ["income"] },
    { id: "income", kind: "type", sel: "form.applicant input[name=income]", values: ["52000", "71000", "88000"], clear: true, weight: 0, mode: "replace", followOnly: true },
    { id: "amount", kind: "select", sel: "form.applicant select[name=amount]", values: ["5000", "15000", "30000"], weight: 0.4, mode: "replace", requires: "form.applicant" },
    { id: "upload", kind: "click", sel: "li.doc button.upload", nth: 3, weight: 1, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.2, requires: "li.doc button.upload" },
    { id: "primary", kind: "click", sel: "footer button.primary", weight: 4, mode: "accumulate", dblclickP: 0.15, impatientP: 0.3, requires: "footer button.primary:not([disabled])" },
    { id: "back", kind: "click", sel: "footer button.back", weight: 0.3, mode: "replace", requires: "footer button.back" },
  ],
  external: [
    { kind: "update", target: "documents", perMin: 10, where: { status: "scanning" }, data: [{ status: "verified" }, { status: "verified" }, { status: "verified" }, { status: "rejected" }] },
    { kind: "update", target: "applications", perMin: 5, where: { status: "submitted" }, data: [{ status: "approved" }, { status: "needs-info" }, { status: "approved" }] },
  ],
  weights: { "loan.error": 0, "loan.busy": 0.1, "loan.name": 0.3, "loan.income": 0.3 },
  relations: [
    {
      name: "the review step has every document",
      fields: ["loan.step", "loan.docs"],
      check: (s) => !s.loan || !["review", "submitting"].includes(s.loan.step) || ["id", "paystub", "bank"].every((k) => s.loan.docs[k] && s.loan.docs[k].id > 0),
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [30000, 70000],
};
export default manifest;
