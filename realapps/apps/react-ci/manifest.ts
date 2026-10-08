import type { AppManifest } from "../../src/shared/manifest.js";

const branches = ["main", "release/2.4", "feat/search", "main", "fix/login", "main", "feat/search", "release/2.4"];
const statuses = ["passed", "running", "failed", "running", "queued", "passed", "failed", "passed"];
const pipelines = branches.map((branch, i) => ({ id: 3300 + i, branch, commit: `a${(91 + i * 37).toString(16)}f${i}`, title: ["Bump deps", "Release notes", "Index tuning", "Fix flaky test", "Login redirect", "Docs", "Facet counts", "Hotfix 2.4.1"][i], status: statuses[i], runs: 1 + (i % 2), duration: 120 + i * 33 }));
const jobs: Record<string, unknown>[] = [];
pipelines.forEach((p, i) => ["lint", "unit", "e2e", "deploy"].forEach((name, j) => jobs.push({ id: 7000 + i * 10 + j, pipelineId: p.id, name, status: j < 2 || p.status === "passed" ? "passed" : p.status === "failed" && j === 2 ? "failed" : "pending" })));

const manifest: AppManifest = {
  name: "react-ci",
  title: "CI pipelines",
  framework: "react",
  libs: ["react", "useGenClassState", "fetch"],
  domain: "ci-dashboard",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "pipelines", seed: pipelines, versioned: true, filters: ["branch", "status"], envelope: "items", pageSize: 30, actions: { rerun: { inc: "runs", by: 1 } } },
      { name: "jobs", seed: jobs, filters: ["pipelineId"], envelope: "items", pageSize: 20 },
    ],
  },
  variants: {
    pollMode: ["chain", "interval"],
    detailSeq: ["latest", "blind"],
    rerunGuard: ["disable", "none"],
    cancel: ["if-match", "force"],
    pollMs: [3000, 2000],
  },
  affordances: [
    { id: "branch", kind: "select", sel: "select[name=branch]", values: ["all", "main", "release/2.4", "feat/search"], weight: 1.5, mode: "replace" },
    { id: "open", kind: "click", sel: "tr.pipeline button.open", nth: 6, weight: 3, mode: "replace", key: "detail" },
    { id: "rerun", kind: "click", sel: "tr.pipeline button.rerun", nth: 6, weight: 2, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.25, requires: "tr.pipeline button.rerun" },
    { id: "cancel", kind: "click", sel: "tr.pipeline button.cancel", nth: 4, weight: 1.5, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "tr.pipeline button.cancel" },
    { id: "closeDetail", kind: "click", sel: "aside.jobs button.close", weight: 0.5, mode: "replace", key: "detail", after: ["open"], requires: "aside.jobs" },
  ],
  external: [
    { kind: "update", target: "pipelines", perMin: 5, where: { status: "running" }, data: [{ status: "passed" }, { status: "failed" }, { status: "passed" }] },
    { kind: "update", target: "pipelines", perMin: 3, where: { status: "queued" }, data: [{ status: "running" }] },
    { kind: "create", target: "pipelines", perMin: 1, data: [{ branch: "main", commit: "c0ffee1", title: "Merge #812", status: "queued", runs: 1, duration: 0 }, { branch: "feat/search", commit: "b4dd1e5", title: "Synonyms", status: "queued", runs: 1, duration: 0 }] },
    { kind: "update", target: "jobs", perMin: 4, where: { status: "pending" }, data: [{ status: "passed" }, { status: "running" }] },
  ],
  weights: { "ci.error": 0, "ci.notice": 0, "ci.loading": 0.1, "ci.busy": 0.1, "detail.loading": 0.1, "detail.error": 0 },
  relations: [{ name: "jobs belong to the open pipeline", fields: ["detail.jobs", "detail.id"], check: (s) => !s.detail || s.detail.jobs.every((j: { pipelineId: number }) => j.pipelineId === s.detail.id) }, { name: "failing count matches list", fields: ["ci.failing", "ci.items"], check: (s) => !s.ci || s.ci.failing === s.ci.items.filter((p: { status: string }) => p.status === "failed").length }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
