# training/ — the GenClass runtime model

How the model behind `@genclass/runtime` is built: vocabulary pruning, a synthetic stage-1 curriculum,
training on the Azure CPU cluster, evaluation with the product metrics, and ONNX export for the browser.
Owner: TRAIN. Results: `EVAL.md`. Day-by-day record and costs: `LOG.md`. Requests to other workstreams: `NEEDS.md`.

Everything heavy runs on Azure VMs (never on the Mac). `training/node.sh HOST sync|'cmd'|get|put` wraps
ssh/rsync with timeouts: it pushes `training/` to `~/gcl-train/training/` and the parent repo's `jev_local/`
and `scripts/` to `~/jev/` on the node, and runs commands in `~/gcl-train` with `PYTHONPATH=~/jev:~/gcl-train/training`
and `$PY` = the node's `~/jev/.venv/bin/python` (torch 2.14 CPU, transformers 5.18, onnx 1.23.1, onnxruntime 1.30.0).

## Models

| id | init | backbone | vocab | heads | licence of inputs |
|---|---|---|---|---|---|
| **R32** | v1 `models/jev-local-fast` (GenClass 0.1, 32M) | ettin-32m: d 384, 10 layers | 16,364 (pruned) | v1 heads | v1 = Apache-2.0, trained only on our synthetic `data/cu` + `data/gen`; ettin MIT |
| **R17** | `jhu-clsp/ettin-encoder-17m` (MIT) | ettin-17m: d 256, 7 layers | 16,364 (pruned) | fresh | ettin MIT |

Hygiene: no TRAIN script reads `jev-local-fast-v2`, `meharsjev-68m-z`, `z-cal-*`, `z-mid*` or any benchmark /
third-party dataset. Training data = the stage-1 curriculum (this directory), v1 `data/gen` (all) and a slice of v1
`data/cu` as replay, and (stage 2) SIM rows from `sim/`.

## 1. Vocabulary pruning — `prune_vocab.py`

```
$PY training/prune_vocab.py prune --src ~/jev/models/jev-local-fast --out models/r32-v16k --merges 16000
$PY training/prune_vocab.py prune --src ~/jev/models/base/ettin-encoder-17m --out models/base/ettin-17m-v16k --merges 16000
$PY training/prune_vocab.py analyze --src ~/jev/models/jev-local-fast --group runtime=training/samples/runtime_samples.txt ...
```

Keeps the first N BPE merges (closed under composition, checked), all 243 byte symbols and all 119 added tokens
(specials, whitespace runs, `[unused*]`, markers), remaps ids (ids < 245+N unchanged, added tokens move down) and
slices the embedding table. Every string still encodes (BPE stops before the first dropped merge). N = 16,000 was
chosen from the inflation table in `LOG.md` (+10.8% tokens on runtime-like text vs the 50k vocabulary).
Tests: `training/tests/test_prune_vocab.py` (encodes everything, ids in range, markers special and unforgeable,
identical logits when tokenisation is unchanged, HF base → `init_model`).

## 2. Stage-1 curriculum — `curriculum/`

`generate.py` writes CONTRACT-D rows (`{id, split, family, state, questions, labels, meta}`); 800k train rows in
≈ 10 s on 72 processes. Exact labels from an explicit world model (`world.py`: ops, user actions, field versions,
baselines), many surface forms (`fmt.py`: op-ref styles, 6 time formats, 4 timeline line formats, key-name
variants, ≥ 5 paraphrases per fact with held-out phrasings for test), 62 app domains (`vocab.py`, 13 held out
for test).

- **Decision rows (58%)**: a runtime-like situation (`app, trigger, facts, in_flight, timeline, state, stats`) plus
  the standing questions `action` (applicable actions with descriptions, random order, 10% renamed labels,
  15% distractor plugin actions) and `diagnosis` (9 labels, paraphrased descriptions, 20% subsets), plus 0–3
  primitive questions about the same trace. Scenarios per trigger (`scenarios.py`, `scen_ops.py`,
  `scen_state.py`): stale typeahead/detail/autosave/live-update writes vs fresh, older-writer-in-between and
  same-chain writes; double submits and same-render duplicate GETs vs deliberate repeats, refreshes, polling and
  typing bursts; retry storms, failure streaks, outages with cache; transient vs non-idempotent failures,
  idempotency keys, Retry-After, offline, long-poll timeouts, app retry loops; tail-latency stalls vs normal slow
  endpoints, degraded APIs and uploads; partial-failure invariant breaks vs relations explained by a simultaneous
  change; novel transitions vs common variants and thin history; render crashes after bad writes vs
  third-party/benign errors. About 55% of decision rows have the passive action as the best answer.
  Genuinely ambiguous cases carry soft labels that lean passive.
