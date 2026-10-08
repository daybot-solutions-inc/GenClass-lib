# realapps: a real-browser, real-app training corpus for GenClass Runtime

The simulator (`sim/`) runs combinator-built apps in Node. Real apps differ: React batches renders on a
MessageChannel scheduler, Vue and Svelte flush in microtasks, TanStack Query and SWR dedupe and retry on their own,
axios and jQuery use XMLHttpRequest, Redux middleware reorders dispatches, and app code has its own guards and bugs.
`realapps/` closes that sim-to-real gap. It runs real web apps, built with real frameworks, in **headless Chromium**
with the **real `@genclass/runtime`**. It labels every sampled runtime decision by **counterfactual outcome**, with
the same row format, cost terms and label rule as the sim.

```
realapps/
  apps/<name>/            ~25 apps: manifest.ts (Node side) + app source; apps/README.md = authoring guide
  apps/_shared/           genclass.ts (the app's one-line integration), atom bridges (Vue, Svelte), Conduit manifest
  corpus/                 open-source apps: oss.json (repo, commit, licence), patch_oss.py, prepare_oss.sh,
                          vite.oss.config.mjs, LICENSES.md
  src/world/              in-page world (one IIFE, injected before any page script): loop.ts (virtual time),
                          server.ts + ext/conduit.ts (mock backend), net.ts + netapi.ts (fetch/XHR/WebSocket + chaos),
                          user.ts (scripted user), probe.ts (recording decider, hooks, snapshots), diagnose.ts
  src/harness/            Node side: scenario.ts, trajectory.ts, cost.ts, labels.ts, browser.ts, serve.ts,
                          gen.ts (worker pool), worker.ts, debug.ts
  scripts/                analyze.py (stats + sim comparison), evalset.py, node_setup.sh, cluster.sh
  build.mjs               bundles the world, the harness and every app (esbuild; Vite apps via corpus/)
  EXAMPLES.md             audited example rows (situation, labels, per-action costs)
```

Nothing runs on the Mac. Build, test and generate on the VMs (see "Run it").

## The app corpus

Diversity is the point: frameworks, state libraries, data libraries, and the latent async bugs real apps have, each
mixed with the correct guard. Every app reads feature flags (`flag(name, default)`) that select a guard or a latent
bug. The **first option** of each flag is the correct default; clean runs use only first options. Apps are ordinary
apps. None is written for a particular trigger rule.

- **Written for the corpus** (`apps/<name>`, see `apps/README.md` for the authoring rules). React (hooks,
  useGenClassState, useReducer), Redux Toolkit, Zustand, TanStack Query, SWR, MobX, Vue 3 (template compiler,
  Pinia, vue-query, axios), Svelte 5 (stores, WebSocket), Solid (signals), Preact (signals), Lit (shadow DOM),
  jQuery ($.ajax, observe-only), Alpine, vanilla TypeScript and raw XMLHttpRequest. Latent bugs: missing
  request-ordering guards, double submits, naive retries without idempotency keys, blind server echoes over newer
  typing, overlapping autosaves, optimistic updates without rollback, relative toggles, non-atomic derived counts and
  totals, cache/echo races, WebSocket reconnects without resync, response+push duplicates, concurrent token
  refreshes with rotating refresh tokens, assume-all-succeeded bulk operations, overlapping polls and retry storms.
- **Open source** (`corpus/oss.json`, licences in `corpus/LICENSES.md`, all MIT). Four RealWorld "Conduit"
  front-ends run unmodified against a mock of the RealWorld API (`src/world/ext/conduit.ts`): gothinkster
  react-redux (React 16, Redux 3, superagent/XHR), khaledosman RTK (React 18, Redux Toolkit), mutoe vue3 (Vue SFC,
  Pinia, generated fetch client; built with Vite) and solidjs solid-realworld (Solid JSX; built with Vite). The only
  change is the GenClass integration a developer would add (`corpus/patch_oss.py`). Redux apps get
  `genclassEnhancer` on their store. The Vue and Solid apps get one init import (observe-only). These apps bring
  their own real bugs. For example, gothinkster's promise middleware reads `error.response.body`, so one transient
  5xx on the feed throws in a reducer and leaves the home page empty.

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

