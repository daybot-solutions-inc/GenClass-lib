import type { AppManifest } from "../../src/shared/manifest.js";

const liftRows: [string, string, string, string, number][] = [
  ["Summit Express", "North Peak", "Six-pack", "open", 12],
  ["Glacier Gondola", "North Peak", "Gondola", "open", 18],
  ["Ridge T-bar", "North Peak", "T-bar", "hold", 0],
  ["Cornice Quad", "North Peak", "Express quad", "open", 6],
  ["Plaza Gondola", "Village", "Gondola", "open", 9],
  ["Meadow Carpet", "Village", "Magic carpet", "open", 1],
  ["Sunrise Chair", "Village", "Triple chair", "open", 4],
  ["Backbowl Quad", "Backside", "Express quad", "closed", 0],
  ["Powder Chair", "Backside", "Double chair", "open", 7],
  ["Hidden Valley T-bar", "Backside", "T-bar", "open", 3],
];
const lifts = liftRows.map(([name, area, kind, status, wait], i) => ({ id: 700 + i, name, area, kind, status, wait }));
const runRows: [string, string, string, string, boolean][] = [
  ["Upper Cornice", "North Peak", "black", "open", false], ["Glacier Bowl", "North Peak", "black", "closed", false], ["Skyline", "North Peak", "blue", "open", true],
  ["Bunny Hill", "Village", "green", "open", true], ["Easy Street", "Village", "green", "open", true], ["Plaza Run", "Village", "blue", "open", false],
  ["Powder Trees", "Backside", "black", "open", false], ["Valley Cruiser", "Backside", "blue", "open", true], ["Backbowl Chutes", "Backside", "black", "closed", false],
];
const runs = runRows.map(([name, area, level, status, groomed], i) => ({ id: 800 + i, name, area, level, status, groomed }));
const slotRows: [number, string, string, string, number][] = [
  [700, "Summit Express", "Early bird", "09:30", 2], [700, "Summit Express", "Mid-morning", "10:30", 4], [700, "Summit Express", "Lunch", "12:30", 3],
  [701, "Glacier Gondola", "Early bird", "09:30", 1], [701, "Glacier Gondola", "Afternoon", "14:00", 3],
  [704, "Plaza Gondola", "Mid-morning", "10:30", 2], [704, "Plaza Gondola", "Afternoon", "14:00", 4], [703, "Cornice Quad", "Lunch", "12:30", 2],
];
const slots = slotRows.map(([liftId, lift, wave, time, left], i) => ({ id: 900 + i, liftId, lift, wave, time, left }));

const manifest: AppManifest = {
  name: "preact-skilifts",
  title: "Lift status",
  framework: "preact",
  libs: ["preact", "@preact/signals (signal/computed, not registered)", "fetch", "AbortController", "WebSocket"],
  domain: "ski-resort-lift-status",
  entry: "main.tsx",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "lifts", seed: lifts, versioned: true, live: true, filters: ["area", "status"], envelope: "items", pageSize: 20 },
      { name: "runs", seed: runs, versioned: true, live: true, filters: ["area", "status"], envelope: "items", pageSize: 30 },
      { name: "favourites", seed: [], unique: ["key"], required: ["liftId", "member"], filters: ["member"], envelope: "items", pageSize: 20 },
      { name: "slots", seed: slots, filters: ["liftId"], envelope: "items", pageSize: 8, actions: { book: { inc: "left", by: -1 }, give: { inc: "left", by: 1 } } },
      { name: "passes", seed: [], required: ["slotId", "member"], filters: ["member"], envelope: "items", pageSize: 20 },
    ],
  },
  variants: {
    live: ["newer-wins", "blind"],
    reconnect: ["resync", "naive"],
    favGuard: ["pending", "none"],
    filterSeq: ["abort", "none"],
    passKey: ["idempotency-key", "none"],
  },
  affordances: [
    { id: "area", kind: "click", sel: "nav.areas button", text: ["All", "North Peak", "Village", "Backside"], weight: 1.4, mode: "replace", key: "area" },
    { id: "short", kind: "check", sel: "input[name=short]", weight: 0.8, mode: "replace", key: "short" },
    { id: "fav", kind: "click", sel: "li.lift button.fav", nth: 6, weight: 2.2, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.2, requires: "li.lift button.fav:not([disabled])" },
    { id: "book", kind: "click", sel: "li.slot button.book", nth: 4, weight: 2, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.3, requires: "li.slot button.book:not([disabled])" },
    { id: "remove", kind: "click", sel: "li.fav button.remove", nth: 3, weight: 0.8, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.fav button.remove:not([disabled])" },
  ],
  external: [
    { kind: "update", target: "lifts", perMin: 20, data: [{ wait: 2 }, { wait: 5 }, { wait: 8 }, { wait: 12 }, { wait: 17 }, { wait: 24 }, { status: "hold" }, { status: "open" }, { status: "open" }] },
    { kind: "update", target: "lifts", perMin: 0.6, where: { status: "open" }, data: [{ status: "closed", wait: 0 }] },
    { kind: "update", target: "lifts", perMin: 1.2, where: { status: "closed" }, data: [{ status: "open", wait: 5 }] },
    { kind: "update", target: "runs", perMin: 3, data: [{ status: "closed" }, { status: "open" }, { groomed: true }, { groomed: false }] },
    { kind: "action", target: "slots", perMin: 3, verb: "book", where: { left: { $gt: 0 } } },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
