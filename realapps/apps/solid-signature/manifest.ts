import type { AppManifest } from "../../src/shared/manifest.js";

const envelopes = [
  { id: 910, title: "Office lease renewal", status: "sent", signers: 5 },
  { id: 911, title: "Contractor NDA — R. Gupta", status: "completed", signers: 1 },
  { id: 912, title: "Q2 vendor agreement", status: "draft", signers: 0 },
];
const signers = [
  { id: 1201, envelopeId: 910, name: "Dana Whitfield", email: "dana@landlord.example", status: "signed", reminders: 0, live: true },
  { id: 1202, envelopeId: 910, name: "Marcus Lee", email: "marcus@acme.example", status: "pending", reminders: 1, live: true },
  { id: 1203, envelopeId: 910, name: "Priya Shah", email: "priya@acme.example", status: "pending", reminders: 0, live: true },
  { id: 1206, envelopeId: 910, name: "Tom Becker", email: "tom@acme.example", status: "pending", reminders: 0, live: true },
  { id: 1207, envelopeId: 910, name: "Ana Lima", email: "ana@landlord.example", status: "pending", reminders: 0, live: true },
  { id: 1204, envelopeId: 911, name: "Ravi Gupta", email: "ravi@gupta.example", status: "signed", reminders: 0, live: true },
  { id: 1205, envelopeId: 912, name: "Hannah Ortiz", email: "hannah@vendor.example", status: "pending", reminders: 0, live: false },
];

const manifest: AppManifest = {
  name: "solid-signature",
  title: "E-signature envelopes",
  framework: "solid",
  libs: ["solid-js", "solid-js/html", "createMemo", "fetch", "rt.atom", "atomSignal"],
  domain: "e-signature",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "envelopes", seed: envelopes, versioned: true, required: ["title"], filters: ["status"], envelope: "items", pageSize: 20 },
      { name: "signers", seed: signers, required: ["envelopeId", "email"], filters: ["envelopeId", "status"], envelope: "items", pageSize: 30, actions: { remind: { inc: "reminders", by: 1 } } },
    ],
  },
  variants: {
    send: ["after-signers", "race"],
    addGuard: ["pending", "none"],
    remind: ["cooldown", "none"],
    poll: ["chain", "interval"],
    signedCount: ["derive", "incremental"],
  },
  affordances: [
    { id: "open", kind: "click", sel: "li.envelope button.open", nth: 4, weight: 1.5, mode: "replace", key: "envelope" },
    { id: "newEnvelope", kind: "click", sel: "button.new-envelope", weight: 1.2, mode: "accumulate", dblclickP: 0.1, impatientP: 0.15, then: ["firstName", "signerEmail", "addSigner"] },
    { id: "firstName", kind: "type", sel: "form.signer input[name=name]", values: ["Leo Martins", "Aiko Sato", "Femi Adeyemi", "Clara Novak"], clear: true, weight: 0, mode: "replace", followOnly: true },
    { id: "signerName", kind: "type", sel: "form.signer input[name=name]", values: ["Leo Martins", "Aiko Sato", "Femi Adeyemi", "Clara Novak"], clear: true, weight: 1.2, mode: "replace", requires: "form.signer", then: ["signerEmail", "addSigner"] },
    { id: "signerEmail", kind: "type", sel: "form.signer input[name=email]", values: ["leo@client.example", "aiko@client.example", "femi@client.example", "clara@client.example"], clear: true, weight: 0, mode: "replace", followOnly: true },
    { id: "addSigner", kind: "click", sel: "form.signer button", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.2 },
    { id: "send", kind: "click", sel: "button.send", weight: 1.6, mode: "accumulate", dblclickP: 0.15, impatientP: 0.25, requires: "button.send:not([disabled])" },
    { id: "remind", kind: "click", sel: "li.signer button.remind", nth: 3, weight: 1.2, mode: "accumulate", intent: "nth", dblclickP: 0.15, requires: "li.signer button.remind" },
  ],
  external: [{ kind: "update", target: "signers", perMin: 5, where: { status: "pending", live: true }, data: [{ status: "signed" }, { status: "signed" }, { status: "declined" }] }],
  weights: { "esign.error": 0, "esign.notice": 0, "esign.adding": 0.1, "esign.sending": 0.1, "esign.draft": 0.3, "esign.cooldown": 0 },
  relations: [
    { name: "signed count = signed signers", fields: ["esign.signedCount", "esign.signers"], check: (s) => !s.esign || s.esign.loading || s.esign.signedCount === s.esign.signers.filter((x: { status: string }) => x.status === "signed").length },
    { name: "a sent envelope lists all its signers", fields: ["esign.envelopes", "esign.signers"], check: (s) => { if (!s.esign || s.esign.loading) return true; const e = s.esign.envelopes.find((x: { id: number }) => x.id === s.esign.current); return !e || e.status === "draft" || e.signers === s.esign.signers.length; } },
  ],
  errorSelector: "[role=alert]",
  build: { jsx: "solid-html" },
  sessionMs: [25000, 60000],
};
export default manifest;
