# @genclass/runtime: model host (worker, loader, backends, engine, packer, calibration, CLI)

> **Scope:** `packages/runtime/src/model/*.ts` (backend, calibrate, engine, errors, hash, host, index, loader, packer, protocol, pyutil, serialize, tokenizer, worker), `packages/runtime/src/model/README.md` (internal notes), `packages/runtime/bin/genclass-runtime.mjs`, `packages/runtime-model/MODEL_CARD.md`, the model-loading side of the CDN builds (`packages/runtime/src/cdn/ort-env.ts`, `ort-wasm.ts`, `ort-webgpu.ts`, `worker.ts`, and in `src/cdn/global.ts` the `withCdnModel` / `blobModuleWorker` / `assetBase` parts; the rest of `src/cdn/*`, `src/auto.ts` and `bin/lib/*` belong to INSTALL and are covered in [public-api-and-lifecycle.md](./public-api-and-lifecycle.md) and [build-test-release.md](./build-test-release.md)), the `worker` entry and the CDN entries of `packages/runtime/tsup.config.ts`, and the model sections (§2 `model` options, §8 `DecisionProvider`, §10, §13) of `docs/runtime/CONTRACT.md`.
> **Read this when:** you change how the model is downloaded, cached, verified or run; touch the worker or its message protocol; change WebGPU/WASM selection or onnxruntime-web settings; change the tokenizer, packer, Python-parity serializer or calibration; add or change a model error; change how the script-tag (CDN) build starts the model worker or loads onnxruntime-web; work on the `genclass-runtime` CLI (`fetch-model` / `info`); debug "model unavailable", "observing only", stuck loads or slow decisions.
> **Source of truth:** the code. Verified against branch `mvp-v2-merge` at f107013 (mvp-v2 + origin/runtime eff18cb + observe/redaction fixes), 2026-10-08. If this doc and the code disagree, the code wins.
>
> **What changed since the previous verification (`mvp-v2` at b435acb), in one line:** still nothing under `packages/runtime/src/model/` changed. New around it: the CDN builds from origin/runtime (f3a9dd1, owner INSTALL): the script tag `dist/genclass.global(.min).js` hands the host its own `workerFactory` (a same-origin Blob-URL module worker that imports `dist/cdn/worker.js` from the CDN) and `ortLoader` (`dist/cdn/ort-webgpu.js` / `ort-wasm.js`, which bundle onnxruntime-web and prepare it for a cross-origin script); see [CDN script-tag build](#2b-cdn-script-tag-build-srccdn-tsupconfigts). The `/auto` entries use the ordinary npm host; the CLI gained `init` / `remove` (`bin/lib/*`, INSTALL). Runtime side (054da38): in `observe` a delivery is released at once and its decision now reaches the host in the background instead of being dropped as stale. None of this is on npm: the published `0.1.0-alpha.1` (806a296) predates the merge, so the CDN builds ship in the next version.

## TL;DR

- `createModelHost(opts)` (`packages/runtime/src/model/host.ts`) returns a `ModelHost`, which implements the runtime's `DecisionProvider` seam (`packages/runtime/src/types.ts`). `GenClass.init()` creates one by default in a browser. The runtime only calls `status`, `ready()`, `evaluate()`, `onStatus()` and `dispose()`.
- **Fail open, never wait.** `evaluate()` rejects at once with `ModelNotReadyError` (code `not_ready`) unless `status.state === "ready"`. Every provider error makes the runtime run the passive action. While the host is `"loading"` or `"error"`, the runtime does not even build situations.
- **Transport:** inference runs in a module Worker (`dist/worker.js`, built from `src/model/worker.ts`). If the Worker cannot be created, errors before its `hello`, or sends no `hello` within 15 s, the same `ModelBackend` runs inline on the main thread. `worker: false` forces inline. The script-tag (CDN) build swaps in its own worker factory and ORT loader (both on the host's existing injection points `workerFactory` / `ortLoader`): a Blob-URL module worker importing `dist/cdn/worker.js`, and `dist/cdn/ort-*.js` with onnxruntime-web bundled in. The backend and the load sequence are unchanged.
- **Load sequence** (`packages/runtime/src/model/backend.ts` -> `ModelBackend.doLoad`):
  1. The `model.json` card, fetched in parallel with a WebGPU probe.
  2. The plans are computed.
  3. In parallel: the onnxruntime-web bundle import (`/webgpu` only if a WebGPU plan exists, else `/wasm`), the tokenizer, calibration and meta files, and the first variant.
  4. The ORT `.wasm`, prefetched by us.
  5. For each plan: `InferenceSession` -> `Engine` -> a warm-up pass. The first plan that works wins.
- **Plans:** `webgpu+fp16` (adapter has `shader-f16`) -> `webgpu+q8` -> `wasm+q8`. A failed WebGPU plan alone does not trigger a retry: the same worker moves on to the next plan. Only when a worker's whole load ends in an error status, a crash or a stall after a WebGPU attempt does the host retry **once** in a fresh worker with WASM only (`retryOnWasm`).
- **Downloads** (`packages/runtime/src/model/loader.ts` -> `fetchFile`) go through Cache Storage `genclass-runtime-v1`. They are checked against the card's size and sha256 (WebCrypto, with a pure-TS fallback) and streamed with progress. The card itself is always revalidated from the network. A cached card is used only when the network fails.
- **Engine** (`engine.ts`): `Packer` (`packer.ts`, `Tokenizer` from `tokenizer.ts`, text from `serialize.ts`) packs everything into int64 feeds. One ORT forward pass produces `choice_logits` / `score_logits` / `noul_logits`. Temperature or Platt calibration (`calibrate.ts`) then gives typed `Answer`s.
- **Python parity is the contract.** `serialize.ts`, `pyutil.ts`, `tokenizer.ts`, `packer.ts` and `calibrate.ts` are ports of `jev_local` Python. The model was trained on the Python rendering, so any change here is a model-format change. The situation format (the text CORE builds in `packages/runtime/src/situation/*`, which this module then tokenizes) is frozen at tag `situation-v2` (6e5e86e); `situation-v1` is the old format. The model module itself is identical in v1 and v2.
- **No model exists for the current runtime, and none is published.** `DEFAULT_MODEL_BASE_URL` = `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/`. `packages/runtime-model/` holds only `MODEL_CARD.md`; `@genclass/runtime-model` is a 404 on npm (as of 2026-10-08). The only trained runtime model, R17-final1, was trained on `situation-v1` and lives only on the train VM / Mehar's Mac; it does **not** match the v2 runtime. The v2 model comes from the scaled program ([HANDOFF](../../../HANDOFF.md): 150M teacher -> distil R17/R32 -> DAgger -> EVAL -> `@genclass/runtime-model@0.1.0`). The card fetch therefore fails (HTTP 404), the host goes to `state: "error"`, and the runtime prints `[GenClass] Model unavailable (...); observing only.` From then on it observes only. See [When the default model URL 404s](#when-the-default-model-url-404s-the-alpha-today).
- **Status:** `off` -> `loading` (phases `card` / `download` / `runtime` / `session` / `warmup`) -> `ready` or `error`; `dispose()` -> `off`. See [Status lifecycle](#status-lifecycle-modelhoststatusstate). The runtime core reads only `state`, `device`, `threads`, `warmupMs`, `model`, `variant`, `loadMs` and `error` (the devtools overlay also shows `progress`); `status.latency` (p50/p90 of the last 20 evaluations) and `host.stats` are for tooling.
- **Default mode `observe` (since f3636b2) still loads and consults the model.** `observe` permits no non-passive action, so nothing is ever held: every salient trigger, `delivery` included (since 054da38), is decided in the background (priority capped at 1, deadline 5 s), for detection and reports. A salient delivery is released to the app at once (`runDelivery` -> `deliveryHoldable` is false in `observe`), before any body read, and its background decision is no longer dropped as stale. Only `mode: "guard"`/`"heal"` can make the runtime wait for the host.
- **CLI** `genclass-runtime fetch-model <dir>` / `info <dir>` downloads and verifies a self-hostable model directory, with no dependencies. Its own default source (`DEFAULT_FROM`) is the same jsDelivr directory as `DEFAULT_MODEL_BASE_URL`, a 404 too until the model package is published, so pass `--from` until then. The file is committed executable (mode 100755, b435acb). The same binary now also has `init` / `remove` (project setup; `bin/lib/*`, owner INSTALL, not covered here) and runs as `npx @genclass/runtime <command>`. A short-alias package `genclass-runtime` (`packages/genclass-runtime/cli.mjs`, which only imports this file; not on npm yet) is meant to make `npx genclass-runtime <command>` work without a local install.

## Files

| path | role | key exports / entry points |
|---|---|---|
| `packages/runtime/src/model/host.ts` | Main-thread host: chooses worker or inline transport, preload, priority queue, timeouts, status, WASM retry, latency stats | `createModelHost`, `ModelHost`, `ModelHostOptions`, `ModelHostStats`, `ModelEvaluateRequest`, `WorkerLike`, `DEFAULT_MODEL_BASE_URL`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_MAX_QUEUE` |
| `packages/runtime/src/model/backend.ts` | Load sequence and evaluation. One instance runs in the worker, or inline. Sets ORT threads and wasm. Provides the warm-up request | `ModelBackend`, `ModelHostStatus`, `LatencyStats`, `OrtBuild`, `BackendLoadOptions`, `BackendEnv`, `ORT_WASM_FILES`, `ortCdnBase`, `WARMUP_STATE`, `WARMUP_QUESTIONS` |
| `packages/runtime/src/model/worker.ts` | Module Worker entry (tsup entry `worker` -> `dist/worker.js`). Wires `ModelBackend` to `postMessage` | (side-effect module; posts `hello`) |
| `packages/runtime/src/model/protocol.ts` | Host <-> worker message types | `ToWorker`, `FromWorker`, `EvaluateOk` |
| `packages/runtime/src/model/loader.ts` | Card parsing, plan order, WebGPU probe, Cache-Storage downloads with sha256, step timeouts | `parseCard`, `planOrder`, `probeWebGPU`, `fetchFile`, `fetchCard`, `cardId`, `fileUrl`, `normalizeBaseUrl`, `withTimeout`, `StepTimeoutError`, `CARD_FORMAT`, `DEFAULT_CACHE_NAME`, types `ModelCard`, `VariantSpec`, `FileSpec`, `FileRole`, `Plan`, `GpuInfo`, `DevicePreference`, `DeviceKind`, `FetchEnv`, `FetchOutcome`, `TimerEnv` |
| `packages/runtime/src/model/engine.ts` | Packer + ORT session + calibration -> answers. Checks the graph contract | `Engine`, `FEEDS`, `tensorFloats`, `ModelMeta`, `EngineOptions`, `EngineResult`, ORT structural types `OrtLike`, `OrtSessionLike`, `OrtTensorLike`, `OrtEnvLike` |
| `packages/runtime/src/model/packer.ts` | Sequence layout, ONNX feed plan, logits unpacking, token limits | `Packer`, `planInputs`, `unpackLogits`, `MARKERS`, `STATE` (= -1), types `Packed`, `PackedQuestion`, `PackerOptions`, `FeedPlan`, `HeadOutput`, `Marker` |
| `packages/runtime/src/model/tokenizer.ts` | Byte-level BPE over HF `tokenizer.json` | `Tokenizer` (`encode`, `count`, `decode`, `tokenId`, `vocabSize`), `bytesToUnicode`, `TokenizerJson`, `AddedTokenJson` |
| `packages/runtime/src/model/serialize.ts` | Jev state/question -> text. Port of `jev_local/serialize.py` | `stateSegments`, `segmentText`, `stateText`, `entryText`, `pyJson`, `toJsonValue`, `questionBlock`, `questionEntries`, `criteriaEntries`, `MAX_ARRAY_SEGMENTS`, `DEFAULT_{NOUL,CHOICE,SCORE}_INSTR`, types `Segment`, `QBlock`, `BlockKind`, `WireQuestion` |
| `packages/runtime/src/model/pyutil.ts` | Python value semantics | `pyNumber`, `pyFloatRepr`, `pyRound`, `pyStrip`, `clip01` |
| `packages/runtime/src/model/calibrate.ts` | `calibration.json` parsing, temperature/Platt lookup, answer math. Port of `calibrate.py` and `confidence.py` | `parseCalibration`, `calibrateLogits`, `buildAnswer`, `headerKey`, `tauFor`, `noulAffine`, `kBucket`, `normalizeProbs`, `choiceConfidence`, `scoreConfidence`, `K_BUCKETS`, `BUCKET_CLAMP`, `Calibration`, `Precision` |
| `packages/runtime/src/model/errors.ts` | Typed errors and their wire format | `GenClassModelError` + 11 subclasses, `serializeError`, `deserializeError`, `errorMessage` (any thrown value -> string), `ModelErrorCode`, `SerializedError`, `LoadAttempt` |
| `packages/runtime/src/model/hash.ts` | Pure-TS SHA-1 (calibration header keys) and SHA-256 (integrity; WebCrypto preferred) | `sha1Hex`, `sha256Hex` (async; `crypto.subtle` when present, else pure TS), `sha256HexSync`, `sha1`, `sha256` |
| `packages/runtime/src/model/index.ts` | Barrel for the model module (internal; not a package entry point). Nothing in `src/` imports it: the runtime imports `model/host.js` and `model/errors.js` directly. Its only user is the fallback "model-entries" build in `packages/runtime/test/browser/build.mjs`, which uses it as the `index` entry | re-exports everything above **except** `withTimeout`, `StepTimeoutError`, `TimerEnv`, `errorMessage`, `sha256HexSync`, `sha1`, `sha256`, `pyFloatRepr`, `HeadOutput`, `Marker`, `OrtEnvLike`, and the protocol types `ToWorker` / `FromWorker` (`EvaluateOk` is re-exported via `host.ts`) |
| `packages/runtime/src/model/README.md` | MODEL's internal notes: card format, load steps, parity results, measured latency and transfer sizes | — |
| `packages/runtime/src/index.ts` | Public facade. Re-exports `createModelHost`, `DEFAULT_MODEL_BASE_URL`, the host types and all error classes. Builds the host in `makeHost` | `createRuntime`, `GenClass.init`, `makeHost`, `failedProvider`, `NATIVE_FETCH` |
| `packages/runtime/src/cdn/global.ts` | Script-tag build (`dist/genclass.global.js` / `.global.min.js`, iife, `window.GenClass`; owner INSTALL). Model side: `withCdnModel` adds `workerFactory: () => blobModuleWorker(<base>cdn/worker.js)` and `ortLoader: build => import(<base>cdn/ort-webgpu.js \| ort-wasm.js)` to `model` (user keys spread after them; skipped when a `decider` is given or `model === false`); `assetBase` picks `<base>` | `assetBase`, `GenClassGlobal` (internal: `blobModuleWorker`, `withCdnModel`, `findScript`, `install`) |
| `packages/runtime/src/cdn/worker.ts` | CDN module-worker entry (-> `dist/cdn/worker.js`). Imports `../model/worker.js` unchanged, plus a `message` listener that copies `load.options.ortWasmPaths` into `cdnState` | (side-effect module) |
| `packages/runtime/src/cdn/ort-env.ts` | Shared by the CDN worker and the ORT wrappers (lands in a shared chunk of `dist/cdn/`). `prepareOrt` points ORT's threaded glue `.mjs` at the onnxruntime-web directory (only in a `crossOriginIsolated` worker with `env.wasm.wasmPaths` unset, the case where a cross-origin ORT would need it) | `cdnState`, `prepareOrt` |
| `packages/runtime/src/cdn/ort-wasm.ts`, `ort-webgpu.ts` | `import * as ort from "onnxruntime-web/wasm" \| "/webgpu"`, `prepareOrt(ort.env, "ort-wasm-simd-threaded.mjs" \| "ort-wasm-simd-threaded.asyncify.mjs")`, re-export everything (-> `dist/cdn/ort-wasm.js` / `ort-webgpu.js`) | (re-exports of onnxruntime-web) |
| `packages/runtime/src/cdn/config.ts` | Page configuration for the script tag and `/auto` (owner INSTALL). Model keys of `<meta name="genclass">` / `data-*`: `model` (a directory URL, or `off` -> `model: false`), `modelurl`/`baseurl`, `device`, `preload`, `ort`/`ortwasmpaths` -> `ortWasmPaths`, `worker` | `fromPairs`, `parsePairs`, `mergeConfig`, `readMetaConfig`, `readWindowConfig`, `fromDataset` |
| `packages/runtime/tsup.config.ts` | Four builds. (1) The ESM library: entry `worker: "src/model/worker.ts"` -> `dist/worker.js` (not in `dts.entry`, so no `.d.ts`); `external: ["onnxruntime-web", "onnxruntime-web/webgpu", "react", "redux", "zustand"]`; `target: "es2022"`, `platform: "browser"`, `splitting: true` (the build output's `worker.js` imports `ModelBackend` from a chunk shared with `index.js`), sourcemaps; `clean` spares `cdn/**` and `genclass.global*`. (2, 3) `globalBuild(false \| true)`: iife, `es2020`, plugin `genclass-ort-external` keeps every `onnxruntime-web(/...)` import external (the host's default inline loader stays as a bare `import("onnxruntime-web/...")` that the script tag never calls), defines `__GENCLASS_VERSION__` from `package.json`. (4) The CDN worker build: entries `worker` (`src/cdn/worker.ts`), `ort-webgpu`, `ort-wasm` -> `dist/cdn/`, ESM, minified, `splitting: true`, `noExternal: [/^onnxruntime-web/]`, plugin `genclass-cdn-ort` maps the model worker's `import("onnxruntime-web/webgpu" \| "/wasm")` (any importer outside `src/cdn/`) to `src/cdn/ort-*.ts`, so the built `dist/cdn/worker.js` does `import('./ort-webgpu.js')` / `import('./ort-wasm.js')` | default export (the four configs); module-local `cdnOrt`, `ortExternal`, `globalBuild` |
| `packages/runtime/package.json` | `exports["./worker"]` -> `./dist/worker.js`; `unpkg` / `jsdelivr` -> `./dist/genclass.global.min.js` (what a bare `cdn.jsdelivr.net/npm/@genclass/runtime` URL serves); `sideEffects` lists `./dist/cdn/*.js`, the global builds, the `/auto` files and `./src/model/worker.ts`; `bin.genclass-runtime` -> `./bin/genclass-runtime.mjs`; dependency `onnxruntime-web ^1.30.0` (1.30.0 in the lockfile, which is what the CDN build bundles) | — |
| `packages/runtime/bin/genclass-runtime.mjs` | CLI (Node >= 20, no deps): `fetch-model`, `info`; `init` / `remove` are dispatched to `bin/lib/init.mjs` -> `run` (INSTALL) before argument parsing | `main`, `fetchModel`, `info`, `parseCard` (JS copy), `scanOnnx` |
| `packages/runtime-model/MODEL_CARD.md` | Model card of the runtime model (R17/R32), training data, limits. Its status line (fcd1e68) reports final round 1 on `situation-v1` and says the next rounds retrain on v2. **The npm package itself does not exist yet** (no `package.json`, no `files/` in git, although the card says "`files/r17/` here") | — |

## Concepts and data structures

| term | meaning |
|---|---|
| **model host** | `ModelHost` (`host.ts`): the main-thread object the runtime talks to. It owns one transport and a queue. |
| **backend** | `ModelBackend` (`backend.ts`): loads a model directory and runs the `Engine`. It runs inside the worker, or inline. |
| **transport** | `WorkerTransport` (posts to a Worker) or `InlineTransport` (calls a `ModelBackend` in the same realm, asynchronously via a microtask). Both speak `ToWorker` / `FromWorker`. |
| **model directory** | A URL directory (`baseUrl`) holding `model.json` plus the files it lists. |
| **model card** | `model.json`, parsed by `parseCard` into `ModelCard`. Format tag `genclass-runtime-model/1` (`CARD_FORMAT`). |
| **variant** | One ONNX file of the model, keyed by name in `card.variants`: `q8` (MatMulNBits 8-bit; meant for WASM) and `fp16` (meant for WebGPU with `shader-f16`). |
| **plan** | `{ variant, device }` tried in order by the backend. `device` is `"webgpu"` or `"wasm"`. |
| **ORT build** | `OrtBuild` = `"webgpu"` (`onnxruntime-web/webgpu`, asyncify wasm, runs the WebGPU and WASM EPs) or `"wasm"` (`onnxruntime-web/wasm`, plain wasm, CPU only). |
| **attempt** | `LoadAttempt { variant, device, error }`: a plan that failed. Collected in `status.attempts`. |
| **phase** | The load step in progress: `"card" \| "download" \| "runtime" \| "session" \| "warmup"`. |
| **warm-up** | One forward pass, two on WebGPU, over `WARMUP_STATE` + `WARMUP_QUESTIONS` (a situation-shaped request; the code comment says about 350 tokens) before `ready`. |
| **wire request** (Jev request) | `{ state: JevState, questions: Record<qid, Question> }`, the only part of `EvaluateRequest` that reaches the worker (`protocol.ts` -> `ToWorker`). `Question` is `noul` / `choice` / `score` (`types.ts`). See [glossary](../glossary.md). |
| **segment** | `Segment { key, text }`: one top-level state key (or array item) rendered as text. Segments are separated by `[SEP]` in the packed sequence. |
| **QBlock** | `{ qid, kind: "noul"\|"choice"\|"score", header, items, labels }`: one question rendered for packing. |
| **heads** | Graph outputs `choice_logits`, `score_logits`, `noul_logits` (`OUTPUT_KIND` in `engine.ts`). |
| **tau / calibration** | Post-hoc temperature (or Platt affine for noul) per header, K-bucket or kind, read from `calibration.json`. |
| **fail open** | On any provider error or not-ready state, the subject proceeds unchanged (the passive action). |
| **situation-v1 / situation-v2** | Git tags freezing the situation text format the model is trained on. v2 (6e5e86e, current) adds the `delivery` trigger, new generic facts (F1, F2, F3, F6, F9 in OPEN_TASKS) and a 2,400-char full budget (`STATE_CHAR_BUDGET`). A model trained on one format is not valid for the other. Nothing in `src/model/` encodes the version: `ModelCard` has no situation-format field, so (derived from the code, not tested) a v1 export loads into a v2 runtime and simply answers out of distribution. |
| **R17 / R32** | Runtime model candidates (MODEL_CARD). Final round 1 (v1 data): R17 81.9% action / 90.5% diagnosis, guard FIR 0.05%, clear-case recall about 5-8%; R32 no better. R17 is the chosen default on every device ([docs/runtime/RESULTS.md](../../runtime/RESULTS.md) §2). R17 = ettin-encoder-17m (d 256, 7 layers, 8.1M + 0.7M heads; q8 9.6 MB, fp16 13.6 MB). R32 = ettin-encoder-32m from GenClass 0.1 (d 384, 10 layers, 18.8M + 1.6M heads; q8 22.5 MB, fp16 34.8 MB). Both use a 16,364-token pruned vocabulary, with markers at ids 16359-16363. |
| **v0.1 model** | The older GenClass 0.1 ONNX (`genclass-q8.onnx` 56,931,453 B; `genclass-fp16.onnx` 67,154,907 B) used for development. Its card is `extension/src/model/model.json` (the "v0.1 extension card": `bundled`, `default_base_url`, no `files`). |

### `ModelHost` API (`packages/runtime/src/model/host.ts`)

```ts
interface ModelHost extends DecisionProvider {
  readonly status: ModelHostStatus;           // current snapshot (replaced on every change)
  readonly stats: Readonly<ModelHostStats>;   // the live counters object, not a copy
  ready(): Promise<void>;                     // starts the load if needed
  load(): Promise<void>;                      // starts now; after an "error" it retries
  evaluate(req: ModelEvaluateRequest): Promise<Record<string, Answer>>;
  evaluateDetailed(req: ModelEvaluateRequest): Promise<EvaluateOk>;   // + model ("name@version"), usage, timings
  measure(state: unknown, questions?: unknown): Promise<{ stateTokens: number; positions: number; total: number }>;
  onStatus(fn: (s: ModelHostStatus) => void): () => void;
  dispose(): void;
}
type ModelEvaluateRequest = EvaluateRequest & { timeoutMs?: number };   // EvaluateRequest: trigger, state, questions, priority?, subject?, timeoutMs?
interface ModelHostStats { requests; completed; failed; timeouts; busy; notReady; lastMs?; lastForwardMs? }   // all numbers
```

Public exports of `@genclass/runtime` from this module (`packages/runtime/src/index.ts`): `createModelHost`, `DEFAULT_MODEL_BASE_URL`, types `ModelHost`, `ModelHostOptions`, `ModelHostStatus`, `ModelHostStats`, `ModelEvaluateRequest`, the 12 error classes, `ModelErrorCode`, `LoadAttempt`. `DEFAULT_TIMEOUT_MS`, `DEFAULT_MAX_QUEUE`, `WorkerLike`, `EvaluateOk` and `LatencyStats` are not public.

`stats` counters: `requests` (every `evaluateDetailed` call on a live host; `evaluate` delegates to it), `notReady` (rejected because not `ready`), `completed`, `failed` (error results, unclonable requests, `toJsonValue` failures), `timeouts`, `busy` (queue evictions), `lastMs` (wall time of the last completed request, queue wait included), `lastForwardMs` (its `timings.forward`).

### Status lifecycle (`ModelHostStatus.state`)

| from | to | when (code) |
|---|---|---|
| (constructed) | `off` | `Host` constructor. `preload: "eager"` calls `start()` immediately |
| `off` | `loading` | `start()`: idle callback, or the first `ready()`/`load()`/`evaluate()`/`measure()`. Phases then run `card` -> `download` -> (`download` -> `runtime` -> `session` -> `warmup`) per plan |
| `loading` | `loading` | WebGPU recovery (`retryOnWasm`): the error is swallowed, a fresh worker loads with `device: "wasm"`, earlier attempts are kept |
| `loading` | `ready` | the first plan that passes its warm-up (`ModelBackend.doLoad`) |
| `loading` | `error` | the backend emits `error`, or a worker crashes after `hello`, or the stall watch fires, and no WASM retry happens. `retryOnWasm` needs a worker transport, `device !== "wasm"`, the one retry unused, and a WebGPU entry in `attempts`; a crash is only offered to it when the current `status.device` is `"webgpu"` |
| `ready` | `error` | a worker `error`/`messageerror` event after `hello` (`failEarly` -> `onWorkerCrash`): message `the model worker crashed: <why>` |
| `error` | `loading` | `host.load()` (re-sends `load` on the live transport). After a crash `started` is reset, so `load()`, `ready()`, `evaluate()` or `measure()` all start a fresh worker. After a plain load error (`started` still true) `ready()` rejects at once and starts nothing. The runtime never calls `load()`, and triggers stop calling anything in `error`. It calls `ready()` at most once (the cached `rt.ready`), so the first `rt.ask()`/`rt.decide()` or app read of `rt.ready` **after a crash** restarts the host only if `rt.ready` had not been read before |
| any | `off` | `dispose()` |

### Card (`ModelCard`, `packages/runtime/src/model/loader.ts`)

```ts
interface FileSpec { file: string; bytes?: number; sha256?: string }
interface VariantSpec extends FileSpec { provider?: string; needs?: string }   // needs e.g. "shader-f16"
interface ModelCard { format: string; name: string; version: string; license?: string;
  variants: Record<string, VariantSpec>; files: Record<"tokenizer"|"calibration"|"meta", FileSpec> }
```
`parseCard` rules:
- It must be a JSON object with at least one variant.
- `file` must be relative: no scheme, no leading `/` or `\`, no `..` or empty path segment. Otherwise it throws `ModelUnsupportedError`.
- `bytes` must be a non-negative integer.
- `sha256` must be 64 hex characters. A `sha256:` prefix is accepted and the value is lowercased.
- `files.*` may be a bare string, and missing entries default to `tokenizer.json` / `calibration.json` / `meta.json`.
- Missing `name`, `version` and `format` default to `"genclass-model"`, `"0.0.0"` and `CARD_FORMAT`.
- `provider` is informative only.

### `meta.json` (`ModelMeta`, `engine.ts`): only these keys are read

`max_len` (positions budget; default 1536), `max_total` (whole sequence; default 8192), `markers`, `cls_id`, `sep_id` (all checked against the tokenizer), `inputs`, `outputs` (checked against the graph), and `name` (only the `Engine`'s fallback id; `ModelBackend.createEngine` always passes `name: "<card.name>@<card.version>"`, so the host never uses `meta.name`). `pad_id` is declared in `ModelMeta` but not used. TRAIN's `training/export_runtime.py` writes all of these, plus extra informational keys.

### Status (`ModelHostStatus` in `backend.ts`, extends `ModelStatus` in `types.ts`)

`state: "off"|"loading"|"ready"|"error"`, `phase?`, `progress? {loaded,total}` (model-file bytes; monotonic; throttled to one update per 100 ms, except the final one), `device?`, `variant?`, `model?` (card name), `version?`, `bytes?` (variant size), `fromCache?` (variant came from Cache Storage), `loadMs?`, `warmupMs?` (first warm-up pass), `threads?`, `worker?`, `workerError?` (why inline), `gpu?` (probe summary, e.g. `"nvidia ampere, shader-f16"` or the reason there is none), `attempts?`, `ort?` (onnxruntime-web version), `error?`. Two fields exist only on `ModelHostStatus`: `ortBuild?` and `latency?: LatencyStats`.

```ts
interface LatencyStats { p50: number; p90: number; n: number; tokensP50: number; msPerToken: number; source: "warmup" | "evaluations" }
```

### Protocol (`packages/runtime/src/model/protocol.ts`)

| direction | message | notes |
|---|---|---|
| host -> worker | `{type:"load", options: BackendLoadOptions}` | `baseUrl` (and `ortWasmPaths`) already resolved to absolute URLs on the main thread |
| host -> worker | `{type:"evaluate", id, state, questions}` | `state` is JSON-normalised by `toJsonValue`. `questions` is posted as given (structured clone; Maps survive) |
| host -> worker | `{type:"measure", id, state, questions?}` | answered synchronously from the packer |
| host -> worker | `{type:"dispose"}` | worker disposes the backend then `close()`s |
| worker -> host | `{type:"hello"}` | posted once, right after the worker module evaluates (before ORT is imported) |
| worker -> host | `{type:"status", status: ModelHostStatus}` | every backend status change |
| worker -> host | `{type:"result", id, ok:true, value}` / `{type:"result", id, ok:false, error: SerializedError}` | exactly one per `evaluate` / `measure` |

`EvaluateOk = { answers: Record<string, Answer>; model: string; usage: { input_tokens; positions }; timings: { pack; forward; total } }`.

### Errors (`packages/runtime/src/model/errors.ts`): every class extends `GenClassModelError { code, detail? }`

| class | `code` | thrown by | `detail` / extra fields | what the runtime does |
|---|---|---|---|---|
| `ModelNotReadyError` | `not_ready` | `host.evaluateDetailed`/`measure` when not ready; `pump` when the load failed with jobs queued; `onWorkerCrash` for queued jobs; `ModelBackend.evaluate`/`measure` without an engine | `{state}` from the host | fail open (passive) |
| `MaxTokensExceededError` | `max_tokens_exceeded` | `Packer.pack` | `tokens` (state + longest branch), `total`, `maxTokens`; detail `{detail:"max_tokens_exceeded", tokens, total, max_tokens, max_total?}` | fail open, and `budgetScale = max(0.5, budgetScale*0.8)` (`runtime.ts`, `DeciderQueue` `onError`), so later **automatic** situation budgets are smaller (a numeric `situation.budget` is not scaled) |
| `ModelInputError` | `bad_request` | `serialize.ts` (non-object question, empty choice/score, unknown type, non-object `questions`, non-JSON state such as BigInt or cycles); `host.pump` when `postMessage` throws (e.g. `DataCloneError`) | — | fail open |
| `ModelUnsupportedError` | `unsupported` | bad card/calibration/tokenizer/meta, graph-contract mismatch, missing head for a question kind, unknown output dtype | — | fail open. During load it becomes `ModelLoadError` or an attempt |
| `ModelTimeoutError` | `timeout` | `host.timeout` (request deadline passed, queued or running) | `{timeoutMs}` | fail open |
| `ModelAbortedError` | `aborted` | **never thrown** (only rebuilt by `deserializeError`) | — | — |
| `ModelBusyError` | `busy` | host queue full (eviction) | `{queued}` | fail open |
| `ModelDisposedError` | `disposed` | any call after `dispose()`, and pending work at dispose | — | — |
| `ModelLoadError` | `load_failed` | `fetchFile`/`fetchCard` (network, HTTP status, opaque response); `ModelBackend.doLoad` (wraps every other load failure); host `setStatus(error)` (rejects `ready()`), `ready()` after error, `onWorkerCrash` (running job) | `attempts: LoadAttempt[]`; detail `{attempts}` | status `error`; runtime observes only |
| `ModelIntegrityError` | `integrity` | `fetchFile` size or sha256 mismatch | `{url, bytes, expected}` or `{url, sha256, expected}` | never reaches callers with this code: it is wrapped into `ModelLoadError` (small files) or recorded as an attempt's `error` string (variants) |
| `ModelInferenceError` | `inference_failed` | `Engine.logits` when `session.run` throws | — | fail open |
| `StepTimeoutError` (loader.ts; **not** a `GenClassModelError`) | — | `withTimeout`: `requestAdapter`/`requestDevice` (5 s each) inside `probeWebGPU`, and session creation (webgpu 60 s, wasm 180 s) in `ModelBackend.createEngine` | message `"<what> timed out after <ms> ms"` | Probe timeouts never escape: `probeWebGPU` catches them and returns `webgpu: false` with a `summary` such as `"WebGPU probe failed: requestAdapter timed out after 5000 ms"` or `"<adapter>: no device (...)"`, so no WebGPU plan is made. A session-creation timeout is recorded as an attempt. On WebGPU in a worker it stops the remaining plans |

`ModelLoadError` messages produced by the load (useful when matching `status.error`): `model card download failed: HTTP <status> for <url>`, `model card download failed for <url>: <msg>`, `download failed: HTTP <status> for <url>`, `download failed for <url>: <msg>`, `download of <url> returned an opaque (no-CORS) response`, `WebGPU did not come up (<msg>); not trying further plans in this worker`, `no plan could run the model: <variant>/<device>: <error>; ...` (or `... the card has no usable variant`), `disposed while loading`. Host-side texts: `the model worker crashed: <why>`, `the model worker did not start in time` (only as `workerError`), `the model worker stopped responding while loading (<phase> on <device>)`.

Not a model error: `GenClassUnavailableError` (`packages/runtime/src/errors.ts`, `reason: "off" | "error" | "timeout" | "destroyed"`) is what `rt.ask()`/`rt.decide()` throw when no model can answer. See [public-api-and-lifecycle.md](./public-api-and-lifecycle.md).

Wire format: `SerializedError { name, message, code?, detail? }`. `serializeError` JSON-sanitises `detail`. `deserializeError` rebuilds the class from `code` and restores the original `message`. Non-`GenClassModelError` errors come back as a plain `Error` with the same `name`.

Public re-exports (`packages/runtime/src/index.ts`): all 12 classes, plus the types `ModelErrorCode` and `LoadAttempt`. `serializeError` / `deserializeError` are exported only from the internal `model/index.ts`.

## How it works

### 1. How the runtime creates and consumes the host

1. `packages/runtime/src/index.ts` captures `NATIVE_FETCH` (the global `fetch` as it was when the module loaded, before GenClass instruments it).
2. `GenClass.init(options)` (`initUnsafe`) does one of three things:
   - kill switch `?genclass=off` / `localStorage.genclass="off"`: creates no model;
   - non-browser (no `window` or `document`): sets `model: false`;
   - otherwise, if `options.decider === undefined && options.model !== false`, sets `o.model = options.model ?? {}`.
3. `createRuntime` builds a host only when `options.model` is an object and no `decider` was given. `makeHost` calls `createModelHost({ ...model, fetch, clock })`:
   - `fetch` is `NATIVE_FETCH`, or, when `createRuntime` got a `global`, that global's `fetch` bound before the observers install. It is used only by the inline transport;
   - `clock` is passed only when `createRuntime` got one (otherwise the host uses `browserClock`).

   The script-tag build gets here through `GenClass.init(withCdnModel(init))` (`src/cdn/global.ts`), so its `model` object also carries `workerFactory` and `ortLoader`; they are not typed on `ModelOptions` and pass through the spread like any other `ModelHostOptions` key. The `/auto` entries (`src/auto.ts`, `src/cdn/auto-*.ts`) call plain `GenClass.init` (through `src/cdn/auto-start.ts` -> `startAuto`), so they use the default factory and loader (bundler output).

   If construction throws, it uses `failedProvider`, a provider with `status: {state:"error"}` and no `onStatus` (so no console line and no `"status"` event). The runtime then owns the host (`ownsDecider`) and calls `dispose()` on `destroy()`.
4. `RuntimeImpl` (`packages/runtime/src/runtime.ts`) consumes the provider as follows:
   - `onStatus`: re-fires as the runtime `"status"` event. On `ready` the reporter prints `[GenClass] Model ready (<model>, <device>, <variant>, <loadMs>). Mode: <mode>.` (`<mode>` is `observe` unless the app chose otherwise: `o.mode ?? "observe"` in the `RuntimeImpl` constructor). On `error` it prints `[GenClass] Model unavailable (<error>); observing only.` Both go through `console.info` under `report: "console"`.
   - `consultable()`: triggers are built only when `status.state` is `"ready"` or `"off"`. With `"loading"` or `"error"`, every trigger (including the delivery gate, `runDelivery`) runs its passive action at once and nothing is held. Store writes are held only under `policy.holdWrites: true` (opt-in): `hub.hooks.mayHold` = `hub.holdWrites && consultable() && mode !== "observe"`. By default a salient write goes to `observeWrite` and is decided in the background.
   - `trigger()`: if a situation is salient but `status.state !== "ready"`, it calls `void this.ready`, which starts a load (the effective "lazy" start), and runs the passive action. The public `rt.ready` getter calls `decider.ready()` once and caches the promise, so any read of `rt.ready` by the app, and any `rt.ask()`/`rt.decide()`, also starts the load regardless of `preload`.
   - `priority` per request (the `trigger(...)` call sites in `runtime.ts`, `observe/fetch.ts`, `observe/xhr.ts`; `ask` submits directly): 2 for `delivery` (fetch/XHR responses, WebSocket and EventSource messages, via `runDelivery`), `request` (fetch and XHR), fetch `failure` and a held `mutation` (`gateMutation`, only with `holdWrites`); 1 for a background `mutation` (`observeWrite`, the default), `inconsistency`, `stall`, XHR `failure` and `ask`; 0 for `transition` and `error`. In `trigger`, a request that will not hold is capped at 1 (`waits ? priority : min(priority, 1)`).
   - Holding: `waits = opts.hold && permitted.length > 0 && !paused && expectedLatency() <= holdBudgetMs()`. In `observe` mode `permittedActions` is always empty, so nothing waits and every request, `delivery` included, reaches the host at priority <= 1 with the 5 s background deadline. Since 054da38 a non-waiting delivery gets no `stale` check (`stale` is passed only when `waits || spec.trigger !== "delivery"`), so its background decision is no longer dropped; in `observe` `runDelivery` releases it before reading the body (`deliveryHoldable` is false), and the body analysis is cut short at the first write of its chain (`finalizeDeliveries`). In guard/heal a delivery that cannot wait while `discard` is permitted (`writesCanAct`) runs `passive()` only and is not sent, unless a question forces it or `triage: "always"`; a holdable delivery may still wait up to 100 ms (`BODY_WAIT_MS`) for its body. `expectedLatency()` is `Infinity` while `DeciderQueue.stuck` (the provider's last evaluation timed out and none has answered since), and otherwise `base × (1 + waiting)` plus, while an evaluation is in flight, `max(base, the time it has taken so far)`, where `base` is the (lower) median of the queue's recent latencies, or `status.warmupMs` before any. A slow or wedged host therefore stops causing holds instead of delaying the app.
   - `situationBudget()`: reads `status.device` and `status.threads`: webgpu (and unknown devices) `STATE_CHAR_BUDGET` = 2,400 chars (about 1,000 tokens); wasm `1000 + round((threads - 1) × 1000 / 3)` (1,000 at 1 thread to 2,000 at 4); then `× budgetScale`.
   - `holdBudgetMs()`: seeds from `status.warmupMs` until the decider queue has its own latency samples.
   - `Decision.model`: comes from `status.model ?? status.variant ?? "custom"`.
   - Calls to `evaluate()` all go through `DeciderQueue` (`packages/runtime/src/decide/decider.ts`). It allows one in flight. It passes `timeoutMs = deadline - now` (the hold budget, plus 2 s when a late revert is possible, or 5 s for background decisions). It abandons the provider after that deadline (or 10 s when there is none) and marks itself `stuck` until the next answer. Since batch 4 a queued item also carries a `stale()` check (e.g. a delivery already released): superseded items are dropped before they reach the host. Any rejection triggers `onError` and the passive action. See [decide-policy-actions.md](./decide-policy-actions.md).
5. The runtime does **not** use `measure`, `evaluateDetailed`, `stats` or `status.latency`. They exist for direct `createModelHost` users, the browser benchmarks and devtools-style tooling.
6. The other direct user is the sim's on-policy decider (`sim/src/run/onpolicy.ts` -> `loadModelDecider`, used by `node dist/gen.js --on-policy <modelDir>` via `sim/src/gen/worker.ts`). `npm run build:model-host` in `sim/` builds `packages/runtime/src/model/host.ts` unmodified into `sim/dist/model-host/`, and `loadModelDecider` calls `createModelHost({ baseUrl: "https://model.local/", worker: false, device: "wasm", preload: "eager", fetch: <reads the model directory and onnxruntime-web's dist/ from disk>, ortWasmPaths: "https://model.local/ort/", timeoutMs: 600_000, maxQueue: 10_000 })` and awaits `ready()`. So the inline transport, WASM plan, packer and calibration also run in Node for DAgger data.

### 2. Host start-up, preload and transports (`host.ts`)

1. The `Host` constructor resolves `loadOptions`:
   - `baseUrl`: `resolveBaseUrl(opts.baseUrl ?? DEFAULT_MODEL_BASE_URL)`, resolved against `location.href` so relative paths such as `/genclass-model/` work inside the worker;
   - `device`: `opts.device ?? "auto"`;
   - optional `ortWasmPaths` (resolved), `cacheName`, `warmup: false`, `maxThreads`.
2. Preload (`opts.preload ?? "idle"`):
   - `"eager"`: `start()` now.
   - `"idle"`: `scheduleIdle`. If `document.readyState !== "complete"`, it waits for `load` (or `LOAD_EVENT_WAIT_MS` = 5 s), then calls `requestIdleCallback(run, {timeout: 2000})`. Without `requestIdleCallback` it uses a `clock.setTimeout` of 1 s.
   - `"lazy"`: nothing until the first `ready()`, `load()`, `evaluate()` or `measure()`.
3. `start()` (once): unless `opts.worker === false`, it calls `workerFactory ?? defaultWorkerFactory`. The default factory is `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`, or `null` when `Worker` is undefined. If the factory throws (CSP, `file://`, ...), the result counts as `null`. A `null` worker means `useInline()`. The script tag's factory is `blobModuleWorker` (see [2b](#2b-cdn-script-tag-build-srccdn-tsupconfigts)); the same factory is used again for the WASM retry.
4. `useWorker(w)`:
   - registers `message`, `error` and `messageerror` listeners. Every `error` event is `preventDefault()`ed so it never reaches the page's error handlers or GenClass's own error observer;
   - arms `helloTimer` (`helloTimeoutMs ?? 15_000`);
   - sets status `{state:"loading", worker:true}`, posts `load`, and arms the stall watch.
5. Failure before `hello` (error event, `messageerror`, or hello timeout): the worker is terminated and the host calls `useInline(why)`. `status.workerError = why`.
6. `useInline()` creates an `InlineTransport`:
   - `fetch` = `opts.fetch` (the runtime passes `NATIVE_FETCH`) or global `fetch`;
   - `ort` = `opts.ortLoader ?? defaultOrtLoader` (dynamic `import("onnxruntime-web/webgpu")` or `import("onnxruntime-web/wasm")`);
   - `caches` = `globalThis.caches`.

   It sets status `{state:"loading", worker:false}` and sends `load`.
7. `worker.ts`:
   - If `self.name` starts with `em-pthread` or equals `ort-wasm-proxy-worker`, the module does nothing. ORT may start its pthread workers from the script that contains it.
   - Otherwise it builds `ModelBackend({ ort: dynamic import by build, fetch: self.fetch, caches (try/catch), clock: browserClock, emit: post status, inWorker: true })`, routes messages to it, and posts `hello`.
8. Every `status` message re-arms the **stall watch** (`loadStallMs ?? 180_000`; worker transport only, only while `loading`). Silence for that long calls `onStall`. If `status.device` is `"webgpu"` it first adds an attempt `{device:"webgpu", error:"stalled"}`. It then calls `retryOnWasm`; if that returns false it calls `onWorkerCrash("the model worker stopped responding while loading (<phase> on <device>)")` (`<phase>` is `start-up` when no phase was reported yet).

### 2b. CDN script-tag build (`src/cdn/*`, `tsup.config.ts`)

The model code is the same; only how the worker script and onnxruntime-web get onto the page differs. Owner of `src/cdn/*`: INSTALL.

1. **Where files come from.** `install()` in `global.ts` computes `base`, the package's `dist/` URL: `data-base` on the tag (resolved against the page, trailing `/` added), else `assetBase(script.src)`. On jsDelivr (`cdn`, `fastly`, `gcore`, `testingcf`) and unpkg URLs of `@genclass/runtime`, `assetBase` pins the version to `__GENCLASS_VERSION__` (the `package.json` version at build time), so an unversioned or `@latest` tag never mixes files of two releases. Anywhere else it is the script's own directory. Without a script URL it falls back to `https://cdn.jsdelivr.net/npm/@genclass/runtime@<version>/dist/`. `GenClass.base` exposes it.
2. **Host options.** `withCdnModel` (skipped when the options have a `decider` or `model === false`) sets `model = { workerFactory, ortLoader, ...user }`. `model.baseUrl`, `ortWasmPaths`, `device`, `preload` and `worker` come from the merged page configuration (`<meta name="genclass">`, the tag's `data-*`, `window.GENCLASS_CONFIG`, then the `GenClass.init(options)` argument; `src/cdn/config.ts` -> `fromPairs`: `data-model` / `data-ort` / `data-device` / `data-preload` / `data-worker`). With no `model`/`baseUrl` the host uses `DEFAULT_MODEL_BASE_URL`, so today the script tag observes only, exactly like the npm path (see the 404 flow below).
3. **Worker.** `workerFactory: () => blobModuleWorker(base + "cdn/worker.js")`. Browsers refuse `new Worker(<cross-origin URL>)`, so `blobModuleWorker` creates a same-origin Blob URL whose only line is `import "<base>cdn/worker.js";` and starts `new Worker(blobUrl, { type: "module", name: "genclass-model" })`. It returns `null` when `Worker`, `Blob` or `URL.createObjectURL` is missing (host goes inline); if the constructor throws it revokes the URL and rethrows (the host counts that as `null` too). The Blob URL is revoked on the worker's first `message` (its `hello`) or `error`. A module worker may import cross-origin modules over CORS, and jsDelivr/unpkg send `Access-Control-Allow-Origin: *`; a self-hosted `dist/` on another origin must send CORS headers too. If the import fails (404, CORS, CSP), the worker fires `error` before `hello`, and the host falls back inline as in step 5 of section 2. The 15 s hello timeout covers fetching `cdn/worker.js` (40 KB raw, 16 KB gzip per `test/install/RESULTS.md`) and its shared chunk (`ort-env.ts`, under 1 KB in a local build); ORT still comes later.
4. **`dist/cdn/worker.js`** (`src/cdn/worker.ts`) is `src/model/worker.ts` unchanged (same `hello`, same em-pthread guard, same protocol) plus a second `message` listener that copies `load.options.ortWasmPaths` into `cdnState` (`ort-env.ts`). The model worker's `loadOrt` dynamic imports are rewritten at build time by the `genclass-cdn-ort` plugin, so in the built file they are `import('./ort-webgpu.js')` / `import('./ort-wasm.js')`, resolved next to `worker.js` on the CDN. No bare `onnxruntime-web` specifier is left, so no import map or bundler is needed. Only the bundle the plans need is fetched (`status.ortBuild`), as on npm.
5. **`dist/cdn/ort-webgpu.js` / `ort-wasm.js`** (`src/cdn/ort-webgpu.ts` / `ort-wasm.ts`) bundle `onnxruntime-web/webgpu` / `/wasm` (`noExternal`; minified 118 KB / 73 KB raw per RESULTS.md), call `prepareOrt(ort.env, glue)` once at module evaluation, and re-export the module. `prepareOrt` does something only when the realm is `crossOriginIsolated`, has no `document` (a worker) and `env.wasm.wasmPaths` is unset. Then it sets `env.wasm.wasmPaths = { mjs: <dir>/<glue> }` with `<dir>` = `cdnState.ortWasmPaths` or `https://cdn.jsdelivr.net/npm/onnxruntime-web@<env.versions.web>/dist/`, and `<glue>` = `ort-wasm-simd-threaded.asyncify.mjs` (webgpu bundle) or `ort-wasm-simd-threaded.mjs` (wasm bundle). Reason: with WASM threads, ORT refuses its embedded glue in a cross-origin script and would look for the `.mjs` next to itself, which this package does not ship; given an explicit URL it preloads the glue as a same-origin Blob and can start its pthread workers. Single-threaded (no COOP/COEP), nothing changes: ORT uses its embedded glue because the backend hands it the wasm bytes.
6. **ORT `.wasm` and model files.** Unchanged backend behaviour (section 3, step 7): `prefetchWasm` fetches `ORT_WASM_FILES[build]` from `ortWasmPaths || ortCdnBase(ort.env.versions.web)` through Cache Storage and sets `env.wasm.wasmBinary`. `env.versions.web` is the version bundled into `dist/cdn/ort-*.js` (1.30.0 from the lockfile), so the default wasm and glue always match the bundled JS. The model card and files come from `baseUrl` as on npm. The `.wasm` is not in `@genclass/runtime`; it always comes from the onnxruntime-web package (jsDelivr) or `data-ort`.
7. **Inline fallback** (no `Worker`, CSP `worker-src` blocking the Blob URL, failed import, hello timeout, `data-worker="false"`): `ortLoader(build)` does `import(base + "cdn/ort-webgpu.js" | "cdn/ort-wasm.js")` on the main thread (`/* webpackIgnore */`, `/* @vite-ignore */`). `prepareOrt` is a no-op there (`document` exists), the backend uses 1 thread and `wasmBinary` as usual. Checked in `cdn-check.mjs` ("CSP `worker-src 'none'`: inline fallback loads ORT from the CDN").
8. **What the iife never contains:** onnxruntime-web. `globalBuild` marks every `onnxruntime-web(/...)` import external, so the host's `defaultOrtLoader` survives as a bare `import("onnxruntime-web/webgpu")` in `genclass.global.js`; it is never called because `ortLoader` is always set, unless the page passes its own `model.ortLoader`. The default `new Worker(new URL("./worker.js", import.meta.url))` factory is likewise replaced. `genclass.global.min.js` is 253 KB raw / 86 KB gzip (RESULTS.md).

### 3. Backend load (`backend.ts` -> `ModelBackend.load` / `doLoad`)

1. `load(opts)` joins an in-flight load and resolves at once when an engine exists. On failure `loading` resets, so a later `load` starts over.
2. Phase `card`:
   - starts the GPU probe (skipped with `device:"wasm"`; `probeGpu` override or `probeWebGPU(clock)`);
   - `fetchCard(fenv, baseUrl)` fetches `<baseUrl>model.json` with `cache:"no-cache"`;
   - when the response is OK, parses it and writes a copy to Cache Storage (fire-and-forget);
   - on a network, HTTP or JSON error, falls back to the cached copy;
   - if nothing is cached, rethrows a `ModelLoadError` (`"model card download failed: HTTP <status> for <url>"` or `"model card download failed for <url>: <msg>"`);
   - a `ModelUnsupportedError` from `parseCard` is rethrown immediately, without the cache fallback.
3. It sets `status.model`/`version` from the card. It awaits the probe and sets `status.gpu` to `gpu.summary` (unless `device:"wasm"`).
4. It calls `planOrder(card, device, gpu)` (loader.ts):
   - GPU plans exist only if `device !== "wasm" && gpu.webgpu && (device === "webgpu" || !gpu.fallback)`. `"auto"` skips software adapters (e.g. SwiftShader).
   - For each of `fp16` and `q8` present in the card: skip it if `needs === "shader-f16"` and the adapter lacks `f16`, or if it has any other non-empty `needs`. Otherwise push `webgpu+<v>`.
   - Then push `wasm+q8`, or `wasm+fp16` if the card has no `q8`. If the card has neither, push every variant on WASM in card order.
5. `build = plans.some(webgpu) ? "webgpu" : "wasm"` sets `status.ortBuild`, and `env.ort(build)` starts importing onnxruntime-web.
6. Phase `download`:
   - progress is seeded with the card sizes of the tokenizer, calibration, meta and the first plan's variant;
   - the first variant starts downloading;
   - the three small files are fetched in parallel (`fetchFile` with tag `cardId(card)` = `name@version`) and parsed: `new Tokenizer(...)`, `parseCalibration(...)`, `JSON.parse(meta)`.
   - `fetchFile(env, url, spec, tag, onProgress)` (loader.ts) per file: open Cache Storage `cacheName` -> a valid hit is returned with `fromCache: true` and no network -> an invalid hit is deleted -> network `fetch(url, { cache: "no-store" })` (the HTTP cache is bypassed; Cache Storage is the only cache) -> reject opaque or non-OK responses (`ModelLoadError`) -> stream the body with per-chunk progress (`readBody`; total = card `bytes`, else `content-length`) -> size check, then sha256 check (`ModelIntegrityError`) -> `stored` = a background `cache.put` with headers `x-genclass-tag` and, when hashed, `x-genclass-sha256`. There is no retry.
7. It awaits ORT and calls `configureOrt`:
   - `threads = crossOriginIsolated && inWorker ? max(1, min(maxThreads ?? 4, hardwareConcurrency || 1)) : 1`;
   - `env.wasm.numThreads = threads`, `env.wasm.proxy = false`, `env.logLevel = "error"`.

   It then starts `prefetchWasm`:
   - fetches `ORT_WASM_FILES[build]` from `ortWasmPaths || ortCdnBase(ort.env.versions.web || "1.30.0")` through the same cache (tag `onnxruntime-web@<version>`, no sha256);
   - sets `env.wasm.wasmBinary` so ORT never fetches the wasm itself;
   - if that fails, sets `env.wasm.wasmPaths = <base>` instead. In the CDN worker on a `crossOriginIsolated` page this replaces the `{ mjs }` object `prepareOrt` set, so ORT then resolves both the glue and the wasm under `<base>` on its own (not tested).
8. For each plan:
   - `download` (await the variant; extra variants are fetched on demand and memoised per load);
   - `runtime` (await the wasm prefetch);
   - `session`: `ort.InferenceSession.create(bytes, { executionProviders: [device], graphOptimizationLevel: "all" })` under `withTimeout` (webgpu 60 s, wasm 180 s, overridable only via `BackendLoadOptions.sessionTimeoutMs`). A session that arrives late is released;
   - `new Engine(...)` checks the graph contract;
   - `warmup`: one `engine.evaluate(WARMUP_STATE, WARMUP_QUESTIONS)`, timed as `warmupMs`. On WebGPU a second pass is timed for latency, because the first pass compiles pipelines. The result seeds `status.latency = {p50=p90=ms, n:0, tokensP50, msPerToken, source:"warmup"}`;
   - await all Cache Storage writes, then `ready` with `loadMs`, `bytes`, `fromCache` and `attempts` (if any).
9. If the backend is disposed mid-load, `ModelLoadError("disposed while loading")` is thrown at the start of the next plan or right after the warm-up (the engine is released); it is not recorded as an attempt. Otherwise a plan that throws is pushed to `attempts`, and the next plan is tried. Exception: a `StepTimeoutError` on WebGPU **inside a worker** throws `ModelLoadError("WebGPU did not come up (...); not trying further plans in this worker")`, because ORT may be wedged in WebGPU. Inline, the remaining plans continue.
10. If every plan fails, it throws `ModelLoadError("no plan could run the model: <variant>/<device>: <error>; ...", attempts)`. Any error goes through the outer catch, which emits `{state:"error", error, worker, model?, version?, gpu?, attempts?}` and rethrows. Non-`ModelLoadError` errors (integrity, unsupported tokenizer, ...) are wrapped in a `ModelLoadError` with the same message.
11. `finally`: `delete ort.env.wasm.wasmBinary`, which drops the ~25 MB reference once ORT has instantiated the wasm.

### 4. Host reaction to statuses and WebGPU recovery (`host.ts` -> `onMessage`, `retryOnWasm`)

1. `hello`: marks the worker alive and clears the hello timer.
2. `status`:
   - If `state === "error"` and `retryOnWasm(status)` returns true, the error is swallowed and a retry starts.
   - Otherwise `setStatus({...status, worker: <transport is worker>, attempts: priorAttempts + status.attempts, workerError?})` notifies listeners. On `ready` it resolves the `ready()` waiters. On `error` it rejects them with `ModelLoadError(error, attempts)`. Then `armStallWatch()`; on `ready` or `error`, `pump()`.
3. `retryOnWasm` runs at most once per host (`wasmRetried`), and only when all of these hold:
   - the transport is a worker;
   - `loadOptions.device !== "wasm"`;
   - some attempt has `device === "webgpu"`.

   It closes the worker, keeps `priorAttempts`, and starts a fresh worker (or inline, `workerError: "could not start a second worker"`) with `{...loadOptions, device:"wasm"}`. Its triggers are a worker error status, a worker crash after `hello` while `loading` on WebGPU, and a stall (which adds a `{device:"webgpu", error:"stalled"}` attempt when it happened on WebGPU, so it retries on WebGPU or after any earlier WebGPU attempt).
4. `onWorkerCrash(why)` (crash after `hello`, or a stall, when not retried):
   - closes the transport, sets `started = false` (so `load()`/`ready()` can start a new worker), and sets status `{state:"error", error, worker:true}` where `error` is `why` itself when it already starts with `"the model worker"` (the stall message), else `"the model worker crashed: <why>"`;
   - rejects the running job with `ModelLoadError`, and queued jobs and pending `measure`s with `ModelNotReadyError`.
5. `load()`:
   - after `error` with a live transport, it re-sends `load` with the same options (status back to `loading`);
   - after a crash (no transport), it calls `ready()`, which starts a new worker;
   - otherwise it is the same as `ready()`.
6. `ready()`: rejects with `ModelDisposedError` after dispose, and immediately with `ModelLoadError` when `state === "error"` and the load was started. Otherwise it waits and starts the load.

### 5. Evaluate path (host -> worker -> engine)

1. `host.evaluateDetailed(req)`:
   - increments `stats.requests`;
   - if not `ready`: `stats.notReady++`, `start()`, reject `ModelNotReadyError` with message `"the GenClass model is not loaded"` / `"... is still loading"` / `"the GenClass model failed to load: <error>"` (measured in Chromium at < 1 ms);
   - otherwise `state = toJsonValue(req.state)` (a throw is a `ModelInputError`);
   - creates a `Job {id, seq, priority: Number(req.priority ?? 0) || 0, ...}` with a timer of `req.timeoutMs ?? opts.timeoutMs ?? 10_000`.
2. Queue admission: if `queue.length >= maxQueue` (default 32; the running job is not counted), the victim is the lowest-priority, oldest request among the queue and the new job. With equal priorities that is the oldest queued job, not the newcomer.
   - If the victim is a queued job, it is removed and rejected with `ModelBusyError`.
   - If the victim is the newcomer, it is rejected with `ModelBusyError` only when a job is running. Otherwise it is queued anyway, exceeding `maxQueue`.

   Each rejection increments `stats.busy`.
3. `pump()`: if `ready` and nothing is running, it picks the highest `priority` (then lowest `seq`), skips settled jobs, and posts `evaluate`. A `postMessage` throw (e.g. `DataCloneError` for functions in `questions`) rejects the job with `ModelInputError`. If the status is `error`, all queued jobs are rejected with `ModelNotReadyError`.
4. `timeout(job)`: `stats.timeouts++`. A queued job is removed and never computed. A running job is rejected, but **keeps the slot** until the backend answers (one inference at a time).
5. Worker side: `backend.evaluate` -> `Engine.evaluate(state, questions)`:
   1. `Engine.logits` is serialised per session through a promise chain (`serial`).
   2. `packer.pack(state, questions)` -> `{packed, blocks}`. Every block's kind must be one of the model's `heads`, else `ModelUnsupportedError`.
   3. `feeds(packed)`: for each declared input name, `FEEDS[name](packed, planInputs(packed))` -> `BigInt64Array` int64 `Tensor`s.
   4. `session.run(feeds)`; a throw becomes `ModelInferenceError`. Each declared output `*_logits` is converted by `tensorFloats` (float32 / float64 / float16; float16 `Uint16Array` is decoded by `halfToFloat`).
   5. `unpackLogits(packed, heads)` gives raw logits per qid in request order. For noul it is 1 value (row g). For choice and score it is the first `labels.length` columns of row g of a `[nQ, K]` tensor.
   6. Input and output tensors are `dispose()`d.
   7. Per block: `calibrateLogits(kind, headerKey(header), logits, calib)`, then `buildAnswer(question, probs, "exact", labels)`.
   8. It returns `usage = {input_tokens: inputIds.length, positions: max(positionIds)+1}` and `timings = {pack, forward, total}` (ms, via the injected clock).
6. Host `result`:
   - a late result for a timed-out job just frees the slot;
   - an OK result increments `stats.completed`, sets `lastMs` (wall time including the queue) and `lastForwardMs`, calls `recordLatency`, and resolves;
   - an error result increments `stats.failed` and rejects with `deserializeError(error)`;
   - then `pump()`.
7. `recordLatency`:
   - keeps a window of the last 20 `{ms: timings.total, tokens: usage.input_tokens}` samples;
   - nearest-rank `p50`/`p90` (`a[ceil(p*n)-1]`), `tokensP50`, and `msPerToken` (median of ms/token, 3 dp), with `source:"evaluations"`;
   - `p50`/`p90` are rounded to whole ms; `tokensP50` is not rounded;
   - listeners are notified on the first sample and then at most every 5 s. Otherwise `status.latency` changes silently;
   - the window is emptied whenever a new transport starts (`useWorker`/`useInline`, so also after a WASM retry). Until the first evaluation, `status.latency` is the backend's warm-up estimate (`source: "warmup"`, `n: 0`), absent when `warmup: false`.

### 6. Packing and text (`serialize.ts`, `tokenizer.ts`, `packer.ts`)

Full contract with examples: [model-io-contract.md](../model-io-contract.md). In brief:

1. `stateSegments(state)` runs `toJsonValue` first: `undefined` keys vanish, NaN/Infinity become `null`, Dates become strings, BigInt and cycles throw `ModelInputError`. A `Map` survives (ordered) only at the top level or as a value of another `Map`; a `Map` nested inside a plain object or array goes through `JSON.stringify` and becomes `{}`. Then:
   - an object state gives one segment per key. String arrays are joined with `"\n"`; everything else goes through `entryText`;
   - an array state gives `[i]` segments for the first 64 items (`MAX_ARRAY_SEGMENTS`), plus a `[64:]` overflow segment;
   - a string gives one segment with key `""`, stripped;
   - `null` -> `"None"`, booleans -> `True`/`False`, numbers -> `pyNumber`.

   `segmentText(s) = key ? "key: text" : text`.
2. `entryText` renders individual values:
   - strings are `pyStrip`ped (Python `str.strip()` whitespace set, not JS `trim`);
   - string arrays become `"; "`-joined non-empty entries;
   - other arrays and nested values become `pyJson` (`json.dumps` with `", "` / `": "` separators, `ensure_ascii=False`);
   - objects become `"k: v | k2: v2"`;
   - numbers print like Python after a JSON round trip (`pyNumber`: ints stay ints, floats use `repr` with exponent form when exp < -4 or >= 16).
3. `questionBlock(qid, q)`:
   - `noul`: header = instructions or `DEFAULT_NOUL_INSTR`; items = [true criterion or `"yes"`, false criterion or `"no"`]; labels `["true","false"]`;
   - `choice`: items are `"label"` when the description is null, empty or equal to the label, else `"label: desc"`. Labels keep criteria order (use a `Map` to keep integer-like labels in order);
   - `score`: items are the level texts; labels are `"0".."n-1"`.

   Question ids are never shown to the model.
4. `Tokenizer.encode(text)`: HF `tokenizers` byte-level BPE, as `encode(text, add_special_tokens=False)`. Order in code: `splitAdded(normalize(text))`, then `encodePiece` per remaining piece.
   - Special added tokens (`[CLS]`, `[Q]`, ...) are **never** matched in text, so user text cannot forge a marker.
   - The normalizer (NFC/NFD/NFKC/NFKD/Lowercase/Sequence; ASCII-only text skips the Unicode forms) runs first, on the whole text.
   - Then non-special added tokens are split out of the normalized text (scan left to right, longest match at each position), keeping their own ids.
   - Each remaining piece goes through the GPT-2 ByteLevel regex (with `\p{White_Space}`), bytes-to-unicode, and heap-based merges as in `Word::merge_all`.
   - Nothing is hardcoded: the vocab, ids and merges all come from the file.
   - `pre_tokenizer.add_prefix_space` and `use_regex`, and `model.ignore_merges`, are honoured. Words are cached (`cacheSize` 20000, cleared when full).
   - The constructor throws `ModelUnsupportedError` for: a model type other than `BPE`; BPE `dropout`; `continuing_subword_prefix`/`end_of_word_suffix`; a non-special added token with `lstrip`/`rstrip`/`single_word`; any id >= `ID_SPACE` (2^26); a missing byte-level token for a byte that can occur in UTF-8; a malformed merge or one referring to a missing token; a normalizer other than NFC/NFD/NFKC/NFKD/Lowercase/Sequence; a missing pre-tokenizer or one other than ByteLevel (or a one-element Sequence of it).
   - Other methods: `count(text)`, `decode(ids)` (byte-level; for logs and tests), `tokenId(s)` (added tokens first, then vocab), `vocabSize` (max id + 1).
5. `Packer.pack(state, questions)` builds:
   ```
   [CLS] seg_0 [SEP] seg_1 [SEP] ... | [Q] header_0 | [O] item_00 | [O] item_01 | ... | [Q] header_1 | ...
   ```
   - Item markers: `[O]` for choice, `[L]` for score, `[T]`/`[F]` for noul.
   - Positions restart per branch: the header is at `S..`, and every item at `S+len(header)..`.
   - `q_group` is -1 for state tokens, else the question ordinal. `i_group` is -1 for state and header tokens, else the item ordinal.
   - Limits:
     - `stateTokens + max_q(len(header_q) + longest item_q) <= maxPositions` (`meta.max_len`, default 1536);
     - `total <= maxTotal` (`meta.max_total`, default 8192);
     - otherwise `MaxTokensExceededError`.
   - Marker, CLS and SEP ids come from `meta.json` and must equal the tokenizer's (`ModelUnsupportedError` on mismatch), or from the tokenizer alone.
6. `planInputs` gives the marker indices per head. A kind with no question gets a dummy row at token 0. Items are padded to `k` with 0.
7. `Packer.measure(state, questions?)` returns `{stateTokens, positions, total}` without building the sequence (exposed as `host.measure`). It never throws `MaxTokensExceededError`; compare the result with `meta.max_len`/`max_total` yourself. Without `questions`, `positions = total = stateTokens` (which counts `[CLS]` and every `[SEP]`).

### 7. Calibration (`calibrate.ts`)

`parseCalibration` applies defaults `{noul:1, choice:1, score:1, by_header:{}}` and requires positive per-kind temperatures and an object `by_header` (else `ModelUnsupportedError`). The v2 keys (`by_bucket`, `tau_k`, `noul_platt`, `bucket_clamp`) and `version` are passed through **unvalidated**: a non-numeric v2 value is not caught at load; it yields NaN probabilities, which `buildAnswer` silently turns into a uniform distribution (choice/score) or 0.5 (noul).

| key | version | meaning |
|---|---|---|
| `noul`, `choice`, `score` | v1 | per-kind temperature |
| `by_header` | v1 | `sha1(header)[:12]` -> tau (`headerKey`, pure-TS SHA-1, cached up to 4096 headers) |
| `by_bucket` | v2 | `"<kind>:<bucket>"` -> tau; buckets `K_BUCKETS` = 2, 3-5, 6-10, 11-30, 31-100, 101-255 (K > 255 uses `101-255`) |
| `tau_k` | v2 | `{choice:[a,b], score:[a,b]}`: tau = a + b·ln(max(K,2)), clamped to `bucket_clamp` (default `BUCKET_CLAMP` = [0.5, 5.0]) |
| `noul_platt` | v2 | `{a,b}`: p = sigmoid(a·z + b) |

Lookup order:
- choice/score: `by_header`, then `by_bucket`, then `tau_k`, then the per-kind value. The probabilities are a softmax of logits/tau.
- noul: `by_header` (as a = 1/tau, b = 0), then `noul_platt`, then (1/`noul`, 0).

`buildAnswer` (with `Precision` `"exact"`, the engine's default; `"round"` = 2 dp half-even like the Jev server). `EngineOptions.precision` exists, but `ModelBackend.createEngine` never sets it, so host answers are always `"exact"`:
- noul: `{noul: clip01(p)}`, where a non-finite `p` becomes 0.5;
- choice: `normalizeProbs` (clip, drop non-finite, renormalise, uniform if all zero). `choice` is the argmax (ties go to the first label), `confidence = clip01((K·pmax − 1)/(K − 1))`, and `probabilities` is in label order;
- score: `score = Σ i·p_i`, `confidence = max(0, 1 − Σ p_i·|i − mode| / MAD_uniform(K))`, `probabilities` keyed `"0".."n-1"`.

### 8. Dispose

`host.dispose()` cancels the idle scheduling and the hello and stall timers, and rejects the running job, queued jobs, `measure`s and `ready()` waiters with `ModelDisposedError`. It then closes the transport (worker: posts `dispose` then `terminate()`; inline: `backend.dispose()`), sets status `{state:"off"}`, notifies listeners once, and clears them. Every later call rejects with `ModelDisposedError`.

### When the default model URL 404s (the alpha today)

No runtime model is published, and none exists yet for `situation-v2`. The npm package `@genclass/runtime-model` has no `package.json` in `packages/runtime-model/` and is a 404 on the registry (checked by the lead, 2026-10-08); OPEN_TASKS "Next": Model package `@genclass/runtime-model@0.1.0` is still open, behind the v2 data, teacher, distillation and EVAL steps in HANDOFF. The published `@genclass/runtime@0.1.0-alpha.0` defaults to `guard`; `0.1.0-alpha.1` (`latest`) and this branch default to `observe`, which changes nothing below because nothing can act without a model. The script-tag build (not on npm yet) behaves the same, with `cdn/worker.js` from the asset base as the worker. The release procedure is in [RELEASE.md](../../../RELEASE.md). Traced through the code, a default `GenClass.init()` in a browser does the following.

1. The host is created with `preload: "idle"`, so the status is `off`. Until the idle start, triggers compute facts. A salient one calls `void this.ready`, which starts the load early, and runs the passive action.
2. The worker starts and posts `hello`. `doLoad` sets phase `card`, starts the WebGPU probe, and fetches `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/model.json` (`cache:"no-cache"`). The probe is not cancelled when the card fails: on a WebGPU-capable browser it still requests an adapter and creates and destroys a device; its result is discarded.
3. The fetch returns a 404, so `fetchCard` throws `ModelLoadError("model card download failed: HTTP 404 for <url>")`. The Cache Storage has no copy, so the error is rethrown. **No ORT bundle, ORT wasm, tokenizer or ONNX file is downloaded**, because those steps come after the card. The only network traffic is the worker chunk(s) and `model.json` (script tag: `cdn/worker.js` and its chunk from the asset base, no `cdn/ort-*.js`). If the request fails without a response instead (offline, CSP `connect-src` blocking jsDelivr, CORS), the message is `model card download failed for <url>: <fetch error message>` and the rest is identical. With `worker: false` or the inline fallback, the same happens on the main thread with `worker: false` in the status.
4. The backend emits `{state:"error", error:"model card download failed: HTTP 404 for https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/model.json", worker:true}`, with no `attempts` and no `gpu`.
5. Host: `retryOnWasm` returns false (no WebGPU attempt), so `setStatus(error)` runs and `ready()` waiters reject with `ModelLoadError`. The worker is **not** terminated; it stays idle until `dispose()`.
6. Runtime: the console shows `[GenClass] Model unavailable (model card download failed: HTTP 404 for https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/model.json); observing only.` (via `console.info`, only with `report: "console"`), and a `"status"` event fires. The devtools overlay shows "Model unavailable" with `observing only · <error>` (`packages/runtime/src/devtools/index.ts` -> `renderStatus`).
7. From then on `consultable()` is false. Every trigger and every delivery takes the passive action immediately; no situations, decisions or detections are produced, and nothing is held. Observers, tracing and baselines keep running.
8. `rt.ask()` / `rt.decide()` reject with `GenClassUnavailableError("error", "the model failed to load: ...")`. Exception: with `opts.timeoutMs` set, `ask` awaits `Promise.race([wait, to])` without wrapping, so the raw `ModelLoadError` propagates instead. The runtime caches its `ready` promise and has no public reload. Only a direct `createModelHost` user can call `host.load()` to retry. The next page load tries the card again.
9. To get decisions today, self-host a model directory and pass `model: { baseUrl }` (see [CLI](#cli-packagesruntimebingenclass-runtimemjs)). The CLI's default `--from` (the same jsDelivr directory) is a 404 too, so pass `--from` explicitly. Only the v0.1 development model (`https://github.com/MeharPro/GenClass/releases/download/v0.1.0/`, whether it serves a CLI-readable `model.json` is unverified) and the situation-v1 R17-final1 export (train VM only) exist; neither is trained on `situation-v2`, so their decisions are not meaningful for this runtime. Use them to exercise the loading machinery, not to evaluate behaviour.

### CLI (`packages/runtime/bin/genclass-runtime.mjs`)

```
genclass-runtime fetch-model <dir> [--from <baseUrl>] [--variant q8|fp16|all] [--force] [--quiet]
genclass-runtime info <dir>
```
- Flags: `--key value` or `--key=value`. `--force` and `--quiet` are booleans. `-h`/`--help` or no command prints usage. Unknown `--flags` are accepted silently (and consume the next argument as their value). Exit code 2 for a `UsageError` (unknown command, missing dir, flag without a value, variant not in the card), 1 for other errors (including a `--from` that is not an absolute URL, and any card error from the CLI's `parseCard`, which throws plain `Error`s) and for `info` finding missing or invalid files.
- No environment variables are read. Files are processed sequentially.
- **`fetch-model`** steps:
  1. `--from` defaults to `DEFAULT_FROM` = `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/` (= `DEFAULT_MODEL_BASE_URL`; before 2026-10-08 the GitHub release `runtime-model-v0.1.0`, still the default of the published `0.1.0-alpha.1` CLI). A trailing slash is ensured.
  2. `--variant` defaults to `all` and accepts a comma-separated list of card variant names.
  3. Fetches `model.json` (Node `fetch`, `redirect:"follow"`, user-agent `genclass-runtime-cli`) and parses it with a JS copy of `parseCard`.
  4. For the 3 role files and the chosen variants: a valid local copy is kept unless `--force` is given. A local copy is valid when it matches the card's sha256, or its size when the card has no hash. A card with neither always re-downloads.
  5. Downloads stream into `<file>.part-<pid>` with a per-file percentage on a TTY's stderr (only when the size is known; suppressed by `--quiet`). The size and sha256 are checked **before** the `rename` to `<file>`, so a bad file never replaces a good one; the part file is removed on any failure. `safeJoin` refuses paths outside `<dir>`. A failed download aborts the command before `model.json` is written.
  6. Scans each fetched variant's graph (`graphNote`) and prints a `warning:` line on stderr (`console.warn`, not silenced by `--quiet`) only when the graph has fp16 tensors but the card lacks `"needs": "shader-f16"`.
  7. Keeps variants from an earlier `model.json` with the same name and version that are still valid on disk.
  8. Writes `<dir>/model.json` in `genclass-runtime-model/1` format: `{format, name, version, license?, variants, files, source}`, with each file's actual `bytes` and `sha256`, and variants in source-card order.
- **`info`**:
  1. Prints `name version (license) [format]`.
  2. Checks every variant (marked `*` when it has `needs`) and role file: `MISSING` / `SIZE MISMATCH` / `SHA256 MISMATCH` / `sha256 ok` / `present (no hash in card)`.
  3. Prints `meta` (`max_len`, vocab count, merges count, markers) and the graph inputs and outputs.
  4. Scans each variant's ONNX graph (`scanOnnx`: a dependency-free protobuf walk counting fp16 initializers (dtype 10), int8 initializers (dtype 3), `Cast to=FLOAT16` nodes and fp16 constants, recursing into `If`/`Loop` bodies). Prints `graph <variant> <ops>; <fp16 summary>` with counts of `MatMulNBits`, `MatMul`, `Gather`, `GatherBlockQuantized`, `MatMulInteger`, `DynamicQuantizeLinear`, and a `WARNING` line when a graph uses fp16 but the card lacks `"needs": "shader-f16"` (the card rule). The warning does not change the exit code.
- The CLI's `parseCard` is a copy of `loader.ts` -> `parseCard` with two differences: `bytes` is only `Number(...)`-converted (not checked to be a non-negative integer), and errors are plain `Error`s rather than `ModelUnsupportedError`.

## Configuration and constants

| name | type | default / value | defined in | effect |
|---|---|---|---|---|
| `ModelOptions.baseUrl` | string | `DEFAULT_MODEL_BASE_URL` = `"https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/"` | `types.ts` / `host.ts` | model directory (holds `model.json`); resolved against `location.href` (`resolveBaseUrl`), trailing `/` added by `normalizeBaseUrl` in the backend |
| `ModelOptions.device` | `"auto"\|"webgpu"\|"wasm"` | `"auto"` | `host.ts` constructor | plan selection (see `planOrder`) |
| `ModelOptions.worker` | boolean | `true` | `host.ts` -> `start` | `false` = inline on the main thread |
| `ModelOptions.preload` | `"eager"\|"idle"\|"lazy"` | `"idle"` | `host.ts` constructor | when the load starts |
| `ModelOptions.ortWasmPaths` | string | jsDelivr `ortCdnBase(version)` = `https://cdn.jsdelivr.net/npm/onnxruntime-web@<v>/dist/` | `backend.ts` | prefix for the ORT `.wasm` (resolved against `location.href`). It must serve the file of the build in use: `ort-wasm-simd-threaded.wasm` when `ortBuild` is `"wasm"`, `ort-wasm-simd-threaded.asyncify.wasm` when `"webgpu"`. If our prefetch fails, ORT is given the same prefix as `env.wasm.wasmPaths` |
| `ModelOptions.cacheName` | string | `DEFAULT_CACHE_NAME` = `"genclass-runtime-v1"` | `loader.ts` | Cache Storage bucket |
| `ModelHostOptions.timeoutMs` | number | `DEFAULT_TIMEOUT_MS` = 10_000 | `host.ts` | per-request deadline (queued or running); `req.timeoutMs` overrides |
| `ModelHostOptions.maxQueue` | number | `DEFAULT_MAX_QUEUE` = 32 | `host.ts` | waiting requests (excluding the running one) |
| `ModelHostOptions.maxThreads` | number | 4 | `backend.ts` -> `configureOrt` | WASM thread cap (only with `crossOriginIsolated`, in a worker) |
| `ModelHostOptions.warmup` | boolean | `true` | `backend.ts` | `false` skips the warm-up (tests). Then `warmupMs` and `latency` are absent, so the runtime's automatic hold budget is 300 ms (`HOLD_FALLBACK_MS`) until it has its own samples |
| `ModelHostOptions.helloTimeoutMs` | number | `HELLO_TIMEOUT_MS` = 15_000 | `host.ts` | worker start-up budget before the inline fallback |
| `ModelHostOptions.loadStallMs` | number | `LOAD_STALL_MS` = 180_000 | `host.ts` | silence while loading = stuck worker |
| `ModelHostOptions.fetch` / `clock` / `workerFactory` / `ortLoader` / `probeGpu` | — | native fetch / `browserClock` / real Worker / dynamic import / `probeWebGPU` | `host.ts` | injection points (runtime passes `fetch`, `clock`; the script-tag build passes `workerFactory` = `blobModuleWorker(<base>cdn/worker.js)` and `ortLoader` = `import(<base>cdn/ort-*.js)`; tests pass the rest) |
| Script-tag model keys | string attributes / meta pairs | `data-model` / `model=` (URL, or `off`), `data-ort` / `ort=` -> `ortWasmPaths`, `data-device`, `data-preload`, `data-worker`; `data-base` = asset base | `src/cdn/config.ts` -> `fromPairs`, `fromDataset`; `src/cdn/global.ts` -> `install` | page-level `model` options for the CDN build (any `ModelOptions` also via `window.GENCLASS_CONFIG`) |
| CDN asset base | URL | `assetBase(script.src)`: jsDelivr/unpkg -> `<cdn>/@genclass/runtime@<__GENCLASS_VERSION__>/dist/`; elsewhere the script's directory; fallback `https://cdn.jsdelivr.net/npm/@genclass/runtime@<version>/dist/` | `src/cdn/global.ts` | where `cdn/worker.js`, `cdn/ort-*.js` and `devtools/index.js` load from |
| CDN threaded glue | file | `ort-wasm-simd-threaded.asyncify.mjs` (webgpu) / `ort-wasm-simd-threaded.mjs` (wasm), under `ortWasmPaths` or `https://cdn.jsdelivr.net/npm/onnxruntime-web@<version>/dist/` | `src/cdn/ort-env.ts` -> `prepareOrt` | only in a `crossOriginIsolated` worker, when `wasmPaths` is unset |
| `BackendLoadOptions.sessionTimeoutMs` | `{webgpu?, wasm?}` | webgpu 60_000, wasm 180_000 | `backend.ts` -> `createEngine` | session-creation timeout; **not settable through the host** |
| `IDLE_TIMEOUT_MS` | ms | 2_000 (`requestIdleCallback` timeout); fallback timer `IDLE_TIMEOUT_MS / 2` = 1_000 | `host.ts` | idle preload |
| `LOAD_EVENT_WAIT_MS` | ms | 5_000 | `host.ts` | idle preload waits at most this long for `load` |
| `LATENCY_WINDOW` / `LATENCY_EMIT_MS` | n / ms | 20 / 5_000 | `host.ts` | `status.latency` window / notify rate |
| `PROGRESS_STEP_MS` | ms | 100 | `backend.ts` | progress status throttle |
| ORT env and session settings | — | `env.wasm.numThreads` = threads, `env.wasm.proxy = false`, `env.logLevel = "error"`; `InferenceSession.create(bytes, { executionProviders: [device], graphOptimizationLevel: "all" })` | `backend.ts` -> `configureOrt`, `createEngine` | fixed; not configurable |
| fetch cache modes | — | card: `cache: "no-cache"` (revalidate); every other file: `cache: "no-store"` | `loader.ts` -> `fetchCard`, `fetchFile` | Cache Storage is the only cache for model and wasm files |
| `Engine` defaults | — | `precision` `"exact"`; `name` = `"<card.name>@<card.version>"` (set by the backend; becomes `EvaluateOk.model`); `device` `"wasm"`, `variant` `"q8"` when not given | `engine.ts` constructor | host answers are never rounded |
| `headerKey` cache | number | cleared when it exceeds 4096 headers | `calibrate.ts` | SHA-1 cost per header |
| `ORT_FALLBACK_VERSION` | string | `"1.30.0"` | `backend.ts` | CDN path if ORT reports no version |
| `ORT_WASM_FILES` | record | `webgpu: "ort-wasm-simd-threaded.asyncify.wasm"` (27 MB, 5.5 MB br), `wasm: "ort-wasm-simd-threaded.wasm"` (14 MB, 3.1 MB br) | `backend.ts` | wasm file per ORT build (sizes from code comments) |
| `probeWebGPU` `timeoutMs` | ms | 5000 each for `requestAdapter` and `requestDevice` | `loader.ts` | probe never throws |
| `CARD_FORMAT` | string | `"genclass-runtime-model/1"` | `loader.ts`, CLI | card format tag |
| cache headers | string | `x-genclass-sha256`, `x-genclass-tag` | `loader.ts` (`H_SHA`, `H_TAG`) | cache-entry validity |
| `meta.max_len` -> `Packer.maxPositions` | number | 1536 if absent | `engine.ts`, `packer.ts` | positions budget (final round 1 trained with `--max-len 2048`, `training/launch_final1.sh`; the scaled-program launch scripts `launch_t150.sh` (teacher), `launch_student.sh` and `launch_r68.sh` also pass `--max-len 2048`, so their exports should declare 2048) |
| `meta.max_total` -> `Packer.maxTotal` | number | 8192 if absent | `engine.ts`, `packer.ts` | whole-sequence budget |
| `Packer` `cacheSize` | number | 8192 texts (cleared when full) | `packer.ts` | encode cache |
| `Tokenizer` `cacheSize` | number | 20000 words (cleared when full) | `tokenizer.ts` | BPE word cache |
| `ID_SPACE` | number | 2^26 | `tokenizer.ts` | max token id + 1 allowed |
| `MAX_ARRAY_SEGMENTS` | number | 64 | `serialize.ts` | array state items before `[64:]` overflow |
| `DEFAULT_NOUL_INSTR` / `DEFAULT_CHOICE_INSTR` / `DEFAULT_SCORE_INSTR` | string | `"Is the statement true of the state?"` / `"Which option best fits the state?"` / `"Which level best describes the state?"` | `serialize.ts` | header when instructions are empty |
| `K_BUCKETS` / `BUCKET_CLAMP` | — | `[2,2],[3,5],[6,10],[11,30],[31,100],[101,255]` / `[0.5, 5.0]` | `calibrate.ts` | v2 calibration |
| CLI `DEFAULT_FROM` | string | `"https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/"` | `bin/genclass-runtime.mjs` | `fetch-model` source (= `DEFAULT_MODEL_BASE_URL`) |
| Runtime-side (context only) | — | default mode `"observe"` (`runtime.ts`, `o.mode ?? "observe"`); `DeciderQueue` `PROVIDER_TIMEOUT_MS` 10_000, `MAX_QUEUE` 32, answer cache 64 entries / 30 s (`CACHE_MAX`, `CACHE_TTL`); `BACKGROUND_DEADLINE_MS` 5000; `LATE_REVERT_MS` 2000; hold budget `HOLD_MIN_MS`..`HOLD_MAX_MS` = 150..800 ms (fallback `HOLD_FALLBACK_MS` 300); `STATE_CHAR_BUDGET` 2400, `COMPACT_BUDGET` 1100, `MIN_BUDGET` 500 (`situation/serialize.ts`) | `decide/decider.ts`, `runtime.ts`, `decide/policy.ts`, `situation/serialize.ts` | see [decide-policy-actions.md](./decide-policy-actions.md), [learn-situation-triage.md](./learn-situation-triage.md) |

Only `baseUrl`, `device`, `worker`, `preload`, `ortWasmPaths` and `cacheName` are typed on `InitOptions.model` (`ModelOptions` in `types.ts`). `makeHost` spreads the object into `createModelHost`, so other `ModelHostOptions` keys pass through at runtime but are not typed for `GenClass.init`.

## Invariants and gotchas

- **Parity with Python is load-bearing.** The model was trained on text from `jev_local/serialize.py` (via the sim's JSON rows) and the Python `Packer`. Changing any of the following changes what the model sees and needs retraining plus a new situation tag (the current freeze is `situation-v2`; HANDOFF: "coordinate before touching it"). Coordinate with TRAIN and SIM (see [training.md](../training.md), [sim.md](../sim.md)):
  - rendering in `serialize.ts` or `pyutil.ts` (number formatting, whitespace, separators, `True`/`None`, `[SEP]` placement);
  - BPE behaviour;
  - the packer layout (position restarts, groups, marker choice).
- **Per-header calibration is keyed on the exact instruction text** (`sha1(header)[:12]`). Rewording a standing question in `packages/runtime/src/situation/questions.ts` silently falls back to bucket or kind temperatures. v2 added a new header, `ACTION_INSTRUCTIONS.delivery` ("What should the runtime do with this response or message?"), and per-trigger action descriptions (`TRIGGER_DESCRIPTIONS.delivery`): a v1 calibration file has no `by_header` entry for it.
- **The default mode does not reduce model traffic.** In `observe` (the default since f3636b2) every salient situation is still evaluated, in the background; it only never waits. Since 054da38 that includes `delivery` (released to the app at once, decided afterwards; the decision cannot act, so it records `executed: false` unless the model's top choice was the passive action itself, `runtime.ts` -> `onDecision`), so `observe` sends the host more requests than before, not fewer. Turning the model off needs `model: false` (script tag: `data-model="off"`) or the kill switch.
- **JS cannot emit Python float literals** like `25.0` (`pyNumber(25)` = `"25"`). That is why training/NEEDS.md item 8 asks the curriculum to write integral floats as ints.
- **The public `stateText`** (`packages/runtime/src/situation/serialize.ts`, used by `explain()`) is a human rendering (indented list items). It is *not* the token text: the packer uses `model/serialize.ts` -> `segmentText` with `[SEP]` between segments. `model/serialize.ts` also has a `stateText`, which is internal.
- **Nothing about the vocabulary is hardcoded.** Marker, CLS and SEP ids come from `meta.json` (checked) or `tokenizer.json`, so pruned vocabularies (16,364 tokens, markers 16359-16363) work unchanged. Keep it that way (CONTRACT §13).
- **Graph contract:**
  - The session's inputs must equal `meta.inputs` as a set, and each must be a key of `FEEDS`.
  - Every `meta.outputs` entry must be a graph output, and at least one must be a known head.
  - A question kind without its head fails per request with `ModelUnsupportedError`; the load still succeeds.
- **One inference at a time**, enforced in two places: the host (`running`) and `Engine.serial`. A request that times out while running keeps the slot. A forward pass that never returns therefore blocks every later request, which all time out, and there is no watchdog after load. The runtime's `DeciderQueue` also runs one at a time, so in practice the host queue holds at most a few jobs.
- **Worker vs inline differences:**
  - Inline runs on the main thread (jank) and always uses 1 WASM thread: ORT pthreads would start from the app bundle URL.
  - Inline does not structured-clone, so `questions` containing functions work inline but fail in the worker with `ModelInputError`.
  - Inline WebGPU timeouts do not stop the remaining plans.
- **The worker and the onnxruntime threads:** `worker.ts` must stay inert when `self.name` starts with `em-pthread` or equals `ort-wasm-proxy-worker`. Removing that guard spawns nested backends.
- **`hello` is posted before ORT is imported** (ORT is a dynamic import on `load`). The 15 s hello timeout therefore only covers fetching and evaluating the worker chunk (for the script tag: the cross-origin `cdn/worker.js` and its chunk, imported from the Blob URL).
- **CDN worker ordering:** `src/cdn/worker.ts` registers its `message` listener after `src/model/worker.ts`'s; both run synchronously on the `load` message, and ORT is imported only after the card and the GPU probe, so `cdnState.ortWasmPaths` is set before `prepareOrt` runs. Importing ORT earlier (at module top, or before the first `await` in `doLoad`) would make `prepareOrt` miss a page's `data-ort`, and `prepareOrt` runs once per realm (at module evaluation), so a later `ortWasmPaths` is never picked up for the glue.
- **CDN self-hosting (`data-base`, `data-ort`):** the `dist/` directory must serve `genclass.global*.js`, `cdn/worker.js`, `cdn/ort-*.js`, the `cdn/chunk-*.js` they import (and `devtools/index.js` for the overlay), with CORS headers when on another origin than the page. A `data-ort` directory must hold both `.wasm` files and, for `crossOriginIsolated` pages, both threaded `.mjs` glue files (`ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.asyncify.mjs`). The CDN `worker.js` is not a drop-in for `dist/worker.js` (and vice versa): one bundles ORT, the other imports bare `onnxruntime-web` specifiers.
- **The asset version must exist on the CDN.** `assetBase` pins jsDelivr/unpkg URLs, and the no-script-URL fallback, to `__GENCLASS_VERSION__` (the `package.json` version at build time). This branch's `package.json` still says `0.1.0-alpha.1`, which is on npm from 806a296 without `dist/cdn/` or the global builds. So a local build whose base resolves to jsDelivr (the fallback, e.g. when `findScript` finds no tag) loads `.../@genclass/runtime@0.1.0-alpha.1/dist/cdn/worker.js`, which 404s: the worker errors before `hello`, the inline `ortLoader` 404s too, and the load ends in `error` (observe only). Bump the version before testing against or publishing to the CDN; npm refuses a republish of `0.1.0-alpha.1` anyway.
- **Stall vs session timeout:** `LOAD_STALL_MS` (180 s) equals the WASM session timeout (180 s), and no status is posted during session creation. On a very slow WASM session the host's stall watchdog and the backend's step timeout fire at about the same time.
- **The WASM retry happens once per host lifetime** (`wasmRetried` is never reset).
- **A worker crash after `ready` is usually permanent for the runtime.** A worker `error`/`messageerror` event after `hello` moves `ready` -> `error` (`onWorkerCrash`), rejects the running job with `ModelLoadError` and queued jobs with `ModelNotReadyError`. The runtime never calls `host.load()`, and triggers stop consulting in `error`. The one exception: `RuntimeImpl`'s `ready` getter calls `decider.ready()` only on its first read and caches the promise. If nothing had read `rt.ready` before the crash (no salient trigger while `off`, no `rt.ask()` while not ready, no app read), the first `rt.ask()`/`rt.decide()` or app read of `rt.ready` afterwards calls `host.ready()`, which starts a fresh worker because `started` was reset. Otherwise the runtime observes only until the page reloads.
- **`warmupMs` is the first warm-up pass; `status.latency` is the second on WebGPU.** The first WebGPU pass includes pipeline compilation, and the runtime seeds its automatic hold budget from `status.warmupMs` (`decide/policy.ts` -> `holdBudget`: clamp(1.5 × warmupMs, 150, 800)) until the decider queue has real latency samples. On WebGPU the seed is therefore pessimistic (likely the 800 ms cap; not measured).
- **After a load error the worker stays alive** (only a crash closes the transport), so `load()` can retry cheaply. After a crash `started` resets, so `ready()`/`load()` (and also `evaluate()`/`measure()`, which call `start()` while not ready) start a fresh worker.
- **The card is revalidated on every load** (`cache:"no-cache"`): one network request per page load, even when everything else is cached. Offline, the cached card is used.
- **Cache validity:**
  - Files with a card sha256 are valid when the stored `x-genclass-sha256` header matches (and the size matches when known).
  - Files without a hash (v0.1 extension card, ORT wasm) are valid when the `x-genclass-tag` header matches: `name@version` for model files, `onnxruntime-web@<version>` for the wasm. So a changed file under the same version is not refetched.
  - Invalid entries are deleted and refetched. **Old versions are never evicted** (they live under other URLs in `genclass-runtime-v1`).
  - Quota errors on `cache.put` and missing or blocked Cache Storage degrade to network-only. An opaque or non-200 **cached** entry is treated as invalid (deleted and refetched). An opaque **network** response is not a degradation: `fetchFile` throws `ModelLoadError("download of <url> returned an opaque (no-CORS) response")`.
- **Downloads are not retried** within a load. A failed variant download is memoised, so every plan that uses that variant fails in the same load. A new `load()` starts over (cached valid files are reused).
- **Integrity failures surface as `load_failed`**, not `integrity`, at the host. Small files: the `ModelLoadError` message carries the checksum or size text. Variants: the text is in `attempts[].error`.
- **Never use the instrumented fetch.**
  - The worker uses its own realm's `fetch`, and the inline path uses `NATIVE_FETCH`, so GenClass never observes its own downloads.
  - The ORT wasm is prefetched and handed over as `wasmBinary` so ORT never fetches it (offline second loads).
  - Worker `error` events are `preventDefault`ed so they never reach the app's error handlers.
- **Thread count:** WASM threads need a `crossOriginIsolated` page (COOP/COEP) *and* the worker transport: `min(maxThreads ?? 4, hardwareConcurrency)`. The runtime's automatic situation budget grows with `status.threads`.
- **Self-hosting needs three things served:** the model directory (`baseUrl`), the worker chunk next to the host chunk (bundler output; for the script tag, `dist/cdn/*` under the asset base, see the CDN bullets above), and the ORT wasm (`ortWasmPaths`, default jsDelivr). Which wasm is fetched depends on the plans: `ort-wasm-simd-threaded.wasm` when no WebGPU plan exists (e.g. `device: "wasm"`, no `navigator.gpu`, software adapter under `"auto"`), else `ort-wasm-simd-threaded.asyncify.wasm`. Serve both. The model files and the wasm are `fetch`ed, so a Content-Security-Policy whose `connect-src` blocks their origin makes the load fail and the runtime observe only; a blocked worker script only triggers the inline fallback (which policy governs the worker's own fetches depends on how the worker script is served; no test covers CSP).
- **`host.stats` is the live counters object**, typed `Readonly` but mutated in place; copy it if you need a snapshot.
- **The v0.1 q8 needs `shader-f16` on WebGPU** (its embedding table is fp16; ORT's WebGPU Gather fails with "Program Gather requires f16"), but its card does not say so. The loader then wastes a `webgpu+q8` session and warm-up before WASM. TRAIN's exports use an int8 embedding table and declare `needs: "shader-f16"` only on fp16. Check with `genclass-runtime info`.
- **Bundling:**
  - tsup keeps `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` verbatim; Vite and webpack 5 bundle that pattern.
  - Both `import("onnxruntime-web/webgpu")` and `import("onnxruntime-web/wasm")` must stay **static string specifiers** so bundlers split them into separate chunks and a page downloads only one. The CDN build depends on this too: the `genclass-cdn-ort` plugin's `onResolve` filter (`/^onnxruntime-web\/(webgpu|wasm)$/`) only rewrites those exact specifiers; any other ORT import in `src/model/` would be bundled into `dist/cdn/worker.js` directly (or, in the iife, left as an unresolvable bare import).
  - `onnxruntime-web/wasm` is missing from `tsup.config.ts` `external`. It stays external only because `onnxruntime-web` is a `dependency` (tsup externalises dependencies including subpaths). The local `packages/runtime/dist/` from the 2026-10-08 tsup build on this branch (untracked build output) keeps both `import('onnxruntime-web/webgpu')` and `import('onnxruntime-web/wasm')` as dynamic imports in `dist/worker.js` and in the chunk that `dist/index.js` re-exports `createModelHost` from (which also holds the `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` pattern).
- **Determinism:** the host uses the injected `Clock` for timers. `scheduleIdle` uses the global `requestIdleCallback` and `load` event. The sim's default modes plug in their own `decider` and never touch the host, but the `--on-policy` (DAgger) mode runs the real host inline in Node (`sim/src/run/onpolicy.ts`; it passes no `clock`, so the host's timers use `browserClock`, and `preload: "eager"` bypasses `scheduleIdle`). A change to `host.ts`, `backend.ts`, the loader, packer or calibration therefore also changes on-policy data generation; rebuild `sim/dist/model-host` (`npm run build:model-host` in `sim/`) after one.

## How to change it safely

Run policy: HANDOFF.md's "never run npm/tsc/vitest on the Mac" rule is about the colleague's 8 GB Mac. On other machines agents may run light local checks (`npm ci`, `tsc`, `tsup`, vitest unit tests, including `test/model/*`). Ask the user before model downloads (`fetch-model`), Playwright specs, `smoke.sh`, or anything on Azure ([build-test-release.md](build-test-release.md#where-to-run-things)). Model-file tests read `GENCLASS_MODEL_DIR` (default `<repo>/.cache-model`) and **skip** when it is absent: these are the 14 skipped tests of the unit run (`npx vitest run` in `packages/runtime` on `mvp-v2-merge`, 2026-10-08: 379 passed + 14 skipped in 46 files, `test/install/cli.test.ts` included; one of three full parallel runs had a single failure that did not reproduce, consistent with timing-sensitive tests: CI runs `review-perf.test.ts` alone with `--retry=2`). Unit tests with fakes always run, and CI (`.github/workflows/ci.yml`, b435acb) runs them on every push to `main`/`runtime`/`mvp`/`mvp-v2` and on pull requests, without a model directory and without Playwright, so CI never exercises a real ONNX model.

```sh
node packages/runtime/bin/genclass-runtime.mjs fetch-model ~/gcl-cache/model-v0.1 --from https://github.com/MeharPro/GenClass/releases/download/v0.1.0/
cd packages/runtime
GENCLASS_MODEL_DIR=~/gcl-cache/model-v0.1 npx vitest run test/model
GENCLASS_MODEL_DIR=~/gcl-cache/model-v0.1 npx playwright test --config test/browser/playwright.config.ts
```
(The commands come from `packages/runtime/src/model/README.md`. Whether that GitHub release serves a `model.json` the CLI can read is unverified.)

1. **Point at a published model / bump the model version.** (Release procedure: [RELEASE.md](../../../RELEASE.md).)
   - Edit `DEFAULT_MODEL_BASE_URL` in `host.ts` and `DEFAULT_FROM` in the CLI.
   - Update `docs/runtime/CONTRACT.md` §2/§10, `docs/runtime/API.md`, `packages/runtime/README.md`, `packages/runtime-model/MODEL_CARD.md`.
   - New URLs or hashes refetch automatically; old cache entries remain.
   - Run `genclass-runtime info <dir>` on the published directory (card rule, hashes).
   - Tests: `test/model/host.test.ts` (uses its own base URL; no change expected), the browser specs against the new directory.
2. **Ship a different model architecture (R17 vs R32, new export).** No code change is needed if the export follows the card format and `meta.json` declares `inputs`, `outputs`, `markers`, `cls_id`, `sep_id`, `max_len`, `max_total`.
   - Make sure `max_len` matches training (2048 for the stage-2 pilot, final round 1 and the scaled-program launch scripts).
   - Make sure it was trained on `situation-v2` data (the card cannot tell; check `training/EVAL.md` / the export's provenance).
   - Keep the q8 embedding table int8 so `webgpu+q8` works without `shader-f16`.
   - Device-based model selection (OPEN_TASKS "Next": Model package `@genclass/runtime-model@0.1.0` (+ device-based selection): R17 for WASM, R32 for WebGPU only if clearly more accurate, "Device-based model selection in the host card") is **not implemented**. It would need card support (e.g. variants per device) plus a `planOrder` change and tests in `loader.test.ts`.
3. **Add a graph input or head.**
   - Add a builder to `FEEDS` (`engine.ts`), and a plan field in `planInputs` if needed.
   - For a new head, add it to `OUTPUT_KIND`, a `BlockKind`, `questionBlock`, `itemMarkers`, `unpackLogits`, `calibrateLogits` and `buildAnswer`, and the `Question`/`Answer` types in `types.ts`, which form the CORE<->MODEL seam ("change that section only together").
   - Tests: `engine.test.ts` ("engine graph contract"), `packer.test.ts` (feed plan).
4. **Change the WebGPU/WASM plan order or device semantics.**
   - Edit `planOrder` (loader.ts). The `ortBuild` choice follows automatically.
   - Keep `wasm` as the last plan for `"webgpu"`.
   - Tests: `loader.test.ts` "plans: ..." and "ModelBackend load"; `host.test.ts` "WebGPU recovery"; `test/browser/model-webgpu.spec.ts`.
5. **Add a host option.**
   - Add it to `ModelHostOptions`. If it must reach the worker, also add it to `BackendLoadOptions` (structured-cloneable values only) and set it in the `Host` constructor's `loadOptions`.
   - If apps should set it through `GenClass.init`, add it to `ModelOptions` in `types.ts` (CORE-owned) and document it in CONTRACT §2 and API.md. Example: exposing `sessionTimeoutMs` needs all three.
6. **Add a protocol message.**
   - Update `protocol.ts`, `worker.ts`'s switch, `InlineTransport.send` (keep both paths identical) and `Host.onMessage`.
   - Every request must get exactly one `result`.
   - Tests: `host.test.ts` with `FakeWorker`.
7. **Add or change an error.**
   - Update `ModelErrorCode`, the class, and the `deserializeError` switch (otherwise it comes back as a plain `Error`).
   - Re-export it from `src/index.ts` and `src/model/index.ts`.
   - If the runtime should react specially, see the `max_tokens_exceeded` handler in `runtime.ts`.
   - Tests: `host.test.ts` "errors cross the worker boundary".
8. **Change serialization, tokenization, packing or calibration.**
   - Only together with the Python side (`jev_local/serialize.py`, `tokenize_pack.Packer`, `calibrate.py`, `confidence.py`), TRAIN and SIM.
   - Regenerate the fixtures with `packages/runtime/test/fixtures/model/make_py_fixtures.py`, which needs HF `tokenizers` and runs on the VM.
   - Run `serialize.test.ts`, `packer.test.ts`, `calibrate.test.ts`, and `engine.test.ts` with a model directory.
   - Expect a model retrain.
9. **Upgrade onnxruntime-web.**
   - Update `package.json` (`^1.30.0`) and `ORT_FALLBACK_VERSION`.
   - Check `ORT_WASM_FILES` names exist in the new `dist/` (`node_modules/onnxruntime-web/package.json` exports `./wasm`, `./webgpu` and the `.wasm` files) and that `tsup.config.ts` externals still apply.
   - Update the browser test regex expecting `onnxruntime-web@1.30.x`, and `onnxruntime-node` in devDependencies (pinned `1.30.0`) for parity tests.
   - CDN build: `dist/cdn/ort-*.js` bundle whatever version the lockfile installs, and the default wasm and threaded glue follow `env.versions.web`, so they stay matched. Check that the glue names in `src/cdn/ort-webgpu.ts` / `ort-wasm.ts` (`prepareOrt` argument) still exist in the new `dist/`, that ORT still accepts `env.wasm.wasmPaths = { mjs }`, and rerun `test/install/cdn-check.mjs` (crossOriginIsolated case) on the VM.
   - Re-measure latency and transfer (Playwright writes `test-results/model-bench/{latency,transfer}.json`).
10. **Change the CLI.** Keep its `parseCard` in sync with `loader.ts` `parseCard` (same file-name safety rules and defaults). `test/install/cli.test.ts` covers only `init` / `remove` and the page config; there are no automated tests of `fetch-model` / `info`: verify on the VM against a real directory. Keep the `init` / `remove` dispatch in `main` ahead of `parseArgs`.
11. **Self-host everything (app integration; derived from the code).**
    - `npx genclass-runtime fetch-model public/genclass-model --from <a directory URL that serves model.json>`.
    - Copy **both** `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm` and `ort-wasm-simd-threaded.asyncify.wasm` to e.g. `public/ort/` (the plain one is used when no WebGPU plan exists, the asyncify one otherwise).
    - `GenClass.init({ model: { baseUrl: "/genclass-model/", ortWasmPaths: "/ort/" } })`. For WASM threads, serve the page with COOP/COEP so it is `crossOriginIsolated`.
    - Check: `status.ortBuild`, `status.threads`, `status.fromCache`, and that the network panel shows no jsDelivr requests.
    - Script tag instead of a bundler: serve the package's `dist/` (at least `genclass.global.min.js`, `cdn/`), then `<script src="/genclass/genclass.global.min.js" data-model="/genclass-model/" data-ort="/ort/"></script>` first in `<head>` (a non-CDN `src` makes the script's directory the asset base; `data-base` overrides it). For WASM threads also copy `ort-wasm-simd-threaded.mjs` and `ort-wasm-simd-threaded.asyncify.mjs` into `/ort/`.

12. **Change how the CDN build loads the worker or ORT** (`src/cdn/global.ts` -> `withCdnModel` / `blobModuleWorker` / `assetBase`, `src/cdn/worker.ts`, `src/cdn/ort-*.ts`, `tsup.config.ts` CDN entries; coordinate with INSTALL).
    - Keep `src/model/*` free of CDN knowledge: the CDN side only uses `workerFactory`, `ortLoader` and the `load` message's `ortWasmPaths`. A new load option the CDN worker needs must still go through `BackendLoadOptions`.
    - After `npx tsup` in `packages/runtime`, check that `dist/cdn/worker.js` contains `import('./ort-webgpu.js')` and `import('./ort-wasm.js')` and no bare `onnxruntime-web` import, and that `dist/genclass.global.js` contains no onnxruntime-web code (only the external bare `import("onnxruntime-web/...")` of the unused default loader).
    - Tests: `test/install/cli.test.ts` "page config" (`assetBase`, `fromPairs`) runs with vitest; the browser check is `node test/install/cdn-check.mjs` (headless Chromium via Playwright, needs a model directory; VM only, ask first).

## Tests

| test file | what it asserts |
|---|---|
| `packages/runtime/test/model/host.test.ts` | Uses a `FakeWorker` and `FakeClock`. Asserts:<ul><li>lazy preload (evaluate fails open with `not_ready` and starts the load; `ready()` loads)</li><li>idle preload via the timer fallback</li><li>status listeners and `ready()` rejecting with `ModelLoadError` and attempts</li><li>one-at-a-time priority/FIFO order</li><li>queued timeouts are never run, and a running timeout keeps the slot</li><li>full-queue eviction (`ModelBusyError`)</li><li>`status.latency` nearest-rank values and the 5 s notify throttle</li><li>typed errors across the boundary</li><li>state JSON normalisation; `measure`; `dispose`</li><li>a crash after `ready` with a request running rejects it with `ModelLoadError`, becomes an error status, and `load()` makes a fresh worker</li><li>WebGPU recovery: error with a webgpu attempt, death on webgpu, and stall all lead to one WASM-only worker, or an error on WASM</li><li>inline fallback: factory throws, error before hello, hello timeout, `worker:false`</li></ul> |
| `packages/runtime/test/model/loader.test.ts` | <ul><li>runtime and v0.1 card parsing; malformed cards and unsafe names</li><li>`planOrder` matrix (auto/webgpu/wasm × f16/no-f16/software/no GPU)</li><li>`fetchFile` streaming progress, sha256, store and cache hit</li><li>refetch on hash mismatch; size/hash corruption gives `ModelIntegrityError`; a missing file gives `ModelLoadError`</li><li>no Cache Storage and quota failures</li><li>`fetchCard` network vs offline cache</li><li>`ModelBackend` plan fallback, phases, monotonic progress, single ORT wasm fetch, `wasmBinary` released, answers, `measure`</li><li>second load needs only `model.json` from the network</li><li>v0.1 card</li><li>a WebGPU session timeout stops the remaining plans in a worker and continues inline</li><li>error status lists all attempts</li></ul> |
| `packages/runtime/test/model/engine.test.ts` | <ul><li>parity vs PyTorch on the 50 harness requests: onnxruntime-node q8/fp16 and onnxruntime-web WASM q8 (12 requests); against the export's `parity.json` when present. Needs `GENCLASS_MODEL_DIR`</li><li>graph contract: feeds exactly the declared inputs, rejects unknown or mismatched inputs, a missing head gives `ModelUnsupportedError`</li></ul> |
| `packages/runtime/test/model/packer.test.ts` | <ul><li>identical ids, positions, groups and marker positions vs Python</li><li>plain-object vs Map criteria</li><li>special tokens in text stay text</li><li>marker ids from the files, and a meta/tokenizer mismatch throws</li><li>`max_tokens_exceeded` semantics (positions vs total)</li><li>empty choices rejected</li><li>feed plan and unpacking</li><li>tokenizer parity on the full and pruned vocabularies</li><li>encode speed</li></ul> |
| `packages/runtime/test/model/calibrate.test.ts` | <ul><li>SHA-1 header keys vs Python</li><li>SHA-256 (pure TS and WebCrypto) at edge lengths</li><li>calibrated probabilities vs PyTorch (< 1e-9)</li><li>v1/v2 calibration files</li><li>confidence math</li><li>answer building (order, ties)</li><li>lookup and validation</li></ul> |
| `packages/runtime/test/model/serialize.test.ts` | <ul><li>`state_segments` / `question_block` vs Python fixtures</li><li>Python number formatting</li><li>`json.dumps` separators</li><li>`str.strip` whitespace</li><li>JSON round-trip semantics</li><li>situation-shaped states</li><li>`pyRound` half-even</li></ul> |
| `packages/runtime/test/browser/model.spec.ts` (Playwright, Chromium, built library) | <ul><li>WASM worker load, PyTorch parity, status events, Cache Storage second load, transfer sizes</li><li>inline fallback (no `Worker`, missing worker script, no page errors)</li><li>lazy (< 50 ms `not_ready`)</li><li>idle preload</li><li>WebGPU fallbacks (no adapter, an adapter without a device caught by the probe)</li><li>latency benches (1 and 4 threads)</li><li>the default ORT wasm path is jsDelivr `onnxruntime-web@1.30.x`</li></ul> Skipped without a model directory. |
| `packages/runtime/test/browser/model-webgpu.spec.ts` | On SwiftShader WebGPU: `webgpu+q8` without `shader-f16` runs or falls back; embedding variants (`GENCLASS_WEBGPU_VARIANTS`); exported models; `auto` skips a software adapter. |
| `packages/runtime/test/model/helpers.ts`, `test/browser/model-helpers.ts`, `test/fixtures/model/*` | `MODEL_DIR` resolution (both helpers: `GENCLASS_MODEL_DIR`, default `<repo>/.cache-model`). Fixture selection in the Node helpers (`test/model/helpers.ts`): from the model directory when the export ships `requests.json`/`pack_fixtures.json`/`torch_fixtures.json` (plus `parity.json` for `exportParity`), else the v0.1 set in `test/fixtures/model`. The browser helpers always read the v0.1 set (`requests50.json`, `pack_fixtures.json`, `torch_fixtures.json`). Generators: `make_py_fixtures.py`, `make_webgpu_variants.py`. |
| `packages/runtime/test/browser/build.mjs`, `server.mjs`, `playwright.config.ts`, `page/*` | Test infrastructure, no assertions of its own. `build.mjs` (Playwright global setup) builds the library with `npx tsup` (falls back to building `src/model/index.ts` + `worker.ts` alone into `.build/dist` when a tsup entry file is missing, the package build fails, or `dist/index.js` does not mention `createModelHost`), bundles a test app with esbuild, and throws unless a built file contains the `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` pattern, `worker.js` exists, and the worker code holds both `import("onnxruntime-web/webgpu")` and `import("onnxruntime-web/wasm")`. `server.mjs` serves the app, `/model/` (`GENCLASS_MODEL_DIR`), `/ort/` (onnxruntime-web's `dist/`, so both wasm files), extra models at `/m/<name>/`, and the same under `/coi/` with COOP/COEP headers for WASM-thread tests. |
| `packages/runtime/test/install/cli.test.ts` (vitest, runs in CI) | Mostly INSTALL (`init` / `remove` on fixture projects, edit helpers). Model-relevant: "page config" (`fromPairs` / `parsePairs` of meta content and data attributes, including model keys) and `assetBase` (jsDelivr/unpkg URLs pinned to the build's version, `@latest` and unversioned included; other hosts use the script's directory; `null` -> jsDelivr fallback). |
| `packages/runtime/test/install/cdn-check.mjs` (+ `server.mjs`; not vitest, not CI) | Headless Chromium (Playwright) after `npx tsup`, with `GENCLASS_MODEL_DIR` (default `~/gcl/model/.cache-model`). Page on `http://localhost:A`, "CDN" on `http://127.0.0.1:B` with CORS. Checks: the model gets ready in the Blob-URL module worker and `decide()` answers through it; a crossOriginIsolated page gets ready with WASM threads in the worker (the check asserts `threads > 1`; RESULTS.md reports 4 threads and the glue preloaded from the ORT directory); CSP `worker-src 'none'` -> inline fallback loads ORT from the CDN; an unversioned jsDelivr URL pins the worker to the build's version; default URLs; kill switch; `data-manual`; meta + `GENCLASS_CONFIG`; the tag twice; `/auto` bundled by esbuild; SSR. Last recorded result 26/26 (`test/install/RESULTS.md`, Mehar's VM run; not rerun here). |
| `packages/runtime/test/smoke/smoke.sh` | npm tarball in a fresh Vite app. Uses `model: false`, so it does **not** exercise the model host. |
| `packages/runtime/test/atoms.test.ts` (runtime side) | "provider errors (not ready, too many tokens, timeout, busy) fail open at once": a decider throwing an error with `code` `not_ready` / `max_tokens_exceeded` / `timeout` / `busy` lets the write apply immediately, with no decision and no hold. |
| `packages/runtime/test/default-mode.test.ts` (runtime side, f3636b2) | `createRuntime()` and `GenClass.init()` without a mode start in `observe`; `guard` is opt-in (option or `?genclass=guard`); observe never holds writes or requests even when the model is sure, and with a decider that never answers nothing is delayed. `test/helpers.ts` -> `setup()` defaults to `mode: "guard"`, so the other runtime tests keep testing guard behaviour. |
| `packages/runtime/test/budget.test.ts` (runtime side) | `"auto"` situation budget from the model status (webgpu 2,400; wasm 1,000 at 1 thread to 2,000 at 4 threads); section limits full at 2,400; `max_tokens_exceeded` shrinks later automatic budgets; hold budget = clamp(1.5 × median latency, or the warm-up time before any, 150, 800), else 300; held requests carry `timeoutMs` = the time left. |

Environment variables of the model tests: `GENCLASS_MODEL_DIR` (model directory; default `<repo>/.cache-model`; model-file tests skip without it), `GENCLASS_WEBGPU_VARIANTS` (embedding variants for `model-webgpu.spec.ts`), `GENCLASS_BENCH_MODELS` (`name=dir,...`: extra model directories for the per-size latency bench and WebGPU tests), `GENCLASS_OFFLINE` (skips the test that loads the default ORT wasm from jsDelivr).

No test covers the default-URL 404 end-to-end, the CLI's `fetch-model` / `info`, the CDN build's `prefetchWasm` failure path (where `wasmPaths` replaces the `{ mjs }` glue override), the runtime's reaction to a host that goes `ready` -> `error` (the host side is covered in `host.test.ts`), or `ModelAbortedError`. The browser tests always serve both ORT wasm files, so a self-hosted `ortWasmPaths` missing one of them is not caught.

## Drift and open issues

Mismatches between docs and code (code wins):

- **The default model is not published, and no model matches the runtime.** CONTRACT §2 says `baseUrl` defaults to "CDN of `@genclass/runtime-model@<pinned>`". The code pins `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/`, but `packages/runtime-model/` has no `package.json` or `files/`, the npm package is a 404, and OPEN_TASKS "Next" (Model package `@genclass/runtime-model@0.1.0`) lists publishing as future work; see [RELEASE.md](../../../RELEASE.md). Result: observe-only (see the 404 flow above). The only trained export (R17-final1) is `situation-v1`; publishing it as-is would ship a model out of distribution for the v2 runtime.
- **Two different default model sources:**
  - host and CLI: jsDelivr npm (`DEFAULT_MODEL_BASE_URL`, and `DEFAULT_FROM` since 2026-10-08; before that the CLI defaulted to the GitHub release `runtime-model-v0.1.0`, which the published `0.1.0-alpha.1` CLI still does);
  - CONTRACT §10 and `src/model/README.md`: the dev v0.1 model at `https://github.com/MeharPro/GenClass/releases/download/v0.1.0/`.

  `packages/runtime/README.md` and API.md say "self-host a model with `npx genclass-runtime fetch-model`" with no `--from`. That default is the jsDelivr directory, a 404 until `@genclass/runtime-model@0.1.0` is published; the `runtime-model-v0.1.0` release URL (alpha.1's default) is a 404 too and optional (RELEASE.md B5).
- CONTRACT §10 says "the worker imports `onnxruntime-web/webgpu`". The code imports `onnxruntime-web/wasm` when no WebGPU plan exists, and `/webgpu` otherwise (worker and inline). The same staleness is in `src/model/README.md` "Bundling" ("`dist/worker.js` imports `onnxruntime-web/webgpu`"; "the inline fallback's `import("onnxruntime-web/webgpu")`").
- CONTRACT §2 and `docs/runtime/API.md` list only `baseUrl`, `device`, `worker` and `preload` for `model`. `ModelOptions` in `types.ts` also has `ortWasmPaths` and `cacheName`. Host-only options (`timeoutMs`, `maxQueue`, `maxThreads`, `helloTimeoutMs`, `loadStallMs`, `warmup`) are untyped through `init`.
- CONTRACT §8 `DecisionProvider.evaluate(req)` lists `{trigger, state, questions}`. `EvaluateRequest` also has `priority`, `subject` (§13) and `timeoutMs`, which the host honours.
- `host.ts` -> `ModelHostOptions.workerFactory` is commented "Tests: create the worker", and `ortLoader` "Inline path". `workerFactory` is now a production injection point of the script-tag build (`src/cdn/global.ts` -> `withCdnModel`), as is `ortLoader` (correctly inline-only: the worker has its own `loadOrt`, which the CDN build rewrites at bundle time). Neither is typed on `ModelOptions`.
- `src/model/README.md` and CONTRACT §10 describe only the npm/bundler path (`dist/worker.js` + bare `onnxruntime-web` imports). The CDN path (Blob-URL worker, `dist/cdn/*`, bundled ORT, `prepareOrt`) is documented only in `src/cdn/*` comments, `packages/runtime/README.md`'s install section (one sentence: the tag loads the worker, ONNX Runtime Web and the overlay on demand from the same CDN version) and `test/install/RESULTS.md`.
- `src/cdn/global.ts` header comment says the onnxruntime-web wasm comes "from the jsDelivr onnxruntime-web package or `data-ort`"; with `window.GENCLASS_CONFIG.model.ortWasmPaths` or the `GenClass.init` argument it can come from elsewhere too (same option).
- `protocol.ts` comment: `hello` is "posted once when the worker module (and onnxruntime-web) finished loading". In fact ORT is imported later, on `load`.
- `host.ts` comment on `recordLatency`: "for status.latency (adaptive hold budgets and situation sizes)". No runtime code reads `status.latency`. The hold budget uses `DeciderQueue.latencies()` and `status.warmupMs`, and the situation budget uses `status.device`/`threads`.
- `MODEL_CARD.md`:
  - Its status line says final round 1 is "delivered (`files/r17/` here ...)", but `packages/runtime-model/` in git holds only `MODEL_CARD.md` (no `files/`). The export is on the train VM (`~/gcl/train-out/final1/`), not in the repo.
  - It says the runtime acts "only when `p(action) ≥ 0.9` (guard tier) / `0.8` (heal tier)". The gate uses the **summed** probability of the permitted actions (`decide/policy.ts`, CONTRACT §8). It also does not mention that the default mode is now `observe` (no action at all unless the app opts into `guard`).
  - Its diagnosis list omits `transient`, and its action list omits the v2 `delivery` trigger (`deliver` / `discard` / `defer`).
  - Its latency paragraph maps token counts to state budgets of 1,000 / 2,000 / 3,200 chars; the v2 full budget is 2,400 (`STATE_CHAR_BUDGET`). Its figures (R17 ≈ 190 / 340 / 610 ms, R32 ≈ 500 / 880 / 1,540 ms, "fitted over 184 requests") also differ from `docs/runtime/RESULTS.md` §2 (R17 177 / 323 / 589, R32 569 / 954 / 1,580).
  - It describes `calibration.json` as "per-kind temperatures", while the runtime also supports `by_header`, `by_bucket`, `tau_k` and `noul_platt`.
- HANDOFF.md "What this is" still says "observe -> guard (default; ...)". Since f3636b2 on this branch the default is `observe` (CONTRACT §13, `runtime.ts`). The older published npm alpha.0 defaults to `guard`; alpha.1 (`latest`) defaults to `observe`.
- CONTRACT §10 refers to `/Users/meharkhanna/jev/extension/genclass/src/` (another machine). In this repo the v0.1 card is `extension/src/model/model.json`.
- CONTRACT §2 comments `device` as "default auto (webgpu+fp16 if shader-f16, else wasm+q8)". `planOrder` also tries `webgpu+q8` between them, and `"auto"` skips software (fallback) adapters.
- CONTRACT §2 says `preload: "lazy"` downloads "only when the first salient situation appears", and §10 says "on the first `evaluate`/`ready`". The host starts on the first `ready()`/`load()`/`evaluate()`/`measure()`; through the runtime that is the first salient trigger, `rt.ask`/`rt.decide`, or any read of `rt.ready`.
- `src/model/README.md` "Self-hosting everything" copies only `ort-wasm-simd-threaded.asyncify.wasm` to `public/ort/`. When no WebGPU plan exists, the backend loads `onnxruntime-web/wasm` and fetches `ort-wasm-simd-threaded.wasm` from `ortWasmPaths`, which that recipe does not provide (code-derived; not tested). Serve both files.
- `tokenizer.ts` header comment describes non-special added tokens as "split out first", with the normalizer applied to "the rest". The code normalizes the whole text first and then splits added tokens (`encode` -> `splitAdded(this.normalize(text))`). For the v0.1 tokenizer (`extension/src/model/tokenizer.json`: normalizer `NFC`, 109 non-special added tokens such as `[unusedN]` and space runs, all ASCII) the two orders give the same result; a tokenizer whose added tokens change under its normalizer could differ. The README parity table reports identical ids on the full and pruned vocabularies (unverified).
- `WARMUP_STATE` / `WARMUP_QUESTIONS` (`backend.ts`) are a v1-style mutation situation, and the warm-up diagnosis question reads "What is going on?" while the runtime's `DIAGNOSIS_INSTRUCTIONS` (`situation/questions.ts`) is "What is happening here?". Only the timing (`warmupMs`, the warm-up `status.latency`) is used, so this is cosmetic.
- `src/model/index.ts` header comment says `Tokenizer`/`Packer`/`stateSegments` "are exported for token budgeting of situations". Nothing in `src/` imports `model/index.ts`, and situation budgets are in characters (`STATE_CHAR_BUDGET`), not tokens.

Open items and TODOs relevant to this scope:

- `rt.ask(q, { timeoutMs })` after a failed load rejects with the raw `ModelLoadError` instead of `GenClassUnavailableError` (`runtime.ts` -> `ask`: the `Promise.race([wait, to])` branch is not wrapped). Without `timeoutMs` it is wrapped.
- A worker crash after `ready` usually leaves the runtime observing only for the rest of the page: the host supports `load()` after a crash, but the runtime never calls it (the only restart path is a first-ever read of `rt.ready` after the crash; see Invariants).
- `ModelAbortedError` (code `aborted`) is defined and exported but never thrown.
- `BackendLoadOptions.sessionTimeoutMs` cannot be set through `createModelHost` or `init`.
- There is no automatic reload after a failed load: the runtime caches `ready` and has no public retry. The idle worker is kept after a load error.
- Old Cache Storage entries are never evicted.
- A hung forward pass blocks the host forever: there is no post-load watchdog.
- Device-based model selection and publishing `@genclass/runtime-model@0.1.0` plus a GitHub release (OPEN_TASKS "Next": Model package `@genclass/runtime-model@0.1.0` (+ device-based selection); procedure in [RELEASE.md](../../../RELEASE.md)) are open. Final round 1 results are now in training/EVAL.md and docs/runtime/RESULTS.md (R17 chosen as the default on every device, which makes device-based selection less pressing), but they are `situation-v1` baselines.
- The v2 model itself ([HANDOFF](../../../HANDOFF.md) "How to continue" step 3): v2 data (SIM about 10M gold + 50M unlabeled on 20 Azure nodes, REAL about 495k (HANDOFF; training/NEEDS target ≥ 500k) real-browser gold rows; locations in training/NEEDS.md item 16 and its node-claims table) -> 150M teacher -> teacher labels -> distil R17 (default) and R32 -> DAgger via SIM `--on-policy` -> EVAL -> `@genclass/runtime-model@0.1.0` -> demos rerun -> `@genclass/runtime@0.1.0`. When it lands: update `DEFAULT_FROM`, MODEL_CARD, and check `meta.json` `max_len` 2048 and the calibration headers (including the new `delivery` action header).
- The crash on `NaN` in app state (fixed in `packages/runtime/src/util.ts` by ad24804, test `test/nan.test.ts`) shipped in `0.1.0-alpha.1`, published 2026-10-08 under `latest` (release commit 806a296). The model host was never affected (`toJsonValue` maps NaN to `null`).
- demos/NEEDS.md §2: one-at-a-time decisions queued up during typing bursts (median 826 ms, measured on v1). Batch 4/5 addressed the runtime side (no store-write holds, `expectedLatency` gate, `stale()` drop in `DeciderQueue`); the host is still one inference at a time. Not re-measured with a model on v2.
- Measured performance (not re-verified here):
  - [docs/runtime/RESULTS.md](../../runtime/RESULTS.md) §2 (onnxruntime-web 1.30 WASM, 1 thread, q8): R17 177 / 323 / 589 ms and R32 569 / 954 / 1,580 ms at 500 / 780 / 1,170 sequence tokens; GenClass 0.1 about 900 ms at 780. A 2,400-char v2 situation is about 1,000 tokens (2.4 chars per token, training/NEEDS.md 6a).
  - `src/model/README.md` (Chromium on the shared VM): v0.1 q8 cold load 1.56–1.94 s from localhost; 4 WASM threads are about 3× faster.

  Single-thread WASM with R32 does not fit an 800 ms hold budget at full size; with R17 it does at about 1,000 tokens. Under the default `observe` mode this only affects how fast background findings arrive.

## Related docs

- [../../../RELEASE.md](../../../RELEASE.md): release procedure for `@genclass/runtime` and `@genclass/runtime-model`.
- [../../../HANDOFF.md](../../../HANDOFF.md): project state and "How to continue".
- [../../runtime/RESULTS.md](../../runtime/RESULTS.md): measured results (latency, model choice).
- [../../../packages/runtime/test/install/RESULTS.md](../../../packages/runtime/test/install/RESULTS.md): install, script-tag and CDN-worker checks (`cdn-check.mjs`) and CDN file sizes.

- [public-api-and-lifecycle.md](./public-api-and-lifecycle.md): `GenClass.init`, `createRuntime`, `InitOptions.model`, `ready`/`status`, kill switch.
- [decide-policy-actions.md](./decide-policy-actions.md): `DeciderQueue`, hold budget, policy gate, late revert, fail-open handling of provider errors.
- [learn-situation-triage.md](./learn-situation-triage.md): situation building, `STATE_CHAR_BUDGET` / `COMPACT_BUDGET`, `situationBudget`, standing questions.
- [devtools.md](./devtools.md): how the overlay shows model status.
- [build-test-release.md](./build-test-release.md): tsup entries, local and VM test commands, CI (`.github/workflows/ci.yml`), npm publish.
- [../model-io-contract.md](../model-io-contract.md): situation text -> packed request -> heads -> calibrated answers (runtime, sim, training).
- [../training.md](../training.md): R17/R32 training, `export_runtime.py` (writes `model.json`/`meta.json`), calibration fitting.
- [../genclass-model-lineage.md](../genclass-model-lineage.md): `jev_local` Python originals of the serializer, packer and calibration.
- [../status-and-known-issues.md](../status-and-known-issues.md): project-wide status and drift.
- [../sim.md](../sim.md): the sim plugs in its own decider, except `--on-policy` (DAgger), which runs this host inline in Node (`sim/src/run/onpolicy.ts`).
- [../realapps.md](../realapps.md): the real-app corpus (91 apps at b435acb; the v2 never-worse sweep covered the 66 of the time) and its never-worse sweep; it plugs in its own recording decider (`realapps/src/world/probe.ts` -> `decider`, model `realapps-recorder`) or `model: false`, never the model host.
- [../glossary.md](../glossary.md): shared terms.
- Source notes: `packages/runtime/src/model/README.md`; model card: `packages/runtime-model/MODEL_CARD.md`; contract: `docs/runtime/CONTRACT.md` §2, §8, §10, §13.
