// Helpers to build realistic scripted sessions: human typing rhythm (log-normal inter-key times, pauses,
// typos fixed with Backspace), and randomized chaos within per-demo ranges.
import { Rng, clamp } from "./rng.ts";
import type { Chaos } from "./chaos.ts";
import type { Step } from "./types.ts";

const NEIGHBOURS: Record<string, string> = {
  a: "qsz",
  b: "vgn",
  c: "xdv",
  d: "sfe",
  e: "wrd",
  f: "dgr",
  g: "fht",
  h: "gjy",
  i: "uok",
  j: "hku",
  k: "jli",
  l: "kop",
  m: "nj",
  n: "bmh",
  o: "ipl",
  p: "ol",
  q: "wa",
  r: "etf",
  s: "adw",
  t: "ryg",
  u: "yij",
  v: "cbf",
  w: "qes",
  x: "zcs",
  y: "tuh",
  z: "xa",
};

export interface TypingStyle {
  /** Median ms between keys. */
  median: number;
  /** Log-space spread. */
  sigma: number;
  /** P(a typo on a letter), fixed with Backspace. */
  typoRate: number;
  /** P(a thinking pause after a word/char). */
  pauseRate: number;
  pauseMs: [number, number];
}

export const CALM_TYPIST: TypingStyle = { median: 210, sigma: 0.28, typoRate: 0.03, pauseRate: 0.04, pauseMs: [500, 1100] };
export const FAST_TYPIST: TypingStyle = { median: 120, sigma: 0.4, typoRate: 0.06, pauseRate: 0.05, pauseMs: [400, 1200] };

export function keyDelay(rng: Rng, style: TypingStyle): number {
  return clamp(rng.lognormal(style.median, style.sigma), 35, 900);
}

/**
 * Steps that type `text` into `sel` the way a person does. Returns the steps; the final text in the field is
 * `text` (typos are corrected).
 */
export function typeSteps(rng: Rng, sel: string, text: string, style: TypingStyle): Step[] {
  const steps: Step[] = [];
  let chunk = "";
  let delays: number[] = [];
  const flush = () => {
    if (chunk) steps.push({ k: "type", sel, text: chunk, delays });
    chunk = "";
    delays = [];
  };
  for (const ch of text) {
    let d = keyDelay(rng, style);
    if (rng.chance(style.pauseRate) || (ch === " " && rng.chance(style.pauseRate * 3))) d += rng.range(style.pauseMs[0], style.pauseMs[1]);
    const lower = ch.toLowerCase();
    if (NEIGHBOURS[lower] && rng.chance(style.typoRate)) {
      const wrong = rng.pick(NEIGHBOURS[lower].split(""));
      chunk += ch === lower ? wrong : wrong.toUpperCase();
      delays.push(d);
      flush();
      steps.push({ k: "key", sel, key: "Backspace", delays: [rng.range(160, 420)] });
      d = keyDelay(rng, style);
    }
    chunk += ch;
    delays.push(d);
  }
  flush();
  return steps;
}

/** Uniform sample of a chaos parameter range. */
export type ChaosRanges = Partial<Record<keyof Omit<Chaos, "routes" | "outage" | "offline">, [number, number]>>;

export function sampleChaos(rng: Rng, ranges: ChaosRanges, extra: Partial<Chaos> = {}): Partial<Chaos> {
  const out: Partial<Chaos> = { ...extra };
  for (const [k, [lo, hi]] of Object.entries(ranges) as [keyof ChaosRanges, [number, number]][]) {
    (out as Record<string, number>)[k] = Math.round(rng.range(lo, hi) * 1000) / 1000;
  }
  return out;
}

/** Clean runs: a fast, reliable network with no failures (same as the Calm preset). */
export const CLEAN_CHAOS: Partial<Chaos> = { latency: 45, jitter: 15, failRate: 0, commitFailRate: 0, timeoutRate: 0, spikeRate: 0, reorder: 0 };
