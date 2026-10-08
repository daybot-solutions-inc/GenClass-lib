import type { AppManifest } from "../../src/shared/manifest.js";

const waiting: [string, string, string, string, string][] = [
  ["Biscuit", "dog", "Okafor", "vaccination", "routine"], ["Miso", "cat", "Tanaka", "limping", "urgent"], ["Pickles", "rabbit", "Moreau", "not eating", "urgent"],
  ["Rex", "dog", "Santos", "ear infection", "routine"], ["Luna", "cat", "Novak", "dental check", "routine"], ["Bolt", "dog", "Haddad", "swallowed a sock", "emergency"],
  ["Kiwi", "bird", "Lindqvist", "feather loss", "routine"],
];
const patients = waiting.map(([pet, species, owner, reason, priority], i) => ({ id: 4400 + i, pet, species, owner, reason, priority, status: i === 5 ? "in-room" : "waiting", room: i === 5 ? "Room 2" : "", arrived: `08:${String(10 + i * 6).padStart(2, "0")}` }));

const manifest: AppManifest = {
  name: "valtio-vetclinic",
  title: "Vet clinic front desk",
  framework: "vanilla",
  libs: ["valtio/vanilla", "lit-html (render)", "fetch", "WebSocket", "rt.guard"],
  domain: "veterinary-clinic",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "patients", seed: patients, versioned: true, live: true, required: ["pet", "owner"], filters: ["status"], envelope: "items", pageSize: 50 }],
  },
  variants: {
    callNext: ["if-match", "force"],
    checkin: ["reconcile", "append"],
    live: ["version-check", "blind"],
    order: ["recompute", "stale"],
    waitingCount: ["derive", "incremental"],
  },
  affordances: [
    { id: "pet", kind: "type", sel: "form.checkin input[name=pet]", values: ["Nala", "Ziggy", "Mochi", "Chester"], clear: true, weight: 1.5, mode: "replace", then: ["owner", "checkin"] },
    { id: "owner", kind: "type", sel: "form.checkin input[name=owner]", values: ["Diaz", "Kowalski", "Mensah", "Ito"], clear: true, weight: 0, mode: "replace", followOnly: true },
    { id: "checkin", kind: "click", sel: "form.checkin button", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.2 },
    { id: "triage", kind: "select", sel: "li.patient select.priority", nth: 5, values: ["routine", "urgent", "emergency"], weight: 2, mode: "replace", intent: "nth", key: "triage" },
    { id: "call", kind: "click", sel: "nav.rooms button", text: ["Room 1", "Room 2", "Room 3"], weight: 3, mode: "accumulate", intent: "text", dblclickP: 0.15, impatientP: 0.2, requires: "nav.rooms button:not([disabled])" },
  ],
  external: [
    { kind: "update", target: "patients", perMin: 6, where: { status: "in-room" }, data: [{ status: "done", room: "" }] },
    { kind: "create", target: "patients", perMin: 2.5, data: [{ pet: "Pepper", species: "dog", owner: "Clarke", reason: "vomiting", priority: "urgent", status: "waiting", room: "", arrived: "09:05" }, { pet: "Simba", species: "cat", owner: "Ruiz", reason: "annual check", priority: "routine", status: "waiting", room: "", arrived: "09:07" }, { pet: "Hazel", species: "guinea pig", owner: "Berg", reason: "overgrown teeth", priority: "routine", status: "waiting", room: "", arrived: "09:12" }] },
    { kind: "update", target: "patients", perMin: 1.5, where: { status: "waiting" }, data: [{ priority: "urgent" }, { priority: "emergency" }, { priority: "routine" }] },
    { kind: "update", target: "patients", perMin: 2, where: { status: "waiting" }, data: [{ status: "in-room", room: "Exam B" }] },
  ],
  weights: { "desk.error": 0, "desk.notice": 0, "desk.pending": 0.1, "desk.live": 0.1, "desk.checkingIn": 0.1, "desk.draft": 0.3 },
  relations: [
    { name: "waiting count = waiting patients", fields: ["desk.waitingCount", "desk.patients"], check: (s) => !s.desk || s.desk.waitingCount === s.desk.patients.filter((p: { status: string }) => p.status === "waiting").length },
    { name: "one patient per room", fields: ["desk.patients"], check: (s) => { if (!s.desk) return true; const rooms = s.desk.patients.filter((p: { status: string; room: string }) => p.status === "in-room" && p.room.startsWith("Room")).map((p: { room: string }) => p.room); return new Set(rooms).size === rooms.length; } },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
