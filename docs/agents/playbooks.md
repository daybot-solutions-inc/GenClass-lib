# Playbooks: recipes for common changes

> **Scope:** step-by-step recipes for the edits agents are most often asked to make in this monorepo: the runtime (`packages/runtime`), its model host and devtools, the adapters, `sim/`, `realapps/`, `training/`, `demos/`, releases, CI, test runs, debugging a reported intervention, and these docs. Each recipe merges and deduplicates the "How to change it safely" sections of the subsystem docs.
> **Read this when:** you have a concrete change to make and need the full checklist: files and symbols to touch, tests to add and run, parity / retrain / release consequences, and the traps.
> **Source of truth:** the code. Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins. If this doc and a subsystem doc disagree, check the code and fix whichever is wrong (recipe 26).

## TL;DR

- The runtime is **situation-v2** (tag `situation-v2` = 6e5e86e): decisions happen at the network boundary (trigger `delivery`), store writes are not held by default, and the model-visible text is **frozen**. Any change to what the model reads needs the user's go-ahead, a new tag, regenerated SIM **and** realapps data, and a retrain (recipe 6).
- On `mvp-v2` the only runtime changes since the tag are ours: f3636b2 (default mode `observe`; `guard` opt-in, `heal` experimental) and b435acb (CI, committed root lockfile, CLI 100755). Neither touches model text.
- **No situation-v2 model exists.** The plan (HANDOFF): 150M teacher on v2 gold -> teacher labels on unlabeled rows -> distil R17 (default) and R32 -> DAgger via SIM `--on-policy` -> EVAL -> `@genclass/runtime-model@0.1.0` -> demos rerun -> `@genclass/runtime@0.1.0` (recipes 30, 20, 22, 19; release procedure in [`RELEASE.md`](../../RELEASE.md)).
- Light local checks are fine: `npm ci`, runtime `tsc`/`tsup`/vitest, sim `tsc` and `SIM_RUNTIME=real` vitest. **Ask the user first** for Playwright, `smoke.sh`, the sim generator, realapps, training, demos eval, model downloads, anything on Azure, `git push`, `npm publish`. Azure is operated by the colleague (Mehar) right now; nobody on our side touches it.
- Baseline at b435acb: runtime unit tests 332 passed + 14 skipped (40 + 1 files) without `review-perf`, which passes alone (4); sim 19 passed (5 files). CI (`.github/workflows/ci.yml`) runs the same runtime steps (recipe 21).
- New recipes: never-worse sweep (28), add a realapps app (29), the v2 training pipeline (30).

Conventions used below:

- Code pointers are `path/from/repo/root.ts` -> `symbol`. A method is written `Class.method`. No line numbers.
- In "Tests" lines, test files are listed after their directory, e.g. `packages/runtime/test/`: `atoms.test.ts`, `policy.test.ts`.
- **[ask first]** marks a step that runs something the run policy reserves for the user's approval (see [Where to run things](#3-where-to-run-things)).
- **Model input** means any byte that reaches `EvaluateRequest.state` or `EvaluateRequest.questions` (situation text, question headers, option descriptions, diagnosis labels), plus the token ids derived from it.
- Recipes say "the lead", "SIM", "REAL" or "TRAIN" where the original workstream protocol required their sign-off. In an agent session, stop and get the user's decision at those points; record it the way the protocol describes (recipe 26).
- "(unverified)" marks a statement that could not be checked from the repo.

## Before you start

### 1. Ground rules (binding: `docs/runtime/CONTRACT.md` §0 and §0.5, `HANDOFF.md` "Rules")

- **No rules in the runtime.** The runtime computes generic facts and decides whether to ask the model (triage); it never maps a fact pattern to a diagnosis or action with an if/then. The model chooses; `packages/runtime/src/decide/policy.ts` -> `gate` only filters. This also holds when you fix a false intervention (recipe 25).
- **One situation implementation.** `packages/runtime/src/situation/*` is the only code that builds situation text. The sim runs it unchanged (`sim/src/run/rt.ts` -> `realRuntimeFactory`), realapps bundles it into every app (`realapps/build.mjs`, `RW_RUNTIME_SRC`), and `training/curriculum/rt.py` is a hand port of it.
- **Never make a correct app worse.** The default path applies store writes in the caller's stack, in order, and the default mode (`observe`) permits no action. Do not add anything that delays or reorders a default-path write (`packages/runtime/test/no-reorder.test.ts`, `default-mode.test.ts`), and check runtime changes with the realapps sweep (recipe 28).
- **Determinism.** Inside `packages/runtime/src`, never call `Math.random`, `Date.now`, `performance.now` or the global `setTimeout`/`setInterval`. Use the injected `Clock` (`this.clock` in `RuntimeImpl`, `api.clock` in plugins), take ids from counters, and clear every timer you arm in `RuntimeImpl.destroy` (or make it harmless when it fires later). Sim world code uses keyed `Rng` forks only (`sim/src/rng.ts` -> `Rng.fork`); realapps keys every draw by (seed, salt, request identity, occurrence).
- **Fail open.** Every path that has no usable answer runs the controller's passive action. Never make the app wait on the model.
- **`GenClass.init` never throws.** Observers install inside `tryAdd` in `packages/runtime/src/runtime.ts` -> `RuntimeImpl.installObservers`; plugin `setup` errors are swallowed.
- **Honest evaluation.** `sim/`, `realapps/` and `demos/` never import or read each other's apps (realapps imports sim's cost/label code by design, never `demos/`). Do not fix the demo apps' latent bugs or tune them for GenClass.
- **Dependencies.** No new runtime dependency besides `onnxruntime-web` without the lead. TypeScript strict, ESM only. The root `package-lock.json` is committed: a dependency change must update it (`npm install` at the root) or CI's `npm ci` fails.
- **Legacy content stays as is** (CONTRACT §1): `jev_local/`, `extension/` and the jev-era `docs/*.md`. This does not cover `docs/runtime/` or `docs/agents/`.
- **Review tests are a contract.** Never edit `packages/runtime/test/review-*.test.ts` to make it pass; fix `src/`.
- **Licensing for training:** only v1 `jev-local-fast` or MIT ettin bases plus synthetic/sim/realapps data. Never v2/Z/S checkpoints or benchmark datasets (HANDOFF).
- **Code wins over docs.** `docs/runtime/CONTRACT.md`, `HANDOFF.md` (it still says guard is the default), STATUS test counts and the NEEDS files have stale items. Check the drift sections of the subsystem docs before trusting them.

### 2. The `situation-v2` freeze

| tag | commit | data and models built on it |
|---|---|---|
| `situation-v1` | 1a77558 | SIM phase A (600,676 rows) and B (1,415,344), `gold-r1x`, REAL pilots `pilot4`/`pilot-all`, curriculum `cur1`–`cur4`, round-1 R17/R32-final1. Superseded: does not match the v2 runtime. |
| `situation-v2` | 6e5e86e | **current.** SIM v2 gold/unlabeled runs (`train:/data/sim-out/v2-*`), REAL `v2-pilot` and `v2b1`–`v2b3`, the `rt.py` port (d73d20c). No model yet. |

