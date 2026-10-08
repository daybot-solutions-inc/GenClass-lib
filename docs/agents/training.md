# training/: the GenClass runtime model (curriculum, training, export, eval)

> **Scope:** `training/` (README.md, LOG.md, EVAL.md, NEEDS.md, `prune_vocab.py`, `eval_runtime.py`, `export_runtime.py`, `report.py`, every `*.sh`, `curriculum/**`, `configs/*.json`, `ortweb/**`, `tests/**`, `samples/**`), plus the parts of `jev_local/train/{train,stream,eval}.py`, `jev_local/engine/encoder/{engine,calibrate,tokenize_pack}.py`, `scripts/genclass_export.py` and `scripts/launch_run.sh` that `training/` calls.
> **Read this when:** you regenerate or change the stage-1 curriculum; mirror a runtime situation/question wording change into `curriculum/rt.py`; change mixtures or launch a training round on Azure; evaluate a checkpoint, fit calibration or read EVAL.md numbers; export a model directory (q8/fp16 ONNX, `model.json`, `meta.json`, `calibration.json`) or validate it with onnxruntime-web; change the vocabulary; pick between R17 and R32.
> **Source of truth:** the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

## TL;DR

- `training/` builds the model behind `@genclass/runtime`: a Jev-style typed-decision encoder (one forward pass reads a *situation* and answers typed *questions*: choice / noul / score). Owner workstream: TRAIN (CONTRACT §1 says LEAD).
- Two **model candidates**, both with a pruned 16,364-token vocabulary: **R17** (`jhu-clsp/ettin-encoder-17m`, d 256, 7 layers, fresh heads) and **R32** (GenClass 0.1 `jev-local-fast` = ettin-32m, d 384, 10 layers, v1 heads). Plan: R17 for WASM, R32 for WebGPU only if clearly more accurate (OPEN_TASKS item 5).
- Pipeline: `prune_vocab.py` (keep first 16,000 BPE merges) → **stage 1** on a synthetic curriculum (`curriculum/`, exact labels, ~55% passive-best decision rows) → **stage 2 / final round** on SIM rows from `sim/` (counterfactual-cost labels) plus curriculum replay → `eval_runtime.py` (product metrics + temperature fit) → `export_runtime.py` (fp16-free int8 **q8** ONNX for WASM, fp16 ONNX for WebGPU) → `ortweb/validate.mjs`.
- `curriculum/rt.py` is a Python port of `packages/runtime/src/situation/*` so a share of curriculum rows are **runtime-exact** (byte-identical format to what the runtime sends). Any wording change in the runtime situation code must be mirrored there (and is frozen as tag `situation-v1`).
- Training itself is `jev_local/train/train.py` in stream mode (DDP over torchrun/gloo on CPU) launched with `scripts/launch_run.sh`; all heavy work runs on Azure VMs (`c01` workbench, `c02`–`c11` F80 training nodes, `train` VM), never on the Mac.
- Data mixes (`configs/mix_*.json` → `jev_local/train/stream.py` → `MixConfig`) weight **buckets** = the parent directory names of train shards found under the `--stream` roots; weights are renormalised over the buckets present, so a missing bucket is silently dropped.
- The eval **gate** mirrors CONTRACT §8: candidate = argmax over permitted non-passive actions *A*; fire iff Σ_{a∈A} p(a) ≥ tier threshold (guard 0.9, heal 0.8) and top diagnosis ≠ `expected`. Headline metric: **FIR** (false-intervention rate on passive-best rows).
- Trained checkpoints ship with all-1.0 temperatures; the real `calibration.json` comes from `eval_runtime.py --write-calibration` and must be passed to `export_runtime.py --calibration`.
- Status at this commit: stage 1c final (rt1 action/diagnosis ≈ 98%, FIR 0%); stage-2 pilot on pre-freeze SIM was precise but almost never acted (recall ≈ 1.3%); **final round 1** (frozen `situation-v1`, SIM phase A) was launched 2026-10-08 00:06 UTC and has **no results in the repo** (EVAL.md says "(in progress)").
- Shell scripts assume a nested checkout: `JEV="$HERE/../.."` must contain `jev_local/`, `scripts/` and `pyproject.toml` (the original `/Users/meharkhanna/jev/<checkout>/training` layout). In this monorepo those live at the repo root, one level up (see Gotchas).

## Files

| Path | Role | Key entry points |
|---|---|---|
| `training/README.md` | Overview and reproduce commands (partly stale, see Drift) | — |
| `training/LOG.md` | Dated run log 2026-10-07/08: what ran where, throughput, costs, decisions | — |
| `training/EVAL.md` | Metric definitions and results (baseline, stage 1c, sizes/latency, stage-2 pilot) | — |
| `training/NEEDS.md` | Requests to SIM / CORE / MODEL (OPEN/ASK/DONE) | — |
| `training/prune_vocab.py` | First-N-merges BPE pruning of a checkpoint or HF base; inflation analysis | `prune_tokenizer_json`, `vocab_layout`, `prune_checkpoint`, `prune_hf_dir`, `slice_weights`, `remap_model_config` (+ `CONFIG_ID_KEYS`), `remap_tokenizer_config`, `iter_texts`, `analyze`, `main` (`prune` / `analyze` subcommands) |
| `training/curriculum/__init__.py` | Package docstring only | — |
| `training/curriculum/generate.py` | Parallel, seeded generator of CONTRACT-D jsonl (train/dev/test) + `stats.json` | `make_row`, `work`, `_validate`, `main`; `TRIGGERS`, `KINDS`, `TRAIN_DOMAINS`, `HELD_DOMAINS`, `P_RUNTIME` |
| `training/curriculum/world.py` | Explicit world model: ops, writes with versions, extras, baselines; varied-style rendering | `Op`, `Write`, `Extra`, `Baseline`, `Trace`, `render_timeline`, `render_in_flight`, `render_state_line`, `render_stats`, `status_phrase`, `_events`, `STATUS_TEXT`, `USER_VERB` |
| `training/curriculum/app.py` | Per-row app instance (names, ids, routes, values) from a domain | `App` (`ident`, `coll_url`, `item_url`, `new_id`, `route`, `app_line`, `body`, `list_summary`, `query_prefixes`), `rand_token` |
| `training/curriculum/vocab.py` | 62 app domains (13 held out), UI/error vocab | `Domain`, `DOMAINS`, `TEST_DOMAINS`, `domain_split`, `plural`, `PLURALS`, `PERSON_FIRST`, `COMPONENTS`, `FILE_EXT`, `INPUT_TARGETS`, `THIRD_PARTY` |
| `training/curriculum/fmt.py` | Surface variation: `Style`, paraphrase `TEMPLATES` with held-out tails, action/diagnosis vocab, `js_numbers` | `Style.make`, `pick`, `pick_from`, `held_count`, `js_numbers`, `TEMPLATES`, `ACTION_DESC`, `DIAG_DESC`, `DIAGNOSES`, `TRIGGER_ACTIONS`, `PASSIVE`, `TIER`, `DISTRACTOR_ACTIONS`, `ACTION_INSTR`, `DIAG_INSTR`, `CANONICAL_KEYS`, `KEY_VARIANTS` |
| `training/curriculum/scenarios.py` | `Scen` dataclass; mutation scenarios; noise ops | `Scen`, `mutation`, `mut_typeahead`, `mut_detail`, `mut_autosave`, `mut_live`, `mut_dupchange`, `add_noise_ops`, `cap_now`, `PASSIVE_OF` |
| `training/curriculum/scen_ops.py` | Request / failure / stall scenarios | `request`, `failure`, `stall` |
| `training/curriculum/scen_state.py` | Inconsistency / transition / error scenarios | `inconsistency`, `transition`, `error`, `ERR_MSGS` (5 entries) |
| `training/curriculum/prims.py` | Primitive questions with exact labels over a `Trace` | `noul`, `choice`, `score`, `temporal`, `causal`, `versions`, `identity`, `streak_q`, `latency_q`, `failure_q`, `failure_kind`, `ratio_level`, `RATIO_LEVELS`, `RETRYABLE`, `FAILURE_KIND_DESC` |
| `training/curriculum/rows.py` | Assemble rows: situation state, standing questions, primitives | `decision_row`, `ask_row`, `situation_state`, `action_question`, `diagnosis_question`, `add_prims`, `RENAMES` |
| `training/curriculum/standalone.py` | Non-situation primitive families | `json_invariants`, `http_semantics`, `js_errors`, `described_options`, `DECIDE` (12), `HTTP_CASES` (15), `JS_ERRS` (9), `JS_KIND_DESC` (8 kinds) |
| `training/curriculum/rt.py` | Runtime-exact rendering (port of runtime `situation/{facts,describe,build,serialize,questions}.ts`) | `render`, `to_state`, `section_limits`, `size_chars`, `signature`, `is_id`, `mutation_facts`, `request_common`, `failure_facts`, `stall_facts`, `inconsistency_facts`, `transition_facts`, `error_facts`, `subject_sentence`, `event_lines`, `in_flight_lines`, `state_lines`, `stats_lines`, `order`, `provenance`, `started_rel`, `user_relation`, `failure_text`, `failure_counts`, `error_rate_text`; ports of `util.ts` `truncate`, `secs`, `rel`, `fmt_num` (`fmtNum`), `ratio`, `plural`, `ordinal`, plus `times` (a local helper of `facts.ts`); constants `DIAG_INSTR`, `DIAGNOSES`, `ACTIONS`, `TRIGGER_ACTIONS`, `ACTION_INSTR`, `STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `MIN_BUDGET`, `COMPACT_QUESTIONS_MAX`, `BUDGETS`, `RANK`, `LIMITS`, `WINDOW`. `LINE` and `err_rate` are defined but unused. |
| `training/eval_runtime.py` | Evaluation: accuracy, NLL/Brier/ECE, temperature fit, gate metrics, SIM cost regret | `collect`, `get_records` (+ `dump_records`, `load_records`), `fit_calibration`, `fit_tau`, `fit_tau_noul`, `probs`, `group_of`, `canonical`, `softmax`, `ece`, `question_metrics`, `decision_metrics`, `load_rows`, `main`; `TIER`, `PASSIVE`, `THRESH`, `N_BINS` |
| `training/report.py` | Markdown tables (for EVAL.md) from eval reports | `main` (`name=path ... [--mode=kind\|raw\|group\|header]`) |
| `training/export_runtime.py` | ONNX export, q8/fp16 graph surgery, parity, model directory | `main`, `make_q8`, `make_fp16`, `quantize_embedding`, `gemm_to_matmul`, `requests_from_rows`; `CARD_FORMAT`, `OUTPUTS` |
| `training/ortweb/validate.mjs`, `package.json` | onnxruntime-node + onnxruntime-web 1.30.0 (WASM in Node) parity and latency check | CLI `node validate.mjs <dir> [variant=q8] [maxRequests=60]` |
| `training/configs/mix_*.json` | Mixture configs (`jev_local/train/stream.py` → `MixConfig`) | `mix_s1`, `mix_s1b`, `mix_s1c`, `mix_s2`, `mix_final1` |
| `training/node.sh` | ssh/rsync wrapper for Azure hosts | `node.sh HOST sync\|'cmd'\|get R L\|put L R` |
| `training/import_sim.sh` | Pull a SIM run to c01, shard train (stage 2) | `import_sim.sh SIM_OUT_DIR NAME` |
| `training/import_final.sh` | Pull a frozen SIM run, shard, build eval subsets, bundle for nodes | `import_final.sh SIM_OUT_DIR NAME` |
| `training/launch_s2.sh` | Launch stage-2 pilot runs (R32, R17) | no args |
| `training/launch_final1.sh` | Launch final round 1 | `launch_final1.sh R32_PASSES R17_PASSES` |
| `training/final_post.sh` | On a rank-0 node: SIM eval → export → serve tar on :8801 | `final_post.sh MODEL NAME VERSION` |
| `training/eval_sim.sh` | On c01 / a rank-0 node: sharded parallel logit collection over `data/NAME_t*`, `data/NAME_d*`, merge, one SIM eval per model (dev-fitted temps) | `bash eval_sim.sh NAME model...` → `out/eval/<M>-NAME.json`, `out/cal/<M>-NAME.json`, marker `out/eval/.done-sim-NAME` |
| `training/run_evals.sh` | On c01: stage-1 eval batch, 10 threads per job | `bash run_evals.sh TAG model...` → `out/eval/<M>-{rt1,sim,cur1,cur2}.json`, `out/cal/<M>.json` (rt1-dev fit), marker `out/eval/.done-TAG` |
| `training/pull_ckpt.sh` | Tar `~/gcl-train/models/NAME` on a node, serve it on `<node private IP>:8801`, untar into c01 `~/gcl-train/models/` | `pull_ckpt.sh NAME NODE` |
| `training/pull_on_train.sh` | On the train VM: wait for an export tar, unpack, sha256 check, run validate.mjs | `pull_on_train.sh IP MODEL ROUND SUB` |
| `training/deliver_final.sh` | From the Mac: same delivery as above, driven remotely | `deliver_final.sh MODEL NODE ROUND SUB` |
| `training/samples/runtime_samples.txt` | 75 hand-written lines of runtime-like text (7 subject sentences, facts, timeline lines, question headers, key names, action/diagnosis labels) for `prune_vocab.py analyze --group runtime=...`. Written before CORE's situation code: uses `op N` refs, not the runtime's `#N`. | — |
| `training/tests/test_*.py` | pytest suites (VM only) | see Tests |

## Concepts and data structures

Terms beyond the shared [glossary](glossary.md) (op, situation, questions, diagnosis, action, passive, mode, tier, budget, R17/R32, q8, `situation-v1`):

