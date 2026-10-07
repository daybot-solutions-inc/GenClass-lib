# GenClass runtime model — evaluation

Stage 1 (synthetic curriculum). Stage 2 (SIM rows from the real runtime) is pending SIM data. All numbers are on
held-out data: test rows come only from app domains never seen in training (13 of 62 domains) and use held-out
paraphrases for half of their templated sentences. Evaluated with `training/eval_runtime.py` on `c01`.

## Metrics

- **action acc / diagnosis acc**: top-1 vs the label's best option (soft labels: argmax).
- **The runtime gate** (CONTRACT §8): the runtime executes a non-passive action only if it is the top action,
  `p(action) ≥ 0.9` for guard-tier actions (discard, defer, coalesce, delay) or `≥ 0.8` for heal-tier actions
  (block, serve_cached, retry, hedge, rollback, resync), **and** the top diagnosis is not `expected`.
  - *guard mode*: only guard-tier actions may fire. *heal mode*: guard + heal tiers.
  - **FIR (false-intervention rate)** = fired non-passive actions on rows whose best action is passive ÷ such rows.
    This is the "false positives kill the product" number.
  - **precision** = fired actions that equal the best action ÷ all fired actions; **recall** = fired correct
    actions on rows whose best action is non-passive ÷ such rows.
- **ECE** (15 bins, top-1 confidence) after temperature scaling fitted on the dev split (per kind; `group` = separate
  temperatures for the `action` and `diagnosis` questions; `header` = per exact runtime instruction text), with a
  split-half check on dev (fit on half, evaluate on the other half).

## Test sets

| set | rows | what |
|---|---|---|
| `rt1/test` | 12,000 | runtime-exact rendering only (`curriculum/rt.py` = CORE's situation format), held-out domains |
| `cur1/test` | 12,000 | the varied surface styles (key names, time formats, line formats, paraphrases), held-out domains |
| `cur2/test` | 8,000 | 60/40 runtime-exact / varied |
| SIM sample | 200 | `sim/samples/sample.jsonl`: real runtime situations labelled by SIM's counterfactual costs (zero-shot; never trained on) |

(Results below.)
