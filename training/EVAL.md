# GenClass runtime model — evaluation

Candidates: **R17** (ettin-encoder-17m, d 256 × 7 layers, fresh heads) and **R32** (GenClass 0.1 / ettin-32m, d 384 ×
10 layers), both with the pruned 16,364-token vocabulary. Everything here is on held-out data; all runs on Azure
(`c01`), with `training/eval_runtime.py` and `training/report.py`.

Status (2026-10-08): stage 1c final; stage-2 pilot on pre-freeze SIM data (`r300k`); **final round 1** on the frozen
runtime (`situation-v1`) with SIM phase A — see the last section. The shipping candidates are the final-round models.

## Metrics

- **action acc / diagnosis acc**: top-1 vs the label's best option (soft labels: argmax).
- **Runtime gate** (CONTRACT §8, 2026-10-07): *A* = the applicable non-passive actions the mode permits (guard
  mode: guard tier = discard, defer, coalesce, delay; heal mode: guard + heal tier = block, serve_cached, retry,
  hedge, rollback, resync). Candidate = argmax of the calibrated probabilities over *A*; it runs iff
  Σ_{a∈A} p(a) ≥ the candidate's tier threshold (guard 0.9, heal 0.8) **and** the top diagnosis is not `expected`.
  - **FIR** (false-intervention rate) = gate fires on rows whose best action is passive ÷ those rows.
  - **precision** = fired candidate == best action ÷ fires; **recall** = correct fires ÷ rows whose best action is
    a permitted non-passive action.
  - **regret / cost** (SIM rows only): mean counterfactual cost (SIM `meta.costs`) of the gated policy vs always
    passive vs the per-row oracle; **harm** = summed extra cost of fires on passive-best rows.
- **ECE** (15 bins) after temperature scaling fitted on the matching dev split (`kind` = per question kind;
  checked split-half on dev).
- Threshold sweep: heal-mode permitted set, summed probability ≥ t, diagnosis gate on: fires / false fires /
  precision.

## Test sets

| set | rows (decision rows) | what |
|---|---|---|
| `rt1/test` | 12,000 (6,583) | curriculum rendered exactly like the runtime's `situation/*` (`curriculum/rt.py`), held-out app domains (13 of 62) and held-out paraphrases |
| `cur1/test` | 12,000 (6,958) | the varied surface styles (key names, time/line formats, paraphrases, renamed options, distractor actions), held-out domains |
| `cur2/test` | 8,000 (4,246) | 60/40 runtime-exact / varied |
| SIM sample | 200 (123) | `sim/samples/sample.jsonl`: real runtime situations, labels from SIM's counterfactual costs; never trained on (stage 1) |
| SIM `r300k` test | 20,000 random of 68,790 | SIM's held-out split (pre-freeze), for the stage-2 pilot |

## Baseline: GenClass 0.1 (v1, 32M, full vocabulary), zero-shot, `rt1/test`

action acc 37.6%, diagnosis acc 8.0% (pruned v1: 37.6% / 43.5%); the gate almost never fires (heal FIR 0.0–0.33%,
precision 39% when it does). The v1 computer-use model has none of the runtime skills.

## Stage 1c (curriculum: 818k + 400k rows, runtime-exact share 60% in the second part)

### Runtime-exact format (`rt1/test`, temperatures from `rt1/dev`)

| model | action acc | diagnosis acc | guard FIR | guard precision (fires) | guard recall | heal FIR | heal precision (fires) | heal recall | ECE action / diag | all questions |
|---|---|---|---|---|---|---|---|---|---|---|
| R32-s1c | 98.2 | 98.4 | 0.00% (0/3,355) | 100.0 (1,398) | 88.5 | 0.00% (0/3,355) | 100.0 (2,777) | 86.0 | 0.050 / 0.017 | 96.3 |
| R17-s1c | 98.0 | 98.3 | 0.00% (0/3,355) | 100.0 (1,398) | 88.5 | 0.00% (0/3,355) | 100.0 (2,774) | 85.9 | 0.048 / 0.017 | 96.1 |

