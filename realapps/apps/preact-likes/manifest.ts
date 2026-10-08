import type { AppManifest } from "../../src/shared/manifest.js";

const titles: [string, string, number][] = [
  ["The quiet cost of flaky tests", "amara", 7],
  ["Why we moved our queue to Postgres", "jonas", 11],
  ["Designing for slow networks", "li wei", 6],
  ["A field guide to idempotency keys", "sofia", 9],
  ["What our on-call rotation taught us", "dmitri", 5],
  ["CSS container queries in practice", "hana", 8],
  ["Feature flags without the mess", "omar", 6],
  ["The case for boring technology, revisited", "grace", 12],
  ["Measuring what users actually wait for", "tomas", 7],
  ["Retry storms and how to avoid them", "nia", 10],
];
const articles = titles.map(([title, author, minutes], i) => ({
  id: 400 + i,
  title,
  author,
  minutes,
  likes: 40 + ((i * 53) % 170),
  summary: `${title}: ${["notes from production", "a practical walkthrough", "lessons learned the hard way", "a short opinionated guide"][i % 4]}.`,
}));

const manifest: AppManifest = {
  name: "preact-likes",
  title: "Reading list",
  framework: "preact",
  libs: ["preact", "@preact/signals", "fetch", "rt.atom"],
  domain: "publishing",
  entry: "main.tsx",
  integration: "stores",
  build: { jsx: "preact" },
  server: {
    base: "/api",
    collections: [{ name: "articles", seed: articles, envelope: "items", pageSize: 20, actions: { like: { inc: "likes", by: 1 } } }],
  },
  variants: {
    retry: ["keyed", "none", "naive", "naive"],
    echo: ["max", "blind", "blind"],
    poll: ["chain", "interval"],
    timeoutMs: [2500, 1200, 4000],
  },
  affordances: [
    { id: "clap", kind: "click", sel: ".article button.clap", nth: 6, intent: "nth", weight: 5, mode: "accumulate", burst: [0, 5], dblclickP: 0.05 },
    { id: "preview", kind: "click", sel: ".article button.read", nth: 8, intent: "nth", weight: 1.5, mode: "replace" },
  ],
  external: [{ kind: "action", target: "articles", perMin: 14, verb: "like" }],
  weights: { "reading.loading": 0.1, "reading.error": 0, "trending.stale": 0.1, "detail.loading": 0.1 },
  errorSelector: "[role=alert]",
  sessionMs: [20000, 55000],
};
export default manifest;
