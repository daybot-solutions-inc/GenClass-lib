import type { AppManifest } from "../../src/shared/manifest.js";

const people = ["ana", "bo", "cy", "dee", "eli"];
const titles = ["Write release notes", "Review PR #214", "Update onboarding doc", "Fix flaky login test", "Book team offsite", "Rotate API keys", "Triage support queue", "Plan sprint 19", "Clean up feature flags"];
const todos = titles.map((title, i) => ({ id: 300 + i, title, done: i % 3 === 1, assignee: people[i % people.length] }));

const manifest: AppManifest = {
  name: "rtk-todos",
  title: "Team todos",
  framework: "react",
  libs: ["react", "@reduxjs/toolkit", "react-redux", "createAsyncThunk", "axios"],
  domain: "productivity",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "todos", seed: todos, envelope: "data", pageSize: 100, filters: ["done", "assignee"], actions: { toggle: { toggle: "done" } } }],
  },
  variants: {
    addGuard: ["disable", "none", "none"],
    toggle: ["patch", "relative", "relative"],
    rollback: [true, false],
    remaining: ["recount", "forget-delete", "forget-rollback"],
    sync: ["skip-if-dirty", "blind", "blind"],
    pollMs: [8000, 5000, 12000],
  },
  affordances: [
    { id: "draft", kind: "type", sel: "input[name=newTodo]", values: ["Call the vendor", "Draft Q3 OKRs", "Fix the CI cache", "Order new badges", "Prep demo for Friday", "Reply to legal", "Archive old tickets"], weight: 4, mode: "replace", clear: true, then: ["add"] },
    { id: "add", kind: "click", sel: "button.add-todo", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.2 },
    { id: "toggle", kind: "check", sel: "li.todo input[type=checkbox]", nth: 9, weight: 5, mode: "accumulate", intent: "nth", dblclickP: 0.12 },
    { id: "delete", kind: "click", sel: "li.todo button.delete", nth: 8, weight: 1.2, mode: "accumulate", dblclickP: 0.1 },
    { id: "filter", kind: "click", sel: "nav.filters button", text: ["All", "Active", "Done"], weight: 1.5, mode: "replace" },
    { id: "clear", kind: "click", sel: "button.clear-completed", weight: 0.8, mode: "accumulate", dblclickP: 0.1, impatientP: 0.2, after: ["toggle"] },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.6, mode: "replace", dblclickP: 0.1 },
  ],
  external: [
    { kind: "create", target: "todos", perMin: 1.5, data: [{ title: "Follow up with design", done: false, assignee: "bo" }, { title: "Renew SSL cert", done: false, assignee: "cy" }, { title: "Update status page", done: false, assignee: "dee" }] },
    { kind: "update", target: "todos", perMin: 2, data: [{ done: true }, { done: false }, { title: "Renamed by a teammate" }, { assignee: "eli" }] },
  ],
  weights: { "todos.draft": 0.3, "todos.adding": 0.1, "todos.loading": 0.1, "todos.clearing": 0.1, "todos.error": 0, "todos.syncId": 0 },
  relations: [{ name: "remaining == open todos", fields: ["todos.remaining", "todos.items"], check: (s) => !s.todos || s.todos.remaining === s.todos.items.filter((t: { done: boolean }) => !t.done).length }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
