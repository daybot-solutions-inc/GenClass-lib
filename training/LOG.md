# TRAIN log (GenClass runtime model)

Dated entries: what ran, where, how long, results, cost. Times UTC. F80 node ≈ $5.46/h.

## 2026-10-07

### 13:00 T0 start
- Started `c01` (F80) as the TRAIN workbench (prune/export/generation/eval). `train` VM untouched except a
  one-off tar of `models/jev-local-fast`, `models/base/ettin-encoder-32m`, `data/{cu,gen}` served on the private
  network (10.0.0.4:8798) and pulled to c01.
- Downloaded `jhu-clsp/ettin-encoder-17m` (MIT, `pytorch_model.bin`) on c01 → `~/jev/models/base/ettin-encoder-17m`.
- Licensing hygiene: only v1 `models/jev-local-fast` (R32) and the ettin-17m base (R17) are used as inits. No v2/Z/S
  checkpoint is read by any TRAIN script.

### 13:15 Vocabulary pruning (`training/prune_vocab.py`)
- ettin/ModernBERT BPE layout verified: ids 2..244 = 243 base byte symbols, id 245+i = result of merge i (50,009
  merges), 119 added tokens at 50254.. (whitespace runs, specials, [unused*], markers). First-N-merges pruning is
  closed under composition (checked in code), keeps ids 0..244+N unchanged, moves added tokens to 245+N...
- Tests (c01): `training/tests/test_prune_vocab.py` 6/6 pass — every string encodes (random unicode/emoji/control
  bytes; decode(pruned) == decode(full)), ids in range, markers stay special and are never matched in text, logits
  identical (< 1e-4) to the unpruned v1 model on requests whose tokenisation is unchanged, HF-base prune →
  `init_model` adds markers and runs.
- Tokens-per-char inflation vs the full 50k vocab (`~/gcl-train/out/inflation.json`):

  | merges kept | runtime-like text | v1 gen | v1 cu |
  |---|---|---|---|
  | 4k | +32.8% | +39.9% | +35.8% |
  | 8k | +19.8% | +25.6% | +22.3% |
  | 12k | +14.9% | +18.4% | +16.1% |
  | **16k** | **+10.8%** | +12.3% | +10.9% |
  | 24k | +5.9% | +6.7% | +7.3% |
  | 32k | +2.8% | +3.7% | +5.4% |

- **Decision: N = 16,000 merges → vocab 16,364** (incl. markers). Estimated q8 sizes: R32 ≈ 22 MB, R17 ≈ 9.4 MB
  (12k would save 1.6 / 1.0 MB for 4% more tokens per request).
- Note for runtime/MODEL: with 16k merges the situation keys `trigger`, `facts` and action names like `apply`,
  `defer` (no leading space) split into several tokens; harmless (the model is trained on the pruned tokenizer),
  but marker ids are now 16359..16363 — read them from `tokenizer.json`/`meta.json`.
- Pruned checkpoints on c01: `~/gcl-train/models/r32-v16k` (v1, pruned), `~/gcl-train/models/base/ettin-17m-v16k`
  (HF base), `~/gcl-train/models/r17-v16k-init` (random heads, pipeline tests). R32 and R17 tokenizers are
  identical (model + added tokens).

### 13:30–14:45 Mac slept (session interrupted)
- c01 sat idle ≈ 75 min (≈ $7). Kept running afterwards because the export work resumed on it immediately; a
  `caffeinate -i -m` hold now runs on the Mac for the rest of the session.

### 17:30–17:50 Mac offline ≈ 3 h (network); resume
- c01 idle ≈ 4 h in total over both outages (≈ $22). Deallocated at 17:30, restarted 17:45 when the generator was
  ready. The delegated export sub-task produced nothing (interrupted twice); TRAIN wrote `export_runtime.py` itself.
- Rule adopted: every long job is launched detached on the nodes (`setsid nohup`), results go to disk, LOG.md is
  updated at each phase, idle nodes are deallocated.

### 17:50 Stage-1 curriculum (`training/curriculum/`)
- `generate.py --n 800000 --dev 6000 --test 12000 --seed 1 --workers 72` on c01: 818k rows in ≈ 8 s, 0 invalid,
  0 generator errors. 1.8 GB train jsonl, sharded into 64 files (the exact-layout cache is built per file; one
  1.8 GB file took minutes single-threaded, 64 shards take 24 s).
