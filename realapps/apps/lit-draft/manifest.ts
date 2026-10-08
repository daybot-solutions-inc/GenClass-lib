import type { AppManifest } from "../../src/shared/manifest.js";

const names: [string, string, string][] = [
  ["J. Allen", "QB", "BUF"], ["C. McCaffrey", "RB", "SF"], ["J. Chase", "WR", "CIN"], ["T. Kelce", "TE", "KC"], ["B. Robinson", "RB", "ATL"], ["C. Lamb", "WR", "DAL"],
  ["L. Jackson", "QB", "BAL"], ["S. LaPorta", "TE", "DET"], ["J. Jefferson", "WR", "MIN"], ["J. Gibbs", "RB", "DET"], ["A. St. Brown", "WR", "DET"], ["P. Mahomes", "QB", "KC"],
  ["S. Barkley", "RB", "PHI"], ["T. Hill", "WR", "MIA"], ["M. Andrews", "TE", "BAL"], ["D. Henry", "RB", "BAL"], ["P. Nacua", "WR", "LAR"], ["J. Hurts", "QB", "PHI"],
  ["K. Walker", "RB", "SEA"], ["G. Kittle", "TE", "SF"], ["N. Collins", "WR", "HOU"], ["J. Burrow", "QB", "CIN"], ["J. Cook", "RB", "BUF"], ["D. London", "WR", "ATL"],
];
const players = names.map(([name, pos, team], i) => ({ id: 3000 + i, name, pos, team, rank: i + 1, status: i % 9 === 4 ? "drafted" : "available", by: i % 9 === 4 ? "Hail Marys" : "" }));

const manifest: AppManifest = {
  name: "lit-draft",
  title: "Draft room",
  framework: "lit",
  libs: ["lit", "LitElement(shadow DOM)", "@state", "fetch", "WebSocket"],
  domain: "fantasy-draft",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "players", seed: players, versioned: true, live: true, filters: ["pos", "status"], envelope: "items", pageSize: 8 },
      { name: "picks", seed: [], unique: ["playerId"], required: ["playerId", "team"], filters: ["team"], envelope: "items", pageSize: 30 },
    ],
  },
  variants: {
    pickGuard: ["pending", "none"],
    available: ["refetch-on-push", "stale"],
    pageSeq: ["latest", "blind"],
    steps: ["claim-first", "record-first"],
    reconnect: ["resync", "naive"],
  },
  affordances: [
    { id: "pos", kind: "click", sel: "draft-room >>> nav.pos button", text: ["All", "QB", "RB", "WR", "TE"], weight: 1.2, mode: "replace", key: "list" },
    { id: "page", kind: "click", sel: "draft-room >>> nav.pages button", nth: 3, weight: 1, mode: "replace", key: "list" },
    { id: "draft", kind: "click", sel: "draft-room >>> li.player button.draft", nth: 6, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "draft-room >>> li.player button.draft" },
    { id: "queue", kind: "click", sel: "draft-room >>> li.player button.queue", nth: 6, weight: 1, mode: "accumulate", intent: "nth", requires: "draft-room >>> li.player button.queue" },
  ],
  external: [{ kind: "update", target: "players", perMin: 6, where: { status: "available" }, data: [{ status: "drafted", by: "Gridiron Gang" }, { status: "drafted", by: "Hail Marys" }, { status: "drafted", by: "Blitz Squad" }] }],
  errorSelector: "draft-room >>> [role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
