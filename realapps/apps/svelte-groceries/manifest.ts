import type { AppManifest } from "../../src/shared/manifest.js";

const items = [
  { id: 501, name: "Oat milk", qty: 2, checked: false, aisle: "dairy", addedBy: "sam" },
  { id: 502, name: "Bananas", qty: 6, checked: false, aisle: "produce", addedBy: "you" },
  { id: 503, name: "Sourdough loaf", qty: 1, checked: true, aisle: "bakery", addedBy: "alex" },
  { id: 504, name: "Coffee beans", qty: 1, checked: false, aisle: "pantry", addedBy: "you" },
  { id: 505, name: "Spinach", qty: 1, checked: false, aisle: "produce", addedBy: "sam" },
  { id: 506, name: "Greek yogurt", qty: 3, checked: false, aisle: "dairy", addedBy: "alex" },
];

const manifest: AppManifest = {
  name: "svelte-groceries",
  title: "Shared groceries",
  framework: "svelte",
  libs: ["svelte@5", "runes", "fetch", "WebSocket", "rt.atom", "atomStore"],
  domain: "shared-shopping-list",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "items", seed: items, versioned: true, live: true, required: ["name"], filters: ["checked"], envelope: "items", pageSize: 60, actions: { toggle: { toggle: "checked" }, more: { inc: "qty", by: 1 }, less: { inc: "qty", by: -1 } } },
    ],
  },
  variants: {
    toggle: ["patch-absolute", "toggle-action"],
    add: ["reconcile", "append"],
    clear: ["per-item", "assume-all"],
    live: ["version-check", "blind"],
    left: ["derive", "incremental"],
  },
  affordances: [
    { id: "check", kind: "click", sel: "li.item input.done", nth: 8, weight: 3.5, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.1 },
    { id: "more", kind: "click", sel: "li.item button.more", nth: 8, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.1, burst: [0, 2] },
    { id: "draft", kind: "type", sel: "form.add input[name=item]", values: ["Eggs", "Tomatoes", "Olive oil", "Rice", "Dish soap", "Apples"], clear: true, weight: 1.6, mode: "replace", then: ["add"] },
    { id: "add", kind: "click", sel: "form.add button", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.2 },
    { id: "clear", kind: "click", sel: "button.clear-checked", weight: 0.8, mode: "accumulate", dblclickP: 0.1, impatientP: 0.2, requires: "button.clear-checked:not([disabled])" },
  ],
  external: [
    { kind: "create", target: "items", perMin: 2.5, data: [{ name: "Toilet paper", qty: 1, checked: false, aisle: "household", addedBy: "sam" }, { name: "Lemons", qty: 4, checked: false, aisle: "produce", addedBy: "alex" }, { name: "Pasta", qty: 2, checked: false, aisle: "pantry", addedBy: "sam" }, { name: "Butter", qty: 1, checked: false, aisle: "dairy", addedBy: "alex" }] },
    { kind: "update", target: "items", perMin: 3, where: { checked: false }, data: [{ checked: true }] },
    { kind: "action", target: "items", perMin: 1.5, verb: "more" },
  ],
  weights: { "groceries.error": 0, "groceries.notice": 0, "groceries.pending": 0.1, "groceries.adding": 0.1, "groceries.live": 0.1, "groceries.draft": 0.3 },
  relations: [
    { name: "no item twice", fields: ["groceries.items"], check: (s) => !s.groceries || new Set(s.groceries.items.map((i: { id: number | string; clientId?: string }) => i.clientId ?? i.id)).size === s.groceries.items.length },
    { name: "left-to-buy count = unchecked items", fields: ["groceries.left", "groceries.items"], check: (s) => !s.groceries || s.groceries.left === s.groceries.items.filter((i: { checked: boolean }) => !i.checked).length },
  ],
  errorSelector: "[role=alert]",
  build: { svelte: true },
  sessionMs: [25000, 60000],
};
export default manifest;