| Term | Meaning here |
|---|---|
| CONTRACT-D row | One jsonl training example `{id, split, family, state, questions, labels, meta}` (CONTRACT §11). For decision/ask rows `state` is the Jev state object (`app, trigger, facts, in_flight, timeline, state, stats`, key names varied in non-canonical styles); standalone rows use other keys (`request`/`response`/..., `error`/`stack`/`recent`, `situation`, a store name) or a plain string. `questions` maps qid → `{type, instructions, criteria}`. |
| Label formats | Parsed by `jev_local/train/train.py` → `parse_target`: noul `{"type":"noul","p":0..1}`; choice `{"type":"choice","label":x}` (x must be an offered label) or `{"dist":{x:p}}` (renormalised over offered labels); score `{"type":"score","level":k}` (0 ≤ k < K) or `{"dist":[...]}` (length K). In training a rejected label leaves that question in the input but unsupervised (counted as `bad_labels` in the log); the curriculum generator's `_validate` drops such rows entirely. |
| Standing questions | `action` (applicable actions, passive first) and `diagnosis` (10 labels). The runtime asks `action` only when ≥ 2 actions apply. |
| Primitive question | Exact-label question about the trace (qids `t_*` temporal, `c_*` causal, `v_*` versions, `i_*` identity, `o_*` outcomes, `b_*` baselines, `f_*` failure, `j_*` JSON, `h_*` HTTP, `js_*` JS errors, `decide`, plus scenario-specific `l_newer`, `d_same`, `d_gap`, `n_settled`, `n_explained`, `tr_novel`, `tr_hist`, `e_appcode`, `e_state`, `e_comp`). |
| Scenario / case | A builder in `scenarios.py` / `scen_ops.py` / `scen_state.py` returns a `Scen`; `Scen.case` is `"<builder>/<case>"`, e.g. `typeahead/stale`, `request/double_submit`. |
| `Scen` fields | `trigger, case, subject, subj, facts, actions, action (str or dist), diag (str or dist), state_paths, extra_state, stats_sigs, prims, exclude_inflight, trace, spec`; property `passive_best`. `spec` carries what `rt.py` needs (`cause`/`op`, `paths`, `after`, `cached`, `usual_per_10s`, `recent_count`, `err_rate`, `rel`, `values`, `held`, `fields`, `lc_age`, `unusual_text`, `chain_fields`, `repetition`, `no_runtime`, ...). |
| Trace | `world.py` → `Trace`: `ops` (id → `Op`), `writes` (`Write{t, path, version, op, summary}`), `extras` (error/nav/offline events), `baselines` (sig → `Baseline{sig, med, p95, err_rate, n}`), `version0/values0`, `now`. All ground truth is computed from the Trace, never from rendered text. |
| Style (varied) | `fmt.py` → `Style`: op-ref format (`op {n}`, `#{n}`, `op#{n}`, `req {n}`, `[{n}]`, `op-{n}`), 6 time formats (`rel_s`, `rel_ms`, `ago`, `clock`, `offset`, `t_minus`), duration format, 4 timeline line formats (A–D), key-name variants. 55% of rows use the canonical style. |
| Runtime-exact (style `runtime`) | Row rendered by `rt.render`: exactly the runtime's subject sentence, facts, `#id` refs, sections, budget shaping and standing questions. `meta.style` = `"runtime"`; otherwise `"varied"`. SIM rows have no `style` (eval groups them as `"sim"`). |
| Held-out templates | `fmt.pick_from`: the trailing `held_count(n)` = max(1, round(0.2 n)) entries of any list with ≥ 4 entries are test-only. |
| Held-out domains | `vocab.TEST_DOMAINS` (13 of 62): auction, ci dashboard, energy usage, forum, insurance claims, language learning, maps, parking, payroll, photo gallery, recipes, restaurant reservations, weather dashboard. Test rows use only these; train/dev never. |
| Bucket | A mixture group = the parent directory name of a shard file (`jev_local/train/stream.py` → `_names`), e.g. `data/s3/simA/shard07.jsonl` → bucket `simA`. A top-level `bucket` field in a row would override it (`_row_fields`); curriculum and SIM rows have none. |
| Pass / `pass_tokens` | One draw of the mixture; bucket token budget = weight × `pass_tokens`. `--passes` may be fractional. |
| Servable checkpoint vs trainer state | `--out models/<M>` (`backbone/`, `heads.safetensors`, `calibration.json`, `meta.json` with `final`) vs `runs/<run>/ckpt` (weights + optimizer, used by `--resume` and as `--init-from`). |
| Stage 1 / 1c / 2 / final round | s1: curriculum `cur1` + v1 `gen`/`cu` replay (`mix_s1`); s1c: continuation with runtime-exact `cur2` (`mix_s1c`); s2: pilot on pre-freeze SIM `r300k` (`mix_s2`); final1: frozen SIM phase A + replay (`mix_final1`). |
| FIR | False-intervention rate = gate fires on passive-best rows ÷ passive-best rows (per mode). |
| Replay | Curriculum/v1 buckets mixed into SIM training (`cur*`, `gen`, `cu`). |
| Hosts | `train` VM (10.0.0.4; SIM runs, delivery, MODEL's node_modules), `c01` (10.0.0.6; TRAIN workbench: prune, generate, eval, export, data hub), `c02`–`c11` (F80 training nodes; c02 = 10.0.0.7 is R32 rank 0, c09 = 10.0.0.14 is R17 rank 0). F80 ≈ $5.46/h (LOG). |
| `Op` (curriculum) | `world.py` → `Op{id, kind (user\|fetch\|timer\|ws\|task\|load), start, method, url, sig, body, end, status (ok\|error\|aborted), code, err ("timeout"\|"network error"\|""), cause, root, action, target, value, attempt}`; properties `req`, `identity` (`"{method} {url} {body}"`), `idempotent` (GET/HEAD/PUT/DELETE/OPTIONS). Ids start at `rng.randint(3, 400)` and advance by 1/1/1/2/3. `root` is inherited from `cause` at creation. |
| `Trace` API | Builders `user`, `timer`, `fetch`, `finish` (status `ok` iff code < 400 and no err), `abort`, `init_field`, `write` (version = previous + 1), `extra`, `baseline`; queries `version(path, t)`, `writes_between`, `last_write`, `value`, `in_flight(t)` (fetches with `start < t`, so a `request` subject created at `now` is not in flight), `requests`, `users`, `root_of`, `root_desc`. `scenarios.cap_now` turns fetches ending after `now` back into in-flight ops. |

Model candidates (README, EVAL.md, LOG; embedding arithmetic from the verified row counts):

| | R17 | R32 |
|---|---|---|
| Init | `jhu-clsp/ettin-encoder-17m` (MIT), downloaded to `~/jev/models/base/ettin-encoder-17m` (`pytorch_model.bin`) | GenClass 0.1 `models/jev-local-fast` (v1, Apache-2.0, trained on the repo's own synthetic `data/cu` + `data/gen`), a fine-tune of ettin-encoder-32m (MIT) |
| Backbone | ModernBERT/ettin, d 256, 7 layers | ModernBERT/ettin, d 384, 10 layers |
| Heads | fresh (seeded by `jev_local/engine/encoder/engine.py` → `init_model`) | v1 heads |
| Nominal size | 17M parameters (full 50,368-row vocabulary) | 32M parameters (full vocabulary) |
| Embedding after pruning | 50,368 × 256 ≈ 12.9M → 16,364 × 256 ≈ 4.2M params | 50,373 (50,368 + 5 markers) × 384 ≈ 19.3M → 16,364 × 384 ≈ 6.3M params |
| Pruned start point | `models/base/ettin-17m-v16k` (HF base; markers appended by `init_model`) | `models/r32-v16k` (pruned fast-engine checkpoint) |
| `--base` in launches | `$G/models/base/ettin-17m-v16k` | `$G/models/r32-v16k/backbone` |
| q8 / fp16 export (stage 1c) | 9.58 MB / 13.57 MB | 22.47 MB / 34.79 MB |
| Intended use | WASM default | WebGPU, only if clearly more accurate |

`models/r17-v16k-init` (random heads, used by `test_export_runtime.py` and MODEL's latency runs) also exists on c01; the command that created it is not recorded (`jev_local/train/train.py` has `--init-only`, which writes an untrained servable with meta `trained: false`; unverified that it was used).

Primitive question ids (`prims.py`; `add_prims` dedups by `(instructions, type)` and suffixes a repeated qid with `2`, `3`, ...):

| Builder | qid → type |
|---|---|
| `temporal` | `t_before` noul, `t_first` choice, `t_ooo` noul (out-of-order response), `t_lastend` choice, `t_inflight` score (0..3) |
| `causal` | `c_root` choice, `c_same` noul, `c_count` score (none/one/two/three or more) |
| `versions` | `v_changed` noul, `v_newer` noul, `v_behind` score (0/1/2/3 or more), `v_writer` choice |
| `identity` | `i_ident` noul, `i_which` choice, `i_sameact` noul, `i_gap` score (<100 ms / 100 ms–1 s / 1–5 s / >5 s) |
| `streak_q` | `o_streak` score (0..5 or more), `o_last` noul |
| `latency_q` | `b_ratio` score (`RATIO_LEVELS`: <1.5×, 1.5–3×, 3–10×, ≥10× the median), `b_p95` noul (elapsed > p95), `b_anom` noul (ratio > 3 and elapsed > p95) |
| `failure_q` | `f_kind` choice over 4 of the 9 `FAILURE_KIND_DESC` kinds (timeout, network, rate_limited, auth, forbidden, not_found, conflict, validation, server; `failure_kind` maps code/err), `f_retry` noul = (idempotent or idempotency key) and `RETRYABLE[code]` (default True) |
| scenario-specific | `l_newer` noul (`mut_live`), `d_same` noul / `d_gap` score (`mut_dupchange`), `n_settled` score / `n_explained` noul (`inconsistency`), `tr_novel` noul / `tr_hist` score (`transition`), `e_appcode` noul / `e_state` noul / `e_comp` choice (`error`) |

Standalone families (`standalone.py`, 28% of rows; `meta.kind = "prim"`):

| Family (`family`) | Content | qids |
|---|---|---|
| `cur/prim/json_invariants` | a store as nested JSON, flattened keys, or a JSON string; 2–4 of the checks total / count / selected / unique / nonneg; "which relation is violated" when ≤ 1 is broken; a price-threshold count | `j_<check>` noul, `j_which` choice, `j_count` score (overwrites the count check, see Gotchas) |
| `cur/prim/http` | one of 15 `HTTP_CASES` (code, err, headers, body) rendered as a dict (50%) or one line; 30% of POSTs carry an idempotency key; `meta` adds `code`, `err` | `f_kind`, `f_retry`, `h_wait` score (429/503 with Retry-After), `h_auth` noul (401), `h_side` choice client/server/network (not for timeouts), `h_field` choice (422 only) |
| `cur/prim/js_errors` | one of 9 `JS_ERRS`; 25% third-party stacks (`THIRD_PARTY`), else first-party component frames; dict or raw "Uncaught ..." text (30%) | `js_kind` choice over 4 of 8 `JS_KIND_DESC` kinds, `js_first` noul, `js_comp` choice (first-party only) |
| `cur/prim/decide` | one of 12 `DECIDE` described-option situations (e.g. 401 with/without refresh token) | `decide` choice |

Remote layout (scripts and LOG; `G=/home/azureuser/gcl-train`):

| Where | Path | Contents |
|---|---|---|
| Mac | `~/.jev-local/azure_hosts`, `~/.ssh/jev_azure` | host table (name, public IP, private IP), ssh key (user `azureuser`) |
| every node | `~/gcl-train/training/` | rsynced copy of `training/` (`node.sh sync`, `--delete`) |
| every node | `~/jev/{jev_local,scripts,pyproject.toml}`, `~/jev/.venv/bin/python` | jev code (rsync without `--delete`) and the Python env (`$PY`) |
| every node | `$G/data/<set>/`, `$G/data/s{1,1b,2,3}/<bucket>/shardNN.jsonl` | generator / SIM outputs; stream roots with one dir per mixture bucket |
| every node | `$G/models/<M>/` | servable checkpoints (`--out`) |
| every node | `$G/runs/<run>/{ckpt/,log.jsonl}` | trainer state (`--runs-dir`) and the rank-0 training log |
| every node | `~/jev/runs/<run>/rank<R>.out` | stdout/stderr of each node's torchrun (`scripts/launch_run.sh`) |
| every node | `$G/cache/<round>/` | stream index cache (`--stream-cache`) |
| c01 / rank-0 nodes | `$G/out/{eval,cal,records,export-<M>}/`, `$G/logs/` | eval reports, calibration files, cached logits, exports, job logs |
| c01 / nodes | `~/xfer/` | tars served by `python3 -m http.server` (ports below) |
| train VM | `~/gcl/sim/sim/out/<run>/` | SIM outputs (`r300k`, `final-a`) |
| train VM | `~/gcl/train-out/<round>/<sub>/`, `~/gcl/train-out/ortweb/` | delivered exports; validation dir (`node_modules` → `~/gcl/model/node_modules`, Node at `$HOME/node/bin`) |

Stream-root contents (which bucket lives under which root). Only `data/s2/<NAME>` and `data/s3/<NAME>` are created by scripts; the rest is inferred from launch flags and mixtures (unverified):

| Root | Buckets |
|---|---|
| `data/s1` | `cur1`, `gen`, `cu` (stage 1); also streamed in s2 and final1 |
| `data/s1b` | `cur2` (streamed from s1c on) |
| `data/s2` | `sim1` (`import_sim.sh`), `cur3` (README) |
| `data/s3` | `simA` (`import_final.sh`); `cur4` must also sit under `data/s3` or `data/s1` for `mix_final1.json` to find it (no script puts it there; see Gotchas) |

Datasets referenced by configs and scripts (sizes from LOG/EVAL; generator flags marked unverified where not in a script):

| Bucket / dir | Rows (train / dev / test) | Source | Notes |
|---|---|---|---|
| `cur1` | 800k / 6k / 12k | `generate.py --n 800000 --dev 6000 --test 12000 --seed 1 --workers 72` | all varied style (generated before `rt.py` existed); 818k rows in ≈ 8 s on 72 processes; packed length mean 482 / p95 885 / max 1,208 tokens; sharded into 64 files |
| `cur2` | 400k / ? / 8k | seed 2, `--p-runtime 0.6` | 60% of decision rows runtime-exact, rendered by the first `rt.py` port (pre-freeze wording, 3,200-char budget only) |
| `rt1` | — / 6k / 12k | `--p-runtime 1.0` (seed unverified) | runtime-style eval/calibration set, same pre-freeze port as `cur2`. Only decision rows are rendered runtime-style (and `failure/offline` falls back to varied); ask and standalone rows are varied. 12,000 test rows hold 6,583 decision rows (EVAL.md). |
| `cur3` | 300k | seed 4, `--p-runtime 0.8` | stage-2 replay; adds coincidental-invariant cases; budgets 3,200 / 2,000 / 1,100 at 40/35/25% (before `transient`, compact questions and the 1,000 budget, LOG 18:41–19:02); at `data/s2/cur3` |
| `cur4` | 300k | seed 5, `--p-runtime 0.8` | final replay, frozen `situation-v1` wording (current `rt.py`); the raw set is `data/cur4/{train,dev,test}.jsonl` |
| `gen`, `cu` | — | GenClass 0.1 v1 synthetic data (`data/gen` all, slice of `data/cu`) | replay only |
| `sim1` | 224,051 / 7,426 / 68,790 | SIM `r300k` (pre-freeze) via `import_sim.sh` | `sim1e/test.jsonl` = 20k random test rows |
| `simA` | 448,420 / 14,613 / 137,643 | SIM `final-a` (frozen) via `import_final.sh` | `simAe` = 8k dev / 20k test random rows |
| `simsample` | 200 (123 decision rows) | `sim/samples/sample.jsonl` | zero-shot check in `run_evals.sh` |

Row `meta` written by the curriculum (`rows.py` → `decision_row`): `kind="decision"`, `trigger`, `case`, `domain`, `passive_best`, `action_gold` (shown name), `action_canonical`, `passive` (shown passive name), `diag_gold`, `action_names` (canonical → shown), `prims`, `heldout_templates_possible`, `soft_action`, `style`. Ask rows (`ask_row`): `kind="ask"`, `trigger="ask"`, `source_trigger`, `case`, `domain`, `prims`. Standalone: `kind="prim"`, `family`, `domain` (+ `code`, `err` for HTTP). Families: `cur/<trigger>/<case suffix>` (builder name dropped, see below), `cur/ask/<trigger>`, `cur/prim/{json_invariants,http,js_errors,decide}`. Curriculum rows carry **no `meta.budget`**.

## How it works

### 1. Vocabulary pruning (`training/prune_vocab.py`)

1. `vocab_layout` classifies a byte-level BPE `tokenizer.json`: ids 0–1 added tokens, 2–244 the 243 base byte symbols, 245+i = result of merge i (50,009 merges in ettin), added tokens from 50254 (whitespace runs, specials, `[unused0..82]`, and in GenClass checkpoints the markers `[Q] [O] [L] [T] [F]`). Raises if a merge result is missing or two merges produce the same token.
2. `prune_tokenizer_json(tj, N)` keeps base ids + the first N merge results + all added tokens, checks closure under composition (raises `merges are not closed under composition`), and remaps ids in kept order: ids < 245+N are unchanged, added tokens move down to 245+N.. . It also remaps `post_processor` TemplateProcessing ids and `padding.pad_id`.
3. `prune_hf_dir` slices every `[vocab, d]` (and `[vocab]`) tensor via `index_select` (`slice_weights`, always writes safetensors; reads `pytorch_model.bin` for HF bases), writes `config.json` (`vocab_size` + remapped `*_token_id`), `tokenizer.json`, `tokenizer_config.json` (`added_tokens_decoder` remapped) and `prune.json` (`merges_kept`, `merges_total`, `vocab_old`, `vocab_new`, `embedding_keys`, `source`, `source_tokenizer_sha256`).
4. `prune_checkpoint` (a GenClass fast-engine checkpoint with `backbone/`) prunes `backbone/`, copies `heads.safetensors` and `calibration.json`, and annotates `meta.json` with `vocab_pruned` and `pruned_from`. Written to a temp sibling then renamed.
5. For an HF base (R17), markers are added later by `jev_local/engine/encoder/engine.py` → `init_model` (resize embeddings, seeded marker init), so markers land at the end.
6. `analyze --src ... --group name=a.jsonl,b.txt --merges 8000,12000,...` reports tokens-per-char inflation vs the full vocab (`iter_texts` tokenises state segments `"key: text"`, question headers and items like the packer; `.txt` = one text per line; `--limit-rows` default 2000).

Result used everywhere: N = 16,000 merges → vocab **16,364** = 245 + 16,000 + 119; markers `[Q] [O] [L] [T] [F]` = ids **16359–16363**. R32 and R17 tokenizers are identical (LOG). Inflation at 16k: +10.8% tokens on runtime-like text, +12.3% v1 gen, +10.9% v1 cu (LOG table).

### 2. Curriculum generation (`training/curriculum/generate.py`)

1. `main` builds jobs of `--chunk` (default 5000) rows per split; dev default = max(2000, n/50), test default = max(4000, n/25). Workers run `work(split, chunk, n, seed, out)` with `random.Random(f"{seed}:{split}:{chunk}")`, so output is independent of `--workers` but depends on `--chunk`.
2. `make_row`: test split draws a domain from `TEST_DOMAINS`, else from train domains; builds `App` and `Style.make(rng, test)`; picks a kind from `KINDS` = decision 0.58, ask 0.14, json 0.10, http 0.08, js 0.04, decide 0.06.
3. Decision/ask: pick a trigger from `TRIGGERS` (mutation 0.26, request 0.20, failure 0.18, stall 0.12, inconsistency 0.09, transition 0.08, error 0.07), run its builder → `Scen`, then `rows.decision_row(sc, app, st, rng, P_RUNTIME)` or `rows.ask_row`.
4. `decision_row`: if `p_runtime > 0` and `rng.random() < p_runtime`, call `rt.render`; on success emit runtime-exact state/questions (labels restricted to offered actions, 0–2 primitives: choice of (0,0,1,2), `style="runtime"`). Otherwise varied: `situation_state` (≤ 12 facts, shuffled 25%; ≤ 8 state lines; timeline ≤ 16; in-flight ≤ 6; 15% drop one of in_flight/stats/state; 10% shuffle key order; key names from `Style`), `action_question` (10%: rename via `RENAMES`; 15%: insert 1–2 `DISTRACTOR_ACTIONS`; 50% shuffle; descriptions canonical or paraphrased; 10% bare names), `diagnosis_question` (20%: subset keeping gold + `expected` + 2–5 others; 50% shuffle; 10% bare labels), 15% question order swapped, `action` removed if < 2 actions, 0–3 primitives (choice of (0,1,2,2,3)).
5. `_validate` runs `jev_local.serialize.state_segments`, `question_block` and the trainer's `parse_target` on every label; invalid rows are counted in `stats["bad"]`, generator exceptions in `stats["errors"]`; neither is emitted. Each chunk tries at most 3n times.
6. Valid rows get id `cur-{split}-{chunk:05d}-{i:06d}`; `fmt.js_numbers` is applied to `state` and `questions` (integral floats → ints, NEEDS item 8). Chunks are concatenated into `{train,dev,test}.jsonl`; `stats.json` has per-split counters and `passive_best_fraction` per trigger.

Ask rows (`rows.ask_row`): the same `Scen` situation via `situation_state(..., ask=True)` with the trigger line replaced by "Developer question about the current situation." / "ask" / "Question from the app developer.", `facts` dropped 30% of the time (the answer must then come from timeline/state), and 2–5 primitives only (a row with none is discarded). Family `cur/ask/<trigger>`.

Varied-style wording vs the runtime's: `rows.action_question` draws instructions from `fmt.ACTION_INSTR[trigger]` and `rows.diagnosis_question` from `fmt.DIAG_INSTR`. For mutation, request, stall and error the first entry equals the runtime's `ACTION_INSTRUCTIONS`; for failure ("...with this failure?"), inconsistency and transition, and for the diagnosis question ("What is going on here?"), the varied lists do not contain the runtime sentence. The exact runtime instructions (`rt.ACTION_INSTR`, `rt.DIAG_INSTR` = "What is happening here?") appear only in runtime-exact rows. Descriptions: forced canonical (`ACTION_DESC[a][0]`, `DIAG_DESC[d][0]`, = runtime text) 50% of the time, else `pick_from` over the list (which may also return the canonical entry; held-out tails only on test rows).

Row families use the case suffix only: `family = f"cur/{trigger}/{case.split('/')[-1]}"` (e.g. `typeahead/stale` → `cur/mutation/stale`), so builders sharing a case name share a family; `meta.case` keeps the full `"<builder>/<case>"`.

Scenario cases and labels (weights are the `rng.choices` weights in each builder):

| Trigger | Cases → action / diagnosis |
|---|---|
| mutation (`mutation`: typeahead 0.42, detail 0.20, autosave 0.16, live 0.11, dupchange 0.11) | `*/stale` → discard / stale; `*/moved_inflight` → {defer .7, discard .2, apply .1} / {stale .8, conflict .2}; `fresh`, `older_between`, `same_root`, `two_saves_last`, `live/newer`, `dupchange/separate_clicks`, `dupchange/idempotent_set` → apply / expected; `dupchange/dup_append` → discard / duplicate |
| request | `double_submit`, `same_root_get` → coalesce / duplicate; `separate_intent`, `deliberate_repeat`, `polling_ok`, `typing_burst`, `normal` → send / expected; `retry_storm` → delay / overload; `runaway` → {delay .6, block .3, send .1} / overload; `failing_backoff` → delay / failing; `outage_cached` → {serve_cached .55, delay .35, send .1} / failing |
| failure | `transient_get`, `timeout_get`, `post_with_key` → retry / transient; `post_no_key` → deliver / transient; `outage_cached` → {serve_cached .7, deliver .2, retry .1} / failing; `offline` with cache → {serve_cached .6, deliver .4} / failing, else deliver / failing; `rate_limited` → deliver / overload (high rate) or failing; `longpoll_expected` → deliver / expected; `outage_no_cache`, `app_retry_loop` → deliver / failing |
| stall | `tail_get` → hedge / slow; `tail_get_cached` → {hedge .6, serve_cached .3, wait .1} / slow; `api_degraded` → {wait .7, hedge .3} (GET) / slow; `slow_upload` → wait / slow if > p95 else expected; `within_p95`, `slow_endpoint_ok` → wait / expected |
| inconsistency | `partial_sum`, `count_drift`, `negative` → resync (if handler) else rollback / inconsistent; `dup_ids` → same / {inconsistent .6, duplicate .4}; `explained_discount`, `coincidental`, `weak_invariant` → mostly ignore (soft, ≥ 0.8) / expected |
| transition | `missing_write`, `null_write` → soft resync/rollback/ignore mixes / unusual; `common_variant`, `few_obs`, `empty_after_filter` → ignore / expected |
| error | `bad_write` → {rollback .7, ignore .3} / {unusual .6, inconsistent .4}; `third_party`, `resize_observer` → ignore / expected; `unhandled_fetch`, `chunk_load` → ignore / {transient .6, failing .4} |

Case weights (`rng.choices` in each builder): typeahead stale .36 / fresh .22 / older_between .20 / moved_inflight .12 / same_root .10; detail stale .40 / fresh .30 / moved_inflight .15 / older_between .15; autosave stale .50 / fresh .30 / two_saves_last .20; live stale .50 / newer .50; dupchange dup_append .45 / separate_clicks .35 / idempotent_set .20; request normal .17 / double_submit .13 / same_root_get .07 / separate_intent .10 / deliberate_repeat .08 / retry_storm .08 / failing_backoff .10 / outage_cached .06 / polling_ok .09 / typing_burst .07 / runaway .05; failure transient_get .17 / post_no_key .13 / post_with_key .07 / outage_cached .08 / outage_no_cache .10 / rate_limited .10 / offline .08 / timeout_get .10 / longpoll_expected .09 / app_retry_loop .08; stall tail_get .25 / within_p95 .22 / slow_endpoint_ok .15 / api_degraded .14 / slow_upload .12 / tail_get_cached .12; inconsistency partial_sum .15 / count_drift .12 / negative .09 / dup_ids .08 / explained_discount .16 / weak_invariant .15 / coincidental .25; transition missing_write .25 / null_write .18 / common_variant .22 / few_obs .17 / empty_after_filter .18; error bad_write .34 / third_party .20 / resize_observer .14 / unhandled_fetch .18 / chunk_load .14.

Offered actions (`Scen.actions`, which become the `action` criteria): mutation always apply/discard/defer; request send/delay/block, + `coalesce` (always for `same_root_get`; for the POST repeat cases only when the earlier identical request is in flight or ended < 2 s ago) and + `serve_cached` for `outage_cached`; failure deliver/retry, + `serve_cached` for `outage_cached` and half of offline GETs; stall `wait`, + `hedge` for GETs, + `serve_cached` for `tail_get_cached`; inconsistency/transition ignore/rollback, + `resync` in 50% of rows (`has_resync`); error `ignore`, + `rollback` only for `bad_write`. So non-GET stalls (`slow_upload`, POST `slow_endpoint_ok`) and every error case except `bad_write` are single-action rows with no `action` question.

Measured passive-best shares of `cur1` train decision rows: mutation 0.50, request 0.51, failure 0.54, stall 0.63, inconsistency 0.42, transition 0.70, error 0.66 (LOG; generated before the `coincidental` and `transient` changes).

### 3. Runtime-exact rendering (`training/curriculum/rt.py` → `render`)

1. Returns `None` (row falls back to varied style) when `sc.spec` is empty or `spec["no_runtime"]` (currently `failure/offline`: CORE cannot produce an offline fact).
2. Per trigger builds facts as `(text, kind, neutral)` tuples with CORE's computations: `mutation_facts` (provenance, per-path versions with same-chain vs other-writer logic and `started_rel` "started 0.09s after #6", inputs moved incl. "is back to", concurrency, baseline, failed cause, pending local change, repetition, delta), `request_common` (provenance, attempt, identical requests in the last 10 s, other same-signature requests, failure streak, rate vs usual, baseline with `error_rate_text`, cache, idempotency), `failure_facts`, `stall_facts`, `inconsistency_facts`, `transition_facts`, `error_facts`.
3. `order` sorts non-neutral first, then by `RANK` (invariant/transition/error 0, versions 1, repetition 2, inputs 3, outcome 4, baseline 5, concurrency 6, provenance 7, request 8, cache 9, delta 10, plugin 11), stable; identical to `packages/runtime/src/situation/facts.ts` → `RANK`.
4. Sections: `subject_sentence`, `in_flight_lines`, `event_lines` (timers omitted, like CORE), `state_lines`, `stats_lines` ("F of last N failed" over ≤ 20 outcomes via `failure_counts`).
5. Budget: `GC_RT_BUDGET` env (analysis) or `spec["budget"]` or a draw from `BUDGETS` = 3200 (0.35) / 2000 (0.30) / 1000 (0.35). `to_state` applies `section_limits` (linear between `COMPACT_BUDGET` 1100 and `STATE_CHAR_BUDGET` 3200, `MIN_BUDGET` 500) then shrinks timeline (oldest first) → state → facts (floor 1) → in_flight → stats until `size_chars` ≤ budget; mirrors `packages/runtime/src/situation/serialize.ts` → `toJevState`.
6. Questions: `diagnosis` always, with `DIAG_INSTR` "What is happening here?" and `DIAGNOSES` (10 labels); `action` only if ≥ 2 of `TRIGGER_ACTIONS[trigger]` are in `sc.actions`, with `ACTION_INSTR[trigger]`. At budget ≤ `COMPACT_QUESTIONS_MAX` (1400) every criterion is `null` (bare labels), as in `questions.ts` → `buildQuestions`.
7. Details that matter for byte parity: `app` = `"{app.title} — {app.route()}"`; an empty list section becomes the string `"none"`; `size_chars(state)` = Σ over keys of `len(key) + 2 + len(text) + 1`, where `text` is `"\n".join(value)` for a list and `str(value)` otherwise (= `serialize.ts` → `stateChars`); `failure_text` prints `HTTP <code>` and appends the `world.STATUS_TEXT` reason phrase for a deterministic ≈ 30% of ops (`(op.id * 2654435761) % 10 < 3`), because `Response.statusText` is usually empty in browsers and in SIM. Spec keys `extra_facts` (rendered as `plugin`-kind facts) and `budget` are read by `render` but no scenario sets them, so the budget is always drawn from `BUDGETS` (or `GC_RT_BUDGET`). Mutation rows add `spec["state_extra"]` paths (e.g. the query field) to the state section.

### 4. Training (stage 1, stage 2, final round)

1. Sync code to a node: `training/node.sh HOST sync` (rsync `training/` → `~/gcl-train/training/` with `--delete`; `jev_local`, `scripts`, `pyproject.toml` → `~/jev/`).
2. Data must be sharded (the stream index/length cache is built per file in parallel: one 1.8 GB file took minutes, 64 shards 24 s). The import scripts use `split -n l/64`.
3. From the Mac, a launch script calls `scripts/launch_run.sh RUN MASTER_IP NPROC THREADS "nodes" -- <train.py args>`. For each node (in order, node rank = position) it ssh-es and starts `python -m torch.distributed.run --nnodes N --nproc-per-node NPROC --node-rank R --master-addr MASTER --master-port 29500 -m jev_local.train.train --ddp --threads THREADS --run-name RUN ...` detached (`setsid nohup nice -n 5`, from `~/jev` with `.venv/bin/python`), with `OMP_NUM_THREADS=THREADS`, `GLOO_SOCKET_IFNAME=eth0`, `JEV_ENCODER=banded`, `TOKENIZERS_PARALLELISM=false`, `HF_HUB_OFFLINE=1`; stdout/stderr go to `~/jev/runs/RUN/rank<R>.out` while the trainer's own state and `log.jsonl` go to `--runs-dir` (`$G/runs/RUN/`).
4. `jev_local/train/train.py` → `train`: `init_model(--base)`; rank 0 alone loads `runs/<run>/ckpt` if `--resume` and it exists, else `--init-from` (servable dir or trainer-state dir, weights only, fresh optimizer/schedule), then broadcasts. So **rank 0 must be the node holding the `--init-from` path**.
5. Stream mode builds `MixConfig.from_json(--mixture, **CLI overrides)` over `--stream` roots; `stream.py` → `discover` walks each root recursively (`<root>/raw/**` if present, else `<root>/**`; `*.jsonl` and `*.jsonl.zst`; hidden dirs skipped), buckets come from the shard's parent directory name (`_names`), and rows are filtered by their `split` field (default `("train",)`), so dev/test files under a root are ignored. Weights merge over `DEFAULT_BUCKET_WEIGHTS` (the v2 `b1_*`…`s0_families` table, irrelevant here); buckets absent from `bucket_weights` get `OTHER_BUCKET_WEIGHT` = 0.04 unless `buckets` restricts them; weights are renormalised over the buckets actually present, so a missing bucket silently drops out; unknown JSON keys raise.
6. Checkpoints every `--ckpt-every` steps to `runs/<run>/ckpt` and the servable `--out` (meta adds `base`, `max_len`, `run`, `trained`, `step`, `final`); `final: true` only when step ≥ total. `calibration.json` in the servable is the default (all temperatures 1.0).
7. Stop cleanly with `pkill -TERM -f "run-name r32-s1[c] "` on the rank-0 node (bracket trick so pkill does not match itself); ranks agree to drop the partial step and rank 0 checkpoints.

Runs as executed (LOG; `G=/home/azureuser/gcl-train`). The s1c, s2 and final1 commands (README, launch scripts) all pass `--balance --amp --no-grad-ckpt --device cpu --batch-tokens 8192 --log-every 10 --ckpt-every 50 --runs-dir $G/runs --resume` with 8 ranks × 10 threads per node; the exact `*-s1` commands are not in the repo (unverified beyond LOG):

| Run | Nodes (rank 0 first) | Mixture / streams | Init | lr / head-lr | grad-accum | max-len | Passes / steps |
|---|---|---|---|---|---|---|---|
| `r32-s1` | c02–c08 (4 × 20 threads) | `mix_s1` | pruned v1 `models/r32-v16k` | 1.5e-4 / 6e-4 | ? | ? (unverified) | 2 planned, stopped at step 190 |
| `r17-s1` | c09–c11 (4 × 20 threads) | `mix_s1` | `models/base/ettin-17m-v16k` + fresh heads | 3e-4 / 2e-3 | ? | ? (unverified) | stopped at step 382 |
| `r32-s1c` | c02–c08, master 10.0.0.7 | `mix_s1c`; `data/s1b data/s1` | `runs/r32-s1/ckpt` | 1.2e-4 / 5e-4 | 3 | 1536 | 1 pass, 312 steps / 36 min |
| `r17-s1c` | c09–c11, master 10.0.0.14 | `mix_s1c` | `runs/r17-s1/ckpt` | 2.5e-4 / 1.5e-3 | 2 | 1536 | 1 pass, 1,092 steps / 39 min |
| `r32-s2` (`launch_s2.sh`) | c02–c05 | `mix_s2`; `data/s2 data/s1b data/s1`, seed 2 | `runs/r32-s1c/ckpt` | 1e-4 / 4e-4 | 3 | 2048 | 1.5, 625 steps |
| `r17-s2` | c09 c10 c11 c06 c07 c08 | `mix_s2` | `runs/r17-s1c/ckpt` | 2e-4 / 1e-3 | 2 | 2048 | 4, 1,664 steps |
| `r32-final1` (`launch_final1.sh`) | c02–c07 | `mix_final1`; `data/s3 data/s1`, seed 3, cache `cache/final1` | `runs/r32-s1c/ckpt` | 1e-4 / 4e-4 | 3 | 2048 | 2.4 × 498M tokens (in progress) |
| `r17-final1` | c09 c10 c11 c08 | `mix_final1` | `runs/r17-s1c/ckpt` | 2e-4 / 1e-3 | 2 | 2048 | 3.0 (in progress) |

Measured throughput (LOG): `r32-s1` ≈ 215k tok/s (5 s/step), falling to 134k with the 4 × 20 layout; `r17-s1` 165–210k; 1-node R17 pilot 68–70k (4 × 20) vs 93–95k (8 × 10); `r32-s2` ≈ 168k, `r17-s2` ≈ 449k; `r32-final1` ≈ 253k, `r17-final1` ≈ 322–333k tok/s. Stage-1 loss 0.28 / 0.27 at steps 60 / 140; first stage-2 step 0.76 (R32) / 0.80 (R17). Stage 1c logged no dropped questions and no bad labels.

Final rounds deliberately restart from the stage-1c weights (the s2 pilots saw pre-freeze text). Layout rule from LOG: 8 ranks × 10 threads per F80 node; 4 × 20 left ranks idle ≈ 45% of each step (per-micro-batch Python overhead dominates for these small models).

### 5. Final-round pipeline (frozen data)

1. `training/import_final.sh /home/azureuser/gcl/sim/sim/out/final-a simA` (from the Mac): train VM serves the SIM dir on `10.0.0.4:8802`; c01 downloads `{train,dev,test}.jsonl` (+ `stats.json`) into `data/simA/`, splits train into `data/s3/simA/shardNN.jsonl` (64), builds `data/simAe/test.jsonl` (`shuf -n 20000`, random source `yes 7`) and `data/simAe/dev.jsonl` (8000, `yes 8`), shards them into `data/simAe_t{0..3}/test.jsonl` and `data/simAe_d{0,1}/dev.jsonl`, tars `data/s3 data/simAe data/simAe_* data/cur4 training` into `~/xfer/final_simA.tar` (2.57 GB) and serves `~/xfer` on `10.0.0.6:8799`.
2. Start c02–c11, `node.sh <node> sync`, pull and untar `final_simA.tar` from `10.0.0.6:8799` on each node (manual step). `mix_final1.json` needs a `cur4` bucket, i.e. `cur4` train shards under `data/s3/cur4/` or `data/s1/cur4/`; `import_final.sh` bundles the whole `data/s3` and the raw `data/cur4/`, but no script in the repo shards `cur4` into a stream root (presumably done by hand on c01; unverified). If it is missing, the trainer silently renormalises over `simA`, `cur1`, `gen`.
3. `training/launch_final1.sh <R32 passes> <R17 passes>`.
4. On each rank-0 node a detached waiter (not in the repo) waits for `models/<M>/meta.json` `"final": true`, then runs `training/final_post.sh <M> <name> <version>` (example in the script: `r17-final1 genclass-runtime-r17 1.0.0-rc1`): `EVAL_THREADS=12 eval_sim.sh simAe <M>` → `out/eval/<M>-simAe.json` + `out/cal/<M>-simAe.json`; `export_runtime.py --calibration out/cal/<M>-simAe.json --data-rows data/simAe/dev.jsonl,data/cur4/dev.jsonl --n-per-file 60 --threads 24` → `out/export-<M>/`; markers `out/.post-done-<M>`, `out/.served-<M>`; tar without `ref/` → `~/xfer/export-<M>.tar`, served on `<hostname -I first IP>:8801`. The script runs with `set -u` but not `-e`: a failed eval still runs the export (which then fails on the missing calibration file) and the markers are touched anyway, so check `logs/final-eval-<M>.log` and `logs/final-export-<M>.log`. Its first redirect writes `logs/final-eval-<M>.log` before `eval_sim.sh` creates `logs/`, so `~/gcl-train/logs/` must already exist on the node.
5. On the train VM, detached: `pull_on_train.sh <rank-0 ip> <M> final1 <r17|r32>` polls `http://IP:8801/export-<M>.tar` (400 × 30 s), unpacks into `~/gcl/train-out/final1/<sub>/`, checks each file's sha256 against `model.json` (the card's `bytes` are printed, not compared; same in `deliver_final.sh`), runs `node validate.mjs <dir> q8 120` in `~/gcl/train-out/ortweb` (node_modules symlinked from `~/gcl/model/node_modules`). `deliver_final.sh` does the same driven from the Mac and also copies `validate.mjs` there.

### 6. Evaluation (`training/eval_runtime.py` → `main`)

1. `load_rows` reads `<data>/<split>.jsonl` (with `--limit`), keeps `meta`, `labels`, `family` and a `_budget` bucket: `meta.budget` (or `meta.situation.budget`) when present (SIM), else by state chars `≤1100` / `≤2100` / `>2100`.
2. `get_records` → `collect` calls `jev_local/train/eval.py` → `collect` (banded encoder, `max_len` from ckpt meta, default 2048) and keeps one record per supervised question `{id, qid, kind, labels, logits, target, header}`; `header` is `sha1(header)[:12]`. With `--records-dir`, raw logits are cached as `<ckpt.name>__<data.name>__<split>.jsonl` and **reused whenever the file exists**.
3. Calibration: `--calibration file` loads `noul/choice/score/by_header` (action and diagnosis use `choice`). `--fit-split dev` instead fits: `fit_tau` (golden section on log τ in [0.2, 5], 40 iterations, soft-target NLL) for `choice` (all choice questions incl. standing ones), `score`, `action`, `diagnosis`; `fit_tau_noul` (61-point log grid in [0.2, 5]); `by_header` for standing-question headers with ≥ 300 records. A split-half check fits on even `crc32(id)` and scores odd ids.
4. For each mode in raw/kind/group/header (only raw without temperatures): `question_metrics` (per group `action`, `diagnosis`, `choice`, `score`, `noul`, `all`: n, acc, NLL, Brier, ECE with 15 bins) and `decision_metrics`.
5. `decision_metrics` (rows with both `action` and `diagnosis`): maps shown names back with `meta.action_names`; passive-best = gold == `PASSIVE[trigger]` (fallback `meta.passive` for unknown triggers) or `TIER[gold] == "passive"`; per mode guard (guard tier) / heal (guard + heal): *A* = offered actions whose tier is permitted (unknown names default to heal), candidate = argmax p over *A*, fire iff Σ p(A) ≥ `THRESH[tier(candidate)]` and top diagnosis ≠ `expected`. Counts FIR, precision (candidate == gold), recall (on rows whose gold is a permitted non-passive action), and with `meta.costs`: mean cost of policy / always-passive / oracle and harm on passive rows. Breakdowns `by_trigger`, `by_case`, `by_style`, `by_budget`; `sweep` at 0.5/0.6/0.7/0.8/0.9/0.95 (heal set); `diag_confusion`; top-30 `false_fires_detail` (`mode:trigger:cand<-gold`).
6. `primitive_acc` per qid family (trailing digits stripped). Report JSON to `--out`; `--write-calibration` writes `{noul, choice, score, by_header, _fit}` (`by_header` only with `--header-calibration`, else `{}`). The fitted `action` / `diagnosis` temperatures are only recorded in `_fit.taus`: the shipped file applies `choice` to the standing questions unless `--header-calibration` adds their exact headers (lookup is by header, then by kind, with optional `by_bucket` / `tau_k` / `noul_platt` steps in between that these files never contain; there is no per-qid key: `packages/runtime/src/model/calibrate.ts`, `jev_local/engine/encoder/calibrate.py` → `calibrate_logits` / `tau_for`). If both `--calibration` and `--fit-split` are given, the fit wins. Console prints the `kind` mode summary.
7. Report layout: `ckpt, data, split, n_rows, n_questions, taus, calibration_from | calibration_fit_on, split_half{taus_even, odd_raw, odd_with_even_taus_{kind,group,header}}, questions_<mode>{<group>: {n, acc, nll, brier, ece}}, decisions_<mode>{n, action_acc, diag_acc, modes{guard,heal}, by_trigger, by_case, by_style, by_budget, sweep, diag_confusion, false_fires_detail}, primitive_acc`. Each `modes.<m>` = `{false_intervention_rate, false_fires, passive_rows, precision, fires, recall, active_rows[, mean_cost{policy, always_passive, oracle, rows, harm_on_passive_rows}]}`.
8. Batch drivers: `run_evals.sh TAG M...` (stage 1, per model in parallel): `rt1` test with `rt1` dev fit → `out/cal/<M>.json`, then SIM sample (`data/simsample/test.jsonl`, how it was created from `sim/samples/sample.jsonl` is not scripted) with that calibration; `cur1` test with its own dev fit; `cur2` test raw. `eval_sim.sh NAME M...`: for every shard dir `data/NAME_t*` (test) and `data/NAME_d*` (dev) it runs `eval_runtime.py --records-dir out/records --batch 32 --threads $EVAL_THREADS` in parallel only to fill the logit cache, concatenates `out/records/<M>__NAME_t*__test.jsonl` → `<M>__NAME__test.jsonl` (same for dev), then one `eval_runtime.py --data data/NAME --split test --fit-split dev --write-calibration out/cal/<M>-NAME.json` reads the merged cache.
9. `training/report.py name=report.json ... [--mode=kind]` (default `kind`; falls back to `raw` when the report has no `decisions_<mode>`) prints the EVAL.md tables (main table, SIM cost table when `mean_cost` exists, per trigger, per budget, sweep, taus + split-half NLL/ECE).

### 7. Export (`training/export_runtime.py` → `main`)

1. `load_checkpoint(--ckpt, encoder="reference")`; calibration = `--calibration` file if given, else the checkpoint's (all 1.0 after training). `ExportModel(enc, heads)` and `plan_inputs`/`unpack` are imported from `scripts/genclass_export.py` (single source of the graph; same I/O as GenClass 0.1).
2. Parity requests: `--requests file` or `requests_from_rows(--data-rows, --n-per-file (40), max_tokens 1500)` (random rows per file, seed 0). Written to `requests.json`.
3. `torch.onnx.export` (opset `--opset` 17, `dynamo=False`, dynamic axes L/G/K/S/K2/M) of fp32 and a `.half()` copy into `--out/ref/` (`<name>-fp32.onnx`, `<name>-fp16-fullemb.onnx`).
4. `make_q8`: `gemm_to_matmul` (Gemm with transA=0, alpha=beta=1 → MatMul + Add, so the noul head's first layer is quantised too) → onnxruntime `MatMulNBitsQuantizer` (`DefaultWeightOnlyQuantConfig(block_size=--block 32, is_symmetric=True, bits=8, op_types_to_quantize=("MatMul",), quant_axes=(("MatMul", 0),))`) → `quantize_embedding(..., "float32")` → **fp16 check**: any FLOAT16 initializer or Cast-to-FLOAT16 raises `ValueError` → `onnx.checker` → `<name>-q8.onnx`.
5. `quantize_embedding`: finds the single Gather over a `[vocab, d]` initializer, replaces it with `Gather(int8 table) → Cast → Mul(Gather(per-row scale))`; symmetric per row, `scale = max|row| / 127` (zero rows get scale 1), `q = clip(rint(w/scale), -127, 127)`.
6. `make_fp16`: the fp16 graph + int8 embeddings with fp16 Cast/scale → `<name>-fp16.onnx`.
7. Parity on ORT CPU (fp32, fp16, q8; plus 1-thread sessions for q8/fp16) vs PyTorch `FastEngine(encoder="banded")` with the same calibration → `parity.json`; packer outputs → `pack_fixtures.json`; PyTorch logits/probs/header keys → `torch_fixtures.json`.
8. Model directory: `tokenizer.json` (copied from `ckpt/backbone`), `calibration.json`, `meta.json`, `model.json` (card). `ref/` is not part of the card and is excluded from delivery tars.

CLI defaults: `--name genclass-runtime`, `--version 0.1.0` (always pass both; the delivery convention is `genclass-runtime-r17` / `-r32`), `--requests` or `--data-rows` is required in practice (with neither, the request list is empty and `main` raises on `max(packs, ...)` before exporting; the requests also fix the dummy shapes used for tracing), `--n-per-file 40`, `--opset 17`, `--threads 16`, `--block 32`. The parity packer is `Packer(tok, max_len=8192)`. `meta.json` `merges_kept` is read from the checkpoint's `meta.vocab_pruned`, which only `prune_vocab.py prune_checkpoint` writes; trainer-written servables (`jev_local/engine/encoder/engine.py` → `write_checkpoint`, called by `jev_local/train/train.py` → `train`) do not carry it, so exports of trained models have `merges_kept: null`.

### 8. ortweb validation (`training/ortweb/validate.mjs`)

1. Install `onnxruntime-node` and `onnxruntime-web` 1.30.0 (`training/ortweb/package.json`) in a working dir; run `node validate.mjs <export dir> [q8|fp16] [maxRequests]`.
2. Builds feeds from `pack_fixtures.json` exactly like `plan_inputs` (dummy row when a kind has no question), runs onnxruntime-node CPU (4 and 1 threads) and onnxruntime-web WASM (`numThreads` 1 and 4; `wasmPaths` = the directory of the resolved `onnxruntime-web` entry file), compares raw (uncalibrated) logits with `torch_fixtures.json`.
3. Per backend: `missing_inputs` (`meta.json` `inputs` absent from the session), `max_abs_logit`, `argmax_agree/argmax_total` (questions with > 1 logit), `ms_p50/p90`, `tokens_p50`, `runtime_sized` (requests ≥ 400 tokens), and `est_ms_at_seq_tokens` at 500 / 780 / 1170 tokens (≈ 330 / 600 / 1,000-token states plus the standing questions) from a least-squares fit `ms ≈ a + bL + cL²`. Writes `<dir>/ortweb_report_<variant>.json` (`{dir, variant, file, bytes, results[]}`).
4. It has no pass/fail: a backend error is caught and recorded as `{backend, error}` (the process still exits 0; only unreadable `model.json`/fixtures crash it). There are no thresholds; read `max_abs_logit`, `argmax_agree` and `error` yourself (the delivery scripts print them).

## Configuration and constants

| Name | Type | Value / default | Defined in | Effect |
|---|---|---|---|---|
| merges kept | int | 16,000 (`--merges`, required) | `prune_vocab.py` CLI; decision in LOG | vocab 16,364; markers 16359–16363 |
| `analyze --merges` / `--limit-rows` | csv / int | `8000,12000,16000,24000,32000` / 2000 | `prune_vocab.py` → `main` | merge counts compared; jsonl rows read per file |
| `CONFIG_ID_KEYS` | tuple | pad/bos/eos/cls/sep/mask/unk/decoder_start `_token_id` | `prune_vocab.py` | `config.json` ids remapped on prune |
| `--workers` | int | `os.cpu_count() or 8` | `generate.py` | parallelism only (output independent of it) |
| `KINDS` | weights | decision .58, ask .14, json .10, http .08, js .04, decide .06 | `curriculum/generate.py` | row kind mix |
| `TRIGGERS` | weights | mutation .26, request .20, failure .18, stall .12, inconsistency .09, transition .08, error .07 | `curriculum/generate.py` | trigger mix of decision/ask rows |
| `--n` / `--dev` / `--test` | int | 600,000 / max(2000, n // 50) / max(4000, n // 25) (= 12,000 / 24,000 at the default n) | `generate.py` → `main` | split sizes |
| `--chunk` | int | 5000 | `generate.py` | RNG stream unit (changing it changes rows) |
| `--p-runtime` | float | 0.0 | `training/curriculum/generate.py` → `main` | probability that a decision row is rendered runtime-exact (`training/curriculum/rows.py` → `decision_row`: `p_runtime > 0 and rng.random() < p_runtime` → `rt.render`; if `rt.render` returns None (scenario without `spec`, or `spec.no_runtime`) the row falls back to varied style, so the realised share is <= p_runtime). Omitted = 0.0 = no runtime-exact rows. `main()` writes `os.environ["GC_P_RUNTIME"] = str(args.p_runtime)` and sets the global `P_RUNTIME` before the worker pool starts, so a `GC_P_RUNTIME` exported in the shell is overwritten by the CLI value; always pass `--p-runtime` explicitly. |
| `GC_P_RUNTIME` | env float | `"0"` | `generate.py` module level (`P_RUNTIME = float(os.environ.get("GC_P_RUNTIME", "0"))`) | read only when `generate` is imported without `main()` (e.g. `training/tests/test_curriculum.py` → `make_row`); `main()` overrides it from `--p-runtime` |
| `GC_RT_BUDGET` | env int | unset | `rt.py` → `render` | force one budget (analysis) |
| `Style.make(canonical=)` | float | 0.55 | `fmt.py` | share of canonical-style rows |
| `held_count` | fn | max(1, round(0.2 n)) if n ≥ 4 else 0 | `fmt.py` | held-out template tail |
| `TEST_DOMAINS` | set | 13 of 62 | `vocab.py` | test-only domains (test asserts 15–30%) |
| `STATE_CHAR_BUDGET` | int | 3200 | `rt.py` (= `serialize.ts`) | full-size situation |
| `COMPACT_BUDGET`, `MIN_BUDGET` | int | 1100, 500 | `rt.py` (= `serialize.ts`) | section-limit interpolation floor; smallest budget |
| `COMPACT_QUESTIONS_MAX` | int | 1400 | `rt.py` (= `questions.ts` `COMPACT_QUESTIONS_BUDGET`) | bare-label standing questions at ≤ this budget |
| `BUDGETS` | (chars, weight) | (3200, .35), (2000, .30), (1000, .35) | `rt.py` | budget draw; mirrors runtime "auto" budgets (WASM 1 thread 1000 … 4 threads 2000; else 3200: `packages/runtime/src/runtime.ts` → `situationBudget`) |
| `LIMITS` | dict | facts 12, in_flight 6, timeline 16, state 8, stats 4 | `rt.py` | full-budget section sizes |
| `section_limits` | fn | facts 6→12, in_flight 2→6, timeline 3→16, state 3→8, stats 1→4; line caps app 60→120, trigger 180→240, facts 220→260, in_flight 90→120, timeline 100→140, state 100→150, stats 110→140 | `rt.py` | linear in budget between 1100 and 3200 |
| `WINDOW` | ms | 10,000 | `rt.py` (= `facts.ts`) | "in the last 10s" windows |
| mixture `max_repeat` default | float | 2.0 | `jev_local/train/stream.py` → `MixConfig` | per-pass repeat cap per group |
| `OTHER_BUCKET_WEIGHT` | float | 0.04 | `stream.py` | weight of buckets not named in `bucket_weights` |
| `mix_s1.json` | mixture | cur1 .90, gen .04, cu .06; `pass_tokens` 420M; max_repeat `*` 2.0, cur1 1.5 | `configs/` | stage 1 (realised pass 406M: cur1 93.1%, cu 6.2%, gen 0.7%) |
| `mix_s1b.json` | mixture | cur2 .75, cur1 .15, gen .04, cu .06; 250M; cur2 1.2 | `configs/` | not referenced by LOG/scripts (unused, unverified) |
| `mix_s1c.json` | mixture | cur2 .55, cur1 .37, gen .03, cu .05; 520M; cur2 1.5, cur1 1.0 | `configs/` | stage 1c |
| `mix_s2.json` | mixture | sim1 .76, cur3 .12, cur2 .05, cur1 .03, gen .01, cu .03; 420M; sim1 1.5 | `configs/` | stage-2 pilot |
| `mix_final1.json` | mixture | simA .85, cur4 .12, cur1 .02, gen .01; `buckets` = those 4; 500M; `*` 2.0, simA 1.3 | `configs/` | final round 1 |
| `--max-len` | int | trainer default 1536; 1536 in stage 1c (s1 command unrecorded); 2048 stage 2/final (SIM packed p95 1,523, max 1,761) | `jev_local/train/train.py`, README, launch scripts | written to servable/exported `meta.json` `max_len` |
| `--batch-tokens` | int | 8192 | launch scripts | micro-batch token budget |
| `--ckpt-every` | int | trainer default 500; launch scripts pass 50 | `jev_local/train/train.py` | checkpoint cadence (a SIGKILL loses at most this many steps) |
| `MAX_TRAIN_LEN` | int | 8192 | `jev_local/train/train.py` | upper bound for `--max-len` |
| `--seed` | int | s1c 1, s2 2, final1 3 | launch scripts | mixture/shuffle seed |
| `DEFAULT_CALIBRATION` | dict | `{noul: 1.0, choice: 1.0, score: 1.0, by_header: {}}` | `jev_local/engine/encoder/calibrate.py` | what every trainer-written servable ships |
| `node.sh` remote env | env | `PYTHONPATH=$HOME/jev:$HOME/gcl-train/training`, `PY=$HOME/jev/.venv/bin/python`, `HF_HUB_OFFLINE=1`, `TOKENIZERS_PARALLELISM=false`, cwd `~/gcl-train` | `node.sh` | environment of `node.sh HOST 'cmd'` (also set by `eval_sim.sh`, `run_evals.sh`, `final_post.sh`) |
| torchrun master port | int | 29500 | `scripts/launch_run.sh` | DDP rendezvous |
| `TIER` | dict | passive: apply/send/deliver/wait/ignore; guard: discard/defer/coalesce/delay; heal: block/serve_cached/retry/hedge/rollback/resync | `eval_runtime.py` and `fmt.py` (duplicated) | gate tiers (= runtime `BUILTIN_ACTIONS`) |
| `THRESH` | dict | guard 0.9, heal 0.8 | `eval_runtime.py` | gate thresholds (= CONTRACT §8 defaults) |
| `N_BINS` | int | 15 | `eval_runtime.py` | ECE bins |
| τ search range | float | [0.2, 5.0] | `eval_runtime.py` → `fit_tau`, `fit_tau_noul` | temperature fit |
| `by_header` min records | int | 300 | `eval_runtime.py` → `fit_calibration` | per-header τ only when well populated |
| eval `--batch` / `--threads` | int | 16 / 32 | `eval_runtime.py` | collection speed (scripts use 32 / 6–12) |
| `EVAL_THREADS` | env int | 6 | `eval_sim.sh` | threads per shard job (`final_post.sh` sets 12) |
| `CARD_FORMAT` | str | `genclass-runtime-model/1` | `export_runtime.py` | `model.json` `format` (same constant in `packages/runtime/src/model/loader.ts`, which records the field but does not reject other values) |
| `OUTPUTS` | list | `choice_logits`, `score_logits`, `noul_logits` | `export_runtime.py` | graph outputs |
| graph inputs | list | `input_ids, position_ids, q_group, i_group, choice_q, choice_items, score_q, score_items, noul_q, noul_t, noul_f` | `scripts/genclass_export.py` → `plan_inputs` | written to `meta.json` `inputs` |
| export `--opset` / `--threads` / `--block` / `--n-per-file` | int | 17 / 16 / 32 / 40 | `export_runtime.py` | ONNX opset; ORT threads; MatMulNBits block; parity rows per file |
| parity request cap | tokens | 1500 | `export_runtime.py` → `requests_from_rows` | longer rows skipped |
| `meta.json` `max_len` / `max_total` | int | ckpt meta `max_len` or 1536 / 8192 | `export_runtime.py` | runtime packer limits |
| ortweb versions | str | onnxruntime-node 1.30.0, onnxruntime-web 1.30.0 | `ortweb/package.json` | validation runtime |
| validate defaults | args | variant q8, 60 requests (delivery scripts pass 120) | `validate.mjs` | — |
| ports | int | 8798 (train VM → c01 one-off v1 tar), 8799 (c01 data bundles, 10.0.0.6), 8801 (node → c01/train VM tars), 8802 (train VM SIM dir, 10.0.0.4) | scripts, LOG | `python3 -m http.server` transfers on the private network |
| `TIMEOUT` | env s | 900 | `node.sh` | per-call ssh/scp timeout for `'cmd'`/`get`/`put` (`sync` uses fixed 120 s / 600 s timeouts; `scripts/azvm.sh` and therefore `scripts/launch_run.sh` ignore it) |

Model directory files (`export_runtime.py`):

| File | Content |
|---|---|
| `model.json` | `{format, name, version, license: "Apache-2.0", variants: {q8: {file, bytes, sha256, provider: "wasm"}, fp16: {file, bytes, sha256, provider: "webgpu", needs: "shader-f16"}}, files: {tokenizer, calibration, meta: {file, bytes, sha256}}}` |
| `meta.json` | `name` (`<name>-<version>`), `source_checkpoint`, `max_len`, `max_total`, `window`, `hidden_size`, `layer_types`, `markers` (from the tokenizer), `cls_id`, `sep_id`, `pad_id`, `vocab_size`, `merges_kept`, `inputs`, `outputs`, `embedding_quant` = `int8-rowwise-symmetric`, `matmul_quant` = `MatMulNBits-8bit-b32-symmetric (q8); fp16 weights (fp16)`, `license` |
| `calibration.json` | as passed (from `eval_runtime.py --write-calibration`: `noul`, `choice`, `score`, `by_header`, `_fit`) |
| `<name>-q8.onnx`, `<name>-fp16.onnx`, `tokenizer.json` | graphs and pruned tokenizer |
| `parity.json` | per variant: `max_abs_logit`, `max_abs_prob`, `argmax_rate`, `noul_side_rate`, `gate08_rate`, `gate09_rate`, `ort_cpu_ms_p50`, `ort_cpu_1thread_ms_p50`, `file_mb`; `n_requests`, `tokens{min,median,max}`, `embedding_q8` (incl. `fp16_free`, `matmulnbits`, `gemm_converted`, `matmul_unquantized_with_weight`, `fp32_initializer_mb`), `embedding_fp16` |
| `pack_fixtures.json`, `torch_fixtures.json`, `requests.json` | JS parity fixtures (also used by MODEL's TS packer/engine tests) |
| `ref/` | fp32 and fp16-full-embedding reference graphs (not shipped) |

## Invariants and gotchas

- **Runtime parity of `rt.py` is load-bearing.** Constants and wording (`DIAG_INSTR`, `DIAGNOSES`, `ACTIONS`, `ACTION_INSTR`, `TRIGGER_ACTIONS`, `RANK`, `LIMITS`, budgets, `secs`/`rel`/`ratio`/`fmt_num`, `signature`/`is_id`) must equal `packages/runtime/src/situation/{questions,serialize,facts,describe,build}.ts` and `src/util.ts`. They match at this commit (runtime situation code is unchanged since tag `situation-v1` = 1a77558; `rt.py` was re-ported after it). Per-header calibration keys are `sha1(instructions)[:12]`, so any instruction text change silently orphans `by_header` temperatures.
- **Known small parity gaps** in `rt.py`: `to_state`'s last-resort shortening truncates facts to max(40, …) and never shortens the trigger, while `toJevState` uses max(60, …) and then shortens the trigger; Python `round()` (banker's) vs JS `Math.round` in `secs` (≥ 1000 s) and `ratio` (≥ 10×); Python format specs (`f"{x:.2f}"`, half-even on exact binary ties) vs JS `toFixed` (ties up) in `secs`/`rel`/`fmt_num`, e.g. `secs(125)` is `0.12s` in Python and `0.13s` in JS; `truncate` counts code points (Python `len`) vs UTF-16 code units (JS `length`), so text with astral characters such as emoji is cut at different points. Rare, but they produce text the runtime never sends.
- **Numbers as JS prints them.** `fmt.js_numbers` turns integral floats into ints in `state` and `questions` (not in `labels`/`meta`); without it the model trains on `25.0`, which the JS runtime never emits (NEEDS item 8). Keep it when adding new emit paths.
- **Determinism** is per code version: `random.Random(f"{seed}:{split}:{chunk}")`, sorted iteration where sets are involved. Changing any generator code, `--chunk`, or `--p-runtime` from 0 to > 0 (it adds an RNG draw) changes the rows; `cur1`/`cur2` cannot be regenerated byte-identically from the current code (the generator gained `transient`, `coincidental`, budgets and compact questions since).
- **Held-out integrity:** test rows only use `TEST_DOMAINS` and may use held-out templates; train/dev never do. `test_curriculum.py` asserts both. Do not add a domain to `DOMAINS` without deciding its split.
- **Precision first:** decision rows must keep a large passive-best share (test bound 0.45–0.75); soft labels for ambiguous cases lean passive. SIM's passive-best shares are much higher (pre-freeze SIM sample: 70–96% per EVAL.md; phase A train: 64% stall to 99% error, `sim/samples/stats-final-a.json`, see [sim.md](sim.md)), which is why stage 2 is required.
- **Single-action rows** have no `action` question/label (runtime behaviour). `eval_runtime.py` skips them in `decision_metrics`, so `diag_acc` there covers only rows that also have an `action` question.
- **Calibration must be shipped explicitly.** A trained servable's `calibration.json` is all 1.0; `export_runtime.py` without `--calibration` ships uncalibrated temperatures. The runtime gate thresholds assume calibrated probabilities.
- **Stale logit cache:** `eval_runtime.py --records-dir` reuses `<ckpt.name>__<data.name>__<split>.jsonl` if present, even after the checkpoint changed. Delete `out/records/<M>__*` before re-evaluating a retrained model with the same name. `eval_sim.sh` concatenates shard records by this naming.
- **q8 must be fp16-free.** Onnxruntime's WebGPU Gather on an fp16 table requires `shader-f16` ("Program Gather requires f16"); the int8 table + fp32 row scales runs on WebGPU without it (MODEL confirmed in Chromium/SwiftShader). `make_q8` raises on any fp16 tensor or cast; keep the `gemm_to_matmul` rewrite (without it the noul head stays fp32, +2.9 MB).
- **Rank 0 holds the init.** Only rank 0 reads `--resume` state or `--init-from`; the first node in the launcher list must have `runs/<model>-s1c/ckpt` (c02 for R32, c09 for R17). `--resume` wins over `--init-from` when `runs/<run>/ckpt/trainer.json` exists, so reusing a run name resumes instead of re-initialising.
- **Mixture buckets are directory names.** Put shards in `<stream root>/<bucket>/`. Without a `buckets` list, any extra bucket dir under a stream root silently gets weight 0.04 (`OTHER_BUCKET_WEIGHT`); `mix_final1.json` is the only config that lists `buckets`.
- **Marker ids moved.** With the pruned vocab, `[Q] [O] [L] [T] [F]` are 16359–16363; runtime, sim tooling and tests must read them from `tokenizer.json` / `meta.json` (CONTRACT §10). With 16k merges, keys like `trigger`, `facts`, `apply`, `defer` split into several tokens (harmless; trained on the pruned tokenizer).
- **Token budget vs characters:** the runtime's 3200-char budget assumes ≈ 3.2 chars/token, measured ≈ 2.4 (NEEDS 6a), so situations are ≈ 1.3–1.4× the intended 1,000 tokens; 3.9% of SIM `r300k` packed rows exceed 1,536 tokens, hence `max_len` 2048 for stage 2 (LOG). The smaller 1,000/2,000-char WASM budgets were adopted for latency (LOG 19:00 coordinator/MODEL note).
- **Script path layout:** `node.sh`, `import_*.sh`, `deliver_final.sh`, `launch_*.sh` resolve `JEV="$HERE/../.."` (or `cd "$(dirname "$0")/../.."`) and expect `jev_local/`, `scripts/launch_run.sh`, `scripts/azvm.sh`, `pyproject.toml` there. In this monorepo they are at the repo root (`$HERE/..`), so run them from a checkout nested inside a jev tree or adjust the path (unverified). `~/.jev-local/azure_hosts` columns: name, public IP ($2, used for ssh), private IP ($3); key `~/.ssh/jev_azure`, user `azureuser`. Mac-side scripts use GNU `timeout`. Only the Mac-side `.sh` files are committed executable (git mode 100755); `run_evals.sh`, `eval_sim.sh` and all `.py` files are 100644, so invoke them via `bash` / `$PY`.
- **Python import paths:** `export_runtime.py`, `eval_runtime.py`, `generate.py`, `prune_vocab.py analyze` and the tests insert `~/jev` (and `~/jev/scripts`) into `sys.path`; elsewhere set `PYTHONPATH=<repo>:<repo>/scripts:<repo>/training`.
- **`azvm.sh` ignores `TIMEOUT`** (only `node.sh` honours it), so `TIMEOUT=... scripts/azvm.sh` lines in `import_sim.sh`/`deliver_final.sh` and `TIMEOUT=300 scripts/launch_run.sh` in `launch_*.sh` have no timeout. `import_final.sh` deliberately has no `pkill` (a self-killing `pkill` was a past bug: the remote shell's command line matched the pattern); stop the train VM's :8802 server with `pkill -f "http.server 880[2]"` in a command that does not itself contain `http.server 8802`. `import_sim.sh`'s first remote command still has the old pattern (its `pkill` runs only when :8802 is already listening, and the same command line later contains `http.server 8802 --bind`, so it can kill its own shell); stop any running server first or reuse `import_final.sh`'s logic.
- **`pull_on_train.sh` expects `validate.mjs` already in `~/gcl/train-out/ortweb`** (it does not copy it; `deliver_final.sh` does).
- **Bug (curriculum):** `standalone.json_invariants` writes the `count` invariant check as `j_count` and then overwrites `questions["j_count"]`/`labels["j_count"]` with the "price above threshold" score question, so the count==len check never reaches the data. Rows stay valid.
- **Tests do not exercise `rt.py` by default.** `generate.make_row` reads the module global `P_RUNTIME` (from `GC_P_RUNTIME`, default 0), and `test_curriculum.py` calls `make_row` directly, so runtime-exact rendering is only tested with `GC_P_RUNTIME=1` in the environment. Run it both ways after touching `rt.py`. Setting `GC_P_RUNTIME` has no effect on a `generate.py` CLI run; there, `--p-runtime` wins.
- **`rt1` and `cur2` predate the freeze.** They were rendered by the first `rt.py` port (3,200-char budget, pre-`situation-v1` fact wording, no `transient`, no compact questions), so the stage-1c `rt1` numbers measure the old runtime format. Only `cur4` (and SIM `final-a`) use the frozen wording. Regenerating `rt1` with today's code gives a different set.
- **Runtime budgets between the drawn ones.** The runtime's auto budget is `1000 + round((threads - 1) * 1000 / 3)` on WASM (1,000 / 1,333 / 1,667 / 2,000 for 1–4 threads), else 3,200, and either is multiplied by `budgetScale` (starts at 1; × 0.8 per `max_tokens_exceeded` model error, floor 0.5); a numeric `budget` option overrides all of it (`packages/runtime/src/runtime.ts` → `situationBudget`). `rt.BUDGETS` only draws 1,000 / 2,000 / 3,200; intermediate budgets rely on `section_limits` interpolation generalising.
- **Missing mixture buckets are silent.** `stream.py` renormalises weights over the buckets it finds, so a typo in a bucket dir or a forgotten `cur4` shard dir trains on a different mix without an error. Check the plan before or at launch: `python -m jev_local.train.stream <roots...> --mixture <mix.json>` prints it, and the trainer writes `$G/runs/<run>/mixture_plan.json` (corpus summary + pass-0 plan; LOG's "cur1 93.1%, cu 6.2%, gen 0.7%" for `mix_s1` is this kind of realised share).
- **`merges_kept: null` in exported `meta.json`** for every trainer-written checkpoint (see Export). Nothing reads it today; `vocab_size` and `markers` are always set.
- **Dead code in `rt.py`:** `LINE` (superseded by `section_limits`' line caps) and `err_rate` (EWMA emulation, superseded by `failure_counts`) are unused; edit `section_limits` / `failure_counts` instead.
- **Past bugs recorded in LOG:** typeahead requests could start out of keystroke order (fixed with a per-app debounce in `mut_typeahead`); noul head Gemm left fp32 (fixed by `gemm_to_matmul`); Python float literals in rows (fixed by `js_numbers`).
- **Licensing hygiene:** no TRAIN script reads `jev-local-fast-v2`, `meharsjev-68m-z`, `z-cal-*`, `z-mid*` or any benchmark/third-party dataset (verified by grep at this commit). Keep it that way; the model card claims Apache-2.0 synthetic-only data.

## How to change it safely

**Reproduce the pipeline** (Azure only; commands run in `~/gcl-train` via `node.sh HOST '...'`, `$PY` and `G` as above):
1. Prune (c01): `$PY training/prune_vocab.py prune --src ~/jev/models/jev-local-fast --out models/r32-v16k --merges 16000` and `... --src ~/jev/models/base/ettin-encoder-17m --out models/base/ettin-17m-v16k --merges 16000`. Optional: `prune_vocab.py analyze --src ~/jev/models/jev-local-fast --group runtime=training/samples/runtime_samples.txt --group gen=<v1 gen jsonl> --out out/inflation.json`.
2. Generate (c01): `cur1` = `generate.py --out ~/gcl-train/data/cur1 --n 800000 --dev 6000 --test 12000 --seed 1 --workers 72`; `cur2` seed 2 `--p-runtime 0.6` (400k train); `cur3` seed 4 / `cur4` seed 5, `--p-runtime 0.8` (300k each). `rt1` used `--p-runtime 1.0` with 6k dev / 12k test (exact command unrecorded). Today's code reproduces none of these byte for byte (see Determinism).
3. Shard each train split into its stream root: `split -n l/64 -d -a 2 --additional-suffix=.jsonl data/<set>/train.jsonl data/<root>/<set>/shard` (roots in Concepts).
4. Stage 1 (`r*-s1`, exact command not in the repo) then stage 1c: the `launch_run.sh r32-s1c ...` / `r17-s1c ...` commands in `training/README.md` §3.
5. Stage 2 / final: `import_sim.sh` + `launch_s2.sh`, or `import_final.sh` + distribute the tar + `launch_final1.sh P32 P17`.
6. Copy servables to c01 if needed (`pull_ckpt.sh <M> <node>`), evaluate (`run_evals.sh` for curriculum sets, `eval_sim.sh <NAME>e <M>` for SIM), tabulate with `report.py`.
7. Export with the fitted calibration, validate with `ortweb/validate.mjs`, deliver with `pull_on_train.sh` / `deliver_final.sh` (or `final_post.sh` on the rank-0 node for the automated tail).

**Regenerate a curriculum set** (on c01, after `node.sh c01 sync`):
```
$PY training/curriculum/generate.py --out ~/gcl-train/data/cur5 --n 300000 --seed 6 --workers 72 --p-runtime 0.8
```
Then shard train (`split -n l/64 -d -a 2 --additional-suffix=.jsonl train.jsonl <root>/<bucket>/shard`) under a stream root, add the bucket to a mixture, and check `stats.json` (`bad`, `errors` = 0; `passive_best_fraction` sane). Use a new seed and bucket name; never overwrite a set a run is training on.

**Mirror a runtime situation/question wording change** (CORE changed `packages/runtime/src/situation/*`):
1. Diff the runtime files since the last port and update the matching `rt.py` function (`*_facts`, `subject_sentence`, `event_lines`, `state_lines`, `stats_lines`, `to_state`/`section_limits`, constants).
2. If an instruction or description changed, also update `fmt.py` canonical first entries (`ACTION_DESC[a][0]`, `DIAG_DESC[d][0]`) and expect `by_header` calibration to be re-fitted.
3. Render a few rows at each budget and compare with SIM rows (`sim/samples/sample.jsonl`) for the same situations.
4. Regenerate the replay set (`cur*` with `--p-runtime 0.8`), retrain, re-evaluate. Coordinate a new freeze tag with the lead (SIM data must match). Run `test_curriculum.py`.

**Add a scenario case:** add it to the builder's `rng.choices` list in `scenarios.py`/`scen_ops.py`/`scen_state.py`, build the `Trace`, facts (via `fmt.pick` templates with ≥ 4 phrasings so one is held out), labels (soft dist leaning passive when ambiguous), primitives (`prims.*`) and a `spec` that `rt.py` can render (or `no_runtime: True`). Keep the passive-best share within 0.45–0.75 and run `test_curriculum.py` (validity, determinism, label consistency, version semantics).

**Add a diagnosis label or a built-in action:** it must exist in the runtime first (`questions.ts` `DEFAULT_DIAGNOSES` / `BUILTIN_ACTIONS` / `TRIGGER_ACTIONS`). Then update `fmt.DIAG_DESC` (canonical first) or `fmt.ACTION_DESC`, `fmt.TRIGGER_ACTIONS`, `fmt.TIER`, `rows.RENAMES` (optional), `rt.DIAGNOSES`/`rt.ACTIONS`/`rt.TRIGGER_ACTIONS`, and `eval_runtime.TIER`/`PASSIVE` (unknown actions default to heal tier in eval). Add scenarios that use it.

**Change a mixture / launch a new round:** copy a `configs/mix_*.json` (keys must be `MixConfig` fields; list `buckets` explicitly), copy `launch_final1.sh` with a new run name, `--stream-cache`, `--out`, `--seed`, and keep rank 0 = the node holding `--init-from`. Use 8 ranks × 10 threads per F80 node. Make sure every bucket named in the mixture has train shards under one of the `--stream` roots (check `mixture_plan.json`). Watch `~/jev/runs/<run>/rank0.out` and `$G/runs/<run>/log.jsonl` on the rank-0 node; deallocate idle nodes.

**Evaluate a checkpoint and fit calibration:**
```
$PY training/eval_runtime.py --ckpt models/M --data data/rt1 --split test --fit-split dev \
    --records-dir out/records --out out/eval/M-rt1.json --write-calibration out/cal/M.json
bash training/eval_sim.sh simAe M             # SIM: sharded logits, dev-fitted temperatures
$PY training/report.py M=out/eval/M-rt1.json --mode=kind
```
Clear `out/records/M__*` first if `models/M` was retrained.

**Export and validate:**
```
$PY training/export_runtime.py --ckpt models/M --out out/export-M --name genclass-runtime-r17 --version X.Y.Z \
    --calibration out/cal/M-simAe.json --data-rows data/simAe/dev.jsonl,data/cur4/dev.jsonl --n-per-file 60
node validate.mjs out/export-M q8 120          # in a dir with training/ortweb/package.json installed
```
Check `parity.json` (q8 argmax agreement, `embedding_q8.fp16_free: true`, q8 size ≤ 25 MB per CONTRACT §10) and `ortweb_report_q8.json`. Run `test_export_runtime.py` after touching graph surgery.

**Change the vocabulary size:** rerun `prune_vocab.py analyze` on `samples/runtime_samples.txt` and SIM rows, prune both bases, rerun `test_prune_vocab.py`, retrain from the pruned bases (embedding rows change), and tell MODEL (marker ids and model size change; the runtime reads them from files).

**Change gate semantics or thresholds in eval:** keep `eval_runtime.py` → `decision_metrics` in sync with `packages/runtime/src/decide/policy.ts` → `gate` and CONTRACT §8; update EVAL.md's "Runtime gate" definition and recompute reports from cached records (`--records-dir` makes this cheap).

## Tests

All tests run on a VM (`cd ~/gcl-train && PYTHONPATH=~/jev[:~/gcl-train/training] ~/jev/.venv/bin/python -m pytest -q training/tests/<file>`); none run in the npm/vitest suites.

| Test file | What it asserts |
|---|---|
| `training/tests/test_curriculum.py` (5 tests) | `test_all_rows_valid_and_deterministic`: 400 train rows from the same seed have identical `state` across two runs (only `state` is compared) and all pass `_validate`; `test_test_split_uses_only_heldout_domains`: train never / test always in `TEST_DOMAINS`, held-out share 15–30%; `test_heldout_templates_never_in_train_picks`; `test_decision_labels_consistent`: action label/dist ⊆ offered criteria, dist sums to 1, diagnosis gold offered, passive offered, passive-best share 0.45–0.75, no `action` label when not asked; `test_stale_vs_benign_versions_semantics`: `v_newer` true for `typeahead|detail/stale`, false for `fresh`, `older_between`, `same_root`, `moved_inflight` |
| `training/tests/test_prune_vocab.py` (6 tests; need `GC_V1_CKPT`, `GC_BASE_32M`) | ettin layout (243 base ids 2–244, merges from 245); pruned tokenizer at 4k/8k/16k encodes random unicode/control text, ids in range, decodes to the same text, never fewer tokens, ids < 245+N unchanged, specials/markers kept and special, markers in user text not matched; logits identical (< 1e-4) to the unpruned v1 model when tokenisation is unchanged (`vocab_new` = 245+N+119); HF-base prune → `init_model` appends markers at V..V+4 and runs a forward pass |
| `training/tests/test_export_runtime.py` (3 tests; e2e needs `GC_R17_INIT`, default `~/gcl-train/models/r17-v16k-init`) | int8 embedding error ≤ scale/2 and zero rows survive; Gemm→MatMul+Add preserves outputs; end-to-end export: card format, bytes/sha256 of every file, `meta.markers`/`cls_id`/`sep_id` match `tokenizer.json`, parity fp32 < 1e-3, q8/fp16 < 0.5 (random heads), R17 q8 < 12 MB |

Last recorded runs (LOG): `test_prune_vocab.py` 6/6, `test_curriculum.py` 5/5 on c01. No run of `test_export_runtime.py` is recorded.

Test inputs and skips: `test_curriculum.py` needs `~/jev` on `sys.path` (it imports `jev_local` for `_validate`) and covers only the varied style unless `GC_P_RUNTIME` is set (see Gotchas). `test_prune_vocab.py`: `GC_V1_CKPT` (default `~/jev/models/jev-local-fast`; 5 tests skip without `backbone/tokenizer.json`) and `GC_BASE_32M` (default `~/jev/models/base/ettin-encoder-32m`; the HF-base test prunes it to 8,000 merges and skips without it). `test_export_runtime.py`: the two graph-surgery tests are self-contained (tiny ONNX graphs); the end-to-end test skips unless `GC_R17_INIT/backbone` exists and runs `export_runtime.py` as a subprocess on 6 hand-written requests.

## Drift and open issues

Results and status (from EVAL.md / LOG.md; held-out data, temperatures fitted on the matching dev split):

| Set | Model | Action / diagnosis acc | Guard FIR | Heal FIR | Heal precision (fires) / recall | Notes |
|---|---|---|---|---|---|---|
| `rt1/test` | GenClass 0.1 baseline (zero-shot) | 37.6 / 8.0 | — | 0.0–0.33% | 39% | pruned v1: 37.6 / 43.5 |
| `rt1/test` | R32-s1c | 98.2 / 98.4 | 0.00% (0/3,355) | 0.00% | 100.0 (2,777) / 86.0 | ECE 0.050 / 0.017; mutation hardest (94.1 / 94.4) |
| `rt1/test` | R17-s1c | 98.0 / 98.3 | 0.00% | 0.00% | 100.0 (2,774) / 85.9 | ECE 0.048 / 0.017 |
| `cur1/test` | R32-s1c | 95.8 / 97.8 | 0.00% | 0.60% (23/3,830) | 98.6 (2,544) / 80.2 | |
| `cur1/test` | R17-s1c | 94.0 / 97.2 | 0.03% | 1.70% (65/3,830) | 96.1 (2,510) / 77.1 | stall heal FIR 11.5% (R32 4.5%) |
| SIM sample (123) | R32-s1c / R17-s1c | 51.2 / 49.6; 48.0 / 43.9 | 13.6%; 9.7% | 34.0%; 18.4% | 19.1%; 22.2% | stage 1 does not transfer to SIM labels |
| SIM `r300k` test (20k) | R32-s2-pilot | 77.5 / 90.8 | 0.02% | 0.06% (6/10,234) | 75.5 (49) / 1.3% | cost policy 33.99 vs passive 34.03 vs oracle 32.88 |
| SIM `r300k` test (20k) | R17-s2-pilot | 78.3 / 91.1 | 0.00% | 0.08% (8/10,234) | 65.5 (58) / 1.4% | cost 33.97 / 34.03 / 32.88 |
| SIM phase A | R32/R17-final1 | — | — | — | — | launched 00:06 UTC 2026-10-08, ETA ≈ 01:30; no results in repo |

Size/latency (stage 1c exports): R17 q8 **9.58 MB** / fp16 13.57 MB, WASM 1-thread 188 / 339 / 608 ms at 500 / 780 / 1,170 tokens, ORT CPU 1-thread 39 / 71 / 132 ms; R32 q8 22.47 / fp16 34.79 MB, 499 / 879 / 1,539 ms, 93 / 163 / 289 ms. q8 vs PyTorch agreement (argmax / gate@0.8 / gate@0.9): R17 99.5 / 99.4 / 98.8%, R32 100 / 97.0 / 99.4%. Calibration: τ choice 0.71, score 0.59–0.66, noul 0.85–1.0. Cost to 23:05 UTC ≈ $215.

More numbers from EVAL.md / LOG (same sources):
- `rt1/test` guard mode: precision 100.0% (1,398 fires), recall 88.5% for both models; all-question accuracy R32 96.3%, R17 96.1%; no false fire at sweep t ≥ 0.6 (R32 has 8 at t = 0.5). Split-half on `rt1` dev: NLL 0.078 → 0.070, ECE 0.025 → 0.011.
- `cur1/test` guard precision R32 99.3%, R17 98.3%; ECE action/diag R32 0.024 / 0.016, R17 0.035 / 0.018. `cur2/test` (raw temperatures): R32 96.9 / 97.9, heal FIR 0.14%; R17 96.1 / 97.8, heal FIR 0.81%.
- SIM sample mean cost (heal policy / always passive / oracle): R32-s1c 23.26 / 23.61 / 22.36, R17-s1c 23.24 / 23.61 / 22.36.
- Stage-2 pilot: guard fires 2 (R32) / 4 (R17); ECE action/diag 0.24 / 0.012 and 0.26 / 0.017; per trigger action/diag ≈ error 94.5 / 93, failure 71 / 85, inconsistency 85 / 97, mutation 84–86 / 90, request 72 / 95, stall 64–68 / 87–89, transition 83–85 / 89–90; heal sweep: at 0.8 130 / 173 fires with 70% / 66% precision, at 0.9 21 / 27 fires with 81% / 93%. Gated policy saves ≈ 0.05 of the 1.15 cost units available per decision. Pre-freeze SIM action labels were soft (≈ temperature 2 over costs), hence the low recall.
- Packed sequence length by state budget (pruned tokenizer, ≈ 2.4–2.5 chars/token): 1,000–1,100 chars ≈ 600 tokens, 2,000 ≈ 1,000, 3,200 → SIM `r300k` mean 1,108 / p95 1,523 / max 1,761; standing questions add ≈ 185 tokens. At ≈ 600 tokens R17 decides in ≈ 0.25 s and R32 in ≈ 0.65 s (WASM, 1 thread). MODEL measured R32 at 780 tokens in Chromium at 837–940 ms, and ≈ 3× faster with 4 threads in a crossOriginIsolated page (Node shows no speed-up).
- Final round 1 sizes: SIM `final-a` train 448,420 / dev 14,613 / test 137,643; `r32-final1` 2.4 passes × 498M tokens on 48 ranks, `r17-final1` 3.0 passes on 32 ranks, ETA ≈ 01:28–01:30 UTC; c01 deallocated 00:12.

NEEDS items not listed below: 2 (row format) and 3 (meta) DONE on `sim/samples/sample.jsonl`; 6 DONE (card format `genclass-runtime-model/1`, `meta.json` fields); 7 answered by MODEL: the int8-embedding q8 runs under onnxruntime-web 1.30 WebGPU on an adapter without shader-f16, while the v0.1 q8 with an fp16 table fails with "Program Gather requires f16"; MODEL's TS packer reproduces `export-r32-v1pruned/parity.json` (q8 450/454 decisions, fp16 453/454; 89/90 requests pack bit-exactly); 9 INFO: `genclass-runtime info <dir>` enforces "any fp16 tensor → `needs: shader-f16`"; 10 INFO: MODEL's single-thread WASM latency R17 177 / 245 / 360 / 625 ms vs R32 458 / 601 / 908 / 1,647 ms at ≈ 300 / 400 / 600 / 1,000 state tokens.

Doc-vs-code drift:
- `training/README.md` §2 says diagnosis has "9 labels"; code has 10 (`transient` added; `fmt.DIAG_DESC`, `rt.DIAGNOSES`).
- `training/README.md` §4 describes the old gate ("non-passive top action, p ≥ 0.9 / 0.8"); `eval_runtime.py` uses the summed-mass gate over permitted actions (EVAL.md is current). `packages/runtime-model/MODEL_CARD.md` has the same old gate wording, omits `transient`, and its status line ("stage 1c final") predates final round 1.
- `export_runtime.py` parity metrics `gate08`/`gate09` still use the single-max-probability gate, not the summed-mass gate.
- `training/README.md` §3 points at `/Users/meharkhanna/jev/scripts/launch_run.sh`; in this repo it is `scripts/launch_run.sh`, and the `.sh` scripts resolve jev code at `$HERE/../..` rather than the repo root.
- `prune_vocab.py` module docstring shows `analyze --texts a.jsonl b.txt`; the CLI takes `--group name=path1,path2`.
- `ortweb/validate.mjs` header says it writes `ortweb_report.json`; it writes `ortweb_report_<variant>.json`.
- `report.py` docstring shows `--mode kind|raw|group|header`; `main` only recognises `--mode=<mode>` (a bare `--mode kind` is parsed as a `name=path` argument and fails).
- `import_sim.sh` header says the bundle is "served on 10.0.0.6:8799"; the script only writes `~/xfer/s2_<NAME>.tar` and starts no server. `data/sim1e` (20k eval rows) is not produced by any script.
- `training/NEEDS.md` item 8 is still "ASK" but is implemented (`fmt.js_numbers`, LOG 23:05). Its "TRAIN status for the frozen data (23:10)" section ("still to mirror ... corrected fact wording"; "Ready to run: import_sim.sh → launch_s2.sh") is superseded by the 23:05–23:35 re-port and `import_final.sh` / `launch_final1.sh`.
- `eval_runtime.py` → `probs` docstring lists modes raw/kind/group; `header` also exists.
- CONTRACT §1 lists `training/` owner as LEAD; README says TRAIN.
- `pull_on_train.sh` and `deliver_final.sh` headers say they "verify bytes + sha256" / "sizes/hashes"; the inline Python only compares sha256 and prints the card's `bytes` value.
- `launch_final1.sh` header says "SIM phase A + 15% frozen-wording curriculum replay"; `mix_final1.json` replay is 15% in total but only `cur4` (0.12) has the frozen wording (`cur1` 0.02 is varied style, `gen` 0.01 is v1 data).
- `training/README.md` §1 says pruning keeps "all 119 added tokens (…, markers)"; that holds for a GenClass checkpoint (R32). An HF base (R17) has no markers yet: pruning keeps its 114 non-marker added tokens (vocab 16,359) and `init_model` appends the 5 markers (16,364).
- `training/README.md` §3 describes the stage-2 mixture as "≈ 80% SIM and ≈ 20% curriculum replay"; `configs/mix_s2.json` is sim1 0.76 + 0.24 replay (EVAL.md says 24%). README says 800k rows in "≈ 10 s"; LOG measured ≈ 8 s for 818k.
- Exported `meta.json` `merges_kept` is `null` for trained checkpoints (code reads `meta.vocab_pruned`, which only pruned-but-untrained checkpoints carry). No runtime code reads the field, so it is informational only; fix it in `export_runtime.py` (e.g. fall back to the tokenizer's merge count) if anything starts depending on it.
- `final_post.sh` header says it "writes out/eval/..., out/cal/..., out/export-<M>/ and touches out/.post-done-<M>"; it touches the marker even when eval or export failed (no `set -e`).
- `training/README.md` §2 says ask rows carry "2–5 primitive questions only" and decision rows "0–3"; runtime-exact decision rows draw 0–2 (`rows.decision_row`: `rng.choice((0, 0, 1, 2))`).
- `curriculum/rt.py` module docstring says "Scenario facts that CORE cannot compute are dropped; scenarios whose label would then be unjustifiable return None"; the only such scenario is `failure/offline` via `spec["no_runtime"]`.

Open items relevant to this scope:
- Final round 1 evaluation, calibration, export and delivery (OPEN_TASKS 3–4); EVAL.md "Final round 1" is empty. Round 2 on SIM phase A + B with longer schedules.
- Choose shipping models (OPEN_TASKS 5) and publish `@genclass/runtime-model@0.1.0` (OPEN_TASKS 8).
- NEEDS 1 (OPEN): stage 2 wants ≥ 1M SIM train rows; phase A gave 448k. NEEDS 4 (ASK): clean-run SIM rows (`meta.clean`) for a direct FIR on clean traffic. NEEDS 5 (ASK): keep instructions/descriptions stable. NEEDS 6a (ASK): budget with the real tokenizer (≈ 2.4 chars/token).
- Stage-2 pilot lesson: soft pre-freeze SIM action labels gave recall ≈ 1%; frozen SIM uses sharper uncertainty-based labels (≥ 0.95 on clear cases), which final round 1 trains on. Re-check q8 parity on trained models and consider MatMulNBits block 16 (+1.8 MB for R32) if gate agreement is low (LOG).
- Known risks (OPEN_TASKS): label noise from few sampled futures; thin `conflict` and `transition` classes.
- `standalone.json_invariants` `j_count` overwrite (see Gotchas).

## Related docs

- [glossary.md](glossary.md): shared term list (stage 1 / 1c / 2, final round 1 / 2, phase A / B, bucket, `COMPACT_BUDGET` vs `COMPACT_QUESTIONS_BUDGET`).
- [model-io-contract.md](model-io-contract.md): situation text → packed request → heads → calibrated answers (shared by runtime, sim and training).
- [sim.md](sim.md): the SIM generator that produces the rows for the stage-2 pilot (`r300k`) and the final rounds (phase A/B): `meta.costs`, `meta.budget`, splits.
- [runtime/learn-situation-triage.md](runtime/learn-situation-triage.md): the runtime situation code that `curriculum/rt.py` mirrors.
- [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md): the runtime gate and action tiers that `eval_runtime.py` reproduces.
- [runtime/model-host.md](runtime/model-host.md): how the exported model directory is loaded, verified and run (card format, `meta.json`, calibration lookup).
- [genclass-model-lineage.md](genclass-model-lineage.md): `jev_local/` (trainer, engine, packer) and GenClass 0.1 (the R32 init).
- [demos.md](demos.md): demo trials that will evaluate the trained model.
- [status-and-known-issues.md](status-and-known-issues.md), [runtime/build-test-release.md](runtime/build-test-release.md).
- Source docs: [../../training/README.md](../../training/README.md), [../../training/EVAL.md](../../training/EVAL.md), [../../training/LOG.md](../../training/LOG.md), [../../training/NEEDS.md](../../training/NEEDS.md), [../runtime/CONTRACT.md](../runtime/CONTRACT.md) (§8 gate, §10 model, §11 SIM), [../../packages/runtime-model/MODEL_CARD.md](../../packages/runtime-model/MODEL_CARD.md), [../../OPEN_TASKS.md](../../OPEN_TASKS.md).
