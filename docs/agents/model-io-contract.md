# Model I/O contract: situation text -> packed request -> model heads -> calibrated answers (runtime, sim and training)

> **Scope:** `packages/runtime/src/situation/{serialize,questions,build,describe,env}.ts`, `packages/runtime/src/model/{packer,serialize,tokenizer,calibrate,engine,protocol,loader}.ts` (+ `pyutil.ts`), the model seam of `packages/runtime/src/types.ts`, `sim/src/ask/questions.ts`, `sim/src/gen.ts`, `sim/src/gen/*.ts`, `sim/src/oracle/cost.ts` (+ `sim/src/run/transform.ts`, `sim/src/run/rt.ts`), `training/export_runtime.py`, `training/eval_runtime.py`, `training/curriculum/{fmt,rows}.py` (+ `rt.py`), `packages/runtime-model/MODEL_CARD.md`, the example situations in `packages/runtime/STATUS.md`. Python reference counterparts in `jev_local/` and `scripts/genclass_export.py` are cited where they define the other side of the contract.
> **Read this when:** you change any text the model reads (facts, subject sentences, timeline/state/stats lines, question instructions, option descriptions, diagnosis labels, budgets); you change the packer, tokenizer, feeds, heads or calibration; you change how the sim labels rows or how training reads them; you export or ship a model directory; you need to know whether a change forces regenerating data and retraining.
> **Source of truth:** the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

## TL;DR

- One pipeline, three consumers. The **runtime** builds a situation (`JevState` + typed questions). The **model host** packs it into token ids, runs the ONNX graph and calibrates the logits into answers. The **sim** records the same `state`/`questions` verbatim from the real runtime, attaches labels, and **training** packs them with the Python reference (`jev_local`). Every step on the TypeScript side is a byte-exact port of the Python step. That makes train/serve parity a hard invariant.
- The **situation** is a 7-key object in fixed order: `app, trigger, facts, in_flight, timeline, state, stats`. Each value is a string or an array of strings (one line each). Empty arrays become `"none"`. It is sized by a **character budget** (`STATE_CHAR_BUDGET` 3,200; compact 1,100; floor 500) and shrunk deterministically (`toJevState`).
- **Questions** are Jev-wire objects `{type, instructions, criteria}` of kind `choice | noul | score`. Standing qids are `diagnosis` (always, except on `ask`) and `action` (only when ≥ 2 actions apply). Qids are never shown to the model. At budgets ≤ 1,400 chars, options are bare labels (`null` descriptions, called **compact questions**).
- **Diagnosis labels (10, in order):** `expected, stale, conflict, duplicate, inconsistent, failing, slow, overload, unusual, transient`. **Actions:** 15 built-ins, 7 trigger kinds, passive first: `apply|send|deliver|wait|ignore` are passive.
- **Packing:** `[CLS] key: text [SEP] … | [Q] header [O] item … | [Q] …`. Positions restart per question branch and per item. `q_group`/`i_group` drive block attention, so options and questions are isolated: option order and unrelated questions cannot change an answer. Limits: positions (state + longest single branch) ≤ `meta.max_len` (default 1536), total ≤ `meta.max_total` (default 8192).
- **Heads → answers:** raw logits (τ = 1) per question → calibration (`calibration.json`: by-header, then by-bucket, then τ(K), then per-kind temperature; or Platt for noul) → `Answer` (`choice`, `confidence`, `probabilities` in criteria order). The runtime gate reads only `probabilities` and the diagnosis `choice`.
- **SIM labels:** `action` is a soft distribution from **counterfactual costs**. The sim re-runs the scenario with each action forced, over up to 3 paired futures, adds a tier premium and a tie rule, then takes `p ∝ exp(−gap/τ)`. `diagnosis` is a hard label from the sim's own knowledge. `ask` rows get exact noul/score/choice labels.
- **Model directory** (`export_runtime.py`): `model.json` (card `genclass-runtime-model/1`, bytes + sha256), `<name>-q8.onnx` (WASM), `<name>-fp16.onnx` (WebGPU + `shader-f16`), `tokenizer.json`, `calibration.json`, `meta.json`, and parity fixtures.
- **Freeze:** tag `situation-v1` (commit 1a77558) froze the situation format. `git diff situation-v1 HEAD -- packages/runtime/src jev_local scripts/genclass_export.py` is empty at 654d822. Any change to text, questions, vocabulary, budgets, packing, tokenizer or labels needs regenerated SIM data (and the `rt.py` port) plus retraining.

## Files

