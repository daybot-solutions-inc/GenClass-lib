import type { AppManifest } from "../../src/shared/manifest.js";

const F: [string, string][] = [["new-checkout", "New checkout flow"], ["dark-mode", "Dark mode"], ["search-v2", "Search ranking v2"], ["beta-banner", "Beta banner"], ["bulk-export", "Bulk CSV export"], ["ai-summaries", "Ticket summaries"]];
const flags: Record<string, unknown>[] = [];
let id = 10;
for (const env of ["dev", "staging", "prod"]) F.forEach(([key, name], i) => flags.push({ id: id++, env, key, name, enabled: env === "dev" || (env === "staging" && i % 2 === 0) || (env === "prod" && i === 1), rollout: env === "prod" ? [0, 100, 0, 0, 0, 0][i] : 100 }));

const manifest: AppManifest = {
  name: "react-flags",
  title: "Feature flags",
  framework: "react",
  libs: ["react", "@tanstack/react-query", "useGenClassState", "fetch"],
  domain: "feature-flag-admin",
  entry: "main.tsx",
  integration: "stores",
  server: { base: "/api", collections: [{ name: "flags", seed: flags, versioned: true, filters: ["env"], envelope: "items", pageSize: 30 }] },
  variants: {
    toggle: ["wait", "optimistic-rollback", "optimistic"],
    toggleGuard: ["pending", "none"],
    versioned: [true, false],
    rolloutSave: ["serial", "parallel"],
  },
  affordances: [
    { id: "env", kind: "click", sel: "nav.envs button", text: ["dev", "staging", "prod"], weight: 1.5, mode: "replace", key: "env" },
    { id: "toggle", kind: "click", sel: "tr.flag button.toggle", nth: 6, weight: 3.5, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.25 },
    { id: "rollout", kind: "type", sel: "tr.flag input.rollout", nth: 6, values: ["10", "25", "50", "100", "5"], clear: true, enter: true, weight: 2, mode: "replace", intent: "nth", key: "rollout" },
    { id: "kill", kind: "click", sel: "button.kill", weight: 0.4, mode: "accumulate", dblclickP: 0.1 },
  ],
  external: [{ kind: "update", target: "flags", perMin: 3, where: { env: "prod" }, data: [{ enabled: true }, { enabled: false }, { rollout: 20 }] }],
  weights: { "flagsUi.error": 0, "flagsUi.notice": 0, "flagsUi.pending": 0.1, "flagsUi.killing": 0.1 },
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
