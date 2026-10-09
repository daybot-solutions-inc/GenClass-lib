# GenClass Runtime demos: trial results

Generated 2026-10-09T07:23:24.219Z on the build VM. Runtime: **real** (@genclass/runtime 0.1.0-beta.4, dist d0fd6e20ecfc). Model: genclass-runtime-r17 on wasm q8, cross-origin isolated (WASM threads available).

Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). 10 chaos trials and 5 clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.

| Demo | Mode | Chaos bug rate | Fixed/introduced vs Off | Clean bugs | False interventions (clean) | False findings (clean) | Findings / chaos trial | Actions / chaos trial | Actions run | User latency p50 (clean) | Decision p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search typeahead | guard | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 2 in 2/5 | 0.90 | 0.00 | – | 13 ms | 724 ms |
| Search typeahead | heal | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 2 in 1/5 | 0.90 | 0.00 | – | 10 ms | 675 ms |
| Notes autosave | guard | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 3.10 | 0.00 | – | 791 ms | 376 ms |
| Notes autosave | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 3.30 | 0.00 | – | 784 ms | 374 ms |
| Cart & checkout | guard | 80% (8/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.50 | 0.00 | – | 226 ms | 276 ms |
| Cart & checkout | heal | 80% (8/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.80 | 0.00 | – | 205 ms | 398 ms |
| Service status | guard | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 3.40 | 0.00 | – | 1.29 s | 1.70 s |
| Service status | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.80 | 0.00 | – | 1.36 s | 2.17 s |
| Team board | guard | 40% (4/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.80 | 0.00 | – | 33 ms | 443 ms |
| Team board | heal | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.80 | 0.00 | – | 46 ms | 489 ms |
| Runtime decisions | guard | 90% (9/10) | 0/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 6.70 | 0.00 | – | 138 ms | 208 ms |
| Runtime decisions | heal | 90% (9/10) | 0/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 6.00 | 0.00 | – | 144 ms | 258 ms |

## Search typeahead (`search`)

- **guard**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 1.6; detections per trial 0.7; model decision latency p50 724 ms, p95 1.41 s; user-visible latency p50 13 ms clean, 20 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×6, gain # of discard over deliver is not above the guard margin # ×4, gain # of coalesce over send is not above the guard margin # ×2, guard mode does not allow heal-tier actions ×2.
- **heal**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 1.5; detections per trial 0.7; model decision latency p50 675 ms, p95 1.47 s; user-visible latency p50 10 ms clean, 71 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×8, gain # of discard over deliver is not above the guard margin # ×3, gain # of coalesce over send is not above the guard margin # ×1, gain # of retry over deliver is not above the heal margin # ×1.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.finalWrong | 0.1 | 0.1 |
| chaos.latencyMs | 434 | 420 |
| chaos.requests | 10.8 | 11 |
| chaos.staleMs | 473 | 416 |
| chaos.staleShare | 0.08 | 0.07 |
| chaos.wrongVisibleMs | 4242 | 4164 |
| clean.finalWrong | 0 | 0 |
| clean.latencyMs | 69.8 | 64.8 |
| clean.requests | 11.4 | 11.2 |
| clean.staleMs | 63.8 | 0 |
| clean.staleShare | 0.01 | 0 |
| clean.wrongVisibleMs | 2004 | 1976 |

## Notes autosave (`editor`)

- **guard**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 6.2; detections per trial 2.1; model decision latency p50 376 ms, p95 1.86 s; user-visible latency p50 791 ms clean, 2.48 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×7, gain # of discard over deliver is not above the guard margin # ×15, gain # of discard over apply is not above the guard margin # ×6, gain # of coalesce over send is not above the guard margin # ×8.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 6.1; detections per trial 2.2; model decision latency p50 374 ms, p95 2.47 s; user-visible latency p50 784 ms clean, 2.19 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×3, gain # of discard over apply is not above the guard margin # ×8, gain # of discard over deliver is not above the guard margin # ×12, gain # of coalesce over send is not above the guard margin # ×8.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.finalLie | 0.1 | 0.1 |
| chaos.latencyMs | 3144 | 2088 |
| chaos.lieMs | 7547 | 6946 |
| chaos.lostLocal | 1 | 1 |
| chaos.lostServer | 0.1 | 0.1 |
| chaos.maxLieMs | 6648 | 6104 |
| chaos.reverts | 1.3 | 1.4 |
| chaos.saves | 11.2 | 11.5 |
| clean.finalLie | 0 | 0 |
| clean.latencyMs | 794 | 789 |
| clean.lieMs | 160 | 45.8 |
| clean.lostLocal | 0 | 0 |
| clean.lostServer | 0 | 0 |
| clean.maxLieMs | 160 | 45.8 |
| clean.reverts | 0 | 0 |
| clean.saves | 14.2 | 14.2 |

## Cart & checkout (`checkout`)

- **guard**: bug rate 80% (8/10, 95% CI 49%–94%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 3.1; detections per trial 1.0; model decision latency p50 276 ms, p95 1.59 s; user-visible latency p50 226 ms clean, 696 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×3, gain # of coalesce over send is not above the guard margin # ×8, gain # of discard over apply is not above the guard margin # ×8, gain # of discard over deliver is not above the guard margin # ×3.
- **heal**: bug rate 80% (8/10, 95% CI 49%–94%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 3.0; detections per trial 1.2; model decision latency p50 398 ms, p95 2.14 s; user-visible latency p50 205 ms clean, 634 ms chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×2, gain # of coalesce over send is not above the guard margin # ×6, gain # of discard over apply is not above the guard margin # ×8, gain # of resync over ignore is not above the heal margin # ×1, gain # of discard over deliver is not above the guard margin # ×1.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.driftMs | 2994 | 3171 |
| chaos.duplicates | 0.5 | 0.5 |
| chaos.errorsShown | 0 | 0 |
| chaos.latencyMs | 1338 | 1044 |
| chaos.maxDriftMs | 2973 | 3156 |
| chaos.ordersCreated | 1.3 | 1.3 |
| chaos.untilTimeouts | 2 | 2 |
| chaos.wrongCharges | 1.2 | 1.3 |
| clean.driftMs | 0 | 0 |
| clean.duplicates | 0 | 0 |
| clean.errorsShown | 0 | 0 |
| clean.latencyMs | 223 | 213 |
| clean.maxDriftMs | 0 | 0 |
| clean.ordersCreated | 1 | 1 |
| clean.untilTimeouts | – | – |
| clean.wrongCharges | 0 | 0 |

## Service status (`status`)

- **guard**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 11.6; detections per trial 2.3; model decision latency p50 1.70 s, p95 4.61 s; user-visible latency p50 1.29 s clean, 1.71 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×30, gain # of delay over send is not above the guard margin # ×6, gain # of coalesce over send is not above the guard margin # ×6, gain # of discard over apply is not above the guard margin # ×1.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 11.1; detections per trial 1.9; model decision latency p50 2.17 s, p95 4.79 s; user-visible latency p50 1.36 s clean, 1.82 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×15, gain # of coalesce over send is not above the guard margin # ×9, gain # of serve_cached over send is not above the heal margin # ×10, gain # of serve_cached over deliver is not above the heal margin # ×7, gain # of delay over send is not above the guard margin # ×2, gain # of discard over apply is not above the guard margin # ×1.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.banners | 4.3 | 4 |
| chaos.falseAlarmMs | 5600 | 5082 |
| chaos.latencyMs | 2078 | 2085 |
| chaos.missedMs | 0 | 0 |
| chaos.otherWrongMs | 0 | 0 |
| chaos.requestRatio | 1.33 | 1.36 |
| chaos.requests | 72.8 | 74.6 |
| clean.banners | 0 | 0 |
| clean.falseAlarmMs | 0 | 0 |
| clean.latencyMs | 1094 | 1169 |
| clean.missedMs | 0 | 0 |
| clean.otherWrongMs | 0 | 0 |
| clean.requestRatio | 0.94 | 0.94 |
| clean.requests | 46.8 | 46.8 |

## Team board (`board`)

- **guard**: bug rate 40% (4/10, 95% CI 17%–69%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 5.0; detections per trial 1.2; model decision latency p50 443 ms, p95 2.23 s; user-visible latency p50 33 ms clean, 777 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×20, gain # of coalesce over send is not above the guard margin # ×4.
- **heal**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 5.2; detections per trial 1.2; model decision latency p50 489 ms, p95 2.36 s; user-visible latency p50 46 ms clean, 107 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×15, gain # of coalesce over send is not above the guard margin # ×4, gain # of discard over deliver is not above the guard margin # ×1.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.divergedMs | 3594 | 5340 |
| chaos.finalMismatches | 0.7 | 1.2 |
| chaos.jumpBacks | 5.1 | 5 |
| chaos.latencyMs | 836 | 378 |
| chaos.maxDivergedMs | 3156 | 4894 |
| chaos.teammateMoves | 5.2 | 5.6 |
| chaos.userMoves | 11 | 10.5 |
| clean.divergedMs | 0 | 0 |
| clean.finalMismatches | 0 | 0 |
| clean.jumpBacks | 0.4 | 0.4 |
| clean.latencyMs | 26.6 | 321 |
| clean.maxDivergedMs | 0 | 0 |
| clean.teammateMoves | 0.4 | 0.6 |
| clean.userMoves | 5.2 | 5.2 |

## Runtime decisions (`decisions`)

- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.9; detections per trial 4.5; model decision latency p50 208 ms, p95 2.42 s; user-visible latency p50 138 ms clean, 312 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×14, gain # of coalesce over send is not above the guard margin # ×1.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 6.8; detections per trial 4.0; model decision latency p50 258 ms, p95 2.12 s; user-visible latency p50 144 ms clean, 230 ms chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×11, gain # of coalesce over send is not above the guard margin # ×1.

| metric (mean) | guard | heal |
|---|---|---|
| chaos.accuracy | 0.47 | 0.47 |
| chaos.answeredByGenClass | 3.3 | 3.3 |
| chaos.backup.n | 1.2 | 1.2 |
| chaos.backup.ok | 0 | 0 |
| chaos.decisions | 3.4 | 3.4 |
| chaos.health.n | 1 | 1 |
| chaos.health.ok | 0.4 | 0.4 |
| chaos.latencyMs | 397 | 321 |
| chaos.leave.n | 2 | 2 |
| chaos.leave.ok | 1.3 | 1.3 |
| chaos.quality.n | 1 | 1 |
| chaos.quality.ok | 0.33 | 0.33 |
| chaos.untilTimeouts | 1 | 1 |
| chaos.wrong | 1.8 | 1.8 |
| clean.accuracy | 0.93 | 0.93 |
| clean.answeredByGenClass | 3 | 3 |
| clean.backup.n | 1 | 1 |
| clean.backup.ok | 1 | 1 |
| clean.decisions | 3 | 3 |
| clean.health.n | 1 | 1 |
| clean.health.ok | 0.75 | 0.75 |
| clean.latencyMs | 153 | 158 |
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
