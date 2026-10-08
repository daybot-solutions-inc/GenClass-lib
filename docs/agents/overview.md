# GenClass-lib system overview: the mental model

> **Scope:** the whole monorepo at the level of one mental model: `@genclass/runtime` (`packages/runtime/src/**`),
> the unpublished model package (`packages/runtime-model/`), `sim/`, `realapps/`, `training/`, `demos/`, and the
> legacy GenClass content it builds on (`jev_local/`, `extension/`, `bench/`, `results/`, `scripts/`, legacy
> `docs/*.md`). Detail lives in the subsystem docs linked from every section; this doc names the stages and the seams
> between them.
> **Read this when:** you land in the repo cold and need to know what the parts are, how one runtime decision flows
> from an observed event to an action (now mostly at the network boundary), how the offline loops (sim + realapps ->
> teacher -> distillation -> DAgger -> export, demos evaluation) connect to it, what each mode allows, what happens
> without a model, who owns what, and where the project stands.
> **Source of truth:** the code. Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins.

Path convention: every code pointer is `path/from/repo/root` -> `symbol`. Runtime source is under
`packages/runtime/src/`.

## TL;DR

- `@genclass/runtime` is a browser library for self-healing web apps. It instruments the page (fetch, XHR,
  WebSocket, EventSource, timers, DOM user events, errors, navigation, storage, long tasks) and the app's state
  stores, keeps a causal trace, learns baselines, invariants, transition profiles and request cadence, and turns a
  suspicious moment (a *trigger*) into a plain-English *situation*. A small local model (ONNX in a Web Worker, WebGPU
  or WASM) answers two typed questions about it (diagnosis, action). A policy gate runs a minimal action only at high
  calibrated confidence; otherwise the passive action (let it happen) runs.
- **situation-v2 decides at the network boundary.** The main trigger is `delivery`: a fetch/XHR response or a
  WebSocket/EventSource message is about to reach the app, and the fields its operation is predicted to write already
  hold newer data that the body would change (or a pending local change / typed text the body would overwrite). The
  runtime can hold the delivery (pure latency, at most the hold budget) and `discard` it: deliver it, but drop the
  writes its chain makes over newer data, synchronously inside each write. **Store writes are not held by default**
  (`policy.holdWrites: false`); a salient write no delivery decision covers is decided in the background and can only
  be late-reverted.
- The runtime never maps a fact pattern to a diagnosis or action with an if/then (CONTRACT §0 rule 1). Facts are
  generic; triage and the delivery pre-filter only decide whether the model is worth asking; the model decides; the
  gate filters.
- One situation implementation (`packages/runtime/src/situation/*`) is shared by the runtime, by the sim and by the
  real-app corpus, which both drive the real runtime to produce training rows. Its text is **frozen at tag
  `situation-v2`** (6e5e86e); `git diff situation-v2 b435acb -- packages/runtime/src` touches only `runtime.ts` (default
  mode), `types.ts` and `devtools/index.ts`. Everything trained so far used the older `situation-v1` format.
- Modes: **`observe` (default since our commit f3636b2**; never acts, decides in the background for detection),
  `guard` (opt-in; guard-tier actions such as `discard`, `defer`, `coalesce`), `heal` (experimental; adds `retry`,
  `serve_cached`, `rollback`, ...). Kill switch: `?genclass=off`.
- Fail open everywhere: no model, a loading or failed model, a timeout or any error means the passive action runs;
  the runtime holds only when a non-passive action is permitted **and** the model is expected to answer within the
  hold budget (at most 800 ms with the default `"auto"`).
- **Where it stands:** `@genclass/runtime@0.1.0-alpha.1` (situation-v2, NaN fix, default `observe`) is `latest` on npm; no model is
  published (`@genclass/runtime-model` is a 404), so any install only observes. No situation-v2 model exists. The
  colleague is generating v2 data on Azure (SIM ~10M gold + ~50M unlabeled rows on 20 nodes; REAL ~0.5M real-browser
  gold rows on 3 nodes); next comes the 150M teacher, distillation into R17/R32, DAgger, EVAL, the model package, a
  demos rerun and `@genclass/runtime@0.1.0`.

## 1. The problem and the product principles

Web apps fail at runtime in ways their code does not handle: an older response overwrites newer state (stale
response), the same request is sent twice from one intent (duplicate), a request keeps failing, a request hangs, a
store ends up contradicting a relation it normally keeps, an operation makes a state change unlike its usual ones.
CONTRACT §0.5 states the claim: *install one library; find and prevent runtime failures automatically, with low false
positives.* HANDOFF.md's product principle: *never make a correct app worse*.

Binding principles (`docs/runtime/CONTRACT.md` §0 and §0.5; restated with code locations in
[status-and-known-issues](status-and-known-issues.md)):

| principle | what it means in code |
|---|---|
| Never make a correct app worse | Default mode `observe` acts on nothing. When a mode permits actions, the runtime holds only a delivery or request (latency, never reordering), never a store write unless `policy.holdWrites` is on; a discard drops only fields that already hold newer data. The realapps never-worse sweep ("an always-passive model changes nothing") reports 0/396 clean runs changed for the v2 runtime (STATUS.md; see [realapps](realapps.md) for what it compares). |
| Precision first | The gate needs Σ p(permitted actions) ≥ 0.9 (guard) / 0.8 (heal) and a top diagnosis other than `expected` (`packages/runtime/src/decide/policy.ts` -> `gate`, `policyConfig`). Labels favour passive (tier premiums, tie rule). The false-intervention rate (FIR) is reported next to every recall number. |
| Cheap by default | Facts and baselines always run and are cheap; a delivery reads its body only when it is already a candidate; the model is consulted only for *salient* situations (`packages/runtime/src/runtime.ts` -> `RuntimeImpl.trigger`, `RuntimeImpl.runDelivery`), runs in a Worker, loads at idle or lazily, and is cached. Target model size ≤ 25 MB q8 (R17 q8 9.58 MB, R32 q8 22.5 MB). |
| Observable | One console line per detection/intervention with collapsible evidence (`packages/runtime/src/decide/report.ts` -> `interventionLine`, `detectionLine`), `explain(id)`, `undo()` for reversible actions, the `x-genclass` response header on synthetic answers, the devtools overlay, the kill switch. |
| No hardcoded bugs | Facts (`packages/runtime/src/situation/facts.ts` -> `computeFacts`, plus `conflicts.ts`, `content.ts`, `evidence.ts`) are uniform sentences with a `neutral` flag; applicability (`packages/runtime/src/situation/build.ts` -> `builtinApplicable`) only says whether an action *can* run. Only the model's probabilities choose. |
| Determinism and parity | Runtime code reads time only from the injected `Clock` (no `Math.random`, `Date.now`, global timers), so the sim and realapps (virtual time) replay it exactly. Both drive the same code; `training/curriculum/rt.py` is a Python port of the situation text, frozen at `situation-v2`. |
| Honest evaluation | `sim/`, `realapps/` and `demos/` must not read each other's code (CONTRACT §0 rule 4, HANDOFF.md). Demos are never tuned. |

Adoption path: `observe` (default) -> `guard` -> `heal`.

## 2. Component map

