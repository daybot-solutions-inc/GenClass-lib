# Build, test and release (@genclass/runtime and the monorepo)

> **Scope:** `package.json` and `package-lock.json` (root), `tsconfig.base.json`, `.gitignore`, `.github/workflows/ci.yml`, `packages/runtime/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts}`, `packages/runtime/bin/genclass-runtime.mjs` (packaging only), `packages/runtime/test/**` (unit, model, browser, smoke, fixtures), `packages/runtime/STATUS.md` ("State" and "How to drive it headless"), `scripts/vm.sh`, `OPEN_TASKS.md` and `HANDOFF.md` (packaging, release), `sim/package.json`, `demos/package.json`, `realapps/package.json`, `packages/runtime-model/`.
> **Read this when:** you need to build, typecheck or test the runtime; add or fix a test; understand or change CI; regenerate fixtures; run the Playwright model/UI specs or the npm-pack smoke test; publish a version; or understand how `sim/`, `demos/` and `realapps/` consume the runtime package.
> **Source of truth:** the code. Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins.

## TL;DR

- npm workspaces monorepo: `packages/*`, `sim`, `demos` (`realapps/` has its own `package.json` but is **not** a workspace). Root `npm run build` / `npm test` touch only `@genclass/runtime`; root `npm run typecheck` runs every workspace's `typecheck` (`--if-present`: runtime, `sim`, `demos`), and the demos part fails in this checkout (see gotchas).
- **A root `package-lock.json` is committed now** (b435acb, lockfileVersion 3), so `npm ci` works on a fresh clone and CI uses it.
- **CI exists**: `.github/workflows/ci.yml` (b435acb), one job on `ubuntu-latest`, Node 22, `ONNXRUNTIME_NODE_INSTALL=skip`: `npm ci` -> typecheck -> build -> unit tests (browser specs and `review-perf.test.ts` excluded) -> `review-perf.test.ts` alone with `--retry=2`. Triggers: push to `main`, `runtime`, `mvp`, `mvp-v2`; every `pull_request`; `workflow_dispatch`. It has not run on GitHub yet: `mvp-v2` is not pushed (`origin/runtime` = 74f17c0 has no `.github/`).
- **Run policy.** Mehar's team rule ("the Mac only edits files"; everything runs on the Azure `train` VM through `scripts/vm.sh`) exists because *his* Mac has 8 GB RAM (`HANDOFF.md` "Rules", `scripts/vm.sh` header, `docs/runtime/CONTRACT.md` §0 rule 5). For agents on other machines (lead policy, 2026-10-08): npm install/ci, tsc, tsup and the vitest unit tests are light and run locally; **ask the user first** before Playwright (including `test/smoke/smoke.sh`), the sim generator, training, realapps runs, the demos' eval, model downloads, anything on Azure, `git push` and `npm publish`. See [Where to run things](#where-to-run-things).
- Build = `tsup` (`packages/runtime/tsup.config.ts`, unchanged since situation-v1): ESM only, 6 entries (`index`, 3 adapters, `devtools/index`, `worker`), `.d.ts` for all but the worker, `clean: true`, `splitting: true`. Output goes to `packages/runtime/dist/`, which `package.json` `exports` points at.
- Typecheck = `tsc -p tsconfig.json --noEmit` over `src/` only. **Test files are never type-checked.**
- Unit tests = vitest, **42 tracked files** (36 under `test/`, 6 under `test/model/`), **350 tests**. Default environment `node`; 5 files opt into `happy-dom` per file. Verified 2026-10-08 without a model directory: 336 passed + 14 skipped, split the way CI runs them (346 in the main run, 4 in `review-perf.test.ts`; see [Verified locally](#verified-locally-2026-10-08)).
- **Default mode is `observe`** in the product (f3636b2: `src/runtime.ts` -> `o.mode ?? "observe"`), but the test harness `test/helpers.ts` -> `setup()` passes `mode: "guard"` by default, and `smoke.test.ts`, `review-fetch.test.ts` -> `headless()` and `test/browser/ui/session.ts` -> `runStoreSession` pass `mode: "guard"` explicitly. Pass `mode: undefined` to `setup()` to get the product default (`test/default-mode.test.ts` does).
- **Store writes are not held by default** (situation-v2, `policy.holdWrites` off). Tests that exercise held store writes pass `policy: { holdWrites: true }` (`atoms.test.ts` wraps `setup()` to add it); default behaviour (delivery decisions at the network boundary, late reverts) is tested in `delivery.test.ts`, `content.test.ts`, `no-reorder.test.ts`.
- Runtime unit tests run on a virtual clock (`test/helpers.ts` -> `FakeClock`), a virtual HTTP server (`FakeServer`) and a scripted model (`ScriptedDecider` / `ManualDecider`): no real time, no network, no model. Exceptions (wall-time perf checks, `loader.test.ts`'s real `browserClock`, model-file tests) are listed under gotchas.
- Model tests need a model directory (`GENCLASS_MODEL_DIR`, default `<repo>/.cache-model`); without it 14 model tests skip. **No situation-v2 model exists yet**; the only fixtures and models are the v0.1 GenClass model's. The gc test needs `NODE_OPTIONS=--expose-gc` (otherwise it logs "skipped" and passes).
- Browser tests = Playwright (`npm run test:browser` in `packages/runtime`): `globalSetup` builds the library with tsup and bundles a test app with esbuild; model specs skip without a model directory. A separate config runs the devtools UI spec and writes 18 screenshots. Not run in CI.
- `test/smoke/smoke.sh` packs the tarball, installs it into a fresh Vite 8 app, builds it and loads it in headless Chromium. Not run in CI.
- Released: `@genclass/runtime@0.1.0-alpha.1` on npm, dist-tag `latest`, 2026-10-08 (~05:33 UTC) by `karanvir1729` under dist-tag `latest`, from release commit 806a296 (local annotated tag `v0.1.0-alpha.1`, not pushed); 26 files, 486.8 kB, shasum 9e3e82bcf752d6eb34db0620d072e6a913508dff. Before it: `@genclass/runtime@0.1.0-alpha.0` (was `latest`; checked with `npm view` 2026-10-08; the registry also lists a `0.0.0-stage` version published four minutes earlier), git tag `v0.1.0-alpha.0` on 654d822. That tarball predates situation-v2 and still defaults to `guard`. Release recipe from `HANDOFF.md`: the user runs `npm publish <tgz> --access public` with 2FA; for a prerelease such as `0.1.0-alpha.1`, npm 11 (11.8.0 on the lead's machine) refuses that command without `--tag` (see [Cut a release](#cut-a-release-of-genclassruntime)). Pending: `@genclass/runtime-model@0.1.0` (404 today) and `@genclass/runtime@0.1.0`.
- `sim` and `demos` depend on `"@genclass/runtime": "*"` (workspace symlink), which resolves to `packages/runtime/dist/`: **build the runtime first**. `realapps` bundles `packages/runtime/src` directly with esbuild (see [../realapps.md](../realapps.md)).

## Files

| path | role | key contents / entry points |
|---|---|---|
| `package.json` | root, private `genclass-lib`, `"type": "module"` | workspaces `packages/*`, `sim`, `demos`; scripts `build`, `test`, `typecheck`; devDep `typescript ~5.9.3`; `engines.node >=20`; license Apache-2.0 |
| `tsconfig.base.json` | shared compiler options | see Configuration |
| `.gitignore` | ignores build and model artefacts | "GenClass runtime" block: `node_modules/`, `dist/`, `.vite/`, `test-results/`, `playwright-report/`, `sim/out/`, `packages/runtime-model/files/`, `.cache-model/`, `.publish/`, `*.tgz` (the last two added in 59c213f). Older Python block: `.venv/`, `__pycache__/`, `*.pyc`, `.pytest_cache/`, `*.egg-info/`, `data/`, `models/`, `runs/`, `dist/`, `node_modules/`, `.DS_Store`. `data/`, `models/`, `runs/` are unanchored (match at any depth). `package-lock.json` is **not** ignored |
| `package-lock.json` (root) | committed lockfile (b435acb) | `lockfileVersion: 3`, 213 `packages` entries; records `node_modules/@genclass/runtime` as `{ "resolved": "packages/runtime", "link": true }`. Resolved versions include `vitest 5.0.3`, `tsup 8.5.1`, `typescript 5.9.3`, `esbuild 0.27.7`, `happy-dom 20.14.5`, `onnxruntime-web`/`onnxruntime-node 1.30.0`, `@playwright/test 1.63.0`, `vite 8.3.3`. `npm ci` installs exactly this |
| `.github/workflows/ci.yml` | the only CI workflow (b435acb) | job `runtime`; see [CI](#ci-githubworkflowsciyml) |
| `packages/runtime/package.json` | the published package | name `@genclass/runtime`, version `0.1.0-alpha.1` (bumped in release commit 806a296, the head of `mvp-v2`; it was `0.1.0-alpha.0` from 59c213f to b435acb), `exports`, `bin`, `files`, scripts `build`/`typecheck`/`test`/`test:browser` |
| `packages/runtime/tsconfig.json` | typecheck project | extends base; `rootDir: src`, `outDir: dist`, `jsx: react-jsx`, `types: []`, `include: ["src"]` |
| `packages/runtime/tsup.config.ts` | build | entries, dts entries, externals |
| `packages/runtime/vitest.config.ts` | unit-test runner config | include `test/**/*.test.ts`, exclude `test/browser/**`, env `node`, `testTimeout 20000` |
| `packages/runtime/bin/genclass-runtime.mjs` | CLI shipped in the tarball (not built); committed as mode 100755 since b435acb (it was 100644, and every root `npm install` showed a mode change) | `fetch-model <dir> [--from] [--variant q8\|fp16\|all] [--force] [--quiet]`, `info <dir>`; `DEFAULT_FROM` |
| `packages/runtime/test/helpers.ts` | core test kit | `drain`, `FakeClock`, `choice`, `ScriptedDecider`, `defaultScript`, `FakeServer`, `makeGlobal`, `setup` (defaults `mode: "guard"` since f3636b2), `ManualDecider` |
| `packages/runtime/test/*.test.ts` | 36 tracked unit test files (CORE, UI, REVIEW, lead) | see Tests. New since 654d822: `content`, `delivery`, `no-reorder`, `nan`, `default-mode` |
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
| `packages/runtime/test/browser/ui/{mock-runtime,scenario,session,page}.ts` | UI fixtures, **also imported by unit tests** | `mock-runtime.ts`: `MockRuntime` (scripted `Runtime`, not the runtime; `situationBudget()` returns `2400` since batch 4; a public `holdWrites = false` field that the `adapters-*` tests set to `true` to exercise hold paths), `MockClock`, `choice(probs)`, `makeDecision`, `makeAction`; `scenario.ts`: `loadScenario(rt, opts)`, `ScenarioOptions`; `session.ts`: `runStoreSession(opts)` (real `createRuntime` under virtual time, `mode: "guard"` explicitly), `Session`, `SessionOptions`, `VirtualClock`, `realTurn`, `READY` (a `ModelStatus`), `SessionDecider` (rule-based test decider; its `judge()` has a `delivery` case since batch 4); `page.ts`: `window.__gc` |
| `packages/runtime/test/browser/ui/screenshots/` | 18 committed PNGs | `{pill,overlay,interventions,evidence,evidence-answers,detections,activity,now,loading}-{light,dark}.png` |
| `packages/runtime/test/browser/.gitignore` | ignores `.build/` | build output of `build.mjs` |
| `packages/runtime/test/smoke/smoke.sh` | npm-pack smoke test | run from `packages/runtime` |
| `packages/runtime/STATUS.md` | CORE status + headless recipe + example situations | last measured (VM, with a model dir): 41 files / 346 tests passing; written before `default-mode.test.ts` (+1 file, +4 tests) |
| `packages/runtime-model/MODEL_CARD.md` | only file of the planned `@genclass/runtime-model` package | no `package.json` yet, so not a workspace. Status line now describes round 1 (situation-v1) R17; a v2 model is not trained yet |
| `scripts/vm.sh` | VM helper (Mehar's machine; needs his hosts file and key) | `sync`, `run`, `exec`, `get` |
| `sim/package.json`, `demos/package.json` | consumers of the runtime | `"@genclass/runtime": "*"`; scripts listed under "How `sim`, `demos` and `realapps` consume the runtime" |
| `realapps/package.json` | `@genclass/realapps` (private, not a workspace) | scripts `build:runtime` (`cd ../packages/runtime && npx tsup`), `build` (`node build.mjs`), `gen`; pins `@playwright/test`/`playwright` `1.63.0`. See [../realapps.md](../realapps.md) |
| `HANDOFF.md` | Mehar's handoff for continuing sessions (d73d20c) | npm/2FA publish recipe, tags, run rules, next steps |

## Concepts and data structures

| term | meaning |
|---|---|
| workstream | team role that owns files: lead, CORE (runtime core + most tests), MODEL (`src/model/**`, `bin/`, `test/model/`, model browser specs), UI (`src/devtools/**`, `src/adapters/**` per CONTRACT §13, their tests, `test/browser/ui/`), SIM, REAL (`realapps/`, real-browser data), DEMOS, TRAIN, REVIEW (`test/review-*.test.ts`). Mehar's sessions play all of these; on `mvp-v2` the lead (us) owns AGENTS.md, `docs/agents/**`, `default-mode.test.ts` and CI |
| slot | your directory on the VM, `~/gcl/<SLOT>`; name must match `[a-zA-Z0-9_-]+`; conventional names `core`, `model`, `sim`, `demos` |
| model directory | a folder with `model.json` (card format `genclass-runtime-model/1` or the v0.1 extension card), the ONNX variants, `tokenizer.json`, `calibration.json`, `meta.json`. Fetched with `genclass-runtime fetch-model`. Tests read it from `GENCLASS_MODEL_DIR` |
| v0.1 fixture set | `test/fixtures/model/{requests50,pack_fixtures,torch_fixtures}.json`: 50 computer-use requests (ids like `cu-004219-f`) with the Python packer output and PyTorch logits of the **v0.1 GenClass model** |
| model-dir fixture set | `requests.json`, `pack_fixtures.json`, `torch_fixtures.json` (+ `parity.json`) written next to an export by `training/export_runtime.py`. `test/model/helpers.ts` -> `FIXTURES_FROM_MODEL` is true when all three exist in `MODEL_DIR`; then the unit parity tests use them instead of the v0.1 set |
| parity | TS port output (packer, tokenizer, serializer, calibration, engine) equals the Python/PyTorch reference on fixtures |
| review test | `test/review-*.test.ts`: written by REVIEW as bug demonstrations ("A failing test demonstrates a bug"); STATUS records they pass **unmodified** |
| package build vs model-entries build | `build.mjs` -> `buildLibrary`: uses the real `npx tsup` output (`mode: "package"`) when every tsup entry file exists and `dist/index.js` mentions `createModelHost`; otherwise builds only `src/model/index.ts` + `src/model/worker.ts` into `.build/dist` (`mode: "model-entries"`) |
| worker URL pattern | the literal `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` in `src/model/host.ts` -> `defaultWorkerFactory` that app bundlers key on (its sibling `defaultOrtLoader` holds the two literal calls `import("onnxruntime-web/webgpu")` and `import("onnxruntime-web/wasm")`); `build.mjs` -> `WORKER_URL_RE` asserts it survives both builds |
| `situation-v1` | annotated git tag on 1a77558 ("Frozen runtime situation format for model training"); round-1 SIM data and the R17/R32 round-1 models come from it. Superseded |
| `situation-v2` | annotated git tag on 6e5e86e ("Frozen runtime situation format v2", runtime batch 5). **The current frozen training format** (`HANDOFF.md`): SIM and REAL are generating v2 data from it; any change under `src/situation/*` means a new tag and regenerated data |
| `v0.1.0-alpha.0` | annotated git tag on 654d822 ("@genclass/runtime 0.1.0-alpha.0 (npm)"); a GitHub pre-release per `HANDOFF.md` |
| `delivery` trigger | situation-v2 (batch 4): the runtime decides at the network boundary (a response, WebSocket/EventSource message or XHR completion) instead of holding store writes; a `discard` drops only the response's stale field writes (`ActionRecord.dropped`). Tests: `delivery.test.ts`, `content.test.ts`, `smoke.test.ts`, `situation.test.ts` |
| `policy.holdWrites` | `PolicyOptions.holdWrites?` in `src/types.ts`, default off: store writes apply at once and a background `discard` becomes a late revert. `true` restores pre-v2 held writes; tests about held writes must opt in |
| default mode vs harness mode | product default `observe` (`src/runtime.ts` -> `o.mode ?? "observe"`, f3636b2); `test/helpers.ts` -> `setup()` defaults to `"guard"` so CORE tests keep exercising interventions |
| CI | `.github/workflows/ci.yml`: typecheck, build, unit tests and perf budgets of `@genclass/runtime` only (no sim, demos, realapps, Playwright, Python) |

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

`setup()` spreads your options **after** its defaults (`mode: "guard"`, `report: "silent"`, an `observe` map with `fetch: true` and `xhr`, `user`, `errors`, `nav`, `storage`, `perf`, `websocket`, `timers` false; `eventsource` is not listed, so it stays at its default "on", a no-op on the fake global, which has no `EventSource`), so `setup({ mode: undefined })` gives the runtime's own default (`observe`) and `setup({ decider: manual })` replaces the decider passed to `createRuntime`, but the returned `decider` field is still the unused `ScriptedDecider`; keep your own reference to `manual`. `FakeServer.fetch` honours `init.signal` (rejects with `signal.reason`), reads only string bodies, and `error: "network"` rejects with `TypeError("Failed to fetch")`.

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
| `timers(holder)` (a global whose `setTimeout`/`clearTimeout` run on the `FakeClock`, passed via `extraGlobal`) + `searchApp` / `listApp` | `test/delivery.test.ts`, `test/content.test.ts` | debounced app timers seen by the timers observer; small apps that produce delivery situations |
| `FakeWS` / `FakeES` (`EventTarget` subclasses) + `board(s)`; `makeXHR(ref, handler)` | `test/delivery.test.ts` | WebSocket and EventSource channels for message delivery decisions; an `XMLHttpRequest` for XHR delivery holds |
| `PassiveDecider` (always the passive action with an alarming diagnosis, after `latency` virtual ms) | `test/no-reorder.test.ts` | a model that never acts, for "never worse" checks |
| `counterStore()` (minimal redux-like store) | `test/default-mode.test.ts` | an adapter store for `rt.adapter(...).propose` |

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

1. vitest collects `test/**/*.test.ts` minus `test/browser/**` (42 tracked files; plus any untracked `*.test.ts` in your working copy). It transpiles TS without type-checking.
2. Each file runs in `node` unless its first line is `// @vitest-environment happy-dom` (`adapters-react`, `devtools`, `devtools-runtime`, `dom`, `review-dom`).
3. A typical test calls `setup()`: builds `FakeClock` + `FakeServer` + `makeGlobal(server)` + `ScriptedDecider`, then `createRuntime({ clock, global: g, decider, mode: "guard", report: "silent", observe: { fetch: true, xhr/user/errors/nav/storage/perf/websocket/timers: false }, ...rest })` (`eventsource` unlisted, so default on) and casts to `RuntimeImpl` (so tests can reach `rt.hub`, `rt.ops`, `rt.ctx`, `rt.cache`, `rt.miner`, `rt.internals`).
4. The test drives the app through `rt.user(...)`, `rt.op(...)`, atoms and `fetch`, then advances virtual time: `await clock.advance(ms)` runs due timers in order, each followed by `flush()`; `flush()` drains microtasks with 4 real `setImmediate` turns (`drain`), runs `afterTask` hooks, and repeats up to 50 times.
5. The decider answers at once (an already-resolved promise) from a script (`ScriptedDecider`, records `calls`; `script` can be reassigned mid-test) or when the test calls `ManualDecider.answer(script?)` (oldest pending first).
6. Assertions read `decider.calls[i].state` (the situation), `decider.calls.filter((c) => c.trigger === "delivery")` (v2 network-boundary decisions), `rt.decisions()`, `rt.interventions()` (incl. `.late` for late reverts and `.dropped` for delivery discards), `rt.history()`, `server.hits` / `server.log`. `defaultScript()` takes any trigger key, e.g. `defaultScript({ delivery: { diagnosis: "stale", action: "discard" } })`.
7. Model tests (`test/model/`) read fixtures through `test/model/helpers.ts`; parts that need model files use `describe.skipIf(!hasModelFile(...))` / `it.skipIf`. The 14 model-file tests: `calibrate.test.ts` 1 (`calibration.json`), `engine.test.ts` 3 (`model.json` + `tokenizer.json` + the variant file), `packer.test.ts` 10 (`tokenizer.json`; the 2 HF edge-case tests also need `isV01Tokenizer`). The `py_fixtures.json` blocks skip only if that committed file is missing.

### Headless runtime recipe (STATUS "How to drive it headless")

What `setup()` does is the minimal form of the recipe SIM and tests use. `packages/runtime/STATUS.md` gives the full form (updated for situation-v2); options are defined in `src/types.ts` -> `CreateOptions` / `InitOptions` (see [public-api-and-lifecycle.md](public-api-and-lifecycle.md)):

```ts
createRuntime({ clock, global, decider,                    // injected Clock, instrumented global, DecisionProvider
  observe: { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false },
  mode: "heal", triage: "salient", report: "silent",        // pass mode explicitly: the default is now "observe"
  policy: { thresholds: { report: 0, guard: 0.5, heal: 0.5 }, holdBudgetMs: 1e9, maxActionsPerMinute: 1e9, requireDiagnosis: false },
  situation: { budget: 1000 },                               // sample budgets 1000/1333/2000/2400; <= 1400 = compact questions
  hooks: { opCreated(op) {}, mutationProposed(m) {} }, vocabulary: { diagnoses: {}, actions: {} } });
```

Facts STATUS records for this mode: `global.fetch` (and WebSocket, EventSource, ...) is replaced at construction and `rt.destroy()` restores every wrapped global; `observe` defaults to every observer on except `timers`, which is on only when `global.document` exists, and synthetic DOM events count as user actions only with `observe.untrustedEvents: true`; the decider is consulted only while `status.state === "ready"`; holds (responses, messages, requests) are released only by the decision, the hold-budget timer or `defer`'s wait, all on the injected clock; forcing semantics: thresholds 0.5, `requireDiagnosis: false`, probability 1 on an action runs exactly that action when the mode permits it (tested for `delivery` too in `delivery.test.ts` "answers"); same inputs give byte-identical situations at any budget. `sim/src/run/rt.ts` -> `createOptions` (the options every sim run passes to the `createRuntime` that `realRuntimeFactory` loads) sets `mode: "heal"` explicitly, so the default-mode change does not affect SIM data.

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

1. `npm run build`, then `npm pack` -> `<pkg>/genclass-runtime-<version>.tgz` (today `genclass-runtime-0.1.0-alpha.1.tgz`) (name from npm's scoped-package convention; gitignored as `*.tgz`).
2. Creates a temp Vite app (`mktemp -d`/app) whose `src/main.js` calls `GenClass.init({ model: false, report: "console" })`, creates atom `search.results`, wires an input to a `data:` URL fetch, and calls `mountDevtools(rt)`.
3. `npm install` the tarball + `vite@8` + `@playwright/test@1.63.0` (needs registry access), `npx vite build`.
4. `check.mjs` serves `dist/` on port `4191` (plain `node:http`), opens it in Chromium (`chromium.launch()` from the app's `@playwright/test`), waits for `window.__smoke.ok`, `p.fill("#q", "rea")`, waits for `#out` to read `rea-1`, prints one JSON line `{ info: { status, events, devtools }, errs }`, and exits 1 unless there are no page errors / console errors, `genclass-devtools` exists, and `rt.history().length >= 3` (`status` is printed, not asserted). Then prints `SMOKE OK: <tgz>`.
5. The script is unchanged since 59c213f. `GenClass.init({ model: false, report: "console" })` now starts in `observe` (default since f3636b2); nothing it asserts depends on the mode (unverified: not re-run on mvp-v2).
6. Leftovers: the `.tgz` stays in `packages/runtime/` and the `mktemp -d` app is not deleted. The script never runs `playwright install`: Chromium for Playwright `1.63.0` must already be in the Playwright browser cache on the machine (how the VM got it is not recorded in the repo).

### VM workflow (`scripts/vm.sh`)

1. Reads the `train` host IP from `~/.jev-local/azure_hosts` (line `train <ip>`), key `~/.ssh/jev_azure`, user `azureuser`, ssh options `StrictHostKeyChecking=accept-new`, `ConnectTimeout=20`, `ServerAliveInterval=30`, `ServerAliveCountMax=6`. Exits 2 if the host line is missing, the slot name has characters outside `[a-zA-Z0-9_-]`, or the subcommand is unknown. Every step is wrapped in GNU `timeout` (see Configuration). The sibling `scripts/azvm.sh HOST ...` uses the same hosts file and key for the other jev VMs (out of scope here).
2. `sync SLOT`: `ssh mkdir -p gcl/SLOT`, then `rsync -az --delete` the repo to `~/gcl/SLOT/`, excluding `node_modules`, `.git`, `dist/`, `.vite`, `/data/`, `test-results/`, `playwright-report/`, `__pycache__`, `.DS_Store`, `/models/`, `/runs/`, `/extension/`, `/sim/out/`, `.cache-model/`. Excluded paths on the VM are kept (rsync does not delete excluded files without `--delete-excluded`), so `node_modules`, `dist` and model caches survive syncs.
3. `run SLOT 'cmd'` = sync + remote (the script is unchanged since 654d822; it only works from a machine holding Mehar's hosts file and key); `exec SLOT 'cmd'` = remote only; remote runs `export PATH=$HOME/node/bin:$PATH; cd ~/gcl/SLOT && cmd` (Node 22 per the header and CONTRACT §0 rule 6).
4. `get SLOT REMOTE LOCAL`: `scp -r` from `~/gcl/SLOT/REMOTE`.

### How `sim`, `demos` and `realapps` consume the runtime

npm workspaces symlink `node_modules/@genclass/runtime` -> `packages/runtime`, so every workspace import goes through `packages/runtime/package.json` `exports` -> `dist/`. `realapps/` is not a workspace and bypasses `dist/` entirely.

| consumer | dependency | how it resolves | build requirement | escape hatch |
|---|---|---|---|---|
| `sim` (`@genclass/sim`, private) | `"@genclass/runtime": "*"` | dynamic `import(process.env.GENCLASS_RUNTIME ?? "@genclass/runtime")` in `sim/src/run/rt.ts` -> `realRuntimeFactory`; `sim/tsup.config.ts` leaves `@genclass/runtime` external | `npm run build:runtime-core` (in `sim`: tsup of `src/index.ts` only, `--no-config --platform neutral`, no dts, into `packages/runtime/dist`) or the full runtime build | `SIM_RUNTIME=real` runs sim tests on the real runtime; otherwise they use the fake (`sim/test/helpers.ts`); `GENCLASS_RUNTIME=<specifier>` loads another build |
| `demos` (`@genclass/demos`, private) | `"@genclass/runtime": "*"` plus `react`, `redux`, `zustand`, `@fontsource-variable/*` | Vite resolves `exports` -> `dist/` | full runtime build (`demos/scripts/vm-eval.sh` runs `npm run build -w @genclass/runtime` and stops if it fails) | `GENCLASS_SHIM=1` (or a missing `packages/runtime/dist/index.js`) aliases `demos/src/dev/runtime-shim/*` in `demos/vite.config.ts`; `GENCLASS_SHIM=0` forces the real one; `npm run typecheck:shim` |
| `sim` on-policy runs | the model host only | `sim/src/run/onpolicy.ts` loads `sim/dist/model-host/host.js`, built by `npm run build:model-host` (tsup of `packages/runtime/src/model/host.ts`, `--platform neutral`, ORT external, into `sim/dist/model-host`); `sim`'s `build` now runs it after `tsup` | `npm run build` in `sim` | none |
| `realapps` (`@genclass/realapps`, private, **not** a workspace) | none in `package.json` | `realapps/build.mjs` aliases `@genclass/runtime` (+ `/react`, `/redux`, `/zustand`) to `packages/runtime/src/*.ts` and stubs `onnxruntime-web` (+ `/wasm`, `/webgpu`); esbuild bundles the source into each app | none (`dist/` is not used; `build:runtime` runs a full tsup anyway) | `RW_RUNTIME_SRC` = an exported `git archive <tag> packages/runtime/src` to pin a frozen tag, `RW_RUNTIME_TAG` = its name (written to `dist/runtime-tag.txt`); default: the working tree. See [../realapps.md](../realapps.md) |
| `packages/runtime` UI spec | demos' hoisted deps | `<repo>/node_modules/@fontsource-variable/*` | root `npm install` / `npm ci` | none |

`sim` does **not** need `dist/` to typecheck: `sim/src/types.ts` is a structural mirror of the runtime's model seam and the only runtime import is the dynamic one in `sim/src/run/rt.ts`. `demos` typecheck does need `dist/*.d.ts` (or `typecheck:shim`, whose `demos/tsconfig.shim.json` maps `@genclass/runtime` and its `/react`, `/redux`, `/zustand`, `/devtools` subpaths to `src/dev/runtime-shim/{index,react,redux,zustand,devtools}.ts`; `/worker` is not mapped).

Workspace scripts (verbatim from the `package.json` files):

| workspace | script | command |
|---|---|---|
| root | `build` / `test` / `typecheck` | `npm run build -w @genclass/runtime` / `npm test -w @genclass/runtime` / `npm run typecheck --workspaces --if-present` |
| `@genclass/runtime` | `build` / `typecheck` / `test` / `test:browser` | `tsup` / `tsc -p tsconfig.json --noEmit` / `vitest run` / `playwright test --config test/browser/playwright.config.ts` |
| `@genclass/sim` (`0.0.0`, private, bin `genclass-sim` = `./dist/gen.js`) | `build`, `typecheck`, `test` | `tsup && npm run build:model-host` (tsup entries `gen`, `worker`, `index`, `smoke`; `node22`; `@genclass/runtime` external), `tsc -p tsconfig.json --noEmit`, `vitest run` |
| | `gen` / `sample` | `node dist/gen.js` / `node dist/gen.js --sample` |
| | `build:runtime-core` | `cd ../packages/runtime && tsup src/index.ts --no-config --format esm --target es2022 --platform neutral --out-dir dist --external onnxruntime-web --external onnxruntime-web/webgpu --sourcemap` |
| | `build:model-host` | `cd ../packages/runtime && tsup src/model/host.ts --no-config --format esm --target es2022 --platform neutral --out-dir ../../sim/dist/model-host --external onnxruntime-web --external onnxruntime-web/wasm --external onnxruntime-web/webgpu` |
| `@genclass/demos` (`0.1.0`, private) | `dev` / `build` / `preview` | `vite` / `node scripts/build.mjs` / `node --experimental-strip-types e2e/serve.ts dist --base /genclass/ --port 4173` |
| | `typecheck` / `typecheck:shim` | `tsc -p tsconfig.json` (or `tsconfig.shim.json`) `--noEmit && tsc -p tsconfig.sw.json --noEmit && tsc -p tsconfig.node.json --noEmit` |
| | `fetch-model` | `bash scripts/fetch-model.sh public/genclass-model` |
| | `eval` / `eval:fast` / `shots` | `node --experimental-strip-types e2e/eval.ts` (`--fast` / `--shots-only`) |

Demos devDeps pin the same `@playwright/test` `1.63.0` as the runtime and use `vite ^8.3.3`.

Details: [../sim.md](../sim.md), [../demos.md](../demos.md), [../realapps.md](../realapps.md).

### Exact commands

Local (allowed for agents off the 8 GB Mac; what CI runs):

```sh
npm ci --no-audit --no-fund                     # repo root; uses the committed lockfile (add ONNXRUNTIME_NODE_INSTALL=skip on Linux, as CI does)
npm run typecheck -w @genclass/runtime          # or: cd packages/runtime && npx tsc -p tsconfig.json --noEmit
npm run build -w @genclass/runtime              # tsup -> packages/runtime/dist
cd packages/runtime
NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts   # CI "Unit tests"
NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts --retry=2                              # CI "Perf budgets"
npx vitest run test/atoms.test.ts -t "late discard"                                                     # one file / one test
npx vitest run test/situation.test.ts test/delivery.test.ts test/content.test.ts test/budget.test.ts     # prints the STATUS example situations (console.log)
npm pack --dry-run                              # list tarball contents (files: dist, bin, README.md, LICENSE)
cd ../../sim && npx tsc -p tsconfig.json --noEmit && SIM_RUNTIME=real npx vitest run   # sim tests on the real runtime (needs the runtime build); not the generator
```

Heavy (ask the user first; on Mehar's setup they go through his VM slot):

```sh
scripts/vm.sh exec core 'cd packages/runtime && GENCLASS_MODEL_DIR=~/gcl/model/.cache-model NODE_OPTIONS=--expose-gc npx vitest run'
scripts/vm.sh exec model 'cd packages/runtime && GENCLASS_MODEL_DIR=~/gcl-cache/model-v0.1 npx vitest run test/model'
scripts/vm.sh exec model 'cd packages/runtime && GENCLASS_MODEL_DIR=~/gcl-cache/model-v0.1 npm run test:browser'   # add --project chromium | swiftshader-webgpu
scripts/vm.sh exec model 'cd packages/runtime && GENCLASS_MODEL_DIR=~/gcl-cache/model-v0.1 npx playwright test --config test/browser/playwright.config.ts model.spec.ts -g "inline fallback"'   # one spec / one test
scripts/vm.sh exec core 'cd packages/runtime && npx playwright test --config test/browser/ui/playwright.config.ts'
scripts/vm.sh exec core 'cd packages/runtime && bash test/smoke/smoke.sh'
# one-time per machine (not in any repo script; unverified that the VM needed it): npx playwright install chromium
# fetch the v0.1 model for the model tests (command from packages/runtime/src/model/README.md; default --variant all)
scripts/vm.sh exec model 'node packages/runtime/bin/genclass-runtime.mjs fetch-model ~/gcl-cache/model-v0.1 --from https://github.com/MeharPro/GenClass/releases/download/v0.1.0/'
```

The two `GENCLASS_MODEL_DIR` paths above are the ones written in `packages/runtime/STATUS.md` and `packages/runtime/src/model/README.md`; which of them exists on the VM is unverified. Both hold the v0.1 GenClass model (the parity fixtures' model), not a runtime model: no situation-v2 runtime model exists yet.

### Where to run things

- **Mehar's team rule** (`HANDOFF.md` "Rules", `docs/runtime/CONTRACT.md` §0 rule 5, `scripts/vm.sh` header): his Mac has 8 GB RAM and is near OOM, so on it nothing runs (npm, tsc, vitest, node, browsers, torch, models); builds and tests go through `scripts/vm.sh` on the `train` VM.
- **Lead policy for agents (2026-10-08):** on any other machine, run these locally; they are light and were verified (next section):
  - `npm install` / `npm ci` at the repo root;
  - typecheck (`tsc`) and build (`tsup`) of `packages/runtime`;
  - the runtime unit tests (vitest, browser specs excluded), and the sim's unit tests with `SIM_RUNTIME=real`.
- **Ask the user first** before running any of:
  - Playwright (`npm run test:browser`, the UI spec, `test/smoke/smoke.sh`, which also installs from the npm registry);
  - the sim generator (`sim` `gen`, `sim/scripts/*`);
  - training (`training/*.sh`, Python training or tests);
  - realapps runs (`realapps` `build`/`gen`, its harness scripts);
  - the demos' eval (`demos/scripts/vm-eval.sh`, `npm run eval` in `demos`);
  - model downloads (`genclass-runtime fetch-model`, `demos/scripts/fetch-model.sh`);
  - anything on Azure (`scripts/*.sh`, including `scripts/vm.sh`, `az`). Mehar is actively operating the cluster for v2 data generation; nobody on our side touches it;
  - `git push` and `npm publish`.

### Verified locally (2026-10-08)

Run on `mvp-v2` at b435acb on a macOS machine (16 GB RAM, Node v25.6.0), by the lead (the per-file vitest counts in [Tests](#tests) were re-collected for this doc):

| step | command (directory) | result |
|---|---|---|
| install | `npm ci` (fresh clone, repo root) | OK from the committed lockfile; EBADENGINE warning from vitest on Node 25 (below) |
| typecheck | `npx tsc -p tsconfig.json --noEmit` (`packages/runtime`) | clean |
| build | `npx tsup` (`packages/runtime`) | OK, 6 entries, `.d.ts` for all but `worker` |
| unit tests | `NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts` (`packages/runtime`) | Test Files 40 passed \| 1 skipped (41); Tests 332 passed \| 14 skipped (346) |
| perf budgets | `NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts` | 4 passed. In a full parallel run it once failed at 5.5 ms against its 2 ms bound (contention), hence CI's separate step with `--retry=2` |
| sim | `npx tsc --noEmit`; `SIM_RUNTIME=real npx vitest run` (`sim`) | clean; 19 passed (5 files) |
| CI steps | the five steps of `ci.yml`, in a fresh clone | pass |

- **The 14 skipped tests** are model-parity tests that need model files in `GENCLASS_MODEL_DIR` (default `<repo>/.cache-model`), which did not exist on that machine: `test/model/packer.test.ts` all 10 (the one fully skipped file), `test/model/engine.test.ts` 3 of 4, `test/model/calibrate.test.ts` 1 of 8. With a model directory all 350 should pass (STATUS: 346 on the VM, before `default-mode.test.ts`). Getting one means a model download: ask the user first.
- **On `origin/runtime` (74f17c0) itself**, where the default mode is still `guard`: 331 passed + 1 flaky perf failure + 14 skipped = 346.
- **EBADENGINE warning.** `vitest@5.0.3` declares `engines.node` `^22.12.0 || ^24.0.0 || >=26.0.0`. Node 25 is outside that range, so npm warns, but the tests run. Node 22.x from 22.12, 24.x and 26+ are inside it; 23.x and 25.x are not. CI uses `node-version: 22` (latest 22.x).
- **Install side effects are gone**: the lockfile is committed and the CLI is committed as 100755, so a root `npm install` / `npm ci` leaves `git status` clean (unless dependencies changed).
- **Untracked test files.** Working copies used by parallel agents may contain untracked `test/zz-*.test.ts` files (`zz-review-*`, `zz-verify-*`; one appeared mid-run during this doc's check and lifted the count to 351); vitest collects them (`include` is `test/**/*.test.ts`) and some may fail. They are not part of the branch: check `git status` before trusting a red run, and count only tracked files.
- **Not run:** Playwright (main and UI configs), `test/smoke/smoke.sh`, realapps, the demos' eval, Python tests, training, model downloads, anything on Azure.

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
| `engines.node` | pkg | `>=20` (root and runtime) | `package.json`s | VM and CI run Node 22 |
| CI triggers | ci | push to `main`, `runtime`, `mvp`, `mvp-v2`; `pull_request` (any branch); `workflow_dispatch` | `.github/workflows/ci.yml` -> `on` | |
| CI `permissions` / `concurrency` | ci | `contents: read`; group `ci-${{ github.ref }}`, `cancel-in-progress: true` | `.github/workflows/ci.yml` | a new push cancels the running job of the same ref |
| CI runner / timeout / Node | ci | `ubuntu-latest`, `timeout-minutes: 15`, `actions/setup-node@v4` `node-version: 22`, `cache: npm` | `.github/workflows/ci.yml` -> `jobs.runtime` | |
| `ONNXRUNTIME_NODE_INSTALL` | env (CI) | `skip` | `.github/workflows/ci.yml` -> `jobs.runtime.env` | stops `onnxruntime-node` (dev-only, model parity tests) from downloading CUDA binaries on Linux; those tests skip anyway without a model dir |
| CI test env | ci | `NODE_OPTIONS: --expose-gc`, `working-directory: packages/runtime` | unit-test and perf steps | gc test really runs |
| perf retry | ci | `--retry=2` | "Perf budgets" step | `review-perf.test.ts` wall-clock bounds are noisy on shared runners |
| default `mode` | const | `"observe"` | `src/runtime.ts` -> `o.mode ?? "observe"` (f3636b2) | the product default; `?genclass=guard` / `heal` or `mode` opt in |
| `setup()` `mode` | test | `"guard"` | `test/helpers.ts` -> `setup` | override with `mode: undefined` for the product default |
| `policy.holdWrites` | option | `false` (unset) | `src/types.ts` -> `PolicyOptions.holdWrites` | tests about held store writes pass `true` |
| `MockRuntime.situationBudget()` | test | `2400` (was `3200`) | `test/browser/ui/mock-runtime.ts` | matches the v2 full budget |
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

- **Do not run builds or tests on Mehar's 8 GB Mac.** That is the binding team rule there (`HANDOFF.md` "Rules"). Elsewhere the run policy in AGENTS.md allows the light checks locally and requires the user's OK for everything heavier ([Where to run things](#where-to-run-things)). `vm.sh` needs `~/.jev-local/azure_hosts` (a `train` line) and `~/.ssh/jev_azure`, neither of which is in the repo. It also calls GNU `timeout` on the local machine, which macOS does not include by default. Without all three, `vm.sh` cannot reach a VM. If you have no VM, ask the user; do not quietly run heavy jobs locally.
- **`dist/` must exist before anything consumes the package.** `sim`, `demos` and demo typechecking resolve `@genclass/runtime` through `exports` -> `dist/`. Root `npm run typecheck` therefore needs `npm run build` first (demos' `typecheck` reads `dist/*.d.ts`; `typecheck:shim` avoids it). The demos typecheck (and `typecheck:shim`) also needs the missing `demos/src/server/data/cities.ts` (see [../demos.md](../demos.md#drift-and-open-issues) Drift 1). It is not in git because the root `.gitignore`'s unanchored `data/` matches `demos/src/server/data/` (`git check-ignore -v` names that line). `src/server/worlds/search.ts`, `src/demos/search/scenario.ts` and `src/demos/search/oracle.ts` import it, so `tsc -p demos/tsconfig.json` and `tsconfig.shim.json` fail with TS2307 "Cannot find module ... cities.ts" (checked 2026-10-08 with `packages/runtime/dist/` built), and so does the root `npm run typecheck`.
- **`clean: true` + a failed build = a half-empty `dist/`.** `demos/scripts/vm-eval.sh` refuses to measure after a failed runtime build for this reason (`ALLOW_BROKEN_RUNTIME=1` overrides).
- **`npm run test:browser` rebuilds `packages/runtime/dist/`** (its global setup runs `npx tsup`). Do not run it in a slot where another job is reading `dist/`.
- **Keep tsup entries as literal `"src/...ts"` strings.** `build.mjs` -> `fullBuildPossible` finds them with a regex over the config text.
- **Keep the worker URL pattern and the two `import("onnxruntime-web/webgpu" | "onnxruntime-web/wasm")` literals.** Bundlers (Vite, webpack) recognise them; `build.mjs` fails if either disappears from the output.
- **Tests are not type-checked** (`tsconfig.json` `include: ["src"]`; vitest strips types). A test can drift from the public types and still pass; `MockRuntime` (`implements Runtime`) in particular can fall behind the `Runtime` interface without any error (the situation-v1 STATUS said so explicitly; the current STATUS no longer mentions it).
- **Unit tests import from `test/browser/ui/`** (`mock-runtime.ts`, `scenario.ts`, `session.ts`). The vitest exclude only stops test discovery there; moving or renaming those files breaks `adapters-*.test.ts`, `devtools*.test.ts`.
- **Determinism.** Runtime code uses only the injected `Clock` (CONTRACT §0 rule 3). Tests assert byte-identical situations across runs (`situation.test.ts` "determinism", `budget.test.ts` "byte-identical"). Never use `Date.now`, `performance.now`, `Math.random` or the global `setTimeout` directly in `src/` (rule 3 names all of them); in tests use `FakeClock`, not real timers. Exceptions: wall-time measurements with `performance.now` in `review-perf.test.ts`, `test/model/engine.test.ts` and `test/model/packer.test.ts`, the real `browserClock` in `test/model/loader.test.ts`, and the 40 ms real `setTimeout` "frame" waits in `devtools.test.ts` / `devtools-runtime.test.ts`.
- **Wall-clock thresholds in `review-perf.test.ts`** (user write < 1 ms, async write < 2 ms, redux dispatch < 1 / < 2 ms, settled point < 16 ms on 5,000-item stores) can fail on a loaded machine: the lead saw one 5.5 ms failure against the 2 ms bound in a full parallel run on 2026-10-08, and it passed alone. CI therefore runs it in its own step with `--retry=2`; run it alone locally too before calling it a regression. STATUS (batch 5, shared VM): keystroke write 0.22 ms, async write 0.14 ms, redux dispatch 0.71 ms (user) / 0.70 ms (async), settled point 0.3 ms (+2.3 ms with an unchanged 5,000-item adapter store).
- **The gc test passes silently without `--expose-gc`.** `review-timers.test.ts` "a polling loop does not retain..." logs `[review] skipped: run with NODE_OPTIONS=--expose-gc` and returns.
- **Review tests are a contract.** Never edit `test/review-*.test.ts` to make them pass; fix `src/`.
- **Situation wording is frozen at `situation-v2`** (tag on 6e5e86e; `situation-v1` is superseded). `situation.test.ts`, `budget.test.ts`, `batch3.test.ts`, `content.test.ts` and `delivery.test.ts` assert exact fact sentences (regexes / `toContain`), and `invariants.test.ts`, `review-fetch.test.ts`, `review-hub.test.ts` assert fact fragments; `report.test.ts`, `atoms.test.ts`, `fetch.test.ts`, `learn.test.ts`, `devtools-runtime.test.ts` assert report / reason / `changed` / title wording. (`smoke.test.ts` prints a delivery situation but asserts only the decision, `dropped` and `subject.kind`, not wording.) SIM's ≥ 10M-row v2 data set and REAL's real-browser rows are being generated from that tag right now, and `training/curriculum/rt.py` mirrors the renderer (its header names `src/situation/{facts,conflicts,content,evidence,describe,build,serialize,questions}.ts` and `src/state/fields.ts` -> `changeText` / `stringDiff`). The example situations in `packages/runtime/STATUS.md` are copied from the `console.log` output of `budget.test.ts` (compact budgets) and `situation.test.ts`, `delivery.test.ts`, `content.test.ts` (full budget). Any change under `src/situation/*` (or to `changeText` / `stringDiff`) means a new tag and regenerated data: coordinate with Mehar (SIM, REAL, TRAIN) first (`HANDOFF.md` "Rules").
- **Browser parity fixtures are v0.1-only.** `test/browser/model-helpers.ts` always reads `test/fixtures/model/{requests50,pack_fixtures,torch_fixtures}.json`, so `model.spec.ts` parity assertions only hold when `GENCLASS_MODEL_DIR` is the v0.1 GenClass model. The unit tests switch to an export's own fixtures (`FIXTURES_FROM_MODEL`); the browser specs do not.
- **The default Playwright config also runs `ui-devtools.spec.ts`.** Its `chromium` project matches every `*.spec.ts` except `*webgpu.spec.ts`, so `npm run test:browser` also re-runs the UI spec. That run uses Playwright's default viewport and device scale factor (the main config sets neither) and overwrites the committed screenshots. Use the UI config to regenerate screenshots.
- **The UI spec needs the demos workspace installed** (fonts come from `@fontsource-variable/*`, dependencies of `demos`, hoisted to `<repo>/node_modules`). Run a root `npm install`, not one scoped to the runtime.
- **Node version.** `test/model/helpers.ts` -> `pythonOnlyFloatRequests` uses `JSON.parse` source-text access (Node >= 21). On Node 20 it finds nothing, so fixtures holding Python-only float literals such as `25.0` would not be skipped by the packer parity test. Use Node 22 as on the VM and in CI. Node 25.6.0 also ran the unit tests in the 2026-10-08 pass, with an EBADENGINE warning from vitest ([Verified locally](#verified-locally-2026-10-08)).
- **Global singletons in tests.** `report.test.ts`, `batch3.test.ts` and `default-mode.test.ts` use `GenClass.init`; always `GenClass.destroy()` (and delete `globalThis.location` if you set it). happy-dom tests patch `window` globals: `rt.destroy()` in `afterEach`. `review-hub.test.ts` swaps `process` `unhandledRejection` listeners and restores them in `finally`.
- **Network-dependent steps:** `smoke.sh` (npm registry), `model.spec.ts` "default ORT wasm path" (jsDelivr; `GENCLASS_OFFLINE=1` skips it), `fetch-model` (GitHub).
- **Fixture JSON files are single-line.** `wc -l` prints `0` for `pack_fixtures.json` (955,379 bytes), `py_fixtures.json` (167,629), `requests50.json` (285,309) and `torch_fixtures.json` (255,945): no trailing newline, not empty. Use `wc -c` or a JSON parser.
- **No `prepublishOnly` and no `publishConfig`.** `npm publish` packs whatever `dist/` holds; build right before publishing. Scoped packages publish as restricted unless `--access public` is passed (npm behaviour).
- **The root lockfile is committed; keep it in sync.** Since b435acb `package-lock.json` is tracked and CI runs `npm ci`, which fails when any workspace `package.json` (root, `packages/*`, `sim`, `demos`) no longer matches the lockfile. After changing a dependency, run `npm install` at the repo root and commit the updated lockfile in the same commit. `realapps/` is not a workspace and has no lockfile of its own.
- **Test harness mode is not the product mode.** `test/helpers.ts` -> `setup()` defaults to `mode: "guard"`, so a test that does not pass `mode` exercises guard, while a real app (and `GenClass.init`, the smoke script, any package built from this branch, including the published `0.1.0-alpha.1`; only the older `0.1.0-alpha.0` defaults to guard) starts in `observe`. To test default behaviour pass `mode: undefined`. New headless harnesses that build their own runtime (like `review-fetch.test.ts` -> `headless()`) must pass `mode` explicitly or they observe only.
- **Held store writes are opt-in.** Since batch 4 `policy.holdWrites` is off: an async `set()` applies at once and a model `discard` is a late revert (`interventions()[i].late`). A test that expects `a.get()` to stay unchanged until the model answers needs `policy: { holdWrites: true }`; otherwise assert on the `delivery` decision or the late revert.
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
2. Use `setup()` and drive time with `clock.advance` / `clock.flush`. Use `triage: "always"` to force a model consultation, `mode: "heal"` for heal-tier actions (`setup()` defaults to `"guard"`; `mode: undefined` for the product default `observe`), `ManualDecider` to control answer timing. To test held store writes add `policy: { holdWrites: true }`; for the default v2 behaviour drive a network response and assert on the `delivery` decision (copy the app helpers in `delivery.test.ts` -> `searchApp` or `content.test.ts` -> `listApp`).
3. Name the contract section in the `describe` (e.g. `"(CONTRACT §4)"`). For a bug demonstration, follow the `review-*.test.ts` files: a header comment `// REVIEW: <area>. A failing test demonstrates a bug.`, a `describe("review: ...")`, and a test name that states the required behaviour.
4. For DOM: first line `// @vitest-environment happy-dom`, then `createRuntime({ clock: new FakeClock(), global: window, decider, mode: "guard" /* if you need actions */, report: "silent", observe: { ...OFF, user: true } })` where `OFF` sets `fetch, xhr, errors, nav, storage, perf, websocket, timers` to `false` (copy it from `dom.test.ts`), and `rt.destroy()` in `afterEach`.
5. For model files: `describe.skipIf(!hasModelFile("model.json"))`.

```ts
import { describe, expect, it } from "vitest";
import { ManualDecider, defaultScript, setup } from "./helpers.js";

describe("my change (CONTRACT §4)", () => {
  it("holds an async write until the model answers", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always", policy: { holdWrites: true } }); // holds are opt-in since v2
    const a = rt.atom("v", 0);
    void rt.op("save", () => a.set(5));
    expect(a.get()).toBe(0); // held
    manual.answer(defaultScript({ mutation: { diagnosis: "expected", action: "apply" } }));
    await clock.flush();
    expect(a.get()).toBe(5);
  });
});
```

Run it locally: `cd packages/runtime && npx vitest run test/<file>.test.ts` ([Where to run things](#where-to-run-things)). CI picks up any new `test/**/*.test.ts` automatically.

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

The format is frozen at `situation-v2` and v2 training data is being generated from it now. Do not change it without Mehar's go-ahead.

1. Edit `src/situation/*` (and, for change previews, `src/state/fields.ts` -> `changeText` / `stringDiff`) only: a single implementation shared with `sim/`; `realapps/` bundles the same source; `training/curriculum/rt.py` mirrors the renderer in Python and must be updated too.
2. Update the exact-text assertions in `test/situation.test.ts`, `test/budget.test.ts`, `test/batch3.test.ts`, `test/content.test.ts`, `test/delivery.test.ts`, `test/invariants.test.ts`, `test/review-fetch.test.ts`, `test/review-hub.test.ts` (facts) and, for report and title wording, `test/report.test.ts`, `test/atoms.test.ts`, `test/fetch.test.ts`, `test/learn.test.ts`, `test/devtools-runtime.test.ts`, and `SessionDecider` -> `judge()` regexes in `test/browser/ui/session.ts` (search for the old sentence). Changing a `review-*` assertion conflicts with "Review tests are a contract" (gotchas): raise it rather than rewrite it silently.
3. Re-run `situation.test.ts`, `delivery.test.ts`, `content.test.ts` and `budget.test.ts`, paste their printed situations into the STATUS.md example sections ("Example situations: compact budgets" from `budget.test.ts`; "full budget (2,400)" from the other three).
4. Cut a new frozen tag (`situation-v3`) only with the owner, and tell SIM, REAL and TRAIN: rows must be regenerated, and models trained on v2 data were trained on the old text. See [learn-situation-triage.md](learn-situation-triage.md), [../model-io-contract.md](../model-io-contract.md) and [../realapps.md](../realapps.md).

### Regenerate model fixtures

- `py_fixtures.json` (needs the jev venv: `tokenizers`, `numpy`, `pydantic`, and the v0.1 tokenizer so `isV01Tokenizer` passes):
  `~/jev/.venv/bin/python packages/runtime/test/fixtures/model/make_py_fixtures.py --tokenizer <model dir>/tokenizer.json --out packages/runtime/test/fixtures/model/py_fixtures.json`
  It also reads `<model dir>/calibration.json` when present for the v1 calibration cases.
  The script prints `wrote <out>: <n> states, <n> texts, <n> calibration cases, <n> confidence cases` and writes one line (`json.dumps(..., ensure_ascii=False)`, no trailing newline). `~/jev/.venv` is the venv `scripts/vm_bootstrap.sh` creates (CPU torch, `tokenizers`, `numpy`, `pydantic>=2`, ...).
- WebGPU embedding variants (written outside the repo, used via `GENCLASS_WEBGPU_VARIANTS`; `--src` must be a runtime-card model dir with a q8 variant; needs `onnx` + `numpy`, and `onnx` is not in `vm_bootstrap.sh`'s pip list):
  `~/jev/.venv/bin/python packages/runtime/test/fixtures/model/make_webgpu_variants.py --src ~/gcl-cache/model-v0.1 --out ~/gcl-cache/webgpu-variants`
  Writes `f32emb/` (fp32 embedding table: `Gather(fp32)`) and `i8emb/` (int8 table + per-row fp32 scale: `Gather(int8) -> Cast -> Mul(Gather(scale))`).
- `pack_fixtures.json` / `torch_fixtures.json`: outputs of `scripts/genclass_export.py` or `extension/tools/genclass_export.py` (identical fixture code; which one produced the committed files is not recorded). Both export the extension's v1 computer-use model, import torch and say "RUN ON THE AZURE VM ONLY"; the fixtures are Python `Packer` output and PyTorch logits, so they do not depend on the int8 vs q8 ONNX variant. They were copied from `extension/test/fixtures/` and re-serialised compactly. Do not hand-edit them; the browser parity specs depend on them matching the v0.1 model. If you regenerate, re-serialise without whitespace to keep diffs comparable, and regenerate `requests50.json` from the same request set.

### Publish history (from git and the registry)

| when | commit / tag | what |
|---|---|---|
| 2026-10-07 19:19 -0400 | tag `situation-v1` -> 1a77558 | runtime fix batch 3; situation format v1 frozen for SIM data |
| 2026-10-07 20:09 -0400 | 59c213f | `version` `0.1.0` -> `0.1.0-alpha.0`, `packages/runtime/LICENSE` added, `test/smoke/smoke.sh`, `.gitignore` gains `.publish/` and `*.tgz` |
| 2026-10-07 20:15 -0400 (00:15 UTC 10-08) | 654d822, tag `v0.1.0-alpha.0` | READMEs get npm and license badges and an "alpha" note; OPEN_TASKS moves publish to "Done" |
| 2026-10-08 00:14 / 00:18 UTC | (npm) | `@genclass/runtime@0.0.0-stage` (about one minute before 654d822's commit time) then `0.1.0-alpha.0` (about three minutes after it) published (`npm view @genclass/runtime time`); dist-tag `latest` = `0.1.0-alpha.0`. OPEN_TASKS: "2026-10-08, `genclass` org, owner meharpro", smoke-tested first |
| 2026-10-07 21:16 -0400 (01:16 UTC 10-08) | ad24804, ce27efd | fix infinite recursion on `NaN` in state (`test/nan.test.ts`); OPEN_TASKS asks the user to publish `0.1.0-alpha.1` (needs 2FA); published later, see below |
| 2026-10-07 22:31 / 23:26 -0400 | fcd1e68, 6e5e86e (tag `situation-v2`) | runtime batch 4 (delivery trigger, no store holds by default) and batch 5 (separability facts); situation format v2 frozen |
| 2026-10-08 00:15 -0400 | f3636b2, b435acb (`mvp-v2`, ours, not pushed) | default mode `observe`; CI workflow, committed root lockfile, CLI mode 100755 |
| 2026-10-08 ~05:33 UTC | 806a296, local tag `v0.1.0-alpha.1` (not pushed) | `@genclass/runtime@0.1.0-alpha.1` published by karanvir1729 under `latest` (26 files, 486.8 kB, shasum 9e3e82bc...); first attempt 403 (no 2FA on the account), then browser-based 2FA approval |

`package.json` `version` is `0.1.0-alpha.1` on `mvp-v2`: release commit 806a296 is now the head of `mvp-v2` (fast-forwarded). What `.publish/` was used for is not recorded (unverified).

### Cut a release of `@genclass/runtime`

Full procedure: [RELEASE.md](../../../RELEASE.md) Part A.

There is no publish script, no `prepublishOnly` and no `publishConfig`. The recorded procedure (`HANDOFF.md` "Current state": "Each publish needs the user's 2FA, so give them the exact `npm publish <tgz> --access public` command") is: the agent prepares and checks a tarball, the **user** publishes it.

1. Locally: `npm ci`, `npm run typecheck -w @genclass/runtime`, `npm run build -w @genclass/runtime`, the unit tests and perf budgets as in CI (or a green CI run on the pushed branch). With the user's OK (ask first): vitest with `GENCLASS_MODEL_DIR`, the browser specs and `bash test/smoke/smoke.sh`.
2. Bump `version` in `packages/runtime/package.json` (e.g. `0.1.0-alpha.1`), plus the version strings in READMEs, `OPEN_TASKS.md` and `HANDOFF.md`. Run `npm install` at the root so the lockfile's `packages/runtime` entry picks up the version, and commit both.
3. From `packages/runtime`: `npm run build && npm pack` -> `genclass-runtime-<version>.tgz`; check `npm pack --dry-run` lists only `dist/`, `bin/`, `README.md`, `LICENSE`, `package.json`.
4. Give the user the command to run (on a machine logged in to npm with publish rights on the `genclass` org, with their 2FA): `npm publish genclass-runtime-<version>.tgz --access public --tag <tag>`. **A prerelease needs `--tag`** on npm 11: `lib/commands/publish.js` in npm 11.8.0 throws "You must specify a tag using --tag when publishing a prerelease version." unless `--tag` (or `publishConfig.tag`, or `--force`) is given, so `HANDOFF.md`'s bare `npm publish <tgz> --access public` fails for `0.1.0-alpha.1`. Use `--tag alpha` (or `next`) to leave `latest` where it is, or `--tag latest` to move it (today `latest` = `0.1.0-alpha.1`). A non-prerelease such as `0.1.0` needs no tag and becomes `latest`. Never run `npm publish` yourself without an explicit user go-ahead in chat.
5. After the publish: `git tag -a v<version> -m "@genclass/runtime <version> (npm)"` (push only with the user's OK); move the item to "Done" in `OPEN_TASKS.md`; check `npm view @genclass/runtime dist-tags`.

What `0.1.0-alpha.1` (built from `mvp-v2`) changed for users of `0.1.0-alpha.0`: default mode `observe` (was `guard`), situation-v2 runtime (delivery decisions, no store holds by default), the NaN fix. Without a published model the runtime still only observes either way.

### Publish the model package (planned; OPEN_TASKS.md item 9; HANDOFF.md "How to continue")

Full procedure: [RELEASE.md](../../../RELEASE.md) Part B.

Blocked on training: no situation-v2 model exists (next per HANDOFF: 150M teacher on v2 gold -> teacher labels on unlabeled rows -> distil R17 (default) and R32 -> DAgger via SIM `--on-policy` -> EVAL). The round-1 R17 (`files/r17/` per MODEL_CARD, situation-v1) does not match the v2 runtime and must not be published as the default. `DEFAULT_MODEL_BASE_URL` and the CLI `DEFAULT_FROM` both 404 today.

1. Put a model directory (card `genclass-runtime-model/1`: `model.json`, `<name>-q8.onnx`, `<name>-fp16.onnx`, `tokenizer.json`, `calibration.json`, `meta.json`) under `packages/runtime-model/files/` (gitignored), so jsDelivr serves it at `DEFAULT_MODEL_BASE_URL`. Check it with `node packages/runtime/bin/genclass-runtime.mjs info packages/runtime-model/files`.
2. Add `packages/runtime-model/package.json` (`@genclass/runtime-model`, `0.1.0`, `files` including `files/`). It then becomes a workspace automatically (`packages/*`), so run a root `npm install` and commit the lockfile change, or CI's `npm ci` fails.
3. Attach the same files to a GitHub release tagged `runtime-model-v0.1.0` (the CLI's `DEFAULT_FROM`).
4. Rerun the demos with the trained model, then publish `@genclass/runtime@0.1.0` without a prerelease tag (user, 2FA).

### CI (`.github/workflows/ci.yml`)

One workflow, `CI`, one job `runtime` ("@genclass/runtime: typecheck, build, unit tests"), added in b435acb:

| step | command | notes |
|---|---|---|
| checkout | `actions/checkout@v4` | |
| node | `actions/setup-node@v4`, `node-version: 22`, `cache: npm` | inside vitest 5's engine range |
| Install | `npm ci --no-audit --no-fund` | job env `ONNXRUNTIME_NODE_INSTALL: skip` |
| Typecheck | `npm run typecheck -w @genclass/runtime` | runtime only; the root `npm run typecheck` would also typecheck `sim` and `demos` (which needs `dist/` and the missing `demos/src/server/data/cities.ts`) |
| Build | `npm run build -w @genclass/runtime` | |
| Unit tests | `npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts` in `packages/runtime`, `NODE_OPTIONS: --expose-gc` | model parity tests skip (no `GENCLASS_MODEL_DIR`) |
| Perf budgets | `npx vitest run test/review-perf.test.ts --retry=2`, same env | |

Not in CI: Playwright (model and UI specs), `smoke.sh`, model-dir tests, `sim`/`demos`/`realapps`, Python tests. It has not run on GitHub yet (the branch is unpushed; `origin/runtime` has no `.github/`).

To change it: keep the runtime steps green locally first (same commands, [Exact commands](#exact-commands)). Adding the sim tests would need `npm run build -w @genclass/runtime` first and `SIM_RUNTIME=real`; adding browser specs needs `npx playwright install --with-deps chromium` and, for model specs, a model directory (a download: ask the user). Changing the trigger branches or adding jobs that publish is a user decision.

## Tests

Counts are `it(...)` cases (the `budget.test.ts` loop counts 3; the `no-reorder.test.ts` loop counts 4), collected with vitest's JSON reporter on b435acb. **Total 350 in 42 tracked files**: CORE 188, UI 53, MODEL 62, REVIEW 43, lead 4 (`default-mode.test.ts`). STATUS's "41 files, 346 tests" predates `default-mode.test.ts`. Without a model directory 14 MODEL tests skip (see [Verified locally](#verified-locally-2026-10-08)). Since 654d822: +5 files (`content` 14, `delivery` 16, `no-reorder` 6, `nan` 1, `default-mode` 4), and `atoms` +2, `batch3` +1, `dom` +4, `report` +1, `situation` +1. Tests that rely on held store writes now pass `policy: { holdWrites: true }` (`adapter-seam`, `adapters-*` real-runtime blocks, `plugins`, `report` (2 cases), `batch3` "ctx.builtin returns false ...", `review-hub` "in-place updater while held", `budget` hold-budget case, `no-reorder` last case; `atoms.test.ts` wraps `setup()` to always add it); the `adapters-*` `MockRuntime` blocks set `rt.holdWrites = true` on the mock instead.

| test file | owner | env | tests | what it asserts |
|---|---|---|---|---|
| `test/adapter-seam.test.ts` | CORE | node | 4 | `rt.adapter(name, io).propose({fn, commit})` with `holdWrites: true`: reducer preview, async dispatch held then committed, discard never commits, direct library changes recorded not held, rollback offered only when `io.set` exists |
| `test/adapters-react.test.ts` | UI | happy-dom | 9 | `useGenClassState` (one atom per name, held write shown only when applied, StrictMode-safe, plain-state fallback with one `console.info` "no runtime"), `useAtom`, `useGenClass` throws "No runtime", live `useGenClassDecisions/Interventions/Status`; with the real runtime (`holdWrites: true`): request, then a `delivery` decision, then the held `mutation`; hold, discard, undo; user-handler writes never held |
| `test/adapters-redux.test.ts` | UI | node | 11 | `genclassEnhancer`: passthrough, hold/apply once (reducer runs once), re-run on moved state, drop, middleware/thunks see the action once, no-op actions, `replaceReducer`, inner enhancers see `GENCLASS_REPLACE` for GenClass writes, `null` runtime; real runtime (`holdWrites: true`) hold/discard/undo |
| `test/adapters-zustand.test.ts` | UI | node | 6 | `genclass(rt, name)` middleware: merge semantics, hold/drop, replace/functional/no-op/extra `set` args, GenClass whole-state writes, `null` runtime; real runtime (`holdWrites: true`) |
| `test/ask.test.ts` | CORE | node | 5 | `ask()` typed answers (choice/noul/score), trigger `ask`, `about` an op or store, `decide()`, `GenClassUnavailableError` without a model (status `off`), timeout reason `timeout` |
| `test/atoms.test.ts` | CORE | node | 18 | mutation pipeline **with `holdWrites: true`** (local `setup` wrapper): user-sync writes never held, async held then applied, fail-open at `holdBudgetMs` + late discard revert + undo, no late revert when superseded / after 2 s / same chain wrote again, a model slower than the hold budget means no hold at all, late defer only recorded, provider errors fail open at once, proposal order, a user write never overtakes an earlier held write of the same store (DEMOS regression), queued functional updates re-run, read-your-writes inside the writing chain, patch re-apply, discard + undo, defer re-decides after related ops settle (max 2), `hold: false`, `guard()`, same-name atoms, field versions/writers |
| `test/batch3.test.ts` | CORE | node | 14 | SIM requests a–f (word-level redaction, kanban card values, no `= undefined` state lines, item change summaries, "changed N times and is back to V", slug ids via `normalizePath`/`isIdSegment`, pending-local-change fact), `ctx.builtin` through the gate, rate-limit warning once per minute, `ask()` after destroy, read-only globals, `GenClass.init` never throws, never-answering provider, `transient` label last; batch 5: redaction by the leaf field, never by the store name (an `auth` store keeps status flags and user name) |
| `test/budget.test.ts` | CORE | node | 12 | `sectionLimits` at 500 (= 1,100)/1,100/1,750/2,400 (3,200 = 2,400); budgets 1,000/1,100/2,000 shape every section of a `delivery` situation; compact questions at <= 1,400; vocabulary overrides <= 24 chars kept; determinism; auto budget (webgpu 2,400; wasm 1,000/1,333/2,000; unknown 2,400; fixed 1,500); `max_tokens_exceeded` shrinks auto budget to 1,920; `holdBudget` auto = clamp(1.5 x median, 150, 800) else 300; held write `timeoutMs` = budget + 2,000; fetch `timeoutMs` = remaining budget. Prints example situations |
| `test/content.test.ts` | CORE | node | 14 | batch 5 situation-v2 facts from `sim/SEPARABILITY.md` §6, one per fact: F3 a response that changes nothing is not salient; F1 put back a value a newer operation replaced (field, item cells); F2 overwrites text the user typed (diff-centred preview); F9 provenance of known-stale values (incl. a live channel that was down); F6 learned cadence (polling, debounced save); F5 failure scope and commit ambiguity; F7 repeated user action evidence; F8 relation quality; read-your-writes. Prints STATUS example situations |
| `test/context.test.ts` | CORE | node | 7 | causal context: fetch -> json -> set cause/root, concurrent chains, `rt.op` ambient in body and continuation, nested op causes, ambient cleared by `afterTask`, timers observer carries cause (`timer 300ms`), idle timers create no ops |
| `test/default-mode.test.ts` | lead (f3636b2) | node | 4 | `createRuntime` without `mode` is `observe`; `GenClass.init` without `mode` is `observe`, `mode: "guard"` or `?genclass=guard` opt in; in observe nothing is held, delayed or changed even at p = 0.99 (decisions recorded, `executed` false, detections reported); with a never-answering model nothing waits (atom, adapter commit, fetch success and failure all immediate) |
| `test/delivery.test.ts` | CORE | node | 16 | situation-v2 network-boundary decisions: clean typeahead (in-order, loading flags, debounce) makes zero model calls; a stale out-of-order response gets a `delivery` decision and `discard` drops only its stale field writes; holding a response is only latency; no hold when the model cannot answer within the hold budget; store writes never held by default (read-after-write, late revert, slow model released at the budget, superseded queued decisions dropped); WebSocket messages (held only when they would put back a value a pending local change replaced, order kept), EventSource (custom event types as ops), XHR (held before any completion listener, abort during the hold); forced actions with probability 1 |
| `test/devtools-runtime.test.ts` | UI | happy-dom | 7 | overlay on the real runtime (`runStoreSession`, guard): interventions newest first ("Prevented a stale response", "Reverted a duplicate write", "Prevented a duplicate request", "Slowed down a failing request"), folded detections, evidence = `explain()` (trigger "The response to GET /api/search?q=rea"), activity timeline, Now view, undo, live report sentence |
| `test/devtools.test.ts` | UI | happy-dom | 20 | overlay vs `MockRuntime` + `loadScenario`: mount/unmount (shadow root, `data-genclass-ignore`, no global CSS, listeners and plugin removed), no-op handle, theme/position, feeds, activity rows, typing bursts, evidence, undo and undo errors, live pill, folding, 200-card cap, policy reasons, pause/clear, Now view, mode switch, keyboard (Alt+Shift+G), empty states |
| `test/dom.test.ts` | CORE | happy-dom | 12 | `describeElement` (incl. batch 5: a control nested in its `<label>`, open shadow roots, `aria-labelledby`, slotted text); DOM user observer (clicks, typing bursts, passwords never recorded, submit/change/Enter, `[data-genclass-ignore]` incl. shadow roots, shadow-DOM targets described as the real element, synthetic `isTrusted: false` events only with `observe.untrustedEvents`, destroy); destroy restores fetch/XHR/history/Storage/WebSocket/timers; uncaught errors -> error trigger |
| `test/fetch.test.ts` | CORE | node | 17 | fetch observer: plain traffic makes no model call, app body vs clone, coalesce (`x-genclass: coalesced`), block (503 `blocked`), guard never runs heal-tier, `serve_cached`, delay 250 ms first, retry backoff 200 ms, retry not offered for non-replayable bodies, network error delivered, failure/request gates fail open at 300 ms, hedge, abort, `TimeoutError` = failure, cache <= `MAX_ENTRIES` (64) and skips bodies > `MAX_BODY` (256 KB), destroy restores fetch |
| `test/invariants.test.ts` | CORE | node | 6 | `InvariantMiner` learns len/sum/equality/unique relations, ignores unchanged fields and id-like keys; inconsistency once per episode + rollback + undo; unsettled transients ignored; `expect()` predicates |
| `test/learn.test.ts` | CORE | node | 8 | `Baselines` (latency after 5 samples, EWMA 0.9 error rate, streaks, outcomes, rate vs usual, identity gaps); `Profiles` (write set < 1% of >= 20, value kind, status class); transition trigger + rollback |
| `test/nan.test.ts` | CORE (ad24804) | node | 1 | a store holding `NaN` builds situations without infinite recursion (the alpha.0 crash; fixed in the published `0.1.0-alpha.1`) |
| `test/no-reorder.test.ts` | CORE | node | 6 | "never worse": realworld's Redux promise-middleware pattern through `genclassEnhancer` with an always-passive model (`PassiveDecider`, 10 ms): observe baseline renders; guard and heal x triage salient and always give identical dispatches, order, pages and final state with 0 interventions; `holdWrites: true` never reorders a store's dispatches |
| `test/plugins.test.ts` | CORE | node | 7 | plugin facts/diagnoses/custom actions, `ctx.builtin` (with `holdWrites: true`), plugin actions default to heal tier, `applicable()`, standing questions + `onAnswer`, `setup()`/cleanup API, vocabulary overrides |
| `test/policy.test.ts` | CORE | node | 14 | `gate()` summed mass, mode tiers, thresholds 0.9 guard / 0.8 heal, passive top, `requireDiagnosis`, deny/allow, pause, rate limit with 60 s sliding window, observe never holds, `setMode`, `pause()/resume()`, loading fails open without a record, detection threshold |
| `test/report.test.ts` | CORE | node | 8 | report line format, `explain(id)`, without `holdWrites` a discarded write is applied at once, late-reverted and reported "Reverted a stale write ... (decided 0.00s after it applied)" with `late: true`, "Not acted on (would have done ...)", console group + "(×2 more in the last minute)", `on()` listeners, `GenClass.init` idempotent, `?genclass=off`, `?genclass=heal` |
| `test/review-actions.test.ts` | REVIEW | node | 1 | error-trigger rollback only when the failing chain wrote state; user input survives |
| `test/review-dom.test.ts` | REVIEW | happy-dom | 2 | unlabeled password never recorded; programmatic `click()` inside an op is not a user action |
| `test/review-fetch.test.ts` | REVIEW | node | 11 | request identity (Request bodies, Range), coalesce with opaque / streaming responses never hangs, buffers <= 64 x 256 KB, abort listener removed, no work after destroy, guard-mode failures not held, keepalive sent synchronously, "started after" direction, error-rate counts. Its local `headless()` passes `mode: "guard"` (f3636b2) |
| `test/review-hub.test.ts` | REVIEW | node | 8 | held value write patched over user edit, queued nested object kept, late-revert undo, in-place push summary, in-place updater while held (`holdWrites: true` since batch 4), versions past 16 history entries, deep change in 2,000-item array, throwing commit does not strand the queue |
| `test/review-misc.test.ts` | REVIEW | node | 6 | console ×N summaries, rate-limit warning once, read-only `fetch`, `ctx.builtin` cannot run a denied heal-tier action, never-settling provider, `ask()` after destroy |
| `test/review-perf.test.ts` | REVIEW | node | 4 | wall-clock cost budgets on 5,000-item stores (see gotchas); logs numbers. Runs in its own CI step with `--retry=2` |
| `test/review-precision.test.ts` | REVIEW | node | 4 | short last page is not a transition, keyed keys like `m21` are not, closing a selection is not an inconsistency, a lingering violation does not freeze snapshots |
| `test/review-redaction.test.ts` | REVIEW | node | 1 | custom `redact` also applies to invariant facts |
| `test/review-timers.test.ts` | REVIEW | node | 2 | 200,000-step recursive `setTimeout` loop does not throw; polling loop does not retain ops (registry prunes beyond 2,000; gc check needs `--expose-gc`) |
| `test/review-xhr.test.ts` | REVIEW | node | 4 | sync XHR never held, abort while held means never sent, listeners added once per object, reuse after a blocked answer |
| `test/situation.test.ts` | CORE | node | 11 | one situation per trigger: `delivery` (a stale response about to overwrite newer results; in-order responses never ask), `mutation` (an older task's write over a newer task's, applied then late-reverted), request, failure, stall, inconsistency, transition, error, `ask` (side-effect free): keys `app, trigger, facts, in_flight, timeline, state, stats`, section limits, `stateChars <= STATE_CHAR_BUDGET`; serializer drop order; determinism. Prints situations |
| `test/smoke.test.ts` | CORE | node | 3 | atoms apply synchronously when nothing is salient; context through real awaits; in guard mode a stale out-of-order response gets one `delivery` decision, `discard` drops only `search.results` (`interventions()[0].dropped`), the app still sees the response (own local `setup()` with `mode: "guard"`) |
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

- **`HANDOFF.md` "What this is"** says "Modes: observe -> guard (default; ...) -> heal". Since f3636b2 (on `mvp-v2` only) the default is `observe`; guard is opt-in and heal experimental. `HANDOFF.md` and `STATUS.md` were not updated by that commit.
- **`HANDOFF.md` "Current state"** gives the publish command as `npm publish <tgz> --access public`. With npm 11 that fails for any prerelease (`0.1.0-alpha.1`) unless `--tag` is added ([Cut a release](#cut-a-release-of-genclassruntime) step 4).
- **`.gitignore` `data/` hides `demos/src/server/data/cities.ts`**, which the demos import; see gotchas and [../demos.md](../demos.md).
- **Test counts.** `STATUS.md` "State" says "41 files, 346 tests" and `HANDOFF.md` "346 tests pass"; on `mvp-v2` it is 42 files, 350 tests (`default-mode.test.ts` added).
- **Branch header.** `OPEN_TASKS.md` says "Branch `runtime`"; `origin/main` is still 654d822, so "Merging `runtime` into `main`" ("Needs the user") is still open.
- `packages/runtime/STATUS.md` "Open issues" says `react-dom` is not a devDependency of `@genclass/runtime`, and `packages/runtime/UI-NEEDS.md` item 2 (still under "Open") asks for `react-dom` and `@types/react-dom`. Both are devDependencies: `react-dom ^19.3.0`, `@types/react-dom ^19.0.0`. UI-NEEDS item 1 (ignore `[data-genclass-ignore]`) is also listed as open but is implemented and tested (`dom.test.ts`).
- `packages/runtime/src/model/README.md` ("Bundling") says `dist/worker.js` imports `onnxruntime-web/webgpu`. The worker imports either `onnxruntime-web/webgpu` or `onnxruntime-web/wasm` on demand (`src/model/worker.ts`; the same README's file table says so), and `build.mjs` checks both.
- `test/browser/model-helpers.ts` -> `saveResults` doc comment says it writes `test-results/browser/<name>.json`. The code writes `test-results/model-bench/<name>.json` (the model README is correct).
- `test/browser/ui-devtools.spec.ts` calls its output "the README screenshots", but no README or doc references `test/browser/ui/screenshots/*.png`.
- `sim/README.md` says the runtime's full tsup config "fails until those [adapter] files exist". The adapters exist; the full build works.
- `docs/runtime/CONTRACT.md` §1 describes `packages/runtime-model/` as "model card + files for the CDN package". Only `MODEL_CARD.md` is tracked; `files/` is gitignored (MODEL_CARD mentions a local `files/r17/`, situation-v1) and there is no `package.json`.
- `packages/runtime-model/MODEL_CARD.md` lists 9 diagnoses (no `transient`); the runtime has 10 (`DEFAULT_DIAGNOSES` ends `unusual, transient`, asserted in `batch3.test.ts`).
- Documented `GENCLASS_MODEL_DIR` locations differ: `~/gcl/model/.cache-model` (STATUS), `~/gcl-cache/model-v0.1` (model README), `~/gcl/models/genclass-v0.1` (demos `vm-eval.sh` default model dir). Unverified which exist on the VM.
- `scripts/genclass_export.py` usage text passes `--requests extension/genclass/test/fixtures/requests50.json`; that path does not exist in this repo (the file is `extension/test/fixtures/requests50.json`; the script's own instructions say to run "from ~/jev on the VM").
- Ownership: `docs/runtime/CONTRACT.md` §1 (layout) still lists `src/adapters/` and `src/devtools/` as owner CORE, but §13 (Additions) reassigns them to UI, which matches `STATUS.md` counting their tests as UI's. §1 is stale; the Tests table follows §13 / STATUS.
- `test/browser/model-helpers.ts` and `model.spec.ts` parity still target the v0.1 GenClass model; nothing in the browser specs exercises a situation-v2 runtime model (none exists).

Resolved since 654d822 (moved out): no CI and no committed lockfile (b435acb); the CLI's 100644 mode flip on install (b435acb); the npm dist-tag question (`latest` was `0.1.0-alpha.0` per `npm view`; since 2026-10-08 it is `0.1.0-alpha.1`); `STATUS.md`'s stale "For UI" note about `MockRuntime.holdBudgetMs()/situationBudget()` and its redundant `--exclude "test/browser/**"` command (both gone from STATUS).

Open items in scope (from `OPEN_TASKS.md`, `HANDOFF.md`, `training/NEEDS.md`, STATUS):

- **`0.1.0-alpha.1`**: published 2026-10-08 from `mvp-v2` (806a296) under `latest`. 806a296 is now the head of `mvp-v2`. Still open: push `mvp-v2` and tag `v0.1.0-alpha.1` to origin (needs an account with write access).
- **Push and first CI run**: `mvp-v2` (with `.github/workflows/ci.yml`) is local only; pushing needs the user's OK. Until then CI has never run on GitHub (the `review-perf` retry and the `ONNXRUNTIME_NODE_INSTALL=skip` setting are verified only locally).
- **Model package**: blocked on v2 training (SIM v2 data on c02–c09 and c12–c23, REAL on c01, c10, c11, per `training/NEEDS.md`; then teacher, distillation, DAgger, EVAL). Then `@genclass/runtime-model@0.1.0` + GitHub release `runtime-model-v0.1.0`, demos rerun, `@genclass/runtime@0.1.0`. Until then the default model URL 404s and the runtime only observes.
- Docs (item 13): dev-only lazy import of the devtools (52 KB min / 17 KB gz).
- The VM path (`scripts/vm.sh`) depends on Mehar's hosts file and SSH key. Without them the light checks run locally under the run policy in AGENTS.md; anything heavier needs the user's go-ahead.
- Any situation-wording change must be coordinated with SIM, REAL and TRAIN (frozen at `situation-v2`).
- Working copies may hold untracked `test/zz-*.test.ts` files from parallel review agents; vitest collects them. They are not part of `mvp-v2`.

## Related docs

- Runtime docs (this set): [public-api-and-lifecycle.md](public-api-and-lifecycle.md), [observe-and-trace.md](observe-and-trace.md), [state-and-adapters.md](state-and-adapters.md), [learn-situation-triage.md](learn-situation-triage.md), [decide-policy-actions.md](decide-policy-actions.md), [model-host.md](model-host.md), [devtools.md](devtools.md)
- Cross-cutting: [../model-io-contract.md](../model-io-contract.md), [../sim.md](../sim.md), [../realapps.md](../realapps.md), [../training.md](../training.md), [../demos.md](../demos.md), [../genclass-model-lineage.md](../genclass-model-lineage.md), [../extension-and-benchmarks.md](../extension-and-benchmarks.md), [../status-and-known-issues.md](../status-and-known-issues.md), [../README.md](../README.md), [../overview.md](../overview.md), [../repo-map.md](../repo-map.md), [../glossary.md](../glossary.md), [../playbooks.md](../playbooks.md), [../../../AGENTS.md](../../../AGENTS.md)
- Existing sources: [docs/runtime/CONTRACT.md](../../runtime/CONTRACT.md), [docs/runtime/API.md](../../runtime/API.md), [packages/runtime/STATUS.md](../../../packages/runtime/STATUS.md), [packages/runtime/src/model/README.md](../../../packages/runtime/src/model/README.md), [OPEN_TASKS.md](../../../OPEN_TASKS.md), [RELEASE.md](../../../RELEASE.md) (release procedure: Part A runtime, Part B model and 0.1.0), [HANDOFF.md](../../../HANDOFF.md), [docs/runtime/RESULTS.md](../../runtime/RESULTS.md), [training/NEEDS.md](../../../training/NEEDS.md), [.github/workflows/ci.yml](../../../.github/workflows/ci.yml), [packages/runtime-model/MODEL_CARD.md](../../../packages/runtime-model/MODEL_CARD.md), [sim/README.md](../../../sim/README.md), [demos/README.md](../../../demos/README.md)
