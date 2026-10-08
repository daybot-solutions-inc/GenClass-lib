import type { AppManifest } from "../../src/shared/manifest.js";

const items: [string, string, number][] = [
  ["Trail running shoes", "SHO-221", 129], ["Rain shell jacket", "JKT-104", 189], ["Wool socks (3-pack)", "SOC-033", 24], ["Daypack 22L", "BAG-310", 89],
  ["Insulated bottle", "BTL-012", 35], ["Fleece hoodie", "FLC-118", 79], ["Headlamp", "LMP-007", 45], ["Hiking poles", "POL-090", 110],
];
const customers = ["J. Ortiz", "M. Chen", "A. Kowalski", "S. Patel", "R. Haddad", "L. Svensson"];
const statuses = ["awaiting", "awaiting", "received", "awaiting", "inspected", "received", "awaiting", "received", "refunded", "awaiting", "received", "awaiting", "inspected", "awaiting", "received", "awaiting"];
const rmas = statuses.map((status, i) => {
  const [item, sku, price] = items[i % items.length]!;
  return { id: 2600 + i, rma: `RMA-${1040 + i}`, customer: customers[i % 6], item, sku, price, reason: ["too small", "defective", "changed mind", "wrong item"][i % 4], status, condition: status === "inspected" || status === "refunded" ? ["new", "opened"][i % 2] : "" };
});

const manifest: AppManifest = {
  name: "mithril-returns",
  title: "Returns desk",
  framework: "mithril",
  libs: ["mithril", "m.request(XHR)", "rt.atom"],
  domain: "returns-processing",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "rmas", seed: rmas, versioned: true, filters: ["status", "rma"], envelope: "data", pageSize: 6 },
      { name: "refunds", seed: [], required: ["rmaId", "amount"], envelope: "data" },
    ],
  },
  variants: {
    scanSeq: ["latest", "blind"],
    refundKey: ["idempotency-key", "none"],
    refundGuard: ["pending", "none"],
    tabSeq: ["latest", "blind"],
    refundedTotal: ["derive", "incremental"],
  },
  affordances: [
    { id: "tab", kind: "click", sel: "nav.tabs button", text: ["All", "All", "Awaiting", "Received", "Inspected"], weight: 1, mode: "replace", key: "tab" },
    { id: "page", kind: "click", sel: "nav.pages button", nth: 3, weight: 0.8, mode: "replace", key: "tab" },
    { id: "scan", kind: "type", sel: "input[name=scan]", values: ["RMA-1040", "RMA-1043", "RMA-1046", "RMA-1049", "RMA-1051", "RMA-1053"], clear: true, enter: true, weight: 2, mode: "accumulate", intent: "value" },
    { id: "receive", kind: "click", sel: "tr.rma button.receive", nth: 6, weight: 1, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "tr.rma button.receive" },
    { id: "condition", kind: "select", sel: "tr.rma select.condition", nth: 6, values: ["new", "opened", "damaged"], weight: 2.5, mode: "accumulate", intent: "nth", requires: "tr.rma select.condition" },
    { id: "refund", kind: "click", sel: "tr.rma button.refund", nth: 6, weight: 2.5, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.25, requires: "tr.rma button.refund" },
  ],
  external: [
    { kind: "create", target: "rmas", perMin: 2, data: [{ rma: "RMA-1090", customer: "D. Nguyen", item: "Rain shell jacket", sku: "JKT-104", price: 189, reason: "too big", status: "awaiting", condition: "" }, { rma: "RMA-1091", customer: "E. Brown", item: "Headlamp", sku: "LMP-007", price: 45, reason: "defective", status: "awaiting", condition: "" }] },
    { kind: "update", target: "rmas", perMin: 2, where: { status: "awaiting" }, data: [{ status: "received" }] },
  ],
  weights: { "desk.error": 0, "desk.notice": 0, "desk.loading": 0.1, "desk.pending": 0.1, "scan.looking": 0.1, "scan.code": 0.3 },
  relations: [
    { name: "refunded total = refunds issued", fields: ["desk.refunded", "desk.refunds"], check: (s) => !s.desk || s.desk.refunded === s.desk.refunds.reduce((a: number, r: { amount: number }) => a + r.amount, 0) },
    { name: "rows belong to the tab", fields: ["desk.rows", "desk.tab"], check: (s) => !s.desk || s.desk.loading || s.desk.tab === "all" || s.desk.rows.every((r: { id: number; status: string }) => r.status === s.desk.tab || s.desk.pending.includes(r.id)) },
    { name: "the scanned RMA is the one typed", fields: ["scan.match", "scan.code"], check: (s) => !s.scan || s.scan.looking || !s.scan.match || s.scan.match.rma === s.scan.code },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
