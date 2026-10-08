import type { AppManifest } from "../../src/shared/manifest.js";

const people: [string, string, string, string, number][] = [
  ["Amara Nwosu", "Backend engineer", "applied", "Referral", 1],
  ["Jonas Weber", "Backend engineer", "screen", "LinkedIn", 2],
  ["Lucía Fernández", "Product designer", "interview", "Careers page", 3],
  ["Kenji Watanabe", "Data analyst", "applied", "Agency", 1],
  ["Fatima Zahra", "Support lead", "offer", "Referral", 4],
  ["Oliver Brandt", "Product designer", "applied", "Careers page", 1],
  ["Chloé Martin", "Backend engineer", "interview", "LinkedIn", 2],
  ["Ravi Menon", "Data analyst", "screen", "Referral", 2],
  ["Sofia Rossi", "Support lead", "applied", "Careers page", 1],
  ["Mateus Silva", "Backend engineer", "screen", "Agency", 3],
  ["Hannah Cole", "Product designer", "hired", "Referral", 5],
  ["Tomás Ruiz", "Data analyst", "interview", "LinkedIn", 2],
  ["Ingrid Holm", "Support lead", "screen", "Careers page", 1],
  ["Yusuf Demir", "Backend engineer", "applied", "LinkedIn", 1],
];
const candidates = people.map(([name, role, stage, source, version], i) => ({ id: 3300 + i, name, role, stage, source, version }));

const manifest: AppManifest = {
  name: "solid-query-kanban",
  title: "Hiring pipeline",
  framework: "solid",
  libs: ["solid-js", "solid-js/html", "@tanstack/solid-query", "fetch", "rt.guard"],
  domain: "recruiting",
  entry: "main.ts",
  integration: "stores",
  build: { jsx: "solid-html" },
  server: {
    base: "/api",
    collections: [{ name: "candidates", seed: candidates, versioned: true, pageSize: 50, envelope: "items" }],
  },
  variants: {
    conflict: ["if-match", "none"],
    versionEcho: ["from-response", "stale"],
    poll: ["pause", "replace", "replace"],
    rollback: ["revert", "none"],
    moveLock: [true, false],
  },
  affordances: [
    { id: "next", kind: "click", sel: ".card button.next", nth: 10, intent: "nth", weight: 4, mode: "accumulate", dblclickP: 0.15, impatientP: 0.1 },
    { id: "prev", kind: "click", sel: ".card button.prev", nth: 10, intent: "nth", weight: 1.5, mode: "accumulate", dblclickP: 0.1 },
    { id: "reject", kind: "click", sel: ".card button.reject", nth: 10, intent: "nth", weight: 0.6, mode: "accumulate", dblclickP: 0.1 },
  ],
  external: [
    // other recruiters working the same pipeline
    { kind: "update", target: "candidates", perMin: 2.2, data: [{ stage: "screen" }, { stage: "interview" }, { stage: "offer" }, { stage: "interview" }] },
    { kind: "create", target: "candidates", perMin: 0.8, data: [{ name: "Noor Haddad", role: "Data analyst", stage: "applied", source: "Careers page" }, { name: "Elias Berg", role: "Backend engineer", stage: "applied", source: "LinkedIn" }] },
  ],
  weights: { "boardNotes.notice": 0.1, "boardNotes.error": 0, "pipeline.page": 0 },
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
