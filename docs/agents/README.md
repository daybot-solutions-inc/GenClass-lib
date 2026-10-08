# Agent docs: index and router

> **Scope:** every doc in `docs/agents/`, the root entry points `AGENTS.md` and `CLAUDE.md`, and how these docs relate to the human docs in `docs/runtime/`.
> **Read this when:** you need the right doc for a task, want to know what a doc covers, or must update the docs after changing code.
> **Source of truth:** the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

## Purpose and reading order

These docs are for AI coding agents that arrive in this repo with no context. Each subsystem doc describes one area as the code stands at a stated commit, with `file -> symbol` pointers so you can go straight to the source. They are not product documentation. For that, see `README.md`, `packages/runtime/README.md` and `docs/runtime/*.md`.

Read them in this order:

1. [`../../AGENTS.md`](../../AGENTS.md): ground rules, what you may run locally, and what needs the user's OK first.
2. [overview.md](overview.md): what the product is and how runtime, sim, training, model and demos fit together.
3. The subsystem doc for your task (see the [routing table](#routing-table)). Read its TL;DR first, then "Invariants and gotchas" and "How to change it safely" before you edit anything.
4. [playbooks.md](playbooks.md): procedures for tasks that span several subsystems.

Keep three docs open for reference: [repo-map.md](repo-map.md) (where things live), [glossary.md](glossary.md) (terms) and [status-and-known-issues.md](status-and-known-issues.md) (what is shipped, frozen, open and stale).

Three facts change how you should read every other doc:

- **The situation format is frozen** at tag `situation-v1` (1a77558). `git diff situation-v1 HEAD -- packages/runtime/src` is empty at 654d822. Any change to text the model reads needs the user's go-ahead (ask the user; the workstream roles belonged to the original team), regenerated sim data, a `training/curriculum/rt.py` mirror and retraining. See [model-io-contract.md](model-io-contract.md).
- **The published alpha only observes.** `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` points at `@genclass/runtime-model@0.1.0`, which has not been published (OPEN_TASKS item 8; the CDN was not checked live). A default `GenClass.init()` ends in model status `error` and never acts. See [runtime/model-host.md](runtime/model-host.md).
- **The subsystem docs still state the original run rule:** everything on the Azure VM via `scripts/vm.sh`, never locally (CONTRACT §0 rule 5, written for an 8 GB Mac). The current policy for agents is in `AGENTS.md`:
  - You may run `npm install`, typecheck, the tsup build and the vitest unit tests locally. The lead checked all four on 2026-10-07.
  - Ask the user before you run the sim, training, Playwright (including `test/smoke/smoke.sh`), model downloads, the demos' eval, or any script that touches Azure (`scripts/*.sh`, `training/*.sh`, `sim/scripts/*`).

## Routing table

Each row names the doc to read, and then any further docs to check. "Ask first" means you must get the user's OK before you run anything for that task.

### Orientation and process

| If your task is ... | Read | Then |
|---|---|---|
| Learn what is shipped, frozen or in flight, and who owns what | [status-and-known-issues.md](status-and-known-issues.md) | [overview.md](overview.md) |
| Find where a file, package or script lives | [repo-map.md](repo-map.md) | the "Files" table of the subsystem doc |
| Look up a term (situation, trigger, tier, settled point, hold budget, FIR, R17/R32) | [glossary.md](glossary.md) | the doc's "Concepts and data structures" |
| Decide whether a change forces new sim data and retraining | [model-io-contract.md](model-io-contract.md) ("Versioning: what invalidates the trained model") | [status-and-known-issues.md](status-and-known-issues.md) ("Change anything the model reads") |
| Record status after a change (STATUS.md, NEEDS files, OPEN_TASKS.md) or file a cross-workstream request | [status-and-known-issues.md](status-and-known-issues.md) ("How to change it safely") | — |
| Handle a human doc (API.md, CONTRACT.md, a README, STATUS.md) that disagrees with the code | [status-and-known-issues.md](status-and-known-issues.md) ("Drift and open issues", "Fix doc drift") | the subsystem doc's "Drift and open issues" |

### Runtime: public API, observers, state

| If your task is ... | Read | Then |
|---|---|---|
| Add or change an init/`createRuntime` option or a default (mode, thresholds, `settleMs`, `historySize`) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) | [sim.md](sim.md) (`sim/src/run/rt.ts` -> `createOptions`) if it reaches situations or decisions |
| Add a `Runtime` method or event | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) | [runtime/devtools.md](runtime/devtools.md) (`MockRuntime`), [demos.md](demos.md) (runtime shim) |
| Change `GenClass.init`, the kill switch or `destroy()` | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) (how globals are restored) |
| Write a plugin, custom action or standing question | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) (plugin API) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md), [model-io-contract.md](model-io-contract.md) (no retrain; quality unmeasured) |
| Add code that depends on time (timers, timestamps, ids) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) (`Clock` rules) | [runtime/build-test-release.md](runtime/build-test-release.md) (`FakeClock` tests) |
| Add an observer (`EventSource`, `BroadcastChannel`, ...) | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) if you add an `OpKind` |
| Debug how fetch/XHR requests are held, coalesced, retried, hedged or served from cache | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) |
| Change op signatures, request identity or volatile headers | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) | [model-io-contract.md](model-io-contract.md) (op names reach the model) |
| Carry the ambient op across a new async boundary | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) (`LazyOp` timer pattern) | — |
| Change DOM user-action recording or `data-genclass-ignore` | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) | [runtime/devtools.md](runtime/devtools.md) |
| Integrate another state library through `runtime.adapter` | [runtime/state-and-adapters.md](runtime/state-and-adapters.md) | [runtime/build-test-release.md](runtime/build-test-release.md) (subpath export) |
| Change the React hooks, Redux enhancer or Zustand middleware | [runtime/state-and-adapters.md](runtime/state-and-adapters.md) | [demos.md](demos.md) (a demo exercises each adapter) |
| Debug why a write was held, applied, dropped or not reverted | [runtime/state-and-adapters.md](runtime/state-and-adapters.md) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) (hold budget, late revert) |
| Add or tune an invariant template; debug a missing or spurious `inconsistency` trigger | [runtime/state-and-adapters.md](runtime/state-and-adapters.md) | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) |
| Fix held writes landing after a newer user write (`demos/NEEDS.md` §1) | [runtime/state-and-adapters.md](runtime/state-and-adapters.md) | [status-and-known-issues.md](status-and-known-issues.md), [demos.md](demos.md) |

