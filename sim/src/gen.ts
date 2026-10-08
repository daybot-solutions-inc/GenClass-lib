#!/usr/bin/env node
// CLI: node sim/dist/gen.js --rows N --out <dir> --seed S --workers W [--max-points 6] [--test-keep 0.5]
//      [--explore 1] [--no-ask] [--allow-fake] [--sample]
// Writes <out>/train.jsonl, dev.jsonl, test.jsonl and stats.json. --sample writes sim/samples/sample.jsonl
// (~200 rows) and sim/samples/EXAMPLES.md (~12 pretty-printed rows).

import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { PointStat } from "./gen/trajectory.js";
import { renderExamples } from "./gen/examples.js";

interface Args {
  rows: number;
  out: string;
  seed: number;
  workers: number;
  maxPoints: number;
  testKeep: number;
  explore: number;
  ask: boolean;
  fake: boolean;
  sample: boolean;
  /** Resumable parts mode: fixed seed ranges of `chunk` seeds, one file set per part. */
  parts: boolean;
  chunk: number;
  /** Only merge existing parts into train/dev/test.jsonl. */
  mergeOnly: boolean;
  /** Row type: gold (counterfactual labels) or unlabeled (base runs only). */
  mode: "gold" | "unlabeled" | "onpolicy";
  modelDir: string;
  gate: "shipping" | "explore";
}

