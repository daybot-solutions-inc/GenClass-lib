# GenClass Runtime demos: trial results

Generated 2026-10-09T08:23:42.682Z on the build VM. Runtime: **real** (@genclass/runtime 0.1.0-beta.4, dist 758d2337b4ea). Model: genclass-runtime-r17 on wasm q8, cross-origin isolated (WASM threads available).

Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). 10 chaos trials and 5 clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.

| Demo | Mode | Chaos bug rate | Fixed/introduced vs Off | Clean bugs | False interventions (clean) | False findings (clean) | Findings / chaos trial | Actions / chaos trial | Actions run | User latency p50 (clean) | Decision p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search typeahead | observe | 20% (2/10) | 0/0 | 1/5 | 0 in 0/5 | 3 in 3/5 | 1.50 | 0.00 | – | 5 ms | 1.19 s |
| Search typeahead | guard | 20% (2/10) | 0/0 | 1/5 | 0 in 0/5 | 2 in 2/5 | 1.60 | 0.00 | – | 12 ms | 1.57 s |
| Search typeahead | heal | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 2 in 2/5 | 1.70 | 0.10 | discard 1 | 14 ms | 1.03 s |
| Notes autosave | observe | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 4.10 | 0.00 | – | 787 ms | 642 ms |
| Notes autosave | guard | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 4.90 | 0.00 | – | 791 ms | 539 ms |
| Notes autosave | heal | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 5.60 | 0.00 | – | 790 ms | 446 ms |
| Cart & checkout | observe | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.50 | 0.00 | – | 201 ms | 573 ms |
| Cart & checkout | guard | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.80 | 0.00 | – | 276 ms | 527 ms |
| Cart & checkout | heal | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.00 | 0.00 | – | 229 ms | 445 ms |
| Service status | observe | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.50 | 0.00 | – | 1.24 s | 2.73 s |
| Service status | guard | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.80 | 0.00 | – | 905 ms | 3.10 s |
| Service status | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.70 | 0.00 | – | 1.17 s | 2.46 s |
| Team board | observe | 50% (5/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.00 | 0.00 | – | 19 ms | 646 ms |
| Team board | guard | 60% (6/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.70 | 0.00 | – | 28 ms | 580 ms |
| Team board | heal | 40% (4/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.50 | 0.00 | – | 9 ms | 236 ms |
| Runtime decisions | observe | 90% (9/10) | 0/0 | 2/5 | 0 in 0/5 | 0 in 0/5 | 7.20 | 0.00 | – | 462 ms | 410 ms |
| Runtime decisions | guard | 90% (9/10) | 0/0 | 2/5 | 0 in 0/5 | 0 in 0/5 | 7.10 | 0.00 | – | 449 ms | 419 ms |
| Runtime decisions | heal | 90% (9/10) | 0/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 5.50 | 0.00 | – | 340 ms | 442 ms |

## Search typeahead (`search`)

- **observe**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.1; detections per trial 1.2; model decision latency p50 1.19 s, p95 2.84 s; user-visible latency p50 5 ms clean, 18 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×19.
- **guard**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 1.9; detections per trial 1.2; model decision latency p50 1.57 s, p95 3.71 s; user-visible latency p50 12 ms clean, 17 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×13, too late to revert: decided #s after the write applied ×1, gain # of coalesce over send is not above the guard margin # ×1, guard mode does not allow heal-tier actions ×2.
- **heal**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.10; decisions per trial 2.0; detections per trial 1.3; model decision latency p50 1.03 s, p95 3.43 s; user-visible latency p50 14 ms clean, 17 ms chaos. Actions: discard ×1. Chosen but not run: gain # of discard over apply is not above the guard margin # ×11, too late to revert: decided #s after the write applied ×1, gain # of coalesce over send is not above the guard margin # ×1, gain # of discard over deliver is not above the guard margin # ×1, gain # of retry over deliver is not above the heal margin # ×2.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.finalWrong | 0.1 | 0.1 | 0.1 |
| chaos.latencyMs | 359 | 355 | 414 |
| chaos.requests | 12.5 | 11.9 | 12.3 |
| chaos.staleMs | 641 | 530 | 532 |
| chaos.staleShare | 0.09 | 0.09 | 0.09 |
| chaos.wrongVisibleMs | 4911 | 5043 | 4846 |
| clean.finalWrong | 0 | 0 | 0 |
| clean.latencyMs | 49.8 | 57 | 69.4 |
| clean.requests | 11.2 | 11.6 | 11.8 |
| clean.staleMs | 411 | 352 | 60.4 |
| clean.staleShare | 0.06 | 0.05 | 0.01 |
| clean.wrongVisibleMs | 2554 | 2427 | 2132 |

## Notes autosave (`editor`)

- **observe**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 6.1; detections per trial 2.7; model decision latency p50 642 ms, p95 1.71 s; user-visible latency p50 787 ms clean, 2.01 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×42.
- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 6.3; detections per trial 3.3; model decision latency p50 539 ms, p95 1.91 s; user-visible latency p50 791 ms clean, 1.88 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×6, gain # of coalesce over send is not above the guard margin # ×12, gain # of discard over apply is not above the guard margin # ×10, gain # of discard over deliver is not above the guard margin # ×6.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.7; detections per trial 3.7; model decision latency p50 446 ms, p95 2.18 s; user-visible latency p50 790 ms clean, 2.19 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×6, gain # of discard over apply is not above the guard margin # ×9, gain # of coalesce over send is not above the guard margin # ×9, gain # of discard over deliver is not above the guard margin # ×7.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.finalLie | 0.2 | 0.1 | 0.2 |
| chaos.latencyMs | 2395 | 2111 | 3381 |
| chaos.lieMs | 7775 | 7288 | 7591 |
| chaos.lostLocal | 0.9 | 0.9 | 0.9 |
| chaos.lostServer | 0.2 | 0.1 | 0.2 |
| chaos.maxLieMs | 7021 | 6708 | 6671 |
| chaos.reverts | 0.9 | 1.2 | 1.3 |
| chaos.saves | 11 | 11.2 | 11.6 |
| clean.finalLie | 0 | 0 | 0 |
| clean.latencyMs | 789 | 790 | 795 |
| clean.lieMs | 47.4 | 42.8 | 44.6 |
| clean.lostLocal | 0 | 0 | 0 |
| clean.lostServer | 0 | 0 | 0 |
| clean.maxLieMs | 47.4 | 42.8 | 44.6 |
| clean.reverts | 0 | 0 | 0 |
| clean.saves | 14 | 14 | 14 |

## Cart & checkout (`checkout`)

- **observe**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.6; detections per trial 1.0; model decision latency p50 573 ms, p95 2.58 s; user-visible latency p50 201 ms clean, 760 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×10.
- **guard**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.4; detections per trial 1.2; model decision latency p50 527 ms, p95 3.32 s; user-visible latency p50 276 ms clean, 607 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×2, gain # of coalesce over send is not above the guard margin # ×4, gain # of discard over apply is not above the guard margin # ×2, gain # of discard over deliver is not above the guard margin # ×1.
- **heal**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.5; detections per trial 1.3; model decision latency p50 445 ms, p95 3.29 s; user-visible latency p50 229 ms clean, 744 ms chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×2, gain # of coalesce over send is not above the guard margin # ×5, gain # of discard over apply is not above the guard margin # ×2, gain # of rollback over ignore is not above the heal margin # ×1.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.driftMs | 3484 | 3344 | 2996 |
| chaos.duplicates | 0.4 | 0.5 | 0.5 |
| chaos.errorsShown | 0 | 0 | 0 |
| chaos.latencyMs | 1016 | 1031 | 1048 |
| chaos.maxDriftMs | 3350 | 3344 | 2957 |
| chaos.ordersCreated | 1.2 | 1.3 | 1.3 |
| chaos.untilTimeouts | 2 | 2 | 2 |
| chaos.wrongCharges | 1.1 | 1.2 | 1.2 |
| clean.driftMs | 0 | 0 | 0 |
| clean.duplicates | 0 | 0 | 0 |
| clean.errorsShown | 0 | 0 | 0 |
| clean.latencyMs | 205 | 306 | 255 |
| clean.maxDriftMs | 0 | 0 | 0 |
| clean.ordersCreated | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – |
| clean.wrongCharges | 0 | 0 | 0 |

## Service status (`status`)

- **observe**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 5.5; detections per trial 1.7; model decision latency p50 2.73 s, p95 4.89 s; user-visible latency p50 1.24 s clean, 1.24 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×19.
- **guard**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 5.7; detections per trial 1.9; model decision latency p50 3.10 s, p95 4.89 s; user-visible latency p50 905 ms clean, 1.65 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×12, gain # of discard over apply is not above the guard margin # ×1, gain # of delay over send is not above the guard margin # ×3, gain # of coalesce over send is not above the guard margin # ×7.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.1; detections per trial 1.8; model decision latency p50 2.46 s, p95 4.79 s; user-visible latency p50 1.17 s clean, 1.35 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×8, gain # of discard over apply is not above the guard margin # ×1, gain # of delay over send is not above the guard margin # ×1, gain # of serve_cached over send is not above the heal margin # ×5, gain # of coalesce over send is not above the guard margin # ×3, gain # of serve_cached over deliver is not above the heal margin # ×4.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.banners | 4.2 | 4 | 4 |
| chaos.falseAlarmMs | 5328 | 5109 | 4734 |
| chaos.latencyMs | 1324 | 2210 | 1398 |
| chaos.missedMs | 0 | 0 | 0 |
| chaos.otherWrongMs | 0 | 5 | 5 |
| chaos.requestRatio | 1.35 | 1.34 | 1.33 |
| chaos.requests | 78.8 | 78.8 | 77.1 |
| clean.banners | 0 | 0 | 0 |
| clean.falseAlarmMs | 0 | 0 | 0 |
| clean.latencyMs | 1206 | 1078 | 890 |
| clean.missedMs | 0 | 0 | 0 |
| clean.otherWrongMs | 0 | 0 | 0 |
| clean.requestRatio | 0.96 | 0.96 | 0.96 |
| clean.requests | 46.8 | 46.8 | 46.8 |

## Team board (`board`)

- **observe**: bug rate 50% (5/10, 95% CI 24%–76%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.1; detections per trial 1.3; model decision latency p50 646 ms, p95 2.57 s; user-visible latency p50 19 ms clean, 305 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×26.
- **guard**: bug rate 60% (6/10, 95% CI 31%–83%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 5.3; detections per trial 1.8; model decision latency p50 580 ms, p95 2.45 s; user-visible latency p50 28 ms clean, 47 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×22, gain # of coalesce over send is not above the guard margin # ×4, gain # of discard over deliver is not above the guard margin # ×6.
- **heal**: bug rate 40% (4/10, 95% CI 17%–69%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 5.8; detections per trial 1.7; model decision latency p50 236 ms, p95 1.86 s; user-visible latency p50 9 ms clean, 97 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×16, gain # of coalesce over send is not above the guard margin # ×4, gain # of discard over deliver is not above the guard margin # ×3.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.divergedMs | 2792 | 3803 | 2958 |
| chaos.finalMismatches | 0.7 | 0.8 | 0.5 |
| chaos.jumpBacks | 4.3 | 4.2 | 4.9 |
| chaos.latencyMs | 503 | 398 | 343 |
| chaos.maxDivergedMs | 2369 | 3426 | 2609 |
| chaos.teammateMoves | 5.8 | 6 | 5.6 |
| chaos.userMoves | 10.9 | 10.6 | 11 |
| clean.divergedMs | 0 | 0 | 0 |
| clean.finalMismatches | 0 | 0 | 0 |
| clean.jumpBacks | 0.6 | 0.2 | 0.6 |
| clean.latencyMs | 24 | 156 | 23.2 |
| clean.maxDivergedMs | 0 | 0 | 0 |
| clean.teammateMoves | 0.4 | 0.4 | 0.4 |
| clean.userMoves | 5.2 | 5.2 | 5.2 |

## Runtime decisions (`decisions`)

- **observe**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 40% (2/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.7; detections per trial 4.8; model decision latency p50 410 ms, p95 3.84 s; user-visible latency p50 462 ms clean, 401 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×15.
- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 40% (2/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.2; detections per trial 4.7; model decision latency p50 419 ms, p95 3.92 s; user-visible latency p50 449 ms clean, 242 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×14, gain # of delay over send is not above the guard margin # ×1.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 6.4; detections per trial 3.7; model decision latency p50 442 ms, p95 4.39 s; user-visible latency p50 340 ms clean, 174 ms chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×11, gain # of delay over send is not above the guard margin # ×1.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.accuracy | 0.44 | 0.44 | 0.44 |
| chaos.answeredByGenClass | 2.9 | 2.8 | 2.8 |
| chaos.backup.n | 1.2 | 1.2 | 1.2 |
| chaos.backup.ok | 0 | 0 | 0 |
| chaos.decisions | 3.4 | 3.4 | 3.4 |
| chaos.health.n | 1 | 1 | 1 |
| chaos.health.ok | 0.4 | 0.4 | 0.4 |
| chaos.latencyMs | 487 | 503 | 457 |
| chaos.leave.n | 2 | 2 | 2 |
| chaos.leave.ok | 1.2 | 1.2 | 1.2 |
| chaos.quality.n | 1 | 1 | 1 |
| chaos.quality.ok | 0.33 | 0.33 | 0.33 |
| chaos.untilTimeouts | 1 | 1 | 1 |
| chaos.wrong | 1.9 | 1.9 | 1.9 |
| clean.accuracy | 0.88 | 0.88 | 0.93 |
| clean.answeredByGenClass | 3.2 | 3.2 | 3 |
| clean.backup.n | 1.2 | 1.2 | 1 |
| clean.backup.ok | 1 | 1 | 1 |
| clean.decisions | 3.2 | 3.2 | 3 |
| clean.health.n | 1 | 1 | 1 |
| clean.health.ok | 0.75 | 0.75 | 0.75 |
| clean.latencyMs | 389 | 472 | 304 |
| clean.leave.n | 1 | 1 | 1 |
| clean.leave.ok | 1 | 1 | 1 |
| clean.quality.n | 1 | 1 | 1 |
| clean.quality.ok | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – |
| clean.wrong | 0.4 | 0.4 | 0.2 |

## How to reproduce

```bash
scripts/vm.sh run demos 'setsid nohup bash demos/scripts/vm-eval.sh > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
# or, on any machine: npm install && npm run build -w @genclass/runtime && cd demos && npm run fetch-model && npm run build && npm run eval
```
