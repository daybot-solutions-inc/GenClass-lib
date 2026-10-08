import type { AppManifest } from "../../src/shared/manifest.js";

const drinkSizes = [
  { id: "small", label: "Small", delta: 0 },
  { id: "medium", label: "Medium", delta: 0.5 },
  { id: "large", label: "Large", delta: 1 },
];
const sideSizes = [
  { id: "small", label: "Small", delta: 0 },
  { id: "medium", label: "Medium", delta: 1 },
  { id: "large", label: "Large", delta: 1.75 },
];
const burgerExtras = [
  { id: "cheese", label: "Cheddar", price: 1 },
  { id: "bacon", label: "Bacon", price: 1.5 },
  { id: "avocado", label: "Avocado", price: 2 },
];
const menu = [
  { id: 101, category: "burgers", name: "Classic Burger", price: 8.5, soldOut: false, extras: burgerExtras },
  { id: 102, category: "burgers", name: "Smoky BBQ Burger", price: 10.25, soldOut: false, extras: burgerExtras },
  { id: 103, category: "burgers", name: "Mushroom Swiss", price: 9.75, soldOut: false, extras: burgerExtras },
  { id: 104, category: "burgers", name: "Veggie Burger", price: 9, soldOut: false, extras: burgerExtras.slice(0, 1).concat(burgerExtras.slice(2)) },
  { id: 201, category: "sides", name: "Fries", price: 3.25, soldOut: false, sizes: sideSizes },
  { id: 202, category: "sides", name: "Onion Rings", price: 4, soldOut: false, sizes: sideSizes },
  { id: 203, category: "sides", name: "Side Salad", price: 4.5, soldOut: false },
  { id: 301, category: "drinks", name: "Cola", price: 2.25, soldOut: false, sizes: drinkSizes },
  { id: 302, category: "drinks", name: "Lemonade", price: 2.75, soldOut: false, sizes: drinkSizes },
  { id: 303, category: "drinks", name: "Iced Tea", price: 2.5, soldOut: false, sizes: drinkSizes },
  { id: 401, category: "desserts", name: "Brownie", price: 3.5, soldOut: false },
  { id: 402, category: "desserts", name: "Soft Serve", price: 2.95, soldOut: false, extras: [{ id: "sprinkles", label: "Sprinkles", price: 0.5 }, { id: "fudge", label: "Hot fudge", price: 0.75 }] },
];
const promos = [
  { id: 1, code: "SAVE10", percent: 10, minSpend: 15 },
  { id: 2, code: "LUNCH15", percent: 15, minSpend: 25 },
  { id: 3, code: "FREEFRIES", percent: 5, minSpend: 0 },
];
const orders = [
  { id: 880, status: "preparing", total: 18.4, createdAt: "2026-03-31T23:58:00.000Z" },
  { id: 879, status: "ready", total: 9.2, createdAt: "2026-03-31T23:55:00.000Z" },
];

const r2 = (n: number) => Math.round(n * 100) / 100;
type Line = { unit: number; qty: number };
const sub = (ls: Line[]) => r2(ls.reduce((s, l) => s + l.unit * l.qty, 0));
const disc = (subtotal: number, p: { percent: number; minSpend: number } | null) => (p && subtotal >= p.minSpend ? r2((subtotal * p.percent) / 100) : 0);

