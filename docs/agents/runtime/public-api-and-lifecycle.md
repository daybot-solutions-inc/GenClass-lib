# @genclass/runtime: public API, options and lifecycle

> **Scope:** `packages/runtime/src/index.ts`, `packages/runtime/src/runtime.ts` (wiring, construction, init/destroy, modes, kill switch, option resolution, events, plugins, introspection, settled points, the delivery gate and background write observation as seen from the facade), `packages/runtime/src/types.ts`, `packages/runtime/src/errors.ts`, `packages/runtime/src/clock.ts`, `packages/runtime/src/util.ts`, `packages/runtime/package.json`; the consumer-facing side of the zero-code entries (`packages/runtime/src/auto.ts`, `packages/runtime/src/cdn/*`, `packages/runtime/bin/genclass-runtime.mjs` `init`/`remove`); their internals (framework detection, edit planning, the CDN worker and onnxruntime bundling) belong to INSTALL and are only summarised here.
> **Read this when:** you add or change an init option, a `Runtime` method, an event, a plugin hook or a subpath export; you touch `GenClass.init` / `createRuntime` / the kill switch / `destroy()`; you touch `@genclass/runtime/auto*`, the script-tag global (`window.GenClass`) or `genclass-runtime init|remove`; you need the exact default of any option (the default mode is `observe`); you add timing or scheduling code; you wire a new subsystem into `RuntimeImpl`.
> **Source of truth:** the code. App tokens, `protect()` and `scope` verified against branch `feat/projects` (from 126026f), 2026-10-10. Automatic state discovery (`autoState`, `stores()`, `@genclass/runtime/discover`) verified against branch `feat/one-line` (from 89237ab), 2026-10-10. The rest verified against branch `mvp-v2-merge` (mvp-v2 + origin/runtime eff18cb + observe/redaction fixes 054da38, f107013), 2026-10-08. origin/runtime has since moved past eff18cb (ca08174..5bc40c9: realapps wave 4, runtime batch 6 with model-provided gate thresholds, tag `situation-v2.1`); none of that is merged here or described in this doc. If this doc and the code disagree, the code wins.

## TL;DR

