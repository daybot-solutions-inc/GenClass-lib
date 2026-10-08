import type { AppManifest } from "../../src/shared/manifest.js";

const found: [string, string, string][] = [
  ["Umbrella", "Black folding umbrella with wooden handle", "Central"], ["Phone", "Cracked phone in a green case", "Harbour"],
  ["Wallet", "Brown leather wallet, no cards", "Northgate"], ["Keys", "Bunch of keys on a red lanyard", "Central"],
  ["Bag", "Navy backpack with a laptop sleeve", "Airport"], ["Glasses", "Reading glasses in a black case", "Harbour"],
  ["Clothing", "Grey wool scarf", "Central"], ["Umbrella", "Large golf umbrella, striped", "Northgate"],
  ["Phone", "Phone with a cat sticker", "Airport"], ["Keys", "Car key with a supermarket tag", "Harbour"],
  ["Bag", "Black tote bag with library books", "Central"], ["Wallet", "Pink purse with a transit card", "Airport"],
  ["Clothing", "Child's yellow raincoat", "Northgate"], ["Glasses", "Sunglasses with tortoiseshell frames", "Central"],
  ["Umbrella", "Small black umbrella", "Airport"], ["Bag", "Gym bag with trainers", "Harbour"],
  ["Phone", "Black phone, no case", "Central"], ["Keys", "Bike lock key and house key", "Northgate"],
  ["Clothing", "Black leather gloves", "Harbour"], ["Wallet", "Black card holder", "Northgate"],
  ["Bag", "Camera bag", "Airport"], ["Umbrella", "Clear bubble umbrella", "Central"],
];
const items = found.map(([category, description, station], i) => ({
  id: 3100 + i,
  category,
  description,
  station,
  status: i % 7 === 3 ? "claimed" : "unclaimed",
  createdAt: `2026-03-${String(10 + Math.floor(i / 2)).padStart(2, "0")}T${String(8 + (i % 9)).padStart(2, "0")}:15:00.000Z`,
}));

const manifest: AppManifest = {
  name: "mithril-lostfound",
  title: "Lost and found desk",
  framework: "mithril",
  libs: ["mithril", "m.request(XHR)", "rt.atom"],
  domain: "lost-and-found",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "items", seed: items, versioned: true, search: ["description", "category", "station"], filters: ["status", "station"], required: ["category", "description", "station"], envelope: "data", pageSize: 6 },
      { name: "handovers", seed: [], required: ["itemId"], envelope: "data" },
    ],
  },
  variants: {
    searchSeq: ["latest", "blind"],
    cursor: ["reset-on-search", "keep"],
    claim: ["if-match", "force"],
    logGuard: ["pending", "none"],
    handoverRetry: ["idempotency-key", "blind"],
  },
  affordances: [
    { id: "search", kind: "type", sel: "input[name=q]", values: ["umbrella", "phone", "black", "wallet", "harbour", "keys", "bag"], clear: true, weight: 2, mode: "replace", key: "search" },
    { id: "clearSearch", kind: "clear", sel: "input[name=q]", weight: 0.5, mode: "replace", key: "search", after: ["search"] },
    { id: "older", kind: "click", sel: "button.older", weight: 1.5, mode: "accumulate", impatientP: 0.2, requires: "button.older:not([disabled])" },
    { id: "handover", kind: "click", sel: "li.item button.handover", nth: 6, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "li.item button.handover:not([disabled])" },
    { id: "category", kind: "select", sel: "form.log select[name=category]", values: ["Umbrella", "Phone", "Wallet", "Keys", "Bag", "Glasses", "Clothing"], weight: 1.2, mode: "accumulate", then: ["describe", "logIt"] },
    { id: "describe", kind: "type", sel: "form.log input[name=description]", values: ["Blue umbrella with a broken spoke", "Black phone in a leather case", "Red wallet with a library card", "Silver key on a ring", "Green backpack", "Glasses in a blue case", "Black winter hat"], clear: true, weight: 0, mode: "accumulate", followOnly: true },
    { id: "logIt", kind: "click", sel: "form.log button.log", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.15 },
    { id: "quickLog", kind: "click", sel: "form.log button.log", weight: 0.3, mode: "accumulate", requires: "form.log button.log:not([disabled])" },
  ],
  external: [
    {
      kind: "create",
      target: "items",
      perMin: 2,
      data: [
        { category: "Umbrella", description: "Green golf umbrella", station: "Harbour", status: "unclaimed" },
        { category: "Phone", description: "Black phone with a cracked screen", station: "Northgate", status: "unclaimed" },
        { category: "Bag", description: "Black laptop bag", station: "Airport", status: "unclaimed" },
        { category: "Keys", description: "Keys on a black carabiner", station: "Central", status: "unclaimed" },
      ],
    },
    { kind: "update", target: "items", perMin: 2, where: { status: "unclaimed" }, data: [{ status: "claimed" }] },
  ],
  weights: { "desk.error": 0, "desk.notice": 0, "desk.loading": 0.1, "desk.older": 0.1, "desk.pending": 0.1, "desk.q": 0.3, "log.saving": 0.1, "log.description": 0.3, "log.category": 0.3 },
  relations: [
    {
      name: "rows match the search",
      fields: ["desk.rows", "desk.q"],
      check: (s) => !s.desk || s.desk.loading || !s.desk.q || s.desk.rows.every((r: { category: string; description: string; station: string }) => `${r.category}|${r.description}|${r.station}`.toLowerCase().includes(String(s.desk.q).toLowerCase())),
    },
    { name: "no item listed twice", fields: ["desk.rows"], check: (s) => !s.desk || new Set(s.desk.rows.map((r: { id: number }) => r.id)).size === s.desk.rows.length },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