```text
 ONLINE: inside the app's page                          packages/runtime  (npm: @genclass/runtime)
 +-------------------------------------------------------------------------------------------------------+
 |  app code: fetch / XHR / WebSocket / EventSource / timers / DOM events / store writes (atoms, Redux,  |
 |  Zustand)                                                                                             |
 |      |                                            |                                                   |
 |      v                                            v                                                   |
 |  observe/* (patched globals) --ops--> trace/*   state/* StoreHub: propose -> drop filter -> commit    |
 |      |   OpRegistry, Context, EventLog            |  (no holds by default)   learn/* Baselines,       |
 |      |                                            |                          Profiles, Cadence;       |
 |      |  NETWORK BOUNDARY                          |  salient write not       InvariantMiner at        |
 |      |  response / message about to reach app     |  covered by a delivery   settled points           |
 |      v                                            v  decision                     |                   |
 |  runtime.ts runDelivery: predicted writes,    observeWrite: background            | inconsistency,    |
 |  conflicts, body read (<= 100 ms)             `mutation` (late revert only)       | transition, error |
 |      |  delivery                                  |   request / failure / stall    |                   |
 |      +--------------------------+-----------------+--------------------------------+                   |
 |                                 v                                                                     |
 |   runtime.ts RuntimeImpl.trigger: facts -> triage -> situation + questions (situation/*)              |
 |                                 |  hold only if an action is permitted AND expectedLatency <= budget  |
 |                                 v                                                                     |
 |   decide/decider.ts DeciderQueue (stale drop) --> DecisionProvider (default: model/* ModelHost)       |
 |                                       Worker: ModelBackend -> Engine -> onnxruntime-web               |
 |                                 |  calibrated Answers (diagnosis, action)                             |
 |                                 v                                                                     |
 |   decide/policy.ts gate --> Controller.run(action) (deliver/discard/defer, coalesce, ...) or passive  |
 |                                 v                                                                     |
 |   Decision / ActionRecord --> report.ts console lines, explain(), undo(), rt.on() events              |
 |                                 --> devtools/* overlay, adapters/* hooks                              |
 +-------------------------------------------------------------------------------------------------------+
                                        ^ model directory: model.json, *-q8.onnx, *-fp16.onnx,
                                        |   tokenizer.json, calibration.json, meta.json
 OFFLINE                                |   (planned: @genclass/runtime-model@0.1.0, a 404 today)
   sim/      --drives the real createRuntime in a virtual world--> gold / unlabeled / on-policy rows
   realapps/ --91 real apps + the real runtime in headless Chromium--> gold / unlabeled REAL rows
   training/ curriculum (rt.py) + T150 teacher on gold -> teacher labels on unlabeled rows
             -> distil R17 / R32 -> DAgger (SIM --on-policy) -> eval_runtime.py -> export_runtime.py
   demos/    GenClass.init Off / Guard / Heal --> seeded trials + oracles --> demos/results.md
   legacy:   jev_local/ (Python model, packer, trainer), extension/ (v0.1 model), bench/, results/
```

| component | path | role | state at b435acb | doc |
|---|---|---|---|---|
| Public API and wiring | `packages/runtime/src/index.ts` (`GenClass`, `createRuntime`), `packages/runtime/src/runtime.ts` (`RuntimeImpl`), `types.ts`, `clock.ts`, `util.ts` | facade, construction, modes (default `observe`), kill switch, events, plugins, settled points, delivery gate wiring | situation-v2 + our default-mode commit | [public-api-and-lifecycle](runtime/public-api-and-lifecycle.md) |
| Observers and trace | `packages/runtime/src/observe/*` (incl. `eventsource.ts`, `messages.ts` -> `MessageGate`), `packages/runtime/src/trace/*` | patch globals, ops with causes, ambient context, event log; request, failure, stall and delivery gates | frozen at `situation-v2` | [observe-and-trace](runtime/observe-and-trace.md) |
| State | `packages/runtime/src/state/*`, `packages/runtime/src/adapters/*` | `StoreHub` (atom/guard/adapter stores), drop filter, late revert, opt-in holds, invariant miner (10 templates), stale marks, snapshots; React/Redux/Zustand adapters | frozen at `situation-v2` | [state-and-adapters](runtime/state-and-adapters.md) |
| Learn, situation, triage | `packages/runtime/src/learn/*` (incl. `cadence.ts`), `packages/runtime/src/situation/*` (incl. `conflicts.ts`, `content.ts`, `evidence.ts`) | baselines, profiles, cadence, version conflicts, content facts F1–F3, evidence facts F5–F9, triage, situation text and questions (model input) | frozen at `situation-v2` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Decide | `packages/runtime/src/decide/*`, controllers in `runtime.ts` | queue (stale drop, deadlines), hold budget, policy gate, actions, reports, explain, undo | frozen at `situation-v2` | [decide-policy-actions](runtime/decide-policy-actions.md) |
| Model host | `packages/runtime/src/model/*`, `packages/runtime/bin/genclass-runtime.mjs` | worker, loader (Cache Storage + sha256), WebGPU/WASM plans, Python-parity packer, calibration, CLI | unchanged since `situation-v1`; no model to load | [model-host](runtime/model-host.md) |
| Devtools | `packages/runtime/src/devtools/*` | shadow-DOM overlay on the public API | mode labels "Observe (default)", "Guard (opt-in)", "Heal (experimental)" | [devtools](runtime/devtools.md) |
| Build, test, release | `packages/runtime/{package.json,tsup.config.ts,test/**}`, root `package-lock.json`, `.github/workflows/ci.yml` | tsup ESM build (6 entries), vitest (351 tests), Playwright, smoke test, CI | alpha.1 published (`latest`; alpha.0 before it); lockfile and CI committed (CI not yet run on GitHub: `mvp-v2` is not pushed) | [build-test-release](runtime/build-test-release.md) |
| Model I/O contract | runtime `situation/*` + `model/*`, `sim/`, `realapps/`, `training/` | situation text -> packed request -> heads -> calibrated answers; row kinds and labels | format `situation-v2` | [model-io-contract](model-io-contract.md) |
| Model package | `packages/runtime-model/` | planned home of the published model directory | only `MODEL_CARD.md`; `@genclass/runtime-model` is a 404 on npm | [model-host](runtime/model-host.md), [build-test-release](runtime/build-test-release.md) |
| Sim | `sim/` (`@genclass/sim`) | training-data generator driving the real runtime in a virtual world: 46 feature combinators × 115 domains; gold, unlabeled and on-policy rows; S1/S2 labels | v1 data on disk (phase A 600,676, phase B 1,415,344 rows); v2 runs in progress on Azure | [sim](sim.md) |
| Real-app corpus | `realapps/` | 91 real apps (77 written + 14 OSS RealWorld front-ends, 23 frameworks) with the real runtime in headless Chromium on virtual time; same labels as the sim; the never-worse sweep | v2 batches `v2b1`–`v2b3` in progress on c01/c10/c11 (per `training/NEEDS.md`, unverified from here); no tests, not in CI or the workspaces | [realapps](realapps.md) |
| Training | `training/` | vocabulary, curriculum (`rt.py` at situation-v2), training rounds, teacher labelling, distillation, eval, ONNX export | final round 1 (situation-v1) done and superseded; v2 program prepared, not run | [training](training.md) |
| Demos | `demos/` (`@genclass/demos`) | six demo apps, Service Worker chaos backend, trial harness | results only with the v0.1 model on the situation-v1 runtime | [demos](demos.md) |
| GenClass model lineage | `jev_local/`, `scripts/genclass_export.py`, `tests/` | Python predecessor: model, packer, calibration, trainer; reference for parity | legacy except trainer, export graph, parity reference | [genclass-model-lineage](genclass-model-lineage.md) |
| Extension, benchmarks, ops scripts | `extension/`, `bench/`, `results/`, `BENCHMARKS.md`, `scripts/` | GenClass 0.1 Chrome extension, Jev benchmarks, Azure/VM scripts | legacy; `scripts/vm.sh`, `scripts/azvm.sh`, `scripts/launch_run.sh` still used | [extension-and-benchmarks](extension-and-benchmarks.md) |
| Status and team files | `HANDOFF.md`, `OPEN_TASKS.md`, `packages/runtime/STATUS.md`, `*/NEEDS.md`, `docs/runtime/{CONTRACT,API,ARCHITECTURE,RESULTS}.md` | handoff, plan, status, requests, binding contract, results | drift documented | [status-and-known-issues](status-and-known-issues.md) |

