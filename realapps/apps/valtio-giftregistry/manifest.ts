import type { AppManifest } from "../../src/shared/manifest.js";

const list: [string, string, number, string, number, number][] = [
  ["Muslin swaddle blankets", "nursery", 24, "Target", 3, 2],
  ["Crib fitted sheets", "nursery", 18, "IKEA", 2, 2],
  ["White noise machine", "nursery", 35, "Amazon", 1, 1],
  ["Video baby monitor", "nursery", 89, "Best Buy", 1, 1],
  ["Glass baby bottles", "feeding", 32, "Target", 2, 1],
  ["Silicone bib set", "feeding", 15, "Amazon", 3, 3],
  ["Bottle drying rack", "feeding", 22, "Target", 1, 0],
  ["Wooden high chair", "feeding", 129, "IKEA", 1, 1],
  ["Newborn onesie pack", "clothing", 20, "Carter's", 4, 3],
  ["Knitted booties", "clothing", 14, "Etsy", 2, 1],
  ["Sun hat with chin strap", "clothing", 12, "Carter's", 2, 2],
  ["Goodnight Moon board book", "books", 9, "Indigo", 2, 1],
  ["The Very Hungry Caterpillar", "books", 10, "Indigo", 2, 2],
  ["Touch and feel farm book", "books", 8, "Indigo", 1, 1],
];
const gifts = list.map(([name, category, price, shop, wanted, remaining], i) => ({ id: 800 + i, name, category, price, shop, wanted, remaining }));
// June already promised the booties; other guests' claims are not listed to her
const claims = [{ id: 900, guest: "June", giftId: 809, key: "June|809" }, { id: 901, guest: "Marta", giftId: 804, key: "Marta|804" }];

const manifest: AppManifest = {
  name: "valtio-giftregistry",
  title: "Gift registry",
  framework: "react",
  libs: ["react", "valtio", "useSnapshot", "fetch", "WebSocket", "rt.guard"],
  domain: "gift-registry",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "gifts", seed: gifts, live: true, filters: ["category"], envelope: "items", pageSize: 50, actions: { claim: { inc: "remaining", by: -1 }, unclaim: { inc: "remaining", by: 1 } } },
      { name: "claims", seed: claims, unique: ["key"], required: ["guest", "giftId", "key"], filters: ["guest", "key"], envelope: "items", pageSize: 50 },
    ],
  },
  variants: {
    claimGuard: ["pending", "none"],
    steps: ["rollback", "dangling"],
    live: ["newer-wins", "blind"],
    filter: ["refetch-on-change", "stale"],
    remainingCount: ["derive", "incremental"],
  },
  affordances: [
    { id: "category", kind: "select", sel: "select[name=category]", values: ["all", "all", "nursery", "feeding", "clothing", "books"], weight: 1, mode: "replace" },
    { id: "needed", kind: "check", sel: "input[name=needed]", weight: 0.6, mode: "replace" },
    { id: "claim", kind: "click", sel: "li.gift button.claim", nth: 6, weight: 3.5, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.25, requires: "li.gift button.claim:not([disabled])" },
    { id: "unclaim", kind: "click", sel: "li.gift button.unclaim", nth: 2, weight: 0.9, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.15, requires: "li.gift button.unclaim:not([disabled])" },
  ],
  external: [
    { kind: "action", target: "gifts", verb: "claim", perMin: 4, where: { remaining: { $gt: 0 } } },
    { kind: "action", target: "gifts", verb: "unclaim", perMin: 0.7, where: { remaining: { $lt: 1 } } },
  ],
  weights: { "registry.error": 0, "registry.notice": 0, "registry.pending": 0.1, "registry.loading": 0.1, "registry.live": 0.1 },
  relations: [
    { name: "still-needed count = sum over the list", fields: ["registry.neededCount", "registry.gifts"], check: (s) => !s.registry || s.registry.neededCount === s.registry.gifts.reduce((a: number, g: { remaining: number }) => a + g.remaining, 0) },
    { name: "still-needed view lists needed gifts only", fields: ["registry.gifts", "registry.onlyNeeded"], check: (s) => !s.registry || s.registry.loading || !s.registry.onlyNeeded || s.registry.gifts.every((g: { remaining: number }) => g.remaining > 0) },
    { name: "list matches the category", fields: ["registry.gifts", "registry.category"], check: (s) => !s.registry || s.registry.loading || s.registry.category === "all" || s.registry.gifts.every((g: { category: string }) => g.category === s.registry.category) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
