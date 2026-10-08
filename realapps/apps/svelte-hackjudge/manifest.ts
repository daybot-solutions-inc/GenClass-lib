import type { AppManifest } from "../../src/shared/manifest.js";

const entries: [string, string, string][] = [
  ["Team Nimbus", "Rainwater Ledger", "Climate"],
  ["Byte Bakers", "Crumb Tracker", "Food"],
  ["Pier Pressure", "Dockside Queue", "Mobility"],
  ["Null Pointers", "Shelter Finder", "Civic"],
  ["Tidal Labs", "Kelp Monitor", "Climate"],
  ["Lantern", "Night Bus Buddy", "Mobility"],
  ["Quiet Coders", "Library Seat Map", "Civic"],
  ["Saltwater", "Ferry Delay Bot", "Mobility"],
  ["Green Thumbs", "Compost Courier", "Food"],
  ["Harbour Hawks", "Bike Dock Radar", "Mobility"],
  ["Open Doors", "Ramp Reporter", "Civic"],
  ["Fogbank", "Air Quality Kiosk", "Climate"],
  ["Mapmakers", "Trail Condition Wiki", "Civic"],
  ["Spice Route", "Market Stall Finder", "Food"],
  ["Lighthouse", "Volunteer Matcher", "Civic"],
  ["Deep Current", "Fishing Quota Tracker", "Climate"],
  ["Night Owls", "Late Pharmacy Map", "Civic"],
  ["Anchor Point", "Boat Share Booking", "Mobility"],
];
const projects = entries.map(([team, title, track], i) => ({ id: 900 + i, table: i + 1, team, title, track }));

const crit = ["impact", "execution", "design"];
const scores: Record<string, unknown>[] = [];
let sid = 4100;
const add = (judge: string, p: number, c: number, value: number) => {
  const pr = projects[p]!;
  scores.push({ id: sid++, judge, projectId: pr.id, team: pr.team, criterion: crit[c], value, key: `${judge}|${pr.id}|${crit[c]}`, version: 1 });
};
for (let p = 0; p < 18; p++) for (let c = 0; c < 3; c++) {
  if ((p + c) % 3 !== 2) add("Lee Park", p, c, 1 + ((p * 7 + c * 3) % 5));
  if ((p * 2 + c) % 4 === 1) add("Sam Rivera", p, c, 1 + ((p * 5 + c) % 5));
}
for (let p = 0; p < 3; p++) for (let c = 0; c < 2; c++) add("Dana Okafor", p, c, 2 + ((p + c) % 3));

const otherScores = [
  ["Sam Rivera", 3, 0, 4], ["Sam Rivera", 7, 2, 3], ["Sam Rivera", 12, 1, 5], ["Mo Ahmed", 1, 0, 3], ["Mo Ahmed", 9, 1, 4], ["Mo Ahmed", 15, 2, 2],
].map(([judge, p, c, value]) => {
  const pr = projects[p as number]!;
  const cr = crit[c as number];
  return { judge, projectId: pr.id, team: pr.team, criterion: cr, value, key: `${judge}|${pr.id}|${cr}` };
});

const manifest: AppManifest = {
  name: "svelte-hackjudge",
  title: "Hackathon judging",
  framework: "svelte",
  libs: ["svelte", "svelte runes", "@tanstack/svelte-query", "fetch", "WebSocket", "rt.guard", "svelte-store(rt.atom)"],
  domain: "hackathon-judging",
  entry: "main.ts",
  integration: "stores",
  build: { svelte: true },
  server: {
    base: "/api",
    collections: [
      { name: "projects", seed: projects, envelope: "items", pageSize: 6 },
      { name: "scores", seed: scores, versioned: true, envelope: "items", pageSize: 500, filters: ["judge", "key"], unique: ["key"], required: ["judge", "projectId", "criterion", "value"] },
    ],
    docs: [{ name: "round", init: { status: "open", name: "Final round" }, live: true }],
  },
  variants: {
    save: ["serial", "parallel"],
    create: ["upsert-on-409", "blind-post"],
    leaderboard: ["invalidate-when-idle", "invalidate-each"],
    scoreVersion: ["if-match", "force"],
    roundLock: ["respect", "ignore"],
  },
  affordances: [
    { id: "score", kind: "select", sel: "tr.cell select.score", nth: 18, intent: "nth", values: ["1", "2", "3", "4", "5", "4", "3"], weight: 4, mode: "replace", requires: "tr.cell select.score:not([disabled])" },
    { id: "rescore", kind: "select", sel: "tr.cell select.score", nth: 18, intent: "nth", values: ["2", "3", "4", "5"], weight: 1.5, mode: "replace", key: "score", requires: "tr.cell select.score:not([disabled])", then: ["fix"] },
    { id: "fix", kind: "select", sel: "tr.cell select.score", values: ["1", "3", "4", "5"], weight: 0, mode: "replace", key: "score", followOnly: true, sameNth: true },
    { id: "next", kind: "click", sel: "button.next-tables", weight: 1.3, mode: "accumulate", dblclickP: 0.1, requires: "button.next-tables:not([disabled])" },
    { id: "prev", kind: "click", sel: "button.prev-tables", weight: 0.9, mode: "accumulate", dblclickP: 0.1, requires: "button.prev-tables:not([disabled])" },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.5, mode: "accumulate", dblclickP: 0.15 },
  ],
  external: [
    // the other judges scoring at the same time; organisers pausing the round now and then
    { kind: "update", target: "scores", perMin: 6, where: { judge: { $ne: "Dana Okafor" } }, data: [{ value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }] },
    { kind: "create", target: "scores", perMin: 2, data: otherScores },
    { kind: "doc", target: "round", perMin: 1.5, data: [{ status: "closed" }, { status: "open" }, { status: "open" }, { status: "open" }, { status: "open" }] },
  ],
  weights: { "judging.error": 0, "judging.notice": 0, "judging.page": 0.3, "judging.roundName": 0 },
  relations: [
    {
      name: "one score per judge, project and criterion",
      fields: ["scores.items"],
      check: (s) => !s.scores || new Set(s.scores.items.map((x: { key: string }) => x.key)).size === s.scores.items.length,
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
