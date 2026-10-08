# Agent docs: index and router

> **Scope:** every doc in `docs/agents/`, the root entry points `AGENTS.md` and `CLAUDE.md`, and how these docs relate to the human docs in `docs/runtime/`.
> **Read this when:** you need the right doc for a task, want to know what a doc covers, or must update the docs after changing code.
> **Source of truth:** the code. Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins.

## Purpose and reading order

These docs are for AI coding agents that arrive in this repo with no context. Each subsystem doc describes one area as the code stands at a stated commit, with `file -> symbol` pointers so you can go straight to the source. They are not product documentation. For that, see `README.md`, `packages/runtime/README.md` and `docs/runtime/*.md` (several of which are stale; see the Drift sections).

Read them in this order:

1. [`../../AGENTS.md`](../../AGENTS.md): ground rules, what you may run locally, and what needs the user's OK first.
2. [overview.md](overview.md): what the product is and how runtime, sim, realapps, training, model and demos fit together.
3. The subsystem doc for your task (see the [routing table](#routing-table)). Read its TL;DR first, then "Invariants and gotchas" and "How to change it safely" before you edit anything.
4. [playbooks.md](playbooks.md): procedures for tasks that span several subsystems.

Keep three docs open for reference: [repo-map.md](repo-map.md) (where things live), [glossary.md](glossary.md) (terms) and [status-and-known-issues.md](status-and-known-issues.md) (what is shipped, frozen, open and stale).

For live state and results, also use the human sources [HANDOFF.md](../../HANDOFF.md) (the colleague's current state and next steps), [docs/runtime/RESULTS.md](../runtime/RESULTS.md) (measured results and training log) and [RELEASE.md](../../RELEASE.md) (release procedure).

Five facts change how you should read every other doc:

- **The situation format is frozen at tag `situation-v2`** (6e5e86e, runtime batch 5). `git diff situation-v2 b435acb -- packages/runtime/src` touches only `runtime.ts` (the default mode), `types.ts` (its JSDoc) and `devtools/index.ts` (mode labels); no model-visible code changed. The old tag `situation-v1` (1a77558) is the format of all data and models trained so far, so **no trained model matches the current runtime**. Any change to text the model reads needs the user's go-ahead (coordinate with the colleague who runs SIM/REAL/TRAIN), a new tag, regenerated SIM and realapps data, a `training/curriculum/rt.py` mirror and retraining. See [model-io-contract.md](model-io-contract.md).
- **Decisions happen at the network boundary.** situation-v2 adds the `delivery` trigger (a fetch/XHR response or a WebSocket/EventSource message about to reach the app; actions `deliver` / `discard` / `defer`) and no longer holds store writes by default (`policy.holdWrites: false`). Older docs and the human docs often still describe held store writes. See [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md).
- **The default mode is `observe`** on `mvp-v2` (our commit f3636b2: `packages/runtime/src/runtime.ts` -> `RuntimeImpl` constructor, `o.mode ?? "observe"`). `guard` is opt-in and `heal` experimental. The published `@genclass/runtime@0.1.0-alpha.1` (`latest`) also defaults to `observe`; the older `0.1.0-alpha.0` (situation-v1 code) defaults to `guard`, and so does `HANDOFF.md` (both READMEs now say `observe`). The unit-test harness (`packages/runtime/test/helpers.ts` -> `setup`) passes `mode: "guard"`. See [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md).
- **No model is published, so every install only observes.** `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` points at `@genclass/runtime-model@0.1.0`, which is a 404 on npm, as is the CLI's `DEFAULT_FROM`. A default `GenClass.init()` ends in model status `error` and never decides. The situation-v2 model comes from the scaled program in [training.md](training.md) (teacher -> distillation -> DAgger -> EVAL -> export). See [runtime/model-host.md](runtime/model-host.md).
- **Run policy for agents** (set by the lead for this machine; `HANDOFF.md`'s "never run npm/tsc/vitest on the Mac" rule is about the colleague's 8 GB Mac):
  - You may run `npm install` / `npm ci`, typecheck, the tsup build and the vitest unit tests locally. All of them were run when these docs were written, on 2026-10-08 (350 tests: 336 passed, 14 model-parity skips).
  - Ask the user before you run Playwright (including `test/smoke/smoke.sh`), the sim generator, training, anything in `realapps/` that launches Chromium or touches a VM, the demos' eval, model downloads, anything on Azure, `git push` or `npm publish`. The colleague is operating the Azure cluster right now (SIM on c02–c09 and c12–c23, REAL on c01, c10, c11); nobody on our side touches it.

## Routing table

Each row names the doc to read, and then any further docs to check. "Ask first" means you must get the user's OK before you run anything for that task.

### Orientation and process

| If your task is ... | Read | Then |
|---|---|---|
| Learn what is shipped, frozen or in flight, and who owns what | [status-and-known-issues.md](status-and-known-issues.md) | [overview.md](overview.md) ("Where the project stands") |
| Find where a file, package or script lives | [repo-map.md](repo-map.md) | the "Files" table of the subsystem doc |
| Look up a term (situation, trigger, delivery, discard mark, tier, settled point, hold budget, FIR, S1/S2, R17/R32, T150) | [glossary.md](glossary.md) | the doc's "Concepts and data structures" |
| Decide whether a change forces new data and retraining | [model-io-contract.md](model-io-contract.md) ("Versioning: what invalidates the trained model") | [status-and-known-issues.md](status-and-known-issues.md) |
| Record status after a change (STATUS.md, NEEDS files, OPEN_TASKS.md, HANDOFF.md) or file a cross-workstream request | [status-and-known-issues.md](status-and-known-issues.md) ("How to change it safely") | — |
| Handle a human doc (API.md, CONTRACT.md, a README, STATUS.md, OPEN_TASKS.md) that disagrees with the code | [status-and-known-issues.md](status-and-known-issues.md) ("Drift and open issues") | the subsystem doc's "Drift and open issues" |

### Runtime: public API, observers, state

| If your task is ... | Read | Then |
|---|---|---|
| Add or change an init/`createRuntime` option or a default (mode, `holdWrites`, thresholds, `settleMs`, `historySize`) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) | [sim.md](sim.md) (`sim/src/run/rt.ts` -> `createOptions`) and [realapps.md](realapps.md) (`realapps/src/world/index.ts`) if it reaches situations or decisions |
| Understand or change the default mode (`observe` since f3636b2) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) | [runtime/devtools.md](runtime/devtools.md) (mode labels), [runtime/build-test-release.md](runtime/build-test-release.md) (`setup()` passes `guard`) |
| Add a `Runtime` method or event | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) | [runtime/devtools.md](runtime/devtools.md) (`MockRuntime`), [demos.md](demos.md) (runtime shim) |
| Change `GenClass.init`, the kill switch or `destroy()` | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) (how globals are restored) |
| Write a plugin, custom action or standing question | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) (plugin API) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md), [model-io-contract.md](model-io-contract.md) (no retrain; quality unmeasured) |
| Add code that depends on time (timers, timestamps, ids) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) (`Clock` rules) | [runtime/build-test-release.md](runtime/build-test-release.md) (`FakeClock` tests) |
| Add an observer, or change the WebSocket/EventSource observers or the message gate (`observe/messages.ts` -> `MessageGate`) | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) if you add an `OpKind` |
| Debug how fetch/XHR requests are held, coalesced, retried, hedged or served from cache | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) |
| Change where fetch/XHR/WS/SSE hand a response or message to the delivery gate, or how the body clone is read | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) ("The delivery gate") |
| Change op signatures, request identity or volatile headers | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) | [model-io-contract.md](model-io-contract.md) (op names reach the model) |
| Carry the ambient op across a new async boundary | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) (`LazyOp` timer pattern) | — |
| Change DOM user-action recording, `observe.untrustedEvents` or `data-genclass-ignore` | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) | [runtime/devtools.md](runtime/devtools.md), [demos.md](demos.md) (the in-page driver uses synthetic events) |
| Integrate another state library through `runtime.adapter` | [runtime/state-and-adapters.md](runtime/state-and-adapters.md) | [runtime/build-test-release.md](runtime/build-test-release.md) (subpath export) |
| Change the React hooks, Redux enhancer or Zustand middleware | [runtime/state-and-adapters.md](runtime/state-and-adapters.md) | [demos.md](demos.md) (a demo exercises each adapter) |
| Debug why a write was applied, dropped by a discard mark, late-reverted or (with `holdWrites`) held | [runtime/state-and-adapters.md](runtime/state-and-adapters.md) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) (late revert, delivery `discard`) |
| Add or tune an invariant template; debug a missing or spurious `inconsistency` trigger | [runtime/state-and-adapters.md](runtime/state-and-adapters.md) | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) |
| Check the old "held write lands after a newer user write" bug (`demos/NEEDS.md` §1) | [runtime/state-and-adapters.md](runtime/state-and-adapters.md) (addressed in code, unmeasured on the demos) | [demos.md](demos.md) |

