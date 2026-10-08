import type { AppManifest } from "../../src/shared/manifest.js";

const st = ["dirty", "dirty", "clean", "cleaning", "dirty", "inspected", "dirty", "clean", "dirty", "cleaning", "dirty", "inspected"];
const rooms = st.map((status, i) => ({ id: 100 + i, number: String((i < 6 ? 200 : 300) + (i % 6) + 1), floor: i < 6 ? "2" : "3", status, attendant: status === "cleaning" ? "Rosa" : "", checkout: i % 3 === 0 }));

const manifest: AppManifest = {
  name: "backbone-housekeeping",
  title: "Housekeeping board",
  framework: "backbone",
  libs: ["backbone", "underscore", "jquery", "Backbone.sync($.ajax)", "rt.guard"],
  domain: "hotel-housekeeping",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "rooms", seed: rooms, filters: ["floor", "status"], envelope: "items", pageSize: 40 },
      { name: "supplies", seed: [], envelope: "items", required: ["item"] },
    ],
  },
  variants: {
    save: ["wait", "optimistic", "optimistic"],
    stepGuard: ["pending", "none"],
    supplyKey: ["idempotency-key", "none"],
    counts: ["listen", "manual"],
    pollMs: [5000, 3000],
  },
  affordances: [
    { id: "floor", kind: "select", sel: "select[name=floor]", values: ["all", "2", "3"], weight: 1.2, mode: "replace" },
    { id: "step", kind: "click", sel: "li.room button.next", nth: 6, weight: 4, mode: "accumulate", intent: "nth", dblclickP: 0.18, impatientP: 0.2, requires: "li.room button.next" },
    { id: "supply", kind: "click", sel: "form.supplies button.request", weight: 1, mode: "accumulate", dblclickP: 0.1, impatientP: 0.2 },
    { id: "supplyItem", kind: "select", sel: "select[name=item]", values: ["towels", "linen", "toiletries", "minibar"], weight: 0.8, mode: "replace", then: ["supply"] },
  ],
  external: [
    { kind: "update", target: "rooms", perMin: 3, where: { status: "inspected" }, data: [{ status: "dirty", attendant: "" }] },
    { kind: "update", target: "rooms", perMin: 2, where: { status: "cleaning" }, data: [{ status: "clean" }] },
  ],
  weights: { "board.loading": 0.1, "board.error": 0, "board.notice": 0, "board.pending": 0.1 },
  relations: [{ name: "dirty counter = dirty rooms", fields: ["board.dirty", "board.rooms"], check: (s) => !s.board || s.board.loading || s.board.dirty === s.board.rooms.filter((r: { status: string }) => r.status === "dirty").length }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
