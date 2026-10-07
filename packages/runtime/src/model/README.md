# src/model: GenClass model engine and host (internal notes)

Owner: MODEL. This directory turns a Jev request (`state` + typed `questions`) into calibrated answers with the
local GenClass ONNX model, in a module Worker, and is the runtime's default `DecisionProvider`.

| file | what |
|---|---|
| `serialize.ts` | state/question text, port of `jev_local/serialize.py`. Renders values exactly as Python does after a JSON round trip (numbers, `str.strip()` whitespace, `undefined`/NaN/Date) |
| `tokenizer.ts` | byte-level BPE over `tokenizer.json` (HF `tokenizers` semantics; special tokens never matched in text; non-special added tokens split out leftmost-longest; heap-based merges like `Word::merge_all`). Nothing hardcoded: vocab size, ids, markers and merges come from the file |
| `packer.ts` | sequence layout + ONNX feed plan, port of `tokenize_pack.Packer` with FastEngine length rules; typed `MaxTokensExceededError` |
| `calibrate.ts` | temperature/Platt lookup (`calibrate.py`: by_header, by_bucket, tau_k, noul_platt) and answer math (`confidence.py`) |
| `engine.ts` | packer + ORT session + calibration; builds exactly the inputs `meta.json` declares |
| `loader.ts` | model card, plan order, WebGPU probe, Cache Storage downloads (sha256, progress) |
| `backend.ts` | the load sequence and evaluation; runs in the worker, or inline as the fallback |
| `worker.ts` | module Worker entry (`dist/worker.js`); imports onnxruntime-web on demand (WASM-only or WebGPU bundle) |
| `host.ts` | `createModelHost()`: worker/inline transport, preload modes, priority queue, timeouts, status |
| `protocol.ts`, `errors.ts`, `hash.ts`, `pyutil.ts` | message types, typed errors (they cross the worker boundary), SHA-1/SHA-256, Python semantics |

## Model directory and card (`model.json`)

```json
{ "format": "genclass-runtime-model/1", "name": "genclass-runtime-model", "version": "0.1.0", "license": "Apache-2.0",
  "variants": {
    "q8":   { "file": "genclass-q8.onnx",   "bytes": 123, "sha256": "<hex>", "provider": "wasm" },
    "fp16": { "file": "genclass-fp16.onnx", "bytes": 123, "sha256": "<hex>", "provider": "webgpu", "needs": "shader-f16" } },
  "files": {
    "tokenizer":   { "file": "tokenizer.json",   "bytes": 123, "sha256": "<hex>" },
    "calibration": { "file": "calibration.json", "bytes": 123, "sha256": "<hex>" },
    "meta":        { "file": "meta.json",        "bytes": 123, "sha256": "<hex>" } } }
```

- File names are relative to the directory (no scheme, no absolute path, no `..`). `files` entries may be bare names;
  missing ones default to `tokenizer.json`, `calibration.json`, `meta.json`.
- `needs` is the WebGPU feature a variant needs **on WebGPU**; WASM ignores it. Card rule: **any fp16 tensor ->
  `"needs": "shader-f16"`** (the v0.1 q8 keeps its embedding table in fp16 and so needs it; an int8 table does not).
  `genclass-runtime info <dir>` scans each variant's graph (dependency-free protobuf walk) and warns when the rule is
  broken.
- The GenClass extension's v0.1 card (`bundled`, `default_base_url`, no `files`) is accepted as is; files without a
  sha256 are cached under the card's `name@version`.
- `meta.json`: `max_len` (positions budget: state + the longest question branch, default 1536), optional `max_total`
  (whole sequence, default 8192), `markers`/`cls_id`/`sep_id` (checked against the tokenizer), `inputs`/`outputs`
  (the graph must have exactly these inputs, each one the engine knows: `input_ids position_ids q_group i_group
  attention_mask token_type_ids choice_q choice_items score_q score_items noul_q noul_t noul_f`; outputs
  `choice_logits score_logits noul_logits`, fp32 or fp16).

`genclass-runtime fetch-model <dir> [--from <baseUrl>] [--variant q8|fp16|all] [--force]` (bin/) downloads a
directory with Node fetch (follows redirects, so GitHub release URLs work), verifies sizes and sha256, skips files
already present and valid, keeps variants fetched earlier, and writes a card in the format above listing exactly the
files on disk with their hashes. `genclass-runtime info <dir>` verifies a directory.

## Loading (`backend.ts`, `loader.ts`)

1. `model.json` from the network (`cache: "no-cache"`; a Cache Storage copy is used when offline), in parallel with
   the WebGPU probe.
