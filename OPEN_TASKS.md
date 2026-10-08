# Open tasks: @genclass/runtime

Status as of 2026-10-08 (~04:15 UTC). New sessions: start with [HANDOFF.md](HANDOFF.md). Branches: `runtime`
(the colleague's, at 74f17c0) and `mvp-v2` (= `runtime` + AI-agent docs, default mode `observe`, CI). Spec:
[docs/runtime/CONTRACT.md](docs/runtime/CONTRACT.md). Results and numbers: [docs/runtime/RESULTS.md](docs/runtime/RESULTS.md).
The runtime decides through a trained local model; nothing here is hardcoded per bug pattern.

The training format is frozen at tag **`situation-v2`** (commit 6e5e86e). No situation-v2 model exists yet.

## Done

- **Published `@genclass/runtime@0.1.0-alpha.1` to npm** (published 2026-10-08 (~05:33 UTC) by `karanvir1729` under dist-tag `latest`, from release commit 806a296 (local annotated tag `v0.1.0-alpha.1`, not pushed); 26 files, 486.8 kB, shasum 9e3e82bcf752d6eb34db0620d072e6a913508dff). It ships the NaN fix (ad24804), the
  situation-v2 runtime (decisions at the network boundary via the `delivery` trigger; store writes not held by default),
  EventSource observed, synthetic DOM events ignored unless `observe: { untrustedEvents: true }`, default mode `observe`
  (guard opt-in, heal experimental) and refreshed docs. No model is published, so it only observes. The first attempt
  got a 403 because the publishing account had no 2FA; with 2FA enabled it went through browser-based 2FA approval.
- **Published `@genclass/runtime@0.1.0-alpha.0` to npm** (2026-10-08, `genclass` org, owner meharpro). The
  tarball was smoke-tested in a fresh Vite app in headless Chromium (`packages/runtime/test/smoke/smoke.sh`).
  The alpha takes no actions: `@genclass/runtime-model` is not published, so the default model URL returns 404.
  It predates batches 4–5 and the observe default (its default mode is guard).
- **Runtime core** (`packages/runtime/src`): observers (fetch, XHR, DOM user actions, errors, nav, storage,
  long tasks, WebSocket, EventSource, timers), causal context propagation, stores (atoms, guard, adapter seam),
  mutation pipeline, learned invariants and transition profiles, latency/error/rate baselines, generic facts,
  situation serializer, triage, policy gate, built-in actions, console reports, `explain`, undo, kill switch,
  plugins, device-sized situations, late revert.
- **Runtime fix batch 3** (frozen as tag `situation-v1`): all 34 review findings fixed with regression tests;
  summed-probability gate; `transient`; compact questions; redaction by field meaning.
- **Runtime batch 4: decisions at the network boundary** (fcd1e68). Store writes are no longer held by default;
  the runtime holds only the delivery of a response or message (the `delivery` trigger) when newer data already sits
  in the fields it would write, and drops its stale writes synchronously. Adds EventSource observation and the
  `untrustedEvents` option. Motivation (v1 demos, guard, zero actions): board 11 card jump-backs, editor 37
  overwritten keystrokes, checkout 24 reset quantities, search clean latency 6 → 389 ms (RESULTS.md §4).
- **Runtime batch 5 + `situation-v2` freeze** (6e5e86e): real-app text fixes (shadow DOM, label text, leaf-field
  redaction) and the separability facts F1, F2, F3, F5, F6, F7, F8, F9 and read-your-writes
  (`packages/runtime/STATUS.md`). 346 tests on `runtime` per STATUS.md.
- **Never-worse sweep on v2** (realapps harness, all-passive model, heal vs observe): **0/396** clean runs changed
  over the 66 apps then in the corpus; Conduit 0/30; chaos 3/198 changed (request-time holds shift a request by
  ~25 ms); determinism 198/198 (RESULTS.md §4, STATUS.md). What the sweep compares is narrower than "same
  requests, bodies, server state and DOM" (see Known risks).
- **Final training round 1** (situation-v1, 448k phase-A rows): R17 diagnosis 90.5%, action 81.9%, guard FIR
  0.05%, heal FIR 0.24%, calibration error 0.009, but recall on clear stale/duplicate cases only 7.7%; R32 is no
  better (89.7% / 81.8% / 0.05% / 5.9%). R17 chosen as the default model (9.58 MB q8, 177/323/589 ms at
  500/780/1,170 tokens single-thread WASM) (RESULTS.md §1–2). Superseded: v1 models do not match the v2 runtime.
- **Separability analysis** (`sim/SEPARABILITY.md`) and its fixes: S1 labels (by the cause of the divergence),
  S2 futures (re-draw latents the runtime cannot observe), and the F1–F9 facts in situation-v2. Effect on
  visible-text separability, v1 → v2 (RESULTS.md §3): failure look-alikes 40% → 17%, request 48% → 38%, stall
  31% → 5%, mutation 8% → 2%; inconsistency linear recall at 1% FIR 10% → 20%.
- **Real-browser corpus** (`realapps/`, fcb8189 and later): real apps in 23 stacks in headless Chromium with the
  sim's label semantics. 66 apps at the sweep; **91 apps in the tree now** (77 written + 14 open-source Conduit
  front-ends). v2 pilot: 400 trajectories, 2,519 gold rows (135 `delivery`), 0 drops (`training/NEEDS.md` item 16).
  See [docs/agents/realapps.md](docs/agents/realapps.md).
