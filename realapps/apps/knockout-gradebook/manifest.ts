import type { AppManifest } from "../../src/shared/manifest.js";

const students: Record<string, string[]> = { "9A": ["Ava", "Ben", "Chloe", "Dara"], "9B": ["Eli", "Fatima", "Gus", "Hiro"], "10A": ["Ines", "Jack", "Kofi", "Lena"] };
const grades: Record<string, unknown>[] = [];
let id = 300;
Object.entries(students).forEach(([section, names], s) =>
  names.forEach((student, i) => ["Essay", "Quiz", "Lab"].forEach((assignment, a) => grades.push({ id: id++, section, student, assignment, score: 55 + ((i * 13 + a * 7 + s * 5) % 45) }))),
);

const manifest: AppManifest = {
  name: "knockout-gradebook",
  title: "Gradebook",
  framework: "knockout",
  libs: ["knockout", "fetch", "rt.guard"],
  domain: "school-gradebook",
  entry: "main.ts",
  integration: "stores",
  server: { base: "/api", collections: [{ name: "grades", seed: grades, versioned: true, filters: ["section", "student"], envelope: "items", pageSize: 50 }] },
  variants: {
    autosave: ["per-cell-queue", "parallel"],
    conflict: ["reload", "overwrite"],
    sectionSeq: ["latest", "blind"],
    average: ["computed", "on-save"],
    poll: ["pending-aware", "blind"],
  },
  affordances: [
    { id: "section", kind: "select", sel: "select[name=section]", values: ["9A", "9B", "10A"], weight: 1.2, mode: "replace" },
    { id: "score", kind: "type", sel: "td.cell input.score", nth: 12, values: ["85", "92", "7", "100", "64", "78"], clear: true, weight: 4, mode: "replace", intent: "nth", key: "score" },
    { id: "publish", kind: "click", sel: "button.publish", weight: 0.8, mode: "accumulate", dblclickP: 0.12, impatientP: 0.2 },
  ],
  external: [{ kind: "update", target: "grades", perMin: 3, where: { section: "9A" }, data: [{ score: 88 }, { score: 71 }, { score: 95 }, { score: 60 }] }],
  weights: { "gradebook.error": 0, "gradebook.notice": 0, "gradebook.saving": 0.1, "gradebook.loading": 0.1 },
  relations: [
    {
      name: "class averages match the scores",
      fields: ["gradebook.averages", "gradebook.cells"],
      check: (s) => {
        const g = s.gradebook;
        if (!g || g.loading) return true;
        return ["Essay", "Quiz", "Lab"].every((a) => {
          const xs = g.cells.filter((c: { assignment: string }) => c.assignment === a).map((c: { score: number }) => c.score);
          return !xs.length || g.averages[a] === Math.round(xs.reduce((p: number, q: number) => p + q, 0) / xs.length);
        });
      },
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
