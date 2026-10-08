import type { AppManifest } from "../../src/shared/manifest.js";

const S: [string, string, string, number, number][] = [
  ["NRTH", "Northwind Systems", "tech", 142.3, 28], ["CLDR", "Cloudrise", "tech", 88.1, 41], ["BYTE", "Bytewell", "tech", 23.4, 17],
  ["GRNE", "Greenearth Energy", "energy", 54.2, 12], ["SOLR", "Solaria", "energy", 31.9, 22], ["PETR", "Petrocore", "energy", 76.5, 9],
  ["MEDX", "Medexa", "health", 210.4, 35], ["CURA", "Curalab", "health", 45.7, 19], ["VITA", "Vitalis", "health", 12.8, 14],
  ["BANKO", "Banko Group", "finance", 61.2, 11], ["LEDG", "Ledgerline", "finance", 98.6, 16], ["RETL", "Retailia", "consumer", 37.3, 21],
  ["SNAK", "Snackworks", "consumer", 19.9, 25], ["HOMZ", "Homzy", "consumer", 66.0, 30],
];
const stocks = S.map(([symbol, name, sector, price, pe], i) => ({ id: 1500 + i, symbol, name, sector, price, pe, change: ((i * 7) % 11) - 5 }));

const manifest: AppManifest = {
  name: "mithril-screener",
  title: "Stock screener",
  framework: "mithril",
  libs: ["mithril", "m.request(XHR)", "rt.atom"],
  domain: "stock-screener",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "stocks", seed: stocks, filters: ["sector", "symbol"], search: ["symbol", "name"], envelope: "items", pageSize: 30 },
      { name: "watchlist", seed: [{ id: 1, symbol: "MEDX" }], unique: ["symbol"], required: ["symbol"], envelope: "bare" },
    ],
  },
  variants: {
    screenSeq: ["latest", "blind"],
    watchGuard: ["pending", "none"],
    watchSave: ["wait", "optimistic", "optimistic-rollback"],
    quotePoll: ["chain", "interval"],
    pollMs: [3000, 2000],
  },
  affordances: [
    { id: "sector", kind: "select", sel: "select[name=sector]", values: ["all", "tech", "energy", "health", "finance", "consumer"], weight: 2, mode: "replace" },
    { id: "sort", kind: "select", sel: "select[name=sort]", values: ["pe", "-price", "-change", "symbol"], weight: 1.2, mode: "replace" },
    { id: "search", kind: "type", sel: "input[name=q]", values: ["n", "cl", "ener", "med", "sol"], weight: 1, mode: "replace", clear: true, waitMs: 1 },
    { id: "watch", kind: "click", sel: "tr.stock button.watch", nth: 6, weight: 2.5, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.25, requires: "tr.stock button.watch" },
    { id: "unwatch", kind: "click", sel: "li.watched button.unwatch", nth: 3, weight: 1.2, mode: "accumulate", intent: "nth", requires: "li.watched button.unwatch" },
  ],
  external: [
    { kind: "update", target: "stocks", perMin: 6, where: { sector: "tech" }, data: [{ price: 144.1, change: 2 }, { price: 86.0, change: -3 }, { price: 24.2, change: 1 }] },
    { kind: "update", target: "stocks", perMin: 3, data: [{ change: 4 }, { change: -2 }] },
  ],
  weights: { "screen.loading": 0.1, "screen.error": 0, "screen.q": 0.3, "watch.error": 0, "watch.notice": 0, "watch.pending": 0.1 },
  relations: [{ name: "results match the sector", fields: ["screen.rows", "screen.sector"], check: (s) => !s.screen || s.screen.loading || s.screen.sector === "all" || s.screen.rows.every((r: { sector: string }) => r.sector === s.screen.sector) }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
