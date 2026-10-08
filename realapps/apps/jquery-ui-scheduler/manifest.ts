import type { AppManifest } from "../../src/shared/manifest.js";

const employees = [
  { id: 11, name: "Ann Lee", maxHours: 40 },
  { id: 12, name: "Bob Mensah", maxHours: 32 },
  { id: 13, name: "Carla Ruiz", maxHours: 40 },
  { id: 14, name: "Dev Patel", maxHours: 24 },
  { id: 15, name: "Eve Novak", maxHours: 32 },
];
// employee -> days worked (0 = Mon)
const pattern: Record<number, number[]> = { 11: [0, 1, 2, 3], 12: [0, 2, 4], 13: [1, 2, 3, 4], 14: [0, 4], 15: [1, 3, 4] };
const times: [string, string, number][] = [
  ["07:00", "15:00", 8],
  ["09:00", "17:00", 8],
  ["12:00", "20:00", 8],
  ["08:00", "14:00", 6],
];
const shifts = Object.entries(pattern).flatMap(([emp, days], i) => days.map((day, j) => {
  const [start, end, hours] = times[(i + j) % times.length]!;
  return { id: 2000 + Number(emp) * 10 + day, employeeId: Number(emp), day, start, end, hours };
}));

type Sh = { employeeId: number; day: number; hours: number };

const manifest: AppManifest = {
  name: "jquery-ui-scheduler",
  title: "Front-of-house rota",
  framework: "jquery",
  libs: ["jquery", "$.ajax(xhr)", "rt.atom"],
  domain: "workforce",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "employees", seed: employees, envelope: "bare" },
      { name: "shifts", seed: shifts, envelope: "bare", pageSize: 100, required: ["employeeId"], actions: { next: { inc: "day", by: 1 }, prev: { inc: "day", by: -1 } } },
    ],
  },
  variants: {
    moveWrite: ["absolute", "relative"],
    moveGuard: ["pending", "none"],
    swap: ["sequential-rollback", "parallel", "sequential"],
    hours: ["derived", "incremental"],
    pollMs: [6000, 3000],
  },
  affordances: [
    { id: "next", kind: "click", sel: ".shift button.next", nth: 16, weight: 1.8, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.15 },
    { id: "prev", kind: "click", sel: ".shift button.prev", nth: 16, weight: 1.3, mode: "accumulate", intent: "nth", dblclickP: 0.12 },
    { id: "swap", kind: "click", sel: ".shift button.swap", nth: 16, weight: 1.8, mode: "replace", key: "swap", intent: "nth", then: ["swapWith", "confirmSwap"] },
    { id: "swapWith", kind: "select", sel: ".swap-panel select[name=with]", nth: 3, weight: 0, mode: "replace", key: "swap", followOnly: true, requires: ".swap-panel select[name=with]" },
    { id: "confirmSwap", kind: "click", sel: ".swap-panel button.confirm-swap", weight: 0, mode: "accumulate", followOnly: true, requires: ".swap-panel button.confirm-swap", dblclickP: 0.15, impatientP: 0.25 },
    { id: "cancelSwap", kind: "click", sel: ".swap-panel button.cancel-swap", weight: 0.3, mode: "replace", requires: ".swap-panel" },
    { id: "remove", kind: "click", sel: ".shift button.remove", nth: 16, weight: 0.5, mode: "accumulate", intent: "nth" },
    { id: "addEmp", kind: "select", sel: "select[name=emp]", values: employees.map((e) => String(e.id)), weight: 0.5, mode: "replace" },
    { id: "addDay", kind: "select", sel: "select[name=day]", values: ["0", "1", "2", "3", "4"], weight: 0.5, mode: "replace", then: ["addShift"] },
    { id: "addShift", kind: "click", sel: "button.add-shift", weight: 0.4, mode: "accumulate", dblclickP: 0.15 },
  ],
  external: [
    { kind: "update", target: "shifts", perMin: 2, data: [{ start: "10:00", end: "18:00", hours: 8 }, { start: "07:00", end: "13:00", hours: 6 }, { start: "12:00", end: "20:00", hours: 8 }, { start: "08:00", end: "14:00", hours: 6 }] },
  ],
  weights: { "schedule.loading": 0.1, "schedule.error": 0, "schedule.notice": 0, "schedule.pending": 0.1, "swap.busy": 0.1, swap: 0.3 },
  relations: [
    {
      name: "weekly hours == sum of shift hours",
      fields: ["schedule.hours", "schedule.shifts"],
      check: (s) => {
        if (!s.schedule || s.schedule.loading) return true;
        const h: Record<string, number> = {};
        for (const x of s.schedule.shifts as Sh[]) h[x.employeeId] = (h[x.employeeId] ?? 0) + x.hours;
        return (s.schedule.employees as { id: number }[]).every((e) => (h[e.id] ?? 0) === (s.schedule.hours[e.id] ?? 0));
      },
    },
    {
      name: "nobody works two shifts on one day",
      fields: ["schedule.shifts"],
      check: (s) => {
        if (!s.schedule) return true;
        const seen = new Set<string>();
        for (const x of s.schedule.shifts as Sh[]) {
          const k = `${x.employeeId}:${x.day}`;
          if (seen.has(k)) return false;
          seen.add(k);
        }
        return true;
      },
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
