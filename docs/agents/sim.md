# sim/: the training-data simulator (@genclass/sim)

> **Scope:** `sim/README.md`, `sim/NEEDS.md`, `sim/package.json`, `sim/tsconfig.json`, `sim/tsup.config.ts`,
> `sim/vitest.config.ts`, `sim/src/**`, `sim/test/**`, `sim/scripts/**`, `sim/samples/**`.
> **Read this when:** you generate or regenerate training data; change a feature combinator, domain, chaos model,
> cost weight, label rule, ask question, split or budget; debug a dropped trajectory, a `prefix-mismatch`, a wrong
> diagnosis label or an odd action distribution; or need to know exactly what a CONTRACT-D row contains.
> **Source of truth:** the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

## TL;DR

- The sim is a private Node package (`@genclass/sim`, ESM, Node 22) that builds **random web-app programs** from
  15 feature combinators x 55 domains, runs them with **simulated users** on a **simulated network and server**
  inside a **deterministic virtual event loop**, and drives the **real runtime** (`createRuntime` from
  `@genclass/runtime`, loaded dynamically) through it. Nothing in the runtime knows about the sim.
- Every time the runtime calls its `DecisionProvider.evaluate`, the sim's recording decider stores the request
  verbatim (`state`, `questions`); those bytes become a training row's model input. The sim never writes situation
  text itself.
- Labels come from **counterfactual outcomes**: for a sampled decision point *k*, the scenario is re-run once per
  applicable action with that action forced at *k* (and passive afterwards), over up to **K = 3 paired futures**;
  each run is scored by `runCost` against the **ideal run** (same intents, zero latency, no failures, no accidental
  clicks, exactly-once). `actionLabel` turns costs into a soft `action` distribution (precision first: tier
  premiums, ties pinned to passive).
- The `diagnosis` label is a hard label from the sim's own knowledge (`Knowledge`: intents, app ops, writes, error
  tags) via `diagnose`, not from the runtime's text. Rows also include diagnosis-only rows and `ask` rows with exact
  programmatic answers.
- Determinism rests on **keyed RNG forks** (`Rng.fork(label)` never depends on draw order), request draws keyed by
  (seed, request identity, occurrence), **content-derived server ids**, and a replay check that every decision up
  to *k* is byte-identical (`fp`) to the base run.
- Splits are per scenario: `test` = 10 held-out domains, or a held-out family hash (17%), or a held-out pattern;
  `dev` = 3% of remaining families; only 33% of test trajectories are kept (`--test-keep`).
- Output: `<out>/{train,dev,test}.jsonl` + `stats.json` (or resumable `parts/` in phase B). Row shape:
  `{id, split, family, state, questions, labels, meta}` (CONTRACT-D).