function parse(argv: string[]): Args {
  const a: Args = { rows: 1000, out: "sim/out/run", seed: 1, workers: 4, maxPoints: 6, testKeep: 0.33, explore: 1, ask: true, fake: false, sample: false, parts: false, chunk: 100, mergeOnly: false, mode: "gold", modelDir: "", gate: "shipping" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--rows": a.rows = Number(v); i++; break;
      case "--out": a.out = String(v); i++; break;
      case "--seed": a.seed = Number(v); i++; break;
      case "--workers": a.workers = Number(v); i++; break;
      case "--max-points": a.maxPoints = Number(v); i++; break;
      case "--test-keep": a.testKeep = Number(v); i++; break;
      case "--explore": a.explore = Number(v); i++; break;
      case "--no-ask": a.ask = false; break;
      case "--allow-fake": a.fake = true; break;
      case "--sample": a.sample = true; break;
      case "--parts": a.parts = true; break;
      case "--chunk": a.chunk = Number(v); i++; break;
      case "--merge-only": a.parts = true; a.mergeOnly = true; break;
      case "--unlabeled": a.mode = "unlabeled"; break;
      case "--on-policy": a.mode = "onpolicy"; a.modelDir = String(v); i++; break;
      case "--gate": a.gate = String(v) === "explore" ? "explore" : "shipping"; i++; break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

type Counter = Record<string, number>;
const inc = (c: Counter, k: string, n = 1) => (c[k] = (c[k] ?? 0) + n);

interface Agg {
  rows: Counter;
  rowsBySplitTrigger: Record<string, Counter>;
  diag: Record<string, Counter>;
  best: Record<string, Counter>;
  passiveBest: Record<string, { n: number; passive: number }>;
  harm: Record<string, Record<string, number[]>>;
  gap: Record<string, number[]>;
  askKinds: Counter;
  askLabels: Counter;
  lens: number[];
  drops: Counter;
  domains: Counter;
  families: Counter;
  features: Counter;
  skipped: Counter;
  errors: string[];
  trajectories: number;
  runs: number;
  decisions: number;
  correlated: Counter;
  explored: Counter;
  byBudget: Record<string, { rows: number; lens: number[]; chars: number[]; passiveBest: Record<string, { n: number; passive: number }> }>;
  sharp: Record<string, { passiveRows: number; passive90: number; actRows: number; act95: number; act90: number; actSoft: number; futures3: number }>;
}

function newAgg(): Agg {
  return { rows: {}, rowsBySplitTrigger: {}, diag: {}, best: {}, passiveBest: {}, harm: {}, gap: {}, askKinds: {}, askLabels: {}, lens: [], drops: {}, domains: {}, families: {}, features: {}, skipped: {}, errors: [], trajectories: 0, runs: 0, decisions: 0, correlated: {}, explored: {}, byBudget: {}, sharp: {} };
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

async function main(): Promise<void> {
  const a = parse(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(a.sample ? join(here, "..", "out", "sample-tmp") : a.out);
  if (existsSync(join(out, "shards"))) rmSync(join(out, "shards"), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const target = a.sample ? 900 : a.rows;
  const agg = newAgg();
  let produced = 0;
  let nextSeed = a.seed;
  const batch = 2;
  // Parts mode (resumable): part i = seeds [seed + i*chunk, seed + (i+1)*chunk). Finished parts have a .json marker
  // and are skipped on restart; half-written parts (.tmp) are discarded and regenerated.
  const partsDir = join(out, "parts");
  const doneParts = new Set<number>();
  let nextPart = 0;
  if (a.parts) {
    mkdirSync(partsDir, { recursive: true });
    for (const f of readdirSync(partsDir)) {
      if (f.endsWith(".tmp")) rmSync(join(partsDir, f), { force: true });
      const m = /^part-(\d+)\.json$/.exec(f);
      if (m) {
        const info = JSON.parse(readFileSync(join(partsDir, f), "utf8")) as { rows: Record<string, number> };
        doneParts.add(Number(m[1]));
        produced += Object.values(info.rows).reduce((x, y) => x + y, 0);
      }
    }
    if (doneParts.size) console.log(`[gen] resuming: ${doneParts.size} finished parts, ${produced} rows already written`);
  }
  if (a.mergeOnly) {
    await mergeParts(out, partsDir);
    return;
  }
  const t0 = Date.now();
  let lastLog = 0;
  await new Promise<void>((done, fail) => {
    let live = 0;
    const workers: Worker[] = [];
    const feed = (w: Worker) => {
      if (produced >= target) {
        w.postMessage({ stop: true });
        return;
      }
      if (a.parts) {
        while (doneParts.has(nextPart)) nextPart++;
        const part = nextPart++;
        const from = a.seed + part * a.chunk;
        w.postMessage({ part, seeds: Array.from({ length: a.chunk }, (_, i) => from + i) });
        return;
      }
      const seeds = Array.from({ length: batch }, () => nextSeed++);
      w.postMessage({ seeds });
    };
    for (let i = 0; i < a.workers; i++) {
      const w = new Worker(join(here, "worker.js"), {
        workerData: { id: i, out, fake: a.fake, maxPoints: a.maxPoints, askRows: a.ask, testKeep: a.sample ? 1 : a.testKeep, exploreScale: a.explore, mode: a.mode, modelDir: a.modelDir, gate: a.gate },
      });
      live++;
      workers.push(w);
      w.on("message", (m: Record<string, unknown>) => {
        if (m.type === "ready" || m.type === "idle") return feed(w);
        if (m.type === "part-done") {
          doneParts.add(Number(m.part));
          return;
        }
        if (m.type === "fatal") return fail(new Error(String(m.error)));
        if (m.type === "error") {
          if (agg.errors.length < 20) agg.errors.push(`seed ${m.seed}: ${m.error}`);
          inc(agg.drops, "trajectory-exception");
          return;
        }
        if (m.type !== "traj") return;
        agg.trajectories++;
        agg.runs += Number(m.runs);
        agg.decisions += Number(m.decisions);
        if (m.skipped) inc(agg.skipped, String(m.skipped).split(":")[0]!);
        if (m.skipped && String(m.skipped).startsWith("base-error") && agg.errors.length < 20) agg.errors.push(`seed ${m.seed}: ${m.skipped}`);
        const n = Number(m.rows);
        produced += n;
        const trig = m.rowTriggers as string[];
        const splits = m.rowSplits as string[];
        trig.forEach((t, i) => {
          inc(agg.rows, splits[i]!);
          inc((agg.rowsBySplitTrigger[splits[i]!] ??= {}), t);
        });
        for (const k of m.askKinds as string[]) inc(agg.askKinds, k);
        for (const k of m.askLabels as string[]) inc(agg.askLabels, k);
        for (const l of m.lens as number[]) agg.lens.push(l);
        const budgets = m.rowBudgets as number[];
        budgets.forEach((b, i) => {
          const bb = (agg.byBudget[String(b)] ??= { rows: 0, lens: [], chars: [], passiveBest: {} });
          bb.rows++;
          if (bb.lens.length < 200000) bb.lens.push((m.lens as number[])[i]!);
          if (bb.chars.length < 200000) bb.chars.push((m.stateChars as number[])[i]!);
        });
        const tb = String(budgets[0] ?? 0);
        for (const p of m.points as PointStat[]) {
          const bb = (agg.byBudget[tb] ??= { rows: 0, lens: [], chars: [], passiveBest: {} });
          const x = (bb.passiveBest[p.trigger] ??= { n: 0, passive: 0 });
          x.n++;
          if (p.passiveBest) x.passive++;
        }
        for (const [k, v] of Object.entries(m.drops as Counter)) inc(agg.drops, k, v);
        if (n > 0) {
          if (m.domain) inc(agg.domains, String(m.domain));
          if (m.family) inc(agg.families, String(m.family));
          for (const f of (m.features as string[] | null) ?? []) inc(agg.features, f);
        }
        for (const p of m.points as PointStat[]) {
          const key = `${p.split}|${p.trigger}`;
          inc((agg.diag[key] ??= {}), p.diagnosis ?? "(none)");
          inc((agg.best[key] ??= {}), p.best);
          const pb = (agg.passiveBest[key] ??= { n: 0, passive: 0 });
          pb.n++;
          if (p.passiveBest) {
            pb.passive++;
            const h = (agg.harm[p.trigger] ??= {});
            for (const [act, v] of Object.entries(p.harm)) (h[act] ??= []).push(v);
          } else {
            const c = p.costs;
            const passive = Object.keys(c)[0]!;
            (agg.gap[p.trigger] ??= []).push((c[passive] ?? 0) - (c[p.best] ?? 0));
          }
          const sh = (agg.sharp[p.trigger] ??= { passiveRows: 0, passive90: 0, actRows: 0, act95: 0, act90: 0, actSoft: 0, futures3: 0 });
          if (p.futures > 1) sh.futures3++;
          if (p.passiveBest) {
            sh.passiveRows++;
            if (1 - p.nonPassiveMass >= 0.9) sh.passive90++;
          } else {
            sh.actRows++;
            if (p.nonPassiveMass >= 0.95) sh.act95++;
            if (p.nonPassiveMass >= 0.9) sh.act90++;
            if (p.nonPassiveMass < 0.6) sh.actSoft++;
          }
          inc(agg.correlated, p.correlated ? "yes" : "no");
          inc(agg.explored, p.explored ? "after-exploration" : "on-passive-path");
        }
        const now = Date.now();
        if (now - lastLog > 15000) {
          lastLog = now;
          const secs = (now - t0) / 1000;
          console.log(`[gen] ${produced}/${target} rows, ${agg.trajectories} trajectories, ${(produced / secs).toFixed(1)} rows/s, ${agg.runs} runs`);
        }
      });
      w.on("error", (e) => fail(e));
      w.on("exit", () => {
        live--;
        if (live === 0) done();
      });
    }
  });
  const secs = (Date.now() - t0) / 1000;
  if (a.parts) {
    writeFileSync(join(out, "stats.session.json"), JSON.stringify({ note: "this session only; run scripts/analyze.py on parts for totals", rows: produced, seconds: secs, rowsBySplitTrigger: agg.rowsBySplitTrigger, drops: agg.drops, errors: agg.errors }, null, 2));
    console.log(`[gen] parts session done in ${secs.toFixed(0)} s; ${doneParts.size} parts finished; ${produced} rows in ${partsDir}`);
    return;
  }
  // Merge shards.
  const shardDir = join(out, "shards");
  const files = existsSync(shardDir) ? readdirSync(shardDir) : [];
  const counts: Counter = {};
  for (const split of ["train", "dev", "test"]) {
    const dst = createWriteStream(join(out, `${split}.jsonl`));
    for (const f of files.filter((x) => x.startsWith(`${split}.`)).sort()) {
      const rl = createInterface({ input: createReadStream(join(shardDir, f)) });
      for await (const line of rl) {
        if (!line) continue;
        dst.write(line + "\n");
        inc(counts, split);
      }
    }
    await new Promise((r) => dst.end(r));
  }
  rmSync(shardDir, { recursive: true, force: true });
  // Stats.
  const harm: Record<string, Record<string, { n: number; mean: number; p10: number; median: number; frac_harmful: number }>> = {};
  for (const [trig, acts] of Object.entries(agg.harm)) {
    harm[trig] = {};
    for (const [act, xs] of Object.entries(acts)) harm[trig]![act] = { n: xs.length, mean: r3(mean(xs)), p10: r3(pct(xs, 0.1)), median: r3(pct(xs, 0.5)), frac_harmful: r3(xs.filter((x) => x > 0.05).length / xs.length) };
  }
  const passiveBest: Record<string, { rows: number; passive_best: number; frac: number }> = {};
  for (const [k, v] of Object.entries(agg.passiveBest)) passiveBest[k] = { rows: v.n, passive_best: v.passive, frac: r3(v.passive / v.n) };
  const stats = {
    args: a,
    rows: counts,
    rows_by_split_trigger: agg.rowsBySplitTrigger,
    trajectories: agg.trajectories,
    runs: agg.runs,
    decisions_seen: agg.decisions,
    seconds: r3(secs),
    rows_per_sec_total: r3(Object.values(counts).reduce((x, y) => x + y, 0) / secs),
    diagnosis_by_split_trigger: agg.diag,
    best_action_by_split_trigger: agg.best,
    passive_best_by_split_trigger: passiveBest,
    harm_of_non_passive_when_passive_best: harm,
    gain_of_best_over_passive_when_not_passive: Object.fromEntries(Object.entries(agg.gap).map(([k, xs]) => [k, { n: xs.length, mean: r3(mean(xs)), median: r3(pct(xs, 0.5)) }])),
    by_budget: Object.fromEntries(
      Object.entries(agg.byBudget).map(([b, v]) => [
        b,
        {
          rows: v.rows,
          state_chars: { p50: pct(v.chars, 0.5), p90: pct(v.chars, 0.9), max: pct(v.chars, 1) },
          token_estimate: { p50: pct(v.lens, 0.5), p90: pct(v.lens, 0.9), max: pct(v.lens, 1) },
          passive_best_by_trigger: Object.fromEntries(Object.entries(v.passiveBest).map(([t, x]) => [t, { rows: x.n, frac: r3(x.passive / x.n) }])),
        },
      ]),
    ),
    label_sharpness: Object.fromEntries(
      Object.entries(agg.sharp).map(([t, v]) => [
        t,
        {
          passive_best_rows: v.passiveRows,
          passive_mass_ge_0_9: r3(v.passive90 / Math.max(1, v.passiveRows)),
          intervene_best_rows: v.actRows,
          non_passive_mass_ge_0_95: r3(v.act95 / Math.max(1, v.actRows)),
          non_passive_mass_ge_0_9: r3(v.act90 / Math.max(1, v.actRows)),
          non_passive_mass_lt_0_6: r3(v.actSoft / Math.max(1, v.actRows)),
          points_with_3_futures: r3(v.futures3 / Math.max(1, v.passiveRows + v.actRows)),
        },
      ]),
    ),
    ask_question_kinds: agg.askKinds,
    ask_labels: agg.askLabels,
    token_estimate: { note: "chars/3.6 of state+questions JSON", p50: pct(agg.lens, 0.5), p90: pct(agg.lens, 0.9), p99: pct(agg.lens, 0.99), max: pct(agg.lens, 1) },
    subject_correlated: agg.correlated,
    exploration: agg.explored,
    drops: agg.drops,
    skipped: agg.skipped,
    domains: agg.domains,
    families: Object.keys(agg.families).length,
    features: agg.features,
    errors: agg.errors,
  };
  writeFileSync(join(out, "stats.json"), JSON.stringify(stats, null, 2));
  console.log(`[gen] done: ${JSON.stringify(counts)} in ${secs.toFixed(1)} s (${stats.rows_per_sec_total} rows/s); stats at ${join(out, "stats.json")}`);
  if (a.sample) {
    const all: Record<string, unknown>[] = [];
    for (const split of ["train", "dev", "test"]) {
      const p = join(out, `${split}.jsonl`);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf8").split("\n")) if (line) all.push(JSON.parse(line));
    }
    const sampleDir = join(here, "..", "samples");
    mkdirSync(sampleDir, { recursive: true });
    // Stratified: round-robin over (trigger, diagnosis) groups so every kind of row is represented.
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const r of all) {
      const m = r.meta as Record<string, unknown>;
      const k = `${m.trigger}|${m.diagnosis ?? ""}|${m.passive_best === false ? "act" : "passive"}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    const picked: Record<string, unknown>[] = [];
    const lists = [...groups.values()];
    for (let i = 0; picked.length < 200 && lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i] && picked.length < 200) picked.push(l[i]!);
    writeFileSync(join(sampleDir, "sample.jsonl"), picked.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(join(sampleDir, "EXAMPLES.md"), renderExamples(all));
    writeFileSync(join(sampleDir, "sample-stats.json"), JSON.stringify(stats, null, 2));
    console.log(`[gen] wrote ${picked.length} sample rows and EXAMPLES.md to ${sampleDir}`);
  }
}

/** Concatenate finished parts into <out>/{train,dev,test}.jsonl (parts are left in place). */
async function mergeParts(out: string, partsDir: string): Promise<void> {
  const files = existsSync(partsDir) ? readdirSync(partsDir).filter((f) => f.endsWith(".jsonl")).sort() : [];
  const counts: Record<string, number> = {};
  for (const split of ["train", "dev", "test"]) {
    const dst = createWriteStream(join(out, `${split}.jsonl`));
    for (const f of files.filter((x) => x.endsWith(`.${split}.jsonl`))) {
      const rl = createInterface({ input: createReadStream(join(partsDir, f)) });
      for await (const line of rl) {
        if (!line) continue;
        dst.write(line + "\n");
        counts[split] = (counts[split] ?? 0) + 1;
      }
    }
    await new Promise((r) => dst.end(r));
  }
  console.log(`[gen] merged parts: ${JSON.stringify(counts)} -> ${out}/{train,dev,test}.jsonl`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
