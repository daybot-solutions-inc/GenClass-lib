# TRAIN plan v1 — scaled training on errors (teacher → students → DAgger)

**Status 02:00 UTC:** final round 1 (situation-v1) is done and is the baseline (EVAL.md): R17 = R32 at 82% action /
90% diagnosis accuracy, guard FIR 0.05%, heal FIR 0.24%, ECE 0.01, but recall on clear actionable cases only ≈ 5%:
students cannot separate clear actionable situations from benign look-alikes (argmax 41% on clear rows), and 3× more
student compute (R32) does not help. CORE is moving to **situation-v2** (`delivery` trigger, non-blocking mutations);
everything below starts on v2 data, with these extra checks: (a) the teacher's separation on clear cases is the
first gate (P2) — if a 150M teacher is also near 40% argmax on clear rows, the bottleneck is the situation
information, and the fix is in SIM/CORE (what the situation shows), not in model size; (b) DAgger rows and REAL rows
are evaluated for clear-case recall separately.

Mandate (user, 2026-10-08): "Find a lot of data, so much data to train on errors that it'll be insane. We want this
model to be crazy. Use Azure, I don't care." Final round 1 (frozen runtime, SIM phase A) is the baseline; this plan
scales from it. Licensing rule unchanged: MIT ettin bases + our synthetic/simulated/real-app data only; never
`jev-local-fast-v2`, Z or S checkpoints or benchmark data.

## 1. Targets (stretch; reported honestly every round)

| metric (SIM held-out incl. held-out features, and REAL eval) | target |
|---|---|
| guard-mode false-intervention rate (FIR) | ≤ 0.1% |
| guard-mode recall on clear stale / duplicate cases (gold best action non-passive with ≥ 0.9 label mass) | ≥ 80% |
| heal-mode FIR | ≤ 0.5% |
| diagnosis accuracy | ≥ 95% |
| ECE (action, diagnosis; per budget 1,000 / 2,000 / 3,200) | ≤ 0.02 |
| latency (q8, WASM 1 thread) — R17 default | ≈ 0.25 s at the 1,000-char budget |

Round-1 baseline numbers go into EVAL.md (final round 1) and are the reference for every later round.

## 2. Data inventory (owner → location; TRAIN imports with `import_final.sh`-style scripts)

| source | volume | labels | use |
|---|---|---|---|
| SIM gold (phase A 600k, B 1.4M, then scaled) | → ≥ 10M rows | counterfactual (sharp, uncertainty-based) | teacher + student training, held-out eval |
| SIM unlabeled situations (every decision point of base runs) | → ≥ 50M rows | none | teacher soft labels → distillation |
| SIM on-policy (DAgger: our exported students as the sim policy) | per round, 1–5M | counterfactual | next-round training (states the policy actually visits) |
| REAL corpus (real front-ends in headless Chromium) | TBD | counterfactual | training + **real-app eval set** (never trained on) |
| curriculum (`training/curriculum`, frozen wording) | unlimited, ~10 s per 400k rows | exact | ≤ 10% replay: format/primitives, `ask` skills |

Hold-outs: SIM's held-out domains/program families **and held-out feature classes** stay test-only; REAL eval stays
test-only; dev splits are used for calibration only.

## 3. Models

| id | base (MIT) | params (non-emb) | role | est. train throughput per F80 node (8 ranks × 10 thr) |
|---|---|---|---|---|
| R17 | ettin-17m, pruned vocab | 4.6M | WASM default student | ≈ 90k tok/s (measured 80–90k) |
| R32 | ettin-32m (via GenClass 0.1), pruned | 14M | WebGPU student | ≈ 42k tok/s (measured) |
| R68 | ettin-68m, pruned | 42M | candidate WebGPU student (benchmark) | ≈ 12k tok/s (est.) |
| T150 | ettin-150m, pruned | 111M | **teacher** | **9.4k tok/s measured** (1-node probe, 2048-token rows; 16.5 GB RSS per rank → on the 160 GB `als/alds` nodes use 6 ranks or grad-ckpt) |
| T400 | ettin-400m | ≈ 350M | teacher only if T150 clearly beats R68 and throughput allows | ≈ 1.3k tok/s (est.) |