- **Curriculum ported to v2** (`training/curriculum/rt.py` mirrors the situation-v2 renderer; known divergences
  under Next).
- **v2 data generation launched** (~04:00 UTC): SIM ~10M gold + ~50M unlabeled on 20 nodes; REAL ~495k
  real-browser gold rows on 3 nodes (RESULTS.md §6–7).
- **Model host** (`src/model`): TypeScript port of the GenClass engine (packing identical to Python on all 50
  fixtures), Web Worker with inline fallback, Cache Storage + sha256, WebGPU → WASM plans, idle/lazy preload,
  latency stats, WASM-only ORT build, CLI `genclass-runtime fetch-model | info`. R17/R32 q8 exports agree with
  PyTorch on 233/233 decisions in onnxruntime-web (RESULTS.md §2).
- **Devtools overlay + adapters** (`src/devtools`, `src/adapters`): React hooks, Redux enhancer, Zustand middleware.
- **Training-data simulator** (`sim/`) and **training pipeline** (`training/`): vocabulary pruning (16k merges),
  fp16-free int8 exports, curriculum (~1.9M rows), stage 1 and stage 2 pilots.
- **On `mvp-v2` only** (not on `runtime`): default mode `observe` (guard opt-in, heal experimental) with
  `test/default-mode.test.ts`; GitHub Actions CI (`.github/workflows/ci.yml`: typecheck, build, unit tests,
  review-perf separately with retries) and a committed root `package-lock.json`; AI-agent docs (`AGENTS.md`,
  `CLAUDE.md`, `docs/agents/**`). Verified locally on `mvp-v2`: 332 passed + 14 skipped (model parity) in the unit
  run, plus 4 review-perf tests run alone (350 in total); review-perf can flake under parallel load.

## In progress

1. **v2 data on Azure** (Mehar operates the cluster; nobody else touches Azure). SIM: ≥ 10M gold + ≥ 50M
   unlabeled rows on c02–c09 and c12–c23 into `train:/data/sim-out/v2-*`. REAL: production batches `v2b1`/`v2b2`/
   `v2b3` on c01, c10, c11 (30k trajectories each, target ≥ 500k gold), then copied to `train:/data/real-out/`.
   Locations and manifests: `training/NEEDS.md`.
2. **Demos** (DEMOS): six demos, Service Worker backend, Playwright trial harness. Current numbers use the
   untrained v0.1 model and only validate the harness (RESULTS.md §5: guard executed 0 actions; heal took 156,
   which fixed nothing; 0 false interventions on clean runs).

