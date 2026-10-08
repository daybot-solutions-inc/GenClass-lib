import type { AppManifest } from "../../src/shared/manifest.js";

const roles = ["Frontend engineer", "Backend engineer", "Product designer", "Data analyst", "Data engineer", "Product manager", "Site reliability engineer", "UX researcher", "Mobile engineer", "ML engineer"];
const companies = ["Northwind", "Lumen Labs", "Kestrel Health", "Bluefin", "Orchard", "Papaya Pay", "Tundra Games", "Civic Data Co"];
const cities = ["Toronto", "Montréal", "Vancouver", "Waterloo", "Calgary"];
const jobs = Array.from({ length: 40 }, (_, i) => ({ id: 6200 + i, title: roles[(i * 3) % 10], company: companies[(i * 5) % 8], city: cities[i % 5], remote: i % 3 === 0, salary: 85 + ((i * 17) % 70), posted: 80 - i }));

const manifest: AppManifest = {
  name: "rx-jobs",
  title: "Job board",
  framework: "vanilla",
  libs: ["rxjs", "fromEvent", "debounceTime", "switchMap/exhaustMap", "scan", "rxjs/fetch(fromFetch)", "fetch"],
  domain: "job-board",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "jobs", seed: jobs, search: ["title", "company", "city"], filters: ["remote", "city"], envelope: "items", pageSize: 6 },
      { name: "saved", seed: [{ id: 1, jobId: 6203 }], unique: ["jobId"], required: ["jobId"], envelope: "items", pageSize: 50 },
      { name: "applications", seed: [], required: ["jobId"], envelope: "items" },
    ],
  },
  variants: {
    search: ["switchMap", "mergeMap"],
    debounce: [300, 0],
    more: ["exhaustMap", "mergeMap"],
    save: ["optimistic-rollback", "optimistic"],
    applyGuard: ["pending", "none"],
  },
  affordances: [
    { id: "search", kind: "type", sel: "input[name=q]", values: ["engineer", "design", "data", "product", "toronto"], clear: true, weight: 2, mode: "replace", key: "search" },
    { id: "remote", kind: "check", sel: "input[name=remote]", weight: 0.8, mode: "replace", key: "remote" },
    { id: "more", kind: "click", sel: "button.more", weight: 2.5, mode: "accumulate", dblclickP: 0.2, impatientP: 0.2, requires: "button.more:not([disabled])" },
    { id: "save", kind: "click", sel: "li.job button.save", nth: 6, weight: 2, mode: "accumulate", intent: "nth", dblclickP: 0.15, requires: "li.job button.save" },
    { id: "apply", kind: "click", sel: "li.job button.apply", nth: 6, weight: 1.2, mode: "accumulate", intent: "nth", dblclickP: 0.2, impatientP: 0.25, requires: "li.job button.apply" },
  ],
  external: [
    { kind: "create", target: "jobs", perMin: 2, data: [{ title: "Staff frontend engineer", company: "Orchard", city: "Toronto", remote: true, salary: 165, posted: 100 }, { title: "Data engineer", company: "Kestrel Health", city: "Waterloo", remote: false, salary: 120, posted: 100 }, { title: "Product designer", company: "Papaya Pay", city: "Montréal", remote: true, salary: 110, posted: 100 }, { title: "Backend engineer", company: "Tundra Games", city: "Vancouver", remote: false, salary: 130, posted: 100 }] },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