Paths and per-directory detail: [repo-map](repo-map.md). Terms: [glossary](glossary.md).

## 3. Runtime data flow end to end

Every stage below runs inside `RuntimeImpl` (constructed by `GenClass.init` or `createRuntime`). Stages 1–4 always
run, model or not; stages 5 onward run only while the runtime is *consultable* (not paused, not destroyed, a
`DecisionProvider` exists, and its `status.state` is `ready` or `off`).

| # | stage | what happens | code (file -> symbol) | doc |
|---|---|---|---|---|
| 1 | Observers | The constructor installs, in order, `timers fetch xhr websocket eventsource user errors nav storage perf`, each in try/catch; each patched global becomes a pass-through after `destroy()`. Synthetic DOM events are recorded only with `observe.untrustedEvents: true`. | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.installObservers`; `packages/runtime/src/observe/fetch.ts` -> `installFetch`; `packages/runtime/src/observe/dom-user.ts` -> `installDomUser` | [observe-and-trace](runtime/observe-and-trace.md) |
| 2 | Trace, ops, causality | Every async unit is an `OpRec` (id, kind, signature name such as `GET /api/search`, detail such as `?q=rea`, cause, root). The ambient op becomes the cause of new ops and the writer of state writes; a released response or dispatched message makes its op ambient while the app's handlers run. Events go to a ring buffer (default 500). | `packages/runtime/src/trace/ops.ts` -> `OpRegistry`; `packages/runtime/src/trace/context.ts` -> `Context`, `LazyOp`; `packages/runtime/src/trace/events.ts` -> `EventLog` | [observe-and-trace](runtime/observe-and-trace.md) |
| 3 | Stores | Values are flattened into versioned dotted fields with writer ops, history and write logs. Each `set`/`dispatch` is a `MutationRec`: first the **drop filter** removes changes that an active discard mark protects; then the write applies at once (user-sync, GenClass, paused, `hold: false` and no-op writes bypass everything); a non-bypass write not `covered` by a delivery decision is handed to `observeWrite` first (a background `mutation` trigger). Only with `holdWrites: true` does the old held pipeline (`gateMutation`) run. | `packages/runtime/src/state/hub.ts` -> `StoreHub.propose`, `StoreHub.applyFilter`, `StoreHub.commit`; `packages/runtime/src/runtime.ts` -> `RuntimeImpl.dropFilter`, `RuntimeImpl.observeWrite`, `RuntimeImpl.covered`, `RuntimeImpl.onApplied` | [state-and-adapters](runtime/state-and-adapters.md) |
| 4 | Learned baselines, invariants, profiles, cadence | Fetch/XHR latency (≥ 5 samples), outcomes, failure streaks, rates and cadence (schedule or debounce) per signature; at *settled points* (60 ms after the last op end or write, nothing younger than 10 s in flight, no pending write) the invariant miner checks 10 generic templates and transition profiles flag rare state changes (< 1% of ≥ 20 completions). Profiles also give the delivery gate its predicted write set. | `packages/runtime/src/learn/baselines.ts` -> `Baselines`; `packages/runtime/src/learn/profiles.ts` -> `Profiles`; `packages/runtime/src/learn/cadence.ts`; `packages/runtime/src/state/invariants.ts` -> `InvariantMiner.observe`; `packages/runtime/src/runtime.ts` -> `RuntimeImpl.settled` | [learn-situation-triage](runtime/learn-situation-triage.md), [state-and-adapters](runtime/state-and-adapters.md) |
| 5 | Delivery pre-filter (network boundary) | fetch (a non-failure response, before the app's promise resolves), XHR (first completion event, before any app completion listener) and WebSocket/EventSource (each message, before any app listener; per-channel order kept) call `runDelivery`. It computes the predicted write set P, matches live fields and finds conflicts (`newer`: written by a later op outside the chain, not a user action, with no newer same-signature request in flight; `pending`: an unconfirmed optimistic user change). No conflict and no typed-into text field -> released synchronously, no body read. Otherwise it waits at most 100 ms for the body (a clone) and keeps the delivery only if the body would change newer data, put back the value a pending change replaced (F1) or replace typed text (F2). | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.runDelivery`; `packages/runtime/src/situation/conflicts.ts` -> `predictedWrites`, `matchFields`, `conflictsOn`; `packages/runtime/src/situation/content.ts` -> `analyzeBody`; `packages/runtime/src/observe/messages.ts` -> `MessageGate` | [learn-situation-triage](runtime/learn-situation-triage.md), [decide-policy-actions](runtime/decide-policy-actions.md) |
| 6 | Trigger | A raise site calls `trigger(spec, controller, { hold, priority })`. Kinds: `delivery` (holdable, priority 2), `request` (holdable), `failure` (fetch: holdable), `mutation` (background by default; holdable only with `holdWrites`), `stall`, `inconsistency`, `transition`, `error`; `ask` comes from `rt.ask`/`rt.situation`. | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.trigger`, `runDelivery`, `observeWrite`, `gateMutation`, `watchStall`, `raiseInconsistency`, `raiseTransition`, `reportError`; `packages/runtime/src/observe/fetch.ts` -> `installFetch` | [decide-policy-actions](runtime/decide-policy-actions.md) |
| 7 | Facts | Uniform English sentences per trigger, each with a kind and a `neutral` flag; non-neutral first; at most 12 at the full budget. v2 adds version-conflict facts, F1 (would put back an older value), F2 (would replace typed text), F3 (changes nothing), F5 (failure scope, commit ambiguity), F6 (cadence), F7 (repeat evidence), F9 (known-stale values) and read-your-writes. | `packages/runtime/src/situation/facts.ts` -> `computeFacts`, `orderFacts`; `situation/content.ts`; `situation/evidence.ts` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| 8 | Triage | With `triage: "salient"` (default) the model is asked only if some fact is non-neutral, a standing question has `always: true`, or the trigger is `ask`. Otherwise the passive action runs with no model call and no record. | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.trigger` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| 9 | Situation + questions | 7-key `JevState` (`app, trigger, facts, in_flight, timeline, state, stats`) sized by a character budget: full 2,400 (WebGPU or unknown device), WASM 1,000–2,000 by threads; `diagnosis` question (10 labels) and `action` question (applicable actions, passive first, only when ≥ 2 apply); bare labels at ≤ 1,400 chars. | `packages/runtime/src/situation/build.ts` -> `buildSituation`; `packages/runtime/src/situation/serialize.ts` -> `toJevState`; `packages/runtime/src/situation/questions.ts` -> `buildQuestions`; `packages/runtime/src/runtime.ts` -> `RuntimeImpl.situationBudget` | [learn-situation-triage](runtime/learn-situation-triage.md), [model-io-contract](model-io-contract.md) |
| 10 | Hold or not | `waits = hold && permitted.length > 0 && !paused && expectedLatency() <= holdBudgetMs()`. `expectedLatency` = median recent provider latency (warm-up before any) × (1 + queued decisions) + the one computing; infinite while the provider is stuck. Hold budget `"auto"`: clamp(round(1.5 × median of the last 20 latencies, or `warmupMs`), 150, 800) ms; 300 ms when neither is known. If not waiting, the passive action runs now and the decision continues in the background (5 s deadline). | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.trigger`, `RuntimeImpl.expectedLatency`; `packages/runtime/src/decide/policy.ts` -> `permittedActions`, `holdBudget` | [decide-policy-actions](runtime/decide-policy-actions.md) |
| 11 | Decision queue | Single-flight priority queue (32 items, 30 s answer cache, deadlines, 10 s runtime-side timeout). An item whose subject was superseded (`ctl.stale`: response already released, write overwritten) is dropped before the model sees it. Every miss, error or timeout resolves `null` -> passive. | `packages/runtime/src/decide/decider.ts` -> `DeciderQueue.submit`, `DeciderQueue.pump` | [decide-policy-actions](runtime/decide-policy-actions.md) |
| 12 | Model host | `evaluate` rejects at once unless `ready`. In the Worker (inline fallback), the packer renders the state and questions with Python-parity serialization, tokenizes, packs `[CLS] key: text [SEP] ... [Q] header [O] item ...` with block attention, and runs one ONNX forward pass. | `packages/runtime/src/model/host.ts` -> `createModelHost`; `packages/runtime/src/model/engine.ts` -> `Engine.evaluate`; `packages/runtime/src/model/packer.ts` -> `Packer.pack` | [model-host](runtime/model-host.md), [model-io-contract](model-io-contract.md) |
| 13 | Calibrated answers | Per-question temperature or Platt scaling turns logits into `Answer`s (`choice`, `confidence`, `probabilities`). The gate reads only `probabilities` and the diagnosis `choice`. | `packages/runtime/src/model/calibrate.ts` -> `calibrateLogits`, `buildAnswer` | [model-io-contract](model-io-contract.md) |
| 14 | Policy gate | A = applicable non-passive actions the mode allows minus `deny`; candidate = argmax over A; runs iff not paused, Σ p(A) ≥ the candidate tier's threshold, top diagnosis ≠ `expected`, < 60 actions in the last minute, and the subject has not already proceeded (except a late-revert `discard` of a write, and custom actions). A delivery decided before release is marked `decided`, which makes its chain's writes `covered`. | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.onDecision`; `packages/runtime/src/decide/policy.ts` -> `gate` | [decide-policy-actions](runtime/decide-policy-actions.md) |
| 15 | Action or passive | The subject's `Controller` performs the action (`run`) or lets it through (`passive`). Delivery: `deliver` releases; `discard` releases and sets a 10 s discard mark; `defer` waits for related in-flight ops (≤ 10 s) and decides again (≤ 2 times). A throw runs passive. | `packages/runtime/src/decide/exec.ts` -> `Controller`; `packages/runtime/src/runtime.ts` -> `runDelivery`, `mutationController`, `rollback`, `revertChain`, `resync`; `packages/runtime/src/observe/fetch.ts` -> `installFetch` | [decide-policy-actions](runtime/decide-policy-actions.md) |
| 16 | Report, explain, undo, events | Every model answer to a trigger is a `Decision` (`d<n>`); every non-passive attempt an `ActionRecord` (`a<n>`, exact `changed` sentence, `dropped` paths for a delivery discard, optional `undo`); console lines deduped per 60 s; events `decide`, `detect`, `act`, `report`, `status`, `event`; past actions and drops reappear in later timelines. | `packages/runtime/src/decide/report.ts` -> `interventionLine`, `detectionLine`; `packages/runtime/src/runtime.ts` -> `RuntimeImpl.explain`, `RuntimeImpl.on`; `packages/runtime/src/devtools/index.ts` -> `mountDevtools` | [decide-policy-actions](runtime/decide-policy-actions.md), [devtools](runtime/devtools.md) |

