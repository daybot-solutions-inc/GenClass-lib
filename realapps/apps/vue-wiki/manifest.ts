import type { AppManifest } from "../../src/shared/manifest.js";

const P: [string, string, string][] = [
  ["Onboarding checklist", "people", "Laptop, accounts, buddy, first-week goals."],
  ["On-call handbook", "eng", "Pager rotation, escalation, runbooks."],
  ["Expense policy", "finance", "Receipts within 30 days; travel class rules."],
  ["Release process", "eng", "Freeze Thursday, ship Tuesday, notes in #releases."],
  ["Office wifi", "it", "Network: Guest-5G. Ask IT for the staff network."],
  ["Brand guidelines", "design", "Logo spacing, colours, tone of voice."],
];
const pages = P.map(([title, space, body], i) => ({ id: 40 + i, title, space, body, editedBy: "admin" }));

const manifest: AppManifest = {
  name: "vue-wiki",
  title: "Team wiki",
  framework: "vue",
  libs: ["vue", "fetch", "rt.atom", "useAtom"],
  domain: "wiki-editor",
  entry: "main.ts",
  integration: "stores",
  server: { base: "/api", collections: [{ name: "pages", seed: pages, versioned: true, filters: ["space"], search: ["title", "body"], envelope: "items", pageSize: 30, required: ["title"] }] },
  variants: {
    conflict: ["prompt", "overwrite", "take-theirs"],
    openSeq: ["latest", "blind"],
    saveGuard: ["pending", "none"],
    baseVersion: ["at-open", "from-poll"],
  },
  affordances: [
    { id: "open", kind: "click", sel: "li.page button.open", nth: 6, weight: 3, mode: "replace", key: "page" },
    { id: "type", kind: "type", sel: "textarea[name=body]", values: [" Updated for Q4.", " See also the FAQ.", " Owner: platform team.", " (draft)"], weight: 3, mode: "replace", after: ["open"], requires: "section.editor", then: ["save"] },
    { id: "save", kind: "click", sel: "section.editor button.save", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.25 },
    { id: "keepMine", kind: "click", sel: "div.conflict button.keep-mine", weight: 1.5, mode: "accumulate", requires: "div.conflict" },
    { id: "takeTheirs", kind: "click", sel: "div.conflict button.take-theirs", weight: 1, mode: "accumulate", requires: "div.conflict" },
  ],
  external: [{ kind: "update", target: "pages", perMin: 4, data: [{ body: "Rewritten by Sam: see the new layout.", editedBy: "sam" }, { body: "Kim fixed typos and added links.", editedBy: "kim" }, { title: "Release process (2026)", editedBy: "kim" }] }],
  weights: { "wiki.error": 0, "wiki.notice": 0, "wiki.saving": 0.1, "wiki.loading": 0.1, "wiki.draft": 0.3, "wiki.baseVersion": 0 },
  relations: [{ name: "editor shows the opened page", fields: ["wiki.pageId", "wiki.openId"], check: (s) => !s.wiki || s.wiki.loading || s.wiki.pageId === s.wiki.openId }],
  errorSelector: "[role=alert]",
  build: { vueCompiler: true },
  sessionMs: [25000, 60000],
};
export default manifest;