Per trigger (action / diagnosis acc, heal-mode FIR): both models are at 98–100% on request, failure, stall,
inconsistency, transition and error; **mutation** is the hardest trigger (R32 94.1 / 94.4, R17 94.2 / 94.2;
FIR 0%). Threshold sweep: no false fire at t ≥ 0.6 for either model (R32 has 8 false fires at t = 0.5).

### Varied styles (`cur1/test`, temperatures from `cur1/dev`)

| model | action acc | diagnosis acc | guard FIR | guard precision | heal FIR | heal precision (fires) | heal recall | ECE action / diag |
|---|---|---|---|---|---|---|---|---|
| R32-s1c | 95.8 | 97.8 | 0.00% | 99.3 | 0.60% (23/3,830) | 98.6 (2,544) | 80.2 | 0.024 / 0.016 |
| R17-s1c | 94.0 | 97.2 | 0.03% | 98.3 | 1.70% (65/3,830) | 96.1 (2,510) | 77.1 | 0.035 / 0.018 |

R17's extra false fires are concentrated in **stall** (heal FIR 11.5% vs R32 4.5%: it hedges degraded-API stalls
whose label leans `wait`) and failure (0.75%). Mixed set `cur2/test` (raw temperatures): R32 96.9 / 97.9, heal FIR
0.14%; R17 96.1 / 97.8, heal FIR 0.81%.

Calibration: fitted temperatures choice 0.71, score 0.59–0.66, noul 0.85–1.0 (the heads are slightly
under-confident); split-half on dev: NLL 0.078 → 0.070 (rt1) and ECE 0.025 → 0.011, i.e. the fit transfers within
the curriculum distribution.

### Zero-shot on SIM's sample (123 decision rows, temperatures from `rt1/dev`)

| model | action acc | diagnosis acc | guard FIR | heal FIR | heal precision | mean cost: heal policy / always passive / oracle |
|---|---|---|---|---|---|---|
| R32-s1c | 51.2 | 49.6 | 13.6% | 34.0% | 19.1% | 23.26 / 23.61 / 22.36 |
| R17-s1c | 48.0 | 43.9 | 9.7% | 18.4% | 22.2% | 23.24 / 23.61 / 22.36 |

The curriculum's labels are a rule-based oracle over clear-cut synthetic cases with ≈ 55% passive-best rows; SIM's
are counterfactual costs on real runtime traces with 70–96% passive-best rows, many coincidental learned
invariants (labelled `expected`) and soft, close action costs. Stage 1 alone over-intervenes on SIM traffic
(inconsistency, request and mutation rows), so **stage 2 on SIM data is required**; stage 1's value is the format
and the primitives (versions, identity, streaks, baselines, invariants) it starts from.

## Size and latency (q8 = fp16-free: MatMulNBits 8-bit block 32 + int8 row-wise embeddings + fp32 scales)

| model | q8 | fp16 (WebGPU, shader-f16) | q8 vs PyTorch: argmax / gate@0.8 / gate@0.9 agreement | onnxruntime-web 1.30 WASM, 1 thread: ms at 500 / 780 / 1,170 sequence tokens | ORT CPU (native) 1 thread |
|---|---|---|---|---|---|
| R17-s1c | **9.58 MB** | 13.57 MB | 99.5% / 99.4% / 98.8% (165 questions) | **188 / 339 / 608** | 39 / 71 / 132 |
| R32-s1c | 22.47 MB | 34.79 MB | 100% / 97.0% / 99.4% | 499 / 879 / 1,539 | 93 / 163 / 289 |

- WASM latencies are least-squares fits over 184 requests (34–1,484 tokens) run in Node 22 with the WASM backend;
  MODEL measured R32 in Chromium at 837–940 ms for a 780-token sequence, matching the Node fit. `numThreads = 4`
  gives no speed-up in Node (no worker threads there); MODEL measured ≈ 3× in a crossOriginIsolated page.
