// Post-hoc calibration (port of jev_local/engine/encoder/calibrate.py lookup/application) and answer math (port of
// jev_local/confidence.py). calibration.json keys (v2 keys are additive; a v1 file still works):
//
//   {"noul": tau, "choice": tau, "score": tau,              v1: one temperature per head kind
//    "by_header": {sha1(header)[:12]: tau},                 v1: per question header
//    "by_bucket": {"choice:2": tau, "choice:3-5": tau, ...}, v2: (kind, K-bucket)
//    "tau_k": {"choice": [a, b], "score": [a, b]},          v2: tau(K) = a + b ln K, clamped to bucket_clamp
//    "noul_platt": {"a": a, "b": b},                         v2: p = sigmoid(a z + b)
//    "bucket_clamp": [0.5, 5.0]}
//
// Lookup: by_header -> (noul: noul_platt -> per kind) | (choice/score: by_bucket -> tau_k -> per kind).

import type { Answer } from "../types.js";
import { ModelUnsupportedError } from "./errors.js";
import { sha1Hex } from "./hash.js";
import { clip01, pyRound } from "./pyutil.js";
import type { BlockKind } from "./serialize.js";
import { criteriaEntries } from "./serialize.js";

export interface Calibration {
  noul: number;
  choice: number;
  score: number;
  by_header: Record<string, number>;
  by_bucket?: Record<string, number>;
  tau_k?: Partial<Record<"choice" | "score", [number, number]>>;
  noul_platt?: { a: number; b: number };
  bucket_clamp?: [number, number];
  version?: number;
}

export const K_BUCKETS: ReadonlyArray<readonly [number, number]> = [
  [2, 2],
  [3, 5],
  [6, 10],
  [11, 30],
  [31, 100],
  [101, 255],
];
export const BUCKET_CLAMP: [number, number] = [0.5, 5.0];

/** load_calibration: defaults for missing v1 keys; positive temperatures required. */
export function parseCalibration(json: unknown): Calibration {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new ModelUnsupportedError("calibration.json must be a JSON object");
  const c = { noul: 1.0, choice: 1.0, score: 1.0, by_header: {}, ...(json as Record<string, unknown>) } as Calibration;
  for (const k of ["noul", "choice", "score"] as const) {
    const v = c[k];
    if (typeof v !== "number" || !(v > 0)) throw new ModelUnsupportedError(`calibration[${k}] must be a positive temperature, not ${String(v)}`);
  }
  if (!c.by_header || typeof c.by_header !== "object") throw new ModelUnsupportedError("calibration.by_header must be an object");
  return c;
}

/** sha1(header)[:12], the key of calibration.by_header (cached). */
const headerKeys = new Map<string, string>();
export function headerKey(header: string): string {
  let k = headerKeys.get(header);
  if (k === undefined) {
    k = sha1Hex(header).slice(0, 12);
    if (headerKeys.size > 4096) headerKeys.clear();
    headerKeys.set(header, k);
  }
  return k;
}

export function kBucket(k: number): string {
  for (const [lo, hi] of K_BUCKETS) if (k <= hi) return lo === hi ? String(lo) : `${lo}-${hi}`;
  const [lo, hi] = K_BUCKETS[K_BUCKETS.length - 1];
  return `${lo}-${hi}`;
}

export function tauFor(calib: Calibration, kind: BlockKind, hk: string, k: number | null = null): number {
  const bh = calib.by_header ?? {};
  if (Object.hasOwn(bh, hk)) return Number(bh[hk]);
  if (k !== null && kind !== "noul") {
    const [lo, hi] = calib.bucket_clamp ?? BUCKET_CLAMP;
    const bb = calib.by_bucket?.[`${kind}:${kBucket(k)}`];
    if (bb !== undefined && bb !== null) return Number(bb);
    const tk = calib.tau_k?.[kind];
    if (tk) return Math.min(Math.max(tk[0] + tk[1] * Math.log(Math.max(k, 2)), lo), hi);
  }
  return Number(calib[kind] ?? 1.0);
}

