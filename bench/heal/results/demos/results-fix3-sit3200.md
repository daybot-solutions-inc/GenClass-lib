# GenClass Runtime demos: trial results

Generated 2026-10-09T08:23:26.006Z on the build VM. Runtime: **real** (@genclass/runtime 0.1.0-beta.4, dist 758d2337b4ea). Model: genclass-runtime-r17 on wasm q8, cross-origin isolated (WASM threads available).

Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). 10 chaos trials and 5 clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.

| Demo | Mode | Chaos bug rate | Fixed/introduced vs Off | Clean bugs | False interventions (clean) | False findings (clean) | Findings / chaos trial | Actions / chaos trial | Actions run | User latency p50 (clean) | Decision p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search typeahead | observe | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 3 in 2/5 | 1.50 | 0.00 | – | 18 ms | 1.88 s |
| Search typeahead | guard | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 2 in 2/5 | 1.50 | 0.00 | – | 14 ms | 2.09 s |
| Search typeahead | heal | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 4 in 3/5 | 1.80 | 0.00 | – | 12 ms | 1.98 s |
| Notes autosave | observe | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 4.90 | 0.00 | – | 787 ms | 1.11 s |
| Notes autosave | guard | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 4.30 | 0.00 | – | 796 ms | 1.35 s |
| Notes autosave | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 4.30 | 0.00 | – | 792 ms | 1.01 s |
| Cart & checkout | observe | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.40 | 0.00 | – | 198 ms | 518 ms |
| Cart & checkout | guard | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.60 | 0.00 | – | 216 ms | 591 ms |
| Cart & checkout | heal | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.50 | 0.00 | – | 201 ms | 505 ms |
| Service status | observe | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 3.00 | 0.00 | – | 973 ms | 1.62 s |
| Service status | guard | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.40 | 0.00 | – | 1.06 s | 2.40 s |
| Service status | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.90 | 0.00 | – | 1.15 s | 2.58 s |
| Team board | observe | 50% (5/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.70 | 0.00 | – | 32 ms | 2.05 s |
| Team board | guard | 40% (4/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.70 | 0.00 | – | 27 ms | 1.40 s |
| Team board | heal | 60% (6/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.00 | 0.00 | – | 24 ms | 1.71 s |
| Runtime decisions | observe | 90% (9/10) | 0/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 7.50 | 0.00 | – | 302 ms | 303 ms |
| Runtime decisions | guard | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 6.10 | 0.00 | – | 249 ms | 405 ms |
| Runtime decisions | heal | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 5.00 | 0.00 | – | 345 ms | 383 ms |

## Search typeahead (`search`)

- **observe**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 1.7; detections per trial 1.2; model decision latency p50 1.88 s, p95 3.50 s; user-visible latency p50 18 ms clean, 12 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×16.
- **guard**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 1.7; detections per trial 1.1; model decision latency p50 2.09 s, p95 4.17 s; user-visible latency p50 14 ms clean, 17 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×9, gain # of coalesce over send is not above the guard margin # ×3, superseded: search.query changed again after the write applied ×1, guard mode does not allow heal-tier actions ×2, too late to revert: decided #s after the write applied ×1.
- **heal**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.1; detections per trial 1.5; model decision latency p50 1.98 s, p95 3.40 s; user-visible latency p50 12 ms clean, 19 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×10, too late to revert: decided #s after the write applied ×4, gain # of coalesce over send is not above the guard margin # ×4, superseded: search.query changed again after the write applied ×1, gain # of retry over deliver is not above the heal margin # ×2.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.finalWrong | 0.1 | 0.1 | 0.1 |
| chaos.latencyMs | 378 | 397 | 433 |
| chaos.requests | 12 | 12.1 | 12.7 |
| chaos.staleMs | 530 | 500 | 535 |
| chaos.staleShare | 0.06 | 0.08 | 0.09 |
| chaos.wrongVisibleMs | 4751 | 4558 | 4755 |
| clean.finalWrong | 0 | 0 | 0 |
| clean.latencyMs | 59.2 | 77.8 | 37.8 |
| clean.requests | 13 | 12 | 12.2 |
| clean.staleMs | 0 | 0 | 60.2 |
| clean.staleShare | 0 | 0 | 0.01 |
| clean.wrongVisibleMs | 2134 | 1907 | 2198 |

## Notes autosave (`editor`)

- **observe**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 6.7; detections per trial 3.3; model decision latency p50 1.11 s, p95 3.63 s; user-visible latency p50 787 ms clean, 1.78 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×63.
- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 5.5; detections per trial 2.9; model decision latency p50 1.35 s, p95 4.03 s; user-visible latency p50 796 ms clean, 1.44 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×8, gain # of coalesce over send is not above the guard margin # ×8, gain # of discard over apply is not above the guard margin # ×11, gain # of discard over deliver is not above the guard margin # ×5.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 5.9; detections per trial 2.9; model decision latency p50 1.01 s, p95 3.94 s; user-visible latency p50 792 ms clean, 1.69 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×5, gain # of discard over apply is not above the guard margin # ×10, gain # of coalesce over send is not above the guard margin # ×8, gain # of discard over deliver is not above the guard margin # ×11.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.finalLie | 0.1 | 0.1 | 0.1 |
| chaos.latencyMs | 2981 | 1483 | 1705 |
| chaos.lieMs | 7638 | 7368 | 6752 |
| chaos.lostLocal | 0.9 | 0.9 | 1 |
| chaos.lostServer | 0.1 | 0.1 | 0.1 |
| chaos.maxLieMs | 6959 | 6416 | 6230 |
| chaos.reverts | 1.6 | 1.1 | 1.2 |
| chaos.saves | 11.3 | 11.5 | 10.9 |
| clean.finalLie | 0 | 0 | 0 |
| clean.latencyMs | 647 | 654 | 652 |
| clean.lieMs | 44.8 | 45.4 | 40 |
| clean.lostLocal | 0 | 0 | 0 |
| clean.lostServer | 0 | 0 | 0 |
| clean.maxLieMs | 44.8 | 45.4 | 40 |
| clean.reverts | 0 | 0 | 0 |
| clean.saves | 14 | 13.8 | 13.6 |

## Cart & checkout (`checkout`)

- **observe**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.8; detections per trial 0.9; model decision latency p50 518 ms, p95 2.91 s; user-visible latency p50 198 ms clean, 725 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×14.
- **guard**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.4; detections per trial 1.1; model decision latency p50 591 ms, p95 2.88 s; user-visible latency p50 216 ms clean, 734 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×2, gain # of coalesce over send is not above the guard margin # ×4, gain # of discard over apply is not above the guard margin # ×6, gain # of discard over deliver is not above the guard margin # ×2.
- **heal**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.3; detections per trial 1.0; model decision latency p50 505 ms, p95 3.65 s; user-visible latency p50 201 ms clean, 777 ms chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×2, gain # of coalesce over send is not above the guard margin # ×1, gain # of discard over apply is not above the guard margin # ×7, gain # of discard over deliver is not above the guard margin # ×2.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.driftMs | 3042 | 3167 | 3075 |
| chaos.duplicates | 0.5 | 0.2 | 0.2 |
| chaos.errorsShown | 0 | 0 | 0 |
| chaos.latencyMs | 1239 | 1286 | 753 |
| chaos.maxDriftMs | 3042 | 3099 | 3048 |
| chaos.ordersCreated | 1.3 | 1 | 1 |
| chaos.untilTimeouts | 2 | 2 | 2 |
| chaos.wrongCharges | 1.2 | 0.9 | 0.9 |
| clean.driftMs | 0 | 0 | 0 |
| clean.duplicates | 0 | 0 | 0 |
| clean.errorsShown | 0 | 0 | 0 |
| clean.latencyMs | 217 | 215 | 203 |
| clean.maxDriftMs | 0 | 0 | 0 |
| clean.ordersCreated | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – |
| clean.wrongCharges | 0 | 0 | 0 |

## Service status (`status`)

- **observe**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 6.4; detections per trial 2.0; model decision latency p50 1.62 s, p95 4.55 s; user-visible latency p50 973 ms clean, 1.51 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×28.
- **guard**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 4.8; detections per trial 1.6; model decision latency p50 2.40 s, p95 4.69 s; user-visible latency p50 1.06 s clean, 1.25 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×15, gain # of delay over send is not above the guard margin # ×3, gain # of discard over apply is not above the guard margin # ×1, gain # of coalesce over send is not above the guard margin # ×7.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 3.9; detections per trial 1.3; model decision latency p50 2.58 s, p95 4.86 s; user-visible latency p50 1.15 s clean, 1.07 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×8, gain # of discard over apply is not above the guard margin # ×1, gain # of delay over send is not above the guard margin # ×2, gain # of serve_cached over send is not above the heal margin # ×1, gain # of coalesce over send is not above the guard margin # ×4.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.banners | 4.1 | 4.3 | 4.2 |
| chaos.falseAlarmMs | 5198 | 5248 | 4970 |
| chaos.latencyMs | 1755 | 1927 | 1562 |
| chaos.missedMs | 0 | 0 | 0 |
| chaos.otherWrongMs | 0 | 0 | 0 |
| chaos.requestRatio | 1.32 | 1.34 | 1.34 |
| chaos.requests | 74.9 | 77.1 | 77.4 |
| clean.banners | 0 | 0 | 0 |
| clean.falseAlarmMs | 0 | 0 | 0 |
| clean.latencyMs | 1084 | 1051 | 1209 |
| clean.missedMs | 0 | 0 | 0 |
| clean.otherWrongMs | 0 | 0 | 0 |
| clean.requestRatio | 0.93 | 0.96 | 0.95 |
| clean.requests | 45.6 | 46.8 | 46.8 |

## Team board (`board`)

- **observe**: bug rate 50% (5/10, 95% CI 24%–76%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 4.3; detections per trial 0.5; model decision latency p50 2.05 s, p95 4.55 s; user-visible latency p50 32 ms clean, 25 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×14.
- **guard**: bug rate 40% (4/10, 95% CI 17%–69%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 3.6; detections per trial 1.1; model decision latency p50 1.40 s, p95 4.23 s; user-visible latency p50 27 ms clean, 41 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×10, gain # of coalesce over send is not above the guard margin # ×2.
- **heal**: bug rate 60% (6/10, 95% CI 31%–83%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 3.5; detections per trial 1.3; model decision latency p50 1.71 s, p95 4.19 s; user-visible latency p50 24 ms clean, 128 ms chaos. Actions: none. Chosen but not run: gain # of coalesce over send is not above the guard margin # ×6, gain # of discard over apply is not above the guard margin # ×4, gain # of discard over deliver is not above the guard margin # ×1.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.divergedMs | 3764 | 3855 | 4729 |
| chaos.finalMismatches | 0.7 | 0.5 | 0.9 |
| chaos.jumpBacks | 4.6 | 3.8 | 4.8 |
| chaos.latencyMs | 18.6 | 258 | 676 |
| chaos.maxDivergedMs | 3485 | 3665 | 4364 |
| chaos.teammateMoves | 5.8 | 5.8 | 5.5 |
| chaos.userMoves | 10.7 | 10.6 | 10.8 |
| clean.divergedMs | 0 | 0 | 0 |
| clean.finalMismatches | 0 | 0 | 0 |
| clean.jumpBacks | 0.6 | 0.6 | 0 |
| clean.latencyMs | 28.4 | 24.2 | 31 |
| clean.maxDivergedMs | 0 | 0 | 0 |
| clean.teammateMoves | 0.4 | 0.4 | 0.4 |
| clean.userMoves | 5.2 | 5.2 | 5.2 |

## Runtime decisions (`decisions`)

- **observe**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 8.2; detections per trial 5.0; model decision latency p50 303 ms, p95 2.84 s; user-visible latency p50 302 ms clean, 598 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×13.
- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.0; detections per trial 4.1; model decision latency p50 405 ms, p95 4.40 s; user-visible latency p50 249 ms clean, 738 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×12.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 5.7; detections per trial 3.3; model decision latency p50 383 ms, p95 3.87 s; user-visible latency p50 345 ms clean, 671 ms chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×9.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.accuracy | 0.49 | 0.41 | 0.41 |
| chaos.answeredByGenClass | 3.1 | 2.9 | 2.9 |
| chaos.backup.n | 1.4 | 1.2 | 1.2 |
| chaos.backup.ok | 0.2 | 0 | 0 |
| chaos.decisions | 3.5 | 3.4 | 3.4 |
| chaos.health.n | 1 | 1 | 1 |
| chaos.health.ok | 0.4 | 0.4 | 0.4 |
| chaos.latencyMs | 490 | 728 | 679 |
| chaos.leave.n | 2 | 2 | 2 |
| chaos.leave.ok | 1.3 | 1.1 | 1.1 |
| chaos.quality.n | 1 | 1 | 1 |
| chaos.quality.ok | 0.33 | 0.33 | 0.33 |
| chaos.untilTimeouts | 1 | 1 | 1 |
| chaos.wrong | 1.8 | 2 | 2 |
| clean.accuracy | 0.93 | 1 | 1 |
| clean.answeredByGenClass | 3 | 2.8 | 2.8 |
| clean.backup.n | 1 | 1 | 1 |
| clean.backup.ok | 1 | 1 | 1 |
| clean.decisions | 3 | 3 | 3 |
| clean.health.n | 1 | 1 | 1 |
| clean.health.ok | 0.75 | 1 | 1 |
| clean.latencyMs | 387 | 418 | 501 |
| clean.leave.n | 1 | 1 | 1 |
| clean.leave.ok | 1 | 1 | 1 |
| clean.quality.n | 1 | 1 | 1 |
| clean.quality.ok | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – |
| clean.wrong | 0.2 | 0 | 0 |

## How to reproduce

```bash
scripts/vm.sh run demos 'setsid nohup bash demos/scripts/vm-eval.sh > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
# or, on any machine: npm install && npm run build -w @genclass/runtime && cd demos && npm run fetch-model && npm run build && npm run eval
```