### Runtime: situation, decisions, model host, devtools

| If your task is ... | Read | Then |
|---|---|---|
| Find out why a trigger did or did not reach the model (triage) | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) |
| Change fact wording or timeline/state/stats lines, or add a fact | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) | [model-io-contract.md](model-io-contract.md), [sim.md](sim.md), [training.md](training.md) |
| Change the situation budget or section limits | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) | [model-io-contract.md](model-io-contract.md), [training.md](training.md) (`rt.py` must match) |
| Change redaction (`isSensitiveName`), latency/error baselines or transition profiles | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) (`util.ts` helpers) |
| Add a trigger kind | [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) (`Controller`), [model-io-contract.md](model-io-contract.md), [sim.md](sim.md) |
| Change the policy gate, thresholds, hold budget or rate limit | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) | [training.md](training.md) (`eval_runtime.py` mirrors the gate) |
| Change a built-in action's mechanics or its `changed` sentence | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) | [runtime/observe-and-trace.md](runtime/observe-and-trace.md) (request/failure/stall controllers) |
| Add a built-in action or a diagnosis label | [model-io-contract.md](model-io-contract.md) ("Recipes") | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md), [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md), [sim.md](sim.md), [training.md](training.md) |
| Change console report wording, `explain()` or undo | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) | [runtime/devtools.md](runtime/devtools.md) (the overlay mirrors report templates) |
| Change the decider queue (priorities, deadlines, timeout, answer cache) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) | [runtime/model-host.md](runtime/model-host.md) |
| Debug "Model unavailable (...); observing only.", a stuck load or slow decisions | [runtime/model-host.md](runtime/model-host.md) | [status-and-known-issues.md](status-and-known-issues.md) |
| Point at a published model, bump the model version, or self-host model files (`genclass-runtime fetch-model`) | [runtime/model-host.md](runtime/model-host.md) | [runtime/build-test-release.md](runtime/build-test-release.md) (publishing the model package) |
| Change WebGPU/WASM plan order, the worker protocol, a model error class or the onnxruntime-web version | [runtime/model-host.md](runtime/model-host.md) | [runtime/build-test-release.md](runtime/build-test-release.md) (externals, browser specs) |
| Change the TS serializer, tokenizer, packer or calibration | [model-io-contract.md](model-io-contract.md) | [runtime/model-host.md](runtime/model-host.md), [genclass-model-lineage.md](genclass-model-lineage.md) (Python side), [runtime/build-test-release.md](runtime/build-test-release.md) (fixtures) |
| Mount the devtools overlay, or change a view, option, card, theme or keyboard handling | [runtime/devtools.md](runtime/devtools.md) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) (events it subscribes to) |
| Update the overlay's Playwright spec or its screenshots (ask first) | [runtime/devtools.md](runtime/devtools.md) | [runtime/build-test-release.md](runtime/build-test-release.md) |
| Investigate a false intervention or unexpected behaviour reported by a user | [playbooks.md](playbooks.md#25-investigate-a-false-intervention-reported-by-a-user) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) |

### Build, test and release

| If your task is ... | Read | Then |
|---|---|---|
| Build, typecheck or run the unit tests | [runtime/build-test-release.md](runtime/build-test-release.md) | [`../../AGENTS.md`](../../AGENTS.md) (what may run locally) |
| Write a unit test in house style (`setup()`, `FakeClock`, `ManualDecider`) | [runtime/build-test-release.md](runtime/build-test-release.md) | [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) (`defaultScript`) |
| Add a public entry point (subpath export) | [runtime/build-test-release.md](runtime/build-test-release.md) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) |
| Run the Playwright specs or the npm-pack smoke test (ask first) | [runtime/build-test-release.md](runtime/build-test-release.md) | — |
| Cut a release, publish `@genclass/runtime-model`, or add CI (there is no `.github/`) | [runtime/build-test-release.md](runtime/build-test-release.md) | [playbooks.md](playbooks.md#19-publish-genclassruntime) recipes 19–21, [status-and-known-issues.md](status-and-known-issues.md) |

### Sim, training and demos

| If your task is ... | Read | Then |
|---|---|---|
| Generate or regenerate training data (ask first) | [sim.md](sim.md) | [model-io-contract.md](model-io-contract.md) |
| Add a feature combinator, domain, chaos behaviour or ask-question generator | [sim.md](sim.md) | — |
| Change cost weights or label parameters | [sim.md](sim.md) | [model-io-contract.md](model-io-contract.md) (how the sim labels rows) |
| Debug a dropped trajectory, a `prefix-mismatch` or an odd label | [sim.md](sim.md) | — |
| Change the runtime options the sim passes (`createOptions`) | [sim.md](sim.md) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) |
| Mirror a runtime wording change into `training/curriculum/rt.py` | [training.md](training.md) | [model-io-contract.md](model-io-contract.md) |
| Regenerate the curriculum, change a mixture or launch a training round (Azure; ask first) | [training.md](training.md) | [genclass-model-lineage.md](genclass-model-lineage.md) (the `jev_local` trainer) |
| Evaluate a checkpoint, fit calibration or read EVAL.md numbers | [training.md](training.md) | [model-io-contract.md](model-io-contract.md) ("Re-calibrate only") |
| Export and validate a model directory; choose between R17 and R32 | [training.md](training.md) | [runtime/model-host.md](runtime/model-host.md) (card format), [status-and-known-issues.md](status-and-known-issues.md) |
| Change the tokenizer vocabulary | [training.md](training.md) | [genclass-model-lineage.md](genclass-model-lineage.md) |
| Build the demos from a fresh clone (`demos/src/server/data/cities.ts` is missing) | [demos.md](demos.md) | — |
| Add a demo, or change a scenario, oracle, chaos knob or mock route | [demos.md](demos.md) | — |
| Use a new runtime API from the demos (runtime shim) | [demos.md](demos.md) | [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) |
| Evaluate a model in the demos (`demos/scripts/vm-eval.sh`; ask first) | [demos.md](demos.md) | [runtime/model-host.md](runtime/model-host.md) |
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

