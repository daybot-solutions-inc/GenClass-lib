import type { AppManifest } from "../../src/shared/manifest.js";

const units: [string, string, number, number][] = [
  ["Freezer A1", "Dock", -18, -18.4],
  ["Freezer A2", "Dock", -18, -17.9],
  ["Blast freezer B1", "Kitchen", -25, -24.6],
  ["Walk-in chiller C1", "Kitchen", 3, 3.4],
  ["Walk-in chiller C2", "Kitchen", 3, 5.6],
  ["Dairy cooler D1", "Retail", 4, 4.2],
  ["Produce cooler D2", "Retail", 6, 6.5],
  ["Ice cream case E1", "Retail", -20, -19.2],
  ["Reefer truck T1", "Fleet", -18, -16.9],
  ["Reefer truck T2", "Fleet", 2, 2.8],
];
const sensors = units.map(([name, zone, setpoint, temp], i) => ({ id: 400 + i, name, zone, setpoint, temp, acked: false }));

const manifest: AppManifest = {
  name: "rx-telemetry",
  title: "Cold-chain monitor",
  framework: "vanilla",
  libs: ["rxjs", "rxjs/webSocket", "rxjs/fetch(fromFetch)", "fetch", "rt.atom"],
  domain: "iot-monitoring",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      {
        name: "sensors",
        seed: sensors,
        live: true,
        pageSize: 50,
        envelope: "items",
        actions: { drift: { inc: "temp" }, ack: { set: { acked: true } } },
      },
    ],
  },
  variants: {
    reconnect: ["resync", "resubscribe", "none", "resubscribe"],
    smoothing: ["buffer", "throttle", "sample"],
    merge: ["newest", "replace", "replace"],
    alarmCount: ["derive", "on-snapshot"],
    setpointSend: ["debounce", "each", "each"],
  },
  affordances: [
    { id: "spUp", kind: "click", sel: ".sensor button.sp-up", nth: 10, intent: "nth", weight: 2.5, mode: "accumulate", burst: [0, 3], dblclickP: 0.1 },
    { id: "spDown", kind: "click", sel: ".sensor button.sp-down", nth: 10, intent: "nth", weight: 2, mode: "accumulate", burst: [0, 3], dblclickP: 0.1 },
    { id: "ack", kind: "click", sel: ".sensor button.ack", nth: 2, intent: "nth", weight: 1.5, mode: "accumulate", requires: ".sensor button.ack", dblclickP: 0.2 },
    { id: "zone", kind: "select", sel: "select[name=zone]", values: ["all", "Dock", "Kitchen", "Retail", "Fleet", "all"], weight: 1, mode: "replace" },
    { id: "pause", kind: "click", sel: "button.live", weight: 0.8, mode: "replace", key: "live", requires: "button.live:not(.paused)" },
    { id: "resume", kind: "click", sel: "button.live", weight: 2, mode: "replace", key: "live", requires: "button.live.paused", after: ["pause"] },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.6, mode: "replace", dblclickP: 0.1 },
  ],
  external: [
    // compressors cycling, doors opening: readings drift up and down
    { kind: "action", target: "sensors", verb: "drift", by: 0.4, perMin: 16 },
    { kind: "action", target: "sensors", verb: "drift", by: -0.5, perMin: 14 },
    { kind: "action", target: "sensors", verb: "drift", by: 2.2, perMin: 1.5 },
  ],
  weights: { "monitor.zone": 0.3, "monitor.loading": 0.1, "monitor.error": 0, "monitor.connected": 0.2, "monitor.live": 0.3 },
  relations: [
    {
      name: "alarmCount == count(sensors where temp > setpoint + 2 and not acked)",
      fields: ["monitor.alarmCount", "monitor.sensors"],
      check: (s) => !s.monitor || !Array.isArray(s.monitor.sensors) || s.monitor.alarmCount === s.monitor.sensors.filter((r: { temp: number; setpoint: number; acked: boolean }) => Number(r.temp) > Number(r.setpoint) + 2 && !r.acked).length,
    },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [30000, 70000],
};
export default manifest;