- Packed sequence length (state + diagnosis + action) by the runtime's state budget, measured with the pruned
  tokenizer (≈ 2.4–2.5 chars/token): 1,000–1,100 chars → ≈ 600 tokens (max ≈ 710); 2,000 → ≈ 1,000 (max ≈ 1,200);
  3,200 → SIM `r300k` mean 1,108, p95 1,523, max 1,761 (so stage-2 models use `max_len` 2048). The two standing
  questions add ≈ 185 tokens (fewer with compact questions).
- So at the WASM-1-thread budget (≈ 600 tokens) R17 decides in ≈ 0.25 s and R32 in ≈ 0.65 s.

## Stage 2 pilot (pre-freeze data: SIM `r300k`)

Both models continued from stage 1c on SIM `r300k` train (224k rows) + 24% curriculum replay, `max_len` 2048:
R32 1.5 passes (625 steps, 4 nodes), R17 4 passes (1,664 steps, 6 nodes). Evaluated on 20,000 random rows of SIM's
held-out test split (13,058 decision rows), temperatures fitted on SIM dev (7,426 rows).

| model | action acc | diagnosis acc | guard FIR | guard fires | heal FIR | heal precision (fires) | heal recall | mean cost: heal policy / always passive / oracle | ECE action / diag |
|---|---|---|---|---|---|---|---|---|---|
| R32-s2-pilot | 77.5 | 90.8 | 0.02% (2/10,234) | 2 | 0.06% (6/10,234) | 75.5 (49) | 1.3% | 33.99 / 34.03 / 32.88 | 0.24 / 0.012 |
| R17-s2-pilot | 78.3 | 91.1 | 0.00% (0/10,234) | 4 | 0.08% (8/10,234) | 65.5 (58) | 1.4% | 33.97 / 34.03 / 32.88 | 0.26 / 0.017 |

Per trigger (action / diagnosis acc): error 94.5 / 93, failure 71 / 85, inconsistency 85 / 97, mutation 84–86 / 90,
request 72 / 95, stall 64–68 / 87–89, transition 83–85 / 89–90 (R32 / R17 within ~2 points of each other
everywhere). Threshold sweep (heal, summed mass): at 0.8 the models fire 130 (R32) / 173 (R17) times with 70% / 66%
precision; at 0.9 21 / 27 times with 81% / 93% precision.

Reading: after stage 2 the models are **precise but almost never confident enough to act** (recall ≈ 1%): the
pre-freeze SIM action labels were soft (a temperature of ≈ 2 over costs, e.g. 0.31 / 0.34 / 0.34 on clear stale
writes), so the models learned soft action distributions that rarely put ≥ 0.8 on the non-passive actions. The
gated policy saves only ≈ 0.05 cost units per decision of the 1.15 available (oracle). Diagnoses are already good
(91%). SIM's frozen data uses uncertainty-based labels (≥ 0.95 on clear cases), which is what the final round
trains on; R17 matches R32 here, which supports R17 as the WASM default.

## Final round 1 (frozen runtime `situation-v1`, SIM phase A) — v1 baseline

Training: both students from their stage-1c weights on SIM phase A train (448,420 rows; budgets 3,200 / 2,000 /
1,000 chars, compact bare-label questions at 1,000) + 12% frozen-wording curriculum (`cur4`) + 3% older replay,
`max_len` 2048. R32: 2.4 passes (771 steps, c02–c07, 1 h 25 min); R17: 3.0 passes (2,168 steps, c08–c11, 1 h 12 min).
Evaluation: 20,000 random rows of SIM's held-out test split (12,901 decision rows), temperatures fitted on 8,000 dev
rows (per kind; split-half NLL 0.332 → 0.331, ECE 0.013 → 0.009, so the fit transfers).

