import type { AppManifest } from "../../src/shared/manifest.js";

const vehicles = [["KX21 ABC", "Toyota Corolla"], ["KX22 BCD", "VW Golf"], ["LM70 XYZ", "Nissan Leaf"], ["LM19 QRS", "Ford Fiesta"], ["AB12 CDE", "Kia Niro"], ["AB68 FGH", "Honda Jazz"]].map(([plate, model], i) => ({ id: 30 + i, plate, model }));
const zones = [{ id: 1, code: "A", name: "Zone A – Old Town", monthly: 42 }, { id: 2, code: "B", name: "Zone B – Riverside", monthly: 30 }, { id: 3, code: "C", name: "Zone C – University", monthly: 25 }];
const permits = [{ id: 501, plate: "KX21 ABC", zone: "A", months: 3, status: "active" }];

const manifest: AppManifest = {
  name: "jquery-parking",
  title: "Residents' parking permits",
  framework: "jquery",
  libs: ["jquery", "$.ajax", "$.getJSON"],
  domain: "parking-permits",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "vehicles", seed: vehicles, search: ["plate"], envelope: "bare" },
      { name: "zones", seed: zones, envelope: "bare" },
      { name: "permits", seed: permits, required: ["plate", "zone"], envelope: "bare", actions: { renew: { inc: "months", by: 1 } } },
    ],
  },
  variants: {
    plateLookup: ["abort", "none"],
    submitGuard: ["disable", "none"],
    submitKey: ["idempotency-key", "none"],
    renewGuard: ["disable", "none"],
  },
  affordances: [
    { id: "plate", kind: "type", sel: "input[name=plate]", values: ["KX2", "LM70 XYZ", "AB1", "AB68 FGH", "KX22 BCD"], clear: true, weight: 2.5, mode: "replace", waitMs: 1 },
    { id: "zone", kind: "select", sel: "select[name=zone]", values: ["A", "B", "C"], weight: 1.5, mode: "replace" },
    { id: "months", kind: "click", sel: "fieldset.months label", text: ["1 month", "3 months", "6 months", "12 months"], weight: 1.2, mode: "replace", key: "months" },
    { id: "apply", kind: "click", sel: "form.apply button[type=submit]", weight: 1.8, mode: "accumulate", after: ["plate"], dblclickP: 0.15, impatientP: 0.25 },
    { id: "renew", kind: "click", sel: "li.permit button.renew", nth: 3, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.18, impatientP: 0.2 },
    { id: "cancel", kind: "click", sel: "li.permit button.cancel", nth: 3, weight: 0.5, mode: "accumulate", intent: "nth", requires: "li.permit button.cancel" },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
