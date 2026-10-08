import type { AppManifest } from "../../src/shared/manifest.js";

const questions = [
  { id: 11, order: 1, text: "How satisfied are you with onboarding?", type: "scale" },
  { id: 12, order: 2, text: "Which features do you use weekly?", type: "multi" },
  { id: 13, order: 4, text: "Anything we should improve?", type: "text" },
];

const manifest: AppManifest = {
  name: "react-survey",
  title: "Survey builder",
  framework: "react",
  libs: ["react", "useGenClassState", "fetch"],
  domain: "survey-builder",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "questions", seed: questions, required: ["text"], envelope: "items", pageSize: 50 }],
    docs: [{ name: "survey", init: { title: "Customer pulse Q4", status: "draft", questionCount: 3 }, versioned: true }],
  },
  variants: {
    addGuard: ["disable", "none"],
    editSave: ["debounced", "on-change"],
    deleteMode: ["wait", "optimistic"],
    order: ["max+1", "length+1"],
    publishGuard: ["pending", "none"],
  },
  affordances: [
    { id: "kind", kind: "select", sel: "select[name=type]", values: ["scale", "multi", "text", "yesno"], weight: 0.8, mode: "replace" },
    { id: "draft", kind: "type", sel: "input[name=newq]", values: ["Would you recommend us?", "How often do you log in?", "Rate our support", "What almost stopped you signing up?"], clear: true, weight: 2.5, mode: "replace", then: ["add"] },
    { id: "add", kind: "click", sel: "form.add button", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.18, impatientP: 0.25 },
    { id: "edit", kind: "type", sel: "li.question input.text", nth: 4, values: [" (optional)", "?", " this month"], weight: 2, mode: "replace", intent: "nth", key: "edit" },
    { id: "delete", kind: "click", sel: "li.question button.delete", nth: 4, weight: 1, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.question button.delete" },
    { id: "publish", kind: "click", sel: "button.publish", weight: 0.8, mode: "accumulate", dblclickP: 0.15, impatientP: 0.2, requires: "button.publish" },
  ],
  weights: { "builder.error": 0, "builder.notice": 0, "builder.adding": 0.1, "builder.newq": 0.3, "builder.saving": 0.1, "builder.version": 0 },
  relations: [{ name: "question order is unique", fields: ["builder.questions"], check: (s) => !s.builder || new Set(s.builder.questions.map((q: { order: number }) => q.order)).size === s.builder.questions.length }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
