import type { AppManifest } from "../../src/shared/manifest.js";

const places = ["Union Station", "Airport T2", "Maple & 5th", "City Hospital", "Harbourfront", "Convention Centre", "Riverside Mall", "Old Town Square"];
const rides = Array.from({ length: 7 }, (_, i) => ({ id: 4400 + i, pickup: places[i % 8], dropoff: places[(i + 3) % 8], riders: 1 + (i % 3), status: i < 5 ? "waiting" : "assigned", driverId: i < 5 ? 0 : 60 + i }));
const drivers = ["Ravi", "Elena", "Kwame", "Jun", "Marta", "Ben", "Noor"].map((name, i) => ({ id: 60 + i, name, zone: ["north", "south", "central"][i % 3], available: i < 5 }));

const manifest: AppManifest = {
  name: "lit-dispatch",
  title: "Ride dispatch",
  framework: "lit",
  libs: ["lit", "LitElement", "fetch", "WebSocket", "rt.atom", "AtomController"],
  domain: "ride-dispatch",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "rides", seed: rides, versioned: true, live: true, filters: ["status"], envelope: "items", pageSize: 40 },
      { name: "drivers", seed: drivers, filters: ["available"], envelope: "items", pageSize: 20 },
    ],
  },
  variants: {
    live: ["newer-wins", "blind"],
    reconnect: ["resync", "naive"],
    assignGuard: ["pending", "none"],
    assign: ["if-match", "force", "if-match"],
    waitingCount: ["derive", "incremental"],
  },
  affordances: [
    { id: "ride", kind: "click", sel: "dispatch-board >>> li.ride button.select", nth: 5, weight: 3, mode: "replace", key: "ride" },
    { id: "driver", kind: "click", sel: "dispatch-board >>> li.driver button.assign", nth: 5, weight: 3, mode: "accumulate", intent: "nth", after: ["ride"], requires: "dispatch-board >>> li.ride.selected", dblclickP: 0.15, impatientP: 0.25 },
    { id: "release", kind: "click", sel: "dispatch-board >>> li.ride button.release", nth: 3, weight: 1, mode: "accumulate", intent: "nth", requires: "dispatch-board >>> li.ride button.release" },
    { id: "zone", kind: "select", sel: "dispatch-board >>> select[name=zone]", values: ["all", "north", "south", "central"], weight: 1, mode: "replace" },
  ],
  external: [
    { kind: "create", target: "rides", perMin: 2, data: [{ pickup: "Airport T2", dropoff: "Harbourfront", riders: 2, status: "waiting", driverId: 0 }, { pickup: "City Hospital", dropoff: "Maple & 5th", riders: 1, status: "waiting", driverId: 0 }] },
    { kind: "update", target: "rides", perMin: 3, where: { status: "waiting" }, data: [{ status: "assigned", driverId: 66 }, { riders: 3 }] },
    { kind: "update", target: "drivers", perMin: 4, where: { available: false }, data: [{ available: true }] },
    { kind: "update", target: "rides", perMin: 1.5, where: { status: "assigned" }, data: [{ status: "completed" }] },
  ],
  weights: { "board.error": 0, "board.notice": 0, "board.live": 0.1, "board.busy": 0.1, "board.zone": 0.3 },
  relations: [{ name: "waiting count = waiting rides", fields: ["board.waiting", "board.rides"], check: (s) => !s.board || s.board.waiting === s.board.rides.filter((r: { status: string }) => r.status === "waiting").length }],
  errorSelector: "dispatch-board >>> [role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