### Runtime: situation, decisions, model host, devtools

| If your task is ... | Read | Then |
|---|---|---|
| Find out why a trigger did or did not reach the model (triage, delivery pre-filter) | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) |
| Debug why a response or message was held, delivered at once, discarded or deferred | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) ("Delivery gate") | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) (salience), [runtime/state-and-adapters.md](runtime/state-and-adapters.md) (drop filter) |
| Change the delivery gate (predicted writes, conflicts, body read, discard marks, `defer`) | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md), [model-io-contract.md](model-io-contract.md) (salience decides which rows exist) |
| Change fact wording (incl. F1–F9, read-your-writes) or timeline/state/stats lines, or add a fact | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) | [model-io-contract.md](model-io-contract.md), [sim.md](sim.md), [realapps.md](realapps.md), [training.md](training.md) |
| Change the situation budget or section limits | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) | [model-io-contract.md](model-io-contract.md), [training.md](training.md) (`rt.py` must match) |
| Change redaction (`isSensitiveName`, `isSensitivePath`), latency/error baselines, cadence or transition profiles | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) (`util.ts` helpers) |
| Add a trigger kind | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) (`Controller`), [model-io-contract.md](model-io-contract.md), [sim.md](sim.md), [realapps.md](realapps.md) |
| Change the policy gate, thresholds, hold budget, `expectedLatency` or rate limit | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) | [training.md](training.md) (`eval_runtime.py` mirrors the gate) |
| Change a built-in action's mechanics or its `changed` sentence | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) (request/failure/stall controllers) |
| Add a built-in action or a diagnosis label | [model-io-contract.md](model-io-contract.md) ("Recipes") | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md), [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md), [sim.md](sim.md), [realapps.md](realapps.md), [training.md](training.md) |
| Change console report wording, `explain()` or undo | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) | [runtime/devtools.md](runtime/devtools.md) (the overlay mirrors report templates) |
| Change the decider queue (priorities, deadlines, stale drop, timeout, answer cache) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) | [runtime/model-host.md](runtime/model-host.md) |
| Debug "Model unavailable (...); observing only.", a stuck load or slow decisions | [runtime/model-host.md](runtime/model-host.md) | [status-and-known-issues.md](status-and-known-issues.md) |
| Point at a model, bump the model version, or self-host model files (`genclass-runtime fetch-model`) | [runtime/model-host.md](runtime/model-host.md) | [runtime/build-test-release.md](runtime/build-test-release.md) (publishing the model package) |
| Change WebGPU/WASM plan order, the worker protocol, a model error class or the onnxruntime-web version | [runtime/model-host.md](runtime/model-host.md) | [runtime/build-test-release.md](runtime/build-test-release.md) (externals, browser specs) |
| Change the TS serializer, tokenizer, packer or calibration | [model-io-contract.md](model-io-contract.md) | [runtime/model-host.md](runtime/model-host.md), [genclass-model-lineage.md](genclass-model-lineage.md) (Python side), [runtime/build-test-release.md](runtime/build-test-release.md) (fixtures) |
| Mount the devtools overlay, or change a view, option, card, theme or keyboard handling | [runtime/devtools.md](runtime/devtools.md) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) (events it subscribes to) |
| Update the overlay's Playwright spec or its screenshots (ask first) | [runtime/devtools.md](runtime/devtools.md) | [runtime/build-test-release.md](runtime/build-test-release.md) |
| Investigate a false intervention or unexpected behaviour reported by a user | [playbooks.md](playbooks.md) (recipe "Investigate a false intervention reported by a user") | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) |

