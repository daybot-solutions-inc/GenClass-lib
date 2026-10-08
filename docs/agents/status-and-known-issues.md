# Project status, ground rules, open work, known issues and doc drift

> **Scope:** `HANDOFF.md`, `OPEN_TASKS.md`, `docs/runtime/RESULTS.md`, `packages/runtime/STATUS.md`, `demos/NEEDS.md`,
> `sim/NEEDS.md`, `training/NEEDS.md`, `training/PLAN-v1.md`, `training/LOG.md`, `packages/runtime/UI-NEEDS.md`,
> `docs/runtime/{CONTRACT,API,ARCHITECTURE}.md`, `README.md`, `packages/runtime/README.md`, `realapps/README.md`,
> `.github/workflows/ci.yml`, `packages/runtime/{CHANGELOG,INSTALL-NEEDS}.md`, `packages/runtime/test/install/*.md`,
> git history and tags, code TODO markers, the 2026-10-08 review of the situation-v2 work and the 2026-10-08 review of
> the merged install code. Cross-checked against `packages/runtime/src/**`, `packages/runtime/bin/**`,
> `packages/runtime/package.json`, `packages/runtime/tsup.config.ts`, `sim/src/**`, `realapps/**`, `training/**`,
> the npm registry (`npm view`) and the newer `origin/runtime` commits (read with `git show`, not merged).
> **Read this when:** you land in the repo cold and need to know what is shipped, what runs on Azure right now, what
> comes next and who owns it; before any change that could break a binding rule (situation text, determinism,
> dependencies, where to run things); before trusting a human doc over the code; when you pick up one of the review
> findings; when you finish work and must update STATUS/NEEDS/OPEN_TASKS/HANDOFF.
> **Source of truth:** the code. Verified against branch `mvp-v2-merge` at f107013 (`mvp-v2` + origin/runtime eff18cb merged + two runtime fixes), 2026-10-08 ~07:00 UTC. If this doc and the code disagree, the code wins.

## TL;DR

Path convention in this doc: `src/…`, `test/…` and `bin/…` are relative to `packages/runtime/`; bare runtime module
paths (`runtime.ts`, `types.ts`, `util.ts`, `state/hub.ts`, `situation/content.ts`, `decide/policy.ts`,
`model/host.ts`, …) are relative to `packages/runtime/src/`. Every other path is from the repo root.

- **Branches.** `mvp-v2-merge` (this doc, head f107013, **not pushed**) = `mvp-v2` (c16a3b0) + dabbce2, the merge of
  Mehar's `origin/runtime` at eff18cb + 10e5c3b (lockfile sync) + 054da38 and f107013 (runtime fixes, below).
  `mvp-v2` = `origin/runtime` 74f17c0 plus 7dab2b3 (agent docs), f3636b2 (default `observe`), b435acb (CI, root
  lockfile, CLI 100755), b561244 and 6ac4737 (docs), 806a296 (release commit `0.1.0-alpha.1`) and c16a3b0 (publish
  record). Mehar's six merged commits: d53e836 (realapps wave 3), d05abc1 (npm README rewrite), 2516a6e (OPEN_TASKS:
  alpha.1 contents, Polar Parts rollout plan), 29b7f28 (`situation()` purity regression test), f3a9dd1 (one-command
  install, `/auto`, CDN script tag, `genclass-runtime` alias), eff18cb (v2 data done). **`origin/runtime` has moved on
  to 5bc40c9** (ca08174 realapps wave 4, 6d6eb00 REAL v2 production done, 416e374 first r17-v2a results, 5bc40c9
  runtime batch 6 = model-provided gate thresholds, tag `situation-v2.1`); none of them is merged here. A trial
  `git merge-tree HEAD origin/runtime` conflicts only in `packages/runtime/STATUS.md`. Local branch `mvp-v2-b6`
  (4e95373, worktree `GenClass-lib-b6`) already merges 5bc40c9 on top of f107013; this doc does not cover it.
- **Shipped on npm:** `@genclass/runtime@0.1.0-alpha.1` (`latest`, 2026-10-08 ≈ 05:33 UTC, from release commit 806a296,
  local tag `v0.1.0-alpha.1` not pushed): NaN fix, situation-v2, default `observe`, no model. It has **none of Mehar's
  install paths** (`npm view @genclass/runtime@0.1.0-alpha.1 exports` has no `./auto*`; `sideEffects: false`) and
  neither fix below. Before it, `0.1.0-alpha.0` (tag `v0.1.0-alpha.0` = 654d822): situation-v1, `guard` default, NaN
  crash. `@genclass/runtime-model` is **not published** (404).
- **Next release** (`0.1.0-alpha.2`, or a beta together with the v2 model once it is validated; `OPEN_TASKS.md` Next
  14): the install paths, the two fixes, and whatever of `origin/runtime` is merged by then. Before any build or pack
  meant to ship, bump `packages/runtime/package.json` (still `0.1.0-alpha.1`; the global build bakes the version into
  its jsDelivr URLs) and fix the install findings below. Publishing needs the user's 2FA ([RELEASE.md](../../RELEASE.md)).
- **Runtime on `mvp-v2-merge`:** situation-v2, decisions at the network boundary (`delivery` trigger,
  `RuntimeImpl.runDelivery`), no store-write holds by default, default mode `observe` (`runtime.ts` ->
  `o.mode ?? "observe"`). New: the `@genclass/runtime/auto` entries and the CDN/script-tag build (`src/auto.ts`,
  `src/cdn/*`); **054da38** observe mode never holds or delays a delivery and still records its decision (fixes DL-3,
  DL-4); **f107013** redaction fixes (SIT-1, SIT-3). Verified 2026-10-08 (macOS, Node v25.6.0): `tsc` clean, `tsup` OK,
  unit tests 44 files passed + 1 skipped (45), 375 passed + 14 skipped, `review-perf` alone 4 passed: **393 tests in
  46 files, 14 model-parity skips**. CI exists but has never run on GitHub (nothing pushed; `mvp-v2-merge` is not a
  CI trigger branch).
