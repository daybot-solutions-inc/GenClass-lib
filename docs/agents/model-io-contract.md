# Model I/O contract: situation text -> packed request -> model heads -> calibrated answers (runtime, sim and training)

> **Scope:** `packages/runtime/src/situation/{serialize,questions,build,describe,env}.ts` (+ the delivery text in `facts.ts` -> `predictedText` and `conflicts.ts` -> `predictedWrites`), `packages/runtime/src/model/{packer,serialize,tokenizer,calibrate,engine,protocol,loader}.ts` (+ `pyutil.ts`), the model seam of `packages/runtime/src/types.ts`, `sim/src/ask/questions.ts`, `sim/src/gen.ts`, `sim/src/gen/*.ts`, `sim/src/oracle/cost.ts`, `sim/src/run/{transform,rt,latent,onpolicy}.ts`, `training/export_runtime.py`, `training/eval_runtime.py`, `training/curriculum/{fmt,rows,rt}.py`, the T1/teacher scripts (`training/{t1_relabel,label_teacher,collect_gain,eval_gain}.py`), `packages/runtime-model/MODEL_CARD.md`, the example situations in `packages/runtime/STATUS.md`. Python reference counterparts in `jev_local/` and `scripts/genclass_export.py` are cited where they define the other side of the contract.
> **Read this when:** you change any text the model reads (facts, subject sentences, timeline/state/stats lines, question instructions, option descriptions, diagnosis labels, budgets); you change the packer, tokenizer, feeds, heads or calibration; you change how the sim labels rows (gold, unlabeled, on-policy) or how training reads them; you export or ship a model directory; you need to know whether a change forces regenerating data and retraining.
> **Source of truth:** the code. Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins.

## TL;DR

- One pipeline, three consumers. The **runtime** builds a situation (`JevState` + typed questions). The **model host** packs it into token ids, runs the ONNX graph and calibrates the logits into answers. The **sim** (and the real-browser corpus in `realapps/`, see [realapps.md](realapps.md)) records the same `state`/`questions` verbatim from the real runtime, attaches labels, and **training** packs them with the Python reference (`jev_local`). Every step on the TypeScript side is a byte-exact port of the Python step, so train/serve parity is a hard invariant.
- **Format version: `situation-v2`** (tag on 6e5e86e, "Runtime batch 5", 2026-10-07 23:26 -0400). The old `situation-v1` tag (1a77558) is the format of round-1 data and the round-1 model (R17-final1), which therefore does **not** match the current runtime. `git diff situation-v2 b435acb -- packages/runtime/src/situation packages/runtime/src/util.ts packages/runtime/src/state packages/runtime/src/learn` is empty; the model side (`src/model`, `jev_local`, `scripts/genclass_export.py`, `export_runtime.py`) is unchanged since `situation-v1`.
- The **situation** is a 7-key object in fixed order: `app, trigger, facts, in_flight, timeline, state, stats`. Values are strings or arrays of strings (one line each); empty arrays become `"none"`. It is sized by a **character budget** (`STATE_CHAR_BUDGET` **2,400** since v2, was 3,200; compact 1,100; floor 500) and shrunk deterministically (`toJevState`).
- **Triggers (8 + ask):** `mutation, request, delivery, failure, stall, inconsistency, transition, error`, plus `ask`. **`delivery` is new in v2:** a fetch/XHR response or a WebSocket/EventSource message about to reach the app; actions `deliver` (passive), `discard`, `defer`, with trigger-specific descriptions (`TRIGGER_DESCRIPTIONS`). Store writes are no longer held by default, so most stale-response decisions are now `delivery`, not `mutation`.
- **Questions** are Jev-wire objects `{type, instructions, criteria}` of kind `choice | noul | score`. Standing qids are `diagnosis` (always, except on `ask`) and `action` (only when ≥ 2 actions apply). Qids are never shown to the model. At budgets ≤ 1,400 chars, options are bare labels (`null` descriptions, **compact questions**).
- **Diagnosis labels (10, in order):** `expected, stale, conflict, duplicate, inconsistent, failing, slow, overload, unusual, transient`. **Actions:** 15 built-ins; passive per trigger `apply|send|deliver|deliver|wait|ignore|ignore|ignore`.
- **Packing:** `[CLS] key: text [SEP] … | [Q] header [O] item … | [Q] …`. Positions restart per item; `q_group`/`i_group` drive block attention, so option order and unrelated questions cannot change an answer. Limits: state + longest branch ≤ `meta.max_len` (default 1536), total ≤ `meta.max_total` (default 8192).
- **Heads → answers:** raw logits (τ = 1) → calibration (`calibration.json`: by-header, by-bucket, τ(K), per-kind temperature; Platt for noul) → `Answer`. The runtime gate reads only `probabilities` and the diagnosis `choice`. Since f3636b2 the default mode is `observe`, so by default no answer changes execution.
- **SIM rows now come in three kinds** (`sim/src/gen.ts`): **gold** (counterfactual soft `action` dist + hard `diagnosis`; ids `sim-…`), **unlabeled** (`--unlabeled`: every decision point of a base run, diagnosis only; ids `u-…`), **on-policy** (`--on-policy <model dir>`: a real export decides through the production gate, DAgger rows; ids `p-…`). Labels gained **S1** (never `expected` where acting clearly wins; `meta.diagnosis_s1`) and **S2** (re-seeded futures re-draw what the runtime cannot observe; `src/run/latent.ts`).
- **Training-side gains (T1):** `training/t1_relabel.py` derives expected-gain labels from `meta.cost_futures` (`gain(a) = mean c(passive) − mean c(a) − premium`), `eval_gain.py` scores gate policies by captured gain, `label_teacher.py` soft-labels unlabeled rows with a teacher.
- **Model directory** (`export_runtime.py`, unchanged): `model.json` (card `genclass-runtime-model/1`, bytes + sha256), `<name>-q8.onnx` (WASM), `<name>-fp16.onnx` (WebGPU + `shader-f16`), `tokenizer.json`, `calibration.json`, `meta.json`, and parity fixtures. **No situation-v2 model exists yet** and `@genclass/runtime-model` is not published.

## Files

