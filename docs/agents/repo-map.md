# Repository map (GenClass-lib)

> **Scope:** every tracked path (`git ls-files`: 749 files at 654d822), plus the generated and ignored paths that show up in a working copy.
> **Read this when:** you need to find where a file, symbol, constant, CLI command, env var or config key lives; decide whether a directory matters for `@genclass/runtime`; or want to know which paths are generated, ignored or too large to read in full.
> **Source of truth:** `git ls-files` and the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

Conventions: code pointers are `path/from/repo/root` -> `symbol`. Relevance to the runtime library:

- **core**: ships in `@genclass/runtime` or defines what it ships.
- **supporting**: builds, trains, tests or demonstrates the runtime.
- **legacy**: the earlier GenClass project (Python model, Chrome extension, benchmarks). `docs/runtime/CONTRACT.md` §1 says: "Existing GenClass content (jev_local/, extension/, docs/, etc.) stays as is. Do not edit it." Some legacy files are still reference implementations for the runtime; the notes say which.

Workstream names (lead, CORE, MODEL, UI, SIM, DEMOS, TRAIN, REVIEW) and their edit rights are defined in [status-and-known-issues.md](status-and-known-issues.md) ("Workstreams and ownership"). The index of all agent docs is [README.md](README.md); how the parts fit together is in [overview.md](overview.md). Ground rules and what you may run: [../../AGENTS.md](../../AGENTS.md); terms: [glossary.md](glossary.md); step-by-step procedures: [playbooks.md](playbooks.md).

## 1. Top-level directories

