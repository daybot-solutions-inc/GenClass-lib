import type { AppManifest } from "../../src/shared/manifest.js";

const polls = [
  { id: 1, title: "Friday team lunch", closes: "Thu 17:00" },
  { id: 2, title: "Next retro format", closes: "Mon 10:00" },
  { id: 3, title: "Offsite city", closes: "Fri 12:00" },
];
const labels: [number, string, number][] = [
  [1, "Tacos", 6],
  [1, "Ramen", 9],
  [1, "Pizza", 4],
  [1, "Mezze", 3],
  [2, "Start / Stop / Continue", 5],
  [2, "Sailboat", 7],
  [2, "4Ls", 2],
  [3, "Lisbon", 8],
  [3, "Kraków", 6],
  [3, "Valencia", 5],
  [3, "Edinburgh", 3],
];
const options = labels.map(([pollId, label, votes], i) => ({ id: 500 + i, pollId, label, key: `${pollId}|${label.toLowerCase()}`, votes }));

const manifest: AppManifest = {
  name: "petite-polls",
  title: "Team polls",
  framework: "petite-vue",
  libs: ["petite-vue", "fetch", "websocket", "rt.atom(reactive mirror)"],
  domain: "polling",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "polls", seed: polls, envelope: "bare" },
      { name: "options", seed: options, filters: ["pollId"], live: true, unique: ["key"], required: ["label", "pollId"], pageSize: 50, envelope: "items", actions: { vote: { inc: "votes", by: 1 }, unvote: { inc: "votes", by: -1 } } },
    ],
  },
  variants: {
    voteGuard: ["one-per-poll", "none"],
    echo: ["newest", "blind", "blind"],
    totals: ["derive", "incremental"],
    reconnect: ["resync", "naive"],
  },
  affordances: [
    { id: "vote", kind: "click", sel: ".option button.vote", nth: 5, intent: "nth", weight: 5, mode: "accumulate", dblclickP: 0.2, impatientP: 0.1 },
    { id: "tab", kind: "click", sel: "button.poll-tab", nth: 3, intent: "nth", weight: 1.2, mode: "replace" },
    { id: "suggest", kind: "type", sel: "input[name=suggestion]", values: ["Dumplings", "Tacos", "Lean coffee", "Porto", "Sailboat", "Burritos"], weight: 1, mode: "replace", clear: true, then: ["addOption"] },
    { id: "addOption", kind: "click", sel: "button.add-option", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15 },
  ],
  external: [
    // colleagues voting from their own laptops
    { kind: "action", target: "options", verb: "vote", perMin: 24 },
    { kind: "action", target: "options", verb: "unvote", perMin: 3 },
  ],
  weights: { "polls.draft": 0.3, "polls.error": 0, "polls.notice": 0.1, "polls.live": 0.2, "polls.current": 0.5 },
  relations: [
    {
      name: "total == sum(options.votes)",
      fields: ["polls.total", "polls.options"],
      check: (s) => !s.polls || !Array.isArray(s.polls.options) || s.polls.total === s.polls.options.reduce((a: number, o: { votes: number }) => a + Number(o.votes || 0), 0),
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