- Packed length with the pruned tokenizer: mean 482, p95 885, max 1,208 tokens; situation states ≤ 960 tokens.
- Passive-best share of decision rows (train): mutation 0.50, request 0.51, failure 0.54, stall 0.63,
  inconsistency 0.42, transition 0.70, error 0.66.
- Tests: `test_curriculum.py` 5/5 (one real bug caught: typeahead requests could start out of keystroke order,
  which made "older writer" cases inconsistent; fixed with a per-app debounce).

### 17:58 Stage-1 training launched (detached)
- Single-node pilot (c01, R17, 4 ranks × 20 threads): 68–70k tok/s.
- `r32-s1`: c02–c08 (7 × F80, 28 ranks), init v1 pruned, lr 1.5e-4 / heads 6e-4: ≈ 215k tok/s, 5 s/step.
- `r17-s1`: c09–c11 (3 × F80, 12 ranks), ettin-17m pruned + fresh heads, lr 3e-4 / heads 2e-3: ≈ 165–210k tok/s.
- Mixture pass = 406M tokens (cur1 93.1%, cu 6.2%, gen 0.7%), 2 passes. Loss at step 60/140: 0.28 / 0.27.

### 18:00–18:20 Export pipeline (`export_runtime.py`, `ortweb/validate.mjs`) on c01, using the v1-pruned R32
- q8 = 22.47 MB (≤ 25 MB) after rewriting the noul head's Gemm to MatMul (it was left fp32: 2.9 MB); fp16 = 34.8 MB.
- Parity vs PyTorch (90 requests, untrained-on-runtime model, so many near-ties): fp32 max |Δlogit| 3e-5; fp16 0.66,
  argmax 99.7%; q8 1.37, argmax 99.0%, gate agreement 98.8% @0.8 / 97.3% @0.9. Attribution: MatMulNBits b32 alone
  1.03 (b16 0.75), int8 embeddings alone 0.64 → re-check on the trained models, consider block 16 (+1.8 MB).
- onnxruntime-web 1.30.0 (WASM backend in Node 22) loads and runs the q8 file with outputs identical to ORT CPU;
  WASM p50 154 ms on these requests (p50 175 tokens) with 1 thread; numThreads=4 gives no speed-up in Node
  (no worker threads there); ORT-node CPU 34 ms (1 thread) / 18 ms (4 threads).

### 18:00–18:20 Runtime-exact rendering (`curriculum/rt.py`) and a restart into stage 1c
- CORE's situation code landed (`packages/runtime/src/situation/*`). `rt.py` ports its formats to the curriculum's
  world model: subject sentences, facts (provenance, versions with same-chain/other-writer logic, inputs moved,
  concurrency, repetition, outcomes, baselines, cache, method semantics, invariants, transitions, errors) with CORE's
  ordering, `#id` refs, `secs()`/`rel()` time formats, timeline `eventLine`s, in-flight/state/stats lines, the
  3,200-char budget, and the standing questions exactly (diagnosis first, "What is happening here?", canonical
  descriptions; action question only when ≥ 2 actions apply). Scenarios whose labels need facts CORE cannot produce
  (offline) are never rendered this way.
- `cur2` = 400k train rows (seed 2) with 60% of decision rows in the runtime-exact style; `rt1` = runtime-style-only
  dev (6k) / test (12k) sets for evaluation and calibration.
- The 4-rank × 20-thread layout left ranks waiting (R32 throughput fell 215k → 134k tok/s, 45% of each step in
  collectives): per-micro-batch Python overhead is a large share for these small models. A 1-node pilot with
  8 ranks × 10 threads gave 93–95k tok/s for R17 vs 68–70k with 4 × 20.
- Stopped `r32-s1` (step 190) and `r17-s1` (step 382) cleanly (checkpoints written), relaunched as `r32-s1c`
  (7 nodes × 8 ranks, grad-accum 3, lr 1.2e-4 / 5e-4) and `r17-s1c` (3 nodes × 8 ranks, grad-accum 2, lr 2.5e-4 /
  1.5e-3), both initialised from the stopped weights, 1 pass of `mix_s1c.json` (cur2 0.55, cur1 0.37, gen 0.03,
  cu 0.05; 520M tokens).
