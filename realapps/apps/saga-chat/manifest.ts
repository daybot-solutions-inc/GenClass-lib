import type { AppManifest } from "../../src/shared/manifest.js";

const customers = ["Priya", "Jonas", "Amelia", "Kwame", "Sofia", "Hiro"];
const subjects = ["Order arrived damaged", "Promo code not working", "Change delivery address", "Charged twice", "Size exchange", "Where is my parcel?"];
const conversations = customers.map((customer, i) => ({ id: 2100 + i, customer, subject: subjects[i], status: "open", channel: i % 2 ? "email" : "web" }));
const lines = ["Hi, I need help with my order", "It's order 88213", "Is anyone there?", "Thanks for the quick reply", "Could you check again?", "Photo attached"];
const messages: Record<string, unknown>[] = [];
const agentLines = ["Hi, Rita here, happy to help.", "Let me check that for you.", "I've asked the warehouse."];
for (let i = 0; i < 18; i++) {
  const agent = i % 3 === 2;
  messages.push({ id: 51000 + i, conversationId: 2100 + (i % 6), from: agent ? "agent" : "customer", author: agent ? "rita" : customers[i % 6], text: agent ? agentLines[(i + Math.floor(i / 6)) % 3] : lines[(i + Math.floor(i / 6)) % lines.length] });
}

type C = { unread: number };

const manifest: AppManifest = {
  name: "saga-chat",
  title: "Support inbox",
  framework: "react",
  libs: ["react", "redux", "react-redux", "redux-saga", "eventChannel", "websocket", "fetch", "genclassEnhancer"],
  domain: "customer-support-chat",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "conversations", seed: conversations, filters: ["status"], envelope: "bare", pageSize: 50 },
      { name: "messages", seed: messages, filters: ["conversationId"], live: true, envelope: "items", pageSize: 100, required: ["text"] },
    ],
  },
  variants: {
    selectTake: ["latest", "every", "every"],
    dedupe: ["clientId", "id"],
    clearDraft: ["on-send", "on-success"],
    reconnect: ["resync", "none"],
    unread: ["recount", "incremental"],
  },
  affordances: [
    { id: "select", kind: "click", sel: "li.conv button.select", nth: 6, weight: 3, mode: "replace", key: "conversation", dblclickP: 0.05 },
    { id: "reply", kind: "type", sel: "input[name=reply]", values: ["Sorry about that, let me check.", "Could you send the order number?", "I've issued a refund.", "A new parcel is on its way.", "Thanks, closing this now."], weight: 4, mode: "replace", clear: true, then: ["send"] },
    { id: "send", kind: "click", sel: "button.send", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.2 },
    { id: "resolve", kind: "click", sel: "button.resolve", weight: 0.8, mode: "accumulate", dblclickP: 0.1 },
  ],
  external: [
    { kind: "create", target: "messages", perMin: 10, data: [{ conversationId: 2100, from: "customer", author: "Priya", text: "Any update?" }, { conversationId: 2101, from: "customer", author: "Jonas", text: "The code is SPRING24" }, { conversationId: 2102, from: "customer", author: "Amelia", text: "New address is 4 Elm Row" }, { conversationId: 2103, from: "customer", author: "Kwame", text: "I see two charges on my card statement" }, { conversationId: 2104, from: "customer", author: "Sofia", text: "I need a medium instead" }, { conversationId: 2105, from: "customer", author: "Hiro", text: "Tracking hasn't moved in days" }] },
    { kind: "update", target: "conversations", perMin: 1, data: [{ status: "resolved" }, { status: "open" }, { status: "open" }] },
    { kind: "create", target: "conversations", perMin: 0.4, data: [{ customer: "Lena", subject: "Gift wrapping", status: "open", channel: "web" }, { customer: "Omar", subject: "Invoice copy", status: "open", channel: "email" }] },
  ],
  weights: { "support.draft": 0.3, "support.sending": 0.1, "support.loadingThread": 0.1, "support.connected": 0.2, "support.error": 0 },
  relations: [{ name: "unreadTotal == sum(conversations.unread)", fields: ["support.unreadTotal", "support.conversations"], check: (s) => !s.support || s.support.unreadTotal === s.support.conversations.reduce((a: number, c: C) => a + c.unread, 0) }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
