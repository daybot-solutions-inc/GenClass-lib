# GenClass Runtime: results, comparisons and training log

Updated 2026-10-08. All numbers are measured on held-out data. Every recall or fix rate is reported next to its
false-intervention rate (FIR): the share of cases where doing nothing was best but the gate fired anyway. The raw
reports are in `training/EVAL.md`, `training/LOG.md`, `sim/SEPARABILITY.md`, `realapps/README.md` and
`demos/results.md`.

## 1. Model stages compared (held-out simulated apps)

| Stage | Data | Diagnosis | Action | Guard FIR | Heal FIR | Recall on clear stale/duplicate cases |
|---|---|---|---|---|---|---|
| GenClass 0.1 (no runtime training) | none | 8.0% | 37.6% | ~0% | 0.0–0.33% | ~0% |
| Stage 1: curriculum only, R17 (tested on simulated apps) | 1.2M curriculum rows | 44% | 48% | 9.7% | 18.4% | n/a (over-intervenes) |
| Stage 2 pilot, R17 | 224k pre-freeze sim rows, mushy labels | 91.1% | 78.3% | 0.00% | 0.08% | ~1% |
| **Final round 1, R17** (format v1) | 448k sim rows (phase A) | **90.5%** | **81.9%** | **0.05%** | **0.24%** | **7.7%** |
| Final round 1, R32 (format v1) | same | 89.7% | 81.8% | 0.05% | 0.22% | 5.9% |
| **r17-v2a** (format v2, first round) | 2B tokens of v2 sim gold + v2 curriculum | 84.4% | 77.9% | **0.00%** | 0.46% | 3.1% (heal clear-case 11.3%) |
| **r17-v2b** (+1B tokens with real-app gold) | sim 84.2% / real 83.6% | sim 77.8% / real 80.0% | 0.02% sim, 0.00% real (derived gates) | 0.23% sim, 0.00% real | heal 6.0% clear; real duplicate 8.2% (14% held-out apps) |
| 150M teacher (t150-v2a, 1B tokens, v2 + real gold) | sim 81.8% / real 82.0% | sim 76.5% / real 78.1% | – | – | lower than r17-v2b everywhere, so distillation was skipped |
| **r17-v2c** (+ on-policy round a, v2.2 retry labels) | sim 84.4% / real 83.7% | sim 77.8% / real 79.9% | 0.02% sim, 0.00% real | 0.22% sim, 0.00% real | guard recall on clear 2.1% (v2b 0.6%); heal gain 5.6% (v2b 3.8%); real duplicate 11.2% |
| Next: r17-v2d (mass gate) vs r17-v2dT (gain gate), winner ships as model 0.2.0 | 10.4M sim gold + 51M unlabeled + 616k real | in progress | | | | |

### r17-v2a on held-out data (details)

| Set | Diagnosis | Action | Guard FIR | Heal FIR | Recall at shipping gates | Recall at gate 0.5 |
|---|---|---|---|---|---|---|
| Sim test (`sim2e`) | 84.4% | 77.9% | 0.00% | 0.46% | heal 6.8% | heal 45% on clear cases (harm 1.8% of rows) |
| Held-out app features (`sim2f`) | 81.0% | 77.4% | 0.00% | 0.75% | heal 6.8% | – |
| **Real apps, eval set (16,600)** | – | – | **0.00%** | **0.00%** | duplicate 0.6%, stale 1.0% | **duplicate 35% (64% on held-out apps)**, broken state 10%, stale 9%, with FIR 0.05–0.35% |

**Reading.** v2 kept v1's safety and made the model much better at ranking, but the fixed 0.9/0.8 gates were
chosen before labels became expected costs and now block nearly every action. Next:
- **Thresholds:** derive per-tier, per-trigger gate thresholds from held-out data (FIR ≤ 0.1% guard / 0.5% heal on
  clean real-app and sim traffic; fit on dev, verify on test) and ship them in the model's meta.json.
- **Training:** finish the 150M teacher (with real-app gold), distil, and run DAgger rounds.

### Data-derived gate thresholds (r17-v2a)

