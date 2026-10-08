import type { AppManifest } from "../../src/shared/manifest.js";

const dests = ["Kingston", "Ottawa", "Montréal", "Niagara Falls", "London", "Windsor", "Barrie", "Peterborough", "Kitchener", "Hamilton"];
const departures = Array.from({ length: 26 }, (_, i) => {
  const mins = 9 * 60 + 5 + i * 4;
  return { id: 8800 + i, train: `${["VIA", "GO", "VIA", "GO"][i % 4]} ${640 + i * 3}`, dest: dests[(i * 7) % 10], time: `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`, platform: String(1 + ((i * 5) % 12)), status: i % 7 === 3 ? "delayed 10" : "on time" };
});

const manifest: AppManifest = {
  name: "nano-departures",
  title: "Union Station departures",
  framework: "vanilla",
  libs: ["nanostores", "atom/map/computed", "fetch", "AbortController", "WebSocket"],
  domain: "train-departures",
  entry: "main.ts",
  integration: "observe",
  server: {
    base: "/api",
    collections: [
      { name: "departures", seed: departures, live: true, search: ["dest", "train"], filters: ["status"], envelope: "items", pageSize: 6 },
      { name: "alerts", seed: [], unique: ["trainId"], required: ["trainId"], envelope: "items" },
    ],
  },
  variants: {
    more: ["window", "offset"],
    searchSeq: ["abort", "blind"],
    live: ["newer-wins", "blind"],
    reconnect: ["resync", "naive"],
    alertGuard: ["pending", "none"],
  },
  affordances: [
    { id: "search", kind: "type", sel: "input[name=q]", values: ["ki", "ott", "lon", "ham", "win"], clear: true, weight: 1.5, mode: "replace", key: "search" },
    { id: "clearSearch", kind: "clear", sel: "input[name=q]", weight: 0.6, mode: "replace", key: "search", after: ["search"] },
    { id: "more", kind: "click", sel: "button.more", weight: 2.5, mode: "accumulate", dblclickP: 0.15, impatientP: 0.2, requires: "button.more:not([disabled])" },
    { id: "alert", kind: "click", sel: "li.departure button.alert", nth: 6, weight: 2, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.15, requires: "li.departure button.alert" },
  ],
  external: [
    { kind: "update", target: "departures", perMin: 8, where: { status: "on time" }, data: [{ status: "delayed 5" }, { status: "boarding" }, { platform: "7" }, { status: "boarding" }] },
    { kind: "update", target: "departures", perMin: 2, where: { status: "delayed 10" }, data: [{ status: "cancelled" }, { status: "boarding" }] },
    { kind: "delete", target: "departures", perMin: 4, where: { status: "boarding" } },
    { kind: "create", target: "departures", perMin: 2, data: [{ train: "GO 902", dest: "Barrie", time: "11:58", platform: "4", status: "on time" }, { train: "VIA 77", dest: "Windsor", time: "11:59", platform: "9", status: "on time" }, { train: "GO 905", dest: "Hamilton", time: "11:59", platform: "2", status: "on time" }] },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
