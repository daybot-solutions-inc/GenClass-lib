import type { AppManifest } from "../../src/shared/manifest.js";

const rows: [string, string, string, string, number][] = [
  ["acme.io", "A", "@", "203.0.113.10", 3600], ["acme.io", "A", "www", "203.0.113.10", 3600], ["acme.io", "CNAME", "blog", "acme.ghost.io", 300], ["acme.io", "MX", "@", "10 mx1.mailhost.net", 3600],
  ["acme.io", "TXT", "@", "v=spf1 include:mailhost.net ~all", 300], ["acme.io", "CNAME", "status", "acme.statuspage.io", 300], ["acme.io", "TXT", "_dmarc", "v=DMARC1; p=none", 3600],
  ["acme.dev", "A", "@", "198.51.100.7", 300], ["acme.dev", "CNAME", "docs", "acme-docs.netlify.app", 300], ["acme.dev", "TXT", "@", "google-site-verification=abc123", 3600],
  ["shop.acme.io", "A", "@", "192.0.2.44", 600], ["shop.acme.io", "CNAME", "cdn", "shop.cdnprovider.net", 300], ["shop.acme.io", "TXT", "@", "stripe-verification=xyz", 3600],
];
const records = rows.map(([zone, type, name, value, ttl], i) => ({ id: 7700 + i, zone, type, name, value, ttl, fqdn: `${zone}|${type}|${name}|${value}` }));

const manifest: AppManifest = {
  name: "effector-dns",
  title: "DNS records",
  framework: "vanilla",
  libs: ["effector", "createEffect", "sample", "combine", "fetch", "rt.guard", "template-string DOM"],
  domain: "dns-management",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "records", seed: records, versioned: true, unique: ["fqdn"], required: ["zone", "type", "name", "value"], filters: ["zone", "type"], envelope: "items", pageSize: 50 }],
  },
  variants: {
    ttlSave: ["if-match", "force"],
    zoneSeq: ["latest", "blind"],
    addGuard: ["pending", "none"],
    bulk: ["per-item", "assume-all"],
    selection: ["prune", "keep"],
  },
  affordances: [
    { id: "zone", kind: "select", sel: "select[name=zone]", values: ["acme.io", "acme.dev", "shop.acme.io"], weight: 1.2, mode: "replace" },
    { id: "ttl", kind: "select", sel: "tr.record select.ttl", nth: 6, values: ["60", "300", "3600", "86400"], weight: 3, mode: "replace", intent: "nth", key: "ttl" },
    { id: "pick", kind: "check", sel: "tr.record input.pick", nth: 6, weight: 2, mode: "accumulate", intent: "nth" },
    { id: "deleteSel", kind: "click", sel: "button.delete-selected", weight: 0.8, mode: "accumulate", dblclickP: 0.1, impatientP: 0.2, requires: "button.delete-selected:not([disabled])" },
    { id: "name", kind: "type", sel: "form.add input[name=name]", values: ["api", "mail", "staging", "www2"], clear: true, weight: 1.5, mode: "replace", then: ["value", "add"] },
    { id: "value", kind: "type", sel: "form.add input[name=value]", values: ["203.0.113.50", "203.0.113.51", "198.51.100.9"], clear: true, weight: 0, mode: "replace", followOnly: true },
    { id: "add", kind: "click", sel: "form.add button", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.2, impatientP: 0.2 },
  ],
  external: [
    { kind: "update", target: "records", perMin: 3, where: { zone: "acme.io" }, data: [{ ttl: 600 }, { ttl: 120 }, { ttl: 1800 }] },
    { kind: "create", target: "records", perMin: 1, data: [{ zone: "acme.io", type: "TXT", name: "@", value: "openai-domain-verification=q1", ttl: 300, fqdn: "acme.io|TXT|@|openai-domain-verification=q1" }, { zone: "acme.dev", type: "CNAME", name: "preview", value: "acme-preview.vercel.app", ttl: 300, fqdn: "acme.dev|CNAME|preview|acme-preview.vercel.app" }] },
    { kind: "delete", target: "records", perMin: 0.6, where: { type: "TXT" } },
  ],
  weights: { "zone.error": 0, "zone.notice": 0, "zone.loading": 0.1, "zone.pending": 0.1, "zone.busy": 0.1, "form.name": 0.3, "form.value": 0.3, "form.adding": 0.1 },
  relations: [
    { name: "records belong to the zone", fields: ["zone.records", "zone.zone"], check: (s) => !s.zone || s.zone.loading || s.zone.records.every((r: { zone: string }) => r.zone === s.zone.zone) },
    { name: "selection is visible", fields: ["zone.selected", "zone.records"], check: (s) => !s.zone || s.zone.loading || s.zone.selected.every((id: number) => s.zone.records.some((r: { id: number }) => r.id === id)) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
