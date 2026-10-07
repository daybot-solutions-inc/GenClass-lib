// Board oracle (test code): the board on screen against the server's board, at the end and over time.
import type { Oracle, OracleContext } from "../../shared/demo-def.ts";
import { epochNow } from "../../shared/server.ts";
import type { Score } from "../../shared/types.ts";
import { BOARD_SEED, type ColumnId } from "../../server/worlds/board.ts";

const WINDOW_MS = 1500;

interface Sample {
  t: number;
  cols: Record<string, string>;
  pending: number;
}

interface Move {
  t: number;
  card: string;
  column: ColumnId;
  by: string;
  version: number;
}

export function boardOracle(ctx: OracleContext): Oracle {
  const samples: Sample[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const read = (): Sample => {
    const cols: Record<string, string> = {};
    let pending = 0;
    for (const colEl of ctx.el.querySelectorAll<HTMLElement>('[data-testid^="col-"]')) {
      const col = colEl.dataset.testid!.slice(4);
      for (const c of colEl.querySelectorAll<HTMLElement>("[data-card]")) {
        cols[c.dataset.card!] = col;
        if (c.dataset.pending === "true") pending++;
      }
    }
    return { t: epochNow(), cols, pending };
  };

  return {
    start() {
      timer = setInterval(() => samples.push(read()), 50);
    },
    check(cond) {
      if (cond === "loaded") return ctx.el.querySelectorAll("[data-card]").length > 0;
      return false;
    },
    async finish(): Promise<Score> {
      samples.push(read());
      clearInterval(timer);
      const truth = await ctx.link.truth<{ cards: Record<string, { column: string; version: number }>; moves: Move[] }>();
      const moves = truth.state.moves;
      const initial: Record<string, string> = Object.fromEntries(BOARD_SEED.map(([id, , c]) => [id, c]));
      const columnAt = (card: string, t: number) => {
        let c = initial[card];
        for (const m of moves) if (m.card === card && m.t <= t) c = m.column;
        return c;
      };
      const allowed = (card: string, t: number) => {
        const out = new Set([columnAt(card, t - WINDOW_MS), columnAt(card, t + WINDOW_MS)]);
        for (const m of moves) if (m.card === card && m.t >= t - WINDOW_MS && m.t <= t + WINDOW_MS) out.add(m.column);
        return out;
      };

      let divergedMs = 0;
      let maxRun = 0;
      let run = 0;
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        if (a.t < ctx.t0) continue;
        const dt = samples[i].t - a.t;
        const wrong = Object.entries(a.cols).some(([id, c]) => !allowed(id, a.t).has(c));
        if (wrong) {
          divergedMs += dt;
          run += dt;
          maxRun = Math.max(maxRun, run);
        } else run = 0;
      }

      const last = samples[samples.length - 1];
      const mismatched = Object.entries(truth.state.cards).filter(([id, c]) => last.cols[id] !== c.column).map(([id]) => id);
      // Jump-backs: a card the user moved shows its old column again after the server accepted the move.
      let jumpBacks = 0;
      for (const m of moves.filter((x) => x.by === "you")) {
        const prev = columnAt(m.card, m.t - 1);
        const later = samples.filter((s) => s.t > m.t + 400 && s.t < m.t + 5000);
        const next = moves.find((x) => x.card === m.card && x.t > m.t);
        if (later.some((s) => s.cols[m.card] === prev && (!next || s.t < next.t))) jumpBacks++;
      }
      const lastMove = ctx.marks.get("lastMove") ?? ctx.t0;
      let latencyMs = NaN;
      if (!mismatched.length) {
        let j = samples.length - 1;
        const good = (s: Sample) => Object.entries(s.cols).every(([id, c]) => columnAt(id, s.t) === c);
        while (j > 0 && good(samples[j - 1]) && samples[j - 1].t >= lastMove) j--;
        latencyMs = Math.max(0, samples[j].t - lastMove);
      }

      const reasons: string[] = [];
      if (mismatched.length) reasons.push(`${mismatched.length} card${mismatched.length > 1 ? "s" : ""} in the wrong column at the end (${mismatched.join(", ")})`);
      else if (maxRun > 2000) reasons.push(`board disagreed with the server for ${(maxRun / 1000).toFixed(1)} s`);
      if (last.pending) reasons.push(`${last.pending} card${last.pending > 1 ? "s" : ""} stuck “syncing”`);
      return {
        bug: reasons.length > 0,
        reasons,
        metrics: {
          finalMismatches: mismatched.length,
          divergedMs: Math.round(divergedMs),
          maxDivergedMs: Math.round(maxRun),
          jumpBacks,
          userMoves: moves.filter((m) => m.by === "you").length,
          teammateMoves: moves.filter((m) => m.by !== "you").length,
          latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : NaN,
        },
      };
    },
  };
}
