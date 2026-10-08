import type { AppManifest } from "../../src/shared/manifest.js";

const people: [string, string, number][] = [["Adaeze Nwosu", "warehouse", 24], ["Bilal Khan", "warehouse", 22], ["Carmen Diaz", "drivers", 27], ["Dmitri Volkov", "drivers", 26], ["Elif Demir", "office", 31], ["Felix Wagner", "office", 29], ["Grace Mensah", "warehouse", 23]];
const sheets: Record<string, unknown>[] = [];
let id = 5000;
for (const period of ["2026-09-A", "2026-09-B", "2026-10-A"])
  people.forEach(([name, team, rate], i) => sheets.push({ id: id++, period, name, team, rate, hours: 60 + ((i * 9 + period.length) % 25), status: period === "2026-09-A" ? "approved" : i % 3 === 2 ? "flagged" : "submitted" }));

const manifest: AppManifest = {
  name: "rtk-payroll",
  title: "Payroll approvals",
  framework: "react",
  libs: ["react", "@reduxjs/toolkit", "react-redux", "createAsyncThunk", "genclassEnhancer", "axios"],
  domain: "payroll-approvals",
  entry: "main.tsx",
  integration: "stores",
  server: { base: "/api", collections: [{ name: "timesheets", seed: sheets, versioned: true, filters: ["period", "team", "status"], envelope: "items", pageSize: 40 }] },
  variants: {
    periodGuard: ["requestId", "none"],
    approveGuard: ["pending", "none"],
    conflict: ["refetch", "force"],
    total: ["selector", "stored"],
    pollMs: [6000, 4000],
  },
  affordances: [
    { id: "period", kind: "select", sel: "select[name=period]", values: ["2026-09-A", "2026-09-B", "2026-10-A"], weight: 1.5, mode: "replace" },
    { id: "approve", kind: "click", sel: "tr.sheet button.approve", nth: 5, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.25, requires: "tr.sheet button.approve" },
    { id: "reject", kind: "click", sel: "tr.sheet button.reject", nth: 5, weight: 1.2, mode: "accumulate", intent: "nth", requires: "tr.sheet button.reject" },
    { id: "approveAll", kind: "click", sel: "button.approve-all", weight: 0.8, mode: "accumulate", requires: "button.approve-all:not([disabled])", dblclickP: 0.1 },
  ],
  external: [
    { kind: "update", target: "timesheets", perMin: 2.5, where: { status: "submitted" }, data: [{ hours: 72 }, { hours: 80 }, { status: "flagged" }] },
    { kind: "update", target: "timesheets", perMin: 1, where: { status: "flagged" }, data: [{ status: "submitted" }] },
  ],
  weights: { "payroll.error": 0, "payroll.notice": 0, "payroll.loading": 0.1, "payroll.pending": 0.1 },
  relations: [
    { name: "approved payroll total", fields: ["payroll.approvedTotal", "payroll.sheets"], check: (s) => !s.payroll || s.payroll.loading || s.payroll.approvedTotal === s.payroll.sheets.filter((x: { status: string }) => x.status === "approved").reduce((a: number, x: { hours: number; rate: number }) => a + x.hours * x.rate, 0) },
    { name: "sheets belong to the period", fields: ["payroll.sheets", "payroll.period"], check: (s) => !s.payroll || s.payroll.loading || s.payroll.sheets.every((x: { period: string }) => x.period === s.payroll.period) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
