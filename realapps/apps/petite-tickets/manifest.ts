import type { AppManifest } from "../../src/shared/manifest.js";

const seats: Record<string, unknown>[] = [];
let id = 1;
for (const [section, price] of [["Stalls", 65], ["Circle", 48]] as [string, number][])
  for (const row of ["A", "B", "C"])
    for (let n = 1; n <= 6; n++) {
      const taken = (id * 7) % 5 === 0;
      seats.push({ id: id++, section, row, num: n, price: row === "A" ? price + 10 : price, status: taken ? "sold" : "available", holder: taken ? "other" : "" });
    }

const manifest: AppManifest = {
  name: "petite-tickets",
  title: "Box office",
  framework: "petite-vue",
  libs: ["petite-vue", "fetch", "rt.atom"],
  domain: "event-ticketing",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "seats", seed: seats, versioned: true, filters: ["section", "status"], envelope: "items", pageSize: 40 },
      { name: "orders", seed: [], required: ["seats"], envelope: "items" },
    ],
  },
  variants: {
    holdVersion: ["if-match", "none"],
    holdGuard: ["pending", "none"],
    total: ["derive", "incremental"],
    orderKey: ["idempotency-key", "none"],
    mapPoll: ["pending-aware", "blind"],
  },
  affordances: [
    { id: "section", kind: "click", sel: "nav.sections button", text: ["Stalls", "Circle"], weight: 1, mode: "replace", key: "section" },
    { id: "hold", kind: "click", sel: ".seatmap button.seat.available", nth: 12, weight: 4, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2 },
    { id: "release", kind: "click", sel: "li.held button.release", nth: 3, weight: 1.2, mode: "accumulate", intent: "nth", requires: "li.held button.release" },
    { id: "checkout", kind: "click", sel: "button.checkout", weight: 1, mode: "accumulate", requires: "button.checkout:not([disabled])", dblclickP: 0.15, impatientP: 0.25, after: ["hold"] },
  ],
  external: [
    { kind: "update", target: "seats", perMin: 6, where: { status: "available" }, data: [{ status: "held", holder: "other" }] },
    { kind: "update", target: "seats", perMin: 3, where: { holder: "other", status: "held" }, data: [{ status: "available", holder: "" }, { status: "sold" }] },
  ],
  weights: { "box.error": 0, "box.notice": 0, "box.pending": 0.1, "box.paying": 0.1 },
  relations: [{ name: "basket total = held seat prices", fields: ["box.total", "box.mine"], check: (s) => !s.box || s.box.total === s.box.mine.reduce((a: number, x: { price: number }) => a + x.price, 0) }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
