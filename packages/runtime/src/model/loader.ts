// Model directory loading: the model card (model.json), plan order, WebGPU capability probe, and file downloads
// through Cache Storage with sha256 verification and streamed progress. Pure functions over an injected
// environment (fetch, caches, timers), so the same code runs in the module Worker, inline on the main thread
// (with the runtime's captured native fetch), and in Node tests.
//
// Card format (genclass-runtime-model/1), a superset of the GenClass extension's v0.1 card:
//
//   { "format": "genclass-runtime-model/1",
//     "name": "genclass-runtime-model", "version": "0.1.0", "license": "Apache-2.0",
//     "variants": {
//       "q8":   { "file": "genclass-q8.onnx",   "bytes": 123, "sha256": "<hex>", "provider": "wasm" },
//       "fp16": { "file": "genclass-fp16.onnx", "bytes": 123, "sha256": "<hex>", "provider": "webgpu", "needs": "shader-f16" } },
//     "files": {
//       "tokenizer":   { "file": "tokenizer.json",   "bytes": 123, "sha256": "<hex>" },
//       "calibration": { "file": "calibration.json", "bytes": 123, "sha256": "<hex>" },
//       "meta":        { "file": "meta.json",        "bytes": 123, "sha256": "<hex>" } } }
//
// `files` entries may also be plain file names. The v0.1 extension card (no `files`, a `bundled` list instead,
// `default_base_url`, `release_tag`) is accepted as is: its small files have no hashes and are cache-keyed by the
// card's name@version instead.

import { ModelIntegrityError, ModelLoadError, ModelUnsupportedError, errorMessage } from "./errors.js";
import { sha256Hex } from "./hash.js";

export const CARD_FORMAT = "genclass-runtime-model/1";
export const DEFAULT_CACHE_NAME = "genclass-runtime-v1";

export interface FileSpec {
  file: string;
  bytes?: number;
  sha256?: string;
}

export interface VariantSpec extends FileSpec {
  /** Where this variant is meant to run ("wasm" | "webgpu"); informative. */
  provider?: string;
  /** WebGPU feature the variant requires, e.g. "shader-f16". */
  needs?: string;
}

export type FileRole = "tokenizer" | "calibration" | "meta";

export interface ModelCard {
  format: string;
  name: string;
  version: string;
  license?: string;
  variants: Record<string, VariantSpec>;
  files: Record<FileRole, FileSpec>;
}

const SHA_RE = /^[0-9a-f]{64}$/;

function fileSpec(raw: unknown, where: string, fallbackName?: string): FileSpec {
  const o = typeof raw === "string" ? { file: raw } : (raw as Record<string, unknown> | undefined);
  const file = o && typeof o.file === "string" ? o.file : fallbackName;
  if (!file) throw new ModelUnsupportedError(`model card: ${where} has no file name`);
  // Files are paths relative to the model directory (the CLI writes them to disk): no scheme, no absolute path, no "..".
  if (/^[a-z][a-z0-9+.-]*:/i.test(file) || /^[\\/]/.test(file) || file.split(/[\\/]/).some((p) => p === ".." || p === "")) {
    throw new ModelUnsupportedError(`model card: ${where} has an invalid file name ${JSON.stringify(file)}`);
  }
  const spec: FileSpec = { file };
  if (o && o.bytes !== undefined && o.bytes !== null) {
    const b = Number(o.bytes);
    if (!Number.isInteger(b) || b < 0) throw new ModelUnsupportedError(`model card: ${where}.bytes must be a byte count`);
    spec.bytes = b;
  }
  if (o && o.sha256 !== undefined && o.sha256 !== null && o.sha256 !== "") {
    const h = String(o.sha256).toLowerCase().replace(/^sha256:/, "");
    if (!SHA_RE.test(h)) throw new ModelUnsupportedError(`model card: ${where}.sha256 is not a sha256 hex digest`);
    spec.sha256 = h;
  }
  return spec;
}