- **Where to run.** The original team ran sim builds, tests and generation only on the VM (`scripts/vm.sh run|exec
  sim '...'`; CONTRACT §0 rule 5, the author's Mac has 8 GB). Under the 2026-10-07 run policy in AGENTS.md, the runtime's
  install, typecheck, build and unit tests run locally, but ask the user before running the sim's vitest suites,
  `gen.js` or `sim/scripts/*` ([where to run things](runtime/build-test-release.md#where-to-run-things)).
  Committed samples in `sim/samples/`; the frozen-runtime phase A (600,676 rows) stats are in
  `sim/samples/stats-final-a.json`.
- Any change to the runtime's situation text (`packages/runtime/src/situation/*`) invalidates all data: rebuild the
  runtime, regenerate everything. Any change to sim scenario generation changes every seed's world.
- Vitest suites default to a crude **fake runtime** (`createFakeRuntime`); set `SIM_RUNTIME=real` to test against the
  real one (2 oracle tests run only then). `gen.js` uses the real runtime unless `--allow-fake`.

## Files

| path | role | key exports / entry points |
|---|---|---|
| `sim/package.json` | private package `@genclass/sim` v0.0.0, `bin: genclass-sim -> dist/gen.js` | scripts `build` (tsup), `typecheck`, `test` (vitest run), `gen`, `sample`, `build:runtime-core`; dep `@genclass/runtime: "*"` |
| `sim/tsup.config.ts` | ESM bundle, target node22, `@genclass/runtime` external | entries `gen`, `worker`, `index`, `smoke` -> `dist/{gen,worker,index,smoke}.js` |
| `sim/tsconfig.json` | extends `../tsconfig.base.json`, `noEmit`, includes `src`, `test` | - |
| `sim/vitest.config.ts` | node env, `pool: "forks"`, test/hook timeout 120000 ms | - |
| `sim/src/index.ts` | library re-exports | `buildScenario`, `splitOf`, `runScenario`, `generateTrajectory`, `actionLabel`, `runCost`, `COST_WEIGHTS` (= `W`), `LABEL_PARAMS` (= `LABEL`), `transformQuestions`, `ACTION_PARA`, `createFakeRuntime`, `VirtualLoop` |
| `sim/src/types.ts` | structural mirror of the runtime model seam + row types | `JevState`, `Question`, `NoulAnswer`/`ChoiceAnswer`/`ScoreAnswer`/`Answer`, `TriggerKind`, `ModelStatus`, `SubjectInfo`, `EvaluateRequest`, `DecisionProvider`, `Clock`, `PASSIVE`, `DIAGNOSES`, `Diagnosis`, `Row`, `Label` |
| `sim/src/rng.ts` | seeded PRNG (sfc32, splitmix32 init, 12 warm-up draws) with keyed forks | `hash32` (FNV-1a + murmur3 finalizer), `hashAll`, `Rng` (`fork`, `next`, `int`, `float`, `bool`, `pick`, `weighted`, `weightedKey`, `normal`, `lognormal`, `shuffle`, `sample`, `token`), `u01`/`keyedLognormal` (unused) |
| `sim/src/loop.ts` | virtual event loop | `VirtualLoop` (`schedule`, `at`, `cancel`, `afterTask`, `clockFor`, `settle`, `runUntil`, `pending`, `nextTime`, `stop`; fields `onSettled`, `onAppError`, `internalErrors`, `tasksRun`), `TaskOwner` (`app net runtime user sim`), `LoopError` |
| `sim/src/net/server.ts` | virtual server: DB + routed endpoints + idempotency keys | `Db`, `VirtualServer`, `API_STYLES`/`ApiStyle`, `canonical`, `clone`, `ServerSnapshot`, `ServerRequest`, `ServerResponse`, `Handler`, `RouteMeta`, `ServerLogEntry`, `Collection`, `Doc`, `Item`, `Json`, `IdStyle` |
| `sim/src/net/network.ts` | virtual network: latency, chaos, push channel, `fetch` | `Network`, `NetProfile`, `IDEAL_PROFILE`, `BASE_URL`, `NetEntry`, `NetCause`, `Win`, `Outage`/`OutageMode`, `SlowPeriod`, `ServerBug`/`BugKind`, `Lat`, `PushSub`, `SIM_OP_HEADER`, `simOpHeaderValue`, `parseSimOpHeader`, `makeResponse` |
| `sim/src/app/vocab.ts` | 55 domain vocabularies (2 entities each) | `DOMAINS`, `Domain`, `Entity`, `ROUTE_WORDS` (unused) |
| `sim/src/app/naming.ts` | per-program naming: route prefix/casing, store names, field synonyms | `Naming` (`field`, `word`, `store`, `route`, `owner`), `Casing`, `cased`, `camel`, `title`, `splitWords` |
| `sim/src/app/feature.ts` | feature contract, user model, personas, relations | `FeatureDef`, `FeatureCtx`, `FeatureClient`, `UserStep`, `StepIntent`, `UiKind`, `WorldCtx`, `ExternalEvent`, `Relation`, `rel`, `Persona`, `randomPersona`, `UserModel` (`think`, `key`, `type`, `click`), `itemName`, `numIn`, `round2` |
| `sim/src/app/env.ts` | what app programs see: global, stores, sockets, uncaught errors | `AppEnv` (`fetch`, `store`, `socket`, `subscribe`, `setRoute`, `uncaught`, `snapshot`, timers), `PlainBackend`, `SimGlobal`, `Store`, `StoreOpts`, `WriteMeta`, `StoreBackend`, `AtomLike`, `RegisteredStore` |
| `sim/src/app/kit.ts` | feature building blocks: tagged ops, requests, writes, error surfacing | `Kit` (`op`, `call`, `write`, `shownError`, `spawn`), `OpInit`, `CallOpts`, `CallResult`, `HttpError`, `errorFor`, `sleepJitter` (unused) |
| `sim/src/app/features/index.ts` | registry and frequency weights | `FEATURES`, `FEATURE_WEIGHTS` |
| `sim/src/app/features/common.ts` | shared helpers | `ContentBook`, `idsKey`, `seedItems`, `weightsOf`, `queryWords`, `errMsg`, `apiOf` |
| `sim/src/app/features/{search,editor,form,cart,toggle,counter,poll,board,chat,settings,nav,list,bulk,auth,benign}.ts` | the 15 combinators | one `FeatureDef` each (see [Feature combinators](#feature-combinators-and-the-bugs-they-create)) |
| `sim/src/world/scenario.ts` | seed -> scenario; splits; vocab randomisation; chaos profile | `buildScenario`, `BuildOptions` (`kinds`, `chaos`, `duration`, `domain`: tests only), `Scenario`, `FeatureInst` (`kind`, `id` = `f<i>`, `route`, `spec`, `pattern`), `splitOf`, `TEST_DOMAINS`, `TEST_PATTERNS`, `familyHeldOut`, `DEFAULT_DIAGNOSES`, `Chaos` |
| `sim/src/run/rt.ts` | runtime slice the sim uses; `createRuntime` options; loader | `RuntimeLike`, `RuntimeOptions`, `RuntimeFactory`, `RuntimeHooksLike`, `SituationLike`, `AtomLike`, `createOptions`, `realRuntimeFactory` |
| `sim/src/run/runner.ts` | runs one scenario (ideal or real), recording decider, correlation, snapshots | `runScenario`, `RunOptions`, `RunResult`, `Snapshot`, `DecisionRec`, `AskRec`, `AskFacts`, `ExplorePolicy` |
| `sim/src/run/fake-runtime.ts` | **test double** of the runtime (crude text); rows marked `meta.runtime: "fake"` | `createFakeRuntime` (see [Fake runtime](#fake-runtime-test-double)) |
| `sim/src/run/transform.ts` | per-row action-option shuffle/drop; action paraphrases | `transformQuestions`, `Transformed` (`questions`, `dist`, `variant`), `ACTION_PARA` |
| `sim/src/oracle/knowledge.ts` | ground truth bookkeeping | `Knowledge`, `Intent`, `Mode`, `SimOp`, `SimWrite`, `ErrorTag`, `sigOf` |
| `sim/src/oracle/diagnose.ts` | diagnosis labels | `diagnose`, `diagnoseFailure`, `Subject`, `DiagCtx`, `fieldRefs`, `relationMatches` (unused) |
| `sim/src/oracle/cost.ts` | divergence, run cost, soft labels | `W`, `LABEL`, `TIER`, `runCost`, `CostBreakdown`, `actionLabel`, `ActionLabel`, `clientDist`, `serverDist`, `divergenceArea`, `relationViolation`, `valueDist` |
| `sim/src/ask/questions.ts` | programmatic `ask` questions with exact answers | `askQuestions`, `AskQ` (`qid`, `question`, `label`, `kind`); 11 generators in `GENS` (see [Ask questions](#ask-questions-simsrcaskquestionsts)) |
| `sim/src/gen/trajectory.ts` | one trajectory = ideal + base + counterfactuals -> rows | `generateTrajectory`, `pointCosts`, `GenOptions`, `PointStat`, `TrajectoryOut` |
| `sim/src/gen/worker.ts` | `worker_threads` worker: seeds -> rows -> shard/part files | (message protocol, see flow 1) |
| `sim/src/gen.ts` | CLI: worker pool, shard merge, `stats.json`, `--sample`, parts mode | `main`, `mergeParts` |
| `sim/src/gen/examples.ts` | `EXAMPLES.md` renderer | `renderExamples` |
| `sim/src/dev/smoke.ts` | dev tool: base runs on many seeds, print raw situations | CLI `dist/smoke.js [--seeds 40] [--from 1] [--fake] [--show <trigger\|all\|ask>] [--cf]`; prints decisions by trigger, correlation `trigger:how`, diagnoses, mutation subject roles, push writes, internal errors; `--cf` also runs `generateTrajectory` (maxPoints 4) on up to 20 seeds |
| `sim/scripts/final.sh` | final datasets on the train VM | `final.sh a \| b \| merge-b` |
| `sim/scripts/analyze.py` | dataset summary (works on merged files or `parts/`) | `python3 sim/scripts/analyze.py <dir>` |
| `sim/test/*.ts` | vitest suites (17 tests) | see [Tests](#tests) |
| `sim/samples/` | `sample.jsonl` (200 rows), `EXAMPLES.md` (16 rows), `sample-stats.json`, `stats-final-a.json` | - |
| `sim/NEEDS.md` | SIM -> CORE requests (all DONE per STATUS) | - |

## Concepts and data structures

| term | meaning (code) |
|---|---|
| **scenario** | `Scenario` (`sim/src/world/scenario.ts`): one program (domain, 1-3 features + optional `benign`, naming, API envelope style `api`, `idStyle`), one user session (`steps: UserStep[]`), one network profile (`net: NetProfile`, `chaos`), `external: ExternalEvent[]`, timing (`warmup`, `tUser`, `tEnd`), `askTimes`, vocabulary overrides (`diagnoses`, `actionWords`), `modelMs`, `budget`. Fully determined by `seed`. |
| **trajectory** | one scenario processed by `generateTrajectory`: 1 ideal run + 1 base run + counterfactual runs -> rows. Rows of a trajectory share one split. |
| **feature / combinator** | `FeatureDef<S>`: `make(ctx) -> spec`, `pattern(spec)`, `server(spec, srv, db)`, `client(spec, env, kit) -> FeatureClient`, `session(spec, user, win)`, optional `external(...)`, `relations(spec)`. |
| **spec** | the per-program knob values a feature's `make` picks (guards vs defects). |
| **pattern** | variant tags from `pattern(spec)`, stored prefixed with the kind (e.g. `search/guard:none`). Used for held-out test patterns and `meta.patterns`. |
| **family** | program family = sorted unique feature kinds joined by `+` (e.g. `cart+search`). A row's `family` is `<program family>/<trigger>`. |
| **intent** | `Intent` in `Knowledge`: one user step; `key` = slot it targets, `mode` `replace` (newer replace-intents on the same key **supersede** older ones, `Knowledge.superseded`) or `accumulate`; `accidental` = double click / impatient re-click with `repeatOf`. |
| **sim op** | `SimOp`: an app-level request with `role`, `intent`, `key`, `idempotent`, `attempt`, `retryOf`, `dupOf` (repeat of another op), `anomaly` (typed `partial \| shape \| empty \| benign-change \| string`, but never set on ops in practice: `Kit.op` does not copy an `anomaly` field, so poll's `anomaly: "storm"` is dropped; features set `partial`, `shape` and `benign-change` on writes instead), `background`, `handled`, `classify()`, `rtOp` (runtime op id), `net` (network entry ids). Not the runtime's op. |
| **sim write** | `SimWrite`: one store write with `role`, `op`, `intent`, `key`, `fields` (top-level fields changed), `anomaly`, `classify()`, `rtMutation`. |
| **classify** | feature-provided closure on an op/write evaluated at decision time; returns a diagnosis (`stale`, `conflict`, `duplicate`, `expected`) or `undefined`, typically from content bookkeeping (`ContentBook` in search/cart: which intent the shown data reflects; editor keeps its own text map, board/poll compare versions/ranges). A returned label takes precedence in `diagnose`. |
| **relation** | `Relation {fields, desc, check(stores)}`: an invariant the app intends to keep (count = len(items), total = sum price*qty, badge = cart count, per-column/per-status counts). Ground truth for `inconsistent` and a cost term. |
| **ideal run** | `runScenario(scn, {ideal: true})`: no runtime (`PlainBackend` atoms), `IDEAL_PROFILE` network (0 latency, no failures/chaos, 0 push latency, 0 ms socket connect), accidental and conditional (`when`) steps skipped, app-generated duplicates (`dupOf`) share the original's result (`Kit.call`). The **intended outcome**. |
| **base run** | real runtime, recording decider, exploration policy, ask probes; `record: true`. |
| **counterfactual (cf) run** | real runtime, `forced` map (explored choices before *k*, action *a* at *k*, passive after), `fpUpTo: k`, `tStop: t_k + 15000`, optional `future`. |
| **decision point** | `DecisionRec` (`k` = 0-based index of `evaluate` calls in the run, `t`, `trigger`, `state`, `questions`, `actions` = keys of `questions.action.criteria`, `chosen`, `explored`, `diagnosis`, `subject`, `fakeDiagnosis`, `fp`). |
| **fp** | fingerprint `JSON.stringify([trigger, state, questions])`; cf runs must reproduce `fp` for every decision `<= k` or the point is dropped (`prefix-mismatch`). |
| **future** | `RunOptions.future = {k, salt, t}`. Future 0 = no salt (same draws as base). Futures 1..K-1 re-seed the draws made after the decision for network latency/failures/replica lag, push latency, model latency for `idx > k` and external events (+U(0,600) ms jitter) with a salt shared by all actions (common random numbers). App-code draws (`env.rng`) and the user session are not re-seeded. |
| **subject correlation** | mapping `EvaluateRequest.subject` (runtime ids) to sim knowledge: `Subject.kind` in `write`, `op`, `error`, `invariant`, `chain`, `unknown`; `DecisionRec.subject.how` in `subject`, `sync`, `chain`, `delivered`, `last`, `text`, `none`. |
| **D(t)** | weighted client divergence of the real run's stores from the ideal run's at the same time (`clientDist`). |
| **tier** | `TIER` in `cost.ts`: passive (`apply send deliver wait ignore`), guard (`discard defer coalesce delay`), heal (`block serve_cached retry hedge rollback resync`). Drives the label premium. |
| **chaos** | `"calm" \| "normal" \| "flaky" \| "degraded" \| "storm"`, picks network parameters (`makeNet`). |
| **diagnosis-only row** | a decision with < 2 applicable actions (runtime omits the `action` question); only a `diagnosis` label; no counterfactuals; <= 3 per trajectory. |
| **ask row / ask probe** | at `scn.askTimes` the base run calls `runtime.situation("ask")` (side-effect free) and records `AskFacts`; `askQuestions` attaches 1-3 questions with exact labels. |
| **budget** | `situation.budget` passed to the runtime per scenario: 3200 / 2000 / 1000 characters (runtime uses compact questions at <= 1400). Recorded in `meta.budget`. |
| **passive** | `PASSIVE` (`sim/src/types.ts`): mutation `apply`, request `send`, failure `deliver`, stall `wait`, inconsistency `ignore`, transition `ignore`, error `ignore`. Fallback everywhere: the first offered action. |
| **user model** | `UserModel` (`feature.ts`): `think(mul)` = max(120, lognormal(thinkMs x mul, 0.5)); `key()` = max(25, lognormal(keyMs, keySigma)); `type()` emits one `type` step per keystroke (value = full input text), typo + backspace with p = typoP/6 per non-space char, pause U(150,700) ms after a space with p 0.3; `click()` adds an accidental double click U(45,190) ms later with p `doubleClickP` (or `opts.doubleP`), and, when `pendingCond` is given, with p `impatientP` 1-3 impatient re-clicks starting at impatienceMs x U(0.7,1.4), spaced U(300,1500) ms, each guarded by `when: pendingCond` (runs only while `client.cond(name)` is true). Accidental steps carry `repeatOf: -1`; the runner resolves the real intent it repeats. |
| **session window** | per feature *i*: `cover = U(0.45, 1)`, length `tUser x cover`, start `U(0, tUser - len)` (`R.fork("session", i)`); steps at `>= tUser` are dropped; all steps sorted by `t`. |
| **transform variant** | `meta.transform`: `default`, `shuffle`, `drop:<action>`, or `drop:<action>,shuffle`. |
| **NetCause** | why a request ended (`NetEntry.cause`): `ok transient outage overload ratelimit spike slow-period gateway-timeout bug replica-lag neterr aborted notfound`; plus `slowCause` `spike \| slow-period \| overload`. Diagnoses read these. |

Row (`sim/src/types.ts` -> `Row`, CONTRACT-D):

```ts
interface Row { id: string; split: "train"|"dev"|"test"; family: string; state: JevState;
  questions: Record<string, Question>; labels: Record<string, Label>; meta: Record<string, unknown> }
type Label = {type:"choice"; label:string} | {type:"choice"; dist:Record<string,number>}
           | {type:"noul"; p:number} | {type:"score"; level:number} | {type:"score"; dist:number[]};
```

| row kind | `id` | `labels` | `meta` fields (beyond `meta0`) |
|---|---|---|---|
| decision | `sim-<seed>-d<k>` | `action: {type:"choice", dist}` (after transform), `diagnosis: {type:"choice", label}` when correlated and the label is in the offered vocabulary | `trigger`, `decision` (k), `t` (virtual ms), `explored_before`, `best`, `passive_best`, `costs` (mean per action, 4 dp), `cost_futures` (per-future totals), `futures`, `adjusted` (gap to best), `se`, `non_passive_mass`, `cost_parts` (future 0 breakdown: `area`, `final_client`, `final_server`, `relation_s`, `relation_final`, `errors`, `uncaught`, `wasted`, `latency_s`), `tiers`, `diagnosis` (or null), `subject`, `transform`, optional `fake_diagnosis: true` |
| diagnosis-only | `sim-<seed>-s<k>` | `diagnosis` | `trigger`, `decision`, `t`, `diagnosis`, `diagnosis_only: true`, `subject` |
| ask | `sim-<seed>-a<i>` | `q_*` per question (noul `p` 0/1, choice `label`, score `level`) | `trigger: "ask"`, `t`, `kinds` |

`meta0` (every row): `seed`, `domain`, `family` (program family), `chaos`, `budget`, `runtime` (`"real"` or `"fake"`),
`features` (kinds), `patterns`. Situation `state` sections seen in samples: `app`, `trigger`, `facts`, `in_flight`,
`timeline`, `state`, `stats` (produced by the runtime; see [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md)).

Random streams (every one is a keyed `Rng`; changing a key or the order of draws *within* one stream changes data):

| stream | key | used for |
|---|---|---|
| scenario root `R` | `Rng(hashAll("scenario-v1", seed))` | forks `domain`, `program` (-> `naming`, `api`, `ids`, `kinds`, `feature,i,kind` -> `make`), `timing`, `chaos`, `net`, `persona`, `session,i` (-> `user`), `external,i`, `ask`, `vocab`, `action-vocab`, `model`, `budget` (`buildScenario`) |
| trajectory `R` | `Rng(hashAll("traj", seed))` | forks `testkeep`, `explore`, `points`, `transform,k`, `single`, `ask,i` (`generateTrajectory`) |
| server ids | `hashAll("db-<seed>", collection, createKey, n, salt)` | `Db.makeId` |
| network | `hashAll(hashAll("net", seed), [salt,] identity, occurrence)`; push `(.., "push", topic, n)`; replica lag `(.., "lag", identity, occurrence)` | `Network.send`, `publish`, `process` |
| app | `Rng(hashAll("app", seed))` = `env.rng` | run-time draws inside feature code (always `env.rng.fork(<key>)`) |
| exploration | `Rng(hashAll("explore", seed)).fork(k)` | per-decision explore draw (`runScenario` decider) |
| model latency | `hashAll("model-latency", seed, idx[, salt])` | decider delay `lognormal(modelMs, 0.35)` |
| external jitter | `hashAll("ext-jitter", salt, i)` | +U(0,600) ms for external events after `future.t` |
| futures | `hashAll("future", seed, k, j)` | salt of future *j* at point *k* (`pointCosts`) |

## How it works

### 1. CLI and workers (`sim/src/gen.ts`, `sim/src/gen/worker.ts`)

1. `gen.ts` -> `parse` reads flags (table in [Configuration](#configuration-and-constants)); unknown flags throw.
2. Non-parts mode: deletes `<out>/shards`, spawns `--workers` `Worker(dist/worker.js)` with `workerData {id, out,
   fake, maxPoints, askRows, testKeep (1 when --sample), exploreScale}`; feeds each idle worker 2 consecutive seeds
   (`batch = 2`) from `--seed` upward until `produced >= target` (target = `--rows`, or 900 with `--sample`), then
   sends `{stop: true}`. Workers already fed finish their batch, so the run overshoots slightly and the exact
   last seeds depend on scheduling.
3. Worker: loads the factory once (`realRuntimeFactory()`, or `createFakeRuntime` with `--allow-fake`), then per
   seed `generateTrajectory(seed, opts)`; appends rows to `shards/<split>.w<id>.jsonl`; posts a `traj` message with
   compact stats. Exceptions -> `error` message (counted as drop `trajectory-exception`); a failed runtime import ->
   `fatal` (aborts the run). Messages: `ready`, `idle`, `traj`, `error`, `fatal`, `part-done`.
4. When all workers exit: shards are concatenated per split (sorted by file name) into `<out>/{train,dev,test}.jsonl`,
   `shards/` is removed, `stats.json` is written.
5. Parts mode (`--parts`): part *i* = seeds `[seed + i*chunk, seed + (i+1)*chunk)`. The worker writes
   `parts/part-NNNNNN.<split>.jsonl.tmp`, renames them when the part is complete and writes `part-NNNNNN.json`
   `{part, seeds:[first,last], rows}`. On start, `*.tmp` files are deleted and parts with a `.json` marker are skipped
   and their rows counted toward `--rows`. Writes `stats.session.json` (see table below), not `stats.json`.
   `--merge-only` concatenates `parts/*.<split>.jsonl` into `<out>/<split>.jsonl` (parts kept).
6. `--sample`: output to `sim/out/sample-tmp`, then writes `sim/samples/sample.jsonl` (200 rows, round-robin over
   groups `trigger|diagnosis|act-or-passive`), `sim/samples/EXAMPLES.md` (`renderExamples`: 12 targeted kinds, then
   distinct `trigger|best|diagnosis` up to 13, one diagnosis-only, two ask rows) and `sim/samples/sample-stats.json`.
7. Progress is logged at most every 15 s, checked when a `traj` message arrives (`[gen] <produced>/<target> rows,
   ...`). `--merge-only` implies `--parts`.

Output files of one `gen.js` run (`<out>` = `--out`, resolved against the cwd; `final.sh` first `cd`s into `sim/`):

| file | written by | content |
|---|---|---|
| `<out>/shards/<split>.w<id>.jsonl` | worker (non-parts) | per-worker rows; merged then deleted |
| `<out>/{train,dev,test}.jsonl` | `main` merge / `mergeParts` | final rows (one JSON `Row` per line) |
| `<out>/stats.json` | `main` (non-parts only) | aggregate stats (keys below) |
| `<out>/parts/part-NNNNNN.<split>.jsonl[.tmp]` | worker (parts) | rows of one part; `.tmp` until the part is complete |
| `<out>/parts/part-NNNNNN.json` | worker (parts) | `{part, seeds:[first,last], rows:{split:n}}` completion marker |
| `<out>/stats.session.json` | `main` (parts) | `{note, rows, seconds, rowsBySplitTrigger, drops, errors}`; all but `rows` cover this session only (`rows` also counts the rows of parts finished in earlier sessions) |

`stats.json` keys (`gen.ts` -> `main`): `args`, `rows` (per split), `rows_by_split_trigger`, `trajectories`, `runs`,
`decisions_seen`, `seconds`, `rows_per_sec_total`, `diagnosis_by_split_trigger`, `best_action_by_split_trigger`,
`passive_best_by_split_trigger` (`{rows, passive_best, frac}` per `split|trigger`),
`harm_of_non_passive_when_passive_best` (per trigger/action `{n, mean, p10, median, frac_harmful}`, harmful = cost
increase > 0.05), `gain_of_best_over_passive_when_not_passive`, `by_budget` (`rows`, `state_chars` and
`token_estimate` p50/p90/max, `passive_best_by_trigger`), `label_sharpness` (per trigger: passive-best rows with
passive mass >= 0.9; intervene-best rows with non-passive mass >= 0.95 / >= 0.9 / < 0.6; `points_with_3_futures` =
share of points with > 1 future), `ask_question_kinds`, `ask_labels` (`<qid>=<value>` counts), `token_estimate` (chars/3.6 of state+questions
JSON: p50/p90/p99/max), `subject_correlated` (`yes`/`no` per labelled point), `exploration` (`on-passive-path` /
`after-exploration`), `drops`, `skipped` (reason prefix before `:`), `domains`, `families` (count), `features`,
`errors` (first 20). Stats count only decision points (`PointStat`) for label statistics; row counts include
diagnosis-only and ask rows.

### 2. One trajectory (`sim/src/gen/trajectory.ts` -> `generateTrajectory`)

1. `buildScenario(seed)`; `split = splitOf(scn)`; trajectory rng `R = Rng(hashAll("traj", seed))`.
2. If `split === "test"` and `R.fork("testkeep").next() >= testKeep`: return `skipped: "test-subsample"` (no runs).
3. Ideal run (`ideal: true, serverTimeline: true`). Internal errors -> drop `ideal-internal-error`.
4. Exploration: `eps = R.fork("explore").weighted([[0,4],[0.08,3],[0.2,2]]) * exploreScale`. Per decision that
   offers a non-passive action, probability `eps` if the sim's diagnosis is set and not `expected`, else `eps/4`, to
   pick a uniformly random non-passive action (`explorePolicy`). Draws use `Rng(hashAll("explore", seed)).fork(k)`.
5. Base run (real runtime, `record: true`, `probeAsk`, explore). Internal errors -> drop `base-internal-error`,
   `skipped: "base-error: ..."`.
6. `pickPoints(base.decisions, maxPoints, R.fork("points"))`: candidates have >= 2 actions; weighted sampling
   without replacement with `TRIGGER_W` (mutation 1, request 1, failure 1.6, stall 2.2, inconsistency 3,
   transition 3, error 2.2) x 1.5 when the diagnosis is set and not `expected`; sorted by `k` (all candidates are
   kept when there are at most `maxPoints`).
7. For each point: `pointCosts` (flow 4) -> `actionLabel(futures, passive)` (flow 5) -> `transformQuestions(...,
   R.fork("transform", k))` -> labels. `diagnosis` label only if the diagnosis is in the offered criteria and
   `subject.kind !== "unknown"`; otherwise drop counters `diagnosis-not-in-vocab` / `diagnosis-uncorrelated`.
8. Diagnosis-only rows: decisions with < 2 actions, a diagnosis and a known subject; `R.fork("single").sample(.., 3)`;
   a sampled decision is skipped (not replaced) when its label is not among the offered diagnosis criteria.
9. Ask rows (unless `--no-ask`, which also turns off the base run's ask probes: `probeAsk = askRows`): for each
   `base.asks[i]`, `askQuestions(a, R.fork("ask", i))`; a probe that yields no question produces no row.

### 3. One run (`sim/src/run/runner.ts` -> `runScenario`)

1. New `VirtualLoop`, `Db(scn.idStyle, "db-<seed>")`, `VirtualServer`; each feature's `server()` registers routes and
   seeds data; `relations()` collected.
2. `Network(loop, server, ideal ? IDEAL_PROFILE : scn.net, hashAll("net", seed))`; `makeGlobal` builds `SimGlobal`:
   `fetch` = `network.fetch`, timers on the loop (owner `app`), `location` at `https://app.example.test/`,
   `document.title`, and a `WebSocket` class (`makeWebSocketClass`) over the push channel
   (`wss://<host>/ws/<topic>`, connect delay `40 + (topic.length % 7) * 10` ms, 0 in the ideal run; `send` not modelled).
3. Real runs: `factory(RuntimeOptions)` -> `createRuntime(createOptions(...))` with the recording decider,
   `loop.clockFor("runtime")`, vocabulary overrides, `budget`, `hooks`, `app: () => ({title, route})`. Stores are
   runtime atoms (`rt.atom(name, initial, {resync})`); ideal runs use `PlainBackend`.
4. `AppEnv` + one `Kit` per feature; `client()` per feature; initial route = first feature's route.
5. Schedules: `init()` of every client at t = 0; every user step at `st.t` (owner `user`; skipped if `when` is false;
   real runs wrap `client.handle` in `runtime.user(act, handler)` with `know.callingIntent` set); external events
   (owner `sim`; in a re-seeded future, events later than `future.t` are delayed by U(0,600) ms); ask probes (real
   runs with `probeAsk`, i.e. base runs only).
   Each executed step creates a `Knowledge.intent`; an accidental step's `repeatOf` resolves to the latest
   non-accidental intent with the same `feature|action|intent.key`. `act` = `{kind: ui.kind, target, value?}`.
   Ask probes call `runtime.situation("ask")` (a throw is an internal error) and record `AskRec {t, state,
   facts}`.
6. `loop.onSettled` pushes a client snapshot after every settled macrotask that changed a store (`env.dirty`) and,
   with `serverTimeline`, a server snapshot after every DB write.
7. `loop.settle()`, `loop.runUntil(min(tEnd, tStop))`, then collect `RunResult` (snapshots, final, server, decisions,
   asks, know, netLog, error counts/times, `userOpMs`, internal errors, weights, relations) and `runtime.destroy()`.

### 4. Counterfactuals (`sim/src/gen/trajectory.ts` -> `pointCosts`)

1. `forcedPrefix` = `{d.k: d.chosen}` for explored base decisions before *k* (non-explored ones were passive, which is
   the cf default).
2. For future `j = 0..K-1` (K = `GenOptions.futures ?? 3`): with `adaptive` (default true), stop after future 0
   unless some non-passive action beats passive by > 0.05 there.
3. Future `j >= 1`: `salt = hashAll("future", seed, k, j)`; if any external event is after `t_k`, re-run the ideal
   world with that salt (`future.k = -1`) so external timing matches.
4. For each action: `runScenario(scn, {forced: prefix + {k: a}, fpUpTo: k, tStop: t_k + W.finalMs, future})`.
   Exception -> drop `cf-exception`; internal error -> `cf-internal-error`; decisions `<= k` must equal the base run's
   `fp` -> else `prefix-mismatch`.
5. `runCost(cf, idealJ, t_k, scn.tEnd).total` (4 dp) per action per future; `cost_parts` and `results` from future 0.

### 5. Cost and labels (`sim/src/oracle/cost.ts`)

1. `stop = min(tEnd, t_k + 15000, run.tStop)`.
2. `area` = `divergenceArea` over `[t_k, min(stop, t_k + 10000)]` (seconds) of `clientDist(real, ideal)`.
   `clientDist`: per store/field weight from `env.store(..., {weights})` (default 1, weight <= 0 skipped); lists compare
   as multisets of content with volatile keys ignored (`id version rev revision etag updatedAt updated_at clientId
   pending seq`); numbers 0/1; objects averaged per key (depth < 3). The first field of every violated relation
   adds its full weight even if it equals the ideal value.
3. `finalClient` = `clientDist` at `stop`; `finalServer` = `serverDist(real.server, ideal server at stop)`:
   `25 x min(5, extra/missing items) + 6 x min(5, changed items)` per collection, `6 x min(3, differing fields)` per
   doc, `6 x min(3, |delta|)` per counter (counters named `*beats` ignored); volatile server fields stripped.
4. Error terms: shown-error episodes and uncaught errors in `[t_k, stop]` beyond the ideal run's count; `wasted` =
   per-signature server arrivals in `[t_k, stop]` beyond the ideal run's; `latencyS` = seconds non-background ops
   were pending in `[t_k, stop]` (absolute, not relative to ideal); relation-violation area over the 10 s horizon and
   count at `stop`.
5. `total = 1.0*area + 4.0*finalClient + finalServer + 1.5*shownErrors + 1.0*uncaught + 0.08*wasted + 0.25*latencyS
   + 0.8*relationArea + 2.0*relationFinal`.
6. `actionLabel(costs, passive)`: per-future costs paired by index (K = min length). Non-passive action whose mean
   is within `tieEps` 0.05 of passive's -> adjusted = passive's costs + `exactTie` 1.5; else cost + tier premium
   (passive 0, guard 0.25, heal 0.5). `best` = argmin mean adjusted (ties keep passive). `gap_a = max(0, mean(adj_a -
   adj_best))`, `tau_a = 0.10 + 1.0 * SE_a` (SE of the paired difference, 0 with one future), `p_a ∝ exp(-gap_a/tau_a)`,
   rounded to 4 dp.

### 6. A request through the world (correlation)

1. Feature code: `kit.op({role, method, url, intent, key, ...})` -> `Knowledge.beginOp` (sim op id).
2. `Kit.callNet` adds `x-request-id: req-<hash>-<opId base36>` (`SIM_OP_HEADER`, `simOpHeaderValue`), app timeout via
   `AbortController` with a `TimeoutError` reason, then `AppEnv.fetch` sets `know.callingOp` and calls
   `G.fetch` (runtime-instrumented).
3. The runtime creates its fetch op synchronously -> `hooks.opCreated` maps runtime op -> sim op (`know.rtOps`,
   `op.rtOp`), records causal parents (`know.rtParents`), and maps runtime user ops to intents (`know.rtUserOps`).
   The runtime treats `x-request-id` as a volatile tracing header (not part of request identity, never serialized).
4. If the runtime lets it through, `Network.fetch` strips the header (`parseSimOpHeader` -> `NetEntry.simOp`), draws
   latency keyed by `(netSeed, [salt,] identity, occurrence)`, and `onSend` appends the entry id to `op.net`.
5. Arrival after `0.35 x latency`; checks in order: outage -> capacity (non-latency mode) -> per-endpoint rate limit ->
   random transient (`transientP`; non-GET commits first with `postCommitP`, then 500) -> network error (`netErrP`, 50%
   commit) -> normal processing (server bug mutation, replica lag) -> gateway timeout 504 if the response would land
   after `t0 + gatewayMs`. A normal response is delivered `(0.05 + 0.6) x latency` after arrival (fast-fail paths
   such as outages and 429s use shorter offsets); bodies are real undici `Response` objects (`makeResponse`).
   Exact failure shapes: outage `neterr` -> `TypeError("Failed to fetch")`; `hang` -> 504 at `t0 + gatewayMs`;
   `empty` -> GETs processed with the `empty-list` bug (2xx, cause `outage`), writes 503; `503/500/502` -> that
   status. Capacity (`load` = arrivals in the last 1000 ms > `perSec`): 429 with `retry-after: 1` or 503; in
   `latency` mode the latency is multiplied by `1 + (load - perSec)/perSec` at send time instead. Rate limit:
   429, `retry-after: 1|2` when enabled. Random transient: post-commit -> 500, else one of 500/502/503. Server bug
   mutations (`mutateForBug`) apply only to responses < 400: `drop-field`/`null-field` on `field` of every item
   (depth <= 3), `empty-list` empties arrays and zeroes numeric `count|total` keys, `html` replaces the body with
   `text/html`. Replica lag swaps the resource (`RouteMeta.resource`, GET only) to its value before the earliest
   write in `(t - lagMs, t]` for the duration of the handler. In ideal mode the request is processed on arrival with
   no checks (latency 0, two dummy draws keep the stream aligned).
6. Server (`VirtualServer.handle`): routes match by method + segment count (`:param` segments capture); no match ->
   404 `{error:"not_found"}`; a throwing handler -> 500 `{error:"internal"}`. `Idempotency-Key` responses are
   remembered per `signature|key` when status < 500 and replayed (logged `note: "idempotent-replay"`,
   `committed: false`). `committed` in the server log = not a replay and status < 400; the network only counts
   non-GET commits. Every DB write increments `Db.writes` and stores a pre-write snapshot per resource key (`c:`,
   `d:`, `n:`; last 64) for replica lag. `snapshot()` strips `version updatedAt updated_at rev etag seq`.
7. `Kit` classifies the outcome (`ok`, `http-error`, `neterr`, `aborted`, `timeout`, `parse-error` for HTML/invalid
   JSON) and calls `Knowledge.endOp` (updates the per-signature failure `streak`: reset on `ok`, unchanged on
   `aborted`, +1 otherwise; signature = `sigOf`). `Kit.op` defaults `idempotent` to true for GET/PUT/DELETE and
   false for POST/PATCH unless the feature passes it; `Kit.callNet` also sets `accept: application/json` and, with a
   body, `content-type: application/json`. Outcome mapping of a rejected fetch: app timeout fired -> `timeout`;
   `AbortError`/`TimeoutError` -> `aborted`; anything else -> `neterr`. A 2xx whose body is not JSON (bug `html`)
   becomes `parse-error` with a synthetic `SyntaxError`.
8. Writes: `env.store(...).set(next, meta)` records a `SimWrite` (changed top-level fields; `input` role updates
   `userFieldTime`) and sets `know.writing` during `atom.set`, so `hooks.mutationProposed` maps runtime mutation ->
   sim write (`know.rtMutations`).

### 7. A decision (recording decider in `runScenario`)

1. `evaluate(req)`: `idx = k++`; actions = keys of `req.questions.action.criteria`; `correlate(req)` -> `Subject`:
   mutation via `subject.mutation` (else ambient `know.writing`); request/failure/stall/transition via `subject.op`
   (runtime retries/hedges map through causal parents up to 6 hops); transition on a user/timer op -> the chain of
   app ops descending from it (8 hops); request fallback ambient `know.callingOp` (`how: "sync"`); failure fallback
   `network.lastDelivered`; error via `subject.error` (else last
   uncaught error); inconsistency via `subject.invariant` + `paths` (else trigger/facts text).
2. `diagnose(trigger, subject, {know, network, relations, now, stores})` (flow 8).
3. Choice: `forced.get(idx)` -> else exploration -> else passive (`PASSIVE[trigger]`). A forced or explored action
   that is not among the offered actions falls back to passive (or the first offered action). `DecisionRec.subject`
   = `{kind, how, ref?}` where `ref` is the sim op/write id.
4. Answers: action = probability 1 on the chosen action; diagnosis = the sim's label, but if a non-passive action
   is chosen and the label is `expected`, answer `unusual` (or the first non-`expected` key) and set
   `fakeDiagnosis`; other noul questions 0.5, score level 0.
5. Records a `DecisionRec` (`record`, or `idx <= fpUpTo` with state/questions blanked). At `idx === future.k` the
   network switches to the future salt; model latency `lognormal(scn.modelMs, 0.35)` keyed by `(seed, idx[, salt])`.
6. Runtime policy (from `createOptions`): thresholds guard/heal 0.5 with `requireDiagnosis: false` -> exactly the
   forced action runs (the summed non-passive mass is 1 or 0).

Error paths into the runtime's `error` trigger: `Kit.spawn(fn, "uncaught", tag)` tags the rejection
(`Knowledge.tagError`, default tag `{cause:"unhandled", diagnosis:"failing"}`) and calls `env.uncaught(e,
"unhandledrejection")`; a throw inside an `app`/`user` loop task is tagged `{cause:"handler-threw",
diagnosis:"failing"}` (if untagged) and reported as `window.onerror`. `env.uncaught` -> `runtime.reportError(err,
{source})`. `benign` noise errors are tagged `expected`.

### 8. Diagnosis rules (`sim/src/oracle/diagnose.ts` -> `diagnose`, first match wins)

| trigger | rules |
|---|---|
| mutation | `write.classify()`; `anomaly === "partial"` -> inconsistent; `shape`/`empty`, server bug, or outage-emptied data with status < 400 -> unusual; op `dupOf` or accidental intent -> duplicate; replica lag -> stale; data role (`DATA_ROLES`) of a superseded intent -> stale; non-input write over fields the user changed after the op started -> stale; `push` write while a non-background op on the same key is in flight -> conflict; else expected |
| request | `op.classify()`; `dupOf`/accidental -> duplicate; non-idempotent retry whose original committed -> duplicate; `anomaly: "storm"` (dead branch, see sim op) or >= 6 req/s to that signature (2 s window) -> overload; non-background superseded intent -> stale; streak >= 2 -> failing; else expected |
| failure | `diagnoseFailure`: outage -> failing; timeout/504/`TimeoutError`: slow period or overload -> slow, else streak >= 2 -> slow, else transient; 429/503 shedding or rate limit: client >= 3 req/s (signature of the entry, 2 s window) or storm -> overload, else failing; bug -> unusual; storm -> overload; streak >= 2 -> failing; else transient. Both storm checks read `op.anomaly`, which is never set, so they never fire |
| stall | request inside an outage window -> failing; `slowCause === "overload"` -> overload; else slow |
| inconsistency | `inconsistent` only if a relation is violated in the current client snapshot and its fields overlap the invariant's `store.field` refs (`fieldRefs`); else expected |
| transition | a network entry of the op(s) with cause bug or replica lag, or cause outage with status < 400 or no status (outage-emptied 2xx, and also `neterr`-mode outages, which carry no status) -> unusual; a write with `partial`/`shape` anomaly for the op or chain intent -> unusual; failed op -> `diagnoseFailure`; else expected |
| error | untagged error -> expected; tag `expected` -> expected; tagged op with `parse-error` -> unusual; tagged op -> `diagnoseFailure`; else the tag's diagnosis |

Details: `diagnose` returns `undefined` (no label, drop counter `diagnosis-uncorrelated`) when the subject is
missing (mutation without a write, request without an op, stall with neither entry nor op, transition with neither
op nor chain). A failure always gets a label (`diagnoseFailure` falls back to `transient`), but the row still loses it
because `subject.kind` is `unknown`. In `diagnoseFailure`, `streak` = `know.streak[sigOf(op)] + 1`. For a `failure`
trigger the op has usually not ended yet (the `+1` stands for the current failure), so "streak >= 2" means at least
one earlier consecutive failure. For `error` and `transition` callers the op has already ended (`Knowledge.endOp`
counted it), so unless a later op of the same signature reset the streak, the `+1` counts the current failure twice
and a first failure already yields `failing` (or `slow` for a timeout). Error tags without an `op` (form, poll, nav
and cart-checkout spawns, `handler-threw`) return the tag's own `failing`. Both are consistent with phase A train
`error` points (94.8% `failing`, 0.1% `transient`). The request rule uses the raw `know.streak >= 2`. Client rates (`clientRate`) count
`NetEntry`s with the same route signature sent in the last 2000 ms, divided by 2. `DATA_ROLES` = `results echo
refetch poll-result view-data append data load confirm created push cache resync conflict-refetch bulk-result
presence swr-cache clear placed`.

### Feature combinators and the bugs they create

`FEATURE_WEIGHTS` (`sim/src/app/features/index.ts`): search 10, editor 9, poll 9, form 8, cart 8, board 7, nav 7,
list 7, toggle 6, chat 6, counter 5, settings 5, bulk 4, auth 3, benign 4 (benign is never drawn by weight; it is
added with p 0.3).

| feature | knobs -> pattern tags | bug opportunities (what the runtime should catch) | relations / external |
|---|---|---|---|
| `search` (typeahead) | `guard:none\|abort\|reqid\|check` (4/2/2/2), `debounce` (0 or 120-450 ms), `cache` (0.25), `err:show\|silent\|throw`, `timeout` (2.5-9 s); minLen 0-2 | no guard -> out-of-order results overwrite newer ones (stale mutation); per-keystroke requests; `err:throw` -> unhandled rejection | - |
| `editor` (autosave + echo) | `save:debounce\|interval\|button`, `overlap:allow\|serialize`, `echo:always\|if-unchanged\|version-only`, `vcheck:refetch\|overwrite\|show` or `novcheck`, `live:blind\|if-clean` or `nolive`, `retry:none\|once\|backoff` | overlapping saves; echo of an older save over newer typing (stale); 409 conflicts; blind live edits during local edits (conflict); retry of old text (stale) | external: 0-2 random collaborator edits; plus (live only) for the first 3 of the user's save steps (and about 4% of edit keystrokes), each with p 0.5, a conflicting edit 20-900 ms later |
| `form` (create) | `disable`, `idem`, `retry:none\|same-key\|no-key`, `retry-on:timeout\|5xx`, `ok:append\|refetch`, `optimistic+rollback\|optimistic-norollback\|pessimistic`, `count\|count-partial\|nocount` | double submit; retry without key after a committed timeout -> duplicate item (server damage); optimistic append without rollback; count not kept on refetch/rollback (`anomaly: partial`); 25% intentional identical re-creates (benign) | count == len(list) |
| `cart` | `mode:optimistic\|server\|echo`, `rollback`, `recompute:always\|skip-rollback\|skip-echo\|items-only-qty`, `addguard`, `co-disable`, `co-idem`, `co-retry:*`, `badge` | non-idempotent add POST + double click; full-cart echo stale with several updates in flight; totals not recomputed (partial); checkout double submit / retry without key -> duplicate orders | total = sum price*qty (abs diff < 0.011); count = sum qty; badge = cart count |
| `toggle` | `ep:absolute\|relative`, `rollback`, `echo`, `pending-guard\|noguard`, `count\|count-partial\|nocount` | relative (non-idempotent) toggle + double click flips back; echo flip-back (stale); no rollback; partial count | flagged count |
| `counter` | `ep:increment\|absolute`, `echo:always\|latest-only\|none`, `retry:none\|retry` | non-idempotent increment + retries/double clicks over-count; stale echo after rapid clicks | - |
| `poll` (dashboard) | `mode:interval\|chain`, `skip-inflight\|overlap`, `fail:backoff\|tight\|ignore\|throw`, `seq\|noseq`, `timeout` | overlapping polls (`dupOf`); tight retry loop (50 ms sleep after each failed response, up to 30 consecutive fails); it passes `anomaly: "storm"` to `kit.op`, which drops it, so these retries are `overload` only through the >= 6 req/s rate rule; throw after 2 failures; stale range responses | external: 2-8 metric changes |
| `board` (kanban + live) | `push:blind\|version\|skip-pending`, `echo`, `rollback`, `counts\|counts-partial\|nocounts`, `vcheck` | blind push over a pending local move (conflict); out-of-date push (stale); counts not updated on push (partial); 409 on version mismatch | per-column counts; external: 1-5 random moves + 30% of user moves followed by a conflicting move 30-700 ms later |
| `chat` | `optimistic\|pessimistic`, `dedupe:id\|clientId\|none`, `resp:replace\|append\|ignore`, `disable`, `unread` | duplicate messages (response + own push); pessimistic send clears a draft typed meanwhile; double send; 15% intentional repeats | external: 0-4 incoming messages |
| `settings` | `echo:full\|key\|none`, `seq\|noseq`, `serialize\|parallel`, `rollback` | full-object echo reverts a newer toggle (stale) | - |
| `nav` (views) | `mode:all\|allSettled\|chain`, `route-guard\|noguard`, `abort\|noabort`, `err:throw\|banner\|partial`, `swr` | previous view's data written into the current view (stale); `err:throw` unhandled rejection; partial render (`anomaly: benign-change`) | - |
| `list` (filters + infinite scroll) | `guard:none\|reqid\|abort`, `more-guard\|more-noguard` | stale page after filter/sort change; duplicate page appends from repeated scroll events (`doubleP` 0.35) | - |
| `bulk` | `assume-all\|per-result`, `counts\|counts-partial\|nocounts`, `disable` | assume all succeeded although locked items failed (207/409; `anomaly: shape` -> unusual); partial counts | per-status counts |
| `auth` (expiring tokens) | `single-flight\|per-request-refresh` | one refresh per 401 -> second refresh uses the rotated token -> 401 -> forced logout; duplicate refresh request | - |
| `benign` | `beacon-timer\|beacon-user`, `noise:0\|1\|2` | none by design: heartbeats (identical POSTs), beacons with ignored failures, config prefetch, harmless uncaught errors (`ResizeObserver loop...`, `Script error.`, ...). All ops/writes classify `expected`. | - |

Exact negative tags emitted by `pattern()` (needed when editing `TEST_PATTERNS`): search `nodebounce nocache
notimeout`; form `nodisable noidem`; cart `norollback noaddguard co-nodisable co-noidem nobadge`; toggle
`norollback noecho`; poll `notimeout` (positive `timeout`); board `noecho norollback novcheck`; chat `nodisable
nounread`; settings `norollback`; nav `noswr`; bulk `nodisable`. Tags are stored as `<kind>/<tag>`.

Knob draws in each feature's `make()` (weights `a:w`, probabilities `p`):

| feature | draws |
|---|---|
| search | guard none:4 abort:2 reqid:2 check:2; debounce 0:4 / int(120,450):4; cache p 0.25; minLen 0/1/2 equal; loadingFlag p 0.7; totalField p 0.6; onError show:5 silent:2 throw:2; timeout 0:3 / int(2500,9000):2; 12-40 seeded items; pageSize 10/20/25 |
| editor | save debounce:5 (300-1500 ms) / interval:2 (1500-5000 ms) / button:3; overlap allow:5 serialize:4; echo always:5 if-unchanged:3 version-only:2; versionCheck p 0.4; onConflict refetch:2 overwrite:1 show:2; live p 0.4 (blind:1 if-clean:1); retry none:3 once:2 backoff:2; timeout 0:3 / int(3000,10000):2; method PUT p 0.7 else PATCH; externalEdits 0:3 1:2 2:1 |
| form | retry none:4 same-key:2 no-key:3; idemKey = same-key or p 0.25; disable p 0.45; retryOn timeout:1 5xx:1; timeout (retry none: 0:2 / int(2000,6000):1, else int(1500,6000)); onSuccess append:3 refetch:1; optimistic p 0.35; rollback p 0.6; countField p 0.7; countOnAllPaths p 0.4; onError show:4 throw:1; 2-8 seeded items |
| cart | mode optimistic:3 server:3 echo:3; rollback p 0.6; recompute always:3 skip-rollback:4 skip-echo:2 items-only-qty:1; addGuard p 0.4; badge store p 0.5; checkout disable p 0.5, retry none:3 same-key:2 no-key:2, idem = same-key or p 0.3, timeout 0:2 / int(2000,7000):3; 4-10 products |
| toggle | endpoint absolute:3 relative:2; rollback p 0.6; echo p 0.5; pendingGuard p 0.35; countField p 0.65; countPartial p 0.5; 4-12 items |
| counter | endpoint increment:3 absolute:2; echo always:3 latest-only:2 none:1; retry none:3 retry:2; 3-8 items |
| poll | intervalMs 800:2 1000:3 1500:3 2000:2 3000:1 5000:1; mode interval:3 chain:3; skipIfInflight p 0.5; onFail backoff:3 tight:2 ignore:3 throw:1; timeout 0:3 / int(1500,6000):2; seqGuard p 0.35; 2-8 metric changes; 2-4 metrics |
| board | push blind:4 version:3 skip-pending:2; echo p 0.5; rollback p 0.6; countsField p 0.7; countsOnPush p 0.4; versionInBody p 0.3; 5-12 cards; 1-5 external moves |
| chat | optimistic p 0.6; dedupe id:2 clientId:2 none:3; onResponse replace:3 append:2 ignore:1; disable p 0.3; unread p 0.5; 0-4 incoming |
| settings | 2-3 keys; echo full:4 key:2 none:2; seqGuard p 0.3; serialize p 0.25; rollback p 0.5 |
| nav | 2-4 views x 2-3 resources (later resources depend on the first with p 0.3); mode all:4 allSettled:2 chain:2; routeGuard p 0.45; abortOnNav p 0.3; onError throw:2 banner:3 partial:2; swr p 0.3 |
| list | guard none:4 reqid:3 abort:2; moreGuard p 0.5; 15-45 items; pageSize 5/8/10 |
| bulk | applyAll p 0.45; countsField p 0.7; countsPartial p 0.5; disable p 0.5; 6-14 items, each `locked` p 0.2 |
| auth | ttlMs int(2500,9000); singleFlight p 0.5; 2 resources under `me/<entity>` |
| benign | heartbeatMs 2000/3000/5000; beaconOnTimer 0/2500/4000 ms; noise errors at U(500,14000) ms (count: see gotchas) |

The network adds failure-mode opportunities independent of features: random 5xx, network errors, latency spikes,
slow periods, outages (`503 500 502 neterr hang empty`), capacity overload (`503 429 latency`), rate limits with or
without `retry-after`, replica lag, and server bugs (`drop-field null-field empty-list stale-replica html`).

### Domains and naming (`sim/src/app/vocab.ts`, `sim/src/app/naming.ts`)

- `DOMAINS` (55, in array order; **bold** = `TEST_DOMAINS`): commerce, chat, docs, project, finance, health,
  travel, iot, games, media, crm, hr, education, maps, analytics, social, support, inventory, logistics, banking,
  calendar, food, realestate, **music**, news, email, notes, todo, fitness, **weather**, rides, events, **hotel**,
  library, **legal**, insurance, energy, **farm**, fleet, pharmacy, devops, code, marketing, **survey**, nonprofit,
  **permits**, sports, photos, jobs, **pets**, **auction**, wiki, procurement, **payroll**, invoicing.
- A `Domain` has `name`, `titles` (app titles), `entities` (2 x `Entity {s, p, name, words, nums, status, flags,
  create}`), `docs` (`[noun, textFields]`), `metrics`, `topics`, `settings`, `bulk` verbs, `people`. Built with the
  string helpers `D(...)` / `E(...)` (nums as `field=lo-hi-decimals`).
- `Naming` per program (`rP.fork("naming")`): route casing kebab:5 snake:2 camel:1; route prefix `/api`:5
  `/api/v1`:3 `/api/v2`:1 `/v1`:2 `/rest`:1 `/svc/<app-title-kebab>`:1 none:1; store names camelCase p 0.8 else
  snake_case (unique: suffix `2`, `3`, ... or `_2`, `_3`, ... in snake case); field names camelCase p 0.82 else snake_case. `field(role, scope)`
  picks once per `(role, scope)` from the synonym pool `SYN` (e.g. `list`: items results rows list entries
  records data hits; `loading`: loading isLoading pending busy fetching inFlight). `route(...)` prefixes a scope
  word (`shop admin team my app store hub desk`, chosen by a hash of the owning feature id) when a path could
  match another feature's route, so features never share an endpoint.
- Each feature's view route (`FeatureInst.route`) is `/<kebab of entity plural | "editor" | app|home|workspace>`;
  the program starts on the first feature's route (`runScenario` -> `env.setRoute`), except that a `nav` feature's
  `init()` switches to its own first view route, and its navigation steps change the route later.

### Fake runtime (test double)

`sim/src/run/fake-runtime.ts` -> `createFakeRuntime` implements `RuntimeLike` crudely so tests run without the real
runtime (default when `SIM_RUNTIME` is unset; `gen.js --allow-fake`). It wraps `global.fetch`, calls
`hooks.opCreated` / `hooks.mutationProposed`, and emits only these triggers: `request` (when an identical request
was sent in the last 3 s or the endpoint has a failure streak; actions `send [coalesce] delay block
[serve_cached]`), `failure` (`deliver retry`, plus `serve_cached` for an HTTP failure of a cached GET), `stall` (after max(1000 ms, 4 x median) once >= 3 latency samples
exist; `wait [hedge]`), `mutation` (an async fetch-caused write to a store written by another op since it started;
`apply discard defer`, defer = re-apply after 300 ms) and `error` (`ignore` only, so error rows are diagnosis-only).
No `inconsistency`/`transition` triggers. Situation sections: `app`, `trigger`, `facts`, `in_flight`, `timeline`.
Rows from it carry `meta.runtime: "fake"` and must never be used for training.

### Ask questions (`sim/src/ask/questions.ts`)

`askQuestions(a, rng)` shuffles the 11 generators, wants `rng.int(1, 3)` questions, and keeps the first that do
not return `null`; each generator gets `rng.fork(name)`. `text` = `JSON.stringify(a.state)`. Facts come from
`AskFacts` (`runner.ts` -> `askFacts`): network entries in flight / delivered in the last 15 s, last user intent
time, longest pending non-background sim op, last `save`-role op, current route.

| qid | type | label | skip (returns null) when |
|---|---|---|---|
| `q_write_inflight` | noul | any non-GET network entry in flight | never |
| `q_any_inflight` | noul | any entry in flight | never |
| `q_pending` | score (4 options) | `min(3, in-flight count)` | > 6 in flight |
| `q_last_failed` | choice `e1..e3` + `none` | latest failed entry (HTTP >= 400 or neterr) in the last 12 s, else `none` | < 2 distinct signatures; the failed endpoint's last literal path segment is not in `text` |
| `q_recent_failure` | noul | a failure in the last 5 or 10 s | a failure is within 1 s of the window edge |
| `q_fail_count` | score | `min(3, failures in 10 s)` | count differs between 9 s and 11 s windows |
| `q_user_waiting` | noul | longest pending non-background op > N s (N in 1,2,3,5) | within 400 ms of N s |
| `q_user_recent` | noul | last user intent < N s ago (N in 1,2,3) | within 300 ms of N s |
| `q_last_save` | noul | last finished `save` op was `ok` | no finished save |
| `q_route` | choice `r1..r3` | current route among 2 decoys | route not in `text` |
| `q_slowest` | choice `o1..o4` | oldest in-flight request | < 2 in flight (age > 0); top two within 300 ms or same signature; the last literal path segment of any in-flight request is missing from `text` |

## Configuration and constants

| name | type | default / value | defined in | effect |
|---|---|---|---|---|
| `--rows` | number | 1000 (900 with `--sample`) | `gen.ts` -> `parse` | target rows (parts mode: total across sessions) |
| `--out` | path | `sim/out/run` (relative to cwd) | `gen.ts` | output dir; `--sample` ignores it (`sim/out/sample-tmp`) |
| `--seed` | number | 1 | `gen.ts` | first scenario seed |
| `--workers` | number | 4 (`final.sh`: `WORKERS` env, 56) | `gen.ts`, `scripts/final.sh` | worker threads |
| `--max-points` | number | 6 | `gen.ts` | labelled decision points per trajectory |
| `--test-keep` | number | 0.33 (1 with `--sample`) | `gen.ts` | fraction of test trajectories kept |
| `--explore` | number | 1 | `gen.ts` | multiplies exploration eps |
| `--no-ask` / `--allow-fake` / `--sample` | flags | off | `gen.ts` | no ask rows / fake runtime (never for training) / sample mode |
| `--parts`, `--chunk`, `--merge-only` | flag, number, flag | off, 100, off | `gen.ts` | resumable parts of `chunk` seeds; merge only |
| `batch` | const | 2 seeds per worker message | `gen.ts` | non-parts feeding |
| `SIM_RUNTIME` | env | unset (fake) | `sim/test/helpers.ts` -> `testFactory` | `real` runs tests on the real runtime |
| `SIM_DEBUG` | env | unset | `sim/test/oracle.test.ts` | prints state, cost parts and snapshots in the real-only invariant test |
| `TIMEOUT` | env (s) | 1800 | `scripts/vm.sh` | every `vm.sh run/exec` command is wrapped in `timeout`; phase A took 2,444 s, so long `gen.js` runs need a larger `TIMEOUT` (how phase A was launched is unverified) |
| scenario root key | string | `"scenario-v1"` | `scenario.ts` -> `buildScenario` | salt of every scenario draw; changing it re-rolls every seed |
| `GENCLASS_RUNTIME` | env | `@genclass/runtime` | `sim/src/run/rt.ts` -> `realRuntimeFactory` | module specifier to import |
| runtime options | object | `model:false, mode:"heal", report:"silent", observe{fetch,timers,websocket: true; xhr,user,errors,nav,storage,perf: false}, triage:"salient", policy{thresholds{report 0, guard 0.5, heal 0.5}, holdBudgetMs 1e9, maxActionsPerMinute 1e9, requireDiagnosis false}, historySize 500` | `rt.ts` -> `createOptions` | forced-action contract with the runtime |
| feature count | weighted | 1:35, 2:45, 3:20; +benign p 0.3 | `scenario.ts` -> `buildScenario` | program size |
| `idStyle` | weighted | num 4, uuid 2, prefixed 2, slug 1 | `scenario.ts` | server id format (`Db.makeId`): num = `1000 + h % 899000`; uuid v4-shaped; prefixed = `<3-letter noun>_<digit><letter><12 chars>`; slug = `<noun[:6]>-<4 base36 chars>`. The runtime normalises a slug id in signatures only when `isSlugId` (`packages/runtime/src/util.ts`) accepts it: the 4-char suffix must start with a digit or alternate letters/digits at least twice (`k2x9`, `1cam`); all-letter, all-digit and single-transition suffixes (`abc1`, `a123`) stay literal. The sim's own `sigOf` never normalises slugs |
| API style | uniform | `items`, `data`, `bare`, `results` | `server.ts` -> `API_STYLES` | response envelopes |
| `tUser` | ms | 15%: U(120000, 300000); else U(20000, 75000) | `scenario.ts` | user session length |
| `warmup` | ms | `tUser x U(0.3, 0.6)` | `scenario.ts` | earliest start of outages/slow periods/bugs; ask probes from `warmup x 0.5` |
| `tEnd` | ms | `tUser + U(2500, 5000)` | `scenario.ts` | run end |
| chaos | weighted | calm 2, normal 3, flaky 3, degraded 3, storm 1 | `scenario.ts` | network profile |
| latency multiplier `m` | number | calm 0.5, normal 1, flaky 1.5, degraded/storm 2 | `scenario.ts` -> `makeNet` | scales medians: read U(50,220)m, write U(90,380)m, auth U(80,300)m, upload U(300,1500)m, bulk U(200,900)m; 25% of endpoints get U(100,1200)m |
| `spikeP`, `spikeMul` | number | calm 0.005; normal U(0.01,0.04); else U(0.01,0.1); mul [3, U(6,25)] | `makeNet` | latency spikes |
| `transientP`, `postCommitP` | number | calm 0; normal U(0,0.015); else U(0.02,0.12); post-commit U(0.2,0.7) | `makeNet` | random 5xx (some after commit) |
| `netErrP` | number | calm 0; normal U(0,0.004); else U(0,0.03) | `makeNet` | network errors (50% commit) |
| `gatewayMs` | ms | int(8000, 30000) | `makeNet` | 504 after this time in flight |
| outages | windows | degraded/storm, or flaky p 0.4: 1-2, length U(1500,9000), modes 503:4 500:2 502:2 neterr:2 hang:1 empty:2, endpoints `*` (p 0.4) or 1-3 | `makeNet` | outage failures |
| slow period | window | non-calm, p 0.25 (normal) / 0.6: length U(2000,10000), mul U(3,15) | `makeNet` | slow responses |
| capacity | object | storm, or degraded p 0.4: perSec int(4,14), mode 503:2 429:2 latency:1 | `makeNet` | overload shedding |
| rate limit | object | non-calm p 0.25: one endpoint, perSec int(2,6), `retry-after` p 0.6 | `makeNet` | 429s |
| replica lag | object | non-calm p 0.15: ms int(300,2500), p U(0.1,0.5) | `makeNet` | stale reads |
| server bug | window | p 0.05 calm / 0.18: a read endpoint, length U(2000,8000), kinds drop-field 2, null-field 2, empty-list 3, stale-replica 1 (2500 ms lag), html 1 | `makeNet` | malformed responses |
| push latency | lognormal | median U(20,150), sigma U(0.2,0.8); in order per topic | `makeNet`, `Network.publish` | live updates |
| persona | object | keyMs U(70,210), keySigma U(0.25,0.6), thinkMs U(500,2600), doubleClickP 0:3 0.06:3 0.18:2 0.4:1, impatientP 0:3 0.3:3 0.7:2, impatienceMs U(900,3500), typoP U(0,0.25) | `feature.ts` -> `randomPersona` | user behaviour |
| ask times | ms | 1-3 at U(warmup x 0.5, tEnd - 200) | `scenario.ts` | ask probes |
| `diagnoses` vocab | object/null | 50% default; else 30% drop 1-2 of `conflict slow overload unusual inconsistent duplicate transient`, each label paraphrased p 0.6 (`DIAG_PARA`) | `scenario.ts` -> `diagVocab` | runtime `vocabulary.diagnoses` |
| `actionWords` vocab | object/null | 50% default; else each action paraphrased p 0.6 (`ACTION_PARA`) | `scenario.ts` -> `actionVocab` | runtime `vocabulary.actions` |
| `modelMs` | ms | U(6, 25); latency `lognormal(modelMs, 0.35)` | `scenario.ts`, `runner.ts` | decider latency |
| `budget` | chars | 3200:40, 2000:30, 1000:30 | `scenario.ts` | runtime `situation.budget` |
| `TEST_DOMAINS` | set | weather, legal, pets, auction, farm, permits, music, hotel, payroll, survey | `scenario.ts` | held-out domains (10/55) |
| `TEST_PATTERNS` | set | `search/guard:check`, `settings/serialize`, `toggle/pending-guard`, `list/guard:abort`, `cart/recompute:items-only-qty`, `editor/echo:version-only`, `poll/fail:throw` | `scenario.ts` | held-out patterns |
| family hold-out | hash | `hashAll("family-split-v1", family) % 100 < 17` | `scenario.ts` -> `familyHeldOut` | test families |
| dev split | hash | `hashAll("dev-split-v1", family) % 100 < 3` | `scenario.ts` -> `splitOf` | dev families |
| `TRIGGER_W` | weights | mutation 1, request 1, failure 1.6, stall 2.2, inconsistency 3, transition 3, error 2.2 (x1.5 non-expected) | `trajectory.ts` | point sampling |
| futures K / adaptive gain | number | 3 / > 0.05 | `trajectory.ts` -> `pointCosts` | extra futures |
| `W` | object | area 1.0, horizonMs 10000, finalMs 15000, finalClient 4.0, serverItem 25, serverField 6, shownError 1.5, uncaught 1.0, relation 0.8, relationFinal 2.0, wasted 0.08, latency 0.25 | `cost.ts` | cost weights |
| `LABEL` | object | tier {passive 0, guard 0.25, heal 0.5}, exactTie 1.5, tieEps 0.05, tau0 0.1, seMul 1.0 | `cost.ts` | soft labels; an action missing from `TIER` gets the heal premium and `meta.tiers` value `heal`; `adjusted`/`se` rounded to 3 dp, `dist` to 4 dp |
| cost volatile keys | set | client: `id version rev revision etag updatedAt updated_at clientId pending seq`; server snapshot: `version updatedAt updated_at rev etag seq` | `cost.ts` (`VOLATILE`), `server.ts` (`VOLATILE`) | ignored when comparing list items / server items |
| server history | number | 64 pre-write snapshots per resource key | `server.ts` -> `Db.recordWrite` | replica-lag lookback |
| arrival windows | number | global list <= 512 (oldest 256 dropped when exceeded), per signature <= 256 (oldest 128 dropped); load window 1000 ms | `network.ts` -> `noteArrival` | capacity and rate-limit counting |
| transform | probs | 50% unchanged; else drop one non-passive non-best action p 0.12 (needs >= 3 options), shuffle p 0.5 | `transform.ts` | option order/subsets |
| diagnosis-only rows | count | <= 3 per trajectory | `trajectory.ts` | - |
| ask questions | count | 1-3 per probe, 11 generators | `ask/questions.ts` | - |
| loop limits | number | 2,000,000 tasks per `runUntil`; 1000 `afterTask` re-arms | `loop.ts` | `LoopError` -> trajectory exception |
| `BASE_URL` | string | `https://app.example.test` | `network.ts` | app origin |
| app timeouts | ms | cart add/qty 8000, toggle 8000, counter 6000, board 8000, settings 8000, chat 10000, bulk 10000, list 9000, nav 10000, auth 8000, beacon 5000, heartbeat 4000 | feature files | `timeout` outcomes |

## Invariants and gotchas

- **Never use unkeyed randomness or real time in world code.** No `Math.random`, `Date.now` or `performance.now`
  inside a run (`performance.now` is only for trajectory/smoke timing stats, `Date.now` only for the CLI's timing
  and progress log). Use the
  spec rng in `make`, `user.rng` in `session`, the `rng` passed to `external`, and at run time
  `env.rng.fork(<key derived from the intent>)` (e.g. idempotency keys `env.rng.fork("idem", ref)`). A draw whose
  order depends on the forced action shifts unrelated draws and breaks futures or the prefix check.
- **Request draws are keyed by `(seed, identity, occurrence)`** (`identity = method + path + search + body`). Two
  requests with identical identity share an occurrence counter; adding a request in a cf run only shifts later
  occurrences of the same identity.
- **Server ids are content-derived** (`Db.makeId`: hash of the `db-<seed>` salt, collection, create key (the
  canonical/JSON body or a feature-chosen key such as `seed:<name>` or `line:<productId>`), and how many identical
  keys were created before). The same intent gets the same id in every run; a duplicate gets a new one. Changing
  a create body format changes ids.
- **`runtime.situation()` must stay side-effect free**: ask probes run only in the base run; if a probe consumed
  runtime ids, every cf prefix would mismatch (NEEDS item 5).
- **Correlation is synchronous.** `know.callingOp` / `know.writing` / `know.callingIntent` are set only around the
  synchronous `fetch` / `atom.set` / `runtime.user` call; the runtime's `opCreated` / `mutationProposed` hooks must
  fire inside those calls. If a correlation fails, `subject.kind` is `unknown` and the row loses its diagnosis label.
  Phase A: 100% correlated (`subject_correlated`).
- **`x-request-id` is the correlation channel.** The runtime ignores it for identity and never prints it;
  `sim/test/rows.test.ts` asserts no `x-request-id` / `req-xxxxxxxx-` text appears in any `state`. Changing the
  header requires it to remain in the runtime's volatile header list.
- **Gate thresholds must stay 0.5** with `requireDiagnosis: false`: the decider puts probability 1 on the forced
  action; with 0 the gate would run the argmax non-passive action even when passive is forced.
- **Task owners matter.** Exceptions in `app`/`user` tasks become app uncaught errors (`window.onerror`, reported via
  `runtime.reportError`); exceptions in `net`/`runtime`/`sim` tasks (and in `afterTask` hooks) are internal errors and
  drop the trajectory (ideal or base run) or the decision point (cf run).
- **The ideal run has no runtime** and skips accidental and `when`-conditional steps; app-generated duplicates
  (`dupOf`) share the original result. Features must set `dupOf`/`accidental` correctly or the ideal world contains
  the duplicate.
- **Store weights shape the oracle.** Set per feature with `weightsOf` in `env.store(...)`. Error-message fields are
  always 0 (errors are charged as episodes; a branch must never win by hiding a message); typical values: data lists
  1, totals/placed 0.8, counts 0.4-0.6, inputs/drafts/filters/view 0.3-0.5, saved flag 0.3, loading/busy flags 0.1-0.12,
  versions 0. A field missing from the weights counts 1.
- **`DATA_ROLES`** (`diagnose.ts`) gates the "superseded intent -> stale" rule for mutations. A new feature role that
  applies server data must be added there.
- **Calm warm-up is partial.** Only outages, slow periods and server bugs start after `warmup`; random transients,
  spikes, network errors, capacity, rate limits and replica lag apply from t = 0.
- **Compact questions at budget 1000.** The runtime prints bare labels/names (null descriptions) when the budget is
  <= 1400 and keeps a vocabulary override only if it is <= 24 characters; every diagnosis paraphrase and most action
  paraphrases are longer (a few, e.g. `send it now`, are not), so wording randomisation mostly affects 2000/3200 rows
  (label subsets still apply).
- **Scenario changes ripple to every seed.** Adding a domain, a feature, a weight or an rng draw in `buildScenario`
  changes the keyed picks (e.g. `R.fork("domain").pick(DOMAINS)` depends on the array length), so the same seed yields
  a different program. Do not mix rows from different sim versions under the same seed range. Splits stay
  consistent across machines and versions only while `TEST_DOMAINS`, `TEST_PATTERNS` and the hash salts
  (`family-split-v1`, `dev-split-v1`) are unchanged; every seed's world also depends on `scenario-v1` and the other
  stream keys listed under [Concepts](#concepts-and-data-structures).
- **`stats.json` is per run**; parts mode writes `stats.session.json`; use `scripts/analyze.py` for totals.
- **The VM path.** The team never ran the sim on the 8 GB Mac (`scripts/vm.sh` header); agents ask the user before
  running sim tests or generation. `scripts/vm.sh` needs `~/.jev-local/azure_hosts` and `~/.ssh/jev_azure`, which are
  not in the repo. `scripts/vm.sh run sim` rsyncs with `--delete` but
  excludes `/sim/out/` and `dist/`, so outputs survive and builds must be redone on the VM. On the VM the repo is at
  `~/gcl/sim`, so outputs land in `~/gcl/sim/sim/out/...` (the paths `training/import_*.sh` use).
- Exploration answers a fake diagnosis (`meta.fake_diagnosis: true`) when forcing a non-passive action on an
  `expected` situation; later rows of that trajectory can contain the effects of explored actions
  (`meta.explored_before`).
- **Non-parts vs parts determinism.** Non-parts mode hands out 2-seed batches on demand, so which seeds near the end
  are included depends on worker scheduling. Parts mode uses fixed seed ranges (`seed + i*chunk`), so finished
  parts are reproducible; only how many parts finish before `--rows` is reached varies.
- **`analyze.py` prefers merged files.** It reads `<dir>/<split>.jsonl` when present and only falls back to
  `parts/part-*.<split>.jsonl`; after a `merge-b`, newer parts are ignored until you merge again.
- **`benign` noise count quirk.** `make()` loops `for (i = 0; i < rng.int(0, 2); i++)`, re-drawing the bound every
  iteration, so `noise:0/1/2` occur with p 1/3, 4/9, 2/9 (not uniform). Fixing it changes every benign world.
- **Slug-id programs (idStyle slug, weight 1/9).** The sim's `sigOf` keeps slug ids literal, so for those programs
  failure `streak`s are per item and the request rule's `clientRate(network, sigOf(op))` (compared against route
  signatures with `:id`) never matches item URLs; since `anomaly: "storm"` never reaches an op, such item requests are
  never diagnosed `overload` by the request rule.
- **Ideal run and futures.** The ideal run has no decider, so `future.k = -1` only moves external events; ideal
  network draws are trivially 0. The ideal run is re-done per future only when an external event lies after `t_k`.
- **The cost's initial state** for both runs is the *real* run's first snapshot (`runCost`), and the window ends at
  `min(tEnd, t_k + 15000, real.tStop)`; relation areas and `area` use the 10 s horizon, finals use `stop`.

## How to change it safely

Before any change: read the matching test in `sim/test/`. After it (ask the user first;
[where to run things](runtime/build-test-release.md#where-to-run-things)), the team ran on the VM:
`npm run build:runtime-core && npx tsup`, `SIM_RUNTIME=real npx vitest run`, `node dist/smoke.js --seeds 40` (check `internal errors`, correlation
`*:none` counts), then a small `gen.js` run and `analyze.py`.

1. **Add a feature combinator.** New `sim/src/app/features/<kind>.ts` exporting a `FeatureDef`; register in
   `FEATURES` and `FEATURE_WEIGHTS`. Server routes via `srv.route(method, naming.route(...), handler, {feature, kind,
   idempotent, resource})` (resource `c:`/`d:`/`n:` keys enable replica lag). Client: `env.store(name, s.id, init,
   {weights, resync})`, requests only via `kit.op` + `kit.call`, writes only via `kit.write` with `role`, `intent`,
   `key`, `op`; set `dupOf` for accidental repeats, `anomaly: "partial"` on writes of paths that skip derived fields
   (an `anomaly` passed to `kit.op` is silently dropped: `OpInit` has no such field; add it to `OpInit` and `Kit.op`
   if an op-level anomaly is needed), `classify`
   where content bookkeeping (`ContentBook`) decides stale/conflict/duplicate; declare `relations()` for derived
   fields; `cond()` for `pendingCond` re-clicks. Surface failures with `kit.shownError()` (charged as an error
   episode) or `kit.spawn(fn, "uncaught", {cause, diagnosis, op})` (becomes an `error` trigger); use `"swallow"` for
   handled background work. Add new data roles to `DATA_ROLES`. Consider adding a held-out pattern to
   `TEST_PATTERNS`. Every seed's world changes: regenerate all data and samples.

   *Adding a knob to an existing feature:* append the draw at the end of `make()` if you can: draws come from one
   stream (`rf.fork("make")`), so inserting one in the middle shifts every later knob of that feature. A new
   `naming.field(role, scope)` call draws from the program-wide naming stream (`rP.fork("naming")`, shared by all
   features of the program), so it also changes field names picked later by other features. New tags in
   `pattern()` change `meta.patterns` and possibly the test split (via `TEST_PATTERNS`).
2. **Add or edit a domain.** Append `D(...)` in `sim/src/app/vocab.ts` (2 entities via `E(...)`); hold it out via
   `TEST_DOMAINS` if desired. Changes every seed's domain pick.
3. **Change cost weights (`W`).** Totals change; regenerate data. Re-check `sim/test/oracle.test.ts` and the README
   formula. Changing only `LABEL` (premiums, tie, tau) can be re-derived offline from `meta.cost_futures` with
   `actionLabel` (same pairing), without re-simulating; re-apply any option drop recorded in `meta.transform`
   (`drop:<action>`), because `cost_futures` keeps every offered action.
4. **Change a diagnosis rule.** Edit `diagnose`/`diagnoseFailure` or a feature's `classify`; diagnosis does not
   affect costs, but it affects exploration (`eps` vs `eps/4`), point sampling (x1.5) and `fake_diagnosis`, so action
   rows can change too. Update oracle tests' expected diagnoses.
5. **Change chaos or network behaviour.** `makeNet` (parameters) and `Network.send` (mechanics). Keep every draw
   keyed (`Rng(hashAll(seed, [salt,] ...))`), keep ideal-mode draw counts stable, and keep `NetEntry.cause` /
   `slowCause` accurate: diagnoses read them.
6. **Add an ask question.** Add a generator to `GENS` in `sim/src/ask/questions.ts` returning `{qid, question, label,
   kind}`; check the evidence appears in `text` (the serialized state) and skip borderline timings; labels must be
   valid for the question type (`rows.test.ts` checks this).
7. **Change budgets.** `budget` weights in `buildScenario`; keep `meta.budget`; coordinate with TRAIN (per-budget
   eval in `training/eval_runtime.py`) and the runtime's auto budgets.
8. **Change the runtime contract** (option names, thresholds, hooks). Edit `createOptions` and the structural types
   in `rt.ts`/`types.ts`; run `SIM_RUNTIME=real` tests (the two real-only oracle tests and the determinism suite).
9. **After any runtime situation change** (`packages/runtime/src/situation/*`): rebuild the runtime core, regenerate
   all datasets and `sim/samples/*` (`node dist/gen.js --sample --workers 8`), tell TRAIN (and update
   `training/curriculum/rt.py` mirrors). Data trained so far uses tag `situation-v1`.
10. **Produce final data.** `bash sim/scripts/final.sh a` (600k rows, seeds from 10,000,000, `out/final-a`);
    `bash sim/scripts/final.sh b` (1.4M rows, seeds from 50,000,000, parts of 100 seeds, resumable after the 03:00 UTC
    VM shutdown); `final.sh merge-b`. To split across machines give disjoint seed ranges (phase A: about 5.8 rows
    per seed, counting test-subsampled seeds).
11. **Change splits.** Edit `TEST_DOMAINS`, `TEST_PATTERNS`, or the salts/percentages in `familyHeldOut` / `splitOf`.
    This moves whole trajectories between splits, so previously generated datasets become incomparable; rerun
    `rows.test.ts` (split counts over 400 seeds) and regenerate.

## Tests

(Ask the user first; [where to run things](runtime/build-test-release.md#where-to-run-things).) The team ran on the
VM: `cd sim && SIM_RUNTIME=real npx vitest run` (17 tests; without `SIM_RUNTIME=real` the suites use the
fake runtime and the two real-only tests are skipped).

| test file | test | what it asserts |
|---|---|---|
| `sim/test/loop.test.ts` | orders macrotasks / drains microtasks | (time, seq) order; microtask chains and `afterTask` hooks run before the next macrotask; `now` ends at `tEnd` |
| | Response bodies within one macrotask | `Response.clone().json()` settles before the next macrotask |
| | keyed rng forks | `fork(label)` independent of prior draws |
| `sim/test/determinism.test.ts` | same seed -> identical rows | seeds 11-13: identical rows, 0 `prefix-mismatch`, identical final client/server state and `fp` lists |
| | replay reproduces every prefix | seeds 100-129, skipping bases with < 2 decisions (no new seed once >= 12 checks): forcing each action at decision indices 0, mid and last reproduces all `fp <= k`; asserts > 5 checks |
| `sim/test/rows.test.ts` | valid CONTRACT-D rows | 40 trajectories: no base errors, no prefix mismatch, > 40 rows, ask + >= 2 other triggers, labels reference offered options, dists sum to 1, no `x-request-id` text, passive best on > 20% of decision rows |
| | splits and transform | 400 seeds: > 40 test, > 150 train; transform keeps passive and best, renormalises the dist over remaining options |
| `sim/test/oracle.test.ts` | stale overwrite | search without guard: diagnosis `stale`, `discard` cheapest and label best |
| | one stale write among later stale writes | discarding one write still cheaper than apply; best in `discard`/`defer` |
| | intentional double add | counter increment: request diagnosis `expected`, `send` cheapest, `coalesce` > send + 1 |
| | duplicate POST after committed timeout | form retry without key: `duplicate`; `block`/`coalesce` beat `send` |
| | outage failure streak | poll during 503 outage: request diagnosis `failing`; `delay`/`serve_cached` beat `send` |
| | benign concurrency | cart server mode, two adds: `expected`, best `apply` |
| | label sharpness | `actionLabel`: sharp (> 0.95 non-passive) when futures agree, soft (passive > 0.15) when they disagree, passive > 0.9 when interventions slightly harmful |
| | exact ties | ties -> passive (> 0.95); dist sums to 1 |
| | (real only) partial-update invariant break | cart `skip-rollback` + outage: inconsistency diagnosis `inconsistent`; `rollback`/`resync` beat `ignore` |
| | (real only) duplicate token refresh | auth per-request refresh: request `duplicate`; `coalesce` beats `send` |

Helpers (`sim/test/helpers.ts`): `testFactory`, `mini(kind, patch, opts)` (one-feature calm scenario with exact
latencies via `latencyFn`, optional outages), `step`, `runBoth`, `argmin`, `find`. `mini` = `buildScenario(4242,
{kinds:[kind], chaos:"calm", duration: opts.duration ?? 6000, domain: opts.domain ?? "commerce"})` with `patch`
merged into the spec, scripted steps (feature `f0`), no external events / ask probes / vocabulary overrides,
`tEnd = duration + 3000`, latencies read 80 / write 120 / auth 80 / upload 300 / bulk 200 ms with sigma 0, and no
spikes, transients, network errors, slow periods, bugs, rate limits, capacity or replica lag. Trajectory tests use
`maxPoints` 3 (determinism) or 4 (rows), `askRows: true`, `testKeep: 1`, `exploreScale: 1`.

### Sample stats (`sim/samples/`)

- `stats-final-a.json` (phase A, frozen runtime, seeds from 10,000,000, 56 workers): 600,676 rows (train 448,420 /
  dev 14,613 / test 137,643), 104,116 trajectories (32,729 skipped by test-subsample), 2,401,160 runs, 2,443.8 s,
  245.8 rows/s, 937 families, drops only `diagnosis-not-in-vocab` 4,219, 0 errors.
- Trigger mix: ask 23.8%, mutation 23.3%, request 17.2%, failure 14.7%, stall 9.1%, inconsistency 5.5%, error 3.6%,
  transition 2.8%. Most stall/error and a third of transition rows are diagnosis-only.
- Passive best (train): mutation 88.1%, request 74.3%, failure 70.4%, stall 64.0%, inconsistency 83.8%, transition
  85.9%, error 99.0%.
- Train diagnoses: mutation expected 49.8 / stale 17.5 / duplicate 14.1 / conflict 9.7 / inconsistent 8.4 / unusual
  0.5%; failure transient 53.6 / failing 39.1 / slow 5.8 / overload 1.5%; inconsistency expected 90.7 / inconsistent
  9.3%; stall slow 90.7 / failing 9.2%; request expected 70.9 / duplicate 16.9 / failing 10.0 / overload 1.4 /
  stale 0.8%; transition expected 43.9 / failing 30.0 / transient 13.5 / unusual 6.1 / slow 6.1 / overload 0.3%;
  error failing 94.8 / overload 4.1 / slow 0.7%.
- Per budget (state chars p50/max): 1000 -> 994/1069; 2000 -> 1854/2132; 3200 -> 2438/3387. Token estimate
  (chars/3.6 of state+questions) p50 726, p99 1206, max 1262 (an estimate only: TRAIN measured ≈ 2.4 chars/token
  with the runtime's pruned tokenizer, training/NEEDS.md 6a, so real counts are ≈ 1.5× higher). Rows per budget: 1000: 180,010; 2000: 180,232;
  3200: 240,434.
- Labelled points: 389,393 (all correlated), 29.9% after exploration; 3,464,871 decisions seen in base runs.
  Points with 3 futures (adaptive): failure 43%, request 54%, stall 66%, mutation 19%, inconsistency 22%,
  transition 26%, error 2%. Label sharpness (`label_sharpness`): passive-best rows with passive mass >= 0.9:
  mutation 93%, request 68%, failure 87%, stall 71%; intervene-best rows with non-passive mass >= 0.95: mutation
  57%, request 32%, failure 60%, stall 52%, inconsistency 66%.
- Ask questions asked (phase A): `write_inflight` 33,851, `route` 33,826, `pending_count` 33,576, `any_inflight`
  33,559, `user_waiting` 32,773, `user_recent` 30,993, `recent_failure` 30,314, `fail_count` 27,996, `last_failed`
  22,409, `last_save` 4,271, `slowest` 1,835.
- `sample-stats.json` (`--sample`, seed 1000, 8 workers): 994 rows (train 630, test 364; no dev), 116 trajectories.

## Drift and open issues

- **README limitation 5 is stale.** It says `conflict` rows are under 1% of mutation rows because the runtime does
  not flag a remote write over a pending local change (NEEDS f). The runtime now has the pending-local-change fact
  (`packages/runtime/src/situation/facts.ts`; STATUS "SIM requests a-f: DONE") and phase A has `conflict` on 9.7% of
  train mutation rows.
- **`sim/NEEDS.md` is stale.** Observations a-f are still listed as ASK (STATUS: all done in batch 3); the note that
  `transient` is missing from the runtime's `DEFAULT_DIAGNOSES` is false (it is there, last), so the fallback in
  `realRuntimeFactory` is inactive. Its header's `createRuntime` options (no `websocket`, thresholds 0) differ from
  `createOptions` (websocket on, guard/heal 0.5, `model: false`, `historySize: 500`).
- **README "every [ask] generator checks that its evidence appears in the situation text"**: only `last_failed`,
  `route` and `slowest` check the text; `recent_failure`, `fail_count`, `user_waiting`, `user_recent` skip
  borderline timings; `write_inflight`, `any_inflight`, `pending_count` (skips > 6), `last_save` check nothing.
- **README "calm warm-up of 30-60%"**: only windowed chaos respects it (see gotchas).
- **README limitation 6** ("genuine relation breaks ... about 4% of mutation rows"): phase A has 8.4% of train
  mutation rows labelled `inconsistent` (from `anomaly: "partial"` writes, not a relation check).
- **README cost formula omits the caps** in `serverDist` (5 extra/missing and 5 changed items per collection, 3
  fields per doc, 3 units per counter, `*beats` counters ignored). It also does not say that the latency term is
  absolute (unlike the error and wasted-request terms, it is not relative to the ideal run).
- **Code comments:** `rt.ts` header says the fake runtime lives in `test/fake-runtime.ts` (it is
  `src/run/fake-runtime.ts`); `NetEntry.simOp` mentions an `x-sim-op` header (renamed to `x-request-id` after
  `situation-v1`); `gen.ts` header shows `--test-keep 0.5` and "~12" examples (defaults 0.33 and up to 16) and omits
  `--parts/--chunk/--merge-only`; the `diagnoseFailure` comment says a spike-caused timeout is `transient` (code:
  any timeout outside a slow period/overload is `slow` once streak >= 2, else `transient`); `Persona.typoP` says
  "per word" (code: `typoP/6` per non-space character).
- **Slug ids:** the `server.ts` comment in `Db.makeId` ("the runtime does not treat it as an id") and NEEDS
  observation e predate batch 3; the runtime's `isSlugId` (`packages/runtime/src/util.ts`) now normalises slug ids
  whose suffix starts with a digit or alternates letters/digits twice (STATUS "e"), so only part of the sim's
  slug-id programs keep per-item signatures.
- **Poll `storm` anomaly never reaches the oracle (code bug).** `sim/src/app/features/poll.ts` passes
  `anomaly: "storm"` to `kit.op` for tight retries, but `sim/src/app/kit.ts` -> `Kit.op` copies only the `OpInit`
  fields, so `SimOp.anomaly` is never set. The README ("overload (storm code path, ...)"), the `diagnoseFailure`
  comment and the three `anomaly === "storm"` checks in `diagnose.ts` assume it is. Fixing it changes diagnoses (and,
  through exploration and point sampling, action rows) of tight-poll programs: regenerate data.
- **`RunOptions.explore` doc comment** in `runner.ts` ("Decisions >= this index take the passive action") describes
  counterfactual futures, not the exploration policy it annotates.
- **README flag list** omits `--parts`, `--chunk`, `--merge-only` (only `final.sh b` mentions parts mode) and says
  "about 5.7 rows per trajectory" (phase A: 5.77 rows per seed incl. test-subsampled seeds, 8.4 per simulated
  trajectory).
- **CONTRACT §11** asks to randomise diagnosis paraphrases/subsets "per row"; the sim does it per trajectory
  (scenario) through the runtime's `vocabulary`, and only option order/subset is per row (`transformQuestions`).
- **`docs/runtime/ARCHITECTURE.md`** lists "uploads" among the 15 combinators; there is no upload feature (`upload`
  is only a latency kind no route uses).
- **CONTRACT §11** calls the ideal world "serial"; the sim's ideal run is zero-latency and failure-free, not
  explicitly serialised.
- **training/NEEDS.md item 3** (marked DONE there) asks for `meta.passive`, `meta.program_family`, `meta.action_names`; the sim emits
  `meta.family` (program family) and `meta.tiers`, no `passive` (derive from `PASSIVE`), no `action_names` (option
  keys are never renamed). Item 4 (clean-run rows, `meta.clean`) is not implemented.
- **Budgets:** the runtime's auto budget also yields 1,333 / 1,667 (2-3 WASM threads); the sim samples only 1000 /
  2000 / 3200.
- **Sim changed after the freeze tag:** `git diff situation-v1 HEAD -- sim/src` shows the header rename, thresholds
  0 -> 0.5, budget 1100 -> 1000, parts mode. `packages/runtime/src` is unchanged since the tag (only the runtime's
  README, package.json, LICENSE and a smoke test changed). `stats-final-a.json` `args` lack
  the parts keys, so phase A ran on a `gen.js` before parts mode (exact commit unverified).
- **Dead code:** `u01`, `keyedLognormal` (`rng.ts`), `relationMatches` (`diagnose.ts`), `searchLabel`, `listKey`,
  `sleepJitter`, `ROUTE_WORDS`, `Network.committedBefore`, `Knowledge.inflight`, `Knowledge.appliedReadStart`;
  `Knowledge.localChange` and `errorList` are written but never read; `runCost` has a no-op ternary
  (`real.tStop <= stop ? real.server : real.server`).
- **Label-quality limitations** (README "Known limitations", still accurate unless noted above): only K = 3 futures
  (noisy SE; `meta.cost_futures` allows re-derivation); the failure-free ideal can be unreachable after a real
  failure; diagnosis and action are labelled independently (e.g. `expected -> coalesce`, kept passive by the
  runtime gate); `defer` is scored as defer-then-apply; thin classes (transitions about 3% of rows); token lengths
  are estimates; ask labels are imbalanced (phase A: `q_user_waiting` 92% "no", `q_write_inflight` 71% "no").
- **Open work (OPEN_TASKS.md):** phase B (1.4M rows) in progress, resumable; training round 2 uses phase A + B.

## Related docs

- [model-io-contract.md](model-io-contract.md): row -> packed request -> heads -> calibrated answers.
- [training.md](training.md): how rows are imported (`training/import_final.sh`), trained on and evaluated.
- [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md): the facts, triage and serializer that
  produce every `state` the sim records.
- [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md): the gate the forced actions pass through.
- [runtime/observe-and-trace.md](runtime/observe-and-trace.md): ops, `opCreated`, causality used for correlation.
- [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md): `createRuntime` options.
- [runtime/build-test-release.md](runtime/build-test-release.md): VM workflow, how `sim` consumes the runtime build.
- [demos.md](demos.md): the independent external test (never modelled by the sim).
- [status-and-known-issues.md](status-and-known-issues.md), [glossary.md](glossary.md), [repo-map.md](repo-map.md).
- Source docs: [../../sim/README.md](../../sim/README.md), [../../sim/NEEDS.md](../../sim/NEEDS.md),
  [../runtime/CONTRACT.md](../runtime/CONTRACT.md) §11 and §13.
