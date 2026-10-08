// Decisions oracle (test code): recomputes the right answer to every question the app asked, at the moment it
// asked, from what actually happened (typing, requests in flight, request outcomes and timings, what the server
// stored), and compares it with the answer the app acted on.
import type { Oracle, OracleContext } from "../../shared/demo-def.ts";
import type { LogEntry } from "../../shared/protocol.ts";
import { epochNow } from "../../shared/server.ts";
import type { Score } from "../../shared/types.ts";
import type { JournalVersion } from "../../server/worlds/decisions.ts";
import { nativeClearInterval, nativeSetInterval } from "../../shared/native.ts";

const LEVELS = ["failing", "poor", "fair", "good", "excellent"];

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const v = xs.slice().sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

/** Request outcomes the app saw in a window (excluding the backup upload's own control calls). */
function window(log: LogEntry[], from: number, to: number) {
  const done = log.filter((e) => e.tEnd !== undefined && e.tEnd >= from && e.tEnd <= to && e.route !== "backup" && e.route !== "backup/control");
  const failed = done.filter((e) => e.outcome === "rejected" || e.outcome === "lost" || e.outcome === "network");
  const ok = done.filter((e) => e.outcome === "ok");
  return { n: done.length, failRate: done.length ? failed.length / done.length : 0, failed: failed.length, med: median(ok.map((e) => e.tEnd! - e.t0)) };
}

export function decisionsOracle(ctx: OracleContext): Oracle {
  const keys: number[] = [];
  const texts: { t: number; text: string }[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const $ = (id: string) => ctx.el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const onKey = () => keys.push(epochNow());

  return {
    start() {
      ctx.el.addEventListener("keydown", onKey, true);
      ctx.el.addEventListener("input", onKey, true);
      timer = nativeSetInterval(() => texts.push({ t: epochNow(), text: ($("journal-body") as HTMLTextAreaElement | null)?.value ?? "" }), 25);
    },
    check(cond) {
      if (cond === "loaded") return (($("journal-body") as HTMLTextAreaElement | null)?.value.length ?? 0) > 0;
      if (cond === "leaveAnswered") return !$("leave-confirm")!.hidden || !$("closed")!.hidden;
      if (cond === "noConfirm") return $("leave-confirm")!.hidden;
      if (cond === "notClosed") return $("closed")!.hidden;
      return false;
    },
    async finish(): Promise<Score> {
      nativeClearInterval(timer);
      ctx.el.removeEventListener("keydown", onKey, true);
      ctx.el.removeEventListener("input", onKey, true);
      const truth = await ctx.link.truth<{ history: JournalVersion[] }>();
      const { log } = await ctx.link.log(0);
      const history = truth.state.history;
      const entries = [...ctx.el.querySelectorAll<HTMLElement>('[data-testid="decision"]')].map((li) => ({
        q: li.dataset.q!,
        answer: li.dataset.answer!,
        source: li.dataset.source!,
        at: Number(li.dataset.askedAt),
        ms: Number(li.dataset.ms),
      }));

      const per: Record<string, { n: number; ok: number }> = {};
      const reasons: string[] = [];
      for (const d of entries) {
        const T = d.at;
        let expected = "";
        let correct = false;
        if (d.q === "backup") {
          const typing = keys.some((k) => k >= T - 2500 && k <= T);
          const saving = log.some((e) => e.route === "journal/save" && e.t0 <= T && (e.tEnd === undefined || e.tEnd > T));
          const w = window(log, T - 8000, T);
          const slow = (window(log, T - 10000, T).med ?? 0) >= 600;
          expected = !typing && !saving && w.failed === 0 && !slow ? "start now" : "postpone";
          correct = d.answer === expected;
        } else if (d.q === "quality") {
          const w = window(log, T - 15000, T);
          expected = w.failRate >= 0.25 ? "thumbnails" : (w.med ?? 0) >= 450 ? "reduced" : "full";
          correct = d.answer === expected;
        } else if (d.q === "leave") {
          let text = texts[0]?.text ?? "";
          for (const s of texts) if (s.t <= T) text = s.text;
          let stored = history[0]?.body ?? "";
          for (const h of history) if (h.t <= T) stored = h.body;
          const saving = log.some((e) => e.route === "journal/save" && e.t0 <= T && (e.tEnd === undefined || e.tEnd > T));
          expected = text !== stored || saving ? "warn" : "let go";
          correct = d.answer === expected;
        } else if (d.q === "health") {
          const w = window(log, T - 15000, T);
          const med = w.med ?? 0;
          const level =
            w.n === 0 ? 3 : w.failRate >= 0.5 ? 0 : w.failRate >= 0.2 || med >= 900 ? 1 : w.failRate > 0 || med >= 350 ? 2 : med >= 120 ? 3 : 4;
          expected = LEVELS[level];
          correct = Math.abs(LEVELS.indexOf(d.answer) - level) <= 1;
        }
        per[d.q] ??= { n: 0, ok: 0 };
        per[d.q].n++;
        if (correct) per[d.q].ok++;
        else reasons.push(`${d.q}: answered “${d.answer}” (${d.source}), right answer “${expected}”`);
      }
      const n = entries.length;
      const wrong = reasons.length;
      const metrics: Record<string, number> = {
        decisions: n,
        wrong,
        accuracy: n ? Math.round(((n - wrong) / n) * 1000) / 1000 : NaN,
        answeredByGenClass: entries.filter((e) => e.source === "genclass").length,
        latencyMs: n ? Math.round(entries.reduce((a, e) => a + e.ms, 0) / n) : NaN,
      };
      for (const [q, v] of Object.entries(per)) {
        metrics[`${q}.n`] = v.n;
        metrics[`${q}.ok`] = v.ok;
      }
      return { bug: wrong > 0, reasons, metrics };
    },
  };
}
