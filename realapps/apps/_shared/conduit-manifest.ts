// Shared manifest parts for RealWorld "Conduit" front-ends (Node side only). The markup follows the RealWorld
// templates, so the same scripted user works across implementations; selectors are deliberately tolerant.
import type { AppManifest, Affordance } from "../../src/shared/manifest.js";

const words = ["signals", "render", "cache", "hooks", "compiler", "streams", "routing", "forms"];

export const conduitAffordances: Affordance[] = [
  { id: "tag", key: "feed", kind: "click", sel: ".sidebar .tag-list a, .sidebar .tag-pill", nth: 10, weight: 2, mode: "replace" },
  { id: "tab", key: "feed", kind: "click", sel: ".feed-toggle .nav-link", text: ["Global Feed", "Your Feed"], weight: 2, mode: "replace", intent: "text" },
  { id: "page", key: "feed", kind: "click", sel: ".pagination .page-link, .pagination a, .pagination li", nth: 3, weight: 1, mode: "replace" },
  { id: "favorite", kind: "click", sel: ".article-preview button", nth: 6, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.12, impatientP: 0.1 },
  { id: "open", key: "view", kind: "click", sel: ".article-preview .preview-link h1, .article-preview a.preview-link", nth: 6, weight: 3, mode: "replace" },
  { id: "author", key: "view", kind: "click", sel: ".article-preview .author", nth: 6, weight: 0.8, mode: "replace" },
  { id: "home", key: "view", kind: "click", sel: ".navbar .nav-link, nav a", text: ["Home"], weight: 1, mode: "replace" },
  { id: "comment", kind: "type", sel: "textarea[placeholder='Write a comment...']", values: ["Great read!", "Thanks for sharing.", "I disagree about the cache part.", "Bookmarked."], weight: 2, mode: "replace", clear: true, after: ["open"], then: ["post"] },
  { id: "post", kind: "click", sel: ".comment-form button, form.card button", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.12, impatientP: 0.15 },
  { id: "favArticle", kind: "click", sel: ".article-meta button, .article-actions button", text: ["avorite"], weight: 1.2, mode: "accumulate", after: ["open"], dblclickP: 0.1 },
  { id: "follow", kind: "click", sel: ".article-meta button, .article-actions button, .user-info button", text: ["ollow"], weight: 0.8, mode: "accumulate", after: ["open", "author"], dblclickP: 0.1 },
  { id: "editor", key: "view", kind: "click", sel: ".navbar .nav-link, nav a", text: ["New "], weight: 0.6, mode: "replace", then: ["title", "about", "body"] },
  { id: "title", kind: "type", sel: "input[placeholder='Article Title']", values: words.map((w) => `Notes on ${w}`), weight: 0, mode: "replace", followOnly: true },
  { id: "about", kind: "type", sel: "input[placeholder*='this article about']", values: ["a short summary", "what I learned", "a quick tip"], weight: 0, mode: "replace", followOnly: true },
  { id: "body", kind: "type", sel: "textarea[placeholder*='markdown']", values: ["First paragraph.", "Some *markdown* text."], weight: 0, mode: "replace", followOnly: true },
  { id: "publish", kind: "click", sel: "button", text: ["Publish"], weight: 0.8, mode: "accumulate", after: ["editor"], dblclickP: 0.15, impatientP: 0.15 },
];

export function conduitManifest(m: Partial<AppManifest> & Pick<AppManifest, "name" | "framework" | "libs" | "entry" | "integration" | "source">): AppManifest {
  return {
    title: "Conduit",
    domain: "blogging",
    server: { base: "/api", collections: [], ext: ["conduit"] },
    affordances: conduitAffordances,
    external: [
      { kind: "action", target: "articles", perMin: 4, data: [{ who: "grace" }, { who: "ken" }, { who: "frances" }] },
      { kind: "create", target: "comments", perMin: 3, data: [{ who: "ada", body: "Interesting." }, { who: "linus", body: "Patch welcome." }] },
      { kind: "update", target: "articles", perMin: 0.6 },
    ],
    errorSelector: ".error-messages li, [role=alert]",
    sessionMs: [30000, 80000],
    startMs: 1500,
    ...m,
  } as AppManifest;
}
