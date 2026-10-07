import { Rng, clamp } from "./rng.ts";

/** How the mock server misbehaves. Everything here is environment, never app logic. */
export interface RouteChaos {
  /** Median end-to-end latency in ms. */
  latency: number;
  /** Spread in ms; larger means a heavier tail (log-normal). */
  jitter: number;
  /** P(5xx before the server handles the request): no side effects. */
  failRate: number;
  /** P(the server handles the request, then the response is lost as 502/504): side effects stay. */
  commitFailRate: number;
  /** P(the response is held for hangMs after the server handled it), e.g. a slow gateway. */
  timeoutRate: number;
  hangMs: number;
  /** P(latency is multiplied by spikeFactor): slowdowns. */
  spikeRate: number;
  spikeFactor: number;
  /** 0..1 pressure for requests and live events to overtake each other. */
  reorder: number;
  /** Every request fails with 503. */
  outage: boolean;
  /** Every request fails at the network level (fetch rejects). */
  offline: boolean;
}

export interface Chaos extends RouteChaos {
  /** Per-route overrides keyed by route key ("status/payments") or prefix ("status"). */
  routes: Record<string, Partial<RouteChaos>>;
}

export const CALM: Chaos = {
  latency: 45,
  jitter: 15,
  failRate: 0,
  commitFailRate: 0,
  timeoutRate: 0,
  hangMs: 8000,
  spikeRate: 0,
  spikeFactor: 5,
  reorder: 0,
  outage: false,
  offline: false,
  routes: {},
};

export type PresetId = "calm" | "busy" | "flaky" | "storm" | "outage";

export const PRESETS: Record<PresetId, { label: string; hint: string; chaos: Partial<Chaos> }> = {
  calm: { label: "Calm", hint: "fast, reliable network", chaos: {} },
  busy: {
    label: "Busy",
    hint: "slow and jittery, responses overtake each other",
    chaos: { latency: 350, jitter: 320, spikeRate: 0.08, spikeFactor: 5, reorder: 0.35 },
  },
  flaky: {
    label: "Flaky",
    hint: "random 5xx, lost responses, slowdowns",
    chaos: { latency: 160, jitter: 120, failRate: 0.15, commitFailRate: 0.04, spikeRate: 0.06, spikeFactor: 6 },
  },
  storm: {
    label: "Storm",
    hint: "everything at once",
    chaos: {
      latency: 450,
      jitter: 450,
      failRate: 0.2,
      commitFailRate: 0.05,
      timeoutRate: 0.04,
      hangMs: 6000,
      spikeRate: 0.12,
      spikeFactor: 6,
      reorder: 0.6,
    },
  },
  outage: { label: "Outage", hint: "the API answers 503 to everything", chaos: { outage: true } },
};

export function withPreset(id: PresetId): Chaos {
  return mergeChaos({ ...CALM, routes: {} }, PRESETS[id].chaos);
}

/** Which preset (if any) a chaos config equals, ignoring per-route rules. */
export function matchPreset(c: Chaos): PresetId | null {
  for (const id of Object.keys(PRESETS) as PresetId[]) {
    const p = withPreset(id);
    const keys = Object.keys(CALM).filter((k) => k !== "routes") as (keyof RouteChaos)[];
    if (keys.every((k) => p[k] === c[k])) return id;
  }
  return null;
}

export function mergeChaos(base: Chaos, patch: Partial<Chaos> | undefined): Chaos {
  if (!patch) return base;
  const routes = { ...base.routes };
  if (patch.routes) {
    for (const [k, v] of Object.entries(patch.routes)) {
      if (v === null) delete routes[k];
      else routes[k] = { ...(routes[k] ?? {}), ...v };
    }
  }
  return { ...base, ...patch, routes };
}

/** Effective chaos for a route key: global, then prefix overrides ("status"), then the exact key. */
export function resolveChaos(c: Chaos, key: string): RouteChaos {
  let out: RouteChaos = { ...c };
  const parts = key.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const k = parts.slice(0, i).join("/");
    const o = c.routes[k];
    if (o) out = { ...out, ...o };
  }
  return out;
}

export interface Timing {
  /** Delay before the server handles the request. */
  up: number;
  /** Delay between handling and the response reaching the page. */
  down: number;
  spike: boolean;
}

export function sampleTiming(rng: Rng, c: RouteChaos): Timing {
  const median = Math.max(1, c.latency);
  const sigma = Math.log(1 + Math.max(0, c.jitter) / median);
  let total = clamp(rng.lognormal(median, sigma), 2, 30000);
  const spike = c.spikeRate > 0 && rng.chance(c.spikeRate);
  if (spike) total *= Math.max(1, c.spikeFactor);
  const share = rng.range(0.25, 0.5);
  let up = total * share;
  let down = total - up;
  if (c.reorder > 0) {
    const scale = c.reorder * Math.max(median, 40);
    up += rng.exp(scale);
    down += rng.exp(scale * 0.5);
  }
  return { up, down, spike };
}

/** Delivery delay of one live event on a stream (events may overtake each other under reorder pressure). */
export function sampleEventDelay(rng: Rng, c: RouteChaos): number {
  const median = Math.max(4, c.latency * 0.4);
  const sigma = Math.log(1 + Math.max(0, c.jitter) / Math.max(1, c.latency));
  let d = clamp(rng.lognormal(median, sigma), 1, 20000);
  if (c.reorder > 0) d += rng.exp(c.reorder * Math.max(c.latency, 40));
  return d;
}

/** One-line human summary for logs and trial tables. */
export function describeChaos(c: Chaos): string {
  if (c.offline) return "offline";
  if (c.outage) return "outage";
  const bits = [`${Math.round(c.latency)}±${Math.round(c.jitter)} ms`];
  if (c.failRate) bits.push(`${Math.round(c.failRate * 100)}% 5xx`);
  if (c.commitFailRate) bits.push(`${Math.round(c.commitFailRate * 100)}% lost`);
  if (c.timeoutRate) bits.push(`${Math.round(c.timeoutRate * 100)}% hang`);
  if (c.spikeRate) bits.push(`${Math.round(c.spikeRate * 100)}% ×${c.spikeFactor}`);
  if (c.reorder) bits.push(`reorder ${c.reorder.toFixed(2)}`);
  const routes = Object.keys(c.routes).length;
  if (routes) bits.push(`${routes} route rule${routes > 1 ? "s" : ""}`);
  return bits.join(" · ");
}
