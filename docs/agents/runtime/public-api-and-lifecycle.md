# @genclass/runtime: public API, options and lifecycle

> **Scope:** `packages/runtime/src/index.ts`, `packages/runtime/src/runtime.ts` (wiring, construction, init/destroy, modes, kill switch, option resolution, events, plugins, introspection, settled points), `packages/runtime/src/types.ts`, `packages/runtime/src/errors.ts`, `packages/runtime/src/clock.ts`, `packages/runtime/src/util.ts`, `packages/runtime/package.json`.
> **Read this when:** you add or change an init option, a `Runtime` method, an event, a plugin hook or a subpath export; you touch `GenClass.init` / `createRuntime` / the kill switch / `destroy()`; you need the exact default of any option; you add timing or scheduling code; you wire a new subsystem into `RuntimeImpl`.
> **Source of truth:** the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

## TL;DR

- Two entry points: `GenClass.init(options)` (browser facade: singleton, never throws, kill switch, loads the local model by default) and `createRuntime(options)` (headless: tests, sim, SSR; no model unless `decider` or `model: {...}` is passed). Both return a `RuntimeImpl` typed as `Runtime`. `createRuntime` can throw on malformed options; `GenClass.init` never throws (it falls back to an inert runtime).
- `GenClass.init` is idempotent: a second call returns the first runtime and **ignores its new options**. Only `GenClass.destroy()` clears the singleton; `rt.destroy()` alone does not.
- Three modes: `observe` (never changes execution, nothing held), `guard` (default; guard-tier actions only), `heal` (guard + heal tier). A **tier** is the mode an action needs; the **policy gate** compares the mode with the action's tier.
- Kill switch: `?genclass=off` (URL wins) or `localStorage.genclass = "off"` gives an inert runtime; the values `observe|guard|heal` override `options.mode`.
- The decider (`DecisionProvider`) is the only seam to the model. `createRuntime` builds a model host (`createModelHost`) only when `options.decider === undefined` and `options.model` is an object; the runtime then **owns** it and disposes it on `destroy()`. A caller-supplied decider is never disposed.
- The runtime consults the decider only while its `status.state` is `"ready"` or `"off"` (lazy). `"loading"` and `"error"` mean every trigger fails open at once (passive action, nothing held, no decision recorded).
- Everything time-related goes through the injected `Clock` (`browserClock` by default). Runtime code never calls `Math.random`, `Date.now`, `performance.now` or the global `setTimeout`; ids come from counters. This is what makes the sim deterministic and keeps train/runtime parity.
- Construction order matters: core subsystems, then queue/reporter/env, hub hooks, event and status subscriptions, persisted profiles, observers (each wrapped in try/catch), then plugins. `destroy()` is idempotent and tears down in roughly reverse order.
- A **settled point** is reached `settleMs` (default 60 ms) after the last op end / applied write / discarded write, when nothing younger than 10 s is in flight and no write is pending. Invariants and transition profiles are learned there and `inconsistency` / `transition` triggers are raised there.
- Events: `detect`, `decide`, `act`, `event`, `status`, `report` via `rt.on(type, fn)`; listener exceptions are swallowed (logged with `debug: true`).
- `util.ts` helpers (`secs`, `fmtNum`, `describe`, `normalizePath`, `isSensitiveName`, ...) shape the situation text. Changing them changes the frozen `situation-v1` format and breaks train/runtime parity.

## Files