### Build, test, CI and release

| If your task is ... | Read | Then |
|---|---|---|
| Build, typecheck or run the unit tests (`npm ci` works from the committed lockfile) | [runtime/build-test-release.md](runtime/build-test-release.md) | [`../../AGENTS.md`](../../AGENTS.md) (what may run locally) |
| Write a unit test in house style (`setup()` defaults to `guard`, `FakeClock`, `ManualDecider`, `holdWrites: true` for held writes) | [runtime/build-test-release.md](runtime/build-test-release.md) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) (`defaultScript`) |
| Change the CI workflow (`.github/workflows/ci.yml`: Node 22, `npm ci`, typecheck, build, unit tests, `review-perf` alone with retries) | [runtime/build-test-release.md](runtime/build-test-release.md) ("CI") | — |
| Add a public entry point (subpath export) | [runtime/build-test-release.md](runtime/build-test-release.md) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) |
| Run the Playwright specs or the npm-pack smoke test (ask first) | [runtime/build-test-release.md](runtime/build-test-release.md) | — |
| Cut a release of `@genclass/runtime` (the user publishes with 2FA, and npm 11 needs `--tag` for a prerelease) | [../../RELEASE.md](../../RELEASE.md); [runtime/build-test-release.md](runtime/build-test-release.md) ("Cut a release") | [status-and-known-issues.md](status-and-known-issues.md), [playbooks.md](playbooks.md) ("Publish @genclass/runtime") |
| Publish `@genclass/runtime-model@0.1.0`, then `@genclass/runtime@0.1.0` (only after a situation-v2 model passes EVAL) | [../../RELEASE.md](../../RELEASE.md) (Part B); [runtime/build-test-release.md](runtime/build-test-release.md) ("Publish the model package") | [training.md](training.md) (export), [runtime/model-host.md](runtime/model-host.md) (card format), [playbooks.md](playbooks.md) |

