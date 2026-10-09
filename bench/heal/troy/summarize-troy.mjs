// Troy results as a Markdown table: per scenario, bugs and latency per mode, GenClass decisions / detections /
// actions per model mode.   node bench/heal/troy/summarize-troy.mjs results.json
import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync(process.argv[2], "utf8"));
const M = ["off", "observe", "guard", "heal"].filter((m) => j.raw.some((r) => r.mode === m));
const S = {};
for (const r of j.raw) {
  const s = (S[r.scenario] ??= { kind: r.kind });
  const m = (s[r.mode] ??= { n: 0, b: 0, err: 0, lat: [], dec: 0, det: 0, acts: 0 });
  m.n++;
  if (r.error) m.err++;
  else if (r.bug) m.b++;
  if (r.latencyMs != null) m.lat.push(r.latencyMs);
  m.dec += r.gc?.decisions ?? 0;
  m.det += r.gc?.detections ?? 0;
  m.acts += r.gc?.interventions?.length ?? 0;
}
const med = (a) => {
  const v = [...a].sort((x, y) => x - y);
  return v.length ? Math.round(v[Math.floor((v.length - 1) / 2)]) : "–";
};
const G = M.filter((m) => m !== "off");
console.log(`| scenario | kind | bugs ${M.join(" / ")} | latency p50 ms ${M.join(" / ")} | decisions ${G.join(" / ")} | detections | actions |`);
console.log("|---|---|---|---|---|---|---|");
for (const [k, v] of Object.entries(S))
  console.log(
    `| ${k} | ${v.kind} | ${M.map((m) => (v[m] ? `${v[m].b}/${v[m].n}${v[m].err ? ` (${v[m].err} err)` : ""}` : "–")).join(" / ")} | ${M.map((m) => (v[m] ? med(v[m].lat) : "–")).join(" / ")} | ${G.map((m) => v[m]?.dec ?? "–").join(" / ")} | ${G.map((m) => v[m]?.det ?? "–").join(" / ")} | ${G.map((m) => v[m]?.acts ?? "–").join(" / ")} |`,
  );
console.log(`\nExternal requests: ${j.external?.length ? j.external.join(", ") : "none"}.`);
