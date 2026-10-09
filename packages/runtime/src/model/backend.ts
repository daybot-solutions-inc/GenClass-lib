// The model backend: loads a model directory and answers evaluate requests. One instance lives in the module
// Worker (worker.ts) or, as the fallback, inline on the main thread (host.ts). It reports a rich status.
//
// Load: model card -> tokenizer/calibration/meta (cached) -> ORT wasm binary (cached, same Cache Storage) ->
// for each plan (webgpu+fp16 -> webgpu+q8 -> wasm+q8): variant bytes (cached, sha256-checked, progress) ->
// InferenceSession -> Engine -> warm-up pass. The first plan that works wins; failures are recorded in
// status.attempts.

import type { Clock, ModelGate, ModelStatus } from "../types.js";
import { parseCalibration } from "./calibrate.js";
import { Engine, type EngineResult, type ModelMeta, type OrtLike, type OrtSessionLike } from "./engine.js";
import { ModelLoadError, ModelNotReadyError, errorMessage, type LoadAttempt } from "./errors.js";
import {
  DEFAULT_CACHE_NAME,
  StepTimeoutError,
  withTimeout,
  cardId,
  fetchCard,
  fetchFile,
  fileUrl,
  normalizeBaseUrl,
  planOrder,
  probeWebGPU,
  type DevicePreference,
  type FetchEnv,
  type FetchOutcome,
  type GpuInfo,
  type ModelCard,
  type Plan,
} from "./loader.js";
import { Tokenizer, type TokenizerJson } from "./tokenizer.js";

/** ModelStatus plus what devtools and the console show about the model. */
export interface ModelHostStatus extends ModelStatus {
  /** What the load is doing now. */
  phase?: "card" | "download" | "runtime" | "session" | "warmup";
  /** Model card version (status.model is the card name). */
  version?: string;
  /** Size of the loaded variant file. */
  bytes?: number;
  /** The variant came from Cache Storage (no download). */
  fromCache?: boolean;
  /** WASM threads (1 unless the page is crossOriginIsolated). */
  threads?: number;
  /** Duration of the warm-up forward pass. */
  warmupMs?: number;
  /** Inference runs in a Worker (false: inline on the main thread). */
  worker?: boolean;
  /** Why the Worker was not used (inline fallback). */
  workerError?: string;
  /** Plans that failed before the one that loaded (or all of them, on error). */
  attempts?: LoadAttempt[];
  /** onnxruntime-web version. */
  ort?: string;
  /** What the WebGPU probe found (absent with device "wasm"). */
  gpu?: string;
  /** Which onnxruntime-web bundle was loaded: "wasm" (onnxruntime-web/wasm, CPU only) or "webgpu" (onnxruntime-web/webgpu). */
  ortBuild?: OrtBuild;
  /**
   * Inference time (pack + forward + answers, in the worker; no queue wait) over the last 20 evaluations. Before the
   * first evaluation it is the warm-up estimate (n = 0). `msPerToken` is the median of ms / sequence tokens.
   */
  latency?: LatencyStats;
}

export interface LatencyStats {
  p50: number;
  p90: number;
  n: number;
  tokensP50: number;
  msPerToken: number;
  /** "warmup" until real evaluations arrive. */
  source: "warmup" | "evaluations";
}

/** onnxruntime-web bundle: "webgpu" = onnxruntime-web/webgpu (WebGPU + WASM providers), "wasm" = onnxruntime-web/wasm. */
export type OrtBuild = "webgpu" | "wasm";

export interface BackendLoadOptions {
  /** Absolute model directory URL (holds model.json). */
  baseUrl: string;
  device?: DevicePreference;
  /** Prefix of the onnxruntime-web .wasm files (default: jsDelivr for the installed ORT version). */
  ortWasmPaths?: string;
  cacheName?: string;
  /** Skip the warm-up pass (tests). */
  warmup?: boolean;
  /** Cap on WASM threads; the effective count is min(cap, hardwareConcurrency) and 1 without crossOriginIsolated. */
  maxThreads?: number;
  /** Give up on a plan whose InferenceSession does not come up in time (default: webgpu 60 s, wasm 180 s). */
  sessionTimeoutMs?: { webgpu?: number; wasm?: number };
}

