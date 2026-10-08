// Separability probes (analysis only; enabled with SIM_PROBE=1). For each decision the sim records facts the runtime
// does NOT state today, split into two families:
//   n_*  computable now from what a runtime observes (history of requests, writes, values, user input)
//   l_*  latent or future: hidden world state (user intent, whether a failed request committed, outages) or what
//        happens after the decision in the base run (filled after the run).
// sim/scripts/separability.py joins them with the labels to measure how much each would separate clear actionable
// rows from benign look-alikes. Nothing here feeds labels or the runtime.

import type { Network, NetEntry } from "../net/network.js";
import type { Knowledge, SimOp, SimWrite } from "./knowledge.js";
import { sigOf } from "./knowledge.js";
import type { Subject } from "./diagnose.js";

export const PROBE = typeof process !== "undefined" && process.env.SIM_PROBE === "1";

export type Probe = Record<string, number | string | boolean>;

/** Per-cell provenance: store|cell -> last writer. */
interface CellInfo {
  w: number;
  t: number;
  start: number;
  user: boolean;
  op?: number;
}

const META = new Set(["id", "version", "v", "rev", "etag", "updatedAt", "updated_at", "createdAt", "created_at", "temp", "tempId", "_temp", "pending", "clientId", "client_id"]);

function itemKey(x: unknown, i: number): string {
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    for (const k of ["id", "key", "slug", "uuid", "_id"]) if (o[k] !== undefined && o[k] !== null) return String(o[k]);
  }
  return `@${i}`;
}

function contentSig(x: unknown): string {
  if (!x || typeof x !== "object") return JSON.stringify(x);
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => !META.has(k)).sort();
  return JSON.stringify(keys.map((k) => [k, o[k]]));
}

export interface CellDiff {
  cells: string[];
  added: number;
  dupId: number;
  dupContent: number;
}

/** Cell-level diff of a store value (top-level fields; lists of items by id, item props shallow). */
export function cellDiff(cur: unknown, nv: unknown): CellDiff {
  const out: CellDiff = { cells: [], added: 0, dupId: 0, dupContent: 0 };
  const field = (k: string, a: unknown, b: unknown) => {
    if (a === b) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      const am = new Map<string, unknown>();
      a.forEach((x, i) => am.set(itemKey(x, i), x));
      const asig = new Set(a.map(contentSig));
      const seen = new Set<string>();
      b.forEach((x, i) => {
        const id = itemKey(x, i);
        if (seen.has(id)) out.dupId++;
        seen.add(id);
        const old = am.get(id);
        if (old === undefined) {
          out.added++;
          out.cells.push(`${k}+${id}`);
          if (asig.has(contentSig(x))) out.dupContent++;
          return;
        }
        if (old === x) return;
        if (old && x && typeof old === "object" && typeof x === "object") {
          const oo = old as Record<string, unknown>;
          const xx = x as Record<string, unknown>;
          for (const p of new Set([...Object.keys(oo), ...Object.keys(xx)])) {
            if (META.has(p)) continue;
            if (JSON.stringify(oo[p]) !== JSON.stringify(xx[p])) out.cells.push(`${k}#${id}.${p}`);
          }
        } else if (JSON.stringify(old) !== JSON.stringify(x)) out.cells.push(`${k}#${id}`);
      });
      for (const id of am.keys()) if (!seen.has(id)) out.cells.push(`${k}-${id}`);
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.cells.push(k);
  };
  if (cur && nv && typeof cur === "object" && typeof nv === "object" && !Array.isArray(cur) && !Array.isArray(nv)) {
    const c = cur as Record<string, unknown>;
    const n = nv as Record<string, unknown>;
    for (const k of new Set([...Object.keys(c), ...Object.keys(n)])) field(k, c[k], n[k]);
  } else field("", cur, nv);
  return out;
}

export class ProbeState {
  cells = new Map<string, CellInfo>();
  /** write id -> cells it changes (for post-run overwrite checks) */
  writeCells = new Map<number, string[]>();
  writeProbe = new Map<number, Probe>();

  constructor(
    private know: Knowledge,
    private weights: (store: string) => Record<string, number>,
  ) {}

