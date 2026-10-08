import type { AppManifest } from "../../src/shared/manifest.js";

const subjects = [
  "Can't reset my password",
  "Invoice shows the wrong VAT rate",
  "App crashes when uploading a PDF",
  "Refund for order 5521",
  "SSO login loops back to the start",
  "Export stuck at 99%",
  "Add a teammate to our plan",
  "Webhook retries keep failing",
  "Change the billing address",
  "Data deletion request",
  "Dashboard is very slow today",
  "Rotate our API credentials",
];
const requesters = ["maria", "tomasz", "aiko", "femi", "grace", "luis"];
const statuses = ["open", "open", "pending", "open", "closed", "open", "pending", "open", "open", "closed", "open", "pending"];
const agents = ["", "lena", "", "omar", "jo", "", "lena", "", "omar", "", "", "jo"];
const prios = ["normal", "high", "urgent", "normal", "low", "high", "normal", "urgent", "low", "normal", "high", "normal"];
const tickets = subjects.map((subject, i) => ({ id: 4100 + i, subject, requester: requesters[i % requesters.length], status: statuses[i], priority: prios[i], assignee: agents[i] }));
const replies = ["Thanks, any update?", "I attached a screenshot.", "Still happening this morning.", "Can you escalate this please?", "That worked, thank you!", "Our finance team needs this today."];
const comments: Record<string, unknown>[] = [];
for (let i = 0; i < 14; i++) comments.push({ id: 7700 + i, ticketId: 4100 + (i % 7), author: i % 3 === 0 ? "lena" : requesters[i % requesters.length], body: replies[i % replies.length] });

const manifest: AppManifest = {
  name: "rtkq-helpdesk",
  title: "Helpdesk",
  framework: "react",
  libs: ["react", "@reduxjs/toolkit", "rtk-query", "react-redux", "fetchBaseQuery", "genclassEnhancer"],
  domain: "customer-support",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "tickets", seed: tickets, versioned: true, filters: ["status", "assignee"], search: ["subject", "requester"], envelope: "items", pageSize: 50 },
      { name: "comments", seed: comments, filters: ["ticketId"], envelope: "items", pageSize: 100, required: ["body"] },
    ],
  },
  variants: {
    undo: [true, false],
    invalidate: ["tags", "none", "tags"],
    claim: ["if-match", "force"],
    postGuard: ["disable", "none"],
    pollMs: [5000, 3000, 8000],
  },
  affordances: [
    { id: "view", kind: "click", sel: "nav.views button", text: ["Open", "Pending", "Mine", "Closed"], weight: 1.5, mode: "replace", key: "view" },
    { id: "open", kind: "click", sel: "li.ticket button.open", nth: 8, weight: 3, mode: "replace", key: "selected" },
    { id: "assign", kind: "click", sel: "li.ticket button.assign", nth: 6, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.12 },
    { id: "close", kind: "click", sel: "li.ticket button.close-ticket", nth: 6, weight: 2.5, mode: "accumulate", intent: "nth", dblclickP: 0.12, impatientP: 0.1 },
    { id: "comment", kind: "type", sel: "textarea[name=comment]", values: ["Thanks for the details, looking into it now.", "Could you share the request id?", "We pushed a fix, please try again.", "Escalated to engineering.", "Refund issued, it takes 3-5 days."], weight: 3, mode: "replace", clear: true, after: ["open"], then: ["post"] },
    { id: "post", kind: "click", sel: "button.post-comment", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.25 },
    { id: "reopen", kind: "click", sel: "aside.detail button.reopen", weight: 0.8, mode: "accumulate", after: ["open"], requires: "aside.detail button.reopen" },
    { id: "refresh", kind: "click", sel: "button.refetch", weight: 0.5, mode: "replace" },
  ],
  external: [
    { kind: "create", target: "tickets", perMin: 1.2, data: [{ subject: "Two-factor codes not arriving", requester: "nadia", status: "open", priority: "high", assignee: "" }, { subject: "Wrong currency on quote", requester: "pieter", status: "open", priority: "normal", assignee: "" }, { subject: "Cancel my subscription", requester: "sam", status: "open", priority: "low", assignee: "" }] },
    { kind: "update", target: "tickets", perMin: 3, data: [{ assignee: "lena" }, { assignee: "omar" }, { status: "pending" }, { priority: "urgent" }, { status: "closed" }] },
    { kind: "create", target: "comments", perMin: 1.5, data: [{ ticketId: 4100, author: "maria", body: "Any news on this?" }, { ticketId: 4101, author: "tomasz", body: "The VAT should be 19%." }, { ticketId: 4103, author: "femi", body: "Order number is 5521." }, { ticketId: 4105, author: "luis", body: "Export finished on its own." }] },
  ],
  weights: { "helpdesk.api": 0, "helpdesk.desk": 0.3 },
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
