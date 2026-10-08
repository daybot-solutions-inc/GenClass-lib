import type { AppManifest } from "../../src/shared/manifest.js";

const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dates = [
  ...days.map((d, i) => ({ id: 900 + i, week: "this", day: `${d} ${13 + i}`, left: [2, 1, 3, 0, 2, 1][i], capacity: 6 })),
  ...days.map((d, i) => ({ id: 910 + i, week: "next", day: `${d} ${20 + i}`, left: [4, 3, 5, 2, 4, 3][i], capacity: 6 })),
];

const manifest: AppManifest = {
  name: "hyperapp-recycling",
  title: "Bulky waste pickup",
  framework: "hyperapp",
  libs: ["hyperapp@2", "effects/subscriptions", "fetch", "hyperappGuard"],
  domain: "bulky-waste-pickup",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "dates", seed: dates, filters: ["week"], envelope: "items", pageSize: 20, actions: { take: { inc: "left", by: -1 }, giveback: { inc: "left", by: 1 } } },
      { name: "bookings", seed: [{ id: 4401, resident: "you", dateId: 911, day: "Tuesday 21", items: ["Mattress"], status: "scheduled" }], required: ["resident", "dateId"], filters: ["resident"], envelope: "items" },
    ],
  },
  variants: {
    confirmKey: ["idempotency-key", "none"],
    confirmGuard: ["pending", "none"],
    datesSeq: ["latest", "blind"],
    cancel: ["pessimistic", "optimistic-no-rollback"],
    capacity: ["server", "local"],
  },
  affordances: [
    { id: "item", kind: "check", sel: "section.items li.item input", nth: 7, weight: 3, mode: "accumulate", intent: "nth", then: ["item2"] },
    { id: "item2", kind: "check", sel: "section.items li.item input", nth: 7, weight: 0, mode: "accumulate", intent: "nth", followOnly: true },
    { id: "week", kind: "click", sel: "nav.weeks button", text: ["This week", "Next week"], weight: 1, mode: "replace", key: "week", requires: "nav.weeks button" },
    { id: "date", kind: "click", sel: "li.date button.choose", nth: 5, weight: 2.5, mode: "replace", key: "date", requires: "li.date button.choose", then: ["confirm"] },
    { id: "confirm", kind: "click", sel: "section.confirm button.confirm", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.25, requires: "section.confirm button.confirm:not([disabled])" },
    { id: "confirmAgain", kind: "click", sel: "section.confirm button.confirm", weight: 0.8, mode: "accumulate", dblclickP: 0.15, impatientP: 0.25, requires: "section.confirm button.confirm:not([disabled])" },
    { id: "cancel", kind: "click", sel: "li.booking button.cancel", nth: 3, weight: 0.9, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.booking button.cancel:not([disabled])" },
  ],
  external: [
    { kind: "action", target: "dates", perMin: 6, verb: "take", where: { left: { $gt: 0 } } },
    { kind: "action", target: "dates", perMin: 1.5, verb: "giveback", where: { left: { $lt: 5 } } },
    { kind: "update", target: "bookings", perMin: 2, where: { status: "scheduled" }, data: [{ status: "crew assigned" }] },
  ],
  weights: { "pickup.error": 0, "pickup.notice": 0, "pickup.datesLoading": 0.1, "pickup.confirming": 0.1, "pickup.cancelling": 0.1, "pickup.key": 0, "pickup.items": 0.3 },
  relations: [
    { name: "dates belong to the chosen week", fields: ["pickup.dates", "pickup.week"], check: (s) => !s.pickup || s.pickup.datesLoading || s.pickup.dates.every((d: { week: string }) => d.week === s.pickup.week) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
