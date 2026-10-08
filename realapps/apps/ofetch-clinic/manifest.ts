import type { AppManifest } from "../../src/shared/manifest.js";

const clinicians = ["osei", "brandt", "sousa"];
const days = ["2026-04-06", "2026-04-07", "2026-04-08"];
const slots = ["09:00", "09:20", "09:40", "10:00", "10:20", "10:40", "11:00", "11:20", "11:40"];
const others = ["R. Patel", "J. Okoye", "M. Duarte", "S. Novak", "L. Chen", "A. Byrne", "K. Yilmaz"];
const reasons = ["Check-up", "Follow-up", "Prescription review", "Vaccination", "Back pain"];
const appointments: Record<string, unknown>[] = [];
let n = 0;
clinicians.forEach((c, ci) =>
  days.forEach((d, di) =>
    slots.forEach((t, si) => {
      if ((ci * 7 + di * 5 + si * 3) % 4 !== 0) return;
      appointments.push({ id: 4400 + n, slotKey: `${c}|${d}|${t}`, clinician: c, day: d, time: t, patient: others[n % others.length], reason: reasons[n % reasons.length], account: `acct-${n}` });
      n++;
    }),
  ),
);
appointments.push({ id: 4499, slotKey: "brandt|2026-04-08|11:00", clinician: "brandt", day: "2026-04-08", time: "11:00", patient: "Maya Lind", reason: "Back pain", account: "lind-household" });
// other patients grabbing slots while the user is choosing (clashes are skipped by the server)
const grabs = clinicians.flatMap((c, ci) => days.map((d, di) => slots[(ci * 2 + di * 3 + 1) % slots.length]!).map((t, di) => ({ slotKey: `${c}|${days[di]}|${t}`, clinician: c, day: days[di], time: t, patient: others[(ci + di) % others.length], reason: "Check-up", account: `walk-in-${ci}${di}` })));

const manifest: AppManifest = {
  name: "ofetch-clinic",
  title: "Riverside Health booking",
  framework: "vue",
  libs: ["vue", "ofetch", "AbortController", "rt.atom", "useAtom"],
  domain: "healthcare-scheduling",
  entry: "main.ts",
  integration: "stores",
  build: { vueCompiler: true },
  server: {
    base: "/api",
    collections: [
      { name: "appointments", seed: appointments, unique: ["slotKey"], required: ["slotKey", "patient"], filters: ["clinician", "day", "account"], pageSize: 50, envelope: "data" },
      { name: "waitlist", seed: [], required: ["patient"], envelope: "bare" },
    ],
  },
  variants: {
    retryPolicy: ["get-only", "global", "global"],
    bookLock: [true, false],
    slotRefresh: ["after-change", "never"],
    scheduleGuard: ["abort", "none"],
  },
  affordances: [
    { id: "clinician", kind: "select", sel: "select[name=clinician]", values: ["osei", "brandt", "sousa"], weight: 1.2, mode: "replace" },
    { id: "day", kind: "select", sel: "select[name=day]", values: ["2026-04-06", "2026-04-07", "2026-04-08"], weight: 1.2, mode: "replace" },
    // switching clinician and day in quick succession
    { id: "browse", kind: "select", sel: "select[name=clinician]", values: ["osei", "brandt", "sousa"], weight: 0.8, mode: "replace", then: ["dayQuick"] },
    { id: "dayQuick", kind: "select", sel: "select[name=day]", values: ["2026-04-06", "2026-04-07", "2026-04-08"], weight: 0, mode: "replace", followOnly: true },
    { id: "slot", kind: "click", sel: "button.slot:not([disabled])", nth: 9, intent: "nth", weight: 3.5, mode: "replace", then: ["patient", "book"] },
    { id: "patient", kind: "type", sel: "input[name=patient]", values: ["Maya Lind", "Erik Lind", "Noor Lind"], weight: 0, mode: "replace", clear: true, followOnly: true },
    { id: "book", kind: "click", sel: "button.book", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.25, impatientP: 0.2 },
    { id: "waitlist", kind: "click", sel: "button.waitlist", weight: 1, mode: "accumulate", requires: "button.waitlist", dblclickP: 0.15 },
    { id: "cancel", kind: "click", sel: ".visit button.cancel", nth: 3, intent: "nth", weight: 0.6, mode: "accumulate", requires: ".visit button.cancel", dblclickP: 0.1 },
  ],
  external: [{ kind: "create", target: "appointments", perMin: 3, data: grabs }],
  weights: {
    "schedule.clinician": 0.3,
    "schedule.day": 0.3,
    "schedule.loading": 0.1,
    "schedule.error": 0,
    "booking.patient": 0.3,
    "booking.reason": 0.3,
    "booking.status": 0.1,
    "booking.notice": 0.1,
    "booking.error": 0,
    "booking.waitlistOffer": 0.2,
    "visits.error": 0,
    banner: 0,
  },
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
