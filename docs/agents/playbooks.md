# Playbooks: recipes for common changes

> **Scope:** step-by-step recipes for the edits agents are most often asked to make in this monorepo: the runtime (`packages/runtime`), its model host and devtools, the adapters, `sim/`, `training/`, `demos/`, releases, test runs, debugging a reported intervention, and these docs. Each recipe merges and deduplicates the "How to change it safely" sections of the subsystem docs.
> **Read this when:** you have a concrete change to make and need the full checklist: files and symbols to touch, tests to add and run, parity / retrain / release consequences, and the traps.
> **Source of truth:** the code. Pointers verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins. If this doc and a subsystem doc disagree, check the code and fix whichever is wrong (recipe 26).

Conventions used below:

- Code pointers are `path/from/repo/root.ts` -> `symbol`. A method is written `Class.method`.
- In "Tests" lines, test files are listed after their directory, e.g. `packages/runtime/test/`: `atoms.test.ts`, `policy.test.ts`.
- **[ask first]** marks a step that runs something the run policy in AGENTS.md reserves for the user's approval (see [Where to run things](#3-where-to-run-things)).
- **Model input** means any byte that reaches `EvaluateRequest.state` or `EvaluateRequest.questions` (situation text, question headers, option descriptions, diagnosis labels), plus the token ids derived from it.
- Recipes say "the lead", "SIM" or "TRAIN" where the original workstream protocol required their sign-off. In an agent session, stop and get the user's decision at those points; record it the way the protocol describes (recipe 26).

## Before you start

### 1. Ground rules (binding: `docs/runtime/CONTRACT.md` §0 and §0.5)

