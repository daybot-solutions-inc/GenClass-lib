import type { AppManifest } from "../../src/shared/manifest.js";

const cards: [string, string, string, string, string][] = [
  ["2017 Honda Civic", "Okafor", "front brake noise", "waiting", ""],
  ["2019 Ford F-150", "Lindqvist", "check engine light", "in-progress", "Marco"],
  ["2014 Toyota Corolla", "Moreau", "oil change and rotation", "in-progress", "Priya"],
  ["2021 Subaru Outback", "Haddad", "AC blowing warm", "waiting-parts", "Dale"],
  ["2016 Mazda CX-5", "Tanaka", "rattle over bumps", "waiting", ""],
  ["2012 Volkswagen Jetta", "Santos", "timing belt due", "in-progress", "Keisha"],
  ["2018 Chevrolet Equinox", "Novak", "battery drains overnight", "waiting", ""],
  ["2020 Hyundai Elantra", "Achebe", "winter tire swap", "ready", "Marco"],
  ["2015 Nissan Rogue", "Ferreira", "squealing belt", "waiting", ""],
  ["2013 Kia Soul", "Kowalski", "brake pedal soft", "in-progress", "Dale"],
];
const jobs = cards.map(([vehicle, customer, concern, status, tech], i) => ({ id: 2400 + i, ro: `RO-${5521 + i}`, vehicle, customer, concern, status, tech }));
const catalog: [string, string, number][] = [
  ["BP-2210", "Front brake pads", 3], ["BR-1180", "Brake rotor", 2], ["OF-0042", "Oil filter", 6], ["SB-6PK", "Serpentine belt", 2], ["TB-KIT", "Timing belt kit", 1],
  ["BT-H6", "Battery H6", 4], ["CF-220", "Cabin air filter", 5], ["SL-STAB", "Stabilizer link", 3], ["RF-134", "R-134a refrigerant", 2], ["WB-22", "Wiper blades", 7],
];
const parts = catalog.map(([sku, name, stock], i) => ({ id: 3300 + i, sku, name, stock }));
const jobparts = [
  { id: 8800, jobId: 2403, partId: 3308, name: "R-134a refrigerant" },
  { id: 8801, jobId: 2405, partId: 3304, name: "Timing belt kit" },
];

const manifest: AppManifest = {
  name: "effector-autoshop",
  title: "Service advisor board",
  framework: "vanilla",
  libs: ["effector", "createEffect", "createEvent", "sample", "fetch", "rt.guard", "template-string DOM"],
  domain: "auto-repair-shop",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "jobs", seed: jobs, versioned: true, filters: ["status", "tech"], envelope: "items", pageSize: 50 },
      { name: "parts", seed: parts, envelope: "items", pageSize: 50, actions: { reserve: { inc: "stock", by: -1 }, restock: { inc: "stock", by: 4 } } },
      { name: "jobparts", seed: jobparts, required: ["jobId", "partId"], filters: ["jobId"], envelope: "items", pageSize: 100 },
    ],
  },
  variants: {
    assign: ["if-match", "force"],
    partSteps: ["rollback", "dangling"],
    lowStock: ["refetch-after-reserve", "stale"],
    boardSeq: ["latest", "blind"],
    partGuard: ["pending", "none"],
  },
  affordances: [
    { id: "show", kind: "select", sel: "select[name=show]", values: ["open", "ready", "all", "open"], weight: 1, mode: "replace", key: "show" },
    { id: "status", kind: "select", sel: "article.job select.status", nth: 6, values: ["in-progress", "waiting-parts", "ready"], intent: "nth", key: "status", weight: 2.2, mode: "replace", requires: "article.job select.status:not([disabled])" },
    { id: "tech", kind: "select", sel: "article.job select.tech", nth: 6, values: ["Marco", "Priya", "Dale", "Keisha"], intent: "nth", key: "tech", weight: 2.2, mode: "replace", requires: "article.job select.tech:not([disabled])" },
    { id: "pickPart", kind: "select", sel: "article.job select.part", nth: 6, values: ["3300", "3301", "3302", "3303", "3305", "3307"], intent: "nth", key: "part", weight: 2.5, mode: "replace", requires: "article.job select.part:not([disabled])", then: ["addPart"] },
    { id: "addPart", kind: "click", sel: "article.job button.add-part", sameNth: true, weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.2, requires: "article.job button.add-part:not([disabled])" },
  ],
  external: [
    // technicians update their jobs from the bay tablets, the other advisor assigns work, cars get dropped off,
    // parts deliveries restock what runs low and the other advisor uses parts too
    { kind: "update", target: "jobs", perMin: 3, where: { status: "in-progress" }, data: [{ status: "ready" }, { status: "waiting-parts" }] },
    { kind: "update", target: "jobs", perMin: 2, where: { status: "waiting" }, data: [{ status: "in-progress", tech: "Dale" }, { status: "in-progress", tech: "Keisha" }, { tech: "Priya" }] },
    { kind: "create", target: "jobs", perMin: 1, data: [{ ro: "RO-5540", vehicle: "2022 Tesla Model 3", customer: "Ito", concern: "tire pressure warning", status: "waiting", tech: "" }, { ro: "RO-5541", vehicle: "2011 Honda Odyssey", customer: "Mensah", concern: "sliding door stuck", status: "waiting", tech: "" }] },
    { kind: "action", target: "parts", perMin: 2, where: { stock: { $lt: 3 } }, verb: "restock" },
    { kind: "action", target: "parts", perMin: 1.5, where: { stock: { $gte: 3 } }, verb: "reserve" },
  ],
  weights: { "board.error": 0, "board.notice": 0, "board.loading": 0.1, "board.pending": 0.1, "stock.adding": 0.1, "stock.picked": 0.3 },
  relations: [
    {
      name: "status counts = job statuses",
      fields: ["board.counts", "board.jobs"],
      check: (s) => !s.board || ["waiting", "in-progress", "waiting-parts", "ready"].every((st) => (s.board.counts[st] ?? 0) === s.board.jobs.filter((j: { status: string }) => j.status === st).length),
    },
    {
      name: "low-stock panel agrees with the parts catalog",
      fields: ["stock.low", "stock.parts"],
      check: (s) => !s.stock || s.stock.low.every((l: { id: number; stock: number }) => { const p = s.stock.parts.find((x: { id: number }) => x.id === l.id); return !p || p.stock === l.stock; }),
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
