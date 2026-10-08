import type { AppManifest } from "../../src/shared/manifest.js";

const titles: Record<string, string[]> = {
  work: ["Review Q3 hiring plan", "Update incident runbook", "Prep sprint demo", "Reply to legal about DPA", "Fix flaky checkout test", "Draft OKR comments", "1:1 notes for Ines"],
  personal: ["Renew passport", "Call grandma", "Book dentist", "Return library books", "Plan Lisbon trip"],
  errands: ["Pick up dry cleaning", "Buy printer ink", "Drop off recycling", "Get bike tuned"],
};
const tasks: Record<string, unknown>[] = [];
let n = 0;
for (const [project, ts] of Object.entries(titles))
  for (const title of ts) tasks.push({ id: 4100 + n, title, done: n % 4 === 1, project, priority: n % 5 === 0 ? "high" : "normal", version: 1 + (n++ % 3) });

const manifest: AppManifest = {
  name: "alpine-tasks",
  title: "Team tasks",
  framework: "alpine",
  libs: ["alpinejs", "fetch", "Alpine.store(rt.atom)"],
  domain: "productivity",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "tasks", seed: tasks, versioned: true, filters: ["project", "done"], envelope: "data", pageSize: 50 }],
  },
  variants: {
    conflict: ["refetch", "overwrite", "keep-local"],
    rollback: [true, false],
    versionFromEcho: [true, false],
    serialize: [true, false, false],
    addDisable: [true, false],
    syncMs: [12000, 6000],
  },
  affordances: [
    { id: "toggle", kind: "check", sel: "li.task input.toggle", nth: 7, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15 },
    { id: "edit", kind: "dblclick", sel: "li.task span.title", nth: 7, weight: 2, mode: "replace", intent: "nth", then: ["rename"] },
    { id: "rename", kind: "type", sel: "li.task input.edit-title", values: [" (today)", " — blocked", " v2", " ✓ reviewed"], weight: 0, mode: "replace", enter: true, followOnly: true },
    { id: "project", kind: "click", sel: "button.project", text: ["Work", "Personal", "Errands"], weight: 1.5, mode: "replace" },
    { id: "draft", kind: "type", sel: "input[name=new-task]", values: ["Send invoice to Northwind", "Water the plants", "Schedule design review", "Order team lunch"], weight: 1.3, mode: "replace", clear: true, then: ["add"] },
    { id: "add", kind: "click", sel: "button.add-btn", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.25 },
    { id: "delete", kind: "click", sel: "li.task button.delete", nth: 7, weight: 0.5, mode: "accumulate", intent: "nth" },
    { id: "clear", kind: "click", sel: "button.clear-done", weight: 0.4, mode: "accumulate", dblclickP: 0.1 },
    { id: "dismiss", kind: "click", sel: "button.dismiss", weight: 0.3, mode: "replace" },
  ],
  external: [
    { kind: "update", target: "tasks", perMin: 3, data: [{ done: true }, { done: false }, { priority: "high" }, { title: "Moved to next week (Sam)" }] },
    { kind: "create", target: "tasks", perMin: 0.6, data: [{ title: "Sync with design", project: "work", done: false, priority: "normal" }, { title: "Buy oat milk", project: "errands", done: false, priority: "low" }] },
  ],
  weights: { "tasks.loading": 0.1, "tasks.adding": 0.1, "tasks.error": 0, "tasks.notice": 0 },
  relations: [{ name: "remaining == open tasks", fields: ["tasks.remaining", "tasks.items"], check: (s) => !s.tasks || s.tasks.remaining === s.tasks.items.filter((t: { done: boolean }) => !t.done).length }],
  sessionMs: [25000, 70000],
};
export default manifest;