- **No rules in the runtime.** The runtime computes generic facts and decides whether to ask the model (triage); it never maps a fact pattern to a diagnosis or action with an if/then. The model chooses; `packages/runtime/src/decide/policy.ts` -> `gate` only filters. This also holds when you fix a false intervention (recipe 25).
- **One situation implementation.** `packages/runtime/src/situation/*` is the only code that builds situation text. The sim runs it unchanged (`sim/src/run/rt.ts` -> `realRuntimeFactory`), and `training/curriculum/rt.py` is a hand port of it.
- **Determinism.** Inside `packages/runtime/src`, never call `Math.random`, `Date.now`, `performance.now` or the global `setTimeout`/`setInterval`. Use the injected `Clock` (`this.clock` in `RuntimeImpl`, `api.clock` in plugins), take ids from counters, and clear every timer you arm in `RuntimeImpl.destroy` (or make it harmless when it fires later). Sim world code uses keyed `Rng` forks only (`sim/src/rng.ts` -> `Rng.fork`).
- **Fail open.** Every path that has no usable answer runs the controller's passive action. Never make the app wait on the model.
- **`GenClass.init` never throws.** Observers install inside `tryAdd` in `packages/runtime/src/runtime.ts` -> `RuntimeImpl.installObservers`; plugin `setup` errors are swallowed.
- **Honest evaluation.** `sim/` and `demos/` never import or read each other. Do not fix the demo apps' latent bugs or tune them for GenClass.
- **Dependencies.** No new runtime dependency besides `onnxruntime-web` without the lead. TypeScript strict, ESM only.
- **Legacy content stays as is** (CONTRACT §1): `jev_local/`, `extension/` and the jev-era `docs/*.md`. This does not cover `docs/runtime/` or `docs/agents/`.
- **Review tests are a contract.** Never edit `packages/runtime/test/review-*.test.ts` to make it pass; fix `src/`.
- **Code wins over docs.** `docs/runtime/CONTRACT.md` was last edited in a53dd38, before batch 3. STATUS, the READMEs, `UI-NEEDS.md`, `sim/NEEDS.md` and `training/NEEDS.md` have stale items. Check the drift tables in [status-and-known-issues.md](status-and-known-issues.md#drift-and-open-issues) before trusting them.

### 2. The `situation-v1` freeze

Tag `situation-v1` is commit 1a77558. `git diff situation-v1 HEAD -- packages/runtime/src` is empty at 654d822. SIM phase A (600,676 rows) and TRAIN final round 1 were built on that exact text. Before editing, classify your change (condensed from [model-io-contract.md](model-io-contract.md#versioning-what-invalidates-the-trained-model)):

| class | what you touch | consequence |
|---|---|---|
| **A. Model input text or label space** | `packages/runtime/src/situation/{facts,describe,build,serialize,questions}.ts`; `packages/runtime/src/util.ts` formatters, redaction and signature normalisation; `packages/runtime/src/state/fields.ts` -> `changeText`; `ActionEffect.changed` sentences (`packages/runtime/src/runtime.ts`, `packages/runtime/src/observe/fetch.ts`, `packages/runtime/src/observe/xhr.ts`); observer op names, details and event `data` keys; which actions are offered (`packages/runtime/src/situation/build.ts` -> `builtinApplicable`) | user approval, SIM regeneration, `training/curriculum/rt.py` re-port, retrain, re-eval, re-export, a new freeze tag (recipe 6) |
| **B. Distribution only** | `neutral` flags and thresholds in `packages/runtime/src/situation/facts.ts`, trigger conditions, baseline/profile estimators, invariant learning, hold/bypass rules | regenerate SIM data; retrain recommended |
| **C. Token ids** | `packages/runtime/src/model/{serialize,pyutil,tokenizer,packer}.ts`, `packages/runtime/src/model/engine.ts` -> `FEEDS` | change `jev_local/` in lockstep, regenerate fixtures, retrain if the Python side changed (recipe 13) |
| **D. Answers only** | `packages/runtime/src/model/calibrate.ts`, `calibration.json` | re-run `training/eval_runtime.py`; no retrain |
| **E. Nothing the model sees** | `packages/runtime/src/decide/policy.ts` defaults, host/loader/worker, devtools, adapters, report wording | runtime tests only; mirror gate changes in `training/eval_runtime.py` |

Class A and C changes need the user's go-ahead **before** you edit.

### 3. Where to run things

Run policy (set when these docs were written, 2026-10-07): the original team ran every build and test on an Azure VM through `scripts/vm.sh`, because the original author's Mac has 8 GB RAM (CONTRACT §0 rule 5; the subsystem docs repeat "VM only"). On other machines the light steps below are verified to work locally and may be run without asking. Everything else needs the user's approval first.

| task | run locally? | command | verified result (macOS, 16 GB, 10 CPUs, Node v25.6.0, npm 11.8.0) |
|---|---|---|---|
| install | yes | `npm install` at the repo root | 18 s, 134 packages. One `EBADENGINE` warning (vitest@5.0.3 wants node `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`; Node 25 works). Side effects: an untracked root `package-lock.json` (never committed; do not commit it without the user's decision) and a mode change on `packages/runtime/bin/genclass-runtime.mjs` (committed 644, npm sets 755): revert with `git checkout -- packages/runtime/bin/genclass-runtime.mjs` |
| runtime typecheck | yes | `cd packages/runtime && npx tsc -p tsconfig.json --noEmit` | clean, ~1.6 s. Covers `src/` only: tests are never type-checked |
| runtime build | yes | `cd packages/runtime && npx tsup` | ~2.5 s; entries `index`, `adapters/{react,redux,zustand}`, `devtools/index`, `worker`; `.d.ts` for all but `worker`; `dist/` ~1.6 MB with maps |
| runtime unit tests | yes | `cd packages/runtime && NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**"` | Test Files 36 passed, 1 skipped (37); Tests 286 passed, 14 skipped (300); ~2.4 s |
| the 14 skipped model-parity tests | **[ask first]** (model download) | same command with `GENCLASS_MODEL_DIR=<model dir>` (default `<repo>/.cache-model`) | skipped files/tests: `test/model/packer.test.ts` (10 of 10), `engine.test.ts` (3 of 4), `calibrate.test.ts` (1 of 8). With a model directory all 300 pass (per STATUS) |
| Playwright (model specs, devtools UI spec), `packages/runtime/test/smoke/smoke.sh` | **[ask first]** | see recipe 23 | not run when these docs were written |
| sim (tests, smoke, generation), training, demos eval, Python tests, model downloads | **[ask first]** | see recipes 17, 18, 22, 23 | not run when these docs were written |
| anything that touches Azure: `scripts/*.sh`, `training/*.sh`, `sim/scripts/*` | **[ask first]** | | `scripts/vm.sh` also needs `~/.jev-local/azure_hosts` and `~/.ssh/jev_azure`, which are not in the repo |

There is **no CI** (no `.github/` directory). Your local typecheck and unit-test run is the only gate before review.

### 4. Read these first

| file | why |
|---|---|
| [status-and-known-issues.md](status-and-known-issues.md) | what is shipped, frozen, in flight; ownership; open product risks; drift tables |
| the subsystem doc for your area (index below) | "Invariants and gotchas", "How to change it safely", "Tests" |
| [`OPEN_TASKS.md`](../../OPEN_TASKS.md) | the lead's task list (Next / In progress / Done / Needs the user) |
| [`packages/runtime/STATUS.md`](../../packages/runtime/STATUS.md) | CORE's state, example situations per trigger, "Deviations from the contract", "Open issues" |
| [`docs/runtime/CONTRACT.md`](../runtime/CONTRACT.md) | binding rules (§0, §0.5), workstream layout (§1), additions (§13). Stale in places |
| [`docs/runtime/API.md`](../runtime/API.md) | human API reference; update it with any public-surface change |
| NEEDS files: [`demos/NEEDS.md`](../../demos/NEEDS.md), [`sim/NEEDS.md`](../../sim/NEEDS.md), [`training/NEEDS.md`](../../training/NEEDS.md), [`packages/runtime/UI-NEEDS.md`](../../packages/runtime/UI-NEEDS.md) | open cross-workstream requests (OPEN / ASK / DONE); `demos/NEEDS.md` §1, §2, §5, §6 are open in runtime code |
| [`training/LOG.md`](../../training/LOG.md), [`training/EVAL.md`](../../training/EVAL.md) | before any training or eval work |

Ownership (CONTRACT §1 and §13): CORE owns `packages/runtime/src` except `model/` (MODEL) and `adapters/` + `devtools/` (UI); SIM owns `sim/`, TRAIN `training/` (CONTRACT §1 lists the lead), DEMOS `demos/`, REVIEW the `review-*` tests.

### 5. Recipe index

| # | recipe | area | can change model input? | needs **[ask first]** runs to finish? |
|---|---|---|---|---|
| 1 | [Add or change an observer](#1-add-or-change-an-observer) | runtime | yes (op names, details, events) | no |
| 2 | [Add or change a generic fact](#2-add-or-change-a-generic-fact) | runtime | yes | for the parity follow-up |
| 3 | [Add a trigger kind](#3-add-a-trigger-kind) | runtime + sim + training | yes | yes |
| 4 | [Add or change a built-in action](#4-add-or-change-a-built-in-action) | runtime (+ sim, training) | yes | for a new action |
| 5 | [Change a policy threshold or default](#5-change-a-policy-threshold-or-default) | runtime | no (distribution for triage) | no |
| 6 | [Change situation text, serialiser, budgets or questions](#6-change-situation-text-serialiser-budgets-or-questions) | runtime + sim + training | yes | yes |
| 7 | [Change the state pipeline or invariants](#7-change-the-state-pipeline-or-invariants) | runtime | sometimes | no |
| 8 | [Add or change a framework adapter](#8-add-or-change-a-framework-adapter) | runtime (UI) | no | smoke test only |
| 9 | [Add a public API method, option, event or subpath export](#9-add-a-public-api-method-option-event-or-subpath-export) | runtime | only if it alters situations | smoke test only |
| 10 | [Add a custom action, standing question or plugin (app side)](#10-add-a-custom-action-standing-question-or-plugin-app-side) | app code | no retrain needed | no |
| 11 | [Add or change a devtools view](#11-add-or-change-a-devtools-view) | runtime (UI) | no | Playwright for screenshots |
| 12 | [Change model loading or backends](#12-change-model-loading-or-backends) | model host | no | browser specs |
| 13 | [Change the packer, tokenizer, serializer or calibration](#13-change-the-packer-tokenizer-serializer-or-calibration) | model host + `jev_local` | yes (token ids) | yes |
| 14 | [Regenerate model parity fixtures](#14-regenerate-model-parity-fixtures) | model tests | no | yes |
| 15 | [Add a sim feature module](#15-add-a-sim-feature-module) | sim | data only | yes |
| 16 | [Change sim oracle, labelling, ask questions or splits](#16-change-sim-oracle-labelling-ask-questions-or-splits) | sim | labels only | yes |
| 17 | [Generate a data set](#17-generate-a-data-set) | sim | n/a | yes |
| 18 | [Train, evaluate and export a model](#18-train-evaluate-and-export-a-model) | training | n/a | yes |
| 19 | [Publish @genclass/runtime](#19-publish-genclassruntime) | release | n/a | yes (user publishes) |
| 20 | [Publish @genclass/runtime-model and point the runtime at it](#20-publish-genclassruntime-model-and-point-the-runtime-at-it) | release | n/a | yes |
| 21 | [Add a CI workflow](#21-add-a-ci-workflow) | repo | no | no |
| 22 | [Add or change a demo and re-run trials](#22-add-or-change-a-demo-and-re-run-trials) | demos | no | yes |
| 23 | [Run each test suite](#23-run-each-test-suite) | all | n/a | some |
| 24 | [Write a runtime unit test](#24-write-a-runtime-unit-test) | runtime tests | n/a | no |
| 25 | [Investigate a false intervention reported by a user](#25-investigate-a-false-intervention-reported-by-a-user) | runtime | depends on the fix | no |
| 26 | [Update these docs after a code change](#26-update-these-docs-after-a-code-change) | docs | n/a | no |
| 27 | [Touch legacy code: jev_local, extension, benchmarks, ops scripts](#27-touch-legacy-code-jev_local-extension-benchmarks-ops-scripts) | legacy | possibly | yes |

## Definition of done

A change is done when all of these hold. Say explicitly in your final report which ones you could not meet.

1. **Typecheck clean:** `cd packages/runtime && npx tsc -p tsconfig.json --noEmit`. If you touched `sim/src` types, also `npm run typecheck -w @genclass/sim` (light; not run when these docs were written).
2. **Unit tests pass:** the full runtime suite (command in [Where to run things](#3-where-to-run-things)). Without a model directory the baseline is 286 passed / 14 skipped in 36 + 1 files; your new tests add to "passed" and nothing new is skipped. No `review-*.test.ts` was edited.
3. **New behaviour has a test** in house style (recipe 24), including a "benign stays quiet" test for anything that can make a situation salient.
4. **Build passes** (`npx tsup`) if you touched `package.json` exports, `tsup.config.ts`, the worker, dynamic imports or anything bundling-related.
5. **Mirrors updated by hand** (the runtime's `tsc` checks none of them; the sim loads the runtime by module name, so a mismatch shows up only at sim run time): `packages/runtime/test/browser/ui/mock-runtime.ts` -> `MockRuntime`, `demos/src/dev/runtime-shim/*` (`ShimRuntime`), `sim/src/run/rt.ts` -> `RuntimeLike` / `createOptions`, `sim/src/types.ts`, `training/curriculum/rt.py`, the devtools copies of report wording (`packages/runtime/src/devtools/ui.ts` -> `LEAD`, `NOUN`).
6. **Freeze respected:** `git diff situation-v1 -- packages/runtime/src` shows no class A/B/C change, or the user approved it and your report lists the follow-ups (SIM regeneration, `training/curriculum/rt.py` re-port, retrain, re-export, new freeze tag). Do not create freeze tags yourself.
7. **Docs updated** (recipe 26): `packages/runtime/src/types.ts` JSDoc, `docs/runtime/API.md`, `packages/runtime/README.md` for public surface; `packages/runtime/STATUS.md`; the matching `docs/agents/*.md`; `OPEN_TASKS.md` when a listed item moves.
8. **Workspace clean:** no root `package-lock.json` committed (unless the user decided to), the bin file mode reverted, no `dist/`, `*.tgz` or regenerated screenshots committed by accident.
9. **Nothing irreversible without the user:** no `npm publish`, `git push`, tag, GitHub release, Azure VM start or paid API call unless the user explicitly asked for that action.
10. **Report** lists the commands you ran with their results, and the **[ask first]** suites you did not run (Playwright, smoke, sim, model tests, training).

## Recipes: runtime core

### 1. Add or change an observer

**Goal.** Trace a new async source (e.g. `EventSource`, requested in `demos/NEEDS.md` §6, or `BroadcastChannel`), or change how an existing observer records ops and events.

**Steps.**
1. Decide whether you need core code. App-specific sources can stay in a plugin: `PluginApi.recordOp` / `endOp` / `runInOp` (`packages/runtime/src/runtime.ts` -> `RuntimeImpl.pluginApi`), with no core or parity impact (recipe 10).
2. Create `packages/runtime/src/observe/<name>.ts` exporting `install<Name>(...)` that returns an uninstall function, or `null` when the global is missing. Follow `packages/runtime/src/observe/fetch.ts` -> `installFetch`: a `disabled` flag so the wrapper becomes a pass-through after `destroy()`, restore the global only if it still holds your wrapper, wrap all tracing in try/catch, use the host's clock.
3. Register it in `packages/runtime/src/runtime.ts` -> `RuntimeImpl.installObservers` with `if (on("<name>")) tryAdd("<name>", () => install<Name>(...))`. `on(k)` defaults to true; pass a second argument (as `timers` does with `browserLike`) to make the default conditional.
4. Add the name to `packages/runtime/src/types.ts` -> `ObserverName`; TypeScript then forces it into `packages/runtime/src/index.ts` -> `ALL_OFF`.
5. Add the key to every explicit observe map: `packages/runtime/test/helpers.ts` -> `setup`, `packages/runtime/test/browser/ui/session.ts` (`OBSERVE`), the `ONLY_*` constants in `review-fetch.test.ts` / `review-timers.test.ts`, `const OFF` in `dom.test.ts`, and `sim/src/run/rt.ts` -> `createOptions` (set it to `false` unless SIM wants it).
6. Reuse an existing `packages/runtime/src/types.ts` -> `OpKind` if you can. A new kind also touches `packages/runtime/src/situation/describe.ts` -> `opPhrase`, `packages/runtime/src/runtime.ts` -> `PROFILED`, and situation text (class A).
7. To carry causality across a new async boundary (`requestAnimationFrame`, `queueMicrotask`, `MessagePort`), copy `packages/runtime/src/observe/timers.ts` -> `installTimers`: capture `ctx.peek()` at schedule time, resolve a `LazyOp` to `.nearest`, call `ctx.stick(lazyTimer(parent, label))` in the callback. Never give a `LazyOp` a `LazyOp` parent.
8. Changing DOM recording (`packages/runtime/src/observe/dom-user.ts` -> `installDomUser`): keep the `ignoredEvent(e) || programmatic(e)` guard and the rule that sensitive fields record `""`. If `describeElement` output changes, the sim's synthetic targets must follow.
9. Adding a volatile header: add it to both `packages/runtime/src/observe/fetch.ts` -> `VOLATILE_HEADERS` and `packages/runtime/src/observe/xhr.ts` -> `VOLATILE`, so identities match across transports.

**Tests.** `packages/runtime/test/`: install and record; `destroy()` restores the global (next to `dom.test.ts` "browser globals are restored by destroy()"); pass-through after destroy (`review-fetch.test.ts` pattern); a read-only global does not throw (`batch3.test.ts`, `review-misc.test.ts` patterns). For context changes run `context.test.ts` and `review-timers.test.ts` with `NODE_OPTIONS=--expose-gc` (otherwise the gc test logs a skip and passes). For DOM changes run `dom.test.ts`, `review-dom.test.ts`.

**Parity / retrain / release.** A new observer that the sim leaves off adds no training rows, but its ops, op names, `detail` strings and event `data` keys appear in timelines and facts at runtime: they are class A for any trigger the sim does produce. Renaming existing op names, details or event keys (`packages/runtime/src/situation/describe.ts` -> `eventLine` reads `count`, `first`, `route`, `key`, `duration`, `summary`, `message`) is class A. Signature normalisation (`packages/runtime/src/util.ts` -> `isIdSegment`, `isSlugId`) also keys baselines and the persisted profiles under `genclass.profiles.v1`.

**Gotchas.** Captured natives (`packages/runtime/src/clock.ts` -> `browserClock` timers, `packages/runtime/src/index.ts` -> `NATIVE_FETCH`) must stay at module top level, or the runtime observes its own timers and model download. Two runtimes on one page double-wrap every global. WebSocket instances and timer callbacks created before `destroy()` keep tracing. Sync XHR and keepalive fetch raise no request trigger. Nav routes are not redacted.

**See.** [observe-and-trace.md](runtime/observe-and-trace.md#how-to-change-it-safely), [public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md#how-to-change-it-safely).

### 2. Add or change a generic fact

**Goal.** Add a new uniform fact, reword one, change whether it is `neutral` (triage), or change a triage threshold such as the M8 latency ratio.

**Steps.**
1. Get the user's go-ahead: every variant is class A (wording) or class B (neutral flag, threshold).
2. Edit the per-trigger function in `packages/runtime/src/situation/facts.ts`: `mutationFacts`, `requestCommon` (shared by request/failure/stall), `failureFacts`, `stallFacts`, `inconsistencyFacts`, `transitionFacts`, `errorFacts`, `askFacts`; all dispatched by `computeFacts`. Build facts with the module's `fact(text, kind, neutral)` helper. State relations and numbers explicitly ("after", "newer", "in a row"); never phrase a verdict ("this is a bug").
3. Data comes only from `SitEnv` (`packages/runtime/src/situation/env.ts`), implemented by `packages/runtime/src/runtime.ts` -> `RuntimeImpl.makeEnv`. Add a read-only member there if needed. Read time only from `env.now()`. No ops, events or store writes (the single allowed write is the `op.reads` cache in `mutationFacts`).
4. Pick `kind` deliberately: `packages/runtime/src/situation/facts.ts` -> `RANK` decides which facts survive the budget. A new kind needs `packages/runtime/src/types.ts` -> `FactKind`, an entry in `RANK` (typed `Record<FactKind, number>`, so the compiler forces it) and `RANK` in `training/curriculum/rt.py`.
5. Pick `neutral` deliberately: `false` makes the trigger salient, which means a model call and possibly a hold of the user's write or request. Triage is per trigger (the same repetition fact is salient on `request`, neutral on `failure`/`stall`).
6. Keep ordering deterministic: `orderFacts` sorts non-neutral first, then by rank, stable; `MAX_FACTS` = 12.
7. Check wording consumers: `packages/runtime/src/decide/report.ts` -> `topFact` and `packages/runtime/src/devtools/ui.ts` skip provenance with the regex `^This (write|request) (comes from|has no known cause)`; keep it matching.
8. Mirror the computation and ordering in `training/curriculum/rt.py` (`mutation_facts`, `request_common`, `failure_facts`, `stall_facts`, `inconsistency_facts`, `transition_facts`, `error_facts`, `order`).
9. Variant, the numbers behind facts: baseline estimators live in `packages/runtime/src/learn/baselines.ts` -> `Baselines` (latency needs ≥ 5 samples, 64-sample window, failure streak, 10 s rate), transition rarity in `packages/runtime/src/learn/profiles.ts` -> `Profiles` (`MIN_COMPLETIONS`, `RARE`). Stall timing (`RuntimeImpl.watchStall`) and several request facts read them. Tests: `learn.test.ts`, `review-precision.test.ts`, `situation.test.ts`. Class B (class A where a number is printed).

**Tests.** Add a positive test (the situation reaches `decider.calls`) and a benign test (nothing salient; pattern: `packages/runtime/test/review-precision.test.ts`). Update exact-text assertions found with `grep -rn "<old sentence>" packages/runtime/test`: typically `situation.test.ts`, `budget.test.ts`, `batch3.test.ts`, `invariants.test.ts`, `review-fetch.test.ts`, `review-hub.test.ts`, `learn.test.ts`. If a `review-*` assertion must change, raise it with the user instead of rewriting it. Paste the situations printed by `situation.test.ts` and `budget.test.ts` into the example blocks of `packages/runtime/STATUS.md`.

**Parity / retrain / release.** Follow recipe 6, "Parity" (SIM regeneration, `training/curriculum/rt.py`, retrain, new freeze tag). A threshold change alters which situations become rows even when no sentence changes.

**Gotchas.** Plugin facts are always neutral and rank last. `rt.situation()` with no argument builds an `ask` situation, which is always salient, so the devtools Now view cannot tell you whether a trigger would be salient. Facts are computed only while the runtime is consultable. Making facts non-neutral increases holds: OPEN_TASKS lists hold-induced latency (search clean p50 14 -> 125 ms with v0.1) and typeahead being salient about 6 times per clean trial.

**See.** [learn-situation-triage.md](runtime/learn-situation-triage.md#how-to-change-it-safely), [model-io-contract.md](model-io-contract.md#recipes).

### 3. Add a trigger kind

**Goal.** Add a new kind of moment at which the model is consulted (alongside `mutation`, `request`, `failure`, `stall`, `inconsistency`, `transition`, `error`, `ask`).

**Steps.**
1. Get the user's go-ahead: this adds a new question family to the model's input and needs data and retraining.
2. `packages/runtime/src/types.ts` -> `TriggerKind`. The compiler then flags every `Record<TriggerKind, …>`: `packages/runtime/src/situation/questions.ts` -> `TRIGGER_ACTIONS` (passive first), `PASSIVE`, `ACTION_INSTRUCTIONS`; `packages/runtime/src/decide/report.ts` -> `NOUN`. `packages/runtime/src/devtools/ui.ts` -> `NOUN` is a `Record<string, string>` and must be updated by hand.
3. `packages/runtime/src/situation/env.ts` -> `SubjectSpec` (the subject's shape), then `packages/runtime/src/situation/build.ts` -> `subjectOf`, `subjectOp`, `involvedStores`, `involvedFields`, `builtinApplicable`, `subjectRef` (`isTrigger` derives from `TRIGGER_ACTIONS`).
4. `packages/runtime/src/situation/facts.ts` -> a new facts function wired into `computeFacts` (recipe 2).
5. A raise site: implement `Controller` (`packages/runtime/src/decide/exec.ts`) and call `RuntimeImpl.trigger(spec, ctl, { hold, priority })` from `packages/runtime/src/runtime.ts` or an observer. Add `revertable`/`revert` only if the subject can be reverted exactly (a `revert` extends the queue deadline by `LATE_REVERT_MS`).
6. Mirrors: `sim/src/types.ts` (`TriggerKind`, `PASSIVE`), sim scenarios that can produce it and the oracle (`sim/src/oracle/diagnose.ts`, `sim/src/oracle/cost.ts`), `training/curriculum/rt.py` (`TRIGGER_ACTIONS`, `ACTION_INSTR`, a facts port), `training/curriculum/fmt.py` -> `TRIGGER_ACTIONS`, `training/eval_runtime.py` -> `PASSIVE`, devtools labels.

**Tests.** `packages/runtime/test/`: a `situation.test.ts` case (key order, section caps, first fact), a controller test in the style of `atoms.test.ts` / `fetch.test.ts` (hold, fail-open at the budget, passive on every exit), `report.test.ts` for the report noun, `devtools.test.ts` if the overlay labels it.

**Parity / retrain / release.** Class A plus a new label space: recipe 6 "Parity" in full, and the sim must be able to force every action of the new trigger.

**Gotchas.** Controllers must tolerate a second `passive()` call (`runCustom` calls it outside the guard). Priority 2 is used only for held subjects; non-held ones are capped at 1.

**See.** [learn-situation-triage.md](runtime/learn-situation-triage.md#how-to-change-it-safely), [decide-policy-actions.md](runtime/decide-policy-actions.md#how-to-change-it-safely).

### 4. Add or change a built-in action

**Goal.** (a) Change what an existing built-in action does or the `changed` sentence it reports; or (b) add a new built-in action.

**Steps for (a), mechanics.**
1. Find the controller: mutation -> `packages/runtime/src/runtime.ts` -> `RuntimeImpl.gateMutation`; inconsistency, transition and error -> `RuntimeImpl.raiseInconsistency`, `raiseTransition`, `reportError`, whose `rollback` runs `RuntimeImpl.rollback` (inconsistency: last consistent snapshot) or `RuntimeImpl.revertChain` (transition, error: the chain's own writes) and whose `resync` runs `RuntimeImpl.resync`; request, failure and stall -> `packages/runtime/src/observe/fetch.ts` -> `installFetch` (internal `reqCtl`, `failureGate`, `stallController`) and `packages/runtime/src/observe/xhr.ts` -> `installXHR` (request gate only; XHR failures and stalls are passive-only).
2. Keep the controller contract: throw when the action cannot run (the passive action then runs); return an exact `changed` sentence; provide `undo` only if the effect is truly reversible and idempotent; mark answers GenClass synthesises with `synthetic: true` and an `x-genclass` header; tolerate repeated `passive()` calls.
3. Applicability (whether it is offered) lives in `packages/runtime/src/situation/build.ts` -> `builtinApplicable`. Example open issue: `retry` is offered for any replayable fetch with `attempt < 4`, including non-idempotent POSTs (`demos/NEEDS.md` §5).

**Steps for (b), a new action.** Do not do this in the runtime alone.
1. Get the user's go-ahead (class A, new label).
2. `packages/runtime/src/situation/questions.ts` -> `BUILTIN_ACTIONS` (name, tier `guard` or `heal`, model-facing description) and `TRIGGER_ACTIONS` (passive stays first).
3. `packages/runtime/src/situation/build.ts` -> `builtinApplicable`; the controller's `run()` for that trigger (step a1).
4. `packages/runtime/src/decide/report.ts` -> `LEAD` and `packages/runtime/src/devtools/ui.ts` -> `LEAD`.
5. Sim: `sim/src/oracle/cost.ts` -> `TIER`, `sim/src/run/transform.ts` -> `ACTION_PARA`, the test double `sim/src/run/fake-runtime.ts`, and a scenario in which forcing it is meaningful.
6. Training: `training/curriculum/fmt.py` -> `ACTION_DESC` (canonical description first), `TRIGGER_ACTIONS`, `TIER`; `training/curriculum/rt.py` -> `ACTIONS`, `TRIGGER_ACTIONS`; `training/eval_runtime.py` -> `TIER` (unknown actions default to heal tier in eval).

**Tests.** `packages/runtime/test/`: `fetch.test.ts`, `xhr.test.ts`, `atoms.test.ts`, `review-fetch.test.ts`, `review-xhr.test.ts` (mechanics and `changed` text); `policy.test.ts` (tiers); `report.test.ts`, `devtools.test.ts`, `devtools-runtime.test.ts` (lead words); for a new action also `situation.test.ts` (options offered).

**Parity / retrain / release.** `BUILTIN_ACTIONS` descriptions, `TRIGGER_ACTIONS` membership/order, applicability and `ActionEffect.changed` (it reappears in later timelines) are all model input: recipe 6 "Parity". A pure mechanics change with the same `changed` text and the same applicability is class E.

**Gotchas.** The rate limiter takes its slot before the effect, so failed attempts count; a custom action calling `ctx.builtin` takes two. `coalesce` (≤ 8 s), `delay` (≤ 8 s), `retry` backoff (≤ 5 s) keep the subject waiting after the hold budget timer is cleared. Only `discard` (and a late revert), `rollback` and custom actions with `onUndo` have an undo. The known `rollback` description mismatch (it says "last consistent snapshot" but transition/error rollback restores only the chain's writes) can only be fixed as a model-input change.

**See.** [decide-policy-actions.md](runtime/decide-policy-actions.md#how-to-change-it-safely), [model-io-contract.md](model-io-contract.md#recipes), [sim.md](sim.md#how-to-change-it-safely), [training.md](training.md#how-to-change-it-safely).

### 5. Change a policy threshold or default

**Goal.** Change a default such as a gate threshold, the hold budget, the rate limit, the default mode, `settleMs` or `historySize`, or change the gate logic itself.

**Where defaults live.**

| default | value | defined in |
|---|---|---|
| `mode` | `"guard"` | `packages/runtime/src/runtime.ts` -> `RuntimeImpl` constructor |
| `settleMs`, `historySize` | 60, 500 | same constructor |
| `policy.thresholds` report / guard / heal | 0.6 / 0.9 / 0.8 | `packages/runtime/src/decide/policy.ts` -> `policyConfig` |
| `policy.holdBudgetMs` | `"auto"`: clamp(1.5 × median latency, `HOLD_MIN_MS` 150, `HOLD_MAX_MS` 800); `HOLD_FALLBACK_MS` 300 with no data | `policyConfig`, `holdBudget` |
| `maxActionsPerMinute`, `requireDiagnosis`, `holdUserWrites` | 60, true, false | `policyConfig` |
| queue: `MAX_QUEUE`, `CACHE_MAX`, `CACHE_TTL`, `LATENCY_SAMPLES`, `PROVIDER_TIMEOUT_MS` | 32, 64, 30 s, 20, 10 s | `packages/runtime/src/decide/decider.ts` |
| `LATE_REVERT_MS`, `BACKGROUND_DEADLINE_MS` | 2,000 ms, 5,000 ms | `packages/runtime/src/runtime.ts` |
| response cache and coalescing: `MAX_BODY`, `MAX_ENTRIES`, `COALESCE_WINDOW_MS`, `BUFFER_WAIT_MS`; `COALESCE_MAX_WAIT_MS` | 256 KB, 64, 2,000 ms, 1,000 ms; 8,000 ms | `packages/runtime/src/observe/cache.ts`; `packages/runtime/src/observe/fetch.ts` |
| situation budgets | 3,200 / 1,100 / 500 chars | recipe 6 (model input) |

**Steps.**
1. Change the value where it is defined (table). Options are read once in the constructor (`o.x ?? default`); only `setMode` changes behaviour live.
2. Update the JSDoc in `packages/runtime/src/types.ts` (`PolicyOptions`, `InitOptions`), `docs/runtime/API.md` ("Options", "Policy"), `packages/runtime/README.md`.
3. Gate logic: edit only `packages/runtime/src/decide/policy.ts` -> `gate`. Keep the reason strings verbatim: `policy.test.ts` and `report.test.ts` assert them, the console report prints them, devtools shows them, `demos/src/site/activity.ts` classifies decisions by the substrings `"hold budget"`, `"below the"` and `"expected"`, and the demos' results key `notExecuted` by the reason text.
4. Check the sim's forced-action contract in `sim/src/run/rt.ts` -> `createOptions` (`thresholds { report: 0, guard: 0.5, heal: 0.5 }`, `requireDiagnosis: false`, `holdBudgetMs: 1e9`, `maxActionsPerMinute: 1e9`); it must still be able to force any action.
5. Mirror gate semantics or thresholds in `training/eval_runtime.py` (`THRESH`, `decision_metrics`) and the "Runtime gate" definition in `training/EVAL.md`.

**Tests.** `packages/runtime/test/`: `policy.test.ts` (thresholds, reasons, tiers, rate limit), `budget.test.ts` (hold budget 300 / 150 / 800 / adaptive; `timeoutMs` = budget + 2,000 for held writes; expired queued items never computed), `fetch.test.ts` (request and failure gates fail open at 300 ms; it imports `MAX_BODY` / `MAX_ENTRIES`), `review-fetch.test.ts` (64 × 256 KB buffer bound), `atoms.test.ts` (provider error codes fail open at once), `report.test.ts`, `batch3.test.ts` and `review-misc.test.ts` (a provider that never answers). Cache limits also appear in `docs/runtime/API.md` (`serve_cached` row) and CONTRACT §7.

**Parity / retrain / release.** Class E for the model. Thresholds and budgets change eval comparability (tell TRAIN) and demo comparability. Triage thresholds are not policy: they are `neutral` expressions in `packages/runtime/src/situation/facts.ts` (recipe 2).

**Gotchas.** The threshold applies to the summed probability of all permitted actions, at the candidate's tier. Thresholds of 0 run the first permitted action even at probability 0 (why the sim uses 0.5). The console hint "Deny this action: `GenClass.init({ policy: { deny: [...] } })`" does nothing on a page where `GenClass.init` already ran. The auto hold budget is seeded from `status.warmupMs` until real latency samples exist. Several docs still say the hold budget default is 300 ms (CONTRACT §8, `demos/README.md`); the code default is `"auto"`.

**See.** [decide-policy-actions.md](runtime/decide-policy-actions.md#configuration-and-constants), [public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md#how-to-change-it-safely).

### 6. Change situation text, serialiser, budgets or questions

**Goal.** Change anything the model reads: fact or timeline wording, state/stats/in-flight lines, section limits or character budgets, question headers, option descriptions, diagnosis labels, formatting or redaction helpers.

**Steps.**
1. Get the user's go-ahead first. Any such change invalidates SIM phase A/B data and the final training rounds (`situation-v1`).
2. Edit only `packages/runtime/src/situation/*` plus helpers in `packages/runtime/src/util.ts`; text that reaches the model from elsewhere: `packages/runtime/src/state/fields.ts` -> `changeText`, `ActionEffect.changed` strings, observer op details (recipe 1).
3. Find the code by section:

| what | runtime | Python port (`training/curriculum/rt.py`) |
|---|---|---|
| facts | `packages/runtime/src/situation/facts.ts` (recipe 2) | `*_facts`, `request_common`, `order` |
| subject sentence | `packages/runtime/src/situation/build.ts` -> `subjectOf` | `subject_sentence` |
| timeline lines | `packages/runtime/src/situation/describe.ts` -> `eventLine`, `opPhrase`; `packages/runtime/src/situation/build.ts` -> `timelineLines` | `event_lines`, `phrase` |
| state / stats / in-flight lines | `packages/runtime/src/situation/build.ts` -> `stateLines`, `statsLines`, `inFlightLines` | `state_lines`, `stats_lines`, `in_flight_lines` |
| budgets and shrink order | `packages/runtime/src/situation/serialize.ts` -> `STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `MIN_BUDGET`, `LIMITS`, `sectionLimits`, `toJevState`; `packages/runtime/src/runtime.ts` -> `RuntimeImpl.situationBudget` | `STATE_CHAR_BUDGET`, `LIMITS`, `section_limits`, `to_state`, `BUDGETS` |
| questions | `packages/runtime/src/situation/questions.ts` -> `BUILTIN_ACTIONS`, `ACTION_INSTRUCTIONS`, `DIAGNOSIS_INSTRUCTIONS`, `DEFAULT_DIAGNOSES`, `COMPACT_QUESTIONS_BUDGET`, `buildQuestions` | `ACTIONS`, `ACTION_INSTR`, `DIAG_INSTR`, `DIAGNOSES` |
| formatters | `packages/runtime/src/util.ts` -> `secs`, `rel`, `fmtNum`, `ratio`, `plural`, `ordinal`, `truncate`, `describe` | `secs`, `rel`, `fmt_num`, `ratio`, `truncate` |
| signatures | `packages/runtime/src/util.ts` -> `normalizePath`, `isIdSegment`, `isSlugId` | `signature`, `is_id` |
| redaction | `packages/runtime/src/util.ts` -> `isSensitiveName`, `SECRET_WORDS`, `SECRET_PAIRS`, `defaultRedact` | |


4. Diagnosis labels: keep `expected` first and `transient` last (`batch3.test.ts` asserts `unusual`, `transient` are last). Also update `sim/src/types.ts` -> `DIAGNOSES`, `sim/src/world/scenario.ts` -> `DEFAULT_DIAGNOSES` and `DIAG_PARA`, `sim/src/oracle/diagnose.ts` (so the sim can emit the label), `training/curriculum/fmt.py` -> `DIAG_DESC` (canonical first).
5. Action descriptions and instructions: also `sim/src/run/transform.ts` -> `ACTION_PARA`, `training/curriculum/fmt.py` -> `ACTION_DESC` canonical first entries. Per-header calibration keys are `sha1(instructions)[:12]`, so a changed header orphans its `by_header` entry.
6. Budgets: also `sim/src/world/scenario.ts` -> `buildScenario` budget weights (3200/2000/1000 at 40/30/30), the JSDoc of `InitOptions.situation` in `packages/runtime/src/types.ts` (currently drifted), `docs/runtime/API.md`, and check token lengths against the model's `meta.max_len` (TRAIN measured about 2.4 chars/token).
7. Redaction: also `docs/runtime/API.md` "Privacy".

**Tests.** `packages/runtime/test/`: `situation.test.ts`, `budget.test.ts`, `batch3.test.ts`, `invariants.test.ts`, `review-fetch.test.ts`, `review-hub.test.ts`, `learn.test.ts`, `review-redaction.test.ts` (for redaction), `report.test.ts` / `atoms.test.ts` / `fetch.test.ts` (for `changed` text); then the full suite. Update the STATUS.md example blocks from the printed situations. **[ask first]** `sim/test/rows.test.ts`, `determinism.test.ts`, `oracle.test.ts` with `SIM_RUNTIME=real`; `training/tests/test_curriculum.py` both with and without `GC_P_RUNTIME=1` (the default run never exercises `rt.py`).

**Parity / retrain / release (the full follow-up for any class A change).**
1. Re-port `training/curriculum/rt.py` and render a few rows per budget against `sim/samples/sample.jsonl`.
2. **[ask first]** Rebuild the runtime and regenerate SIM data (recipe 17) and `sim/samples/*`.
3. **[ask first]** Regenerate a curriculum replay set with `--p-runtime 0.8`, retrain, then evaluate, calibrate and export (recipe 18).
4. The lead tags a new freeze (the `situation-v1` convention; no v2 exists). Re-run the demos with the new model (recipe 22).

**Gotchas.** `packages/runtime/src/situation/serialize.ts` -> `stateText` (public; `explain()`, devtools, STATUS) indents list items and is not the token text; the packer uses `packages/runtime/src/model/serialize.ts` -> `segmentText`. `COMPACT_BUDGET` (1,100, section sizes) and `COMPACT_QUESTIONS_BUDGET` (1,400, bare labels) are different constants; keep both. Situation building must stay deterministic and side-effect free, or the sim's prefix check drops trajectories. Python rows must print integral floats as ints (`training/curriculum/fmt.py` -> `js_numbers`). Known `rt.py` gaps: fact shortening floor 40 vs 60 chars, half-even vs half-up rounding on exact ties. Avoid plugin question ids `action` and `diagnosis`.

**See.** [model-io-contract.md](model-io-contract.md#how-to-change-it-safely), [learn-situation-triage.md](runtime/learn-situation-triage.md#how-to-change-it-safely), [status-and-known-issues.md](status-and-known-issues.md#how-to-change-it-safely), [training.md](training.md#how-to-change-it-safely).

### 7. Change the state pipeline or invariants

**Goal.** Change how writes are proposed, held, applied, patched or reverted; fix the open user-write ordering risk (`demos/NEEDS.md` §1); add an invariant template; change flattening caps; handle dotted store names.

**Steps.**
1. **Bypass, hold and late-revert rules:** `packages/runtime/src/state/hub.ts` -> `StoreHub.propose` (the `bypass` expression: user-sync writes unless `policy.holdUserWrites`, GenClass writes, stores with `hold: false`, and any write while paused or destroyed), `StoreHub.revertable`, and `packages/runtime/src/runtime.ts` -> `LATE_REVERT_MS`. These are policy-visible: update `docs/runtime/API.md` "State".
2. **User-write ordering fix (`demos/NEEDS.md` §1, open):** in `StoreHub.propose`, when a bypass write targets a store whose `queue` is non-empty, either apply the pending writes first in proposal order, or mark the overlapping held writes superseded and re-gate them. Add the regression test demos suggests (hold a functional write to `s.x`, make a user-sync write to `s.x`, release with `apply`, expect the user's value) and update `atoms.test.ts` "functional updates re-run against the value at apply time", which asserts the current order.
3. **Invariant template:** `packages/runtime/src/state/invariants.ts` -> extend `Tpl`, implement it in `InvariantMiner.holds` (null when not applicable), `nonTrivial`, `valuesText` and `propose` with a deterministic id and readable text; put per-array work in `ArrayStats` so it runs once per array version.
4. **Flattening caps or hashing:** `packages/runtime/src/state/fields.ts` -> `MAX_DEPTH`, `MAX_KEYS_EXPAND`, `MAX_FIELDS_PER_STORE`, and the sampling and hashing helpers.
5. **Patch semantics:** `packages/runtime/src/state/fields.ts` -> `patchValue`; keep "removals first; never remove a path with a set beneath it".
6. **Dotted store names:** nothing enforces "no `.` in store names", and every path lookup splits on `.`. Either validate in `RuntimeImpl.atom` / `guard` / `adapter` (prefer a console warning and a sanitised name; throwing breaks apps) or pass the store explicitly instead of `path.split(".")[0]`. Fix the `packages/runtime/README.md` and `packages/runtime/src/adapters/react.ts` header examples (`"search.results"`).
7. **Settled points and snapshots:** `RuntimeImpl.settled`, `RuntimeImpl.busy`.

**Tests.** `packages/runtime/test/`: `atoms.test.ts`, `review-hub.test.ts`, `invariants.test.ts`, `adapter-seam.test.ts`, `adapters-react.test.ts`, `adapters-redux.test.ts`, `adapters-zustand.test.ts`, `review-perf.test.ts`, `review-precision.test.ts`, `situation.test.ts`, `batch3.test.ts`, `policy.test.ts`, `learn.test.ts`, `review-actions.test.ts`; then the full suite. A new template needs a learning test and a precision test (no false `inconsistency` on benign behaviour).

**Parity / retrain / release.** Template text, flattening and `changeText` output appear verbatim in situations: class A. Bypass/hold/ordering fixes change no text but change sim dynamics (class B): tell SIM and TRAIN. Re-run the demos' board trials to measure §1 (recipe 22).

**Gotchas.** `review-perf.test.ts` asserts wall-clock budgets on 5,000-item stores (< 1 ms per keystroke write, < 16 ms per settled point); any O(n) per-write work (hashing, cloning, `JSON.stringify`) breaks them, and they can flake on a loaded machine. Updaters may run several times and must be pure. Rollback for `inconsistency` restores whole stores; error/transition rollback is field-precise.

**See.** [state-and-adapters.md](runtime/state-and-adapters.md#how-to-change-it-safely).

### 8. Add or change a framework adapter

**Goal.** Integrate another state library (MobX, Jotai, Valtio, …) through `runtime.adapter`, or change the React, Redux or Zustand adapter.

**Steps.**
1. Add `packages/runtime/src/adapters/<lib>.ts`. Call `runtime.adapter(name, { get, set?, subscribe? }, opts)` once per store (`packages/runtime/src/types.ts` -> `Runtime.adapter`, `AdapterIO`, `AdapterHandle`).
2. Route every app write through `handle.propose({ fn | value, commit })`. `commit(next)` must write to the library store synchronously; it runs later for held writes and never for discarded ones. Provide `set` if GenClass may write whole states (rollback, resync); without it the store is not writable.
3. Build and package: `packages/runtime/tsup.config.ts` -> `entry` and `dts.entry` (keep the literal `"src/...ts"` strings: `packages/runtime/test/browser/build.mjs` finds them with a regex), the library in `external`; `packages/runtime/package.json` -> an `exports` subpath (`types` + `import`), an optional `peerDependencies` entry plus `peerDependenciesMeta`, and the library as a devDependency for tests.
4. If the demos use it: a shim in `demos/src/dev/runtime-shim/`, an alias in `demos/vite.config.ts`, a path in `demos/tsconfig.shim.json`.
5. Changing an existing adapter: keep its contracts (commit exactly once on apply, never on discard; Redux reducer once per applied dispatch and inner enhancers see the original action; Zustand commits with `replace = true` and forwards extra `set()` arguments; React: one atom per (runtime, name), plain `useState` fallback without a runtime). Update the file's header comment and API.md "Adapters and devtools".

**Tests.** Model the new file on `packages/runtime/test/adapters-zustand.test.ts`: `MockRuntime` (`holdWrites`, `flushHeld`, `dropHeld`, `genclassWrite`) plus one test against the real runtime with `ManualDecider`. Run `adapter-seam.test.ts`, the `adapters-*.test.ts` files and `review-perf.test.ts`. Build with `npx tsup`. **[ask first]** `cd packages/runtime && bash test/smoke/smoke.sh` after adding an import of the new subpath to the `src/main.js` that `packages/runtime/test/smoke/smoke.sh` generates.

**Parity / retrain / release.** Class E. A new subpath is a public-surface change: update API.md, the package README and the "Extra public surface" bullet under STATUS "Deviations from the contract (and why)".

**Gotchas.** Redux and Zustand capture `runtime` when the store is created, so `genclass(GenClass.runtime, …)` evaluated before `GenClass.init()` gets `null` and is never guarded. Store names are global per runtime across kinds: reusing a name re-registers the store and orphans old handles. A library listener that throws inside `commit` looks like a failed setter.

**See.** [state-and-adapters.md](runtime/state-and-adapters.md#how-to-change-it-safely), [build-test-release.md](runtime/build-test-release.md#add-a-public-entry-point-new-subpath-export).

### 9. Add a public API method, option, event or subpath export

**Goal.** Extend the public surface of `@genclass/runtime`.

**Steps.**
1. **Init option:** add the field with a JSDoc default to `packages/runtime/src/types.ts` -> `InitOptions` (or `CreateOptions` if headless-only); read it once in the `RuntimeImpl` constructor with an explicit default; check the four creation paths in `packages/runtime/src/index.ts` -> `initUnsafe` (browser, non-browser, kill-switch `off`) and the `GenClass.init` fallback, and decide whether the option survives each. Host-only model options: recipe 12.
2. **`Runtime` method:** add it to `packages/runtime/src/types.ts` -> `Runtime` and implement it in `packages/runtime/src/runtime.ts` -> `RuntimeImpl`. Update every other implementer by hand: `packages/runtime/test/browser/ui/mock-runtime.ts` -> `MockRuntime` and `demos/src/dev/runtime-shim/index.ts` -> `ShimRuntime` (which already lacks `adapter`, `holdBudgetMs`, `situationBudget`). Add it to `sim/src/run/rt.ts` -> `RuntimeLike` only if the sim calls it. Keep it non-throwing if devtools will call it (devtools wraps calls in `safe()`).
3. **Changing an existing method or option:** find callers outside `src/`: the sim (loaded by module name via `GENCLASS_RUNTIME`, so a break shows only at sim run time), `MockRuntime`, `ShimRuntime`, `packages/runtime/src/devtools/index.ts`, `packages/runtime/src/adapters/react.ts` -> `useRuntimeList`.
4. **Event type:** add the key and payload to `packages/runtime/src/types.ts` -> `RuntimeEvents`, add a `Set` for it in `RuntimeImpl`'s `listeners` initializer (otherwise `on(newType)` throws), fire it with `RuntimeImpl.fire`. Update `packages/runtime/src/devtools/index.ts` -> `subscribe` and its unmount test list if the overlay should react.
5. **Error class:** runtime-level errors live in `packages/runtime/src/errors.ts`; model errors in recipe 12. Re-export from `packages/runtime/src/index.ts`.
6. **Subpath export:** `packages/runtime/package.json` -> `exports` (`"./<name>": { "types": "./dist/<name>.d.ts", "import": "./dist/<name>.js" }`), `packages/runtime/tsup.config.ts` -> `entry` and `dts.entry`, externalise any new peer library; demos shim and aliases if demos use it (recipe 8 step 4).
7. Time-dependent behaviour uses `this.clock.now()` / `this.clock.setTimeout` / `this.clock.afterTask`; store the handle and clear it in `RuntimeImpl.destroy`.
8. **Kill switch or init paths:** `packages/runtime/src/index.ts` -> `killSwitch`, `initUnsafe`; keep everything inside the try/catch of `GenClass.init`. **`destroy()`:** `RuntimeImpl.destroy` must stay idempotent, clear every new timer, uninstall observers in reverse order and dispose only a decider it created (`createRuntime` with `model: {...}` and no `decider`).
9. Docs: JSDoc in `packages/runtime/src/types.ts`, `docs/runtime/API.md`, `packages/runtime/README.md`, `packages/runtime/STATUS.md` ("Deviations" lists the public surface beyond CONTRACT §2), [public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md).

**Tests.** A test using `setup({ ...option })` from `packages/runtime/test/helpers.ts`. Lifecycle changes: `report.test.ts` ("GenClass.init and the kill switch"), `batch3.test.ts` ("lifecycle"), `dom.test.ts` / `fetch.test.ts` / `xhr.test.ts` (destroy restores globals), `review-misc.test.ts`. Build with `npx tsup` for export changes; **[ask first]** `cd packages/runtime && bash test/smoke/smoke.sh`.

**Parity / retrain / release.** Only if the option alters situation text or decisions: then coordinate with SIM (`sim/src/run/rt.ts` -> `createOptions`) and treat it as class A/B. Public-surface changes go into the next release notes (recipe 19).

**Gotchas.** `GenClass.init` is idempotent: later calls ignore their options. `createRuntime` can throw on malformed options; `GenClass.init` never does (inert fallback). Any non-`undefined` `decider` (including `null`) disables model creation. `on("status")` also fires on `setMode`. `decisions(0)` returns the whole buffer.

**See.** [public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md#how-to-change-it-safely), [build-test-release.md](runtime/build-test-release.md#add-a-public-entry-point-new-subpath-export).

### 10. Add a custom action, standing question or plugin (app side)

**Goal.** Extend GenClass from application code, without changing the runtime: an app capability the model may choose, an extra question per trigger, extra facts or an app-specific signal source.

**Steps.**
1. Write a `Plugin` (`packages/runtime/src/types.ts` -> `Plugin`: `name`, `setup?(api)`, `facts?(sit)`, `actions?`, `questions?`, `diagnoses?`) and pass it as `GenClass.init({ plugins: [p] })` or `rt.use(p)`. Single pieces: `rt.action(def)`, `rt.question(def)`. Reference app: `demos/src/demos/decisions/plugin.ts` -> `backgroundWorkPlugin`.
2. **Custom action** (`ActionDef`): `name`, `description` (the model reads it), `on: TriggerKind[]`, `tier` (default `"heal"`), optional `applicable(sit)`, `run(ctx)`. In `run`, call `ctx.describe(changed)` with exactly what changed, `ctx.onUndo(fn)` if reversible, and `ctx.builtin("<name>")` to delegate to a built-in (re-checked against mode, policy and rate, not thresholds). The passive action runs afterwards unless a built-in took over.
3. **Standing question** (`StandingQuestion`): `id`, `on`, `question` (`{ type: "noul" | "choice" | "score", instructions, criteria }`), `always?` (ask even when triage finds nothing salient), `onAnswer(answer, ctx)` (runs before any action).
4. **Facts and signals:** `facts(sit)` returns strings (always neutral, ranked last, cut first by the budget). In `setup(api)`, use `api.clock`, `api.emit`, `api.recordOp` / `api.endOp` / `api.runInOp` for app ops, and return a cleanup function.
5. One-off questions: `rt.ask(question, { about, timeoutMs })` and `rt.decide(question, options)`.
6. Changing the plugin API itself (runtime side, CORE): `packages/runtime/src/runtime.ts` -> `RuntimeImpl.runCustom`, `action`, `question`, `use`, `pluginApi`; offering in `packages/runtime/src/situation/build.ts` -> `buildSituation`. Tests: `plugins.test.ts`, `batch3.test.ts`, `review-misc.test.ts`.

**Tests.** Pattern: `packages/runtime/test/plugins.test.ts` (custom action runs then passive, `ctx.builtin`, default heal tier, `applicable`, standing questions and `onAnswer`, `setup` cleanup, vocabulary overrides). In an app, verify with `rt.explain(id)` and the devtools overlay.

**Parity / retrain / release.** No retrain is needed: the model reads the description at runtime. Answer quality on custom actions and questions is unmeasured.

**Gotchas.** Custom actions are gated at their own tier (default heal, so guard mode never runs them). At budgets ≤ 1,400 characters (`COMPACT_QUESTIONS_BUDGET`), custom descriptions are sent as `null` unless a `vocabulary.actions` override of ≤ 24 characters exists, so the model sees only the name. Avoid question ids `action` and `diagnosis`. A non-iterable `plugins`, `actions` or `questions` throws inside the constructor after observers were installed (`GenClass.init` then returns an inert runtime). Custom actions can hold a subject indefinitely. Nothing acts until a model is loaded (see recipe 25 step 1).

**See.** [decide-policy-actions.md](runtime/decide-policy-actions.md), [public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md), [`docs/runtime/API.md`](../runtime/API.md) "Plugins".

### 11. Add or change a devtools view

**Goal.** Change the overlay (`@genclass/runtime/devtools`): add a tab, show a new `Decision` / `ActionRecord` field, change report wording, add a mount option, change styling.

**Steps.**
1. **New tab:** `packages/runtime/src/devtools/index.ts` -> extend `DevtoolsTab` and `TABS` (keep `interventions` and `detections` first: the counters read `tabBtns[0]` and `tabBtns[1]`), add a pane in the constructor's `panes` record. If it polls the runtime, gate it like `renderNow` (open, tab selected, not paused, not dead) and refresh it from `startTicking`. Widen the `tab` union in `demos/src/dev/runtime-shim/devtools.ts`.
2. **New field on cards or evidence:** render it in `card()` or `evidence()` with `h()` and `text` (no `innerHTML`). Add the field to `makeDecision` / `makeAction` in `packages/runtime/test/browser/ui/mock-runtime.ts` and set it in `packages/runtime/test/browser/ui/scenario.ts`.
3. **Mount option:** `DevtoolsOptions` with a JSDoc default, read in the `Devtools` constructor; mirror it in `demos/src/dev/runtime-shim/devtools.ts`.
4. **Report wording:** runtime sentences come from `packages/runtime/src/decide/report.ts` -> `interventionLine`, `detectionLine`. Keep `packages/runtime/src/devtools/ui.ts` -> `splitReport` regexes able to strip the `[GenClass]` prefix, the `(diag, p; action p)` tail, `Not acted on (…): …` and the `(×N …)` suffix; keep `packages/runtime/src/devtools/ui.ts` -> `LEAD` / `NOUN` aligned where the same wording is intended.
5. **Activity kinds and filters:** `packages/runtime/src/devtools/ui.ts` -> `KIND_LABEL`, `OP_LABEL`, `eventText`, `groupOf`; `packages/runtime/src/devtools/index.ts` -> `FILTERS`; badge rules in `packages/runtime/src/devtools/css.ts`.
6. **Styling:** edit `packages/runtime/src/devtools/css.ts` only; add tokens to both `LIGHT` and `DARK`; never add selectors for `html`, `body` or `:root`.
7. **New runtime event:** `packages/runtime/src/types.ts` -> `RuntimeEvents` (CORE), then `packages/runtime/src/devtools/index.ts` -> `subscribe` through the local `on()` wrapper; update the unmount test's listener list.
8. **Cards recorded before mount** (`packages/runtime/UI-NEEDS.md` item 3): in `card()`, when the report sentence is missing, fall back to `this.rt.explain(id)?.message` inside `safe()`; then update the "reports emitted before mounting are not replayed" assertion in `devtools.test.ts`, the `.cx` body expectations in `devtools-runtime.test.ts`, and add `message` to the explanations built in `packages/runtime/test/browser/ui/scenario.ts`.
9. **Runtime-side report wording** changes (`packages/runtime/src/decide/report.ts`) also need `report.test.ts`, `atoms.test.ts` (late-revert line) and `review-misc.test.ts` updated.

**Tests.** `packages/runtime/test/`: `devtools.test.ts` (against `MockRuntime` + `loadScenario`) and `devtools-runtime.test.ts` (real runtime via `runStoreSession`); `dom.test.ts` if you touch the ignore attribute; the `adapters-*.test.ts` files if you touch `mock-runtime.ts`. **[ask first]** `npx playwright test --config test/browser/ui/playwright.config.ts` from `packages/runtime` regenerates the 18 PNGs in `test/browser/ui/screenshots/` (written, never compared); review and commit them only if intended.

**Parity / retrain / release.** Class E, unless the field comes from a CORE change that alters situations. Bundle size matters (devtools ~68 KB unminified in the local build).

**Gotchas.** The overlay uses only the public `Runtime` API; it must not import runtime internals. Tests are not type-checked, so `MockRuntime` drifts silently. `npm run test:browser` also runs the UI spec with different viewport settings and overwrites the screenshots: use the UI config.

**See.** [devtools.md](runtime/devtools.md#how-to-change-it-safely).

## Recipes: model host and parity

### 12. Change model loading or backends

**Goal.** Change how the model is fetched, cached, verified or run: host options, WebGPU/WASM plan order, worker protocol, model errors, onnxruntime-web version, the `genclass-runtime` CLI, or self-hosting.

**Steps.**
1. **Host option:** `packages/runtime/src/model/host.ts` -> `ModelHostOptions`; if it must reach the worker, also `packages/runtime/src/model/backend.ts` -> `BackendLoadOptions` (structured-cloneable values only) and the `Host` constructor's `loadOptions`; if apps set it through `GenClass.init`, also `packages/runtime/src/types.ts` -> `ModelOptions` and API.md.
2. **Plan order or device semantics:** `packages/runtime/src/model/loader.ts` -> `planOrder` (the ORT build choice follows). Keep `wasm` as the last plan for `"webgpu"`.
3. **Worker protocol message:** `packages/runtime/src/model/protocol.ts`, the switch in `packages/runtime/src/model/worker.ts`, `packages/runtime/src/model/host.ts` -> `InlineTransport` (keep both transports identical) and the host's message handler. Every request gets exactly one `result`.
4. **Model error:** `packages/runtime/src/model/errors.ts` -> `ModelErrorCode`, the class, the `deserializeError` switch (otherwise it crosses the worker boundary as a plain `Error`); re-export from `packages/runtime/src/index.ts` and `packages/runtime/src/model/index.ts`. Special runtime handling: see the `max_tokens_exceeded` handler in the `RuntimeImpl` constructor.
5. **New graph input or head:** `packages/runtime/src/model/engine.ts` -> `FEEDS`, `OUTPUT_KIND`; `packages/runtime/src/model/packer.ts` -> `planInputs`, `unpackLogits`; `packages/runtime/src/model/serialize.ts` -> `BlockKind`, `questionBlock`; `packages/runtime/src/model/calibrate.ts` -> `calibrateLogits`, `buildAnswer`; the `Question` / `Answer` types in `packages/runtime/src/types.ts` (the CORE/MODEL seam, mirrored by `sim/src/types.ts`). This is also a training change (recipe 13).
6. **onnxruntime-web upgrade:** `packages/runtime/package.json` (`^1.30.0`), `packages/runtime/src/model/backend.ts` -> `ORT_FALLBACK_VERSION`, check `ORT_WASM_FILES` names exist in the new `dist/`, keep the externals, update the browser-test regex expecting `onnxruntime-web@1.30.x` and the pinned `onnxruntime-node` devDependency.
7. **CLI:** `packages/runtime/bin/genclass-runtime.mjs` (`fetch-model`, `info`); keep its `parseCard` in sync with `packages/runtime/src/model/loader.ts` -> `parseCard`. There are no automated CLI tests.
8. **Default model URL:** `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` and `packages/runtime/bin/genclass-runtime.mjs` -> `DEFAULT_FROM` (recipe 20). Shipping a different architecture (R17 vs R32, a new export) needs no code change when the export follows the card format and `meta.json` declares `inputs`, `outputs`, `markers`, `cls_id`, `sep_id`, `max_len`, `max_total`; device-based model selection (OPEN_TASKS item 5) is not implemented and would need card support plus a `planOrder` change.
9. **Self-hosting (app integration):** `npx genclass-runtime fetch-model public/genclass-model --from <dir URL with model.json>` **[ask first]** (download); copy both `ort-wasm-simd-threaded.wasm` and `ort-wasm-simd-threaded.asyncify.wasm` from `node_modules/onnxruntime-web/dist/`; `GenClass.init({ model: { baseUrl: "/genclass-model/", ortWasmPaths: "/ort/" } })`; serve COOP/COEP for WASM threads.

**Tests.** Local, no model files needed: `packages/runtime/test/model/`: `host.test.ts` (fake worker: queue, timeouts, crash, WASM retry, inline fallback, errors across the boundary), `loader.test.ts` (card parsing, `planOrder` matrix, cache and sha256), `engine.test.ts` graph-contract test. **[ask first]** `npm run test:browser` (needs a model directory and Playwright Chromium; rebuilds `dist/`).

**Parity / retrain / release.** Loading and transport changes are class E. Graph inputs and heads require a new export and retraining.

**Gotchas.** `evaluate()` never waits: before `ready` it rejects at once with `ModelNotReadyError`, and while the host is `loading` or `error` the runtime builds no situations. Keep `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` and the two `import("onnxruntime-web/webgpu")` / `import("onnxruntime-web/wasm")` literals verbatim: bundlers split on them and `packages/runtime/test/browser/build.mjs` fails without them. `packages/runtime/src/model/worker.ts` must stay inert in ORT's own worker threads (`em-pthread`, `ort-wasm-proxy-worker`). Downloads use the native fetch (`NATIVE_FETCH` or the worker realm), never the instrumented one. One inference at a time; a hung forward pass blocks the host (no watchdog). The WASM retry happens once per host lifetime.

**See.** [model-host.md](runtime/model-host.md#how-to-change-it-safely).

### 13. Change the packer, tokenizer, serializer or calibration

**Goal.** Change how a situation becomes token ids or how logits become calibrated answers. These TypeScript files are byte-exact ports of Python in `jev_local/`.

**Steps.**
1. Get the user's go-ahead (class C or D; class C requires retraining when the Python side changes).
2. Change both sides in the same change: `packages/runtime/src/model/{serialize,pyutil,tokenizer,packer}.ts` with `jev_local/serialize.py` and `jev_local/engine/encoder/tokenize_pack.py`; `packages/runtime/src/model/calibrate.ts` with `jev_local/engine/encoder/calibrate.py` and `jev_local/confidence.py`.
3. Keep v1 calibration files loadable; keep the documented Jev answer rows within ±0.01 (`jev_local/confidence.py`; tested by `tests/test_confidence.py`).
4. Regenerate the fixtures (recipe 14) and, for a token-id change, re-export a model so the export's own fixtures and `parity.json` reflect the new layout.
5. Recalibration only (no code change): `$PY training/eval_runtime.py --ckpt … --data … --fit-split dev --write-calibration cal.json`, then `$PY training/export_runtime.py … --calibration cal.json` **[ask first]** (recipe 18).

**Tests.** Local (fixtures committed): `packages/runtime/test/model/`: `serialize.test.ts`, `calibrate.test.ts` (7 of 8 run without model files), `packer.test.ts` and `engine.test.ts` parity need a model directory **[ask first]**. Python: `tests/test_encoder_pack.py`, `test_encoder_model.py`, `test_encoder_engine.py`, `test_serialize_w8.py`, `test_confidence.py`, `test_train_v2_engine.py` **[ask first]** (Python environment with torch).

**Parity / retrain / release.** Token-id changes invalidate trained weights: retrain and re-export (recipe 18), new freeze. Calibration changes alter intervention rates: re-run `training/eval_runtime.py` and compare FIR/precision before shipping.

**Gotchas.** JavaScript cannot print `25.0`; Python-generated rows must write integral floats as ints. Nothing about the vocabulary is hardcoded: marker, CLS and SEP ids come from `meta.json` / `tokenizer.json`; keep it that way. The runtime bounds state + longest branch (`meta.max_len`), the trainer bounds the whole question block: length semantics differ. The extension's JS copies (`extension/src/model/`) are the ancestors; the runtime TS copy is the maintained one.

**See.** [model-host.md](runtime/model-host.md#how-to-change-it-safely), [model-io-contract.md](model-io-contract.md#invariants-and-gotchas), [genclass-model-lineage.md](genclass-model-lineage.md#how-to-change-it-safely).

### 14. Regenerate model parity fixtures

**Goal.** Refresh the Python-generated fixtures that pin the TypeScript model code to the Python reference.

**Steps.**
1. **`py_fixtures.json`** (serialize, pruned tokenizer, calibration and confidence cases) **[ask first]**: needs the jev venv (`tokenizers`, `numpy`, `pydantic`) and the v0.1 tokenizer:
   `~/jev/.venv/bin/python packages/runtime/test/fixtures/model/make_py_fixtures.py --tokenizer <model dir>/tokenizer.json --out packages/runtime/test/fixtures/model/py_fixtures.json`. It also reads `<model dir>/calibration.json` when present. The script imports `jev_local` from the repo root (`ROOT = parents[5]`), so do not move it.
2. **`pack_fixtures.json` / `torch_fixtures.json`** are outputs of either v1 exporter, `scripts/genclass_export.py` or `extension/tools/genclass_export.py` (both export the extension's v1 model, import torch and say "RUN ON THE AZURE VM ONLY"; their fixture-writing code in `main` is identical and does not depend on the int8 vs q8 ONNX export; which one produced the committed files is not recorded) **[ask first]**, copied from `extension/test/fixtures/` and re-serialised compactly (no whitespace). Never hand-edit them. Regenerate `requests50.json` from the same request set.
3. **An export's own fixtures:** `training/export_runtime.py` writes `requests.json`, `pack_fixtures.json`, `torch_fixtures.json` and `parity.json` into the model directory; `packages/runtime/test/model/helpers.ts` uses them automatically when all three exist (`FIXTURES_FROM_MODEL`).
4. **WebGPU embedding variants** (outside the repo, used via `GENCLASS_WEBGPU_VARIANTS`) **[ask first]**: `~/jev/.venv/bin/python packages/runtime/test/fixtures/model/make_webgpu_variants.py --src <runtime-card model dir with a q8 variant> --out <dir>` (needs `onnx`, `numpy`); writes `f32emb/` and `i8emb/`.

**Tests.** `packages/runtime/test/model/` `serialize.test.ts`, `calibrate.test.ts`, `packer.test.ts`, `engine.test.ts` with `GENCLASS_MODEL_DIR` **[ask first]**.

**Parity / retrain / release.** Fixtures only document parity; regenerating them never fixes a parity break.

**Gotchas.** The committed fixture JSON files are single-line (`wc -l` prints 0); compare parsed JSON, not hashes. The browser specs always read the v0.1 fixtures (`test/browser/model-helpers.ts`), so their parity assertions only hold for the v0.1 model. `pythonOnlyFloatRequests` needs Node ≥ 21.

**See.** [build-test-release.md](runtime/build-test-release.md#regenerate-model-fixtures).

## Recipes: sim

All sim runs are **[ask first]**. Before any sim change, read the matching test in `sim/test/`. Check-out sequence after the change: `npm run build` (runtime) then, in `sim/`, `npx tsup`, `SIM_RUNTIME=real npx vitest run`, `node dist/smoke.js --seeds 40` (check `internal errors` and correlation `*:none` counts), a small `gen.js` run and `python3 scripts/analyze.py <out>`.

### 15. Add a sim feature module

**Goal.** Add a feature combinator (a new kind of app behaviour with guards or injected defects), a domain, or a knob on an existing feature.

**Steps.**
1. New `sim/src/app/features/<kind>.ts` exporting a `FeatureDef` (`sim/src/app/feature.ts`); register it in `sim/src/app/features/index.ts` -> `FEATURES` and `FEATURE_WEIGHTS`.
2. Server routes via `srv.route(method, naming.route(...), handler, { feature, kind, idempotent, resource })`. Client state via `env.store(name, s.id, init, { weights, resync })`. Requests only via `Kit.op` + `Kit.call`; writes only via `Kit.write` with `role`, `intent`, `key`, `op` (`sim/src/app/kit.ts`).
3. Ground truth: set `dupOf` for accidental repeats, `anomaly: "partial"` on writes that skip derived fields, `classify` where `ContentBook` decides stale/conflict/duplicate; declare `relations()` for derived fields; surface failures with `kit.shownError()` or `kit.spawn(fn, "uncaught", …)`.
4. New data roles go into `sim/src/oracle/diagnose.ts` -> `DATA_ROLES`. Consider a held-out pattern in `sim/src/world/scenario.ts` -> `TEST_PATTERNS`.
5. Randomness only from the spec rng in `make`, `user.rng` in `session`, and keyed `env.rng.fork(<key>)` at run time. For a knob on an existing feature, append the draw at the end of `make()` (inserting one shifts every later knob).
6. Domain: append `D(...)` with two entities in `sim/src/app/vocab.ts` -> `DOMAINS`; optionally hold it out in `TEST_DOMAINS`.

**Tests.** `sim/test/oracle.test.ts` cases via `mini(kind, patch, opts)` from `sim/test/helpers.ts` (expected diagnosis, cheapest action); `rows.test.ts`, `determinism.test.ts` with `SIM_RUNTIME=real` **[ask first]**.

**Parity / retrain / release.** Every seed's world changes (keyed picks depend on array lengths): regenerate all data and `sim/samples/*`; never mix rows from different sim versions under one seed range.

**Gotchas.** An `anomaly` passed to `Kit.op` is silently dropped (`OpInit` has no such field); the poll feature's `storm` anomaly never reaches the oracle for this reason. Error-message fields must have weight 0. The ideal run has no runtime and skips accidental steps, so `dupOf` / `accidental` must be right.

**See.** [sim.md](sim.md#how-to-change-it-safely).

### 16. Change sim oracle, labelling, ask questions or splits

**Goal.** Change how rows are labelled (cost weights, label parameters, diagnosis rules), add an `ask` question generator, change chaos, budgets or splits.

**Steps.**
1. **Cost weights:** `sim/src/oracle/cost.ts` -> `W`; update `sim/test/oracle.test.ts` and the README formula; regenerate data.
2. **Label parameters only:** `sim/src/oracle/cost.ts` -> `LABEL` (premiums, tie rule, tau). These can be re-derived offline from `meta.cost_futures` with `actionLabel`, without re-simulating; re-apply option drops recorded in `meta.transform` (`drop:<action>`).
3. **Diagnosis rules:** `sim/src/oracle/diagnose.ts` -> `diagnose`, `diagnoseFailure`, or a feature's `classify`. Diagnosis also changes exploration, point sampling and `fake_diagnosis`, so action rows change too.
4. **Ask questions:** a generator in `sim/src/ask/questions.ts` -> `GENS` returning `{ qid, question, label, kind }`; check the evidence appears in the serialised state and skip borderline timings.
5. **Chaos and network:** `sim/src/world/scenario.ts` -> `makeNet` (parameters), `sim/src/net/network.ts` -> `Network` (mechanics). Keep every draw keyed and ideal-mode draw counts stable; keep `NetEntry.cause` / `slowCause` accurate (diagnoses read them).
6. **Budgets:** `buildScenario` budget weights; coordinate with per-budget eval in `training/eval_runtime.py` and the runtime's auto budgets.
7. **Splits:** `sim/src/world/scenario.ts` -> `TEST_DOMAINS`, `TEST_PATTERNS`, `familyHeldOut`, `splitOf` (and their salts). Moves whole trajectories between splits; old datasets become incomparable.
8. **Runtime contract** (option names, thresholds, hooks): `sim/src/run/rt.ts` -> `createOptions`, `RuntimeLike`, and `sim/src/types.ts`.

**Tests.** `sim/test/oracle.test.ts` (expected diagnoses and cheapest actions; 2 cases run only with `SIM_RUNTIME=real`), `rows.test.ts` (labels reference offered options, dists sum to 1, split counts over 400 seeds), `determinism.test.ts` **[ask first]**.

**Parity / retrain / release.** Labels and targets change: regenerate data and retrain. Gate thresholds in `createOptions` must stay 0.5 with `requireDiagnosis: false`.

**Gotchas.** `x-request-id` is the sim's correlation header; it must stay in the runtime's volatile header list and never appear in a state (`rows.test.ts` asserts it). Correlation is synchronous: the runtime's `opCreated` / `mutationProposed` hooks must fire inside the sim's calls.

**See.** [sim.md](sim.md#how-to-change-it-safely), [model-io-contract.md](model-io-contract.md).

### 17. Generate a data set

**Goal.** Produce CONTRACT-D rows (`{ id, split, family, state, questions, labels, meta }`) from the sim. **[ask first]** for every step: generation is CPU-heavy and the original team ran it only on the VM.

**Steps.**
1. Build the runtime first (`npm run build` at the repo root; `sim` resolves `@genclass/runtime` through `packages/runtime/dist/`), then the sim: `cd sim && npx tsup`.
2. Samples: `node dist/gen.js --sample --workers 8` writes `sim/samples/sample.jsonl`, `EXAMPLES.md` and `sample-stats.json`.
3. A custom run: `node dist/gen.js --rows <N> --out <dir> --seed <S> --workers <W>` (other flags: `--max-points`, `--test-keep`, `--explore`, `--no-ask`, `--parts`, `--chunk`, `--merge-only`; `--allow-fake` only for tests). Output: `<dir>/{train,dev,test}.jsonl` + `stats.json`.
4. Final datasets: `bash sim/scripts/final.sh a` (600k rows, seeds from 10,000,000, `sim/out/final-a`), `final.sh b` (1.4M rows, seeds from 50,000,000, resumable parts of 100 seeds), `final.sh merge-b`. Splitting across machines needs disjoint seed ranges.
5. Summarise: `python3 sim/scripts/analyze.py <dir>` (prefers merged files over `parts/`).

**Tests.** Check `stats.json`: drops (phase A only had `diagnosis-not-in-vocab`), 0 errors, `subject_correlated` 100%, passive-best shares per trigger.

**Parity / retrain / release.** Data generated from a runtime whose situation code differs from the model's training data is not comparable; record the runtime commit with the data.

**Gotchas.** `gen.js` uses the real runtime unless `--allow-fake`. A stale `dist/` from an older build silently produces old text: rebuild first. `sim`'s `build:runtime-core` writes only `dist/index.js` (+ chunks; no `.d.ts`, adapters, devtools or worker) and does not clean, so on an empty `dist/` it leaves the demos resolving files that do not exist; prefer the full build.

**See.** [sim.md](sim.md#how-to-change-it-safely), [training.md](training.md).

## Recipes: training

### 18. Train, evaluate and export a model

**Goal.** Produce a model directory the runtime can load (card `genclass-runtime-model/1`: `model.json`, `<name>-q8.onnx`, `<name>-fp16.onnx`, `tokenizer.json`, `calibration.json`, `meta.json`, parity fixtures). Everything here runs on Azure VMs and costs money: **[ask first]** for every step.

**Steps.**
1. Read `training/LOG.md`, `training/EVAL.md`, `training/NEEDS.md`. Note the script layout assumption: `training/*.sh` resolve `JEV="$HERE/../.."` and expect `jev_local/`, `scripts/` and `pyproject.toml` there, while in this monorepo they are one level up.
2. **Curriculum** (if needed; `$PY` is `~/jev/.venv/bin/python` as set by `training/node.sh`, see [training.md](training.md#configuration-and-constants)): `$PY training/curriculum/generate.py --out <dir> --n <N> --seed <new seed> --workers <W> --p-runtime 0.8`; shard train into a stream bucket (`split -n l/64 …` into `<stream root>/<bucket>/`). Use a new seed and bucket name; check `stats.json` (`bad` and `errors` 0, sane `passive_best_fraction`).
3. **Import SIM data:** `training/import_final.sh SIM_OUT_DIR NAME`.
4. **Mixture and launch:** copy a `training/configs/mix_*.json` (keys must be `MixConfig` fields; list `buckets` explicitly) and `training/launch_final1.sh` with a new run name, `--stream-cache`, `--out`, `--seed`. Rank 0 must be the node holding `--init-from`. Check `mixture_plan.json`: missing buckets are dropped silently.
5. **Evaluate and calibrate:** `$PY training/eval_runtime.py --ckpt models/M --data <set> --split test --fit-split dev --records-dir out/records --out out/eval/M-<set>.json --write-calibration out/cal/M.json`; SIM eval with `bash training/eval_sim.sh <NAME> M`; tables with `$PY training/report.py M=<json> --mode=kind`. Delete `out/records/M__*` first if `models/M` was retrained.
6. **Export:** `$PY training/export_runtime.py --ckpt models/M --out out/export-M --name genclass-runtime-<size> --version X.Y.Z --calibration <cal.json> --data-rows <jsonl list>`. Without `--calibration` the export ships all-1.0 temperatures. `final_post.sh MODEL NAME VERSION` automates eval, export and serving on a rank-0 node.
7. **Validate:** `node validate.mjs <export dir> q8 120`, run in a directory where `training/ortweb/package.json` is installed (onnxruntime-node and onnxruntime-web WASM vs the PyTorch fixtures); check `parity.json` (q8 argmax agreement, `embedding_q8.fp16_free: true`, q8 size ≤ 25 MB per CONTRACT §10).
8. **Runtime parity:** `cd packages/runtime && GENCLASS_MODEL_DIR=<export dir> npx vitest run test/model` (uses the export's own fixtures), then the browser specs (their parity assertions compare against the committed v0.1 fixtures, so they only hold for the v0.1 model; load, fallback and latency checks still apply to a new export).
9. **New curriculum scenario case:** add it to the builder's `rng.choices` list in `training/curriculum/scenarios.py`, `scen_ops.py` or `scen_state.py`; build the `Trace`, facts via `fmt.pick` templates (≥ 4 phrasings so one is held out), labels leaning passive when ambiguous, primitives (`training/curriculum/prims.py`) and a `spec` that `rt.py` can render (or `no_runtime: True`). Keep the passive-best share within 0.45–0.75 (`test_curriculum.py` asserts it).
10. Variants: change `max_len` with `--max-len N` at training (the export copies it into `meta.json`); change the vocabulary with `training/prune_vocab.py` (prune both bases, rerun `test_prune_vocab.py`, retrain; marker ids move).

**Tests.** `training/tests/test_curriculum.py` (with and without `GC_P_RUNTIME=1`), `test_export_runtime.py` after touching graph surgery, `test_prune_vocab.py` after vocabulary work.

**Parity / retrain / release.** The trained model must have been trained on text from the runtime it will ship with (`situation-v1` today). Shipping is recipe 20.

**Gotchas.** `training/export_runtime.py` parity `gate08`/`gate09` are a single-max proxy, not the runtime's summed-mass gate. `training/eval_runtime.py --records-dir` reuses cached logits by name even after retraining. q8 must be fp16-free so `webgpu+q8` runs without `shader-f16`. Final round 1 has no results in the repo.

**See.** [training.md](training.md#how-to-change-it-safely), [model-io-contract.md](model-io-contract.md#recipes).

## Recipes: releases

### 19. Publish @genclass/runtime

**Goal.** Release a new version of the library to npm. There is no publish script and no CI; the steps are reconstructed. Publishing is irreversible and public: the user approves it and runs `npm publish` from their own logged-in machine. Agents never run `npm login` or handle npm tokens.

**Steps.**
1. Preconditions: decide with the user whether this release can act. With `DEFAULT_MODEL_BASE_URL` pointing at the unpublished `@genclass/runtime-model@0.1.0`, a default `GenClass.init()` observes only; OPEN_TASKS plans `@genclass/runtime-model` first, then `@genclass/runtime@0.1.0` without the alpha tag.
2. Checks (local): `npm install`, `cd packages/runtime && npx tsc -p tsconfig.json --noEmit`, `npx tsup`, the full unit suite with `NODE_OPTIONS=--expose-gc`, `npm pack --dry-run` (expect `dist`, `bin`, `README.md`, `LICENSE`, `package.json`). **[ask first]**: model tests with `GENCLASS_MODEL_DIR`, `npm run test:browser`, `bash test/smoke/smoke.sh` from `packages/runtime` (registry access; leaves a `.tgz` in `packages/runtime/` and a temp app).
3. Bump `version` in `packages/runtime/package.json` and the version strings in the READMEs and `OPEN_TASKS.md`.
4. Build immediately before publishing (`npm publish` packs whatever `dist/` holds; there is no `prepublishOnly`).
5. The user, from `packages/runtime`: `npm publish --access public` (scoped packages are restricted otherwise; add `--tag <prerelease>` for prereleases; the flags used for `0.1.0-alpha.0` are not recorded). Check `npm view @genclass/runtime dist-tags` before and after.
6. With the user's approval: `git tag -a vX.Y.Z -m "@genclass/runtime X.Y.Z (npm)"` and push it; move the item to "Done" in `OPEN_TASKS.md`.

**Tests.** As in step 2.

**Parity / retrain / release.** The published runtime's situation code must match the model it loads (`situation-v1` for the current training round).

**Gotchas.** No root lockfile is committed, so dependency versions float within caret ranges. `packages/runtime/bin/genclass-runtime.mjs` is committed as 644; npm sets the executable bit on install. A failed tsup build leaves a half-empty `dist/` (`clean: true`).

**See.** [build-test-release.md](runtime/build-test-release.md#how-to-change-it-safely).

### 20. Publish @genclass/runtime-model and point the runtime at it

**Goal.** Make the default model URL serve a trained model so that `GenClass.init()` can act (OPEN_TASKS item 8). **[ask first]** throughout; publishing is the user's action.

**Steps.**
1. Choose the model with the user (R17 for WASM vs R32 for WebGPU; OPEN_TASKS item 5) and get its export directory (recipe 18).
2. Put the directory under `packages/runtime-model/files/` (gitignored), so jsDelivr serves it at `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@<version>/files/`. Check it: `node packages/runtime/bin/genclass-runtime.mjs info packages/runtime-model/files` (card rules, hashes, `needs: shader-f16` on fp16).
3. Add `packages/runtime-model/package.json` (`@genclass/runtime-model`, version, `files` including `files/`). It becomes a workspace automatically (`packages/*`). Confirm with `npm pack --dry-run` in that directory that `files/` is included.
4. The user publishes it (`npm publish --access public`) and attaches the same files to a GitHub release tagged `runtime-model-v<version>` (the CLI's `DEFAULT_FROM` is `https://github.com/daybot-solutions-inc/GenClass-lib/releases/download/runtime-model-v0.1.0/`).
5. If the version is not 0.1.0, update `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` and `packages/runtime/bin/genclass-runtime.mjs` -> `DEFAULT_FROM`, then release the runtime (recipe 19).
6. Update `packages/runtime-model/MODEL_CARD.md` (it lacks `transient` and describes the old gate), `docs/runtime/CONTRACT.md` §2/§10, `docs/runtime/API.md`, `packages/runtime/README.md` "Status", `OPEN_TASKS.md`.

**Tests.** No automated test covers the default URL end to end. **[ask first]** In a browser: `GenClass.init()` reaches `status.state === "ready"`, the console no longer prints "Model unavailable (...); observing only.", and `npm run test:browser` passes against the published directory.

**Parity / retrain / release.** The model must match the runtime's situation format.

**Gotchas.** Cache Storage (`genclass-runtime-v1`) never evicts old versions. `model.json` is revalidated on every load. The demos' `?model=cdn` falls back to the runtime default (`DEFAULT_MODEL_BASE_URL`, which ends in `files/`). Only the `demos/README.md` example `GENCLASS_MODEL_URL=…@0.1.0/` lacks the `files/` suffix.

**See.** [build-test-release.md](runtime/build-test-release.md#how-to-change-it-safely), [model-host.md](runtime/model-host.md).

### 21. Add a CI workflow

**Goal.** Add the CI that OPEN_TASKS item 8 plans (none exists: no `.github/`).

**Steps.**
1. Add `.github/workflows/<name>.yml` running on Node 22 (≥ 22.12) or 24: vitest@5.0.3's `engines` excludes Node 20, 21, 23 and 25.
2. Steps: `npm install` (or have the user decide to commit a root `package-lock.json` and use `npm ci`), `npm run build`, `npm run typecheck -w @genclass/runtime`, `NODE_OPTIONS=--expose-gc npm test`. Expect 286 passed / 14 skipped without a model directory.
3. Keep root `npm run typecheck` out unless the demos typecheck works: it needs the full runtime build and the missing `demos/src/server/data/cities.ts`. It fails at this commit: `demos/tsconfig.json` includes `src/`, and three files import the missing `cities.ts` (inferred from code; not run).
4. Browser specs would need `npx playwright install --with-deps chromium` and a model directory; the smoke test needs registry access. Leave them out of a first workflow.
5. Pushing the workflow is the user's call.

**Tests.** Run the same commands locally first.

**Gotchas.** `review-perf.test.ts` asserts wall-clock bounds and can flake on shared runners. The gc test passes silently without `--expose-gc`.

**See.** [build-test-release.md](runtime/build-test-release.md#how-to-change-it-safely).

## Recipes: demos

### 22. Add or change a demo and re-run trials

**Goal.** Add a demo app or change a scenario, oracle, chaos knob or server route, and measure with trials.

**Steps.**
1. **Prerequisite for any demos build:** recreate `demos/src/server/data/cities.ts` (missing from git; ignored by the root `.gitignore` pattern `data/`). It must export `searchCities(q: string)` returning `{ total, items: { id, name, country, population }[] }` and `TYPED_TARGETS: string[]`. Add a negation (`!demos/src/server/data/`) to the root `.gitignore` or rename the directory.
2. **New demo:** `demos/src/shared/protocol.ts` -> `DemoId`; a world `demos/src/server/worlds/<id>.ts` registered in `demos/src/server/sw.ts` -> `DEFS`; `demos/src/demos/<id>/{main,app,scenario,oracle}.ts` + `app.css`; `demos/<id>/index.html` (copy one; `gc-root` `../`); `demos/vite.config.ts` -> `PAGES`; `demos/e2e/eval.ts` -> `ALL_DEMOS`, `TITLES`, `SHOT_PRESET`; `demos/src/shared/demos.ts` -> `DEMOS`; `demos/src/site/art.ts` -> `ART`. `tsc` flags missing `DEFS`, `ART`, `TITLES`, `SHOT_PRESET` entries but not `DEMOS`, `PAGES`, `ALL_DEMOS`.
3. **Scenario or oracle threshold:** edit `demos/src/demos/<id>/scenario.ts` / `oracle.ts`; keep the scenario RNG label `"<demo>:<kind>:<seed>"`; update the `scored` copy in `demos/src/shared/demos.ts` and the README oracle table.
4. **Chaos knob:** `demos/src/shared/chaos.ts` -> `RouteChaos`, `CALM`, `describeChaos`; apply it in `demos/src/server/core.ts` -> `World.handle` (draw randomness from the request's rng up front); a slider in `demos/src/site/chaos-panel.ts` -> `SLIDERS`.
5. **Server route or world action:** a `Route` with a stable `key`; `w.rng` in handlers, `w.scriptRng` / `w.script` for scripted activity; oracle-relevant data in `snapshot`.
6. **GenClass init:** only `demos/src/shared/genclass.ts` -> `startGenClass`; app code never branches on mode. New runtime API: public API only, mirrored in `demos/src/dev/runtime-shim/*`.
7. **Trials** **[ask first]**: `GENCLASS_MODEL_FROM=<release dir url> bash demos/scripts/vm-eval.sh --tag <name>` (or `GENCLASS_MODEL_DIR` / `GENCLASS_MODEL_URL`), or, from `demos/`, `npm run build` then `npm run eval:fast -- --demos <id>` (`e2e/eval.ts` options include `--n`, `--clean`, `--modes`, `--workers`, `--model`, `--tag`, `--trace`, `--no-shots`). Tagged runs write `results-<tag>.*`; untagged runs replace the shipped `results.*` and the landing page numbers.
8. **Results schema or aggregation:** `demos/src/shared/aggregate.ts` -> `ModeSummary` feeds `demos/src/site/trials-panel.ts`, `demos/e2e/eval.ts` (Markdown and JSON reports) and `demos/src/site/landing.ts` (reads `results-summary.json`); keep the fields or update all three.
9. **World-clock offset (optional fix):** trial worlds start before Guard/Heal pages wait for the model, so scripted activity happens earlier relative to `t0` than in Off. Moving `link.hello(...)` in `demos/src/site/demo-page.ts` -> `bootTrial` after the `gc.ready` wait, or starting scripts from a world action sent at `demos/src/shared/harness.ts` -> `TrialHarness.begin`, removes it; either changes every seed's results.
10. **Hold-induced regressions** **[ask first]**: from `demos/`, `node --experimental-strip-types e2e/eval.ts --trace --demos board --modes off,guard,heal --tag <t>` plus an Off-only A/A run, then `node --experimental-strip-types e2e/trace-report.ts e2e/.out/traces-<t>.json [e2e/.out/traces-<offB>.json]`.

**Tests.** There are no unit tests in `demos/`; the oracles and the eval are the tests. Typecheck: `npm run typecheck -w @genclass/demos` (needs `packages/runtime/dist/*.d.ts`) or `npm run typecheck:shim -w @genclass/demos` (the shim lacks some `Runtime` methods, so it likely fails; unverified).

**Parity / retrain / release.** None for the model. Results are comparable only within the same scenario code, runtime build and model; re-run all modes after any scenario change.

**Gotchas.** Test-side code (oracles, driver, harness, site panels) must use the native timers from `demos/src/shared/native.ts` and control the mock server only through `postMessage`, never `fetch`, or GenClass observes test traffic. Request bodies and event keys must not contain timestamps or random ids (they would re-roll the network per mode). Oracles read `data-testid` / `data-*` attributes: renaming one silently changes scores. Do not fix the apps' latent bugs. The activity panel classifies decisions by runtime reason strings.

**See.** [demos.md](demos.md#how-to-change-it-safely).

## Recipes: tests, debugging, docs

### 23. Run each test suite

| suite | where / command | prerequisites | expected | policy |
|---|---|---|---|---|
| runtime typecheck | `cd packages/runtime && npx tsc -p tsconfig.json --noEmit` | `npm install` | clean | local |
| runtime build | `cd packages/runtime && npx tsup` (or `npm run build` at the root) | install | `dist/` with 6 entries | local |
| runtime unit tests | `cd packages/runtime && NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**"` (`npm test` is equivalent; the config already excludes `test/browser/**`) | install | 36 passed + 1 skipped files; 286 passed + 14 skipped tests | local |
| one file / one test | `cd packages/runtime && npx vitest run test/atoms.test.ts -t "late discard"` | install | | local |
| model unit tests incl. parity | `cd packages/runtime && GENCLASS_MODEL_DIR=<dir> NODE_OPTIONS=--expose-gc npx vitest run test/model` | a model directory from `node packages/runtime/bin/genclass-runtime.mjs fetch-model <dir> --from <url>` | all 62 MODEL tests run | **[ask first]** (download) |
| browser model specs | `cd packages/runtime && GENCLASS_MODEL_DIR=<dir> npm run test:browser` (add `--project chromium` or `swiftshader-webgpu`) | Playwright Chromium for `@playwright/test` 1.63.0, model dir; rebuilds `dist/`; also re-runs the UI spec | specs skip without `model.json` | **[ask first]** |
| devtools UI spec | `cd packages/runtime && npx playwright test --config test/browser/ui/playwright.config.ts` | root `npm install` (fonts from the demos workspace), Chromium | 5 tests; rewrites 18 screenshots | **[ask first]** |
| tarball smoke | `cd packages/runtime && bash test/smoke/smoke.sh` | registry access, Chromium in the Playwright cache | prints `SMOKE OK: <tgz>` | **[ask first]** |
| sim tests | `npm run build`, then `cd sim && SIM_RUNTIME=real npx vitest run` | runtime `dist/` | 17 tests (without `SIM_RUNTIME=real` the fake runtime is used and 2 oracle tests skip) | **[ask first]** |
| sim typecheck | `npm run typecheck -w @genclass/sim` | install | not run when these docs were written | local |
| demos typecheck | `npm run typecheck -w @genclass/demos` | runtime build, `cities.ts` (recipe 22) | not run when these docs were written | local |
| demos trials | recipe 22 step 7 | built site, model, Chromium | `results*.json/md` | **[ask first]** |
| training tests | on a VM: `PYTHONPATH=… python -m pytest -q training/tests/<file>` | jev venv, checkpoints for some tests | | **[ask first]** |
| legacy Python tests | `python -m pytest -q tests/<file>` (markers `model`, `slow`, `macos`) | Python env; 20 `tests/test_data_*.py` fail at collection because `jev_local/data` is missing | | **[ask first]** |
| export validation | `node validate.mjs <export dir> q8 [maxRequests]` in a directory with `training/ortweb/package.json` installed | an export dir | `ortweb_report_q8.json` | **[ask first]** |
| extension | in `extension/` on a VM: `npm ci`, `npm test`, `npm run test:e2e` | release-assets ONNX files | | **[ask first]** |

Root scripts: `npm run build` and `npm test` run only in `@genclass/runtime`; `npm run typecheck` runs every workspace that has the script.

**See.** [build-test-release.md](runtime/build-test-release.md#exact-commands), [build-test-release.md](runtime/build-test-release.md#tests).

### 24. Write a runtime unit test

**Goal.** Add a test in the house style: virtual time, virtual server, scripted model.

**Steps.**
1. Put it in `packages/runtime/test/<area>.test.ts` (`test/model/` for model code). Import with `.js` extensions (`./helpers.js`, `../src/...js`).
2. Use `packages/runtime/test/helpers.ts` -> `setup(opts)`: `createRuntime` with `FakeClock` (starts at t = 1000), `FakeServer` (`http://app.test/`, 50 ms latency, unknown route 404), `ScriptedDecider`, `report: "silent"` and only the fetch observer on. Useful options: `triage: "always"` to force consultation, `mode: "heal"` for heal-tier actions, `script: defaultScript({ mutation: { diagnosis: "stale", action: "discard", p } })`, `decider: new ManualDecider()` to control answer timing (`answer(script)` releases the oldest pending request).
3. Drive the app with `rt.user(...)`, `rt.op(...)`, atoms and `fetch`; advance time with `await clock.advance(ms)`, `clock.flush()`, `clock.runAll()`.
4. Assert on `decider.calls[i].state`, `rt.decisions()`, `rt.interventions()`, `rt.history()`, `server.hits` / `server.log`.
5. Name the contract section in the `describe` (e.g. `"(CONTRACT §4)"`). A bug demonstration follows the `review-*.test.ts` style: header comment `// REVIEW: <area>. A failing test demonstrates a bug.`, `describe("review: ...")`, and a test name stating the required behaviour.
6. DOM tests: first line `// @vitest-environment happy-dom`; `createRuntime({ clock: new FakeClock(), global: window, decider, report: "silent", observe: { ...OFF, user: true } })` with `OFF` copied from `dom.test.ts`; `rt.destroy()` in `afterEach`.
7. Model-file tests: `describe.skipIf(!hasModelFile("model.json"))` from `packages/runtime/test/model/helpers.ts`.

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

**Gotchas.** Tests are not type-checked. Identical `(trigger, state, questions)` within 30 s are answered from the queue cache, so `ScriptedDecider.calls` does not grow: advance the clock past 30 s or vary the situation. Tests that use `GenClass.init` must call `GenClass.destroy()`. Unit tests import fixtures from `test/browser/ui/` (`mock-runtime.ts`, `scenario.ts`, `session.ts`); do not move them.

**See.** [build-test-release.md](runtime/build-test-release.md#write-a-new-unit-test-house-style).

### 25. Investigate a false intervention reported by a user

**Goal.** Find out why GenClass changed an app's behaviour when it should not have, relieve the user, and fix the right layer without adding a rule.

**Steps.**
1. **Confirm the runtime could act.** Check `GenClass.runtime.status` (`state`, `model`, `variant`) and `GenClass.runtime.mode`. With default options, `@genclass/runtime@0.1.0-alpha.0` cannot act: its model URL is unpublished, the status ends in `error` and the console says "Model unavailable (...); observing only.". An intervention therefore implies a self-hosted `model.baseUrl` or a custom `decider`. Guard mode runs only guard-tier actions: the built-ins `discard`, `defer`, `coalesce`, `delay`, and custom actions declared with `tier: "guard"`.
2. **Collect the evidence.** The console line `[GenClass] <Lead> <noun>: <fact> <changed> (<diagnosis>, p; <action> p)` and its collapsed group; `GenClass.runtime.interventions()` -> `ActionRecord` (`id` `a<n>`, `decisionId`, `action`, `tier`, `changed`, `ok`, `error`, `late`); `GenClass.runtime.explain("a<n>")` -> `Explanation` (`situationText`, `facts`, `timeline`, `answers`, and `decision` with `diagnosisProbabilities`, `probabilities`, `candidate`, `mass`, `tier`, `reason`). The devtools overlay shows the same evidence with a Copy button for the situation text. `GenClass.runtime.history(400)` gives the event log; `debug: true` logs swallowed errors.
3. **Relieve the user.** `ActionRecord.undo?.()` exists only for `discard`, late reverts, `rollback` and custom actions with `onUndo` (undo is unguarded and does not check whether state moved since). At the next page load: `GenClass.init({ policy: { deny: ["<action>"] } })`, or `mode: "observe"`, or `?genclass=observe` / `?genclass=off` / `localStorage.genclass = "off"`. The printed "Deny this action" hint does nothing on a page where `init` already ran.
4. **Classify** (read the evidence against the code):
   - **Gate:** did the decision pass `packages/runtime/src/decide/policy.ts` -> `gate` legitimately? `decision.mass` ≥ the threshold of `decision.tier` (0.9 guard / 0.8 heal unless overridden), top diagnosis ≠ `expected` (unless `requireDiagnosis: false`), the mode permits the tier. A wrong pass is a gate bug (test in `policy.test.ts`).
   - **Applicability:** should the action have been offered at all? `packages/runtime/src/situation/build.ts` -> `builtinApplicable` (known: `retry` for non-idempotent POSTs, `demos/NEEDS.md` §5). Fixing it is class A (recipe 4).
   - **Facts:** is any fact false (wrong order, version count, causal attribution, a redaction leak)? That is a trace or fact bug in `packages/runtime/src/situation/facts.ts`, `packages/runtime/src/trace/context.ts` or an observer; the fix is class A (recipes 1, 2).
   - **Effect:** does `changed` describe what really happened; did it act on the right write or request? That is a controller bug (recipe 4 a). `late: true` means a late revert: check `StoreHub.revertable`.
   - **Model:** the gate, offer, facts and effect are all correct and the model was confidently wrong. That is a precision problem for training: record the situation text and the expected passive outcome (e.g. a `training/NEEDS.md` or SIM scenario request). Do **not** add a runtime rule that maps this pattern to passive (CONTRACT §0 rule 1).
   - **No `ActionRecord` at all**, but the app misbehaved: look at holds. Decisions with `reason` "the decision arrived after the hold budget expired", held writes reordered behind a newer user write (`demos/NEEDS.md` §1), added latency (§2). Mitigations: `StoreOptions.hold: false` for that store, `policy.holdBudgetMs`, observe mode.
5. **Reproduce headless.** Write a unit test (recipe 24) that recreates the trigger and forces the same model answer with `defaultScript`, then asserts the corrected gate, offer, fact or effect. The real model's probabilities can only be reproduced with model files **[ask first]**.
6. **Record.** Add the regression test; note the issue in `packages/runtime/STATUS.md` "Open issues" (or the owning NEEDS file); for precision cases, give TRAIN the situation text.

**Gotchas.** Console reports are deduplicated in 60 s windows ("×N more"). Reason strings are parsed by devtools and the demos: do not reword them while debugging. `rt.situation(trigger)` returns the last situation built for that trigger, not a fresh rebuild.

**See.** [decide-policy-actions.md](runtime/decide-policy-actions.md), [learn-situation-triage.md](runtime/learn-situation-triage.md), [state-and-adapters.md](runtime/state-and-adapters.md#drift-and-open-issues), [devtools.md](runtime/devtools.md).

### 26. Update these docs after a code change

**Goal.** Keep `docs/agents/`, `AGENTS.md`, `CLAUDE.md` and the human docs true to the code after you change it.

**Steps.**
1. Find every doc that cites what you changed: `grep -rn "<symbol or path>" docs/agents AGENTS.md CLAUDE.md docs/runtime packages/runtime/*.md packages/runtime/src/model/README.md sim/README.md training/README.md demos/README.md`.
2. Update the owning agent doc (sections Files, Concepts, Configuration and constants, Invariants and gotchas, How to change it safely, Tests, Drift and open issues):

| code | agent doc |
|---|---|
| `packages/runtime/src/{index,runtime,types,errors,clock,util}.ts` (wiring, options, lifecycle, plugins) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) |
| `packages/runtime/src/observe/*`, `trace/*` | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) |
| `packages/runtime/src/state/*`, `adapters/*` | [runtime/state-and-adapters.md](runtime/state-and-adapters.md) |
| `packages/runtime/src/learn/*`, `situation/*` | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) and [model-io-contract.md](model-io-contract.md) |
| `packages/runtime/src/decide/*`, actions in `runtime.ts` | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) |
| `packages/runtime/src/model/*`, `packages/runtime/bin/genclass-runtime.mjs`, `packages/runtime-model/` | [runtime/model-host.md](runtime/model-host.md) and [model-io-contract.md](model-io-contract.md) |
| `packages/runtime/src/devtools/*` | [runtime/devtools.md](runtime/devtools.md) |
| package manifests, tsup, vitest, test infrastructure, `scripts/vm.sh`, publishing | [runtime/build-test-release.md](runtime/build-test-release.md) |
| `sim/` | [sim.md](sim.md) |
| `training/` | [training.md](training.md) |
| `demos/` | [demos.md](demos.md) |
| `jev_local/` | [genclass-model-lineage.md](genclass-model-lineage.md) |
| `extension/`, `bench/`, `scripts/` | [extension-and-benchmarks.md](extension-and-benchmarks.md) |
| status, ownership, open work | [status-and-known-issues.md](status-and-known-issues.md) |
| new terms, moved paths, new recipes | [glossary.md](glossary.md), [repo-map.md](repo-map.md), this file |

3. Keep the conventions: pointers `path -> symbol`, no line numbers, "code wins". Update the "Verified against commit … (date)" line of each doc you re-verified. Remove drift rows you fixed; add new drift you found, with evidence.
4. Check every relative link you touched resolves from the linking file (`ls` the target) and that anchors still match headings.
5. Human docs: `packages/runtime/src/types.ts` JSDoc (safe to fix: no model input), `docs/runtime/API.md`, `packages/runtime/README.md`; `packages/runtime/STATUS.md` ("Updated:" line, "State" counts and commands, a batch section, "Deviations from the contract (and why)", "Open issues", example situations); `OPEN_TASKS.md` (Next -> In progress -> Done, with evidence). Fixing `BUILTIN_ACTIONS` descriptions is not a doc fix: it is model input.
6. Cross-workstream requests: add a numbered item to your own NEEDS file (addressee, status OPEN or ASK, evidence as file -> symbol, suggested fix, a regression-test sketch; `demos/NEEDS.md` §1 is the model). The requester flips it to DONE after verifying. Contract changes go to CONTRACT §13 (lead) or STATUS "Deviations" (owner); never diverge silently.
7. Do not edit legacy jev-era docs (`docs/*.md` outside `docs/runtime/` and `docs/agents/`).

**See.** [status-and-known-issues.md](status-and-known-issues.md#how-to-change-it-safely), [README.md](README.md).

### 27. Touch legacy code: jev_local, extension, benchmarks, ops scripts

**Goal.** Make a change in the code the runtime grew out of. CONTRACT §1 says existing GenClass content stays as is: do this only when the user asks.

**Steps.**
1. **`jev_local/` serialization, packing or calibration:** recipe 13 (TS and Python together, fixtures, retrain).
2. **Training losses or the stream reader** (`jev_local/train/`): add a `LossConfig` field defaulting to off so the v1 path stays bit-identical (`tests/test_train_v2_losses.py`); keep stream determinism and bump `INDEX_VERSION` if the row index layout changes; keep the trainer flags the `training/` launchers and `scripts/launch_run.sh` pass backward compatible.
3. **Extension harness logic** (`extension/src/core`): change `jev_local/harness/*.py` first (the Python is the reference), regenerate `extension/test/fixtures/*_py.json` with `extension/scripts/make_py_fixtures.py` (fix its `ROOT`/`OUT` paths first), run `npm test` in `extension/` on a VM **[ask first]**. `scripts/vm.sh` excludes `/extension/`.
4. **Engine/packer/tokenizer bug in the extension:** fix the runtime TS copy first (`packages/runtime/src/model/`); port to the extension only if it is still released.
5. **Extension features and models** (browser-only intents, shipping a new model variant with card sha256 and parity fixtures): follow [extension-and-benchmarks.md](extension-and-benchmarks.md#how-to-change-it-safely) recipes 2 and 3; builds and e2e run on a VM **[ask first]**.
6. **Benchmarks:** benchmax specs need pinned upstream revisions and pure-Python tests; changing `bench/public/jev_published.json` or targets changes frozen hashes (re-freeze before any test read). Never run paid Jev/OpenRouter calls (`scripts/jevbench.py run-jev`) without the user's explicit approval and a funded key; `run-ours`, `score` and `report` score a checkpoint without paid calls.
7. **Ops scripts:** keep `scripts/vm.sh` rsync exclusions and `--delete` semantics; keep `scripts/launch_run.sh` positional arguments (`training/launch_s2.sh` and `launch_final1.sh` depend on them). Anything that calls `az vm create/start` needs the user's go-ahead.

**Tests.** Python tests with markers `model`, `slow`, `macos` (`tests/conftest.py` skips `macos` off macOS) **[ask first]**.

**See.** [genclass-model-lineage.md](genclass-model-lineage.md#how-to-change-it-safely), [extension-and-benchmarks.md](extension-and-benchmarks.md#how-to-change-it-safely).

## Related docs

- [README.md](README.md) (index of agent docs), [overview.md](overview.md), [repo-map.md](repo-map.md), [glossary.md](glossary.md), [../../AGENTS.md](../../AGENTS.md)
- [status-and-known-issues.md](status-and-known-issues.md), [model-io-contract.md](model-io-contract.md)
- Runtime: [public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md), [observe-and-trace.md](runtime/observe-and-trace.md), [state-and-adapters.md](runtime/state-and-adapters.md), [learn-situation-triage.md](runtime/learn-situation-triage.md), [decide-policy-actions.md](runtime/decide-policy-actions.md), [model-host.md](runtime/model-host.md), [devtools.md](runtime/devtools.md), [build-test-release.md](runtime/build-test-release.md)
- Other subsystems: [sim.md](sim.md), [training.md](training.md), [demos.md](demos.md), [genclass-model-lineage.md](genclass-model-lineage.md), [extension-and-benchmarks.md](extension-and-benchmarks.md)
- Human sources: [`docs/runtime/CONTRACT.md`](../runtime/CONTRACT.md), [`docs/runtime/API.md`](../runtime/API.md), [`packages/runtime/STATUS.md`](../../packages/runtime/STATUS.md), [`OPEN_TASKS.md`](../../OPEN_TASKS.md)
