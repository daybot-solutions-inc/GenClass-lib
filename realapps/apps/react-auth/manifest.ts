import type { AppManifest } from "../../src/shared/manifest.js";

const projects = ["Website relaunch", "Data warehouse", "Mobile app 3.0", "SOC 2 audit", "Partner portal", "Pricing page"].map((name, i) => ({ id: 120 + i, name, status: ["on track", "at risk", "blocked"][i % 3], progress: 10 + ((i * 23) % 85) }));
const invoices = ["Acme Corp", "Globex", "Initech", "Umbrella", "Hooli", "Stark Ind."].map((customer, i) => ({ id: 3100 + i, customer, amount: 1200 + i * 350, status: i % 3 === 0 ? "approved" : "pending" }));
const notifications = ["Build 1.8.2 deployed", "New comment on Pricing page", "Invoice 3104 is overdue", "Kim invited you to Partner portal", "Weekly report ready", "Password policy updated", "Audit evidence requested", "Sam assigned you a task"].map((text, i) => ({ id: 4400 + i, text, read: i % 4 === 3 }));

type N = { read: boolean };

const manifest: AppManifest = {
  name: "react-auth",
  title: "Ops dashboard",
  framework: "react",
  libs: ["react", "axios", "axios-interceptors", "rt.atom", "useAtom"],
  domain: "saas-dashboard",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    auth: { ttlMs: 20000, rotate: true },
    collections: [
      { name: "projects", seed: projects, envelope: "data", protected: true, pageSize: 50 },
      { name: "invoices", seed: invoices, envelope: "data", protected: true, pageSize: 50, filters: ["status"] },
      { name: "notifications", seed: notifications, envelope: "data", protected: true, pageSize: 50, actions: { read: { set: { read: true } } } },
    ],
  },
  variants: {
    refresh: ["single-flight", "per-request", "per-request"],
    retryOriginal: [true, false],
    autoRefreshMs: [10000, 6000, 15000],
  },
  affordances: [
    { id: "username", kind: "type", sel: "input[name=username]", values: ["dana", "lee", "sam.ops"], weight: 0.01, mode: "replace", clear: true, then: ["password", "signIn"], waitMs: 400 },
    { id: "password", kind: "type", sel: "input[name=password]", values: ["demo-pass-1"], weight: 0, mode: "replace", clear: true, followOnly: true },
    { id: "signIn", kind: "click", sel: "button.sign-in", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.1, impatientP: 0.15 },
    { id: "signInAgain", kind: "click", sel: "button.sign-in", weight: 0.3, mode: "accumulate", after: ["signIn"], waitMs: 400, dblclickP: 0.1, impatientP: 0.15 },
    { id: "refresh", kind: "click", sel: "button.refresh-dash", weight: 1.5, mode: "replace", after: ["signIn"], dblclickP: 0.1, waitMs: 500 },
    { id: "reloadPanel", kind: "click", sel: ".panel button.reload-panel", nth: 3, weight: 1.2, mode: "replace", intent: "nth", after: ["signIn"], dblclickP: 0.1, waitMs: 500 },
    { id: "invoiceFilter", kind: "select", sel: "select[name=invoiceStatus]", values: ["all", "pending", "approved", "all"], weight: 1, mode: "replace", after: ["signIn"], waitMs: 500 },
    { id: "approve", kind: "click", sel: ".invoice button.approve", nth: 4, weight: 2, mode: "accumulate", intent: "nth", after: ["signIn"], dblclickP: 0.12, impatientP: 0.15, waitMs: 500 },
    { id: "markRead", kind: "click", sel: ".note button.mark-read", nth: 5, weight: 2, mode: "accumulate", intent: "nth", after: ["signIn"], dblclickP: 0.1, waitMs: 500 },
    { id: "signOut", kind: "click", sel: "button.sign-out", weight: 0.03, mode: "replace", after: ["signIn"], waitMs: 500 },
  ],
  external: [
    { kind: "update", target: "projects", perMin: 2, data: [{ status: "at risk" }, { status: "on track" }, { progress: 90 }] },
    { kind: "create", target: "notifications", perMin: 2, data: [{ text: "Deploy queued by Kim", read: false }, { text: "Invoice paid: Globex", read: false }, { text: "Raj mentioned you", read: false }] },
    { kind: "create", target: "invoices", perMin: 1.5, data: [{ customer: "Wayne Ent.", amount: 980, status: "pending" }, { customer: "Soylent", amount: 2240, status: "pending" }, { customer: "Tyrell", amount: 4100, status: "pending" }] },
  ],
  weights: { "auth.token": 0, "auth.refreshToken": 0, "auth.refreshes": 0, "auth.error": 0, "auth.busy": 0.1, "dash.errors": 0, "dash.pending": 0.1 },
  relations: [{ name: "unread == unread notifications", fields: ["dash.unread", "dash.notifications"], check: (s) => !s.dash || s.dash.unread === s.dash.notifications.filter((n: N) => !n.read).length }],
  errorSelector: "[role=alert]",
  sessionMs: [30000, 75000],
};
export default manifest;