- Cost so far ≈ $120 (c01 since 13:00 incl. idle ≈ $45; 10 training nodes since 17:58 ≈ $75 including the 18:20 restart).

### 18:20–18:32 Baseline and SIM samples
- Baseline (GenClass 0.1, full vocab, zero-shot) on `rt1/test` (runtime-exact, 12k rows, held-out domains):
  action acc 37.6%, diagnosis acc 8.0%, heal-mode FIR 0.33% with 39% precision (it almost never clears the
  gate; when it does it is mostly wrong). The pruned v1 behaves the same (eval queued).
- SIM has 200 sample rows (`sim/samples/sample.jsonl`) in exactly the runtime format with cost-based soft labels:
  they validate `rt.py`'s port (same sentences) and serve as a tiny zero-shot check. SIM's passive-best shares
  are much higher than the curriculum's (request 0.88, mutation 0.83, failure 0.73) and its inconsistency triggers
  are mostly coincidental learned relations (e.g. `x.total_count ∈ y.results[*].version`, held at 3–6 points) with
  diagnosis `expected` — the curriculum's inconsistency cases are mostly meaningful relations (sums/counts), so the
  stage-1 prior there is more interventionist than SIM's; stage 2 must correct it (and the curriculum replay for
  stage 2 should add coincidental-relation cases).

### 18:41–19:02 SIM r300k arrives; stage 2 launched
- SIM run `~/gcl/sim/sim/out/r300k` on the train VM (gen.js, 599 s): train 224,051 / dev 7,426 / test 68,790 rows.
  Imported with `training/import_sim.sh` (c01: `data/sim1/{dev,test}.jsonl`, train sharded into `data/s2/sim1/`,
  64 shards), plus `data/sim1e/test.jsonl` = 20k random test rows for evaluation.
  Passive-best shares (train): mutation 0.86, inconsistency 0.86, failure 0.69, request 0.74, stall 0.61,
  error 0.96, transition 0.83. Packed length with the runtime tokenizer (dev): mean 1,108, p95 1,523, max 1,761
  tokens; 3.9% exceed 1,536 → stage 2 uses `--max-len 2048`. States run at 2.4 chars/token (NEEDS.md 6a).
- Coordinator/MODEL (19:00): latency is the binding constraint (32M ≈ 0.9 s / 600-token state single-thread WASM in
  Chromium), so R17 is strategically important; the runtime will shrink situations to 3,200 / 2,000 / 1,100 chars by
  device; q8 must be fp16-free. Actions: `rt.py` now renders runtime-style rows at all three budgets (40/35/25%);
  the stage-2 replay set `cur3` (300k rows, seed 4, 80% runtime-exact, incl. coincidental-invariant cases) was
  regenerated with them; the exporter refuses q8 graphs with any fp16 tensor/cast (int8 table + fp32 row scales);
  R17 gets 6 of the 10 nodes and 4 passes in stage 2.
- Stage 1c finished: `r32-s1c` 312 steps / 36 min (c02–c08), `r17-s1c` 1,092 steps / 39 min (c09–c11); no dropped
  questions, no bad labels. Checkpoints copied to c01 (`models/r{32,17}-s1c`), evals running there.
