import type { AppManifest } from "../../src/shared/manifest.js";

const people: [string, string][] = [
  ["Ada", "Okafor"], ["Binh", "Nguyen"], ["Carla", "Johnson"], ["Darek", "Kowalski"], ["Emad", "Haddad"], ["Fiona", "Lee"], ["Gabriel", "Martinez"],
  ["Hiba", "Ali"], ["Ivan", "Petrov"], ["Joyce", "Mensah"], ["Karl", "Fischer"], ["Layla", "Ibrahim"], ["Maeve", "Walsh"], ["Nuno", "Santos"],
  ["Opal", "Kaur"], ["Pavel", "Novak"], ["Quentin", "Dubois"], ["Rukiye", "Yilmaz"], ["Sven", "Andersson"], ["Tegan", "Hughes"], ["Usman", "Khan"],
  ["Vivian", "Tanaka"], ["Walter", "Rossi"], ["Xola", "Mwangi"], ["Yara", "Garcia"], ["Zane", "Larsen"], ["Anca", "Popescu"], ["Bo", "Chen"],
  ["Cawo", "Abdi"], ["Dylan", "Morgan"],
];
const households = people.map(([first, last], i) => ({
  id: 5200 + i,
  name: `${first} ${last}`,
  ref: `HH-${String(410 + i * 7).padStart(4, "0")}`,
  size: 1 + ((i * 5) % 6),
  parcel: [1, 2, 1, 4, 1, 3, 2][i % 7],
  status: i % 9 === 4 || i % 11 === 7 ? "collected" : "waiting",
}));
const parcels = [
  { id: 1, kind: "Family box", stock: 34 },
  { id: 2, kind: "Single box", stock: 21 },
  { id: 3, kind: "Infant kit", stock: 7 },
  { id: 4, kind: "Halal box", stock: 12 },
];

const manifest: AppManifest = {
  name: "backbone-foodbank",
  title: "Food bank pickup desk",
  framework: "backbone",
  libs: ["backbone", "underscore", "jquery", "Backbone.sync($.ajax)", "rt.guard"],
  domain: "food-bank-distribution",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "households", seed: households, versioned: true, search: ["name", "ref"], filters: ["status", "parcel"], envelope: "items", pageSize: 8 },
      { name: "parcels", seed: parcels, envelope: "items", actions: { handout: { inc: "stock", by: -1 }, restock: { inc: "stock", by: 6 } } },
    ],
  },
  variants: {
    save: ["patch-if-match", "put"],
    pickupGuard: ["pending", "none"],
    stock: ["server", "local"],
    bulk: ["per-item", "assume-all"],
    fetch: ["abort-previous", "none"],
  },
  affordances: [
    { id: "search", kind: "type", sel: "input[name=q]", values: ["okafor", "an", "son", "HH-04", "ali", "ch", "kh", "ma"], clear: true, weight: 1.4, mode: "replace", key: "list", then: ["collectFound"] },
    { id: "collectFound", kind: "click", sel: "tr.household button.pickup", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.2, requires: "tr.household button.pickup:not([disabled])" },
    { id: "clearSearch", kind: "clear", sel: "input[name=q]", weight: 1, mode: "replace", key: "list", after: ["search"] },
    { id: "page", kind: "click", sel: "nav.pages button", nth: 4, weight: 1.5, mode: "replace", key: "list" },
    { id: "pickup", kind: "click", sel: "tr.household button.pickup", nth: 8, weight: 4, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.2, requires: "tr.household button.pickup:not([disabled])" },
    { id: "noShow", kind: "click", sel: "button.no-show", weight: 0.5, mode: "accumulate", dblclickP: 0.1, impatientP: 0.2, requires: "button.no-show:not([disabled])" },
  ],
  external: [
    { kind: "update", target: "households", perMin: 3, where: { status: "waiting" }, data: [{ status: "collected" }] },
    { kind: "update", target: "households", perMin: 1.5, where: { status: "waiting", parcel: 1 }, data: [{ parcel: 4 }, { parcel: 2 }] },
    { kind: "action", target: "parcels", perMin: 5, verb: "handout", where: { stock: { $gt: 0 } } },
    { kind: "action", target: "parcels", perMin: 0.6, verb: "restock" },
  ],
  weights: { "desk.error": 0, "desk.notice": 0, "desk.loading": 0.1, "desk.pending": 0.1, "desk.bulkBusy": 0.1, "desk.q": 0.3 },
  relations: [
    {
      name: "rows match the search",
      fields: ["desk.households", "desk.q"],
      check: (s) => !s.desk || s.desk.loading || !s.desk.q || s.desk.households.every((h: { name: string; ref: string }) => `${h.name} ${h.ref}`.toLowerCase().includes(String(s.desk.q).toLowerCase())),
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
