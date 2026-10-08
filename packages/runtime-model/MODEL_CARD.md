# @genclass/runtime-model: model card

`genclass-runtime-r17` version **2.0.0-rc2** (checkpoint `r17-v2b`), package `@genclass/runtime-model@0.1.0`. It is
the default model of [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) `0.1.0-beta.0`, which
loads it from `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/`. This is a data package with no
JavaScript entry point. To self-host, copy `files/` (or run `npx @genclass/runtime fetch-model <dir>`) and point the
runtime's `model.baseUrl` at it. `npx @genclass/runtime info <dir>` checks a copy against the hashes in `model.json`.

**Status: first model for the `situation-v2` runtime format, release candidate.** In short:

- It diagnoses about 84% of held-out decisions correctly, on simulated and on real apps.
- When it acts (`guard` / `heal`), it is precise: false interventions are 0.01% (guard) and 0.07% (heal) on held-out
  simulated apps, and none were seen on held-out real apps. Its gates were refit on the model's own on-policy traffic
  before release.
- It acts on few of the cases where acting would help: under 3% of clear cases on simulated apps (guard 0.7%, heal
  2.9%), 5.7% of actionable real-app cases in heal mode.
- In `observe` mode (the default) it flags a problem on 1.4% (simulated) to 3.8% (real) of held-out decisions where
  nothing was wrong, and on 3.1% of the model's own on-policy simulated traffic. On real apps those false flags were
  concentrated in one app.

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
| `mutation` | 0.95 | (default) |
| `failure` | (default) | **0.95** |
| `inconsistency` | (default) | 0.85 (the default, set explicitly) |
| `delivery`, `request`, `stall`, `transition`, `error` | (default) | (default) |
| **report** (all triggers) | | **0.85** |

Built-in guard-tier actions exist only on `delivery`, `request` and `mutation`, so guard acts at 0.80 on deliveries and
requests and at 0.95 on mutations. The guard default applies to custom guard-tier actions on other triggers.

### Where they come from

The model's trainer fitted these with `training/fit_gates.py` and refit them on 2026-10-08 (10:30 UTC) on the
shipped model's own distribution (`training/EVAL.md`, "r17-v2b gates refit on the shipped model's own distribution").

**Why a refit.** SIM's on-policy round b ran this model with its first gates on the `situation-v2.3` runtime. On that
traffic the first gates were too loose: 41% of heal `transition` actions (gate 0.55) were false, as were 18% of guard
`delivery` actions and 19% of guard `request` actions (gate 0.75 each; mostly `coalesce` on intended repeats).

**Dev data** (never trained on):

- `sim2g`: a 104k-row SIM dev sample;
- on-policy round b dev (33.7k rows) and round a dev (37.8k rows);
- the real-app eval set outside its test split;
- REAL dev (`real2e`).

**Rule.** Per tier and trigger, take the lowest summed-probability threshold whose 95% Wilson upper bounds meet
0.8 × each limit below on dev, with `diagnosis != expected` applied as in the runtime. A trigger gets its own threshold
only where its dev evidence (SIM and REAL) certifies every limit. Otherwise it gets max(tier default, SIM-certified
value), never less than the default. `retry` is removed where the v2.2 runtime does not offer it (unkeyed POST/PATCH).

| Limit | Guard | Heal |
|---|---|---|
| FIR: SIM passive-best rows, and real-app clean-benign plus benign-salient rows | ≤ 0.1% | ≤ 0.5% |
| Harm: the fired action costs at least 1 more than doing nothing | ≤ 0.2% | ≤ 1% |

**One test-informed value: heal `failure` 0.95.** The dev rule gave 0.90. Its held-out test FIR was 0.74%
[0.51, 0.98], over the 0.5% limit. The trainer chose 0.95 after that check: failure FIR 0.21% [0.11, 0.34], with the
gain captured on failures falling from 8.4% to 2.5%. `meta.json` records this in `gate_fit.test_informed`. Every
other value, including `report`, is the dev fit.

