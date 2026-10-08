import type { AppManifest } from "../../src/shared/manifest.js";

const stations: [string, string][] = [
  ["Union Square", "Downtown"], ["City Hall", "Downtown"], ["Market & 3rd", "Downtown"], ["Ferry Terminal", "Riverside"], ["Boathouse", "Riverside"],
  ["Mill Bridge", "Riverside"], ["Library Quad", "University"], ["Science Hall", "University"], ["Stadium Gate", "University"], ["Arts Centre", "Downtown"],
];
const docks = stations.map(([name, area], i) => ({ id: 80 + i, name, area, bikes: 2 + ((i * 5) % 7), ebikes: (i * 3) % 4, slots: 12 }));

const manifest: AppManifest = {
  name: "alpine-bikeshare",
  title: "Bike share",
  framework: "alpine",
  libs: ["alpinejs", "x-data component", "fetch", "WebSocket"],
  domain: "bike-share",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "docks", seed: docks, live: true, filters: ["area"], envelope: "data", pageSize: 20, actions: { reserve: { inc: "bikes", by: -1 }, release: { inc: "bikes", by: 1 }, take: { inc: "bikes", by: -1 }, give: { inc: "bikes", by: 1 } } },
      { name: "reservations", seed: [], unique: ["key"], required: ["dockId", "rider"], filters: ["rider"], envelope: "data" },
    ],
  },
  variants: {
    reserveGuard: ["pending", "none"],
    live: ["newer-wins", "blind"],
    expiry: ["cancel-on-expire", "leak"],
    reconnect: ["resync", "naive"],
    steps: ["rollback", "dangling"],
  },
  affordances: [
    { id: "area", kind: "select", sel: "select[name=area]", values: ["all", "Downtown", "Riverside", "University"], weight: 1, mode: "replace" },
    { id: "reserve", kind: "click", sel: "li.dock button.reserve", nth: 6, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "li.dock button.reserve:not([disabled])" },
    { id: "cancel", kind: "click", sel: "li.hold button.cancel-reservation", nth: 3, weight: 1, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.hold button.cancel-reservation" },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.6, mode: "replace", impatientP: 0.2 },
  ],
  external: [
    { kind: "action", target: "docks", perMin: 7, verb: "take", where: { area: "Downtown" } },
    { kind: "action", target: "docks", perMin: 4, verb: "take", where: { area: "University" } },
    { kind: "action", target: "docks", perMin: 9, verb: "give" },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
