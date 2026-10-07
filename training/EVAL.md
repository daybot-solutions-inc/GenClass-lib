# GenClass runtime model — evaluation

Candidates: **R17** (ettin-encoder-17m, d 256 × 7 layers, fresh heads) and **R32** (GenClass 0.1 / ettin-32m, d 384 ×
10 layers), both with the pruned 16,364-token vocabulary. Everything here is on held-out data; all runs on Azure
(`c01`), with `training/eval_runtime.py` and `training/report.py`.

Status (2026-10-07, 23:10 UTC): **stage 1c is final; stage 2 is a pilot** on pre-freeze SIM data (`r300k`, runtime
and SIM labels changed afterwards: fact fixes, sharper action labels, the new `transient` diagnosis). The pilot
numbers show the pipeline and the direction, not the shipping model.

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

## Stage 2 pilot (SIM `r300k`, pre-freeze)

(filled in below when the evaluation finishes)