**History.** The first export of this checkpoint (`meta.json` 6,079 B, sha256 `0308b212…50de`) had guard `delivery`
and `request` 0.75, heal `transition` 0.55, `failure` 0.90, `inconsistency` 0.80 and `request` 1.0. The refit replaced
it before release.

### Our q8 re-verification

We re-verified the shipped gates independently with the shipped **q8 ONNX** logits, using a port of the runtime's
gate code (`parseGate`, `effectiveGates`, `gate`, calibration) and the shipped `meta.json` (sha256 `c3358947…0eb50`).
The runtime applies the v2.2 retry rule: it renormalises probabilities where it does not offer `retry`. A re-run of
those rows without `retry` gave the same probabilities (max difference 0.0).

- **Every pooled limit holds on test:** guard FIR 0.01% (≤ 0.1%), heal FIR 0.07% (≤ 0.5%), on SIM and on real apps.
- **Heal `failure` is now under its limit:** 0.19% (7/3,618) [0.09, 0.40], down from 0.66% at the first gates.
- Our test sets do not include on-policy round b test (we have no q8 records for it); the trainer's do.

### Report threshold

The runtime's default report threshold, 0.6, is too noisy for this model. At 0.6 on held-out test, the model flags
4.3% of gold-`expected` decisions on simulated apps and 6.2% on real apps.

- **Trainer's rule** (`gate_fit.report_rule`): the lowest top-diagnosis probability with false detections ≤ 1% on
  real-app clean plus benign-salient rows and ≤ 2% on SIM gold-`expected` dev rows (including on-policy a and b dev),
  at the 95% upper bound against 0.8 × each limit. **Result: 0.85.**
- **Our independent dev-only fit** with q8 logits: the lowest grid value (0.50–0.95 in steps of 0.05, then 0.97 and
  0.99) at which false findings (detections on gold-`expected` decisions) are at most 1.0% on SIM dev (`sim2g`,
  32,392 gold-`expected`) and, separately, on REAL dev (eval set outside its test split plus REAL dev, 9,841
  gold-`expected`), at that value and every higher one. **Result: 0.85** (the one-sided 95% upper-bound version also
  gives 0.85). On dev at 0.85: SIM 0.80% (260/32,392), REAL 0.30% (30/9,841).

**Held-out test does not meet the 1% limit**, and on on-policy round b test it exceeds the trainer's 2% SIM limit
(next section). It was not refitted on test.

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

Each mode below is measured with the shipped gates. The trainer's test is on-policy round b test (20k rows) +
`sim2e` + `sim2f`, plus the REAL test-split eval rows. Ours is `sim2e` + `sim2f` with q8 logits, plus the real-app
eval set's test split (FIR and action recall) and `real2e` test (harm).

| | Trainer | Ours (q8) |
|---|---|---|
| Guard FIR, SIM | 0.01% [0.00, 0.02] | 0.01% (1/8,987) [0.00, 0.06] |
| Guard FIR, real held-out | 0.00% | 0.00% (0/66) [0, 5.5] |
| Guard harm, SIM / real | 0.00% / 0.00% | 0.01% (1/12,111) / 0.00% (0/6,620) |
| Guard recall, clear SIM cases | 0.6% | 0.7% (4/602) [0.3, 1.7] |
| Guard recall, actionable real-app cases | 0.0% | 0.0% (0/281) |
| Heal FIR, SIM | 0.07% (0.17% [0.12, 0.22] with failure at 0.90) | 0.07% (11/16,290) [0.04, 0.12] |
| Heal FIR, real held-out | 0.00% | 0.00% (0/1,124) [0, 0.34] |
| Heal FIR, `failure`, SIM | 0.21% [0.11, 0.34] (0.74% at 0.90) | 0.19% (7/3,618) [0.09, 0.40] |
| Heal harm, SIM / real | 0.04% / 0.07% (failure at 0.90) | 0.04% (9/22,322) / 0.04% (5/12,214) |
| Heal recall, clear SIM cases | 5.9% (failure at 0.90) | 2.9% (45/1,545) [2.2, 3.9] |
| Heal recall, actionable real-app cases | 5.7% (requests 14%) | 5.7% (24/422) [3.9, 8.3]; requests 14.0% (24/172) |
| Heal gain captured | 3.8% | not computed |

