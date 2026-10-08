# AGENTS.md

Root entry point for AI coding agents in GenClass-lib.

> **Source of truth:** the code. Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins.

## 1. What this repo is

- `@genclass/runtime` (`packages/runtime/`) is an npm library for self-healing web apps. It observes a running app
  (fetch/XHR/WebSocket/EventSource, user actions, timers, state stores, errors, causality) and computes generic facts.
  For salient situations a small local model (ONNX in a Web Worker, WebGPU or WASM) chooses a diagnosis and an action,
  which must pass a precision-first policy gate. Without a model the runtime only observes.
- **Situation-v2 design:** decisions happen at the network boundary. The `delivery` trigger (`packages/runtime/src/types.ts`
  -> `TriggerKind`) holds only the delivery of a response or push message, and only when newer data already sits in the
  fields it would write. Store writes are not held by default (`policy.holdWrites` is opt-in).
- `sim/` generates training data by driving the real runtime. `realapps/` runs real framework apps in headless Chromium
  with the real runtime for real-browser training rows and the "never worse" sweep. `training/` trains and exports the
  model. `demos/` holds six evaluation apps.
- `jev_local/`, `extension/`, `bench/`, `results/`, `tests/` and the legacy `docs/*.md` are the older GenClass model,
  Chrome extension and benchmarks that the runtime builds on.
- npm workspaces: `packages/*`, `sim`, `demos` (`realapps/` has its own `package.json` but is not a workspace).

