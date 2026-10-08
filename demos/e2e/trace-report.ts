// Analyse traced trials (eval.ts --trace): which writes GenClass held, in which order writes really applied, and
// how that relates to bugs the oracle found. Usage:
//   node --experimental-strip-types e2e/trace-report.ts e2e/.out/traces-<tag>.json > e2e/.out/trace-report.md
import { readFileSync } from "node:fs";

interface Proposal {
  id: number;
  t: number;
  store: string;
  paths: string[];
  cause?: number;
  changes: { path: string; before: unknown; after: unknown }[];
}
interface Apply {
  t: number;
  mutation: number;
  store: string;
  paths: string[];
  user: boolean;
  op?: number;
  summary: string[];
}
interface Decision {
  id: string;
  trigger: string;
  subject: string;
  at: number;
  latencyMs: number;
  action: string;
  candidate?: string;
  mass?: number;
  executed: boolean;
  reason?: string;
  diagnosis: string;
  mutation?: number;
  op?: number;
}
interface Op {
  kind: string;
  name: string;
  t: number;
  cause?: number;
}
interface Trace {
  origin: number;
  proposals: Proposal[];
  applies: Apply[];
  decisions: Decision[];
  ops: Record<string, Op>;
}
interface Traced {
  demo: string;
  mode: string;
  kind: string;
  seed: number;
  label: string;
  bug: boolean;
  reasons: string[];
  metrics: Record<string, number>;
  details?: { mismatched?: { card: string; shown: string; server: string; moves: { t: number; column: string; by: string; version: number }[] }[]; t0?: number };
  error?: string;
  trace?: Trace;
}

const file = process.argv[2] ?? "e2e/.out/traces.json";
const all = JSON.parse(readFileSync(file, "utf8")) as Traced[];
/** Optional second Off run of the same seeds (A/A noise floor). */
const offB = process.argv[3] ? (JSON.parse(readFileSync(process.argv[3], "utf8")) as Traced[]) : [];
const out: string[] = [];
const say = (s = "") => out.push(s);
const fmt = (ms: number) => `${ms >= 0 ? "+" : ""}${(ms / 1000).toFixed(3)}s`;

interface W {
  p: Proposal;
  applied?: Apply;
  wait: number | null;
  source: string;
  user: boolean;
  decision?: Decision;
}

/** Writes of one trial with their application and a readable source. */
function writes(tr: Trace, store: string): W[] {
  const applied = new Map<number, Apply>();
  for (const a of tr.applies) if (!applied.has(a.mutation)) applied.set(a.mutation, a);
  const dec = new Map<number, Decision>();
  for (const d of tr.decisions) if (d.mutation !== undefined) dec.set(d.mutation, d);
  return tr.proposals
    .filter((p) => p.store === store)
    .map((p) => {
      const a = applied.get(p.id);
      const op = p.cause !== undefined ? tr.ops[String(p.cause)] : undefined;
      let source = op ? `${op.kind === "user" ? "user " : ""}${op.name}` : "no op (e.g. EventSource message)";
      const user = a?.user ?? op?.kind === "user";
      if (store === "board") {
        const touchesNotice = p.paths.some((x) => x.endsWith(".notice"));
        const cards = new Set(p.paths.map((x) => x.split(".")[2]).filter((x) => x && /^c\d+$/.test(x)));
        if (!op) source = "live event";
        else if (user) source = `user: ${op.name}`;
        else if (/^POST /.test(op.name) && touchesNotice) source = `rollback after failed ${op.name}`;
        else if (/^POST /.test(op.name)) source = `confirmation of ${op.name}`;
        else if (/^GET /.test(op.name)) source = `load (${op.name})`;
        if (cards.size > 1) source += ` [${cards.size} cards]`;
      }
      return { p, applied: a, wait: a ? a.t - p.t : null, source, user, decision: dec.get(p.id) };
    });
}

const cardsOf = (w: W) => new Set(w.p.paths.map((x) => x.split(".")[2]).filter((x) => x && /^c\d+$/.test(x)));
const columnChange = (w: W, card: string) => {
  const c = w.p.changes.find((x) => x.path === `board.cards.${card}.column` || x.path === `board.cards.${card}`);
  if (!c) return "";
  const col = (v: unknown) => (v && typeof v === "object" ? (v as { column?: string }).column : v);
  return `${String(col(c.before))} → ${String(col(c.after))}`;
};