## 4. Walkthrough: a stale typeahead response held at delivery and dropped

The canonical bug. The user types into a search box; each keystroke sends `GET /api/search?q=...`; an older, slower
response arrives after a newer one and is about to overwrite newer results. This is the scenario of
`packages/runtime/test/budget.test.ts` -> `typeahead`, whose situations are printed in `packages/runtime/STATUS.md`
("Example situations: compact budgets" and "delivery: a stale out-of-order response"). The test registers
`rt.atom("search", { query: "", results: [] })`; each `rt.user({ kind: "type", ... })` handler writes `query` and
fetches; after `await res.json()` the app writes `results`. It types `r`, `re`, `rea`, `reac` (80, 70 and 90 ms
apart) and serves `q=rea` with 900 ms latency and every other query with 120 ms. Op ids: `#1`/`#2` user `r` and its
GET, `#3`/`#4` for `re`, `#5` user typed `rea`, `#6` `GET /api/search?q=rea`, `#7` user typed `reac`, `#8`
`GET /api/search?q=reac`. The test harness runs in `guard` mode (`test/helpers.ts` -> `setup`); the steps below
assume `mode: "guard"` and a `ready` model. The table after them covers the default `observe` mode and the
fail-open cases. A sibling test, `packages/runtime/test/delivery.test.ts` -> "a stale out-of-order response gets a
delivery decision; discard drops only the stale field writes", asserts the discard end to end.

1. **Keystroke -> user op.** In a browser, the capture-phase `input` listener (`packages/runtime/src/observe/dom-user.ts`
   -> `installDomUser`; trusted events only unless `observe.untrustedEvents`) calls `RuntimeImpl.user`, which starts
   an instant `user` op and sticks it as ambient so the app's own listener in the same task runs under it (the test
   calls `rt.user(action, handler)` directly).
2. **Query write applies at once.** `search.set(v => ({ ...v, query: q }))` reaches `StoreHub.propose`. Its cause is
   the task's user op, so it is *user-sync*: it bypasses everything and applies in the caller's stack (`search.query`
   gets a new version, writer `#5`). Store writes are never held by default anyway.
3. **Request -> fetch op.** `fetch("/api/search?q=rea")` hits `installFetch`'s wrapper: `startOp` creates `#6`
   (cause `#5`), `Baselines.start` records it, and the request gate raises a `request` trigger. Its facts are neutral
   (different identities, nothing failed, no learned rate), so the request is sent at once with no model call. Same
   for `#8` 90 ms later.