/** (a, b) with p = sigmoid(a z + b): per-header temperature, else Platt, else per-kind temperature. */
export function noulAffine(calib: Calibration, hk: string): [number, number] {
  const bh = calib.by_header ?? {};
  if (Object.hasOwn(bh, hk)) return [1 / Number(bh[hk]), 0];
  if (calib.noul_platt) return [Number(calib.noul_platt.a), Number(calib.noul_platt.b)];
  return [1 / Number(calib.noul ?? 1.0), 0];
}

/** Raw (tau = 1) logits of ONE question -> calibrated probabilities (float64). */
export function calibrateLogits(kind: BlockKind, hk: string, logits: readonly number[], calib: Calibration): number[] {
  if (kind === "noul") {
    const [a, b] = noulAffine(calib, hk);
    return [1 / (1 + Math.exp(-(a * logits[0] + b)))];
  }
  const tau = tauFor(calib, kind, hk, logits.length);
  const z = logits.map((x) => x / tau);
  const m = Math.max(...z);
  const e = z.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

// ------------------------------------------------------------------------------------------- answers

/** Clip to [0, 1], drop NaN/inf, renormalise; an all-zero input becomes uniform. */
export function normalizeProbs(p: readonly number[]): number[] {
  const clean = p.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const t = clean.reduce((a, b) => a + b, 0);
  if (t <= 0) return clean.map(() => 1 / clean.length);
  return clean.map((x) => x / t);
}

/** (K * pmax - 1) / (K - 1). */
export function choiceConfidence(p: readonly number[]): number {
  return p.length <= 1 ? 1 : clip01((p.length * Math.max(...p) - 1) / (p.length - 1));
}

function madUniform(k: number): number {
  const c = (k - 1) / 2;
  let s = 0;
  for (let i = 0; i < k; i++) s += Math.abs(i - c);
  return s / k;
}

/** max(0, 1 - sum p_i |i - c| / MAD_uniform(K)), c = mode (first index on ties). */
export function scoreConfidence(p: readonly number[]): number {
  const k = p.length;
  if (k <= 1) return 1;
  let c = 0;
  for (let i = 1; i < k; i++) if (p[i] > p[c]) c = i;
  let spread = 0;
  p.forEach((pi, i) => {
    spread += pi * Math.abs(i - c);
  });
  return Math.max(0, 1 - spread / madUniform(k));
}

/** "exact": unrounded numbers (default). "round": every number rounded to 2 dp like the Jev server. */
export type Precision = "exact" | "round";

/**
 * Calibrated distribution -> Jev answer. `choice` is the argmax of the unrounded probabilities (ties: first label);
 * choice/score probabilities are plain objects in criteria order. `labels` are the choice labels in request order
 * (QBlock.labels); they are read from `criteria` when omitted.
 */
export function buildAnswer(
  q: { type: string; criteria?: unknown },
  probs: readonly number[],
  precision: Precision = "exact",
  labels?: readonly string[],
): Answer {
  const r = (x: number) => (precision === "round" ? pyRound(x, 2) : x + 0);
  if (q.type === "noul") {
    const p = clip01(Number.isFinite(probs[0]) ? probs[0] : 0.5);
    return { type: "noul", noul: r(p) };
  }
  if (q.type === "choice") {
    labels ??= criteriaEntries(q.criteria).map(([l]) => l);
    const p = normalizeProbs(probs);
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
    const probabilities: Record<string, number> = {};
    labels.forEach((l, i) => {
      probabilities[l] = r(clip01(p[i]));
    });
    return { type: "choice", choice: labels[best], confidence: r(choiceConfidence(p)), probabilities };
  }
  if (q.type === "score") {
    const p = normalizeProbs(probs);
    const probabilities: Record<string, number> = {};
    p.forEach((x, i) => {
      probabilities[String(i)] = r(clip01(x));
    });
    return { type: "score", score: r(p.reduce((a, x, i) => a + i * x, 0)), confidence: r(scoreConfidence(p)), probabilities };
  }
  throw new ModelUnsupportedError(`unsupported question type ${q.type}`);
}
