import type { AppManifest } from "../../src/shared/manifest.js";

const classes: [string, string[]][] = [
  ["p1", ["Amelia Chen", "Bruno Silva", "Chidi Okeke", "Dana Weiss", "Elif Demir", "Farid Rahimi", "Greta Lindholm", "Hamza Qureshi"]],
  ["p2", ["Iris Moreau", "Jakub Nowak", "Kalani Akana", "Leon Brandt", "Mira Kapoor", "Noor Haddad", "Oscar Lindgren", "Priya Iyer"]],
  ["p3", ["Quinn Murphy", "Rosa Delgado", "Samir Bensaid", "Tara Byrne", "Umar Sheikh", "Valentina Greco", "Wren Fletcher", "Yusuf Arslan"]],
];
const attendance = classes.flatMap(([period, students], p) =>
  students.map((student, i) => ({ id: 6000 + p * 20 + i, period, student, status: p === 1 && i % 3 === 0 ? "present" : "unmarked", slip: "" })),
);

const manifest: AppManifest = {
  name: "petite-attendance",
  title: "Class attendance",
  framework: "petite-vue",
  libs: ["petite-vue", "fetch", "WebSocket", "rt.atom(reactive mirror)"],
  domain: "class-attendance",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "attendance", seed: attendance, versioned: true, live: true, filters: ["period", "status"], envelope: "items", pageSize: 40 }],
  },
  variants: {
    periodSeq: ["latest", "blind"],
    mark: ["serial-per-student", "parallel"],
    bulk: ["per-item", "assume-all"],
    live: ["version-check", "blind"],
    counts: ["derive", "incremental"],
  },
  affordances: [
    { id: "period", kind: "select", sel: "select[name=period]", values: ["p1", "p2", "p3"], weight: 1.2, mode: "replace" },
    { id: "mark", kind: "select", sel: "li.student select.status", nth: 8, values: ["present", "present", "late", "absent"], weight: 4, mode: "replace", intent: "nth", key: "mark" },
    { id: "remark", kind: "select", sel: "li.student select.status", nth: 8, values: ["late", "absent"], weight: 1.2, mode: "replace", intent: "nth", key: "mark", then: ["fix"] },
    { id: "fix", kind: "select", sel: "li.student select.status", values: ["present"], weight: 0, mode: "replace", intent: "nth", key: "mark", sameNth: true, followOnly: true },
    { id: "restPresent", kind: "click", sel: "button.rest-present", weight: 0.8, mode: "accumulate", dblclickP: 0.1, impatientP: 0.2, requires: "button.rest-present:not([disabled])" },
  ],
  external: [
    {
      kind: "update",
      target: "attendance",
      perMin: 6,
      where: { status: { $in: ["unmarked", "absent"] } },
      data: [{ status: "late", slip: "slip 08:52" }, { status: "late", slip: "slip 09:05" }, { status: "late", slip: "slip 09:20" }],
    },
  ],
  weights: { "roll.error": 0, "roll.notice": 0, "roll.loading": 0.1, "roll.pending": 0.1, "roll.bulkBusy": 0.1, "roll.live": 0 },
  relations: [
    {
      name: "counts = statuses on the roll",
      fields: ["roll.counts", "roll.rows"],
      check: (s) => !s.roll || s.roll.loading || ["present", "late", "absent", "unmarked"].every((k) => s.roll.counts[k] === s.roll.rows.filter((r: { status: string }) => r.status === k).length),
    },
    { name: "rows belong to the period", fields: ["roll.rows", "roll.period"], check: (s) => !s.roll || s.roll.loading || s.roll.rows.every((r: { period: string }) => r.period === s.roll.period) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
