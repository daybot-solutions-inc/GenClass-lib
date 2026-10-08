# sim/: the training-data simulator (@genclass/sim)

> **Scope:** `sim/README.md`, `sim/NEEDS.md`, `sim/SEPARABILITY.md`, `sim/package.json`, `sim/tsconfig.json`,
> `sim/tsup.config.ts`, `sim/vitest.config.ts`, `sim/src/**`, `sim/test/**`, `sim/scripts/**` (incl. `cluster/`),
> `sim/samples/**`.
> **Read this when:** you generate or regenerate training data (gold, unlabeled or on-policy rows); change a feature
> combinator, domain, persona, chaos regime, cost weight, label rule (incl. S1/S2), ask question, split or budget;
> debug a dropped trajectory, a `prefix-mismatch`, a wrong diagnosis label or an odd action distribution; or need to
> know exactly what a CONTRACT-D row contains.
> **Source of truth:** the code. Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins.

## TL;DR

- The sim is a private Node package (`@genclass/sim`, ESM, Node 22) that builds **random web-app programs** from
  **46 feature combinators** (15 round-1 + 31 round-2) x **115 domains** (55 + 60), runs them with **simulated users**
  (5 persona kinds) on a **simulated network and server** (8 chaos regimes, offline windows, socket drops, clock
  skew, other tabs) inside a **deterministic virtual event loop**, and drives the **real runtime** (`createRuntime`
  from `@genclass/runtime`, loaded dynamically) through it. Nothing in the runtime knows about the sim.
- The runtime is **situation-v2** (tag `situation-v2` = 6e5e86e): responses and WebSocket messages are decided at the
  network boundary (trigger **`delivery`**: `deliver` / `discard` / `defer`), and `mutation` is non-blocking. The sim
  correlates delivery subjects and labels them from the writes they cause. The sim is unchanged between that tag and
  b435acb; our default-mode change does not affect it (the sim passes `mode: "heal"` explicitly).
- Every time the runtime calls its `DecisionProvider.evaluate`, the sim's recording decider stores the request
  verbatim (`state`, `questions`); those bytes become a training row's model input. The sim never writes situation
  text itself.
- Three row types (`gen.js` mode): **gold** (default; counterfactual action labels), **unlabeled** (`--unlabeled`:
  base run only, every decision point, gold diagnosis, no action label; README: ~150 vs ~4.4 rows/s per worker for gold), **on-policy**
  (`--on-policy <export dir>`: a real model decides through the runtime's production gate; its points are
  counterfactual-labelled, for DAgger).
- Gold labels come from **counterfactual outcomes**: for a sampled decision point *k*, the scenario is re-run once
  per applicable action with that action forced at *k* (and passive afterwards), over **K = 2-3 paired futures**;
  each run is scored by `runCost` against the **ideal run**. **S2** (`sim/src/run/latent.ts`): futures 1-2 also
  re-draw what a runtime cannot observe (later user timing, remaining outage/offline/slow lengths, whether an
  ambiguous failed write committed, remaining time of in-flight requests, accidental-vs-intended repeats), so a label
  is the expected cost given the observable situation. `actionLabel` turns costs into a soft `action` distribution.
- The `diagnosis` label is a hard label from the sim's own knowledge (`diagnose`). **S1**: when a non-passive action
  beats passive by >= 1 (`S1_GAP`) but the subject looks `expected`, the label names what the action repairs
  (`diagnosisFromOutcome`; `meta.diagnosis_s1`). `delivery` diagnoses are the verdict of the first write the
  delivered op/message makes.
- Determinism rests on **keyed RNG forks**, request draws keyed by (seed, request identity, occurrence),
  **content-derived server ids**, and a replay check that every decision up to *k* is byte-identical (`fp`) to the base
  run (a latent re-draw that breaks it falls back to a network-only future: `info:latent-fallback`).
- Splits are per scenario: `test` = 19 held-out domains, a held-out family hash (17%), a held-out pattern, or (new)
  any program using one of 6 held-out round-2 features (`TEST_FEATURES`; `SIM_FEATURE_HOLDOUT=off` disables it);
  `dev` = 3% of remaining families; only 33% of test trajectories are kept (`--test-keep`).
- Output: `<out>/{train,dev,test}.jsonl` + `stats.json` (or resumable `parts/`). Row shape:
  `{id, split, family, state, questions, labels, meta}` (CONTRACT-D). Large runs go through the Azure cluster
  scripts (`sim/scripts/cluster/`), dedupe + gz shards via `collect.py`.
- **Data on disk is mostly situation-v1.** Phase A (600,676 rows) and phase B (1,415,344 rows) were generated on the
  situation-v1 runtime and 15 features; they do not match the v2 runtime. Per [HANDOFF.md](../../HANDOFF.md)/training/NEEDS the v2 runs
  (>= 10M gold + >= 50M unlabeled, seeds 11e9 / 16e9 + NN x 1e8) are being generated on Azure into
  `train:/data/sim-out/v2-*` by the colleague; nobody on our side touches Azure.
