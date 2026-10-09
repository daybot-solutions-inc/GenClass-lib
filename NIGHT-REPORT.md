# Night report: making web apps heal with @genclass/runtime (2026-10-09)

Branch `heal/overnight` (from `mvp-v2-b6` at da10256 = unpublished `0.1.0-beta.4`), local only: nothing was
published, pushed or deployed, nothing on Azure or Cloudflare was touched, and **telemetry was off in every run**
(`telemetry: false` in every GenClass mode of both harnesses, plus a browser-level block of every request to a host
other than 127.0.0.1; every run logged "no external requests"). Model: `@genclass/runtime-model@0.2.0`
(r17-v2dT, gain gate, profiles cautious / balanced / eager), q8 on WASM, served from a local `fetch-model`
directory (`.cache-model/runtime-model-0.2.0`, copied from Troy's self-hosted copy; sha256 verified by
`genclass-runtime info`).

## TL;DR

- **Healing is not happening yet, and runtime changes alone cannot make it happen with model 0.2.0.** Across the six
  demos (10 chaos + 5 clean seeds per demo and mode), the chaos bug rate is about the same in every mode:
  off 72–73%, observe 70–72%, guard 70–73%, heal 70–72% (both arms of the final A/B run).
  Guard and heal ran 1–3 actions per 60 chaos trials at the shipped (balanced) gates. The cause is the
  model's confidence, not the runtime: the gain gate needs ln(p(action) / p(passive)) above 4–8, and only 3–8% of
  the model's candidate actions get there (pooled over ~7,000 gated decisions, the median gain is about 0).
  Loosening the gate (eager profile, or margin 1 for every trigger) runs 3–15 times more actions but fixes nothing
  more and adds false interventions on clean runs (0 → 2–3 of 30).
- **What the runtime did wrong, and is now fixed** (four runtime commits, each with unit tests):
  1. a delivery `discard` on **Redux and Zustand stores was a silent no-op** whenever the stale write also changed
     other fields (the editor and board demos are exactly that case);
  2. **late reverts up to 2 s after a write** turned correct runs into visible bugs (every revert decided ≥ 0.88 s
     after its write ended in a bug, 5 of 5, two of them on clean runs); the window is now 800 ms;
  3. **fan-out polling looked stale to triage** (the status board asked the model 4–8 delivery questions per clean run
     about sibling responses of one poll tick, and guard/heal held those responses); siblings started by the same tick
     are no longer "newer data" for each other;
  4. opt-in **`policy.idempotencyBodyFields`**, so apps whose idempotency key is a JSON body field (Troy's
     `request_id`) can get `retry` offered.
- **False interventions on clean runs:** 0 of 30 per mode at the shipped gates, in the baseline, in the final runtime and in every Troy run (Troy clean scenarios: 0 decisions at all). False findings (detections on clean demo runs): 1–5 per 30 per mode, almost all real stale deliveries in the search demo, whose "clean" runs are not race-free.
- **Troy (real app, injected faults):** no user-visible bug in 8 of 9 scenarios in any mode, including out-of-order
  ticket polls (the app versions its order view). The one bug, a **duplicate order after a lost-commit 502 and a
  re-tap**, happens in every mode: GenClass detects the failure (`transient`) but does not act. With
  `idempotencyBodyFields: ["request_id"]` the model's top choice becomes `retry` (which the server would
  deduplicate), at gain 0.75 against a heal margin of 8 (5 eager), so it still does not run. 0 false interventions,
  no measurable latency cost.
- **Small samples.** With zero actions, two runs of the same mode differ by up to 4 bugs in 60 (timing: the
  model-loaded modes mount the app after the model is ready, and CPU load changes decision latency). Read every
  difference under ~5 points as noise.

## 1. What was built (step 1)

`bench/heal/` ([README](bench/heal/README.md)), commits 276344b and a815ab1:

