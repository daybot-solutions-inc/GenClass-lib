// Search oracle (test code; never shown to GenClass). Samples what the user sees every 20 ms and compares the
// list with the correct results for the text in the box.
import type { Oracle, OracleContext } from "../../shared/demo-def.ts";
import { epochNow } from "../../shared/server.ts";
import type { Score } from "../../shared/types.ts";
import { searchCities } from "../../server/data/cities.ts";

/** Display may lag a fresh answer by this much (rendering, or a write held for a decision) before it counts. */
const GRACE_MS = 350;
/** Showing other results for longer than this (after the right answer arrived) is a user-visible bug. */
const STALE_BUG_MS = 400;

interface Sample {
  t: number;
  q: string;
  ok: boolean;
  shown: string;
}

const expectedKey = (q: string) => (q.trim() ? searchCities(q).items.map((c) => c.id).join(",") : "");

export function searchOracle(ctx: OracleContext): Oracle {
  const input = () => ctx.el.querySelector<HTMLInputElement>('[data-testid="search-input"]');
  const shown = () =>
    [...ctx.el.querySelectorAll<HTMLElement>('[data-testid="search-results"] [data-id]')].map((e) => e.dataset.id).join(",");
  const samples: Sample[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  const sample = () => {
    const q = input()?.value ?? "";
    const s = shown();
    samples.push({ t: epochNow(), q, shown: s, ok: s === expectedKey(q) });
  };

  return {
    start() {
      timer = setInterval(sample, 20);
    },
    check(cond) {
      if (cond === "settled") {
        const q = input()?.value ?? "";
        return shown() === expectedKey(q);
      }
      return false;
    },
    async finish(): Promise<Score> {
      sample();
      clearInterval(timer);
      const { log } = await ctx.link.log(0);
      const ok = log.filter((e) => e.route === "search" && e.outcome === "ok" && e.tEnd);
      const deliveries = ok.map((e) => ({ q: new URLSearchParams(e.query).get("q") ?? "", t0: e.t0, tEnd: e.tEnd! }));

      // When did the box start holding its current text?
      let since = samples[0]?.t ?? ctx.t0;
      let staleMs = 0;
      let wrongVisibleMs = 0;
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const b = samples[i];
        if (b.q !== a.q) since = b.t;
        if (a.ok || a.t < ctx.t0) continue;
        const dt = b.t - a.t;
        wrongVisibleMs += dt;
        const answered = deliveries.some((d) => d.q === a.q && d.t0 >= since - 5 && d.tEnd <= a.t - GRACE_MS);
        if (answered) staleMs += dt;
      }

      const last = samples[samples.length - 1];
      const finalOk = last ? last.ok : false;
      const lastKey = ctx.marks.get("lastKey") ?? ctx.t0;
      // Latency: from the last keystroke until the list is right and stays right.
      let latencyMs = NaN;
      if (finalOk) {
        let j = samples.length - 1;
        while (j > 0 && samples[j - 1].ok && samples[j - 1].t >= lastKey) j--;
        latencyMs = Math.max(0, samples[j].t - lastKey);
      }
      const reasons: string[] = [];
      if (!finalOk) reasons.push(`final list does not match “${last?.q ?? ""}”`);
      if (staleMs >= STALE_BUG_MS) reasons.push(`showed other results for ${Math.round(staleMs)} ms after the right answer arrived`);
      const requests = log.filter((e) => e.route === "search").length;
      return {
        bug: reasons.length > 0,
        reasons,
        metrics: {
          finalWrong: finalOk ? 0 : 1,
          staleMs: Math.round(staleMs),
          wrongVisibleMs: Math.round(wrongVisibleMs),
          staleShare: Math.round((staleMs / Math.max(1, ctx.tEnd - ctx.t0)) * 1000) / 1000,
          latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : NaN,
          requests,
        },
      };
    },
  };
}