The thresholds are fitted per tier and trigger on held-out dev data, under these constraints: FIR ≤ 0.1% (guard)
or ≤ 0.5% (heal), and harm ≤ 0.2% or ≤ 1%. Each constraint must hold at the 95% upper confidence bound. The
thresholds ship in the model's `meta.json` `gate`. Verified on held-out test (95% bootstrap intervals):

| Policy | Fires | FIR sim | FIR real apps | Harm (sim / real) | Recall on clear cases | Gain captured |
|---|---|---|---|---|---|---|
| guard, derived gates (0.70–0.90) | 0.14% | 0.03% [0.00, 0.08] | 0.00% | 0.01% / 0.00% | 2.5% | 3.0% |
| guard, fixed 0.9 | – | 0.00% | 0.00% | – | 0.2% | 0.04% |
| heal, derived gates | 0.99% | 0.19% [0.13, 0.25] | 0.00% | 0.05% / 0.04% | 5.2% | 5.1% |
| heal, fixed 0.8 | – | **0.66%** [0.56, 0.77] (over the limit) | – | – | 12.0% | 9.3% |

The derived gates keep both tiers inside their safety limits on data never used for fitting. Recall is now
limited by the model's discrimination, which is what the 150M teacher, distillation and DAgger rounds target.

### Observe mode: detection quality (r17-v2b)

A *detection* is GenClass reporting a problem, such as "this response overwrote newer state", without changing
anything. This is the phase-1 product. Detections fire when the top diagnosis is not `expected` and its probability
is ≥ `gate.report`.

| Held-out test set | Report threshold | Detected | Precision | False detections on clean real-app traffic |
|---|---|---|---|---|
| Real apps never trained on (eval set) | 0.70 | duplicate submits **76%**, stale overwrites **43%**, broken state 27% | 0.96 | 0.62% |
| Real apps never trained on (eval set) | **0.85 (shipped)** | duplicate ~76%, stale 28% | higher | **0.36%** |
| Simulated apps (sim2e) | 0.70 | 50.9% of anomalies | 0.91 | gold-expected rows: 2.59% (over the 2% limit) |
| Simulated apps (sim2e) | 0.85 | – | – | 1.11% |

Per-class precision / recall at 0.70 on sim2e:

| Class | Precision | Recall |
|---|---|---|
| failing | 0.95 | 0.78 |
| slow | 0.94 | 0.91 |
| transient | 0.88 | 0.81 |
| stale | 0.87 | 0.57 |
| duplicate | 0.80 | 0.49 |
| inconsistent | 0.97 | 0.53 |
| conflict | 0.89 | 0.54 |

The shipped threshold, 0.85, was chosen after the dev-fitted 0.70 failed the simulated false-detection limit on
test, so that one choice is test-informed. Future exports fit with a stricter dev margin.

### On-policy round a (the model acting inside the simulator)

| Gate | Acts | False interventions among acts | Harmful (≥ +1 cost) | Misses (clear action skipped) |
|---|---|---|---|---|
| shipping (0.9 / 0.8) | 2.6% of decisions | 12% | 366 | 43,662 (9.7%), mostly request and failure |
| exploratory 0.5 | 21.5% | 36% | 15,054 | 29,913 |

Where the false interventions come from:
- `coalesce` of deliberate repeated actions;
- `retry` and `serve_cached` during real outages;
- `discard` where the response wasn't actually stale;
- `rollback` / `resync` on coincidental relations.

The worst `retry` harm (POSTs that had already committed) is now prevented by the v2.2 rule: retry only when the
request is idempotent or carries an idempotency key. These rows train the next student, up-weighted.

### On-policy round b (r17-v2b with its data-derived gates, situation-v2.3)

