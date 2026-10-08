import type { AppManifest } from "../../src/shared/manifest.js";

const senders = ["Dana Whitfield", "GitLab", "Priya Raman", "Acme Billing", "Marco Bellini", "Figma", "Hiring Team", "Lena Vogt", "Calendar", "Travel Desk"];
const subjects: Record<string, string[]> = {
  inbox: ["Q2 offsite agenda", "Contract redlines attached", "Lunch Thursday?", "Design crit notes", "Re: onboarding checklist", "Customer escalation #4471", "Re: budget numbers", "Draft blog post for review", "Interview feedback: backend loop", "Re: API deprecation timeline", "Weekend on-call swap", "Board deck v3", "Re: vendor security review", "Welcome our new PM", "Photos from the retreat", "Re: invoice discrepancy"],
  updates: ["Pipeline #8812 failed", "Your invoice for March", "New comment on 'Checkout v2'", "Security alert: new sign-in", "Weekly digest", "Merge request approved", "Storage quota at 80%", "Calendar: 1:1 moved", "Release 4.2.0 published", "Password expires in 7 days"],
  promotions: ["Spring sale: 30% off", "Your exclusive invite", "Last chance: conference tickets", "We miss you", "New arrivals this week", "Earn double points", "Free shipping weekend", "Webinar: scaling Postgres"],
  archive: ["Expense report approved", "Re: lease renewal", "Tax documents 2025", "Flight confirmation LHR", "Re: old roadmap", "Offer letter signed"],
};
const messages: Record<string, unknown>[] = [];
let n = 0;
for (const [folder, subs] of Object.entries(subjects)) {
  subs.forEach((subject, i) => {
    const day = 28 - Math.floor(n / 2);
    messages.push({
      id: 7000 + n,
      folder,
      from: senders[(n * 3) % senders.length],
      subject,
      snippet: `${subject.replace(/^Re: /, "")} — a few quick notes before tomorrow.`,
      body: `Hi,\n\nFollowing up on "${subject}". Let me know what you think.\n\nThanks`,
      read: folder === "archive" || (n * 7) % 3 === 0,
      createdAt: `2026-03-${String(Math.max(1, day)).padStart(2, "0")}T${String(8 + (i % 10)).padStart(2, "0")}:15:00.000Z`,
    });
    n++;
  });
}

const manifest: AppManifest = {
  name: "lit-inbox",
  title: "Mail",
  framework: "lit",
  libs: ["lit", "fetch", "rt.atom(reactive controller)"],
  domain: "email",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "messages", seed: messages, filters: ["folder", "read"], envelope: "items", pageSize: 6, actions: { "toggle-read": { toggle: "read" } } }],
  },
  variants: {
    loadGuard: ["inflight", "none", "none"],
    folderGuard: ["token", "none"],
    readWrite: ["absolute", "relative"],
    badge: ["derive", "incremental", "incremental"],
    pageSize: [6, 5, 8],
  },
  affordances: [
    { id: "folder", kind: "click", sel: "inbox-app >>> nav button.folder", text: ["Inbox", "Updates", "Promotions", "Archive"], weight: 2, mode: "replace" },
    { id: "more", kind: "click", sel: "inbox-app >>> button.load-more", weight: 2.5, mode: "accumulate", dblclickP: 0.2, impatientP: 0.3 },
    { id: "toggle", kind: "click", sel: "inbox-app >>> message-row >>> button.toggle-read", nth: 8, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.12 },
    { id: "open", kind: "click", sel: "inbox-app >>> message-row >>> button.open", nth: 8, weight: 2.5, mode: "replace" },
    { id: "markAll", kind: "click", sel: "inbox-app >>> button.mark-all", weight: 0.6, mode: "accumulate", dblclickP: 0.1 },
    { id: "check", kind: "click", sel: "inbox-app >>> button.check-mail", weight: 1, mode: "replace", impatientP: 0.2 },
    { id: "close", kind: "click", sel: "inbox-app >>> button.close-reader", weight: 0.5, mode: "replace", after: ["open"] },
  ],
  external: [
    { kind: "create", target: "messages", perMin: 2, data: [
      { folder: "inbox", from: "Dana Whitfield", subject: "Re: Q2 offsite agenda", snippet: "Works for me — can we add a retro slot?", body: "Works for me.", read: false },
      { folder: "inbox", from: "Priya Raman", subject: "Quick question about the rollout", snippet: "Do we gate it behind the flag?", body: "Do we gate it?", read: false },
      { folder: "updates", from: "GitLab", subject: "Pipeline #8840 passed", snippet: "All 212 jobs passed.", body: "Pipeline passed.", read: false },
    ] },
    { kind: "update", target: "messages", perMin: 1, data: [{ read: true }, { read: false }] },
  ],
  weights: { "inbox.loading": 0.1, "inbox.loadingMore": 0.1, "inbox.error": 0, "reader.loading": 0.1, "reader.error": 0 },
  relations: [{ name: "unread badge == unread messages shown", fields: ["inbox.unread", "inbox.items"], check: (s) => !s.inbox || s.inbox.unread === s.inbox.items.filter((m: { read: boolean }) => !m.read).length }],
  sessionMs: [25000, 70000],
};
export default manifest;
