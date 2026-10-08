import type { AppManifest } from "../../src/shared/manifest.js";

const H: [string, string, string][] = [
  ["Council approves new bike lanes", "metro", "review"], ["Harbour ferry fares to rise in May", "metro", "draft"],
  ["Local bakery wins national prize", "life", "published"], ["Storm closes coastal road", "metro", "review"],
  ["Hospital opens new maternity wing", "health", "draft"], ["Library extends weekend hours", "life", "review"],
  ["School board delays budget vote", "education", "draft"], ["Marathon route announced", "sport", "published"],
  ["River clean-up draws 400 volunteers", "metro", "review"], ["Theatre festival returns", "arts", "draft"],
];
const stories = H.map(([headline, desk, status], i) => ({ id: 1200 + i, headline, desk, status, words: 300 + i * 70, standfirst: `Standfirst for story ${i + 1}.` }));

const manifest: AppManifest = {
  name: "solid-newsroom",
  title: "Newsroom",
  framework: "solid",
  libs: ["solid-js", "solid-js/html", "fetch", "rt.atom", "atomSignal"],
  domain: "newsroom-cms",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "stories", seed: stories, versioned: true, filters: ["status", "desk"], envelope: "items", pageSize: 30, required: ["headline"] }],
  },
  variants: {
    autosave: ["serialized", "parallel"],
    conflict: ["reload", "overwrite", "reload"],
    openSeq: ["latest", "blind"],
    publishGuard: ["disable", "none"],
    listPoll: [6000, 4000],
  },
  affordances: [
    { id: "filter", kind: "click", sel: "nav.status button", text: ["All", "Draft", "Review", "Published"], weight: 1.2, mode: "replace", key: "filter" },
    { id: "open", kind: "click", sel: "li.story button.open", nth: 6, weight: 3, mode: "replace", key: "open" },
    { id: "headline", kind: "type", sel: "input[name=headline]", values: [" (updated)", ": what we know", " — live", " as costs climb"], weight: 3, mode: "replace", after: ["open"], requires: "form.editor" },
    { id: "standfirst", kind: "type", sel: "textarea[name=standfirst]", values: ["Officials confirmed the plan on Tuesday.", "More details are expected this week.", "Residents gave mixed reactions."], clear: true, weight: 1.5, mode: "replace", after: ["open"], requires: "form.editor" },
    { id: "publish", kind: "click", sel: "form.editor button.publish", weight: 1.5, mode: "accumulate", after: ["open"], requires: "form.editor button.publish", dblclickP: 0.15, impatientP: 0.2 },
  ],
  external: [
    { kind: "update", target: "stories", perMin: 2.5, where: { status: "review" }, data: [{ headline: "Council approves bike lanes after long debate" }, { standfirst: "Edited by the night desk." }, { status: "published" }] },
    { kind: "update", target: "stories", perMin: 1.5, where: { status: "draft" }, data: [{ words: 640 }, { status: "review" }] },
  ],
  weights: { "desk.error": 0, "desk.notice": 0, "desk.loading": 0.1, "editor.saving": 0.1, "editor.dirty": 0.1, "editor.version": 0, "editor.headline": 0.3, "editor.standfirst": 0.3, "editor.error": 0 },
  relations: [{ name: "open story matches the list", fields: ["editor.story", "editor.id"], check: (s) => !s.editor || !s.editor.id || s.editor.loading || s.editor.story === s.editor.id }],
  errorSelector: "[role=alert]",
  build: { jsx: "solid-html" },
  sessionMs: [25000, 60000],
};
export default manifest;
