# AGENTS.md

Root entry point for AI coding agents in GenClass-lib. Verified against commit 654d822 (2026-10-07).
The code is the source of truth: if this file or any other doc disagrees with it, the code wins.

## 1. What this repo is

- `@genclass/runtime` (`packages/runtime/`) is an npm library for self-healing web apps. It observes a running app
  (fetch/XHR/WebSocket, user actions, timers, state stores, errors, causality) and computes generic facts.
- For salient situations a small local model (ONNX in a Web Worker, WebGPU or WASM) chooses a diagnosis and an action.
  Actions are minimal (only `discard`, a late revert, `rollback` and custom actions with `onUndo` can be undone), and they
  pass a precision-first policy gate. Without a model the runtime only observes.
- `sim/` generates training data by driving the real runtime. `training/` trains and exports the model, and `demos/` holds six evaluation apps.
- `jev_local/`, `extension/`, `bench/`, `results/` and the legacy `docs/*.md` are the older GenClass model, Chrome extension and benchmarks that the runtime builds on.
- npm workspaces: `packages/*`, `sim`, `demos`. Branches `main`, `origin/main` and `origin/runtime` all point at 654d822.

Read next: [docs/agents/README.md](docs/agents/README.md) (index: which doc answers which question), then
[docs/agents/overview.md](docs/agents/overview.md) (how the parts fit together). Also:
[repo-map](docs/agents/repo-map.md), [glossary](docs/agents/glossary.md), [playbooks](docs/agents/playbooks.md), and
[status-and-known-issues](docs/agents/status-and-known-issues.md) before you change anything.

## 2. Status in brief

- `@genclass/runtime@0.1.0-alpha.0` is on npm (per `OPEN_TASKS.md`; git tag `v0.1.0-alpha.0` = 654d822). **It only observes.**
  `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` points at `@genclass/runtime-model@0.1.0`, which is
  not published yet (`packages/runtime-model/` holds only `MODEL_CARD.md`). So a default `GenClass.init()` ends with model status `error` and
  prints `[GenClass] Model unavailable (...); observing only.` From then on it never holds a write or takes an action.
- The runtime source is frozen at tag `situation-v1` (1a77558): `git diff situation-v1 HEAD -- packages/runtime/src` is
  empty. SIM phase A (600,676 rows) came from that code. Final training round 1 was launched, and the repo has no results from it.
- Next (`OPEN_TASKS.md`): choose the shipping model (R17 and/or R32), publish `@genclass/runtime-model@0.1.0` and its GitHub
  release, publish `@genclass/runtime@0.1.0`, add CI, then re-run the demos with the trained model.
- The repo has no CI (no `.github/`) and no committed root `package-lock.json`. Demo results so far use the v0.1 GenClass model
  (a general classifier, not trained for runtime decisions).
- `demos/src/server/data/cities.ts` is not in git (root `.gitignore` rule `data/`), so a fresh clone cannot build or typecheck the demos.
- Open product risks (`demos/NEEDS.md` §1, §2, §5, all still open in code): held writes can land after a newer user write, holds add
  latency, and `retry` is offered for non-idempotent requests. Details: [status doc](docs/agents/status-and-known-issues.md).

## 3. Ground rules (binding; `docs/runtime/CONTRACT.md` §0 and §0.5)

CONTRACT: "If something here is wrong, tell the lead; do not silently diverge." The workstream roles in the docs
(lead, CORE, MODEL, UI, SIM, DEMOS, TRAIN, REVIEW) belong to the original team. Where a rule says "ask the lead", ask the user.

1. **No hardcoded bug rules in the runtime (§0 rule 1).** The runtime may compute generic, uniform facts and may triage, which means
   deciding whether a situation is worth asking the model about. It must never map a fact pattern to a diagnosis or an action with an if/then. Diagnoses and
   actions come from the model. In code, triage is `facts.every((f) => f.neutral)` in `packages/runtime/src/runtime.ts` ->
   `RuntimeImpl.trigger`. Actions are chosen only by `packages/runtime/src/decide/policy.ts` -> `gate` from model probabilities.
   `packages/runtime/src/situation/build.ts` -> `builtinApplicable` says only whether an action *can* run.
