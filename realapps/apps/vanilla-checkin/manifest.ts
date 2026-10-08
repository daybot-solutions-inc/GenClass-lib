import type { AppManifest } from "../../src/shared/manifest.js";

const mine = [
  { id: 6101, booking: "QX7RZ", name: "Ana Ribeiro", seat: "", bags: 0, checkedIn: false },
  { id: 6102, booking: "QX7RZ", name: "Joao Ribeiro", seat: "", bags: 1, checkedIn: false },
  { id: 6103, booking: "QX7RZ", name: "Lia Ribeiro", seat: "", bags: 0, checkedIn: false },
];
const others = ["1A", "1D", "2B", "3C", "4A", "4B", "5D", "6C", "7A", "8B"].map((seat, i) => ({ id: 6200 + i, booking: "OTHER", name: `Passenger ${i + 1}`, seat, bags: i % 2, checkedIn: true }));

const manifest: AppManifest = {
  name: "vanilla-checkin",
  title: "Online check-in",
  framework: "vanilla",
  libs: ["fetch", "rt.atom"],
  domain: "airline-checkin",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "passengers", seed: [...mine, ...others], filters: ["booking"], unique: ["seat"], envelope: "items", pageSize: 60, actions: { bag: { inc: "bags", by: 1 }, checkin: { set: { checkedIn: true } } } },
    ],
  },
  variants: {
    seatGuard: ["pending", "none"],
    seatSave: ["wait", "optimistic", "optimistic-rollback"],
    bagGuard: ["disable", "none"],
    mapLoad: ["latest", "blind"],
    bagsTotal: ["derive", "increment"],
    pollMs: [5000, 3000],
  },
  affordances: [
    { id: "pick", kind: "click", sel: "li.pax button.pick", nth: 3, weight: 2, mode: "replace", key: "pax" },
    { id: "seat", kind: "click", sel: ".seatmap button.seat.free", nth: 20, weight: 3, mode: "replace", key: "seat", intent: "aff", after: ["pick"], requires: "li.pax.current", dblclickP: 0.15, impatientP: 0.2 },
    { id: "bag", kind: "click", sel: "li.pax button.bag", nth: 3, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, burst: [0, 1] },
    { id: "checkin", kind: "click", sel: "li.pax button.checkin", nth: 3, weight: 1.2, mode: "accumulate", intent: "nth", dblclickP: 0.12, requires: "li.pax button.checkin" },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.6, mode: "replace" },
  ],
  external: [
    { kind: "update", target: "passengers", perMin: 4, where: { booking: "OTHER" }, data: [{ seat: "2C" }, { seat: "3A" }, { seat: "5B" }, { seat: "6D" }, { seat: "7C" }, { seat: "8D" }, { seat: "1B" }] },
  ],
  weights: { "checkin.error": 0, "checkin.notice": 0, "checkin.busy": 0.1, "checkin.loading": 0.1 },
  relations: [{ name: "bag total == sum of passenger bags", fields: ["checkin.bagsTotal", "checkin.pax"], check: (s) => !s.checkin || s.checkin.bagsTotal === s.checkin.pax.reduce((a: number, p: { bags: number }) => a + Number(p.bags || 0), 0) }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