Where the trainer's number is marked "failure at 0.90", it was reported only at the dev-rule value, before
`failure` was raised to 0.95. Raising `failure` lowers heal recall on clear SIM cases. In heal mode, every real-app
action was on a request: real-app recall on the other triggers is 0.

Per trigger, ours (q8), pooled `sim2e` + `sim2f` test (SIM passive-best FIR; real held-out FIR where there are benign
rows):

| Trigger | Guard FIR | Heal FIR | Heal recall, clear SIM cases | Notes |
|---|---|---|---|---|
| `delivery` | 0.07% (1/1,416) | 0.07% (1/1,416) | 1.0% (1/96) | real 0/26 |
| `request` | 0.00% (0/5,860) | 0.05% (3/5,882) | 4.7% (20/423) | real 0/40 |
| `mutation` | 0.00% (0/1,711) | 0.00% (0/1,711) | 0% (0/84) | |
| `failure` | – | 0.19% (7/3,618) [0.09, 0.40] | 3.6% (21/590) | `real2e` harm 0.20% (4/2,043) |
| `inconsistency` | – | 0.00% (0/1,796) | 0.9% (2/213) | real 0/1,008 |
| `transition` | – | 0.00% (0/1,311); no fires | 0% (0/79) | real 0/49; the trainer also saw 0 fires on test |
| `stall` | – | 0.00% (0/451) | 1.7% (1/59) | |
| `error` | – | 0.00% (0/105) | – | |

### Observe mode: detections at report 0.85

The report threshold and calibration did not change in the refit, so our q8 observe numbers are those of the
first export.

| Set | False findings (of gold-`expected` decisions) | Flagged (of gold problem decisions) | Right diagnosis (of flags) |
|---|---|---|---|
| `sim2e` | 1.11% (61/5,474) [0.87, 1.43] | 66.4% | 94.8% |
| `sim2f` | 1.72% (88/5,108) [1.40, 2.12] | 63.6% | 93.4% |
| **SIM test, pooled** | **1.41% (149/10,582)** [1.20, 1.65] | 65.0% | 94.1% |
| Real eval set, test split | 0.18% (2/1,118) [0.05, 0.65] | 46.7% | 98.0% |
| `real2e` test | 4.35% (303/6,961) [3.90, 4.86] | 61.5% | 89.1% |
| **REAL test, pooled** | **3.78% (305/8,079)** [3.38, 4.21] | 60.7% | 89.5% |
| (runtime default 0.6, for comparison) | SIM 4.31%, REAL 6.18% | SIM 82.9%, REAL 82.7% | SIM 88.0%, REAL 84.4% |

The trainer's held-out numbers at 0.85:

- SIM gold-`expected`: 1.1% (`sim2e`) and 1.7% (`sim2f`), the same as ours.
- **On-policy round b test: 3.1%**, over the trainer's 2% limit, on the model's own distribution. This set is not in
  our q8 sets.
- Real-app clean plus benign-salient rows: 0.36% (ours: 0.27%, 3/1,124, on the eval set's test split; row selection
  differs).
- Detection with the right diagnosis on held-out real apps: duplicate submit 76%, stale overwrite 28%.

Notes on our numbers:

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
- Detection false findings ≤ 1% on held-out data (and ≤ 2% on the model's own on-policy traffic: 3.1%).

Met by the gate refit: heal FIR ≤ 0.5% on the `failure` trigger on held-out data (now 0.19–0.21%, was 0.66–0.74%).

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
| `meta.json` | 2,602 B | `c335894748d9e1ba09885968c902adc10bbd4e816b4f2e852a5f4fe92be0eb50` | ids, graph signature, quantisation, `gate`, and the fitting record `gate_fit` (data, limits, rules, refit date, the test-informed `failure` value) |
| `model.json` | 999 B | `9e2a42bd7948014d5320104fd56f541b1d7216055d4eb858f1bbe50783afff20` | manifest: variants and hashes of the files above |

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
