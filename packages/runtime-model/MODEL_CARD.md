# GenClass runtime model: model card

**`@genclass/runtime-model@0.2.0` ships `genclass-runtime-r17` 2.0.0-rc4t (training run `r17-v2dT`), with a gain gate and three aggressiveness profiles in `meta.json`. The results tables below are still those of 0.1.0 (`r17-v2b`, 2.0.0-rc2) until TRAIN's r17-v2dT numbers are copied in from `training/EVAL.md`.** It reads the
runtime's frozen situation format `situation-v2`, which `@genclass/runtime` 0.1.0-alpha.1 and later render. The
numbers below are copied from `training/EVAL.md` and `docs/runtime/RESULTS.md` in the GenClass-lib repository; those
files have the definitions and full tables.

## What it is

A Jev-style typed-decision encoder for `@genclass/runtime`. One forward pass reads a *situation* (the runtime's
`app / trigger / facts / in_flight / timeline / state / stats` text) together with typed questions (choice / noul /
score). Each question gets calibrated answers, and options are attention-isolated, so option order cannot change an
answer. For every salient trigger the runtime asks two standing questions:

- `action`: which of the applicable actions to take, each with its description;
- `diagnosis`: what is going on (`expected` / `stale` / `conflict` / `duplicate` / `inconsistent` / `failing` /
  `slow` / `overload` / `unusual` / `transient`).

It acts only when the summed probability of the permitted actions reaches the tier's threshold in `meta.json`
`gate`, **and** the top diagnosis is not `expected`. It reports a detection when the top diagnosis is not `expected`
and its probability is at least `gate.report`.

| | |
|---|---|
| backbone | ettin-encoder-17m (d 256, 7 layers: global attention in layers 1, 4, 7, 64-token sliding windows in the others) |
| parameters | 8.1M encoder + 0.7M heads |
| vocabulary | 16,364 tokens (the first 16,000 merges of the ettin tokenizer, plus markers `[Q] [O] [L] [T] [F]` = ids 16359–16363) |
| positions | `max_len` 2,048 (state plus the longest question branch), `max_total` 8,192 |
| `genclass-runtime-r17-q8.onnx` | 9.58 MB: MatMulNBits 8-bit (block 32) and int8 row-wise token embeddings. For WASM, and WebGPU without `shader-f16` |
| `genclass-runtime-r17-fp16.onnx` | 13.57 MB: fp16 weights and int8 embeddings. Needs WebGPU `shader-f16` |
| graph | inputs `input_ids, position_ids, q_group, i_group, choice_q, choice_items, score_q, score_items, noul_q, noul_t, noul_f`; outputs `choice_logits, score_logits, noul_logits` |
| parity | onnxruntime-web q8 vs PyTorch: 223/223 decisions |

**Latency** (onnxruntime-web 1.30, WASM, 1 thread, q8): about 176, 320 and 583 ms at 500, 780 and 1,170 sequence
tokens. WebGPU is much faster, and so is 4-thread WASM on crossOriginIsolated pages. Normal traffic makes no model
calls: the runtime asks only about salient situations.

## Results on held-out data

Accuracy on held-out test sets: `sim2e` is simulated apps, `sim2f` is simulated apps with held-out app features, and
`real2e` is real apps run in Chromium. The false-intervention rates (FIR) here use the fixed 0.9 / 0.8 gates.

| set | action | diagnosis | guard FIR @0.9 | heal FIR @0.8 | ECE (action) |
|---|---|---|---|---|---|
| sim2e | 77.8% | 84.2% | 0.01% | 0.50% | 0.023 |
| sim2f | 77.0% | 80.6% | 0.00% | 0.70% | 0.022 |
| real2e | 80.0% | 83.6% | 0.00% | 0.31% | 0.021 |

**Shipped action thresholds** (`meta.json` `gate`). They were fitted on dev data under these limits: FIR ≤ 0.1% and
harm ≤ 0.2% for guard; FIR ≤ 0.5% and harm ≤ 1% for heal. Each limit holds at the 95% upper confidence bound, and
the thresholds were then verified on test.

| tier | thresholds | FIR, simulated (95% CI) | FIR, real apps | recall on clear cases |
|---|---|---|---|---|
| guard | default 0.80; delivery 0.75, mutation 0.95, request 0.75 | 0.02% [0.00, 0.06] | 0.00% | 1.8% |
| heal | default 0.85; failure 0.90, inconsistency 0.80, request 1.0, transition 0.55 | 0.23% [0.14, 0.29] | 0.00% | 6.0% |

**Observe-mode detections** (`gate.report` = 0.85):
- On real apps never trained on, it detects about 76% of duplicate submits and 28% of stale overwrites, with 0.36%
  false detections on clean or benign traffic.
- On the simulated test sets, 1.1% and 1.7% of rows whose correct diagnosis is `expected` are detected.
- 0.85 is the one test-informed choice. The dev fit gave 0.70: it detects more (stale 43%), but it failed the
  simulated false-detection limit on test.

**Reading.** The model is safe and rarely wrong when it acts, but it acts rarely. In guard mode it intervenes in
about 2% of clear stale or duplicate cases. Its main value today is observe mode: plain-English detections with the
evidence. Later training rounds (a 150M teacher, distillation, on-policy rounds) target recall.

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
- Developer `ask` / `decide` questions work for short factual questions about the current situation. It is a 17M
  encoder, not a general reasoner.
