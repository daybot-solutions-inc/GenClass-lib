import type { AppManifest } from "../../src/shared/manifest.js";

const printers = [
  { id: 300, name: "Hopper", model: "Prusa MK4", status: "busy", progress: 40, file: "gear-housing.stl" },
  { id: 301, name: "Lovelace", model: "Prusa MK4", status: "idle", progress: 0, file: "" },
  { id: 302, name: "Turing", model: "Bambu X1", status: "idle", progress: 0, file: "" },
  { id: 303, name: "Curie", model: "Bambu X1", status: "busy", progress: 75, file: "drone-arm.stl" },
  { id: 304, name: "Tesla", model: "Voron 2.4", status: "error", progress: 0, file: "", note: "nozzle clog" },
  { id: 305, name: "Noether", model: "Voron 2.4", status: "idle", progress: 0, file: "" },
  { id: 306, name: "Babbage", model: "Prusa Mini", status: "idle", progress: 0, file: "" },
];
const jobRows: [string, string, number, string, string][] = [
  ["gear-housing.stl", "PETG", 300, "Robotics club", "printing"],
  ["drone-arm.stl", "PLA", 303, "Drone club", "printing"],
  ["phone-stand.stl", "PLA", 301, "Design studio", "failed"],
  ["bracket-v3.stl", "ABS", 305, "Facilities", "done"],
  ["cable-clip.stl", "PETG", 302, "Biology lab", "done"],
  ["lens-cap.stl", "PLA", 306, "Physics dept", "failed"],
  ["gear-housing.stl", "ABS", 300, "Rocketry team", "done"],
  ["phone-stand.stl", "PETG", 302, "Theatre props", "cancelled"],
  ["bracket-v3.stl", "PLA", 301, "Architecture", "done"],
  ["drone-arm.stl", "PETG", 303, "Library", "queued"],
  ["cable-clip.stl", "ABS", 305, "Art school", "failed"],
  ["lens-cap.stl", "PLA", 306, "Chem lab", "done"],
  ["bracket-v3.stl", "PETG", 302, "Alumni office", "done"],
  ["gear-housing.stl", "PLA", 301, "Makerspace", "done"],
];
const names = Object.fromEntries(printers.map((p) => [p.id, p.name]));
const jobs = jobRows.map(([file, material, printerId, who, status], i) => ({
  id: 4000 + i,
  file,
  material,
  printerId,
  printer: names[printerId],
  for: who,
  status,
  attempts: 1,
  createdAt: `2026-03-${String(31 - Math.floor(i / 3)).padStart(2, "0")}T${String(17 - (i % 3) * 2).padStart(2, "0")}:00:00.000Z`,
}));

const manifest: AppManifest = {
  name: "lit-printfarm",
  title: "Print farm",
  framework: "lit",
  libs: ["lit", "LitElement(shadow DOM)", "AtomController", "lit-toast", "fetch", "WebSocket", "rt.atom"],
  domain: "3d-print-farm",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "printers", seed: printers, versioned: true, live: true, filters: ["status", "model"], envelope: "items", pageSize: 20, actions: { advance: { inc: "progress", by: 25 }, free: { set: { status: "idle", progress: 0, file: "" } } } },
      { name: "jobs", seed: jobs, versioned: true, required: ["file", "material", "printerId"], filters: ["status", "printerId"], envelope: "items", pageSize: 6, actions: { reprint: { inc: "attempts", by: 1, set: { status: "queued" } } } },
    ],
  },
  variants: {
    live: ["version-check", "blind"],
    submitGuard: ["pending", "none"],
    cancel: ["if-match", "force"],
    queueCursor: ["reset-on-filter", "keep"],
    reconnect: ["resync", "naive"],
  },
  affordances: [
    { id: "file", kind: "select", sel: "print-farm >>> select[name=file]", values: ["bracket-v3.stl", "gear-housing.stl", "phone-stand.stl", "drone-arm.stl"], weight: 0.6, mode: "replace" },
    { id: "material", kind: "select", sel: "print-farm >>> select[name=material]", values: ["PLA", "PETG", "ABS"], weight: 0.4, mode: "replace" },
    { id: "send", kind: "click", sel: "print-farm >>> li.printer.idle button.send", nth: 4, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.3, requires: "print-farm >>> li.printer.idle button.send:not([disabled])" },
    { id: "filter", kind: "click", sel: "print-farm >>> job-queue >>> nav.filters button", text: ["All", "Printing", "Failed", "Done"], weight: 1.3, mode: "replace", key: "filter" },
    { id: "older", kind: "click", sel: "print-farm >>> job-queue >>> button.older", weight: 1, mode: "accumulate", impatientP: 0.2, requires: "print-farm >>> job-queue >>> button.older:not([disabled])" },
    { id: "cancel", kind: "click", sel: "print-farm >>> job-queue >>> li.job button.cancel", nth: 3, weight: 1.2, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "print-farm >>> job-queue >>> li.job button.cancel:not([disabled])" },
    { id: "reprint", kind: "click", sel: "print-farm >>> job-queue >>> li.job button.reprint", nth: 3, weight: 1.2, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.2, requires: "print-farm >>> job-queue >>> li.job button.reprint:not([disabled])" },
  ],
  external: [
    { kind: "action", target: "printers", perMin: 14, verb: "advance", where: { status: "busy", progress: { $lt: 100 } } },
    { kind: "update", target: "printers", perMin: 7, where: { status: "busy", progress: { $gte: 75 } }, data: [{ status: "idle", progress: 0, file: "" }] },
    { kind: "update", target: "printers", perMin: 1.5, where: { status: "idle" }, data: [{ status: "busy", progress: 0, file: "cable-clip.stl" }, { status: "busy", progress: 0, file: "lens-cap.stl" }] },
    { kind: "update", target: "printers", perMin: 1.5, where: { status: "error" }, data: [{ status: "idle", note: "" }] },
    { kind: "update", target: "jobs", perMin: 3, where: { status: "printing" }, data: [{ status: "done" }, { status: "done" }, { status: "failed" }] },
    { kind: "update", target: "jobs", perMin: 2, where: { status: "queued" }, data: [{ status: "printing" }] },
  ],
  weights: { "farm.error": 0, "farm.notice": 0, "farm.cursor": 0, "farm.loadingJobs": 0.1, "farm.sending": 0.1, "farm.working": 0.1, "farm.live": 0.1, "farm.file": 0.3, "farm.material": 0.3 },
  relations: [
    { name: "idle count = idle printers", fields: ["farm.idle", "farm.printers"], check: (s) => !s.farm || s.farm.idle === s.farm.printers.filter((p: { status: string }) => p.status === "idle").length },
    { name: "listed jobs match the filter", fields: ["farm.jobs", "farm.filter"], check: (s) => !s.farm || s.farm.filter === "all" || s.farm.jobs.every((j: { status: string }) => j.status === s.farm.filter) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
