# @genclass/runtime-model: model card

`genclass-runtime-r17` version **2.0.0-rc2** (checkpoint `r17-v2b`), package `@genclass/runtime-model@0.1.0`. It is
the default model of [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) `0.1.0-beta.0`, which
loads it from `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/`. This is a data package with no
JavaScript entry point. To self-host, copy `files/` (or run `npx @genclass/runtime fetch-model <dir>`) and point the
runtime's `model.baseUrl` at it. `npx @genclass/runtime info <dir>` checks a copy against the hashes in `model.json`.

**Status: first model for the `situation-v2` runtime format, release candidate.** In short:

- It diagnoses about 84% of held-out decisions correctly, on simulated and on real apps.
- When it acts (`guard` / `heal`), it is precise: false interventions are 0.02% (guard) and 0.23% (heal) on held-out
  simulated apps, and none were seen on held-out real apps.
- It acts on few of the cases where acting would help: 1–6% of clear cases on simulated apps, 8.5% of actionable
  real-app cases in heal mode.
- In `observe` mode (the default) it flags a problem on 1.4% (simulated) to 3.8% (real) of held-out decisions where
  nothing was wrong. On real apps those false flags were concentrated in one app.

Read [Measured quality](#measured-quality) before relying on it.

## What it is

A typed-decision encoder. One forward pass reads a *situation* (the runtime's `app / trigger / facts / in_flight /
timeline / state / stats` text) plus typed questions (choice / noul / score), and returns calibrated answers. Options
are attention-isolated, so option order cannot change an answer.

| | |
|---|---|
| Backbone | `jhu-clsp/ettin-encoder-17m` (MIT): hidden 256, 7 layers, alternating full / sliding-window (64) attention |
| Parameters | about 8.8M (8.1M encoder + 0.7M decision heads) |
| Vocabulary | 16,364 tokens: byte-level BPE pruned to the first 16,000 ettin merges, plus markers `[Q] [O] [L] [T] [F]` (ids 16359–16363) |
| Max length | 2,048 tokens per segment, 8,192 total |
| Exports | q8 for onnxruntime-web WASM (MatMulNBits 8-bit, block 32, symmetric; int8 row-wise token embeddings; no fp16 tensors); fp16 for WebGPU with `shader-f16` (fp16 weights, int8 embeddings) |
| Graph | inputs `input_ids, position_ids, q_group, i_group, choice_q, choice_items, score_q, score_items, noul_q, noul_t, noul_f`; outputs `choice_logits, score_logits, noul_logits` |

### Training

| Stage | Data |
|---|---|
| Round 1, `r17-final1` | ettin-encoder-17m, trained on the runtime-format curriculum and on SIM gold in the previous format (`situation-v1`) |
| `r17-v2a` | from `r17-final1`, 2B tokens: SIM v2 gold 86% (7.56M training rows from simulated apps), v2 curriculum replay 13%, general 1% |
| **`r17-v2b` (this model)** | from `r17-v2a`, 1B more tokens (learning rate 1e-4): SIM v2 gold 70%, **real-app gold 18%**, curriculum 11%, general 1% |

- **SIM gold:** rows from simulated apps that run on the real runtime in a deterministic virtual world. Each label is
  the expected cost of each action, given what the runtime can observe.
- **Real-app gold:** about 453k training rows from REAL batches `v2c1`–`v2c4`. They were recorded from 96 small apps:
  apps written for the corpus, plus unmodified open-source RealWorld front-ends. Scripted users drove the apps in
  headless Chromium with the real runtime, and the rows were labelled the same way as SIM.
  - The 16,600 rows of the real-app eval set were removed from training.
  - Rows from held-out apps are test-only: every Lit and SWR app, `alpine-tasks`, `xhr-autocomplete` and
    `oss-rtk-conduit`. So are rows that use three held-out app variants, in `react-search`, `vue-editor` and
    `zustand-board`.
- **No other data:** no benchmark, scraped or third-party dataset was used. The only external weights are the
  MIT-licensed ettin-encoder-17m initialisation.

**Format.** The training data was rendered by the runtime at tag `situation-v2`. The `0.1.0-beta.0` runtime renders
`situation-v2.3` and also changes how redacted values print:

| Change | What the model sees | Accounted for here? |
|---|---|---|
| v2.1 | one new fact for a stall with no latency baseline | not measured |
| v2.2 | `retry` offered only when repeating is safe | yes: the gate numbers below use v2.2 retry rules |
| v2.3 | fewer, more precise learned relations, so far fewer `inconsistency` decisions | not measured |
| redaction | the text of redacted values | not measured |

## How the runtime uses it

For each salient trigger (a request, a response about to be delivered, a mutation, a failure, a stall, an
inconsistency, a transition, an error), the runtime asks two standing questions:

- `action`: which of the applicable actions to take. Each action comes with a description; examples are deliver /
  discard / defer, send / coalesce / delay / block / serve_cached, deliver / retry, wait / hedge, and ignore /
  rollback / resync.
- `diagnosis`: expected / stale / conflict / duplicate / inconsistent / failing / slow / overload / unusual /
  transient.

What happens next depends on the mode:

- **Report (every mode).** A decision is reported as a detection (a console line, a `detect` event, the devtools
  Detections view) when the top calibrated diagnosis is not `expected` and its probability is at least `report`. In
  `observe` mode, the runtime's default, this is all that happens: nothing is held or changed.
- **Act (guard / heal).** The candidate is the most probable action the mode permits. Guard mode permits guard-tier
  actions; heal mode permits guard and heal. The candidate runs only when both of these hold:
  - the summed probability of all permitted non-passive actions reaches the threshold of the candidate's tier for
    that trigger;
  - the top diagnosis is not `expected`.

Where the thresholds come from, in order: the app's `policy.thresholds`, then this model's `meta.json` `gate`, then
the runtime defaults (report 0.6, guard 0.9, heal 0.8). `runtime.gates(trigger)` shows the values in force and the
source of each. With this model and no app override, the source is `"model"` for all three.

The model never sees app code. It sees only what the runtime observed (with secrets redacted).

## Gate thresholds

`meta.json` → `gate`:

| Trigger | Guard | Heal |
|---|---|---|
| default | 0.80 | 0.85 |
| `delivery` | 0.75 | (default) |
| `mutation` | 0.95 | (default) |
| `request` | 0.75 | 1.0 (heal-tier actions effectively never run on requests; guard-tier ones still can, at 0.75) |
| `failure` | (default) | 0.90 |
| `inconsistency` | (default) | 0.80 |
| `transition` | (default) | 0.55 |
| `stall`, `error` | (default) | (default) |
| **report** (all triggers) | | **0.85** |

Built-in guard-tier actions exist only on `delivery`, `request` and `mutation`. The guard default therefore applies
only to custom guard-tier actions on other triggers.

### Guard and heal thresholds

These were fitted by the model's trainer with `training/fit_gates.py`. The data was dev data the model never trained
on:

- `sim2g`: a 104k-row SIM dev sample;
- the real-app eval set outside its test split;
- REAL dev rows.

Rule: per tier and trigger, take the lowest summed-probability threshold that meets the limits below at the one-sided
95% Wilson upper bound, at that threshold and at every grid value above it. A trigger with too little dev data uses
the tier default.

| Limit | Guard | Heal |
|---|---|---|
| FIR: SIM passive-best rows, and real-app clean-benign plus benign-salient rows | ≤ 0.1% | ≤ 0.5% |
| Harm: the fired action costs at least 1 more than doing nothing | ≤ 0.2% | ≤ 1% |

We re-verified these gates independently with the shipped **q8 ONNX** logits, using a port of the runtime's gate code
(`parseGate`, `effectiveGates`, `gate`, calibration). The runtime applies the v2.2 retry rule: it renormalises
probabilities where it does not offer `retry`. A re-run of those rows without `retry` gave the same probabilities
(max difference 0.0). All pooled test limits are met, so the gates are unchanged.

### Report threshold

The runtime's default report threshold, 0.6, is too noisy for this model. At 0.6 on held-out test, the model flags
4.3% of gold-`expected` decisions on simulated apps and 6.2% on real apps.

We fitted `report` on dev data only, with q8 logits:

- **Rule:** the lowest grid value (0.50–0.95 in steps of 0.05, then 0.97 and 0.99) at which false findings are at most
  1.0% on SIM dev and, separately, on REAL dev, at that value and every higher one. A false finding is a detection on
  a gold-`expected` decision.
- **Dev data:** SIM is `sim2g`, 79,839 rows with 32,392 gold-`expected`. REAL is the eval set outside its test split
  plus REAL dev, with 9,841 gold-`expected` rows.
- **Result: 0.85.** The one-sided 95% upper-bound version of the rule also gives 0.85. On dev at 0.85, false findings
  are SIM 0.80% (260/32,392) and REAL 0.30% (30/9,841).

The trainer's first export carried 0.70, a dev fit against a looser limit (2% on SIM) that failed on test. The
trainer then chose 0.85 after looking at test results. Our dev-only fit reaches the same value without using test.
**Held-out test does not meet the 1% dev limit** (next section). It was not refitted on test.

## Measured quality

All numbers are on held-out data. FIR (false-intervention rate) is the share of rows where doing nothing was best but
the gate fired anyway. Recall is the share of rows that should be acted on (or flagged) where it did so. Brackets are
95% Wilson intervals.

Test sets (never trained on, never used for fitting):

| Set | Rows | Contents |
|---|---|---|
| `sim2e` | 20k | random rows of SIM's held-out test split |
| `sim2f` | 18,690 | simulated apps whose family contains an app feature held out from training (service-worker cache, presence, cascade, saga, prefetch, permissions) |
| `real2e` test | 20k | real-app test rows from 10 apps: 7 held out of training entirely, and 3 seen in training whose test rows use a held-out variant |
| Real-app eval set, test split | 1,546 | the test-split subset (held-out apps and variants) of 16,600 unambiguous recorded real-app cases (clean-benign, benign-salient, duplicate, genuine break, stale) |

### Accuracy

The trainer measured these with PyTorch on SIM test and REAL test rows:

| | Diagnosis | Action |
|---|---|---|
| Simulated apps | 84.2% | 77.8% |
| Real apps | 83.6% | 80.0% |

Our argmax cross-check with the shipped q8 export (argmax of logits against argmax of the gold target):

| Set | Diagnosis | Action |
|---|---|---|
| `sim2e` | 85.0% (12,946/15,224) | 77.6% (9,977/12,858) |
| `sim2f` | 82.4% (11,853/14,388) | 76.9% (9,156/11,909) |
| `real2e` test | 85.6% (11,892/13,894) | 80.4% (10,269/12,765) |

Row selection differs slightly from the trainer's evaluation.

### Guard and heal on test

Each mode below is measured with the shipped gates.

| Mode | FIR, SIM | FIR, real held-out | Harm | Recall |
|---|---|---|---|---|
| guard | 0.02% (2/8,987) [0.01, 0.08] | 0.00% (0/66) [0, 5.5] | SIM 0.01% (1/12,111) | 1.2% (7/602) of clear SIM cases |
| heal | 0.23% (38/16,290) [0.17, 0.32] | 0.00% (0/1,124) [0, 0.34] | SIM 0.07% (15/22,322); `real2e` 0.08% (10/12,214) | 5.7% (88/1,545) of clear SIM cases; 8.5% (36/422) of actionable real-app cases |

In heal mode, real-app recall on requests is 20.9% (36/172) and 0 on the other triggers. The trainer reports 6.0%
heal clear-case recall, and real-app duplicate recall of 8.2% (14% on held-out apps).

Per trigger, pooled `sim2e` + `sim2f` test (SIM passive-best FIR; real held-out FIR where there are benign rows):

| Trigger | Guard FIR | Heal FIR | Heal recall, clear SIM cases | Notes |
|---|---|---|---|---|
| `delivery` | 0.07% (1/1,416) | 0.07% | 2.1% (2/96) | real 0/26 |
| `request` | 0.02% (1/5,860) | 0.10% (6/5,882) | 3.8% (16/423) | real 0/40 |
| `mutation` | 0.00% (0/1,711) | 0.00% | 0% (0/84) | |
| `failure` | – | **0.66% (24/3,618) [0.45, 0.99]** | 10.2% (60/590) | **over the 0.5% heal limit on test** (dev 0.28%); `real2e` harm 0.39% (8/2,043) |
| `inconsistency` | – | 0.11% (2/1,796) | 3.8% (8/213) | real 0/1,008 |
| `transition` | – | 0.38% (5/1,311) | 1.3% (1/79) | real 0/49 |
| `stall` | – | 0.00% (0/451) | 1.7% (1/59) | |
| `error` | – | 0.00% (0/105) | – | |

We also refitted the gates on q8 dev logits with `fit_gates.py`. Two values came out differently: guard `delivery` 0.80
instead of 0.75 (one q8 dev false intervention in 3,615 rows), and heal `transition` 0.50 instead of 0.55. The
shipped values were kept, and both pass on test.

### Observe mode: detections at report 0.85

| Set | False findings (of gold-`expected` decisions) | Flagged (of gold problem decisions) | Right diagnosis (of flags) |
|---|---|---|---|
| `sim2e` | 1.11% (61/5,474) [0.87, 1.43] | 66.4% | 94.8% |
| `sim2f` | 1.72% (88/5,108) [1.40, 2.12] | 63.6% | 93.4% |
| **SIM test, pooled** | **1.41% (149/10,582)** [1.20, 1.65] | 65.0% | 94.1% |
| Real eval set, test split | 0.18% (2/1,118) [0.05, 0.65] | 46.7% | 98.0% |
| `real2e` test | 4.35% (303/6,961) [3.90, 4.86] | 61.5% | 89.1% |
| **REAL test, pooled** | **3.78% (305/8,079)** [3.38, 4.21] | 60.7% | 89.5% |
| (runtime default 0.6, for comparison) | SIM 4.31%, REAL 6.18% | SIM 82.9%, REAL 82.7% | SIM 88.0%, REAL 84.4% |

- **One app dominates the real false findings.** `real2e` test has gold-`expected` rows from only 9 apps. 240 of
  its 303 false findings come from one of them, the held-out `oss-rtk-conduit`: 240 of that app's 955
  gold-`expected` rows, flagged as `stale` on its `article.inProgress` field. That is why REAL `mutation` decisions
  show 21.8% false findings (265/1,215). Without that app, `real2e` test is 1.05% (63/6,006). The other eight apps
  range from 0.50% to 2.33% each.
- **Benign real-app cases** (clean-benign and benign-salient, eval-set test split): 0.27% (3/1,124) were flagged.
- **Flag rate by trigger:** failures, stalls and errors are flagged most often (63% or more of their problem
  decisions). Deliveries are flagged least (28–31%), and transitions on real apps only 20%.

### Calibration

`calibration.json` holds per-kind softmax temperatures fitted on the `sim2e` dev split: noul 1.0551, choice 0.9212,
score 0.8716. The runtime divides logits by them before the softmax. The `action` and `diagnosis` questions use the
choice temperature, and every threshold above assumes these calibrated probabilities. The trainer has not reported
calibration error for this checkpoint; it was 0.011 on `sim2e` for `r17-v2a`.

### Not yet met

- Diagnosis ≥ 95%.
- Clear-case recall ≥ 80%.
- Heal FIR ≤ 0.5% on the `failure` trigger on held-out data.
- Detection false findings ≤ 1% on held-out data.

## Parity and latency

The q8 export agrees with the PyTorch checkpoint on the top answer of 223 of 223 questions, in onnxruntime and in
onnxruntime-web 1.30 (WASM), with max |Δlogit| 0.848. It agrees on 191 of 191 gate outcomes at 0.8 and at 0.9. The fp16 export also agrees on 223 of 223 (max
|Δlogit| 0.474). Our own q8 collector reproduced the 223 of 223 agreement, with max |Δlogit| 0.848 against the
PyTorch fixtures.

Latency of the q8 export, measured by the trainer in Node on the training VM over the 120 parity requests (median
598 tokens):

| Backend | 500 tokens | 780 tokens | 1,170 tokens | Runtime-sized requests (89, median 772 tokens) |
|---|---|---|---|---|
| onnxruntime-web 1.30, WASM, 1 thread | 176 ms | 320 ms | 583 ms | p50 315 ms, p90 621 ms |
| onnxruntime-node, CPU, 1 thread | 35 ms | 62 ms | 115 ms | p50 62 ms |

500 / 780 / 1,170 tokens is roughly the runtime's 1,000 / 2,000 / 3,200-character situation budgets. On single-thread
WASM the runtime uses a 1,000-character budget. Multi-threaded WASM (cross-origin-isolated pages) and WebGPU are faster
in browsers; neither was measured for this checkpoint.

## Files

`files/model.json` (format `genclass-runtime-model/1`) lists every file with its size and sha256. The runtime and
`genclass-runtime info` verify them.

| File | Size | sha256 | Purpose |
|---|---|---|---|
| `genclass-runtime-r17-q8.onnx` | 9,582,526 B (9.6 MB) | `65d94e4cd4f1180abab0db6c7a6639f1e749c4cc93fda2bb5963b4652b01c4c0` | WASM (default); also runs on WebGPU without `shader-f16` |
| `genclass-runtime-r17-fp16.onnx` | 13,569,879 B (13.6 MB) | `2958f4baf3e1e6a92c603f51559da05c97a7b6a3125879a1395f521a4549b628` | WebGPU with `shader-f16` |
| `tokenizer.json` | 1,138,910 B (1.1 MB) | `11a0f913475cabb7568acc69f8fb884bbbde04edb513b9280c174b911f9e939a` | pruned byte-level BPE |
| `calibration.json` | 501 B | `843c1131bfbf947b2172392d96dcdceae1e0e0ee770febc2cb3dd0a49ab767d4` | per-kind temperatures |
| `meta.json` | 6,079 B | `0308b212152f93725fd48cdd5d81638e903bded575439232f499ca75ba2550de` | ids, graph signature, quantisation, `gate`, and the fitting records (`gate_fit`, `report_fit`, `gate_q8_check`) |
| `model.json` | 999 B | `fb682536d89da304c32a16b747eb1b1ad2c57b169ea1ee1b64caaa70ae490bbc` | manifest: variants and hashes of the files above |

Every file is under jsDelivr's 20 MB per-file limit.

## Intended use and limits

- **What it is for.** It decides generic runtime actions and diagnoses from the runtime's observed facts, inside
  `@genclass/runtime`. It is not a general classifier or reasoner. Developer `ask` / `decide` questions work for short
  factual questions about the situation.
- **Not tested on your app.** It was evaluated on simulated apps and on small real apps driven in headless Chromium.
  Run it in `observe` mode (the default) first and read what it flags before you turn on `guard` or `heal`.
- **Observe mode will show some false flags.** Expect roughly 1–4 in 100 decisions where nothing was wrong. In some
  apps, one recurring pattern can produce many of them (one held-out app: 25% of its clean decisions). Raise
  `policy.thresholds.report` to see fewer, at the cost of recall (at 0.9: SIM 0.89%, REAL 3.44%, flagged 58% / 52%).
- **Precision over recall.** It acts on few of the cases where acting would help (see the recall numbers above).
  Expect it to miss most problems. False interventions are rare but possible, and `heal` on failures (retry,
  serve_cached) is the least precise. Please report them.
- **It cannot see everything.** It does not see app code, request headers it was not shown, or server state.
- **Not a safety net.** It is not a substitute for tests, correct concurrency control or server-side validation.

## License

Apache-2.0. Base weights: `jhu-clsp/ettin-encoder-17m`, MIT.
