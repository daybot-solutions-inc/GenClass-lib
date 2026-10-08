import type { AppManifest } from "../../src/shared/manifest.js";

const names = [
  "Ashford", "Bramley", "Cedar Falls", "Dunmore", "Elmwood", "Fairhaven", "Glenrock", "Harbourside", "Ironbridge",
  "Juniper Bay", "Kingsmere", "Lakeview", "Millbrook", "Northgate", "Oakridge", "Pinecrest", "Queensport", "Riverbend",
];
const regions = ["North", "Central", "Coastal"];
const districts = names.map((name, i) => ({ id: 400 + i, name, region: regions[i % 3], reported: (i * 13) % 60, votesA: 1200 + ((i * 377) % 2400), votesB: 1100 + ((i * 523) % 2500) }));

const manifest: AppManifest = {
  name: "mithril-elections",
  title: "Election night",
  framework: "mithril",
  libs: ["mithril", "m.request(XHR)", "WebSocket"],
  domain: "election-results",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "districts", seed: districts, live: true, filters: ["region"], envelope: "items", pageSize: 6, actions: { tallyA: { inc: "votesA", by: 140 }, tallyB: { inc: "votesB", by: 130 }, report: { inc: "reported", by: 5 } } },
      { name: "follows", seed: [], unique: ["districtId"], required: ["districtId"], envelope: "bare" },
    ],
    counters: [{ name: "called", init: 2, live: true }],
  },
  variants: {
    pageSeq: ["latest", "blind"],
    detailSeq: ["latest", "blind"],
    poll: ["chain", "interval"],
    merge: ["newer-wins", "replace"],
    follow: ["wait", "optimistic"],
    reconnect: ["resync", "naive"],
  },
  affordances: [
    { id: "region", kind: "select", sel: "select[name=region]", values: ["all", ...regions], weight: 1.2, mode: "replace" },
    { id: "page", kind: "click", sel: "nav.pages button", nth: 3, weight: 2, mode: "replace", key: "page", dblclickP: 0.1 },
    { id: "open", kind: "click", sel: "tr.district button.open", nth: 6, weight: 3, mode: "replace", key: "detail" },
    { id: "follow", kind: "click", sel: "tr.district button.follow", nth: 6, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.12, impatientP: 0.15, requires: "tr.district button.follow" },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.8, mode: "replace", impatientP: 0.3 },
  ],
  external: [
    { kind: "action", target: "districts", perMin: 14, verb: "tallyA" },
    { kind: "action", target: "districts", perMin: 14, verb: "tallyB" },
    { kind: "action", target: "districts", perMin: 10, verb: "report" },
    { kind: "counter", target: "called", perMin: 1.5, by: 1 },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
