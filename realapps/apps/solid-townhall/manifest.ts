import type { AppManifest } from "../../src/shared/manifest.js";

const asked: [string, string, number][] = [
  ["Will the Q3 roadmap include offline mode?", "priya", 14], ["How are we thinking about hiring next year?", "marc", 11], ["Any update on the office move?", "jo", 9],
  ["Can we get a clearer on-call rotation policy?", "sam", 7], ["What's the plan for the legacy billing system?", "lin", 5], ["Will there be a hackathon this fall?", "dev", 3],
];
const questions = asked.map(([text, author, votes], i) => ({ id: 120 + i, text, author, votes, answered: i === 2, createdAt: `2026-03-31T1${i}:00:00.000Z` }));

const manifest: AppManifest = {
  name: "solid-townhall",
  title: "Town hall Q&A",
  framework: "solid",
  libs: ["solid-js", "solid-js/html", "createMemo", "fetch", "WebSocket", "rt.atom", "atomSignal"],
  domain: "town-hall-qa",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "questions", seed: questions, versioned: true, live: true, required: ["text"], filters: ["answered"], envelope: "items", pageSize: 60, actions: { upvote: { inc: "votes", by: 1 } } }],
  },
  variants: {
    ask: ["reconcile", "append"],
    vote: ["optimistic-rollback", "optimistic"],
    voteGuard: ["once", "none"],
    live: ["version-check", "blind"],
    reconnect: ["resync", "naive"],
  },
  affordances: [
    { id: "draft", kind: "type", sel: "form.ask textarea[name=question]", values: ["Is remote work policy changing?", "When do we get the new laptops?", "How do promotions work this cycle?", "Can we open-source the design system?"], clear: true, weight: 1.5, mode: "replace", then: ["ask"] },
    { id: "ask", kind: "click", sel: "form.ask button", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.2 },
    { id: "vote", kind: "click", sel: "li.question button.vote", nth: 6, weight: 3.5, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.1, requires: "li.question button.vote:not([disabled])" },
    { id: "tab", kind: "click", sel: "nav.tabs button", text: ["Top", "Newest", "Answered"], weight: 1, mode: "replace", key: "tab" },
  ],
  external: [
    { kind: "create", target: "questions", perMin: 4, data: [{ text: "Are we keeping the 4-day summer weeks?", author: "ana", votes: 0, answered: false }, { text: "What happened with the outage last Tuesday?", author: "kofi", votes: 0, answered: false }, { text: "Will we expand to the EU this year?", author: "zoe", votes: 0, answered: false }, { text: "Any plans for a learning budget?", author: "raj", votes: 0, answered: false }] },
    { kind: "action", target: "questions", perMin: 10, verb: "upvote", where: { answered: false } },
    { kind: "update", target: "questions", perMin: 2, where: { answered: false }, data: [{ answered: true }] },
  ],
  weights: { "townhall.error": 0, "townhall.notice": 0, "townhall.asking": 0.1, "townhall.pending": 0.1, "townhall.live": 0.1, "townhall.draft": 0.3, "townhall.tab": 0.3 },
  relations: [{ name: "no question twice", fields: ["townhall.questions"], check: (s) => !s.townhall || new Set(s.townhall.questions.map((q: { id: number | string; clientId?: string }) => q.clientId ?? q.id)).size === s.townhall.questions.length }],
  errorSelector: "[role=alert]",
  build: { jsx: "solid-html" },
  sessionMs: [25000, 60000],
};
export default manifest;
