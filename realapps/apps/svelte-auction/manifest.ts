import type { AppManifest } from "../../src/shared/manifest.js";

const items = ["Signed team jersey", "Weekend cabin stay", "Cooking class for two", "Vintage record player", "Hand-thrown vase", "Kayak rental day", "Pottery workshop", "Botanical print set"];
const lots = items.map((title, i) => ({ id: 80 + i, title, bid: 50 + i * 20, leader: i % 3 === 0 ? "kai" : i % 3 === 1 ? "noa" : "", open: i !== 7 }));

const manifest: AppManifest = {
  name: "svelte-auction",
  title: "Charity auction",
  framework: "svelte",
  libs: ["svelte", "fetch", "WebSocket", "rt.atom", "atomStore"],
  domain: "points-auction",
  entry: "main.ts",
  integration: "stores",
  server: { base: "/api", collections: [{ name: "lots", seed: lots, versioned: true, live: true, envelope: "items", pageSize: 20, actions: { raise: { inc: "bid", by: 10 } } }] },
  variants: {
    live: ["version-check", "blind"],
    bidGuard: ["pending", "none"],
    bidMode: ["if-match", "no-version"],
    reconnect: ["resync", "naive"],
    reserved: ["derive", "manual"],
  },
  affordances: [
    { id: "bid", kind: "click", sel: "li.lot button.bid", nth: 7, weight: 4, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.3, burst: [0, 1], requires: "li.lot button.bid" },
    { id: "bid50", kind: "click", sel: "li.lot button.bid-big", nth: 7, weight: 1.2, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.lot button.bid-big" },
    { id: "filter", kind: "click", sel: "nav.view button", text: ["All lots", "Leading", "Outbid"], weight: 1, mode: "replace", key: "view" },
  ],
  external: [
    { kind: "action", target: "lots", perMin: 8, verb: "raise", where: { open: true } },
    { kind: "update", target: "lots", perMin: 10, where: { leader: "you" }, data: [{ leader: "kai" }, { leader: "noa" }, { leader: "sam" }] },
  ],
  weights: { "auction.error": 0, "auction.notice": 0, "auction.pending": 0.1, "auction.live": 0.1, "auction.view": 0.3 },
  relations: [{ name: "reserved points = my leading bids", fields: ["auction.reserved", "auction.lots"], check: (s) => !s.auction || s.auction.reserved === s.auction.lots.filter((l: { leader: string }) => l.leader === "you").reduce((a: number, l: { bid: number }) => a + l.bid, 0) }],
  errorSelector: "[role=alert]",
  build: { svelte: true },
  sessionMs: [25000, 60000],
};
export default manifest;