- **Frozen format:** tag **`situation-v2`** (annotated → 6e5e86e). f107013 changed model-visible text for redacted
  values only: `git diff situation-v2 HEAD -- packages/runtime/src/situation packages/runtime/src/state/fields.ts
  packages/runtime/src/util.ts` now shows `content.ts`, `fields.ts`, `util.ts`. No new tag was cut, the v2 SIM data
  and r17-v2a predate it, and `training/curriculum/rt.py` has no redactor at all (STATUS "Fix after
  0.1.0-alpha.1"). On `origin/runtime`, batch 6 adds one neutral stall fact and tags `situation-v2.1` (5bc40c9).
- **Azure (Mehar's jobs; they run on their own while Mehar sleeps; nobody on our side touches Azure).** SIM v2 data is
  **done**: gold 10,423,855 rows, unlabeled 51,272,078 (`OPEN_TASKS.md` "Done"); SIM's 20 nodes were deallocated
  04:55–05:10 UTC. TRAIN (per `training/LOG.md` 04:50–05:22 and the `training/NEEDS.md` claim table): workbench c02;
  **`r17-v2a`** (R17 from `r17-final1`, `mix_v2a`, 64 ranks on c09, c03–c08, c13, launched 05:14 UTC, ETA ≈ 06:20;
  `training/v2_post.sh` detached on c09 then evaluates `sim2e` + `sim2f` + expected gain, exports q8/fp16 with the
  `sim2e` calibration and serves the tar on :8801); **`t150-v2a`** (150M teacher from the MIT ettin-150m base,
  `mix_t150v2`, 88 ranks on c12, c14–c23, launched 05:20 UTC, ETA ≈ 08:30). REAL `v2c1`..`v2c4` had not landed at
  eff18cb; `v2b1`..`v2b3` stopped at ≈ 20.5k trajectories each with pre-fix diagnosis labels (`training/NEEDS.md` 16).
  Spend ≈ $440, burn ≈ $110/h with 20 nodes (LOG 05:22).
- **First v2 model: trained, not published, not in this branch.** `origin/runtime` 416e374 (`docs/runtime/RESULTS.md`)
  reports r17-v2a: `sim2e` diagnosis 84.4%, action 77.9%, guard FIR 0.00%, heal FIR 0.46%; real-app eval set guard and
  heal FIR 0.00%; recall at the fixed 0.9/0.8 gates very low (duplicate 0.6%, stale 1.0% on real apps), hence batch 6's
  model-provided thresholds. Still to come: teacher, distillation, DAgger, EVAL, then `@genclass/runtime-model@0.1.0`
  and `@genclass/runtime@0.1.0` (owner's 2FA). No t150-v2a result is recorded anywhere yet.
- **Default install today** (npm alpha.1 and this branch): `GenClass.init()` starts in `observe`, tries the
  unpublished model URL, ends in model status `error` and logs `[GenClass] Model unavailable (<error>); observing
  only.` From then on it traces and learns but never builds a situation or decides. No test covers this path.
- **Install code review (2026-10-08): 11 confirmed findings, nothing shipped yet.** Worst: `init` and
  `init --mode guard` install observe while printing "Mode guard" (`bin/lib/plan.mjs` -> `AUTO`, `scriptTag`), and the
  tree's version makes the CLI and global build point at the published alpha.1, which lacks those files. Full table:
  [Install code review](#install-code-review-2026-10-08).
- **Binding rules** (CONTRACT §0, §0.5, §13): no hardcoded bug rules; one situation implementation (frozen at
  situation-v2); determinism through the injected `Clock`; sim/realapps never read demos; one runtime dependency;
  precision first, default `observe`. Our run policy replaces CONTRACT §0 rule 5 for this machine (light checks
  local; ask before anything heavier, Azure, `git push`, `npm publish`).
- **Coordination files:** `HANDOFF.md` (start here for Mehar's sessions), `OPEN_TASKS.md`, `docs/runtime/RESULTS.md`
  (results and comparisons; "update it with every result"), `packages/runtime/STATUS.md` (CORE),
  `packages/runtime/INSTALL-NEEDS.md` (INSTALL), per-workstream `NEEDS.md` (`training/NEEDS.md` also holds Azure node
  claims and data locations).
- **Review of the situation-v2 work (2026-10-08): 52 confirmed findings; 4 fixed on this branch** (SIT-1, SIT-3 in
  f107013; DL-3, DL-4 in 054da38; DL-10 only for observe mode). Still open, the worst: a delivery `discard` is a silent
  no-op on redux/zustand stores (`state/hub.ts` -> `StoreHub.applyFilter`); unlabeled SIM rows hard-label `expected`
  diagnoses that S1 would relabel; SIM sampled the v1 3,200-char budget for 40% of trajectories in the finished v2
  data. Coordinate with the user (and through them Mehar) before fixing. Full list:
  [Review of the situation-v2 work](#review-of-the-situation-v2-work-2026-10-08).
- **Docs drift.** `HANDOFF.md`, `packages/runtime/test/install/INSTALL-README-SNIPPET.md` and the `init` usage text
  still say `guard` is the default; `packages/runtime/CHANGELOG.md` lists the install paths under `0.1.0-alpha.1`;
  `CONTRACT.md` has no `delivery` trigger; `docs/runtime/ARCHITECTURE.md` still says 3,200 chars. Tables in
  [Doc drift](#doc-drift-project-and-coordination-files). No TODO/FIXME/XXX/HACK markers in code.

## Files

| path | role | key content |
|---|---|---|
| `HANDOFF.md` | Mehar's hand-off for continuing Claude sessions (updated 2026-10-08) | current state table (npm, git, runtime, model, data, training), repo map, hard-won rules (8 GB Mac, Azure, zsh, freeze, licensing, commits), "How to continue" |
| `OPEN_TASKS.md` | Project status (owner inferred: lead), "as of ~05:45 UTC" in the merged tree | Done (alpha.1 publish, v2 SIM data) / In progress (r17-v2a, t150-v2a, REAL `v2c*`, one-command install, demos) / Next 6–18 (14: next prerelease with the install) / Model quality / Needs the user (2FA publishes, push, Polar Parts rollout) / Known risks |
| `docs/runtime/RESULTS.md` | Results, comparisons and training log (Mehar, 2026-10-08) | §1 model stages, §2 R17 vs R32, §3 v1 vs v2 separability, §4 never-worse sweep, §5 demos (v0.1 baseline), §6 data volume, §7 training log; FIR next to every recall number |
| `packages/runtime/STATUS.md` | CORE's status ("Updated" line still says batch 5) | State (VM test counts: 42 files / 348 tests after 29b7f28), "Fix after 0.1.0-alpha.1: two redaction leaks" (f107013), "Fix after batch 5: situation() purity" (29b7f28), batch 5 and batch 4 with "Contract deltas", batch 3, headless recipe, trigger table, example situations, **Deviations**, **Open issues**. No entry yet for 054da38 (observe deliveries) |
| `packages/runtime/INSTALL-NEEDS.md` | INSTALL → lead / CORE / MODEL / UI (f3a9dd1) | the `npx genclass-runtime` naming decision, the `package.json` changes (`./auto*` exports, `sideEffects` list, `unpkg`/`jsdelivr`), the tsup configs, runtime behaviour INSTALL relies on |
| `packages/runtime/CHANGELOG.md` | npm changelog (f3a9dd1) | `## 0.1.0-alpha.1` lists the one-command install, `/auto` and the script tag, which the published alpha.1 does not contain (see Drift) |
| `packages/runtime/test/install/RESULTS.md`, `INSTALL-README-SNIPPET.md` | INSTALL's VM test record; README snippet | run against a packed `0.1.0-alpha.0`-versioned tarball of Mehar's tree, which defaulted to `guard`; the snippet still says `guard` is the default |
| `docs/runtime/CONTRACT.md` | Binding build contract (lead) | §0 ground rules, §0.5 product principles, §1 layout, §2–§12 spec, §13 approved additions (now incl. default `observe`) |
| `docs/runtime/API.md` | Public API reference | updated for v2 (delivery, `holdWrites`, `untrustedEvents`, 2,400 budget) and for the observe default |
| `docs/runtime/ARCHITECTURE.md` | Design overview | principles (now observe default), data flow, training summary |
| `training/NEEDS.md` | TRAIN's needs; MODEL → TRAIN notes; **Azure node claims; SIM/REAL data locations** | items 1–16, cluster-expansion claim table, SIM → TRAIN scaled data, REAL → TRAIN (13–16) |
| `training/PLAN-v1.md` | Scaled training plan (teacher → students → DAgger) | targets, data inventory, models (R17/R32/R68/T150/T400), phases P0–P5, eval, infra, risks |
| `training/LOG.md`, `training/EVAL.md` | TRAIN's dated log and results | final round 1 (situation-v1) results, T1 runs stopped at the v2 freeze, spend |
| `sim/NEEDS.md` | SIM → CORE requests | requests 1–5 DONE, g (NaN crash, still marked OPEN), observations, batch-4 needs, v2 fact proposals, batch-4 integration notes |
| `sim/SEPARABILITY.md` | Why round 1 was timid; the F-facts and S1/S2 label fixes | evidence behind situation-v2 |
| `demos/NEEDS.md` | DEMOS → CORE/MODEL/UI/lead | §1–§8, written against batch 3 (stale for v2, see Drift) |
| `packages/runtime/UI-NEEDS.md` | UI → CORE requests | Open 1–2 and Nice-to-have 3 (stale, see Drift) |
| `realapps/README.md`, `realapps/EXAMPLES.md` | REAL's corpus, harness and audit | see [realapps.md](realapps.md) |
| `README.md`, `packages/runtime/README.md` | Repo landing page; npm README (rewritten by Mehar in d05abc1, merged) | both say `observe` is the default and `0.1.0-alpha.1` is `latest`; the npm README says the `init`, `/auto` and script-tag paths are "not in `0.1.0-alpha.1`" |
| `packages/runtime-model/MODEL_CARD.md` | Model card for the unpublished `@genclass/runtime-model` | status "final round 1 on the frozen runtime (situation-v1)"; the only tracked file in `packages/runtime-model/` |
| `.github/workflows/ci.yml` | CI (b435acb) | Node 22, `ONNXRUNTIME_NODE_INSTALL=skip`, `npm ci`, typecheck and build of `@genclass/runtime`, unit tests without `test/browser/**` and `review-perf`, then `review-perf` with `--retry=2` |
| `package-lock.json` (root) | committed in b435acb | CI runs `npm ci` from it; keep it in sync |
| `AGENTS.md`, `CLAUDE.md`, `docs/agents/**` | Agent docs (7dab2b3, refreshed for v2 in b561244; this doc, AGENTS.md, repo-map and glossary re-verified at f107013) | run policy, commands, ground rules, subsystem docs |
| `scripts/vm.sh` | Mehar's way to build/test on the `train` VM (`sync`, `run`, `exec`, `get` per SLOT) | needs `~/.jev-local/azure_hosts` and `~/.ssh/jev_azure` (not in repo); we do not use it without asking |
| `packages/runtime/test/review-*.test.ts` | REVIEW's regression tests (10 files) | must pass unchanged |
| `packages/runtime/test/smoke/smoke.sh` | npm tarball smoke test (Vite app, headless Chromium) | runs with `model: false`; ask before running |
| `docs/CONTRACT.md`, `docs/CONTRACT-v2.md`, `docs/SPEC.md`, … | **Legacy jev-local docs**, not the runtime contract | CONTRACT §1: "stays as is. Do not edit it." |

[RELEASE.md](../../RELEASE.md) at the repo root (committed in b561244, publish recorded in c16a3b0) is the release
procedure: Part A for `0.1.0-alpha.1` (done), Part B for the model and `0.1.0`. It has no part for the next
prerelease with the install paths (`0.1.0-alpha.2`). `extension/RELEASE.md` is the legacy
Chrome-extension release note.

## Concepts and data structures

### People, workstreams and ownership

Every commit up to 74f17c0 is by Mehar Khanna (messages prefixed "Mehar commit: …"); he ran the original
multi-agent team (lead, CORE, MODEL, UI, SIM, REAL, DEMOS, TRAIN, REVIEW) and operates the Azure cluster and the npm
org (`genclass`, owner meharpro). 7dab2b3, f3636b2, b435acb and every later `mvp-v2`/`mvp-v2-merge` commit not
prefixed "Mehar commit" are by Karan (this repo's user; `0.1.0-alpha.1` was published as `karanvir1729`). The roles below belong
to the original team: where a doc says "ask the lead", **ask the user**.

| workstream | owns (edit rights) | writes | reads / serves |
|---|---|---|---|
| **lead** | `docs/runtime/CONTRACT.md`, `packages/runtime-model/`, `OPEN_TASKS.md`, `HANDOFF.md`, `docs/runtime/RESULTS.md` (inferred: Mehar's commits, no owner lines) | contract changes (§13), approvals, node-claim arbitration, merges, publishing | relays sim/NEEDS and training/NEEDS |
| **CORE** | `packages/runtime/**` except `src/model/**`, `src/devtools/**`, `src/adapters/**`; owns `src/situation/*` wording and `src/types.ts` | `packages/runtime/STATUS.md`, `docs/runtime/API.md` (inferred) | sim/NEEDS, UI-NEEDS, demos/NEEDS, training/NEEDS |
| **MODEL** | `src/model/**`, `bin/genclass-runtime.mjs` | `src/model/README.md`, MODEL → TRAIN notes | training/NEEDS |
| **UI** | `src/devtools/**`, `src/adapters/**` (CONTRACT §13) | `packages/runtime/UI-NEEDS.md` | STATUS "For UI" |
| **SIM** | `sim/` | `sim/NEEDS.md`, `sim/README.md`, `sim/SEPARABILITY.md`, data under `train:/data/sim-out/` | STATUS, training/NEEDS |
| **REAL** (new since 654d822) | `realapps/` | `realapps/README.md`, `realapps/EXAMPLES.md`, training/NEEDS items 13–16, data under `~/gcl/real-out/` on the generating VM, then `train:/data/real-out/` | STATUS ("REAL reads this file"); imports the sim's cost weights and label rule from `sim/src` |
| **DEMOS** | `demos/` | `demos/NEEDS.md`, `demos/README.md`, `demos/results*` | STATUS |
| **TRAIN** | `training/` | `training/NEEDS.md`, `LOG.md`, `EVAL.md`, `PLAN-v1.md` | SIM/REAL output |
| **REVIEW** | `packages/runtime/test/review-*.test.ts` | regression tests | runtime code |
| **INSTALL** (new in f3a9dd1) | `src/auto.ts`, `src/cdn/**`, `bin/lib/**`, the `init`/`remove` commands, `test/install/**` (`packages/runtime/INSTALL-NEEDS.md` header) | `packages/runtime/INSTALL-NEEDS.md`, `test/install/RESULTS.md` | runtime `GenClass.init`, model host options |

Separation rule (CONTRACT §0 rule 4): SIM and DEMOS do not read each other's code. REAL also never reads demos (it
imports from `sim/src`, which is allowed).

### Communication file conventions

- **`HANDOFF.md`** is the entry point for a new Mehar-side session: read it, then `OPEN_TASKS.md`, `training/LOG.md`
  (tail) and `training/NEEDS.md`; check running VMs; pick the next unfinished item. Its rules (8 GB Mac, `az` calls one
  at a time in `timeout`, push to `origin runtime` as you go) describe Mehar's setup, not ours.
- **`docs/runtime/RESULTS.md`**: every result goes here, with the false-intervention rate (FIR) next to every recall
  or fix-rate number (HANDOFF "How to continue" step 4).
- **`STATUS.md` (CORE).** Header `Updated: <date> (<batch>). Owner: CORE. SIM, DEMOS, UI, REAL and MODEL read this
  file.` Sections per batch, each with a **"Contract deltas"** list; then "Deviations from the contract (and why)" and
  "Open issues". Since batch 4 the contract changes live there, not in CONTRACT.md (see Drift).
- **`NEEDS.md` files** live in the requester's directory (exception: `UI-NEEDS.md` in `packages/runtime/`). Status
  legend OPEN / ASK / DONE (+ INFO in training/NEEDS). `training/NEEDS.md` additionally holds **node-claim tables**
  ("Claim nodes in `training/NEEDS.md`. Never delete VMs.", HANDOFF) and **data locations** per batch.
- **Contract changes.** Approved additions go to CONTRACT §13; accepted divergences to STATUS "Deviations"; batch
  contract deltas to STATUS. "Do not silently diverge."
- **Batches.** CORE ships numbered batches: 1 (SIM requests 1–5), 2 (model integration, latency, UI requests), 3 (34
  REVIEW findings, summed gate, `transient`; tag `situation-v1`), 4 (fcd1e68: `delivery` trigger, no store-write
  holds, `eventsource`, `untrustedEvents`, budget 2,400), 5 (6e5e86e: REAL's text fixes, SIM's separability facts
  F1–F9, leaf redaction; tag `situation-v2`).
- **Freeze tags.** A change to model-visible text gets a new `situation-vN` tag and regenerated data. Rows carry
  `meta.runtime` (SIM and REAL) so batches can be filtered by format.
- **VM slots** (Mehar): `scripts/vm.sh run <SLOT> '<cmd>'` builds in `~/gcl/<SLOT>` on the `train` VM with
  `rsync -az --delete`; outputs never live under a slot (they go to `/data`). `sim/NEEDS.md` notes that the sync's
  `--exclude '/sim/out/'` deletes the `sim/out` symlink on every sync.

### Git history since 654d822

| commit | author, time (−04:00) | what |
|---|---|---|
| ad24804 | Mehar, 10-07 21:16 | Fix infinite recursion on a `NaN` store value (`util.ts` -> `describe` uses `Object.is`; `test/nan.test.ts`) |
| ce27efd | Mehar, 21:16 | OPEN_TASKS: alpha.1 patch release for the NaN fix |
| 04a264f | Mehar, 21:27 | Demos: frozen-runtime results, hold-reordering investigation, tracing tools |
| fcd1e68 | Mehar, 22:31 | **Runtime batch 4**: decide at the network boundary, never reorder app writes |
| 82db331 | Mehar, 22:39 | OPEN_TASKS: round-1 results and separability findings |
| fcb8189 | Mehar, 22:50 | `realapps/`: real-browser corpus (66 apps, 23 stacks) and deterministic harness |
| 6e5e86e | Mehar, 23:26 | **Runtime batch 5**; tag `situation-v2` |
| bac4409 | Mehar, 23:27 | STATUS: batch 5 perf numbers and never-worse sweep |
| 7dab2b3 | Karan, 23:27 | AGENTS.md, CLAUDE.md, `docs/agents/**` (written against 654d822) |
| f3636b2 | Karan, 23:30 | Default mode `observe`; guard opt-in, heal experimental |
| d73d20c | Mehar, 10-08 00:07 | HANDOFF.md; v2 curriculum port; realapps (+24 apps) and training updates |
| 74f17c0 | Mehar, 00:09 | `docs/runtime/RESULTS.md` (= `origin/runtime`) |
| b435acb | Karan, 00:15 | CI workflow, root lockfile, CLI mode 100755 |
| d53e836 | Mehar, 00:17 | realapps wave 3: "30 more apps (96 total)" |
| d05abc1, 2516a6e | Mehar, 00:19 | npm README rewrite (one-command install); OPEN_TASKS: alpha.1 contents, Polar Parts rollout plan |
| 29b7f28 | Mehar, 00:50 | `test/situation-purity.test.ts`; error pruning moved out of situation building |
| f3a9dd1 | Mehar, 01:12 | **One-command install**: `bin/lib/*` (`init`/`remove`), `src/auto.ts`, `src/cdn/*`, global + CDN builds in `tsup.config.ts`, `test/install/*`, `packages/genclass-runtime`, `CHANGELOG.md`, `INSTALL-NEEDS.md` (its message says "0.1.0-alpha.1", but that number went to our publish) |
| b561244, 6ac4737 | Karan, 01:25–01:26 | agent-doc refresh, honest READMEs, OPEN_TASKS, RELEASE.md |
| 806a296 | Karan, 01:27 | **release commit `0.1.0-alpha.1`** (published ≈ 05:33 UTC as `latest`; tag `v0.1.0-alpha.1`) |
| c16a3b0 | Karan, 01:36 | docs: record the publish (= `mvp-v2` head) |
| eff18cb | Mehar, 01:43 | "v2 data done (10.4M gold, 51.3M unlabeled)"; `vm.sh` keeps the `sim/out` symlink; v2 import/eval scripts (`import_v2.sh`, `prep_v2.py`, `v2_post.sh`, `eval_real.py`, mixes `mix_v2a`, `mix_t150v2`) |
| dabbce2 | Karan, 02:08 | merge `origin/runtime` (eff18cb) into `mvp-v2-merge` |
| 10e5c3b | Karan, 02:09 | lockfile sync after the merge |
| 054da38 | Karan, 02:47 | runtime: observe mode never holds or delays deliveries; background delivery decisions recorded (`test/observe-delivery.test.ts`) |
| f107013 | Karan, 02:47 | runtime: redact F2 diffs and numeric/array secrets under secret containers (`test/redaction-v2.test.ts`) (head) |

Not merged (on `origin/runtime` only): ca08174 (Mehar, 02:02, realapps wave 4), 6d6eb00 (02:31, REAL v2 production
done: 616k gold, 16.6k eval), 416e374 (02:35, RESULTS: first r17-v2a numbers), 5bc40c9 (02:44, runtime batch 6:
model-provided gate thresholds, no-baseline stall fallback; tag `situation-v2.1`).

`git diff --stat 654d822 b435acb`: 451 files, +90,715 / −20,699. Earlier history (13 commits from 7a7ff6d to
654d822, all Mehar's) is legacy GenClass content, the runtime build-up and batch 3 / `situation-v1`.

### Version markers

| marker | value (2026-10-08 ~07:00 UTC) | meaning |
|---|---|---|
| `mvp-v2-merge` | f107013, not pushed | this branch |
| `mvp-v2` | c16a3b0, not pushed | our line before the merge (release commit 806a296 + publish record) |
| `origin/runtime` | 5bc40c9 (this branch merged it at eff18cb) | Mehar's line; HANDOFF says "push to `origin runtime` as you go"; still defaults to `guard` |
| local `runtime` | 74f17c0 | stale local copy |
| `mvp-v2-b6` | 4e95373 = f107013 + merge of 5bc40c9 | separate worktree `GenClass-lib-b6`; not described here |
| `release/runtime-0.1.0-alpha.1` | 806a296 | worktree `GenClass-lib-release` |
| `main`, `origin/main` | 654d822 | not updated since the first alpha |
| `mvp` (local) | b15415b on 654d822 | superseded |
| tag `situation-v1` | → 1a77558 | v1 format; superseded |
| tag `situation-v2` | annotated tag object 75df720 → commit 6e5e86e | **frozen training format of the v2 data and r17-v2a** |
| tag `situation-v2.1` | → 5bc40c9 (not merged here) | batch 6: v2 plus one neutral stall fact |
| tag `v0.1.0-alpha.0` | → 654d822 | the first published alpha |
| tag `v0.1.0-alpha.1` | → 806a296 | published alpha.1 (`latest`); local only, not pushed |
| `packages/runtime/package.json` `version` | `0.1.0-alpha.1` | **already published**: bump before building or packing the next release |
| `packages/genclass-runtime/package.json` | `0.1.0-alpha.1`, dependency `@genclass/runtime` `0.1.0-alpha.1` | unpublished alias (no `genclass-runtime` on npm) |
| `@genclass/runtime-model@0.1.0` | not published (404); `packages/runtime-model/` tracks only `MODEL_CARD.md` | default `model.baseUrl` |
| GitHub release `runtime-model-v0.1.0` | no such tag in the repo; the CLI's default `--from` 404s (per the lead) | |
| v0.1 GenClass model | `https://github.com/MeharPro/GenClass/releases/download/v0.1.0/` | general classifier, **not** a runtime model; used by demos and model tests |
| R17-final1 / R32-final1 | situation-v1; on the `train` VM (`~/gcl/train-out/final1/`) and Mehar's Mac (`packages/runtime-model/files/r17/`, gitignored) | baseline only; does not match the v2 runtime |
| `r17-v2a`, `t150-v2a` | training runs on Azure (see TL;DR); r17-v2a's export is served from c09 by `v2_post.sh`, not published | first v2 student / teacher |

### Status at f107013

| item | state | owner | evidence |
|---|---|---|---|
| Runtime batches 4 and 5 (situation-v2) | done, frozen | CORE | fcd1e68, 6e5e86e; STATUS; `test/delivery.test.ts`, `no-reorder.test.ts`, `content.test.ts` |
| Default mode `observe` | done on `mvp-v2`, this branch and npm `0.1.0-alpha.1` (not on `origin/runtime`, not in `0.1.0-alpha.0`) | us (f3636b2) | `runtime.ts` -> `RuntimeImpl` constructor; `test/default-mode.test.ts`; CONTRACT §13 |
| Observe never holds or delays a delivery; background delivery decisions recorded | done here (054da38); not on npm | us | `runtime.ts` -> `RuntimeImpl.runDelivery`, `deliveryHoldable`, `finalizeDeliveries`; `test/observe-delivery.test.ts` |
| Redaction fixes (F2 diff, numbers/arrays under secret containers) | done here (f107013); not on npm; not mirrored in `rt.py` | us | `state/fields.ts` -> `redactedStringDiff`; `util.ts` -> `isSensitivePath`; `test/redaction-v2.test.ts` |
| `situation()` purity test | done (29b7f28) | CORE | `test/situation-purity.test.ts` |
| One-command install, `/auto`, script tag | merged here (f3a9dd1); not on npm; 11 open review findings | INSTALL | `bin/lib/*`, `src/auto.ts`, `src/cdn/*`, `test/install/*` |
| CI | workflow committed; never run on GitHub | us (b435acb) | `.github/workflows/ci.yml` |
| NaN fix | in code since ad24804; on npm since `0.1.0-alpha.1` | CORE | `util.ts` -> `describe`; `test/nan.test.ts`; `sim/NEEDS.md` g still says OPEN |
| npm `0.1.0-alpha.0` | published (guard default, no model, v1) | lead | tag `v0.1.0-alpha.0` |
| npm `0.1.0-alpha.1` (NaN fix, situation-v2, observe default) | published 2026-10-08, `latest` | karanvir1729 | OPEN_TASKS "Done"; `npm view` |
| SIM v1 phase A / B | done (600,676 / 1,415,344 rows); superseded | SIM | training/NEEDS "SIM → TRAIN: scaled data" |
| Final round 1 (situation-v1) | done: R17 81.9% action / 90.5% diagnosis, guard FIR 0.05%, heal FIR 0.24%, ECE 0.009; guard recall on clear stale/duplicate 7.7% | TRAIN | `training/EVAL.md`, RESULTS §1 |
| T1 runs and v1 teacher `t150-g1` | stopped at the v2 freeze, no results | TRAIN | `training/LOG.md` 01:13–03:35 |
| SIM v2 gold + unlabeled | **done**: 10,423,855 gold, 51,272,078 unlabeled; imported as `sim2`, `sim2e`, `sim2f`, `cur5` | SIM / TRAIN | OPEN_TASKS "Done"; `training/LOG.md` 04:50–05:22 |
| REAL v2 production | `v2b1`–`v2b3` stopped (≈ 380k gold, pre-fix diagnosis labels); `v2c1`–`v2c4` not landed at eff18cb (done per `origin/runtime` 6d6eb00: 616,437 gold, eval set 16,600) | REAL | `training/NEEDS.md` 16 |
| `r17-v2a` | running at eff18cb (ETA ≈ 06:20 UTC); finished per `origin/runtime` 416e374 (numbers in TL;DR) | TRAIN | `training/LOG.md`; RESULTS on `origin/runtime` |
| `t150-v2a` (teacher) | running (ETA ≈ 08:30 UTC); no result recorded | TRAIN | `training/LOG.md` |
| Teacher labels, distillation, DAgger, EVAL | not started | TRAIN | PLAN-v1 P3–P5 |
| Next prerelease with the install (`0.1.0-alpha.2` or a beta with the model) | not started: version bump and install fixes first | user (2FA) | OPEN_TASKS Next 14 |
| `@genclass/runtime-model@0.1.0`, then `@genclass/runtime@0.1.0` | not started | lead / user | HANDOFF "How to continue" step 3 |
| Demos with a trained model | not started (numbers are v0.1 only) | DEMOS | RESULTS §5 |
| Public demo hosting; merge into `main`; Polar Parts rollout | waiting on the user (Polar Parts once the trained model is good: observe first, then guard) | user | OPEN_TASKS "Needs the user" |

## How it works

### 1. What a default install does today

1. The app calls `GenClass.init()`. `index.ts` -> `initUnsafe` reads the kill switch (URL `?genclass=`, else
   `localStorage.genclass`; `off` installs nothing; `observe|guard|heal` override the mode). Otherwise it sets
   `model: {}` and calls `createRuntime`.
2. `RuntimeImpl`'s constructor sets `this._mode = o.mode ?? "observe"`: **observe** unless the app asks for guard.
   (The npm alpha.0 and `origin/runtime` still default to guard.)
3. `createModelHost` gets `baseUrl = DEFAULT_MODEL_BASE_URL`
   (`https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/`) and `preload: "idle"`; status starts `off`.
4. Observers install. Tracing, field versions, baselines, invariants, transition profiles and cadence learning run
   whatever the model state.
5. After `load` + idle, the host fetches `<baseUrl>model.json`; the package does not exist, so status becomes
   `error` and the runtime emits `[GenClass] Model unavailable (<error>); observing only.` (`runtime.ts`, the
   `onStatus` listener in the constructor).
6. From then on `RuntimeImpl.consultable()` is false (true only for `ready` or `off`): `runDelivery` releases every
   response and message at once, `trigger()` runs the passive action without building a situation, writes are never
   observed for decisions. No `Decision`, `Detection` or `ActionRecord` is recorded. `rt.ready` rejects (memoised);
   `ask`/`decide` reject. Nothing retries the load.
7. Before step 5 (status `off`), a salient trigger builds a situation, fails open and starts the load. Since 054da38 a
   delivery is never held then: `RuntimeImpl.deliveryHoldable` is false in observe mode, while paused, while the model
   is not `ready`, when no non-passive delivery action is permitted, or when the model is too slow for the hold
   budget, so `runDelivery` releases it synchronously before any body read and decides in the background (DL-3, DL-4
   fixed; in npm alpha.1 a salient delivery could still wait up to `BODY_WAIT_MS`, 100 ms).

Even with a model, `observe` takes no action: decisions are made in the background and reported
(`test/default-mode.test.ts`), including delivery decisions (`executed: false`; `test/observe-delivery.test.ts`). The only way to see decisions today is to self-host a model: no model matches
situation-v2, the v0.1 model only exercises the pipeline (`npx genclass-runtime fetch-model <dir> --from
https://github.com/MeharPro/GenClass/releases/download/v0.1.0/`; a model download, so ask the user first).

### 1b. What the merged install paths do (not on npm yet)

- `import "@genclass/runtime/auto"` (`src/auto.ts`) calls `src/cdn/auto-start.ts` -> `startAuto()` with no defaults:
  it merges `<meta name="genclass">` (`src/cdn/config.ts` -> `readMetaConfig`) and `window.GENCLASS_CONFIG`
  (`readWindowConfig`), calls `GenClass.init`, and mounts the devtools when the page config asks. So `/auto` runs
  **observe** on this branch (the runtime default); `/auto/guard` and `/auto/heal` pass `{ mode }`
  (`src/cdn/auto-guard.ts`, `auto-heal.ts`). Outside a browser it returns `GenClass.init()`'s inert runtime.
- The script tag `dist/genclass.global.min.js` (`src/cdn/global.ts` -> `install`) initialises from its data
  attributes, the meta tag and `window.GENCLASS_CONFIG`, exposes `window.GenClass`, and loads the model worker
  (`dist/cdn/worker.js`, from a Blob URL), onnxruntime-web (`dist/cdn/ort-*.js`) and the devtools on demand from
  `assetBase()`, which pins jsDelivr/unpkg URLs to the version baked in at build time.
- `npx @genclass/runtime init` (`bin/lib/init.mjs` -> `init`, `bin/lib/detect.mjs` -> `detectProject`,
  `bin/lib/plan.mjs` -> `planInit`) detects the framework, installs `@genclass/runtime@^<own version>` (or `--from`),
  adds one import marked `// genclass:init` (plus a dev-only devtools line) or a script tag for plain HTML, shows the
  diff and asks first. `remove` (`bin/lib/init.mjs` -> `remove`, `bin/lib/edit.mjs` -> `removeMarked`) deletes the
  marked lines and files and uninstalls the package when its scan finds no other use. The CLI's mode mapping still
  assumes the old guard default: see [Install code review](#install-code-review-2026-10-08).

### 2. How a request moves between workstreams

1. The requester writes a NEEDS item with evidence and a status (OPEN or ASK), addressed to an owner.
2. The lead relays it (contract changes: approve into CONTRACT §13, or reject).
3. The owner lands it in a batch and records it (CORE: STATUS batch section with "Contract deltas"; deviations).
4. The requester verifies it and flips the item to DONE. This step is often skipped (sim/NEEDS g, UI-NEEDS 1/3,
   demos/NEEDS §1/§2/§6 are implemented but not flipped; see Drift).
5. If the change alters situation text: new freeze tag, SIM and REAL regenerate, TRAIN mirrors `rt.py` and retrains.

### 3. How a runtime change reaches the shipped model (situation-v2 pipeline)

1. CORE changes `packages/runtime/src/situation/*` (or other model-visible text: `util.ts` formatting and
   redaction, fact/question/action wording, op/event names) and the lead tags it (`situation-v2` = 6e5e86e).
2. **SIM** drives that exact runtime in a deterministic virtual world (`sim/src/run/rt.ts` -> `realRuntimeFactory`,
   pinned to `mode: "heal"` in `createOptions`, so the observe default does not affect SIM data): gold rows
   (counterfactual costs, S1 diagnosis relabelling, S2 re-drawn latents), unlabeled rows (every decision point of a
   base run) and, later, on-policy rows. Details: [sim.md](sim.md).
3. **REAL** bundles the runtime from source at a pinned tag into real apps in headless Chromium and labels with the
   sim's cost weights: [realapps.md](realapps.md).
4. **TRAIN** mirrors the wording in `training/curriculum/rt.py` (ported to situation-v2 in d73d20c), imports
   SIM/REAL rows, trains the T150 teacher on gold, soft-labels unlabeled rows (`label_teacher.py`,
   `label_cluster.sh`), distils R17/R32 (`launch_student.sh`), runs DAgger rounds, evaluates
   (`eval_sim.sh`, `eval_runtime.py`, `final_post.sh`), calibrates on dev and exports q8/fp16
   (`export_runtime.py`, `ortweb/validate.mjs`). Details: [training.md](training.md).
5. **MODEL** checks TS packer/engine parity against the export's `parity.json`.
6. The lead publishes `@genclass/runtime-model@0.1.0` (jsDelivr serves `files/`) and a GitHub release
   `runtime-model-v0.1.0`, the demos are rerun, then `@genclass/runtime@0.1.0` is published (owner's 2FA).

### 4. Where the v2 data and compute are now

- **Cluster** (HANDOFF "Rules"): `rg-jev-train`, eastus, quota 2,048 vCPU; nodes c01–c23 (F80 variants; c12–c23 added
  2026-10-08 by `training/cluster_expand.sh`) plus `train` (1 TB `/data` disk, bundle server) and `data`. **The
  nightly auto-shutdown schedules are disabled** for the training push and must be re-enabled when it ends.
- **Claims** (training/NEEDS "Cluster expansion and claims", at eff18cb): SIM's 20 v2 nodes are done and were
  deallocated; TRAIN holds c02 (v2 workbench, from 05:05 UTC), c03–c09 + c13 (`r17-v2a`, ≈ 1.5 h) and c12 + c14–c23
  (`t150-v2a`, ≈ 5 h); REAL runs `v2c1`..`v2c4` on c01, c10, c11 and `data`.
- **Data locations:** SIM `train:/data/sim-out/v2-gold/` (10,423,855 rows: train 7,560,367 / dev 317,732 / test
  2,545,756) and `train:/data/sim-out/v2-unl/` (51,272,078 rows); on c02 (`training/import_v2.sh`,
  `training/prep_v2.py`): 128 train shards `data/s3/sim2`, eval sets `sim2e` (20k held-out test + 8k dev) and `sim2f`
  (18,690 held-out-feature rows), curriculum replay `cur5` (300k rows), a 27 GB tar served from c02:8799. REAL
  `v2c*` into `train:/data/real-out/` when they land (the eval set `v2-eval` is built from them). All from
  `training/NEEDS.md`, `training/LOG.md` and `OPEN_TASKS.md`; not checkable from here.
- **What runs unattended:** `training/v2_post.sh` on c09 waits for `models/r17-v2a/meta.json` to say `final`, then runs
  `eval_sim.sh` on `sim2e` and `sim2f`, `eval_gain.py`, `export_runtime.py` with the `sim2e` calibration, and serves
  the export tar on :8801 (arguments: run, export name, version; the script's own example is
  `r17-v2a genclass-runtime-r17 2.0.0-rc1`). Nothing publishes it.
- **Spend:** ≈ $440 to date, ≈ $110/h while 20 TRAIN nodes run (`training/LOG.md` 05:22); PLAN-v1 estimates $3–4k
  for P0–P5. The auto-shutdown schedules are still disabled (OPEN_TASKS "Needs the user").

## Configuration and constants

Status-relevant values only; the subsystem docs list the rest.

| name | value at f107013 | defined in | effect |
|---|---|---|---|
| default mode | `"observe"` | `runtime.ts` -> `RuntimeImpl` constructor (`o.mode ?? "observe"`) | no actions unless `mode: "guard"`/`"heal"`, `?genclass=guard`, or `setMode` |
| test-harness mode | `"guard"` | `test/helpers.ts` -> `setup` | CORE tests exercise interventions; `setup({ mode: undefined })` gives the product default |
| `DEFAULT_MODEL_BASE_URL` | `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/` | `model/host.ts` | unpublished → status `error`, observe only |
| `DEFAULT_FROM` | `https://github.com/daybot-solutions-inc/GenClass-lib/releases/download/runtime-model-v0.1.0/` | `bin/genclass-runtime.mjs` | `fetch-model` default source; 404 |
| `STATE_CHAR_BUDGET` | 2400 (was 3200 in v1) | `situation/serialize.ts` | full situation budget (≈ 1,000 tokens at the measured 2.4 chars/token) |
| `COMPACT_BUDGET` / `COMPACT_QUESTIONS_BUDGET` | 1100 / 1400 | `situation/serialize.ts` / `situation/questions.ts` | section-limit floor / bare-label questions |
| auto situation budget | webgpu and unknown device 2,400; wasm `1000 + round((threads − 1) × 1000 / 3)`, threads clamped 1–4; × `budgetScale` (× 0.8 per `max_tokens_exceeded`, floor 0.5) | `RuntimeImpl.situationBudget` | device sizing; a numeric `situation.budget` wins |
| SIM budget sampling | `[[3200, 40], [2000, 30], [1000, 30]]` | `sim/src/world/scenario.ts` (`budget`) | **still v1** (finding SIT-2); `rt.py` `BUDGETS` uses 2400/2000/1667/1333/1000 |
| `policy.holdWrites` | `false` | `decide/policy.ts` -> `policyConfig`; `state/hub.ts` -> `StoreHub.holdWrites` | store writes apply at once; opt-in holds never reorder a store's writes |
| `policy.thresholds` | report 0.6, guard 0.9, heal 0.8 | `decide/policy.ts` -> `policyConfig` | summed-mass gate + `requireDiagnosis` |
| hold budget | "auto" = clamp(1.5 × median latency, `HOLD_MIN_MS` 150, `HOLD_MAX_MS` 800), `HOLD_FALLBACK_MS` 300 | `decide/policy.ts` | a trigger holds only if `expectedLatency() <= holdBudgetMs()` |
| `BODY_WAIT_MS` | 100 | `runtime.ts` | a salient delivery that can be held waits this long for its body clone. One that cannot (`RuntimeImpl.deliveryHoldable` false: always in observe) is released first; an in-memory body (XHR, WebSocket, EventSource) is analysed at once, a fetch body at most until this wait ends or the chain's first write (`RuntimeImpl.finalizeDeliveries`) |
| `DISCARD_MARK_MS` | 10,000 | `runtime.ts` | a delivery `discard` keeps dropping the chain's writes over newer data this long |
| `LONG_RUNNING_MS` | 10,000 | `runtime.ts` (`waitOps`) | a delivery `defer` waits at most this per defer (≤ 2 defers) |
| `BACKGROUND_DEADLINE_MS` | 5,000 | `runtime.ts` | non-held decisions |
| `LATE_REVERT_MS` | 2,000 | `runtime.ts` | late `discard` window |
| `PROVIDER_TIMEOUT_MS` | 10,000 | `decide/decider.ts` | runtime-side provider abandonment |
| `observe.untrustedEvents` | `false` | `runtime.ts` -> `installObservers`; `observe/dom-user.ts` | synthetic DOM events are not user actions unless enabled |
| `NOT_PROCESSED` | `502, 503, 429, 408` | `situation/evidence.ts` | statuses called "usually returned without processing the request" (finding SIT-11) |
| runtime `dependencies` | `onnxruntime-web` only; optional peers react, redux, zustand | `packages/runtime/package.json` | CONTRACT §0 rule 6 |
| CI Node | 22 (`engines.node` `>=20`) | `.github/workflows/ci.yml`, `package.json` | |
| kill switch | `genclass=off\|observe\|guard\|heal` (URL wins over `localStorage`) | `index.ts` -> `killSwitch` | rule GenClass out while debugging |
| package `version` | `0.1.0-alpha.1` (already on npm) | `packages/runtime/package.json` | baked into the global build (`tsup.config.ts` -> `globalBuild`, `__GENCLASS_VERSION__`), `src/cdn/global.ts` -> `assetBase`, and the CLI's install spec and default script tag (`bin/lib/init.mjs` -> `installSpec`, `bin/lib/plan.mjs` -> `scriptTag`) |
| subpath exports | `.`, `./auto`, `./auto/observe`, `./auto/guard`, `./auto/heal`, `./react`, `./redux`, `./zustand`, `./devtools`, `./worker` (only through `exports`; no `typesVersions`) | `packages/runtime/package.json` | `./auto*` are new since alpha.1 |
| `sideEffects` | `./dist/auto.js`, `./dist/auto/*.js`, `./dist/genclass.global.js`, `./dist/genclass.global.min.js`, `./dist/cdn/*.js`, `./src/model/worker.ts` (alpha.1 on npm: `false`) | `packages/runtime/package.json` | keeps `import "@genclass/runtime/auto"`; the src entry keeps the model loop in `dist/cdn/worker.js`; `./dist/worker.js` is missing (install finding) |
| `init` mode mapping | no mode and `guard` both write `@genclass/runtime/auto`; `observe`/`heal` write `/auto/<mode>`; the script tag gets `data-mode` only for non-guard modes | `bin/lib/plan.mjs` -> `AUTO`, `scriptTag` | wrong after the merge: `/auto` runs observe (install finding 1) |
| CLI markers | `genclass:init` (line, or `start`/`end` block), `genclass:inline` | `bin/lib/edit.mjs` -> `MARK`, `MARK_INLINE`, `removeMarked` | what `remove` deletes |

## Invariants and gotchas

### Ground rules (binding; CONTRACT §0, §0.5 and §13, restated for mvp-v2)

CONTRACT: "If something here is wrong, tell the lead; do not silently diverge." For us, the lead is the user.

1. **No hardcoded bugs, patterns or recoveries in the runtime (§0 rule 1).** Generic facts and triage only; the model
   chooses diagnoses and actions. *In code:* triage is `facts.every((f) => f.neutral)` in `RuntimeImpl.trigger`
   (plus delivery salience in `RuntimeImpl.runDelivery`: newer-data and pending-change conflicts, F2 typed text,
   F3 unchanged bodies); actions are chosen only by `decide/policy.ts` -> `gate`; `situation/build.ts` ->
   `builtinApplicable` only says whether an action *can* run. Model unavailable → observe only, passive action.
2. **Train/runtime parity, frozen at situation-v2 (§0 rule 2).** One implementation of situation building:
   `packages/runtime/src/situation/*`. SIM drives it, REAL bundles it, `training/curriculum/rt.py` ports it. **Any
   change to model-visible text** (situation code, fact/question/action/diagnosis wording, `util.ts` formatting and
   redaction, op/event names) needs a new tag, regenerated SIM and REAL data, an `rt.py` mirror and retraining.
   Training runs on v2 data right now: never make such a change without the user's go-ahead. On this branch f107013
   already changed the text of redacted values (no new tag; `rt.py` not mirrored; see Gotchas).
   Behaviour-only runtime fixes (most delivery findings) do not change wording but do change SIM/REAL dynamics and
   therefore labels: coordinate them too.
3. **Determinism (§0 rule 3).** No `Math.random`, `Date.now`, `performance.now` or global `setTimeout` in runtime
   code; the injected `Clock`; ids from counters. Re-checked at b435acb and again at f107013 (the new `src/cdn/*` and
   `src/auto.ts` add none): the only hits are `model/engine.ts`
   (default `now = performance.now()`, timing only), `model/host.ts` (`requestIdleCallback` for preload) and
   `clock.ts` itself (`browserClock`). The devtools capture `requestAnimationFrame`/`setTimeout` at module load.
4. **Honest evaluation (§0 rule 4).** `demos/` is never read or modelled by `sim/` or `realapps/`; demos are never
   tuned.
5. **Where to run things (§0 rule 5, superseded for us).** CONTRACT and HANDOFF say the Mac only edits files and every
   build/test runs on the `train` VM: that is Mehar's 8 GB Mac. **Our run policy (2026-10-08):** light local checks
   (`npm install`/`npm ci`, `tsc`, `tsup`, vitest unit tests) are fine on this machine. **Ask the user first** before
   Playwright, `test/smoke/smoke.sh`, the sim generator, training, realapps runs, the demos' eval, model downloads,
   anything on Azure, `git push`, `npm publish`. See [../../AGENTS.md](../../AGENTS.md) §4.
6. **Language and dependencies (§0 rule 6).** TypeScript strict, ESM only; `onnxruntime-web` is the only runtime
   dependency; ask before adding one. Keep the root `package-lock.json` in sync (CI uses `npm ci`).
7. **Do not edit legacy content (§1):** `jev_local/`, `extension/`, `bench/`, `results/`, `tests/`, legacy `docs/*.md`,
   `docs/benchmax-research/`, legacy `scripts/`. Not covered: `docs/runtime/`, `docs/agents/`, `scripts/vm.sh`.
8. **REVIEW tests are a contract.** Never edit `test/review-*.test.ts` to make them pass.
9. **Licensing (HANDOFF):** train only from v1 `jev-local-fast` or MIT ettin bases plus synthetic/sim/realapps data;
   never v2/Z/S checkpoints or benchmark datasets.

**Product principles (§0.5, binding).** Claim: *install one library; find and prevent runtime failures automatically,
with low false positives.* (1) False positives: since f3636b2 / CONTRACT §13 the **default mode is `observe`** (reports
only); `guard` is opt-in (minimal guard-tier actions at summed probability ≥ 0.9 with a non-`expected` diagnosis);
`heal` is experimental; FIR on clean runs is a first-class metric. (2) Performance: facts always on and cheap, the
model only for salient situations, in a worker. (3) Observability: one console line per detection/intervention,
`explain(id)`, undo, `x-genclass` marks, kill switch. Product principle from HANDOFF: "never make a correct app worse".

### Gotchas

- **Code wins over every doc.** CONTRACT.md does not describe batch 4/5 (no `delivery` trigger); the deltas live in
  STATUS "Contract deltas". HANDOFF still says guard is the default.
- **Two defaults in the wild.** This branch, `mvp-v2` and npm alpha.1 (`latest`) default to `observe`;
  `origin/runtime` (still `o.mode ?? "guard"` at 5bc40c9) and npm alpha.0 default to `guard`. The tests' `setup()`
  defaults to `guard` on purpose. Mehar's install CLI was written against the guard default, so on this branch it
  maps `--mode guard` to the observe entry (install finding 1): never trust `init`'s "Mode" line here.
- **Observe and execution.** Since 054da38 observe never holds or delays a delivery and XHR listeners run inside the
  original dispatch (`test/observe-delivery.test.ts`); npm alpha.1 still has DL-3 (up to 100 ms body wait). In guard
  or heal mode, a delivery that cannot be held is now also released before its body is read.
- **The freeze has one deliberate exception.** f107013 changed model-visible text for redacted values, so
  `git diff situation-v2 HEAD -- packages/runtime/src/situation packages/runtime/src/state/fields.ts
  packages/runtime/src/util.ts` is not empty. Any further change needs the user's go-ahead (ground rule 2).
- **The package version is already taken.** `packages/runtime/package.json` says `0.1.0-alpha.1`, which is on npm
  without the install paths. Building or packing this tree before a bump makes the global build, the CLI's install
  spec and its default script tag point at the published alpha.1 (no `./auto`, no `dist/cdn/`, no global build).
- **The install evidence predates the merge.** `test/install/RESULTS.md` (real frameworks, VM) was recorded against a
  tarball versioned `0.1.0-alpha.0` built from Mehar's tree, which defaulted to guard; locally only
  `test/install/cli.test.ts` runs (fixture projects, `--no-install`), and it has no case for `--mode guard` or the
  default mode.
- **R17-final1 is a v1 model.** Do not load it into this runtime, ship it, or compare v2 numbers against it as if the
  formats matched.
- **Tests are not type-checked.** `packages/runtime/tsconfig.json` includes only `src`.
- **Test counts differ by branch.** HANDOFF says 346 tests, STATUS 42 files / 348 tests (origin/runtime at 29b7f28, on
  the VM with a model dir). On `mvp-v2`: 42 files, 350 tests. On this branch: 46 files, 393 tests (adds
  `default-mode`, `situation-purity`, `install/cli`, `observe-delivery`, `redaction-v2`); without a model dir 14
  model-parity tests skip. `review-perf` can flake in a parallel run (5.5 ms vs its 2 ms bound once); run it alone.
- **The shipped default path is untested.** No test references `DEFAULT_MODEL_BASE_URL` or "observing only"; the smoke
  test uses `model: false`.
- **`demos/src/server/data/cities.ts` is not in git** (root `.gitignore` rule `data/`), so a fresh clone cannot build
  or typecheck the demos, and root `npm run typecheck` (all workspaces) fails. CI typechecks only `@genclass/runtime`.
- **v1 artefacts look current.** `training/NEEDS.md` "SIM → TRAIN: scaled data" says "Runtime tag `situation-v1`"
  for the v1 batches; realapps batch manifests hardcode `situation-v1` even for v2 batches (finding RA-8). Filter on
  `meta.runtime` in the rows, not on manifests.
- **`docs/CONTRACT.md` is not the runtime contract** (`docs/runtime/CONTRACT.md` is).
- **Demo numbers measure the harness, not the product** (v0.1 model; RESULTS §5).
- **Time zones.** Commit times are −04:00; HANDOFF, LOG and NEEDS use UTC.

## How to change it safely

**Record status after landing a runtime change (CORE role)**
1. Update `packages/runtime/STATUS.md` ("Updated:" line, State, a batch section with "Contract deltas", Deviations,
   Open issues) and `docs/runtime/API.md` / `types.ts` JSDoc if the public surface changed.
2. Move the item in `OPEN_TASKS.md`, update `HANDOFF.md` "Current state" if it changes the picture, and add results
   to `docs/runtime/RESULTS.md` with FIR next to recall.
3. Ask the requester to flip its NEEDS item to DONE; do not rewrite another workstream's items.

**Fix a review finding**
1. Classify it first: (a) runtime model-visible text (needs a new freeze tag, regenerated data and an `rt.py`
   mirror: SIT-1, SIT-3, SIT-8, SIT-10, SIT-11); (b) runtime behaviour (DL-*: wording unchanged but SIM/REAL dynamics
   and therefore labels change); (c) curriculum port only (`rt.py`/`scenarios.py`: SIT-4…SIT-7, SIT-9, SIT-12,
   SIT-13; no v2 curriculum set exists yet, per [training.md](training.md)); (d) data/infra scripts (SIT-2, ST-*,
   RA-*), which affect the live Azure runs; (e) docs (PD-*, SIT-14).
2. For (a)–(c), get the user's go-ahead and agree with Mehar whether it lands before or after the next
   training round (the v2 data is finished; r17-v2a and t150-v2a trained on it). For (d), edit freely (docs owned by the right workstream).
3. Add the regression test the finding suggests, in a new or existing non-review test file.

**Change anything the model reads (after `situation-v2`)**
1. Get the user's go-ahead (it makes the finished v2 data and the models trained on it mismatch the runtime).
2. Change only `src/situation/*` plus `util.ts` helpers if needed; update STATUS example situations.
3. Tell SIM, REAL (regenerate) and TRAIN (`rt.py` mirror; per-header calibration keyed on exact instruction text,
   training/NEEDS 5). Expect a new tag (`origin/runtime` already has `situation-v2.1`).
4. Run the light checks locally (commands in [runtime/build-test-release.md](runtime/build-test-release.md)).

**Fix doc drift**
1. Confirm the behaviour in code first; code wins.
2. Edit the doc owned by the right workstream (CONTRACT: lead; STATUS/API: CORE; NEEDS: requester).
3. JSDoc in `types.ts` is safe; `BUILTIN_ACTIONS` descriptions and `DEFAULT_DIAGNOSES` are model input (frozen).

**Prepare the next release (with the install paths)**
1. Fix install findings 1, 2 and 4 at least (and decide on 3, 5, 6); add the missing `cli.test.ts` cases.
2. Bump `packages/runtime/package.json` (and `packages/genclass-runtime/package.json` if the alias ships) to
   `0.1.0-alpha.2` or the planned beta; move the CHANGELOG bullets; run `npm install` so the root lockfile follows.
3. Merge or rebase onto the newer `origin/runtime` if it should ship (batch 6, `situation-v2.1`).
4. Run the light checks, then (ask first) `test/smoke/smoke.sh` and `npm pack`; the user publishes with 2FA
   ([RELEASE.md](../../RELEASE.md) has no part for this version yet).

**Run checks** (local, per our run policy)
- `npm ci` at the root; in `packages/runtime`: `npx tsc -p tsconfig.json --noEmit`, `npx tsup`,
  `NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts`, then
  `NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts`.
- Sim: `npm run build` at the root, then in `sim/` `SIM_RUNTIME=real npx vitest run` (19 tests, 5 files).
- Ask first: `bash test/smoke/smoke.sh`, Playwright, realapps, demos eval, Python/training.

## Tests

| test file | what it asserts (status-relevant) |
|---|---|
| `test/default-mode.test.ts` | no `mode` → `observe` (`createRuntime` and `GenClass.init`); `?genclass=guard` / `mode: "guard"` opt in; never holds writes or requests even when the model is sure; findings still reported |
| `test/delivery.test.ts` | typeahead zero calls; stale out-of-order response → `discard` drops only the newer-data field; holding is only latency; no hold when the model cannot answer in time; WebSocket order; EventSource; XHR holds and `abort()`; salience rules |
| `test/no-reorder.test.ts` | realworld's promise middleware through `genclassEnhancer` with an always-passive model: guard/heal give the same dispatches and final state as observe |
| `test/content.test.ts` | F1, F2 (diff preview), F3, F5, F6, F7, F8, F9, read-your-writes |
| `test/atoms.test.ts` | runs with `holdWrites: true`: a user write never overtakes an earlier held write; read-your-writes |
| `test/nan.test.ts` | a `NaN` store value no longer recurses forever |
| `test/observe-delivery.test.ts` (11, 054da38) | observe: a conflicting fetch with a slow body resolves at network time and its background decision is recorded (`executed: false`) and reported, its writes not decided again; decided on the state it was delivered into; decided at the chain's first write if the body is late; F1 not lost; delivery standing questions answered; XHR listeners inside the original dispatch (`currentTarget` set); WebSocket/EventSource delivered synchronously and still decided; guard unchanged (held stale response discarded; a too-slow model releases at once and the write is late-reverted on its own) |
| `test/redaction-v2.test.ts` (10, f107013) | F2 on a secret field shows `[redacted]` on both sides (default and custom redactor); an unredacted field keeps its diff preview; `redactedStringDiff`; numbers, bigints and arrays under strong secret containers redacted; booleans/null visible; broad containers unchanged |
| `test/situation-purity.test.ts` (2, 29b7f28) | building situations for every trigger, in every context, changes no counter or later id; polling like the devtools overlay changes no decision, hold or id |
| `test/install/cli.test.ts` (20, f3a9dd1) | `init`/`remove` on fixture projects (Vite, Next 14/15/16, SvelteKit, Nuxt 3/4, Astro, Angular, CRA, Remix, React Router, webpack, plain HTML) with `--no-install`: edits, idempotence, byte-identical `remove`; edit helpers; page-config parsing; `assetBase`. Only `--mode observe` is covered: no case for `--mode guard` or the default |
| `test/review-*.test.ts` (10) | REVIEW's batch-3 findings; must pass unchanged. `review-perf` times 5,000-item stores (run alone; CI retries it twice) |
| `test/batch3.test.ts`, `budget.test.ts`, `situation.test.ts`, `policy.test.ts`, `smoke.test.ts` | redaction by meaning, section limits and auto budgets (2,400 on WebGPU), one situation per trigger, the §8 gate, smoke paths (explicit `mode: "guard"`) |
| `test/model/*.test.ts` | 14 model-parity tests skip without `GENCLASS_MODEL_DIR` |
| `test/smoke/smoke.sh` | packed tarball in a Vite app in headless Chromium with `model: false` (ask before running) |
| `sim` (`SIM_RUNTIME=real npx vitest run`) | 19 tests, 5 files, against the built runtime |
| `training/tests/test_curriculum.py` | the v2 curriculum test (passes per the situation reviewer; not run by the lead) |

Not run by us: Playwright specs, `smoke.sh`, the install suite (`test/install/run-all.sh`: scaffolds, frameworks,
`cdn-check.mjs`), realapps sweeps, demos eval, Python tests, training. `realapps/` has no
tests at all.

## Drift and open issues

### Open work (aligned with HANDOFF, OPEN_TASKS and the release recipe)

| owner | item | state |
|---|---|---|
| SIM (Mehar) | v2 gold and unlabeled | **done** (10,423,855 / 51,272,078); budget skew (SIT-2) and unlabeled `expected` labels (ST-1) are in it |
| REAL (Mehar) | `v2c1`–`v2c4` (fixed labels) into `train:/data/real-out/`, eval set `v2-eval` | not landed at eff18cb; done per `origin/runtime` 6d6eb00 (not merged) |
| TRAIN (Mehar) | `r17-v2a` (R17 on v2 gold) → `v2_post.sh` eval/export; `t150-v2a` teacher, then a continuation with REAL `v2c*` gold | running at eff18cb (r17-v2a done per `origin/runtime` 416e374; t150-v2a ETA ≈ 08:30 UTC) |
| TRAIN | teacher eval as the separation gate (P2), soft-label unlabeled rows (P3; `label_cluster.sh` cannot read gz shards, ST-2/ST-3), distil R17/R32 (P4), DAgger ×3 (P5), EVAL per trigger/budget/held-out set, data-derived gate thresholds (batch 6 on `origin/runtime`), export, parity | not started. v2 import uses `import_v2.sh` / `prep_v2.py` (ST-8 concerned `import_final.sh`); `v2_post.sh` evaluates on `sim2e`/`sim2f` instead of the v1-wired `final_post.sh` (ST-4) |
| lead / user | `@genclass/runtime-model@0.1.0` + GitHub release `runtime-model-v0.1.0`; rerun demos; `@genclass/runtime@0.1.0` without the alpha tag | after EVAL |
| user | publish `0.1.0-alpha.1` (cut from `mvp-v2`, 806a296) | done 2026-10-08 (`latest`) |
| INSTALL / us | fix the install findings (at least 1, 2 and 4 of [Install code review](#install-code-review-2026-10-08)), bump to `0.1.0-alpha.2` (or the planned beta), move the CHANGELOG bullets, resolve the `npx genclass-runtime` naming question (`INSTALL-NEEDS.md`), `npm pack` smoke test | open; before the next release |
| user | publish the next prerelease (2FA) | after the above |
| us | merge `origin/runtime` 5bc40c9 (batch 6, `situation-v2.1`, r17-v2a results, REAL v2 done; conflict only in `STATUS.md`), or adopt `mvp-v2-b6` | open |
| CORE | a STATUS entry for 054da38 (observe deliveries); `rt.py` follow-up for f107013 (no redactor in the curriculum) | open |
| user | push `mvp-v2` / `mvp-v2-merge` (first CI run; add the branch to the CI triggers or open a PR), merge into `runtime`/`main`; public demo hosting | waiting |
| Mehar / user | re-enable the Azure auto-shutdown schedules when the push ends; deallocate idle nodes | open |
| CORE | review findings DL-1, DL-2, DL-5…DL-9, DL-11, DL-12, DL-10 outside observe (behaviour) and SIT-8, SIT-10, SIT-11 (model-visible text) | open (SIT-1, SIT-3, DL-3, DL-4 fixed here); see [How to change it safely](#how-to-change-it-safely) |
| SIM / REAL | SIT-2 (budget weights), ST-1, ST-6, ST-9…ST-11, RA-1…RA-12 | open |
| TRAIN | `rt.py` parity SIT-4…SIT-7, SIT-9, SIT-12, SIT-13; scripts ST-2…ST-5, ST-7, ST-8 | open |
| CORE | `retry` still offered for non-idempotent POSTs (heal tier; `builtinApplicable` checks only `replayable && attempt < 4 && fetch`) | open (demos/NEEDS §5); SIT-11 makes it worse for 502 |
| CORE | `rollback` description ("last consistent snapshot") vs chain revert; unreachable fact "This write could not be held: …" (`StoreHub.propose` commits unholdable writes without observing them) | open; the first is model input |
| CORE / lead | a test for the shipped default path (model 404 → `error` → observe only) | none exists |
| MODEL | device-based model selection in the host card | not started |
| UI | overlay ignores `Explanation.message` (`devtools/index.ts` has no `.message` use) | open |
| DEMOS | rerun with the trained v2 model (Off/Observe/Guard/Heal, clean-run FIR); commit `cities.ts`; pass `untrustedEvents` for the synthetic driver (DL-11) | open |
| docs | HANDOFF default mode, CONTRACT v2 deltas and redaction rule, ARCHITECTURE budget, stale NEEDS items (SIT-14), CHANGELOG alpha.1 section, INSTALL-README-SNIPPET default, a RELEASE.md part for alpha.2 (table below) | open |

### Decisions waiting on the user / repo owner

1. ~~`0.1.0-alpha.1`: publish (2FA) and from which tree.~~ Done 2026-10-08 from `mvp-v2` (806a296), dist-tag `latest`.
2. Push `mvp-v2` / `mvp-v2-merge`, merge into `runtime` and `main` (`main` is still 654d822; the old "looks merged"
   note no longer holds). The default mode differs between `origin/runtime` (guard) and our line (observe): pick one
   before `0.1.0` (OPEN_TASKS "Needs the user").
3. Public demo hosting (GitHub Pages).
4. Which review fixes land before the next training round (the v2 SIM data is finished: SIT-2 and ST-1 are in it;
   DL-2 shapes counterfactual costs), and whether text-changing fixes (f107013 already, SIT-8, SIT-10, SIT-11) justify
   a new tag after `situation-v2.1`.
6. The next prerelease: `0.1.0-alpha.2` with the install paths now, or a beta together with the validated v2 model
   (`OPEN_TASKS.md` Next 14); and whether to publish the unscoped `genclass-runtime` alias (`INSTALL-NEEDS.md`).
7. Polar Parts rollout (`MeharPro/Polar-Parts`; user OK'd once the trained model is good): observe on a branch first,
   then guard. Note that `init --mode guard` currently installs observe (install finding 1).
5. Shipping models: R17 default on every device (RESULTS §2 decision for v1); R32 for WebGPU only if clearly better.

### Known risks

- **The finished v2 data carries known defects.** SIM sampled budget 3,200 for ~40% of trajectories (SIT-2);
  unlabeled rows keep `expected` labels that S1 would flip (ST-1, fixable by a relabel pass before teacher labelling);
  delivery-discard semantics under review (DL-1, DL-2) shaped the counterfactual costs. r17-v2a and t150-v2a train on
  it as is. The data also predates f107013 (redacted values) and 054da38 (observe deliveries; SIM pins heal).
- **The teacher may not separate the cases.** PLAN-v1: if T150 is also near 40% argmax on clear rows, the bottleneck
  is the situation information, not model size. v1 → v2 separability improved but is far from solved (RESULTS §3:
  linear recall at 1% FIR 6% → 11% on failure, 11% → 15% on request).
- **Targets not met by any model yet:** diagnosis ≥ 95% (v1: 90.5%; r17-v2a 84.4% on `sim2e`, per `origin/runtime`)
  and clear-case recall ≥ 80% (v1: 7.7% guard on clear stale/duplicate; r17-v2a heal 6.8% at the shipping gates).
  Guard FIR ≤ 0.1% and ECE ≤ 0.02 were met in v1; r17-v2a guard FIR 0.00%.
- **Curriculum ≠ runtime.** `rt.py` is called runtime-exact but diverges on several common cases (SIT-4…SIT-7,
  SIT-9, SIT-12, SIT-13).
- **Never-worse evidence is narrower than claimed.** The 0/396 sweep compares final visible text and server content
  only, covers 66 of the 128 app directories now in the tree, and never compares observe against no runtime (RA-1,
  RA-6, RA-10; `docs/runtime/RESULTS.md` on `origin/runtime` reports a newer interference run, 0/256, not merged). Under chaos, 3/198
  runs changed from request-time holds (RESULTS §4).
- **Single-thread WASM speed**: R17 ≈ 177 / 323 / 589 ms at 500 / 780 / 1,170 tokens (RESULTS §2); hold budgets cap at
  800 ms, so slow devices fail open more.
- **Label noise**: costs come from K = 3 sampled futures; S2 re-draws unobservable latents but not for impatient
  re-clicks (ST-6).
- **Cost and operations**: auto-shutdown disabled; label/eval scripts can mark work done after failures (ST-2, ST-4);
  a crashed Chromium drains a REAL worker's queue (RA-2).
- **npm alphas**: `latest` (alpha.1) is fine for observing, but still has the F2 leak and the numeric-secret
  regression (fixed only here, f107013), DL-3's body wait, and no install paths. Anyone who pins `0.1.0-alpha.0` gets
  the guard default, v1 situations and the NaN crash.
- **Install defects ship with the next release unless fixed first**: a silent guard→observe downgrade, stale version
  pins, `remove` breaking formatted code, TypeScript `node` resolution failures (see the install table).
- **Privacy**: fixed on this branch (SIT-1, SIT-3); remaining known gaps: a container named by a secret word pair
  (`cardNumber`, `apiKey`) counts as broad, so values under it are still shown, and "is back to [redacted]" compares
  rendered text (STATUS "Fix after 0.1.0-alpha.1"). The script-tag build reads page config from any
  `<meta name="genclass">` in the document (install finding 10).

### Review of the situation-v2 work (2026-10-08)

Status on `mvp-v2-merge`: SIT-1 and SIT-3 fixed in f107013, DL-3 and DL-4 fixed in 054da38, DL-10 fixed for observe
mode only; everything else below is still open. Five reviewers checked `git diff 654d822 b435acb` by area (delivery, situation, sim-train, realapps, project docs),
with adversarial verification; findings marked "test" in their summaries were reproduced with temporary vitest files
(deleted) or pure-Python probes. No source file was edited by the review. **52 confirmed findings; the uncertain list
is empty** (one confirmed finding, DL-12, was not verified in a real browser). Area verdicts in one line each:

- **Delivery:** the common path is sound (uncontended deliveries released synchronously, channel order kept, atom
  discards drop only the stale field); the edges are weak.
- **Situation:** deterministic; the worst problems are two redaction regressions and the SIM budget; `rt.py`
  diverges from the frozen renderer in several common cases.
- **Sim-train:** RNG streams, commit posterior and prefix check hold; the sim pins `heal`, so the observe default does
  not affect it; labelling/eval scripts can report success after failures.
- **Realapps:** virtual time, keyed draws and labels mirror the sim; headline sweep claims say more than the code
  measures; eval-set and manifest problems.
- **Project docs:** HANDOFF says guard is the default (still true).

#### Delivery (runtime network-boundary path)

| id | sev | where (file -> symbol) | finding and scenario | suggested fix |
|---|---|---|---|---|
| DL-1 | high | `packages/runtime/src/state/hub.ts` -> `StoreHub.applyFilter` | Delivery `discard` is a silent no-op on redux/zustand stores, but the `ActionRecord` claims the writes were dropped. Guard, redux `{items, loading}`: a newer op writes `items=['pushed-newer']`, the stale response dispatches `LOADED {items:['v2']}`; final state `['v2']`, record says "dropped the state changes it makes over newer data (list.items)" with `dropped: []`, and no mutation decision follows. The atom variant ends correctly with `['pushed-newer']`. | Apply the kept changes as a patched whole value through the store's `io.set` (redux `GENCLASS_REPLACE`, zustand `outer(v, true)`); else report honestly (ok:false or a reason, `op.delivery.overNewer`, leave `decided` false so the mutation trigger can decide or late-revert). Build `changed` from `mark.dropped` after the fact. Add redux and zustand variants of the discard test. |
| DL-2 | medium | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.dropFilter` / `RuntimeImpl.writtenOver` | A discard mark drops the fresh writes of later ops chained from the discarded op (polling chains, sagas) for 10 s. Guard: stale poll p2 is discarded, its handler schedules the next poll; p4 (cause chain p4 → timer → p2) returns fresh `v=103` and is dropped ("dropped the write of doc.v by GET /api/doc?slow=0&p=4 (#10) over newer data"); `loading`/`status` fields can stick. | Scope the mark to the discarded response's own writes: stop the cause walk at the first op with its own `delivery` record (`if (x.delivery && !x.discardMark) return null`), or compute `writtenOver` against the nearest network op. Regression test with a `setTimeout`-chained poll. Decide with Mehar whether it lands before or after the current v2 generation. |
| DL-3 | medium, **fixed in 054da38** | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.runDelivery` | Observe mode (the new default) still holds deliveries: up to 100 ms waiting for the body, and XHR/WS listeners run outside the original dispatch. Measured: network answered at +500 ms, the app's fetch resolved at +600 ms, same as guard; an observe-mode XHR `readystatechange` ran with `inDispatch=false` and `load` saw `currentTarget=null`. | At the top of `runDelivery`, check whether a hold is possible (`permittedActions(this.policy, this._mode, TRIGGER_ACTIONS.delivery).length > 0 && this.expectedLatency() <= this.holdBudgetMs()`); if not, `rel()` synchronously first and do body analysis and the background trigger (F9 marks, detection) without holding. Default-mode tests for fetch and XHR with a conflicting delivery and a slow body. |
| DL-4 | medium, **fixed in 054da38** | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.trigger` / `runDelivery` `ctl.stale` | Background (non-held) delivery decisions are always dropped as stale: delivery standing questions are never answered in observe mode, and every salient delivery's situation is built for nothing. `rt.question({ on: ["delivery"], always: true })` + one fetch: 0 answers in observe, 1 in guard; with triage `always`, observe decisions are `request`/`mutation`, never `delivery`. | Pass `stale` only for held submissions (`waits ? stale : undefined`), or skip building the situation when it will not be held and no standing question forces it. If background delivery decisions are kept, mark the writes covered when the decision lands. Correct "every trigger is decided" wording in docs/agents. |
| DL-5 | medium | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.runDelivery` `ctl.run('defer')` / `waitOps` | `defer` can hold a response, or a whole WS/SSE channel, for 20 s regardless of the hold budget (`waitOps` waits up to `LONG_RUNNING_MS` = 10 s per defer, at most 2 defers). Guard, WS `/live`, a long-poll `GET /api/feed` in flight, model answers `defer`: message delivered at +20,000 ms; every later message on the socket waits too. | Bound a delivery defer by the hold budget (`waitOps(related, Math.min(LONG_RUNNING_MS, k * this.holdBudgetMs()))`); offer defer only when related ops are expected to finish soon; for push channels do not offer it while messages are queued behind (`queuedAhead`), or cap it more tightly. |
| DL-6 | medium | `packages/runtime/src/observe/messages.ts` -> `MessageGate.pump` | Held WebSocket/EventSource messages are dispatched after the app called `close()`. Guard, triage `always`: held message, app calls `ws.close()` (readyState 2), decision releases it: the listener receives `{"n":1}` with readyState 2. | Before dispatching a queued `MessageEvent`, check `readyState`: drop when a WebSocket is not OPEN (1) or an EventSource is CLOSED (2); end/emit the op as dropped; still dispatch queued close/error events. Or wrap `close()` to flush or drop the queue. |
| DL-7 | medium | `packages/runtime/src/state/hub.ts` -> `StoreHub.gateAndQueue` / `StoreHub.flushQueue` | `holdWrites` (opt-in): a held write applied early by `flushQueue` flips back to state `resolved`; a late discard is then recorded as a drop while the write stays applied. Policy `{holdWrites:true, holdBudgetMs:100}`: record reads "Dropped the write to a.v from task bg (#1); a stays at version 2." with nothing reverted. | In `gateAndQueue`'s `held.then` and its `catch`, return early when `m.state === "done"`; make `proceeded` robust with `m.outcome !== undefined`. |
| DL-8 | low | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.dropFilter` (via `StoreHub.propose` -> `applyFilter`) | Discard marks keep dropping app writes after `rt.pause()` and `setMode("observe")`. Guard: stale response discarded, its handler applies data 500 ms later; pause (or observe) in between: the write is still dropped. | Return null from `dropFilter` when `this.paused \|\| this.destroyed \|\| this._mode === "observe"` (or call `applyFilter` only when gating); clear active `discardMark`s in `pause()`, `destroy()` and `setMode("observe")`. |
| DL-9 | low | `packages/runtime/src/observe/eventsource.ts` -> `installEventSource` / `MessageGate.ensure` | EventSource `open` is not order-kept behind held messages, and the re-dispatched error clone reports a spurious channel "down". Triage `always`: open, message (held), error (queued), open: the app saw `open, open, message, error`. | Queue `open` with the orderOnly handler (like close/error); in the raw open/error/close listeners ignore the gate's own re-dispatched copies (expose `gate.isMine(e)`). |
| DL-10 | low; **fixed for observe mode in 054da38** (released synchronously), open for held XHRs in guard/heal | `packages/runtime/src/observe/xhr.ts` -> `installXHR` -> `gateCall` / `arrive` | XHR completion listeners run after the event's dispatch ended (`e.currentTarget === null`): `(e) => JSON.parse(e.currentTarget.responseText)` throws a TypeError for a held XHR (guard) or in observe mode with a conflict. | Invoke queued listeners with an event whose `currentTarget` is the xhr (Proxy, or `Object.defineProperty(ev, "currentTarget", { value: xhr, configurable: true })` plus `eventPhase` 2), or re-dispatch fresh events as `MessageGate` does. |
| DL-11 | low | `packages/runtime/src/observe/dom-user.ts` -> `installDomUser` -> `programmatic` | `untrustedEvents` defaults to false, so the demos site's in-page synthetic driver now records no user actions; decisions diverge from the Playwright driver for the same script (regresses demos/NEEDS §7). | Pass `observe: { untrustedEvents: true }` from the demos' `startGenClass` when the synthetic driver is used (or always on the demo site); update the `programmatic` comment. |
| DL-12 | low | `packages/runtime/src/observe/messages.ts` -> `MessageGate.intercept` | (Not verified in a browser.) A capture-phase WS/SSE message listener (`addEventListener('message', h, { capture: true })`) sees a held message twice: at arrival and at release. | Register the interceptor with `{ capture: true }` (it still runs first), or wrap `addEventListener` for message types as `xhr.ts` does. |

#### Situation format, redaction and the curriculum port

| id | sev | where (file -> symbol) | finding and scenario | suggested fix |
|---|---|---|---|---|
| SIT-1 | high, **fixed in f107013** (`state/fields.ts` -> `redactedStringDiff`) | `packages/runtime/src/situation/content.ts` -> `contentFacts` | The F2 fact prints the raw text of redacted fields (bypass via `stringDiff`). Store `settings = {apiKey: "sk_live_AAAA…"}`, an autosave PUT in flight, the user types into the key field: every other section shows `settings.apiKey = [redacted]`, but the first fact quotes `"…AAAAAAAAAAAAAA SECRET99" → "…AAAAAAAAAAAAAA" (removes " SECRET99")`. Same with a custom redactor hiding a PII free-text field. | Use `stringDiff` only when both values pass the redactor unchanged (`Object.is(env.redact(c.path, c.current), c.current) && Object.is(env.redact(c.path, c.incoming), c.incoming)`), or route through `changeText({path, before, after}, env.redact)`. Tests with a sensitive key and a custom redactor. Changes model-visible text only for redacted fields. |
| SIT-2 | medium | `sim/src/world/scenario.ts` -> `budget` | SIM still samples the v1 3,200-char budget for 40% of trajectories while v2 data is generated on Azure (`[[3200, 40], [2000, 30], [1000, 30]]`). Measured: `toJevState(p, 3200)` 3,010 chars vs `toJevState(p, 2400)` 2,198 for identical parts; ~35% more tokens in teacher labelling and distillation, and R17/R32 train on longer sections than production shows. | Use the v2 device budgets, e.g. `[[2400, 35], [2000, 20], [1667, 5], [1333, 5], [1000, 35]]` (= `rt.py` `BUDGETS`), fix the JSDoc, tell Mehar before more v2 shards are produced; existing shards can be filtered by `meta.budget == 3200`. Optionally clamp `toJevState` to `STATE_CHAR_BUDGET × budgetScale`. |
| SIT-3 | low, **fixed in f107013** (tests in `test/redaction-v2.test.ts`, not `review-redaction`) | `packages/runtime/src/util.ts` -> `isSensitivePath` / `defaultRedact` | The new leaf-based default redactor no longer redacts numbers or arrays under secret-named containers (regression vs 654d822): `defaultRedact("payment.cvv.value", 123)` → 123, `("login.otp.code", 123456)` → 123456, `("lock.pin.value", 1234)` → 1234; `account.password.history` arrays likewise. They then appear in state lines, deltas, timeline and facts. | Under a strong (non-broad) secret container, redact every non-boolean, non-null value (strings, numbers, bigint, arrays) before the early return that should only short-circuit the broad-container opaque test. Add the cases to `test/review-redaction.test.ts`. Model-visible. |
| SIT-4 | medium | `training/curriculum/rt.py` -> `request_common` | `rt.py` adds a "Recent … outcomes" fact to every failure situation; the runtime never emits it for failures. Probe over 3,000 seeds: 479 of 479 runtime-style failure rows, e.g. "Recent GET /api/v2/listings outcomes: 500, 503, 503, 503, 503." | `elif outs and trigger == "stall":`; add a parity assertion to `test_runtime_rows_situation_v2` that failure rows have no such fact. |
| SIT-5 | medium | `training/curriculum/rt.py` -> `compare_field` / `change_text` / `_json_str` | Long-text summaries skip the runtime's F2 and diff-centred paths, so autosave rows get F1 "put back" wording instead (68 of ~6,000 delivery and 25 of ~3,000 mutation rows); timeline lines show `A → B` instead of the diff preview. The model trains on the wrong wording for the main F2 case. | Let long-text scenarios carry the real strings so summaries are JSON string literals and `string_diff` runs (mirror `describe(…, 48/40)` truncation); at minimum treat summaries starting with `"` as strings in `compare_field`. |
| SIT-6 | medium | `training/curriculum/rt.py` -> `event_lines` / `to_state` / `in_flight_lines` | `rt.py` keeps the last N timeline events; the runtime keeps relevant events first (and orders mutation in-flight lines by the cause). Probe: in 549 of 2,949 runtime-style rows (~19%) a relevant event (often the causing user action) was dropped while an irrelevant noise request was kept. | Return `(line, relevant)` pairs with the runtime's relevance rule (user, error, subject chain, same sig, same root, signatures that wrote the involved stores), select relevant-first with a seq re-sort, pass `spec['cause']` as the in-flight subject for mutations. |
| SIT-7 | medium | `training/curriculum/rt.py` -> `event_lines` / `mutation_facts` / `content_facts` | `rt.py` renders no-op writes (`A → A`) the runtime never logs or gates: 224 of 2,949 rows (7.6%) have a no-op timeline write; 43 mutation rows have an F3 "has the current value" fact with `X → X`; 33 have "is back to" facts driven by no-op writes. | Skip writes whose summary equals `value_before` (timeline, moved facts, version counts); `render()` returns None for a mutation whose `after` equals the current value of every path (F3 "changes nothing" belongs to delivery only). |
| SIT-8 | medium | `packages/runtime/src/situation/content.ts` -> `contentFacts` / `compareField` | "…nor the value when #X started" is asserted without checking it; false when X's own chain wrote first. `card.status = "idle"`; Refresh starts a slow fetch, the handler sets "loading", op `push` sets "ready", the response has "idle": fact says "neither the current value "ready", nor the value when #4 started", but it was "idle" then. | Append the clause only when `vhash(c.start.value) !== vhash(c.incoming)`; otherwise say ", the value it had when #X started". Mirror in `rt.py` `content_facts`; add the repro as a test. Model-visible. |
| SIT-9 | low | `training/curriculum/rt.py` -> `request_common` / `stats_lines` / `secs` / `ratio` | `rt.py` rounds the usual request rate to 2 decimals; the runtime's `fmtNum` prints 4 below 1 ("usually 0.33 per 10s" vs "0.3333"), in 102 of 598 request rows and 15 failure rows, plus "(usual 0.33)" stats; also JS/Python tie-rounding differences. | Drop `round(usual, 2)` in both places; optionally round half-up (`decimal` `ROUND_HALF_UP` or `floor(x*10^d + 0.5)`) to match JS `toFixed`/`Math.round`. |
| SIT-10 | low | `packages/runtime/src/situation/content.ts` -> `createdIds` / `rywFacts` (fed by `runtime.ts` -> `noteResponse`) | Every successful POST JSON response is recorded as a "create": `POST /api/search` returning items makes a later paginated `GET /api/products` get the non-neutral fact "… created item "7" …, and does not contain it", pushing toward inconsistent/resync. | Count as a create only a 201, or a POST whose single returned object's id is not already in any store; drop the array case unless 201; or word it "returned item". Model-visible. |
| SIT-11 | low | `packages/runtime/src/situation/evidence.ts` -> `commitAmbiguity` / `NOT_PROCESSED` | The commit-ambiguity fact says HTTP 502 is "usually returned without processing the request". A proxy 502 after the app server committed an order pushes toward `retry` and a duplicate order; 500/504 are correctly ambiguous. | Remove 502 from `NOT_PROCESSED` in `evidence.ts` and `rt.py` (falls through to the 5xx "may have applied it" branch), or weaken the wording. Model-visible. |
| SIT-12 | low | `training/curriculum/scenarios.py` -> `mut_live` | The live-update scenario uses bracket paths the runtime never produces: ~3.4% of runtime-style rows show `board.cards[46095] = …` and "messages like it last wrote board.:id." | Use dotted paths (`f"{store}.{coll}.{cid}"`) in `mut_live` and any other scenario that builds bracket paths. |
| SIT-13 | low | `training/curriculum/rt.py` -> `state_lines` | `rt.py` prints `(vN)` with no writer or age for initialised fields (~2% of rows, e.g. `current.value = {id: pedalshare-518} (v1)`); the runtime always adds the age. | Give `init_field` a timestamp (and optionally a writer) and render ` (v{v} {secs(now - t0)} ago)` or ` (v{v}, by #{op} …)`. |
| SIT-14 | low | `docs/runtime/CONTRACT.md` -> `redact` option (§2) | CONTRACT still documents the old substring redaction rule; an integrator assumes `cardInfo.digits` is redacted (it is not: words "card", "info", leaf "digits" do not match) and ships without a custom redactor. | Describe the leaf-name/word rule, secret pairs, strong vs broad containers and the opaque-string rule in CONTRACT (and docs/agents); recommend a custom redactor for app-specific secrets. |

#### Sim labelling and training scripts

| id | sev | where (file -> symbol) | finding and scenario | suggested fix |
|---|---|---|---|---|
| ST-1 | high | `sim/src/gen/trajectory.ts` -> `unlabeledTrajectory`; `training/label_teacher.py` -> `main` | Unlabeled rows hard-label `expected` diagnoses that S1 would relabel, and `label_teacher` keeps them, undoing S1 on 5× more data. A stale overwrite where `discard` wins: gold says `stale`, five unlabeled look-alikes say `expected`; the distilled student pushes P(expected) up and the guard/heal gate (`requireDiagnosis`) refuses to fire. | S1 only turns `expected` into non-`expected`, so in unlabeled mode omit the hard diagnosis label when it is `expected` (keep it in `meta.diagnosis`) so the teacher labels it; or add `--overwrite-qids diagnosis` to `label_teacher.py`. No regeneration needed: a one-line relabel pass over the collected shards can drop `labels.diagnosis` where it is `expected`. |
| ST-2 | medium | `training/label_cluster.sh` (remote `/tmp/label-$OUT.sh`) | Touches the done marker unconditionally and cannot read the collected `.jsonl.gz` shards: every node labels 0 rows but `.label-<OUT>-done` appears within minutes; students then launch on a missing/empty bucket. A teacher-tar 404 also ends "done" after nodes were billed. | `set -euo pipefail`; fail if the teacher tar or model dir is missing; per-shard `.ok` on exit 0 and the done marker only when every assigned shard has one; accept `*.jsonl.gz` (gzip streaming in `label_teacher.py`, or `zcat`) with one pattern for list and glob. |
| ST-3 | medium | `training/label_cluster.sh` | No split filter and no gather step: test/dev shards of an unlabeled run get teacher labels and stream as training data (held-out feature/domain metrics contaminated); students on c02–c09 stream an OUT bucket that holds only their own node's shards, or none. | Select only `train-*` shards (assert `split == "train"` per row in `label_teacher.py`); add a gather step that pulls `data/s3/$OUT/*` from every node to the workbench and redistributes, or document that SRC_DIR must hold train shards only. |
| ST-4 | medium | `training/final_post.sh`; `training/eval_sim.sh` | `final_post.sh` hard-wires the situation-v1 eval set (`eval_sim.sh simAe`, `out/cal/<M>-simAe.json`) and skips failures, so a v2 model would be calibrated and exported on v1 situations; a crashed shard eval leaves partial merged records. | Make the eval-set name a required argument (EVAL=simv2e) and assert the eval rows' situation version; `set -euo pipefail`; check each shard record file exists and is non-empty before merging; no `.post-done` or served tar unless the export's card and sha256 check pass. |
| ST-5 | medium | `training/eval_runtime.py` -> `get_records` / `main` (tag) | Cached eval logits are keyed only by checkpoint and data names: a step-1,000 progress eval of `r17-v2` is reused after training finishes, so final metrics, dev-fitted temperatures and the exported calibration come from stale logits. | Add a checkpoint fingerprint (step, or mtime/sha of the weights) and a data fingerprint (row count + hash of the first ids) to the cache key or record header and invalidate on mismatch; at minimum have `eval_sim.sh` delete `out/records/${M}__${NAME}*` before collecting. |
| ST-6 | medium | `sim/src/run/latent.ts` -> `idealRepeatSkips`; `sim/src/run/runner.ts` -> `runScenario` | The S2 hidden-intent re-draw has no effect on impatient (conditional) re-clicks: the ideal run's `cond` is always false. A re-click 1.2 s after a pending submit (`REPEAT_PRIOR(1200)` = 0.2 accidental): ~80% of futures draw "intended", yet the ideal run still skips the click, so `coalesce`/`block` looks free and S1 rule b labels `duplicate`. | In ideal runs bypass the `cond` check for steps whose idealSkip entry is false (they fired in the base run); add a `latent.test.ts` case that an intended conditional re-click changes the ideal run. |
| ST-7 | medium | `training/launch_student.sh` (argument parsing / `INIT_ARGS`) | Fails whenever INIT is omitted: under bash 3.2 (Mac) the empty array is unbound (`INIT_ARGS[@]: unbound variable`) after the prune loop already ran over ssh on 12 nodes; with `-- --gain-loss 1.0` and no INIT, `--` is taken as INIT and every rank dies on `--init-from --`. (Reproduced locally with bash 3.2.) | Parse positionals up to `--` explicitly (INIT = 6th positional only if it is not `--`); expand with `${INIT_ARGS[@]+"${INIT_ARGS[@]}"}`; optionally `#!/usr/bin/env bash` and a version check. |
| ST-8 | low | `training/import_final.sh` | Cannot import the v2 SIM layout and is destructive on failure: it wipes `data/simv2`, the `train.jsonl` curl 404s, nothing is imported; the FILES override is broken; the tar duplicates all of `data/s3` and can fill the workbench disk, leaving a truncated tar served on :8799. | A v2 importer: pull gz shards (verify against `manifest.json`), stream train shards into `data/s3/<NAME>/`, sample eval sets from test/dev; download to a temp dir and swap on success; tar only `data/s3/$NAME` or let nodes pull per bucket. |
| ST-9 | low | `sim/src/gen/trajectory.ts` -> `generateTrajectory` (diagnosis-only rows) | On-policy diagnosis-only rows reuse the gold id prefix and carry no `on_policy` flag: ~3 per on-policy trajectory are counted as gold-policy rows, and id-keyed joins (`eval_gain` loads rows by id) can pick the wrong row. | Use the same `${onp ? "p" : "sim"}` prefix and add `on_policy: true` to their meta in on-policy mode. |
| ST-10 | low | `sim/src/run/rt.ts` -> `createOptions` | On-policy (DAgger) runs act in heal mode while the shipped default is observe and the precision target is guard: 1–5M rows per round follow heal-tier actions guard users never trigger, so guard FIR/recall on them do not reflect the guard deployment. | Add `--on-policy-mode guard\|heal` to `gen.js` (default guard) and record `meta.policy_mode`. |
| ST-11 | low | `sim/src/run/runner.ts` -> `makeWebSocketClass` | Re-drawn socket-drop windows can be reordered, and the socket schedules only the first later window in array order: with A re-drawn to t+9 s and B to t+5 s, only A closes the socket while offline/online and the server act as if B had, so websocket-reconnect labels in that future come from an inconsistent world. | Sort re-drawn windows by start in `futureProfile`, or schedule the earliest `w.start > now`. |

#### Realapps (REAL corpus and never-worse harness)

| id | sev | where (file -> symbol) | finding and scenario | suggested fix |
|---|---|---|---|---|
| RA-1 | medium | `realapps/src/harness/debug.ts` -> `--interference` block | The interference sweep does not compare requests, bodies, stores, errors or run health, so "0/396 (same requests, bodies, server state and DOM)" overstates what was measured: a held delivery that resets an `<input>`, an extra GET, a flashed alert, or both runs hitting an internal error (`ok=false`, empty DOM and server) all count as unchanged. | Count a run as changed if `!obs.ok \|\| !heal.ok`, or if the net sequence `[method,url,bodyKey,status,outcome]`, final stores, error episodes/writes/uncaught counts, `skippedAt` or input values (add a form-value snapshot) differ. Rerun the sweep, or reword STATUS/RESULTS/HANDOFF to "same final visible text and server content". |
| RA-2 | medium | `realapps/src/harness/browser.ts` -> `Runner.run` / `Runner.context`; `gen.ts` worker message loop | A crashed Chromium makes its worker drain the whole remaining seed queue as instant failures: an OOM-killed `headless_shell` 2 h into a 30k batch fails ~20k seeds in under a minute, `gen.js` prints "done", the node keeps running (billed) with most of the batch missing. Failed seeds are not in `done.txt`, so a rerun recovers them, but nobody is alerted. | Move `context`/`newPage` inside the try; on failure or `!browser.isConnected()` relaunch the browser and retry once; in `gen.ts` re-fork a worker after N consecutive failures and log a loud failure count to `gen.log`. |
| RA-3 | medium | `realapps/scripts/evalset.py` -> `main` (splits default) | `evalset.py` draws eval rows from `["test", "dev", "train"]` by default, so eval rows are training rows and real-app precision/recall are inflated. | Default to `test` (or test,dev); refuse `train` without `--allow-train`; regenerate existing eval sets and check the `splits` field in `manifest.json`. |
| RA-4 | medium | `realapps/scripts/evalset.py` -> `classify` | The eval set ignores the situation-v2 `delivery` trigger: none of the v2 pilot's 135 delivery rows reach `real_eval.jsonl`, so it cannot measure the network-boundary decisions v2 is built around. | Accept `t in ('mutation','delivery')` for stale-overwrite (expect discard/defer); add delivery to genuine-break and duplicate cases; report per-trigger counts in `manifest.json`. |
| RA-5 | medium | `realapps/src/world/diagnose.ts` -> `diagnose` (case `delivery` / default) | The `delivery` diagnosis has no "user changed the same field after the read started" rule: in vue-editor the autosave GET lands after the user typed in the title, discard is best, but the label is `expected` (the bucket TRAIN may down-weight), so the model learns `expected` for real stale overwrites. | For delivery, compute the chain start (min `op.start` over `p.chain(opId)`); if a user write after it touches the response's predicted paths (or, when unknown, any store the op's prior writes touched), label `stale` with why `user-changed-before-delivery`; apply the mutation branch's pending-write/read-before-write rule; re-audit `EXAMPLES.md` delivery rows. |
| RA-6 | medium | `realapps/README.md` -> APPS (`build.mjs` `apps.gen.ts`) | The sweep claims (66 apps, 0/396, 198/198 or 132/132) do not cover the current corpus: 25 wave-3 apps added afterwards (91 now) have no recorded determinism or interference sweep, yet the docs cite the numbers as covering the data. | Before a production batch includes them, run `debug.js --det 1-3 --app <25 apps>` and `--interference 1-6 --clean --app <25 apps>` (ask the user first: Chromium); update README/HANDOFF/STATUS to 91 apps with per-set numbers; record the app list (or a hash) in `manifest.json`. |
| RA-7 | medium | `realapps/src/harness/gen.ts` -> `record` / stats resume | Resume can duplicate rows and under-count stats: a node deallocated mid-batch and resumed duplicates up to ~70 trajectories (one per in-flight worker) whose rows were flushed but not marked done; `manifest.json` reports fewer gold rows than the files hold. | Append `done.txt` first with a pending marker, or dedupe rows by id on resume (ids are deterministic: `real-<app>-<seed>-dK`); recompute counts from the jsonl files for the final manifest. |
| RA-8 | low | `realapps/src/harness/gen.ts` -> `manifest` | Batch `manifest.json` hardcodes `runtime: "situation-v1 (packages/runtime/src bundled from source)"` for every batch, including v2 production, so TRAIN filtering by manifest excludes every v2 batch or mixes v1 pilot data in. | Import `RUNTIME_TAG` from `./trajectory.js` and write `runtime: RUNTIME_TAG`; patch existing manifests on c01/c10/c11 and `train:/data` (Mehar's call). |
| RA-9 | low | `realapps/src/harness/debug.ts` -> `--det` block | The determinism check only reruns the base run inside one browser context; counterfactual, future-salted and cross-worker runs are never checked, so noisy post-k behaviour (untracked native work under 70-worker load) inflates SE and softens labels unseen. | Add `--det-cf`: for a sampled decision k, run the forced counterfactual with a `future` twice on two Runner instances (separate browsers) and compare snapshots, net and server. |
| RA-10 | low | `realapps/src/harness/debug.ts` -> `--interference` block | No sweep measures whether observe mode itself (the new default) changes app behaviour: "never worse" is heal relative to observe, so an observer wrapper that changes Response timing or notification order in some framework is invisible. | Add an "off" run mode (no `__GENCLASS_INIT__`, or probe hooks only) and report off vs observe as the never-worse figure for the default. |
| RA-11 | low | `realapps/corpus/prepare_oss.sh` (`npm install` after `rm -f package-lock.json`); `node_setup.sh` | Unpinned dependencies: realapps has no lockfile and OSS apps' lockfiles are deleted, so nodes set up at different times can bundle different framework versions; `v2b1` and `v2b3` rows for the same app/seed may differ and cannot be reproduced. | Commit `realapps/package-lock.json` and use `npm ci` in `node_setup.sh`; keep upstream lockfiles or commit generated ones under `corpus/locks/<name>.json`; record `npm ls --depth=0` per app in the manifest. |
| RA-12 | low | `realapps/README.md` -> "Run it (on a VM)" | The README pins the runtime through env vars exported on the Mac, which never reach the VM build, so rows get `meta.runtime='working-tree'` (now including f3636b2's runtime changes): the leak the pinning was meant to prevent. | Put the exports inside the quoted remote command (or have `build.mjs` read `~/gcl/real-cache/runtime/current` as `node_setup.sh` does); change the example tag to `situation-v2`; make `gen.js` refuse `working-tree` unless `--allow-unpinned`. |

#### Project docs

| id | sev | where (file -> symbol) | finding and scenario | suggested fix |
|---|---|---|---|---|
| PD-1 | resolved in b561244 | `README.md` -> Modes / "How it works" 5; `packages/runtime/README.md` -> Modes | Both READMEs still say guard is the default; a user reading the npm README after the next publish expects guard protection from `GenClass.init()` and gets observe, which takes no action. | Mark observe as the default and guard as opt-in (heal experimental) in both, change the example to `GenClass.init({ mode: "guard" })`, add a note on the change. |
| PD-2 | resolved in b561244 | `OPEN_TASKS.md` -> In progress / Next | The body is stale and contradicts HANDOFF: "Final data, phase A" and "Final training round 1 on phase A" read as current work (following them spends Azure compute on v1 training), batch 4 sits under Next though done, and items 3 and 4 appear twice. | Move batches 4 and 5 to Done; replace phase A / round 1 with the v2 pipeline from HANDOFF; renumber. |
| PD-3 | resolved in b561244: the Loading bullet now says there is no model for this runtime yet | `packages/runtime/README.md` -> Status note | Tells users to self-host with `npx genclass-runtime fetch-model`; there is no v2 model, so they get a 404, or load a v1 model into the v2 runtime and get wrong decisions. | Remove the suggestion until `@genclass/runtime-model@0.1.0` is published, or say no compatible model exists yet. |

**Uncertain findings:** none (the reviewers' uncertain list is empty).

### Install code review (2026-10-08)

Review of Mehar's one-command install (f3a9dd1) as merged here (HEAD 10e5c3b at review time; the later fix commits do
not touch `bin/` or `src/cdn/`). Every finding was reproduced (scratch projects, `node -e` imports, tsc, esbuild,
Prettier) and verified adversarially; severities are the verifiers'. None has shipped: the published `0.1.0-alpha.1`
has no install code. All must be weighed before the next release.

| # | sev | where (file -> symbol) | finding and scenario | suggested fix |
|---|---|---|---|---|
| 1 | high | `packages/runtime/bin/lib/plan.mjs` -> `AUTO`, `scriptTag`; `bin/lib/init.mjs` -> `USAGE`, the "Mode" row | `init` and `init --mode guard` both write `import ... from "@genclass/runtime/auto"` (and the script tag omits `data-mode` for guard), because the CLI assumed guard was the runtime default (true at eff18cb: `o.mode ?? "guard"`). After the merge `/auto` runs observe, so a user who asked for guard gets observe while the CLI prints "Mode guard"; `USAGE` says "guard (default)". Fails safe (observe changes nothing) but silently. `test/install/INSTALL-README-SNIPPET.md` repeats the guard default; `test/install/cli.test.ts` covers only `--mode observe` | `` AUTO = (mode) => mode ? `@genclass/runtime/auto/${mode}` : "@genclass/runtime/auto" ``; emit `data-mode` whenever a mode is set; usage and Mode row say observe is the default; fix the snippet; tests for `--mode guard` (`/auto/guard`, `data-mode="guard"`) and for no flag (bare `/auto`). Fix before adding the "re-run with another mode" check of finding 11 |
| 2 | medium | `packages/runtime/package.json` (`version`); `tsup.config.ts` -> `globalBuild`; `src/cdn/global.ts` -> `assetBase`; `bin/lib/init.mjs` -> `installSpec`; `bin/lib/plan.mjs` -> `scriptTag`; `packages/runtime/CHANGELOG.md` | The tree is still `0.1.0-alpha.1`, which npm already has without these files. Built or packed before a bump: the global build's `dist/cdn/worker.js` URL and the default script tag 404 on jsDelivr; `init` installs `@genclass/runtime@^0.1.0-alpha.1`, which resolves to the published alpha.1 with no `./auto` export, so the user's build fails. (The devtools would load, from the older release.) `CHANGELOG.md`'s `## 0.1.0-alpha.1` lists the install, `/auto` and the script tag. npm refuses to republish a version, so this only bites local builds, packs and tarball tests until the bump | Bump to `0.1.0-alpha.2` (or the planned beta) before any build or pack; rebuild so the baked version and SRI hashes match; move the install bullets to a new `## 0.1.0-alpha.2` section. Optionally refuse a CDN URL or install spec for a version whose registry entry lacks `dist/genclass.global.min.js` |
| 3 | medium | `packages/runtime/bin/lib/edit.mjs` -> `removeMarked`; `bin/lib/plan.mjs` -> `snippets`, `editEntry`; `bin/lib/init.mjs` -> `remove` | `init` appends a 97+ character dev-only line ending in `// genclass:init`; Prettier (format-on-save) wraps it so only the inner line carries the marker; `remove` deletes that line and leaves a dangling `if (import.meta.env.DEV)` (syntax error). Same with the Next layout's inline `<GenClassInit />{/* genclass:inline */}`: the inline regex stops matching, `remove` deletes the import and `genclass-init.tsx` but leaves `<GenClassInit />` (build error). Astro form plausible, not reproduced | Insert only short single statements or start/end marked blocks; markers that survive reflow for the JSX/Astro forms; have `remove` sanity-check its result (dangling `if`, leftover `GenClassInit` or `genclass:inline`) and refuse with a manual-edit message |
| 4 | medium | `packages/runtime/package.json` (`exports`, no `typesVersions`) | `/auto`, `/devtools` (and `/react` etc.) do not resolve under TypeScript `moduleResolution: node`: TS2307 "There are types at .../dist/auto.d.ts, but this result could not be resolved". A Create React App TypeScript project fails `npm start`/`npm run build` right after `init` (ForkTsChecker). `bundler` resolution is fine; a bare side-effect import of `/auto/<mode>` is not type-checked by TS 5.9 | Add `typesVersions` mapping `auto`, `auto/*`, `react`, `redux`, `zustand`, `devtools` to their `.d.ts` (verified with tsc under `node`: all resolve, root import unchanged); add a node10-resolution check and a CRA TS scaffold to `frameworks.mjs` |
| 5 | medium | `packages/runtime/bin/lib/detect.mjs` -> `detectProject`; `bin/lib/plan.mjs` -> `planWebpack` | Any `webpack`, `@rspack/core`, `@rsbuild/core`, `parcel`, `esbuild` or `rollup` dependency makes the project a browser app (`framework: "webpack"`). A Node CLI/server with `esbuild` as a devDependency gets `import "@genclass/runtime/auto"` after its shebang in `src/index.ts` and a runtime dependency on the package; a rollup-built library would start GenClass in every consumer's app | Require browser evidence (an HTML entry, an html plugin config, a DOM entry); refuse for `bin`/`main`/`exports` packages without HTML or entries importing `node:*`/server frameworks; otherwise fall back to the manual help |
| 6 | medium | `packages/runtime/bin/lib/plan.mjs` -> `integrityFor`, `scriptTag` | `--cdn <url>` gets an `integrity` hash of the CLI's own local `dist/genclass.global*.js` whenever the URL's filename matches, regardless of version or host: `@latest`, another version or a self-hosted copy of another build is blocked by the browser, GenClass never starts, and `@latest` breaks again on every release. `--no-sri` exists but is not in the usage text | Add SRI only for the default URL or a jsDelivr/unpkg URL pinned to exactly `@${VERSION}/`; otherwise omit it with a note (or require `--sri`); document `--no-sri` |
| 7 | low | `packages/runtime/bin/lib/edit.mjs` -> `removeMarked`; `bin/lib/init.mjs` -> `remove` | `remove` (a) deletes user code added inside a block init created (and the whole file when nothing else is left), (b) drops the rest of a file whose `// genclass:init end` line was lost, (c) drops any line that merely contains `genclass:init`. The diff is shown and confirmed unless `--yes` | Hash each created block and refuse to strip a changed one; treat a start without an end as an error; match markers only as the exact trailing comment forms |
| 8 | low | `packages/runtime/bin/lib/detect.mjs` -> `walkSources`; `bin/lib/init.mjs` -> `remove` | `remove` uninstalls the package while it is still imported from dot-directories (`.storybook/`), `tmp/`, `out/`, `build/` or beyond the 20,000-file / depth-10 scan, and also when the user installed it before `init` | Uninstall only what `init` installed (record it); scan dot-dirs except `.git` and caches |
| 9 | low | `packages/runtime/package.json` (`sideEffects`) | The published worker entry `./dist/worker.js` (the `./worker` export: top-level message loop, no exports) is not listed, so a bare `import "@genclass/runtime/worker"` bundles to nothing (esbuild warns). The default path (`new Worker(new URL("./worker.js", import.meta.url))`) is an entry and works. Alpha.1's `sideEffects: false` had the same gap. `./src/model/worker.ts` must stay: `src/cdn/worker.ts` imports it for the CDN worker build | Add `./dist/worker.js` and keep `./src/model/worker.ts` (the original suggestion to replace it would empty `dist/cdn/worker.js`); correct the `sideEffects` rows in `docs/agents/runtime/{public-api-and-lifecycle,build-test-release}.md` |
| 10 | low | `packages/runtime/src/cdn/config.ts` -> `readMetaConfig`, `fromPairs`; `src/cdn/global.ts` -> `blobModuleWorker`, `install` (its `load`); `src/cdn/ort-env.ts` -> `prepareOrt` | Page config comes from every `<meta name="genclass">` in the document (later ones win) and accepts arbitrary `ort`/`model` URLs: injected markup that lets a `<meta>` through can point the ORT wasm (and, when cross-origin isolated, its `.mjs` glue, in a page-origin Blob worker) or the model at another host, or switch the mode. SRI covers only the loader; the worker, ORT chunks and devtools load by `import()` without integrity. Needs a sanitizer that allows `<meta>`; on the CDN path a non-default loading setup | Read only `head > meta` (or the first one); do not accept remote `ort`/`model` URLs from meta (or require same-origin); document that SRI covers only the loader, or embed build-time hashes for `dist/cdn/*.js` and `devtools/index.js` |
| 11 | low | `packages/runtime/bin/lib/init.mjs` -> `init`; `src/index.ts` -> `GenClass.init` | Re-running `init --mode heal` after an observe install prints "Nothing to do" and keeps observe; a later `GenClass.init(options)` after `/auto` silently returns the first runtime (documented in the npm README) | Compare the existing marked import with the requested mode (after fixing finding 1) and offer to switch; a one-time `console.warn` when `GenClass.init` is called again with different options |

### Doc drift: project and coordination files

| file | stale statement | reality at f107013 |
|---|---|---|
| `HANDOFF.md` ("Modes: observe → guard (default; …)") | guard is the default | `observe` on our line (`runtime.ts`); `origin/runtime` still guard |
| `HANDOFF.md` "Current state" | "346 tests pass"; "66 real apps"; "Push to `origin runtime` as you go"; training "Next: 150M teacher on v2 gold" | 393 tests here; 128 app directories in `realapps/` ([realapps.md](realapps.md)); our policy: ask before pushing; r17-v2a and t150-v2a are already training |
| `packages/runtime/CHANGELOG.md` `## 0.1.0-alpha.1` | one-command install, `/auto` (`/auto/observe`, `/auto/heal`) and the script tag are in alpha.1 | the published alpha.1 (806a296) has none of them (`npm view ... exports`); they belong in the next version. The npm README already says "not in `0.1.0-alpha.1`" |
| `packages/runtime/bin/lib/init.mjs` -> `USAGE`; the "Mode" row | "guard (default)"; prints `guard` when no mode is given | the merged runtime and `/auto` default to observe (install finding 1) |
| `packages/runtime/test/install/INSTALL-README-SNIPPET.md` | "For a mode other than guard, import /auto/observe"; `data-mode` table "guard (default)" | observe is the default; guard needs `/auto/guard` or `data-mode="guard"` |
| `packages/runtime/test/install/RESULTS.md` | results for "this tree" | packed as `0.1.0-alpha.0` from Mehar's tree (guard default), before the merge |
| `packages/runtime/INSTALL-NEEDS.md` | `./src/model/worker.ts` in `sideEffects` "only for our own build" | correct, but `./dist/worker.js` is missing (install finding 9) |
| `docs/agents/runtime/public-api-and-lifecycle.md`, `docs/agents/runtime/build-test-release.md` (as committed at f107013) | `"sideEffects": false`; six tsup entries | the merged `package.json` lists side-effect files; tsup has four configs (10 ESM entries, two global builds, the CDN worker) |
| `RELEASE.md` | Part A is alpha.1 (done), Part B the model and `0.1.0` | no procedure yet for the next prerelease with the install paths (version bump, CHANGELOG, `npm pack` of the global build) |
| `packages/genclass-runtime/package.json` | version and dependency `0.1.0-alpha.1` | the alias would need the next version and is unpublished (`INSTALL-NEEDS.md` item 1) |
| `docs/runtime/CONTRACT.md` | no `delivery` trigger (§6); §4 mutations "held until a decision arrives"; §6 budget "≤ 1,000 tokens"; §8 `holdBudgetMs` "default 300"; §2 redaction regex and observer list without `eventsource`/`untrustedEvents`; §13 default-mode entry: "`situation-v1` training data stays valid" | batch 4/5 deltas exist only in STATUS; no store-write holds by default; 2,400-char budget; "auto" hold budget; leaf-field redaction (SIT-14); the entry should say situation-v2 (mode does not change situation text: `src/situation/*` has no mode dependency) |
| `docs/runtime/ARCHITECTURE.md` | "3,200 characters on WebGPU, 2,000 with WASM threads"; redaction regex | 2,400 on WebGPU and unknown devices, 2,000 only at 4 threads (`STATE_CHAR_BUDGET`); leaf-field rule |
| `docs/runtime/API.md` | mostly current for v2; still advises `fetch-model` without `--from`; "observe … nothing is held"; no `/auto` or script tag | the default model 404s; "nothing is held" is now true here (054da38), not in npm alpha.1 (DL-3); the install entries are undocumented in API.md. Full API drift: [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md#drift-and-open-issues) |
| `packages/runtime/STATUS.md` | "Updated: … (batch 5 …)"; Open issues: "`react-dom` is not a devDependency"; never-worse "same requests, bodies, server state and DOM"; 42 files / 348 tests; nothing on 054da38 | `react-dom ^19.3.0` is a devDependency; the sweep compares less (RA-1); 46 files / 393 tests here; observe deliveries changed in 054da38 |
| `docs/runtime/RESULTS.md` §4, §6 (merged version) | "0/396" never-worse; real-browser v2 gold "~495k target, generating" (96 apps) | covers 66 apps and final text/server content only (RA-1, RA-6); the newer RESULTS on `origin/runtime` reports 616,437 REAL gold and r17-v2a |
| `packages/runtime-model/MODEL_CARD.md` | "`files/r17/` here"; clear-case recall "≈ 5%" | `files/` is gitignored (only `MODEL_CARD.md` is tracked); EVAL.md gives guard 4.2% on all clear rows, 7.7% on clear stale/duplicate, heal 6.1% |
| `sim/NEEDS.md` g | NaN crash OPEN | fixed in ad24804 (`util.ts` -> `describe` uses `Object.is`; `test/nan.test.ts`) |
| `demos/NEEDS.md` | "Runtime: frozen batch 3"; §1 holds reorder writes, §2 hold latency, §6 EventSource not observed, §7 synthetic events recorded | batch 4: no store-write holds by default and opt-in holds never reorder; holds only when the model can answer in time, superseded decisions dropped; `observe/eventsource.ts`; synthetic events now need `untrustedEvents` (DL-11). §5 (`retry` on POST) is still open |
| `packages/runtime/UI-NEEDS.md` | Open 1 (ignore the overlay), Open 2 (`react-dom`), Nice-to-have 3 (`Explanation.message`) | 1 done (`observe/dom-user.ts` -> `ignoredEvent`); 2 done (devDependency); 3 done on the CORE side, the overlay still ignores it |
| `training/NEEDS.md` 10 | quota "1,024 vCPU … exactly the whole cluster" | HANDOFF / RESULTS: raised to 2,048 vCPU, c12–c23 added |
| `realapps/README.md` | 66 apps; "Run it" env-var pinning; `situation-v1` example tag | 128 app directories with a manifest; RA-12 |

### Recorded contract deviations (STATUS "Deviations from the contract (and why)")

Accepted by CORE and listed in STATUS; CONTRACT.md was not updated.

| # | deviation | code |
|---|---|---|
| 1 | `retry` backoff `min(200 ms · 2^(attempt−1), 5 s)` | `observe/fetch.ts` (failure handler) |
| 2 | `coalesce` not offered for XHR; XHR failures/stalls detection-only | `situation/build.ts` -> `builtinApplicable` |
| 3 | Transition profiles compare array kinds as empty / non-empty only | `learn/profiles.ts` |
| 4 | Error/transition `rollback` restores only the chain's fields; inconsistency uses the snapshot | `runtime.ts` -> `revertChain` |
| 5 | Default redaction by word-level secret names and (batch 5) by the leaf field with container rules; booleans and null never redacted | `util.ts` -> `defaultRedact`, `isSensitivePath` (see SIT-3) |
| 6 | `situation(trigger)` returns the last situation built for that trigger | `runtime.ts` -> `situation` |
| 7 | Batch 4 salience: a user action that changed a field is not, by itself, a version conflict; XHR `on*` getters return GenClass's wrapper | `runtime.ts` -> `runDelivery`; `observe/xhr.ts` |
| 8 | With `holdWrites` off, `mutation` `defer` is recorded only | `runtime.ts` -> `observeWrite` |
| 9 | Extra public surface (`adapter`, `inflight`, `holdBudgetMs`, `situationBudget`, `on("report")`, `ActionRecord.dropped`, `PolicyOptions.holdWrites`, `observe.untrustedEvents`, `SituationDraft.delivery`, …) | `types.ts` |

### Code TODOs

None. `git grep -E "TODO|FIXME|XXX|HACK"` over `packages/runtime/src`, `sim/src`, `realapps/src`, `demos/src` and
the `training` scripts at b435acb finds nothing; `packages/runtime/src` and `packages/runtime/bin` are still clean at
f107013. Open work lives in HANDOFF, OPEN_TASKS, STATUS and the NEEDS files.

### Subsystem drift tracked elsewhere

Each refreshed subsystem doc has its own Drift section with more detail:
[public API](runtime/public-api-and-lifecycle.md#drift-and-open-issues), [observe](runtime/observe-and-trace.md),
[state](runtime/state-and-adapters.md), [situation](runtime/learn-situation-triage.md),
[decide](runtime/decide-policy-actions.md), [model host](runtime/model-host.md), [devtools](runtime/devtools.md),
[build, test and release](runtime/build-test-release.md), [model-io-contract.md](model-io-contract.md),
[sim.md](sim.md#drift-and-open-issues), [training.md](training.md#drift-and-open-issues),
[realapps.md](realapps.md#drift-and-open-issues), [demos.md](demos.md),
[genclass-model-lineage.md](genclass-model-lineage.md), [extension-and-benchmarks.md](extension-and-benchmarks.md).

## Related docs

- Agent docs: [README.md](README.md), [overview.md](overview.md), [repo-map.md](repo-map.md), [glossary.md](glossary.md),
  [playbooks.md](playbooks.md), [model-io-contract.md](model-io-contract.md), [sim.md](sim.md),
  [realapps.md](realapps.md), [training.md](training.md), [demos.md](demos.md),
  [genclass-model-lineage.md](genclass-model-lineage.md), [extension-and-benchmarks.md](extension-and-benchmarks.md),
  [../../AGENTS.md](../../AGENTS.md)
- Runtime agent docs: [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md),
  [runtime/observe-and-trace.md](runtime/observe-and-trace.md), [runtime/state-and-adapters.md](runtime/state-and-adapters.md),
  [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md),
  [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md), [runtime/model-host.md](runtime/model-host.md),
  [runtime/devtools.md](runtime/devtools.md), [runtime/build-test-release.md](runtime/build-test-release.md)
- Sources: [HANDOFF.md](../../HANDOFF.md), [OPEN_TASKS.md](../../OPEN_TASKS.md), [RELEASE.md](../../RELEASE.md),
  [docs/runtime/RESULTS.md](../runtime/RESULTS.md), [packages/runtime/STATUS.md](../../packages/runtime/STATUS.md),
  [docs/runtime/CONTRACT.md](../runtime/CONTRACT.md), [docs/runtime/API.md](../runtime/API.md),
  [docs/runtime/ARCHITECTURE.md](../runtime/ARCHITECTURE.md), [training/NEEDS.md](../../training/NEEDS.md),
  [training/PLAN-v1.md](../../training/PLAN-v1.md), [training/LOG.md](../../training/LOG.md),
  [training/EVAL.md](../../training/EVAL.md), [sim/NEEDS.md](../../sim/NEEDS.md),
  [sim/SEPARABILITY.md](../../sim/SEPARABILITY.md), [demos/NEEDS.md](../../demos/NEEDS.md),
  [packages/runtime/UI-NEEDS.md](../../packages/runtime/UI-NEEDS.md), [realapps/README.md](../../realapps/README.md),
  [packages/runtime-model/MODEL_CARD.md](../../packages/runtime-model/MODEL_CARD.md),
  [packages/runtime/INSTALL-NEEDS.md](../../packages/runtime/INSTALL-NEEDS.md),
  [packages/runtime/CHANGELOG.md](../../packages/runtime/CHANGELOG.md),
  [packages/runtime/test/install/RESULTS.md](../../packages/runtime/test/install/RESULTS.md),
  [.github/workflows/ci.yml](../../.github/workflows/ci.yml)