2. **Train/runtime parity (§0 rule 2).** There is exactly one implementation of situation building and serialization:
   `packages/runtime/src/situation/*`. The sim drives the real runtime (`sim/src/run/rt.ts` -> `realRuntimeFactory`), and
   `training/curriculum/rt.py` is a Python port of it. The situation format is frozen at tag `situation-v1`. **Any change to
   situation text, facts, questions, action/diagnosis wording, `packages/runtime/src/util.ts` formatting or op/event names
   invalidates the SIM data and the trained model.** Do not make such a change without the user's explicit go-ahead.
3. **Determinism (§0 rule 3).** Runtime code never calls `Math.random`, `Date.now` or `performance.now` directly, and never
   schedules with the global `setTimeout`. It uses the injected `Clock` (`packages/runtime/src/clock.ts` -> `browserClock`
   captures the real timers at module load). IDs come from counters (e.g. `OpRegistry` `nextId`, action ids `a<n>`).
   Same inputs give byte-identical situations. Known exceptions, none of which touch situation text:
   `packages/runtime/src/model/engine.ts` defaults `now` to `performance.now()` (timing only),
   `packages/runtime/src/model/host.ts` -> `scheduleIdle` uses `requestIdleCallback`, and
   `packages/runtime/src/devtools/index.ts` captures the global `requestAnimationFrame` and `setTimeout` at module load
   (`rawRaf`, `rawSetTimeout`: render flushes, the Copy-button reset and the no-plugin timer fallback).
4. **Honest-evaluation separation (§0 rule 4).** `sim/` and `demos/` never read or model each other. The sim never models a
   demo. Demos contain nothing beyond a normal integration: stores, optional resync handlers, and custom actions or questions only in
   the extensibility demo. Do not copy code, scenarios or knowledge between the two.
5. **Precision first, fail open (§0 rule 1, §0.5 principle 1, §8, §11).** The default mode (`guard`) takes only minimal guard-tier
   actions (`discard`, `defer`, `coalesce`, `delay`; only `discard` has an undo, so CONTRACT's "reversible" is drift:
   [decide-policy-actions](docs/agents/runtime/decide-policy-actions.md) Drift 10). An action runs only when the summed calibrated
   probability of the permitted non-passive actions reaches the candidate action's tier threshold (guard-tier 0.9, heal-tier 0.8;
   `packages/runtime/src/decide/policy.ts` -> `gate`), and the model's top diagnosis is not `expected`. If the model is unavailable, loading, late or erroring, the runtime takes the passive action. Held writes and
   requests are released when the hold budget expires. False interventions on clean runs are a first-class metric.
6. **Dependencies (§0 rule 6).** `onnxruntime-web` is the only runtime `dependency` (`packages/runtime/package.json`). Do not
   add another runtime dependency without asking. React, Redux and Zustand are optional peers.
7. **TypeScript strict, ESM only (§0 rule 6).** `tsconfig.base.json` sets `strict`, `verbatimModuleSyntax` and `isolatedModules`.
   The package is ESM-only (no `require` export). `packages/runtime/tsconfig.json` has `types: []`, so `src/` must not use Node APIs.
8. **Leave legacy content alone (§1).** "Existing GenClass content (jev_local/, extension/, docs/, etc.) stays as is." This
   covers the pre-runtime GenClass content: `jev_local/`, `extension/`, `bench/`, `results/`, `tests/`, the legacy `docs/*.md`,
   `docs/benchmax-research/` and the legacy scripts in `scripts/`. It does not cover `docs/runtime/`, `docs/agents/` or
   `scripts/vm.sh`. Edit legacy content only when the user asks ([playbooks](docs/agents/playbooks.md) recipe 27).
9. **REVIEW tests are a contract.** Never edit `packages/runtime/test/review-*.test.ts` to make them pass. Fix `src/` instead.

## 4. Where to run things

- **The team's rule (CONTRACT §0 rule 5).** "The Mac only edits files." Every build, test, browser and model run went to the Azure `train` VM through
  `scripts/vm.sh` in a per-workstream slot, because the original author's Mac has 8 GB RAM. `vm.sh` needs
  `~/.jev-local/azure_hosts`, `~/.ssh/jev_azure` and GNU `timeout`, none of which are in the repo.
