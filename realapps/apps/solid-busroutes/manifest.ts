import type { AppManifest } from "../../src/shared/manifest.js";

const fleet: [string, string, string, string, string, string, string, number, string][] = [
  ["Bus 12", "north", "North Loop", "Lincoln Elementary", "Rosa Alvarez", "Maple & 3rd", "Oak Avenue", 4, "on route"],
  ["Bus 4", "north", "North Loop", "Lincoln Elementary", "Dev Malhotra", "Cedar Court", "Maple & 3rd", 7, "on route"],
  ["Bus 7", "river", "River Road", "Riverside Middle", "Grace Obi", "Mill Bridge", "Ferry Lane", 6, "on route"],
  ["Bus 9", "river", "River Road", "Riverside Middle", "Tom Becker", "Depot", "Mill Bridge", 12, "not started"],
  ["Bus 15", "hill", "Hillcrest", "Hillcrest High", "Ana Lima", "Summit Drive", "Pine & 9th", 5, "on route"],
  ["Bus 21", "hill", "Hillcrest", "Hillcrest High", "Marcus Webb", "Elm Park", "Summit Drive", 9, "delayed"],
  ["Bus 3", "north", "North Loop", "Lincoln Elementary", "Lena Varga", "Birch Street", "School gate", 2, "on route"],
  ["Bus 18", "river", "River Road", "Riverside Middle", "Sam Carter", "Ferry Lane", "Harbour View", 8, "on route"],
];
const buses = fleet.map(([bus, route, routeName, school, driver, at, next, eta, status], i) => ({ id: 300 + i, bus, route, routeName, school, driver, at, next, eta, status }));
const stops = [
  { id: 41, name: "Maple & 3rd", route: "north", bus: "Bus 12", pickup: "7:42" },
  { id: 42, name: "Oak Avenue", route: "north", bus: "Bus 12", pickup: "7:46" },
  { id: 43, name: "Cedar Court", route: "north", bus: "Bus 4", pickup: "7:38" },
  { id: 44, name: "Mill Bridge", route: "river", bus: "Bus 7", pickup: "7:51" },
  { id: 45, name: "Ferry Lane", route: "river", bus: "Bus 7", pickup: "7:55" },
  { id: 46, name: "Harbour View", route: "river", bus: "Bus 18", pickup: "8:02" },
];

const manifest: AppManifest = {
  name: "solid-busroutes",
  title: "School bus tracker",
  framework: "solid",
  libs: ["solid-js", "solid-js/html", "solid-js/store createStore", "fetch", "AbortController", "WebSocket"],
  domain: "school-bus-tracking",
  entry: "main.ts",
  integration: "observe",
  build: { jsx: "solid-html" },
  server: {
    base: "/api",
    collections: [
      { name: "buses", seed: buses, live: true, filters: ["route"], envelope: "items", pageSize: 20 },
      { name: "stops", seed: stops, envelope: "items", pageSize: 20 },
      { name: "alerts", seed: [{ id: 900, parent: "Jordan Lee", stopId: 44, stop: "Mill Bridge", key: "Jordan Lee|44" }], filters: ["parent"], unique: ["key"], required: ["parent", "stopId"], envelope: "items" },
      { name: "absences", seed: [], filters: ["parent", "date"], unique: ["key"], required: ["child", "reason", "date"], envelope: "items" },
    ],
  },
  variants: {
    live: ["newer-wins", "blind"],
    reconnect: ["resync", "naive"],
    alertGuard: ["pending", "none"],
    absenceGuard: ["pending", "none"],
    routeFetch: ["abort", "none"],
  },
  affordances: [
    { id: "route", kind: "select", sel: "select[name=route]", values: ["north", "river", "hill", "all", "north"], weight: 2, mode: "replace" },
    { id: "alert", kind: "click", sel: "li.stop button.alert", nth: 6, intent: "nth", weight: 3, mode: "accumulate", dblclickP: 0.2, impatientP: 0.2, requires: "li.stop button.alert:not([disabled])" },
    { id: "child", kind: "select", sel: "form.absence select[name=child]", values: ["Mia", "Leo"], weight: 1.2, mode: "replace", then: ["reason", "report"] },
    { id: "reason", kind: "select", sel: "form.absence select[name=reason]", values: ["sick", "appointment", "family", "other"], weight: 0, mode: "replace", followOnly: true },
    { id: "report", kind: "click", sel: "form.absence button.report", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.25 },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.7, mode: "accumulate", dblclickP: 0.1 },
  ],
  external: [
    // the buses driving their routes
    {
      kind: "update",
      target: "buses",
      perMin: 18,
      where: { status: { $in: ["on route", "delayed"] } },
      data: [
        { at: "Oak Avenue", next: "Birch Street", eta: 3 },
        { at: "Birch Street", next: "School gate", eta: 1 },
        { at: "Pine & 9th", next: "Elm Park", eta: 6 },
        { at: "Ferry Lane", next: "Harbour View", eta: 4 },
        { eta: 5 },
        { eta: 2 },
        { status: "delayed", eta: 11 },
        { status: "on route" },
      ],
    },
    { kind: "update", target: "buses", perMin: 2, where: { status: "not started" }, data: [{ status: "on route", at: "Depot gate", next: "Mill Bridge", eta: 10 }] },
    { kind: "update", target: "buses", perMin: 1.5, where: { status: "on route" }, data: [{ status: "arrived", eta: 0, at: "School gate", next: "—" }] },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
