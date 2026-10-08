import type { AppManifest } from "../../src/shared/manifest.js";

const comps: [string, string][] = [
  ["Compute API", "compute"],
  ["Container Registry", "compute"],
  ["Serverless Functions", "compute"],
  ["Object Storage", "storage"],
  ["Block Volumes", "storage"],
  ["Backups", "storage"],
  ["Load Balancers", "network"],
  ["DNS", "network"],
  ["CDN Edge", "network"],
  ["Managed Postgres", "data"],
  ["Message Queues", "data"],
];
const services = comps.map(([name, group], i) => ({ id: 300 + i, name, group, status: i === 4 ? "degraded" : "operational", latencyMs: 30 + ((i * 17) % 90), uptime: 99.9 + ((i * 7) % 10) / 100 }));
const incidents = [
  { id: 900, title: "Elevated latency on Block Volumes in us-east-2", service: "Block Volumes", severity: "minor", state: "monitoring", updates: ["Investigating elevated attach latency.", "A fix has been deployed; monitoring."] },
  { id: 901, title: "DNS resolution failures for some zones", service: "DNS", severity: "major", state: "resolved", updates: ["Investigating resolution errors.", "Rolled back resolver config.", "Resolved."] },
  { id: 902, title: "Delayed backup snapshots", service: "Backups", severity: "minor", state: "resolved", updates: ["Snapshot queue is backed up.", "Queue drained; resolved."] },
  { id: 903, title: "Registry pushes intermittently failing", service: "Container Registry", severity: "major", state: "investigating", updates: ["We are investigating failed pushes with 502 errors."] },
  { id: 904, title: "Scheduled maintenance: Managed Postgres minor upgrade", service: "Managed Postgres", severity: "minor", state: "identified", updates: ["Maintenance window announced."] },
];

const manifest: AppManifest = {
  name: "jquery-status",
  title: "Northwind Cloud status",
  framework: "jquery",
  libs: ["jquery", "$.ajax(xhr)"],
  domain: "ops",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "services", seed: services, filters: ["group"], envelope: "data", pageSize: 50 },
      { name: "incidents", seed: incidents, filters: ["service", "state"], envelope: "data", pageSize: 50 },
      { name: "subscribers", seed: [], envelope: "data" },
    ],
  },
  variants: {
    overlap: ["skip", "overlap", "overlap"],
    onError: ["backoff", "tight-loop"],
    pollMs: [5000, 2500, 8000],
    detailGuard: ["latest", "none"],
    subscribeDisable: [true, false],
  },
  affordances: [
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 2, mode: "replace", dblclickP: 0.15, impatientP: 0.3 },
    { id: "group", kind: "select", sel: "select[name=group]", values: ["all", "compute", "storage", "network", "data"], weight: 2, mode: "replace" },
    { id: "tab", kind: "click", sel: "button.tab", text: ["Open", "Resolved"], weight: 1.2, mode: "replace" },
    { id: "incident", kind: "click", sel: "a.incident-link", nth: 4, weight: 2.5, mode: "replace" },
    { id: "close", kind: "click", sel: "button.close-detail", weight: 0.6, mode: "replace", after: ["incident"] },
    { id: "email", kind: "type", sel: "input[name=email]", values: ["ops@acme.io", "jane.doe@contoso.com", "sre-team@example.org", "pager@initech"], weight: 1, mode: "replace", clear: true, then: ["subscribe"] },
    { id: "subscribe", kind: "click", sel: "button.sub-btn", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.18, impatientP: 0.25 },
  ],
  external: [
    { kind: "update", target: "services", perMin: 5, data: [{ status: "degraded", latencyMs: 412 }, { status: "operational", latencyMs: 44 }, { status: "outage", latencyMs: 0 }, { latencyMs: 63 }, { status: "maintenance" }, { status: "operational", latencyMs: 38 }] },
    { kind: "create", target: "incidents", perMin: 0.7, data: [{ title: "Elevated 5xx on Object Storage", service: "Object Storage", severity: "major", state: "investigating", updates: ["We are investigating elevated error rates."] }, { title: "CDN cache purge delays", service: "CDN Edge", severity: "minor", state: "identified", updates: ["Purges are taking up to 10 minutes."] }] },
    { kind: "update", target: "incidents", perMin: 1.2, data: [{ state: "monitoring" }, { state: "resolved" }, { state: "identified" }] },
  ],
  sessionMs: [25000, 70000],
};
export default manifest;
