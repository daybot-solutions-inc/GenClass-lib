import type { AppManifest } from "../../src/shared/manifest.js";

const sequences = [
  { id: 31, name: "Trial nurture", status: "active" },
  { id: 32, name: "Webinar follow-up", status: "active" },
  { id: 33, name: "Win-back", status: "paused" },
];
const subj: Record<number, string[]> = { 31: ["Welcome to your trial", "3 tips for week one", "Your trial ends soon"], 32: ["Thanks for joining", "Slides and recording", "Book a demo"], 33: ["We miss you", "What's new since you left", "A gift to come back"] };
const steps: Record<string, unknown>[] = [];
for (const s of sequences) subj[s.id]!.forEach((subject, i) => steps.push({ id: s.id * 10 + i, sequenceId: s.id, order: i + 1, subject, delayDays: [0, 3, 7][i] }));
const contacts = ["Amara Okafor", "Bruno Silva", "Chen Wei", "Dana Kowalski", "Eitan Levi", "Freya Lund", "Gita Rao", "Hugo Marchand"].map((name, i) => ({ id: 400 + i, name, company: ["Acme", "Globex", "Initech", "Umbrella"][i % 4] }));
const enrollments = [{ id: 1, key: "31-400", sequenceId: 31, contactId: 400 }, { id: 2, key: "32-403", sequenceId: 32, contactId: 403 }];

const manifest: AppManifest = {
  name: "zustand-sequences",
  title: "Email sequences",
  framework: "react",
  libs: ["react", "zustand", "genclass(zustand)", "fetch"],
  domain: "crm-email-sequences",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "sequences", seed: sequences, envelope: "items" },
      { name: "steps", seed: steps, filters: ["sequenceId"], envelope: "items", required: ["subject"] },
      { name: "contacts", seed: contacts, envelope: "items" },
      { name: "enrollments", seed: enrollments, filters: ["sequenceId"], unique: ["key"], required: ["key"], envelope: "items", pageSize: 50 },
    ],
  },
  variants: {
    enrollGuard: ["disable", "none"],
    enrollWait: ["allSettled", "all"],
    seqLoad: ["latest", "blind"],
    subjectSave: ["debounced", "per-keystroke"],
    enrolledCount: ["derive", "manual"],
  },
  affordances: [
    { id: "sequence", kind: "click", sel: "nav.sequences button", text: ["Trial nurture", "Webinar follow-up", "Win-back"], weight: 2, mode: "replace", key: "seq" },
    { id: "contact", kind: "check", sel: "li.contact input.pick", nth: 8, weight: 3, mode: "accumulate", intent: "nth" },
    { id: "enroll", kind: "click", sel: "button.enroll", weight: 2, mode: "accumulate", requires: "button.enroll:not([disabled])", dblclickP: 0.15, impatientP: 0.25 },
    { id: "subject", kind: "type", sel: "li.step input.subject", nth: 3, values: [" (reminder)", " today", "!"], weight: 2, mode: "replace", intent: "nth", key: "subject", requires: "li.step input.subject" },
    { id: "pause", kind: "click", sel: "button.status", weight: 0.8, mode: "accumulate", dblclickP: 0.12 },
  ],
  external: [{ kind: "create", target: "enrollments", perMin: 1.5, data: [{ key: "31-405", sequenceId: 31, contactId: 405 }, { key: "32-401", sequenceId: 32, contactId: 401 }, { key: "31-406", sequenceId: 31, contactId: 406 }] }],
  weights: { "sequences.error": 0, "sequences.notice": 0, "sequences.busy": 0.1, "sequences.loading": 0.1, "sequences.picked": 0.3 },
  relations: [
    { name: "enrolled count = enrollments", fields: ["sequences.enrolledCount", "sequences.enrolled"], check: (s) => !s.sequences || s.sequences.loading || s.sequences.enrolledCount === s.sequences.enrolled.length },
    { name: "steps belong to the open sequence", fields: ["sequences.steps", "sequences.current"], check: (s) => !s.sequences || s.sequences.loading || s.sequences.steps.every((x: { sequenceId: number }) => x.sequenceId === s.sequences.current) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
