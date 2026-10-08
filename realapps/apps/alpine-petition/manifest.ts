import type { AppManifest } from "../../src/shared/manifest.js";

const people: [string, string][] = [["Maya R.", "Riverside"], ["Tom B.", "Northend"], ["Aisha K.", "Riverside"], ["Luis G.", "Old Mill"], ["Hannah W.", "Riverside"], ["Jonah P.", "Eastgate"]];
const signers = people.map(([name, city], i) => ({ id: 70 + i, name, city, email: `seed${i}@example.org`, comment: i % 2 ? "" : "The library is our second home.", createdAt: `2026-03-31T2${i}:00:00.000Z` }));
const others = [
  { name: "Priya S.", city: "Riverside", email: "priya@example.net", comment: "" },
  { name: "Owen D.", city: "Old Mill", email: "owen@example.net", comment: "Keep the reading room open!" },
  { name: "Fatou N.", city: "Eastgate", email: "fatou@example.net", comment: "" },
  { name: "Grace L.", city: "Northend", email: "grace@example.net", comment: "My kids learned to read there." },
  { name: "Ivan M.", city: "Riverside", email: "ivan@example.net", comment: "" },
];

const manifest: AppManifest = {
  name: "alpine-petition",
  title: "Save the Riverside Library",
  framework: "alpine",
  libs: ["alpinejs", "Alpine.store(rt.atom)", "fetch", "WebSocket"],
  domain: "petition",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "signers", seed: signers, live: true, unique: ["email"], required: ["name", "email"], envelope: "items", pageSize: 6 }],
    counters: [
      { name: "signatures", init: 1237, live: true },
      { name: "shares", init: 88, live: false },
    ],
  },
  variants: {
    count: ["server-value", "local-add"],
    signGuard: ["pending", "none"],
    signRetry: ["idempotency-key", "blind", "none"],
    recent: ["dedupe", "append"],
    reconnect: ["resync", "naive"],
  },
  affordances: [
    { id: "name", kind: "type", sel: "form.sign input[name=name]", values: ["Sam Okoro", "Lena Fischer", "Ravi Patel", "Chloe Martin"], clear: true, weight: 2.5, mode: "replace", then: ["email", "sign"] },
    { id: "email", kind: "type", sel: "form.sign input[name=email]", values: ["sam.okoro@example.com", "lena.f@example.com", "ravi.p@example.com", "chloe.m@example.com", "sam.o@example.com"], clear: true, weight: 0, mode: "replace", followOnly: true },
    { id: "sign", kind: "click", sel: "form.sign button.sign", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.25 },
    { id: "clear", kind: "click", sel: "form.sign button.clear", weight: 0.4, mode: "replace", key: "form" },
    { id: "share", kind: "click", sel: "button.share", weight: 1.2, mode: "accumulate", burst: [0, 2] },
  ],
  external: [
    { kind: "counter", target: "signatures", perMin: 20, by: 1 },
    { kind: "create", target: "signers", perMin: 5, data: others },
  ],
  weights: { "petition.error": 0, "petition.notice": 0, "petition.signing": 0.1, "petition.live": 0.1, "petition.form": 0.3 },
  relations: [{ name: "no signer listed twice", fields: ["petition.recent"], check: (s) => !s.petition || new Set(s.petition.recent.map((r: { id: number }) => r.id)).size === s.petition.recent.length }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
