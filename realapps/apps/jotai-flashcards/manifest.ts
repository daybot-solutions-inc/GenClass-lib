import type { AppManifest } from "../../src/shared/manifest.js";

const decks: Record<string, [string, string][]> = {
  spanish: [["la ventana", "the window"], ["el puente", "the bridge"], ["despacio", "slowly"], ["la llave", "the key"], ["madrugar", "to get up early"], ["el sobre", "the envelope"], ["quizás", "maybe"], ["la almohada", "the pillow"], ["aprovechar", "to make the most of"], ["el ayuntamiento", "the town hall"], ["la sombra", "the shade"], ["el rincón", "the corner"]],
  anatomy: [["femur", "thigh bone"], ["tibia", "shin bone"], ["scapula", "shoulder blade"], ["patella", "kneecap"], ["clavicle", "collarbone"], ["sternum", "breastbone"], ["mandible", "lower jaw"], ["phalanges", "finger and toe bones"], ["carpals", "wrist bones"], ["vertebra", "spine bone"]],
  capitals: [["Mongolia", "Ulaanbaatar"], ["Canada", "Ottawa"], ["Kenya", "Nairobi"], ["Peru", "Lima"], ["Norway", "Oslo"], ["Vietnam", "Hanoi"], ["Morocco", "Rabat"], ["Chile", "Santiago"], ["Finland", "Helsinki"], ["Ghana", "Accra"]],
};
const cards: Record<string, unknown>[] = [];
let id = 100;
for (const [deck, list] of Object.entries(decks)) list.forEach(([front, back], i) => cards.push({ id: id++, deck, front, back, box: 1 + (i % 3), due: i % 5 === 4 ? "later" : "today" }));

const manifest: AppManifest = {
  name: "jotai-flashcards",
  title: "Flashcards",
  framework: "react",
  libs: ["react", "jotai", "createStore", "useAtomValue", "fetch", "rt.guard"],
  domain: "flashcards",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "cards", seed: cards, filters: ["deck", "due"], envelope: "items", pageSize: 4, actions: { good: { inc: "box", by: 1, set: { due: "later" } }, easy: { inc: "box", by: 2, set: { due: "later" } }, again: { set: { box: 1, due: "today" } } } }],
    counters: [{ name: "reviewed", init: 7 }],
  },
  variants: {
    prefetch: ["page-1-dedupe", "next-page", "page-1-blind"],
    reveal: ["required", "optional"],
    reviewed: ["server", "local"],
    deckSeq: ["latest", "blind"],
    gradeFail: ["requeue", "drop"],
  },
  affordances: [
    { id: "deck", kind: "select", sel: "select[name=deck]", values: ["spanish", "anatomy", "capitals"], weight: 0.8, mode: "replace" },
    { id: "reveal", kind: "click", sel: "button.reveal", weight: 4, mode: "accumulate", requires: "button.reveal", then: ["grade"] },
    { id: "grade", kind: "click", sel: ".grades button", text: ["Again", "Good", "Easy"], weight: 0.8, mode: "accumulate", intent: "text", dblclickP: 0.25, requires: ".grades button" },
    { id: "skip", kind: "click", sel: "button.skip", weight: 0.4, mode: "accumulate", requires: "button.skip" },
  ],
  external: [
    { kind: "update", target: "cards", perMin: 3, where: { due: "later" }, data: [{ due: "today" }] },
    { kind: "counter", target: "reviewed", perMin: 1, by: 1 },
  ],
  weights: { "review.error": 0, "review.notice": 0, "review.loading": 0.1, "review.pending": 0.1, "review.revealed": 0.1 },
  relations: [
    { name: "no card twice in the queue", fields: ["review.queue"], check: (s) => !s.review || new Set(s.review.queue.map((c: { id: number }) => c.id)).size === s.review.queue.length },
    { name: "queue cards belong to the deck", fields: ["review.queue", "review.deck"], check: (s) => !s.review || s.review.loading || s.review.queue.every((c: { deck: string }) => c.deck === s.review.deck) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
