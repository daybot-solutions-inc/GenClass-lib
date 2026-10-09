// Telemetry configuration: defaults, opt-outs and sampling (packages/runtime/TELEMETRY.md).
//
// On by default only through GenClass.init() in a browser; createRuntime() and Node/SSR need an explicit option.
// Off, in this order: `telemetry: false`; `?genclass=no-telemetry` or `?genclass=off`; localStorage
// "genclass.telemetry" = "off"; Global Privacy Control (navigator.globalPrivacyControl === true, an opt-out of
// sale/sharing under CCPA/CPRA that we honour for all users); not sampled; no crypto.getRandomValues; no transport.

import type { TelemetryOptions, TelemetryTransport } from "../types.js";
import { nativeTransport, nativeTransportAvailable } from "./transport.js";

/** The GenClass collector (Cloudflare Worker `genclass-telemetry`, telemetry-worker/). */
export const DEFAULT_TELEMETRY_ENDPOINT = "https://genclass-telemetry.mehar-144.workers.dev/v1/events";
export const TELEMETRY_SCHEMA = "genclass-telemetry/1";
export const TELEMETRY_NOTICE =
  "[GenClass] Sends anonymous diagnostics (decisions, redacted situation text) to improve the model. Opt out: GenClass.init({ telemetry: false }) or ?genclass=no-telemetry.";

export interface TelemetryConfig {
  endpoint: string;
  sample: number;
  flushMs: number;
  maxBatch: number;
  situation: boolean;
  transport: TelemetryTransport;
  sessionId: string;
}

export type TelemetryResolution = { on: true; config: TelemetryConfig } | { on: false; reason: string };

type G = Record<string, unknown>;

function urlOptOut(g: G): boolean {
  try {
    const search = (g.location as { search?: unknown } | undefined)?.search;
    if (typeof search !== "string" || !search) return false;
    return new URLSearchParams(search).getAll("genclass").some((v) => {
      const s = v.trim().toLowerCase();
      return s === "no-telemetry" || s === "off";
    });
  } catch {
    return false;
  }
}

function storageOptOut(g: G): boolean {
  try {
    const ls = g.localStorage as Storage | undefined;
    const v = ls?.getItem("genclass.telemetry");
    return typeof v === "string" && v.trim().toLowerCase() === "off";
  } catch {
    return false;
  }
}

function gpc(g: G): boolean {
  try {
    return (g.navigator as { globalPrivacyControl?: unknown } | undefined)?.globalPrivacyControl === true;
  } catch {
    return false;
  }
}

/** n random bytes from crypto.getRandomValues, or null (telemetry never falls back to Math.random). */
export function randomBytes(g: G, n: number): Uint8Array | null {
  try {
    const c = g.crypto as { getRandomValues?: (a: Uint8Array) => Uint8Array } | undefined;
    if (typeof c?.getRandomValues !== "function") return null;
    return c.getRandomValues(new Uint8Array(n));
  } catch {
    return null;
  }
}

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/**
 * Decide whether this page sends telemetry. `defaultOn`: GenClass.init in a browser. `g`: where the page's
 * location / localStorage / navigator / crypto live (the runtime's global).
 */
export function resolveTelemetry(opt: boolean | TelemetryOptions | undefined, g: G, defaultOn: boolean): TelemetryResolution {
  if (opt === false) return { on: false, reason: "option" };
  if (opt === undefined || opt === null) {
    if (!defaultOn) return { on: false, reason: "headless" };
  } else if (opt !== true && typeof opt !== "object") return { on: false, reason: "option" };
  if (urlOptOut(g)) return { on: false, reason: "url" };
  if (storageOptOut(g)) return { on: false, reason: "localStorage" };
  if (gpc(g)) return { on: false, reason: "gpc" };
  const o: TelemetryOptions = typeof opt === "object" && opt ? opt : {};
  const sample = num(o.sample, 0, 1, 1);
  // 16 random bytes: 12 for the session id, 4 for the sample draw
  const rnd = randomBytes(g, 16);
  if (!rnd) return { on: false, reason: "no-crypto" };
  if (sample < 1) {
    const draw = ((rnd[12] << 24) | (rnd[13] << 16) | (rnd[14] << 8) | rnd[15]) >>> 0;
    if (draw / 0x100000000 >= sample) return { on: false, reason: "sampled-out" };
  }
  const transport = o.transport && typeof o.transport.send === "function" ? o.transport : nativeTransportAvailable() ? nativeTransport : null;
  if (!transport) return { on: false, reason: "no-transport" };
  let sessionId = "";
  for (let i = 0; i < 12; i++) sessionId += rnd[i].toString(16).padStart(2, "0");
  const endpoint = typeof o.endpoint === "string" && /^https?:\/\//i.test(o.endpoint) ? o.endpoint : DEFAULT_TELEMETRY_ENDPOINT;
  return {
    on: true,
    config: {
      endpoint,
      sample,
      flushMs: num(o.flushMs, 1000, 600_000, 10_000),
      maxBatch: Math.floor(num(o.maxBatch, 1, 500, 100)),
      situation: o.include?.situation !== false,
      transport,
      sessionId,
    },
  };
}