- **Demos** (`demos/`: six apps with deliberate latent bugs under network chaos; Playwright with real keyboard and
  mouse; common random numbers): `cities.ts` recreated (real city names, synthetic populations) and un-ignored; an
  **observe** demo mode; `telemetry: false` everywhere; external requests aborted; knobs `--aggr`, `--gate`, `--sit`,
  `--dist` (serve a fixed snapshot build, so a long run is not disturbed by rebuilds); `falseFindings`,
  per-trigger decision counts and per-decision gate gains in the results; the demos now build against this
  checkout's runtime (before, `node_modules/@genclass/runtime` resolved into another worktree). `summarize.mjs`
  pairs guard/heal with off **and** with observe: observe loads the model like guard/heal (the trial page mounts the
  app after the model is ready, which shifts the world's scripted timing), so "vs observe" isolates what guard and
  heal's actions and holds did, and "vs off" is the user-facing total.
- **Troy** (`troy/troy-bench.mjs`): nine scenarios (3 clean, 6 with injected faults: lost commit, transient 5xx,
  slow add + double tap, out-of-order poll, failed removal, everything slow) against the production build in mobile
  Chromium, scored from the server's truth; `swap-runtime.sh` runs Troy on this checkout's runtime without touching
  its tracked files.
- **Not run: realapps never-worse sweeps.** `realapps/` needs its own `npm install` (about 50 framework packages, none
  installed on this machine) and its esbuild/svelte toolchain. Tonight's runtime changes leave the passive path (what
  the all-passive interference sweep checks) unchanged apart from triage (fewer delivery decisions), so it was not
  worth the disk and the hour. It is next step 2.

## 2. Baseline: `0.1.0-beta.4` (da10256) + model 0.2.0

### 2.1 Demos, shipped default (balanced), 10 chaos + 5 clean seeds per demo and mode

Columns: chaos bug rate; bugs fixed / introduced against off and against observe on the same seeds; non-passive
actions run on chaos trials; false interventions on clean trials; false findings (detections) on clean trials;
clean trials with a bug; the demo's user-visible latency on clean trials (median, ms).

#### off

| demo | bugs (chaos) | fixed/intro vs off | vs observe | actions (chaos) | FI (clean) | false findings | clean bugs | clean p50 ms |
|---|---|---|---|---|---|---|---|---|
| search | 20% (2/10) | – | – | 0 | 0/5 | 0 | 0 | 25 |
| editor | 100% (10/10) | – | – | 0 | 0/5 | 0 | 0 | 783 |
| checkout | 70% (7/10) | – | – | 0 | 0/5 | 0 | 0 | 205 |
| status | 100% (10/10) | – | – | 0 | 0/5 | 0 | 0 | 1521 |
| board | 40% (4/10) | – | – | 0 | 0/5 | 0 | 0 | 21 |
| decisions | 100% (10/10) | – | – | 0 | 0/5 | 0 | 0 | 0 |
| **all** | **72%** (43/60) | – | – | 0 | 0/30 | 0 | 0 | |

#### observe

| demo | bugs (chaos) | fixed/intro vs off | vs observe | actions (chaos) | FI (clean) | false findings | clean bugs | clean p50 ms |
|---|---|---|---|---|---|---|---|---|
| search | 20% (2/10) | 0/0 | – | 0 | 0/5 | 2 | 0 | 25 |
| editor | 90% (9/10) | 1/0 | – | 0 | 0/5 | 0 | 0 | 793 |
| checkout | 70% (7/10) | 0/0 | – | 0 | 0/5 | 0 | 0 | 207 |
| status | 100% (10/10) | 0/0 | – | 0 | 0/5 | 0 | 0 | 855 |
| board | 50% (5/10) | 0/1 | – | 0 | 0/5 | 0 | 0 | 23 |
| decisions | 90% (9/10) | 1/0 | – | 0 | 0/5 | 0 | 0 | 88 |
| **all** | **70%** (42/60) | 2/1 | – | 0 | 0/30 | 2 | 0 | |

#### guard

| demo | bugs (chaos) | fixed/intro vs off | vs observe | actions (chaos) | FI (clean) | false findings | clean bugs | clean p50 ms |
|---|---|---|---|---|---|---|---|---|
| search | 20% (2/10) | 0/0 | 0/0 | 2 | 0/5 | 3 | 0 | 32 |
| editor | 90% (9/10) | 1/0 | 0/0 | 0 | 0/5 | 1 | 0 | 794 |
| checkout | 70% (7/10) | 0/0 | 0/0 | 0 | 0/5 | 0 | 0 | 199 |
| status | 100% (10/10) | 0/0 | 0/0 | 0 | 0/5 | 0 | 0 | 960 |
| board | 60% (6/10) | 0/2 | 0/1 | 0 | 0/5 | 0 | 0 | 11 |
| decisions | 90% (9/10) | 1/0 | 0/0 | 0 | 0/5 | 0 | 1 | 91 |
| **all** | **72%** (43/60) | 2/2 | 0/1 | 2 | 0/30 | 4 | 1 | |

