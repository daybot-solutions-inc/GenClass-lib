import type { AppManifest } from "../../src/shared/manifest.js";

const cats: [string, number][] = [["Groceries", 600], ["Transport", 180], ["Eating out", 150], ["Utilities", 220], ["Fun", 120]];
const envelopes: Record<string, unknown>[] = [];
const expenses: Record<string, unknown>[] = [];
let eid = 900;
["2026-09", "2026-10"].forEach((month, m) =>
  cats.forEach(([name, budget], i) => {
    const id = 50 + m * 10 + i;
    envelopes.push({ id, month, name, budget });
    for (let k = 0; k < 2 + (i % 2); k++) expenses.push({ id: eid++, month, envelopeId: id, note: `${name} #${k + 1}`, amount: 12 + ((i * 17 + k * 23 + m * 5) % 60) });
  }),
);

const manifest: AppManifest = {
  name: "mithril-envelopes",
  title: "Budget envelopes",
  framework: "mithril",
  libs: ["mithril", "m.request(XHR)", "rt.atom"],
  domain: "budget-envelopes",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "envelopes", seed: envelopes, filters: ["month"], envelope: "items", pageSize: 20 },
      { name: "expenses", seed: expenses, filters: ["month", "envelopeId"], envelope: "items", pageSize: 100, required: ["amount", "envelopeId"] },
    ],
  },
  variants: {
    spent: ["derive", "cached"],
    addGuard: ["disable", "none"],
    retryKey: ["idempotency-key", "none"],
    transfer: ["compensate", "none"],
    monthSeq: ["latest", "blind"],
  },
  affordances: [
    { id: "month", kind: "select", sel: "select[name=month]", values: ["2026-09", "2026-10"], weight: 1, mode: "replace" },
    { id: "envelope", kind: "select", sel: "select[name=envelope]", values: ["Groceries", "Transport", "Eating out", "Utilities", "Fun"], weight: 1, mode: "replace" },
    { id: "amount", kind: "type", sel: "input[name=amount]", values: ["12.50", "40", "7.20", "65"], clear: true, weight: 2.5, mode: "replace", then: ["add"] },
    { id: "add", kind: "click", sel: "form.expense button[type=submit]", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.18, impatientP: 0.25 },
    { id: "move", kind: "click", sel: "li.env button.move", nth: 5, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.12 },
  ],
  external: [{ kind: "create", target: "expenses", perMin: 2.5, data: [{ month: "2026-10", envelopeId: 60, note: "Partner: market", amount: 23 }, { month: "2026-10", envelopeId: 62, note: "Partner: pizza", amount: 31 }, { month: "2026-09", envelopeId: 51, note: "Partner: bus pass", amount: 18 }] }],
  weights: { "budget.error": 0, "budget.notice": 0, "budget.adding": 0.1, "budget.loading": 0.1, "budget.amount": 0.3 },
  relations: [
    { name: "spent = sum of envelope expenses", fields: ["budget.spent", "budget.expenses"], check: (s) => { const b = s.budget; if (!b || b.loading) return true; return b.envelopes.every((e: { id: number }) => Math.round((b.spent[e.id] ?? 0) * 100) === Math.round(b.expenses.filter((x: { envelopeId: number }) => x.envelopeId === e.id).reduce((a: number, x: { amount: number }) => a + Number(x.amount), 0) * 100)); } },
    { name: "envelopes belong to the month", fields: ["budget.envelopes", "budget.month"], check: (s) => !s.budget || s.budget.loading || s.budget.envelopes.every((e: { month: string }) => e.month === s.budget.month) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
