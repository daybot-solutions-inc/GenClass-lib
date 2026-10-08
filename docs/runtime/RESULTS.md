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
| Round 2 continues (teacher, REAL gold, DAgger, data-derived gates) | 10.4M sim gold + 51M unlabeled + 616k real | in progress | | | | |

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

## 5. Demos (v0.1 model, untrained for this; baseline only)

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
| Sim v2 unlabeled (for teacher labelling) | **51,272,078** | done (~21k rows/s per node) |
| Real-browser v2 gold (128 apps, 40+ stacks) | **616,437** (+523k unlabeled) | done; determinism 3,030/3,030, interference 0/256 |
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
