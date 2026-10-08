import type { AppManifest } from "../../src/shared/manifest.js";

const dishes: [string, number, string][] = [
  ["Grilled pork banh mi", 9.5, "sandwich"],
  ["Lemongrass tofu banh mi", 9, "vegan"],
  ["Chicken pho", 13.5, "soup"],
  ["Beef brisket pho", 14, "soup"],
  ["Crispy spring rolls", 6.5, "starter"],
  ["Shrimp summer rolls", 7, "starter"],
  ["Vermicelli bowl with chicken", 12.5, "bowl"],
  ["Lemongrass tofu bowl", 12, "vegan"],
  ["Broken rice with pork chop", 13, "rice"],
  ["Vietnamese iced coffee", 4.5, "drink"],
];
const menu = dishes.map(([name, price, tag], i) => ({ id: 600 + i, name, price, tag }));
const seeded: [string, number, number][] = [
  ["Marco", 3, 1],
  ["Aisha", 7, 1],
  ["Jonas", 0, 2],
  ["Wen", 5, 1],
  ["Priya", 9, 1],
  ["Lena", 2, 1],
];
const lines = seeded.map(([person, d, qty], i) => ({ id: 700 + i, person, item: dishes[d]![0], price: dishes[d]![1], qty }));
const line = (person: string, d: number) => ({ person, item: dishes[d]![0], price: dishes[d]![1], qty: 1 });

const manifest: AppManifest = {
  name: "jotai-lunchorder",
  title: "Team lunch order",
  framework: "react",
  libs: ["react", "jotai", "createStore", "useAtomValue", "fetch", "WebSocket", "rt.guard"],
  domain: "team-lunch-order",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "menu", seed: menu, envelope: "bare", pageSize: 50 },
      { name: "lines", seed: lines, live: true, required: ["person", "item"], envelope: "items", pageSize: 100, actions: { inc: { inc: "qty", by: 1 }, dec: { inc: "qty", by: -1 } } },
    ],
    docs: [{ name: "order", init: { restaurant: "Saigon Corner", cutoff: "11:30", status: "open", organiser: "Priya", note: "" }, versioned: true, live: true }],
  },
  variants: {
    qty: ["relative", "absolute-put"],
    add: ["reconcile", "append"],
    total: ["derive", "incremental"],
    lock: ["if-match", "force"],
    reconnect: ["resync", "naive"],
  },
  affordances: [
    { id: "add", kind: "click", sel: "li.menu-item button.add", nth: 10, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.15, requires: "li.menu-item button.add:not([disabled])" },
    { id: "inc", kind: "click", sel: "tr.line button.inc", nth: 8, weight: 2.5, mode: "accumulate", intent: "nth", burst: [0, 1], requires: "tr.line button.inc:not([disabled])" },
    { id: "dec", kind: "click", sel: "tr.line button.dec", nth: 8, weight: 1.2, mode: "accumulate", intent: "nth", requires: "tr.line button.dec:not([disabled])" },
    { id: "remove", kind: "click", sel: "tr.line button.remove", nth: 8, weight: 0.5, mode: "accumulate", intent: "nth", requires: "tr.line button.remove:not([disabled])" },
    { id: "lock", kind: "click", sel: "button.lock", weight: 0.4, mode: "replace", dblclickP: 0.1, requires: "button.lock:not([disabled])", requiresText: "Lock order", then: ["reopen"] },
    { id: "reopen", kind: "click", sel: "button.lock", weight: 0, mode: "replace", key: "lock", followOnly: true, requires: "button.lock:not([disabled])", requiresText: "Reopen order" },
  ],
  external: [
    { kind: "create", target: "lines", perMin: 2.5, data: [line("Marco", 4), line("Omar", 8), line("Aisha", 9), line("Wen", 6), line("Lena", 1), line("Dev", 2)] },
    { kind: "action", target: "lines", verb: "inc", perMin: 2 },
    { kind: "action", target: "lines", verb: "dec", perMin: 0.8, where: { qty: { $gt: 1 } } },
    { kind: "delete", target: "lines", perMin: 0.4, where: { person: { $ne: "Priya" } } },
    { kind: "doc", target: "order", perMin: 0.5, data: [{ cutoff: "11:45" }, { note: "Extra chili on the side please" }, { cutoff: "12:00" }, { note: "" }] },
  ],
  weights: { "lunch.error": 0, "lunch.notice": 0, "lunch.adding": 0.1, "lunch.locking": 0.1, "lunch.live": 0.1 },
  relations: [
    { name: "total = sum of line prices", fields: ["lunch.total", "lunch.lines"], check: (s) => !s.lunch || Math.abs(s.lunch.total - s.lunch.lines.reduce((a: number, l: { qty: number; price: number }) => a + l.qty * l.price, 0)) < 0.005 },
    { name: "item count = sum of quantities", fields: ["lunch.count", "lunch.lines"], check: (s) => !s.lunch || s.lunch.count === s.lunch.lines.reduce((a: number, l: { qty: number }) => a + l.qty, 0) },
    { name: "no line twice", fields: ["lunch.lines"], check: (s) => !s.lunch || new Set(s.lunch.lines.map((l: { id: number }) => l.id)).size === s.lunch.lines.length },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
