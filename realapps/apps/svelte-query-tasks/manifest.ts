import type { AppManifest } from "../../src/shared/manifest.js";

const rows: [string, string, string, string, string][] = [
  ["Boiler pressure dropping overnight", "Boiler room", "urgent", "in-progress", "Marcus"],
  ["Lobby door closer sticking", "Lobby", "normal", "open", "unassigned"],
  ["Dishwasher leaking under the counter", "Level 2 kitchen", "normal", "open", "Dana"],
  ["Car park barrier stuck open", "Car park", "urgent", "open", "unassigned"],
  ["CRAC unit filter change", "Server room", "low", "open", "Priya"],
  ["Roof drain blocked by leaves", "Roof", "normal", "in-progress", "Marcus"],
  ["Flickering lights by the lifts", "Lobby", "low", "open", "unassigned"],
  ["Fridge door seal torn", "Level 2 kitchen", "low", "done", "Dana"],
  ["UPS battery warning", "Server room", "normal", "open", "Priya"],
  ["Gate intercom not ringing", "Car park", "normal", "done", "Marcus"],
];
const workorders = rows.map(([title, location, priority, status, assignee], i) => ({ id: 6200 + i, title, location, priority, status, assignee, createdAt: new Date(Date.UTC(2026, 2, 30, 8, 0) + i * 3600000).toISOString() }));

const manifest: AppManifest = {
  name: "svelte-query-tasks",
  title: "Facilities work orders",
  framework: "svelte",
  libs: ["svelte", "@tanstack/svelte-query", "fetch", "rt.guard", "svelte-store(rt.atom)"],
  domain: "facilities",
  entry: "main.ts",
  integration: "stores",
  build: { svelte: true },
  server: {
    base: "/api",
    collections: [{ name: "workorders", seed: workorders, pageSize: 50, envelope: "items", required: ["title", "location"] }],
  },
  variants: {
    rollback: ["per-item", "snapshot", "none"],
    cancelOnMutate: [true, false, false],
    invalidate: ["when-idle", "each", "none"],
    createLock: [true, false],
  },
  affordances: [
    { id: "status", kind: "select", sel: ".wo select.status", nth: 6, intent: "nth", values: ["open", "in-progress", "done", "in-progress"], weight: 4, mode: "replace" },
    { id: "escalate", kind: "click", sel: ".wo button.escalate", nth: 6, intent: "nth", weight: 1.5, mode: "accumulate", dblclickP: 0.15 },
    { id: "title", kind: "type", sel: "input[name=title]", values: ["Replace broken window latch", "Mop up water by the stairs", "Reset fire panel fault", "Unblock staff toilet", "Paint scuffed corridor"], weight: 2, mode: "replace", clear: true, then: ["log"] },
    { id: "log", kind: "click", sel: "button.log", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.2 },
    { id: "location", kind: "select", sel: "select[name=location]", values: ["Boiler room", "Lobby", "Level 2 kitchen", "Car park", "Server room", "Roof"], weight: 0.6, mode: "replace" },
    { id: "tab", kind: "select", sel: "select[name=tab]", values: ["active", "open", "in-progress", "done", "all"], weight: 1, mode: "replace" },
    { id: "delete", kind: "click", sel: ".wo button.delete", nth: 6, intent: "nth", weight: 0.6, mode: "accumulate", dblclickP: 0.1 },
  ],
  external: [
    // the rest of the facilities team working the same queue
    { kind: "update", target: "workorders", perMin: 2.5, data: [{ status: "in-progress" }, { status: "done" }, { assignee: "Dana" }, { assignee: "Marcus" }, { priority: "urgent" }] },
    { kind: "create", target: "workorders", perMin: 0.8, data: [{ title: "Smoke detector chirping", location: "Lobby", priority: "normal", status: "open", assignee: "unassigned" }, { title: "Coffee machine descaling", location: "Level 2 kitchen", priority: "low", status: "open", assignee: "unassigned" }] },
  ],
  weights: { "woForm.draft": 0.3, "woForm.location": 0.3, "woForm.tab": 0.3, "woForm.error": 0, "workorders.page": 0 },
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