`git diff situation-v2 b435acb -- packages/runtime/src` touches only `devtools/index.ts`, `runtime.ts` (the default mode) and `types.ts` (JSDoc), all f3636b2, none of them model text. Before editing, classify your change (condensed from [model-io-contract.md](model-io-contract.md#versioning-what-invalidates-the-trained-model)):

| class | what you touch | consequence |
|---|---|---|
| **A. Model input text or label space** | `packages/runtime/src/situation/{build,facts,conflicts,content,evidence,describe,serialize,questions}.ts`; `packages/runtime/src/util.ts` formatters (`secs`, `rel`, `fmtNum`, `ratio`, `truncate`, `describe`), redaction (`isSensitiveName`, `isSensitivePath`, `defaultRedact`) and signatures (`normalizePath`, `normalizeFieldPath`, `isIdSegment`); `packages/runtime/src/state/fields.ts` -> `changeText`, `stringDiff`; change summaries in `packages/runtime/src/state/hub.ts`; `ActionEffect.changed` sentences (`packages/runtime/src/runtime.ts`, `packages/runtime/src/observe/fetch.ts`, `packages/runtime/src/observe/xhr.ts`); observer op names, details and event `data` keys; which actions are offered (`packages/runtime/src/situation/build.ts` -> `builtinApplicable`); `TRIGGER_DESCRIPTIONS`, `BUILTIN_ACTIONS`, `DEFAULT_DIAGNOSES` | user approval, coordination with whoever is generating data, a new freeze tag, SIM **and** realapps regeneration, `training/curriculum/rt.py` re-port, retrain, re-eval, re-export (recipe 6) |
| **B. Distribution only** | `neutral` flags and triage thresholds, delivery salience (`conflicts.ts` -> `conflictsOn`, `content.ts` -> `analyzeBody`, `PENDING_WINDOW_MS`, `RYW_WINDOW_MS`), trigger conditions, baseline/profile estimators, invariant learning, hold/bypass rules, situation budgets and the SIM/realapps budget weights | regenerate SIM and realapps data; retrain recommended |
| **C. Token ids** | `packages/runtime/src/model/{serialize,pyutil,tokenizer,packer}.ts`, `packages/runtime/src/model/engine.ts` -> `FEEDS` | change `jev_local/` in lockstep, regenerate fixtures, retrain if the Python side changed (recipe 13) |
| **D. Answers only** | `packages/runtime/src/model/calibrate.ts`, `calibration.json` | re-run `training/eval_runtime.py`; no retrain |
| **E. Nothing the model sees** | `packages/runtime/src/decide/policy.ts` defaults, the default mode, host/loader/worker, devtools, adapters, report wording, CI | runtime tests only; mirror gate changes in `training/eval_runtime.py` and `training/eval_gain.py` |

Class A, B and C changes need the user's go-ahead **before** you edit. HANDOFF: "The training format is frozen at `situation-v2` … Coordinate before touching it." Data generation on Azure runs with this exact runtime right now, so a "small fix" to a fact also splits the in-flight data.

### 3. Where to run things

Run policy for agents (the lead, 2026-10-08): `HANDOFF.md`'s "never run npm, tsc, vitest, node … on the Mac" is about the colleague's 8 GB Mac. On this machine the light steps below were verified and may be run without asking. Everything else needs the user's approval first.

| task | run locally? | command | verified result (macOS, 16 GB, Node v25.6.0, 2026-10-08) |
|---|---|---|---|
| install | yes | `npm ci` at the repo root (or `npm install` when you change dependencies; commit the lockfile) | OK from the committed lockfile; an `EBADENGINE` warning (vitest@5.0.3 wants node `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`; Node 25 works). No longer leaves an untracked lockfile or a mode change on the CLI |
| runtime typecheck | yes | `npm run typecheck -w @genclass/runtime` (= `cd packages/runtime && npx tsc -p tsconfig.json --noEmit`) | clean. Covers `src/` only: tests are never type-checked |
| runtime build | yes | `npm run build -w @genclass/runtime` (= `npx tsup`) | OK; entries `index`, `adapters/{react,redux,zustand}`, `devtools/index`, `worker`; `.d.ts` for all but `worker` |
| runtime unit tests | yes | `cd packages/runtime && NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts`, then `NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts` | Test Files 40 passed \| 1 skipped (41); Tests 332 passed \| 14 skipped (346); `review-perf` alone 4 passed (it once failed at 5.5 ms vs its 2 ms bound inside a full parallel run: contention) |
| sim typecheck and tests | yes (build the runtime first) | `cd sim && npx tsc -p tsconfig.json --noEmit`; `SIM_RUNTIME=real npx vitest run` | clean; 19 passed (5 files). Without `SIM_RUNTIME=real`, `oracle.test.ts` fails by design ([sim.md](sim.md#tests)) |
| the 14 skipped model-parity tests | **[ask first]** (model download) | the unit command with `GENCLASS_MODEL_DIR=<model dir>` (default `<repo>/.cache-model`) | `test/model/packer.test.ts` (10 of 10), `engine.test.ts` (3 of 4), `calibrate.test.ts` (1 of 8). No v2 model exists; the v0.1 fixtures still pin the packer |
| Playwright (model specs, devtools UI spec), `packages/runtime/test/smoke/smoke.sh` | **[ask first]** | recipe 23 | not run |
| Python tests (`training/tests`, `tests/`) | **[ask first]** | recipe 23 | not run by the lead (a docs agent ran 5 of 6 `test_curriculum.py` functions locally; see [training.md](training.md#tests)) |
| sim generator, realapps (anything that launches Chromium), training, demos eval, model downloads | **[ask first]** | recipes 17, 18, 22, 28–30 | not run |
| anything that touches Azure: `scripts/*.sh`, `training/*.sh`, `sim/scripts/cluster/*`, `realapps/scripts/{cluster,node_setup}.sh`, `az` | **[ask first]**, and in practice no: the colleague operates the cluster | | needs `~/.jev-local/azure_hosts` and `~/.ssh/jev_azure`, which are on the colleague's machine |
| `git push`, tags, GitHub releases, `npm publish` | **[ask first]**; `npm publish` and `npm dist-tag` are the user's action (npm 2FA) | recipes 19, 20 | |

Untracked `packages/runtime/test/zz-*.test.ts` files from parallel agents may exist in a shared working copy; vitest collects them. Count only tracked files (`git status`) before trusting a red or inflated run.

### 4. Read these first

| file | why |
|---|---|
| [`HANDOFF.md`](../../HANDOFF.md) | the colleague's current state, rules and "How to continue" (more current than OPEN_TASKS) |
| [status-and-known-issues.md](status-and-known-issues.md) | what is shipped, frozen, in flight; ownership; drift tables |
| the subsystem doc for your area (index below) | "Invariants and gotchas", "How to change it safely", "Tests", "Drift and open issues" (the review findings at b435acb live there) |
| [`OPEN_TASKS.md`](../../OPEN_TASKS.md) | the lead's task list; describes the v2 pipeline (items 1-14) and "Needs the user" |
| [`packages/runtime/STATUS.md`](../../packages/runtime/STATUS.md) | CORE's state, example situations per trigger, "Never worse", "Deviations from the contract", "Open issues" |
| [`docs/runtime/RESULTS.md`](../runtime/RESULTS.md) | model comparisons, never-worse table, data volume, training log summary |
| [`docs/runtime/CONTRACT.md`](../runtime/CONTRACT.md), [`docs/runtime/API.md`](../runtime/API.md) | binding rules (§0, §0.5, §13); the human API reference (update it with any public-surface change) |
| NEEDS files: [`demos/NEEDS.md`](../../demos/NEEDS.md), [`sim/NEEDS.md`](../../sim/NEEDS.md), [`training/NEEDS.md`](../../training/NEEDS.md), [`packages/runtime/UI-NEEDS.md`](../../packages/runtime/UI-NEEDS.md) | open cross-workstream requests; `training/NEEDS.md` holds node claims and SIM/REAL data locations (items 10–16) |
| [`training/LOG.md`](../../training/LOG.md), [`training/EVAL.md`](../../training/EVAL.md), [`training/PLAN-v1.md`](../../training/PLAN-v1.md) | before any training or eval work |
| `realapps/README.md`, `realapps/apps/README.md` | before any realapps work ([realapps.md](realapps.md)) |

Ownership (CONTRACT §1 and §13): CORE owns `packages/runtime/src` except `model/` (MODEL) and `adapters/` + `devtools/` (UI); SIM owns `sim/`, REAL `realapps/`, TRAIN `training/` (CONTRACT §1 lists the lead), DEMOS `demos/`, REVIEW the `review-*` tests.

### 5. Recipe index

| # | recipe | area | can change model input? | needs **[ask first]** runs to finish? |
|---|---|---|---|---|
| 1 | [Add or change an observer](#1-add-or-change-an-observer) | runtime | yes (op names, details, events) | no |
| 2 | [Add or change a generic fact](#2-add-or-change-a-generic-fact) | runtime | yes | yes (recipe 6) |
| 3 | [Add a trigger kind](#3-add-a-trigger-kind) | runtime + sim + realapps + training | yes | yes |
| 4 | [Add or change a built-in action](#4-add-or-change-a-built-in-action) | runtime (+ sim, realapps, training) | yes | for a new action |
| 5 | [Change a policy threshold or default](#5-change-a-policy-threshold-or-default) | runtime | no | sweep for default-path changes |
| 6 | [Change model-visible text under the situation-v2 freeze](#6-change-model-visible-text-under-the-situation-v2-freeze) | runtime + sim + realapps + training | yes | yes |
| 7 | [Change the state pipeline or invariants](#7-change-the-state-pipeline-or-invariants) | runtime | sometimes | sweep |
| 8 | [Add or change a framework adapter](#8-add-or-change-a-framework-adapter) | runtime (UI) | no | smoke test only |
| 9 | [Add a public API method, option, event or subpath export](#9-add-a-public-api-method-option-event-or-subpath-export) | runtime | only if it alters situations | smoke test only |
| 10 | [Add a custom action, standing question or plugin (app side)](#10-add-a-custom-action-standing-question-or-plugin-app-side) | app code | no retrain needed | no |
| 11 | [Add or change a devtools view](#11-add-or-change-a-devtools-view) | runtime (UI) | no | Playwright for screenshots |
| 12 | [Change model loading or backends](#12-change-model-loading-or-backends) | model host | no | browser specs |
| 13 | [Change the packer, tokenizer, serializer or calibration](#13-change-the-packer-tokenizer-serializer-or-calibration) | model host + `jev_local` | yes (token ids) | yes |
| 14 | [Regenerate model parity fixtures](#14-regenerate-model-parity-fixtures) | model tests | no | yes |
| 15 | [Add a sim feature module](#15-add-a-sim-feature-module) | sim | data only | yes |
| 16 | [Change sim oracle, labelling, ask questions or splits](#16-change-sim-oracle-labelling-ask-questions-or-splits) | sim | labels only | yes |
| 17 | [Generate a SIM data set](#17-generate-a-sim-data-set) | sim | n/a | yes |
| 18 | [Train, evaluate and export a model (mechanics)](#18-train-evaluate-and-export-a-model-mechanics) | training | n/a | yes |
| 19 | [Publish @genclass/runtime](#19-publish-genclassruntime) | release | n/a | yes (the user publishes) |
| 20 | [Publish @genclass/runtime-model and point the runtime at it](#20-publish-genclassruntime-model-and-point-the-runtime-at-it) | release | n/a | yes |
| 21 | [Change the CI workflow](#21-change-the-ci-workflow) | repo | no | no |
| 22 | [Add or change a demo and re-run trials](#22-add-or-change-a-demo-and-re-run-trials) | demos | no | yes |
| 23 | [Run each test suite](#23-run-each-test-suite) | all | n/a | some |
| 24 | [Write a runtime unit test](#24-write-a-runtime-unit-test) | runtime tests | n/a | no |
| 25 | [Investigate a false intervention reported by a user](#25-investigate-a-false-intervention-reported-by-a-user) | runtime | depends on the fix | no |
| 26 | [Update these docs after a code change](#26-update-these-docs-after-a-code-change) | docs | n/a | no |
| 27 | [Touch legacy code: jev_local, extension, benchmarks, ops scripts](#27-touch-legacy-code-jev_local-extension-benchmarks-ops-scripts) | legacy | possibly | yes |
| 28 | [Run and read a never-worse sweep (realapps)](#28-run-and-read-a-never-worse-sweep-realapps) | realapps + runtime | no | yes |
| 29 | [Add a realapps app](#29-add-a-realapps-app) | realapps | data only | yes |
| 30 | [Run the v2 training pipeline (teacher, labels, distil, DAgger)](#30-run-the-v2-training-pipeline-teacher-labels-distil-dagger) | training + sim + realapps | n/a | yes, all of it |

## Definition of done

A change is done when all of these hold. Say explicitly in your final report which ones you could not meet.

1. **Typecheck clean:** `npm run typecheck -w @genclass/runtime`. If you touched `sim/src` or anything the sim imports, also `cd sim && npx tsc -p tsconfig.json --noEmit`. `realapps/` has no tsconfig and no typecheck: review type changes there by reading.
2. **Unit tests pass:** the runtime suite as in [Where to run things](#3-where-to-run-things) (baseline at b435acb: 332 passed / 14 skipped in 40 + 1 files, plus `review-perf` 4 passed alone). Your new tests add to "passed" and nothing new is skipped. No `review-*.test.ts` was edited. If the sim consumes what you changed, `SIM_RUNTIME=real npx vitest run` in `sim/` (19 passed) after `npm run build -w @genclass/runtime`.
3. **New behaviour has a test** in house style (recipe 24), including a "benign stays quiet" test for anything that can make a situation salient, and a default-mode (`observe`) test for anything that could delay, hold or reorder app work.
4. **Build passes** (`npm run build -w @genclass/runtime`) if you touched `package.json` exports, `tsup.config.ts`, the worker, dynamic imports or anything bundling-related.
5. **CI steps pass locally** (they are the commands above; `.github/workflows/ci.yml`). A dependency change updates and commits the root `package-lock.json`.
6. **Mirrors updated by hand** (the runtime's `tsc` checks none of them): `packages/runtime/test/browser/ui/mock-runtime.ts` -> `MockRuntime`, `demos/src/dev/runtime-shim/*` (`ShimRuntime`), `sim/src/run/rt.ts` -> `RuntimeLike` / `createOptions`, `sim/src/types.ts`, `realapps/src/harness/trajectory.ts` (`OBSERVE`, `TRIGGER_W`), `realapps/src/world/{index,probe,diagnose}.ts`, `realapps/scripts/{analyze,evalset}.py` (`PASSIVE` copies), `training/curriculum/rt.py`, `training/label_teacher.py` / `training/eval_runtime.py` (`PASSIVE`, `TIER`), the devtools copies of report wording (`packages/runtime/src/devtools/ui.ts` -> `LEAD`, `NOUN`).
7. **Freeze respected:** `git diff situation-v2 -- packages/runtime/src` shows nothing beyond f3636b2's three files and no class A/B/C change, or the user approved it and your report lists the follow-ups of recipe 6. Do not create freeze tags yourself.
8. **Docs updated** (recipe 26): `packages/runtime/src/types.ts` JSDoc, `docs/runtime/API.md`, `packages/runtime/README.md` (and root `README.md`) for public surface; `packages/runtime/STATUS.md`; `docs/runtime/RESULTS.md` for any new measured result; the matching `docs/agents/*.md`; `OPEN_TASKS.md` / `HANDOFF.md` when a listed item moves.
9. **Workspace clean:** no `dist/`, `*.tgz`, regenerated screenshots, `zz-*` scratch tests or local model directories committed by accident.
10. **Nothing irreversible without the user:** no `npm publish`, `git push`, tag, GitHub release, Azure call or paid API call unless the user explicitly asked for that action in chat.
11. **Report** lists the commands you ran with their results, and the **[ask first]** suites you did not run (Playwright, smoke, sim generator, realapps sweeps, model tests, training, Python tests).

## Recipes: runtime core

### 1. Add or change an observer

**Goal.** Trace a new async source (e.g. `BroadcastChannel`, requested with EventSource in `demos/NEEDS.md` §6; EventSource itself is done in v2), or change how an existing observer records ops and events.

**Steps.**
1. Decide whether you need core code. App-specific sources can stay in a plugin: `PluginApi.recordOp` / `endOp` / `runInOp` (`packages/runtime/src/runtime.ts` -> `RuntimeImpl.pluginApi`), with no core or parity impact (recipe 10).
2. Create `packages/runtime/src/observe/<name>.ts` exporting `install<Name>(...)` that returns an uninstall function, or `null` when the global is missing. Follow `packages/runtime/src/observe/fetch.ts` -> `installFetch`: a `disabled` flag so the wrapper becomes a pass-through after `destroy()`, restore the global only if it still holds your wrapper, wrap all tracing in try/catch, use the host's clock. A push channel follows `packages/runtime/src/observe/eventsource.ts` -> `installEventSource` and `packages/runtime/src/observe/messages.ts` -> `MessageGate` (deliveries in channel order, behind any held message).
3. Register it in `packages/runtime/src/runtime.ts` -> `RuntimeImpl.installObservers` with `if (on("<name>")) tryAdd("<name>", () => install<Name>(...))`. `on(k)` defaults to true; pass a second argument (as `timers` does with `browserLike`) to make the default conditional.
4. Add the name to `packages/runtime/src/types.ts` -> `ObserverName`; TypeScript then forces it into `packages/runtime/src/index.ts` -> `ALL_OFF`.
5. Explicit observe maps that omit a key leave it **on**. None of these lists `eventsource` today (harmless only where no `EventSource` global exists): `packages/runtime/test/helpers.ts` -> `setup`, `packages/runtime/test/browser/ui/session.ts` (`OBSERVE`), the `ONLY_*` constants in `review-fetch.test.ts` / `review-timers.test.ts`, `const OFF` in `dom.test.ts`, `sim/src/run/rt.ts` -> `createOptions`, `realapps/src/harness/trajectory.ts` -> `OBSERVE` and `realapps/src/world/index.ts` (`ALL_OFF` of the ideal run; realapps also sets `window.EventSource = undefined` in `src/world/netapi.ts`). Add your key to each, `false` unless SIM/REAL want it.
6. Reuse an existing `packages/runtime/src/types.ts` -> `OpKind` if you can. A new kind also touches `packages/runtime/src/situation/describe.ts` -> `opPhrase`, `opLabel`, the `PROFILED` set in `packages/runtime/src/runtime.ts`, and situation text (class A).
7. To carry causality across a new async boundary (`requestAnimationFrame`, `queueMicrotask`, `MessagePort`), copy `packages/runtime/src/observe/timers.ts` -> `installTimers`: capture `ctx.peek()` at schedule time, resolve a `LazyOp` to `.nearest`, call `ctx.stick(lazyTimer(parent, label))` in the callback. Never give a `LazyOp` a `LazyOp` parent.
8. Network observers that deliver data must route the delivery through `RuntimeImpl.runDelivery` (fetch via `NetHost.deliver`, XHR via `arrive()`, push channels via `MessageGate.decide`) so the `delivery` trigger sees it; keep listener order and keep the app's dispatch semantics (known gaps: XHR listeners released from the queue see `e.currentTarget === null`; a capture-phase message listener can see a held message twice; see [observe-and-trace.md](runtime/observe-and-trace.md#drift-and-open-issues)).
9. Changing DOM recording (`packages/runtime/src/observe/dom-user.ts` -> `installDomUser`): keep the `ignoredEvent(e) || programmatic(e)` guard, the `untrustedEvents` option (default false: synthetic `isTrusted: false` events are not recorded; realapps passes `true`) and the rule that sensitive fields record `""`. If `describeElement` output changes, the sim's synthetic targets must follow.
10. Adding a volatile header: add it to both `packages/runtime/src/observe/fetch.ts` -> `VOLATILE_HEADERS` and `packages/runtime/src/observe/xhr.ts` -> `VOLATILE`, so identities match across transports. `x-request-id` (the sim's correlation header) must stay volatile.

**Tests.** `packages/runtime/test/`: install and record; `destroy()` restores the global (next to `dom.test.ts` "browser globals are restored by destroy()"); pass-through after destroy (`review-fetch.test.ts` pattern); a read-only global does not throw (`batch3.test.ts`, `review-misc.test.ts` patterns); delivery order and holds (`delivery.test.ts`). For context changes run `context.test.ts` and `review-timers.test.ts` with `NODE_OPTIONS=--expose-gc` (otherwise the gc test logs a skip and passes). For DOM changes run `dom.test.ts`, `review-dom.test.ts`.

**Parity / retrain / release.** A new observer that SIM and realapps leave off adds no training rows, but its ops, op names, `detail` strings and event `data` keys appear in timelines and facts at runtime: they are class A for any trigger the data does produce. Renaming existing op names, details or event keys (`packages/runtime/src/situation/describe.ts` -> `eventLine`) is class A. Signature normalisation (`packages/runtime/src/util.ts` -> `normalizePath`, `isIdSegment`) also keys baselines and the persisted profiles under `genclass.profiles.v1`.

**Gotchas.** Captured natives (`packages/runtime/src/clock.ts` -> `browserClock` timers, `packages/runtime/src/index.ts` -> `NATIVE_FETCH`) must stay at module top level, or the runtime observes its own timers and model download. Two runtimes on one page double-wrap every global. WebSocket/EventSource instances and timer callbacks created before `destroy()` keep tracing. Sync XHR and keepalive fetch raise no request trigger. Nav routes are not redacted. The demos' in-page synthetic trial driver produces untrusted events, so with the default `untrustedEvents: false` it records no user actions (`demos/src/shared/genclass.ts` does not pass the option).

**See.** [observe-and-trace.md](runtime/observe-and-trace.md#how-to-change-it-safely), [public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md#how-to-change-it-safely).

### 2. Add or change a generic fact

**Goal.** Add a new uniform fact, reword one, change whether it is `neutral` (triage), or change a triage threshold.

**Steps.**
1. Get the user's go-ahead: every variant is class A (wording) or class B (neutral flag, threshold). Then follow recipe 6 for everything after the code edit.
2. Find the builder. v2 facts are spread over four modules, dispatched by `packages/runtime/src/situation/facts.ts` -> `computeFacts`:
   - `facts.ts`: `mutationFacts`, `deliveryFacts`, `requestCommon` (shared by request/failure/stall), `failureFacts`, `stallFacts`, `inconsistencyFacts`, `transitionFacts`, `errorFacts`, `askFacts`, plus the shared builders `versionFacts`, `movedFacts`, `concurrencyFacts`, `provenance`;
   - `conflicts.ts`: what a delivery or write is predicted to overwrite (`predictedWrites`, `matchFields`, `newerConflict`, `pendingConflict`, `conflictsOn`, `newerSameSignature`);
   - `content.ts`: body-versus-store comparisons (F1 put back a replaced value, F2 overwrites newer typing, F3 changes nothing: `compareField`, `contentFacts`, `pendingRevertFacts`; read-your-writes: `createdIds`, `rywFacts`);
   - `evidence.ts`: F5–F7, F9 (`scopeFacts`, `commitAmbiguity`, `repeatEvidence`, `cadenceFact`, `markFacts`).
   Build facts with each module's `fact(text, kind, neutral)` helper. State relations and numbers explicitly ("after", "newer", "in a row"); never phrase a verdict ("this is a bug").
3. Data comes only from `SitEnv` (`packages/runtime/src/situation/env.ts`), implemented by `packages/runtime/src/runtime.ts` -> `RuntimeImpl.makeEnv`. Add a read-only member there if needed. Read time only from `env.now()`. No ops, events or store writes.
4. Pick `kind` deliberately: `packages/runtime/src/situation/facts.ts` -> `RANK` decides which facts survive the budget. A new kind needs `packages/runtime/src/types.ts` -> `FactKind`, an entry in `RANK` (typed `Record<FactKind, number>`) and `RANK` in `training/curriculum/rt.py`.
5. Pick `neutral` deliberately: `false` makes the trigger salient, which means a model call and, in guard/heal, possibly a hold of a delivery or request. Triage is per trigger.
6. Keep ordering deterministic: `orderFacts` sorts non-neutral first, then by rank, stable; `MAX_FACTS` = 12.
7. Redaction: any fact that prints a field value must go through `env.redact` (or `changeText(..., redact)`). The F2 fact currently prints raw `stringDiff` text for redacted fields (open review finding, [learn-situation-triage.md](runtime/learn-situation-triage.md#drift-and-open-issues)); do not copy that pattern.
8. Check wording consumers: `packages/runtime/src/decide/report.ts` -> `topFact` and `packages/runtime/src/devtools/ui.ts` skip provenance with the regex `^This (write|request) (comes from|has no known cause)`; keep it matching.
9. Mirror the computation and ordering in `training/curriculum/rt.py` (`mutation_facts`, `delivery_facts`, `request_common`, `failure_facts`, `stall_facts`, `inconsistency_facts`, `transition_facts`, `error_facts`, `version_facts`, `content_facts`, `scope_facts`, `commit_ambiguity`, `repeat_evidence`, `cadence_fact`, `mark_facts`, `order`).
10. Variant, the numbers behind facts: baseline estimators live in `packages/runtime/src/learn/baselines.ts` -> `Baselines` (latency needs ≥ 5 samples), transition rarity in `packages/runtime/src/learn/profiles.ts` -> `Profiles`. Class B (class A where a number is printed).

**Tests.** A positive test (the situation reaches `decider.calls`) and a benign test (nothing salient; pattern: `packages/runtime/test/review-precision.test.ts`). Update exact-text assertions found with `grep -rn "<old sentence>" packages/runtime/test`: typically `situation.test.ts`, `budget.test.ts`, `delivery.test.ts`, `content.test.ts`, `batch3.test.ts`, `invariants.test.ts`, `review-fetch.test.ts`, `review-hub.test.ts`, `learn.test.ts`. If a `review-*` assertion must change, raise it with the user instead of rewriting it. Paste the situations printed by `situation.test.ts` and `budget.test.ts` into the STATUS.md example blocks.

**Parity / retrain / release.** Recipe 6 in full. A threshold change alters which situations become rows even when no sentence changes.

**Gotchas.** Plugin facts are always neutral and rank last. `rt.situation()` with no argument builds an `ask` situation, which is always salient. Facts are computed only while the runtime is consultable. `rt.py` already diverges from the frozen renderer in several common cases (an extra "Recent … outcomes" fact on failure rows, last-N timeline selection, no-op writes, F1 wording where the runtime shows F2; [training.md](training.md#drift-and-open-issues)); a re-port is the moment to fix them.

**See.** [learn-situation-triage.md](runtime/learn-situation-triage.md#how-to-change-it-safely), [model-io-contract.md](model-io-contract.md#recipes).

### 3. Add a trigger kind

**Goal.** Add a new kind of moment at which the model is consulted (alongside `mutation`, `request`, `delivery`, `failure`, `stall`, `inconsistency`, `transition`, `error`, `ask`).

**Steps.**
1. Get the user's go-ahead: this adds a new question family to the model's input and needs data and retraining (recipe 6).
2. `packages/runtime/src/types.ts` -> `TriggerKind`. The compiler then flags every `Record<TriggerKind, …>`: `packages/runtime/src/situation/questions.ts` -> `TRIGGER_ACTIONS` (passive first), `PASSIVE`, `ACTION_INSTRUCTIONS`, `TRIGGER_DESCRIPTIONS`; `packages/runtime/src/decide/report.ts` -> `NOUN`. `packages/runtime/src/devtools/ui.ts` -> `NOUN` is a `Record<string, string>` and must be updated by hand.
3. `packages/runtime/src/situation/env.ts` -> `SubjectSpec`, then `packages/runtime/src/situation/build.ts` -> `subjectOf`, `subjectOp`, `involvedStores`, `involvedFields`, `builtinApplicable`, `subjectRef` (`isTrigger` derives from `TRIGGER_ACTIONS`).
4. `packages/runtime/src/situation/facts.ts` -> a new facts function wired into `computeFacts` (recipe 2).
5. A raise site: implement `Controller` (`packages/runtime/src/decide/exec.ts`) and call `RuntimeImpl.trigger(spec, ctl, { hold, priority })`. Add `revertable`/`revert` only if the subject can be reverted exactly. Pass `stale` only when the decision is held (background decisions passed a `stale` check are dropped; open finding on `delivery` in [decide-policy-actions.md](runtime/decide-policy-actions.md#drift-and-open-issues)).
6. Mirrors: `sim/src/types.ts` (`TriggerKind`, `PASSIVE`), `sim/src/gen/trajectory.ts` -> `TRIGGER_W`, sim exploration, `sim/src/oracle/diagnose.ts`, `sim/src/oracle/cost.ts`, `sim/src/run/runner.ts` correlation; realapps `src/world/diagnose.ts`, `src/harness/trajectory.ts` -> `TRIGGER_W`, `scripts/{analyze,evalset}.py` `PASSIVE`; `training/curriculum/rt.py` (`TRIGGER_ACTIONS`, `ACTION_INSTR`, `TRIGGER_DESCRIPTIONS`, a facts port), `training/curriculum/fmt.py` -> `TRIGGER_ACTIONS`, `training/eval_runtime.py` -> `PASSIVE`, `training/label_teacher.py` -> `PASSIVE`, devtools labels.

**Tests.** `packages/runtime/test/`: a `situation.test.ts` case, a controller test in the style of `delivery.test.ts` / `fetch.test.ts` (hold, fail-open at the budget, passive on every exit, nothing held in default mode), `report.test.ts`, `devtools.test.ts` if the overlay labels it.

**Parity / retrain / release.** Class A plus a new label space: recipe 6 in full; SIM and realapps must be able to force every action of the new trigger.

**Gotchas.** Controllers must tolerate a second `passive()` call. Priority 2 is used only for held subjects; non-held ones are capped at 1.

**See.** [learn-situation-triage.md](runtime/learn-situation-triage.md#how-to-change-it-safely), [decide-policy-actions.md](runtime/decide-policy-actions.md#how-to-change-it-safely).

### 4. Add or change a built-in action

**Goal.** (a) Change what an existing built-in action does or the `changed` sentence it reports; or (b) add a new built-in action.

**Steps for (a), mechanics.**
1. Find the controller:
   - delivery (`deliver` / `discard` / `defer`) -> `packages/runtime/src/runtime.ts` -> `RuntimeImpl.runDelivery` (discard marks: `markWrites`, `dropFilter`, `writtenOver`, `onDropped`; store side `packages/runtime/src/state/hub.ts` -> `StoreHub.applyFilter`);
   - mutation -> `RuntimeImpl.mutationController`; held path (`policy.holdWrites: true`) `RuntimeImpl.gateMutation`; default non-holding path `RuntimeImpl.observeWrite` (a passing `discard` becomes a late revert);
   - inconsistency, transition, error -> `RuntimeImpl.raiseInconsistency`, `raiseTransition`, `reportError`, whose `rollback` runs `RuntimeImpl.rollback` (inconsistency) or `RuntimeImpl.revertChain` (transition, error) and whose `resync` runs `RuntimeImpl.resync`;
   - request, failure, stall -> `packages/runtime/src/observe/fetch.ts` -> `installFetch` and `packages/runtime/src/observe/xhr.ts` -> `installXHR`.
2. Keep the controller contract: throw when the action cannot run (the passive action then runs); return an exact `changed` sentence, built from what actually happened (the delivery `discard` sentence is written at decision time and can claim drops that did not happen on redux/zustand stores: open finding); provide `undo` only if the effect is truly reversible and idempotent; mark synthesised answers `synthetic: true` with an `x-genclass` header; tolerate repeated `passive()` calls.
3. Applicability lives in `packages/runtime/src/situation/build.ts` -> `builtinApplicable` (class A). Example open issue: `retry` is offered for any replayable fetch with `attempt < 4`, including non-idempotent POSTs (`demos/NEEDS.md` §5).

**Steps for (b), a new action.** Do not do this in the runtime alone.
1. Get the user's go-ahead (class A, new label).
2. `packages/runtime/src/situation/questions.ts` -> `BUILTIN_ACTIONS` (name, tier `guard` or `heal`, description) and `TRIGGER_ACTIONS` (passive stays first), plus `TRIGGER_DESCRIPTIONS` if its text differs per trigger.
3. `builtinApplicable`; the controller's `run()` (step a1).
4. `packages/runtime/src/decide/report.ts` -> `LEAD` and `packages/runtime/src/devtools/ui.ts` -> `LEAD`.
5. Sim: `sim/src/oracle/cost.ts` -> `TIER`, `sim/src/run/transform.ts` -> `ACTION_PARA`, `sim/src/run/fake-runtime.ts`, `sim/scripts/relabel.py`, and a scenario in which forcing it is meaningful. realapps reuses sim's tiers and transform; check its probe can force it.
6. Training: `training/curriculum/fmt.py` -> `ACTION_DESC`, `TRIGGER_ACTIONS`, `TIER`; `training/curriculum/rt.py` -> `ACTIONS`, `TRIGGER_ACTIONS` (and `DELIVERY_ACTION` if it maps); `training/eval_runtime.py` -> `TIER`; `training/t1_relabel.py` / `eval_gain.py` -> `PREM`.

**Tests.** `packages/runtime/test/`: `delivery.test.ts`, `fetch.test.ts`, `xhr.test.ts`, `atoms.test.ts`, `review-fetch.test.ts`, `review-xhr.test.ts` (mechanics and `changed` text; add redux/zustand variants for store-side effects); `policy.test.ts` (tiers); `report.test.ts`, `devtools.test.ts`, `devtools-runtime.test.ts`; for a new action also `situation.test.ts`.

**Parity / retrain / release.** `BUILTIN_ACTIONS` descriptions, `TRIGGER_ACTIONS` membership/order, applicability and `ActionEffect.changed` (it reappears in later timelines) are model input: recipe 6. A pure mechanics change with the same `changed` text and applicability is class E, but it changes SIM/realapps counterfactual costs (labels): tell SIM and REAL.

**Gotchas.** The rate limiter takes its slot before the effect, so failed attempts count. Delivery `discard` keeps dropping the chain's writes for `DISCARD_MARK_MS` (10 s), including later fresh polls chained from the discarded op, and survives `pause()`/`setMode("observe")`; each delivery `defer` can wait up to `LONG_RUNNING_MS` (10 s), two defers are allowed (a 20 s hold was reproduced), and it stalls the whole push channel behind it (open findings). `coalesce` (≤ 8 s), `delay` (≤ 8 s), `retry` backoff (≤ 5 s) keep the subject waiting after the hold budget timer is cleared. Only `discard` (and a late revert), `rollback` and custom actions with `onUndo` have an undo.

**See.** [decide-policy-actions.md](runtime/decide-policy-actions.md#how-to-change-it-safely), [model-io-contract.md](model-io-contract.md#recipes), [sim.md](sim.md#how-to-change-it-safely), [training.md](training.md#how-to-change-it-safely).

### 5. Change a policy threshold or default

**Goal.** Change a default such as a gate threshold, the hold budget, the rate limit, the default mode, `settleMs` or `historySize`, or the gate logic itself.

**Where defaults live.**

| default | value | defined in |
|---|---|---|
| `mode` | `"observe"` (f3636b2; `"guard"` before, and still in `0.1.0-alpha.0` on npm) | `packages/runtime/src/runtime.ts` -> `RuntimeImpl` constructor (`o.mode ?? "observe"`) |
| `settleMs`, `historySize` | 60, 500 | same constructor |
| `policy.thresholds` report / guard / heal | 0.6 / 0.9 / 0.8 | `packages/runtime/src/decide/policy.ts` -> `policyConfig` |
| `policy.holdBudgetMs` | `"auto"`: clamp(round(1.5 × median latency), `HOLD_MIN_MS` 150, `HOLD_MAX_MS` 800); `HOLD_FALLBACK_MS` 300 with no data | `policyConfig`, `holdBudget` |
| `policy.holdWrites`, `holdUserWrites` | false, false | `policyConfig` |
| `maxActionsPerMinute`, `requireDiagnosis` | 60, true | `policyConfig` |
| queue: `MAX_QUEUE`, `CACHE_MAX`, `CACHE_TTL`, `LATENCY_SAMPLES`, `PROVIDER_TIMEOUT_MS` | 32, 64, 30 s, 20, 10 s | `packages/runtime/src/decide/decider.ts` |
| `LATE_REVERT_MS`, `BACKGROUND_DEADLINE_MS`, `DISCARD_MARK_MS`, `BODY_WAIT_MS`, `LONG_RUNNING_MS`, `STALL_MIN_MS` | 2,000, 5,000, 10,000, 100, 10,000, 500 ms | `packages/runtime/src/runtime.ts` |
| response cache and coalescing: `MAX_BODY`, `MAX_ENTRIES`, `COALESCE_WINDOW_MS`, `BUFFER_WAIT_MS`; `COALESCE_MAX_WAIT_MS` | 256 KB, 64, 2,000 ms, 1,000 ms; 8,000 ms | `packages/runtime/src/observe/cache.ts`; `packages/runtime/src/observe/fetch.ts` |
| situation budgets | `STATE_CHAR_BUDGET` 2,400, `COMPACT_BUDGET` 1,100, `MIN_BUDGET` 500; auto by device (WebGPU or unknown 2,400; WASM 1,000 at 1 thread to 2,000 at 4 threads) | `packages/runtime/src/situation/serialize.ts`; `RuntimeImpl.situationBudget` (model input: recipe 6) |

**Steps.**
1. Change the value where it is defined. Options are read once in the constructor (`o.x ?? default`); only `setMode` changes behaviour live.
2. Update the JSDoc in `packages/runtime/src/types.ts` (`PolicyOptions`, `InitOptions`), `docs/runtime/API.md` ("Options", "Policy"), `packages/runtime/README.md`, the root `README.md`, and CONTRACT §13 for a default the contract names. The mode change f3636b2 did the JSDoc, API.md, ARCHITECTURE and §13; both READMEs now say observe is the default, but `HANDOFF.md` still says guard.
3. Gate logic: edit only `packages/runtime/src/decide/policy.ts` -> `gate`. Keep the reason strings verbatim: `policy.test.ts` and `report.test.ts` assert them, the console report prints them, devtools shows them, `demos/src/site/activity.ts` classifies decisions by the substrings `"hold budget"`, `"below the"` and `"expected"`, and the demos' results key `notExecuted` by the reason text.
4. Check the forced-action contracts: `sim/src/run/rt.ts` -> `createOptions` and `realapps/src/world/index.ts` both pass explicit `mode: "heal"` and `thresholds { report: 0, guard: 0.5, heal: 0.5 }`, `requireDiagnosis: false`, `holdBudgetMs: 1e9`, `maxActionsPerMinute: 1e9`; they must still be able to force any action. Because they pass the mode explicitly, a default-mode change does not change their data.
5. Mirror gate semantics or thresholds in `training/eval_runtime.py` (`THRESH`, `decision_metrics`), `training/eval_gain.py` and the "Runtime gate" definition in `training/EVAL.md`.
6. A change to the default path (anything that can hold, delay or reorder app work without an explicit opt-in): run `default-mode.test.ts`, `no-reorder.test.ts`, `delivery.test.ts`, then propose a never-worse sweep (recipe 28) **[ask first]**.

**Tests.** `packages/runtime/test/`: `default-mode.test.ts` (no hold, delay or change in observe, even with a sure model or a model that never answers), `policy.test.ts`, `budget.test.ts` (hold budget 300 / 150 / 800 / adaptive), `fetch.test.ts` (gates fail open at 300 ms; imports `MAX_BODY` / `MAX_ENTRIES`), `review-fetch.test.ts`, `atoms.test.ts`, `delivery.test.ts`, `report.test.ts`, `batch3.test.ts` and `review-misc.test.ts` (a provider that never answers). Most tests run in guard because `test/helpers.ts` -> `setup` defaults `mode: "guard"`; tests of the hold pipeline add `policy: { holdWrites: true }`.

**Parity / retrain / release.** Class E for the model. Thresholds and budgets change eval comparability (tell TRAIN) and demo comparability.

**Gotchas.** The threshold applies to the summed probability of all permitted actions, at the candidate's tier. Thresholds of 0 run the first permitted action even at probability 0 (why SIM and REAL use 0.5). Observe mode still waits up to `BODY_WAIT_MS` (100 ms) for a conflicting delivery's body and runs XHR listeners outside the original dispatch (open finding: `default-mode.test.ts`'s "never holds" is not fully true for deliveries). The console hint "Deny this action: `GenClass.init({ policy: { deny: [...] } })`" does nothing on a page where `GenClass.init` already ran.

**See.** [decide-policy-actions.md](runtime/decide-policy-actions.md#configuration-and-constants), [public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md#how-to-change-it-safely).

### 6. Change model-visible text under the situation-v2 freeze

**Goal.** Change anything the model reads (fact or timeline wording, state/stats/in-flight lines, section limits or character budgets, question headers, option descriptions, trigger descriptions, diagnosis labels, formatting, redaction), or fix a defect in it, without silently splitting the training data.

**Steps.**
1. **Stop and ask.** Get the user's go-ahead and the colleague's coordination before editing (HANDOFF: "Any change to `packages/runtime/src/situation/*` changes the model's input, so it means a new tag and regenerated data. Coordinate before touching it."). SIM and REAL are generating v2 data on Azure with the frozen text right now. Agree on: whether the fix waits until after the current v2 generation and the first v2 model, or replaces them; the new tag name (`situation-v3`); who regenerates.
2. Batch the change. Each freeze costs a full regeneration and retrain, so collect every pending class A/B fix first. Candidates found by review at b435acb ([learn-situation-triage.md](runtime/learn-situation-triage.md#drift-and-open-issues), [training.md](training.md#drift-and-open-issues), [sim.md](sim.md#drift-and-open-issues)): the F2 redaction bypass (`content.ts` -> `contentFacts`), the leaf-based redactor no longer redacting numbers/arrays under secret-named containers (`util.ts` -> `isSensitivePath`), "…nor the value when #X started" asserted without checking, every successful POST counted as a create (`createdIds`), HTTP 502 in `NOT_PROCESSED` (`evidence.ts`), the SIM and realapps budget weights still sampling the v1 3,200-char budget 40% of the time (`sim/src/world/scenario.ts`, `realapps/src/harness/scenario.ts`; production never exceeds 2,400), and the `rt.py` divergences.
3. Edit only `packages/runtime/src/situation/*`, the helpers in `packages/runtime/src/util.ts`, `packages/runtime/src/state/fields.ts` (`changeText`, `stringDiff`), and the other class A sources listed in [the freeze table](#2-the-situation-v2-freeze). Find the code by section:

| what | runtime | Python port (`training/curriculum/rt.py`) |
|---|---|---|
| facts | `situation/facts.ts`, `conflicts.ts`, `content.ts`, `evidence.ts` (recipe 2) | `*_facts`, `request_common`, `version_facts`, `content_facts`, `scope_facts`, `commit_ambiguity`, `repeat_evidence`, `cadence_fact`, `mark_facts`, `order` |
| delivery prediction text | `facts.ts` -> `predictedText`, `deliveryFacts`; `build.ts` -> `relatedInFlight` | `delivery_spec`, `predicted_text`, `related_in_flight`, `field_list_text` |
| subject sentence | `situation/build.ts` -> `subjectOf` | `subject_sentence` |
| timeline lines | `situation/describe.ts` -> `eventLine`, `opPhrase`; `build.ts` -> `timelineLines` | `event_lines` |
| state / stats / in-flight lines | `build.ts` -> `stateLines`, `statsLines`, `inFlightLines` | `state_lines`, `stats_lines`, `in_flight_lines` |
| change text | `state/fields.ts` -> `changeText`, `stringDiff` | `change_text`, `string_diff` |
| budgets and shrink order | `situation/serialize.ts` -> `STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `MIN_BUDGET`, `LIMITS`, `sectionLimits`, `toJevState`; `runtime.ts` -> `RuntimeImpl.situationBudget` | `STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `MIN_BUDGET`, `LIMITS`, `section_limits`, `to_state`, `BUDGETS` |
| questions | `situation/questions.ts` -> `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS`, `PASSIVE`, `ACTION_INSTRUCTIONS`, `DIAGNOSIS_INSTRUCTIONS`, `DEFAULT_DIAGNOSES`, `TRIGGER_DESCRIPTIONS`, `COMPACT_QUESTIONS_BUDGET`, `buildQuestions` | `ACTIONS`, `TRIGGER_ACTIONS`, `ACTION_INSTR`, `DIAG_INSTR`, `DIAGNOSES`, `TRIGGER_DESCRIPTIONS`, `COMPACT_QUESTIONS_MAX` |
| formatters | `util.ts` -> `secs`, `rel`, `fmtNum`, `ratio`, `plural`, `ordinal`, `truncate`, `describe` | `secs`, `rel`, `fmt_num`, `ratio`, `plural`, `ordinal`, `truncate` |
| signatures | `util.ts` -> `normalizePath`, `normalizeFieldPath`, `isIdSegment` | `signature`, `is_id`, `normalize_field_path` |
| redaction | `util.ts` -> `isSensitiveName`, `isSensitivePath`, `defaultRedact` | (none: curriculum values are synthetic) |

4. Mirrors outside the runtime: diagnosis labels (keep `expected` first and `transient` last) in `sim/src/types.ts` -> `DIAGNOSES`, `sim/src/world/scenario.ts` -> `DEFAULT_DIAGNOSES`, `DIAG_PARA`, `sim/src/oracle/diagnose.ts`, `training/curriculum/fmt.py` -> `DIAG_DESC`; action descriptions in `sim/src/run/transform.ts` -> `ACTION_PARA` and `fmt.py` -> `ACTION_DESC` (canonical first). Per-header calibration keys are `sha1(header)[:12]`, so a changed header orphans its `by_header` entry. Budgets: the SIM and realapps `buildScenario` budget weights, `rt.py` `BUDGETS`, `InitOptions.situation` JSDoc, API.md; check token lengths against `meta.max_len` (≈ 2.4 chars/token). Redaction: API.md "Privacy" and CONTRACT (it still documents the old substring rule).
5. Tests (local): `packages/runtime/test/` `situation.test.ts`, `budget.test.ts`, `delivery.test.ts`, `content.test.ts`, `batch3.test.ts`, `invariants.test.ts`, `review-fetch.test.ts`, `review-hub.test.ts`, `review-redaction.test.ts`, `learn.test.ts`, `report.test.ts` / `atoms.test.ts` / `fetch.test.ts` (for `changed` text), then the full suite; `cd sim && SIM_RUNTIME=real npx vitest run` after a runtime build. Update the STATUS.md example blocks from the printed situations.
6. Re-port `training/curriculum/rt.py` ([training.md](training.md#how-to-change-it-safely), "Mirror a runtime situation/question wording change"): diff `git diff situation-v2 HEAD -- packages/runtime/src/situation packages/runtime/src/state/fields.ts packages/runtime/src/util.ts`, update the matching functions, render rows at each budget and compare with SIM rows for the same situations. **[ask first]** `training/tests/test_curriculum.py` with and without `GC_P_RUNTIME=1` (the default run never exercises `rt.py`; `test_runtime_rows_situation_v2` is pure Python and should be renamed or extended for the new tag).
7. Commit, then **the user (or the lead) creates the freeze tag** (`git tag situation-v3 <commit>`; never create or push tags yourself) and records it in HANDOFF, CONTRACT §13 and [model-io-contract.md](model-io-contract.md#versioning-what-invalidates-the-trained-model).
8. **[ask first]** Regenerate SIM data from the tagged runtime (recipe 17): rebuild the runtime and sim `dist/`, rebuild the cluster bundle (`sim/scripts/cluster/bundle.sh`), new seed bases (never reuse a v2 base: gold 11e9, unlabeled 16e9, on-policy 22e9, checks 19e9 are taken), regenerate `sim/samples/*`. SIM rows carry only `meta.runtime: "real"`, not the tag: record the tag per batch in `training/NEEDS.md` and the run name.
9. **[ask first]** Regenerate realapps data from the tagged runtime: `TAG=situation-v3 realapps/scripts/cluster.sh setup <host>` (exports `git archive` of the tag and pins `RW_RUNTIME_SRC`/`RW_RUNTIME_TAG`), rerun the determinism and never-worse sweeps (recipe 28), a pilot plus `realapps/scripts/analyze.py`, then production batches with new seed ranges; fix the hard-coded `runtime` string in `realapps/src/harness/gen.ts` -> `manifest` first. Rows from different tags must never be mixed (filter REAL by `meta.runtime`).
10. **[ask first]** Regenerate a curriculum replay set with the new `rt.py` (`--p-runtime 0.8`, new seed and bucket), then retrain, evaluate, calibrate and export on the new data only (recipe 30), rerun the demos (recipe 22), and release model then runtime (recipes 20, 19). The published runtime and the model it loads must share one tag.

**Gotchas.** `packages/runtime/src/situation/serialize.ts` -> `stateText` (public; `explain()`, devtools, STATUS) indents list items and is not the token text; the packer uses `packages/runtime/src/model/serialize.ts` -> `segmentText`. `COMPACT_BUDGET` (1,100, section sizes) and `COMPACT_QUESTIONS_BUDGET` (1,400, bare labels) are different constants; keep both. Situation building must stay deterministic and side-effect free, or the SIM/realapps prefix checks drop trajectories. Python rows must print integral floats as ints (`fmt.py` -> `js_numbers`) and round half-up like JS. Avoid plugin question ids `action` and `diagnosis`. A runtime fix that is "only a bug fix" (e.g. the F2 redaction leak) is still class A: it is a privacy defect worth shipping, but agree its timing with the user.

**See.** [model-io-contract.md](model-io-contract.md#how-to-change-it-safely), [learn-situation-triage.md](runtime/learn-situation-triage.md#how-to-change-it-safely), [training.md](training.md#how-to-change-it-safely), [sim.md](sim.md#how-to-change-it-safely), [realapps.md](realapps.md#how-to-change-it-safely).

### 7. Change the state pipeline or invariants

**Goal.** Change how writes are proposed, held, applied, patched, filtered or reverted; add an invariant template; change flattening caps; handle dotted store names.

**Steps.**
1. **Know the two paths** (`packages/runtime/src/state/hub.ts` -> `StoreHub.propose`):
   - **Default (`policy.holdWrites: false`):** every write commits synchronously in the caller's stack; a salient write that no delivery decision covers raises a non-holdable `mutation` trigger (`RuntimeImpl.observeWrite`, `covered`), and a gate-passing `discard` becomes a late revert (`StoreHub.revertable`, `LATE_REVERT_MS`). A delivery `discard` mark filters the chain's later writes (`StoreHub.applyFilter` via `RuntimeImpl.dropFilter`).
   - **Opt-in (`holdWrites: true`):** the `bypass` expression (user-sync writes unless `holdUserWrites`, GenClass writes, stores with `hold: false`, not gating) and `hooks.mayHold`; held writes go through `gateAndQueue` / `RuntimeImpl.gateMutation`; any write that applies at once first calls `flushQueue`, so a hold never reorders a store's writes (the old `demos/NEEDS.md` §1 jump-back is fixed).
   Keep "apply in the caller's stack, in order; observation never throws into the write" for the default path. These rules are policy-visible: update `docs/runtime/API.md` "State".
2. **Adapter stores:** `applyFilter` cannot drop individual fields of a redux/zustand whole-state write, so a delivery `discard` there is a silent no-op that is still recorded as a drop (open finding, [state-and-adapters.md](runtime/state-and-adapters.md#drift-and-open-issues)). A fix applies kept changes through the store's `io.set` or reports the drop honestly; it changes `changed` text (class A) and SIM/realapps labels for redux/zustand apps.
3. **Invariant template:** `packages/runtime/src/state/invariants.ts` -> extend `Tpl`, implement it in `InvariantMiner.holds` (null when not applicable), `nonTrivial`, `valuesText` and `propose` with a deterministic id and readable text; put per-array work in `ArrayStats`.
4. **Flattening caps or hashing:** `packages/runtime/src/state/fields.ts` -> `MAX_DEPTH`, `MAX_KEYS_EXPAND`, `MAX_FIELDS_PER_STORE`.
5. **Patch semantics:** `packages/runtime/src/state/fields.ts` -> `patchValue`; keep "removals first; never remove a path with a set beneath it".
6. **Dotted store names:** nothing enforces "no `.` in store names", and every path lookup splits on `.`. Either validate in `RuntimeImpl.atom` / `guard` / `adapter` (prefer a console warning and a sanitised name; throwing breaks apps) or pass the store explicitly. Fix the `packages/runtime/README.md` and `packages/runtime/src/adapters/react.ts` header examples (`"search.results"`).
7. **Settled points and snapshots:** `RuntimeImpl.settled`, `RuntimeImpl.busy`.

**Tests.** `packages/runtime/test/`: `atoms.test.ts`, `delivery.test.ts`, `no-reorder.test.ts`, `default-mode.test.ts`, `content.test.ts`, `review-hub.test.ts`, `invariants.test.ts`, `adapter-seam.test.ts`, `adapters-react.test.ts`, `adapters-redux.test.ts`, `adapters-zustand.test.ts`, `review-precision.test.ts`, `situation.test.ts`, `batch3.test.ts`, then `review-perf.test.ts` alone, then the full suite. A new template needs a learning test and a precision test (no false `inconsistency` on benign behaviour).

**Parity / retrain / release.** Template text, flattening and `changeText` output appear verbatim in situations: class A. Bypass/hold/filter changes change no text but change SIM and realapps dynamics (class B): tell SIM and REAL. Any default-path change: never-worse sweep (recipe 28) **[ask first]**.

**Gotchas.** `review-perf.test.ts` asserts wall-clock budgets on 5,000-item stores; any O(n) per-write work breaks them, and they can flake on a loaded machine (CI retries them twice). Updaters may run several times and must be pure. Read-your-writes (`StoreHub.pendingView`) reaches only the runtime's own `get()`, not `store.getState()` of a library. A held write applied early by `flushQueue` must not be reopened by a late verdict (`gateAndQueue`).

**See.** [state-and-adapters.md](runtime/state-and-adapters.md#how-to-change-it-safely).

### 8. Add or change a framework adapter

**Goal.** Integrate another state library (MobX, Jotai, Valtio, …) through `runtime.adapter`, or change the React, Redux or Zustand adapter.

**Steps.**
1. Add `packages/runtime/src/adapters/<lib>.ts`. Call `runtime.adapter(name, { get, set?, subscribe? }, opts)` once per store (`packages/runtime/src/types.ts` -> `Runtime.adapter`, `AdapterIO`, `AdapterHandle`).
2. Route every app write through `handle.propose({ fn | value, commit })`. `commit(next)` must write to the library store synchronously; on the default path it runs at once, under `holdWrites` later for held writes and never for discarded ones. Provide `set` if GenClass may write whole states (rollback, resync, a field-precise discard); without it the store is not writable.
3. Build and package: `packages/runtime/tsup.config.ts` -> `entry` and `dts.entry` (keep the literal `"src/...ts"` strings: `packages/runtime/test/browser/build.mjs` finds them with a regex), the library in `external`; `packages/runtime/package.json` -> an `exports` subpath (`types` + `import`), an optional `peerDependencies` entry plus `peerDependenciesMeta`, and the library as a devDependency (then `npm install` at the root and commit the lockfile).
4. If the demos use it: a shim in `demos/src/dev/runtime-shim/`, an alias in `demos/vite.config.ts`, a path in `demos/tsconfig.shim.json`. If realapps should cover it: an alias in `realapps/build.mjs` and an app (recipe 29).
5. Changing an existing adapter: keep its contracts (commit exactly once on apply, never on discard; Redux reducer once per applied dispatch and inner enhancers see the original action; Zustand commits with `replace = true` and forwards extra `set()` arguments; React: one atom per (runtime, name), plain `useState` fallback without a runtime). Update the file's header comment and API.md "Adapters and devtools".

**Tests.** Model the new file on `packages/runtime/test/adapters-zustand.test.ts`: `MockRuntime` plus one test against the real runtime with `ManualDecider`. Run `adapter-seam.test.ts`, the `adapters-*.test.ts` files, `no-reorder.test.ts` and `review-perf.test.ts`. Build. **[ask first]** `cd packages/runtime && bash test/smoke/smoke.sh` after adding an import of the new subpath to the `src/main.js` that `smoke.sh` generates.

**Parity / retrain / release.** Class E. A new subpath is a public-surface change: API.md, the package README, the "Extra public surface" bullet under STATUS "Deviations from the contract (and why)".

**Gotchas.** Redux and Zustand capture `runtime` when the store is created, so `genclass(GenClass.runtime, …)` evaluated before `GenClass.init()` gets `null` and is never guarded. Store names are global per runtime across kinds. A library listener that throws inside `commit` looks like a failed setter.

**See.** [state-and-adapters.md](runtime/state-and-adapters.md#how-to-change-it-safely), [build-test-release.md](runtime/build-test-release.md#add-a-public-entry-point-new-subpath-export).

### 9. Add a public API method, option, event or subpath export

**Goal.** Extend the public surface of `@genclass/runtime`.

**Steps.**
1. **Init option:** add the field with a JSDoc default to `packages/runtime/src/types.ts` -> `InitOptions` (or `CreateOptions` if headless-only); read it once in the `RuntimeImpl` constructor with an explicit default; check the creation paths in `packages/runtime/src/index.ts` -> `initUnsafe` (browser, non-browser, kill-switch `off`) and the `GenClass.init` fallback. Host-only model options: recipe 12.
2. **`Runtime` method:** add it to `packages/runtime/src/types.ts` -> `Runtime` and implement it in `packages/runtime/src/runtime.ts` -> `RuntimeImpl`. Update every other implementer by hand: `packages/runtime/test/browser/ui/mock-runtime.ts` -> `MockRuntime` and `demos/src/dev/runtime-shim/index.ts` -> `ShimRuntime`. Add it to `sim/src/run/rt.ts` -> `RuntimeLike` only if the sim calls it. Keep it non-throwing if devtools will call it.
3. **Changing an existing method or option:** find callers outside `src/`: the sim (loaded by module name via `GENCLASS_RUNTIME`, so a break shows only at sim run time), realapps (bundled from source; `realapps/src/world/{index,probe}.ts`, `apps/_shared/*`), `MockRuntime`, `ShimRuntime`, `packages/runtime/src/devtools/index.ts`, `packages/runtime/src/adapters/react.ts`.
4. **Event type:** add the key and payload to `packages/runtime/src/types.ts` -> `RuntimeEvents`, add a `Set` for it in `RuntimeImpl`'s `listeners` initializer (otherwise `on(newType)` throws), fire it with `RuntimeImpl.fire`. Update `packages/runtime/src/devtools/index.ts` -> `subscribe` if the overlay should react.
5. **Error class:** runtime-level errors in `packages/runtime/src/errors.ts`; model errors in recipe 12. Re-export from `packages/runtime/src/index.ts`.
6. **Subpath export:** `packages/runtime/package.json` -> `exports`, `packages/runtime/tsup.config.ts` -> `entry` and `dts.entry`, externalise any new peer library; demos shim and aliases if demos use it (recipe 8 step 4).
7. Time-dependent behaviour uses `this.clock.now()` / `this.clock.setTimeout` / `this.clock.afterTask`; store the handle and clear it in `RuntimeImpl.destroy`.
8. **Kill switch or init paths:** `packages/runtime/src/index.ts` -> `killSwitch`, `initUnsafe`; keep everything inside the try/catch of `GenClass.init`. `RuntimeImpl.destroy` must stay idempotent, clear every new timer, uninstall observers in reverse order, dispose only a decider it created, and leave no active `discardMark` behind (open finding).
9. Docs: JSDoc in `packages/runtime/src/types.ts`, `docs/runtime/API.md`, `packages/runtime/README.md`, `packages/runtime/STATUS.md`, [public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md).

**Tests.** A test using `setup({ ...option })` from `packages/runtime/test/helpers.ts` (note: it defaults `mode: "guard"`; use `GenClass.init` or pass no mode in a `createRuntime` call to test the real default, as `default-mode.test.ts` does). Lifecycle changes: `report.test.ts`, `batch3.test.ts`, `dom.test.ts` / `fetch.test.ts` / `xhr.test.ts`, `review-misc.test.ts`, `smoke.test.ts`. Build for export changes; **[ask first]** `bash test/smoke/smoke.sh`.

**Parity / retrain / release.** Only if the option alters situation text or decisions: then coordinate with SIM and REAL (`createOptions`, `realapps/src/world/index.ts`) and treat it as class A/B. Public-surface changes go into the next release notes (recipe 19).

**Gotchas.** `GenClass.init` is idempotent: later calls ignore their options. `createRuntime` can throw on malformed options; `GenClass.init` never does (inert fallback). Any non-`undefined` `decider` (including `null`) disables model creation. `on("status")` also fires on `setMode`.

**See.** [public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md#how-to-change-it-safely), [build-test-release.md](runtime/build-test-release.md#add-a-public-entry-point-new-subpath-export).

### 10. Add a custom action, standing question or plugin (app side)

**Goal.** Extend GenClass from application code, without changing the runtime: an app capability the model may choose, an extra question per trigger, extra facts or an app-specific signal source.

**Steps.**
1. Write a `Plugin` (`packages/runtime/src/types.ts` -> `Plugin`: `name`, `setup?(api)`, `facts?(sit)`, `actions?`, `questions?`, `diagnoses?`) and pass it as `GenClass.init({ plugins: [p] })` or `rt.use(p)`. Single pieces: `rt.action(def)`, `rt.question(def)`. Reference app: `demos/src/demos/decisions/plugin.ts` -> `backgroundWorkPlugin`.
2. **Custom action** (`ActionDef`): `name`, `description` (the model reads it), `on: TriggerKind[]`, `tier` (default `"heal"`), optional `applicable(sit)`, `run(ctx)`. In `run`, call `ctx.describe(changed)` with exactly what changed, `ctx.onUndo(fn)` if reversible, and `ctx.builtin("<name>")` to delegate to a built-in. Nothing runs in the default `observe` mode: the app must opt in to `guard` (guard-tier custom actions) or `heal`.
3. **Standing question** (`StandingQuestion`): `id`, `on`, `question` (`{ type: "noul" | "choice" | "score", instructions, criteria }`), `always?`, `onAnswer(answer, ctx)`. A standing question on `delivery` is answered only when the delivery is held; in observe mode the background delivery decision is dropped and `onAnswer` never runs (open finding).
4. **Facts and signals:** `facts(sit)` returns strings (always neutral, ranked last, cut first by the budget). In `setup(api)`, use `api.clock`, `api.emit`, `api.recordOp` / `api.endOp` / `api.runInOp`, and return a cleanup function.
5. One-off questions: `rt.ask(question, { about, timeoutMs })` and `rt.decide(question, options)`.
6. Changing the plugin API itself (CORE): `packages/runtime/src/runtime.ts` -> `RuntimeImpl.runCustom`, `action`, `question`, `use`, `pluginApi`; offering in `packages/runtime/src/situation/build.ts` -> `buildSituation`. Tests: `plugins.test.ts`, `ask.test.ts`, `batch3.test.ts`, `review-misc.test.ts`.

**Tests.** Pattern: `packages/runtime/test/plugins.test.ts`. In an app, verify with `rt.explain(id)` and the devtools overlay.

**Parity / retrain / release.** No retrain is needed: the model reads the description at runtime. Answer quality on custom actions and questions is unmeasured, and no v2 model exists yet.

**Gotchas.** Custom actions are gated at their own tier. At budgets ≤ 1,400 characters (`COMPACT_QUESTIONS_BUDGET`), custom descriptions are sent as `null` unless a `vocabulary.actions` override of ≤ 24 characters exists. Avoid question ids `action` and `diagnosis`. A non-iterable `plugins`, `actions` or `questions` throws inside the constructor (`GenClass.init` then returns an inert runtime). Custom actions can hold a subject indefinitely.

**See.** [decide-policy-actions.md](runtime/decide-policy-actions.md), [public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md), [`docs/runtime/API.md`](../runtime/API.md) "Plugins".

### 11. Add or change a devtools view

**Goal.** Change the overlay (`@genclass/runtime/devtools`): add a tab, show a new `Decision` / `ActionRecord` field, change report wording, add a mount option, change styling.

**Steps.**
1. **New tab:** `packages/runtime/src/devtools/index.ts` -> extend `DevtoolsTab` and `TABS` (keep `interventions` and `detections` first: the counters read `tabBtns[0]` and `tabBtns[1]`), add a pane in the constructor's `panes` record. If it polls the runtime, gate it like `renderNow` and refresh it from `startTicking`. Widen the `tab` union in `demos/src/dev/runtime-shim/devtools.ts`.
2. **Mode labels:** f3636b2 relabelled the mode control "Observe (default)" / "Guard (opt-in)" / "Heal (experimental)" in `packages/runtime/src/devtools/index.ts`; keep them in sync with the runtime default.
3. **New field on cards or evidence:** render it in `card()` or `evidence()` with `h()` and `text` (no `innerHTML`). Add the field to `makeDecision` / `makeAction` in `packages/runtime/test/browser/ui/mock-runtime.ts` and set it in `packages/runtime/test/browser/ui/scenario.ts`.
4. **Mount option:** `DevtoolsOptions` with a JSDoc default, read in the `Devtools` constructor; mirror it in `demos/src/dev/runtime-shim/devtools.ts`.
5. **Report wording:** runtime sentences come from `packages/runtime/src/decide/report.ts` -> `interventionLine`, `detectionLine`. Keep `packages/runtime/src/devtools/ui.ts` -> `splitReport` regexes able to strip the `[GenClass]` prefix, the `(diag, p; action p)` tail, `Not acted on (…): …` and the `(×N …)` suffix; keep `ui.ts` -> `LEAD` / `NOUN` aligned (including the `delivery` noun).
6. **Activity kinds and filters:** `packages/runtime/src/devtools/ui.ts` -> `KIND_LABEL`, `OP_LABEL`, `eventText`, `groupOf`; `packages/runtime/src/devtools/index.ts` -> `FILTERS`; badge rules in `packages/runtime/src/devtools/css.ts`.
7. **Styling:** edit `packages/runtime/src/devtools/css.ts` only; add tokens to both `LIGHT` and `DARK`; never add selectors for `html`, `body` or `:root`.
8. **New runtime event:** `packages/runtime/src/types.ts` -> `RuntimeEvents` (CORE), then `packages/runtime/src/devtools/index.ts` -> `subscribe` through the local `on()` wrapper.
9. **Cards recorded before mount** (`packages/runtime/UI-NEEDS.md` item 3): fall back to `this.rt.explain(id)?.message` inside `safe()`; update the matching assertions in `devtools.test.ts` and `devtools-runtime.test.ts`.

**Tests.** `packages/runtime/test/`: `devtools.test.ts` (against `MockRuntime` + `loadScenario`) and `devtools-runtime.test.ts` (real runtime via `runStoreSession`, which passes an explicit `mode: "guard"`). **[ask first]** `npx playwright test --config test/browser/ui/playwright.config.ts` from `packages/runtime` regenerates the PNGs in `test/browser/ui/screenshots/` (written, never compared); commit them only if intended.

**Parity / retrain / release.** Class E, unless the field comes from a CORE change that alters situations.

**Gotchas.** The overlay uses only the public `Runtime` API. Tests are not type-checked, so `MockRuntime` drifts silently. `npm run test:browser` also runs the UI spec with different viewport settings and overwrites the screenshots: use the UI config.

**See.** [devtools.md](runtime/devtools.md#how-to-change-it-safely).

## Recipes: model host and parity

### 12. Change model loading or backends

**Goal.** Change how the model is fetched, cached, verified or run: host options, WebGPU/WASM plan order, worker protocol, model errors, onnxruntime-web version, the `genclass-runtime` CLI, or self-hosting.

**Steps.**
1. **Host option:** `packages/runtime/src/model/host.ts` -> `ModelHostOptions`; if it must reach the worker, also `packages/runtime/src/model/backend.ts` -> `BackendLoadOptions` (structured-cloneable values only) and the `Host` constructor's `loadOptions`; if apps set it through `GenClass.init`, also `packages/runtime/src/types.ts` -> `ModelOptions` and API.md.
2. **Plan order or device semantics:** `packages/runtime/src/model/loader.ts` -> `planOrder`. Keep `wasm` as the last plan for `"webgpu"`. The device also sets the auto situation budget (`RuntimeImpl.situationBudget`).
3. **Worker protocol message:** `packages/runtime/src/model/protocol.ts`, the switch in `packages/runtime/src/model/worker.ts`, `packages/runtime/src/model/host.ts` -> `InlineTransport` (keep both transports identical) and the host's message handler. Every request gets exactly one `result`.
4. **Model error:** `packages/runtime/src/model/errors.ts` -> `ModelErrorCode`, the class, the `deserializeError` switch; re-export from `packages/runtime/src/index.ts` and `packages/runtime/src/model/index.ts`. Special runtime handling: the `max_tokens_exceeded` handler in the `RuntimeImpl` constructor (shrinks `budgetScale`).
5. **New graph input or head:** `packages/runtime/src/model/engine.ts` -> `FEEDS`, `OUTPUT_KIND`; `packages/runtime/src/model/packer.ts` -> `planInputs`, `unpackLogits`; `packages/runtime/src/model/serialize.ts` -> `BlockKind`, `questionBlock`; `packages/runtime/src/model/calibrate.ts`; the `Question` / `Answer` types in `packages/runtime/src/types.ts`. This is also a training change (recipe 13).
6. **onnxruntime-web upgrade:** `packages/runtime/package.json` (`^1.30.0`; update the lockfile), `packages/runtime/src/model/backend.ts` -> `ORT_FALLBACK_VERSION`, check `ORT_WASM_FILES` names exist in the new `dist/`, keep the externals, update the browser-test regex expecting `onnxruntime-web@1.30.x` and the pinned `onnxruntime-node` devDependency (CI skips its binary download with `ONNXRUNTIME_NODE_INSTALL=skip`).
7. **CLI:** `packages/runtime/bin/genclass-runtime.mjs` (`fetch-model`, `info`; committed as 100755); keep its `parseCard` in sync with `packages/runtime/src/model/loader.ts` -> `parseCard`. No automated CLI tests.
8. **Default model URL:** `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` and the CLI's `DEFAULT_FROM` (recipe 20). Both 404 today.
9. **Self-hosting (app integration):** `npx genclass-runtime fetch-model public/genclass-model --from <dir URL with model.json>` **[ask first]** (download); copy both `ort-wasm-simd-threaded.wasm` and `ort-wasm-simd-threaded.asyncify.wasm` from `node_modules/onnxruntime-web/dist/`; `GenClass.init({ mode: "guard", model: { baseUrl: "/genclass-model/", ortWasmPaths: "/ort/" } })`; serve COOP/COEP for WASM threads. There is no situation-v2 model to self-host yet: the round-1 R17 export reads v1 text and must not be loaded into this runtime.

**Tests.** Local, no model files needed: `packages/runtime/test/model/`: `host.test.ts`, `loader.test.ts`, the `engine.test.ts` graph-contract test. **[ask first]** `npm run test:browser` (needs a model directory and Playwright Chromium; rebuilds `dist/`).

**Parity / retrain / release.** Loading and transport changes are class E. Graph inputs and heads require a new export and retraining.

**Gotchas.** `evaluate()` never waits: before `ready` it rejects at once with `ModelNotReadyError`, and while the host is `loading` or `error` the runtime builds no situations. Keep `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` and the two `import("onnxruntime-web/webgpu")` / `import("onnxruntime-web/wasm")` literals verbatim. Downloads use the native fetch, never the instrumented one. One inference at a time; no watchdog.

**See.** [model-host.md](runtime/model-host.md#how-to-change-it-safely).

### 13. Change the packer, tokenizer, serializer or calibration

**Goal.** Change how a situation becomes token ids or how logits become calibrated answers. These TypeScript files are byte-exact ports of Python in `jev_local/`, unchanged since `situation-v1`.

**Steps.**
1. Get the user's go-ahead (class C or D; class C requires retraining when the Python side changes).
2. Change both sides in the same change: `packages/runtime/src/model/{serialize,pyutil,tokenizer,packer}.ts` with `jev_local/serialize.py` and `jev_local/engine/encoder/tokenize_pack.py`; `packages/runtime/src/model/calibrate.ts` with `jev_local/engine/encoder/calibrate.py` and `jev_local/confidence.py`.
3. Keep v1 calibration files loadable; keep the documented Jev answer rows within ±0.01.
4. Regenerate the fixtures (recipe 14) and, for a token-id change, re-export a model so the export's own fixtures and `parity.json` reflect the new layout.
5. Recalibration only: `$PY training/eval_runtime.py --ckpt … --data … --fit-split dev --write-calibration cal.json`, then `$PY training/export_runtime.py … --calibration cal.json` **[ask first]** (recipe 18).

**Tests.** Local (fixtures committed): `packages/runtime/test/model/` `serialize.test.ts`, `calibrate.test.ts` (7 of 8 run without model files); `packer.test.ts` and `engine.test.ts` parity need a model directory **[ask first]**. Python: `tests/test_encoder_pack.py`, `test_encoder_model.py`, `test_encoder_engine.py`, `test_serialize_w8.py`, `test_confidence.py`, `test_train_v2_engine.py` **[ask first]**.

**Parity / retrain / release.** Token-id changes invalidate trained weights: retrain and re-export, new freeze. Calibration changes alter intervention rates: re-run `training/eval_runtime.py` and compare FIR/precision before shipping.

**Gotchas.** JavaScript cannot print `25.0`; Python-generated rows must write integral floats as ints. Marker, CLS and SEP ids come from `meta.json` / `tokenizer.json`; keep it that way. The runtime bounds state + longest branch (`meta.max_len`), the trainer bounds the whole question block.

**See.** [model-host.md](runtime/model-host.md#how-to-change-it-safely), [model-io-contract.md](model-io-contract.md#invariants-and-gotchas), [genclass-model-lineage.md](genclass-model-lineage.md#how-to-change-it-safely).

### 14. Regenerate model parity fixtures

**Goal.** Refresh the Python-generated fixtures that pin the TypeScript model code to the Python reference.

**Steps.**
1. **`py_fixtures.json`** **[ask first]**: needs the jev venv (`tokenizers`, `numpy`, `pydantic`) and the v0.1 tokenizer: `~/jev/.venv/bin/python packages/runtime/test/fixtures/model/make_py_fixtures.py --tokenizer <model dir>/tokenizer.json --out packages/runtime/test/fixtures/model/py_fixtures.json`. It imports `jev_local` from the repo root; do not move it.
2. **`pack_fixtures.json` / `torch_fixtures.json`** are outputs of a v1 exporter (`scripts/genclass_export.py` or `extension/tools/genclass_export.py`) **[ask first]**, re-serialised compactly. Never hand-edit them. Regenerate `requests50.json` from the same request set.
3. **An export's own fixtures:** `training/export_runtime.py` writes `requests.json`, `pack_fixtures.json`, `torch_fixtures.json` and `parity.json` into the model directory; `packages/runtime/test/model/helpers.ts` uses them automatically when all three exist (`FIXTURES_FROM_MODEL`). This is how a v2 export will be checked.
4. **WebGPU embedding variants** **[ask first]**: `make_webgpu_variants.py --src <q8 model dir> --out <dir>`.

**Tests.** `packages/runtime/test/model/` with `GENCLASS_MODEL_DIR` **[ask first]**.

**Parity / retrain / release.** Fixtures only document parity; regenerating them never fixes a parity break.

**Gotchas.** The committed fixture JSON files are single-line; compare parsed JSON, not hashes. The browser specs always read the v0.1 fixtures, so their parity assertions only hold for the v0.1 model. `pythonOnlyFloatRequests` needs Node ≥ 21.

**See.** [build-test-release.md](runtime/build-test-release.md#regenerate-model-fixtures).

## Recipes: sim

Sim typecheck and `SIM_RUNTIME=real npx vitest run` are light local checks (build the runtime first). Everything that generates data is **[ask first]**, and cluster runs are operated by the colleague. Check-out sequence after a sim change: `npm run build -w @genclass/runtime`, then in `sim/`: `npx tsc -p tsconfig.json --noEmit`, `SIM_RUNTIME=real npx vitest run`, `npx tsup`; then **[ask first]** `node dist/smoke.js --seeds 40` (check `internal errors` and correlation `*:none` counts), a small `gen.js` run and `python3 scripts/analyze.py <out>`.

### 15. Add a sim feature module

**Goal.** Add a feature combinator (a new kind of app behaviour with guards or injected defects), a domain, or a knob on an existing feature.

**Steps.**
1. New `sim/src/app/features/<kind>.ts` exporting a `FeatureDef` (`sim/src/app/feature.ts`); register it in `sim/src/app/features/index.ts` -> `FEATURES` and `FEATURE_WEIGHTS` (46 features at b435acb).
2. Server routes via `srv.route(...)`. Client state via `env.store(...)`. Requests only via `kit.op` + `kit.call` (an `anomaly` on the op reaches the oracle); writes only via `kit.write` with `role`, `intent`, `key`, `op` (`sim/src/app/kit.ts`). Use `env.clientNow()`, `env.online`, `env.on(...)`, `env.channel(...)`, `env.busy(ms)` and `world.otherTab` instead of globals; declare `env()` for offline windows, socket drops and skew; honour `ctx.clean`.
3. Ground truth: `dupOf` for accidental repeats, `anomaly: "partial"` on writes that skip derived fields, `classify` where bookkeeping decides stale/conflict/duplicate; `relations()`; surface failures with `kit.shownError()` or `kit.spawn(fn, "uncaught", …)`.
4. New data roles go into `sim/src/oracle/diagnose.ts` -> `DATA_ROLES`. Consider `TEST_PATTERNS` or `TEST_FEATURES` in `sim/src/world/scenario.ts`.
5. Randomness only from the spec rng in `make`, `user.rng` in `session`, and keyed `env.rng.fork(<key>)` at run time. For a knob on an existing feature, append the draw at the end of `make()`.
6. Domain: append to `sim/src/app/vocab2.ts` (keep `vocab.ts` stable); optionally hold it out in `TEST_DOMAINS`.

**Tests.** `sim/test/oracle.test.ts` cases via `mini(kind, patch, opts)` from `sim/test/helpers.ts`; `rows.test.ts`, `determinism.test.ts`, `latent.test.ts` with `SIM_RUNTIME=real` (local). Check `smoke.js --profile` cost **[ask first]**.

**Parity / retrain / release.** Every seed's world changes (keyed picks depend on array lengths): regenerate all data and `sim/samples/*`; never mix rows from different sim versions under one seed range.

**Gotchas.** Error-message fields must have weight 0. The ideal run has no runtime and skips accidental steps, so `dupOf` / `accidental` must be right.

**See.** [sim.md](sim.md#how-to-change-it-safely).

### 16. Change sim oracle, labelling, ask questions or splits

**Goal.** Change how rows are labelled (cost weights, label parameters, diagnosis rules, S1, S2), add an `ask` question generator, change chaos, budgets or splits.

**Steps.**
1. **Cost weights:** `sim/src/oracle/cost.ts` -> `W`; update `sim/test/oracle.test.ts` and the README formula; regenerate data. realapps imports `W` and the label rule, so its labels change too: tell REAL.
2. **Label parameters only:** `sim/src/oracle/cost.ts` -> `LABEL`; re-derivable offline from `meta.cost_futures` with `sim/scripts/relabel.py` (re-apply `drop:<action>` transforms) or `training/t1_relabel.py`.
3. **Diagnosis or S1 rules:** `sim/src/oracle/diagnose.ts` -> `diagnose`, `diagnoseFailure`; `sim/src/gen/trajectory.ts` -> `diagnosisFromOutcome`, `S1_GAP`; or a feature's `classify`. Affects exploration, point sampling and `fake_diagnosis`. Update the S1 assertion in `rows.test.ts`. Unlabeled rows (`unlabeledTrajectory`) hard-label `expected` diagnoses that S1 would relabel on gold rows (open finding): fix it here or drop those labels at import (recipe 30).
4. **S2 latent re-draws:** `sim/src/run/latent.ts` (`futureProfile`, `futureStepTimes`, `idealRepeatSkips`, `REPEAT_PRIOR`). Keep every draw keyed and ideal-mode draw counts stable; run `latent.test.ts` and `determinism.test.ts`.
5. **Ask questions:** a generator in `sim/src/ask/questions.ts` -> `GENS`; check the evidence appears in the serialised state and skip borderline timings. realapps reuses these generators.
6. **Chaos and network:** `sim/src/world/scenario.ts` -> `makeNet`, `sim/src/net/network.ts` -> `Network`; keep `NetEntry.cause` accurate.
7. **Budgets:** `buildScenario` budget weights (still `[[3200, 40], [2000, 30], [1000, 30]]`, the v1 device budgets; production auto budgets are 2,400 / 2,000…1,000 and `rt.py` `BUDGETS` uses them). Changing them is class B (recipe 6); keep realapps' copy in `realapps/src/harness/scenario.ts` in step.
8. **Splits:** `TEST_DOMAINS`, `TEST_PATTERNS`, `TEST_FEATURES`, `familyHeldOut`, `splitOf` and their salts. Old datasets become incomparable.
9. **Runtime contract** (option names, thresholds, hooks): `sim/src/run/rt.ts` -> `createOptions`, `RuntimeLike`, and `sim/src/types.ts`.

**Tests.** `sim/test/oracle.test.ts`, `rows.test.ts`, `latent.test.ts`, `determinism.test.ts`, `loop.test.ts` with `SIM_RUNTIME=real` (local).

**Parity / retrain / release.** Labels and targets change: regenerate data and retrain. Gate thresholds in `createOptions` stay 0.5 with `requireDiagnosis: false`.

**Gotchas.** `x-request-id` must stay volatile in the runtime and never appear in a state. Correlation is synchronous: the runtime's `opCreated` / `mutationProposed` hooks must fire inside the sim's calls. `delivery` diagnoses are the verdict of the first write the delivered op/message makes.

**See.** [sim.md](sim.md#how-to-change-it-safely), [model-io-contract.md](model-io-contract.md).

### 17. Generate a SIM data set

**Goal.** Produce CONTRACT-D rows (`{ id, split, family, state, questions, labels, meta }`) from the sim: gold (counterfactual labels), unlabeled (base runs; teacher labels later) or on-policy (DAgger). **[ask first]** for every step; large runs are Azure work operated by the colleague.

**Steps.**
1. Build the runtime from the frozen tag, then the sim: `npm run build -w @genclass/runtime`, `cd sim && npx tsup`. A stale `dist/` silently produces old text.
2. Samples: `node dist/gen.js --sample --workers 8` writes `sim/samples/sample.jsonl`, `EXAMPLES.md` and `sample-stats.json`.
3. A local run: `node dist/gen.js --rows <N> --out <dir> --seed <S> --workers <W> [--unlabeled | --on-policy <export dir>]` (other flags: `--max-points`, `--test-keep`, `--explore`, `--no-ask`, `--parts`, `--chunk`, `--merge-only`; `--allow-fake` only for tests). Output: `<dir>/{train,dev,test}.jsonl` + `stats.json`.
4. Cluster runs (v2; [sim.md](sim.md#9-cluster-runs-simscriptscluster)): `sim/scripts/cluster/bundle.sh` on the train VM, then from the colleague's Mac `bigrun.sh gold RUN ROWS NODES…` (seed base 11e9) and `bigrun.sh unl RUN ROWS NODES…` (16e9), or `orchestrate.sh run RUN onpolicy:<model dir on the node> ROWS nodes…` with `SEED_BASE=22000000000`; each node `cNN` gets base + NN × 1e8. Collect with `python3 sim/scripts/cluster/collect.py RUN OUTDIR HOST…` (dedupe, test-first, gz shards ≤ 500k rows + `manifest.json`). Deallocate each node when its share is collected.
5. Summarise: `python3 sim/scripts/analyze.py <dir>`. Record location, rows per split, row type, runtime tag and held-out lists in `training/NEEDS.md` (item 11).
6. v1 history only: `sim/scripts/final.sh a|b|merge-b` built phase A/B on `situation-v1`; do not reuse it for v2.

**Tests.** `stats.json`: drops (expect `info:latent-fallback` and a few `diagnosis-not-in-vocab`), 0 internal errors, `subject_correlated` 100%, passive-best shares per trigger comparable with the previous batch.

**Parity / retrain / release.** Data from a runtime whose situation code differs from the model's training data is not comparable. SIM rows do not carry the runtime tag (`meta.runtime` is `"real"`): keep tag-specific run names and seed bases.

**Gotchas.** `gen.js` deletes `<out>/shards` at start in every mode. `sim`'s `build:runtime-core` writes only `dist/index.js` and does not clean; prefer the full runtime build. On-policy runs pin `mode: "heal"` (`createOptions`), not the shipped `observe` or the target `guard` (open finding). The trainer's stream reader reads `*.jsonl` and `*.jsonl.zst`, not the collected `.jsonl.gz` shards (recipe 30).

**See.** [sim.md](sim.md#how-to-change-it-safely), [training.md](training.md).

## Recipes: training

### 18. Train, evaluate and export a model (mechanics)

**Goal.** The generic mechanics behind recipe 30: produce a model directory the runtime can load (card `genclass-runtime-model/1`: `model.json`, `<name>-q8.onnx`, `<name>-fp16.onnx`, `tokenizer.json`, `calibration.json`, `meta.json`, parity fixtures). Everything here runs on Azure VMs and costs money: **[ask first]** for every step.

**Steps.**
1. Read `training/LOG.md`, `training/EVAL.md`, `training/NEEDS.md`, `training/PLAN-v1.md`. Script layout: `training/*.sh` resolve `JEV="$HERE/../.."` and expect `jev_local/`, `scripts/` and `pyproject.toml` there; in this monorepo they are one level up ([training.md](training.md#invariants-and-gotchas)).
2. Sync code: `training/node.sh HOST sync`. `$PY` is `~/jev/.venv/bin/python` on the nodes; `G=/home/azureuser/gcl-train`.
3. **Curriculum** (if needed): `$PY training/curriculum/generate.py --out <dir> --n <N> --seed <new seed> --workers <W> --p-runtime 0.8`; shard train (`split -n l/64 -d -a 2 --additional-suffix=.jsonl train.jsonl <root>/<bucket>/shard`); check `stats.json` (`bad`, `errors` 0, sane `passive_best_fraction`).
4. **Mixture and launch:** copy a `training/configs/mix_*.json` (keys must be `MixConfig` fields; list `buckets` explicitly), then `training/launch_student.sh RUN ARCH PASSES MIX "nodes" [INIT] [-- extra]` (ARCH `r17` / `r32` / `r68` / `t150`; 8 ranks × 10 threads per F80; rank 0 and master = the first node, which must hold `INIT`). Check `mixture_plan.json`: missing buckets are dropped silently.
5. **Evaluate and calibrate:** `bash training/eval_sim.sh <EVALSET> <M>` on the workbench (sharded logits over `data/<EVALSET>_t*`, `_d*`; dev-fitted temperatures to `out/cal/<M>-<EVALSET>.json`); tables with `$PY training/report.py M=<json> --mode=kind`. Delete `out/records/<M>__*` first if `models/<M>` changed (the cache is keyed by name only).
6. **Export:** `$PY training/export_runtime.py --ckpt models/M --out out/export-M --name genclass-runtime-r17 --version X.Y.Z --calibration <cal.json> --data-rows <dev jsonl list> --n-per-file 60`. Without `--calibration` the export ships all-1.0 temperatures.
7. **Validate:** `node validate.mjs <export dir> q8 120` in a directory with `training/ortweb/package.json` installed; check `parity.json` (q8 argmax agreement, `embedding_q8.fp16_free: true`, q8 ≤ 25 MB per CONTRACT §10) and `ortweb_report_q8.json` (no pass/fail: read `argmax_agree`, `max_abs_logit`, `error`). Deliver with `pull_on_train.sh` / `deliver_final.sh` (sha256 against `model.json`).
8. **Runtime parity:** `cd packages/runtime && GENCLASS_MODEL_DIR=<export dir> npx vitest run test/model` (uses the export's own fixtures); then the browser specs **[ask first]**.
9. **New curriculum scenario case:** add it to the builder's `rng.choices` list in `training/curriculum/scenarios.py`, `scen_ops.py` or `scen_state.py`, with ≥ 4 phrasings, labels leaning passive when ambiguous, primitives and a `spec` that `rt.py` can render (or `no_runtime: True`). Keep the passive-best share within 0.45–0.75. Use dotted field paths (`mut_live` still builds bracket paths the runtime never produces).

**Tests.** `training/tests/test_curriculum.py` (with and without `GC_P_RUNTIME=1`), `test_export_runtime.py` after touching graph surgery, `test_prune_vocab.py` after vocabulary work. All **[ask first]**.

**Parity / retrain / release.** The trained model must have been trained on text from the runtime it will ship with: `situation-v2` today. Round-1 models (situation-v1) must not ship with this runtime.

**Gotchas.** `export_runtime.py` parity `gate08`/`gate09` are a single-max proxy, not the runtime's summed-mass gate. q8 must be fp16-free so `webgpu+q8` runs without `shader-f16`. `final_post.sh` hard-wires the v1 eval set `simAe` (recipe 30).

**See.** [training.md](training.md#how-to-change-it-safely), [model-io-contract.md](model-io-contract.md#recipes).

## Recipes: releases

### 19. Publish @genclass/runtime

**Goal.** Release a new version of the library to npm. Publishing is irreversible and public: the user approves it and runs `npm publish` / `npm dist-tag` with their npm 2FA. Agents prepare and check everything, never run `npm login`, never handle npm tokens, and never publish, push or tag without an explicit go-ahead in chat. The full procedure, with exact commands and expected outputs, is [`RELEASE.md`](../../RELEASE.md) at the repo root; this recipe is its summary.

**Steps.**
1. **Decide with the user which release** (RELEASE.md A0, B0):
   - **Part A, `0.1.0-alpha.1` (optional, now, no model):** the NaN fix plus the situation-v2 runtime and the `observe` default, published under dist-tag `alpha` (moving `latest` afterwards is the user's choice). Without a model it only observes, so the open review findings go into the release notes, not the blocker list.
   - **Part B (after a situation-v2 model exists):** `@genclass/runtime-model@0.1.0` and its GitHub release first (recipe 20), then the demos eval (recipe 22), then `@genclass/runtime@0.1.0-beta.0` or `0.1.0`. Part B treats the open findings as blockers.
   - Which branch and commit: `mvp-v2` is unpushed; the colleague works on `origin/runtime`. The release commit must reach `origin` (the user decides how).
2. **Fix what the tarball ships** (RELEASE.md A1): `packages/runtime/README.md` is the npm page: check the README status line and version before packing, and commit any fix.
3. **Clean release worktree** (RELEASE.md A2): `git worktree add -b release/runtime-<version> ../GenClass-lib-release <commit>`; `git status --porcelain` must print nothing. The main checkout may hold other agents' uncommitted edits, and `tsup` bundles whatever is on disk.
4. **Pre-flight** in the worktree (the CI steps, recipe 21): `npm ci --no-audit --no-fund`, `npm run typecheck -w @genclass/runtime`, `npm run build -w @genclass/runtime`, the unit tests (40 + 1 files, 332 passed / 14 skipped at b435acb) and `review-perf` with `--retry=2`, `npm pack --dry-run` (26 files: `LICENSE`, `README.md`, `bin/genclass-runtime.mjs`, `package.json`, 22 under `dist/`). With the user's OK **[ask first]**: a never-worse sweep on the release commit (recipe 28), `bash test/smoke/smoke.sh` on the exact tarball, and for Part B the model tests and browser specs with `GENCLASS_MODEL_DIR`.
5. **Version bump** (RELEASE.md A4): `npm version <version> -w @genclass/runtime --no-git-tag-version` updates `packages/runtime/package.json` and the root lockfile together; commit both. Update the version strings in the READMEs, `OPEN_TASKS.md` and `HANDOFF.md`.
6. **Pack** from `packages/runtime`: `npm run build && npm pack` -> `genclass-runtime-<version>.tgz` (there is no `prepublishOnly`; `npm publish` packs whatever `dist/` holds).
7. **Give the user the exact command** (RELEASE.md A6): `npm publish genclass-runtime-<version>.tgz --access public --tag <tag>`. A prerelease needs `--tag` on npm 11 (HANDOFF's bare command fails for `0.1.0-alpha.1`); `0.1.0` needs none and becomes `latest`. Check `npm view @genclass/runtime dist-tags` before and after (RELEASE.md A8).
8. **After the publish, with the user's OK** (RELEASE.md A9, A10): tag `v<version>` and push it, a GitHub release if wanted, move the item to "Done" in `OPEN_TASKS.md`, update `HANDOFF.md` and [build-test-release.md](runtime/build-test-release.md#publish-history-from-git-and-the-registry).

**Tests.** As in step 4.

**Parity / retrain / release.** The published runtime's situation code must match the model it loads (`situation-v2` for the coming v2 model). The loader checks only the card format (`genclass-runtime-model/1`), not a situation version, so a mismatched model loads silently. A runtime that changed model text after the tag needs a new model first.

**Gotchas.** A failed tsup build leaves a half-empty `dist/` (`clean: true`). `git push` of the release branch is itself a user decision (its CI then runs for the first time on GitHub). If `RELEASE.md` is missing on your checkout, follow `HANDOFF.md` "How to continue" and [build-test-release.md](runtime/build-test-release.md#cut-a-release-of-genclassruntime).

**See.** [`RELEASE.md`](../../RELEASE.md), [build-test-release.md](runtime/build-test-release.md#how-to-change-it-safely), [status-and-known-issues.md](status-and-known-issues.md).

### 20. Publish @genclass/runtime-model and point the runtime at it

**Goal.** Make the default model URL serve a trained situation-v2 model so that `GenClass.init({ mode: "guard" })` can act. **[ask first]** throughout; publishing is the user's action. Full procedure: [`RELEASE.md`](../../RELEASE.md) Part B (B0–B7). npm versions are immutable, so whatever is published as `@genclass/runtime-model@0.1.0` is what every default `GenClass.init()` loads, permanently. Blocked until recipe 30 produces a v2 model that meets the gates (PLAN-v1 §1, §8: ship guard only when guard FIR ≤ 0.1% on all held-out sets).

**Steps.**
1. Choose the model with the user (R17 default on every device per final round 1; R32 only if clearly better) and get its validated export directory (recipes 18, 30).
2. Put the directory under `packages/runtime-model/files/` (gitignored), so jsDelivr serves it at `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@<version>/files/` (`DEFAULT_MODEL_BASE_URL`). Check it: `node packages/runtime/bin/genclass-runtime.mjs info packages/runtime-model/files` (card rules, hashes, `needs: shader-f16` on fp16). Never publish the round-1 `files/r17/` (situation-v1).
3. Add `packages/runtime-model/package.json` (`@genclass/runtime-model`, version, `files` including `files/`). It becomes a workspace automatically (`packages/*`), so run `npm install` at the root and commit the lockfile, or CI's `npm ci` fails. Confirm with `npm pack --dry-run` in that directory that `files/` is included.
4. The user publishes it (`npm publish --access public`) and attaches the same files to a GitHub release tagged `runtime-model-v<version>` (the CLI's `DEFAULT_FROM`).
5. If the version is not 0.1.0, update `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` and `packages/runtime/bin/genclass-runtime.mjs` -> `DEFAULT_FROM`, then release the runtime (recipe 19).
6. Update `packages/runtime-model/MODEL_CARD.md` (it describes round 1), `docs/runtime/CONTRACT.md` §2/§10, `docs/runtime/API.md`, both READMEs' "Status", `docs/runtime/RESULTS.md`, `OPEN_TASKS.md`, `HANDOFF.md`.

**Tests.** No automated test covers the default URL end to end. **[ask first]** In a browser: `GenClass.init()` reaches `status.state === "ready"`, the console no longer prints "Model unavailable (...); observing only.", and `npm run test:browser` passes against the published directory.

**Parity / retrain / release.** The model must match the runtime's situation format (one tag for both).

**Gotchas.** Cache Storage (`genclass-runtime-v1`) never evicts old versions. `model.json` is revalidated on every load. The demos' `?model=cdn` falls back to `DEFAULT_MODEL_BASE_URL`.

**See.** [RELEASE.md Part B](../../RELEASE.md#part-b-model-package-then-genclassruntime010-after-a-situation-v2-model-exists), [build-test-release.md](runtime/build-test-release.md), [model-host.md](runtime/model-host.md).

### 21. Change the CI workflow

**Goal.** Change `.github/workflows/ci.yml` (added in b435acb; it has not run on GitHub yet because `mvp-v2` is unpushed and `origin/runtime` has no `.github/`).

**What it does.** One job `runtime` on `ubuntu-latest`, 15 min timeout, triggered by pushes to `main`, `runtime`, `mvp`, `mvp-v2`, by pull requests and by `workflow_dispatch`; `concurrency` cancels superseded runs; `permissions: contents: read`; env `ONNXRUNTIME_NODE_INSTALL: skip`. Steps: `actions/checkout@v4`; `actions/setup-node@v4` with `node-version: 22`, `cache: npm`; `npm ci --no-audit --no-fund`; `npm run typecheck -w @genclass/runtime`; `npm run build -w @genclass/runtime`; in `packages/runtime` with `NODE_OPTIONS: --expose-gc`: `npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts`, then `npx vitest run test/review-perf.test.ts --retry=2`.

**Steps.**
1. Run the changed steps locally first (same commands; recipe 23). Keep Node within vitest@5.0.3's engines (22 ≥ 22.12, 24, ≥ 26; not 23 or 25).
2. Keep the root `npm run typecheck` out: it also typechecks `demos`, which needs the runtime `dist/` and the missing `demos/src/server/data/cities.ts` (recipe 22). Sim tests could be added after the build step: `cd sim && SIM_RUNTIME=real npx vitest run` (19 tests).
3. Browser specs would need `npx playwright install --with-deps chromium` and, for model specs, a model directory (a download: ask the user); the smoke test needs registry access. realapps needs Chromium and a VM-sized machine. Leave them out unless the user decides otherwise.
4. Never add a job that publishes, tags or pushes; changing triggers or adding secrets is the user's call. Pushing the workflow is the user's call.

**Tests.** The workflow itself; locally the same commands.

**Gotchas.** `review-perf.test.ts` asserts wall-clock bounds and flakes on shared runners (hence its own step with retries). The gc test passes silently without `--expose-gc`. A dependency change without a lockfile update fails `npm ci`.

**See.** [build-test-release.md](runtime/build-test-release.md#ci-githubworkflowsciyml).

## Recipes: demos

### 22. Add or change a demo and re-run trials

**Goal.** Add a demo app or change a scenario, oracle, chaos knob or server route, and measure with trials. The HANDOFF order reruns all demos with the trained v2 model before `@genclass/runtime@0.1.0`.

**Steps.**
1. **Prerequisite for any demos build:** recreate `demos/src/server/data/cities.ts` (still missing from git at b435acb; ignored by the root `.gitignore` pattern `data/`). It must export `searchCities(q: string)` returning `{ total, items: { id, name, country, population }[] }` and `TYPED_TARGETS: string[]`. Add a negation (`!demos/src/server/data/`) to the root `.gitignore` or rename the directory.
2. **New demo:** `demos/src/shared/protocol.ts` -> `DemoId`; a world `demos/src/server/worlds/<id>.ts` registered in `demos/src/server/sw.ts` -> `DEFS`; `demos/src/demos/<id>/{main,app,scenario,oracle}.ts` + `app.css`; `demos/<id>/index.html`; `demos/vite.config.ts` -> `PAGES`; `demos/e2e/eval.ts` -> `ALL_DEMOS`, `TITLES`, `SHOT_PRESET`; `demos/src/shared/demos.ts` -> `DEMOS`; `demos/src/site/art.ts` -> `ART`.
3. **Scenario or oracle threshold:** `demos/src/demos/<id>/scenario.ts` / `oracle.ts`; keep the scenario RNG label `"<demo>:<kind>:<seed>"`; update the `scored` copy and the README oracle table.
4. **Chaos knob:** `demos/src/shared/chaos.ts` -> `RouteChaos`, `CALM`, `describeChaos`; apply it in `demos/src/server/core.ts` -> `World.handle`; a slider in `demos/src/site/chaos-panel.ts` -> `SLIDERS`.
5. **GenClass init:** only `demos/src/shared/genclass.ts` -> `startGenClass`, which passes explicit modes (off = observe without a model, guard, heal), so the default-mode change does not affect trials. Its header comment still calls guard "the default". The synthetic in-page driver needs `observe: { untrustedEvents: true }` to record user actions (open finding).
6. **Trials** **[ask first]**: `GENCLASS_MODEL_FROM=<release dir url> bash demos/scripts/vm-eval.sh --tag <name>` (or `GENCLASS_MODEL_DIR` / `GENCLASS_MODEL_URL`), or, from `demos/`, `npm run build` then `npm run eval:fast -- --demos <id>`. Tagged runs write `results-<tag>.*`; untagged runs replace the shipped `results.*` and the landing page numbers. Report bug rate per mode **and** clean-run false interventions; update `docs/runtime/RESULTS.md` §5. The pre-release eval (Off / Observe / Guard) and the code changes it needs first are in [`RELEASE.md`](../../RELEASE.md) B7.
7. **Results schema:** `demos/src/shared/aggregate.ts` -> `ModeSummary` feeds `demos/src/site/trials-panel.ts`, `demos/e2e/eval.ts` and `demos/src/site/landing.ts`; keep the fields or update all three.
8. **Hold-induced regressions** **[ask first]**: `node --experimental-strip-types e2e/eval.ts --trace --demos board --modes off,guard,heal --tag <t>` plus an Off-only A/A run, then `e2e/trace-report.ts`.

**Tests.** No unit tests in `demos/`; the oracles and the eval are the tests. Typecheck: `npm run typecheck -w @genclass/demos` (needs `packages/runtime/dist/*.d.ts` and `cities.ts`).

**Parity / retrain / release.** None for the model. Results are comparable only within the same scenario code, runtime build and model.

**Gotchas.** Test-side code must use the native timers from `demos/src/shared/native.ts` and control the mock server only through `postMessage`. Request bodies and event keys must not contain timestamps or random ids. Oracles read `data-testid` / `data-*` attributes. Do not fix the apps' latent bugs, and never let `sim/` or `realapps/` read the demos.

**See.** [demos.md](demos.md#how-to-change-it-safely).

## Recipes: tests, debugging, docs

### 23. Run each test suite

| suite | where / command | prerequisites | expected at b435acb | policy |
|---|---|---|---|---|
| install | `npm ci` (repo root) | Node 22/24 (25 warns) | OK | local |
| runtime typecheck | `npm run typecheck -w @genclass/runtime` | install | clean | local |
| runtime build | `npm run build -w @genclass/runtime` | install | `dist/` with 6 entries | local |
| runtime unit tests | `cd packages/runtime && NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts` | install | 40 passed + 1 skipped files; 332 passed + 14 skipped tests | local |
| perf budgets | `cd packages/runtime && NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts` | install | 4 passed (flaky under load) | local |
| one file / one test | `cd packages/runtime && npx vitest run test/delivery.test.ts -t "<name>"` | install | | local |
| CI steps | the five steps of `.github/workflows/ci.yml` | fresh clone | pass | local |
| sim typecheck and tests | `npm run build -w @genclass/runtime`; `cd sim && npx tsc -p tsconfig.json --noEmit && SIM_RUNTIME=real npx vitest run` | runtime `dist/` | clean; 19 passed (5 files) | local |
| model unit tests incl. parity | `cd packages/runtime && GENCLASS_MODEL_DIR=<dir> NODE_OPTIONS=--expose-gc npx vitest run test/model` | a model directory (download) | the 14 skips run | **[ask first]** |
| browser model specs | `cd packages/runtime && GENCLASS_MODEL_DIR=<dir> npm run test:browser` | Playwright Chromium for `@playwright/test` 1.63.0, model dir; rebuilds `dist/` | specs skip without `model.json` | **[ask first]** |
| devtools UI spec | `cd packages/runtime && npx playwright test --config test/browser/ui/playwright.config.ts` | Chromium | rewrites the screenshots | **[ask first]** |
| tarball smoke | `cd packages/runtime && bash test/smoke/smoke.sh` | registry access, Chromium | prints `SMOKE OK: <tgz>` | **[ask first]** |
| sim smoke / generation | `node sim/dist/smoke.js --seeds 40`; recipe 17 | sim `dist/` | | **[ask first]** |
| realapps sweeps / generation | recipes 28, 29 | a VM with Chromium | | **[ask first]** |
| demos typecheck | `npm run typecheck -w @genclass/demos` | runtime build, `cities.ts` | fails without `cities.ts` | local |
| demos trials | recipe 22 step 6 | built site, model, Chromium | `results*.json/md` | **[ask first]** |
| training tests | `PYTHONPATH=… python -m pytest -q training/tests/<file>` | jev venv; checkpoints for some | | **[ask first]** |
| legacy Python tests | `python -m pytest -q tests/<file>` (markers `model`, `slow`, `macos`) | Python env | 20 `tests/test_data_*.py` fail at collection (`jev_local/data` missing) | **[ask first]** |
| export validation | `node validate.mjs <export dir> q8 [maxRequests]` in a dir with `training/ortweb/package.json` installed | an export dir | `ortweb_report_q8.json` | **[ask first]** |
| extension | in `extension/` on a VM: `npm ci`, `npm test`, `npm run test:e2e` | release-assets ONNX files | | **[ask first]** |

Root scripts: `npm run build` and `npm test` run only in `@genclass/runtime`; `npm run typecheck` runs every workspace that has the script (`packages/*`, `sim`, `demos`; `realapps` is not a workspace).

**See.** [build-test-release.md](runtime/build-test-release.md#exact-commands), [build-test-release.md](runtime/build-test-release.md#tests).

### 24. Write a runtime unit test

**Goal.** Add a test in the house style: virtual time, virtual server, scripted model.

**Steps.**
1. Put it in `packages/runtime/test/<area>.test.ts` (`test/model/` for model code). Import with `.js` extensions (`./helpers.js`, `../src/...js`).
2. Use `packages/runtime/test/helpers.ts` -> `setup(opts)`: `createRuntime` with `FakeClock` (starts at t = 1000), `FakeServer` (`http://app.test/`, 50 ms latency, unknown route 404), `ScriptedDecider`, `report: "silent"`, **`mode: "guard"`** (not the library default) and only the fetch observer on. Useful options: `triage: "always"`, `mode: "heal"` or `mode: "observe"`, `policy: { holdWrites: true }` for the held-write pipeline, `script: defaultScript({ delivery: { diagnosis: "stale", action: "discard", p } })`, `decider: new ManualDecider()` to control answer timing.
3. Drive the app with `rt.user(...)`, `rt.op(...)`, atoms and `fetch`; advance time with `await clock.advance(ms)`, `clock.flush()`, `clock.runAll()`.
4. Assert on `decider.calls[i].state`, `rt.decisions()`, `rt.interventions()`, `rt.history()`, `server.hits` / `server.log`.
5. Name the contract section in the `describe` (e.g. `"(CONTRACT §4)"`). A bug demonstration follows the `review-*.test.ts` style: header comment `// REVIEW: <area>. A failing test demonstrates a bug.`, `describe("review: ...")`, and a test name stating the required behaviour.
6. DOM tests: first line `// @vitest-environment happy-dom`; `createRuntime({ clock: new FakeClock(), global: window, decider, report: "silent", observe: { ...OFF, user: true } })` with `OFF` copied from `dom.test.ts`; `rt.destroy()` in `afterEach`.
7. Model-file tests: `describe.skipIf(!hasModelFile("model.json"))` from `packages/runtime/test/model/helpers.ts`.

```ts
import { describe, expect, it } from "vitest";
import { ManualDecider, defaultScript, setup } from "./helpers.js";

describe("my change (CONTRACT §4)", () => {
  it("a write applies at once and a passing discard reverts it late", async () => {
    const manual = new ManualDecider();
    const { rt, clock } = setup({ decider: manual, triage: "always" }); // guard, holdWrites off
    const a = rt.atom("v", 0);
    void rt.op("save", () => a.set(5));
    expect(a.get()).toBe(5); // never held by default
    manual.answer(defaultScript({ mutation: { diagnosis: "stale", action: "discard", p: 0.99 } }));
    await clock.flush();
    // assert on a.get(), rt.interventions()[0].late, ...
  });
});
```

The example is a sketch: check the exact late-revert conditions in `atoms.test.ts` / `delivery.test.ts` before asserting values.

**Gotchas.** Tests are not type-checked. Identical `(trigger, state, questions)` within 30 s are answered from the queue cache: advance the clock past 30 s or vary the situation. Tests that use `GenClass.init` must call `GenClass.destroy()`. Unit tests import fixtures from `test/browser/ui/`; do not move them. Delete temporary `zz-*` files before you finish.

**See.** [build-test-release.md](runtime/build-test-release.md#write-a-new-unit-test-house-style).

### 25. Investigate a false intervention reported by a user

**Goal.** Find out why GenClass changed an app's behaviour when it should not have, relieve the user, and fix the right layer without adding a rule.

**Steps.**
1. **Confirm the runtime could act.** Check `GenClass.runtime.status` (`state`, `model`, `variant`) and `GenClass.runtime.mode`. In the default `observe` mode (this branch) nothing non-passive can run. With `@genclass/runtime@0.1.0-alpha.0` (default `guard`) the default model URL 404s, the status ends in `error` and the console says "Model unavailable (...); observing only.". So an intervention implies an explicit `mode: "guard" | "heal"` (or `setMode`, or `?genclass=guard|heal`) **and** a self-hosted `model.baseUrl` or a custom `decider`. Guard runs only guard-tier actions: `discard`, `defer`, `coalesce`, `delay`, and custom actions declared `tier: "guard"`.
2. **Collect the evidence.** The console line `[GenClass] <Lead> <noun>: <fact> <changed> (<diagnosis>, p; <action> p)`; `GenClass.runtime.interventions()` -> `ActionRecord` (`id` `a<n>`, `decisionId`, `action`, `tier`, `changed`, `ok`, `error`, `late`); `GenClass.runtime.explain("a<n>")` -> `Explanation` (`situationText`, `facts`, `timeline`, `answers`, and `decision` with `diagnosisProbabilities`, `probabilities`, `candidate`, `mass`, `tier`, `reason`). The devtools overlay shows the same evidence with a Copy button. `GenClass.runtime.history(400)` gives the event log; `debug: true` logs swallowed errors.
3. **Relieve the user.** `ActionRecord.undo?.()` exists only for `discard`, late reverts, `rollback` and custom actions with `onUndo`. At the next page load: `GenClass.init({ policy: { deny: ["<action>"] } })`, or drop the explicit mode (default observe), or `?genclass=observe` / `?genclass=off` / `localStorage.genclass = "off"`. A delivery `discard` mark keeps dropping that chain's writes for 10 s even after `pause()` or `setMode("observe")` (open finding): a reload is the reliable reset.
4. **Classify** (read the evidence against the code):
   - **Gate:** did the decision pass `packages/runtime/src/decide/policy.ts` -> `gate` legitimately? `decision.mass` ≥ the tier threshold, top diagnosis ≠ `expected` (unless `requireDiagnosis: false`), the mode permits the tier. A wrong pass is a gate bug (`policy.test.ts`).
   - **Applicability:** should the action have been offered? `packages/runtime/src/situation/build.ts` -> `builtinApplicable` (known: `retry` for non-idempotent POSTs). Fixing it is class A (recipes 4, 6).
   - **Facts:** is any fact false (wrong order, version count, causal attribution, a "created" item that was a search result, "nor the value when #X started" when it was, a redaction leak)? A fact or trace bug in `packages/runtime/src/situation/*`, `packages/runtime/src/trace/context.ts` or an observer; the fix is class A (recipes 1, 2, 6).
   - **Effect:** does `changed` describe what really happened; did it act on the right write, response or message? A controller bug (recipe 4 a). Known effect defects: a delivery `discard` mark also drops later fresh polls chained from the discarded op; a `discard` on redux/zustand stores changes nothing but is recorded as a drop; a held WS/SSE message is dispatched after `close()`; a delivery `defer` can hold a response or a whole push channel for up to 20 s (two 10 s defers). `late: true` means a late revert: check `StoreHub.revertable`.
   - **Model:** the gate, offer, facts and effect are all correct and the model was confidently wrong. A precision problem for training: record the situation text and the expected passive outcome (a `training/NEEDS.md` or SIM scenario request). Do **not** add a runtime rule that maps this pattern to passive (CONTRACT §0 rule 1).
   - **No `ActionRecord` at all**, but the app misbehaved: look at timing. Held deliveries (`delivery` decisions with a hold-budget reason), observe mode's up-to-100 ms wait for a conflicting delivery's body, XHR completion listeners run after the dispatch ended (`e.currentTarget === null`), request-time holds (the source of the 3/198 chaos differences in the realapps sweep), held writes under an opt-in `holdWrites`.
5. **Reproduce headless.** Write a unit test (recipe 24) that recreates the trigger and forces the same model answer with `defaultScript`, then asserts the corrected gate, offer, fact or effect. If the app is in the realapps corpus (or close to one), reproduce in a real browser with `debug.js --app <name> --seed <s> --mode guard|heal` **[ask first]** (recipe 28). The real model's probabilities can only be reproduced with model files **[ask first]**.
6. **Record.** Add the regression test; note the issue in `packages/runtime/STATUS.md` "Open issues" (or the owning NEEDS file) and in the subsystem doc's "Drift and open issues"; for precision cases, give TRAIN the situation text.

**Gotchas.** Console reports are deduplicated in 60 s windows ("×N more"). Reason strings are parsed by devtools and the demos: do not reword them while debugging. `rt.situation(trigger)` returns the last situation built for that trigger, not a fresh rebuild.

**See.** [decide-policy-actions.md](runtime/decide-policy-actions.md), [learn-situation-triage.md](runtime/learn-situation-triage.md), [state-and-adapters.md](runtime/state-and-adapters.md#drift-and-open-issues), [observe-and-trace.md](runtime/observe-and-trace.md), [devtools.md](runtime/devtools.md).

### 26. Update these docs after a code change

**Goal.** Keep `docs/agents/`, `AGENTS.md`, `CLAUDE.md` and the human docs true to the code after you change it.

**Steps.**
1. Find every doc that cites what you changed: `grep -rn "<symbol or path>" docs/agents AGENTS.md CLAUDE.md HANDOFF.md OPEN_TASKS.md README.md docs/runtime packages/runtime/*.md packages/runtime/src/model/README.md sim/README.md realapps/README.md training/README.md demos/README.md`.
2. Update the owning agent doc (sections Files, Concepts, Configuration and constants, Invariants and gotchas, How to change it safely, Tests, Drift and open issues):

| code | agent doc |
|---|---|
| `packages/runtime/src/{index,runtime,types,errors,clock,util}.ts` (wiring, options, lifecycle, plugins) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) |
| `packages/runtime/src/observe/*`, `trace/*` | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) |
| `packages/runtime/src/state/*`, `adapters/*` | [runtime/state-and-adapters.md](runtime/state-and-adapters.md) |
| `packages/runtime/src/learn/*`, `situation/*` | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) and [model-io-contract.md](model-io-contract.md) |
| `packages/runtime/src/decide/*`, actions and delivery in `runtime.ts` | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) |
| `packages/runtime/src/model/*`, `packages/runtime/bin/genclass-runtime.mjs`, `packages/runtime-model/` | [runtime/model-host.md](runtime/model-host.md) and [model-io-contract.md](model-io-contract.md) |
| `packages/runtime/src/devtools/*` | [runtime/devtools.md](runtime/devtools.md) |
| package manifests, lockfile, tsup, vitest, test infrastructure, CI, `scripts/vm.sh`, publishing | [runtime/build-test-release.md](runtime/build-test-release.md) |
| `sim/` | [sim.md](sim.md) |
| `realapps/` | [realapps.md](realapps.md) |
| `training/` | [training.md](training.md) |
| `demos/` | [demos.md](demos.md) |
| `jev_local/` | [genclass-model-lineage.md](genclass-model-lineage.md) |
| `extension/`, `bench/`, `scripts/` | [extension-and-benchmarks.md](extension-and-benchmarks.md) |
| status, ownership, open work | [status-and-known-issues.md](status-and-known-issues.md) |
| new terms, moved paths, new recipes | [glossary.md](glossary.md), [repo-map.md](repo-map.md), this file |

3. Keep the conventions: pointers `path -> symbol`, no line numbers, "code wins", "(unverified)" for what you could not check. Update the header line of each doc you re-verified (branch, commit, date). Remove drift rows you fixed; add new drift you found, with evidence.
4. Check every relative link you touched resolves from the linking file (`ls` the target) and that anchors still match headings. Other docs link to recipes 19 and 25 of this file by anchor: keep those headings.
5. Human docs: `packages/runtime/src/types.ts` JSDoc (safe to fix: no model input), `docs/runtime/API.md`, `packages/runtime/README.md` and the root `README.md`; `packages/runtime/STATUS.md` ("Updated:" line, counts and commands, a batch section, "Deviations", "Open issues", example situations); `docs/runtime/RESULTS.md` (every new measured result, FIR next to every recall); `OPEN_TASKS.md` and `HANDOFF.md` (items moving between Next, In progress, Done, with evidence). Fixing `BUILTIN_ACTIONS` or `TRIGGER_DESCRIPTIONS` text is not a doc fix: it is model input.
6. Cross-workstream requests: add a numbered item to the owning NEEDS file (addressee, status OPEN or ASK, evidence as file -> symbol, suggested fix, a regression-test sketch). The requester flips it to DONE after verifying. Contract changes go to CONTRACT §13 (lead) or STATUS "Deviations" (owner); never diverge silently.
7. Do not edit legacy jev-era docs (`docs/*.md` outside `docs/runtime/` and `docs/agents/`).

**See.** [status-and-known-issues.md](status-and-known-issues.md#how-to-change-it-safely), [README.md](README.md).

### 27. Touch legacy code: jev_local, extension, benchmarks, ops scripts

**Goal.** Make a change in the code the runtime grew out of. CONTRACT §1 says existing GenClass content stays as is: do this only when the user asks.

**Steps.**
1. **`jev_local/` serialization, packing or calibration:** recipe 13 (TS and Python together, fixtures, retrain).
2. **Training losses or the stream reader** (`jev_local/train/`): add a `LossConfig` field defaulting to off so the v1 path stays bit-identical (`tests/test_train_v2_losses.py`); keep stream determinism and bump `INDEX_VERSION` if the row index layout changes; keep the trainer flags the `training/` launchers and `scripts/launch_run.sh` pass backward compatible. The T1 gain head (`--gain-loss`) exists only in the colleague's parent-repo `jev_local`, not here.
3. **Extension harness logic** (`extension/src/core`): change `jev_local/harness/*.py` first, regenerate `extension/test/fixtures/*_py.json` with `extension/scripts/make_py_fixtures.py` (fix its `ROOT`/`OUT` paths first), run `npm test` in `extension/` on a VM **[ask first]**.
4. **Engine/packer/tokenizer bug in the extension:** fix the runtime TS copy first (`packages/runtime/src/model/`); port to the extension only if it is still released.
5. **Extension features and models:** [extension-and-benchmarks.md](extension-and-benchmarks.md#how-to-change-it-safely); builds and e2e run on a VM **[ask first]**.
6. **Benchmarks:** benchmax specs need pinned upstream revisions; changing `bench/public/jev_published.json` or targets changes frozen hashes. Never run paid Jev/OpenRouter calls (`scripts/jevbench.py run-jev`) without the user's explicit approval and a funded key.
7. **Ops scripts:** keep `scripts/vm.sh` rsync exclusions and `--delete` semantics; keep `scripts/launch_run.sh` positional arguments (`training/launch_*.sh` depend on them). Anything that calls `az vm create/start` needs the user's go-ahead.

**Tests.** Python tests with markers `model`, `slow`, `macos` **[ask first]**.

**See.** [genclass-model-lineage.md](genclass-model-lineage.md#how-to-change-it-safely), [extension-and-benchmarks.md](extension-and-benchmarks.md#how-to-change-it-safely).

## Recipes: realapps and the v2 training pipeline

### 28. Run and read a never-worse sweep (realapps)

**Goal.** Check that a runtime build does not change correct apps when its model always answers passive ("never make a correct app worse"), and that the apps are deterministic, using `realapps/src/harness/debug.ts`. Run it after any runtime change on the default path, before a new freeze tag, and before a release. Everything here launches Chromium on a VM: **[ask first]**.

**Steps.**
1. **Set up a VM slot** (the colleague's flow; [realapps.md](realapps.md#how-to-change-it-safely)): `scripts/vm.sh run real 'cd realapps && npm install --no-audit --no-fund --ignore-scripts && bash corpus/prepare_oss.sh && node build.mjs'`, or on a cluster node `TAG=<tag> realapps/scripts/cluster.sh setup <host>`. Without `RW_RUNTIME_SRC`, `build.mjs` bundles the working-tree runtime (`dist/runtime-tag.txt` = `working-tree`): right for testing an uncommitted change, wrong for data. The README's "Run it" exports `RW_RUNTIME_*` on the Mac, where they never reach the VM build (open finding): set them inside the remote command.
2. **Determinism first:** `node dist/harness/debug.js --det 1-3 [--app a,b]`. For each seed and app: an ideal run (for the pins), then the base run twice with the scenario's exploration. Output: one `MISMATCH app=<name> seed=<s> ok=<a>/<b> decisions=<n>/<m> err=…` line per difference and `determinism: n/N identical`. A nondeterministic app makes every later number meaningless: fix the app (recipe 29) before reading interference.
3. **Never-worse, clean runs:** `node dist/harness/debug.js --interference 1-6 --clean [--app a,b]`. For each seed and app: the ideal run, then the same scenario with `mode: "observe"` and with `mode: "heal"` under the probe's all-passive decider (no forced actions, ε 0). Output per app: `<app> x/n changed (dom a, server b) seed s: steps r/k vs r/k; dom L vs L lines`, then `interference: x/N runs changed by GenClass with an all-passive model`.
4. **With chaos:** the same without `--clean` (seeds 1–3 in the recorded runs).
5. **Read it against the baselines** (all on the 66 apps of fcb8189, situation-v2 runtime; STATUS.md "Never worse", `training/NEEDS.md` 16, RESULTS.md §4): clean 0/396 (seeds 1–6); chaos 3/198 (preact-likes ×2, vanilla-spreadsheet: request-time holds shifting a request by about 25 ms, which re-rolls chaos draws keyed on arrival order); `oss-react-redux-conduit` 0/30 clean and 0/30 chaos; determinism 198/198. Under situation-v1 it was 4/198 and the Conduit never rendered its feed. The corpus now has 91 apps: the 25 newer apps have no recorded sweep, so a full run is 546 clean runs for seeds 1–6, and new mismatches there are not necessarily regressions.
6. **Know what it does not measure** (open findings, [realapps.md](realapps.md#drift-and-open-issues)): it compares only the final visible DOM text and the server content (timestamps ignored). It does not compare requests or bodies, store values, error episodes, input values or run health (a run where both legs failed counts as unchanged), and it never compares observe mode against no runtime at all, so it cannot see damage the default mode itself does. Report it as "same final visible text and server content", and look at `ok=` and step counts in the notes.
7. **Investigate a changed run:** rerun the single scenario in both modes and compare: `node dist/harness/debug.js --app <name> --seed <s> [--clean] --mode observe --steps` and `--mode heal` (prints ideal/base `ok`, network correlation, triggers, diagnoses, final stores and final DOM); `--dom-at t1,t2` prints the ideal DOM at those times; `--twice` checks determinism of that seed. Then reproduce the mechanism in a runtime unit test (recipe 24) and fix the runtime, not the app.
8. **Record** the numbers with the runtime commit and the app list in `packages/runtime/STATUS.md` ("Never worse") and `docs/runtime/RESULTS.md` §4, and note sweep changes in [realapps.md](realapps.md#tests).

**Tests.** The sweep is the test. Runtime-side companions, local: `packages/runtime/test/no-reorder.test.ts`, `default-mode.test.ts`, `delivery.test.ts`.

**Gotchas.** `--interference` passes explicit modes, so the library's default mode never affects it; its "heal" leg uses the probe decider, which answers passive when nothing is forced. A crashed Chromium makes its worker fail every remaining seed instantly (open finding in `browser.ts` -> `Runner.run`): a sudden burst of failures is infrastructure, not the runtime. Outputs never go under `~/gcl/<slot>` (`vm.sh` syncs slots with `--delete`). The VM is shared with the colleague's batches: run one sweep at a time.

**See.** [realapps.md](realapps.md#the-never-worse-and-determinism-sweeps-realappssrcharnessdebugts), [state-and-adapters.md](runtime/state-and-adapters.md#how-to-change-it-safely).

### 29. Add a realapps app

**Goal.** Add a real app (written for the corpus, or an open-source front-end) so REAL data and the never-worse sweep cover another framework, library or pattern. Building and checking it launches Chromium: **[ask first]**.

**Steps.**
1. Read `realapps/apps/README.md` (hard rules, mock backend API, affordances, cost meaning, determinism do/don't, test loop) and two example apps of the same framework. It was written for the colleague's machine (absolute paths, branch `runtime`, "never run node on the Mac"); our run policy differs, but every check needs Chromium anyway.
2. **Written app:** `realapps/apps/<name>/manifest.ts` (default export `AppManifest`, `realapps/src/shared/manifest.ts`) plus source; integrate with one line through `apps/_shared/genclass.ts` (`rt = GenClass.init(window.__GENCLASS_INIT__ ?? {})`, `flag(name, default)`), and either put state in runtime stores (`integration: "stores"`: `rt.atom`, `useGenClassState`, `genclassEnhancer`, `genclass()` for Zustand, `rt.guard`, the `_shared/*-atom.ts` bridges) or observe only (`integration: "observe"`, scored on DOM text). Framework settings (JSX mode, Svelte, Vue compiler) go in `manifest.build`; a new library needs an alias or plugin in `realapps/build.mjs` and a devDependency in `realapps/package.json`.
3. **Open-source app:** an entry in `realapps/corpus/oss.json` (repo, pinned commit, build kind, deps, licence; MIT only per `corpus/LICENSES.md`), the integration a developer would add in `realapps/corpus/patch_oss.py`, a manifest (Conduit apps: `apps/_shared/conduit-manifest.ts` -> `conduitManifest`; set `domWeight: 2` yourself for observe-only), and a build through `corpus/prepare_oss.sh` (or `build.mjs` for kind `esbuild`).
4. **Manifest rules:** the first option of every `variants` entry is the correct/guarded default (clean runs use only first options; a buggy option first corrupts the clean-benign eval case and false-intervention numbers); `affordances` with stable selectors and intent keys; `weights` (error, loading and input fields low or 0); `relations` for derived values (`fields[0]` is the derived field); `external` events for other users; `errorSelector` if not `[role=alert]`.
5. **Determinism:** nothing on real time (IntersectionObserver/ResizeObserver logic, CSS transition/animation events, full page reloads, IndexedDB, FileReader, Workers, BroadcastChannel, EventSource, image/font gating, code splitting). Never read `demos/`.
6. **Hold-out decision:** add it to `TEST_APPS` or set `heldOut` in the manifest if it should be test-only; a framework in `TEST_FRAMEWORKS` (`lit`) is test-only automatically (`realapps/src/harness/scenario.ts` -> `splitOf`).
7. **Check on a VM** **[ask first]**: `node build.mjs <name>`; then for seeds 1–6 `node dist/harness/debug.js --app <name> --seed <s> --show 1 --twice --steps` (ideal/base `ok=true`, steps mostly run, network correlated N/N, triggers present, "first diff -1"); `--traj --show 2` (rows produced, `drops={}`); then `--det 1-6 --app <name>` and `--interference 1-6 --clean --app <name>` plus chaos (recipe 28).
8. **Record:** app counts in `realapps/README.md`, `HANDOFF.md`, `docs/runtime/RESULTS.md` §6 and [realapps.md](realapps.md); per-app sweep numbers.

**Tests.** No unit tests, no typecheck (esbuild strips types; realapps is not a workspace and has no tsconfig): the debug checks are the tests.

**Parity / retrain / release.** Data only. Adding an app changes the pool that `buildScenario` draws from (`R.fork("app").pick(apps)` over every manifest `build.mjs` found), so **every seed's app choice can change**. Never sync a new app to a node in the middle of a batch (a resumed batch would draw its remaining seeds from a different pool), record the app list (or its hash) per batch, and use a new seed range for the next batch. The production batches `v2b1`–`v2b3` may or may not include the 25 newest apps, depending on what was synced (unverified).

**Gotchas.** Do not name a store `auth` (secret-word redaction; use `session`). Apps must not use EventSource (`netapi.ts` sets it undefined). Ideal runs are blind (observe mode, no observers, no decider); do not turn observers on there. realapps imports sim's cost and label code by relative path, so a sim change changes realapps labels too. `realapps` has no lockfile and `prepare_oss.sh` deletes each OSS app's lockfile, so nodes set up at different times can bundle different framework versions (open finding).

**See.** [realapps.md](realapps.md#how-to-change-it-safely), `realapps/apps/README.md`.

### 30. Run the v2 training pipeline (teacher, labels, distil, DAgger)

**Goal.** Produce the first situation-v2 model the way the colleague runs training (`HANDOFF.md` "How to continue", `training/PLAN-v1.md` P1–P5, `training/LOG.md`): T150 teacher on v2 gold -> teacher labels on unlabeled rows -> distil R17 (default) and R32 -> DAgger via SIM `--on-policy` -> EVAL -> export. **Every step is [ask first].** It runs on Azure (`rg-jev-train`, nodes c01–c23 F80 plus `train` and `data`), costs money (PLAN-v1 estimates $3–4k; spend to date ≈ $400), and the colleague is operating the cluster now. Use this recipe to plan, review or hand over the work, not to start it on your own.

**Preconditions.**
- v2 data collected and its locations listed in `training/NEEDS.md`: SIM gold and unlabeled under `train:/data/sim-out/v2-*` (gz shards + `manifest.json` from `collect.py`), REAL `v2b1`–`v2b3` copied to `train:/data/real-out/` with their eval set.
- Node claims recorded in `training/NEEDS.md` (TRAIN's plan: c01 workbench; teacher on c12–c23; students on c02–c11).
- The HANDOFF Azure rules: `az` calls one at a time, each wrapped in `timeout`; deallocate idle nodes; never delete VMs; the nightly shutdown schedules are disabled for the push and must be re-enabled when it ends.

**Steps.**
1. **Sync code** to every node: `training/node.sh <host> sync`. Shell scripts assume the nested `jev/<checkout>/training` layout ([training.md](training.md#invariants-and-gotchas)).
2. **Import v2 data** to the workbench and stream roots. `training/import_final.sh` expects a plain `{train,dev,test}.jsonl` SIM dir and cannot read the v2 gz-shard layout (open finding); it also wipes `data/<NAME>` first and tars all of `data/s3`. Until a v2 importer exists: download the shards, verify them against `manifest.json`, decompress train shards into `data/s3/<bucket>/` (the stream reader reads `*.jsonl` and `*.jsonl.zst`, not `.gz`), and build an eval set from test/dev in the layout `eval_sim.sh` expects (`data/<EVALSET>/{test,dev}.jsonl` plus `data/<EVALSET>_t*/test.jsonl`, `data/<EVALSET>_d*/dev.jsonl`; e.g. `simv2e`). REAL train rows get their own bucket; build the REAL eval set with `python3 realapps/scripts/evalset.py <dirs> --out <dir> --splits test` (its default `test,dev,train` puts training rows into the eval set; it also ignores `delivery` rows: open findings).
3. **Decide data filters with the user** before training on them (open findings): rows at `meta.budget == 3200` (SIM and realapps still sample the v1 budget for 40% of trajectories; production never exceeds 2,400 chars); unlabeled rows whose hard `labels.diagnosis` is `expected` (S1 would relabel some of them; dropping that label lets the teacher label it); realapps `delivery` rows labelled `expected` although the user changed the field (`realapps/src/world/diagnose.ts`).
4. **Curriculum replay on v2:** `$PY training/curriculum/generate.py --out ~/gcl-train/data/cur5 --n 300000 --seed 6 --workers 72 --p-runtime 0.8` on the workbench; check `stats.json`; shard into `data/s3/cur5/`.
5. **Mixtures:** write new `training/configs/mix_v2_t150.json` and `mix_v2_distill.json` listing `buckets` explicitly (no v2 mixture exists; `mix_t150.json` names the v1 buckets `simA`, `cur4`). Gold dominates; curriculum replay 5–10% (PLAN P4).
6. **Teacher (P1):** `training/launch_student.sh t150-v2a t150 <passes> mix_v2_t150.json "c12 c13 … c23" <INIT>` (ettin-150m pruned base, 8 ranks × 10 threads; `launch_t150.sh` hard-codes `mix_t150.json`). Always pass `INIT` (e.g. `$G/models/base/ettin-150m-v16k` or the stopped v1 `t150-g1` checkpoint on c12 as a warm start, the user's call): without it the script fails under bash 3.2 after it has already pruned on every node, and with `-- extra` args the `--` is taken as `INIT` (open finding). Watch `~/jev/runs/<run>/rank0.out` and `$G/runs/<run>/log.jsonl` on rank 0; check `mixture_plan.json`.
7. **Teacher gate (P2):** copy the servable to the workbench (`training/pull_ckpt.sh t150-v2a <rank-0 node>`), `bash training/eval_sim.sh simv2e t150-v2a`, `$PY training/report.py t150-v2a=out/eval/t150-v2a-simv2e.json --mode=kind`. Check clear-case recall first: if a 150M teacher is also near 40% argmax on clear rows, the limit is the situation information, not model size, and the fix is in SIM/CORE (recipe 6), not in more training.
8. **Teacher labels (P3):** with the teacher's dev-fitted calibration, `training/label_cluster.sh c01 t150-v2a out/cal/t150-v2a-simv2e.json data/unlab/<set> <bucket> "<nodes>" [PROCS] [QIDS]`, or `$PY training/label_teacher.py --ckpt models/t150-v2a --in <shard> --out <out> --calibration <cal>` per shard. `label_cluster.sh` is untested (LOG) and has open defects: it touches the done marker even when labelling failed, cannot read `.jsonl.gz` shards, has no split filter (only `train` shards may be labelled into a training bucket) and does not gather outputs back to the workbench. Check per-shard line counts against the inputs before trusting `.label-<bucket>-done`, and gather the shards yourself. PLAN P3 labels a prioritised 5–10M-row subset (rows near the gate plus a uniform sample), not all 50M.
9. **Distil students (P4):** `training/launch_student.sh r17-v2 r17 <passes> mix_v2_distill.json "<nodes>" $G/runs/r17-s1c/ckpt` and the same for `r32` (final rounds restart from the stage-1c weights, as in LOG). New run names mean new stream caches and outputs.
10. **Evaluate, calibrate, export:** `final_post.sh` is wired to the v1 eval set `simAe` and does not stop on failures (open finding), so run the steps yourself on the rank-0 node or c01: `rm -f out/records/r17-v2__*` (cached logits are keyed by name only), `EVAL_THREADS=12 bash training/eval_sim.sh simv2e r17-v2`, the REAL eval set via `$PY training/eval_runtime.py --ckpt models/r17-v2 --data <real eval dir> …`, then `$PY training/export_runtime.py --ckpt models/r17-v2 --out out/export-r17-v2 --name genclass-runtime-r17 --version 0.1.0 --calibration out/cal/r17-v2-simv2e.json --data-rows data/simv2e/dev.jsonl,data/cur5/dev.jsonl --n-per-file 60 --threads 24`, then deliver and validate (recipe 18 steps 7–8).
11. **DAgger (P5):** export the students, run SIM on-policy generation with the export (`SEED_BASE=22000000000 sim/scripts/cluster/orchestrate.sh run <RUN> onpolicy:<export dir on the nodes> <ROWS> <nodes…>`; 1–5M rows per round), collect, import as a new bucket, retrain the students (refresh the teacher every second round). On-policy runs act in heal mode (open finding: guard-mode numbers on those rows do not describe guard deployment); evaluate DAgger and REAL rows for clear-case recall separately (PLAN-v1).
12. **Report every round** in `training/EVAL.md`, `training/LOG.md` (what ran where, cost) and `docs/runtime/RESULTS.md` (§1, §6, §7): action/diagnosis accuracy, guard/heal FIR, precision, recall and clear-case recall, ECE, per trigger and per budget, SIM held-out (incl. held-out features) and REAL eval; always FIR next to recall (HANDOFF).
13. **Ship:** only when the gates hold (guard FIR ≤ 0.1% on all held-out sets): recipe 20 (model package), recipe 22 (demos rerun), recipe 19 (`@genclass/runtime@0.1.0`). Deallocate every node, release claims in `training/NEEDS.md`, and re-enable the shutdown schedules (command in HANDOFF).

**Tests.** `training/tests/test_curriculum.py` after curriculum changes, `test_export_runtime.py` after export changes; `validate.mjs` and runtime parity on every export.

**Parity / retrain / release.** Train only on rows from one runtime tag (`situation-v2`); never mix v1 rows (phase A/B, `gold-r1x`, `cur1`–`cur4`, REAL pilots) into v2 training buckets. A runtime text change during the pipeline restarts it (recipe 6).

**Gotchas.** Rank 0 must hold `--init-from`. A bucket named in a mixture but missing on disk is dropped silently. `label_teacher.py` keeps gold labels unless `--overwrite`. The eval logit cache, the shared `data/s3` tar and the done markers can each make a failed step look finished: verify outputs, not markers. The T1 expected-gain side track (`t1_relabel.py`, `eval_gain.py`, `t1_post.sh`) is optional and also wired to `simAe`.

**See.** [training.md](training.md#how-to-change-it-safely), [sim.md](sim.md#9-cluster-runs-simscriptscluster), [realapps.md](realapps.md#how-it-feeds-training), [genclass-model-lineage.md](genclass-model-lineage.md).

## Drift and open issues

Open defects found by review at b435acb that change how the recipes above must be followed (details and suggested fixes in the subsystem docs' "Drift and open issues"):

| area | defect | recipes affected |
|---|---|---|
| runtime, model text | F2 fact prints raw text of redacted fields (`situation/content.ts` -> `contentFacts`); leaf-based redactor misses numbers/arrays under secret containers (`util.ts` -> `isSensitivePath`); "…nor the value when #X started" unchecked; every successful POST counted as a create; 502 treated as "not processed" | 2, 6, 25 |
| runtime, delivery | discard mark drops later fresh chained writes for 10 s and survives `pause()`/observe; discard is a no-op on redux/zustand but recorded as a drop; observe mode still waits up to 100 ms for a conflicting body; background delivery decisions are always dropped (delivery standing questions never answered in observe); `defer` can stall a channel 20 s; held WS/SSE messages dispatched after `close()`; XHR listeners see `currentTarget === null` | 4, 5, 7, 10, 25 |
| sim / realapps | budget weights still sample the v1 3,200-char budget 40%; unlabeled SIM rows keep `expected` diagnoses S1 would relabel; realapps manifests say `situation-v1`; interference sweep compares only final DOM text and server content; evalset includes train rows and ignores `delivery`; 25 apps never swept | 6, 16, 17, 28, 29, 30 |
| training scripts | `import_final.sh` cannot import v2 shards; `label_cluster.sh` marks done unconditionally, no gz, no split filter, no gather; `final_post.sh` hard-wired to `simAe`; eval logit cache keyed by name; `launch_student.sh` breaks without `INIT`; `rt.py` diverges from the frozen renderer in several common cases | 18, 30 |
| docs | `HANDOFF.md` still says guard is the default; CONTRACT documents the old redaction rule | 5, 19, 20 |

Other notes:
- `RELEASE.md` (repo root, added alongside this doc refresh) is the release procedure recipes 19 and 20 summarise; where they disagree, it and the code win.
- The test example in recipe 24 is illustrative; the exact late-revert conditions are in `atoms.test.ts` / `delivery.test.ts` (unverified as written).
- `status-and-known-issues.md` may still describe 654d822 in places; prefer HANDOFF and the subsystem docs for v2 status.

## Related docs

- [README.md](README.md) (index of agent docs), [overview.md](overview.md), [repo-map.md](repo-map.md), [glossary.md](glossary.md), [../../AGENTS.md](../../AGENTS.md)
- [status-and-known-issues.md](status-and-known-issues.md), [model-io-contract.md](model-io-contract.md)
- Runtime: [public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md), [observe-and-trace.md](runtime/observe-and-trace.md), [state-and-adapters.md](runtime/state-and-adapters.md), [learn-situation-triage.md](runtime/learn-situation-triage.md), [decide-policy-actions.md](runtime/decide-policy-actions.md), [model-host.md](runtime/model-host.md), [devtools.md](runtime/devtools.md), [build-test-release.md](runtime/build-test-release.md)
- Other subsystems: [sim.md](sim.md), [realapps.md](realapps.md), [training.md](training.md), [demos.md](demos.md), [genclass-model-lineage.md](genclass-model-lineage.md), [extension-and-benchmarks.md](extension-and-benchmarks.md)
- Human sources: [`HANDOFF.md`](../../HANDOFF.md), [`docs/runtime/CONTRACT.md`](../runtime/CONTRACT.md), [`docs/runtime/API.md`](../runtime/API.md), [`docs/runtime/RESULTS.md`](../runtime/RESULTS.md), [`packages/runtime/STATUS.md`](../../packages/runtime/STATUS.md), [`OPEN_TASKS.md`](../../OPEN_TASKS.md), [`RELEASE.md`](../../RELEASE.md), `realapps/README.md`, `training/PLAN-v1.md`
