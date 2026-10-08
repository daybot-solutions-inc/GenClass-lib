# Open tasks: @genclass/runtime

Status as of 2026-10-08. New sessions: start with HANDOFF.md. Branch `runtime`. Spec: [docs/runtime/CONTRACT.md](docs/runtime/CONTRACT.md).
The runtime decides through a trained local model; nothing here is hardcoded per bug pattern.

## Done

- **npm 0.1.0-beta.1** (latest) + **model 0.2.0** (r17-v2dT, gain gate, cautious/balanced/eager profiles) + the `genclass-runtime` alias
  are published (2026-10-08). The registry e2e passes: guard fixes 6/6 and clean typing makes 0 model calls.
- **npm:** `@genclass/runtime@0.1.0-beta.0` (latest) and `@genclass/runtime-model@0.1.0` (r17-v2b, with gates refit on on-policy data)
  are published. Checked on 2026-10-08 against the registry tarballs: guard fixed an out-of-order typeahead 6/6, observe detected it, and
  clean typing made 0 model calls. The `genclass-runtime` alias is not published yet; its tarball is in `packages/runtime/.publish/`.
- **Published `@genclass/runtime@0.1.0-alpha.0` to npm** (2026-10-08, `genclass` org, owner meharpro). The
  tarball was smoke-tested in a fresh Vite app in headless Chromium (`packages/runtime/test/smoke/smoke.sh`).
  The alpha takes no actions until the runtime model package is published.
- **Runtime fix batch 3** (frozen as tag `situation-v1`): all 34 review findings fixed, each with its
  regression test; summed-probability gate; `transient`; compact questions; redaction by field meaning;
  300 tests passing. A keystroke write on a 5,000-item store takes 0.14 ms.
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

1. **Final data, phase A** (SIM): 600k rows from the frozen runtime (tag `situation-v1`), then phase B
   (1.4M more, disjoint seeds) until the 03:00 UTC VM shutdown; resumable.
2. **Demos** (DEMOS): six demos, Service Worker backend, Playwright trial harness; screenshot tour and README.
   Current numbers use the untrained v0.1 model and only validate the harness.

## Next

3. **Runtime batch 4: move decisions to the network boundary** (CORE). The demos showed that holding
   *store writes* makes correct apps worse even when GenClass takes no action:
   - board: held writes landed after a newer user move and moved cards back (11 visible jump-backs over 30
     sessions);
   - editor: 37 delayed save echoes rewrote newer keystrokes;
   - checkout: 24 delayed confirmations reset quantities;
   - search: clean-run latency rose from about 6 ms to 230–390 ms.

   The redesign holds only the delivery of a response or message (equivalent to network latency) when newer
   data already sits in the fields it will write, and drops its stale writes synchronously. It also adds
   EventSource observation and an `untrustedEvents` option. Produces the situation format `situation-v2`.
4. **Then regenerate all data on v2** (sim gold, unlabeled and on-policy rows; the real-app corpus) and run the
   scaled training (teacher, then distillation into R17/R32, then retraining on the model's own mistakes).

3. **Final training round 1** (tonight, on phase A): R17 and R32 from their stage-1 weights, then eval,
   calibration and export by about 02:40 UTC. **Round 2** (after the shutdown) uses phase A + B with longer
   schedules.
4. **Final training details** (heavy, Azure): stage 2 for R17 and R32 on the frozen data plus curriculum replay;
   calibration fit on dev, checked on held-out test; export; parity; EVAL.md with guard/heal precision,
   false-intervention rate and regret per trigger and per budget.
5. **Choose shipping models**: R17 for WASM (about 0.2–0.3 s per decision single-threaded), and R32 for WebGPU
   only if it is clearly more accurate. Device-based model selection in the host card.
6. **Demo evaluation with the trained model**: bug rate Off / Guard / Heal and false interventions on clean runs
   for all six demos. Investigate:
   - **hold-induced harm:** with v0.1, the board demo had 9 bugs introduced in guard mode with no interventions,
     and search clean-run latency rose from 14 ms to 125 ms because salient writes were held;
   - **triage sensitivity on naturally concurrent apps:** typeahead was salient about 6 times per trial on
     clean runs.
7. **Docs**: READMEs and ARCHITECTURE.md are written; still to do: fill in honest results (install, two-line init, modes, what it detects, observability, performance,
   honest results), ARCHITECTURE.md, model card, and dev-only lazy import of the devtools (52 KB min / 17 KB gz).
8. **Packaging**: publish the trained model as `@genclass/runtime-model@0.1.0` (the runtime's default CDN URL)
   and attach it to a GitHub release, then publish `@genclass/runtime@0.1.0` without the alpha tag;
   CI workflow (build, typecheck, unit tests); `npm pack` smoke test in a fresh Vite app.

## Model quality: where it stands and why

- **Round 1** (situation-v1, 448k simulated rows, R17 9.6 MB):
  - guard false-intervention rate 0.05%, heal 0.24%, calibration error 0.009, diagnosis 90.5%;
  - but it acts on only 7.7% of clear stale/duplicate cases;
  - R32 (3× the compute) is no better.
- **Separability analysis** (`sim/SEPARABILITY.md`):
  - the ceiling is in the data: 62–82% of clear cases have a benign twin with identical visible facts;
  - 24% of clear rows were mislabelled `expected`;
  - labels were hindsight-certain about things a runtime cannot observe (the user's next action, how long an
    outage lasts, whether a failed write committed).
- **Fixes in progress:**
  - generic facts measured to separate the cases: F1 put-back-a-replaced-value, F2 overwrites newer typing,
    F3 response changes nothing, F9 known-stale provenance, F6 refresh/save cadence;
  - the labelling fix (S1);
  - futures that re-draw unobservable latents, so labels become expected cost given what is observable (S2);
  - an expected-advantage training target (T1).

## Needs the user

- **Release `0.1.0-alpha.1`**: the NaN crash fix, the network-boundary runtime (batches 4–5), the new README, and the
  one-command install (`npx genclass-runtime init`, `@genclass/runtime/auto`, the CDN script tag, being built by
  INSTALL). Publishing needs your 2FA; the tarball and command follow once install tests pass.
- **Install on Polar Parts** (`MeharPro/Polar-Parts`) once the trained model is good (user OK'd). Start in
  observe mode on a branch, verify the storefront is unchanged, then guard.
- **Public demo hosting** (GitHub Pages on this repo): OK to publish?
- **Merging `runtime` into `main`** when ready.

## Known risks

- **Query-value redaction in model input** (OPTIONS-SPEC §8.6) is deferred: it changes the model's input, so it needs a new
  situation tag, regenerated data and retraining. For now only sink evidence redacts URLs. Also `model.inlineFallback: false`
  is passed through but the model host doesn't read it yet.

- **Stall detection for requests with no latency history** (realapps wave 4): a hung non-GET request with no
  baseline produced zero decisions, because `stall` needs at least 5 latency samples. Consider a generic
  no-baseline fallback (e.g. a long absolute timeout) as an additional trigger condition. This is not a format change.

- **Single-thread WASM speed**: hold budgets adapt and late revert covers slow decisions, but slow devices see
  more fail-open decisions.
- **Training-label noise**: costs come from a few sampled futures; benign request rows are the softest
  (66% of passive-best request rows put ≥ 0.9 on passive).
- **Thin classes**: `conflict` and `transition` rows are thin until the batch-3 runtime facts land.
