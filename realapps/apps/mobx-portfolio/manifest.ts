import type { AppManifest } from "../../src/shared/manifest.js";

const prices: [string, number][] = [["AAPL", 190], ["MSFT", 410], ["GOOG", 165], ["AMZN", 180], ["NVDA", 120], ["TSLA", 240], ["META", 500], ["NFLX", 610], ["AMD", 160], ["SHOP", 70], ["UBER", 72], ["INTC", 31]];
const quotes = prices.map(([symbol, price], i) => ({ id: 40 + i, symbol, price }));
const holdings = [
  { id: 61, symbol: "AAPL", shares: 10 },
  { id: 62, symbol: "MSFT", shares: 5 },
  { id: 63, symbol: "NVDA", shares: 20 },
  { id: 64, symbol: "TSLA", shares: 8 },
];

type H = { symbol: string; shares: number };
const value = (hs: H[], q: Record<string, number>) => Math.round(hs.reduce((a, h) => a + h.shares * (q[h.symbol] ?? 0), 0) * 100) / 100;

const manifest: AppManifest = {
  name: "mobx-portfolio",
  title: "Watchlist",
  framework: "mobx-react",
  libs: ["react", "mobx", "mobx-react-lite", "fetch", "rt.guard"],
  domain: "finance",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "quotes", seed: quotes, envelope: "bare", filters: ["symbol"], pageSize: 50, actions: { up: { inc: "price", by: 1 }, down: { inc: "price", by: -1 } } },
      { name: "holdings", seed: holdings, envelope: "items", pageSize: 50 },
    ],
  },
  variants: {
    overlap: ["skip", "none", "none", "abort"],
    pollMs: [3000, 1500, 5000],
    total: ["recompute", "skip-on-remove", "skip-on-add"],
    addGuard: ["disable", "none"],
    echo: ["ignore-stale", "apply"],
  },
  affordances: [
    { id: "symbol", kind: "type", sel: "input[name=symbol]", values: ["NFLX", "AMD", "SHOP", "UBER", "INTC", "META", "GOOG"], weight: 1.5, mode: "replace", clear: true, then: ["add"] },
    { id: "add", kind: "click", sel: "button.add-holding", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.2 },
    { id: "buy", kind: "click", sel: ".holding button.buy", nth: 5, weight: 3, mode: "accumulate", intent: "nth", burst: [0, 2], dblclickP: 0.1 },
    { id: "sell", kind: "click", sel: ".holding button.sell", nth: 5, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.08 },
    { id: "remove", kind: "click", sel: ".holding button.remove", nth: 5, weight: 0.8, mode: "accumulate", dblclickP: 0.1 },
    { id: "refresh", kind: "click", sel: "button.refresh-quotes", weight: 1, mode: "replace", dblclickP: 0.12 },
  ],
  external: [
    { kind: "action", target: "quotes", verb: "up", perMin: 14 },
    { kind: "action", target: "quotes", verb: "down", perMin: 12 },
  ],
  weights: { "portfolio.polling": 0.1, "portfolio.adding": 0.1, "portfolio.error": 0, "portfolio.symbolDraft": 0.3, "portfolio.sharesDraft": 0.3, "portfolio.busy": 0.1 },
  relations: [{ name: "total value == sum(shares * price)", fields: ["portfolio.totalValue", "portfolio.holdings", "portfolio.quotes"], check: (s) => !s.portfolio || Math.abs(s.portfolio.totalValue - value(s.portfolio.holdings, s.portfolio.quotes)) < 0.01 }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
