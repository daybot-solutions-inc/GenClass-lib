# GenClass model lineage: jev_local (Python model, server, harness, training) and legacy docs

> **Scope:** `jev_local/**` except `jev_local/bench/**` (`api.py`, `schema.py`, `serialize.py`, `confidence.py`, `validate.py`, `cli.py`, `demo.py`, `engine/**`, `harness/**`, `server/**`, `train/**`), `pyproject.toml`, `tests/**` (Python), and the legacy design docs `docs/SPEC.md`, `docs/CONTRACT.md`, `docs/CONTRACT-v2.md`, `docs/DEMO.md`, `docs/GENCLASS.md`, `docs/COMPARISON.md`, `docs/PLAN-excel.md`.
> **Read this when:** you touch anything that changes the text the model reads or the numbers it returns (serialization, packing, markers, heads, calibration, answer math); you need to know what `packages/runtime/src/model` was ported from and how parity is checked; you run or change the Python trainer that `training/` drives (including teacher soft-labelling and the T1 gain work for situation-v2); you need the Jev-compatible HTTP server or the macOS voice harness; you want to know which Python is legacy and safe to ignore for the self-healing runtime.
> **Source of truth:** the code. Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins.
>
> **What changed since the previous verification (654d822 = v0.1.0-alpha.0, situation-v1 format; the situation-v1 tag is 1a77558):** nothing under `jev_local/**`, `tests/**`, `pyproject.toml` or the legacy docs (`git diff --stat 654d822 b435acb` on those paths is empty), and nothing in `packages/runtime/src/model` or its fixtures. What changed is around it: `training/` gained the scaled program (teacher T150, students R17/R32/R68, teacher soft-labelling, T1 expected-gain targets) that drives this `jev_local` (see "Situation-v2 training and this package" under How it works), the optional **gain head** was added to the **parent repo's** `jev_local` only (not to this tree), and `packages/runtime-model/MODEL_CARD.md` now describes R17-final1, a **situation-v1** model that does not match the v2 runtime.

## TL;DR

