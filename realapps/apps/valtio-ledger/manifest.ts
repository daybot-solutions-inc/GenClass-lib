import type { AppManifest } from "../../src/shared/manifest.js";

const CATS = ["groceries", "rent", "transport", "dining", "utilities", "fun"];
const rows: [string, string, number][] = [
  ["Rent March", "rent", 95000],
  ["Supermarket", "groceries", 6342],
  ["Metro card top-up", "transport", 3000],
  ["Thai takeaway", "dining", 2450],
  ["Water bill", "utilities", 3815],
  ["Concert tickets", "fun", 7800],
  ["Farmers market", "groceries", 2180],
  ["Taxi from airport", "transport", 4120],
  ["Internet", "utilities", 3999],
  ["Brunch", "dining", 3460],
  ["Supermarket", "groceries", 5409],
  ["Board game", "fun", 2999],
];
const expenses = rows.map(([desc, category, amount], i) => ({ id: 6100 + i, date: `2026-03-${String(2 + i * 2).padStart(2, "0")}`, desc, category, amount }));

type E = { category: string; amount: number };
const sumBy = (es: E[], c?: string) => es.filter((e) => !c || e.category === c).reduce((a, e) => a + e.amount, 0);

const manifest: AppManifest = {
  name: "valtio-ledger",
  title: "Household ledger",
  framework: "react",
  libs: ["react", "valtio", "immer", "fetch", "rt.guard"],
  domain: "personal-finance",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "expenses", seed: expenses, filters: ["category"], envelope: "data", pageSize: 200, required: ["desc", "amount"] }],
  },
  variants: {
    totals: ["recompute", "incremental", "incremental"],
    importMode: ["settled", "all"],
    importGuard: ["disable", "none"],
    refresh: ["skip-if-pending", "blind"],
  },
  affordances: [
    { id: "desc", kind: "type", sel: "input[name=desc]", values: ["Bakery", "Bus pass", "Pharmacy", "Pizza night", "Electric bill", "Cinema", "Hardware store"], weight: 3, mode: "replace", clear: true, then: ["amount", "add"] },
    { id: "amount", kind: "type", sel: "input[name=amount]", values: ["12.50", "4.20", "37.99", "60", "8.75", "23.10"], weight: 0, mode: "replace", clear: true, followOnly: true },
    { id: "add", kind: "click", sel: "form.add button.add", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.12, impatientP: 0.2 },
    { id: "category", kind: "select", sel: "form.add select[name=category]", values: CATS, weight: 0.8, mode: "replace" },
    { id: "recat", kind: "select", sel: "li.entry select.recat", nth: 8, values: CATS, weight: 2.5, mode: "accumulate", intent: "nth" },
    { id: "delete", kind: "click", sel: "li.entry button.delete", nth: 8, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.1 },
    { id: "import", kind: "click", sel: "button.import", weight: 1, mode: "accumulate", dblclickP: 0.2, impatientP: 0.3 },
    { id: "retry", kind: "click", sel: "button.retry-import", weight: 1.2, mode: "accumulate", after: ["import"], requires: "button.retry-import", dblclickP: 0.1 },
    { id: "filter", kind: "select", sel: "select[name=filter]", values: ["all", ...CATS], weight: 1, mode: "replace" },
  ],
  external: [
    { kind: "create", target: "expenses", perMin: 1.5, data: [{ date: "2026-03-28", desc: "Groceries (Sam)", category: "groceries", amount: 4210 }, { date: "2026-03-28", desc: "Fuel (Sam)", category: "transport", amount: 5500 }, { date: "2026-03-29", desc: "Dinner out (Sam)", category: "dining", amount: 6120 }] },
    { kind: "update", target: "expenses", perMin: 1, data: [{ category: "dining" }, { category: "groceries" }, { amount: 1999 }] },
    { kind: "delete", target: "expenses", perMin: 0.3 },
  ],
  weights: { "ledger.draft": 0.3, "ledger.filter": 0.3, "ledger.importing": 0.1, "ledger.saving": 0.1, "ledger.error": 0, "ledger.failedLines": 0.2 },
  relations: [
    { name: "total == sum(entries.amount)", fields: ["ledger.total", "ledger.entries"], check: (s) => !s.ledger || s.ledger.total === sumBy(s.ledger.entries) },
    { name: "byCategory == per-category sums", fields: ["ledger.byCategory", "ledger.entries"], check: (s) => !s.ledger || CATS.every((c) => (s.ledger.byCategory[c] ?? 0) === sumBy(s.ledger.entries, c)) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
