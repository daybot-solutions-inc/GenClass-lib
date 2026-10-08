import type { AppManifest } from "../../src/shared/manifest.js";

const rows: [string, string, string, number, string][] = [
  ["Dark mode for the mobile app", "Easier on the eyes at night", "planned", 57, "Ana"],
  ["Offline editing", "Edit on the train without signal", "in-progress", 49, "Femi"],
  ["Export notes to PDF", "Share notes with people who don't use the app", "open", 38, "Jules"],
  ["Shared notebooks with permissions", "Read-only links for clients", "planned", 33, "Mateo"],
  ["Markdown tables", "Simple tables in notes", "open", 27, "Priyanka"],
  ["Calendar integration", "Link notes to meetings", "open", 24, "Tom"],
  ["Web clipper for Firefox", "Save articles from Firefox", "in-progress", 21, "Lea"],
  ["Two-step sign-in", "Extra protection for work accounts", "done", 64, "Hiro"],
  ["Handwriting recognition", "Search my scribbles", "open", 18, "Olu"],
  ["Custom keyboard shortcuts", "Remap the editor keys", "open", 15, "Sven"],
  ["Version history for notes", "Undo yesterday's mistake", "planned", 14, "Ines"],
  ["Tag autocomplete", "Stop creating duplicate tags", "done", 12, "Carla"],
  ["Reminders on notes", "Nudge me about a note later", "open", 11, "Dmitri"],
  ["Slack integration", "Send a note to a channel", "open", 9, "Zoe"],
  ["Bulk move between notebooks", "Reorganise faster", "open", 7, "Ken"],
  ["Sort notebooks alphabetically", "Find notebooks quicker", "done", 6, "Rosa"],
  ["Templates for meeting notes", "Agenda, attendees, actions", "open", 5, "Amir"],
  ["Larger font option", "Accessibility for long reading", "open", 3, "Bea"],
];
const ideas = rows.map(([title, details, status, votes, author], i) => ({ id: 100 + i, title, details, status, votes, author }));

const manifest: AppManifest = {
  name: "swr-feedback",
  title: "Feedback board",
  framework: "react",
  libs: ["react", "swr", "useSWRInfinite", "mutate", "fetch", "rt.atom"],
  domain: "product-feedback",
  entry: "main.tsx",
  integration: "stores",
  heldOut: true,
  server: {
    base: "/api",
    collections: [{ name: "ideas", seed: ideas, unique: ["title"], required: ["title", "details"], filters: ["status"], envelope: "items", pageSize: 20, actions: { vote: { inc: "votes", by: 1 } } }],
  },
  variants: {
    vote: ["optimistic-rollback", "optimistic-no-rollback"],
    voteGuard: ["pending", "none"],
    filterReset: ["reset-pages", "keep-pages"],
    submitGuard: ["pending", "none"],
    dedupingInterval: [2000, 0],
  },
  affordances: [
    { id: "tab", kind: "click", sel: "nav.tabs button", text: ["All", "All", "Under review", "Under review", "Planned", "Planned", "Shipped"], weight: 1.2, mode: "replace" },
    { id: "vote", kind: "click", sel: "li.idea button.vote", nth: 5, weight: 3.5, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.2, requires: "li.idea button.vote:not([disabled])" },
    { id: "loadMore", kind: "click", sel: "button.load-more", weight: 1.2, mode: "accumulate", dblclickP: 0.15, impatientP: 0.15, requires: "button.load-more:not([disabled])" },
    {
      id: "title",
      kind: "type",
      sel: "form.new-idea input[name=title]",
      values: ["Audio notes with transcripts", "Pin notes to the top", "Export notes to PDF", "Emoji reactions on shared notes", "Markdown tables", "Apple Watch app"],
      clear: true,
      weight: 0.9,
      mode: "replace",
      then: ["details", "submit"],
    },
    { id: "details", kind: "type", sel: "form.new-idea textarea[name=details]", values: ["I record lectures", "Keep my shopping list on top", "My team needs this weekly"], clear: true, weight: 0, mode: "replace", followOnly: true },
    { id: "submit", kind: "click", sel: "form.new-idea button[type=submit]", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.25, impatientP: 0.2 },
    { id: "quickTitle", kind: "type", sel: "form.new-idea input[name=title]", values: ["Bigger checkboxes", "Pin notes to the top"], clear: true, weight: 0.25, mode: "replace", key: "title", then: ["submit"] },
  ],
  external: [
    { kind: "action", target: "ideas", verb: "vote", perMin: 8, where: { status: { $ne: "done" } } },
    {
      kind: "create",
      target: "ideas",
      perMin: 0.6,
      data: [
        { title: "Apple Watch app", details: "Quick capture from the wrist", status: "open", votes: 1, author: "Kemi" },
        { title: "Math equations", details: "LaTeX in notes for class", status: "open", votes: 1, author: "Lior" },
        { title: "Pin notes to the top", details: "Keep the important ones visible", status: "open", votes: 1, author: "Noah" },
      ],
    },
    { kind: "update", target: "ideas", perMin: 0.5, where: { status: "open" }, data: [{ status: "planned" }] },
    { kind: "update", target: "ideas", perMin: 0.4, where: { status: "planned" }, data: [{ status: "in-progress" }] },
    { kind: "update", target: "ideas", perMin: 0.25, where: { status: "in-progress" }, data: [{ status: "done" }] },
  ],
  weights: { "ui.error": 0, "ui.notice": 0, "ui.voting": 0.1, "ui.submitting": 0.1 },
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
