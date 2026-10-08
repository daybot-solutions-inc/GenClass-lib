# Project status, ground rules, open work, known issues and doc drift

> **Scope:** `HANDOFF.md`, `OPEN_TASKS.md`, `docs/runtime/RESULTS.md`, `packages/runtime/STATUS.md`, `demos/NEEDS.md`,
> `sim/NEEDS.md`, `training/NEEDS.md`, `training/PLAN-v1.md`, `training/LOG.md`, `packages/runtime/UI-NEEDS.md`,
> `docs/runtime/{CONTRACT,API,ARCHITECTURE}.md`, `README.md`, `packages/runtime/README.md`, `realapps/README.md`,
> `.github/workflows/ci.yml`, git history and tags, code TODO markers, and the 2026-10-08 review of the situation-v2
> work. Cross-checked against `packages/runtime/src/**`, `packages/runtime/bin/genclass-runtime.mjs`,
> `packages/runtime/package.json`, `sim/src/**`, `realapps/**` and `training/**`.
> **Read this when:** you land in the repo cold and need to know what is shipped, what runs on Azure right now, what
> comes next and who owns it; before any change that could break a binding rule (situation text, determinism,
> dependencies, where to run things); before trusting a human doc over the code; when you pick up one of the review
> findings; when you finish work and must update STATUS/NEEDS/OPEN_TASKS/HANDOFF.
> **Source of truth:** the code. Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins.

## TL;DR

Path convention in this doc: `src/…`, `test/…` and `bin/…` are relative to `packages/runtime/`; bare runtime module
paths (`runtime.ts`, `types.ts`, `util.ts`, `state/hub.ts`, `situation/content.ts`, `decide/policy.ts`,
`model/host.ts`, …) are relative to `packages/runtime/src/`. Every other path is from the repo root.

- **Branches.** `mvp-v2` (this doc) = `origin/runtime` 74f17c0 (the colleague Mehar's latest: runtime batches 4 and
  5, situation-v2, `realapps/`, v2 curriculum port, `HANDOFF.md`, `docs/runtime/RESULTS.md`) plus three local
  commits: 7dab2b3 (AGENTS.md, CLAUDE.md, `docs/agents/**`), f3636b2 (default mode `observe`), b435acb (CI workflow,
  committed root `package-lock.json`, `bin/genclass-runtime.mjs` as 100755). `mvp-v2` is **not pushed**
  (`git branch -vv`: "ahead 3" of `origin/runtime`). The local branch `mvp` (b15415b, based on 654d822 =
  situation-v1) is superseded. `main` and `origin/main` are still 654d822.
- **Shipped on npm:** `@genclass/runtime@0.1.0-alpha.0` (`latest`, git tag `v0.1.0-alpha.0` = 654d822). It predates
  situation-v2, defaults to `guard`, has no model, and predates the NaN fix (ad24804: `util.ts` -> `describe`
  recursed forever on a `NaN` store value). A `0.1.0-alpha.1` patch waits on the owner's 2FA (`OPEN_TASKS.md`
  "Needs the user"). `@genclass/runtime-model` is **not published** (404).
- **Runtime on `mvp-v2`:** situation-v2, decisions at the network boundary (`delivery` trigger,
  `RuntimeImpl.runDelivery`), no store-write holds by default (`policy.holdWrites` false), default mode `observe`
  (`runtime.ts` -> `o.mode ?? "observe"`). Verified when these docs were written, on 2026-10-08 (macOS, Node v25.6.0): `tsc` clean,
  `tsup` OK, unit tests 40 files passed + 1 skipped (41), 332 tests passed + 14 skipped, plus `review-perf` alone
  4 passed: **350 tests, 14 model-parity skips**. CI (`.github/workflows/ci.yml`) exists but has never run on
  GitHub (branch not pushed).