### Sim, realapps, the v2 training program and demos

| If your task is ... | Read | Then |
|---|---|---|
| Generate or regenerate SIM data: gold, `--unlabeled` or `--on-policy` rows (ask first) | [sim.md](sim.md) | [model-io-contract.md](model-io-contract.md) |
| Add a feature combinator, domain, chaos behaviour or ask-question generator | [sim.md](sim.md) | — |
| Change cost weights, label parameters, S1 relabelling or S2 latent re-draws | [sim.md](sim.md) | [realapps.md](realapps.md) (imports the sim's weights and label rule), [model-io-contract.md](model-io-contract.md) |
| Debug a dropped trajectory, a `prefix-mismatch` or an odd label | [sim.md](sim.md) or [realapps.md](realapps.md) | — |
| Change the runtime options the sim passes (`createOptions`) | [sim.md](sim.md) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) |
| Understand what a REAL row (`meta.source = "realapps"`) is and how it was labelled | [realapps.md](realapps.md) | [model-io-contract.md](model-io-contract.md) |
| Add an app to the real-app corpus, or change the in-page world, probe or harness | [realapps.md](realapps.md) | [sim.md](sim.md) (shared cost and label code) |
| Run the never-worse (`debug.js --interference`) or determinism sweep (Chromium; ask first) | [realapps.md](realapps.md) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) |
| Generate real-browser data or build the real-app eval set (`realapps/scripts/evalset.py`; Chromium/Azure, ask first) | [realapps.md](realapps.md) | [training.md](training.md) |
| Mirror a runtime wording change into `training/curriculum/rt.py` (frozen at `situation-v2`) | [training.md](training.md) | [model-io-contract.md](model-io-contract.md) |
| Regenerate the curriculum, change a mixture or launch a training round (Azure; ask first) | [training.md](training.md) | [genclass-model-lineage.md](genclass-model-lineage.md) (the `jev_local` trainer) |
| Run the v2 program: T150 teacher, soft-labelling (`label_teacher.py`, `label_cluster.sh`), student distillation (`launch_student.sh`), DAgger (Azure; ask first) | [training.md](training.md) ("Teacher, soft-labelling and distillation") | [sim.md](sim.md) (unlabeled and on-policy rows), [realapps.md](realapps.md) |
| Work on the T1 expected-gain side track (`t1_relabel.py`, `eval_gain.py`) | [training.md](training.md) | [sim.md](sim.md) (`meta.cost_futures`) |
| Evaluate a checkpoint, fit calibration or read EVAL.md numbers | [training.md](training.md) | [model-io-contract.md](model-io-contract.md) ("Re-calibrate only") |
| Export and validate a model directory; choose between R17 and R32 | [training.md](training.md) | [runtime/model-host.md](runtime/model-host.md) (card format), [status-and-known-issues.md](status-and-known-issues.md) |
| Change the tokenizer vocabulary | [training.md](training.md) | [genclass-model-lineage.md](genclass-model-lineage.md) |
| Build the demos from a fresh clone (`demos/src/server/data/cities.ts` is missing) | [demos.md](demos.md) | — |
| Add a demo, or change a scenario, oracle, chaos knob or mock route | [demos.md](demos.md) | — |
| Use a new runtime API from the demos (runtime shim) | [demos.md](demos.md) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) |
| Evaluate a model in the demos (`demos/scripts/vm-eval.sh`; ask first; planned after the v2 model) | [demos.md](demos.md) | [runtime/model-host.md](runtime/model-host.md) |
| Investigate a regression caused by holds (`e2e/eval.ts --trace`) | [demos.md](demos.md) | [runtime/state-and-adapters.md](runtime/state-and-adapters.md), [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) |

