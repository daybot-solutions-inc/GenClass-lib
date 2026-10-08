import type { AppManifest } from "../../src/shared/manifest.js";

const talks: [string, string, string][] = [
  ["Signals all the way down", "Ana Ruiz", "frontend"], ["Postgres at 3 a.m.", "Tobi Adeyemi", "data"], ["Shipping CSS without fear", "Mei Lin", "frontend"],
  ["The cost of a retry", "Jonas Berg", "backend"], ["Kubernetes for the tired", "Rosa Kim", "devops"], ["Event sourcing, honestly", "Pavel Novak", "backend"],
  ["Accessible charts", "Lea Martin", "frontend"], ["Feature stores in practice", "Omar Haddad", "data"], ["Terraform drift detectives", "Ivy Chen", "devops"],
  ["Idempotency keys explained", "Sam Ortiz", "backend"], ["Streaming SQL for humans", "Nadia Petrova", "data"], ["Container images on a diet", "Ken Ito", "devops"],
  ["Forms are hard", "Zoe Clarke", "frontend"], ["Rate limits that feel fair", "Diego Alvarez", "backend"], ["Data contracts", "Ruth Mensah", "data"],
  ["Blue/green without tears", "Hugo Laurent", "devops"], ["Hydration, explained", "Priya Raman", "frontend"], ["Queues you can reason about", "Elif Kaya", "backend"],
];
const proposals = talks.map(([title, speaker, track], i) => ({ id: 1500 + i, title, speaker, track, myScore: i % 4 === 0 ? 3 + (i % 3) : 0, reviews: 1 + (i % 4), status: "open" }));

const manifest: AppManifest = {
  name: "knockout-cfp",
  title: "CFP review",
  framework: "knockout",
  libs: ["knockout", "ko.pureComputed", "fetch", "rt.guard"],
  domain: "conference-cfp",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "proposals", seed: proposals, versioned: true, filters: ["track", "status"], envelope: "items", pageSize: 5, actions: { review: { inc: "reviews", by: 1 } } }],
  },
  variants: {
    cache: ["swr", "cache-only"],
    save: ["serial", "parallel"],
    conflict: ["respect", "overwrite"],
    pageSeq: ["latest", "blind"],
    count: ["computed", "incremental"],
  },
  affordances: [
    { id: "track", kind: "select", sel: "select[name=track]", values: ["all", "frontend", "backend", "data", "devops"], weight: 1, mode: "replace" },
    { id: "page", kind: "click", sel: "nav.pages button", nth: 4, weight: 2, mode: "replace", key: "page" },
    { id: "score", kind: "select", sel: "tr.proposal select.score", nth: 5, values: ["1", "2", "3", "4", "5"], weight: 4, mode: "replace", intent: "nth", key: "score" },
    { id: "decide", kind: "click", sel: "tr.proposal button.decide", text: ["Accept", "Reject"], nth: 5, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.1, impatientP: 0.15, requires: "tr.proposal button.decide" },
  ],
  external: [
    { kind: "update", target: "proposals", perMin: 3, where: { status: "open" }, data: [{ status: "accepted" }, { status: "rejected" }, { status: "waitlist" }] },
    { kind: "action", target: "proposals", perMin: 5, verb: "review" },
  ],
  weights: { "cfp.error": 0, "cfp.notice": 0, "cfp.loading": 0.1, "cfp.saving": 0.1, "cfp.track": 0.3 },
  relations: [
    { name: "scored count = scored rows", fields: ["cfp.scored", "cfp.rows"], check: (s) => !s.cfp || s.cfp.loading || s.cfp.scored === s.cfp.rows.filter((r: { myScore: number }) => r.myScore > 0).length },
    { name: "rows belong to the track", fields: ["cfp.rows", "cfp.track"], check: (s) => !s.cfp || s.cfp.loading || s.cfp.rows.every((r: { track: string }) => s.cfp.track === "all" || r.track === s.cfp.track) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