- `jev_local` (pip package `jev-local` 0.1.0) is the **predecessor project** of `@genclass/runtime`: a local, open re-implementation of TypeSafe's "Jev" *System One* typed-decision API (not affiliated). It contains the model, a Jev-wire-compatible HTTP server, a macOS voice computer-use harness, and the multi-node CPU trainer.
- A **typed decision** is `{state, model, questions}` in, `{model, answers, usage}` out. Three question kinds: `choice` (2–255 labels, softmax), `noul` (absolute P(true), sigmoid), `score` (2–10 ordered levels, softmax, value = Σ i·pᵢ). Wire models: `jev_local/schema.py`.
- The model (`FastEngine`, "jev-local-fast") is an **ettin/ModernBERT encoder** with **typed heads over marker tokens** `[Q] [O] [L] [T] [F]`. One packed sequence holds the state once plus every question; a block attention mask makes each option see only the state, its own header and itself, so answers are **exactly invariant to option order and to other questions**.
- Raw logits are turned into probabilities by **post-hoc calibration** (`calibration.json`: per kind, per header hash, per (kind, K-bucket), τ(K), noul Platt), then into Jev answers by `confidence.build_answer`.
- **The runtime model is a direct descendant.** `packages/runtime/src/model` is a TypeScript port of `serialize.py`, the HF tokenizer call, `tokenize_pack.Packer` (single-pass subset), `calibrate.py` lookup and `confidence.py`. The network itself is exported to ONNX by `scripts/genclass_export.py` (graph) / `training/export_runtime.py` (q8/fp16 + card). Parity is pinned by Python-generated fixtures in `packages/runtime/test/fixtures/model/`.
- **R32** (runtime candidate) is initialised from the v1 `jev-local-fast` checkpoint (ettin-32m, d 384, 10 layers) with a pruned 16,364-token vocabulary; **R17** starts from `jhu-clsp/ettin-encoder-17m` (d 256, 7 layers per `training/README.md`; fresh `DecisionHeads(enc.hidden_size)`), also pruned to 16,364 tokens. The scaled program (`training/PLAN-v1.md`, 2026-10-08) adds **R68** (ettin-68m student benchmark; never trained, per `training/LOG.md`) and **T150** (ettin-150m **teacher**, never shipped); their pruned bases `ettin-68m-v16k` / `ettin-150m-v16k` are made on each node by the launchers when missing. All are trained with `jev_local/train/train.py` (stream mode, DDP) launched from `training/` (`training/launch_student.sh` is the generic launcher). Caveat: `training/node.sh sync` copies `jev_local/` from the **parent jev repo** (`$HERE/../..`), not from this repo's root, and the two copies have now **diverged** (the parent has the gain head; see Drift).
- **No situation-v2 model exists yet.** The newest trained models (`r17-final1` = R17 default, `r32-final1`) were trained on situation-v1 SIM data and do not match the v2 runtime (`packages/runtime-model/MODEL_CARD.md`, `training/LOG.md`). Next per `HANDOFF.md`: T150 teacher on v2 gold -> teacher labels on unlabeled rows (`training/label_teacher.py`, which calls this package's `load_checkpoint` / `Packer` / `collate_tree` / `build_plan` / `calibrate_logits`) -> distil R17 and R32 -> DAgger via SIM `--on-policy` -> EVAL -> `@genclass/runtime-model@0.1.0` (release procedure: [RELEASE.md](../../RELEASE.md)). The text contract (serialize/pack/calibrate) is unchanged by v2; what changed is the *content* of the situations (e.g. the new `delivery` trigger with actions `deliver` (passive) / `discard` / `defer`; `deliver` itself already existed as the `failure` passive in v1) rendered by `packages/runtime/src/situation/*` (`questions.ts` -> `TRIGGER_ACTIONS`, `PASSIVE`).
- Python entry points: console script `jev-local` (`cli.py`), and `python -m` on `jev_local.server.app`, `jev_local.train.train`, `jev_local.train.eval`, `jev_local.train.stream`, `jev_local.engine.encoder.calibrate`, `jev_local.harness.observe`, `jev_local.demo` (table in Files).
- **Changing `serialize.py`, `tokenize_pack.py`, marker ids, `heads.py`, `calibrate.py` lookup or `confidence.py` breaks train/runtime parity** unless the TS port, fixtures and model are changed together.
- Legacy for the runtime library (safe to ignore unless asked): `api.py` routing and benchmax `ServeConfig`, `validate.py`, `server/app.py`, `engine/registry.py`, `engine/heuristic.py`, `engine/decoder/mlx_scorer.py`, all of `harness/**`, `demo.py`, `cli.py`, and the legacy docs listed in Scope.
- `jev_local/data/**` (the v1/v2 data generators) is **not in this repo**: the root `.gitignore` rule `data/` also matches `jev_local/data/`. The 20 `tests/test_data_*.py` files import it and fail at collection.
- Python tests live in `tests/` (71 files); heavy ones are marked `model` / `slow` / `macos`. Per `docs/CONTRACT-v2.md`, torch/model work runs on the Azure VMs, never on the 8 GB Mac.

## Files

### Package core

| path | role | key exports / entry points |
|---|---|---|
| `pyproject.toml` | package `jev-local` 0.1.0, Python `>=3.12,<3.14`, setuptools; console script `jev-local = jev_local.cli:main`; extras `general` (mlx, mlx-lm), `dev` (pytest, jsonschema, typesafe-sdk); pytest `testpaths=["tests"]`, markers `macos`, `model`, `slow` | — |
| `jev_local/__init__.py` | version string | `__version__ = "0.1.0"` |
| `jev_local/schema.py` | Jev wire models (pydantic v2, `extra="ignore"`) | `Entry`, `NoulCriteria`, `NoulQuestion`, `ChoiceQuestion`, `ScoreQuestion`, `Question`, `SystemOneRequest`, `NoulAnswer`, `ChoiceAnswer`, `ScoreAnswer`, `Answer`, `Usage`, `SystemOneResponse`, `question_from_json`, `question_to_json` |
| `jev_local/serialize.py` | canonical text of state and questions, shared by every engine and the trainer | `entry_text`, `Segment` (+ `.digest`: blake2b-12 of key/text), `state_segments`, `state_text`, `QBlock`, `question_block`, `MAX_ARRAY_SEGMENTS`, `DEFAULT_NOUL_INSTR` / `DEFAULT_CHOICE_INSTR` / `DEFAULT_SCORE_INSTR` (values in Constants) |
| `jev_local/confidence.py` | raw distribution -> Jev answer (the only place answers are built) | `choice_confidence`, `score_value`, `score_center`, `score_confidence`, `mad_uniform`, `normalize`, `largest_remainder`, `round_probs`, `build_answer`, `Precision` |
| `jev_local/validate.py` | count limits the schema cannot express | `validate_limits`, `OptionCapExceeded`, `option_cap_message`, `RefusalStyle`, `OPTION_CAP_MARKER`, `MIN/MAX_CHOICE_OPTIONS`, `MIN/MAX_SCORE_LEVELS` |
| `jev_local/api.py` | validate -> normalise -> route -> evaluate -> answers; benchmax run config; determinism report | `ServeConfig` (+ `.preset`, `.rounding`, `.to_dict`), `PRESETS`, `parse_precision`, `resolve_model_id`, `public_model_id`, `route`, `route_key`, `Candidate`, `serve_request`, `Served`, `system_one`, `system_one_json`, `serve_json`, `normalize_request`, `output_tokens`, `too_long_message`, `is_too_long`, `refusal_kind`, `determinism_report`, `hardware_info`, `sha256_file`, `AUTO_IDS`, `AUTO_ORDER`, `EXPLICIT_PREFIXES`, `MAX_TOKENS_EXCEEDED` |
| `jev_local/cli.py` | `jev-local demo ...` and `jev-local serve [--port]` only | `main` |
| `jev_local/demo.py` | voice demo entry (`scripts/demo.py` wraps it); RAM guards `NEED_ENGINE_GB` 1.5, `NEED_WHISPER_GB` 0.6, `NEED_MARGIN_GB` 0.4; checkpoints `CKPTS = {"v1": models/jev-local-fast, "v2": runs/v2/jev-local-fast-v2}` | `main`, `parse_args`, `amain`, `SessionTap`, `required_free_gb` |
| `jev_local/{engine/encoder,engine/decoder,harness,server,train}/__init__.py` | empty package markers; `jev_local/engine/` itself has **no** `__init__.py` (implicit namespace package) | — |

### Engines

| path | role | key exports |
|---|---|---|
| `jev_local/engine/base.py` | engine protocol (no `__init__.py` in `engine/`: implicit namespace package) | `Engine`, `RawDist`, `EngineResult`, `EngineError`, `Kind` |
| `jev_local/engine/registry.py` | lazy construction of `fast` / `general` / `heuristic` | `Registry(fast_ckpt=None, general_repo=None, load_general="lazy", *, load_fast=True, fast_options=None)` with `.engines()`, `.ready`, `.warm()`, `.status()`, `.describe()`, `.unload()`, `.notes`; `default_fast_ckpt`, `general_model_cached`, `is_loaded`, `checkpoint_sha256` (sha256 of `heads.safetensors`, `backbone/model.safetensors`, `calibration.json`, `meta.json`), `DEFAULT_FAST_CKPT`, `FAST_CKPT_ENV`, `DEFAULT_GENERAL_REPO`, `LoadMode` (`lazy`/`eager`/`off`) |
| `jev_local/engine/heuristic.py` | model-free fuzzy-matching fallback | `HeuristicEngine` (`name = NAME = "jev-local-heuristic-0.1.0"`), `reference_text` |
| `jev_local/engine/encoder/tokenize_pack.py` | sequence layout, dense masks, tree layout | `MARKERS`, `BUCKETS`, `MAX_LEN`, `STATE`, `PAD`, `Packer` (`encode`, `segment_text`, `count`, `pack`, `pack_split`, `collate`, `_state_ids`, `_block_parts`, `_layout`), `Packed`, `QIndex`, `Batch`, `build_masks`, `TreeBatch`, `collate_tree`, `add_marker_tokens`, `bucket_for`, `ITEM_CHUNK` |
| `jev_local/engine/encoder/model.py` | ModernBERT forward with arbitrary block mask (reuses the HF submodules `embeddings`, `attn.Wqkv`, `attn.Wo`, `mlp`, norms, `rotary_emb`; re-implements the per-layer attention: RoPE rotated in fp32, SDPA with a per-layer-type boolean mask) | `MaskedEncoder` (`from_pretrained`, `forward`, `forward_raw`, `forward_tree`, `.grad_ckpt`), `BASE_MODEL`, `init_marker_embeddings` |
| `jev_local/engine/encoder/heads.py` | decision heads over marker states; parameter names `norm`, `choice_mlp`, `score_mlp`, `noul_mlp` (the `heads.safetensors` keys) | `DecisionHeads(d=384)`, `MLP`, `build_plan`, `HeadPlan`, `GroupIdx`, `NoulIdx`, `HeadOut`, `QRef`, `probabilities`, `temperature_vector` |
| `jev_local/engine/encoder/calibrate.py` | calibration fit + lookup; CLI | `fit_calibration`, `fit_tau`, `fit_tau_k`, `fit_platt`, `nll`, `tau_for`, `noul_affine`, `calibrate_logits`, `calibrated_probs`, `apply_calibration`, `apply_tau`, `load_calibration`, `describe_calibration`, `header_key`, `k_bucket`, `bucket_key`, `CalibRecord`, `DEFAULT_CALIBRATION`, `main` |
| `jev_local/engine/encoder/engine.py` | `FastEngine`, checkpoint I/O, fast exact encoder | `FastEngine` (`supports`, `count_tokens`, `positions_needed`, `fit_state`, `evaluate`, `evaluate_logits`, `warmup`, `unload`, `calibration_info`, `last_passes`), `BandedEncoder`, `ENCODERS`, `encoder_class`, `init_model`, `load_tokenizer`, `write_checkpoint`, `load_checkpoint`, `plan_passes`, `Fragment`, `pick_device`, `ENGINE_NAME`, `MAX_CHOICE_OPTIONS` (255), `MAX_POSITIONS`, `ENGINE_BUCKETS`, `MARKER_SEEDS` |
| `jev_local/engine/decoder/mlx_scorer.py` | zero-shot Qwen3-1.7B 4-bit prefill-only scorer (macOS/MLX) | `GeneralEngine` (`name = "jev-local-general-0.1.0"`, `available`, `load`, `unload`), `prefix_text`, `choice_suffix`, `score_suffix`, `noul_suffix`, `SYSTEM_PROMPT`, `combine_pages`, `paginate`, `pick_finalists`, `presentation_order`, `neutralizer`, `fork_cache`, `common_prefix_len` |

### Server, training

| path | role | key exports |
|---|---|---|
| `jev_local/server/app.py` | FastAPI app; `python -m jev_local.server.app` CLI | `create_app`, `serve`, `main`, `build_parser`, `config_from_args`, `registry_from_args`, `Counters` (`FIELDS`), `new_request_id`, `rss_mb`, `Overloaded`, `_Gate`, `_Guard`, header names `REQUEST_ID_HEADER`, `ENGINE_HEADER`, `LATENCY_HEADER`, `TRUNCATED_HEADER`, `ENGINE_DESCRIPTIONS`, `ALIASES`, `PUBLIC_DESCRIPTION` |
| `jev_local/train/train.py` | trainer (index mode v1, stream mode v2, DDP) | `train`, `main`, `build_parser`, `encode_example`, `example_tokens`, `parse_target`, `QTarget`, `Row`, `DataStats`, `make_batches`, `prepare_batch`, `build_targets`, `train_buckets`, `JsonlIndex`, `IndexSource`, `StreamSource`, `Prefetch`, `param_groups`, `amp_dtype`, `loss_config`, `parse_curriculum`, `save_state`, `load_state`, `load_weights`, `lr_factor`, `LONG_BUCKETS`, `MAX_TRAIN_LEN` |
| `jev_local/train/stream.py` | torch-free (numpy) indexed mixture reader for `*.jsonl(.zst)` shards; CLI prints the mixture plan | `Corpus` (`.open`, `.summary`), `Mixture` (`.iterate`, `.plan_summary`), `MixConfig` (`.from_json`, `.to_json`), `PassPlan`, `FileIndex`, `build_file_index`, `discover`, `main`, `DEFAULT_BUCKET_WEIGHTS`, `OTHER_BUCKET_WEIGHT`, `SPLITS`, `LICENSES`, `INDEX_VERSION` |
| `jev_local/train/losses.py` | proper-scoring losses + consistency pairs | `LossConfig` (`.v2()`, `.sigma(progress)`), `Targets`, `compute_loss`, `consistency_terms`, term functions `softmax_ce`, `softmax_brier`, `rps`, `spherical`, `coral`, `noul_bce`, `noul_brier`, `entropy`, `smooth`, `NEG_FILL` (-1e4) |
| `jev_local/train/ddp.py` | torchrun/gloo (NCCL on CUDA) helpers, one all-reduce per step | `Dist`, `init_from_env`, `destroy`, `barrier`, `any_flag`, `LaggedFlag`, `GradReducer`, `broadcast_object`, `broadcast_tensors`, `broadcast_optimizer`, `module_tensors` |
| `jev_local/train/eval.py` | per-qid / per-K-bucket metrics; logit collection; CLI | `collect`, `collect_from_model`, `Collected`, `RecMeta`, `metrics_from`, `ece`, `auroc`, `StreamExamples`, `example_source`, `main`, `N_BINS` |
| `jev_local/train/fixture.py` | tiny procedural harness examples for tests (goes through `build_state` / `build_questions` / span extractors) | `make_examples`, `write_splits` |

### Voice computer-use harness (`jev_local/harness/`, summary level; legacy for the runtime)

| module | role |
|---|---|
| `types.py` | `TranscriptEvent`, `Element`, `Snapshot`, `Tail`, `ActionKind`, `RiskLevel`, `Action`, `Decision`, `ExecResult`, `ActionRecord`, `Thresholds`, `HarnessConfig` |
| `catalog.py` | closed vocabularies shown to the model: `INTENTS` (18), `KEYS`, `FOLDERS`, `SCROLL_LEVELS`, `RISK_RE`, deny lists, `SECURE_FIELD_RE`, `CHAIN_WORDS` |
| `questions.py`, `state.py`, `spans.py` | the fixed question schema (`build_questions`, `rank_apps`, `element_line`), `build_state`, verbatim span candidates (`extract_text_candidates`, `extract_url_candidates`, `consumed_for`) |
| `stream.py` | `Stream`: consumed-prefix cursor, virtual utterances `<uid>+<gen>`, fired set |
| `policy.py` | `evaluate_policy`: ordered gates -> `act/wait/ignore/confirm/clarify` |
| `safety.py` | `gate`, `classify_risk`, `deny_reason`, `confirmation_allowed`, `RateLimiter` |
| `controller.py` | `Controller`: asyncio loop (debounce, coalescing, stale rule, execute, consume, re-decide), `halt()` kill switch |
| `client.py` | `DecisionClient` backends `inproc` (calls `api.system_one`), `http`, `hosted` |
| `observe.py`, `execute.py`, `apps.py` | macOS Accessibility snapshots (`Observer`), execution (`Executor`, `MacUI`; dry-run by default), app index |
| `whisper_source.py` | whisper.cpp `whisper-stream` / `whisper-cli` speech sources and utterance tracker |
| `log.py`, `hud.py`, `killswitch.py`, `replay.py`, `simworld.py`, `fakes.py` | audit JSONL (`AuditLog`, default dir `~/.jev-local/log`, `TOP_K = 3` probabilities kept per choice), console HUD (`ConsoleHud`), ⌃⌥⎋ switch (`KillSwitch`), word-timed replay in virtual time (`VirtualTimeLoop`, `run_replay`, `load_script`), simulated screen (`SimWorld`, `SimExecutor`), test fakes (`RuleModel`, `ScriptedEngine`, `FakeObserver`, `FakeExecutor`, `SlowClient`) |

The harness's pure modules (`catalog`, `controller`, `policy`, `questions`, `safety`, `spans`, `state`, `stream`, `types`) were ported to the GenClass Chrome extension's JS core (`extension/src/core/*.js`; e.g. `controller.js` says it is a port of `controller.py`), and `extension/scripts/make_py_fixtures.py` imports `catalog`, `policy`, `questions`, `safety`, `spans`, `state`, `stream`, `types` (not `controller`) plus `jev_local.schema` to generate the extension's parity fixtures. So `harness/**` is legacy for `@genclass/runtime` but is still the reference for the extension (see [extension-and-benchmarks.md](extension-and-benchmarks.md)).

### Entry points

| command | defined in | what it does |
|---|---|---|
| `jev-local demo [...]` / `jev-local serve [--port 8765]` | `pyproject.toml` `[project.scripts]` -> `jev_local/cli.py` -> `main` | demo -> `jev_local.demo.main`; serve -> `server.app.serve(port=...)` with `ServeConfig()` (= `compat`); any other subcommand exits 2 |
| `python -m jev_local.server.app [flags]` | `server/app.py` -> `main` | benchmax server (default `--preset jev`); flags in Constants |
| `python -m jev_local.train.train [flags]` | `train/train.py` -> `main` | trainer (index or stream mode, `--ddp` under torchrun) |
| `python -m jev_local.train.eval --ckpt DIR (--data DIR \| --stream ROOTS) [--split dev] [--out PATH] [--no-calib]` | `train/eval.py` -> `main` | metrics JSON (default `runs/<ckpt name>/eval_<split>.json`) |
| `python -m jev_local.train.stream ROOTS [--cache runs/stream_cache] [--mixture m.json] [--workers 4] [--out PATH]` | `train/stream.py` -> `main` | index shards and print the mixture plan |
| `python -m jev_local.engine.encoder.calibrate --ckpt DIR ...` | `engine/encoder/calibrate.py` -> `main` | fit and **overwrite** `<ckpt>/calibration.json` |
| `python -m jev_local.harness.observe [--app NAME] [--runs 1] [--max-elements 60] [--quiet]` | `harness/observe.py` -> `main` | print a read-only AX snapshot (macOS) |
| `python -m jev_local.demo [...]` or `python scripts/demo.py` | `demo.py` -> `main` | voice demo (dry-run unless `--live`); walkthrough in [`docs/DEMO.md`](../DEMO.md) |

### Tests support files and legacy design docs

| path | role |
|---|---|
| `tests/conftest.py` | `pytest_collection_modifyitems`: skips `macos`-marked tests when `sys.platform != "darwin"` |
| `tests/fixtures/official_examples.json` | Jev documentation examples (server + SDK shape tests) |
| `tests/fixtures/harness_cases.json` | harness decision cases (`test_mlx_scorer.py`; also read by `scripts/bench_{decoder,encoder,laya}.py`) |
| `docs/SPEC.md` | 2026-09-22 rebuild spec: what Jev is (endpoints, wire schema, answer math), how voice computer-use demos work, encoder/decoder design, runtime, data. Many designs differ from code (Drift) |
| `docs/CONTRACT.md` | v0.1 build contract per workstream A–H (API, encoder, decoder, data, harness, macOS I/O, speech, integration); defines the CONTRACT-D training row format still used by `training/` and `sim/` |
| `docs/CONTRACT-v2.md` | v2 mechanics: Mac safety rules (8 GB M1: pure-Python tests only), Azure VM data layout `~/jev/data/v2/`, ownership, lead status notes |
| `docs/DEMO.md` | voice demo setup, commands, what to say, safety, latency, troubleshooting |
| `docs/GENCLASS.md` | public README for GenClass (browser extension + 32M model, Apache-2.0) |
| `docs/COMPARISON.md` | 2026-10-02 meharsjev vs Jev results (computer control, jevbench, compatibility check) |
| `docs/PLAN-excel.md` | 2026-10-03 staged plan to improve the benchmark model (speed fix, specialist, teacher/distil) |

## Concepts and data structures

Terms not in the shared terminology list:

- **System One / Jev wire format.** TypeSafe's typed-decision API shape (`POST /v1/systemone`). `jev_local` reproduces its request/response shapes, limits and answer math (checked against 1,280 real Jev responses per `docs/COMPARISON.md` §3); the runtime's model host uses the same question/answer shape internally.
- **Request** (`SystemOneRequest`): `state: Entry`, `model: str`, `questions: dict[str, Question]` with `min_length=1` (empty `questions` is a pydantic 422). `Question` is a union discriminated by `type` (`"noul" | "choice" | "score"`); unknown fields are ignored everywhere.
- **Question kinds** (`schema.py`). `ChoiceQuestion.criteria: dict[label, Entry | None]` (order = probability order; `None`, `""` or a description equal to the label all mean "read the label by its name alone"). `ScoreQuestion.criteria: list[Entry]` (index = level). `NoulQuestion.criteria: NoulCriteria(true, false) | None`. `instructions` is optional everywhere. `Entry = str | dict | list`.
- **Answers.** `NoulAnswer{noul}` (no confidence field), `ChoiceAnswer{choice, confidence, probabilities}`, `ScoreAnswer{score, confidence, legend, probabilities}` (keys `"0".."n-1"`, legend echoes criteria verbatim). `Usage{input_tokens, output_tokens}`.
- **RawDist** (`engine/base.py`). Unrounded per-question distribution `RawDist(kind, probs, labels)`: noul `probs=(p_true,)`, `labels=()`; choice per label in request order; score per level, labels `"0".."K-1"`. **EngineResult** = `dists`, `input_tokens`, `output_tokens`, `engine` (versioned id), `cached_tokens`, `timings_ms`. **Engine** protocol = `name`, `max_tokens`, `supports(req)`, `count_tokens(req)`, `evaluate(state, questions)`; optional duck-typed `positions_needed(req)` and `fit_state(state, questions)`. **EngineError(detail, status=400)** carries the HTTP status.
- **Segment / QBlock** (`serialize.py`). State -> ordered `Segment(key, text)`: a string state is one segment with key `""`; a dict gives one segment per top-level key; a list gives `"[i]"` segments for the first `MAX_ARRAY_SEGMENTS = 64` items plus one `"[64:]"` tail segment. A question -> `QBlock(qid, kind, header, items, labels)`: header = rendered instructions or a default; choice items `"label: desc"` or bare `"label"`; score items = level texts, labels `"0".."K-1"`; noul items `(true_text or "yes", false_text or "no")`, labels `("true","false")`. **Question ids are never shown to the model.**
- **entry_text rules** (what text the model sees): `None` -> `""`; `str` -> `strip()`; list of strings -> `"; "`-joined non-empty items; other lists -> `json.dumps(..., separators=(", ", ": "))`; dict -> `" | "`-joined `"k: v"` with nested dicts / non-string lists JSON-dumped; anything else -> `str(x)` (so Python renders `True`, `25.0`, `1e-05`). In a dict state, a list-of-strings value is newline-joined.
- **Markers.** `MARKERS = ("[Q]", "[O]", "[L]", "[T]", "[F]")`, added as special tokens. `[Q]` starts a question header, `[O]` a choice option, `[L]` a score level, `[T]`/`[F]` the noul true/false criteria. Heads read hidden states **at marker positions recorded at pack time**; user text is tokenized with `encode_special_tokens = True`, so a label like `"[O] Delete all"` cannot forge a marker. v0.1 ids: `[Q]..[F]` = 50368–50372, `[CLS]` 50281, `[SEP]` 50282, `[PAD]` 50283 (`extension/release-assets/meta.json`); pruned R17/R32 tokenizers: 16359–16363 (`packages/runtime-model/MODEL_CARD.md`).
- **Packed sequence** (`Packed`): `[CLS] seg0 [SEP] seg1 [SEP] ... | [Q] header0 | [O] item00 | [O] item01 | ... | [Q] header1 | ...`, with per-token `input_ids`, `position_ids`, `q_group` (`STATE = -1` for `[CLS]`/state, else question ordinal; `PAD = -2` for padding) and `i_group` (`-1` for state and header tokens, else item ordinal). `QIndex(qid, kind, header, labels, q_pos, item_pos)` records marker positions. State segment text is `"key: text"` (or `text` when key is `""`).
- **Branch.** One question header plus one of its items. Attention rule: a token attends to key *k* iff *k* is a state token, or *k* is in the same question and is a header token or in the same item. Positions restart per branch: header at `S..`, every item at `S+len(header)..`. So `max_tokens` bounds **positions** (state + header + longest item), not the total sequence.
- **Dense vs tree layout.** `build_masks` builds the reference `[B,1,L,L]` boolean masks (`full_attention` and `sliding_attention`, the latter ANDed with `|pos_q - pos_k| <= window`, window = `config.sliding_window` = 64 for ettin). `collate_tree` computes the same attention as three small problems per layer: trunk (state), head (header + its row's state), item chunks (whole items of one question packed into chunks of ≤ `ITEM_CHUNK = 64` tokens, a single longer item gets a wider chunk; keys = its row's state + its header + same-item tokens). **BandedEncoder** (`engine.py`) is a faster exact version of the tree forward (slot gathers, banded local layers); `JEV_ENCODER=reference` selects `MaskedEncoder`.
- **Fragment / pass** (`engine.py`). Each pass holds the state plus at most `max_flat_tokens − state` question tokens. `plan_passes` splits a choice/score question whose header + items exceed that room into contiguous **fragments** (header repeated), then first-fit packs questions and fragments in request order into **passes**, each repeating the state; never two fragments of one qid in a pass; noul is never split. Raw logits of a question's fragments are concatenated and calibrated with **one** softmax over all K options, so the result equals a single pass.
- **Heads** (`heads.py`, d = 384 for ettin-32m). A shared `LayerNorm(d)` normalises gathered marker states, then: choice `z_i = MLP_c([h_Q; h_Oi; h_Q*h_Oi])`; score `z_k = MLP_s([h_Q; h_Lk; h_Q*h_Lk])`; noul `z = MLP_n([h_Q; h_T; h_F; h_Q*h_T; h_Q*h_F])` (absolute, sigmoid). `MLP` = Linear(in -> d) -> GELU -> Linear(d -> 1), last layer `N(0, 0.02)`, bias 0. A `HeadPlan` gathers all questions of a batch into dense `[G, Kmax]` index tensors (padding logits `-inf`).
- **K-bucket.** Option-count bucket for calibration: `2`, `3-5`, `6-10`, `11-30`, `31-100`, `101-255` (`calibrate.K_BUCKETS`); bucket key `"choice:3-5"` etc., `"noul"` for nouls.
- **calibration.json.** v1 keys `{"noul": τ, "choice": τ, "score": τ, "by_header": {sha1(header)[:12]: τ}}`; v2 adds `"version": 2`, `"by_bucket"`, `"tau_k": {"choice": [a, b], "score": [a, b]}` (τ(K) = a + b·ln K), `"noul_platt": {"a", "b"}`, `"bucket_clamp"`, `"_fit"` (stats, ignored at inference).
- **Fast checkpoint dir.** `backbone/` (HF `save_pretrained` of the ModernBertModel + tokenizer with markers), `heads.safetensors`, `calibration.json`, `meta.json` (`name`, `base`, `markers`, `max_len`, `buckets`, `hidden_size`, `written_at`, plus trainer fields `run`, `trained`, `step`, `final`).
- **CONTRACT-D row** (training example, one JSON per line): `{id, split, family, state, questions, labels, meta}`; v2 adds provenance `bucket, source, license_use, variant, group_id`. Labels: choice `{"type":"choice","label":L}` or `{"dist":{L:p}}`; score `{"level":k}` or `{"dist":[...]}`; noul `{"p":x}`. A qid absent from `labels` is unsupervised. `meta.prefix` (harness), `meta.pairs` (consistency), `meta.cap_key|subsource|task` (mixture grouping).
- **Consistency pair** (`meta.pairs`, v2 loss): `{"kind":"neg","a":q,"b":q}` (p(Q)+p(¬Q) = 1), `{"kind":"noul_choice","noul":q,"choice":q,"yes":L}`, `{"kind":"score_choice","score":q,"choice":q,"map":[L per level]}`.
- **Trainer records** (`train/train.py`). `QTarget(dist, hard)` (choice/score: distribution over labels; noul: `[p]`; `hard` = one-hot or p ∈ {0, 1}; `losses.smooth` applies label smoothing only to hard choice/score targets, never to nouls). `Row(pack: Packed, targets: dict[qid, QTarget], example_id, meta)` = one packed sequence. `DataStats(examples, rows, dropped_qids, bad_labels, unsupervised_examples)`. `losses.Targets` = the batch's supervised targets as index tensors aligned with `HeadPlan` groups (`choice_idx/choice/choice_hard`, `score_*`, `noul_idx/noul`, consistency `neg_*`, `nc_*`, `sc_*`).
- **CalibRecord** (`calibrate.py`): `(qid, kind, header, logits, target)` where `header` is already `header_key(...)`, `logits` are raw (τ = 1), choice/score `[K]`, noul `[1]`; `.k` = 2 for noul. `train.eval.collect` returns `Collected(records, metas: list[RecMeta(example_id, prefix, labels, source)], calib, n_examples, dropped_qids)`; `training/eval_runtime.py` consumes exactly this.
- **ServeConfig / preset / W1–W11.** Per-run serving options for the benchmark ("benchmax") effort, chosen once at server start and never per request; W-numbers are requirement ids from `docs/benchmax-research/suite-reproduction-specs.md` (W1 argmax ties, W3 precision, W4 refusals, W5 truncation, W8 label alias, W9 calibration by run config, W10 public id, W11 determinism).
- **Model lineage names.** *jev-local-fast v1* (`models/jev-local-fast`, ettin-32m) = **GenClass 0.1** (`genclass-model-0.1.0`, ONNX in the Chrome extension) = the R32 initialisation. *v2* (`jev-local-fast-v2`, ettin-68m) = public id `meharsjev-68m`, renamed `genclass-<size>`; not used by `training/`. (This "v2" is the old Jev-benchmark model generation; it is unrelated to the runtime's `situation-v2` format.) *R32 / R17* = runtime model candidates (see [glossary.md](glossary.md)); *R68* = ettin-68m student benchmark; *T150* = ettin-150m teacher (pruned to the same 16k vocabulary, fresh heads, never shipped). *r17-final1 / r32-final1* = final round 1 on situation-v1 (R17 is the default; v1 only). Run names `t150-g1`, `r17-t1g10`, `r17-t1g20`, `r17-t1h` were stopped v1 experiments (`training/LOG.md`): `t150-g1` at step 69 around 01:30 UTC when the lead announced the move to situation-v2 (checkpoint kept on c12's disk), the three T1 runs at the situation-v2 freeze (03:32–03:35 UTC).
- **Teacher soft labels** (`training/label_teacher.py`). A calibrated checkpoint's probabilities written back as CONTRACT-D labels: choice `{"type":"choice","dist":{...}}`, score `{"type":"score","dist":[...]}`, noul `{"type":"noul","p":...}`; gold labels kept unless `--overwrite`; `meta.teacher` = `{ckpt, <qid>: {top, margin, non_passive_mass (action only)}}` for choice/score questions and `{p}` for nouls; probabilities rounded to 5 dp; default `--max-len 2048`, `--batch 32`, `--threads 16`; resumable by line count. Its `PASSIVE` set is `apply, send, deliver, wait, ignore` (the passive actions of every trigger; `deliver` is the passive of both `failure` and the v2 `delivery` trigger). It reuses this package's training-side inference path (`load_checkpoint(..., encoder="banded")` (the `JEV_ENCODER` env var overrides it), `train.encode_example`, `train.train_buckets`, `Packer`, `collate_tree`, `build_plan`, `calibrate_logits` + `header_key`), not `FastEngine`; packing goes through `Packer.pack_split` rather than `FastEngine`'s `plan_passes`, so the numbers should match `FastEngine` only for rows that fit one pass (unverified).
- **T1 / expected-gain targets** (`training/t1_relabel.py`, sim/SEPARABILITY.md §7; no `jev_local` import). gain(a) = mean cost(passive) − mean cost(a) − premium (guard 0.25, heal 0.5; an action with no tier in `meta.tiers` pays the heal premium), clipped ±30, costs from `meta.cost_futures` (fallback `meta.costs`); the action label becomes softmax(gain/τ), or with `--keep-dist` SIM's label is kept and gains are added for a **gain head**. The gain head (an MLP over option marker states, one scalar per option, `HeadOut.gain`, trainer `--gain-loss W`) exists **only in the parent repo's `jev_local`** per `training/LOG.md`; this tree's `heads.HeadOut` has only `choice`, `score`, `noul`. Details: [training.md](training.md).

## How it works

### 1. One request through the HTTP server

1. `jev_local/server/app.py` -> `_Guard` (pure ASGI): assigns `x-typesafe-request-id` (`req_` + 12 hex ms + 16 random hex), rejects a Host not in `LOCAL_HOSTS` (400 `Invalid host header`), and, when an API key is set, requires `Authorization: Bearer <key>` on `/v1/*` (401).
2. `create_app` -> `systemone`: pydantic parses `SystemOneRequest` (schema errors -> 422); unknown top-level fields are logged once per distinct set (`_log_extra_fields`, max 256 sets).
3. `_Gate.slot()`: one evaluation at a time (asyncio lock); if busy and `waiting >= max_queue` -> 529 `{"detail":"Overloaded"}`, `retry-after: 1`. Evaluation runs in a threadpool under a second `threading.Lock`.
4. `api.serve_request`: `validate.validate_limits` (count limits, option-cap refusal per `ServeConfig`), then `normalize_request` when `label_alias` (description == key -> `None`), then `_candidates` (flow 2 below).
5. `cand.engine.evaluate(state, questions)` -> `EngineResult`. A too-long error from an engine whose estimate undershot moves auto mode to the next engine; explicit mode raises it in the canonical shape `{"detail":[{"type":"max_tokens_exceeded","msg":...}]}`.
6. `confidence.build_answer` per question (precision and centre from `ServeConfig`), `usage.input_tokens` = engine count, `usage.output_tokens` = Σ (items + 1) (`api.output_tokens`), `model` = `api.public_model_id`.
7. Response headers: `x-jev-local-engine` (`fast|general|heuristic`), `x-jev-local-latency-ms`, and `x-jev-local-truncated` when state tokens were cut. `Counters` record served / refused / truncated for `/healthz` and `/x/v1/run`.

#### HTTP API reference (`server/app.py` -> `create_app`)

| method, path | auth | 200 body | notes |
|---|---|---|---|
| `POST /v1/systemone` | bearer if a key is set | `SystemOneResponse` `{model, answers: {qid: Answer}, usage: {input_tokens, output_tokens}}` | headers `x-jev-local-engine`, `x-jev-local-latency-ms` (1 dp), `x-jev-local-truncated` (only when state tokens were cut) |
| `GET /v1/models` | bearer if a key is set | `{"models": [{name, description, release_date}]}` | configured `model_id` first (only if set and a `fast` engine was built), then every engine's versioned name, then aliases `jev-local`, `jev-latest`; `release_date` = `RELEASE_DATE` |
| `GET /healthz` | none | `{ok, version, engines: {fast, general, heuristic: loaded\|lazy\|off\|missing\|error}, queue: {waiting, max}, rss_mb, benchmax: {config, counters, started_at}}` | not a Jev route |
| `GET /x/v1/run` | none | `{config, counters, started_at, registry: Registry.describe(), hardware: hardware_info(), version}` | not a Jev route |

FastAPI's own `/openapi.json` and `/docs` are also served (`test_server.py` checks the OpenAPI document). Every response, errors included, carries `x-typesafe-request-id`.

| status | body | when |
|---|---|---|
| 400 | `{"detail": "Invalid host header"}` | Host not in `LOCAL_HOSTS` (unless `allow_remote`) |
| 400 | `{"detail": "<message>"}` | count limits, `No local engine supports this request`, `Model <name> does not support this request` |
| 400 / 413 / 422 | `{"detail": [{"type": "max_tokens_exceeded", "msg": ...}]}` or the option-cap message | capacity refusals; status = `ServeConfig.refusal_status` |
| 401 | `{"detail": "Missing API key"}` / `{"detail": "Invalid API key"}` + `www-authenticate: Bearer` | `/v1/*` only |
| 404 | `{"detail": "Model not found: <id>"}` | unknown id, or engine not installed |
| 422 | FastAPI validation shape | schema errors; empty score `criteria` (raised by `validate_limits` in the same shape) |
| 500 | `{"detail": "Internal server error"}` | unexpected exception (logged with the request id) |
| 503 | `{"detail": "No decision engine is available"}` | registry has no engines (not reachable in practice: heuristic is always built) |
| 529 | `{"detail": "Overloaded"}` + `retry-after: 1` | `max_queue` waiters already queued |

Illustrative request and response (numbers made up but consistent with the answer math; `compat` rounding):

```json
{"model": "jev-local", "state": {"transcript": "open safari"},
 "questions": {"intent": {"type": "choice", "instructions": "Which action?", "criteria": {"open_app": "open an app", "none": null}},
               "done": {"type": "noul", "instructions": "Is the command complete?"},
               "urgency": {"type": "score", "criteria": ["low", "high"]}}}
```

```json
{"model": "jev-local-fast-0.1.0",
 "answers": {"intent": {"type": "choice", "choice": "open_app", "confidence": 0.9, "probabilities": {"open_app": 0.95, "none": 0.05}},
             "done": {"type": "noul", "noul": 0.97},
             "urgency": {"type": "score", "score": 0.3, "confidence": 0.4, "legend": {"0": "low", "1": "high"}, "probabilities": {"0": 0.7, "1": 0.3}}},
 "usage": {"input_tokens": 41, "output_tokens": 9}}
```

`output_tokens` = (2 + 1) + (2 + 1) + (2 + 1) = 9; `model` is the engine's versioned name because `jev-local` is an auto alias and no public `model_id` is configured.

### 2. Model-id resolution and routing (`api.py`)

1. Strip a vendor prefix `typesafe/`. `AUTO_IDS` (`jev-local`, `jev`, `jev-latest`, `jev-preview`, `jev-1.13`, `jev-1.13.0`) -> auto. Prefixes `jev-local-fast|general|heuristic` -> that engine. `genclass-*` / legacy `meharsjev-*` -> `fast` (if `ServeConfig.model_id` is set, only that exact id). Anything else -> 404 `Model not found: <id>`.
2. Explicit engine: missing -> 404; `_prepare` (truncate mode: `engine.fit_state`); length check `_needed` (`positions_needed` if the engine has it, else `count_tokens`) **before** `supports`, so a too-long request is always a capacity refusal; then `supports` (400 if false).
3. Auto: try `AUTO_ORDER = ("fast", "general", "heuristic")` lazily; skip engines that are too long or do not support the request. If something was too long -> that refusal; no engines at all -> 503; else 400 `No local engine supports this request`.

### 3. `FastEngine.evaluate` (`engine/encoder/engine.py`)

1. `serialize.state_segments(state)` and `question_block` per question.
2. `_forward`: `Packer._state_ids` (`[CLS]` + segments with `[SEP]`), `Packer._block_parts` (markers + cached token ids), `plan_passes(n_state, blocks, parts, max_tokens, max_flat_tokens)`; raises `EngineError` 400 `max_tokens_exceeded` if any branch exceeds `max_tokens` positions or the state alone leaves no room.
3. Per pass: `Packer._layout` -> `collate_tree(..., buckets=ENGINE_BUCKETS)` -> `build_plan` -> `heads(enc(batch), plan)`; one host sync per pass. (`attn="dense"` uses `Packer.collate` + `build_masks` instead.)
4. Concatenate each question's fragment logits in option order; `calibrate.calibrate_logits(kind, header_key(header), logits, calib)` in float64 numpy -> `RawDist`.
5. `EngineResult.input_tokens` = state + all header and item tokens counted once (repeated state across passes not counted); `timings_ms` has `serialize`, `pack`, `forward`, `heads`, `total`, `passes`.

### 4. Calibration lookup (`calibrate.tau_for`, `calibrate.noul_affine`, `calibrate.calibrate_logits`)

1. `by_header[sha1(header)[:12]]` wins for every kind (fixed-instruction questions keep their own temperature).
2. noul: `noul_platt` (p = sigmoid(a·z + b)) else per-kind τ (p = sigmoid(z/τ)).
3. choice/score: `by_bucket["<kind>:<K-bucket>"]` else `tau_k` (clamped to `bucket_clamp`, default [0.5, 5.0]) else per-kind τ; then softmax(z/τ) with K = full option count.
4. `FastEngine(calibration=...)` **replaces** (never merges with) the checkpoint file (W9); `drop_header_calibration=True` empties `by_header`.

### 5. Answer math (`confidence.build_answer`)

1. Choice: reorder engine probs to request label order (`_ordered_probs`), `normalize` (clip, drop NaN/inf, renormalise; all-zero -> uniform), `choice` = argmax of the **unrounded** probs, ties -> first label (W1); `confidence = (K·pmax − 1)/(K − 1)` clipped to [0, 1].
2. Score: `score = Σ i·pᵢ`; `confidence = max(0, 1 − Σ pᵢ|i − c| / MAD_uniform(K))`, `c` = mode (default; first index on ties) or median; `legend` echoes criteria.
3. Noul: `p` clipped to [0, 1]; NaN/inf -> 0.5. No range clamp beyond [0, 1].
4. Precision: `round` (each number to N dp, default 2), `lr` (largest-remainder rounding so Σp = 1.00 exactly; scalars still from unrounded probs), `exact` (no rounding). `+ 0.0` everywhere removes `-0.0`.

### 6. Decoder and heuristic engines (legacy, summary)

1. `GeneralEngine` (`mlx_scorer.py`): prefix = `SYSTEM_PROMPT` + `<document>{state_text}</document>` in Qwen3 ChatML, prefilled once in chunks of 512 and reused across requests by longest common prefix. Each question is a branch suffix ending with the assistant header and an empty `<think>` block; the answer is read from **next-token logits only**: letters `A..Z` (choice), digits `0..9` (score), `sigmoid(logit("Yes") − logit("No"))` (noul). >26 options are paginated (pages of 25, top ≤3 per page to a final round, merged by `combine_pages`). Control-token strings in user text are broken by `neutralizer`. Branches are batched (≤ 8 rows, ≤ 1024 padded tokens). Never downloads unless `allow_download=True`; missing weights -> 503.
2. `HeuristicEngine`: picks a reference text (state segment named by a backticked path in the instructions, else a transcript-like key, else the whole state), scores options by IDF- and field-weighted word matches (exact, rapidfuzz ≥ 80, 5-letter stem), softmax with scale `(1 + ln K)/0.6`; nouls from criteria similarity or keyword cues (0.5 with no cues, 0.4 when cues are absent from the text). Always present in the registry, < 5 ms target.

### 7. Training (`train/train.py`)

1. `init_model(base)`: tokenizer + markers (`add_marker_tokens`), backbone via `encoder_class(...).from_pretrained` (HF cache only, `local_files_only`), embeddings resized and marker rows seeded by `init_marker_embeddings` (0.5·(mean of seed-word embeddings + `[CLS]` embedding); seeds `MARKER_SEEDS`), fresh `DecisionHeads`. `--init-only` writes a servable checkpoint with random heads.
2. Data source: **index mode** (`--data`/`--extra` dirs with `train.jsonl`; `JsonlIndex` byte offsets; `make_batches` length-bucketed by line bytes) or **stream mode** (`--stream` roots; `stream.Corpus` decompresses `.zst` once into `--stream-cache` and indexes per-row offset, split, licence, group, #decisions, class key, layout sizes; `stream.Mixture` filters by split/licence/bucket, caps per group/class, allocates tokens by bucket weight and `n_decisions^alpha` with water-filled repeat limits, shuffles, cuts token-budget micro-batches, optional length curriculum).
3. `encode_example`: `question_from_json` -> `question_block` -> `parse_target` -> `Packer.pack_split` (an over-long example becomes several rows, each repeating the state; questions too long even alone are dropped and counted).
4. `prepare_batch`: `collate_tree` (default `--attn tree`) + `build_plan` + `build_targets` (+ `_pair_refs` for consistency pairs).
5. Forward under optional autocast (`--amp`: fp16 on MPS, bf16 on CPU / bf16 CUDA), `losses.compute_loss`, backward with `/grad_accum`; AdamW (betas 0.9/0.98, eps 1e-6, decay 0.01 except norms/embeddings/biases; heads at `--head-lr`), warmup + cosine (`lr_factor`), grad-norm clip.
6. DDP (`--ddp` under torchrun): no DDP wrapper; `ddp.GradReducer` all-reduces one flat buffer (grads + counters + has-grad flags) per optimizer step; data cursor counts global micro-batches so resume works on a different world size; SIGTERM handled by `LaggedFlag` (non-blocking flag read one micro-batch later; `--stop-check micro` = blocking `any_flag` per micro-batch).
7. Checkpointing: trainer state in `runs/<run>/ckpt/` (`model.safetensors`, `optim.pt`, `trainer.json`, atomic swap) and the servable export in `--out` via `write_checkpoint` (fp32 on CPU, atomic swap; meta gets `base`, `max_len` = `--max-len`, `run`, `trained`, `step`, `final`), every `--ckpt-every` steps and at the end; first SIGINT/SIGTERM finishes the step (DDP: all ranks drop the partial step), checkpoints and exits **130**. Logs: `runs/<run>/log.jsonl`, `mixture_plan.json`, optional `timing/rank<r>.jsonl`.
8. `train/eval.py` collects raw logits (`collect`), computes accuracy / NLL / Brier / ECE (15 bins) / AUROC per qid, kind, K-bucket and source; `calibrate.py main` fits and writes `calibration.json` into the checkpoint.

### 8. Voice harness (legacy, summary)

`whisper-stream` -> `WhisperSource` (parser + `UtteranceTracker`) -> `Controller.on_event` -> `Stream.update` (tail after the consumed prefix) -> debounce -> `build_state` + `build_questions` (one request with every question: speculative fan-out) -> `DecisionClient.system_one` -> stale check -> `policy.evaluate_policy` -> `safety.gate` -> `Executor.run` on a worker thread (dry-run by default) -> `Stream.consume` -> re-decide on the rest (≤ `MAX_LOOPS = 4`). Typed text is always a verbatim transcript span chosen by a choice question. Walkthrough and safety rules: [`docs/DEMO.md`](../DEMO.md).

### 9. From a Python checkpoint to the runtime's model (lineage)

1. Train with `jev_local/train/train.py` (stream mode) from `training/` launchers (`scripts/launch_run.sh` runs `python -m torch.distributed.run ... -m jev_local.train.train --ddp` on each node); R32 starts from v1 `jev-local-fast` (v1 heads) after `training/prune_vocab.py` keeps the first 16,000 BPE merges (16,364 tokens) into `models/r32-v16k` (launched with `--base .../r32-v16k/backbone`); R17 from the pruned `ettin-17m-v16k` base with fresh heads; stage 1c `--init-from` the stage-1 trainer state (`runs/<model>-s1/ckpt`); the stage-2 pilot and final round 1 both `--init-from` the stage-1c state (`runs/<model>-s1c/ckpt`), not the pilot (`training/launch_s2.sh`, `training/launch_final1.sh`).
2. Evaluate / fit temperatures with `training/eval_runtime.py` (uses `jev_local.train.eval.collect` for raw logits; its own `fit_calibration` fits per-kind, `action`/`diagnosis` group and `by_header` (≥ 300 records) temperatures; `--write-calibration` writes only `noul`/`choice`/`score`, `by_header` (only with `--header-calibration`, else `{}`) and `_fit`: the group temperatures are evaluation-only).
3. Export: `training/export_runtime.py` imports `scripts/genclass_export.py`'s `ExportModel` (dense block mask built in-graph, raw logits at τ = 1) over `load_checkpoint(..., encoder="reference")`, writes `<name>-q8.onnx` / `<name>-fp16.onnx`, `tokenizer.json`, `calibration.json`, `meta.json`, `model.json`, plus `parity.json`, `pack_fixtures.json`, `torch_fixtures.json`, `requests.json` computed with the Python `Packer` and `calibrate_logits`.
4. In the browser, `packages/runtime/src/model` re-implements packing and calibration in TypeScript and runs the ONNX graph with onnxruntime-web; its tests compare against those fixtures (port table below). Details: [runtime/model-host.md](runtime/model-host.md), [model-io-contract.md](model-io-contract.md).

### 10. Situation-v2 training and this package (2026-10-08 plan; v2 data generation running, no training run on v2 yet)

The runtime's situation format is frozen at tag `situation-v2` (6e5e86e). SIM generates v2 gold and unlabeled rows and REAL generates real-browser rows ([realapps.md](realapps.md)); both are CONTRACT-D rows, so the trainer and serialization here are unchanged. The planned pipeline (`training/PLAN-v1.md`, `HANDOFF.md`) and which `jev_local` pieces each step uses:

| step | script | `jev_local` used |
|---|---|---|
| prune bases (to 16,000 merges = 16,364 tokens) | `training/prune_vocab.py prune`; the launchers call it on each node when the pruned base is missing: `launch_student.sh` for 68m and 150m (whatever ARCH), `launch_t150.sh` for 150m, `launch_r68.sh` for 68m. The 17m base `ettin-17m-v16k` and `r32-v16k` are not auto-pruned and must already exist on the nodes | tokenizer + checkpoint I/O |
| teacher T150 on v2 gold (+ curriculum replay) | `training/launch_student.sh RUN t150 ...` or the older `training/launch_t150.sh` (stream `data/s3` only, fixed `mix_t150.json`, seed 4; its header comment says 6 ranks × 13 threads but the code defaults to `RANKS=8`, `THREADS=10`) -> `scripts/launch_run.sh` -> `python -m torch.distributed.run ... -m jev_local.train.train --ddp` | trainer (stream mode, `--balance --amp --no-grad-ckpt --device cpu --max-len 2048 --batch-tokens 8192 --ckpt-every 25 --resume`) |
| teacher soft labels on unlabeled rows | `training/label_cluster.sh` (fan-out over nodes; untested per LOG) -> `training/label_teacher.py` | inference path listed in Concepts |
| distil R17 (default) and R32 (and R68) | `training/launch_student.sh RUN {r17,r32,r68} PASSES MIX "nodes" [INIT]` | trainer |
| evaluate / fit temperatures | `training/eval_sim.sh`, `training/eval_runtime.py` (now also reports `recall_clear` and `recall_clear_stale_dup` per gate mode), `training/report.py` | `train.eval.collect` |
| T1 gain evaluation | `training/eval_gain.py` (numpy only), `training/collect_gain.py` (needs the parent repo's gain head for `gain_pred`; see Drift) | inference path |
| export | `training/export_runtime.py` | as in §9 step 3 |

`launch_student.sh` defaults per ARCH (base, lr, head lr, grad-accum, ranks × threads): r17 `ettin-17m-v16k`, 2e-4, 1e-3, 2, 8×10; r32 `r32-v16k/backbone`, 1e-4, 4e-4, 3, 8×10; r68 `ettin-68m-v16k`, 2e-4, 1e-3, 2, 8×10; t150 `ettin-150m-v16k`, 2e-4, 1e-3, 2, 8×10; streams `data/s3` and `data/s1`, seed 7; overrides via `RANKS`, `THREADS`, `GA_OVERRIDE`, `LR_OVERRIDE`, `HLR_OVERRIDE`; trainer args after `--` are passed through. The older `training/launch_r68.sh` differs (lr 3e-4, seed 5, fixed 8 × 10, `mix_r68.json`). New mixture files (`training/configs/mix_t150.json`, `mix_r68.json`, `mix_t1a.json`, `mix_t1b.json`, `mix_t1h.json`) use a per-bucket `max_repeat` dict (e.g. `{"*": 2.0, "simA": 1.2}`), which this tree's `stream.MixConfig.repeat` supports; their SIM buckets are situation-v1 phase-A data (`simA`, `simAg10`, `simAg20`, `simAh`, plus `cur4` / `cur1` / `gen`), so the v2 mixtures are still to be written. Full training-side detail: [training.md](training.md).

### Port map: Python -> TypeScript (`packages/runtime/src/model`)

The port went Python -> the GenClass extension's JS core (`extension/src/core/{serialize,packer,tokenizer,pyutil,engine}.js`) -> TypeScript.

| Python (`jev_local/...`) | TypeScript (`packages/runtime/src/model/...`) | notes |
|---|---|---|
| `serialize.py` -> `entry_text`, `state_segments`, `question_block`, `state_text` | `serialize.ts` -> `entryText`, `stateSegments`, `questionBlock`, `stateText` (+ `pyutil.ts` -> `pyNumber`, `pyStrip`) | renders values exactly as Python does **after a JSON round trip** (int vs float text, `str.strip` whitespace set, `True`/`False`) |
| HF `tokenizers` `encode_batch(..., add_special_tokens=False)` with `encode_special_tokens=True` (`Packer.__init__`, `Packer.encode`) | `tokenizer.ts` | byte-level BPE from `tokenizer.json`; special tokens never matched in text |
| `engine/encoder/tokenize_pack.py` -> `Packer._state_ids`, `_block_parts`, `_layout`, `MARKERS`, `STATE` | `packer.ts` -> `Packer.stateIds`, `blockParts` / `layout` (private), `pack`, `measure`, `MARKERS`, `STATE` | **single pass only**: throws `MaxTokensExceededError` when state + longest branch > `maxPositions` (default 1536, meta `max_len`) or total > `maxTotal` (default 8192, meta `max_total`); no `plan_passes`, no `fit_state` |
| `scripts/genclass_export.py` -> `plan_inputs`, `unpack` | `packer.ts` -> `planInputs`, `unpackLogits` | ONNX feed: `input_ids, position_ids, q_group, i_group, choice_q, choice_items, score_q, score_items, noul_q, noul_t, noul_f` -> `choice_logits, score_logits, noul_logits` |
| `engine/encoder/model.py` `MaskedEncoder` + `heads.py` `DecisionHeads` | the ONNX graph, run by `engine.ts` / `backend.ts` | dense reference mask in-graph (batch 1, no padding) |
| `engine/encoder/calibrate.py` -> `header_key`, `k_bucket`, `tau_for`, `noul_affine`, `calibrate_logits`, `K_BUCKETS`, `BUCKET_CLAMP` | `calibrate.ts` -> `headerKey`, `kBucket`, `tauFor`, `noulAffine`, `calibrateLogits`, `K_BUCKETS`, `BUCKET_CLAMP` | identical lookup order; fitting is not ported |
| `confidence.py` -> `normalize`, `choice_confidence`, `score_confidence(center="mode")`, `build_answer` | `calibrate.ts` -> `normalizeProbs`, `choiceConfidence`, `scoreConfidence`, `buildAnswer` | TS precision is `"exact"` (default) or `"round"` (2 dp); no `lr`, no median centre; runtime `ScoreAnswer` has **no `legend`** |
| not ported | — | `validate.py`, `api.py` routing/`ServeConfig`, multi-pass option batching, truncate mode, heuristic and decoder engines |

Fixtures (all in `packages/runtime/test/fixtures/model/`): `py_fixtures.json` (sections `serialize`, `tokenize`, `pruned`, `calibrate`, `confidence`; regenerate with `packages/runtime/test/fixtures/model/make_py_fixtures.py`, not to be confused with the extension's `extension/scripts/make_py_fixtures.py`; it imports `jev_local.serialize`, `jev_local.schema`, `jev_local.engine.encoder.calibrate`, `jev_local.confidence`), `requests50.json`, `pack_fixtures.json`, `torch_fixtures.json` (50 each; from the v0.1 export flow). Tests prefer `requests.json` / `pack_fixtures.json` / `torch_fixtures.json` from the model directory (`GENCLASS_MODEL_DIR`) when present (`packages/runtime/test/model/helpers.ts`). Reported results (unverified): packing identical on all 50 v0.1 fixtures, q8 decisions 79/80 vs PyTorch (`OPEN_TASKS.md`); R32 export q8 450/454, fp16 453/454, bit-exact packing on 89/90 requests (`packages/runtime/src/model/README.md`).

### What `training/` reuses vs what is legacy

| `jev_local` part | used by `training/` / runtime pipeline? | how |
|---|---|---|
| `train/train.py`, `train/stream.py`, `train/losses.py`, `train/ddp.py` | **yes** | the trainer for R17/R32 (stream mode, DDP, `--balance`, `--init-from`; the `training/` launchers pass no `--loss`, so the v1 loss default applies) |
| `train/eval.py` | **yes** | `collect` used by `training/eval_runtime.py`; `train.parse_target` used by `training/curriculum/generate.py` to validate labels; `train.encode_example` and `train.train_buckets` (both in `train/train.py`) used by `training/label_teacher.py` and `training/collect_gain.py` |
| `engine/encoder/{tokenize_pack,model,heads,engine}.py` | **yes** | `init_model`, `load_checkpoint`, `write_checkpoint`, `Packer`, `collate_tree`, `build_plan`, `FastEngine` (export, prune tests); teacher labelling and gain collection use `load_checkpoint` + `Packer` + `collate_tree` + `build_plan` directly, not `FastEngine` |
| `engine/encoder/calibrate.py` | lookup **yes** (export parity, teacher labels); fitting/CLI no (TRAIN fits in `eval_runtime.py`) | `calibrate_logits`, `header_key` |
| `schema.py`, `serialize.py` | **yes** | `question_from_json`, `question_block`, `state_segments` (curriculum validation, export, pruning) |
| `confidence.py` | parity only | TS port + `packages/runtime/test/fixtures/model/make_py_fixtures.py` |
| `api.py`, `validate.py`, `server/**`, `engine/registry.py`, `engine/heuristic.py`, `engine/decoder/**` | no | Jev-compatible server and benchmarks (legacy) |
| `harness/**`, `demo.py`, `cli.py`, `train/fixture.py` | no | voice computer-use product and its tests (legacy for the runtime; `harness/**` remains the parity source for the Chrome extension's `extension/src/core/*.js` via `extension/scripts/make_py_fixtures.py`) |

Two exporter copies exist: `scripts/genclass_export.py` (imported by `training/export_runtime.py`, which inserts `~/jev` and `~/jev/scripts` into `sys.path`, i.e. the VM copy synced by `training/node.sh`) and `extension/tools/genclass_export.py` (the extension's copy; the files differ). Change the one `training/` imports.

## Configuration and constants

### Serialization and answer math (`serialize.py`, `confidence.py`): model-input constants

These strings are model input; the TS port copies them verbatim (`packages/runtime/src/model/serialize.ts`). Changing any of them is a parity break (see Invariants).

| name | type | value | defined in | effect |
|---|---|---|---|---|
| `DEFAULT_NOUL_INSTR` | str | `"Is the statement true of the state?"` | `serialize.py` | noul header when `instructions` renders empty |
| `DEFAULT_CHOICE_INSTR` | str | `"Which option best fits the state?"` | `serialize.py` | choice header default |
| `DEFAULT_SCORE_INSTR` | str | `"Which level best describes the state?"` | `serialize.py` | score header default |
| noul item defaults | str | `"yes"` / `"no"` | `serialize.question_block` | `[T]` / `[F]` item text when criteria sides are absent or empty |
| `MAX_ARRAY_SEGMENTS` | int | 64 | `serialize.py` | list states: items 0..63 one segment each, the rest newline-joined into `"[64:]"` |
| segment text | format | `"key: text"` (bare `text` when key is `""`) | `tokenize_pack.Packer.segment_text` | each followed by `[SEP]` |
| `state_text` | format | `"key:\ntext"` blocks joined by `"\n\n"` | `serialize.state_text` | decoder engine only |
| `build_answer` defaults | kwargs | `round_digits=2`, `center="mode"`, `precision="round"` | `confidence.py` | `serve_request` passes values from `ServeConfig` |
| score median centre | rule | first index with cumulative p ≥ 0.5 − 1e-12 | `confidence.score_center` | only with `center="median"` |

### Wire limits and serving (`validate.py`, `api.py`, `server/app.py`)

| name | type | value | defined in | effect |
|---|---|---|---|---|
| `MIN_CHOICE_OPTIONS` / `MAX_CHOICE_OPTIONS` | int | 2 / 255 | `validate.py` | 400 outside; >255 is `OptionCapExceeded` with `ServeConfig.refusal_status` |
| `MIN_SCORE_LEVELS` / `MAX_SCORE_LEVELS` | int | 2 / 10 | `validate.py` | 400 outside; **0 levels is a 422** in FastAPI's error shape |
| `OPTION_CAP_MARKER` / `CONTEXT_MARKER` | str | `"options per choice"` / `"maximum context length"` | `validate.py` / `api.py` | capacity markers in `refusal_style="jev"` wording |
| `AUTO_IDS`, `AUTO_ORDER` | set / tuple | see How it works 2; order `fast, general, heuristic` | `api.py` | auto routing |
| `PUBLIC_PREFIX`, `PUBLIC_PREFIXES` | str / tuple | `"genclass-"`; `("genclass-", "meharsjev-")` | `api.py` | public ids route to `fast` |
| `ServeConfig()` defaults | dataclass | `precision="round2"`, `overflow="refuse"`, `refusal_status=400`, `refusal_style="local"`, `model_id=None`, `label_alias=True`, `center="mode"`, `name="compat"` | `api.py` | v1 server behaviour |
| `ServeConfig` validation | `__post_init__` | `precision` ∈ `exact` \| `round<N>` \| `lr<N>` (N = 1–2 digits, default 2; `parse_precision`); `overflow` ∈ refuse/truncate; `refusal_status` ∈ {400, 413, 422}; `refusal_style` ∈ local/jev; `model_id` matches `^(?:genclass\|meharsjev)-[a-z0-9][a-z0-9.\-]*$` | `api.py` | `ValueError` at start-up |
| `PRESETS` | dict | `compat`; `jev` (+jev wording); `di` (exact, refuse, 400, jev); `jevbench` (exact, refuse, 422, jev); `deusser` (exact, truncate, 400, jev); `paired2dp` (lr2, truncate, 400, jev) | `api.py` | `--preset` |
| `DEFAULT_HOST` / `DEFAULT_PORT` | str / int | `127.0.0.1` / 8765 | `server/app.py` | `serve` refuses other hosts unless `allow_remote` |
| `MAX_QUEUE` | int | 32 | `server/app.py` | waiters before 529 |
| `API_KEY_ENV` | env | `JEV_LOCAL_API_KEY` | `server/app.py` | optional bearer auth on `/v1/*` |
| `LOCAL_HOSTS` | set | `127.0.0.1`, `localhost`, `::1`, `testserver` | `server/app.py` | DNS-rebinding Host check |
| `RELEASE_DATE` | str | `"2026-09-24"` | `server/app.py` | `/v1/models` |
| server CLI defaults | args | `--preset jev`, `--threads 16`; general engine off when `--no-general` or not macOS | `server/app.py` -> `build_parser`, `registry_from_args` | note `jev-local serve` (cli.py) uses `ServeConfig()` = `compat`, not `jev` |
| `Counters.FIELDS` | tuple | `requests`, `served`, `truncated_requests`, `truncated_tokens`, `refused_context`, `refused_options`, `errors_4xx`, `errors_5xx`, `overloaded` | `server/app.py` | `/healthz` `benchmax.counters`, `/x/v1/run` |
| request id | format | `req_` + 12 hex digits of epoch ms + 16 random hex | `server/app.py` -> `new_request_id` | `x-typesafe-request-id` |
| unknown-field log | int | ≤ 256 distinct field sets remembered | `server/app.py` -> `_log_extra_fields` | logs once per set |

`python -m jev_local.server.app` flags (`build_parser`; `None` = keep the preset's / engine's own value): `--preset {compat,jev,di,jevbench,deusser,paired2dp}` (jev), `--precision`, `--overflow {refuse,truncate}`, `--refusal-status {400,413,422}`, `--refusal-style {local,jev}`, `--model-id`, `--no-label-alias`, `--ckpt PATH` (default `$JEV_LOCAL_FAST_CKPT` or `models/jev-local-fast`), `--calib PATH` (replaces the checkpoint's calibration, W9), `--global-calibration-only` (drop `by_header`), `--max-tokens`, `--max-flat`, `--device` (free text, help says `cpu | mps`; unset = `FastEngine`'s `mps`, falling back to cpu), `--threads 16`, `--no-general`, `--host 127.0.0.1`, `--allow-remote` (disables the Host check), `--port 8765`, `--max-queue 32`, `--api-key`, `--log-level info`, `--print-config` (print `{config, fast_options}` JSON and exit). `config_from_args` applies the overrides on top of `ServeConfig.preset(...)`; `registry_from_args` turns the engine flags into `Registry(fast_options=...)`.

### Environment variables

| variable | read by | effect |
|---|---|---|
| `JEV_LOCAL_API_KEY` | `server/app.py` -> `create_app` (`API_KEY_ENV`); `harness/client.py` (http backend) | enables / sends bearer auth on `/v1/*`; empty = no auth |
| `JEV_LOCAL_FAST_CKPT` | `engine/registry.py` -> `default_fast_ckpt`; `tests/test_bm_engine_vm.py` (default `~/jev/models/jev-local-fast-v2`); `tests/test_bench_ours.py` (default `~/jev/models/jev-local-fast`) | fast checkpoint dir (default `<repo>/models/jev-local-fast`) |
| `JEV_ENCODER` | `engine/encoder/engine.py` -> `encoder_class` | forces `reference` or `banded` for every constructor |
| `TYPESAFE_API_KEY` | `harness/client.py` (`API_KEY_ENV`, hosted backend at `https://api.typesafe.ai`) | hosted Jev key (constructor `api_key` or this variable); without one the hosted backend raises `DecisionError` before opening a connection |
| `RANK`, `WORLD_SIZE`, `MASTER_ADDR`, `MASTER_PORT` (required), `LOCAL_RANK`, `LOCAL_WORLD_SIZE` | `train/ddp.py` -> `init_from_env` | torchrun process group (`--ddp`) |
| `OMP_NUM_THREADS`, `MKL_NUM_THREADS`, `TORCH_NUM_THREADS` | `api.hardware_info` (reported only) | recorded in determinism reports and `/x/v1/run` |
| `NO_COLOR` | `harness/hud.py` | disables HUD colours |

Routes, response shapes and error statuses: see "HTTP API reference" under How it works 1.

### Encoder, packing, engine (`engine/encoder/*`, `engine/registry.py`)

| name | type | value | defined in | effect |
|---|---|---|---|---|
| `BASE_MODEL` | str | `jhu-clsp/ettin-encoder-32m` | `model.py` | default backbone: d 384, 10 layers, global attention at layers 0/3/6/9, sliding window 64 (per the v0.1 `meta.json`; layer types and window are read from the HF config at load time) |
| `MARKERS` | tuple | `[Q] [O] [L] [T] [F]` | `tokenize_pack.py` | special tokens |
| `BUCKETS` | tuple | 256, 384, 512, 768, 1024, 1536, 2048 | `tokenize_pack.py` | padded lengths (MPS shape stability); beyond: round up to 64 |
| `MAX_LEN` | int | 2048 | `tokenize_pack.py` | `Packer` default; `meta.json` fallback |
| `ITEM_CHUNK` | int | 64 | `tokenize_pack.py` | item tokens per tree chunk |
| `Packer.cache_size` | int | 8192 | `tokenize_pack.py` | token cache entries (cleared when full) |
| `ENGINE_NAME` | str | `jev-local-fast-0.1.0` | `engine.py` | response `model` / engine id |
| `MAX_POSITIONS` | int | 8192 | `engine.py` | hard cap on `max_tokens` |
| `ENGINE_BUCKETS` | tuple | `BUCKETS` + 3072, 4096, 6144, 8192, 12288, 16384 | `engine.py` | flat tree lengths |
| `MARKER_SEEDS` | dict | `" question"`, `" option"`, `" level"`, `" true"`, `" false"` | `engine.py` | marker embedding init |
| `FastEngine(...)` defaults | ctor | `device="mps"` (falls back to cpu), `dtype=float16` (forced to fp32 on CPU), `max_tokens=None` (-> `meta.max_len`, else 2048, ≤ 8192), `attn="tree"`, `max_flat_tokens=None` (-> `max(max_tokens, 8192)`; dense: `max_tokens`), `encoder="banded"`, `calibration=None`, `drop_header_calibration=False`, `threads=None` | `engine.py` | |
| `FastEngine.warmup` lengths | tuple | 256, 512, 768, 1024, 1536 | `engine.py` | MPS kernel warm-up |
| `fit_state` | kwargs | `margin=8`, `min_keep=16`, `max_rounds=12` | `engine.py` | truncate mode |
| `JEV_ENCODER` | env | `reference` / `banded` | `engine.py` -> `encoder_class` | overrides encoder choice |
| default `encoder` | str | `"reference"` for `encoder_class`, `init_model`, `load_checkpoint`; `"banded"` for `FastEngine`, `train --encoder`, eval | `engine.py`, `train.py` | exports use `load_checkpoint(..., encoder="reference")` |
| `MAX_CHOICE_OPTIONS` | int | 255 | `engine.py` | `FastEngine.supports` is False above it (independent of `validate.py`'s identical cap) |
| `write_checkpoint` meta defaults | dict | `name=ENGINE_NAME`, `base=BASE_MODEL`, `markers`, `max_len=MAX_LEN` (2048), `buckets=BUCKETS`, `hidden_size`, `written_at`; trainer `meta=` overrides | `engine.py` | `FastEngine.max_tokens` comes from `max_len` |
| `JEV_LOCAL_FAST_CKPT` | env | path | `registry.py` | fast checkpoint dir (default `<repo>/models/jev-local-fast`) |
| `DEFAULT_GENERAL_REPO` | str | `mlx-community/Qwen3-1.7B-4bit` | `registry.py` | never downloaded by the registry |

### Calibration (`engine/encoder/calibrate.py`)

| name | value | effect |
|---|---|---|
| `DEFAULT_CALIBRATION` | `{"noul":1.0,"choice":1.0,"score":1.0,"by_header":{}}` | base of every loaded file |
| `TAU_MIN, TAU_MAX` | 0.05, 20.0 | per-kind / per-header fit range |
| `BUCKET_CLAMP` | (0.5, 5.0) | bucket τ and τ(K) clamp |
| `K_BUCKETS` | (2,2) (3,5) (6,10) (11,30) (31,100) (101,255) | K-buckets |
| `min_per_header`, `min_per_bucket` | 50, 50 | samples needed to fit a header / bucket / Platt |
| `fit_tau_k` | needs ≥ 20 records and ≥ 2 distinct K; subsample 20,000 (seed 0) | τ(K) fit |
| `fit_platt` | Newton, 50 iters; `a` clamped to [0.2, 2.0], `b` to [−5, 5] | noul Platt |
| `fit_tau` | golden-section on log β = log(1/τ), 60 iterations, range `[TAU_MIN, TAU_MAX]` (or the bucket clamp) | per-kind / header / bucket τ |
| `tau_k` lookup | τ = clamp(a + b·ln(max(K, 2)), `calib["bucket_clamp"]` or `BUCKET_CLAMP`) | `tau_for` |
| `k_bucket(K)` for K > 255 | `"101-255"` | the last bucket absorbs everything above |
| rounding of fitted values | 4 dp | every τ, `tau_k` pair and Platt `(a, b)` in the written file |

Calibrate CLI (`calibrate.main`): `--ckpt` (required), `--data`, `--extra`, `--stream ROOTS`, `--stream-cache runs/stream_cache`, `--split dev`, `--limit`, `--batch 8`, `--device`, `--max-len`, `--min-per-header 50`, `--min-per-bucket 50`, `--bucket-clamp 0.5,5.0`, `--no-platt`, `--no-buckets` (v1 file). It writes `<ckpt>/calibration.json` and prints ECE before/after per kind and per K-bucket.

### Decoder and heuristic (legacy)

| name | value | defined in |
|---|---|---|
| `MAX_TOKENS` (GeneralEngine) | 8192 (prefix + all branches, and prefix + longest branch) | `mlx_scorer.py` |
| `PAGE_SIZE`, `MAX_FINALISTS_PER_PAGE`, `PREFILL_CHUNK`, `CACHE_LIMIT_MB` | 25, 3, 512, 256 | `mlx_scorer.py` |
| `GeneralEngine` ctor | `order_samples=1`, `batch_tokens=1024`, `max_batch=8`, temperatures 1.0, `allow_download=False` | `mlx_scorer.py` |
| `HeuristicEngine.max_tokens` | 65536 | `heuristic.py` |
| `CHOICE_TEMP`, `SCORE_TEMP`, `NONE_BASELINE`, `FUZZY_CUTOFF`, `STEM_LEN`, `NOUL_SLOPE` | 0.6, 0.6, 0.45, 80.0, 5, 8.0 | `heuristic.py` |

### Training (`train/train.py`, `train/losses.py`, `train/stream.py`)

| name | value | effect |
|---|---|---|
| CLI defaults | `--data data/cu`, `--out models/jev-local-fast`, `--runs-dir runs` (`--run-name` defaults to the basename of `--out`), `--base jhu-clsp/ettin-encoder-32m`, `--batch 4`, `--grad-accum 4`, `--max-len 1536` (≤ `MAX_TRAIN_LEN` 8192), `--lr 5e-5`, `--head-lr 1e-3`, `--weight-decay 0.01`, `--warmup 0.03`, `--clip 1.0`, `--log-every 20`, `--ckpt-every 500`, `--empty-cache-every 200`, `--seed 0`, `--encoder banded`, `--attn tree`, `--grad-ckpt` on, `--loss v1`, `--prefetch` 2 (stream) / 0 (index), `--calibrate-lengths 64`, `--index-workers 4`, `--ddp-timeout 1800`, `--stop-check lagged` | `build_parser` |
| other trainer flags | `--init-from PATH` (weights only, fresh optimizer/schedule; servable ckpt or trainer state dir, `load_weights`), `--init-only`, `--resume`, `--epochs`, `--max-steps`, `--limit`, `--device` (free text: mps / cpu / cuda; default mps when available), `--amp`, `--threads`; loss overrides `--smoothing`, `--brier`, `--rps`, `--kl/--no-kl`, `--spherical`, `--coral`, `--noise-sigma start,end`, `--noise-samples`, `--noise-weight`, `--consistency`; stream group `--stream ROOTS`, `--stream-cache runs/stream_cache`, `--mixture JSON`, `--batch-tokens`, `--batch-rows`, `--source-cap`, `--class-cap`, `--alpha`, `--passes`, `--pool`, `--batch-layout {tree,dense}`, `--balance/--no-balance`, `--curriculum 'p:max,...'`, `--license`, `--buckets`, `--splits`; DDP group `--ddp`, `--ddp-compress bf16`, `--stop-check {lagged,micro}`, `--timing-log`; hidden `--stop-at K` (tests) | `build_parser`, `loss_config`, `build_stream` |
| `LONG_BUCKETS` | 3072, 4096, 6144, 8192 | `train_buckets` |
| `LossConfig()` (v1) | smoothing 0.02, rps 0.25 (score), brier 0, kl False, spherical 0, coral 0, noise off, consistency 0 | `losses.py` |
| `LossConfig.v2()` | smoothing 0.02, rps 1.0, kl True, spherical 0.5, coral 0.25, consistency 0.1 | `losses.py` |
| `MixConfig()` | `seed=0`, `splits=("train",)`, `licenses=None`, `buckets=None`, `bucket_weights=DEFAULT_BUCKET_WEIGHTS`, `weight_unit="tokens"`, `alpha=0.5`, `source_cap=None`, `class_cap=None`, `max_repeat=2.0` (each of the three also accepts a per-bucket dict with a `"*"` default, read by `caps` / `repeat`), `pass_tokens=None` (one capped epoch), `passes=1.0`, `pool=4096`, `batch_tokens=16384`, `layout="tree"`, `batch_rows=None`, `max_len=8192`, `curriculum=()`, `balance=False` | `stream.py` |
| `DEFAULT_BUCKET_WEIGHTS` | `b1_tasksource_jev` 0.36, `b2_label_semantics` 0.10, `b3_nli` 0.05, `b4_procedural` 0.08, `b5_open_jev` 0.04, `b6_synthetic` 0.14, `b7_laurer` 0.06, `b8_extractive` 0.04, `b9_cu` 0.12, `s0_families` 0.14; any other bucket `OTHER_BUCKET_WEIGHT` 0.04 (renormalised over buckets present) | `stream.py` |
| `SPLITS`, `LICENSES` | `("train", "dev_mix", "dev_family", "dev", "test")`, `("commercial", "research", "unknown")` | `stream.py` |
| AdamW | betas (0.9, 0.98), eps 1e-6; groups: decayed backbone, no-decay backbone (ndim < 2, `norm`, `embeddings`), heads at `--head-lr` with no decay | `train.py` -> `param_groups` |
| `lr_factor` | linear warmup over `max(1, round(total·warmup))` steps, then cosine to `floor` (0.0) | `train.py` |
| `amp_dtype` | MPS fp16; CPU bf16; CUDA bf16 if supported else `None` (no autocast) | `train.py` |
| `DEFAULT_TOKENS_PER_BYTE`, `INDEX_VERSION` | 0.27, 2 | `stream.py` |
| `N_BINS` | 15 | `train/eval.py` (ECE) |

### Harness (legacy, `harness/types.py` -> `Thresholds`, `controller.py`, `safety.py`)

`Thresholds`: `is_command` 0.5, `intent_conf` 0.45, `intent_top_p` 0.55, `complete` 0.65, `stable_complete` 0.85, `target_conf` 0.45, `target_top_p` 0.35, `span_top_p` 0.35, `app_top_p` 0.50, `key_top_p` 0.60, `folder_top_p` 0.50, `destructive` 0.5, `high_risk_intent_p` 0.85, `high_risk_target_p` 0.75, `confirm_p` 0.8, `silence_complete_ms` 900, `payload_silence_ms` 600, `debounce_ms` 120, `confirm_timeout_ms` 8000. `HarnessConfig`: `dry_run=True`, `backend="inproc"`, `base_url="http://127.0.0.1:8765"`, `model="jev-local"`, `search_url="https://www.google.com/search?q={q}"`, `allow_apps=()`, `max_elements=60`, `max_apps=24`, `log_redact=True`, `thresholds=Thresholds()`. Controller: `MAX_LOOPS` 4, `MAX_DEBOUNCE_MS` 300, `SILENCE_MARGIN_MS` 15, `RATE_MAX, RATE_WINDOW_S` = 3, 1.0, `UNDO_DEPTH` 20, `DEFAULT_APPS` (18 names, deny-listed apps included on purpose); `silence_gates_for(cadence)` = (2·cadence + 150, max(that, 900)). Safety: `CONFIRM_REACTION_S` 0.8. Policy: `CANCEL_TOP_P` 0.5. `DecisionClient` timeout 1.2 s; hosted base URL `https://api.typesafe.ai`. Whisper (`whisper_source.py`): models in `~/.jev-local/models/whisper` (default `base.en`), `DEFAULT_STEP_MS` 500, `DEFAULT_LENGTH_MS` 8000, `DEFAULT_KEEP_MS` 200, `SAMPLE_RATE` 16000; binaries `whisper-stream` / `whisper-cli` from `PATH` else `/opt/homebrew/bin`. Question ids sent every update (`questions.py`): `intent`, `complete`, `is_command`, `destructive`, `target` (only with a snapshot), `app`, `key`, `folder`, `text_span` / `url_span` (only with candidates), `scroll_amount`; state keys (`state.build_state`): `screen`, `focused`, `recent_actions` (last 3), `pending`, `transcript`.

## Invariants and gotchas

- **Text parity is the contract with the runtime.** The trained weights only work on text produced exactly as `serialize.py` + `Packer` produce it. Any change to `entry_text`, `state_segments`, default instructions, item rendering (`"label: desc"` vs bare label), `[SEP]`/`[CLS]` placement, marker set or order, or position numbering silently degrades every existing model and breaks `packages/runtime/test/model/*` parity.
- **Python number rendering leaks into the text.** `str(25.0)` is `"25.0"` but JS can only produce `25`; rows with integral floats train on text the runtime never sends (`training/NEEDS.md` item 8). The curriculum generator now normalises them (`training/curriculum/fmt.py` -> `js_numbers`); any new row producer (teacher labelling keeps the input `state` untouched; SIM and REAL emit JSON from JS) must do the same. Booleans render `True`/`False`, `None` as `""` in dicts.
- **Isolation is exact, not approximate.** Option order and unrelated questions cannot change an answer (tests: `test_encoder_engine.py` -> `test_permuting_options_is_exact`, `test_unrelated_question_is_exact`). Do not add cross-question or cross-option attention; it would break this and the multi-pass equivalence.
- **`max_tokens` is a positions budget.** It bounds state + header + longest item; the whole request may be far longer (multi-pass). The router compares `positions_needed`, not `count_tokens`. The TS port has **no** multi-pass and also enforces a total (`maxTotal`), so the runtime must keep situations inside its budgets.
- **Three different length checks.** `Packer.pack` (used by `scripts/genclass_export.py` and `training/export_runtime.py` to build parity fixtures) bounds the **total** sequence by `max_len` (`EngineError` 400 `{"detail": "max_tokens_exceeded", "tokens", "max_tokens"}`); `FastEngine` bounds **positions** via `plan_passes` and splits the rest into passes; `FastEngine.count_tokens` (= `Packer.count`) is the total and is what `usage.input_tokens` reports, while routing uses `positions_needed`. The TS packer checks both positions (`maxPositions`) and total (`maxTotal`). Both exporters build fixtures with `Packer(tok, max_len=8192)`, so fixture totals stay ≤ 8192 (= TS `maxTotal` default), but `Packer.pack` does not bound positions; `training/export_runtime.py` -> `requests_from_rows` only samples data rows whose total is ≤ 1500 tokens, which keeps them under `maxPositions` 1536. Requests passed with `--requests` get no such filter.
- **Packer token cache** is cleared wholesale when `cache_size` (8192) would be exceeded, and the current call's texts are then re-encoded; `test_encoder_pack.py` -> `test_encode_cache_eviction_keeps_this_calls_hits` pins that fix.
- **Joint softmax over fragments.** Calibration must see all K logits of a question at once (bucket by the full K). Never calibrate per fragment.
- **`by_header` keys are sha1 of the rendered header** (`header_key(question_block(...).header)`), i.e. of the instructions text or the default instruction, not of the qid. Renaming or rewording standing-question instructions silently drops their per-header temperature.
- **`heads.probabilities` is v1-only** (per kind + by_header, torch). `FastEngine` uses `calibrate.calibrate_logits` (numpy, float64, v2 keys). `calibrate.calibrated_probs` is the v2 torch equivalent.
- **Answer math.** `choice` is the argmax of unrounded probabilities with ties to the first label; confidence is computed before rounding; `round` precision can make Σp ≠ 1 for many options (use `lr` or `exact` when sums are checked).
- **Marker forgery is blocked** only because `Packer.__init__` sets `tok.backend_tokenizer.encode_special_tokens = True` (this mutates the shared tokenizer object). The TS tokenizer must keep "special tokens are never matched in text".
- **Checkpoints are written atomically** (sibling `.tmp-<pid>` then swap); `write_checkpoint` stores fp32 on CPU. `meta.json["max_len"]` becomes `FastEngine.max_tokens`; an `--init-only` checkpoint has `max_len` 2048.
- **Engines are not thread-safe.** The server serialises evaluations (asyncio gate + lock); `DecisionClient` inproc uses a lock.
- **`BandedEncoder` == `MaskedEncoder.forward_tree` == dense mask** in float64 (outputs and gradients), pinned by `test_train_v2_banded.py` and `test_encoder_model.py`. Change all three together or not at all.
- **Padding rows must stay finite**: padding queries attend to themselves / key 0 (`build_masks`, `_only_first_key`); a NaN would leak into real rows through 0·NaN in backward.
- **Determinism.** Same request bytes -> same response bytes is measured (not enforced) by `api.determinism_report` (W11; asserted in `test_bm_engine.py` and `test_bm_engine_vm.py`). Training data order is a pure function of seed, pass and cursor (`stream._rng`); DDP replicas stay bit-identical through identical reduced gradients.
- **Never download.** `load_tokenizer` / `init_model` use `local_files_only` for bare repo ids; the registry never fetches the decoder; `GeneralEngine` returns 503 when weights are absent.
- **Mac safety** (`docs/CONTRACT-v2.md`): on the 8 GB M1 run only pure-Python tests; torch, models, datasets, training and benchmarks run on Azure VMs. The executor defaults to dry-run; live actions only by the user.
- **`pyproject.toml` lists pyobjc unconditionally** and lacks `zstandard`, `onnx`, `onnxruntime`; installing on Linux VMs may need manual handling (unverified).
- **Which `jev_local` the VMs run.** `training/node.sh sync` rsyncs `${HERE}/../..` + `/jev_local`, `/scripts`, `/pyproject.toml` (comment: "parent repo with jev_local") to `~/jev/` on the node, and commands run with `PYTHONPATH=~/jev:~/gcl-train/training`. Edits to this repo's `jev_local/` reach the cluster only if that parent copy is the same tree; check before assuming a Python change is live in training.
- **This tree's `jev_local` is behind the one the cluster runs.** The parent repo copy has the optional gain head (`DecisionHeads(gain_head=...)`, `add_gain_head()`, `HeadOut.gain`, trainer `--gain-loss`, `load_checkpoint` building the head when a checkpoint has `gain_mlp.*`) per `training/LOG.md` (03:00–03:12 entry); none of it is here. A checkpoint with `gain_mlp.*` keys cannot be loaded through this tree: `engine.load_checkpoint` calls `heads.load_state_dict(...)` with the default `strict=True`, so the unexpected keys raise; and `training/collect_gain.py` reads `o.gain`, which raises `AttributeError` on this tree's `HeadOut`. If you port the gain head, keep it default-off so `heads.safetensors` keys and the ONNX export stay unchanged.
- **Situation format is frozen, the text contract is not the format.** `situation-v2` changes what the runtime puts in `state` and `questions` (e.g. the new `delivery` trigger whose actions are `deliver` / `discard` / `defer`), not how `serialize.py` / `Packer` turn them into tokens. A v1 checkpoint therefore loads and runs on v2 situations without error but was never trained on them; do not treat R17-final1 numbers as v2 numbers.
- **Collection errors abort pytest.** The 20 `tests/test_data_*.py` files import the absent `jev_local.data`; a plain `pytest tests` stops at collection. Ignore them (see Tests).

## How to change it safely

1. **Change serialization, packing, markers or position rules** (affects every model):
   - Edit `jev_local/serialize.py` / `engine/encoder/tokenize_pack.py` **and** `packages/runtime/src/model/{serialize,packer,pyutil,tokenizer}.ts` in the same change.
   - Regenerate `py_fixtures.json` (`packages/runtime/test/fixtures/model/make_py_fixtures.py`, on a VM with the jev venv) and re-export a model so `pack_fixtures.json` / `torch_fixtures.json` / `parity.json` reflect the new layout; retrain (the change invalidates trained weights).
   - Run `tests/test_encoder_pack.py`, `test_encoder_model.py`, `test_encoder_engine.py`, `test_train_v2_banded.py`, `test_train_v2_engine.py`, `test_serialize_w8.py`, and `packages/runtime/test/model/*.test.ts`. Coordinate with MODEL and TRAIN (see [model-io-contract.md](model-io-contract.md)).
2. **Change calibration lookup or file format**: edit `calibrate.tau_for` / `noul_affine` / `calibrate_logits` and `calibrate.ts` together; keep v1 files loadable (`test_train_v2_engine.py` checks backward compatibility); update the calibrate section of `packages/runtime/test/fixtures/model/make_py_fixtures.py`; run `test_encoder_heads.py`, `test_train_v2_engine.py`, `test_bm_engine.py` (`test_load_calibration_replaces_and_describes`), TS `calibrate.test.ts`.
3. **Change answer math** (`confidence.py`): keep the documented Jev rows within ±0.01 (`test_confidence.py`), keep W1 ties and precision modes (`test_bm_engine.py`); mirror in `calibrate.ts` `buildAnswer` if the runtime should follow.
4. **Add a server option / preset**: add a `ServeConfig` field with validation in `__post_init__`, add it to `PRESETS` if needed, wire a flag in `server/app.py` -> `build_parser` / `config_from_args`; never decide from request content. Tests: `test_bm_engine.py`, `test_server.py`.
5. **Change training losses**: add a `LossConfig` field defaulting to off so the v1 path stays bit-identical (`test_train_v2_losses.py` -> `test_v1_default_is_bit_identical`); expose a CLI flag in `build_parser` and `loss_config`. Every new term must be a proper scoring rule (zero gradient at p = t).
6. **Change the mixture / data reader**: `stream.py` is numpy-only; keep determinism and world-size-independent cursors (`test_train_v2_stream.py`). Bump `INDEX_VERSION` if the per-row index layout changes (old caches are rebuilt by manifest key).
7. **Change harness vocabularies** (`harness/catalog.py`, `questions.py` instructions): these strings are model input, so a change requires regenerating data and retraining the computer-use model; run `test_policy.py`, `test_safety.py`, `test_controller.py`, `test_heuristic.py`. The extension's JS core mirrors these modules, so its parity fixtures (`extension/scripts/make_py_fixtures.py`) change too (see [extension-and-benchmarks.md](extension-and-benchmarks.md)).
8. **Ship a `jev_local` change to training runs**: `training/` imports `jev_local` from `~/jev` on the VMs (`training/node.sh sync` source is `$HERE/../..`, see Invariants); make sure the copy that gets synced contains your change (and that it is based on the parent copy with the gain head, or you would drop it on the cluster), then re-run `training/tests/` on a VM (see [training.md](training.md)). Keep trainer flags that the `training/` launchers and `scripts/launch_run.sh` pass (`--ddp`, `--threads`, `--run-name`, `--stream`, `--stream-cache`, `--mixture`, `--runs-dir`, `--max-len`, `--batch-tokens`, `--balance`, `--amp`, `--no-grad-ckpt`, `--device`, `--base`, `--init-from`, `--out`, `--lr`, `--head-lr`, `--grad-accum`, `--resume`, ...) backward compatible; note `scripts/launch_run.sh` also exports `JEV_ENCODER=banded`.
9. **Port the gain head into this tree** (if asked): copy the parent repo's additive change (heads, `HeadOut.gain`, `load_checkpoint`, trainer `--gain-loss`, `load_weights` tolerance), keep it off by default so v1 runs stay bit-identical (`test_train_v2_losses.py` -> `test_v1_default_is_bit_identical`), and keep it out of the ONNX export unless the runtime gains a consumer for it; the TS model host has no gain output.
10. **Add a Python test**: put it in `tests/test_<module>.py`; mark `@pytest.mark.model` (needs downloaded weights), `@pytest.mark.slow` (> 10 s), `@pytest.mark.macos` (AX/AppKit; auto-skipped off macOS by `tests/conftest.py`).

## Tests

How to run (from the repo root, inside the jev venv; per [`docs/CONTRACT-v2.md`](../CONTRACT-v2.md) torch/model tests run on the VM):

```sh
.venv/bin/pip install -e ".[dev]"                     # once (pyobjc deps: see gotchas)
.venv/bin/python -m pytest -q tests --ignore-glob='tests/test_data_*.py' -m "not model and not slow"   # pure-ish
.venv/bin/python -m pytest -q tests --ignore-glob='tests/test_data_*.py'                               # VM: everything else
JEV_LOCAL_FAST_CKPT=~/jev/models/jev-local-fast-v2 .venv/bin/python -m pytest -q tests/test_bm_engine_vm.py
```

`model` tests need `jhu-clsp/ettin-encoder-32m` in the Hugging Face cache (encoder/train tests) or `mlx-community/Qwen3-1.7B-4bit` (decoder); `test_server.py` / `test_sdk_roundtrip.py` skip without the `dev` extra; `test_train_v2.py` needs `zstandard` and spawns 2 local gloo ranks. `test_encoder_heads.py`, `test_train_v2_losses.py` and `test_train_v2_engine.py` (its first three tests are unmarked) import torch at module level without a file-wide `model` marker, so `-m "not model"` is not torch-free; on the Mac, select files explicitly. Instead of `--ignore-glob`, `--continue-on-collection-errors` also works. `training/tests/` is not under `testpaths` (see [training.md](training.md)).

| test file | area | needs | what it asserts |
|---|---|---|---|
| `test_confidence.py` | answer math | pure | documented Jev confidence rows within ±0.01; mode vs median; MAD; normalise; label reordering, ties, legend echo, noul clip without range clamp |
| `test_validate.py` | limits | pure | 2..255 options, 2..10 levels, empty score = 422, nouls unlimited |
| `test_api.py` | routing | pure | auto prefers fast, falls back; explicit ids; 404/400/503; too-long normalisation; auto retry after an engine under-estimate; output_tokens |
| `test_bm_engine.py` | benchmax W1–W11 | pure | largest-remainder, presets, public ids, refusal wording/status, length-before-supports, multi-pass via `positions_needed`, truncate mode + headers/counters, label alias, 255 options over HTTP, determinism report, calibration replace, CLI print-config, no torch import |
| `test_bm_engine_vm.py` | benchmax on real ckpt | torch + ckpt, VM only (skips on darwin) | 8k states, 255 long options in exact passes, refuse vs truncate on 12k state, calibration by run config, byte determinism and order invariance |
| `test_server.py` | HTTP | dev extra | official examples' shape vs SDK models + jsonschema, request ids, extra fields, models/healthz/openapi, 422/400/404, auth + env key, Host check, engine header, 529 + no overlap, 500 with request id, latency header |
| `test_sdk_roundtrip.py` | client compat | dev extra, live uvicorn | `typesafe-sdk` sync/async round trips, errors, auth, base URL |
| `test_registry.py` | registry | pure | lazy build, missing/erroring engines non-fatal, env override, general cached/lazy/eager, warm, importing does not import torch/mlx |
| `test_heuristic.py` | heuristic | pure | protocol, determinism, min < 5 ms (median < 15 ms) on a 61-option target request, sane harness answers, permutation invariance, backticked path |
| `test_serialize_w8.py` | serialization | pure | `null`, `""`, desc == label render identically |
| `test_encoder_pack.py` | packing | `model` (tokenizer) | markers added once, layout/positions/groups, marker forgery blocked, max tokens, `pack_split`, buckets, mask rules, cache-eviction regression |
| `test_encoder_model.py` | masked forward | `model` | config matches contract, all-attend == HF forward, tree == dense, padding/batching invariance, tree backward + grad checkpoint |
| `test_encoder_heads.py` | heads/losses/calib/eval | torch | plan shapes, temperatures, permutation equivariance, losses decrease, RPS ordinal, `parse_target`, batching, LR schedule, τ fits, ECE/AUROC |
| `test_encoder_engine.py` | FastEngine | `model` (+ MPS and `slow` for one test) | protocol + checkpoint round trip, exact option-permutation and unrelated-question invariance, tree == dense engine, max tokens, >255 unsupported, calibration, api end to end, MPS fp16 ≈ CPU fp32 |
| `test_train_v2_engine.py` | FastEngine v2 | torch import; K-bucket/fit/clamp tests unmarked (numpy), the rest `model` | K-buckets, bucket/Platt fit recovery, clamp, multi-pass == single pass, 255 ok / 256 not, states to 8192, `evaluate_logits`, calibrate CLI writes v2 file |
| `test_train_v2_banded.py` | BandedEncoder | `model` | hidden states and gradients equal the reference (padding, many option chunks, long states, checkpointing) |
| `test_train.py` | trainer v1 | `model`, `slow` | 20-step smoke loss decreases, servable ckpt, resume == uninterrupted, init-only, eval + calibrate CLI |
| `test_train_v2.py` | trainer v2 | `model`, `slow`, zstandard | stream smoke with v2 losses, resume, token budget + `--init-from`, DDP == single-process accumulation, SIGTERM on all ranks + resume |
| `test_train_v2_losses.py` | losses | torch | v1 default bit-identical, KL/spherical/CORAL proper, noise schedule, consistency pairs, NaN-free padding |
| `test_train_v2_stream.py` | mixture | numpy | index + cache, filters, bucket shares + sqrt sampling, caps/repeat water-fill, determinism, token budgets, DDP sharding/resume, cycling, curriculum, cost balancing |
| `test_mlx_scorer.py` | decoder | pure helpers; mlx for mechanics; `model`+`slow` for Qwen3 | prompt text, pagination math, neutralizer, forked-prefix == full forward, batching, prefix reuse, no writes to shared cache, doc example -> billing |
| `test_stream.py`, `test_policy.py`, `test_safety.py`, `test_controller.py`, `test_client.py`, `test_log.py`, `test_replay.py`, `test_fakes.py`, `test_hud.py` | harness core | pure (`test_replay.py` has a `slow` test) | consumed-prefix/dedup, gate order, red-team list never executes unconfirmed, mid-sentence replays (42 controller tests), client backends (hosted needs an explicit key), redaction, virtual-time replay == real-time replay |
| `test_execute.py` | macOS execution | pure (fake UI; one `slow` test) | key map covers every catalog key, URL builder accepts/refuses, dry-run is the default and never touches the UI, live-path fallbacks (AXPress, keystrokes), secure-field and deny-list refusals, undo |
| `test_observe.py`, `test_apps.py` | macOS observation | pure helpers + `macos` live tests | role humanising, ranking, permission/locked-screen handling; read-only live Finder / frontmost snapshots; app index scan |
| `test_whisper_source.py`, `test_demo.py`, `test_demo_midsentence.py`, `test_demo_safety_review.py` | voice demo | pure (`test_demo.py` has `macos` tests, e.g. the kill switch) | whisper parser/tracker over a fake binary, demo args/memory guards, adversarial mid-sentence and safety reviews (docstrings say written to fail before fixes; current pass status unverified) |
| `test_overnight.py`, `test_bench_*.py`, `test_bm_adapters_*.py`, `test_bm_integrate.py` | scripts / benchmarks | pure, except `test_bench_ours.py` (`model`, skips on darwin and without a checkpoint) | out of scope: see [extension-and-benchmarks.md](extension-and-benchmarks.md) |
| `test_data_*.py` (20 files) | data generators | `jev_local.data` | **cannot run in this repo**: the package is not in it |

TypeScript side of the parity contract (`packages/runtime/test/model/{serialize,packer,calibrate,engine}.test.ts`): run in the normal `vitest` unit run and in CI (`.github/workflows/ci.yml`); the sections that compare against the committed `py_fixtures.json` (serialize, calibration and answer math vs Python) always run; the sections that need a model directory (`GENCLASS_MODEL_DIR`, default `<repo>/.cache-model`, see `packages/runtime/test/model/helpers.ts` -> `MODEL_DIR`) use `describe.skipIf` / `it.skipIf` and skip when it is absent. Those are exactly the 14 skipped tests on `mvp-v2`: 10 in `packer.test.ts` (tokenizer + packer vs the parity requests, HF tokenizer edge cases, tokenizer performance), 3 in `engine.test.ts` (q8/fp16 on onnxruntime-node, q8 on onnxruntime-web WASM) and 1 in `calibrate.test.ts` (calibration vs PyTorch). Checked on 2026-10-08: `npx vitest run test/model` in `packages/runtime` -> 48 passed, 14 skipped; the lead's full unit run: 332 passed, 14 skipped, plus `review-perf` 4 passed. No model directory can be fetched today: `@genclass/runtime-model` is not published and `DEFAULT_MODEL_BASE_URL` returns 404. The Python tests above are not run by CI.

Fixtures: `tests/fixtures/official_examples.json` (Jev doc examples, server + SDK tests), `tests/fixtures/harness_cases.json` (decoder cases, `test_mlx_scorer.py`). `tests/conftest.py` only skips `macos` tests off macOS; there are no shared fixtures.

## Drift and open issues

Code wins in every row.

| # | doc says | code does |
|---|---|---|
| 1 | `docs/CONTRACT.md` H: subcommands `serve`, `run`, `replay`, `doctor`, `bench`, `data`, `train`, `eval`, `calibrate`, `snapshot` | `jev_local/cli.py` -> `main` has only `demo` and `serve [--port]` |
| 2 | `docs/CONTRACT.md` G, `docs/SPEC.md` §4.1–4.2: Swift `helpers/JevHear` + `harness/stt_client.py` (SpeechAnalyzer over a Unix socket) | no `helpers/`, no `stt_client.py`; speech comes from whisper.cpp via `harness/whisper_source.py` |
| 3 | `docs/CONTRACT.md` D, `docs/SPEC.md` §6.1, `docs/GENCLASS.md` ("data pipelines ... `jev_local/data/`"), `train/stream.py` docstring (`jev_local.data.v2.render`) | `jev_local/data/` absent: root `.gitignore` `data/` matches it; 20 `tests/test_data_*.py` fail to import |
| 4 | `docs/SPEC.md` §3.3: segment-causal state attention, segment KV cache (`engine/encoder/cache.py`), span head, `<s:...>` segment tags, buckets 256/512/768/1024/2048 (§6.2 `pack` signature: up to 4096), packed ≤ 4096 (v0) / 8192 | full bidirectional state attention, no cache, no span head, `"key: text" [SEP]` segments, `BUCKETS` to 2048 (`ENGINE_BUCKETS` to 16384), positions ≤ `meta.max_len` (fallback 2048, cap 8192) with multi-pass |
| 5 | `docs/SPEC.md` §3.3 noul head `[h_Q; h_T; h_F]` | 5-way `[h_Q; h_T; h_F; h_Q*h_T; h_Q*h_F]` (matches CONTRACT B); plus a shared `LayerNorm` on gathered states (in neither doc) |
| 6 | `docs/SPEC.md` §3.4 / CONTRACT C: noul tokens `" Yes"`/`" No"`, suffix ends `Answer:` | single tokens `"Yes"`/`"No"`; ChatML assistant header with empty `<think>` block, `CHOICE_ASK`/`SCORE_ASK`/`NOUL_ASK` lines |
| 7 | `docs/CONTRACT.md` A: every count limit is a 400 | empty score criteria -> 422 (FastAPI shape); option cap status 400/413/422 and wording per `ServeConfig` |
| 8 | `docs/CONTRACT.md` B training losses: CE + smoothing 0.02, optional Brier | v1 default also adds RPS 0.25 on score; `--loss v2` = KL + 0.5 spherical + 1.0 RPS + 0.25 CORAL + 0.1 consistency |
| 9 | `docs/SPEC.md` §4.3–4.4 thresholds (`intent_conf` 0.60, `app_conf` 0.60, `key_conf` 0.70, `correction`, `ends_dictation`), intents `switch_app`, `click_element`, `menu_item`, `WAIT`, dictation mode | `Thresholds` as in Constants; 18 `catalog.INTENTS` (`click`, `wait`, no `switch_app`/`menu_item`); no dictation, `is_correction` or `ends_dictation` |
| 10 | `docs/SPEC.md` §5.1: `POST /x/v1/spans`, release date 2026-10-01; §5.2: too-long message "7,680 tokens" | no spans route; `GET /x/v1/run`; `RELEASE_DATE` 2026-09-24; message from `api.too_long_message` |
| 11 | code docstrings cite `docs/research/SPEC.md`, `docs/research/benchmax/...`, `docs/build/stage1-speed.md` (and `jev_local/bench/` cites `docs/research/v2/PLAN.md`); `docs/CONTRACT.md` and `docs/CONTRACT-v2.md` also point at `docs/research/...` | in this repo: `docs/SPEC.md`, `docs/benchmax-research/*`; `docs/research/` and `docs/build/` do not exist |
| 12 | `api.py` module docstring, `server/app.py` `--model-id` help and `PUBLIC_DESCRIPTION`: `meharsjev-<size>` | `PUBLIC_PREFIX = "genclass-"`; `meharsjev-*` still accepted |
| 13 | `docs/runtime/CONTRACT.md` §10: port of `extension/genclass/src/core/...` in the parent jev repo | in this repo the JS core is `extension/src/core/` |
| 14 | `docs/DEMO.md`, `docs/CONTRACT.md`: project at `/Users/meharkhanna/jev`; `models/`, `runs/`, `data/` present | this repo has `jev_local` at the root and none of those (gitignored) |
| 15 | `docs/SPEC.md` §6.2 signatures (`Packed.attn_mask`, `FastEngine.spans`, `Controller(speech, ..., T, safety)`), `docs/CONTRACT.md` `Registry(...)`, `build_answer(q, d, round_digits)` | code signatures differ (additive `load_fast`, `fast_options`, `center`, `precision`; no `spans`) |
| 16 | `docs/CONTRACT.md` A heuristic nouls "default to 0.5" | 0.5 only when instructions have no content words; 0.4 when cues are not found |
| 17 | `test_demo_midsentence.py` docstring: every test "FAILS on the reviewed code"; `test_demo_safety_review.py` docstring: tests "are expected to FAIL until the corresponding issue is fixed" | the fixes they name appear in code (`silence_gates_for`, terminal/code-editor deny lists, `joined` confirmation rule); pass status (unverified) |
| 18 | `tests/conftest.py` docstring: the full suite (`pytest -q tests`) is runnable on the Linux VMs | in this repo the 20 `test_data_*.py` files fail at collection (no `jev_local/data`), so a plain `pytest -q tests` errors out; use `--ignore-glob` (see Tests) |
| 19 | `training/node.sh` / `training/README.md`: `jev_local/` comes from the parent jev repo at `$HERE/../..` | in this repo `jev_local/` sits at the repo root (`$HERE/..`); `node.sh sync` would copy `<parent of repo>/jev_local`, not this tree |
| 20 | `engine/encoder/heads.py` docstring: noul `p = sigmoid(z / tau)`; `engine/encoder/engine.py` docstring lists only the v1 `calibration.json` keys | `FastEngine` applies `calibrate.calibrate_logits`: `by_header` τ, else `noul_platt` `sigmoid(a·z + b)`, else per-kind τ; v2 keys `by_bucket`, `tau_k`, `noul_platt`, `bucket_clamp` are honoured |
| 21 | `engine/base.py` docstring: answers are built "in `jev_local.api.build_answer`" | defined in `jev_local/confidence.py` -> `build_answer`; `api.py` only imports it |
| 22 | `training/LOG.md` (03:00–03:12): `jev_local` has an optional gain head (`DecisionHeads(gain_head=…)`, `add_gain_head()`, `HeadOut.gain`, `--gain-loss`) | only in the **parent repo's** copy; this tree's `heads.DecisionHeads(d=384)` / `HeadOut(choice, score, noul)` have no gain head and `train.py` has no `--gain-loss`; `training/collect_gain.py` (reads `o.gain`) and loading a `gain_mlp.*` checkpoint fail against this tree |
| 23 | `training/launch_student.sh` usage comment: MIX "e.g. `mix_v2_distill.json`" | no such file in `training/configs/` (existing: `mix_final1`, `mix_r68`, `mix_s1`, `mix_s1b`, `mix_s1c`, `mix_s2`, `mix_t150`, `mix_t1a`, `mix_t1b`, `mix_t1h`); the v2 mixtures are not written yet |
| 24 | `training/NEEDS.md` item 8 is still an open ASK (curriculum rows carry Python-only float literals such as `25.0`) | `training/curriculum/fmt.py` -> `js_numbers` (already present at 654d822) turns integral floats into ints, and `training/curriculum/generate.py` applies it to `state` and `questions`; rows generated before it (e.g. the one in export-r32's `requests.json`) still carry `25.0` |
| 25 | `training/NEEDS.md` item 11 (asks for the runtime tag, example `situation-v1`) and its "SIM → TRAIN: scaled data" section ("Runtime tag `situation-v1`") | the scaled SIM and REAL runs now in progress are `situation-v2` (`HANDOFF.md`; NEEDS item 16 and the c02–c09/c12–c23 claim row); `training/PLAN-v1.md` already says everything in it starts on v2 data |
| 26 | `packages/runtime-model/MODEL_CARD.md` status: R17 "delivered" in `files/r17/` | `packages/runtime-model/files/` is gitignored (not in the repo); R17-final1 is situation-v1 and does not match the v2 runtime; `@genclass/runtime-model` is unpublished (npm 404) |

Open issues relevant to this scope:

- No situation-v2 model: every number in `packages/runtime-model/MODEL_CARD.md` and `training/EVAL.md` is a v1 number (round-1 results: [RESULTS.md](../runtime/RESULTS.md)). CI exercises the serialize, calibration and answer-math parity against the committed `py_fixtures.json`, but the tokenizer/packer, ONNX engine and torch-calibration parity tests need a local model directory, so CI does not exercise them today.
- The two `jev_local` copies (this tree vs the parent repo synced to the cluster) have diverged (row 22). Decide which is canonical before changing either; until then, Python edits here do not reach training.
- T1 (expected-gain targets / gain head) was stopped on v1 with no result and is to be rerun on v2 data; LOG reports the gain-head interim loss barely beat trivial predictors (0.85 vs 0.97–1.01).
- TS port intentionally lacks multi-pass option batching and `lr`/median answer modes; the runtime must stay within `maxPositions` / `maxTotal`.
- `docs/GENCLASS.md` / `docs/COMPARISON.md` / `docs/PLAN-excel.md` numbers (90.4% vs 66.4%, v2 skill 36.8, staged budgets) describe the computer-use and benchmark lineage, not the runtime model; do not quote them as runtime results.

## Related docs

- [runtime/model-host.md](runtime/model-host.md) — the TypeScript model host built from this engine.
- [model-io-contract.md](model-io-contract.md) — situation text -> packed request -> heads -> calibrated answers across runtime, sim and training.
- [training.md](training.md) — `training/` (curriculum, prune, export, eval) that drives `jev_local/train`.
- [sim.md](sim.md) — the simulator that writes CONTRACT-D rows for the stage-2 pilot, the final rounds and the situation-v2 scaled runs.
- [realapps.md](realapps.md) — the real-browser corpus (REAL): CONTRACT-D rows from real apps running the runtime, the second v2 data source.
- [extension-and-benchmarks.md](extension-and-benchmarks.md) — Chrome extension (JS core between Python and TS), `jev_local/bench`, scripts.
- [status-and-known-issues.md](status-and-known-issues.md), [glossary.md](glossary.md), [repo-map.md](repo-map.md).
- Training plans and logs: [`training/PLAN-v1.md`](../../training/PLAN-v1.md), [`training/LOG.md`](../../training/LOG.md), [`training/NEEDS.md`](../../training/NEEDS.md), [`HANDOFF.md`](../../HANDOFF.md); round-1 results [RESULTS.md](../runtime/RESULTS.md); release procedure [RELEASE.md](../../RELEASE.md).
- Legacy sources: [SPEC](../SPEC.md), [CONTRACT](../CONTRACT.md), [CONTRACT-v2](../CONTRACT-v2.md), [DEMO](../DEMO.md), [GENCLASS](../GENCLASS.md), [COMPARISON](../COMPARISON.md), [PLAN-excel](../PLAN-excel.md); runtime contract [docs/runtime/CONTRACT.md](../runtime/CONTRACT.md); port notes [packages/runtime/src/model/README.md](../../packages/runtime/src/model/README.md).
