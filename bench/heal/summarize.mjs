// Compare demo eval runs: one Markdown table per mode with one row per demo and one column group per run.
//   node bench/heal/summarize.mjs results-a.json results-b.json ... [--modes guard,heal]
// Reads the eval's results-<tag>.json (summaries per demo and mode, plus raw trials for gate analysis).
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const argv = process.argv.slice(2);
const files = argv.filter((a) => a.endsWith(".json"));
const mi = argv.indexOf("--modes");
const MODES = (mi >= 0 ? argv[mi + 1] : "off,observe,guard,heal").split(",");
const runs = files.map((f) => ({ name: basename(f).replace(/^results-|\.json$/g, ""), j: JSON.parse(readFileSync(f, "utf8")) }));
const DEMOS = ["search", "editor", "checkout", "status", "board", "decisions"];
const pct = (x) => `${Math.round(x * 100)}%`;
const ms = (x) => (x == null || !Number.isFinite(x) ? "–" : `${Math.round(x)}`);

for (const mode of MODES) {
  const have = runs.filter((r) => DEMOS.some((d) => r.j.demos?.[d]?.[mode]));
  if (!have.length) continue;
  console.log(`\n### ${mode}\n`);
  console.log(`| demo | ${have.map((r) => `${r.name}: bugs (chaos) | fixed/intro | FI clean | false findings | clean p50 ms | acts/chaos`).join(" | ")} |`);
  console.log(`|---|${have.map(() => "---|---|---|---|---|---").join("|")}|`);
  const tot = have.map(() => ({ k: 0, n: 0, fx: 0, in: 0, fi: 0, ff: 0, cn: 0, acts: 0 }));
  for (const d of DEMOS) {
    const cells = have.map((r, i) => {
      const x = r.j.demos?.[d]?.[mode];
      if (!x) return "– | – | – | – | – | –";
      const t = tot[i];
      t.k += x.chaos.k;
      t.n += x.chaos.n;
      t.fx += x.fixed;
      t.in += x.introduced;
      t.fi += x.falseInterventions;
      t.ff += x.falseFindings ?? 0;
      t.cn += x.cleanTrials;
      t.acts += x.interventionsPerChaosTrial * x.chaos.n;
      return `${pct(x.chaos.rate)} (${x.chaos.k}/${x.chaos.n}) | ${mode === "off" ? "–" : `${x.fixed}/${x.introduced}`} | ${x.falseInterventions}/${x.cleanTrials} | ${x.falseFindings ?? "–"} | ${ms(x.latencyMs)} | ${x.interventionsPerChaosTrial.toFixed(2)}`;
    });
    console.log(`| ${d} | ${cells.join(" | ")} |`);
  }
  console.log(`| **all** | ${tot.map((t) => `**${pct(t.k / Math.max(1, t.n))}** (${t.k}/${t.n}) | ${mode === "off" ? "–" : `${t.fx}/${t.in}`} | ${t.fi}/${t.cn} | ${t.ff} | | ${(t.acts / Math.max(1, t.n)).toFixed(2)}`).join(" | ")} |`);
}

// Gate analysis: executed non-passive actions and near misses, from raw trials (gc.gates when present).
for (const r of runs) {
  const raw = r.j.raw ?? [];
  const acts = {};
  const gains = {};
  for (const t of raw) {
    for (const a of t.gc?.interventions ?? []) {
      const k = `${t.demo} ${t.mode} ${t.kind} ${a.trigger}:${a.action}`;
      acts[k] = (acts[k] ?? 0) + 1;
    }
    for (const g of t.gc?.gates ?? []) {
      const [trig, , cand, gm] = g.split(":");
      if (cand === "-") continue;
      const v = Number(gm.split("/")[0]);
      if (!Number.isFinite(v)) continue;
      const k = `${trig}:${cand}`;
      (gains[k] ??= []).push(v);
    }
  }
  console.log(`\n#### ${r.name}: actions that ran\n`);
  for (const [k, v] of Object.entries(acts).sort()) console.log(`- ${k}: ${v}`);
  if (Object.keys(gains).length) {
    console.log(`\n#### ${r.name}: candidate gains (trigger:action → n, max, share ≥ 1 / ≥ 2 / ≥ 3)\n`);
    for (const [k, v] of Object.entries(gains).sort()) {
      const n = v.length;
      const ge = (x) => `${Math.round((100 * v.filter((y) => y >= x).length) / n)}%`;
      console.log(`- ${k}: n=${n}, max ${Math.max(...v).toFixed(2)}, ${ge(1)} / ${ge(2)} / ${ge(3)}`);
    }
  }
}
