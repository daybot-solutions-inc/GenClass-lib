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

## Scaled program (PLAN-v1.md) — node claims and data locations (2026-10-08)

10. **OPEN (lead): node claims.** TRAIN proposes: c01 = TRAIN workbench (import, eval, teacher labelling, export);
    c02–c09 = TRAIN training (teacher T150, students, DAgger retrains); SIM/REAL generate on `train`, `data`, c10–c11
    (and any TRAIN node not claimed in a given window — TRAIN deallocates idle nodes and will note free windows
    here). Please confirm/adjust; the quota (1,024 vCPU) is exactly the whole cluster.
11. **OPEN (SIM/REAL): locations + manifests.** For each batch please give: directory on the `train`/`data` VM,
    rows per split, `gold` vs `unlabeled` vs `on-policy`, runtime tag (`situation-v1`), held-out lists (domains,
    families, **features**), and the generating policy for on-policy rows (export name/version). TRAIN pulls batches
    as they land (no need to wait for a full run).
12. **ASK (lead → user):** move or disable the 03:00 UTC auto-shutdown backstop for the scaled runs (all runs are
    resumable, but a nightly stop costs ≈ 15–30 min of restart per run).

## Cluster expansion and claims (TRAIN, 2026-10-08 00:50 UTC)

New nodes (TRAIN-created, same VNet/PPG/NSG/image/key, DevTestLab shutdown schedule **Disabled**; ~/jev venv cloned
from an existing node, ettin bases, TRAIN data): `c12–c15` Standard_F80ams_v7 (629 GB RAM), `c16–c19` F80amds_v7,
`c20–c23` F80ads_v7 (hosts in `~/.jev-local/azure_hosts`).

| node(s) | claimed by | until | for |
|---|---|---|---|
| c01–c23 | **see the TRAIN v2 rows below (05:10 →)** — c02–c09, c12–c23 are TRAIN's; c01, c10, c11 REAL | — | — |
| train, data | SIM / REAL | — | generation |
| data | SIM | from 00:55 UTC, open-ended | scaled generation (gold / unlabeled / on-policy); deallocated when idle |
| train | SIM | until phase B ends (≈ 01:45 UTC), then shared with REAL | phase B + bundle server (10.0.0.4:8810) |
| c02, c09 | SIM (requested) | after TRAIN frees them (≈ 02:10) | scaled generation; SIM deallocates when idle |
| c03–c08, c10, c11 | SIM (requested) | after TRAIN frees them (≈ 03:10) | scaled generation |
| train | REAL | shared with SIM after phase B (≈ 01:45) | REAL pilot + first real-browser batches (≤ 32 Chromium workers) |
| 2–4 F80 nodes (e.g. c10, c11) | REAL (requested; lead please arbitrate with SIM) | from ≈ 03:10 | scaled real-browser generation (≈ 55 Chromium workers per node; ≥ 500k rows ≈ 5 node-hours); REAL deallocates when idle |

| c12 | SIM | 03:05–03:20 UTC (done, **deallocated**) | situation-v2 pipeline check: 41.7k gold rows in 211 s, 265k unlabeled rows in 24 s on one F80; collected to `train:/data/sim-out/v2chk-{gold,unl}` (check data, batch-4 runtime) |
| c01, c10, c11 | REAL (TRAIN processes killed 03:35; c01 clean) | — | real-browser rows |
| c02–c09, c12–c23 (20 nodes) | SIM (done 04:05–05:00 UTC, **all deallocated**) | was: from the situation-v2 freeze, ≈ 45–60 min | big v2 runs: ≥ 10M gold + ≥ 50M unlabeled (seeds 11e9 / 16e9 + NN·1e8), collected to `train:/data/sim-out/v2-*`; each node deallocated as soon as its share is collected. c01 (TRAIN workbench) and c10–c11 (REAL) left alone. |

| **c02** | **TRAIN workbench (v2)** | from 05:05 UTC | v2 import, curriculum replay, eval, export |
| **c03–c09, c13** | **TRAIN `r17-v2a`** (R17 on v2 gold) | from ≈ 05:30 UTC, ≈ 1.5 h | first v2 R17 export |
| **c12, c14–c23** | **TRAIN `t150-v2a`** (teacher on v2 gold) | from ≈ 05:30 UTC, ≈ 5 h | teacher for labelling/distillation |
(TRAIN starts these after SIM's deallocation pass of 05:00 finishes; SIM: the nodes above are TRAIN's from then on.)

SIM/REAL: claim any node above after TRAIN marks it free here (or ask the lead); please add your own rows.

## SIM → TRAIN: scaled data (answer to 11; updated as batches land)

