# realapps: a real-browser, real-app training corpus for GenClass Runtime

The simulator (`sim/`) runs combinator-built apps in Node. Real apps differ: React batches renders on a
MessageChannel scheduler, Vue and Svelte flush in microtasks, TanStack Query and SWR dedupe and retry on their own,
axios and jQuery use XMLHttpRequest, Redux middleware reorders dispatches, and app code has its own guards and bugs.
`realapps/` closes that sim-to-real gap. It runs real web apps, built with real frameworks, in **headless Chromium**
with the **real `@genclass/runtime`**. It labels every sampled runtime decision by **counterfactual outcome**, with
the same row format, cost terms and label rule as the sim.

```
realapps/
  apps/<name>/            66 apps (52 written for the corpus + 14 open-source): manifest.ts (Node side) + source;
                          apps/README.md = authoring guide
  apps/_shared/           genclass.ts (the app's one-line integration), atom bridges (Vue, Svelte), Conduit manifest
  corpus/                 open-source apps: oss.json (repo, commit, licence), patch_oss.py, prepare_oss.sh,
                          vite.oss.config.mjs, LICENSES.md
  src/world/              in-page world (one IIFE, injected before any page script): loop.ts (virtual time),
                          server.ts + ext/conduit.ts (mock backend), net.ts + netapi.ts (fetch/XHR/WebSocket + chaos),
                          user.ts (scripted user), probe.ts (recording decider, hooks, snapshots), diagnose.ts
  src/harness/            Node side: scenario.ts, trajectory.ts, cost.ts, labels.ts, browser.ts, gen.ts (worker
                          pool), worker.ts, debug.ts (inspection, determinism and interference sweeps)
  scripts/                analyze.py (stats + sim comparison), evalset.py, examples.py (audit printer),
                          node_setup.sh, cluster.sh, chromium_probe.mjs (the event-loop facts below, measured)
  build.mjs               bundles the world, the harness and every app (esbuild; Vite apps via corpus/)
  EXAMPLES.md             audited example rows (situation, labels, per-action costs)
```

Nothing runs on the Mac. Build, test and generate on the VMs (see "Run it").

## The app corpus

Diversity is the point: frameworks, state libraries, data libraries, and the latent async bugs real apps have, each
mixed with the correct guard. Every app reads feature flags (`flag(name, default)`) that select a guard or a latent
bug. The **first option** of each flag is the correct default; clean runs use only first options. Apps are ordinary
apps. None is written for a particular trigger rule.

- **Written for the corpus** (52 apps in `apps/<name>`; authoring rules in `apps/README.md`):
  - **React:** hooks, useGenClassState, useReducer, React 19 actions/`useOptimistic`, React Router 7 data APIs.
  - **State:** Redux Toolkit, RTK Query, redux-saga, Zustand, Jotai, Valtio, XState, effector, MobX, nanostores.
  - **Data:** TanStack Query (React, Vue, Svelte, Solid), SWR, axios, ky, ofetch, wretch, superagent, RxJS.
  - **Vue:** Vue 3 with template compiler, Pinia, vue-router; also petite-vue.
  - **Other frameworks:** Svelte 5, Solid, Preact (signals, htm), Lit and native custom elements (shadow DOM),
    Mithril, Hyperapp, Alpine, Knockout, Backbone.
  - **Low level:** jQuery (`$.ajax`, observe-only), vanilla TypeScript, raw XMLHttpRequest.

  Latent bugs: missing
  request-ordering guards, double submits, naive retries without idempotency keys, blind server echoes over newer
  typing, overlapping autosaves, optimistic updates without rollback, relative toggles, non-atomic derived counts and
  totals, cache/echo races, WebSocket reconnects without resync, response+push duplicates, concurrent token
  refreshes with rotating refresh tokens, assume-all-succeeded bulk operations, overlapping polls and retry storms.
