import type { AppManifest } from "../../src/shared/manifest.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
type L = { lid: string; desc: string; qty: number; price: number };
const inv = (id: number, number: string, customer: string, taxRate: number, status: string, lines: [string, number, number][]) => {
  const ls: L[] = lines.map(([desc, qty, price], i) => ({ lid: `L${i + 1}`, desc, qty, price }));
  const subtotal = r2(ls.reduce((s, l) => s + l.qty * l.price, 0));
  const tax = r2(subtotal * taxRate);
  return { id, number, customer, taxRate, status, lines: ls, subtotal, tax, total: r2(subtotal + tax), notes: "" };
};
const invoices = [
  inv(4101, "INV-2026-031", "Harbor & Pine Architects", 0.08, "draft", [["Discovery workshop", 1, 1800], ["UX audit (per screen)", 12, 95], ["Travel", 1, 240.5]]),
  inv(4102, "INV-2026-032", "Kestrel Analytics", 0.2, "draft", [["Data pipeline review", 3, 1150], ["Dashboard build", 1, 4200]]),
  inv(4103, "INV-2026-033", "Bluebird Bakery Co.", 0, "sent", [["Website refresh", 1, 2600], ["Hosting (12 months)", 12, 18]]),
  inv(4104, "INV-2026-034", "Orchard Street Dental", 0.05, "draft", [["Booking widget integration", 1, 1350], ["Support hours", 6, 85]]),
  inv(4105, "INV-2026-035", "Meridian Freight", 0.08, "viewed", [["Route optimiser prototype", 1, 5400], ["Load testing", 2, 640], ["Training session", 1, 450]]),
];
const payments = [{ id: 610, invoiceId: 4103, amount: 1000, method: "bank transfer" }];

const sumLines = (ls: L[]) => r2(ls.reduce((s, l) => s + Number(l.qty) * Number(l.price), 0));

const manifest: AppManifest = {
  name: "knockout-invoices",
  title: "Ledgerly — Invoices",
  framework: "knockout",
  libs: ["knockout", "fetch", "rt.guard(ko view model)"],
  domain: "invoicing",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "invoices", seed: invoices, envelope: "items", versioned: true, pageSize: 50, actions: { send: { set: { status: "sent" } } } },
      { name: "payments", seed: payments, envelope: "items", filters: ["invoiceId"], required: ["invoiceId", "amount"] },
    ],
  },
  variants: {
    totals: ["computed", "manual"],
    autosave: ["serial", "overlap"],
    saveDelayMs: [800, 300, 1500],
    echo: ["version-only", "apply"],
    conflict: ["rebase", "overwrite", "reload"],
    switchGuard: ["token", "none"],
    payGuard: ["disable", "none"],
  },
  affordances: [
    { id: "open", kind: "click", sel: "button.open-invoice", nth: 5, weight: 1.4, mode: "replace", intent: "nth" },
    { id: "customer", kind: "type", sel: "input[name=customer]", values: ["Harbor & Pine LLP", "Kestrel Analytics GmbH", "Bluebird Bakery", "Meridian Freight Ltd"], weight: 0.9, mode: "replace", clear: true },
    { id: "qty", kind: "type", sel: "tr.line input.qty", nth: 3, values: ["2", "5", "12", "1", "40"], weight: 2.2, mode: "replace", intent: "nth", clear: true },
    { id: "price", kind: "type", sel: "tr.line input.price", nth: 3, values: ["19.99", "120", "7.50", "1450", "85"], weight: 2, mode: "replace", intent: "nth", clear: true },
    { id: "desc", kind: "type", sel: "tr.line input.desc", nth: 3, values: ["Design review", "Hosting (April)", "Onsite workshop", "Bug fixes"], weight: 0.7, mode: "replace", intent: "nth", clear: true },
    { id: "tax", kind: "select", sel: "select[name=tax]", values: ["0", "0.05", "0.08", "0.2"], weight: 0.8, mode: "replace" },
    { id: "addLine", kind: "click", sel: "button.add-line", weight: 0.9, mode: "accumulate", dblclickP: 0.1 },
    { id: "removeLine", kind: "click", sel: "tr.line button.remove-line", nth: 4, weight: 0.5, mode: "accumulate", intent: "nth" },
    { id: "send", kind: "click", sel: "button.send", weight: 0.4, mode: "accumulate", dblclickP: 0.1 },
    { id: "pay", kind: "click", sel: "button.pay", weight: 0.7, mode: "accumulate", dblclickP: 0.2, impatientP: 0.3 },
  ],
  external: [
    { kind: "update", target: "invoices", perMin: 1.5, data: [{ status: "viewed" }, { notes: "Customer asked for a PO number on the invoice." }, { notes: "Approved by finance." }, { status: "viewed", notes: "Opened by recipient." }] },
  ],
  weights: {
    "invoice.loading": 0.1,
    "invoice.saving": 0.1,
    "invoice.saveState": 0.1,
    "invoice.error": 0,
    "invoice.version": 0,
    "invoices.loading": 0.1,
  },
  relations: [
    { name: "subtotal == sum(qty*price)", fields: ["invoice.subtotal", "invoice.lines"], check: (s) => !s.invoice || s.invoice.loading || Math.abs(s.invoice.subtotal - sumLines(s.invoice.lines)) < 0.005 },
    { name: "total == subtotal + tax", fields: ["invoice.total", "invoice.subtotal", "invoice.tax"], check: (s) => !s.invoice || Math.abs(s.invoice.total - r2(s.invoice.subtotal + s.invoice.tax)) < 0.005 },
    { name: "tax == subtotal * rate", fields: ["invoice.tax", "invoice.subtotal", "invoice.taxRate"], check: (s) => !s.invoice || s.invoice.loading || Math.abs(s.invoice.tax - r2(s.invoice.subtotal * s.invoice.taxRate)) < 0.005 },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
