import type { AppManifest } from "../../src/shared/manifest.js";

const T: [string, string, string, number][] = [
  ["Spin 45", "Mon", "07:00", 12], ["Yoga flow", "Mon", "18:30", 16], ["HIIT", "Mon", "19:30", 10],
  ["Pilates", "Tue", "08:00", 10], ["Boxing basics", "Tue", "18:00", 12], ["Spin 45", "Tue", "19:00", 12],
  ["Kettlebells", "Wed", "07:00", 8], ["Yoga flow", "Wed", "18:30", 16], ["Barre", "Wed", "19:30", 10],
  ["Spin 45", "Thu", "07:00", 12], ["Mobility", "Thu", "12:15", 14], ["HIIT", "Thu", "19:30", 10],
];
const classes = T.map(([name, day, time, capacity], i) => ({ id: 510 + i, name, day, time, capacity, booked: Math.max(0, capacity - 1 - (i % 4)), coach: ["Mia", "Dev", "Ola", "Sam"][i % 4] }));

const manifest: AppManifest = {
  name: "svelte-gym",
  title: "Class booking",
  framework: "svelte",
  libs: ["svelte", "fetch", "rt.atom", "atomStore"],
  domain: "gym-booking",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "classes", seed: classes, filters: ["day"], envelope: "items", pageSize: 40, actions: { book: { inc: "booked", by: 1 }, unbook: { inc: "booked", by: -1 } } },
      { name: "bookings", seed: [{ id: 41, classId: 511, name: "Yoga flow", day: "Mon", time: "18:30" }], unique: ["classId"], required: ["classId"], envelope: "items" },
    ],
  },
  variants: {
    bookGuard: ["disable", "none"],
    order: ["booking-first", "count-first"],
    dayLoad: ["latest", "blind"],
    myCount: ["derive", "manual"],
    pollMs: [5000, 3000],
  },
  affordances: [
    { id: "day", kind: "click", sel: "nav.days button", text: ["Mon", "Tue", "Wed", "Thu"], weight: 2, mode: "replace", key: "day" },
    { id: "book", kind: "click", sel: "li.class button.book", nth: 3, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.18, impatientP: 0.25, requires: "li.class button.book" },
    { id: "cancel", kind: "click", sel: "li.booking button.cancel", nth: 3, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.12, requires: "li.booking button.cancel" },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.5, mode: "replace" },
  ],
  external: [
    { kind: "action", target: "classes", perMin: 4, verb: "book" },
    { kind: "action", target: "classes", perMin: 2, verb: "unbook", where: { day: "Mon" } },
  ],
  weights: { "gym.error": 0, "gym.notice": 0, "gym.loading": 0.1, "gym.pending": 0.1 },
  relations: [{ name: "booking count == bookings", fields: ["gym.count", "gym.mine"], check: (s) => !s.gym || s.gym.count === s.gym.mine.length }],
  errorSelector: "[role=alert]",
  build: { svelte: true },
  sessionMs: [25000, 60000],
};
export default manifest;
