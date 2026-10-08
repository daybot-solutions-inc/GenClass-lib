import type { AppManifest } from "../../src/shared/manifest.js";

const authors = ["mira", "tobias", "ines", "kwame", "lena", "otto", "sana", "felix"];
const topics = [
  "Shipped the new onboarding flow today",
  "Anyone else seeing slow builds on main?",
  "Reading group picks: Designing Data-Intensive Applications",
  "Pairing session notes are in the wiki",
  "The office plants survived the long weekend",
  "Reminder: retro moved to Thursday",
  "Our p95 latency dropped by a third after the cache change",
  "Looking for reviewers on the billing refactor",
  "Hackathon ideas thread",
  "Lunch-and-learn on accessibility next week",
  "New hire intro: welcome Priya!",
  "Postmortem for Tuesday's outage is published",
  "Who owns the flaky checkout test?",
  "Coffee machine on floor 3 is fixed",
  "Draft roadmap for Q3 is up for comments",
  "We hit 10k weekly active users",
  "Deprecating the v1 export API in June",
  "Tips for writing better commit messages",
  "Mentorship program sign-ups are open",
  "Kudos to the support team this week",
  "The design system now has dark mode tokens",
  "Office closed Friday for maintenance",
  "Book club meets in the atrium",
];
const posts = topics.map((text, i) => ({
  id: 9001 + i,
  author: authors[i % authors.length],
  text,
  likes: (i * 7) % 23,
  liked: i % 5 === 2,
  comments: i < 6 ? 2 : i % 3 === 0 ? 1 : 0,
  createdAt: new Date(Date.UTC(2026, 2, 31, 18, 0, 0) - i * 3600000 * 5).toISOString(),
}));
const comments: Record<string, unknown>[] = [];
let cid = 70000;
for (const p of posts) for (let k = 0; k < (p.comments as number); k++) comments.push({ id: cid++, postId: p.id, author: authors[(p.id + k + 3) % authors.length], text: ["Nice!", "+1, same here", "Thanks for sharing", "Can you add a link?"][(p.id + k) % 4] });

const manifest: AppManifest = {
  name: "vue-query-feed",
  title: "Commons",
  framework: "vue",
  libs: ["vue", "@tanstack/vue-query", "axios", "rt.guard"],
  domain: "social",
  entry: "main.ts",
  integration: "stores",
  build: { vueCompiler: true },
  server: {
    base: "/api",
    collections: [
      {
        name: "posts",
        seed: posts,
        pageSize: 5,
        envelope: "items",
        actions: { like: { inc: "likes", by: 1, set: { liked: true } }, unlike: { inc: "likes", by: -1, set: { liked: false } }, upvote: { inc: "likes", by: 1 } },
      },
      { name: "comments", seed: comments, filters: ["postId"], envelope: "items", pageSize: 50 },
    ],
  },
  variants: {
    loadMoreGuard: ["inflight", "none", "none"],
    dedupe: ["by-id", "none", "none"],
    rollback: ["invert", "snapshot", "none"],
    likeMode: ["relative", "absolute"],
    likeEcho: ["if-latest", "blind", "blind"],
    replyGuard: [true, false],
  },
  affordances: [
    { id: "like", kind: "click", sel: ".post button.like", nth: 8, intent: "nth", weight: 4, mode: "replace", dblclickP: 0.12 },
    { id: "more", kind: "click", sel: "button.more", weight: 2, mode: "accumulate", dblclickP: 0.2, impatientP: 0.3 },
    { id: "open", kind: "click", sel: ".post button.comments", nth: 6, intent: "nth", weight: 2, mode: "replace" },
    {
      id: "reply",
      kind: "type",
      sel: "textarea[name=reply]",
      values: ["Love this", "Count me in", "Where can I read more?", "Great work, team", "Is there a recording?"],
      weight: 2.5,
      mode: "replace",
      clear: true,
      after: ["open"],
      then: ["send"],
    },
    { id: "send", kind: "click", sel: "button.reply", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.15 },
    { id: "new", kind: "click", sel: "button.new-posts", weight: 1, mode: "replace" },
  ],
  external: [
    { kind: "action", target: "posts", perMin: 8, verb: "upvote" },
    {
      kind: "create",
      target: "comments",
      perMin: 2,
      data: [
        { postId: 9001, author: "otto", text: "Congrats!" },
        { postId: 9002, author: "sana", text: "Builds are fine for me" },
        { postId: 9003, author: "ines", text: "I'll join" },
      ],
    },
    {
      kind: "create",
      target: "posts",
      perMin: 1,
      data: [
        { author: "noor", text: "Standup is async today", likes: 0, liked: false, comments: 0 },
        { author: "kwame", text: "Release 4.2 is out", likes: 0, liked: false, comments: 0 },
        { author: "lena", text: "Free pizza in the kitchen", likes: 0, liked: false, comments: 0 },
      ],
    },
  ],
  weights: { "ui.draft": 0.3, "ui.error": 0, "ui.openId": 0.5, "feed.page": 0.5 },
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