4. **Earlier responses pass the delivery gate without cost.** When `#2` (`q=r`) arrives, its signature has no
   completed run yet, so its predicted write set is unknown and it is released at once. When `#8` arrives after
   120 ms, `predictedWrites` says the signature writes `search.results` (what its last completion wrote); the last
   writer of that field (`#4`) started before `#8`, so there is no conflict: `runDelivery` releases synchronously, reads
   no body and asks nothing. The app's write `results = ["reac-1", "reac-2"]` (writer `#8`) is `covered` by that
   delivery (`op.delivery` known, covering the field, not salient), so it raises no `mutation` trigger either. This is
   why clean, in-order typeahead makes zero model calls (`delivery.test.ts` -> "clean typing ... makes zero model
   calls").
5. **The stale response arrives (`#6`, after 900 ms).** `runDelivery` finds a **newer-data conflict** on
   `search.results`: it changed since `#6` started, and `#8` started after `#6`, is outside `#6`'s chain, is not a user
   action, and no newer `GET /api/search` is still in flight. `op.delivery.salient` is set. Because a conflict exists,
   the gate reads the buffered clone of the body (≤ 256 KB JSON, waiting at most 100 ms); `analyzeBody` locates
   `results` in `{ q, results: ["rea-1", "rea-2"] }` and finds it differs from the current `["reac-1", "reac-2"]`, so
   the delivery stays salient. The app's `await fetch(...)` promise has not resolved yet.
6. **Trigger, facts, situation.** `trigger(spec, ctl, { hold: true, priority: 2 })` recomputes the facts (the version
   fact is non-neutral), passes triage and builds the situation. `defer` is not offered because no related operation
   is in flight, so the action question is `deliver | discard`. At a 1,000-char budget (1-thread WASM; compact
   questions) the model receives this (STATUS.md, "delivery at 1000 chars (951)"):

```text
app: /search
trigger: The response to GET /api/search?q=rea (#6) arrived and is about to be delivered; its operation last wrote search.results.
facts:
  search.results was written twice by other operations since its operation (#6) started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later user action (#7).
  The response has search.results = 2 items ["rea-1", "rea-2"]: neither the current value 2 items ["reac-1", "reac-2"], nor the value when #6 started.
  search.query changed since its operation (#6) started: "rea" → "reac", last by user typed "reac" into input "Search" (#7) 0.09s after #6 started.
  The response to GET /api/search?q=rea (#6) arrived after 0.90s (200); the app has not seen it yet.
  This request comes from user typed "rea" into input "Search" (#5), started 0.90s ago.
in_flight: none
timeline: none
state: none
stats:
  GET /api/search: 4 done, 0 of last 4 failed, 4 in last 10s
questions:
  diagnosis: What is happening here? expected | stale | conflict | duplicate | inconsistent | failing | slow | overload | unusual | transient
  action: What should the runtime do with this response or message? deliver | discard
```

   The second fact is F1's "third value" form (the response matches neither the current value nor the value when `#6`
   started). At 2,000 and 2,400 chars the same delivery carries a full timeline and state section and described
   options; both versions are in STATUS.md.
7. **Hold.** In `guard` mode `discard` is permitted, so if `expectedLatency() <= holdBudgetMs()` the delivery waits:
   a budget timer is armed and `DeciderQueue.submit` gets priority 2, deadline `t0 + budget` (a delivery has no
   late-revert window) and `ctl.stale` (true once the response is released). Holding is only latency: the `Response`
   object is unchanged.
8. **Model.** `ModelHost.evaluate` -> Worker -> `Engine.evaluate`: pack, one forward pass, calibrate. The result is
   `{ diagnosis, action }`, each with `probabilities` in option order.
9. **Gate.** `RuntimeImpl.onDecision` -> `gate`: A = {`discard`}; it runs iff p(discard) ≥ 0.9, the top diagnosis
   is not `expected`, the rate limiter has room and the delivery has not been released. `op.delivery.decided` is set,
   which makes `#6`'s later writes `covered` (no extra `mutation` decision). A `Decision` is recorded either way.
10. **Discard.** The controller's `run("discard")` sets `op.discardMark = { protect: {search.results}, until: now +
    10 s }` and releases the response. The app's promise resolves, it parses the JSON and calls
    `search.set(v => ({ ...v, results }))` with `#6` as the ambient cause. `StoreHub.propose` -> `applyFilter` ->
    `RuntimeImpl.dropFilter` walks the cause chain to `#6`'s mark and drops the change to `search.results` (protected,
    and written over by `#8`). Other fields of the same write would still apply; here none remain, so the write is
    dropped whole and nothing is notified. An `action` event `dropped the write of search.results by GET
    /api/search?q=rea (#6) over newer data` is pushed. `search.results` keeps the `reac` results.
11. **Record and report.** The `ActionRecord` has `changed` = `Delivered the response to GET /api/search?q=rea (#6)
    and dropped the state changes it makes over newer data (search.results).`, `dropped: ["search.results"]` and an
    `undo` that restores the dropped values. The console prints `[GenClass] Prevented a stale response: <first fact>
    <changed> (stale, <p>; discard <p>)` with the evidence grouped under it; `rt.explain(id)` returns the same
    evidence and the devtools Interventions card offers Undo.

Other outcomes of the same delivery:

| condition | result |
|---|---|
| default `mode: "observe"` | nothing is permitted, so `waits` is false and the response is released as soon as the trigger runs (after the body read, up to 100 ms: the pre-filter does not check the mode). The release marks the chain as delivered over newer data (F9). Because the subject is already released, the queued delivery decision is dropped as stale before the model sees it; the app's write is not `covered` (salient, not decided), so `observeWrite` raises a background `mutation` decision instead, which can only flag (`[GenClass] Flagged a stale write: ...`). |
| gate fails (mass < 0.9, top diagnosis `expected`, rate limit) | `deliver`: the stale results show; a `Flagged a stale response` detection line prints when the diagnosis is not `expected` with p ≥ 0.6 |
| model not expected within the hold budget (`expectedLatency` too high) or slower than the budget | the response is released at once or at the budget (fail open); the writes are then not `covered`, so they get a background `mutation` decision, and a gate-passing `discard` can **late-revert** the write within 2 s if nothing changed those fields since (`delivery.test.ts` -> "a slow model: the response is released at the budget, its writes are decided in the background and late-reverted") |
| model loading, failed or absent (every install today: the default model URL 404s) | `consultable()` is false: `runDelivery` releases at once, no facts are computed, nothing is recorded; the stale write applies exactly as without GenClass |
| model status `off` (lazy preload not started) | the pre-filter and facts run; this salient delivery starts the model load and is released at once (fail open) |
| `heal` mode | as `guard` here (no heal-tier delivery action) |

Known risks on exactly this path, from the 2026-10-08 adversarial review (open at b435acb; details and proposed fixes
in [decide-policy-actions](runtime/decide-policy-actions.md) and [state-and-adapters](runtime/state-and-adapters.md)):

- The discard mark lasts 10 s and is found by walking the cause chain, so later operations chained from the
  discarded one (a `setTimeout` poll loop, a saga) can have their fresh writes dropped too (`RuntimeImpl.dropFilter`,
  `RuntimeImpl.writtenOver`).
- On Redux/Zustand stores a write that would be only partly dropped is applied whole (`StoreHub.applyFilter`,
  fail-open), yet the `ActionRecord` still says the changes were dropped (`dropped: []`).
- Observe mode, the new default, still delays a candidate delivery by up to 100 ms for the body read, and XHR
  completion listeners queued during that wait run outside the original dispatch (`e.currentTarget === null`).
- Discard marks survive `pause()` and `setMode("observe")`; a delivery `defer` (two rounds of up to 10 s each) can
  stall a whole WebSocket/EventSource channel; held WebSocket/EventSource messages are dispatched even after the app
  called `close()` (`MessageGate.pump`).

## 5. Offline loops

Training rows come from three producers that all record the runtime's own `EvaluateRequest` bytes (`state`,
`questions`) or a byte-exact Python port of them, and share one row schema (CONTRACT-D: `{id, split, family, state,
questions, labels, meta}`). Details: [model-io-contract](model-io-contract.md).

