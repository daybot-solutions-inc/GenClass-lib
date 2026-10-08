import type { AppManifest } from "../../src/shared/manifest.js";

const plots = Array.from({ length: 14 }, (_, i) => {
  const taken = (i * 5) % 7 === 0 || i % 6 === 4;
  return { id: 200 + i, bed: `${"ABC"[i % 3]}${1 + Math.floor(i / 3)}`, size: i % 3 === 2 ? "large" : "small", status: taken ? "taken" : "free", holder: taken ? "neighbour" : "", fee: i % 3 === 2 ? 40 : 25 };
});

const manifest: AppManifest = {
  name: "petite-garden",
  title: "Community garden plots",
  framework: "petite-vue",
  libs: ["petite-vue", "fetch", "rt.atom(reactive mirror)"],
  domain: "community-garden",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "plots", seed: plots, versioned: true, filters: ["size", "status"], envelope: "items", pageSize: 30 }],
    docs: [{ name: "watering", init: { mon: "Bo", tue: "", wed: "Lin", thu: "", fri: "", sat: "", sun: "Grace" }, versioned: true }],
  },
  variants: {
    claim: ["if-match", "force"],
    claimGuard: ["pending", "none"],
    poll: ["pending-aware", "blind"],
    watering: ["patch-if-match", "put-whole"],
    fees: ["derive", "incremental"],
  },
  affordances: [
    { id: "size", kind: "click", sel: "nav.sizes button", text: ["All", "small", "large"], weight: 0.8, mode: "replace", key: "size" },
    { id: "claim", kind: "click", sel: "li.plot.free button.claim", nth: 6, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "li.plot.free button.claim" },
    { id: "release", kind: "click", sel: "li.plot.mine button.release", nth: 2, weight: 1, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.plot.mine button.release" },
    { id: "water", kind: "click", sel: "table.watering button.take", nth: 7, weight: 2, mode: "accumulate", intent: "nth", dblclickP: 0.1, impatientP: 0.15, requires: "table.watering button.take" },
  ],
  external: [
    { kind: "update", target: "plots", perMin: 3, where: { status: "free" }, data: [{ status: "taken", holder: "neighbour" }] },
    { kind: "update", target: "plots", perMin: 1.5, where: { holder: "neighbour" }, data: [{ status: "free", holder: "" }] },
    { kind: "doc", target: "watering", perMin: 2.5, data: [{ tue: "Ahmed" }, { thu: "Rosa" }, { fri: "Kai" }, { sat: "Ahmed" }, { mon: "" }, { sun: "" }] },
  ],
  weights: { "garden.error": 0, "garden.notice": 0, "garden.pending": 0.1, "garden.size": 0.3, "garden.waterVersion": 0 },
  relations: [{ name: "season fees = fees of my plots", fields: ["garden.fees", "garden.plots"], check: (s) => !s.garden || s.garden.fees === s.garden.plots.filter((p: { holder: string }) => p.holder === "you").reduce((a: number, p: { fee: number }) => a + p.fee, 0) }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
