import type { AppManifest } from "../../src/shared/manifest.js";

const zoneRows: [string, string, number][] = [
  ["Riverside Park", "Class G", 400], ["Harbour Flats", "Class G", 400], ["Old Quarry", "Class G", 300], ["North Fields", "Class G", 400],
  ["Stadium Lot", "Class D", 200], ["Airport Fringe", "Class C", 100], ["College Green", "Class G", 300], ["Pine Ridge", "Class E", 400],
];
const zones = zoneRows.map(([name, airspace, ceiling], i) => ({ id: 210 + i, name, airspace, ceiling }));
const notams = [
  { id: 500, zone: 210, text: "Crane at the pier up to 250 ft", floor: 200, kind: "advisory", active: true },
  { id: 501, zone: 211, text: "Seaplane operations", floor: 150, kind: "restriction", active: false },
  { id: 502, zone: 213, text: "Crop dusting in progress", floor: 100, kind: "restriction", active: false },
  { id: 503, zone: 214, text: "Stadium event TFR", floor: 0, kind: "restriction", active: false },
  { id: 504, zone: 216, text: "Graduation ceremony crowds", floor: 0, kind: "advisory", active: true },
  { id: 505, zone: 217, text: "Wildfire aerial firefighting", floor: 0, kind: "restriction", active: false },
];
const authorizations = [{ id: 7700, zoneId: 212, zone: "Old Quarry", altitude: 200, window: "Morning 09–10", pilot: "you", status: "completed", createdAt: "2026-03-28T09:00:00.000Z" }];

const manifest: AppManifest = {
  name: "xstate-dronepermit",
  title: "Drone flight authorization",
  framework: "solid",
  libs: ["solid-js", "solid-js/html", "xstate@5", "createActor", "fromPromise(signal)", "fromCallback", "fetch", "AbortController", "rt.atom", "atomSignal"],
  domain: "drone-flight-authorization",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "zones", seed: zones, filters: ["airspace"], envelope: "items", pageSize: 20 },
      { name: "notams", seed: notams, filters: ["zone", "active", "kind"], envelope: "items", pageSize: 20 },
      { name: "authorizations", seed: authorizations, versioned: true, required: ["zoneId", "altitude", "window"], filters: ["pilot", "status"], envelope: "items", pageSize: 20 },
    ],
  },
  variants: {
    check: ["cancel-on-change", "race"],
    requestGuard: ["state", "none"],
    approvalPoll: ["invoke", "leak"],
    start: ["if-match", "force"],
    requestRetry: ["idempotency-key", "blind"],
  },
  affordances: [
    { id: "altitude", kind: "select", sel: "select[name=altitude]", values: ["100", "200", "300", "400"], weight: 1, mode: "replace", requires: "select[name=altitude]:not([disabled])" },
    { id: "window", kind: "select", sel: "select[name=window]", values: ["Morning 09–10", "Midday 12–13", "Evening 16–17"], weight: 0.8, mode: "replace", requires: "select[name=window]:not([disabled])" },
    { id: "zone", kind: "click", sel: "li.zone button.pick", nth: 5, weight: 2.5, mode: "replace", key: "zone", requires: "li.zone button.pick:not([disabled])", then: ["requestNow"] },
    { id: "requestNow", kind: "click", sel: "section.plan button.request", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.3 },
    { id: "request", kind: "click", sel: "section.plan button.request", weight: 1, mode: "accumulate", dblclickP: 0.2, impatientP: 0.3, requires: "section.plan button.request:not([disabled])" },
    { id: "start", kind: "click", sel: "li.auth button.start", nth: 3, weight: 2, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.25, requires: "li.auth button.start:not([disabled])" },
    { id: "land", kind: "click", sel: "li.auth button.land", weight: 1.5, mode: "accumulate", dblclickP: 0.15, impatientP: 0.25, requires: "li.auth button.land" },
    { id: "withdraw", kind: "click", sel: "li.auth button.withdraw", nth: 3, weight: 0.4, mode: "accumulate", intent: "nth", requires: "li.auth button.withdraw" },
  ],
  external: [
    { kind: "update", target: "authorizations", perMin: 12, where: { status: "pending" }, data: [{ status: "approved" }, { status: "approved" }, { status: "approved" }, { status: "denied", reason: "conflicts with a medevac corridor" }] },
    { kind: "update", target: "authorizations", perMin: 2, where: { status: "approved" }, data: [{ status: "revoked", reason: "temporary flight restriction issued" }] },
    { kind: "update", target: "notams", perMin: 4, data: [{ active: true }, { active: false }, { active: false }] },
  ],
  weights: { "permit.error": 0, "permit.notice": 0, "permit.reqKey": 0, "permit.busy": 0.1, "permit.sub": 0.1, "permit.window": 0.3, "permit.altitude": 0.3 },
  relations: [
    {
      name: "the airspace check is for the selected zone and altitude",
      fields: ["permit.check", "permit.zoneId", "permit.altitude"],
      check: (s) => !s.permit || !s.permit.check || (s.permit.check.for === s.permit.zoneId && s.permit.check.altitude === s.permit.altitude),
    },
    {
      name: "one open request per flight",
      fields: ["permit.auths"],
      check: (s) => {
        if (!s.permit) return true;
        const open = (s.permit.auths as { phase: string; zoneId: number; altitude: number; window: string }[]).filter((a) => ["pending", "withdrawing", "approved", "starting", "flying", "landing"].includes(a.phase)).map((a) => `${a.zoneId}|${a.altitude}|${a.window}`);
        return new Set(open).size === open.length;
      },
    },
  ],
  errorSelector: "[role=alert]",
  build: { jsx: "solid-html" },
  sessionMs: [25000, 60000],
};
export default manifest;