// ------------------------------------------------------------------------------------------------ board
say("# Trace report");
say();
say(`Source: \`${file}\`, ${all.length} traced trials.`);
say();
const board = all.filter((r) => r.demo === "board" && r.trace && !r.error);
if (board.length) {
  say("## Board: what holding writes does");
  say();
  const byMode = new Map<string, Traced[]>();
  for (const r of board) byMode.set(`${r.mode}/${r.kind}`, [...(byMode.get(`${r.mode}/${r.kind}`) ?? []), r]);
  say("| mode/kind | trials | bugs | writes | held (waited > 2 ms) | median wait of held | user writes | held writes applied after a newer user write to the same card | trials with such a reorder |");
  say("|---|---|---|---|---|---|---|---|---|");
  for (const [k, rs] of [...byMode].sort()) {
    let n = 0;
    let held = 0;
    let userW = 0;
    let reorders = 0;
    let trialsWithReorder = 0;
    const waits: number[] = [];
    for (const r of rs) {
      const ws = writes(r.trace!, "board");
      n += ws.length;
      let rr = 0;
      for (const w of ws) {
        if (w.user) userW++;
        if (w.wait !== null && w.wait > 2) {
          held++;
          waits.push(w.wait);
          const cards = cardsOf(w);
          const later = ws.filter((u) => u.user && u.p.t > w.p.t && u.applied && w.applied && u.applied.t < w.applied.t && [...cardsOf(u)].some((c) => cards.has(c)));
          if (later.length) rr++;
        }
      }
      reorders += rr;
      if (rr) trialsWithReorder++;
    }
    waits.sort((a, b) => a - b);
    say(`| ${k} | ${rs.length} | ${rs.filter((r) => r.bug).length} | ${n} | ${held} | ${waits.length ? Math.round(waits[Math.floor(waits.length / 2)]) + " ms" : "–"} | ${userW} | ${reorders} | ${trialsWithReorder} |`);
  }
  say();

  // A/A: the same seeds with GenClass Off twice. Flips here are the noise floor of the paired comparison.
  const offA = new Map(board.filter((r) => r.mode === "off" && r.kind === "chaos").map((r) => [r.seed, r]));
  const bB = offB.filter((r) => r.demo === "board" && r.kind === "chaos" && !r.error);
  if (bB.length) {
    let ab = 0;
    let ba = 0;
    let n = 0;
    for (const r of bB) {
      const a = offA.get(r.seed);
      if (!a) continue;
      n++;
      if (a.bug && !r.bug) ab++;
      if (!a.bug && r.bug) ba++;
    }
    say(`A/A (Off run A vs Off run B, same ${n} seeds): bugs ${[...offA.values()].filter((r) => r.bug).length} vs ${bB.filter((r) => r.bug).length}; flips ${ba} (clean in A, bug in B) and ${ab} (the other way).`);
    say();
  }

  // Paired seeds: clean with Off, bug with Guard (or Heal).
  for (const mode of ["guard", "heal"]) {
    const off = new Map(board.filter((r) => r.mode === "off" && r.kind === "chaos").map((r) => [r.seed, r]));
    const introduced = board.filter((r) => r.mode === mode && r.kind === "chaos" && r.bug && off.get(r.seed) && !off.get(r.seed)!.bug);
    const fixed = board.filter((r) => r.mode === mode && r.kind === "chaos" && !r.bug && off.get(r.seed)?.bug);
    say(`### ${mode}: ${introduced.length} seeds clean with Off but buggy with ${mode}, ${fixed.length} the other way`);
    say();
    const classes = new Map<string, number>();
    for (const r of introduced) {
      const tr = r.trace!;
      const ws = writes(tr, "board");
      const t0 = (r.details?.t0 ?? tr.origin) - tr.origin;
      const mism = r.details?.mismatched ?? [];
      say(`#### seed ${r.seed} (${r.label}): ${r.reasons.join("; ")}`);
      say();
      for (const m of mism) {
        const card = m.card;
        const touching = ws.filter((w) => cardsOf(w).has(card));
        const appliedOrder = touching.filter((w) => w.applied).sort((a, b) => a.applied!.t - b.applied!.t);
        const lastApplied = appliedOrder[appliedOrder.length - 1];
        // Was the last write to this card a held write that landed after a newer user write?
        let cls = "other";
        if (lastApplied && lastApplied.wait !== null && lastApplied.wait > 2) {
          const newerUser = touching.find((u) => u.user && u.p.t > lastApplied.p.t && u.applied && u.applied.t < lastApplied.applied!.t);
          cls = newerUser ? `held ${lastApplied.source.split(" [")[0].replace(/ of POST.*| after failed POST.*/, "")} applied after a newer user move` : `held ${lastApplied.source.split(" [")[0]} applied last`;
        } else if (lastApplied) {
          cls = `last write applied without a hold (${lastApplied.source.split(" [")[0].replace(/:.*/, "")})`;
        }
        classes.set(cls, (classes.get(cls) ?? 0) + 1);
        say(`Card **${card}**: screen ${m.shown}, server ${m.server}. Classified: ${cls}.`);
        say();
        say("```");
        for (const w of touching) {
          const d = w.decision;
          const dec = d ? ` · decision ${d.id}: ${d.diagnosis}, model chose ${d.action}${d.executed ? "" : `, passive ran (${d.reason ?? "no reason"})`}, ${d.latencyMs} ms` : "";
          const applied = w.applied ? `applied ${fmt(w.applied.t - t0)}${w.wait! > 2 ? ` (waited ${Math.round(w.wait!)} ms)` : ""}` : "never applied";
          say(`${fmt(w.p.t - t0)}  #${w.p.id} ${w.source.padEnd(46).slice(0, 46)} ${columnChange(w, card).padEnd(20)} ${applied}${dec}`);
        }
        const serverMoves = m.moves.map((mv) => `${fmt(mv.t - tr.origin - t0)} server ${card} → ${mv.column} v${mv.version} by ${mv.by}`);
        if (serverMoves.length) say(serverMoves.join("\n"));
        say("```");
        say();
        // The same card in the Off run of this seed (times relative to the first proposal of each run).
        const o = offA.get(r.seed);
        if (o?.trace) {
          const ow = writes(o.trace, "board").filter((w) => cardsOf(w).has(card));
          const o0 = o.trace.proposals[0]?.t ?? 0;
          const g0 = tr.proposals[0]?.t ?? 0;
          say(`Off run of seed ${r.seed} (ok), same card; times from each run's first write (Guard's first write is at ${fmt(t0 - g0)} on the scale above):`);
          say();
          say("```");
          for (const w of ow) say(`${fmt(w.p.t - o0)}  #${w.p.id} ${w.source.padEnd(46).slice(0, 46)} ${columnChange(w, card).padEnd(20)} ${w.applied ? `applied ${fmt(w.applied.t - o0)}` : "no-op"}`);
          say("```");
          say();
        }
      }
    }
    if (classes.size) {
      say(`Mechanism counts (${mode}, last write to each mismatched card):`);
      for (const [c, n] of [...classes].sort((a, b) => b[1] - a[1])) say(`- ${c}: ${n}`);
      say();
    }
  }
}

