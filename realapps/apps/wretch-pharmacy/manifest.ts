import type { AppManifest } from "../../src/shared/manifest.js";

const prescriptions = [
  { id: 1201, drug: "atorvastatin", label: "Atorvastatin 20 mg", qty: 30, refillsLeft: 3, autoRefill: false, prescriber: "Dr. Haddad", status: "active" },
  { id: 1202, drug: "metformin", label: "Metformin 500 mg", qty: 60, refillsLeft: 5, autoRefill: true, prescriber: "Dr. Haddad", status: "active" },
  { id: 1203, drug: "lisinopril", label: "Lisinopril 10 mg", qty: 30, refillsLeft: 1, autoRefill: false, prescriber: "Dr. Moreau", status: "active" },
  { id: 1204, drug: "levothyroxine", label: "Levothyroxine 50 mcg", qty: 90, refillsLeft: 2, autoRefill: false, prescriber: "Dr. Okonkwo", status: "active" },
  { id: 1205, drug: "sertraline", label: "Sertraline 50 mg", qty: 30, refillsLeft: 0, autoRefill: false, prescriber: "Dr. Moreau", status: "needs renewal" },
];
const drugs = prescriptions.map((p) => p.drug);
const stores = ["main", "north", "airport"];
const inventory = drugs.flatMap((drug, i) => stores.map((store, j) => ({ id: 3000 + i * 10 + j, drug, store, onHand: (i * 7 + j * 11) % 5 === 0 ? 0 : 8 + ((i * 13 + j * 5) % 40) })));
const refills = [
  { id: 7001, rxId: 1202, drug: "metformin", store: "main", qty: 60, createdAt: "2026-02-03T15:20:00.000Z" },
  { id: 7002, rxId: 1201, drug: "atorvastatin", store: "north", qty: 30, createdAt: "2026-03-01T11:05:00.000Z" },
  { id: 7003, rxId: 1204, drug: "levothyroxine", store: "main", qty: 90, createdAt: "2026-03-12T09:40:00.000Z" },
];

const manifest: AppManifest = {
  name: "wretch-pharmacy",
  title: "CareWell Pharmacy",
  framework: "vanilla",
  libs: ["wretch", "wretch/middlewares(retry)", "AbortController", "rt.atom"],
  domain: "healthcare",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "prescriptions", seed: prescriptions, envelope: "bare", actions: { refill: { inc: "refillsLeft", by: -1 } } },
      { name: "inventory", seed: inventory, envelope: "bare", filters: ["drug", "store"], pageSize: 50 },
      { name: "refills", seed: refills, envelope: "bare", required: ["rxId", "store"], pageSize: 50 },
    ],
  },
  variants: {
    retry: ["reads-only", "all", "all"],
    idemKey: ["outside-retry", "inside-retry", "none"],
    stockGuard: ["abort", "none"],
    confirmGuard: ["disable", "none"],
    countMode: ["derived", "incremental"],
  },
  affordances: [
    { id: "request", kind: "click", sel: "li.rx button.request-refill", nth: 5, weight: 2, mode: "replace", intent: "nth", then: ["store"] },
    { id: "store", kind: "select", sel: ".refill-panel select[name=store]", values: ["main", "north", "airport"], weight: 1.4, mode: "replace", requires: ".refill-panel" },
    { id: "confirm", kind: "click", sel: ".refill-panel button.confirm-refill", weight: 1.8, mode: "accumulate", requires: ".refill-panel", dblclickP: 0.2, impatientP: 0.3 },
    { id: "cancel", kind: "click", sel: ".refill-panel button.cancel-refill", weight: 0.4, mode: "replace", requires: ".refill-panel" },
    { id: "auto", kind: "click", sel: "li.rx button.auto-refill", nth: 5, weight: 0.8, mode: "accumulate", intent: "nth", dblclickP: 0.1 },
    { id: "history", kind: "click", sel: "button.reload-history", weight: 0.5, mode: "replace", impatientP: 0.15 },
  ],
  external: [
    { kind: "update", target: "inventory", perMin: 5, data: [{ onHand: 0 }, { onHand: 12 }, { onHand: 3 }, { onHand: 40 }, { onHand: 1 }] },
    { kind: "create", target: "refills", perMin: 0.4, data: [{ rxId: 1202, drug: "metformin", store: "airport", qty: 60, by: "pharmacist" }] },
    { kind: "update", target: "prescriptions", perMin: 0.5, data: [{ refillsLeft: 4 }, { status: "active" }, { autoRefill: true }] },
  ],
  weights: { "rx.loading": 0.1, "rx.error": 0, "refill.checking": 0.1, "refill.submitting": 0.1, "refill.error": 0, "refill.done": 0.2, "history.loading": 0.1 },
  relations: [
    { name: "refill counter == history entries", fields: ["history.count", "history.items"], check: (s) => !s.history || s.history.loading || s.history.count === s.history.items.length },
    { name: "refills left never negative", fields: ["rx.items"], check: (s) => !s.rx || s.rx.items.every((r: { refillsLeft: number }) => r.refillsLeft >= 0) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
