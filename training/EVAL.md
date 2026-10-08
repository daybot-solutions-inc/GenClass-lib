# GenClass runtime model — evaluation

Candidates: **R17** (ettin-encoder-17m, d 256 × 7 layers, fresh heads) and **R32** (GenClass 0.1 / ettin-32m, d 384 ×
10 layers), both with the pruned 16,364-token vocabulary. Everything here is on held-out data; all runs on Azure
(`c01`), with `training/eval_runtime.py` and `training/report.py`.

Status (2026-10-08): stage 1c final; stage-2 pilot on pre-freeze SIM data (`r300k`); **final round 1** on the frozen
runtime (`situation-v1`) with SIM phase A (v1 baseline); **situation-v2**: `r17-v2a` (SIM v2 gold) with data-derived gates in its `meta.json` — see the last section, which is the current shipping candidate.

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

## situation-v2: `r17-v2a` (first v2 R17; 2026-10-08 06:10 UTC)

Recipe: R17 from `r17-final1`, 2B tokens: SIM v2 gold `sim2` 86% (7.56M train rows), v2 curriculum replay `cur5` 11%,
`cur1` 2%, `gen` 1%; 8 F80 nodes, 56 min. No REAL gold (see `r17-v2b`). Export `genclass-runtime-r17` 2.0.0-rc1:
q8 9.58 MB (fp16-free) / fp16 13.57 MB, q8 = PyTorch argmax 223/223, gates 191/191; onnxruntime-web 1.30 WASM 1 thread
≈ 176 / 321 / 586 ms at 500 / 780 / 1,170 tokens. Delivered: train VM `~/gcl/train-out/v2a/r17/`,
`packages/runtime-model/files/r17/` (replaces the v1 files; v1 stays in `~/gcl/train-out/final1/`).

Test sets (never trained on): `sim2e` = 20k random rows of SIM's held-out test split (held-out domains / families /
patterns / features), 8k dev rows for temperatures; `sim2f` = 18,690 test rows whose family contains a held-out
**feature** (swcache, presence, cascade, saga, prefetch, permissions); `real2e` = 20k random REAL v2c test rows (+8k dev);
`realev` = REAL's unambiguous-case eval set (16,600 rows; its rows are removed from every REAL training bucket).

Fixed gates 0.9 / 0.8 (pre-v2.2 action applicability, `eval_runtime.py`):

| set | decision rows | action acc | diagnosis acc | guard FIR | heal FIR | heal precision | heal recall | clear (heal) | ECE action raw → cal |
|---|---|---|---|---|---|---|---|---|---|
| sim2e | 12,696 | 77.9 | 84.4 | 0.00% (0/9,464) | 0.46% | 75.2 | 6.8 | 11.3 | 0.026 → 0.011 |
| sim2f (held-out features) | 11,756 | 77.4 | 81.0 | 0.00% (0/8,703) | 0.75% | 71.0 | 6.8 | 11.1 | 0.028 |
| real2e | 13,032 | 78.7 | 77.8 | 0.01% | 0.22% | 64.1 | 3.2 | 3.7 | 0.059 |

Per trigger (sim2e, action / diagnosis / heal FIR): delivery 84.7 / 77.8 / 0.00%, error 95.0 / 96.7 / 0.00%, failure
78.7 / 88.1 / 1.43%, inconsistency 81.0 / 88.5 / 0.11%, mutation 86.7 / 85.9 / 0.00%, request 71.7 / 80.5 / 0.07%,
stall 67.3 / 92.2 / 0.00%, transition 88.5 / 80.1 / 0.00%. Budgets 1,000 / 2,000 / full: action 77.0 / 78.0 / 78.5.

Expected gain (sim2e, `eval_gain.py`, heal mode, oracle 1.11 gain/row): gate@0.8 captures 9.3% of the oracle gain
(v1 baseline 6.7%), recall on clear 12.3%, harmful 0.13%, label-FIR 0.49%; gate@0.5 33% / 45% / 1.8% / 8.1%.

REAL eval set (`eval_real.py`, SIM-fitted calibration = what ships), fixed gates guard@0.9 / heal@0.8:
clean-benign and benign-salient fired 0.00% / 0.00% (gate 0.5: 0.05–0.35%); recall duplicate-submit 0.0% / 0.6%,
genuine-break 0.0% / 0.1%, stale-overwrite 0.2% / 1.0% (gate 0.5, heal: 35% / 10% / 9%; duplicate on held-out-app
test-split rows 64%). Argmax accuracy: duplicate 25%, genuine-break 8%, stale 11%.

