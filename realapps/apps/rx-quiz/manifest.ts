import type { AppManifest } from "../../src/shared/manifest.js";

const questions = [
  { qid: "q1", question: "Which planet has the shortest year?", options: ["Mercury", "Venus", "Mars", "Jupiter"], open: true },
  { qid: "q2", question: "What is 7 × 8?", options: ["54", "56", "58", "64"], open: true },
  { qid: "q3", question: "Who wrote “Frankenstein”?", options: ["Mary Shelley", "Jane Austen", "Bram Stoker", "Emily Brontë"], open: true },
  { qid: "q4", question: "Which gas do plants absorb?", options: ["Oxygen", "Nitrogen", "Carbon dioxide", "Helium"], open: true },
  { qid: "q5", question: "How many sides does a hexagon have?", options: ["5", "6", "7", "8"], open: true },
];
const students = ["you", "Amara", "Bao", "Chiara", "Dev", "Elif", "Femi"];
const scores = students.map((name, i) => ({ id: 60 + i, name, points: 20 + ((i * 17) % 50) }));

const manifest: AppManifest = {
  name: "rx-quiz",
  title: "Live quiz",
  framework: "vanilla",
  libs: ["rxjs", "rxjs/webSocket", "rxjs/ajax", "rxjs/fetch(fromFetch)", "exhaustMap/switchMap", "rt.atom"],
  domain: "live-quiz",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "answers", seed: [], unique: ["key"], required: ["qid", "choice"], filters: ["student"], envelope: "items", pageSize: 50 },
      { name: "scores", seed: scores, envelope: "items", pageSize: 10, actions: { award: { inc: "points" } } },
    ],
    docs: [{ name: "quiz", init: questions[0]!, live: true }],
    counters: [{ name: "claps", init: 12, live: true }],
  },
  variants: {
    answerMap: ["exhaustMap", "mergeMap"],
    leaderboard: ["switchMap", "mergeMap"],
    claps: ["server-value", "local-add"],
    reconnect: ["resync", "naive"],
    answerRetry: ["timeout-retry", "none"],
  },
  affordances: [
    { id: "answer", kind: "click", sel: ".options button.option", nth: 4, weight: 4, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.2, requires: ".options button.option:not([disabled])" },
    { id: "clap", kind: "click", sel: "button.clap", weight: 2, mode: "accumulate", burst: [1, 4] },
    { id: "board", kind: "click", sel: "button.refresh-board", weight: 0.8, mode: "replace", dblclickP: 0.1 },
  ],
  external: [
    { kind: "doc", target: "quiz", perMin: 3, data: questions.slice(1) },
    { kind: "doc", target: "quiz", perMin: 0.8, data: [{ open: false }] },
    { kind: "counter", target: "claps", perMin: 8, by: 1 },
    { kind: "action", target: "scores", perMin: 5, verb: "award", by: 10 },
  ],
  weights: { "quiz.error": 0, "quiz.notice": 0, "quiz.sending": 0.1, "quiz.live": 0.1 },
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
