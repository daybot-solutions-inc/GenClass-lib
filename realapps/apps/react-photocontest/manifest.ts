import type { AppManifest } from "../../src/shared/manifest.js";

const titles: [string, string][] = [
  ["Fog over the harbour", "Landscape"], ["Rush hour reflections", "Street"], ["Heron at dawn", "Wildlife"], ["Glacier blue", "Landscape"], ["Market umbrellas", "Street"],
  ["Fox in the snow", "Wildlife"], ["Desert road", "Landscape"], ["Night tram", "Street"], ["Puffin pair", "Wildlife"], ["Aurora over the lake", "Landscape"],
  ["Rainy crosswalk", "Street"], ["Hummingbird", "Wildlife"], ["Salt flats", "Landscape"], ["Laundry lines", "Street"], ["Seal pup", "Wildlife"],
  ["Canyon light", "Landscape"], ["Subway musician", "Street"], ["Owl in the barn", "Wildlife"], ["Lavender rows", "Landscape"], ["Neon alley", "Street"],
];
const authors = ["mira", "theo", "kenji", "ola", "sam", "ines"];
const photos = titles.map(([title, category], i) => ({ id: 1700 + i, title, category, author: authors[i % 6], votes: 40 - ((i * 7) % 37), createdAt: `2026-03-${String(10 + i).padStart(2, "0")}T12:00:00.000Z` }));

const manifest: AppManifest = {
  name: "react-photocontest",
  title: "Photo contest",
  framework: "react",
  libs: ["react", "useGenClassState", "fetch", "WebSocket"],
  domain: "photo-contest",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "photos", seed: photos, live: true, filters: ["category"], envelope: "items", pageSize: 6, actions: { vote: { inc: "votes", by: 1 }, unvote: { inc: "votes", by: -1 } } }],
    counters: [{ name: "ballots-you", init: 10 }],
  },
  variants: {
    vote: ["optimistic-rollback", "optimistic"],
    ballots: ["recount", "manual"],
    more: ["dedupe", "blind"],
    live: ["server-value", "increment"],
    tabSeq: ["latest", "blind"],
  },
  affordances: [
    { id: "tab", kind: "click", sel: "nav.categories button", text: ["All", "Landscape", "Street", "Wildlife"], weight: 1.2, mode: "replace", key: "list" },
    { id: "sort", kind: "select", sel: "select[name=sort]", values: ["top", "new"], weight: 0.8, mode: "replace", key: "list" },
    { id: "vote", kind: "click", sel: "li.photo button.vote", nth: 6, weight: 3.5, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.15, requires: "li.photo button.vote:not([disabled])" },
    { id: "more", kind: "click", sel: "button.more", weight: 2, mode: "accumulate", dblclickP: 0.2, impatientP: 0.2, requires: "button.more:not([disabled])" },
  ],
  external: [
    { kind: "action", target: "photos", perMin: 15, verb: "vote" },
    { kind: "create", target: "photos", perMin: 1.5, data: [{ title: "First frost", category: "Landscape", author: "lena", votes: 0 }, { title: "Bike courier", category: "Street", author: "omar", votes: 0 }, { title: "Otter break", category: "Wildlife", author: "yuki", votes: 0 }] },
  ],
  weights: { "gallery.error": 0, "gallery.notice": 0, "gallery.loading": 0.1, "gallery.loadingMore": 0.1, "gallery.pending": 0.1 },
  relations: [
    { name: "no photo twice", fields: ["gallery.items"], check: (s) => !s.gallery || new Set(s.gallery.items.map((p: { id: number }) => p.id)).size === s.gallery.items.length },
    { name: "ballots left = 10 minus my votes", fields: ["gallery.ballots", "gallery.voted"], check: (s) => !s.gallery || s.gallery.ballots === 10 - s.gallery.voted.length },
    { name: "photos belong to the category", fields: ["gallery.items", "gallery.tab"], check: (s) => !s.gallery || s.gallery.loading || s.gallery.items.every((p: { category: string }) => s.gallery.tab === "All" || p.category === s.gallery.tab) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