- **Ask rows (14%)**: the same situations with 2–5 primitive questions only (sometimes without the facts, so the
  answer must be derived from the timeline/state): happens-before, out-of-order responses, in-flight counts, root
  user action, same-root, field changed since, newer writer, versions behind, identical earlier request, same
  action, gap, failure streak, last outcome, latency ratio buckets, beyond p95, failure kind, retry safety.
- **Standalone primitives (28%)**: JSON invariants (sum/count/membership/uniqueness/non-negative), HTTP semantics
  (status class, retryability, Retry-After, auth, side, rejected field), JS errors (kind, first-party, component),
  and described-option decisions (the right option follows from the description).

Tests: `training/tests/test_curriculum.py` (validity against the trainer's own label parser, determinism,
held-out domains/templates, label consistency, passive share, version semantics vs decision labels).

## 3. Training

Stream mode of `jev_local/train/train.py` over `data/s1/{cur1/shard*.jsonl, gen/train.jsonl, cu/train.jsonl}`
with `configs/mix_s1.json` (token shares cur1 0.90 / gen 0.04 / cu 0.06; gen is capped at 2 repeats so it ends
up ≈ 0.7%), DDP over torchrun/gloo with `--grad-accum 4 --balance` (exact-layout cost dealing), via
`/Users/meharkhanna/jev/scripts/launch_run.sh`:

```
COMMON="--stream $G/data/s1 --stream-cache $G/cache/s1 --mixture $G/training/configs/mix_s1.json --runs-dir $G/runs \
  --max-len 1536 --batch-tokens 8192 --grad-accum 4 --balance --amp --no-grad-ckpt --device cpu --log-every 10 \
  --ckpt-every 100 --passes 2 --seed 0"
scripts/launch_run.sh r32-s1 10.0.0.7 4 20 "c02 c03 c04 c05 c06 c07 c08" -- $COMMON \
  --base $G/models/r32-v16k/backbone --init-from $G/models/r32-v16k --out $G/models/r32-s1 --lr 1.5e-4 --head-lr 6e-4 --resume
scripts/launch_run.sh r17-s1 10.0.0.14 4 20 "c09 c10 c11" -- $COMMON \
  --base $G/models/base/ettin-17m-v16k --out $G/models/r17-s1 --lr 3e-4 --head-lr 2e-3 --resume
```
(`G=/home/azureuser/gcl-train`; the curriculum must be sharded — the exact-layout cache is built per file.)

## 4. Evaluation — `eval_runtime.py`

```
$PY training/eval_runtime.py --ckpt models/r32-s1 --data data/cur1 --split test --fit-split dev --out out/eval-r32-s1.json
```
Per question group (action, diagnosis, other choice, noul, score): accuracy, NLL, Brier, ECE. Decisions: the
runtime gate (non-passive top action, p ≥ 0.9 guard / 0.8 heal, top diagnosis ≠ expected) per mode, with the
false-intervention rate on rows whose best action is passive, precision of fired actions and recall, per trigger,
plus a threshold sweep and diagnosis confusion. Temperatures are fitted on `--fit-split` and checked split-half.

## 5. Export — `export_runtime.py` (+ `ortweb/validate.mjs`)

```
$PY training/export_runtime.py --ckpt models/r17-s1 --out out/export-r17 --name genclass-runtime-r17 --version 0.1.0 \
    --data-rows data/cur1/dev.jsonl,$HOME/jev/data/gen/dev.jsonl --calibration out/cal-r17.json
cd ortweb-run && node validate.mjs ../out/export-r17 q8     # onnxruntime-node + onnxruntime-web 1.30 (WASM in Node)
```
Graph: `scripts/genclass_export.py`'s `ExportModel` (imported; inputs/outputs identical to GenClass 0.1). Variants:
`q8` = MatMulNBits 8-bit block 32 on every MatMul (Gemm layers are rewritten to MatMul first) + int8 row-wise token
embeddings (Gather int8 → Cast → Mul by a per-row scale); `fp16` = fp16 weights + the same int8 embeddings.
Writes the model directory MODEL's loader reads (`model.json` format `genclass-runtime-model/1` with bytes and
sha256, `tokenizer.json`, `calibration.json`, `meta.json` incl. marker ids) and parity/JS fixtures.
