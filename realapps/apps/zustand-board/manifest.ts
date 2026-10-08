import type { AppManifest } from "../../src/shared/manifest.js";

const cols = ["todo", "doing", "done"];
const owners = ["sam", "kim", "raj", "lou"];
const titles = ["Login page redesign", "Billing API v2", "Search filters", "Dark mode", "Export to CSV", "Audit log", "Rate limiter", "Email digests", "Onboarding tour", "Mobile nav"];
const cards = titles.map((title, i) => ({ id: 700 + i, title, column: cols[(i * 2) % 3], owner: owners[i % 4], points: 1 + ((i * 3) % 5) }));

type Card = { column: string };
const tally = (cards: Card[], c: string) => cards.filter((x) => x.column === c).length;

const manifest: AppManifest = {
  name: "zustand-board",
  title: "Sprint board",
  framework: "react",
  libs: ["react", "zustand", "fetch", "websocket"],
  domain: "project-management",
  entry: "main.tsx",
  integration: "stores",
  server: { base: "/api", collections: [{ name: "cards", seed: cards, versioned: true, live: true, envelope: "bare", pageSize: 100 }] },
  variants: {
    push: ["version-check", "blind", "ignore-pending", "blind"],
    rollback: ["restore", "keep"],
    conflict: ["adopt", "force"],
    counts: ["recount", "skip-on-push"],
  },
  affordances: [
    { id: "right", kind: "click", sel: ".card button.right", nth: 8, weight: 5, mode: "accumulate", intent: "nth", dblclickP: 0.14 },
    { id: "left", kind: "click", sel: ".card button.left", nth: 8, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.1 },
    { id: "draft", kind: "type", sel: "input[name=cardTitle]", values: ["Fix SSO redirect", "Add retry to webhooks", "Cache avatars", "Tweak empty states", "Spike: GraphQL"], weight: 1.5, mode: "replace", clear: true, then: ["add"] },
    { id: "add", kind: "click", sel: "button.add-card", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.12, impatientP: 0.15 },
    { id: "mine", kind: "check", sel: "input[name=mine]", weight: 0.5, mode: "replace" },
    { id: "reload", kind: "click", sel: "button.reload", weight: 0.4, mode: "replace" },
  ],
  external: [
    { kind: "update", target: "cards", perMin: 4, data: [{ column: "doing" }, { column: "done" }, { column: "todo" }, { title: "Renamed by Kim" }, { owner: "raj" }] },
    { kind: "create", target: "cards", perMin: 0.8, data: [{ title: "Hotfix: login loop", column: "todo", owner: "kim", points: 2 }, { title: "Bump dependencies", column: "todo", owner: "lou", points: 1 }] },
  ],
  weights: { "board.connected": 0.2, "board.loading": 0.1, "board.error": 0, "board.notice": 0, "board.pending": 0.1, "board.draft": 0.3, "board.adding": 0.1 },
  relations: [
    {
      name: "column counts == cards per column",
      fields: ["board.counts", "board.cards"],
      check: (s) => !s.board || ["todo", "doing", "done"].every((c) => s.board.counts[c] === tally(s.board.cards, c)),
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
