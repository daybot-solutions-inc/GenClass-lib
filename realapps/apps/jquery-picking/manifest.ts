import type { AppManifest } from "../../src/shared/manifest.js";

const skus: [string, string, string][] = [
  ["SKU-1042", "USB-C cable 2m", "A-03-2"], ["SKU-2210", "Desk lamp", "B-11-1"], ["SKU-3301", "Notebook A5", "A-07-4"], ["SKU-0915", "Water bottle", "C-02-3"],
  ["SKU-7788", "Phone stand", "B-04-2"], ["SKU-5120", "Wireless mouse", "A-01-1"], ["SKU-6402", "HDMI adapter", "C-09-2"], ["SKU-4471", "Sticky notes", "A-12-3"],
];
const lines: Record<string, unknown>[] = [];
["W1", "W2", "W3"].forEach((wave, w) => {
  for (let i = 0; i < 5; i++) {
    const [sku, name, bin] = skus[(i + w * 3) % skus.length]!;
    lines.push({ id: 9100 + w * 10 + i, wave, order: `SO-${5530 + w * 3 + (i % 3)}`, sku, name, bin, qty: 1 + ((i + w) % 3), picked: 0, short: false });
  }
});

const manifest: AppManifest = {
  name: "jquery-picking",
  title: "Pick station",
  framework: "jquery",
  libs: ["jquery", "$.ajax"],
  domain: "warehouse-picking",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "lines", seed: lines, filters: ["wave", "order"], envelope: "data", pageSize: 50, actions: { pick: { inc: "picked", by: 1 }, unpick: { inc: "picked", by: -1 }, short: { set: { short: true } } } },
      { name: "shipments", seed: [], envelope: "data", required: ["wave"] },
    ],
  },
  variants: {
    pickGuard: ["disable", "none", "none"],
    waveLoad: ["abort", "none"],
    closeCheck: ["refetch", "trust-local"],
    pollMs: [4000, 2500],
  },
  affordances: [
    { id: "wave", kind: "select", sel: "select[name=wave]", values: ["W1", "W2", "W3"], weight: 1.5, mode: "replace" },
    { id: "pick", kind: "click", sel: "tr.line button.pick", nth: 5, weight: 4, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.25, burst: [0, 2] },
    { id: "unpick", kind: "click", sel: "tr.line button.unpick", nth: 5, weight: 0.8, mode: "accumulate", intent: "nth", requires: "tr.line button.unpick" },
    { id: "short", kind: "click", sel: "tr.line button.short", nth: 5, weight: 0.6, mode: "accumulate", intent: "nth", requires: "tr.line button.short" },
    { id: "close", kind: "click", sel: "button.close-wave", weight: 1, mode: "accumulate", dblclickP: 0.15, impatientP: 0.2 },
  ],
  external: [{ kind: "action", target: "lines", perMin: 3, verb: "pick", where: { wave: "W2" } }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