- Stage 2 (`training/launch_s2.sh`, `configs/mix_s2.json`: sim1 0.76, cur3 0.12, cur2 0.05, cur1 0.03, gen 0.01,
  cu 0.03; pass = 420M tokens; `--max-len 2048`):
  `r32-s2` c02–c05 (32 ranks), 1.5 passes, lr 1e-4 / 4e-4, ≈ 168k tok/s (ETA ≈ 20:02);
  `r17-s2` c09–c11 + c06–c08 (48 ranks), 4 passes, lr 2e-4 / 1e-3, ≈ 449k tok/s (ETA ≈ 20:05).
  Both initialised from the stage-1c weights; first-step loss 0.76 / 0.80 (SIM's soft labels and new situations).

### 19:00–20:49 Stage-1c evaluation, exports, stage-2 pilots finish; coordinator updates
- Eval gate switched to CONTRACT §8 as revised (summed calibrated probability of the permitted non-passive actions
  ≥ the candidate's tier threshold, candidate = argmax among permitted, top diagnosis ≠ expected), plus SIM-cost
  regret (`meta.costs`), logit caching (`--records-dir`) and per-case/per-style breakdowns. All stage-1c reports
  were recomputed with it.
- Stage-1c results (details in EVAL.md): runtime-exact held-out test `rt1` R32 98.2 / 98.4 (action / diagnosis),
  R17 98.0 / 98.3, FIR 0% in both modes, heal precision 100%, recall 86%; varied styles `cur1` R32 95.8 / 97.8 (heal
  FIR 0.60%), R17 94.0 / 97.2 (heal FIR 1.70%, mostly stall); zero-shot on SIM's 123-row sample ≈ 50% action
  accuracy and 18–34% heal FIR → stage 1 does not transfer to SIM's label semantics; stage 2 is required.
- Exports (`out/export-r{17,32}-s1c`, fp16-free q8 enforced): R17 q8 9.58 MB / fp16 13.57 MB, R32 22.47 / 34.79 MB.
  onnxruntime-web 1.30 WASM (Node, 1 thread) fitted latency at 500 / 780 / 1,170 tokens: R17 188 / 339 / 608 ms,
  R32 499 / 879 / 1,539 ms (MODEL's Chromium measurement for R32 at 780 tokens: 837–940 ms).
- Coordinator: r300k is pre-freeze (runtime fact fixes, sharper SIM labels, new `transient` diagnosis); treat
  stage 2 as a pilot, evaluate, deallocate, wait for "frozen data ready". Curriculum updated accordingly:
  `transient` diagnosis (isolated retryable failures; unhandled one-off fetch failures soft transient/failing),
  compact questions (bare labels/names at state budgets ≤ 1,400 chars), WASM budget 1,000 chars (budget mix
  3,200 / 2,000 / 1,000 = 35 / 30 / 35%).
- Pilots finished: `r32-s2` 625 steps (1.5 passes, c02–c05, ≈ 1 h 50 min), `r17-s2` 1,664 steps (4 passes, 6 nodes,
  ≈ 1 h 47 min). Both servables (`max_len` 2048) copied to c01; training logs saved; **c02–c11 deallocated 20:49**.

### 20:49–23:05 Network stalls
- The Mac lost connectivity twice; the coordinator confirmed c02–c11 deallocated and deallocated an idle c01 at
  22:45. c01 restarted 23:05 for the pilot SIM evaluation (detached: `training/eval_sim.sh`, parallel shard
  collection of 20k SIM test + 7.4k dev rows per model).

### Cost estimate so far ≈ $215
- c01 ≈ 10.2 node-hours (incl. ≈ 6 h idle during outages) ≈ $56; c02–c11 ≈ 29 node-hours (17:55–20:49) ≈ $158.

### 23:05–23:35 Pilot results; runtime frozen (`situation-v1`, 1a77558); final-round prep
- Pilot SIM evaluation (20k random rows of r300k test, temperatures from r300k dev): R32-s2 action 77.5% /
  diagnosis 90.8%, R17-s2 78.3% / 91.1%; heal-mode FIR 0.06% / 0.08% but recall ≈ 1.3% (precise, almost never
  confident enough to act: pre-freeze labels were soft); mean cost heal policy 33.99 / 33.97 vs always-passive 34.03
  vs oracle 32.88. Details in EVAL.md ("Stage 2 pilot").
- `rt.py` re-ported to the frozen wording: "started 0.09s after #6" relations, "comes from X, started …, ended …
  with 200; its chain began with Y", inputs-moved "… is back to …" variant and "after #N started", "#id … started
  … after #N" concurrency items, "pending local change" fact, error-rate text "error rate X% over N requests
  (F failed)" over the last ≤ 20 outcomes, stats "F of last N failed", errors "(k of them overwritten since …)",
  slug-id signature normalisation, budget-shaped sections (`sectionLimits`: compact ≤ 1,100 chars, full ≥ 3,200,
  linear between; MIN 500; same shrink order), compact questions at ≤ 1,400 chars, `transient`.
- MODEL NEEDS 8 fixed: integral floats are written as ints everywhere in curriculum rows (also inside JSON strings).
- `cur4` = 300k rows (seed 5, 80% runtime-exact, frozen wording) as the final replay set.
- Frozen SIM rows checked (phase A shards): `meta.budget` present (1000/2000/3200), compact questions at 1000,
  sharp labels (most action dists put 1.0 on one action), `transient` diagnosis.
- Final round 1 tooling: `import_final.sh` (pull + shard + eval subsets + bundle), `configs/mix_final1.json`
  (simA 0.85, cur4 0.12, cur1 0.02, gen 0.01), `launch_final1.sh` (R32 on c02–c07 rank 0 c02; R17 on c09 c10 c11 c08,
  rank 0 c09 — rank 0 must hold the stage-1c state), `final_post.sh` (on each rank-0 node: SIM eval with dev-fitted
  temperatures, then export with them), per-budget metrics in `eval_runtime.py` (`meta.budget`).

### 00:06–00:12 (2026-10-08) Final round 1 launched
- SIM phase A (`~/gcl/sim/sim/out/final-a`, frozen runtime `situation-v1`): train 448,420 / dev 14,613 /
  test 137,643. Imported (`import_final.sh`, after fixing a self-killing `pkill` in it), bundled (2.57 GB),
  distributed to c02–c11. Eval subsets: 20k random test + 8k random dev rows.
- `r32-final1`: c02–c07 (48 ranks), from `r32-s1c`, 2.4 passes × 498M tokens, lr 1e-4 / 4e-4, ≈ 253k tok/s.
  `r17-final1`: c09 c10 c11 c08 (32 ranks), from `r17-s1c`, 3.0 passes, lr 2e-4 / 1e-3, ≈ 322–333k tok/s.
  Both ETA ≈ 01:28–01:30 UTC.
- Autonomous tail (survives Mac disconnects): on c02 / c09 a waiter runs `final_post.sh` when the servable's
  `meta.json` says `final: true` (SIM eval with dev-fitted temperatures → export with them → serve the tar on :8801);
  on the train VM `pull_on_train.sh` pulls each export into `~/gcl/train-out/final1/{r32,r17}/`, checks sha256 and runs
  the onnxruntime-web/node check. c01 deallocated 00:12.

### 00:20–00:30 Scaled-program mandate; PLAN-v1.md; probes
- New mandate (user via lead): scale data massively (SIM ≥ 10M gold + ≥ 50M unlabeled + on-policy; REAL corpus),
  teacher → students distillation, DAgger. Plan written: `training/PLAN-v1.md`; node claims/data asks in NEEDS 10–12.
- c01 restarted 00:24 as workbench: pruned `ettin-encoder-68m` and `-150m` MIT bases to the 16k vocabulary
  (`models/base/ettin-{68m,150m}-v16k`); `label_teacher.py` written and tested (R17 labels 64 SIM rows, 11.5k tok/s
  on 16 threads).
- T150 throughput probe (c01, 8 ranks × 10 threads, 2048-token rows): ≈ 9.4k tok/s per node (2× my estimate),
  16.5 GB RSS per rank.

### 00:40–01:13 Backstop disabled, quota 2,048; cluster expanded to 23 c-nodes; teacher started
- Lead: the 03:00 auto-shutdown schedules are Disabled (user OK); quota raised to 2,048 vCPU; TRAIN owns expansion.
- Created (`training/cluster_expand.sh`, one az call at a time, PPG ok, DevTestLab schedule **Disabled**):
  c12–c15 F80ams_v7 (629 GB RAM), c16–c19 F80amds_v7, c20–c23 F80ads_v7. Initialised in ≈ 1 min each from a node kit
  served by c10 (`node_init.sh`: cloned venv torch 2.14.1 / transformers 5.18, ettin bases, TRAIN data) + `node.sh sync`.
- Probes: R68 (ettin-68m) ≈ 19k tok/s per node; T150 ≈ 9.4k tok/s per node.
- **Teacher `t150-g1`** launched 01:09 on c12–c23 (12 nodes × 8 ranks × 10 threads): ettin-150m MIT base, pruned
  vocab, fresh heads, SIM phase A + 10% `cur4`, 2 passes (≈ 940M tokens), lr 2e-4 / heads 1e-3: ≈ 106k tok/s,
  ETA ≈ 03:40.
- Cost so far ≈ $330 (c01 ≈ $65; c02–c11 ≈ 41 node-hours ≈ $225; c12–c23 ≈ 3 node-hours ≈ $20 incl. setup). Running
  burn now: 22 nodes ≈ $135/h.
