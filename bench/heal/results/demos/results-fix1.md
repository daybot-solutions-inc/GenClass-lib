# GenClass Runtime demos: trial results

Generated 2026-10-09T07:33:57.298Z on the build VM. Runtime: **real** (@genclass/runtime 0.1.0-beta.4, dist 053fa2794a40). Model: genclass-runtime-r17 on wasm q8, cross-origin isolated (WASM threads available).

Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). 10 chaos trials and 5 clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.

| Demo | Mode | Chaos bug rate | Fixed/introduced vs Off | Clean bugs | False interventions (clean) | False findings (clean) | Findings / chaos trial | Actions / chaos trial | Actions run | User latency p50 (clean) | Decision p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search typeahead | observe | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 2 in 2/5 | 1.00 | 0.00 | – | 15 ms | 490 ms |
| Search typeahead | guard | 20% (2/10) | 0/0 | 1/5 | 1 in 1/5 | 4 in 4/5 | 1.10 | 0.20 | discard 3 | 14 ms | 352 ms |
| Search typeahead | heal | 10% (1/10) | 0/0 | 1/5 | 1 in 1/5 | 4 in 4/5 | 1.10 | 0.20 | discard 3 | 14 ms | 871 ms |
| Notes autosave | observe | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 4.70 | 0.00 | – | 795 ms | 282 ms |
| Notes autosave | guard | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 1 in 1/5 | 4.90 | 0.00 | – | 800 ms | 432 ms |
| Notes autosave | heal | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 1 in 1/5 | 4.90 | 0.00 | – | 787 ms | 259 ms |
| Cart & checkout | observe | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.50 | 0.00 | – | 196 ms | 263 ms |
| Cart & checkout | guard | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.90 | 0.00 | – | 321 ms | 235 ms |
| Cart & checkout | heal | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.80 | 0.00 | – | 226 ms | 229 ms |
| Service status | observe | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 5.60 | 0.00 | – | 1.22 s | 1.51 s |
| Service status | guard | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 4.00 | 0.00 | – | 1.33 s | 1.70 s |
| Service status | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 3.20 | 0.00 | – | 864 ms | 3.36 s |
| Team board | observe | 50% (5/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.80 | 0.00 | – | 42 ms | 873 ms |
| Team board | guard | 50% (5/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.50 | 0.00 | – | 35 ms | 450 ms |
| Team board | heal | 50% (5/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.30 | 0.00 | – | 49 ms | 389 ms |
| Runtime decisions | observe | 90% (9/10) | 0/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 8.40 | 0.00 | – | 172 ms | 363 ms |
| Runtime decisions | guard | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 7.40 | 0.00 | – | 109 ms | 324 ms |
| Runtime decisions | heal | 90% (9/10) | 0/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 6.90 | 0.00 | – | 134 ms | 353 ms |

## Search typeahead (`search`)

- **observe**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 1.6; detections per trial 0.8; model decision latency p50 490 ms, p95 2.59 s; user-visible latency p50 15 ms clean, 95 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×13.
- **guard**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **1** (in 1/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.20; decisions per trial 1.7; detections per trial 1.0; model decision latency p50 352 ms, p95 2.04 s; user-visible latency p50 14 ms clean, 76 ms chaos. Actions: discard ×3. Chosen but not run: gain # of discard over deliver is not above the guard margin # ×3, gain # of discard over apply is not above the guard margin # ×7, guard mode does not allow heal-tier actions ×3.
- **heal**: bug rate 10% (1/10, 95% CI 2%–40%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **1** (in 1/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.20; decisions per trial 1.6; detections per trial 1.0; model decision latency p50 871 ms, p95 2.34 s; user-visible latency p50 14 ms clean, 133 ms chaos. Actions: discard ×3. Chosen but not run: gain # of discard over deliver is not above the guard margin # ×1, gain # of discard over apply is not above the guard margin # ×7, superseded: search.query changed again after the write applied ×1, gain # of coalesce over send is not above the guard margin # ×1, gain # of retry over deliver is not above the heal margin # ×1.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.finalWrong | 0.1 | 0.1 | 0 |
| chaos.latencyMs | 455 | 413 | 402 |
| chaos.requests | 10.9 | 10.9 | 11.6 |
| chaos.staleMs | 504 | 484 | 81.9 |
| chaos.staleShare | 0.08 | 0.09 | 0.01 |
| chaos.wrongVisibleMs | 4349 | 4190 | 3974 |
| clean.finalWrong | 0 | 0 | 0 |
| clean.latencyMs | 60.4 | 526 | 439 |
| clean.requests | 11.8 | 12.2 | 11 |
| clean.staleMs | 60.4 | 440 | 372 |
| clean.staleShare | 0.01 | 0.09 | 0.08 |
| clean.wrongVisibleMs | 2316 | 2462 | 2389 |

## Notes autosave (`editor`)

- **observe**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.0; detections per trial 3.1; model decision latency p50 282 ms, p95 1.80 s; user-visible latency p50 795 ms clean, 2.69 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×48.
- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 6.8; detections per trial 3.3; model decision latency p50 432 ms, p95 1.29 s; user-visible latency p50 800 ms clean, 2.24 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×6, gain # of discard over apply is not above the guard margin # ×5, gain # of coalesce over send is not above the guard margin # ×9, gain # of discard over deliver is not above the guard margin # ×22.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 6.7; detections per trial 3.3; model decision latency p50 259 ms, p95 1.41 s; user-visible latency p50 787 ms clean, 2.11 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×6, gain # of discard over deliver is not above the guard margin # ×21, gain # of discard over apply is not above the guard margin # ×7, gain # of coalesce over send is not above the guard margin # ×8.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.finalLie | 0.2 | 0.1 | 0.1 |
| chaos.latencyMs | 3204 | 2687 | 2614 |
| chaos.lieMs | 7283 | 6900 | 7346 |
| chaos.lostLocal | 1 | 0.9 | 0.9 |
| chaos.lostServer | 0.2 | 0.1 | 0.1 |
| chaos.maxLieMs | 6491 | 6243 | 6509 |
| chaos.reverts | 1.2 | 1.6 | 1.4 |
| chaos.saves | 11.1 | 10.9 | 11.2 |
| clean.finalLie | 0 | 0 | 0 |
| clean.latencyMs | 791 | 796 | 776 |
| clean.lieMs | 45 | 82 | 82.4 |
| clean.lostLocal | 0 | 0 | 0 |
| clean.lostServer | 0 | 0 | 0 |
| clean.maxLieMs | 45 | 82 | 82.4 |
| clean.reverts | 0 | 0 | 0 |
| clean.saves | 14 | 14.2 | 14.4 |

## Cart & checkout (`checkout`)

- **observe**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.9; detections per trial 1.0; model decision latency p50 263 ms, p95 1.02 s; user-visible latency p50 196 ms clean, 578 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×17.
- **guard**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.7; detections per trial 1.3; model decision latency p50 235 ms, p95 2.05 s; user-visible latency p50 321 ms clean, 590 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×2, gain # of coalesce over send is not above the guard margin # ×5, gain # of discard over apply is not above the guard margin # ×4, gain # of discard over deliver is not above the guard margin # ×2.
- **heal**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.6; detections per trial 1.2; model decision latency p50 229 ms, p95 1.23 s; user-visible latency p50 226 ms clean, 553 ms chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×2, gain # of coalesce over send is not above the guard margin # ×7, gain # of discard over apply is not above the guard margin # ×2, gain # of discard over deliver is not above the guard margin # ×1.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.driftMs | 2910 | 2372 | 2712 |
| chaos.duplicates | 0.3 | 0.5 | 0.5 |
| chaos.errorsShown | 0 | 0 | 0 |
| chaos.latencyMs | 958 | 633 | 940 |
| chaos.maxDriftMs | 2901 | 2372 | 2712 |
| chaos.ordersCreated | 1.1 | 1.3 | 1.3 |
| chaos.untilTimeouts | 2 | 2 | 2 |
| chaos.wrongCharges | 1 | 1.2 | 1.2 |
| clean.driftMs | 0 | 0 | 0 |
| clean.duplicates | 0 | 0 | 0 |
| clean.errorsShown | 0 | 0 | 0 |
| clean.latencyMs | 205 | 293 | 331 |
| clean.maxDriftMs | 0 | 0 | 0 |
| clean.ordersCreated | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – |
| clean.wrongCharges | 0 | 0 | 0 |

## Service status (`status`)

- **observe**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 18.0; detections per trial 3.7; model decision latency p50 1.51 s, p95 4.59 s; user-visible latency p50 1.22 s clean, 1.66 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×62.
- **guard**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 8.2; detections per trial 2.7; model decision latency p50 1.70 s, p95 4.73 s; user-visible latency p50 1.33 s clean, 1.79 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×22, gain # of delay over send is not above the guard margin # ×4, gain # of coalesce over send is not above the guard margin # ×14, gain # of discard over apply is not above the guard margin # ×1.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.5; detections per trial 2.1; model decision latency p50 3.36 s, p95 4.85 s; user-visible latency p50 864 ms clean, 1.68 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×12, gain # of serve_cached over send is not above the heal margin # ×7, gain # of delay over send is not above the guard margin # ×2, gain # of coalesce over send is not above the guard margin # ×4, gain # of serve_cached over deliver is not above the heal margin # ×2, gain # of discard over apply is not above the guard margin # ×2.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.banners | 4.1 | 4.4 | 4.1 |
| chaos.falseAlarmMs | 4671 | 5401 | 5010 |
| chaos.latencyMs | 1976 | 2025 | 1861 |
| chaos.missedMs | 0 | 0 | 0 |
| chaos.otherWrongMs | 0 | 0 | 0 |
| chaos.requestRatio | 1.33 | 1.32 | 1.32 |
| chaos.requests | 72.4 | 72.4 | 73.9 |
| clean.banners | 0 | 0 | 0 |
| clean.falseAlarmMs | 0 | 0 | 0 |
| clean.latencyMs | 1222 | 1276 | 1041 |
| clean.missedMs | 0 | 0 | 0 |
| clean.otherWrongMs | 0 | 0 | 0 |
| clean.requestRatio | 0.93 | 0.96 | 0.96 |
| clean.requests | 45.6 | 48 | 48 |

## Team board (`board`)

- **observe**: bug rate 50% (5/10, 95% CI 24%–76%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 6.2; detections per trial 1.2; model decision latency p50 873 ms, p95 3.00 s; user-visible latency p50 42 ms clean, 42 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×20.
- **guard**: bug rate 50% (5/10, 95% CI 24%–76%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 5.7; detections per trial 1.7; model decision latency p50 450 ms, p95 1.77 s; user-visible latency p50 35 ms clean, 47 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×19, gain # of coalesce over send is not above the guard margin # ×3, gain # of discard over deliver is not above the guard margin # ×2.
- **heal**: bug rate 50% (5/10, 95% CI 24%–76%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 5.9; detections per trial 1.5; model decision latency p50 389 ms, p95 2.14 s; user-visible latency p50 49 ms clean, 40 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×22, gain # of coalesce over send is not above the guard margin # ×2, gain # of discard over deliver is not above the guard margin # ×3.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.divergedMs | 5196 | 4754 | 4078 |
| chaos.finalMismatches | 0.6 | 0.8 | 0.6 |
| chaos.jumpBacks | 4.4 | 4.8 | 5 |
| chaos.latencyMs | 434 | 568 | 423 |
| chaos.maxDivergedMs | 4848 | 4445 | 3681 |
| chaos.teammateMoves | 5.4 | 5.7 | 5.3 |
| chaos.userMoves | 10.6 | 10.8 | 10.6 |
| clean.divergedMs | 0 | 0 | 0 |
| clean.finalMismatches | 0 | 0 | 0 |
| clean.jumpBacks | 0.2 | 0.4 | 0.2 |
| clean.latencyMs | 71.6 | 326 | 403 |
| clean.maxDivergedMs | 0 | 0 | 0 |
| clean.teammateMoves | 0.6 | 0.6 | 0.6 |
| clean.userMoves | 5.2 | 5.2 | 5.2 |

## Runtime decisions (`decisions`)

- **observe**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 8.7; detections per trial 5.6; model decision latency p50 363 ms, p95 2.03 s; user-visible latency p50 172 ms clean, 206 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×16.
- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.7; detections per trial 4.9; model decision latency p50 324 ms, p95 2.54 s; user-visible latency p50 109 ms clean, 215 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×15, gain # of coalesce over send is not above the guard margin # ×1.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.1; detections per trial 4.6; model decision latency p50 353 ms, p95 2.30 s; user-visible latency p50 134 ms clean, 192 ms chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×9, gain # of delay over send is not above the guard margin # ×1.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.accuracy | 0.47 | 0.44 | 0.47 |
| chaos.answeredByGenClass | 3.2 | 3.2 | 3.2 |
| chaos.backup.n | 1.2 | 1.2 | 1.2 |
| chaos.backup.ok | 0 | 0 | 0 |
| chaos.decisions | 3.4 | 3.4 | 3.4 |
| chaos.health.n | 1 | 1 | 1 |
| chaos.health.ok | 0.4 | 0.4 | 0.4 |
| chaos.latencyMs | 231 | 268 | 303 |
| chaos.leave.n | 2 | 2 | 2 |
| chaos.leave.ok | 1.3 | 1.2 | 1.3 |
| chaos.quality.n | 1 | 1 | 1 |
| chaos.quality.ok | 0.33 | 0.33 | 0.33 |
| chaos.untilTimeouts | 1 | 1 | 1 |
| chaos.wrong | 1.8 | 1.9 | 1.8 |
| clean.accuracy | 0.93 | 1 | 0.93 |
| clean.answeredByGenClass | 3 | 3 | 3 |
| clean.backup.n | 1 | 1 | 1 |
| clean.backup.ok | 1 | 1 | 1 |
| clean.decisions | 3 | 3 | 3 |
| clean.health.n | 1 | 1 | 1 |
| clean.health.ok | 0.75 | 1 | 0.75 |
| clean.latencyMs | 257 | 136 | 206 |
| clean.leave.n | 1 | 1 | 1 |
| clean.leave.ok | 1 | 1 | 1 |
| clean.quality.n | 1 | 1 | 1 |
| clean.quality.ok | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – |
| clean.wrong | 0.2 | 0 | 0.2 |

## How to reproduce

```bash
scripts/vm.sh run demos 'setsid nohup bash demos/scripts/vm-eval.sh > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
# or, on any machine: npm install && npm run build -w @genclass/runtime && cd demos && npm run fetch-model && npm run build && npm run eval
```