### Data-derived gates (shipped in `meta.json` → `gate`; `fit_gates.py`, coordinator rule of 07:00)

Rule: per tier × trigger, the lowest summed-mass threshold (diagnosis ≠ expected kept) such that on **dev** data the
model never trained on — SIM dev sample `sim2g` (104k rows), REAL eval-set rows outside REAL's test split, REAL dev —
FIR (SIM passive-best rows; REAL clean-benign + benign-salient) ≤ 0.1% guard / 0.5% heal and harm (fired action costs
≥ 1 more than passive; SIM and REAL separately) ≤ 0.2% / 1%, each for the one-sided 95% Wilson **upper bound** (point
estimate where n cannot certify the limit), at that threshold and every grid value above it; triggers with < 1,500
SIM passive-best dev rows use the tier default; guard fitted in guard mode, heal in heal mode with guard candidates at
their guard thresholds. Without the upper bound the dev-fitted thresholds did not transfer to the held-out test sets
(guard FIR 0.11%, delivery 0.28%, heal failure 0.85% on test). **v2.2 applicability:** `retry` removed (probabilities
renormalised) for POST/PATCH rows without an idempotency key — v2 rows carry no headers, so "keyed" = the subject
feature's SIM pattern says the app sends keys (`…/idem`, `co-idem`, `create-idem`, `confirm-idem`, `key-guard`,
`retry:same-key`); this removes retry from 1,321 of 4,071 retry-offering sim2e rows (1,124 of 3,838 in sim2f).

`r17-v2a` gates: guard default 0.75 (delivery 0.70, mutation 0.90, request 0.75); heal default 0.85 (failure 0.90,
inconsistency 0.80, request 1.0 = never, transition 0.60; error/stall default).

Verification on **test** (sim2e + sim2f + REAL test-split eval rows + real2e test; 95% bootstrap intervals):

| mode / gates | SIM rows | fired | FIR SIM | FIR REAL | harm SIM / REAL | recall clear | gain captured |
|---|---|---|---|---|---|---|---|
| guard, data-derived | 12,111 | 0.14% | 0.03% [0.00, 0.08] | 0.00% | 0.01% / 0.00% | 2.5% [1.1, 4.2] | 3.0% [1.1, 5.6] |
| guard, fixed 0.9 | 12,111 | 0.02% | 0.00% | 0.00% | 0.00% / 0.00% | 0.2% | 0.04% |
| heal, data-derived | 22,322 | 0.99% | 0.19% [0.13, 0.25] | 0.00% | 0.05% / 0.04% | 5.2% [4.1, 6.3] | 5.1% [3.7, 6.5] |
| heal, fixed 0.8 | 22,322 | 2.67% | **0.66%** [0.56, 0.77] | 0.00% | 0.09% / 0.10% | 12.0% | 9.3% |

Per trigger on test (heal mode): failure fired 2.8%, FIR 0.55% [0.33, 0.83] (slightly above the limit on held-out
data), recall clear 10.0%, gain 6.3%; request FIR 0.07%, gain 6.6%; delivery FIR 0.14% [0.00, 0.42], gain 2.9%;
inconsistency FIR 0.17%, gain 1.4%; transition FIR 0.15%; mutation / stall / error ≈ 0. The fixed 0.8 heal gate
breaks the heal FIR limit on held-out data (0.66%); the derived gates hold it pooled and trade recall for it.
Full per-trigger tables: `out/gates/r17-v2a.json` on c09.

Targets: guard FIR ≤ 0.1% met; heal FIR ≤ 0.5% met pooled (failure trigger 0.55% on held-out test); diagnosis ≥ 95%
not met (84 / 81); clear stale/duplicate recall ≥ 80% far from met; ECE ≤ 0.02 met after calibration on SIM (REAL 0.059).

## situation-v2: `r17-v2b` (current shipping candidate, 2.0.0-rc2; 2026-10-08 07:10 UTC)