#### heal

| demo | bugs (chaos) | fixed/intro vs off | vs observe | actions (chaos) | FI (clean) | false findings | clean bugs | clean p50 ms |
|---|---|---|---|---|---|---|---|---|
| search | 20% (2/10) | 0/0 | 0/0 | 3 | 0/5 | 2 | 0 | 21 |
| editor | 100% (10/10) | 0/0 | 0/1 | 0 | 0/5 | 0 | 0 | 790 |
| checkout | 70% (7/10) | 0/0 | 0/0 | 0 | 0/5 | 0 | 0 | 205 |
| status | 100% (10/10) | 0/0 | 0/0 | 0 | 0/5 | 0 | 0 | 997 |
| board | 60% (6/10) | 0/2 | 0/1 | 0 | 0/5 | 0 | 0 | 21 |
| decisions | 90% (9/10) | 1/0 | 0/0 | 0 | 0/5 | 0 | 1 | 67 |
| **all** | **73%** (44/60) | 1/2 | 0/2 | 3 | 0/30 | 2 | 1 | |

One honesty note on this run: about a third of the way in, the demos were rebuilt in place by mistake (same
runtime source, the new build only added the per-decision gate log), so later trials carry gate logs and earlier
ones do not; a few trials waited for the Service Worker update. Later runs serve fixed snapshot builds (`--dist`).

Off bug reasons (chaos, 60 trials): editor "lost text the user typed" 10/10; status error banners 10/10 and healthy
services shown failing 9/10; decisions wrong defaults (leave 12, backup 6, health 3); checkout duplicate orders 4,
wrong charges 7, total drift 7; board wrong column 4; search stale results 3. Every one of these reaches the model
(failure, request, delivery or mutation decisions fire on them); none is acted on.

Search "clean" runs are not race-free: short prefixes are slower on the mock server, so an older answer can still
land after a newer one. Its 2–3 false findings are real stale deliveries that the oracle tolerates (< 400 ms).

### 2.2 Profiles and a looser gate (guard / heal totals over the six demos)

| configuration | guard: chaos bugs | actions | FI clean | heal: chaos bugs | actions | FI clean |
|---|---|---|---|---|---|---|
| cautious | 72% (43/60) | 0 | 0/30 | 77% (46/60) | 0 | 0/30 |
| **balanced (default)** | 72% (43/60) | 2 | 0/30 | 73% (44/60) | 3 | 0/30 |
| eager | 73% (44/60) | 6 | **2/30** | 75% (45/60) | 12 | 0/30 |
| margin 1 for every trigger (`--gate 1,1`), beta.4 | 70% (42/60) | 20 | **3/30** | 77% (46/60) | 39 | **3/30** |
| margin 1, with tonight's fixes (dff696a) | 72% (43/60) | 14 | 0/30 | 73% (44/60) | 44 | 1/30 |

Cautious ran no action at all and still differs from balanced by 2 bugs in heal: that is the noise floor. Eager's
extra actions included late reverts of the board's own move confirmations (`mutation:discard` of the POST
response's write; both runs ended with the card in the wrong column), heal retries of failed first page loads
(which did not save those runs) and discards on clean search runs. The margin-1 rows ran under heavy CPU load
(three evals at once); they show that the model's mild preferences are not reliably right, not a tuned result.

### 2.3 Why the model does not act: candidate gains (every gated decision of every run, pooled)

The gain is ln(p(candidate) / p(passive)) with calibrated probabilities; an action runs when it exceeds the margin
of its tier and trigger (balanced: guard delivery 4, mutation 6, request 4; heal failure 8, request 1.5,
inconsistency 2, transition 0.5, otherwise 4).

