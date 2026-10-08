import type { AppManifest } from "../../src/shared/manifest.js";

const CAP = 4;
const drives: [number, string[]][] = [
  [41, ["Amara Osei", "Bilal Haddad", "Chloe Martin", "Dev Patel", "Elena Rossi", "Femi Adeyemi"]],
  [42, ["Grace Liu", "Hugo Brandt", "Isla Murray", "Jonah Weiss", "Keiko Sato", "Luis Romero"]],
  [43, ["Maya Cohen", "Nils Berg", "Olga Ivanova", "Pablo Ruiz", "Quinn Hart", "Rana Aziz"]],
];
const times = ["09:00", "09:40", "10:20", "11:00", "13:30", "14:10"];
const slots = drives.flatMap(([drive, nurses], d) => nurses.map((nurse, i) => ({ id: 700 + d * 10 + i, drive, time: times[i], nurse, capacity: CAP, booked: (i * 3 + d * 2) % 5 })));

const manifest: AppManifest = {
  name: "knockout-blooddrive",
  title: "Blood drive booking",
  framework: "knockout",
  libs: ["knockout", "ko.pureComputed", "fetch", "rt.guard"],
  domain: "blood-donation-drive",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "slots", seed: slots, filters: ["drive"], envelope: "data", pageSize: 20, actions: { book: { inc: "booked", by: 1 }, unbook: { inc: "booked", by: -1 } } },
      { name: "appointments", seed: [], unique: ["key"], required: ["donor", "slotId"], filters: ["donor", "drive"], envelope: "data" },
    ],
  },
  variants: {
    steps: ["rollback", "dangling"],
    bookGuard: ["pending", "none"],
    poll: ["pending-aware", "blind"],
    slotSeq: ["latest", "blind"],
    remaining: ["derive", "incremental"],
  },
  affordances: [
    { id: "drive", kind: "select", sel: "select[name=drive]", values: ["41", "42", "43"], weight: 2, mode: "replace" },
    { id: "answer", kind: "check", sel: "section.eligibility li.answer input:not(:checked)", nth: 1, weight: 0.6, mode: "accumulate", requires: "section.eligibility li.answer input:not(:checked)", then: ["answer2", "answer3", "next"] },
    { id: "answer2", kind: "check", sel: "section.eligibility li.answer input:not(:checked)", nth: 1, weight: 0, mode: "accumulate", followOnly: true, requires: "section.eligibility li.answer input:not(:checked)" },
    { id: "answer3", kind: "check", sel: "section.eligibility li.answer input:not(:checked)", nth: 1, weight: 0, mode: "accumulate", followOnly: true, requires: "section.eligibility li.answer input:not(:checked)" },
    { id: "next", kind: "click", sel: "section.eligibility button.next", weight: 0.4, mode: "replace", after: ["answer"], requires: "section.eligibility button.next:not([disabled])" },
    { id: "book", kind: "click", sel: "li.slot button.book", nth: 6, weight: 3.5, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.25, after: ["answer", "next"], requires: "li.slot button.book:not([disabled])" },
    { id: "cancel", kind: "click", sel: "li.appt button.cancel", nth: 2, weight: 1.4, mode: "accumulate", intent: "nth", dblclickP: 0.1, after: ["book"], requires: "li.appt button.cancel:not([disabled])" },
  ],
  external: [
    { kind: "action", target: "slots", perMin: 8, verb: "book", where: { booked: { $lt: CAP } } },
    { kind: "action", target: "slots", perMin: 2.5, verb: "unbook", where: { booked: { $gt: 0 } } },
  ],
  weights: { "donor.error": 0, "donor.notice": 0, "donor.loading": 0.1, "donor.booking": 0.1, "donor.cancelling": 0.1, "donor.answers": 0.3 },
  relations: [
    {
      name: "open chairs = chairs left in the listed slots",
      fields: ["donor.remaining", "donor.slots"],
      check: (s) => !s.donor || s.donor.loading || s.donor.remaining === s.donor.slots.reduce((a: number, x: { capacity: number; booked: number }) => a + Math.max(0, x.capacity - x.booked), 0),
    },
    { name: "slots belong to the chosen drive", fields: ["donor.slots", "donor.driveId"], check: (s) => !s.donor || s.donor.loading || s.donor.slots.every((x: { drive: number }) => String(x.drive) === s.donor.driveId) },
    { name: "one appointment per drive", fields: ["donor.mine"], check: (s) => !s.donor || new Set(s.donor.mine.map((a: { drive: number }) => a.drive)).size === s.donor.mine.length },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