Recipe: `r17-v2a` + 1B tokens (`mix_v2b`: sim2 0.70, REAL gold `real2` 0.18 — v2c1–4 minus every REAL eval-set row —,
cur5 0.10, cur1/gen 0.02), lr 1e-4, 4 nodes. Export q8 9.58 MB / fp16 13.57 MB, ORT-web 223/223, WASM 1 thread ≈ 176 /
320 / 583 ms at 500 / 780 / 1,170 tokens; `train:~/gcl/train-out/v2b/r17/` and `packages/runtime-model/files/r17/`.

| set | action acc | diagnosis acc | guard FIR @0.9 | heal FIR @0.8 | heal precision | heal recall | ECE action |
|---|---|---|---|---|---|---|---|
| sim2e | 77.8 | 84.2 | 0.01% | 0.50% | 74.1 | 7.1 | 0.023 |
| sim2f (held-out features) | 77.0 | 80.6 | 0.00% | 0.70% | 72.9 | 7.0 | 0.022 |
| real2e | **80.0** (v2a 78.7) | **83.6** (77.8) | 0.00% | 0.31% | 72.9 | 6.2 | **0.021** (0.059) |

REAL eval set (fixed gates): argmax duplicate-submit 49.6% (v2a 24.8%), stale-overwrite 13.6%, genuine-break 2.7%
(v2a 7.8%); heal@0.8 recall duplicate 8.2% (held-out-app rows 14%); clean-benign / benign-salient fired 0.00%.

Data-derived action gates (in `meta.json`): guard default 0.80 (delivery 0.75, mutation 0.95, request 0.75); heal
default 0.85 (failure 0.90, inconsistency 0.80, request 1.0, transition 0.55). Test verification (v2.2 retry
applicability): guard FIR SIM 0.02% [0.00, 0.06], REAL 0.00%, recall clear 1.8%, gain captured 2.9%; heal FIR SIM 0.23%
[0.14, 0.29], REAL 0.00%, harm 0.07% / 0.08%, recall clear 6.0%, REAL action-case recall 9.5%, gain captured 5.7%
(fixed 0.8: FIR 0.67%, over the limit).

### Observe-mode detections (`fit_report.py`; coordinator request of 07:50)

