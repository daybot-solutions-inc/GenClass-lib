import type { AppManifest } from "../../src/shared/manifest.js";

const topics = ["Release plan", "Standup notes", "Design review", "Hiring loop", "Budget draft", "Retro", "Roadmap Q3", "Incident 42"];
const notes = topics.map((title, i) => ({ id: 200 + i, title, body: `${title}: first draft. Owner ${["ana", "bo", "cy"][i % 3]}.`, version: 1 }));

const manifest: AppManifest = {
  name: "vue-editor",
  title: "Team notes",
  framework: "vue",
  libs: ["vue", "axios", "rt.atom"],
  domain: "docs",
  entry: "main.ts",
  integration: "stores",
  build: { vueCompiler: true },
  server: { base: "/api", collections: [{ name: "notes", seed: notes, versioned: true, envelope: "bare", pageSize: 50 }] },
  variants: {
    save: ["serialize", "overlap", "overlap"],
    echo: ["if-unchanged", "blind", "version-only", "blind"],
    versionCheck: [true, false],
    debounce: [600, 300, 900],
  },
  affordances: [
    { id: "open", kind: "click", sel: ".note-item", nth: 8, weight: 3, mode: "replace" },
    { id: "edit", kind: "type", sel: "textarea[name=body]", values: [" Added action items.", " Ship by Friday.", " Needs review from legal.", " Moved to next sprint.", " Blocked on API keys."], weight: 6, mode: "replace", after: ["open", "new"] },
    { id: "title", kind: "type", sel: "input[name=title]", values: [" (draft)", " v2", " - final"], weight: 2, mode: "replace", after: ["open", "new"] },
    { id: "new", kind: "click", sel: "button.new-note", weight: 1, mode: "accumulate", dblclickP: 0.12 },
    { id: "delete", kind: "click", sel: "button.delete-note", weight: 0.4, mode: "accumulate", after: ["open"], dblclickP: 0.1 },
    { id: "reload", kind: "click", sel: "button.reload", weight: 0.6, mode: "replace" },
  ],
  external: [{ kind: "update", target: "notes", perMin: 2, data: [{ body: "Edited by a teammate." }, { title: "Renamed by a teammate" }] }],
  weights: { "editor.saving": 0.1, "editor.error": 0, "editor.dirty": 0.2, "editor.version": 0, "list.loading": 0.1 },
  sessionMs: [25000, 70000],
};
export default manifest;
