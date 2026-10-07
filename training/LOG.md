# TRAIN log (GenClass runtime model)

Dated entries: what ran, where, how long, results, cost. Times UTC. F80 node ≈ $5.46/h.

## 2026-10-07

### 13:00 T0 start
- Started `c01` (F80) as the TRAIN workbench (prune/export/generation/eval). `train` VM untouched except a
  one-off tar of `models/jev-local-fast`, `models/base/ettin-encoder-32m`, `data/{cu,gen}` served on the private
  network (10.0.0.4:8798) and pulled to c01.
- Downloaded `jhu-clsp/ettin-encoder-17m` (MIT, `pytorch_model.bin`) on c01 → `~/jev/models/base/ettin-encoder-17m`.
- Licensing hygiene: only v1 `models/jev-local-fast` (R32) and the ettin-17m base (R17) are used as inits. No v2/Z/S
  checkpoint is read by any TRAIN script.

### 13:15 Vocabulary pruning (`training/prune_vocab.py`)
- ettin/ModernBERT BPE layout verified: ids 2..244 = 243 base byte symbols, id 245+i = result of merge i (50,009
  merges), 119 added tokens at 50254.. (whitespace runs, specials, [unused*], markers). First-N-merges pruning is
  closed under composition (checked in code), keeps ids 0..244+N unchanged, moves added tokens to 245+N...
- Tests (c01): `training/tests/test_prune_vocab.py` 6/6 pass — every string encodes (random unicode/emoji/control
  bytes; decode(pruned) == decode(full)), ids in range, markers stay special and are never matched in text, logits
  identical (< 1e-4) to the unpruned v1 model on requests whose tokenisation is unchanged, HF-base prune →
  `init_model` adds markers and runs.
- Tokens-per-char inflation vs the full 50k vocab (`~/gcl-train/out/inflation.json`):

  | merges kept | runtime-like text | v1 gen | v1 cu |
  |---|---|---|---|
  | 4k | +32.8% | +39.9% | +35.8% |
  | 8k | +19.8% | +25.6% | +22.3% |
  | 12k | +14.9% | +18.4% | +16.1% |
  | **16k** | **+10.8%** | +12.3% | +10.9% |
  | 24k | +5.9% | +6.7% | +7.3% |
  | 32k | +2.8% | +3.7% | +5.4% |

- **Decision: N = 16,000 merges → vocab 16,364** (incl. markers). Estimated q8 sizes: R32 ≈ 22 MB, R17 ≈ 9.4 MB
  (12k would save 1.6 / 1.0 MB for 4% more tokens per request).
- Note for runtime/MODEL: with 16k merges the situation keys `trigger`, `facts` and action names like `apply`,
  `defer` (no leading space) split into several tokens; harmless (the model is trained on the pruned tokenizer),
  but marker ids are now 16359..16363 — read them from `tokenizer.json`/`meta.json`.
- Pruned checkpoints on c01: `~/gcl-train/models/r32-v16k` (v1, pruned), `~/gcl-train/models/base/ettin-17m-v16k`
  (HF base), `~/gcl-train/models/r17-v16k-init` (random heads, pipeline tests). R32 and R17 tokenizers are
  identical (model + added tokens).

### 13:30–14:45 Mac slept (session interrupted)
- c01 sat idle ≈ 75 min (≈ $7). Kept running afterwards because the export work resumed on it immediately; a
  `caffeinate -i -m` hold now runs on the Mac for the rest of the session.

### 17:30–17:50 Mac offline ≈ 3 h (network); resume
- c01 idle ≈ 4 h in total over both outages (≈ $22). Deallocated at 17:30, restarted 17:45 when the generator was
  ready. The delegated export sub-task produced nothing (interrupted twice); TRAIN wrote `export_runtime.py` itself.
- Rule adopted: every long job is launched detached on the nodes (`setsid nohup`), results go to disk, LOG.md is
  updated at each phase, idle nodes are deallocated.

### 17:50 Stage-1 curriculum (`training/curriculum/`)
- `generate.py --n 800000 --dev 6000 --test 12000 --seed 1 --workers 72` on c01: 818k rows in ≈ 8 s, 0 invalid,
  0 generator errors. 1.8 GB train jsonl, sharded into 64 files (the exact-layout cache is built per file; one
  1.8 GB file took minutes single-threaded, 64 shards take 24 s).
- Packed length with the pruned tokenizer: mean 482, p95 885, max 1,208 tokens; situation states ≤ 960 tokens.
- Passive-best share of decision rows (train): mutation 0.50, request 0.51, failure 0.54, stall 0.63,
  inconsistency 0.42, transition 0.70, error 0.66.
- Tests: `test_curriculum.py` 5/5 (one real bug caught: typeahead requests could start out of keystroke order,
  which made "older writer" cases inconsistent; fixed with a per-app debounce).

### 17:58 Stage-1 training launched (detached)
- Single-node pilot (c01, R17, 4 ranks × 20 threads): 68–70k tok/s.
- `r32-s1`: c02–c08 (7 × F80, 28 ranks), init v1 pruned, lr 1.5e-4 / heads 6e-4: ≈ 215k tok/s, 5 s/step.
- `r17-s1`: c09–c11 (3 × F80, 12 ranks), ettin-17m pruned + fresh heads, lr 3e-4 / heads 2e-3: ≈ 165–210k tok/s.
- Mixture pass = 406M tokens (cur1 93.1%, cu 6.2%, gen 0.7%), 2 passes. Loss at step 60/140: 0.28 / 0.27.

### 18:00–18:20 Export pipeline (`export_runtime.py`, `ortweb/validate.mjs`) on c01, using the v1-pruned R32
- q8 = 22.47 MB (≤ 25 MB) after rewriting the noul head's Gemm to MatMul (it was left fp32: 2.9 MB); fp16 = 34.8 MB.
- Parity vs PyTorch (90 requests, untrained-on-runtime model, so many near-ties): fp32 max |Δlogit| 3e-5; fp16 0.66,
  argmax 99.7%; q8 1.37, argmax 99.0%, gate agreement 98.8% @0.8 / 97.3% @0.9. Attribution: MatMulNBits b32 alone
  1.03 (b16 0.75), int8 embeddings alone 0.64 → re-check on the trained models, consider block 16 (+1.8 MB).
- onnxruntime-web 1.30.0 (WASM backend in Node 22) loads and runs the q8 file with outputs identical to ORT CPU;
  WASM p50 154 ms on these requests (p50 175 tokens) with 1 thread; numThreads=4 gives no speed-up in Node
  (no worker threads there); ORT-node CPU 34 ms (1 thread) / 18 ms (4 threads).