## Next

The usual order (HANDOFF.md): v2 data collected → teacher → labels → distillation → DAgger → EVAL → model
package → demos rerun → runtime release.

3. **Check the v2 data before training on it** (from the review findings): SIM samples budget 3,200 for ~40% of
   trajectories (`sim/src/world/scenario.ts` → `budget`), above the v2 device budgets; unlabeled rows hard-label
   `expected` diagnoses that S1 would relabel (`sim/src/gen/trajectory.ts` → `unlabeledTrajectory`; a relabel pass
   can drop them); REAL manifests hardcode `situation-v1` (`realapps/src/harness/gen.ts` → `manifest`). Decide
   with Mehar whether to filter, relabel or regenerate.
4. **150M teacher on v2 gold** (SIM + REAL).
5. **Teacher labels on the unlabeled rows** (`training/label_cluster.sh`, `training/label_teacher.py`). Before
   running: the script cannot read `.jsonl.gz` shards, marks itself done unconditionally, has no train-split
   filter and no gather step.
6. **Distil R17 (default) and R32**, then the T1 expected-advantage target on v2 (the v1 T1 runs were stopped at
   the freeze; `training/LOG.md`). `training/launch_student.sh` fails when INIT is omitted.
7. **DAgger** via SIM `--on-policy` (on-policy runs use heal mode, while the default is observe and the precision
   target is guard).
8. **EVAL** (`training/EVAL.md`): guard/heal precision, false-intervention rate and regret per trigger and per
   budget; calibration fit on dev, checked on held-out test; parity. `training/final_post.sh` and
   `training/eval_sim.sh` are hard-wired to the v1 eval set (`simAe`), and `training/eval_runtime.py` caches logits
   by name only: fix before evaluating a v2 model. The real-app eval set (`realapps/scripts/evalset.py`) draws
   from the train split by default and ignores the `delivery` trigger. Targets (RESULTS.md §1): guard FIR ≤ 0.1%,
   heal FIR ≤ 0.5%, calibration error ≤ 0.02, diagnosis ≥ 95%, clear-case recall ≥ 80%.
