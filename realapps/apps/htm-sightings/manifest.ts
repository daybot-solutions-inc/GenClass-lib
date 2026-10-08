import type { AppManifest } from "../../src/shared/manifest.js";

const rows: [string, string, number, string, string, number][] = [
  ["Great blue heron", "waterbird", 2, "Mill Pond", "priya", 3], ["Red fox", "mammal", 1, "North Meadow", "marc", 1], ["Northern cardinal", "songbird", 4, "Cedar Marsh", "jo", 0],
  ["Spring peeper", "amphibian", 12, "Cedar Marsh", "lin", 2], ["Red-tailed hawk", "raptor", 1, "Quarry Trail", "sam", 4], ["American beaver", "mammal", 2, "Mill Pond", "dev", 1],
  ["Painted turtle", "reptile", 5, "Mill Pond", "ana", 0], ["Great blue heron", "waterbird", 1, "Cedar Marsh", "kofi", 2], ["Northern cardinal", "songbird", 2, "North Meadow", "zoe", 1],
  ["Red-tailed hawk", "raptor", 2, "North Meadow", "raj", 0], ["Spring peeper", "amphibian", 30, "Quarry Trail", "priya", 1], ["Red fox", "mammal", 2, "Quarry Trail", "lin", 3],
  ["American beaver", "mammal", 1, "Cedar Marsh", "jo", 0], ["Painted turtle", "reptile", 3, "Cedar Marsh", "marc", 2], ["Great blue heron", "waterbird", 3, "North Meadow", "ana", 0],
  ["Northern cardinal", "songbird", 1, "Quarry Trail", "dev", 1],
];
const sightings = rows.map(([species, group, count, place, observer, confirmations], i) => ({
  id: 8800 + i,
  species,
  group,
  count,
  place,
  observer,
  confirmations,
  createdAt: `2026-03-${String(10 + i).padStart(2, "0")}T0${i % 10}:15:00.000Z`,
}));
const others = [
  { species: "Red-tailed hawk", group: "raptor", count: 1, place: "Mill Pond", observer: "kofi", confirmations: 0 },
  { species: "Spring peeper", group: "amphibian", count: 8, place: "North Meadow", observer: "zoe", confirmations: 0 },
  { species: "Red fox", group: "mammal", count: 1, place: "Cedar Marsh", observer: "sam", confirmations: 0 },
  { species: "Northern cardinal", group: "songbird", count: 3, place: "Mill Pond", observer: "raj", confirmations: 0 },
];

const manifest: AppManifest = {
  name: "htm-sightings",
  title: "Wildlife sightings",
  framework: "preact",
  libs: ["preact", "htm", "preact/hooks", "useAtom hook", "fetch", "WebSocket", "rt.atom"],
  domain: "citizen-science-sightings",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "sightings", seed: sightings, live: true, required: ["species", "place", "count"], filters: ["group", "observer"], envelope: "items", pageSize: 6, actions: { confirm: { inc: "confirmations", by: 1 } } },
      { name: "confirmations", seed: [], unique: ["key"], required: ["sightingId", "user"], filters: ["user"], envelope: "items" },
    ],
  },
  variants: {
    older: ["cursor", "offset"],
    report: ["reconcile", "append"],
    confirmGuard: ["pending", "none"],
    tally: ["derive", "incremental"],
    reconnect: ["resync", "naive"],
  },
  affordances: [
    { id: "group", kind: "select", sel: "select[name=group]", values: ["all", "birds", "mammals", "amphibians"], weight: 1, mode: "replace" },
    { id: "older", kind: "click", sel: "button.older", weight: 2, mode: "accumulate", dblclickP: 0.15, impatientP: 0.2, requires: "button.older:not([disabled])" },
    { id: "confirm", kind: "click", sel: "li.sighting button.confirm", nth: 6, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.15, requires: "li.sighting button.confirm:not([disabled])" },
    { id: "species", kind: "select", sel: "form.report select[name=species]", values: ["Great blue heron", "Red-tailed hawk", "Red fox", "Spring peeper", "Painted turtle"], weight: 1.5, mode: "replace", then: ["count", "report"] },
    { id: "count", kind: "type", sel: "form.report input[name=count]", values: ["2", "3", "6", "1"], clear: true, weight: 0, mode: "replace", followOnly: true },
    { id: "place", kind: "select", sel: "form.report select[name=place]", values: ["Mill Pond", "Cedar Marsh", "North Meadow", "Quarry Trail"], weight: 0.5, mode: "replace" },
    { id: "report", kind: "click", sel: "form.report button", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.15 },
  ],
  external: [
    { kind: "create", target: "sightings", perMin: 4, data: others },
    { kind: "action", target: "sightings", perMin: 6, verb: "confirm", where: { confirmations: { $lt: 4 } } },
  ],
  weights: { "sightings.error": 0, "sightings.notice": 0, "sightings.loading": 0.1, "sightings.loadingMore": 0.1, "sightings.pending": 0.1, "sightings.live": 0.1, "report.posting": 0.1, "report.count": 0.3 },
  relations: [
    { name: "tally = individuals shown", fields: ["sightings.tally", "sightings.rows"], check: (s) => !s.sightings || s.sightings.loading || s.sightings.tally === s.sightings.rows.reduce((a: number, r: { count: number }) => a + Number(r.count), 0) },
    { name: "no sighting twice", fields: ["sightings.rows"], check: (s) => !s.sightings || new Set(s.sightings.rows.map((r: { id: unknown }) => String(r.id))).size === s.sightings.rows.length },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
