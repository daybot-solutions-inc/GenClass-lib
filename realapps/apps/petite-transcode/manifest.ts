import type { AppManifest } from "../../src/shared/manifest.js";

const jobs = [
  { id: 51, file: "trailer-v3.mov", sizeMb: 820, chunks: 4, received: 4, status: "done", progress: 100 },
  { id: 52, file: "interview-raw.mp4", sizeMb: 1430, chunks: 5, received: 5, status: "encoding", progress: 25 },
  { id: 53, file: "drone-b-roll.mov", sizeMb: 2210, chunks: 6, received: 6, status: "queued", progress: 0 },
];

const manifest: AppManifest = {
  name: "petite-transcode",
  title: "Video uploads",
  framework: "petite-vue",
  libs: ["petite-vue", "fetch", "AbortController"],
  domain: "media-transcoding",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "jobs", seed: jobs, filters: ["status"], required: ["file"], envelope: "items", pageSize: 30, actions: { chunk: { inc: "received", by: 1 }, advance: { inc: "progress", by: 25 } } },
    ],
  },
  variants: {
    chunkRetry: ["idempotency-key", "blind", "none"],
    finalize: ["after-all", "early"],
    cancel: ["abort", "ui-only"],
    poll: ["chain", "interval"],
    uploadGuard: ["pending", "none"],
  },
  affordances: [
    { id: "file", kind: "select", sel: "select[name=file]", values: ["keynote-2026.mov", "podcast-ep42.wav", "product-demo.mp4", "wedding-reel.mov"], weight: 0.8, mode: "replace" },
    { id: "upload", kind: "click", sel: "button.upload", weight: 2.5, mode: "accumulate", dblclickP: 0.2, impatientP: 0.25, requires: "button.upload:not([disabled])" },
    { id: "cancel", kind: "click", sel: "li.job button.cancel", nth: 3, weight: 1, mode: "accumulate", intent: "nth", requires: "li.job button.cancel" },
    { id: "filter", kind: "click", sel: "nav.filters button", text: ["All", "Active", "Done"], weight: 1, mode: "replace", key: "filter" },
    { id: "remove", kind: "click", sel: "li.job button.remove", nth: 3, weight: 0.6, mode: "accumulate", intent: "nth", requires: "li.job button.remove" },
  ],
  external: [
    { kind: "update", target: "jobs", perMin: 6, where: { status: "queued" }, data: [{ status: "encoding", progress: 0 }] },
    { kind: "action", target: "jobs", perMin: 14, verb: "advance", where: { status: "encoding" } },
    { kind: "update", target: "jobs", perMin: 4, where: { status: "encoding" }, data: [{ status: "done", progress: 100 }, { status: "done", progress: 100 }, { status: "failed" }] },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
