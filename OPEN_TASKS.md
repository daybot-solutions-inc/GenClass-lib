# Open tasks: @genclass/runtime

Status as of 2026-10-07 23:00 UTC. Branch `runtime`. Spec: [docs/runtime/CONTRACT.md](docs/runtime/CONTRACT.md).
The runtime decides through a trained local model; nothing here is hardcoded per bug pattern.

## Done

- **Runtime core** (`packages/runtime/src`): observers (fetch, XHR, DOM user actions, errors, nav, storage,
  long tasks, WebSocket, timers), causal context propagation, stores (atoms, guard, adapter seam), mutation
  pipeline with holds, learned invariants and transition profiles, latency/error/rate baselines, generic facts,
  situation serializer, triage, policy gate, built-in actions, console reports, `explain`, undo, kill switch,
  plugins, device-sized situations, late revert. 239 tests passing before the current fix batch.
- **Model host** (`src/model`): TypeScript port of the GenClass engine (packing identical to Python on all 50
  fixtures; q8 decisions 79/80 vs PyTorch in Chromium), Web Worker with inline fallback, Cache Storage + sha256,
  WebGPU → WASM plans, idle/lazy preload, latency stats, WASM-only ORT build when WebGPU is unavailable (2.7 MB br
  instead of 4.7 MB), CLI `genclass-runtime fetch-model | info`.
- **Devtools overlay + adapters** (`src/devtools`, `src/adapters`): interventions/detections/activity/now views
  with evidence and undo; React hooks, Redux enhancer, Zustand middleware.
- **Training-data simulator** (`sim/`): random apps over 55 domains driving the real runtime in a deterministic
  virtual world; labels from counterfactual outcomes over 3 sampled futures; held-out domains for test.
- **Training pipeline** (`training/`): vocabulary pruning (16k merges), fp16-free int8 exports (R17 9.6 MB,
  R32 22.5 MB), curriculum generator, stage-1 curriculum training of both candidates, stage-2 pilots.

## In progress

1. **Runtime fix batch 3** (CORE). Remaining items:
   - fix the 43 review findings, each with a failing test in `packages/runtime/test/review-*.test.ts`; they
     include a stack overflow from recursive timers, sub-object loss in held writes, coalesce hangs, request
     identity collisions, wrong facts, a password-name leak, and perf on large stores;
   - the simulator's requests (sim/NEEDS.md a–f), including the remote-write-over-pending-local-change fact;
   - the summed-probability gate (CONTRACT §8);
   - the new `transient` diagnosis;
   - compact questions at budgets ≤ 1,400 chars, and a 1,000-char auto budget on single-thread WASM.
2. **Demos** (DEMOS): six demos, Service Worker backend, Playwright trial harness; screenshot tour and README.
   Current numbers use the untrained v0.1 model and only validate the harness.

## Next

3. **Freeze the runtime** after batch 3; re-run all suites; tag the situation format.
4. **Final data**: ≥ 1M (target 2M) simulator rows on the frozen runtime (train VM + c-nodes, disjoint seeds).
5. **Final training** (heavy, Azure): stage 2 for R17 and R32 on the frozen data plus curriculum replay;
   calibration fit on dev, checked on held-out test; export; parity; EVAL.md with guard/heal precision,
   false-intervention rate and regret per trigger and per budget.
6. **Choose shipping models**: R17 for WASM (about 0.2–0.3 s per decision single-threaded), and R32 for WebGPU
   only if it is clearly more accurate. Device-based model selection in the host card.
7. **Demo evaluation with the trained model**: bug rate Off / Guard / Heal and false interventions on clean runs
   for all six demos. Investigate:
   - **hold-induced harm:** with v0.1, the board demo had 9 bugs introduced in guard mode with no interventions,
     and search clean-run latency rose from 14 ms to 125 ms because salient writes were held;
   - **triage sensitivity on naturally concurrent apps:** typeahead was salient about 6 times per trial on
     clean runs.
8. **Docs**: library-first README (install, two-line init, modes, what it detects, observability, performance,
   honest results), ARCHITECTURE.md, model card, and dev-only lazy import of the devtools (52 KB min / 17 KB gz).
9. **Packaging**: model files as `@genclass/runtime-model` (CDN default URL) and a GitHub release on this repo;
   CI workflow (build, typecheck, unit tests); `npm pack` smoke test in a fresh Vite app.

## Needs the user

- **npm publish**: an `@genclass` npm org and `npm login` on this machine (not logged in), or another scope
  name.
- **Public demo hosting** (GitHub Pages on this repo): OK to publish?
- **Merging `runtime` into `main`** when ready.

## Known risks

- **Single-thread WASM speed**: hold budgets adapt and late revert covers slow decisions, but slow devices see
  more fail-open decisions.
- **Training-label noise**: costs come from a few sampled futures; benign request rows are the softest
  (66% of passive-best request rows put ≥ 0.9 on passive).
- **Thin classes**: `conflict` and `transition` rows are thin until the batch-3 runtime facts land.