| path | role | key exports / entry points |
|---|---|---|
| `packages/runtime/src/situation/build.ts` | Assembles a situation: subject sentence, facts, in-flight, timeline, state, stats, applicable actions, standing questions, triage flag | `buildSituation`, `subjectOf`, `subjectRef`, `isTrigger`, `BuildOptions`, `BuiltSituation`, `ActionOption` |
| `packages/runtime/src/situation/serialize.ts` | Budget-shaped `JevState` (key order, section and line limits, shrink order) | `toJevState`, `sectionLimits`, `stateChars`, `stateText`, `STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `MIN_BUDGET`, `LIMITS`, `SituationParts`, `SectionLimits` |
| `packages/runtime/src/situation/questions.ts` | Action catalogue, per-trigger actions/passive/instructions, diagnosis vocabulary, standing-question builder | `BUILTIN_ACTIONS`, `BuiltinAction`, `TRIGGER_ACTIONS`, `PASSIVE`, `ACTION_INSTRUCTIONS`, `DIAGNOSIS_INSTRUCTIONS`, `DEFAULT_DIAGNOSES`, `COMPACT_QUESTIONS_BUDGET`, `diagnosisVocabulary`, `actionDescription`, `buildQuestions` |
| `packages/runtime/src/situation/describe.ts` | How ops/events are named in subject sentences, facts and timeline lines | `opPhrase`, `opLabel`, `userPhrase`, `statusText`, `eventLine` |
| `packages/runtime/src/situation/env.ts` | Read-only view of the runtime used by situation building; subject specs per trigger | `SitEnv`, `SubjectSpec`, `ReqMeta`, `FailureInfo`, `Violation`, `ErrorInfo` |
| `packages/runtime/src/situation/facts.ts` | (out of scope, see [learn-situation-triage.md](runtime/learn-situation-triage.md)) fact computation and ordering | `computeFacts`, `orderFacts`, `MAX_FACTS` |
| `packages/runtime/src/util.ts` | Formatting helpers that appear in the text (`secs`, `rel`, `fmtNum`, `truncate`, `describe`, redaction) | `secs`, `rel`, `truncate`, `describe` |
| `packages/runtime/src/types.ts` | Model seam types (CORE + MODEL change together; the file's "model seam" section) plus the situation/plugin types the text depends on | `JevState`, `Question`, `Answer`, `AnswerOf`, `NoulAnswer`, `ChoiceAnswer`, `ScoreAnswer`, `TriggerKind`, `ModelStatus`, `EvaluateRequest`, `DecisionProvider`, `SubjectRef`, `Situation`, `SituationDraft`, `Fact`, `FactKind`, `Vocabulary`, `StandingQuestion`, `ActionDef`, `Tier` |
| `packages/runtime/src/model/serialize.ts` | Port of `jev_local/serialize.py`: state segments and question blocks with Python-after-JSON value semantics | `stateSegments`, `segmentText`, `questionBlock`, `questionEntries`, `entryText`, `toJsonValue`, `pyJson`, `criteriaEntries`, `stateText`, `MAX_ARRAY_SEGMENTS`, `DEFAULT_NOUL_INSTR`, `DEFAULT_CHOICE_INSTR`, `DEFAULT_SCORE_INSTR`, `QBlock`, `Segment`, `BlockKind`, `WireQuestion` |
| `packages/runtime/src/model/pyutil.ts` | Python formatting semantics (`str.strip`, float `repr`, `round`) | `pyStrip`, `pyNumber`, `pyFloatRepr`, `pyRound`, `clip01` |
| `packages/runtime/src/model/tokenizer.ts` | Byte-level BPE over a HF `tokenizer.json` (`encode_special_tokens = True` semantics) | `Tokenizer`, `bytesToUnicode`, `TokenizerJson` |
| `packages/runtime/src/model/packer.ts` | Port of `jev_local/engine/encoder/tokenize_pack.Packer` (FastEngine length semantics) + ONNX feed plan | `Packer` (`pack`, `measure`, `encode`, `stateIds`), `PackerOptions`, `MARKERS`, `Marker`, `STATE` (= −1), `Packed`, `PackedQuestion`, `planInputs`, `unpackLogits`, `FeedPlan`, `HeadOutput` |
| `packages/runtime/src/model/engine.ts` | Packer + ORT session + calibration → answers; builds exactly the inputs `meta.json` declares | `Engine` (`evaluate`, `logits`, `release`), `EngineOptions`, `FEEDS`, `ModelMeta`, `EngineResult`, `tensorFloats`, `OrtLike`, `OrtSessionLike`, `OrtTensorLike` |
| `packages/runtime/src/model/calibrate.ts` | Port of `jev_local/engine/encoder/calibrate.py` lookup and `jev_local/confidence.py` answer math | `Calibration`, `parseCalibration`, `headerKey`, `kBucket`, `tauFor`, `noulAffine`, `calibrateLogits`, `buildAnswer`, `Precision`, `normalizeProbs`, `choiceConfidence`, `scoreConfidence`, `K_BUCKETS`, `BUCKET_CLAMP` |
| `packages/runtime/src/model/protocol.ts` | Main thread ↔ worker messages (`state`, `questions` only; trigger/subject never cross). `evaluate` and `measure` requests; one `result` per id | `ToWorker`, `FromWorker`, `EvaluateOk` |
| `packages/runtime/src/model/loader.ts` | Model card parsing, plan order, downloads with sha256 | `parseCard`, `CARD_FORMAT`, `DEFAULT_CACHE_NAME`, `cardId`, `planOrder`, `fetchFile`, `fetchCard`, `ModelCard`, `FileSpec`, `VariantSpec`, `FileRole`, `Plan` |
| `sim/src/gen.ts` | CLI: worker pool, shard merge, `stats.json`, `--sample` | `main`, `mergeParts` |
| `sim/src/gen/trajectory.ts` | One scenario → decision rows, diagnosis-only rows, ask rows; counterfactual costs | `generateTrajectory`, `pointCosts`, `GenOptions`, `PointStat`, `TrajectoryOut` |
| `sim/src/gen/worker.ts` | Worker thread: writes `shards/<split>.w<id>.jsonl` or `parts/part-NNNNNN.<split>.jsonl` | (module) |
| `sim/src/gen/examples.ts` | `sim/samples/EXAMPLES.md` renderer | `renderExamples` |
| `sim/src/oracle/cost.ts` | Run cost vs the ideal run; soft action label | `W`, `LABEL`, `TIER`, `runCost`, `actionLabel`, `clientDist`, `serverDist`, `valueDist`, `divergenceArea`, `relationViolation`, `CostBreakdown`, `ActionLabel` |
| `sim/src/oracle/diagnose.ts` | (detail in [sim.md](sim.md)) hard `diagnosis` label from the sim's knowledge | `diagnose`, `diagnoseFailure` |
| `sim/src/world/scenario.ts` | (detail in [sim.md](sim.md)) scenario seed → domain, budget, ask times, vocabulary paraphrases, split | `buildScenario`, `splitOf`, `TEST_DOMAINS`, `TEST_PATTERNS`, `DEFAULT_DIAGNOSES` |
| `sim/src/ask/questions.ts` | Programmatic `ask` questions with exact labels | `askQuestions`, `AskQ` |
| `sim/src/run/transform.ts` | Post-transform of recorded questions (shuffle/drop action options); action paraphrases | `transformQuestions`, `ACTION_PARA` |
| `sim/src/run/rt.ts` | Options the sim passes to `createRuntime` | `createOptions`, `realRuntimeFactory` |
| `sim/src/types.ts` | Sim mirror of the seam + row schema | `Row`, `Label`, `PASSIVE`, `DIAGNOSES` |
| `training/curriculum/rows.py` | Stage-1 curriculum rows (decision / ask), varied style or runtime-exact | `decision_row`, `ask_row`, `situation_state`, `action_question`, `diagnosis_question`, `RENAMES` |
| `training/curriculum/fmt.py` | Surface variation (key names, time formats, paraphrase templates with held-out tails), vocab copies | `Style`, `TEMPLATES`, `ACTION_DESC`, `DIAG_DESC`, `TRIGGER_ACTIONS`, `TIER`, `DISTRACTOR_ACTIONS`, `js_numbers`, `pick_from` |
| `training/curriculum/rt.py` | Python port of the runtime's situation text (frozen wording) for runtime-exact curriculum rows | `render`, `to_state`, `section_limits`, `DIAGNOSES`, `ACTIONS`, `ACTION_INSTR` |
| `training/curriculum/generate.py` | (detail in [training.md](training.md)) curriculum CLI: row ids, `js_numbers`, validation through the trainer's own parser | `make_row`, `_validate`, `work`, `main` (`--p-runtime` → env `GC_P_RUNTIME`) |
| `training/prune_vocab.py` | (detail in [training.md](training.md)) prunes the ettin tokenizer to the shipped `tokenizer.json` (16,000 merges) | — |
| `training/eval_runtime.py` | Accuracy, calibration fit (`calibration.json`), §8 gate metrics | `fit_calibration`, `decision_metrics`, `question_metrics`, `main` |
| `training/export_runtime.py` | Checkpoint → ONNX q8/fp16 + model directory + parity fixtures | `make_q8`, `make_fp16`, `quantize_embedding`, `gemm_to_matmul`, `requests_from_rows`, `main` |
| `jev_local/serialize.py`, `jev_local/engine/encoder/tokenize_pack.py`, `jev_local/engine/encoder/calibrate.py`, `jev_local/engine/encoder/heads.py`, `jev_local/train/train.py` | Python reference: serialization, packing, calibration, heads, label → target | `state_segments`, `question_block`, `Packer.pack`/`pack_split`, `header_key`, `DecisionHeads`, `parse_target`, `encode_example` |
| `scripts/genclass_export.py` | ONNX graph definition and feed plan (imported by `export_runtime.py`) | `ExportModel`, `plan_inputs`, `unpack` |
| `packages/runtime-model/MODEL_CARD.md` | Model card (only file in that package today) | — |
| `packages/runtime/test/fixtures/model/` | Parity fixtures for the TS ports: `py_fixtures.json` (made by `make_py_fixtures.py`: `serialize`, `tokenize`, `pruned`, `calibrate`, `confidence` sections), v0.1 `requests50.json` / `pack_fixtures.json` / `torch_fixtures.json`, `make_webgpu_variants.py` (WebGPU embedding-encoding variants) | read by `test/model/helpers.ts` |
| `packages/runtime/STATUS.md` ("Example situations") | Real rendered situations: the same stale write at 1,000 chars (998, compact questions) and 2,000 chars (1,494); one full-budget situation per trigger (mutation, request, failure, stall, inconsistency, transition, error) | copied from `test/budget.test.ts` / `test/situation.test.ts` |

## Concepts and data structures

Terms used here beyond the shared terminology (see [glossary.md](glossary.md)):

- **Wire request**: `{state, questions}`, the only thing the model host uses. `EvaluateRequest.trigger`, `subject`, `priority` and `timeoutMs` are scheduling/test metadata and never reach the packer (`protocol.ts` -> `ToWorker` carries only `state`, `questions`).
- **Segment**: one `key: text` unit of the state (`model/serialize.ts` -> `Segment`). **QBlock**: one question rendered as `header` + `items` + `labels`.
- **Header**: the question's `instructions` text. **Item**: one option (choice), level (score), or the true/false criterion (noul).
- **Marker**: special token `[Q] [O] [L] [T] [F]` whose hidden state feeds a head. **Branch**: state + one question's header + one of its items (what `max_len` bounds).
- **Raw logits**: head outputs at τ = 1. **Header key**: `sha1(header)[:12]`, the key of `calibration.json.by_header`.
- **Compact questions**: options with `null` descriptions when the situation budget ≤ `COMPACT_QUESTIONS_BUDGET` (1,400).
- **CONTRACT-D row**: one JSONL training example `{id, split, family, state, questions, labels, meta}`.
- **Counterfactual cost**: cost of a re-run with one action forced at a decision point, measured against the ideal run (`sim/src/oracle/cost.ts` -> `runCost`). **Future**: one re-seeded continuation after the decision (common random numbers across actions).
- **Tier premium / tie rule**: label-time adjustments that favour passive (`LABEL` in `cost.ts`).

### Seam types (`packages/runtime/src/types.ts`)

```ts
type JevState = Record<string, unknown>;
type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };
interface NoulAnswer   { type: "noul"; noul: number }                       // calibrated P(true)
interface ChoiceAnswer { type: "choice"; choice: L; confidence: number; probabilities: Record<L, number> }
interface ScoreAnswer  { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
interface EvaluateRequest { trigger: TriggerKind; state: JevState; questions: Record<string, Question>;
                            priority?: number; subject?: SubjectRef; timeoutMs?: number }
interface DecisionProvider { readonly status: ModelStatus; ready(): Promise<void>;
  evaluate(req: EvaluateRequest): Promise<Record<string, Answer>>; onStatus?(fn): () => void; dispose?(): void }
```

`Situation` (returned by `runtime.situation()`, built in `build.ts`): `trigger, subject, state, questions, actions` (passive first), `salient`, `facts` (all ordered facts, ≤ 12, **not** budget-trimmed), `compact`, `budget`. The model reads `state.facts`, which may be shorter.

Other `types.ts` shapes on the model path (`Vocabulary`, `StandingQuestion.question` and `ActionDef.description` change the text the model reads):

```ts
interface Vocabulary { diagnoses?: Record<string, string>;            // replaces the default label set (expected re-added, plugin labels appended)
                       actions?: Partial<Record<string, string>> }    // per-action description override
interface StandingQuestion { id: string; on: TriggerKind[]; question: Question;
                             always?: boolean /* consult even when not salient */; onAnswer?(a, ctx): void }
interface ActionDef { name; description; on: TriggerKind[]; tier?: "guard" | "heal" /* default heal */;
                      risk?; applicable?(sit: SituationDraft): boolean; run(ctx) }
type AnswerOf<Q> = /* noul → NoulAnswer; choice → ChoiceAnswer<keyof criteria>; score → ScoreAnswer */
```

- **salient** (`build.ts` -> `buildSituation`): `triage === "always" || trigger === "ask" || facts.some(f => !f.neutral)`. **forced**: some standing question for this trigger has `always: true`. Neither is model input.
- **`SubjectRef`** (`build.ts` -> `subjectRef`; never serialized, the model host ignores it): mutation `{mutation, store, paths, cause?}`; request/failure/stall `{op}`; transition `{op, paths, store?}`; inconsistency `{paths, store?, invariant?}` (first violation's text); error `{error: raw, op?}`; ask `{op?}` or `{store?}`.
- **`EvaluateRequest.priority`** is queue order only (`types.ts` comment: held writes/requests 2, background 0); see [decide-policy-actions.md](runtime/decide-policy-actions.md).

### Model-side structures (`packages/runtime/src/model/`)

| type | fields |
|---|---|
| `Segment` | `key` (`""` for a string state, object key, or `[i]`), `text` |
| `QBlock` | `qid`, `kind: "noul" \| "choice" \| "score"`, `header`, `items`, `labels` (choice labels in criteria order; score `"0".."n-1"`; noul `["true","false"]`) |
| `Packed` | `inputIds`, `positionIds`, `qGroup`, `iGroup`, `nState`, `qIndex: Map<qid, PackedQuestion>` |
| `PackedQuestion` | `kind`, `header`, `labels`, `qPos` (index of `[Q]`), `itemPos` (index of each `[O]`/`[L]`, or `[T]`,`[F]`) |
| `FeedPlan` | `choice {q, items, k}`, `score {q, items, k}`, `noul {q, t, f}` |
| `ModelMeta` (keys read) | `max_len`, `max_total`, `markers`, `cls_id`, `sep_id`, `inputs`, `outputs`; `name` only as the `Engine` fallback when no `name` option is passed (the backend always passes one); `pad_id` declared but unused |
| `Calibration` | `noul`, `choice`, `score` (τ > 0, default 1.0), `by_header`, optional `by_bucket`, `tau_k`, `noul_platt`, `bucket_clamp`, `version` |
| `ModelCard` | `format`, `name`, `version`, `license?`, `variants{name: {file, bytes?, sha256?, provider?, needs?}}`, `files{tokenizer, calibration, meta}` |

### Diagnosis vocabulary (`questions.ts` -> `DEFAULT_DIAGNOSES`, order is the option order)

| label | description (what the model reads at full budget) |
|---|---|
| `expected` | normal behaviour, nothing is wrong |
| `stale` | outdated data or an older operation is about to replace newer state |
| `conflict` | concurrent operations are competing over the same state or resource |
| `duplicate` | the same change or request is happening again without a new intent |
| `inconsistent` | the state contradicts itself or relationships it normally keeps |
| `failing` | an operation keeps failing or its failures follow a pattern |
| `slow` | an operation is far slower than usual |
| `overload` | work is being triggered far more often than usual |
| `unusual` | this differs from how the same operation normally behaves |
| `transient` | a one-off failure that is likely to succeed if tried again |

`diagnosisVocabulary(vocab, pluginLabels)`: `vocab.diagnoses` replaces the defaults. `expected` is always kept and moved first. Plugin labels are appended if their names are new. The header is always `DIAGNOSIS_INSTRUCTIONS` = `"What is happening here?"`.

### Actions per trigger (`questions.ts` -> `TRIGGER_ACTIONS`, `PASSIVE`, `ACTION_INSTRUCTIONS`, `BUILTIN_ACTIONS`; applicability in `build.ts` -> `builtinApplicable`)

| trigger | action header (exact) | actions, passive first | offered only when |
|---|---|---|---|
| `mutation` | What should the runtime do with this write? | `apply`, `discard`, `defer` | `defer`: the mutation was deferred < 2 times |
| `request` | What should the runtime do with this request? | `send`, `coalesce`, `delay`, `block`, `serve_cached` | `coalesce`: fetch and `env.canCoalesce`; `serve_cached`: GET and a cached response |
| `failure` | What should the runtime do with this failed request? | `deliver`, `retry`, `serve_cached` | `retry`: replayable, attempt < 4, fetch; `serve_cached`: GET, cached, fetch |
| `stall` | What should the runtime do with this slow request? | `wait`, `hedge`, `serve_cached` | `hedge`: idempotent GET, replayable, fetch; `serve_cached`: GET, cached, fetch |
| `inconsistency` | What should the runtime do about this inconsistent state? | `ignore`, `rollback`, `resync` | `rollback`: a consistent snapshot and a writable store; `resync`: a store with a resync handler |
| `transition` | What should the runtime do about this unusual state change? | `ignore`, `rollback`, `resync` | `rollback`: the op chain's writes are revertable; `resync`: a chain store is resyncable |
| `error` | What should the runtime do about this error? | `ignore`, `rollback` | `rollback`: the ambient op's chain wrote revertable state |
| `ask` | (none) | (none) | — |

Built-in descriptions and tiers (`BUILTIN_ACTIONS`; the sim's `TIER`, curriculum `fmt.TIER` and `eval_runtime.TIER` are copies):

| action | tier | description |
|---|---|---|
| `apply` | passive | let this write update the state now |
| `discard` | guard | drop this write and keep the current state |
| `defer` | guard | hold this write until the related in-flight operations finish, then decide again |
| `send` | passive | send the request now |
| `coalesce` | guard | do not send; reuse the result of the identical request that is in flight or just finished |
| `delay` | guard | wait before sending, backing off so the service can recover |
| `block` | heal | do not send; fail this request immediately |
| `serve_cached` | heal | answer with the last successful response for this request instead |
| `deliver` | passive | pass the failure to the application as it is |
| `retry` | heal | retry the request after a short backoff |
| `wait` | passive | keep waiting for the request |
| `hedge` | heal | send a second identical request and use whichever answers first |
| `ignore` | passive | leave the state as it is |
| `rollback` | heal | restore the affected state to its last consistent snapshot |
| `resync` | heal | reload the affected state from its source |

Custom (plugin) actions are appended after the built-ins when `def.on` includes the trigger, the name is new, and `def.applicable(draft)` is truthy (no `applicable` = applicable; a throw counts as false). Their tier defaults to `heal`, and their description comes from `actionDescription` (vocabulary override, then `def.description`, then the built-in text, then the name).

### Training row (`sim/src/types.ts` -> `Row`, `Label`; same schema as docs/CONTRACT.md §D)

```ts
interface Row { id: string; split: "train" | "dev" | "test"; family: string; state: JevState;
                questions: Record<string, Question>; labels: Record<string, Label>; meta: Record<string, unknown> }
type Label = { type: "choice"; label: string } | { type: "choice"; dist: Record<string, number> }
           | { type: "noul"; p: number } | { type: "score"; level: number } | { type: "score"; dist: number[] };
```

A qid without a label is packed but unsupervised.

## How it works

### 1. Situation text (`build.ts` -> `buildSituation`, `serialize.ts` -> `toJevState`)

1. `subjectOf(env, spec)` writes the `trigger` sentence (model input) and `Situation.subject` (reports only, never model input). `opLabel(op)` = `` `${truncate(opPhrase(op), 90)} (#${op.id})` `` (`"an earlier operation"` when the op is unknown).
   | trigger | sentence template (`state.trigger`) | `Situation.subject` |
   |---|---|---|
   | mutation | `A write to <p1, p2, p3[ and N more] \| store>[ from <opLabel(cause)>] is about to be applied.` | `write to <paths>[ from <opLabel>]` |
   | request | `<opLabel> is about to be sent.` | `<opLabel>` |
   | failure | `<opLabel> failed (<HTTP 503 \| timed out \| network error>) and the app has not seen the failure yet.` | `<opLabel> (<failure>)` |
   | stall | `<opLabel> has been waiting <secs> for a response.` | `<opLabel>, waiting <secs>` |
   | inconsistency | `The relation <text \| ?>[ (and N more)] no longer holds now that the app is settled.` | `relation <text>[ (and N more)]` |
   | transition | `<opLabel> completed with a state change unlike its usual ones.` | `<opLabel> state change` |
   | error | `An uncaught <Name> was thrown: <message, truncated to 120>` | `<Name>: <message ≤ 80>` |
   | ask | `The developer asks about <opLabel>.` / `The developer asks about the store <name>.` / `The developer asks about the app right now.` | `question about <opLabel \| name \| the app>` |

   `opPhrase` by op kind (`describe.ts`): user → `userPhrase` (`user clicked <target>`, `user typed <value>[ into <target>]`, `user changed …`, `user submitted …`, `user pressed <key>…`, `user navigated to …`); fetch/xhr → `<op.name><op.detail>` where `name` is the op signature and `detail` the query string plus, for non-GET/HEAD, a redacted body summary (`observe/fetch.ts`; e.g. `GET /api/search?q=rea`, `POST /api/orders {items: [1], cardNumber: [redacted]}`); timer/ws → name; task → `task <name>[ <detail>]`; genclass → `GenClass <name>`. Time and number formats come from `util.ts`: `secs(ms)` = 2 dp below 10 s (`0.42s`), 1 dp below 1,000 s (`12.3s`), else integer; `rel(ms)` = signed timeline stamp (`-1.24s`, `+…` for future); `fmtNum` = integers as is, else 1/2/4 dp by magnitude (≥ 100 / ≥ 1 / < 1); `truncate(s, n)` = first `n−1` UTF-16 code units + `…`.
2. Facts: `computeFacts` (or precomputed facts from triage), plus plugin facts (each truncated to 240, `kind: "plugin"`, neutral). Then `orderFacts` (non-neutral first, then kind rank, stable) and `.slice(0, MAX_FACTS = 12)`.
3. Section lines (details in [learn-situation-triage.md](runtime/learn-situation-triage.md)):
   - `app`: `` `${title} — ${route}` ``, or whichever exists, else `unknown`.
   - `in_flight`: non-user in-flight ops except the subject, same signature first, then same root, then by start: `<opPhrase≤80> (#id) <secs> so far[, by #cause]`.
   - `timeline`: from the last 96 events, the relevant ones (≤ section limit), topped up with the most recent irrelevant ones and sorted by `seq`. Lines come from `describe.ts` -> `eventLine`, for example `-0.90s start GET /api/search?q=rea (#6, by #5)`, `-0.00s end … (#6): 200 in 0.90s`, `-0.69s write search.results: 0 items → 2 items […] (by #8)`, `-1.05s user typed "reac" into input "Search" (4 keystrokes, #1–#7)`, `… error <msg≤100> (during #2)`, `… navigate <route≤60>`, `… GenClass <text≤100>`. `decision` events are never shown.
   - `state`: involved fields first, then other fields of the involved stores by most recent write: `path = value (vN, by #writer <secs> ago)` or `(v0)`. A store with a `describe` option renders `store = <describe≤110> (vN)`.
   - `stats`: `<sig>: N done[, median Xs, p95 Ys], F of last N failed, R in last 10s[ (usual U)]`.
4. `toJevState(parts, budget)`:
   1. `b = max(MIN_BUDGET 500, round(budget))`; `L = sectionLimits(b)`, with `r = clamp((b − 1100) / 2100, 0, 1)` and every limit `Math.round(a + (b − a)·r)` (half-up).
   2. Cap each section: facts/in_flight/state/stats keep the first N, timeline keeps the **last** N. Each line is truncated to its line limit with `…` (`util.truncate`: first `n−1` chars + `…`).
   3. Build the object in key order `app, trigger, facts, in_flight, timeline, state, stats`. An empty array becomes the string `"none"`.
   4. Size = `stateChars` = Σ over keys of `len(key) + 2 + len(value joined by "\n") + 1`. While size > `b`, shrink in this order: timeline (drop oldest, floor 0), state (drop last, floor 0), facts (drop last, **floor 1**), in_flight (drop last), stats (drop last).
   5. If still over (`over = size − b`): shorten every fact to `max(60, len − over)`. If still over, shorten the trigger to `max(60, len − remaining excess)` (the excess is recomputed after the fact shortening).
5. The situation is deterministic: the same inputs and clock give byte-identical output (`test/situation.test.ts`, `test/budget.test.ts`).
6. The budget comes from `RuntimeImpl.situationBudget` (`src/runtime.ts`). A numeric `situation.budget` is used as is. With `"auto"`: webgpu or an unknown device gives 3,200; wasm gives `1000 + round((threads − 1)·1000/3)` with threads clamped to 1..4 (1,000 / 1,333 / 1,667 / 2,000). The result is multiplied by `budgetScale`, which starts at 1 and becomes `max(0.5, ×0.8)` after each `max_tokens_exceeded` (auto only).

### 2. Standing questions (`questions.ts` -> `buildQuestions`)

1. `compact = budget <= COMPACT_QUESTIONS_BUDGET` (1,400). This is a different constant from `COMPACT_BUDGET` 1,100.
2. `ask` trigger: only standing questions (from `rt.question` or a plugin) for `ask`. `runtime.ask(q)` sends its own `{answer: q}` (`runtime.ts` -> `ask`).
3. Otherwise `diagnosis = {type: "choice", instructions: "What is happening here?", criteria}`, where `criteria[label]` is the description. In compact mode it is `null`, unless a `vocabulary.diagnoses` override of ≤ 24 chars (`COMPACT_DESC_MAX`) exists for that label.
4. `action` is added only if more than one action applies, with `criteria[name]` = the description (compact: `null` unless a `vocabulary.actions` override ≤ 24 chars). The header is `ACTION_INSTRUCTIONS[trigger]` and is fixed per trigger (no subject interpolation).
5. Standing questions (from `rt.question` or a plugin) follow, by their `id`, only if the id is not already in the object (`if (!(k in qs))`). So an id `diagnosis` is always skipped, but an id `action` is **inserted** when the built-in `action` question is absent (≤ 1 applicable action). Insertion order is `diagnosis, action, <standing qids>`. For `ask` the result is `{...extra}` (standing questions for `ask` only, nothing skipped).

### 3. Wire → segments and blocks (`model/serialize.ts`, port of `jev_local/serialize.py`)

1. The host calls `toJsonValue(req.state)` (`host.ts` -> `evaluateDetailed`; questions are passed as given and converted per value inside `questionBlock`). This is the value Python sees after `json.loads(JSON.stringify(v))`: `undefined` keys vanish, NaN/±Infinity become `null`, Dates become strings, Maps are kept as ordered maps (entries whose value is `undefined`, a function or a symbol are dropped). BigInt and cyclic values throw `ModelInputError`. `pyJson` is `json.dumps(v, ensure_ascii=False, separators=(", ", ": "))`: non-ASCII characters stay raw, numbers go through `pyNumber`.
2. `stateSegments(state)`:
   - object: one segment per top-level key, `text = valueText(v)`: an array of strings is joined with `"\n"` (not stripped); anything else goes through `entryText`.
   - array: up to 64 (`MAX_ARRAY_SEGMENTS`) `[i]` segments plus one `[64:]` remainder.
   - string: one segment with key `""` (stripped).
   - `null` → `None`; booleans → `True`/`False`; numbers → Python repr.
3. `entryText`:
   - `null` → `""`.
   - string → `pyStrip` (Python whitespace set).
   - all-string array → items joined with `"; "`, skipping empties.
   - other array → `json.dumps(…, separators=(", ", ": "))`.
   - object → `k: v | k: v` (nested objects and non-string arrays as JSON).
   - number → `pyNumber`: JSON integers print as ints; others print as Python `repr(float)`, with an exponent form outside `[1e-4, 1e16)`.
4. `segmentText` = `` `${key}: ${text}` `` (or `text` when the key is empty). The model therefore reads `facts: <fact1>\n<fact2>`. The indented `facts:\n  <fact1>` rendering in STATUS.md and `explain()` comes from `situation/serialize.ts` -> `stateText` and is display only. (`model/serialize.ts` -> `stateText` is a different helper: `key:\ntext` blocks joined by blank lines, also display only.)
5. `questionBlock(qid, q)`:
   - header = `entryText(instructions)` or the default (`Is the statement true of the state?` / `Which option best fits the state?` / `Which level best describes the state?`).
   - choice: items `label` when the description is `null`, `""`, or equal to the label after strip; otherwise `label: <entryText(desc)>`. Labels are in criteria order (a Map keeps integer-like labels in order; a plain object moves them first). Empty criteria → `ModelInputError`.
   - score: items = level texts, labels `"0".."n-1"`. Empty criteria → `ModelInputError`.
   - noul: items `[true || "yes", false || "no"]`, labels `["true","false"]`.
   - Any other type → `ModelInputError`.
6. `questionEntries(questions)`: request order (`Object.entries`, or Map order).

### 4. Packing (`packer.ts` -> `Packer.pack`)

```
[CLS] seg_0 [SEP] seg_1 [SEP] … seg_n [SEP] | [Q] header_0 | [O] item_00 | [O] item_01 … | [Q] header_1 | [L] lvl_10 … | [Q] header_2 | [T] true | [F] false
```

1. Each text is tokenized on its own with no special tokens (`Packer.encode` -> `Tokenizer.encode`, cached by text, 8,192 entries). Special added tokens (`[CLS]`, `[Q]`, …) are **never** matched inside text, so user text cannot forge a marker. In code order (`Tokenizer.encode`): the file's normalizer runs on the whole text first (NFC for the shipped file; `NFC/NFD/NFKC/NFKD/Lowercase/Sequence` supported), then non-special added tokens (whitespace runs, `|||…|||`, `[unusedN]`) are split out leftmost-longest and keep their own ids, then each remaining piece goes ByteLevel regex → BPE merges (heap, `Word::merge_all` order).
2. State ids: `[CLS]`, then each segment's ids followed by `[SEP]`. `nState = S` is the count.
3. Per question `qn`: header = `[Q]` + header ids. Each item = its marker + item ids. Markers: `[O]` choice, `[L]` score, `[T]`/`[F]` noul.
4. `position_ids`: state `0..S−1`. Header tokens `S..S+h−1`. Every item **restarts** at `S+h`.
5. `q_group`: −1 for state, `qn` for header and items. `i_group`: −1 for state and header tokens, the item ordinal for item tokens. The graph builds the block mask from these: a token sees the state plus its own header and its own item. ModernBERT local (`sliding_attention`) layers also require `|pos_q − pos_k| ≤ window`; the window is a graph constant (`ExportModel.window`), recorded as `meta.json` `window` but not read by the host.
6. Limits: `positions = S + max over questions(len(header) + longest item)` must be ≤ `maxPositions` (`meta.max_len`, default 1536), and `total = S + Σ(header + all items)` ≤ `maxTotal` (`meta.max_total`, default 8192). Otherwise `MaxTokensExceededError` (`code: "max_tokens_exceeded"`) is thrown. There is no truncation inside the model host: the situation budget is the only size control.
7. Marker, `[CLS]` and `[SEP]` ids come from `meta.json` when given and must equal the tokenizer's ids, otherwise `ModelUnsupportedError`. Nothing is hardcoded. The pruned runtime tokenizer has markers at ids 16359–16363 (MODEL_CARD).
8. `Packer.measure(state, questions?)` returns `{stateTokens, positions, total}` with the same arithmetic as `pack` but never throws `MaxTokensExceededError` (host `measure`, worker message `measure`; the runtime itself does not call it, see [model-host.md](runtime/model-host.md)).
9. Tokenizer constraints (`tokenizer.ts` -> `Tokenizer` constructor, all `ModelUnsupportedError`): model type must be `BPE`; no dropout; no `continuing_subword_prefix`/`end_of_word_suffix`; pre-tokenizer must be `ByteLevel` (or a one-element `Sequence` of it); normalizer one of `NFC/NFD/NFKC/NFKD/Lowercase/Sequence` or none; non-special added tokens may not use `lstrip`/`rstrip`/`single_word`; every byte that can occur in UTF-8 needs its byte-level token; every merge must refer to vocab tokens; every id < `ID_SPACE` (2^26, module-private). The pre-tokenizer regex spells `\s` as `\p{White_Space}` to match Rust/Oniguruma.

### 5. Feeds, graph and heads (`engine.ts`, `packer.ts` -> `planInputs`/`unpackLogits`; graph `scripts/genclass_export.py` -> `ExportModel`)

1. `planInputs` groups questions by kind in request order:
   - `choice_q [G]`, `choice_items [G, K]` (padded with 0);
   - `score_q [S]`, `score_items [S, K2]`;
   - `noul_q/noul_t/noul_f [M]`.
   A kind with no question gets one dummy row pointing at token 0.
2. `Engine` feeds exactly `meta.inputs`. The set must equal the session's input names, and every name must be in `FEEDS`: `input_ids, position_ids, q_group, i_group, attention_mask, token_type_ids, choice_q, choice_items, score_q, score_items, noul_q, noul_t, noul_f`. All feeds are int64, and token rows are `[1, L]`. Shipped exports declare the 11 inputs without `attention_mask`/`token_type_ids`.
3. Outputs map by name: `choice_logits [G, K]`, `score_logits [S, K2]`, `noul_logits [M]` (fp16 outputs are converted to numbers).
4. Heads (`jev_local/engine/encoder/heads.py`):
   - choice: `z_i = MLP([h_Q; h_Oi; h_Q*h_Oi])`;
   - score: `z_k = MLP([h_Q; h_Lk; h_Q*h_Lk])`;
   - noul: `z = MLP([h_Q; h_T; h_F; h_Q*h_T; h_Q*h_F])`, an absolute sigmoid rather than a 2-way softmax.
   MLP = Linear → GELU → Linear(d → 1). Every `h_*` is first passed through the heads' shared LayerNorm (`DecisionHeads.norm`; `pairwise`/`n` in `ExportModel.forward`).
5. `unpackLogits` returns raw logits per qid in request order, taking the first `labels.length` columns. `Engine.logits` serializes forward passes (one at a time per session).
6. `Engine` constructor checks (all `ModelUnsupportedError`): the session's input names must equal `meta.inputs` as a set (if `meta.inputs` is absent, the session's names are used); every input must be a `FEEDS` key; every `meta.outputs` name must be a graph output; outputs are filtered to `choice_logits`/`score_logits`/`noul_logits` and at least one must remain. A question whose kind has no head fails at `logits` time. Output tensors of type float16 (`Uint16Array`) are decoded by `tensorFloats`; float32/float64 pass through; any other type throws. The reported model id comes from the backend: `name: "<card.name>@<card.version>"` (`backend.ts` -> `createEngine`); `meta.name` is only a fallback when no name is passed.

### 6. Logits → calibrated probabilities → answers (`calibrate.ts`)

0. `parseCalibration(json)` (backend load) fills missing `noul`/`choice`/`score` with 1.0 and `by_header` with `{}`, then throws `ModelUnsupportedError` if the file is not an object, any of the three is not a number > 0, or `by_header` is not an object. Other keys (`by_bucket`, `tau_k`, `noul_platt`, `bucket_clamp`, `version`, and an unknown `_fit`) are passed through unchecked.
1. `hk = headerKey(header)` = `sha1(header)[:12]` (UTF-8). Example keys: `041ccfa6318c` = "What is happening here?", `bb11f7f0f3a7` = "What should the runtime do with this write?", `61d7c396157f` (request), `3616530c70a5` (failure), `94978d9e82be` (stall), `1b36f88322a0` (inconsistency), `6a2432a6e7de` (transition), `3f494eb3a731` (error).
2. choice/score: `tauFor(calib, kind, hk, K)` takes the first that applies:
   1. `by_header[hk]`;
   2. `by_bucket["<kind>:<bucket(K)>"]`, with buckets `2 | 3-5 | 6-10 | 11-30 | 31-100 | 101-255` (K > 255 → `101-255`);
   3. `tau_k[kind] = [a, b]` → `clamp(a + b·ln max(K, 2), bucket_clamp)` (default `[0.5, 5.0]`);
   4. `calib[kind]`.
   Then `softmax(z / τ)` (max-subtracted, float64).
3. noul: `noulAffine` gives `[1/by_header[hk], 0]`, else `noul_platt (a, b)`, else `[1/calib.noul, 0]`. Then `p = sigmoid(a·z + b)`.
4. `buildAnswer(q, probs, precision = "exact", labels)`:
   - choice: `normalizeProbs` (non-finite or ≤ 0 → 0, renormalize; all zero → uniform). `choice` = argmax (first label wins ties). `confidence = clip01((K·pmax − 1)/(K − 1))`. `probabilities` is a plain object in criteria order.
   - score: `score = Σ i·p_i`. `confidence = max(0, 1 − Σ p_i·|i − mode| / MAD_uniform(K))`, with mode = first argmax and `MAD_uniform(K) = mean_i |i − (K−1)/2|`. `probabilities` is keyed `"0".."K−1"` (not the level texts). K ≤ 1 gives confidence 1 for both choice and score.
   - noul: `noul = clip01(p)` (0.5 if p is not finite).
   - `precision: "round"` rounds every number to 2 dp, half-even (`pyRound`), like the Jev server.
5. `EngineResult`: `{model: "<card.name>@<card.version>", answers, usage: {input_tokens, positions: max(position_id)+1}, timings}`.

### 7. How the runtime consumes answers (detail in [decide-policy-actions.md](runtime/decide-policy-actions.md))

`runtime.ts` -> `onDecision`:

- It reads `answers.action.probabilities`, or `{<passive>: 1}` when there is no `action` question. The top action is `answers.action.choice`, or the passive action if that choice is not offered.
- It reads `answers.diagnosis.choice`, or `expected`.
- `decide/policy.ts` -> `gate`: A = the permitted non-passive actions; the candidate is the argmax over A. The candidate runs iff `Σ_{a∈A} p(a)` ≥ the candidate tier's threshold (defaults guard 0.9, heal 0.8) and the diagnosis is not `expected` (unless `requireDiagnosis: false`).
- `Answer.confidence` is **not** used by the gate. `Decision.confidence` = `probabilities[action]`.

### 8. Annotated example (real SIM row `sim-1071-d17` from `sim/samples/sample.jsonl`, budget 1,000)

`state`/`questions` are exactly what the runtime handed its decider (843 chars by `stateChars`):

```jsonc
{ "app": "Snapvault — /albums",                          // title — route, ≤ 60 chars at this budget
  "trigger": "A write to routeData.model.photos, routeData.model.owners, routeData.model.activity and 2 more from GET /v1/photos/photos (#73) is about to be applied.",
  "facts": [                                             // compact limit 6; 2 remain (the shrink loop never drops the last one); each ≤ 220 chars ("…")
    "routeData.model.photos was written once by other operations since this write's cause (#73) started (version 7 → 8), last 0.16s ago by user navigated to link \"Albums\" (#87), which started 2.07s after #73, from a later us…",
    "routeData.model.owners was written once by other operations since this write's cause (#73) started (version 8 → 9), last 0.16s ago by user navigated to link \"Albums\" (#87), which started 2.07s after #73, from a later us…" ],
  "in_flight": [ "GET /v1/albums/photos (#88) 0.16s so far, by #87", "GET /v1/albums/albums (#89) 0.16s so far, by #87" ],
  "timeline": "none",                                     // emptied by the shrink loop (dropped first)
  "state": "none",                                        // emptied by the shrink loop, or no state lines to begin with
  "stats": [ "GET /v1/photos/photos: 4 done, 0 of last 4 failed, 1 in last 10s" ] }
```

```json
{ "diagnosis": { "type": "choice", "instructions": "What is happening here?",
    "criteria": { "expected": null, "stale": null, "conflict": null, "duplicate": null, "inconsistent": null,
                  "failing": null, "slow": null, "overload": null, "unusual": null, "transient": null } },
  "action": { "type": "choice", "instructions": "What should the runtime do with this write?",
    "criteria": { "apply": null, "discard": null, "defer": null } } }
```

At budgets > 1,400 the same criteria carry descriptions (for example `"discard": "drop this write and keep the current state"`), and the item text becomes `discard: drop this write and keep the current state`.

Packed (schematic): `[CLS] "app: Snapvault — /albums" [SEP] "trigger: A write to …" [SEP] "facts: <f1>\n<f2>" [SEP] "in_flight: <l1>\n<l2>" [SEP] "timeline: none" [SEP] "state: none" [SEP] "stats: GET /v1/photos/photos: …" [SEP] [Q] "What is happening here?" [O] "expected" … [O] "transient" [Q] "What should the runtime do with this write?" [O] "apply" [O] "discard" [O] "defer"`.

- `q_group`: −1 for the state, 0 for diagnosis, 1 for action.
- Feed plan: `choice_q = [qPos_diag, qPos_action]`, `choice_items` is `[2, 10]` (the action row is padded with 0 after 3), and score/noul get dummy rows.
- `choice_logits [2, 10]` → diagnosis uses 10 values, action the first 3.
- Calibration: `by_header["041ccfa6318c"]` / `["bb11f7f0f3a7"]` if present, else `choice:6-10` / `choice:3-5` buckets, else `tau_k`, else `choice`.

Labels and the cost evidence in `meta`:

```json
"labels": { "action": { "type": "choice", "dist": { "apply": 0, "discard": 1, "defer": 0 } },
            "diagnosis": { "type": "choice", "label": "stale" } }
"meta": { "trigger": "mutation", "budget": 1000, "best": "discard", "passive_best": false,
          "costs": { "apply": 69.2888, "discard": 64.6921, "defer": 67.9801 },
          "adjusted": { "apply": 4.347, "discard": 0, "defer": 3.288 }, "se": { "apply": 0.004, "discard": 0, "defer": 0.012 },
          "futures": 3, "non_passive_mass": 1, "transform": "default", "diagnosis": "stale", … }
```

How the label falls out of `actionLabel`:

- Adjusted costs: apply = 69.29 + 0 (passive premium), discard = 64.69 + 0.25, defer = 67.98 + 0.25. No tie with passive, since the gaps exceed 0.05.
- Best = discard. gap_apply = 4.347 and gap_defer = 3.288, with τ ≈ 0.10–0.11.
- `exp(−gap/τ)` ≈ 0, so the distribution is one-hot on `discard`.

#### Reading the STATUS.md examples

`packages/runtime/STATUS.md` ("Example situations") prints situations with `stateText` (indented list items) and a display-only `questions:` footer; the model reads `key: line1\nline2` segments and the question blocks of section 3. What they show:

- **Compact vs full** (`test/budget.test.ts`): the same stale write at budget 1,000 (998 chars) and 2,000 (1,494 chars). Limits at 1,000 are facts 6 / timeline 3, and the shrink loop leaves 1 timeline line; at 2,000, `r = 900/2100`, so timeline = `round(3 + 13r)` = 9 lines. At 1,000 the questions are bare labels (≤ 1,400); at 2,000 they carry descriptions.
- **One per trigger at 3,200** (`test/situation.test.ts`): mutation, request (redacted body `cardNumber: [redacted]`, `serve_cached` absent because the request is a POST and `serve_cached` needs a GET with a cached response, `state: none`, `stats: none`), failure, stall, inconsistency, transition, error. These strings are what `rt.py` must reproduce and what a wording change must update.

### 9. SIM rows (`sim/src/gen/trajectory.ts` -> `generateTrajectory`)

1. `buildScenario(seed)` fixes the domain, features, chaos, wording and `budget` (weighted 3,200:40 / 2,000:30 / 1,000:30). The split comes from `splitOf`: test if the domain is in `TEST_DOMAINS` (10 of 55), the family hash is in the held-out 17% (`"family-split-v1"`), or a pattern is in `TEST_PATTERNS`; dev if `hash("dev-split-v1", family) % 100 < 3`; else train. Test trajectories are kept with probability `testKeep` (CLI default 0.33).
2. **Ideal run** (no runtime, zero latency, exactly-once), then the **base run** on the real `createRuntime`. Options come from `sim/src/run/rt.ts` -> `createOptions`: `mode: "heal"`, `triage: "salient"`, `model: false`, `report: "silent"`, thresholds `{report 0, guard 0.5, heal 0.5}`, `holdBudgetMs: 1e9`, `maxActionsPerMinute: 1e9`, `requireDiagnosis: false`, `historySize: 500`, observers fetch + timers + websocket only (xhr, user, errors, nav, storage, perf off; user actions and errors enter through `runtime.user()`/`reportError()`), `situation: {budget}`, `vocabulary` when paraphrased. The runtime module is `process.env.GENCLASS_RUNTIME ?? "@genclass/runtime"` (`realRuntimeFactory`), which also passes the sim's own `DEFAULT_DIAGNOSES` if the runtime's default vocabulary lacks any contract label. `--allow-fake` uses `sim/src/run/fake-runtime.ts` instead (`meta.runtime: "fake"`; tests only).
   - The recording decider (`sim/src/run/runner.ts`) records `{state, questions}` verbatim, answers with probability 1 on the chosen action, and adds a lognormal virtual latency (median 6–25 ms, σ 0.35).
   - Exploration ε ∈ {0, 0.08, 0.2} (weights 4:3:2) × `exploreScale`, used fully where the sim sees a problem and at ε/4 elsewhere.
3. Decision points (`pickPoints`): decisions with ≥ 2 actions, up to `maxPoints` (CLI default 6). They are weighted by `TRIGGER_W` (mutation 1, request 1, failure 1.6, stall 2.2, inconsistency 3, transition 3, error 2.2), ×1.5 when the sim's diagnosis is not `expected`.
4. `pointCosts`: for each action and each future j < K (default 3), re-run with the base run's explored choices before k, the action at k and passive after k. Each run stops at `t_k + W.finalMs` (15 s).
   - Futures 1..K−1 re-seed everything after the decision with a salt `hashAll("future", seed, k, j)` shared across actions (common random numbers). When the scenario has external events after `t_k`, the ideal run is re-run with the same salt for that future.
   - Adaptive: futures 1+ run only if some non-passive action beats passive by > 0.05 in future 0. `meta.futures` = the number of futures actually run (1 or K).
   - Any prefix fingerprint mismatch, internal error or exception drops the point (`prefix-mismatch`, `cf-internal-error`, `cf-exception`).
5. `runCost(real, ideal, from, tEnd)`, with `stop = min(tEnd, from + 15 s, real.tStop)`, sums:
   - `area`: ∫ client divergence over [from, min(stop, from + 10 s)];
   - 4.0 × final client divergence at `stop` + the server divergence `serverDist` vs the ideal server state at `stop`: per collection `25 × min(5, extra/missing items) + 6 × min(5, changed items)`; per document `6 × min(3, differing fields)`; per counter `6 × min(3, |difference|)` (counters ending in `beats` ignored);
   - 1.5 × extra shown-error episodes + 1.0 × extra uncaught errors (counts in [from, stop] beyond the ideal run's);
   - 0.08 × requests beyond the ideal run per signature (requests that arrived at the server in [from, stop], `NetEntry.ta`);
   - 0.25 × seconds non-background ops were pending inside [from, stop];
   - 0.8 × ∫ violated app relations over [from, min(stop, from + 10 s)] + 2.0 × relations still violated at `stop`.
   Client divergence `clientDist` = Σ over store fields of `weight × valueDist` (weights from the app, default 1; the first field (`fields[0]`) of every violated app relation counts its full weight even if it equals the ideal value, and is then skipped in the per-field comparison). `valueDist` ∈ [0, 1]: lists compare as multisets of content with volatile keys (`id, version, rev, revision, etag, updatedAt, updated_at, clientId, pending, seq`) ignored; objects recurse to depth 3 averaging over non-volatile keys; numbers equal within 1e-9.
6. `actionLabel(futures, passive)`:
   1. Premium per action tier: passive 0, guard 0.25, heal 0.5.
   2. A non-passive action whose mean cost is within 0.05 of passive's is a tie and is pinned to passive's costs + 1.5.
   3. Best = lowest mean adjusted cost (passive wins exact ties).
   4. `p_a ∝ exp(−max(0, mean(adj_a − adj_best)) / (0.1 + 1.0·SE_a))`, rounded to 1e-4. `SE_a` = sample SD of the paired per-future differences / √K (0 with one future). Futures are paired by index and truncated to the shortest list.
   5. `meta.costs` = per-action mean raw cost (1e-4); `meta.cost_futures` = the raw per-future costs (1e-4); `meta.adjusted` = gap to best (1e-3), `meta.se` (1e-3), `meta.non_passive_mass` (1e-4).
7. `transformQuestions`, with an independent RNG per row:
   - 50%: unchanged.
   - Otherwise, for `action` only: with p 0.12, if there are ≥ 3 options, drop one option that is neither passive nor best and renormalize the distribution. With p 0.5, shuffle the options.
   - `meta.transform` records the variant (`default`, `drop:<a>`, `shuffle` or `drop:<a>,shuffle`).
   - Instructions and descriptions are never changed. Wording variation comes from the runtime's `vocabulary`, per trajectory:
     - diagnoses: 50% default; otherwise each label is paraphrased with p 0.6, and with p 0.3 one or two of `conflict, slow, overload, unusual, inconsistent, duplicate, transient` are dropped;
     - actions: 50% default; otherwise each action is paraphrased with p 0.6 (`ACTION_PARA`).
8. Labels written: `labels.action = {type: "choice", dist}` always. `labels.diagnosis = {type: "choice", label: diag}` only if the sim's diagnosis is in the row's criteria and the subject correlated; otherwise the row is still emitted, counting drops `diagnosis-not-in-vocab` / `diagnosis-uncorrelated`.
   - The diagnosis is **not** derived from costs or from the runtime's text: `sim/src/oracle/diagnose.ts` -> `diagnose(trigger, subject, ctx)` maps the sim's ground truth (superseded intent → `stale`, competing intents → `conflict`, repeated intent → `duplicate`, broken app relation → `inconsistent`, failure streak/outage → `failing`, isolated 5xx/network/timeout → `transient`, latency anomaly → `slow`, rate anomaly → `overload`, genuine shape anomaly/server bug → `unusual`, else `expected`). Exact rules per trigger: [sim.md](sim.md) flow 8.
9. Other row kinds:
   - **Diagnosis-only** rows (`sim-<seed>-s<k>`): up to 3 per trajectory, sampled from decisions with < 2 actions, a diagnosis and a correlated subject; questions = the recorded `questions` **untransformed** (normally just `{diagnosis}`); meta `{…scenario meta, trigger, decision, t, diagnosis, diagnosis_only: true, subject}`.
   - **Ask** rows (`sim-<seed>-a<i>`, family `<scenario family>/ask`): `runtime.situation("ask")` (always about `"now"`, so `trigger` = `The developer asks about the app right now.`) at 1–3 probe times (`scenario.askTimes`), with 1–3 questions from `askQuestions` (generators tried in shuffled order, each may return null). Labels are exact. The generators that name things (`last_failed`, `route`, `slowest`) check that their evidence appears in `JSON.stringify(state)`; the timing generators skip borderline values (table below). Meta `{…scenario meta, trigger: "ask", t, kinds}`.

     | qid | type | options (criteria) | label | skipped when |
     |---|---|---|---|---|
     | `q_write_inflight` | noul | true `yes, a write is in flight` / false `no write is in flight` | a POST/PUT/PATCH/DELETE in flight | never |
     | `q_any_inflight` | noul | default (`yes`/`no`) | any request in flight | never |
     | `q_pending` | score | `none, one, two, three or more` or `0 requests, 1 request, 2 requests, 3+ requests` | `min(3, in-flight count)` | > 6 in flight |
     | `q_last_failed` | choice | `e1..e3` = endpoint signatures, `none` = a "none" phrase | id of the last failing signature (≥ 400 or network error, last 12 s), else `none` | < 2 known signatures; its path tail not in the text |
     | `q_recent_failure` | noul | default | a failure in the last 5 or 10 s | a failure within 1 s of the window edge |
     | `q_fail_count` | score | `none, one, two, three or more` | `min(3, failures in last 10 s)` | counts at 9 s and 11 s differ |
     | `q_user_waiting` | noul | default | user-initiated wait > N s (N ∈ 1, 2, 3, 5) | within 400 ms of N s |
     | `q_user_recent` | noul | default | user input within N s (N ∈ 1, 2, 3) | within 300 ms of N s |
     | `q_last_save` | noul | true `the last save succeeded` / false `the last save failed` | last save ok | no save yet |
     | `q_route` | choice | `r1..r3` = the route + 2 from a fixed list (`/settings`, `/home`, …) | id of the current route | route not in the text |
     | `q_slowest` | choice | `o1..o4` = in-flight signatures | id of the oldest in-flight request | < 2 in flight; top two within 300 ms or same signature; a path tail missing from the text |
10. Ids, family and meta:
    - Ids: `sim-<seed>-d<k>` (decision), `-s<k>`, `-a<i>`. `family` = `<scenario family>/<trigger>`.
    - Decision meta: `seed, domain, family, chaos, budget, runtime, features, patterns, trigger, decision, t, explored_before, best, passive_best, costs, cost_futures, futures, adjusted, se, non_passive_mass, cost_parts{area, final_client, final_server, relation_s, relation_final, errors, uncaught, wasted, latency_s}, tiers, diagnosis, subject{kind, how, ref?}, transform, fake_diagnosis?`.
    - Output: `<out>/{train,dev,test}.jsonl` + `stats.json` (or resumable `parts/part-NNNNNN.<split>.jsonl`, written as `.tmp` and renamed when the part completes, with a `part-NNNNNN.json` marker; `--merge-only` concatenates them). `stats.json` `token_estimate` is `(len(JSON state) + len(JSON questions)) / 3.6`, not real tokens.
    - `--sample`: target 900 rows, `testKeep` 1, then a stratified 200 rows (round-robin over `trigger|diagnosis|act-or-passive`) to `sim/samples/sample.jsonl`, plus `EXAMPLES.md` (`renderExamples`) and `sample-stats.json`. Full CLI: [sim.md](sim.md).

### 10. Training consumes rows (`jev_local/train/train.py` -> `encode_example`, `parse_target`)

1. Every question goes through `question_from_json` → `question_block`, and the state through `state_segments`. This is the Python original of `model/serialize.ts`, so SIM rows (written by `JSON.stringify`) render identically on both sides.
2. `parse_target(block, label)`:
   - noul `p` → `[p]` (hard if 0/1).
   - choice `label` → one-hot over `block.labels` (rejected if not an option).
   - choice `dist` → values aligned to `block.labels` (missing → 0), renormalized; always `hard=False`, **even when one-hot**, so label smoothing never applies to SIM action labels (they are always `dist`). A dist summing to 0 is rejected.
   - score `level` → one-hot (rejected outside `0..K−1`); score `dist` (length must equal K) → renormalized, soft.
   - A type mismatch or bad label makes the question unsupervised (`bad_labels`); a label for a qid that has no question is ignored by the trainer (the curriculum's `_validate` rejects such rows).
3. `Packer.pack_split(segments, blocks, --max-len)`: questions are isolated, so an over-long example splits into several sequences that repeat the state (greedy, in request order). A question whose state + whole block exceeds `max_len` is dropped (`dropped_qids`); a state that alone exceeds `max_len` therefore drops every question.
4. Losses (`jev_local/train/losses.py`): proper scoring rules. Defaults reproduce v1 (CE, label smoothing 0.02 on hard labels, RPS 0.25 on score). See [training.md](training.md) for the configs actually used.
5. Final round 1 (`training/launch_final1.sh`, `training/configs/mix_final1.json`): `--max-len 2048`, `--batch-tokens 8192`, mixture `simA 0.85, cur4 0.12, cur1 0.02, gen 0.01`, `pass_tokens` 500,000,000, `max_repeat` `{"*": 2.0, "simA": 1.3}`.
6. Curriculum rows (`rows.py`; full detail in [training.md](training.md)):
   - `decision_row` emits either runtime-exact text (`rt.render`, style `runtime`, share `--p-runtime` = env `GC_P_RUNTIME`, default 0; `cur4` used 0.8) or varied text (style `varied`; also the fallback when `rt.render` returns `None`, e.g. a scenario with no `spec` or `no_runtime`). Runtime-style rows get the runtime's exact questions plus 0–2 primitive questions (choice of `(0, 0, 1, 2)`); `action` is labelled only if `rt.render` produced an `action` question.
   - Varied text: renamed keys (`KEY_VARIANTS`), op/time/duration formats (`Style.make`), facts ≤ 12 shuffled (25%), one of `in_flight`/`stats`/`state` dropped (15%), key order shuffled (10%), state ≤ 8 lines, timeline ≤ 16; action labels renamed (10%, each with p 0.5, `RENAMES`), 1–2 `DISTRACTOR_ACTIONS` inserted (15%), options shuffled (50%), descriptions = canonical (50%) or a paraphrase; diagnosis subset of gold + `expected` + 2–5 others (20%), shuffled (50%); bare `null` criteria (10% per question); question order swapped (15%); 0–3 primitives (choice of `(0, 1, 2, 2, 3)`). Headers come from `fmt.ACTION_INSTR[trigger]` (some with `{subj}`) and `fmt.DIAG_INSTR`; these lists do **not** contain `What is happening here?` nor the runtime's exact failure/inconsistency/transition headers, so those four strings appear only in `rt.render` rows (the runtime's mutation, request, stall and error action headers are also among the varied choices).
   - `ask_row`: varied state with an ask trigger sentence (`facts` dropped 30%), 2–5 primitive questions, meta `{kind: "ask", trigger: "ask", source_trigger, case, domain, prims}`, family `cur/ask/<trigger>`.
   - Decision meta: `kind, trigger, case, domain, passive_best, action_gold, action_canonical, passive, diag_gold, action_names, prims, heldout_templates_possible, soft_action, style`; family `cur/<trigger>/<case tail>`. `meta.action_names` maps canonical → shown names (`eval_runtime.canonical` reverses it).
   - `generate.py` writes ids `cur-<split>-<chunk:05d>-<i:06d>`, applies `js_numbers` to `state` and `questions` (integral floats → ints, as JS prints them; labels and meta untouched), and drops rows that fail `_validate` (jev_local `state_segments`/`question_block`/`parse_target`, no unknown qids, ≥ 1 label).

### 11. Evaluation and calibration fit (`training/eval_runtime.py`)

CLI: `--ckpt` (required), `--data DIR` (required; reads `DIR/<split>.jsonl`), `--split` (default `test`), `--fit-split`, `--limit`, `--batch` (16), `--threads` (32), `--out report.json`, `--write-calibration`, `--calibration` (evaluate with a given file; reads only `noul`, `choice`, `score`, `by_header`, so v2 keys are ignored), `--records-dir` (cache raw logits as `<ckpt>__<data>__<split>.jsonl`), `--header-calibration`.

1. Raw logits per supervised question come from `jev_local.train.eval.collect`. `header` is the header key (`sha1(header)[:12]`, computed in `jev_local/train/eval.py`).
2. `fit_calibration` (on `--fit-split`):
   - noul τ on a 61-point log grid in [0.2, 5];
   - choice τ by golden section on log τ in [0.2, 5] (40 iterations) over all choice questions, `action` and `diagnosis` included;
   - score τ the same way;
   - `action` and `diagnosis` also get their own τ (used by the `group` metric mode, never written);
   - `by_header` (sha1 keys) only for standing questions with ≥ 300 examples.
   - Split-half check: refit on fit-split records with even `crc32(id)`, evaluate on odd ones (`report.split_half`).
   - Metric modes: `raw` (τ 1), `kind` (per-kind τ, what the runtime does with a v1 file), `group`, `header`; the report has `questions_<mode>` (acc, NLL, Brier, ECE 15 bins) and `decisions_<mode>` for each, plus `primitive_acc`. Rows are bucketed by `meta.budget` (else by state chars `≤1100` / `≤2100` / `>2100`) for `by_budget`.
3. `--write-calibration` writes `{noul, choice, score, by_header, _fit}`. `by_header` stays `{}` unless `--header-calibration` is passed, and `final_post.sh` (which runs the eval through `training/eval_sim.sh`) does not pass it. Shipped files are therefore v1 per-kind temperatures; the runtime ignores `_fit`.
4. Decision metrics re-implement the runtime §8 gate (summed mass, `THRESH` guard 0.9 / heal 0.8, top diagnosis ≠ `expected`; unknown actions count as heal). Reports per trigger/case/style/budget: FIR, precision, recall, mean counterfactual cost vs always-passive vs oracle (SIM rows with `meta.costs`), plus a threshold sweep.

### 12. Export → model directory (`training/export_runtime.py` -> `main`)

Run by `training/final_post.sh` after the eval (`eval_sim.sh simAe <M>`): `--calibration out/cal/<M>-simAe.json --data-rows data/simAe/dev.jsonl,data/cur4/dev.jsonl --n-per-file 60 --threads 24`; it then tars the export without `ref/` for `pull_on_train.sh`.

CLI defaults: `--ckpt`, `--out` (required), `--name genclass-runtime`, `--version 0.1.0`, `--requests` (a JSON list) or `--data-rows a.jsonl,b.jsonl`, `--n-per-file 40`, `--calibration` (default: the checkpoint's), `--opset 17`, `--threads 16`, `--block 32`. It imports `jev_local` and `genclass_export` from `~/jev` and `~/jev/scripts` (VM layout). Steps:

1. `load_checkpoint(ckpt, "cpu", float32, encoder="reference")`; `ExportModel(enc, heads)`; parity requests sampled per file (random permutation, seed 0) keeping those that pack to ≤ 1,500 tokens with the Python `Packer(tok, max_len=8192)`.
2. `torch.onnx.export` fp32 and fp16 references into `ref/` with dynamic axes `L` (tokens), `G/K` (choice), `S/K2` (score), `M` (noul).
3. `make_q8`: `gemm_to_matmul` (Gemm with transA 0, alpha = beta = 1 and an initializer weight → MatMul [+ Add]), `MatMulNBitsQuantizer` (8-bit, block 32, symmetric, axis 0), then `quantize_embedding` (per-row `scale = max|row| / 127`, zero rows scale 1, `q = clip(rint(w/scale), −127, 127)`); refuses any fp16 initializer or Cast-to-fp16. `make_fp16`: the fp16 reference with the same int8 embedding, scale stored fp16.
4. Parity on CPU (ORT `CPUExecutionProvider` with `--threads` intra-op threads for fp32/fp16/q8, plus a 1-thread session for fp16/q8 only) vs `FastEngine(…, encoder="banded")` logits, both calibrated with the shipped calibration → `parity.json`.
5. Copy tokenizer, write calibration, `meta.json`, then `model.json` with byte sizes and sha256 of every file.

| file | content |
|---|---|
| `model.json` | `{format: "genclass-runtime-model/1", name, version, license: "Apache-2.0", variants: {q8: {file, bytes, sha256, provider: "wasm"}, fp16: {file, bytes, sha256, provider: "webgpu", needs: "shader-f16"}}, files: {tokenizer, calibration, meta: {file, bytes, sha256}}}` |
| `<name>-q8.onnx` | MatMulNBits 8-bit, block 32, symmetric, on every MatMul (Gemm rewritten first) + int8 row-wise token embedding (Gather int8 → Cast fp32 → Mul per-row scale); must contain no fp16 tensor |
| `<name>-fp16.onnx` | fp16 weights/compute, fp32 I/O, int8 embedding (Cast fp16) |
| `tokenizer.json` | copied from `<ckpt>/backbone/tokenizer.json` (pruned: 16,000 merges, 16,364 tokens) |
| `calibration.json` | `--calibration` file, else the checkpoint's |
| `meta.json` | `name` (`<name>-<version>`), `source_checkpoint`, `max_len` (checkpoint meta, else 1536; 2048 for final round 1), `max_total: 8192`, `window`, `hidden_size`, `layer_types`, `markers`, `cls_id`, `sep_id`, `pad_id`, `vocab_size`, `merges_kept`, `inputs`, `outputs: ["choice_logits","score_logits","noul_logits"]`, `embedding_quant`, `matmul_quant`, `license` |
| `requests.json` | `[{id, state, questions, tokens}]`: parity requests (≤ 1,500 tokens, `--n-per-file` per data file) |
| `pack_fixtures.json` | per request `{id, input_ids, position_ids, q_group, i_group, n_state, q_index: {qid: {kind, header, labels, q_pos, item_pos}}}` from the Python packer |
| `torch_fixtures.json` | per request `{id, logits: {qid: [...]}, probs: {qid: [...]}, header_key: {qid: hk}}` (PyTorch, calibrated with the shipped file) |
| `parity.json` | per variant `fp32`/`fp16`/`q8`: `max_abs_logit`, `max_abs_prob`, `argmax_agree`/`argmax_total`/`argmax_rate`, `noul_side_agree`/`noul_total`/`noul_side_rate`, `gate08_agree`/`gate09_agree`/`gate_total`/`gate08_rate`/`gate09_rate` (same argmax and same side of pmax ≥ 0.8 / 0.9 on choice questions), `ort_cpu_ms_p50`, `ort_cpu_1thread_ms_p50` (fp16, q8), `file_mb`; plus `n_requests`, `tokens{min, median, max}`, `embedding_q8`, `embedding_fp16` (quantization error stats) |
| `ref/` | `<name>-fp32.onnx`, `<name>-fp16-fullemb.onnx` references (not in the card; excluded from the served tar) |

Shipped candidates (MODEL_CARD, measured at stage 1c): R17 `genclass-runtime-r17` (ettin-encoder-17m, d 256, 7 layers, 8.1M + 0.7M heads) q8 9.6 MB / fp16 13.6 MB; R32 `genclass-runtime-r32` (ettin-encoder-32m, d 384, 10 layers, 18.8M + 1.6M heads) q8 22.5 MB / fp16 34.8 MB; both vocab 16,364.

The runtime reads `model.json` (`loader.ts` -> `parseCard`; missing `files` default to `tokenizer.json`/`calibration.json`/`meta.json`; `files` entries may be bare file names; file names must be relative with no scheme, leading slash, `..` or empty segment; `sha256` may carry a `sha256:` prefix; `format` defaults to `CARD_FORMAT` and is **not** checked; `name`/`version` default to `genclass-model`/`0.0.0`), then the `meta.json` keys listed in Concepts and every `calibration.json` key listed in step 6. Load plans (`planOrder`): webgpu+fp16 (needs `shader-f16`) → webgpu+q8 → wasm+q8 (wasm+fp16 if the card has no q8; only when the card has neither `q8` nor `fp16` are its other variant names tried on WASM in card order). `device: "auto"` skips WebGPU on a software (fallback) adapter; `"wasm"` never touches the GPU. The default base URL is `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/` (`host.ts` -> `DEFAULT_MODEL_BASE_URL`), and that package is not published yet. More in [model-host.md](runtime/model-host.md).

## Configuration and constants

| name | type | value | defined in | effect |
|---|---|---|---|---|
| `STATE_CHAR_BUDGET` | number | 3200 | `situation/serialize.ts` | full section sizes; default budget |
| `COMPACT_BUDGET` | number | 1100 | `situation/serialize.ts` | budget at or below which section limits are minimal |
| `MIN_BUDGET` | number | 500 | `situation/serialize.ts` | smallest budget honoured |
| `LIMITS` (full) | object | facts 12, in_flight 6, timeline 16, state 8, stats 4 | `situation/serialize.ts` | lines per section at ≥ 3,200 |
| compact section limits | — | facts 6, in_flight 2, timeline 3, state 3, stats 1 | `serialize.ts` -> `sectionLimits` | lines per section at ≤ 1,100 |
| line limits compact→full | — | app 60→120, trigger 180→240, facts 220→260, in_flight 90→120, timeline 100→140, state 100→150, stats 110→140 | `serialize.ts` -> `sectionLimits` | per-line truncation |
| last-resort fact/trigger floor | — | 60 chars | `serialize.ts` -> `toJevState` | pathological over-budget case |
| `COMPACT_QUESTIONS_BUDGET` | number | 1400 | `situation/questions.ts` | bare labels/names at or below |
| `COMPACT_DESC_MAX` | number | 24 | `situation/questions.ts` (private) | vocabulary override kept in compact mode |
| `MAX_FACTS` | number | 12 | `situation/facts.ts` | facts kept before budgeting |
| plugin fact length | — | 240 | `build.ts` -> `buildSituation` | plugin fact truncation |
| phrase truncations (before line limits) | chars | `opLabel` phrase 90; in-flight phrase 80; error trigger message 120 (`Situation.subject` 80); timeline start/end phrase 80, write summary 110, error 100, navigate 60, GenClass action 100, custom name/summary 60/60, storage key 40; state value 90 (`describe`), store-level `describe` 110 | `describe.ts`, `build.ts` | text shape |
| timeline candidates | — | last 96 events | `build.ts` -> `timelineLines` | events considered |
| auto budget | — | webgpu/unknown 3,200; wasm `1000 + round((t−1)·1000/3)`, t ∈ 1..4 | `runtime.ts` -> `situationBudget` | device-sized situations |
| `budgetScale` | number | 1, ×0.8 per `max_tokens_exceeded`, floor 0.5 | `runtime.ts` | shrinks auto budgets only |
| `MAX_ARRAY_SEGMENTS` | number | 64 | `model/serialize.ts` | array states |
| `DEFAULT_NOUL/CHOICE/SCORE_INSTR` | string | see step 3.5 | `model/serialize.ts` | empty instructions |
| `Packer.maxPositions` | number | `meta.max_len` ?? 1536 | `packer.ts`, `engine.ts` | positions limit |
| `Packer.maxTotal` | number | `meta.max_total` ?? 8192 | `packer.ts`, `engine.ts` | whole-sequence limit |
| packer text cache / tokenizer word cache | number | 8192 / 20000 | `packer.ts` / `tokenizer.ts` | cleared when full |
| `MARKERS` | tuple | `[Q] [O] [L] [T] [F]` | `packer.ts` (= `tokenize_pack.MARKERS`) | head read points |
| `ID_SPACE` | number | 2^26 | `tokenizer.ts` | max token id |
| `K_BUCKETS` | list | 2, 3-5, 6-10, 11-30, 31-100, 101-255 | `calibrate.ts` | `by_bucket` keys |
| `BUCKET_CLAMP` | pair | [0.5, 5.0] | `calibrate.ts` | τ(K) clamp |
| calibration defaults | number | `noul`/`choice`/`score` 1.0, `by_header` `{}` | `calibrate.ts` -> `parseCalibration` | missing keys |
| header-key cache | number | 4096 | `calibrate.ts` -> `headerKey` | — |
| `Precision` default | string | `"exact"` | `engine.ts` | `"round"` = 2 dp half-even |
| policy thresholds | number | report 0.6, guard 0.9, heal 0.8 | `decide/policy.ts` | gate on calibrated probabilities |
| `W` | object | area 1.0, horizonMs 10000, finalMs 15000, finalClient 4.0, serverItem 25.0, serverField 6.0, shownError 1.5, uncaught 1.0, relation 0.8, relationFinal 2.0, wasted 0.08, latency 0.25 | `sim/src/oracle/cost.ts` | run cost |
| `LABEL` | object | tier {passive 0, guard 0.25, heal 0.5}, exactTie 1.5, tieEps 0.05, tau0 0.1, seMul 1.0 | `sim/src/oracle/cost.ts` | soft action label |
| futures K / adaptive gain | number | 3 / > 0.05 | `trajectory.ts` -> `pointCosts` | label sharpness |
| `TRIGGER_W` | object | see step 9.3 | `trajectory.ts` | decision point sampling |
| sim CLI defaults | — | rows 1000, seed 1, workers 4, max-points 6, test-keep 0.33, explore 1, ask on | `sim/src/gen.ts` -> `parse` | generation |
| scenario budgets | weights | 3200:40, 2000:30, 1000:30 | `sim/src/world/scenario.ts` | `meta.budget` |
| transform | prob | unchanged 0.5; drop 0.12 (≥ 3 options); shuffle 0.5 | `sim/src/run/transform.ts` | option order/subsets |
| sim gate thresholds | number | report 0, guard 0.5, heal 0.5; `requireDiagnosis: false` | `sim/src/run/rt.ts` | forced action runs exactly |
| eval `THRESH` | number | guard 0.9, heal 0.8 | `training/eval_runtime.py` | must mirror the runtime |
| eval calibration fit | — | τ ∈ [0.2, 5]; noul grid 61; by_header ≥ 300 examples; ECE 15 bins | `training/eval_runtime.py` | `calibration.json` |
| export | — | opset 17, block 32, `max_total` 8192, parity requests ≤ 1,500 tokens, `--n-per-file` 40 | `training/export_runtime.py` | model directory |
| `CARD_FORMAT` | string | `genclass-runtime-model/1` | `loader.ts`, `export_runtime.py` | card format (written, not validated on read) |
| `DEFAULT_CACHE_NAME` | string | `genclass-runtime-v1` | `loader.ts` | Cache Storage bucket for model files |
| `DEFAULT_MODEL_BASE_URL` | string | `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/` | `model/host.ts` | where the card is fetched (package unpublished) |
| export `OUTPUTS` | list | `choice_logits, score_logits, noul_logits` | `export_runtime.py` | `meta.outputs` |
| export CLI | — | `--name genclass-runtime`, `--version 0.1.0`, `--n-per-file 40`, `--opset 17`, `--threads 16`, `--block 32` | `export_runtime.py` -> `main` | model directory |
| eval CLI | — | `--split test`, `--batch 16`, `--threads 32`; `N_BINS` 15 | `eval_runtime.py` -> `main` | report / calibration |
| `--p-runtime` / `GC_P_RUNTIME` | float | 0.0 (`cur4`: 0.8) | `training/curriculum/generate.py` | share of runtime-exact decision rows |
| `GENCLASS_RUNTIME` | env | `@genclass/runtime` | `sim/src/run/rt.ts` -> `realRuntimeFactory` | runtime module the sim imports |
| `GENCLASS_MODEL_DIR` | env | `<repo>/.cache-model` | `packages/runtime/test/model/helpers.ts` | model directory for parity tests; fixtures come from it when it ships `requests.json`, `pack_fixtures.json`, `torch_fixtures.json`, else from `test/fixtures/model/` (v0.1) |
| sim runtime options | — | `historySize` 500, `holdBudgetMs` 1e9, `maxActionsPerMinute` 1e9, `report: "silent"` | `sim/src/run/rt.ts` -> `createOptions` | no time/rate limits on forced actions |

## Invariants and gotchas

- **Parity chain:** runtime text → `JSON.stringify` (sim row) → Python `serialize.py` → `tokenize_pack.Packer` → PyTorch. On the serving side: runtime text → `toJsonValue` → `model/serialize.ts` → `Packer` (TS) → ORT. Both sides must produce identical token ids. Do not "improve" `pyStrip`, `pyNumber`, `entryText`, the item `label: desc` rule or marker placement on one side only.
- **JS numbers vs Python floats:** JS can only print `25`, never `25.0`. Rows produced in Python must write integral floats as ints (`fmt.js_numbers`). Otherwise the model trains on text the runtime never sends. `test/model/helpers.ts` -> `pythonOnlyFloatRequests` skips such fixtures.
- **Two different compact constants:** `COMPACT_BUDGET` (1,100) shapes sections, while `COMPACT_QUESTIONS_BUDGET` (1,400) bares the questions. Budgets in (1,100, 1,400] get almost-minimal sections plus bare questions.
- **`facts` floor is 1:** the shrink loop never removes the last fact, so the trigger sentence plus one fact (when there was any) always survive; in the pathological case both may be shortened to 60 chars.
- **Display ≠ model text:** `stateText` (STATUS.md, `explain()`, devtools) indents list items. The model reads `key: line1\nline2`.
- **Qids are invisible to the model:** only headers and items are tokenized. Renaming a qid changes nothing for the model but breaks `answers.action`/`answers.diagnosis` lookups. A header change, by contrast, changes the text *and* the `by_header` key.
- **Option order is irrelevant to the model** (isolation), but it decides the order of `probabilities` and the tie-break of `choice`. Plain-object criteria with integer-like labels are reordered by JS. Pass a `Map` to keep the order.
- **Question order:** `diagnosis` comes before `action` in runtime situations. The curriculum swaps it in 15% of varied rows. Answers do not depend on it.
- **`action` is absent when only one action applies:** consumers must treat a missing `answers.action` as passive (`onDecision` does).
- **The runtime never truncates inside the model host:** a situation that does not fit throws `max_tokens_exceeded`, the decision fails open, and auto budgets shrink by 20% (to ≥ 50%). Training drops (does not truncate) questions whose block does not fit `--max-len`.
- **Length semantics differ:** the runtime bounds state + longest branch (`max_len`). The trainer's `pack_split` bounds state + the whole question block per sequence. A many-option question can be valid at runtime yet never have been trained.
- **Markers and specials are read from files:** a re-pruned tokenizer moves ids, and `meta.json` must agree with `tokenizer.json` or loading fails (`ModelUnsupportedError`).
- **Calibration keys are text-sensitive:** any change to an instruction string orphans its `by_header` entry. Shipped files have `by_header: {}`, so this matters only if `--header-calibration` is used.
- **The gate uses probabilities, not `confidence`:** recalibrating changes intervention rates. Re-run `eval_runtime.py` with the new file and compare FIR/precision before shipping.
- **The sim needs thresholds 0.5:** the decider answers with probability 1 on the forced action, so the permitted mass is 1 or 0. A threshold of 0 would run the argmax non-passive action even when passive is forced (comment in `sim/src/run/rt.ts`).
- **Sim determinism:** the counterfactual prefix check compares `JSON.stringify([trigger, state, questions])` for every decision up to k. Any nondeterminism in situation building (time, random ids, iteration order) shows up as `prefix-mismatch` drops. `situation()` must stay side-effect free.
- **`x-request-id` is the sim's correlation header:** the runtime excludes it from request identity and never serializes it. `sim/test/rows.test.ts` asserts it never appears in a state.
- **Description vs effect:** the `rollback` description says "last consistent snapshot", but transition/error rollback restores only the op chain's own writes. Changing the text is a model-input change.
- **SIM action labels are never label-smoothed:** they are always `{type: "choice", dist}`, which `parse_target` marks soft even when one-hot. Converting them to `label` would change the loss.
- **`budgetScale` only shrinks:** each `max_tokens_exceeded` multiplies it by 0.8 (floor 0.5) and nothing resets it for the life of the runtime (`runtime.ts`). Numeric `situation.budget` values are never scaled.
- **Standing question id `action`:** it is skipped only when the built-in `action` question exists. With ≤ 1 applicable action (only the passive one, which is always applicable) it is inserted, and `onDecision` copies its `probabilities` into the decision as if they were action probabilities. The gate still runs nothing (no non-passive action is offered), but reports are misleading. Avoid standing-question ids `action`/`diagnosis`.
- **`situation()` is almost side-effect free:** `env.ts` notes it caches field versions in `op.reads`. Anything more breaks the sim's prefix fingerprints.
- **Varied curriculum headers ≠ runtime headers:** `fmt.ACTION_INSTR`/`DIAG_INSTR` never produce `What is happening here?` or the runtime's failure/inconsistency/transition headers. If `--p-runtime` is 0, the model never sees those exact strings from the curriculum (SIM rows still carry them).
- **Python vs JS number text in `rt.py`:** Python `f"{x:.2f}"` rounds exact binary ties half-even, while JS `toFixed(2)` rounds them up (125 ms → Python `0.12s`, JS `0.13s`; 12.25 s → `12.2s` vs `12.3s`). `rt.py`'s `secs`, `rel` and `fmt_num` therefore differ from `util.ts` on such values. `secs` ≥ 1000 s and `ratio` ≥ 10× also use Python `round()` (banker's) where `util.ts` uses `Math.round`. This affects runtime-exact curriculum rows only; SIM rows record the runtime's own text.
- **Truncation units:** `util.truncate` counts UTF-16 code units, `rt.py.truncate` counts code points. They differ only for astral-plane characters (emoji), and the TS cut can split a surrogate pair (behaviour downstream of a lone surrogate is unverified).

## How to change it safely

### Versioning: what invalidates the trained model

`situation-v1` is a git tag on commit 1a77558 ("Runtime fix batch 3", 2026-10-07). It freezes the text the SIM final data (phase A: train 448,420 / dev 14,613 / test 137,643, per `training/LOG.md`) and the final training round were built on. At 654d822, `packages/runtime/src`, `jev_local/` and `scripts/genclass_export.py` are unchanged since the tag. The sim changed after the tag in 59c213f: correlation header `x-sim-op` → `x-request-id` (excluded from request identity), sim thresholds 0 → 0.5, 1-thread budget 1100 → 1000, resumable parts. Phase A rows carry budgets 1000/2000/3200 (`training/LOG.md`), so at least the budget change was in effect. Whether the other changes were in effect when phase A was generated is (unverified). The same commit changed the training side: `training/curriculum/rt.py` was re-ported to the frozen `situation-v1` wording (relation phrasing such as "started 0.09s after #6", "pending local change" fact, error-rate text, slug-id signatures, budget-shaped sections via `section_limits`/`to_state`; compact questions and `transient` were already in `rt.py` before the tag, at a53dd38), `fmt.js_numbers` was added and applied in `generate.py`, and `eval_runtime.py` gained `by_budget`. `cur4` (300k rows, seed 5, 80% runtime-exact) was generated with that wording (`training/LOG.md`). Curriculum sets made earlier (`cur1`, `cur2`, `cur3`) predate it.

| change in … | invalidates | required follow-up |
|---|---|---|
| `situation/{build,facts,describe,serialize,questions}.ts`, `util.ts` formatting/redaction, `state/hub.ts` change summaries, signature normalization, baselines/profiles numbers that appear in text | model input text | regenerate SIM data, re-port `training/curriculum/rt.py`, retrain, re-eval, re-export; new freeze tag |
| `DEFAULT_DIAGNOSES`, `BUILTIN_ACTIONS` descriptions, `ACTION_INSTRUCTIONS`, `DIAGNOSIS_INSTRUCTIONS`, `TRIGGER_ACTIONS` membership/order, compact thresholds | model input text and label space (and `by_header` keys) | same as above; also update copies in `sim/src/types.ts` (`PASSIVE`, `DIAGNOSES`), `sim/src/world/scenario.ts` (`DEFAULT_DIAGNOSES`, `DIAG_PARA`), `sim/src/run/transform.ts` (`ACTION_PARA`), `sim/src/oracle/cost.ts` (`TIER`), `fmt.py`, `rt.py`, `eval_runtime.py` (`TIER`, `PASSIVE`) |
| `sectionLimits`, `STATE_CHAR_BUDGET`, auto budget mapping, scenario budget weights | situation length distribution | regenerate data, retrain; check token percentiles vs `max_len` |
| triage / trigger conditions (`learn`, `runtime.ts`) | which situations get recorded (distribution), not text | regenerate data; retrain recommended |
| `model/serialize.ts`, `pyutil.ts`, `tokenizer.ts`, `packer.ts`, `FEEDS` | token ids | change `jev_local` in lockstep, re-run parity tests; retrain if the Python side changed |
| `tokenizer.json` (pruning), heads, graph inputs/outputs | the model | retrain/re-export; `meta.json` `inputs`/`outputs`/`markers` |
| `calibrate.ts` math or `calibration.json` | answers, not text | re-run `eval_runtime.py`; check `calibrate.test.ts` parity |
| `sim/src/oracle/{cost,diagnose}.ts`, `trajectory.ts`, `transform.ts`, `ask/questions.ts`, `scenario.ts` splits/vocab | labels/targets | regenerate data, retrain (`meta.cost_futures` lets you re-derive action labels offline without re-simulating) |
| `training/curriculum/{rt,fmt,rows}.py`, scenario modules | curriculum text/labels (training distribution, not runtime text) | regenerate the curriculum set (e.g. a new `curN`), update the mixture, retrain; `rt.py` must still equal the runtime's text |
| `eval_runtime.py` metrics, `export_runtime.py` graph surgery/quantization | evaluation numbers / the ONNX files, not the trained weights | re-eval or re-export; re-run `test_export_runtime.py`, `ortweb/validate.mjs`, the runtime parity tests |
| `decide/policy.ts` thresholds, host/loader/worker, `EvaluateRequest.subject/priority/timeoutMs` | nothing the model sees | mirror the gate in `eval_runtime.py` if the gate changes |

### Recipes

1. **Change wording the model reads** (a fact, sentence, description or instruction):
   1. Edit `packages/runtime/src/situation/*`.
   2. Update `test/situation.test.ts`/`test/budget.test.ts` expectations and the STATUS.md examples.
   3. Mirror the change in `training/curriculum/rt.py`.
   4. Regenerate SIM data (`bash sim/scripts/final.sh a`) (ask the user first).
   5. Retrain, then run `final_post.sh` (eval → calibration → export).
   6. Tag a new freeze. Coordinate with SIM and TRAIN first (`training/NEEDS.md` item 5).
2. **Add a diagnosis label:**
   1. Add it to `DEFAULT_DIAGNOSES` (order = option order; `expected` stays first).
   2. Teach the sim to emit it (`sim/src/oracle/diagnose.ts`).
   3. Add it to `sim/src/types.ts` -> `DIAGNOSES`, `scenario.ts` -> `DEFAULT_DIAGNOSES`/`DIAG_PARA`, `fmt.py` -> `DIAG_DESC` (`fmt.DIAGNOSES` is derived from it), `rt.py` -> `DIAGNOSES`.
   4. Regenerate data and retrain. Without retraining the model never picks it reliably.
3. **Add a built-in action:**
   1. Add it to `BUILTIN_ACTIONS` + `TRIGGER_ACTIONS` + `builtinApplicable` + the executor ([decide-policy-actions.md](runtime/decide-policy-actions.md)).
   2. Add its tier to `cost.ts` `TIER`, `fmt.TIER`, `eval_runtime.TIER`, `ACTION_PARA`, `fmt.ACTION_DESC`, `fmt.TRIGGER_ACTIONS`, `rt.py` `ACTIONS`/`TRIGGER_ACTIONS`, `eval_runtime.PASSIVE` and `sim/src/types.ts` -> `PASSIVE` (passive actions), and `sim/src/run/fake-runtime.ts` (`ACTIONS`/`DESC`, tests only).
   3. Make the sim able to force it, then regenerate and retrain.
4. **Standing questions (from `rt.question` or a plugin) or custom actions** need no retrain to run: the model reads the description. Quality is unmeasured, though. Check with `runtime.ask`/the demos.
5. **Change budgets or limits:** keep `rt.py` `section_limits`/`to_state` identical, including JS half-up rounding. Check token lengths: TRAIN measured about 2.4 chars/token (`training/NEEDS.md` 6a), so 3,200 chars ≈ 1,300+ tokens.
6. **Re-calibrate only:** `eval_runtime.py --fit-split dev --write-calibration cal.json`, then `export_runtime.py --calibration cal.json`. No retrain. The text does not change, so the freeze is unaffected.
7. **Change `max_len`:** train with `--max-len N`. The export copies it into `meta.json`, so the runtime positions limit follows automatically.
8. **Tests to run** (runtime vitest runs locally under the run policy in AGENTS.md; ask the user before the sim tests, training pytest, `validate.mjs` and anything that needs a model download; see [where to run things](runtime/build-test-release.md#where-to-run-things)):
   - `packages/runtime`: `vitest run test/situation.test.ts test/budget.test.ts test/model/` (model parity tests read `GENCLASS_MODEL_DIR`, default `<repo>/.cache-model`, filled by `genclass-runtime fetch-model`; with a new export, its own `requests.json`/`pack_fixtures.json`/`torch_fixtures.json` replace the v0.1 fixtures automatically).
   - `sim`: `vitest run test/rows.test.ts test/determinism.test.ts test/oracle.test.ts`.
   - `training/tests/test_curriculum.py`, `training/tests/test_export_runtime.py`.
   - `training/ortweb/validate.mjs <export dir> q8`.

## Tests

| test file | what it asserts |
|---|---|
| `packages/runtime/test/situation.test.ts` | one situation per trigger (mutation, request, failure, stall, inconsistency, transition, error): key order, section caps (facts ≤ 12, timeline ≤ 16, state ≤ 8), `stateChars` ≤ 3,200, a `diagnosis` question, and regexes on selected facts (not the whole text; the full text is printed with `console.log`, which is where the STATUS.md examples come from); `ask`: `situation()` is side-effect free (same state twice, no new ops or events) and has trigger `ask`; serializer: an over-budget input stays ≤ 3,200 chars with `timeline: "none"`, an under-budget one keeps all 16 timeline lines and gives `"none"` for its empty sections; same scripted inputs → identical situations |
| `packages/runtime/test/budget.test.ts` | section limits compact 1,100 / full 3,200 / linear; every budget shapes sections and keeps top facts; compact questions keep ≤ 24-char overrides; determinism; auto budget 3,200 / 1,000–2,000; `max_tokens_exceeded` shrinks auto budgets |
| `packages/runtime/test/model/serialize.test.ts` | `state_segments`/`question_block` on edge cases vs Python fixtures; Python number printing; `json.dumps` separators; `str.strip` whitespace; JSON-round-trip semantics; situation-shaped states; `round` half-even |
| `packages/runtime/test/model/packer.test.ts` | identical ids/positions/groups/marker positions/question order vs the Python packer on the parity requests; plain-object criteria = Python-ordered Maps; special tokens stay text; marker ids from files, meta must agree; typed `max_tokens_exceeded` (positions vs total); Map label order, empty choices rejected; feed plan + unpack; HF tokenizer edge cases (full and pruned vocab); speed |
| `packages/runtime/test/model/calibrate.test.ts` | sha1 header keys = Python; reproduces PyTorch calibrated probabilities (< 1e-9); v1 and v2 files; confidence/score math; answer shapes and tie-break |
| `packages/runtime/test/model/engine.test.ts` | end-to-end TS packer → ORT (onnxruntime-node CPU, and onnxruntime-web 1.30 WASM single thread) → TS calibration vs PyTorch fixtures: within the export's own `parity.json` (agreement ≥ its count − 1, max logit diff < its value + 0.05) when the model directory has one, else ≥ 99% agreement and max logit diff < 1.0 (q8) / 0.1 (fp16); feeds exactly `meta.inputs` and rejects unknown ones |
| `packages/runtime/test/model/loader.test.ts`, `host.test.ts` | card parsing, plans, sha256 cache; host queueing/fail-open (see [model-host.md](runtime/model-host.md)) |
| `packages/runtime/test/browser/model.spec.ts`, `model-webgpu.spec.ts` (Playwright) | the model loads over WASM in a module worker and matches PyTorch, Cache Storage reuse, inline fallback, preload modes, WebGPU fallbacks (no adapter, no `shader-f16`, software adapter), latency at ~300–1,000 state tokens |
| `packages/runtime/test/fixtures/model/make_py_fixtures.py` | (generator, run on the VM) writes `py_fixtures.json` from jev_local `serialize`, HF `tokenizers`, `calibrate_logits` (v1 and v2 files) and `confidence` |
| `sim/test/rows.test.ts` | 40 trajectories produce valid CONTRACT-D rows: labels reference real options, dists sum to 1 (±0.01), noul p ∈ {0, 1}, score level in range, no `x-request-id` in states, passive-best share > 0.2, 0 prefix mismatches; splits hold out domains/families; transform renormalizes |
| `sim/test/determinism.test.ts` | same seed → identical rows and final states; forced replays reproduce every prefix |
| `sim/test/oracle.test.ts` | stale overwrite → discard best; single-point credit; intentional double add → passive/expected; duplicate POST → block/coalesce; outage → delay/serve_cached; benign concurrency → apply; sharp vs soft labels; exact ties favour passive |
| `training/tests/test_curriculum.py` | rows valid against the trainer's label parser and deterministic; held-out domains/templates only in test; label consistency; version semantics |
| `training/tests/test_export_runtime.py` | int8 embedding close and valid (zero rows survive); Gemm→MatMul rewrite preserves outputs; end to end: card bytes/sha256 match, meta markers/`cls_id`/`sep_id` = tokenizer added tokens, fp32 parity < 1e-3, R17 q8 < 12 MB |
| `training/tests/test_prune_vocab.py` | the pruned tokenizer's layout matches ettin, encodes every sample, and gives identical model outputs where tokenization is unchanged (needs the v1 checkpoint: `GC_V1_CKPT`, `GC_BASE_32M`) |
| `training/ortweb/validate.mjs` | (script: `node validate.mjs <export dir> [variant=q8] [maxRequests=60]`) onnxruntime-web WASM + node on the export, feeds from `pack_fixtures.json`, vs `torch_fixtures.json`; writes `<export dir>/ortweb_report_<variant>.json` (e.g. `ortweb_report_q8.json`; the script's header comment still says `ortweb_report.json`) |

## Drift and open issues

- **MODEL_CARD.md** (`packages/runtime-model/MODEL_CARD.md`):
  - It lists 9 diagnoses (no `transient`); the code has 10.
  - It says the runtime acts when "`p(action) ≥ 0.9` (guard) / `0.8` (heal)". The code gates on the **summed** probability of the permitted non-passive actions (`decide/policy.ts` -> `gate`, mirrored in `eval_runtime.py`).
  - Accuracy numbers are stage 1c; the shipping model is the final-round model ([EVAL.md](../../training/EVAL.md) "Final round 1" is "(in progress)").
- **training/README.md**:
  - §2 says "diagnosis (9 labels …)"; `fmt.DIAG_DESC` has 10.
  - §4 says the gate is "non-passive top action, p ≥ 0.9 guard / 0.8 heal"; `eval_runtime.py` implements the summed-mass gate.
- **docs/runtime/CONTRACT.md §6**:
  - It says the action instructions are "What should the runtime do with <subject>?". The code uses fixed per-trigger sentences without the subject (`ACTION_INSTRUCTIONS`).
  - It gives the budget as "≤ 1,000 tokens; truncate timeline first, then state, then facts". The code uses characters (3,200 default, device-sized) and the 5-step shrink plus fact/trigger shortening.
  - Its `runtime.situation()` shape omits `salient`, `facts`, `compact`, `budget`.
- **`types.ts` -> `InitOptions.situation` comment**: says "wasm 1,100 + 300 per extra thread … 2,000". The code gives 1,000 / 1,333 / 1,667 / 2,000 (`situationBudget`). STATUS.md and the tests match the code.
- **`serialize.ts` header comment**: assumes ≈ 3.2 chars/token. TRAIN measured 2.4 chars/token on SIM states (mean 963, p95 1,340, max 1,569 state tokens), so 3,200 chars ≈ 1.3–1.4× the intended 1,000 tokens (`training/NEEDS.md` 6a, open ASK).
- **sim/NEEDS.md preamble and STATUS.md "How to drive it headless"** show `thresholds {guard: 0, heal: 0}`. `sim/src/run/rt.ts` uses 0.5 (changed after the tag; see the gotcha). sim/NEEDS.md's note that `transient` is missing from `DEFAULT_DIAGNOSES` is stale.
- **`training/curriculum/rt.py` -> `to_state`**: the last-resort fact shortening floor is 40 chars (runtime 60), and the trigger is never shortened. This only matters when a single fact or the trigger exceeds the budget.
- **`rollback` description vs effect** (see gotchas): fixing it is a model-input change.
- **`docs/runtime/ARCHITECTURE.md`** lists diagnoses with `transient` before `slow`. The code order puts it last. Order affects only answer key order and tie-breaks.
- **Not published:** `@genclass/runtime-model@0.1.0`. The package directory holds only `MODEL_CARD.md`, so the default base URL cannot serve a model until OPEN_TASKS item 8 lands. OPEN_TASKS says the alpha takes no actions until then.
- **Open (OPEN_TASKS.md / training/NEEDS.md):**
  - final training round 1 on phase A, then round 2 on A + B;
  - choose R17 (WASM) vs R32 (WebGPU);
  - device-based model selection in the card;
  - clean-run rows (`meta.clean`) requested by TRAIN (ASK);
  - thin `conflict`/`transition` classes;
  - label noise on benign request rows (OPEN_TASKS: 66% of passive-best request rows put ≥ 0.9 on passive; phase A `sim/samples/stats-final-a.json` `label_sharpness.request.passive_mass_ge_0_9` = 0.676).
- **`meta.json.name`** is `<name>-<version>`, while the runtime reports `<card.name>@<card.version>` and ignores `pad_id` and, in practice, `meta.name` (an `Engine` fallback only; `backend.ts` -> `createEngine` always passes a name). This is harmless but confusing.
- **`training/curriculum/rt.py` vs `util.ts` number formatting** (see gotchas): half-even vs half-up on exact binary ties in `secs`/`rel`/`fmt_num`, so runtime-exact curriculum rows are not always byte-identical to the runtime. `rt.py.to_state` also uses Python `round(budget)` where the runtime uses `Math.round` (irrelevant for integer budgets).
- **`model/tokenizer.ts` header comment** says non-special added tokens are split out first and the normalizer runs on the rest; `Tokenizer.encode` normalizes the whole text first, then splits added tokens. Likely equivalent for the shipped NFC normalizer and ASCII added tokens (unverified; OPEN_TASKS.md reports packing identical to Python on all 50 v0.1 fixtures); it would matter for a normalizer that rewrites added-token text (e.g. `Lowercase` and `[unusedN]`).
- **`export_runtime.py` parity `gate08`/`gate09`** compare the max choice probability per question, not the runtime's summed non-passive mass gate. They are a proxy, not the product gate.
- **docs/runtime/CONTRACT.md §11** says option order/subsets and diagnosis paraphrases/subsets are randomised "per row". In code, order/drop is per row (`transformQuestions`) but description wording and diagnosis subsets are per trajectory (runtime `vocabulary` from `scenario.ts`).
- **MODEL_CARD.md status line** ("stage 1c final, stage 2 piloted on pre-freeze SIM data"; "`calibration.json` (per-kind temperatures)") predates final round 1; the per-kind part still matches what `final_post.sh` writes.

## Related docs

- [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md): facts catalogue, triage salience, section line details, redaction
- [runtime/model-host.md](runtime/model-host.md): worker/inline host, loader, backends, CLI, errors
- [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md): queue, gate, action execution, reports
- [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md): `vocabulary`, `situation.budget`, `ask`/`decide`, plugins
- [runtime/build-test-release.md](runtime/build-test-release.md): where and how tests run
- [sim.md](sim.md), [training.md](training.md), [genclass-model-lineage.md](genclass-model-lineage.md) (jev_local Python reference), [status-and-known-issues.md](status-and-known-issues.md), [glossary.md](glossary.md)
- Source docs: [docs/runtime/CONTRACT.md](../runtime/CONTRACT.md) §5–§8, §10, §11; [docs/CONTRACT.md](../CONTRACT.md) §B (packing, heads) and §D (row format); [packages/runtime/STATUS.md](../../packages/runtime/STATUS.md) (example situations); [sim/README.md](../../sim/README.md); [training/README.md](../../training/README.md); [training/NEEDS.md](../../training/NEEDS.md); [packages/runtime-model/MODEL_CARD.md](../../packages/runtime-model/MODEL_CARD.md)
