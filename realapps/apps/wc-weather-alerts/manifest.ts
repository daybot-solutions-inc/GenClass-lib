import type { AppManifest } from "../../src/shared/manifest.js";

const subscriptions = [
  { id: 51, region: "coastal-north", minSeverity: "watch", muted: false, channel: "push" },
  { id: 52, region: "valley-east", minSeverity: "advisory", muted: false, channel: "push" },
];
const alerts = [
  { id: 9001, region: "coastal-north", severity: "warning", headline: "High surf warning, waves 4–6 m", until: "18:00", acked: false },
  { id: 9002, region: "coastal-north", severity: "advisory", headline: "Small craft advisory", until: "21:00", acked: true },
  { id: 9003, region: "coastal-south", severity: "watch", headline: "Coastal flood watch at high tide", until: "16:30", acked: false },
  { id: 9004, region: "valley-east", severity: "watch", headline: "Excessive heat watch, highs near 41 °C", until: "20:00", acked: false },
  { id: 9005, region: "valley-west", severity: "advisory", headline: "Air quality advisory (ozone)", until: "19:00", acked: false },
  { id: 9006, region: "highlands", severity: "warning", headline: "Winter storm warning above 1,800 m", until: "23:00", acked: false },
  { id: 9007, region: "metro", severity: "advisory", headline: "Dense fog advisory for the ring road", until: "10:30", acked: false },
  { id: 9008, region: "valley-east", severity: "advisory", headline: "Wind advisory, gusts to 70 km/h", until: "17:00", acked: false },
];
const regions = ["coastal-north", "coastal-south", "valley-east", "valley-west", "highlands", "metro"];

const manifest: AppManifest = {
  name: "wc-weather-alerts",
  title: "Regional Weather Alerts",
  framework: "custom-elements",
  libs: ["customElements", "shadow DOM", "fetch", "rt.atom"],
  domain: "public-safety",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "subscriptions", seed: subscriptions, envelope: "bare", required: ["region"] },
      { name: "alerts", seed: alerts, envelope: "bare", filters: ["region"], pageSize: 50, actions: { ack: { set: { acked: true } }, "toggle-ack": { toggle: "acked" } } },
    ],
  },
  variants: {
    subGuard: ["inflight", "exists-only", "none"],
    pollCleanup: [true, true, false],
    rowRender: ["keyed", "replace"],
    poll: ["chain", "interval"],
    pollMs: [5000, 3000],
    ack: ["set", "toggle"],
  },
  affordances: [
    { id: "region", kind: "select", sel: "wx-app >>> wx-picker >>> select[name=region]", values: regions, weight: 1.6, mode: "replace", then: ["subscribe"] },
    { id: "severity", kind: "select", sel: "wx-app >>> wx-picker >>> select[name=severity]", values: ["advisory", "watch", "warning"], weight: 0.6, mode: "replace" },
    { id: "subscribe", kind: "click", sel: "wx-app >>> wx-picker >>> button.subscribe", weight: 0.8, mode: "accumulate", dblclickP: 0.2, impatientP: 0.3 },
    { id: "mute", kind: "click", sel: "wx-app >>> wx-subscriptions >>> wx-sub-row >>> button.mute", nth: 4, weight: 1.6, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "wx-app >>> wx-subscriptions >>> wx-sub-row >>> button.mute" },
    { id: "unsubscribe", kind: "click", sel: "wx-app >>> wx-subscriptions >>> wx-sub-row >>> button.remove", nth: 4, weight: 0.6, mode: "accumulate", intent: "nth", requires: "wx-app >>> wx-subscriptions >>> wx-sub-row >>> button.remove" },
    { id: "ack", kind: "click", sel: "wx-app >>> wx-feed >>> button.ack", nth: 5, weight: 2.4, mode: "accumulate", intent: "nth", dblclickP: 0.18, requires: "wx-app >>> wx-feed >>> button.ack" },
  ],
  external: [
    { kind: "create", target: "alerts", perMin: 2.5, data: [
      { region: "coastal-north", severity: "watch", headline: "Rip current watch", until: "19:00", acked: false },
      { region: "valley-east", severity: "warning", headline: "Excessive heat warning, highs near 43 °C", until: "21:00", acked: false },
      { region: "metro", severity: "watch", headline: "Flash flood watch for low-lying underpasses", until: "22:00", acked: false },
      { region: "highlands", severity: "advisory", headline: "Black ice advisory on mountain passes", until: "09:00", acked: false },
      { region: "coastal-south", severity: "warning", headline: "Storm surge warning", until: "02:00", acked: false },
    ] },
    { kind: "update", target: "alerts", perMin: 2, data: [{ severity: "warning" }, { severity: "advisory" }, { until: "23:30" }, { acked: false }] },
    { kind: "delete", target: "alerts", perMin: 0.8 },
  ],
  weights: { "subs.loading": 0.1, "subs.adding": 0.1, "subs.error": 0, "subs.notice": 0, "feed.error": 0 },
  relations: [
    { name: "one subscription per region", fields: ["subs.items"], check: (s) => !s.subs || new Set(s.subs.items.map((x: { region: string }) => x.region)).size === s.subs.items.length },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
