import type { AppManifest } from "../../src/shared/manifest.js";

const C: [string, string, string, [string, number][]][] = [
  ["CLM-2041", "Hannah Ortiz", "open", [["Windscreen replacement", 420], ["Courtesy car (3 days)", 135]]],
  ["CLM-2042", "Marcus Lee", "open", [["Burst pipe repair", 980], ["Carpet replacement", 1450], ["Drying equipment", 260]]],
  ["CLM-2043", "Priya Shah", "review", [["Laptop (theft)", 1299], ["Phone (theft)", 799]]],
  ["CLM-2044", "Tom Becker", "open", [["Rear bumper", 650], ["Paint", 310]]],
  ["CLM-2045", "Aisha Bello", "review", [["Roof tiles", 2100], ["Gutter", 340]]],
  ["CLM-2046", "Kenji Mori", "open", [["Bike (theft)", 890]]],
  ["CLM-2047", "Sofia Rossi", "closed", [["Water damage ceiling", 1320]]],
  ["CLM-2048", "Liam Walsh", "open", [["Fence panels", 480], ["Shed door", 220]]],
];
const claims = C.map(([ref, holder, status, lines], i) => ({ id: 2041 + i, ref, holder, status, lines: lines.map(([desc, amount]) => ({ desc, amount, ok: false })) }));

const manifest: AppManifest = {
  name: "preact-claims",
  title: "Claims desk",
  framework: "preact",
  libs: ["preact", "@preact/signals", "fetch", "rt.atom", "atomSignal"],
  domain: "insurance-claims",
  entry: "main.tsx",
  integration: "stores",
  server: { base: "/api", collections: [{ name: "claims", seed: claims, versioned: true, filters: ["status"], search: ["ref", "holder"], envelope: "results", pageSize: 30 }] },
  variants: {
    lineSave: ["queue", "parallel"],
    versionCheck: [true, false],
    decideGuard: ["disable", "none"],
    approvedTotal: ["derive", "increment"],
    listSeq: ["latest", "blind"],
  },
  affordances: [
    { id: "status", kind: "click", sel: "nav.queues button", text: ["Open", "Review", "Closed", "All"], weight: 1.2, mode: "replace", key: "queue" },
    { id: "open", kind: "click", sel: "li.claim button.open", nth: 5, weight: 3, mode: "replace", key: "claim" },
    { id: "line", kind: "check", sel: "section.claim input.line-ok", nth: 3, weight: 3.5, mode: "accumulate", intent: "nth", after: ["open"], requires: "section.claim input.line-ok", burst: [0, 1] },
    { id: "approve", kind: "click", sel: "section.claim button.approve", weight: 1.2, mode: "accumulate", after: ["open"], requires: "section.claim button.approve", dblclickP: 0.15, impatientP: 0.2 },
    { id: "refer", kind: "click", sel: "section.claim button.refer", weight: 0.6, mode: "accumulate", after: ["open"], requires: "section.claim button.refer" },
  ],
  external: [{ kind: "update", target: "claims", perMin: 2, where: { status: "review" }, data: [{ status: "open" }, { status: "closed" }] }],
  weights: { "claims.error": 0, "claims.loading": 0.1, "claim.error": 0, "claim.notice": 0, "claim.saving": 0.1, "claim.version": 0 },
  relations: [
    { name: "approved total = sum of approved lines", fields: ["claim.approved", "claim.lines"], check: (s) => !s.claim || s.claim.approved === s.claim.lines.reduce((a: number, l: { ok: boolean; amount: number }) => a + (l.ok ? l.amount : 0), 0) },
    { name: "list shows the chosen queue", fields: ["claims.items", "claims.queue"], check: (s) => !s.claims || s.claims.loading || s.claims.queue === "all" || s.claims.items.every((c: { status: string }) => c.status === s.claims.queue) },
  ],
  errorSelector: "[role=alert]",
  build: { jsx: "preact" },
  sessionMs: [25000, 60000],
};
export default manifest;
