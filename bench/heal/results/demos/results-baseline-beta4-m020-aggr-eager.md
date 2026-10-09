# GenClass Runtime demos: trial results

Generated 2026-10-09T07:26:45.554Z on the build VM. Runtime: **real** (@genclass/runtime 0.1.0-beta.4, dist d0fd6e20ecfc). Model: genclass-runtime-r17 on wasm q8, cross-origin isolated (WASM threads available).

Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). 10 chaos trials and 5 clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.

| Demo | Mode | Chaos bug rate | Fixed/introduced vs Off | Clean bugs | False interventions (clean) | False findings (clean) | Findings / chaos trial | Actions / chaos trial | Actions run | User latency p50 (clean) | Decision p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search typeahead | observe | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 2 in 2/5 | 1.60 | 0.00 | – | 25 ms | 753 ms |
| Search typeahead | guard | 20% (2/10) | 0/0 | 0/5 | 2 in 2/5 | 3 in 3/5 | 1.50 | 0.40 | discard 6 | 12 ms | 232 ms |
| Search typeahead | heal | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 2 in 2/5 | 1.60 | 0.40 | discard 4 | 20 ms | 298 ms |
| Notes autosave | observe | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 6.20 | 0.00 | – | 798 ms | 233 ms |
| Notes autosave | guard | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 6.80 | 0.00 | – | 796 ms | 248 ms |
| Notes autosave | heal | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 6.30 | 0.10 | retry 1 | 773 ms | 220 ms |
| Cart & checkout | observe | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.30 | 0.00 | – | 204 ms | 517 ms |
| Cart & checkout | guard | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.10 | 0.00 | – | 263 ms | 789 ms |
| Cart & checkout | heal | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.80 | 0.40 | retry 3, rollback 1 | 196 ms | 247 ms |
| Service status | observe | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 1 in 1/5 | 7.60 | 0.00 | – | 1.30 s | 1.61 s |
| Service status | guard | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 7.30 | 0.00 | – | 1.08 s | 1.64 s |
| Service status | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 7.50 | 0.00 | – | 1.05 s | 1.95 s |
| Team board | observe | 50% (5/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.30 | 0.00 | – | 7 ms | 884 ms |
| Team board | guard | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 3.00 | 0.20 | discard 2 | 23 ms | 668 ms |
| Team board | heal | 60% (6/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 3.10 | 0.10 | discard 1 | 43 ms | 645 ms |
| Runtime decisions | observe | 90% (9/10) | 0/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 9.70 | 0.00 | – | 140 ms | 585 ms |
| Runtime decisions | guard | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 9.10 | 0.00 | – | 99 ms | 521 ms |
| Runtime decisions | heal | 90% (9/10) | 0/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 8.60 | 0.20 | retry 2 | 150 ms | 553 ms |

## Search typeahead (`search`)

- **observe**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.0; detections per trial 1.2; model decision latency p50 753 ms, p95 2.35 s; user-visible latency p50 25 ms clean, 12 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×17.
- **guard**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **2** (in 2/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.40; decisions per trial 1.7; detections per trial 1.2; model decision latency p50 232 ms, p95 1.84 s; user-visible latency p50 12 ms clean, 108 ms chaos. Actions: discard ×6. Chosen but not run: gain # of discard over apply is not above the guard margin # ×3, guard mode does not allow heal-tier actions ×3, superseded: search.query changed again after the write applied ×2, gain # of discard over deliver is not above the guard margin # ×1.
- **heal**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.40; decisions per trial 1.5; detections per trial 1.2; model decision latency p50 298 ms, p95 1.99 s; user-visible latency p50 20 ms clean, 83 ms chaos. Actions: discard ×4. Chosen but not run: gain # of discard over apply is not above the guard margin # ×4, gain # of coalesce over send is not above the guard margin # ×1, gain # of discard over deliver is not above the guard margin # ×1, gain # of retry over deliver is not above the heal margin # ×1, too late to revert: decided #s after the write applied ×1.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.finalWrong | 0.1 | 0 | 0.1 |
| chaos.latencyMs | 360 | 640 | 423 |
| chaos.requests | 11.5 | 11.2 | 11.1 |
| chaos.staleMs | 506 | 276 | 487 |
| chaos.staleShare | 0.08 | 0.04 | 0.08 |
| chaos.wrongVisibleMs | 4432 | 4185 | 4340 |
| clean.finalWrong | 0 | 0 | 0 |
| clean.latencyMs | 73.8 | 107 | 106 |
| clean.requests | 11.2 | 11 | 11 |
| clean.staleMs | 60 | 0 | 0 |
| clean.staleShare | 0.01 | 0 | 0 |
| clean.wrongVisibleMs | 2006 | 1940 | 1967 |

## Notes autosave (`editor`)

- **observe**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.4; detections per trial 4.1; model decision latency p50 233 ms, p95 1.26 s; user-visible latency p50 798 ms clean, 2.03 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×53.
- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 7.5; detections per trial 4.5; model decision latency p50 248 ms, p95 1.09 s; user-visible latency p50 796 ms clean, 2.55 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×11, gain # of discard over deliver is not above the guard margin # ×23, gain # of discard over apply is not above the guard margin # ×7, gain # of coalesce over send is not above the guard margin # ×6.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.10; decisions per trial 7.0; detections per trial 4.2; model decision latency p50 220 ms, p95 1.45 s; user-visible latency p50 773 ms clean, 1.84 s chaos. Actions: retry ×1. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×8, gain # of discard over deliver is not above the guard margin # ×22, gain # of discard over apply is not above the guard margin # ×6, gain # of coalesce over send is not above the guard margin # ×8.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.finalLie | 0.2 | 0.1 | 0.1 |
| chaos.latencyMs | 2497 | 2731 | 2383 |
| chaos.lieMs | 7395 | 6869 | 6681 |
| chaos.lostLocal | 1 | 0.9 | 0.9 |
| chaos.lostServer | 0.2 | 0.1 | 0.1 |
| chaos.maxLieMs | 6756 | 6088 | 6082 |
| chaos.reverts | 1.2 | 1.3 | 1.4 |
| chaos.saves | 11.2 | 11.2 | 10.9 |
| clean.finalLie | 0 | 0 | 0 |
| clean.latencyMs | 792 | 789 | 768 |
| clean.lieMs | 48 | 43.6 | 41.4 |
| clean.lostLocal | 0 | 0 | 0 |
| clean.lostServer | 0 | 0 | 0 |
| clean.maxLieMs | 48 | 43.6 | 41.4 |
| clean.reverts | 0 | 0 | 0 |
| clean.saves | 14.4 | 14.2 | 15 |

## Cart & checkout (`checkout`)

- **observe**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.9; detections per trial 1.5; model decision latency p50 517 ms, p95 2.88 s; user-visible latency p50 204 ms clean, 706 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×15.
- **guard**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 2.4; detections per trial 1.4; model decision latency p50 789 ms, p95 2.95 s; user-visible latency p50 263 ms clean, 750 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×3, gain # of coalesce over send is not above the guard margin # ×6, gain # of discard over apply is not above the guard margin # ×3.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.40; decisions per trial 3.2; detections per trial 1.9; model decision latency p50 247 ms, p95 2.44 s; user-visible latency p50 196 ms clean, 579 ms chaos. Actions: retry ×3, rollback ×1. Chosen but not run: gain # of discard over apply is not above the guard margin # ×5, gain # of coalesce over send is not above the guard margin # ×6.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.driftMs | 2994 | 3123 | 3570 |
| chaos.duplicates | 0.4 | 0.4 | 0.5 |
| chaos.errorsShown | 0 | 0 | 0 |
| chaos.latencyMs | 1063 | 1022 | 1064 |
| chaos.maxDriftMs | 2985 | 3123 | 3567 |
| chaos.ordersCreated | 1.2 | 1.2 | 1.5 |
| chaos.untilTimeouts | 2 | 2 | – |
| chaos.wrongCharges | 1.1 | 1.1 | 1.4 |
| clean.driftMs | 0 | 0 | 0 |
| clean.duplicates | 0 | 0 | 0 |
| clean.errorsShown | 0 | 0 | 0 |
| clean.latencyMs | 228 | 268 | 200 |
| clean.maxDriftMs | 0 | 0 | 0 |
| clean.ordersCreated | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – |
| clean.wrongCharges | 0 | 0 | 0 |

## Service status (`status`)

- **observe**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 17.7; detections per trial 5.1; model decision latency p50 1.61 s, p95 4.72 s; user-visible latency p50 1.30 s clean, 1.58 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×56.
- **guard**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 13.2; detections per trial 4.9; model decision latency p50 1.64 s, p95 4.51 s; user-visible latency p50 1.08 s clean, 1.74 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×33, gain # of delay over send is not above the guard margin # ×7, gain # of coalesce over send is not above the guard margin # ×18, gain # of discard over deliver is not above the guard margin # ×1.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 12.9; detections per trial 5.0; model decision latency p50 1.95 s, p95 4.74 s; user-visible latency p50 1.05 s clean, 1.76 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×16, the model's diagnosis is expected ×1, gain # of delay over send is not above the guard margin # ×2, gain # of coalesce over send is not above the guard margin # ×11, gain # of serve_cached over deliver is not above the heal margin # ×4, the subject was not held (decided in the background) ×8, gain # of serve_cached over send is not above the heal margin # ×4.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.banners | 4.3 | 4.2 | 4.2 |
| chaos.falseAlarmMs | 4699 | 4485 | 4978 |
| chaos.latencyMs | 1945 | 1786 | 2043 |
| chaos.missedMs | 0 | 0 | 0 |
| chaos.otherWrongMs | 0 | 0 | 0 |
| chaos.requestRatio | 1.31 | 1.32 | 1.34 |
| chaos.requests | 70.8 | 71.6 | 72.3 |
| clean.banners | 0 | 0 | 0 |
| clean.falseAlarmMs | 0 | 0 | 0 |
| clean.latencyMs | 1287 | 1136 | 1046 |
| clean.missedMs | 0 | 0 | 0 |
| clean.otherWrongMs | 0 | 0 | 0 |
| clean.requestRatio | 0.95 | 0.95 | 0.94 |
| clean.requests | 45.6 | 45.6 | 45.6 |

## Team board (`board`)

- **observe**: bug rate 50% (5/10, 95% CI 24%–76%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 6.6; detections per trial 1.5; model decision latency p50 884 ms, p95 4.25 s; user-visible latency p50 7 ms clean, 39 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×20.
- **guard**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.20; decisions per trial 5.1; detections per trial 2.0; model decision latency p50 668 ms, p95 3.59 s; user-visible latency p50 23 ms clean, 208 ms chaos. Actions: discard ×2. Chosen but not run: gain # of discard over apply is not above the guard margin # ×14, gain # of coalesce over send is not above the guard margin # ×5, superseded: board.cards.c#.version changed again after the write applied ×1, superseded: board.cards.c#.column changed again after the write applied ×1.
- **heal**: bug rate 60% (6/10, 95% CI 31%–83%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.10; decisions per trial 5.3; detections per trial 2.1; model decision latency p50 645 ms, p95 2.75 s; user-visible latency p50 43 ms clean, 411 ms chaos. Actions: discard ×1. Chosen but not run: gain # of discard over apply is not above the guard margin # ×17, gain # of coalesce over send is not above the guard margin # ×4, gain # of discard over deliver is not above the guard margin # ×2.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.divergedMs | 3166 | 5617 | 4126 |
| chaos.finalMismatches | 0.4 | 0.9 | 0.6 |
| chaos.jumpBacks | 4 | 4.4 | 4.5 |
| chaos.latencyMs | 511 | 484 | 638 |
| chaos.maxDivergedMs | 2821 | 5068 | 3501 |
| chaos.teammateMoves | 5.4 | 5.8 | 5.4 |
| chaos.userMoves | 10.8 | 10.5 | 10.9 |
| clean.divergedMs | 0 | 0 | 0 |
| clean.finalMismatches | 0 | 0 | 0 |
| clean.jumpBacks | 0.2 | 0.2 | 0.4 |
| clean.latencyMs | 191 | 205 | 418 |
| clean.maxDivergedMs | 0 | 0 | 0 |
| clean.teammateMoves | 0.4 | 0.4 | 0.6 |
| clean.userMoves | 5.2 | 5.2 | 5.2 |

## Runtime decisions (`decisions`)

- **observe**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 9.1; detections per trial 6.5; model decision latency p50 585 ms, p95 4.07 s; user-visible latency p50 140 ms clean, 253 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×16.
- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.00; decisions per trial 8.5; detections per trial 6.1; model decision latency p50 521 ms, p95 3.89 s; user-visible latency p50 99 ms clean, 325 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×14, gain # of coalesce over send is not above the guard margin # ×1.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 0. Interventions per chaos trial 0.20; decisions per trial 8.1; detections per trial 5.7; model decision latency p50 553 ms, p95 3.88 s; user-visible latency p50 150 ms clean, 193 ms chaos. Actions: retry ×2. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×10.

| metric (mean) | observe | guard | heal |
|---|---|---|---|
| chaos.accuracy | 0.41 | 0.47 | 0.43 |
| chaos.answeredByGenClass | 2.9 | 3.1 | 2.9 |
| chaos.backup.n | 1.2 | 1.2 | 1.2 |
| chaos.backup.ok | 0 | 0 | 0 |
| chaos.decisions | 3.4 | 3.4 | 3.4 |
| chaos.health.n | 1 | 1 | 1 |
| chaos.health.ok | 0.4 | 0.4 | 0.4 |
| chaos.latencyMs | 356 | 390 | 414 |
| chaos.leave.n | 2 | 2 | 2 |
| chaos.leave.ok | 1.1 | 1.3 | 1.2 |
| chaos.quality.n | 1 | 1 | 1 |
| chaos.quality.ok | 0.33 | 0.33 | 0.33 |
| chaos.untilTimeouts | 1 | 1 | 1 |
| chaos.wrong | 2 | 1.8 | 1.9 |
| clean.accuracy | 0.93 | 1 | 0.93 |
| clean.answeredByGenClass | 3 | 2.8 | 3 |
| clean.backup.n | 1 | 1 | 1 |
| clean.backup.ok | 1 | 1 | 1 |
| clean.decisions | 3 | 3 | 3 |
| clean.health.n | 1 | 1 | 1 |
| clean.health.ok | 0.75 | 1 | 0.75 |
| clean.latencyMs | 360 | 347 | 342 |
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
