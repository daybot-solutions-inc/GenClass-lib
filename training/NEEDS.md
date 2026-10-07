# TRAIN needs (relayed by the lead)

Status legend: OPEN (needed), ASK (would help), DONE.

## SIM → TRAIN (stage 2 data)

1. **OPEN: volume.** Stage 2 needs ≥ 1M train rows (target 1–2M: `node dist/gen.js --rows 1200000 ...`), with
   ≥ 20k dev and ≥ 40k test rows and held-out domains / program families only in test (CONTRACT §11). The current
   `gen.js` layout (`<out>/{train,dev,test}.jsonl` + `stats.json`) is fine: TRAIN shards the files itself. Please tell
   the lead the output directory on the `train` VM (e.g. `~/gcl/sim/sim/out/r1m`) when a run is complete.
2. **DONE (verified on `sim/samples/sample.jsonl`): row format** = CONTRACT-D exactly as the runtime handed it to the decider:
   `{"id", "split", "family", "state", "questions", "labels", "meta"}`.
   - `labels.action`: `{"type":"choice","dist":{...}}` over the offered action names (soft labels from costs are fine;
     ties favour the passive action); `labels.diagnosis`: `{"type":"choice","label":...}` or a `dist`.
   - Rows whose trigger offers a single action have no `action` question/label (like the runtime).
   - `ask` rows: any choice/noul/score questions with exact labels.
3. **DONE (sample has `trigger`, `domain`, `family`, `costs`, `best`, `passive_best`, `diagnosis`): meta** that the evaluation needs (TRAIN reports precision / false interventions per trigger and per
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

6a. **ASK (measured on SIM r300k dev, 3k rows):** situation states average 963 tokens (p95 1,340, max 1,569) with the
   runtime tokenizer: the text runs at **2.4 characters per token**, not the 3.2 that `STATE_CHAR_BUDGET = 3200`
   assumes, so states are ≈ 1.3–1.4× the intended ≈ 1,000 tokens (latency scales with tokens). Suggest
   `STATE_CHAR_BUDGET ≈ 2400`, or budget with the real tokenizer. Packed requests (state + diagnosis + action) average
   1,108 tokens (p95 1,523, max 1,761), so the stage-2 model is trained with `max_len` 2048 and `meta.json`
   `max_len` = 2048.

## TRAIN status for the frozen data (2026-10-07 23:10)

- Mirrored in the curriculum (`curriculum/rt.py`, `fmt.py`, scenarios): the `transient` diagnosis, compact questions
  (bare labels / names at state budgets ≤ 1,400 chars), budgets 3,200 / 2,000 / 1,000 chars. Still to mirror when
  CORE's fix batch lands: the corrected fact wording (e.g. failure/stall "started before/after" direction, write
  counts, error-rate wording).
- Ready to run on "frozen data ready": `import_sim.sh` → `launch_s2.sh` (R17 on 6 nodes, R32 on 4) → `eval_sim.sh` →
  `export_runtime.py` → `ortweb/validate.mjs`.

## MODEL → TRAIN

6. **DONE (TRAIN side):** the exported model directory follows MODEL's card format `genclass-runtime-model/1`
   (`format`, `variants.{q8,fp16}.{file,bytes,sha256,provider,needs}`, `files.{tokenizer,calibration,meta}` with
   bytes + sha256). `meta.json` carries `markers`, `cls_id`, `sep_id`, `pad_id`, `max_len`, `max_total`, `inputs`,
   `outputs`. The pruned vocabulary moves the marker ids to 16359–16363: read them from `meta.json`/`tokenizer.json`.
7. **ASK:** the q8 file uses `MatMulNBits` (8-bit, block 32) and an int8 token-embedding table (Gather int8 → Cast →
   Mul by a per-row scale). It runs in onnxruntime-web 1.30 WASM (validated in Node). Please confirm it also loads
   under the WebGPU EP in a browser (the int8 Gather and MatMulNBits may fall back to WASM kernels; fine if it works).

## MODEL → TRAIN (from MODEL, 2026-10-07)

7. **DONE (answer to 7):** the int8-embedding q8 runs under onnxruntime-web 1.30's **WebGPU** EP in Chromium, on an
   adapter **without** shader-f16 (SwiftShader): `out/export-r32-v1pruned` and an R17 export both load as webgpu+q8
   and answer (the int8 Gather and MatMulNBits run there; the fp16 variant is skipped as its card says). The v0.1 q8,
   whose embedding table is fp16, does not (`Program Gather requires f16`), so keep the table int8. Same files on
   WASM: fine. MODEL's TS packer + engine reproduce `export-r32-v1pruned/parity.json` exactly with the pruned
   tokenizer (q8 450/454 decisions, max logit diff 1.3656; fp16 453/454) and pack bit-exactly (89/90 requests, see 8).
8. **ASK:** curriculum rows carry Python-only float literals: `cur-dev-00000-001774` (in export-r32's requests.json)
   has `"col": 25.0`, which Python renders as `25.0`; the JS runtime can only ever produce `25` (JS numbers have no
   int/float distinction), so the model trains on text the runtime never sends. Please write integral floats as ints
   in the curriculum generator (`int(x) if isinstance(x, float) and x.is_integer() else x`) before dumping rows.
   SIM rows come from `JSON.stringify` and are not affected.
9. **INFO:** card rule "any fp16 tensor → `needs: shader-f16`" is checked by `genclass-runtime info <dir>` (scans each
   variant's graph); export-r32-v1pruned and the R17 export pass (q8: no fp16 tensors; fp16 declares it).
10. **INFO:** for latency only, MODEL ran `training/export_runtime.py --ckpt models/r17-v16k-init` on c01 into
    `~/gcl-model-exports/r17-init` (nothing under `~/gcl-train` written). Single-thread WASM warm forward, same
    situation + 2 questions: R17 177 / 245 / 360 / 625 ms at ~300 / 400 / 600 / 1,000 state tokens vs R32 (pruned)
    458 / 601 / 908 / 1,647 ms; see `packages/runtime/src/model/README.md`.
