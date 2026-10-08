import type { AppManifest } from "../../src/shared/manifest.js";

const devices = [
  { id: 6001, name: "Lobby thermostat", room: "Lobby", kind: "thermostat", online: true, temp: 20.5, setpoint: 21, reboots: 0 },
  { id: 6002, name: "Conference room thermostat", room: "Conference room", kind: "thermostat", online: true, temp: 22.1, setpoint: 21.5, reboots: 0 },
  { id: 6003, name: "Corner office thermostat", room: "Office 3B", kind: "thermostat", online: true, temp: 19.8, setpoint: 20.5, reboots: 1 },
  { id: 6004, name: "Open office lights", room: "Open office", kind: "light", online: true, on: true, reboots: 0 },
  { id: 6005, name: "Kitchen lights", room: "Kitchen", kind: "light", online: true, on: false, reboots: 0 },
  { id: 6006, name: "Coffee machine", room: "Kitchen", kind: "plug", online: true, on: true, watts: 1180, reboots: 0 },
  { id: 6007, name: "Server closet UPS", room: "Server closet", kind: "plug", online: true, on: true, watts: 340, reboots: 2 },
  { id: 6008, name: "Front door", room: "Lobby", kind: "lock", online: true, locked: true, reboots: 0 },
  { id: 6009, name: "Bike room door", room: "Garage", kind: "lock", online: false, locked: false, reboots: 0 },
];

const manifest: AppManifest = {
  name: "htm-iot-dashboard",
  title: "Harbor View Offices — Devices",
  framework: "preact",
  libs: ["preact", "htm", "@preact/signals", "WebSocket", "fetch", "rt.atom"],
  domain: "iot",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      {
        name: "devices",
        seed: devices,
        envelope: "bare",
        live: true,
        versioned: true,
        actions: { reboot: { inc: "reboots", by: 1 }, "toggle-power": { toggle: "on" }, lock: { set: { locked: true } }, unlock: { set: { locked: false } } },
      },
    ],
  },
  variants: {
    ackApply: ["version", "blind", "blind"],
    reconnect: ["resync", "naive", "none"],
    powerWrite: ["set", "toggle"],
    setpointSend: ["debounce", "each"],
    rebootGuard: ["pending", "none"],
    onlineCount: ["derived", "incremental"],
  },
  affordances: [
    { id: "spUp", kind: "click", sel: ".device.thermostat button.sp-up", nth: 3, weight: 2.4, mode: "accumulate", intent: "nth", burst: [0, 3], dblclickP: 0.06, requires: ".device.thermostat button.sp-up" },
    { id: "spDown", kind: "click", sel: ".device.thermostat button.sp-down", nth: 3, weight: 1.4, mode: "accumulate", intent: "nth", burst: [0, 2], requires: ".device.thermostat button.sp-down" },
    { id: "power", kind: "click", sel: ".device button.power", nth: 4, weight: 2, mode: "accumulate", intent: "nth", dblclickP: 0.15, requires: ".device button.power" },
    { id: "lock", kind: "click", sel: ".device button.lock", nth: 2, weight: 0.9, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: ".device button.lock" },
    { id: "reboot", kind: "click", sel: ".device button.reboot", nth: 9, weight: 0.8, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.3 },
    { id: "room", kind: "select", sel: "select[name=room]", values: ["all", "Lobby", "Kitchen", "Conference room", "Open office", "Office 3B"], weight: 0.9, mode: "replace" },
    { id: "refresh", kind: "click", sel: "button.refresh", weight: 0.4, mode: "replace" },
  ],
  external: [
    { kind: "update", target: "devices", perMin: 14, data: [{ temp: 20.9 }, { temp: 21.6 }, { temp: 19.4 }, { temp: 22.8 }, { watts: 1210 }, { watts: 0 }, { online: false }, { online: true }, { online: true }] },
    { kind: "update", target: "devices", perMin: 1.5, data: [{ setpoint: 22 }, { on: false }, { locked: true }] },
  ],
  weights: { "devices.loading": 0.1, "devices.error": 0, "devices.connected": 0.2, "ui.busy": 0.1, "ui.drafts": 0.3 },
  relations: [{ name: "online counter == devices online", fields: ["devices.online", "devices.items"], check: (s) => !s.devices || s.devices.online === s.devices.items.filter((d: { online: boolean }) => d.online).length }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 65000],
};
export default manifest;
