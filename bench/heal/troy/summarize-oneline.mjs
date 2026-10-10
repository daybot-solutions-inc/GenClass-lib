// Summary of Troy runs for the one-line work (automatic state discovery): per run file and mode, bugs, decisions by
// trigger, detections, actions, discovered stores and React commit-walk cost (p50 / p95 / max ms over every commit).
//   node bench/heal/troy/summarize-oneline.mjs <results.json>...
import { readFile } from "node:fs/promises";

const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))] : null);
const f2 = (x) => (x == null ? "–" : x.toFixed(2));
for (const file of process.argv.slice(2)) {
  const j = JSON.parse(await readFile(file, "utf8"));
  console.log(`\n## ${j.tag || file}${Object.keys(j.config ?? {}).length ? ` (config ${JSON.stringify(j.config)})` : ""}\n`);
  console.log("| mode | trials | bugs | decisions (by trigger) | detections | actions | discovered stores | commits | walk p50 / p95 / max ms | heap MB p50 | long tasks |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const mode of j.modes) {
    const rs = j.raw.filter((r) => r.mode === mode);
    const trig = {};
    let dec = 0, det = 0, acts = 0, commits = 0;
    const samples = [];
    const stores = new Set();
    const heap = [];
    let lt = 0;
    for (const r of rs) {
      dec += r.gc?.decisions ?? 0;
      det += r.gc?.detections ?? 0;
      acts += r.gc?.interventions?.length ?? 0;
      for (const [k, v] of Object.entries(r.gc?.byTrigger ?? {})) trig[k] = (trig[k] ?? 0) + v;
      for (const s of r.gc?.stores ?? []) stores.add(s.split(":")[0]);
      if (r.gc?.walk) {
        commits += r.gc.walk.commits;
        samples.push(...(r.gc.walk.samples ?? []));
      }
      if (r.perf?.heapMB != null) heap.push(r.perf.heapMB);
      lt += r.perf?.longTasks ?? 0;
    }
    samples.sort((a, b) => a - b);
    heap.sort((a, b) => a - b);
    const bugs = rs.filter((r) => r.bug && !r.error).length;
    const trigs = Object.entries(trig).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`| ${mode} | ${rs.length} | ${bugs} | ${dec}${trigs ? ` (${trigs})` : ""} | ${det} | ${acts} | ${[...stores].sort().join(", ") || "–"} | ${commits} | ${f2(pct(samples, 0.5))} / ${f2(pct(samples, 0.95))} / ${f2(samples.at(-1))} | ${pct(heap, 0.5) ?? "–"} | ${lt} |`);
  }
}