| path | role | key exports / entry points |
|---|---|---|
| `packages/runtime/src/index.ts` | Public facade and root module | `GenClass` (also `default`), `createRuntime`, re-exports (see [Root module exports](#root-module-exports)); private `killSwitch`, `initUnsafe`, `makeHost`, `failedProvider`, `NATIVE_FETCH`, `MODES`, `ALL_OFF` |
| `packages/runtime/src/runtime.ts` | `RuntimeImpl`: wires trace, state, learn, situation, decide and observers; implements every `Runtime` method; actions that need runtime state (rollback, chain revert, resync, late revert); settled points | `RuntimeImpl`, `RuntimeInternals`, `normalizeError`, type re-exports `SituationDraft`, `BuiltSituation` |
| `packages/runtime/src/types.ts` | Every public and shared type. Header: CORE owns it; the "model seam" section (top) is shared with MODEL (`src/model/**`) and mirrored by `sim/src/types.ts` | `InitOptions`, `CreateOptions`, `ModelOptions`, `PolicyOptions`, `Runtime`, `RuntimeEvents`, `Plugin`, `PluginApi`, `DecisionProvider`, `Clock`, ... |
| `packages/runtime/src/errors.ts` | The one runtime-level error class | `GenClassUnavailableError` |
| `packages/runtime/src/clock.ts` | Real clock; captures timers at module load | `browserClock` |
| `packages/runtime/src/util.ts` | Deterministic helpers: hashing, stable stringify, number/time formatting, redaction, value descriptions, URL signatures | see [util.ts helpers](#utilts-helpers) |
| `packages/runtime/package.json` | Package manifest: exports map, bin, deps, peer deps | `exports`, `bin.genclass-runtime` |
| `packages/runtime/tsup.config.ts` | Build entries (one per subpath export, including `worker`) | `entry`, `dts.entry`, `external` |

Read-only neighbours this doc leans on: `src/decide/policy.ts` (`policyConfig`, `holdBudget`, `gate`), `src/decide/decider.ts` (`DeciderQueue`), `src/decide/report.ts` (`Reporter`), `src/model/host.ts` (`createModelHost`, `DEFAULT_MODEL_BASE_URL`), `src/situation/serialize.ts` (`STATE_CHAR_BUDGET`, `COMPACT_BUDGET`), `src/trace/events.ts` (`EventLog`), `src/state/hub.ts` (`StoreHub`).

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

### Package exports (`packages/runtime/package.json`)

ESM only (`"type": "module"`, only `import` conditions), `"sideEffects": false`, `engines.node >= 20`, version `0.1.0-alpha.0`, license Apache-2.0.

| subpath | types | import | source entry (tsup) | documented in |
|---|---|---|---|---|
| `@genclass/runtime` | `./dist/index.d.ts` | `./dist/index.js` | `src/index.ts` | this doc |
| `@genclass/runtime/react` | `./dist/adapters/react.d.ts` | `./dist/adapters/react.js` | `src/adapters/react.ts` | [state-and-adapters.md](state-and-adapters.md) |
| `@genclass/runtime/redux` | `./dist/adapters/redux.d.ts` | `./dist/adapters/redux.js` | `src/adapters/redux.ts` | [state-and-adapters.md](state-and-adapters.md) |
| `@genclass/runtime/zustand` | `./dist/adapters/zustand.d.ts` | `./dist/adapters/zustand.js` | `src/adapters/zustand.ts` | [state-and-adapters.md](state-and-adapters.md) |
| `@genclass/runtime/devtools` | `./dist/devtools/index.d.ts` | `./dist/devtools/index.js` | `src/devtools/index.ts` | [devtools.md](devtools.md) |
| `@genclass/runtime/worker` | (none) | `./dist/worker.js` | `src/model/worker.ts` | [model-host.md](model-host.md) |
| `@genclass/runtime/package.json` | | `./package.json` | | |

- Legacy top-level fields: `main` and `module` = `./dist/index.js`, `types` = `./dist/index.d.ts` (same targets as the `.` export). `repository.directory` = `packages/runtime`.
- `bin`: `genclass-runtime` -> `./bin/genclass-runtime.mjs`: `fetch-model <dir> [--from <baseUrl>] [--variant q8|fp16|all] [--force] [--quiet]` and `info <dir>` (details in [model-host.md](model-host.md)).
- `dependencies`: `onnxruntime-web ^1.30.0` (the only runtime dependency; CONTRACT §0 forbids adding others without the lead).
- `peerDependencies` (all optional via `peerDependenciesMeta`): `react >=18`, `redux >=4`, `zustand >=4`.
- `devDependencies`: `@playwright/test 1.63.0`, `@types/react ^19.0.0`, `@types/react-dom ^19.0.0`, `esbuild ^0.27.0`, `happy-dom ^20.14.5`, `onnxruntime-node 1.30.0`, `react ^19.3.0`, `react-dom ^19.3.0`, `redux ^5.0.1`, `tsup ^8.5.1`, `typescript ~5.9.3`, `vitest ^5.0.3`, `zustand ^5.0.15`.
- `files`: `dist`, `bin`, `README.md`, `LICENSE`. Scripts: `build` (tsup), `typecheck` (`tsc -p tsconfig.json --noEmit`), `test` (`vitest run`), `test:browser` (`playwright test --config test/browser/playwright.config.ts`).
- `tsup.config.ts`: ESM only, `target: "es2022"`, `platform: "browser"`, `splitting: true`, `sourcemap: true`, `treeshake: true`; `external`: `onnxruntime-web`, `onnxruntime-web/webgpu`, `react`, `redux`, `zustand`. `worker` has no `.d.ts` (not in `dts.entry`).
- Git tags: `situation-v1` (situation-format freeze) and `v0.1.0-alpha.0` (the published alpha).

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
| `stateText`, `stateChars`, `sectionLimits`, `STATE_CHAR_BUDGET` (3200), `COMPACT_BUDGET` (1100) | serializer | `src/situation/serialize.ts` |
| `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS`, `PASSIVE`, `DEFAULT_DIAGNOSES` | question vocabulary | `src/situation/questions.ts` |
| `describeElement` | DOM element -> `'button "Place order"'` | `src/observe/dom-user.ts` |
| `RuntimeImpl` | class (advanced; exposes internals) | `src/runtime.ts` |

Not exported from the root: `util.ts` helpers, `normalizeError`, `policyConfig`/`holdBudget`/`gate`, `COMPACT_QUESTIONS_BUDGET` (1400).

### Modes and tiers

`Mode = "observe" | "guard" | "heal"`; `Tier = "passive" | "guard" | "heal"` (`types.ts`). The mode-tier rule is `src/decide/policy.ts` -> `modeAllows`:

| mode | permitted tiers | holds | notes |
|---|---|---|---|
| `observe` | passive only | never (`trigger()` never waits because `permittedActions` is empty; `hub.hooks.mayHold` also returns false, so the hub does not protect live state from in-place updaters) | Decisions are still made in the background (deadline 5,000 ms) and recorded, so detections and reports work. |
| `guard` (default) | passive, guard (`discard`, `defer`, `coalesce`, `delay`, guard-tier custom actions) | when a guard action is permitted for the trigger | |
| `heal` | passive, guard, heal (`block`, `serve_cached`, `retry`, `hedge`, `rollback`, `resync`, custom actions (`rt.action` or plugins), which default to heal) | when any non-passive action is permitted | |

Threshold defaults (`policyConfig`): `report` 0.6, `guard` 0.9, `heal` 0.8. The full gate is in [decide-policy-actions.md](decide-policy-actions.md).

### `InitOptions` (`types.ts` -> `InitOptions`)

Defaults below are what `RuntimeImpl`'s constructor applies, unless the row says otherwise. `GenClass.init` changes some of them per path (see [GenClass.init](#1-genclassinitoptions)).

| option | type | default | effect / where read |
|---|---|---|---|
| `mode` | `Mode` | `"guard"` (`o.mode ?? "guard"`) | Initial mode; the kill switch overrides it in `GenClass.init`. Change later with `setMode`. |
| `model` | `ModelOptions \| false` | `GenClass.init` in a browser: `{}` (load the local model with defaults) unless `decider` is given or `model === false`. `createRuntime`: no model unless an object is passed. | Read only in `index.ts` -> `createRuntime`; `RuntimeImpl` never reads it. |
| `decider` | `DecisionProvider \| null` | `undefined` | Any provider (test double, sim, custom). Wins over `model`. `null` means "no model" even if `model` is an object. |
| `report` | `"console" \| "silent" \| (r: Report) => void` | `"console"` | Report sink (`Reporter`). `GenClass.init` defaults it to `"silent"` outside a browser. `on("report")` listeners get every report regardless of the sink. |
| `observe` | `Partial<Record<ObserverName, boolean>>` | every observer on, except `timers`, which is on only when `global.document` is a non-null object | `RuntimeImpl.installObservers`; unknown keys ignored. Forced to all-off outside a browser, by the kill switch and in the init fallback. |
| `triage` | `"salient" \| "always"` | `"salient"` | `"salient"`: ask only when some fact is non-neutral (or a standing question has `always: true`). `"always"`: build and ask for every consultable trigger (tests). |
| `policy` | `PolicyOptions` | see [PolicyOptions](#policyoptions) | `policyConfig(o.policy)` once at construction (not changeable later). |
| `redact` | `(path: string, value: unknown) => unknown` | `util.ts` -> `defaultRedact` | Return something `!==` value to redact. Used by the hub, invariant miner, observers, `emit`, `user`, situation building. |
| `plugins` | `Plugin[]` | `[]` | Installed with `use()` at the end of the constructor. |
| `historySize` | `number` | `500` | `EventLog` ring buffer size; effective minimum 16 (`new Array(Math.max(16, size))` in `src/trace/events.ts` -> `EventLog`). `NaN`, or a non-integer of 16 or more, makes `new Array(...)` throw `RangeError` in the constructor (`createRuntime` throws; `GenClass.init` falls back to the inert runtime); a fraction below 16 is silently raised to 16. |
| `debug` | `boolean` | `false` | `RuntimeImpl.log` -> `console.debug("[GenClass] ...")`: every decision, plus otherwise-silent failures (observer install, plugin setup, listener, model, passive/situation build errors). |
| `learn` | `{ persist?: boolean }` | `persist: false` | Transition profiles to `global.localStorage` key `genclass.profiles.v1`: loaded at construction; a settled point that had queued ops to profile schedules one write 5,000 ms later (`saveProfilesSoon`; not a debounce: while a write is pending, later settled points do not reschedule it). |
| `vocabulary` | `Vocabulary` (`{ diagnoses?: Record<string,string>; actions?: Partial<Record<string,string>> }`) | `undefined` | `diagnoses` replaces `DEFAULT_DIAGNOSES`; `expected` is always kept (added from the defaults if missing, always first) and plugin labels are added only when the label is not already present (`situation/questions.ts` -> `diagnosisVocabulary`). `actions[name]` overrides the description of a built-in **or custom** action (`actionDescription`: vocabulary, then `ActionDef.description`, then built-in). Changes model input wording. |
| `settleMs` | `number` | `60` | Quiet time before a settled point. |
| `situation` | `{ budget?: number \| "auto" }` | `"auto"` | Situation size in characters. A number is used as is (no device sizing, no budget scale). See `situationBudget()`. |

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
| `startOp(kind, name, o?)`, `endOp(op, status, o?)` | Op creation/completion with events, baselines, profiling queue, `hooks.opCreated`, settle scheduling. |
| `runAsGenClass(name, fn)` | Run `fn` inside an instant `"genclass"` op (`cause: null`): its writes and requests are never gated. |
| `settled()` | Run a settled point now (normally called by the settle timer). |
| `chainWrites(op)`, `revertChain(op, why)`, `rollback(stores, violationIds?, beforeSeq?)`, `resync(stores)` | Action implementations for error/transition/inconsistency triggers. |

### Events (`RuntimeEvents`)

| type | payload | fired from | when |
|---|---|---|---|
| `detect` | `Detection` (= `Decision`) | `RuntimeImpl.onDecision` | `decision.diagnosis !== "expected"` and `diagnosisConfidence >= policy.thresholds.report` (0.6), whether or not an action ran. Fired right after `decide`. |
| `decide` | `Decision` | `RuntimeImpl.onDecision` | Every model decision on a trigger (not for `ask`/`decide` calls, not while loading, not for triage-skipped triggers, and not when the queue returns no answer: deadline passed, queue overflow, provider error or timeout, runtime destroyed). |
| `act` | `ActionRecord` | `onDecision` -> `finish` | Every non-passive action that ran (also failed ones, `ok: false`), after its effect resolved. |
| `event` | `RtEvent` | `EventLog.onEvent` / `EventLog.touch` | Every traced event; a typing burst re-fires the same (mutated) event object. |
| `status` | `ModelStatus` | `decider.onStatus` subscription; `setMode` | Model status changes; also on every `setMode` call (devtools refreshes its mode view on it). |
| `report` | `Report` (`{ kind: "detect" \| "intervene" \| "status", message, decision?, action? }`) | `Reporter.emit` listener | Every report, before the sink: also with `report: "silent"`, and without the console's one-minute de-duplication. |

Order inside one decision (`RuntimeImpl.onDecision`): `event` (an `RtEvent` of kind `"decision"`) -> `decide` -> `detect` (if detected) -> standing-question `onAnswer` callbacks -> either (no action runs: `ctl.passive()`, then a `report` detect line if detected) or (action runs: `rate.take`, the action, and once its effect resolves or fails: `event` (kind `"action"`) -> `act` -> `report` intervene line). A failed action (throw or rejection) runs the passive action first and records `ok: false`.

Trigger priorities (`EvaluateRequest.priority`, higher is served first by `DeciderQueue`): held `mutation` (`gateMutation`), `request` and fetch `failure` = 2; `stall`, `inconsistency`, XHR `failure`, `ask` = 1; `transition`, `error` = 0. A holdable trigger that does not actually wait is capped at 1 (`Math.min(priority, 1)` in `trigger`).

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
| trace | `EventKind`, `RtEvent`, `OpKind`, `OpStatus`, `Op`, `UserAction` | [observe-and-trace.md](observe-and-trace.md) |
| state | `StoreOptions`, `Atom`, `Guarded`, `StoreIO`, `AdapterIO`, `AdapterHandle`, `Change` | [state-and-adapters.md](state-and-adapters.md) |
| options | `Mode`, `Tier`, `ObserverName`, `PolicyOptions`, `Vocabulary`, `RuntimeHooks`, `ModelOptions`, `InitOptions`, `CreateOptions` | this doc |
| questions | `AskOptions` (`about?: "now" \| number /* op id */ \| string /* store */`, `timeoutMs?`) | this doc |
| situations | `FactKind`, `Fact`, `Situation`, `RequestInfo`, `SituationDraft` | [learn-situation-triage.md](learn-situation-triage.md) |
| decisions | `Decision`, `Detection`, `ActionRecord`, `Report`, `Explanation` | [decide-policy-actions.md](decide-policy-actions.md) |
| plugins | `ActionContext`, `ActionDef`, `StandingQuestionContext`, `StandingQuestion`, `PluginApi`, `Plugin` | this doc / [decide-policy-actions.md](decide-policy-actions.md) |
| runtime | `RuntimeEvents`, `Runtime` | this doc |

Key literal unions: `TriggerKind = "mutation" | "request" | "failure" | "stall" | "inconsistency" | "transition" | "error" | "ask"`; `ObserverName = "fetch" | "xhr" | "user" | "errors" | "nav" | "storage" | "perf" | "websocket" | "timers"`; `ModelStatus.state = "off" | "loading" | "ready" | "error"`.

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
| `identicalMap` | request identity -> recent ops | 12 per identity, 512 identities, 10 s |
| `errorsRecent` | recent error keys | 64, 10 s window |
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
4. `policy = policyConfig(o.policy)`; `hub.holdUserWrites = policy.holdUserWrites`; `rate = new RateLimiter(() => policy.maxActionsPerMinute)`.
5. Scalars: `_mode`, `triage`, `vocab`, `hooks`, `settleMs` (60), `budgetOpt` (`"auto"`), `appFn`, `debug`, `persist`, `decider`, `ownsDecider`.
6. `queue = new DeciderQueue(clock, () => decider, onError)`; `onError` shrinks `budgetScale` on `max_tokens_exceeded` and logs.
7. `reporter = new Reporter(o.report ?? "console", clock, id => explain(id), r => fire("report", r))`.
8. `env = makeEnv()`.
9. `hub.hooks = { gate: gateMutation, mayHold: consultable() && mode !== "observe", appError: reportError, waitRelated, applied: onApplied, discarded: scheduleSettle, proposed: hooks.mutationProposed wrapper }`.
10. `events.onEvent(e => fire("event", e))`.
11. If `decider.onStatus` exists: subscribe (fire `status`; status reports on `ready`/`error`); push the unsubscribe into `uninstall`.
12. If `learn.persist`: `loadProfiles()` from `global.localStorage["genclass.profiles.v1"]` (errors ignored).
13. `installObservers(o.observe ?? {})`, in this order: `timers`, `fetch`, `xhr`, `websocket`, `user`, `errors`, `nav`, `storage`, `perf`. Each install is in `tryAdd` (a throwing installer is skipped and logged with `debug`); a non-null returned function is pushed into `uninstall`.
14. `for (const p of o.plugins ?? []) this.use(p)`.

Constructing a `RuntimeImpl` immediately patches the instrumented globals (fetch, XHR, timers, history, Storage, WebSocket, DOM listeners).

### 4. Model readiness

1. A host with `preload: "idle"` (default) starts loading after page load and idle; status goes `off` -> `loading` -> `ready` | `error`, each forwarded as a `status` event.
2. While `loading` or `error`, `consultable()` is false: observers and the hub skip triggers entirely (no facts, no holds, no decisions).
3. While `off` (lazy preload not started yet), triggers compute facts; the first salient one reads `this.ready` (starting the load via `decider.ready()`) and fails open.
4. `rt.ready` memoises the first `decider.ready()` promise and attaches a no-op `catch` so an unobserved failure is not an unhandled rejection.

### 5. Trigger path (facade view)

Observers and the hub call `RuntimeImpl.trigger(spec, ctl, { hold, priority })`. In order: not consultable -> passive; `computeFacts`; with `triage: "salient"`, all facts neutral and no `always` standing question -> passive; `buildSituation`; not ready -> start lazy load, passive; hold only if `hold` and some non-passive action is permitted in this mode/policy and not paused; the hold budget timer runs passive on expiry; submit to `DeciderQueue` with deadline `t0 + holdBudget (+ 2,000 ms late-revert window when the controller can revert)` for held subjects, else `t0 + 5,000 ms` and priority `min(priority, 1)`; `onDecision` gates and acts. Full detail: [decide-policy-actions.md](decide-policy-actions.md).

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
3. `queue.dispose()` (queued requests resolve `null`, so pending triggers fail open and pending `ask`s reject). The one evaluation already dispatched is not cancelled: it settles normally (or after its deadline / `PROVIDER_TIMEOUT_MS`), a trigger waiting on it runs passive because `destroyed` is set, but an `ask` waiting on it can still resolve with an answer after `destroy()`.
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
| `ALL_OFF` | `Record<ObserverName, boolean>` | all nine observers `false` | `index.ts` | Observer set for inert runtimes. Must list every `ObserverName` (type-enforced). |
| kill-switch key | string | URL param `genclass`, localStorage key `genclass` | `index.ts` -> `killSwitch` | `off` / `observe` / `guard` / `heal`; trimmed, case-insensitive; URL wins. |
| `NATIVE_FETCH` | `typeof fetch \| undefined` | `globalThis.fetch.bind(globalThis)` at module evaluation | `index.ts` | Fetch used by an owned model host when no `global` is passed. |
| `DECISIONS_KEPT` | number | `200` | `runtime.ts` | Size of `decisions()` / `interventions()` buffers; default `n`; the explain map evicts (one entry per decision) above `2 ×` this. |
| `LATE_REVERT_MS` | number | `2000` | `runtime.ts` | Late-revert window after a held write applied; extends the held-decision deadline. |
| `BACKGROUND_DEADLINE_MS` | number | `5000` | `runtime.ts` | Deadline for non-held decisions. |
| `STALL_MIN_MS` | number | `500` | `runtime.ts` | Stall timer at `max(4 × median, 2 × p95, 500)` ms of the signature's latency. |
| `LONG_RUNNING_MS` | number | `10000` | `runtime.ts` | Ops older than this do not block settled points; `defer` waits at most this long. |
| `PROFILED` | `Set<OpKind>` | `fetch`, `xhr`, `user`, `task`, `ws` | `runtime.ts` | Op kinds with transition profiles. |
| `TYPING_BURST_MS` | number | `1000` | `runtime.ts` | `user({ kind: "type" })` on the same target within this merges into one event. |
| `PROFILE_KEY` | string | `"genclass.profiles.v1"` | `runtime.ts` | localStorage key for `learn.persist`. |
| profile save delay | number | `5000` ms | `runtime.ts` -> `saveProfilesSoon` | Delay of the single pending profile write (the first request schedules it; later ones are ignored until it runs). |
| rate-warning throttle | number | `60000` ms | `runtime.ts` -> `onDecision` | Rate-limit status report at most once a minute. |
| budget scale | number | start `1`, `× 0.8` per `max_tokens_exceeded`, floor `0.5` | `runtime.ts` constructor | Shrinks the automatic situation budget. |
| `situationBudget()` "auto" | number | WebGPU or unknown device: `STATE_CHAR_BUDGET` = 3200; WASM: `1000 + round((threads - 1) × 1000 / 3)` with threads clamped to 1..4 (1000, 1333, 1667, 2000); then `× budgetScale`, rounded | `runtime.ts` -> `situationBudget` | Size of situation text (`budget`). A numeric `situation.budget` is returned unchanged. |
| `STATE_CHAR_BUDGET`, `COMPACT_BUDGET` | number | `3200`, `1100` | `situation/serialize.ts` | Full and compact section limits. Compact questions at budget `<= 1400` (`COMPACT_QUESTIONS_BUDGET`, `situation/questions.ts`). |
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
| `isSensitiveName(name)` | True if any word is in `SECRET_WORDS` (password, passwd, passcode, passphrase, pass, pwd, secret, token, cvv, cvc, csc, ssn, iban, otp, totp, pin, cookie, authorization, auth, apikey, creditcard, cardnumber) or a pair in `SECRET_PAIRS` (card number/num/no/cvc/cvv/code/security, credit card, cc number/num/no/exp/csc, api key/secret, private key, access key, secret key, session id/token/key, security code, one time, social security). `"author"`, `"cards"`, `"passengers"`, a kanban `"card"` are not secrets. |
| `defaultRedact(path, value)` | `"[redacted]"` if any dot-separated segment `isSensitiveName`, else `value`. |
| `describe(v, path, redact, max = 80)` | One-line value summary used in situations (strings 48 chars top-level, 24 nested; arrays show at most 3 items, e.g. `"5 items [a, b, c, …]"` (the `, …` only when items were left out); objects list id-like keys first: `id`, `_id`, `key`, `uuid`, `slug`, `name`, `title`, `label`). |
| `isIdSegment(seg)` | Digits, UUID, long hex (>= 8 with a digit), long token (>= 16 with letters and digits), conservative slug ids (`tasks-1cam`, `x7k2p`, `PPBqWA9`; not `sha256`, `oauth2`, `v1beta1`). |
| `normalizePath(p)` | Id segments (after `decodeURIComponent`) -> `:id`. |
| `normalizeFieldPath(p)` | Store path segments after the first that are ids or contain a digit -> `:id` (transition profiles). |
| `parseUrl(raw, base)` | `{ href, where, search, sameOrigin }`; `where` is the pathname (same origin) or `host + pathname`; base defaults to `http://localhost/`. |
| `requestSignature(method, where)` | `"GET /api/items/:id"` (the **op signature**). |
| `redactSearch(search, redact, max = 60)` | Query string (input capped at 4096 chars) with values whose `query.<key>` path is redacted replaced by `[redacted]`, truncated. |
| `type Redactor` | `(path: string, value: unknown) => unknown`: the shape of `InitOptions.redact` and `defaultRedact`. |
| `interface ParsedUrl` | `{ href; where; search; sameOrigin }`, returned by `parseUrl`. |
| `REDACTED`, `IDEMPOTENT_METHODS` | Exported constants (values in the table above). `STRINGIFY_CAP`, `SECRET_WORDS`, `SECRET_PAIRS`, `ID_KEYS` and the id regexes are module-private. |

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
- **Every timer the runtime arms must be cleared in `destroy()` or be harmless when it fires afterwards.** `destroy()` clears `settleTimer`, `persistTimer` and the reporter's de-dup windows. Hold-budget, stall and queue-dispatch timers are left to fire: `passive()` is idempotent, `watchStall` checks `destroyed`, and `trigger()`'s answer handler runs passive when `destroyed`.
- **Captured natives.** `browserClock` captures timers and `index.ts` captures `fetch` at module evaluation. If another library patched `fetch` earlier, the model host downloads through that patch. Keep these captures at module top level; moving them into functions would make the runtime observe itself (its own timers through the timers observer, its model download through the fetch observer).
- **Parity and the `situation-v1` freeze.** `util.ts` formatting (`secs`, `rel`, `fmtNum`, `ratio`, `plural`, `ordinal`, `truncate`, `describe`, `normalizePath`, `isIdSegment`, `isSensitiveName`, `defaultRedact`) and the default `vocabulary` feed the text the model reads. The tag `situation-v1` froze it; `git diff situation-v1 HEAD -- packages/runtime/src` is empty at 654d822. Changing any of these requires SIM/TRAIN coordination and regenerated data ([model-io-contract.md](../model-io-contract.md)).
- **The model seam is shared.** The first section of `types.ts` is co-owned by MODEL, and `sim/src/types.ts` mirrors it structurally. Change all three together.
- **Fail-open everywhere.** Not consultable, provider error, deadline missed, queue overflow, destroyed: the passive action runs. Never introduce a path where a missing answer blocks the app.
- **Option resolution is one-shot.** `policy`, `triage`, `vocabulary`, `settleMs`, `redact`, `report` (except via `setReport`) and `observe` are read in the constructor; only `mode` (via `setMode`) and pause state change afterwards.

## How to change it safely

**Add an init option**
1. Add the field with a JSDoc default to `InitOptions` (or `CreateOptions` if headless-only) in `packages/runtime/src/types.ts`.
2. Read it once in `RuntimeImpl`'s constructor with an explicit default (`o.x ?? default`). Never read options lazily from `o` later.
3. Check the four creation paths in `index.ts` (`initUnsafe` browser, non-browser, kill-switch `off`, fallback) and decide whether the option should survive each.
4. If it changes situation text or decisions, coordinate with SIM (`sim/src/run/rt.ts` -> `createOptions`) and record it in `docs/runtime/API.md`.
5. Add a test using `setup({ ...option })` from `test/helpers.ts`; run `vitest run --exclude "test/browser/**"` in `packages/runtime`, locally or on the VM (`scripts/vm.sh run <slot> '...'`); see [build-test-release.md](build-test-release.md#where-to-run-things) for where to run what.

**Add a `Runtime` method**
1. Add it to `Runtime` in `types.ts` and implement it in `RuntimeImpl`.
2. Update every other implementer of `Runtime`: `packages/runtime/test/browser/ui/mock-runtime.ts` (`MockRuntime implements Runtime`) and `demos/src/dev/runtime-shim/index.ts` (`ShimRuntime implements Runtime`). Add it to the sim's `RuntimeLike` (`sim/src/run/rt.ts`) only if the sim calls it.
3. Devtools wraps runtime calls in `safe()`; keep new methods non-throwing if devtools will use them.

**Change an existing `Runtime` method or option (signature or semantics)**
1. Find every caller outside `src/`: the sim's structural `RuntimeLike` (`sim/src/run/rt.ts`) calls `atom`, `user`, `reportError`, `situation`, `on`, `destroy` and optionally `decisions`, `inflight`; its `createOptions` passes `clock`, `global`, `decider`, `model: false`, `mode: "heal"`, `report: "silent"`, an explicit `observe` map, `triage: "salient"`, `policy` (`thresholds { report: 0, guard: 0.5, heal: 0.5 }`, `holdBudgetMs: 1e9`, `maxActionsPerMinute: 1e9`, `requireDiagnosis: false`), `historySize: 500`, `app`, and optionally `vocabulary`, `hooks`, `situation.budget`. The sim loads the runtime by the module name in env var `GENCLASS_RUNTIME` (default `@genclass/runtime`), so it compiles without the runtime's types: a breaking change shows up only at sim run time.
2. Also update `MockRuntime` (`test/browser/ui/mock-runtime.ts`), `ShimRuntime` (`demos/src/dev/runtime-shim/index.ts`), devtools (`src/devtools/index.ts`) and the React adapter (`src/adapters/react.ts` -> `useRuntimeList`, which calls `decisions(limit)` / `interventions(limit)`).
3. Update `docs/runtime/API.md`, the JSDoc in `types.ts` and this doc. If the change alters situation text or decisions, it breaks the `situation-v1` freeze (see Invariants).

**Add an event type**
1. Add the key and payload to `RuntimeEvents` in `types.ts`.
2. Add a `Set` for it in the `listeners` initializer of `RuntimeImpl` (otherwise `on(newType)` throws on `undefined.add`).
3. Fire it with `this.fire(type, value)`. Update `devtools/index.ts` -> `subscribe` and the React adapter's `useRuntimeList` callers if they should react.

**Add an observer**
1. Extend `ObserverName` in `types.ts`; TypeScript then forces the new key into `ALL_OFF` in `index.ts`.
2. Install it in `RuntimeImpl.installObservers` through `tryAdd(name, () => installX(...))`; the installer returns an uninstall function (restore the global if it is still your wrapper, else become a pass-through) or `null` when unsupported.
3. Decide the default (`on(k)` defaults to `true`; pass a second argument like `timers` does to make it conditional).
4. Add a "destroy restores the global" assertion next to `dom.test.ts` -> "browser globals are restored by destroy()". See [observe-and-trace.md](observe-and-trace.md).

**Change a default (mode, thresholds, settleMs, historySize, budgets)**
1. Change it where it is defined (table above), then update the JSDoc in `types.ts`, `docs/runtime/API.md`, `packages/runtime/README.md`.
2. Tests pinning values: `budget.test.ts` (budgets, hold budget), `policy.test.ts`, `report.test.ts` (report line regexes include thresholds), `batch3.test.ts`.
3. Thresholds and budgets affect training/eval comparability: tell TRAIN/SIM.

**Change the kill switch or init paths**
Edit `index.ts` -> `killSwitch` / `initUnsafe`; keep everything in try/catch; update `report.test.ts` -> "GenClass.init and the kill switch" and `batch3.test.ts` -> "lifecycle".

**Change `destroy()`**
Keep it idempotent; clear every new timer; keep reverse uninstall order; dispose only owned deciders. Tests: `fetch.test.ts`, `xhr.test.ts`, `dom.test.ts` (restoration), `review-fetch.test.ts` (no work after destroy), `review-misc.test.ts` / `batch3.test.ts` (`ask` after destroy).

**Add a subpath export**
Add the entry to `package.json` `exports`, `tsup.config.ts` `entry` and `dts.entry`, and externalise any new peer library. See [build-test-release.md](build-test-release.md).

**Add time-dependent behaviour**
Use `this.clock.now()` / `this.clock.setTimeout` / `this.clock.afterTask`; store the handle and clear it in `destroy()`; test it with `FakeClock.advance`.

## Tests

All in `packages/runtime/test/` (vitest, `environment: "node"`, `testTimeout: 20000`, `test/browser/**` excluded; `dom.test.ts` uses `// @vitest-environment happy-dom`). Most use `setup()` from `helpers.ts`: `createRuntime` with `FakeClock`, `FakeServer`, `ScriptedDecider`, `report: "silent"` and only the fetch observer on.

| test file | what it asserts (scope of this doc) |
|---|---|
| `report.test.ts` | `GenClass.init` idempotent, `GenClass.runtime`, `destroy` clears it; `?genclass=off` leaves `fetch` untouched, mode `observe`, exactly one `console.info`; `?genclass=heal` overrides `mode: "guard"`; `on("decide" \| "detect" \| "act" \| "event")` order and unsubscribe; report lines and console grouping/de-dup. |
| `batch3.test.ts` | Lifecycle: `ask` after destroy rejects `"destroyed"`; `createRuntime` survives read-only `fetch`; `GenClass.init` with a throwing plugin `setup` does not throw; a provider that never answers does not block later decisions; rate-limit warning once per minute. |
| `review-misc.test.ts` | Init robustness on frozen globals; `ask` after destroy (`reason: "destroyed"`); console reports reach the console as `×N` summaries; queue robustness. |
| `ask.test.ts` | `ask` sends trigger `ask` with question id `answer`; typed answers (`expectTypeOf`); `decide` returns the label; `about` op id / store; no decider -> `GenClassUnavailableError`, `status.state === "off"`, `ready` resolves; `timeoutMs` -> reason `"timeout"`. |
| `policy.test.ts` | `setMode` switches tiers at runtime; `pause()` stops consulting, `resume()` restores; loading status fails open with no record; observe mode never holds; detection threshold. |
| `plugins.test.ts` | Plugin facts/diagnoses/actions reach the model; custom action runs; `ctx.builtin`; default heal tier; `applicable`; standing questions; `setup` receives `PluginApi` (`recordOp`, `runInOp`, `emit`, `on`, `endOp`) and cleanup runs on unregister; vocabulary overrides. |
| `budget.test.ts` | `situationBudget()` "auto" values (3200 / 1000 / 1333 / 2000, threads capped at 4, unknown device 3200, fixed number wins); `max_tokens_exceeded` -> 2560; hold budget `"auto"` (300 fallback, 150..800 clamp, adapts to measured latency); determinism at a fixed budget. |
| `situation.test.ts` | `situation()` (ask about now) is side-effect free (no ops, no events); determinism of whole runs on a fake clock. |
| `smoke.test.ts` | Minimal `createRuntime` wiring: atoms apply synchronously when nothing is salient; causality through awaits; a stale write is held and discarded in guard mode. |
| `dom.test.ts` | `destroy()` restores `fetch`, XHR `open`, `history.pushState`, `Storage.prototype.setItem`, `WebSocket`, `setTimeout`, and removes DOM listeners; `describeElement`. |
| `fetch.test.ts`, `xhr.test.ts`, `review-fetch.test.ts` | `destroy()` restores fetch/XHR; after destroy GenClass does no work even when another library wrapped fetch on top. |
| `review-timers.test.ts` | Uses `rt.internals` to check op pruning (timer loops do not retain ops). |
| `test/smoke/smoke.sh` | (VM only) packs the tarball, builds a fresh Vite app with `GenClass.init({ model: false, report: "console" })` and `mountDevtools`, loads it in headless Chromium. |

Which `initUnsafe` branch the unit tests hit: vitest runs in `environment: "node"` (no `window`), so every `GenClass.init` call in `report.test.ts` and `batch3.test.ts` goes through the **non-browser** branch (or the kill-switch `off` branch); the mode override test passes through `...(mode ? { mode } : {})` there. The **browser** branch (`o.model = options.model ?? {}`) is exercised only by `test/smoke/smoke.sh` on the VM, and only with `model: false`.

Untested in this scope: the `localStorage.genclass` path of the kill switch, the browser branch of `initUnsafe` with a default model, the outer `catch` fallback of `GenClass.init` (the throwing-plugin test is caught inside `use`, not by the fallback), `learn.persist`, `settleMs`, `historySize`, `setReport`, `isPaused`, `createRuntime({ model: {...} })` fetch selection and `failedProvider`, and the `ask` + `timeoutMs` + load-failure path.

## Drift and open issues

| what | docs say | code does | evidence |
|---|---|---|---|
| Auto situation budget on WASM | `types.ts` JSDoc of `InitOptions.situation`: "wasm 1,100 + 300 per extra thread up to 4 threads: 2,000" (1100/1400/1700/2000) | `1000 + round((threads - 1) × 1000 / 3)`: 1000/1333/1667/2000 | `runtime.ts` -> `situationBudget`; `budget.test.ts` asserts 1000, 1333 and 2000. API.md, ARCHITECTURE.md and STATUS.md match the code. |
| Default redaction | `types.ts` JSDoc of `InitOptions.redact`, `docs/runtime/CONTRACT.md` §2 and `packages/runtime/README.md` ("fields matching `pass\|token\|secret\|card\|cvv\|ssn\|auth`"): substring regex | Word-level meaning (`isSensitiveName`); `"card"`, `"author"`, `"cards"` are not redacted | `util.ts` -> `defaultRedact`; STATUS.md lists it as an approved deviation; API.md matches the code. |
| Non-browser `GenClass.init` | API.md: "returns an inert runtime: no observers, no model" | Observers off and no model host, but `options.decider`, `plugins`, `policy`, `mode` are kept; `report` defaults to `"silent"` | `index.ts` -> `initUnsafe` |
| `GenClass.destroy()` | API.md: "uninstall observers, restore globals, terminate the model worker" | Terminates only a host the runtime created (`ownsDecider`); a global is restored only if it is still GenClass's wrapper, otherwise the wrapper becomes a pass-through | `runtime.ts` -> `destroy`; `observe/fetch.ts` uninstall |
| `rt.ready` | API.md/types.ts: "resolves when the model is ready" | Also rejects (provider error, e.g. `ModelLoadError`) on load failure, and the rejected promise is memoised | `runtime.ts` -> `get ready` |
| `ask` error type | API.md: rejects with `GenClassUnavailableError` when no model can answer | With `timeoutMs` and a failed load, the raw provider error propagates (the race uses the unwrapped `ready` promise); `timeoutMs` is applied to the load wait and the answer wait separately | `runtime.ts` -> `ask` |
| `on("status")` | API.md: "model loading progress and state" | Also fired by every `setMode` call | `runtime.ts` -> `setMode`; devtools relies on it |
| `pause()` | API.md: "stops consulting the model" | Triggers stop, but `ask()`/`decide()` still query the model while paused | `runtime.ts` -> `ask` has no `paused` check |
| `ModelOptions` | API.md options block lists `baseUrl`, `device`, `worker`, `preload` | Also `ortWasmPaths` and `cacheName` | `types.ts` -> `ModelOptions` |
| Default observers | `types.ts`: "Default: all true (where the global supports them)"; CONTRACT §2 `observe` list omits `timers` | `timers` defaults on only when `global.document` is a non-null object; all others default on | `runtime.ts` -> `installObservers` |
| Hold budget fallback | API.md / `types.ts` describe only `clamp(1.5 × median, 150, 800)` | 300 ms when no latency sample and no `warmupMs` | `decide/policy.ts` -> `holdBudget`, `HOLD_FALLBACK_MS` |
| `situation(trigger)` | CONTRACT §13: side-effect free | Returns the last situation built for that trigger when there is one; building caches `op.reads` | `runtime.ts` -> `situation`, `build`; acknowledged in STATUS.md "Deviations" |
| Runtime surface | CONTRACT §2 `Runtime` | Also `mode`, `adapter`, `inflight`, `holdBudgetMs`, `situationBudget`, `on("report")` | STATUS.md "Extra public surface" acknowledges all of these except `mode`, which neither CONTRACT §2 nor STATUS.md lists |
| STATUS.md open issue | "`react-dom` is not a devDependency of `@genclass/runtime`" | `package.json` devDependencies include `react-dom ^19.3.0` and `@types/react-dom ^19.0.0` (stale item) | `packages/runtime/package.json` |
| `Decision.action` | `types.ts` JSDoc: "The action the model chose (highest probability)" | `action = run ?? top`: the action that ran (the gate's most probable **permitted** candidate, which can differ from the model's top choice) or, when nothing ran, the model's top choice. API.md ("the action that ran, else the model's choice") matches the code. | `runtime.ts` -> `onDecision` |
| `EvaluateRequest.priority` | `types.ts` JSDoc: "held writes/requests use 2, background 0" | Background triggers use 1 (`stall`, `inconsistency`, XHR `failure`, `ask`) or 0 (`transition`, `error`); a holdable trigger that does not wait is capped at 1 | `runtime.ts` -> `trigger`; see [Events](#events-runtimeevents) |
| `RuntimeImpl.setReport` | JSDoc: "Report sink for a custom destination at runtime (devtools)" | No caller anywhere in the repo (devtools does not use it) | `git grep setReport` |
| API.md shapes | `Situation` listed as `{ trigger, subject, state, questions, actions, salient, facts }`; `Op` without `meta` | `Situation` also has `compact` and `budget`; `Op` also has `meta` | `types.ts` -> `Situation`, `Op` |
| README observers | "Fetch, XHR, WebSocket, DOM events, errors, navigation and storage are observed automatically" | Also `perf` (long tasks) and `timers` (timers only when `global.document` exists) | `runtime.ts` -> `installObservers` |
| Report console hint | "Deny this action: `GenClass.init({ policy: { deny: [...] } })`" | A no-op once `GenClass.init` has run (idempotent init ignores the new options) | `decide/report.ts` -> `Reporter.emit`; `index.ts` -> `GenClass.init` |
| Default model URL | README: the runtime model is not published yet; alpha observes only | `DEFAULT_MODEL_BASE_URL` points at `@genclass/runtime-model@0.1.0` on jsDelivr, so a default `init()` ends in status `error` until it is published (unverified whether the URL is live). The CLI's default source is a different URL (GitHub release `runtime-model-v0.1.0`). | `model/host.ts`; `bin/genclass-runtime.mjs` -> `DEFAULT_FROM`; OPEN_TASKS.md item 8 |
| Dead code | | `on()` contains an empty `if (type === "report") {}` block | `runtime.ts` -> `on` |
| `explainMap` bound | (no doc) the `DECISIONS_KEPT * 2` check in `onDecision` suggests a 400-entry cap | Only `onDecision` evicts (one entry, when size > 400); `finish` adds `a<n>` entries without eviction, so the map grows by one per executed action for the life of the runtime (bounded in rate by `maxActionsPerMinute`, not in size) | `runtime.ts` -> `onDecision`, `finish` |
| Init with malformed `plugins` | `GenClass.init` "never throws" | It does not throw, but a non-iterable `plugins` / `plugin.actions` / `plugin.questions` throws inside `RuntimeImpl`'s constructor after the observers were installed; the fallback inert runtime is returned while the first instance's wrappers stay on the globals | `runtime.ts` -> constructor, `use`; `index.ts` -> `GenClass.init` |
| `decisions(0)` / `interventions(0)` | | Return the whole buffer (`slice(-0)`), while `history(0)` returns `[]` | `runtime.ts` |

Open items from OPEN_TASKS.md relevant here: publish `@genclass/runtime-model@0.1.0` (the default `baseUrl`) and then `@genclass/runtime@0.1.0` without the alpha tag; add a CI workflow (build, typecheck, unit tests); write honest results into the READMEs. Until the model ships, `GenClass.init()` observes and records but never acts.

## Related docs

- [observe-and-trace.md](observe-and-trace.md): observers, ops, causality, `op`/`user`/`emit` internals
- [state-and-adapters.md](state-and-adapters.md): stores, mutation pipeline, invariants, snapshots, adapters
- [learn-situation-triage.md](learn-situation-triage.md): baselines, profiles, facts, triggers, triage, serialisation, budgets
- [decide-policy-actions.md](decide-policy-actions.md): decision queue, policy gate, actions, reports, explain, undo
- [model-host.md](model-host.md): `createModelHost`, worker, loader, backends, CLI
- [devtools.md](devtools.md): devtools overlay (consumer of this API)
- [build-test-release.md](build-test-release.md): build, tests, VM workflow, publishing
- [../overview.md](../overview.md#3-runtime-data-flow-end-to-end): end-to-end data flow and the stale-write walkthrough
- [../model-io-contract.md](../model-io-contract.md): situation text -> model -> answers; `situation-v1`
- [../sim.md](../sim.md): how the sim drives `createRuntime` deterministically
- [../status-and-known-issues.md](../status-and-known-issues.md), [../glossary.md](../glossary.md), [../playbooks.md](../playbooks.md), [../README.md](../README.md)
- Original sources: [docs/runtime/API.md](../../runtime/API.md), [docs/runtime/CONTRACT.md](../../runtime/CONTRACT.md), [docs/runtime/ARCHITECTURE.md](../../runtime/ARCHITECTURE.md), [packages/runtime/README.md](../../../packages/runtime/README.md), [packages/runtime/STATUS.md](../../../packages/runtime/STATUS.md), [OPEN_TASKS.md](../../../OPEN_TASKS.md)
