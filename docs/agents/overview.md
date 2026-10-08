# GenClass-lib system overview: the mental model

> **Scope:** the whole monorepo at the level of one mental model: `@genclass/runtime` (`packages/runtime/src/**`),
> the unpublished model package (`packages/runtime-model/`), `sim/`, `training/`, `demos/`, and the legacy GenClass
> content it builds on (`jev_local/`, `extension/`, `bench/`, `results/`, `scripts/`, legacy `docs/*.md`). Detail lives
> in the subsystem docs linked from every section; this doc names the stages and the seams between them.
> **Read this when:** you land in the repo cold and need to know what the parts are, how one runtime decision flows
> from an observed event to an action, how the offline loops (sim -> training -> model package, demos evaluation)
> connect to it, what each mode allows, what happens without a model, who owns what, and where the project stands.
> **Source of truth:** the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

Path convention: every code pointer is `path/from/repo/root` -> `symbol`. Runtime source is under
`packages/runtime/src/`.

## TL;DR

- `@genclass/runtime` is a browser library for self-healing web apps. It instruments the page (fetch, XHR,
  WebSocket, timers, DOM user events, errors, navigation, storage, long tasks) and the app's state stores, keeps a
  causal trace, learns baselines, invariants and transition profiles, and turns a suspicious moment (a *trigger*) into
  a plain-English *situation*. A small local model (ONNX in a Web Worker, WebGPU or WASM) answers two typed questions
  about it (diagnosis, action). A policy gate runs a minimal action (undoable only for `discard`, late reverts,
  `rollback` and custom `onUndo`) only at high calibrated confidence; otherwise the passive action (let it happen) runs.
- The runtime never maps a fact pattern to a diagnosis or action with an if/then (CONTRACT §0 rule 1). Facts are
  generic; triage only decides whether the model is worth asking; the model decides; the gate filters.
- One situation implementation (`packages/runtime/src/situation/*`) is shared by the runtime and by the sim, which
  drives the real runtime to produce training rows. Its text is frozen at git tag `situation-v1` (1a77558);
  `git diff situation-v1 HEAD -- packages/runtime/src` is empty at 654d822.
- Modes: `observe` (never changes execution), `guard` (default; guard-tier actions such as `discard`, `coalesce`),
  `heal` (adds heal-tier actions such as `retry`, `serve_cached`, `rollback`). Kill switch: `?genclass=off`.
- Fail open everywhere: no model, a loading or failed model, a timeout or any error means the passive action runs; a
  held write or request never waits for the model longer than the hold budget (at most 800 ms with the default
  `"auto"`); an action that then runs can add its own wait (`delay` and `coalesce` ≤ 8 s, `retry` backoff ≤ 5 s,
  `defer` ≤ 10 s per deferral before the write is re-decided, custom actions unbounded).
- **Where it stands:** `@genclass/runtime@0.1.0-alpha.0` is on npm, but the trained model package
  (`@genclass/runtime-model@0.1.0`, the default model URL) is not published, so a default install observes and learns
  but never decides or acts. SIM phase A data (600,676 rows) exists; final training round 1 was launched with no
  results in the repo; the demos have only been run with the v0.1 model (not trained for runtime decisions).

## 1. The problem and the product principles

Web apps fail at runtime in ways their code does not handle: an older response overwrites newer state (stale write),
the same request is sent twice from one intent (duplicate), a request keeps failing, a request hangs, a store ends up
contradicting a relation it normally keeps, an operation makes a state change unlike its usual ones. CONTRACT §0.5
states the claim: *install one library; find and prevent runtime failures automatically, with low false positives.*

