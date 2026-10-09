# Repository map (GenClass-lib)

> **Scope:** every tracked path (`git ls-files`: 1,202 files at f107013, 1,082 at b435acb, 749 at 654d822), plus the generated and ignored paths that show up in a working copy.
> **Read this when:** you need to find where a file, symbol, constant, CLI command, env var or config key lives; decide whether a directory matters for `@genclass/runtime`; or want to know which paths are generated, ignored or too large to read in full.
> **Source of truth:** the code. Verified against branch `mvp-v2-merge` at f107013 (`mvp-v2` + origin/runtime eff18cb merged + two runtime fixes), 2026-10-08. Sections not touched by the merge keep their b435acb wording where nothing changed. If this doc and the code disagree, the code wins.

Conventions: code pointers are `path/from/repo/root` -> `symbol`. Relevance to the runtime library:

- **core**: ships in `@genclass/runtime` or defines what it ships.
- **supporting**: builds, trains, tests or demonstrates the runtime.
- **legacy**: the earlier GenClass project (Python model, Chrome extension, benchmarks). `docs/runtime/CONTRACT.md` §1 says: "Existing GenClass content (jev_local/, extension/, docs/, etc.) stays as is. Do not edit it." Some legacy files are still reference implementations for the runtime; the notes say which.

Workstream names (lead, CORE, MODEL, UI, SIM, REAL, DEMOS, TRAIN, REVIEW) and their edit rights are described in [status-and-known-issues.md](status-and-known-issues.md) ("Workstreams and ownership"); REAL (`realapps/`) is new since 654d822, see [glossary.md](glossary.md). The index of all agent docs is [README.md](README.md); how the parts fit together is in [overview.md](overview.md). Ground rules and what you may run: [../../AGENTS.md](../../AGENTS.md); terms: [glossary.md](glossary.md); step-by-step procedures: [playbooks.md](playbooks.md).

**What changed since 654d822** (the commit the first version of this map described): `git log --oneline 654d822..b435acb` lists the NaN fix (ad24804), runtime batch 4 (fcd1e68: decisions at the network boundary), the `realapps/` corpus (fcb8189), runtime batch 5 and the `situation-v2` freeze (6e5e86e), `HANDOFF.md` and the v2 curriculum port (d73d20c), `docs/runtime/RESULTS.md` (74f17c0), then our three commits on `mvp-v2`: agent docs (7dab2b3), default mode `observe` (f3636b2) and CI plus the committed root lockfile (b435acb). Use `git diff --stat 654d822 b435acb -- <path>` to see what changed in a path.

**What changed since b435acb** (`git log --oneline b435acb..f107013`): our docs and release commits (b561244, 6ac4737,
806a296 = published `0.1.0-alpha.1`, c16a3b0), the merge dabbce2 of Mehar's `origin/runtime` at eff18cb (realapps wave 3
and more apps, the npm README rewrite, the `situation()` purity test, **the one-command install**: `packages/runtime/bin/lib/`,
`packages/runtime/src/auto.ts`, `packages/runtime/src/cdn/`, `packages/runtime/test/install/`, `packages/genclass-runtime/`,
and the v2 import/eval scripts under `training/`), 10e5c3b (lockfile), 054da38 (observe never holds deliveries) and
f107013 (redaction). `origin/runtime` has four newer commits (up to 5bc40c9, runtime batch 6) that are not in this tree.

## 1. Top-level directories

