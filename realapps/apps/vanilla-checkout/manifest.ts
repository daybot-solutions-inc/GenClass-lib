import type { AppManifest } from "../../src/shared/manifest.js";

const cart = [
  { id: 11, productId: "p-trail-mug", name: "Enamel trail mug", price: 14, qty: 2 },
  { id: 12, productId: "p-merino-socks", name: "Merino hiking socks", price: 19.5, qty: 1 },
  { id: 13, productId: "p-headlamp", name: "Rechargeable headlamp", price: 34, qty: 1 },
];
const products = [
  { id: "p-trail-mug", name: "Enamel trail mug", price: 14, blurb: "12 oz, campfire safe" },
  { id: "p-firestarter", name: "Ferro rod firestarter", price: 11.25, blurb: "works when wet" },
  { id: "p-dry-bag", name: "Roll-top dry bag 10L", price: 22, blurb: "seam-sealed" },
  { id: "p-spork", name: "Titanium spork", price: 8.75, blurb: "9 grams" },
  { id: "p-merino-socks", name: "Merino hiking socks", price: 19.5, blurb: "cushioned heel" },
  { id: "p-bandana", name: "Map print bandana", price: 6, blurb: "organic cotton" },
];
const rates = [
  { id: "standard", label: "Standard (3–5 days)", fee: 4.95 },
  { id: "express", label: "Express (1–2 days)", fee: 12.5 },
  { id: "pickup", label: "Store pickup", fee: 0 },
];
const sum = (xs: { price: number; qty: number }[]) => Math.round(xs.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100;

const manifest: AppManifest = {
  name: "vanilla-checkout",
  title: "Fernhill checkout",
  framework: "vanilla",
  libs: ["fetch", "AbortSignal.timeout", "rt.atom"],
  domain: "commerce",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    cart: { collection: "cart" },
    collections: [
      { name: "cart", seed: cart, actions: { inc: { inc: "qty", by: 1 }, dec: { inc: "qty", by: -1 } } },
      { name: "products", seed: products, envelope: "bare" },
      { name: "rates", seed: rates, envelope: "bare" },
      { name: "orders", seed: [], envelope: "items", pageSize: 5 },
    ],
    docs: [{ name: "profile", init: { name: "Robin Okafor", street: "418 Alder Way", city: "Portland", zip: "97214", method: "standard" } }],
  },
  variants: {
    disableSubmit: [true, false],
    idempotencyKey: [true, false],
    timeoutRetry: ["same-key", "fresh", "off", "fresh"],
    orderTimeoutMs: [8000, 2500, 4000],
    summary: ["derived", "on-click"],
    qtyWrite: ["patch", "inc"],
    cartEcho: ["settle", "latest", "arrival", "arrival"],
    prefill: ["if-untouched", "always"],
  },
  affordances: [
    { id: "inc", kind: "click", sel: "li.line button.inc", nth: 3, weight: 3, mode: "accumulate", intent: "nth", burst: [0, 2], dblclickP: 0.1 },
    { id: "dec", kind: "click", sel: "li.line button.dec", nth: 3, weight: 1.2, mode: "accumulate", intent: "nth", dblclickP: 0.08 },
    { id: "remove", kind: "click", sel: "li.line button.remove", nth: 3, weight: 0.5, mode: "accumulate", intent: "nth" },
    { id: "add", kind: "click", sel: ".rec-list button.add", nth: 6, weight: 2.4, mode: "accumulate", intent: "nth", dblclickP: 0.12 },
    { id: "name", kind: "type", sel: "input[name=name]", values: ["Robin Okafor", "Sam Lindqvist", "Ana Paula Reis"], weight: 0.6, mode: "replace", clear: true },
    { id: "street", kind: "type", sel: "input[name=street]", values: ["77 Juniper Ct", "1200 Harbor Blvd Apt 4", "9 Mill Lane"], weight: 0.8, mode: "replace", clear: true },
    { id: "zip", kind: "type", sel: "input[name=zip]", values: ["94110", "60614", "02139", "9810"], weight: 0.8, mode: "replace", clear: true },
    { id: "method", kind: "select", sel: "select[name=method]", values: ["standard", "express", "pickup"], weight: 1.2, mode: "replace" },
    { id: "place", kind: "click", sel: "button.place-order", weight: 1.5, mode: "accumulate", dblclickP: 0.25, impatientP: 0.35 },
    { id: "continue", kind: "click", sel: "button.continue-shopping", weight: 0.8, mode: "replace", after: ["place"] },
    { id: "refresh", kind: "click", sel: "button.refresh-orders", weight: 0.4, mode: "replace" },
  ],
  weights: {
    "cart.loading": 0.1,
    "cart.error": 0,
    "checkout.form": 0.3,
    "checkout.touched": 0,
    "checkout.submitting": 0.1,
    "checkout.error": 0,
    "checkout.rates": 0.2,
    "orders.loading": 0.1,
  },
  relations: [
    { name: "cart.subtotal == sum(price*qty)", fields: ["cart.subtotal", "cart.items"], check: (s) => !s.cart || s.cart.loading || s.cart.subtotal === sum(s.cart.items) },
    { name: "cart.count == sum(qty)", fields: ["cart.count", "cart.items"], check: (s) => !s.cart || s.cart.loading || s.cart.count === s.cart.items.reduce((n: number, l: { qty: number }) => n + l.qty, 0) },
    { name: "summary.subtotal == cart.subtotal", fields: ["checkout.summary", "cart.subtotal"], check: (s) => !s.cart || !s.checkout || s.cart.loading || s.checkout.summary.subtotal === s.cart.subtotal },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