2. onnxruntime-web is imported once the plans are known: `onnxruntime-web/wasm` when no WebGPU plan will be tried
   (plain `ort-wasm-simd-threaded.wasm`, 14 MB / 3.1 MB brotli), `onnxruntime-web/webgpu` otherwise (asyncify build,
   27 MB / 5.5 MB brotli, which also runs the WASM fallback). Both are static `import()` strings, so bundlers emit
   each as its own chunk and a page downloads only one. `status.ortBuild` says which.
3. In parallel: tokenizer/calibration/meta and the first plan's variant. The ORT wasm of the chosen bundle is fetched
   by us from `ortWasmPaths` or `https://cdn.jsdelivr.net/npm/onnxruntime-web@<ort.env.versions.web>/dist/`, cached,
   and handed to ORT as `env.wasm.wasmBinary`: ORT itself never fetches, second loads work offline, and nothing goes
   through the app's instrumented fetch. If that prefetch fails, `env.wasm.wasmPaths` is set instead.
4. Plans: `webgpu+fp16` (adapter has shader-f16) -> `webgpu+q8` -> `wasm+q8`. `device: "auto"` skips software
   (fallback) adapters; `"webgpu"` still ends with WASM; `"wasm"` never touches the GPU. The probe creates and
   destroys a device first: onnxruntime can hang on an adapter that cannot make one.
5. Per plan: variant bytes -> `InferenceSession.create` (timeout: webgpu 60 s, wasm 180 s) -> `Engine` (graph
   contract check) -> warm-up pass on a situation-shaped request (on WebGPU a second, timed pass: the first compiles
   pipelines); its time seeds `status.latency` (`source: "warmup"`). A failure records `{variant, device, error}` in
   `status.attempts` and moves on. A WebGPU session that times out in a worker ends that worker's plans; the host
   then retries once in a fresh WASM-only worker (it also does so after any failed load that involved WebGPU, and
   when a loading worker is silent for 180 s).
6. Downloads: Cache Storage `genclass-runtime-v1` (`cacheName`), keyed by URL; an entry is valid when its recorded
   sha256 (or tag: card id / ORT version) matches; streamed with progress; size + sha256 checked (WebCrypto, pure-TS
   fallback for insecure contexts); quota errors, opaque responses and missing Cache Storage fall back to the network.
7. Threads: `min(4, hardwareConcurrency)` only in the worker of a crossOriginIsolated page, else 1. `proxy = false`,
   `logLevel = "error"`.

## Host (`createModelHost(opts)`)

`ModelOptions` (types.ts) plus `fetch` (native, for the inline path), `clock`, `timeoutMs` (default 10 s, also while
queued), `maxQueue` (32), `warmup`, `maxThreads`, `helloTimeoutMs` (15 s), `loadStallMs` (180 s), and test hooks
(`workerFactory`, `ortLoader`, `probeGpu`). Default `baseUrl`: `DEFAULT_MODEL_BASE_URL` =
`https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/`.

- Worker by default: `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`. Inline fallback
  (dynamic `import("onnxruntime-web/webgpu")` on the main thread) when `Worker` is missing, construction throws, the
  worker errors before its `hello`, or no `hello` within 15 s. Worker `error` events are `preventDefault`ed so they
  never reach the page's error handlers.
- Preload: `"eager"`; `"idle"` (default): after the page `load` event (or 5 s), `requestIdleCallback` with a 2 s
  timeout (1 s timer without it); `"lazy"`: on the first `ready()`/`evaluate()`/`load()`.
- `evaluate()` before ready rejects at once with `ModelNotReadyError` (code `not_ready`) and starts a lazy load:
  the runtime fails open. Measured in Chromium: < 1 ms.
- Queue: one inference at a time; higher `priority` first, FIFO within a priority. Every request has a deadline
  (`req.timeoutMs` or `timeoutMs`); a queued request past it is dropped without running; a running one rejects and
  keeps the slot until the worker answers. A full queue evicts the lowest-priority, oldest request (`ModelBusyError`).
- `measure(state, questions?)` returns `{ stateTokens, positions, total }` with the loaded tokenizer (situation
  budgeting). `evaluateDetailed()` also returns `model`, `usage` and `timings` (`pack`, `forward`, `total`).
- `status` (`ModelHostStatus` extends `ModelStatus`): `state`, `phase` (`card|download|runtime|session|warmup`),
  `progress {loaded,total}` (model files, monotonic, throttled to 10/s), `device`, `variant`, `model` (card name),
  `version`, `bytes`, `fromCache`, `loadMs`, `warmupMs`, `threads`, `worker`, `workerError`, `gpu` (what the probe
  found), `attempts`, `ort`, `ortBuild`, `error`, and `latency` = `{ p50, p90, n, tokensP50, msPerToken, source }`:
  inference time in the worker (pack + forward + answers; no queue wait or messaging) over the last 20 evaluations
  (nearest rank), seeded by the warm-up before the first one. `onStatus()` sees every change (latency updates at most
  every 5 s); `stats` counts requests/timeouts/busy/notReady.
