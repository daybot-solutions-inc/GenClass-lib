import type { AppManifest } from "../../src/shared/manifest.js";

const orders: [string, string, string, number][] = [
  ["T4", "2× smash burger, fries", "grill", 2], ["T9", "caesar, soup of the day", "salad", 2], ["T2", "ribeye medium-rare", "grill", 1],
  ["Bar", "loaded nachos", "fry", 3], ["T7", "fish & chips ×2", "fry", 2], ["T11", "grilled halloumi wrap", "grill", 1],
  ["T5", "nicoise salad", "salad", 1], ["T3", "wings, onion rings", "fry", 4],
];
const status = ["new", "new", "new", "new", "cooking", "cooking", "cooking", "ready"];
const tickets = orders.map(([table, items, station, covers], i) => ({ id: 500 + i, table, items, station, covers, status: status[i], recalls: 0 }));

const manifest: AppManifest = {
  name: "effector-kds",
  title: "Kitchen display",
  framework: "react",
  libs: ["react", "effector", "effector-react", "createEffect", "useUnit", "fetch", "WebSocket", "rt.guard"],
  domain: "kitchen-display",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "tickets", seed: tickets, versioned: true, live: true, filters: ["station", "status"], envelope: "items", pageSize: 50, actions: { recall: { inc: "recalls", set: { status: "cooking" } } } },
    ],
  },
  variants: {
    live: ["version-check", "blind"],
    bumpGuard: ["pending", "none"],
    reconnect: ["resync", "naive"],
    recall: ["idempotency-key", "retry-blind", "no-retry"],
    allDay: ["derive", "incremental"],
  },
  affordances: [
    { id: "station", kind: "click", sel: "nav.stations button", text: ["All", "grill", "fry", "salad"], weight: 1.2, mode: "replace", key: "station" },
    { id: "start", kind: "click", sel: "li.ticket.new button.start", nth: 4, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "li.ticket.new button.start" },
    { id: "bump", kind: "click", sel: "li.ticket.cooking button.bump", nth: 4, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "li.ticket.cooking button.bump" },
    { id: "recall", kind: "click", sel: "li.ticket.ready button.recall", nth: 3, weight: 1, mode: "accumulate", intent: "nth", dblclickP: 0.1, impatientP: 0.15, requires: "li.ticket.ready button.recall" },
  ],
  external: [
    { kind: "create", target: "tickets", perMin: 3, data: [
        { table: "T6", items: "double cheeseburger", station: "grill", covers: 1, status: "new", recalls: 0 },
        { table: "T1", items: "calamari, fries", station: "fry", covers: 2, status: "new", recalls: 0 },
        { table: "T8", items: "greek salad ×3", station: "salad", covers: 3, status: "new", recalls: 0 },
        { table: "T12", items: "lamb skewers, flatbread", station: "grill", covers: 2, status: "new", recalls: 0 },
        { table: "Patio", items: "sweet potato fries ×2", station: "fry", covers: 2, status: "new", recalls: 0 },
        { table: "T10", items: "burrata, beet salad", station: "salad", covers: 2, status: "new", recalls: 0 },
      ] },
    { kind: "update", target: "tickets", perMin: 1.5, where: { status: "new" }, data: [{ status: "cooking" }] },
    { kind: "delete", target: "tickets", perMin: 2.5, where: { status: "ready" } },
  ],
  weights: { "board.error": 0, "board.notice": 0, "board.pending": 0.1, "board.live": 0.1, "board.station": 0.3 },
  relations: [
    {
      name: "all-day counts = open covers per station",
      fields: ["kitchen.allDay", "kitchen.tickets"],
      check: (s) => {
        const k = s.kitchen;
        if (!k) return true;
        return ["grill", "fry", "salad"].every((st) => k.allDay[st] === k.tickets.filter((t: { station: string; status: string }) => t.station === st && t.status !== "ready").reduce((a: number, t: { covers: number }) => a + t.covers, 0));
      },
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