| path | role | key exports / entry points |
|---|---|---|
| `packages/runtime/src/situation/build.ts` | Assembles a situation: subject sentence, facts, in-flight, timeline, state, stats, applicable actions, standing questions, triage flag | `buildSituation`, `subjectOf`, `subjectRef`, `relatedInFlight`, `isTrigger`, `BuildOptions`, `BuiltSituation`, `ActionOption` |
| `packages/runtime/src/situation/serialize.ts` | Budget-shaped `JevState` (key order, section and line limits, shrink order) | `toJevState`, `sectionLimits`, `stateChars`, `stateText`, `STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `MIN_BUDGET`, `LIMITS`, `SituationParts`, `SectionLimits` |
| `packages/runtime/src/situation/questions.ts` | Action catalogue, per-trigger actions/passive/instructions/descriptions, diagnosis vocabulary, standing-question builder | `BUILTIN_ACTIONS`, `BuiltinAction`, `TRIGGER_ACTIONS`, `PASSIVE`, `ACTION_INSTRUCTIONS`, `TRIGGER_DESCRIPTIONS`, `DIAGNOSIS_INSTRUCTIONS`, `DEFAULT_DIAGNOSES`, `COMPACT_QUESTIONS_BUDGET`, `diagnosisVocabulary`, `actionDescription`, `buildQuestions` |
| `packages/runtime/src/situation/describe.ts` | How ops/events are named in subject sentences, facts and timeline lines | `opPhrase`, `opLabel`, `userPhrase`, `statusText`, `eventLine` |
| `packages/runtime/src/situation/env.ts` | Read-only view of the runtime used by situation building; subject specs per trigger | `SitEnv`, `SubjectSpec`, `DeliverySpec`, `CreateRec`, `OutcomeRec`, `ReqMeta`, `FailureInfo`, `Violation`, `ErrorInfo` |
| `packages/runtime/src/situation/conflicts.ts` | (detail in [learn-situation-triage.md](runtime/learn-situation-triage.md)) predicted write set P and newer-data / pending-local-change conflicts | `predictedWrites`, `matchFields`, `conflictsOn`, `Predicted`, `Conflict`, `PENDING_WINDOW_MS` |
| `packages/runtime/src/situation/{facts,content,evidence}.ts` | (out of scope, see [learn-situation-triage.md](runtime/learn-situation-triage.md)) fact computation and ordering; v2 content facts F1–F3, evidence facts F5–F7/F9, read-your-writes | `computeFacts`, `orderFacts`, `predictedText`, `MAX_FACTS`; `contentFacts`, `analyzeBody`; `scopeFacts`, `cadenceFact`, `markFacts` |
| `packages/runtime/src/util.ts` | Formatting helpers that appear in the text (`secs`, `rel`, `fmtNum`, `truncate`, `describe`); redaction by leaf field since v2 | `secs`, `rel`, `truncate`, `describe`, `isSensitivePath`, `defaultRedact` |
| `packages/runtime/src/types.ts` | Model seam types (CORE + MODEL change together) plus the situation/plugin types the text depends on | `JevState`, `Question`, `Answer`, `AnswerOf`, `NoulAnswer`, `ChoiceAnswer`, `ScoreAnswer`, `TriggerKind`, `ModelStatus`, `EvaluateRequest`, `DecisionProvider`, `SubjectRef`, `Situation`, `SituationDraft`, `Fact`, `FactKind`, `Vocabulary`, `StandingQuestion`, `ActionDef`, `Tier` |
| `packages/runtime/src/model/serialize.ts` | Port of `jev_local/serialize.py`: state segments and question blocks with Python-after-JSON value semantics | `stateSegments`, `segmentText`, `questionBlock`, `questionEntries`, `entryText`, `toJsonValue`, `pyJson`, `criteriaEntries`, `stateText`, `MAX_ARRAY_SEGMENTS`, `DEFAULT_NOUL_INSTR`, `DEFAULT_CHOICE_INSTR`, `DEFAULT_SCORE_INSTR`, `QBlock`, `Segment`, `BlockKind`, `WireQuestion` |
| `packages/runtime/src/model/pyutil.ts` | Python formatting semantics (`str.strip`, float `repr`, `round`) | `pyStrip`, `pyNumber`, `pyFloatRepr`, `pyRound`, `clip01` |
| `packages/runtime/src/model/tokenizer.ts` | Byte-level BPE over a HF `tokenizer.json` (`encode_special_tokens = True` semantics) | `Tokenizer`, `bytesToUnicode`, `TokenizerJson` |
| `packages/runtime/src/model/packer.ts` | Port of `jev_local/engine/encoder/tokenize_pack.Packer` (FastEngine length semantics) + ONNX feed plan | `Packer` (`pack`, `measure`, `encode`, `stateIds`), `PackerOptions`, `MARKERS`, `Marker`, `STATE` (= −1), `Packed`, `PackedQuestion`, `planInputs`, `unpackLogits`, `FeedPlan`, `HeadOutput` |
| `packages/runtime/src/model/engine.ts` | Packer + ORT session + calibration → answers; builds exactly the inputs `meta.json` declares | `Engine` (`evaluate`, `logits`, `release`), `EngineOptions`, `FEEDS`, `ModelMeta`, `EngineResult`, `tensorFloats`, `OrtLike`, `OrtSessionLike`, `OrtTensorLike` |
| `packages/runtime/src/model/calibrate.ts` | Port of `jev_local/engine/encoder/calibrate.py` lookup and `jev_local/confidence.py` answer math | `Calibration`, `parseCalibration`, `headerKey`, `kBucket`, `tauFor`, `noulAffine`, `calibrateLogits`, `buildAnswer`, `Precision`, `normalizeProbs`, `choiceConfidence`, `scoreConfidence`, `K_BUCKETS`, `BUCKET_CLAMP` |
| `packages/runtime/src/model/protocol.ts` | Main thread ↔ worker messages (`state`, `questions` only; trigger/subject never cross) | `ToWorker`, `FromWorker`, `EvaluateOk` |
| `packages/runtime/src/model/loader.ts` | Model card parsing, plan order, downloads with sha256 | `parseCard`, `CARD_FORMAT`, `DEFAULT_CACHE_NAME`, `cardId`, `planOrder`, `fetchFile`, `fetchCard`, `ModelCard`, `FileSpec`, `VariantSpec`, `FileRole`, `Plan` |
| `sim/src/gen.ts` | CLI: worker pool, shard merge, `stats.json`, `--sample`, row mode `--unlabeled` / `--on-policy <dir>` | `parse`, `main`, `mergeParts` (module-internal; nothing is exported) |
| `sim/src/gen/trajectory.ts` | One scenario → decision rows, diagnosis-only rows, ask rows (gold / unlabeled / on-policy); counterfactual costs; S1 | `generateTrajectory`, `pointCosts`, `diagnosisFromOutcome`, `metaOf`, `S1_GAP`, `GenOptions`, `PointStat`, `TrajectoryOut` |
| `sim/src/gen/worker.ts` | Worker thread: writes `shards/<split>.w<id>.jsonl` or `parts/part-NNNNNN.<split>.jsonl`; loads the on-policy model | (module) |
| `sim/src/gen/examples.ts` | `sim/samples/EXAMPLES.md` renderer | `renderExamples` |
| `sim/src/oracle/cost.ts` | Run cost vs the ideal run; soft action label; divergence probes used by S1 | `W`, `LABEL`, `TIER`, `runCost`, `actionLabel`, `clientDist`, `serverDist`, `valueDist`, `divergenceArea`, `relationViolation`, `clientDivergenceAt`, `divergedFieldsAt`, `CostBreakdown`, `ActionLabel` |
| `sim/src/oracle/diagnose.ts` | (detail in [sim.md](sim.md)) hard `diagnosis` label from the sim's knowledge; `delivery` filled after the run | `diagnose`, `diagnoseFailure` |
| `sim/src/run/latent.ts` | S2: what a re-seeded future re-draws after the decision | `S2`, `FutureSpec`, `futureProfile`, `futureStepTimes` |
| `sim/src/run/onpolicy.ts` | On-policy decider: the runtime's own model host (built into `sim/dist/model-host`) reading an export directory | `loadModelDecider` |
| `sim/src/world/scenario.ts` | (detail in [sim.md](sim.md)) scenario seed → domain (115), budget, chaos (8 regimes), clean runs, ask times, vocabulary paraphrases, split | `buildScenario`, `splitOf`, `TEST_DOMAINS`, `TEST_PATTERNS`, `TEST_FEATURES`, `DOMAINS`, `DEFAULT_DIAGNOSES` |
| `sim/src/ask/questions.ts` | Programmatic `ask` questions with exact labels | `askQuestions`, `AskQ` |
| `sim/src/run/transform.ts` | Post-transform of recorded questions (shuffle/drop action options); action paraphrases | `transformQuestions`, `ACTION_PARA` |
| `sim/src/run/rt.ts` | Options the sim passes to `createRuntime` | `createOptions`, `realRuntimeFactory`, `RuntimeOptions` |
| `sim/src/types.ts` | Sim mirror of the seam + row schema | `Row`, `Label`, `PASSIVE`, `DIAGNOSES` |
| `sim/scripts/relabel.py` | Re-derive gold action labels from `meta.cost_futures` (mirrors `actionLabel`) | — |
| `training/curriculum/rows.py` | Stage-1 curriculum rows (decision / ask), varied style or runtime-exact; maps actions when `rt.render` renders a delivery | `decision_row`, `ask_row`, `situation_state`, `action_question`, `diagnosis_question`, `RENAMES` |
| `training/curriculum/fmt.py` | Surface variation (key names, time formats, paraphrase templates with held-out tails), vocab copies | `Style`, `TEMPLATES`, `ACTION_DESC`, `DIAG_DESC`, `TRIGGER_ACTIONS`, `TIER`, `DISTRACTOR_ACTIONS`, `js_numbers`, `pick_from` |
| `training/curriculum/rt.py` | Python port of the runtime's situation text, **frozen at `situation-v2`** (delivery, conflicts, F1–F3, F5–F7/F9, 2,400 budget) | `render`, `to_state`, `section_limits`, `size_chars`, `delivery_spec`, `predicted_text`, `DIAGNOSES`, `ACTIONS`, `TRIGGER_DESCRIPTIONS`, `TRIGGER_ACTIONS`, `ACTION_INSTR`, `BUDGETS`, `P_DELIVERY`, `DELIVERY_ACTION`, `STATE_CHAR_BUDGET` |
| `training/curriculum/generate.py` | (detail in [training.md](training.md)) curriculum CLI: row ids, `js_numbers`, validation through the trainer's own parser | `make_row`, `_validate`, `work`, `main` (`--p-runtime` → env `GC_P_RUNTIME`) |
| `training/prune_vocab.py` | (detail in [training.md](training.md)) prunes the ettin tokenizer to the shipped `tokenizer.json` (16,000 merges) | — |
| `training/eval_runtime.py` | Accuracy, calibration fit (`calibration.json`), §8 gate metrics incl. clear-case recall | `fit_calibration`, `decision_metrics`, `question_metrics`, `main` |
| `training/t1_relabel.py` | T1: expected-gain action labels from `meta.cost_futures` (`meta.egain`) | `gains_of`, `main` |
| `training/label_teacher.py` | Teacher soft labels for (unlabeled) rows; `meta.teacher` | `main` |
| `training/collect_gain.py`, `training/eval_gain.py` | Raw logits (+ `gain_pred` from a gain head) and expected-gain evaluation of gate policies | `main` |
| `training/export_runtime.py` | Checkpoint → ONNX q8/fp16 + model directory + parity fixtures | `make_q8`, `make_fp16`, `quantize_embedding`, `gemm_to_matmul`, `requests_from_rows`, `main` |
| `jev_local/serialize.py`, `jev_local/engine/encoder/tokenize_pack.py`, `jev_local/engine/encoder/calibrate.py`, `jev_local/engine/encoder/heads.py`, `jev_local/train/train.py` | Python reference: serialization, packing, calibration, heads, label → target | `state_segments`, `question_block`, `Packer.pack`/`pack_split`, `header_key`, `DecisionHeads`, `HeadOut`, `build_plan`, `parse_target`, `encode_example` |
| `scripts/genclass_export.py` | ONNX graph definition and feed plan (imported by `export_runtime.py`) | `ExportModel`, `plan_inputs`, `unpack` |
| `packages/runtime-model/MODEL_CARD.md` | Model card (only file in that package today) | — |
| `packages/runtime/test/fixtures/model/` | Parity fixtures for the TS ports: `py_fixtures.json` (made by `make_py_fixtures.py`), v0.1 `requests50.json` / `pack_fixtures.json` / `torch_fixtures.json`, `make_webgpu_variants.py` | read by `test/model/helpers.ts` |
| `packages/runtime/STATUS.md` ("Example situations") | Real rendered v2 situations: the stale typeahead **delivery** at 1,000 chars (951, compact questions) and 2,000 chars (1,760); full-budget (2,400) examples per trigger and per new fact | copied from `test/budget.test.ts`, `test/situation.test.ts`, `test/delivery.test.ts`, `test/content.test.ts` |

## Concepts and data structures

Terms used here beyond the shared terminology (see [glossary.md](glossary.md)):

- **Wire request**: `{state, questions}`, the only thing the model host uses. `EvaluateRequest.trigger`, `subject`, `priority` and `timeoutMs` are scheduling/test metadata and never reach the packer (`protocol.ts` -> `ToWorker` carries only `state`, `questions`).
- **Segment**: one `key: text` unit of the state (`model/serialize.ts` -> `Segment`). **QBlock**: one question rendered as `header` + `items` + `labels`.
- **Header**: the question's `instructions` text. **Item**: one option (choice), level (score), or the true/false criterion (noul).
- **Marker**: special token `[Q] [O] [L] [T] [F]` whose hidden state feeds a head. **Branch**: state + one question's header + one of its items (what `max_len` bounds).
- **Raw logits**: head outputs at τ = 1. **Header key**: `sha1(header)[:12]`, the key of `calibration.json.by_header`.
- **Compact questions**: options with `null` descriptions when the situation budget ≤ `COMPACT_QUESTIONS_BUDGET` (1,400).
- **Format tag**: a git tag that freezes the text the model reads (`situation-v1`, `situation-v2`). Training data and a model are valid only for the tag they were generated/trained on.
- **Delivery**: v2 trigger raised when a response or push message is about to reach the app. **Predicted write set P**: what the delivering op's signature wrote before (transition profile, else the last completion, else unknown; `conflicts.ts` -> `predictedWrites`). It is stated in the trigger sentence.
- **CONTRACT-D row**: one JSONL training example `{id, split, family, state, questions, labels, meta}`. **Gold / unlabeled / on-policy**: the three sim row kinds (`GenOptions.mode`).
- **Counterfactual cost**: cost of a re-run with one action forced at a decision point, measured against the ideal run (`sim/src/oracle/cost.ts` -> `runCost`). **Future**: one re-seeded continuation after the decision (common random numbers across actions). **S2**: re-seeded futures also re-draw latents the runtime cannot observe (`latent.ts`).
- **S1**: a label rule: a decision where a non-passive action clearly wins (passive's adjusted gap ≥ `S1_GAP` = 1.0) never keeps the diagnosis `expected` (`trajectory.ts` -> `diagnosisFromOutcome`).
- **Tier premium / tie rule**: label-time adjustments that favour passive (`LABEL` in `cost.ts`). **Gain** (T1): `gain(a) = mean_f c(passive) − mean_f c(a) − premium(tier(a))`, the training-side expected advantage of acting.

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
type TriggerKind = "mutation" | "request" | "delivery" | "failure" | "stall" | "inconsistency" | "transition" | "error" | "ask";
interface EvaluateRequest { trigger: TriggerKind; state: JevState; questions: Record<string, Question>;
                            priority?: number; subject?: SubjectRef; timeoutMs?: number }
interface DecisionProvider { readonly status: ModelStatus; ready(): Promise<void>;
  evaluate(req: EvaluateRequest): Promise<Record<string, Answer>>; onStatus?(fn): () => void; dispose?(): void }
```

`Situation` (returned by `runtime.situation()`, built in `build.ts`): `trigger, subject, state, questions, actions` (passive first), `salient`, `facts` (all ordered facts, ≤ 12, **not** budget-trimmed), `compact`, `budget`. The model reads `state.facts`, which may be shorter.

Other `types.ts` shapes on the model path (`Vocabulary`, `StandingQuestion.question` and `ActionDef.description` change the text the model reads):

```ts
interface Vocabulary { diagnoses?: Record<string, string>;            // replaces the default label set (expected re-added, plugin labels appended)
                       actions?: Partial<Record<string, string>> }    // per-action description override (all triggers)
interface StandingQuestion { id: string; on: TriggerKind[]; question: Question;
                             always?: boolean /* consult even when not salient */; onAnswer?(a, ctx): void }
interface ActionDef { name; description; on: TriggerKind[]; tier?: "guard" | "heal" /* default heal */;
                      risk?; applicable?(sit: SituationDraft): boolean; run(ctx) }
type AnswerOf<Q> = /* noul → NoulAnswer; choice → ChoiceAnswer<keyof criteria>; score → ScoreAnswer */
```