### Legacy GenClass, extension and benchmarks

| If your task is ... | Read | Then |
|---|---|---|
| Change `jev_local` serialization, packing, calibration or answer math | [genclass-model-lineage.md](genclass-model-lineage.md) | [model-io-contract.md](model-io-contract.md), [runtime/model-host.md](runtime/model-host.md) |
| Work on the Jev-compatible server, the macOS voice harness or the Python tests | [genclass-model-lineage.md](genclass-model-lineage.md) | — |
| Change the Chrome extension | [extension-and-benchmarks.md](extension-and-benchmarks.md) | [genclass-model-lineage.md](genclass-model-lineage.md) (harness parity) |
| Fix an engine/packer/tokenizer bug that the extension also has | [runtime/model-host.md](runtime/model-host.md) (the runtime copy is the maintained one) | [extension-and-benchmarks.md](extension-and-benchmarks.md) |
| Run, extend or quote a benchmark (jevbench, benchmax, the computer-use head-to-head); paid calls need the user's OK | [extension-and-benchmarks.md](extension-and-benchmarks.md) | — |
| Find out what a script in `scripts/` does and whether it touches Azure, money or secrets | [extension-and-benchmarks.md](extension-and-benchmarks.md) (scripts table) | [runtime/build-test-release.md](runtime/build-test-release.md) (`scripts/vm.sh`) |

