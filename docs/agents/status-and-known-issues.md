# Project status, ground rules, open work, known issues and doc drift

> **Scope:** `OPEN_TASKS.md`, `packages/runtime/STATUS.md`, `demos/NEEDS.md`, `sim/NEEDS.md`, `training/NEEDS.md`,
> `packages/runtime/UI-NEEDS.md`, `docs/runtime/{CONTRACT,API,ARCHITECTURE}.md`, `README.md`,
> `packages/runtime/README.md`, git history and tags, code TODO markers. Cross-checked against
> `packages/runtime/src/**`, `packages/runtime/bin/genclass-runtime.mjs`, `packages/runtime/package.json`,
> `training/{LOG,EVAL}.md`, `sim/README.md`, `sim/samples/stats-final-a.json`, `demos/results.md`.
> **Read this when:** you land in the repo cold and need to know what is shipped, what is in flight and who owns it;
> before any change that could break a binding rule (situation text, determinism, dependencies, where to run builds);
> before trusting `docs/runtime/*.md` or a README over the code; when you finish work and must update STATUS/NEEDS/OPEN_TASKS.
> **Source of truth:** the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

## TL;DR

Path convention in this doc: `src/…`, `test/…` and `bin/…` are relative to `packages/runtime/`; bare runtime module
paths (`runtime.ts`, `types.ts`, `util.ts`, `index.ts`, `state/hub.ts`, `situation/build.ts`, `decide/policy.ts`,
`model/host.ts`, …) are relative to `packages/runtime/src/`. Every other path is from the repo root.

