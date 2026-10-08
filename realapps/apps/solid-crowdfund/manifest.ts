import type { AppManifest } from "../../src/shared/manifest.js";

const rewards: [string, number, number, number, string, string][] = [
  ["Thank-you postcard", 10, 180, 200, "A letterpress postcard signed by the workshop.", "in May"],
  ["Early bird kit", 79, 3, 25, "Bare walnut panel, all parts, solder it yourself.", "in June"],
  ["Standard kit", 99, 12, 60, "Walnut panel, pre-soldered power board, printed manual.", "in July"],
  ["Assembled synth", 249, 5, 30, "Fully built and tuned, with a canvas carry case.", "in August"],
  ["Workshop day", 150, 3, 12, "Build your synth with us at the Halifax studio.", "in September"],
  ["Studio bundle", 399, 2, 10, "Two assembled synths, patch cables and a stand.", "in August"],
];
const tiers = rewards.map(([name, amount, left, limit, perks, ships], i) => ({ id: 501 + i, name, amount, left, limit, perks, ships }));

const earlier: [string, number][] = [
  ["Mara Quist", 2], ["Tobias Lind", 1], ["Aiko Mori", 0], ["Femi Adeyemi", 3], ["Clara Voss", 2], ["Diego Paz", 4],
  ["Hanna Berg", 0], ["Omar Saleh", 1], ["Lea Fournier", 2], ["Ravi Iyer", 5], ["Sven Olsen", 1], ["Yara Nasser", 3],
  ["Jun Park", 2], ["Elif Kaya", 0], ["Nils Ek", 4], ["Ana Sousa", 2], ["Tariq Aziz", 1], ["Zoe Laurent", 3], ["Ben Okoro", 2], ["Lina Haddad", 0],
];
const pledges = earlier.map(([backer, t], i) => {
  const tier = tiers[t]!;
  return { id: 7400 + i, backer, tierId: tier.id, tier: tier.name, amount: tier.amount, key: `${backer}|${tier.id}`, createdAt: new Date(Date.UTC(2026, 2, 31, 20, 0) - i * 2700000).toISOString() };
});
const others: [string, number][] = [["Ines Duarte", 2], ["Kofi Mensah", 1], ["Greta Holm", 3], ["Luca Bianchi", 0], ["Mei Chen", 2], ["Pavel Novak", 4]];
const otherPledges = others.map(([backer, t]) => {
  const tier = tiers[t]!;
  return { backer, tierId: tier.id, tier: tier.name, amount: tier.amount, key: `${backer}|${tier.id}` };
});

const manifest: AppManifest = {
  name: "solid-crowdfund",
  title: "Driftwood synth campaign",
  framework: "solid",
  libs: ["solid-js", "solid-js/html", "@tanstack/solid-query", "useInfiniteQuery(cursor)", "fetch", "WebSocket", "rt.guard", "rt.atom"],
  domain: "crowdfunding",
  entry: "main.ts",
  integration: "stores",
  build: { jsx: "solid-html" },
  server: {
    base: "/api",
    collections: [
      { name: "tiers", seed: tiers, envelope: "items", pageSize: 20, actions: { take: { inc: "left", by: -1 } } },
      { name: "pledges", seed: pledges, envelope: "items", pageSize: 5, unique: ["key"], required: ["backer", "tierId"] },
    ],
    counters: [{ name: "funded", init: 48210, live: true }],
  },
  variants: {
    pledgeKey: ["idempotency-key", "none"],
    steps: ["pledge-first", "take-first"],
    tiers: ["invalidate", "stale"],
    total: ["server", "optimistic-no-rollback"],
    pledgeGuard: ["pending", "none"],
  },
  affordances: [
    { id: "pledge", kind: "click", sel: "li.tier button.pledge", nth: 6, intent: "nth", weight: 4, mode: "accumulate", dblclickP: 0.15, impatientP: 0.2, requires: "li.tier button.pledge:not([disabled])" },
    { id: "backer", kind: "type", sel: "input[name=backer]", values: ["Sam Ortiz", "Noor Haddad", "Kit Lambert", "Robin Hale"], clear: true, weight: 0.8, mode: "replace" },
    { id: "more", kind: "click", sel: "button.more-backers", weight: 1.2, mode: "accumulate", dblclickP: 0.15, impatientP: 0.2, requires: "button.more-backers:not([disabled])" },
    { id: "available", kind: "check", sel: "input[name=available]", weight: 0.6, mode: "replace" },
  ],
  external: [
    // other backers pledging at the same time
    { kind: "create", target: "pledges", perMin: 3, data: otherPledges },
    { kind: "action", target: "tiers", perMin: 3, verb: "take", where: { left: { $gt: 0 } } },
    { kind: "counter", target: "funded", perMin: 6, by: 99 },
  ],
  weights: { "campaign.error": 0, "campaign.notice": 0, "campaign.live": 0.1, "campaign.backer": 0.3, "campaign.availableOnly": 0.3, "backers.pageParams": 0 },
  relations: [
    { name: "my total = sum of my pledges", fields: ["campaign.myTotal", "campaign.mine"], check: (s) => !s.campaign || s.campaign.myTotal === s.campaign.mine.reduce((a: number, p: { amount: number }) => a + p.amount, 0) },
    {
      name: "no backer listed twice",
      fields: ["backers.pages"],
      check: (s) => {
        const ids = (s.backers?.pages ?? []).flatMap((p: { items: { id: number }[] }) => p.items.map((x) => x.id));
        return new Set(ids).size === ids.length;
      },
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