/** Parse and normalise a model card (runtime format or the v0.1 extension card). */
export function parseCard(json: unknown): ModelCard {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new ModelUnsupportedError("model card must be a JSON object");
  const j = json as Record<string, unknown>;
  const rawVariants = j.variants as Record<string, unknown> | undefined;
  if (!rawVariants || typeof rawVariants !== "object" || !Object.keys(rawVariants).length) {
    throw new ModelUnsupportedError("model card has no variants");
  }
  const variants: Record<string, VariantSpec> = {};
  for (const [name, raw] of Object.entries(rawVariants)) {
    const v: VariantSpec = fileSpec(raw, `variants.${name}`);
    const r = raw as Record<string, unknown>;
    if (typeof r.provider === "string") v.provider = r.provider;
    if (typeof r.needs === "string" && r.needs) v.needs = r.needs;
    variants[name] = v;
  }
  const defaults: Record<FileRole, string> = { tokenizer: "tokenizer.json", calibration: "calibration.json", meta: "meta.json" };
  const rawFiles = (j.files && typeof j.files === "object" ? j.files : {}) as Record<string, unknown>;
  const files = {} as Record<FileRole, FileSpec>;
  for (const role of Object.keys(defaults) as FileRole[]) files[role] = fileSpec(rawFiles[role], `files.${role}`, defaults[role]);
  return {
    format: typeof j.format === "string" ? j.format : CARD_FORMAT,
    name: typeof j.name === "string" && j.name ? j.name : "genclass-model",
    version: typeof j.version === "string" && j.version ? j.version : "0.0.0",
    ...(typeof j.license === "string" ? { license: j.license } : {}),
    variants,
    files,
  };
}

export const cardId = (card: ModelCard): string => `${card.name}@${card.version}`;

/** baseUrl with a trailing slash, resolved against `base` when relative. */
export function normalizeBaseUrl(url: string, base?: string): string {
  const abs = base ? new URL(url, base).href : url;
  return abs.endsWith("/") ? abs : `${abs}/`;
}

export const fileUrl = (baseUrl: string, spec: FileSpec): string => new URL(spec.file, baseUrl).href;

// ------------------------------------------------------------------------------------------------ plans

export type DeviceKind = "webgpu" | "wasm";
export type DevicePreference = "auto" | "webgpu" | "wasm";

export interface GpuInfo {
  webgpu: boolean;
  /** Adapter supports shader-f16. */
  f16: boolean;
  /** Software (fallback) adapter, e.g. SwiftShader: slower than WASM, skipped by "auto". */
  fallback: boolean;
  /** Human-readable summary for status/devtools, e.g. "nvidia ampere, shader-f16" or "no adapter". */
  summary?: string;
  reason?: string;
}

export interface Plan {
  variant: string;
  device: DeviceKind;
}

/**
 * webgpu+fp16 (needs shader-f16) -> webgpu+q8 -> wasm+q8. "auto" skips WebGPU on a software adapter; "webgpu"
 * still ends with the WASM plan so the model loads somewhere; "wasm" never touches the GPU.
 */
export function planOrder(card: ModelCard, device: DevicePreference, gpu: GpuInfo): Plan[] {
  const has = (v: string) => Object.hasOwn(card.variants, v);
  const plans: Plan[] = [];
  const useGpu = device !== "wasm" && gpu.webgpu && (device === "webgpu" || !gpu.fallback);
  if (useGpu) {
    for (const v of ["fp16", "q8"]) {
      if (!has(v)) continue;
      const needs = card.variants[v].needs;
      if (needs === "shader-f16" && !gpu.f16) continue;
      if (needs && needs !== "shader-f16") continue;
      plans.push({ variant: v, device: "webgpu" });
    }
  }
  if (has("q8")) plans.push({ variant: "q8", device: "wasm" });
  else if (has("fp16")) plans.push({ variant: "fp16", device: "wasm" });
  if (!plans.length) {
    // A card with other variant names: try them in card order on WASM.
    for (const v of Object.keys(card.variants)) plans.push({ variant: v, device: "wasm" });
  }
  return plans;
}

