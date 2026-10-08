import type { AppManifest } from "../../src/shared/manifest.js";

const days: [string, string, string, number][] = [
  ["2026-11-02", "Mon 2 Nov", "Maple", 2],
  ["2026-11-03", "Tue 3 Nov", "Cedar", 1],
  ["2026-11-05", "Thu 5 Nov", "Birch", 3],
  ["2026-11-06", "Fri 6 Nov", "Willow", 1],
  ["2026-11-07", "Sat 7 Nov", "Juniper", 2],
  ["2026-11-09", "Mon 9 Nov", "Aspen", 2],
  ["2026-11-10", "Tue 10 Nov", "Hemlock", 0],
  ["2026-11-12", "Thu 12 Nov", "Spruce", 3],
];
const dates = days.map(([date, label, crew, left], i) => ({ id: 9100 + i, date, label, crew, left }));
const CUFT: Record<string, number> = { bedroom: 160, living: 200, dining: 120, kitchen: 100, office: 90, garage: 180 };
const volumeOf = (rooms: Record<string, number>) => Object.entries(rooms ?? {}).reduce((s, [k, n]) => s + (CUFT[k] ?? 0) * Number(n), 0);

const manifest: AppManifest = {
  name: "xstate-moving",
  title: "Moving quote",
  framework: "preact",
  libs: ["preact", "@preact/signals", "xstate@5", "createActor", "fromPromise(signal)", "fromCallback", "spawnChild", "after (delayed transitions)", "fetch", "rt.atom", "atomSignal"],
  domain: "moving-company-quote",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "quotes", seed: [], required: ["cubicFeet"], envelope: "items" },
      { name: "dates", seed: dates, filters: ["crew"], envelope: "items", pageSize: 12, actions: { take: { inc: "left", by: -1 }, give: { inc: "left", by: 1 } } },
      { name: "holds", seed: [], unique: ["slot"], required: ["dateId", "slot"], filters: ["customer"], envelope: "items" },
      { name: "bookings", seed: [], required: ["quoteId", "dateId"], filters: ["customer"], envelope: "items" },
    ],
  },
  variants: {
    quote: ["invoke-cancel", "spawn-leak"],
    holdExpiry: ["release", "leak"],
    bookKey: ["idempotency-key", "none"],
    bookGuard: ["state", "none"],
    dates: ["refetch-on-enter", "once"],
  },
  affordances: [
    { id: "more", kind: "click", sel: "li.room button.inc", nth: 6, weight: 2.2, mode: "accumulate", intent: "nth", burst: [0, 2], requires: "li.room button.inc:not([disabled])" },
    { id: "fewer", kind: "click", sel: "li.room button.dec", nth: 4, weight: 1, mode: "accumulate", intent: "nth", requires: "li.room button.dec:not([disabled])" },
    { id: "dates", kind: "click", sel: "footer button.to-dates", weight: 1.8, mode: "accumulate", dblclickP: 0.1, impatientP: 0.2, requires: "footer button.to-dates:not([disabled])", then: ["pick"] },
    { id: "pick", kind: "click", sel: "li.date button.hold", nth: 4, weight: 0, mode: "accumulate", intent: "nth", followOnly: true, dblclickP: 0.15 },
    { id: "hold", kind: "click", sel: "li.date button.hold", nth: 4, weight: 1, mode: "accumulate", intent: "nth", after: ["dates"], dblclickP: 0.15, impatientP: 0.2, requires: "li.date button.hold:not([disabled])" },
    { id: "book", kind: "click", sel: "section.held button.book", weight: 2.5, mode: "accumulate", after: ["dates"], dblclickP: 0.2, impatientP: 0.3, requires: "section.held button.book:not([disabled])" },
    { id: "back", kind: "click", sel: "footer button.back", weight: 0.6, mode: "replace", after: ["dates"], requires: "footer button.back" },
    { id: "again", kind: "click", sel: "footer button.again", weight: 2.5, mode: "accumulate", after: ["book"], resets: ["dates", "book"], requires: "footer button.again" },
  ],
  external: [
    { kind: "action", target: "dates", perMin: 4, verb: "take", where: { left: { $gt: 0 } } },
    { kind: "action", target: "dates", perMin: 2, verb: "give", where: { left: { $lt: 3 } } },
  ],
  weights: { "move.error": 0, "move.notice": 0, "move.bookKey": 0, "move.quoting": 0.1, "move.busy": 0.1, "move.loadingDates": 0.1, "move.holdLeft": 0.1 },
  relations: [
    {
      name: "the quote is for the current inventory",
      fields: ["move.quote", "move.rooms"],
      check: (s) => !s.move || s.move.quoting || !s.move.quote || s.move.quote.cubicFeet === volumeOf(s.move.rooms),
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