| dir | tracked files | what | owner / workstream | doc | relevance |
|---|---|---|---|---|---|
| `packages/runtime/` | 143 | `@genclass/runtime` 0.1.0-alpha.0, the npm library: `src/` (55), `test/` (79), `bin/genclass-runtime.mjs` CLI, package and build configs, STATUS/UI-NEEDS | CORE. MODEL owns `src/model/**` and `bin/`. UI owns `src/devtools/**` and `src/adapters/**`. REVIEW owns `test/review-*.test.ts`. | the 8 docs under `runtime/`; start with [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) | core |
| `packages/runtime-model/` | 1 | `MODEL_CARD.md` only. Planned npm package `@genclass/runtime-model` that `DEFAULT_MODEL_BASE_URL` points at. It has no `package.json` and its `files/` directory is gitignored, so it is not a workspace and is unpublished | lead | [runtime/model-host.md](runtime/model-host.md) | core (planned) |
| `sim/` | 59 | `@genclass/sim` (private): training-data simulator that drives the real runtime and writes CONTRACT-D rows | SIM | [sim.md](sim.md) | supporting |
| `training/` | 43 | Python curriculum generator, runtime-text port (`curriculum/rt.py`), eval, ONNX export, Azure launch scripts for the R17/R32 runtime model | TRAIN (CONTRACT §1 says lead) | [training.md](training.md), [model-io-contract.md](model-io-contract.md) | supporting |
| `demos/` | 132 | `@genclass/demos`: Vite site with six demo apps, a Service Worker chaos backend, Playwright trial eval and shipped results | DEMOS | [demos.md](demos.md) | supporting |
| `scripts/` | 26 | Ops scripts. `vm.sh` is the runtime team's VM build/test path; `azvm.sh`, `launch_run.sh` (training launches) and `genclass_export.py` (`ExportModel` for `training/export_runtime.py`) also support the runtime; the rest are legacy GenClass/benchmax/Azure ops | not recorded (`vm.sh` is listed in CONTRACT §1) | [extension-and-benchmarks.md](extension-and-benchmarks.md) ("Scripts"), [runtime/build-test-release.md](runtime/build-test-release.md) ("VM workflow") | `vm.sh`, `azvm.sh`, `launch_run.sh`, `genclass_export.py`: supporting. Rest: legacy |
| `jev_local/` | 136 | Python package `jev-local` 0.1.0: Jev-wire API, encoder engine, trainer, voice harness, benchmark harnesses | none of the runtime workstreams (pre-runtime GenClass) | [genclass-model-lineage.md](genclass-model-lineage.md) | legacy. `serialize.py`, `confidence.py`, `engine/encoder/{tokenize_pack,calibrate,heads}.py` are the parity references for `packages/runtime/src/model`; `train/` is used by `training/` |
| `extension/` | 104 | GenClass 0.1.0 MV3 voice-control Chrome extension. Its own npm package, not a workspace | none of the runtime workstreams | [extension-and-benchmarks.md](extension-and-benchmarks.md) | legacy. `src/core/{engine,packer,tokenizer,serialize,pyutil}.js` are the ancestors of the runtime's `src/model/*.ts` |
| `bench/` | 5 | jevbench and benchmax pre-registrations, `public/` target and exclusion JSON | none of the runtime workstreams | [extension-and-benchmarks.md](extension-and-benchmarks.md) | legacy |
| `tests/` | 74 | pytest suites for `jev_local` (71 `test_*.py`, `conftest.py`, 2 fixtures) | none of the runtime workstreams | [genclass-model-lineage.md](genclass-model-lineage.md) ("Tests") | legacy |
| `results/` | 3 | Benchmark write-ups (CU head-to-head, jevbench M0, Z-68m notes) | none of the runtime workstreams | [extension-and-benchmarks.md](extension-and-benchmarks.md) | legacy |
| `docs/` | 15 tracked | `docs/runtime/` (3: CONTRACT, API, ARCHITECTURE: the runtime's human docs), `docs/benchmax-research/` (5), 7 legacy jev-local docs. `docs/agents/` (these docs) is untracked at 654d822 | `docs/runtime/CONTRACT.md`: lead. Rest: not recorded / legacy | [status-and-known-issues.md](status-and-known-issues.md) (doc drift tables) | `docs/runtime/`: core. Rest: legacy |

Root files:

| file | what | relevance |
|---|---|---|
| `package.json` | private `genclass-lib`, `"type": "module"`, workspaces `packages/*`, `sim`, `demos`; scripts `build` and `test` (runtime only), `typecheck` (all workspaces); devDep `typescript ~5.9.3`; `engines.node >=20` | core |
| `tsconfig.base.json` | shared TypeScript compiler options | core |
| `.gitignore` | ignore rules (see [section 4](#4-generated-and-ignored-paths)) | core |
| `README.md` | repo landing page: status banner, install, repo map | core |
| `OPEN_TASKS.md` | project-level status: done, in progress, next, needs the user, known risks (owner inferred: lead) | core |
| `LICENSE` | Apache-2.0 | core |
| `pyproject.toml` | Python package `jev-local` 0.1.0 (Python >=3.12,<3.14), console script `jev-local`, pytest config | legacy |
| `BENCHMARKS.md` | public summary of GenClass 0.1 benchmark results | legacy |
| [`AGENTS.md`](../../AGENTS.md), [`CLAUDE.md`](../../CLAUDE.md) | agent entry points (untracked at 654d822, written with these docs) | — |

## 2. Tree

One line per file for the code that matters most; one line per directory (with tracked-file counts) for legacy areas. Descriptions are summaries; the linked docs have the detail.

### `packages/runtime/` package root (9 files)

Doc: [runtime/build-test-release.md](runtime/build-test-release.md), [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md).

```text
packages/runtime/
  package.json              @genclass/runtime 0.1.0-alpha.0; exports . ./react ./redux ./zustand ./devtools ./worker; bin genclass-runtime;
                            dep onnxruntime-web ^1.30.0; optional peers react/redux/zustand; scripts build typecheck test test:browser
  tsconfig.json             typecheck project (include src only: tests are never type-checked)
  tsup.config.ts            6 ESM entries (index, adapters/react|redux|zustand, devtools/index, worker) -> dist/; .d.ts for all but worker
  vitest.config.ts          unit tests: test/**/*.test.ts, excludes test/browser/**, env node, testTimeout 20000
  README.md                 npm package README
  STATUS.md                 CORE status: test state, headless recipe, trigger table, example situations, deviations, open issues
  UI-NEEDS.md               UI -> CORE request log (partly stale)
  LICENSE                   Apache-2.0
  bin/genclass-runtime.mjs  CLI (Node >= 20, no deps): fetch-model <dir> [--from] [--variant q8|fp16|all] [--force] [--quiet], info <dir>
```

### `packages/runtime/src/` (55 files)

```text
packages/runtime/src/
  index.ts                  public facade: GenClass (init/runtime/destroy), createRuntime, re-exports; killSwitch, makeHost, NATIVE_FETCH, ALL_OFF
  runtime.ts                RuntimeImpl: wires every layer; installObservers, trigger (triage), onDecision, settled points,
                            rollback/revertChain/resync, explain, undo, destroy
  types.ts                  every public and shared type: options, Runtime, RuntimeEvents, plugins, and the "model seam"
                            (JevState, Question, Answer, EvaluateRequest, DecisionProvider) mirrored by sim/src/types.ts
  errors.ts                 GenClassUnavailableError
  clock.ts                  browserClock (timers captured at module load, afterTask)
  util.ts                   hashing (fnv1a, stableStringify, hashValue), URL signatures (normalizePath, isIdSegment,
                            requestSignature), formatting (secs, rel, fmtNum, truncate), redaction (defaultRedact)
  adapters/react.ts         @genclass/runtime/react: GenClassProvider, useGenClass, useGenClassState, useAtom, useGenClassDecisions/Interventions/Status
  adapters/redux.ts         @genclass/runtime/redux: genclassEnhancer, GENCLASS_REPLACE
  adapters/zustand.ts       @genclass/runtime/zustand: genclass middleware
  decide/decider.ts         DeciderQueue: one request at a time, priority, 32-item cap, answer cache, PROVIDER_TIMEOUT_MS, fail-open
  decide/exec.ts            types only: Controller, ActionEffect, NetHost, TriggerOpts, EndOpts
  decide/policy.ts          policyConfig (thresholds), modeAllows, permittedActions, gate (summed-mass rule), RateLimiter, holdBudget
  decide/report.ts          Reporter (console sink, 60 s dedupe), interventionLine, detectionLine, decisionLine
  devtools/index.ts         @genclass/runtime/devtools: mountDevtools, Devtools class (shadow-root overlay, 4 views)
  devtools/ui.ts            DOM helper h(), icons, formatting, report-wording templates, activity-event classification
  devtools/css.ts           CSS string with light/dark tokens, applied inside the shadow root
  learn/baselines.ts        Baselines: per-signature latency, outcomes, failure streak, error EWMA, rate, identity gaps (fetch/XHR)
  learn/profiles.ts         Profiles: transition profiles and rarity check (MIN_COMPLETIONS 20, RARE 0.01)
  model/README.md           MODEL's internal notes: card format, load steps, parity results, measured latency and sizes
  model/host.ts             createModelHost, ModelHost, DEFAULT_MODEL_BASE_URL; worker or inline transport, preload, queue, timeouts, WASM retry
  model/backend.ts          ModelBackend: load phases (card, download, runtime, session, warmup) and evaluate; WARMUP_STATE
  model/worker.ts           module Worker entry (tsup entry worker -> dist/worker.js)
  model/protocol.ts         ToWorker / FromWorker / EvaluateOk message types
  model/loader.ts           parseCard, planOrder, probeWebGPU, fetchFile (Cache Storage + sha256), CARD_FORMAT, DEFAULT_CACHE_NAME
  model/engine.ts           Engine: packer + ORT session + calibration -> answers; FEEDS; graph-contract check
  model/packer.ts           Packer, planInputs, unpackLogits, MARKERS (port of jev_local tokenize_pack.Packer)
  model/tokenizer.ts        Tokenizer: byte-level BPE over a HF tokenizer.json
  model/serialize.ts        stateSegments, questionBlock, pyJson (port of jev_local/serialize.py)
  model/pyutil.ts           Python value semantics: pyNumber, pyFloatRepr, pyRound, pyStrip, clip01
  model/calibrate.ts        parseCalibration, calibrateLogits, buildAnswer, headerKey, K_BUCKETS (port of calibrate.py + confidence.py)
  model/errors.ts           GenClassModelError + 11 subclasses (ModelNotReadyError, MaxTokensExceededError, ...), serializeError
  model/hash.ts             pure-TS sha1/sha256; sha256Hex prefers WebCrypto
  model/index.ts            internal barrel; nothing in src/ imports it; only test/browser/build.mjs's fallback build uses it
  observe/fetch.ts          installFetch: fetch ops, request identity, request gate, failure gate, stall controller
  observe/xhr.ts            installXHR: XMLHttpRequest.prototype patch; request gate (XHR failures/stalls are detection-only)
  observe/cache.ts          ResponseCache (GET cache, coalescing table), makeResponse/blockedResponse (x-genclass header)
  observe/dom-user.ts       installDomUser (capture-phase user actions), describeElement, ignoredEvent (data-genclass-ignore)
  observe/timers.ts         installTimers: setTimeout/setInterval wrappers that carry the ambient op
  observe/websocket.ts      installWebSocket: WebSocket subclass
  observe/nav.ts            installNav: history pushState/replaceState, popstate, hashchange
  observe/storage.ts        installStorage: Storage.prototype setItem/removeItem/clear
  observe/errors.ts         installErrors: error and unhandledrejection listeners
  observe/perf.ts           installPerf: longtask PerformanceObserver
  situation/build.ts        buildSituation: subject sentence, sections, applicable actions (builtinApplicable), questions, salience
  situation/facts.ts        computeFacts per trigger, orderFacts, MAX_FACTS (12)
  situation/describe.ts     opPhrase, opLabel, userPhrase, statusText, eventLine
  situation/questions.ts    BUILTIN_ACTIONS, TRIGGER_ACTIONS, PASSIVE, DEFAULT_DIAGNOSES, buildQuestions, COMPACT_QUESTIONS_BUDGET
  situation/serialize.ts    toJevState, sectionLimits, stateChars, STATE_CHAR_BUDGET / COMPACT_BUDGET / MIN_BUDGET
  situation/env.ts          SitEnv (read-only runtime view for situation code), SubjectSpec, ReqMeta, FailureInfo, Violation
  state/hub.ts              StoreHub: atom/guard/adapter stores, mutation pipeline, field versions and logs, late revert, snapshots
  state/fields.ts           flatten, diffLeaves, deltaOf, changeText, patchValue, cloneValue; MAX_DEPTH, MAX_FIELDS_PER_STORE
  state/invariants.ts       InvariantMiner (9 templates; LEARN_AFTER, LEARN_AFTER_NONNULL), expect() predicates
  trace/ops.ts              OpRegistry, OpRec
  trace/context.ts          Context (ambient op: run, stick, isUserSync), LazyOp
  trace/events.ts           EventLog ring buffer
```

Docs by folder: `index.ts`, `runtime.ts`, `types.ts`, `errors.ts`, `clock.ts`, `util.ts` -> [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md); `observe/`, `trace/` -> [runtime/observe-and-trace.md](runtime/observe-and-trace.md); `state/`, `adapters/` -> [runtime/state-and-adapters.md](runtime/state-and-adapters.md); `learn/`, `situation/` -> [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md); `decide/` -> [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md); `model/` -> [runtime/model-host.md](runtime/model-host.md); `devtools/` -> [runtime/devtools.md](runtime/devtools.md). Everything the model reads is frozen at tag `situation-v1`: [model-io-contract.md](model-io-contract.md).

### `packages/runtime/test/` (79 files)

Doc: [runtime/build-test-release.md](runtime/build-test-release.md) ("Tests" has one row per file with test counts).

```text
packages/runtime/test/
  helpers.ts                        core test kit: setup, FakeClock, FakeServer, ScriptedDecider, defaultScript, ManualDecider, makeGlobal, drain
  adapter-seam.test.ts              rt.adapter(...).propose: reducer preview, held async dispatch, discard, rollback only with io.set
  adapters-react.test.ts            React hooks, with MockRuntime and the real runtime (happy-dom)
  adapters-redux.test.ts            genclassEnhancer: hold/apply once, GENCLASS_REPLACE, replaceReducer
  adapters-zustand.test.ts          genclass middleware: merge semantics, hold/drop, whole-state writes
  ask.test.ts                       ask()/decide() typed answers, GenClassUnavailableError without a model
  atoms.test.ts                     mutation pipeline: user-sync never held, hold/apply, fail-open, late revert, defer
  batch3.test.ts                    SIM requests a-f, ctx.builtin through the gate, GenClass.init never throws
  budget.test.ts                    situation budgets, compact questions, auto budget, hold budget; prints example situations
  context.test.ts                   causal context: cause/root through fetch, timers, rt.op
  devtools-runtime.test.ts          overlay on the real runtime via runStoreSession (happy-dom)
  devtools.test.ts                  overlay vs MockRuntime + loadScenario (happy-dom)
  dom.test.ts                       describeElement, DOM user observer, destroy restores globals (happy-dom)
  fetch.test.ts                     fetch observer: coalesce, block, serve_cached, delay, retry, hedge, cache limits
  invariants.test.ts                InvariantMiner learning, inconsistency once per episode, rollback
  learn.test.ts                     Baselines and Profiles; transition trigger
  plugins.test.ts                   plugin facts/diagnoses/actions, ctx.builtin, standing questions, vocabulary
  policy.test.ts                    gate(): summed mass, tiers, thresholds, deny/allow, rate limit, pause
  report.test.ts                    report line format, explain(id), ?genclass=off|heal
  review-actions.test.ts            REVIEW regression (must pass unmodified): error-trigger rollback scope
  review-dom.test.ts                REVIEW: passwords never recorded, programmatic click is not a user action
  review-fetch.test.ts              REVIEW: request identity, coalescing edge cases, buffer limits, keepalive
  review-hub.test.ts                REVIEW: held patches, late-revert undo, deep changes
  review-misc.test.ts               REVIEW: console summaries, read-only fetch, denied heal action, ask after destroy
  review-perf.test.ts               REVIEW: wall-clock cost budgets on 5,000-item stores
  review-precision.test.ts          REVIEW: transition/inconsistency false positives
  review-redaction.test.ts          REVIEW: custom redact applies to invariant facts
  review-timers.test.ts             REVIEW: recursive timer loops; gc check needs NODE_OPTIONS=--expose-gc
  review-xhr.test.ts                REVIEW: sync XHR never held, abort while held
  situation.test.ts                 one situation per trigger: key order and section limits; prints situations
  smoke.test.ts                     atoms, context through real awaits, stale write discarded in guard mode
  xhr.test.ts                       XHR op + cause, block, detection-only failures, destroy restores open/send
  model/helpers.ts                  model test kit: MODEL_DIR (GENCLASS_MODEL_DIR), FIXTURES_FROM_MODEL, fixture loaders
  model/calibrate.test.ts           hashes and calibration vs Python/PyTorch (1 of 8 skips without model files)
  model/engine.test.ts              ORT-node and ORT-web parity vs PyTorch (3 of 4 skip without model files)
  model/host.test.ts                createModelHost with a fake worker: preload, queue, timeouts, WebGPU -> WASM recovery
  model/loader.test.ts              parseCard, planOrder, fetchFile, ModelBackend.load phases
  model/packer.test.ts              packer and tokenizer parity (all 10 skip without tokenizer.json in MODEL_DIR)
  model/serialize.test.ts           stateSegments/questionBlock vs Python, Python number formatting
  fixtures/model/make_py_fixtures.py     generator of py_fixtures.json (Python reference outputs)
  fixtures/model/make_webgpu_variants.py generator of test-only WebGPU embedding variants (GENCLASS_WEBGPU_VARIANTS)
  fixtures/model/py_fixtures.json        serialize/tokenize/calibrate/confidence reference cases (single line)
  fixtures/model/requests50.json         50 v0.1 requests {id, state, questions} (single line)
  fixtures/model/pack_fixtures.json      Python packer output for requests50 (single line)
  fixtures/model/torch_fixtures.json     PyTorch logits of the v0.1 model for requests50 (single line)
  browser/.gitignore                ignores .build/
  browser/playwright.config.ts      model specs: projects chromium and swiftshader-webgpu; globalSetup build.mjs
  browser/build.mjs                 global setup: buildLibrary (runs tsup, rewrites dist/), esbuild page bundle into .build/app/
  browser/server.mjs                static server for the specs (startServer)
  browser/model-helpers.ts          spec helpers: MODEL_DIR, HAVE_MODEL, parityRun, benchmarks
  browser/model.spec.ts             model host in headless Chromium on WASM (skips without model.json)
  browser/model-webgpu.spec.ts      model host on SwiftShader WebGPU
  browser/ui-devtools.spec.ts       devtools overlay in Chromium; rewrites ui/screenshots/*.png
  browser/page/index.html           test page
  browser/page/main.ts              test app driving the built library (window.GC)
  browser/ui/playwright.config.ts   UI spec config (testMatch ui-*.spec.ts)
  browser/ui/mock-runtime.ts        MockRuntime: scripted Runtime (also used by adapters-*.test.ts)
  browser/ui/scenario.ts            loadScenario: scripted store story for MockRuntime
  browser/ui/session.ts             runStoreSession: real createRuntime under a VirtualClock with a rule-based SessionDecider
  browser/ui/page.ts                fake "Acme" store page for the UI spec (window.__gc)
  browser/ui/screenshots/activity-dark.png
  browser/ui/screenshots/activity-light.png
  browser/ui/screenshots/detections-dark.png
  browser/ui/screenshots/detections-light.png
  browser/ui/screenshots/evidence-answers-dark.png
  browser/ui/screenshots/evidence-answers-light.png
  browser/ui/screenshots/evidence-dark.png
  browser/ui/screenshots/evidence-light.png
  browser/ui/screenshots/interventions-dark.png
  browser/ui/screenshots/interventions-light.png
  browser/ui/screenshots/loading-dark.png
  browser/ui/screenshots/loading-light.png
  browser/ui/screenshots/now-dark.png
  browser/ui/screenshots/now-light.png
  browser/ui/screenshots/overlay-dark.png
  browser/ui/screenshots/overlay-light.png
  browser/ui/screenshots/pill-dark.png
  browser/ui/screenshots/pill-light.png
  smoke/smoke.sh                    npm pack -> fresh Vite 8 app -> headless Chromium check (run from packages/runtime; ask first)
```

The 18 PNGs are written by `ui-devtools.spec.ts`; no README embeds them.

### `packages/runtime-model/` (1 file)

```text
packages/runtime-model/
  MODEL_CARD.md             model card for R17/R32 (sizes, stage-1c accuracy, limits); the package itself does not exist yet
```

### `sim/` (59 files)

Doc: [sim.md](sim.md). Row format: [model-io-contract.md](model-io-contract.md).

```text
sim/
  package.json              @genclass/sim (private); bin genclass-sim -> dist/gen.js; scripts build typecheck test gen sample build:runtime-core
  tsconfig.json             extends ../tsconfig.base.json, noEmit, src + test
  tsup.config.ts            ESM, node22, @genclass/runtime external; entries gen, worker, index, smoke -> dist/
  vitest.config.ts          node env, pool forks, 120 s timeouts
  README.md                 SIM README: commands, final datasets, known limitations
  NEEDS.md                  SIM -> CORE requests (relayed by the lead)
  scripts/final.sh          final datasets on the train VM: final.sh a | b | merge-b (ask first)
  scripts/analyze.py        dataset summary: python3 sim/scripts/analyze.py <dir>
  samples/sample.jsonl      200 rows written by gen --sample
  samples/EXAMPLES.md       pretty-printed example rows (renderExamples)
  samples/sample-stats.json stats of the sample run
  samples/stats-final-a.json stats of SIM final phase A (600,676 rows)
  src/index.ts              library re-exports (buildScenario, runScenario, generateTrajectory, runCost, ...)
  src/types.ts              structural mirror of the runtime model seam + Row/Label (CONTRACT-D)
  src/rng.ts                Rng (sfc32, keyed forks), hash32, hashAll
  src/loop.ts               VirtualLoop: deterministic virtual event loop and clocks
  src/gen.ts                CLI: worker pool, shard merge, stats.json, --sample, --parts, --allow-fake
  src/gen/trajectory.ts     generateTrajectory, pointCosts: ideal + base + counterfactual runs -> rows
  src/gen/worker.ts         worker_threads worker: seeds -> rows -> shard/part files
  src/gen/examples.ts       renderExamples (EXAMPLES.md)
  src/net/network.ts        Network (latency, chaos, push, fetch), IDEAL_PROFILE, SIM_OP_HEADER
  src/net/server.ts         VirtualServer, Db, API_STYLES
  src/app/env.ts            AppEnv: what generated app programs see (fetch, stores, sockets, timers)
  src/app/feature.ts        FeatureDef contract, UserModel, personas, relations
  src/app/kit.ts            Kit: tagged ops, requests, writes, error surfacing
  src/app/naming.ts         Naming: per-program route/store/field names
  src/app/vocab.ts          DOMAINS: 55 domain vocabularies
  src/app/features/index.ts FEATURES, FEATURE_WEIGHTS
  src/app/features/common.ts shared feature helpers
  src/app/features/auth.ts      feature combinator (one FeatureDef each, 15 in total)
  src/app/features/benign.ts
  src/app/features/board.ts
  src/app/features/bulk.ts
  src/app/features/cart.ts
  src/app/features/chat.ts
  src/app/features/counter.ts
  src/app/features/editor.ts
  src/app/features/form.ts
  src/app/features/list.ts
  src/app/features/nav.ts
  src/app/features/poll.ts
  src/app/features/search.ts
  src/app/features/settings.ts
  src/app/features/toggle.ts
  src/world/scenario.ts     buildScenario(seed), splitOf, TEST_DOMAINS, TEST_PATTERNS, chaos profiles
  src/run/rt.ts             realRuntimeFactory (dynamic import of the real runtime), createOptions
  src/run/runner.ts         runScenario: one run (ideal or real), recording decider, correlation, snapshots
  src/run/fake-runtime.ts   createFakeRuntime: test double only (rows marked meta.runtime "fake")
  src/run/transform.ts      transformQuestions (shuffle/drop action options), ACTION_PARA
  src/oracle/knowledge.ts   Knowledge: ground-truth bookkeeping (intents, sim ops, sim writes)
  src/oracle/diagnose.ts    diagnose, diagnoseFailure: diagnosis labels
  src/oracle/cost.ts        W (cost weights), LABEL, TIER, runCost, actionLabel
  src/ask/questions.ts      askQuestions: 11 programmatic ask generators with exact labels
  src/dev/smoke.ts          dev tool: base runs on many seeds, prints raw situations
  test/helpers.ts           testFactory (SIM_RUNTIME=real -> real runtime, else fake), mini scenario builder
  test/loop.test.ts         VirtualLoop ordering, Response bodies, rng forks
  test/determinism.test.ts  same seed -> identical rows; replay reproduces every prefix
  test/rows.test.ts         valid CONTRACT-D rows; splits and transform
  test/oracle.test.ts       diagnosis and cost/label cases (2 are real-runtime only)
```

### `training/` (43 files)

Doc: [training.md](training.md). Every script here runs on Azure VMs; ask before running any of them.

```text
training/
  README.md                 overview and reproduce commands (partly stale)
  LOG.md                    dated run log (what ran where, throughput, costs, decisions)
  EVAL.md                   metric definitions and results (baseline, stage 1c, sizes/latency, stage-2 pilot)
  NEEDS.md                  TRAIN requests to SIM / CORE / MODEL, MODEL -> TRAIN notes
  prune_vocab.py            prune/analyze: keep the first N BPE merges (16,000 -> 16,364 tokens) of a checkpoint or HF base
  eval_runtime.py           accuracy, NLL/Brier/ECE, temperature fit (calibration.json), CONTRACT §8 gate metrics, SIM cost regret
  export_runtime.py         checkpoint -> q8/fp16 ONNX + model.json/meta.json/calibration.json/tokenizer.json + parity fixtures
  report.py                 Markdown tables for EVAL.md from eval reports
  configs/mix_s1.json       mixture configs read by jev_local/train/stream.py MixConfig
  configs/mix_s1b.json
  configs/mix_s1c.json
  configs/mix_s2.json
  configs/mix_final1.json
  curriculum/__init__.py    package docstring
  curriculum/generate.py    seeded parallel curriculum generator (CONTRACT-D jsonl + stats.json); --p-runtime -> GC_P_RUNTIME
  curriculum/rt.py          Python port of packages/runtime/src/situation/* (runtime-exact rows); must match the frozen text
  curriculum/world.py       explicit world model: ops, writes with versions, baselines; varied-style rendering
  curriculum/app.py         App: per-row app instance (names, ids, routes, values)
  curriculum/vocab.py       62 app domains (13 held out: TEST_DOMAINS), UI/error vocab
  curriculum/fmt.py         surface variation: Style, TEMPLATES (held-out tails), action/diagnosis vocab
  curriculum/scenarios.py   Scen dataclass; mutation scenarios; noise ops
  curriculum/scen_ops.py    request / failure / stall scenarios
  curriculum/scen_state.py  inconsistency / transition / error scenarios
  curriculum/prims.py       primitive questions with exact labels over a Trace
  curriculum/rows.py        decision_row, ask_row: assemble rows
  curriculum/standalone.py  non-situation primitive families (JSON invariants, HTTP semantics, JS errors)
  ortweb/package.json       onnxruntime-node + onnxruntime-web 1.30.0 for validate.mjs (not a workspace)
  ortweb/validate.mjs       node validate.mjs <dir> [variant] [maxRequests]: WASM parity and latency of an export
  samples/runtime_samples.txt 75 hand-written runtime-like lines for prune_vocab.py analyze
  tests/test_curriculum.py  pytest (VM): curriculum validity, held-out splits, label consistency
  tests/test_prune_vocab.py pytest (VM; GC_V1_CKPT, GC_BASE_32M): pruned tokenizer and logits parity
  tests/test_export_runtime.py pytest (VM; GC_R17_INIT): int8 embeddings, Gemm->MatMul, end-to-end export
  node.sh                   ssh/rsync wrapper for Azure hosts: node.sh HOST sync|'cmd'|get R L|put L R
  import_sim.sh             pull a SIM run to c01 and shard it (stage 2)
  import_final.sh           pull a frozen SIM run, shard, build eval subsets, bundle for nodes
  launch_s2.sh              launch stage-2 pilot runs (R32, R17)
  launch_final1.sh          launch final round 1: launch_final1.sh R32_PASSES R17_PASSES
  final_post.sh             on a rank-0 node: SIM eval -> export -> serve tar on :8801
  eval_sim.sh               sharded logit collection + one SIM eval per model
  run_evals.sh              stage-1 eval batch on c01
  pull_ckpt.sh              copy a servable checkpoint from a node to c01
  pull_on_train.sh          on the train VM: fetch an export tar, sha256 check, run validate.mjs
  deliver_final.sh          from the Mac: same delivery, driven remotely
```

### `demos/` (132 files)

Doc: [demos.md](demos.md). Non-`src` files:

```text
demos/
  package.json              @genclass/demos (private); scripts dev build preview typecheck typecheck:shim fetch-model eval eval:fast shots
  vite.config.ts            multi-page build, runtime-shim aliasing (GENCLASS_SHIM), dev Service Worker middleware
  tsconfig.json             app code
  tsconfig.sw.json          Service Worker code (lib WebWorker)
  tsconfig.node.json        e2e/*.ts and vite.config.ts
  tsconfig.shim.json        app code type-checked against the runtime shim
  .gitignore                node_modules/ dist/ public/genclass-model/ test-results/ playwright-report/ e2e/.out/
  index.html                landing page
  board/index.html          one page per demo
  checkout/index.html
  decisions/index.html
  editor/index.html
  search/index.html
  status/index.html
  public/favicon.svg        site icon
  scripts/build.mjs         site build + dist/sw.js IIFE + results-summary.json copy
  scripts/fetch-model.sh    download a model directory (runtime CLI fetch-model, curl fallback)
  scripts/vm-eval.sh        full VM pipeline: install, build runtime, model, build demos, eval (ask first)
  e2e/eval.ts               headless Playwright trials -> results.json, results.md, screenshots (ask first)
  e2e/serve.ts              static server for dist/ under a sub-path
  e2e/trace-report.ts       analyses --trace runs (e2e/.out/traces*.json) into Markdown
  README.md                 human README: run, URL params, oracles, honesty rules
  NEEDS.md                  DEMOS -> CORE/MODEL/UI/lead issues with evidence
  results.md                latest results (v0.1 model, generated before batch 3)
  results.json              raw trials (large)
  results-summary.json      summary shipped with the site
  screenshots/              30 PNGs (see below)
```

`demos/src/` (76 files):

```text
demos/src/
  shared/genclass.ts        startGenClass: the only place the demos create the runtime; collectStats, statusText
  shared/settings.ts        URL params and localStorage: getMode, modelBaseUrl, trialParams, traceOn, holdBudget
  shared/chaos.ts           chaos model: RouteChaos, PRESETS, resolveChaos, sampleTiming
  shared/scenario-kit.ts    typing rhythm (typeSteps), sampleChaos, CLEAN_CHAOS
  shared/types.ts           GcMode, Step, Scenario, Score, TrialResult
  shared/demo-def.ts        DemoDefinition, AppContext, OracleContext, Oracle
  shared/driver.ts          runSteps: synthetic in-page user
  shared/harness.ts         TrialHarness (window.__trial)
  shared/aggregate.ts       wilson, quantile, summarizeMode, summarizeDemo
  shared/trace.ts           ?trace=1 investigation tracing via hooks.mutationProposed
  shared/server.ts          ensureServiceWorker, ServerLink (page side of the mock server)
  shared/protocol.ts        page <-> Service Worker control protocol types
  shared/native.ts          timers captured before GenClass.init wraps globals (nativeSetTimeout, sleep)
  shared/rng.ts             seeded PRNG (sfc32), hashString
  shared/demos.ts           DEMOS copy for landing/topbar/explain cards
  shared/api.ts             api(path): <siteRoot>api/
  server/sw.ts              Service Worker: sessions, control messages, /api/* routing, COOP/COEP headers
  server/core.ts            World: router, chaos/latency pipeline, SSE streams, request log, quiescence
  server/worlds/search.ts   searchWorld (imports data/cities.ts, which is missing from git)
  server/worlds/editor.ts   editorWorld
  server/worlds/checkout.ts checkoutWorld, PRODUCTS
  server/worlds/status.ts   statusWorld, SERVICES, truthAt
  server/worlds/board.ts    boardWorld, COLUMNS, BOARD_SEED, TEAMMATES, teammateMove
  server/worlds/decisions.ts decisionsWorld, BACKUP_MS
  demos/search/main.ts      bootDemo for the search typeahead
  demos/search/app.ts       mountSearch (atom "search"); latent bug: no request-ordering guard
  demos/search/app.css
  demos/search/scenario.ts  searchScenario(seed, kind)
  demos/search/oracle.ts    searchOracle (test code only)
  demos/editor/main.ts      bootDemo for notes autosave
  demos/editor/app.ts       mountEditor; latent bugs: overlapping saves, "Saved" lies
  demos/editor/app.css
  demos/editor/store.ts     createNotesStore: Redux + genclassEnhancer
  demos/editor/scenario.ts  editorScenario
  demos/editor/oracle.ts    editorOracle
  demos/checkout/main.ts    bootDemo for cart/checkout
  demos/checkout/app.tsx    mountCheckout (React, useGenClassState); latent bugs: double submit, retries without idempotency key
  demos/checkout/app.css
  demos/checkout/scenario.ts checkoutScenario
  demos/checkout/oracle.ts  checkoutOracle
  demos/status/main.ts      bootDemo for the status dashboard
  demos/status/app.ts       mountStatus (gc.guard "services"); latent bugs: overlapping polls, retry storm
  demos/status/app.css
  demos/status/scenario.ts  statusScenario
  demos/status/oracle.ts    statusOracle
  demos/board/main.ts       bootDemo for the kanban board
  demos/board/app.tsx       mountBoard (React + SSE); latent bugs: no version check, whole-board rollback
  demos/board/app.css
  demos/board/store.ts      createBoardStore: Zustand + genclass middleware
  demos/board/scenario.ts   boardScenario
  demos/board/oracle.ts     boardOracle
  demos/decisions/main.ts   bootDemo for the field journal
  demos/decisions/app.ts    mountDecisions: gc.ask / gc.decide with app defaults; atoms "journal", "gallery"
  demos/decisions/app.css
  demos/decisions/plugin.ts backgroundWorkPlugin: custom facts and the pause_background action
  demos/decisions/jobs.ts   BackgroundJobs, jobs (background photo backup controller)
  demos/decisions/scenario.ts decisionsScenario
  demos/decisions/oracle.ts decisionsOracle
  site/demo-page.ts         bootDemo: interactive demo page or bare trial page; mounts devtools
  site/landing.ts           landing page
  site/activity.ts          mountActivity: "GenClass activity" panel (reports, evidence, Undo)
  site/chaos-panel.ts       mountChaosPanel: presets, sliders, toggles
  site/trials-panel.ts      mountTrials: in-page trial runner (iframes)
  site/netlane.ts           mountNetLane: live waterfall of the server log
  site/chrome.ts            renderTopbar, applyTheme
  site/dom.ts               h(), append, esc, toast, formatting helpers
  site/icons.ts             icon(), BRAND_MARK
  site/art.ts               ART: per-demo card art
  site/highlight.ts         highlight(): tiny TS/JS syntax highlighter
  styles/system.css         design tokens (light/dark, --mode-off/guard/heal)
  styles/site.css           site chrome
  dev/runtime-shim/index.ts observe-only stand-in for @genclass/runtime (used when dist is missing or GENCLASS_SHIM=1)
  dev/runtime-shim/react.ts
  dev/runtime-shim/redux.ts
  dev/runtime-shim/zustand.ts
  dev/runtime-shim/devtools.ts no-op mountDevtools; duplicates DevtoolsOptions (update when the options change)
```

`demos/src/server/data/cities.ts` is imported but not in git (the root `.gitignore` rule `data/` matches it), so a fresh clone cannot build the Service Worker or the search demo. See [demos.md](demos.md) ("Drift and open issues").

### `scripts/` (26 files)

Doc: [extension-and-benchmarks.md](extension-and-benchmarks.md) ("Scripts", with Azure and cost flags per script). None of these should be run without the user's go-ahead.

```text
scripts/
  vm.sh                     runtime build/test path: vm.sh sync|run|exec|get SLOT ...; rsync to ~/gcl/SLOT on VM "train" (Azure)
  azvm.sh                   ssh/scp/rsync helper for named Azure VMs from ~/.jev-local/azure_hosts (used by training/*.sh)
  launch_run.sh             detached multi-node torch.distributed.run of jev_local.train.train (used by training/launch_*.sh; costs money)
  cluster_up.sh             az vm create training nodes (costs money)
  vm_bootstrap.sh           one-time Ubuntu VM setup
  node_setup.sh             fresh-node bootstrap + data bundle pull
  launch_z68m.sh            benchmax Z-68m retrain launch (costs money)
  stage1_speedtest.sh       DDP timing runs (costs money)
  watch_runs.sh             poll rank-0 training logs
  phase3_eval.sh            benchmax phase-3 eval driver (costs money)
  genclass_export.py        PyTorch -> ONNX exporter; ExportModel is imported by training/export_runtime.py (from ~/jev/scripts on the VM)
  benchmax.py               benchmax CLI: list, verify --spec, run --spec
  benchmax/stage0_validation.sh   adapters on non-evaluated splits (VM)
  benchmax/dry_pass_validation.sh dry pass of all 19 specs (VM)
  benchmax/engine_determinism.py  W11 determinism report
  benchmax_build_targets.py regenerate bench/public/targets.json + exclusions.json
  jevbench.py               jevbench CLI: build, run-ours, run-jev (OpenRouter, costs money), score, report
  compare_jev.py            CU head-to-head behind results/genclass-vs-jev-computer-use.md (OpenRouter, costs money)
  openrouter_key.sh         set/check the OpenRouter key (handles a secret; never run unprompted)
  dev_to_calib.py           jevbench clean-dev requests -> calibration-fitter rows
  bench_encoder.py          FastEngine inference/training benchmarks (Mac)
  bench_decoder.py          MLX decoder benchmarks (Mac only)
  bench_laya.py             zero-shot Laya on the harness cases (Mac)
  overnight.py              memory-gated overnight job runner for the 8 GB Mac
  demo.py                   macOS voice computer-use demo entry
  demo_proof.sh             offline mid-sentence proof (Mac only)
```

### Legacy directories (one line per directory)

Doc for `jev_local/`, `tests/` and `docs/` legacy files: [genclass-model-lineage.md](genclass-model-lineage.md). Doc for `extension/`, `bench/`, `results/`, `docs/benchmax-research/`: [extension-and-benchmarks.md](extension-and-benchmarks.md).

```text
jev_local/                              136  Python package jev-local 0.1.0
  (top level)                             8  __init__, schema (Jev wire models), serialize (parity reference), confidence (answer math,
                                             parity reference), validate, api (ServeConfig, routing), cli, demo
  engine/                                11  base.py (Engine protocol), registry.py, heuristic.py, plus:
    engine/encoder/                       6  tokenize_pack (Packer), model (MaskedEncoder), heads (DecisionHeads), calibrate, engine (FastEngine)
    engine/decoder/                       2  MLX Qwen3 zero-shot scorer (macOS)
  harness/                               21  macOS voice computer-use harness (reference for extension/src/core)
  server/                                 2  FastAPI Jev-wire server (create_app)
  train/                                  7  trainer used by training/: train.py, stream.py (MixConfig), losses.py, ddp.py, eval.py, fixture.py
  bench/                                 87  jevbench v1 (registry, templates, build, metrics, ours, baselines) and:
    bench/benchmax/                      80  runner, specs_a/specs_b (19 specs), bridge_b, adapters_a/ (5), adapters_b/ (70, incl. vendor/ 51)
  (missing) jev_local/data/               -  v1/v2 data generators; ignored by the root data/ rule, so 20 tests/test_data_*.py fail at collection
extension/                              104  GenClass 0.1.0 MV3 Chrome extension (own package.json and package-lock.json)
  (top level)                             8  README, MODEL_CARD, RELEASE, NOTICE, LICENSE, package.json, package-lock.json, .gitignore
  src/                                   28  background/ (1: sw.js), content/ (1), core/ (17: harness port + engine/packer/tokenizer/serialize/pyutil),
                                             model/ (4: model.json, tokenizer.json, calibration.json, meta.json), offscreen/ (3), sidepanel/ (2)
  static/                                11  manifest.json, panel/offscreen/welcome pages, audio worklet, icons/ (5)
  store/                                 13  Chrome Web Store listing, permissions, privacy, icon, screenshots/ (9)
  test/                                  35  unit/ (6), e2e/ (12), eval/ (7), fixtures/ (10: parity JSON, audio)
  scripts/                                4  build.mjs, make_icons.mjs, compose_screens.mjs, make_py_fixtures.py
  release-assets/                         4  tokenizer.json, calibration.json, meta.json, parity.json (*.onnx ignored and absent)
  tools/                                  1  genclass_export.py (q8 export of the v0.1 model)
bench/                                    5  PREREG-jevbench.md, PREREG-benchmax.md, public/ (3: targets.json, jev_published.json, exclusions.json)
tests/                                   74  pytest for jev_local: conftest.py, fixtures/ (2), 71 test_*.py (20 test_data_*.py cannot import)
docs/                                    15  tracked files:
  docs/runtime/                           3  CONTRACT.md (binding runtime contract, lead), API.md, ARCHITECTURE.md
  docs/benchmax-research/                 5  benchmax planning notes (read-only background)
  (top level)                             7  legacy jev-local docs: SPEC, CONTRACT (defines the CONTRACT-D row format), CONTRACT-v2, DEMO,
                                             GENCLASS, COMPARISON, PLAN-excel
  docs/agents/                            -  these agent docs (untracked at 654d822)
results/                                  3  genclass-vs-jev-computer-use.md, jevbench-m0.md, z68m-dev-notes.md
demos/screenshots/                       30  <demo>.png, <demo>-dark.png, <demo>-full.png and <demo>-page.png for board, checkout,
                                             decisions, editor, status, search; index{,-dark,-full,-mobile}.png; search-mobile.png,
                                             search-trials.png. Written by demos/e2e/eval.ts (npm run shots)
```

## 3. Where is X?

Verified with `grep` at 654d822. Methods are `RuntimeImpl.<name>` in `packages/runtime/src/runtime.ts` unless stated.

### Runtime public API, options and lifecycle

| X | kind | where | doc |
|---|---|---|---|
| `GenClass` (browser singleton: `init`, `runtime`, `destroy`) | symbol | `packages/runtime/src/index.ts` -> `GenClass` | [public-api](runtime/public-api-and-lifecycle.md) |
| `createRuntime` (headless entry point) | symbol | `packages/runtime/src/index.ts` -> `createRuntime` | [public-api](runtime/public-api-and-lifecycle.md) |
| Kill switch `?genclass=off\|observe\|guard\|heal` / `localStorage.genclass` | URL param, storage key | `packages/runtime/src/index.ts` -> `killSwitch` | [public-api](runtime/public-api-and-lifecycle.md) |
| Owned model host built by `createRuntime` | symbol | `packages/runtime/src/index.ts` -> `makeHost` | [model-host](runtime/model-host.md) |
| Un-observed fetch used for model downloads | constant | `packages/runtime/src/index.ts` -> `NATIVE_FETCH` | [observe-and-trace](runtime/observe-and-trace.md) |
| All-observers-off map (inert runtime) | constant | `packages/runtime/src/index.ts` -> `ALL_OFF` | [public-api](runtime/public-api-and-lifecycle.md) |
| `RuntimeImpl` (implements every `Runtime` method) | class | `packages/runtime/src/runtime.ts` -> `RuntimeImpl` | [public-api](runtime/public-api-and-lifecycle.md) |
| `InitOptions` (`mode`, `model`, `decider`, `observe`, `policy`, `report`, `triage`, `settleMs`, `historySize`, `situation`, ...) | type | `packages/runtime/src/types.ts` -> `InitOptions` | [public-api](runtime/public-api-and-lifecycle.md) |
| `CreateOptions` (adds `clock`, `global`, `app`, `hooks`) | type | `packages/runtime/src/types.ts` -> `CreateOptions` | [public-api](runtime/public-api-and-lifecycle.md) |
| `ModelOptions` (`baseUrl`, `preload`, ...) | type | `packages/runtime/src/types.ts` -> `ModelOptions` | [model-host](runtime/model-host.md) |
| `PolicyOptions` (`thresholds`, `holdBudgetMs`, `allow`, `deny`, `holdUserWrites`, `requireDiagnosis`) | type | `packages/runtime/src/types.ts` -> `PolicyOptions` | [decide-policy](runtime/decide-policy-actions.md) |
| `Runtime` interface | type | `packages/runtime/src/types.ts` -> `Runtime` | [public-api](runtime/public-api-and-lifecycle.md) |
| `RuntimeEvents` (decide, detect, act, report, event, status) | type | `packages/runtime/src/types.ts` -> `RuntimeEvents` | [public-api](runtime/public-api-and-lifecycle.md) |
| `Plugin` / `PluginApi` | type | `packages/runtime/src/types.ts` -> `Plugin`, `PluginApi` | [public-api](runtime/public-api-and-lifecycle.md) |
| `Decision`, `ActionRecord` | type | `packages/runtime/src/types.ts` -> `Decision`, `ActionRecord` | [decide-policy](runtime/decide-policy-actions.md) |
| `DecisionProvider`, `EvaluateRequest` (model seam) | type | `packages/runtime/src/types.ts` -> `DecisionProvider`, `EvaluateRequest` | [model-io-contract](model-io-contract.md) |
| `JevState`, `TriggerKind` | type | `packages/runtime/src/types.ts` -> `JevState`, `TriggerKind` | [model-io-contract](model-io-contract.md) |
| `Clock` and the default real clock | type, constant | `packages/runtime/src/types.ts` -> `Clock`; `packages/runtime/src/clock.ts` -> `browserClock` | [public-api](runtime/public-api-and-lifecycle.md) |
| `GenClassUnavailableError` | class | `packages/runtime/src/errors.ts` -> `GenClassUnavailableError` | [public-api](runtime/public-api-and-lifecycle.md) |
| Observer install order and uninstall | method | `RuntimeImpl.installObservers` | [observe-and-trace](runtime/observe-and-trace.md) |
| Is the decider consulted? (ready/off, not paused) | method | `RuntimeImpl.consultable` | [public-api](runtime/public-api-and-lifecycle.md) |
| Trigger -> triage -> situation -> queue | method | `RuntimeImpl.trigger` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Settled points (invariants, snapshots, profiles) | method | `RuntimeImpl.settled` | [state-and-adapters](runtime/state-and-adapters.md) |
| Model answer -> gate -> action | method | `RuntimeImpl.onDecision` | [decide-policy](runtime/decide-policy-actions.md) |
| Auto situation budget by device (`budgetScale`) | method | `RuntimeImpl.situationBudget` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| `SitEnv` implementation | method | `RuntimeImpl.makeEnv` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Chain revert (error/transition rollback) | method | `RuntimeImpl.revertChain` | [state-and-adapters](runtime/state-and-adapters.md) |
| Late-revert window (2,000 ms) | constant | `packages/runtime/src/runtime.ts` -> `LATE_REVERT_MS` | [decide-policy](runtime/decide-policy-actions.md) |
| In-flight age that blocks settled points (10 s) | constant | `packages/runtime/src/runtime.ts` -> `LONG_RUNNING_MS` | [state-and-adapters](runtime/state-and-adapters.md) |
| Console line `[GenClass] Model unavailable (...); observing only.` | string | `packages/runtime/src/runtime.ts` -> `RuntimeImpl` constructor (status subscription) | [status](status-and-known-issues.md) |

### Observers and trace

| X | kind | where | doc |
|---|---|---|---|
| fetch wrapper, request/failure gates, stall controller | function | `packages/runtime/src/observe/fetch.ts` -> `installFetch` | [observe-and-trace](runtime/observe-and-trace.md) |
| Max request body hashed for identity (64 KiB) | constant | `packages/runtime/src/observe/fetch.ts` -> `IDENTITY_BODY_MAX` | [observe-and-trace](runtime/observe-and-trace.md) |
| XHR patch | function | `packages/runtime/src/observe/xhr.ts` -> `installXHR` | [observe-and-trace](runtime/observe-and-trace.md) |
| DOM user-action observer | function | `packages/runtime/src/observe/dom-user.ts` -> `installDomUser` | [observe-and-trace](runtime/observe-and-trace.md) |
| `describeElement` (public helper) | function | `packages/runtime/src/observe/dom-user.ts` -> `describeElement` | [observe-and-trace](runtime/observe-and-trace.md) |
| `data-genclass-ignore` attribute handling | attribute | `packages/runtime/src/observe/dom-user.ts` -> `ignoredEvent` | [devtools](runtime/devtools.md) |
| WebSocket, timers, nav, storage, errors, longtask observers | function | `packages/runtime/src/observe/{websocket,timers,nav,storage,errors,perf}.ts` -> `installWebSocket`, `installTimers`, `installNav`, `installStorage`, `installErrors`, `installPerf` | [observe-and-trace](runtime/observe-and-trace.md) |
| GET cache and coalescing table | class | `packages/runtime/src/observe/cache.ts` -> `ResponseCache` | [observe-and-trace](runtime/observe-and-trace.md) |
| Cache limits (`MAX_BODY` 256 KB, `MAX_ENTRIES` 64, `COALESCE_WINDOW_MS` 2000) | constant | `packages/runtime/src/observe/cache.ts` | [observe-and-trace](runtime/observe-and-trace.md) |
| `x-genclass: blocked\|cached\|coalesced` response header | header | `packages/runtime/src/observe/cache.ts` -> `makeResponse`, `blockedResponse` | [observe-and-trace](runtime/observe-and-trace.md) |
| Op registry and `OpRec` | class, type | `packages/runtime/src/trace/ops.ts` -> `OpRegistry`, `OpRec` | [observe-and-trace](runtime/observe-and-trace.md) |
| Ambient op, `LazyOp` | class | `packages/runtime/src/trace/context.ts` -> `Context`, `LazyOp` | [observe-and-trace](runtime/observe-and-trace.md) |
| Event ring buffer | class | `packages/runtime/src/trace/events.ts` -> `EventLog` | [observe-and-trace](runtime/observe-and-trace.md) |
| Op signature normalisation (`GET /api/items/:id`) | function | `packages/runtime/src/util.ts` -> `normalizePath`, `isIdSegment`, `requestSignature` | [observe-and-trace](runtime/observe-and-trace.md) |
| Hashing | function | `packages/runtime/src/util.ts` -> `fnv1a`, `stableStringify` | [public-api](runtime/public-api-and-lifecycle.md) |
| Default redaction | constant | `packages/runtime/src/util.ts` -> `defaultRedact` | [learn-situation-triage](runtime/learn-situation-triage.md) |

### State and adapters

| X | kind | where | doc |
|---|---|---|---|
| Store registry and mutation pipeline | class | `packages/runtime/src/state/hub.ts` -> `StoreHub` | [state-and-adapters](runtime/state-and-adapters.md) |
| One proposed write | type | `packages/runtime/src/state/hub.ts` -> `MutationRec` | [state-and-adapters](runtime/state-and-adapters.md) |
| Field flattening and patches | function | `packages/runtime/src/state/fields.ts` -> `flatten`, `patchValue` | [state-and-adapters](runtime/state-and-adapters.md) |
| Flattening limits (`MAX_DEPTH` 4, `MAX_KEYS_EXPAND` 32, `MAX_FIELDS_PER_STORE` 200) | constant | `packages/runtime/src/state/fields.ts` | [state-and-adapters](runtime/state-and-adapters.md) |
| Invariant miner (`LEARN_AFTER` 3, `LEARN_AFTER_NONNULL` 6) | class, constant | `packages/runtime/src/state/invariants.ts` -> `InvariantMiner` | [state-and-adapters](runtime/state-and-adapters.md) |
| Field-path normalisation for chain keys | function | `packages/runtime/src/util.ts` -> `normalizeFieldPath` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| React bindings | symbol | `packages/runtime/src/adapters/react.ts` -> `GenClassProvider`, `useGenClassState`, `useAtom` | [state-and-adapters](runtime/state-and-adapters.md) |
| Redux enhancer and replace action `"@@genclass/REPLACE"` | symbol | `packages/runtime/src/adapters/redux.ts` -> `genclassEnhancer`, `GENCLASS_REPLACE` | [state-and-adapters](runtime/state-and-adapters.md) |
| Zustand middleware | function | `packages/runtime/src/adapters/zustand.ts` -> `genclass` | [state-and-adapters](runtime/state-and-adapters.md) |

### Learn, situation and questions (frozen at `situation-v1`)

| X | kind | where | doc |
|---|---|---|---|
| Latency/outcome baselines | class | `packages/runtime/src/learn/baselines.ts` -> `Baselines` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Transition profiles (`MIN_COMPLETIONS` 20, `RARE` 0.01) | class, constant | `packages/runtime/src/learn/profiles.ts` -> `Profiles` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Facts per trigger (`MAX_FACTS` 12) | function | `packages/runtime/src/situation/facts.ts` -> `computeFacts` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Situation assembly | function | `packages/runtime/src/situation/build.ts` -> `buildSituation` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Which built-in actions apply to a subject | function | `packages/runtime/src/situation/build.ts` -> `builtinApplicable` | [decide-policy](runtime/decide-policy-actions.md) |
| Action catalogue, per-trigger actions, passive action | constant | `packages/runtime/src/situation/questions.ts` -> `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS`, `PASSIVE` | [model-io-contract](model-io-contract.md) |
| Diagnosis vocabulary (10 labels) | constant | `packages/runtime/src/situation/questions.ts` -> `DEFAULT_DIAGNOSES` | [model-io-contract](model-io-contract.md) |
| Standing-question builder; bare labels at <= 1,400 chars | function, constant | `packages/runtime/src/situation/questions.ts` -> `buildQuestions`, `COMPACT_QUESTIONS_BUDGET` | [model-io-contract](model-io-contract.md) |
| Budget-shaped state | function | `packages/runtime/src/situation/serialize.ts` -> `toJevState`, `sectionLimits` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Budgets 3,200 / 1,100 / 500 chars | constant | `packages/runtime/src/situation/serialize.ts` -> `STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `MIN_BUDGET` | [model-io-contract](model-io-contract.md) |
| Read-only runtime view for situation code; trigger subjects | type | `packages/runtime/src/situation/env.ts` -> `SitEnv`, `SubjectSpec` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Op phrasing in situations and `changed` sentences | function | `packages/runtime/src/situation/describe.ts` -> `opPhrase` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Python port of the situation text | function | `training/curriculum/rt.py` -> `render` | [training](training.md) |
| Freeze marker | git tag | `situation-v1` (1a77558); check `git diff situation-v1 HEAD -- packages/runtime/src` | [model-io-contract](model-io-contract.md) |

### Decide, policy and reports

| X | kind | where | doc |
|---|---|---|---|
| Decision queue | class | `packages/runtime/src/decide/decider.ts` -> `DeciderQueue` | [decide-policy](runtime/decide-policy-actions.md) |
| Runtime-side provider timeout (10 s) | constant | `packages/runtime/src/decide/decider.ts` -> `PROVIDER_TIMEOUT_MS` | [decide-policy](runtime/decide-policy-actions.md) |
| Summed-mass gate (CONTRACT §8) | function | `packages/runtime/src/decide/policy.ts` -> `gate` | [decide-policy](runtime/decide-policy-actions.md) |
| Default thresholds (report 0.6, guard 0.9, heal 0.8) | config | `packages/runtime/src/decide/policy.ts` -> `policyConfig` | [decide-policy](runtime/decide-policy-actions.md) |
| Hold budget (auto: clamp 150-800 ms, fallback 300) | function, constant | `packages/runtime/src/decide/policy.ts` -> `holdBudget`, `HOLD_MIN_MS`, `HOLD_MAX_MS`, `HOLD_FALLBACK_MS` | [decide-policy](runtime/decide-policy-actions.md) |
| Rate limiter (`policy.maxActionsPerMinute`, default 60) | class | `packages/runtime/src/decide/policy.ts` -> `RateLimiter`, `policyConfig` | [decide-policy](runtime/decide-policy-actions.md) |
| `Controller` / `NetHost` seams | type | `packages/runtime/src/decide/exec.ts` -> `Controller`, `NetHost` | [decide-policy](runtime/decide-policy-actions.md) |
| Console reports and dedupe | class, function | `packages/runtime/src/decide/report.ts` -> `Reporter`, `interventionLine` | [decide-policy](runtime/decide-policy-actions.md) |

### Model host and CLI

| X | kind | where | doc |
|---|---|---|---|
| Model host factory | function | `packages/runtime/src/model/host.ts` -> `createModelHost` | [model-host](runtime/model-host.md) |
| Default model URL (unpublished `@genclass/runtime-model@0.1.0`) | constant | `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` | [model-host](runtime/model-host.md) |
| Host defaults (`DEFAULT_TIMEOUT_MS` 10 s, `DEFAULT_MAX_QUEUE` 32) | constant | `packages/runtime/src/model/host.ts` | [model-host](runtime/model-host.md) |
| Worker URL literal `new Worker(new URL("./worker.js", import.meta.url), ...)` | code pattern | `packages/runtime/src/model/host.ts` -> `defaultWorkerFactory` | [build-test-release](runtime/build-test-release.md) |
| Load and evaluate (in the worker or inline) | class | `packages/runtime/src/model/backend.ts` -> `ModelBackend` | [model-host](runtime/model-host.md) |
| Warm-up request | constant | `packages/runtime/src/model/backend.ts` -> `WARMUP_STATE`, `WARMUP_QUESTIONS` | [model-host](runtime/model-host.md) |
| Card format `genclass-runtime-model/1` | constant | `packages/runtime/src/model/loader.ts` -> `CARD_FORMAT`, `parseCard` | [model-host](runtime/model-host.md) |
| Plan order webgpu+fp16 -> webgpu+q8 -> wasm+q8 | function | `packages/runtime/src/model/loader.ts` -> `planOrder` | [model-host](runtime/model-host.md) |
| Cache Storage name `genclass-runtime-v1` | constant | `packages/runtime/src/model/loader.ts` -> `DEFAULT_CACHE_NAME` | [model-host](runtime/model-host.md) |
| Packer + ORT session + calibration | class | `packages/runtime/src/model/engine.ts` -> `Engine`, `FEEDS` | [model-io-contract](model-io-contract.md) |
| Packing limits (`max_len` 1536, `max_total` 8192 defaults) | config | `packages/runtime/src/model/packer.ts` -> `Packer`; `packages/runtime/src/model/engine.ts` -> `Engine` (reads `meta.json`) | [model-io-contract](model-io-contract.md) |
| Marker tokens `[Q] [O] [L] [T] [F]` | constant | `packages/runtime/src/model/packer.ts` -> `MARKERS` | [model-io-contract](model-io-contract.md) |
| BPE tokenizer | class | `packages/runtime/src/model/tokenizer.ts` -> `Tokenizer` | [model-host](runtime/model-host.md) |
| State/question text (Python parity) | function | `packages/runtime/src/model/serialize.ts` -> `stateSegments`, `questionBlock` | [model-io-contract](model-io-contract.md) |
| Calibration and answer math | function, constant | `packages/runtime/src/model/calibrate.ts` -> `calibrateLogits`, `buildAnswer`, `K_BUCKETS` | [model-io-contract](model-io-contract.md) |
| Model errors (`max_tokens_exceeded`, not ready, ...) | class | `packages/runtime/src/model/errors.ts` -> `GenClassModelError`, `ModelNotReadyError`, `MaxTokensExceededError` | [model-host](runtime/model-host.md) |
| sha256 integrity / sha1 header keys | function | `packages/runtime/src/model/hash.ts` -> `sha256Hex`, `sha1Hex` | [model-host](runtime/model-host.md) |
| Host <-> worker messages | type | `packages/runtime/src/model/protocol.ts` -> `ToWorker`, `FromWorker` | [model-host](runtime/model-host.md) |
| `genclass-runtime fetch-model <dir>` / `info <dir>` | CLI | `packages/runtime/bin/genclass-runtime.mjs` -> `fetchModel`, `info` | [model-host](runtime/model-host.md) |
| CLI default source (release `runtime-model-v0.1.0`, does not exist yet) | constant | `packages/runtime/bin/genclass-runtime.mjs` -> `DEFAULT_FROM` | [status](status-and-known-issues.md) |

### Devtools overlay

| X | kind | where | doc |
|---|---|---|---|
| `mountDevtools` (`@genclass/runtime/devtools`) | function | `packages/runtime/src/devtools/index.ts` -> `mountDevtools` | [devtools](runtime/devtools.md) |
| Alt+Shift+G toggle | key binding | `packages/runtime/src/devtools/index.ts` -> `Devtools` | [devtools](runtime/devtools.md) |
| Report sentence parsing | function | `packages/runtime/src/devtools/ui.ts` -> `splitReport` | [devtools](runtime/devtools.md) |
| Stylesheet | constant | `packages/runtime/src/devtools/css.ts` -> `CSS` | [devtools](runtime/devtools.md) |

### Build, test and release

| X | kind | where | doc |
|---|---|---|---|
| Workspaces (`packages/*`, `sim`, `demos`) and root scripts `build`, `test`, `typecheck` | config | `package.json` -> `workspaces`, `scripts` | [build-test-release](runtime/build-test-release.md) |
| Subpath exports and `bin` | config | `packages/runtime/package.json` -> `exports`, `bin` | [build-test-release](runtime/build-test-release.md) |
| Build entries and externals | config | `packages/runtime/tsup.config.ts` -> `entry`, `dts`, `external` | [build-test-release](runtime/build-test-release.md) |
| Unit-test include/exclude | config | `packages/runtime/vitest.config.ts` | [build-test-release](runtime/build-test-release.md) |
| Typecheck: `npx tsc -p tsconfig.json --noEmit` (in `packages/runtime`) | command | `packages/runtime/package.json` -> `scripts.typecheck` | [build-test-release](runtime/build-test-release.md) |
| Unit tests: `NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**"` (in `packages/runtime`) | command | `packages/runtime/vitest.config.ts`; gc check in `packages/runtime/test/review-timers.test.ts` | [build-test-release](runtime/build-test-release.md) |
| Browser specs `npm run test:browser` (ask first) | command | `packages/runtime/package.json` -> `scripts.test:browser`; `packages/runtime/test/browser/playwright.config.ts` | [build-test-release](runtime/build-test-release.md) |
| Smoke test `bash test/smoke/smoke.sh` (ask first) | command | `packages/runtime/test/smoke/smoke.sh` | [build-test-release](runtime/build-test-release.md) |
| Core test harness | function, class | `packages/runtime/test/helpers.ts` -> `setup`, `FakeClock`, `FakeServer`, `ScriptedDecider`, `ManualDecider` | [build-test-release](runtime/build-test-release.md) |
| Scripted `Runtime` for UI/adapter tests | class | `packages/runtime/test/browser/ui/mock-runtime.ts` -> `MockRuntime` | [devtools](runtime/devtools.md) |
| Real runtime under virtual time for UI tests | function | `packages/runtime/test/browser/ui/session.ts` -> `runStoreSession` | [devtools](runtime/devtools.md) |
| Scripted store story | function | `packages/runtime/test/browser/ui/scenario.ts` -> `loadScenario` | [devtools](runtime/devtools.md) |
| Playwright global setup (rebuilds `dist/`) | function | `packages/runtime/test/browser/build.mjs` -> `buildLibrary` | [build-test-release](runtime/build-test-release.md) |
| Model fixtures from an export instead of v0.1 | flag | `packages/runtime/test/model/helpers.ts` -> `FIXTURES_FROM_MODEL` | [build-test-release](runtime/build-test-release.md) |
| VM helper `scripts/vm.sh sync\|run\|exec\|get SLOT ...` (Azure; ask first) | command | `scripts/vm.sh` | [build-test-release](runtime/build-test-release.md) |
| Release tags `v0.1.0-alpha.0` (654d822), `situation-v1` (1a77558) | git tag | `git tag -n1` | [build-test-release](runtime/build-test-release.md) |

### Environment variables

| X | used by | where | doc |
|---|---|---|---|
| `GENCLASS_MODEL_DIR` (default `<repo>/.cache-model`) | model unit tests and browser specs | `packages/runtime/test/model/helpers.ts` -> `MODEL_DIR`; `packages/runtime/test/browser/model-helpers.ts` -> `MODEL_DIR` | [build-test-release](runtime/build-test-release.md) |
| `GENCLASS_WEBGPU_VARIANTS` | WebGPU spec variants | `packages/runtime/test/browser/model-webgpu.spec.ts` | [build-test-release](runtime/build-test-release.md) |
| `GENCLASS_BENCH_MODELS`, `GENCLASS_OFFLINE` | browser model specs | `packages/runtime/test/browser/model.spec.ts` | [build-test-release](runtime/build-test-release.md) |
| `NODE_OPTIONS=--expose-gc` | gc check in a REVIEW test | `packages/runtime/test/review-timers.test.ts` | [build-test-release](runtime/build-test-release.md) |
| `SIM_RUNTIME=real` | sim tests use the real runtime | `sim/test/helpers.ts` -> `testFactory` | [sim](sim.md) |
| `GC_P_RUNTIME` (set from `--p-runtime`) | share of runtime-exact curriculum rows | `training/curriculum/generate.py` -> `P_RUNTIME` | [training](training.md) |
| `GC_V1_CKPT`, `GC_BASE_32M` | prune tests | `training/tests/test_prune_vocab.py` | [training](training.md) |
| `GC_R17_INIT` | export end-to-end test | `training/tests/test_export_runtime.py` | [training](training.md) |
| `GENCLASS_SHIM` (`1` forces the runtime shim, `0` forbids it) | demos build | `demos/vite.config.ts` | [demos](demos.md) |
| `VITE_GENCLASS_MODEL_URL` | demo model location (after `?model=`) | `demos/src/shared/settings.ts` -> `modelBaseUrl` | [demos](demos.md) |
| `GENCLASS_MODEL_FROM`, `GENCLASS_MODEL_DIR`, `GENCLASS_MODEL_URL`, `GENCLASS_MODEL_VARIANT`, `ALLOW_BROKEN_RUNTIME`, `SKIP_EVAL` | demos VM pipeline | `demos/scripts/vm-eval.sh` | [demos](demos.md) |
| `JEV_LOCAL_FAST_CKPT` | fast checkpoint dir (default `<repo>/models/jev-local-fast`) | `jev_local/engine/registry.py` -> `default_fast_ckpt` | [lineage](genclass-model-lineage.md) |
| `JEV_ENCODER` (`banded` / `reference`) | encoder choice | `jev_local/engine/encoder/engine.py`; set in `scripts/launch_run.sh` | [lineage](genclass-model-lineage.md) |
| `TIMEOUT` (default 1800 s per remote command) | VM helper | `scripts/vm.sh` | [build-test-release](runtime/build-test-release.md) |
| `GENCLASS_EXT` (unpacked extension dir) | extension e2e | `extension/test/e2e/fixtures.mjs` | [extension](extension-and-benchmarks.md) |

### sim

| X | kind | where | doc |
|---|---|---|---|
| Scenario from a seed; split assignment; held-out domains | function, constant | `sim/src/world/scenario.ts` -> `buildScenario`, `splitOf`, `TEST_DOMAINS` | [sim](sim.md) |
| One run (ideal or real runtime) | function | `sim/src/run/runner.ts` -> `runScenario` | [sim](sim.md) |
| Trajectory -> rows; counterfactual costs | function | `sim/src/gen/trajectory.ts` -> `generateTrajectory`, `pointCosts` | [sim](sim.md) |
| Run cost, cost weights, soft action label, tier premiums | function, constant | `sim/src/oracle/cost.ts` -> `runCost`, `W`, `actionLabel`, `LABEL`, `TIER` | [sim](sim.md) |
| Diagnosis labels | function | `sim/src/oracle/diagnose.ts` -> `diagnose` | [sim](sim.md) |
| Ground-truth bookkeeping | class | `sim/src/oracle/knowledge.ts` -> `Knowledge` | [sim](sim.md) |
| Virtual event loop | class | `sim/src/loop.ts` -> `VirtualLoop` | [sim](sim.md) |
| Seeded RNG with keyed forks | class | `sim/src/rng.ts` -> `Rng`, `hashAll` | [sim](sim.md) |
| Virtual network and ideal profile; sim op header | class, constant | `sim/src/net/network.ts` -> `Network`, `IDEAL_PROFILE`, `SIM_OP_HEADER` | [sim](sim.md) |
| Virtual server | class | `sim/src/net/server.ts` -> `VirtualServer` | [sim](sim.md) |
| Feature combinators and weights | constant | `sim/src/app/features/index.ts` -> `FEATURES`, `FEATURE_WEIGHTS` | [sim](sim.md) |
| 55 domain vocabularies | constant | `sim/src/app/vocab.ts` -> `DOMAINS` | [sim](sim.md) |
| Loading the real runtime; `createRuntime` options | function | `sim/src/run/rt.ts` -> `realRuntimeFactory`, `createOptions` | [sim](sim.md) |
| Fake runtime (test double; generator refuses it without `--allow-fake`) | function | `sim/src/run/fake-runtime.ts` -> `createFakeRuntime`; flag in `sim/src/gen.ts` | [sim](sim.md) |
| Ask questions | function | `sim/src/ask/questions.ts` -> `askQuestions` | [sim](sim.md) |
| Action-option shuffle/drop and paraphrases | function, constant | `sim/src/run/transform.ts` -> `transformQuestions`, `ACTION_PARA` | [sim](sim.md) |
| CONTRACT-D row type | type | `sim/src/types.ts` -> `Row`, `Label` | [model-io-contract](model-io-contract.md) |
| `node sim/dist/gen.js --rows N --out DIR ...` (`--sample`, `--parts`) (ask first) | CLI | `sim/src/gen.ts` -> `main` | [sim](sim.md) |
| `bash sim/scripts/final.sh a\|b\|merge-b` (VM; ask first) | command | `sim/scripts/final.sh` | [sim](sim.md) |

### training and the Python reference

| X | kind | where | doc |
|---|---|---|---|
| Curriculum row factory | function | `training/curriculum/generate.py` -> `make_row` | [training](training.md) |
| Scenario result dataclass | class | `training/curriculum/scenarios.py` -> `Scen` | [training](training.md) |
| Surface-variation templates | constant | `training/curriculum/fmt.py` -> `TEMPLATES`, `Style` | [training](training.md) |
| Curriculum domains (13 held out) | constant | `training/curriculum/vocab.py` -> `DOMAINS`, `TEST_DOMAINS` | [training](training.md) |
| Calibration fit and gate metrics | function | `training/eval_runtime.py` -> `fit_calibration`, `decision_metrics` | [training](training.md) |
| q8 / fp16 export | function | `training/export_runtime.py` -> `make_q8`, `make_fp16` | [training](training.md) |
| Vocabulary pruning | function | `training/prune_vocab.py` -> `prune_tokenizer_json` | [training](training.md) |
| Export check in onnxruntime-web WASM: `node validate.mjs <dir> [variant] [maxRequests]` | CLI | `training/ortweb/validate.mjs` | [training](training.md) |
| Mixture configs | config | `training/configs/mix_*.json`, read by `jev_local/train/stream.py` -> `MixConfig` | [training](training.md) |
| Row label -> training target; example encoding | function | `jev_local/train/train.py` -> `parse_target`, `encode_example` | [lineage](genclass-model-lineage.md) |
| Python serializer (reference for `model/serialize.ts`) | function | `jev_local/serialize.py` -> `state_segments`, `question_block` | [lineage](genclass-model-lineage.md) |
| Python packer (reference for `model/packer.ts`) | class | `jev_local/engine/encoder/tokenize_pack.py` -> `Packer` | [lineage](genclass-model-lineage.md) |
| Python calibration lookup (reference for `model/calibrate.ts`) | function | `jev_local/engine/encoder/calibrate.py` -> `header_key`, `tau_for` | [lineage](genclass-model-lineage.md) |
| Python answer math | function | `jev_local/confidence.py` -> `build_answer` | [lineage](genclass-model-lineage.md) |
| Decision heads | class | `jev_local/engine/encoder/heads.py` -> `DecisionHeads` | [lineage](genclass-model-lineage.md) |
| Python inference engine | class | `jev_local/engine/encoder/engine.py` -> `FastEngine` | [lineage](genclass-model-lineage.md) |
| ONNX graph definition (imported by the runtime exporter) | class | `scripts/genclass_export.py` -> `ExportModel` | [model-io-contract](model-io-contract.md) |
| Jev-wire HTTP server | function | `jev_local/server/app.py` -> `create_app` | [lineage](genclass-model-lineage.md) |

### demos

| X | kind | where | doc |
|---|---|---|---|
| Where the demos create the runtime | function | `demos/src/shared/genclass.ts` -> `startGenClass` | [demos](demos.md) |
| Mock-server session | class | `demos/src/server/core.ts` -> `World` | [demos](demos.md) |
| Chaos presets and per-route resolution | constant, function | `demos/src/shared/chaos.ts` -> `PRESETS`, `resolveChaos` | [demos](demos.md) |
| Clean-trial chaos | constant | `demos/src/shared/scenario-kit.ts` -> `CLEAN_CHAOS` | [demos](demos.md) |
| Trial harness | class | `demos/src/shared/harness.ts` -> `TrialHarness` | [demos](demos.md) |
| Aggregation (Wilson intervals, per-mode summary) | function | `demos/src/shared/aggregate.ts` -> `wilson`, `summarizeMode` | [demos](demos.md) |
| Demo page boot (mounts devtools; `?devtools=open`) | function | `demos/src/site/demo-page.ts` -> `bootDemo` | [demos](demos.md) |
| Demo mode type (`off`/`guard`/`heal`) | type | `demos/src/shared/types.ts` -> `GcMode` | [demos](demos.md) |
| `?trace=1` investigation tracing | URL param | `demos/src/shared/settings.ts` -> `traceOn`; `demos/src/shared/trace.ts` | [demos](demos.md) |
| Timers captured before `GenClass.init` | constant | `demos/src/shared/native.ts` -> `nativeSetTimeout` | [demos](demos.md) |
| Custom plugin example | function | `demos/src/demos/decisions/plugin.ts` -> `backgroundWorkPlugin` | [demos](demos.md) |
| `npm run eval` / `eval:fast` / `shots` (Playwright; ask first) | command | `demos/package.json` -> `scripts`; `demos/e2e/eval.ts` | [demos](demos.md) |

## 4. Generated and ignored paths

Ignore rules live in `.gitignore` (root), `demos/.gitignore`, `extension/.gitignore` and `packages/runtime/test/browser/.gitignore`. The root rules `data/`, `models/`, `runs/`, `dist/` and `node_modules/` have no leading slash, so they match at any depth.

| path | ignored by | produced by | notes |
|---|---|---|---|
| `node_modules/` (root) | root | `npm install` at the repo root (workspaces hoisted; about 134 packages) | `extension/` and `training/ortweb/` are not workspaces and need their own `npm install` |
| `package-lock.json` (root) | **not ignored** | `npm install` at the root | never committed; shows as untracked. Do not commit it unless asked |
| `packages/runtime/bin/genclass-runtime.mjs` mode change | — | `npm install` chmods it to 755 (committed mode 644) | shows as a modified file; revert with `git checkout -- packages/runtime/bin/genclass-runtime.mjs` |
| `packages/runtime/dist/` | root `dist/` | `npx tsup` / `npm run build` (in `packages/runtime`); also `sim`'s `build:runtime-core` script and `packages/runtime/test/browser/build.mjs` (Playwright global setup) rewrite it | `sim` and `demos` import the runtime through this `dist/`; a working copy may hold a stale one |
| `sim/dist/` | root `dist/` | `npm run build` in `sim` (tsup: `gen`, `worker`, `index`, `smoke`) | — |
| `demos/dist/` | root and `demos/.gitignore` | `npm run build` in `demos` (`demos/scripts/build.mjs`) | — |
| `extension/dist/` | root and `extension/.gitignore` | `extension/scripts/build.mjs` (`dist/genclass/`) | — |
| `sim/out/` | root | `sim/src/gen.ts` (default `--out sim/out/run`), `sim/scripts/final.sh` (`sim/out/final-a/`, `sim/out/final-b/parts/`) | training data; excluded from `scripts/vm.sh` syncs |
| `.cache-model/` | root | `node packages/runtime/bin/genclass-runtime.mjs fetch-model .cache-model --from https://github.com/MeharPro/GenClass/releases/download/v0.1.0/` (ask first: download; without `--from` the CLI uses the unpublished `DEFAULT_FROM`) | default `GENCLASS_MODEL_DIR`; absent in a fresh clone, so 14 model tests skip |
| `packages/runtime-model/files/` | root | intended for `training/export_runtime.py` output (the planned `@genclass/runtime-model` package) | does not exist at 654d822 |
| `demos/public/genclass-model/` | `demos/.gitignore` | `npm run fetch-model` in `demos` (`demos/scripts/fetch-model.sh`, v0.1 model) | — |
| `packages/runtime/test/browser/.build/` | `packages/runtime/test/browser/.gitignore` | `packages/runtime/test/browser/build.mjs` | bundled test app and build info |
| `test-results/` | root, `demos/.gitignore`, `extension/.gitignore` | Playwright (`packages/runtime/test-results/{browser,ui}`), model benchmarks (`packages/runtime/test-results/model-bench/`) | — |
| `playwright-report/` | root, `demos/.gitignore`, `extension/.gitignore` | Playwright HTML reporter | — |
| `demos/e2e/.out/` | `demos/.gitignore` | `demos/e2e/eval.ts` (`partial.json`, `traces*.json` with `--trace`) | input to `demos/e2e/trace-report.ts` |
| `*.tgz` | root | `npm pack` in `packages/runtime/test/smoke/smoke.sh` (left in `packages/runtime/`) | — |
| `.publish/` | root | no tracked script; added with the alpha publish (59c213f) | purpose not recorded |
| `.vite/` | root | Vite cache directory (no config in the repo sets `cacheDir`; Vite's default is `node_modules/.vite`) | — |
| `data/` (any depth) | root | not produced in this repo. Matches the missing `jev_local/data/` (data generators) and `demos/src/server/data/cities.ts`; Azure hosts keep training data under `$G/data/` | the rule hides source files that the code imports |
| `models/` (any depth) | root | `python -m jev_local.train.train --out models/<M>` (servable checkpoints); `training/prune_vocab.py --out` (on Azure, e.g. `models/r32-v16k`) | default `JEV_LOCAL_FAST_CKPT` is `<repo>/models/jev-local-fast`; none in the repo |
| `runs/` (any depth) | root | trainer state and logs (`runs/<run>/ckpt`, `log.jsonl`), `scripts/benchmax.py` (`runs/benchmax/...`), `scripts/bench_encoder.py`, `scripts/bench_decoder.py` | none in the repo |
| `extension/release-assets/*.onnx` | `extension/.gitignore` | `extension/tools/genclass_export.py` | absent |
| `.venv/`, `__pycache__/`, `*.pyc`, `.pytest_cache/`, `*.egg-info/` | root | Python venv, pytest, `pip install -e .` of `jev-local` | — |
| `.DS_Store` | root, `extension/.gitignore` | macOS Finder | — |
| `docs/agents/`, `AGENTS.md`, `CLAUDE.md` | not ignored | these agent docs | untracked at 654d822 |

## 5. Large files: do not read in full

Sizes from `wc -c` / `wc -l` at 654d822. "0 lines" means one line with no trailing newline: inspect it with `python3 -c` or `jq` (keys, lengths, one record) instead of opening it.

| path | bytes | lines | what it is / how to read it |
|---|---|---|---|
| `extension/src/model/tokenizer.json` | 3,584,123 | 251,542 | HF tokenizer of the v0.1 model. Read keys only (`added_tokens`, `model.type`) |
| `extension/release-assets/tokenizer.json` | 3,584,123 | 251,542 | byte-identical copy of the above |
| `extension/test/fixtures/policy_py.json` | 3,069,755 | 0 | Python-harness policy parity fixture |
| `extension/test/fixtures/pack_fixtures.json` | 1,228,103 | 0 | Python packer output for the v0.1 requests |
| `packages/runtime/test/fixtures/model/pack_fixtures.json` | 955,379 | 0 | compact copy of the extension's pack fixtures; read through `packages/runtime/test/model/helpers.ts` -> `packs` |
| `sim/samples/sample.jsonl` | 848,581 | 200 | 200 CONTRACT-D rows (about 4 KB each); read one line, or `sim/samples/EXAMPLES.md` |
| `bench/public/targets.json` | 785,218 | 30,045 | 549 benchmax targets |
| `demos/results.json` | 773,038 | 39,384 | raw demo trials; read `demos/results.md` or `demos/results-summary.json` instead |
| `bench/public/jev_published.json` | 383,059 | 8,236 | 549 published Jev numbers |
| `extension/test/fixtures/requests50.json` | 346,737 | 9,399 | the 50 harness requests with `gold` and `screen_type` |
| `packages/runtime/test/fixtures/model/requests50.json` | 285,309 | 0 | the same 50 requests without `gold`/`screen_type` |
| `extension/test/fixtures/torch_fixtures.json` | 269,230 | 0 | PyTorch logits of the v0.1 model |
| `packages/runtime/test/fixtures/model/torch_fixtures.json` | 255,945 | 0 | compact copy of the above |
| `extension/test/fixtures/questions_py.json` | 222,955 | 16,984 | Python-harness question fixtures |
| `docs/benchmax-research/jev-published.md` | 217,513 | 2,206 | census of published Jev numbers |
| `packages/runtime/test/fixtures/model/py_fixtures.json` | 167,629 | 0 | Python reference cases for serialize/tokenize/calibrate/confidence |
| `jev_local/bench/registry.py` | 90,896 | 1,888 | jevbench dataset registry and exclusion rules (source; grep it) |
| `docs/SPEC.md` | 84,347 | 1,131 | legacy jev-local rebuild spec |
| `docs/benchmax-research/{PLAN,feasibility-targets,suite-reproduction-specs,train-data-and-supervised-ceilings}.md` | 72,630-93,641 each | 768-971 each | benchmax planning notes |
| `packages/runtime/src/runtime.ts` | 65,221 | 1,583 | `RuntimeImpl`; jump to methods by name (`trigger`, `onDecision`, `settled`) |
| `extension/test/fixtures/spans_py.json` | 59,806 | 5,458 | Python-harness span fixtures |
| `bench/public/exclusions.json` | 59,101 | 2,297 | benchmax exclusion manifest |
| `sim/samples/EXAMPLES.md` | 52,713 | 1,345 | pretty-printed sim rows |
| `scripts/benchmax_build_targets.py` | 52,170 | 671 | target/exclusion generator |
| `extension/package-lock.json` | 50,300 | 1,506 | extension lockfile |
| `packages/runtime/src/devtools/index.ts` | 49,689 | 1,291 | `Devtools` class; read by method |
| `jev_local/bench/benchmax/adapters_b/vendor/earino/val_indices.json` | 43,930 | 0 | vendored upstream indices |
| `docs/agents/*.md`, `docs/agents/runtime/*.md` (subsystem docs) | about 66,000-103,000 each | — | read the TL;DR, then the section you need |

Binary files: 63 tracked PNGs (11,388,350 bytes in total: 18 devtools screenshots, 30 demo screenshots, 10 Chrome Web Store images, 5 extension icons) and 3 WAV clips under `extension/test/fixtures/audio/` (219,600 bytes). Model weights (`*.onnx`) are never tracked.

Other source files over 25 KB that are better read by symbol than end to end: `packages/runtime/src/situation/facts.ts` (568 lines), `packages/runtime/src/model/host.ts` (752), `packages/runtime/src/observe/fetch.ts` (630), `packages/runtime/src/state/hub.ts` (734), `training/curriculum/rt.py` (829), `jev_local/train/train.py` (1,059), `jev_local/train/stream.py` (917), `docs/runtime/CONTRACT.md` (519), `packages/runtime/STATUS.md` (533).