| trigger:action | decisions | median gain | p90 | max | share ≥ 3 | share ≥ 4 |
|---|---|---|---|---|---|---|
| request:coalesce | 1629 | -0.31 | 0.91 | 3.17 | 0% | 0% |
| request:delay | 1436 | -0.72 | -0.18 | 2.20 | 0% | 0% |
| mutation:discard | 1432 | -0.02 | 3.56 | 12.12 | 14% | 8% |
| mutation:defer | 909 | -1.28 | -0.85 | 1.00 | 0% | 0% |
| delivery:discard | 834 | 0.12 | 1.48 | 4.59 | 5% | 3% |
| failure:retry | 826 | -0.28 | 1.70 | 6.14 | 7% | 7% |
| failure:serve_cached | 184 | -0.66 | 0.71 | 1.68 | 0% | 0% |
| transition:rollback | 152 | -1.82 | -1.35 | -0.14 | 0% | 0% |
| request:serve_cached | 118 | 0.11 | 0.96 | 1.76 | 0% | 0% |
| inconsistency:resync | 32 | -2.21 | -1.93 | 0.77 | 0% | 0% |
| request:block | 16 | -1.98 | -1.67 | -1.50 | 0% | 0% |
| stall:hedge | 6 | -0.27 | 0.03 | 0.03 | 0% | 0% |
| inconsistency:rollback | 5 | 1.63 | 1.77 | 1.77 | 0% | 0% |
| delivery:defer | 5 | -0.64 | -0.43 | -0.43 | 0% | 0% |

The model's top choice is often an action ("gain x of discard over deliver is not above the guard margin 4" is the
most common reason in every model mode), but rarely by a wide margin. All other reasons an action did not run
(hold budget, lateness, superseded) appeared fewer than five times in total: holds and timing do not limit healing.
The runtime applies calibration correctly (the per-question temperatures in `calibration.json` match the action
headers of mutation, request, delivery, failure and inconsistency; stall and transition fall back to the generic
choice temperature, as fitted).

### 2.4 Troy, balanced, 3 repetitions per scenario and mode (production build, mobile, 1 WASM thread)

| scenario | kind | bugs off / observe / guard / heal | latency p50 ms off / observe / guard / heal | decisions observe / guard / heal | detections | actions |
|---|---|---|---|---|---|---|
| add-once | clean | 0/3 / 0/3 / 0/3 / 0/3 | 20 / 23 / 28 / 25 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| add-two | clean | 0/3 / 0/3 / 0/3 / 0/3 | 31 / 30 / 30 / 60 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| order-remove | clean | 0/3 / 0/3 / 0/3 / 0/3 | 78 / 73 / 73 / 70 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| add-lost-commit | fault | 3/3 / 3/3 / 3/3 / 3/3 | 21 / 20 / 27 / 20 | 3 / 3 / 3 | 3 / 3 / 3 | 0 / 0 / 0 |
| add-transient-5xx | fault | 0/3 / 0/3 / 0/3 / 0/3 | 20 / 23 / 38 / 30 | 3 / 3 / 3 | 3 / 3 / 3 | 0 / 0 / 0 |
| add-slow-doubletap | fault | 0/3 / 0/3 / 0/3 / 0/3 | 1978 / 1979 / 1973 / 1974 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| order-poll-reorder | fault | 0/3 / 0/3 / 0/3 / 0/3 | 73 / 76 / 70 / 73 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| order-remove-5xx | fault | 0/3 / 0/3 / 0/3 / 0/3 | 2323 / 2276 / 2286 / 2294 | 6 / 6 / 6 | 3 / 3 / 3 | 0 / 0 / 0 |
| slow-all | fault | 0/3 / 0/3 / 0/3 / 0/3 | 919 / 919 / 924 / 936 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

External requests: none.

GenClass decides only on Troy's failures (its order state is React `useState`; there is no store for a delivery
decision to protect). Model decisions start once the model is loaded (~1 s); a fault in the first second fails
open, which is why the harness gives the guest 2.5 s to read each page.

## 3. What changed (commits on `heal/overnight`)

| commit | change | evidence | tests |
|---|---|---|---|
| 276344b, a815ab1 | benchmark harness, docs | | demos typecheck |
| 8053b36 | **fix:** a delivery `discard` drops only the stale fields of Redux/Zustand writes (it applied them whole: a no-op whose record still named the fields as dropped) | reproduced in a unit test: the delivery discard dropped nothing, and a second, mutation-level revert then threw away the non-stale part of the write too | `test/discard-adapters.test.ts` |
| 2eaa134 | **feat:** opt-in `policy.idempotencyBodyFields` | Troy lost commit: `retry` becomes the model's top choice (gain 0.75 < margin 8) | `test/idempotency-body.test.ts` |
| dff696a | **perf:** fan-out siblings are not newer data (delivery triage) | status demo, clean: 126 delivery decisions over 15 clean runs, all "expected", held in guard/heal; the unit test reproduces 6 → 0 | `test/fanout-triage.test.ts` |
| 47f292c | **fix:** late-revert window 2 s → 800 ms | late reverts decided ≥ 0.88 s after their write: 5 of 5 ended in a bug (2 on clean search runs: the right results replaced by older ones for ~1.9 s); ≤ 0.65 s: 5 of 7 fine | `test/late-revert-window.test.ts` |

