import type { AppManifest } from "../../src/shared/manifest.js";

const shows: Record<string, string[]> = {
  "Field Notes": ["Owls at dusk", "The river delta", "Mosses up close", "Night insects"],
  "Byte Size": ["Why caches lie", "Queues everywhere", "Clocks are hard", "Retry storms"],
  "Kitchen Table": ["Sourdough rescue", "Knife skills", "Stock from scraps", "One-pan dinners"],
};
const episodes: Record<string, unknown>[] = [];
Object.entries(shows).forEach(([show, titles], s) => titles.forEach((title, i) => episodes.push({ id: 700 + s * 10 + i, show, title, minutes: 18 + ((s * 5 + i * 7) % 30) })));
const queue = [
  { id: 1, episodeId: 701, title: "The river delta", show: "Field Notes", position: 1, progress: 120 },
  { id: 2, episodeId: 712, title: "Clocks are hard", show: "Byte Size", position: 2, progress: 0 },
];

const manifest: AppManifest = {
  name: "alpine-podcast",
  title: "Podcast queue",
  framework: "alpine",
  libs: ["alpinejs", "fetch", "rt.atom"],
  domain: "podcast-player",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "episodes", seed: episodes, filters: ["show"], envelope: "data", pageSize: 20 },
      { name: "queue", seed: queue, unique: ["episodeId"], required: ["episodeId"], envelope: "data", pageSize: 30 },
    ],
  },
  variants: {
    progressSave: ["latest-only", "every-tick"],
    reorder: ["serial", "parallel"],
    addGuard: ["pending", "none"],
    showSeq: ["latest", "blind"],
  },
  affordances: [
    { id: "show", kind: "click", sel: "nav.shows button", text: ["Field Notes", "Byte Size", "Kitchen Table"], weight: 1.5, mode: "replace", key: "show" },
    { id: "enqueue", kind: "click", sel: "li.episode button.enqueue", nth: 4, weight: 2.5, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "li.episode button.enqueue" },
    { id: "play", kind: "click", sel: "li.queued button.play", nth: 3, weight: 1.5, mode: "replace", key: "player" },
    { id: "pause", kind: "click", sel: "button.pause", weight: 0.8, mode: "replace", key: "player", requires: "button.pause" },
    { id: "up", kind: "click", sel: "li.queued button.up", nth: 4, weight: 2, mode: "accumulate", intent: "nth", burst: [0, 1], requires: "li.queued button.up" },
    { id: "remove", kind: "click", sel: "li.queued button.remove", nth: 4, weight: 0.8, mode: "accumulate", intent: "nth", requires: "li.queued button.remove" },
  ],
  weights: { "player.error": 0, "player.notice": 0, "player.loading": 0.1, "player.busy": 0.1, "player.progress": 0.1 },
  relations: [{ name: "queue positions are distinct", fields: ["player.queue"], check: (s) => !s.player || new Set(s.player.queue.map((q: { position: number }) => q.position)).size === s.player.queue.length }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
