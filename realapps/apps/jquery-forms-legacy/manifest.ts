import type { AppManifest } from "../../src/shared/manifest.js";

const people: [string, string, string][] = [
  ["Maria Kowalski", "maria.k@acme.io", "admin"],
  ["Devon Price", "devon@acme.io", "editor"],
  ["Aiko Tanaka", "aiko.t@acme.io", "editor"],
  ["Samuel Okoro", "sam.okoro@acme.io", "viewer"],
  ["Lucía Fernández", "lucia@acme.io", "billing"],
  ["Ben Carter", "ben.c@acme.io", "viewer"],
  ["Priya Nair", "priya@acme.io", "editor"],
];
const members = people.map(([name, email, role], i) => ({ id: 300 + i, name, email, role, status: i === 5 ? "suspended" : "active" }));
const teams = [
  { id: 701, name: "Platform", quotaGb: 500, usedGb: 412 },
  { id: 702, name: "Data Science", quotaGb: 1200, usedGb: 1033 },
  { id: 703, name: "Marketing", quotaGb: 100, usedGb: 37 },
  { id: 704, name: "Support", quotaGb: 50, usedGb: 49 },
];
const invites = [
  { id: 801, email: "new.hire@acme.io", role: "viewer" },
  { id: 802, email: "contractor@studio.dev", role: "editor" },
];
const audit = [
  { id: 901, actor: "maria.k", action: "raised the quota of", target: "Data Science", createdAt: "2026-03-30T16:02:00.000Z" },
  { id: 902, actor: "devon", action: "invited", target: "contractor@studio.dev", createdAt: "2026-03-30T17:40:00.000Z" },
  { id: 903, actor: "maria.k", action: "suspended", target: "ben.c@acme.io", createdAt: "2026-03-31T08:15:00.000Z" },
  { id: 904, actor: "system", action: "rotated API keys for", target: "Platform", createdAt: "2026-03-31T09:00:00.000Z" },
];

const manifest: AppManifest = {
  name: "jquery-forms-legacy",
  title: "Acme Cloud · Organization settings",
  framework: "jquery",
  libs: ["jquery", "$.ajax(xhr)", "$.ajaxSetup", "form-encoded bodies"],
  domain: "admin",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    envelope: "data",
    collections: [
      { name: "members", seed: members, envelope: "data", pageSize: 50 },
      { name: "teams", seed: teams, envelope: "data", actions: { grow: { inc: "quotaGb", by: 10 } } },
      { name: "invites", seed: invites, envelope: "data", unique: ["email"], required: ["email"] },
      { name: "audit", seed: audit, envelope: "data", pageSize: 6 },
    ],
  },
  variants: {
    retry: ["idempotent", "all", "none", "all"],
    disableOnSubmit: [true, false],
    refreshKeepsEdits: [true, false],
    teamGuard: ["latest", "none"],
    quotaGrow: ["absolute", "relative"],
    auditPollMs: [5000, 2000],
  },
  affordances: [
    { id: "role", kind: "select", sel: "table.members select.role", nth: 7, values: ["viewer", "editor", "admin", "billing"], weight: 2.2, mode: "replace", intent: "nth" },
    { id: "saveRoles", kind: "click", sel: "button.save-roles", weight: 1.3, mode: "accumulate", after: ["role"], dblclickP: 0.15, impatientP: 0.2 },
    { id: "reload", kind: "click", sel: "button.reload-members", weight: 0.4, mode: "replace" },
    { id: "team", kind: "select", sel: "select[name=team]", values: ["701", "702", "703", "704"], weight: 1.2, mode: "replace" },
    { id: "quota", kind: "type", sel: "input[name=quota]", values: ["50", "200", "750", "1200", "15"], weight: 1, mode: "replace", clear: true, then: ["applyQuota"] },
    { id: "applyQuota", kind: "click", sel: "button.apply-quota", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15 },
    { id: "grow", kind: "click", sel: "button.grow", weight: 1, mode: "accumulate", dblclickP: 0.2, impatientP: 0.2 },
    { id: "email", kind: "type", sel: ".invite-form input[name=email]", key: "invite", values: ["jordan@acme.io", "r.silva@acme.io", "temp.staff@agency.co", "ops-oncall@acme"], weight: 0.8, mode: "replace", clear: true, then: ["sendInvite"] },
    { id: "emailEnter", kind: "type", sel: ".invite-form input[name=email]", key: "invite", values: ["kim.lee@acme.io", "audit@pwc-partner.com"], weight: 0.5, mode: "replace", clear: true, enter: true },
    { id: "sendInvite", kind: "click", sel: "button.send-invite", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.25 },
    { id: "inviteRole", kind: "select", sel: ".invite-form select[name=role]", values: ["viewer", "editor", "admin"], weight: 0.4, mode: "replace" },
    { id: "revoke", kind: "click", sel: "ul.invite-list button.revoke", nth: 3, weight: 0.6, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "ul.invite-list button.revoke" },
    { id: "dismiss", kind: "click", sel: ".flash button.dismiss", weight: 0.4, mode: "replace", requires: ".flash [role=alert]" },
  ],
  external: [
    { kind: "create", target: "audit", perMin: 3, data: [
      { actor: "maria.k", action: "changed the role of", target: "aiko.t@acme.io" },
      { actor: "system", action: "sent the weekly usage report to", target: "billing" },
      { actor: "devon", action: "revoked an invite for", target: "old.vendor@agency.co" },
      { actor: "lucia", action: "updated billing contact for", target: "Acme Cloud" },
    ] },
    { kind: "update", target: "members", perMin: 1, data: [{ status: "suspended" }, { status: "active" }, { role: "editor" }] },
    { kind: "update", target: "teams", perMin: 1, data: [{ usedGb: 88 }, { usedGb: 471 }, { usedGb: 1101 }] },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
