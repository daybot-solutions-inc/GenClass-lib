import type { AppManifest } from "../../src/shared/manifest.js";

const calls = ["W1AW", "K1ABC", "W9XYZ", "N5KO", "VE3RCS", "VE7CC", "KH6LC", "K4ZZ", "AA7BQ", "W0DLE", "KD8OXR", "N2IC", "K6XX", "VA3DX", "W5KFT", "KB1HQS", "DL2ZZ", "G4ABC"];
const bands = ["20m", "40m", "15m", "10m"];
const modes = ["SSB", "CW", "FT8"];
const ptsOf = (mode: string) => (mode === "SSB" ? 1 : 2);
const seen = new Set<string>();
const qsos = Array.from({ length: 36 }, (_, i) => {
  const call = calls[(i * 5) % calls.length]!;
  const band = bands[(i * 3 + Math.floor(i / 4)) % 4]!;
  const mode = modes[(i * 7) % 3]!;
  const mins = 8 * 60 + i * 7;
  return { id: 9100 + i, call, band, mode, rst: mode === "CW" ? "599" : mode === "FT8" ? "-07" : "59", points: ptsOf(mode), op: i % 3 === 0 ? "Jess" : "you", key: `${call}|${band}|${mode}`, createdAt: `2026-03-31T${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00.000Z` };
}).filter((q) => (seen.has(q.key) ? false : (seen.add(q.key), true)));
const points = qsos.reduce((n, q) => n + q.points, 0);

const manifest: AppManifest = {
  name: "rx-contestlog",
  title: "Field Day contest log",
  framework: "vanilla",
  libs: ["rxjs", "fromEvent/Subject", "debounceTime", "switchMap/mergeMap/exhaustMap", "rxjs/fetch(fromFetch)", "rxjs/webSocket", "rt.atom"],
  domain: "ham-radio-contest-log",
  entry: "main.ts",
  integration: "stores",
  server: {
    base: "/api",
    collections: [{ name: "qsos", seed: qsos, unique: ["key"], required: ["call", "band", "mode"], filters: ["call", "band", "mode"], search: ["call"], envelope: "items", pageSize: 8 }],
    counters: [{ name: "points", init: points, live: true }],
  },
  variants: {
    dupeCheck: ["switchMap", "mergeMap"],
    debounce: [300, 0],
    logFlatten: ["exhaustMap", "mergeMap"],
    score: ["server", "local"],
    older: ["reset-on-band", "keep-cursor"],
  },
  affordances: [
    { id: "call", kind: "type", sel: "form.entry input[name=call]", values: ["K1ABC", "W9XYZ", "VE3RCS", "DL2ZZ", "JA1QQ", "N5KO", "G4ABC", "PY2XB", "EA8RM"], clear: true, weight: 3, mode: "replace", key: "call", then: ["log"] },
    { id: "log", kind: "click", sel: "form.entry button.log", weight: 0, mode: "accumulate", followOnly: true, dblclickP: 0.25, impatientP: 0.2 },
    { id: "band", kind: "select", sel: "select[name=band]", values: ["20m", "40m", "15m", "10m"], weight: 1.3, mode: "replace", key: "band" },
    { id: "mode", kind: "select", sel: "select[name=mode]", values: ["SSB", "CW", "FT8"], weight: 0.8, mode: "replace", key: "mode" },
    { id: "older", kind: "click", sel: "button.older", weight: 1.6, mode: "accumulate", dblclickP: 0.15, impatientP: 0.2, requires: "button.older:not([disabled])" },
  ],
  external: [
    // the second station of the club logs contacts too
    { kind: "create", target: "qsos", perMin: 3, data: [{ call: "KC1XYZ", band: "40m", mode: "CW", rst: "599", points: 2, op: "Jess", key: "KC1XYZ|40m|CW" }, { call: "W8EH", band: "20m", mode: "SSB", rst: "59", points: 1, op: "Jess", key: "W8EH|20m|SSB" }, { call: "VE2FK", band: "15m", mode: "FT8", rst: "-12", points: 2, op: "Jess", key: "VE2FK|15m|FT8" }, { call: "K0RF", band: "10m", mode: "SSB", rst: "59", points: 1, op: "Jess", key: "K0RF|10m|SSB" }] },
    { kind: "counter", target: "points", perMin: 3, by: 2 },
    { kind: "counter", target: "points", perMin: 2, by: 1 },
  ],
  weights: { "log.error": 0, "log.notice": 0, "log.call": 0.3, "log.logging": 0.1, "log.loading": 0.1, "log.loadingOlder": 0.1, "log.live": 0.1 },
  relations: [{ name: "recent log is for the selected band", fields: ["log.rows", "log.band"], check: (s) => !s.log || s.log.loading || s.log.rows.every((q: { band: string }) => q.band === s.log.band) }],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