| model | action acc | diagnosis acc | guard FIR | guard precision (fires) | guard recall | heal FIR | heal precision (fires) | heal recall | ECE action / diag |
|---|---|---|---|---|---|---|---|---|---|
| **R17-final1** | 81.9 | 90.5 | **0.05%** (5/10,224) | 80.8 (26) | 1.8% | **0.24%** (24/10,224) | 79.0 (152) | 4.5% | **0.009 / 0.010** |
| R32-final1 | 81.8 | 89.7 | 0.05% (5/10,224) | 78.3 (23) | 1.5% | 0.22% (23/10,224) | 77.1 (157) | 4.5% | 0.008 / 0.012 |

Recall on **clear** cases (gold puts ≥ 0.9 on one permitted non-passive action): R17 guard 4.2% of 429 rows (clear
stale/duplicate 7.7% of 220), heal 6.1% of 1,193; R32 3.5% / 6.8% / 5.9%.
Counterfactual cost per decision (heal mode): R17 33.35, R32 33.34 vs always-passive 33.40 vs oracle 32.38 — the gate
recovers ≈ 5% of the available improvement.

Per trigger (R17; action / diagnosis acc, heal FIR, heal precision): mutation 90.3 / 89.7, 0.10%, 83%; request
75.0 / 94.5, 0.20%, 70%; failure 75.9 / 85.3, 0.55%, 83%; inconsistency 85.3 / 94.7, 0.30%, 60%; stall 67.0 / 91.2,
0.50%, 67%; transition 86.5 / 87.0, 0%; error 94.3 / 98.9, 0%. Per budget (R17): 1,000 chars 82.1 / 87.9 (heal FIR
0.20%), 2,000 chars 81.9 / 91.0 (0.30%), 3,200 chars 81.8 / 91.9 (0.22%) — compact situations cost ≈ 4 points of
diagnosis accuracy and nothing in action accuracy.

Threshold sweep (R17, heal): 0.5 → 1,440 fires at 56% precision; 0.8 → 206 at 77%; 0.9 → 87 at 85%; 0.95 → 39 at 97%.

Against the PLAN-v1 targets: guard FIR ≤ 0.1% **met** (0.05%), heal FIR ≤ 0.5% **met** (0.24%), ECE ≤ 0.02 **met**;
diagnosis ≥ 95% **not met** (90.5%); recall on clear stale/duplicate ≥ 80% **far from met** (7.7%).

Why recall is low: on the 1,216 clear actionable test rows R17's argmax equals the gold action only 41% of the time
and its non-passive mass has median 0.48 (p90 0.79), while on passive-best rows the non-passive mass has p90 0.42 and
p99 0.71: the situations of clear actionable cases and of benign look-alikes overlap a lot for these models, so a
calibrated model cannot be ≥ 0.8 sure. Per trigger the argmax accuracy on clear rows is failure 51%, mutation 48%,
stall 54%, request 30%, inconsistency 14%, transition 5%. R32 (3× the compute per token) is no better than R17, which
points at **information/data**, not student capacity, as the bottleneck — the questions for the scaled program are
whether a much larger teacher separates these cases (P2) and whether more and on-policy data does.

Size and latency of the delivered exports (`~/gcl/train-out/final1/{r17,r32}` on the train VM; R17 also in
`packages/runtime-model/files/r17/`): R17 q8 9.58 MB / fp16 13.57 MB; q8 vs PyTorch: argmax 100%, gate agreement
99.5% @0.8 / 100% @0.9 (233 questions); onnxruntime-web 1.30 WASM 1 thread ≈ 177 / 323 / 589 ms at 500 / 780 / 1,170
sequence tokens (SIM rows: ≈ 380 / 780 / 1,100 tokens at the 1,000 / 2,000 / 3,200-char budgets).

**Recommendation for v1:** R17 as the default for every device (same accuracy as R32 at a third of the latency and
size); the gate is precise and well calibrated but intervenes rarely. CORE's situation-v2 redesign (a `delivery`
trigger at the network boundary, non-blocking mutations) supersedes this format; these numbers are the baseline for
the v2 rounds.