export interface TimerEnv {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

/** A step of the load (adapter, device, session) did not settle in time. */
export class StepTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`);
    this.name = "StepTimeoutError";
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, timers: TimerEnv, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const h = timers.setTimeout(() => reject(new StepTimeoutError(what, ms)), ms);
    p.then(
      (v) => {
        timers.clearTimeout(h);
        resolve(v);
      },
      (e) => {
        timers.clearTimeout(h);
        reject(e);
      },
    );
  });
}

interface GpuDeviceLike {
  destroy?(): void;
}
interface GpuAdapterLike {
  features?: { has(f: string): boolean };
  info?: { isFallbackAdapter?: boolean; vendor?: string; architecture?: string };
  isFallbackAdapter?: boolean;
  requestDevice?(d?: { requiredFeatures?: string[] }): Promise<GpuDeviceLike>;
}

/**
 * Probe WebGPU in the current realm (window or worker). Never throws. Besides the adapter it creates (and destroys)
 * a device with the features the model needs: an adapter that cannot make a device would otherwise reach
 * onnxruntime, which can hang on it instead of failing.
 */
export async function probeWebGPU(timers: TimerEnv, timeoutMs = 5000): Promise<GpuInfo> {
  const none = (reason: string): GpuInfo => ({ webgpu: false, f16: false, fallback: false, reason, summary: reason });
  const gpu = (globalThis as { navigator?: { gpu?: { requestAdapter(o?: unknown): Promise<GpuAdapterLike | null> } } }).navigator?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== "function") return none("WebGPU is not available here (no navigator.gpu)");
  try {
    const adapter = await withTimeout(gpu.requestAdapter(), timeoutMs, timers, "requestAdapter");
    if (!adapter) return none("no WebGPU adapter");
    const f16 = !!adapter.features?.has("shader-f16");
    const fallback = !!(adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter);
    const name = [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(" ") || "adapter";
    if (typeof adapter.requestDevice !== "function") return none(`${name}: cannot create a device`);
    try {
      const dev = await withTimeout(adapter.requestDevice({ requiredFeatures: f16 ? ["shader-f16"] : [] }), timeoutMs, timers, "requestDevice");
      dev?.destroy?.();
    } catch (e) {
      return none(`${name}: no device (${errorMessage(e)})`);
    }
    return { webgpu: true, f16, fallback, summary: `${name}${fallback ? " (software)" : ""}, ${f16 ? "shader-f16" : "no shader-f16"}` };
  } catch (e) {
    return none(`WebGPU probe failed: ${errorMessage(e)}`);
  }
}

// --------------------------------------------------------------------------------------------- downloads

export interface FetchEnv {
  fetch: typeof fetch;
  /** Cache Storage, or null when unavailable (insecure context, privacy mode, Node). */
  caches: CacheStorage | null;
  cacheName: string;
}

export interface FetchOutcome {
  bytes: Uint8Array<ArrayBuffer>;
  fromCache: boolean;
  /** Settles when the copy for Cache Storage was written (or failed silently). */
  stored: Promise<void>;
}

const H_SHA = "x-genclass-sha256";
const H_TAG = "x-genclass-tag";

async function openCache(env: FetchEnv): Promise<Cache | null> {
  if (!env.caches) return null;
  try {
    return await env.caches.open(env.cacheName);
  } catch {
    return null; // SecurityError in some privacy modes
  }
}

/** A cached entry is valid when its recorded sha256 (or, without one, its tag: card id or ORT version) matches. */
function cachedValid(res: Response, spec: FileSpec, tag: string): boolean {
  if (res.type === "opaque" || res.status !== 200) return false;
  if (spec.sha256) return res.headers.get(H_SHA) === spec.sha256;
  return res.headers.get(H_TAG) === tag;
}

/**
 * Fetch one file through Cache Storage: a valid cached copy is used without touching the network; otherwise the
 * file is streamed (progress per chunk), checked against the card's size and sha256, and stored. `tag` versions
 * entries that have no sha256 (the card id for model files, the ORT version for the ORT wasm).
 */
export async function fetchFile(
  env: FetchEnv,
  url: string,
  spec: FileSpec,
  tag: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<FetchOutcome> {
  const cache = await openCache(env);
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        if (cachedValid(hit, spec, tag)) {
          const bytes = new Uint8Array(await hit.arrayBuffer());
          if (spec.bytes === undefined || bytes.byteLength === spec.bytes) {
            onProgress?.(bytes.byteLength, bytes.byteLength);
            return { bytes, fromCache: true, stored: Promise.resolve() };
          }
        }
        await cache.delete(url).catch(() => false);
      }
    } catch {
      // unreadable cache entry: fall back to the network
    }
  }

  let res: Response;
  try {
    res = await env.fetch(url, { cache: "no-store" });
  } catch (e) {
    throw new ModelLoadError(`download failed for ${url}: ${errorMessage(e)}`);
  }
  if (res.type === "opaque") throw new ModelLoadError(`download of ${url} returned an opaque (no-CORS) response`);
  if (!res.ok) throw new ModelLoadError(`download failed: HTTP ${res.status} for ${url}`);
  const total = spec.bytes ?? (Number(res.headers.get("content-length")) || 0);
  const bytes = await readBody(res, total, onProgress);
  if (spec.bytes !== undefined && bytes.byteLength !== spec.bytes) {
    throw new ModelIntegrityError(`size mismatch for ${url}: got ${bytes.byteLength} bytes, the card says ${spec.bytes}`, {
      url,
      bytes: bytes.byteLength,
      expected: spec.bytes,
    });
  }
  let sha: string | null = null;
  if (spec.sha256) {
    sha = await sha256Hex(bytes);
    if (sha !== spec.sha256) {
      throw new ModelIntegrityError(`checksum mismatch for ${url} (got ${sha.slice(0, 12)}…, expected ${spec.sha256.slice(0, 12)}…)`, {
        url,
        sha256: sha,
        expected: spec.sha256,
      });
    }
  }
  const stored = cache ? storeCopy(cache, url, bytes, sha, tag) : Promise.resolve();
  return { bytes, fromCache: false, stored };
}

async function storeCopy(cache: Cache, url: string, bytes: Uint8Array<ArrayBuffer>, sha: string | null, tag: string): Promise<void> {
  try {
    const headers: Record<string, string> = { "content-type": "application/octet-stream", [H_TAG]: tag };
    if (sha) headers[H_SHA] = sha;
    await cache.put(url, new Response(bytes, { headers }));
  } catch {
    // QuotaExceededError and friends: the model still runs, it just is not cached.
  }
}

async function readBody(res: Response, total: number, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(buf.byteLength, buf.byteLength);
    return buf;
  }
  let buf = new Uint8Array(total > 0 ? total : 1 << 20);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.byteLength > buf.byteLength) {
      const grown = new Uint8Array(Math.max(buf.byteLength * 2, got + value.byteLength));
      grown.set(buf.subarray(0, got));
      buf = grown;
    }
    buf.set(value, got);
    got += value.byteLength;
    onProgress?.(got, Math.max(total, got));
  }
  return got === buf.byteLength ? buf : buf.slice(0, got);
}

/**
 * The card is fetched from the network (revalidated) so updates are seen; a copy is kept in Cache Storage so a page
 * that loaded the model once can load it again offline.
 */
export async function fetchCard(env: FetchEnv, baseUrl: string): Promise<{ card: ModelCard; fromCache: boolean }> {
  const url = new URL("model.json", baseUrl).href;
  const cache = await openCache(env);
  let netErr: unknown = null;
  try {
    const res = await env.fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new ModelLoadError(`model card download failed: HTTP ${res.status} for ${url}`);
    const text = await res.text();
    const card = parseCard(JSON.parse(text));
    if (cache) {
      cache.put(url, new Response(text, { headers: { "content-type": "application/json" } })).catch(() => undefined);
    }
    return { card, fromCache: false };
  } catch (e) {
    if (e instanceof ModelUnsupportedError) throw e;
    netErr = e;
  }
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit && hit.ok) return { card: parseCard(await hit.json()), fromCache: true };
    } catch {
      // fall through
    }
  }
  if (netErr instanceof ModelLoadError) throw netErr;
  throw new ModelLoadError(`model card download failed for ${url}: ${errorMessage(netErr)}`);
}
