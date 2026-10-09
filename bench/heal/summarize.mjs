// Compare demo eval runs from their raw trials: one Markdown table per mode, one row per demo, one column group per
// run. Pairs every guard/heal chaos trial with the same seed in off AND in observe: observe loads the model like
// guard/heal (the trial page mounts the app only after the model is ready, which shifts the world's scripted
// activity), so "vs observe" isolates what guard/heal's actions and holds did; "vs off" is the user-facing total.
//   node bench/heal/summarize.mjs results-a.json [results-b.json ...] [--modes guard,heal] [--no-gates]
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const argv = process.argv.slice(2);
const files = argv.filter((a) => a.endsWith(".json"));
const mi = argv.indexOf("--modes");
const MODES = (mi >= 0 ? argv[mi + 1] : "off,observe,guard,heal").split(",");
const GATES = !argv.includes("--no-gates");
const runs = files.map((f) => ({ name: basename(f).replace(/^results-|\.json$/g, ""), raw: JSON.parse(readFileSync(f, "utf8")).raw ?? [] }));
// a run without off (or observe) trials borrows them from the first run that has them (same seeds and chaos draws)
for (const base of ["off", "observe"]) {
  const src = runs.find((r) => r.raw.some((t) => t.mode === base));
  for (const r of runs) if (src && r !== src && !r.raw.some((t) => t.mode === base)) r.raw = [...r.raw, ...src.raw.filter((t) => t.mode === base).map((t) => ({ ...t, borrowed: true }))];
}
const DEMOS = ["search", "editor", "checkout", "status", "board", "decisions"];
const pct = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : "–");
const med = (a) => {
  const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return null;
  const i = (v.length - 1) / 2;
  return (v[Math.floor(i)] + v[Math.ceil(i)]) / 2;
};

function stats(raw, demo, mode) {
  const rs = raw.filter((r) => r.demo === demo && r.mode === mode && !r.error);
  if (!rs.length) return null;
  const chaos = rs.filter((r) => r.kind === "chaos");
  const clean = rs.filter((r) => r.kind === "clean");
  const pair = (base) => {
    const b = new Map(raw.filter((r) => r.demo === demo && r.mode === base && r.kind === "chaos" && !r.error).map((r) => [r.seed, r]));
    let fx = 0, intro = 0, n = 0;
    for (const r of chaos) {
      const o = b.get(r.seed);
      if (!o) continue;
      n++;
      if (o.bug && !r.bug) fx++;
      if (!o.bug && r.bug) intro++;
    }
    return { fx, intro, n };
  };
  return {
    k: chaos.filter((r) => r.bug).length,
    n: chaos.length,
    off: mode === "off" ? null : pair("off"),
    obs: mode === "guard" || mode === "heal" ? pair("observe") : null,
    fi: clean.reduce((a, r) => a + (r.gc?.interventions?.length ?? 0), 0),
    cleanBugs: clean.filter((r) => r.bug).length,
    cn: clean.length,
    ff: clean.reduce((a, r) => a + (r.gc?.detections ?? 0), 0),
    lat: med(clean.map((r) => r.metrics?.latencyMs)),
    acts: chaos.reduce((a, r) => a + (r.gc?.interventions?.length ?? 0), 0),
    errors: raw.filter((r) => r.demo === demo && r.mode === mode && r.error).length,
  };
}

for (const mode of MODES) {
  const have = runs.filter((r) => r.raw.some((t) => t.mode === mode));
  if (!have.length) continue;
  console.log(`\n### ${mode}\n`);
  const head = "bugs (chaos) | fixed/intro vs off | vs observe | actions (chaos) | FI (clean) | false findings | clean bugs | clean p50 ms";
  console.log(`| demo | ${have.map((r) => (have.length > 1 ? head.replace("bugs (chaos)", `${r.name}: bugs`) : head)).join(" | ")} |`);
  console.log(`|---|${have.map(() => "---|---|---|---|---|---|---|---").join("|")}|`);
  const tot = have.map(() => ({ k: 0, n: 0, ofx: 0, oin: 0, bfx: 0, bin: 0, acts: 0, fi: 0, ff: 0, cb: 0, cn: 0, err: 0 }));
  for (const d of DEMOS) {
    const cells = have.map((r, i) => {
      const x = stats(r.raw, d, mode);
      if (!x) return "– | – | – | – | – | – | – | –";
      const t = tot[i];
      t.k += x.k; t.n += x.n; t.acts += x.acts; t.fi += x.fi; t.ff += x.ff; t.cb += x.cleanBugs; t.cn += x.cn; t.err += x.errors;
      if (x.off) { t.ofx += x.off.fx; t.oin += x.off.intro; }
      if (x.obs) { t.bfx += x.obs.fx; t.bin += x.obs.intro; }
      return `${pct(x.k, x.n)} (${x.k}/${x.n}) | ${x.off ? `${x.off.fx}/${x.off.intro}` : "–"} | ${x.obs ? `${x.obs.fx}/${x.obs.intro}` : "–"} | ${x.acts} | ${x.fi}/${x.cn} | ${x.ff} | ${x.cleanBugs} | ${x.lat == null ? "–" : Math.round(x.lat)}`;
    });
    console.log(`| ${d} | ${cells.join(" | ")} |`);
  }
  console.log(`| **all** | ${tot.map((t) => `**${pct(t.k, t.n)}** (${t.k}/${t.n}) | ${mode === "off" ? "–" : `${t.ofx}/${t.oin}`} | ${mode === "guard" || mode === "heal" ? `${t.bfx}/${t.bin}` : "–"} | ${t.acts} | ${t.fi}/${t.cn} | ${t.ff} | ${t.cb} |${t.err ? ` ${t.err} errors` : ""}`).join(" | ")} |`);
}

if (GATES)
  for (const r of runs) {
    const acts = {};
    const gains = {};
    for (const t of r.raw) {
      for (const a of t.gc?.interventions ?? []) {
        const k = `${t.demo} ${t.mode} ${t.kind} ${a.trigger}:${a.action}`;
        acts[k] = (acts[k] ?? 0) + 1;
      }
      for (const g of t.gc?.gates ?? []) {
        const [trig, , cand, gm] = g.split(":");
        if (cand === "-") continue;
        const v = Number(gm.split("/")[0]);
        if (Number.isFinite(v)) (gains[`${trig}:${cand}`] ??= []).push(v);
      }
    }
    console.log(`\n#### ${r.name}: actions that ran (demo mode kind trigger:action)\n`);
    for (const [k, v] of Object.entries(acts).sort()) console.log(`- ${k}: ${v}`);
    if (Object.keys(gains).length) {
      console.log(`\n#### ${r.name}: candidate gains, all modes (trigger:action: n, max, share with gain ≥ 1 / ≥ 2 / ≥ 3)\n`);
      for (const [k, v] of Object.entries(gains).sort()) {
        const ge = (x) => `${Math.round((100 * v.filter((y) => y >= x).length) / v.length)}%`;
        console.log(`- ${k}: n=${v.length}, max ${Math.max(...v).toFixed(2)}, ${ge(1)} / ${ge(2)} / ${ge(3)}`);
      }
    }
  }