- **Open source** (`corpus/oss.json`, licences in `corpus/LICENSES.md`, all MIT). Fourteen RealWorld "Conduit"
  front-ends run against a mock of the RealWorld API (`src/world/ext/conduit.ts`), each built with its own
  toolchain:
  - React 16 + Redux 3 + superagent;
  - React 18 + Redux Toolkit;
  - React + MobX 3 (decorators);
  - Vue 3 SFC + Pinia, and Vue 2 + Vuex;
  - Angular 21 (zoneless, signals) and AngularJS 1.5;
  - Svelte 3 + axios, and Solid;
  - native web components;
  - Elm 0.19, PureScript Halogen, ReScript React;
  - Ember Octane + Ember Data.

  The only change is the GenClass integration a developer would add (`corpus/patch_oss.py`), plus build
  configuration where an old toolchain no longer runs. Redux apps get `genclassEnhancer` on their store. The others
  get one init import (observe-only). These apps bring their own real bugs, for example:
  - gothinkster's promise middleware reads `error.response.body`, so one transient 5xx on the feed throws in a
    reducer and leaves the home page empty;
  - Vue 2's initial-feed 500 becomes an uncaught error;
  - the web-components app fetches tags twice and calls `.forEach` on error bodies;
  - ReScript's article dates are off by a month.

## Integration (the way a developer would do it)

Each app calls `GenClass.init(...)` once (`apps/_shared/genclass.ts`) and puts its state in runtime stores:
`rt.atom`, `useGenClassState`, `genclassEnhancer` (Redux, RTK), `genclass()` (Zustand), or `rt.guard` (Pinia,
MobX). A few atom bridges cover Vue (`useAtom`), Svelte (a store backed by an atom) and Solid/Preact/Lit. Some apps
are **observe-only** (jQuery, and the Vue and Solid Conduits). They register no stores but still produce request,
failure, stall and error rows. Their divergence is measured on the visible DOM.

The harness passes the init options through `window.__GENCLASS_INIT__`, the way a test setup configures an SDK. It
uses exactly the sim's seams:
- a recording `DecisionProvider` (`src/world/probe.ts`) that answers with probability 1 on the forced action;
- `policy: { thresholds: { report: 0, guard: 0.5, heal: 0.5 }, holdBudgetMs: 1e9, maxActionsPerMinute: 1e9, requireDiagnosis: false }`
  and `mode: "heal"`, `triage: "salient"`, `report: "silent"`;
- `hooks.opCreated` / `hooks.mutationProposed` and `EvaluateRequest.subject` to correlate decisions;
- `vocabulary` for wording randomisation and `situation.budget` (40% 3,200 / 30% 2,000 / 30% 1,000 chars).

