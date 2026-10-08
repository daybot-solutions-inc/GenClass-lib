import type { AppManifest } from "../../src/shared/manifest.js";

const songs: [string, string][] = [
  ["Moonlight Drive", "The Velvet Owls"], ["Blue Monday Morning", "Kite Theory"], ["Night Bus", "Lumen"], ["Love on Mute", "Sasha Grey Skies"],
  ["Sunroof", "Paper Planes"], ["Mosaic", "Ines Ortega"], ["Northern Lights", "Lumen"], ["Blue Hour", "Delta Nine"],
  ["Sunday Best", "The Velvet Owls"], ["Lovesick Radio", "Kite Theory"], ["Midnight Snack", "Bodega Kids"], ["Sundial", "Ines Ortega"],
  ["Motel Pool", "Delta Nine"], ["Night Swim", "Paper Planes"], ["Love Letters", "Bodega Kids"], ["Blueprint", "Sasha Grey Skies"],
];
const catalog = songs.map(([title, artist], i) => ({ id: 300 + i, title, artist, seconds: 170 + ((i * 23) % 90) }));
const tracks = [0, 4, 7, 10, 13].map((c, i) => ({ id: 900 + i, catalogId: catalog[c]!.id, title: catalog[c]!.title, artist: catalog[c]!.artist, addedBy: ["dj_kim", "you", "marco", "dj_kim", "lea"][i], votes: [5, 3, 3, 1, 0][i], position: i + 1 }));

const manifest: AppManifest = {
  name: "nano-playlist",
  title: "Party playlist",
  framework: "react",
  libs: ["react", "nanostores", "@nanostores/react", "fetch", "AbortController", "WebSocket", "rt.guard"],
  domain: "collaborative-playlist",
  entry: "main.tsx",
  integration: "stores",
  server: {
    base: "/api",
    collections: [
      { name: "catalog", seed: catalog, search: ["title", "artist"], envelope: "items", pageSize: 6 },
      { name: "tracks", seed: tracks, versioned: true, live: true, unique: ["catalogId"], required: ["catalogId"], filters: ["addedBy"], envelope: "items", pageSize: 50, actions: { upvote: { inc: "votes", by: 1 } } },
    ],
  },
  variants: {
    search: ["debounce-abort", "every-key"],
    add: ["dedupe", "append"],
    vote: ["optimistic-rollback", "optimistic", "wait"],
    live: ["newer-wins", "blind"],
    reconnect: ["resync", "naive"],
  },
  affordances: [
    { id: "query", kind: "type", sel: "input[name=q]", values: ["mo", "blue", "night", "love", "sun"], clear: true, weight: 2.5, mode: "replace", key: "search", then: ["add"] },
    { id: "add", kind: "click", sel: "ul.results button.add", nth: 4, weight: 0, mode: "accumulate", intent: "nth", followOnly: true, dblclickP: 0.15, impatientP: 0.2, requires: "ul.results button.add" },
    { id: "vote", kind: "click", sel: "li.track button.vote", nth: 6, weight: 3, mode: "accumulate", intent: "nth", dblclickP: 0.15, impatientP: 0.15, requires: "li.track button.vote:not([disabled])" },
    { id: "remove", kind: "click", sel: "li.track.mine button.remove", nth: 2, weight: 0.8, mode: "accumulate", intent: "nth", dblclickP: 0.1, requires: "li.track.mine button.remove" },
  ],
  external: [
    { kind: "create", target: "tracks", perMin: 2, data: [3, 5, 8, 11, 14, 15].map((c) => ({ catalogId: catalog[c]!.id, title: catalog[c]!.title, artist: catalog[c]!.artist, addedBy: c % 2 ? "marco" : "lea", votes: 0, position: 50 + c })) },
    { kind: "action", target: "tracks", perMin: 6, verb: "upvote" },
    { kind: "delete", target: "tracks", perMin: 0.6, where: { addedBy: "dj_kim" } },
  ],
  weights: { "party.error": 0, "party.notice": 0, "party.pending": 0.1, "party.live": 0.1, "search.searching": 0.1, "search.q": 0.3 },
  relations: [
    { name: "no track twice", fields: ["party.tracks"], check: (s) => !s.party || new Set(s.party.tracks.map((t: { id: number }) => t.id)).size === s.party.tracks.length },
    { name: "results match the query", fields: ["search.results", "search.q"], check: (s) => !s.search || s.search.searching || !s.search.q.trim() || s.search.results.every((r: { title: string; artist: string }) => `${r.title} ${r.artist}`.toLowerCase().includes(s.search.q.trim().toLowerCase())) },
  ],
  errorSelector: "[role=alert]",
  sessionMs: [25000, 60000],
};
export default manifest;