The real observers stay on (fetch, XHR, DOM user events, errors, navigation, storage, WebSocket, timers). The only
exception is `perf`: long-task timing is real time, so it cannot be deterministic.

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
  Error episodes are appearances of the app's error UI (`[role=alert]` by default). Server items compare by content
  with timestamps ignored.
- **Action label.** The sim's `actionLabel`: tier premiums, tie pinning, `p ∝ exp(−gap/τ)`, `τ = 0.1 + SE`. Then the
  sim's question transform (option shuffles and drops) and its wording randomisation (diagnosis and action
  paraphrases, mirrored from `sim/src/world/scenario.ts`).
- **Diagnosis** (`src/world/diagnose.ts`, `src/harness/labels.ts`) comes from harness knowledge at decision time.
  It never comes from the runtime's text.
  - The scripted intents: accidental steps, and steps superseded by a newer step or keystroke on the same intent key.
  - The mock server's record of why a request failed or was slow: outage, transient, spike, slow period, rate limit,
    capacity, replica lag, server bug, committed-then-failed.
  - WebSocket messages versus pending local requests on the same entity (conflict).
  - The app's declared relations (genuine `inconsistent`) and a structural check that finds the same entity twice in
    a list (`duplicate`).
  The runtime's causal chains are used only to connect a write or request to its step, message or request.

Rows are CONTRACT-D `{id, split, family, state, questions, labels, meta}`. They are exactly what the runtime handed
the decider, so the format matches sim rows. Splits are per trajectory:
- **test**: framework `lit`, apps marked `heldOut`, and the held-out flag patterns in `TEST_PATTERNS`. Only
  `--test-keep` of test trajectories are kept.
- **dev**: 4% of the remaining app and flag combinations.
- **train**: everything else.

## Run it (on a VM)

```bash
# once per slot / VM
scripts/vm.sh run real 'cd realapps && npm install --no-audit --no-fund --ignore-scripts && bash corpus/prepare_oss.sh && node build.mjs'
# inspect one scenario (determinism, situations, labels)
scripts/vm.sh exec real 'cd realapps && node dist/harness/debug.js --app react-search --seed 3 --twice --show 2'
scripts/vm.sh exec real 'cd realapps && node dist/harness/debug.js --app vue-editor --seed 2 --traj --show 3'
# generate (resumable: rerun the same command after an interruption)
scripts/vm.sh exec real 'cd realapps && node dist/harness/gen.js --out ~/gcl/real-out/pilot --seed 1 --trajectories 200 --workers 24'
python3 realapps/scripts/analyze.py ~/gcl/real-out/pilot            # stats + comparison with sim final-A
python3 realapps/scripts/evalset.py ~/gcl/real-out/pilot --out ~/gcl/real-out/eval
# cluster nodes (from the Mac; ssh/rsync only)
realapps/scripts/cluster.sh setup c10 && realapps/scripts/cluster.sh run c10 b1 1000000 20000
realapps/scripts/cluster.sh status c10 && realapps/scripts/cluster.sh stop c10
```

`gen.js` flags: `--out`, `--seed` (first scenario seed), `--trajectories`, `--workers` (one Chromium each),
`--apps a,b`, `--max-points 6`, `--futures 3`, `--test-keep 0.5`, `--clean` (clean trajectories only), `--port`.
Outputs are `{train,dev,test}.jsonl`, `stats.json` (per trigger: passive-best share, best actions, diagnoses, harm;
per app; drops; runs) and `done.txt`. Outputs never go under `~/gcl/<slot>`, which `vm.sh` syncs with `--delete`.