Line counts were taken with `wc -l` and are approximate.

| Path | Scope | Read when | Lines |
|---|---|---|---|
| [`../../AGENTS.md`](../../AGENTS.md) | Entry point: what the repo is, status, ground rules, where to run things, commands, conventions, definition of done | First, always | ~190 |
| [`../../CLAUDE.md`](../../CLAUDE.md) | Claude Code entry point: one-line repo summary that imports `AGENTS.md` (`@AGENTS.md`) | Loaded for you by Claude Code | 3 |
| [README.md](README.md) | This index: routing, catalogue, conventions, maintenance | Finding a doc; updating docs | ~185 |
| [overview.md](overview.md) | The mental model: component map, runtime data flow, offline loops (sim -> training -> model), modes, fail-open behaviour | Second, after AGENTS.md | ~415 |
| [repo-map.md](repo-map.md) | Every tracked path, plus generated and ignored paths in a working copy | Finding where a file, symbol, constant, CLI command, env var or config key lives | ~855 |
| [glossary.md](glossary.md) | Terms used across the docs | When a term is unclear | ~445 |
| [playbooks.md](playbooks.md) | End-to-end procedures across subsystems | Before a multi-subsystem change | ~775 |
| [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md) | `index.ts`, `runtime.ts` wiring, `types.ts`, errors, `Clock`, `util.ts`, `package.json` | Options, `Runtime` methods, events, plugins, init/destroy, kill switch | ~640 |
| [runtime/observe-and-trace.md](runtime/observe-and-trace.md) | `observe/*`, `trace/*`, observer install/route code in `runtime.ts` | Patching fetch/XHR/WS/timers/DOM/history/Storage; ops, identity, causality | ~790 |
| [runtime/state-and-adapters.md](runtime/state-and-adapters.md) | `state/*`, `adapters/*`, store code in `runtime.ts` | Holds, patches, reverts, snapshots, invariants, React/Redux/Zustand | ~650 |
| [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md) | `learn/*`, `situation/*`, triage in `runtime.ts` | Any model-visible text, triage, budgets, redaction, baselines | ~1050 |
| [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md) | `decide/*`, action controllers, `explain`, undo | Queue, policy gate, built-in actions, reports | ~720 |
| [runtime/model-host.md](runtime/model-host.md) | `model/*`, worker, CLI `bin/genclass-runtime.mjs`, `packages/runtime-model/` | Model loading, caching, WebGPU/WASM, packer, calibration, CLI | ~670 |
| [runtime/devtools.md](runtime/devtools.md) | `devtools/*`, `UI-NEEDS.md`, devtools tests and UI spec | The overlay, its views, theming, screenshots | ~710 |
| [runtime/build-test-release.md](runtime/build-test-release.md) | Workspace config, tsup/vitest/Playwright, fixtures, smoke, `scripts/vm.sh`, publishing | Build, test, fixtures, release, CI | ~550 |
| [model-io-contract.md](model-io-contract.md) | Situation text -> packed request -> heads -> calibrated answers, across runtime, sim and training | Any change the model can see; shipping a model directory | ~690 |
| [sim.md](sim.md) | `sim/**` | Training data generation, labels, splits, budgets | ~820 |
| [training.md](training.md) | `training/**` and the `jev_local` parts it calls | Curriculum, training rounds, eval, calibration, export | ~520 |
| [demos.md](demos.md) | `demos/**` | Demo apps, mock server, chaos, Playwright eval, results | ~540 |
| [genclass-model-lineage.md](genclass-model-lineage.md) | `jev_local/**` (except bench), Python tests, legacy `docs/*.md` | Python reference for parity; trainer; legacy server and harness | ~530 |
| [extension-and-benchmarks.md](extension-and-benchmarks.md) | `extension/**`, `bench/**`, `jev_local/bench/**`, `results/**`, `scripts/**` | Chrome extension, benchmarks, ops scripts | ~560 |
| [status-and-known-issues.md](status-and-known-issues.md) | OPEN_TASKS, STATUS, NEEDS files, `docs/runtime/*`, git history | Status, ground rules, owners, open issues, cross-doc drift | ~625 |

