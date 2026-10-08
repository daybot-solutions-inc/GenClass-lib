import type { AppManifest } from "../../src/shared/manifest.js";

const rows: [string, string, string, number, string, number, string[]][] = [
  ["Kind of Blue", "Miles Davis", "jazz", 1959, "Columbia", 27.99, ["So What", "Freddie Freeloader", "Blue in Green"]],
  ["A Love Supreme", "John Coltrane", "jazz", 1965, "Impulse!", 29.5, ["Acknowledgement", "Resolution", "Pursuance", "Psalm"]],
  ["Mingus Ah Um", "Charles Mingus", "jazz", 1959, "Columbia", 24.0, ["Better Git It in Your Soul", "Goodbye Pork Pie Hat"]],
  ["Moanin'", "Art Blakey", "jazz", 1958, "Blue Note", 31.0, ["Moanin'", "Are You Real", "Along Came Betty"]],
  ["What's Going On", "Marvin Gaye", "soul", 1971, "Tamla", 26.5, ["What's Going On", "Mercy Mercy Me", "Inner City Blues"]],
  ["Lady Soul", "Aretha Franklin", "soul", 1968, "Atlantic", 23.99, ["Chain of Fools", "Natural Woman", "Since You've Been Gone"]],
  ["Curtis", "Curtis Mayfield", "soul", 1970, "Curtom", 25.0, ["Move On Up", "The Other Side of Town", "We the People"]],
  ["Selected Ambient Works 85-92", "Aphex Twin", "electronic", 1992, "Apollo", 32.0, ["Xtal", "Tha", "Pulsewidth", "Ageispolis"]],
  ["Music Has the Right to Children", "Boards of Canada", "electronic", 1998, "Warp", 34.99, ["Wildlife Analysis", "Roygbiv", "Aquarius"]],
  ["Homework", "Daft Punk", "electronic", 1997, "Virgin", 28.0, ["Revolution 909", "Da Funk", "Around the World"]],
  ["Remain in Light", "Talking Heads", "rock", 1980, "Sire", 26.0, ["Born Under Punches", "Crosseyed and Painless", "Once in a Lifetime"]],
  ["Marquee Moon", "Television", "rock", 1977, "Elektra", 27.0, ["See No Evil", "Venus", "Marquee Moon"]],
  ["Unknown Pleasures", "Joy Division", "rock", 1979, "Factory", 25.5, ["Disorder", "She's Lost Control", "Shadowplay"]],
  ["Pink Moon", "Nick Drake", "folk", 1972, "Island", 22.0, ["Pink Moon", "Place to Be", "Things Behind the Sun"]],
  ["Blue", "Joni Mitchell", "folk", 1971, "Reprise", 27.5, ["All I Want", "Carey", "River", "A Case of You"]],
  ["Bryter Layter", "Nick Drake", "folk", 1971, "Island", 23.0, ["Hazey Jane II", "Northern Sky", "Fly"]],
];
const records = rows.map(([title, artist, genre, year, label, price, tracks], i) => ({ id: 880 + i, title, artist, genre, year, label, price, stock: 1 + ((i * 5) % 4), tracks }));
const crate = [{ id: 51, productId: 884, title: "Marvin Gaye — What's Going On", price: 26.5, qty: 1 }];

