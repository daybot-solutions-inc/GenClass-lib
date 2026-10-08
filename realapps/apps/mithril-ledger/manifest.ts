import type { AppManifest } from "../../src/shared/manifest.js";

const seed: [string, string, string, number][] = [
  ["Opening cash from owner", "1000", "3000", 5000],
  ["March rent", "5100", "1000", 1800],
  ["Flour and butter, Millbrook Supply", "1200", "2000", 640.4],
  ["Weekend card sales", "1000", "4000", 2315.75],
  ["Wholesale order, Corner Café", "1100", "4000", 420],
  ["Part payment to Millbrook Supply", "2000", "1000", 300],
  ["Paper bags and boxes", "5200", "1000", 86.2],
  ["Staff wages, week 13", "5300", "1000", 1240],
];
const entries = seed.map(([memo, debit, credit, amount], i) => ({ id: 9100 + i, memo, debit, credit, amount, voided: false, createdAt: new Date(Date.UTC(2026, 2, 3 + i * 3, 10, 0)).toISOString() }));

const manifest: AppManifest = {
  name: "mithril-ledger",
  title: "General journal",
  framework: "mithril",
  libs: ["mithril", "m.request(XHR)", "m.redraw", "rt.atom"],
  domain: "bookkeeping",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "entries", seed: entries, pageSize: 50, envelope: "items", required: ["memo", "amount"], actions: { void: { set: { voided: true } } } }],
  },
  variants: {
    submitGuard: ["disable", "none", "idem-key", "none"],
    totals: ["recompute", "incremental"],
    poll: ["skip-while-busy", "blind"],
  },
  affordances: [
    { id: "memo", kind: "type", sel: "input[name=memo]", values: ["Flour delivery", "Card sales batch", "Weekly wages", "April rent", "Owner top-up", "Coffee beans", "Café invoice paid"], weight: 4, mode: "replace", clear: true, then: ["amount", "debit", "credit", "post"] },
    { id: "amount", kind: "type", sel: "input[name=amount]", values: ["120.50", "86", "1450", "42.75", "300", "2210.40"], weight: 0, mode: "replace", clear: true, followOnly: true },
    { id: "debit", kind: "select", sel: "select[name=debit]", values: ["1000", "1200", "5100", "5200", "5300", "2000"], weight: 0, mode: "replace", followOnly: true },
    { id: "credit", kind: "select", sel: "select[name=credit]", values: ["1000", "4000", "2000", "3000", "1100"], weight: 0, mode: "replace", followOnly: true },
    { id: "post", kind: "click", sel: "button.post", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.25, impatientP: 0.25 },
    { id: "void", kind: "click", sel: ".entry button.void", nth: 6, intent: "nth", weight: 1, mode: "accumulate", dblclickP: 0.2 },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.5, mode: "replace", dblclickP: 0.1 },
  ],
  external: [
    // the second bookkeeper entering receipts from the shop
    {
      kind: "create",
      target: "entries",
      perMin: 1.5,
      data: [
        { memo: "Till takings, morning", debit: "1000", credit: "4000", amount: 380.25, voided: false },
        { memo: "Eggs, Hillside Farm", debit: "1200", credit: "2000", amount: 96, voided: false },
        { memo: "Cleaning supplies", debit: "5200", credit: "1000", amount: 34.6, voided: false },
      ],
    },
  ],
  weights: { "journal.memo": 0.3, "journal.amount": 0.3, "journal.debit": 0.3, "journal.credit": 0.3, "journal.error": 0, "ledger.posting": 0.1, "ledger.loaded": 0.1, "ledger.notice": 0.1, "ledger.error": 0 },
  relations: [
    {
      name: "totalDebits == sum(entries.amount where not voided)",
      fields: ["ledger.totalDebits", "ledger.entries"],
      check: (s) => !s.ledger || !Array.isArray(s.ledger.entries) || !s.ledger.loaded || Math.abs(s.ledger.totalDebits - s.ledger.entries.reduce((a: number, e: { amount: number; voided?: boolean }) => a + (e.voided ? 0 : Number(e.amount) || 0), 0)) < 0.01,
    },
    {
      name: "trial balance nets to zero",
      fields: ["ledger.balances", "ledger.entries"],
      check: (s) => !s.ledger || !s.ledger.balances || Math.abs(Object.values(s.ledger.balances as Record<string, number>).reduce((a, b) => a + Number(b), 0)) < 0.01,
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [30000, 70000],
};
export default manifest;
