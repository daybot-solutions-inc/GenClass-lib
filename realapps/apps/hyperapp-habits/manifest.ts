import type { AppManifest } from "../../src/shared/manifest.js";

const habits = [
  { id: 31, name: "Morning run", goal: 4 },
  { id: 32, name: "Meditate", goal: 7 },
  { id: 33, name: "Spanish lesson", goal: 5 },
  { id: 34, name: "Floss", goal: 7 },
  { id: 35, name: "Journal", goal: 3 },
];
const checkins: Record<string, unknown>[] = [];
let id = 800;
for (const week of [12, 13, 14])
  for (const h of habits)
    for (let day = 0; day < 7; day++) if ((h.id * 3 + day * 5 + week) % 4 === 0 && !(week === 14 && day > 3)) checkins.push({ id: id++, habitId: h.id, week, day, key: `${h.id}:${week}:${day}` });

const manifest: AppManifest = {
  name: "hyperapp-habits",
  title: "Habit tracker",
  framework: "hyperapp",
  libs: ["hyperapp@2", "effects/subscriptions", "fetch", "hyperappGuard"],
  domain: "habit-tracker",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "habits", seed: habits, unique: ["name"], required: ["name"], envelope: "bare", pageSize: 30 },
      { name: "checkins", seed: checkins, unique: ["key"], required: ["key"], filters: ["week", "habitId"], envelope: "bare", pageSize: 100 },
    ],
  },
  variants: {
    checkin: ["optimistic-rollback", "optimistic", "wait"],
    cellGuard: ["pending", "none"],
    weekSeq: ["latest", "blind"],
    weekTotal: ["derive", "incremental"],
    poll: ["pending-aware", "blind"],
  },
  affordances: [
    { id: "cell", kind: "click", sel: "tr.habit td.day button", nth: 24, weight: 4, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.12 },
    { id: "prev", kind: "click", sel: "nav.weeks button.prev", weight: 0.8, mode: "replace", key: "week" },
    { id: "next", kind: "click", sel: "nav.weeks button.next", weight: 0.8, mode: "replace", key: "week", after: ["prev"], requires: "nav.weeks button.next:not([disabled])" },
    { id: "habitName", kind: "type", sel: "form.add input[name=habit]", values: ["Stretch", "Read 20 pages", "No sugar", "Call a friend"], clear: true, weight: 0.7, mode: "replace", then: ["addHabit"] },
    { id: "addHabit", kind: "click", sel: "form.add button", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.2 },
  ],
  external: [
    { kind: "create", target: "checkins", perMin: 2, data: [{ habitId: 32, week: 14, day: 4, key: "32:14:4" }, { habitId: 34, week: 14, day: 4, key: "34:14:4" }, { habitId: 31, week: 14, day: 5, key: "31:14:5" }, { habitId: 33, week: 14, day: 3, key: "33:14:3" }] },
  ],
  weights: { "habits.error": 0, "habits.notice": 0, "habits.loading": 0.1, "habits.pending": 0.1, "habits.draft": 0.3, "habits.week": 0.3 },
  relations: [
    { name: "week total = check-ins shown", fields: ["habits.total", "habits.checks"], check: (s) => !s.habits || s.habits.loading || s.habits.total === s.habits.checks.length },
    { name: "check-ins belong to the shown week", fields: ["habits.checks", "habits.week"], check: (s) => !s.habits || s.habits.loading || s.habits.checks.every((c: { week: number }) => c.week === s.habits.week) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
