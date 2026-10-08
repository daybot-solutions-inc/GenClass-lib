import type { AppManifest } from "../../src/shared/manifest.js";

const people: [string, string, string][] = [
  ["Ana", "Souza", "gmail.com"], ["Bilal", "Rahman", "outlook.com"], ["Chloé", "Martin", "proton.me"], ["Dmitri", "Volkov", "fastmail.com"],
  ["Esi", "Mensah", "gmail.com"], ["Farah", "Haddad", "studio-haddad.ca"], ["Gustavo", "Lima", "gmail.com"], ["Hana", "Sato", "icloud.com"],
  ["Ines", "Carvalho", "proton.me"], ["Jomo", "Kariuki", "gmail.com"], ["Kenji", "Watanabe", "outlook.com"], ["Lena", "Fischer", "posteo.de"],
  ["Mateo", "Rossi", "gmail.com"], ["Noor", "Aziz", "fastmail.com"], ["Oskar", "Nilsson", "gmail.com"], ["Priya", "Natarajan", "studio-np.com"],
  ["Quinn", "Taylor", "icloud.com"], ["Rosa", "Delgado", "gmail.com"], ["Sven", "Larsen", "outlook.com"], ["Tariq", "Saleh", "proton.me"],
  ["Uma", "Pillai", "gmail.com"], ["Viktor", "Horvat", "fastmail.com"], ["Wren", "Callahan", "wrenstudio.co"], ["Yara", "Costa", "gmail.com"],
  ["Zane", "Okoro", "outlook.com"], ["Amelie", "Brandt", "posteo.de"], ["Bruno", "Ferreira", "gmail.com"], ["Celia", "Ortega", "icloud.com"],
  ["Dario", "Conti", "gmail.com"], ["Elif", "Demir", "proton.me"], ["Femi", "Adeyemi", "gmail.com"], ["Greta", "Lund", "outlook.com"],
  ["Hugo", "Lefebvre", "fastmail.com"], ["Ivy", "Chen", "gmail.com"], ["Joel", "Mwangi", "studio-mwangi.com"], ["Kira", "Novak", "icloud.com"],
];
const ascii = (s: string) => s.normalize("NFD").replace(/[^a-zA-Z]/g, "").toLowerCase();
const subscribers = people.map(([first, last, domain], i) => ({
  id: 5100 + i,
  name: `${first} ${last}`,
  email: `${ascii(first)}.${ascii(last)}@${domain}`,
  status: i % 9 === 4 ? "bounced" : i % 7 === 3 ? "unsubscribed" : "active",
}));

const inFilter = (filter: string, status: string) => filter === "all" || (filter === "unsubscribed" ? status === "unsubscribed" : status !== "unsubscribed");

const manifest: AppManifest = {
  name: "nano-newsletter",
  title: "Newsletter subscribers",
  framework: "vanilla",
  libs: ["nanostores", "map/computed", "fetch", "AbortController", "rt.guard", "bearer auth + refresh"],
  domain: "newsletter-subscribers",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    auth: { ttlMs: 17000, rotate: true },
    collections: [{ name: "subscribers", seed: subscribers, protected: true, unique: ["email"], required: ["email"], search: ["email", "name"], filters: ["status"], envelope: "items", pageSize: 8 }],
  },
  variants: {
    refresh: ["single-flight", "concurrent"],
    cursor: ["reset-on-filter", "keep"],
    searchAbort: ["abort", "none"],
    addGuard: ["pending", "none"],
    bulk: ["per-item", "assume-all"],
  },
  affordances: [
    { id: "signIn", kind: "click", sel: "form.sign-in button.sign-in", weight: 0.02, mode: "accumulate", dblclickP: 0.1, impatientP: 0.15 },
    { id: "signInAgain", kind: "click", sel: "form.sign-in button.sign-in", weight: 0.8, mode: "accumulate", after: ["signIn"], requires: "form.sign-in button.sign-in:not([disabled])" },
    { id: "status", kind: "select", sel: "select[name=status]", values: ["subscribed", "unsubscribed", "all", "subscribed"], weight: 1.2, mode: "replace", after: ["signIn"], requires: "select[name=status]" },
    { id: "search", kind: "type", sel: "input[name=q]", values: ["gmail", "studio", "ana", "proton", "son"], clear: true, weight: 1.2, mode: "replace", key: "search", after: ["signIn"], requires: "input[name=q]" },
    { id: "more", kind: "click", sel: "button.more", weight: 2, mode: "accumulate", dblclickP: 0.15, impatientP: 0.2, after: ["signIn"], requires: "button.more:not([disabled])" },
    { id: "pick", kind: "check", sel: "tr.subscriber input.pick", nth: 8, intent: "nth", weight: 2.5, mode: "accumulate", after: ["signIn"], requires: "tr.subscriber input.pick" },
    { id: "unsubscribe", kind: "click", sel: "button.unsubscribe", weight: 1.2, mode: "accumulate", dblclickP: 0.1, impatientP: 0.2, after: ["pick"], requires: "button.unsubscribe:not([disabled])" },
    { id: "email", kind: "type", sel: "form.add input[name=email]", values: ["olu.adeyemi@fastmail.com", "mia.hart@proton.me", "ana.souza@gmail.com", "j.kowalski@outlook.com", "sam.reid@icloud.com"], clear: true, weight: 1.2, mode: "replace", after: ["signIn"], requires: "form.add input[name=email]", then: ["add"] },
    { id: "add", kind: "click", sel: "form.add button.add", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.2 },
  ],
  external: [
    { kind: "create", target: "subscribers", perMin: 3, data: [{ name: "Lucía Romero", email: "lucia.romero@gmail.com", status: "active" }, { name: "Theo Grant", email: "theo.grant@outlook.com", status: "active" }, { name: "Asha Iyer", email: "asha.iyer@proton.me", status: "active" }, { name: "Ben Ward", email: "ben.ward@icloud.com", status: "active" }] },
    { kind: "update", target: "subscribers", perMin: 1.5, where: { status: "active" }, data: [{ status: "bounced" }, { status: "unsubscribed" }] },
  ],
  weights: { "session.error": 0, "session.busy": 0.1, "audience.error": 0, "audience.notice": 0, "audience.loading": 0.1, "audience.loadingMore": 0.1, "audience.busy": 0.1, "audience.adding": 0.1, "audience.q": 0.3 },
  relations: [
    { name: "selection is listed", fields: ["audience.selected", "audience.rows"], check: (s) => !s.audience || s.audience.selected.every((id: number) => s.audience.rows.some((r: { id: number }) => r.id === id)) },
    { name: "rows match the status filter", fields: ["audience.rows", "audience.filter"], check: (s) => !s.audience || s.audience.loading || s.audience.rows.every((r: { status: string }) => inFilter(s.audience.filter, r.status)) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [30000, 60000],
};
export default manifest;