- Two entry points: `GenClass.init(options)` (browser facade: singleton, never throws, kill switch, loads the local model by default) and `createRuntime(options)` (headless: tests, sim, SSR; no model unless `decider` or `model: {...}` is passed). Both return a `RuntimeImpl` typed as `Runtime`. `createRuntime` can throw on malformed options; `GenClass.init` never throws (it falls back to an inert runtime).
- `GenClass.init` is idempotent: a second call returns the first runtime and **ignores its new options**. Only `GenClass.destroy()` clears the singleton; `rt.destroy()` alone does not.
- Zero-code entries (merged from origin/runtime f3a9dd1; **not** in the published `0.1.0-alpha.1`; they ship in `0.1.0-beta.0`, `latest` since 2026-10-08): `import "@genclass/runtime/auto"` (and `/auto/observe`, `/auto/guard`, `/auto/heal`), the script tag `dist/genclass.global(.min).js` (exposes `window.GenClass`), and the CLI `npx @genclass/runtime init|remove`. All of them end in `GenClass.init`, so the singleton, the kill switch and the defaults below apply unchanged. See [Zero-code entries](#zero-code-entries-auto-script-tag-cli).
- Three modes: `observe` (**default** on `mvp-v2` since f3636b2: `o.mode ?? "observe"` in `RuntimeImpl`'s constructor; never changes execution, nothing held or delayed (since 054da38 also no response/message delivery), decisions still made in the background and reported), `guard` (opt-in; guard-tier actions only), `heal` (experimental; guard + heal tier). A **tier** is the mode an action needs; the **policy gate** compares the mode with the action's tier. The npm `0.1.0-alpha.0` and origin/runtime (through eff18cb, and still at 5bc40c9) default to `guard`; npm `0.1.0-alpha.1` and `0.1.0-beta.0` (`latest`) default to `observe`. The `init` CLI still assumes `guard` is the default (see Drift).
- The unit-test harness (`test/helpers.ts` -> `setup`) passes `mode: "guard"` explicitly, because most CORE tests exercise interventions; pass `setup({ mode: undefined })` to get the product default.
- Situation-v2 (batch 4/5): decisions about responses and push messages are taken at the **network boundary** (the `delivery` trigger, `RuntimeImpl.runDelivery`). Store writes are **never held by default**: a salient write not covered by a delivery decision is triaged when proposed and decided in the background (`observeWrite`); `policy.holdWrites: true` restores the old hold-the-write path (opt-in, never reorders a store's writes). A delivery that cannot be held (observe mode, paused, model not ready, no permitted delivery action, or the model too slow) is released synchronously, before any body read, and (in observe, or whenever `discard` is not permitted) decided in the background on the state it was delivered into; in guard/heal its chain's writes get their own `mutation` decisions instead, and the delivery is asked only when a standing question or `triage: "always"` forces it (054da38; `RuntimeImpl.deliveryHoldable`, `writesCanAct`).
- Kill switch: `?genclass=off` (URL wins) or `localStorage.genclass = "off"` gives an inert runtime; the values `observe|guard|heal` override `options.mode`.
- The decider (`DecisionProvider`) is the only seam to the model. `createRuntime` builds a model host (`createModelHost`) only when `options.decider === undefined` and `options.model` is an object; the runtime then **owns** it and disposes it on `destroy()`. A caller-supplied decider is never disposed.
- The runtime consults the decider only while its `status.state` is `"ready"` or `"off"` (lazy). `"loading"` and `"error"` mean every trigger fails open at once (passive action, nothing held, no decision recorded).
- Everything time-related goes through the injected `Clock` (`browserClock` by default). Runtime code never calls `Math.random`, `Date.now`, `performance.now` or the global `setTimeout`; ids come from counters. This is what makes the sim deterministic and keeps train/runtime parity.
- Construction order matters: core subsystems, then queue/reporter/env, hub hooks, event and status subscriptions, persisted profiles, observers (each wrapped in try/catch), then plugins. `destroy()` is idempotent and tears down in roughly reverse order.
- A **settled point** is reached `settleMs` (default 60 ms) after the last op end / applied write / discarded write, when nothing younger than 10 s is in flight and no write is pending. Invariants and transition profiles are learned there and `inconsistency` / `transition` triggers are raised there.
- Events: `detect`, `decide`, `act`, `event`, `status`, `report` via `rt.on(type, fn)`; listener exceptions are swallowed (logged with `debug: true`).
- `util.ts` helpers (`secs`, `fmtNum`, `describe`, `normalizePath`, `isSensitiveName`, `isSensitivePath`, ...) shape the situation text. Changing them changes the frozen `situation-v2` format (tag `situation-v2` = 6e5e86e) and breaks train/runtime parity. f107013 deliberately changed redaction (numbers, bigints and arrays under a secret-named container; redacted F2 diffs), which changes situation text only where a secret used to leak (see Invariants). `situation-v1` (tag at 1a77558; `packages/runtime/src` is identical at 654d822 = the npm `0.1.0-alpha.0`) is superseded; the R17-final1 model trained on it does not match this runtime.

## Files

| path | role | key exports / entry points |
|---|---|---|
| `packages/runtime/src/index.ts` | Public facade and root module | `GenClass` (also `default`), `createRuntime`, re-exports (see [Root module exports](#root-module-exports)); private `killSwitch`, `initUnsafe`, `makeHost`, `failedProvider`, `NATIVE_FETCH`, `MODES`, `ALL_OFF` |
| `packages/runtime/src/runtime.ts` | `RuntimeImpl`: wires trace, state, learn, situation, decide and observers; implements every `Runtime` method; actions that need runtime state (rollback, chain revert, resync, late revert); the delivery gate (`runDelivery`, discard marks, drop filter); background write observation (`observeWrite`, `covered`); write marks (`markWrites`, `onChannel`); settled points | `RuntimeImpl`, `RuntimeInternals`, `normalizeError`, type re-exports `SituationDraft`, `BuiltSituation` |
| `packages/runtime/src/types.ts` | Every public and shared type. Header: CORE owns it; the "model seam" section (top) is shared with MODEL (`src/model/**`) and mirrored by `sim/src/types.ts` | `InitOptions`, `CreateOptions`, `ModelOptions`, `PolicyOptions`, `Runtime`, `RuntimeEvents`, `Plugin`, `PluginApi`, `DecisionProvider`, `Clock`, ... |
| `packages/runtime/src/errors.ts` | The one runtime-level error class | `GenClassUnavailableError` |
| `packages/runtime/src/clock.ts` | Real clock; captures timers at module load | `browserClock` |
| `packages/runtime/src/util.ts` | Deterministic helpers: hashing, stable stringify, number/time formatting, redaction, value descriptions, URL signatures | see [util.ts helpers](#utilts-helpers) |
| `packages/runtime/package.json` | Package manifest: exports map, bin, deps, peer deps | `exports`, `bin.genclass-runtime` |
| `packages/runtime/tsup.config.ts` | Four build configs: the ESM build (one entry per subpath export, including `auto*` and `worker`), the script-tag IIFE build twice (unminified / minified), and the CDN worker + onnxruntime-web build into `dist/cdn/` | `defineConfig([...])`, `globalBuild`, plugins `cdnOrt`, `ortExternal` |
| `packages/runtime/src/auto.ts` | `@genclass/runtime/auto`: `GenClass.init()` at import time from page config | default export `Runtime`, named `GenClass` |
| `packages/runtime/src/cdn/auto-observe.ts`, `auto-guard.ts`, `auto-heal.ts` | `@genclass/runtime/auto/<mode>`: same as `/auto` with that mode as the lowest-precedence default | default export `Runtime`, named `GenClass` |
| `packages/runtime/src/cdn/auto-start.ts` | Shared zero-code start | `startAuto(defaults)` |
| `packages/runtime/src/cdn/config.ts` | Page configuration: `<meta name="genclass">`, script data attributes, `window.GENCLASS_CONFIG`; devtools setting; kill-switch check | `PageConfig`, `DevtoolsSetting`, `parsePairs`, `fromPairs`, `mergeConfig`, `readMetaConfig`, `readWindowConfig`, `fromDataset`, `isLocalHost`, `isKilled`, `devtoolsOptions`, `splitConfig`, `whenBody` |
| `packages/runtime/src/cdn/global.ts` | Script-tag build (`dist/genclass.global.js`, `.min.js`): installs `window.GenClass` and auto-inits | `GenClassGlobal`, `assetBase`; private `install`, `findScript`, `blobModuleWorker` |
| `packages/runtime/src/cdn/worker.ts`, `ort-webgpu.ts`, `ort-wasm.ts`, `ort-env.ts` | CDN model worker with onnxruntime-web bundled (`dist/cdn/*`), loaded on demand by the script tag | `cdnState`, `prepareOrt` |
| `packages/runtime/bin/genclass-runtime.mjs`, `bin/lib/*.mjs` | CLI: `init`, `remove` (`bin/lib/init.mjs` -> `run`; `detect.mjs`, `plan.mjs`, `edit.mjs`, `ui.mjs`), `fetch-model`, `info` | `bin/lib/plan.mjs` -> `AUTO`, `scriptTag`, `planInit`; `bin/lib/edit.mjs` -> `MARK` |

Read-only neighbours this doc leans on: `src/decide/policy.ts` (`policyConfig`, `holdBudget`, `gate`), `src/decide/decider.ts` (`DeciderQueue`, now with `waiting`, `computing`, `computingSince`, `stuck` and a per-item `stale` check), `src/decide/exec.ts` (`Controller` with new optional `proceeded()` / `stale()`, `ActionEffect.onRecord`, `NetHost.deliver` / `noteResponse`), `src/decide/report.ts` (`Reporter`), `src/model/host.ts` (`createModelHost`, `DEFAULT_MODEL_BASE_URL`), `src/situation/serialize.ts` (`STATE_CHAR_BUDGET`, `COMPACT_BUDGET`), `src/trace/events.ts` (`EventLog`), `src/state/hub.ts` (`StoreHub`, `holdWrites`, hooks `observeWrite` / `filter` / `dropped`). New in batch 4/5 and wired by `RuntimeImpl`: `src/situation/conflicts.ts` (`predictedWrites`, `matchFields`, `conflictsOn`), `src/situation/content.ts` (`analyzeBody`, `createdIds`, `vhash`), `src/situation/evidence.ts` (`commitAmbiguity`, `failureOf`, `hostOfSig`), `src/learn/cadence.ts` (`Cadence`), `src/observe/eventsource.ts` (`installEventSource`), `src/observe/messages.ts` (shared WebSocket/EventSource message ops). Their internals are in [observe-and-trace.md](observe-and-trace.md), [learn-situation-triage.md](learn-situation-triage.md) and [decide-policy-actions.md](decide-policy-actions.md).

## Concepts and data structures

Terms introduced in this doc:

| term | meaning |
|---|---|
| facade | `GenClass` in `index.ts`: the singleton wrapper around `createRuntime` for apps. |
| inert runtime | A `RuntimeImpl` with every observer off (`ALL_OFF`), no decider, `report: "silent"`, `mode: "observe"`. Stores, `op`, `emit`, `user` still work (they record), nothing is ever held or asked. |
| owned decider | A model host that `createRuntime` created itself (`ownsDecider: true`). Only owned deciders are `dispose()`d by `destroy()`. |
| consultable | `RuntimeImpl.consultable()`: not paused, not destroyed, a decider exists, and its `status.state` is `"ready"` or `"off"`. Triggers and holds happen only when consultable. |
| lazy preload | When a salient trigger finds the decider not ready, the runtime reads `this.ready` (which calls `decider.ready()` once) and fails open for that trigger. |
| budget scale | `RuntimeImpl.budgetScale`, starts at 1; multiplied by 0.8 (floor 0.5) each time the decider errors with `code === "max_tokens_exceeded"`; applied to the automatic situation budget only. |
| delivery gate | `RuntimeImpl.runDelivery`: a fetch/XHR response or a WebSocket/EventSource message is about to reach the app; it is salient when a field its signature writes has newer applied data (or, judged from its body, it would put back a value the user's pending change replaced, or replace text the user typed). Salient deliveries wait for the model (trigger `delivery`, held, priority 2) when a hold is possible (`deliveryHoldable`); otherwise they are released at once and, if salient, decided in the background (054da38). |
| background delivery | 054da38: a delivery released without a hold (`deliveryHoldable` false: observe mode, paused, decider not `ready`, no permitted non-passive delivery action, or `expectedLatency() > holdBudgetMs()`). It is released before the body is read; content analysis uses `bodyNow` when the body is in memory (XHR, WebSocket, EventSource) before the app's listeners run, else (fetch) the async body, cut short at the chain's first write (`finalizeDeliveries`). Its decision cannot act (only the passive action); in observe it covers its chain's writes while pending (`deliveryPending`); in guard/heal (`writesCanAct`) the chain's writes keep their own `mutation` decisions and the delivery is asked only when a question forces it. |
| covered write | `RuntimeImpl.covered(m)`: the write's causal chain (the cause op and up to 15 ancestors, 16 ops in all; the first op carrying `op.delivery` decides) went through the delivery gate, the gate knew which fields it would write, every changed path is among them, and (if salient) the decision was taken or is pending in the background (`deliveryPending`). Covered writes raise no `mutation` trigger. Never covered with `triage: "always"`. |
| background write observation | Default store-write path (`policy.holdWrites` false): `StoreHub.propose` calls `hooks.observeWrite(m)` -> `RuntimeImpl.observeWrite`, which triggers `mutation` with `hold: false, priority: 1`; the hub then commits the write at once. Not called for writes the hub never gates (no changes, user-sync writes without `holdUserWrites`, GenClass ops, `hold: false` stores, `hub.gating` false i.e. paused/destroyed). A later `discard` can only late-revert it (`LATE_REVERT_MS`). |
| `holdWrites` | `PolicyOptions.holdWrites` (default false), copied to `hub.holdWrites`. When true, salient writes are queued and gated (`gateMutation`), never reordering a store's writes, and `atom().get()` inside the writing chain sees its own pending value (`hub.pendingView`). |
| expected latency | `RuntimeImpl.expectedLatency()`: base × (1 + queued items) + (while one is computing) `max(base, its elapsed time)`, where base = the lower median of the queue's last 20 provider latencies, else `status.warmupMs`, else 0; `Infinity` while `queue.stuck` (last evaluation timed out). A holdable trigger waits only if this is `<=` the hold budget. |
| discard mark | `OpRec.discardMark`, set by a delivery `discard`: for `DISCARD_MARK_MS` (10 s) the op chain's writes to protected (newer-data) paths, or to paths written over by a newer op/user since it started, are dropped by `RuntimeImpl.dropFilter`; `ActionRecord.dropped` lists them; undo re-applies them. |
| write marks (F9) | `RuntimeImpl.markWrites` / `onChannel` call `hub.markField` on fields written by a response delivered over newer data, an unusually slow response, an ambiguous failed write, or messages of a live channel that was down; surfaced as facts. |

### Package exports (`packages/runtime/package.json`)

ESM only (`"type": "module"`, only `import` conditions; the script-tag build is an IIFE file, not an export condition), `engines.node >= 20`, license Apache-2.0. `sideEffects` is no longer `false` (f3a9dd1): it lists `./dist/auto.js`, `./dist/auto/*.js`, `./dist/genclass.global.js`, `./dist/genclass.global.min.js`, `./dist/cdn/*.js` and `./src/model/worker.ts`, so bundlers keep the bare `import "@genclass/runtime/auto"`; the root and adapter modules are still tree-shakeable. New top-level `unpkg` and `jsdelivr` fields = `./dist/genclass.global.min.js` (what `https://cdn.jsdelivr.net/npm/@genclass/runtime` serves). Version: `0.1.0-beta.0` in `package.json` since 9695830, published as `latest` on 2026-10-08 ~13:40 UTC with the `/auto` entries, the script tag, `init`/`remove` and the default model `@genclass/runtime-model@0.1.0` ([RELEASE.md](../../../RELEASE.md)). Before it, `0.1.0-alpha.1` (806a296: situation-v2, the NaN fix, the observe default, docs) was `latest` and did **not** contain the zero-code entries. The published alpha.0 predates situation-v2, the NaN fix and the observe default. `bin/genclass-runtime.mjs` is committed as mode 100755 (b435acb). CI: `.github/workflows/ci.yml` (b435acb) runs typecheck, build and the unit tests on Node 22; see [build-test-release.md](build-test-release.md).

| subpath | types | import | source entry (tsup) | documented in |
|---|---|---|---|---|
| `@genclass/runtime` | `./dist/index.d.ts` | `./dist/index.js` | `src/index.ts` | this doc |
| `@genclass/runtime/auto` | `./dist/auto.d.ts` | `./dist/auto.js` | `src/auto.ts` | [Zero-code entries](#zero-code-entries-auto-script-tag-cli) |
| `@genclass/runtime/auto/observe`, `/auto/guard`, `/auto/heal` | `./dist/auto/<mode>.d.ts` | `./dist/auto/<mode>.js` | `src/cdn/auto-<mode>.ts` | [Zero-code entries](#zero-code-entries-auto-script-tag-cli) |
| `@genclass/runtime/react` | `./dist/adapters/react.d.ts` | `./dist/adapters/react.js` | `src/adapters/react.ts` | [state-and-adapters.md](state-and-adapters.md) |
| `@genclass/runtime/redux` | `./dist/adapters/redux.d.ts` | `./dist/adapters/redux.js` | `src/adapters/redux.ts` | [state-and-adapters.md](state-and-adapters.md) |
| `@genclass/runtime/zustand` | `./dist/adapters/zustand.d.ts` | `./dist/adapters/zustand.js` | `src/adapters/zustand.ts` | [state-and-adapters.md](state-and-adapters.md) |
| `@genclass/runtime/devtools` | `./dist/devtools/index.d.ts` | `./dist/devtools/index.js` | `src/devtools/index.ts` | [devtools.md](devtools.md) |
| `@genclass/runtime/worker` | (none) | `./dist/worker.js` | `src/model/worker.ts` | [model-host.md](model-host.md) |
| `@genclass/runtime/package.json` | | `./package.json` | | |

- Legacy top-level fields: `main` and `module` = `./dist/index.js`, `types` = `./dist/index.d.ts` (same targets as the `.` export). `repository.directory` = `packages/runtime`.
- Not in `exports` but shipped in `dist/` (fetched by URL): `dist/genclass.global.js`, `dist/genclass.global.min.js` (+ map), `dist/cdn/{worker,ort-webgpu,ort-wasm}.js` and chunks. Because `exports` has no entry for them, a bundler cannot `import` them; they are for `<script src>` and the script tag's own dynamic imports.
- `bin`: `genclass-runtime` -> `./bin/genclass-runtime.mjs` (the package's only bin, so `npx @genclass/runtime <command>` runs it): `init [--mode observe|guard|heal] [--yes|-y] [--dry-run] [--no-install] [--no-devtools] [--cwd <dir>] [--from <spec>] [--cdn <url>]` (also accepted but not in `USAGE`: `--no-sri`, `--strategy instrumentation|layout|pages` for Next.js), `remove [--yes] [--dry-run] [--keep-package] [--cwd <dir>]` (both dispatched to `bin/lib/init.mjs` -> `run`), `fetch-model <dir> [--from <baseUrl>] [--variant q8|fp16|all] [--force] [--quiet]` and `info <dir>` (details in [model-host.md](model-host.md)). A separate unscoped alias package, `packages/genclass-runtime` (`genclass-runtime`, bin `cli.mjs`, which imports `@genclass/runtime`'s `bin/genclass-runtime.mjs`), exists so that `npx genclass-runtime init` works; it is not on npm (404, 2026-10-08) and see Drift for its pinned dependency.
- `dependencies`: `onnxruntime-web ^1.30.0` (the only runtime dependency; CONTRACT §0 forbids adding others without the lead).
- `peerDependencies` (all optional via `peerDependenciesMeta`): `react >=18`, `redux >=4`, `zustand >=4`.
- `devDependencies`: `@playwright/test 1.63.0`, `@types/react ^19.0.0`, `@types/react-dom ^19.0.0`, `esbuild ^0.27.0`, `happy-dom ^20.14.5`, `onnxruntime-node 1.30.0`, `react ^19.3.0`, `react-dom ^19.3.0`, `redux ^5.0.1`, `tsup ^8.5.1`, `typescript ~5.9.3`, `vitest ^5.0.3`, `zustand ^5.0.15`.
- `files`: `dist`, `bin`, `README.md`, `LICENSE`. Scripts: `build` (tsup), `typecheck` (`tsc -p tsconfig.json --noEmit`), `test` (`vitest run`), `test:browser` (`playwright test --config test/browser/playwright.config.ts`).
- `tsup.config.ts` (four configs): (1) the ESM build, `target: "es2022"`, `platform: "browser"`, `splitting: true`, `sourcemap: true`, `treeshake: true`, entries `index`, `auto`, `auto/{observe,guard,heal}`, the adapters, `devtools/index`, `worker`; `external`: `onnxruntime-web`, `onnxruntime-web/webgpu`, `react`, `redux`, `zustand`; `worker` has no `.d.ts` (not in `dts.entry`); its `clean` spares `cdn/**` and `genclass.global*`. (2, 3) `globalBuild(false|true)`: IIFE of `src/cdn/global.ts`, `target: "es2020"`, `define: { __GENCLASS_VERSION__ }` from `package.json`, onnxruntime-web forced external (plugin `ortExternal`), map only for `.min.js`. (4) `dist/cdn/`: `src/cdn/worker.ts`, `ort-webgpu.ts`, `ort-wasm.ts`, minified, onnxruntime-web bundled in (`noExternal`), the worker's `import("onnxruntime-web/webgpu"|"/wasm")` mapped to `src/cdn/ort-*.ts` (plugin `cdnOrt`). The config deletes old `dist/genclass.global*` files before building.
- Git tags: `situation-v1` (= 1a77558, first situation-format freeze, superseded), `situation-v2` (= 6e5e86e, the freeze this branch follows), `v0.1.0-alpha.0` (= 654d822, the first published alpha; same `src` as `situation-v1`) and `v0.1.0-alpha.1` (= 806a296, npm `latest` until 2026-10-08 ~13:40 UTC; local only, not pushed); since then `latest` is `0.1.0-beta.0` (local tag `v0.1.0-beta.0` on 1f0f617, not pushed). origin also has `situation-v2.1` (= 5bc40c9 on origin/runtime, "situation-v2 + no-baseline stall fact (additive)"), which is not an ancestor of this branch. What 806a296 lacks (the zero-code entries f3a9dd1, 29b7f28, 054da38, f107013) was first published in `0.1.0-beta.0`.

### Root module exports

| export | kind | from |
|---|---|---|
| `GenClass` (named and `default`) | const object | `src/index.ts` |
| `createRuntime` | function | `src/index.ts` |
| every type in `types.ts` (`export *`) | types only (`types.ts` has no runtime values) | `src/types.ts` |
| `browserClock` | `Clock` | `src/clock.ts` |
| `GenClassUnavailableError` | class | `src/errors.ts` |
| `createModelHost`, `DEFAULT_MODEL_BASE_URL`; types `ModelHost`, `ModelHostOptions`, `ModelHostStatus`, `ModelHostStats`, `ModelEvaluateRequest` | model host | `src/model/host.ts` |
| `GenClassModelError`, `ModelNotReadyError`, `MaxTokensExceededError`, `ModelInputError`, `ModelUnsupportedError`, `ModelTimeoutError`, `ModelAbortedError`, `ModelBusyError`, `ModelDisposedError`, `ModelLoadError`, `ModelIntegrityError`, `ModelInferenceError`; types `ModelErrorCode`, `LoadAttempt` | model errors (each has `code`) | `src/model/errors.ts` |
| `stateText`, `stateChars`, `sectionLimits`, `STATE_CHAR_BUDGET` (2400; was 3200 in situation-v1), `COMPACT_BUDGET` (1100) | serializer | `src/situation/serialize.ts` |
| `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS` (now with `delivery: ["deliver", "discard", "defer"]`), `PASSIVE` (`delivery: "deliver"`), `DEFAULT_DIAGNOSES` | question vocabulary | `src/situation/questions.ts` |
| `describeElement` | DOM element -> `'button "Place order"'` | `src/observe/dom-user.ts` |
| `RuntimeImpl` | class (advanced; exposes internals) | `src/runtime.ts` |
| `protect(name, fn)` (also `GenClass.protect`) | function wrapper (feat/projects) | `src/protect.ts` |
| `TOKEN_PATTERN` (`/^gc_[A-Za-z0-9]{22}$/`), `isValidToken(v)` | app token format | `src/token.ts` |

Not exported from the root: `util.ts` helpers, `normalizeError`, `policyConfig`/`holdBudget`/`gate`, `COMPACT_QUESTIONS_BUDGET` (1400), `TRIGGER_DESCRIPTIONS` and `ACTION_INSTRUCTIONS` (`situation/questions.ts`). The root export list itself did not change in batch 4/5 (the only `index.ts` change is `eventsource` in `ALL_OFF`), nor with the zero-code entries (`index.ts` and `types.ts` are unchanged since b435acb).

### Zero-code entries (`/auto`, script tag, CLI)

Owner: INSTALL (f3a9dd1, merged from origin/runtime). Not in npm `0.1.0-alpha.1`; in `0.1.0-beta.0` (`latest` since 2026-10-08). Every path ends in `GenClass.init`, so it inherits the singleton (a later `GenClass.init(...)` in app code returns the runtime the entry started and **ignores its options**), the kill switch and the `observe` default mode.

**Page configuration** (`src/cdn/config.ts`), lowest precedence first; `mergeConfig` is a shallow merge where later wins, two `model` objects are merged and `model: false` replaces:

| source | read by | form |
|---|---|---|
| entry defaults | `/auto/<mode>` only (`startAuto({ mode })`); bare `/auto` and the script tag have none | `InitOptions` |
| `<meta name="genclass" content="mode=guard, devtools=local">` (every such tag, in document order) | `/auto*` and the script tag (`readMetaConfig`) | key/value pairs (`parsePairs`: separators `,` `;` or whitespace; keys case-, `-`, `_`-insensitive) |
| `data-*` attributes of the script tag (`data-mode="guard" data-devtools`) | script tag only (`fromDataset`; `data-manual` and `data-base` are not options) | same keys |
| `window.GENCLASS_CONFIG = { ... }` (set before the entry runs) | `/auto*` and the script tag (`readWindowConfig`) | any `InitOptions` plus `devtools` (a shallow copy) |
| `options` of `window.GenClass.init(options)` (highest; the auto-init passes none) | script tag global | `PageConfig` |

Note the order: for `/auto/<mode>` the mode in the import path is the **lowest** precedence, so a `<meta>` or `GENCLASS_CONFIG` mode overrides it; for the script tag the meta tag is below the data attributes. The URL / localStorage kill switch (`?genclass=off|observe|guard|heal`) still beats everything inside `GenClass.init`.

Pair keys (`fromPairs`; unknown keys and invalid values are ignored): `token` (any non-empty value; validated later by `createRuntime`), `scope` (`app|functions`), `mode` (`observe|guard|heal`), `model` (`off`/`false`/`0`/`no`/`none` -> `model: false`; bare/`true` -> defaults; anything else -> `model.baseUrl`), `modelurl` / `baseurl`, `device` (`auto|webgpu|wasm`), `preload` (`eager|idle|lazy`), `ort` / `ortwasmpaths` (-> `model.ortWasmPaths`), `worker` (false only for an "off" word), `report` (`console|silent`), `debug`, `triage` (`salient|always`), `devtools`. `devtools` (`DevtoolsSetting`): bare/`true` -> always; `local`/`dev`/`localhost` -> only when `isLocalHost(location)` (loopback, `*.localhost`, `*.local`, `*.test`, `file:`); a corner (`bottom-right`, `bottom-left`, `top-right`, `top-left`) -> `{ position }`; an "off" word -> not mounted. `devtools` is split off (`splitConfig`) and never reaches `GenClass.init`.

**`@genclass/runtime/auto`, `/auto/<mode>`** (`src/auto.ts`, `src/cdn/auto-*.ts` -> `startAuto(defaults)`):
1. Not a browser (`window` or `document` not an object): return `GenClass.init(defaults)` (the non-browser branch: no observers, no model; meta and window config are not read).
2. Else `GenClass.init(mergeConfig(defaults, meta, window.GENCLASS_CONFIG))` minus `devtools`; if a devtools setting applies and `isKilled` is false, `import("../devtools/index.js")` once `document.body` exists (`whenBody`) and `mountDevtools(rt, options)`; a load failure is a `console.warn`.
3. Default export: that `Runtime` (`import rt from "@genclass/runtime/auto"`); named export `GenClass`. Runs at module evaluation, so it must be the first import of the entry for stores created at import time to see `GenClass.runtime`. The bare `/auto` has no mode default: it runs in `observe`.

**Script tag** (`src/cdn/global.ts`, built to `dist/genclass.global.js` / `.min.js`; `install()` runs at evaluation when `window` and `document` exist):
- Installs `window.GenClass: GenClassGlobal` = `{ version, base, init(options?), runtime (getter), destroy(), devtools(options?), createRuntime, protect, GenClassUnavailableError }`. This is **not** the module `GenClass` object: `init` merges the page configuration under `options`, adds the CDN model wiring and mounts devtools; `destroy` also unmounts the overlay; `devtools()` mounts it (initialising first if needed). A second copy of the tag keeps the first global (`__genclassGlobal` flag).
- Auto-init: `api.init()` at once unless `data-manual` is present (and not `"false"`); a throw is caught and warned.
- `base` (where everything else loads from): `data-base` (resolved, trailing `/` added), else `assetBase(script.src)`: on jsDelivr/unpkg the URL is re-pinned to `@<this file's version>/dist/` (so `@latest` never mixes releases), else the script's directory; fallback `https://cdn.jsdelivr.net/npm/@genclass/runtime@<version>/dist/`. The script element is `document.currentScript`, else the last `script[src]` whose URL looks like this file.
- Model wiring (`withCdnModel`, skipped when `decider` is set or `model === false`): host options `workerFactory` (a module Worker from a same-origin Blob URL that imports `<base>cdn/worker.js`, since browsers refuse cross-origin worker URLs) and `ortLoader` (`<base>cdn/ort-webgpu.js` / `ort-wasm.js`), with the caller's `model` fields spread over them. These are `ModelHostOptions` fields (`model/host.ts`), passed through `ModelOptions` by a cast; they are not in the public `ModelOptions` type. Model weights still come from `DEFAULT_MODEL_BASE_URL` unless `model`/`data-model` says otherwise.
- The IIFE does not contain onnxruntime-web; `dist/cdn/*` bundles it and, only in a worker of a `crossOriginIsolated` page (WASM threads), points the thread glue at `ortWasmPaths` or else the jsDelivr onnxruntime-web directory (`ort-env.ts` -> `prepareOrt`).

**CLI `init` / `remove`** (`bin/lib/init.mjs` -> `run`; consumer view only):
- `init` detects the package manager and framework (`detect.mjs`), installs `@genclass/runtime` (unless `--no-install`; `--from <spec>` picks the spec), and adds, as the first statement of the entry file, `import "<AUTO(mode)>"` (with devtools: `import genclass from "<AUTO(mode)>"` plus a dev-only `if (<dev condition>) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass))` at the end). Plain HTML gets a script tag (`plan.mjs` -> `scriptTag`: jsDelivr URL pinned to the CLI's own version unless `--cdn`; an `integrity` sha384 of the package's local `dist/genclass.global(.min).js` when that file exists, unless `--no-sri`; `data-mode` when a mode other than `guard` is given; `data-devtools="local"` unless `--no-devtools`). It shows the diff and asks unless `--yes`; `--dry-run` writes nothing; running it twice changes nothing.
- Every added line or created file carries the marker `genclass:init` (`edit.mjs` -> `MARK`), except the inline forms used when the insertion point shares its line with other code (a one-line `<head>` or `<body>`), marked `genclass:inline` (`MARK_INLINE`); `remove` deletes exactly the marked lines/blocks/inline forms and uninstalls the package unless `--keep-package` or `--no-install` (or something else still uses it).
- Token (feat/projects; `bin/lib/token.mjs`, `init.mjs` -> `chooseToken`, `tokenRow`, `dashboardNotice`): by default `init` POSTs `https://genclass.dev/api/projects` (`{ name }` from package.json) and writes the token into its config (`genclass.config.*` -> `GENCLASS_CONFIG.token`, `data-token`, Astro meta `token=`), prints the dashboard link and, after the changes are applied, saves `.genclass.local` (and appends it to an existing `.gitignore`). No network with `--token`, `--no-token`, `--no-telemetry`, `--dry-run`, a token already in the marked files, or one in `.genclass.local`. Failure -> warning, no token. Details: [../dashboard-projects.md](../dashboard-projects.md).
- Mode mapping (`plan.mjs` -> `AUTO`): `observe` -> `/auto/observe`, `heal` -> `/auto/heal`, `guard` **or no `--mode`** -> plain `/auto`. On this branch plain `/auto` runs in `observe`, so `init --mode guard` currently produces an observe-mode install, and the CLI's help/summary still call `guard` the default. See Drift.

**Automatic state discovery (branch `feat/one-line`, ships in `0.1.0-beta.4`).** `InitOptions.autoState?: boolean |
AutoStateOptions` (`{ react?, redux?, zustand?, pinia? }`, each default on; `pinia` is ignored). The zero-code entries
default it on (`cdn/auto-start.ts` -> `AUTO_DEFAULTS = { autoState: true }`, merged lowest; `cdn/global.ts` merges
`{ autoState: true }` under the page config); `GenClass.init` / `createRuntime` default off. Page config key
`autostate` / `state` (meta, `data-autostate`): only an off word has an effect (`autoState: false`). Both entries call
`discover/index.ts` -> `registerDiscovery()` (a named call: a bare side-effect import was dropped by tree shaking)
before `GenClass.init`. The main entry does not contain the discovery code (`test/bundle.test.ts`: `/auto` < 98 KB
gzip and carries `__REACT_DEVTOOLS_GLOBAL_HOOK__`, the main entry < 92 KB without it); `GenClass.init({ autoState: true })`
needs `import "@genclass/runtime/discover"` (subpath `./discover` -> `dist/discover.js`, from `src/discover/entry.ts`,
listed in `sideEffects`), which also installs the hooks at its evaluation and lets a later runtime attach; without it
the runtime warns once. The kill switch path of `GenClass.init` never passes `autoState`, so `?genclass=off` installs
no discovery. Mechanics: [state-and-adapters.md](state-and-adapters.md) section 14. New public `Runtime.stores():
StoreInfo[]` (`{ name, kind: "atom"|"guard"|"adapter"|"observed", source?, writable, fields, version }`); internal
`RuntimeImpl.discoveryStats()` (React walk stats, Redux/connected store names); `decisionInfo().autoState` (telemetry
marks the decision event `autoState: true`; the situation text is sent as usual).

**App tokens, `protect()` and `scope` (branch `feat/projects`, ships in `0.1.0-beta.4`).** Server side and the CLI
flow: [../dashboard-projects.md](../dashboard-projects.md).
- `InitOptions.token?: string`: `index.ts` -> `createRuntime` runs `token.ts` -> `resolveToken` (trim; malformed ->
  one `console.warn` on the runtime global's console, ignored; never throws) and passes it to
  `telemetry/index.ts` -> `startTelemetry(..., token)`, which sets `TelemetryConfig.token`; `client.ts` -> `header()`
  writes it as the envelope's first field after `schema`; `TelemetryStatus.token` exposes it. With a token but
  telemetry off and `debug: true`, `createRuntime` logs one `console.info`. The token never reaches `RuntimeImpl`,
  situations or the model.
- `protect(name, fn)` (`src/protect.ts`): resolves the runtime on every call through `setProtectResolver` (set by
  `index.ts` to `GenClass.runtime` when it is a `RuntimeImpl`; tests point it at their own runtime). No runtime ->
  `fn.apply(this, args)`. Else `RuntimeImpl.runProtected(name, fn, this, args)`: `startOp("task", name)` with
  `OpRec.fn = name`, `ctx.run(op, ...)`; a sync throw ends the op `"error"` and rethrows; a native `Promise` result
  is replaced by `r.then(...)` that ends the op and `ctx.stick`s it (like `op()`), so unhandled-rejection behaviour
  is unchanged; any other value or thenable ends the op at once and is returned untouched (never `.then()`-ed). Names
  are trimmed and cut to 80 chars; `name`/`length` of `fn` are copied. Unlike `op()` it never turns a sync function
  async.
- `RuntimeImpl.protectedFnOf(op)`: walks `op.cause` through `ops.get` (≤ 256 steps) and returns the outermost
  `fn`. `trigger()` computes it for `subjectOpOf(spec)` (or the ambient op without materializing a lazy timer op) and
  passes it to `onDecision`, which sets `Decision.fn`; `client.ts` sends it as `fn` on `decision` events.
- `InitOptions.scope?: "app" | "functions"` -> `RuntimeImpl.scope`. `"functions"`: `trigger()` returns the passive
  action before triage when `fn` is undefined (except `ask`), and `runDelivery` releases a delivery at once when its
  op has no protected function in its chain. Recording, learning and situation building are unchanged (test:
  `test/projects.test.ts`, identical situation state for the same subject under both scopes).
- Not implemented: a per-function mode. Route scopes (`OpRec.scope`) are snapshotted per request from the URL/route
  and not inherited through the cause chain, so `protect(name, fn, { mode })` would need that inheritance first
  (`OPEN_TASKS.md`).

### Modes and tiers

`Mode = "observe" | "guard" | "heal"`; `Tier = "passive" | "guard" | "heal"` (`types.ts`). The mode-tier rule is `src/decide/policy.ts` -> `modeAllows`:

| mode | permitted tiers | holds | notes |
|---|---|---|---|
| `observe` (**default**, `o.mode ?? "observe"`) | passive only | never (`trigger()` never waits because `permittedActions` is empty; `hub.hooks.mayHold` also returns false; `deliveryHoldable` is false, so responses and messages are released synchronously, before any body read) | Decisions are still made in the background (deadline 5,000 ms) and recorded (`executed: false`, reason mentioning observe mode), so `decide`/`detect`/report lines work, for deliveries too since 054da38; `interventions()` stays empty. Pinned by `test/default-mode.test.ts`, `test/observe-delivery.test.ts`, `policy.test.ts`. |
| `guard` (opt-in) | passive, guard (`discard`, `defer`, `coalesce`, `delay`, guard-tier custom actions) | when a guard action is permitted for the trigger and `expectedLatency() <= holdBudgetMs()` | Store writes are held only with `policy.holdWrites: true`; otherwise writes apply at once and `discard` can only late-revert them. |
| `heal` (experimental) | passive, guard, heal (`block`, `serve_cached`, `retry`, `hedge`, `rollback`, `resync`, custom actions (`rt.action` or plugins), which default to heal) | when any non-passive action is permitted (same latency and `holdWrites` conditions) | The sim runs in `heal`. |

Ways to choose the mode: `GenClass.init({ mode })`, `createRuntime({ mode })`, `?genclass=guard` / `localStorage.genclass = "guard"` (facade only, so also every zero-code entry), `import "@genclass/runtime/auto/guard"` (or `/observe`, `/heal`), `<meta name="genclass" content="mode=guard">`, the script tag's `data-mode="guard"`, `window.GENCLASS_CONFIG = { mode: "guard" }`, `genclass-runtime init --mode <m>` (but see Drift for `guard`), `rt.setMode(...)`, or the devtools mode switch (`src/devtools/index.ts` -> `MODES`: buttons "Observe" / "Guard" / "Heal" whose tooltips start "Observe (default)", "Guard (opt-in)", "Heal (experimental)").

Threshold defaults (`policyConfig`): `report` 0.6, `guard` 0.9, `heal` 0.8. The full gate is in [decide-policy-actions.md](decide-policy-actions.md).

### `InitOptions` (`types.ts` -> `InitOptions`)

Defaults below are what `RuntimeImpl`'s constructor applies, unless the row says otherwise. `GenClass.init` changes some of them per path (see [GenClass.init](#1-genclassinitoptions)).

| option | type | default | effect / where read |
|---|---|---|---|
| `mode` | `Mode` | `"observe"` (`o.mode ?? "observe"`, f3636b2; was `"guard"` up to origin/runtime 74f17c0 and in npm `0.1.0-alpha.0`) | Initial mode; the kill switch overrides it in `GenClass.init`. Change later with `setMode`. |
| `model` | `ModelOptions \| false` | `GenClass.init` in a browser: `{}` (load the local model with defaults) unless `decider` is given or `model === false`. `createRuntime`: no model unless an object is passed. | Read only in `index.ts` -> `createRuntime`; `RuntimeImpl` never reads it. |
| `decider` | `DecisionProvider \| null` | `undefined` | Any provider (test double, sim, custom). Wins over `model`. `null` means "no model" even if `model` is an object. |
| `report` | `"console" \| "silent" \| (r: Report) => void` | `"console"` | Report sink (`Reporter`). `GenClass.init` defaults it to `"silent"` outside a browser. `on("report")` listeners get every report regardless of the sink. |
| `observe` | `Partial<Record<ObserverName \| "untrustedEvents", boolean>>` | every observer on (now ten, including `eventsource`), except `timers`, which is on only when `global.document` is a non-null object; `untrustedEvents` false | `RuntimeImpl.installObservers`; unknown keys ignored. Forced to all-off outside a browser, by the kill switch and in the init fallback. `untrustedEvents: true` (batch 4) makes the `user` observer record synthetic DOM events (`isTrusted === false`) as user actions too, for in-page test harnesses such as `realapps/` ([../realapps.md](../realapps.md)); it is passed as `installDomUser(g, { untrusted })`. It is not an observer and is not in `ALL_OFF`. |
| `triage` | `"salient" \| "always"` | `"salient"` | `"salient"`: ask only when some fact is non-neutral (or a standing question has `always: true`). `"always"`: build and ask for every consultable trigger (tests). |
| `policy` | `PolicyOptions` | see [PolicyOptions](#policyoptions) | `policyConfig(o.policy)` once at construction (not changeable later). |
| `redact` | `(path: string, value: unknown) => unknown` | `util.ts` -> `defaultRedact` (leaf-field rule, `isSensitivePath`) | Return something not `Object.is`-equal to the value to redact (`describe` and `redactSearch` compare with `Object.is` since ad24804, so `NaN` no longer counts as redacted). Used by the hub, invariant miner, observers, `emit`, `user`, situation building. |
| `plugins` | `Plugin[]` | `[]` | Installed with `use()` at the end of the constructor. |
| `historySize` | `number` | `500` | `EventLog` ring buffer size; effective minimum 16 (`new Array(Math.max(16, size))` in `src/trace/events.ts` -> `EventLog`). `NaN`, or a non-integer of 16 or more, makes `new Array(...)` throw `RangeError` in the constructor (`createRuntime` throws; `GenClass.init` falls back to the inert runtime); a fraction below 16 is silently raised to 16. |
| `debug` | `boolean` | `false` | `RuntimeImpl.log` -> `console.debug("[GenClass] ...")`: every decision, plus otherwise-silent failures (observer install, plugin setup, listener, model, passive/situation build errors). |
| `learn` | `{ persist?: boolean }` | `persist: false` | Transition profiles to `global.localStorage` key `genclass.profiles.v1`: loaded at construction; a settled point that had queued ops to profile schedules one write 5,000 ms later (`saveProfilesSoon`; not a debounce: while a write is pending, later settled points do not reschedule it). |
| `vocabulary` | `Vocabulary` (`{ diagnoses?: Record<string,string>; actions?: Partial<Record<string,string>> }`) | `undefined` | `diagnoses` replaces `DEFAULT_DIAGNOSES`; `expected` is always kept (added from the defaults if missing, always first) and plugin labels are added only when the label is not already present (`situation/questions.ts` -> `diagnosisVocabulary`). `actions[name]` overrides the description of a built-in **or custom** action (`situation/questions.ts` -> `actionDescription`: vocabulary, then `ActionDef.description`, then the trigger-specific built-in wording in `TRIGGER_DESCRIPTIONS` (situation-v2: `delivery`'s `deliver`/`discard`/`defer`), then `BUILTIN_ACTIONS[name].description`). The override applies to every trigger an action appears on. Changes model input wording. |
| `settleMs` | `number` | `60` | Quiet time before a settled point. |
| `situation` | `{ budget?: number \| "auto" }` | `"auto"` | Situation size in characters. A number is used as is (no device sizing, no budget scale). See `situationBudget()`. |
| `token` | `string` | none | App token for the dashboard (`gc_` + 22 base62). Telemetry only: sent on the batch envelope; malformed -> one warning, ignored. See above. |
| `scope` | `"app" \| "functions"` | `"app"` | `"functions"`: decisions only for activity inside `protect()`ed functions (`RuntimeImpl.trigger`, `runDelivery`). |

### `CreateOptions` (`types.ts` -> `CreateOptions extends InitOptions`)

| option | type | default | effect |
|---|---|---|---|
| `clock` | `Clock` | `browserClock` | All time and scheduling of this runtime (and of a model host it creates). |
| `global` | `object` | `globalThis` | The object whose `fetch`, `XMLHttpRequest`, `WebSocket`, `addEventListener`, timers, `history`, `localStorage`... are instrumented; also used for `app()` defaults, `location.href` (URL resolution) and `learn.persist` storage. Not used by the kill switch, `browserClock`, console reporting or the model host's idle scheduling (those use `globalThis`). |
| `app` | `() => { title?: string; route?: string }` | `global.document.title` and `global.location.pathname` (`RuntimeImpl.appInfo`) | App line of every situation. |
| `hooks` | `RuntimeHooks` | `{}` | `opCreated(op)` (sync, in `startOp`) and `mutationProposed({ id, store, paths, cause?, changes })` (sync, inside `set`, before gating). Exceptions swallowed. |

`RuntimeImpl`'s constructor additionally accepts internal fields `decider?: DecisionProvider | null` (already resolved) and `ownsDecider?: boolean`; `createRuntime` sets both.

### `ModelOptions` (`types.ts` -> `ModelOptions`; defaults applied in `src/model/host.ts`)

| option | type | default | defined in |
|---|---|---|---|
| `baseUrl` | `string` | `DEFAULT_MODEL_BASE_URL` = `"https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/"`, resolved against `globalThis.location.href` | `model/host.ts` -> `DEFAULT_MODEL_BASE_URL`, `resolveBaseUrl` |
| `device` | `"auto" \| "webgpu" \| "wasm"` | `"auto"` | `model/host.ts` -> `Host` constructor |
| `worker` | `boolean` | `true` (only `false` disables the module Worker; inline fallback otherwise) | `model/host.ts` -> `Host.start` |
| `preload` | `"eager" \| "idle" \| "lazy"` | `"idle"`: after the `load` event (or at most 5,000 ms), then `requestIdleCallback` with a 2,000 ms timeout, or a 1,000 ms clock timer when it is missing | `model/host.ts` -> `scheduleIdle` |
| `ortWasmPaths` | `string` | `https://cdn.jsdelivr.net/npm/onnxruntime-web@<installed ORT version>/dist/` (fallback version `1.30.0`) | `model/backend.ts` -> `ortCdnBase` |
| `cacheName` | `string` | `"genclass-runtime-v1"` (Cache Storage) | `model/loader.ts` -> `DEFAULT_CACHE_NAME` |

`createRuntime` adds `fetch` (see [createRuntime](#2-createruntimeoptions)) and `clock` before calling `createModelHost`. Host-only knobs (`timeoutMs` 10,000, `maxQueue` 32, `maxThreads`, ...) are in `ModelHostOptions`, not `ModelOptions`; to set them, build a host with `createModelHost` and pass it as `decider` (then the runtime does not own it). Details: [model-host.md](model-host.md).

### `PolicyOptions`

Summary only; semantics in [decide-policy-actions.md](decide-policy-actions.md). Defaults from `src/decide/policy.ts` -> `policyConfig`.

| field | default |
|---|---|
| `thresholds` | `{ report: 0.6, guard: 0.9, heal: 0.8 }` |
| `allow` | unset (all applicable actions) |
| `deny` | `[]` |
| `holdBudgetMs` | `"auto"`: `clamp(round(1.5 × median of the last 20 provider latencies, else status.warmupMs), 150, 800)`; 300 when neither is known (`HOLD_MIN_MS`, `HOLD_MAX_MS`, `HOLD_FALLBACK_MS`). A number is used as `Math.max(0, n)` (no clamp to 150..800). |
| `holdUserWrites` | `false` (copied to `hub.holdUserWrites`) |
| `holdWrites` | `false` (batch 4; copied to `hub.holdWrites`). false: store writes are never held, decisions are taken at the network boundary (`delivery`) and uncovered salient writes are decided in the background. true: salient writes wait for the model without reordering a store's writes. |
| `maxActionsPerMinute` | `60` |
| `requireDiagnosis` | `true` |

### The `Runtime` interface (`types.ts` -> `Runtime`; all implemented in `runtime.ts` -> `RuntimeImpl`)

| member | signature | what it does | owning doc |
|---|---|---|---|
| `ready` | `readonly ready: Promise<void>` | Getter. No decider: `Promise.resolve()`. Otherwise calls `decider.ready()` once and memoises the promise (also starts a lazy load). Rejects if the load fails, and keeps returning that rejected promise. | [model-host.md](model-host.md) |
| `status` | `readonly status: ModelStatus` | `decider.status`, or `{ state: "off" }` without a decider. | [model-host.md](model-host.md) |
| `mode` | `readonly mode: Mode` | Current mode. | this doc |
| `atom` | `atom<T>(name, initial, opts?): Atom<T>` | Register (or reuse) a GenClass-owned store. Same name and kind `"atom"`: returns a handle to the existing store, ignores `initial`, merges `opts` when `resync`/`describe`/`hold` given. Any other existing store of that name is replaced. | [state-and-adapters.md](state-and-adapters.md) |
| `guard` | `guard<T>(name, io: StoreIO<T>, opts?): Guarded<T>` | Wrap an app-owned store; always (re)registers, replacing a same-name store. | [state-and-adapters.md](state-and-adapters.md) |
| `adapter` | `adapter<T>(name, io: AdapterIO<T>, opts?): AdapterHandle<T>` | Seam for state libraries: `propose({ fn?/value?, commit })`, `dispose()`. `writable` only when `io.set` exists. | [state-and-adapters.md](state-and-adapters.md) |
| `expect` | `expect(name, predicate: () => boolean): () => void` | Developer invariant, checked at settled points (`miner.addExpect`). Returns a remover. | [state-and-adapters.md](state-and-adapters.md) |
| `ask` | `ask<Q extends Question>(q, opts?: AskOptions): Promise<AnswerOf<Q>>` | Ask the model about the current situation (trigger `ask`). See [ask flow](#6-ask-and-decide). | [model-io-contract.md](../model-io-contract.md) |
| `decide` | `decide<L extends string>(question, options: Record<L,string>, opts?): Promise<L>` | `ask({ type: "choice", instructions: question, criteria: options })` and return `.choice`. | this doc |
| `on` | `on<K extends keyof RuntimeEvents>(type, fn): () => void` | Subscribe; returns an unsubscribe function. An unknown `type` (bypassing TypeScript) throws `TypeError` (no listener `Set`). Listeners are snapshotted per fire, so (un)subscribing inside a listener takes effect from the next fire. | [Events](#events-runtimeevents) |
| `op` | `op<T>(name, fn, meta?): Promise<T>` | Run `fn` as a `"task"` op (ambient while it runs and when it settles). `meta.detail` (string) becomes the op detail. A sync throw ends the op with `"error"` and returns a rejected promise (never throws synchronously). | [observe-and-trace.md](observe-and-trace.md) |
| `emit` | `emit(name, data?): void` | Push a `custom` event under the ambient op. Each `data` value goes through `redact(key, value)`; a `summary` key (`k=v ...`, truncated to 80 chars) is added. | [observe-and-trace.md](observe-and-trace.md) |
| `user` | `user<T>(action: UserAction, handler?): T \| undefined` | Record an instantaneous `"user"` op (`cause: null`) named `` `${kind} ${target}` `` and run `handler` inside it (returns its result; `undefined` without a handler). `kind` falls back to a legacy `action.action` field, then `"action"`. `value` becomes `"[redacted]"` when `sensitive` or `redact(target, value)` changes it, and is stored as the op `detail` JSON-quoted and truncated to 40 chars. Consecutive `type` actions on the same target within 1,000 ms (`TYPING_BURST_MS`) update one event (`data.count`). | [observe-and-trace.md](observe-and-trace.md) |
| `reportError` | `reportError(error, info?: { source? }): void` | No-op after destroy. Normalises (`normalizeError`), records an `error` event, raises the `error` trigger (not held, priority 0). Its `rollback` controller (`revertChain`) needs the ambient op at report time; without one it throws (recorded as a failed action, passive runs); applicability normally keeps it from being offered then. Keeps the last 64 errors (10 s window) for facts. | [decide-policy-actions.md](decide-policy-actions.md) |
| `use` | `use(plugin): () => void` | Install a plugin (idempotent per object). | [Plugins](#plugin-api) |
| `action` | `action(def: ActionDef): () => void` | Add a custom action; returns a remover. No name de-duplication. | [decide-policy-actions.md](decide-policy-actions.md) |
| `question` | `question(def: StandingQuestion): () => void` | Add a standing question; returns a remover. | [decide-policy-actions.md](decide-policy-actions.md) |
| `situation` | `situation(trigger?): Situation` | With a non-`ask` trigger that was built before: the **last situation built for that trigger** (`lastBuilt`). Otherwise builds "ask about now" and, if a trigger was given, returns it with `trigger` overwritten. Records nothing (only caches `op.reads`). | [learn-situation-triage.md](learn-situation-triage.md) |
| `explain` | `explain(id): Explanation \| null` | Decision id `"d<n>"` or action id `"a<n>"` -> message, decision, situation text, facts, timeline, answers, action, changed. The decision and its action share one record, so `explain("d<n>")` of a decision whose action ran also returns `action`/`changed` and the intervention line as `message` (else the detection line when detected, else `decisionLine`). Eviction: when a decision is recorded and the map exceeds 400 (`DECISIONS_KEPT * 2`), the single oldest entry is deleted; action entries (`a<n>`) are added in `finish` without any eviction check, so the map grows by one entry per executed action beyond 400 (see Drift). | [decide-policy-actions.md](decide-policy-actions.md) |
| `history` | `history(n?): RtEvent[]` | `events.last(n)`: last `n` events (default all kept), oldest first. `history(0)` is empty; `k = Math.min(n, count)`, so a negative `n`, or a fractional `n` below the number of kept events, throws `RangeError` (`new Array(k)`). | [observe-and-trace.md](observe-and-trace.md) |
| `decisions` | `decisions(n = 200): Decision[]` | Last `n` decisions (buffer of 200). Note `decisions(0)` returns all (`slice(-0)`). | [decide-policy-actions.md](decide-policy-actions.md) |
| `interventions` | `interventions(n = 200): ActionRecord[]` | Last `n` non-passive actions that ran (buffer of 200). Same `0` quirk. | [decide-policy-actions.md](decide-policy-actions.md) |
| `inflight` | `inflight(): Op[]` | Snapshot array of in-flight ops. The elements are live internal `OpRec` objects: do not mutate. | [observe-and-trace.md](observe-and-trace.md) |
| `holdBudgetMs` | `holdBudgetMs(): number` | `holdBudget(policy, queue.latencies(), decider?.status.warmupMs)`. | [decide-policy-actions.md](decide-policy-actions.md) |
| `situationBudget` | `situationBudget(): number` | See [Configuration](#configuration-and-constants). | [learn-situation-triage.md](learn-situation-triage.md) |
| `setMode` | `setMode(mode): void` | Ignores anything but the three modes. Sets the mode, emits a status report `"[GenClass] Mode set to <mode>."` and fires `status` with the current `ModelStatus` (even if unchanged). | this doc |
| `pause` | `pause(): void` | `paused = true`, `hub.gating = false`: no triggers, no holds, requests not gated; tracing continues. `ask()` still works. | this doc |
| `resume` | `resume(): void` | No-op after destroy; else `paused = false`, `hub.gating = true`. | this doc |
| `destroy` | `destroy(): void` | Idempotent teardown; see [destroy order](#9-destroy). | this doc |

`RuntimeImpl` members that are **not** on `Runtime` (use only from tests, the sim, devtools or internal code; cast to `RuntimeImpl`):

| member | purpose |
|---|---|
| `clock`, `global`, `events`, `ops`, `ctx`, `hub`, `base`, `profiles`, `miner`, `cache` | Public readonly subsystem fields (tests read `rt.ops.byId`, `rt.hub` ...). |
| `internals` (getter) | `RuntimeInternals = { hub, ops, events, base, profiles, miner, ctx, clock }`. |
| `isPaused` (getter) | Whether `pause()` is in effect. No caller in the repo. |
| `setReport(sink)` | Swap the report sink at runtime (`Reporter.setSink`). JSDoc says "(devtools)" but nothing in the repo calls it. |
| `constructor(o: CreateOptions & { decider?, ownsDecider? } = {})` | Direct construction never reads `o.model` (no model host is created) and ignores the kill switch; use `createRuntime` unless you are resolving the decider yourself. |
| `build(spec: SubjectSpec): BuiltSituation` | Build a situation for a subject spec without triggering. |
| `trigger(spec, ctl, opts)` | Entry point for observers: triage, hold, queue, gate, act (see [decide-policy-actions.md](decide-policy-actions.md)). |
| `runDelivery(o, release, defers = 0)` | The delivery gate (declared without `private`; reached through the closures `netHost().deliver` (fetch/XHR) and `wsHost().deliverMessage` (WebSocket/EventSource)). Each call releases at most once (per-call `released` flag); a `defer` re-enters it with the same `release`. |
| `startOp(kind, name, o?)`, `endOp(op, status, o?)` | Op creation/completion with events, baselines, profiling queue, `hooks.opCreated`, settle scheduling. |
| `runAsGenClass(name, fn)` | Run `fn` inside an instant `"genclass"` op (`cause: null`): its writes and requests are never gated. |
| `settled()` | Run a settled point now (normally called by the settle timer). |
| `chainWrites(op)`, `revertChain(op, why)`, `rollback(stores, violationIds?, beforeSeq?)`, `resync(stores)` | Action implementations for error/transition/inconsistency triggers. |

### Events (`RuntimeEvents`)

| type | payload | fired from | when |
|---|---|---|---|
| `detect` | `Detection` (= `Decision`) | `RuntimeImpl.onDecision` | `decision.diagnosis !== "expected"` and `diagnosisConfidence >= policy.thresholds.report` (0.6), whether or not an action ran. Fired right after `decide`. |
| `decide` | `Decision` | `RuntimeImpl.onDecision` | Every model decision on a trigger (not for `ask`/`decide` calls, not while loading, not for triage-skipped triggers, and not when the queue returns no answer: deadline passed, queue overflow, subject already superseded (`ctl.stale`), provider no longer `ready` at dispatch, provider error or timeout, runtime destroyed). |
| `act` | `ActionRecord` | `onDecision` -> `finish` | Every non-passive action that ran (also failed ones, `ok: false`), after its effect resolved. |
| `event` | `RtEvent` | `EventLog.onEvent` / `EventLog.touch` | Every traced event; a typing burst re-fires the same (mutated) event object. |
| `status` | `ModelStatus` | `decider.onStatus` subscription; `setMode` | Model status changes; also on every `setMode` call (devtools refreshes its mode view on it). |
| `report` | `Report` (`{ kind: "detect" \| "intervene" \| "status", message, decision?, action? }`) | `Reporter.emit` listener | Every report, before the sink: also with `report: "silent"`, and without the console's one-minute de-duplication. |

Order inside one decision (`RuntimeImpl.onDecision`): `event` (an `RtEvent` of kind `"decision"`) -> `decide` -> `detect` (if detected) -> standing-question `onAnswer` callbacks -> either (no action runs: `ctl.passive()`, then a `report` detect line if detected) or (action runs: `rate.take`, the action, and once its effect resolves or fails: `event` (kind `"action"`) -> `act` -> `report` intervene line). A failed action (throw or rejection) runs the passive action first and records `ok: false`.

Trigger priorities (`EvaluateRequest.priority`, higher is served first by `DeciderQueue`): held `delivery` (`runDelivery`; a background delivery is submitted with `hold: false, priority: 2`, capped to 1), held `mutation` (`gateMutation`, only with `holdWrites`), `request` and fetch `failure` = 2; background `mutation` (`observeWrite`, the default write path), `stall`, `inconsistency`, XHR `failure`, `ask` = 1; `transition`, `error` = 0. A holdable trigger that does not actually wait is capped at 1 (`Math.min(priority, 1)` in `trigger`), which in the default `observe` mode is every trigger.

Queued requests can be dropped before dispatch: `trigger` passes `ctl.stale` to `DeciderQueue.submit` as a third argument, and the queue resolves `null` (fail open) for an item whose subject was already delivered, overwritten or superseded. Exception (054da38): for a `delivery` that did not wait, `stale` is not passed (a released delivery is always "stale"), so its background decision is still made and recorded.

Status reports emitted by the runtime itself: `"[GenClass] Model ready (<model>, <device>, <variant>, <secs>). Mode: <mode>."`, `"[GenClass] Model unavailable (<error>); observing only."`, `"[GenClass] Mode set to <mode>."`, `"[GenClass] Rate limit reached (<n> actions/minute): running passive actions until it clears."` (at most once per 60,000 ms).

### Plugin API

`Plugin` (`types.ts`): `{ name; setup?(api: PluginApi): void | (() => void); facts?(sit: SituationDraft): string[]; actions?: ActionDef[]; questions?: StandingQuestion[]; diagnoses?: Record<string, string> }`.

`RuntimeImpl.use(plugin)`:
1. Already installed (same object): return a remover, do nothing else.
2. Register `plugin.actions` into `customActions` and `plugin.questions` into `standing` (before `setup` runs).
3. Call `plugin.setup(this.pluginApi())` in try/catch; a returned function is kept as cleanup. A throwing `setup` is only logged with `debug: true`; the plugin's actions/questions/facts stay registered.
4. `facts` and `diagnoses` are read live at every situation build (`RuntimeImpl.buildOpts`), in plugin insertion order.
5. The remover (`unuse`) removes exactly this plugin's action and question objects (by identity) and calls cleanup (errors ignored). `destroy()` unuses every plugin.

`PluginApi` (built by `RuntimeImpl.pluginApi`):

| member | behaviour |
|---|---|
| `runtime`, `clock` | The runtime and its clock (devtools installs a plugin whose `setup` only captures `api.clock`, the runtime's clock, virtual in tests/sim). |
| `emit(name, data?)` | Same as `rt.emit`. |
| `recordOp(kind, name, meta?)` | `startOp(kind, name, { detail?, identity?, meta: meta.data })`, cause = ambient op; returns the op id. Not instant. `fetch`/`xhr` kinds feed latency baselines. |
| `endOp(id, status = "ok", info?)` | Ends the op (`code`, `errorText` from `info.error`); silently ignored when the id is unknown or pruned. |
| `runInOp(id, fn)` | Run `fn` with that op ambient; runs `fn` without context when the id is unknown. |
| `user`, `reportError`, `on` | Same as the `Runtime` methods. |
| `stores.names()`, `stores.get(name)` | Registered store names; current value via `hub.read` (or `undefined`). The value is not cloned: do not mutate it. |

Note: `pluginApi()` builds a fresh object per `use()` call; it holds no per-plugin state, so ops started with `recordOp` are not ended when the plugin is removed.

`ActionDef`, `ActionContext` (`builtin`, `describe`, `onUndo`), `StandingQuestion` (`always`, `onAnswer`) and how custom actions pass the policy gate are in [decide-policy-actions.md](decide-policy-actions.md).

### Clock (`types.ts` -> `Clock`, `clock.ts` -> `browserClock`)

```ts
interface Clock {
  now(): number;                                   // ms, monotonic
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  afterTask(fn: () => void): void;                 // after the current macrotask's microtasks drain
}
```

`browserClock`:
- Captures `setTimeout`, `clearTimeout`, `setImmediate`, `MessageChannel` and `performance` from `globalThis` **at module load**, so the runtime's own timers never pass through its timers observer (which wraps the app's global `setTimeout`).
- `now()`: `performance.now()`; without it, a counter that increases by 1 per call (never `Date.now`).
- `setTimeout(fn, ms)`: clamps `ms` to `>= 0`; throws `"GenClass: no setTimeout available; pass a clock"` when none was captured; in Node (no `window`) calls `unref()` so housekeeping timers never keep the process alive.
- `clearTimeout(h)`: ignores `null`/`undefined`.
- `afterTask(fn)`: queues `fn`; one flush per macrotask. Transport preference: `setImmediate` when there is no `window` (Node and Node-hosted DOM shims), else `MessageChannel` (ports `unref`'d), else `setImmediate`, else `setTimeout(0)`. Callback exceptions are swallowed.
- Module-load side effects: `hasWindow` (`typeof globalThis.window === "object" && window !== null`) is fixed when `clock.ts` is evaluated, and `afterTask` is built then (`makeAfterTask()`), so importing the root module constructs one `MessageChannel` in a browser. A `window` defined after import does not change the transport or the Node `unref` behaviour.

Test clock: `packages/runtime/test/helpers.ts` -> `FakeClock` (starts at `t = 1000`; `flush()` drains microtasks then afterTask hooks; `advance(ms)` runs due timers in order, each as its own macrotask; `runAll(maxMs = 120000)`). The sim injects its own virtual clock ([sim.md](../sim.md)).

### Errors

`GenClassUnavailableError` (`errors.ts`), `name = "GenClassUnavailableError"`, field `reason`:

| reason | thrown by `ask`/`decide` when | message |
|---|---|---|
| `"destroyed"` | the runtime was destroyed | `this GenClass runtime was destroyed` |
| `"off"` | there is no decider | `GenClass has no model (model: false)` |
| `"timeout"` | `timeoutMs` elapsed while waiting for the load, or for the answer | `the model did not load in time` / `the model did not answer in time` |
| `"error"` | the load failed (no `timeoutMs`), the status is still not ready after waiting, or no answer came back | `the model failed to load: ...` / `the model is <state>` / `the model could not answer` |

Provider errors (`GenClassModelError` subclasses, `code` in `ModelErrorCode`) never escape a trigger: `DeciderQueue` turns them into `null` and the runtime fails open. The one code the runtime reacts to is `max_tokens_exceeded` (budget scale). Codes: [model-host.md](model-host.md).

`runtime.ts` -> `normalizeError(error, source?)` (exported from `runtime.ts`, not from the root; only caller is `reportError`) returns `ErrorInfo` (`situation/env.ts`): `{ name, message, raw, key, source? }`. `name`/`message` come from an `Error` or any object with a `message`; a string becomes the message; anything else is `JSON.stringify`'d (falling back to `String`). `key` = `` `${name}:${message with every digit run replaced by "n", first 120 chars}` `` groups repeats of the same error for the `errorsRecent` facts.

`index.ts` -> `failedProvider(message)`: the stand-in decider when `createModelHost` throws. Its `status` is the fixed object `{ state: "error", error: "model host unavailable: <msg>" }`, `ready()`/`evaluate()` reject with `Error(message)`, and it has no `onStatus` and no `dispose`, so no `"Model unavailable"` status report is printed: the only trace is `rt.status.error`.

### Type catalogue (`types.ts`, by section)

| section | types | detailed in |
|---|---|---|
| model seam | `JevState`, `Question`, `NoulAnswer`, `ChoiceAnswer`, `ScoreAnswer`, `Answer`, `AnswerOf`, `TriggerKind`, `ModelStatus`, `SubjectRef`, `EvaluateRequest`, `DecisionProvider` | [model-io-contract.md](../model-io-contract.md) |
| clock | `Clock` | this doc |
| trace | `EventKind`, `RtEvent`, `OpKind`, `OpStatus`, `Op`, `UserAction` (new `clicks?: number`, the browser click count) | [observe-and-trace.md](observe-and-trace.md) |
| state | `StoreOptions`, `Atom`, `Guarded`, `StoreIO`, `AdapterIO`, `AdapterHandle`, `Change` | [state-and-adapters.md](state-and-adapters.md) |
| options | `Mode`, `Tier`, `ObserverName`, `PolicyOptions`, `Vocabulary`, `RuntimeHooks`, `ModelOptions`, `InitOptions`, `CreateOptions` | this doc |
| questions | `AskOptions` (`about?: "now" \| number /* op id */ \| string /* store */`, `timeoutMs?`) | this doc |
| situations | `FactKind`, `Fact`, `Situation`, `RequestInfo`, `SituationDraft` (new `delivery?: { channel: "response" \| "websocket" \| "eventsource"; predicted; conflicts }`) | [learn-situation-triage.md](learn-situation-triage.md) |
| decisions | `Decision`, `Detection`, `ActionRecord` (new `dropped?: string[]` for delivery `discard`), `Report`, `Explanation` | [decide-policy-actions.md](decide-policy-actions.md) |
| plugins | `ActionContext`, `ActionDef`, `StandingQuestionContext`, `StandingQuestion`, `PluginApi`, `Plugin` | this doc / [decide-policy-actions.md](decide-policy-actions.md) |
| runtime | `RuntimeEvents`, `Runtime` | this doc |

Key literal unions: `TriggerKind = "mutation" | "request" | "delivery" | "failure" | "stall" | "inconsistency" | "transition" | "error" | "ask"` (`delivery` new in batch 4; `SubjectRef.op` is the fetch op or the WebSocket/EventSource message op); `ObserverName = "fetch" | "xhr" | "user" | "errors" | "nav" | "storage" | "perf" | "websocket" | "eventsource" | "timers"`; `ModelStatus.state = "off" | "loading" | "ready" | "error"`. Adding a `TriggerKind` forces entries in every `Record<TriggerKind, ...>` (`TRIGGER_ACTIONS`, `PASSIVE`, `ACTION_INSTRUCTIONS`, `report.ts` -> `NOUN`), and the model seam is mirrored by `sim/src/types.ts`.

### `RuntimeImpl` state (private fields, `runtime.ts`)

| field | holds | bound |
|---|---|---|
| `_mode`, `paused`, `destroyed` | lifecycle flags | |
| `decider`, `ownsDecider`, `_ready` | provider, ownership, memoised `ready` promise | |
| `queue: DeciderQueue` | one evaluation at a time, priorities, 30 s answer cache, deadlines, latency samples | 32 queued, 20 latencies |
| `reporter: Reporter` | report sink + console de-dup windows | 60,000 ms windows |
| `policy: PolicyConfig`, `rate: RateLimiter` | resolved policy; action timestamps | `maxActionsPerMinute` |
| `listeners` | one `Set` per `RuntimeEvents` key | |
| `uninstall` | teardown functions (status subscription first, then observers in install order) | |
| `plugins: Map<Plugin, { cleanup? }>`, `customActions`, `standing` | extension registry | |
| `decisionsBuf`, `actionsBuf` | recent decisions / interventions | 200 each (`DECISIONS_KEPT`) |
| `explainMap` | explain records keyed by `d<n>` and `a<n>` | soft: one oldest entry evicted per decision once over 400 (`DECISIONS_KEPT * 2`); action entries are never evicted on insert, so it grows by one per executed action |
| `lastBuilt` | last built situation per trigger (for `situation(trigger)`) | 1 per trigger |
| `storeWriters` | op signature -> store -> writes by its chains | 1,000 signatures |
| `lastChainMap` | non-user op signature -> normalised field paths its last chain wrote (predicted writes for the delivery gate, `env.lastChain`) | 1,000 signatures (oldest deleted) |
| `cadence: Cadence` | learned schedules / debounces per request signature (F6, `env.cadence`) | see `learn/cadence.ts` |
| `createsBuf` | create responses (POST or 201) with the ids they returned (read-your-writes, `env.creates`), filled by `noteResponse` | 16 entries, 30 s |
| `outcomesBuf` | completed non-aborted fetch/XHR outcomes across signatures (failure scope, F5, `env.outcomes`) | 128 entries, 30 s |
| `channelsDown` | `"<channel> <path>"` -> when and why a WebSocket/EventSource went down (F9 marks on reconnect) | one per channel |
| `deliveryPending` | `WeakSet<OpRec>`: background deliveries whose decision is pending; `covered` treats their chain's writes as covered (054da38) | removed when the decision settles or fails |
| `deliveryAnalysis` | `Map<OpRec, cut>`: background deliveries whose body is still being read; `hooks.proposed` -> `finalizeDeliveries(m.cause)` runs `cut` at the chain's first write (054da38) | cleared in `destroy()` |
| `identicalMap` | request identity -> recent ops | 12 per identity, 512 identities, 10 s |
| `errorsRecent` | recent error keys | 64, 10 s window (pruned when an error is recorded; `env.recentErrors()` only filters, so situation building changes no state, 29b7f28) |
| `toProfile` | ops waiting for the next settled point | 2,000 |
| `snaps` | consistent snapshots `{ t, seq, values }` (newest last) | 8 |
| `episode`, `muted` | violations raised in the current episode; violations whose rollback was undone | |
| `settleTimer`, `persistTimer` | clock handles | |
| `nextDecision`, `nextAction`, `uniq` | id counters (`d<n>`, `a<n>`, `uniq:<n>`) | |
| `budgetScale`, `rateWarnedAt`, `lastTyping`, `lastUserEvent` | adaptive budget, warning throttle, typing-burst state | |
| `env: SitEnv` | read-only view handed to situation building (`makeEnv`) | |

## How it works

### 1. `GenClass.init(options)`

`index.ts` -> `GenClass.init`:
1. If `current` is set, return it (options ignored).
2. Call `initUnsafe(options)` inside try/catch. On any throw: `console.warn("[GenClass] Could not start (<msg>); running without it.")`, set `current = createRuntime({ observe: ALL_OFF, decider: null, report: "silent", mode: "observe" })` and return it.

`index.ts` -> `initUnsafe`:
1. `killSwitch(globalThis)`: read `new URLSearchParams(location.search).get("genclass")`; only if that is empty/absent, read `localStorage.getItem("genclass")`. Both reads are in try/catch. Result is `trim().toLowerCase()` or `null`.
2. Value `"off"`: `console.info('[GenClass] Disabled by ?genclass=off or localStorage.genclass = "off": nothing is installed.')`, then `current = createRuntime({ observe: ALL_OFF, model: false, decider: null, report: "silent", mode: "observe" })`. **All caller options are dropped** (no plugins, no decider).
3. Value in `MODES` (`observe`, `guard`, `heal`): it becomes the mode; any other value is ignored and `options.mode` is used. An unrecognised but non-empty URL value (e.g. `?genclass=1`) still shadows `localStorage.genclass`, which is then never read.
4. Not a browser (`typeof globalThis.window !== "object" || typeof globalThis.document !== "object"`): `current = createRuntime({ ...options, observe: ALL_OFF, model: false, decider: options.decider ?? null, report: options.report ?? "silent", mode? })`. No observers and no model host, but a caller-supplied `decider`, `plugins`, `policy` etc. are kept.
5. Browser: copy options; set the mode if resolved; if `options.decider === undefined && options.model !== false`, set `o.model = options.model ?? {}`; `current = createRuntime(o)`.

`GenClass.runtime` is a getter for `current`. `GenClass.destroy()` sets `current = null` first, then calls `destroy()` on the old runtime.

The zero-code entries call `GenClass.init` with merged page configuration (`startAuto`, or `window.GenClass.init` -> `withCdnModel`); they add no branch to `initUnsafe`. See [Zero-code entries](#zero-code-entries-auto-script-tag-cli).

### 2. `createRuntime(options)`

`index.ts` -> `createRuntime`:
1. `decider = options.decider`. If it is `undefined` and `options.model` is a truthy object: `owns = true`; choose the fetch for model downloads: with `options.global`, that object's `fetch` bound to it (or `undefined` if it has none); without it, `NATIVE_FETCH` (the global `fetch` captured when `index.ts` was evaluated, so the model download never goes through GenClass's own fetch observer).
2. `makeHost(model, fetch, options.clock)`: `createModelHost({ ...model, fetch?, clock? })`; if that throws, `failedProvider(...)`: a provider whose `status` is `{ state: "error", error: "model host unavailable: <msg>" }` and whose `ready()`/`evaluate()` reject.
3. `return new RuntimeImpl({ ...options, decider: decider ?? null, ownsDecider: owns })`.

`createRuntime` never sets `GenClass.runtime`.

### 3. `RuntimeImpl` constructor order

Field initialisers run first (`ops = new OpRegistry()`, `base = new Baselines()`, `profiles = new Profiles()`, buffers, maps). Then `runtime.ts` -> `RuntimeImpl.constructor`:
1. `clock = o.clock ?? browserClock`; `global = o.global ?? globalThis`.
2. `events = new EventLog(o.historySize ?? 500)`; `ctx = new Context(clock)`; `redactFn = o.redact ?? defaultRedact`.
3. `hub = new StoreHub(clock, ctx, events, () => redactFn)`; `miner = new InvariantMiner(() => redactFn)`; `cache = new ResponseCache(clock)`.
4. `policy = policyConfig(o.policy)`; `hub.holdUserWrites = policy.holdUserWrites`; `hub.holdWrites = policy.holdWrites`; `rate = new RateLimiter(() => policy.maxActionsPerMinute)`.
5. Scalars: `_mode` (`o.mode ?? "observe"`), `triage`, `vocab`, `hooks`, `settleMs` (60), `budgetOpt` (`"auto"`), `appFn`, `debug`, `persist`, `decider`, `ownsDecider`.
6. `queue = new DeciderQueue(clock, () => decider, onError)`; `onError` shrinks `budgetScale` on `max_tokens_exceeded` and logs.
7. `reporter = new Reporter(o.report ?? "console", clock, id => explain(id), r => fire("report", r))`.
8. `env = makeEnv()`.
9. `hub.hooks = { gate: gateMutation, mayHold: hub.holdWrites && consultable() && mode !== "observe", observeWrite, filter: dropFilter, dropped: onDropped, appError: reportError, waitRelated, applied: onApplied, discarded: scheduleSettle, proposed: hooks.mutationProposed wrapper }`.
10. `events.onEvent(e => fire("event", e))`.
11. If `decider.onStatus` exists: subscribe (fire `status`; status reports on `ready`/`error`); push the unsubscribe into `uninstall`.
12. If `learn.persist`: `loadProfiles()` from `global.localStorage["genclass.profiles.v1"]` (errors ignored).
13. `installObservers(o.observe ?? {})`, in this order: `timers`, `fetch`, `xhr`, `websocket`, `eventsource` (shares `wsHost()` with WebSocket), `user` (with `untrusted: on("untrustedEvents", false)`), `errors`, `nav`, `storage`, `perf`. Each install is in `tryAdd` (a throwing installer is skipped and logged with `debug`); a non-null returned function is pushed into `uninstall`.
14. `for (const p of o.plugins ?? []) this.use(p)`.

Constructing a `RuntimeImpl` immediately patches the instrumented globals (fetch, XHR, timers, history, Storage, WebSocket, DOM listeners).

### 4. Model readiness

1. A host with `preload: "idle"` (default) starts loading after page load and idle; status goes `off` -> `loading` -> `ready` | `error`, each forwarded as a `status` event.
2. While `loading` or `error`, `consultable()` is false: observers and the hub skip triggers entirely (no facts, no holds, no decisions).
3. While `off` (lazy preload not started yet), triggers compute facts; the first salient one reads `this.ready` (starting the load via `decider.ready()`) and fails open.
4. `rt.ready` memoises the first `decider.ready()` promise and attaches a no-op `catch` so an unobserved failure is not an unhandled rejection.

### 5. Trigger path (facade view)

Observers and the hub call `RuntimeImpl.trigger(spec, ctl, { hold, priority })`. In order: not consultable -> passive; `computeFacts`; with `triage: "salient"`, all facts neutral and no `always` standing question -> passive; `buildSituation`; not ready -> start lazy load, passive; hold only if `hold`, some non-passive action is permitted in this mode/policy, not paused, **and `expectedLatency() <= holdBudgetMs()`** (batch 4: never hold when the model is not expected to answer in time, or while the queue is `stuck`); a `delivery` that does not wait while `writesCanAct()` (not paused and `discard` permitted, i.e. guard/heal) returns passive at once unless a standing question forces it or `triage: "always"` (its writes are decided on their own); any other non-waiting `delivery` is registered in `deliveryPending` before the passive action runs (054da38); the hold budget timer runs passive on expiry; submit to `DeciderQueue` with deadline `t0 + holdBudget (+ 2,000 ms late-revert window when the controller can revert)` for held subjects, else `t0 + 5,000 ms` and priority `min(priority, 1)`, plus `ctl.stale` so a superseded subject is dropped before dispatch; `onDecision` gates and acts.

In `onDecision`, "too late" is now asked of the controller: `proceeded = ctl.proceeded ? ctl.proceeded() : hold && (expired || passiveRan)`. A built-in action on a subject that already proceeded is cancelled with reason "the decision arrived after the hold budget expired" (held) or "the subject was not held (decided in the background)", except a `discard` whose controller can late-revert (`revertable()` returns null). Custom actions skip that check, but `ctx.builtin(name)` (`RuntimeImpl.runCustom`) returns false when `ctl.proceeded()` is true (and when paused, restricted by mode/policy, or rate-limited). For `delivery` triggers that have not proceeded, or that were decided in the background while covering their chain (`st.covers`), `op.delivery.decided` is set (so the chain's writes are covered). A delivery that already proceeded can only take its passive action, custom actions included (054da38). Full detail: [decide-policy-actions.md](decide-policy-actions.md).

### 5a. Delivery gate and write observation (situation-v2, batch 4/5)

1. **Response/message about to reach the app.** `observe/fetch.ts` / `observe/xhr.ts` call `netHost().deliver(...)`; `observe/messages.ts` (WebSocket, EventSource) calls `wsHost().deliverMessage(...)`. Both land in `RuntimeImpl.runDelivery(o, release)`. Not consultable, paused, destroyed or a GenClass-internal op: `release()` at once.
2. Predicted writes (`predictedWrites` from the signature's last chain, `lastChainMap`), the store fields they match (`matchFields`) and conflicts (`conflictsOn`: `newer` applied data, `pending` local changes) are computed; `op.delivery = { patterns, known, salient, decided: false }` is recorded on the op.
3. No conflict, no typed-text field and not `always`: release at once. **No hold possible** (`deliveryHoldable` false; always the case in `observe`; 054da38): release at once, before any body read, then analyze and decide in the background: with `bodyNow` (XHR `body.now`, WebSocket/EventSource parsed message) the analysis runs synchronously, before the app's listeners; otherwise (fetch) the body is awaited up to `BODY_WAIT_MS`, but the chain's first write (`hooks.proposed` -> `finalizeDeliveries`) decides it without the body (with only `pending`/typed-text conflicts it is then left undecided and marked salient, so its writes get their own `mutation` decisions and F1 is not lost). A salient (or `always`) background delivery triggers `delivery` with `hold: false`; in observe (or whenever `discard` is not permitted) the decision is recorded but cannot act, while in guard/heal `trigger` returns the passive action without asking unless a standing question or `triage: "always"` forces it (see [Trigger path](#5-trigger-path-facade-view)). Otherwise (holdable): without a body reader: salient iff a `newer` conflict exists. With one: wait up to `BODY_WAIT_MS` (100 ms) for the parsed body (a clone); `analyzeBody` then keeps a `newer` conflict only if the body would change the value (F3), a `pending` one only if the body puts back the value the user's change replaced (F1), and typed text only if the body would replace it (F2). Unchanged conflicts push a `custom` event `delivery.unchanged`.
4. Salient (or `always`): `trigger({ trigger: "delivery", ... }, ctl, { hold: true, priority: 2 })`. Controller: `passive` releases (and records `overNewer` for F9 marks when delivered over a conflict); `discard` releases and sets a `discardMark` for 10 s; `defer` waits for related in-flight ops (`relatedInFlight`, at most `LONG_RUNNING_MS`) then calls `runDelivery` again with `defers + 1`.
5. **Writes.** The hub calls `hooks.filter` (`dropFilter`: drop paths under an active discard mark), then, with `holdWrites` false, `hooks.observeWrite` (`observeWrite`: skip when not consultable, GenClass-internal or `covered(m)`; else a background `mutation` trigger with a controller whose `run` throws "the write was not held" except via late revert) and commits immediately. With `holdWrites` true, `gate` (`gateMutation`) holds as before, but also skips covered writes.
6. **Marks.** After each applied write, `onApplied` updates `lastChainMap` and calls `markWrites` (try/catch); `noteResponse` records created ids; `onChannel` marks fields of a live channel that was down when it comes back.

Behavioural tests: `delivery.test.ts`, `no-reorder.test.ts`, `content.test.ts`, `observe-delivery.test.ts` (background deliveries in observe, and guard unchanged); design and fact text: [learn-situation-triage.md](learn-situation-triage.md), [decide-policy-actions.md](decide-policy-actions.md), `docs/runtime/RESULTS.md`.

### 6. `ask` and `decide`

`runtime.ts` -> `RuntimeImpl.ask`:
1. Destroyed -> `GenClassUnavailableError("destroyed")`. No decider -> `("off")`.
2. Status not `"ready"`: await `this.ready`. With `timeoutMs`, race it against a clock timer that rejects with `("timeout", "the model did not load in time")`; without, a load failure becomes `("error", "the model failed to load: ...")`.
3. Still not ready -> `("error", "the model is <state>")`.
4. `build({ trigger: "ask", about: opts.about ?? "now" })`; questions `{ answer: q }`; `queue.submit({ trigger: "ask", state, questions, priority: 1, subject }, timeoutMs !== undefined ? now + timeoutMs : undefined)`.
5. With `timeoutMs`, race the answer against a second clock timer -> `("timeout", "the model did not answer in time")`.
6. `null` result or no `answers.answer` -> `("error", "the model could not answer")`; else return `answers.answer`. Without `timeoutMs` the request has no deadline, so the queue abandons a silent provider after `PROVIDER_TIMEOUT_MS` = 10,000 ms (`decide/decider.ts`) and `ask` rejects with this `"error"`; it also resolves `null` (-> `"error"`) when the provider is no longer `ready` at dispatch, when it rejects, or when more than 32 requests are queued and it is the lowest-priority, oldest one (evicted).

`ask` bypasses triage, policy and `pause()`, records no `Decision`, fires no event, and can be served from the queue's 30 s cache of identical requests (same trigger, state and questions).

### 7. Settled points

1. `scheduleSettle()` (debounced; no-op after destroy) is called by `endOp`, `onApplied` and the hub's `discarded` hook; it (re)arms a `settleMs` clock timer.
2. `settled()` returns early when destroyed or `busy()`: any in-flight op younger than `LONG_RUNNING_MS` (10,000 ms), or a pending (held/queued) write. It does not re-arm itself; the next op end or write does.
3. Invariants: `miner.observe(hub.allLeaves(), now)`; violations not present at the previous settled point and not muted are raised as one `inconsistency` trigger (not held, priority 1). Muted ids are dropped once they hold again.
4. Snapshot: if nothing newly broke, push `{ t, seq: hub.seq, values: hub.snapshot() }` (or refresh `t` when `seq` is unchanged); keep 8.
5. Transition profiles: each queued finished op is profiled once (`shapeOf(op.chain, op.chainWrites, statusClass(op), duration)`, then `profiles.check` then `profiles.add`) under the profile key `` `user ${op.name}` `` for user ops and `op.name` otherwise; `statusClass` is `"<n>xx"` for numeric codes, `"timeout"`/`"network"`, else the op status. Unusual ones raise `transition` (not held, priority 0), keeping only the deepest when an op and its descendant are both unusual. Queued ops that have not ended yet are dropped from the queue (an op is re-queued by `endOp` when it ends).
6. With `learn.persist` and at least one queued op, `saveProfilesSoon()` writes profiles 5,000 ms later (one pending save at a time).

Details: [state-and-adapters.md](state-and-adapters.md) (invariants, snapshots) and [learn-situation-triage.md](learn-situation-triage.md) (profiles).

### 8. `setMode`, `pause`, `resume`

1. `setMode(m)`: validate, set, status report, fire `status`. The new mode applies to the next gate; holds already waiting keep their computed `waits` flag.
2. `pause()`: `paused = true`, `hub.gating = false`. `consultable()` turns false, so triggers fail open; the fetch/XHR gate (`netHost.gated`) passes requests through; any hold that is still waiting is released by its own budget timer.
3. `resume()`: reverses `pause()` unless destroyed.

### 9. `destroy()`

`runtime.ts` -> `RuntimeImpl.destroy`, in order:
1. Return if already destroyed; set `destroyed = true`.
2. `hub.gating = false` (later writes apply immediately).
3. `queue.dispose()` (queued requests resolve `null`, so pending triggers fail open and pending `ask`s reject), then `deliveryAnalysis.clear()`. The one evaluation already dispatched is not cancelled: it settles normally (or after its deadline / `PROVIDER_TIMEOUT_MS`), a trigger waiting on it runs passive because `destroyed` is set, but an `ask` waiting on it can still resolve with an answer after `destroy()`.
4. `reporter.dispose()` (open de-dup windows are dropped: pending `(×N more in the last minute)` lines are never printed).
5. Clear `settleTimer` and `persistTimer` (a pending `learn.persist` save is dropped).
6. Run `uninstall` in reverse order (observers last-installed-first, then the decider status subscription); errors ignored. Each observer's uninstall sets its `disabled` flag (its wrapper becomes a pass-through) and, for fetch for example, restores the original only if the global still holds GenClass's wrapper (`observe/fetch.ts` -> `installFetch`), so a library that wrapped on top of GenClass keeps working.
7. `unuse` every plugin (cleanup functions run).
8. `unsubscribeIO()` for every store.
9. `ctx.clear()` (no ambient op).
10. If `ownsDecider`: `decider.dispose()` (terminates the model worker).

After destroy: listeners registered with `on()` stay attached and can still fire. `destroy()` does not detach the `EventLog` listener, so anything still recorded fires `event`: atom/guard `set` and adapter `propose` write directly (`hub.write` -> `StoreHub.record` pushes a `state` event) without gating, and `user()` / `emit()` have no `destroyed` check. An action that was already running when `destroy()` was called still fires `act` and `report` when its effect settles (`onDecision` -> `finish` has no `destroyed` check). No new decisions are made (`consultable()` is false), `reportError` is a no-op, `ask` rejects with `"destroyed"`, and `resume()` is a no-op.

## Configuration and constants

| name | type | value | defined in | effect |
|---|---|---|---|---|
| `MODES` | `readonly Mode[]` | `["observe", "guard", "heal"]` | `index.ts` | Kill-switch values accepted as modes. |
| `ALL_OFF` | `Record<ObserverName, boolean>` | all ten observers `false` (`eventsource` added in batch 4) | `index.ts` | Observer set for inert runtimes. Must list every `ObserverName` (type-enforced). `untrustedEvents` is not listed (it defaults to false anyway). |
| kill-switch key | string | URL param `genclass`, localStorage key `genclass` | `index.ts` -> `killSwitch` | `off` / `observe` / `guard` / `heal`; trimmed, case-insensitive; URL wins. |
| `NATIVE_FETCH` | `typeof fetch \| undefined` | `globalThis.fetch.bind(globalThis)` at module evaluation | `index.ts` | Fetch used by an owned model host when no `global` is passed. |
| `DECISIONS_KEPT` | number | `200` | `runtime.ts` | Size of `decisions()` / `interventions()` buffers; default `n`; the explain map evicts (one entry per decision) above `2 ×` this. |
| `LATE_REVERT_MS` | number | `2000` | `runtime.ts` | Late-revert window after a write applied (`mutationController` -> `revertable`): applies both to a held write whose budget expired and to a background (`observeWrite`) write, so a background `discard` decided more than 2 s after the write is refused ("too late to revert"). Only for held subjects whose controller can revert does it also extend the decision deadline. |
| `BACKGROUND_DEADLINE_MS` | number | `5000` | `runtime.ts` | Deadline for non-held decisions (all decisions in `observe`, and background `mutation`s). |
| `DISCARD_MARK_MS` | number | `10000` | `runtime.ts` | How long a delivery `discard` keeps dropping its chain's writes over newer data. |
| `BODY_WAIT_MS` | number | `100` | `runtime.ts` | Max wait for a salient delivery's body (a buffered clone) before deciding without it. A holdable delivery waits up to that long for its body before it is decided (and then possibly held for the model); a background delivery (observe) is already released and only its analysis waits (fetch only: XHR and push messages are analyzed synchronously via `bodyNow`). |
| delivery / write-chain walk | number | `16` ops (the write's cause and up to 15 ancestors) | `runtime.ts` -> `covered`, `dropFilter`, `onDropped` | How far up the cause chain a write looks for a delivery decision or discard mark. |
| `markWrites` chain | number | writer + 8 ancestors | `runtime.ts` -> `markWrites` | Ops inspected for F9 marks; slow-response mark when duration `>= 5 ×` median and `>= median + 300 ms`. |
| `STALL_MIN_MS` | number | `500` | `runtime.ts` | Stall timer at `max(4 × median, 2 × p95, 500)` ms of the signature's latency. |
| `LONG_RUNNING_MS` | number | `10000` | `runtime.ts` | Ops older than this do not block settled points; `defer` waits at most this long. |
| `PROFILED` | `Set<OpKind>` | `fetch`, `xhr`, `user`, `task`, `ws` | `runtime.ts` | Op kinds with transition profiles. |
| `TYPING_BURST_MS` | number | `1000` | `runtime.ts` | `user({ kind: "type" })` on the same target within this merges into one event. |
| `PROFILE_KEY` | string | `"genclass.profiles.v1"` | `runtime.ts` | localStorage key for `learn.persist`. |
| profile save delay | number | `5000` ms | `runtime.ts` -> `saveProfilesSoon` | Delay of the single pending profile write (the first request schedules it; later ones are ignored until it runs). |
| rate-warning throttle | number | `60000` ms | `runtime.ts` -> `onDecision` | Rate-limit status report at most once a minute. |
| budget scale | number | start `1`, `× 0.8` per `max_tokens_exceeded`, floor `0.5` | `runtime.ts` constructor | Shrinks the automatic situation budget. |
| `situationBudget()` "auto" | number | WebGPU or unknown device: `STATE_CHAR_BUDGET` = 2400 (≈ 1,000 tokens at the measured 2.4 chars/token; was 3200 in situation-v1); WASM: `1000 + round((threads - 1) × 1000 / 3)` with threads clamped to 1..4 (1000, 1333, 1667, 2000); then `× budgetScale`, rounded | `runtime.ts` -> `situationBudget` | Size of situation text (`budget`). A numeric `situation.budget` is returned unchanged. |
| `STATE_CHAR_BUDGET`, `COMPACT_BUDGET` | number | `2400`, `1100` | `situation/serialize.ts` | Full and compact section limits (full at `>= 2400`, linear in between). Compact questions at budget `<= 1400` (`COMPACT_QUESTIONS_BUDGET`, `situation/questions.ts`). |
| historySize floor | number | `16` | `trace/events.ts` -> `EventLog` | Minimum ring-buffer size. |
| `MAX_OPS` / `KEEP_OPS` | number | `2000` / `1500` | `trace/ops.ts` | Op registry pruning (in-flight ops kept); `PluginApi.endOp` on a pruned id is a no-op. |
| `STRINGIFY_CAP` | number | `65536` | `util.ts` | Default cap of `stableStringify`. |
| `REDACTED` | string | `"[redacted]"` | `util.ts` | Redaction marker. |
| `IDEMPOTENT_METHODS` | `Set<string>` | `GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`, `TRACE` | `util.ts` | Request idempotency for facts/actions. |
| `DEFAULT_MODEL_BASE_URL` | string | `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/` | `model/host.ts` | Default `model.baseUrl`. |

Policy defaults are in [PolicyOptions](#policyoptions); queue and host constants (`MAX_QUEUE` 32, `CACHE_TTL` 30,000 ms, `PROVIDER_TIMEOUT_MS` 10,000 ms, `LATENCY_SAMPLES` 20, host `DEFAULT_TIMEOUT_MS` 10,000) in [decide-policy-actions.md](decide-policy-actions.md) and [model-host.md](model-host.md).

### `util.ts` helpers

| helper | contract |
|---|---|
| `fnv1a(s)` | FNV-1a 32-bit (offset `0x811c9dc5`, prime `0x01000193`, `Math.imul`), 8 lowercase hex chars. |
| `isPlainObject(v)` | Prototype is `Object.prototype` or `null`. |
| `stableStringify(v, cap = 65536)` | JSON-like with sorted keys; `undefined`, `"[fn]"`, `"[symbol]"`, `"[cycle]"`, `123n`, non-finite numbers quoted, `Map{k:v}`, `Set[...]`, Dates as ISO; over the cap: `<first cap chars>…<length>`. |
| `hashValue(v)` | `fnv1a(stableStringify(v))`. |
| `kindOf(v)` | `"null" \| "array" \| "map" \| "set" \| "date" \|` `typeof`. |
| `truncate(s, n)` | At most `n` chars, last one `…`. |
| `secs(ms)` | `"0.42s"` (< 10 s, 2 decimals), `"12.3s"` (< 1000 s), else integer; negatives clamp to 0. |
| `rel(ms)` | Signed: `"-1.24s"` (`ms <= 0`, so 0 is `"-0.00s"`) or `"+0.10s"`. |
| `fmtNum(n)` | Integers as is; else 1 decimal if `abs(n) >= 100`, 2 if `>= 1`, 4 otherwise (trailing zeros dropped). |
| `ratio(a, b)` | `"∞"` when `b <= 0`; `"12×"` when `>= 10`; else `"1.5×"`. |
| `plural(n, one, many?)`, `ordinal(n)` | `"3 items"`; `"1st"`, `"12th"`, `"23rd"`. |
| `words(s)` | Split camelCase / snake_case / kebab-case / spaces, lowercased. |
| `isSensitiveName(name)` | Results memoised in a module-level `Map` (cleared when it exceeds 4,096 names). True if any word is in `SECRET_WORDS` (password, passwd, passcode, passphrase, pass, pwd, secret, token, cvv, cvc, csc, ssn, iban, otp, totp, pin, cookie, authorization, auth, apikey, creditcard, cardnumber) or a pair in `SECRET_PAIRS` (card number/num/no/cvc/cvv/code/security, credit card, cc number/num/no/exp/csc, api key/secret, private key, access key, secret key, session id/token/key, security code, one time, social security). `"author"`, `"cards"`, `"passengers"`, a kanban `"card"` are not secrets. |
| `isSensitivePath(path, value?)` | New in batch 4/5. Decides by the **leaf** field, never by a store or container name alone: `null`/`undefined`/booleans never; non-path free text (e.g. `'input "Card number"'`) -> `isSensitiveName` of the whole text; numeric segments skipped (`users.3.password`); plain objects never redacted whole; leaf `isSensitiveName`, or a secret pair across the last two segments (`payment.card.number`); otherwise, for string, number, bigint or array values, under a container that names a secret, the value is a secret (`credentials.password.value`, `payment.cvv.value = 123`, `account.password.history = [...]`; numbers, bigints and arrays since f107013, strings before), and under a broad container (`auth`, `authorization`, `cookie`, `session`) only opaque credential-looking strings (`OPAQUE`: >= 20 chars, letters and digits, no spaces). `auth.loading`, `auth.user.name` are not secrets. |
| `defaultRedact(path, value)` | `"[redacted]"` if `isSensitivePath(path, value)`, else `value` (was: any segment `isSensitiveName`). |
| `describe(v, path, redact, max = 80)` | Compares the redactor's result with `Object.is` (ad24804: `!==` recursed forever on `NaN`). One-line value summary used in situations (strings 48 chars top-level, 24 nested; arrays show at most 3 items, e.g. `"5 items [a, b, c, …]"` (the `, …` only when items were left out); objects list id-like keys first: `id`, `_id`, `key`, `uuid`, `slug`, `name`, `title`, `label`). |
| `isIdSegment(seg)` | Digits, UUID, long hex (>= 8 with a digit), long token (>= 16 with letters and digits), conservative slug ids (`tasks-1cam`, `x7k2p`, `PPBqWA9`; not `sha256`, `oauth2`, `v1beta1`). |
| `normalizePath(p)` | Id segments (after `decodeURIComponent`) -> `:id`. |
| `normalizeFieldPath(p)` | Store path segments after the first that are ids or contain a digit -> `:id` (transition profiles). |
| `parseUrl(raw, base)` | `{ href, where, search, sameOrigin }`; `where` is the pathname (same origin) or `host + pathname`; base defaults to `http://localhost/`. `ws:`/`wss:` URLs on the page's host count as same-origin. |
| `requestSignature(method, where)` | `"GET /api/items/:id"` (the **op signature**). |
| `redactSearch(search, redact, max = 60)` | Query string (input capped at 4096 chars) with values whose `query.<key>` path is redacted (not `Object.is`-equal) replaced by `[redacted]`, truncated. |
| `type Redactor` | `(path: string, value: unknown) => unknown`: the shape of `InitOptions.redact` and `defaultRedact`. |
| `interface ParsedUrl` | `{ href; where; search; sameOrigin }`, returned by `parseUrl`. |
| `REDACTED`, `IDEMPOTENT_METHODS` | Exported constants (values in the table above). `STRINGIFY_CAP`, `SECRET_WORDS`, `SECRET_PAIRS`, `WEAK_CONTAINER`, `OPAQUE`, `PATH_LIKE`, `ID_KEYS`, the name cache and the id regexes are module-private. |

`fmtNum` returns `String(n)` for non-finite numbers (`"NaN"`, `"Infinity"`). `stableStringify` prints an invalid `Date` as `"Invalid Date"` and slices any single string longer than the cap before quoting. `describe` nests at most two levels (`{N keys}` deeper, nested arrays as `[N]`, `Map(N)`, `Set(N)`) and appends `, +N` for keys that did not fit.

## Invariants and gotchas

- **`GenClass.init` must never throw.** Every observer installer runs inside `tryAdd`; plugin `setup` errors are caught in `use`; listener, hook and reporter errors are swallowed; the outer catch falls back to an inert runtime. Tests: `batch3.test.ts` ("GenClass.init never throws", read-only globals), `review-misc.test.ts`. Do not add code to the constructor path that can throw without a guard.
- **`createRuntime` (and `new RuntimeImpl`) can throw.** Unguarded constructor steps: `new EventLog(historySize)` (`RangeError` for `NaN` or a non-integer size of 16 or more; a fraction below 16 becomes 16), `policyConfig` (`new Set(allow/deny)` with a non-iterable), and `decider.onStatus(...)` of a custom provider. All of these run before any observer is installed, so nothing is left patched. One unguarded step runs after the observers: plugin registration (`for (const p of o.plugins ?? []) this.use(p)`, and inside `use` the `for...of` over `plugin.actions` / `plugin.questions`), so a non-iterable `plugins`, `actions` or `questions` throws with the globals already patched and no runtime left to `destroy()` them (only `setup` is in try/catch). `GenClass.init` catches all of these and returns the inert fallback (dropping every option). But a model host that `createRuntime` already built for `model: {...}` is never disposed in that case, and its `preload` (`"idle"` by default, scheduled in the `Host` constructor) still downloads the model.
- **Console hints assume the facade.** Report groups print `GenClass.runtime.interventions()...undo()`, `GenClass.runtime.explain(...)` and ``Deny this action: GenClass.init({ policy: { deny: ["<action>"] } })`` (`decide/report.ts` -> `Reporter.emit`). The deny hint does nothing on a page where `GenClass.init` already ran (idempotent init ignores new options); it only takes effect after `GenClass.destroy()` and a fresh `init`, or at the next page load.
- **Silent by default.** Swallowed failures (observer install, plugin setup, provider errors) are only visible with `debug: true`. When debugging "GenClass does nothing", turn on `debug` first.
- **Singleton semantics.** `GenClass.init(newOptions)` after a first init returns the old runtime unchanged. `rt.destroy()` without `GenClass.destroy()` leaves `GenClass.runtime` pointing at a destroyed runtime, and the next `init()` returns it. Console hints printed by reports (`GenClass.runtime.interventions()...`, `GenClass.runtime.explain(...)`) only work for the facade singleton, not for `createRuntime` runtimes.
- **Kill switch scope.** It is read from `globalThis` only, by `GenClass.init` only (`createRuntime` ignores it). `off` drops all options, including `plugins` and `decider`.
- **Non-browser init is not fully inert.** It keeps `options.decider`, `plugins`, `policy`, `mode`; only observers and the model host are forced off.
- **Decider ownership.** Only a host created by `createRuntime` is disposed. If you pass `createModelHost(...)` as `decider`, you must `dispose()` it yourself.
- **`decider` vs `model`.** Any non-`undefined` `decider` (including `null`) disables model creation. `model: {}` with `createRuntime` does load the model (unlike passing nothing).
- **`rt.ready` memoises failure.** After a failed load, `rt.ready` keeps rejecting even if the host could reload via `ModelHost.load()`; `ask()` without `timeoutMs` then rejects with reason `"error"`.
- **`ask()` timeouts apply twice** (load wait and answer wait), so the worst case is about `2 × timeoutMs`; and with `timeoutMs` set, a model load failure rejects with the provider's own error (for example `ModelLoadError`), not `GenClassUnavailableError` (see Drift).
- **Event `status` is overloaded:** `setMode` fires it with the unchanged model status. Do not assume every `status` event means the model changed.
- **`event` listeners can see the same object twice** (typing bursts mutate and re-fire the event via `EventLog.touch`).
- **`inflight()` returns live `OpRec`s**; `situation()` returns the cached object for that trigger. Treat both as read-only.
- **`atom(name)` reuse vs replacement.** Same name and kind `atom` reuses the store and ignores `initial`; `guard`/`adapter` (or `atom` over a non-atom store) replace the store and lose its field history.
- **Determinism (CONTRACT §0 rule 3).** Inside `packages/runtime/src` no `Math.random`, `Date.now`, `performance.now` or global `setTimeout`/`setInterval`: use `this.clock` (or `api.clock` in plugins). Ids come from counters (`d<n>`, `a<n>`, `uniq:<n>`, op ids, event `seq`). The only `performance.now` uses are `clock.ts` and a default in `model/engine.ts` that `model/backend.ts` overrides with the injected clock (`now: () => this.env.clock.now()`). Exception outside the decision path: the devtools overlay (`src/devtools/index.ts`, owned by UI) captures the raw global `setTimeout` and `requestAnimationFrame` at module load for its own rendering. The model host's idle preload (`src/model/host.ts` -> `scheduleIdle`) also calls the global `requestIdleCallback`/`cancelIdleCallback` directly. None of these reaches situation text. `budget.test.ts` and `situation.test.ts` assert byte-identical situations for identical inputs.
- **Every timer the runtime arms must be cleared in `destroy()` or be harmless when it fires afterwards.** `destroy()` clears `settleTimer`, `persistTimer` and the reporter's de-dup windows. Hold-budget, stall and queue-dispatch timers are left to fire: `passive()` is idempotent, `watchStall` checks `destroyed`, and `trigger()`'s answer handler runs passive when `destroyed`. The batch-4 delivery timers are also left to fire: the `BODY_WAIT_MS` timer in `runDelivery` (it then decides without the body; `trigger` fails open because not consultable, and the body callback checks `destroyed`) and the `LONG_RUNNING_MS` cap in `waitOps` (a `defer` re-runs `runDelivery`, which releases at once when destroyed). Every delivery path is designed to end in `release()` (guarded by a per-call `released` flag), so a response or message is never swallowed; keep that property when you add a delivery action. A background delivery's analysis (`bodyNow`, `finish`, the `deliveryAnalysis` cut) runs inside try/catch after `release()`, so an analysis error can never break or delay the delivery; keep it that way. A `defer` re-enters `runDelivery` with the same `release`, under a fresh flag (whether a failing `defer` effect can release twice is unverified; the fetch/XHR `release` callbacks would need to tolerate it).
- **Captured natives.** `browserClock` captures timers and `index.ts` captures `fetch` at module evaluation. If another library patched `fetch` earlier, the model host downloads through that patch. Keep these captures at module top level; moving them into functions would make the runtime observe itself (its own timers through the timers observer, its model download through the fetch observer).
- **Parity and the `situation-v2` freeze.** `util.ts` formatting (`secs`, `rel`, `fmtNum`, `ratio`, `plural`, `ordinal`, `truncate`, `describe`, `normalizePath`, `isIdSegment`, `isSensitiveName`, `isSensitivePath`, `defaultRedact`), `STATE_CHAR_BUDGET` and the default `vocabulary` feed the text the model reads. The tag `situation-v2` (6e5e86e) froze it. `git diff situation-v2 HEAD -- packages/runtime/src` on `mvp-v2-merge` touches: `devtools/index.ts` (labels), `types.ts` (JSDoc), `trace/ops.ts` (`peekNextId`, tests only), the new `auto.ts` and `cdn/*` (no situation code), `runtime.ts` (the `o.mode` default; `errorsRecent` pruning moved to record time; background deliveries, 054da38), `observe/xhr.ts` / `observe/messages.ts` (`bodyNow`), and the redaction fix f107013 (`util.ts` -> `isSensitivePath`, `state/fields.ts` -> `redactedStringDiff`, `situation/content.ts` F2 diff). The last group **does** change situation text, but only for values that are now redacted (numbers/arrays under secret containers, F2 previews of redacted fields); 054da38 changes which situations are built (the state a background delivery was released into) and makes observe-mode delivery decisions exist, not the format. The v2 data (10.4M gold, 51.3M unlabeled, eff18cb) was generated before f107013, so it may contain such unredacted values; that is a curriculum/data follow-up for SIM/TRAIN (STATUS.md), not a format break. Any further change to the helpers above invalidates that data. Coordinate with SIM/TRAIN first ([model-io-contract.md](../model-io-contract.md)). `situation-v1` (tag at 1a77558, same `src` as 654d822) is superseded.
- **Default mode is `observe`, but the test harness is `guard`.** `test/helpers.ts` -> `setup` defaults `mode: "guard"`; `smoke.test.ts`, `test/browser/ui/session.ts` and `review-fetch.test.ts` -> `headless()` pass `mode: "guard"` explicitly. A new test that expects interventions from `createRuntime` (not `setup`) must pass `mode: "guard"`; a test of the product default uses `setup({ mode: undefined })` as `default-mode.test.ts` does.
- **Observe never delays anything, deliveries included (054da38).** Before it, a conflicting response in observe still waited up to `BODY_WAIT_MS` (100 ms) for its body before release, and its decision was then dropped as stale. Now `deliveryHoldable` returns false in observe, the delivery is released synchronously (XHR listeners and WebSocket/EventSource handlers run inside the original dispatch), and the decision is still recorded. Do not add a code path that reads a body or waits before `release()` unless the delivery is holdable.
- **Zero-code entries run at import time and call `GenClass.init` once.** App code that later calls `GenClass.init(options)` gets the runtime the entry started; its options are ignored (use `window.GENCLASS_CONFIG`, the meta tag or the `/auto/<mode>` path instead). `/auto*` and the script tag never install anything outside a browser, and do not mount devtools when the kill switch is `off`.
- **Writes are not held by default (even in guard).** With `policy.holdWrites` false, `mayHold` is false and `atom().set` / adapter `propose` apply in the caller's stack; a model `discard` of a `mutation` can only late-revert under the strict rules (within `LATE_REVERT_MS`, nothing overwrote it). Tests that rely on held writes set `policy: { holdWrites: true }` (`atoms.test.ts`, adapter tests; `MockRuntime` has its own `holdWrites` flag).
- **The sim's observer map omits `eventsource`.** `sim/src/run/rt.ts` -> `createOptions` passes an explicit `observe` map without `eventsource`, so the EventSource observer defaults on in sim runs. `installEventSource` returns `null` when `global.EventSource` is not a function, and nothing under `sim/src` mentions `EventSource`, so today it is a no-op there; if the sim ever adds an `EventSource` to its fake global, decide explicitly whether to observe it. The unit-test harness (`test/helpers.ts` -> `setup`, `review-fetch.test.ts` -> `ONLY_FETCH`) has the same gap.
- **The model seam is shared.** The first section of `types.ts` is co-owned by MODEL, and `sim/src/types.ts` mirrors it structurally. Change all three together.
- **Fail-open everywhere.** Not consultable, provider error, deadline missed, queue overflow, destroyed: the passive action runs. Never introduce a path where a missing answer blocks the app.
- **Option resolution is one-shot.** `policy` (including `holdWrites`), `triage`, `vocabulary`, `settleMs`, `redact`, `report` (except via `setReport`) and `observe` are read in the constructor; only `mode` (via `setMode`) and pause state change afterwards.

## How to change it safely

**Add an init option**
1. Add the field with a JSDoc default to `InitOptions` (or `CreateOptions` if headless-only) in `packages/runtime/src/types.ts`.
2. Read it once in `RuntimeImpl`'s constructor with an explicit default (`o.x ?? default`). Never read options lazily from `o` later.
3. Check the four creation paths in `index.ts` (`initUnsafe` browser, non-browser, kill-switch `off`, fallback) and decide whether the option should survive each.
4. If it changes situation text or decisions, coordinate with SIM (`sim/src/run/rt.ts` -> `createOptions`) and record it in `docs/runtime/API.md`. A boolean that only tunes an observer (like `observe.untrustedEvents`) can ride in the `observe` map: widen the `observe` type in `types.ts` and read it with `on("<key>", false)` in `installObservers`; keep it out of `ObserverName` so `ALL_OFF` does not need it.
5. Add a test using `setup({ ...option })` from `test/helpers.ts` (remember it defaults to `mode: "guard"`); run `NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts` in `packages/runtime` (light unit tests are fine on a 16 GB dev machine; HANDOFF.md's "never on the Mac" rule is about the colleague's 8 GB Mac), then `review-perf.test.ts` alone; CI (`.github/workflows/ci.yml`) runs the same split. See [build-test-release.md](build-test-release.md#where-to-run-things).

**Add a `Runtime` method**
1. Add it to `Runtime` in `types.ts` and implement it in `RuntimeImpl`.
2. Update every other implementer of `Runtime`: `packages/runtime/test/browser/ui/mock-runtime.ts` (`MockRuntime implements Runtime`) and `demos/src/dev/runtime-shim/index.ts` (`ShimRuntime implements Runtime`). Add it to the sim's `RuntimeLike` (`sim/src/run/rt.ts`) only if the sim calls it.
3. Devtools wraps runtime calls in `safe()`; keep new methods non-throwing if devtools will use them.

**Change an existing `Runtime` method or option (signature or semantics)**
1. Find every caller outside `src/`: the sim's structural `RuntimeLike` (`sim/src/run/rt.ts`) calls `atom`, `user`, `reportError`, `situation`, `on`, `destroy` and optionally `decisions`, `inflight`; its `createOptions` passes `clock`, `global`, `decider`, `model: false`, `mode: "heal"`, `report: "silent"`, an explicit `observe` map, `triage: "salient"`, `policy` (`thresholds { report: 0, guard: 0.5, heal: 0.5 }`, `holdBudgetMs: 1e9`, `maxActionsPerMinute: 1e9`, `requireDiagnosis: false`), `historySize: 500`, `app`, and optionally `vocabulary`, `hooks`, `situation.budget`; with `production: true` (on-policy runs) `policy` is replaced by `{ holdBudgetMs: 1e9, maxActionsPerMinute: 1e9 }` (default thresholds and diagnosis gate). It never sets `holdWrites`, so sim store writes are never held (decisions on writes are background ones). The sim loads the runtime by the module name in env var `GENCLASS_RUNTIME` (default `@genclass/runtime`), so it compiles without the runtime's types: a breaking change shows up only at sim run time.
2. Also update `MockRuntime` (`test/browser/ui/mock-runtime.ts`), `ShimRuntime` (`demos/src/dev/runtime-shim/index.ts`), devtools (`src/devtools/index.ts`) and the React adapter (`src/adapters/react.ts` -> `useRuntimeList`, which calls `decisions(limit)` / `interventions(limit)`).
3. Update `docs/runtime/API.md`, the JSDoc in `types.ts` and this doc. If the change alters situation text or decisions, it breaks the `situation-v2` freeze (see Invariants).

**Add an event type**
1. Add the key and payload to `RuntimeEvents` in `types.ts`.
2. Add a `Set` for it in the `listeners` initializer of `RuntimeImpl` (otherwise `on(newType)` throws on `undefined.add`).
3. Fire it with `this.fire(type, value)`. Update `devtools/index.ts` -> `subscribe` and the React adapter's `useRuntimeList` callers if they should react.

**Add an observer**
1. Extend `ObserverName` in `types.ts`; TypeScript then forces the new key into `ALL_OFF` in `index.ts`.
2. Install it in `RuntimeImpl.installObservers` through `tryAdd(name, () => installX(...))`; the installer returns an uninstall function (restore the global if it is still your wrapper, else become a pass-through) or `null` when unsupported.
3. Decide the default (`on(k)` defaults to `true`; pass a second argument like `timers` does to make it conditional).
4. Add a "destroy restores the global" assertion next to `dom.test.ts` -> "browser globals are restored by destroy()". See [observe-and-trace.md](observe-and-trace.md).

**Change a default (mode, thresholds, settleMs, historySize, budgets, holdWrites)**
1. Change it where it is defined (table above), then update the JSDoc in `types.ts`, `docs/runtime/API.md`, `docs/runtime/CONTRACT.md` (§2 and a dated §13 entry for a product decision), `packages/runtime/README.md`, and devtools labels if they name the default. For the mode default also the CLI (`bin/lib/plan.mjs` -> `AUTO`, `scriptTag`; `bin/lib/init.mjs` -> `USAGE` and the "Mode" summary row) and its fixtures in `test/install/cli.test.ts`: they encode which mode plain `/auto` means.
2. Tests pinning values: `budget.test.ts` (budgets, hold budget), `policy.test.ts`, `report.test.ts` (report line regexes include thresholds), `batch3.test.ts`, `default-mode.test.ts` (mode), `atoms.test.ts` / `no-reorder.test.ts` / adapter tests (`holdWrites`).
3. Worked example, the mode default (f3636b2): `runtime.ts` constructor `o.mode ?? "observe"`; `types.ts` JSDoc; devtools `MODES` tooltips and mode fallback; `test/helpers.ts` -> `setup` now passes `mode: "guard"` explicitly; explicit `mode: "guard"` in `smoke.test.ts`, `test/browser/ui/session.ts` and `review-fetch.test.ts` -> `headless()` (no assertion changed); new `default-mode.test.ts`; API/ARCHITECTURE/CONTRACT §13.
4. Thresholds and budgets affect training/eval comparability: tell TRAIN/SIM.

**Change the kill switch or init paths**
Edit `index.ts` -> `killSwitch` / `initUnsafe`; keep everything in try/catch; update `report.test.ts` -> "GenClass.init and the kill switch" and `batch3.test.ts` -> "lifecycle".

**Change `destroy()`**
Keep it idempotent; clear every new timer; keep reverse uninstall order; dispose only owned deciders. Tests: `fetch.test.ts`, `xhr.test.ts`, `dom.test.ts` (restoration), `review-fetch.test.ts` (no work after destroy), `review-misc.test.ts` / `batch3.test.ts` (`ask` after destroy).

**Add a subpath export**
Add the entry to `package.json` `exports`, `tsup.config.ts` `entry` and `dts.entry` (of the first, ESM config), and externalise any new peer library. If importing it for its effect is the point (like `/auto`), also add its `dist` file to `sideEffects`. See [build-test-release.md](build-test-release.md).

**Add time-dependent behaviour**
Use `this.clock.now()` / `this.clock.setTimeout` / `this.clock.afterTask`; store the handle and clear it in `destroy()`; test it with `FakeClock.advance`.

## Tests

All in `packages/runtime/test/` (vitest, `environment: "node"`, `testTimeout: 20000`, `test/browser/**` excluded; `dom.test.ts` uses `// @vitest-environment happy-dom`). Most use `setup()` from `helpers.ts`: `createRuntime` with `FakeClock`, `FakeServer`, `ScriptedDecider`, **`mode: "guard"`**, `report: "silent"` and only the fetch observer on (its explicit `observe` map omits `eventsource`, which therefore defaults on but installs nothing: the fake global from `makeGlobal` has no `EventSource`). Run on `mvp-v2-merge` at f107013 (2026-10-08, Node v25.6.0): unit tests without `test/browser/**` and `review-perf` -> 44 files passed, 1 skipped; 375 tests passed, 14 skipped (model parity), 389 in all (`vitest.config.ts` includes `test/**/*.test.ts`, so `test/install/cli.test.ts` runs too). `review-perf.test.ts` is run alone (4 tests at b435acb; it can flake under a full parallel run: 5.5 ms vs its 2 ms bound).

| test file | what it asserts (scope of this doc) |
|---|---|
| `projects.test.ts` (feat/projects, 16 tests) | Token format; token from meta / data attributes / `GENCLASS_CONFIG` / options; envelope `token` (and none without one); malformed token -> one warning; token with telemetry off (debug info line); GPC still wins; `protect()` without a runtime, `this`/args/sync/async/throws/rejections/thenables, `name`/`length`, destroyed runtime; `Decision.fn` and telemetry `fn` (outermost function), attribution after an `await`; `scope: "functions"` decides only protected activity, default scope unchanged, identical situation state for the same subject. CLI token tests are in `test/install/cli.test.ts` (6 tests, fetch mocked by `test/install/mock-fetch.mjs`). |
| `default-mode.test.ts` (f3636b2, 054da38) | `createRuntime` and `GenClass.init` without a mode start in `observe`; `mode: "guard"` and `?genclass=guard` opt in; in observe, a sure model (p 0.99) records `delivery`/`mutation`/`request` decisions and detections but nothing is held, `executed` is false and `interventions()` is empty; a model that never answers delays nothing (atom write, adapter propose, fetch, failed fetch) while it is still asked in the background. |
| `delivery.test.ts`, `content.test.ts`, `no-reorder.test.ts` (batch 4/5) | The delivery gate (salience, `discard` drop marks and undo, `defer`), body analysis (F1/F2/F3, read-your-writes), and that held writes never reorder a store's writes. Owned by [decide-policy-actions.md](decide-policy-actions.md) / [learn-situation-triage.md](learn-situation-triage.md). |
| `observe-delivery.test.ts` (054da38) | Observe: a conflicting fetch response with a slow body resolves at network time and is decided once in the background on the state it was delivered into; an app write before the body is read decides it at that write; F1 is not lost; standing questions on `delivery` are answered; XHR listeners run inside the original dispatch with the body analyzed first; WebSocket/EventSource messages delivered synchronously and in order, still decided. Guard unchanged: stale response held and discarded; a too-slow model releases at once and the write is late-reverted on its own. |
| `redaction-v2.test.ts` (f107013) | Numbers, bigints and arrays under strong secret containers are redacted; booleans/null and broad containers unchanged; F2 previews of redacted fields do not leak characters. |
| `situation-purity.test.ts` (29b7f28) | Building situations for every trigger kind changes no counter and no later id (`OpRegistry.peekNextId`); polling the runtime like the devtools overlay changes no decision, hold or id. |
| `test/install/cli.test.ts` (f3a9dd1) | `init`/`remove` round trips on fixture projects (`--no-install`) for Vite, Next.js 14-16, SvelteKit, Nuxt, Astro, Angular/CRA/Remix/React Router/webpack and plain HTML: marked import first, dev overlay line, `/auto/observe` for `--mode observe`, script tag with `data-mode`, no write without a terminal unless `--yes`, `remove` keeps user edits outside the markers; `edit.mjs` helpers; `config.ts` parsers (`parsePairs`, `fromDataset`, `mergeConfig`, `readMetaConfig`, `isKilled`, `isLocalHost`, `devtoolsOptions`) and `global.ts` -> `assetBase`. The real-framework and CDN checks (`test/install/frameworks.mjs`, `cdn-check.mjs`, `run-all.sh`) are VM-only. |
| `nan.test.ts` (ad24804) | A store holding `NaN` builds a situation without recursing (`describe` uses `Object.is`). |
| `report.test.ts` | `GenClass.init` idempotent, `GenClass.runtime`, `destroy` clears it; `?genclass=off` leaves `fetch` untouched, mode `observe`, exactly one `console.info`; `?genclass=heal` overrides `mode: "guard"`; `on("decide" \| "detect" \| "act" \| "event")` order and unsubscribe; report lines and console grouping/de-dup. |
| `batch3.test.ts` | Lifecycle: `ask` after destroy rejects `"destroyed"`; `createRuntime` survives read-only `fetch`; `GenClass.init` with a throwing plugin `setup` does not throw; a provider that never answers does not block later decisions; rate-limit warning once per minute. |
| `review-misc.test.ts` | Init robustness on frozen globals; `ask` after destroy (`reason: "destroyed"`); console reports reach the console as `×N` summaries; queue robustness. |
| `ask.test.ts` | `ask` sends trigger `ask` with question id `answer`; typed answers (`expectTypeOf`); `decide` returns the label; `about` op id / store; no decider -> `GenClassUnavailableError`, `status.state === "off"`, `ready` resolves; `timeoutMs` -> reason `"timeout"`. |
| `policy.test.ts` | `setMode` switches tiers at runtime; `pause()` stops consulting, `resume()` restores; loading status fails open with no record; observe mode never holds; detection threshold. |
| `plugins.test.ts` | Plugin facts/diagnoses/actions reach the model; custom action runs; `ctx.builtin`; default heal tier; `applicable`; standing questions; `setup` receives `PluginApi` (`recordOp`, `runInOp`, `emit`, `on`, `endOp`) and cleanup runs on unregister; vocabulary overrides. |
| `budget.test.ts` | `situationBudget()` "auto" values (2400 / 1000 / 1333 / 2000, threads capped at 4, unknown device 2400, fixed number wins); `max_tokens_exceeded` -> 1920 (2400 × 0.8); hold budget `"auto"` (300 fallback, 150..800 clamp, adapts to measured latency); determinism at a fixed budget. |
| `situation.test.ts` | `situation()` (ask about now) is side-effect free (no ops, no events); determinism of whole runs on a fake clock. |
| `smoke.test.ts` | Minimal `createRuntime` wiring (explicit `mode: "guard"`): atoms apply synchronously when nothing is salient; causality through awaits; a stale **response** is held at the delivery gate, the model is asked, and its stale writes are dropped in guard mode. |
| `dom.test.ts` | `destroy()` restores `fetch`, XHR `open`, `history.pushState`, `Storage.prototype.setItem`, `WebSocket`, `setTimeout`, and removes DOM listeners; `describeElement`; synthetic (`isTrusted` false) events become user actions only with `observe.untrustedEvents`. |
| `fetch.test.ts`, `xhr.test.ts`, `review-fetch.test.ts` | `destroy()` restores fetch/XHR; after destroy GenClass does no work even when another library wrapped fetch on top. |
| `review-timers.test.ts` | Uses `rt.internals` to check op pruning (timer loops do not retain ops). |
| `test/smoke/smoke.sh` | (VM only) packs the tarball, builds a fresh Vite app with `GenClass.init({ model: false, report: "console" })` and `mountDevtools`, loads it in headless Chromium. |

Which `initUnsafe` branch the unit tests hit: vitest runs in `environment: "node"` (no `window`), so every `GenClass.init` call in `report.test.ts`, `batch3.test.ts` and `default-mode.test.ts` goes through the **non-browser** branch (or the kill-switch `off` branch); the mode override test passes through `...(mode ? { mode } : {})` there. The **browser** branch (`o.model = options.model ?? {}`) is exercised only by `test/smoke/smoke.sh` on the VM, and only with `model: false`.

CI (`.github/workflows/ci.yml`, b435acb) runs typecheck, build, the unit tests without `test/browser/**` and `review-perf`, then `review-perf` alone with `--retry=2`, on pushes to `main`/`runtime`/`mvp`/`mvp-v2`, pull requests and manual dispatch. It does not run Playwright, `smoke.sh`, the sim or realapps.

Untested in this scope (by unit tests): `startAuto` and the script tag's `install()` in a DOM (only their pure helpers are unit-tested; the browser behaviour is in the VM-only install checks), that `/auto/guard` really starts in guard, the `localStorage.genclass` path of the kill switch, the browser branch of `initUnsafe` with a default model, the outer `catch` fallback of `GenClass.init` (the throwing-plugin test is caught inside `use`, not by the fallback), `learn.persist`, `settleMs`, `historySize`, `setReport`, `isPaused`, `createRuntime({ model: {...} })` fetch selection and `failedProvider`, and the `ask` + `timeoutMs` + load-failure path.

## Drift and open issues

| what | docs say | code does | evidence |
|---|---|---|---|
| Default mode | HANDOFF.md "Modes: observe → guard (default; ...)"; npm `0.1.0-alpha.0` | `o.mode ?? "observe"` on `mvp-v2` (f3636b2) and `mvp-v2-merge`. API.md, ARCHITECTURE.md, CONTRACT §2/§13, `types.ts` JSDoc, devtools labels and both READMEs (README.md, packages/runtime/README.md, which says plain `/auto` and the tag without `data-mode` observe) say observe. origin/runtime (through eff18cb) still defaults to guard. | `runtime.ts` -> `RuntimeImpl` constructor; `default-mode.test.ts` |
| `init` CLI mode | `bin/lib/init.mjs` -> `USAGE` ("guard (default)") and the summary row (`o.mode ?? "guard"`, "(default; --mode observe never changes anything)"), written against origin/runtime's guard default | `plan.mjs` -> `AUTO` maps `guard` and no `--mode` to plain `@genclass/runtime/auto`, and `scriptTag` omits `data-mode` for `guard`; on this branch both run in **observe**. So `init --mode guard` silently installs observe, and the printed "Mode guard" is wrong. Fix (INSTALL): map `guard` to `/auto/guard` and `data-mode="guard"`, make the default `observe`, update `cli.test.ts` fixtures. | `bin/lib/plan.mjs` -> `AUTO`, `scriptTag`; `bin/lib/init.mjs`; `src/auto.ts` |
| Zero-code entries vs npm | packages/runtime/README.md documents `npx @genclass/runtime init`, `/auto` and the script tag (with a note that alpha.1 lacks them); `package.json` says `0.1.0-alpha.1` | npm `0.1.0-alpha.1` (806a296) has none of them, `dist/genclass.global.min.js` is not on jsDelivr, and the CLI's `scriptTag` pins jsDelivr to the package's own version (`0.1.0-alpha.1`), whose file does not exist. The alias package `packages/genclass-runtime` (not on npm) is also at `0.1.0-alpha.1` and pins `"@genclass/runtime": "0.1.0-alpha.1"` exactly, whose bin has no `init`/`remove`; its naming question is open in `packages/runtime/INSTALL-NEEDS.md` (OPEN_TASKS.md item 14). Resolved for the scoped package on 2026-10-08: `0.1.0-beta.0` (`latest`) contains them and the alias now pins `0.1.0-beta.0`; the alias itself is still unpublished. | `npm view @genclass/runtime`, `npm view genclass-runtime` (404) (2026-10-08); `bin/lib/plan.mjs` -> `scriptTag`; `packages/genclass-runtime/package.json` |
| Script-tag model wiring | `ModelOptions` (`types.ts`) lists `baseUrl`, `device`, `worker`, `preload`, `ortWasmPaths`, `cacheName` | `global.ts` -> `withCdnModel` also passes `workerFactory` and `ortLoader` (host-only `ModelHostOptions`) through `model` by a cast; `createRuntime` spreads `model` into `createModelHost`, so they work, but the public type does not admit them | `src/cdn/global.ts`; `index.ts` -> `makeHost`; `model/host.ts` |
| `/auto/<mode>` precedence | The import path reads as "this mode" | The path's mode is the lowest-precedence default: a `<meta name="genclass" content="mode=...">` or `GENCLASS_CONFIG.mode` overrides it (as does the kill switch) | `cdn/auto-start.ts` -> `startAuto` |
| Observe deliveries | `RuntimeImpl.runDelivery` behaviour up to 054da38 | Fixed in 054da38: observe used to hold a conflicting response for up to `BODY_WAIT_MS` (body read) before release, and its decision was dropped as stale. API.md / ARCHITECTURE.md do not yet describe background delivery decisions. | `runtime.ts` -> `runDelivery`, `deliveryHoldable`; `observe-delivery.test.ts` |
| Auto situation budget (WebGPU / unknown device) | `docs/runtime/ARCHITECTURE.md` ("3,200 characters on WebGPU"), STATUS.md's older line ("webgpu 3,200", followed by "(Batch 4: webgpu and unknown device 2,400.)") | `STATE_CHAR_BUDGET` = 2400 since batch 4; WASM 1000/1333/1667/2000 unchanged. `types.ts` JSDoc (fixed in batch 4), API.md, packages/runtime/README.md and `MockRuntime.situationBudget` (2400) match the code. | `situation/serialize.ts`; `runtime.ts` -> `situationBudget`; `budget.test.ts` |
| Default redaction | `docs/runtime/CONTRACT.md` §2 (`/pass\|token\|secret\|card\|cvv\|ssn\|auth/i`) | Leaf-field rule (`isSensitivePath`): `auth.loading` and `auth.user.name` visible, `auth.token` redacted; opaque strings under `auth`/`session`/`cookie` redacted. `types.ts` JSDoc, API.md and packages/runtime/README.md were updated in batch 4/5 and match. | `util.ts` -> `isSensitivePath`, `defaultRedact` |
| `observe` option JSDoc | `types.ts`: a leftover `/** Default: all true (where the global supports them). */` sits directly above the new JSDoc on `InitOptions.observe` (two doc comments; editors show the last one) | `timers` only with a document; `eventsource` included; `untrustedEvents` default false | `types.ts` -> `InitOptions.observe`; `runtime.ts` -> `installObservers` |
| CONTRACT §2 observer list | `observe?: Partial<Record<"fetch"\|...\|"websocket", boolean>>; // default all true` | Also `eventsource`, `timers` (document-only default) and the `untrustedEvents` flag. API.md lists all of them. | `types.ts` -> `ObserverName`, `InitOptions.observe` |
| Non-browser `GenClass.init` | API.md: "returns an inert runtime: no observers, no model" | Observers off and no model host, but `options.decider`, `plugins`, `policy`, `mode` are kept; `report` defaults to `"silent"` | `index.ts` -> `initUnsafe` |
| `GenClass.destroy()` | API.md: "uninstall observers, restore globals, terminate the model worker" | Terminates only a host the runtime created (`ownsDecider`); a global is restored only if it is still GenClass's wrapper, otherwise the wrapper becomes a pass-through | `runtime.ts` -> `destroy`; `observe/fetch.ts` uninstall |
| `rt.ready` | API.md/types.ts: "resolves when the model is ready" | Also rejects (provider error, e.g. `ModelLoadError`) on load failure, and the rejected promise is memoised | `runtime.ts` -> `get ready` |
| `ask` error type | API.md: rejects with `GenClassUnavailableError` when no model can answer | With `timeoutMs` and a failed load, the raw provider error propagates (the race uses the unwrapped `ready` promise); `timeoutMs` is applied to the load wait and the answer wait separately | `runtime.ts` -> `ask` |
| `on("status")` | API.md: "model loading progress and state" | Also fired by every `setMode` call | `runtime.ts` -> `setMode`; devtools relies on it |
| `pause()` | API.md: "stops consulting the model" | Triggers stop, but `ask()`/`decide()` still query the model while paused | `runtime.ts` -> `ask` has no `paused` check |
| `ModelOptions` | API.md options block lists `baseUrl`, `device`, `worker`, `preload` | Also `ortWasmPaths` and `cacheName` | `types.ts` -> `ModelOptions` |
| Hold budget fallback | API.md / `types.ts` describe only `clamp(1.5 × median, 150, 800)` | 300 ms when no latency sample and no `warmupMs` | `decide/policy.ts` -> `holdBudget`, `HOLD_FALLBACK_MS` |
| `situation(trigger)` | CONTRACT §13: side-effect free | Returns the last situation built for that trigger when there is one; building caches `op.reads` | `runtime.ts` -> `situation`, `build`; acknowledged in STATUS.md "Deviations" |
| Runtime surface | CONTRACT §2 `Runtime` | Also `mode`, `adapter`, `inflight`, `holdBudgetMs`, `situationBudget`, `on("report")` | STATUS.md "Extra public surface" acknowledges all of these except `mode`, which neither CONTRACT §2 nor STATUS.md lists |
| STATUS.md open issue | "`react-dom` is not a devDependency of `@genclass/runtime`" | `package.json` devDependencies include `react-dom ^19.3.0` and `@types/react-dom ^19.0.0` (stale item) | `packages/runtime/package.json` |
| `Decision.action` | `types.ts` JSDoc: "The action the model chose (highest probability)" | `action = run ?? top`: the action that ran (the gate's most probable **permitted** candidate, which can differ from the model's top choice) or, when nothing ran, the model's top choice. API.md ("the action that ran, else the model's choice") matches the code. | `runtime.ts` -> `onDecision` |
| `EvaluateRequest.priority` | `types.ts` JSDoc: "held writes/requests use 2, background 0" | Background triggers use 1 (`stall`, `inconsistency`, XHR `failure`, `ask`) or 0 (`transition`, `error`); a holdable trigger that does not wait is capped at 1 | `runtime.ts` -> `trigger`; see [Events](#events-runtimeevents) |
| `RuntimeImpl.setReport` | JSDoc: "Report sink for a custom destination at runtime (devtools)" | No caller anywhere in the repo (devtools does not use it) | `git grep setReport` |
| API.md shapes | `Situation` listed as `{ trigger, subject, state, questions, actions, salient, facts }`; `Op` without `meta` | `Situation` also has `compact` and `budget`; `Op` also has `meta` | `types.ts` -> `Situation`, `Op` |
| API.md observers | "The DOM, fetch, XHR, WebSocket and timers are observed automatically" (packages/runtime/README.md now lists them all) | Also `eventsource` (batch 4), `perf` (long tasks) and `timers` (timers only when `global.document` exists) | `runtime.ts` -> `installObservers` |
| Report console hint | "Deny this action: `GenClass.init({ policy: { deny: [...] } })`" | A no-op once `GenClass.init` has run (idempotent init ignores the new options) | `decide/report.ts` -> `Reporter.emit`; `index.ts` -> `GenClass.init` |
| Default model URL | README (before 9695830): the runtime model is not published yet; alpha observes only | Resolved 2026-10-08 ~13:40 UTC. `DEFAULT_MODEL_BASE_URL` points at `@genclass/runtime-model@0.1.0` on jsDelivr and so does the CLI's `DEFAULT_FROM` (until 2026-10-08 the GitHub release `runtime-model-v0.1.0`); the package (`r17-v2b`, situation-v2) is published and the URL resolves, so a default browser `init()` loads the model (before that both were 404 and `init()` ended in status `error`, "Model unavailable ...; observing only."). R17-final1 (situation-v1) does not match this runtime. | `model/host.ts`; `bin/genclass-runtime.mjs` -> `DEFAULT_FROM`; HANDOFF.md; OPEN_TASKS.md item 12 |
| npm `0.1.0-alpha.0` vs this branch | npm "latest" until 2026-10-08 | The older alpha predates the NaN fix (ad24804: `describe` recursed forever on a `NaN` store value), situation-v2 (delivery gate, `holdWrites`, `eventsource`, new redaction, budget 2400) and the observe default. Resolved for new installs: `0.1.0-alpha.1`, built from `mvp-v2` (806a296), became `latest` on 2026-10-08, then `0.1.0-beta.0` (1f0f617, ~13:40 UTC; alpha.0 is deprecated); procedure in [RELEASE.md](../../../RELEASE.md). alpha.1 in turn lacks everything after 806a296 (zero-code entries, 054da38, f107013). | `npm view @genclass/runtime` (2026-10-08); `nan.test.ts` |
| Dead code | | `on()` contains an empty `if (type === "report") {}` block | `runtime.ts` -> `on` |
| `explainMap` bound | (no doc) the `DECISIONS_KEPT * 2` check in `onDecision` suggests a 400-entry cap | Only `onDecision` evicts (one entry, when size > 400); `finish` adds `a<n>` entries without eviction, so the map grows by one per executed action for the life of the runtime (bounded in rate by `maxActionsPerMinute`, not in size) | `runtime.ts` -> `onDecision`, `finish` |
| Init with malformed `plugins` | `GenClass.init` "never throws" | It does not throw, but a non-iterable `plugins` / `plugin.actions` / `plugin.questions` throws inside `RuntimeImpl`'s constructor after the observers were installed; the fallback inert runtime is returned while the first instance's wrappers stay on the globals | `runtime.ts` -> constructor, `use`; `index.ts` -> `GenClass.init` |
| `decisions(0)` / `interventions(0)` | | Return the whole buffer (`slice(-0)`), while `history(0)` returns `[]` | `runtime.ts` |

Open items relevant here (OPEN_TASKS.md, HANDOFF.md, training/NEEDS.md): the model path is 150M teacher on situation-v2 gold -> teacher labels on unlabeled rows -> distil R17 (default) and R32 -> DAgger via SIM `--on-policy` -> EVAL -> publish `@genclass/runtime-model@0.1.0` (the default `baseUrl`) -> rerun the demos -> publish `@genclass/runtime@0.1.0` without the alpha tag. The situation-v2 data is done (eff18cb: 10.4M gold, 51.3M unlabeled; plus real-browser gold rows from `realapps/` over 96 apps (`v2c1`..`v2c4`; the corpus on this branch has 128 app manifests), [../realapps.md](../realapps.md)); on 2026-10-08 the Azure jobs `r17-v2a` (R17 on v2 gold, 8 nodes, ETA ~06:20 UTC, auto eval and export via `training/v2_post.sh`; origin/runtime 416e374, not merged here, already records first `r17-v2a` results in RESULTS.md) and `t150-v2a` (150M teacher, 11 nodes, ETA ~08:30 UTC) were launched (OPEN_TASKS.md "In progress" items 1 and 2). Since 2026-10-08 ~13:40 UTC the first situation-v2 model is published (`@genclass/runtime-model@0.1.0` = `r17-v2b`), together with `@genclass/runtime@0.1.0-beta.0`, which carries the zero-code entries, 054da38 and f107013. OPEN_TASKS.md item 16 (CI) is done on `mvp-v2` (b435acb); the `npm pack` smoke test in a fresh Vite app is not in CI. Why writes are no longer held (commit fcd1e68): store-write holds reordered in-app writes (held echoes overwrote newer user writes, read-after-write broke) and broke the unmodified RealWorld React/Redux app even with an always-passive model; the related "hold-induced harm" in the v0.1 demos is recorded in RESULTS.md §5 and OPEN_TASKS item 13 (demo rerun). Demo numbers with a v2 model are not measured yet. With the published model, `GenClass.init()` (and every zero-code entry) loads the model and decides, but with the observe default it does not act unless `mode: "guard"` is set, e.g. via `/auto/guard` (before 2026-10-08 no model loaded, so nothing could act).

## Related docs

- [observe-and-trace.md](observe-and-trace.md): observers, ops, causality, `op`/`user`/`emit` internals
- [state-and-adapters.md](state-and-adapters.md): stores, mutation pipeline, invariants, snapshots, adapters
- [learn-situation-triage.md](learn-situation-triage.md): baselines, profiles, facts, triggers, triage, serialisation, budgets
- [decide-policy-actions.md](decide-policy-actions.md): decision queue, policy gate, actions, reports, explain, undo
- [model-host.md](model-host.md): `createModelHost`, worker, loader, backends, CLI
- [devtools.md](devtools.md): devtools overlay (consumer of this API)
- [build-test-release.md](build-test-release.md): build, tests, VM workflow, publishing
- [../overview.md](../overview.md#3-runtime-data-flow-end-to-end): end-to-end data flow and the stale-write walkthrough
- [../model-io-contract.md](../model-io-contract.md): situation text -> model -> answers; `situation-v2`
- [../sim.md](../sim.md): how the sim drives `createRuntime` deterministically
- [../realapps.md](../realapps.md): the real-browser corpus and harness (uses `observe.untrustedEvents`)
- [../status-and-known-issues.md](../status-and-known-issues.md), [../glossary.md](../glossary.md), [../playbooks.md](../playbooks.md), [../README.md](../README.md)
- Original sources: [docs/runtime/API.md](../../runtime/API.md), [docs/runtime/CONTRACT.md](../../runtime/CONTRACT.md), [docs/runtime/ARCHITECTURE.md](../../runtime/ARCHITECTURE.md), [packages/runtime/README.md](../../../packages/runtime/README.md), [packages/runtime/STATUS.md](../../../packages/runtime/STATUS.md), [docs/runtime/RESULTS.md](../../runtime/RESULTS.md), [OPEN_TASKS.md](../../../OPEN_TASKS.md), [HANDOFF.md](../../../HANDOFF.md), [RELEASE.md](../../../RELEASE.md)
