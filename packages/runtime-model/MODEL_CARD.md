# GenClass runtime model — model card

Status: **stage 1** (synthetic curriculum only; stage 2 on SIM rows from the real runtime is pending SIM data).
Numbers below are filled from `training/EVAL.md`; see it for definitions and the full tables.

## What it is

A Jev-style typed-decision encoder for `@genclass/runtime`: one forward pass over a *situation* (the runtime's
`app / trigger / facts / in_flight / timeline / state / stats` text) and typed questions (choice / noul / score),
answers calibrated per question, options attention-isolated (option order cannot change answers). The runtime asks
two standing questions per salient trigger: `action` (the applicable actions, with descriptions) and `diagnosis`
(expected / stale / conflict / duplicate / inconsistent / failing / slow / overload / unusual), and acts only when
`p(action) ≥ 0.9` (guard tier) / `0.8` (heal tier) **and** the top diagnosis is not `expected`.

| variant | backbone | params | vocab | q8 (WASM) | fp16 (WebGPU) |
|---|---|---|---|---|---|
| `genclass-runtime-r17` | ettin-encoder-17m (d 256, 7 layers) | 8.1M + heads | 16,364 | see EVAL.md | see EVAL.md |
| `genclass-runtime-r32` | ettin-encoder-32m (d 384, 10 layers), from GenClass 0.1 | 18.8M + heads | 16,364 | see EVAL.md | see EVAL.md |

Files per model directory (`model.json` format `genclass-runtime-model/1`): `<name>-q8.onnx` (MatMulNBits 8-bit
block 32 + int8 row-wise token embeddings; for onnxruntime-web WASM), `<name>-fp16.onnx` (fp16 weights + int8
embeddings; WebGPU with `shader-f16`), `tokenizer.json` (byte-level BPE, first 16,000 merges of the ettin tokenizer;
markers `[Q] [O] [L] [T] [F]` = ids 16359–16363), `calibration.json` (per-kind temperatures), `meta.json`.
Graph inputs/outputs are identical to GenClass 0.1 (`input_ids, position_ids, q_group, i_group, choice_q,
choice_items, score_q, score_items, noul_q, noul_t, noul_f` → `choice_logits, score_logits, noul_logits`).

## Training data and licence

Apache-2.0. Initialisations: `jhu-clsp/ettin-encoder-17m` (MIT) for R17; GenClass 0.1 `jev-local-fast` (ettin-32m,
MIT, fine-tuned by us only on our own synthetic computer-use and generic data) for R32. Training data: only
programmatic synthetic data written for this project — the stage-1 curriculum (`training/curriculum/`, ≈ 1.2M rows:
runtime situations with exact labels, timeline/causality/version/identity/streak/baseline/invariant/transition/
HTTP/JS-error primitives, described-option decisions), plus replay of GenClass 0.1's synthetic `data/gen` (all) and a
slice of `data/cu`. No benchmark, scraped or third-party dataset; no weights from other GenClass experiments.

## Intended use and limits

- Decides generic runtime actions (apply/discard/defer, send/coalesce/delay/block/serve_cached, deliver/retry/
  serve_cached, wait/hedge/serve_cached, ignore/rollback/resync) and diagnoses from the runtime's facts. It never sees
  app code; it only sees what the runtime observed.
- Stage-1 labels come from an explicit rule-based oracle over a synthetic world (clear-cut cases; soft labels leaning
  passive where cases are genuinely ambiguous), not from counterfactual outcomes of real apps. The held-out test uses
  unseen app domains and unseen phrasings, but it is still synthetic: expect a gap on real apps until stage 2 (SIM).
- Precision first: about 55% of decision training rows have the passive action as the best answer, including
  salient-looking benign cases (older writers in between, deliberate repeats, polling, typing bursts, long-poll
  timeouts, explained relation changes, third-party errors). Report false interventions from your app.
- Developer `ask`/`decide` questions work for short factual questions about the situation; it is a 17M/32M encoder,
  not a general reasoner.