## Catalogue

Line counts were taken with `wc -l docs/agents/*.md docs/agents/runtime/*.md AGENTS.md CLAUDE.md` on 2026-10-08 while the set was being refreshed for situation-v2; treat them as approximate.

| Path | Scope | Read when | Lines |
|---|---|---|---|
| [`../../AGENTS.md`](../../AGENTS.md) | Entry point: what the repo is, status, ground rules, where to run things, commands, conventions, definition of done | First, always | ~190 |
| [`../../CLAUDE.md`](../../CLAUDE.md) | Claude Code entry point: one-line repo summary that imports `AGENTS.md` (`@AGENTS.md`) | Loaded for you by Claude Code | 3 |
| [README.md](README.md) | This index: routing, catalogue, conventions, maintenance | Finding a doc; updating docs | ~200 |
| [overview.md](overview.md) | The mental model: component map, runtime data flow with the delivery gate, a v2 walkthrough, offline loops (sim + realapps -> teacher -> distillation -> DAgger -> export), modes, fail-open behaviour, where the project stands | Second, after AGENTS.md | ~500 |
| [repo-map.md](repo-map.md) | Every tracked path, plus generated and ignored paths in a working copy | Finding where a file, symbol, constant, CLI command, env var or config key lives | ~855 |
| [glossary.md](glossary.md) | Terms used across the docs | When a term is unclear | ~445 |
| [playbooks.md](playbooks.md) | End-to-end procedures across subsystems | Before a multi-subsystem change | ~775 |
| [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) | `index.ts`, `runtime.ts` wiring, `types.ts`, errors, `Clock`, `util.ts`, `package.json`; modes and the observe default | Options, `Runtime` methods, events, plugins, init/destroy, kill switch | ~690 |
| [runtime/observe-and-trace.md](runtime/observe-and-trace.md) | `observe/*` (incl. EventSource and the message gate), `trace/*`, observer install/route code in `runtime.ts` | Patching fetch/XHR/WS/SSE/timers/DOM/history/Storage; ops, identity, causality; the four network gates | ~900 |
| [runtime/state-and-adapters.md](runtime/state-and-adapters.md) | `state/*`, `adapters/*`, store code in `runtime.ts` | Writes (not held by default), drop filter, late revert, opt-in holds, snapshots, invariants, stale marks, React/Redux/Zustand | ~750 |
| [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) | `learn/*` (incl. cadence), `situation/*`, triage and the delivery gate in `runtime.ts` | Any model-visible text, delivery salience, triage, budgets, redaction, baselines | ~905 |
| [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) | `decide/*`, action controllers (incl. delivery), `explain`, undo | Queue, hold rules, policy gate, built-in actions, late revert, reports | ~830 |
| [runtime/model-host.md](runtime/model-host.md) | `model/*`, worker, CLI `bin/genclass-runtime.mjs`, `packages/runtime-model/` | Model loading, caching, WebGPU/WASM, packer, calibration, CLI | ~680 |
| [runtime/devtools.md](runtime/devtools.md) | `devtools/*`, `UI-NEEDS.md`, devtools tests and UI spec | The overlay, its views, mode labels, theming, screenshots | ~720 |
| [runtime/build-test-release.md](runtime/build-test-release.md) | Workspace config, lockfile, CI, tsup/vitest/Playwright, fixtures, smoke, `scripts/vm.sh`, publishing | Build, test, fixtures, CI, release | ~620 |
| [model-io-contract.md](model-io-contract.md) | Situation text -> packed request -> heads -> calibrated answers, across runtime, sim, realapps and training; row kinds and labels | Any change the model can see; shipping a model directory | ~660 |
| [sim.md](sim.md) | `sim/**` | Training data generation (gold, unlabeled, on-policy), S1/S2 labels, splits, budgets | ~710 |
| [realapps.md](realapps.md) | `realapps/**` | Real-app corpus in headless Chromium, REAL rows and labels, never-worse and determinism sweeps, eval set | ~405 |
| [training.md](training.md) | `training/**` and the `jev_local` parts it calls | Curriculum (`rt.py` at situation-v2), training rounds, teacher/distillation/DAgger, eval, calibration, export | ~645 |
| [demos.md](demos.md) | `demos/**` | Demo apps, mock server, chaos, Playwright eval, results (v0.1 model, situation-v1 runtime) | ~550 |
| [genclass-model-lineage.md](genclass-model-lineage.md) | `jev_local/**` (except bench), Python tests, legacy `docs/*.md` | Python reference for parity; trainer; legacy server and harness | ~570 |
| [extension-and-benchmarks.md](extension-and-benchmarks.md) | `extension/**`, `bench/**`, `jev_local/bench/**`, `results/**`, `scripts/**` | Chrome extension, benchmarks, ops scripts | ~565 |
| [status-and-known-issues.md](status-and-known-issues.md) | OPEN_TASKS, HANDOFF, STATUS, NEEDS files, `docs/runtime/*`, git history | Status, ground rules, owners, open issues, cross-doc drift | ~640 |