  /** Called by the store wrapper before a write is applied (cur/next values known). */
  onWrite(w: SimWrite, cur: unknown, nv: unknown): void {
    const d = cellDiff(cur, nv);
    const op = this.know.getOp(w.op);
    const start = op ? op.t0 : w.t;
    let revert = 0;
    let overlapNewer = 0;
    let userSince = 0;
    let newerUser = 0;
    for (const c of d.cells) {
      const info = this.cells.get(`${w.store}|${c}`);
      if (!info || (w.op !== undefined && info.op === w.op)) continue;
      if (info.start > start) {
        overlapNewer++;
        // A newer operation set this cell; this write changes it again from older data.
        if (!(w.role === "input")) revert++;
        if (info.user) newerUser++;
      }
      if (info.user && info.t > start) userSince++;
    }
    const wts = this.weights(w.store);
    const fields = new Set(d.cells.map((c) => c.split(/[#+\-.]/)[0]!));
    let wsum = 0;
    for (const f of fields) wsum += wts[f] ?? 1;
    const p: Probe = {
      n_cells: d.cells.length,
      n_added: d.added,
      n_dup_id: d.dupId,
      n_dup_content: d.dupContent,
      n_cells_newer: overlapNewer,
      n_revert_newer: revert,
      n_cells_newer_user: newerUser,
      n_user_since: userSince,
      n_weight: Math.round(wsum * 100) / 100,
      n_noop: d.cells.length === 0,
    };
    if (op) p.n_cause_failed = op.outcome !== undefined && op.outcome !== "ok";
    this.writeProbe.set(w.id, p);
    this.writeCells.set(w.id, d.cells.map((c) => `${w.store}|${c}`));
    const user = w.role === "input";
    for (const c of d.cells) this.cells.set(`${w.store}|${c}`, { w: w.id, t: w.t, start, user, ...(w.op !== undefined ? { op: w.op } : {}) });
  }
}

function committedOf(op: SimOp, network: Network | null): boolean {
  if (!network) return false;
  return (op.net ?? []).some((id) => network.log.find((e) => e.id === id)?.committed === true);
}

function outageAt(network: Network, sig: string, t: number): boolean {
  const P = network.profile;
  const inW = (w: { start: number; end: number }) => t >= w.start && t < w.end;
  if ((P.offline ?? []).some(inW)) return true;
  return P.outages.some((o) => inW(o) && (o.endpoints === "*" || o.endpoints.includes(sig)));
}

/** Probe at decision time. */
export function probeDecision(trigger: string, s: Subject, know: Knowledge, network: Network, ps: ProbeState | null, t: number): Probe {
  const p: Probe = {};
  const op = s.op ?? (s.write ? know.getOp(s.write.op) : undefined);
  const it = know.getIntent(s.write?.intent ?? op?.intent);
  if (it) {
    p.l_accidental = it.accidental;
    p.l_intent = it.kind;
  }
  if (op) {
    p.n_background = op.background;
    p.n_attempt = op.attempt;
    if (op.dupOf !== undefined) p.l_dup_of = true;
    const sig = sigOf(op);
    // Periodic refresh of this signature (observable: repeated background requests).
    const bg = know.ops.filter((x) => x.background && x.t0 < t && sigOf(x) === sig).map((x) => x.t0);
    if (bg.length >= 2) {
      const per = (bg[bg.length - 1]! - bg[0]!) / (bg.length - 1);
      p.n_period_s = Math.round(per / 100) / 10;
      p.n_next_refresh_s = Math.max(0, Math.round((per - (t - bg[bg.length - 1]!)) / 100) / 10);
    }
    // The app retried an earlier failure of this signature by itself (observable history).
    p.n_app_retry_seen = know.ops.some((x) => x.retryOf !== undefined && x.t0 < t && sigOf(x) === sig);
    // Identical earlier request (same method/url/body) and whether it committed (latent for failures).
    const prev = [...know.ops].reverse().find((x) => x.id !== op.id && x.t0 <= op.t0 && x.method === op.method && x.url === op.url && x.body === op.body);
    if (prev) {
      p.n_prev_same_dt = Math.round((op.t0 - prev.t0) / 10) / 100;
      const pi = know.getIntent(prev.intent);
      if (pi && it) p.n_prev_same_intent_gap = Math.round((it.t - pi.t) / 10) / 100;
    }
    const e: NetEntry | undefined = s.net ?? (op.net && op.net.length ? network.log.find((x) => x.id === op.net![op.net!.length - 1]) : undefined);
    if (trigger === "failure" || trigger === "stall") {
      if (e) {
        p.l_committed = e.committed;
        p.l_cause = e.cause;
        p.n_status = e.status ?? 0;
      }
      p.l_outage_now = outageAt(network, sig, t);
      p.l_outage_1s = outageAt(network, sig, t + 1000);
      p.l_outage_5s = outageAt(network, sig, t + 5000);
    }
  }
  if (s.write && ps) {
    const wp = ps.writeProbe.get(s.write.id);
    if (wp) Object.assign(p, wp);
    if (op && op.outcome !== undefined && op.outcome !== "ok") p.l_cause_committed = committedOf(op, network);
  }
  if (trigger === "inconsistency" || trigger === "transition") {
    const P = network.profile;
    p.l_socket_drop_30s = (P.socketDrops ?? []).some((w) => w.start < t && w.end > t - 30000);
    p.l_offline_30s = (P.offline ?? []).some((w) => w.start < t && w.end > t - 30000);
  }
  return p;
}

/** After the run: what happened next in the base run (latent/future facts). */
export function probeAfter(trigger: string, t: number, p: Probe, subj: { op?: number; write?: number }, know: Knowledge, ps: ProbeState | null): void {
  const op = know.getOp(subj.op ?? (subj.write !== undefined ? know.getWrite(subj.write)?.op : undefined));
  if (op) {
    p.l_app_retried = know.ops.some((x) => x.retryOf === op.id);
    const it = know.getIntent(op.intent);
    if (it) p.l_user_redo_15s = know.intents.some((x) => x.t > t && x.t < t + 15000 && x.key === it.key && !x.accidental && x.id !== it.id);
  }
  if (subj.write !== undefined && ps) {
    const cells = new Set(ps.writeCells.get(subj.write) ?? []);
    if (cells.size) {
      let first = Infinity;
      for (const w of know.writes) {
        if (w.id <= subj.write || w.t < t || w.t > t + 10000) continue;
        const wc = ps.writeCells.get(w.id);
        if (wc && wc.some((c) => cells.has(c))) {
          first = Math.min(first, w.t - t);
          break;
        }
      }
      p.l_overwritten_s = first === Infinity ? -1 : Math.round(first / 100) / 10;
    }
  }
}
