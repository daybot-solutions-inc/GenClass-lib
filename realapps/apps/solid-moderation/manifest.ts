import type { AppManifest } from "../../src/shared/manifest.js";

const msgs: [string, string, string][] = [
  ["spamking", "BUY CHEAP FOLLOWERS at my link!!!", "spam"], ["anna_k", "this ref is blind lol", "harassment"], ["troll42", "everyone here is an idiot", "harassment"],
  ["promo_bot", "Free gift cards, DM me", "spam"], ["mike_r", "can someone share the stream link?", "other"], ["spamking", "follow4follow!!!", "spam"],
  ["zed", "go back to where you came from", "hate"], ["lucy", "spoilers: the hero dies", "spoiler"],
];
const reports = msgs.map(([author, text, reason], i) => ({ id: 300 + i, author, text, reason, status: "open", channel: i % 2 ? "#general" : "#live" }));
const users = [...new Set(msgs.map(([a]) => a))].map((name, i) => ({ id: 70 + i, name, banned: false }));

const manifest: AppManifest = {
  name: "solid-moderation",
  title: "Moderation queue",
  framework: "solid",
  libs: ["solid-js", "solid-js/html", "fetch", "WebSocket", "rt.atom", "atomSignal"],
  domain: "chat-moderation",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "reports", seed: reports, versioned: true, live: true, filters: ["status", "author", "reason"], envelope: "items", pageSize: 40 },
      { name: "users", seed: users, filters: ["name"], envelope: "items", actions: { ban: { set: { banned: true } } } },
    ],
  },
  variants: {
    live: ["dedupe", "append"],
    actionGuard: ["pending", "none"],
    reconnect: ["resync", "naive"],
    claim: ["if-match", "none"],
    queueCount: ["derive", "manual"],
  },
  affordances: [
    { id: "reason", kind: "select", sel: "select[name=reason]", values: ["all", "spam", "harassment", "hate", "spoiler"], weight: 1.2, mode: "replace" },
    { id: "approve", kind: "click", sel: "li.report button.approve", nth: 5, weight: 2.5, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "li.report button.approve" },
    { id: "remove", kind: "click", sel: "li.report button.remove", nth: 5, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "li.report button.remove" },
    { id: "ban", kind: "click", sel: "li.report button.ban", nth: 4, weight: 1, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.report button.ban" },
  ],
  external: [
    { kind: "create", target: "reports", perMin: 4, data: [{ author: "spamking", text: "cheap followers again!!", reason: "spam", status: "open", channel: "#live" }, { author: "newbie", text: "is this the right channel?", reason: "other", status: "open", channel: "#general" }, { author: "troll42", text: "you all are clowns", reason: "harassment", status: "open", channel: "#live" }] },
    { kind: "update", target: "reports", perMin: 2.5, where: { status: "open" }, data: [{ status: "removed" }, { status: "approved" }] },
  ],
  weights: { "mod.error": 0, "mod.notice": 0, "mod.pending": 0.1, "mod.live": 0.1, "mod.reason": 0.3 },
  relations: [
    { name: "queue count = open reports", fields: ["mod.openCount", "mod.reports"], check: (s) => !s.mod || s.mod.openCount === s.mod.reports.filter((r: { status: string }) => r.status === "open").length },
    { name: "no duplicate reports", fields: ["mod.reports"], check: (s) => !s.mod || new Set(s.mod.reports.map((r: { id: number }) => r.id)).size === s.mod.reports.length },
  ],
  errorSelector: "[role=alert]",
  build: { jsx: "solid-html" },
  sessionMs: [25000, 60000],
};
export default manifest;
