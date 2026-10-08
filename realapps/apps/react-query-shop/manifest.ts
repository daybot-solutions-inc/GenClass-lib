import type { AppManifest } from "../../src/shared/manifest.js";

const adjectives = ["oak", "linen", "copper", "stone", "walnut", "glass", "wool", "cedar"];
const nouns = ["lamp", "desk", "mug", "chair", "rug", "shelf", "vase", "stool", "kettle", "bench"];
const categories = ["home", "office", "kitchen", "garden"];
const products: Record<string, unknown>[] = [];
for (let i = 0; i < 40; i++) {
  products.push({ id: 900 + i, name: `${adjectives[(i * 3) % adjectives.length]} ${nouns[i % nouns.length]}`, category: categories[(i + Math.floor(i / 10)) % 4], price: 12 + ((i * 29) % 140), stock: (i * 5) % 9 });
}

type Line = { qty: number; price: number };
const sum = (xs: Line[], f: (l: Line) => number) => xs.reduce((a, l) => a + f(l), 0);

const manifest: AppManifest = {
  name: "react-query-shop",
  title: "Homeware shop",
  framework: "react",
  libs: ["react", "@tanstack/react-query", "zustand", "fetch", "useGenClassState"],
  domain: "commerce",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "products", seed: products, search: ["name"], filters: ["category"], pageSize: 12, envelope: "items" },
      { name: "cart", seed: [], envelope: "items", pageSize: 50 },
      { name: "orders", seed: [], envelope: "items" },
    ],
    cart: { collection: "cart" },
  },
  variants: {
    rollback: ["refetch", "snapshot", "none"],
    echo: ["latest", "always"],
    submitGuard: ["disable", "none"],
    checkout: ["key+retry", "plain", "retry-no-key"],
  },
  affordances: [
    { id: "search", kind: "type", sel: "input[name=q]", values: ["lamp", "desk", "oak", "mug", "chair", "copper", "rug", "wool"], weight: 2.5, mode: "replace", clear: true },
    { id: "category", kind: "select", sel: "select[name=category]", values: ["all", "home", "office", "kitchen", "garden"], weight: 2, mode: "replace" },
    { id: "view", kind: "click", sel: ".product button.view", nth: 6, weight: 2, mode: "replace" },
    { id: "add", kind: "click", sel: ".product button.add", nth: 6, weight: 4, mode: "accumulate", intent: "nth", dblclickP: 0.15 },
    { id: "addDetail", kind: "click", sel: "aside.detail button.add", weight: 1.5, mode: "accumulate", after: ["view"], dblclickP: 0.12 },
    { id: "remove", kind: "click", sel: ".cart-line button.remove", nth: 3, weight: 1, mode: "accumulate", after: ["add", "addDetail"], dblclickP: 0.08 },
    { id: "checkout", kind: "click", sel: "button.checkout", weight: 1, mode: "accumulate", after: ["add", "addDetail"], dblclickP: 0.15, impatientP: 0.3 },
  ],
  weights: { "cart.status": 0.1, "cart.error": 0, "cart.checkoutKey": 0, "shop.q": 0.3 },
  relations: [
    { name: "cart count == sum(qty)", fields: ["cart.count", "cart.items"], check: (s) => !s.cart || s.cart.count === sum(s.cart.items, (l) => l.qty) },
    { name: "cart total == sum(price*qty)", fields: ["cart.total", "cart.items"], check: (s) => !s.cart || Math.abs(s.cart.total - sum(s.cart.items, (l) => l.price * l.qty)) < 0.01 },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