| dir | tracked files | what | owner / workstream | doc | relevance |
|---|---|---|---|---|---|
| `packages/runtime/` | 183 | `@genclass/runtime`, version `0.1.0-alpha.1` in the tree at f107013 (bumped to `0.1.0-beta.0` in 9695830; `0.1.0-beta.0` is the published `latest` since 2026-10-08 ~13:40 UTC), the npm library: `src/` (72), `test/` (95), `bin/` (6: `genclass-runtime.mjs` CLI, mode 100755, plus `bin/lib/` with `init`/`remove`), package and build configs, STATUS, CHANGELOG, INSTALL-NEEDS, UI-NEEDS | CORE. MODEL owns `src/model/**` and `bin/genclass-runtime.mjs` (`fetch-model`, `info`). INSTALL owns `src/auto.ts`, `src/cdn/**`, `bin/lib/**`, `test/install/**`. UI owns `src/devtools/**` and `src/adapters/**`. REVIEW owns `test/review-*.test.ts`. Us (lead): `test/default-mode.test.ts`, `test/observe-delivery.test.ts`, `test/redaction-v2.test.ts` | the 8 docs under `runtime/`; start with [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) | core |
| `packages/genclass-runtime/` | 4 | (new, f3a9dd1) unscoped alias package `genclass-runtime` 0.1.0-alpha.1: `cli.mjs` imports `@genclass/runtime`'s `bin/genclass-runtime.mjs`; `package.json` (dependency `@genclass/runtime` `0.1.0-alpha.1`), `README.md`, `LICENSE`. A workspace (`packages/*`), **not published** | INSTALL | `packages/runtime/INSTALL-NEEDS.md` item 1 | core (planned) |
| `packages/runtime-model/` | 1 | `MODEL_CARD.md` only at f107013 (since ba11126/bcbee89 also `package.json` and `LICENSE`, so it is a workspace). The npm package `@genclass/runtime-model` that `DEFAULT_MODEL_BASE_URL` points at; `0.1.0` (`r17-v2b`, the first situation-v2 model) is published since 2026-10-08. Its `files/` directory is gitignored | lead | [runtime/model-host.md](runtime/model-host.md) | core (planned) |
| `sim/` | 106 | `@genclass/sim` (private): training-data simulator that drives the real runtime and writes CONTRACT-D rows. Now 46 feature combinators, 115 domains, S1/S2 labels, gold / unlabeled / on-policy row modes, Azure cluster scripts, separability analysis | SIM | [sim.md](sim.md) | supporting |
| `realapps/` | 307 | `@genclass/realapps` (private, **not** a root workspace): 128 app directories with a `manifest.ts` (114 written + 14 open-source Conduit front-ends; Mehar's commit messages say 96 after wave 3, the wave-4 apps arrived inside f3a9dd1 and eff18cb) run in headless Chromium with the real runtime; counterfactual labels like the sim; the "never worse" interference and determinism sweeps | REAL | [realapps.md](realapps.md) | supporting |
| `training/` | 69 | Python curriculum generator, runtime-text port (`curriculum/rt.py`, frozen at `situation-v2`), eval, ONNX export, Azure launch scripts for R17/R32/R68 students and the T150 teacher, teacher labelling, T1 expected-gain scripts | TRAIN (CONTRACT §1 says lead) | [training.md](training.md), [model-io-contract.md](model-io-contract.md) | supporting |
| `demos/` | 133 | `@genclass/demos`: Vite site with six demo apps, a Service Worker chaos backend, Playwright trial eval and shipped results (still the v0.1 model) | DEMOS | [demos.md](demos.md) | supporting |
| `scripts/` | 26 | Ops scripts (since 654d822 only `vm.sh` changed, in eff18cb: its sync keeps the `sim/out` symlink). `vm.sh` is the runtime team's VM build/test path; `azvm.sh`, `launch_run.sh` (training launches) and `genclass_export.py` (`ExportModel` for `training/export_runtime.py`) also support the runtime; the rest are legacy GenClass/benchmax/Azure ops | not recorded (`vm.sh` is listed in CONTRACT §1) | [extension-and-benchmarks.md](extension-and-benchmarks.md) ("Scripts"), [runtime/build-test-release.md](runtime/build-test-release.md) ("VM workflow") | `vm.sh`, `azvm.sh`, `launch_run.sh`, `genclass_export.py`: supporting. Rest: legacy |
| `telemetry-worker/` | 7 | (new, 2026-10-09) Cloudflare Worker `genclass-telemetry`: collector for the runtime's default-on telemetry (`wrangler.toml`, `src/index.ts`, `test/index.test.ts`, `README.md`); writes gzip JSONL to R2 bucket `genclass-telemetry`. Client side: `packages/runtime/src/telemetry/*`, `packages/runtime/TELEMETRY.md` | lead (us) | [telemetry.md](telemetry.md) | core (privacy-relevant) |
| `.github/` | 1 | `workflows/ci.yml`: the only CI (added in b435acb) | lead (us) | [runtime/build-test-release.md](runtime/build-test-release.md) | core |
| `jev_local/` | 136 | Python package `jev-local` 0.1.0: Jev-wire API, encoder engine, trainer, voice harness, benchmark harnesses | none of the runtime workstreams (pre-runtime GenClass) | [genclass-model-lineage.md](genclass-model-lineage.md) | legacy. `serialize.py`, `confidence.py`, `engine/encoder/{tokenize_pack,calibrate,heads}.py` are the parity references for `packages/runtime/src/model`; `train/` is used by `training/` (the gain head the T1 scripts need exists only in the parent repo on the nodes, not here) |
| `extension/` | 104 | GenClass 0.1.0 MV3 voice-control Chrome extension. Its own npm package, not a workspace | none of the runtime workstreams | [extension-and-benchmarks.md](extension-and-benchmarks.md) | legacy. `src/core/{engine,packer,tokenizer,serialize,pyutil}.js` are the ancestors of the runtime's `src/model/*.ts` |
| `bench/` | 5 | jevbench and benchmax pre-registrations, `public/` target and exclusion JSON | none of the runtime workstreams | [extension-and-benchmarks.md](extension-and-benchmarks.md) | legacy |
| `tests/` | 74 | pytest suites for `jev_local` (71 `test_*.py`, `conftest.py`, 2 fixtures) | none of the runtime workstreams | [genclass-model-lineage.md](genclass-model-lineage.md) ("Tests") | legacy |
| `results/` | 3 | Benchmark write-ups (CU head-to-head, jevbench M0, Z-68m notes) | none of the runtime workstreams | [extension-and-benchmarks.md](extension-and-benchmarks.md) | legacy |
| `docs/` | 37 | `docs/runtime/` (4: CONTRACT, API, ARCHITECTURE, RESULTS: the runtime's human docs), `docs/agents/` (21: these docs), `docs/benchmax-research/` (5), 7 legacy jev-local docs | `docs/runtime/CONTRACT.md`: lead. `docs/agents/**`: lead (us). Rest: not recorded / legacy | [status-and-known-issues.md](status-and-known-issues.md) (doc drift tables) | `docs/runtime/`, `docs/agents/`: core. Rest: legacy |

Root files (13):

| file | what | relevance |
|---|---|---|
| `package.json` | private `genclass-lib`, `"type": "module"`, workspaces `packages/*` (runtime and, since the merge, the `genclass-runtime` alias), `sim`, `demos` (not `realapps`, not `extension`, not `training/ortweb`); scripts `build` and `test` (runtime only), `typecheck` (all workspaces); devDep `typescript ~5.9.3`; `engines.node >=20` | core |
| `package-lock.json` | root lockfile, **committed in b435acb** (3,220 lines at f107013; 10e5c3b added the alias workspace); CI runs `npm ci` from it. Update it only with a deliberate `npm install` | core |
| `tsconfig.base.json` | shared TypeScript compiler options | core |
| `.gitignore` | ignore rules (see [section 4](#4-generated-and-ignored-paths)) | core |
| `README.md` | repo landing page: status banner, install, repo map. Says `observe` is the default (Status box and Modes table) | core |
| [`HANDOFF.md`](../../HANDOFF.md) | the colleague's "read this first" for continuing sessions (d73d20c): current state table, repo map, hard rules for the 8 GB Mac and Azure, how to continue. Still says "guard (default)" | core |
| [`OPEN_TASKS.md`](../../OPEN_TASKS.md) | project-level status: done, in progress, next, needs the user, known risks (owner inferred: lead). In the merged tree: r17-v2a and t150-v2a in progress, the one-command install "not in the published `0.1.0-alpha.1`", Next 14 = the next prerelease with it, Polar Parts rollout under Needs the user | core |
| [`RELEASE.md`](../../RELEASE.md) | release procedure for `@genclass/runtime` and `@genclass/runtime-model` (b561244; publish recorded in c16a3b0). Part A (alpha.1) is done; no part yet for the next prerelease with the install | core |
| `LICENSE` | Apache-2.0 | core |
| `pyproject.toml` | Python package `jev-local` 0.1.0 (Python >=3.12,<3.14), console script `jev-local`, pytest config | legacy |
| `BENCHMARKS.md` | public summary of GenClass 0.1 benchmark results | legacy |
| [`AGENTS.md`](../../AGENTS.md), [`CLAUDE.md`](../../CLAUDE.md) | agent entry points (7dab2b3) | — |

## 2. Tree

One line per file for the code that matters most; one line per directory (with tracked-file counts) for legacy areas. Descriptions are summaries; the linked docs have the detail. "(new)" marks files added since 654d822.

### Repo root extras

```text
.github/workflows/ci.yml    (new) CI "@genclass/runtime: typecheck, build, unit tests": push to main/runtime/mvp/mvp-v2,
                            pull_request, workflow_dispatch; ubuntu-latest, Node 22, ONNXRUNTIME_NODE_INSTALL=skip,
                            npm ci, typecheck -w, build -w, vitest excluding test/browser/** and review-perf,
                            then review-perf alone with --retry=2 (NODE_OPTIONS=--expose-gc)
HANDOFF.md                  (new) colleague's continuation guide (state, rules, next steps)
package-lock.json           (new) root lockfile for npm ci
docs/runtime/RESULTS.md     (new) model stages compared, R17 vs R32, why round 1 was timid, never-worse design
                            comparison, demo baseline, data volume, training log summary
```

### `packages/runtime/` package root (10 files, plus `bin/` with 6)

Doc: [runtime/build-test-release.md](runtime/build-test-release.md), [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md).

```text
packages/runtime/
  package.json              @genclass/runtime, version 0.1.0-alpha.1 (0.1.0-beta.0 since 9695830 = published latest); exports . ./auto
                            ./auto/observe ./auto/guard ./auto/heal ./react ./redux ./zustand ./devtools ./worker (no typesVersions);
                            sideEffects [dist/auto.js, dist/auto/*.js, dist/genclass.global{,.min}.js, dist/cdn/*.js, src/model/worker.ts];
                            unpkg/jsdelivr -> dist/genclass.global.min.js; bin genclass-runtime; dep onnxruntime-web ^1.30.0;
                            optional peers react/redux/zustand; scripts build typecheck test test:browser
  tsconfig.json             typecheck project (include src only: tests are never type-checked)
  tsup.config.ts            four configs: ESM (10 entries: index, auto, auto/{observe,guard,heal}, adapters/react|redux|zustand,
                            devtools/index, worker; .d.ts for all but worker); globalBuild(false|true) -> dist/genclass.global{,.min}.js
                            (IIFE, onnxruntime-web external, __GENCLASS_VERSION__ = package version); CDN worker -> dist/cdn/{worker,
                            ort-webgpu,ort-wasm}.js (onnxruntime-web bundled, plugin cdnOrt)
  vitest.config.ts          unit tests: test/**/*.test.ts, excludes test/browser/**, env node, testTimeout 20000
  README.md                 npm package README (rewritten by Mehar, d05abc1): one-command install, observe default, no model yet (at f107013);
                            says init, /auto and the script tag are "not in 0.1.0-alpha.1"
  CHANGELOG.md              (new, f3a9dd1) "## 0.1.0-alpha.1" wrongly lists the install paths (they are not in the published alpha.1)
  INSTALL-NEEDS.md          (new, f3a9dd1) INSTALL -> lead/CORE/MODEL/UI: npx naming decision, package.json and tsup changes,
                            runtime behaviour INSTALL relies on
  STATUS.md                 CORE status: test state (42 files / 348 tests on the VM), "Fix after 0.1.0-alpha.1: two redaction leaks",
                            "Fix after batch 5: situation() purity", never-worse sweep, batch 4/5 notes, headless recipe, trigger table,
                            example situations, deviations, open issues
  UI-NEEDS.md               UI -> CORE request log (partly stale)
  LICENSE                   Apache-2.0
  bin/genclass-runtime.mjs  CLI (Node >= 20, no deps; also `npx @genclass/runtime <cmd>`): init, remove (in bin/lib/),
                            fetch-model <dir> [--from] [--variant q8|fp16|all] [--force] [--quiet], info <dir>
  bin/lib/init.mjs          (new) USAGE, init (detect -> plan -> diff -> confirm -> write -> install), remove (strip markers, delete
                            created files, uninstall if unused); installSpec (@genclass/runtime@^<own version> or --from); flags incl.
                            undocumented --no-sri, --strategy
  bin/lib/detect.mjs        (new) detectProject (framework, entry, package manager, TS), walkSources (SKIP_DIRS, dot-dirs skipped,
                            depth 10, 20,000 files), detectState, htmlModuleEntry
  bin/lib/plan.mjs          (new) AUTO (mode -> import path; treats guard as the default), planInit and one plan per framework (Vite,
                            CRA, webpack-likes, Angular, SvelteKit, Nuxt, Remix/React Router, Next app/pages, Astro, HTML),
                            scriptTag, integrityFor (SRI from the local dist file)
  bin/lib/edit.mjs          (new) MARK "genclass:init", MARK_INLINE "genclass:inline", insertTop, appendEnd, removeMarked, codeStyle
  bin/lib/ui.mjs            (new) colours, symbols, line diff, yes/no prompt
```

### `packages/runtime/src/` (72 files)

```text
packages/runtime/src/
  index.ts                  public facade: GenClass (init/runtime/destroy), createRuntime, re-exports; killSwitch, makeHost, NATIVE_FETCH, ALL_OFF
  runtime.ts                RuntimeImpl: wires every layer; default mode (o.mode ?? "observe"); installObservers, trigger (triage),
                            runDelivery (delivery gate), deliveryHoldable / writesCanAct / finalizeDeliveries (054da38: deliveries
                            that cannot be held are released at once and decided in the background), observeWrite / gateMutation,
                            covered, dropFilter / writtenOver (discard marks), noteResponse, onChannel, markWrites (F9), onDecision,
                            settled points, rollback/revertChain/resync, explain, undo, destroy
  auto.ts                   (new, INSTALL) @genclass/runtime/auto: startAuto() with no defaults (observe), default export = the runtime
  types.ts                  every public and shared type: options (PolicyOptions.holdWrites, observe.untrustedEvents), Runtime,
                            RuntimeEvents, plugins, and the "model seam" (JevState, Question, Answer, EvaluateRequest, DecisionProvider)
                            mirrored by sim/src/types.ts
  errors.ts                 GenClassUnavailableError
  clock.ts                  browserClock (timers captured at module load, afterTask)
  util.ts                   hashing (fnv1a, stableStringify, hashValue), URL signatures (normalizePath, isIdSegment,
                            requestSignature), formatting (secs, rel, fmtNum, truncate), redaction (defaultRedact, isSensitivePath:
                            leaf-based; since f107013 numbers, bigints and arrays under strong secret containers are redacted too)
  cdn/auto-start.ts         (new, INSTALL) startAuto(defaults): meta tag + window.GENCLASS_CONFIG -> GenClass.init, optional devtools
  cdn/auto-observe.ts, cdn/auto-guard.ts, cdn/auto-heal.ts   (new) the /auto/<mode> entries: startAuto({ mode })
  cdn/config.ts             (new) page config: parsePairs, fromPairs, fromDataset, readMetaConfig (every meta[name="genclass"]),
                            readWindowConfig, mergeConfig, splitConfig, devtoolsOptions, isLocalHost, isKilled, whenBody
  cdn/global.ts             (new) script-tag build entry: install (window.GenClass, data attributes, data-manual), assetBase
                            (pins jsDelivr/unpkg URLs to the baked __GENCLASS_VERSION__), blobModuleWorker (Blob-URL module worker)
  cdn/worker.ts             (new) CDN worker entry: imports ../model/worker.js, captures ortWasmPaths (cdnState)
  cdn/ort-env.ts            (new) cdnState, prepareOrt (points ORT's threaded .mjs glue at the wasm directory)
  cdn/ort-webgpu.ts, cdn/ort-wasm.ts  (new) onnxruntime-web wrappers bundled into dist/cdn/
  adapters/react.ts         @genclass/runtime/react: GenClassProvider, useGenClass, useGenClassState, useAtom, useGenClassDecisions/Interventions/Status
  adapters/redux.ts         @genclass/runtime/redux: genclassEnhancer, GENCLASS_REPLACE
  adapters/zustand.ts       @genclass/runtime/zustand: genclass middleware
  decide/decider.ts         DeciderQueue: one request at a time, priority, 32-item cap, answer cache, stale drop, PROVIDER_TIMEOUT_MS, fail-open
  decide/exec.ts            types only: Controller, ActionEffect, NetHost (+ deliver, noteResponse), TriggerOpts, EndOpts
  decide/policy.ts          policyConfig (thresholds, holdWrites), modeAllows, permittedActions, gate (summed-mass rule), RateLimiter, holdBudget
  decide/report.ts          Reporter (console sink, 60 s dedupe), interventionLine, detectionLine, decisionLine
  devtools/index.ts         @genclass/runtime/devtools: mountDevtools, Devtools class (shadow-root overlay, 4 views; mode labels
                            "Observe (default)" / "Guard (opt-in)" / "Heal (experimental)")
  devtools/ui.ts            DOM helper h(), icons, formatting, report-wording templates, activity-event classification
  devtools/css.ts           CSS string with light/dark tokens, applied inside the shadow root
  learn/baselines.ts        Baselines: per-signature latency, outcomes, failure streak, error EWMA, rate, identity gaps (fetch/XHR)
  learn/profiles.ts         Profiles: transition profiles and rarity check (MIN_COMPLETIONS 20, RARE 0.01); also feeds the delivery prediction
  learn/cadence.ts          (new) Cadence, CadenceInfo: learned polling schedule or debounce per request signature (fact F6)
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
  observe/fetch.ts          installFetch: fetch ops, request identity, request gate, failure gate, stall controller; host.deliver for responses
  observe/xhr.ts            installXHR: XMLHttpRequest.prototype patch; request gate; delivery gate for async responses (wraps completion
                            listeners); XHR failures/stalls are detection-only
  observe/messages.ts       (new) MessageGate (per-channel ordered queue, re-dispatch of released messages), MsgHost, messageSummary
  observe/websocket.ts      installWebSocket: WebSocket subclass with a MessageGate; reports channel down/up
  observe/eventsource.ts    (new) installEventSource: EventSource subclass with a MessageGate (observer name "eventsource")
  observe/cache.ts          ResponseCache (GET cache, coalescing table), makeResponse/blockedResponse (x-genclass header)
  observe/dom-user.ts       installDomUser (capture-phase user actions; synthetic events only with observe.untrustedEvents),
                            describeElement, ignoredEvent (data-genclass-ignore); UserAction.clicks (MouseEvent.detail)
  observe/timers.ts         installTimers: setTimeout/setInterval wrappers that carry the ambient op
  observe/nav.ts            installNav: history pushState/replaceState, popstate, hashchange
  observe/storage.ts        installStorage: Storage.prototype setItem/removeItem/clear
  observe/errors.ts         installErrors: error and unhandledrejection listeners
  observe/perf.ts           installPerf: longtask PerformanceObserver
  situation/build.ts        buildSituation: subject sentence, sections, applicable actions (builtinApplicable), questions, salience
  situation/facts.ts        computeFacts per trigger (incl. deliveryFacts), orderFacts, predictedText, MAX_FACTS (12)
  situation/conflicts.ts    (new) predictedWrites, matchFields, newerConflict, pendingConflict, conflictsOn, newerSameSignature, PENDING_WINDOW_MS
  situation/content.ts      (new) response/write content vs store: indexBody, parseJsonBody, analyzeBody, compareField, contentFacts (F1-F3),
                            pendingRevertFacts, createdIds, rywFacts (read-your-writes), RYW_WINDOW_MS
  situation/evidence.ts     (new) markFacts (F9), cadenceFact (F6), scopeFacts and commitAmbiguity (F5), failureOf, repeatEvidence (F7)
  situation/describe.ts     opPhrase, opLabel, userPhrase, statusText, eventLine
  situation/questions.ts    BUILTIN_ACTIONS, TRIGGER_ACTIONS (incl. delivery: deliver/discard/defer), PASSIVE, DEFAULT_DIAGNOSES,
                            buildQuestions, COMPACT_QUESTIONS_BUDGET
  situation/serialize.ts    toJevState, sectionLimits, stateChars, STATE_CHAR_BUDGET (2400) / COMPACT_BUDGET / MIN_BUDGET
  situation/env.ts          SitEnv (read-only runtime view for situation code), SubjectSpec (incl. DeliverySpec), ReqMeta, FailureInfo, Violation
  state/hub.ts              StoreHub: atom/guard/adapter stores, mutation pipeline (holdWrites opt-in), propose -> applyFilter (delivery
                            drop filter), flushQueue, field versions, stale marks and logs, late revert, snapshots
  state/fields.ts           flatten, diffLeaves, deltaOf, changeText, stringDiff (diff-centred previews), redactedStringDiff (f107013:
                            diff only when the redactor leaves both values unchanged; used by changeText and contentFacts),
                            patchValue, cloneValue; MAX_DEPTH, MAX_FIELDS_PER_STORE
  state/invariants.ts       InvariantMiner (9 templates + count-by-group; relation-quality rules (F8); LEARN_AFTER, LEARN_AFTER_NONNULL), expect()
  trace/ops.ts              OpRegistry, OpRec (+ delivery, discardMark)
  trace/context.ts          Context (ambient op: run, stick, isUserSync), LazyOp
  trace/events.ts           EventLog ring buffer
```

Docs by folder: `index.ts`, `runtime.ts`, `types.ts`, `errors.ts`, `clock.ts`, `util.ts` -> [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md); `observe/`, `trace/` -> [runtime/observe-and-trace.md](runtime/observe-and-trace.md); `state/`, `adapters/` -> [runtime/state-and-adapters.md](runtime/state-and-adapters.md); `learn/`, `situation/` and the delivery gate -> [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md); `decide/` and the delivery actions -> [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md); `model/` -> [runtime/model-host.md](runtime/model-host.md); `devtools/` -> [runtime/devtools.md](runtime/devtools.md). `auto.ts`, `cdn/` (INSTALL) have no subsystem doc yet; see [status-and-known-issues.md](status-and-known-issues.md) ("What the merged install paths do", "Install code review"). Everything the model reads is frozen at tag `situation-v2` (6e5e86e): [model-io-contract.md](model-io-contract.md). At f107013, `git diff --stat situation-v2 HEAD -- packages/runtime/src` lists `auto.ts`, `cdn/*`, `devtools/index.ts`, `observe/messages.ts`, `observe/xhr.ts`, `runtime.ts`, `trace/ops.ts`, `types.ts` and three model-visible files changed by the redaction fix f107013: `situation/content.ts`, `state/fields.ts`, `util.ts`.

### `packages/runtime/test/` (95 files)

Doc: [runtime/build-test-release.md](runtime/build-test-release.md) ("Tests" has one row per file with test counts). 39 top-level `*.test.ts` + 6 `model/*.test.ts` + 1 `install/cli.test.ts` = 46 unit test files; the local run on f107013 excluding `review-perf` gave 44 passed + 1 skipped files, 375 passed + 14 skipped tests; `review-perf` alone 4 passed (393 in total).

```text
packages/runtime/test/
  helpers.ts                        core test kit: setup (defaults to mode "guard"; pass mode: undefined for the product default),
                                    FakeClock, FakeServer, ScriptedDecider, defaultScript, ManualDecider, makeGlobal, drain
  adapter-seam.test.ts              rt.adapter(...).propose: reducer preview, held async dispatch, discard, rollback only with io.set
  adapters-react.test.ts            React hooks, with MockRuntime and the real runtime (happy-dom)
  adapters-redux.test.ts            genclassEnhancer: hold/apply once, GENCLASS_REPLACE, replaceReducer
  adapters-zustand.test.ts          genclass middleware: merge semantics, hold/drop, whole-state writes
  ask.test.ts                       ask()/decide() typed answers, GenClassUnavailableError without a model
  atoms.test.ts                     mutation pipeline with holdWrites: user-sync never held, hold/apply, fail-open, late revert, defer
  batch3.test.ts                    SIM requests a-f, ctx.builtin through the gate, GenClass.init never throws, auth-store redaction
  budget.test.ts                    situation budgets, compact questions, auto budget, hold budget; prints example situations
  content.test.ts                   (new) F3 no-call-when-unchanged, F1 field/item cells, F2 diff preview, F9, F6, F5, F7, F8, read-your-writes
  context.test.ts                   causal context: cause/root through fetch, timers, rt.op
  default-mode.test.ts              (new, ours) product default is observe: nothing held or changed; guard/heal opt-in
  delivery.test.ts                  (new) delivery salience and actions over fetch, XHR, WebSocket, EventSource (FakeWS, FakeES, makeXHR)
  devtools-runtime.test.ts          overlay on the real runtime via runStoreSession (happy-dom)
  devtools.test.ts                  overlay vs MockRuntime + loadScenario (happy-dom)
  dom.test.ts                       describeElement, DOM user observer (shadow DOM, nested labels), destroy restores globals (happy-dom)
  fetch.test.ts                     fetch observer: coalesce, block, serve_cached, delay, retry, hedge, cache limits
  invariants.test.ts                InvariantMiner learning, inconsistency once per episode, rollback
  learn.test.ts                     Baselines and Profiles; transition trigger
  nan.test.ts                       (new) no infinite recursion when a store value is NaN (ad24804; the 0.1.0-alpha.1 patch)
  observe-delivery.test.ts          (new, ours, 054da38) observe never holds/delays fetch, XHR, WebSocket, EventSource deliveries;
                                    background delivery decisions recorded; guard unchanged (11 tests)
  no-reorder.test.ts                (new) realworld promise middleware through genclassEnhancer with an always-passive model:
                                    guard/heal give the same dispatches, order and final state as observe
  plugins.test.ts                   plugin facts/diagnoses/actions, ctx.builtin, standing questions, vocabulary
  policy.test.ts                    gate(): summed mass, tiers, thresholds, deny/allow, rate limit, pause
  report.test.ts                    report line format, explain(id), ?genclass=off|heal
  review-actions.test.ts            REVIEW regression (must pass unmodified): error-trigger rollback scope
  review-dom.test.ts                REVIEW: passwords never recorded, programmatic click is not a user action
  review-fetch.test.ts              REVIEW: request identity, coalescing edge cases, buffer limits, keepalive (headless() passes mode "guard")
  review-hub.test.ts                REVIEW: held patches, late-revert undo, deep changes
  review-misc.test.ts               REVIEW: console summaries, read-only fetch, denied heal action, ask after destroy
  review-perf.test.ts               REVIEW: wall-clock cost budgets on 5,000-item stores (run alone in CI; flaky under parallel load)
  review-precision.test.ts          REVIEW: transition/inconsistency false positives
  review-redaction.test.ts          REVIEW: custom redact applies to invariant facts
  review-timers.test.ts             REVIEW: recursive timer loops; gc check needs NODE_OPTIONS=--expose-gc
  review-xhr.test.ts                REVIEW: sync XHR never held, abort while held
  redaction-v2.test.ts              (new, ours, f107013) F2 never diffs redacted text; numbers/bigints/arrays under strong secret
                                    containers redacted (10 tests)
  situation-purity.test.ts          (new, 29b7f28) building situations changes no counter, id, decision or hold (2 tests)
  situation.test.ts                 one situation per trigger: key order and section limits; prints situations
  smoke.test.ts                     atoms, context through real awaits, stale delivery discarded in guard mode (explicit mode "guard")
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
  browser/ui/session.ts             runStoreSession: real createRuntime (explicit mode "guard") under a VirtualClock with a rule-based SessionDecider
  browser/ui/page.ts                fake "Acme" store page for the UI spec (window.__gc)
  browser/ui/screenshots/           18 PNGs: {activity,detections,evidence-answers,evidence,interventions,loading,now,overlay,pill}-{dark,light}.png
  smoke/smoke.sh                    npm pack -> fresh Vite 8 app -> headless Chromium check (run from packages/runtime; ask first)
  install/cli.test.ts               (new, INSTALL) init/remove on fixture projects in temp dirs with --no-install (20 tests; runs in CI);
                                    covers --mode observe only, no case for guard or the default mode
  install/run-all.sh                (new) VM: build + pack -> cli tests -> cdn-check -> scaffold -> frameworks (ask first)
  install/scaffold.sh               (new) VM: scaffold real projects with each framework's generator (network, package managers)
  install/frameworks.mjs            (new) VM: per scaffold init -> build -> Chromium (prod + dev) -> remove -> byte comparison
  install/cdn-check.mjs             (new) VM: script-tag build and /auto in headless Chromium, cross-origin "CDN"
  install/server.mjs                (new) static/CORS server for those checks
  install/RESULTS.md                (new) VM results, recorded against a 0.1.0-alpha.0-versioned tarball of Mehar's tree (guard default)
  install/INSTALL-README-SNIPPET.md (new) README snippet; still says guard is the default
```

The 18 PNGs are written by `ui-devtools.spec.ts`; no README embeds them.

### `packages/runtime-model/` (1 file)

```text
packages/runtime-model/
  MODEL_CARD.md             model card for R17/R32 (sizes, final round 1 on situation-v1, limits); since bcbee89 the card for r17-v2b, published as @genclass/runtime-model@0.1.0
```

### `sim/` (106 files)

Doc: [sim.md](sim.md). Row format: [model-io-contract.md](model-io-contract.md).

```text
sim/
  package.json              @genclass/sim (private); bin genclass-sim -> dist/gen.js; scripts build (tsup + build:model-host) typecheck
                            test gen sample build:runtime-core build:model-host (bundles the runtime's model host into dist/model-host/
                            for --on-policy)
  tsconfig.json             extends ../tsconfig.base.json, noEmit, src + test
  tsup.config.ts            ESM, node22, @genclass/runtime external; entries gen, worker, index, smoke -> dist/
  vitest.config.ts          node env, pool forks, 120 s timeouts
  README.md                 SIM README: commands, row modes, datasets, known limitations
  NEEDS.md                  SIM -> CORE requests (relayed by the lead)
  SEPARABILITY.md           (new) why round-1 R17 recalls few clear cases; proposals T1, S1, S2, F1-F9; first v2 check (§8)
  scripts/final.sh          v1 final datasets on the train VM: final.sh a | b | merge-b (ask first)
  scripts/analyze.py        dataset summary (merged files or parts/), per subject feature, unlabeled diagnosis counts
  scripts/relabel.py        (new) re-derive gold action labels from meta.cost_futures (mirror of actionLabel)
  scripts/separability.py           (new) separability analysis, stage 1 (rows)
  scripts/separability_probe.py     (new) stage 2 (SIM_PROBE=1 probes)
  scripts/separability_extra.py     (new) extra tables
  scripts/separability_gbdt.py      (new) GBDT check
  scripts/cluster/bundle.sh         (new) train VM: tar Node 22, runtime dist, sim/dist (incl. model-host/), scripts for the nodes
  scripts/cluster/orchestrate.sh    (new) colleague's Mac: start/stop/status of node runs (one az call at a time); v1 seed bases
  scripts/cluster/node_start.sh     (new) on a node: fetch the bundle, run gen.js --parts --chunk 100
  scripts/cluster/bigrun.sh         (new) v2 production: start, unl RUN ROWS NODES (16e9), gold RUN ROWS NODES (11e9)
  scripts/cluster/collect.py        (new) pull finished parts, dedupe globally, write gz shards + manifest
  samples/sample.jsonl      200 rows written by gen --sample (v2)
  samples/EXAMPLES.md       pretty-printed example rows (renderExamples)
  samples/sample-stats.json stats of the sample run
  samples/stats-final-a.json stats of SIM v1 final phase A (600,676 rows)
  src/index.ts              library re-exports (buildScenario, runScenario, generateTrajectory, runCost, ...)
  src/types.ts              structural mirror of the runtime model seam + Row/Label (CONTRACT-D)
  src/rng.ts                Rng (sfc32, keyed forks), hash32, hashAll
  src/loop.ts               VirtualLoop: deterministic virtual event loop and clocks
  src/gen.ts                CLI: worker pool, shard merge, stats.json, --sample, --parts, --unlabeled, --on-policy <dir>, --allow-fake
  src/gen/trajectory.ts     generateTrajectory (gold / unlabeled / on-policy), unlabeledTrajectory, pointCosts, diagnosisFromOutcome (S1), S1_GAP
  src/gen/worker.ts         worker_threads worker: seeds -> rows -> shard/part files; loads loadModelDecider once in on-policy mode
  src/gen/examples.ts       renderExamples (EXAMPLES.md)
  src/net/network.ts        Network (latency, chaos, offline windows, push, fetch, S2 latent re-draws), IDEAL_PROFILE, SIM_OP_HEADER
  src/net/server.ts         VirtualServer, Db, API_STYLES
  src/app/env.ts            AppEnv: what generated app programs see (fetch, stores, sockets, timers)
  src/app/feature.ts        FeatureDef contract, UserModel, personas, relations
  src/app/kit.ts            Kit: tagged ops, requests, writes, error surfacing
  src/app/naming.ts         Naming: per-program route/store/field names
  src/app/vocab.ts          DOMAINS: 55 round-1 domain vocabularies
  src/app/vocab2.ts         (new) DOMAINS2: 60 round-2 domains
  src/app/features/index.ts FEATURES (46), FEATURE_WEIGHTS
  src/app/features/common.ts shared feature helpers
  src/app/features/{auth,benign,board,bulk,cart,chat,counter,editor,form,list,nav,poll,search,settings,toggle}.ts
                            the 15 round-1 feature combinators (one FeatureDef each)
  src/app/features/{badge,cascade,cdn,clockskew,countdown,etag,exportjob,facets,flags,graphql,infinite,inventory,
                    longtask,masterdetail,money,multitab,offline,payment,permissions,prefetch,presence,querycache,
                    ratelimit,reorder,saga,schemadrift,swcache,undo,upload,wizard,wsreconnect}.ts
                            (new) the 31 round-2 feature combinators
  src/world/scenario.ts     buildScenario(seed), splitOf, TEST_DOMAINS, TEST_PATTERNS, TEST_FEATURES, chaos profiles, budget sampling
  src/run/rt.ts             realRuntimeFactory (dynamic import of the real runtime), createOptions (mode "heal"; production for on-policy)
  src/run/runner.ts         runScenario: one run (ideal or real), recording / on-policy decider, correlation (incl. delivery), platform
  src/run/latent.ts         (new) S2: FutureSpec, S2 (env SIM_S2), futureProfile, futureStepTimes, REPEAT_PRIOR, idealRepeatSkips
  src/run/onpolicy.ts       (new) loadModelDecider(modelDir): the runtime's model host in Node on onnxruntime-web WASM (DAgger)
  src/run/fake-runtime.ts   createFakeRuntime: test double only (rows marked meta.runtime "fake")
  src/run/transform.ts      transformQuestions (shuffle/drop action options), ACTION_PARA
  src/oracle/knowledge.ts   Knowledge: ground-truth bookkeeping (intents, sim ops, sim writes with verdicts)
  src/oracle/diagnose.ts    diagnose, diagnoseFailure: diagnosis labels
  src/oracle/cost.ts        W (cost weights), LABEL, TIER, runCost, actionLabel
  src/oracle/probe.ts       (new) separability probes, analysis only (SIM_PROBE=1)
  src/ask/questions.ts      askQuestions: programmatic ask generators with exact labels
  src/dev/smoke.ts          dev tool: base runs on many seeds, prints raw situations
  test/helpers.ts           testFactory (SIM_RUNTIME=real -> real runtime, else fake), mini scenario builder
  test/loop.test.ts         VirtualLoop ordering, Response bodies, rng forks
  test/determinism.test.ts  same seed -> identical rows; replay reproduces every prefix
  test/rows.test.ts         valid CONTRACT-D rows; splits and transform
  test/oracle.test.ts       diagnosis and cost/label cases (some are real-runtime only)
  test/latent.test.ts       (new) S2 latent re-draws
```

Check run on b435acb when these docs were written: `SIM_RUNTIME=real npx vitest run` in `sim/` gives 19 passed (5 files); `tsc` clean. `sim/` is unchanged since b435acb (not rerun at f107013; the sim pins `mode: "heal"`, so 054da38's observe change does not reach it, but a heal-mode delivery that cannot be held is now released before its body read).

### `realapps/` (307 files)

Doc: [realapps.md](realapps.md). Not a root workspace, no tsconfig, no tests, not in CI; everything real needs Chromium (ask first).

```text
realapps/
  package.json              @genclass/realapps 0.0.0 (private); scripts build (node build.mjs), gen (node dist/harness/gen.js), build:runtime;
                            devDeps playwright 1.63.0, esbuild, esbuild-svelte and every framework the apps use
  .gitignore                node_modules/ dist/ src/harness/apps.gen.ts
  build.mjs                 esbuild: world IIFE (dist/world.js), harness (dist/harness/{gen,worker,debug}.js), manifest registry,
                            every esbuild-built app; RW_RUNTIME_SRC / RW_RUNTIME_TAG pin the runtime (default: working tree,
                            tag "working-tree"); writes dist/runtime-tag.txt
  README.md                 design document (corpus, integration, determinism, labels, row kinds, splits, run commands, v1 pilot numbers);
                            still says 66 apps (128 app directories now)
  EXAMPLES.md               13 audited rows from the v1 pilot
  apps/README.md            authoring guide for app-writing agents (written for the colleague's Mac and branch runtime)
  apps/_shared/             12 files: genclass.ts (one-line integration: GenClass.init(window.__GENCLASS_INIT__ ?? {}), flag()),
                            {vue,svelte,solid,preact,lit}-atom.ts, lit-toast.ts, hyperapp-guard.ts, react-genclass-reducer.ts,
                            w3-http.ts, conduit-manifest.ts (conduitManifest for the 14 OSS apps), onnx-stub.ts (aliased for onnxruntime-web)
  apps/<name>/              128 apps at f107013 (91 at b435acb; the merge added waves 3 and 4): manifest.ts (AppManifest) + source
                            (the 14 oss-*-conduit apps have a manifest only). The name list below is from b435acb; newer apps add
                            more of the same stacks (backbone-*, knockout-*, valtio-*, xstate-*, vue-*, svelte-*, vanilla-*, ...). Names: actions-comments, alpine-*, backbone-*, effector-iot,
                            htm-iot-dashboard, hyperapp-*, jotai-planner, jquery-*, knockout-*, ky-banking, lit-*, mithril-*, mobx-*,
                            nano-notifications, ofetch-clinic, oss-{angular,angularjs,elm,ember,halogen,mobx,react-redux,rescript,rtk,
                            solid,svelte,vue2,vue3,wc}-conduit, petite-*, pinia-*, preact-*, react-*, reducer-inbox, router-crm, rtk-*,
                            rtkq-helpdesk, rx-*, saga-chat, solid-*, superagent-*, svelte-*, swr-status, valtio-ledger, vanilla-*,
                            vue-*, wc-weather-alerts, wretch-pharmacy, xhr-autocomplete, xstate-checkout, zustand-*
  corpus/oss.json           the 14 open-source apps: repo, pinned commit, build kind, deps, licence
  corpus/LICENSES.md        OSS licences
  corpus/prepare_oss.sh     VM: clone + install + patch + build each OSS app into dist/apps/<name>/ ($RW_OSS_DIR, default ~/gcl/real-cache/oss)
  corpus/patch_oss.py       the GenClass integration added to each OSS app
  corpus/rebundle.mjs, build_angularjs.mjs, vite.oss.config.mjs   OSS build helpers
  src/world/index.ts        in-page world entry (IIFE injected before page scripts): loop, network, server, user, probe; window.__RW.start()
  src/world/loop.ts         virtual time (timers, rAF, MessageChannel, postTask, Date, performance.now, seeded randomness)
  src/world/net.ts          in-page fetch / XHR / WebSocket on virtual time with chaos draws
  src/world/netapi.ts       installs them; sets window.EventSource = undefined (the runtime's eventsource observer never installs)
  src/world/server.ts       mock backend (collections, versions/409, idempotency replay, auth, replica lag, live topics)
  src/world/ext/conduit.ts  RealWorld (Conduit) API extension
  src/world/user.ts         scripted user (untrusted events, intent pinning)
  src/world/probe.ts        Probe: recording DecisionProvider, hooks, store-snapshot plugin, DOM snapshots, in-page diagnosis call
  src/world/diagnose.ts     diagnose: in-page diagnosis rules (incl. the v2 delivery trigger)
  src/harness/scenario.ts   buildScenario(seed, apps, opts), splitOf, TEST_FRAMEWORKS, TEST_APPS, TEST_PATTERNS
  src/harness/trajectory.ts generateTrajectory (ideal, base, counterfactuals, prefix check, labels, row kinds); OBSERVE, runConfig, RUNTIME_TAG
  src/harness/cost.ts       runCost, states, serverDist, relationBroken (mirrors sim/src/oracle/cost.ts)
  src/harness/labels.ts     finishDiagnosis, duplicateKeys
  src/harness/browser.ts    Runner: one headless Chromium per worker, fresh page per run, ORIGIN https://app.example.com
  src/harness/gen.ts        resumable generator (worker pool, per-split JSONL, done.txt, stats.json, manifest.json); --out required
  src/harness/worker.ts     worker process (RW_PORT, RW_OPTS)
  src/harness/debug.ts      inspection CLI: one scenario, --twice, --traj, --force k:action, --det (determinism sweep),
                            --interference (never-worse sweep), --clean
  src/shared/manifest.ts    AppManifest, Affordance, Relation
  src/shared/types.ts       RunConfig, RunResult, ServerSpec, Step, DecisionRec
  src/shared/routes.ts      endpointsOf
  scripts/analyze.py        batch stats + comparison with sim/samples/stats-final-a.json
  scripts/evalset.py        builds <out>/real_eval.jsonl + manifest.json (unambiguous real-app eval set)
  scripts/examples.py       row pretty-printer for audits
  scripts/chromium_probe.mjs measures the Chromium event-loop facts the loop relies on
  scripts/node_setup.sh     VM setup: Node 22.22.0, npm install, Playwright chromium_headless_shell, pinned runtime, prepare_oss, build
  scripts/cluster.sh        Mac-side ssh/rsync helper: sync, setup, run (detached gen.js into ~/gcl/real-out/<name>), status, stop
```

### `training/` (69 files)

Doc: [training.md](training.md). Every script here runs on Azure VMs; ask before running any of them.

```text
training/
  README.md                 overview and reproduce commands (partly stale)
  PLAN-v1.md                (new) the scaled program: targets, data, models R17/R32/R68/T150/T400, phases P0-P5, costs, eval, risks
  LOG.md                    dated run log (what ran where, throughput, costs, decisions) up to the r17-v2a / t150-v2a launches (05:22 UTC)
  EVAL.md                   metric definitions and results (baseline, stage 1c, sizes/latency, stage-2 pilot, final round 1)
  NEEDS.md                  TRAIN requests to SIM / CORE / MODEL / REAL; node claims (TRAIN: c02 workbench, r17-v2a, t150-v2a); v2 data
                            locations; item 16: use REAL v2c1..v2c4, not v2b*
  prune_vocab.py            prune/analyze: keep the first N BPE merges (16,000 -> 16,364 tokens) of a checkpoint or HF base
  eval_runtime.py           accuracy, NLL/Brier/ECE, temperature fit (calibration.json), CONTRACT §8 gate metrics, SIM cost regret
  eval_gain.py              (new) T1 expected-gain evaluation of gate policies from cached logits
  export_runtime.py         checkpoint -> q8/fp16 ONNX + model.json/meta.json/calibration.json/tokenizer.json + parity fixtures
  report.py                 Markdown tables for EVAL.md from eval reports
  label_teacher.py          (new) teacher soft-labelling of CONTRACT-D rows (calibrated dist labels, meta.teacher), resumable
  label_cluster.sh          (new) teacher labelling across nodes (serves teacher + shards on :8805); untested
  t1_relabel.py             (new) T1: expected-advantage action labels or gain targets from meta.cost_futures
  collect_gain.py           (new) logits + gain-head predictions; needs the parent-repo jev_local gain head
  t1_post.sh, t1h_post.sh   (new) post-run eval of T1 / gain-head runs on the rank-0 node
  configs/mix_s1.json       mixture configs read by jev_local/train/stream.py MixConfig
  configs/mix_s1b.json
  configs/mix_s1c.json
  configs/mix_s2.json
  configs/mix_final1.json
  configs/mix_t150.json     (new) teacher (v1 buckets simA .9, cur4 .1)
  configs/mix_r68.json      (new) R68 student benchmark (never run)
  configs/mix_t1a.json, mix_t1b.json, mix_t1h.json   (new) T1 runs (simAg10 / simAg20 / simAh)
  configs/mix_v2a.json      (new, eff18cb) r17-v2a: sim2 .86, cur5 .11, cur1 .02, gen .01; 500M tokens per pass
  configs/mix_t150v2.json   (new, eff18cb) t150-v2a teacher: sim2 .9, cur5 .1
  import_v2.sh              (new, eff18cb) v2 import from the Mac: serve a collected SIM batch, then on the workbench (c02) download gz
                            shards, prep_v2.py, the cur5 curriculum replay (300k, 80% runtime-exact), tar served on WB:8799 (Azure)
  prep_v2.py                (new) collected SIM gz shards -> train shards + eval sets (sim2, sim2e, sim2f held-out features)
  v2_node_setup.sh          (new) prepare one node for v2 training (sync code, pull the v2 data tar from the workbench)
  v2_post.sh                (new) detached on a v2 run's rank-0 node: wait for final, eval_sim on sim2e and sim2f, eval_gain, export
                            with the sim2e calibration, serve the tar on :8801 (runs for r17-v2a on c09)
  import_real.sh            (new) REAL v2 batches -> data/s3/real2 shards, real2e eval sets, realev (REAL's unambiguous eval set)
  eval_real.py              (new) REAL eval set under the runtime gate (rows with meta.eval_case / eval_expect)
  curriculum/__init__.py    package docstring
  curriculum/generate.py    seeded parallel curriculum generator (CONTRACT-D jsonl + stats.json); --p-runtime -> GC_P_RUNTIME
  curriculum/rt.py          Python port of packages/runtime/src/situation/* (runtime-exact rows); "FROZEN at git tag situation-v2"
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
  tests/test_curriculum.py  pytest: curriculum validity, held-out splits, label consistency, v2 runtime rows (pure Python part runs locally)
  tests/test_prune_vocab.py pytest (VM; GC_V1_CKPT, GC_BASE_32M): pruned tokenizer and logits parity
  tests/test_export_runtime.py pytest (VM; GC_R17_INIT): int8 embeddings, Gemm->MatMul, end-to-end export
  node.sh                   ssh/rsync wrapper for Azure hosts: node.sh HOST sync|'cmd'|get R L|put L R
  node_init.sh              (new) fresh node: pull the node kit tar, install ONNX tooling, check torch
  cluster_expand.sh         (new) create extra F80 nodes (c12-c23 on 2026-10-08), append to azure_hosts, Disabled shutdown schedule
  import_sim.sh             pull a SIM run to c01 and shard it (stage 2)
  import_final.sh           pull a frozen SIM run (plain jsonl; cannot read v2 gz shards), shard, build eval subsets, bundle for nodes
  launch_s2.sh              launch stage-2 pilot runs (R32, R17)
  launch_final1.sh          launch final round 1: launch_final1.sh R32_PASSES R17_PASSES
  launch_student.sh         (new) generic DDP launcher: launch_student.sh RUN ARCH PASSES MIX "nodes" [INIT] [-- extra]
  launch_t150.sh            (new) T150 teacher launcher
  launch_r68.sh             (new) R68 benchmark launcher
  final_post.sh             on a rank-0 node: SIM eval -> export -> serve tar on :8801 (hard-wired to the v1 simAe eval set)
  eval_sim.sh               sharded logit collection + one SIM eval per model
  run_evals.sh              stage-1 eval batch on c01
  pull_ckpt.sh              copy a servable checkpoint from a node to c01
  pull_on_train.sh          on the train VM: fetch an export tar, sha256 check, run validate.mjs
  deliver_final.sh          from the Mac: same delivery, driven remotely
```

### `demos/` (133 files)

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
  results.md                latest results (v0.1 model on the frozen situation-v1 runtime, 04a264f)
  results.json              raw trials (large)
  results-summary.json      summary shipped with the site
  screenshots/              31 PNGs (see below)
```

`demos/src/` (76 files, unchanged since 654d822):

```text
demos/src/
  shared/genclass.ts        startGenClass: the only place the demos create the runtime; collectStats, statusText
  shared/settings.ts        URL params and localStorage: getMode, modelBaseUrl, trialParams, traceOn, holdBudget
  shared/chaos.ts           chaos model: RouteChaos, PRESETS, resolveChaos, sampleTiming
  shared/scenario-kit.ts    typing rhythm (typeSteps), sampleChaos, CLEAN_CHAOS
  shared/types.ts           GcMode, Step, Scenario, Score, TrialResult
  shared/demo-def.ts        DemoDefinition, AppContext, OracleContext, Oracle
  shared/driver.ts          runSteps: synthetic in-page user (untrusted events: not recorded unless observe.untrustedEvents)
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

`demos/src/server/data/cities.ts` is imported but not in git (the root `.gitignore` rule `data/` matches it), so a fresh clone cannot build the Service Worker or the search demo. See [demos.md](demos.md) ("Drift and open issues"). The demos site creates the runtime with `startGenClass`, which passes an explicit mode, so the default-mode change does not affect it; its in-page synthetic driver dispatches untrusted events, which situation-v2 no longer records unless `observe.untrustedEvents` is set.

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

### `docs/` (37 tracked files)

```text
docs/
  runtime/CONTRACT.md       binding runtime contract (lead); §13 records the default-mode change (f3636b2)
  runtime/API.md            public API reference (default mode observe since f3636b2)
  runtime/ARCHITECTURE.md   architecture overview
  [runtime/RESULTS.md](../runtime/RESULTS.md) (new) results, comparisons and training-log summary; "update it with every result" (HANDOFF)
  agents/                   these docs: README, overview, repo-map, glossary, playbooks, status-and-known-issues, model-io-contract,
                            genclass-model-lineage, extension-and-benchmarks, demos, sim, training, realapps, runtime/ (8 docs)
  benchmax-research/        5 planning notes (read-only background)
  SPEC.md, CONTRACT.md, CONTRACT-v2.md, DEMO.md, GENCLASS.md, COMPARISON.md, PLAN-excel.md   legacy jev-local docs
```

### Legacy directories (one line per directory)

Doc for `jev_local/`, `tests/` and `docs/` legacy files: [genclass-model-lineage.md](genclass-model-lineage.md). Doc for `extension/`, `bench/`, `results/`, `docs/benchmax-research/`: [extension-and-benchmarks.md](extension-and-benchmarks.md). All unchanged since 654d822.

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
results/                                  3  genclass-vs-jev-computer-use.md, jevbench-m0.md, z68m-dev-notes.md
demos/screenshots/                       31  <demo>.png, <demo>-dark.png, <demo>-full.png and <demo>-page.png for board, checkout,
                                             decisions, editor, status, search; decisions-heal.png (new); index{,-dark,-full,-mobile}.png;
                                             search-mobile.png, search-trials.png. Written by demos/e2e/eval.ts (npm run shots)
```

## 3. Where is X?

Verified with `grep` at b435acb; rows touched by the merge and the two fixes re-checked at f107013. Methods are `RuntimeImpl.<name>` in `packages/runtime/src/runtime.ts` unless stated.

### Runtime public API, options and lifecycle

| X | kind | where | doc |
|---|---|---|---|
| `GenClass` (browser singleton: `init`, `runtime`, `destroy`) | symbol | `packages/runtime/src/index.ts` -> `GenClass` | [public-api](runtime/public-api-and-lifecycle.md) |
| `createRuntime` (headless entry point) | symbol | `packages/runtime/src/index.ts` -> `createRuntime` | [public-api](runtime/public-api-and-lifecycle.md) |
| **Default mode `observe`** (`o.mode ?? "observe"`, f3636b2) | code | `RuntimeImpl` constructor; `packages/runtime/src/types.ts` -> `InitOptions.mode` (JSDoc); test `packages/runtime/test/default-mode.test.ts` | [public-api](runtime/public-api-and-lifecycle.md), [decide-policy](runtime/decide-policy-actions.md) |
| Kill switch `?genclass=off\|observe\|guard\|heal` / `localStorage.genclass` | URL param, storage key | `packages/runtime/src/index.ts` -> `killSwitch` | [public-api](runtime/public-api-and-lifecycle.md) |
| Owned model host built by `createRuntime` | symbol | `packages/runtime/src/index.ts` -> `makeHost` | [model-host](runtime/model-host.md) |
| Un-observed fetch used for model downloads | constant | `packages/runtime/src/index.ts` -> `NATIVE_FETCH` | [observe-and-trace](runtime/observe-and-trace.md) |
| All-observers-off map (inert runtime) | constant | `packages/runtime/src/index.ts` -> `ALL_OFF` | [public-api](runtime/public-api-and-lifecycle.md) |
| `RuntimeImpl` (implements every `Runtime` method) | class | `packages/runtime/src/runtime.ts` -> `RuntimeImpl` | [public-api](runtime/public-api-and-lifecycle.md) |
| `InitOptions` (`mode`, `model`, `decider`, `observe` incl. `untrustedEvents`, `policy`, `report`, `triage`, `settleMs`, `historySize`, `situation`, ...) | type | `packages/runtime/src/types.ts` -> `InitOptions` | [public-api](runtime/public-api-and-lifecycle.md) |
| `CreateOptions` (adds `clock`, `global`, `app`, `hooks`) | type | `packages/runtime/src/types.ts` -> `CreateOptions` | [public-api](runtime/public-api-and-lifecycle.md) |
| `ModelOptions` (`baseUrl`, `preload`, ...) | type | `packages/runtime/src/types.ts` -> `ModelOptions` | [model-host](runtime/model-host.md) |
| `PolicyOptions` (`thresholds`, `holdBudgetMs`, `allow`, `deny`, `holdUserWrites`, `holdWrites`, `requireDiagnosis`, `maxActionsPerMinute`) | type | `packages/runtime/src/types.ts` -> `PolicyOptions` | [decide-policy](runtime/decide-policy-actions.md) |
| `Runtime` interface | type | `packages/runtime/src/types.ts` -> `Runtime` | [public-api](runtime/public-api-and-lifecycle.md) |
| `RuntimeEvents` (decide, detect, act, report, event, status) | type | `packages/runtime/src/types.ts` -> `RuntimeEvents` | [public-api](runtime/public-api-and-lifecycle.md) |
| `Plugin` / `PluginApi` | type | `packages/runtime/src/types.ts` -> `Plugin`, `PluginApi` | [public-api](runtime/public-api-and-lifecycle.md) |
| `Decision`, `ActionRecord` (incl. `dropped` for delivery discards) | type | `packages/runtime/src/types.ts` -> `Decision`, `ActionRecord` | [decide-policy](runtime/decide-policy-actions.md) |
| `DecisionProvider`, `EvaluateRequest` (model seam) | type | `packages/runtime/src/types.ts` -> `DecisionProvider`, `EvaluateRequest` | [model-io-contract](model-io-contract.md) |
| `JevState`, `TriggerKind` (incl. `delivery`) | type | `packages/runtime/src/types.ts` -> `JevState`, `TriggerKind` | [model-io-contract](model-io-contract.md) |
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
| Background decision deadline (5 s) | constant | `packages/runtime/src/runtime.ts` -> `BACKGROUND_DEADLINE_MS` | [decide-policy](runtime/decide-policy-actions.md) |
| In-flight age that blocks settled points (10 s) | constant | `packages/runtime/src/runtime.ts` -> `LONG_RUNNING_MS` | [state-and-adapters](runtime/state-and-adapters.md) |
| Console line `[GenClass] Model unavailable (...); observing only.` | string | `packages/runtime/src/runtime.ts` -> `RuntimeImpl` constructor (status subscription) | [status](status-and-known-issues.md) |

### Install paths (INSTALL, f3a9dd1; not in the published `0.1.0-alpha.1`)

| X | kind | where | doc |
|---|---|---|---|
| `import "@genclass/runtime/auto"` (observe on this branch) | entry | `packages/runtime/src/auto.ts`; `packages/runtime/src/cdn/auto-start.ts` -> `startAuto` | [status](status-and-known-issues.md) |
| `/auto/observe`, `/auto/guard`, `/auto/heal` | entry | `packages/runtime/src/cdn/auto-observe.ts`, `auto-guard.ts`, `auto-heal.ts` | [status](status-and-known-issues.md) |
| Page config (`<meta name="genclass">`, `window.GENCLASS_CONFIG`, `data-*`) | function | `packages/runtime/src/cdn/config.ts` -> `readMetaConfig`, `readWindowConfig`, `fromDataset`, `fromPairs`, `mergeConfig` | [status](status-and-known-issues.md) |
| Script-tag build (`window.GenClass`) and its asset base | function | `packages/runtime/src/cdn/global.ts` -> `install`, `assetBase`, `blobModuleWorker`; build `packages/runtime/tsup.config.ts` -> `globalBuild` | [status](status-and-known-issues.md) |
| CDN model worker and ORT glue | file, function | `packages/runtime/src/cdn/worker.ts`; `packages/runtime/src/cdn/ort-env.ts` -> `prepareOrt`, `cdnState` | [model-host](runtime/model-host.md) |
| `npx @genclass/runtime init` / `remove` | CLI | `packages/runtime/bin/lib/init.mjs` -> `init`, `remove`, `USAGE` | [status](status-and-known-issues.md) |
| Mode -> import path (guard treated as default: install finding 1) | function | `packages/runtime/bin/lib/plan.mjs` -> `AUTO`, `scriptTag`, `integrityFor` | [status](status-and-known-issues.md#install-code-review-2026-10-08) |
| Framework / entry detection | function | `packages/runtime/bin/lib/detect.mjs` -> `detectProject`, `walkSources` | [status](status-and-known-issues.md#install-code-review-2026-10-08) |
| Edit markers `genclass:init` / `genclass:inline` and their removal | constant, function | `packages/runtime/bin/lib/edit.mjs` -> `MARK`, `MARK_INLINE`, `removeMarked` | [status](status-and-known-issues.md#install-code-review-2026-10-08) |
| Unscoped alias `npx genclass-runtime` (unpublished) | file | `packages/genclass-runtime/cli.mjs` | [status](status-and-known-issues.md) |

### Delivery decisions (situation-v2, batches 4 and 5)

| X | kind | where | doc |
|---|---|---|---|
| **The delivery trigger / gate** (pre-filter, body read, hold, actions) | method | `RuntimeImpl.runDelivery` (public member) |
| Can this delivery be held? (false in observe, while paused, model not ready, nothing permitted, model too slow) | method | `RuntimeImpl.deliveryHoldable`; `RuntimeImpl.writesCanAct`; `RuntimeImpl.finalizeDeliveries` (decide a released fetch delivery at its chain's first write) (054da38) | [decide-policy](runtime/decide-policy-actions.md) | [learn-situation-triage](runtime/learn-situation-triage.md), [decide-policy](runtime/decide-policy-actions.md) |
| Body wait for salience (100 ms) | constant | `packages/runtime/src/runtime.ts` -> `BODY_WAIT_MS` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Discard mark lifetime (10 s) and the drop filter | constant, method | `packages/runtime/src/runtime.ts` -> `DISCARD_MARK_MS`; `RuntimeImpl.dropFilter`, `RuntimeImpl.writtenOver`, `RuntimeImpl.onDropped`; `packages/runtime/src/state/hub.ts` -> `StoreHub.propose` (calls the private `applyFilter`) | [decide-policy](runtime/decide-policy-actions.md), [state-and-adapters](runtime/state-and-adapters.md) |
| Discard mark on the op (`discardMark`) and the delivery record (`delivery`) | type | `packages/runtime/src/trace/ops.ts` -> `OpRec` | [observe-and-trace](runtime/observe-and-trace.md) |
| Non-blocking `mutation` trigger (default) | method | `RuntimeImpl.observeWrite` | [decide-policy](runtime/decide-policy-actions.md) |
| Held `mutation` (opt-in `policy.holdWrites`) | method | `RuntimeImpl.gateMutation`; `packages/runtime/src/state/hub.ts` -> `StoreHub.holdWrites`, `StoreHub.flushQueue` | [state-and-adapters](runtime/state-and-adapters.md) |
| Writes covered by a delivery decision (no mutation trigger) | method | `RuntimeImpl.covered` | [decide-policy](runtime/decide-policy-actions.md) |
| Hold only if the model is fast enough | method | `RuntimeImpl.expectedLatency` (compared with `holdBudgetMs()` in `trigger`) | [decide-policy](runtime/decide-policy-actions.md) |
| Delivery `defer` waits | method | `RuntimeImpl.waitOps` | [decide-policy](runtime/decide-policy-actions.md) |
| Stale marks (F9) set on writes | method | `RuntimeImpl.markWrites`, `RuntimeImpl.onChannel` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Create responses recorded for read-your-writes | method | `RuntimeImpl.noteResponse` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Push-channel delivery gate (WebSocket/EventSource) | class | `packages/runtime/src/observe/messages.ts` -> `MessageGate`, `MsgHost`, `messageSummary` | [observe-and-trace](runtime/observe-and-trace.md) |
| EventSource observer (observer name `eventsource`) | function | `packages/runtime/src/observe/eventsource.ts` -> `installEventSource` | [observe-and-trace](runtime/observe-and-trace.md) |
| `DeliverySpec` (subject of a delivery trigger) | type | `packages/runtime/src/situation/env.ts` -> `DeliverySpec` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Predicted write set and conflicts (newer data, pending local change; 10 s window) | function, constant | `packages/runtime/src/situation/conflicts.ts` -> `predictedWrites`, `newerConflict`, `pendingConflict`, `conflictsOn`, `PENDING_WINDOW_MS` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Body vs store comparison, facts F1-F3, read-your-writes | function | `packages/runtime/src/situation/content.ts` -> `analyzeBody`, `compareField`, `contentFacts`, `pendingRevertFacts`, `createdIds`, `rywFacts` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Evidence facts F5, F6, F7, F9 | function | `packages/runtime/src/situation/evidence.ts` -> `scopeFacts`, `commitAmbiguity`, `cadenceFact`, `repeatEvidence`, `markFacts` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Learned cadence (schedule / debounce) | class | `packages/runtime/src/learn/cadence.ts` -> `Cadence`, `CadenceInfo` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Delivery facts and the trigger sentence's prediction text | function | `packages/runtime/src/situation/facts.ts` -> `computeFacts` (internal `deliveryFacts`), `predictedText` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Delivery actions `deliver` / `discard` / `defer` | constant | `packages/runtime/src/situation/questions.ts` -> `TRIGGER_ACTIONS.delivery`, `PASSIVE.delivery` | [decide-policy](runtime/decide-policy-actions.md) |
| Relation quality (F8) and count-by-group invariants | class | `packages/runtime/src/state/invariants.ts` -> `InvariantMiner` | [state-and-adapters](runtime/state-and-adapters.md) |
| Diff-centred string previews (F2, timeline, deltas); only for values the redactor leaves unchanged (f107013) | function | `packages/runtime/src/state/fields.ts` -> `stringDiff`, `redactedStringDiff`, `changeText` | [learn-situation-triage](runtime/learn-situation-triage.md) |

### Observers and trace

| X | kind | where | doc |
|---|---|---|---|
| fetch wrapper, request/failure gates, stall controller, response delivery | function | `packages/runtime/src/observe/fetch.ts` -> `installFetch` | [observe-and-trace](runtime/observe-and-trace.md) |
| Max request body hashed for identity (64 KiB) | constant | `packages/runtime/src/observe/fetch.ts` -> `IDENTITY_BODY_MAX` | [observe-and-trace](runtime/observe-and-trace.md) |
| XHR patch (request gate, delivery gate for async responses) | function | `packages/runtime/src/observe/xhr.ts` -> `installXHR` | [observe-and-trace](runtime/observe-and-trace.md) |
| DOM user-action observer | function | `packages/runtime/src/observe/dom-user.ts` -> `installDomUser` | [observe-and-trace](runtime/observe-and-trace.md) |
| `observe.untrustedEvents` (default `false`: synthetic DOM events are not user actions) | option | `packages/runtime/src/types.ts` -> `InitOptions.observe`; read in `RuntimeImpl.installObservers`; applied in `packages/runtime/src/observe/dom-user.ts` -> `installDomUser` | [observe-and-trace](runtime/observe-and-trace.md) |
| `describeElement` (public helper) | function | `packages/runtime/src/observe/dom-user.ts` -> `describeElement` | [observe-and-trace](runtime/observe-and-trace.md) |
| `data-genclass-ignore` attribute handling | attribute | `packages/runtime/src/observe/dom-user.ts` -> `ignoredEvent` | [devtools](runtime/devtools.md) |
| WebSocket, EventSource, timers, nav, storage, errors, longtask observers | function | `packages/runtime/src/observe/{websocket,eventsource,timers,nav,storage,errors,perf}.ts` -> `installWebSocket`, `installEventSource`, `installTimers`, `installNav`, `installStorage`, `installErrors`, `installPerf` | [observe-and-trace](runtime/observe-and-trace.md) |
| GET cache and coalescing table | class | `packages/runtime/src/observe/cache.ts` -> `ResponseCache` | [observe-and-trace](runtime/observe-and-trace.md) |
| Cache limits (`MAX_BODY` 256 KB, `MAX_ENTRIES` 64, `COALESCE_WINDOW_MS` 2000) | constant | `packages/runtime/src/observe/cache.ts` | [observe-and-trace](runtime/observe-and-trace.md) |
| `x-genclass: blocked\|cached\|coalesced` response header | header | `packages/runtime/src/observe/cache.ts` -> `makeResponse`, `blockedResponse` | [observe-and-trace](runtime/observe-and-trace.md) |
| Op registry and `OpRec` | class, type | `packages/runtime/src/trace/ops.ts` -> `OpRegistry`, `OpRec` | [observe-and-trace](runtime/observe-and-trace.md) |
| Ambient op, `LazyOp` | class | `packages/runtime/src/trace/context.ts` -> `Context`, `LazyOp` | [observe-and-trace](runtime/observe-and-trace.md) |
| Event ring buffer | class | `packages/runtime/src/trace/events.ts` -> `EventLog` | [observe-and-trace](runtime/observe-and-trace.md) |
| Op signature normalisation (`GET /api/items/:id`) | function | `packages/runtime/src/util.ts` -> `normalizePath`, `isIdSegment`, `requestSignature` | [observe-and-trace](runtime/observe-and-trace.md) |
| Hashing | function | `packages/runtime/src/util.ts` -> `fnv1a`, `stableStringify` | [public-api](runtime/public-api-and-lifecycle.md) |
| Default redaction (leaf-name based; numbers/bigints/arrays under strong secret containers since f107013) | function | `packages/runtime/src/util.ts` -> `defaultRedact`, `isSensitivePath` | [learn-situation-triage](runtime/learn-situation-triage.md) |

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

### Learn, situation and questions (frozen at `situation-v2`)

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
| Budgets 2,400 / 1,100 / 500 chars (full was 3,200 in v1) | constant | `packages/runtime/src/situation/serialize.ts` -> `STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `MIN_BUDGET` | [model-io-contract](model-io-contract.md) |
| Read-only runtime view for situation code; trigger subjects | type | `packages/runtime/src/situation/env.ts` -> `SitEnv`, `SubjectSpec` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Op phrasing in situations and `changed` sentences | function | `packages/runtime/src/situation/describe.ts` -> `opPhrase` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Python port of the situation text | function | `training/curriculum/rt.py` -> `render` | [training](training.md) |
| Freeze marker | git tag | `situation-v2` (6e5e86e; the v2 data's format); `situation-v2.1` (5bc40c9, on `origin/runtime` only); `situation-v1` (1a77558; old format). Check with `git diff situation-v2 HEAD -- packages/runtime/src/situation packages/runtime/src/learn packages/runtime/src/util.ts packages/runtime/src/state/fields.ts` (empty at b435acb; at f107013 it shows the redaction fix in `content.ts`, `fields.ts`, `util.ts`) | [model-io-contract](model-io-contract.md) |

### Decide, policy and reports

| X | kind | where | doc |
|---|---|---|---|
| Decision queue | class | `packages/runtime/src/decide/decider.ts` -> `DeciderQueue` | [decide-policy](runtime/decide-policy-actions.md) |
| Runtime-side provider timeout (10 s) | constant | `packages/runtime/src/decide/decider.ts` -> `PROVIDER_TIMEOUT_MS` | [decide-policy](runtime/decide-policy-actions.md) |
| Summed-mass gate (CONTRACT §8) | function | `packages/runtime/src/decide/policy.ts` -> `gate` | [decide-policy](runtime/decide-policy-actions.md) |
| Default thresholds (report 0.6, guard 0.9, heal 0.8) | config | `packages/runtime/src/decide/policy.ts` -> `policyConfig` | [decide-policy](runtime/decide-policy-actions.md) |
| Mode -> permitted tiers | function | `packages/runtime/src/decide/policy.ts` -> `modeAllows`, `permittedActions` | [decide-policy](runtime/decide-policy-actions.md) |
| Hold budget (auto: clamp 150-800 ms, fallback 300) | function, constant | `packages/runtime/src/decide/policy.ts` -> `holdBudget`, `HOLD_MIN_MS`, `HOLD_MAX_MS`, `HOLD_FALLBACK_MS` | [decide-policy](runtime/decide-policy-actions.md) |
| Rate limiter (`policy.maxActionsPerMinute`, default 60) | class | `packages/runtime/src/decide/policy.ts` -> `RateLimiter`, `policyConfig` | [decide-policy](runtime/decide-policy-actions.md) |
| `Controller` / `NetHost` seams | type | `packages/runtime/src/decide/exec.ts` -> `Controller`, `NetHost` | [decide-policy](runtime/decide-policy-actions.md) |
| Console reports and dedupe | class, function | `packages/runtime/src/decide/report.ts` -> `Reporter`, `interventionLine` | [decide-policy](runtime/decide-policy-actions.md) |

### Model host and CLI

| X | kind | where | doc |
|---|---|---|---|
| Model host factory | function | `packages/runtime/src/model/host.ts` -> `createModelHost` | [model-host](runtime/model-host.md) |
| Default model URL (`@genclass/runtime-model@0.1.0` on jsDelivr, published 2026-10-08) | constant | `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` | [model-host](runtime/model-host.md) |
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
| CLI default source (jsDelivr `@genclass/runtime-model@0.1.0/files/` = `DEFAULT_MODEL_BASE_URL`, resolves since 2026-10-08) | constant | `packages/runtime/bin/genclass-runtime.mjs` -> `DEFAULT_FROM` | [status](status-and-known-issues.md) |

### Devtools overlay

| X | kind | where | doc |
|---|---|---|---|
| `mountDevtools` (`@genclass/runtime/devtools`) | function | `packages/runtime/src/devtools/index.ts` -> `mountDevtools` | [devtools](runtime/devtools.md) |
| Alt+Shift+G toggle | key binding | `packages/runtime/src/devtools/index.ts` -> `Devtools` | [devtools](runtime/devtools.md) |
| Mode labels "Observe (default)" / "Guard (opt-in)" / "Heal (experimental)" | string | `packages/runtime/src/devtools/index.ts` -> `Devtools` | [devtools](runtime/devtools.md) |
| Report sentence parsing | function | `packages/runtime/src/devtools/ui.ts` -> `splitReport` | [devtools](runtime/devtools.md) |
| Stylesheet | constant | `packages/runtime/src/devtools/css.ts` -> `CSS` | [devtools](runtime/devtools.md) |

### Build, test, CI and release

| X | kind | where | doc |
|---|---|---|---|
| Workspaces (`packages/*`, `sim`, `demos`) and root scripts `build`, `test`, `typecheck` | config | `package.json` -> `workspaces`, `scripts` | [build-test-release](runtime/build-test-release.md) |
| Root lockfile (committed) | file | `package-lock.json` | [build-test-release](runtime/build-test-release.md) |
| **CI** (typecheck, build, unit tests, perf budgets) | workflow | `.github/workflows/ci.yml` -> job `runtime` | [build-test-release](runtime/build-test-release.md) |
| Subpath exports (incl. `./auto*`), `sideEffects`, `bin`, `version` | config | `packages/runtime/package.json` -> `exports`, `sideEffects`, `bin`, `version` | [build-test-release](runtime/build-test-release.md) |
| Build entries and externals (ESM, two global builds, CDN worker) | config | `packages/runtime/tsup.config.ts` -> `entry`, `dts`, `external`, `globalBuild`, plugins `cdnOrt`, `ortExternal` | [build-test-release](runtime/build-test-release.md) |
| Unit-test include/exclude | config | `packages/runtime/vitest.config.ts` | [build-test-release](runtime/build-test-release.md) |
| Typecheck: `npx tsc -p tsconfig.json --noEmit` (in `packages/runtime`), or `npm run typecheck -w @genclass/runtime` | command | `packages/runtime/package.json` -> `scripts.typecheck` | [build-test-release](runtime/build-test-release.md) |
| Unit tests: `NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts`, then `npx vitest run test/review-perf.test.ts --retry=2` (in `packages/runtime`) | command | `packages/runtime/vitest.config.ts`; `.github/workflows/ci.yml`; gc check in `packages/runtime/test/review-timers.test.ts` | [build-test-release](runtime/build-test-release.md) |
| Browser specs `npm run test:browser` (ask first) | command | `packages/runtime/package.json` -> `scripts.test:browser`; `packages/runtime/test/browser/playwright.config.ts` | [build-test-release](runtime/build-test-release.md) |
| Smoke test `bash test/smoke/smoke.sh` (ask first) | command | `packages/runtime/test/smoke/smoke.sh` | [build-test-release](runtime/build-test-release.md) |
| Core test harness (`setup()` defaults to `mode: "guard"`) | function, class | `packages/runtime/test/helpers.ts` -> `setup`, `FakeClock`, `FakeServer`, `ScriptedDecider`, `ManualDecider` | [build-test-release](runtime/build-test-release.md) |
| Scripted `Runtime` for UI/adapter tests | class | `packages/runtime/test/browser/ui/mock-runtime.ts` -> `MockRuntime` | [devtools](runtime/devtools.md) |
| Real runtime under virtual time for UI tests | function | `packages/runtime/test/browser/ui/session.ts` -> `runStoreSession` | [devtools](runtime/devtools.md) |
| Scripted store story | function | `packages/runtime/test/browser/ui/scenario.ts` -> `loadScenario` | [devtools](runtime/devtools.md) |
| Playwright global setup (rebuilds `dist/`) | function | `packages/runtime/test/browser/build.mjs` -> `buildLibrary` | [build-test-release](runtime/build-test-release.md) |
| Model fixtures from an export instead of v0.1 | flag | `packages/runtime/test/model/helpers.ts` -> `FIXTURES_FROM_MODEL` | [build-test-release](runtime/build-test-release.md) |
| VM helper `scripts/vm.sh sync\|run\|exec\|get SLOT ...` (Azure; ask first) | command | `scripts/vm.sh` | [build-test-release](runtime/build-test-release.md) |
| Release and freeze tags `v0.1.0-alpha.0` (654d822), `v0.1.0-alpha.1` (806a296, local), `situation-v1` (1a77558), `situation-v2` (6e5e86e), `situation-v2.1` (5bc40c9, not merged) | git tag | `git tag -n1` |
| Changelog and install requests | file | `packages/runtime/CHANGELOG.md`; `packages/runtime/INSTALL-NEEDS.md` | [build-test-release](runtime/build-test-release.md) |

### Environment variables

| X | used by | where | doc |
|---|---|---|---|
| `INSTALL_OUT`, `INSTALL_TMP`, `SCAFFOLDS`, `WORK`, `TGZ`, `SKIP_DEV` | install suite on the VM (ask first) | `packages/runtime/test/install/run-all.sh`, `scaffold.sh`, `frameworks.mjs` | [status](status-and-known-issues.md) |
| `GENCLASS_MODEL_DIR` (default `<repo>/.cache-model`) | model unit tests and browser specs | `packages/runtime/test/model/helpers.ts` -> `MODEL_DIR`; `packages/runtime/test/browser/model-helpers.ts` -> `MODEL_DIR` | [build-test-release](runtime/build-test-release.md) |
| `GENCLASS_WEBGPU_VARIANTS` | WebGPU spec variants | `packages/runtime/test/browser/model-webgpu.spec.ts` | [build-test-release](runtime/build-test-release.md) |
| `GENCLASS_BENCH_MODELS`, `GENCLASS_OFFLINE` | browser model specs | `packages/runtime/test/browser/model.spec.ts` | [build-test-release](runtime/build-test-release.md) |
| `NODE_OPTIONS=--expose-gc` | gc check in a REVIEW test | `packages/runtime/test/review-timers.test.ts` | [build-test-release](runtime/build-test-release.md) |
| `ONNXRUNTIME_NODE_INSTALL=skip` | CI: stops the dev-only `onnxruntime-node` from downloading CUDA binaries during `npm ci` | `.github/workflows/ci.yml` | [build-test-release](runtime/build-test-release.md) |
| `SIM_RUNTIME=real` | sim tests use the real runtime | `sim/test/helpers.ts` -> `testFactory` | [sim](sim.md) |
| `SIM_S2` (`0` turns S2 latent re-draws off) | sim label futures | `sim/src/run/latent.ts` -> `S2` | [sim](sim.md) |
| `SIM_PROBE=1` | separability probes (analysis only) | `sim/src/oracle/probe.ts` -> `PROBE` | [sim](sim.md) |
| `SIM_FEATURE_HOLDOUT=off` | disables held-out features (train-on-everything runs) | `sim/src/world/scenario.ts` | [sim](sim.md) |
| `RW_RUNTIME_SRC`, `RW_RUNTIME_TAG` | realapps: pin the bundled runtime source and its tag (default the working tree, `working-tree`) | `realapps/build.mjs` | [realapps](realapps.md) |
| `RW_OSS_DIR` (default `~/gcl/real-cache/oss`) | realapps OSS checkouts | `realapps/build.mjs`, `realapps/corpus/prepare_oss.sh` | [realapps](realapps.md) |
| `RW_PORT`, `RW_OPTS` | realapps worker processes (set by the generator) | `realapps/src/harness/worker.ts` | [realapps](realapps.md) |
| `GC_P_RUNTIME` (set from `--p-runtime`) | share of runtime-exact curriculum rows | `training/curriculum/generate.py` -> `P_RUNTIME` | [training](training.md) |
| `GC_V1_CKPT`, `GC_BASE_32M` | prune tests | `training/tests/test_prune_vocab.py` | [training](training.md) |
| `GC_R17_INIT` | export end-to-end test | `training/tests/test_export_runtime.py` | [training](training.md) |
| `RANKS`, `THREADS`, `GA_OVERRIDE`, `LR_OVERRIDE`, `HLR_OVERRIDE` | training launchers | `training/launch_student.sh` (and `RANKS`/`THREADS` in `launch_t150.sh`) | [training](training.md) |
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
| Scenario from a seed; split assignment; held-out domains and features; budget sampling | function, constant | `sim/src/world/scenario.ts` -> `buildScenario`, `splitOf`, `TEST_DOMAINS`, `TEST_FEATURES` | [sim](sim.md) |
| One run (ideal or real) | function | `sim/src/run/runner.ts` -> `runScenario` | [sim](sim.md) |
| Trajectory -> rows (gold, unlabeled, on-policy); counterfactual costs | function | `sim/src/gen/trajectory.ts` -> `generateTrajectory`, `unlabeledTrajectory`, `pointCosts` | [sim](sim.md) |
| **S1** diagnosis relabel (`S1_GAP` 1.0) | function, constant | `sim/src/gen/trajectory.ts` -> `diagnosisFromOutcome`, `S1_GAP` | [sim](sim.md) |
| **S2** latent re-draws in futures | function | `sim/src/run/latent.ts` -> `futureProfile`, `futureStepTimes`, `idealRepeatSkips`, `REPEAT_PRIOR`; `sim/src/net/network.ts` -> `Network` (`latent`) | [sim](sim.md) |
| On-policy (DAgger) decider: a real export in Node WASM | function | `sim/src/run/onpolicy.ts` -> `loadModelDecider`; flag `--on-policy <dir>` in `sim/src/gen.ts` | [sim](sim.md) |
| Run cost, cost weights, soft action label, tier premiums | function, constant | `sim/src/oracle/cost.ts` -> `runCost`, `W`, `actionLabel`, `LABEL`, `TIER` | [sim](sim.md) |
| Diagnosis labels | function | `sim/src/oracle/diagnose.ts` -> `diagnose` | [sim](sim.md) |
| Ground-truth bookkeeping | class | `sim/src/oracle/knowledge.ts` -> `Knowledge` | [sim](sim.md) |
| Separability probes | constant, class | `sim/src/oracle/probe.ts` -> `PROBE`, `Probe` | [sim](sim.md) |
| Virtual event loop | class | `sim/src/loop.ts` -> `VirtualLoop` | [sim](sim.md) |
| Seeded RNG with keyed forks | class | `sim/src/rng.ts` -> `Rng`, `hashAll` | [sim](sim.md) |
| Virtual network and ideal profile; sim op header | class, constant | `sim/src/net/network.ts` -> `Network`, `IDEAL_PROFILE`, `SIM_OP_HEADER` | [sim](sim.md) |
| Virtual server | class | `sim/src/net/server.ts` -> `VirtualServer` | [sim](sim.md) |
| Feature combinators (46) and weights | constant | `sim/src/app/features/index.ts` -> `FEATURES`, `FEATURE_WEIGHTS` | [sim](sim.md) |
| 55 + 60 domain vocabularies | constant | `sim/src/app/vocab.ts` -> `DOMAINS`; `sim/src/app/vocab2.ts` -> `DOMAINS2` | [sim](sim.md) |
| Loading the real runtime; `createRuntime` options (mode `heal`) | function | `sim/src/run/rt.ts` -> `realRuntimeFactory`, `createOptions` | [sim](sim.md) |
| Fake runtime (test double; generator refuses it without `--allow-fake`) | function | `sim/src/run/fake-runtime.ts` -> `createFakeRuntime`; flag in `sim/src/gen.ts` | [sim](sim.md) |
| Ask questions | function | `sim/src/ask/questions.ts` -> `askQuestions` | [sim](sim.md) |
| Action-option shuffle/drop and paraphrases | function, constant | `sim/src/run/transform.ts` -> `transformQuestions`, `ACTION_PARA` | [sim](sim.md) |
| CONTRACT-D row type | type | `sim/src/types.ts` -> `Row`, `Label` | [model-io-contract](model-io-contract.md) |
| `node sim/dist/gen.js --rows N --out DIR ...` (`--sample`, `--parts`, `--unlabeled`, `--on-policy`) (ask first) | CLI | `sim/src/gen.ts` -> `main` | [sim](sim.md) |
| Re-derive action labels from `meta.cost_futures` | script | `sim/scripts/relabel.py` | [sim](sim.md) |
| Azure generation (`bigrun.sh gold\|unl`, `collect.py`) (Azure; ask first) | script | `sim/scripts/cluster/` | [sim](sim.md) |
| `bash sim/scripts/final.sh a\|b\|merge-b` (v1; VM; ask first) | command | `sim/scripts/final.sh` | [sim](sim.md) |

### realapps

| X | kind | where | doc |
|---|---|---|---|
| App manifest and affordance types | type | `realapps/src/shared/manifest.ts` -> `AppManifest`, `Affordance` | [realapps](realapps.md) |
| The app's one-line runtime integration | function | `realapps/apps/_shared/genclass.ts` | [realapps](realapps.md) |
| Shared manifest builder for the 14 OSS Conduits | function | `realapps/apps/_shared/conduit-manifest.ts` -> `conduitManifest` | [realapps](realapps.md) |
| Scenario from a seed; held-out apps/frameworks; split | function, constant | `realapps/src/harness/scenario.ts` -> `buildScenario`, `splitOf`, `TEST_APPS`, `TEST_FRAMEWORKS` | [realapps](realapps.md) |
| Trajectory -> rows; observer map; runtime tag | function, constant | `realapps/src/harness/trajectory.ts` -> `generateTrajectory`, `OBSERVE`, `runConfig`, `RUNTIME_TAG` | [realapps](realapps.md) |
| Run cost (mirrors the sim) | function | `realapps/src/harness/cost.ts` -> `runCost` | [realapps](realapps.md) |
| In-page diagnosis rules | function | `realapps/src/world/diagnose.ts` -> `diagnose`; Node side `realapps/src/harness/labels.ts` -> `finishDiagnosis` | [realapps](realapps.md) |
| Recording decider, hooks, snapshots | class | `realapps/src/world/probe.ts` -> `Probe` | [realapps](realapps.md) |
| Headless Chromium runner | class | `realapps/src/harness/browser.ts` -> `Runner` | [realapps](realapps.md) |
| Never-worse (`--interference`) and determinism (`--det`) sweeps (Chromium; ask first) | CLI | `realapps/src/harness/debug.ts` | [realapps](realapps.md) |
| Generator `node dist/harness/gen.js --out DIR ...` (Chromium; ask first) | CLI | `realapps/src/harness/gen.ts` | [realapps](realapps.md) |
| Real-app eval set | script | `realapps/scripts/evalset.py` | [realapps](realapps.md) |
| Azure batches (`cluster.sh sync\|setup\|run\|status\|stop`) (Azure; ask first) | script | `realapps/scripts/cluster.sh`, `realapps/scripts/node_setup.sh` | [realapps](realapps.md) |

### training and the Python reference

| X | kind | where | doc |
|---|---|---|---|
| Scaled training plan (P0-P5) | doc | `training/PLAN-v1.md` | [training](training.md) |
| Curriculum row factory | function | `training/curriculum/generate.py` -> `make_row` | [training](training.md) |
| Scenario result dataclass | class | `training/curriculum/scenarios.py` -> `Scen` | [training](training.md) |
| Surface-variation templates | constant | `training/curriculum/fmt.py` -> `TEMPLATES`, `Style` | [training](training.md) |
| Curriculum domains (13 held out) | constant | `training/curriculum/vocab.py` -> `DOMAINS`, `TEST_DOMAINS` | [training](training.md) |
| Calibration fit and gate metrics | function | `training/eval_runtime.py` -> `fit_calibration`, `decision_metrics` | [training](training.md) |
| Teacher soft-labelling (one shard / across nodes) | script | `training/label_teacher.py` -> `main`; `training/label_cluster.sh` | [training](training.md) |
| Student / teacher launchers | script | `training/launch_student.sh`, `training/launch_t150.sh`, `training/launch_r68.sh` | [training](training.md) |
| T1 expected-gain relabel and eval | script | `training/t1_relabel.py` -> `relabel_row`, `gains_of`; `training/eval_gain.py` -> `evaluate`, `classify` | [training](training.md) |
| q8 / fp16 export | function | `training/export_runtime.py` -> `make_q8`, `make_fp16` | [training](training.md) |
| Vocabulary pruning | function | `training/prune_vocab.py` -> `prune_tokenizer_json` | [training](training.md) |
| Export check in onnxruntime-web WASM: `node validate.mjs <dir> [variant] [maxRequests]` | CLI | `training/ortweb/validate.mjs` | [training](training.md) |
| Mixture configs | config | `training/configs/mix_*.json`, read by `jev_local/train/stream.py` -> `MixConfig` | [training](training.md) |
| Row label -> training target; example encoding | function | `jev_local/train/train.py` -> `parse_target`, `encode_example` | [lineage](genclass-model-lineage.md) |
| Python serializer (reference for `model/serialize.ts`) | function | `jev_local/serialize.py` -> `state_segments`, `question_block` | [lineage](genclass-model-lineage.md) |
| Python packer (reference for `model/packer.ts`) | class | `jev_local/engine/encoder/tokenize_pack.py` -> `Packer` | [lineage](genclass-model-lineage.md) |
| Python calibration lookup (reference for `model/calibrate.ts`) | function | `jev_local/engine/encoder/calibrate.py` -> `header_key`, `tau_for` | [lineage](genclass-model-lineage.md) |
| Python answer math | function | `jev_local/confidence.py` -> `build_answer` | [lineage](genclass-model-lineage.md) |
| Decision heads (no gain head in this repo) | class | `jev_local/engine/encoder/heads.py` -> `DecisionHeads` | [lineage](genclass-model-lineage.md) |
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

Ignore rules live in `.gitignore` (root), `demos/.gitignore`, `extension/.gitignore`, `realapps/.gitignore` and `packages/runtime/test/browser/.gitignore`. The root rules `data/`, `models/`, `runs/`, `dist/` and `node_modules/` have no leading slash, so they match at any depth.

| path | ignored by | produced by | notes |
|---|---|---|---|
| `node_modules/` (root) | root | `npm ci` / `npm install` at the repo root (workspaces hoisted) | `extension/`, `realapps/` and `training/ortweb/` are not workspaces and need their own `npm install` |
| `package-lock.json` (root) | **tracked** since b435acb | `npm install` at the root rewrites it | CI uses `npm ci`, which fails if `package.json` and the lockfile disagree; commit lockfile changes only when you changed dependencies on purpose |
| `packages/runtime/bin/genclass-runtime.mjs` mode | — | committed as 100755 since b435acb | the old spurious "mode changed" diff after `npm install` is gone |
| `packages/runtime/dist/` | root `dist/` | `npx tsup` / `npm run build` (in `packages/runtime`); also `sim`'s `build:runtime-core` script and `packages/runtime/test/browser/build.mjs` (Playwright global setup) rewrite it | `sim` and `demos` import the runtime through this `dist/`; a working copy may hold a stale one. Since the merge it also holds `auto.js`, `auto/*.js`, `genclass.global{,.min}.js` (version baked in) and `cdn/` (the CDN worker with onnxruntime-web bundled); the CLI hashes the global build for SRI |
| `sim/dist/` | root `dist/` | `npm run build` in `sim` (tsup: `gen`, `worker`, `index`, `smoke`; plus `build:model-host` -> `sim/dist/model-host/`) | — |
| `realapps/dist/`, `realapps/node_modules/` | root and `realapps/.gitignore` | `node build.mjs` in `realapps/` (world, harness, apps, `runtime-tag.txt`); `npm install` there | builds launch nothing, but the outputs are only useful with Chromium (ask first to run) |
| `realapps/src/harness/apps.gen.ts` | `realapps/.gitignore` | `realapps/build.mjs` (one import per `apps/*/manifest.ts`) | regenerate after adding an app |
| `~/gcl/real-cache/oss`, `~/gcl/real-out/<batch>` | outside the repo | `realapps/corpus/prepare_oss.sh` (`RW_OSS_DIR`); `gen.js --out` via `cluster.sh run` | VM paths |
| `demos/dist/` | root and `demos/.gitignore` | `npm run build` in `demos` (`demos/scripts/build.mjs`) | — |
| `extension/dist/` | root and `extension/.gitignore` | `extension/scripts/build.mjs` (`dist/genclass/`) | — |
| `sim/out/` | root | `sim/src/gen.ts` (default `--out sim/out/run`), `sim/scripts/final.sh` (`sim/out/final-a/`, `sim/out/final-b/parts/`) | training data; excluded from `scripts/vm.sh` syncs. v2 production data lives on the train VM under `/data/sim-out/v2-*` and REAL's under `/data/real-out/` (per `training/NEEDS.md`; not checked) |
| `.cache-model/` | root | `node packages/runtime/bin/genclass-runtime.mjs fetch-model .cache-model --from https://github.com/MeharPro/GenClass/releases/download/v0.1.0/` (ask first: download; without `--from` the CLI uses `DEFAULT_FROM`, the published `@genclass/runtime-model@0.1.0`, which is not the parity fixture) | default `GENCLASS_MODEL_DIR`; absent in a fresh clone, so 14 model tests skip. The v0.1 model is a parity fixture only; it does not match situation-v2 |
| `packages/runtime-model/files/` | root | intended for `training/export_runtime.py` output (the `@genclass/runtime-model` package, published 2026-10-08) | does not exist at b435acb |
| `demos/public/genclass-model/` | `demos/.gitignore` | `npm run fetch-model` in `demos` (`demos/scripts/fetch-model.sh`, v0.1 model) | — |
| `packages/runtime/test/browser/.build/` | `packages/runtime/test/browser/.gitignore` | `packages/runtime/test/browser/build.mjs` | bundled test app and build info |
| `test-results/` | root, `demos/.gitignore`, `extension/.gitignore` | Playwright (`packages/runtime/test-results/{browser,ui}`), model benchmarks (`packages/runtime/test-results/model-bench/`) | — |
| `playwright-report/` | root, `demos/.gitignore`, `extension/.gitignore` | Playwright HTML reporter | — |
| `demos/e2e/.out/` | `demos/.gitignore` | `demos/e2e/eval.ts` (`partial.json`, `traces*.json` with `--trace`) | input to `demos/e2e/trace-report.ts` |
| `*.tgz` | root | `npm pack` in `packages/runtime/test/smoke/smoke.sh` (left in `packages/runtime/`) | a release tarball (`genclass-runtime-<version>.tgz`) also lands here |
| `.publish/` | root | no tracked script; added with the alpha publish (59c213f) | purpose not recorded |
| `.vite/` | root | Vite cache directory (no config in the repo sets `cacheDir`; Vite's default is `node_modules/.vite`) | — |
| `data/` (any depth) | root | not produced in this repo. Matches the missing `jev_local/data/` (data generators) and `demos/src/server/data/cities.ts`; Azure hosts keep training data under `$G/data/` | the rule hides source files that the code imports |
| `models/` (any depth) | root | `python -m jev_local.train.train --out models/<M>` (servable checkpoints); `training/prune_vocab.py --out` (on Azure, e.g. `models/r32-v16k`) | default `JEV_LOCAL_FAST_CKPT` is `<repo>/models/jev-local-fast`; none in the repo |
| `runs/` (any depth) | root | trainer state and logs (`runs/<run>/ckpt`, `log.jsonl`), `scripts/benchmax.py` (`runs/benchmax/...`), `scripts/bench_encoder.py`, `scripts/bench_decoder.py` | none in the repo |
| `extension/release-assets/*.onnx` | `extension/.gitignore` | `extension/tools/genclass_export.py` | absent |
| `.venv/`, `__pycache__/`, `*.pyc`, `.pytest_cache/`, `*.egg-info/` | root | Python venv, pytest, `pip install -e .` of `jev-local` | — |
| `.DS_Store` | root, `extension/.gitignore` | macOS Finder | — |
| `/data/install/*` (VM) | outside the repo | `packages/runtime/test/install/run-all.sh` (`INSTALL_OUT`, scaffolds, work dirs, tarball) | VM paths |

## 5. Large files: do not read in full

Sizes from `git ls-tree -l b435acb` / `wc -l` (rows marked f107013 re-measured there). "0 lines" means one line with no trailing newline: inspect it with `python3 -c` or `jq` (keys, lengths, one record) instead of opening it.

| path | bytes | lines | what it is / how to read it |
|---|---|---|---|
| `extension/src/model/tokenizer.json` | 3,584,123 | 251,542 | HF tokenizer of the v0.1 model. Read keys only (`added_tokens`, `model.type`) |
| `extension/release-assets/tokenizer.json` | 3,584,123 | 251,542 | byte-identical copy of the above |
| `extension/test/fixtures/policy_py.json` | 3,069,755 | 0 | Python-harness policy parity fixture |
| `extension/test/fixtures/pack_fixtures.json` | 1,228,103 | 0 | Python packer output for the v0.1 requests |
| `packages/runtime/test/fixtures/model/pack_fixtures.json` | 955,379 | 0 | compact copy of the extension's pack fixtures; read through `packages/runtime/test/model/helpers.ts` -> `packs` |
| `demos/results.json` | 922,287 | 46,000 | raw demo trials; read `demos/results.md` or `demos/results-summary.json` instead |
| `sim/samples/sample.jsonl` | 896,221 | 200 | 200 CONTRACT-D rows (about 4.5 KB each, situation-v2); read one line, or `sim/samples/EXAMPLES.md` |
| `bench/public/targets.json` | 785,218 | 30,045 | 549 benchmax targets |
| `bench/public/jev_published.json` | 383,059 | 8,236 | 549 published Jev numbers |
| `extension/test/fixtures/requests50.json` | 346,737 | 9,399 | the 50 harness requests with `gold` and `screen_type` |
| `packages/runtime/test/fixtures/model/requests50.json` | 285,309 | 0 | the same 50 requests without `gold`/`screen_type` |
| `extension/test/fixtures/torch_fixtures.json` | 269,230 | 0 | PyTorch logits of the v0.1 model |
| `packages/runtime/test/fixtures/model/torch_fixtures.json` | 255,945 | 0 | compact copy of the above |
| `extension/test/fixtures/questions_py.json` | 222,955 | 16,984 | Python-harness question fixtures |
| `docs/benchmax-research/jev-published.md` | 217,513 | 2,206 | census of published Jev numbers |
| `packages/runtime/test/fixtures/model/py_fixtures.json` | 167,629 | 0 | Python reference cases for serialize/tokenize/calibrate/confidence |
| `package-lock.json` | 106,273 | 3,220 | root lockfile (f107013); never edit by hand |
| `jev_local/bench/registry.py` | 90,896 | 1,888 | jevbench dataset registry and exclusion rules (source; grep it) |
| `packages/runtime/src/runtime.ts` | 95,517 | 2,143 | `RuntimeImpl` (f107013); jump to methods by name (`trigger`, `runDelivery`, `deliveryHoldable`, `onDecision`, `settled`) |
| `docs/SPEC.md` | 84,347 | 1,131 | legacy jev-local rebuild spec |
| `docs/benchmax-research/{PLAN,feasibility-targets,suite-reproduction-specs,train-data-and-supervised-ceilings}.md` | 72,630-93,641 each | 768-971 each | benchmax planning notes |
| `packages/runtime/STATUS.md` | 80,206 | 1,097 | CORE status (f107013); read "State", then the fix or batch section you need |
| `sim/samples/EXAMPLES.md` | 68,211 | 1,484 | pretty-printed sim rows |
| `training/curriculum/rt.py` | 66,963 | 1,349 | Python port of the situation renderer; grep by function (`render`, `event_lines`, `content_facts`) |
| `extension/test/fixtures/spans_py.json` | 59,806 | 5,458 | Python-harness span fixtures |
| `bench/public/exclusions.json` | 59,101 | 2,297 | benchmax exclusion manifest |
| `scripts/benchmax_build_targets.py` | 52,170 | 671 | target/exclusion generator |
| `extension/package-lock.json` | 50,300 | 1,506 | extension lockfile |
| `packages/runtime/src/devtools/index.ts` | 49,745 | 1,291 | `Devtools` class; read by method |
| `jev_local/bench/benchmax/adapters_b/vendor/earino/val_indices.json` | 43,930 | 0 | vendored upstream indices |
| `docs/agents/*.md`, `docs/agents/runtime/*.md` (subsystem docs) | about 66,000-137,000 each | — | read the TL;DR, then the section you need |

Binary files: 64 tracked PNGs (11,520,386 bytes in total: 18 devtools screenshots, 31 demo screenshots, 10 Chrome Web Store images, 5 extension icons) and 3 WAV clips under `extension/test/fixtures/audio/` (219,600 bytes). Model weights (`*.onnx`) are never tracked.

Other source files over 25 KB that are better read by symbol than end to end: `packages/runtime/src/situation/facts.ts` (706 lines), `packages/runtime/src/state/hub.ts` (840), `packages/runtime/src/observe/fetch.ts` (654), `packages/runtime/src/model/host.ts` (752), `sim/src/run/runner.ts` (843), `jev_local/train/train.py` (1,059), `jev_local/train/stream.py` (917), `docs/runtime/CONTRACT.md` (525).

## 6. Drift and open issues (map-level)

Doc-vs-code drift you will meet while navigating; the subsystem docs have the details.

- **Default mode**: code, `docs/runtime/API.md`, CONTRACT §13, the devtools and both READMEs say `observe`; `HANDOFF.md`,
  `origin/runtime` (code), the older published alpha.0, the `init` usage text (`packages/runtime/bin/lib/init.mjs` ->
  `USAGE`), its mode mapping (`packages/runtime/bin/lib/plan.mjs` -> `AUTO`) and
  `packages/runtime/test/install/INSTALL-README-SNIPPET.md` still assume guard
  ([status-and-known-issues.md](status-and-known-issues.md#install-code-review-2026-10-08)).
- **Version**: `packages/runtime/package.json` and `packages/genclass-runtime/package.json` said `0.1.0-alpha.1`, already
  published without the install paths; `packages/runtime/CHANGELOG.md` listed the install paths under alpha.1. Since 9695830
  the runtime says `0.1.0-beta.0` (published `latest`, 2026-10-08) and the CHANGELOG lists the install paths under it;
  the alias is still `0.1.0-alpha.1` (unpublished) with dependency `0.1.0-beta.0`.
- **Subsystem docs**: `docs/agents/runtime/build-test-release.md` and `public-api-and-lifecycle.md` (as committed at
  f107013) still describe six tsup entries and `"sideEffects": false`; no subsystem doc covers `src/auto.ts`,
  `src/cdn/` or `bin/lib/` yet.
- **App counts**: `realapps/README.md` and `HANDOFF.md` say 66 apps; the tree has 128 app directories. The never-worse
  result 0/396 covers the 66 ([realapps.md](realapps.md)).
- **Sim budget**: `sim/src/world/scenario.ts` still samples situation budgets 3,200 / 2,000 / 1,000 (40/30/30), while the
  v2 runtime's full budget is 2,400 ([sim.md](sim.md)); the finished v2 SIM data carries it.
- **Test counts**: `packages/runtime/STATUS.md` says 42 files / 348 tests; this branch has 46 files / 393 tests.
- **realapps output**: batch `manifest.json` files hardcode `situation-v1` and `TRIGGER_W` has no `delivery` weight
  (`realapps/src/harness/gen.ts`, `realapps/src/harness/trajectory.ts`); see [realapps.md](realapps.md).
- **Newer upstream**: `origin/runtime` 5bc40c9 (batch 6, `situation-v2.1`, 150 app directories) is not merged here; the
  local branch `mvp-v2-b6` merges it.