// ------------------------------------------------------------------------------------------------ search
const search = all.filter((r) => r.demo === "search" && r.trace && !r.error);
if (search.length) {
  say("## Search: where the latency goes");
  say();
  say("| mode/kind | trials | latency p50 (oracle) | response writes | held | median wait of held | decisions | median decision latency | held writes released before their decision arrived |");
  say("|---|---|---|---|---|---|---|---|---|");
  const groups = new Map<string, Traced[]>();
  for (const r of search) groups.set(`${r.mode}/${r.kind}`, [...(groups.get(`${r.mode}/${r.kind}`) ?? []), r]);
  for (const [k, rs] of [...groups].sort()) {
    let resp = 0;
    let held = 0;
    const waits: number[] = [];
    let decs = 0;
    let late = 0;
    const dlat: number[] = [];
    for (const r of rs) {
      const ws = writes(r.trace!, "search").filter((w) => !w.user);
      resp += ws.length;
      for (const w of ws) {
        if (w.wait !== null && w.wait > 2) {
          held++;
          waits.push(w.wait);
          if (w.decision && w.decision.latencyMs > w.wait + 5) late++;
        }
      }
      for (const d of r.trace!.decisions) {
        decs++;
        dlat.push(d.latencyMs);
      }
    }
    dlat.sort((a, b) => a - b);
    waits.sort((a, b) => a - b);
    const lat = rs.map((r) => r.metrics.latencyMs).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    say(`| ${k} | ${rs.length} | ${lat.length ? Math.round(lat[Math.floor(lat.length / 2)]) + " ms" : "–"} | ${resp} | ${held} | ${waits.length ? Math.round(waits[Math.floor(waits.length / 2)]) + " ms" : "–"} | ${decs} | ${dlat.length ? Math.round(dlat[Math.floor(dlat.length / 2)]) + " ms" : "–"} | ${late} |`);
  }
  say();
  // One concrete example: a clean guard trial with the longest held write.
  const ex = search
    .filter((r) => r.mode === "guard" && r.kind === "clean")
    .map((r) => ({ r, ws: writes(r.trace!, "search").filter((w) => !w.user && w.wait !== null) }))
    .sort((a, b) => Math.max(0, ...b.ws.map((w) => w.wait!)) - Math.max(0, ...a.ws.map((w) => w.wait!)))[0];
  if (ex) {
    const tr = ex.r.trace!;
    say(`Example (guard, clean, seed ${ex.r.seed}): every write of search results and the decision about it.`);
    say();
    say("```");
    for (const w of ex.ws) {
      const d = w.decision;
      say(`#${w.p.id} ${w.source.slice(0, 40).padEnd(40)} waited ${Math.round(w.wait!)} ms${d ? ` · ${d.trigger} decision ${d.id}: ${d.diagnosis}, chose ${d.action}, ${d.latencyMs} ms${d.executed ? "" : `, passive ran (${d.reason})`}` : ""}`);
      const facts = tr.decisions.find((x) => x.mutation === w.p.id)?.subject;
      if (facts) say(`     subject: ${facts}`);
    }
    say("```");
    say();
  }
}

console.log(out.join("\n"));
