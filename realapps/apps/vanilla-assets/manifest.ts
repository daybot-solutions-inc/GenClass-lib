import type { AppManifest } from "../../src/shared/manifest.js";

const models: [string, string][] = [["laptop", "ThinkPad T14"], ["laptop", "MacBook Air 13"], ["monitor", "Dell U2723"], ["phone", "Pixel 8"], ["monitor", "LG 27UK850"], ["laptop", "XPS 13"], ["dock", "TB4 Dock"], ["phone", "iPhone 15"]];
const assets = Array.from({ length: 24 }, (_, i) => {
  const [kind, model] = models[i % models.length]!;
  const holder = i % 3 === 0 ? ["ana", "raj", "li", "max"][i % 4] : "";
  return { id: 7100 + i, tag: `IT-${String(1000 + i * 3)}`, kind, model, holder, status: holder ? "assigned" : i % 7 === 5 ? "repair" : "available" };
});

const manifest: AppManifest = {
  name: "vanilla-assets",
  title: "IT assets",
  framework: "vanilla",
  libs: ["axios", "AbortController", "rt.atom"],
  domain: "it-asset-inventory",
  entry: "main.ts",
  integration: "stores",
  server: { base: "/api", collections: [{ name: "assets", seed: assets, versioned: true, filters: ["kind", "status"], search: ["tag", "model", "holder"], envelope: "items", pageSize: 8 }] },
  variants: {
    pageSeq: ["abort", "none"],
    assignGuard: ["pending", "none"],
    assign: ["if-match", "force"],
    availCount: ["derive", "manual"],
  },
  affordances: [
    { id: "kind", kind: "select", sel: "select[name=kind]", values: ["", "laptop", "monitor", "phone", "dock"], weight: 1.5, mode: "replace" },
    { id: "search", kind: "type", sel: "input[name=q]", values: ["IT-10", "think", "ana", "pixel", "dell"], clear: true, weight: 1.2, mode: "replace", waitMs: 1 },
    { id: "page", kind: "click", sel: "nav.pager button", text: ["Prev", "Next"], weight: 1.5, mode: "replace", key: "page", impatientP: 0.15 },
    { id: "assignTo", kind: "select", sel: "select[name=assignee]", values: ["ana", "raj", "li", "max", "sam"], weight: 1, mode: "replace" },
    { id: "assign", kind: "click", sel: "tr.asset button.assign", nth: 5, weight: 2.5, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.2, requires: "tr.asset button.assign" },
    { id: "return", kind: "click", sel: "tr.asset button.return", nth: 5, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.12, requires: "tr.asset button.return" },
  ],
  external: [{ kind: "update", target: "assets", perMin: 3, where: { status: "available" }, data: [{ status: "assigned", holder: "helpdesk" }, { status: "repair" }] }],
  weights: { "assets.error": 0, "assets.notice": 0, "assets.loading": 0.1, "assets.busy": 0.1, "assets.q": 0.3 },
  relations: [{ name: "available count = available rows", fields: ["assets.available", "assets.rows"], check: (s) => !s.assets || s.assets.loading || s.assets.available === s.assets.rows.filter((r: { status: string }) => r.status === "available").length }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
