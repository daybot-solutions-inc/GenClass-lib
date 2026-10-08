import type { AppManifest } from "../../src/shared/manifest.js";

const drivers = [
  { id: "d-01", name: "Ana Silva", shift: "day" },
  { id: "d-02", name: "Marcus Webb", shift: "day" },
  { id: "d-03", name: "Yusuf Demir", shift: "day" },
  { id: "d-04", name: "Chloe Martin", shift: "day" },
  { id: "d-05", name: "Ravi Iyer", shift: "night" },
  { id: "d-06", name: "Grace Liu", shift: "day" },
  { id: "d-07", name: "Tomás Herrera", shift: "night" },
  { id: "d-08", name: "Ingrid Berg", shift: "day" },
];
const models = ["Ford Transit", "Mercedes Sprinter", "Ram ProMaster", "Nissan e-NV200", "Ford E-Transit"];
const vehicles = Array.from({ length: 10 }, (_, i) => ({
  id: 5100 + i,
  code: `V-${101 + i}`,
  model: models[i % models.length],
  depot: i % 2 ? "South" : "North",
  status: i === 3 ? "maintenance" : i % 3 === 0 ? "en-route" : "idle",
  driverId: i < 6 && i !== 3 ? drivers[i]!.id : null,
}));
const notes = [
  { id: 4401, vehicleId: 5100, text: "Rear door sticks — lift and push.", author: "Ana Silva" },
  { id: 4402, vehicleId: 5103, text: "Brake pads booked for Thursday.", author: "workshop" },
  { id: 4403, vehicleId: 5101, text: "Charging cable in the side pocket.", author: "Marcus Webb" },
];

const manifest: AppManifest = {
  name: "superagent-fleet",
  title: "Metro Courier — Dispatch board",
  framework: "vanilla",
  libs: ["superagent(xhr)", ".retry()", "If-Match"],
  domain: "logistics",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "vehicles", seed: vehicles, envelope: "bare", versioned: true, pageSize: 50, actions: { dispatch: { set: { status: "en-route" } }, recall: { set: { status: "idle" } } } },
      { name: "drivers", seed: drivers, envelope: "bare", idStyle: "slug" },
      { name: "notes", seed: notes, envelope: "bare", filters: ["vehicleId"], required: ["vehicleId", "text"] },
    ],
  },
  variants: {
    conflict: ["refetch", "overwrite", "ignore"],
    pollMerge: ["skip-pending", "overwrite"],
    retry: [0, 2],
    assignGuard: ["pending", "none"],
    pollMs: [5000, 2500],
  },
  affordances: [
    { id: "driver", kind: "select", sel: "tr.vehicle select.driver", nth: 10, values: ["", ...drivers.map((d) => d.id)], weight: 2.6, mode: "replace", intent: "nth", dblclickP: 0 },
    { id: "unassign", kind: "click", sel: "tr.vehicle button.unassign", nth: 10, weight: 0.9, mode: "accumulate", intent: "nth", dblclickP: 0.12 },
    { id: "dispatch", kind: "click", sel: "tr.vehicle button.dispatch", nth: 10, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2 },
    { id: "depot", kind: "select", sel: "select[name=depot]", values: ["all", "North", "South"], weight: 0.7, mode: "replace" },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.5, mode: "replace", impatientP: 0.2 },
    { id: "noteVehicle", kind: "select", sel: "select[name=noteVehicle]", values: vehicles.map((v) => String(v.id)), weight: 0.6, mode: "replace" },
    { id: "note", kind: "type", sel: "textarea[name=note]", values: ["Tyre pressure low on rear left.", "Parked in bay 7.", "Fuel card missing.", "Dashcam not recording."], weight: 0.8, mode: "replace", clear: true, then: ["addNote"] },
    { id: "addNote", kind: "click", sel: "button.add-note", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.3 },
  ],
  external: [
    { kind: "update", target: "vehicles", perMin: 3, data: [{ driverId: "d-07" }, { driverId: null }, { driverId: "d-05" }, { status: "maintenance" }, { status: "idle" }, { status: "en-route" }] },
    { kind: "create", target: "notes", perMin: 0.6, data: [{ vehicleId: 5100, text: "Washed and refuelled.", author: "yard" }, { vehicleId: 5104, text: "Scratch on the left mirror.", author: "Chloe Martin" }] },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