- **Policy for agents (set when these docs were written, 2026-10-07).** On other machines, `npm install`, typecheck, build and unit tests are
  light and were verified locally (macOS, 16 GB RAM, Node v25.6.0, npm 11.8.0). You may run the verified commands in §5.
- **Ask the user first** before running any of these: the sim (generation, `sim/scripts/*`), training (`training/*.sh`, any Python training or eval),
  Playwright (`npm run test:browser`, the UI spec, `test/smoke/smoke.sh`), model downloads (`genclass-runtime fetch-model`,
  `demos/scripts/fetch-model.sh`), the demos' eval (`npm run eval` in `demos/`, `demos/scripts/vm-eval.sh`), or any script that touches Azure
  (`scripts/*.sh`, `training/*.sh`, `sim/scripts/*`).
- **Side effects of `npm install` at the root.** It creates an untracked root `package-lock.json` (never committed; whether to commit
  one is the user's decision). It also chmods `packages/runtime/bin/genclass-runtime.mjs` to 755, which git reports as a mode change
  (committed mode is 644). Revert it with `git checkout -- packages/runtime/bin/genclass-runtime.mjs`.

## 5. Commands

Verified when these docs were written, 2026-10-07 (Node v25.6.0). "Dir" is where to run the command from.

| command | dir | result / notes |
|---|---|---|
| `npm install` | repo root | OK in 18 s, 134 packages. One EBADENGINE warning: vitest 5.0.3 wants Node `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` (Node 25 works). Side effects: see §4 |
| `npx tsc -p tsconfig.json --noEmit` | `packages/runtime` | clean, ~1.6 s. Checks `src/` only: test files are never type-checked |
| `npx tsup` | `packages/runtime` | ~2.5 s. Cleans `dist/` first. 6 entries: `index`, `adapters/{react,redux,zustand}`, `devtools/index`, `worker`; `.d.ts` for all but `worker`; ~1.6 MB with maps |
| `NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**"` | `packages/runtime` | ~2.4 s. Files 36 passed, 1 skipped (37). Tests 286 passed, 14 skipped (300). The 14 skips are model-parity tests that need model files at `GENCLASS_MODEL_DIR` (default `<repo>/.cache-model`): `test/model/packer.test.ts` (all 10), `engine.test.ts` (3 of 4), `calibrate.test.ts` (1 of 8). With a model dir, all 300 pass |

Not verified when these docs were written (taken from [build-test-release.md](docs/agents/runtime/build-test-release.md)):

| command | dir | notes |
|---|---|---|
| `npm run build` / `npm test` | repo root | run only in `@genclass/runtime` (`tsup` / `vitest run`). `vitest.config.ts` already excludes `test/browser/**` |
| `npm run typecheck` | repo root | every workspace. The demos typecheck needs `packages/runtime/dist/*.d.ts`, so build first; it also needs the missing `demos/src/server/data/cities.ts` (see [demos.md](docs/agents/demos.md)). Until that file is recreated, the demos typecheck, and so the root typecheck, fails (inferred from the imports; not run) |
| `npx vitest run test/atoms.test.ts -t "late discard"` | `packages/runtime` | one file or one test |
| `npm run test:browser` | `packages/runtime` | **ask first.** Playwright, rebuilds `dist/`, needs Chromium for `@playwright/test` 1.63.0 and a model dir, overwrites the committed UI screenshots |
| `npx playwright test --config test/browser/ui/playwright.config.ts` | `packages/runtime` | **ask first.** Devtools UI spec, writes 18 screenshots |
| `bash test/smoke/smoke.sh` | `packages/runtime` | **ask first.** `npm pack` into a temp Vite 8 app (registry access), then headless Chromium; leaves the `.tgz` and the temp dir |
| `npm run build && cd sim && SIM_RUNTIME=real npx vitest run` | repo root | **ask first** (sim). Sim tests against the real runtime; without `SIM_RUNTIME=real` they use a fake runtime |
| `node packages/runtime/bin/genclass-runtime.mjs fetch-model <dir> --from https://github.com/MeharPro/GenClass/releases/download/v0.1.0/` | repo root | **ask first** (download). Fetches the v0.1 model for the model tests (`GENCLASS_MODEL_DIR=<dir>`). The default `--from` is an unpublished release |
| `scripts/vm.sh run\|exec <SLOT> '<cmd>'` | repo root | **ask first** (Azure). The original team's path for every command above |

## 6. Top-level layout

| path | what it is | doc |
|---|---|---|
| `packages/` | `runtime/`: the `@genclass/runtime` library (`src/`, `test/`, `bin/genclass-runtime.mjs` CLI, `STATUS.md`, `UI-NEEDS.md`). `runtime-model/`: only `MODEL_CARD.md` of the unpublished model package | [docs/agents/runtime/](docs/agents/runtime/public-api-and-lifecycle.md) (8 docs; start with public-api-and-lifecycle, [build-test-release](docs/agents/runtime/build-test-release.md)) and [model-io-contract](docs/agents/model-io-contract.md) |
| `sim/` | `@genclass/sim`: training-data simulator driving the real runtime (private, Node 22 ESM) | [sim.md](docs/agents/sim.md) |
| `training/` | Python training, eval and export of the runtime model (R17/R32), plus Azure scripts | [training.md](docs/agents/training.md) |
| `demos/` | `@genclass/demos`: six Vite demo apps, Service Worker chaos backend, Playwright trial harness | [demos.md](docs/agents/demos.md) |
| `docs/` | `runtime/` (`CONTRACT.md`, which is binding, plus `API.md` and `ARCHITECTURE.md`; all three drift from the code), `agents/` (these docs), legacy `*.md` and `benchmax-research/` (do not edit) | [status-and-known-issues](docs/agents/status-and-known-issues.md) (drift tables) |
| `jev_local/` | legacy Python predecessor (`jev-local`): the model the runtime's `src/model` was ported from, the trainer `training/` drives, server and harness | [genclass-model-lineage.md](docs/agents/genclass-model-lineage.md) |
| `tests/` | Python tests for `jev_local` (the 20 `test_data_*.py` files fail at collection: `jev_local/data` is gitignored) | [genclass-model-lineage.md](docs/agents/genclass-model-lineage.md) |
| `extension/` | legacy GenClass 0.1.0 MV3 voice-control Chrome extension, the JS ancestor of `src/model` | [extension-and-benchmarks.md](docs/agents/extension-and-benchmarks.md) |
| `bench/`, `results/` | benchmark pre-registrations and published results (jevbench, benchmax, CU head-to-head) | [extension-and-benchmarks.md](docs/agents/extension-and-benchmarks.md) |
| `scripts/` | ops and benchmark scripts; for the runtime: `vm.sh` (VM build/test), `azvm.sh` and `launch_run.sh` (called by `training/*.sh`), and `genclass_export.py` (its `ExportModel` is imported by `training/export_runtime.py`) | [extension-and-benchmarks.md](docs/agents/extension-and-benchmarks.md) (one row per script) |
| root files | `package.json` (workspaces), `tsconfig.base.json`, `pyproject.toml` (`jev-local`), `OPEN_TASKS.md`, `README.md`, `BENCHMARKS.md`, `LICENSE` (Apache-2.0) | [status-and-known-issues](docs/agents/status-and-known-issues.md) |

## 7. Conventions

**Code (observed in `packages/runtime/src`; there is no formatter or linter config).**
- Every module opens with a `//` header comment that states its role and invariants. Many cite the CONTRACT section they implement
  (e.g. `// Policy gate for non-passive actions (CONTRACT §8)`). Most `packages/runtime/src/model/*` headers name the
  `jev_local` Python file or extension code they port.
- Comments are sparse: about 4-10% of lines in the large modules. Use `/** */` JSDoc on exported symbols and non-obvious fields. Inline
  comments mostly explain why, or state an invariant.
- Naming: PascalCase classes and types (`RuntimeImpl`, `StoreHub`, `OpRegistry`), camelCase functions, UPPER_SNAKE module constants
  (`LATE_REVERT_MS`, `CACHE_MAX`), short locals. Named exports only. The one default export is
  `packages/runtime/src/index.ts` -> `GenClass`.
- Imports: relative paths with `.js` extensions; `import type` for types (`verbatimModuleSyntax`). Style: 2-space indent,
  double quotes, semicolons, lines mostly at most 120 chars.
- Errors: never throw into the host app. Hooks, plugins, listeners and callbacks run in `try/catch` with a comment
  (`/* hooks never break the app */`, `/* listeners never break tracing */`). `ask()`/`decide()` reject with
  `GenClassUnavailableError` and a `reason` (`packages/runtime/src/errors.ts`); with `timeoutMs` set, a failed model load
  rejects with the provider's own error instead. A failing action controller throws a plain `Error` with an English
  message: the runtime records `ok: false` plus `error` on the `ActionRecord` and runs the passive action instead.
- Every user-visible or model-visible string (facts, reports, `changed` sentences) is plain English. Model-visible text is frozen (rule 2).

**Tests (`packages/runtime/test/`, vitest).**
- One `<area>.test.ts` per area (`test/model/` for model code). Use `test/helpers.ts`: `setup()` returns `{ clock, server, g, decider, rt, fetch }`
  and builds a `FakeClock`, a `FakeServer`, an instrumented global and a `ScriptedDecider` around `createRuntime`. There is no real time, network or model.
- Drive time with `clock.advance(ms)` / `clock.flush()`. Control answers with `defaultScript({ <trigger>: { diagnosis, action } })`,
  or with `ManualDecider` plus `answer()`. Force consultation with `triage: "always"`. Assert on `decider.calls[i].state`, `rt.decisions()`,
  `rt.interventions()`, `server.hits`.
- Name the CONTRACT section in the `describe` (e.g. `"atoms and the mutation pipeline (CONTRACT §4)"`). DOM tests start with
  `// @vitest-environment happy-dom`. Never use real timers or `Date.now` in tests except where noted in the build doc.

**Coordination files (the original team's protocol; keep using it).**
- `OPEN_TASKS.md` (lead): project status in Done / In progress / Next / Needs the user / Known risks.
- `packages/runtime/STATUS.md` (CORE): test state, batch changes, headless recipe, trigger table, example situations,
  **Deviations from the contract (and why)**, **Open issues**.
- `NEEDS.md` files live in the *requester's* directory: `sim/NEEDS.md`, `training/NEEDS.md`, `demos/NEEDS.md`, and
  (an exception) `packages/runtime/UI-NEEDS.md`. `sim/NEEDS.md` and `training/NEEDS.md` mark items OPEN (needed) / ASK (would help) /
  DONE (landed and verified by the requester), and training/NEEDS also uses INFO. `UI-NEEDS.md` uses Open / Nice to have / Done
  sections. `demos/NEEDS.md` uses numbered sections addressed to an owner. Owners may add answers to a requester's file
  (training/NEEDS has "CORE → TRAIN" and "MODEL → TRAIN (from MODEL, ...)" sections); only the requester closes an item.
- `docs/runtime/CONTRACT.md` (lead): the binding spec. An approved change is appended to §13, and an accepted divergence goes into STATUS
  "Deviations". A deviation without a STATUS entry is a bug. CONTRACT, STATUS, API.md and the NEEDS files are stale in places
  (CONTRACT was last edited before batch 3): check the drift tables in the status doc before relying on them.

## 8. Definition of done

1. If you touched `packages/runtime/src`: `npx tsc -p tsconfig.json --noEmit` is clean, and `npx tsup` still builds when you changed
   entries, exports or the worker. Keep tsup entries as literal `"src/...ts"` strings, and keep the worker URL and ORT `import()` literals.
2. Unit tests pass: 286 passed and 14 skipped without a model dir (all 300 with one), plus new tests in house style for new
   behaviour. No `review-*.test.ts` was edited. For sim or demos changes, name the checks you could not run and why.
3. No model-visible text changed (rule 2), unless the user explicitly approved it. If it was approved, also update the exact-text
   tests and the STATUS example situations, and flag that SIM data and training must be regenerated.
4. Update the affected `docs/agents/` doc(s) (see [docs/agents/README.md](docs/agents/README.md)) and set its header line
   `Verified against commit <sha> (<date>)` to the commit you re-checked it against. A public-surface change also updates
   `docs/runtime/API.md` and the JSDoc in `packages/runtime/src/types.ts`.
5. If behaviour changed: update `packages/runtime/STATUS.md` (Updated line, batch section, Deviations, Open issues) and move the item
   in `OPEN_TASKS.md`. Add or answer the relevant `NEEDS.md` item.
6. Leave no `npm install` side effects in the diff: revert the `bin/genclass-runtime.mjs` mode change and do not commit the root
   `package-lock.json` unless the user decided to.