## Conventions used in these docs

- **Header block.** Every subsystem doc opens with three lines: **Scope** (the files it covers), **Read this when** and **Source of truth**. The last line reads "Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins." A doc that still names commit 654d822 has not been re-checked for situation-v2; treat it with suspicion.
- **Fixed sections.** All 16 subsystem docs (the 8 under `runtime/`, plus model-io-contract, sim, realapps, training, demos, genclass-model-lineage, extension-and-benchmarks and status-and-known-issues) use the same sections in the same order: TL;DR, Files, Concepts and data structures, How it works, Configuration and constants, Invariants and gotchas, How to change it safely, Tests, Drift and open issues, Related docs. Jump straight to the one you need. overview, glossary, repo-map and playbooks have their own layout.
- **Code pointers** look like `path/from/repo/root.ts` -> `symbolName`, for example `packages/runtime/src/runtime.ts` -> `RuntimeImpl.runDelivery`. They never give line numbers; find a symbol with `rg -n "symbolName" <path>`. Some runtime docs shorten paths to `src/…` and `test/…`, relative to `packages/runtime/`. [status-and-known-issues.md](status-and-known-issues.md) states its own path convention at the top of its TL;DR.
- **Code wins.** A doc describes the code at its verified commit. If a doc disagrees with the code, trust the code, then fix the doc. This applies to the human docs too: CONTRACT.md (no `delivery` trigger, old budgets, old redaction rule), API.md, HANDOFF.md (still says guard is the default), STATUS.md, OPEN_TASKS.md (body still describes situation-v1 phase A and training round 1 as current), the NEEDS files and MODEL_CARD.md all have stale items.
- **Drift sections.** "Drift and open issues" lists two things:
  - where docs or code comments disagree with the code, and what the code really does;
  - open questions, and findings that came only from reading the code, with no test behind them, including the findings of the 2026-10-08 adversarial review of the v2 changes (delivery, situation, sim/training scripts, realapps, project docs).

  Check this section before you rely on a human doc. [status-and-known-issues.md](status-and-known-issues.md) holds the cross-cutting drift tables (human docs vs the runtime code). Subsystem-specific drift is only in each doc's own Drift section.
- **"(unverified)"** marks a claim that nobody could confirm from the code or a run at the verified commit. Typical cases are live URLs, browser behaviour, Azure/VM state and results that are not in the repo. Treat such a claim as a hypothesis. "Inferred" and "code reading only" mean the claim was derived from the source and no test asserts it.

## Keeping the docs current

