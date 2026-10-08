import type { AppManifest } from "../../src/shared/manifest.js";

const zones: Record<string, [string, number, number][]> = {
  domestic: [["Economy", 4.5, 0.8], ["Standard", 6.2, 1.1], ["Express", 11.9, 1.6]],
  eu: [["Economy", 9.8, 2.1], ["Standard", 13.5, 2.6], ["Express", 24.0, 3.9]],
  world: [["Economy", 18.0, 4.2], ["Express", 39.0, 6.5]],
};
const rates: Record<string, unknown>[] = [];
let id = 1;
for (const [zone, svcs] of Object.entries(zones)) for (const [service, base, perKg] of svcs) rates.push({ id: id++, zone, service, base, perKg });

const manifest: AppManifest = {
  name: "lit-shipping",
  title: "Shipping calculator",
  framework: "lit",
  libs: ["lit", "LitElement(light DOM)", "fetch", "AbortController", "rt.atom", "AtomController"],
  domain: "shipping-rates",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "rates", seed: rates, filters: ["zone"], envelope: "items" },
      { name: "labels", seed: [], required: ["service", "price"], envelope: "items" },
    ],
  },
  variants: {
    quoteSeq: ["abort", "none"],
    staleRate: ["requote", "keep"],
    labelGuard: ["disable", "none"],
    labelKey: ["idempotency-key", "none"],
  },
  affordances: [
    { id: "zone", kind: "select", sel: "select[name=zone]", values: ["domestic", "eu", "world"], weight: 2, mode: "replace" },
    { id: "weight", kind: "type", sel: "input[name=weight]", values: ["0.5", "2", "3.75", "12", "1.2"], clear: true, weight: 2.5, mode: "replace", waitMs: 1 },
    { id: "service", kind: "click", sel: "li.rate button.choose", nth: 3, weight: 2.5, mode: "replace", key: "service" },
    { id: "label", kind: "click", sel: "button.create-label", weight: 1.5, mode: "accumulate", requires: "button.create-label:not([disabled])", dblclickP: 0.18, impatientP: 0.25, after: ["service"] },
  ],
  weights: { "ship.error": 0, "ship.notice": 0, "ship.quoting": 0.1, "ship.creating": 0.1, "ship.weight": 0.3 },
  relations: [
    { name: "quotes match the zone", fields: ["ship.quotes", "ship.zone"], check: (s) => !s.ship || s.ship.quoting || s.ship.quotes.every((q: { zone: string }) => q.zone === s.ship.zone) },
    { name: "chosen price matches the parcel", fields: ["ship.chosen", "ship.weight"], check: (s) => !s.ship || !s.ship.chosen || s.ship.quoting || (s.ship.chosen.zone === s.ship.zone && s.ship.chosen.kg === Number(s.ship.weight)) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