- **Where to run.** Light local checks are fine on this machine: `cd sim && npx tsc -p tsconfig.json --noEmit` and
  `SIM_RUNTIME=real npx vitest run` (both were run when these docs were written, on 2026-10-08: tsc clean, 19 tests passed in 5 files; needs
  the runtime built first). **Ask the user** before `gen.js`, `smoke.js`, anything in `sim/scripts/` (incl. the cluster
  scripts and separability analysis) and anything touching Azure
  ([where to run things](runtime/build-test-release.md#where-to-run-things)).
- Any change to the runtime's situation text (`packages/runtime/src/situation/*`) invalidates all data: rebuild the
  runtime, regenerate everything. Any change to scenario generation changes every seed's world.
- Vitest suites default to a crude **fake runtime** (`createFakeRuntime`, no `delivery` trigger); set
  `SIM_RUNTIME=real` to test against the real one. `gen.js` uses the real runtime unless `--allow-fake`.

## Files

| path | role | key exports / entry points |
|---|---|---|
| `sim/package.json` | private package `@genclass/sim` v0.0.0, `bin: genclass-sim -> dist/gen.js` | scripts `build` (`tsup && npm run build:model-host`), `typecheck`, `test` (vitest run), `gen`, `sample`, `build:runtime-core` (runtime `src/index.ts` only), `build:model-host` (runtime `src/model/host.ts` -> `sim/dist/model-host/`); dep `@genclass/runtime: "*"` |
| `sim/tsup.config.ts` | ESM bundle, target node22, `@genclass/runtime` external | entries `gen`, `worker`, `index`, `smoke` -> `dist/{gen,worker,index,smoke}.js` |
| `sim/tsconfig.json` | extends `../tsconfig.base.json`, `noEmit`, includes `src`, `test` | - |
| `sim/vitest.config.ts` | node env, `pool: "forks"`, test/hook timeout 120000 ms | - |
| `sim/src/index.ts` | library re-exports | `buildScenario`, `splitOf`, `runScenario`, `generateTrajectory`, `actionLabel`, `runCost`, `COST_WEIGHTS` (= `W`), `LABEL_PARAMS` (= `LABEL`), `transformQuestions`, `ACTION_PARA`, `createFakeRuntime`, `VirtualLoop` |
| `sim/src/types.ts` | structural mirror of the runtime model seam + row types | `JevState`, `Question`, `Answer` types, `TriggerKind` (now incl. `delivery`), `EvaluateRequest`, `DecisionProvider`, `Clock`, `PASSIVE` (`delivery: "deliver"` added), `DIAGNOSES`, `Row`, `Label` |
| `sim/src/rng.ts` | seeded PRNG (sfc32, splitmix32 init, 12 warm-up draws) with keyed forks | `hash32`, `hashAll`, `Rng` (`fork`, `next`, `int`, `float`, `bool`, `pick`, `weighted`, `weightedKey`, `normal`, `lognormal`, `shuffle`, `sample`, `token`), `u01` (used by round-2 servers), `keyedLognormal` (unused) |
| `sim/src/loop.ts` | virtual event loop | `VirtualLoop` (`schedule`, `at`, `cancel`, `afterTask`, `clockFor`, `settle`, `runUntil`, `hold` (real async work, e.g. model inference, finishes before virtual time moves), `advance` (long task: jumps virtual time), ...), `TaskOwner`, `LoopError` |
| `sim/src/net/server.ts` | virtual server: DB + routed endpoints + idempotency keys | `Db`, `VirtualServer`, `API_STYLES`, `canonical`, `clone`, `ServerSnapshot`, `RouteMeta`, ... |
| `sim/src/net/network.ts` | virtual network: latency, chaos, offline windows, push channel, `fetch`, S2 latent re-draws | `Network` (fields `future`, `latent`), `NetProfile` (+ `offline`, `socketDrops`), `IDEAL_PROFILE`, `BASE_URL`, `NetEntry`, `NetCause` (+ `offline`), `Win`, `Outage`, `SlowPeriod`, `ServerBug`, `Lat`, `SIM_OP_HEADER`, `simOpHeaderValue`, `parseSimOpHeader`, `makeResponse` |
| `sim/src/app/vocab.ts` | 55 round-1 domain vocabularies; the `D`/`E` builders are now exported | `DOMAINS` (55 only), `D`, `E`, `Domain`, `Entity`, `ROUTE_WORDS` (unused) |
| `sim/src/app/vocab2.ts` | 60 round-2 domains | `DOMAINS2` |
| `sim/src/app/naming.ts` | per-program naming | `Naming`, `Casing`, `cased`, `camel`, `title`, `splitWords` |
| `sim/src/app/feature.ts` | feature contract, user model, personas, relations | `FeatureDef` (+ optional `env()`), `FeatureCtx` (+ `clean`), `WorldCtx` (+ `otherTab`), `UserStep`, `Relation`, `rel`, `Persona` (+ `kind`, `keyboard`, `tabSwitchPerMin`), `randomPersona`, `UserModel` |
| `sim/src/app/env.ts` | what app programs see | `AppEnv` (`fetch`, `store`, `socket`, `subscribe`, `setRoute`, `uncaught`, `snapshot`, timers, `clientNow` (skewed clock, `EPOCH` = 2026-10-07 14:00 UTC), `busy` (long task), `on` (global events), `online`, `channel` (BroadcastChannel)), `PlainBackend`, `SimGlobal` (+ EventTarget methods, `navigator`, `localStorage`, `document.visibilityState`), `pushIds`, `pushIdsByData` |
| `sim/src/app/kit.ts` | feature building blocks | `Kit` (`op`, `call`, `write`, `shownError`, `spawn`), `OpInit` (now has `anomaly`), `HttpError`, `errorFor` |
| `sim/src/app/features/index.ts` | registry and frequency weights | `FEATURES` (46), `FEATURE_WEIGHTS` |
| `sim/src/app/features/common.ts` | shared helpers | `ContentBook`, `idsKey`, `seedItems`, `weightsOf`, `queryWords`, `errMsg`, `apiOf` |
| `sim/src/app/features/{search,editor,form,cart,toggle,counter,poll,board,chat,settings,nav,list,bulk,auth,benign}.ts` | round-1 combinators (unchanged since 654d822) | one `FeatureDef` each |
| `sim/src/app/features/{infinite,upload,offline,wsreconnect,undo,reorder,querycache,graphql,saga,wizard,etag,presence,badge,facets,masterdetail,clockskew,longtask,cascade,exportjob,payment,inventory,prefetch,multitab,ratelimit,cdn,swcache,countdown,money,permissions,flags,schemadrift}.ts` | round-2 combinators | one `FeatureDef` each (see [Round-2 combinators](#round-2-combinators)) |
| `sim/src/world/scenario.ts` | seed -> scenario; splits; chaos regimes; clean runs | `buildScenario`, `BuildOptions` (`kinds`, `clean`, `chaos`, `duration`, `domain`), `Scenario` (+ `skewMs`, `windowEvents`, `clean`), `DOMAINS` (115 = `vocab.ts` + `vocab2.ts`), `splitOf`, `TEST_DOMAINS`, `TEST_PATTERNS`, `TEST_FEATURES`, `familyHeldOut`, `Chaos` |
| `sim/src/run/rt.ts` | runtime slice; `createRuntime` options; loader | `RuntimeLike`, `RuntimeOptions` (+ `production`), `createOptions`, `realRuntimeFactory` |
| `sim/src/run/runner.ts` | runs one scenario (ideal or real): recording decider, on-policy decider, correlation (incl. delivery), platform (storage, BroadcastChannel, offline, tab switches, socket drops) | `runScenario`, `RunOptions` (+ `onPolicy`, `future: FutureSpec`), `RunResult` (+ `firedSteps`), `DecisionRec` (+ `modelProbs`, `modelChoice`, `modelDiagnosis`, `ran`, `feature`, `diagFrom`, `probe`), `AskRec`, `ExplorePolicy` |
| `sim/src/run/latent.ts` | **S2**: futures re-draw unobservable latents | `FutureSpec`, `S2` (env `SIM_S2`), `futureProfile`, `futureStepTimes`, `REPEAT_PRIOR`, `repeatPrior`, `repeatOfIndex`, `idealRepeatSkips` |
| `sim/src/run/onpolicy.ts` | on-policy decider: the runtime's own model host in Node on onnxruntime-web WASM | `loadModelDecider(modelDir)` |
| `sim/src/run/fake-runtime.ts` | **test double** of the runtime (crude text, no `delivery`); rows marked `meta.runtime: "fake"` | `createFakeRuntime` |
| `sim/src/run/transform.ts` | per-row action-option shuffle/drop; action paraphrases | `transformQuestions`, `ACTION_PARA` |
| `sim/src/oracle/knowledge.ts` | ground truth bookkeeping | `Knowledge` (+ `onWrite`, `probe`, `currentPush`, `deliveringPush`, `rtPushOps`, `nextPush`), `SimOp`, `SimWrite` (+ `diag`, `push`), `sigOf` |
| `sim/src/oracle/diagnose.ts` | diagnosis labels | `diagnose` (+ `delivery` -> `undefined`, filled after the run), `diagnoseFailure` (+ `offline` -> failing), `Subject` (+ kind `push`) |
| `sim/src/oracle/cost.ts` | divergence, run cost, soft labels | `W`, `LABEL`, `TIER` (incl. `deliver` passive), `runCost`, `actionLabel`, `clientDist`, `serverDist`, `clientDivergenceAt`, `divergedFieldsAt` |
| `sim/src/oracle/probe.ts` | separability probes (analysis only, `SIM_PROBE=1`) | `PROBE`, `Probe`, `ProbeState`, `cellDiff`, `probeDecision`, `probeAfter` |
| `sim/src/ask/questions.ts` | programmatic `ask` questions with exact answers | `askQuestions`, `AskQ`; 11 generators |
| `sim/src/gen/trajectory.ts` | one trajectory -> rows (gold / unlabeled / on-policy) | `generateTrajectory`, `pointCosts`, `diagnosisFromOutcome`, `S1_GAP`, `metaOf`, `GenOptions` (+ `mode`, `model`, `maxUnlabeled`), `costMs`/`resetCostMs` (profiling), `latentFallbacks` |
| `sim/src/gen/worker.ts` | `worker_threads` worker | loads `loadModelDecider` once in on-policy mode |
| `sim/src/gen.ts` | CLI: worker pool, shard merge, `stats.json`, `--sample`, parts mode, row modes | no exports; internal `parse`, `main`, `mergeParts` (entry point `dist/gen.js`) |
| `sim/src/gen/examples.ts` | `EXAMPLES.md` renderer | `renderExamples` |
| `sim/src/dev/smoke.ts` | dev tool | `dist/smoke.js [--seeds 40] [--from 1] [--fake] [--show <trigger\|all\|ask>] [--cf]`; `--cf` now runs `generateTrajectory` (maxPoints 6) on all `--seeds` and prints the slowest seeds and `runCost` time; `--profile [--per 4]` (ms/tasks/decisions per feature kind); `--repeat-prior N` (measures `REPEAT_PRIOR` on the fake runtime) |
| `sim/scripts/final.sh` | situation-v1 final datasets | `final.sh a \| b \| merge-b` |
| `sim/scripts/analyze.py` | dataset summary (merged files or `parts/`); now also per subject feature and unlabeled diagnosis counts | `python3 sim/scripts/analyze.py <dir>` |
| `sim/scripts/relabel.py` | re-derive gold action labels from `meta.cost_futures` (mirror of `actionLabel`) | `relabel.py IN OUT [--tau0 --se-mul --guard --heal --tie-eps --tie-penalty]` |
| `sim/scripts/separability*.py` | separability analysis (stage 1 rows; stage 2 probes; extra tables; GBDT check) | see `sim/SEPARABILITY.md` §9 |
| `sim/scripts/cluster/{bundle.sh,node_start.sh,orchestrate.sh,bigrun.sh,collect.py}` | distributed generation on Azure F80 nodes | see [flow 9](#9-cluster-runs-simscriptscluster) |
| `sim/test/*.ts` | vitest suites (19 tests in 5 files) | see [Tests](#tests) |
| `sim/samples/` | `sample.jsonl` (200 rows), `EXAMPLES.md` (16 rows), `sample-stats.json` (regenerated on a `delivery`-era runtime), `stats-final-a.json` (phase A, v1) | - |
| `sim/NEEDS.md` | SIM -> CORE requests | see [Drift](#drift-and-open-issues) |
| `sim/SEPARABILITY.md` | why R17 recalls few clear cases; the S1/S2/T1/F1-F9 proposals; first v2 check | - |

## Concepts and data structures

| term | meaning (code) |
|---|---|
| **scenario** | `Scenario` (`sim/src/world/scenario.ts`): one program (domain, 1-3 features + optional `benign`, naming, API envelope style, `idStyle`), one user session (`steps`, `persona`, `windowEvents`), one network profile (`net`, `chaos`), `external` events, timing (`warmup`, `tUser`, `tEnd`), `askTimes`, vocabulary overrides, `modelMs`, `budget`, `skewMs`, `clean`. Fully determined by `seed`. |
| **trajectory** | one scenario processed by `generateTrajectory`. Gold: 1 ideal run + 1 base run + counterfactual runs (+ re-seeded ideal runs). Unlabeled: 1 base run. Rows of a trajectory share one split. |
| **row mode** | `GenOptions.mode` / `gen.js` flag: `gold` (default), `unlabeled` (`--unlabeled`), `onpolicy` (`--on-policy <dir>`). |
| **feature / combinator** | `FeatureDef<S>`: `make(ctx) -> spec`, `pattern(spec)`, `server`, `client`, `session`, optional `external`, `relations`, and (new) `env(spec, rng, win)` returning `offline` windows, `socketDrops` windows and `skewMs` merged into the scenario. |
| **clean run** | `Scenario.clean` (5%, `R.fork("clean")`): chaos forced `calm`; spikes, transients, network errors, outages, slow periods, bugs, rate limits, capacity and replica lag removed; no feature `env()` conditions; persona `doubleClickP = impatientP = 0`; `FeatureCtx.clean` makes round-2 features pick correct guards. `meta.clean: true`; any non-passive answer there is a false positive. |
| **persona** | `Persona.kind` weighted casual 5, power 2, mobile 2, keyboard 1, novice 1 (`randomPersona`); kinds override typing/think/double-click/impatience/typo/tab-switch ranges. Keyboard personas activate controls with `key` steps (`Enter` p 0.8, else `Space`). `meta.persona`. |
| **chaos regime** | `"calm" \| "normal" \| "flaky" \| "degraded" \| "storm" \| "mobile" \| "peak" \| "deploy"`. `mobile`/`peak`/`deploy` start from the flaky/degraded/normal base profile and add their own conditions (`makeNet`). |
| **delivery** | situation-v2 trigger: a fetch response or WebSocket message about to reach the app; passive `deliver`, guard `discard` / `defer`. Subject = the runtime's fetch op or WebSocket *message* op. |
| **push id** | `Knowledge.nextPush`: every message the virtual socket dispatches gets an id (`pushIds` by event, `pushIdsByData` by payload); `know.deliveringPush` is ambient during dispatch so `opCreated` maps the runtime's `ws` message op -> push id (`know.rtPushOps`), and `know.currentPush` tags the writes the app handler makes (`SimWrite.push`). |
| **write verdict** | `SimWrite.diag`: every write is diagnosed with the `mutation` rules at proposal time (`know.onWrite` in `runScenario`). Used for `delivery` diagnoses and S1 rule a. |
| **pattern / family / intent / sim op / sim write / classify / relation** | as before: pattern tags `<kind>/<tag>`; family = sorted unique kinds joined by `+` (row `family` = `<program family>/<trigger>`); `Intent` with `key`, `mode`, `accidental`, `repeatOf`; `SimOp` with `role`, `intent`, `key`, `idempotent`, `dupOf`, `anomaly` (now really set: `Kit.op` copies it), `rtOp`, `net`; `SimWrite` with `fields`, `anomaly`, `rtMutation`; `classify()` closures; `Relation {fields, desc, check}`. |
| **ideal run** | `runScenario(scn, {ideal: true})`: no runtime, `IDEAL_PROFILE` (0 latency, no failures, no offline/socket drops), no clock skew, accidental and conditional steps skipped (in an S2 future: per `idealRepeatSkips`), app duplicates share the original result. |
| **base run** | gold/unlabeled: real runtime, recording decider, exploration, ask probes; on-policy: the model decides through the production gate, no exploration, no ask probes. |
| **counterfactual (cf) run** | real runtime, `forced` map (explored/ran choices before *k*, action *a* at *k*, passive after), `fpUpTo: k`, `tStop: t_k + 15000`, optional `future`. |
| **decision point** | `DecisionRec` (`k`, `t`, `trigger`, `state`, `questions`, `actions`, `chosen`, `explored`, `diagnosis`, `subject {kind, how, ref}`, `feature` (subject's feature kind), `diagFrom` (delivery), `fakeDiagnosis`, `fp`; on-policy: `modelProbs`, `modelChoice`, `modelDiagnosis`, `ran`; probe: `probe`). |
| **fp** | `JSON.stringify([trigger, state, questions])`; cf runs must reproduce `fp` for every decision `<= k` or the point is dropped (`prefix-mismatch`). |
| **future** | `RunOptions.future: FutureSpec = {k, salt, t, noLatent?, fired?}`. Future 0 = no salt. Futures 1..K-1 re-seed network/push/model-latency draws after the decision and external-event timing (+U(0,600) ms) with a salt shared by all actions, and with S2 on (default) also the latents below. |
| **S2 latents** | `futureProfile` (outage/slow/bug/offline/socket-drop windows: a running window's remaining length x lognormal(1, 0.7), min 200 ms; a later window's start offset x lognormal(1, 0.5), same length), `futureStepTimes` (steps after *t*: tempo lognormal(1, 0.15) x per-gap lognormal(1, 0.2), order kept), `Network.latent` (in-flight responses arriving after *t*: remaining time x lognormal(1, 0.5); server-side draws of requests arriving after *t*; whether an ambiguous failed write committed: 500 on a write with posterior `pc/(pc + (1-pc)/3)`, network error after processing 0.5), `idealRepeatSkips` (repeats before *t* within 3 s: accidental with `REPEAT_PRIOR(gap)`; only the ideal run changes). |
| **latent fallback** | a re-seeded future whose latent re-draw changed an observed prefix is re-run with `noLatent: true` (network/timing only); counted as drop key `info:latent-fallback`. |
| **S1** | `diagnosisFromOutcome`: rules a-e (see [flow 5](#5-cost-labels-and-s1-simsrcoraclecostts-simsrcgentrajectoryts)). |
| **subject correlation** | `Subject.kind` in `write`, `op`, `error`, `invariant`, `chain`, `push`, `unknown`; `DecisionRec.subject.how` in `subject`, `sync`, `chain`, `delivered`, `last`, `text`, `push`, `none`. |
| **D(t)** | weighted client divergence of the real run's stores from the ideal run's at the same time (`clientDist`). |
| **tier** | `TIER`: passive (`apply send deliver wait ignore`), guard (`discard defer coalesce delay`), heal (`block serve_cached retry hedge rollback resync`). |
| **diagnosis-only row** | a decision with < 2 applicable actions; only a `diagnosis` label; <= 3 per gold trajectory. |
| **ask row / ask probe** | at `scn.askTimes` the base run calls `runtime.situation("ask")` and records `AskFacts`; `askQuestions` attaches 1-3 questions with exact labels. |
| **budget** | `situation.budget`: 3200 / 2000 / 1000 characters (compact questions at <= 1400). `meta.budget`. |
| **passive** | `PASSIVE`: mutation `apply`, request `send`, delivery `deliver`, failure `deliver`, stall `wait`, inconsistency/transition/error `ignore`. Now also in `meta.passive` on decision, diagnosis-only and unlabeled rows. |
| **user model** | `UserModel`: `think`, `key`, `type` (typo with p typoP/6 per non-space char), `click` (accidental double click U(45,190) ms later with p `doubleClickP`, forced 0 when the persona's `doubleClickP` is 0; impatient re-clicks guarded by `when: pendingCond`). The runner adds `act.clicks` (browser click count: consecutive clicks on the same target within 500 ms) to `runtime.user`. |
| **tab switches** | `Scenario.windowEvents`: `round(tabSwitchPerMin x tUser/60000 x U(0.5,1.5))` blur/focus pairs at U(warmup x 0.5, tUser - 1000), focus 0.5-20 s later; dispatched as `visibilitychange` + `blur`/`focus` on the global (owner `sim`). |
| **transform variant** | `meta.transform`: `default`, `shuffle`, `drop:<action>`, or `drop:<action>,shuffle`. |
| **NetCause** | `offline ok transient outage overload ratelimit spike slow-period gateway-timeout bug replica-lag neterr aborted notfound`; `slowCause` `spike \| slow-period \| overload`. |

Row (`sim/src/types.ts` -> `Row`, CONTRACT-D):

```ts
interface Row { id: string; split: "train"|"dev"|"test"; family: string; state: JevState;
  questions: Record<string, Question>; labels: Record<string, Label>; meta: Record<string, unknown> }
type Label = {type:"choice"; label:string} | {type:"choice"; dist:Record<string,number>}
           | {type:"noul"; p:number} | {type:"score"; level:number} | {type:"score"; dist:number[]};
```

| row kind | `id` | `labels` | `meta` fields (beyond `meta0`) |
|---|---|---|---|
| gold decision | `sim-<seed>-d<k>` | `action: {type:"choice", dist}` (after transform), `diagnosis: {type:"choice", label}` when correlated and in the offered vocabulary | `trigger`, `passive`, `subject_feature`, `decision`, `t`, `explored_before`, `best`, `passive_best`, `costs`, `cost_futures`, `futures`, `adjusted`, `se`, `non_passive_mass`, `cost_parts`, `tiers`, `diagnosis` (or null), S1 only: `diagnosis_s1` (`a-write \| b-repeat \| c-twin \| d-diverged \| e-other`) + `diagnosis_subject`, `subject`, `transform`, optional `fake_diagnosis`, optional `probe` (`SIM_PROBE=1`) |
| on-policy decision | `p-<seed>-d<k>` | as gold | gold fields + `on_policy: true`, `model_probs`, `model_choice`, `model_diagnosis`, `ran`, `false_intervention` (ran non-passive and passive best), `miss` (ran passive, passive not best, non-passive mass >= 0.9) |
| diagnosis-only | `sim-<seed>-s<k>` (prefix `sim-` in on-policy runs too) | `diagnosis` | `trigger`, `passive`, `subject_feature`, `decision`, `t`, `diagnosis`, `diagnosis_only: true`, `subject` |
| unlabeled decision | `u-<seed>-d<k>` | `diagnosis` only when correlated and in vocabulary, else `{}` | `unlabeled: true`, `trigger`, `passive`, `subject_feature`, `decision`, `t`, `diagnosis`, `actions`, `ran` (= chosen), `explored`, `subject`, `transform` |
| ask | `sim-<seed>-a<i>` / `u-<seed>-a<i>` | `q_*` per question | `trigger: "ask"`, `t`, `kinds` (+ `unlabeled: true` in unlabeled mode) |

`meta0` (every row, `metaOf`): `seed`, `domain`, `family` and `program_family` (both the program family), `chaos`,
`clean`, `persona` (kind), `budget`, `runtime` (`"real"` or `"fake"`), `features` (kinds), `patterns`. Situation
`state` sections are produced by the runtime ([runtime/learn-situation-triage.md](runtime/learn-situation-triage.md)).

Random streams (every one is a keyed `Rng`; changing a key or the order of draws *within* one stream changes data):

| stream | key | used for |
|---|---|---|
| scenario root `R` | `Rng(hashAll("scenario-v1", seed))` | forks `domain`, `program` (-> `naming`, `api`, `ids`, `kinds`, `feature,i,kind` -> `make`), `clean`, `timing`, `persona`, `mobile-net`, `chaos`, `net`, `feature-env,i`, `session,i`, `external,i`, `window`, `ask`, `vocab`, `action-vocab`, `model`, `budget` (`buildScenario`) |
| trajectory `R` | `Rng(hashAll("traj", seed))` | forks `testkeep`, `explore`, `points`, `transform,k`, `single`, `ask,i`, `unl` (`generateTrajectory`) |
| server ids | `hashAll("db-<seed>", collection, createKey, n, salt)` | `Db.makeId` |
| network | `hashAll(hashAll("net", seed), [salt,] identity, occurrence)`; push `(.., "push", topic, n)`; replica lag `(.., "lag", identity, occurrence)` | `Network.send`, `publish`, `process` |
| S2 network | `hashAll("late", salt, identity, occ)`, `hashAll("latent-commit", salt, identity, occ)`, `hashAll(netSeed, salt, identity, occ, "arrive")` | `Network.late`, `latentCommit`, arrival draws after *t* |
| S2 windows / steps / intent | `hashAll("future-windows", salt)`, `hashAll("future-steps", salt)`, `hashAll("future-gap", salt, i)`, `hashAll("future-intent", salt, i)` | `latent.ts` |
| app | `Rng(hashAll("app", seed))` = `env.rng` | run-time draws inside feature code |
| exploration | `Rng(hashAll("explore", seed)).fork(k)` | per-decision explore draw |
| model latency | `hashAll("model-latency", seed, idx[, salt])` | decider delay `lognormal(modelMs, 0.35)` (also delays the on-policy answer) |
| external jitter | `hashAll("ext-jitter", salt, i)` | +U(0,600) ms for external events after `future.t` |
| futures | `hashAll("future", seed, k, j)` | salt of future *j* at point *k* |

## How it works

### 1. CLI and workers (`sim/src/gen.ts`, `sim/src/gen/worker.ts`)

1. `gen.ts` -> `parse` reads flags (table in [Configuration](#configuration-and-constants)); unknown flags throw.
   `--unlabeled` sets `mode: "unlabeled"`; `--on-policy <dir>` sets `mode: "onpolicy"` and `modelDir`.
2. Deletes `<out>/shards` (in every mode), spawns `--workers` `Worker(dist/worker.js)` with `workerData {id, out,
   fake, maxPoints, askRows, testKeep (1 with --sample), exploreScale, mode, modelDir}`. Non-parts mode feeds each
   idle worker 2 consecutive seeds from `--seed` upward (parts mode: one whole part of `--chunk` seeds) until
   `produced >= target`, then `{stop: true}` (slight overshoot).
3. Worker: loads the factory once (`realRuntimeFactory()`, or `createFakeRuntime` with `--allow-fake`); in on-policy
   mode also `loadModelDecider(modelDir)` once. Per seed `generateTrajectory(seed, opts)`; rows to
   `shards/<split>.w<id>.jsonl`; messages `ready`, `idle`, `traj`, `error`, `fatal`, `part-done`.
4. When all workers exit: shards concatenated per split into `<out>/{train,dev,test}.jsonl`, `stats.json` written.
5. Parts mode (`--parts`): part *i* = seeds `[seed + i*chunk, seed + (i+1)*chunk)`, `.tmp` until complete, then a
   `part-NNNNNN.json` marker; restart skips finished parts. Writes `stats.session.json`. `--merge-only` concatenates.
   All cluster runs use parts mode.
6. `--sample`: output to `sim/out/sample-tmp`, then `sim/samples/{sample.jsonl (200 rows), EXAMPLES.md,
   sample-stats.json}`.

Output files and `stats.json` keys are as in round 1 (`args` now includes `mode` and `modelDir`; `drops` includes
`info:latent-fallback`). Label statistics count only counterfactual-labelled decision points (`PointStat`: gold and
on-policy); unlabeled trajectories contribute rows and drops but no points.

### 2. One trajectory (`sim/src/gen/trajectory.ts` -> `generateTrajectory`)

1. `buildScenario(seed)`; `split = splitOf(scn)`; `R = Rng(hashAll("traj", seed))`; test subsample by `--test-keep`.
2. **Unlabeled mode** (`unlabeledTrajectory`): one base run with exploration x 1.5 and ask probes always on (ignores
   `--no-ask`); every decision becomes a row (at most `maxUnlabeled` = 40, sampled with `R.fork("unl")`), including
   decisions with < 2 actions; questions transformed (`transformQuestions` with no dist); ask rows as in gold. Done.
3. Ideal run (`ideal: true, serverTimeline: true`). Internal errors -> drop `ideal-internal-error`.
4. Base run: gold = exploration (`eps = weighted([[0,4],[0.08,3],[0.2,2]]) x exploreScale`; per decision `eps` when
   the sim's diagnosis is set and not `expected`, `eps/2` for `delivery` (its diagnosis is only known after the run),
   else `eps/4`) + ask probes (unless `--no-ask`); on-policy = `onPolicy: {model}`, no exploration, no ask probes.
5. Points: gold `pickPoints` (>= 2 actions and `k < DENSE_K` = 600; all candidates when there are at most
   `--max-points`, else weighted with `TRIGGER_W` mutation 1, delivery 1.2, request 1, failure 1.6, stall 2.2,
   inconsistency 3, transition 3, error 2.2, x 1.5 non-`expected`); on-policy `pickOnPolicy` (>= 2 actions, no
   `DENSE_K` cap; weight 4 if the gate ran a non-passive action, 3 if the model chose one, 2 if the sim sees a
   problem, else 1).
6. For each point: `pointCosts` (flow 4) -> `actionLabel` -> `transformQuestions` -> S1 check -> labels; the
   `diagnosis` label only if in the offered criteria and `subject.kind !== "unknown"` (else drop counters
   `diagnosis-not-in-vocab` / `diagnosis-uncorrelated`).
7. Diagnosis-only rows (< 2 actions, a diagnosis, a known subject; <= 3 via `R.fork("single")`).
8. Ask rows (gold only, unless `--no-ask`; never in on-policy mode).

### 3. One run (`sim/src/run/runner.ts` -> `runScenario`)

1. New `VirtualLoop`, `Db`, `VirtualServer`; features register routes and relations.
2. `Network(loop, server, ideal ? IDEAL_PROFILE : futureProfile(scn.net, future), hashAll("net", seed))`; with a
   re-seeded future and S2 on, `network.latent = {salt, t}`.
3. `makeGlobal`: `fetch`, timers (owner `app`), `location`, `document {title, visibilityState, hidden}`, a global
   `EventTarget` (`addEventListener`/`dispatchEvent`), `navigator {onLine, userAgent}`, `localStorage`
   (`MemStorage`), `WebSocket` (`makeWebSocketClass`: connect delay `40 + (topic.length % 7) * 10` ms; during a
   `socketDrops` window connections fail with `error` + `close` code 1006 and an open socket is closed at the window
   start; each dispatched message gets a push id), and `BroadcastChannel` (`makeBroadcast`: messages from "other
   tabs" arrive 1 ms later; this tab's own posts reach no one).
4. `Knowledge` with `know.onWrite` = diagnose every write with the `mutation` rules (`SimWrite.diag`); probe state if
   `SIM_PROBE=1` on a recorded real run.
5. Real runs: `createRuntime(createOptions(...))` (`production: true` for on-policy) with the decider, hooks
   `opCreated` (also maps `ws` message ops to `know.deliveringPush`) and `mutationProposed`. On-policy also listens to
   `rt.on("decide")` to record what the gate actually ran (`rec.ran`, and sets `rec.chosen`/`rec.explored` so
   replays force it).
6. `AppEnv` (+ `skewMs` from the scenario, 0 in the ideal run; `blocker` = `loop.advance`), `WorldCtx` (+ `otherTab`
   `setItem`/`removeItem` (dispatch a `storage` event) and `broadcast`).
7. Schedules: offline windows flip `navigator.onLine` and dispatch `offline`/`online` (real runs, owner `sim`); tab
   switches; `init()`; user steps at `futureStepTimes(...)` (ideal runs skip per `idealRepeatSkips` or the default
   accidental/conditional rule; fired conditional steps recorded in `firedSteps`); external events; ask probes.
8. `loop.settle()`, `loop.runUntil(min(tEnd, tStop))`; then delivery decisions get `diagnosis` = `diag` of the first
   write whose `op` (fetch delivery) or `push` (message delivery) matches, else the decision's own diagnosis, else
   `expected`; probes are completed; collect `RunResult`.

### 4. Counterfactuals (`sim/src/gen/trajectory.ts` -> `pointCosts`)

1. `forcedPrefix` = `{d.k: d.chosen}` for explored (or, on-policy, gate-ran non-passive) decisions before *k*.
2. For future `j = 0..K-1` (K = 3): with `adaptive` (default) and S2 on, future 1 always runs; future `j >= 2` runs
   only if some non-passive action beat passive by > 0.05 in a future seen so far. (S2 off: stop after future 0
   unless a gain > 0.05 there.)
3. Future `j >= 1`: `salt = hashAll("future", seed, k, j)`; the ideal run is re-run with that salt
   (`future.k = -1`, `fired` = base conditional steps that fired at or before *t*) whenever an external event lies
   after `t_k`, or S2 is on and this is not a `noLatent` fallback.
4. Per action: `runScenario(scn, {forced, fpUpTo: k, tStop: t_k + 15000, future})`; exception -> `cf-exception`;
   internal error -> `cf-internal-error`; prefix differs -> `prefix-mismatch`, except for a re-seeded future with S2
   on, which is retried once with `noLatent: true` (counted `info:latent-fallback`).
5. `runCost(...).total` (4 dp) per action per future; `cost_parts` and results from future 0.

### 5. Cost, labels and S1 (`sim/src/oracle/cost.ts`, `sim/src/gen/trajectory.ts`)

1. Cost: unchanged from round 1. `total = 1.0*area + 4.0*finalClient + finalServer + 1.5*shownErrors + 1.0*uncaught
   + 0.08*wasted + 0.25*latencyS + 0.8*relationArea + 2.0*relationFinal` over `[t_k, min(tEnd, t_k + 15000,
   tStop)]`, area/relation area over the 10 s horizon; `serverDist` caps (5 extra/missing + 5 changed items per
   collection, 3 fields per doc, 3 units per counter, `*beats` counters ignored).
2. `actionLabel`: tier premium (passive 0, guard 0.25, heal 0.5); non-passive within `tieEps` 0.05 of passive ->
   passive's costs + 1.5; `best` = argmin mean adjusted; `p_a ∝ exp(-gap_a / (0.10 + 1.0 x SE_a))`.
3. **S1** (`S1_GAP = 1.0`): if the diagnosis is undefined or `expected`, the subject is known, passive is not best and
   passive's adjusted gap >= 1, then `diagnosisFromOutcome(base, ideal, p, best)`:
   a) fields already wrong at *t* vs the ideal run (`divergedFieldsAt`, incl. first fields of violated relations):
   the `diag` of the latest non-`expected` last write to such a field (`a-write`);
   b) the subject's intent is accidental / a repeat, or the op has `dupOf` -> `duplicate` (`b-repeat`);
   c) request trigger, best `coalesce`/`block`, and an identical op (method, url, body) started earlier and still in
   flight or ended within 10 s -> `duplicate` (`c-twin`);
   d) fields diverged with no named cause -> `inconsistent` (inconsistency/transition) or `stale` (`d-diverged`);
   e) otherwise `unusual` (`e-other`).
   `rows.test.ts` asserts no gold `expected` row has passive's adjusted gap >= 1.

### 6. A request through the world (correlation)

Unchanged from round 1 except: `Kit.op` now copies `anomaly`; offline windows make `Network.send` fail at once
(`cause: "offline"`, `TypeError("Failed to fetch")` after U(2,12) ms, no server processing); S2 re-draws in
re-seeded futures (`late`, `latentCommit`, arrival rng `r2`). Flow: `kit.op` -> `Knowledge.beginOp`; `Kit.callNet`
adds `x-request-id: req-<hash>-<opId base36>` and calls `AppEnv.fetch`, which sets `know.callingOp` around the
runtime-instrumented global fetch;
`opCreated` maps runtime op -> sim op; `Network.fetch` strips the header, draws latency keyed by identity and
occurrence, then outage -> capacity -> rate limit -> transient (500 on a write may commit first) -> network error
(50% commit) -> processing (bugs, replica lag) -> gateway 504; `Kit` classifies `ok/http-error/neterr/aborted/
timeout/parse-error` and updates the per-signature failure `streak`.

### 7. A decision (recording decider in `runScenario`)

1. `evaluate(req)`: `idx = k++`; `correlate(req)`. New for `delivery`: `subject.op` -> sim op via `know.rtOps` (or
   causal parents) -> `{kind: "op", how: "subject"}`; else `know.rtPushOps` -> `{kind: "push", how: "push", ref:
   pushId}`; else unknown. `diagFrom` = `{op}` or `{push}`.
2. `diagnose(...)` (`delivery` returns `undefined`; filled after the run).
3. Choice: forced -> exploration -> passive; answers: action = probability 1 on the chosen action; diagnosis = the
   sim's label (or `expected`), replaced by `unusual` (or another non-`expected` key) with `fakeDiagnosis` when a
   non-passive action is chosen on `expected`. A `delivery` diagnosis is always undefined at decision time, so every
   forced or explored non-passive delivery answer is fake-diagnosed (`fakeDiagnosis`, `meta.fake_diagnosis`).
4. On-policy: the model's `evaluate` promise is registered with `loop.hold` (real inference time is held out of
   virtual time); its `action` probabilities/choice and `diagnosis` choice are recorded, and the answer is released
   after the scenario's virtual model latency.
5. Runtime policy (`createOptions`): `mode: "heal"`, thresholds guard/heal 0.5, `requireDiagnosis: false` -> exactly
   the forced action runs. On-policy (`production`): `policy = {holdBudgetMs: 1e9, maxActionsPerMinute: 1e9}` only,
   i.e. the runtime's default thresholds and diagnosis gate.

Error paths into the `error` trigger are unchanged (`Kit.spawn` tags; `handler-threw`; `env.uncaught` ->
`runtime.reportError`).

### 8. Diagnosis rules (`sim/src/oracle/diagnose.ts` -> `diagnose`, first match wins)

| trigger | rules |
|---|---|
| mutation | `write.classify()`; `anomaly === "partial"` -> inconsistent; `shape`/`empty`, server bug, or outage-emptied data with status < 400 -> unusual; op `dupOf` or accidental intent -> duplicate; replica lag -> stale; data role (`DATA_ROLES`) of a superseded intent -> stale; non-input write over fields the user changed after the op started -> stale; `push` write while a non-background op on the same key is in flight -> conflict; else expected. Also run on every write at proposal time (`SimWrite.diag`). |
| delivery | `undefined` at decision time; after the run: `diag` of the first write of the delivered op / push message, else `expected` |
| request | `op.classify()`; `dupOf`/accidental -> duplicate; non-idempotent retry whose original committed -> duplicate; `anomaly: "storm"` (set through `kit.op` by poll, prefetch, multitab, wsreconnect, clockskew, exportjob, and assigned on the op by countdown, graphql, presence, ratelimit) or >= 6 req/s to that signature (counted over the last 2 s) -> overload; non-background superseded intent -> stale; streak >= 2 -> failing; else expected |
| failure | `diagnoseFailure`: outage or **offline** -> failing; timeout/504/`TimeoutError`: slow period or overload -> slow, else streak >= 2 -> slow, else transient; 429/503 shedding or rate limit: client >= 3 req/s or storm -> overload, else failing; bug -> unusual; storm -> overload; streak >= 2 -> failing; else transient |
| stall | outage window -> failing; `slowCause === "overload"` -> overload; else slow |
| inconsistency | `inconsistent` only if a relation is violated in the current client snapshot and overlaps the invariant's refs; else expected |
| transition | bug / replica lag / outage-emptied entries -> unusual; `partial`/`shape` write for the op or chain -> unusual; failed op -> `diagnoseFailure`; else expected |
| error | untagged -> expected; tag `expected` -> expected; tagged op with `parse-error` -> unusual; tagged op -> `diagnoseFailure`; else the tag's diagnosis |

S1 can then override an `expected`/missing diagnosis on gold rows (flow 5). The streak details of round 1 still hold
(`streak = know.streak[sigOf(op)] + 1`; error/transition callers count the current failure twice).
`DATA_ROLES` is unchanged (`results echo refetch poll-result view-data append data load confirm created push cache
resync conflict-refetch bulk-result presence swr-cache clear placed`); several round-2 data roles are not in it (see
Drift).

### 9. Cluster runs (`sim/scripts/cluster/`)

1. `bundle.sh` (train VM): tars Node 22, the runtime dist, `sim/dist` (incl. `model-host/`), `sim/scripts` and the
   needed `node_modules` into `~/xfer-sim/simbundle.tgz` (~100 MB), served on `10.0.0.4:8810`. `DIST=` picks the
   built sim dir.
2. `orchestrate.sh` (colleague's Mac; strictly one `az` call at a time, each with a timeout): `start`, `start-nowait`,
   `run RUN MODE ROWS_PER_NODE nodes...`, `status`, `kill`, `stop` (deallocate). Seed base per mode: gold 1e9,
   unlabeled 3e9, on-policy 5e9 (v1); v2 runs pass `SEED_BASE` (gold 11e9, unlabeled 16e9, on-policy 22e9, checks
   19e9). Node `cNN` gets base + NN x 1e8 (`data` = 12).
3. `node_start.sh` (on a node): fetches the bundle (`REFRESH=1` re-fetches), runs `gen.js --parts --chunk 100` with
   `nproc - 4` workers and `--max-old-space-size=8192`, mode `gold | unlabeled | onpolicy:<dir>`, serves
   `~/simgen/out` on `<private ip>:8811`; `SIM_FEATURE_HOLDOUT` defaults to `on`.
4. `bigrun.sh` (v2): `start`, `unl RUN ROWS NODES` (16e9, refreshes the bundle), `gold RUN ROWS NODES` (11e9),
   `wait`, `ips`.
5. `collect.py RUN OUTDIR HOST...` (or `--local DIR...`): pulls finished parts only (re-runnable), dedupes globally
   over sha1(state + questions) processing test, then dev, then train (no leakage), writes
   `{train,dev,test}-NNNNN.jsonl.gz` (<= 500k rows each) + `manifest.json`.

These scripts hard-code the colleague's paths (`/Users/meharkhanna/jev/scripts/azvm.sh`) and Azure resource group
`rg-jev-train`. **Do not run them** (no Azure from our side).

### Feature combinators and the bugs they create

`FEATURE_WEIGHTS` (`sim/src/app/features/index.ts`), round 1: search 8, editor 7, form 7, cart 7, poll 7, board 6,
nav 6, list 6, toggle 5, chat 5, counter 4, settings 4, bulk 4, auth 4, benign 4 (benign never drawn by weight; added
with p 0.3). Round 2: querycache 6, masterdetail 6; infinite, offline, wsreconnect, undo, reorder, wizard, etag,
badge, facets, cascade, payment, inventory, multitab, swcache, money 5; upload, graphql, saga, presence, clockskew,
longtask, exportjob, prefetch, ratelimit, cdn, countdown, schemadrift 4; permissions, flags 3. Program size 1:35,
2:45, 3:20 features.

The round-1 table below is unchanged since 654d822 (the feature files did not change).

| feature | knobs -> pattern tags | bug opportunities | relations / external |
|---|---|---|---|
| `search` | `guard:none\|abort\|reqid\|check`, `debounce`, `cache`, `err:show\|silent\|throw`, `timeout` | out-of-order results overwrite newer ones (stale, now mostly a `delivery` decision); per-keystroke requests; unhandled rejection | - |
| `editor` | `save:debounce\|interval\|button`, `overlap:allow\|serialize`, `echo:always\|if-unchanged\|version-only`, `vcheck:*`/`novcheck`, `live:blind\|if-clean`/`nolive`, `retry:*` | overlapping saves; older echo over newer typing; 409s; blind live edits; retry of old text | external collaborator edits |
| `form` | `disable`, `idem`, `retry:none\|same-key\|no-key`, `retry-on:*`, `ok:append\|refetch`, optimistic variants, `count\|count-partial\|nocount` | double submit; duplicate create after committed timeout; no rollback; partial count | count == len(list) |
| `cart` | `mode:optimistic\|server\|echo`, `rollback`, `recompute:*`, `addguard`, `co-*`, `badge` | non-idempotent add + double click; stale full-cart echo; totals not recomputed; duplicate orders | total, count, badge |
| `toggle` | `ep:absolute\|relative`, `rollback`, `echo`, `pending-guard\|noguard`, count variants | relative toggle + double click; echo flip-back; partial count | flagged count |
| `counter` | `ep:increment\|absolute`, `echo:*`, `retry:*` | over-count; stale echo | - |
| `poll` | `mode:interval\|chain`, `skip-inflight\|overlap`, `fail:backoff\|tight\|ignore\|throw`, `seq\|noseq`, `timeout` | overlapping polls; tight retry loop (now `anomaly: "storm"` -> overload); throw after 2 failures | external metric changes |
| `board` | `push:blind\|version\|skip-pending`, `echo`, `rollback`, counts variants, `vcheck` | blind push over a pending local move (conflict); stale push; partial counts; 409 | per-column counts; external moves |
| `chat` | `optimistic\|pessimistic`, `dedupe:*`, `resp:*`, `disable`, `unread` | duplicate messages; draft cleared; double send | incoming messages |
| `settings` | `echo:full\|key\|none`, `seq\|noseq`, `serialize\|parallel`, `rollback` | full-object echo reverts a newer toggle | - |
| `nav` | `mode:all\|allSettled\|chain`, `route-guard\|noguard`, `abort\|noabort`, `err:*`, `swr` | previous view's data in the current view; unhandled rejection; partial render | - |
| `list` | `guard:none\|reqid\|abort`, `more-guard\|more-noguard` | stale page after filter change; duplicate page appends | - |
| `bulk` | `assume-all\|per-result`, counts variants, `disable` | assume all succeeded (`shape` -> unusual); partial counts | per-status counts |
| `auth` | `single-flight\|per-request-refresh` | rotated-token second refresh -> forced logout; duplicate refresh | - |
| `benign` | `beacon-timer\|beacon-user`, `noise:0\|1\|2` | none by design (heartbeats, ignored beacons, harmless uncaught errors); all `expected` | - |

Exact negative tags and per-feature `make()` draws of the round-1 features are as documented for 654d822 (unchanged
files; read each `make()` and `pattern()`); `TEST_PATTERNS` still names only round-1 patterns.

### Round-2 combinators

All 31 honour `FeatureCtx.clean` (correct guards in clean runs). Pattern tags from each `pattern()`; files hold the
full knob descriptions in their header comments.

| feature | pattern tags | defects / risky variants | env / relations / external |
|---|---|---|---|
| `infinite` (cursor infinite scroll) | `guard:inflight\|none`, `reset:*`, `dedupe\|nodedupe`, `cursor:*`, `count:*` | duplicate page appends; old-filter page lands in the new list and hijacks the cursor; offset overlap | relation; external inserts |
| `upload` (queue with progress/cancel) | `retry:*`, `idem\|noidem`, `cancel:*`, `retry-guard\|retry-noguard`, `conc:*`, `totals:*` | duplicate file after committed timeout; orphan after cancel; Retry restarts running rows; partial totals | relation |
| `offline` (outbox) | `replay:*`, `idem\|noidem`, `reconcile\|noreconcile`, `queue:*`, `persist\|memory`, `done\|done-partial\|nodone` | temp-id 404s; racing replays; duplicate create on replay; partial done-count | `env()` offline windows; relation |
| `wsreconnect` (managed live feed) | `backoff:*`, `gap:*`, `seqcheck`, `dedupe`, `ticket`, `unread-*` | reconnect storm; missed events (stale feed); duplicate events | `env()` socket drops; external |
| `undo` (optimistic delete + toast) | `mode:*`, `fail:*`, count variants; `mode:immediate` adds `restore:*`, `await-delete\|race-delete`, `toast-once\|toast-stays`, `filter-pending\|nofilter`, other modes `flush-prev\|per-item-timers` | restore before delete (409); double restore; refresh resurrects item | relation; external |
| `reorder` (drag reorder) | `send:*`, `echo:*`, `serialize\|parallel`, `push:*`, `vcheck`, `retry`, `ui:*`, `head*` | relative PATCH retried twice; old echo reverts a newer reorder; blind push conflict | relation; correlated external |
| `querycache` (React-Query style) | `dedupe`, `retry:*`, `invalidate:*`, optimistic variants, `stale:*`, `interval`, `focus`, `observers:*`, `total*` | duplicate queries; invalidation refetch before commit; revalidation over optimistic update | relation; external |
| `graphql` (batched queries) | `batch:*`, `retry:*`, `ferr:*`, `seq`, `addguard`, `refresh` | request storms; whole-batch retry re-runs the mutation; null over good data; out-of-order batches | external |
| `saga` (reserve -> charge -> confirm) | `compensate`, `derive\|derive-partial`, `idem`, `retry:*`, `disable`, `cancel:*` | half-done server state; double charge; partial derived count | relation; external |
| `wizard` (async validation) | `vguard:*`, `nav:*`, `disable`, `idem` | stale validity; double click skips a step; duplicate submit | correlated external (name taken -> 422, benign) |
| `etag` (If-Match autosave) | `if-match\|blind`, `412:*`, `echo:*`, `serialize\|overlap` | lost updates; older echo over newer typing; overlapping 412s | correlated external |
| `presence` (carets) | `throttle\|every-event`, `backoff\|hammer`, `ttl\|no-ttl`, `count\|count-partial` | request storm into 429/503; ghosts; partial count | relation; external |
| `badge` (notifications + unread) | `all:*`, `dec:*`, `poll:*`, `rollback`, `badge-store\|badge-inline` | mark-all clobbers unseen; lagging replica count overwrites badge; partial badge | relation; correlated external |
| `facets` (faceted search) | `guard:*`, `update:*`, `url:*`, `debounce` | stale facet response; split/partial updates; URL drift | relation; external |
| `masterdetail` | `guard:*`, `echo:*`, `switch:*`, `disable` | A's detail under B; A's saved values into B's form | relation; external |
| `clockskew` (server timestamps vs skewed clock) | `fresh:*`, `token:*`, `check:tight\|normal` | refetch loop; premature token refresh; expired data shown; 401 | `env()` skew; external |
| `longtask` (main-thread blocking) | `render:*`, `input:*`, `reqid`, `busy-guard`, `autorefresh` | late timers; re-clicks during the block; swallowed clicks | uses `env.busy` -> `loop.advance` |
| `cascade` (dependent selects) | `guard:*`, `clear`, `validate`, `depth:*` | old parent's options land late; invalid child kept | relation (child in parent's options) |
| `exportjob` (async job + polling) | `dedupe:*`, `retry:*`, `poll:fast\|normal`, `backoff`, `stop-done`, `cleanup`, `maxwait` | duplicate jobs; fast polling (overload); polling after done/close | - |
| `payment` (intent flow) | `disable`, `create-idem`, `confirm-idem`, `retry:*`, `on409:*`, `server:*`, `poll:*`, `status:*` | double charge (server damage); 409 as failure; older status over `succeeded` | - |
| `inventory` (stock-limited reserve) | `optimistic:*\|pessimistic`, `on409:*`, `refresh`, `addguard`, `idem` | phantom reservations; partial rollback; 409 storm on stale stock | relation; correlated external |
| `prefetch` (hover prefetch) | `trigger:*`, `dedupe`, `ttl`, `vguard` | hover storm; duplicate in-flight request; old copy over newer | correlated external |
| `multitab` (localStorage / BroadcastChannel) | `kind:*`, `via:*`, `apply:*`, `persist:*`, `server:*`, `patch\|full`, `echo-*`, `refetch-*` | other tab clobbers unsaved local changes (conflict) or older over newer (stale); refetch storms | correlated external via `otherTab` |
| `ratelimit` (strict quota) | `on429:*`, `fanout:*`, `auto`, `strict-window\|lenient-window` | immediate retry loop (storm); fan-out over quota | external |
| `cdn` (edge cache) | `after:*`, `invalidate:*`, `auto` | stale CDN copy over a fresh echo (purge race) | external |
| `swcache` (SW-style cache) | `strategy:*`, `key-guard`, `persist\|memory` | cache-first keeps broken responses; slow fetch for the previous tab overwrites the current one | relation; external |
| `countdown` (auctions vs skew) | `mode:*`, `clock:*`, `on409:*`, `retry:*`, `live\|poll`, `skew\|noskew` | closes too early / stays open; bid storm; optimistic bid kept | `env()` skew; external |
| `money` (derived money fields) | `round:*`, `recompute:*`, `echo:*`, `save:*`, `rollback` | totals not recomputed (partial); older echo over newer edits | relation |
| `permissions` (role downgrade) | `on403:*`, optimistic variants, `live`, `poll` | repeated 403s; stale `canEdit` (partial); no rollback | relation; correlated external |
| `flags` (feature-flag rollout) | `v2:*`, `flags:*`, `fallback`, `validate` | broken v2 (`anomaly: "shape"` -> unusual); total silently 0 | relation; external |
| `schemadrift` (deploy changes schema) | `drift:*`, `client:*`, `deploy-rollback\|deploy-stays` | NaN / garbage totals (`shape`); uncaught `toFixed`/parse errors | relation; external |

`TEST_FEATURES` (test only): swcache, presence, cascade, saga, prefetch, permissions.

The network adds failure modes independent of features: random 5xx, network errors, latency spikes, slow periods,
outages (`503 500 502 neterr hang empty`), capacity overload, rate limits, replica lag, server bugs, and (round 2)
offline windows and socket drops.

### Domains and naming (`sim/src/app/vocab.ts`, `vocab2.ts`, `naming.ts`)

- `DOMAINS` in `scenario.ts` = the 55 of `vocab.ts` followed by the 60 of `vocab2.ts` (115). Round-2 domains:
  dental, triage, lims, trials, genomics, journaling, construction, architecture, manufacturing, quality, mining,
  oilgas, ports, airline, railways, transit, parking, evcharging, solar, water, waste, city311, elections, courts,
  dispatch, childcare, schooladmin, admissions, language, recruiting, salon, pos, printfarm, dealership, portfolio,
  taxes, mortgage, marina, skiresort, themepark, museum, cinema, podcast, esports, wedding, volunteer, hoa,
  homeservices, mdm, secops, observability, featureflags, datawarehouse, mlops, labeling, translation, ediscovery,
  patents, gardening, genealogy.
- `TEST_DOMAINS` (19/115): weather, legal, pets, auction, farm, permits, music, hotel, payroll, survey, dental,
  mining, railways, water, elections, admissions, marina, mlops, genealogy.
- Two round-1 vocab edits since 654d822: weather `station.temp` range now `0-40` (was `-20-40`), devops `deploy` name
  field `release` (was `version`).
- Naming, routes and view routes are unchanged from round 1 (route casing kebab:5 snake:2 camel:1; prefixes `/api`,
  `/api/v1`, `/api/v2`, `/v1`, `/rest`, `/svc/<app>`, none; synonym pools `SYN`; scope words avoid route clashes).

### Fake runtime (test double)

`createFakeRuntime` is unchanged: triggers `request`, `failure`, `stall`, `mutation`, `error` only (no `delivery`,
`inconsistency`, `transition`), crude text, `meta.runtime: "fake"`; never for training. The oracle tests that look
for `delivery` decisions need `SIM_RUNTIME=real`.

### Ask questions (`sim/src/ask/questions.ts`)

Unchanged: 11 generators (`q_write_inflight`, `q_any_inflight`, `q_pending`, `q_last_failed`, `q_recent_failure`,
`q_fail_count`, `q_user_waiting`, `q_user_recent`, `q_last_save`, `q_route`, `q_slowest`), 1-3 per probe; only
`last_failed`, `route` and `slowest` check that their evidence appears in the serialized state.

## Configuration and constants

| name | type | default / value | defined in | effect |
|---|---|---|---|---|
| `--rows`, `--out`, `--seed`, `--workers`, `--max-points`, `--test-keep`, `--explore` | | 1000 (900 sample), `sim/out/run`, 1, 4, 6, 0.33 (1 sample), 1 | `gen.ts` -> `parse` | as round 1 |
| `--no-ask` / `--allow-fake` / `--sample` | flags | off | `gen.ts` | `--no-ask` is ignored in unlabeled mode |
| `--parts`, `--chunk`, `--merge-only` | flag, number, flag | off, 100, off | `gen.ts` | resumable parts |
| `--unlabeled` | flag | off | `gen.ts` | `mode: "unlabeled"` |
| `--on-policy <dir>` | path | - | `gen.ts`, `worker.ts` | `mode: "onpolicy"`; TRAIN export dir read from disk; needs `sim/dist/model-host/host.js` (`npm run build`) and `onnxruntime-web` resolvable |
| `SIM_RUNTIME` | env | unset (fake) | `sim/test/helpers.ts` | `real` = tests on the real runtime |
| `SIM_DEBUG` | env | unset | `sim/test/oracle.test.ts` | debug prints in a real-only test |
| `SIM_S2` | env | on | `latent.ts` -> `S2` | `0` turns S2 off (futures re-draw network/timing only) |
| `SIM_PROBE` | env | off | `probe.ts` -> `PROBE` | `1` adds `meta.probe` (analysis only; never changes labels) |
| `SIM_FEATURE_HOLDOUT` | env | on | `scenario.ts` | `off` disables the `TEST_FEATURES` hold-out |
| `GENCLASS_RUNTIME` | env | `@genclass/runtime` | `rt.ts` -> `realRuntimeFactory` | module specifier |
| runtime options | object | `model:false, mode:"heal", report:"silent", observe{fetch,timers,websocket,storage: true; xhr,user,errors,nav,perf: false}, triage:"salient", policy{thresholds{report 0, guard 0.5, heal 0.5}, holdBudgetMs 1e9, maxActionsPerMinute 1e9, requireDiagnosis false}, historySize 500`; on-policy `policy {holdBudgetMs 1e9, maxActionsPerMinute 1e9}` | `rt.ts` -> `createOptions` | forced-action contract; `storage` observer is new |
| scenario root key | string | `"scenario-v1"` | `buildScenario` | unchanged key, but the 115-domain list and new weights already changed every seed's world vs phase A/B |
| clean run | p | 0.05 | `buildScenario` | see Concepts |
| persona | weighted | casual 5, power 2, mobile 2, keyboard 1, novice 1; base keyMs U(70,210), keySigma U(0.25,0.6), thinkMs U(500,2600), doubleClickP 0:3/0.06:3/0.18:2/0.4:1, impatientP 0:3/0.3:3/0.7:2, impatienceMs U(900,3500), typoP U(0,0.25), tabSwitchPerMin U(0,1.5); kind overrides in `randomPersona` | `feature.ts` | user behaviour |
| chaos | weighted | calm 2, normal 3, flaky 3, degraded 3, storm 1, mobile 1, peak 1, deploy 1; mobile persona -> `mobile` with p 0.7; clean -> calm | `buildScenario` | network profile |
| `mobile` regime | - | flaky base; latencies x U(1.5,3), sigma U(0.6,1.0); netErrP >= U(0.01,0.05); 1-2 offline windows (1.5-8 s, + p 0.4 a 1-4 s one); a socket drop (0.8-5 s) | `makeNet` | - |
| `peak` regime | - | degraded base; capacity perSec int(3,9) (503/429/latency 2:2:2); up to 3 endpoints rate-limited perSec int(1,4), retry-after p 0.7; a global slow period 3-15 s x U(2,8) | `makeNet` | - |
| `deploy` regime | - | normal base; a global 502 outage 0.8-3 s; up to 2 read-endpoint bugs (2-10 s); replica lag int(500,3000) ms, p U(0.2,0.6) | `makeNet` | - |
| other network params | | `m`, spikes, transients, `netErrP`, `gatewayMs`, outages, slow periods, capacity, rate limits, replica lag, server bugs, push latency: as round 1 (on the base regime) | `makeNet` | - |
| offline failure | ms | U(2,12) then `TypeError` | `Network.send` | `cause: "offline"` |
| `tUser`, `warmup`, `tEnd`, ask times, `modelMs`, `budget`, `idStyle`, API style, vocab randomisation | | as round 1 (15% long sessions U(120,300) s else U(20,75) s; budget 3200:40 2000:30 1000:30) | `scenario.ts` | - |
| `TEST_DOMAINS` / `TEST_PATTERNS` / `TEST_FEATURES` | sets | 19 domains / 7 round-1 patterns / 6 features | `scenario.ts` | held-out splits |
| family hold-out / dev | hash | `hashAll("family-split-v1", family) % 100 < 17` / `hashAll("dev-split-v1", family) % 100 < 3` | `scenario.ts` | - |
| `TRIGGER_W` | weights | mutation 1, delivery 1.2, request 1, failure 1.6, stall 2.2, inconsistency 3, transition 3, error 2.2 (x1.5 non-expected) | `trajectory.ts` | point sampling |
| `DENSE_K` | number | 600 | `trajectory.ts` | gold: only decisions `k < 600` are labelled (replay cost); `pickOnPolicy` does not apply it |
| exploration | weights | eps 0:4, 0.08:3, 0.2:2 x scale; `eps`, `eps/2` (delivery), `eps/4`; unlabeled scale x 1.5 | `trajectory.ts` -> `explorePolicy` | - |
| `maxUnlabeled` | number | 40 | `GenOptions` | unlabeled rows per trajectory |
| futures K / adaptive gain | number | 3 / > 0.05 (future 1 always with S2) | `pointCosts` | - |
| `S1_GAP` | number | 1.0 | `trajectory.ts` | S1 threshold on passive's adjusted gap |
| `REPEAT_PRIOR` | table | gap <= 100 ms 0.74, <= 200 0.67, <= 500 0.17, <= 1000 0.23, <= 2000 0.2, <= 3000 0.06 | `latent.ts` | P(accidental \| gap) |
| `W` / `LABEL` | objects | as round 1 (area 1.0, horizon 10 s, final 15 s, finalClient 4.0, serverItem 25, serverField 6, shownError 1.5, uncaught 1.0, relation 0.8, relationFinal 2.0, wasted 0.08, latency 0.25; premiums 0/0.25/0.5, exactTie 1.5, tieEps 0.05, tau0 0.1, seMul 1.0) | `cost.ts` | - |
| transform | probs | 50% unchanged; else drop one non-passive non-best action p 0.12 (>= 3 options), shuffle p 0.5 | `transform.ts` | - |
| loop limits | number | 2,000,000 tasks per `runUntil`; 1000 `afterTask` re-arms | `loop.ts` | - |
| `pushIdsByData` cap | number | 2000 entries (oldest dropped) | `runner.ts` | payload fallback for push ids |
| cluster seed bases | numbers | v1 gold 1e9 / unlabeled 3e9 / on-policy 5e9; v2 gold 11e9 / unlabeled 16e9 / on-policy 22e9 / checks 19e9; + NN x 1e8 | `orchestrate.sh`, `bigrun.sh` | disjoint ranges |

## Invariants and gotchas

- **Never use unkeyed randomness or real time in world code.** No `Math.random`, `Date.now`, `performance.now`
  inside a run (`performance.now` only for timing stats such as `costMs`). Wall-clock values come from
  `AppEnv.clientNow()` (`EPOCH` + virtual time + skew). A draw whose order depends on the forced action shifts
  unrelated draws.
- **S2 must keep the prefix byte-identical.** Latent re-draws only touch things after *t* or unobserved by the client
  (server-side commit, ideal run). If you add a latent, key it by the future salt, apply it only when `t >= L.t` or
  server-side, and expect `info:latent-fallback` to count violations (~6% of re-seeded futures per the README).
  `SIM_S2=0` reproduces round-1 futures.
- **Request draws are keyed by `(seed, identity, occurrence)`; server ids are content-derived; `situation()` must stay
  side-effect free** (as round 1).
- **Correlation is synchronous**, now including WebSocket messages: `know.deliveringPush` is set only while the
  virtual socket dispatches, so the runtime must create its `ws` message op (and fire `opCreated`) inside that
  dispatch; `know.currentPush` is set only while the app's handler runs (`AppEnv.socket`). STATUS states both hold
  for batch 4+.
- **Module-level state.** `knowRef`, `pushIds`, `pushIdsByData` are module globals: never run two `runScenario`
  calls concurrently in one process (the generator awaits them sequentially).
- **`x-request-id` is the correlation channel** (volatile header in the runtime; `rows.test.ts` asserts it never
  appears in a state).
- **Gate thresholds must stay 0.5** with `requireDiagnosis: false` and `mode: "heal"` set explicitly. The runtime's new
  default mode (`observe`, our commit f3636b2) does not apply because `createOptions` passes `mode`.
- **Mutation is non-blocking in v2.** Per STATUS, without `policy.holdWrites` a `mutation` decision's `defer` is
  recorded only and `discard` is a late revert; the sim does not set `holdWrites`, so forced mutation `defer` costs
  the same as `apply` (then pinned to passive by the tie rule). Most stale-write cases now surface as `delivery`.
- **Delivery salience is narrow.** The runtime asks on a delivery only when the response would replace newer, already
  applied data with no newer same-signature request in flight, the body changes something, and (for a pending local
  change) it puts back the replaced value (STATUS batch 5). Benign concurrency usually raises no question.
- **Clean runs only fix guards in round-2 features.** Round-1 `make()` functions ignore `ctx.clean`, so a clean run can
  still contain a round-1 defect; it gets a calm network and no accidental clicks.
- **Task owners matter; the ideal run has no runtime; store weights shape the oracle; `DATA_ROLES` gates the
  superseded-intent rule; calm warm-up is partial; compact questions at budget 1000** (all as round 1).
- **Scenario changes ripple to every seed.** v2 added `vocab2` domains, 31 features, new weights, regimes, personas
  and draws; the same seed now yields a different world than in phase A/B. Never mix rows of different sim versions
  under one seed range (the cluster scripts use separate v1/v2 seed bases).
- **Unlabeled mode** ignores `--no-ask`, explores 1.5x more, and keeps decisions with < 2 actions. Its `meta.ran` is
  the sim's chosen action (passive or explored), not a model's.
- **On-policy** rows have no ask rows and no exploration; replays force `rec.ran` (what the gate ran). Matching a
  `decide` event to its decision uses `trigger|JSON(subjectRef without error)`; an unmatched decision keeps
  `ran` undefined (recorded as passive in `meta.ran`).
- **`mini()` test scenarios** keep the seed-4242 persona's `windowEvents` and its `clean` draw; they reset steps,
  external events, ask times, vocab, chaos and network.
- **The VM path** (`scripts/vm.sh`, `~/gcl/sim`) is the colleague's; `sim/out` on the train VM is a symlink to
  `/data/sim-out`, which `vm.sh` sync deletes (NEEDS FYI). Not for us.
- `benign` noise-count quirk, slug-id `sigOf` behaviour, ideal-run futures and the cost's initial state: as round 1.

## How to change it safely

Before any change: read the matching test in `sim/test/`. After it: `cd sim && npx tsc -p tsconfig.json --noEmit` and
`SIM_RUNTIME=real npx vitest run` locally (light checks; build the runtime first). Then **ask the user** before
`node dist/smoke.js --seeds 40` (check `internal errors`, correlation `*:none`), a small `gen.js` run and `analyze.py`.

1. **Add a feature combinator.** New `sim/src/app/features/<kind>.ts` exporting a `FeatureDef`; register in `FEATURES`
   and `FEATURE_WEIGHTS`. Requests only via `kit.op` + `kit.call` (an `anomaly` on the op now reaches the oracle),
   writes only via `kit.write` with `role`, `intent`, `key`, `op`; `dupOf` for repeats, `anomaly: "partial"` on paths
   that skip derived fields, `classify` where bookkeeping decides; `relations()`; `cond()`; honour `ctx.clean` (pick
   correct guards); declare `env()` for offline windows / socket drops / skew; use `env.clientNow()`, `env.online`,
   `env.on(...)`, `env.channel(...)`, `env.busy(ms)` and `world.otherTab` instead of globals. Add new data roles to
   `DATA_ROLES`. Consider `TEST_PATTERNS` / `TEST_FEATURES`. Check `smoke.js --profile` cost. Regenerate all data.
2. **Add or edit a domain.** Append to `vocab2.ts` (keep `vocab.ts` stable); every seed's domain pick changes.
3. **Change cost weights (`W`).** Regenerate. Changing only `LABEL` can be re-derived offline with
   `sim/scripts/relabel.py` from `meta.cost_futures` (re-apply `drop:<action>` transforms).
4. **Change a diagnosis or S1 rule.** `diagnose`/`diagnoseFailure`, `diagnosisFromOutcome`, `S1_GAP`, or a feature's
   `classify`; affects exploration, point sampling and `fake_diagnosis`. Update oracle tests and the S1 assertion in
   `rows.test.ts`.
5. **Change chaos, regimes or S2.** `makeNet` (parameters), `Network.send` (mechanics), `latent.ts` (re-draws). Keep
   every draw keyed and ideal-mode draw counts stable; keep `NetEntry.cause` accurate; run `latent.test.ts` and
   `determinism.test.ts`. Re-measure `REPEAT_PRIOR` with `smoke.js --repeat-prior` if the user model changes.
6. **Add an ask question.** As round 1 (`GENS`, evidence in text, skip borderline timings).
7. **Change budgets.** `budget` weights; coordinate with TRAIN and the runtime's auto budgets.
8. **Change the runtime contract.** `createOptions` and the structural types in `rt.ts`/`types.ts`; run
   `SIM_RUNTIME=real` tests. A new trigger needs `PASSIVE`, `TRIGGER_W`, `TIER` (and `relabel.py`/`analyze.py` maps).
9. **After any runtime situation change** (`packages/runtime/src/situation/*`): rebuild, regenerate all datasets and
   `sim/samples/*`, tell TRAIN. Current tag: `situation-v2`.
10. **Produce data.** v1 final data: `final.sh a|b|merge-b` (historical). v2 data: cluster scripts (flow 9), operated
    by the colleague. Never reuse a seed base across sim versions.
11. **Change splits.** Edit `TEST_DOMAINS`, `TEST_PATTERNS`, `TEST_FEATURES` or the salts; rerun `rows.test.ts`;
    regenerate.

## Tests

`cd sim && SIM_RUNTIME=real npx vitest run`: 19 tests in 5 files (lead, 2026-10-08: all passed). Without
`SIM_RUNTIME=real` the fake runtime is used and the two real-only tests are skipped, and `oracle.test.ts` fails:
checked on 2026-10-08 (`npx vitest run test/oracle.test.ts`, fake runtime): 3 failed, 5 passed, 2 skipped. The two
stale-overwrite tests find no `delivery` decision, and the outage-streak test gets `expected` instead of `failing`.
So a plain `npm test` in `sim/` is red by design; always set `SIM_RUNTIME=real`.

| test file | test | what it asserts |
|---|---|---|
| `sim/test/loop.test.ts` | 3 tests | macrotask/microtask ordering, `Response` bodies within one macrotask, keyed rng forks |
| `sim/test/determinism.test.ts` | same seed -> identical rows | seeds 11-13: identical rows, 0 `prefix-mismatch`, identical states and `fp` lists |
| | replay reproduces every prefix | seeds 100-129: forcing each action at indices 0, mid, last reproduces all `fp <= k` |
| `sim/test/latent.test.ts` (new) | re-draws only what lies after the decision | `futureProfile`: windows over before *t* unchanged, running ones keep start and end after *t*, later ones move with same length, `noLatent` returns the profile; `futureStepTimes` keeps prefix times and order, differs per salt |
| | hidden intent of earlier repeats | `repeatPrior` thresholds; `idealRepeatSkips` skips an 80 ms accidental repeat before *t* in 60-90% of 400 salts, never touches steps after *t* |
| `sim/test/rows.test.ts` | valid CONTRACT-D rows | 40 trajectories: no base errors, no prefix mismatch, labels reference offered options, dists sum to 1, no `x-request-id`, passive best on > 20%; **S1**: no `expected` row with passive's adjusted gap >= 1 |
| | splits and transform | 400 seeds: > 40 test, > 150 train; transform keeps passive and best |
| `sim/test/oracle.test.ts` | stale overwrite | search without guard: a **`delivery`** decision, diagnosis `stale`, `discard` cheapest and label best (passive `deliver`) |
| | one stale response among later stale ones | `discard` cheaper than `deliver`; best in `discard`/`defer` |
| | intentional double add | counter: request `expected`, `send` cheapest |
| | duplicate POST after committed timeout | `duplicate`; `block`/`coalesce` beat `send` |
| | outage failure streak | poll during 503 outage: `failing`; `delay`/`serve_cached` beat `send` |
| | benign concurrency | cart server mode, two adds: no `delivery`/`mutation` question at all, or passive best with `expected` |
| | label sharpness / exact ties | `actionLabel` unit checks |
| | (real only) partial-update invariant break | `inconsistent`; `rollback`/`resync` beat `ignore` |
| | (real only) duplicate token refresh | `duplicate`; `coalesce` beats `send` |

Helpers (`sim/test/helpers.ts`): `testFactory`, `mini(kind, patch, opts)` (one-feature calm scenario from seed 4242,
exact latencies via `latencyFn`), `step`, `runBoth`, `argmin`, `find`.

### Data and sample stats

- **Phase A** (`stats-final-a.json`; situation-v1, 15 features, 55 domains, seeds from 10,000,000): 600,676 rows
  (train 448,420 / dev 14,613 / test 137,643), 937 families, 245.8 rows/s on 56 workers; trigger mix ask 23.8%,
  mutation 23.3%, request 17.2%, failure 14.7%, stall 9.1%, inconsistency 5.5%, error 3.6%, transition 2.8%. Round 1
  (R17) trained on it. Per-trigger diagnoses, passive-best shares and budget lengths are in the file; they describe
  v1 only.
- **Phase B** (training/NEEDS): 1,415,344 rows (train 1,056,383 / dev 35,269 / test 323,692), 2,454 parts,
  `train:/data/sim-out/final-b/parts/`; same code/runtime as A.
- **gold-r1x** (v1 runtime, 115 domains + round-2 personas/regimes/clean runs, original 15 features): 832,279 rows,
  `data:~/simdata/gold-r1x/`.
- **v2 checks**: `train:/data/sim-out/v2chk-{gold,unl}` (one F80: 41.7k gold rows in 211 s, 265k unlabeled in 24 s,
  batch-4 runtime); `v2b5-100k` (batch-5 runtime, S1 + S2; SEPARABILITY §8). Probe rows `probe-150k` (v1, analysis
  only).
- **`sample-stats.json`** (now regenerated: `--sample`, seed 1, 32 workers, mode gold, a runtime with `delivery`):
  1,325 rows (train 560 / dev 49 / test 716), 154 trajectories, 80 domains, 143 families, all 46 features present;
  drops `info:latent-fallback` 68, `diagnosis-not-in-vocab` 18. `sample.jsonl` (200 rows) mixes request 41,
  delivery 34, failure 28, transition 27, mutation 23, inconsistency 16, stall 14, error 12, ask 5; all `runtime:
  "real"`. Exact runtime commit unverified.
- Throughput (README): gold ~4.4 rows/s per worker (~200-250 rows/s per F80), unlabeled ~150 rows/s per worker
  (~11-13k rows/s per F80), on-policy ~0.1 rows/s per worker (WASM inference).

## Drift and open issues

- **No v2 data or model is final yet.** Phase A/B and gold-r1x are situation-v1 and do not match the runtime at
  b435acb. The v2 runs (`train:/data/sim-out/v2-*`) are in progress on Azure (colleague-operated; [HANDOFF.md](../../HANDOFF.md),
  training/NEEDS). On-policy (DAgger) rows need a v2 model export that does not exist yet.
- **`sim/NEEDS.md` is stale in several places.** Item g (NaN recursion in `describe()`) is marked OPEN but the runtime
  now uses `Object.is(r, v)` (`packages/runtime/src/util.ts` -> `describe`); the "Batch 4 / situation-v2" needs and the
  separability fact proposals (F1-F9) are marked OPEN/ASK but STATUS lists them DONE (batch 4 and batch 5); the old
  a-f "ASK" items and the `transient`/`DEFAULT_DIAGNOSES` note are also done; its header's `createRuntime` options
  differ from `createOptions`.
- **README drift.** "Every row also has `meta.passive`": ask rows have no `passive`. "Clean runs ... correct guards":
  only round-2 features honour `clean`. Limitation 5 (few conflicts, NEEDS f) and limitation 6 percentages describe
  v1. The flag list omits `--parts/--chunk/--merge-only`. "Every generator checks that its evidence appears in the
  situation text" (only three do). The README's on-policy description is accurate but no v2 export exists.
- **`gen.ts` header comment** still shows `--test-keep 0.5`, "~12" examples and omits `--parts`, `--unlabeled`,
  `--on-policy`.
- **Code comments:** `rt.ts` header says the fake runtime lives in `test/fake-runtime.ts` (it is
  `src/run/fake-runtime.ts`); `NetEntry.simOp` mentions `x-sim-op` (now `x-request-id`); `diagnoseFailure`'s comment
  says a spike-caused timeout is `transient` (code: `slow` once streak >= 2); `Persona.typoP` says "per word";
  `RunOptions.explore` comment describes counterfactual futures; `Db.makeId` slug comment predates the runtime's
  `isSlugId`.
- **`DATA_ROLES` was not extended for round 2** (unchanged since 654d822). Most round-2 data writes reuse existing
  roles (`results`, `echo`, `refetch`, `data`, `load`, `push`, `cache`, ...), but some data-carrying write roles are
  not in the set: `list` (prefetch), `sorted` (longtask), `status` (payment, wsreconnect), `restored` (undo),
  `synced` (offline), `flags` (flags), `step`/`finish` (saga). For those writes the "data of a superseded intent ->
  stale" mutation rule never fires (impact on labels unverified; S1 can still relabel clear cases). Roles such as
  `detail`, `products`, `refresh`, `reconcile` and `restore` are op roles (`kit.op`), which this rule does not read.
- **Mutation `defer` is a no-op** under the sim's options (no `holdWrites`); mutation rows can only distinguish
  `apply` vs `discard` (late revert). Whether that is intended for training is undecided (unverified).
- **Discard reach on deliveries** (NEEDS, 03:20 UTC): before S2, 45 of 65 stale deliveries had `discard` within 0.5
  of `deliver`; CORE responded by narrowing delivery salience (STATUS batch 5) rather than widening discard.
- **CONTRACT §11** still says "≥ 40 domains", per-row paraphrase randomisation and a "serial" ideal world; the sim
  randomises diagnosis/action wording per trajectory (`diagVocab`, `actionVocab`; only the action option shuffle/drop
  is per row) and its ideal run is zero-latency and failure-free, not serialised.
  **`docs/runtime/ARCHITECTURE.md`** still says 55 domains and 15 combinators (now 115 and 46; an `upload` feature now
  exists).
- **Budgets:** since batch 4 the runtime's full budget is 2,400 characters (`STATE_CHAR_BUDGET` in
  `packages/runtime/src/situation/serialize.ts`; auto budget: webgpu and unknown device 2,400, wasm 1,000-2,000 by
  threads, i.e. also 1,333 / 1,667), and section limits stop growing at 2,400. The sim still samples 3,200 (40%),
  2,000 and 1,000 (`buildScenario`), and the `Scenario.budget` comment still says "3,200 WebGPU". So 40% of rows use
  a budget the runtime never picks on its own (impact on training unverified).
- **Fake runtime lags v2:** no `delivery`, no storage observation; the delivery oracle tests need the real runtime.
- **Dead code:** `keyedLognormal`, `relationMatches`, `searchLabel`, `sleepJitter`, `ROUTE_WORDS`,
  `Network.committedBefore`, `Knowledge.inflight()`, `Knowledge.appliedReadStart`; `localChange`/`errorList`
  written but not read; the no-op ternary in `runCost`; `latentFallbacks` (module counter, never reported). (`u01`
  is now used by round-2 servers; the poll `storm` anomaly bug is fixed: `Kit.op` copies `anomaly`.)
- **Label-quality limitations** (README "Known limitations"): K <= 3 futures (`meta.cost_futures` allows
  re-derivation with `relabel.py`); the failure-free ideal can be unreachable after a real failure; `defer` scored as
  defer-then-apply; thin classes; token lengths are estimates; ask labels imbalanced. SEPARABILITY §8: after S1/S2 and
  batch 5, look-alike rates dropped and failure/request/inconsistency recall at 1% FIR rose on 100k v2 rows, but
  mutation, stall and transition had too few clear test rows to judge.
- **Open proposals not implemented in the sim:** S3 (split the area term into immediate vs later divergence) and the
  S2 "alternative next actions" part (only timing is re-drawn; order and content are kept). T1 (expected-advantage
  target) is TRAIN's.

## Related docs

- [model-io-contract.md](model-io-contract.md): row -> packed request -> heads -> calibrated answers.
- [training.md](training.md): how rows are imported, trained on (teacher, distillation, DAgger) and evaluated.
- [realapps.md](realapps.md): the real-browser corpus (REAL), same CONTRACT-D label semantics as the sim.
- [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md): the facts, triage and serializer that
  produce every `state` the sim records (situation-v2, batch 5 facts).
- [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md): the gate, `delivery` holds and actions.
- [runtime/observe-and-trace.md](runtime/observe-and-trace.md): ops, `opCreated`, WebSocket message ops, causality.
- [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md): `createRuntime` options and default mode.
- [runtime/build-test-release.md](runtime/build-test-release.md): where to run things, how `sim` consumes the build.
- [demos.md](demos.md): the independent external test (never modelled by the sim).
- [status-and-known-issues.md](status-and-known-issues.md), [glossary.md](glossary.md), [repo-map.md](repo-map.md).
- Source docs: [../../sim/README.md](../../sim/README.md), [../../sim/NEEDS.md](../../sim/NEEDS.md),
  [../../sim/SEPARABILITY.md](../../sim/SEPARABILITY.md), [../runtime/CONTRACT.md](../runtime/CONTRACT.md) §11 and §13,
  [../../packages/runtime/STATUS.md](../../packages/runtime/STATUS.md) (batch 4/5, SIM requests), [../../HANDOFF.md](../../HANDOFF.md),
  [../runtime/RESULTS.md](../runtime/RESULTS.md) (§3 format v1 vs v2, §6 data volume).