### 5.1 SIM: simulated apps driving the real runtime

```text
seed -> buildScenario (domain, features, personas, net + chaos, budget, split)
     -> ideal run + base run (real createRuntime on a VirtualLoop, recording decider)
     -> gold:      sampled decision points k -> one counterfactual run per applicable action
                   x K = 2-3 paired futures (S2: futures 1-2 re-draw what the runtime cannot observe)
                   -> runCost vs ideal -> actionLabel (soft) + diagnose (hard; S1 relabels `expected` when acting
                   clearly wins)
     -> unlabeled: every decision point of the base run (gold diagnosis, no action label)  [--unlabeled]
     -> on-policy: an exported model decides through the production gate; points labelled as gold  [--on-policy]
     -> <out>/{train,dev,test}.jsonl + stats.json; cluster runs collect to gz shards
```

- CLI and workers: `sim/src/gen.ts` -> `main` (modes `gold`, `unlabeled`, `onpolicy`); one trajectory:
  `sim/src/gen/trajectory.ts` -> `generateTrajectory`, `pointCosts`; one run: `sim/src/run/runner.ts` ->
  `runScenario`; latent re-draws: `sim/src/run/latent.ts`.
- The real runtime is loaded by `sim/src/run/rt.ts` -> `realRuntimeFactory` with `createOptions`: `model: false`,
  the recording decider, `mode: "heal"` (so the observe default does not affect the sim), `triage: "salient"`,
  observers `fetch`, `timers`, `websocket`, `storage`, thresholds 0.5 with `requireDiagnosis: false` and
  `holdBudgetMs: 1e9`, so exactly the forced action runs. The sim never writes situation text.
- Data: phase A (600,676 rows) and phase B (1,415,344) are situation-v1 and do not match the runtime. The v2 runs
  (≥ 10M gold + ≥ 50M unlabeled) are being generated on 20 Azure nodes into `train:/data/sim-out/v2-*` by the
  colleague (HANDOFF.md, `training/NEEDS.md`; unverified from here). Detail: [sim](sim.md).

### 5.2 REAL: real apps in headless Chromium

- `realapps/` runs 91 apps built with real frameworks (React, Vue, Svelte, Solid, Lit, Angular, Elm, jQuery, Redux,
  Zustand, TanStack Query, SWR, XHR libraries, ...) with the runtime bundled **from source**, on virtual time with an
  in-page mock backend and chaos (`realapps/src/world/*`). It closes the sim-to-real gap (framework schedulers, query
  dedupe, XHR libraries, middleware). It is also the only producer of XHR deliveries and of user actions recorded by
  the DOM observer, since the sim turns off the `xhr` and `user` observers (it calls `runtime.user` directly) and no
  sim code references `EventSource` (inferred from `createOptions` and a grep; see
  [learn-situation-triage](runtime/learn-situation-triage.md) Drift).
- It labels sampled decisions the same way as the sim, importing the sim's cost weights, `actionLabel` and question
  transforms (`realapps/src/harness/trajectory.ts` -> `generateTrajectory`, `realapps/src/harness/cost.ts` ->
  `runCost`), and writes gold, unlabeled, diagnosis-only and ask rows with `meta.source = "realapps"`
  (`realapps/src/harness/gen.ts`). Runs use an explicit `mode` (default `heal`), so the observe default does not
  change them.
- It is also the runtime's never-worse harness (`realapps/src/harness/debug.ts` -> `--interference`, `--det`).
- Data: v2 batches `v2b1`–`v2b3` on c01, c10, c11 (≈ 30k trajectories each, target ≥ 500k gold rows) go to
  `train:/data/real-out/` (`training/NEEDS.md`, HANDOFF.md; unverified from here). `realapps/scripts/evalset.py`
  builds the real-app eval set (366 rows exist from a v1 pilot per RESULTS.md §6). Detail: [realapps](realapps.md).

### 5.3 The v2 training program: teacher -> distillation -> DAgger -> export

```text
prune_vocab.py (16,000 merges -> 16,364 tokens, shared by every model)
  -> curriculum/generate.py (+ rt.py runtime-exact rows, frozen at situation-v2; no v2 set generated yet)
  -> P1  T150 teacher (ettin-150m, never shipped) on SIM v2 gold (+ REAL gold)           launch_t150.sh / launch_student.sh
  -> P3  teacher soft-labels a prioritised subset of the unlabeled rows                    label_teacher.py, label_cluster.sh
  -> P4  distil students R17 (default) and R32 (R68 as a benchmark) on gold + teacher labels + curriculum replay
  -> P5  DAgger x3: export students -> SIM --on-policy rows -> retrain
  -> eval_runtime.py (FIR, precision, recall, regret, ECE; --write-calibration -> calibration.json)
  -> export_runtime.py (<name>-q8.onnx, <name>-fp16.onnx, tokenizer.json, calibration.json, meta.json,
     model.json card "genclass-runtime-model/1", parity fixtures) -> ortweb/validate.mjs
  -> [planned] @genclass/runtime-model@0.1.0 (jsDelivr serves files/ = DEFAULT_MODEL_BASE_URL)
  -> runtime: model/loader.ts fetchCard -> planOrder -> fetchFile (size + sha256, Cache Storage) -> Engine -> "ready"
```

- Plan and phases: `training/PLAN-v1.md` (P0–P5, cost estimates ≈ $3–4k); order of work: HANDOFF.md "How to
  continue". A T1 side track (`training/t1_relabel.py`, `eval_gain.py`) trains on expected-advantage targets from
  SIM `meta.cost_futures`.
- Candidates: R17 (`jhu-clsp/ettin-encoder-17m`, d 256 × 7 layers, q8 9.58 MB) is the default on every device;
  R32 (GenClass 0.1 `jev-local-fast`, ettin-32m, d 384 × 10 layers, q8 22.5 MB) matched it at about 3× the latency
  in round 1 (RESULTS.md §2).
- Baseline to beat: final round 1 (situation-v1, 448k phase-A rows) R17: diagnosis 90.5%, action 81.9%, guard FIR
  0.05%, heal FIR 0.24%, ECE 0.009, but guard recall on clear stale/duplicate cases only 7.7%. `sim/SEPARABILITY.md`
  traced that to the data (benign twins with identical facts, `expected` mislabels, hindsight labels), which v2
  addresses with new facts (F1–F9), S1 and S2.
- Code: `training/curriculum/rt.py` -> `render`, `to_state`; `jev_local/train/train.py`;
  `training/label_teacher.py` -> `main`; `training/eval_runtime.py` -> `fit_calibration`, `decision_metrics`;
  `training/export_runtime.py` -> `main`. Detail: [training](training.md), [genclass-model-lineage](genclass-model-lineage.md).

Known risks in this pipeline from the 2026-10-08 review (none fixed at b435acb; tell the colleague before acting,
since his v2 generation is running):

- `sim/src/world/scenario.ts` still samples the v1 3,200-char budget for 40% of trajectories (`[[3200, 40], [2000,
  30], [1000, 30]]`); the runtime never exceeds 2,400, and `realapps/src/harness/scenario.ts` does the same.
- SIM and REAL unlabeled rows carry a hard `diagnosis` label, including `expected` cases that S1 would relabel, and
  `label_teacher.py` keeps existing labels by default.
- `training/label_cluster.sh` lists `*.jsonl` only (collected SIM shards are gz), has no split filter and no gather
  step, and touches its done marker unconditionally; `training/final_post.sh` and `eval_sim.sh` are hard-wired to the
  v1 eval set `simAe`.
