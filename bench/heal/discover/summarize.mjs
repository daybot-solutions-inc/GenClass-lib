// Demos with stores registered by hand (manual build) vs found by automatic state discovery (GENCLASS_DISCOVER=1):
// per demo and mode, bugs (chaos), decisions by trigger, detections, actions, and the stores each build saw.
//   node bench/heal/discover/summarize.mjs results/demos/results-discover-manual.json results/demos/results-discover-discover.json
import { readFile } from "node:fs/promises";

for (const file of process.argv.slice(2)) {
  const j = JSON.parse(await readFile(file, "utf8"));
  console.log(`\n## ${file.split("/").pop()}\n`);
  console.log("| demo | mode | chaos bugs | clean bugs | decisions (by trigger) | detections | actions | stores (name:kind/source) |");
  console.log("|---|---|---|---|---|---|---|---|");
  const groups = new Map();
  for (const r of j.raw) {
    const k = `${r.demo}|${r.mode}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, rs] of groups) {
    const [demo, mode] = k.split("|");
    const chaos = rs.filter((r) => r.kind === "chaos");
    const clean = rs.filter((r) => r.kind === "clean");
    const trig = {};
    let det = 0, acts = 0, dec = 0;
    const stores = new Set();
    for (const r of rs) {
      dec += r.gc?.decisions ?? 0;
      det += r.gc?.detections ?? 0;
      acts += r.gc?.interventions?.length ?? 0;
      for (const [t, n] of Object.entries(r.gc?.triggers ?? {})) trig[t] = (trig[t] ?? 0) + n;
      for (const s of r.gc?.stores ?? []) stores.add(s.split(":").slice(0, 2).join(":"));
    }
    const t = Object.entries(trig).map(([a, b]) => `${a} ${b}`).join(", ");
    console.log(`| ${demo} | ${mode} | ${chaos.filter((r) => r.bug).length}/${chaos.length} | ${clean.filter((r) => r.bug).length}/${clean.length} | ${dec}${t ? ` (${t})` : ""} | ${det} | ${acts} | ${[...stores].sort().join(", ") || "–"} |`);
  }
}
