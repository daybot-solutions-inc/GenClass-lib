# GenClass Runtime demos: trial results

Generated 2026-10-09T07:41:23.759Z on the build VM. Runtime: **real** (@genclass/runtime 0.1.0-beta.4, dist f210d8892d5a). Model: genclass-runtime-r17 on wasm q8, cross-origin isolated (WASM threads available).

Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). 10 chaos trials and 5 clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.

| Demo | Mode | Chaos bug rate | Fixed/introduced vs Off | Clean bugs | False interventions (clean) | False findings (clean) | Findings / chaos trial | Actions / chaos trial | Actions run | User latency p50 (clean) | Decision p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search typeahead | guard | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 2 in 2/5 | 1.10 | 0.40 | discard 4 | 14 ms | 355 ms |
| Search typeahead | heal | 10% (1/10) | 0/0 | 0/5 | 1 in 1/5 | 1 in 1/5 | 0.90 | 0.70 | discard 7, retry 1 | 74 ms | 245 ms |
| Notes autosave | guard | 80% (8/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 4.20 | 0.50 | discard 5 | 787 ms | 293 ms |
| Notes autosave | heal | 80% (8/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 5.90 | 1.50 | retry 3, discard 12 | 790 ms | 240 ms |
| Cart & checkout | guard | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.70 | 0.00 | – | 230 ms | 226 ms |
| Cart & checkout | heal | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.20 | 0.70 | retry 3, discard 3, coalesce 1 | 210 ms | 248 ms |
| Service status | guard | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 7.10 | 0.00 | – | 1.27 s | 1.26 s |
| Service status | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 6.30 | 0.40 | retry 3, discard 1 | 487 ms | 1.49 s |
| Team board | guard | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.40 | 0.50 | discard 5 | 35 ms | 591 ms |
| Team board | heal | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.10 | 0.30 | discard 3 | 27 ms | 377 ms |
| Runtime decisions | guard | 90% (9/10) | 0/0 | 2/5 | 0 in 0/5 | 0 in 0/5 | 7.50 | 0.00 | – | 163 ms | 211 ms |
| Runtime decisions | heal | 90% (9/10) | 0/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 6.90 | 0.80 | retry 8 | 170 ms | 209 ms |

## Search typeahead (`search`)

- **guard**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.40; decisions per trial 2.1; detections per trial 0.9; model decision latency p50 355 ms, p95 1.28 s; user-visible latency p50 14 ms clean, 94 ms chaos. Actions: discard ×4. Chosen but not run: gain # of discard over apply is not above the guard margin # ×2, superseded: search.query changed again after the write applied ×3, gain # of coalesce over send is not above the guard margin # ×2, guard mode does not allow heal-tier actions ×3.
- **heal**: bug rate 10% (1/10, 95% CI 2%–40%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **1** (in 1/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.70; decisions per trial 1.5; detections per trial 0.7; model decision latency p50 245 ms, p95 885 ms; user-visible latency p50 74 ms clean, 117 ms chaos. Actions: discard ×7, retry ×1. Chosen but not run: gain # of discard over deliver is not above the guard margin # ×1, superseded: search.query changed again after the write applied ×1, gain # of coalesce over send is not above the guard margin # ×1.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.finalWrong | 0.1 | 0 |
| chaos.latencyMs | 457 | 483 |
| chaos.requests | 11.6 | 11.3 |
| chaos.staleMs | 513 | 116 |
| chaos.staleShare | 0.08 | 0.01 |
| chaos.wrongVisibleMs | 4621 | 3858 |
| clean.finalWrong | 0 | 0 |
| clean.latencyMs | 52.6 | 116 |
| clean.requests | 10.8 | 10.8 |
| clean.staleMs | 64.2 | 0 |
| clean.staleShare | 0.01 | 0 |
| clean.wrongVisibleMs | 2033 | 2022 |

## Notes autosave (`editor`)

- **guard**: bug rate 80% (8/10, 95% CI 49%–94%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.50; decisions per trial 6.2; detections per trial 2.8; model decision latency p50 293 ms, p95 1.94 s; user-visible latency p50 787 ms clean, 2.54 s chaos. Actions: discard ×5. Chosen but not run: guard mode does not allow heal-tier actions ×8, gain # of discard over deliver is not above the guard margin # ×13, superseded: notes.notes.n#.body changed again after the write applied ×1, the model's diagnosis is expected ×3, gain # of discard over apply is not above the guard margin # ×5, gain # of coalesce over send is not above the guard margin # ×3.
- **heal**: bug rate 80% (8/10, 95% CI 49%–94%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 1.50; decisions per trial 7.9; detections per trial 3.9; model decision latency p50 240 ms, p95 1.73 s; user-visible latency p50 790 ms clean, 1.85 s chaos. Actions: retry ×3, discard ×12. Chosen but not run: gain # of discard over apply is not above the guard margin # ×6, gain # of coalesce over send is not above the guard margin # ×4, gain # of discard over deliver is not above the guard margin # ×11, the model's diagnosis is expected ×7, superseded: notes.notes.n#.body changed again after the write applied ×1, gain # of retry over deliver is not above the heal margin # ×5, too late to revert: decided #s after the write applied ×1.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.finalLie | 0.1 | 0.1 |
| chaos.latencyMs | 2385 | 2064 |
| chaos.lieMs | 7279 | 1856 |
| chaos.lostLocal | 0.8 | 0.8 |
| chaos.lostServer | 0.1 | 0.1 |
| chaos.maxLieMs | 6477 | 667 |
| chaos.reverts | 0.9 | 1.4 |
| chaos.saves | 11.2 | 13.3 |
| clean.finalLie | 0 | 0 |
| clean.latencyMs | 791 | 788 |
| clean.lieMs | 101 | 31.8 |
| clean.lostLocal | 0 | 0 |
| clean.lostServer | 0 | 0 |
| clean.maxLieMs | 101 | 31.8 |
| clean.reverts | 0 | 0 |
| clean.saves | 14.4 | 14 |

## Cart & checkout (`checkout`)

- **guard**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.3; detections per trial 1.1; model decision latency p50 226 ms, p95 1.99 s; user-visible latency p50 230 ms clean, 661 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×3, gain # of coalesce over send is not above the guard margin # ×4, gain # of discard over apply is not above the guard margin # ×2, the subject was not held (decided in the background) ×1, gain # of discard over deliver is not above the guard margin # ×1.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.70; decisions per trial 3.0; detections per trial 1.5; model decision latency p50 248 ms, p95 1.96 s; user-visible latency p50 210 ms clean, 606 ms chaos. Actions: retry ×3, discard ×3, coalesce ×1. Chosen but not run: gain # of discard over apply is not above the guard margin # ×3, superseded: cart.lines changed again after the write applied ×2, gain # of coalesce over send is not above the guard margin # ×4, gain # of rollback over ignore is not above the heal margin # ×1, gain # of discard over deliver is not above the guard margin # ×2.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.driftMs | 2726 | 3447 |
| chaos.duplicates | 0.3 | 0.4 |
| chaos.errorsShown | 0 | 0 |
| chaos.latencyMs | 964 | 1061 |
| chaos.maxDriftMs | 2726 | 3399 |
| chaos.ordersCreated | 1.1 | 1.4 |
| chaos.untilTimeouts | 2 | – |
| chaos.wrongCharges | 1 | 1.3 |
| clean.driftMs | 0 | 0 |
| clean.duplicates | 0 | 0 |
| clean.errorsShown | 0 | 0 |
| clean.latencyMs | 239 | 206 |
| clean.maxDriftMs | 0 | 0 |
| clean.ordersCreated | 1 | 1 |
| clean.untilTimeouts | – | – |
| clean.wrongCharges | 0 | 0 |

## Service status (`status`)

- **guard**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 16.9; detections per trial 4.7; model decision latency p50 1.26 s, p95 4.58 s; user-visible latency p50 1.27 s clean, 2.17 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×46, gain # of delay over send is not above the guard margin # ×4, gain # of coalesce over send is not above the guard margin # ×23, the model's diagnosis is expected ×2.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.40; decisions per trial 13.5; detections per trial 4.2; model decision latency p50 1.49 s, p95 4.80 s; user-visible latency p50 487 ms clean, 1.46 s chaos. Actions: retry ×3, discard ×1. Chosen but not run: observe mode never changes execution ×4, gain # of retry over deliver is not above the heal margin # ×10, the subject was not held (decided in the background) ×5, gain # of delay over send is not above the guard margin # ×2, gain # of serve_cached over send is not above the heal margin # ×7, gain # of serve_cached over deliver is not above the heal margin # ×9, gain # of coalesce over send is not above the guard margin # ×14.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.banners | 4.2 | 4 |
| chaos.falseAlarmMs | 4869 | 4599 |
| chaos.latencyMs | 1943 | 1852 |
| chaos.missedMs | 0 | 0 |
| chaos.otherWrongMs | 0 | 0 |
| chaos.requestRatio | 1.32 | 1.35 |
| chaos.requests | 71.2 | 72.8 |
| clean.banners | 0 | 0 |
| clean.falseAlarmMs | 0 | 0 |
| clean.latencyMs | 1034 | 531 |
| clean.missedMs | 0 | 0 |
| clean.otherWrongMs | 0 | 0 |
| clean.requestRatio | 0.97 | 0.97 |
| clean.requests | 46.8 | 46.8 |

## Team board (`board`)

- **guard**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.50; decisions per trial 5.4; detections per trial 1.6; model decision latency p50 591 ms, p95 2.96 s; user-visible latency p50 35 ms clean, 34 ms chaos. Actions: discard ×5. Chosen but not run: superseded: board.cards.c#.column changed again after the write applied ×1, gain # of coalesce over send is not above the guard margin # ×3, too late to revert: decided #s after the write applied ×3, gain # of discard over apply is not above the guard margin # ×3, superseded: board.cards.c#.version changed again after the write applied ×2.
- **heal**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.30; decisions per trial 5.3; detections per trial 1.4; model decision latency p50 377 ms, p95 2.46 s; user-visible latency p50 27 ms clean, 35 ms chaos. Actions: discard ×3. Chosen but not run: gain # of coalesce over send is not above the guard margin # ×2, too late to revert: decided #s after the write applied ×3, superseded: board.cards.c#.column changed again after the write applied ×1, gain # of discard over apply is not above the guard margin # ×3, superseded: board.cards.c#.version changed again after the write applied ×1, gain # of discard over deliver is not above the guard margin # ×1.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.divergedMs | 6378 | 4940 |
| chaos.finalMismatches | 1 | 0.8 |
| chaos.jumpBacks | 4.9 | 4.4 |
| chaos.latencyMs | 454 | 119 |
| chaos.maxDivergedMs | 5997 | 4579 |
| chaos.teammateMoves | 5.2 | 5.2 |
| chaos.userMoves | 10.9 | 10.7 |
| clean.divergedMs | 0 | 0 |
| clean.finalMismatches | 0 | 0 |
| clean.jumpBacks | 0.4 | 0.4 |
| clean.latencyMs | 29.6 | 28.6 |
| clean.maxDivergedMs | 0 | 0 |
| clean.teammateMoves | 0.6 | 0.6 |
| clean.userMoves | 5.2 | 5.2 |

## Runtime decisions (`decisions`)

- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 40% (2/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.8; detections per trial 5.0; model decision latency p50 211 ms, p95 1.26 s; user-visible latency p50 163 ms clean, 196 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×15, gain # of delay over send is not above the guard margin # ×1, gain # of coalesce over send is not above the guard margin # ×1.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.80; decisions per trial 7.5; detections per trial 4.6; model decision latency p50 209 ms, p95 2.12 s; user-visible latency p50 170 ms clean, 181 ms chaos. Actions: retry ×8. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×4, observe mode never changes execution ×2, the subject was not held (decided in the background) ×3, gain # of delay over send is not above the guard margin # ×1.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.accuracy | 0.47 | 0.53 |
| chaos.answeredByGenClass | 3.3 | 3.2 |
| chaos.backup.n | 1.2 | 1.4 |
| chaos.backup.ok | 0 | 0.2 |
| chaos.decisions | 3.4 | 3.5 |
| chaos.health.n | 1 | 1 |
| chaos.health.ok | 0.4 | 0.6 |
| chaos.latencyMs | 199 | 440 |
| chaos.leave.n | 2 | 2 |
| chaos.leave.ok | 1.3 | 1.3 |
| chaos.quality.n | 1 | 1 |
| chaos.quality.ok | 0.33 | 0.33 |
| chaos.untilTimeouts | 1 | 1 |
| chaos.wrong | 1.8 | 1.7 |
| clean.accuracy | 0.88 | 0.93 |
| clean.answeredByGenClass | 3.2 | 3 |
| clean.backup.n | 1.2 | 1 |
| clean.backup.ok | 1 | 1 |
| clean.decisions | 3.2 | 3 |
| clean.health.n | 1 | 1 |
| clean.health.ok | 0.75 | 0.75 |
| clean.latencyMs | 210 | 222 |
| clean.leave.n | 1 | 1 |
| clean.leave.ok | 1 | 1 |
| clean.quality.n | 1 | 1 |
| clean.quality.ok | 1 | 1 |
| clean.untilTimeouts | – | – |
| clean.wrong | 0.4 | 0.2 |

## How to reproduce

```bash
scripts/vm.sh run demos 'setsid nohup bash demos/scripts/vm-eval.sh > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
# or, on any machine: npm install && npm run build -w @genclass/runtime && cd demos && npm run fetch-model && npm run build && npm run eval
```
