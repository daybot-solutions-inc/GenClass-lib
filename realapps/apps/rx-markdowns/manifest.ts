import type { AppManifest } from "../../src/shared/manifest.js";

const items: [string, string, string, number][] = [
  ["Two-person dome tent", "OUT-1001", "Outdoor", 189.99], ["Insulated rain jacket", "OUT-1002", "Outdoor", 149.5], ["Camping headlamp", "OUT-1003", "Outdoor", 34.99],
  ["Trekking poles (pair)", "OUT-1004", "Outdoor", 79], ["Down sleeping bag", "OUT-1005", "Outdoor", 229], ["Folding camp chair", "OUT-1006", "Outdoor", 49.99],
  ["Enamel camp mug", "KIT-2001", "Kitchen", 14.5], ["Cast iron skillet", "KIT-2002", "Kitchen", 59.99], ["Pour-over coffee kettle", "KIT-2003", "Kitchen", 44],
  ["Chef's knife 8in", "KIT-2004", "Kitchen", 89.99], ["Glass storage jars", "KIT-2005", "Kitchen", 24.99], ["Linen tea towels", "KIT-2006", "Kitchen", 19.5],
  ["Waterproof hiking boot", "FTW-3001", "Footwear", 169], ["Trail running shoe", "FTW-3002", "Footwear", 139.99], ["Wool hiking socks", "FTW-3003", "Footwear", 22],
  ["Insulated winter boot", "FTW-3004", "Footwear", 199.99], ["Camp sandal", "FTW-3005", "Footwear", 64.5], ["Boot waterproofing wax", "FTW-3006", "Footwear", 12.99],
];
const products = items.map(([name, sku, dept, basePrice], i) => ({ id: 9100 + i, name, sku, dept, basePrice, markdown: i % 5 === 2 ? 20 : 0 }));

const manifest: AppManifest = {
  name: "rx-markdowns",
  title: "Markdowns",
  framework: "vanilla",
  libs: ["rxjs", "debounceTime", "switchMap/exhaustMap", "mergeMap(concurrency)", "fetch", "rt.atom", "template-string DOM"],
  domain: "retail-markdowns",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "products", seed: products, versioned: true, search: ["name", "sku"], filters: ["dept"], envelope: "items", pageSize: 12, actions: { markdown: { inc: "markdown" } } },
      { name: "labels", seed: [], required: ["sku", "price"], envelope: "items" },
    ],
  },
  variants: {
    search: ["switchMap", "mergeMap"],
    markdown: ["bulk-absolute", "delta-retry"],
    bulkResult: ["per-item", "assume-all"],
    apply: ["exhaustMap", "mergeMap"],
    printConcurrency: [2, 0],
  },
  affordances: [
    { id: "search", kind: "type", sel: "input[name=q]", values: ["boot", "camp", "jacket", "kit-20", "tent", "wool"], clear: true, weight: 1.5, mode: "replace", key: "search" },
    { id: "dept", kind: "select", sel: "select[name=dept]", values: ["all", "Outdoor", "Kitchen", "Footwear"], weight: 1, mode: "replace", key: "search" },
    { id: "pick", kind: "check", sel: "li.product input.pick", nth: 6, weight: 3, mode: "accumulate", intent: "nth" },
    { id: "pct", kind: "select", sel: "select[name=pct]", values: ["10", "20", "30", "50"], weight: 0.8, mode: "replace" },
    { id: "apply", kind: "click", sel: "button.apply", weight: 1.5, mode: "accumulate", dblclickP: 0.2, impatientP: 0.2, requires: "button.apply:not([disabled])" },
    { id: "print", kind: "click", sel: "button.print", weight: 1, mode: "accumulate", dblclickP: 0.15, requires: "button.print:not([disabled])" },
    { id: "restore", kind: "click", sel: "li.product button.restore", nth: 4, weight: 1, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.product button.restore:not([disabled])" },
  ],
  external: [
    { kind: "update", target: "products", perMin: 3, where: { dept: "Outdoor" }, data: [{ markdown: 30 }, { markdown: 0 }, { markdown: 15 }] },
    { kind: "update", target: "products", perMin: 2, where: { markdown: { $gt: 0 } }, data: [{ markdown: 0 }, { markdown: 40 }] },
  ],
  weights: { "shelf.error": 0, "shelf.notice": 0, "shelf.loading": 0.1, "shelf.applying": 0.1, "shelf.pending": 0.1, "shelf.q": 0.3, "printer.sending": 0.1 },
  relations: [
    { name: "selection is visible", fields: ["shelf.selected", "shelf.rows"], check: (s) => !s.shelf || s.shelf.loading || s.shelf.selected.every((id: number) => s.shelf.rows.some((r: { id: number }) => r.id === id)) },
    { name: "results match the department", fields: ["shelf.rows", "shelf.dept"], check: (s) => !s.shelf || s.shelf.loading || s.shelf.dept === "all" || s.shelf.rows.every((r: { dept: string }) => r.dept === s.shelf.dept) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