No model-visible text changed: `git diff da10256 -- packages/runtime/src/situation` touches only `repeatUnsafe`
(which actions are offered; opt-in, default unchanged) and the `SitEnv`/`ReqMeta` types; the situation-purity and
exact-text tests pass unchanged. Before each runtime commit: `tsc`, `tsup`, the unit suite without browser tests
(final: 58 files, 528 passed, 14 skipped (the model-parity tests that need `GENCLASS_MODEL_DIR`), up from 375 + 14 at f107013) and `test/review-perf.test.ts` alone (4/4 on an idle machine; under a load average of 40 its
1 ms-per-dispatch bound fails at 1.37 ms, before and after these changes alike).

## 4. Final vs baseline (both arms run at the same time, same seeds, same load)

Baseline arm: da10256 runtime (snapshot `baseline-k`); final arm: 47f292c (snapshot `fix3`). Both: model 0.2.0 balanced, 10 chaos + 5 clean seeds, 4 workers each, run simultaneously.

#### off

| demo | ab-baseline: bugs | fixed/intro vs off | vs observe | actions (chaos) | FI (clean) | false findings | clean bugs | clean p50 ms | ab-final: bugs | fixed/intro vs off | vs observe | actions (chaos) | FI (clean) | false findings | clean bugs | clean p50 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| search | 20% (2/10) | – | – | 0 | 0/5 | 0 | 0 | 20 | 20% (2/10) | – | – | 0 | 0/5 | 0 | 0 | 20 |
| editor | 90% (9/10) | – | – | 0 | 0/5 | 0 | 0 | 770 | 90% (9/10) | – | – | 0 | 0/5 | 0 | 0 | 784 |
| checkout | 70% (7/10) | – | – | 0 | 0/5 | 0 | 0 | 213 | 70% (7/10) | – | – | 0 | 0/5 | 0 | 0 | 206 |
| status | 100% (10/10) | – | – | 0 | 0/5 | 0 | 0 | 1515 | 100% (10/10) | – | – | 0 | 0/5 | 0 | 0 | 1515 |
| board | 50% (5/10) | – | – | 0 | 0/5 | 0 | 0 | 49 | 60% (6/10) | – | – | 0 | 0/5 | 0 | 0 | 16 |
| decisions | 100% (10/10) | – | – | 0 | 0/5 | 0 | 0 | 0 | 100% (10/10) | – | – | 0 | 0/5 | 0 | 0 | 0 |
| **all** | **72%** (43/60) | – | – | 0 | 0/30 | 0 | 0 | | **73%** (44/60) | – | – | 0 | 0/30 | 0 | 0 | |

#### observe

| demo | ab-baseline: bugs | fixed/intro vs off | vs observe | actions (chaos) | FI (clean) | false findings | clean bugs | clean p50 ms | ab-final: bugs | fixed/intro vs off | vs observe | actions (chaos) | FI (clean) | false findings | clean bugs | clean p50 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| search | 20% (2/10) | 0/0 | – | 0 | 0/5 | 0 | 0 | 28 | 20% (2/10) | 0/0 | – | 0 | 0/5 | 1 | 0 | 13 |
| editor | 90% (9/10) | 0/0 | – | 0 | 0/5 | 1 | 0 | 796 | 90% (9/10) | 0/0 | – | 0 | 0/5 | 1 | 0 | 792 |
| checkout | 70% (7/10) | 0/0 | – | 0 | 0/5 | 0 | 0 | 213 | 70% (7/10) | 0/0 | – | 0 | 0/5 | 0 | 0 | 216 |
| status | 100% (10/10) | 0/0 | – | 0 | 0/5 | 0 | 0 | 492 | 100% (10/10) | 0/0 | – | 0 | 0/5 | 0 | 0 | 777 |
| board | 60% (6/10) | 1/2 | – | 0 | 0/5 | 0 | 0 | 39 | 50% (5/10) | 2/1 | – | 0 | 0/5 | 0 | 0 | 20 |
| decisions | 90% (9/10) | 1/0 | – | 0 | 0/5 | 0 | 2 | 105 | 90% (9/10) | 1/0 | – | 0 | 0/5 | 0 | 1 | 93 |
| **all** | **72%** (43/60) | 2/2 | – | 0 | 0/30 | 1 | 2 | | **70%** (42/60) | 3/1 | – | 0 | 0/30 | 2 | 1 | |

