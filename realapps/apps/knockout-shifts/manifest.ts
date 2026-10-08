import type { AppManifest } from "../../src/shared/manifest.js";

const slots: [string, string, string, number, number][] = [
  ["Sat", "9:00–12:00", "sorting", 6, 4], ["Sat", "9:00–12:00", "packing", 8, 7], ["Sat", "12:00–15:00", "driver", 3, 1], ["Sat", "12:00–15:00", "front desk", 2, 1],
  ["Sat", "15:00–18:00", "packing", 8, 3], ["Sun", "9:00–12:00", "sorting", 6, 5], ["Sun", "9:00–12:00", "driver", 3, 2], ["Sun", "12:00–15:00", "packing", 8, 6],
  ["Sun", "12:00–15:00", "front desk", 2, 0], ["Sun", "15:00–18:00", "sorting", 6, 2],
];
const shifts = slots.map(([day, time, role, capacity, filled], i) => ({ id: 40 + i, day, time, role, capacity, filled }));

const manifest: AppManifest = {
  name: "knockout-shifts",
  title: "Volunteer shifts",
  framework: "knockout",
  libs: ["knockout", "fetch", "WebSocket"],
  domain: "volunteer-shifts",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "shifts", seed: shifts, live: true, filters: ["day", "role"], envelope: "results", pageSize: 40, actions: { join: { inc: "filled", by: 1 }, leave: { inc: "filled", by: -1 } } },
      { name: "signups", seed: [], unique: ["shiftId"], required: ["shiftId"], envelope: "results" },
    ],
  },
  variants: {
    signup: ["wait", "optimistic-rollback", "optimistic"],
    joinGuard: ["pending", "none"],
    capacity: ["server-check", "client"],
    live: ["newer-wins", "blind"],
    reconnect: ["resync", "naive"],
  },
  affordances: [
    { id: "day", kind: "select", sel: "select[name=day]", values: ["all", "Sat", "Sun"], weight: 1, mode: "replace" },
    { id: "role", kind: "click", sel: "nav.roles button", text: ["All roles", "sorting", "packing", "driver", "front desk"], weight: 1, mode: "replace", key: "role" },
    { id: "join", kind: "click", sel: "li.shift button.join", nth: 6, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "li.shift button.join" },
    { id: "leave", kind: "click", sel: "li.shift button.leave", nth: 2, weight: 1.2, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.shift button.leave" },
  ],
  external: [
    { kind: "action", target: "shifts", perMin: 2.5, verb: "join" },
    { kind: "action", target: "shifts", perMin: 1.5, verb: "leave", where: { role: "packing" } },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
