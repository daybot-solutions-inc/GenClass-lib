// Status oracle (test code): compares every card with the true health of its service over time (allowing one
// poll interval plus latency to notice a change), counts error banners and the request volume.
import type { Oracle, OracleContext } from "../../shared/demo-def.ts";
import { epochNow } from "../../shared/server.ts";
import type { Score } from "../../shared/types.ts";
import { SERVICES, truthAt, type Health, type Incident } from "../../server/worlds/status.ts";

const GRACE_MS = 3500;
const POLL_MS = 2000;

interface Sample {
  t: number;
  shown: Record<string, string>;
  banners: string[];
}

const red = (s: string) => s === "down" || s === "unreachable";

export function statusOracle(ctx: OracleContext): Oracle {
  const samples: Sample[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const read = (): Sample => {
    const shown: Record<string, string> = {};
    for (const s of SERVICES) shown[s.id] = ctx.el.querySelector<HTMLElement>(`[data-testid="svc-${s.id}"]`)?.dataset.state ?? "unknown";
    const banners = [...ctx.el.querySelectorAll<HTMLElement>('[data-testid="banner"]')].map((b) => b.dataset.id ?? "");
    return { t: epochNow(), shown, banners };
  };

  return {
    start() {
      timer = setInterval(() => samples.push(read()), 50);
    },
    check(cond) {
      if (cond === "loaded") return Object.values(read().shown).every((s) => s !== "unknown");
      return false;
    },
    async finish(): Promise<Score> {
      samples.push(read());
      clearInterval(timer);
      const truth = await ctx.link.truth<{ incidents: Incident[] }>();
      const incidents = truth.state.incidents;
      const { log } = await ctx.link.log(0);

      // Truth states a card may legitimately show at t: anything true in [t - GRACE, t].
      const allowed = (svc: string, t: number): Set<string> => {
        const out = new Set<string>([truthAt(incidents, svc, t)]);
        for (const i of incidents) {
          if (i.svc !== svc) continue;
          if (i.to > t - GRACE_MS && i.from < t) out.add(i.status);
          if (i.to > t - GRACE_MS && i.to <= t) out.add(truthAt(incidents.filter((x) => x !== i), svc, i.to));
          if (i.from > t - GRACE_MS && i.from <= t) out.add(truthAt(incidents.filter((x) => x !== i), svc, i.from - 1));
        }
        return out;
      };

      let falseAlarmMs = 0;
      let missedMs = 0;
      let otherMs = 0;
      for (let k = 1; k < samples.length; k++) {
        const a = samples[k - 1];
        if (a.t < ctx.t0 + GRACE_MS) continue;
        const dt = samples[k].t - a.t;
        for (const s of SERVICES) {
          const shown = a.shown[s.id];
          const ok = allowed(s.id, a.t);
          const okRed = [...ok].some(red);
          if (red(shown)) {
            if (!okRed) falseAlarmMs += dt;
          } else if (shown === "unknown") {
            otherMs += dt;
          } else if (!ok.has(shown)) {
            if (truthAt(incidents, s.id, a.t) === "down") missedMs += dt;
            else otherMs += dt;
          }
        }
      }

      const bannerIds = new Set<string>();
      for (const s of samples) for (const b of s.banners) if (s.t >= ctx.t0) bannerIds.add(b);

      const requests = log.filter((e) => e.route.startsWith("status/") && e.t0 >= ctx.t0 && e.t0 <= ctx.tEnd).length;
      const sessionMs = Math.max(1, ctx.tEnd - ctx.t0);
      const refreshClicks = ctx.scenario.steps.filter((s) => s.k === "click").reduce((a, s) => a + (s.k === "click" ? s.count ?? 1 : 0), 0);
      const ideal = SERVICES.length * (sessionMs / POLL_MS + refreshClicks);
      const ratio = requests / ideal;

      // Detection delay: true transitions → first time the card shows the new state.
      const delays: number[] = [];
      for (const i of incidents) {
        for (const [edge, want] of [
          [i.from, i.status],
          [i.to, truthAt(incidents, i.svc, i.to + 1)],
        ] as [number, Health][]) {
          if (edge < ctx.t0 || edge > ctx.tEnd - GRACE_MS) continue;
          const hit = samples.find((s) => s.t >= edge && (s.shown[i.svc] === want || (want === "down" && red(s.shown[i.svc]))));
          if (hit) delays.push(hit.t - edge);
        }
      }

      const reasons: string[] = [];
      if (falseAlarmMs > 1500) reasons.push(`showed healthy services as failing for ${(falseAlarmMs / 1000).toFixed(1)} s`);
      if (missedMs > 1500) reasons.push(`missed a real outage for ${(missedMs / 1000).toFixed(1)} s`);
      if (otherMs > 3000) reasons.push(`showed a wrong status for ${(otherMs / 1000).toFixed(1)} s`);
      if (bannerIds.size > 0) reasons.push(`${bannerIds.size} error banner${bannerIds.size > 1 ? "s" : ""} shown`);
      if (ratio > 1.5) reasons.push(`${requests} requests, ${ratio.toFixed(1)}× a steady poll`);
      return {
        bug: reasons.length > 0,
        reasons,
        metrics: {
          falseAlarmMs: Math.round(falseAlarmMs),
          missedMs: Math.round(missedMs),
          otherWrongMs: Math.round(otherMs),
          banners: bannerIds.size,
          requests,
          requestRatio: Math.round(ratio * 100) / 100,
          latencyMs: delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length) : NaN,
        },
      };
    },
  };
}