- `dispose()` rejects everything pending (`ModelDisposedError`), releases the session, terminates the worker.

Message protocol (protocol.ts): host -> worker `load{options}`, `evaluate{id,state,questions}`,
`measure{id,...}`, `dispose`; worker -> host `hello`, `status{status}`, `result{id, ok, value | error}`. The state is
JSON-normalised before posting; choice criteria may be Maps (structured clone keeps them). Errors travel as
`{name, message, code, detail}` and are rebuilt as the same classes.

Errors (`errors.ts`, all `GenClassModelError` with a `code`): `ModelNotReadyError`, `MaxTokensExceededError`
(`tokens`, `total`, `maxTokens`; Jev `max_tokens_exceeded`), `ModelInputError`, `ModelUnsupportedError`,
`ModelTimeoutError`, `ModelBusyError`, `ModelDisposedError`, `ModelLoadError` (`attempts`), `ModelIntegrityError`,
`ModelInferenceError`.

## Parity (v0.1 GenClass ONNX, fixtures in test/fixtures/model)

| check | result |
|---|---|
| packer vs Python `Packer` (50 harness requests, ~64k tokens) | identical ids, positions, groups, marker positions |
| tokenizer vs HF `tokenizers` (98 edge-case strings) | identical, full vocab and a TRAIN-style pruned vocab (16,364 tokens, markers 16359..16363) |
| serializer vs `serialize.py` (17 edge-case states, 7 questions) | identical |
| calibration of PyTorch logits vs PyTorch probabilities (503 questions) | max diff < 1e-9; v1+v2 calibration files vs Python < 1e-12 |
| q8 on onnxruntime-node vs PyTorch (50 requests) | 502/503 decisions, max logit diff 0.365, max prob diff 0.045 (= the export's parity.json) |
| fp16 on onnxruntime-node vs PyTorch | 503/503, max logit diff 0.018, max prob diff 0.0024 |
| q8 on onnxruntime-web 1.30 WASM (Node, 12 requests) | 121/121 decisions |
| q8 in Chromium (module worker, WASM, 8 requests) | 79/80 decisions (one near tie: 0.444 vs 0.439), max prob diff 0.011 |

## Measured (Chromium 1243 headless on the shared train VM: AMD EPYC 9V45, no GPU; localhost server)

Ranges are runs on the shared VM (other agents' load moves them by 10-20%).

| v0.1 q8 (32M) | |
|---|---|
| cold load (model 57 MB + ORT wasm from localhost; real cold loads add the download) | 1.56-1.94 s (warm-up pass 0.44-0.49 s of it) |
| cached load (Cache Storage, no network but model.json) | 1.37-1.69 s |
| same, Vite 8 production build / dev server of an app using `GenClass.init` | 1.9 s, worker: true |
| warm forward, ~600-token state (607 state / 780 sequence tokens, 2 choice questions with 8 + 4 options), WASM 1 thread | 837-981 ms median |
| warm forward, ~1,000-token state (1,001 / 1,174 tokens), WASM 1 thread | 1,452-1,791 ms median |
| same two, WASM 4 threads (crossOriginIsolated page) | 271-360 ms / 464-556 ms |
| `status.latency` after the warm-up / after 20 evaluations at 1,174 tokens | `{p50: 472, tokensP50: 406, msPerToken: 1.16, source: "warmup"}` / `{p50: 1657, p90: 1793, n: 20, msPerToken: 1.41}` |
| `evaluate()` before ready | rejects in < 1 ms |
| tokenizer build from tokenizer.json (50k vocab) / encode 2.9k tokens cold | 26 ms / 8 ms |

Compute floor per model size, single-thread WASM, warm forward median (same two questions; state tokens / sequence
tokens; the pruned models use their 16,364-token tokenizer):

| state tokens | v0.1 32M (d 384, 10 layers) | R32 pruned 32M (TRAIN export, int8 emb) | R17 random init (d 256, 7 layers) |
|---|---|---|---|
| ~300 (312 / 485; pruned 274 / 463) | 465 ms | 458 ms | 177 ms |
| ~400 (397 / 570; pruned 409 / 598) | 571 ms | 601 ms | 245 ms |
| ~600 (607 / 780; pruned 598 / 787) | 882 ms | 908 ms | 360 ms |
| ~1,000 (1,001 / 1,174; pruned 993 / 1,182) | 1,555 ms | 1,647 ms | 625 ms |

Vocabulary pruning shrinks the download, not the compute; the 17M architecture is about 2.5x faster than 32M.
Single-threaded WASM does not fit a 300 ms hold budget with the 32M model at these lengths.

Transfer per path (what the worker downloads; brotli q9 here, jsDelivr serves the wasm files at 3.07 MB / 5.53 MB):

| | WASM path (`ortBuild: "wasm"`) | WebGPU path (`ortBuild: "webgpu"`) |
|---|---|---|
| worker + shared chunk | 71 KB raw / 19 KB br | 71 KB / 19 KB |
| onnxruntime-web bundle chunk | 103 KB / 24 KB | 163 KB / 37 KB |
| ORT wasm | 14.2 MB / 2.69 MB | 26.8 MB / 4.69 MB |
| runtime total | 14.4 MB raw, 3.7 MB gzip, 2.7 MB br | 27.0 MB raw, 6.7 MB gzip, 4.7 MB br |
| v0.1 model files (q8 56.9 MB + tokenizer 3.6 MB) | 60.5 MB raw, 53.1 MB br (int8 weights barely compress) | same |
| TRAIN R32 pruned (q8 22.5 MB + tokenizer 0.55 MB) | 23 MB | same |

## WebGPU notes (SwiftShader adapter, no shader-f16)

- The v0.1 q8 export keeps its embedding table in fp16 (Gather + Cast): onnxruntime's WebGPU Gather then needs
  shader-f16 ("Program Gather requires f16"), so webgpu+q8 fails at the warm-up pass on such adapters and the loader
  falls back to WASM. For such a model, mark the q8 variant `"needs": "shader-f16"`.
- With the table in fp32, or as int8 + per-row fp32 scale (Gather(int8) -> Cast -> Mul(Gather(scale))), webgpu+q8
  runs without shader-f16: MatMulNBits (8-bit, block 32) works on onnxruntime-web 1.30's WebGPU provider. Parity
  (4 requests): fp32 table 40/40 (max prob diff 0.007), int8 table 40/40 (0.016); int8 table on ORT CPU over 50
  requests: 500/503 decisions, max prob diff 0.051. `test/fixtures/model/make_webgpu_variants.py` builds both.
- TRAIN's exports (`training/export_runtime.py`: R32 pruned, R17) use the int8 table: their q8 loads as webgpu+q8 on
  SwiftShader and answers; their fp16 declares shader-f16. The TS packer + engine reproduce the export's own
  parity.json exactly (R32: q8 450/454 decisions, max logit diff 1.3656; fp16 453/454) and pack bit-exactly
  (89/90 requests; the other holds a Python-only float literal, `25.0`, that a JS runtime can never produce).

## Bundling

- tsup keeps `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` verbatim in the chunk that
  holds the host; `dist/worker.js` imports `onnxruntime-web/webgpu` (external). The browser tests check both.
- Vite 8: production build (worker format `es` or the default) and the dev server with the package installed from
  npm both start the worker and load the model; no `optimizeDeps.exclude` needed. Vite also emits ORT's own
  `ort-wasm-simd-threaded.asyncify.wasm` (27 MB) as an asset because ORT references it with
  `new URL(..., import.meta.url)`; GenClass does not load it (it fetches the wasm from `ortWasmPaths`/jsDelivr). The
  inline fallback's `import("onnxruntime-web/webgpu")` becomes a separate 115 KB chunk, loaded only if needed.
- webpack 5 supports the same worker pattern natively (not tested here).
- Self-hosting everything: `genclass-runtime fetch-model public/genclass-model`, copy
  `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm` to `public/ort/`, then
  `model: { baseUrl: "/genclass-model/", ortWasmPaths: "/ort/" }`.

## Tests

- `test/model/*.test.ts` (vitest, Node): parity above, Python semantics, hashes, card/plan/cache/backend with
  in-memory fakes, host queue/priority/timeouts/preload/fallbacks/recovery with a fake worker and clock. Model-file
  tests read `GENCLASS_MODEL_DIR` (default `<repo>/.cache-model`) and skip when it is absent;
  `test/fixtures/model/make_py_fixtures.py` regenerates `py_fixtures.json` (HF tokenizers, serialize.py, calibrate.py).
- `test/browser/` (Playwright): `build.mjs` builds the library with tsup and bundles a test app with esbuild the way an
  app bundler would; `model.spec.ts` (Chromium) and `model-webgpu.spec.ts` (Chromium + SwiftShader WebGPU,
  `GENCLASS_WEBGPU_VARIANTS` for the embedding variants). Latency numbers land in `test-results/model-bench/{latency,transfer}.json`.

```sh
node packages/runtime/bin/genclass-runtime.mjs fetch-model ~/gcl-cache/model-v0.1 --from https://github.com/MeharPro/GenClass/releases/download/v0.1.0/
cd packages/runtime
GENCLASS_MODEL_DIR=~/gcl-cache/model-v0.1 npx vitest run test/model
GENCLASS_MODEL_DIR=~/gcl-cache/model-v0.1 npx playwright test --config test/browser/playwright.config.ts
```
