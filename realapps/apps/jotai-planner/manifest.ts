import type { AppManifest } from "../../src/shared/manifest.js";

const acts: [string, string, string, number, number][] = [
  ["Tram 28 heritage ride", "Lisbon", "tour", 12, 6],
  ["Alfama food walk", "Lisbon", "food", 65, 3],
  ["Gulbenkian museum entry", "Lisbon", "museum", 18, 9],
  ["Sunset boat on the Tagus", "Lisbon", "outdoor", 45, 2],
  ["Fado dinner show", "Lisbon", "food", 80, 0],
  ["Sintra palaces day trip", "Sintra", "tour", 95, 4],
  ["Pena park hike", "Sintra", "outdoor", 25, 7],
  ["Tile painting workshop", "Lisbon", "museum", 40, 1],
  ["Time Out market tasting", "Lisbon", "food", 35, 5],
  ["Belem tower and monastery", "Lisbon", "museum", 22, 8],
  ["Cascais coastal bike ride", "Cascais", "outdoor", 38, 3],
  ["Castle of Sao Jorge", "Lisbon", "tour", 15, 0],
  ["Port wine cellar visit", "Lisbon", "food", 30, 6],
  ["Arrabida kayak trip", "Setubal", "outdoor", 70, 2],
  ["Street art tuk-tuk tour", "Lisbon", "tour", 55, 4],
  ["Oceanarium visit", "Lisbon", "museum", 25, 10],
];
const activities = acts.map(([title, city, kind, price, spots], i) => ({ id: 300 + i, title, city, kind, price, spots }));
const bookings = [
  { id: 9001, activityId: 300, day: 1, title: "Tram 28 heritage ride", price: 12 },
  { id: 9002, activityId: 305, day: 2, title: "Sintra palaces day trip", price: 95 },
  { id: 9003, activityId: 302, day: 3, title: "Gulbenkian museum entry", price: 18 },
];

type B = { price: number };

const manifest: AppManifest = {
  name: "jotai-planner",
  title: "Trip planner",
  framework: "react",
  libs: ["react", "jotai", "jotai/utils loadable", "fetch", "rt.guard"],
  domain: "travel",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "activities", seed: activities, search: ["title", "city"], filters: ["kind"], envelope: "items", pageSize: 8 },
      { name: "bookings", seed: bookings, filters: ["day"], envelope: "items", pageSize: 100 },
    ],
  },
  variants: {
    checkGuard: ["latest", "none", "none"],
    bookGuard: ["disable", "none"],
    spent: ["recompute", "incremental"],
    refresh: ["skip-while-saving", "blind", "blind"],
    searchAbort: [true, false],
  },
  affordances: [
    { id: "day", kind: "click", sel: "nav.days button", text: ["Day 1", "Day 2", "Day 3", "Day 4"], weight: 1.5, mode: "replace", key: "day" },
    { id: "search", kind: "type", sel: "input[name=q]", values: ["tram", "food", "museum", "boat", "fado", "castle", "market", "bike"], weight: 2, mode: "replace", clear: true },
    { id: "kind", kind: "select", sel: "select[name=kind]", values: ["all", "tour", "food", "museum", "outdoor"], weight: 1, mode: "replace" },
    { id: "check", kind: "click", sel: "li.result button.check", nth: 6, weight: 3.5, mode: "replace", key: "check", dblclickP: 0.08 },
    { id: "book", kind: "click", sel: "section.check button.book", weight: 3, mode: "accumulate", after: ["check"], requires: "section.check button.book", dblclickP: 0.15, impatientP: 0.2 },
    { id: "remove", kind: "click", sel: "li.booking button.remove", nth: 4, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.1 },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.4, mode: "replace" },
  ],
  external: [
    { kind: "create", target: "bookings", perMin: 1.2, data: [{ activityId: 308, day: 1, title: "Time Out market tasting", price: 35 }, { activityId: 306, day: 2, title: "Pena park hike", price: 25 }, { activityId: 315, day: 4, title: "Oceanarium visit", price: 25 }] },
    { kind: "delete", target: "bookings", perMin: 0.5 },
    { kind: "update", target: "activities", perMin: 2.5, data: [{ spots: 0 }, { spots: 1 }, { spots: 4 }] },
  ],
  weights: { "trip.saving": 0.1, "trip.syncing": 0.1, "trip.error": 0, "trip.check": 0.5 },
  relations: [{ name: "spent == sum(bookings.price)", fields: ["trip.spent", "trip.bookings"], check: (s) => !s.trip || s.trip.spent === s.trip.bookings.reduce((a: number, b: B) => a + b.price, 0) }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