Detection = top calibrated diagnosis ≠ expected with probability ≥ `gate.report`. Fitted on dev (SIM `sim2g` 104k,
REAL eval-set rows outside REAL's test split): lowest r with false detections ≤ 1% on REAL clean-benign +
benign-salient and ≤ 2% on SIM rows whose **gold diagnosis is `expected`** (95% Wilson upper bounds). SIM
passive-best rows were not usable as "false": ≈ 45% of them carry a real anomaly (failing / slow / transient /
overload networks where waiting is still best) and the detection is correct there (precision 0.91 at r = 0.7) — no
threshold ≤ 0.99 brings "any detection on passive-best rows" under 2% (deviation accepted by the coordinator). The dev
fit gave 0.70; it failed the SIM limit on held-out test (table below), so the coordinator selected **`gate.report =
0.85`** for v2b — **this one choice is test-informed**. Shipped v2b `meta.json` sha256 `59d4b608…238126` (2,091 B),
`model.json` sha256 `64f12f2a…af459c`. From now on every dev fit (action gates and `gate.report`) must meet 0.8 × each
limit (Wilson upper bound), so that it holds on the shifted test sets without test-informed changes.

Verification on test, r = 0.70 (r = 0.85 in brackets):

| set | detected | precision | false on REAL clean+benign-salient | false on gold-`expected` rows |
|---|---|---|---|---|
| sim2e | 50.9% | 0.91 | – | **2.59%** [1.11%] |
| sim2f (held-out features) | 49.9% | 0.89 | – | **3.60%** [1.66%] |
| real2e | 39.6% | 0.88 | – | 4.34% [3.16%] |
| REAL eval set, test split | 14.0% | 0.96 | **0.62%** [0.36%] | 0.54% |

The dev-fitted 0.70 meets the REAL limit on held-out apps but **not** the 2% SIM limit on held-out test (domains /
features shift again); 0.85 meets both SIM test sets (stale-overwrite detection drops 43% → 28%). real2e's
gold-`expected` rows are detected 2–4% at every r (REAL diagnosis labels for random rows; not a constraint set).

Per-class detection at r = 0.70 (precision / recall): sim2e — failing 0.95 / 0.78, slow 0.94 / 0.91, transient 0.88 /
0.81, duplicate 0.80 / 0.49, stale 0.87 / 0.57, inconsistent 0.97 / 0.53, conflict 0.89 / 0.54, overload 0.93 / 0.38,
unusual 0.96 / 0.49; sim2f — duplicate 0.68 / 0.43, stale 0.82 / 0.44, inconsistent 0.98 / 0.28, overload 0.88 / 0.25;
real2e — failing 0.96 / 0.64, slow 0.93 / 0.95, transient 0.87 / 0.84, duplicate 0.92 / 0.53, stale 0.67 / 0.51,
inconsistent 0.93 / 0.28, unusual 0.91 / 0.06. REAL eval set (held-out apps), detected with the right diagnosis:
**duplicate-submit 76%**, **stale-overwrite 43%**, genuine-break 27%; clean-benign 0.5% / benign-salient 0.7% any
detection. Full curves (r = 0.50–0.99): `out/gates/r17-v2b-report.json` (c03).

## Teacher `t150-v2a` (ettin-150m, 1B tokens of v2 gold + REAL gold) — not used

Evaluated across its 11 nodes (`teacher_eval.sh`, bf16): sim2e action 76.5 / diagnosis 81.8, sim2f 75.5 / 79.6, real2e
78.1 / 82.0 — below `r17-v2b` (77.8 / 84.2, 77.0 / 80.6, 80.0 / 83.6) on every set; expected gain (heal) gate@0.5 27.9%
vs 31.7%, gate@0.8 3.2% vs 8.8%; REAL eval argmax duplicate 38% vs 50%, stale 4.7% vs 13.6%. Teacher labelling would
cost ≈ 1M rows/h on 20 nodes (bf16). Decision (with the coordinator's rule "only distil if it clearly beats v2b"): no
labelling / distillation; nodes deallocated; the run is resumable (`runs/t150-v2a` on c12).

## T1 on v2: `r17-v2t` (expected-advantage soft labels, τ = 1) vs `r17-v2a` (same recipe, SIM labels)

Labels: action = softmax(gain/τ) with gain = mean-future cost(passive) − cost(a) − premium (clipped ±30), 4.87M of
7.56M sim2 rows relabelled; everything else identical to r17-v2a (from r17-final1, 2B tokens, same mixture).

Expected gain on sim2e (heal mode, oracle 1.11 / row; label-FIR = fired on rows whose SIM label is passive-best):

| policy | fired | recall clear | harmful (gain < −1) | gain captured | label-FIR |
|---|---|---|---|---|---|
| v2a gate@0.8 (summed mass) | 2.5% | 12.3% | 0.13% | 9.3% | 0.49% |
| v2a gate@0.9 | 0.7% | 4.5% | 0.06% | 2.7% | 0.10% |
| v2t gate@0.8 (summed mass) | 4.0% | 19.9% | 0.32% | 18.3% | 1.18% |
| v2t gate@0.9 | 0.8% | 6.5% | 0.05% | 5.9% | 0.06% |
| **v2t per-action gain gate ĝ > 1** | 2.5% | 15.9% | 0.14% | **14.4%** | 0.57% |
| v2t ĝ > 0.5 | 7.9% | 32.6% | 0.65% | 26.1% | 3.2% |

(ĝ(a) = τ·(z_a − z_passive) on raw logits; fire the argmax ĝ over permitted actions.) At matched FIR/harm, T1 with a
per-action gain gate captures ≈ 1.5× the gain of the SIM-label model (14.4% vs 9.3%), and ≈ 2× at gate 0.9. With the
runtime's **summed-mass** gate T1 does not ship: the data-derived heal thresholds come out at 1.0 (never) because
gain-shaped labels put summed mass on near-tie actions of passive-best rows (heal-mode FIR 0.97% at fixed 0.8).
REAL eval set (no REAL training in either): T1 is far more willing on the clear cases — argmax duplicate 55% (v2a 25%),
stale-overwrite 43% (11%), genuine-break 16% (8%); heal@0.8 recall duplicate 17% (35% on held-out apps), stale 4.8%,
clean/benign fired 0.00% — but at gate 0.5 benign-salient fires 3.0% (v2a 0.35%). Action accuracy against SIM's
labels drops (74.1 vs 77.9) as expected, and the shared `choice` temperature is distorted (ECE 0.21 vs SIM labels;
`gate.report` fit = 1.0) — a T1 export would need per-question temperatures. **What shipping T1 needs** (no new ONNX
outputs): the runtime gate on ĝ(a) = τ_gain · ln(p(a)/p(passive)) per permitted action with τ_gain and per-tier/trigger
margins in `meta.json` (`gate.kind: "gain"`), plus per-question calibration. The separate gain-regression head
(`r17-t1h`) was stopped early on v1 (loss 0.98 → 0.85 vs trivial 0.97–1.01) and not pursued.

### `r17-v2b` gates refit on the shipped model's own distribution (2026-10-08 10:30 UTC) — published as `@genclass/runtime-model@0.1.0`

SIM's on-policy round b (r17-v2b with its meta gates, situation-v2.3) showed the heal transition gate 0.55 too loose
on-policy (41% of transition acts false), delivery acts 18% false at 0.75, request 19% (coalesce on intended repeats).
Refit with dev = sim2g + **on-policy round b dev (33.7k) + round a dev (37.8k)** + REAL eval rows outside REAL's test
split + REAL dev; 95% Wilson bound at 0.8 × each limit; a trigger gets its own threshold only where its dev evidence
certifies every limit (SIM and REAL), else max(tier default, SIM-certified value), never below the default.

Shipped gates: guard default 0.80 (mutation 0.95); heal default 0.85 (failure **0.95**, inconsistency 0.85); report 0.85.
**Test-informed (coordinator):** the dev rule gave heal failure 0.90, whose held-out test FIR was 0.74% [0.51, 0.98]
(> 0.5%); 0.95 was selected after that check (failure FIR 0.21% [0.11, 0.34], failure gain captured 8.4% → 2.5%).
`gate.report` 0.85 is now the dev fit itself (no test-informed change).

Verification on held-out test (on-policy round b test 20k + sim2e + sim2f; REAL test-split eval rows), at the dev-rule
values (failure 0.90; with 0.95 pooled heal FIR 0.07%, gain captured 3.8%):

| mode | fired | FIR SIM | FIR REAL | harm SIM / REAL | recall clear | REAL action recall | gain captured |
|---|---|---|---|---|---|---|---|
| guard | 0.04% | 0.01% [0.00, 0.02] | 0.00% | 0.00% / 0.00% | 0.6% | 0.0% | 0.8% |
| heal | 1.11% | 0.17% [0.12, 0.22] | 0.00% | 0.04% / 0.07% | 5.9% | 5.7% (request 14%) | 5.7% |
| heal, fixed 0.9/0.8 | 2.82% | 0.67% | 0.00% | 0.08% / 0.13% | 12.5% | 0.2% | 9.4% |

Transition: 0 fires on test (was 41% false on-policy at 0.55). Observe mode at 0.85: false detections on REAL
clean+benign-salient 0.36%, SIM gold-expected 1.1% (sim2e) / 1.7% (sim2f) — but **3.1% on on-policy round-b test**
(over the 2% limit on the shipped model's own distribution); detection with the right diagnosis on held-out REAL
apps: duplicate-submit 76%, stale-overwrite 28%. Shipped hashes: meta.json `c3358947…0eb50` (2,602 B), model.json
`9e2a42bd…afff20`. The previous meta.json is kept as `meta.json.pre-onpol` on the train VM.

## Head-to-head for `@genclass/runtime-model@0.2.0`: `r17-v2d` (SIM labels, mass gate) vs `r17-v2dT` (T1 labels, gain gate), baseline `r17-v2c` (2026-10-08 11:45 UTC)

All numbers below come from the **shipped q8 ONNX files** (onnxruntime CPU on the exported file, packed like the
runtime; `collect_onnx.py`), with temperatures (per kind + per header) fitted on q8 sim2e dev and gates + `gate.report`
fitted on q8 dev records (sim2g + on-policy a/b dev + REAL eval rows outside REAL's test split + REAL dev; 95% Wilson at
0.8 × the limits; certification rule) and verified on q8 test records (on-policy b test 20k + sim2e + sim2f + sim3e
(v2.3 slice) + on-policy a test; REAL eval sets' test splits — v2-eval for every trigger but inconsistency, v23-eval for
inconsistency). v2d and v2dT: from v2c, identical data and schedule (1.5B tokens; sim2r, v2.3 gold, on-policy a,
REAL v2c + v2d/v23e top-ups minus both eval sets); v2dT's action labels = softmax(gain/τ = 1) on every SIM/REAL bucket.
q8 export: MatMulNBits 8-bit **block 16** (parity fix; 10.16 MB, fp16-free).

| | v2c (baseline) | v2d (mass) | v2dT (gain) |
|---|---|---|---|
| q8 vs PyTorch argmax / gate@0.8 / max \|Δp\| | 223/223 / 99.5% / 0.056 | 223/223 / 100% / 0.034 | 223/223 / 100% / 0.048 |
| fp16 argmax / max \|Δp\| | 223/223 / 0.011 | 223/223 / 0.020 | 223/223 / 0.023 |
| action / diagnosis acc: sim2e | 77.8 / 85.2 | 77.8 / 85.2 | 73.9 / 85.4 (labels differ) |
| sim3e (v2.3) | 75.7 / 84.0 | 75.5 / 84.4 | 70.7 / 84.2 |
| real2e / real3e | 79.9 / 84.0 · 77.5 / 84.3 | 80.2 / 84.9 · 77.6 / 85.9 | 77.8 / 85.5 · 71.9 / 86.4 |
| gates (dev-fitted) | guard 0.80 (mutation 0.85); heal 0.80 (failure 0.90, inconsistency 0.80, stall 0.85) | guard 0.80 (delivery 0.85, mutation 0.90); heal 0.85 (failure 0.95, inconsistency 0.80) | gain: guard 6.0 (mutation never); heal 4.0 (failure 6.0, inconsistency 2.5) |
| **guard** test: FIR SIM / REAL | 0.016% / 0.00% | 0.006% / 0.00% | 0.003% / 0.00% |
| guard recall clear / gain captured | 1.8% / 1.3% | 1.4% / 0.95% | 1.8% / **2.3%** |
| **heal** test: FIR SIM [CI] / REAL | 0.21% [0.17, 0.24] / 0.00% | 0.07% [0.05, 0.09] / 0.00% | 0.105% [0.07, 0.13] / 0.00% |
| heal harm SIM / REAL | 0.05% / 0.06% | 0.02% / 0.02% | 0.02% / 0.03% |
| heal recall clear / REAL action recall / gain captured | 6.0% / 9.8% / **5.2%** | 3.2% / 5.5% / 4.4% | 4.8% / 0.7% / 4.4% |
| `gate.report` (dev) | 0.97 | 0.99 | 0.99 |
| detection: false on gold-expected (onpol-b / sim2e / sim3e) | 0.21 / 0.15 / 0.13% | 0.03 / 0.05 / 0.00% | 0.00 / 0.00 / 0.00% |
| detection right, REAL held-out apps: duplicate / stale / genuine-break | 64% / 1.7% / 22% | 41% / 0% / 14% | 41% / 1.7% / 14% |

**Equal safety** (comparison only, not used for shipping: one global threshold / margin swept on the same q8 test
records, best gain captured with SIM FIR ≤ the target; heal mode / guard mode):

| FIR ≤ | v2c heal gain (recall clear) | v2d | v2dT | v2c guard gain | v2d | v2dT |
|---|---|---|---|---|---|---|
| 0.05% | 1.6 (2.2) | 1.6 (2.0) | **2.1** (2.8) | 2.0 | 1.4 | **2.6** |
| 0.1% | 2.8 (3.8) | 2.5 (3.5) | **3.4** (4.3) | **3.9** | 2.4 | **3.9** |
| 0.2% | 4.6 (6.3) | 5.3 (6.7) | **6.2** (7.2) | **6.4** | 5.1 | 5.9 |
| 0.5% | 8.3 (10.6) | 10.0 (11.8) | **12.3** (13.3) | 10.1 | 9.6 | **10.9** |

REAL action-case recall at FIR ≤ 0.5%: heal v2dT 6.7% vs v2d 3.7% vs v2c 5.4%; guard 14.1% vs 3.1% vs 3.4%.
Reading: at equal FIR **v2dT (gain gate) captures the most expected gain** — +20–35% over v2d/v2c in heal mode, ties
v2c in guard — and the most REAL action recall; with the shipped dev-fitted gates its margins come out conservative
(heal FIR 0.105%), so its shipped heal gain (4.4%) equals v2d's and is below v2c's (5.2% at twice the FIR), and its
REAL action recall at the shipped margins is low (0.7%: REAL action cases sit below margin 4). v2d is the most
conservative; v2c ranks first at its shipped point only because its dev fit allowed a looser heal gate.
Deliveries (train VM, ORT-web 223/223): `~/gcl/train-out/v2dT/r17/` (2.0.0-rc4t), `v2d/r17/` (2.0.0-rc4),
`v2c-q8/r17/` (2.0.0-rc3b).

## `@genclass/runtime-model@0.2.0` = `r17-v2dT` (gain gate, aggressiveness profiles; 2026-10-08 16:30 UTC)

Refit of all three candidates on q8 outputs with REAL's certification dev set (`v23-cert`, 427,576 rows, dev-split apps,
clustered by trajectory `meta.seed`) added to dev, on-policy rows only from the shipping-gate policy, cluster-robust
95% Wilson bounds at the limit (no extra margin), per-trigger values only where certified (else tier default; `error`
default/never), guard thresholds raised jointly when needed so heal-mode limits also hold (one guard set serves both
modes). Profiles (coordinator 15:50): cautious = guard FIR/harm ≤ 0.1/0.2%, heal ≤ 0.5/1%, report false ≤ 1% REAL / 2%
SIM; **balanced** (top-level `gate`) = guard ≤ 0.3/0.3%, heal ≤ 1/1%, report ≤ 2/3%; eager = guard ≤ 1/1%, heal ≤ 3/3%,
report ≤ 5/6%. Held-out test (q8): shipping-gate on-policy a/b test + sim2e + sim2f + sim3e; REAL eval test splits.

| model / profile | guard FIR / harm | guard recall clear / REAL act / gain | heal FIR / harm (SIM / REAL) | heal recall clear / REAL act / gain | report | detection right: dup / stale (v2, v2.3) / broken |
|---|---|---|---|---|---|---|
| **v2dT cautious** | 0.005 / 0.007% | 2.4 / 1.4 / 3.1% | 0.26 / 0.06 / 0.00% | 3.7 / 3.8 / 3.2% | 0.95 | 72% / 14, 28% / 0% |
| **v2dT balanced** | 0.13 / 0.03% | **7.8 / 7.5 / 6.7%** | 0.59 / 0.11 / 0.02% | 7.1 / 10.4 / 5.7% | 0.90 | 75% / 21, 30% / 6% |
| **v2dT eager** | 0.54 / 0.11% | 14.2 / 21.0 / 12.5% | 1.84 / 0.29 / 0.16% | 17.1 / 24.2 / 14.2% | 0.70 | 77% / 40, 45% / 13% |
| v2d cautious | 0.03 / 0.00% | 2.9 / 0.4 / 2.6% | 0.15 / 0.03 / 0.06% | 3.3 / 14.9 / 4.1% | 0.95 | 72% / 12, 23% / 6% |
| v2d balanced | 0.07 / 0.02% | 4.5 / 1.4 / 4.2% | 0.41 / 0.08 / 0.13% | 7.9 / **21.8 / 8.1%** | 0.90 | 74% / 21, 28% / 6% |
| v2d eager | 0.59 / 0.11% | 13.5 / 6.4 / 12.0% | 1.48 / 0.34 / 0.28% | 16.0 / 33.2 / 14.5% | 0.70 | 77% / 41, 45% / 13% |
| v2c balanced | 0.06 / 0.01% | 3.1 / 0.4 / 2.1% | 0.36 / 0.08 / 0.04% | 5.4 / 13.2 / 5.1% | 0.90 | 74% / 22, 25% / 8% |

All profiles meet their limits on held-out test (REAL FIR 0.00% throughout). Choice: v2d and v2dT tie on total shipped
gain at balanced (12.3 vs 12.4 points guard+heal); v2dT wins guard mode clearly (+61% gain, 5× REAL action recall) and
the cautious guard profile, v2d wins heal mode (+42% gain, 2× REAL action recall); detection quality is equal (v2dT
slightly ahead on stale). **v2dT ships as 0.2.0** (guard is the first active mode after observe); a heal-heavy
deployment would be better served by v2d — candidate for a later per-mode model choice. Staged:
`packages/runtime-model/files/r17-0.2.0/` and `train:~/gcl/train-out/v2dT-0.2.0/r17/` (meta.json sha256 73b63b4d…cab07,
model.json 3f792892…169daf; q8 10.16 MB, fp16 13.57 MB; ORT-web WASM 1 thread 182 / 330 / 599 ms; parity 223/223).
`meta.gate` = balanced (`kind: "gain"`, `tauGain` 1) + `gate.profiles` {cautious, balanced, eager}.
