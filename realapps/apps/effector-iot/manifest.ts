import type { AppManifest } from "../../src/shared/manifest.js";

const devs: [string, string, string, number, number][] = [
  ["Lobby thermostat", "Lobby", "thermostat", 21, 20.6],
  ["Meeting room A", "Floor 2", "thermostat", 22, 21.8],
  ["Server closet", "Floor 2", "thermostat", 18, 19.4],
  ["Kitchen", "Floor 3", "thermostat", 21.5, 22.3],
  ["Open office", "Floor 3", "thermostat", 21, 20.9],
];
const devices = devs.map(([name, room, kind, setpoint, temp], i) => ({ id: 40 + i, name, room, kind, setpoint, temp, on: true, online: true }));
const readings: Record<string, unknown>[] = [];
for (let i = 0; i < 30; i++) {
  const d = devs[i % 5]!;
  readings.push({ id: 90000 + i, deviceId: 40 + (i % 5), temp: Math.round((d[4] + ((i * 7) % 9) / 10 - 0.4) * 10) / 10, humidity: 38 + ((i * 3) % 12), createdAt: `2026-03-31T23:${String(10 + Math.floor(i / 5) * 8).padStart(2, "0")}:00.000Z` });
}

type R = { deviceId: number };

const manifest: AppManifest = {
  name: "effector-iot",
  title: "Building climate",
  framework: "react",
  libs: ["react", "effector", "effector-react", "attach", "sample", "fetch", "websocket", "rt.guard"],
  domain: "iot",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "devices", seed: devices, live: true, envelope: "bare", actions: { up: { inc: "setpoint", by: 0.5 }, down: { inc: "setpoint", by: -0.5 }, power: { toggle: "on" } } },
      { name: "readings", seed: readings, filters: ["deviceId"], envelope: "items", pageSize: 8 },
    ],
  },
  variants: {
    race: ["abort", "none", "none"],
    command: ["absolute", "relative"],
    echo: ["pending-aware", "apply", "apply"],
    overlap: ["skip", "none"],
    pollMs: [4000, 2500, 6000],
  },
  affordances: [
    { id: "details", kind: "click", sel: "li.device button.details", nth: 5, weight: 2.5, mode: "replace", key: "device", dblclickP: 0.05 },
    { id: "up", kind: "click", sel: "li.device button.up", nth: 5, weight: 3, mode: "accumulate", intent: "nth", burst: [0, 2], dblclickP: 0.1 },
    { id: "down", kind: "click", sel: "li.device button.down", nth: 5, weight: 2, mode: "accumulate", intent: "nth", burst: [0, 2], dblclickP: 0.1 },
    { id: "power", kind: "click", sel: "li.device button.power", nth: 5, weight: 1, mode: "accumulate", intent: "nth", dblclickP: 0.12 },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.5, mode: "replace" },
  ],
  external: [
    { kind: "update", target: "devices", perMin: 8, data: [{ temp: 20.1 }, { temp: 21.4 }, { temp: 22.7 }, { temp: 19.8 }, { temp: 23.2 }] },
    { kind: "update", target: "devices", perMin: 1, data: [{ online: false }, { online: true }, { online: true }] },
    { kind: "update", target: "devices", perMin: 0.8, data: [{ setpoint: 20 }, { setpoint: 22 }] },
    { kind: "create", target: "readings", perMin: 12, data: [{ deviceId: 40, temp: 20.8, humidity: 41 }, { deviceId: 41, temp: 22.1, humidity: 45 }, { deviceId: 42, temp: 19.2, humidity: 35 }, { deviceId: 43, temp: 22.6, humidity: 48 }, { deviceId: 44, temp: 21.1, humidity: 40 }] },
  ],
  weights: { "panel.error": 0, "panel.connected": 0.2, "panel.pending": 0.1, "panel.loadingHistory": 0.1 },
  relations: [{ name: "history shows the selected device", fields: ["history", "panel"], check: (s) => !s.history || !s.panel || s.history.every((r: R) => r.deviceId === s.panel.selected) }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 70000],
};
export default manifest;
