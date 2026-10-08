import type { AppManifest } from "../../src/shared/manifest.js";

const people: [string, string, string][] = [
  ["Ana Lopez", "Acme Corp", "lead"],
  ["Ben Carter", "Globex", "customer"],
  ["Chloe Martin", "Initech", "customer"],
  ["Dev Patel", "Acme Corp", "churned"],
  ["Elena Rossi", "Umbrella", "lead"],
  ["Frank Smith", "Hooli", "customer"],
  ["Grace Lee", "Globex", "lead"],
  ["Hassan Ali", "Stark Ind", "customer"],
  ["Ines Moreau", "Initech", "lead"],
  ["Jack Smithers", "Wayne Ent", "customer"],
  ["Kim Nguyen", "Hooli", "churned"],
  ["Leo Andersen", "Umbrella", "customer"],
  ["Maya Cohen", "Stark Ind", "lead"],
  ["Noah Leeds", "Acme Corp", "customer"],
];
const contacts = people.map(([name, company, stage], i) => ({ id: 800 + i, name, company, stage, email: `${name.split(" ")[0]!.toLowerCase()}@${company.split(" ")[0]!.toLowerCase()}.com`, phone: `+1 555 01${String(i).padStart(2, "0")}`, favorite: i % 4 === 1 }));
const notes = [
  { id: 1, contactId: 800, author: "you", text: "Asked for a demo next week." },
  { id: 2, contactId: 801, author: "you", text: "Renewal due in May." },
  { id: 3, contactId: 805, author: "sam", text: "Wants volume pricing." },
  { id: 4, contactId: 807, author: "you", text: "Champion left the company." },
];

type C = { favorite: boolean };

const manifest: AppManifest = {
  name: "router-crm",
  title: "Contacts CRM",
  framework: "react",
  libs: ["react", "react-router-dom@7", "createBrowserRouter", "loaders/actions", "useFetcher", "fetch", "rt.atom"],
  domain: "crm",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "contacts", seed: contacts, versioned: true, search: ["name", "company", "email"], envelope: "items", pageSize: 50, actions: { star: { toggle: "favorite" } }, unique: ["email"] },
      { name: "notes", seed: notes, filters: ["contactId"], envelope: "items", pageSize: 100, required: ["text"] },
    ],
  },
  variants: {
    abort: ["signal", "ignore", "ignore"],
    submitGuard: ["navigation-state", "none"],
    star: ["patch", "toggle"],
    noteGuard: ["fetcher-state", "none"],
  },
  affordances: [
    { id: "search", kind: "type", sel: "input[name=q]", values: ["an", "smith", "acme", "lee", "glob", "ma"], weight: 2.5, mode: "replace", clear: true },
    { id: "open", kind: "click", sel: "nav.contacts a", nth: 10, weight: 3.5, mode: "replace", key: "contact" },
    { id: "edit", kind: "click", sel: "a.edit", weight: 1.5, mode: "replace", key: "contact", requires: "a.edit", then: ["company", "save"] },
    { id: "company", kind: "type", sel: "form.edit input[name=company]", values: ["Acme Corp", "Globex EU", "Initech Labs", "Hooli XYZ"], weight: 0, mode: "replace", clear: true, followOnly: true },
    { id: "save", kind: "click", sel: "form.edit button.save", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.2 },
    { id: "note", kind: "type", sel: "textarea[name=note]", values: ["Called, left a voicemail.", "Sent the proposal.", "Follow up after the holidays.", "Interested in the Pro plan."], weight: 2, mode: "replace", clear: true, requires: "textarea[name=note]", then: ["addNote"] },
    { id: "addNote", kind: "click", sel: "button.add-note", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.15, impatientP: 0.2 },
    { id: "retry", kind: "click", sel: "button.retry", weight: 3, mode: "replace", key: "contact", requires: "button.retry" },
    { id: "star", kind: "click", sel: "button.favorite", weight: 1.5, mode: "accumulate", requires: "button.favorite", dblclickP: 0.15 },
  ],
  external: [
    { kind: "update", target: "contacts", perMin: 1.5, data: [{ stage: "customer" }, { stage: "churned" }, { phone: "+1 555 0199" }, { favorite: true }] },
    { kind: "create", target: "notes", perMin: 1, data: [{ contactId: 800, author: "sam", text: "Pinged on LinkedIn." }, { contactId: 805, author: "sam", text: "Budget approved." }] },
  ],
  weights: { "crm.error": 0, "crm.q": 0.3, "crm.recent": 0.5, "crm.loading": 0.1 },
  relations: [{ name: "starred == favorites in list", fields: ["crm.starred", "crm.contacts"], check: (s) => !s.crm || s.crm.starred === s.crm.contacts.filter((c: C) => c.favorite).length }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