- `realapps/scripts/evalset.py` reads `test,dev,train` by default and does not classify `delivery` rows;
  `realapps/src/harness/gen.ts` writes `runtime: "situation-v1 ..."` into every batch manifest.
- `training/curriculum/rt.py` diverges from the frozen renderer in several common cases (an extra "Recent ...
  outcomes" fact on failure rows, timeline selection, no-op writes, F1 vs F2 wording).

### 5.4 Evaluation loop (demos)

- Six apps (`search`, `editor`, `checkout`, `status`, `board`, `decisions`), each with a deliberate latent bug, on a
  Service Worker mock API with seeded chaos. GenClass is created only in `demos/src/shared/genclass.ts` ->
  `startGenClass`: **Off** = `GenClass.init({ mode: "observe", model: false })`, **Guard** / **Heal** =
  `GenClass.init({ mode, model: { baseUrl, preload: "eager" } })`. The demos always pass `mode`, so the new default
  does not change them; the in-page "Run trials" driver uses synthetic events, which the runtime now ignores unless
  `observe.untrustedEvents` is on (the Playwright eval uses real input).
- Shipped `demos/results.md` (810 trials) used the v0.1 model (not trained for runtime decisions) on the frozen
  batch-3 runtime (situation-v1): Guard executed 0 actions yet raised bug rates through store-write holds, which
  drove the v2 redesign. Nothing has been measured on the demos with the v2 runtime; the rerun comes after the v2
  model package. Detail: [demos](demos.md).

### 5.5 How a runtime change reaches the shipped model

CORE changes text the model reads -> a new freeze tag (now `situation-v2`) -> SIM and REAL regenerate rows from that
exact runtime (REAL pins it with `RW_RUNTIME_SRC`/`RW_RUNTIME_TAG` from a `git archive` of the tag) -> TRAIN mirrors the
wording in `training/curriculum/rt.py`, trains the teacher, labels, distils, runs DAgger, calibrates, evaluates and
exports -> MODEL checks TS packer/engine parity against the export's fixtures -> the user publishes the model
package, then the runtime (2FA). Any change to facts, delivery salience, timeline/state/stats lines, question wording,
diagnosis labels, budgets, `util.ts` formatters and redaction, op or event names, the packer, tokenizer or
calibration lookup is a model-format change ([model-io-contract](model-io-contract.md)).

## 6. Modes and what each allows

Mode-tier rule: `packages/runtime/src/decide/policy.ts` -> `modeAllows`. Thresholds from `policyConfig`: report 0.6,
guard 0.9, heal 0.8. Default: `packages/runtime/src/runtime.ts` -> `RuntimeImpl` constructor, `o.mode ?? "observe"`
(f3636b2; CONTRACT §13 entry; `test/default-mode.test.ts`).

| mode | how to get it | actions that can run | holds | decisions and reports |
|---|---|---|---|---|
| off (kill switch) | `?genclass=off` or `localStorage.genclass = "off"` (URL wins), read by `packages/runtime/src/index.ts` -> `killSwitch` | none | never | inert runtime: every observer off, no decider, `report: "silent"`; caller options dropped |
| `observe` (**default**) | no `mode`, `mode: "observe"`, `?genclass=observe`, `setMode` | passive only | never (a candidate delivery may still wait ≤ 100 ms for its body; see section 4) | with a ready model, salient triggers are decided in the background and recorded; detections print `Flagged ...`; delivery decisions are dropped as stale and their writes are decided as `mutation` instead |
| `guard` (opt-in) | `mode: "guard"`, `?genclass=guard` | passive + guard tier: `discard`, `defer`, `coalesce`, `delay`, guard-tier custom actions | when a guard action is permitted for that trigger and the model is expected within the hold budget | decisions, detections, interventions |
| `heal` (experimental) | `mode: "heal"`, `?genclass=heal` | guard + heal tier: `block`, `serve_cached`, `retry`, `hedge`, `rollback`, `resync`, custom actions (default tier heal) | when any non-passive action is permitted and the model is expected in time | decisions, detections, interventions |

Also: `policy.allow` / `policy.deny` narrow the permitted set; `policy.holdWrites: true` re-enables held store writes
(opt-in, never reorders a store's writes); `pause()` stops gating and triggers while tracing continues; `setMode`
applies to the next gate. Passive actions per trigger: mutation `apply`, request `send`, delivery `deliver`, failure
`deliver`, stall `wait`, inconsistency/transition/error `ignore`. The older published alpha.0 and HANDOFF.md still say
`guard` is the default (alpha.1 says `observe`); the unit-test harness passes `mode: "guard"`. Details:
[public-api-and-lifecycle](runtime/public-api-and-lifecycle.md), [decide-policy-actions](runtime/decide-policy-actions.md).

## 7. With no model: fail open, observe only

`consultable()` (`packages/runtime/src/runtime.ts` -> `RuntimeImpl.consultable`) is true only when a provider exists
and its state is `ready` or `off`. Consequences:

| provider state | what triggers do |
|---|---|
| no provider (`createRuntime` without `decider`/`model`, `model: false`, kill switch) | nothing is computed or held; every delivery is released at once; no `Decision` ever |
| `off` (idle preload not started yet) | the delivery pre-filter, facts and triage run; the first salient situation starts the load (`void this.ready`) and fails open |
| `loading` | skipped entirely: no facts, no holds, no records |
| `error` | same as `loading`, permanently: `ready` is memoised and nothing retries the load |
| `ready` | full pipeline |

What a default `GenClass.init()` does at b435acb (code reading; no test covers the browser path): it creates a model
host for `DEFAULT_MODEL_BASE_URL` = `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/`
(`packages/runtime/src/model/host.ts`); the idle preload fetches `model.json` from a package that does not exist (a
404 per a check on 2026-10-08), the status becomes `error`, the console prints `[GenClass] Model unavailable
(...); observing only.`, and from then on no situation is built and nothing is held or acted on. Tracing, field
versions, baselines, cadence, invariants and profiles keep learning; `rt.situation()` still works; `rt.ask()` rejects.
The CLI's default source (`genclass-runtime fetch-model`, `DEFAULT_FROM`) is a 404 too. The only trained runtime model,
R17-final1, is situation-v1 and lives only on the train VM / the colleague's Mac; it does not match this runtime. Full
sequence: [model-host](runtime/model-host.md).

## 8. Workstreams and ownership

The project was built by parallel workstreams (roles; every commit up to 74f17c0 is by the colleague, Mehar, and
HANDOFF.md addresses the Claude sessions that continue the work), coordinating through status and NEEDS files (detail, conventions and drift:
[status-and-known-issues](status-and-known-issues.md#people-workstreams-and-ownership)).

| workstream | owns | writes |
|---|---|---|
| lead | `docs/runtime/CONTRACT.md`, `packages/runtime-model/`, `OPEN_TASKS.md`, `HANDOFF.md` (inferred); approvals, merges, publishing (the user's 2FA) | contract additions (CONTRACT §13); `docs/runtime/RESULTS.md` (HANDOFF: "update it with every result") |
| CORE | `packages/runtime/**` except `src/model/**`, `src/devtools/**`, `src/adapters/**`; situation wording; `src/types.ts` | `packages/runtime/STATUS.md` (batches, contract deltas, deviations) |
| MODEL | `packages/runtime/src/model/**`, `packages/runtime/bin/genclass-runtime.mjs`; co-owns the model-seam section of `types.ts` | `packages/runtime/src/model/README.md`, notes in `training/NEEDS.md` |
| UI | `packages/runtime/src/devtools/**`, `packages/runtime/src/adapters/**` (CONTRACT §13) | `packages/runtime/UI-NEEDS.md` |
| SIM | `sim/` | `sim/NEEDS.md`, `sim/README.md`, `sim/SEPARABILITY.md` |
| REAL | `realapps/` | `realapps/README.md`, `realapps/EXAMPLES.md`, requests and node claims in `training/NEEDS.md` |
| DEMOS | `demos/` | `demos/NEEDS.md`, `demos/README.md`, `demos/results*.{md,json}` |
| TRAIN | `training/` (per `training/README.md`; CONTRACT §1 lists the lead as owner) | `training/NEEDS.md`, `training/LOG.md`, `training/EVAL.md`, `training/PLAN-v1.md` |
| REVIEW | `packages/runtime/test/review-*.test.ts` (a contract: fix code, not these tests) | findings fixed in batch 3 |
| us (this machine) | commits 7dab2b3 (agent docs), f3636b2 (default mode `observe`), b435acb (CI, lockfile) on `mvp-v2` | `AGENTS.md`, `CLAUDE.md`, `docs/agents/**` |

NEEDS items carry OPEN / ASK / DONE (plus INFO in `training/NEEDS.md`); contract changes go through the lead; SIM,
REAL and DEMOS must not read each other's code. For an agent working alone, these files are the record of intent:
update the relevant STATUS/NEEDS entry when you change behaviour they describe.

## 9. Where the project stands (b435acb, 2026-10-08)

| item | state |
|---|---|
| Branches | `mvp-v2` = origin/runtime 74f17c0 + our six commits, head = release commit 806a296 (not pushed). The local branch `mvp` (based on 654d822, situation-v1) is superseded. Tags: `situation-v1` (1a77558), `situation-v2` (6e5e86e, current format), `v0.1.0-alpha.0` (654d822), `v0.1.0-alpha.1` (806a296, local only). |
| Runtime | batches 4 and 5 done: decisions at the network boundary, no store holds by default, EventSource observer, F1–F9 facts, leaf-based redaction, 2,400-char full budget; default mode `observe` (ours). |
| Tests | lead's run on `mvp-v2` (macOS, Node v25.6.0): `tsc` clean, `tsup` OK, vitest 351 tests = 337 passed + 14 model-parity skips (333 + 14 in the main run, counting the uncommitted `atoms.test.ts` test, 4 in `review-perf.test.ts` alone; it flaked once at 5.5 ms vs its 2 ms bound under parallel load). sim: `tsc` clean, `SIM_RUNTIME=real npx vitest run` 19 passed in 5 files. Not run: Playwright, `smoke.sh`, realapps, demos eval, Python tests, training. |
| CI | `.github/workflows/ci.yml` (Node 22, `npm ci`, typecheck, build, unit tests, then `review-perf` with `--retry=2`); its steps pass in a fresh clone; it has not run on GitHub yet. |
| npm | `@genclass/runtime@0.1.0-alpha.1` is `latest` (published 2026-10-08 from 806a296; NaN fix, situation-v2, default `observe`, no model). The older `0.1.0-alpha.0` is situation-v1 code with default `guard`. `@genclass/runtime-model` is a 404. Release procedure: [RELEASE.md](../../RELEASE.md). |
| Model | no situation-v2 model. R17-final1 (situation-v1) is the baseline only (section 5.3). |
| Data | SIM v2 (≥ 10M gold + ≥ 50M unlabeled) on c02–c09 and c12–c23; REAL v2 (≥ 500k gold) on c01, c10, c11; the colleague is operating the cluster (a read-only portal look at 04:14 UTC showed c01–c23 and `vm-jev-train` running, `vm-jev-data` deallocated). Nobody on our side touches Azure. |
| Never worse | realapps sweep, v2 runtime, all-passive model: 0/396 clean runs changed, 3/198 with chaos (request-time holds shifting chaos draws; open), determinism 198/198, conduit 0/30 (STATUS.md). These cover the 66 apps at the time, not the 25 added since, and compare final visible text and server content only ([realapps](realapps.md)). |
| Next (HANDOFF.md) | v2 data collected -> 150M teacher on v2 gold -> teacher labels on unlabeled rows -> distil R17 (default) and R32 -> DAgger via SIM `--on-policy` -> EVAL -> `@genclass/runtime-model@0.1.0` -> demos rerun -> `@genclass/runtime@0.1.0`. |
| Doc drift | HANDOFF.md still calls `guard` the default; CONTRACT.md lacks `delivery`; `realapps/README.md` and HANDOFF.md say 66 apps. See [status-and-known-issues](status-and-known-issues.md). |
| Open runtime issues | the review findings in section 4; `demos/NEEDS.md` §5 (`retry`/`block` on non-idempotent writes) still open; §1, §2 and §6 addressed in code but unmeasured on the demos. |
| Other infrastructure | test files are not type-checked; `demos/src/server/data/cities.ts` is missing from git (root `.gitignore` rule `data/`); `jev_local/data/` is missing (gitignored), so 20 legacy Python test files fail at collection; realapps has no lockfile, no tests and no CI. |

**Working rule for agents.** CONTRACT §0 rule 5 and HANDOFF.md ("never run npm, tsc, vitest ... on the Mac"; build
and test on the Azure `train` VM through `scripts/vm.sh`) exist because the colleague's Mac has 8 GB RAM. On this
machine `npm install`/`npm ci`, typecheck, build and unit tests are light and verified to work locally. Ask the user
before Playwright, `smoke.sh`, the sim generator, training, realapps runs, the demos' eval, model downloads, anything
on Azure, `git push` or `npm publish`. Do not change situation text without a plan for a new tag, regenerated data
and retraining.

## Related docs

- [README](README.md) (index of agent docs), [repo-map](repo-map.md), [glossary](glossary.md),
  [playbooks](playbooks.md).
- Runtime: [public-api-and-lifecycle](runtime/public-api-and-lifecycle.md),
  [observe-and-trace](runtime/observe-and-trace.md), [state-and-adapters](runtime/state-and-adapters.md),
  [learn-situation-triage](runtime/learn-situation-triage.md),
  [decide-policy-actions](runtime/decide-policy-actions.md), [model-host](runtime/model-host.md),
  [devtools](runtime/devtools.md), [build-test-release](runtime/build-test-release.md).
- Cross-cutting: [model-io-contract](model-io-contract.md), [status-and-known-issues](status-and-known-issues.md).
- Offline and legacy: [sim](sim.md), [realapps](realapps.md), [training](training.md), [demos](demos.md),
  [genclass-model-lineage](genclass-model-lineage.md), [extension-and-benchmarks](extension-and-benchmarks.md).
- Human docs (drift documented in status-and-known-issues): [HANDOFF.md](../../HANDOFF.md), [RELEASE.md](../../RELEASE.md),
  [OPEN_TASKS.md](../../OPEN_TASKS.md), [CONTRACT.md](../runtime/CONTRACT.md), [API.md](../runtime/API.md),
  [ARCHITECTURE.md](../runtime/ARCHITECTURE.md), [RESULTS.md](../runtime/RESULTS.md),
  [packages/runtime/STATUS.md](../../packages/runtime/STATUS.md).
