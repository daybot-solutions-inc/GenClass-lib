import type { AppManifest } from "../../src/shared/manifest.js";

const catalog: [string, number, string, string][] = [
  ["Sourdough loaf", 4.5, "loaf", "bakery"],
  ["Croissants (4)", 5.25, "pack", "bakery"],
  ["Free-range eggs", 3.89, "dozen", "dairy"],
  ["Greek yogurt", 2.79, "tub", "dairy"],
  ["Oat milk", 3.49, "carton", "dairy"],
  ["Cheddar block", 6.1, "block", "dairy"],
  ["Bananas", 0.29, "each", "produce"],
  ["Avocados", 1.5, "each", "produce"],
  ["Baby spinach", 3.2, "bag", "produce"],
  ["Cherry tomatoes", 2.99, "punnet", "produce"],
  ["Ground coffee", 8.75, "bag", "pantry"],
  ["Basmati rice", 4.15, "kg", "pantry"],
  ["Olive oil", 9.4, "bottle", "pantry"],
  ["Dish soap", 2.65, "bottle", "household"],
];
const products = catalog.map(([name, price, unit, aisle], i) => ({ id: 101 + i, name, price, unit, aisle }));
const line = (id: number, pi: number, qty: number) => ({ id, productId: products[pi]!.id, name: products[pi]!.name, price: products[pi]!.price, qty });

const manifest: AppManifest = {
  name: "pinia-cart",
  title: "Household groceries",
  framework: "vue",
  libs: ["vue", "pinia", "fetch", "rt.guard"],
  domain: "commerce",
  entry: "main.ts",
  integration: "stores",
  build: { vueCompiler: true },
  server: {
    base: "/api",
    collections: [
      { name: "products", seed: products, envelope: "bare", pageSize: 50 },
      { name: "cart", seed: [line(1, 0, 1), line(2, 2, 2), line(3, 10, 1)], envelope: "bare" },
      { name: "orders", seed: [], envelope: "bare" },
    ],
    cart: { collection: "cart" },
  },
  variants: {
    echo: ["latest", "blind", "blind"],
    totals: ["everywhere", "local-only"],
    qtySend: ["debounce", "each", "each"],
    addGuard: [true, false],
    checkout: ["disable", "none", "idem-key"],
  },
  affordances: [
    { id: "add", kind: "click", sel: ".product button.add", nth: 10, intent: "nth", weight: 3, mode: "accumulate", dblclickP: 0.15 },
    { id: "inc", kind: "click", sel: ".line button.inc", nth: 4, intent: "nth", weight: 4, mode: "accumulate", burst: [0, 3], dblclickP: 0.08 },
    { id: "dec", kind: "click", sel: ".line button.dec", nth: 4, intent: "nth", weight: 2, mode: "accumulate", burst: [0, 2] },
    { id: "remove", kind: "click", sel: ".line button.remove", nth: 4, intent: "nth", weight: 1, mode: "accumulate", dblclickP: 0.1 },
    { id: "aisle", kind: "select", sel: "select[name=aisle]", values: ["all", "bakery", "dairy", "produce", "pantry"], weight: 1, mode: "replace" },
    { id: "sync", kind: "click", sel: "button.sync", weight: 0.7, mode: "replace" },
    { id: "checkout", kind: "click", sel: "button.checkout", weight: 0.5, mode: "accumulate", dblclickP: 0.25, impatientP: 0.3, after: ["add", "inc"] },
  ],
  external: [
    // another household member adds things from their phone, or changes a quantity
    { kind: "create", target: "cart", perMin: 1, data: [{ productId: 107, name: "Bananas", price: 0.29, qty: 6 }, { productId: 105, name: "Oat milk", price: 3.49, qty: 1 }, { productId: 114, name: "Dish soap", price: 2.65, qty: 1 }] },
    { kind: "update", target: "cart", perMin: 0.6, data: [{ qty: 3 }, { qty: 2 }] },
  ],
  weights: {
    "cart.placing": 0.1,
    "cart.error": 0,
    "catalog.loading": 0.1,
    "catalog.error": 0,
    "catalog.aisle": 0.3,
  },
  relations: [
    {
      name: "subtotal == sum(items.price * items.qty)",
      fields: ["cart.subtotal", "cart.items"],
      check: (s) => !s.cart || !Array.isArray(s.cart.items) || Math.abs(s.cart.subtotal - s.cart.items.reduce((a: number, l: { price: number; qty: number }) => a + Number(l.price) * Number(l.qty), 0)) < 0.01,
    },
    {
      name: "count == sum(items.qty)",
      fields: ["cart.count", "cart.items"],
      check: (s) => !s.cart || !Array.isArray(s.cart.items) || s.cart.count === s.cart.items.reduce((a: number, l: { qty: number }) => a + Number(l.qty), 0),
    },
    {
      name: "total == subtotal + shipping",
      fields: ["cart.total", "cart.subtotal", "cart.shipping"],
      check: (s) => !s.cart || Math.abs(s.cart.total - (s.cart.subtotal + s.cart.shipping)) < 0.01,
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
