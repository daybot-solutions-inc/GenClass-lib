import type { AppManifest } from "../../src/shared/manifest.js";

const toolRows: [string, string, string, string][] = [
  ["Laser cutter", "Fab lab", "laser", ""],
  ["Vinyl cutter", "Fab lab", "laser", ""],
  ["Prusa printer", "Fab lab", "3d-printer", "Marco"],
  ["CNC router", "Wood shop", "cnc", ""],
  ["Table saw", "Wood shop", "woodshop", "Dana"],
  ["Bandsaw", "Wood shop", "woodshop", ""],
  ["Sewing machine", "Textiles", "sewing", ""],
  ["Serger", "Textiles", "sewing", "Priya"],
  ["Embroidery machine", "Textiles", "sewing", ""],
  ["Soldering station", "Electronics", "soldering", ""],
  ["Oscilloscope", "Electronics", "soldering", ""],
  ["MIG welder", "Metal shop", "welding", ""],
];
const tools = toolRows.map(([name, area, cert, holder], i) => ({ id: 600 + i, name, area, cert, status: holder ? "out" : "available", holder, uses: 10 + ((i * 7) % 13) }));
const certs = ["laser", "3d-printer", "woodshop", "sewing", "soldering"].map((cert, i) => ({ id: 80 + i, member: "you", cert })).concat([{ id: 90, member: "dana", cert: "cnc" }]);

const manifest: AppManifest = {
  name: "alpine-makerspace",
  title: "Makerspace tools",
  framework: "alpine",
  libs: ["alpinejs", "x-data component", "fetch", "setTimeout chain / setInterval polling"],
  domain: "makerspace-tool-checkout",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "tools", seed: tools, filters: ["area", "status"], envelope: "data", pageSize: 30, actions: { out: { inc: "uses", by: 1, set: { status: "out", holder: "you" } }, in: { set: { status: "available", holder: "" } } } },
      { name: "certs", seed: certs, filters: ["member"], envelope: "data", pageSize: 20 },
      { name: "checkouts", seed: [], unique: ["key"], required: ["toolId", "member"], filters: ["member"], envelope: "data", pageSize: 20 },
      { name: "waitlist", seed: [], unique: ["key"], required: ["toolId", "member"], filters: ["member", "toolId"], envelope: "data", pageSize: 20 },
    ],
  },
  variants: {
    checkoutGuard: ["pending", "none"],
    steps: ["rollback", "dangling"],
    waitlistGuard: ["pending", "none"],
    poll: ["chain", "interval"],
    returnMode: ["pessimistic", "optimistic-no-rollback"],
  },
  affordances: [
    { id: "checkout", kind: "click", sel: "li.tool button.checkout", nth: 6, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.25, requires: "li.tool button.checkout:not([disabled])" },
    { id: "return", kind: "click", sel: "li.mine button.return", nth: 3, weight: 1.6, mode: "accumulate", intent: "nth", dblclickP: 0.15, requires: "li.mine button.return:not([disabled])" },
    { id: "waitlist", kind: "click", sel: "li.tool button.waitlist", nth: 3, weight: 1.2, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.2, requires: "li.tool button.waitlist:not([disabled])" },
    { id: "area", kind: "select", sel: "select[name=area]", values: ["all", "Fab lab", "Wood shop", "Textiles", "Electronics"], weight: 0.8, mode: "replace" },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.6, mode: "replace", impatientP: 0.2 },
  ],
  external: [
    { kind: "update", target: "tools", perMin: 4, where: { status: "available" }, data: [{ status: "out", holder: "Dana" }, { status: "out", holder: "Priya" }, { status: "out", holder: "Marco" }, { status: "out", holder: "Sam" }] },
    { kind: "update", target: "tools", perMin: 4, where: { status: "out", holder: { $ne: "you" } }, data: [{ status: "available", holder: "" }] },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