const manifest: AppManifest = {
  name: "vanilla-kiosk",
  title: "Patty Shack kiosk",
  framework: "vanilla",
  libs: ["fetch", "AbortSignal.timeout", "Idempotency-Key", "rt.atom"],
  domain: "restaurant",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "menu", seed: menu, envelope: "bare", pageSize: 50 },
      { name: "promos", seed: promos, envelope: "bare", filters: ["code"] },
      { name: "orders", seed: orders, envelope: "bare", required: ["lines"] },
    ],
  },
  variants: {
    totals: ["derived", "incremental"],
    orderRetry: ["same-key", "no-key", "off", "no-key"],
    orderTimeoutMs: [6000, 2500],
    submitGuard: [true, false],
    promoGuard: ["latest", "none"],
  },
  affordances: [
    { id: "tab", kind: "click", sel: "button.tab", text: ["Full menu", "Burgers", "Sides", "Drinks", "Desserts"], weight: 1.2, mode: "replace" },
    { id: "add", kind: "click", sel: ".menu-item.simple button.add", nth: 3, key: "add", weight: 0.8, mode: "accumulate", intent: "nth", requires: ".menu-item.simple button.add", dblclickP: 0.12 },
    { id: "addSized", kind: "click", sel: ".menu-item.sized button.add", nth: 5, key: "add", weight: 1.4, mode: "replace", intent: "nth", requires: ".menu-item.sized button.add", then: ["size", "confirmAdd"] },
    { id: "addExtras", kind: "click", sel: ".menu-item.extras button.add", nth: 5, key: "add", weight: 1.2, mode: "replace", intent: "nth", requires: ".menu-item.extras button.add", then: ["extra", "confirmAdd"] },
    { id: "size", kind: "select", sel: ".modal select[name=size]", values: ["small", "medium", "large"], weight: 0, mode: "replace", followOnly: true, requires: ".modal.open select[name=size]" },
    { id: "extra", kind: "check", sel: ".modal input.extra", nth: 3, weight: 0, mode: "accumulate", followOnly: true, requires: ".modal.open input.extra" },
    { id: "confirmAdd", kind: "click", sel: ".modal button.confirm-add", weight: 0, mode: "accumulate", followOnly: true, requires: ".modal.open", dblclickP: 0.1 },
    { id: "cancelModal", kind: "click", sel: ".modal button.cancel", weight: 0.3, mode: "replace", requires: ".modal.open" },
    { id: "inc", kind: "click", sel: ".cart-line button.inc", nth: 4, weight: 1.5, mode: "accumulate", intent: "nth", burst: [0, 2], requires: ".cart-line" },
    { id: "dec", kind: "click", sel: ".cart-line button.dec", nth: 4, weight: 0.8, mode: "accumulate", intent: "nth", requires: ".cart-line" },
    { id: "remove", kind: "click", sel: ".cart-line button.remove", nth: 4, weight: 0.4, mode: "accumulate", intent: "nth", requires: ".cart-line" },
    { id: "promo", kind: "type", sel: "input[name=promo]", values: ["SAVE10", "LUNCH15", "FREEFRIES", "SAVE20"], weight: 0.8, mode: "replace", clear: true, then: ["applyPromo"] },
    { id: "applyPromo", kind: "click", sel: "button.apply-promo", weight: 0, mode: "replace", followOnly: true, dblclickP: 0.1 },
    { id: "place", kind: "click", sel: "button.place-order", weight: 1.2, mode: "accumulate", after: ["add", "addSized", "addExtras"], dblclickP: 0.25, impatientP: 0.35 },
    { id: "newOrder", kind: "click", sel: "button.new-order", weight: 1, mode: "replace", after: ["place"], requires: ".confirmation" },
  ],
  external: [
    { kind: "update", target: "menu", perMin: 1, data: [{ soldOut: true }, { soldOut: false }, { soldOut: false }] },
    { kind: "update", target: "orders", perMin: 3, data: [{ status: "preparing" }, { status: "ready" }, { status: "collected" }] },
  ],
  weights: { "menu.loading": 0.1, "menu.error": 0, "menu.category": 0.2, "menu.notice": 0.2, "cart.checking": 0.1, "cart.promoMsg": 0.2, "order.placing": 0.1, "order.error": 0, modal: 0.3 },
  relations: [
    { name: "cart.subtotal == sum(unit*qty)", fields: ["cart.subtotal", "cart.lines"], check: (s) => !s.cart || Math.abs(s.cart.subtotal - sub(s.cart.lines)) < 0.005 },
    { name: "cart.count == sum(qty)", fields: ["cart.count", "cart.lines"], check: (s) => !s.cart || s.cart.count === s.cart.lines.reduce((n: number, l: Line) => n + l.qty, 0) },
    { name: "promo discount matches subtotal", fields: ["cart.discount", "cart.subtotal", "cart.promo"], check: (s) => !s.cart || Math.abs(s.cart.discount - disc(s.cart.subtotal, s.cart.promo)) < 0.005 },
    { name: "total == subtotal - discount + tax", fields: ["cart.total", "cart.subtotal", "cart.discount", "cart.tax"], check: (s) => !s.cart || Math.abs(s.cart.total - r2(s.cart.subtotal - s.cart.discount + s.cart.tax)) < 0.005 },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
