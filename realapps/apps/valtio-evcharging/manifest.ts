import type { AppManifest } from "../../src/shared/manifest.js";

const posts: [string, string, number][] = [
  ["Aster", "CCS", 150], ["Birch", "CCS", 150], ["Cedar", "CCS", 50], ["Dahlia", "CCS", 50], ["Elm", "Type 2", 22],
  ["Fern", "Type 2", 22], ["Hazel", "CCS", 50], ["Iris", "Type 2", 11], ["Juniper", "CCS", 150], ["Laurel", "Type 2", 11],
];
// Birch charges our Van 17, Dahlia and Elm charge other drivers' vans, Iris is faulted
const connectors = posts.map(([name, plug, maxKw], i) => {
  const van = name === "Birch" ? "Van 17" : name === "Dahlia" ? "Van 44" : name === "Elm" ? "Van 52" : "";
  return { id: 5500 + i, name, plug, maxKw, status: van ? "charging" : name === "Iris" ? "faulted" : "available", van, kw: van ? Math.min(maxKw, 45) : 0, kwh: van === "Van 17" ? 4.5 : van ? 12 : 0 };
});
const sessions = [
  { id: 7700, connectorId: 5502, van: "Van 12", status: "stopped", kwh: 38.5 },
  { id: 7701, connectorId: 5506, van: "Van 23", status: "stopped", kwh: 21 },
  { id: 7702, connectorId: 5501, van: "Van 17", status: "active", kwh: 4.5 },
];
const OTHERS = ["Van 40", "Van 44", "Van 52"];
const round1 = (x: number) => Math.round(x * 10) / 10;

const manifest: AppManifest = {
  name: "valtio-evcharging",
  title: "Depot charging",
  framework: "vanilla",
  libs: ["valtio/vanilla", "lit-html (render)", "fetch", "WebSocket", "rt.guard"],
  domain: "ev-charging-depot",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "connectors", seed: connectors, versioned: true, live: true, filters: ["status"], envelope: "items", pageSize: 50, actions: { meter: { inc: "kwh", by: 1.5 } } },
      { name: "sessions", seed: sessions, required: ["connectorId", "van"], filters: ["status", "van"], envelope: "items", pageSize: 100 },
    ],
  },
  variants: {
    startGuard: ["pending", "none"],
    live: ["version-check", "blind"],
    stop: ["pessimistic", "optimistic-no-rollback"],
    energy: ["derive", "incremental"],
    reconnect: ["resync", "naive"],
  },
  affordances: [
    { id: "fast", kind: "check", sel: "input[name=fast]", weight: 1, mode: "replace", key: "fast" },
    { id: "van", kind: "select", sel: "select[name=van]", values: ["Van 08", "Van 12", "Van 23", "Van 31", "Van 17"], weight: 0.8, mode: "replace", key: "van", requires: "select[name=van]:not([disabled])" },
    { id: "start", kind: "click", sel: "li.connector button.start", nth: 5, intent: "nth", weight: 3, mode: "accumulate", dblclickP: 0.2, impatientP: 0.2, requires: "li.connector button.start:not([disabled])" },
    { id: "stop", kind: "click", sel: "li.connector button.stop", nth: 3, intent: "nth", weight: 1.6, mode: "accumulate", dblclickP: 0.15, impatientP: 0.2, requires: "li.connector button.stop:not([disabled])" },
  ],
  external: [
    // other drivers plug in and unplug, the chargers meter energy, a post faults and gets reset
    { kind: "update", target: "connectors", perMin: 3, where: { status: "available" }, data: OTHERS.map((van) => ({ status: "charging", van, kw: 45, kwh: 0 })) },
    { kind: "update", target: "connectors", perMin: 2.5, where: { van: { $in: OTHERS } }, data: [{ status: "available", van: "", kw: 0, kwh: 0 }] },
    { kind: "action", target: "connectors", perMin: 9, where: { status: "charging" }, verb: "meter" },
    { kind: "update", target: "connectors", perMin: 2, where: { status: "charging" }, data: [{ kw: 38 }, { kw: 44 }, { kw: 21 }] },
    { kind: "update", target: "connectors", perMin: 0.5, where: { status: "available" }, data: [{ status: "faulted" }] },
    { kind: "update", target: "connectors", perMin: 1, where: { status: "faulted" }, data: [{ status: "available" }] },
  ],
  weights: { "depot.error": 0, "depot.notice": 0, "depot.starting": 0.1, "depot.claimed": 0.1, "depot.stopping": 0.1, "depot.live": 0.1, "depot.loading": 0.1, "depot.van": 0.3 },
  relations: [
    { name: "energy delivered = sum of session energy", fields: ["depot.energy", "depot.sessions"], check: (s) => !s.depot || round1(s.depot.energy) === round1(s.depot.sessions.reduce((n: number, x: { kwh: number }) => n + Number(x.kwh || 0), 0)) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
