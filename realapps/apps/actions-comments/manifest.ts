import type { AppManifest } from "../../src/shared/manifest.js";

const threads = [
  { id: 61, title: "Pricing table looks off on mobile", anchor: "Section 2 · Pricing", resolved: false },
  { id: 62, title: "Can we shorten the hero copy?", anchor: "Section 1 · Hero", resolved: false },
  { id: 63, title: "Legal wants a footnote here", anchor: "Section 4 · FAQ", resolved: false },
];
const bodies = ["Agreed, the columns wrap too early.", "Let's test it on an iPhone SE.", "Maybe drop the second sentence?", "I like the current version.", "Footnote text is in the doc.", "Can someone from legal confirm?", "Fixed in the latest draft.", "Looks good to me.", "We need this before launch."];
const people = ["noor", "felix", "ines", "tom"];
const comments = bodies.map((body, i) => ({ id: 7300 + i, threadId: 61 + (i % 3), author: people[i % people.length], body, likes: (i * 2) % 5 }));

type C = { pending?: boolean };

const manifest: AppManifest = {
  name: "actions-comments",
  title: "Design review",
  framework: "react",
  libs: ["react@19", "useActionState", "useOptimistic", "useFormStatus", "form actions", "fetch", "useGenClassState"],
  domain: "collaboration",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "threads", seed: threads, envelope: "bare" },
      { name: "comments", seed: comments, filters: ["threadId"], envelope: "items", pageSize: 200, actions: { like: { inc: "likes", by: 1 } }, required: ["body"] },
    ],
  },
  variants: {
    optimistic: ["useOptimistic", "manual-no-rollback"],
    pendingGuard: ["form-status", "none"],
    poll: ["merge", "replace", "replace"],
    count: ["recount", "increment"],
    likeGuard: ["once", "none"],
  },
  affordances: [
    { id: "replyTo", kind: "click", sel: ".thread button.reply-to", nth: 3, weight: 1.5, mode: "replace", key: "thread" },
    { id: "body", kind: "type", sel: "textarea[name=body]", values: ["+1, let's do it.", "I'll update the mock tonight.", "Not sure about this one.", "Can we discuss at standup?", "Done, please re-check."], weight: 4, mode: "replace", clear: true, then: ["post"] },
    { id: "post", kind: "click", sel: "button.post", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.25 },
    { id: "like", kind: "click", sel: ".comment button.like", nth: 8, weight: 2.5, mode: "accumulate", intent: "nth", dblclickP: 0.2 },
    { id: "resolve", kind: "click", sel: ".thread button.resolve", nth: 3, weight: 0.8, mode: "accumulate", intent: "nth", dblclickP: 0.1 },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.4, mode: "replace" },
  ],
  external: [
    { kind: "create", target: "comments", perMin: 4, data: [{ threadId: 61, author: "felix", body: "Pushed a fix for the wrap." }, { threadId: 62, author: "noor", body: "Shorter version is in Figma." }, { threadId: 63, author: "tom", body: "Legal signed off." }, { threadId: 61, author: "ines", body: "Still broken on Android." }] },
    { kind: "action", target: "comments", perMin: 2, verb: "like" },
    { kind: "update", target: "threads", perMin: 0.5, data: [{ resolved: true }, { resolved: false }] },
  ],
  weights: { "review.error": 0, "review.syncing": 0.1, "review.active": 0.3 },
  relations: [{ name: "total == saved comments", fields: ["review.total", "review.comments"], check: (s) => !s.review || s.review.total === s.review.comments.filter((c: C) => !c.pending).length }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
