# AGENTS.md

Root entry point for AI coding agents in GenClass-lib.

> **Source of truth:** the code. Verified against branch `mvp-v2-merge` at f107013 (`mvp-v2` + origin/runtime eff18cb merged + two runtime fixes), 2026-10-08 ~07:00 UTC. If this doc and the code disagree, the code wins.

## 1. What this repo is

- `@genclass/runtime` (`packages/runtime/`) is an npm library for self-healing web apps. It observes a running app
  (fetch/XHR/WebSocket/EventSource, user actions, timers, state stores, errors, causality) and computes generic facts.
  For salient situations a small local model (ONNX in a Web Worker, WebGPU or WASM) chooses a diagnosis and an action,
  which must pass a precision-first policy gate. Without a model the runtime only observes.
- **Situation-v2 design:** decisions happen at the network boundary. The `delivery` trigger (`packages/runtime/src/types.ts`
  -> `TriggerKind`) holds only the delivery of a response or push message, and only when newer data already sits in the
  fields it would write. Store writes are not held by default (`policy.holdWrites` is opt-in).
- **Install paths** (Mehar's f3a9dd1, merged here, **not in the published `0.1.0-alpha.1`**): `npx @genclass/runtime init`
  / `remove` (`packages/runtime/bin/lib/*`), the zero-code import `@genclass/runtime/auto` (and `/auto/observe`,
  `/auto/guard`, `/auto/heal`; `packages/runtime/src/auto.ts`, `packages/runtime/src/cdn/auto-*.ts`) and a CDN script
  tag (`dist/genclass.global.min.js`; `packages/runtime/src/cdn/global.ts`).
- **Telemetry (since `0.1.0-beta.3`, owner decision 2026-10-09):** `GenClass.init()` in a browser sends anonymous
  diagnostics by default (decisions with the redacted situation text, action outcomes, detections, model status,
  counts) to the Cloudflare Worker in `telemetry-worker/` (R2 bucket `genclass-telemetry`). Client:
  `packages/runtime/src/telemetry/*`; disclosure: `packages/runtime/TELEMETRY.md`; agent doc:
  [docs/agents/telemetry.md](docs/agents/telemetry.md). Off in `createRuntime()`, Node/SSR and the realapps harness.
- `sim/` generates training data by driving the real runtime. `realapps/` runs real framework apps in headless Chromium
  with the real runtime for real-browser training rows and the "never worse" sweep. `training/` trains and exports the
  model. `demos/` holds six evaluation apps.
- `jev_local/`, `extension/`, `bench/`, `results/`, `tests/` and the legacy `docs/*.md` are the older GenClass model,
  Chrome extension and benchmarks that the runtime builds on.
- npm workspaces: `packages/*` (now also `packages/genclass-runtime`, the unpublished unscoped CLI alias), `sim`,
  `demos` (`realapps/` has its own `package.json` but is not a workspace).

Read next: **[HANDOFF.md](HANDOFF.md)** (the team's live handoff, kept current by the colleague, Mehar) and
**[docs/agents/README.md](docs/agents/README.md)** (index: which doc answers which question), then
[overview](docs/agents/overview.md), [repo-map](docs/agents/repo-map.md), [glossary](docs/agents/glossary.md),
[playbooks](docs/agents/playbooks.md), [status-and-known-issues](docs/agents/status-and-known-issues.md) and
[RELEASE.md](RELEASE.md) (release procedure).

## 2. Status in brief (2026-10-08, ~07:00 UTC)

- **Branches.** `mvp-v2-merge` (here, head f107013, not pushed) = `mvp-v2` (c16a3b0: `origin/runtime` 74f17c0 plus
  7dab2b3 agent docs, f3636b2 default mode `observe`, b435acb CI + committed root lockfile, b561244/6ac4737 docs,
  806a296 release commit `0.1.0-alpha.1`, c16a3b0 publish record) + dabbce2 (merge of Mehar's `origin/runtime` at
  eff18cb: d53e836 realapps wave 3, d05abc1 npm README, 2516a6e OPEN_TASKS, 29b7f28 `situation()` purity test,
  f3a9dd1 one-command install, eff18cb "v2 data done") + 10e5c3b (lockfile sync) + 054da38 and f107013 (the two runtime
  fixes below). `origin/runtime` has since moved on to 5bc40c9 (ca08174 realapps wave 4, 6d6eb00 REAL v2 production
  done, 416e374 first r17-v2a results, 5bc40c9 runtime batch 6 with tag `situation-v2.1`); none of these four is in
  this branch. The local branch `mvp-v2-b6` (4e95373, worktree `GenClass-lib-b6`) merges 5bc40c9 on top of f107013;
  this doc does not describe it. `mvp` (situation-v1) is superseded.
- **Runtime:** situation-v2 (tag `situation-v2`, 6e5e86e) plus: default `observe`; the install entries (`src/auto.ts`,
  `src/cdn/*`); **054da38**: observe mode never holds or delays a delivery (released synchronously before any body
  read; the delivery decision is still made in the background and recorded with `executed: false`); **f107013**: the
  F2 fact no longer diffs redacted text (`packages/runtime/src/state/fields.ts` -> `redactedStringDiff`) and the
  default redactor hides numbers, bigints and arrays under strong secret-named containers (`packages/runtime/src/util.ts`
  -> `isSensitivePath`). f107013 changes model-visible text for redacted values only, so `git diff situation-v2 HEAD --
  packages/runtime/src/situation packages/runtime/src/state/fields.ts packages/runtime/src/util.ts` is no longer empty
  (`content.ts`, `fields.ts`, `util.ts`); no new tag was cut and the v2 data predates it (`packages/runtime/STATUS.md`
  "Fix after 0.1.0-alpha.1").
- **Data and training (Azure, Mehar's jobs; they run on their own, Mehar is asleep):** SIM v2 data is done: 10,423,855
  gold and 51,272,078 unlabeled rows (`OPEN_TASKS.md` "Done"). `r17-v2a` (R17 on v2 gold, 64 ranks, launched 05:14 UTC,
  ETA ≈ 06:20; `training/v2_post.sh` then evaluates `sim2e`/`sim2f`, exports and serves the tar) and `t150-v2a` (150M
  teacher, 88 ranks, launched 05:20 UTC, ETA ≈ 08:30) per `training/LOG.md`. Not in this branch but on
  `origin/runtime` (416e374, `docs/runtime/RESULTS.md`): r17-v2a finished, `sim2e` diagnosis 84.4%, action 77.9%, guard
  FIR 0.00%, heal FIR 0.46%, recall at the fixed gates very low. REAL `v2c*` gold had not landed at eff18cb.
- **Model: published** (2026-10-08 ~13:40 UTC): `@genclass/runtime-model@0.1.0` (`r17-v2b`, `latest`). `packages/runtime/src/model/host.ts` ->
  `DEFAULT_MODEL_BASE_URL` and the CLI's `DEFAULT_FROM` (both the jsDelivr `files/` directory) now resolve.
- **npm (updated 2026-10-08 ~13:40 UTC):** `@genclass/runtime@0.1.0-beta.0` is `latest` (from 1f0f617; install paths, fixes, batch 6+, ships with the model); `0.1.0-alpha.0` is deprecated. Older note: `@genclass/runtime@0.1.0-alpha.1` was `latest` (published 2026-10-08 from 806a296: NaN fix, situation-v2,
  default `observe`). It does **not** contain the install paths (`./auto` exports, `dist/cdn/`, the global build,
  `init`/`remove`) nor the two fixes. **The next release** (`0.1.0-alpha.2`, or a beta together with the v2 model once
  validated) carries them. `packages/runtime/package.json` and `packages/genclass-runtime/package.json` still say
  `0.1.0-alpha.1`: bump before any build or pack that is meant to ship (the global build bakes the version into its
  CDN URLs). Release plan: [RELEASE.md](RELEASE.md).
- **Open defects in the install code (review 2026-10-08, all confirmed; none shipped yet):** high: `init` and
  `init --mode guard` install observe while printing "Mode guard" (`packages/runtime/bin/lib/plan.mjs` -> `AUTO`,
  `scriptTag`; `packages/runtime/bin/lib/init.mjs` -> `USAGE` still says "guard (default)"); medium: the tree's version
  makes the CLI and global build point at the published alpha.1, which lacks these files, and `CHANGELOG.md` lists the
  install under alpha.1; `remove` breaks the build after a formatter wraps the marked lines
  (`packages/runtime/bin/lib/edit.mjs` -> `removeMarked`); `/auto` and `/devtools` do not resolve under TypeScript
  `moduleResolution: node` (no `typesVersions`); any esbuild/rollup/parcel/webpack dependency is treated as a browser
  app (`packages/runtime/bin/lib/detect.mjs` -> `detectProject`); local SRI is added to any `--cdn` URL
  (`plan.mjs` -> `integrityFor`); low: five more. Full table: [status-and-known-issues](docs/agents/status-and-known-issues.md#install-code-review-2026-10-08).
- **Earlier review (situation-v2 work):** SIT-1, SIT-3 (redaction) and DL-3, DL-4 (observe deliveries) are fixed here;
  still open among others: a delivery `discard` applies a Redux/Zustand dispatch whole when it also changes other
  fields, yet the record names the fields as dropped (`state/hub.ts` -> `StoreHub.applyFilter`); SIM samples the v1
  3,200-char budget (`sim/src/world/scenario.ts`); unlabeled SIM rows hard-label `expected` diagnoses that S1 would
  relabel. Several touch model-visible text or data generation: coordinate with the user before fixing.
- **Stale human docs:** `HANDOFF.md` ('Modes: observe → guard (default; ...)'),
  `packages/runtime/test/install/INSTALL-README-SNIPPET.md` and the `init` usage text still say guard is the default;
  both READMEs say observe. Test counts in STATUS/HANDOFF are older. Drift tables:
  [status-and-known-issues](docs/agents/status-and-known-issues.md).
- `demos/src/server/data/cities.ts` was not in git (root `.gitignore` rule `data/`); on `heal/overnight` it is
  recreated (synthetic populations) and un-ignored (`!demos/src/server/data/`), and the demos have an `observe` mode,
  `telemetry: false` everywhere and the benchmark knobs of `bench/heal/README.md`.

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
   an `rt.py` mirror and retraining). Training runs on v2 data right now: never make such a change without the user's
   explicit go-ahead. This branch already carries one such change: f107013 (a privacy fix) changes the text of
   redacted values only, and no new tag was cut; the curriculum port does not mirror it (`packages/runtime/STATUS.md` "Fix after
   0.1.0-alpha.1"). See [model-io-contract](docs/agents/model-io-contract.md).
3. **Determinism.** Runtime code never calls `Math.random`, `Date.now` or `performance.now` directly and never schedules
   with the global `setTimeout`; it uses the injected `Clock` (`packages/runtime/src/clock.ts`). IDs come from counters.
   Same inputs give byte-identical situations. Known exceptions, none touching situation text:
   `packages/runtime/src/model/engine.ts` (default `now`), `packages/runtime/src/model/host.ts` -> `scheduleIdle`
   (`requestIdleCallback`), `packages/runtime/src/devtools/index.ts` (`rawRaf`, `rawSetTimeout`).
4. **Honest-evaluation separation.** `sim/` and `realapps/` never read or model `demos/`; demos are never tuned and contain
   nothing beyond a normal integration. (`realapps/` does import the sim's cost weights and label rule from `sim/src`.)
5. **Default `observe`; never make a correct app worse.** Since f3636b2 the default mode is `observe` (`runtime.ts` ->
   `o.mode ?? "observe"`, CONTRACT §13): it never takes an action and, since 054da38, never holds or delays a delivery
   (`RuntimeImpl.deliveryHoldable` is false in observe, so `runDelivery` releases at once). `origin/runtime` still
   defaults to `guard`, and the merged install CLI still assumes guard (open defect, §2). `guard` is opt-in (minimal guard-tier actions:
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
9. **Telemetry conditions (owner-agreed, binding).** Default-on telemetry must stay disclosed (console notice,
   `TELEMETRY.md`, READMEs, CHANGELOG), send only redacted data the runtime already has (never raw input values of
   password/payment/secret fields), keep its opt-outs (`telemetry: false`, `?genclass=no-telemetry|off`,
   `localStorage["genclass.telemetry"]="off"`, GPC) and never feed a decision or change model input. The collector
   never stores IP, user agent, cookies or headers. Widening what is sent needs the owner's OK. See
   [docs/agents/telemetry.md](docs/agents/telemetry.md).
10. **REVIEW tests are a contract.** Never edit `packages/runtime/test/review-*.test.ts` to make them pass. Fix `src/`.

## 4. Where to run things

- **Our run policy (lead, 2026-10-08).** Light local checks are fine on this machine (macOS, 16 GB, Node v25.6.0):
  `npm install`/`npm ci`, `tsc`, `tsup`, vitest unit tests (runtime and sim; `test/install/cli.test.ts` is one of them:
  it runs the CLI on fixture projects in temp dirs with `--no-install`, no network).
- **Ask the user first** before: Playwright (`npm run test:browser`, the UI spec), `test/smoke/smoke.sh`, the sim generator
  (`sim/scripts/*`, `gen.js`), training (`training/*.sh`, any Python training or eval), realapps runs (`gen.js`,
  `debug.js`, `realapps/scripts/*`), the install test suite (`packages/runtime/test/install/run-all.sh`, `scaffold.sh`,
  `frameworks.mjs`, `cdn-check.mjs`: real framework scaffolds, package managers, Chromium; written for the VM), the
  demos' eval, model downloads (`genclass-runtime fetch-model`), deploying `telemetry-worker/` or touching the R2
  telemetry data, **anything on
  Azure** (`scripts/*.sh`, `az`, ssh to nodes), **`git push`** and **`npm publish`**.
- `HANDOFF.md` "Rules" ("never run npm, tsc, vitest ... on the Mac"; build and test on the Azure `train` VM via
  `scripts/vm.sh`) describes Mehar's workflow on his 8 GB Mac and his Azure cluster. It is context, not instructions for us.

## 5. Commands (verified 2026-10-08 on `mvp-v2-merge` at f107013, Node v25.6.0, unless noted)

| command | dir | result / notes |
|---|---|---|
| `npm ci --no-audit --no-fund` | repo root | OK from the committed lockfile at b435acb (not rerun after the merge; 10e5c3b synced the lockfile for the new `packages/genclass-runtime` workspace). Add `ONNXRUNTIME_NODE_INSTALL=skip` on Linux, as CI does. EBADENGINE warning from vitest on Node 25 is harmless |
| `npx tsc -p tsconfig.json --noEmit` | `packages/runtime` | clean. Checks `src/` only: test files are never type-checked |
| `npx tsup` | `packages/runtime` | OK. Four configs: the ESM build (10 entries: `index`, `auto`, `auto/{observe,guard,heal}`, 3 adapters, `devtools/index`, `worker`), the script-tag builds `dist/genclass.global.js` and `.global.min.js` (IIFE, the package version baked in as `__GENCLASS_VERSION__`), and the CDN worker `dist/cdn/{worker,ort-webgpu,ort-wasm}.js` |
| `NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts` | `packages/runtime` | Files 44 passed, 1 skipped (45). Tests 375 passed, 14 skipped (389). The 14 skips are model-parity tests needing `GENCLASS_MODEL_DIR`. New since 806a296: `test/install/cli.test.ts` (20), `test/observe-delivery.test.ts` (11), `test/redaction-v2.test.ts` (10), `test/situation-purity.test.ts` (2) |
| `NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts` | `packages/runtime` | 4 passed. Run it alone: in a full parallel run it flaked once (5.5 ms vs a 2 ms bound). CI uses `--retry=2` |
| `npm run build` then `SIM_RUNTIME=real npx vitest run` | root, then `sim/` | 19 passed (5 files) at b435acb; not rerun after the merge. Without `SIM_RUNTIME=real` the sim tests use a fake runtime |

Total: 393 runtime unit tests in 46 files (379 passed, 14 skipped without a model dir). CI (`.github/workflows/ci.yml`,
Node 22) runs `npm ci` -> runtime typecheck -> build -> the two vitest steps above; triggers: push to
`main`/`runtime`/`mvp`/`mvp-v2`, `pull_request`, `workflow_dispatch` (not `mvp-v2-merge`). It has not run on GitHub yet
(nothing pushed). Not run by us: Playwright, `smoke.sh`, the install suite (`test/install/run-all.sh`), realapps,
demos eval, Python tests, training. One test: `npx vitest run test/delivery.test.ts -t "<name>"`.

## 6. Top-level layout

| path | what it is | doc |
|---|---|---|
| `packages/runtime/` | `@genclass/runtime`: `src/` (incl. `auto.ts`, `cdn/`), `test/` (incl. `install/`), `bin/genclass-runtime.mjs` CLI (`init`, `remove`, `fetch-model`, `info`; `init`/`remove` in `bin/lib/`), `STATUS.md` (runtime state, example situations, deviations), `CHANGELOG.md`, `INSTALL-NEEDS.md` (INSTALL's requests), `UI-NEEDS.md` | [runtime/](docs/agents/runtime/public-api-and-lifecycle.md) (8 docs; start with public-api-and-lifecycle and [build-test-release](docs/agents/runtime/build-test-release.md)), [model-io-contract](docs/agents/model-io-contract.md) |
| `packages/genclass-runtime/` | unscoped alias `genclass-runtime` 0.1.0-alpha.1 (unpublished): `cli.mjs` forwards to `@genclass/runtime`'s CLI so `npx genclass-runtime init` could work; a workspace | [repo-map](docs/agents/repo-map.md) |
| `packages/runtime-model/` | only `MODEL_CARD.md` of the model package (published as `@genclass/runtime-model@0.1.0`; files come from the export) | [model-host](docs/agents/runtime/model-host.md) |
| `sim/` | `@genclass/sim`: deterministic training-data simulator (S1/S2 labels, `SEPARABILITY.md`) | [sim.md](docs/agents/sim.md) |
| `realapps/` | 128 app directories with a `manifest.ts` (Mehar's commits say 96 after wave 3; wave-4 apps arrived inside f3a9dd1/eff18cb), incl. 14 open-source Conduit front-ends, in headless Chromium; REAL rows and the never-worse sweep | [realapps.md](docs/agents/realapps.md) |
| `training/` | Python training, curriculum (`curriculum/rt.py`), eval, export, Azure launch scripts; `NEEDS.md`, `LOG.md`, `EVAL.md` | [training.md](docs/agents/training.md) |
| `demos/` | `@genclass/demos`: six Vite demo apps, Service Worker chaos backend, Playwright trials | [demos.md](docs/agents/demos.md) |
| `docs/runtime/` | `CONTRACT.md` (binding; changes appended to §13), `API.md`, `ARCHITECTURE.md`, [RESULTS.md](docs/runtime/RESULTS.md) (model and design comparisons, data volume, training log) | [status-and-known-issues](docs/agents/status-and-known-issues.md) |
| `docs/agents/` | these docs | [README](docs/agents/README.md) |
| `telemetry-worker/` | Cloudflare Worker `genclass-telemetry` (collector for the runtime's default-on telemetry; R2 bucket `genclass-telemetry`), not a workspace; deploy with `npx --yes wrangler@4 deploy` | [telemetry](docs/agents/telemetry.md) |
| `.github/workflows/ci.yml`, `release.yml` | CI; `release.yml` (2026-10-10, not run yet) publishes `@genclass/runtime` from a `v*` tag with npm provenance once the owner configures npm trusted publishing (RELEASE.md) | [build-test-release](docs/agents/runtime/build-test-release.md) |
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
- `NEEDS.md` files live in the requester's directory (`sim/`, `training/`, `demos/`, plus `packages/runtime/UI-NEEDS.md`
  and `packages/runtime/INSTALL-NEEDS.md`, from the INSTALL workstream that owns `src/auto.ts`, `src/cdn/**`, `bin/lib/**`, `test/install/**`);
  only the requester closes an item. `training/NEEDS.md` also holds Azure node claims and data locations.
- `docs/runtime/CONTRACT.md`: approved changes go to §13; an accepted divergence goes into STATUS "Deviations".

## 8. Definition of done

1. If you touched `packages/runtime/src`: `tsc` clean and `tsup` builds (keep tsup entries as literal `"src/...ts"`
   strings and the worker URL / ORT `import()` literals).
2. Runtime unit tests pass in both CI steps (§5: 375 + 14 skipped, then review-perf 4), plus new tests in house style.
   No `review-*.test.ts` edited. For sim, realapps, demos or training changes, name the checks you could not run and why.
3. No model-visible text changed (rule 2) unless the user approved it; if approved, update exact-text tests and STATUS
   example situations, and flag that a new situation tag, `rt.py` mirror, regenerated data and retraining are needed.
4. Update the affected `docs/agents/` doc(s) and set the header's "Verified against" line to the commit you re-checked.
   A public-surface change also updates `docs/runtime/API.md` and the JSDoc in `packages/runtime/src/types.ts`.
5. If behaviour changed: update `packages/runtime/STATUS.md`, `OPEN_TASKS.md`, `HANDOFF.md` if its state table changes,
   `docs/runtime/RESULTS.md` for new numbers, and the relevant `NEEDS.md` item.
6. A dependency change commits the updated root `package-lock.json` in the same commit.
7. Commit locally with the attribution the session gives you; **do not push or publish without the user** (publish steps: [RELEASE.md](RELEASE.md)).