#### guard

| demo | ab-baseline: bugs | fixed/intro vs off | vs observe | actions (chaos) | FI (clean) | false findings | clean bugs | clean p50 ms | ab-final: bugs | fixed/intro vs off | vs observe | actions (chaos) | FI (clean) | false findings | clean bugs | clean p50 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| search | 20% (2/10) | 0/0 | 0/0 | 3 | 0/5 | 2 | 0 | 14 | 20% (2/10) | 0/0 | 0/0 | 1 | 0/5 | 5 | 1 | 13 |
| editor | 80% (8/10) | 1/0 | 1/0 | 0 | 0/5 | 0 | 0 | 793 | 90% (9/10) | 0/0 | 0/0 | 0 | 0/5 | 0 | 0 | 799 |
| checkout | 70% (7/10) | 0/0 | 0/0 | 0 | 0/5 | 0 | 0 | 218 | 70% (7/10) | 0/0 | 0/0 | 0 | 0/5 | 0 | 0 | 205 |
| status | 100% (10/10) | 0/0 | 0/0 | 0 | 0/5 | 0 | 0 | 1204 | 100% (10/10) | 0/0 | 0/0 | 0 | 0/5 | 0 | 0 | 847 |
| board | 60% (6/10) | 0/1 | 1/1 | 0 | 0/5 | 0 | 0 | 23 | 70% (7/10) | 1/2 | 0/2 | 0 | 0/5 | 0 | 0 | 33 |
| decisions | 90% (9/10) | 1/0 | 0/0 | 0 | 0/5 | 0 | 1 | 119 | 90% (9/10) | 1/0 | 0/0 | 0 | 0/5 | 0 | 2 | 88 |
| **all** | **70%** (42/60) | 2/1 | 2/1 | 3 | 0/30 | 2 | 1 | | **73%** (44/60) | 2/2 | 0/2 | 1 | 0/30 | 5 | 3 | |

#### heal

| demo | ab-baseline: bugs | fixed/intro vs off | vs observe | actions (chaos) | FI (clean) | false findings | clean bugs | clean p50 ms | ab-final: bugs | fixed/intro vs off | vs observe | actions (chaos) | FI (clean) | false findings | clean bugs | clean p50 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| search | 20% (2/10) | 0/0 | 0/0 | 1 | 0/5 | 1 | 0 | 15 | 10% (1/10) | 1/0 | 1/0 | 1 | 0/5 | 4 | 0 | 15 |
| editor | 90% (9/10) | 0/0 | 0/0 | 0 | 0/5 | 0 | 0 | 761 | 100% (10/10) | 0/1 | 0/1 | 0 | 0/5 | 0 | 0 | 793 |
| checkout | 80% (8/10) | 0/1 | 0/1 | 0 | 0/5 | 0 | 0 | 225 | 70% (7/10) | 0/0 | 0/0 | 0 | 0/5 | 0 | 0 | 210 |
| status | 100% (10/10) | 0/0 | 0/0 | 0 | 0/5 | 0 | 0 | 618 | 100% (10/10) | 0/0 | 0/0 | 0 | 0/5 | 0 | 0 | 570 |
| board | 40% (4/10) | 1/0 | 2/0 | 0 | 0/5 | 0 | 0 | 36 | 60% (6/10) | 1/1 | 1/2 | 0 | 0/5 | 0 | 0 | 46 |
| decisions | 90% (9/10) | 1/0 | 0/0 | 0 | 0/5 | 0 | 2 | 118 | 90% (9/10) | 1/0 | 0/0 | 0 | 0/5 | 0 | 2 | 87 |
| **all** | **70%** (42/60) | 2/1 | 2/1 | 1 | 0/30 | 1 | 2 | | **72%** (43/60) | 3/2 | 2/3 | 1 | 0/30 | 4 | 2 | |

