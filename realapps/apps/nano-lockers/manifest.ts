import type { AppManifest } from "../../src/shared/manifest.js";

const doors = ["Alfa", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliett", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa", "Quebec", "Romeo"];
const sizeOf = (i: number) => (i < 8 ? "S" : i < 14 ? "M" : "L");
// seed: a few doors hold other couriers' parcels ("by": "other"), Hotel holds one of ours, Papa is broken
const compartments = doors.map((name, i) => ({
  id: 7300 + i,
  name,
  size: sizeOf(i),
  status: name === "Papa" ? "out-of-service" : [1, 4, 9, 12, 16].includes(i) || name === "Hotel" ? "occupied" : "free",
  by: [1, 4, 9, 12, 16].includes(i) ? "other" : "",
  opens: name === "Hotel" ? 1 : 0,
}));

const manifest: AppManifest = {
  name: "nano-lockers",
  title: "Parcel locker drop-off",
  framework: "vanilla",
  libs: ["nanostores", "map/computed", "fetch", "WebSocket"],
  domain: "parcel-lockers",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      {
        name: "compartments",
        seed: compartments,
        live: true,
        filters: ["size", "status"],
        envelope: "items",
        pageSize: 50,
        actions: { occupy: { set: { status: "occupied" } }, open: { inc: "opens", by: 1 }, release: { set: { status: "free" } } },
      },
      { name: "reservations", seed: [{ id: 610, key: "7307|PX-4460", compartmentId: 7307, parcel: "PX-4460", courier: "me" }], unique: ["key"], required: ["compartmentId", "parcel"], filters: ["courier"], envelope: "items", pageSize: 50 },
    ],
  },
  variants: {
    reserveGuard: ["pending", "none"],
    live: ["newer-wins", "blind"],
    reconnect: ["resync", "naive"],
    steps: ["rollback", "dangling"],
    sizeSeq: ["latest", "blind"],
  },
  affordances: [
    { id: "size", kind: "click", sel: "nav.sizes button", text: ["Small", "Medium", "Large", "All"], weight: 1.5, mode: "replace", key: "size", dblclickP: 0.1 },
    { id: "parcel", kind: "select", sel: "select[name=parcel]", values: ["PX-4471", "PX-4475", "PX-4479", "PX-4482", "PX-4486"], weight: 0.8, mode: "replace", requires: "select[name=parcel]:not([disabled])" },
    { id: "reserve", kind: "click", sel: "li.compartment button.reserve", nth: 5, intent: "nth", weight: 3, mode: "accumulate", dblclickP: 0.2, impatientP: 0.2, requires: "li.compartment button.reserve:not([disabled])" },
    { id: "open", kind: "click", sel: "li.compartment button.open", nth: 3, intent: "nth", weight: 1.8, mode: "accumulate", dblclickP: 0.15, impatientP: 0.15, requires: "li.compartment button.open:not([disabled])" },
    { id: "release", kind: "click", sel: "li.compartment button.release", nth: 3, intent: "nth", weight: 0.9, mode: "accumulate", dblclickP: 0.1, impatientP: 0.15, requires: "li.compartment button.release:not([disabled])" },
  ],
  external: [
    // other couriers drop parcels, recipients pick theirs up, doors get opened, a door breaks and is repaired
    { kind: "update", target: "compartments", perMin: 4, where: { status: "free" }, data: [{ status: "occupied", by: "other" }] },
    { kind: "update", target: "compartments", perMin: 3, where: { status: "occupied", by: "other" }, data: [{ status: "free", by: "" }] },
    { kind: "action", target: "compartments", perMin: 2, where: { by: "other" }, verb: "open" },
    { kind: "update", target: "compartments", perMin: 0.6, where: { status: "free" }, data: [{ status: "out-of-service" }] },
    { kind: "update", target: "compartments", perMin: 1, where: { status: "out-of-service" }, data: [{ status: "free" }] },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
