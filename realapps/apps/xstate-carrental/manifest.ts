import type { AppManifest } from "../../src/shared/manifest.js";

const fleet: [string, string, number][] = [
  ["Toyota Corolla", "compact", 42], ["Honda Civic", "compact", 45], ["Mazda CX-5", "SUV", 68], ["Ford Escape", "SUV", 64], ["Tesla Model 3", "electric", 89],
  ["Kia Niro EV", "electric", 74], ["Chrysler Pacifica", "minivan", 82], ["VW Golf", "compact", 44], ["Subaru Outback", "SUV", 71],
];
const locations = ["Airport", "Downtown", "Station"];
const cars = [] as Record<string, unknown>[];
let id = 5300;
locations.forEach((location, l) => fleet.forEach(([model, cls, rate]) => cars.push({ id: id++, location, model, cls, dayRate: rate + l * 3, status: "available", holder: "" })));

const manifest: AppManifest = {
  name: "xstate-carrental",
  title: "Car rental",
  framework: "vanilla",
  libs: ["xstate@5", "createActor", "fromPromise", "after (delayed transitions)", "fetch", "rt.atom", "template-string DOM"],
  domain: "car-rental",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "cars", seed: cars, versioned: true, filters: ["location", "status", "cls"], envelope: "items", pageSize: 20 },
      { name: "bookings", seed: [], required: ["carId"], envelope: "items" },
    ],
  },
  variants: {
    quote: ["invoke", "effect"],
    holdRelease: ["on-exit", "never"],
    bookKey: ["per-hold", "none"],
    bookGuard: ["state", "none"],
    availability: ["refetch-on-back", "stale"],
  },
  affordances: [
    { id: "location", kind: "select", sel: "select[name=location]", values: locations, weight: 1.2, mode: "replace", requires: "select[name=location]:not([disabled])" },
    { id: "reserve", kind: "click", sel: "li.car button.reserve", nth: 5, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "li.car button.reserve:not([disabled])", then: ["insurance", "book"] },
    { id: "insurance", kind: "select", sel: "select[name=insurance]", values: ["none", "basic", "full"], weight: 0, mode: "replace", followOnly: true },
    { id: "book", kind: "click", sel: "button.book", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.3 },
    { id: "peek", kind: "click", sel: "li.car button.reserve", nth: 5, weight: 0.8, mode: "accumulate", intent: "nth", requires: "li.car button.reserve:not([disabled])", then: ["back"] },
    { id: "back", kind: "click", sel: "button.back", weight: 0, mode: "replace", followOnly: true },
  ],
  external: [
    { kind: "update", target: "cars", perMin: 4, where: { status: "available" }, data: [{ status: "held", holder: "other" }] },
    { kind: "update", target: "cars", perMin: 3, where: { holder: "other" }, data: [{ status: "available", holder: "" }, { status: "booked" }] },
    { kind: "update", target: "cars", perMin: 5, where: { status: "booked" }, data: [{ status: "available", holder: "" }] },
  ],
  weights: { "rental.error": 0, "rental.notice": 0, "rental.quoting": 0.1, "rental.busy": 0.1 },
  relations: [
    { name: "results are at the chosen location", fields: ["rental.cars", "rental.location"], check: (s) => !s.rental || s.rental.quoting || s.rental.cars.every((c: { location: string }) => c.location === s.rental.location) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