Read next: **[HANDOFF.md](HANDOFF.md)** (the team's live handoff, kept current by the colleague, Mehar) and
**[docs/agents/README.md](docs/agents/README.md)** (index: which doc answers which question), then
[overview](docs/agents/overview.md), [repo-map](docs/agents/repo-map.md), [glossary](docs/agents/glossary.md),
[playbooks](docs/agents/playbooks.md), [status-and-known-issues](docs/agents/status-and-known-issues.md) and
[RELEASE.md](RELEASE.md) (release procedure).

## 2. Status in brief (2026-10-08)

- **Branches.** `mvp-v2` (here) = `origin/runtime` 74f17c0 (Mehar's latest: runtime batches 4 and 5, situation-v2, `realapps/`,
  v2 curriculum port, `HANDOFF.md`, `docs/runtime/RESULTS.md`) plus six local commits: 7dab2b3 (these agent docs),
  f3636b2 (default mode `observe`), b435acb (CI, committed root lockfile, CLI mode 100755), b561244 and 6ac4737 (docs),
  806a296 (release commit, `packages/runtime` version `0.1.0-alpha.1`; the head). Not pushed. The local
  branch `mvp` is based on situation-v1 (654d822) and is superseded.
- **Runtime:** situation-v2, frozen at tag `situation-v2` (6e5e86e). Since that tag, `packages/runtime/src` changed only in
  f3636b2 (`runtime.ts`, `types.ts`, `devtools/index.ts`); `git diff situation-v2 HEAD -- packages/runtime/src/situation` is empty.
- **Model: none for v2.** Round-1 R17/R32 models were trained on situation-v1 and do not match this runtime. The v2 plan
  (HANDOFF "Current state"): 150M teacher on v2 gold -> teacher labels on unlabeled rows -> distil R17 (default) and R32 ->
  DAgger via SIM `--on-policy` -> EVAL -> `@genclass/runtime-model@0.1.0` -> demos rerun -> `@genclass/runtime@0.1.0`.
- **Data is being generated now on Azure by Mehar** (per `training/NEEDS.md`): SIM situation-v2 gold and unlabeled rows on
  20 nodes, REAL real-browser gold rows on 3 nodes. Nobody on our side touches Azure.
- **npm:** `@genclass/runtime@0.1.0-alpha.1` is `latest` (published 2026-10-08 from 806a296: NaN fix, situation-v2,
  default `observe`). `0.1.0-alpha.0` predates situation-v2 and defaults to `guard`. Neither has a model.
  `@genclass/runtime-model` is not published, so `packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL` and the
  CLI's `DEFAULT_FROM` 404: a default `GenClass.init()` ends with model status `error` and logs
  `[GenClass] Model unavailable (...); observing only.` Release plan: [RELEASE.md](RELEASE.md) (see also
  [build-test-release](docs/agents/runtime/build-test-release.md) "Cut a release").
- **Stale human docs:** `HANDOFF.md` ('Modes: observe → guard (default; ...)') and the older published `0.1.0-alpha.0` still
  say guard is the default; both READMEs now say observe. Test counts in STATUS/HANDOFF are older. Drift tables: [status-and-known-issues](docs/agents/status-and-known-issues.md).
- **Open defects found by review at b435acb** (details and fixes in the subsystem docs' "Drift and open issues"):
  the F2 content fact can print the raw text of redacted fields (`situation/content.ts` -> `contentFacts`); a delivery
  `discard` applies a Redux/Zustand dispatch whole when it also changes other fields, yet the record names the fields
  as dropped (`state/hub.ts` -> `StoreHub.applyFilter`); SIM still samples the
  v1 3,200-char budget (`sim/src/world/scenario.ts`); unlabeled SIM rows hard-label `expected` diagnoses that S1 would
  relabel. Several of these touch model-visible text or live data generation: coordinate with the user before fixing.
- `demos/src/server/data/cities.ts` is not in git (root `.gitignore` rule `data/`), so a fresh clone cannot build or
  typecheck the demos, and root `npm run typecheck` fails.

## 3. Ground rules (binding; `docs/runtime/CONTRACT.md` §0, §0.5, §13)

CONTRACT: "If something here is wrong, tell the lead; do not silently diverge." The roles in the docs (lead, CORE, MODEL,
UI, SIM, REAL, DEMOS, TRAIN, REVIEW) belong to the original team. Where a rule says "ask the lead", ask the user.

1. **No hardcoded bug rules in the runtime.** The runtime may compute generic facts and triage (decide whether a situation
   is worth asking the model about). It never maps a fact pattern to a diagnosis or action with an if/then. Triage is
   `facts.every((f) => f.neutral)` in `packages/runtime/src/runtime.ts` -> `RuntimeImpl.trigger`; actions are chosen only by
   `packages/runtime/src/decide/policy.ts` -> `gate`; `packages/runtime/src/situation/build.ts` -> `builtinApplicable`
   says only whether an action *can* run.
2. **Situation-v2 freeze (train/runtime parity).** There is one implementation of situation building and serialization:
   `packages/runtime/src/situation/*`. The sim drives the real runtime (`sim/src/run/rt.ts` -> `realRuntimeFactory`),
   realapps bundles it from source, and `training/curriculum/rt.py` ports it. **Any change to
   `packages/runtime/src/situation/*` or to other model-visible text** (facts, questions, action/diagnosis wording,
   `packages/runtime/src/util.ts` formatting and redaction, op/event names) **means a new tag and regenerated data** (and
   an `rt.py` mirror and retraining). Data is being generated from this code right now: never make such a change without
   the user's explicit go-ahead. See [model-io-contract](docs/agents/model-io-contract.md).
3. **Determinism.** Runtime code never calls `Math.random`, `Date.now` or `performance.now` directly and never schedules
   with the global `setTimeout`; it uses the injected `Clock` (`packages/runtime/src/clock.ts`). IDs come from counters.
   Same inputs give byte-identical situations. Known exceptions, none touching situation text:
   `packages/runtime/src/model/engine.ts` (default `now`), `packages/runtime/src/model/host.ts` -> `scheduleIdle`
   (`requestIdleCallback`), `packages/runtime/src/devtools/index.ts` (`rawRaf`, `rawSetTimeout`).
4. **Honest-evaluation separation.** `sim/` and `realapps/` never read or model `demos/`; demos are never tuned and contain
   nothing beyond a normal integration. (`realapps/` does import the sim's cost weights and label rule from `sim/src`.)
5. **Default `observe`; never make a correct app worse.** Since f3636b2 the default mode is `observe` (`runtime.ts` ->
   `o.mode ?? "observe"`, CONTRACT §13): it never takes an action. `guard` is opt-in (minimal guard-tier actions:
   `discard`, `defer`, `coalesce`, `delay`); `heal` is experimental. An action runs only when the summed calibrated
   probability of permitted non-passive actions reaches the tier threshold (`decide/policy.ts`: guard 0.9, heal 0.8) and
   the top diagnosis is not `expected`. Model unavailable, loading, late or erroring means the passive action; holds are
   released when the hold budget expires. False interventions on clean runs are a first-class metric: report FIR next to
   every recall number (HANDOFF "How to continue" step 4).
6. **Dependencies.** `onnxruntime-web` is the only runtime `dependency`. Ask before adding another. React, Redux and
   Zustand are optional peers. Keep the committed root `package-lock.json` in sync (CI runs `npm ci`).
7. **TypeScript strict, ESM only.** `tsconfig.base.json` sets `strict`, `verbatimModuleSyntax`, `isolatedModules`.
   `packages/runtime/tsconfig.json` has `types: []`, so `src/` must not use Node APIs.
8. **Leave legacy content alone** (CONTRACT §1): `jev_local/`, `extension/`, `bench/`, `results/`, `tests/`, legacy
   `docs/*.md`, `docs/benchmax-research/`, legacy `scripts/`. Not covered: `docs/runtime/`, `docs/agents/`, `scripts/vm.sh`.
9. **REVIEW tests are a contract.** Never edit `packages/runtime/test/review-*.test.ts` to make them pass. Fix `src/`.

## 4. Where to run things

- **Our run policy (lead, 2026-10-08).** Light local checks are fine on this machine (macOS, 16 GB, Node v25.6.0):
  `npm install`/`npm ci`, `tsc`, `tsup`, vitest unit tests (runtime and sim).
- **Ask the user first** before: Playwright (`npm run test:browser`, the UI spec), `test/smoke/smoke.sh`, the sim generator
  (`sim/scripts/*`, `gen.js`), training (`training/*.sh`, any Python training or eval), realapps runs (`gen.js`,
  `debug.js`, `realapps/scripts/*`), the demos' eval, model downloads (`genclass-runtime fetch-model`), **anything on
  Azure** (`scripts/*.sh`, `az`, ssh to nodes), **`git push`** and **`npm publish`**.
- `HANDOFF.md` "Rules" ("never run npm, tsc, vitest ... on the Mac"; build and test on the Azure `train` VM via
  `scripts/vm.sh`) describes Mehar's workflow on his 8 GB Mac and his Azure cluster. It is context, not instructions for us.

## 5. Commands (verified 2026-10-08 on mvp-v2, Node v25.6.0)

| command | dir | result / notes |
|---|---|---|
| `npm ci --no-audit --no-fund` | repo root | OK from the committed lockfile (fresh clone too). Add `ONNXRUNTIME_NODE_INSTALL=skip` on Linux, as CI does. EBADENGINE warning from vitest on Node 25 is harmless |
| `npx tsc -p tsconfig.json --noEmit` | `packages/runtime` | clean. Checks `src/` only: test files are never type-checked |
| `npx tsup` | `packages/runtime` | OK. 6 entries (`index`, 3 adapters, `devtools/index`, `worker`) into `dist/` |
| `NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts` | `packages/runtime` | Files 40 passed, 1 skipped (41). Tests 332 passed, 14 skipped (346). The 14 skips are model-parity tests needing `GENCLASS_MODEL_DIR` |
| `NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts` | `packages/runtime` | 4 passed. Run it alone: in a full parallel run it flaked once (5.5 ms vs a 2 ms bound). CI uses `--retry=2` |
| `npm run build` then `SIM_RUNTIME=real npx vitest run` | root, then `sim/` | 19 passed (5 files). Sim `tsc` clean. Without `SIM_RUNTIME=real` the sim tests use a fake runtime |

Total: 350 runtime unit tests (336 passed, 14 skipped without a model dir). CI (`.github/workflows/ci.yml`, Node 22) runs
`npm ci` -> runtime typecheck -> build -> the two vitest steps above; triggers: push to `main`/`runtime`/`mvp`/`mvp-v2`,
`pull_request`, `workflow_dispatch`. It has not run on GitHub yet (mvp-v2 is not pushed). Not run by us: Playwright,
`smoke.sh`, realapps, demos eval, Python tests, training. One test: `npx vitest run test/delivery.test.ts -t "<name>"`.

## 6. Top-level layout

| path | what it is | doc |
|---|---|---|
| `packages/runtime/` | `@genclass/runtime`: `src/`, `test/`, `bin/genclass-runtime.mjs` CLI, `STATUS.md` (runtime state, example situations, deviations), `UI-NEEDS.md` | [runtime/](docs/agents/runtime/public-api-and-lifecycle.md) (8 docs; start with public-api-and-lifecycle and [build-test-release](docs/agents/runtime/build-test-release.md)), [model-io-contract](docs/agents/model-io-contract.md) |
| `packages/runtime-model/` | only `MODEL_CARD.md` of the unpublished model package | [model-host](docs/agents/runtime/model-host.md) |
| `sim/` | `@genclass/sim`: deterministic training-data simulator (S1/S2 labels, `SEPARABILITY.md`) | [sim.md](docs/agents/sim.md) |
| `realapps/` | 91 real apps (corpus + 14 open-source Conduit front-ends) in headless Chromium; REAL rows and the never-worse sweep | [realapps.md](docs/agents/realapps.md) |
| `training/` | Python training, curriculum (`curriculum/rt.py`), eval, export, Azure launch scripts; `NEEDS.md`, `LOG.md`, `EVAL.md` | [training.md](docs/agents/training.md) |
| `demos/` | `@genclass/demos`: six Vite demo apps, Service Worker chaos backend, Playwright trials | [demos.md](docs/agents/demos.md) |
| `docs/runtime/` | `CONTRACT.md` (binding; changes appended to §13), `API.md`, `ARCHITECTURE.md`, [RESULTS.md](docs/runtime/RESULTS.md) (model and design comparisons, data volume, training log) | [status-and-known-issues](docs/agents/status-and-known-issues.md) |
| `docs/agents/` | these docs | [README](docs/agents/README.md) |
| `.github/workflows/ci.yml` | the only CI workflow | [build-test-release](docs/agents/runtime/build-test-release.md) |
| `jev_local/`, `tests/` | legacy Python predecessor and its tests | [genclass-model-lineage](docs/agents/genclass-model-lineage.md) |
| `extension/`, `bench/`, `results/`, `scripts/` | legacy extension and benchmarks; `scripts/vm.sh`, `azvm.sh`, `launch_run.sh`, `genclass_export.py` serve the runtime | [extension-and-benchmarks](docs/agents/extension-and-benchmarks.md) |
| root files | `HANDOFF.md` (live handoff), `OPEN_TASKS.md`, [`RELEASE.md`](RELEASE.md) (release procedure), `package.json` + `package-lock.json`, `tsconfig.base.json`, `pyproject.toml`, `README.md`, `BENCHMARKS.md`, `LICENSE` (Apache-2.0) | [repo-map](docs/agents/repo-map.md) |

## 7. Conventions

**Code (observed in `packages/runtime/src`; no formatter or linter config).**
- Every module opens with a `//` header comment stating its role and invariants, often citing the CONTRACT section.
- Sparse comments; `/** */` JSDoc on exported symbols and non-obvious fields. PascalCase classes/types (`RuntimeImpl`,
  `StoreHub`, `OpRegistry`), camelCase functions, UPPER_SNAKE module constants (`LATE_REVERT_MS`, `CACHE_MAX`).
  Named exports only, except `packages/runtime/src/index.ts` -> `GenClass` (default export).
- Relative imports with `.js` extensions; `import type` for types. 2-space indent, double quotes, semicolons, ~120 chars.
- Never throw into the host app: hooks, plugins, listeners and callbacks run in `try/catch` with a comment.
  `ask()`/`decide()` reject with `GenClassUnavailableError` (`packages/runtime/src/errors.ts`). A failing action
  records `ok: false` on the `ActionRecord` and the passive action runs instead.
- Model-visible text is plain English and frozen (rule 2).

**Tests (`packages/runtime/test/`, vitest).**
- One `<area>.test.ts` per area (`test/model/` for model code). `test/helpers.ts` -> `setup()` returns
  `{ clock, server, g, decider, rt, fetch }` around `createRuntime` with `FakeClock`, `FakeServer` and `ScriptedDecider`.
  No real time, network or model.
- `setup()` defaults to `mode: "guard"` (not the product default); pass `mode: undefined` for `observe`
  (`test/default-mode.test.ts`). Held store writes need `policy: { holdWrites: true }`; delivery behaviour is in
  `delivery.test.ts`, `content.test.ts`, `no-reorder.test.ts`.
- Drive time with `clock.advance(ms)` / `clock.flush()`; control answers with `defaultScript(...)` or `ManualDecider`;
  force consultation with `triage: "always"`. Name the CONTRACT section in the `describe`. DOM tests start with
  `// @vitest-environment happy-dom`.

**Coordination files (the team's protocol; keep using it).**
- `HANDOFF.md`: live state and how to continue. `OPEN_TASKS.md`: Done / In progress / Next / Needs the user / Known risks.
- `packages/runtime/STATUS.md`: test state, batch changes, example situations, "Deviations from the contract", "Open issues".
- [docs/runtime/RESULTS.md](docs/runtime/RESULTS.md): update it with every result (HANDOFF repo map).
- `NEEDS.md` files live in the requester's directory (`sim/`, `training/`, `demos/`, plus `packages/runtime/UI-NEEDS.md`);
  only the requester closes an item. `training/NEEDS.md` also holds Azure node claims and data locations.
- `docs/runtime/CONTRACT.md`: approved changes go to §13; an accepted divergence goes into STATUS "Deviations".

## 8. Definition of done

1. If you touched `packages/runtime/src`: `tsc` clean and `tsup` builds (keep tsup entries as literal `"src/...ts"`
   strings and the worker URL / ORT `import()` literals).
2. Runtime unit tests pass in both CI steps (§5: 332 + 14 skipped, then review-perf 4), plus new tests in house style.
   No `review-*.test.ts` edited. For sim, realapps, demos or training changes, name the checks you could not run and why.
3. No model-visible text changed (rule 2) unless the user approved it; if approved, update exact-text tests and STATUS
   example situations, and flag that a new situation tag, `rt.py` mirror, regenerated data and retraining are needed.
4. Update the affected `docs/agents/` doc(s) and set the header's "Verified against" line to the commit you re-checked.
   A public-surface change also updates `docs/runtime/API.md` and the JSDoc in `packages/runtime/src/types.ts`.
5. If behaviour changed: update `packages/runtime/STATUS.md`, `OPEN_TASKS.md`, `HANDOFF.md` if its state table changes,
   `docs/runtime/RESULTS.md` for new numbers, and the relevant `NEEDS.md` item.
6. A dependency change commits the updated root `package-lock.json` in the same commit.
7. Commit locally with the attribution the session gives you; **do not push or publish without the user** (publish steps: [RELEASE.md](RELEASE.md)).
