# Build, test and release (@genclass/runtime and the monorepo)

> **Scope:** `package.json` (root), `tsconfig.base.json`, `.gitignore`, `packages/runtime/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts}`, `packages/runtime/test/**` (unit, model, browser, smoke, fixtures), `packages/runtime/STATUS.md` ("State" and "How to drive it headless"), `scripts/vm.sh`, `OPEN_TASKS.md` (packaging), `sim/package.json`, `demos/package.json`, `packages/runtime-model/`.
> **Read this when:** you need to build, typecheck or test the runtime; add or fix a test; regenerate fixtures; run the Playwright model/UI specs or the npm-pack smoke test; publish a version; add CI; or understand how `sim/` and `demos/` consume the runtime package.
> **Source of truth:** the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

## TL;DR

- npm workspaces monorepo: `packages/*`, `sim`, `demos`. Root scripts only touch the runtime: `npm run build` / `npm test` run in `@genclass/runtime`; `npm run typecheck` runs every workspace's `typecheck` (`--if-present`).
- **Team rule: the Mac only edits files.** Every `npm install`, build, typecheck, vitest, Playwright, smoke test and model run happens on the Azure `train` VM through `scripts/vm.sh` in your own *slot* (the original Mac had 8 GB RAM). Stated in `scripts/vm.sh` (header) and `docs/runtime/CONTRACT.md` §0 rule 5.
- **Lead policy for agents (2026-10-07):** on machines other than that 8 GB Mac, `npm install`, typecheck, build and unit tests are light and verified to work locally. Ask the user before running the sim, training, Playwright (including `test/smoke/smoke.sh`), model downloads, the demos' eval, or any script that touches Azure (`scripts/*.sh`, `training/*.sh`, `sim/scripts/*`). See [Where to run things](#where-to-run-things) and [Verified locally (2026-10-07)](#verified-locally-2026-10-07).
- Build = `tsup` (`packages/runtime/tsup.config.ts`): ESM only, 6 entries (`index`, 3 adapters, `devtools/index`, `worker`), `.d.ts` for all but the worker, `clean: true`, `splitting: true`. Output goes to `packages/runtime/dist/`, which `package.json` `exports` points at.
- Typecheck = `tsc -p tsconfig.json --noEmit` over `src/` only. **Test files are never type-checked.**
- Unit tests = vitest (`vitest run`), 37 files under `test/` and `test/model/`, 300 tests (UI 53, MODEL 62 per STATUS; the other 185 = CORE 142 + REVIEW 43). Default environment `node`; 5 files opt into `happy-dom` per file. Re-run on 2026-10-07 without a model directory: 286 passed, 14 skipped, about 2.4 s.
- Runtime unit tests run on a virtual clock (`test/helpers.ts` -> `FakeClock`), a virtual HTTP server (`FakeServer`) and a scripted model (`ScriptedDecider` / `ManualDecider`): no real time, no network, no model. Exceptions (wall-time perf checks, `loader.test.ts`'s real `browserClock`, model-file tests) are listed under gotchas.
- Model tests need a model directory (`GENCLASS_MODEL_DIR`, default `<repo>/.cache-model`); without it 14 model tests skip. The gc test needs `NODE_OPTIONS=--expose-gc` (otherwise it logs "skipped" and passes).
- Browser tests = Playwright (`npm run test:browser` in `packages/runtime`): `globalSetup` builds the library with tsup and bundles a test app with esbuild; model specs skip without a model directory. A separate config runs the devtools UI spec and writes 18 screenshots.
- `test/smoke/smoke.sh` packs the tarball, installs it into a fresh Vite 8 app, builds it and loads it in headless Chromium.
- Released: `@genclass/runtime@0.1.0-alpha.0` on npm (org `genclass`, owner `meharpro`, dated 2026-10-08 in `OPEN_TASKS.md`), git tag `v0.1.0-alpha.0` on 654d822. No publish script, no `prepublishOnly`, **no CI workflow** (no `.github/`), and **no committed root `package-lock.json`** (only `extension/package-lock.json` is tracked).
- Planned: `@genclass/runtime-model@0.1.0` (the model files; the runtime's default CDN URL points at it) and then `@genclass/runtime@0.1.0`. `packages/runtime-model/` holds only `MODEL_CARD.md` today.
- `sim` and `demos` depend on `"@genclass/runtime": "*"` (workspace symlink), which resolves to `packages/runtime/dist/`: **build the runtime first**.

## Files

| path | role | key contents / entry points |
|---|---|---|
| `package.json` | root, private `genclass-lib`, `"type": "module"` | workspaces `packages/*`, `sim`, `demos`; scripts `build`, `test`, `typecheck`; devDep `typescript ~5.9.3`; `engines.node >=20`; license Apache-2.0 |
| `tsconfig.base.json` | shared compiler options | see Configuration |
| `.gitignore` | ignores build and model artefacts | "GenClass runtime" block: `node_modules/`, `dist/`, `.vite/`, `test-results/`, `playwright-report/`, `sim/out/`, `packages/runtime-model/files/`, `.cache-model/`, `.publish/`, `*.tgz` (the last two added in 59c213f). Older Python block: `.venv/`, `__pycache__/`, `*.pyc`, `.pytest_cache/`, `*.egg-info/`, `data/`, `models/`, `runs/`, `dist/`, `node_modules/`, `.DS_Store`. `data/`, `models/`, `runs/` are unanchored (match at any depth). `package-lock.json` is **not** ignored |
| `package-lock.json` (root) | **not tracked** | never committed (`git log --all -- package-lock.json` is empty). A root `npm install` creates one that shows as untracked; it records `node_modules/@genclass/runtime` as `{ "resolved": "packages/runtime", "link": true }` |
| `packages/runtime/package.json` | the published package | name `@genclass/runtime`, version `0.1.0-alpha.0`, `exports`, `bin`, `files`, scripts `build`/`typecheck`/`test`/`test:browser` |
| `packages/runtime/tsconfig.json` | typecheck project | extends base; `rootDir: src`, `outDir: dist`, `jsx: react-jsx`, `types: []`, `include: ["src"]` |
| `packages/runtime/tsup.config.ts` | build | entries, dts entries, externals |
| `packages/runtime/vitest.config.ts` | unit-test runner config | include `test/**/*.test.ts`, exclude `test/browser/**`, env `node`, `testTimeout 20000` |
| `packages/runtime/bin/genclass-runtime.mjs` | CLI shipped in the tarball (not built); committed with mode 100644, and a root `npm install` makes it 755 (see [Verified locally](#verified-locally-2026-10-07)) | `fetch-model <dir> [--from] [--variant q8\|fp16\|all] [--force] [--quiet]`, `info <dir>`; `DEFAULT_FROM` |
| `packages/runtime/test/helpers.ts` | core test kit | `drain`, `FakeClock`, `choice`, `ScriptedDecider`, `defaultScript`, `FakeServer`, `makeGlobal`, `setup`, `ManualDecider` |
| `packages/runtime/test/*.test.ts` | 31 unit test files (CORE, UI, REVIEW) | see Tests |
| `packages/runtime/test/model/helpers.ts` | model test kit | `PKG`, `FIX`, `MODEL_DIR`, `readJson`, `modelFile`, `hasModelFile`, `FIXTURES_FROM_MODEL`, `requests`, `packs`, `torch`, `exportParity`, `pyFixturesPath`, `pythonOnlyFloatRequests`, `questionsInPythonOrder`, `pruneTokenizer` (mirrors `prune_tokenizer()` in `make_py_fixtures.py`), `vocabDigest`, `isV01Tokenizer`; types `PackFixture`, `TorchFixture`, `RequestFixture` |
| `packages/runtime/test/model/*.test.ts` | 6 model test files (MODEL) | see Tests |
| `packages/runtime/test/fixtures/model/` | parity fixtures + their generators | see Fixtures |
| `packages/runtime/test/browser/playwright.config.ts` | model browser specs config | projects `chromium`, `swiftshader-webgpu`; `globalSetup: ./build.mjs` |
| `packages/runtime/test/browser/build.mjs` | Playwright global setup | builds the library, bundles `page/main.ts` + `worker.js` with esbuild into `.build/app/`, checks the worker URL pattern |
| `packages/runtime/test/browser/server.mjs` | static server for the specs | `startServer({ appDir, modelDir, models })`, `ortDistDir()`; routes `/app/`, `/model/`, `/ort/`, `/m/<name>/`, `/coi/...` |
| `packages/runtime/test/browser/page/{index.html,main.ts}` | test app driving the **built** library (`main.ts` is `// @ts-nocheck`, imports `createModelHost` from `"genclass-dist"`); `#state` reads `ready` once loaded | `window.GC.{create, ready, load, status, stats, events, evaluate, evaluateDetailed, measure, bench, dispose, cacheKeys, isolated}`. Test-only `create()` options stripped before `createModelHost`: `mockGpu` (`"f16"` or other: installs a fake `navigator.gpu` whose adapter cannot create a device), `workerUrl` (becomes a `workerFactory`), `noWorkerGlobal` (sets `window.Worker = undefined`). `cacheKeys(name = "genclass-runtime-v1")` |
| `packages/runtime/test/browser/model-helpers.ts` | spec helpers | `PKG`, `APP`, `MODEL_DIR`, `HAVE_MODEL` (`model.json` exists), `requests`/`packs`/`torch` (v0.1 fixtures, loaded only when `HAVE_MODEL`), `card`, `useServer`, `openApp`, page wrappers `create`/`ready`/`evaluate`/`evaluateDetailed`/`events`/`statusOf`, `fixtureRequest`, `compare`, `parityRun`, `PARITY_IDS`, `situation(size, seed)`, `QUESTIONS` (mutation diagnosis 8 labels + action 4 labels), `sizedRequest`, `median`, `benchSizes`, `saveResults`, `transferReport` |
| `packages/runtime/test/browser/model.spec.ts` | model host in headless Chromium (WASM) | 9 tests |
| `packages/runtime/test/browser/model-webgpu.spec.ts` | model host on SwiftShader WebGPU | adapter without `shader-f16` |
| `packages/runtime/test/browser/ui-devtools.spec.ts` | devtools overlay in a real browser + screenshots | writes `ui/screenshots/*.png` |
| `packages/runtime/test/browser/ui/playwright.config.ts` | UI specs config | `testMatch /ui-.*\.spec\.ts$/`, viewport 1280x800, DPR 2 |
| `packages/runtime/test/browser/ui/{mock-runtime,scenario,session,page}.ts` | UI fixtures, **also imported by unit tests** | `mock-runtime.ts`: `MockRuntime` (scripted `Runtime`, not the runtime), `MockClock`, `choice(probs)`, `makeDecision`, `makeAction`; `scenario.ts`: `loadScenario(rt, opts)`, `ScenarioOptions`; `session.ts`: `runStoreSession(opts)` (real `createRuntime` under virtual time), `Session`, `SessionOptions`, `VirtualClock`, `realTurn`, `READY` (a `ModelStatus`), `SessionDecider` (rule-based test decider); `page.ts`: `window.__gc` |
| `packages/runtime/test/browser/ui/screenshots/` | 18 committed PNGs | `{pill,overlay,interventions,evidence,evidence-answers,detections,activity,now,loading}-{light,dark}.png` |
| `packages/runtime/test/browser/.gitignore` | ignores `.build/` | build output of `build.mjs` |
| `packages/runtime/test/smoke/smoke.sh` | npm-pack smoke test | run from `packages/runtime` |
| `packages/runtime/STATUS.md` | CORE status + headless recipe | last measured: 37 files / 300 tests passing |
| `packages/runtime-model/MODEL_CARD.md` | only file of the planned `@genclass/runtime-model` package | no `package.json` yet, so not a workspace |
| `scripts/vm.sh` | VM helper | `sync`, `run`, `exec`, `get` |
| `sim/package.json`, `demos/package.json` | consumers of the runtime | `"@genclass/runtime": "*"`; scripts listed under "How `sim` and `demos` consume the runtime" |

## Concepts and data structures

| term | meaning |
|---|---|
| workstream | team role that owns files: lead, CORE (runtime core + most tests), MODEL (`src/model/**`, `bin/`, `test/model/`, model browser specs), UI (`src/devtools/**`, `src/adapters/**` per CONTRACT §13, their tests, `test/browser/ui/`), SIM, DEMOS, TRAIN, REVIEW (`test/review-*.test.ts`) |
| slot | your directory on the VM, `~/gcl/<SLOT>`; name must match `[a-zA-Z0-9_-]+`; conventional names `core`, `model`, `sim`, `demos` |
| model directory | a folder with `model.json` (card format `genclass-runtime-model/1` or the v0.1 extension card), the ONNX variants, `tokenizer.json`, `calibration.json`, `meta.json`. Fetched with `genclass-runtime fetch-model`. Tests read it from `GENCLASS_MODEL_DIR` |
| v0.1 fixture set | `test/fixtures/model/{requests50,pack_fixtures,torch_fixtures}.json`: 50 computer-use requests (ids like `cu-004219-f`) with the Python packer output and PyTorch logits of the **v0.1 GenClass model** |
| model-dir fixture set | `requests.json`, `pack_fixtures.json`, `torch_fixtures.json` (+ `parity.json`) written next to an export by `training/export_runtime.py`. `test/model/helpers.ts` -> `FIXTURES_FROM_MODEL` is true when all three exist in `MODEL_DIR`; then the unit parity tests use them instead of the v0.1 set |
| parity | TS port output (packer, tokenizer, serializer, calibration, engine) equals the Python/PyTorch reference on fixtures |
| review test | `test/review-*.test.ts`: written by REVIEW as bug demonstrations ("A failing test demonstrates a bug"); STATUS records they pass **unmodified** |
| package build vs model-entries build | `build.mjs` -> `buildLibrary`: uses the real `npx tsup` output (`mode: "package"`) when every tsup entry file exists and `dist/index.js` mentions `createModelHost`; otherwise builds only `src/model/index.ts` + `src/model/worker.ts` into `.build/dist` (`mode: "model-entries"`) |
| worker URL pattern | the literal `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` in `src/model/host.ts` -> `defaultWorkerFactory` that app bundlers key on (its sibling `defaultOrtLoader` holds the two literal calls `import("onnxruntime-web/webgpu")` and `import("onnxruntime-web/wasm")`); `build.mjs` -> `WORKER_URL_RE` asserts it survives both builds |
| `situation-v1` | annotated git tag on 1a77558 ("Frozen runtime situation format for model training"); SIM training data was generated from it |
| `v0.1.0-alpha.0` | annotated git tag on 654d822 ("@genclass/runtime 0.1.0-alpha.0 (npm)") |

Test-kit types (exact names, `test/helpers.ts`):

```ts
class FakeClock implements Clock { t = 1000; now(); setTimeout(fn, ms); clearTimeout(h); afterTask(fn);
  get pending(): number; flush(): Promise<void>; advance(ms): Promise<void>; runAll(maxMs = 120_000): Promise<void> }
interface Route { status?: number; body?: unknown; latency?: number; error?: "network"; headers?: Record<string, string> }
class FakeServer { routes; hits: Map<string, number>; log: { method; path; t }[]; on(method, path, Route | Handler): this; fetch }
interface Setup { clock: FakeClock; server: FakeServer; g: Record<string, unknown>; decider: ScriptedDecider; rt: RuntimeImpl; fetch }
function setup(opts?: Partial<CreateOptions> & { script?: Script; extraGlobal?: Record<string, unknown> }): Setup
function defaultScript(pick?: Partial<Record<string /* trigger */, { diagnosis: string; action?: string; p?: number }>>): Script
// default: diagnosis "expected"; action falls back to the first (passive) label; extra questions: noul 0.9,
// choice = first label, score = uniform
class ScriptedDecider implements DecisionProvider { status = { state: "ready", model: "scripted" }; calls: EvaluateRequest[]; script: Script }
class ManualDecider implements DecisionProvider { status = { state: "ready", model: "manual" }; pending: { req; resolve; reject }[];
  answer(script = defaultScript()): EvaluateRequest /* throws "nothing pending" */ }
```

`setup()` spreads your options **after** its defaults, so `setup({ decider: manual })` replaces the decider passed to `createRuntime`, but the returned `decider` field is still the unused `ScriptedDecider`; keep your own reference to `manual`. `FakeServer.fetch` honours `init.signal` (rejects with `signal.reason`), reads only string bodies, and `error: "network"` rejects with `TypeError("Failed to fetch")`.

Per-file fakes outside `test/helpers.ts` (copy these when testing the same area):

| fake | file | what it replaces |
|---|---|---|
| `FakeClock` (own copy, `t = 0`) + `FakeWorker implements WorkerLike` | `test/model/host.test.ts` | clock and the worker boundary (`emit({ type: "hello" \| "status" \| "result" })`) for `createModelHost` |
| `FakeCache`, `FakeCacheStorage`, `modelDir()`, `fakeOrt()`, `NO_GPU`/`GPU_F16` (`GpuInfo`) | `test/model/loader.test.ts` | Cache Storage, a synthetic model directory with its fetch, ORT, GPU probe. Uses the **real** `browserClock` |
| `fakeOrt: OrtLike` (`Tensor`, `InferenceSession.create`, `env.wasm`) + a byte-level BPE `tokJson` | `test/model/engine.test.ts` ("engine graph contract") | ORT, for the model-free graph-contract test |
| local `setup()` with `observe: { fetch: true }` only (other observers at their defaults) | `test/smoke.test.ts` | the shared `setup()` |
| `OFF` observer map + `createRuntime({ global: window, ... })` | `test/dom.test.ts`, `test/review-dom.test.ts` | happy-dom `window` as the instrumented global |
| `makeFakeXHR(clock, handler)` / `makeXHR(clockRef, handler)` | `test/xhr.test.ts` / `test/review-xhr.test.ts` | an `XMLHttpRequest` class passed with `setup({ observe: ..., extraGlobal: { XMLHttpRequest } })`; both use `observe: { fetch: false, xhr: true }` (`XHR_ONLY` in `review-xhr.test.ts`); a passed `observe` replaces setup's map, so unlisted observers fall back to their defaults |
| `timerWorld()` (global whose `setTimeout` queues callbacks run by hand) | `test/review-timers.test.ts` | the timers observer's host global |
| `MockRuntime` / `runStoreSession` | `test/browser/ui/*` | the runtime (devtools and adapter tests) |

Fixture record types (`test/model/helpers.ts`):

```ts
interface RequestFixture { id: string; state: Record<string, unknown>; questions: Record<string, { type: string; instructions?: unknown; criteria?: unknown }> }
interface PackFixture { id: string; input_ids: number[]; position_ids: number[]; q_group: number[]; i_group: number[]; n_state: number;
  q_index: Record<string, { kind: string; header: string; labels: string[]; q_pos: number; item_pos: number[] }> }
interface TorchFixture { id: string; logits: Record<string, number[]>; probs: Record<string, number[]>; header_key: Record<string, string> }
```

## How it works

### Build (`npm run build` -> `tsup`)

1. tsup reads `packages/runtime/tsup.config.ts`; `clean: true` empties `dist/` first.
2. Bundles the 6 entries as ESM (`target es2022`, `platform browser`, `splitting`, `treeshake`, `sourcemap`), leaving `onnxruntime-web`, `onnxruntime-web/webgpu`, `react`, `redux`, `zustand` external. `onnxruntime-web/wasm` is not listed, but tsup also externalises every `dependencies`/`peerDependencies` entry and its subpaths (`^dep($|/)`), so it stays external too; `build.mjs` asserts `import("onnxruntime-web/wasm")` and `import("onnxruntime-web/webgpu")` stay dynamic imports in `dist/worker.js` or its `chunk-*.js`.
3. Emits `.d.ts` for the 5 dts entries (not the worker).

| tsup entry key | source | output | types | `exports` subpath |
|---|---|---|---|---|
| `index` | `src/index.ts` | `dist/index.js` | `dist/index.d.ts` | `.` (also `main`, `module`, `types`) |
| `adapters/react` | `src/adapters/react.ts` | `dist/adapters/react.js` | `dist/adapters/react.d.ts` | `./react` |
| `adapters/redux` | `src/adapters/redux.ts` | `dist/adapters/redux.js` | `.d.ts` | `./redux` |
| `adapters/zustand` | `src/adapters/zustand.ts` | `dist/adapters/zustand.js` | `.d.ts` | `./zustand` |
| `devtools/index` | `src/devtools/index.ts` | `dist/devtools/index.js` | `.d.ts` | `./devtools` |
| `worker` | `src/model/worker.ts` | `dist/worker.js` | none | `./worker` (`import` only) |

Plus shared `chunk-*.js` files (code splitting) and `.map` files. `exports` also exposes `./package.json`. Only `import` conditions exist: the package is ESM-only (no `require`). The tarball contains `files: ["dist", "bin", "README.md", "LICENSE"]` (+ `package.json`). `bin.genclass-runtime` = `./bin/genclass-runtime.mjs` (plain Node >= 20 ESM, no dependencies, not built).

### Unit tests (`npm test` -> `vitest run`)

1. vitest collects `test/**/*.test.ts` minus `test/browser/**` (37 files). It transpiles TS without type-checking.
2. Each file runs in `node` unless its first line is `// @vitest-environment happy-dom` (`adapters-react`, `devtools`, `devtools-runtime`, `dom`, `review-dom`).
3. A typical test calls `setup()`: builds `FakeClock` + `FakeServer` + `makeGlobal(server)` + `ScriptedDecider`, then `createRuntime({ clock, global: g, decider, report: "silent", observe: { fetch: true, all others false }, ...rest })` and casts to `RuntimeImpl` (so tests can reach `rt.hub`, `rt.ops`, `rt.ctx`, `rt.cache`, `rt.miner`, `rt.internals`).
4. The test drives the app through `rt.user(...)`, `rt.op(...)`, atoms and `fetch`, then advances virtual time: `await clock.advance(ms)` runs due timers in order, each followed by `flush()`; `flush()` drains microtasks with 4 real `setImmediate` turns (`drain`), runs `afterTask` hooks, and repeats up to 50 times.
5. The decider answers at once (an already-resolved promise) from a script (`ScriptedDecider`, records `calls`; `script` can be reassigned mid-test) or when the test calls `ManualDecider.answer(script?)` (oldest pending first).
6. Assertions read `decider.calls[i].state` (the situation), `rt.decisions()`, `rt.interventions()`, `rt.history()`, `server.hits` / `server.log`.
7. Model tests (`test/model/`) read fixtures through `test/model/helpers.ts`; parts that need model files use `describe.skipIf(!hasModelFile(...))` / `it.skipIf`. The 14 model-file tests: `calibrate.test.ts` 1 (`calibration.json`), `engine.test.ts` 3 (`model.json` + `tokenizer.json` + the variant file), `packer.test.ts` 10 (`tokenizer.json`; the 2 HF edge-case tests also need `isV01Tokenizer`). The `py_fixtures.json` blocks skip only if that committed file is missing.

### Headless runtime recipe (STATUS "How to drive it headless")

What `setup()` does is the minimal form of the recipe SIM and tests use. `packages/runtime/STATUS.md` gives the full form; options are defined in `src/types.ts` -> `CreateOptions` / `InitOptions` (see [public-api-and-lifecycle.md](public-api-and-lifecycle.md)):

```ts
createRuntime({ clock, global, decider,                    // injected Clock, instrumented global, DecisionProvider
  observe: { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false },
  mode: "heal", triage: "salient", report: "silent",
  policy: { thresholds: { report: 0, guard: 0, heal: 0 }, holdBudgetMs: 1e9, maxActionsPerMinute: 1e9, requireDiagnosis: false },
  situation: { budget: 1000 },                               // sample budgets 1000/1333/2000/3200; <= 1400 = compact questions
  hooks: { opCreated(op) {}, mutationProposed(m) {} }, vocabulary: { diagnoses: {}, actions: {} } });
```

Facts STATUS records for this mode (checked against `src/runtime.ts` -> `installObservers` / `consultable` / `trigger`): `global.fetch` is replaced at construction and `rt.destroy()` restores every wrapped global; `observe` defaults to every observer on except `timers`, which is on only when `global.document` exists (`src/runtime.ts`); the decider is consulted only while `status.state === "ready"`; `app` comes from `CreateOptions.app()` or `document.title` + `location.pathname` (hence `/search` in tests); same inputs give byte-identical situations at any budget.

### Browser model specs (`npm run test:browser`)

1. Playwright loads `test/browser/playwright.config.ts`; `globalSetup` = `build.mjs`.
2. `build.mjs` -> `buildLibrary`: `fullBuildPossible()` regex-scans `tsup.config.ts` for `"src/...ts"` strings and checks each file exists; then runs `npx tsup` in `packages/runtime` (**this rewrites `packages/runtime/dist/`**), checks the worker URL pattern and the two ORT dynamic imports, and uses `dist/` if `dist/index.js` contains `createModelHost`; else falls back to the model-entries build in `.build/dist`.
3. esbuild bundles `page/main.ts` (importing `"genclass-dist"`, aliased to the chosen `index.js`) and `worker.js` into `test/browser/.build/app/` with code splitting (`chunks/[name]-[hash]`), copies `page/index.html`, asserts that some app JS output (page bundle or a chunk) still contains the worker URL pattern, and writes `.build/app-files.json` (which chunk holds which ORT bundle) and `.build/build-info.json`.
4. Each spec starts `server.mjs` on `127.0.0.1:<random port>` serving the app, `MODEL_DIR` at `/model/`, onnxruntime-web's `dist/` at `/ort/` (`ortDistDir()` resolves `onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm`, since `onnxruntime-web/package.json` is not exported), extra model dirs at `/m/<name>/`, and the same under `/coi/` with COOP `same-origin` / COEP `require-corp` (cross-origin isolated, WASM threads). Every response carries `Cross-Origin-Resource-Policy: cross-origin`, `Access-Control-Allow-Origin: *` and `Cache-Control: no-store`; paths escaping a root get 403. It logs every request (`{ path, t }`) so specs can count downloads (`useServer().served(re)`); `openApp` waits for `#state` = `ready` and collects console + page errors.
5. Specs drive `window.GC` in the page, compare answers with PyTorch probabilities from the v0.1 fixtures (`compare`, `parityRun`: `model.spec.ts` uses the default `PARITY_IDS = [0, 7, 13, 21, 29, 36, 42, 49]`, `model-webgpu.spec.ts` passes `[0, 13, 29, 49]`), and merge numbers into `packages/runtime/test-results/model-bench/{latency,transfer}.json` (`saveResults`).

### Browser UI spec

1. `npx playwright test --config test/browser/ui/playwright.config.ts` (from `packages/runtime`; the file header shows the repo-root form `--config packages/runtime/test/browser/ui/playwright.config.ts`). No global setup, no model.
2. `ui-devtools.spec.ts` bundles `ui/page.ts` with esbuild (it imports `src/devtools/index.ts` and, through `session.ts`, `src/index.ts` directly, so no `dist/` build is needed; IIFE, `external: ["onnxruntime-web", "onnxruntime-web/webgpu"]`), inlines `@fontsource-variable/inter/files/inter-latin-wght-normal.woff2` and `@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2` as base64 from `<repo>/node_modules` (installed by the **demos** workspace), and loads the HTML with `page.setContent` after `emulateMedia({ colorScheme, reducedMotion: "reduce" })`.
3. `window.__gc.start({ scenario })`: `live` (default) = real runtime via `runStoreSession()`; `loading` = real runtime, model status loading; `mock` = `MockRuntime` + `loadScenario`; `empty`.
4. Tests check style isolation, keyboard, undo, then write screenshots to `test/browser/ui/screenshots/`.

### Smoke test (`bash test/smoke/smoke.sh`, from `packages/runtime`)

1. `npm run build`, then `npm pack` -> `<pkg>/genclass-runtime-0.1.0-alpha.0.tgz` (name from npm's scoped-package convention; gitignored as `*.tgz`).
2. Creates a temp Vite app (`mktemp -d`/app) whose `src/main.js` calls `GenClass.init({ model: false, report: "console" })`, creates atom `search.results`, wires an input to a `data:` URL fetch, and calls `mountDevtools(rt)`.
3. `npm install` the tarball + `vite@8` + `@playwright/test@1.63.0` (needs registry access), `npx vite build`.
4. `check.mjs` serves `dist/` on port `4191` (plain `node:http`), opens it in Chromium (`chromium.launch()` from the app's `@playwright/test`), waits for `window.__smoke.ok`, `p.fill("#q", "rea")`, waits for `#out` to read `rea-1`, prints one JSON line `{ info: { status, events, devtools }, errs }`, and exits 1 unless there are no page errors / console errors, `genclass-devtools` exists, and `rt.history().length >= 3` (`status` is printed, not asserted). Then prints `SMOKE OK: <tgz>`.
5. Leftovers: the `.tgz` stays in `packages/runtime/` and the `mktemp -d` app is not deleted. The script never runs `playwright install`: Chromium for Playwright `1.63.0` must already be in the Playwright browser cache on the machine (how the VM got it is not recorded in the repo).

### VM workflow (`scripts/vm.sh`)

1. Reads the `train` host IP from `~/.jev-local/azure_hosts` (line `train <ip>`), key `~/.ssh/jev_azure`, user `azureuser`, ssh options `StrictHostKeyChecking=accept-new`, `ConnectTimeout=20`, `ServerAliveInterval=30`, `ServerAliveCountMax=6`. Exits 2 if the host line is missing, the slot name has characters outside `[a-zA-Z0-9_-]`, or the subcommand is unknown. Every step is wrapped in GNU `timeout` (see Configuration). The sibling `scripts/azvm.sh HOST ...` uses the same hosts file and key for the other jev VMs (out of scope here).
2. `sync SLOT`: `ssh mkdir -p gcl/SLOT`, then `rsync -az --delete` the repo to `~/gcl/SLOT/`, excluding `node_modules`, `.git`, `dist/`, `.vite`, `/data/`, `test-results/`, `playwright-report/`, `__pycache__`, `.DS_Store`, `/models/`, `/runs/`, `/extension/`, `/sim/out/`, `.cache-model/`. Excluded paths on the VM are kept (rsync does not delete excluded files without `--delete-excluded`), so `node_modules`, `dist` and model caches survive syncs.
3. `run SLOT 'cmd'` = sync + remote; `exec SLOT 'cmd'` = remote only; remote runs `export PATH=$HOME/node/bin:$PATH; cd ~/gcl/SLOT && cmd` (Node 22 per the header and CONTRACT §0 rule 6).
4. `get SLOT REMOTE LOCAL`: `scp -r` from `~/gcl/SLOT/REMOTE`.

### How `sim` and `demos` consume the runtime

npm workspaces symlink `node_modules/@genclass/runtime` -> `packages/runtime`, so every import goes through `packages/runtime/package.json` `exports` -> `dist/`.

| consumer | dependency | how it resolves | build requirement | escape hatch |
|---|---|---|---|---|
| `sim` (`@genclass/sim`, private) | `"@genclass/runtime": "*"` | dynamic `import(process.env.GENCLASS_RUNTIME ?? "@genclass/runtime")` in `sim/src/run/rt.ts` -> `realRuntimeFactory`; `sim/tsup.config.ts` leaves `@genclass/runtime` external | `npm run build:runtime-core` (in `sim`: tsup of `src/index.ts` only, `--no-config --platform neutral`, no dts, into `packages/runtime/dist`) or the full runtime build | `SIM_RUNTIME=real` runs sim tests on the real runtime; otherwise they use the fake (`sim/test/helpers.ts`); `GENCLASS_RUNTIME=<specifier>` loads another build |
| `demos` (`@genclass/demos`, private) | `"@genclass/runtime": "*"` plus `react`, `redux`, `zustand`, `@fontsource-variable/*` | Vite resolves `exports` -> `dist/` | full runtime build (`demos/scripts/vm-eval.sh` runs `npm run build -w @genclass/runtime` and stops if it fails) | `GENCLASS_SHIM=1` (or a missing `packages/runtime/dist/index.js`) aliases `demos/src/dev/runtime-shim/*` in `demos/vite.config.ts`; `GENCLASS_SHIM=0` forces the real one; `npm run typecheck:shim` |
| `packages/runtime` UI spec | demos' hoisted deps | `<repo>/node_modules/@fontsource-variable/*` | root `npm install` | none |

`sim` does **not** need `dist/` to typecheck: `sim/src/types.ts` is a structural mirror of the runtime's model seam and the only runtime import is the dynamic one in `sim/src/run/rt.ts`. `demos` typecheck does need `dist/*.d.ts` (or `typecheck:shim`, whose `demos/tsconfig.shim.json` maps `@genclass/runtime` and its `/react`, `/redux`, `/zustand`, `/devtools` subpaths to `src/dev/runtime-shim/{index,react,redux,zustand,devtools}.ts`; `/worker` is not mapped).

Workspace scripts (verbatim from the `package.json` files):

| workspace | script | command |
|---|---|---|
| root | `build` / `test` / `typecheck` | `npm run build -w @genclass/runtime` / `npm test -w @genclass/runtime` / `npm run typecheck --workspaces --if-present` |
| `@genclass/runtime` | `build` / `typecheck` / `test` / `test:browser` | `tsup` / `tsc -p tsconfig.json --noEmit` / `vitest run` / `playwright test --config test/browser/playwright.config.ts` |
| `@genclass/sim` (`0.0.0`, private, bin `genclass-sim` = `./dist/gen.js`) | `build`, `typecheck`, `test` | `tsup` (entries `gen`, `worker`, `index`, `smoke`; `node22`; `@genclass/runtime` external), `tsc -p tsconfig.json --noEmit`, `vitest run` |
| | `gen` / `sample` | `node dist/gen.js` / `node dist/gen.js --sample` |
| | `build:runtime-core` | `cd ../packages/runtime && tsup src/index.ts --no-config --format esm --target es2022 --platform neutral --out-dir dist --external onnxruntime-web --external onnxruntime-web/webgpu --sourcemap` |
| `@genclass/demos` (`0.1.0`, private) | `dev` / `build` / `preview` | `vite` / `node scripts/build.mjs` / `node --experimental-strip-types e2e/serve.ts dist --base /genclass/ --port 4173` |
| | `typecheck` / `typecheck:shim` | `tsc -p tsconfig.json` (or `tsconfig.shim.json`) `--noEmit && tsc -p tsconfig.sw.json --noEmit && tsc -p tsconfig.node.json --noEmit` |
| | `fetch-model` | `bash scripts/fetch-model.sh public/genclass-model` |
| | `eval` / `eval:fast` / `shots` | `node --experimental-strip-types e2e/eval.ts` (`--fast` / `--shots-only`) |

Demos devDeps pin the same `@playwright/test` `1.63.0` as the runtime and use `vite ^8.3.3`.

Details: [../sim.md](../sim.md), [../demos.md](../demos.md).

### Exact commands

```sh
# on the VM, through your slot (from the repo root on the Mac)
scripts/vm.sh run core 'npm install && npm run build'
scripts/vm.sh exec core 'npm run typecheck -w @genclass/runtime'            # or: cd packages/runtime && npx tsc -p tsconfig.json --noEmit
scripts/vm.sh exec core 'cd packages/runtime && GENCLASS_MODEL_DIR=~/gcl/model/.cache-model NODE_OPTIONS=--expose-gc npx vitest run'
scripts/vm.sh exec core 'cd packages/runtime && npx vitest run test/atoms.test.ts -t "late discard"'   # one file / one test
scripts/vm.sh exec model 'cd packages/runtime && GENCLASS_MODEL_DIR=~/gcl-cache/model-v0.1 npx vitest run test/model'
scripts/vm.sh exec model 'cd packages/runtime && GENCLASS_MODEL_DIR=~/gcl-cache/model-v0.1 npm run test:browser'   # add --project chromium | swiftshader-webgpu
scripts/vm.sh exec model 'cd packages/runtime && GENCLASS_MODEL_DIR=~/gcl-cache/model-v0.1 npx playwright test --config test/browser/playwright.config.ts model.spec.ts -g "inline fallback"'   # one spec / one test
scripts/vm.sh exec core 'cd packages/runtime && npx playwright test --config test/browser/ui/playwright.config.ts'
scripts/vm.sh exec core 'cd packages/runtime && bash test/smoke/smoke.sh'
scripts/vm.sh exec core 'cd packages/runtime && npm pack --dry-run'          # list tarball contents (files: dist, bin, README.md, LICENSE)
scripts/vm.sh exec sim  'npm run build && cd sim && SIM_RUNTIME=real npx vitest run'   # sim tests against the real runtime
# one-time per machine (not in any repo script; unverified that the VM needed it): npx playwright install chromium
# fetch the v0.1 model for the model tests (command from packages/runtime/src/model/README.md; default --variant all)
scripts/vm.sh exec model 'node packages/runtime/bin/genclass-runtime.mjs fetch-model ~/gcl-cache/model-v0.1 --from https://github.com/MeharPro/GenClass/releases/download/v0.1.0/'
```

The two `GENCLASS_MODEL_DIR` paths above are the ones written in `packages/runtime/STATUS.md` and `packages/runtime/src/model/README.md`; which of them exists on the VM is unverified.

### Where to run things

- **Team rule** (`docs/runtime/CONTRACT.md` §0 rule 5, `scripts/vm.sh` header): the Mac only edits files; every build, test, browser and model run goes through `scripts/vm.sh` on the `train` VM. The reason is RAM: the original author's Mac has 8 GB.
- **Lead policy for agents (2026-10-07):** on any other machine, run these locally; they are light and were verified (next section):
  - `npm install` at the repo root;
  - typecheck and build of `packages/runtime`;
  - the runtime unit tests (vitest, browser specs excluded).
- **Ask the user first** before running any of:
  - the sim (`sim/` generation or tests, `sim/scripts/*`);
  - training (`training/*.sh`, Python training or tests);
  - Playwright (`npm run test:browser`, the UI spec, `test/smoke/smoke.sh`, which also installs from the npm registry);
  - model downloads (`genclass-runtime fetch-model`, `demos/scripts/fetch-model.sh`);
  - the demos' eval (`demos/scripts/vm-eval.sh`, `npm run eval` in `demos`);
  - any script that touches Azure (`scripts/*.sh`, including `scripts/vm.sh`).
- On the original 8 GB Mac, the team rule still applies.

### Verified locally (2026-10-07)

These were run at 654d822, when these docs were written, on a macOS machine (16 GB RAM, 10 CPUs, Node v25.6.0, npm 11.8.0):

| step | command (directory) | result | time |
|---|---|---|---|
| install | `npm install` (repo root) | OK, 134 packages; one EBADENGINE warning (below) | ~18 s |
| typecheck | `npx tsc -p tsconfig.json --noEmit` (`packages/runtime`) | clean | ~1.6 s |
| build | `npx tsup` (`packages/runtime`) | 6 entries (`index`, `adapters/react`, `adapters/redux`, `adapters/zustand`, `devtools/index`, `worker`), `.d.ts` for all but `worker`; `dist/` ~1.6 MB including source maps; largest JS chunk ~258 KB and `dist/devtools/index.js` ~68 KB, both unminified | ~2.5 s |
| unit tests | `NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**"` (`packages/runtime`) | Test Files 36 passed \| 1 skipped (37); Tests 286 passed \| 14 skipped (300) | ~2.4 s |

- **The 14 skipped tests** are model-parity tests that need model files in `GENCLASS_MODEL_DIR` (default `<repo>/.cache-model`), which did not exist on that machine:
  - `test/model/packer.test.ts`: all 10 (the one fully skipped file);
  - `test/model/engine.test.ts`: 3 of 4;
  - `test/model/calibrate.test.ts`: 1 of 8.

  With a model directory present (as on the VM, per STATUS) all 300 pass. Getting one means a model download: ask the user first.
- **EBADENGINE warning.** `vitest@5.0.3` declares `engines.node` `^22.12.0 || ^24.0.0 || >=26.0.0`. Node 25 is outside that range, so npm warns, but the tests run. Node 22.x from 22.12, 24.x and 26+ are inside it; 23.x and 25.x are not. The VM runs Node 22, but the repo does not record its minor version.
- **Install side effects.** The root `npm install` changes two things git sees:
  - It creates an untracked root `package-lock.json`, because the repo has never committed one. Do not commit it unless the lead decides to (see "No committed lockfile" under gotchas). Delete it, or leave it untracked.
  - It chmods `packages/runtime/bin/genclass-runtime.mjs` to 755, so `git status` reports a mode change from the committed 100644. Revert it with `git checkout -- packages/runtime/bin/genclass-runtime.mjs`.
- **Not run in that pass:**
  - Playwright browser specs (main and UI configs);
  - `test/smoke/smoke.sh`;
  - the sim, training, the demos, Python tests, model downloads, anything on Azure.
- **No CI** re-runs any of this: there is no `.github/` directory.

## Configuration and constants

| name | type | value | defined in | effect |
|---|---|---|---|---|
| `target` / `module` / `moduleResolution` | tsc | `ES2022` / `ESNext` / `Bundler` | `tsconfig.base.json` | ESM, bundler-style resolution (uses `exports`) |
| `lib` | tsc | `ES2022, DOM, DOM.Iterable, WebWorker` | `tsconfig.base.json` | browser + worker globals |
| `strict`, `noImplicitOverride`, `isolatedModules`, `verbatimModuleSyntax` | tsc | `true` | `tsconfig.base.json` | type-only imports must use `import type` |
| `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | tsc | `false` | `tsconfig.base.json` | |
| `declaration`, `sourceMap`, `resolveJsonModule`, `esModuleInterop`, `skipLibCheck`, `useDefineForClassFields` | tsc | `true` | `tsconfig.base.json` | |
| `types` | tsc | `[]` | `packages/runtime/tsconfig.json` | no `@types/node` in `src/`: src must not use Node APIs |
| `include` | tsc | `["src"]` | `packages/runtime/tsconfig.json` | tests are not type-checked |
| `jsx` | tsc | `react-jsx` | `packages/runtime/tsconfig.json` | |
| tsup `format` / `target` / `platform` | build | `["esm"]` / `es2022` / `browser` | `tsup.config.ts` | |
| tsup `splitting` / `treeshake` / `sourcemap` / `clean` | build | `true` | `tsup.config.ts` | `clean` wipes `dist/` at build start |
| tsup `external` | build | `onnxruntime-web`, `onnxruntime-web/webgpu`, `react`, `redux`, `zustand` | `tsup.config.ts` | |
| vitest `include` / `exclude` | test | `test/**/*.test.ts` / `test/browser/**` | `vitest.config.ts` | |
| vitest `environment` / `testTimeout` | test | `node` / `20000` ms | `vitest.config.ts` | per-file override for happy-dom; model tests set `600_000` / `900_000` |
| Playwright `timeout` / `expect.timeout` | test | `600_000` / `30_000` ms | `test/browser/playwright.config.ts` | |
| Playwright `workers` / `fullyParallel` | test | `1` / `false` | both configs (`fullyParallel` main only) | serial |
| Playwright projects | test | `chromium` (ignores `*webgpu.spec.ts`); `swiftshader-webgpu` (matches it; args `--enable-unsafe-webgpu --enable-unsafe-swiftshader --use-webgpu-adapter=swiftshader`) | `test/browser/playwright.config.ts` | |
| Playwright `outputDir` | test | `packages/runtime/test-results/browser` / `.../test-results/ui` | main / UI config | |
| UI config `timeout`, viewport, DPR | test | `90_000` ms, 1280x800, `deviceScaleFactor: 2` | `test/browser/ui/playwright.config.ts` | screenshot geometry |
| `FakeClock.t` start | test | `1000` | `test/helpers.ts` | facts/timelines in tests are relative to it |
| `drain(rounds)` / `flush` loop / `runAll(maxMs)` | test | `4` / `50` / `120_000` | `test/helpers.ts` | |
| `FakeServer` defaults | test | latency `50` ms, status `200`, JSON body, unknown route -> `404 {"error":"not found"}`, base `http://app.test/` | `test/helpers.ts` | routing key is `METHOD pathname` (query ignored) |
| `makeGlobal` location | test | `http://app.test/search` (pathname `/search`) | `test/helpers.ts` | why situations say `app: /search` |
| `choice(label, labels, p)` | test | `p = 0.97`; rest split evenly; confidence `(k*p - 1)/(k - 1)` | `test/helpers.ts` | |
| `PARITY_IDS` | test | `[0, 7, 13, 21, 29, 36, 42, 49]` | `test/browser/model-helpers.ts` | browser parity requests |
| model test `MODEL_DIR` | env | `$GENCLASS_MODEL_DIR` else `<repo>/.cache-model` | `test/model/helpers.ts`, `test/browser/model-helpers.ts` | |
| `vm.sh` `TIMEOUT` | env | `1800` s (remote cmd); sync mkdir `300` s, rsync `600` s, scp `600` s, ssh `ConnectTimeout=20` | `scripts/vm.sh` | |
| smoke port / versions | script | `4191`; `vite@8`; `@playwright/test@1.63.0` | `test/smoke/smoke.sh` | |
| `@playwright/test` | devDep | `1.63.0` (exact) | `packages/runtime/package.json` | Chromium build must match |
| other devDeps | devDep | `esbuild ^0.27.0`, `happy-dom ^20.14.5`, `onnxruntime-node 1.30.0`, `tsup ^8.5.1`, `vitest ^5.0.3`, `typescript ~5.9.3`, `react`/`react-dom ^19.3.0`, `@types/react`/`@types/react-dom ^19.0.0`, `redux ^5.0.1`, `zustand ^5.0.15` | `packages/runtime/package.json` | |
| `dependencies` | dep | `onnxruntime-web ^1.30.0` (only runtime dependency; CONTRACT §0 rule 6 forbids others without the lead) | `packages/runtime/package.json` | |
| `peerDependencies` | peer | `react >=18`, `redux >=4`, `zustand >=4`, all optional | `packages/runtime/package.json` | |
| `sideEffects` | pkg | `false` | `packages/runtime/package.json` | bundlers may drop unused imports |
| `engines.node` | pkg | `>=20` (root and runtime) | `package.json`s | VM runs Node 22 |
| `DEFAULT_MODEL_BASE_URL` | const | `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/` | `src/model/host.ts` | default model location = the unpublished package |
| CLI `DEFAULT_FROM` | const | `https://github.com/daybot-solutions-inc/GenClass-lib/releases/download/runtime-model-v0.1.0/` | `bin/genclass-runtime.mjs` | default `fetch-model --from` (planned release) |
| test env vars | env | `GENCLASS_MODEL_DIR`, `NODE_OPTIONS=--expose-gc`, `GENCLASS_BENCH_MODELS="name=dir,..."`, `GENCLASS_WEBGPU_VARIANTS=<dir>`, `GENCLASS_OFFLINE=1` | test files | see Tests |
| `HAVE_MODEL` | test | `existsSync(<MODEL_DIR>/model.json)` | `test/browser/model-helpers.ts` | every model spec calls `test.skip(!HAVE_MODEL, ...)` |
| `DEFAULT_CACHE_NAME` | const | `"genclass-runtime-v1"` | `src/model/loader.ts` | Cache Storage bucket; default of `window.GC.cacheKeys()` |
| browser parity bounds | test | `model.spec.ts`: agree >= total - 1 and max \|p - p_torch\| < `0.06`; `model-webgpu.spec.ts`: agree >= total - 1 (model dir on WebGPU), >= total - 2 (embedding variants), no probability bound | the two specs | `model.spec.ts` compares over `PARITY_IDS`; `model-webgpu.spec.ts` over `[0, 13, 29, 49]` |
| lazy fail-open bound | test | wall < `50` ms | `test/browser/model.spec.ts` | a decision before the model is ready must fail open at once |
| `benchSizes` defaults | test | `runs = 10`, `targets = [600, 1000]` state tokens | `test/browser/model-helpers.ts` | `sizedRequest` binary-searches `situation(size)` over size 0..260 (size fills facts and sections first, the rest becomes timeline lines) with `GC.measure` |
| `transferReport` compression | test | gzip level 9; brotli quality 11 (files <= 2 MB) / 9 (larger) | `test/browser/model-helpers.ts` -> `sizes` | numbers in `test-results/model-bench/transfer.json` |
| `server.mjs` bind | test | `127.0.0.1`, port `0` (random) | `test/browser/server.mjs` -> `startServer` | |
| `isV01Tokenizer` | test | 50,009 merges and 50,280 vocab entries | `test/model/helpers.ts` | gates the HF edge-case tokenizer tests |
| `make_py_fixtures.py` constants | script | `n_merges = 16000` (pruned vocab 16,364, markers 16359..16363); `random.Random(7)`; fallback v1 calibration `{"noul": 1.4, "choice": 0.7, "score": 0.9, "by_header": {}}` when `<tokenizer dir>/calibration.json` is absent | `test/fixtures/model/make_py_fixtures.py` -> `main` | regenerating with another tokenizer or calibration changes `py_fixtures.json` |

## Invariants and gotchas

- **Do not run builds or tests on the original 8 GB Mac.** That is the binding team rule. Elsewhere the run policy in AGENTS.md allows the light checks locally and requires the user's OK for everything heavier ([Where to run things](#where-to-run-things)). `vm.sh` needs `~/.jev-local/azure_hosts` (a `train` line) and `~/.ssh/jev_azure`, neither of which is in the repo. It also calls GNU `timeout` on the local machine, which macOS does not include by default. Without all three, `vm.sh` cannot reach a VM. If you have no VM, ask the user; do not quietly run heavy jobs locally.
- **`dist/` must exist before anything consumes the package.** `sim`, `demos` and demo typechecking resolve `@genclass/runtime` through `exports` -> `dist/`. Root `npm run typecheck` therefore needs `npm run build` first (demos' `typecheck` reads `dist/*.d.ts`; `typecheck:shim` avoids it). The demos typecheck (and `typecheck:shim`) also needs the missing `demos/src/server/data/cities.ts` (see [../demos.md](../demos.md#drift-and-open-issues) Drift 1): `demos/tsconfig.json`, `tsconfig.shim.json` and `tsconfig.sw.json` all include `src/server/worlds/search.ts`, which imports it, so the root `npm run typecheck` fails with a missing-module error in this checkout until that file is recreated (inferred from the configs; tsc was not run).
- **`clean: true` + a failed build = a half-empty `dist/`.** `demos/scripts/vm-eval.sh` refuses to measure after a failed runtime build for this reason (`ALLOW_BROKEN_RUNTIME=1` overrides).
- **`npm run test:browser` rebuilds `packages/runtime/dist/`** (its global setup runs `npx tsup`). Do not run it in a slot where another job is reading `dist/`.
- **Keep tsup entries as literal `"src/...ts"` strings.** `build.mjs` -> `fullBuildPossible` finds them with a regex over the config text.
- **Keep the worker URL pattern and the two `import("onnxruntime-web/webgpu" | "onnxruntime-web/wasm")` literals.** Bundlers (Vite, webpack) recognise them; `build.mjs` fails if either disappears from the output.
- **Tests are not type-checked** (`tsconfig.json` `include: ["src"]`; vitest strips types). A test can drift from the public types and still pass; `MockRuntime` in particular is "not type-checked" (STATUS).
- **Unit tests import from `test/browser/ui/`** (`mock-runtime.ts`, `scenario.ts`, `session.ts`). The vitest exclude only stops test discovery there; moving or renaming those files breaks `adapters-*.test.ts`, `devtools*.test.ts`.
- **Determinism.** Runtime code uses only the injected `Clock` (CONTRACT §0 rule 3). Tests assert byte-identical situations across runs (`situation.test.ts` "determinism", `budget.test.ts` "byte-identical"). Never use `Date.now`, `performance.now`, `Math.random` or the global `setTimeout` directly in `src/` (rule 3 names all of them); in tests use `FakeClock`, not real timers. Exceptions: wall-time measurements with `performance.now` in `review-perf.test.ts`, `test/model/engine.test.ts` and `test/model/packer.test.ts`, the real `browserClock` in `test/model/loader.test.ts`, and the 40 ms real `setTimeout` "frame" waits in `devtools.test.ts` / `devtools-runtime.test.ts`.
- **Wall-clock thresholds in `review-perf.test.ts`** (user write < 1 ms, async write < 2 ms, redux dispatch < 1 / < 2 ms, settled point < 16 ms on 5,000-item stores) can fail on a loaded machine. STATUS measured on the shared VM: keystroke write 0.14 ms, gated async write 0.19 ms, redux dispatch 0.68 ms (user) / 0.58 ms (async), settled point 0.2 ms (+1.4 ms with an unchanged 5,000-item adapter store).
- **The gc test passes silently without `--expose-gc`.** `review-timers.test.ts` "a polling loop does not retain..." logs `[review] skipped: run with NODE_OPTIONS=--expose-gc` and returns.
- **Review tests are a contract.** Never edit `test/review-*.test.ts` to make them pass; fix `src/`.
- **Situation wording is frozen at `situation-v1`.** `situation.test.ts`, `budget.test.ts` and `batch3.test.ts` assert exact fact sentences (regexes / `toContain`), and `invariants.test.ts`, `review-fetch.test.ts`, `review-hub.test.ts` assert fact fragments; `report.test.ts`, `atoms.test.ts`, `fetch.test.ts`, `learn.test.ts` assert report / reason / `changed` wording. SIM training data was generated from that tag. The example situations in `packages/runtime/STATUS.md` are copied from the `console.log` output of `situation.test.ts` and `budget.test.ts`. Coordinate any wording change with SIM (STATUS "Open issues").
- **Browser parity fixtures are v0.1-only.** `test/browser/model-helpers.ts` always reads `test/fixtures/model/{requests50,pack_fixtures,torch_fixtures}.json`, so `model.spec.ts` parity assertions only hold when `GENCLASS_MODEL_DIR` is the v0.1 GenClass model. The unit tests switch to an export's own fixtures (`FIXTURES_FROM_MODEL`); the browser specs do not.
- **The default Playwright config also runs `ui-devtools.spec.ts`.** Its `chromium` project matches every `*.spec.ts` except `*webgpu.spec.ts`, so `npm run test:browser` also re-runs the UI spec. That run uses Playwright's default viewport and device scale factor (the main config sets neither) and overwrites the committed screenshots. Use the UI config to regenerate screenshots.
- **The UI spec needs the demos workspace installed** (fonts come from `@fontsource-variable/*`, dependencies of `demos`, hoisted to `<repo>/node_modules`). Run a root `npm install`, not one scoped to the runtime.
- **Node version.** `test/model/helpers.ts` -> `pythonOnlyFloatRequests` uses `JSON.parse` source-text access (Node >= 21). On Node 20 it finds nothing, so fixtures holding Python-only float literals such as `25.0` would not be skipped by the packer parity test. Use Node 22 as on the VM. Node 25.6.0 also ran the unit tests in the 2026-10-07 pass, with an EBADENGINE warning from vitest ([Verified locally](#verified-locally-2026-10-07)).
- **Global singletons in tests.** `report.test.ts` and `batch3.test.ts` use `GenClass.init`; always `GenClass.destroy()` (and delete `globalThis.location` if you set it). happy-dom tests patch `window` globals: `rt.destroy()` in `afterEach`. `review-hub.test.ts` swaps `process` `unhandledRejection` listeners and restores them in `finally`.
- **Network-dependent steps:** `smoke.sh` (npm registry), `model.spec.ts` "default ORT wasm path" (jsDelivr; `GENCLASS_OFFLINE=1` skips it), `fetch-model` (GitHub).
- **Fixture JSON files are single-line.** `wc -l` prints `0` for `pack_fixtures.json` (955,379 bytes), `py_fixtures.json` (167,629), `requests50.json` (285,309) and `torch_fixtures.json` (255,945): no trailing newline, not empty. Use `wc -c` or a JSON parser.
- **No `prepublishOnly` and no `publishConfig`.** `npm publish` packs whatever `dist/` holds; build right before publishing. Scoped packages publish as restricted unless `--access public` is passed (npm behaviour).
- **No committed lockfile.** The root `package-lock.json` has never been in git, so `npm ci` fails on a fresh clone and dependency versions float within the `^` ranges (only `@playwright/test 1.63.0`, `onnxruntime-node 1.30.0` and `typescript ~5.9.3` are pinned tightly). A root `npm install` writes one, which shows up as untracked; committing it is a lead decision (it would fix CI reproducibility).
- **`sim`'s `build:runtime-core` leaves a partial `dist/`.** It writes only `dist/index.js` (+ chunks, maps; `--platform neutral`, no `.d.ts`, no adapters/devtools/worker) and does not clean (tsup CLI default), so whatever an earlier full build left stays. `demos/vite.config.ts` picks the real runtime whenever `dist/index.js` exists, so after this build on an empty `dist/` demos resolve `@genclass/runtime/react` etc. to files that do not exist (and the demos typecheck finds no `.d.ts`). Run the full `npm run build` before working on demos.
- **vitest `exclude` replaces the defaults.** `vitest.config.ts` sets `exclude: ["test/browser/**"]` rather than extending vitest's default exclude list. Harmless while `include` is `test/**/*.test.ts`; use `[...configDefaults.exclude, "test/browser/**"]` if `include` is ever widened.
- **A checkout may hold stale local artefacts.** `dist/`, `node_modules/`, `test/browser/.build/`, `test-results/` and `*.tgz` are ignored, so a working copy can contain a `dist/` built from older sources. Rebuild before trusting `dist/`, `sim` real-runtime runs or demo results.
- **Unanchored ignores.** `.gitignore` entries `data/`, `models/`, `runs/` (and `dist/`) match directories at any depth: a new `src/models/` folder would be silently ignored. Check `git check-ignore -v <path>` when a new file does not show up.
- **Playwright browsers are a prerequisite.** Nothing in the repo runs `npx playwright install`; `test:browser`, the UI spec and `smoke.sh` assume Chromium for `@playwright/test` `1.63.0` is already installed. The SwiftShader project additionally needs a Chromium build with WebGPU (the spec skips when no adapter appears).
- **`loader.test.ts` uses the real clock.** It passes `browserClock` (not a fake) to `ModelBackend`; the WebGPU session-timeout case waits real time (`sessionTimeoutMs: { webgpu: 30 }`, 30 ms per plan). Keep such timeouts tiny, or inject a fake clock, when adding timing cases there.
- **Fixture byte identity.** The committed `pack_fixtures.json` / `torch_fixtures.json` are compact (no-whitespace) re-serialisations of `extension/test/fixtures/*`; they differ byte-wise from the extension copies and from `genclass_export.py`'s `json.dumps` output, but are identical once whitespace is removed. Compare parsed JSON, not hashes.
- **`make_py_fixtures.py` imports the Python reference from the repo.** `ROOT = Path(__file__).resolve().parents[5]` (the repo root) is put on `sys.path` and `jev_local.{confidence,serialize,schema,engine.encoder.calibrate}` are imported from there. Moving the script changes `ROOT`. The parity tests' Python counterparts are `jev_local/engine/encoder/tokenize_pack.py` (packer), `jev_local/serialize.py`, `calibrate.py`, `confidence.py` (named in the test headers).

## How to change it safely

### Write a new unit test (house style)

1. Put it in `packages/runtime/test/<area>.test.ts` (`test/model/` for model code). Import with `.js` extensions (`./helpers.js`, `../src/...js`).
2. Use `setup()` and drive time with `clock.advance` / `clock.flush`. Use `triage: "always"` to force a model consultation, `mode: "heal"` for heal-tier actions, `ManualDecider` to control answer timing.
3. Name the contract section in the `describe` (e.g. `"(CONTRACT §4)"`). For a bug demonstration, follow the `review-*.test.ts` files: a header comment `// REVIEW: <area>. A failing test demonstrates a bug.`, a `describe("review: ...")`, and a test name that states the required behaviour.
4. For DOM: first line `// @vitest-environment happy-dom`, then `createRuntime({ clock: new FakeClock(), global: window, decider, report: "silent", observe: { ...OFF, user: true } })` where `OFF` sets `fetch, xhr, errors, nav, storage, perf, websocket, timers` to `false` (copy it from `dom.test.ts`), and `rt.destroy()` in `afterEach`.
5. For model files: `describe.skipIf(!hasModelFile("model.json"))`.

```ts
import { describe, expect, it } from "vitest";
import { ManualDecider, defaultScript, setup } from "./helpers.js";

describe("my change (CONTRACT §4)", () => {
  it("holds an async write until the model answers", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always" });
    const a = rt.atom("v", 0);
    void rt.op("save", () => a.set(5));
    expect(a.get()).toBe(0); // held
    manual.answer(defaultScript({ mutation: { diagnosis: "expected", action: "apply" } }));
    await clock.flush();
    expect(a.get()).toBe(5);
  });
});
```

Run it locally (`cd packages/runtime && npx vitest run test/<file>.test.ts`) or on the VM: `scripts/vm.sh run core 'cd packages/runtime && npx vitest run test/<file>.test.ts'` ([Where to run things](#where-to-run-things)).

### Add a browser spec

1. Model host: `test/browser/<name>.spec.ts` (a name ending `webgpu.spec.ts` runs only in the `swiftshader-webgpu` project; `ui-*.spec.ts` is also picked up by the UI config). Start with `test.describe.configure({ mode: "serial" })` and `test.skip(!HAVE_MODEL, ...)`, then `const srv = useServer()` at file level.
2. In each test: `const { page, logs } = await openApp(browser, srv.url)`, `await create(page, { baseUrl: "/model/", device: "wasm", preload: "eager", ortWasmPaths: "/ort/" })`, `await ready(page)`, then `evaluate(page, fixtureRequest(i))` / `parityRun(page)`; assert `logs` has no `[pageerror]`. Use `/coi/model/` + `/coi/ort/` with `openApp(..., { coi: true })` for threads.
3. The page can only call what `page/main.ts` exposes on `window.GC`, and `main.ts` only imports `"genclass-dist"` (the built `dist/index.js`, or `src/model/index.ts` in the model-entries build). New host features must be exported from both entry points to be testable here.
4. Persist numbers with `saveResults("<name>", {...})` (merged into `test-results/model-bench/<name>.json`, not Playwright's `outputDir`, which is emptied each run).

### Add a public entry point (new subpath export)

1. Add the entry to `tsup.config.ts` `entry` **and** `dts.entry` (keep the `"src/...ts"` literal form).
2. Add `"./<name>": { "types": "./dist/<name>.d.ts", "import": "./dist/<name>.js" }` to `packages/runtime/package.json` `exports`.
3. If demos import it, add a shim to `demos/src/dev/runtime-shim/`, an alias in `demos/vite.config.ts` and a path in `demos/tsconfig.shim.json`.
4. Build locally (`npx tsup`). Then, with the user's OK (ask first), run `bash test/smoke/smoke.sh`, extending `src/main.js` in the script to import the new subpath.

### Change situation text, facts or questions

1. Edit `src/situation/*` only (single implementation shared with `sim/`).
2. Update the exact-text assertions in `test/situation.test.ts`, `test/budget.test.ts`, `test/batch3.test.ts`, `test/invariants.test.ts`, `test/review-fetch.test.ts`, `test/review-hub.test.ts` (facts) and, for report wording, `test/report.test.ts`, `test/atoms.test.ts`, `test/fetch.test.ts`, `test/learn.test.ts` (search for the old sentence). Changing a `review-*` assertion conflicts with "Review tests are a contract" (gotchas): raise it rather than rewrite it silently.
3. Re-run `situation.test.ts` and `budget.test.ts`, paste their printed situations into the STATUS.md example sections.
4. Tell SIM: rows must be regenerated, and models trained on `situation-v1` data were trained on the old text. See [learn-situation-triage.md](learn-situation-triage.md) and [../model-io-contract.md](../model-io-contract.md).

### Regenerate model fixtures

- `py_fixtures.json` (needs the jev venv: `tokenizers`, `numpy`, `pydantic`, and the v0.1 tokenizer so `isV01Tokenizer` passes):
  `~/jev/.venv/bin/python packages/runtime/test/fixtures/model/make_py_fixtures.py --tokenizer <model dir>/tokenizer.json --out packages/runtime/test/fixtures/model/py_fixtures.json`
  It also reads `<model dir>/calibration.json` when present for the v1 calibration cases.
  The script prints `wrote <out>: <n> states, <n> texts, <n> calibration cases, <n> confidence cases` and writes one line (`json.dumps(..., ensure_ascii=False)`, no trailing newline). `~/jev/.venv` is the venv `scripts/vm_bootstrap.sh` creates (CPU torch, `tokenizers`, `numpy`, `pydantic>=2`, ...).
- WebGPU embedding variants (written outside the repo, used via `GENCLASS_WEBGPU_VARIANTS`; `--src` must be a runtime-card model dir with a q8 variant; needs `onnx` + `numpy`, and `onnx` is not in `vm_bootstrap.sh`'s pip list):
  `~/jev/.venv/bin/python packages/runtime/test/fixtures/model/make_webgpu_variants.py --src ~/gcl-cache/model-v0.1 --out ~/gcl-cache/webgpu-variants`
  Writes `f32emb/` (fp32 embedding table: `Gather(fp32)`) and `i8emb/` (int8 table + per-row fp32 scale: `Gather(int8) -> Cast -> Mul(Gather(scale))`).
- `pack_fixtures.json` / `torch_fixtures.json`: outputs of `scripts/genclass_export.py` or `extension/tools/genclass_export.py` (identical fixture code; which one produced the committed files is not recorded). Both export the extension's v1 computer-use model, import torch and say "RUN ON THE AZURE VM ONLY"; the fixtures are Python `Packer` output and PyTorch logits, so they do not depend on the int8 vs q8 ONNX variant. They were copied from `extension/test/fixtures/` and re-serialised compactly. Do not hand-edit them; the browser parity specs depend on them matching the v0.1 model. If you regenerate, re-serialise without whitespace to keep diffs comparable, and regenerate `requests50.json` from the same request set.

### Publish history (from git)

| when (commit time) | commit / tag | what |
|---|---|---|
| 2026-10-07 19:19 -0400 | tag `situation-v1` -> 1a77558 | runtime fix batch 3; situation format frozen for SIM data |
| 2026-10-07 20:09 -0400 | 59c213f | `version` `0.1.0` -> `0.1.0-alpha.0`, `packages/runtime/LICENSE` added, `test/smoke/smoke.sh`, `.gitignore` gains `.publish/` and `*.tgz` |
| between 59c213f and 654d822 | (npm) | `@genclass/runtime@0.1.0-alpha.0` published; OPEN_TASKS: "2026-10-08, `genclass` org, owner meharpro", smoke-tested first |
| 2026-10-07 20:15 -0400 (00:15 UTC 10-08) | 654d822, tag `v0.1.0-alpha.0` (tagged 20:15:12 -0400) | both READMEs get an npm badge (`/npm/v/@genclass/runtime/latest`), a license badge and an "alpha" status note (the `npm install @genclass/runtime` lines were already there); OPEN_TASKS moves publish to "Done" and rewrites item 8 |

Before 654d822, OPEN_TASKS "Needs the user" listed the prerequisites: "an `@genclass` npm org and `npm login` on this machine (not logged in), or another scope name". The exact `npm publish` flags (dist-tag, `--access`) and what `.publish/` was used for are not recorded (unverified).

### Cut a release of `@genclass/runtime` (reconstructed; there is no script)

1. Locally: `npm install`, `npm run build`, `npm run typecheck -w @genclass/runtime`, the unit tests with `--expose-gc`. With the user's OK (ask first): vitest with `GENCLASS_MODEL_DIR`, the browser specs and `bash test/smoke/smoke.sh`, locally or on the VM ([Where to run things](#where-to-run-things)).
2. Bump `version` in `packages/runtime/package.json` (and the version strings in READMEs/OPEN_TASKS).
3. From `packages/runtime` on a machine logged in to npm with publish rights on the `genclass` org: `npm publish --access public` (add `--tag alpha` or similar for prereleases; the flags used for `0.1.0-alpha.0` are not recorded, unverified).
4. `git tag -a vX.Y.Z -m "@genclass/runtime X.Y.Z (npm)"` and push the tag. Update `OPEN_TASKS.md` "Done".
5. The user must approve any publish; it is an irreversible public action.

### Publish the model package (planned, OPEN_TASKS item 8)

1. Put a model directory (card `genclass-runtime-model/1`: `model.json`, `<name>-q8.onnx`, `<name>-fp16.onnx`, `tokenizer.json`, `calibration.json`, `meta.json`) under `packages/runtime-model/files/` (gitignored), so jsDelivr serves it at `DEFAULT_MODEL_BASE_URL`. Check it with `node packages/runtime/bin/genclass-runtime.mjs info packages/runtime-model/files`.
2. Add `packages/runtime-model/package.json` (`@genclass/runtime-model`, `0.1.0`, `files` including `files/`). It then becomes a workspace automatically (`packages/*`).
3. Attach the same files to a GitHub release tagged `runtime-model-v0.1.0` (the CLI's `DEFAULT_FROM`).
4. Then publish `@genclass/runtime@0.1.0` without a prerelease tag.

### Add CI (planned, OPEN_TASKS item 8)

No workflow exists (no `.github/`, no other CI config anywhere in the repo). A minimal one (`.github/workflows/*.yml`, Node 22 (≥ 22.12) or 24, inside vitest 5.0.3's engine range (23 and 25 are outside)) would run: `npm install` (or commit a root `package-lock.json` first and use `npm ci`; none is tracked today), `npm run build`, `npm run typecheck -w @genclass/runtime`, `NODE_OPTIONS=--expose-gc npm test`. Without a model directory the 14 model-file tests skip. The root `npm run typecheck` also typechecks `sim` (no build needed) and `demos` (needs the full build first, and fails until the missing `demos/src/server/data/cities.ts` is recreated; see [../demos.md](../demos.md#drift-and-open-issues) Drift 1). Browser specs would additionally need `npx playwright install --with-deps chromium` and a model directory; the smoke test needs registry access. Treat `review-perf.test.ts` wall-clock bounds as possibly flaky on shared runners.

## Tests

Counts are `it(...)` cases (the `budget.test.ts` loop counts 3). The total of 300 matches STATUS (300 total, UI 53, MODEL 62) and the 2026-10-07 vitest run (300 tests: 286 passed, 14 model-file tests skipped; see [Verified locally](#verified-locally-2026-10-07)); the remaining 185 are CORE 142 + REVIEW 43.

| test file | owner | env | tests | what it asserts |
|---|---|---|---|---|
| `test/adapter-seam.test.ts` | CORE | node | 4 | `rt.adapter(name, io).propose({fn, commit})`: reducer preview, async dispatch held then committed, discard never commits, direct library changes recorded not held, rollback offered only when `io.set` exists |
| `test/adapters-react.test.ts` | UI | happy-dom | 9 | `useGenClassState` (one atom per name, held write shown only when applied, StrictMode-safe, plain-state fallback with one `console.info` "no runtime"), `useAtom`, `useGenClass` throws "No runtime", live `useGenClassDecisions/Interventions/Status`; with the real runtime: hold, discard, undo; user-handler writes never held |
| `test/adapters-redux.test.ts` | UI | node | 11 | `genclassEnhancer`: passthrough, hold/apply once (reducer runs once), re-run on moved state, drop, middleware/thunks see the action once, no-op actions, `replaceReducer`, inner enhancers see `GENCLASS_REPLACE` for GenClass writes, `null` runtime; real runtime hold/discard/undo |
| `test/adapters-zustand.test.ts` | UI | node | 6 | `genclass(rt, name)` middleware: merge semantics, hold/drop, replace/functional/no-op/extra `set` args, GenClass whole-state writes, `null` runtime; real runtime |
| `test/ask.test.ts` | CORE | node | 5 | `ask()` typed answers (choice/noul/score), trigger `ask`, `about` an op or store, `decide()`, `GenClassUnavailableError` without a model (status `off`), timeout reason `timeout` |
| `test/atoms.test.ts` | CORE | node | 16 | mutation pipeline: user-sync writes never held, async held then applied, fail-open at `holdBudgetMs` + late discard revert + undo, no late revert when superseded / after 2 s / same chain wrote again, late defer only recorded, provider errors (`not_ready`, `max_tokens_exceeded`, `timeout`, `busy`) fail open at once, proposal order, functional re-run, patch re-apply, discard + undo, defer max 2, `hold: false`, `guard()`, same-name atoms, field versions/writers |
| `test/batch3.test.ts` | CORE | node | 13 | SIM requests a–f (word-level redaction, kanban card values, no `= undefined` state lines, item change summaries, "changed twice ... back to 6", slug ids via `normalizePath`/`isIdSegment`, pending-local-change fact), `ctx.builtin` through the gate, rate-limit warning once per minute, `ask()` after destroy, read-only globals, `GenClass.init` never throws, never-answering provider, `transient` label last |
| `test/budget.test.ts` | CORE | node | 12 | `sectionLimits` at 500/1,100/2,000/3,200; budgets 1,000/1,100/2,000 shape every section; compact questions at <= 1,400; vocabulary overrides <= 24 chars kept; determinism; auto budget (webgpu 3,200; wasm 1,000/1,333/2,000; unknown 3,200; fixed 1,500); `max_tokens_exceeded` shrinks auto budget to 2,560; `holdBudget` auto = clamp(1.5 x median, 150, 800) else 300; held write `timeoutMs` = budget + 2,000; fetch `timeoutMs` = remaining budget. Prints example situations |
| `test/context.test.ts` | CORE | node | 7 | causal context: fetch -> json -> set cause/root, concurrent chains, `rt.op` ambient in body and continuation, nested op causes, ambient cleared by `afterTask`, timers observer carries cause (`timer 300ms`), idle timers create no ops |
| `test/devtools-runtime.test.ts` | UI | happy-dom | 7 | overlay on the real runtime (`runStoreSession`): interventions, folded detections, evidence = `explain()`, activity timeline, Now view, undo, live report sentence |
| `test/devtools.test.ts` | UI | happy-dom | 20 | overlay vs `MockRuntime` + `loadScenario`: mount/unmount (shadow root, `data-genclass-ignore`, no global CSS, listeners and plugin removed), no-op handle, theme/position, feeds, activity rows, typing bursts, evidence, undo and undo errors, live pill, folding, 200-card cap, policy reasons, pause/clear, Now view, mode switch, keyboard (Alt+Shift+G), empty states |
| `test/dom.test.ts` | CORE | happy-dom | 8 | `describeElement`; DOM user observer (clicks, typing bursts, passwords never recorded, submit/change/Enter, `[data-genclass-ignore]` incl. shadow roots, destroy); destroy restores fetch/XHR/history/Storage/WebSocket/timers; uncaught errors -> error trigger |
| `test/fetch.test.ts` | CORE | node | 17 | fetch observer: plain traffic makes no model call, app body vs clone, coalesce (`x-genclass: coalesced`), block (503 `blocked`), guard never runs heal-tier, `serve_cached`, delay 250 ms first, retry backoff 200 ms, retry not offered for non-replayable bodies, network error delivered, failure/request gates fail open at 300 ms, hedge, abort, `TimeoutError` = failure, cache <= `MAX_ENTRIES` (64) and skips bodies > `MAX_BODY` (256 KB), destroy restores fetch |
| `test/invariants.test.ts` | CORE | node | 6 | `InvariantMiner` learns len/sum/equality/unique relations, ignores unchanged fields and id-like keys; inconsistency once per episode + rollback + undo; unsettled transients ignored; `expect()` predicates |
| `test/learn.test.ts` | CORE | node | 8 | `Baselines` (latency after 5 samples, EWMA 0.9 error rate, streaks, outcomes, rate vs usual, identity gaps); `Profiles` (write set < 1% of >= 20, value kind, status class); transition trigger + rollback |
| `test/plugins.test.ts` | CORE | node | 7 | plugin facts/diagnoses/custom actions, `ctx.builtin`, plugin actions default to heal tier, `applicable()`, standing questions + `onAnswer`, `setup()`/cleanup API, vocabulary overrides |
| `test/policy.test.ts` | CORE | node | 14 | `gate()` summed mass, mode tiers, thresholds 0.9 guard / 0.8 heal, passive top, `requireDiagnosis`, deny/allow, pause, rate limit with 60 s sliding window, observe never holds, `setMode`, `pause()/resume()`, loading fails open without a record, detection threshold |
| `test/report.test.ts` | CORE | node | 7 | report line format, `explain(id)`, "Not acted on (would have done ...)", console group + "(×2 more in the last minute)", `on()` listeners, `GenClass.init` idempotent, `?genclass=off`, `?genclass=heal` |
| `test/review-actions.test.ts` | REVIEW | node | 1 | error-trigger rollback only when the failing chain wrote state; user input survives |
| `test/review-dom.test.ts` | REVIEW | happy-dom | 2 | unlabeled password never recorded; programmatic `click()` inside an op is not a user action |
| `test/review-fetch.test.ts` | REVIEW | node | 11 | request identity (Request bodies, Range), coalesce with opaque / streaming responses never hangs, buffers <= 64 x 256 KB, abort listener removed, no work after destroy, guard-mode failures not held, keepalive sent synchronously, "started after" direction, error-rate counts |
| `test/review-hub.test.ts` | REVIEW | node | 8 | held value write patched over user edit, queued nested object kept, late-revert undo, in-place push summary, in-place updater while held, versions past 16 history entries, deep change in 2,000-item array, throwing commit does not strand the queue |
| `test/review-misc.test.ts` | REVIEW | node | 6 | console ×N summaries, rate-limit warning once, read-only `fetch`, `ctx.builtin` cannot run a denied heal-tier action, never-settling provider, `ask()` after destroy |
| `test/review-perf.test.ts` | REVIEW | node | 4 | wall-clock cost budgets on 5,000-item stores (see gotchas); logs numbers |
| `test/review-precision.test.ts` | REVIEW | node | 4 | short last page is not a transition, keyed keys like `m21` are not, closing a selection is not an inconsistency, a lingering violation does not freeze snapshots |
| `test/review-redaction.test.ts` | REVIEW | node | 1 | custom `redact` also applies to invariant facts |
| `test/review-timers.test.ts` | REVIEW | node | 2 | 200,000-step recursive `setTimeout` loop does not throw; polling loop does not retain ops (registry prunes beyond 2,000; gc check needs `--expose-gc`) |
| `test/review-xhr.test.ts` | REVIEW | node | 4 | sync XHR never held, abort while held means never sent, listeners added once per object, reuse after a blocked answer |
| `test/situation.test.ts` | CORE | node | 10 | one situation per trigger (mutation, request, failure, stall, inconsistency, transition, error): keys `app, trigger, facts, in_flight, timeline, state, stats`, facts <= 12, timeline <= 16, state <= 8, `stateChars <= STATE_CHAR_BUDGET`; `situation()` side-effect free; serializer drop order; determinism. Prints situations |
| `test/smoke.test.ts` | CORE | node | 3 | atoms apply synchronously when nothing is salient; context through real awaits; stale write discarded in guard mode (own local `setup()`) |
| `test/xhr.test.ts` | CORE | node | 5 | XHR op + cause, block replays 503, failures detection-only, request gate fails open at 300 ms, destroy restores `open`/`send` |
| `test/model/calibrate.test.ts` | MODEL | node | 8 | sha1 header keys vs Python, sha256 (TS and WebCrypto) at edge lengths; calibration vs PyTorch < 1e-9 (needs `calibration.json` in `MODEL_DIR`); v1/v2 calibration vs Python < 1e-12; confidence; `buildAnswer`; `tauFor`/`kBucket`/`parseCalibration` |
| `test/model/engine.test.ts` | MODEL | node | 4 | ORT-node CPU q8 and fp16 parity vs PyTorch, ORT-web WASM q8 (12 requests, 1 thread) (all need model files); graph contract with a fake ORT (feeds exactly `meta.inputs`, `ModelUnsupportedError`) |
| `test/model/host.test.ts` | MODEL | node | 20 | `createModelHost` with fake worker + own fake clock (t = 0): lazy/eager/idle preload, status, priority queue, timeouts, `maxQueue` eviction, `status.latency` window of 20, typed errors across the worker boundary, JSON normalisation, measure, dispose, crash, WebGPU -> WASM recovery once, `loadStallMs`, inline fallbacks |
| `test/model/loader.test.ts` | MODEL | node | 12 | `parseCard` (runtime + v0.1 cards, unsafe names), `planOrder`, `fetchFile` (progress, sha256, Cache Storage, integrity, no cache / quota), `fetchCard` offline, `ModelBackend.load` phases `card, download, runtime, session, warmup`, ORT build choice, cached second load, WebGPU session timeout |
| `test/model/packer.test.ts` | MODEL | node | 10 | packer vs Python fixtures (skips Python-only float requests), Map vs object criteria, special tokens stay text, markers from meta, `MaxTokensExceededError`, integer-like labels, `planInputs`/`unpackLogits`; HF tokenizer parity full + pruned (v0.1 tokenizer only); tokenizer build < 2,000 ms. All need `tokenizer.json` |
| `test/model/serialize.test.ts` | MODEL | node | 8 | `stateSegments`/`questionBlock` vs Python; `pyNumber`, `pyJson`, `pyStrip`, `toJsonValue`, `pyRound` half-even |
| `test/browser/model.spec.ts` | MODEL | Chromium | 9 | WASM load in a module worker + parity (allow 1 flip, max dp < 0.06) + Cache Storage second load; inline fallbacks; lazy/idle preload; WebGPU fallbacks; latency 1 thread; latency per model size (`GENCLASS_BENCH_MODELS`); 4 threads cross-origin isolated; default ORT wasm from jsDelivr (`GENCLASS_OFFLINE` skips). All skip without `model.json` in `MODEL_DIR` |
| `test/browser/model-webgpu.spec.ts` | MODEL | Chromium + SwiftShader | 2 + per variant + per export | model on WebGPU without `shader-f16` (runs or falls back to WASM on f16 tensors); `GENCLASS_WEBGPU_VARIANTS` variants (`f32emb` must run on WebGPU); `GENCLASS_BENCH_MODELS` exports; `auto` skips software adapters |
| `test/browser/ui-devtools.spec.ts` | UI | Chromium | 5 | style isolation, keyboard, undo, screenshots light + dark |
| `test/smoke/smoke.sh` | packaging (owner not recorded) | bash + Chromium | 1 script | npm tarball works in a fresh Vite 8 app (see How it works) |

### Fixtures

| file | size | generated by | consumed by |
|---|---|---|---|
| `test/fixtures/model/requests50.json` | 285,309 B, single line, 50 requests `{id, state, questions}` | same 50 requests as `extension/test/fixtures/requests50.json` minus its `gold` and `screen_type` fields (verified by comparison; the stripping script is not in the repo) | `test/model/helpers.ts` -> `requests()` (fallback), browser `model-helpers.ts` |
| `test/fixtures/model/pack_fixtures.json` | 955,379 B, single line | `scripts/genclass_export.py` or `extension/tools/genclass_export.py` (v0.1 export; identical fixture code; which one produced the committed files is not recorded). Compact copy of `extension/test/fixtures/pack_fixtures.json` (1,228,103 B): identical after stripping whitespace, byte-different | packer, calibrate, engine, browser parity |
| `test/fixtures/model/torch_fixtures.json` | 255,945 B, single line | `scripts/genclass_export.py` or `extension/tools/genclass_export.py` (identical fixture code; which one produced the committed files is not recorded). Compact copy of the extension's (269,230 B), identical after stripping whitespace | calibrate, engine, browser parity |
| `test/fixtures/model/py_fixtures.json` | 167,629 B, single line: 17 states, 7 questions, 98 texts, pruned (16,000 merges, vocab 16,364), 120 calibration cases, 80 confidence cases | `test/fixtures/model/make_py_fixtures.py` | `serialize.test.ts`, `calibrate.test.ts`, `packer.test.ts` |
| `<MODEL_DIR>/{requests,pack_fixtures,torch_fixtures,parity}.json` | per export | `training/export_runtime.py` | unit tests when all three exist (`FIXTURES_FROM_MODEL`), `exportParity()` |
| `<GENCLASS_WEBGPU_VARIANTS>/{f32emb,i8emb}/` | model dirs | `test/fixtures/model/make_webgpu_variants.py` | `model-webgpu.spec.ts` |

## Drift and open issues

Doc-vs-code mismatches (code wins):

- `packages/runtime/STATUS.md` "Open issues" says `react-dom` is not a devDependency of `@genclass/runtime`, and `packages/runtime/UI-NEEDS.md` item 2 (still under "Open") asks for `react-dom` and `@types/react-dom`. Both are devDependencies: `react-dom ^19.3.0`, `@types/react-dom ^19.0.0`. UI-NEEDS item 1 (ignore `[data-genclass-ignore]`) is also listed as open but is implemented and tested (`dom.test.ts`).
- `STATUS.md` "For UI" says `test/browser/ui/mock-runtime.ts` needs `holdBudgetMs()` and `situationBudget()`. Both exist (return `300` and `3200`). "Not type-checked" is still true.
- `STATUS.md` runs `vitest run --exclude "test/browser/**"`. The exclude is already in `vitest.config.ts`; plain `vitest run` / `npm test` is equivalent.
- `OPEN_TASKS.md` item 8 still lists "`npm pack` smoke test in a fresh Vite app" as to do. `test/smoke/smoke.sh` exists (commit 59c213f) and "Done" says it was run for the alpha.
- `OPEN_TASKS.md` header says "Status as of 2026-10-07 23:30 UTC. Branch `runtime`", but its publish entry is dated 2026-10-08. `main`, `origin/main` and `origin/runtime` all point at 654d822, so the "Merging `runtime` into `main`" item looks done on the remote.
- `packages/runtime/src/model/README.md` ("Bundling") says `dist/worker.js` imports `onnxruntime-web/webgpu`. The worker now imports either `onnxruntime-web/webgpu` or `onnxruntime-web/wasm` on demand (`src/model/worker.ts`), and `build.mjs` checks both.
- `test/browser/model-helpers.ts` -> `saveResults` doc comment says it writes `test-results/browser/<name>.json`. The code writes `test-results/model-bench/<name>.json` (the model README is correct).
- `test/browser/ui-devtools.spec.ts` calls its output "the README screenshots", but no README or doc references `test/browser/ui/screenshots/*.png`.
- `sim/README.md` says the runtime's full tsup config "fails until those [adapter] files exist". The adapters exist; the full build works (STATUS: "`tsup` build OK").
- `docs/runtime/CONTRACT.md` §1 describes `packages/runtime-model/` as "model card + files for the CDN package". Only `MODEL_CARD.md` exists; `files/` is gitignored and there is no `package.json`.
- `packages/runtime-model/MODEL_CARD.md` lists 9 diagnoses (no `transient`); the runtime has 10 (`DEFAULT_DIAGNOSES` ends `unusual, transient`, asserted in `batch3.test.ts`).
- Documented `GENCLASS_MODEL_DIR` locations differ: `~/gcl/model/.cache-model` (STATUS), `~/gcl-cache/model-v0.1` (model README), `~/gcl/models/genclass-v0.1` (demos `vm-eval.sh` default model dir). Unverified which exist on the VM.
- npm dist-tag of the alpha is ambiguous (unverified): `OPEN_TASKS.md` item 8 says publish `0.1.0` "without the alpha tag", while both READMEs say `npm install @genclass/runtime` (installs `latest`) and their badges query `/npm/v/@genclass/runtime/latest`. Whether `0.1.0-alpha.0` went out under `latest` or a prerelease tag is not recorded; check `npm view @genclass/runtime dist-tags` before relying on either.
- `scripts/genclass_export.py` usage text passes `--requests extension/genclass/test/fixtures/requests50.json`; that path does not exist in this repo (the file is `extension/test/fixtures/requests50.json`; the script's own instructions say to run "from ~/jev on the VM").
- Ownership: `docs/runtime/CONTRACT.md` §1 (layout) still lists `src/adapters/` and `src/devtools/` as owner CORE, but §13 (Additions) reassigns them to UI, which matches `STATUS.md` counting their tests (`adapters-*.test.ts`, `devtools*.test.ts`, 53) as UI's. §1 is stale; the Tests table follows §13 / STATUS.

Open items in scope (from `OPEN_TASKS.md`, STATUS):

- Packaging (item 8): publish `@genclass/runtime-model@0.1.0` + GitHub release `runtime-model-v0.1.0`, then `@genclass/runtime@0.1.0`; add a CI workflow (build, typecheck, unit tests). Until the model package exists, the default model URL has nothing to serve and the alpha only observes (README "Status").
- Docs (item 7): dev-only lazy import of the devtools (52 KB min / 17 KB gz).
- The VM path (`scripts/vm.sh`) depends on a hosts file and SSH key from the original team's Mac. Without them the VM is unreachable: the light checks run locally under the run policy in AGENTS.md, and anything heavier (Playwright, smoke test, model runs) needs the user's go-ahead and a place to run it ([Where to run things](#where-to-run-things)).
- Any situation-wording change must be coordinated with SIM (STATUS "Open issues").

## Related docs

- Runtime docs (this set): [public-api-and-lifecycle.md](public-api-and-lifecycle.md), [observe-and-trace.md](observe-and-trace.md), [state-and-adapters.md](state-and-adapters.md), [learn-situation-triage.md](learn-situation-triage.md), [decide-policy-actions.md](decide-policy-actions.md), [model-host.md](model-host.md), [devtools.md](devtools.md)
- Cross-cutting: [../model-io-contract.md](../model-io-contract.md), [../sim.md](../sim.md), [../training.md](../training.md), [../demos.md](../demos.md), [../genclass-model-lineage.md](../genclass-model-lineage.md), [../extension-and-benchmarks.md](../extension-and-benchmarks.md), [../status-and-known-issues.md](../status-and-known-issues.md), [../README.md](../README.md), [../overview.md](../overview.md), [../repo-map.md](../repo-map.md), [../glossary.md](../glossary.md), [../playbooks.md](../playbooks.md), [../../../AGENTS.md](../../../AGENTS.md)
- Existing sources: [docs/runtime/CONTRACT.md](../../runtime/CONTRACT.md), [docs/runtime/API.md](../../runtime/API.md), [packages/runtime/STATUS.md](../../../packages/runtime/STATUS.md), [packages/runtime/src/model/README.md](../../../packages/runtime/src/model/README.md), [OPEN_TASKS.md](../../../OPEN_TASKS.md), [packages/runtime-model/MODEL_CARD.md](../../../packages/runtime-model/MODEL_CARD.md), [sim/README.md](../../../sim/README.md), [demos/README.md](../../../demos/README.md)
