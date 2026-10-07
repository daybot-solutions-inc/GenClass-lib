# TRAIN needs (relayed by the lead)

Status legend: OPEN (needed), ASK (would help), DONE.

## SIM → TRAIN (stage 2 data)

1. **OPEN: where and how much.** Stage 2 needs ≥ 1M train rows (target 1–2M), ≥ 20k dev and ≥ 40k test rows, with
   held-out domains and program families only in test (CONTRACT §11). Please write them on the `train` VM under
   `~/gcl/sim/out/<run>/{train,dev,test}/shard-NNNN.jsonl` (or `.jsonl.zst`), **≤ 50k rows per shard** (the trainer
   builds its exact-layout cache per file in parallel; one huge file takes minutes single-threaded), and tell the lead
   the path + row counts. TRAIN pulls them to the cluster over the private network.
2. **OPEN: row format** = CONTRACT-D exactly as the runtime handed it to the decider:
   `{"id", "split", "family", "state", "questions", "labels", "meta"}`.
   - `labels.action`: `{"type":"choice","dist":{...}}` over the offered action names (soft labels from costs are fine;
     ties favour the passive action); `labels.diagnosis`: `{"type":"choice","label":...}` or a `dist`.
   - Rows whose trigger offers a single action have no `action` question/label (like the runtime).
   - `ask` rows: any choice/noul/score questions with exact labels.
3. **OPEN: meta** that the evaluation needs (TRAIN reports precision / false interventions per trigger and per
   domain/family): `meta.trigger`, `meta.passive` (passive action name), `meta.domain`, `meta.program_family`,
   `meta.costs` (`{action: cost}` for the offered actions, so the harm of each non-passive action on passive-best rows
   can be reported), and for renamed/paraphrased vocabularies the mapping back to canonical names
   (`meta.action_names` `{canonical: shown}` if options are renamed).
4. **ASK:** a few thousand clean-run rows (no chaos, correct app behaviour: every non-passive answer is a false
   positive) as their own family or flag (`meta.clean: true`), so TRAIN can report the false-intervention rate on
   clean traffic directly.

## CORE → TRAIN

5. **ASK:** keep `ACTION_INSTRUCTIONS`, `DIAGNOSIS_INSTRUCTIONS` and the action/diagnosis descriptions stable from now
   on (or tell TRAIN when they change): stage 1 already trains on the exact wording read from
   `packages/runtime/src/situation/{questions,facts,describe,build,serialize}.ts` (2026-10-07), and per-header
   calibration (`calibration.json` `by_header`) is keyed on the exact instruction text.

## MODEL → TRAIN

6. **DONE (TRAIN side):** the exported model directory follows MODEL's card format `genclass-runtime-model/1`
   (`format`, `variants.{q8,fp16}.{file,bytes,sha256,provider,needs}`, `files.{tokenizer,calibration,meta}` with
   bytes + sha256). `meta.json` carries `markers`, `cls_id`, `sep_id`, `pad_id`, `max_len`, `max_total`, `inputs`,
   `outputs`. The pruned vocabulary moves the marker ids to 16359–16363: read them from `meta.json`/`tokenizer.json`.
7. **ASK:** the q8 file uses `MatMulNBits` (8-bit, block 32) and an int8 token-embedding table (Gather int8 → Cast →
   Mul by a per-row scale). It runs in onnxruntime-web 1.30 WASM (validated in Node). Please confirm it also loads
   under the WebGPU EP in a browser (the int8 Gather and MatMulNBits may fall back to WASM kernels; fine if it works).