The real observers stay on (fetch, XHR, DOM user events, errors, navigation, storage, WebSocket, timers), plus
`untrustedEvents` (the scripted user's events are synthetic). The only exception is `perf`: long-task timing is real
time, so it cannot be deterministic.

**Runtime version.** Apps bundle the runtime from source. Builds pin that source to a frozen git tag:
`RW_RUNTIME_SRC` is a `git archive <tag> packages/runtime/src` export and `RW_RUNTIME_TAG` is the tag. The tag is
recorded as `meta.runtime` in every row, so CORE's work in progress never leaks into data. The harness is
format-agnostic:
- it records whatever the runtime hands the decider;
- it forces actions only through the decider;
- it reads passive actions from the runtime's own `PASSIVE` map (a new trigger falls back to its first offered action);
- it has diagnosis rules for situation-v2's `delivery` trigger.

## Determinism: virtual time inside a real browser

`src/world/loop.ts` virtualises every macrotask source that app code, frameworks and the runtime use:
- `setTimeout` and `setInterval`, with Chromium's nesting clamp of 4 ms after 5 levels;
- `requestAnimationFrame` (60 Hz frames) and `requestIdleCallback`;
- `MessageChannel`, which React's scheduler and the runtime's `afterTask` use;
- `scheduler.postTask` and `AbortSignal.timeout`;
- `Date` and `performance.now`;
- `Math.random`, `crypto.getRandomValues` and `crypto.randomUUID`, all seeded.

Tasks run in (virtual time, phase, seq) order, and user input runs in a later phase than other tasks due at the same
instant. After each task the loop yields real macrotasks through a captured real `MessageChannel`, at about 5 µs per
yield, until every tracked native async operation has settled (`Response`/`Blob` body reads, stream reads). Microtask
chains and native follow-ups therefore complete inside the same virtual instant. Measured in Chromium:
`Response.json()` settles in microtasks, while a tee'd `clone()` needs about 3 real tasks. That is why mock
responses clone without tee-ing. Observers that depend on real layout timing (`ResizeObserver`,
`IntersectionObserver`, `PerformanceObserver`) are inert. Apps are served from memory at `https://app.example.com/`
through request interception, which is a secure context with no port in any URL. Every other host fails DNS
(`--host-resolver-rules`), so images and fonts never load on real time.

The network (`src/world/net.ts`, `netapi.ts`) is in-page, on virtual time. It provides `fetch` (real `Response`
objects), `XMLHttpRequest` (state machine and events, `responseType`, timeouts, abort) and `WebSocket`
(topics, per-socket ordering, drops with 1006). They are backed by the mock server (`src/world/server.ts`):
- collections with list, filter, search and paging;
- CRUD, optimistic-concurrency versions (409), and `Idempotency-Key` replay;
- relative non-idempotent actions, and bulk operations with per-id results;
- docs, counters, and auth with expiring tokens and rotating refresh tokens;
- full-cart echoes, versioned history (replica-lag reads), live publishing, and the Conduit extension.

Item ids are content-derived, so the same intent gets the same id in every run and an accidental duplicate gets a
new one. Every random draw for a request is keyed by (seed, future salt, request identity, occurrence), as in the
sim. Forcing an action at one decision therefore never shifts unrelated draws.

The user (`src/world/user.ts`) acts like `@testing-library/user-event`:
- pointer, mouse and focus sequences, then `el.click()`, so disabled buttons do nothing;
- keydown, keypress, beforeinput, a native value setter, input and keyup, so React's value tracker sees the change;
- `change` on blur, select changes, and Enter → `requestSubmit`.

These events are untrusted, and the runtime's DOM observer records them as user actions because no operation is
ambient when they run. Steps wait up to 2 s for their element. Clicks and submits that would navigate the page away
are prevented.

**Intents are pinned to the ideal run.** A scripted click targets a selector plus an index. When latency or stale data
reorders a list, the same index would hit a different item in the real run than in the ideal run, and the labels
would then reward blocking a legitimate request. So the ideal run records the identity of the list item each step
acted on: the words of its row, card or list item. Every other run clicks the visible element whose item matches
best (score ≥ 0.6). If that item never appears, the step is skipped and charged as a blocked intent.
- Accidental repeats (double clicks, impatient re-clicks) hit the same element again.
- Manifests can add runtime preconditions (`requires`) and chains (`then`). A follow-up is skipped at once when its
  chain head was skipped.
Snapshots read text inside open shadow roots (web components).

**Prefix check.** Every counterfactual run reproduces the base run's decisions `0..k` byte for byte. The hash of
`JSON([trigger, state, questions])` must match, or the row is dropped and counted (`drops.prefix-mismatch`).
`debug.js --twice` checks the whole run: decisions, snapshots, network log and server state.

## Labels (same semantics as the sim)

- **Ideal run.** The same session, zero latency, no chaos, no accidental or impatient clicks. It is exactly-once: an
  identical non-idempotent request repeated within 1 s with no user step in between shares the first one's result.
  The runtime is installed but blind (observe mode, every observer off, no decider). It records client snapshots and
  the server timeline.
- **Base run.** The real runtime with exploration ε ∈ {0, 0.08, 0.2}, applied to non-`expected` situations and at
  ε/4 elsewhere. It records every decision.
- **Counterfactuals.** For up to 6 decisions per trajectory (weighted toward rare triggers and problems), each
  applicable action is forced at `k`, with the base run's explored choices before `k` and passive after `k`. There
  are up to K = 3 paired futures, run only when some action beats passive by more than 0.05 in future 0. Futures
  re-seed network, push and model-latency draws and other users' timing after `t_k`. Each run stops at `t_k + 15 s`.
  When nothing was explored from `k` on, the base run serves as the passive counterfactual of future 0.
- **Cost** (`src/harness/cost.ts`) uses sim's weights `W`, term by term: ∫D dt over 10 s, final client divergence,
  server damage, app relations, user-visible error episodes, uncaught errors, wasted requests and pending user time.
  The client state is the registered stores (per-field weights from the manifest: error text 0, loading 0.1,
  inputs 0.3) **plus the visible DOM text** (multiset of `innerText` lines; weight 1, or 2 for observe-only apps).
  Server items compare by content, with timestamps ignored. Shown errors count differently by integration:
  - **store apps:** proposed writes that put an error message into a store, counted at proposal time, so a branch
    never wins by dropping the message (the sim's rule);
  - **observe-only apps:** appearances of the app's error UI (`[role=alert]` by default).
  Error UI text is excluded from the DOM term.

  One term is a realapps addition: **blocked intents**, at 1.0 per user step whose element never appeared (beyond
  the ideal run's). The sim's users act on intents directly; here a broken or stale UI that stops the user from
  doing what they meant is a real cost. Without it, a blank page could look closer to the ideal than a working page
  showing different data.
- **Action label.** The sim's `actionLabel`: tier premiums, tie pinning, `p ∝ exp(−gap/τ)`, `τ = 0.1 + SE`. Then the
  sim's question transform (option shuffles and drops) and its wording randomisation (diagnosis and action
  paraphrases, mirrored from `sim/src/world/scenario.ts`).
- **Diagnosis** (`src/world/diagnose.ts`, `src/harness/labels.ts`) comes from harness knowledge at decision time.
  It never comes from the runtime's text.
  - **The scripted intents.** Accidental steps → `duplicate`. Steps superseded by a newer step or keystroke on the
    same intent key → `stale`.
  - **The mock server's record** of why a request failed or was slow: outage, transient, spike, slow period, rate
    limit, capacity, replica lag, server bug, committed-then-failed.
  - **User writes, element by element.** An async write is `stale` when it changes the same list elements (by id)
    or scalar fields that the user changed after its operation started. It is also `stale` when its read reached the
    server before the user's still-pending write. A push over a pending local write is `conflict`. Busy and loading
    flags (weight ≤ 0.1) are ignored.
  - **Retries.** A retry of a failed request is `duplicate` only if the earlier attempt committed a non-idempotent
    write without an `Idempotency-Key`.
  - **The app's declared relations.** `inconsistent` only when a relation is broken and the flagged invariant names
    its derived field. A structural check that finds the same entity twice in a list gives `duplicate` (for writes,
    broken uniqueness and render errors such as Svelte's `each_key_duplicate`).
  The runtime's causal chains are used only to connect a write or request to its step, message or request.
  `meta.diag_why` and `meta.diag_trace` record which rule fired.

**Row kinds** (all CONTRACT-D):
- **gold decision rows:** soft action label + diagnosis;
- **diagnosis-only rows:** single-action decisions, up to 3 per trajectory;
- **ask rows:** 1–3 developer questions at 1–3 probes per base run (`runtime.situation("ask")`), generated by the
  sim's generators with exact answers from harness facts;
- **unlabeled rows:** in `unlabeled-<split>.jsonl`, up to 40 other base-run decisions per trajectory with the gold
  diagnosis and `meta.unlabeled: true`. They need no counterfactuals and are meant for teacher labelling, as in
  SIM's batches.

Rows are CONTRACT-D `{id, split, family, state, questions, labels, meta}`. They are exactly what the runtime handed
the decider, so the format matches sim rows. Splits are per trajectory:
- **test**:
  - framework `lit`;
  - the apps in `TEST_APPS` (SWR, Alpine and raw-XHR apps that appear nowhere in train);
  - apps marked `heldOut` (`oss-rtk-conduit`);
  - the held-out flag patterns in `TEST_PATTERNS`.
  Only `--test-keep` of test trajectories are kept. `manifest.json` lists all of these.
- **dev**: 4% of the remaining app and flag combinations.
- **train**: everything else.

## Run it (on a VM)

```bash
# once per slot / VM; pin the runtime (export it on the Mac: git archive situation-vN packages/runtime/src)
export RW_RUNTIME_SRC=~/gcl/real-cache/runtime/situation-v1/src RW_RUNTIME_TAG=situation-v1
scripts/vm.sh run real 'cd realapps && npm install --no-audit --no-fund --ignore-scripts && bash corpus/prepare_oss.sh && node build.mjs'
# quality checks
scripts/vm.sh exec real 'cd realapps && node dist/harness/debug.js --det 1-5 --app a,b'                  # base run twice: identical?
scripts/vm.sh exec real 'cd realapps && node dist/harness/debug.js --interference 1-3 --clean'          # GenClass with a do-nothing model must not change the app
scripts/vm.sh exec real 'cd realapps && node dist/harness/debug.js --app a --seed 3 --force 4:discard'  # DOM over time: ideal vs base vs forced
# inspect one scenario (determinism, situations, labels)
scripts/vm.sh exec real 'cd realapps && node dist/harness/debug.js --app react-search --seed 3 --twice --show 2'
scripts/vm.sh exec real 'cd realapps && node dist/harness/debug.js --app vue-editor --seed 2 --traj --show 3'
# generate (resumable: rerun the same command after an interruption)
scripts/vm.sh exec real 'cd realapps && node dist/harness/gen.js --out ~/gcl/real-out/pilot --seed 1 --trajectories 200 --workers 24'
python3 realapps/scripts/analyze.py ~/gcl/real-out/pilot            # stats + comparison with sim final-A
python3 realapps/scripts/evalset.py ~/gcl/real-out/pilot --out ~/gcl/real-out/eval
# cluster nodes (from the Mac; ssh/rsync only): TAG pins the runtime the apps are built against
TAG=situation-v2 realapps/scripts/cluster.sh setup c10 && realapps/scripts/cluster.sh run c10 v2b1 1000000 20000 70
realapps/scripts/cluster.sh status c10 && realapps/scripts/cluster.sh stop c10   # then deallocate the node
```

`gen.js` flags:
- `--out`, `--seed` (first scenario seed), `--trajectories`, `--workers` (one Chromium each), `--apps a,b`;
- `--max-points 6`, `--futures 3`, `--test-keep 0.5`, `--clean` (clean trajectories only), `--unlabeled 40`.

Outputs per batch:
- `{train,dev,test}.jsonl` and `unlabeled-{train,dev,test}.jsonl`;
- `stats.json`: per trigger (passive-best share, best actions, diagnoses, harm), per app, drops, runs;
- `manifest.json`: for TRAIN, with the held-out lists, apps, runtime tag and seeds;
- `done.txt`.

Outputs never go under `~/gcl/<slot>`, which `vm.sh` syncs with `--delete`. On the train VM, `~/gcl/real-out`,
`~/gcl/real-cache` and the `real` slot live on the `/data` disk (symlinks).

## Pilot (runtime `situation-v1`, 2026-10-08)

**Full corpus** (`train:/data/real-out/pilot-all`): 500 trajectories over all 66 apps in 23 frameworks, every
held-out app kept (`--test-keep 1`).
- **Rows:** 3,403 gold (997 ask, 306 diagnosis-only) and 3,789 unlabeled.
- **Quality:** 0 drops, 0 failed trajectories.
  - Determinism sweep: 198/198 identical runs (66 apps × 3 seeds).
  - Interference: 4 of 198 clean runs changed, all in 2 apps (the gothinkster Conduit, and rtkq-helpdesk once).
- **Eval set:** 366 rows.

Passive-best share against SIM:

| trigger | real | sim |
|---|---|---|
| mutation | 88% | 88% |
| request | 75% | 74% |
| failure | 50% | 70% |
| inconsistency | 94% | 84% |
| transition | 89% | 86% |

Label sharpness:
- **Passive-best rows:** 1,512 of 1,674 have passive ≥ 0.9.
- **Rows where an action gains ≥ 2:** 187 of 243 have non-passive mass ≥ 0.9.

**First pilot, audited in `EXAMPLES.md`** (`train:/data/real-out/pilot4`): 230 trajectories over 26 apps.

- **Gold rows:** 1,654 (train 1,210 / dev 47 / test 397). They include 439 ask rows and 171 diagnosis-only rows.
- **Unlabeled rows:** 2,325.
- **Quality checks:**
  - 0 prefix mismatches, 0 failed trajectories;
  - determinism sweeps of 78/78 and 52/52 identical runs (all 26 apps);
  - every network request correlated with its runtime op.
- **Audit:** `EXAMPLES.md` (13 rows, each traced). Real-app eval set: `pilot4/eval/real_eval.jsonl`, 213 rows.

Comparison with SIM final-A (`scripts/analyze.py`):

| trigger | share real / sim | passive-best real / sim | notes |
|---|---|---|---|
| mutation | 40% / 31% | 87% / 88% | diagnosis: stale 29%, duplicate 7% (sim 19%, 13%); conflict and inconsistent are rarer in real apps |
| request | 23% / 23% | 75% / 74% | duplicate 23% (accidental double clicks reach real handlers; buttons that only change their label do not stop them) |
| failure | 13% / 19% | 58% / 70% | retry is best on 37% (sim 21%): real apps rarely retry on their own |
| stall | 2% / 12% | 90% / 64% | fewer repeated identical GETs to learn baselines from in 20–60 s sessions |
| inconsistency | 16% / 7% | 88% / 84% | mostly coincidental learned invariants, labelled `expected`; rollback on those costs +16 on average |
| transition | 4% / 4% | 100% / 86% | |
| error | 3% / 5% | 96% / 99% | includes real framework errors (Svelte `each_key_duplicate`) labelled `duplicate` |

Label sharpness:
- **Passive-best rows:** 789 of 852 have passive ≥ 0.9.
- **Rows where an action gains ≥ 2:** 95 of 114 have non-passive mass ≥ 0.9.
- Rows whose futures disagree stay soft.

Clean runs: passive is best on 96% of them. The rest are actions that genuinely help even on a clean network, such as
`coalesce` on an identical in-flight GET.

**Runtime findings** (`debug.js --interference`, observe mode vs heal mode with an all-passive model, clean runs):
6 of 78 runs differ under v1 write holds.
- The open-source gothinkster react-redux Conduit never renders its feed when writes are held (3 of 3 runs).
- pinia-cart and svelte-inventory end with a different server state because held requests shift timing.
- This was reported for situation-v2, which drops write holds by default.

## Throughput

Measured on `train` (64 vCPU), short batches including browser start-up:

| workers | rate | per trajectory |
|---|---|---|
| 28 | 3.3 trajectories/s, about 20 gold + 25 unlabeled rows/s | |
| 56 (CPU saturated) | 4.6 trajectories/s, about 29 gold + 37 unlabeled rows/s | ≈ 20 browser runs, ≈ 0.45 s of in-page time each; page creation and load are ≈ 25% |
| 48 (full 66-app corpus, held-out apps kept) | 4.5 trajectories/s, about 31 gold + 34 unlabeled rows/s | |

Expected on an F80 (80 vCPU, about 70 workers): about 35–40 gold rows/s, or about 130k gold plus 170k unlabeled rows
per node-hour.

## Scaling plan

1. **Wait for the frozen `situation-v2`** (lead's instruction: no mass production before it). Then:
   - export it with `git archive`;
   - rebuild every app against it;
   - rerun the determinism and interference sweeps and a 230-trajectory pilot;
   - re-audit `EXAMPLES.md`.
2. **Grow the corpus in parallel** (it does not depend on the runtime version). There are 66 apps now: two
   authoring waves of 22 and 30 apps, plus 14 open-source front-ends. The target is ≥ 150:
   - about 30 apps per wave, with each wave covering libraries and domains the corpus lacks;
   - more open-source apps with REST backends beyond RealWorld (the mock server's generic resources already cover
     most of them);
   - whole libraries and frameworks held out for test.
3. **Generate on F80 nodes** (`scripts/cluster.sh setup|run|status|stop`). One batch per node gets a disjoint seed
   range of 1,000,000 seeds. Run with `--workers ≈ 70` and `--test-keep 0.5`, plus a `--clean` batch of about 20k
   rows for false-intervention reporting.
   - ≥ 500k gold rows ≈ 4 node-hours, e.g. 4 F80 nodes for 1 hour, plus about 650k unlabeled rows.
   - Every run is resumable (`done.txt`). Deallocate each node as soon as its batch ends.
   - Batches land in `/data/real-out/<batch>` on the generating VM, or are pulled to `train:/data`. Locations are
     listed in `training/NEEDS.md`.

## Known limitations

- **Untrusted events.** Input is synthetic (user-event style). Trusted Playwright input would add per-step IPC and
  real-time focus and selection events; untrusted events are what the runtime's `untrustedEvents` option is for.
- **Unobservable diagnoses.** Some diagnoses rest on information that is not in the situation, as in the sim: an
  outage behind a first network error (EXAMPLES #2), or a list that turned outdated between read and delivery
  (EXAMPLES #12, `expected` with a sharp `defer`). TRAIN may down-weight rows whose diagnosis is `expected` but
  whose label is a sharp non-passive action (about 4% of mutation rows).
- **Stalls are rare.** Stalls need ≥ 5 latency samples per endpoint. Longer sessions (10% are 90–150 s) and
  poll-heavy apps raise their share.
- **The DOM term is coarse.** It compares line multisets, so a page showing different data and an empty page can
  look alike. Store weights and the blocked-intent term carry most of the signal for store apps; observe-only apps
  rely on the DOM (weight 2).
- **Hosts in WebSocket URLs.** Every app is served from `https://app.example.com`, so WebSocket URLs (and therefore
  WS op names) contain that host. That is realistic but constant.
