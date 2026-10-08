import type { AppManifest } from "../../src/shared/manifest.js";

const lines = [
  { id: 1, sku: "TEE-BLK-M", name: "Black tee (M)", price: 2400, qty: 2 },
  { id: 2, sku: "TOTE-NAT", name: "Canvas tote", price: 1800, qty: 1 },
  { id: 3, sku: "MUG-ENM", name: "Enamel mug", price: 1500, qty: 1 },
];
const rates = [
  { id: "standard", label: "Standard (5-7 days)", price: 495 },
  { id: "express", label: "Express (2 days)", price: 1295 },
  { id: "overnight", label: "Overnight", price: 2495 },
  { id: "pickup", label: "Store pickup", price: 0 },
];
const coupons = [
  { id: "SPRING10", percent: 10 },
  { id: "FREESHIP", freeShipping: true },
];

const manifest: AppManifest = {
  name: "xstate-checkout",
  title: "Checkout",
  framework: "react",
  libs: ["react", "xstate", "@xstate/react", "fromPromise", "fetch", "rt.atom"],
  domain: "commerce-payments",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "cartlines", seed: lines, envelope: "items" },
      { name: "rates", seed: rates, envelope: "items", idStyle: "slug" },
      { name: "coupons", seed: coupons, envelope: "items", idStyle: "slug" },
      { name: "payments", seed: [], envelope: "items", required: ["amount"] },
    ],
  },
  variants: {
    payGuard: ["state", "ref", "ref"],
    idemKey: ["per-order", "per-attempt", "none"],
    retry: ["machine", "none", "machine"],
    quote: ["invoke", "effect"],
    total: ["recompute", "forget-on-remove"],
  },
  affordances: [
    // the happy path is one chain (a shopper goes through the wizard); detours are separate affordances
    { id: "checkout", kind: "click", sel: "button.next-shipping", weight: 4, mode: "replace", key: "step", requires: ".step-cart button.next-shipping", then: ["pickSpeed", "toPayment", "name", "pay", "anotherOrder"] },
    { id: "pickSpeed", kind: "select", sel: "select[name=speed]", values: ["standard", "express", "overnight", "pickup"], weight: 0, mode: "replace", key: "speed", followOnly: true },
    { id: "speed", kind: "select", sel: "select[name=speed]", values: ["standard", "express", "overnight", "pickup"], weight: 1.2, mode: "replace", key: "speed", requires: ".step-shipping select[name=speed]" },
    { id: "coupon", kind: "type", sel: "input[name=coupon]", values: ["SPRING10", "FREESHIP", "WELCOME5"], weight: 1, mode: "replace", clear: true, requires: ".step-shipping input[name=coupon]", then: ["applyCoupon"] },
    { id: "applyCoupon", kind: "click", sel: "button.apply-coupon", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.1 },
    { id: "removeCoupon", kind: "click", sel: "button.remove-coupon", weight: 0.6, mode: "accumulate", requires: "button.remove-coupon" },
    { id: "toPayment", kind: "click", sel: "button.next-payment", weight: 1.5, mode: "replace", key: "step", requires: "section.step-shipping", then: ["name", "pay"] },
    { id: "name", kind: "type", sel: "input[name=cardholder]", values: ["Ana Silva", "J. Okafor", "Mei Lin", "Lars Berg"], weight: 0, mode: "replace", clear: true, followOnly: true, requires: "section.step-payment" },
    { id: "pay", kind: "click", sel: "button.pay", weight: 0, mode: "accumulate", followOnly: true, requires: "section.step-payment", dblclickP: 0.25, impatientP: 0.35 },
    { id: "tryAgain", kind: "click", sel: "section.step-failed button.pay", weight: 2, mode: "accumulate", requires: "section.step-failed button.pay", dblclickP: 0.15, impatientP: 0.2 },
    { id: "reloadCart", kind: "click", sel: "button.reload", weight: 3, mode: "replace", key: "step", requires: "section.step-cart button.reload" },
    { id: "back", kind: "click", sel: "button.back", weight: 0.5, mode: "replace", key: "step" },
    { id: "newOrder", kind: "click", sel: "button.new-order", weight: 2.5, mode: "replace", key: "step", requires: "section.step-done button.new-order" },
    { id: "anotherOrder", kind: "click", sel: "section.step-done button.new-order", weight: 0, mode: "replace", key: "step", followOnly: true, waitMs: 8000 },
  ],
  external: [{ kind: "update", target: "rates", perMin: 0.8, data: [{ price: 595 }, { price: 1395 }, { price: 495 }] }],
  weights: { "checkout.error": 0, "checkout.attempt": 0.1, "checkout.payKey": 0, "checkout.quoting": 0.1, "checkout.cardholder": 0.3, "checkout.couponDraft": 0.3, "checkout.lines": 0.5 },
  relations: [{ name: "total == subtotal + shipping - discount", fields: ["checkout.total", "checkout.subtotal", "checkout.shipping", "checkout.discount"], check: (s) => !s.checkout || s.checkout.total === s.checkout.subtotal + s.checkout.shipping - s.checkout.discount }],
  errorSelector: "[role=alert]",
  sessionMs: [30000, 75000],
};
export default manifest;
