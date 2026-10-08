// Generate real-browser rows: a pool of worker processes (one headless Chromium each) labels trajectories for a
// seed range; the main process serves the built apps, appends rows per split and records finished seeds, so an
// interrupted run resumes where it stopped (run the same command again).
//
//   node dist/harness/gen.js --out ~/gcl/real-out/pilot --seed 1 --trajectories 300 --workers 48
//   options: --apps a,b  --max-points 6  --futures 3  --test-keep 0.5  --clean  --unlabeled 40

import { fork, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrajectoryOut } from "./trajectory.js";
import { TEST_APPS, TEST_FRAMEWORKS, TEST_PATTERNS } from "./scenario.js";
import { APPS } from "./apps.gen.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? "true" : v;
}

const out = arg("out")!;
if (!out) throw new Error("--out required");
const seed0 = Number(arg("seed", "1"));
const n = Number(arg("trajectories", "100"));
const workers = Number(arg("workers", String(Math.max(1, cpus().length - 2))));
const port = Number(arg("port", "8790"));
const opts = {
  maxPoints: Number(arg("max-points", "6")),
  futures: Number(arg("futures", "3")),
  adaptive: arg("adaptive", "true") !== "false",
  testKeep: Number(arg("test-keep", "0.5")),
  apps: arg("apps")?.split(",").filter(Boolean),
  clean: arg("clean") === "true",
  unlabeled: Number(arg("unlabeled", "40")),
};
mkdirSync(out, { recursive: true });
const doneFile = join(out, "done.txt");
const done = new Set<number>(existsSync(doneFile) ? readFileSync(doneFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
const todo: number[] = [];
for (let s = seed0; s < seed0 + n; s++) if (!done.has(s)) todo.push(s);

const stats = {
  started: new Date().toISOString(),
  trajectories: done.size,
  rows: { train: 0, dev: 0, test: 0 } as Record<string, number>,
  unlabeled: { train: 0, dev: 0, test: 0 } as Record<string, number>,
  skipped: {} as Record<string, number>,
  drops: {} as Record<string, number>,
  notes: {} as Record<string, number>,
  runs: 0,
  runMs: 0,
  wallMs: 0,
  byTrigger: {} as Record<string, { n: number; passiveBest: number; best: Record<string, number>; diagnosis: Record<string, number>; harm: Record<string, number[]> }>,
  byApp: {} as Record<string, { trajectories: number; rows: number; decisions: number }>,
  diagnosisOnly: 0,
  errors: [] as string[],
};
const statsFile = join(out, "stats.json");
if (existsSync(statsFile) && done.size) {
  try {
    Object.assign(stats, JSON.parse(readFileSync(statsFile, "utf8")));
  } catch {
    /* fresh stats */
  }
}

function record(t: TrajectoryOut): void {
  const byFile = new Map<string, string[]>();
  for (const r of t.rows) {
    const f = (r.meta as { unlabeled?: boolean }).unlabeled ? `unlabeled-${r.split}.jsonl` : `${r.split}.jsonl`;
    (byFile.get(f) ?? byFile.set(f, []).get(f)!).push(JSON.stringify(r));
  }
  for (const [f, lines] of byFile) appendFileSync(join(out, f), lines.join("\n") + "\n");
  appendFileSync(doneFile, `${t.seed}\n`);
  stats.trajectories++;
  stats.runs += t.runs;
  stats.runMs += t.runMs;
  stats.wallMs += t.realMs;
  if (t.skipped) {
    const k = t.skipped.split(":")[0]!;
    stats.skipped[k] = (stats.skipped[k] ?? 0) + 1;
    if (k !== "test-subsample" && stats.errors.length < 50) stats.errors.push(`${t.seed} ${t.app}: ${t.skipped.slice(0, 300)}`);
  }
  for (const [k, v] of Object.entries(t.drops)) stats.drops[k] = (stats.drops[k] ?? 0) + v;
  for (const [k, v] of Object.entries(t.notes ?? {})) stats.notes[k] = (stats.notes[k] ?? 0) + v;
  const a = (stats.byApp[t.app] ??= { trajectories: 0, rows: 0, decisions: 0 });
  a.trajectories++;
  a.rows += t.rows.filter((r) => !(r.meta as { unlabeled?: boolean }).unlabeled).length;
  a.decisions += t.decisions;
  for (const r of t.rows) {
    if ((r.meta as { unlabeled?: boolean }).unlabeled) {
      stats.unlabeled[r.split] = (stats.unlabeled[r.split] ?? 0) + 1;
      continue;
    }
    stats.rows[r.split] = (stats.rows[r.split] ?? 0) + 1;
    if ((r.meta as { diagnosis_only?: boolean }).diagnosis_only) stats.diagnosisOnly++;
  }
  for (const p of t.points) {
    const b = (stats.byTrigger[p.trigger] ??= { n: 0, passiveBest: 0, best: {}, diagnosis: {}, harm: {} });
    b.n++;
    if (p.passiveBest) b.passiveBest++;
    b.best[p.best] = (b.best[p.best] ?? 0) + 1;
    if (p.diagnosis) b.diagnosis[p.diagnosis] = (b.diagnosis[p.diagnosis] ?? 0) + 1;
    if (p.passiveBest) for (const [act, h] of Object.entries(p.harm)) (b.harm[act] ??= []).push(h);
  }
}

function summary(): Record<string, unknown> {
  const s = JSON.parse(JSON.stringify(stats)) as typeof stats & { harmMean?: Record<string, Record<string, number>> };
  const hm: Record<string, Record<string, number>> = {};
  for (const [tr, b] of Object.entries(stats.byTrigger)) {
    hm[tr] = {};
    for (const [a, xs] of Object.entries(b.harm)) hm[tr]![a] = Math.round((xs.reduce((x, y) => x + y, 0) / Math.max(1, xs.length)) * 1000) / 1000;
    (s.byTrigger[tr] as unknown as { harm: unknown }).harm = hm[tr];
  }
  return { ...s, opts, workers, updated: new Date().toISOString() };
}

/** Batch manifest for TRAIN (training/NEEDS.md item 11). */
function manifest(): Record<string, unknown> {
  return {
    dir: out,
    source: "realapps",
    runtime: "situation-v1 (packages/runtime/src bundled from source)",
    seeds: [seed0, seed0 + n - 1],
    trajectories: stats.trajectories,
    gold: stats.rows,
    unlabeled: stats.unlabeled,
    files: { gold: "{train,dev,test}.jsonl (decision rows with soft action labels + diagnosis; diagnosis-only rows have meta.diagnosis_only; ask rows have meta.trigger = 'ask')", unlabeled: "unlabeled-{train,dev,test}.jsonl (meta.unlabeled: gold diagnosis only, action left to the teacher)" },
    on_policy: false,
    held_out: { frameworks: [...TEST_FRAMEWORKS], apps: [...new Set([...TEST_APPS, ...APPS.filter((a) => a.heldOut).map((a) => a.name)])], patterns: [...TEST_PATTERNS] },
    apps: APPS.map((a) => ({ name: a.name, framework: a.framework, libs: a.libs, integration: a.integration, ...(a.source ? { oss: a.source.repo, commit: a.source.commit, license: a.source.license } : {}) })),
    options: opts,
    updated: new Date().toISOString(),
  };
}

const t0 = Date.now();
let next = 0;
let active = 0;
let finished = 0;
const children: ChildProcess[] = [];
await new Promise<void>((resolveAll) => {
  if (!todo.length) return resolveAll();
  const launch = (wi: number) => {
    const ch = fork(join(HERE, "worker.js"), [], { env: { ...process.env, RW_PORT: String(port), RW_OPTS: JSON.stringify(opts) }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    children.push(ch);
    const give = () => {
      if (next >= todo.length) {
        ch.send({ type: "stop" });
        return;
      }
      ch.send({ type: "seed", seed: todo[next++] });
    };
    ch.on("message", (m: { type: string; out?: TrajectoryOut; seed?: number; error?: string }) => {
      if (m.type === "ready") give();
      else if (m.type === "done" && m.out) {
        record(m.out);
        finished++;
        give();
      } else if (m.type === "failed") {
        stats.errors.length < 50 && stats.errors.push(`${m.seed}: ${m.error}`);
        finished++;
        give();
      }
    });
    ch.on("exit", () => {
      active--;
      if (active === 0) resolveAll();
    });
    active++;
    void wi;
  };
  for (let i = 0; i < Math.min(workers, todo.length); i++) launch(i);
  const tick = setInterval(() => {
    const el = (Date.now() - t0) / 1000;
    const rows = Object.values(stats.rows).reduce((a, b) => a + b, 0);
    const ul = Object.values(stats.unlabeled).reduce((a, b) => a + b, 0);
    console.log(`[realapps] ${finished}/${todo.length} trajectories, ${rows} gold rows + ${ul} unlabeled total, ${(finished / el).toFixed(2)} traj/s this session, ${active} workers`);
    writeFileSync(statsFile, JSON.stringify(summary(), null, 1));
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest(), null, 1));
  }, 30000);
  tick.unref();
});
writeFileSync(statsFile, JSON.stringify(summary(), null, 1));
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest(), null, 1));
console.log(`[realapps] done: ${stats.trajectories} trajectories, rows ${JSON.stringify(stats.rows)}, unlabeled ${JSON.stringify(stats.unlabeled)}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(0);
