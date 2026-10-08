import type { AppManifest } from "../../src/shared/manifest.js";

const names = ["Biscuit", "Luna", "Pepper", "Mochi", "Ziggy", "Hazel", "Otis", "Clover", "Juniper", "Rocco", "Willow", "Nugget", "Maple", "Bruno", "Tofu", "Poppy", "Ollie", "Sage", "Remy", "Daisy", "Pip", "Koda", "Fern", "Bean"];
const species = ["dog", "cat", "rabbit"];
const ages = ["young", "adult", "senior"];
const pets = names.map((name, i) => ({ id: 600 + i, name, species: species[i % 3], age: ages[(i * 5 + Math.floor(i / 3)) % 3], status: "available", shelter: ["Eastside", "Harbour", "Hillcrest"][(i * 2) % 3] }));

const manifest: AppManifest = {
  name: "preact-adoption",
  title: "Adopt a pet",
  framework: "preact",
  libs: ["preact", "@preact/signals", "fetch", "rt.atom", "atomSignal"],
  domain: "pet-adoption",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "pets", seed: pets, filters: ["species", "age", "status"], envelope: "data", pageSize: 6 },
      { name: "applications", seed: [], versioned: true, required: ["petId", "applicant"], filters: ["status"], envelope: "data" },
    ],
  },
  variants: {
    pageSeq: ["latest", "blind"],
    filterReset: ["page-1", "keep-page"],
    applyKey: ["idempotency-key", "retry-blind", "no-retry"],
    applyGuard: ["pending", "none"],
    visitSave: ["patch-if-match", "put-stale"],
  },
  affordances: [
    { id: "species", kind: "select", sel: "select[name=species]", values: ["all", ...species], weight: 1, mode: "replace" },
    { id: "age", kind: "select", sel: "select[name=age]", values: ["any", ...ages], weight: 0.6, mode: "replace" },
    { id: "page", kind: "click", sel: "nav.pages button", nth: 4, weight: 2, mode: "replace", key: "page" },
    { id: "adopt", kind: "click", sel: "li.pet button.adopt", nth: 6, weight: 2.2, mode: "replace", key: "adopt", requires: "li.pet button.adopt", then: ["applicant", "submitApp"] },
    { id: "applicant", kind: "type", sel: "form.apply input[name=applicant]", values: ["Morgan Diaz", "Kai Thompson", "Noor Haddad"], clear: true, weight: 0, mode: "replace", followOnly: true },
    { id: "submitApp", kind: "click", sel: "form.apply button.submit", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.25 },
    { id: "visit", kind: "select", sel: "form.visit select[name=visit]", values: ["Sat 10:00", "Sat 14:00", "Sun 11:00", "Mon 17:30"], weight: 1.4, mode: "replace", after: ["adopt"], requires: "form.visit", then: ["confirmVisit"] },
    { id: "confirmVisit", kind: "click", sel: "form.visit button", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.1, impatientP: 0.15 },
  ],
  external: [
    { kind: "update", target: "applications", perMin: 6, where: { status: "received" }, data: [{ status: "reviewing" }] },
    { kind: "update", target: "pets", perMin: 1.2, where: { status: "available" }, data: [{ status: "adopted" }] },
  ],
  weights: { "pets.error": 0, "pets.loading": 0.1, "pets.species": 0.3, "pets.age": 0.3, "adopt.error": 0, "adopt.notice": 0, "adopt.submitting": 0.1, "adopt.applicant": 0.3 },
  relations: [
    { name: "listed pets match the filters", fields: ["pets.items", "pets.species", "pets.age"], check: (s) => !s.pets || s.pets.loading || s.pets.items.every((p: { species: string; age: string }) => (s.pets.species === "all" || p.species === s.pets.species) && (s.pets.age === "any" || p.age === s.pets.age)) },
    { name: "the page exists", fields: ["pets.page", "pets.total"], check: (s) => !s.pets || s.pets.loading || s.pets.page === 1 || (s.pets.page - 1) * 6 < s.pets.total },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