All use the same pruned 16,364-token vocabulary (one packer/tokenizer everywhere; the embedding table is a small
share of teacher compute). Teachers are never shipped.

## 4. Phases (each run resumable: `--resume`, checkpoints every ≤ 10 min; the 03:00 UTC backstop just pauses work)

| phase | what | compute (est.) |
|---|---|---|
| P0 | final round 1 (running): eval, calibration, export, delivery | 10 nodes × 1.6 h |
| P1 | gold v2 = SIM A + B (2M) + scaled SIM as it lands; T150 training on gold, init from the ettin MLM base, 2–3 epochs over the first ~3M rows (≈ 2.5B tokens at ≈ 65–70k tok/s on 8 nodes) | 8 nodes ≈ 10–11 h |
| P2 | teacher eval on SIM held-out (incl. held-out features) and REAL eval vs R32/R68 trained on the same gold; decide T150 vs T400 (only if T150 − R68 gap is large) | 1 node |
| P3 | soft-label a prioritised subset of the unlabeled rows: all salient-trigger rows where the current student is near the gate (summed non-passive mass 0.3–0.95) or disagrees with itself across budgets, plus a uniform sample; 5–10M rows ≈ 4–8B tokens of teacher inference (≈ 3× cheaper than training per token) | 8 nodes ≈ 10–20 h |
| P4 | distil students: R17, R32, R68 on gold + teacher-labelled rows (teacher dists, temperature-calibrated) + 5–10% curriculum replay; R17 gets the most passes | R17 4 nodes ≈ 4 h, R32 6 nodes ≈ 6 h, R68 8 nodes ≈ 8 h |
| P5 | DAgger rounds (×3): export students → SIM on-policy rows (1–5M) → retrain students (and refresh the teacher every 2nd round) | 3 rounds |
| — | eval/calibration/export/parity per round (c01) | |

Costs are tracked internally.

## 5. Evaluation every round (EVAL.md)

SIM held-out test (domains/families), SIM held-out **features**, REAL eval, the demos (DEMOS' Playwright, bug rate
Off/Guard/Heal and clean-run false interventions): action/diagnosis accuracy; guard/heal FIR, precision, recall
(also restricted to clear stale/duplicate cases); counterfactual cost vs always-passive vs oracle; harm on
passive-best rows; ECE; all per trigger and per budget (1,000 / 2,000 / 3,200 chars) and per held-out category;
calibration fitted on dev with a split-half check; q8/fp16 parity and WASM latency.

## 6. Infrastructure work (TRAIN)

1. `label_teacher.py`: sharded batch inference → rows with `{"type":"choice","dist":…}` labels from the calibrated
   teacher (+ `meta.teacher` = margin, entropy), run per node on assigned shards, resumable by shard.
2. Data hub: corpora live on the `data` VM (or c01) and are pulled per run over the private network; per-file
   stream caches (index + exact-layout sizes) built once and copied to all nodes instead of rebuilt per node.
3. Resume launcher: one script relaunches every interrupted run with `--resume` after the backstop.
4. Calibration per budget (compact vs full questions behave differently) if the split-half check says it transfers;
   otherwise per kind.
5. Teacher-speed work if needed: larger micro-batches, bf16 all-reduce, ga tuning; measure 8×10 vs 4×20 for T150.

## 7. Node claims (proposal; arbitrated by the lead)

The eastus quota (1,024 vCPU) is the whole cluster: `train` D64 + `data` + c01–c11 (F80). Proposed default: SIM and
REAL generate on `train`, `data` and 2–3 c-nodes; TRAIN uses c01 (workbench: import/eval/labelling/export) and
c02–c09 for training; nodes move between workstreams by agreement; every idle node is deallocated.

## 8. Risks

- Teacher too slow on CPU → use R68 as the teacher (still ≈ 3× R32) and spend the compute on data and DAgger.
- SIM label noise on soft cases (close costs) → keep soft dists, don't sharpen; evaluate recall on clear cases.
- Over-intervention when moving to the real runtime/demos → precision-first gate checks on clean runs every round;
  ship guard mode only when guard FIR ≤ 0.1% on all held-out sets.
- The 03:00 backstop interrupting long runs → resumable runs; ask the owner to move it.