1. **Update the doc in the same change as the code.** If you change code under a doc's Scope, edit the affected sections in that doc (Files, constants, How it works, Tests). Remove Drift entries your change resolves, and add any mismatch it creates.
2. **Update the "Source of truth" line.** Name the branch and commit you checked the doc against, and the date. If you re-checked only part of the doc, name those sections in that line.
3. **Fix every copy of a repeated fact.** Several facts appear in more than one doc: the `situation-v2` freeze, the default mode `observe`, `holdWrites` off by default, the unpublished model and its 404 URLs, the default hold budget, the 2,400-char full budget, test counts (350 = 336 passed + 14 skipped), the realapps app count (91 at b435acb). Before you finish, search for the symbol or value you changed and fix every hit, for example `rg -n "DEFAULT_MODEL_BASE_URL|situation-v1" docs/agents`.
4. **Model-visible changes cascade.** A change to situation text, delivery salience, questions, labels or budgets touches [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md), [model-io-contract.md](model-io-contract.md), [sim.md](sim.md), [realapps.md](realapps.md), [training.md](training.md) and [status-and-known-issues.md](status-and-known-issues.md) (freeze tag).
5. **New docs.** A new subsystem doc keeps the same header block and ten sections. Add it to the catalogue and the routing table here, and to [repo-map.md](repo-map.md). Refresh the line counts with `wc -l docs/agents/*.md docs/agents/runtime/*.md` when a doc grows or shrinks a lot.
6. **Mark what you could not check.** Write "(unverified)" next to anything you could not confirm. Never add line numbers.

### How these docs relate to the human docs

The agent docs are derived from the code. They cite the human docs mainly to record drift, and they do not replace them:

- `docs/runtime/CONTRACT.md` is the binding build contract. It holds the §0 ground rules, the spec, and the approved additions in §13 (our default-mode change is recorded there). The batch 4/5 contract deltas (the `delivery` trigger, salience rules, budgets, redaction) exist only in `packages/runtime/STATUS.md` ("Contract deltas"). To change the contract, write a NEEDS item or ask the user (who now stands in for the lead); an approved deviation goes into CONTRACT §13 or STATUS "Deviations from the contract (and why)".
- `docs/runtime/API.md` is the public API reference for library users. If you change the public surface, update API.md and the JSDoc in `packages/runtime/src/types.ts` in the same change, then the agent doc.
- `docs/runtime/ARCHITECTURE.md` is the design overview for humans. [docs/runtime/RESULTS.md](../runtime/RESULTS.md) holds the measured comparisons and the training log (HANDOFF asks for an update with every result). Their known drift is listed in [status-and-known-issues.md](status-and-known-issues.md).
- [HANDOFF.md](../../HANDOFF.md) is the colleague's entry point for a new session (state, rules, how to continue). Its run rules are for his 8 GB Mac and the Azure cluster; our agents follow `AGENTS.md`.
- [RELEASE.md](../../RELEASE.md) at the repo root is the release procedure: Part A for `0.1.0-alpha.1` (done 2026-10-08), Part B for the model and `0.1.0`.
- The workstream status files (`packages/runtime/STATUS.md`, `packages/runtime/UI-NEEDS.md`, `sim/NEEDS.md`, `training/NEEDS.md`, `demos/NEEDS.md`, `OPEN_TASKS.md`) are how the team coordinates. Follow the process in [status-and-known-issues.md](status-and-known-issues.md), and do not close or rewrite another workstream's items: the requester flips an item to DONE after verifying (owners may add answers under their own heading). REAL has no NEEDS file of its own; its requests and node claims live in `training/NEEDS.md`.
- The legacy jev-local docs (`docs/SPEC.md`, `docs/CONTRACT.md`, `docs/CONTRACT-v2.md`, `docs/DEMO.md`, `docs/GENCLASS.md`, `docs/COMPARISON.md`, `docs/PLAN-excel.md`) and `docs/benchmax-research/` are not the runtime contract. CONTRACT §1 says this earlier GenClass content "stays as is". They are summarised in [genclass-model-lineage.md](genclass-model-lineage.md) and [extension-and-benchmarks.md](extension-and-benchmarks.md).