- **Frozen:** the model's input format is frozen at tag **`situation-v2`** (annotated tag → commit 6e5e86e,
  "Frozen runtime situation format v2"). `git diff situation-v2 b435acb -- packages/runtime/src` touches only
  `runtime.ts`, `types.ts` and `devtools/index.ts` (f3636b2's default-mode change); `situation/` is identical.
  `situation-v1` (1a77558) is superseded: R17-final1 and every other checkpoint trained so far do **not** match this
  runtime.
- **Running on Azure now** (lead's read-only portal look, 04:14 UTC 2026-10-08, resource group `rg-jev-train`):
  `vm-jev-c01`…`c23` (F80) and `vm-jev-train` running, `vm-jev-data` deallocated. Per `training/NEEDS.md`, SIM is
  generating situation-v2 data on 20 nodes (c02–c09, c12–c23: ≥ 10M gold + ≥ 50M unlabeled into
  `train:/data/sim-out/v2-*`) and REAL real-browser gold rows on c01, c10, c11 (≥ 500k target; batches
  `v2b1`/`v2b2`/`v2b3`). Mehar operates the cluster. **Nobody on our side touches Azure.**
- **No situation-v2 model exists.** Next (HANDOFF "Current state"): 150M teacher (T150) on v2 gold → teacher labels
  on unlabeled rows → distil R17 (default) and R32 → DAgger via SIM `--on-policy` → EVAL →
  `@genclass/runtime-model@0.1.0` → demos rerun → `@genclass/runtime@0.1.0` (owner's 2FA).
- **Default install today:** `GenClass.init()` starts in `observe`, tries the unpublished model URL, ends in model
  status `error` and logs `[GenClass] Model unavailable (<error>); observing only.` From then on it traces and learns
  but never builds a situation or decides. No test covers this path.
- **Binding rules** (CONTRACT §0, §0.5, §13): no hardcoded bug rules; one situation implementation (frozen at
  situation-v2); determinism through the injected `Clock`; sim/realapps never read demos; one runtime dependency;
  precision first, default `observe`. Our run policy replaces CONTRACT §0 rule 5 for this machine (light checks
  local; ask before anything heavier, Azure, `git push`, `npm publish`).
- **Coordination files:** `HANDOFF.md` (start here for Mehar's sessions), `OPEN_TASKS.md`, `docs/runtime/RESULTS.md`
  (results and comparisons; "update it with every result"), `packages/runtime/STATUS.md` (CORE), per-workstream
  `NEEDS.md` (`training/NEEDS.md` also holds Azure node claims and data locations).
- **Review of the situation-v2 work (2026-10-08): 52 confirmed findings, none left uncertain.** The worst: the F2
  fact prints raw text of redacted fields (`situation/content.ts` -> `contentFacts`); a delivery `discard` is a
  silent no-op on redux/zustand stores (`state/hub.ts` -> `StoreHub.applyFilter`); unlabeled SIM rows hard-label
  `expected` diagnoses that S1 would relabel; SIM still samples the v1 3,200-char budget for 40% of trajectories
  while v2 data is generated. Several touch model-visible text or the live data run: coordinate with the user (and
  through them Mehar) before fixing. Full list: [Review of the situation-v2 work](#review-of-the-situation-v2-work-2026-10-08).
- **Docs drift.** `HANDOFF.md` still says `guard` is the default (both READMEs and `OPEN_TASKS.md` are fixed in the
  working tree, pending commit); `CONTRACT.md` has no `delivery` trigger
  and its §13 default-mode entry still says situation-v1 data "stays valid"; `docs/runtime/ARCHITECTURE.md`
  still says 3,200 chars. Tables in [Doc drift](#doc-drift-project-and-coordination-files). No TODO/FIXME/XXX/HACK
  markers in code.

## Files

| path | role | key content |
|---|---|---|
| `HANDOFF.md` | Mehar's hand-off for continuing Claude sessions (updated 2026-10-08) | current state table (npm, git, runtime, model, data, training), repo map, hard-won rules (8 GB Mac, Azure, zsh, freeze, licensing, commits), "How to continue" |
| `OPEN_TASKS.md` | Project status (owner inferred: lead) | Done / In progress / Next (stale, see Drift) / Model quality / Needs the user / Known risks |
| `docs/runtime/RESULTS.md` | Results, comparisons and training log (Mehar, 2026-10-08) | §1 model stages, §2 R17 vs R32, §3 v1 vs v2 separability, §4 never-worse sweep, §5 demos (v0.1 baseline), §6 data volume, §7 training log; FIR next to every recall number |
| `packages/runtime/STATUS.md` | CORE's status (batch 5, 2026-10-08) | State (VM test counts, perf, never-worse sweep), batch 5 and batch 4 changes with "Contract deltas", batch 3, headless recipe, trigger table, example situations, **Deviations**, **Open issues** |
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
| `README.md`, `packages/runtime/README.md` | Repo landing page; npm README | say `observe` is the default (working tree, pending commit) |
| `packages/runtime-model/MODEL_CARD.md` | Model card for the unpublished `@genclass/runtime-model` | status "final round 1 on the frozen runtime (situation-v1)"; the only tracked file in `packages/runtime-model/` |
| `.github/workflows/ci.yml` | CI (b435acb) | Node 22, `ONNXRUNTIME_NODE_INSTALL=skip`, `npm ci`, typecheck and build of `@genclass/runtime`, unit tests without `test/browser/**` and `review-perf`, then `review-perf` with `--retry=2` |
| `package-lock.json` (root) | committed in b435acb | CI runs `npm ci` from it; keep it in sync |
| `AGENTS.md`, `CLAUDE.md`, `docs/agents/**` | Agent docs (7dab2b3, refreshed for v2) | run policy, commands, ground rules, subsystem docs |
| `scripts/vm.sh` | Mehar's way to build/test on the `train` VM (`sync`, `run`, `exec`, `get` per SLOT) | needs `~/.jev-local/azure_hosts` and `~/.ssh/jev_azure` (not in repo); we do not use it without asking |
| `packages/runtime/test/review-*.test.ts` | REVIEW's regression tests (10 files) | must pass unchanged |
| `packages/runtime/test/smoke/smoke.sh` | npm tarball smoke test (Vite app, headless Chromium) | runs with `model: false`; ask before running |
| `docs/CONTRACT.md`, `docs/CONTRACT-v2.md`, `docs/SPEC.md`, … | **Legacy jev-local docs**, not the runtime contract | CONTRACT §1: "stays as is. Do not edit it." |

[RELEASE.md](../../RELEASE.md) at the repo root (untracked in the working tree, not in b435acb) is the release
procedure: Part A for `0.1.0-alpha.1`, Part B for the model and `0.1.0`. `extension/RELEASE.md` is the legacy
Chrome-extension release note.

## Concepts and data structures

### People, workstreams and ownership

Every commit up to 74f17c0 is by Mehar Khanna (messages prefixed "Mehar commit: …"); he ran the original
multi-agent team (lead, CORE, MODEL, UI, SIM, REAL, DEMOS, TRAIN, REVIEW) and operates the Azure cluster and the npm
org (`genclass`, owner meharpro). 7dab2b3, f3636b2 and b435acb are by Karan (this repo's user). The roles below belong
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

`git diff --stat 654d822 b435acb`: 451 files, +90,715 / −20,699. Earlier history (13 commits from 7a7ff6d to
654d822, all Mehar's) is legacy GenClass content, the runtime build-up and batch 3 / `situation-v1`.

### Version markers

| marker | value at b435acb | meaning |
|---|---|---|
| `mvp-v2` | b435acb, not pushed | this branch |
| `origin/runtime`, local `runtime` | 74f17c0 | Mehar's line; HANDOFF says "push to `origin runtime` as you go" |
| `main`, `origin/main` | 654d822 | not updated since the alpha |
| `mvp` (local) | b15415b on 654d822 | superseded |
| tag `situation-v1` | → 1a77558 | v1 format; superseded |
| tag `situation-v2` | annotated tag object 75df720 → commit 6e5e86e | **current frozen training format** |
| tag `v0.1.0-alpha.0` | → 654d822 | the published alpha |
| `packages/runtime/package.json` `version` | `0.1.0-alpha.0` | not bumped |
| `@genclass/runtime-model@0.1.0` | not published (404); `packages/runtime-model/` tracks only `MODEL_CARD.md` | default `model.baseUrl` |
| GitHub release `runtime-model-v0.1.0` | no such tag in the repo; the CLI's default `--from` 404s (per the lead) | |
| v0.1 GenClass model | `https://github.com/MeharPro/GenClass/releases/download/v0.1.0/` | general classifier, **not** a runtime model; used by demos and model tests |
| R17-final1 / R32-final1 | situation-v1; on the `train` VM (`~/gcl/train-out/final1/`) and Mehar's Mac (`packages/runtime-model/files/r17/`, gitignored) | baseline only; does not match the v2 runtime |

### Status at b435acb

| item | state | owner | evidence |
|---|---|---|---|
| Runtime batches 4 and 5 (situation-v2) | done, frozen | CORE | fcd1e68, 6e5e86e; STATUS; `test/delivery.test.ts`, `no-reorder.test.ts`, `content.test.ts` |
| Default mode `observe` | done on `mvp-v2` only (not on `origin/runtime`, not on npm) | us (f3636b2) | `runtime.ts` -> `RuntimeImpl` constructor; `test/default-mode.test.ts`; CONTRACT §13 |
| CI | workflow committed; never run on GitHub | us (b435acb) | `.github/workflows/ci.yml` |
| NaN fix | in code since ad24804; **not on npm** | CORE | `util.ts` -> `describe`; `test/nan.test.ts`; `sim/NEEDS.md` g still says OPEN |
| npm `0.1.0-alpha.0` | published (guard default, no model, v1) | lead | tag `v0.1.0-alpha.0` |
| npm `0.1.0-alpha.1` (NaN fix) | waiting on the owner's 2FA | user | OPEN_TASKS "Needs the user" |
| SIM v1 phase A / B | done (600,676 / 1,415,344 rows); superseded | SIM | training/NEEDS "SIM → TRAIN: scaled data" |
| Final round 1 (situation-v1) | done: R17 81.9% action / 90.5% diagnosis, guard FIR 0.05%, heal FIR 0.24%, ECE 0.009; guard recall on clear stale/duplicate 7.7% | TRAIN | `training/EVAL.md`, RESULTS §1 |
| T1 runs and v1 teacher `t150-g1` | stopped at the v2 freeze, no results | TRAIN | `training/LOG.md` 01:13–03:35 |
| SIM v2 gold + unlabeled | **generating** on 20 nodes (≥ 10M + ≥ 50M) | SIM | HANDOFF; training/NEEDS claim table |
| REAL v2 production | **generating** on c01, c10, c11 (`v2b1`–`v2b3`, 30k trajectories each, ≥ 500k gold target); v2 pilot done (2,519 gold incl. 135 `delivery`) | REAL | training/NEEDS 16 |
| v2 teacher, students, DAgger, EVAL | not started | TRAIN | PLAN-v1 P1–P5 |
| `@genclass/runtime-model@0.1.0`, then `@genclass/runtime@0.1.0` | not started | lead / user | HANDOFF "How to continue" step 3 |
| Demos with a trained model | not started (numbers are v0.1 only) | DEMOS | RESULTS §5 |
| Public demo hosting; merge into `main` | waiting on the user | user | OPEN_TASKS "Needs the user" |

## How it works

### 1. What a default install does today

1. The app calls `GenClass.init()`. `index.ts` -> `initUnsafe` reads the kill switch (URL `?genclass=`, else
   `localStorage.genclass`; `off` installs nothing; `observe|guard|heal` override the mode). Otherwise it sets
   `model: {}` and calls `createRuntime`.
2. `RuntimeImpl`'s constructor sets `this._mode = o.mode ?? "observe"`: **observe** unless the app asks for guard.
   (The npm alpha.0 still defaults to guard.)
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
7. Before step 5 (status `off`), a salient trigger builds a situation, fails open and starts the load. A salient
   delivery can wait up to `BODY_WAIT_MS` (100 ms) for its body even then (review finding DL-3).

Even with a model, `observe` takes no action: decisions are made in the background and reported
(`test/default-mode.test.ts`). The only way to see decisions today is to self-host a model: no model matches
situation-v2, the v0.1 model only exercises the pipeline (`npx genclass-runtime fetch-model <dir> --from
https://github.com/MeharPro/GenClass/releases/download/v0.1.0/`; a model download, so ask the user first).

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
- **Claims** (training/NEEDS "Cluster expansion and claims"): SIM c02–c09 + c12–c23 for the v2 runs, each node
  deallocated when its share is collected; REAL c01, c10, c11 until its batches finish; TRAIN holds no node; TRAIN
  plans the teacher on c12–c23, students on c02–c11 and the workbench on c01 once v2 data lands.
- **Data locations:** SIM `train:/data/sim-out/v2-*` (check run: `v2chk-{gold,unl}`); REAL `c01:~/gcl/real-out/v2b1/`,
  `c10:…/v2b2/`, `c11:…/v2b3/` (copied to `train:/data/real-out/` when done), v2 pilot `train:/data/real-out/v2-pilot/`.
  All from training/NEEDS; not checkable from here.
- **Spend:** about $400 to date (RESULTS §7); PLAN-v1 estimates $3–4k for P0–P5.

## Configuration and constants

Status-relevant values only; the subsystem docs list the rest.

| name | value at b435acb | defined in | effect |
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
| `BODY_WAIT_MS` | 100 | `runtime.ts` | a salient delivery waits this long for its body clone |
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
   Data is being generated from this code right now: never make such a change without the user's go-ahead.
   Behaviour-only runtime fixes (most delivery findings) do not change wording but do change SIM/REAL dynamics and
   therefore labels: coordinate them too.
3. **Determinism (§0 rule 3).** No `Math.random`, `Date.now`, `performance.now` or global `setTimeout` in runtime
   code; the injected `Clock`; ids from counters. Re-checked at b435acb: the only hits are `model/engine.ts`
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
- **Two defaults in the wild.** `mvp-v2` defaults to `observe`; `origin/runtime` and npm alpha.0 default to `guard`.
  The tests' `setup()` defaults to `guard` on purpose.
- **"Observe never changes execution" is not quite true yet**: a salient delivery can wait up to 100 ms for its body
  and XHR completion listeners run outside the original dispatch (finding DL-3).
- **The runtime is frozen.** See ground rule 2. `git diff situation-v2 HEAD -- packages/runtime/src/situation` must stay
  empty unless the user approved a new format.
- **R17-final1 is a v1 model.** Do not load it into this runtime, ship it, or compare v2 numbers against it as if the
  formats matched.
- **Tests are not type-checked.** `packages/runtime/tsconfig.json` includes only `src`.
- **Test counts differ by branch.** STATUS and HANDOFF say 41 files / 346 tests (origin/runtime, on the VM with a
  model dir). On `mvp-v2`: 42 files, 350 tests (f3636b2 added `test/default-mode.test.ts`); without a model dir 14
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
2. For (a)–(c), get the user's go-ahead and agree with Mehar whether it lands before or after the current v2
   generation. For (d), edit freely (docs owned by the right workstream).
3. Add the regression test the finding suggests, in a new or existing non-review test file.

**Change anything the model reads (after `situation-v2`)**
1. Get the user's go-ahead (it invalidates the v2 data being generated).
2. Change only `src/situation/*` plus `util.ts` helpers if needed; update STATUS example situations.
3. Tell SIM, REAL (regenerate) and TRAIN (`rt.py` mirror; per-header calibration keyed on exact instruction text,
   training/NEEDS 5). Expect a new tag (`situation-v3`).
4. Run the light checks locally (commands in [runtime/build-test-release.md](runtime/build-test-release.md)).

**Fix doc drift**
1. Confirm the behaviour in code first; code wins.
2. Edit the doc owned by the right workstream (CONTRACT: lead; STATUS/API: CORE; NEEDS: requester).
3. JSDoc in `types.ts` is safe; `BUILTIN_ACTIONS` descriptions and `DEFAULT_DIAGNOSES` are model input (frozen).

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
| `test/review-*.test.ts` (10) | REVIEW's batch-3 findings; must pass unchanged. `review-perf` times 5,000-item stores (run alone; CI retries it twice) |
| `test/batch3.test.ts`, `budget.test.ts`, `situation.test.ts`, `policy.test.ts`, `smoke.test.ts` | redaction by meaning, section limits and auto budgets (2,400 on WebGPU), one situation per trigger, the §8 gate, smoke paths (explicit `mode: "guard"`) |
| `test/model/*.test.ts` | 14 model-parity tests skip without `GENCLASS_MODEL_DIR` |
| `test/smoke/smoke.sh` | packed tarball in a Vite app in headless Chromium with `model: false` (ask before running) |
| `sim` (`SIM_RUNTIME=real npx vitest run`) | 19 tests, 5 files, against the built runtime |
| `training/tests/test_curriculum.py` | the v2 curriculum test (passes per the situation reviewer; not run by the lead) |

Not run by us: Playwright specs, `smoke.sh`, realapps sweeps, demos eval, Python tests, training. `realapps/` has no
tests at all.

## Drift and open issues

### Open work (aligned with HANDOFF, OPEN_TASKS and the release recipe)

| owner | item | state |
|---|---|---|
| SIM (Mehar) | v2 gold ≥ 10M and unlabeled ≥ 50M on 20 nodes | running; budget skew (SIT-2) and unlabeled `expected` labels (ST-1) affect it |
| REAL (Mehar) | v2 production `v2b1`–`v2b3` (≥ 500k gold), copy to `train:/data/real-out/` with the eval set | running; see RA-* before using the data |
| TRAIN | import v2 SIM/REAL data (`import_final.sh` cannot read the v2 gz-shard layout, ST-8), T150 teacher on gold (PLAN P1), teacher eval as the separation gate (P2), soft-label unlabeled rows (P3), distil R17/R32 (P4), DAgger ×3 (P5), EVAL per trigger/budget/held-out set, calibration, export, parity | not started; several scripts untested (ST-2 to ST-7) |
| lead / user | `@genclass/runtime-model@0.1.0` + GitHub release `runtime-model-v0.1.0`; rerun demos; `@genclass/runtime@0.1.0` without the alpha tag | after EVAL |
| user | publish `0.1.0-alpha.1` (2FA; npm 11 needs `--tag` for a prerelease per build-test-release.md). Decide which tree it is cut from: the NaN fix alone, or `mvp-v2` with situation-v2 and the observe default | waiting |
| user | push `mvp-v2` (first CI run), merge into `runtime`/`main`; public demo hosting | waiting |
| Mehar / user | re-enable the Azure auto-shutdown schedules when the push ends; deallocate idle nodes | open |
| CORE | review findings DL-1…DL-12 (behaviour) and SIT-1, SIT-3, SIT-8, SIT-10, SIT-11 (model-visible text) | open; see [How to change it safely](#how-to-change-it-safely) |
| SIM / REAL | SIT-2 (budget weights), ST-1, ST-6, ST-9…ST-11, RA-1…RA-12 | open |
| TRAIN | `rt.py` parity SIT-4…SIT-7, SIT-9, SIT-12, SIT-13; scripts ST-2…ST-5, ST-7, ST-8 | open |
| CORE | `retry` still offered for non-idempotent POSTs (heal tier; `builtinApplicable` checks only `replayable && attempt < 4 && fetch`) | open (demos/NEEDS §5); SIT-11 makes it worse for 502 |
| CORE | `rollback` description ("last consistent snapshot") vs chain revert; unreachable fact "This write could not be held: …" (`StoreHub.propose` commits unholdable writes without observing them) | open; the first is model input |
| CORE / lead | a test for the shipped default path (model 404 → `error` → observe only) | none exists |
| MODEL | device-based model selection in the host card | not started |
| UI | overlay ignores `Explanation.message` (`devtools/index.ts` has no `.message` use) | open |
| DEMOS | rerun with the trained v2 model (Off/Observe/Guard/Heal, clean-run FIR); commit `cities.ts`; pass `untrustedEvents` for the synthetic driver (DL-11) | open |
| docs | HANDOFF default mode, CONTRACT v2 deltas and redaction rule, ARCHITECTURE budget, stale NEEDS items (SIT-14, table below) | open |

### Decisions waiting on the user / repo owner

1. `0.1.0-alpha.1`: publish (2FA) and from which tree.
2. Push `mvp-v2`, merge into `runtime` and `main` (`main` is still 654d822; the old "looks merged" note no longer holds).
3. Public demo hosting (GitHub Pages).
4. Which review fixes land before vs after the running v2 generation (SIT-2, ST-1 and DL-2 affect data being produced
   now), and whether text-changing fixes justify `situation-v3`.
5. Shipping models: R17 default on every device (RESULTS §2 decision for v1); R32 for WebGPU only if clearly better.

### Known risks

- **The v2 data run carries known defects.** SIM samples budget 3,200 for ~40% of trajectories (SIT-2); unlabeled rows
  keep `expected` labels that S1 would flip (ST-1, fixable by a relabel pass); delivery-discard semantics under review
  (DL-1, DL-2) shape the counterfactual costs. Filtering or relabelling is cheaper than regenerating; decide before
  training starts.
- **The teacher may not separate the cases.** PLAN-v1: if T150 is also near 40% argmax on clear rows, the bottleneck
  is the situation information, not model size. v1 → v2 separability improved but is far from solved (RESULTS §3:
  linear recall at 1% FIR 6% → 11% on failure, 11% → 15% on request).
- **Targets not met by any model yet:** diagnosis ≥ 95% (v1: 90.5%) and clear-case recall ≥ 80% (v1: 7.7% guard on
  clear stale/duplicate). Guard FIR ≤ 0.1% and ECE ≤ 0.02 were met in v1.
- **Curriculum ≠ runtime.** `rt.py` is called runtime-exact but diverges on several common cases (SIT-4…SIT-7,
  SIT-9, SIT-12, SIT-13).
- **Never-worse evidence is narrower than claimed.** The 0/396 sweep compares final visible text and server content
  only, covers 66 of 91 apps, and never compares observe against no runtime (RA-1, RA-6, RA-10). Under chaos, 3/198
  runs changed from request-time holds (RESULTS §4).
- **Single-thread WASM speed**: R17 ≈ 177 / 323 / 589 ms at 500 / 780 / 1,170 tokens (RESULTS §2); hold budgets cap at
  800 ms, so slow devices fail open more.
- **Label noise**: costs come from K = 3 sampled futures; S2 re-draws unobservable latents but not for impatient
  re-clicks (ST-6).
- **Cost and operations**: auto-shutdown disabled; label/eval scripts can mark work done after failures (ST-2, ST-4);
  a crashed Chromium drains a REAL worker's queue (RA-2).
- **Stale npm alpha**: users who install today get guard default, v1 situations and the NaN crash.
- **Privacy**: the F2 fact leaks redacted text (SIT-1) and the leaf redactor regressed on numbers/arrays under
  secret containers (SIT-3 in the table, "low").

### Review of the situation-v2 work (2026-10-08)

Five reviewers checked `git diff 654d822 b435acb` by area (delivery, situation, sim-train, realapps, project docs),
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
- **Project docs:** HANDOFF says guard is the default.

#### Delivery (runtime network-boundary path)

| id | sev | where (file -> symbol) | finding and scenario | suggested fix |
|---|---|---|---|---|
| DL-1 | high | `packages/runtime/src/state/hub.ts` -> `StoreHub.applyFilter` | Delivery `discard` is a silent no-op on redux/zustand stores, but the `ActionRecord` claims the writes were dropped. Guard, redux `{items, loading}`: a newer op writes `items=['pushed-newer']`, the stale response dispatches `LOADED {items:['v2']}`; final state `['v2']`, record says "dropped the state changes it makes over newer data (list.items)" with `dropped: []`, and no mutation decision follows. The atom variant ends correctly with `['pushed-newer']`. | Apply the kept changes as a patched whole value through the store's `io.set` (redux `GENCLASS_REPLACE`, zustand `outer(v, true)`); else report honestly (ok:false or a reason, `op.delivery.overNewer`, leave `decided` false so the mutation trigger can decide or late-revert). Build `changed` from `mark.dropped` after the fact. Add redux and zustand variants of the discard test. |
| DL-2 | medium | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.dropFilter` / `RuntimeImpl.writtenOver` | A discard mark drops the fresh writes of later ops chained from the discarded op (polling chains, sagas) for 10 s. Guard: stale poll p2 is discarded, its handler schedules the next poll; p4 (cause chain p4 → timer → p2) returns fresh `v=103` and is dropped ("dropped the write of doc.v by GET /api/doc?slow=0&p=4 (#10) over newer data"); `loading`/`status` fields can stick. | Scope the mark to the discarded response's own writes: stop the cause walk at the first op with its own `delivery` record (`if (x.delivery && !x.discardMark) return null`), or compute `writtenOver` against the nearest network op. Regression test with a `setTimeout`-chained poll. Decide with Mehar whether it lands before or after the current v2 generation. |
| DL-3 | medium | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.runDelivery` | Observe mode (the new default) still holds deliveries: up to 100 ms waiting for the body, and XHR/WS listeners run outside the original dispatch. Measured: network answered at +500 ms, the app's fetch resolved at +600 ms, same as guard; an observe-mode XHR `readystatechange` ran with `inDispatch=false` and `load` saw `currentTarget=null`. | At the top of `runDelivery`, check whether a hold is possible (`permittedActions(this.policy, this._mode, TRIGGER_ACTIONS.delivery).length > 0 && this.expectedLatency() <= this.holdBudgetMs()`); if not, `rel()` synchronously first and do body analysis and the background trigger (F9 marks, detection) without holding. Default-mode tests for fetch and XHR with a conflicting delivery and a slow body. |
| DL-4 | medium | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.trigger` / `runDelivery` `ctl.stale` | Background (non-held) delivery decisions are always dropped as stale: delivery standing questions are never answered in observe mode, and every salient delivery's situation is built for nothing. `rt.question({ on: ["delivery"], always: true })` + one fetch: 0 answers in observe, 1 in guard; with triage `always`, observe decisions are `request`/`mutation`, never `delivery`. | Pass `stale` only for held submissions (`waits ? stale : undefined`), or skip building the situation when it will not be held and no standing question forces it. If background delivery decisions are kept, mark the writes covered when the decision lands. Correct "every trigger is decided" wording in docs/agents. |
| DL-5 | medium | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.runDelivery` `ctl.run('defer')` / `waitOps` | `defer` can hold a response, or a whole WS/SSE channel, for 20 s regardless of the hold budget (`waitOps` waits up to `LONG_RUNNING_MS` = 10 s per defer, at most 2 defers). Guard, WS `/live`, a long-poll `GET /api/feed` in flight, model answers `defer`: message delivered at +20,000 ms; every later message on the socket waits too. | Bound a delivery defer by the hold budget (`waitOps(related, Math.min(LONG_RUNNING_MS, k * this.holdBudgetMs()))`); offer defer only when related ops are expected to finish soon; for push channels do not offer it while messages are queued behind (`queuedAhead`), or cap it more tightly. |
| DL-6 | medium | `packages/runtime/src/observe/messages.ts` -> `MessageGate.pump` | Held WebSocket/EventSource messages are dispatched after the app called `close()`. Guard, triage `always`: held message, app calls `ws.close()` (readyState 2), decision releases it: the listener receives `{"n":1}` with readyState 2. | Before dispatching a queued `MessageEvent`, check `readyState`: drop when a WebSocket is not OPEN (1) or an EventSource is CLOSED (2); end/emit the op as dropped; still dispatch queued close/error events. Or wrap `close()` to flush or drop the queue. |
| DL-7 | medium | `packages/runtime/src/state/hub.ts` -> `StoreHub.gateAndQueue` / `StoreHub.flushQueue` | `holdWrites` (opt-in): a held write applied early by `flushQueue` flips back to state `resolved`; a late discard is then recorded as a drop while the write stays applied. Policy `{holdWrites:true, holdBudgetMs:100}`: record reads "Dropped the write to a.v from task bg (#1); a stays at version 2." with nothing reverted. | In `gateAndQueue`'s `held.then` and its `catch`, return early when `m.state === "done"`; make `proceeded` robust with `m.outcome !== undefined`. |
| DL-8 | low | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.dropFilter` (via `StoreHub.propose` -> `applyFilter`) | Discard marks keep dropping app writes after `rt.pause()` and `setMode("observe")`. Guard: stale response discarded, its handler applies data 500 ms later; pause (or observe) in between: the write is still dropped. | Return null from `dropFilter` when `this.paused \|\| this.destroyed \|\| this._mode === "observe"` (or call `applyFilter` only when gating); clear active `discardMark`s in `pause()`, `destroy()` and `setMode("observe")`. |
| DL-9 | low | `packages/runtime/src/observe/eventsource.ts` -> `installEventSource` / `MessageGate.ensure` | EventSource `open` is not order-kept behind held messages, and the re-dispatched error clone reports a spurious channel "down". Triage `always`: open, message (held), error (queued), open: the app saw `open, open, message, error`. | Queue `open` with the orderOnly handler (like close/error); in the raw open/error/close listeners ignore the gate's own re-dispatched copies (expose `gate.isMine(e)`). |
| DL-10 | low | `packages/runtime/src/observe/xhr.ts` -> `installXHR` -> `gateCall` / `arrive` | XHR completion listeners run after the event's dispatch ended (`e.currentTarget === null`): `(e) => JSON.parse(e.currentTarget.responseText)` throws a TypeError for a held XHR (guard) or in observe mode with a conflict. | Invoke queued listeners with an event whose `currentTarget` is the xhr (Proxy, or `Object.defineProperty(ev, "currentTarget", { value: xhr, configurable: true })` plus `eventPhase` 2), or re-dispatch fresh events as `MessageGate` does. |
| DL-11 | low | `packages/runtime/src/observe/dom-user.ts` -> `installDomUser` -> `programmatic` | `untrustedEvents` defaults to false, so the demos site's in-page synthetic driver now records no user actions; decisions diverge from the Playwright driver for the same script (regresses demos/NEEDS §7). | Pass `observe: { untrustedEvents: true }` from the demos' `startGenClass` when the synthetic driver is used (or always on the demo site); update the `programmatic` comment. |
| DL-12 | low | `packages/runtime/src/observe/messages.ts` -> `MessageGate.intercept` | (Not verified in a browser.) A capture-phase WS/SSE message listener (`addEventListener('message', h, { capture: true })`) sees a held message twice: at arrival and at release. | Register the interceptor with `{ capture: true }` (it still runs first), or wrap `addEventListener` for message types as `xhr.ts` does. |

#### Situation format, redaction and the curriculum port

| id | sev | where (file -> symbol) | finding and scenario | suggested fix |
|---|---|---|---|---|
| SIT-1 | high | `packages/runtime/src/situation/content.ts` -> `contentFacts` | The F2 fact prints the raw text of redacted fields (bypass via `stringDiff`). Store `settings = {apiKey: "sk_live_AAAA…"}`, an autosave PUT in flight, the user types into the key field: every other section shows `settings.apiKey = [redacted]`, but the first fact quotes `"…AAAAAAAAAAAAAA SECRET99" → "…AAAAAAAAAAAAAA" (removes " SECRET99")`. Same with a custom redactor hiding a PII free-text field. | Use `stringDiff` only when both values pass the redactor unchanged (`Object.is(env.redact(c.path, c.current), c.current) && Object.is(env.redact(c.path, c.incoming), c.incoming)`), or route through `changeText({path, before, after}, env.redact)`. Tests with a sensitive key and a custom redactor. Changes model-visible text only for redacted fields. |
| SIT-2 | medium | `sim/src/world/scenario.ts` -> `budget` | SIM still samples the v1 3,200-char budget for 40% of trajectories while v2 data is generated on Azure (`[[3200, 40], [2000, 30], [1000, 30]]`). Measured: `toJevState(p, 3200)` 3,010 chars vs `toJevState(p, 2400)` 2,198 for identical parts; ~35% more tokens in teacher labelling and distillation, and R17/R32 train on longer sections than production shows. | Use the v2 device budgets, e.g. `[[2400, 35], [2000, 20], [1667, 5], [1333, 5], [1000, 35]]` (= `rt.py` `BUDGETS`), fix the JSDoc, tell Mehar before more v2 shards are produced; existing shards can be filtered by `meta.budget == 3200`. Optionally clamp `toJevState` to `STATE_CHAR_BUDGET × budgetScale`. |
| SIT-3 | low | `packages/runtime/src/util.ts` -> `isSensitivePath` / `defaultRedact` | The new leaf-based default redactor no longer redacts numbers or arrays under secret-named containers (regression vs 654d822): `defaultRedact("payment.cvv.value", 123)` → 123, `("login.otp.code", 123456)` → 123456, `("lock.pin.value", 1234)` → 1234; `account.password.history` arrays likewise. They then appear in state lines, deltas, timeline and facts. | Under a strong (non-broad) secret container, redact every non-boolean, non-null value (strings, numbers, bigint, arrays) before the early return that should only short-circuit the broad-container opaque test. Add the cases to `test/review-redaction.test.ts`. Model-visible. |
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
| PD-1 | resolved in the working tree (pending commit) | `README.md` -> Modes / "How it works" 5; `packages/runtime/README.md` -> Modes | Both READMEs still say guard is the default; a user reading the npm README after the next publish expects guard protection from `GenClass.init()` and gets observe, which takes no action. | Mark observe as the default and guard as opt-in (heal experimental) in both, change the example to `GenClass.init({ mode: "guard" })`, add a note on the change. |
| PD-2 | resolved in the working tree (pending commit) | `OPEN_TASKS.md` -> In progress / Next | The body is stale and contradicts HANDOFF: "Final data, phase A" and "Final training round 1 on phase A" read as current work (following them spends Azure compute on v1 training), batch 4 sits under Next though done, and items 3 and 4 appear twice. | Move batches 4 and 5 to Done; replace phase A / round 1 with the v2 pipeline from HANDOFF; renumber. |
| PD-3 | resolved in the working tree (pending commit): the Loading bullet now says there is no model for this runtime yet | `packages/runtime/README.md` -> Status note | Tells users to self-host with `npx genclass-runtime fetch-model`; there is no v2 model, so they get a 404, or load a v1 model into the v2 runtime and get wrong decisions. | Remove the suggestion until `@genclass/runtime-model@0.1.0` is published, or say no compatible model exists yet. |

**Uncertain findings:** none (the reviewers' uncertain list is empty).

### Doc drift: project and coordination files

| file | stale statement | reality at b435acb |
|---|---|---|
| `HANDOFF.md` ("Modes: observe → guard (default; …)") | guard is the default | `observe` (`runtime.ts`) |
| `HANDOFF.md` "Current state" | "346 tests pass"; "66 real apps"; "Push to `origin runtime` as you go" | 350 tests on `mvp-v2`; 91 apps in `realapps/` ([realapps.md](realapps.md)); our policy: ask before pushing |
| `docs/runtime/CONTRACT.md` | no `delivery` trigger (§6); §4 mutations "held until a decision arrives"; §6 budget "≤ 1,000 tokens"; §8 `holdBudgetMs` "default 300"; §2 redaction regex and observer list without `eventsource`/`untrustedEvents`; §13 default-mode entry: "`situation-v1` training data stays valid" | batch 4/5 deltas exist only in STATUS; no store-write holds by default; 2,400-char budget; "auto" hold budget; leaf-field redaction (SIT-14); the entry should say situation-v2 (mode does not change situation text: `src/situation/*` has no mode dependency) |
| `docs/runtime/ARCHITECTURE.md` | "3,200 characters on WebGPU, 2,000 with WASM threads"; redaction regex | 2,400 on WebGPU and unknown devices, 2,000 only at 4 threads (`STATE_CHAR_BUDGET`); leaf-field rule |
| `docs/runtime/API.md` | mostly current for v2; still advises `fetch-model` without `--from`; "observe … nothing is held" | the default model 404s; observe can still wait up to 100 ms on a salient delivery (DL-3). Full API drift: [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md#drift-and-open-issues) |
| `packages/runtime/STATUS.md` | Open issues: "`react-dom` is not a devDependency"; "Content comparison facts … not implemented yet"; never-worse "same requests, bodies, server state and DOM"; 41 files / 346 tests | `react-dom ^19.3.0` is a devDependency; F1/F2/F3 shipped in batch 5 (`situation/content.ts`); the sweep compares less (RA-1); 42 files / 350 tests on `mvp-v2` |
| `docs/runtime/RESULTS.md` §4, §6 | "0/396" never-worse; "66 → ~96 apps" | covers 66 of 91 apps and final text/server content only (RA-1, RA-6) |
| `packages/runtime-model/MODEL_CARD.md` | "`files/r17/` here"; clear-case recall "≈ 5%" | `files/` is gitignored (only `MODEL_CARD.md` is tracked); EVAL.md gives guard 4.2% on all clear rows, 7.7% on clear stale/duplicate, heal 6.1% |
| `sim/NEEDS.md` g | NaN crash OPEN | fixed in ad24804 (`util.ts` -> `describe` uses `Object.is`; `test/nan.test.ts`) |
| `demos/NEEDS.md` | "Runtime: frozen batch 3"; §1 holds reorder writes, §2 hold latency, §6 EventSource not observed, §7 synthetic events recorded | batch 4: no store-write holds by default and opt-in holds never reorder; holds only when the model can answer in time, superseded decisions dropped; `observe/eventsource.ts`; synthetic events now need `untrustedEvents` (DL-11). §5 (`retry` on POST) is still open |
| `packages/runtime/UI-NEEDS.md` | Open 1 (ignore the overlay), Open 2 (`react-dom`), Nice-to-have 3 (`Explanation.message`) | 1 done (`observe/dom-user.ts` -> `ignoredEvent`); 2 done (devDependency); 3 done on the CORE side, the overlay still ignores it |
| `training/NEEDS.md` 10 | quota "1,024 vCPU … exactly the whole cluster" | HANDOFF / RESULTS: raised to 2,048 vCPU, c12–c23 added |
| `realapps/README.md` | 66 apps; "Run it" env-var pinning; `situation-v1` example tag | 91 apps; RA-12 |

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
the `training` scripts at b435acb finds nothing. Open work lives in HANDOFF, OPEN_TASKS, STATUS and the NEEDS files.

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
  [.github/workflows/ci.yml](../../.github/workflows/ci.yml)