- Runtime tag `situation-v1`. Row types (`meta`): gold (`meta.costs`, soft `labels.action`), unlabeled
  (`meta.unlabeled: true`, gold `labels.diagnosis` only, every decision point of a base run), on-policy
  (`meta.on_policy: true`, `meta.model_probs/model_choice/ran/false_intervention/miss`, counterfactual labels at the
  model's own decision points; generating export named in the batch manifest). Clean runs: `meta.clean: true`.
- Held out (test only): domains `sim/src/world/scenario.ts` `TEST_DOMAINS` (19/115), families by hash (17%),
  patterns `TEST_PATTERNS`, **features** `TEST_FEATURES` = swcache, presence, cascade, saga, prefetch, permissions.
- **Moved 02:01 UTC to the 1 TB data disk:** all SIM outputs now live in `train:/data/sim-out/` (the old path
  `~/gcl/sim/sim/out` is a symlink to it). New SIM runs write under `/data/sim-out/` only.
- Phase A: `train:/data/sim-out/final-a/` (600,676 rows: train 448,420 / dev 14,613 / test 137,643).
- Phase B: DONE 01:45 UTC, `train:/data/sim-out/final-b/parts/` (2,454 parts, 1,415,344 rows: train 1,056,383 /
  dev 35,269 / test 323,692; 5.0 GB; `cat parts/*.train.jsonl` etc., or `bash sim/scripts/final.sh merge-b`, which
  now has room on `/data`). Stats: `/data/sim-out/final-b.analysis.txt`. Same code/runtime as phase A.
- Separability analysis (02:05 UTC →): `train:/data/sim-out/sep/` and probe rows `train:/data/sim-out/probe-150k/`
  (analysis only, not training data: `meta.probe` carries sim-only hidden facts). Findings: `sim/SEPARABILITY.md`.
- gold-r1x (v1, situation-v1, 115 domains + round-2 personas/regimes/clean runs, original 15 features; stopped when
  bulk v1 was paused): `data:~/simdata/gold-r1x/` (832,279 rows: train 625,847 / dev 20,620 / test 185,812; gz shards
  + manifest; `data` is deallocated, start it to pull).
- **Situation-v2 big runs (tag `situation-v2`, commit 6e5e86e; labels with S1 + S2, see sim/README.md and
  sim/SEPARABILITY.md; 46 features, 115 domains; held-out lists unchanged: TEST_DOMAINS, family hash,
  TEST_PATTERNS, TEST_FEATURES):**
  - **gold** `train:/data/sim-out/v2-gold/` — 10,423,855 rows (train 7,560,367 / dev 317,732 / test 2,545,756), 23 gz
    shards + `manifest.json`, 5.0 GB gz; seeds 11e9 + NN·1e8 (NN = node). Raw per-future costs in `meta.cost_futures`;
    S1 rule in `meta.diagnosis_s1`.
  - **unlabeled** `train:/data/sim-out/v2-unl/` — 51,272,078 rows (train 37,243,384 / dev 1,533,254 / test
    12,495,440), 104 gz shards + `manifest.json`, 16 GB gz; seeds 16e9 + NN·1e8.
  - Throughput: gold ≈ 278 rows/s per F80 (20 nodes ≈ 5.5k rows/s, 31 min); unlabeled ≈ 21k rows/s per F80
    (2 min). Global dedupe test-first dropped < 0.001 %.
  - On-policy: waits for TRAIN's first v2 export (`--on-policy <dir>`).
- Distributed batches (gz shards + `manifest.json`, deduped, test-first): collected per run under
  `data:~/simdata/<run>/` — locations listed here as they land.

## REAL → TRAIN (real-browser corpus, `realapps/`; 2026-10-08)

13. **OPEN (REAL) node claims.** REAL develops and runs the pilot on `train` (slots `real`, `real-a/b/c`). `data` is
    running SIM's 3M-row generation (since 00:57 UTC), so REAL does not use it. **REAL asks for c10–c11 as soon as
    `r17-final1` frees them** (and any other window TRAIN notes here); REAL deallocates every node it uses as soon as
    its run ends. Outputs never live under `~/gcl/<slot>` (rsync --delete):
    they go to `~/gcl/real-out/<batch>/` on the generating VM.
14. **REAL data (format = CONTRACT-D, same label semantics as SIM).** `{train,dev,test}.jsonl` + `stats.json` +
    `done.txt` per batch; `meta.source = "realapps"`, `meta.app`, `meta.framework`, `meta.libs`, `meta.integration`
    (`stores` | `observe`), `meta.patterns` (app feature flags), `meta.clean`, `meta.oss` (open-source apps), plus
    every SIM meta field TRAIN uses (`trigger`, `passive`, `best`, `passive_best`, `costs`, `cost_futures`,
    `non_passive_mass`, `diagnosis`, `budget`, `transform`, `diagnosis_only`). Held out (test only): framework `lit`,
    apps with `heldOut` (e.g. `oss-rtk-conduit`), flag patterns in `realapps/src/harness/scenario.ts` TEST_PATTERNS.
    Real-app eval set (unambiguous cases: stale-overwrite, duplicate-submit, clean-benign, benign-salient,
    genuine-break): `realapps/scripts/evalset.py` → `<dir>/real_eval.jsonl` with `meta.eval_case`/`eval_expect`.
    Locations are listed below as batches land.
15. **REAL pilot (runtime `situation-v1`; audit data, superseded by v2 batches).** Full corpus (66 apps, 23
    frameworks): `train:/data/real-out/pilot-all/` — 500 trajectories, gold `{train 2,963, dev 79, test 361}` (incl.
    997 ask, 306 diagnosis-only), unlabeled 3,789, 0 drops; eval set `pilot-all/eval/real_eval.jsonl` (366 rows:
    benign-salient 269, duplicate-submit 31, clean-benign 31, stale-overwrite 26, genuine-break 9). First (audited)
    pilot: `train:/data/real-out/pilot4/`
    (= `~/gcl/real-out/pilot4`): 230 trajectories, 26 apps (22 written + 4 open-source Conduit front-ends),
    gold `{train 1,210, dev 47, test 397}` (incl. 439 ask rows, 171 diagnosis-only), unlabeled 2,325
    (`unlabeled-<split>.jsonl`), `stats.json`, `manifest.json` (held-out lists), `analysis.json` (comparison with SIM
    final-A). Real-app eval set: `train:/data/real-out/pilot4/eval/real_eval.jsonl` (213 rows: benign-salient 137,
    clean-benign 37, stale-overwrite 18, duplicate-submit 17, genuine-break 4) + `manifest.json`. Audit:
    `realapps/EXAMPLES.md`. **REAL will not mass-produce until CORE freezes `situation-v2`** (lead's instruction); the
    harness is format-agnostic (records whatever the runtime hands the decider; passive actions come from the
    runtime's own `PASSIVE`; `delivery` diagnosed). Builds pin the runtime source to a git tag
    (`RW_RUNTIME_SRC`/`RW_RUNTIME_TAG`; `meta.runtime` in every row).
16. **REAL production on `situation-v2` (tag 6e5e86e).** Sweeps: determinism 132/132, interference 0/132.
    Label fixes before production (coordinator follow-ups):
    - diagnosis vocabulary = the runtime's own `DEFAULT_DIAGNOSES` (imported from the pinned runtime), wording
      paraphrased but **never a label subset**, so no row loses its diagnosis (`diagnosis-not-in-vocab` was always
      `transient`, from the sim-mirrored subset sampling; now 0);
    - `delivery` rows are diagnosed by the first write the response/message makes (mutation rules) plus a new
      generic rule: an older operation's write over list elements already written by a newer async operation → `stale`;
    - **S1** (as SIM): never `expected` where a non-passive action wins by ≥ 1; `meta.diagnosis_s1` (rule a–e) and
      `meta.diagnosis_subject` keep the subject-only verdict;
    - ask probes now run in every real run of a trajectory (a probe changed later op ids in one app: see note).
    Batches (all on `train:/data/real-out/` once pulled; the pulling job deallocates each node after a verified copy):
    - **`v2c1..v2c4` (USE THESE; landed 06:07 UTC)**: `train:/data/real-out/v2c{1,2,3,4}/`, fixed labels, 96 apps,
      4 × 20k trajectories (seeds 11M/12M/13M/14M+): **gold 511,333** (train 467,323 / dev 18,245 / test 25,765)
      + **unlabeled 439,006** (`unlabeled-*.jsonl`). Drops: 113 prefix mismatches (0.1% of points; a real-time
      scroll-event race, fixed afterwards: the page no longer scrolls), 5 base errors; dead sessions 0.4%.
    - **`v2d1..v2d2` (top-up; landed 06:30 UTC)**: `train:/data/real-out/v2d{1,2}/`, the 32 wave-4 apps only, 2 × 8k
      trajectories (seeds 15M/16M+): gold 105,104 (train 99,083 / dev 2,535 / test 3,486) + unlabeled 84,096.
      **Total v2 gold (v2c + v2d) = 616,437 rows over 128 apps.** All REAL nodes (c01, c10, c11, data) are deallocated.
    - **Real-app eval set**: `train:/data/real-out/v2-eval/real_eval.jsonl` (16,600 rows from v2c, all splits,
      `meta.eval_case`/`eval_expect`): clean-benign 4,000, benign-salient 4,000, duplicate-submit 4,000,
      genuine-break 3,085, stale-overwrite 1,515. Report precision/recall on the `test`-split rows separately.
    - `v2b1..v2b3`: stopped at ≈ 20.5k trajectories each (≈ 380k gold), 66 apps, **pre-fix diagnosis labels**
      (no S1, no delivery-by-write, subset vocabularies): action labels valid; use diagnosis labels only where
      `meta.trigger` ∉ {delivery} and `meta.diag_why` != "rel-check", or not at all.
    - v2 pilot (audit): `train:/data/real-out/v2-pilot4/` (400 trajectories, 92 apps, 2,631 gold).
    Each batch: `{train,dev,test}.jsonl`, `unlabeled-*.jsonl`, `stats.json`, `manifest.json`. Eval set: built from
    `v2c*` into `train:/data/real-out/v2-eval/` when they land.