9. **Model package** `@genclass/runtime-model@0.1.0` (the runtime's default CDN URL) plus a GitHub release.
   Device-based model selection in the host card (R17 everywhere unless R32 is clearly better on WebGPU).
10. **Demo rerun with the trained model**: bug rate Off / Guard / Heal and false interventions on clean runs for
    all six demos (RESULTS.md §5 is the v0.1 baseline). Investigate triage sensitivity on naturally concurrent apps
    (v0.1: typeahead was salient about 6 times per trial on clean runs; v2 reports 0 model calls on clean
    typeahead, RESULTS.md §4). The synthetic in-page driver records no user actions since `untrustedEvents`
    defaults to false.
11. **Publish `@genclass/runtime@0.1.0`** without the alpha tag (2FA by the user), after `npm pack` smoke test; procedure in [RELEASE.md](RELEASE.md).
12. **CI**: done on `mvp-v2` (`.github/workflows/ci.yml`); lands on `runtime`/`main` with the merge.
13. **Docs**:
    - `HANDOFF.md`, `realapps/README.md` and RESULTS.md say 66 apps; the tree has 91.
    - `docs/runtime/CONTRACT.md` still describes the old substring redaction rule.
    - Still open from before: model card; honest results in the READMEs. Devtools ships as the separate
      `@genclass/runtime/devtools` entry; whether a dev-only lazy import is still needed is (unverified).
14. **Review fixes** (adversarial review of `mvp-v2`, 2026-10-08; most change runtime behaviour, so coordinate
    with Mehar, and anything under `packages/runtime/src/situation/*` needs a new format tag):
    - delivery: discard is a silent no-op on redux/zustand stores but is recorded as a drop
      (`state/hub.ts` → `StoreHub.applyFilter`); a discard mark drops fresh writes of later ops chained from the
      discarded one for 10 s and survives `pause()`/`setMode("observe")` (`runtime.ts` → `dropFilter`); observe
      mode still holds deliveries up to 100 ms and its background delivery decisions are always dropped as stale
      (`runDelivery`, `trigger`); a delivery `defer` can stall a WS/SSE channel for 20 s; held WS/SSE messages are
      dispatched after `close()` (`observe/messages.ts` → `MessageGate.pump`); XHR listeners see
      `currentTarget === null`; `holdWrites` flush/discard mismatch.
    - situation: the F2 fact prints raw text of redacted fields (`situation/content.ts` → `contentFacts`); the
      leaf-based default redactor no longer redacts numbers/arrays under secret-named containers (`util.ts` →
      `isSensitivePath`); "nor the value when #X started" asserted without checking; every POST JSON response
      counted as a create; HTTP 502 called "not processed".
    - curriculum parity (`training/curriculum/rt.py`): extra "Recent … outcomes" fact on failure rows, last-N
      timeline instead of relevance-first, no-op writes, F1 instead of F2 wording on long text, rounding, bracket
      paths, missing ages.
    - realapps: a crashed Chromium drains its worker's seed queue as instant failures; resume can duplicate rows;
      unpinned dependencies; the README's runtime pinning does not reach the VM.

## Model quality: where it stands and why

- **Round 1** (situation-v1, 448k simulated rows, R17 9.6 MB): guard FIR 0.05%, heal 0.24%, calibration error
  0.009, diagnosis 90.5%; but it acts on only 7.7% of clear stale/duplicate cases; R32 (3× the compute) is no
  better.
- **Why** (`sim/SEPARABILITY.md`): the ceiling is in the data. 62–82% of clear cases had a benign twin with
  identical visible facts; 24% of clear rows were mislabelled `expected`; labels were hindsight-certain about
  things a runtime cannot observe (the user's next action, outage length, whether a failed write committed).
- **Fixes, now in the v2 format and data:** facts F1–F9 and read-your-writes; S1 labelling; S2 futures. The
  expected-advantage target (T1) is still to be trained on v2.
- **Round 2** (situation-v2): data generating; no result yet.

## Needs the user

- **2FA publishes:** `@genclass/runtime-model@0.1.0` and `@genclass/runtime@0.1.0` (`0.1.0-alpha.1` is done). Agents
  prepare the tarball and the exact command per [RELEASE.md](RELEASE.md).
- **Push** `mvp-v2` (head = release commit 806a296) and tag `v0.1.0-alpha.1` to origin (needs an account with write access).
- **Public demo hosting** (GitHub Pages on this repo): OK to publish?
- **Merging into `main`**: `runtime` and/or `mvp-v2` when ready.
- **Default mode decision:** `mvp-v2` defaults to `observe` (f3636b2); HANDOFF.md and the older published
  `0.1.0-alpha.0` say `guard` (`0.1.0-alpha.1`, now `latest`, defaults to `observe`). Pick one before 0.1.0.
- **Re-enable the Azure auto-shutdown schedules when the training push ends** (disabled with the user's OK at
  00:35 UTC; command in HANDOFF.md). Spend so far about $400 (RESULTS.md §7).

## Known risks

- **Single-thread WASM speed**: hold budgets adapt and late revert covers slow decisions, but slow devices see
  more fail-open decisions.
- **Training-label noise**: costs come from a few sampled futures; benign request rows are the softest (66% of
  passive-best request rows put ≥ 0.9 on passive).
- **Data generated with known defects**: v2 SIM/REAL data is being produced by the runtime and harness that the
  review findings above describe; fixing a runtime defect that changes situations or delivery behaviour means a
  new format tag and regenerated data.
- **Never-worse claims are narrower than stated**: the interference sweep compares final visible text and server
  content (not requests, stores, errors or input values), covers 66 of the 91 apps, never compares observe mode
  against no runtime, and the determinism check reruns only the base run. Chaos runs: 3/198 changed.
- **Thin classes**: `conflict` and `transition` rows were thin on v1; unmeasured on v2.
