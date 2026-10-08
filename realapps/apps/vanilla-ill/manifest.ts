import type { AppManifest } from "../../src/shared/manifest.js";

const T: [string, string, string, string][] = [
  ["The Structure of Scientific Revolutions", "Thomas Kuhn", "9780226458120", "Univ. of Leeds"], ["Seeing Like a State", "James C. Scott", "9780300078152", "Bodleian"],
  ["The Death and Life of Great American Cities", "Jane Jacobs", "9780679741954", "Glasgow"], ["Gödel, Escher, Bach", "Douglas Hofstadter", "9780465026562", "Cambridge UL"],
  ["The Making of the English Working Class", "E. P. Thompson", "9780394703220", "Manchester"], ["Orientalism", "Edward Said", "9780394740676", "SOAS"],
  ["Silent Spring", "Rachel Carson", "9780618249060", "Edinburgh"], ["The Order of Things", "Michel Foucault", "9780679753353", "UCL"],
  ["A Pattern Language", "Christopher Alexander", "9780195019193", "Bath"], ["The Wealth of Nations", "Adam Smith", "9780553585971", "St Andrews"],
];
const catalog = T.map(([title, author, isbn, holder], i) => ({ id: 1300 + i, title, author, isbn, holder }));
const requests = [
  { id: 61, isbn: "9780300078152", title: "Seeing Like a State", status: "shipped", holder: "Bodleian" },
  { id: 62, isbn: "9780618249060", title: "Silent Spring", status: "requested", holder: "Edinburgh" },
];

const manifest: AppManifest = {
  name: "vanilla-ill",
  title: "Interlibrary loans",
  framework: "vanilla",
  libs: ["ky", "rt.atom"],
  domain: "library-interlibrary-loan",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "catalog", seed: catalog, search: ["title", "author", "isbn"], envelope: "results", pageSize: 8 },
      { name: "requests", seed: requests, versioned: true, unique: ["isbn"], required: ["isbn"], envelope: "results", pageSize: 30 },
    ],
  },
  variants: {
    searchSeq: ["latest", "blind"],
    requestGuard: ["disable", "none"],
    statusPoll: ["keep-pending", "blind"],
    cancel: ["if-match", "force"],
    activeCount: ["derive", "manual"],
  },
  affordances: [
    { id: "search", kind: "type", sel: "input[name=q]", values: ["the", "struct", "jac", "ord", "97803", "silent"], clear: true, weight: 2.5, mode: "replace", waitMs: 1 },
    { id: "request", kind: "click", sel: "li.hit button.request", nth: 5, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.18, impatientP: 0.25, requires: "li.hit button.request" },
    { id: "cancel", kind: "click", sel: "li.req button.cancel", nth: 3, weight: 1.2, mode: "accumulate", intent: "nth", requires: "li.req button.cancel", dblclickP: 0.1 },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.5, mode: "replace" },
  ],
  external: [
    { kind: "update", target: "requests", perMin: 3, where: { status: "requested" }, data: [{ status: "shipped" }] },
    { kind: "update", target: "requests", perMin: 2, where: { status: "shipped" }, data: [{ status: "arrived" }] },
  ],
  weights: { "ill.error": 0, "ill.notice": 0, "ill.searching": 0.1, "ill.busy": 0.1, "ill.q": 0.3 },
  relations: [
    { name: "active count = active requests", fields: ["ill.active", "ill.requests"], check: (s) => !s.ill || s.ill.active === s.ill.requests.filter((r: { status: string }) => r.status !== "cancelled" && r.status !== "arrived").length },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