- **salient** (`build.ts` -> `buildSituation`): `triage === "always" || trigger === "ask" || facts.some(f => !f.neutral)`. **forced**: some standing question for this trigger has `always: true`. Neither is model input. Delivery salience (which conflicts are non-neutral, body comparison) is detailed in [learn-situation-triage.md](runtime/learn-situation-triage.md).
- **`SubjectRef`** (`build.ts` -> `subjectRef`; never serialized, the model host ignores it): mutation `{mutation, store, paths, cause?}`; request/failure/stall `{op}`; **delivery `{op, paths?, store?}`** (paths = conflicting fields, else the matched predicted ones; `store` = first path's store); transition `{op, paths, store?}`; inconsistency `{paths, store?, invariant?}`; error `{error: raw, op?}`; ask `{op?}` or `{store?}`.
- **`SituationDraft.delivery`** (`{channel: "response" | "websocket" | "eventsource", predicted, conflicts}`) is what plugin facts and `ActionDef.applicable` see; it is not model text by itself.
- **`EvaluateRequest.priority`** is queue order only; see [decide-policy-actions.md](runtime/decide-policy-actions.md).

### Model-side structures (`packages/runtime/src/model/`, unchanged since `situation-v1`)

| type | fields |
|---|---|
| `Segment` | `key` (`""` for a string state, object key, or `[i]`), `text` |
| `QBlock` | `qid`, `kind: "noul" \| "choice" \| "score"`, `header`, `items`, `labels` (choice labels in criteria order; score `"0".."n-1"`; noul `["true","false"]`) |
| `Packed` | `inputIds`, `positionIds`, `qGroup`, `iGroup`, `nState`, `qIndex: Map<qid, PackedQuestion>` |
| `PackedQuestion` | `kind`, `header`, `labels`, `qPos` (index of `[Q]`), `itemPos` (index of each `[O]`/`[L]`, or `[T]`,`[F]`) |
| `FeedPlan` | `choice {q, items, k}`, `score {q, items, k}`, `noul {q, t, f}` |
| `ModelMeta` (keys read) | `max_len`, `max_total`, `markers`, `cls_id`, `sep_id`, `inputs`, `outputs`; `name` only as the `Engine` fallback when no `name` option is passed; `pad_id` declared but unused |
| `Calibration` | `noul`, `choice`, `score` (τ > 0, default 1.0), `by_header`, optional `by_bucket`, `tau_k`, `noul_platt`, `bucket_clamp`, `version` |
| `ModelCard` | `format`, `name`, `version`, `license?`, `variants{name: {file, bytes?, sha256?, provider?, needs?}}`, `files{tokenizer, calibration, meta}` |

### Diagnosis vocabulary (`questions.ts` -> `DEFAULT_DIAGNOSES`, order is the option order; unchanged in v2)

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

### Actions per trigger (`questions.ts` -> `TRIGGER_ACTIONS`, `PASSIVE`, `ACTION_INSTRUCTIONS`, `TRIGGER_DESCRIPTIONS`, `BUILTIN_ACTIONS`; applicability in `build.ts` -> `builtinApplicable`)

| trigger | action header (exact) | actions, passive first | offered only when |
|---|---|---|---|
| `mutation` | What should the runtime do with this write? | `apply`, `discard`, `defer` | `defer`: the mutation was deferred < 2 times |
| `request` | What should the runtime do with this request? | `send`, `coalesce`, `delay`, `block`, `serve_cached` | `coalesce`: fetch and `env.canCoalesce`; `serve_cached`: GET and a cached response |
| `delivery` | What should the runtime do with this response or message? | `deliver`, `discard`, `defer` | `discard`: always; `defer`: deferred < 2 times **and** `relatedInFlight` is non-empty (an in-flight op outside the subject's chain with the same signature, or whose chain wrote one of the matched fields' stores) |
| `failure` | What should the runtime do with this failed request? | `deliver`, `retry`, `serve_cached` | `retry`: replayable, attempt < 4, fetch; `serve_cached`: GET, cached, fetch |
| `stall` | What should the runtime do with this slow request? | `wait`, `hedge`, `serve_cached` | `hedge`: idempotent GET, replayable, fetch; `serve_cached`: GET, cached, fetch |
| `inconsistency` | What should the runtime do about this inconsistent state? | `ignore`, `rollback`, `resync` | `rollback`: a consistent snapshot and a writable store; `resync`: a store with a resync handler |
| `transition` | What should the runtime do about this unusual state change? | `ignore`, `rollback`, `resync` | `rollback`: the op chain's writes are revertable; `resync`: a chain store is resyncable |
| `error` | What should the runtime do about this error? | `ignore`, `rollback` | `rollback`: the ambient op's chain wrote revertable state |
| `ask` | (none) | (none) | — |

Built-in descriptions and tiers (`BUILTIN_ACTIONS`; the sim's `TIER`, curriculum `fmt.TIER`, `eval_runtime.TIER`, `sim/scripts/relabel.py` `TIER`, `t1_relabel`/`eval_gain` `PREM` are copies):

| action | tier | description | delivery description (`TRIGGER_DESCRIPTIONS.delivery`) |
|---|---|---|---|
| `apply` | passive | let this write update the state now | — |
| `discard` | guard | drop this write and keep the current state | deliver it but drop the state changes it would make over newer data |
| `defer` | guard | hold this write until the related in-flight operations finish, then decide again | hold it until the related in-flight operations finish, then decide again |
| `send` | passive | send the request now | — |
| `coalesce` | guard | do not send; reuse the result of the identical request that is in flight or just finished | — |
| `delay` | guard | wait before sending, backing off so the service can recover | — |
| `block` | heal | do not send; fail this request immediately | — |
| `serve_cached` | heal | answer with the last successful response for this request instead | — |
| `deliver` | passive | pass the failure to the application as it is | pass it to the application now |
| `retry` | heal | retry the request after a short backoff | — |
| `wait` | passive | keep waiting for the request | — |
| `hedge` | heal | send a second identical request and use whichever answers first | — |
| `ignore` | passive | leave the state as it is | — |
| `rollback` | heal | restore the affected state to its last consistent snapshot | — |
| `resync` | heal | reload the affected state from its source | — |

`actionDescription(name, vocab, custom?, trigger?)` precedence: `vocab.actions[name]` → `custom` (a plugin's `def.description`) → `TRIGGER_DESCRIPTIONS[trigger][name]` → `BUILTIN_ACTIONS[name].description` → the name. Built-in actions are described with their trigger (`build.ts` passes `s.trigger`); custom actions are not. Custom (plugin) actions are appended after the built-ins when `def.on` includes the trigger, the name is new, and `def.applicable(draft)` is truthy (no `applicable` = applicable; a throw counts as false). Their tier defaults to `heal`.

### Training row (`sim/src/types.ts` -> `Row`, `Label`; same schema as docs/CONTRACT.md §D)

```ts
interface Row { id: string; split: "train" | "dev" | "test"; family: string; state: JevState;
                questions: Record<string, Question>; labels: Record<string, Label>; meta: Record<string, unknown> }
type Label = { type: "choice"; label: string } | { type: "choice"; dist: Record<string, number> }
           | { type: "noul"; p: number } | { type: "score"; level: number } | { type: "score"; dist: number[] };
```

A qid without a label is packed but unsupervised (unlabeled rows rely on this for `action`).

| row kind | id | labels | distinguishing `meta` |
|---|---|---|---|
| gold decision | `sim-<seed>-d<k>` | `action` dist (always) + `diagnosis` label (when in the criteria and correlated) | `best`, `passive_best`, `costs`, `cost_futures`, `futures`, `adjusted`, `se`, `non_passive_mass`, `cost_parts`, `tiers`, `diagnosis_s1?`, `diagnosis_subject?`, `probe?` |
| diagnosis-only | `sim-<seed>-s<k>` (also in on-policy runs) | `diagnosis` | `diagnosis_only: true` |
| ask | `sim-<seed>-a<i>` (gold) / `u-<seed>-a<i>` (unlabeled) | exact noul/score/choice | `trigger: "ask"`, `kinds` |
| unlabeled decision | `u-<seed>-d<k>` | `diagnosis` only (when in the criteria and correlated), never `action` | `unlabeled: true`, `actions`, `ran`, `explored` |
| on-policy decision | `p-<seed>-d<k>` | as gold | `on_policy: true`, `model_probs`, `model_choice`, `model_diagnosis`, `ran`, `false_intervention`, `miss` |

Every row of a trajectory shares `metaOf(scn, o)`: `seed, domain, family, program_family, chaos, clean, persona, budget, runtime, features, patterns`. Decision and diagnosis-only rows add `trigger, passive, subject_feature, decision, t, subject`. Teacher-labelled and T1 rows add `meta.teacher` / `meta.egain` (training side, section 10).

## How it works

### 1. Situation text (`build.ts` -> `buildSituation`, `serialize.ts` -> `toJevState`)

1. `subjectOf(env, spec)` writes the `trigger` sentence (model input) and `Situation.subject` (reports only, never model input). `opLabel(op)` = `` `${truncate(opPhrase(op), 90)} (#${op.id})` `` (`"an earlier operation"` when the op is unknown).
   | trigger | sentence template (`state.trigger`) | `Situation.subject` |
   |---|---|---|
   | mutation | `A write to <p1, p2, p3[ and N more] \| store>[ from <opLabel(cause)>] is about to be applied.` | `write to <paths>[ from <opLabel>]` |
   | request | `<opLabel> is about to be sent.` | `<opLabel>` |
   | delivery (response) | `The response to <opLabel> arrived and is about to be delivered; <predicted>.` | `response to <opLabel>` |
   | delivery (message) | `A <WebSocket \| server-sent> message <channel path> (#id) arrived and is about to be delivered; <predicted>.` | `<WebSocket \| server-sent> message <path> (#id) <summary>` |
   | failure | `<opLabel> failed (<HTTP 503 \| timed out \| network error>) and the app has not seen the failure yet.` | `<opLabel> (<failure>)` |
   | stall | `<opLabel> has been waiting <secs> for a response.` | `<opLabel>, waiting <secs>` |
   | inconsistency | `The relation <text \| ?>[ (and N more)] no longer holds now that the app is settled.` | `relation <text>[ (and N more)]` |
   | transition | `<opLabel> completed with a state change unlike its usual ones.` | `<opLabel> state change` |
   | error | `An uncaught <Name> was thrown: <message, truncated to 120>` | `<Name>: <message ≤ 80>` |
   | ask | `The developer asks about <opLabel>.` / `The developer asks about the store <name>.` / `The developer asks about the app right now.` | `question about <opLabel \| name \| the app>` |

   `<predicted>` = `facts.ts` -> `predictedText`: response `its operation usually writes <fields>` (transition profile) / `its operation last wrote <fields>` (last completion) / `no earlier completion shows which state it writes`; message `messages like it usually write …` / `messages like it last wrote …` / `no earlier message shows which state it writes`. `<fields>` lists up to 4 normalised paths (`a, b, c and d (+N more)`).

   `opPhrase` by op kind (`describe.ts`, unchanged in v2): user → `userPhrase` (`user clicked <target>`, `user typed <value>[ into <target>]`, …); fetch/xhr → `<op.name><op.detail>` where `name` is the op signature and `detail` the query string plus, for non-GET/HEAD, a redacted body summary (e.g. `GET /api/search?q=rea`, `POST /api/orders {items: [1], cardNumber: [redacted]}`); timer/ws → name; task → `task <name>[ <detail>]`; genclass → `GenClass <name>`. Redaction is by the **leaf field** since v2 (`util.ts` -> `isSensitivePath`: `auth.loading` visible, `auth.token` redacted). Time and number formats come from `util.ts`: `secs(ms)` = 2 dp below 10 s (`0.42s`), 1 dp below 1,000 s, else integer; `rel(ms)` = signed timeline stamp; `fmtNum` = integers as is, else 1/2/4 dp by magnitude; `truncate(s, n)` = first `n−1` UTF-16 code units + `…`. Long string changes use a diff-centred preview (`state/fields.ts` -> `stringDiff`), e.g. `"…e sword shield market lib" → "…e sword shield" (removes " market lib")`.
2. Facts: `computeFacts` (or precomputed facts from triage), plus plugin facts (each truncated to 240, `kind: "plugin"`, neutral). Then `orderFacts` (non-neutral first, then kind rank, stable) and `.slice(0, MAX_FACTS = 12)`. v2 adds delivery facts (provenance of the response/message, profile counts, version conflicts), content facts F1–F3, evidence facts F5–F7/F9 and read-your-writes; catalogue and wording in [learn-situation-triage.md](runtime/learn-situation-triage.md) and `packages/runtime/STATUS.md` "Batch 5".
3. Section lines (details in [learn-situation-triage.md](runtime/learn-situation-triage.md)):
   - `app`: `` `${title} — ${route}` ``, or whichever exists, else `unknown`.
   - `in_flight`: non-user in-flight ops except the subject (`subjectOp`; for a delivery, the delivering op), same signature first, then same root, then by start: `<opPhrase≤80> (#id) <secs> so far[, by #cause]`.
   - `timeline`: from the last 96 events, the relevant ones (≤ section limit), topped up with the most recent irrelevant ones and sorted by `seq`; lines from `describe.ts` -> `eventLine`. `decision` events are never shown.
   - `state`: involved fields first (delivery: conflicting paths, then matched predicted paths), then other fields of the involved stores (delivery: stores of P) by most recent write: `path = value (vN, by #writer <secs> ago)` or `(v0)`.
   - `stats`: `<sig>: N done[, median Xs, p95 Ys], F of last M failed, R in last 10s[ (usual U)]` (M is the failure window, not N), for the subject's signature (fetch/xhr/ws/task) and then each in-flight fetch/xhr signature.
4. `toJevState(parts, budget)`:
   1. `b = max(MIN_BUDGET 500, round(budget))`; `L = sectionLimits(b)`, with `r = clamp((b − 1100) / (2400 − 1100), 0, 1)` and every limit `Math.round(a + (b − a)·r)` (half-up). Limits saturate at 2,400: `sectionLimits(3200)` equals `sectionLimits(2400)` (tested).
   2. Cap each section: facts/in_flight/state/stats keep the first N, timeline keeps the **last** N. Each line is truncated to its line limit with `…`.
   3. Build the object in key order `app, trigger, facts, in_flight, timeline, state, stats`. An empty array becomes the string `"none"`.
   4. Size = `stateChars` = Σ over keys of `len(key) + 2 + len(value joined by "\n") + 1`. While size > `b`, shrink in this order: timeline (drop oldest, floor 0), state (drop last, floor 0), facts (drop last, **floor 1**), in_flight (drop last), stats (drop last).
   5. If still over (`over = size − b`): shorten every fact to `max(60, len − over)`. If still over, shorten the trigger to `max(60, len − remaining excess)`.
5. The situation is deterministic: the same inputs and clock give byte-identical output (`test/situation.test.ts`, `test/budget.test.ts`).
6. The budget comes from `RuntimeImpl.situationBudget` (`src/runtime.ts`). A numeric `situation.budget` is used as is. With `"auto"`: webgpu or an unknown device gives **2,400**; wasm gives `1000 + round((threads − 1)·1000/3)` with threads clamped to 1..4 (1,000 / 1,333 / 1,667 / 2,000). The result is multiplied by `budgetScale`, which starts at 1 and becomes `max(0.5, ×0.8)` after each `max_tokens_exceeded` (auto only; 2,400 → 1,920 after one, tested).

### 2. Standing questions (`questions.ts` -> `buildQuestions`)

1. `compact = budget <= COMPACT_QUESTIONS_BUDGET` (1,400). This is a different constant from `COMPACT_BUDGET` 1,100.
2. `ask` trigger: only standing questions (from `rt.question` or a plugin) for `ask`. `runtime.ask(q)` sends its own `{answer: q}` (`runtime.ts` -> `ask`).
3. Otherwise `diagnosis = {type: "choice", instructions: "What is happening here?", criteria}`, where `criteria[label]` is the description. In compact mode it is `null`, unless a `vocabulary.diagnoses` override of ≤ 24 chars (`COMPACT_DESC_MAX`) exists for that label.
4. `action` is added only if more than one action applies, with `criteria[name]` = the `ActionOption.description` built by `actionDescription` (trigger-specific for delivery). Compact: `null` unless a `vocabulary.actions` override ≤ 24 chars. The header is `ACTION_INSTRUCTIONS[trigger]`, fixed per trigger (no subject interpolation).
5. Standing questions follow, by their `id`, only if the id is not already in the object (`if (!(k in qs))`). So an id `diagnosis` is always skipped, but an id `action` is **inserted** when the built-in `action` question is absent. Insertion order is `diagnosis, action, <standing qids>`.

### 3. Wire → segments and blocks (`model/serialize.ts`, port of `jev_local/serialize.py`)

1. The host calls `toJsonValue(req.state)` (`host.ts` -> `evaluateDetailed`). This is the value Python sees after `json.loads(JSON.stringify(v))`: `undefined` keys vanish, NaN/±Infinity become `null`, Dates become strings; a Map is kept as an ordered map when it is the value itself or nested in another Map (a Map inside a plain object or array goes through `JSON.stringify` and becomes `{}`). BigInt and cyclic values throw `ModelInputError`. `pyJson` is `json.dumps(v, ensure_ascii=False, separators=(", ", ": "))`.
2. `stateSegments(state)`:
   - object: one segment per top-level key, `text = valueText(v)`: an array of strings is joined with `"\n"` (not stripped); anything else goes through `entryText`.
   - array: up to 64 (`MAX_ARRAY_SEGMENTS`) `[i]` segments plus one `[64:]` remainder.
   - string: one segment with key `""` (stripped).
   - `null` → `None`; booleans → `True`/`False`; numbers → Python repr.
3. `entryText`: `null` → `""`; string → `pyStrip`; all-string array → items joined with `"; "`, skipping empties; other array → `json.dumps(…)`; object → `k: v | k: v`; number → `pyNumber` (JSON integers print as ints; others as Python `repr(float)`).
4. `segmentText` = `` `${key}: ${text}` `` (or `text` when the key is empty). The model therefore reads `facts: <fact1>\n<fact2>`. The indented `facts:\n  <fact1>` rendering in STATUS.md and `explain()` comes from `situation/serialize.ts` -> `stateText` and is display only.
5. `questionBlock(qid, q)`:
   - header = `entryText(instructions)` or the default (`Is the statement true of the state?` / `Which option best fits the state?` / `Which level best describes the state?`).
   - choice: items `label` when the description is `null`, `""`, or equal to the label after strip; otherwise `label: <entryText(desc)>`. Labels are in criteria order (a Map keeps integer-like labels in order; a plain object moves them first). Empty criteria → `ModelInputError`.
   - score: items = level texts, labels `"0".."n-1"`. noul: items `[true || "yes", false || "no"]`, labels `["true","false"]`. Any other type → `ModelInputError`.
6. `questionEntries(questions)`: request order (`Object.entries`, or Map order).

### 4. Packing (`packer.ts` -> `Packer.pack`)

```
[CLS] seg_0 [SEP] seg_1 [SEP] … seg_n [SEP] | [Q] header_0 | [O] item_00 | [O] item_01 … | [Q] header_1 | [L] lvl_10 … | [Q] header_2 | [T] true | [F] false
```

1. Each text is tokenized on its own with no special tokens (`Packer.encode` -> `Tokenizer.encode`, cached by text, 8,192 entries). Special added tokens are **never** matched inside text, so user text cannot forge a marker. In code order: the normalizer runs on the whole text first (NFC for the shipped file), then non-special added tokens are split out leftmost-longest, then each remaining piece goes ByteLevel regex → BPE merges.
2. State ids: `[CLS]`, then each segment's ids followed by `[SEP]`. `nState = S` is the count.
3. Per question `qn`: header = `[Q]` + header ids. Each item = its marker + item ids. Markers: `[O]` choice, `[L]` score, `[T]`/`[F]` noul.
4. `position_ids`: state `0..S−1`. Header tokens `S..S+h−1`. Every item **restarts** at `S+h`.
5. `q_group`: −1 for state, `qn` for header and items. `i_group`: −1 for state and header tokens, the item ordinal for item tokens. A token sees the state plus its own header and its own item. ModernBERT local layers also require `|pos_q − pos_k| ≤ window` (`ExportModel.window`, recorded in `meta.json` but not read by the host).
6. Limits: `positions = S + max over questions(len(header) + longest item)` ≤ `maxPositions` (`meta.max_len`, default 1536), and `total = S + Σ(header + all items)` ≤ `maxTotal` (`meta.max_total`, default 8192). Otherwise `MaxTokensExceededError` (`code: "max_tokens_exceeded"`). There is no truncation inside the model host: the situation budget is the only size control.
7. Marker, `[CLS]` and `[SEP]` ids come from `meta.json` when given and must equal the tokenizer's ids, otherwise `ModelUnsupportedError`. The pruned runtime tokenizer has markers at ids 16359–16363 (MODEL_CARD).
8. `Packer.measure(state, questions?)` returns `{stateTokens, positions, total}` with the same arithmetic but never throws `MaxTokensExceededError` (see [model-host.md](runtime/model-host.md)).
9. Tokenizer constraints (`tokenizer.ts` -> `Tokenizer` constructor, all `ModelUnsupportedError`): BPE only; no dropout; no `continuing_subword_prefix`/`end_of_word_suffix`; `ByteLevel` pre-tokenizer; normalizer `NFC/NFD/NFKC/NFKD/Lowercase/Sequence` or none; non-special added tokens without `lstrip`/`rstrip`/`single_word`; every UTF-8 byte token present; merges over vocab tokens; ids < `ID_SPACE` (2^26).

### 5. Feeds, graph and heads (`engine.ts`, `packer.ts` -> `planInputs`/`unpackLogits`; graph `scripts/genclass_export.py` -> `ExportModel`)

1. `planInputs` groups questions by kind in request order: `choice_q [G]`, `choice_items [G, K]` (padded with 0); `score_q [S]`, `score_items [S, K2]`; `noul_q/noul_t/noul_f [M]`. A kind with no question gets one dummy row pointing at token 0.
2. `Engine` feeds exactly `meta.inputs`; the set must equal the session's input names, and every name must be in `FEEDS` (`input_ids, position_ids, q_group, i_group, attention_mask, token_type_ids, choice_q, choice_items, score_q, score_items, noul_q, noul_t, noul_f`). All feeds are int64, token rows `[1, L]`. Shipped exports declare the 11 inputs without `attention_mask`/`token_type_ids`.
3. Outputs map by name: `choice_logits [G, K]`, `score_logits [S, K2]`, `noul_logits [M]` (fp16 outputs are converted).
4. Heads (`jev_local/engine/encoder/heads.py`): choice `z_i = MLP([h_Q; h_Oi; h_Q*h_Oi])`; score `z_k = MLP([h_Q; h_Lk; h_Q*h_Lk])`; noul `z = MLP([h_Q; h_T; h_F; h_Q*h_T; h_Q*h_F])` (absolute sigmoid). MLP = Linear → GELU → Linear(d → 1), inputs through the shared LayerNorm. The repo's `HeadOut` has no gain head (see Drift: `collect_gain.py`).
5. `unpackLogits` returns raw logits per qid in request order, taking the first `labels.length` columns. `Engine.logits` serializes forward passes (one at a time per session).
6. `Engine` constructor checks (all `ModelUnsupportedError`): input names = `meta.inputs` as a set; every input a `FEEDS` key; every `meta.outputs` name a graph output; at least one of the three logit outputs. A question whose kind has no head fails at `logits` time. The reported model id is `"<card.name>@<card.version>"` (`backend.ts` -> `createEngine`).

### 6. Logits → calibrated probabilities → answers (`calibrate.ts`)

0. `parseCalibration(json)` fills missing `noul`/`choice`/`score` with 1.0 and `by_header` with `{}`, then throws `ModelUnsupportedError` if the file is not an object, any of the three is not a number > 0, or `by_header` is not an object. Other keys pass through unchecked.
1. `hk = headerKey(header)` = `sha1(header)[:12]` (UTF-8). Keys: `041ccfa6318c` = "What is happening here?", `bb11f7f0f3a7` (mutation), `2a615ca90e33` (delivery, new in v2), `61d7c396157f` (request), `3616530c70a5` (failure), `94978d9e82be` (stall), `1b36f88322a0` (inconsistency), `6a2432a6e7de` (transition), `3f494eb3a731` (error).
2. choice/score: `tauFor(calib, kind, hk, K)` takes the first that applies: `by_header[hk]`; `by_bucket["<kind>:<bucket(K)>"]` (buckets `2 | 3-5 | 6-10 | 11-30 | 31-100 | 101-255`); `tau_k[kind] = [a, b]` → `clamp(a + b·ln max(K, 2), bucket_clamp)` (default `[0.5, 5.0]`); `calib[kind]`. Then `softmax(z / τ)`.
3. noul: `noulAffine` gives `[1/by_header[hk], 0]`, else `noul_platt (a, b)`, else `[1/calib.noul, 0]`. Then `p = sigmoid(a·z + b)`.
4. `buildAnswer(q, probs, precision = "exact", labels)`:
   - choice: `normalizeProbs`; `choice` = argmax (first label wins ties); `confidence = clip01((K·pmax − 1)/(K − 1))`; `probabilities` in criteria order.
   - score: `score = Σ i·p_i`; `confidence = max(0, 1 − Σ p_i·|i − mode| / MAD_uniform(K))`; `probabilities` keyed `"0".."K−1"`.
   - noul: `noul = clip01(p)` (0.5 if p is not finite).
   - `precision: "round"` rounds every number to 2 dp, half-even (`pyRound`).
5. `EngineResult`: `{model: "<card.name>@<card.version>", answers, usage: {input_tokens, positions}, timings}`.

### 7. How the runtime consumes answers (detail in [decide-policy-actions.md](runtime/decide-policy-actions.md))

`runtime.ts` -> `onDecision`:

- It reads `answers.action.probabilities`, or `{<passive>: 1}` when there is no `action` question. The top action is `answers.action.choice`, or the passive action if that choice is not offered. It reads `answers.diagnosis.choice`, or `expected`.
- `decide/policy.ts` -> `gate`: A = the permitted non-passive actions; the candidate is the argmax over A. It runs iff `Σ_{a∈A} p(a)` ≥ the candidate tier's threshold (defaults guard 0.9, heal 0.8) and the diagnosis is not `expected` (unless `requireDiagnosis: false`). `Answer.confidence` is **not** used.
- **Mode decides what is permitted.** Since f3636b2 the default is `observe` (`runtime.ts` -> `o.mode ?? "observe"`): the model is still consulted and answers are reported (except for `delivery`: a delivery candidate may wait up to `BODY_WAIT_MS` (100 ms) for its body, then proceeds at once and its queued decision is dropped as stale before the model sees it, `runtime.ts` -> `RuntimeImpl.runDelivery` controller `stale: () => released`; the same happens in guard mode whenever a delivery does not wait), but no action runs and no write or request is held. `guard` (opt-in) permits guard-tier actions (for delivery: `discard`, `defer`); `heal` (experimental) adds heal-tier ones. The text the model reads does not depend on the mode. The sim runs in `heal` (`sim/src/run/rt.ts` -> `createOptions`).
- Delivery enforcement: `discard` delivers the response but drops the writes its chain makes over newer data (`ActionRecord.dropped`); `defer` holds until related in-flight ops finish and re-asks. Holding is latency only (STATUS.md "Batch 4").

### 8. Annotated example (real SIM row `sim-42-d48` from `sim/samples/sample.jsonl`, budget 1,000)

`state`/`questions` are exactly what the runtime handed its decider (894 chars by `stateChars`):

```jsonc
{ "app": "PatentPath — /applications",
  "trigger": "The response to GET /public/responses/:id?nocache=1791381656694.1008 (#186) arrived and is about to be delivered; its operation usually writes responsePublic.arguments, responsePu…",
                                                              // delivery sentence; cut at the compact trigger line limit (180)
  "facts": [                                                  // compact limit 6; 2 in this row (whether any were shrunk away is not recorded)
    "The response would replace text the user typed into responsePublic.title after #186 started (1 user write, the last 0.17s ago): \"… gripper hinge \" → \"… gripper hinge\" (removes \" \").",   // F2, non-neutral
    "In 11 earlier completions of GET /public/responses/:id its chain wrote responsePublic.arguments, responsePublic.etag, responsePublic.failure and responsePublic.title (6 of 11 wrote state)." ],  // profile counts
  "in_flight": [ "GET /public/responses/:id?nocache=1791381656714.0552 (#187) 1.22s so far, by #179", "POST /ping {status: \"active\"} (#185) 1.93s so far, by #184" ],
  "timeline": "none",                                         // dropped first by the shrink loop
  "state": "none",
  "stats": [ "GET /public/responses/:id: 15 done, median 1.81s, p95 2.73s, 3 of last 15 failed, 4 in last 10s (usual 2.5)" ] }
```

```json
{ "diagnosis": { "type": "choice", "instructions": "What is happening here?",
    "criteria": { "expected": null, "stale": null, "conflict": null, "duplicate": null, "inconsistent": null,
                  "failing": null, "slow": null, "overload": null, "unusual": null, "transient": null } },
  "action": { "type": "choice", "instructions": "What should the runtime do with this response or message?",
    "criteria": { "deliver": null, "discard": null, "defer": null } } }
```

At budgets > 1,400 the same criteria carry the delivery descriptions, so the item text becomes `discard: deliver it but drop the state changes it would make over newer data`.

Packed (schematic): `[CLS] "app: PatentPath — /applications" [SEP] "trigger: The response to …" [SEP] "facts: <f1>\n<f2>" [SEP] "in_flight: <l1>\n<l2>" [SEP] "timeline: none" [SEP] "state: none" [SEP] "stats: GET /public/…" [SEP] [Q] "What is happening here?" [O] "expected" … [O] "transient" [Q] "What should the runtime do with this response or message?" [O] "deliver" [O] "discard" [O] "defer"`.

- `q_group`: −1 for the state, 0 for diagnosis, 1 for action. Feed plan: `choice_q = [qPos_diag, qPos_action]`, `choice_items` is `[2, 10]` (the action row padded with 0 after 3); score/noul get dummy rows.
- Calibration: `by_header["041ccfa6318c"]` / `["2a615ca90e33"]` if present, else `choice:6-10` / `choice:3-5` buckets, else `tau_k`, else `choice`.

Labels and the cost evidence in `meta` (excerpt):

```json
"labels": { "action": { "type": "choice", "dist": { "deliver": 0.1524, "discard": 0.628, "defer": 0.2196 } },
            "diagnosis": { "type": "choice", "label": "stale" } }
"meta": { "trigger": "delivery", "passive": "deliver", "subject_feature": "cdn", "budget": 1000, "chaos": "degraded", "clean": false,
          "best": "discard", "passive_best": false,
          "costs": { "deliver": 38.6908, "discard": 38.2584, "defer": 42.4544 },
          "cost_futures": { "deliver": [42.3626, 30.8184, 42.8913], "discard": [41.9014, 30.4436, 42.4302], "defer": [42.2028, 42.4275, 42.7329] },
          "adjusted": { "deliver": 0.182, "discard": 0, "defer": 4.196 }, "se": { "deliver": 0.029, "discard": 0, "defer": 3.894 },
          "futures": 3, "non_passive_mass": 0.8476, "transform": "default", "diagnosis": "stale", … }
```

How the label falls out of `actionLabel`:

- Adjusted costs: deliver = 38.69 + 0 (passive), discard = 38.26 + 0.25, defer = 42.45 + 0.25. Best = discard; gaps deliver 0.182, defer 4.196.
- Per-action temperature τ = 0.1 + SE: deliver 0.129, defer 3.994. `exp(−0.182/0.129)` ≈ 0.244, `exp(−4.196/3.994)` ≈ 0.350, discard 1 → normalized ≈ 0.153 / 0.628 / 0.219. The large SE of `defer` (future 1 differs by ~12) keeps it soft: an S2-style "outcome depends on the future" label rather than a one-hot.
- T1 gain view of the same row (`t1_relabel.py`): gain(discard) = 38.69 − 38.26 − 0.25 ≈ 0.18, gain(defer) ≈ −4.0.

#### Reading the STATUS.md examples

`packages/runtime/STATUS.md` prints situations with `stateText` (indented list items) and a display-only `questions:` footer; the model reads `key: line1\nline2` segments and the question blocks of section 3.

- **Compact vs full** (`test/budget.test.ts`): the stale typeahead **delivery** at budget 1,000 (951 chars) and 2,000 (1,760 chars). At 2,000, `r = 900/1300`, so facts = `round(6 + 6r)` = 10 and timeline = `round(3 + 13r)` = 12. At 1,000 the questions are bare labels (≤ 1,400); at 2,000 they carry descriptions.
- **Full budget 2,400** (`test/situation.test.ts`, `test/delivery.test.ts`, `test/content.test.ts`): four delivery situations (stale out-of-order response with F1 third value; F1 list undo; F2 autosave over typed text; a WebSocket message reverting a pending local change), then mutation, request, failure (×2: F5/F6), stall, inconsistency, transition, error. These strings are what `rt.py` must reproduce and what a wording change must update.

### 9. SIM rows (`sim/src/gen/trajectory.ts` -> `generateTrajectory`)

Mode is chosen by the CLI (`sim/src/gen.ts` -> `parse`): default `gold`; `--unlabeled`; `--on-policy <model dir>` (the worker loads `sim/src/run/onpolicy.ts` -> `loadModelDecider`, which runs the runtime's own `createModelHost` inline on onnxruntime-web WASM from `sim/dist/model-host`, built by `npm run build:model-host`).

1. `buildScenario(seed)` fixes the domain (115 = 55 original + 60 in `vocab2.ts`), features, chaos (`calm, normal, flaky, degraded, storm, mobile, peak, deploy`; mobile personas get `mobile` with p 0.7), **clean runs** (p 0.05: calm network, no failures, no accidental clicks, no feature env; `meta.clean`), tab switches, clock skew, wording and `budget` (weighted 3,200:40 / 2,000:30 / 1,000:30). Split (`splitOf`): test if the domain is in `TEST_DOMAINS` (19 of 115), the family hash is in the held-out 17%, a pattern is in `TEST_PATTERNS`, or (unless `SIM_FEATURE_HOLDOUT=off`) a family feature is in `TEST_FEATURES` (`swcache, presence, cascade, saga, prefetch, permissions`); dev if `hash("dev-split-v1", family) % 100 < 3`; else train. Test trajectories are kept with probability `testKeep` (CLI default 0.33).
2. **Ideal run**, then the **base run** on the real `createRuntime`. Options (`sim/src/run/rt.ts` -> `createOptions`): `mode: "heal"`, `triage: "salient"`, `model: false`, `report: "silent"`, thresholds `{report 0, guard 0.5, heal 0.5}`, `holdBudgetMs: 1e9`, `maxActionsPerMinute: 1e9`, `requireDiagnosis: false`, `historySize: 500`, observers fetch + timers + websocket + **storage** (xhr, user, errors, nav, perf off), `situation: {budget}`, `vocabulary` when paraphrased. On-policy runs pass `production: true`, which replaces the policy with `{holdBudgetMs: 1e9, maxActionsPerMinute: 1e9}`: default thresholds (0.6/0.9/0.8) and the diagnosis gate, still `heal` mode. The runtime module is `process.env.GENCLASS_RUNTIME ?? "@genclass/runtime"`.
   - The recording decider (`sim/src/run/runner.ts`) records `{state, questions}` verbatim, answers with probability 1 on the chosen action, and adds a lognormal virtual latency. On-policy: the model answers; `modelProbs`/`modelChoice`/`modelDiagnosis` and what the gate actually ran (`ran`) are recorded, and replays force `ran`.
   - Exploration ε ∈ {0, 0.08, 0.2} (weights 4:3:2) × `exploreScale`: full where the sim sees a problem, ε/4 elsewhere, **ε/2 for delivery** (its diagnosis is only known after the run). None on-policy; ×1.5 in unlabeled mode.
   - Delivery diagnoses are filled after the run: the verdict of the first write the delivered op (or push message) made, each write being diagnosed at proposal time with the `mutation` rules (`SimWrite.diag`).
3. Decision points: gold `pickPoints` takes decisions with ≥ 2 actions and `k < DENSE_K` (600), up to `maxPoints` (CLI default 6), weighted by `TRIGGER_W` (mutation 1, **delivery 1.2**, request 1, failure 1.6, stall 2.2, inconsistency 3, transition 3, error 2.2), ×1.5 when the diagnosis is not `expected`. On-policy `pickOnPolicy` weights 4 if a non-passive action ran, 3 if the model chose one, 2 if the diagnosis is not `expected`, else 1.
4. `pointCosts`: for each action and each future j < K (default 3), re-run with the base run's explored choices before k, the action at k and passive after k, stopping at `t_k + W.finalMs` (15 s).
   - Futures 1..K−1 re-seed everything after the decision with a salt `hashAll("future", seed, k, j)` shared across actions. With **S2** (`SIM_S2` ≠ `0`, default on) they also re-draw the user's later step timing, outage/offline/slow/socket-drop/server-bug windows, prefix latents (did an ambiguous failed write commit, remaining time of in-flight requests) and the hidden intent of earlier repeats (ideal run only). The ideal run is re-run for a re-seeded future when external events follow `t_k` or S2 is on.
   - Adaptive: with S2, future 1 always runs; later futures only if some non-passive action beat passive by > 0.05 in a future seen so far (without S2 the same rule already applies from future 1, so future 1 needs such a gain in future 0). `meta.futures` = futures actually run.
   - A prefix mismatch in an S2 future is retried once with network/timing re-draws only (`noLatent`; counted as `info:latent-fallback`). Any remaining prefix mismatch, internal error or exception drops the point (`prefix-mismatch`, `cf-internal-error`, `cf-exception`).
5. `runCost(real, ideal, from, tEnd)` (unchanged): `area` ∫ client divergence over ≤ 10 s; 4.0 × final client divergence + server divergence at `stop`; 1.5 × extra shown-error episodes + 1.0 × extra uncaught errors; 0.08 × extra requests per signature; 0.25 × seconds non-background ops were pending; 0.8 × ∫ violated relations + 2.0 × relations still violated. Weights in `W` (table below); full definitions in [sim.md](sim.md).
6. `actionLabel(futures, passive)` (unchanged): premium per tier (passive 0, guard 0.25, heal 0.5); a non-passive action within 0.05 of passive is pinned to passive + 1.5; best = lowest mean adjusted cost (passive wins exact ties); `p_a ∝ exp(−max(0, mean(adj_a − adj_best)) / (0.1 + 1.0·SE_a))`, rounded to 1e-4. `meta.costs`, `cost_futures`, `adjusted`, `se`, `non_passive_mass` as in the example.
7. **S1** (gold and on-policy): if the diagnosis is undefined or `expected`, the subject is correlated, passive is not best and `adjusted[passive] ≥ S1_GAP` (1.0), the diagnosis becomes `diagnosisFromOutcome`: (a) for each field already diverged from the ideal run, the last write to it before the decision; if that write's verdict is not `expected`, the latest such verdict wins; (b) `duplicate` for a repeat of an accidental action (or an op marked as a duplicate); (c) `duplicate` on a `request` point whose best action is coalesce/block, with an identical request in flight or answered in the last 10 s; (d) `inconsistent` (inconsistency/transition) or `stale` when fields diverged without a named cause; (e) `unusual`. `meta.diagnosis_s1` = rule (`a-write`, `b-repeat`, `c-twin`, `d-diverged`, `e-other`), `meta.diagnosis_subject` = the subject-only verdict.
8. `transformQuestions`, with an independent RNG per row: 50% unchanged; otherwise, for `action` only, with p 0.12 (≥ 3 options) drop one option that is neither passive nor best and renormalize, and with p 0.5 shuffle. `meta.transform` records the variant. Wording variation comes from the runtime's `vocabulary`, per trajectory: diagnoses 50% default, else each label paraphrased with p 0.6 and p 0.3 of dropping one or two of `conflict, slow, overload, unusual, inconsistent, duplicate, transient`; actions 50% default, else each action paraphrased with p 0.6 (`ACTION_PARA`, keyed by action name only; see gotchas for delivery).
9. Labels written (gold): `labels.action = {type: "choice", dist}` always; `labels.diagnosis = {type: "choice", label}` only if the diagnosis is in the row's criteria and the subject correlated (drops `diagnosis-not-in-vocab` / `diagnosis-uncorrelated` otherwise). Unlabeled rows get only the diagnosis label (no S1, no costs; `transformQuestions` with no dist and `best = passive`). The diagnosis is never derived from the runtime's text: `sim/src/oracle/diagnose.ts` maps sim ground truth ([sim.md](sim.md) flow 8).
10. Other row kinds:
    - **Diagnosis-only** (`sim-<seed>-s<k>`): up to 3 per trajectory from decisions with < 2 actions, a diagnosis and a correlated subject; questions untransformed.
    - **Ask** (`sim-<seed>-a<i>`, gold only when `askRows`; always in unlabeled mode as `u-<seed>-a<i>`; never on-policy): `runtime.situation("ask")` at 1–3 probe times with 1–3 questions from `askQuestions` (table below). Labels are exact.

      | qid | type | options (criteria) | label | skipped when |
      |---|---|---|---|---|
      | `q_write_inflight` | noul | true `yes, a write is in flight` / false `no write is in flight` | a POST/PUT/PATCH/DELETE in flight | never |
      | `q_any_inflight` | noul | default (`yes`/`no`) | any request in flight | never |
      | `q_pending` | score | `none, one, two, three or more` or `0 requests, 1 request, 2 requests, 3+ requests` | `min(3, in-flight count)` | > 6 in flight |
      | `q_last_failed` | choice | `e1..e3` = endpoint signatures, `none` | id of the last failing signature (≥ 400 or network error, last 12 s), else `none` | < 2 known signatures; its path tail not in the text |
      | `q_recent_failure` | noul | default | a failure in the last 5 or 10 s | a failure within 1 s of the window edge |
      | `q_fail_count` | score | `none, one, two, three or more` | `min(3, failures in last 10 s)` | counts at 9 s and 11 s differ |
      | `q_user_waiting` | noul | default | user-initiated wait > N s (N ∈ 1, 2, 3, 5) | within 400 ms of N s |
      | `q_user_recent` | noul | default | user input within N s (N ∈ 1, 2, 3) | within 300 ms of N s |
      | `q_last_save` | noul | true `the last save succeeded` / false `the last save failed` | last save ok | no save yet |
      | `q_route` | choice | `r1..r3` = the route + 2 from a fixed list | id of the current route | route not in the text |
      | `q_slowest` | choice | `o1..o4` = in-flight signatures | id of the oldest in-flight request | < 2 in flight; top two within 300 ms or same signature; a path tail missing |
11. Output: `<out>/{train,dev,test}.jsonl` + `stats.json` (or resumable `parts/part-NNNNNN.<split>.jsonl` with a `part-NNNNNN.json` marker; `--merge-only` concatenates them). `stats.json` `token_estimate` is `(len(JSON state) + len(JSON questions)) / 3.6`, not real tokens. `SIM_PROBE=1` adds `meta.probe` (sim-only hidden facts; analysis rows, **not** training data). `--sample`: target 900 rows, `testKeep` 1, then a stratified 200 rows to `sim/samples/sample.jsonl` plus `EXAMPLES.md` and `sample-stats.json`. Full CLI and cluster orchestration: [sim.md](sim.md). The real-browser corpus writes the same schema with `meta.source = "realapps"` ([realapps.md](realapps.md)).

### 10. Training consumes rows (`jev_local/train/train.py` -> `encode_example`, `parse_target`)

1. Every question goes through `question_from_json` → `question_block`, and the state through `state_segments`: the Python original of `model/serialize.ts`, so SIM rows (written by `JSON.stringify`) render identically on both sides.
2. `parse_target(block, label)`: noul `p` → `[p]` (hard if 0/1); choice `label` → one-hot (rejected if not an option); choice `dist` → aligned to `block.labels`, renormalized, always `hard=False` (no label smoothing on SIM action labels); score `level` → one-hot; score `dist` (length K) → soft. A type mismatch or bad label makes the question unsupervised (`bad_labels`).
3. `Packer.pack_split(segments, blocks, --max-len)`: questions are isolated, so an over-long example splits into several sequences that repeat the state. A question whose state + whole block exceeds `max_len` is dropped.
4. Losses (`jev_local/train/losses.py`): proper scoring rules (CE, label smoothing 0.02 on hard labels, RPS 0.25 on score). Configs in [training.md](training.md).
5. Round 1 (`training/launch_final1.sh`, `configs/mix_final1.json`) trained on **situation-v1** SIM phase A; its numbers are the baseline only. Every committed mixture config is v1-era and names v1 buckets (`simA`, `simAh`, `cur1`, `cur4`, `gen`): `configs/mix_t150.json` (`simA 0.9, cur4 0.1`, `pass_tokens` 470M; the `t150-g1` teacher run that was stopped for v2, `training/LOG.md` 01:13–01:56), `mix_r68.json` (R68 benchmark, not started), `mix_t1{a,b,h}.json` (T1 variants on v1 data, stopped at the v2 freeze, LOG 03:32). No v2 mixture is committed at b435acb; the v2 runs will need new configs or v2 data under these bucket names on the VM (unverified).
6. **T1 and teacher labels** (training side; nothing in the runtime changes):
   - `t1_relabel.py --in DIR --out DIR --tau τ [--keep-dist]`: for SIM decision rows with an `action` label and `meta.cost_futures` (falling back to `meta.costs`), `gain(a) = mean_f c(passive) − mean_f c(a) − premium` (passive 0, guard 0.25, heal 0.5), clipped to ±30, label `softmax(gain/τ)` over the offered actions; `meta.egain` keeps the gains. With `--keep-dist` the SIM dist is kept and the gains are added as `labels.action.gain` and `meta.egain` (gain-head training).
   - `label_teacher.py --ckpt T --in rows --out rows`: every question (or `--qids`) gets a calibrated soft label (choice dist, score dist, noul p); gold labels are kept unless `--overwrite`; `meta.teacher` records checkpoint, top probability, margin and summed non-passive mass (its `PASSIVE` set is `apply, send, deliver, wait, ignore`).
   - `collect_gain.py` writes eval_runtime-format records (+ `gain_pred` when the checkpoint has a gain head); `eval_gain.py` compares gate policies (`gate@t`, `gate@t-nodiag`, `gain>m`, `head>m`) by fired share, clear-case recall, harmful share and gain captured vs the oracle.
7. Curriculum rows (`rows.py`; full detail in [training.md](training.md)):
   - `decision_row` emits runtime-exact text (`rt.render`, style `runtime`, share `--p-runtime` = env `GC_P_RUNTIME`, default 0) or varied text (style `varied`, also the fallback when `rt.render` returns `None`).
   - **v2:** `rt.render(sc, app, rng, info)` renders a `mutation` scenario whose cause is a completed fetch or WS message as a **`delivery`** with probability `P_DELIVERY` = 0.5 (forced by `spec["delivery"]`), when the gold action survives the mapping `DELIVERY_ACTION` (`apply→deliver, discard→discard, defer→defer`; `defer` removed unless related work is in flight). `info["trigger"]` and `info["action_map"]` let `decision_row` rename labels and set `meta.trigger`, `meta.passive`, `meta.action_names` and the family `cur/delivery/<case tail>`.
   - Runtime-exact budgets: `rt.BUDGETS` = 2,400:0.35 / 2,000:0.2 / 1,667:0.05 / 1,333:0.05 / 1,000:0.35 (`GC_RT_BUDGET` forces one budget for analysis). Questions use `TRIGGER_DESCRIPTIONS` for delivery and bare labels at ≤ 1,400.
   - Varied text, `ask_row`, ids, `js_numbers` and `_validate` are unchanged since v1; varied rows never use the trigger `delivery` (`fmt.TRIGGER_ACTIONS` has no delivery entry).

### 11. Evaluation and calibration fit (`training/eval_runtime.py`)

CLI: `--ckpt`, `--data DIR` (reads `DIR/<split>.jsonl`), `--split` (default `test`), `--fit-split`, `--limit`, `--batch` (16), `--threads` (32), `--out report.json`, `--write-calibration`, `--calibration` (reads only `noul`, `choice`, `score`, `by_header`), `--records-dir`, `--header-calibration`.

1. Raw logits per supervised question come from `jev_local.train.eval.collect`; `header` is the header key.
2. `fit_calibration` (on `--fit-split`): noul τ on a 61-point log grid in [0.2, 5]; choice and score τ by golden section on log τ in [0.2, 5]; `action`/`diagnosis` τ for the `group` mode (never written); `by_header` only for standing questions with ≥ 300 examples; split-half check. Metric modes `raw`, `kind`, `group`, `header`; `by_budget` buckets by `meta.budget` (else state chars `≤1100` / `≤2100` / `>2100`).
3. `--write-calibration` writes `{noul, choice, score, by_header, _fit}`; `by_header` stays `{}` unless `--header-calibration`.
4. Decision metrics re-implement the runtime §8 gate (summed mass, `THRESH` guard 0.9 / heal 0.8, top diagnosis ≠ `expected`; unknown actions count as heal). The passive action is `PASSIVE[trigger]`, falling back to `meta.passive` (the map has no `delivery` key; delivery rows carry `meta.passive`), and a gold action with tier `passive` counts as passive-best. New since v1: `recall_clear` (gold non-passive, permitted, target mass ≥ 0.9) and `recall_clear_stale_dup` (the same for gold diagnosis `stale`/`duplicate`), the metrics of `training/PLAN-v1.md` §1.

### 12. Export → model directory (`training/export_runtime.py` -> `main`, unchanged since `situation-v1`)

Run by `training/final_post.sh` after the eval: `--calibration out/cal/<M>-simAe.json --data-rows data/simAe/dev.jsonl,data/cur4/dev.jsonl --n-per-file 60 --threads 24`. CLI defaults: `--name genclass-runtime`, `--version 0.1.0`, `--n-per-file 40`, `--opset 17`, `--threads 16`, `--block 32`. It imports `jev_local` and `genclass_export` from `~/jev` (VM layout). Packaging, validating and publishing the result: [RELEASE.md](../../RELEASE.md) Part B.

1. `load_checkpoint(ckpt, "cpu", float32, encoder="reference")`; `ExportModel(enc, heads)`; parity requests sampled per file (seed 0) that pack to ≤ 1,500 tokens.
2. `torch.onnx.export` fp32 and fp16 references into `ref/` with dynamic axes `L`, `G/K`, `S/K2`, `M`.
3. `make_q8`: `gemm_to_matmul`, `MatMulNBitsQuantizer` (8-bit, block 32, symmetric), then `quantize_embedding` (per-row `scale = max|row| / 127`); refuses any fp16 tensor. `make_fp16`: fp16 reference with the same int8 embedding.
4. Parity on CPU vs `FastEngine(…, encoder="banded")` logits, both calibrated with the shipped calibration → `parity.json`.
5. Copy tokenizer, write calibration, `meta.json`, then `model.json` with byte sizes and sha256.

| file | content |
|---|---|
| `model.json` | `{format: "genclass-runtime-model/1", name, version, license: "Apache-2.0", variants: {q8: {file, bytes, sha256, provider: "wasm"}, fp16: {file, bytes, sha256, provider: "webgpu", needs: "shader-f16"}}, files: {tokenizer, calibration, meta}}` |
| `<name>-q8.onnx` | MatMulNBits 8-bit block 32 on every MatMul + int8 row-wise token embedding; no fp16 tensor |
| `<name>-fp16.onnx` | fp16 weights/compute, fp32 I/O, int8 embedding |
| `tokenizer.json` | from `<ckpt>/backbone/tokenizer.json` (pruned: 16,000 merges, 16,364 tokens) |
| `calibration.json` | `--calibration` file, else the checkpoint's |
| `meta.json` | `name` (`<name>-<version>`), `source_checkpoint`, `max_len` (checkpoint meta, else 1536; 2048 for round 1), `max_total: 8192`, `window`, `hidden_size`, `layer_types`, `markers`, `cls_id`, `sep_id`, `pad_id`, `vocab_size`, `merges_kept`, `inputs`, `outputs`, `embedding_quant`, `matmul_quant`, `license` |
| `requests.json`, `pack_fixtures.json`, `torch_fixtures.json` | parity requests and the Python packer / PyTorch outputs for them (read by the runtime parity tests and `validate.mjs`) |
| `parity.json` | per variant: `max_abs_logit`, `max_abs_prob`, argmax / noul-side / gate08 / gate09 agreement, CPU p50 latencies, `file_mb`; plus token stats and embedding quantization errors |
| `ref/` | fp32 and fp16-fullemb references (excluded from the served tar) |

Candidate students (MODEL_CARD; sizes of the round-1 `final1` exports, `training/LOG.md`): R17 `genclass-runtime-r17` (ettin-17m, d 256, 7 layers) q8 9.6 MB / fp16 13.6 MB; R32 `genclass-runtime-r32` (ettin-32m, d 384, 10 layers) q8 22.5 MB / fp16 34.8 MB; both vocab 16,364. `training/PLAN-v1.md` adds R68 and a 150M teacher (T150, never shipped).

The runtime reads `model.json` (`loader.ts` -> `parseCard`; `format` defaults to `CARD_FORMAT` and is **not** checked), then `meta.json` and `calibration.json`. Load plans (`planOrder`): webgpu+fp16 → webgpu+q8 → wasm+q8. The default base URL is `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/` (`host.ts` -> `DEFAULT_MODEL_BASE_URL`), which returns 404 today. More in [model-host.md](runtime/model-host.md).

## Configuration and constants

| name | type | value | defined in | effect |
|---|---|---|---|---|
| `STATE_CHAR_BUDGET` | number | **2400** (v1: 3200) | `situation/serialize.ts` | full section sizes; default budget; webgpu/unknown auto budget |
| `COMPACT_BUDGET` | number | 1100 | `situation/serialize.ts` | budget at or below which section limits are minimal |
| `MIN_BUDGET` | number | 500 | `situation/serialize.ts` | smallest budget honoured |
| `LIMITS` (full) | object | facts 12, in_flight 6, timeline 16, state 8, stats 4 | `situation/serialize.ts` | lines per section at ≥ 2,400 |
| compact section limits | — | facts 6, in_flight 2, timeline 3, state 3, stats 1 | `serialize.ts` -> `sectionLimits` | lines per section at ≤ 1,100 |
| line limits compact→full | — | app 60→120, trigger 180→240, facts 220→260, in_flight 90→120, timeline 100→140, state 100→150, stats 110→140 | `serialize.ts` -> `sectionLimits` | per-line truncation |
| last-resort fact/trigger floor | — | 60 chars | `serialize.ts` -> `toJevState` | pathological over-budget case |
| `COMPACT_QUESTIONS_BUDGET` | number | 1400 | `situation/questions.ts` | bare labels/names at or below |
| `COMPACT_DESC_MAX` | number | 24 | `situation/questions.ts` (private) | vocabulary override kept in compact mode |
| `TRIGGER_DESCRIPTIONS` | object | `delivery`: deliver / discard / defer texts | `situation/questions.ts` | trigger-specific option descriptions |
| `MAX_FACTS` | number | 12 | `situation/facts.ts` | facts kept before budgeting |
| `PENDING_WINDOW_MS` | number | 10000 | `situation/conflicts.ts` | pending-local-change window |
| plugin fact length | — | 240 | `build.ts` -> `buildSituation` | plugin fact truncation |
| phrase truncations | chars | `opLabel` phrase 90; in-flight phrase 80; error trigger message 120; timeline: op phrases 80, write summaries 110, error messages 100, nav 60, custom events 60, storage keys 40 | `describe.ts`, `build.ts` | text shape |
| timeline candidates | — | last 96 events | `build.ts` | events considered |
| auto budget | — | webgpu/unknown 2,400; wasm `1000 + round((t−1)·1000/3)`, t ∈ 1..4 | `runtime.ts` -> `situationBudget` | device-sized situations |
| `budgetScale` | number | 1, ×0.8 per `max_tokens_exceeded`, floor 0.5 | `runtime.ts` | shrinks auto budgets only |
| default mode | string | `observe` (since f3636b2) | `runtime.ts` | answers reported, no action runs |
| `MAX_ARRAY_SEGMENTS` | number | 64 | `model/serialize.ts` | array states |
| `Packer.maxPositions` / `maxTotal` | number | `meta.max_len` ?? 1536 / `meta.max_total` ?? 8192 | `packer.ts`, `engine.ts` | length limits |
| packer text cache / tokenizer word cache | number | 8192 / 20000 | `packer.ts` / `tokenizer.ts` | cleared when full |
| `MARKERS` | tuple | `[Q] [O] [L] [T] [F]` | `packer.ts` | head read points |
| `ID_SPACE` | number | 2^26 | `tokenizer.ts` | max token id |
| `K_BUCKETS` / `BUCKET_CLAMP` | — | 2, 3-5, 6-10, 11-30, 31-100, 101-255 / [0.5, 5.0] | `calibrate.ts` | `by_bucket` keys / τ(K) clamp |
| calibration defaults | number | `noul`/`choice`/`score` 1.0, `by_header` `{}` | `calibrate.ts` -> `parseCalibration` | missing keys |
| policy thresholds | number | report 0.6, guard 0.9, heal 0.8 | `decide/policy.ts` | gate on calibrated probabilities |
| `W` | object | area 1.0, horizonMs 10000, finalMs 15000, finalClient 4.0, serverItem 25.0, serverField 6.0, shownError 1.5, uncaught 1.0, relation 0.8, relationFinal 2.0, wasted 0.08, latency 0.25 | `sim/src/oracle/cost.ts` | run cost |
| `LABEL` | object | tier {passive 0, guard 0.25, heal 0.5}, exactTie 1.5, tieEps 0.05, tau0 0.1, seMul 1.0 | `sim/src/oracle/cost.ts` | soft action label |
| futures K / adaptive gain | number | 3 / > 0.05 (S2: future 1 always) | `trajectory.ts` -> `pointCosts` | label sharpness |
| `S1_GAP` | number | 1.0 | `trajectory.ts` | S1 diagnosis rule threshold |
| `DENSE_K` | number | 600 | `trajectory.ts` | gold points only among the first 600 decisions |
| `maxUnlabeled` | number | 40 | `trajectory.ts` (`GenOptions`) | unlabeled rows per trajectory |
| `TRIGGER_W` | object | mutation 1, delivery 1.2, request 1, failure 1.6, stall 2.2, inconsistency 3, transition 3, error 2.2 | `trajectory.ts` | decision point sampling |
| sim CLI defaults | — | rows 1000, seed 1, workers 4, max-points 6, test-keep 0.33, explore 1, ask on, mode gold | `sim/src/gen.ts` -> `parse` | generation |
| `SIM_S2` / `SIM_PROBE` / `SIM_FEATURE_HOLDOUT` | env | on / off / on | `latent.ts` / `oracle/probe.ts` / `scenario.ts` | S2 re-draws; probe meta; feature hold-out |
| scenario budgets | weights | 3200:40, 2000:30, 1000:30 | `sim/src/world/scenario.ts` | `meta.budget` |
| clean-run share | prob | 0.05 | `scenario.ts` -> `buildScenario` | `meta.clean` |
| transform | prob | unchanged 0.5; drop 0.12 (≥ 3 options); shuffle 0.5 | `sim/src/run/transform.ts` | option order/subsets |
| sim gate thresholds | number | report 0, guard 0.5, heal 0.5; `requireDiagnosis: false` (on-policy: runtime defaults) | `sim/src/run/rt.ts` | forced action runs exactly |
| `rt.BUDGETS` | weights | 2400:0.35, 2000:0.2, 1667:0.05, 1333:0.05, 1000:0.35 | `training/curriculum/rt.py` | runtime-exact curriculum budgets |
| `P_DELIVERY` | prob | 0.5 | `training/curriculum/rt.py` | mutation scenarios rendered as delivery |
| eval `THRESH` | number | guard 0.9, heal 0.8 | `training/eval_runtime.py` | must mirror the runtime |
| eval calibration fit | — | τ ∈ [0.2, 5]; noul grid 61; by_header ≥ 300 examples; ECE 15 bins | `training/eval_runtime.py` | `calibration.json` |
| T1 | — | premiums guard 0.25 / heal 0.5, clip ±30, `--tau` | `training/t1_relabel.py` | gain labels |
| export | — | opset 17, block 32, `max_total` 8192, parity requests ≤ 1,500 tokens, `--n-per-file` 40 | `training/export_runtime.py` | model directory |
| `CARD_FORMAT` | string | `genclass-runtime-model/1` | `loader.ts`, `export_runtime.py` | written, not validated on read |
| `DEFAULT_CACHE_NAME` | string | `genclass-runtime-v1` | `loader.ts` | Cache Storage bucket |
| `DEFAULT_MODEL_BASE_URL` | string | `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/` | `model/host.ts` | unpublished (404) |
| `--p-runtime` / `GC_P_RUNTIME` | float | 0.0 (`cur4`: 0.8) | `training/curriculum/generate.py` | share of runtime-exact decision rows |
| `GC_RT_BUDGET` | env | unset | `training/curriculum/rt.py` -> `render` | render every runtime row at one budget (analysis) |
| `GENCLASS_RUNTIME` | env | `@genclass/runtime` | `sim/src/run/rt.ts` | runtime module the sim imports |
| `GENCLASS_MODEL_DIR` | env | `<repo>/.cache-model` | `packages/runtime/test/model/helpers.ts` | model directory for parity tests |

## Invariants and gotchas

- **Parity chain:** runtime text → `JSON.stringify` (sim row) → Python `serialize.py` → `tokenize_pack.Packer` → PyTorch. Serving side: runtime text → `toJsonValue` → `model/serialize.ts` → `Packer` (TS) → ORT. Both sides must produce identical token ids. Do not "improve" `pyStrip`, `pyNumber`, `entryText`, the item `label: desc` rule or marker placement on one side only.
- **Data and model are tied to a format tag.** Round-1 data (SIM phase A/B, `gold-r1x`, REAL pilots) and R17-final1 are `situation-v1`; the runtime now emits `situation-v2` (delivery trigger, 2,400 budget, new facts and wording). Never mix v1 rows into v2 training without accepting the text mismatch, and never ship a v1 model as the v2 default. Check `meta.runtime` / batch manifests.
- **JS numbers vs Python floats:** JS prints `25`, never `25.0`. Python-produced rows must write integral floats as ints (`fmt.js_numbers`).
- **Two different compact constants:** `COMPACT_BUDGET` (1,100) shapes sections, `COMPACT_QUESTIONS_BUDGET` (1,400) bares the questions. Budgets in (1,100, 1,400] get almost-minimal sections plus bare questions.
- **Section limits saturate at 2,400, the char budget does not.** A 3,200 budget (40% of SIM scenarios) has the same section/line limits as 2,400 but more room before the shrink loop drops lines; production webgpu situations are 2,400. See Drift.
- **`facts` floor is 1:** the shrink loop never removes the last fact.
- **Display ≠ model text:** `stateText` indents list items. The model reads `key: line1\nline2`.
- **Qids are invisible to the model:** renaming a qid changes nothing for the model but breaks `answers.action`/`answers.diagnosis` lookups. A header change changes the text *and* the `by_header` key.
- **Same action name, different text per trigger:** `deliver`, `discard` and `defer` read differently under `delivery` (`TRIGGER_DESCRIPTIONS`). A `vocabulary.actions` override is per name and wins over the trigger text in every trigger, so an app (or the sim) overriding `discard` changes the delivery description too.
- **Sim action paraphrases are failure/mutation-flavoured:** `ACTION_PARA.deliver` ("let the application see the failure", …) and `ACTION_PARA.discard`/`defer` ("throw this write away …") are chosen per trajectory by name, so in paraphrased trajectories delivery rows carry those texts instead of the delivery descriptions (`actionDescription` precedence). Runtime defaults never produce them.
- **Option order is irrelevant to the model** (isolation), but decides the order of `probabilities` and the tie-break of `choice`. Pass a `Map` to keep integer-like labels in order.
- **`action` is absent when only one action applies.** Consumers treat a missing `answers.action` as passive. A delivery always has at least `deliver` and `discard` (`discard` is always applicable), so delivery situations always carry an `action` question.
- **No truncation inside the model host:** an oversize situation throws `max_tokens_exceeded`, the decision fails open, and auto budgets shrink by 20% (to ≥ 50%). Training drops (does not truncate) questions whose block does not fit `--max-len`.
- **Length semantics differ:** the runtime bounds state + longest branch; the trainer's `pack_split` bounds state + the whole block per sequence.
- **Markers and specials are read from files:** `meta.json` must agree with `tokenizer.json` or loading fails.
- **The gate uses probabilities, not `confidence`.** Recalibrating changes intervention rates; with T1 gain-shaped labels the summed-mass gate becomes approximately an expected-gain gate (`t1_relabel.py` docstring: gain ≥ τ·ln 4 / τ·ln 9 for one dominant action).
- **The default mode does not change the text.** `observe` vs `guard` vs `heal` changes only what runs, so data generated in `heal` mode (sim) is valid for an `observe` default.
- **The sim needs thresholds 0.5:** the decider answers with probability 1 on the forced action. On-policy runs instead use the production gate (`production: true`).
- **Sim determinism:** the counterfactual prefix check compares fingerprints of every decision up to k. Nondeterminism in situation building shows up as `prefix-mismatch` drops; S2 latents that change the observed prefix fall back to `noLatent`. `situation()` must stay side-effect free (it caches `op.reads` only).
- **Delivery diagnoses are post-hoc in the sim:** filled from the first write the delivery caused, after the run. Exploration on delivery uses ε/2 because the diagnosis is unknown at decision time.
- **Unlabeled rows have no `action` label and no S1:** the `action` question is packed but unsupervised until `label_teacher.py` fills it. Do not compute action accuracy on them.
- **`x-request-id` is the sim's correlation header:** never serialized (`sim/test/rows.test.ts`).
- **Description vs effect:** the `rollback` description says "last consistent snapshot", but transition/error rollback restores only the op chain's own writes. Changing the text is a model-input change.
- **SIM action labels are never label-smoothed:** always `{type: "choice", dist}`.
- **Varied curriculum headers ≠ runtime headers:** `fmt.ACTION_INSTR`/`DIAG_INSTR` never produce `What is happening here?`, the delivery header, or the runtime's failure/inconsistency/transition headers; only `rt.render` rows (and SIM/REAL rows) carry them.
- **Python vs JS number text in `rt.py`:** Python `f"{x:.2f}"` rounds exact binary ties half-even, JS `toFixed(2)` rounds them up; `rt.py`'s `secs`, `rel` and `fmt_num` differ from `util.ts` on such values. Affects runtime-exact curriculum rows only.
- **Truncation units:** `util.truncate` counts UTF-16 code units, `rt.py.truncate` counts code points.

## How to change it safely

### Versioning: what invalidates the trained model

| tag | commit | what it froze | data / models on it |
|---|---|---|---|
| `situation-v1` | 1a77558 ("Runtime fix batch 3", 2026-10-07 19:19 -0400) | v1 text: no `delivery`, held mutations, 3,200 budget | SIM phase A (600,676 rows) and B (1,415,344), `gold-r1x` (832,279), REAL pilots, `cur4`; round-1 models R17/R32-final1 |
| `situation-v2` | 6e5e86e ("Runtime batch 5 …; freeze situation-v2", 2026-10-07 23:26 -0400) | v2 text: `delivery` trigger + descriptions, non-blocking mutations, newer-data/pending conflicts, F1–F3, F5–F7, F9, read-your-writes, leaf-field redaction, diff previews, 2,400 budget | SIM v2 gold/unlabeled runs (`train:/data/sim-out/v2-*`), REAL v2 batches (`v2-pilot`, `v2b1–3`), `rt.py` port (d73d20c); no model yet |

Since `situation-v2`, `packages/runtime/src/situation`, `util.ts`, `state/` and `learn/` are unchanged at b435acb; the only `src` changes are f3636b2 (default mode, devtools labels, `InitOptions.mode` JSDoc), none of them model text. The model side (`src/model`, `jev_local`, `scripts/genclass_export.py`, `export_runtime.py`, the parity fixtures) is unchanged since `situation-v1`, so a v2 export uses the same packer/tokenizer/graph contract.

| change in … | invalidates | required follow-up |
|---|---|---|
| `situation/{build,facts,conflicts,content,evidence,describe,serialize,questions}.ts`, `util.ts` formatting/redaction, `state/fields.ts` change text, `state/hub.ts` change summaries, signature normalization, baselines/profiles/cadence numbers that appear in text | model input text | regenerate SIM and REAL data, re-port `training/curriculum/rt.py`, retrain, re-eval, re-export; new freeze tag (`situation-v3`) |
| `DEFAULT_DIAGNOSES`, `BUILTIN_ACTIONS`, `TRIGGER_DESCRIPTIONS`, `ACTION_INSTRUCTIONS`, `DIAGNOSIS_INSTRUCTIONS`, `TRIGGER_ACTIONS` membership/order, compact thresholds | model input text and label space (and `by_header` keys) | same as above; also update copies in `sim/src/types.ts` (`PASSIVE`, `DIAGNOSES`), `sim/src/world/scenario.ts` (`DEFAULT_DIAGNOSES`, `DIAG_PARA`), `sim/src/run/transform.ts` (`ACTION_PARA`), `sim/src/oracle/cost.ts` (`TIER`), `sim/scripts/relabel.py`, `fmt.py`, `rt.py`, `eval_runtime.py` (`TIER`, `PASSIVE`), `t1_relabel.py`/`eval_gain.py` (`PREM`), `label_teacher.py` (`PASSIVE`), realapps harness ([realapps.md](realapps.md)) |
| a new trigger | text, label space, sim correlation | everything above plus `TriggerKind` in `sim/src/types.ts`, sim `TRIGGER_W`, exploration, `diagnose.ts`, `runner.ts` correlation, `rt.py` rendering |
| `sectionLimits`, `STATE_CHAR_BUDGET`, auto budget mapping, scenario/curriculum budget weights | situation length distribution | regenerate data, retrain; check token percentiles vs `max_len` |
| triage / salience (`learn`, `runtime.ts`, delivery salience) | which situations get recorded (distribution), not text | regenerate data; retrain recommended |
| `model/serialize.ts`, `pyutil.ts`, `tokenizer.ts`, `packer.ts`, `FEEDS` | token ids | change `jev_local` in lockstep, re-run parity tests; retrain if the Python side changed |
| `tokenizer.json` (pruning), heads, graph inputs/outputs | the model | retrain/re-export; `meta.json` `inputs`/`outputs`/`markers` |
| `calibrate.ts` math or `calibration.json` | answers, not text | re-run `eval_runtime.py`; check `calibrate.test.ts` parity |
| `sim/src/oracle/{cost,diagnose}.ts`, `trajectory.ts` (S1), `latent.ts` (S2), `transform.ts`, `ask/questions.ts`, `scenario.ts` splits/vocab | labels/targets | regenerate data, retrain (`meta.cost_futures` lets you re-derive action labels offline: `sim/scripts/relabel.py`, `t1_relabel.py`) |
| `training/curriculum/{rt,fmt,rows}.py`, scenario modules | curriculum text/labels | regenerate the curriculum set, update the mixture, retrain; `rt.py` must still equal the runtime's text |
| `eval_runtime.py`/`eval_gain.py` metrics, `export_runtime.py` graph surgery/quantization | evaluation numbers / the ONNX files | re-eval or re-export; re-run `test_export_runtime.py`, `ortweb/validate.mjs`, the runtime parity tests |
| `decide/policy.ts` thresholds, default mode, host/loader/worker, `EvaluateRequest.subject/priority/timeoutMs` | nothing the model sees | mirror the gate in `eval_runtime.py`/`eval_gain.py` if the gate changes |

### Recipes

1. **Change wording the model reads** (a fact, sentence, description or instruction):
   1. Edit `packages/runtime/src/situation/*`.
   2. Update `test/situation.test.ts`/`test/budget.test.ts`/`test/delivery.test.ts`/`test/content.test.ts` expectations and the STATUS.md examples.
   3. Mirror the change in `training/curriculum/rt.py` (and `test_curriculum.py`).
   4. Regenerate SIM and REAL data (ask the user first; cluster runs are Mehar's: see [sim.md](sim.md), [realapps.md](realapps.md)).
   5. Retrain, eval, calibrate, export. Tag a new freeze. Coordinate first (`HANDOFF.md`: "The training format is frozen at `situation-v2`").
2. **Add a diagnosis label:** add it to `DEFAULT_DIAGNOSES` (`expected` stays first); teach `sim/src/oracle/diagnose.ts` (and S1 `diagnosisFromOutcome` if relevant); add it to `sim/src/types.ts` -> `DIAGNOSES`, `scenario.ts` -> `DEFAULT_DIAGNOSES`/`DIAG_PARA`, `fmt.py` -> `DIAG_DESC`, `rt.py` -> `DIAGNOSES`; regenerate and retrain.
3. **Add a built-in action:** `BUILTIN_ACTIONS` + `TRIGGER_ACTIONS` (+ `TRIGGER_DESCRIPTIONS` if its text differs per trigger) + `builtinApplicable` + the executor; tiers/passives in every copy listed in the versioning table, `ACTION_PARA`, `fmt.ACTION_DESC`, `fmt.TRIGGER_ACTIONS`, `rt.py` `ACTIONS`/`TRIGGER_ACTIONS` (and `DELIVERY_ACTION` if it maps), `sim/src/run/fake-runtime.ts`; make the sim able to force it; regenerate and retrain.
4. **Standing questions or custom actions** need no retrain to run: the model reads the description. Quality is unmeasured; check with `runtime.ask`/the demos.
5. **Change budgets or limits:** keep `rt.py` `section_limits`/`to_state` identical (JS half-up rounding) and update `rt.BUDGETS` and the sim's scenario budget weights together. TRAIN measured about 2.4 chars/token, so 2,400 chars ≈ 1,000 tokens.
6. **Re-calibrate only:** `eval_runtime.py --fit-split dev --write-calibration cal.json`, then `export_runtime.py --calibration cal.json`. No retrain; the freeze is unaffected.
7. **Relabel without regenerating:** `sim/scripts/relabel.py` (new τ/premiums for the soft dist) or `training/t1_relabel.py` (gain labels) on rows that carry `meta.cost_futures`.
8. **Change `max_len`:** train with `--max-len N`; the export copies it into `meta.json`.
9. **Tests to run** (runtime vitest runs locally under the run policy in AGENTS.md; ask the user before the sim generator, training pytest that needs checkpoints, `validate.mjs` and anything that needs a model download; see [where to run things](runtime/build-test-release.md#where-to-run-things)):
   - `packages/runtime`: `NODE_OPTIONS=--expose-gc npx vitest run test/situation.test.ts test/budget.test.ts test/delivery.test.ts test/content.test.ts test/model/` (model parity tests read `GENCLASS_MODEL_DIR`; `test/model/{packer,serialize,calibrate,engine}.test.ts` contain the conditional skips, and the lead's local run reported 14 skipped model-parity tests without a model directory).
   - `sim`: `SIM_RUNTIME=real npx vitest run test/rows.test.ts test/determinism.test.ts test/oracle.test.ts test/latent.test.ts` (the lead's whole-suite run `SIM_RUNTIME=real npx vitest run` saw 19 passed in 5 files, the fifth being `test/loop.test.ts`).
   - `training/tests/test_curriculum.py` (`test_runtime_rows_situation_v2` is pure Python), `training/tests/test_export_runtime.py`.
   - `training/ortweb/validate.mjs <export dir> q8`.

## Tests

| test file | what it asserts |
|---|---|
| `packages/runtime/test/situation.test.ts` | one situation per trigger (delivery: a stale response about to overwrite newer results; mutation: an older task's write not covered by a delivery decision; request, failure, stall, inconsistency, transition, error): key order, section caps, `stateChars` ≤ `STATE_CHAR_BUDGET` (2,400), a `diagnosis` question, regexes on selected facts (full text printed with `console.log` → STATUS.md); `ask` is side-effect free; serializer over/under-budget; determinism |
| `packages/runtime/test/budget.test.ts` | section limits compact 1,100 / `sectionLimits(1750)` = 9/4/10/6/3 / full 2,400 / `sectionLimits(3200)` = `sectionLimits(2400)`; 1,000/1,100/2,000 budgets shape a delivery situation and keep the version fact; compact questions keep ≤ 24-char overrides; determinism; auto budget 2,400 / 1,000–2,000; `max_tokens_exceeded` shrinks auto budgets (2,400 → 1,920) |
| `packages/runtime/test/delivery.test.ts` | delivery salience and enforcement: typeahead zero calls, stale out-of-order response → `discard` drops only the stale field, holding is latency only, no hold when the model cannot answer in time, background decisions and late revert, superseded queued decisions dropped, WebSocket order and pending-change revert, EventSource, XHR holds and abort |
| `packages/runtime/test/content.test.ts` | v2 facts: F3 (no call when unchanged), F1 field and item cells, F2 salience and diff preview, F9 stale marks, F6 cadence, F5 scope/offline/commit ambiguity, F7, F8, read-your-writes |
| `packages/runtime/test/default-mode.test.ts` | `createRuntime` and `GenClass.init` start in `observe` without `mode`; observe never holds writes or requests even when the model is sure, still reports findings, and never waits for the model (f3636b2) |
| `packages/runtime/test/model/serialize.test.ts` | `state_segments`/`question_block` vs Python fixtures; Python number printing; `json.dumps` separators; `str.strip`; JSON-round-trip semantics; `round` half-even |
| `packages/runtime/test/model/packer.test.ts` | ids/positions/groups/marker positions/question order identical to the Python packer; special tokens stay text; marker ids from files; typed `max_tokens_exceeded`; feed plan + unpack; HF tokenizer edge cases |
| `packages/runtime/test/model/calibrate.test.ts` | sha1 header keys = Python; calibrated probabilities = PyTorch (< 1e-9); v1 and v2 calibration files; confidence/score math |
| `packages/runtime/test/model/engine.test.ts` | TS packer → ORT (node CPU and web WASM) → TS calibration vs PyTorch fixtures within the export's `parity.json` (or fixed tolerances); feeds exactly `meta.inputs` |
| `packages/runtime/test/model/loader.test.ts`, `host.test.ts` | card parsing, plans, sha256 cache; host queueing/fail-open ([model-host.md](runtime/model-host.md)) |
| `packages/runtime/test/browser/model.spec.ts`, `model-webgpu.spec.ts` (Playwright; ask first) | WASM worker load and parity, Cache Storage, fallbacks, latency |
| `packages/runtime/test/fixtures/model/make_py_fixtures.py` | (generator, VM) writes `py_fixtures.json` from jev_local, HF `tokenizers`, `calibrate_logits`, `confidence` |
| `sim/test/rows.test.ts` | valid CONTRACT-D rows (labels reference options, dists sum to 1, …), no `x-request-id` in states, passive-best share > 0.2, 0 prefix mismatches, splits hold out domains/families; **S1:** a gold `expected` diagnosis never comes with `adjusted[passive] ≥ 1` when passive is not best |
| `sim/test/determinism.test.ts` | same seed → identical rows and final states; forced replays reproduce every prefix |
| `sim/test/oracle.test.ts` | stale out-of-order response → **delivery** decision with `discard` best (was `mutation` in v1); single-point credit (`discard` vs `deliver`); benign concurrency asks nothing or prefers passive; duplicate POST → block/coalesce; outage → delay/serve_cached; sharp vs soft labels; exact ties favour passive |
| `sim/test/latent.test.ts` | S2: re-seeded futures re-draw only what lies after the decision (windows, user steps); hidden repeat intent drawn from its posterior in ideal runs only |
| `training/tests/test_curriculum.py` | rows valid against the trainer's parser and deterministic; held-out domains/templates; label consistency; **`test_runtime_rows_situation_v2`**: runtime-style rows fit 2,400 chars, delivery rows appear with "about to be delivered", action labels/passive map into the runtime's actions |
| `training/tests/test_export_runtime.py` | int8 embedding, Gemm→MatMul rewrite, end to end card bytes/sha256, meta markers = tokenizer, fp32 parity < 1e-3, R17 q8 < 12 MB |
| `training/tests/test_prune_vocab.py` | pruned tokenizer layout and identical outputs (needs `GC_V1_CKPT`, `GC_BASE_32M`) |
| `training/ortweb/validate.mjs` | onnxruntime-web WASM on an export vs `torch_fixtures.json`; writes `ortweb_report_<variant>.json` |

## Drift and open issues

- **No situation-v2 model; npm default URL 404.** R17-final1 is `situation-v1` and exists only on the train VM / Mehar's Mac. `@genclass/runtime-model` is not published, so `DEFAULT_MODEL_BASE_URL` (and the CLI default) return 404; `@genclass/runtime@0.1.0-alpha.0` ships no model (and still defaults to `guard`; a 0.1.0-alpha.1 NaN-fix patch needs the owner's 2FA, OPEN_TASKS.md). Plan per HANDOFF: T150 teacher on v2 gold → teacher labels on unlabeled rows → distil R17 (default) and R32 → DAgger via `--on-policy` → EVAL → `@genclass/runtime-model@0.1.0` → demos rerun → `@genclass/runtime@0.1.0`. Release procedure: [RELEASE.md](../../RELEASE.md) (Part A alpha.1, Part B model packaging and validation).
- **SIM scenario budgets still 3,200 / 2,000 / 1,000** (`scenario.ts`, comment "3,200 WebGPU"; sim/README.md says the same), while the runtime's webgpu/unknown auto budget is 2,400 and section limits saturate at 2,400. SIM v2 data never renders the production webgpu budget exactly, and its 3,200 rows are longer than anything a v2 runtime sends by default. `rt.py` `BUDGETS` uses 2,400. `training/PLAN-v1.md` ECE targets and MODEL_CARD latency still quote 3,200.
- **Sim action paraphrases on delivery** (gotchas): `ACTION_PARA` is keyed by action name, so paraphrased trajectories give delivery `deliver`/`discard`/`defer` failure- or write-flavoured descriptions; there is no delivery-specific paraphrase set.
- **`collect_gain.py` needs a gain head the repo does not have:** it reads `o.gain` from `heads(...)`, but `jev_local/engine/encoder/heads.py` -> `HeadOut` defines no `gain` field. The gain-head code (`r17-t1h`, `training/LOG.md` 03:00–03:12) presumably lives in the VM's `~/jev` (unverified). No T1 result exists on v1; T1 is to be rerun on v2 (`training/LOG.md` 03:32).
- **training/NEEDS.md "SIM → TRAIN: scaled data"** still says "Runtime tag `situation-v1`" for the scaled row types; the v2 runs (`v2-*`) are generated from `situation-v2` per HANDOFF and the claims table (manifests not checked here, unverified).
- **docs/runtime/CONTRACT.md:** §5 has no `delivery` trigger; §6 still says action instructions are "What should the runtime do with <subject>?" (code: fixed per-trigger sentences) and "≤ 1,000 tokens; truncate timeline first, then state, then facts" (code: 2,400 chars + 5-step shrink + fact/trigger shortening); its `runtime.situation()` shape omits `salient`, `facts`, `compact`, `budget`; §11 says option order/subsets and diagnosis paraphrases are randomised "per row" (code: order/drop per row, wording per trajectory). The §13 default-mode entry (from f3636b2) says "`situation-v1` training data stays valid"; the mode claim holds, but v1 data no longer matches the v2 text anyway.
- **MODEL_CARD.md:** lists 9 diagnoses (no `transient`); describes the gate as `p(action) ≥ 0.9/0.8` (code: summed permitted non-passive mass); lists actions without the delivery trio; says round-1 files are in `files/r17/` "here", but `packages/runtime-model/` contains only `MODEL_CARD.md`; latency is quoted at the v1 1,000/2,000/3,200 budgets.
- **HANDOFF.md** "Modes" line still says guard is the default (code since f3636b2: observe).
- **training/README.md:** §2 says "diagnosis (9 labels …)"; §4 describes the gate as "non-passive top action, p ≥ 0.9 / 0.8" (`eval_runtime.py` implements the summed-mass gate).
- **sim/NEEDS.md preamble** shows `thresholds {guard: 0, heal: 0}` (`rt.ts` uses 0.5) and says `transient` is missing from `DEFAULT_DIAGNOSES` (it is present). STATUS.md's headless block is now correct (0.5).
- **docs/runtime/ARCHITECTURE.md** lists diagnoses with `transient` before `slow`; code order puts it last (affects only answer key order and tie-breaks).
- **`training/curriculum/rt.py` -> `to_state`**: last-resort fact floor 40 chars (runtime 60), trigger never shortened; `round(budget)` vs `Math.round`; half-even number formatting (gotchas). Unchanged by the v2 port.
- **`rollback` description vs effect** (gotchas): fixing it is a model-input change.
- **`meta.json.name`** is `<name>-<version>`, while the runtime reports `<card.name>@<card.version>` and ignores `pad_id` and, in practice, `meta.name`.
- **`model/tokenizer.ts` header comment** describes added-token splitting before normalization; `Tokenizer.encode` normalizes first. Equivalent for the shipped NFC file (unverified for other normalizers).
- **`export_runtime.py` parity `gate08`/`gate09`** compare the max choice probability, not the summed-mass gate: a proxy only.
- **`eval_runtime.py` `PASSIVE`** has no `delivery` key (falls back to `meta.passive`, present on SIM, REAL and curriculum rows); a row without `meta.passive` would get `None` as passive but still counts passive-best through `TIER`.
- **Open (OPEN_TASKS.md / training/NEEDS.md / RESULTS.md):** v2 data collection (≈ 10M gold + 50M unlabeled SIM on 20 nodes; ≈ 495k REAL gold on c01/c10/c11; generation is running on Azure under Mehar, nobody on our side touches it); teacher/distillation/DAgger; R17 vs R32; device-based model selection in the card; round-1 recall on clear cases ≈ 5–8% at FIR 0.05% (the separability analysis behind S1/S2 and the v2 facts is in `sim/SEPARABILITY.md`, summarized in `docs/runtime/RESULTS.md` §3).
- **Resolved since 654d822** (removed from this list): the `serialize.ts` header now states 2.4 chars/token (measured); the `types.ts` `InitOptions.situation` comment now matches `situationBudget` (webgpu 2,400; wasm 1,000–2,000 linear).

## Related docs

- [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md): facts catalogue (incl. v2 delivery, F1–F9), triage and delivery salience, section line details, redaction
- [runtime/model-host.md](runtime/model-host.md): worker/inline host, loader, backends, CLI, errors
- [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md): queue, gate, modes, action execution (delivery `discard`/`defer`), reports
- [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md): `vocabulary`, `situation.budget`, `mode`, `ask`/`decide`, plugins
- [RELEASE.md](../../RELEASE.md): release procedure for `@genclass/runtime` and `@genclass/runtime-model`
- [runtime/build-test-release.md](runtime/build-test-release.md): where and how tests run, CI
- [sim.md](sim.md), [realapps.md](realapps.md), [training.md](training.md), [genclass-model-lineage.md](genclass-model-lineage.md) (jev_local Python reference), [status-and-known-issues.md](status-and-known-issues.md), [glossary.md](glossary.md)
- Source docs: [docs/runtime/CONTRACT.md](../runtime/CONTRACT.md) §5–§8, §10, §11, §13; [docs/CONTRACT.md](../CONTRACT.md) §B (packing, heads) and §D (row format); [packages/runtime/STATUS.md](../../packages/runtime/STATUS.md) (batches 4–5, example situations); [sim/README.md](../../sim/README.md), [sim/SEPARABILITY.md](../../sim/SEPARABILITY.md); [training/README.md](../../training/README.md), [training/PLAN-v1.md](../../training/PLAN-v1.md), [training/NEEDS.md](../../training/NEEDS.md); [docs/runtime/RESULTS.md](../runtime/RESULTS.md); [HANDOFF.md](../../HANDOFF.md); [packages/runtime-model/MODEL_CARD.md](../../packages/runtime-model/MODEL_CARD.md)
