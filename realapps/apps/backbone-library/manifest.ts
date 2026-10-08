import type { AppManifest } from "../../src/shared/manifest.js";

// title, author, genre, copies, available
const raw: [string, string, string, number, number][] = [
  ["A Gentleman in Moscow", "Amor Towles", "fiction", 3, 1],
  ["The Remains of the Day", "Kazuo Ishiguro", "fiction", 2, 2],
  ["Pachinko", "Min Jin Lee", "fiction", 3, 0],
  ["Homegoing", "Yaa Gyasi", "fiction", 2, 1],
  ["The Thursday Murder Club", "Richard Osman", "mystery", 4, 2],
  ["The Moonstone", "Wilkie Collins", "mystery", 1, 1],
  ["Magpie Murders", "Anthony Horowitz", "mystery", 2, 0],
  ["The Guns of August", "Barbara Tuchman", "history", 2, 1],
  ["SPQR", "Mary Beard", "history", 2, 2],
  ["The Warmth of Other Suns", "Isabel Wilkerson", "history", 3, 1],
  ["The Sea Around Us", "Rachel Carson", "science", 1, 1],
  ["The Gene", "Siddhartha Mukherjee", "science", 2, 0],
  ["Entangled Life", "Merlin Sheldrake", "science", 2, 2],
  ["The Secret Garden", "Frances Hodgson Burnett", "children", 3, 3],
  ["Goodnight Moon", "Margaret Wise Brown", "children", 2, 1],
  ["Where the Wild Things Are", "Maurice Sendak", "children", 2, 2],
];
const books = raw.map(([title, author, genre, copies, available], i) => ({ id: 2100 + i, title, author, genre, copies, available, holds: available === 0 ? 1 + (i % 3) : 0 }));
const loans = [
  { id: 880, bookId: 2102, title: "Pachinko", due: "2026-04-09", renewals: 0 },
  { id: 881, bookId: 2111, title: "The Gene", due: "2026-04-15", renewals: 1 },
];


const manifest: AppManifest = {
  name: "backbone-library",
  title: "Riverside Branch Library",
  framework: "backbone",
  libs: ["backbone", "underscore", "jquery", "Backbone.sync($.ajax/xhr)", "rt.guard"],
  domain: "library",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "books", seed: books, filters: ["genre"], search: ["title", "author"], envelope: "items", pageSize: 50, actions: { checkout: { inc: "available", by: -1 }, return: { inc: "available", by: 1 }, hold: { inc: "holds", by: 1 } } },
      { name: "loans", seed: loans, envelope: "items", versioned: true, required: ["bookId", "due"] },
    ],
  },
  variants: {
    fetchMode: ["abort-previous", "reset", "merge", "reset"],
    checkoutGuard: ["disable", "none"],
    save: ["wait", "optimistic-rollback", "optimistic", "optimistic"],
    loanGuard: ["pending", "none"],
    counter: ["listen", "manual"],
    pollMs: [6000, 3000],
  },
  affordances: [
    { id: "genre", kind: "select", sel: "select[name=genre]", values: ["all", "fiction", "mystery", "history", "science", "children"], weight: 2.2, mode: "replace" },
    { id: "search", kind: "type", sel: "input[name=q]", values: ["the", "an", "moon", "mur", "sea", "o", "ar"], weight: 1.2, mode: "replace", clear: true },
    { id: "clearSearch", kind: "click", sel: "button.clear-q", weight: 0.9, mode: "replace", after: ["search"] },
    { id: "checkout", kind: "click", sel: "#shelf button.checkout", nth: 6, weight: 2.6, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.25, requires: "#shelf button.checkout" },
    { id: "hold", kind: "click", sel: "#shelf button.hold", nth: 3, weight: 0.7, mode: "accumulate", intent: "nth", dblclickP: 0.12, requires: "#shelf button.hold" },
    { id: "renew", kind: "click", sel: "#loans button.renew", nth: 4, weight: 1.4, mode: "accumulate", intent: "nth", dblclickP: 0.14, requires: "#loans button.renew" },
    { id: "return", kind: "click", sel: "#loans button.return", nth: 4, weight: 1.1, mode: "accumulate", intent: "nth", dblclickP: 0.12, impatientP: 0.25, requires: "#loans button.return" },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.6, mode: "replace", impatientP: 0.2 },
  ],
  external: [
    { kind: "action", target: "books", perMin: 3, verb: "checkout" },
    { kind: "action", target: "books", perMin: 2.5, verb: "return" },
    { kind: "action", target: "books", perMin: 0.8, verb: "hold" },
  ],
  weights: {
    "catalogue.loading": 0.1,
    "catalogue.error": 0,
    "catalogue.q": 0.3,
    "desk.checkingOut": 0.1,
    "desk.returning": 0.1,
    "desk.renewing": 0.1,
    "desk.error": 0,
    "desk.notice": 0,
  },
  relations: [
    { name: "loan counter == loans listed", fields: ["desk.onLoan", "desk.loans"], check: (s) => !s.desk || s.desk.onLoan === s.desk.loans.length },
    {
      name: "shelf shows only the selected genre",
      fields: ["catalogue.books", "catalogue.genre"],
      check: (s) => !s.catalogue || s.catalogue.loading || s.catalogue.genre === "all" || s.catalogue.books.every((b: { genre: string }) => b.genre === s.catalogue.genre),
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
