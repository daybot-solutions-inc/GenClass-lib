import type { AppManifest } from "../../src/shared/manifest.js";

const senders = ["Priya (Finance)", "GitHub", "Marco", "HR Team", "Jira", "Lena", "AWS Billing", "Tom"];
const subjects = ["Q3 budget sign-off", "[ci] build #4412 failed", "Lunch Thursday?", "Benefits enrollment closes Friday", "PROJ-311 assigned to you", "Slides for the offsite", "Your invoice is ready", "Re: hiring panel", "Contract renewal", "Weekly metrics", "Security training reminder", "Re: API deprecation plan", "Team photo", "Expense report approved", "Standup moved to 10:30", "Customer escalation: Acme"];
const archived = ["Offsite logistics", "Re: laptop refresh", "Holiday schedule", "[ci] build #4390 failed", "Old contract draft", "Welcome to the team!"];
const messages = [
  ...subjects.map((subject, i) => ({ id: 2000 + i, from: senders[i % senders.length], subject, folder: "inbox", label: i % 5 === 0 ? "work" : "", unread: i % 3 !== 2, seq: 7020 + i * 3 })),
  ...archived.map((subject, i) => ({ id: 1900 + i, from: senders[(i * 3) % senders.length], subject, folder: "archive", label: i % 2 ? "work" : "", unread: i === 1, seq: 7000 + i * 3 })),
];

type M = { unread: boolean };

const manifest: AppManifest = {
  name: "reducer-inbox",
  title: "Inbox",
  framework: "react",
  libs: ["react", "useGenClassState(reducer)", "fetch"],
  domain: "email",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "messages", seed: messages, envelope: "results", filters: ["folder"], pageSize: 50, seqField: "seq" }],
  },
  variants: {
    bulk: ["per-id", "assume-all", "per-id"],
    unread: ["recount", "skip-on-bulk"],
    folderGuard: [true, false],
    disableBulk: [true, false],
    pollMs: [10000, 4000],
  },
  affordances: [
    { id: "select", kind: "check", sel: "li.msg input.select", nth: 12, weight: 5, mode: "accumulate", intent: "nth" },
    { id: "selectAll", kind: "check", sel: "input.select-all", weight: 0.6, mode: "replace" },
    { id: "archive", kind: "click", sel: "button.archive", weight: 1.5, mode: "accumulate", after: ["select", "selectAll"], dblclickP: 0.12, impatientP: 0.25 },
    { id: "label", kind: "click", sel: "button.label-work", weight: 1, mode: "accumulate", after: ["select", "selectAll"], dblclickP: 0.1, impatientP: 0.15 },
    { id: "markRead", kind: "click", sel: "button.mark-read", weight: 1.2, mode: "accumulate", after: ["select", "selectAll"], dblclickP: 0.1, impatientP: 0.2 },
    { id: "open", kind: "click", sel: "li.msg button.subject", nth: 10, weight: 2.5, mode: "replace" },
    { id: "folder", kind: "click", sel: "nav.folders button", text: ["Inbox", "Inbox", "Archive"], weight: 1.2, mode: "replace" },
  ],
  external: [
    {
      kind: "create",
      target: "messages",
      perMin: 3,
      data: [
        { from: "Jira", subject: "PROJ-340 moved to Review", folder: "inbox", label: "", unread: true, seq: 7100 },
        { from: "Priya (Finance)", subject: "Re: Q3 budget sign-off", folder: "inbox", label: "work", unread: true, seq: 7101 },
        { from: "GitHub", subject: "[ci] build #4420 passed", folder: "inbox", label: "", unread: true, seq: 7102 },
      ],
    },
  ],
  weights: { "inbox.loading": 0.1, "inbox.busy": 0.1, "inbox.error": 0, "inbox.notice": 0.2, "inbox.selected": 0.3 },
  relations: [{ name: "unread == unread inbox messages", fields: ["inbox.unread", "inbox.messages"], check: (s) => !s.inbox || s.inbox.folder !== "inbox" || s.inbox.loading || s.inbox.unread === s.inbox.messages.filter((m: M) => m.unread).length }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
