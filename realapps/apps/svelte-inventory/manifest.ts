import type { AppManifest } from "../../src/shared/manifest.js";

const rows: [string, string, number, number][] = [
  ["HX-M8-40", "Hex bolt M8x40", 140, 50],
  ["HX-M6-25", "Hex bolt M6x25", 32, 40],
  ["WS-M8", "Flat washer M8", 410, 100],
  ["WS-M6", "Flat washer M6", 85, 100],
  ["NT-M8", "Lock nut M8", 60, 50],
  ["SC-4x30", "Wood screw 4x30", 900, 200],
  ["CB-CAT6-3", "Cat6 cable 3m", 18, 20],
  ["CB-HDMI-2", "HDMI cable 2m", 9, 10],
  ["GL-NIT-L", "Nitrile gloves L", 22, 15],
  ["GL-NIT-M", "Nitrile gloves M", 14, 15],
  ["TP-DUCT", "Duct tape 50m", 7, 8],
  ["TP-MASK", "Masking tape 25mm", 30, 12],
  ["LB-A4", "Shipping labels A4", 11, 10],
  ["BX-S", "Carton box small", 75, 40],
  ["BX-L", "Carton box large", 21, 25],
  ["ZT-200", "Zip ties 200mm", 260, 100],
];
const items = rows.map(([sku, name, stock, min], i) => ({ id: 3100 + i, sku, name, stock, min, bin: `${String.fromCharCode(65 + (i % 4))}-${10 + Math.floor(i / 4)}` }));

const manifest: AppManifest = {
  name: "svelte-inventory",
  title: "Stockroom",
  framework: "svelte",
  libs: ["svelte", "axios", "svelte-store(rt.atom)"],
  domain: "inventory",
  entry: "main.ts",
  integration: "stores",
  build: { svelte: true },
  server: {
    base: "/api",
    collections: [{ name: "items", seed: items, search: ["name", "sku"], pageSize: 50, envelope: "items", actions: { adjust: { inc: "stock" } } }],
  },
  variants: {
    poll: ["skip-if-pending", "blind", "blind"],
    echo: ["pending-aware", "blind", "blind"],
    badge: ["recompute", "load-only"],
    searchGuard: ["reqid", "none", "none"],
    debounce: [250, 0, 120],
    receiveLock: [true, false],
  },
  affordances: [
    { id: "dec", kind: "click", sel: ".item button.dec", nth: 6, intent: "nth", weight: 4, mode: "accumulate", burst: [0, 4], dblclickP: 0.08 },
    { id: "inc", kind: "click", sel: ".item button.inc", nth: 6, intent: "nth", weight: 2.5, mode: "accumulate", burst: [0, 2] },
    { id: "receive", kind: "click", sel: ".item button.receive", nth: 6, intent: "nth", weight: 1, mode: "accumulate", dblclickP: 0.2, impatientP: 0.2 },
    { id: "search", kind: "type", sel: "input[name=q]", values: ["bolt", "M8", "washer", "gloves", "cable", "tape", "box", ""], weight: 2, mode: "replace", clear: true },
    { id: "show", kind: "select", sel: "select[name=show]", values: ["all", "all", "low", "ok"], weight: 0.8, mode: "replace" },
  ],
  external: [
    { kind: "action", target: "items", perMin: 6, verb: "adjust", by: -1 },
    { kind: "action", target: "items", perMin: 0.7, verb: "adjust", by: 6 },
  ],
  weights: { "inv.q": 0.3, "inv.loading": 0.1, "inv.error": 0 },
  relations: [
    {
      name: "lowCount == count(items where stock <= min)",
      fields: ["inv.lowCount", "inv.items"],
      check: (s) => !s.inv || !Array.isArray(s.inv.items) || s.inv.lowCount === s.inv.items.filter((it: { stock: number; min: number }) => it.stock <= it.min).length,
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