## Conventions used in these docs

- **Header block.** Every subsystem doc opens with three lines: **Scope** (the files it covers), **Read this when** and **Source of truth**. The last line reads "Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins."
- **Fixed sections.** All 15 subsystem docs use the same sections in the same order: TL;DR, Files, Concepts and data structures, How it works, Configuration and constants, Invariants and gotchas, How to change it safely, Tests, Drift and open issues, Related docs. Jump straight to the one you need.
- **Code pointers** look like `path/from/repo/root.ts` -> `symbolName`, for example `packages/runtime/src/decide/policy.ts` -> `gate`. They never give line numbers; find a symbol with `rg -n "symbolName" <path>`. Some runtime docs shorten paths to `src/…` and `test/…`, relative to `packages/runtime/`. [status-and-known-issues.md](status-and-known-issues.md) states its own path convention at the top of its TL;DR.
- **Code wins.** A doc describes the code at its verified commit. If a doc disagrees with the code, trust the code, then fix the doc. This applies to the human docs too: CONTRACT.md, API.md, the READMEs, STATUS.md, the NEEDS files and MODEL_CARD.md all have stale items.
- **Drift sections.** "Drift and open issues" lists two things:
  - where docs or code comments disagree with the code, and what the code really does;
  - open questions, and findings that came only from reading the code, with no test behind them.

  Check this section before you rely on a human doc. [status-and-known-issues.md](status-and-known-issues.md) holds the cross-cutting drift tables (human docs vs the runtime code). Subsystem-specific drift is only in each doc's own Drift section.
