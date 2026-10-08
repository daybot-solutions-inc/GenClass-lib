import type { AppManifest } from "../../src/shared/manifest.js";

const tests = ["CBC", "Lipid panel", "HbA1c", "TSH", "CRP", "Ferritin"];
const st = ["pending", "pending", "received", "pending", "received", "resulted", "pending", "received", "pending", "pending", "resulted", "pending"];
const samples = st.map((status, i) => ({ id: 2600 + i, barcode: `LAB-${(48210 + i * 7).toString()}`, patient: `P-${1100 + (i % 7)}`, test: tests[i % tests.length], status, slot: status === "received" ? `R1-${i}` : "", value: status === "resulted" ? 5.2 + i : null }));

const manifest: AppManifest = {
  name: "mobx-lab",
  title: "Sample reception",
  framework: "mobx-react",
  libs: ["react", "mobx", "mobx-react-lite", "rt.guard", "fetch"],
  domain: "lab-sample-tracking",
  entry: "main.tsx",
  integration: "stores",
  server: { base: "/api", collections: [{ name: "samples", seed: samples, versioned: true, unique: ["slot"], filters: ["barcode", "status"], envelope: "items", pageSize: 40 }] },
  variants: {
    scanMode: ["queue", "parallel"],
    slotGuard: ["pending", "none"],
    counts: ["computed", "stored"],
    verify: ["if-match", "force"],
  },
  affordances: [
    { id: "scan", kind: "type", sel: "input[name=barcode]", values: ["LAB-48210", "LAB-48217", "LAB-48231", "LAB-48252", "LAB-48266", "LAB-48280"], clear: true, enter: true, weight: 3.5, mode: "accumulate", intent: "value" },
    { id: "slot", kind: "click", sel: "li.sample button.rack", nth: 4, weight: 2, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "li.sample button.rack" },
    { id: "result", kind: "type", sel: "li.sample input.value", nth: 3, values: ["4.8", "6.1", "132", "0.9"], clear: true, weight: 1.5, mode: "replace", intent: "nth", key: "result", requires: "li.sample input.value", then: ["verify"], sameNth: true },
    { id: "verify", kind: "click", sel: "li.sample button.verify", nth: 3, weight: 0, mode: "accumulate", followOnly: true, sameNth: true, dblclickP: 0.12 },
  ],
  external: [{ kind: "update", target: "samples", perMin: 3, where: { status: "received" }, data: [{ status: "processing" }, { status: "resulted", value: 7.4 }] }],
  weights: { "lab.error": 0, "lab.notice": 0, "lab.busy": 0.1, "lab.drafts": 0.3 },
  relations: [{ name: "status counts match samples", fields: ["lab.counts", "lab.samples"], check: (s) => !s.lab || ["pending", "received", "resulted"].every((k) => (s.lab.counts[k] ?? 0) === s.lab.samples.filter((x: { status: string }) => x.status === k).length) }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
