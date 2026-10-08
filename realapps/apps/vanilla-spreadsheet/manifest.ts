import type { AppManifest } from "../../src/shared/manifest.js";
import { evaluate, sameVal, type Val } from "./formula";

const rows: [string, number, number, number][] = [
  ["Rent", 4200, 4200, 4350],
  ["Payroll", 18500, 18500, 19200],
  ["Software", 1240, 1310, 1295],
  ["Travel", 860, 2150, 640],
  ["Marketing", 3000, 3500, 2750],
];
const cells: { id: string; raw: string }[] = [];
rows.forEach(([label, b, c, d], i) => {
  const r = i + 1;
  cells.push({ id: `A${r}`, raw: label }, { id: `B${r}`, raw: String(b) }, { id: `C${r}`, raw: String(c) }, { id: `D${r}`, raw: String(d) }, { id: `E${r}`, raw: `=SUM(B${r}:D${r})` });
});
cells.push({ id: "A6", raw: "Total" }, { id: "B6", raw: "=SUM(B1:B5)" }, { id: "C6", raw: "=SUM(C1:C5)" }, { id: "D6", raw: "=SUM(D1:D5)" }, { id: "E6", raw: "=SUM(E1:E5)" });
cells.push({ id: "A7", raw: "Monthly avg" }, { id: "B7", raw: "=AVG(B1:B5)" }, { id: "C7", raw: "=AVG(C1:C5)" }, { id: "D7", raw: "=AVG(D1:D5)" }, { id: "E7", raw: "=E6/3" });

type C = Record<string, { raw: string; v: Val }>;
const formulasConsistent = (cs: C) => Object.values(cs).every((c) => !c.raw.startsWith("=") || sameVal(c.v, evaluate(c.raw, (id) => cs[id]?.v ?? "")));

const manifest: AppManifest = {
  name: "vanilla-spreadsheet",
  title: "FY26 Q1 budget",
  framework: "vanilla",
  libs: ["fetch", "rt.atom"],
  domain: "finance",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "cells", seed: cells, idStyle: "slug", envelope: "bare", pageSize: 100 }],
  },
  variants: {
    saveMode: ["serial", "fire"],
    echo: ["if-latest", "apply", "apply"],
    recompute: ["full", "direct-only"],
    pollMerge: ["skip-pending", "overwrite"],
    pollMs: [4000, 2000],
  },
  affordances: [
    { id: "select", kind: "click", sel: "td.cell.num", nth: 15, weight: 3, mode: "replace", intent: "nth", then: ["edit"] },
    { id: "selectFormula", kind: "click", sel: "td.cell.formula", nth: 9, weight: 0.6, mode: "replace", intent: "nth" },
    { id: "edit", kind: "type", sel: "input.formula", key: "cell", values: ["4500", "980", "12000", "2750", "1500", "0", "=B2*1.05", "=SUM(B1:B3)"], weight: 0, mode: "replace", clear: true, enter: true, followOnly: true },
    { id: "reedit", kind: "type", sel: "input.formula", key: "cell", values: ["4600", "990", "1250", "3100", "20000"], weight: 1.4, mode: "replace", clear: true, enter: true, after: ["select", "selectFormula"] },
    { id: "undo", kind: "click", sel: "button.undo", weight: 0.6, mode: "accumulate", after: ["select"], dblclickP: 0.12 },
    { id: "recalc", kind: "click", sel: "button.recalc", weight: 0.4, mode: "replace" },
    { id: "sync", kind: "click", sel: "button.sync", weight: 0.5, mode: "replace", impatientP: 0.15 },
  ],
  external: [{ kind: "update", target: "cells", perMin: 3, data: [{ raw: "4400" }, { raw: "2100" }, { raw: "19800" }, { raw: "905" }, { raw: "3300" }] }],
  weights: { "sheet.draft": 0.3, "sheet.pending": 0.1, "sheet.error": 0, "sheet.sel": 0.2 },
  relations: [{ name: "every formula shows its computed value", fields: ["sheet.cells"], check: (s) => !s.sheet || formulasConsistent(s.sheet.cells) }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
