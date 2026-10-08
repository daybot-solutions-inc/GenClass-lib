import type { AppManifest } from "../../src/shared/manifest.js";

const titles = [
  "Crash when exporting CSV with emoji", "Dark mode toggle resets on reload", "Typo in onboarding email", "Slow search on large workspaces",
  "Add keyboard shortcut for archive", "Webhook payload missing timezone", "Avatar upload fails on Safari", "Docs link 404 in settings",
  "Duplicate notifications after reconnect", "Allow custom date formats", "Billing page shows wrong plan", "Drag and drop broken in Firefox",
];
const labels = ["", "bug", "", "perf", "feature", "", "bug", "docs", "", "feature", "", "bug"];
const issues = titles.map((title, i) => ({ id: 900 + i, number: 1840 + i, title, label: labels[i], assignee: i % 5 === 0 ? "kim" : "", component: ["api", "web", "mobile"][i % 3] }));

const manifest: AppManifest = {
  name: "hyperapp-triage",
  title: "Issue triage",
  framework: "hyperapp",
  libs: ["hyperapp", "fetch", "hyperappGuard"],
  domain: "issue-triage",
  entry: "main.ts",
  integration: "stores",
  server: { base: "/api", collections: [{ name: "issues", seed: issues, filters: ["label", "component", "assignee"], search: ["title"], envelope: "items", pageSize: 40 }] },
  variants: {
    bulkResult: ["per-item", "assume-all"],
    assignGuard: ["pending", "none"],
    listSeq: ["latest", "blind"],
    selection: ["prune", "keep"],
    untriaged: ["derive", "manual"],
  },
  affordances: [
    { id: "component", kind: "click", sel: "nav.components button", text: ["All", "api", "web", "mobile"], weight: 1.5, mode: "replace", key: "component" },
    { id: "select", kind: "check", sel: "li.issue input.pick", nth: 6, weight: 3, mode: "accumulate", intent: "nth" },
    { id: "label", kind: "click", sel: "div.bulk button.apply", text: ["bug", "feature", "perf", "docs"], weight: 2, mode: "accumulate", intent: "text", requires: "div.bulk button.apply:not([disabled])", dblclickP: 0.12, impatientP: 0.2 },
    { id: "assign", kind: "click", sel: "li.issue button.mine", nth: 5, weight: 2, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "li.issue button.mine" },
  ],
  external: [
    { kind: "create", target: "issues", perMin: 1.5, data: [{ number: 1900, title: "Login button misaligned", label: "", assignee: "", component: "web" }, { number: 1901, title: "Rate limit headers missing", label: "", assignee: "", component: "api" }] },
    { kind: "update", target: "issues", perMin: 2, where: { label: "" }, data: [{ label: "bug" }, { assignee: "kim" }] },
  ],
  weights: { "triage.error": 0, "triage.notice": 0, "triage.loading": 0.1, "triage.busy": 0.1 },
  relations: [
    { name: "untriaged count = unlabelled issues", fields: ["triage.untriaged", "triage.issues"], check: (s) => !s.triage || s.triage.loading || s.triage.untriaged === s.triage.issues.filter((i: { label: string }) => !i.label).length },
    { name: "selection is visible", fields: ["triage.selected", "triage.issues"], check: (s) => !s.triage || s.triage.loading || s.triage.selected.every((id: number) => s.triage.issues.some((i: { id: number }) => i.id === id)) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
