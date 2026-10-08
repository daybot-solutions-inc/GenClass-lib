import type { AppManifest } from "../../src/shared/manifest.js";

const wards = ["Medical", "Surgical", "ICU"];
const statuses = ["occupied", "available", "occupied", "cleaning", "occupied", "available", "blocked", "occupied", "cleaning", "available", "occupied", "occupied"];
const names = ["E. Moreau", "", "K. Osei", "", "T. Nakamura", "", "", "B. Fischer", "", "", "S. Rahman", "J. Silva"];
const beds = statuses.map((status, i) => ({ id: 700 + i, ward: wards[i % 3], bed: `${["M", "S", "I"][i % 3]}-${String(1 + Math.floor(i / 3)).padStart(2, "0")}`, status, patient: names[i] }));
const admissions = [
  { id: 41, name: "A. Kowalski", ward: "Medical", acuity: 2 },
  { id: 42, name: "R. Haddad", ward: "Surgical", acuity: 3 },
  { id: 43, name: "L. Chen", ward: "ICU", acuity: 1 },
  { id: 44, name: "P. Murphy", ward: "Medical", acuity: 3 },
];

const manifest: AppManifest = {
  name: "preact-beds",
  title: "Bed board",
  framework: "preact",
  libs: ["preact", "preact/hooks (useState/useEffect)", "fetch", "WebSocket"],
  domain: "hospital-bed-management",
  entry: "main.tsx",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "beds", seed: beds, versioned: true, live: true, filters: ["ward", "status"], envelope: "items", pageSize: 40 },
      { name: "admissions", seed: admissions, live: true, required: ["name"], filters: ["ward"], envelope: "items", pageSize: 20 },
    ],
  },
  variants: {
    assign: ["if-match", "force"],
    assignGuard: ["pending", "none"],
    steps: ["bed-then-admission", "admission-first"],
    live: ["newer-wins", "blind"],
    reconnect: ["resync", "naive"],
  },
  affordances: [
    { id: "ward", kind: "click", sel: "nav.wards button", text: ["All", "Medical", "Surgical", "ICU"], weight: 1, mode: "replace", key: "ward" },
    { id: "pick", kind: "click", sel: "li.admission button.pick", nth: 4, weight: 2.5, mode: "replace", key: "pick", requires: "li.admission button.pick", then: ["assign"] },
    { id: "assign", kind: "click", sel: "li.bed.available button.assign", nth: 4, weight: 0, mode: "accumulate", intent: "nth", followOnly: true, dblclickP: 0.15, impatientP: 0.2 },
    { id: "discharge", kind: "click", sel: "li.bed.occupied button.discharge", nth: 6, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.bed.occupied button.discharge" },
    { id: "cleaned", kind: "click", sel: "li.bed.cleaning button.cleaned", nth: 3, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.bed.cleaning button.cleaned" },
  ],
  external: [
    { kind: "create", target: "admissions", perMin: 3, data: [{ name: "G. Ivanova", ward: "Medical", acuity: 2 }, { name: "H. Abara", ward: "Surgical", acuity: 3 }, { name: "M. Lindqvist", ward: "ICU", acuity: 1 }, { name: "D. Park", ward: "Medical", acuity: 3 }] },
    { kind: "update", target: "beds", perMin: 2, where: { status: "available" }, data: [{ status: "occupied", patient: "transfer (ED)" }] },
    { kind: "update", target: "beds", perMin: 2, where: { status: "cleaning" }, data: [{ status: "available", patient: "" }] },
    { kind: "update", target: "beds", perMin: 1.5, where: { status: "occupied" }, data: [{ status: "cleaning", patient: "" }] },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