| Gate | Acts | False among acts | Harmful | Misses |
|---|---|---|---|---|
| shipping (the model's own gates) | 1.9% | 11% | 201 (0.09% of rows) | 10.9% |
| exploratory 0.5 | 22% | 36% | 14,920 | – |

Compared with round a:
- **failure** is much cleaner: 6% of acts false, and 8 false retries vs 198, thanks to the v2.2 retry rule;
- **delivery** now acts: 99 acts, 18% false.

Remaining issues:
- the **heal transition gate (0.55) is too loose on-policy**: 41% of its acts are false. Gates are being refitted on
  on-policy dev data, falling back to the tier default where evidence is thin;
- **request** acts are 19% false, mostly coalescing deliberate repeated clicks.

### Head-to-head for model 0.2.0 (all on the shipped q8 outputs)

Shipped (dev-fitted) operating points, held-out test:

| | v2c | v2d (mass gate) | v2dT (gain gate) |
|---|---|---|---|
| guard FIR (sim) | 0.016% | 0.006% | 0.003% |
| heal FIR (sim) | 0.21% | 0.07% | 0.105% |
| heal gain captured | **5.2%** | 4.4% | 4.4% |
| heal real-app action recall | **9.8%** | 5.5% | 0.7% |
| FIR on real apps | 0.00% | 0.00% | 0.00% |

At equal safety (one global threshold swept on the same test records), v2dT captures the most:

| | heal gain at FIR ≤ 0.05 / 0.1 / 0.2 / 0.5% |
|---|---|
| v2dT | 2.1 / 3.4 / 6.2 / 12.3% |
| v2d | 1.6 / 2.5 / 5.3 / 10.0% |
| v2c | 1.6 / 2.8 / 4.6 / 8.3% |

v2dT also leads guard-mode real-app recall at FIR ≤ 0.5%: 14.1%, against 3.1–3.4%.

**Why v2dT ships conservatively.** There are too few clean real-app dev rows to certify per-trigger margins, so the
fit falls back to strict defaults. The same thin evidence pushes `gate.report` up to 0.97–0.99. Next: a large
real-app certification dev set (dev apps only), then refit all three, then pick 0.2.0 by its shipped operating
point.

**Quantization.** The q8 export was fixed by moving to MatMulNBits block 16: 223/223 decisions match PyTorch,
the file is 10.16 MB, and it is fp16-free.

### Model 0.2.0 (r17-v2dT, gain gate, three aggressiveness profiles)

Gates are fitted on the shipped q8 outputs, using the real-app certification set (counted per trajectory) and
shipping-gate on-policy rows. Results on held-out test:

| Profile | guard FIR | guard harm | guard recall (clear / real) | guard gain | heal FIR | heal harm | heal recall (clear / real) | heal gain | report | detected (duplicate / stale / broken) |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.1.0 (v2b) | 0.01% | 0.00% | 0.6% / 0% | 0.8% | 0.07% | 0.04% | – / 5.7% | 3.8% | 0.85 | 76% / 28% / – |
| 0.2.0 cautious | 0.005% | 0.007% | 2.4% / 1.4% | 3.1% | 0.26% | 0.06% | 3.7% / 3.8% | 3.2% | 0.95 | 72% / 28% / 0% |
| **0.2.0 balanced (default)** | 0.13% | 0.03% | 7.8% / 7.5% | 6.7% | 0.59% | 0.11% | 7.1% / 10.4% | 5.7% | 0.90 | 75% / 30% / 6% |
| 0.2.0 eager | 0.54% | 0.11% | 14.2% / 21.0% | 12.5% | 1.84% | 0.29% | 17.1% / 24.2% | 14.2% | 0.70 | 77% / 45% / 13% |

The 0.1.0 row comes from the earlier, stricter fit without the certification set, so it is not exactly
like-for-like. FIR on real apps is 0.00% for every profile.

Why v2dT: v2d is better in heal mode (gain 8.1% vs 5.7%, real recall 21.8% vs 10.4%), and v2dT is better in guard
mode (6.7% vs 4.2%). Guard is the default mode, so v2dT ships. Choosing the model per mode is an open item.

Targets: guard FIR ≤ 0.1% (met), heal FIR ≤ 0.5% (met), calibration error ≤ 0.02 (met: 0.009),
diagnosis ≥ 95% (not yet), clear-case recall ≥ 80% (not yet).

The stage-1 row comes from the 200 sim sample rows (`training/EVAL.md`). On its own curriculum test set, stage 1
scores 98% / 98% with 0% FIR.

## 2. R17 vs R32 (choosing the shipping model)

| Model | q8 size | WASM, 1 thread, ms at 500 / 780 / 1,170 tokens | Final round 1 diagnosis / action / guard FIR |
|---|---|---|---|
| **R17** (ettin-17m, 16k pruned vocab) | **9.58 MB** | **177 / 323 / 589** | 90.5% / 81.9% / 0.05% |
| R32 (GenClass 0.1 / ettin-32m, pruned) | 22.5 MB | 569 / 954 / 1,580 | 89.7% / 81.8% / 0.05% |
| GenClass 0.1 (original) | 57 MB | ≈ 900 at 780 | not trained for this |

**Decision:** R17 is the default on every device. It matches R32 at about a third of the size and latency. Both
q8 exports are fp16-free, so they run on WebGPU without `shader-f16`, and agree with PyTorch on 233/233 decisions
in onnxruntime-web.

## 3. Why round 1 was timid (format v1 vs v2)

From `sim/SEPARABILITY.md`:

- A linear model on the visible situation text reaches the same recall ceiling as R17, so the limit is
  information, not capacity.
- 62–82% of clear actionable rows had a benign twin with an identical fact set.
- 24% of clear rows were mislabelled `expected`, which the gate never acts on. Fixed by S1.
- Labels were hindsight-certain about things a runtime cannot observe: the user's next action, outage length,
  and whether a failed write committed. Fixed by S2, so labels are now expected cost given what is observable.

Format v2 adds measured facts (would put back a replaced value, overwrites newer typing, response changes
nothing, known-stale values, cadence, failure scope, repeat-click evidence, …). Its effect on visible-text
separability (100k rows, v1 → v2):

| Trigger | Benign look-alike rate | Linear recall at 1% FIR |
|---|---|---|
| failure | 40% → 17% | 6% → 11% |
| request | 48% → 38% | 11% → 15% |
| stall | 31% → 5% | – |
| mutation | 8% → 2% | – |
| inconsistency | – | 10% → 20% (AUC 0.73 → 0.81) |

## 4. "Never make a correct app worse" (runtime design comparison)

GenClass with an always-passive model, compared against observe mode:

| Runtime | Real apps, clean runs changed | Conduit (React/Redux RealWorld) | Demos (guard, zero actions) |
|---|---|---|---|
| v1 (store-write holds) | 4/198 (2 apps) | **never renders its home feed** | board 11 card jump-backs, editor 37 overwritten keystrokes, checkout 24 reset quantities, search clean latency 6 → 389 ms |
| **v2 (network-boundary decisions)** | **0/396** | identical, 0/30 | holds only at delivery; clean typeahead makes 0 model calls and holds for 0 ms |

Chaos runs under v2: 3/198 changed. A request held about 25 ms drew a different simulated network outcome (open
item).

## 5. Demos

### Model 0.2.0, runtime 0.1.0-beta.4 and heal/overnight (2026-10-09, local, `bench/heal/`, `NIGHT-REPORT.md`)

10 chaos + 5 clean seeds per demo and mode, Playwright, telemetry off, model served locally (WASM, 4 threads).
Chaos bug rate over the six demos (60 trials per cell); FI = false interventions on 30 clean trials.

| configuration | off | observe | guard | heal | actions guard / heal (chaos) | FI guard / heal |
|---|---|---|---|---|---|---|
| beta.4, balanced (default) | 72% | 70% | 72% | 73% | 2 / 3 | 0 / 0 |
| beta.4, cautious | – | – | 72% | 77% | 0 / 0 | 0 / 0 |
| beta.4, eager | – | 72% | 73% | 75% | 6 / 12 | 2 / 0 |
| beta.4, margin 1 for every trigger | – | – | 70% | 77% | 20 / 39 | 3 / 3 |
| A/B, beta.4 arm (simultaneous) | 72% | 72% | 70% | 70% | 3 / 1 | 0 / 0 |
| A/B, heal/overnight arm (47f292c) | 73% | 70% | 73% | 72% | 1 / 1 | 0 / 0 |

Nothing is healed at the shipped gates: candidate gains are rarely above the margins (median ≈ 0; 3–8% of
discard/retry candidates reach 4). Differences under ~5 points are noise (cautious, with no action at all, differs
from balanced by 4 points in heal). Troy (real app, 9 fault scenarios): the only bug, a duplicate order after a
lost-commit 502 and a re-tap, occurs in every mode; 0 actions, 0 false interventions.

### v0.1 model, untrained for this (2026-10-08, baseline only)

| Demo | Bug rate Off | Guard | Heal | False interventions on clean runs |
|---|---|---|---|---|
| search | 23% | 23% | 27% | 0 |
| editor | 83% | 90% | 87% | 0 |
| checkout | 70% | 77% | 83% | 0 |
| status | 100% | 100% | 100% | 0 |
| board | 57% | 63% | 77% | 0 |
| decisions | 83% | 97% | 97% | 0 |

Guard executed 0 actions. Heal took 156 actions, which fixed nothing. These numbers are re-measured with the
trained v2 model once it exists.

## 6. Data volume

| Dataset | Rows | Status |
|---|---|---|
| Curriculum (cur1–cur4) | ~1.9M | done |
| Sim v1 phase A / phase B | 600k / 1.4M | done (v1, superseded) |
| Sim v2 gold (S1+S2 labels, 46 features, 115 domains) | **10,423,855** (7.56M train / 318k dev / 2.55M test) | done, 20 nodes in ~31 min |
| Sim v2.3 gold top-up (relation-learner fixes) | **2,107,824** (inconsistency rows 5.5% → 1.6%) | done |
| Sim on-policy round a (model r17-v2a acting in the sim; DAgger) | **1,248,131** (448k at shipping gate, 672k at explore gate 0.5) | done |
| Sim on-policy round b (r17-v2b with its own gates, v2.3) | **1,094,953** | done |
| Sim v2 unlabeled (for teacher labelling) | **51,272,078** | done (~21k rows/s per node) |
| Real-browser v2 gold (158 apps, 40+ stacks) | **616,437** (+523k unlabeled) | done; determinism 3,030/3,030, interference 0/256 |
| Real-browser v2.3 top-up (relation-learner fixes) | **221,186** (real total 837,623) | done; real inconsistency triggers 18.3% → 2.6% of decisions, genuine share 10% → 40% |
| Real-app eval set (unambiguous) | **16,600** (clean-benign 4,000, benign-salient 4,000, duplicate 4,000, genuine break 3,085, stale 1,515) | done |

## 7. Training log (summary)

| When (UTC) | Event |
|---|---|
| 10-07 13:00–17:00 | Vocabulary pruned to 16k merges. q8 exports: R32 22 MB, R17 9.6 MB. Stage-1 curriculum built. |
| 10-07 17:58–19:00 | Stage 1 on 10 nodes, for both R17 and R32. |
| 10-07 19:00–20:05 | Stage 2 pilot on pre-freeze sim data: precise but timid, because the labels were mushy. |
| 10-07 23:20 | Runtime frozen as `situation-v1`. Sim phase A: 600k rows in 41 min. |
| 10-08 00:06–01:30 | Final round 1 on phase A (R32 on 6 nodes, R17 on 4). Results in §1. |
| 10-08 00:35 | Auto-shutdown disabled with the user's OK. Quota raised to 2,048 vCPU; nodes c12–c23 added. |
| 10-08 02:00–04:00 | Separability analysis led to the S1/S2 label fixes and the F1–F9 facts. Runtime batches 4–5 (network-boundary decisions). |
| 10-08 ~04:00 | `situation-v2` frozen. v2 generation launched: ~10M gold + ~50M unlabeled in the sim, ~495k real-browser rows. |
| next | 150M teacher on v2 gold, teacher labels on unlabeled rows, distil R17/R32, DAgger rounds (SIM `--on-policy`), EVAL. |

Spend to date: about $400 of Azure compute (`training/LOG.md` has the details).
