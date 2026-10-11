# GenClass runtime model: model card

**`@genclass/runtime-model@0.2.0` ships `genclass-runtime-r17` 2.0.0-rc4t (training run `r17-v2dT`), with a gain
gate and three aggressiveness profiles in `meta.json`.** It reads the runtime's frozen situation format
`situation-v2`, which `@genclass/runtime` 0.1.0-alpha.1 and later render. The numbers below are copied from
`training/EVAL.md` and `docs/runtime/RESULTS.md` in the GenClass-lib repository; those files have the definitions
and full tables.

## What it is

A Jev-style typed-decision encoder for `@genclass/runtime`. One forward pass reads a *situation* (the runtime's
`app / trigger / facts / in_flight / timeline / state / stats` text) together with typed questions (choice / noul /
score). Each question gets calibrated answers, and options are attention-isolated, so option order cannot change an
answer. For every salient trigger the runtime asks two standing questions:

- `action`: which of the applicable actions to take, each with its description;
- `diagnosis`: what is going on (`expected` / `stale` / `conflict` / `duplicate` / `inconsistent` / `failing` /
  `slow` / `overload` / `unusual` / `transient`).

**Gain gate.** The action labels of `r17-v2dT` are `softmax(gain / τ)` with τ = 1, where gain is the expected
counterfactual cost saved by each action over doing nothing. The runtime acts only when the model's expected gain
of the best permitted non-passive action clears the margin for that tier and trigger (`meta.json` `gate`,
`kind: "gain"`), **and** the top diagnosis is not `expected`. It reports a detection when the top diagnosis is not
`expected` and its probability is at least `gate.report`. `gate.profiles` holds the three profiles; the top-level
`gate` is `balanced`.

| | |
|---|---|
| backbone | ettin-encoder-17m (d 256, 7 layers: global attention in layers 1, 4, 7, 64-token sliding windows in the others) |
| parameters | 8.1M encoder + 0.7M heads after vocabulary pruning |
| vocabulary | 16,364 tokens (the first 16,000 merges of the ettin tokenizer, plus markers `[Q] [O] [L] [T] [F]` = ids 16359–16363) |
| positions | `max_len` 2,048 (state plus the longest question branch), `max_total` 8,192 |
| `genclass-runtime-r17-q8.onnx` | 10.16 MB (10,160,186 bytes): MatMulNBits 8-bit (block 16) and int8 row-wise token embeddings, fp16-free. For WASM, and WebGPU without `shader-f16` |
| `genclass-runtime-r17-fp16.onnx` | 13.57 MB (13,569,879 bytes): fp16 weights and int8 embeddings. Needs WebGPU `shader-f16` |
| graph | inputs `input_ids, position_ids, q_group, i_group, choice_q, choice_items, score_q, score_items, noul_q, noul_t, noul_f`; outputs `choice_logits, score_logits, noul_logits` |
| parity | onnxruntime-web q8 vs PyTorch: 223/223 decisions (block 32 lost parity; block 16 restored it) |

**Latency** (onnxruntime-web 1.30, WASM, 1 thread, q8): about 182, 330 and 599 ms at 500, 780 and 1,170 sequence
tokens, so about 180 ms per decision at the single-thread situation budget. WebGPU is much faster, and so is
4-thread WASM on crossOriginIsolated pages. Normal traffic makes no model calls: the runtime asks only about salient
situations.

## Results on held-out data

### Shipped profiles (0.2.0, `r17-v2dT`)

Gates were fitted on the outputs of the shipped q8 file, on dev data (simulated apps, on-policy rows from the
shipping gate, and a real-app certification set counted per trajectory), as the lowest margin per tier and trigger
whose cluster-robust 95% Wilson upper bound meets the profile's limits, then verified on held-out test. FIR is the
false-intervention rate (the gate fired where doing nothing was best); harm is the share of decisions whose action
made the outcome worse; recall is on clear cases (simulated) and on actionable real-app cases; gain is the share of
the available counterfactual improvement captured.

| profile | limits (guard FIR / harm; heal FIR / harm) | guard FIR / harm | guard recall (clear / real) | guard gain | heal FIR / harm | heal recall (clear / real) | heal gain | report | detected (duplicate / stale / broken) |
|---|---|---|---|---|---|---|---|---|---|
| `cautious` | 0.1 / 0.2%; 0.5 / 1% | 0.005% / 0.007% | 2.4% / 1.4% | 3.1% | 0.26% / 0.06% | 3.7% / 3.8% | 3.2% | 0.95 | 72% / 28% / 0% |
| **`balanced`** (default) | 0.3 / 0.3%; 1 / 1% | 0.13% / 0.03% | 7.8% / 7.5% | 6.7% | 0.59% / 0.11% | 7.1% / 10.4% | 5.7% | 0.90 | 75% / 30% / 6% |
| `eager` | 1 / 1%; 3 / 3% | 0.54% / 0.11% | 14.2% / 21.0% | 12.5% | 1.84% / 0.29% | 17.1% / 24.2% | 14.2% | 0.70 | 77% / 45% / 13% |