Totals (six demos, 60 chaos + 30 clean trials per mode and arm): guard 70% → 73% chaos bugs, heal 70% → 72%,
observe 72% → 70%, off 72% → 73% (off has no GenClass action at all: that last pair is pure run-to-run noise).
Actions on chaos trials: guard 3 → 1, heal 1 → 1; false interventions on clean runs 0/30 → 0/30 in every mode.
**Healing did not measurably change**, as expected from §2.3: tonight's fixes act on the rare actions the model
does take (and on what is decided at all), not on whether it acts.

Where the changes do show (observe + guard + heal trials pooled, baseline → final):

| demo | kind | model decisions per trial | delivery decisions | decision latency p50 / p90 (ms) |
|---|---|---|---|---|
| status | clean | 8.5 → **3.9** | 63 → **0** | 2,431 / 4,427 → 3,306 / 4,737 |
| status | chaos | 6.3 → 6.8 | 15 → **4** | 3,282 / 4,708 → 2,105 / 4,735 |
| search | chaos | 2.5 → 2.4 | 18 → 16 | 737 / 1,862 → 612 / 2,098 |
| editor | chaos | 9.7 → 9.7 | 79 → 81 | 709 / 2,603 → 576 / 2,315 |
| board | chaos | 7.1 → 7.4 | 65 → 60 | 1,295 / 3,445 → 1,346 / 2,956 |

- **Fan-out triage (dff696a):** the status dashboard's clean runs no longer ask about (or, in guard/heal, hold)
  sibling poll responses: delivery decisions 63 → 0, all model decisions per clean run 8.5 → 3.9. Status chaos
  delivery decisions 15 → 4; overlapping-round staleness is still decided (unit test).
- **Late-revert window (47f292c):** no late revert ran in either arm at the shipped gates (they only appear when the
  model is confident, §2.2), so this run cannot show it; the evidence is the 5-of-5 table in §3.
- **Discard on Redux/Zustand (8053b36):** no delivery discard ran on the editor or board in either arm (gains below
  the margin), so it is also invisible here; it matters as soon as the model acts on those stores.
- Decision latencies in this A/B are 3–10 times the ones of the first baseline (p50 ~150 ms): the two arms plus two
  situation-budget runs and Troy shared the CPU (load average up to ~30). That load hits both arms alike, but it
  also means the held-delivery path was rarely available; on an idle machine the numbers in §2.1 apply.

### Troy, final runtime (47f292c swapped into Troy's installed package)

| scenario | kind | bugs off / observe / guard / heal | latency p50 ms off / observe / guard / heal | decisions observe / guard / heal | detections | actions |
|---|---|---|---|---|---|---|
| add-once | clean | 0/3 / 0/3 / 0/3 / 0/3 | 32 / 32 / 30 / 31 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| add-two | clean | 0/3 / 0/3 / 0/3 / 0/3 | 33 / 32 / 33 / 32 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| order-remove | clean | 0/3 / 0/3 / 0/3 / 0/3 | 76 / 76 / 78 / 76 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| add-lost-commit | fault | 3/3 / 3/3 / 3/3 / 3/3 | 30 / 32 / 31 / 32 | 3 / 3 / 3 | 3 / 3 / 3 | 0 / 0 / 0 |
| add-transient-5xx | fault | 0/3 / 0/3 / 0/3 / 0/3 | 31 / 30 / 31 / 30 | 3 / 3 / 3 | 3 / 3 / 3 | 0 / 0 / 0 |
| add-slow-doubletap | fault | 0/3 / 0/3 / 0/3 / 0/3 | 1991 / 1991 / 1981 / 1985 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| order-poll-reorder | fault | 0/3 / 0/3 / 0/3 / 0/3 | 79 / 79 / 72 / 72 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| order-remove-5xx | fault | 0/3 / 0/3 / 0/3 / 0/3 | 2291 / 2292 / 2295 / 2302 | 6 / 6 / 6 | 3 / 3 / 3 | 0 / 0 / 0 |
| slow-all | fault | 0/3 / 0/3 / 0/3 / 0/3 | 924 / 931 / 923 / 921 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

External requests: none.

