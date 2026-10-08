import type { AppManifest } from "../../src/shared/manifest.js";

const words = ["red", "blue", "green", "lamp", "chair", "desk", "mug", "plant", "rug", "sofa", "shelf", "clock"];
const products = [] as Record<string, unknown>[];
for (let i = 0; i < 48; i++) {
  const a = words[i % words.length]!;
  const b = words[(i * 5 + 3) % words.length]!;
  products.push({ id: 100 + i, name: `${a} ${b} ${i % 3 ? "classic" : "studio"}`, price: 5 + ((i * 37) % 90), category: ["home", "office", "garden"][i % 3], stock: (i * 7) % 13 });
}

const manifest: AppManifest = {
  name: "react-search",
  title: "Shop search",
  framework: "react",
  libs: ["react", "fetch", "useGenClassState"],
  domain: "commerce",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "products", seed: products, search: ["name"], filters: ["category"], pageSize: 8, envelope: "items" }],
  },
  variants: {
    guard: ["none", "abort", "reqid", "none"],
    debounce: [0, 0, 150, 300],
    minLen: [1, 2],
  },
  affordances: [
    { id: "search", kind: "type", sel: "input[name=q]", values: ["red", "blue lamp", "desk", "chair studio", "mug", "plant", "sofa", "green rug", "clock", "shelf classic"], weight: 6, mode: "replace", clear: true },
    { id: "category", kind: "select", sel: "select[name=category]", values: ["all", "home", "office", "garden"], weight: 2, mode: "replace" },
    { id: "open", kind: "click", sel: ".result button.details", nth: 4, weight: 2, mode: "replace", intent: "aff" },
    { id: "close", kind: "click", sel: "button.close", weight: 1, mode: "replace", after: ["open"] },
  ],
  weights: { "search.query": 0.4, "search.loading": 0.1, "search.error": 0, "detail.loading": 0.1, "detail.error": 0 },
  errorSelector: "[role=alert]",
  sessionMs: [20000, 60000],
};
export default manifest;
