import type { AppManifest } from "../../src/shared/manifest.js";

const dests: [string, string, number][] = [
  ["OPO", "Porto", 55],
  ["CDG", "Paris", 150],
  ["ORY", "Paris", 145],
  ["LHR", "London", 160],
  ["LGW", "London", 155],
  ["MAD", "Madrid", 80],
  ["BCN", "Barcelona", 115],
  ["BER", "Berlin", 225],
  ["FCO", "Rome", 185],
  ["AMS", "Amsterdam", 170],
  ["MUC", "Munich", 190],
];
const carriers: [string, string][] = [
  ["TP", "TAP Air Portugal"],
  ["U2", "easyJet"],
  ["FR", "Ryanair"],
  ["IB", "Iberia"],
  ["LH", "Lufthansa"],
  ["AF", "Air France"],
  ["BA", "British Airways"],
  ["KL", "KLM"],
];
const flights = Array.from({ length: 48 }, (_, i) => {
  const [to, city, base] = dests[i % dests.length]!;
  const [cc, carrier] = carriers[(i * 3 + Math.floor(i / dests.length)) % carriers.length]!;
  const stops = i % 5 === 3 ? 1 : i % 11 === 7 ? 2 : 0;
  const cabin = i % 6 === 0 ? "business" : i % 4 === 1 ? "premium" : "economy";
  const hour = 6 + ((i * 5) % 16);
  const minute = ((i * 17) % 12) * 5;
  const price = 39 + ((i * 37) % 170) + (cabin === "business" ? 240 : cabin === "premium" ? 85 : 0) - stops * 12;
  return {
    id: 7100 + i,
    code: `${cc} ${1000 + ((i * 73) % 8000)}`,
    carrier,
    to,
    city,
    depart: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    duration: base + stops * 70 + ((i * 7) % 20),
    stops,
    cabin,
    price,
    seats: 2 + ((i * 13) % 9),
  };
});

const manifest: AppManifest = {
  name: "rx-search",
  title: "Fare finder",
  framework: "vanilla",
  libs: ["rxjs", "rxjs/fetch(fromFetch)", "rxjs/ajax(XHR)", "rt.atom"],
  domain: "travel",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      {
        name: "flights",
        seed: flights,
        search: ["city", "to", "carrier"],
        filters: ["stops", "cabin"],
        pageSize: 50,
        envelope: "items",
        actions: { book: { inc: "seats", by: -1 }, reprice: { inc: "price" } },
      },
      { name: "holds", seed: [], envelope: "bare" },
    ],
  },
  variants: {
    flatten: ["switch", "merge", "concat", "merge"],
    debounce: [300, 0, 150],
    holdMap: ["exhaust", "merge"],
    holdRetry: ["idem-key", "none", "blind"],
    holdTotal: ["derive", "incremental"],
  },
  affordances: [
    { id: "dest", kind: "type", sel: "input[name=dest]", values: ["Porto", "Paris", "London", "Madrid", "Berlin", "Rome", "Par", "Lon", "Ryanair", "Amsterdam", ""], weight: 4, mode: "replace", clear: true },
    { id: "stops", kind: "select", sel: "select[name=stops]", values: ["any", "0", "1", "any"], weight: 1.4, mode: "replace" },
    { id: "cabin", kind: "select", sel: "select[name=cabin]", values: ["economy", "premium", "business", "economy"], weight: 1, mode: "replace" },
    { id: "sort", kind: "select", sel: "select[name=sort]", values: ["price", "depart", "duration"], weight: 1, mode: "replace" },
    { id: "hold", kind: "click", sel: ".flight button.hold", nth: 6, intent: "nth", weight: 2.5, mode: "accumulate", dblclickP: 0.2, impatientP: 0.2 },
    { id: "release", kind: "click", sel: ".held button.release", nth: 3, intent: "nth", weight: 1, mode: "accumulate", after: ["hold"], dblclickP: 0.1 },
  ],
  external: [
    // seats sell and fares step up while the user is searching
    { kind: "action", target: "flights", verb: "book", perMin: 6 },
    { kind: "action", target: "flights", verb: "reprice", by: 7, perMin: 2 },
  ],
  weights: { "search.dest": 0.3, "search.stops": 0.3, "search.cabin": 0.3, "search.sort": 0.3, "search.loading": 0.1, "search.error": 0, "holds.error": 0 },
  relations: [
    {
      name: "holds.total == sum(holds.items.price)",
      fields: ["holds.total", "holds.items"],
      check: (s) => !s.holds || !Array.isArray(s.holds.items) || Math.abs(s.holds.total - s.holds.items.reduce((a: number, h: { price: number }) => a + Number(h.price || 0), 0)) < 0.01,
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