Same picture as the baseline: the duplicate order after a lost commit in every mode (3/3), nothing else, no action,
no false intervention, and no latency difference between off and the GenClass modes (medians within ±2 ms). A first
final run made while the demos A/B was running had 3 failures in 108 trials, including in off (no GenClass
installed): the harness's re-tap window (100 ms) and chip read (50 ms timeout) were too tight for a loaded machine.
The harness was hardened (one re-tap after 2.2 s; chip read waits up to 1 s when the chip exists) and the run
repeated on an idle machine; that run is the table above. Both are in `bench/heal/results/troy/`.

## 5. What did not help (measured, not shipped)

- **Eager profile and margin 1 everywhere**: more actions, no fewer bugs, false interventions on clean runs (§2.2).
  For this model the shipped balanced default is the right operating point; cautious acts on nothing.
- **Recognising body keys such as `request_id` by default**: not shipped. The model does not retry at the shipped
  margins anyway, and a server that does not deduplicate would get duplicates. It stays opt-in.
- **A larger situation budget** (3,200 characters, the WebGPU size the model was trained on 40% of the time, instead of the 2,000 that `auto` gives 4-thread WASM): no gain uplift (delivery discard max gain 4.05 → 1.23, request coalesce 2.40 → 3.17, mutation and failure unchanged), no action either way, chaos bugs within noise (guard 72% → 68%, heal 68% → 73%), decision latency +36% (p50 847 → 1,152 ms under load). The `auto` budget stays as it is.

## 6. Proposals that need retraining or a format change (not shipped)

1. **Model confidence is the bottleneck.** The benchmark's decisions are labelled examples: for each gated decision
   it records trigger, diagnosis, candidate and gain, and the trial's oracle says whether the user saw a bug. Export
   them (situation text + counterfactual outcome, realapps-style) to pick scenarios for realapps/sim generation;
   keep the demos themselves held out (AGENTS.md rule 4).
2. **Never revert the user's own confirmation.** Eager reverted the board's POST /move response write as stale (the
   SSE echo had arrived first). A fact such as "this write is the server's answer to the user's own pending
   action" is a situation-format change (v2.x) and needs data.
3. **Re-tap after an ambiguous failure (Troy's duplicate order).** The second POST differs from the first only in
   its fresh `request_id`, so it is not "identical", and one failure in a row is a neutral fact: the clear bug never
   reaches the model. Normalising configured key fields out of request identity changes repetition facts
   (model-visible) and needs data on 502s that did and did not commit.
4. **Coverage for state outside GenClass** (Troy keeps orders in React state; GenClass sees only the network):
   TanStack Query / SWR adapters (query key → field path, `setQueryData` through the pipeline) would give delivery
   decisions to the most common fetch-driven state with one wrapper. On Troy it would not have fixed anything (its
   poll/mutation ordering is versioned; the out-of-order scenario shows no bug in any mode); build it with realapps
   evidence (TanStack and SWR apps are in the corpus).
5. **`gc.ask` on clean runs.** The decisions demo's health question was answered "failing"/"poor" on a clean run in
   every model mode (off's default answer is right): a clean bug introduced through `ask`, model-side.
6. **Mutation triage for fan-out siblings.** dff696a changes delivery salience only. The writes of a signature's first
   completion (nothing predicted yet) are triaged as mutations and still look stale to each other; the fact
   neutrality lives in `situation/facts.ts` and changes which situations reach the model, so it belongs with the next
   data generation.

## 7. Next steps

1. Review and merge `heal/overnight` into the shipping line (four runtime commits; CHANGELOG "Unreleased"; nothing
   here needs a new situation tag).
2. Run the realapps never-worse sweep on a VM with the corpus installed (`node dist/harness/debug.js --interference
   1-3 --clean`, then without `--clean`) to confirm the triage and late-revert changes on all 128 apps.
3. Re-run `bench/heal/run-demos.sh` at N=30 on an otherwise idle machine; tonight's runs shared the CPU (load 5–40),
   which moves decision latency and therefore late reverts.
4. Proposal 1 (training rows from the benchmark situations), then re-measure the next model with the same harness:
   a more confident model shows up directly in the gains table and the actions columns.
5. Troy: its installed runtime was restored to the beta.4 tarball (`swap-runtime.sh restore`) and its production
   build removed; its tracked files were never modified.