export interface BackendEnv {
  /** Loads onnxruntime-web: the WebGPU bundle only when a WebGPU plan will be tried, else the smaller WASM one. */
  ort: (build: OrtBuild) => Promise<OrtLike>;
  /** Native fetch (never the runtime's instrumented one). */
  fetch: typeof fetch;
  caches: CacheStorage | null;
  clock: Clock;
  /** Status sink (posted to the host by the worker). */
  emit: (s: ModelHostStatus) => void;
  probeGpu?: () => Promise<GpuInfo>;
  /** true when this backend runs inside a Worker. */
  inWorker: boolean;
}

/**
 * The .wasm each onnxruntime-web 1.30 bundle loads: onnxruntime-web/webgpu runs its WebGPU and CPU providers on the
 * asyncify build (27 MB, 5.5 MB brotli); onnxruntime-web/wasm on the plain one (14 MB, 3.1 MB brotli).
 */
export const ORT_WASM_FILES: Record<OrtBuild, string> = {
  webgpu: "ort-wasm-simd-threaded.asyncify.wasm",
  wasm: "ort-wasm-simd-threaded.wasm",
};
/** The JS glue ORT's WASM threads (pthread workers) load by URL, next to each build's .wasm. */
export const ORT_GLUE_FILES: Record<OrtBuild, string> = {
  webgpu: "ort-wasm-simd-threaded.asyncify.mjs",
  wasm: "ort-wasm-simd-threaded.mjs",
};
export const ortCdnBase = (version: string): string => `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;

/**
 * Session options for every InferenceSession. ORT's own log is cut to errors: at its default (warning) the WebGPU
 * provider prints two benign lines through console.error on every load ("Some nodes were not assigned to the
 * preferred execution providers ...", which is ORT placing shape ops on the CPU on purpose), which error monitors
 * then report. Real failures still reject session creation or inference (and are reported by the runtime).
 */
export const ORT_SESSION_LOG = { logSeverityLevel: 3, logVerbosityLevel: 0 } as const;

const PROGRESS_STEP_MS = 100;
/** Used for the CDN path only if onnxruntime-web does not report its version. */
const ORT_FALLBACK_VERSION = "1.30.0";

export class ModelBackend {
  private engine: Engine | null = null;
  private loading: Promise<void> | null = null;
  private disposed = false;
  /** Why the ORT wasm prefetch failed in the current load, if it did. */
  private wasmError: string | null = null;
  private st: ModelHostStatus = { state: "off" };
  private lastProgressAt = -Infinity;

  constructor(private readonly env: BackendEnv) {}

  get status(): ModelHostStatus {
    return this.st;
  }

  private set(s: ModelHostStatus): void {
    this.st = s;
    this.env.emit(s);
  }

  /** Starts (or joins) the load. Resolves when ready; rejects with ModelLoadError when every plan failed. */
  load(opts: BackendLoadOptions): Promise<void> {
    if (this.engine) return Promise.resolve();
    if (!this.loading) {
      this.loading = this.doLoad(opts).catch((e) => {
        this.loading = null;
        throw e;
      });
    }
    return this.loading;
  }

  private async doLoad(opts: BackendLoadOptions): Promise<void> {
    const { clock } = this.env;
    const t0 = clock.now();
    const baseUrl = normalizeBaseUrl(opts.baseUrl, globalLocation());
    const fenv: FetchEnv = { fetch: this.env.fetch, caches: this.env.caches, cacheName: opts.cacheName || DEFAULT_CACHE_NAME };
    const base: ModelHostStatus = { state: "loading", worker: this.env.inWorker };
    this.set({ ...base, phase: "card" });
    const attempts: LoadAttempt[] = [];
    let ort: OrtLike | null = null;
    try {
      const gpuP: Promise<GpuInfo> =
        opts.device === "wasm" ? Promise.resolve({ webgpu: false, f16: false, fallback: false }) : (this.env.probeGpu ?? (() => probeWebGPU(clock)))();
      const { card } = await fetchCard(fenv, baseUrl);
      const id = cardId(card);
      Object.assign(base, { model: card.name, version: card.version });
      const gpu = await gpuP;
      if (opts.device !== "wasm" && gpu.summary) base.gpu = gpu.summary;
      const plans = planOrder(card, opts.device ?? "auto", gpu);
      // The WebGPU bundle (and its larger wasm) only when a WebGPU plan will be tried.
      const build: OrtBuild = plans.some((p) => p.device === "webgpu") ? "webgpu" : "wasm";
      base.ortBuild = build;
      const ortP = this.env.ort(build);
      ortP.catch(() => undefined);

      // Progress covers the model files, seeded with the card's sizes so it only moves forward; the ORT wasm
      // downloads alongside (its compressed size is unknown up front).
      const progress = new Map<string, { loaded: number; total: number }>();
      const report = (key: string, loaded: number, total: number) => {
        progress.set(key, { loaded, total: Math.max(total, progress.get(key)?.total ?? 0) });
        let l = 0;
        let t = 0;
        for (const p of progress.values()) {
          l += p.loaded;
          t += Math.max(p.total, p.loaded);
        }
        const now = clock.now();
        if ((l >= t && t > 0) || now - this.lastProgressAt >= PROGRESS_STEP_MS) {
          this.lastProgressAt = now;
          this.set({ ...this.st, progress: { loaded: l, total: t } });
        }
      };
      for (const role of ["tokenizer", "calibration", "meta"] as const) progress.set(role, { loaded: 0, total: card.files[role].bytes ?? 0 });
      if (plans[0]) progress.set(`variant:${plans[0].variant}`, { loaded: 0, total: card.variants[plans[0].variant].bytes ?? 0 });
      this.set({ ...base, phase: "download", ...(plans[0] ? { device: plans[0].device, variant: plans[0].variant } : {}) });

      const small = (role: "tokenizer" | "calibration" | "meta") =>
        fetchFile(fenv, fileUrl(baseUrl, card.files[role]), card.files[role], id, (l, t) => report(role, l, t));
      const variants = new Map<string, Promise<FetchOutcome>>();
      const variant = (name: string) => {
        let p = variants.get(name);
        if (!p) {
          const spec = card.variants[name];
          p = fetchFile(fenv, fileUrl(baseUrl, spec), spec, id, (l, t) => report(`variant:${name}`, l, t));
          p.catch(() => undefined);
          variants.set(name, p);
        }
        return p;
      };
      if (plans[0]) variant(plans[0].variant); // downloads in parallel with the small files
      const [tokF, calF, metaF] = await Promise.all([small("tokenizer"), small("calibration"), small("meta")]);
      const stores: Promise<void>[] = [tokF.stored, calF.stored, metaF.stored];
      const dec = new TextDecoder();
      const tokenizer = new Tokenizer(JSON.parse(dec.decode(tokF.bytes)) as TokenizerJson);
      const calibration = parseCalibration(JSON.parse(dec.decode(calF.bytes)));
      const meta = JSON.parse(dec.decode(metaF.bytes)) as ModelMeta;

      ort = await ortP;
      const ortVersion = ort.env.versions?.web ?? "";
      base.ort = ortVersion;
      base.threads = this.configureOrt(ort, opts);
      const wasmBase = normalizeBaseUrl(opts.ortWasmPaths || ortCdnBase(ortVersion || ORT_FALLBACK_VERSION), globalLocation());
      // WASM threads: ORT starts its pthread workers from its JS glue, by URL; take it from the wasm's directory (an
      // app's bundler may have rewritten ORT's own import.meta.url, and a self-hosted ortWasmPaths must win).
      if (base.threads > 1) (ort.env.wasm as { wasmPaths?: unknown }).wasmPaths = { mjs: new URL(ORT_GLUE_FILES[build], wasmBase).href };
      this.wasmError = null;
      const wasmP = this.prefetchWasm(ort, fenv, wasmBase, ortVersion, build);

      for (const plan of plans) {
        if (this.disposed) throw new ModelLoadError("disposed while loading");
        const at = { ...base, device: plan.device, variant: plan.variant };
        try {
          this.set({ ...at, phase: "download", ...(this.st.progress ? { progress: this.st.progress } : {}) });
          const vf = await variant(plan.variant);
          stores.push(vf.stored);
          this.set({ ...at, phase: "runtime" });
          await wasmP;
          this.set({ ...at, phase: "session" });
          const engine = await this.createEngine(ort, plan, vf.bytes, tokenizer, calibration, meta, card, opts);
          let warmupMs: number | undefined;
          let latency: LatencyStats | undefined;
          if (opts.warmup !== false) {
            this.set({ ...at, phase: "warmup" });
            try {
              const tw = clock.now();
              let r = await engine.evaluate(WARMUP_STATE, WARMUP_QUESTIONS);
              warmupMs = Math.round(clock.now() - tw);
              // WebGPU compiles its pipelines on the first pass: time a second one for the latency estimate.
              if (plan.device === "webgpu") r = await engine.evaluate(WARMUP_STATE, WARMUP_QUESTIONS);
              const ms = Math.round(r.timings.total);
              latency = { p50: ms, p90: ms, n: 0, tokensP50: r.usage.input_tokens, msPerToken: round3(ms / r.usage.input_tokens), source: "warmup" };
            } catch (e) {
              await engine.release().catch(() => undefined);
              throw e;
            }
          }
          if (this.disposed) {
            await engine.release().catch(() => undefined);
            throw new ModelLoadError("disposed while loading");
          }
          await Promise.all(stores);
          this.engine = engine;
          this.set({
            ...at,
            state: "ready",
            loadMs: Math.round(clock.now() - t0),
            bytes: vf.bytes.byteLength,
            fromCache: vf.fromCache,
            ...(warmupMs !== undefined ? { warmupMs } : {}),
            ...(latency ? { latency } : {}),
            ...(attempts.length ? { attempts } : {}),
            // the model's own gate thresholds (meta.json `gate`), validated by the runtime (decide/policy.ts)
            ...(meta.gate && typeof meta.gate === "object" ? { gate: meta.gate as ModelGate } : {}),
          });
          return;
        } catch (e) {
          if (this.disposed) throw e;
          attempts.push({ variant: plan.variant, device: plan.device, error: errorMessage(e) });
          if (plan.device === "webgpu" && e instanceof StepTimeoutError && this.env.inWorker) {
            // onnxruntime may be stuck inside WebGPU now: stop here; the host retries on WASM in a fresh worker.
            throw new ModelLoadError(`WebGPU did not come up (${errorMessage(e)}); not trying further plans in this worker`, attempts);
          }
        }
      }
      throw new ModelLoadError(
        `no plan could run the model: ${attempts.map((a) => `${a.variant}/${a.device}: ${a.error}`).join("; ") || "the card has no usable variant"}`,
        attempts,
      );
    } catch (e) {
      const err = e instanceof ModelLoadError ? e : new ModelLoadError(errorMessage(e), attempts);
      this.set({
        state: "error",
        error: err.message,
        worker: this.env.inWorker,
        ...(base.model ? { model: base.model, version: base.version } : {}),
        ...(base.gpu ? { gpu: base.gpu } : {}),
        ...(attempts.length ? { attempts } : {}),
      });
      throw err;
    } finally {
      // ORT instantiated its wasm already (or never will in this realm): drop our 25 MB reference.
      if (ort) delete (ort.env.wasm as { wasmBinary?: unknown }).wasmBinary;
    }
  }

  private configureOrt(ort: OrtLike, opts: BackendLoadOptions): number {
    const g = globalThis as { crossOriginIsolated?: boolean; navigator?: { hardwareConcurrency?: number } };
    const cores = g.navigator?.hardwareConcurrency || 1;
    // WASM threads need crossOriginIsolated, and only run in the worker: inline on the main thread, ORT would start
    // its pthread workers from the app's own bundle URL.
    const threads = g.crossOriginIsolated && this.env.inWorker ? Math.max(1, Math.min(opts.maxThreads ?? 4, cores)) : 1;
    ort.env.wasm.numThreads = threads;
    ort.env.wasm.proxy = false;
    ort.env.logLevel = "error";
    return threads;
  }

  /**
   * Fetches the ORT wasm through Cache Storage with the native fetch and hands it to ORT as `wasmBinary`, so ORT
   * itself never fetches (offline second loads; nothing goes through the runtime's instrumented fetch). If that
   * fails, ORT loads it from the same prefix on its own.
   */
  private async prefetchWasm(ort: OrtLike, fenv: FetchEnv, wasmBase: string, version: string, build: OrtBuild): Promise<void> {
    const w = ort.env.wasm as { wasmBinary?: ArrayBuffer | Uint8Array; wasmPaths?: unknown };
    if (w.wasmBinary) return;
    try {
      const file = ORT_WASM_FILES[build];
      const url = new URL(file, wasmBase).href;
      const got = await fetchFile(fenv, url, { file }, `onnxruntime-web@${version}`);
      w.wasmBinary = got.bytes;
      await got.stored;
    } catch {
      w.wasmPaths = wasmBase;
    }
  }

  private async createEngine(
    ort: OrtLike,
    plan: Plan,
    bytes: Uint8Array,
    tokenizer: Tokenizer,
    calibration: ReturnType<typeof parseCalibration>,
    meta: ModelMeta,
    card: ModelCard,
    opts: BackendLoadOptions,
  ): Promise<Engine> {
    const ms = plan.device === "webgpu" ? (opts.sessionTimeoutMs?.webgpu ?? 60_000) : (opts.sessionTimeoutMs?.wasm ?? 180_000);
    const creating = ort.InferenceSession.create(bytes, { executionProviders: [plan.device], graphOptimizationLevel: "all", ...ORT_SESSION_LOG });
    let session: OrtSessionLike;
    try {
      session = await withTimeout(creating, ms, this.env.clock, `${plan.device} session creation`);
    } catch (e) {
      creating.then((s) => s.release?.(), () => undefined); // a late session is released, never used
      throw e;
    }
    try {
      return new Engine({ ort, session, tokenizer, calibration, meta, device: plan.device, variant: plan.variant, name: `${card.name}@${card.version}`, now: () => this.env.clock.now() });
    } catch (e) {
      await session.release?.().catch(() => undefined);
      throw e;
    }
  }

  get ready(): boolean {
    return !!this.engine;
  }

  async evaluate(state: unknown, questions: unknown): Promise<EngineResult> {
    if (!this.engine) throw new ModelNotReadyError(this.st.state === "error" ? `the GenClass model failed to load: ${this.st.error}` : undefined);
    return this.engine.evaluate(state, questions);
  }

  measure(state: unknown, questions?: unknown): { stateTokens: number; positions: number; total: number } {
    if (!this.engine) throw new ModelNotReadyError();
    return this.engine.packer.measure(state, questions);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const e = this.engine;
    this.engine = null;
    if (e) await e.release().catch(() => undefined);
    this.set({ state: "off" });
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function globalLocation(): string | undefined {
  const loc = (globalThis as { location?: { href?: string } }).location;
  return loc?.href;
}

// --------------------------------------------------------------------------------------------- warm-up

/** A situation-shaped request (~350 tokens, two choice questions): compiles WebGPU pipelines / warms WASM kernels. */
export const WARMUP_STATE = {
  app: "Orders dashboard, route /orders/:id",
  trigger: "A write to orders.items by GET /api/orders/:id is about to apply.",
  facts: [
    "GET /api/orders/:id started 1.24 s ago, caused by a click on \"Refresh\".",
    "orders.items was at version 4 when it started and is at version 6 now.",
    "Versions 5 and 6 were written by PATCH /api/orders/:id, which started after it.",
    "An identical request finished 0.31 s ago.",
  ],
  in_flight: ["PATCH /api/orders/:id (0.42 s)", "GET /api/orders/:id (1.24 s)"],
  timeline: [
    "-1.24s user click \"Refresh\"",
    "-1.24s GET /api/orders/:id started",
    "-0.62s user input orders.note",
    "-0.42s PATCH /api/orders/:id started",
    "-0.05s PATCH /api/orders/:id ok 200",
    "-0.05s state orders.items v6",
  ],
  state: ["orders.items: 3 items (ids 17, 18, 21)", "orders.total: 42.5", "orders.note: \"leave at the door\""],
  stats: ["GET /api/orders/:id: median 180 ms, p95 420 ms, 2% errors"],
};

export const WARMUP_QUESTIONS = {
  action: {
    type: "choice" as const,
    instructions: "What should the runtime do with this write?",
    criteria: {
      apply: "let this write update the state now",
      discard: "drop this write and keep the current state",
      defer: "hold this write until the related in-flight operations finish, then decide again",
    },
  },
  diagnosis: {
    type: "choice" as const,
    instructions: "What is going on?",
    criteria: {
      expected: "normal behaviour, nothing is wrong",
      stale: "outdated data or an older operation is about to replace newer state",
      conflict: "concurrent operations are competing over the same state or resource",
      duplicate: "the same change or request is happening again without a new intent",
    },
  },
};