const manifest: AppManifest = {
  name: "vue-router-shop",
  title: "Groove Cellar",
  framework: "vue",
  libs: ["vue", "vue-router(history)", "pinia", "fetch", "AbortController", "rt.guard"],
  domain: "music-retail",
  entry: "main.ts",
  integration: "stores",
  build: { vueCompiler: true },
  server: {
    base: "/api",
    collections: [
      { name: "records", seed: records, filters: ["genre"], pageSize: 50, envelope: "items", actions: { sell: { inc: "stock", by: -1 }, restock: { inc: "stock", by: 2 } } },
      { name: "crate", seed: crate, envelope: "bare" },
    ],
    cart: { collection: "crate" },
  },
  variants: {
    productFetch: ["abort", "none", "check-id", "none"],
    catalogGuard: ["latest", "none"],
    addLock: [true, false],
    badge: ["from-echo", "local-increment"],
    qtyFlush: ["flush-on-leave", "drop", "drop"],
  },
  // Flows start from the always-visible nav links; page-specific steps are follow-ups (they wait for their page).
  affordances: [
    { id: "browse", kind: "click", sel: "nav a.to-catalog", weight: 1.4, mode: "replace", key: "page", then: ["open"] },
    { id: "buy", kind: "click", sel: "nav a.to-catalog", weight: 2, mode: "replace", key: "page", then: ["open", "add"] },
    { id: "quickBuy", kind: "click", sel: "nav a.to-catalog", weight: 1, mode: "replace", key: "page", then: ["quickAdd"] },
    { id: "filter", kind: "click", sel: "nav a.to-catalog", weight: 1.2, mode: "replace", key: "page", then: ["genre", "open"] },
    // flicking between related records before the first one has loaded
    { id: "dig", kind: "click", sel: "nav a.to-catalog", weight: 1, mode: "replace", key: "page", then: ["open", "hop", "hop2"] },
    { id: "editCrate", kind: "click", sel: "nav a.to-crate", weight: 1.4, mode: "replace", key: "page", then: ["inc"] },
    // bump a quantity and head straight back to the shelves
    { id: "crateLeave", kind: "click", sel: "nav a.to-crate", weight: 1, mode: "replace", key: "page", then: ["incOnce", "leave"] },
    { id: "trim", kind: "click", sel: "nav a.to-crate", weight: 0.6, mode: "replace", key: "page", then: ["dec"] },
    { id: "prune", kind: "click", sel: "nav a.to-crate", weight: 0.4, mode: "replace", key: "page", then: ["remove"] },
    { id: "related", kind: "click", sel: ".record a.related-link", nth: 3, intent: "nth", weight: 0.8, mode: "replace", key: "page", requires: ".record a.related-link" },
    { id: "add", kind: "click", sel: "button.add-to-crate", weight: 0.8, mode: "accumulate", requires: ".record", dblclickP: 0.2, impatientP: 0.25 },
    { id: "back", kind: "click", sel: ".record a.back", weight: 0.6, mode: "replace", key: "page", requires: ".record a.back" },
    { id: "open", kind: "click", sel: ".catalog a.record-link", nth: 12, intent: "nth", weight: 0, mode: "replace", key: "page", followOnly: true },
    { id: "quickAdd", kind: "click", sel: ".record-row button.quick-add", nth: 12, intent: "nth", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2 },
    { id: "genre", kind: "select", sel: "select[name=genre]", values: ["all", "jazz", "soul", "electronic", "rock", "folk"], weight: 0, mode: "replace", followOnly: true },
    { id: "hop", kind: "click", sel: ".record a.related-link", nth: 3, intent: "nth", weight: 0, mode: "replace", key: "page", followOnly: true },
    { id: "hop2", kind: "click", sel: ".record a.related-link", nth: 3, intent: "nth", weight: 0, mode: "replace", key: "page", followOnly: true },
    { id: "inc", kind: "click", sel: ".crate-line button.inc", nth: 3, intent: "nth", weight: 0, mode: "accumulate", burst: [0, 3], followOnly: true },
    { id: "incOnce", kind: "click", sel: ".crate-line button.inc", nth: 3, intent: "nth", weight: 0, mode: "accumulate", burst: [0, 1], followOnly: true },
    { id: "leave", kind: "click", sel: "nav a.to-catalog", weight: 0, mode: "replace", key: "page", followOnly: true },
    { id: "dec", kind: "click", sel: ".crate-line button.dec", nth: 3, intent: "nth", weight: 0, mode: "accumulate", followOnly: true },
    { id: "remove", kind: "click", sel: ".crate-line button.remove", nth: 3, intent: "nth", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.1 },
  ],
  external: [
    { kind: "action", target: "records", verb: "sell", perMin: 3 },
    { kind: "action", target: "records", verb: "restock", perMin: 0.8 },
  ],
  weights: {
    "catalog.genre": 0.3,
    "catalog.loading": 0.1,
    "catalog.error": 0,
    "record.loading": 0.1,
    "record.error": 0,
    "record.id": 0.5,
    "crate.adding": 0.1,
    "crate.loading": 0.1,
    "crate.notice": 0.1,
    "crate.error": 0,
  },
  relations: [
    {
      name: "crate.count == sum(crate.items.qty)",
      fields: ["crate.count", "crate.items"],
      check: (s) => !s.crate || !Array.isArray(s.crate.items) || s.crate.adding.length > 0 || s.crate.count === s.crate.items.reduce((a: number, l: { qty: number }) => a + Number(l.qty), 0),
    },
    {
      name: "crate.total == sum(items.price * items.qty)",
      fields: ["crate.total", "crate.items"],
      check: (s) => !s.crate || !Array.isArray(s.crate.items) || Math.abs(s.crate.total - s.crate.items.reduce((a: number, l: { qty: number; price: number }) => a + Number(l.qty) * Number(l.price), 0)) < 0.01,
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