Binding principles (`docs/runtime/CONTRACT.md` §0 and §0.5; restated with code locations in
[status-and-known-issues](status-and-known-issues.md#ground-rules-binding-contract-0-and-05-restated)):

| principle | what it means in code |
|---|---|
| Precision first | Default mode `guard` allows only guard-tier actions. The gate needs Σ p(permitted actions) ≥ 0.9 (guard) / 0.8 (heal) and a top diagnosis other than `expected` (`packages/runtime/src/decide/policy.ts` -> `gate`, `policyConfig`). The sim labels favour passive (tier premiums, tie rule). The false-intervention rate on clean runs is the headline metric in training eval and demos. |
| Cheap by default | Facts and baselines always run and are cheap; the model is consulted only for *salient* situations (`packages/runtime/src/runtime.ts` -> `RuntimeImpl.trigger`), runs in a Worker, loads at idle or lazily, and is cached. Target model size ≤ 25 MB q8 (R17 q8 9.58 MB, R32 q8 22.47 MB). |
| Observable | One console line per detection/intervention with collapsible evidence (`packages/runtime/src/decide/report.ts` -> `Reporter`), `explain(id)`, `undo()` for reversible actions, the `x-genclass` response header on synthetic answers (`blocked`, `cached`, `coalesced`), devtools overlay, kill switch. |
| No hardcoded bugs | Facts (`packages/runtime/src/situation/facts.ts` -> `computeFacts`) are uniform sentences with a `neutral` flag; applicability (`packages/runtime/src/situation/build.ts` -> `buildSituation`, internal `builtinApplicable`) only says whether an action *can* run. Only the model's probabilities choose. Without a model the runtime observes only. |
| Determinism and parity | Runtime code reads time only from the injected `Clock` (no `Math.random`, `Date.now`, global timers), so the sim can replay it byte for byte. The sim drives the same code; `training/curriculum/rt.py` is a Python port of the situation text. |
| Honest evaluation | `sim/` and `demos/` are built by different people who do not read each other's code (CONTRACT §0 rule 4). |

Adoption path: `observe` -> `guard` -> `heal`.

## 2. Component map

```text
 ONLINE: inside the app's page                       packages/runtime  (npm: @genclass/runtime)
 +------------------------------------------------------------------------------------------------+
 |  app code: fetch / XHR / WebSocket / timers / DOM events / store writes (atoms, Redux, Zustand)  |
 |      |                                     |                                                    |
 |      v                                     v                                                    |
 |  observe/*  --ops, events-->  trace/*   state/* StoreHub --writes--> InvariantMiner             |
 |  (patched globals)            (OpRegistry, Context, EventLog)        learn/* Baselines, Profiles |
 |      |  request / failure / stall      |  mutation          |  settled point: inconsistency,   |
 |      |  triggers                       |  trigger           |  transition triggers; error      |
 |      +---------------------------------+--------------------+                                   |
 |                                        v                                                        |
 |        runtime.ts RuntimeImpl.trigger: facts -> triage -> situation + questions (situation/*)   |
 |                                        |  EvaluateRequest { state, questions }                  |
 |                                        v                                                        |
 |        decide/decider.ts DeciderQueue --> DecisionProvider (default: model/* ModelHost)         |
 |                                               Worker: ModelBackend -> Engine -> onnxruntime-web |
 |                                        |  calibrated Answers (diagnosis, action)                |
 |                                        v                                                        |
 |        decide/policy.ts gate --> Controller.run(action) or passive()                            |
 |                                        v                                                        |
 |        Decision / ActionRecord --> report.ts console lines, explain(), undo(), rt.on() events   |
 |                                        --> devtools/* overlay, adapters/* hooks                 |
 +------------------------------------------------------------------------------------------------+
                                                   ^ model directory: model.json, *-q8.onnx, *-fp16.onnx,
                                                   |   tokenizer.json, calibration.json, meta.json
 OFFLINE                                           |   (planned home: @genclass/runtime-model, unpublished)
   sim/ --drives the real createRuntime--> rows {state, questions, labels}
                                                   |
   training/ curriculum + jev_local/train --> eval_runtime.py --> export_runtime.py --> model directory
   demos/  GenClass.init Off / Guard / Heal --> seeded trials + oracles --> demos/results.md
   legacy: jev_local/ (Python model, packer, trainer), extension/ (v0.1 model card), bench/, results/
```

| component | path | role | state at 654d822 | doc |
|---|---|---|---|---|
| Public API and wiring | `packages/runtime/src/index.ts` (`GenClass`, `createRuntime`), `packages/runtime/src/runtime.ts` (`RuntimeImpl`), `types.ts`, `clock.ts`, `util.ts` | facade, construction, modes, kill switch, events, plugins, settled points | done, frozen | [public-api-and-lifecycle](runtime/public-api-and-lifecycle.md) |
| Observers and trace | `packages/runtime/src/observe/*`, `packages/runtime/src/trace/*` | patch globals, ops with causes, ambient context, event log, fetch/XHR action controllers | done, frozen | [observe-and-trace](runtime/observe-and-trace.md) |
| State | `packages/runtime/src/state/*`, `packages/runtime/src/adapters/*` | `StoreHub` (atom/guard/adapter stores), mutation pipeline and holds, invariant miner, snapshots; React/Redux/Zustand adapters | done, frozen | [state-and-adapters](runtime/state-and-adapters.md) |
| Learn, situation, triage | `packages/runtime/src/learn/*`, `packages/runtime/src/situation/*` | baselines, transition profiles, facts, triage, situation text and questions (model input) | done, frozen at `situation-v1` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| Decide | `packages/runtime/src/decide/*` | queue, hold budget, policy gate, actions, reports, explain, undo | done, frozen | [decide-policy-actions](runtime/decide-policy-actions.md) |
| Model host | `packages/runtime/src/model/*`, `packages/runtime/bin/genclass-runtime.mjs` | worker, loader (Cache Storage + sha256), WebGPU/WASM plans, Python-parity packer, calibration, CLI | done, frozen | [model-host](runtime/model-host.md) |
| Devtools | `packages/runtime/src/devtools/*` | shadow-DOM overlay on the public API | done, frozen | [devtools](runtime/devtools.md) |
| Build, test, release | `packages/runtime/{package.json,tsup.config.ts,test/**}` | tsup ESM build (6 entries), vitest, Playwright, smoke test | alpha published; no CI | [build-test-release](runtime/build-test-release.md) |
| Model I/O contract | runtime `situation/*` + `model/*`, `sim/`, `training/` | situation text -> packed request -> heads -> calibrated answers | frozen | [model-io-contract](model-io-contract.md) |
| Model package | `packages/runtime-model/` | planned home of the published model directory | only `MODEL_CARD.md`; package not created | [model-host](runtime/model-host.md), [build-test-release](runtime/build-test-release.md) |
| Sim | `sim/` (`@genclass/sim`) | training-data generator driving the real runtime in a virtual world | phase A done (600,676 rows); phase B in progress at commit time | [sim](sim.md) |
| Training | `training/` | curriculum, R17/R32 training, eval, ONNX export | final round 1 launched, no results in repo | [training](training.md) |
| Demos | `demos/` (`@genclass/demos`) | six demo apps, Service Worker chaos backend, trial harness | built; results only with v0.1 model | [demos](demos.md) |
| GenClass model lineage | `jev_local/`, `scripts/genclass_export.py`, `tests/` | Python predecessor: model, packer, calibration, trainer; reference for parity | legacy except trainer, export graph, parity reference | [genclass-model-lineage](genclass-model-lineage.md) |
| Extension, benchmarks, ops scripts | `extension/`, `bench/`, `results/`, `BENCHMARKS.md`, `scripts/` | GenClass 0.1 Chrome extension, Jev benchmarks, Azure/VM scripts | legacy; `scripts/vm.sh`, `scripts/azvm.sh`, `scripts/launch_run.sh` still used | [extension-and-benchmarks](extension-and-benchmarks.md) |
| Status and team files | `OPEN_TASKS.md`, `packages/runtime/STATUS.md`, `*/NEEDS.md`, `docs/runtime/{CONTRACT,API,ARCHITECTURE}.md` | plan, status, requests, binding contract | drift documented | [status-and-known-issues](status-and-known-issues.md) |

Paths and per-directory detail: [repo-map](repo-map.md). Terms: [glossary](glossary.md).

## 3. Runtime data flow end to end

Every stage below runs inside `RuntimeImpl` (constructed by `GenClass.init` or `createRuntime`). The first four stages
always run, model or not; stages 5 onward run only while the runtime is *consultable* (not paused, not destroyed, a
`DecisionProvider` exists, and its `status.state` is `ready` or `off`).

| # | stage | what happens | code (file -> symbol) | doc |
|---|---|---|---|---|
| 1 | Observers | Constructor installs, in order, timers, fetch, xhr, websocket, user (DOM), errors, nav, storage, perf; each in try/catch; each patched global becomes a pass-through after `destroy()` (WebSocket instances and timer callbacks created before `destroy()` keep tracing; see [observe-and-trace](runtime/observe-and-trace.md), 'After destroy: what still runs'). | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.installObservers`; `packages/runtime/src/observe/fetch.ts` -> `installFetch`; `packages/runtime/src/observe/dom-user.ts` -> `installDomUser` | [observe-and-trace](runtime/observe-and-trace.md) |
| 2 | Trace, ops, causality | Every async unit is an `OpRec` (id, kind, signature name such as `GET /api/search`, detail such as `?q=rea`, cause, root). The ambient op (set by `run`, `stick`, `stickUser`) becomes the cause of new ops and the writer of state writes. Events go to a ring buffer (default 500). | `packages/runtime/src/trace/ops.ts` -> `OpRegistry`; `packages/runtime/src/trace/context.ts` -> `Context`, `LazyOp`; `packages/runtime/src/trace/events.ts` -> `EventLog`; `packages/runtime/src/runtime.ts` -> `RuntimeImpl.startOp`, `RuntimeImpl.endOp`, `RuntimeImpl.user` | [observe-and-trace](runtime/observe-and-trace.md) |
| 3 | Stores | Store values are flattened into versioned dotted fields with writer ops and history. Each `set`/`dispatch` becomes a `MutationRec`: user-sync, GenClass, paused, `hold: false`, no-op and unholdable writes bypass; the rest go through the hub's `gate` hook in per-store FIFO order. | `packages/runtime/src/state/hub.ts` -> `StoreHub.propose`, `StoreHub.commit`; `packages/runtime/src/runtime.ts` -> `RuntimeImpl.gateMutation`, `RuntimeImpl.onApplied` | [state-and-adapters](runtime/state-and-adapters.md) |
| 4 | Learned baselines, invariants, profiles | Fetch/XHR latency (≥ 5 samples), outcomes, failure streaks and rates per signature; at *settled points* (60 ms after the last op end or write, nothing younger than 10 s in flight and no held or queued write) the invariant miner checks 9 generic templates and transition profiles flag rare state changes (< 1% of ≥ 20 completions). | `packages/runtime/src/learn/baselines.ts` -> `Baselines`; `packages/runtime/src/state/invariants.ts` -> `InvariantMiner.observe`; `packages/runtime/src/learn/profiles.ts` -> `Profiles`; `packages/runtime/src/runtime.ts` -> `RuntimeImpl.settled` | [learn-situation-triage](runtime/learn-situation-triage.md), [state-and-adapters](runtime/state-and-adapters.md) |
| 5 | Trigger | A raise site calls `trigger(spec, controller, { hold, priority })`. Kinds: `mutation` (held), `request` (held), `failure` (fetch: holdable, held only when a failure action is permitted, i.e. in heal mode or with a guard-tier custom failure action), `stall`, `inconsistency`, `transition`, `error`; `ask` comes from `rt.ask`/`rt.situation`. | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.trigger`, `gateMutation`, `watchStall`, `raiseInconsistency`, `raiseTransition`, `reportError`; `packages/runtime/src/observe/fetch.ts` -> `installFetch` (internal `runRequest`, `failureGate`) | [decide-policy-actions](runtime/decide-policy-actions.md) |
| 6 | Facts | Uniform English sentences per trigger, each with a kind and a `neutral` flag; ordered non-neutral first; at most 12. | `packages/runtime/src/situation/facts.ts` -> `computeFacts`, `orderFacts` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| 7 | Triage | With `triage: "salient"` (default) the model is asked only if some fact is non-neutral, a standing question has `always: true`, or the trigger is `ask`. Otherwise the passive action runs with no model call and no record. | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.trigger` | [learn-situation-triage](runtime/learn-situation-triage.md) |
| 8 | Situation + questions | 7-key `JevState` (`app, trigger, facts, in_flight, timeline, state, stats`) sized by a character budget (3,200 full; auto 1,000-2,000 on WASM); `diagnosis` question (10 labels) and `action` question (applicable actions, passive first, only when ≥ 2 apply); bare labels at ≤ 1,400 chars. | `packages/runtime/src/situation/build.ts` -> `buildSituation`; `packages/runtime/src/situation/serialize.ts` -> `toJevState`; `packages/runtime/src/situation/questions.ts` -> `buildQuestions`; `packages/runtime/src/runtime.ts` -> `RuntimeImpl.situationBudget` | [learn-situation-triage](runtime/learn-situation-triage.md), [model-io-contract](model-io-contract.md) |
| 9 | Hold or not | The subject is held only if the trigger is holdable and the mode and policy permit at least one non-passive action; the wait for the decision lasts at most the hold budget (`"auto"`: clamp(round(1.5 × median of the last 20 provider latencies, or the model's `warmupMs` before any), 150, 800) ms; 300 ms when neither is known). Otherwise the passive action runs now and the decision continues in the background (detection only). | `packages/runtime/src/decide/policy.ts` -> `permittedActions`, `holdBudget` | [decide-policy-actions](runtime/decide-policy-actions.md) |
| 10 | Decision queue | Single-flight priority queue (32 items, 30 s answer cache, deadlines, 10 s runtime-side timeout); every miss, error or timeout resolves `null` -> passive. | `packages/runtime/src/decide/decider.ts` -> `DeciderQueue.submit` | [decide-policy-actions](runtime/decide-policy-actions.md) |
| 11 | Model host | `evaluate` rejects at once unless `ready`. In the Worker (inline fallback), the packer renders the state and questions with Python-parity serialization, tokenizes, packs `[CLS] key: text [SEP] ... [Q] header [O] item ...` with block attention, and runs one ONNX forward pass (heads `choice_logits`, `score_logits`, `noul_logits`). | `packages/runtime/src/model/host.ts` -> `createModelHost`, `ModelHost.evaluate`; `packages/runtime/src/model/backend.ts` -> `ModelBackend.evaluate`; `packages/runtime/src/model/engine.ts` -> `Engine.evaluate`; `packages/runtime/src/model/packer.ts` -> `Packer.pack` | [model-host](runtime/model-host.md), [model-io-contract](model-io-contract.md) |
| 12 | Calibrated answers | Per-question temperature (by header, bucket or kind) or Platt scaling turns logits into `Answer`s (`choice`, `confidence`, `probabilities`). The gate reads only `probabilities` and the diagnosis `choice`. | `packages/runtime/src/model/calibrate.ts` -> `calibrateLogits`, `buildAnswer` | [model-io-contract](model-io-contract.md) |
| 13 | Policy gate | A = applicable non-passive actions the mode allows minus `deny`; candidate = argmax over A; runs iff not paused, Σ p(A) ≥ the candidate tier's threshold, top diagnosis ≠ `expected`, < 60 actions in the last minute, and, for holdable triggers (mutation, request, fetch failure), the answer arrived while the subject was still held (else late-revert rules; non-holdable triggers skip this check). | `packages/runtime/src/runtime.ts` -> `RuntimeImpl.onDecision`; `packages/runtime/src/decide/policy.ts` -> `gate` | [decide-policy-actions](runtime/decide-policy-actions.md) |
| 14 | Action or passive | The subject's `Controller` performs the action (`run`) or lets it through (`passive`). A throw runs passive. | `packages/runtime/src/decide/exec.ts` -> `Controller`; controllers in `packages/runtime/src/runtime.ts` -> `gateMutation`, `RuntimeImpl.rollback`, `RuntimeImpl.revertChain`, `RuntimeImpl.resync` and `packages/runtime/src/observe/fetch.ts` -> `installFetch` (internal `reqCtl`, `failureGate`, `stallController`) | [decide-policy-actions](runtime/decide-policy-actions.md) |
| 15 | Report, explain, undo, events | Every model answer to a trigger is a `Decision` (`d<n>`); every non-passive attempt an `ActionRecord` (`a<n>`, exact `changed` sentence, optional idempotent `undo`); console lines deduped per 60 s; events `decide`, `detect`, `act`, `report`, `status`, `event`; past actions reappear in later timelines as `GenClass <changed>`. | `packages/runtime/src/decide/report.ts` -> `Reporter`, `interventionLine`, `detectionLine`; `packages/runtime/src/runtime.ts` -> `RuntimeImpl.explain`, `RuntimeImpl.on`; `packages/runtime/src/devtools/index.ts` -> `mountDevtools` | [decide-policy-actions](runtime/decide-policy-actions.md), [devtools](runtime/devtools.md) |

## 4. Walkthrough: a typeahead stale write

The canonical bug. The user types into a search box; each keystroke sends `GET /api/search?q=...`; an older, slower
response arrives after a newer one and is about to overwrite newer results. The situation text below is Example A
from [learn-situation-triage](runtime/learn-situation-triage.md#12-annotated-examples-copied-from-packagesruntimestatusmd-produced-by-the-tests),
produced by `packages/runtime/test/budget.test.ts` -> `typeahead` at a 1,000-char budget. That test registers
`rt.atom("search", { query: "", results: [] })`, types `r`, `re`, `rea`, `reac` through `rt.user(...)`, and serves
`q=rea` with 900 ms latency and every other query with 120 ms. Op ids: `#5` user typed `rea`, `#6` `GET
/api/search?q=rea`, `#7` user typed `reac`, `#8` `GET /api/search?q=reac` (`#1`-`#4` are the `r` and `re` prefixes).
The steps assume a `ready` model and the default `guard` mode; the table after them covers the other cases.

1. **Keystroke -> user op.** In a browser, the capture-phase `input` listener (`packages/runtime/src/observe/dom-user.ts`
   -> `installDomUser`) calls the sink with `{ kind: "type", target: 'input "Search"', value }`, which is
   `RuntimeImpl.user`. It starts an instant `user` op, merges keystrokes on the same target into one typing event, and
   calls `Context.stickUser`, so the app's own listener in the same task runs with that op as ambient (the test calls
   `rt.user(action, handler)` directly, which runs the handler inside `Context.run`).
2. **Query write bypasses.** The handler's `search.set(v => ({ ...v, query: q }))` reaches `StoreHub.propose`. Its cause
   is the task's user op, so it is *user-sync* and bypasses the gate (`policy.holdUserWrites` is false): applied at once,
   `search.query` gets a new version with writer `#5`.
3. **Request -> fetch op.** `fetch("/api/search?q=rea")` hits the wrapper from `installFetch`: `startOp("fetch", "GET
   /api/search")` with detail `?q=rea` and cause `#5` (`#6`); `Baselines.start` records the start; `registerIdentity`
   records the request identity. The request gate raises a `request` trigger (hold, priority 2). Its salient facts
   would be R3 (an *identical* request close by), R5 (≥ 2 failures in a row) or R7 (hot rate); `q=rea` and `q=reac`
   have different identities, nothing failed, and no usual rate is learned yet, so every fact is neutral and the
   request is sent at once with no model call. The same happens 90 ms later for `#7` -> `#8`.
4. **The newer response lands first.** `#8` answers after 120 ms. `endOp` records latency and outcome; the fetch op is
   stuck as ambient while the app reads the body (`instrumentResponse`), so `search.set(... results ...)` is a write
   with cause `#8`. `gateMutation` -> `trigger({ trigger: "mutation", m })` computes facts: no other chain wrote the
   written fields since `#8` started, and the only other in-flight `GET /api/search` (`#6`) is older, so nothing is
   salient; the controller's `passive()` runs synchronously and the write applies in the caller's stack.
   `search.results` goes to version 1, writer `#8`.
5. **The older response arrives.** `#6` answers at 900 ms; its write proposes `results: ["rea-1", "rea-2"]` with cause
   `#6`. Now `computeFacts` (`mutationFacts`) finds M2 (salient: `search.results` was written by another chain since
   `#6` started) and M5 (salient: `search.query`, same store, changed by another chain since then), plus neutral
   provenance (M1) and delta (M15). Triage passes. `buildSituation` builds the situation; `toJevState` shapes it to the
   budget (the test fixes 1,000 chars, which is also the auto budget on single-threaded WASM):

```text
app: /search
trigger: A write to search.results from GET /api/search?q=rea (#6) is about to be applied.
facts:
  search.results was written once by other operations since this write's cause (#6) started (version 0 → 1), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later user action (#7).
  search.query changed since this write's cause (#6) started: "rea" → "reac", last by user typed "reac" into input "Search" (#7) 0.09s after #6 started.
  This write comes from GET /api/search?q=rea (#6), started 0.90s ago, ended 0.00s ago with 200; its chain began with user typed "rea" into input "Search" (#5).
  This write would change search.results: 2 items ["reac-1", "reac-2"] → 2 items ["rea-1", "rea-2"].
in_flight: none
timeline:
  -0.00s end GET /api/search?q=rea (#6): 200 in 0.90s
state:
  search.results = 2 items ["reac-1", "reac-2"] (v1, by #8 0.69s ago)
  search.query = "reac" (v4, by #7 0.81s ago)
stats:
  GET /api/search: 4 done, 0 of last 4 failed, 4 in last 10s
questions:
  diagnosis: What is happening here? expected | stale | conflict | duplicate | inconsistent | failing | slow | overload | unusual | transient
  action: What should the runtime do with this write? apply | discard | defer
```

   This is `stateText` of the `JevState` plus the test's printout of the questions. The model receives the `state`
   object and a `questions` object of two `choice` questions whose `criteria` are all `null` (compact questions at
   ≤ 1,400 chars). At the full 3,200-char budget the same write carries a 16-line timeline and described options; that
   version is in `packages/runtime/STATUS.md` ("Example situations: full budget"). Its timeline also shows that in this
   test the `#2` and `#4` writes were themselves dropped (`GenClass Dropped the write to search.results from GET
   /api/search?q=re (#4); search stays at version 3.`), which is why `search.results` was still at version 0 when `#6`
   started.
6. **Hold.** In `guard` mode the permitted set is `discard` and `defer` (guard tier; `defer` is offered while
   `m.defers < 2`), so `waits` is true: `gateMutation` returns `{ held }` and the hub keeps the write queued. A budget
   timer is armed (`RuntimeImpl.holdBudgetMs`), and `DeciderQueue.submit` gets priority 2 and deadline
   `t0 + budget + 2000` (the extra 2 s is the late-revert window, since mutation controllers can revert).
7. **Model.** `ModelHost.evaluate` -> Worker -> `ModelBackend.evaluate` -> `Engine.evaluate`: `Packer.pack`, one forward
   pass, `unpackLogits`, `calibrateLogits` and `buildAnswer` per question. The result is `{ diagnosis: ChoiceAnswer,
   action: ChoiceAnswer }`, each with `probabilities` in criteria order.
8. **Gate.** `RuntimeImpl.onDecision` -> `gate`: A = {`discard`, `defer`}; candidate = the more probable of the two; it
   runs iff p(discard) + p(defer) ≥ 0.9, the top diagnosis is not `expected`, the rate limiter has room, and the subject
   is still held. A `Decision` is recorded either way; `decide` fires, and `detect` fires when the diagnosis is not
   `expected` with p ≥ 0.6.
9. **Action.** If `discard` passes: `rate.take`, then the mutation controller's `run("discard")` settles the verdict
   `discard`; the hub drops the write and the app is never notified, so `search.results` keeps the `reac` results. The
   `ActionRecord` has `changed` = `Dropped the write to search.results from GET /api/search?q=rea (#6); search stays at
   version <v>.` and an `undo` that commits the original write as a GenClass write. An `action` event is pushed, so
   later situations show `GenClass Dropped the write ...` in their timeline.
10. **Report.** With diagnosis `stale`, `interventionLine` prints `[GenClass] Prevented a stale write: <first
    non-provenance fact> <changed> (stale, <p>; discard <p>)`, here led by the M2 fact. The console groups the facts,
    timeline, exact situation text and answers under it, plus an undo hint and a deny hint. `rt.explain("<id>")`
    returns the same evidence; the devtools Interventions card offers Undo.

Other outcomes of the same trigger:

| condition | result |
|---|---|
| gate fails (mass < 0.9, top diagnosis `expected`, rate limit) | `apply` runs when the answer arrives; the stale results show; if the diagnosis is `stale` with p ≥ 0.6, a `Flagged a stale write: ...` detection line prints (with a `Not acted on (...)` clause when the gate recorded a reason) |
| model slower than the hold budget | the budget timer applies the write (fail open); a gate-passing `discard` within 2 s can still revert it if nothing changed those fields since (`Reverted a stale write: ...`, `ActionRecord.late`) |
| `mode: "observe"` | nothing is permitted, so the write applies at step 6 with no hold; the decision is made in the background (deadline 5 s) and can only flag |
| model loading, failed or absent (the alpha default once the card fetch fails) | `consultable()` is false; `gateMutation` returns no hold, no facts are computed, nothing is recorded; the stale write applies exactly as without GenClass |
| model status `off` (lazy preload not started) | facts and triage run; this salient write starts the model load and applies at once (fail open) |

Known product risks on exactly this path (open in code, `demos/NEEDS.md`): holds add latency to typeahead-like apps
(§2; search clean p50 14 -> 125 ms with v0.1), and a held write can land after a newer user-sync write to the same
store (§1). Store names must not contain `.` (for example `search.results` as a store name): nothing enforces it,
and the version facts that detect this bug then always say the field "has not changed"
([state-and-adapters](runtime/state-and-adapters.md)).

## 5. Offline loops

### 5.1 Training-data loop (sim)

```text
seed -> buildScenario (domain, features, net, budget, split) -> ideal run + base run (real runtime, recording decider)
     -> sampled decision points k -> one counterfactual run per applicable action x up to K=3 paired futures
     -> runCost vs ideal -> actionLabel (soft action distribution) + diagnose (hard diagnosis label)
     -> CONTRACT-D rows {id, split, family, state, questions, labels, meta} -> <out>/{train,dev,test}.jsonl + stats.json
```

- CLI and workers: `sim/src/gen.ts` -> `main`; one trajectory: `sim/src/gen/trajectory.ts` -> `generateTrajectory`,
  `pointCosts`; one run: `sim/src/run/runner.ts` -> `runScenario` on a `VirtualLoop` (`sim/src/loop.ts`).
- The real runtime is loaded by `sim/src/run/rt.ts` -> `realRuntimeFactory` with `createOptions`: `model: false`, the
  sim's recording decider, `mode: "heal"`, `triage: "salient"`, a fixed `situation.budget` (3200/2000/1000), observers
  `fetch`, `timers`, `websocket` only, gate thresholds 0.5 with `requireDiagnosis: false` so exactly the forced action
  runs. The decider stores every `EvaluateRequest`'s `state` and `questions` verbatim: the sim never writes situation
  text, which is what keeps train/runtime parity.
- Labels: `sim/src/oracle/cost.ts` -> `runCost`, `actionLabel` (tier premium 0/0.25/0.5, ties within 0.05 pinned to
  passive); `sim/src/oracle/diagnose.ts` -> `diagnose`. Plus diagnosis-only rows and `ask` rows with exact labels.
- Output so far: phase A on the frozen runtime, 600,676 rows (`sim/samples/stats-final-a.json`). Detail: [sim](sim.md).

### 5.2 Training and export loop

```text
prune_vocab.py (16,000 merges -> 16,364 tokens)
  -> stage 1 / 1c: synthetic curriculum (curriculum/generate.py; cur1 varied style in s1, cur2 adds rt.py runtime-exact rows in s1c)
  -> stage 2 / final rounds: jev_local/train/train.py on SIM rows + curriculum replay (configs/mix_*.json, Azure nodes)
  -> eval_runtime.py (FIR, precision, recall, cost regret, ECE; --write-calibration -> calibration.json)
  -> export_runtime.py (<name>-q8.onnx: 8-bit MatMulNBits + int8 embeddings; <name>-fp16.onnx; tokenizer.json,
     calibration.json, meta.json, model.json card "genclass-runtime-model/1"; parity fixtures)
  -> ortweb/validate.mjs (onnxruntime-web WASM vs torch logits)
  -> [planned] publish as @genclass/runtime-model@0.1.0 (jsDelivr serves files/ = DEFAULT_MODEL_BASE_URL)
     + GitHub release runtime-model-v0.1.0 (the CLI's default --from)
  -> runtime: model/loader.ts fetchCard -> parseCard -> planOrder -> fetchFile (size + sha256, Cache Storage)
     -> ModelBackend.load -> Engine (graph-contract check, warm-up) -> status "ready"
```

- Candidates: R17 (ettin-encoder-17m, d 256 × 7 layers, intended for WASM) and R32 (GenClass 0.1 `jev-local-fast`,
  ettin-32m, d 384 × 10 layers, WebGPU only if clearly better; OPEN_TASKS item 5).
- Code: `training/curriculum/generate.py`, `training/curriculum/rt.py` -> `render`, `to_state`;
  `jev_local/train/train.py`; `training/eval_runtime.py` -> `fit_calibration`, `decision_metrics`;
  `training/export_runtime.py` -> `main` (graph from `scripts/genclass_export.py`);
  `packages/runtime/src/model/loader.ts` -> `fetchCard`, `parseCard`, `planOrder`, `fetchFile`.
- Results so far: stage 1c held-out `rt1` action/diagnosis about 98% with 0% FIR; the stage-2 pilot (pre-freeze data)
  was precise but rarely acted (heal recall about 1.3%); final round 1 has no results in the repo. Detail:
  [training](training.md), [model-io-contract](model-io-contract.md), [genclass-model-lineage](genclass-model-lineage.md).

### 5.3 Evaluation loop (demos)

- Six apps (`search`, `editor`, `checkout`, `status`, `board`, `decisions`), each with a deliberate latent bug, on a
  Service Worker mock API with seeded chaos. GenClass is created only in `demos/src/shared/genclass.ts` ->
  `startGenClass`: **Off** = `GenClass.init({ mode: "observe", model: false })` (installed, never decides),
  **Guard** / **Heal** = `GenClass.init({ mode, model: { baseUrl, preload: "eager" } })`. App code is identical.
- A trial is a seeded scenario run in a fresh page by `demos/src/shared/harness.ts` -> `TrialHarness` with the
  synthetic driver (`demos/src/shared/driver.ts` -> `runSteps`) or Playwright (`demos/e2e/eval.ts`), scored by the
  demo's oracle (DOM + server truth only). `demos/src/shared/aggregate.ts` -> `summarizeMode` reports Wilson bug
  rates on chaos trials, false interventions on clean trials, fixed/introduced vs Off, and latency medians.
- Shipped `demos/results.md` (810 trials, v0.1 model (not trained for runtime decisions), WASM q8): no executed action lowered a bug rate,
  0 false interventions, holds added latency (search) and introduced board bugs. Detail: [demos](demos.md).

### 5.4 How a runtime change reaches the shipped model

CORE changes text the model reads -> the lead freezes it with a tag -> SIM regenerates rows from that exact runtime ->
TRAIN mirrors the wording in `training/curriculum/rt.py`, trains, calibrates, evaluates, exports -> MODEL checks TS
packer/engine parity against the export's fixtures -> the lead publishes the model package, then the runtime. Any
change to facts, timeline/state/stats lines, question wording, diagnosis labels, budgets, `util.ts` formatters, op or
event names, the packer, tokenizer or calibration lookup is a model-format change
([model-io-contract](model-io-contract.md), [status-and-known-issues](status-and-known-issues.md)).

## 6. Modes and what each allows

Mode-tier rule: `packages/runtime/src/decide/policy.ts` -> `modeAllows`. Thresholds from `policyConfig`: report 0.6,
guard 0.9, heal 0.8.

| mode | how to get it | actions that can run | holds | decisions and reports |
|---|---|---|---|---|
| off (kill switch) | `?genclass=off` or `localStorage.genclass = "off"` (URL wins), read by `packages/runtime/src/index.ts` -> `killSwitch` | none | never | inert runtime: every observer off, no decider, `report: "silent"`; all caller options dropped |
| `observe` | `mode: "observe"`, `?genclass=observe`, `setMode` | passive only | never | with a ready model, salient triggers are still decided in the background and recorded; detections print `Flagged ...` |
| `guard` (default) | `mode` default | passive + guard tier: `discard`, `defer`, `coalesce`, `delay`, guard-tier custom actions | when a guard action is permitted for that trigger | decisions, detections, interventions |
| `heal` | `mode: "heal"` | guard + heal tier: `block`, `serve_cached`, `retry`, `hedge`, `rollback`, `resync`, custom actions (default tier heal) | when any non-passive action is permitted | decisions, detections, interventions |

Also: `policy.allow` / `policy.deny` narrow the permitted set; `pause()` stops gating and triggers while tracing
continues; `setMode` applies to the next gate. Passive actions per trigger: mutation `apply`, request `send`,
failure `deliver`, stall `wait`, inconsistency/transition/error `ignore`. Details:
[public-api-and-lifecycle](runtime/public-api-and-lifecycle.md#modes-and-tiers),
[decide-policy-actions](runtime/decide-policy-actions.md).

## 7. With no model: fail open, observe only

`consultable()` (`packages/runtime/src/runtime.ts` -> `RuntimeImpl.consultable`) is true only when a provider exists
and its state is `ready` or `off`. Consequences:

| provider state | what triggers do |
|---|---|
| no provider (`createRuntime` without `decider`/`model`, `GenClass.init` outside a browser without a `decider`, `model: false`, kill switch) | nothing is computed or held; every subject proceeds; no `Decision` ever |
| `off` (idle preload not started yet) | facts and triage run; the first salient situation starts the load (`void this.ready`) and fails open |
| `loading` | skipped entirely: no facts, no holds, no records |
| `error` | same as `loading`, permanently: `ready` is memoised and nothing retries the load |
| `ready` | full pipeline |

What a default `GenClass.init()` does at 654d822 (verified by code reading only; no test covers it): it creates a
model host for `DEFAULT_MODEL_BASE_URL` = `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/`
(`packages/runtime/src/model/host.ts`), the idle preload fetches `model.json` from a package that does not exist,
the status becomes `error`, the console prints `[GenClass] Model unavailable (...); observing only.`, and from then on
no situation is built and nothing is held or acted on. Tracing, field versions, baselines, invariants and profiles keep
learning; `rt.situation()` still works; `rt.ask()` rejects with `GenClassUnavailableError` (or the raw provider error
when `timeoutMs` is set). To exercise the decision
pipeline today, self-host the v0.1 GenClass model (`npx genclass-runtime fetch-model <dir> --from
https://github.com/MeharPro/GenClass/releases/download/v0.1.0/`, then `model: { baseUrl }`); v0.1 is a general
classifier, not trained for runtime decisions, and answers `unusual` almost always. Full sequence:
[status-and-known-issues](status-and-known-issues.md#1-what-a-default-install-does-today-model-unpublished).

## 8. Workstreams and ownership

The project was built by parallel workstreams coordinated by a lead, communicating through status and NEEDS files
(detail, conventions and drift: [status-and-known-issues](status-and-known-issues.md#workstreams-and-ownership)).

| workstream | owns | writes |
|---|---|---|
| lead | `docs/runtime/CONTRACT.md`, `packages/runtime-model/`, `OPEN_TASKS.md` (inferred); approvals, merges, publishing; `training/` per CONTRACT §1 | contract additions (CONTRACT §13) |
| CORE | `packages/runtime/**` except `src/model/**`, `src/devtools/**`, `src/adapters/**`; situation wording; `src/types.ts` | `packages/runtime/STATUS.md` (with "Deviations from the contract") |
| MODEL | `packages/runtime/src/model/**`, `packages/runtime/bin/genclass-runtime.mjs`; co-owns the model-seam section of `types.ts` | `packages/runtime/src/model/README.md`, MODEL -> TRAIN notes in `training/NEEDS.md` |
| UI | `packages/runtime/src/devtools/**`, `packages/runtime/src/adapters/**` (CONTRACT §13) | `packages/runtime/UI-NEEDS.md` |
| SIM | `sim/` | `sim/NEEDS.md`, `sim/README.md` |
| DEMOS | `demos/` | `demos/NEEDS.md`, `demos/README.md`, `demos/results*.{md,json}` |
| TRAIN | `training/` (per `training/README.md`; CONTRACT §1 lists the lead as owner) | `training/NEEDS.md`, `training/LOG.md`, `training/EVAL.md` |
| REVIEW | `packages/runtime/test/review-*.test.ts` (a contract: fix code, not these tests) | findings fixed in batch 3 |

NEEDS items carry OPEN / ASK / DONE (plus INFO in `training/NEEDS.md`); contract changes go through the lead; SIM and
DEMOS must not read each other's code. For an agent working alone, these files are the record of intent: update the
relevant STATUS/NEEDS entry when you change behaviour they describe.

## 9. Where the project stands (654d822)

| item | state |
|---|---|
| Runtime core, model host, devtools, adapters | done; source frozen at `situation-v1` |
| npm | `@genclass/runtime@0.1.0-alpha.0` published (per `OPEN_TASKS.md`; tag `v0.1.0-alpha.0`); it takes no actions until the model package exists |
| Model package | `@genclass/runtime-model@0.1.0` not created (`packages/runtime-model/` has only `MODEL_CARD.md`); no `runtime-model-v0.1.0` tag exists for the planned GitHub release |
| SIM data | phase A done (600,676 rows); phase B (1.4M rows) in progress at commit time |
| Training | stage 1c done; stage-2 pilot done; final round 1 (R17, R32 on phase A) launched, no results in the repo |
| Demos | built; results only with the v0.1 model (not trained for runtime decisions); `demos/src/server/data/cities.ts` is missing from git (root `.gitignore` rule `data/`), which blocks building the search demo from a fresh clone |
| Next (`OPEN_TASKS.md`) | choose R17/R32, publish the model package and release, then `@genclass/runtime@0.1.0`; add CI; re-run demos with the trained model; investigate hold-induced harm and typeahead triage sensitivity (salient about 6 times per clean trial) |
| Open runtime issues | `demos/NEEDS.md` §1 (held write lands after a newer user write), §2 (hold latency), §5 (`retry` offered for non-idempotent requests), §6 (no EventSource observer) |
| Infrastructure | no `.github/` (no CI); no committed root `package-lock.json`; test files are not type-checked; `jev_local/data/` is missing (gitignored), so 20 legacy Python test files fail at collection |

**Local verification when these docs were written (2026-10-07; macOS, 16 GB RAM, Node v25.6.0, npm 11.8.0).** `npm install` at the
root succeeds in about 18 s (one EBADENGINE warning for vitest 5.0.3 on Node 25; it creates an untracked root
`package-lock.json` and chmods `packages/runtime/bin/genclass-runtime.mjs` to 755, revert with `git checkout --
packages/runtime/bin/genclass-runtime.mjs`). In `packages/runtime`: `npx tsc -p tsconfig.json --noEmit` is clean;
`npx tsup` builds in about 2.5 s; `NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**"` gives
286 passed and 14 skipped (the model-parity tests that need `GENCLASS_MODEL_DIR`). Not run: Playwright, the smoke
test, sim, training, demos, Python tests, model downloads, anything on Azure.

**Working rule for agents (set when these docs were written).** CONTRACT §0 rule 5 ("the Mac only edits files"; everything on the
Azure `train` VM through `scripts/vm.sh`) existed because the original author's Mac had 8 GB RAM. On other machines,
`npm install`, typecheck, build and unit tests are light and verified to work locally. Ask the user before running the
sim, training, Playwright, model downloads, the demos' eval, or any script that touches Azure (`scripts/*.sh`,
`training/*.sh`, `sim/scripts/*`). Do not change situation text without a plan for regenerating data and retraining.

## Related docs

- [README](README.md) (index of agent docs), [repo-map](repo-map.md), [glossary](glossary.md),
  [playbooks](playbooks.md).
- Runtime: [public-api-and-lifecycle](runtime/public-api-and-lifecycle.md),
  [observe-and-trace](runtime/observe-and-trace.md), [state-and-adapters](runtime/state-and-adapters.md),
  [learn-situation-triage](runtime/learn-situation-triage.md),
  [decide-policy-actions](runtime/decide-policy-actions.md), [model-host](runtime/model-host.md),
  [devtools](runtime/devtools.md), [build-test-release](runtime/build-test-release.md).
- Cross-cutting: [model-io-contract](model-io-contract.md), [status-and-known-issues](status-and-known-issues.md).
- Offline and legacy: [sim](sim.md), [training](training.md), [demos](demos.md),
  [genclass-model-lineage](genclass-model-lineage.md), [extension-and-benchmarks](extension-and-benchmarks.md).
- Human docs (drift documented in status-and-known-issues): [CONTRACT.md](../runtime/CONTRACT.md),
  [API.md](../runtime/API.md), [ARCHITECTURE.md](../runtime/ARCHITECTURE.md),
  [packages/runtime/STATUS.md](../../packages/runtime/STATUS.md), [OPEN_TASKS.md](../../OPEN_TASKS.md).
