import type { AppManifest } from "../../src/shared/manifest.js";

const seed: [string, string, string, string][] = [
  ["Design system tokens", "https://design.acme.io/tokens", "Design", "maya"], ["Icon library", "https://icons.acme.io", "Design", "maya"],
  ["Brand guidelines", "https://brand.acme.io/guide", "Design", "leo"], ["Figma team space", "https://figma.com/team/acme", "Design", "leo"],
  ["Accessibility checklist", "https://a11y.acme.io/checklist", "Design", "ana"], ["Motion principles", "https://design.acme.io/motion", "Design", "ana"],
  ["Deploy runbook", "https://wiki.acme.io/runbooks/deploy", "Engineering", "sam"], ["On-call handbook", "https://wiki.acme.io/oncall", "Engineering", "sam"],
  ["API style guide", "https://wiki.acme.io/api-style", "Engineering", "kofi"], ["Grafana dashboards", "https://grafana.acme.io", "Engineering", "kofi"],
  ["Feature flag console", "https://flags.acme.io", "Engineering", "lin"], ["Postmortem template", "https://wiki.acme.io/postmortem", "Engineering", "lin"],
  ["Laptop setup", "https://it.acme.io/laptop", "Onboarding", "jo"], ["Benefits overview", "https://people.acme.io/benefits", "Onboarding", "jo"],
  ["Team directory", "https://people.acme.io/directory", "Onboarding", "raj"], ["Expense policy", "https://finance.acme.io/expenses", "Onboarding", "raj"],
  ["First week checklist", "https://people.acme.io/first-week", "Onboarding", "zoe"], ["User interview notes", "https://research.acme.io/interviews", "Research", "priya"],
  ["Survey results Q1", "https://research.acme.io/survey-q1", "Research", "priya"], ["Competitor teardown", "https://research.acme.io/teardown", "Research", "marc"],
  ["Usability test videos", "https://research.acme.io/videos", "Research", "marc"], ["Persona library", "https://research.acme.io/personas", "Research", "ana"],
];
const links = seed.map(([title, url, folder, addedBy], i) => ({ id: 5300 + i, title, url, folder, addedBy, pinned: i % 4 === 0 }));

const manifest: AppManifest = {
  name: "knockout-links",
  title: "Team links",
  framework: "knockout",
  libs: ["knockout", "data-bind templates", "fetch", "rt.guard over ko observables", "deferred delete with undo"],
  domain: "team-link-library",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      {
        name: "links",
        seed: links,
        versioned: true,
        unique: ["url"],
        required: ["title", "url", "folder"],
        filters: ["folder"],
        envelope: "items",
        pageSize: 40,
        actions: { pin: { toggle: "pinned" } },
      },
    ],
  },
  variants: {
    poll: ["write-aware", "blind"],
    undo: ["deferred", "immediate"],
    move: ["if-match", "force"],
    folderSeq: ["latest", "blind"],
    pinned: ["derive", "incremental"],
  },
  affordances: [
    { id: "folder", kind: "select", sel: "select[name=folder]", values: ["Design", "Engineering", "Onboarding", "Research"], weight: 1, mode: "replace" },
    { id: "pin", kind: "click", sel: "tr.link button.pin", nth: 6, weight: 2, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.15, requires: "tr.link button.pin:not([disabled])" },
    { id: "move", kind: "select", sel: "tr.link select.move", nth: 6, values: ["Design", "Engineering", "Onboarding", "Research"], weight: 1.5, mode: "accumulate", intent: "nth", requires: "tr.link select.move:not([disabled])" },
    { id: "delete", kind: "click", sel: "tr.link button.delete", nth: 6, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "tr.link button.delete:not([disabled])" },
    { id: "undo", kind: "click", sel: "div.undo button.undo", weight: 1.2, mode: "accumulate", after: ["delete"], requires: "div.undo button.undo", dblclickP: 0.1 },
    { id: "title", kind: "type", sel: "form.add input[name=title]", values: ["Release calendar", "Pairing guide", "Research repository", "Color contrast tool"], clear: true, weight: 1, mode: "replace", then: ["url", "add"] },
    { id: "url", kind: "type", sel: "form.add input[name=url]", values: ["https://wiki.acme.io/releases", "https://wiki.acme.io/pairing", "https://research.acme.io/repo", "https://figma.com/team/acme"], clear: true, weight: 0, mode: "replace", followOnly: true },
    { id: "add", kind: "click", sel: "form.add button", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.15 },
  ],
  external: [
    { kind: "action", target: "links", perMin: 3, verb: "pin" },
    { kind: "update", target: "links", perMin: 2, where: { folder: "Design" }, data: [{ folder: "Research" }, { title: "Design tokens (v2)" }] },
    { kind: "update", target: "links", perMin: 1.5, where: { folder: "Engineering" }, data: [{ folder: "Onboarding" }, { title: "Deploy runbook (2026)" }] },
    { kind: "create", target: "links", perMin: 1.5, data: [{ title: "Sprint review deck", url: "https://slides.acme.io/sprint-review", folder: "Engineering", addedBy: "sam", pinned: false }, { title: "Moodboard spring", url: "https://design.acme.io/moodboard", folder: "Design", addedBy: "leo", pinned: false }, { title: "Interview guide", url: "https://research.acme.io/guide", folder: "Research", addedBy: "priya", pinned: false }] },
  ],
  weights: { "library.error": 0, "library.notice": 0, "library.loading": 0.1, "library.busy": 0.1, "library.adding": 0.1, "library.undo": 0.1 },
  relations: [
    { name: "pinned count = pinned links", fields: ["library.pinnedCount", "library.links"], check: (s) => !s.library || s.library.loading || s.library.pinnedCount === s.library.links.filter((l: { pinned: boolean }) => l.pinned).length },
    { name: "links belong to the folder", fields: ["library.links", "library.folder"], check: (s) => !s.library || s.library.loading || s.library.links.every((l: { folder: string }) => l.folder === s.library.folder) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
