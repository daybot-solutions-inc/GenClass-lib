import type { AppManifest } from "../../src/shared/manifest.js";

const STATUSES = ["label_created", "in_transit", "out_for_delivery", "delivered", "exception"];
const rows: [string, string, string, string][] = [
  ["DHL", "Express", "Berlin, DE", "in_transit"],
  ["UPS", "Ground", "Lyon, FR", "out_for_delivery"],
  ["FedEx", "Home", "Leeds, UK", "label_created"],
  ["DHL", "Ground", "Porto, PT", "in_transit"],
  ["UPS", "Express", "Milan, IT", "delivered"],
  ["FedEx", "Ground", "Ghent, BE", "exception"],
  ["DHL", "Home", "Krakow, PL", "in_transit"],
  ["UPS", "Ground", "Vienna, AT", "label_created"],
];
const shipments = rows.map(([carrier, service, destination, status], i) => ({ id: 3300 + i, tracking: `TRK${88000 + i * 37}`, carrier, service, destination, status }));
const hubs = ["Leipzig hub", "Paris CDG", "East Midlands", "Madrid hub", "Cologne hub"];
const events: Record<string, unknown>[] = [];
for (let i = 0; i < 24; i++) {
  const s = i % 8;
  const k = Math.floor(i / 8);
  events.push({ id: 64000 + i, shipmentId: 3300 + s, status: k === 0 ? "label_created" : "in_transit", location: k === 0 ? "Warehouse Rotterdam" : hubs[(s + k) % hubs.length], createdAt: `2026-03-31T${String(8 + k * 4).padStart(2, "0")}:${String(10 + s * 5).padStart(2, "0")}:00.000Z` });
}

type S = { status: string };
type E = { id: number };

const manifest: AppManifest = {
  name: "superagent-logistics",
  title: "Shipment tracking",
  framework: "react",
  libs: ["react", "superagent", "xhr", "useReducer via useGenClassState"],
  domain: "logistics",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "shipments", seed: shipments, filters: ["status", "carrier"], envelope: "results", pageSize: 50 },
      { name: "events", seed: events, filters: ["shipmentId"], envelope: "results", pageSize: 5, required: ["status"] },
    ],
  },
  variants: {
    merge: ["by-id", "append", "append"],
    bulk: ["apply-results", "assume-all"],
    reportGuard: ["disable", "none"],
    pollMs: [3000, 2000, 4500],
  },
  affordances: [
    { id: "track", kind: "click", sel: "tr.shipment button.track", nth: 8, weight: 3, mode: "replace", key: "shipment" },
    { id: "pick", kind: "check", sel: "tr.shipment input.pick", nth: 8, weight: 2.5, mode: "accumulate", intent: "nth" },
    { id: "relabelTo", kind: "select", sel: "select[name=relabel]", values: ["UPS Ground", "DHL Express", "FedEx Home"], weight: 0.8, mode: "replace" },
    { id: "relabel", kind: "click", sel: "button.relabel", weight: 1.5, mode: "accumulate", after: ["pick"], dblclickP: 0.12, impatientP: 0.2 },
    { id: "report", kind: "click", sel: "section.timeline button.report", weight: 1, mode: "accumulate", requires: "section.timeline button.report", dblclickP: 0.2, impatientP: 0.2 },
    { id: "refresh", kind: "click", sel: "section.timeline button.refresh", weight: 0.8, mode: "replace", requires: "section.timeline button.refresh" },
    { id: "status", kind: "select", sel: "select[name=status]", values: ["all", ...STATUSES], weight: 0.8, mode: "replace" },
  ],
  external: [
    { kind: "create", target: "events", perMin: 12, data: [{ shipmentId: 3300, status: "in_transit", location: "Leipzig hub" }, { shipmentId: 3301, status: "out_for_delivery", location: "Lyon depot" }, { shipmentId: 3303, status: "in_transit", location: "Madrid hub" }, { shipmentId: 3306, status: "in_transit", location: "Cologne hub" }, { shipmentId: 3302, status: "in_transit", location: "East Midlands" }, { shipmentId: 3301, status: "delivered", location: "Lyon, FR" }] },
    { kind: "update", target: "shipments", perMin: 2, data: [{ status: "in_transit" }, { status: "out_for_delivery" }, { status: "delivered" }, { status: "exception" }] },
  ],
  weights: { "track.error": 0, "track.notice": 0, "track.loading": 0.1, "track.relabeling": 0.1, "track.picked": 0.3, "track.filter": 0.3, "track.relabelTo": 0.3, "track.lastSeen": 0 },
  relations: [
    { name: "counts == shipments per status", fields: ["track.counts", "track.shipments"], check: (s) => !s.track || STATUSES.every((st) => (s.track.counts[st] ?? 0) === s.track.shipments.filter((x: S) => x.status === st).length) },
    { name: "timeline has no duplicate events", fields: ["track.timeline"], check: (s) => !s.track || new Set(s.track.timeline.map((e: E) => e.id)).size === s.track.timeline.length },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