FIR and harm are on simulated apps; on held-out real apps FIR was 0.00% for every profile. Every profile meets its
limits on held-out test. The project targets are guard FIR ≤ 0.1% and heal FIR ≤ 0.5%: `cautious` stays under
both, `balanced` is slightly over both, `eager` is well over.

**Gain margins** (`meta.json` `gate.profiles`; a trigger not listed uses the tier default; `mutation` never acts
in `cautious`):

| profile | guard margin: default (delivery / mutation / request) | heal margin: default (failure / inconsistency / request / stall / transition) | `report` |
|---|---|---|---|
| `cautious` | 6.0 (5.0 / never / 5.0) | 5.0 (8.0 / 3.0 / 2.5 / 1.5 / 0.75) | 0.95 |
| `balanced` | 5.0 (4.0 / 6.0 / 4.0) | 4.0 (8.0 / 2.0 / 1.5 / 1.25 / 0.5) | 0.90 |
| `eager` | 3.0 (3.0 / 4.0 / 3.0) | 2.5 (5.0 / 0.75 / 0.25 / 1.0 / 0.0) | 0.70 |

**Accuracy** on the held-out test sets (`sim2e` simulated apps, `sim3e` the `situation-v2.3` slice, `real2e` /
`real3e` real apps in Chromium), action / diagnosis: `sim2e` 73.9% / 85.4%, `sim3e` 70.7% / 84.2%, `real2e`
77.8% / 85.5%, `real3e` 71.9% / 86.4%. Action accuracy is not comparable with 0.1.0 below: `r17-v2dT`'s action
labels are gain distributions, not argmax labels.

**Calibration.** ECE has not yet been measured for 0.2.0. For `r17-v2b` (0.1.0) it was 0.021–0.023 (action).

### Previous model (0.1.0, `r17-v2b`, fixed-threshold gate)

The false-intervention rates here use the fixed 0.9 / 0.8 gates.

| set | action | diagnosis | guard FIR @0.9 | heal FIR @0.8 | ECE (action) |
|---|---|---|---|---|---|
| sim2e | 77.8% | 84.2% | 0.01% | 0.50% | 0.023 |
| sim2f | 77.0% | 80.6% | 0.00% | 0.70% | 0.022 |
| real2e | 80.0% | 83.6% | 0.00% | 0.31% | 0.021 |

**Observe-mode detections** (0.1.0, `gate.report` = 0.85; not re-measured for 0.2.0, whose profiles report at
0.95 / 0.90 / 0.70):
- On real apps never trained on, it detected about 76% of duplicate submits and 28% of stale overwrites, with 0.36%
  false detections on clean or benign traffic.
- On the simulated test sets, 1.1% and 1.7% of rows whose correct diagnosis is `expected` were detected.

**Reading.** The model is safe and rarely wrong when it acts, but it acts rarely. In guard mode at `balanced` it
intervenes in under 8% of the clear cases where acting would help. Its main value today is observe mode:
plain-English detections with the evidence. Later training rounds (a 150M teacher, distillation, on-policy rounds)
target recall.

## Training data and licence

Apache-2.0. Initialised from `jhu-clsp/ettin-encoder-17m` (MIT). It was trained only on data generated for this
project:

- **Curriculum:** about 1.2M programmatic rows of runtime situations with exact labels. They cover
  timeline/causality/version/identity/streak/baseline/invariant/transition/HTTP/JS-error primitives and
  described-option decisions.
- **SIM:** the project's deterministic simulator of combinator-built apps. Labels come from counterfactual outcomes:
  each candidate action is replayed and its cost measured.
- **REAL:** traces from about 150 web apps run in headless Chromium with the real runtime, labelled the same
  counterfactual way. 144 apps were written for the corpus. 14 are MIT-licensed open-source RealWorld front-ends,
  listed in `realapps/corpus/LICENSES.md`; their code is not part of this model, only traces of running them. Every
  row of the real-app evaluation set was excluded from training.
- **On-policy rows:** situations the previous model's own gate produced in the simulator (DAgger-style), labelled
  the same way.
- **Replay:** GenClass 0.1's synthetic generic data.

No benchmark, scraped or third-party dataset was used, and no weights from other GenClass experiments.

## Intended use and limits

- It decides generic runtime actions and diagnoses from facts the runtime observed:
  - apply / discard / defer
  - send / coalesce / delay / block / serve_cached
  - deliver / retry / serve_cached
  - wait / hedge / serve_cached
  - ignore / rollback / resync

  It never sees your source code.
- **Precision first.** About half of the training decisions have "do nothing" as the best answer. That includes
  salient-looking benign cases: older writers in between, deliberate repeats, polling, typing bursts and explained
  relation changes. Please report false interventions and false detections from your app.
- Recall on actionable cases is low (see above). The runtime fails open: while the model is loading, after an error,
  or when it answers too late, the app runs unchanged.
- Developer `ask` / `decide` questions work for short factual questions about the current situation. It is a small
  encoder (8.8M parameters), not a general reasoner.
