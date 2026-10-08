import type { AppManifest } from "../../src/shared/manifest.js";

const channels = ["general", "random", "deploys", "support"].map((name, i) => ({ id: i + 1, name }));
const people = ["ana", "bo", "cy", "dee"];
const messages: Record<string, unknown>[] = [];
for (let i = 0; i < 24; i++) messages.push({ id: 5000 + i, channel: channels[i % 4]!.name, author: people[i % 4], text: `message ${i} about ${["the build", "lunch", "the outage", "a ticket"][i % 4]}` });

const manifest: AppManifest = {
  name: "svelte-chat",
  title: "Team chat",
  framework: "svelte",
  libs: ["svelte", "fetch", "websocket", "svelte-store(rt.atom)"],
  domain: "chat",
  entry: "main.ts",
  integration: "stores",
  build: { svelte: true },
  server: {
    base: "/api",
    collections: [
      { name: "channels", seed: channels, envelope: "bare" },
      { name: "messages", seed: messages, filters: ["channel"], live: true, envelope: "items", pageSize: 50 },
    ],
  },
  variants: {
    dedupe: ["clientId", "none", "id", "none"],
    optimistic: [true, false, true],
    replace: ["clientId", "append"],
    disableWhileSending: [true, false, false],
    countOnPush: [true, false],
    reconnect: ["resync", "naive", "none"],
    channelGuard: [true, false],
  },
  affordances: [
    { id: "draft", kind: "type", sel: "input[name=draft]", values: ["on it", "deploying now", "lunch?", "PR is up", "rolled back", "thanks!", "can you check the logs"], weight: 5, mode: "replace", clear: true, then: ["send"] },
    { id: "send", kind: "click", sel: "button.send", weight: 0, mode: "accumulate", dblclickP: 0.15, impatientP: 0.2, followOnly: true },
    { id: "channel", kind: "click", sel: "button.channel", nth: 4, weight: 2, mode: "replace" },
  ],
  external: [{ kind: "create", target: "messages", perMin: 8, data: [{ channel: "general", author: "bo", text: "anyone around?" }, { channel: "deploys", author: "cy", text: "deploy 1.4.2 done" }, { channel: "random", author: "dee", text: "coffee time" }, { channel: "support", author: "ana", text: "ticket #881 escalated" }] }],
  weights: { "chat.draft": 0.3, "chat.sending": 0.1, "chat.error": 0, "chat.connected": 0.2 },
  relations: [{ name: "count == len(messages)", fields: ["chat.count", "chat.messages"], check: (s) => !s.chat || s.chat.count === s.chat.messages.length }],
  sessionMs: [25000, 70000],
};
export default manifest;
