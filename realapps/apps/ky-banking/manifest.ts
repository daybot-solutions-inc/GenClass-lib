import type { AppManifest } from "../../src/shared/manifest.js";

const accounts = [
  { id: "chk", name: "Everyday checking", opening: 240000 },
  { id: "sav", name: "Savings", opening: 800000 },
  { id: "joint", name: "Joint account", opening: 120000 },
];
const payees = [
  { id: "landlord", name: "Landlord (Oak St)" },
  { id: "power", name: "City Power" },
  { id: "gym", name: "Pulse Gym" },
];
const flows: [string, string, number, string][] = [
  ["ext", "chk", 320000, "Salary March"],
  ["chk", "landlord", 145000, "Rent March"],
  ["chk", "sav", 50000, "Monthly saving"],
  ["joint", "power", 6420, "City Power"],
  ["ext", "joint", 40000, "Partner deposit"],
  ["chk", "gym", 3900, "Pulse Gym"],
  ["sav", "chk", 20000, "Top-up"],
  ["chk", "joint", 30000, "Groceries pot"],
];
const transfers = flows.map(([from, to, amount, memo], i) => ({ id: 5200 + i, from, to, amount, memo, date: `2026-03-${String(3 + i * 3).padStart(2, "0")}` }));

type A = { id: string; opening: number; balance: number };
type T = { from: string; to: string; amount: number };

const manifest: AppManifest = {
  name: "ky-banking",
  title: "Online banking",
  framework: "react",
  libs: ["react", "ky", "ky retry/timeout/hooks", "Idempotency-Key", "rt.atom", "useAtom"],
  domain: "banking",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "accounts", seed: accounts, envelope: "bare", idStyle: "slug" },
      { name: "payees", seed: payees, envelope: "bare", idStyle: "slug" },
      { name: "transfers", seed: transfers, envelope: "items", pageSize: 200, required: ["from", "to", "amount"] },
    ],
  },
  variants: {
    retry: ["get-only", "post-on-timeout", "post-on-timeout"],
    idemKey: ["per-review", "none"],
    balance: ["refetch", "derive"],
    confirmGuard: ["disable", "none"],
  },
  affordances: [
    { id: "from", kind: "select", sel: "select[name=from]", values: ["chk", "sav", "joint"], weight: 1, mode: "replace" },
    { id: "to", kind: "select", sel: "select[name=to]", values: ["sav", "joint", "chk", "landlord", "power", "gym"], weight: 1.5, mode: "replace" },
    { id: "amount", kind: "type", sel: "input[name=amount]", values: ["25", "120", "60.50", "300", "15", "42.99"], weight: 3, mode: "replace", clear: true, then: ["review", "confirm"] },
    { id: "review", kind: "click", sel: "button.review", weight: 0, mode: "replace", followOnly: true, key: "review" },
    { id: "confirm", kind: "click", sel: "section.review-panel button.confirm", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.35 },
    { id: "confirmAgain", kind: "click", sel: "section.review-panel button.confirm", weight: 1, mode: "accumulate", requires: "section.review-panel button.confirm", dblclickP: 0.1, impatientP: 0.2 },
    { id: "cancel", kind: "click", sel: "section.review-panel button.cancel", weight: 0.4, mode: "replace", key: "review", requires: "section.review-panel button.cancel" },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.5, mode: "replace" },
  ],
  external: [
    { kind: "create", target: "transfers", perMin: 1.5, data: [{ from: "ext", to: "joint", amount: 15000, memo: "Partner deposit", date: "2026-04-01" }, { from: "joint", to: "power", amount: 6400, memo: "City Power (autopay)", date: "2026-04-01" }, { from: "ext", to: "chk", amount: 2500, memo: "Refund", date: "2026-04-01" }] },
  ],
  weights: { "bank.form": 0.3, "bank.review": 0.3, "bank.sending": 0.1, "bank.retrying": 0.1, "bank.error": 0, "bank.notice": 0.2 },
  relations: [
    {
      name: "balance == opening + inflows - outflows",
      fields: ["bank.accounts", "bank.transfers"],
      check: (s) => !s.bank || s.bank.accounts.every((a: A) => a.balance === a.opening + s.bank.transfers.reduce((x: number, t: T) => x + (t.to === a.id ? t.amount : 0) - (t.from === a.id ? t.amount : 0), 0)),
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
