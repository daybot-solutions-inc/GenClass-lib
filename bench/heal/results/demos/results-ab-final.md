# GenClass Runtime demos: trial results

Generated 2026-10-09T08:20:55.456Z on the build VM. Runtime: **real** (@genclass/runtime 0.1.0-beta.4, dist 758d2337b4ea). Model: genclass-runtime-r17 on wasm q8, cross-origin isolated (WASM threads available).

Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). 10 chaos trials and 5 clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.

| Demo | Mode | Chaos bug rate | Fixed/introduced vs Off | Clean bugs | False interventions (clean) | False findings (clean) | Findings / chaos trial | Actions / chaos trial | Actions run | User latency p50 (clean) | Decision p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search typeahead | off | 20% (2/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 20 ms | – |
| Search typeahead | observe | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 1 in 1/5 | 1.00 | 0.00 | – | 13 ms | 547 ms |
| Search typeahead | guard | 20% (2/10) | 0/0 | 1/5 | 0 in 0/5 | 5 in 4/5 | 1.50 | 0.10 | discard 1 | 13 ms | 672 ms |
| Search typeahead | heal | 10% (1/10) | 1/0 | 0/5 | 0 in 0/5 | 4 in 4/5 | 1.10 | 0.10 | discard 1 | 15 ms | 635 ms |
| Notes autosave | off | 90% (9/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 784 ms | – |
| Notes autosave | observe | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 1 in 1/5 | 5.30 | 0.00 | – | 792 ms | 637 ms |
| Notes autosave | guard | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 5.00 | 0.00 | – | 799 ms | 576 ms |
| Notes autosave | heal | 100% (10/10) | 0/1 | 0/5 | 0 in 0/5 | 0 in 0/5 | 5.10 | 0.00 | – | 793 ms | 472 ms |
| Cart & checkout | off | 70% (7/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 206 ms | – |
| Cart & checkout | observe | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.00 | 0.00 | – | 216 ms | 362 ms |
| Cart & checkout | guard | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.90 | 0.00 | – | 205 ms | 328 ms |
| Cart & checkout | heal | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.60 | 0.00 | – | 210 ms | 346 ms |
| Service status | off | 100% (10/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 1.51 s | – |
| Service status | observe | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.90 | 0.00 | – | 777 ms | 1.71 s |
| Service status | guard | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.40 | 0.00 | – | 847 ms | 2.70 s |
| Service status | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.70 | 0.00 | – | 570 ms | 3.70 s |
| Team board | off | 60% (6/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 16 ms | – |
| Team board | observe | 50% (5/10) | 2/1 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.80 | 0.00 | – | 20 ms | 1.41 s |
| Team board | guard | 70% (7/10) | 1/2 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.20 | 0.00 | – | 33 ms | 1.48 s |
| Team board | heal | 60% (6/10) | 1/1 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.40 | 0.00 | – | 46 ms | 1.17 s |
| Runtime decisions | off | 100% (10/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 0 ms | – |
| Runtime decisions | observe | 90% (9/10) | 1/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 8.60 | 0.00 | – | 93 ms | 285 ms |
| Runtime decisions | guard | 90% (9/10) | 1/0 | 2/5 | 0 in 0/5 | 0 in 0/5 | 7.50 | 0.00 | – | 88 ms | 422 ms |
| Runtime decisions | heal | 90% (9/10) | 1/0 | 2/5 | 0 in 0/5 | 0 in 0/5 | 7.80 | 0.00 | – | 87 ms | 398 ms |

## Search typeahead (`search`)

- **off**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 20 ms clean, 89 ms chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 1.8; detections per trial 0.7; model decision latency p50 547 ms, p95 1.82 s; user-visible latency p50 13 ms clean, 80 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×11.
- **guard**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.10; decisions per trial 2.1; detections per trial 1.3; model decision latency p50 672 ms, p95 2.35 s; user-visible latency p50 13 ms clean, 17 ms chaos. Actions: discard ×1. Chosen but not run: gain # of discard over apply is not above the guard margin # ×9, gain # of discard over deliver is not above the guard margin # ×3, too late to revert: decided #s after the write applied ×2, guard mode does not allow heal-tier actions ×3, gain # of coalesce over send is not above the guard margin # ×1.
- **heal**: bug rate 10% (1/10, 95% CI 2%–40%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 0 of 10. Interventions per chaos trial 0.10; decisions per trial 1.7; detections per trial 1.0; model decision latency p50 635 ms, p95 3.08 s; user-visible latency p50 15 ms clean, 170 ms chaos. Actions: discard ×1. Chosen but not run: gain # of discard over apply is not above the guard margin # ×6, too late to revert: decided #s after the write applied ×1, gain # of serve_cached over send is not above the heal margin # ×1, gain # of discard over deliver is not above the guard margin # ×5, gain # of coalesce over send is not above the guard margin # ×1, gain # of retry over deliver is not above the heal margin # ×1.

| metric (mean) | off | observe | guard | heal |
|---|---|---|---|---|
| chaos.finalWrong | 0.1 | 0.1 | 0.1 | 0 |
| chaos.latencyMs | 237 | 413 | 415 | 479 |
| chaos.requests | 11.1 | 10.9 | 11.5 | 11.3 |
| chaos.staleMs | 488 | 503 | 496 | 134 |
| chaos.staleShare | 0.09 | 0.09 | 0.08 | 0.01 |
| chaos.wrongVisibleMs | 4117 | 4296 | 4410 | 4012 |
| clean.finalWrong | 0 | 0 | 0 | 0 |
| clean.latencyMs | 65 | 58 | 67.6 | 107 |
| clean.requests | 12.6 | 12.8 | 11.6 | 12.2 |
| clean.staleMs | 0 | 0 | 120 | 59.8 |
| clean.staleShare | 0 | 0 | 0.01 | 0.01 |
| clean.wrongVisibleMs | 2007 | 2045 | 2163 | 2130 |

Most common bugs with GenClass Off:
- showed other results for # ms after the right answer arrived (×2)
- final list does not match “Portl” (×1)

## Notes autosave (`editor`)

- **off**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 784 ms clean, 1.70 s chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 7.1; detections per trial 3.6; model decision latency p50 637 ms, p95 3.47 s; user-visible latency p50 792 ms clean, 1.80 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×57.
- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 6.3; detections per trial 3.3; model decision latency p50 576 ms, p95 2.42 s; user-visible latency p50 799 ms clean, 2.45 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×7, gain # of discard over apply is not above the guard margin # ×7, gain # of coalesce over send is not above the guard margin # ×6, gain # of discard over deliver is not above the guard margin # ×14.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 1 of 10. Interventions per chaos trial 0.00; decisions per trial 6.4; detections per trial 3.4; model decision latency p50 472 ms, p95 2.87 s; user-visible latency p50 793 ms clean, 2.35 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×6, gain # of discard over apply is not above the guard margin # ×7, gain # of coalesce over send is not above the guard margin # ×6, gain # of discard over deliver is not above the guard margin # ×12.

| metric (mean) | off | observe | guard | heal |
|---|---|---|---|---|
| chaos.finalLie | 0.1 | 0.1 | 0.1 | 0.1 |
| chaos.latencyMs | 2530 | 1629 | 3259 | 2115 |
| chaos.lieMs | 7384 | 7361 | 7780 | 7293 |
| chaos.lostLocal | 0.9 | 0.9 | 0.9 | 1 |
| chaos.lostServer | 0.1 | 0.1 | 0.1 | 0.1 |
| chaos.maxLieMs | 6434 | 6112 | 6696 | 6112 |
| chaos.reverts | 1 | 1.3 | 1.1 | 1.5 |
| chaos.saves | 12.8 | 12.7 | 12.7 | 13 |
| clean.finalLie | 0 | 0 | 0 | 0 |
| clean.latencyMs | 655 | 792 | 794 | 789 |
| clean.lieMs | 44.8 | 44.6 | 74.6 | 41.6 |
| clean.lostLocal | 0 | 0 | 0 | 0 |
| clean.lostServer | 0 | 0 | 0 | 0 |
| clean.maxLieMs | 44.8 | 44.6 | 74.6 | 41.6 |
| clean.reverts | 0 | 0 | 0 | 0 |
| clean.saves | 14.4 | 14.2 | 14 | 13.8 |

Most common bugs with GenClass Off:
- the editor lost text the user typed (×9)
- the server copy differs from the editor (×1)
- “Saved” shown while the server holds older text (×1)
- “Saved” was untrue for # s (×1)

## Cart & checkout (`checkout`)

- **off**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 206 ms clean, 559 ms chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 2.9; detections per trial 1.3; model decision latency p50 362 ms, p95 3.07 s; user-visible latency p50 216 ms clean, 665 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×17.
- **guard**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 2.9; detections per trial 1.3; model decision latency p50 328 ms, p95 2.93 s; user-visible latency p50 205 ms clean, 950 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×3, gain # of coalesce over send is not above the guard margin # ×6, gain # of discard over apply is not above the guard margin # ×4, gain # of discard over deliver is not above the guard margin # ×1.
- **heal**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 2.4; detections per trial 1.1; model decision latency p50 346 ms, p95 3.11 s; user-visible latency p50 210 ms clean, 660 ms chaos. Actions: none. Chosen but not run: gain # of coalesce over send is not above the guard margin # ×5, gain # of discard over apply is not above the guard margin # ×4, gain # of rollback over ignore is not above the heal margin # ×1, gain # of retry over deliver is not above the heal margin # ×1.

| metric (mean) | off | observe | guard | heal |
|---|---|---|---|---|
| chaos.driftMs | 2694 | 2985 | 3489 | 3194 |
| chaos.duplicates | 0.4 | 0.4 | 0.5 | 0.4 |
| chaos.errorsShown | 0 | 0 | 0 | 0 |
| chaos.latencyMs | 942 | 925 | 1329 | 1055 |
| chaos.maxDriftMs | 2694 | 2985 | 3468 | 3194 |
| chaos.ordersCreated | 1.2 | 1.2 | 1.3 | 1.2 |
| chaos.untilTimeouts | 2 | 2 | 2 | 2 |
| chaos.wrongCharges | 1.1 | 1.1 | 1.2 | 1.1 |
| clean.driftMs | 0 | 0 | 0 | 0 |
| clean.duplicates | 0 | 0 | 0 | 0 |
| clean.errorsShown | 0 | 0 | 0 | 0 |
| clean.latencyMs | 204 | 215 | 202 | 316 |
| clean.maxDriftMs | 0 | 0 | 0 | 0 |
| clean.ordersCreated | 1 | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – | – |
| clean.wrongCharges | 0 | 0 | 0 | 0 |

Most common bugs with GenClass Off:
- displayed total ≠ sum of the lines for # s (×7)
- charged $# for items worth a different amount (×4)
- # orders created for # intended (×3)
- charged $#, $# for items worth a different amount (×2)
- charged $#, $#, $# for items worth a different amount (×1)

## Service status (`status`)

- **off**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 1.51 s clean, 1.67 s chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 8.5; detections per trial 1.9; model decision latency p50 1.71 s, p95 4.78 s; user-visible latency p50 777 ms clean, 1.41 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×40.
- **guard**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 4.9; detections per trial 1.6; model decision latency p50 2.70 s, p95 4.89 s; user-visible latency p50 847 ms clean, 1.24 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×15, gain # of delay over send is not above the guard margin # ×3, gain # of discard over apply is not above the guard margin # ×1, gain # of coalesce over send is not above the guard margin # ×1.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 4.0; detections per trial 1.1; model decision latency p50 3.70 s, p95 4.88 s; user-visible latency p50 570 ms clean, 1.11 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×7, gain # of discard over apply is not above the guard margin # ×1, gain # of serve_cached over send is not above the heal margin # ×2, gain # of coalesce over send is not above the guard margin # ×1.

| metric (mean) | off | observe | guard | heal |
|---|---|---|---|---|
| chaos.banners | 4.1 | 4.5 | 4.3 | 4.3 |
| chaos.falseAlarmMs | 4313 | 5388 | 5411 | 5821 |
| chaos.latencyMs | 2064 | 1605 | 1830 | 1440 |
| chaos.missedMs | 0 | 0 | 0 | 0 |
| chaos.otherWrongMs | 0 | 0 | 0 | 0 |
| chaos.requestRatio | 1.32 | 1.32 | 1.33 | 1.37 |
| chaos.requests | 71.6 | 73.7 | 77.1 | 81.9 |
| clean.banners | 0 | 0 | 0 | 0 |
| clean.falseAlarmMs | 0 | 0 | 0 | 0 |
| clean.latencyMs | 1373 | 788 | 989 | 814 |
| clean.missedMs | 0 | 0 | 0 | 0 |
| clean.otherWrongMs | 0 | 0 | 0 | 0 |
| clean.requestRatio | 0.95 | 0.94 | 0.92 | 0.94 |
| clean.requests | 46.8 | 45.6 | 45.6 | 45.6 |

Most common bugs with GenClass Off:
- # error banners shown (×10)
- showed healthy services as failing for # s (×9)

## Team board (`board`)

- **off**: bug rate 60% (6/10, 95% CI 31%–83%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 16 ms clean, 428 ms chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 50% (5/10, 95% CI 24%–76%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 2, introduced 1 of 10. Interventions per chaos trial 0.00; decisions per trial 6.2; detections per trial 1.2; model decision latency p50 1.41 s, p95 3.88 s; user-visible latency p50 20 ms clean, 1.29 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×22.
- **guard**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 2 of 10. Interventions per chaos trial 0.00; decisions per trial 4.5; detections per trial 1.5; model decision latency p50 1.48 s, p95 3.65 s; user-visible latency p50 33 ms clean, 315 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×22, gain # of coalesce over send is not above the guard margin # ×3, too late to revert: decided #s after the write applied ×1.
- **heal**: bug rate 60% (6/10, 95% CI 31%–83%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 1 of 10. Interventions per chaos trial 0.00; decisions per trial 4.2; detections per trial 1.6; model decision latency p50 1.17 s, p95 2.62 s; user-visible latency p50 46 ms clean, 273 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×16, gain # of coalesce over send is not above the guard margin # ×7.

| metric (mean) | off | observe | guard | heal |
|---|---|---|---|---|
| chaos.divergedMs | 4100 | 3720 | 5628 | 5104 |
| chaos.finalMismatches | 0.7 | 0.7 | 0.9 | 0.7 |
| chaos.jumpBacks | 4.2 | 4.2 | 4.2 | 5.4 |
| chaos.latencyMs | 539 | 1132 | 295 | 572 |
| chaos.maxDivergedMs | 3808 | 2805 | 4857 | 4872 |
| chaos.teammateMoves | 6 | 5.9 | 6.2 | 5.7 |
| chaos.userMoves | 10.6 | 10.7 | 10.7 | 11 |
| clean.divergedMs | 0 | 0 | 0 | 0 |
| clean.finalMismatches | 0 | 0 | 0 | 0 |
| clean.jumpBacks | 0.4 | 0.2 | 0.2 | 0.4 |
| clean.latencyMs | 224 | 22.8 | 86.8 | 93.6 |
| clean.maxDivergedMs | 0 | 0 | 0 | 0 |
| clean.teammateMoves | 0.6 | 0.6 | 0.6 | 0.4 |
| clean.userMoves | 5.2 | 5.2 | 5.2 | 5.2 |

Most common bugs with GenClass Off:
- # card in the wrong column at the end (c#) (×3)
- # cards in the wrong column at the end (c#, c#) (×2)
- # card stuck “syncing” (×2)

## Runtime decisions (`decisions`)

- **off**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 0 ms clean, 0 ms chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 8.5; detections per trial 5.7; model decision latency p50 285 ms, p95 2.42 s; user-visible latency p50 93 ms clean, 189 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×18.
- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 40% (2/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 7.5; detections per trial 5.0; model decision latency p50 422 ms, p95 2.60 s; user-visible latency p50 88 ms clean, 134 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×15, gain # of coalesce over send is not above the guard margin # ×1.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 40% (2/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 7.9; detections per trial 5.2; model decision latency p50 398 ms, p95 3.71 s; user-visible latency p50 87 ms clean, 288 ms chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×11.

| metric (mean) | off | observe | guard | heal |
|---|---|---|---|---|
| chaos.accuracy | 0.34 | 0.44 | 0.44 | 0.44 |
| chaos.answeredByGenClass | 0 | 3.1 | 3 | 3.1 |
| chaos.backup.n | 1.2 | 1.2 | 1.2 | 1.2 |
| chaos.backup.ok | 0 | 0 | 0 | 0 |
| chaos.decisions | 3.4 | 3.4 | 3.4 | 3.4 |
| chaos.health.n | 1 | 1 | 1 | 1 |
| chaos.health.ok | 0.4 | 0.4 | 0.4 | 0.4 |
| chaos.latencyMs | 0 | 357 | 337 | 417 |
| chaos.leave.n | 2 | 2 | 2 | 2 |
| chaos.leave.ok | 0.9 | 1.2 | 1.2 | 1.2 |
| chaos.quality.n | 1 | 1 | 1 | 1 |
| chaos.quality.ok | 0.33 | 0.33 | 0.33 | 0.33 |
| chaos.untilTimeouts | 1 | 1 | 1 | 1 |
| chaos.wrong | 2.2 | 1.9 | 1.9 | 1.9 |
| clean.accuracy | 1 | 0.93 | 0.88 | 0.83 |
| clean.answeredByGenClass | 0 | 3 | 3.2 | 3.2 |
| clean.backup.n | 1 | 1 | 1.2 | 1.2 |
| clean.backup.ok | 1 | 1 | 1 | 0.8 |
| clean.decisions | 3 | 3 | 3.2 | 3.2 |
| clean.health.n | 1 | 1 | 1 | 1 |
| clean.health.ok | 1 | 0.75 | 0.75 | 0.75 |
| clean.latencyMs | 0 | 102 | 109 | 85.4 |
| clean.leave.n | 1 | 1 | 1 | 1 |
| clean.leave.ok | 1 | 1 | 1 | 1 |
| clean.quality.n | 1 | 1 | 1 | 1 |
| clean.quality.ok | 1 | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – | – |
| clean.wrong | 0 | 0.2 | 0.4 | 0.6 |

Most common bugs with GenClass Off:
- leave: answered “let go” (default), right answer “warn” (×11)
- backup: answered “start now” (default), right answer “postpone” (×6)
- health: answered “good” (default), right answer “poor” (×2)
- quality: answered “full” (default), right answer “thumbnails” (×1)
- health: answered “good” (default), right answer “failing” (×1)

## How to reproduce

```bash
scripts/vm.sh run demos 'setsid nohup bash demos/scripts/vm-eval.sh > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
# or, on any machine: npm install && npm run build -w @genclass/runtime && cd demos && npm run fetch-model && npm run build && npm run eval
```