- **"(unverified)"** marks a claim that nobody could confirm from the code or a run at the verified commit. Typical cases are live URLs, browser behaviour, VM state and results that are not in the repo. Treat such a claim as a hypothesis. "Inferred" and "code reading only" mean the claim was derived from the source and no test asserts it.

## Keeping the docs current

1. **Update the doc in the same change as the code.** If you change code under a doc's Scope, edit the affected sections in that doc (Files, constants, How it works, Tests). Remove Drift entries your change resolves, and add any mismatch it creates.
2. **Update the commit line.** Set "Verified against commit … (date)" to the commit you checked the doc against. If you re-checked only part of the doc, name those sections in that line.
3. **Fix every copy of a repeated fact.** Several facts appear in more than one doc: the unpublished default model, the `situation-v1` freeze, the default hold budget, test counts. Before you finish, search for the symbol or value you changed and fix every hit, for example `rg -n "DEFAULT_MODEL_BASE_URL" docs/agents`.
4. **Model-visible changes cascade.** A change to situation text, questions, labels or budgets touches [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md), [model-io-contract.md](model-io-contract.md), [sim.md](sim.md), [training.md](training.md) and [status-and-known-issues.md](status-and-known-issues.md) (freeze tag).
5. **New docs.** A new subsystem doc keeps the same header block and ten sections. Add it to the catalogue and the routing table here, and to [repo-map.md](repo-map.md). Refresh the line counts with `wc -l docs/agents/*.md docs/agents/runtime/*.md` when a doc grows or shrinks a lot.
6. **Mark what you could not check.** Write "(unverified)" next to anything you could not confirm. Never add line numbers.

### How these docs relate to the human docs

The agent docs are derived from the code. They cite the human docs mainly to record drift, and they do not replace them:

- `docs/runtime/CONTRACT.md` is the binding build contract. The lead owns it. It holds the §0 ground rules, the spec, and the approved additions in §13. To change it, write a NEEDS item or ask the user (who now stands in for the lead); an approved deviation goes into CONTRACT §13 or STATUS "Deviations from the contract (and why)".
- `docs/runtime/API.md` is the public API reference for library users. If you change the public surface, update API.md and the JSDoc in `packages/runtime/src/types.ts` in the same change, then the agent doc.
- `docs/runtime/ARCHITECTURE.md` is the design overview for humans. Its known drift is listed in [status-and-known-issues.md](status-and-known-issues.md).
- The workstream status files (`packages/runtime/STATUS.md`, `packages/runtime/UI-NEEDS.md`, `sim/NEEDS.md`, `training/NEEDS.md`, `demos/NEEDS.md`, `OPEN_TASKS.md`) are how the team coordinates. Follow the process in [status-and-known-issues.md](status-and-known-issues.md), and do not close or rewrite another workstream's items: the requester flips an item to DONE after verifying (owners may add answers under their own heading, as MODEL did in `training/NEEDS.md`).
- The legacy jev-local docs (`docs/SPEC.md`, `docs/CONTRACT.md`, `docs/CONTRACT-v2.md`, `docs/DEMO.md`, `docs/GENCLASS.md`, `docs/COMPARISON.md`, `docs/PLAN-excel.md`) and `docs/benchmax-research/` are not the runtime contract. CONTRACT §1 says this earlier GenClass content "stays as is". They are summarised in [genclass-model-lineage.md](genclass-model-lineage.md) and [extension-and-benchmarks.md](extension-and-benchmarks.md).
