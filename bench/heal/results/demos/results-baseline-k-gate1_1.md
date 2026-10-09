# GenClass Runtime demos: trial results

Generated 2026-10-09T07:38:10.813Z on the build VM. Runtime: **real** (@genclass/runtime 0.1.0-beta.4, dist d0fd6e20ecfc). Model: genclass-runtime-r17 on wasm q8, cross-origin isolated (WASM threads available).

Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). 10 chaos trials and 5 clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.

| Demo | Mode | Chaos bug rate | Fixed/introduced vs Off | Clean bugs | False interventions (clean) | False findings (clean) | Findings / chaos trial | Actions / chaos trial | Actions run | User latency p50 (clean) | Decision p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search typeahead | guard | 20% (2/10) | 0/0 | 0/5 | 3 in 3/5 | 4 in 3/5 | 1.40 | 0.70 | discard 10 | 12 ms | 449 ms |
| Search typeahead | heal | 20% (2/10) | 0/0 | 0/5 | 3 in 3/5 | 2 in 2/5 | 0.90 | 0.80 | discard 10, retry 1 | 18 ms | 210 ms |
| Notes autosave | guard | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 5.20 | 0.30 | discard 3 | 786 ms | 237 ms |
| Notes autosave | heal | 80% (8/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 6.10 | 1.40 | retry 4, discard 10 | 784 ms | 223 ms |
| Cart & checkout | guard | 60% (6/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.80 | 0.30 | coalesce 1, discard 2 | 221 ms | 219 ms |
| Cart & checkout | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.30 | 0.60 | retry 3, discard 2, coalesce 1 | 246 ms | 268 ms |
| Service status | guard | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 6.70 | 0.10 | discard 1 | 1.11 s | 1.78 s |
| Service status | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 5.50 | 0.20 | retry 2 | 658 ms | 1.87 s |
| Team board | guard | 60% (6/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.40 | 0.60 | discard 6 | 34 ms | 373 ms |
| Team board | heal | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.10 | 0.70 | discard 7 | 42 ms | 596 ms |
| Runtime decisions | guard | 90% (9/10) | 0/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 7.90 | 0.00 | – | 135 ms | 256 ms |
| Runtime decisions | heal | 90% (9/10) | 0/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 6.40 | 0.20 | retry 2 | 146 ms | 208 ms |

## Search typeahead (`search`)

- **guard**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **3** (in 3/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.70; decisions per trial 2.0; detections per trial 1.2; model decision latency p50 449 ms, p95 1.41 s; user-visible latency p50 12 ms clean, 166 ms chaos. Actions: discard ×10. Chosen but not run: gain # of discard over apply is not above the guard margin # ×1, superseded: search.loading changed again after the write applied ×1, gain # of coalesce over send is not above the guard margin # ×1, gain # of discard over deliver is not above the guard margin # ×1, guard mode does not allow heal-tier actions ×2, the subject was not held (decided in the background) ×1.
- **heal**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **3** (in 3/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.80; decisions per trial 1.5; detections per trial 0.7; model decision latency p50 210 ms, p95 748 ms; user-visible latency p50 18 ms clean, 159 ms chaos. Actions: discard ×10, retry ×1. Chosen but not run: gain # of discard over apply is not above the guard margin # ×1, gain # of serve_cached over send is not above the heal margin # ×1, gain # of defer over apply is not above the guard margin # ×1, superseded: search.query changed again after the write applied ×1.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.finalWrong | 0 | 0 |
| chaos.latencyMs | 619 | 634 |
| chaos.requests | 11.1 | 11.1 |
| chaos.staleMs | 188 | 228 |
| chaos.staleShare | 0.03 | 0.04 |
| chaos.wrongVisibleMs | 4055 | 3972 |
| clean.finalWrong | 0 | 0 |
| clean.latencyMs | 59.8 | 76.8 |
| clean.requests | 11.2 | 11 |
| clean.staleMs | 0 | 0 |
| clean.staleShare | 0 | 0 |
| clean.wrongVisibleMs | 1838 | 1875 |

## Notes autosave (`editor`)

- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.30; decisions per trial 7.1; detections per trial 3.5; model decision latency p50 237 ms, p95 1.38 s; user-visible latency p50 786 ms clean, 1.61 s chaos. Actions: discard ×3. Chosen but not run: guard mode does not allow heal-tier actions ×7, gain # of discard over deliver is not above the guard margin # ×19, the model's diagnosis is expected ×3, gain # of coalesce over send is not above the guard margin # ×4, superseded: notes.notes.n#.body changed again after the write applied ×1, gain # of discard over apply is not above the guard margin # ×2, superseded: notes.status changed again after the write applied ×1.
- **heal**: bug rate 80% (8/10, 95% CI 49%–94%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 1.40; decisions per trial 8.5; detections per trial 4.1; model decision latency p50 223 ms, p95 1.73 s; user-visible latency p50 784 ms clean, 1.90 s chaos. Actions: retry ×4, discard ×10. Chosen but not run: the model's diagnosis is expected ×8, gain # of discard over deliver is not above the guard margin # ×27, gain # of discard over apply is not above the guard margin # ×3, gain # of retry over deliver is not above the heal margin # ×4, gain # of coalesce over send is not above the guard margin # ×3.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.finalLie | 0.1 | 0 |
| chaos.latencyMs | 2759 | 2392 |
| chaos.lieMs | 6764 | 2101 |
| chaos.lostLocal | 0.9 | 0.8 |
| chaos.lostServer | 0.1 | 0 |
| chaos.maxLieMs | 6071 | 893 |
| chaos.reverts | 1.3 | 2.1 |
| chaos.saves | 11.1 | 13.4 |
| clean.finalLie | 0 | 0 |
| clean.latencyMs | 785 | 639 |
| clean.lieMs | 0 | 0 |
| clean.lostLocal | 0 | 0 |
| clean.lostServer | 0 | 0 |
| clean.maxLieMs | 0 | 0 |
| clean.reverts | 0 | 0 |
| clean.saves | 13.8 | 14 |

## Cart & checkout (`checkout`)

- **guard**: bug rate 60% (6/10, 95% CI 31%–83%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.30; decisions per trial 2.5; detections per trial 1.2; model decision latency p50 219 ms, p95 1.52 s; user-visible latency p50 221 ms clean, 604 ms chaos. Actions: coalesce ×1, discard ×2. Chosen but not run: guard mode does not allow heal-tier actions ×2, gain # of coalesce over send is not above the guard margin # ×4, gain # of discard over apply is not above the guard margin # ×3, the subject was not held (decided in the background) ×1, gain # of discard over deliver is not above the guard margin # ×1.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.60; decisions per trial 3.3; detections per trial 1.5; model decision latency p50 268 ms, p95 2.85 s; user-visible latency p50 246 ms clean, 810 ms chaos. Actions: retry ×3, discard ×2, coalesce ×1. Chosen but not run: gain # of coalesce over send is not above the guard margin # ×4, gain # of discard over apply is not above the guard margin # ×3, the subject was not held (decided in the background) ×2, gain # of discard over deliver is not above the guard margin # ×1.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.driftMs | 2703 | 3729 |
| chaos.duplicates | 0.4 | 0.4 |
| chaos.errorsShown | 0 | 0 |
| chaos.latencyMs | 977 | 1042 |
| chaos.maxDriftMs | 2682 | 3711 |
| chaos.ordersCreated | 1.2 | 1.4 |
| chaos.untilTimeouts | 2 | – |
| chaos.wrongCharges | 1 | 1.3 |
| clean.driftMs | 0 | 0 |
| clean.duplicates | 0 | 0 |
| clean.errorsShown | 0 | 0 |
| clean.latencyMs | 266 | 289 |
| clean.maxDriftMs | 0 | 0 |
| clean.ordersCreated | 1 | 1 |
| clean.untilTimeouts | – | – |
| clean.wrongCharges | 0 | 0 |

## Service status (`status`)

- **guard**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.10; decisions per trial 12.4; detections per trial 4.5; model decision latency p50 1.78 s, p95 4.48 s; user-visible latency p50 1.11 s clean, 1.55 s chaos. Actions: discard ×1. Chosen but not run: guard mode does not allow heal-tier actions ×30, gain # of delay over send is not above the guard margin # ×4, the model's diagnosis is expected ×2, gain # of coalesce over send is not above the guard margin # ×14.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.20; decisions per trial 12.0; detections per trial 3.7; model decision latency p50 1.87 s, p95 4.77 s; user-visible latency p50 658 ms clean, 1.69 s chaos. Actions: retry ×2. Chosen but not run: the subject was not held (decided in the background) ×6, gain # of retry over deliver is not above the heal margin # ×6, gain # of delay over send is not above the guard margin # ×3, gain # of serve_cached over send is not above the heal margin # ×6, gain # of serve_cached over deliver is not above the heal margin # ×5, gain # of discard over apply is not above the guard margin # ×1, gain # of coalesce over send is not above the guard margin # ×9.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.banners | 4.2 | 4.2 |
| chaos.falseAlarmMs | 5221 | 5111 |
| chaos.latencyMs | 2061 | 1990 |
| chaos.missedMs | 0 | 0 |
| chaos.otherWrongMs | 0 | 0 |
| chaos.requestRatio | 1.32 | 1.34 |
| chaos.requests | 71.3 | 72.5 |
| clean.banners | 0 | 0 |
| clean.falseAlarmMs | 0 | 0 |
| clean.latencyMs | 982 | 842 |
| clean.missedMs | 0 | 0 |
| clean.otherWrongMs | 0 | 0 |
| clean.requestRatio | 0.95 | 0.95 |
| clean.requests | 46.8 | 46.8 |

## Team board (`board`)

- **guard**: bug rate 60% (6/10, 95% CI 31%–83%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.60; decisions per trial 5.8; detections per trial 1.6; model decision latency p50 373 ms, p95 2.04 s; user-visible latency p50 34 ms clean, 83 ms chaos. Actions: discard ×6. Chosen but not run: gain # of discard over apply is not above the guard margin # ×6, superseded: board.cards.c#.column changed again after the write applied ×2, superseded: board.cards.c#.version changed again after the write applied ×2, gain # of coalesce over send is not above the guard margin # ×3, gain # of discard over deliver is not above the guard margin # ×4, too late to revert: decided #s after the write applied ×1.
- **heal**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.70; decisions per trial 5.8; detections per trial 1.4; model decision latency p50 596 ms, p95 2.53 s; user-visible latency p50 42 ms clean, 163 ms chaos. Actions: discard ×7. Chosen but not run: gain # of discard over apply is not above the guard margin # ×3, gain # of discard over deliver is not above the guard margin # ×4, gain # of coalesce over send is not above the guard margin # ×3, superseded: board.cards.c#.column changed again after the write applied ×4, too late to revert: decided #s after the write applied ×5, superseded: board.cards.c#.rank changed again after the write applied ×1.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.divergedMs | 4860 | 4571 |
| chaos.finalMismatches | 0.8 | 0.8 |
| chaos.jumpBacks | 4.5 | 4.9 |
| chaos.latencyMs | 281 | 381 |
| chaos.maxDivergedMs | 4293 | 4116 |
| chaos.teammateMoves | 5.4 | 5.4 |
| chaos.userMoves | 10.7 | 10.8 |
| clean.divergedMs | 0 | 0 |
| clean.finalMismatches | 0 | 0 |
| clean.jumpBacks | 0.2 | 0.2 |
| clean.latencyMs | 28.6 | 35.2 |
| clean.maxDivergedMs | 0 | 0 |
| clean.teammateMoves | 0.4 | 0.4 |
| clean.userMoves | 5.2 | 5.2 |

## Runtime decisions (`decisions`)

- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 8.0; detections per trial 5.3; model decision latency p50 256 ms, p95 1.41 s; user-visible latency p50 135 ms clean, 157 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×16, gain # of delay over send is not above the guard margin # ×1.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.20; decisions per trial 6.6; detections per trial 4.3; model decision latency p50 208 ms, p95 1.53 s; user-visible latency p50 146 ms clean, 232 ms chaos. Actions: retry ×2. Chosen but not run: the subject was not held (decided in the background) ×1, gain # of retry over deliver is not above the heal margin # ×9.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.accuracy | 0.47 | 0.44 |
| chaos.answeredByGenClass | 3.3 | 3.2 |
| chaos.backup.n | 1.2 | 1.2 |
| chaos.backup.ok | 0 | 0 |
| chaos.decisions | 3.4 | 3.4 |
| chaos.health.n | 1 | 1 |
| chaos.health.ok | 0.4 | 0.4 |
| chaos.latencyMs | 231 | 227 |
| chaos.leave.n | 2 | 2 |
| chaos.leave.ok | 1.3 | 1.2 |
| chaos.quality.n | 1 | 1 |
| chaos.quality.ok | 0.33 | 0.33 |
| chaos.untilTimeouts | 1 | 1 |
| chaos.wrong | 1.8 | 1.9 |
| clean.accuracy | 0.93 | 0.93 |
| clean.answeredByGenClass | 3 | 3 |
| clean.backup.n | 1 | 1 |
| clean.backup.ok | 1 | 1 |
| clean.decisions | 3 | 3 |
| clean.health.n | 1 | 1 |
| clean.health.ok | 0.75 | 0.75 |
| clean.latencyMs | 174 | 190 |
| clean.leave.n | 1 | 1 |
| clean.leave.ok | 1 | 1 |
| clean.quality.n | 1 | 1 |
| clean.quality.ok | 1 | 1 |
| clean.untilTimeouts | – | – |
| clean.wrong | 0.2 | 0.2 |

## How to reproduce

```bash
scripts/vm.sh run demos 'setsid nohup bash demos/scripts/vm-eval.sh > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
# or, on any machine: npm install && npm run build -w @genclass/runtime && cd demos && npm run fetch-model && npm run build && npm run eval
```