- **Shipped:** `@genclass/runtime@0.1.0-alpha.0` on npm (per `OPEN_TASKS.md`; registry not re-checked). Runtime core,
  model host, devtools and adapters are built and tested (STATUS: 37 files, 300 tests passing on the VM). Re-run
  on 2026-10-07 without a model directory: typecheck clean, `tsup` build OK, 286 tests passed and the 14
  model-file tests skipped (see [Gotchas](#gotchas)).
- **Not shipped:** the trained runtime model. `DEFAULT_MODEL_BASE_URL` (`src/model/host.ts`) points at
  `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/`, a package that does not exist yet
  (`packages/runtime-model/` holds only `MODEL_CARD.md`). A default `GenClass.init()` therefore ends with model status
  `error`, prints `[GenClass] Model unavailable (...); observing only.`, and from then on never consults the model or
  takes an action (only while the status is still `off`, before the idle preload starts, are salient situations built,
  and those fail open). It still traces, learns baselines/invariants/profiles and answers `rt.situation()`. No runtime
  test covers this default path.
- **Frozen:** the situation format is frozen at tag `situation-v1` (commit 1a77558). `git diff situation-v1 HEAD --
  packages/runtime/src` is empty at 654d822. The final training data (SIM phase A, 600k rows) was generated from it.
  Any change to text the model reads breaks parity with that data. Only the runtime source is frozen: sim, training
  and demos changed after the tag (59c213f, 654d822).
- **In flight at 654d822:** SIM phase B data (1.4M rows), TRAIN final round 1 (R17 and R32 on phase A), DEMOS screenshot
  tour. **Next:** choose R17 and/or R32, publish `@genclass/runtime-model@0.1.0` and a GitHub release, then
  `@genclass/runtime@0.1.0`, add CI, then re-run the demos with the trained model.
- **Binding rules** (CONTRACT §0, §0.5): no hardcoded bug rules (facts and triage only; the model decides), one
  situation implementation shared with the sim, determinism via the injected `Clock`, sim and demos never read each
  other, builds/tests/models run only on the `train` VM (the 2026-10-07 run policy in AGENTS.md relaxes this for
  light checks on other machines; see [ground rule 5](#ground-rules-binding-contract-0-and-05-restated) (Mac safety,
  CONTRACT §0 rule 5; current policy in [../../AGENTS.md](../../AGENTS.md) §4)), no new runtime dependency besides
  `onnxruntime-web`, precision first.
- **Workstreams:** lead, CORE, MODEL, UI, SIM, DEMOS, TRAIN, REVIEW. They talk through `STATUS.md` (CORE's state) and
  per-workstream `NEEDS.md` files (requests with OPEN / ASK / DONE status; sim/NEEDS and training/NEEDS say they are
  "relayed by the lead").
- **Biggest open product risks:** holding writes can reorder them behind a newer user write (board demo: +56% visible
  jump-backs with zero actions, `demos/NEEDS.md` §1); holds add latency to typeahead-like apps (§2); `retry` is offered
  for non-idempotent POSTs (§5). All three are open in code.
- **Docs drift a lot.** CONTRACT.md was last edited in a53dd38, before batch 3 landed (it already specifies the
  summed-mass §8 gate and `transient`, but none of STATUS's deviations); READMEs, STATUS, UI-NEEDS and sim/NEEDS each
  have stale items. The full list with evidence is in [Drift and open issues](#drift-and-open-issues). There are
  **no** TODO/FIXME/XXX/HACK comments in code.

## Files

| path | role | key content |
|---|---|---|
| `OPEN_TASKS.md` | Project-level status (owner inferred: lead) | Done / In progress (1–2) / Next (3–8) / Needs the user / Known risks |
| `packages/runtime/STATUS.md` | CORE's status, read by SIM, DEMOS, UI, MODEL | test state, batch 3 changes, headless recipe, trigger table, example situations, **Deviations from the contract**, **Open issues** |
| `docs/runtime/CONTRACT.md` | Binding build contract (lead) | §0 ground rules, §0.5 product principles, §1 layout and owners, §2–§12 spec, §13 approved additions |
| `docs/runtime/API.md` | Public API reference | options, state, ops, ask, events, triggers/actions, policy, reports, plugins, headless, types |
| `docs/runtime/ARCHITECTURE.md` | Design overview | principles, data flow, training and evaluation summary |
| `packages/runtime/UI-NEEDS.md` | UI → CORE requests | Open (1–2), Nice to have (3), Done |
| `sim/NEEDS.md` | SIM → CORE requests and observations | Requests 1–5 (DONE), observations a–f (marked ASK), SIM notes |
| `training/NEEDS.md` | TRAIN's needs from SIM, CORE, MODEL; MODEL → TRAIN notes | items 1–10, 6a; TRAIN status for frozen data |
| `demos/NEEDS.md` | DEMOS → CORE/MODEL/UI/lead | §1–§8 evidence-backed product issues from traced Playwright runs |
| `README.md` | Repo landing page | install, status banner, repo map, how it works |
| `packages/runtime/README.md` | npm package README | status banner, modes, adapters, privacy, limits |
| `packages/runtime-model/MODEL_CARD.md` | Model card for the unpublished `@genclass/runtime-model` (lead) | R17/R32 sizes, stage-1c accuracy, limits |
| `training/LOG.md`, `training/EVAL.md` | TRAIN's dated log and results | stage 1c, stage-2 pilot, final round 1 launch (EVAL final section "(in progress)") |
| `demos/results.md`, `demos/results.json`, `demos/results-summary.json` | Demo trial results with the **v0.1** model (generated 2026-10-07T19:30Z) | bug rate, false interventions, latency per demo and mode |
| `training/README.md`, `sim/README.md`, `demos/README.md`, `src/model/README.md` | Per-workstream READMEs | owner lines ("Owner: TRAIN", "Owner: MODEL"), sim "Known limitations" 1–8, demos "Honesty rules", MODEL measurements |
| `sim/samples/stats-final-a.json` | Stats of SIM final phase A | rows per split/trigger, diagnosis counts, passive-best fractions |
| `scripts/vm.sh` | The team's way to build/test per CONTRACT §0 rule 5 (`sync`, `run`, `exec`, `get` per SLOT); light checks may run locally under the run policy in AGENTS.md ([ground rule 5 (Mac safety)](#ground-rules-binding-contract-0-and-05-restated)) | needs `~/.jev-local/azure_hosts` and `~/.ssh/jev_azure` (not in repo) |
| `packages/runtime/test/review-*.test.ts` | REVIEW's regression tests (10 files) | must pass unchanged |
| `packages/runtime/test/smoke/smoke.sh` | npm tarball smoke test (Vite app, headless Chromium) | runs with `model: false` |
| `docs/CONTRACT.md`, `docs/CONTRACT-v2.md`, `docs/SPEC.md`, … | **Legacy jev-local docs**, not the runtime contract | CONTRACT §1: "stays as is. Do not edit it." |

## Concepts and data structures

### Workstreams and ownership

| workstream | owns (edit rights) | writes | reads / serves |
|---|---|---|---|
| **lead** (also "LEAD", "coordinator") | `docs/runtime/CONTRACT.md`, `packages/runtime-model/`; `training/` per CONTRACT §1; `OPEN_TASKS.md` (inferred: the file has no owner line) | contract changes (§13 "Additions (approved …)"), approvals of deviations and dependencies, merges, publishing | relays sim/NEEDS and training/NEEDS (titles say "relayed by the lead"); reads demos/NEEDS ("Read by CORE, MODEL, UI and the lead"); answers UI-NEEDS 2 |
| **CORE** | `packages/runtime/**` except `src/model/**`, `src/devtools/**`, `src/adapters/**`; owns `src/situation/*` wording and `src/types.ts` | `packages/runtime/STATUS.md`, `docs/runtime/API.md` (inferred: CONTRACT §1 names no owner for API.md; it was last changed in CORE's batch 3) | sim/NEEDS, UI-NEEDS, demos/NEEDS, training/NEEDS (CORE → TRAIN) |
| **MODEL** | `packages/runtime/src/model/**`, `bin/genclass-runtime.mjs`; co-owns the "model seam" section at the top of `src/types.ts` | `src/model/README.md`; MODEL → TRAIN entries in training/NEEDS | training/NEEDS (MODEL items) |
| **UI** | `src/devtools/**`, `src/adapters/**` (CONTRACT §13; §1's table still says CORE) | `packages/runtime/UI-NEEDS.md` | STATUS "For UI" |
| **SIM** | `sim/` | `sim/NEEDS.md`, `sim/README.md`, data under `sim/out/` (gitignored) | STATUS, training/NEEDS (SIM → TRAIN) |
| **DEMOS** | `demos/` | `demos/NEEDS.md`, `demos/README.md`, `demos/results*.{md,json}` | STATUS |
| **TRAIN** | `training/` (`training/README.md`: "Owner: TRAIN") | `training/NEEDS.md`, `LOG.md`, `EVAL.md` | sim output, MODEL card format |
| **REVIEW** | `packages/runtime/test/review-*.test.ts` | 34 findings (all fixed in batch 3) | runtime code |

Separation rule (CONTRACT §0 rule 4): SIM and DEMOS are built by different people who do not read each other's code.

### Communication file conventions

- **`STATUS.md` (CORE).** Header `Updated: <date> (<batch>). Owner: CORE. SIM, DEMOS, UI and MODEL read this file.`
  Sections: State (VM test command and counts), the latest batch's changes grouped by origin (REVIEW findings, SIM
  requests, contract changes), "How to drive it headless", per-consumer notes ("For UI"), trigger/triage table,
  example situations copied from tests, **Deviations from the contract (and why)**, **Open issues**.
- **`NEEDS.md` files.** Live in the *requester's* directory (exception: `UI-NEEDS.md` lives in `packages/runtime/`;
  training/NEEDS also carries MODEL's answers and notes to TRAIN, "MODEL → TRAIN (from MODEL)").
  Title states direction ("SIM → CORE requests", "What the demos need from @genclass/runtime", "TRAIN needs"). Status
  legend (sim, training): **OPEN** (needed), **ASK** (would help), **DONE** (landed; verified by the requester), plus
  **INFO** in training/NEEDS. UI-NEEDS uses sections Open / Nice to have / Done. demos/NEEDS uses numbered sections with
  the addressee in parentheses ("(CORE, product risk)") and evidence (traces, seeds, tables).
- **Contract changes.** A workstream that needs the contract changed tells the lead ("do not silently diverge"). Approved
  additions are appended to CONTRACT §13; accepted divergences are listed in STATUS "Deviations". §13 ("Additions
  (approved 2026-10-07)") holds seven items: `EvaluateRequest.subject` (exposed as `Decision.subjectRef`),
  `createRuntime({ hooks })`, `policy.requireDiagnosis`, `vocabulary`, side-effect-free `situation(trigger)` (since
  softened by a STATUS deviation), the pruned 16,364-token vocabulary with marker ids read from files, and UI ownership
  of `src/devtools/**` and `src/adapters/**`.
- **Batches.** CORE ships in numbered batches: batch 1 (SIM requests 1–5), batch 2 ("model integration, latency, UI
  requests" per the a53dd38 STATUS: `situation: { budget }`, `sectionLimits`, auto hold budget, late revert, provider
  errors fail open; 239 tests), batch 3 (REVIEW's 34 findings, SIM a–f, summed-mass §8 gate, `transient`, compact
  questions) = commit 1a77558.
- **VM slots.** Each workstream builds in its own directory on the `train` VM: `scripts/vm.sh run <SLOT> '<cmd>'` with
  SLOT such as `core`, `model`, `sim`, `demos` (`~/gcl/<SLOT>`; slot names `[a-zA-Z0-9_-]` only). `run`/`exec`
  commands are wrapped in `timeout $TIMEOUT` (default 1800 s); the sync and `get` steps use fixed 300/600 s timeouts.
  `sync`/`run` use `rsync -az --delete` (excluding `node_modules`, `.git`, `dist/`, `.vite`, `/data/`, `test-results/`,
  `playwright-report/`, `__pycache__`, `.DS_Store`, `/models/`, `/runs/`, `/extension/`, `/sim/out/`, `.cache-model/`),
  so files created in a slot outside those paths are deleted by the next sync. Use
  `scripts/vm.sh get <SLOT> <remote> <local>` to bring results back.

### Git history (all 13 commits; author Mehar Khanna, every message prefixed "Mehar commit: …")

| commit | date (−04:00) | what | relevance now |
|---|---|---|---|
| 7a7ff6d, 72ec517 | 2026-10-04 01:58–02:00 | README, Apache-2.0 licence, GenClass vs Jev benchmarks | legacy |
| 3b2121f | 2026-10-04 02:07 | Open-source GenClass: `jev_local/`, server, voice harness, training, benchmarks, `docs/*.md` | legacy content; CONTRACT §1 says do not edit |
| c2ddfa5, 666080e, 58d0f66 | 2026-10-04 09:44–10:59 | Chrome extension v0.1.0 and two store-listing fixes | legacy; holds the v0.1 model card (`extension/src/model/model.json`) |
| 353b0a4 | 2026-10-07 14:18 | WIP runtime core, model host, sim, demos, training scaffolding | first runtime commit; CONTRACT.md created |
| a53dd38 | 2026-10-07 19:02 | Runtime core, model host, devtools, adapters, sim, training, demos (WIP) + `OPEN_TASKS.md` | **last change to CONTRACT.md, UI-NEEDS.md, sim/NEEDS.md** |
| c14151c | 2026-10-07 19:05 | Runtime-first README, package README, ARCHITECTURE.md | only commit touching ARCHITECTURE.md; message understates scope: also changes `packages/runtime/src` (`decide/policy.ts`, `decide/decider.ts`, `situation/{facts,build,questions,env}.ts`, …) and adds `docs/GENCLASS.md` |
| 1a77558 | 2026-10-07 19:19 | Runtime fix batch 3 (34 REVIEW findings, summed-mass gate, `transient`, compact questions) | tag `situation-v1`; last change to STATUS.md, API.md, training/NEEDS.md, `packages/runtime-model/MODEL_CARD.md` and to `packages/runtime/src` |
| 501cec7 | 2026-10-07 19:20 | OPEN_TASKS: runtime frozen, final data and training plan | |
| 59c213f | 2026-10-07 20:09 | Runtime LICENSE, tarball smoke test; also sim (gate thresholds 0.5, 1,000-char WASM budget, op header `x-request-id`, resumable parts, `stats-final-a.json`), training final-round scripts, demos tracing (`demos/e2e/trace-report.ts`, common random numbers) | message understates scope: 59 files |
| 654d822 | 2026-10-07 20:15 | Publish `0.1.0-alpha.0`; READMEs, OPEN_TASKS, demos/NEEDS rewritten (also `training/LOG.md`, two demos files) | HEAD; tag `v0.1.0-alpha.0` |

The freeze covers `packages/runtime/src` only: `git diff --stat situation-v1 HEAD` lists 65 changed files (demos 27,
training 16, sim 15, `packages/runtime/{LICENSE,README.md,package.json,test/smoke/smoke.sh}`, root `README.md`,
`OPEN_TASKS.md`, `.gitignore`; nothing under `docs/`). The sim changes in 59c213f are, by inference, the code that
produced phase A (`stats-final-a.json` lands in the same commit and its `by_budget` has 1000-char rows).

### Version markers

| marker | value at 654d822 | meaning |
|---|---|---|
| `main`, `origin/main`, `origin/runtime` | all 654d822 | OPEN_TASKS still calls the branch `runtime` and asks to merge it into `main` |
| tag `situation-v1` | → 1a77558, message "Frozen runtime situation format for model training" | freeze point for situation text; SIM final data and TRAIN final rounds use it |
| tag `v0.1.0-alpha.0` | → 654d822, message "@genclass/runtime 0.1.0-alpha.0 (npm)" | the published alpha |
| `packages/runtime/package.json` `version` | `0.1.0-alpha.0` | |
| `@genclass/runtime-model@0.1.0` | not created (no `package.json`, `files/` gitignored) | default model location |
| GitHub release `runtime-model-v0.1.0` | no such tag in the repo | the CLI's default `--from` |
| v0.1 GenClass model | `https://github.com/MeharPro/GenClass/releases/download/v0.1.0/` | general classifier, **not** trained for runtime decisions; used by demos and model tests |
| R17 / R32 | 17M / 32M runtime candidates, pruned 16,364-token vocab, int8 (q8) exports 9.58 / 22.47 MB | `training/EVAL.md` |

### Status at 654d822

| item | state | owner | evidence |
|---|---|---|---|
| Runtime core, model host, devtools, adapters | done, frozen | CORE, MODEL, UI | `OPEN_TASKS.md` Done; `git diff situation-v1 HEAD -- packages/runtime/src` empty |
| Runtime fix batch 3 (34 REVIEW findings, summed gate, `transient`, compact questions, word-level redaction) | done | CORE | commit 1a77558; `test/review-*.test.ts`, `test/batch3.test.ts` |
| npm alpha `0.1.0-alpha.0` | published 2026-10-08 (npm org `genclass`, owner meharpro) | lead | OPEN_TASKS Done; tag `v0.1.0-alpha.0` |
| Tarball smoke test | done | lead | `test/smoke/smoke.sh` (commit 59c213f) |
| SIM final phase A | done: train 448,420 / dev 14,613 / test 137,643 rows | SIM | `sim/samples/stats-final-a.json`, `training/LOG.md` |
| SIM final phase B (1.4M rows, seeds from 50,000,000, resumable parts) | in progress | SIM | OPEN_TASKS item 1; `sim/README.md` |
| Stage 1c (curriculum) R17/R32 | done: held-out `rt1` action 98.0 / 98.2%, diagnosis 98.3 / 98.4%, 0 false interventions | TRAIN | `training/EVAL.md`, `MODEL_CARD.md` |
| Stage-2 pilot (pre-freeze SIM r300k) | done: action 77.5 / 78.3% (R32 / R17), diagnosis 90.8 / 91.1%, heal FIR 0.06 / 0.08% but heal recall 1.3 / 1.4% | TRAIN | `training/EVAL.md` "Stage 2 pilot" |
| Final round 1 (phase A) | launched 2026-10-08 00:06–00:12 UTC, training ETA ≈ 01:28–01:30 UTC; eval, calibration and export "by about 02:40 UTC" (OPEN_TASKS 3) by an autonomous tail (`training/final_post.sh` on c02/c09, `training/pull_on_train.sh` on the VM) | TRAIN | `training/LOG.md`; EVAL final section "(in progress)" |
| Final round 2 (phase A + B, longer) | next, after the 03:00 UTC VM shutdown | TRAIN | OPEN_TASKS item 3 |
| Demos (6), Service Worker backend, Playwright harness | built; numbers only with v0.1; `demos/src/server/data/cities.ts` missing (see [demos.md](demos.md#drift-and-open-issues)) | DEMOS | `demos/results.md` (2026-10-07) |
| Choose shipping model(s), device-based selection | next | lead, MODEL | OPEN_TASKS item 5 |
| Publish runtime model + release, then `@genclass/runtime@0.1.0`; CI | next | lead | OPEN_TASKS item 8; no `.github/` directory exists |
| Honest-results docs, model card numbers, dev-only lazy import of the devtools (52 KB min / 17 KB gz) | next | lead | OPEN_TASKS item 7 (the package README already shows the `import.meta.env.DEV` dynamic-import pattern) |
| Public demo hosting (GitHub Pages) | waiting on the user | lead | OPEN_TASKS "Needs the user" |

## How it works

### 1. What a default install does today (model unpublished)

1. App calls `GenClass.init()` in a browser. `src/index.ts` -> `initUnsafe` reads the kill switch (URL `?genclass=`, else
   `localStorage.genclass`; `off` installs nothing). Otherwise it sets `model: {}` and calls `createRuntime`.
2. `createRuntime` -> `makeHost` -> `createModelHost` with `baseUrl = DEFAULT_MODEL_BASE_URL`, `preload: "idle"`
   (`src/model/host.ts`). Status starts as `{ state: "off" }`.
3. Observers install (`RuntimeImpl.installObservers`). Tracing, field versions, baselines, invariant mining and
   transition profiles run from now on, whatever the model state (`RuntimeImpl.settled` has no model check).
4. After `load` + idle (≤ 2 s idle timeout, ≤ 5 s load wait), the host fetches `<baseUrl>model.json`
   (`src/model/loader.ts` -> `fetchCard`). The package does not exist, so the fetch fails (expected HTTP 404; not checked
   against the live CDN) and no cached card exists: `ModelLoadError("model card download failed: …")`; status becomes `error`.
5. `RuntimeImpl` constructor's `onStatus` listener emits a status report: `[GenClass] Model unavailable (<error>);
   observing only.` (`console.info` with `report: "console"`; always delivered to `on("report")`).
6. From now on `RuntimeImpl.consultable()` is false (it is true only for `ready` or `off`): `trigger()` runs the passive
   action without building a situation, `gateMutation` never holds. No `Decision`, `Detection` or `ActionRecord` is ever recorded.
7. `rt.ready` rejects with the load error (memoised); `rt.ask()`/`decide()` reject with
   `GenClassUnavailableError` (`reason: "error"`), or with the raw provider error when `timeoutMs` is set.
8. There is no automatic retry: the runtime memoises `ready`; `ModelHost.load()` would retry but nothing calls it.

Before step 4: while status is `off` (idle preload not started), a salient trigger is built, fails open at once
(`trigger()` -> `provider.status.state !== "ready"`) and starts the load (`void this.ready`); while `loading`,
`consultable()` is false and triggers are skipped. To see decisions today, self-host the **v0.1** model with
`npx genclass-runtime fetch-model <dir> --from https://github.com/MeharPro/GenClass/releases/download/v0.1.0/` and pass
`model: { baseUrl }`. Without `--from` the CLI uses `DEFAULT_FROM` (the unpublished release), which is expected to
fail (not checked against GitHub). v0.1 answers
`unusual` almost always (`demos/NEEDS.md` §8), so its decisions only exercise the pipeline.

### 2. How a request moves between workstreams

1. The requester writes an item in its NEEDS file with evidence and a status (OPEN or ASK), addressed to an owner.
2. The lead relays it (and, for a contract change, approves it into CONTRACT §13 or rejects it).
3. The owner lands it in a batch and records it in its status file (CORE: STATUS.md batch section; deviations under
   "Deviations from the contract (and why)").
4. The requester verifies it on the VM and flips the item to DONE with a verification note (example: sim/NEEDS 1–5
   "Verified: 100% of decisions in a 20k-row run correlate…").
5. If the change alters situation text, SIM and TRAIN regenerate data (STATUS: "Fact and question wording changed again
   in batch 3 … regenerate rows").

Step 4 is often skipped: several items are implemented but still marked OPEN/ASK (see Drift).

### 3. How a runtime change reaches the shipped model

1. CORE changes `packages/runtime/src/situation/*` (or anything that changes the text: `util.ts` formatting, vocab,
   op/event names).
2. The lead freezes it with a tag (`situation-v1`).
3. SIM generates rows by driving that exact runtime (`sim/src/run/rt.ts`, `npm run build:runtime-core`).
4. TRAIN mirrors the wording in the curriculum (`training/curriculum/rt.py`), imports SIM rows, trains, calibrates on
   dev, evaluates on held-out test, exports q8/fp16 (`training/export_runtime.py`, `training/ortweb/validate.mjs`).
5. MODEL checks parity of the TS packer/engine against the export's `parity.json` (an export artefact, not in the
   repo; training/NEEDS, MODEL → TRAIN 7).
6. The lead publishes the model directory as `@genclass/runtime-model@0.1.0` (jsDelivr serves `files/`) plus GitHub
   release `runtime-model-v0.1.0`, then publishes `@genclass/runtime@0.1.0`.

## Configuration and constants

Status-relevant values only; the subsystem docs list the rest.

| name | type | value | defined in | effect |
|---|---|---|---|---|
| `DEFAULT_MODEL_BASE_URL` | string | `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/` | `src/model/host.ts` | default `model.baseUrl`; unpublished → status `error`, observe only |
| `DEFAULT_FROM` | string | `https://github.com/daybot-solutions-inc/GenClass-lib/releases/download/runtime-model-v0.1.0/` | `bin/genclass-runtime.mjs` | `fetch-model` default source; no `runtime-model-v0.1.0` tag in the repo (GitHub releases not checked) |
| v0.1 model URL | string | `https://github.com/MeharPro/GenClass/releases/download/v0.1.0/` | `demos/scripts/fetch-model.sh`, CONTRACT §10 | the only model that exists publicly |
| runtime `dependencies` | — | `onnxruntime-web ^1.30.0` only; optional peers `react >=18`, `redux >=4`, `zustand >=4` | `packages/runtime/package.json` | dependency policy (CONTRACT §0 rule 6) |
| `engines.node` | — | `>=20` (VM runs Node 22) | `packages/runtime/package.json`, root `package.json` | |
| `policy.thresholds` | numbers | report 0.6, guard 0.9, heal 0.8 | `src/decide/policy.ts` -> `policyConfig` | precision-first gate |
| `policy.requireDiagnosis` | boolean | `true` | `policyConfig` | non-passive needs top diagnosis ≠ `expected` |
| `policy.holdBudgetMs` | number \| "auto" | "auto" = clamp(1.5 × median of last 20 latencies (else warm-up), 150, 800); 300 if nothing known | `decide/policy.ts` -> `holdBudget`, `HOLD_MIN_MS`/`HOLD_MAX_MS`/`HOLD_FALLBACK_MS` | how long holds last |
| `policy.maxActionsPerMinute` | number | 60 | `policyConfig` | rate limit |
| `LATE_REVERT_MS` | ms | 2000 | `src/runtime.ts` | late `discard` window |
| `PROVIDER_TIMEOUT_MS` | ms | 10,000 | `src/decide/decider.ts` | runtime-side provider abandonment |
| `STATE_CHAR_BUDGET` | chars | 3200 (comment: "≈ 3.2 chars per token") | `src/situation/serialize.ts` | full situation budget; TRAIN measured 2.4 chars/token (training/NEEDS 6a) |
| `COMPACT_BUDGET` | chars | 1100 | `situation/serialize.ts` | floor of `sectionLimits` interpolation (not the compact-questions switch) |
| `COMPACT_QUESTIONS_BUDGET` | chars | 1400 | `src/situation/questions.ts` | at or below: bare labels/names in questions |
| auto situation budget | chars | webgpu 3200; wasm `1000 + round((threads − 1) × 1000 / 3)` with threads clamped to 1–4 (1000/1333/1667/2000); unknown device 3200; all × `budgetScale` (1, × 0.8 per `max_tokens_exceeded`, floor 0.5) | `RuntimeImpl.situationBudget` | device sizing; a numeric `situation.budget` wins |
| `DEFAULT_DIAGNOSES` | labels | expected, stale, conflict, duplicate, inconsistent, failing, slow, overload, unusual, transient | `situation/questions.ts` | frozen vocabulary order |
| kill switch | URL / localStorage | `genclass=off\|observe\|guard\|heal` (URL wins) | `src/index.ts` -> `killSwitch` | rule GenClass out while debugging |

## Invariants and gotchas

### Ground rules (binding; CONTRACT §0 and §0.5, restated)

CONTRACT: "This file binds every workstream. If something here is wrong, tell the lead; do not silently diverge."

1. **No hardcoded bugs, patterns, recoveries or demo rules in the runtime (§0 rule 1).** The runtime may compute generic,
   uniform facts (happens-before order, versions, repetition counts, failure streaks, latency vs learned baselines,
   learned invariants, value deltas) and may decide whether a situation is worth asking the model about (triage). It
   must never map a fact pattern to a diagnosis or an action with an if/then. Diagnoses and actions come from the model.
   If the model is unavailable, the runtime observes only and always takes the passive action.
   *In code:* triage is `facts.every((f) => f.neutral)` in `RuntimeImpl.trigger`; actions are chosen only by
   `decide/policy.ts` -> `gate` from model probabilities; report templates (`decide/report.ts`) are reporting only.
   Applicability checks (`situation/build.ts` -> `builtinApplicable`) only say whether an action *can* run.
2. **Train/runtime parity (§0 rule 2).** The sim drives the real runtime code (same trace, facts, serializer, questions) in a
   deterministic virtual world. There is exactly one implementation of situation building and serialization:
   `packages/runtime/src/situation/*`. *In code:* `sim/package.json` depends on `@genclass/runtime` and builds it with
   `build:runtime-core`. Wording changes after `situation-v1` invalidate the final data.
3. **Determinism (§0 rule 3).** Runtime code never calls `Math.random`, `Date.now` or `performance.now` directly, and never
   schedules with the global `setTimeout`; it uses the injected `Clock` (`src/clock.ts` -> `browserClock` captures
   real timers at module load). IDs come from counters. Same inputs give byte-identical situations
   (`test/budget.test.ts`, `test/situation.test.ts`). *Exceptions found:* `src/model/engine.ts` defaults `now` to
   `performance.now()` (timing only), `src/model/host.ts` -> `scheduleIdle` calls `requestIdleCallback` for preload, and
   the devtools render with a `requestAnimationFrame` captured at module load (`src/devtools/index.ts`; UI only, never
   situation text). No `Math.random` or `Date.now` anywhere in `packages/runtime/src`.
4. **Honest evaluation (§0 rule 4).** `demos/` and `sim/` are built by different people who do not read each other's code.
   The sim never models a demo. Demos contain no hints beyond a normal integration (stores, optional `resync`
   handlers, custom actions/questions only in the extensibility demo). `demos/README.md` "Honesty rules" restates this.
5. **Mac safety (§0 rule 5).** The Mac only edits files. Every build, test, browser and model run happens on the `train` VM
   via `scripts/vm.sh` in your own slot. Never run `npm install`, `tsc`, `vitest`, Playwright or a model locally.
   *Lead policy for agents (2026-10-07):* the rule exists because the original author's Mac has 8 GB RAM. On other
   machines `npm install`, typecheck, build and the runtime unit tests are light and verified to work locally. Ask
   the user before running the sim, training, Playwright (including `test/smoke/smoke.sh`), model downloads, the demos'
   eval, or any script that touches Azure (`scripts/*.sh`, `training/*.sh`, `sim/scripts/*`). Details and the verified
   commands: [runtime/build-test-release.md](runtime/build-test-release.md#where-to-run-things).
6. **Language and dependencies (§0 rule 6).** TypeScript, strict mode (`tsconfig.base.json` `"strict": true`), ESM only,
   Node 22 on the VM. No new runtime dependency besides `onnxruntime-web` without asking the lead.
7. **Do not edit legacy content (§1).** "Existing GenClass content (jev_local/, extension/, docs/, etc.) stays as is."
   This covers the pre-runtime GenClass content: `jev_local/`, `extension/`, `bench/`, `results/`, `tests/`, the legacy
   `docs/*.md` (jev-local contracts and specs), `docs/benchmax-research/` and the legacy scripts in `scripts/`. It does
   not cover `docs/runtime/`, `docs/agents/` or `scripts/vm.sh` (added by the runtime team in 353b0a4).

**Product principles (§0.5, "from the user, 2026-10-07; binding").** Claim: *install one library; find and prevent
runtime failures automatically, with low false positives.*

1. **False positives.** Default mode takes only minimal, reversible guard actions at very high calibrated confidence; a
   non-passive action also requires the model's diagnosis to say something is wrong; the false-intervention rate on
   clean runs is a first-class metric in the sim test split and in every demo.
2. **Performance.** Tiered detection: facts and baselines always on and nearly free; the model only for salient
   situations, in a worker, loaded at idle or lazily, cached. Target model: pruned vocabulary + int8 embeddings, ≤ 25 MB q8.
3. **Observability.** One plain-English console line per detection/intervention with collapsible evidence, `explain(id)`,
   undo for reversible actions, `x-genclass` response marks, kill switch `?genclass=off`.

Adoption path: `observe` → `guard` (default) → `heal`. CONTRACT §11 adds **precision first** for training data: benign
but salient-looking situations must be well represented, and the sim reports per trigger the passive-best fraction and
the harm of each non-passive action on passive-best rows.

### Gotchas

- **Code wins over every doc here.** CONTRACT.md was last changed in a53dd38, before batch 3. STATUS.md was last
  changed in 1a77558, UI-NEEDS and sim/NEEDS in a53dd38. Check the Drift tables before relying on them.
- **The runtime is frozen.** Do not change situation text, fact wording, action/diagnosis descriptions, `util.ts`
  formatting (`secs`, `rel`, `describe`, `normalizePath`, `isSensitiveName`, …) or op/event names without the lead,
  SIM and TRAIN. Pipeline-only fixes (e.g. demos §1 ordering) do not change text but still change sim dynamics.
- **REVIEW tests are a contract.** STATUS: "including every `test/review-*.test.ts` (no review test was modified)". Fix
  code, not these tests.
- **No CI and no type-checking of tests.** There is no `.github/` directory. `packages/runtime/tsconfig.json` includes
  only `src`, so test files (and `test/browser/ui/mock-runtime.ts`) are not type-checked.
- **No VM access by default.** `scripts/vm.sh` needs `~/.jev-local/azure_hosts` (a `train` line) and `~/.ssh/jev_azure`,
  neither in the repo, plus GNU `timeout` on the local `PATH`. Without them the VM is unreachable. Run the light checks
  locally (lead policy, [ground rule 5 (Mac safety)](#ground-rules-binding-contract-0-and-05-restated)) and ask the
  user before anything heavier. Gitignored `node_modules/` and
  `packages/runtime/dist/` in a working copy may be stale; rebuild before trusting them.
- **Test counts.** STATUS reports 37 files / 300 tests passing on the VM with a model directory. The lead re-ran the
  unit tests on 2026-10-07 at 654d822: macOS, Node v25.6.0, no model directory, `packages/runtime`,
  `NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**"`. Result: Test Files 36 passed | 1 skipped (37),
  Tests 286 passed | 14 skipped (300), about 2.4 s. That confirms STATUS's file and test totals and the 286 tests that
  need no model. The 14 skips are model-parity tests that need model files in `GENCLASS_MODEL_DIR` (default
  `<repo>/.cache-model`): `test/model/packer.test.ts` all 10, `engine.test.ts` 3 of 4, `calibrate.test.ts` 1 of 8.
  That those 14 pass comes from STATUS's VM run. The same pass confirmed STATUS's "`tsc --noEmit` clean" and "`tsup`
  build OK". It did not run the Playwright specs or `test/smoke/smoke.sh`. A static count of `it(`/`test(` call sites
  is lower than 300 because some tests are generated in loops.
- **The shipped default path is untested.** No file under `packages/runtime/test/` references `DEFAULT_MODEL_BASE_URL`
  or the "Model unavailable … observing only." line, and no `RuntimeImpl` test drives a provider whose status is
  `error` (`test/model/host.test.ts` and `test/model/loader.test.ts` cover the host's own `error` status only); the
  tarball smoke test uses `model: false`. What a default `init()` does today (How it works §1) is verified by code
  reading only.
- **No committed lockfile at the root.** Only `extension/package-lock.json` is tracked; root `npm install` resolves
  caret ranges (`onnxruntime-web ^1.30.0`, `vitest ^5.0.3`, …) fresh each time. A root `npm install` also leaves two
  changes git sees: an untracked root `package-lock.json` (do not commit it unless the lead decides to), and
  `bin/genclass-runtime.mjs` chmodded from the committed 100644 to 755, a mode change. Revert the mode with
  `git checkout -- packages/runtime/bin/genclass-runtime.mjs`.
- **Two "compact" constants.** `COMPACT_BUDGET` = 1100 shapes section sizes; `COMPACT_QUESTIONS_BUDGET` = 1400
  switches to bare labels. Do not merge them; both are frozen.
- **`docs/CONTRACT.md` is not the runtime contract.** The runtime contract is `docs/runtime/CONTRACT.md`.
- **Demo numbers measure the harness, not the product.** `demos/results.md` used the v0.1 model.
- **`OPEN_TASKS.md` mixes time zones and dates.** The header says "as of 2026-10-07 23:30 UTC" while its Done entry is
  dated 2026-10-08; commit 654d822 is 2026-10-08 00:15 UTC.

## How to change it safely

**Record status after landing a runtime change (CORE)**
1. Update `packages/runtime/STATUS.md`: "Updated:" line, State (VM command and counts), a batch section, Deviations
   (with the reason) and Open issues.
2. If the public surface changed, update `docs/runtime/API.md` and the JSDoc in `src/types.ts` in the same change.
3. Move the item in `OPEN_TASKS.md` (Next → In progress → Done), with evidence.
4. Ask the requester to flip its NEEDS item to DONE after verifying. Do not close or rewrite another workstream's items
   yourself; owners may add answers under their own heading in the requester's file, as MODEL did in `training/NEEDS.md`
   ("MODEL → TRAIN (from MODEL, 2026-10-07)").

**Propose a contract change or deviation**
1. Write the request with evidence in your NEEDS file (or tell the lead directly).
2. After approval, the lead appends it to CONTRACT §13 or the owner lists it in STATUS "Deviations from the contract (and why)".
3. Never diverge silently. A deviation without a STATUS entry is a bug.

**Change anything the model reads (after `situation-v1`)**
1. Get the user's go-ahead: it invalidates SIM phase A/B data and the final training rounds.
2. Change only `packages/runtime/src/situation/*` (one implementation) plus `util.ts` helpers if needed. Update example
   situations in STATUS from `test/situation.test.ts` / `test/budget.test.ts` output.
3. Tell SIM (regenerate) and TRAIN (`training/curriculum/rt.py` mirror; per-header calibration in `calibration.json` is
   keyed on exact instruction text, training/NEEDS 5). Expect a new freeze tag (convention suggested by `situation-v1`; no v2 exists).
4. Run locally or on the VM in your slot (STATUS "State"; where to run:
   [ground rule 5 (Mac safety)](#ground-rules-binding-contract-0-and-05-restated)): `npm install` at the repo root, then in `packages/runtime`
   `npx tsc --noEmit` and `GENCLASS_MODEL_DIR=~/gcl/model/.cache-model NODE_OPTIONS=--expose-gc npx vitest run`
   (model tests need the v0.1 model directory; the gc test needs `--expose-gc`). Exact commands:
   [runtime/build-test-release.md](runtime/build-test-release.md).

**Fix doc drift**
1. Confirm the behaviour in code first. Code wins; do not change code to match a doc unless the lead decides the doc is the spec.
2. Edit the doc owned by the right workstream: CONTRACT (lead), STATUS/API (CORE), UI-NEEDS (UI), sim/NEEDS (SIM), etc.
3. Fixing JSDoc in `src/types.ts` is safe (no situation text). Fixing `BUILTIN_ACTIONS` descriptions is **not** (model input).

**File a cross-workstream request**
1. Add a numbered item to your NEEDS file: addressee, status (OPEN or ASK), evidence (trace, seeds, row ids, file -> symbol), a
   suggested fix and, for CORE, a regression test sketch (demos/NEEDS §1 is the model).

**Run checks** (where to run: [ground rule 5 (Mac safety)](#ground-rules-binding-contract-0-and-05-restated) and [runtime/build-test-release.md](runtime/build-test-release.md#where-to-run-things))
- Runtime unit tests (local or VM): in `packages/runtime`, `NODE_OPTIONS=--expose-gc npx vitest run` (`vitest.config.ts`
  already excludes `test/browser/**`; without `--expose-gc`, `test/review-timers.test.ts` logs "[review] skipped: run with
  NODE_OPTIONS=--expose-gc" and passes without checking anything).
- Tarball smoke (ask the user first; Playwright Chromium and npm registry): `bash test/smoke/smoke.sh` from `packages/runtime`.
- Sim tests (ask the user first): from the repo root, `npm run build && cd sim && SIM_RUNTIME=real npx vitest run` (the sim
  imports `@genclass/runtime` through `packages/runtime/dist`, `sim/src/run/rt.ts` -> `realRuntimeFactory`, so build first).

## Tests

| test file | what it asserts (status-relevant) |
|---|---|
| `test/review-actions.test.ts` | error-trigger `rollback` offered only when the failing chain wrote state; never reverts other chains' writes |
| `test/review-hub.test.ts` | held value writes re-applied as patches; late-revert undo; in-place updaters while held; versions past the 16-entry history; 2,000-item arrays; throwing commits do not strand queues |
| `test/review-dom.test.ts` | password values never recorded; programmatic `el.click()` inside an op is not a user action |
| `test/review-fetch.test.ts` | request identity (Request bodies, Range); coalesce never hangs; memory bounds (64 × 256 KB); destroy pass-through; no holds in guard mode for failures; keepalive never held; failure/error-rate fact wording |
| `test/review-xhr.test.ts` | sync XHR never held; abort while held; listeners once per object; reuse after block |
| `test/review-timers.test.ts` | recursive `setTimeout` loops: no stack overflow, no retention |
| `test/review-precision.test.ts` | short last page not unusual; `m21`-style keys; null selection not an inconsistency; lingering violation does not freeze `lastConsistent` |
| `test/review-redaction.test.ts` | custom `redact` applies to invariant facts |
| `test/review-misc.test.ts` | console ×N summaries; rate-limit warning once; init robustness on read-only globals; `ctx.builtin` cannot bypass policy; never-settling provider; `ask` after destroy rejects `destroyed` |
| `test/review-perf.test.ts` | cost with 5,000-item stores; asserts per-write < 1 ms (keystroke), < 2 ms (gated async write), redux dispatch < 1 ms (user) / < 2 ms (async), settled point < 16 ms (STATUS measured 0.14, 0.19, 0.68/0.58, 0.2 ms) |
| `test/batch3.test.ts` | SIM a–f (redaction by meaning, state lines, "back to V", item diffs, slug ids, pending-local-change fact); `transient` after `unusual`; lifecycle guarantees |
| `test/budget.test.ts` | section limits (1,100: 6/2/3/3/1, 2,000: 9/4/9/5/2, 3,200: 12/6/16/8/4; 500 = 1,100); compact questions (≤ 24-char overrides kept); byte-identical determinism; auto budgets webgpu 3,200, wasm 1,000 / 1,333 / 2,000 at 1 / 2 / 4 threads (16 threads → 2,000), unknown device 3,200, a fixed number wins; `max_tokens_exceeded` shrink; hold-budget formula and `timeoutMs` of held requests |
| `test/situation.test.ts` | one situation per trigger (the STATUS examples); side-effect-free `ask` situation; shrink order; identical situations on a fake clock |
| `test/policy.test.ts` | §8 gate: summed mass, tiers, thresholds, deny/allow, pause, rate limit, observe never holds, fail-open while loading, detection threshold |
| `test/smoke.test.ts` | atoms apply synchronously when not salient; context through awaits; stale write held and discarded in guard mode |
| `test/smoke/smoke.sh` | packed tarball installs into Vite 8, builds, loads in headless Chromium with devtools, ≥ 3 events, no console errors (`model: false`) |

## Drift and open issues

### Open issues by owner (as of 654d822, verified in code where marked)

| owner | issue | source | state in code |
|---|---|---|---|
| CORE | **Held writes land after a newer user write.** User-sync writes bypass the store queue and apply at once; an earlier held write later re-runs its updater on top and overwrites the user's change. Board: jump-backs 3.07 → 4.80 per session, 0 actions | demos/NEEDS §1 | open: `state/hub.ts` -> `StoreHub.propose` (`bypass` → `commit` immediately) |
| CORE | **Holds cost latency** when the model is slower than the budget; decision requests queue one at a time; superseded requests are not dropped | demos/NEEDS §2 | open: `RuntimeImpl.trigger` holds whenever an action is permitted; `DeciderQueue` has no supersede logic |
| CORE | **`retry` offered for non-idempotent requests** (duplicate orders after a 502/504 that committed) | demos/NEEDS §5 | open: `builtinApplicable` → `replayable && attempt < 4 && fetch` (no idempotency check). `req.idempotent` (from `util.ts` -> `IDEMPOTENT_METHODS` = GET, HEAD, OPTIONS, PUT, DELETE, TRACE, set in `observe/fetch.ts`) gates only `hedge` among actions; the model sees it only as the request fact "POST is not idempotent; …", and the `retry` description says nothing about idempotency |
| CORE | Observe `EventSource`/`BroadcastChannel` messages as ops | demos/NEEDS §6 | open: no reference in `src/` |
| CORE | Keep observing synthetic DOM events | demos/NEEDS §7 | satisfied (no `isTrusted` filter), except: any event while a non-user op's code is running, untrusted events while a non-user op is ambient (`observe/dom-user.ts` -> `programmatic`), and events inside `[data-genclass-ignore]` (`ignoredEvent`) |
| CORE | In-place mutation detection is best effort (8 sampled elements/values) | STATUS Open issues | open by design |
| CORE | Situation budget assumes 3.2 chars/token; measured 2.4 | training/NEEDS 6a | open: `STATE_CHAR_BUDGET` = 3200 unchanged; TRAIN trains with `max_len` 2048 |
| CORE | `rollback` description ("last consistent snapshot") does not match transition/error effect (chain revert) | code reading | open; fixing it changes model input |
| CORE | Fact "could not be held: the update changed the stored value in place" is unreachable (unholdable writes commit in `propose` without gating) | code reading | open |
| MODEL | Device-based model selection in the host card | OPEN_TASKS 5 | not started: `model/loader.ts` -> `parseCard` reads one model's variants (`q8`/`fp16`) per card; `planOrder` picks only variant and device |
| UI | Overlay ignores `Explanation.message` | UI-NEEDS 3 | CORE side done (`types.ts` -> `Explanation.message`, `runtime.ts` -> `explain`); the overlay still takes lines only from `on("report")` (`devtools/index.ts` -> `addReport`) and otherwise falls back to its own templates. See [runtime/devtools.md](runtime/devtools.md) |
| SIM | Phase B (1.4M rows) | OPEN_TASKS 1 | in progress |
| SIM | Phase A is below TRAIN's stated volume: train 448,420 (asked ≥ 1M, target 1–2M) and **dev 14,613 (asked ≥ 20k)**; test 137,643 meets ≥ 40k | training/NEEDS 1 (still OPEN) | phase B should cover train; whether dev grows is not recorded |
| SIM | Clean-run rows flagged `meta.clean: true` | training/NEEDS 4 (ASK) | not found in `sim/src` |
| TRAIN | Final rounds 1 and 2, calibration, export, parity, EVAL.md per trigger and budget | OPEN_TASKS 3–4 | round 1 running at commit time |
| DEMOS | Screenshot tour and README; evaluation with the trained model (bug rate Off/Guard/Heal, clean-run false interventions) | OPEN_TASKS 2, 6 | v0.1 numbers only |
| DEMOS | **`demos/src/server/data/cities.ts` is missing from git** (root `.gitignore` line `data/` ignores it). `demos/src/server/worlds/search.ts`, `demos/src/demos/search/scenario.ts` and `demos/src/demos/search/oracle.ts` import it, and `demos/tsconfig.json` includes `src`, so it blocks the demos build, the demos typecheck (and with it the root `npm run typecheck`, which runs every workspace's `typecheck`; inferred from the code, `tsc` not run) and the Service Worker bundle | [demos.md](demos.md#drift-and-open-issues) Drift 1 | open: `demos/src/server/data/` does not exist |
| lead | Publish `@genclass/runtime-model@0.1.0` + release `runtime-model-v0.1.0`, then `@genclass/runtime@0.1.0`; CI (build, typecheck, unit tests); honest-results docs; model card numbers; dev-only lazy devtools import | OPEN_TASKS 7–8 | not done |
| CORE / lead | A test for the shipped default path (model card 404 → status `error` → observe only, status report printed) | code reading (see Gotchas) | none exists |

### Known risks

- **Single-thread WASM speed** (OPEN_TASKS): hold budgets cap at 800 ms, so slow devices fail open more. Measured
  (Node, 1 thread, q8): R17 188 / 339 / 608 ms and R32 499 / 879 / 1,539 ms at 500 / 780 / 1,170 tokens (`training/EVAL.md`).
- **Training-label noise** (OPEN_TASKS): costs come from K = 3 sampled futures (`sim/README.md` limitation 1); "66% of
  passive-best request rows put ≥ 0.9 on passive" (in OPEN_TASKS since a53dd38, so a pre-freeze figure; phase A
  `label_sharpness.request.passive_mass_ge_0_9` = 0.676, and only 0.379 of intervene-best request rows put ≥ 0.9 on
  non-passive actions; `label_sharpness` is not split by train/dev/test). Diagnosis and action are labelled independently:
  "expected → coalesce" is about 11% of request rows (`sim/README.md` limitation 3); the runtime's diagnosis gate
  keeps those passive.
- **Thin classes** (OPEN_TASKS): in SIM phase A train, `diagnosis_by_split_trigger` counts `conflict` 10,204 and
  `unusual` 1,049 of 291,031 diagnosis labels, and `transition` is 12,360 of 341,204 non-`ask` rows
  (`sim/samples/stats-final-a.json`).
- **Hold-induced harm and triage sensitivity** (OPEN_TASKS 6, demos/NEEDS §1–§2), all with v0.1:
  - Board, guard mode, no interventions: OPEN_TASKS and `demos/results.md` say 9 bugs introduced vs 1 fixed. demos/NEEDS
    §4 attributes most of that to the mock server's single random stream. The corrected traced run (common random
    numbers) shows 5 introduced / 3 fixed and +56% visible jump-backs (§1).
  - Search, clean runs: `demos/results.md` user-latency p50 14 ms (Off) → 125 ms (Guard); demos/NEEDS §2 (final
    results, calm typist, 15 seeds) 6 ms → 389 ms, with 127 of 148 result writes held (median 543 ms).
  - Typeahead is salient about 6 times per clean trial (OPEN_TASKS 6).
- **v0.1 is not a runtime model**: `unusual` for 6,328 of 6,386 decisions, never `expected`; 0 false interventions only
  because it rarely clears thresholds in time (demos/NEEDS §8).
- **Paired demo results with v0.1** (`demos/results.md` summary table, 30 chaos seeds, fixed / introduced vs Off):
  Guard: search 0/0, editor 1/1, checkout 0/2, status 2/0, board 1/9, decisions 3/5; Heal: 0/0, 0/1, 0/2, 0/0, 2/9,
  2/5. False interventions on clean runs: 0 in every demo and mode. These predate the mock-server fix (demos/NEEDS §4).
- **Stage 1 does not transfer to SIM labels**: zero-shot on SIM's 123-row sample ≈ 50% action accuracy and 18–34%
  heal-mode false interventions (`MODEL_CARD.md`, `training/LOG.md`); the shipping model must come from the final rounds.
- **R17 vs R32 precision off the runtime-exact format**: on varied surface styles (`cur1/test`) heal FIR is 1.70%
  for R17 (stall 11.5%) vs 0.60% for R32 (`training/EVAL.md`). Relevant to OPEN_TASKS 5 (ship R17 for WASM).
- **Stage-2 pilot was precise but timid**: heal recall 1.3% (R32) / 1.4% (R17) on pre-freeze soft labels; final rounds
  use sharper labels.

### Decisions waiting on the user / repo owner

Recorded in `OPEN_TASKS.md` "Needs the user":
1. **Public demo hosting** (GitHub Pages on this repo): OK to publish? Open.
2. **Merging `runtime` into `main`.** `main`, `origin/main` and `origin/runtime` already point at 654d822, so this looks
   done; the owner should confirm and remove the item.

Pending lead/owner decisions inferred from NEEDS and OPEN_TASKS (not recorded as user questions):
3. Ship R17 only, or R32 for WebGPU "only if clearly more accurate" (OPEN_TASKS 5).
4. Whether to change the frozen runtime for demos §1/§2 (behaviour only) or §5/§6 and the `rollback` description
   (model-visible text, so new data and retraining).
5. Whether to rebudget situations by real tokens (training/NEEDS 6a).
6. VM access (hosts file, SSH key) for new agents. Partly settled on 2026-10-07: the lead allows the light checks (install,
   typecheck, build, runtime unit tests) locally on other machines. Heavy jobs still need the user's go-ahead and a place
   to run: sim, training, Playwright, model runs, demo eval.

### Doc drift: `docs/runtime/API.md` vs `src/types.ts`, `src/index.ts`, runtime

| # | API.md says | code does | evidence |
|---|---|---|---|
| 1 | Self-host with `npx genclass-runtime fetch-model public/genclass-model` | Default `--from` is the unpublished release `runtime-model-v0.1.0`; today it needs an explicit `--from` (e.g. the v0.1 URL) | `bin/genclass-runtime.mjs` -> `DEFAULT_FROM` |
| 2 | `baseUrl` default "jsDelivr CDN" | Correct URL, but the package is unpublished: default init observes only | `model/host.ts` -> `DEFAULT_MODEL_BASE_URL` |
| 3 | `model` options: `baseUrl`, `device`, `worker`, `preload` | Also `ortWasmPaths`, `cacheName` | `types.ts` -> `ModelOptions` |
| 4 | `rt.ready` resolves when ready (immediately with no model) | Rejects with the provider's error on load failure; memoised | `runtime.ts` -> `get ready` |
| 5 | `ask`/`decide` reject with `GenClassUnavailableError` | With `timeoutMs` and a failed load the raw provider error propagates; `timeoutMs` applies to the load wait and the answer wait separately | `runtime.ts` -> `ask` |
| 6 | `pause()` stops consulting the model | `ask`/`decide` still query it (no `paused` check) | `runtime.ts` -> `ask` |
| 7 | Kill switch: `localStorage.genclass = "off"`; URL `?genclass=observe\|guard\|heal` | localStorage also accepts `observe\|guard\|heal`; URL wins | `index.ts` -> `killSwitch`, `initUnsafe` |
| 8 | Outside a browser `init()` returns an inert runtime: no observers, no model | Observers off and no host, but `options.decider` is kept; `report` defaults to `"silent"` | `index.ts` -> `initUnsafe` |
| 9 | `holdBudgetMs: "auto"` = clamp(1.5 × median, 150, 800) | Plus 300 ms fallback when no latency and no `warmupMs` | `decide/policy.ts` -> `holdBudget` |
| 10 | Bodies over 64 KB never match | String bodies up to 1 MB are hashed and can match; 64 KB applies to Blob/ArrayBuffer/view/Request bodies | `observe/fetch.ts` -> `STRING_BODY_MAX`, `IDENTITY_BODY_MAX` |
| 11 | Report example "(v0 → v1)" | "(version 0 → 1)" | `situation/facts.ts`; STATUS examples |
| 12 | `situation()` returns `{ trigger, subject, state, questions, actions, salient, facts }` | Also `compact`, `budget`; returns the last situation built for that trigger if any, else the "ask about now" situation relabelled with that trigger (so `actions` is empty) | `types.ts` -> `Situation`; `runtime.ts` -> `situation` |
| 13 | Plugin facts are "added to every situation" | Only to built situations (after triage), always neutral, ranked last, may be cut | `situation/build.ts` -> `buildSituation` |
| 14 | `on("status")`: model loading progress and state | Also fired by every `setMode` | `runtime.ts` -> `setMode` |
| 15 | Type listings | Omit `UserAction.data`, `Op.meta`, `ActionDef.risk` (unused) | `types.ts` |
| 16 | Exports | Undocumented: `browserClock`, `stateText`, `stateChars`, `sectionLimits`, `STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS`, `PASSIVE`, `DEFAULT_DIAGNOSES`, `describeElement`, `RuntimeImpl`, default export, model errors beyond the five named (`GenClassModelError`, `ModelInputError`, `ModelUnsupportedError`, `ModelAbortedError`, `ModelDisposedError`, `ModelIntegrityError`, `ModelInferenceError`), host types; `./worker` subpath; React `GenClassProvider`, `getGenClassAtom`, `useGenClassDecisions`, `useGenClassInterventions`, `useGenClassStatus`; Redux `GENCLASS_REPLACE`; Zustand `genclass(runtime, name, opts?)` | `index.ts`, `package.json` `exports`, `src/adapters/*.ts` |
| 17 | `observe` defaults not stated | `timers` on only when `global.document` is a non-null object; others on | `runtime.ts` -> `installObservers` |
| 18 | Trigger/action tables do not distinguish fetch from XHR | XHR: no `coalesce`; failure `retry`/`serve_cached` and stall `hedge`/`serve_cached` are fetch-only, so XHR failures and stalls are detection-only; XHR requests can still get `delay`, `block`, `serve_cached` | `situation/build.ts` -> `builtinApplicable`; STATUS deviation 2 |
| 19 | Types section lists `Decision`, `ActionRecord`, `Explanation`, `RtEvent`, `Op` | Public types a plugin or provider author needs are not listed: `SituationDraft` (input of `facts()`, `applicable()`, `ActionContext.situation`), `Fact`/`FactKind`, `RequestInfo`, `SubjectRef`, `EvaluateRequest`, full `ModelStatus` (`model`, `loadMs`, `version`, `bytes`, `fromCache`, `warmupMs`, `worker`, `workerError`, `gpu`, `attempts`, `ort`), `ChoiceAnswer.confidence` = (k·max p − 1)/(k − 1), `AdapterIO`/`AdapterHandle`, `RuntimeHooks.mutationProposed` payload, `StandingQuestionContext` | `types.ts` |

API.md is otherwise accurate for batch 3 (summed gate, `candidate`/`mass`, `transient`, compact questions, retry
backoff `min(200 · 2^(attempt−1), 5000)`, word-level redaction, `data-genclass-ignore`).

### Recorded contract deviations (STATUS "Deviations from the contract (and why)")

These are accepted by CORE and listed in STATUS; CONTRACT.md was not updated. Each also appears in the table below.

| # | deviation | why (STATUS) | code |
|---|---|---|---|
| 1 | `retry` backoff `min(200 ms · 2^(attempt−1), 5 s)` (first retry waits 200 ms) | — | `observe/fetch.ts` (failure handler) |
| 2 | `coalesce` not offered for XHR; XHR failures/stalls detection-only | the app receives XHR events directly | `situation/build.ts` -> `builtinApplicable` |
| 3 | Transition profiles compare array kinds as empty / non-empty only (no length-delta sign) | precision: a short last page or a removal is ordinary | `learn/profiles.ts` -> `kindLabel` |
| 4 | Error/transition `rollback` restores only the fields the op's own chain wrote; inconsistency uses the snapshot | the snapshot would also revert other chains' writes (e.g. user input) | `runtime.ts` -> `revertChain`; `situation/build.ts` -> `revertableChain` |
| 5 | Default redaction by word-level secret names, not the §2 regex | approved SIM request a | `util.ts` -> `defaultRedact`, `isSensitiveName` |
| 6 | `situation(trigger)` returns the last situation built for that trigger | — | `runtime.ts` -> `situation` |
| 7 | Extra public surface (`adapter`, `inflight`, `holdBudgetMs`, `situationBudget`, `on("report")`, extra `Situation`/`Decision`/`ActionRecord`/`Explanation`/option fields) | additive | `types.ts` |

### Doc drift: `docs/runtime/CONTRACT.md` vs implementation

| § | CONTRACT says | code does |
|---|---|---|
| 1 | `src/observe/` = fetch, xhr, dom-user, errors, nav, storage, perf, websocket | Also `timers.ts` and `cache.ts` (response cache); extra top-level `src/util.ts`, `src/errors.ts`; `situation/` also has `build.ts`, `describe.ts`, `env.ts` |
| 2 | Kill switch: `localStorage.genclass = "off"`; adapters: React `useGenClassState`, `useAtom`, `useGenClass` | localStorage also accepts `observe\|guard\|heal`; adapters also export `GenClassProvider`, `getGenClassAtom`, `useGenClassDecisions`, `useGenClassInterventions`, `useGenClassStatus`, Redux `GENCLASS_REPLACE`; Redux `genclassEnhancer` and Zustand `genclass` accept a null runtime and pass through, React `useGenClassState` falls back to plain `useState`, but `useGenClass()` throws without a runtime (`src/adapters/*.ts`) |
| 4 | Mutations "applied in proposal order per store (a later-decided mutation waits for earlier ones on the same store)" | Only for queued writes: user-sync writes (unless `holdUserWrites`), GenClass writes, `hold: false` stores and paused runtimes bypass the queue and commit at once, overtaking held writes (`state/hub.ts` -> `StoreHub.propose`; demos/NEEDS §1) |
| 6 | `hedge` applicable when the body is replayable and the method idempotent | Also GET only and fetch only (`builtinApplicable`) |
| 1 | `src/plugins.ts`; `state/` "atom, guard, diff/summaries, invariant miner, snapshots"; `decide/` "built-in actions, executor"; `learn/` baselines only | No `plugins.ts` (plugins in `runtime.ts`); `state/{hub,fields,invariants}.ts`; action catalogue in `situation/questions.ts`, `decide/exec.ts` is only the `Controller` seam; `learn/profiles.ts` exists |
| 1 | adapters/devtools owner CORE; `training/` owner LEAD; `runtime-model/` "model card + files"; CLI "fetch-model" | §13 and UI-NEEDS: UI; training/README: TRAIN; only `MODEL_CARD.md`; CLI also has `info <dir>` |
| 2 | `redact` default `/pass\|token\|secret\|card\|cvv\|ssn\|auth/i` | Word-level `isSensitiveName` (approved SIM a) — `util.ts` -> `defaultRedact` |
| 2 | `InitOptions` listing without `decider`, `learn`, `vocabulary`, `settleMs`, `situation`, `observe.timers` (§4 mentions `settleMs` and `learn: { persist }`, §13 approves `vocabulary`); `Runtime` without `mode`, `adapter`, `inflight`, `holdBudgetMs`, `situationBudget`, `on("report")` | All exist (STATUS "Extra public surface") |
| 2 | `device: auto` = webgpu+fp16 if shader-f16, else wasm+q8 | Plans webgpu+fp16 → webgpu+q8 → wasm+q8; auto skips software adapters (`model/loader.ts` -> `planOrder`) |
| 3 | `Op` fields; identity = hash of method+url+body; ids normalised: numbers, uuids, long hex; body methods `json,text,arrayBuffer,blob,formData` | Adds `Op.meta`; identity adds non-volatile headers; also long mixed tokens and short slug ids (`util.ts` -> `isIdSegment`); also `bytes` |
| 4 | Hub records snapshots; every template (incl. `a != null`) is learned after ≥ 3 settled snapshots; profile kind includes length delta sign; duration bucket in the shape | `RuntimeImpl.settled` records them (≤ 8, lingering violations do not block); `state/invariants.ts`: `LEARN_AFTER` = 3 but `LEARN_AFTER_NONNULL` = 6 for `a != null`; array kinds empty/non-empty only (STATUS deviation); `dur` recorded but never raises a transition (`learn/profiles.ts` -> `Profiles.check`) |
| 4 | Settled = no in-flight ops | No in-flight op younger than 10 s **and** no pending write (`RuntimeImpl.busy`) |
| 6 | Budget ≤ 1,000 tokens; truncate timeline, then state, then facts; `situation()` returns `{trigger, subject, state, questions, actions}` | Character budget, device-sized; then in-flight/stats and fact shortening; extra `salient/facts/compact/budget` |
| 6 | Triage example "baseline ratio beyond 3×" | Cause latency > 3× median **and** ≥ 100 ms over it; rate ≥ 3× usual **and** ≥ 5 in 10 s (`situation/facts.ts`) |
| 7 | `retry` backoff `min(200 ms · 2^attempt, 5 s)` | `min(200 · 2^(attempt−1), 5000)` (STATUS deviation) |
| 7 | `rollback` writes the snapshot back | Snapshot only for `inconsistency`; error/transition revert only the chain's fields (STATUS deviation) |
| 7 | Implied XHR parity | XHR: no `coalesce`, `retry`, `hedge`, failure/stall `serve_cached` (STATUS deviation) |
| 8 | `holdBudgetMs` default 300 | `"auto"` (150–800; 300 only as fallback) |
| 8 | `Decision`/`ActionRecord`/`Explanation`/`DecisionProvider` field lists | Add `tier`, `ran`, `answers`, `subjectRef`, `candidate`, `mass`, `late`, `message`, `priority`, `timeoutMs` |
| 8 | Repeats "summarised as ×N in the last minute" | `(×N more in the last minute)` printed at window end, console sink only |
| 9 | `ActionDef` without `tier`; `StandingQuestion` without `always`; PluginApi without `runInOp`, `runtime` | All exist; `risk` is declared but unused |
| 10 | Worker imports `onnxruntime-web/webgpu`; reference engine at `/Users/meharkhanna/jev/...` | Imports `/wasm` or `/webgpu` on demand (`model/worker.ts`); path is another machine (v0.1 card is `extension/src/model/model.json` here) |
| 13 | `situation(trigger)` is side-effect free | Returns the cached last-built situation; building caches `op.reads` (STATUS deviation) |
| 0.5 | Console examples "Coalesced a duplicate: …", "Flagged: …" | Templates: `[GenClass] <Lead> a/an <diagnosis> <noun>: <top fact> <changed> (<diag>, p; <action> p)`; coalesce lead is "Prevented", late reverts "Reverted", actions without a `LEAD` entry (plugin actions) "Handled"; detections "Flagged a/an …" (`decide/report.ts` -> `interventionLine`, `detectionLine`) |

### Other doc drift

| file | stale statement | code / repo reality |
|---|---|---|
| `packages/runtime/README.md` | Privacy: "fields matching `pass\|token\|secret\|card\|cvv\|ssn\|auth` are redacted" | Word-level redaction; "card", "cards", "author" kept (`util.ts` -> `isSensitiveName`) |
| `packages/runtime/README.md` (status banner and "Self-hosting" bullet) | "self-host a model with `npx genclass-runtime fetch-model`" | Needs `--from` (see API #1). The root `README.md` does not mention `fetch-model` |
| `packages/runtime/README.md`, `docs/runtime/ARCHITECTURE.md` | "2,000 with WASM threads" | 2,000 only at 4 threads (1,333 at 2, 1,667 at 3) |
| `packages/runtime/README.md`, `README.md`, CONTRACT §0.5 | Console example lines | Real format differs (see CONTRACT §0.5 row); API.md's example is close |
| `packages/runtime/README.md`, OPEN_TASKS | ORT WASM 2.7 MB br (no WebGPU) / 4.7 MB | Not a real conflict: `src/model/README.md` measures 2.69 / 4.69 MB at brotli q9 and notes jsDelivr serves the wasm at 3.07 / 5.53 MB, the figures `model/worker.ts`'s comment rounds to 3.1 / 5.5 MB |
| `README.md` "How it works" 5 | guard acts "when the model is ≥ 90% sure" | Summed probability of the permitted non-passive actions ≥ 0.9 **and** top diagnosis ≠ `expected` (`decide/policy.ts` -> `gate`); the package README's wording ("very sure (≥ 0.9) that acting beats doing nothing") is accurate |
| `packages/runtime/UI-NEEDS.md` 3 | `Explanation.message` is "Nice to have" | Implemented by CORE (`types.ts` -> `Explanation.message`, `runtime.ts` -> `explain`; API.md documents it); only the overlay's use of it is missing |
| `packages/runtime/STATUS.md` Open issues; UI-NEEDS 2 | `react-dom` is not a devDependency | `react-dom ^19.3.0`, `@types/react-dom ^19.0.0` are devDependencies |
| `packages/runtime/STATUS.md` For UI | mock-runtime needs `holdBudgetMs()`/`situationBudget()` | Present in `test/browser/ui/mock-runtime.ts` |
| `packages/runtime/STATUS.md` batch 3 | Unholdable in-place write "applies at once with a fact" | Applies at once without gating, so no fact (`state/hub.ts` -> `StoreHub.propose`) |
| `packages/runtime/STATUS.md`, sim/NEEDS header | Headless thresholds `{ report: 0, guard: 0, heal: 0 }` | The sim uses guard/heal 0.5 (`sim/README.md`) |
| `packages/runtime/UI-NEEDS.md` 1 | Ignore the devtools overlay: Open | Done: `observe/dom-user.ts` -> `ignoredEvent`; STATUS "For UI" agrees |
| `sim/NEEDS.md` a–f | ASK | DONE in batch 3 (STATUS; `test/batch3.test.ts`) |
| `sim/NEEDS.md` Notes | `transient` not yet in `DEFAULT_DIAGNOSES` | It is, last (`situation/questions.ts`) |
| `sim/README.md` limitation 5 | Triage does not flag a remote write over a pending local change | It does (`situation/facts.ts` "has a pending local change"; SIM f) |
| `training/NEEDS.md` | "Still to mirror when CORE's fix batch lands" | Done per `training/LOG.md` 23:05–23:35 (`rt.py` re-ported; MODEL NEEDS 8 fixed) |
| `OPEN_TASKS.md` item 8 | `npm pack` smoke test is next | Done (`test/smoke/smoke.sh`, Done list) |
| `OPEN_TASKS.md` item 7 | "ARCHITECTURE.md are written; still to do: … ARCHITECTURE.md" | Self-contradictory; the to-do is "honest results" content |
| `OPEN_TASKS.md` item 6, `demos/results.md` | Board: 9 bugs introduced in guard mode | Superseded by demos/NEEDS §1/§4 (5 introduced / 3 fixed after the mock-server fix) |
| `OPEN_TASKS.md` risks | Thin classes "until the batch-3 runtime facts land" | Batch 3 landed before phase A; see Known risks for counts |
| `docs/runtime/ARCHITECTURE.md` | DOM events "trusted events only"; sources omit timers; diagnosis order "…failing, transient, slow…"; fact "(v0 → v1)" | Untrusted events kept unless a non-user op is running or ambient (`observe/dom-user.ts` -> `programmatic`); timers observer exists; `transient` last; "(version 0 → 1)" |
| `packages/runtime-model/MODEL_CARD.md` | 9 diagnoses; acts when `p(action) ≥ 0.9/0.8`; q8 is "for onnxruntime-web WASM"; status "stage 2 piloted" | 10 (with `transient`); summed probability of permitted actions; MODEL verified q8 also runs on the WebGPU EP without shader-f16 (training/NEEDS, MODEL → TRAIN 7); final round 1 is running |
| `sim/README.md` limitation 8, `stats-final-a.json` `token_estimate` | Token counts estimated as characters / 3.6 | TRAIN measured 2.4 chars/token with the runtime tokenizer (training/NEEDS 6a), so SIM's token estimates are ≈ 1.5× low |
| `src/types.ts` JSDoc | `InitOptions.redact` regex; `InitOptions.situation` auto wasm budget "1,100 + 300 per extra thread"; `Decision.action` "The action the model chose (highest probability)"; `InitOptions.observe` "Default: all true" | word-level; `1000 + round((t−1)·1000/3)`; `run ?? top` in `runtime.ts` (the action that ran, else the model's choice); timers conditional |
| `src/situation/serialize.ts` comment | `STATE_CHAR_BUDGET` ≈ 3.2 chars per token | Measured 2.4 (training/NEEDS 6a) |
| `packages/runtime/bin/genclass-runtime.mjs` | — | Committed as mode 100644 (not executable). A root `npm install` chmods it to 755 (observed with npm 11.8.0 on 2026-10-07), which git reports as a mode change; revert with `git checkout -- packages/runtime/bin/genclass-runtime.mjs` |

### Code TODOs

None. `grep -rn "TODO\|FIXME\|HACK\|XXX"` over the repo (excluding `node_modules`, `.git`, `dist`) matches only
vocabulary entries in `extension/**/tokenizer.json` and prose in agent docs. Open work lives in the NEEDS,
STATUS and OPEN_TASKS files instead.

Comments that act like TODOs or temporary workarounds (found by grepping `packages/runtime/src`, `sim/src`,
`demos/src`, `training` for "until", "not yet", "for now", "stub", "workaround"):

| where | what it says | state at 654d822 |
|---|---|---|
| `sim/src/run/rt.ts` -> `realRuntimeFactory` | "Until the runtime's default vocabulary has every contract label, pass the contract's defaults explicitly"; also "CORE's API is in flux" and the error "does not export createRuntime yet" | Inert: runtime `DEFAULT_DIAGNOSES` has all 10 labels, so `missing` is false; the wording is stale |
| `sim/src/run/fake-runtime.ts` | "TEST DOUBLE ONLY": rows it produces are marked `meta.runtime = "fake"` and "must never be used for training" | Guarded: `sim/src/gen.ts` uses it only with `--allow-fake` |
| `src/model/backend.ts` -> `WARMUP_STATE`, `WARMUP_QUESTIONS` | Hand-copied situation and question wording for the warm-up pass ("What is going on?" vs the runtime's `DIAGNOSIS_INSTRUCTIONS` "What is happening here?") | Harmless: used only for the warm-up pass in `ModelBackend` load (also re-exported from `model/index.ts`); never a decision. Do not treat it as a wording reference |
| `src/types.ts` JSDoc, `src/situation/serialize.ts` comment | Stale values (see Other doc drift) | Safe to fix (no model-visible text) |

### Subsystem drift tracked elsewhere

The tables above cover the human docs (API.md, CONTRACT.md, READMEs, STATUS, NEEDS, MODEL_CARD) against the runtime
code. Each subsystem doc has its own Drift section with more detail: [public API](runtime/public-api-and-lifecycle.md),
[observe](runtime/observe-and-trace.md), [state](runtime/state-and-adapters.md),
[situation](runtime/learn-situation-triage.md), [decide](runtime/decide-policy-actions.md),
[model host](runtime/model-host.md), [devtools](runtime/devtools.md), [build](runtime/build-test-release.md),
[model-io-contract.md](model-io-contract.md), [sim.md](sim.md), [training.md](training.md), [demos.md](demos.md) (e.g.
Drift 1, the missing `cities.ts`), [genclass-model-lineage.md](genclass-model-lineage.md) and
[extension-and-benchmarks.md](extension-and-benchmarks.md).

## Related docs

- Agent docs: [README.md](README.md), [overview.md](overview.md), [repo-map.md](repo-map.md), [glossary.md](glossary.md),
  [playbooks.md](playbooks.md), [model-io-contract.md](model-io-contract.md), [sim.md](sim.md), [training.md](training.md),
  [demos.md](demos.md), [genclass-model-lineage.md](genclass-model-lineage.md),
  [extension-and-benchmarks.md](extension-and-benchmarks.md), [../../AGENTS.md](../../AGENTS.md)
- Runtime agent docs: [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md),
  [runtime/observe-and-trace.md](runtime/observe-and-trace.md), [runtime/state-and-adapters.md](runtime/state-and-adapters.md),
  [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md),
  [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md), [runtime/model-host.md](runtime/model-host.md),
  [runtime/devtools.md](runtime/devtools.md), [runtime/build-test-release.md](runtime/build-test-release.md)
- Sources: [OPEN_TASKS.md](../../OPEN_TASKS.md), [packages/runtime/STATUS.md](../../packages/runtime/STATUS.md),
  [docs/runtime/CONTRACT.md](../runtime/CONTRACT.md), [docs/runtime/API.md](../runtime/API.md),
  [docs/runtime/ARCHITECTURE.md](../runtime/ARCHITECTURE.md), [demos/NEEDS.md](../../demos/NEEDS.md),
  [sim/NEEDS.md](../../sim/NEEDS.md), [training/NEEDS.md](../../training/NEEDS.md),
  [packages/runtime/UI-NEEDS.md](../../packages/runtime/UI-NEEDS.md), [training/EVAL.md](../../training/EVAL.md),
  [training/LOG.md](../../training/LOG.md), [packages/runtime-model/MODEL_CARD.md](../../packages/runtime-model/MODEL_CARD.md),
  [demos/results.md](../../demos/results.md), [sim/README.md](../../sim/README.md), [scripts/vm.sh](../../scripts/vm.sh)
