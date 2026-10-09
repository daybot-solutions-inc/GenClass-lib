# GenClass Runtime demos: trial results

Generated 2026-10-09T08:20:59.865Z on the build VM. Runtime: **real** (@genclass/runtime 0.1.0-beta.4, dist d0fd6e20ecfc). Model: genclass-runtime-r17 on wasm q8, cross-origin isolated (WASM threads available).

Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). 10 chaos trials and 5 clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.

| Demo | Mode | Chaos bug rate | Fixed/introduced vs Off | Clean bugs | False interventions (clean) | False findings (clean) | Findings / chaos trial | Actions / chaos trial | Actions run | User latency p50 (clean) | Decision p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search typeahead | off | 20% (2/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 20 ms | – |
| Search typeahead | observe | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.30 | 0.00 | – | 28 ms | 732 ms |
| Search typeahead | guard | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 2 in 2/5 | 1.30 | 0.30 | discard 3 | 14 ms | 896 ms |
| Search typeahead | heal | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 1 in 1/5 | 1.10 | 0.10 | discard 1 | 15 ms | 631 ms |
| Notes autosave | off | 90% (9/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 770 ms | – |
| Notes autosave | observe | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 1 in 1/5 | 6.50 | 0.00 | – | 796 ms | 826 ms |
| Notes autosave | guard | 80% (8/10) | 1/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 4.70 | 0.00 | – | 793 ms | 560 ms |
| Notes autosave | heal | 90% (9/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 4.60 | 0.00 | – | 761 ms | 476 ms |
| Cart & checkout | off | 70% (7/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 213 ms | – |
| Cart & checkout | observe | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.90 | 0.00 | – | 213 ms | 398 ms |
| Cart & checkout | guard | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.80 | 0.00 | – | 218 ms | 303 ms |
| Cart & checkout | heal | 80% (8/10) | 0/1 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.60 | 0.00 | – | 225 ms | 385 ms |
| Service status | off | 100% (10/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 1.51 s | – |
| Service status | observe | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.20 | 0.00 | – | 492 ms | 2.20 s |
| Service status | guard | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.30 | 0.00 | – | 1.20 s | 3.19 s |
| Service status | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 3.20 | 0.00 | – | 618 ms | 3.60 s |
| Team board | off | 50% (5/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 49 ms | – |
| Team board | observe | 60% (6/10) | 1/2 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.70 | 0.00 | – | 39 ms | 1.82 s |
| Team board | guard | 60% (6/10) | 0/1 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.00 | 0.00 | – | 23 ms | 1.12 s |
| Team board | heal | 40% (4/10) | 1/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.70 | 0.00 | – | 36 ms | 875 ms |
| Runtime decisions | off | 100% (10/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 0 ms | – |
| Runtime decisions | observe | 90% (9/10) | 1/0 | 2/5 | 0 in 0/5 | 0 in 0/5 | 8.90 | 0.00 | – | 105 ms | 333 ms |
| Runtime decisions | guard | 90% (9/10) | 1/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 7.80 | 0.00 | – | 119 ms | 208 ms |
| Runtime decisions | heal | 90% (9/10) | 1/0 | 2/5 | 0 in 0/5 | 0 in 0/5 | 6.90 | 0.00 | – | 118 ms | 416 ms |

## Search typeahead (`search`)

- **off**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 20 ms clean, 107 ms chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 1.9; detections per trial 0.9; model decision latency p50 732 ms, p95 2.44 s; user-visible latency p50 28 ms clean, 13 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×15.
- **guard**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.30; decisions per trial 2.0; detections per trial 1.0; model decision latency p50 896 ms, p95 2.23 s; user-visible latency p50 14 ms clean, 208 ms chaos. Actions: discard ×3. Chosen but not run: gain # of discard over apply is not above the guard margin # ×3, gain # of discard over deliver is not above the guard margin # ×3, guard mode does not allow heal-tier actions ×4, gain # of coalesce over send is not above the guard margin # ×1.
- **heal**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.10; decisions per trial 1.5; detections per trial 0.8; model decision latency p50 631 ms, p95 2.64 s; user-visible latency p50 15 ms clean, 88 ms chaos. Actions: discard ×1. Chosen but not run: gain # of discard over apply is not above the guard margin # ×6, gain # of coalesce over send is not above the guard margin # ×2, gain # of hedge over wait is not above the heal margin # ×1, superseded: search.query changed again after the write applied ×1, gain # of discard over deliver is not above the guard margin # ×2.

| metric (mean) | off | observe | guard | heal |
|---|---|---|---|---|
| chaos.finalWrong | 0.1 | 0.1 | 0.1 | 0.1 |
| chaos.latencyMs | 325 | 246 | 373 | 426 |
| chaos.requests | 10.7 | 11.2 | 11.9 | 11.3 |
| chaos.staleMs | 485 | 507 | 530 | 515 |
| chaos.staleShare | 0.09 | 0.08 | 0.07 | 0.09 |
| chaos.wrongVisibleMs | 4231 | 4261 | 4689 | 4429 |
| clean.finalWrong | 0 | 0 | 0 | 0 |
| clean.latencyMs | 71.2 | 62.8 | 71.6 | 85 |
| clean.requests | 12.4 | 11.8 | 11.8 | 11.4 |
| clean.staleMs | 0 | 0 | 0 | 0 |
| clean.staleShare | 0 | 0 | 0 | 0 |
| clean.wrongVisibleMs | 2061 | 2032 | 2010 | 1933 |

Most common bugs with GenClass Off:
- showed other results for # ms after the right answer arrived (×2)
- final list does not match “Portl” (×1)

## Notes autosave (`editor`)

- **off**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 770 ms clean, 1.59 s chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 7.6; detections per trial 4.4; model decision latency p50 826 ms, p95 3.75 s; user-visible latency p50 796 ms clean, 1.70 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×72.
- **guard**: bug rate 80% (8/10, 95% CI 49%–94%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 6.3; detections per trial 3.1; model decision latency p50 560 ms, p95 2.47 s; user-visible latency p50 793 ms clean, 2.48 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×7, gain # of discard over apply is not above the guard margin # ×6, gain # of coalesce over send is not above the guard margin # ×5, gain # of discard over deliver is not above the guard margin # ×9.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 6.0; detections per trial 3.1; model decision latency p50 476 ms, p95 2.91 s; user-visible latency p50 761 ms clean, 2.68 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×8, gain # of coalesce over send is not above the guard margin # ×5, gain # of discard over apply is not above the guard margin # ×7, gain # of discard over deliver is not above the guard margin # ×10.

| metric (mean) | off | observe | guard | heal |
|---|---|---|---|---|
| chaos.finalLie | 0.2 | 0.1 | 0.1 | 0.1 |
| chaos.latencyMs | 1720 | 1712 | 2956 | 2866 |
| chaos.lieMs | 7564 | 7061 | 7646 | 7904 |
| chaos.lostLocal | 0.9 | 0.9 | 0.8 | 0.9 |
| chaos.lostServer | 0.2 | 0.1 | 0.1 | 0.1 |
| chaos.maxLieMs | 6460 | 6169 | 6570 | 6708 |
| chaos.reverts | 1.4 | 1.3 | 1.6 | 1.2 |
| chaos.saves | 12.8 | 12.6 | 12.8 | 12.5 |
| clean.finalLie | 0 | 0 | 0 | 0 |
| clean.latencyMs | 785 | 795 | 791 | 756 |
| clean.lieMs | 45 | 55 | 44.8 | 44.8 |
| clean.lostLocal | 0 | 0 | 0 | 0 |
| clean.lostServer | 0 | 0 | 0 | 0 |
| clean.maxLieMs | 45 | 55 | 44.8 | 44.8 |
| clean.reverts | 0 | 0 | 0 | 0 |
| clean.saves | 14.4 | 14.2 | 14 | 14 |

Most common bugs with GenClass Off:
- the editor lost text the user typed (×9)
- the server copy differs from the editor (×2)
- “Saved” shown while the server holds older text (×2)

## Cart & checkout (`checkout`)

- **off**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 213 ms clean, 709 ms chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 2.9; detections per trial 1.3; model decision latency p50 398 ms, p95 2.31 s; user-visible latency p50 213 ms clean, 592 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×14.
- **guard**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 2.5; detections per trial 1.2; model decision latency p50 303 ms, p95 2.97 s; user-visible latency p50 218 ms clean, 731 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×3, gain # of coalesce over send is not above the guard margin # ×6, gain # of discard over apply is not above the guard margin # ×4.
- **heal**: bug rate 80% (8/10, 95% CI 49%–94%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 1 of 10. Interventions per chaos trial 0.00; decisions per trial 2.5; detections per trial 1.1; model decision latency p50 385 ms, p95 2.32 s; user-visible latency p50 225 ms clean, 605 ms chaos. Actions: none. Chosen but not run: gain # of coalesce over send is not above the guard margin # ×5, gain # of rollback over ignore is not above the heal margin # ×1, gain # of discard over apply is not above the guard margin # ×2, gain # of discard over deliver is not above the guard margin # ×1, gain # of retry over deliver is not above the heal margin # ×1.

| metric (mean) | off | observe | guard | heal |
|---|---|---|---|---|
| chaos.driftMs | 2781 | 3091 | 3249 | 3149 |
| chaos.duplicates | 0.5 | 0.4 | 0.4 | 0.5 |
| chaos.errorsShown | 0 | 0 | 0 | 0 |
| chaos.latencyMs | 993 | 954 | 1063 | 1067 |
| chaos.maxDriftMs | 2781 | 3091 | 3225 | 3117 |
| chaos.ordersCreated | 1.3 | 1.2 | 1.2 | 1.3 |
| chaos.untilTimeouts | 2 | 2 | 2 | 2 |
| chaos.wrongCharges | 1.2 | 1.1 | 1.1 | 1.2 |
| clean.driftMs | 0 | 0 | 0 | 0 |
| clean.duplicates | 0 | 0 | 0 | 0 |
| clean.errorsShown | 0 | 0 | 0 | 0 |
| clean.latencyMs | 222 | 240 | 221 | 275 |
| clean.maxDriftMs | 0 | 0 | 0 | 0 |
| clean.ordersCreated | 1 | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – | – |
| clean.wrongCharges | 0 | 0 | 0 | 0 |

Most common bugs with GenClass Off:
- displayed total ≠ sum of the lines for # s (×7)
- # orders created for # intended (×4)
- charged $#, $# for items worth a different amount (×3)
- charged $# for items worth a different amount (×3)
- charged $#, $#, $# for items worth a different amount (×1)

## Service status (`status`)

- **off**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 1.51 s clean, 1.76 s chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 10.7; detections per trial 1.5; model decision latency p50 2.20 s, p95 4.56 s; user-visible latency p50 492 ms clean, 1.77 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×33.
- **guard**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 5.1; detections per trial 1.5; model decision latency p50 3.19 s, p95 4.75 s; user-visible latency p50 1.20 s clean, 1.42 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×13, gain # of delay over send is not above the guard margin # ×4, gain # of coalesce over send is not above the guard margin # ×1, gain # of discard over apply is not above the guard margin # ×1.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 5.4; detections per trial 2.1; model decision latency p50 3.60 s, p95 4.90 s; user-visible latency p50 618 ms clean, 1.22 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×11, gain # of serve_cached over send is not above the heal margin # ×1, gain # of serve_cached over deliver is not above the heal margin # ×2, gain # of delay over send is not above the guard margin # ×1, gain # of coalesce over send is not above the guard margin # ×1.

| metric (mean) | off | observe | guard | heal |
|---|---|---|---|---|
| chaos.banners | 4.5 | 4.2 | 4.3 | 4.4 |
| chaos.falseAlarmMs | 5740 | 5315 | 5661 | 6210 |
| chaos.latencyMs | 2133 | 1901 | 1692 | 1442 |
| chaos.missedMs | 0 | 0 | 0 | 0 |
| chaos.otherWrongMs | 0 | 0 | 0 | 0 |
| chaos.requestRatio | 1.31 | 1.33 | 1.33 | 1.33 |
| chaos.requests | 72.1 | 75.8 | 79.8 | 79.3 |
| clean.banners | 0 | 0 | 0 | 0 |
| clean.falseAlarmMs | 0 | 0 | 0 | 0 |
| clean.latencyMs | 1396 | 658 | 1133 | 772 |
| clean.missedMs | 0 | 0 | 0 | 0 |
| clean.otherWrongMs | 0 | 0 | 0 | 0 |
| clean.requestRatio | 0.94 | 0.96 | 0.93 | 0.94 |
| clean.requests | 46.8 | 46.8 | 45.6 | 45.6 |

Most common bugs with GenClass Off:
- # error banners shown (×10)
- showed healthy services as failing for # s (×9)

## Team board (`board`)

- **off**: bug rate 50% (5/10, 95% CI 24%–76%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 49 ms clean, 75 ms chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 60% (6/10, 95% CI 31%–83%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 2 of 10. Interventions per chaos trial 0.00; decisions per trial 5.9; detections per trial 1.1; model decision latency p50 1.82 s, p95 4.35 s; user-visible latency p50 39 ms clean, 923 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×19.
- **guard**: bug rate 60% (6/10, 95% CI 31%–83%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 1 of 10. Interventions per chaos trial 0.00; decisions per trial 3.7; detections per trial 1.3; model decision latency p50 1.12 s, p95 2.87 s; user-visible latency p50 23 ms clean, 414 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×13, gain # of coalesce over send is not above the guard margin # ×2.
- **heal**: bug rate 40% (4/10, 95% CI 17%–69%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 4.5; detections per trial 1.8; model decision latency p50 875 ms, p95 3.53 s; user-visible latency p50 36 ms clean, 361 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×17, gain # of coalesce over send is not above the guard margin # ×2, gain # of discard over deliver is not above the guard margin # ×1.

| metric (mean) | off | observe | guard | heal |
|---|---|---|---|---|
| chaos.divergedMs | 4963 | 3913 | 6059 | 3702 |
| chaos.finalMismatches | 0.6 | 0.5 | 0.6 | 0.6 |
| chaos.jumpBacks | 4.4 | 4.2 | 4.4 | 4.8 |
| chaos.latencyMs | 415 | 773 | 486 | 685 |
| chaos.maxDivergedMs | 4636 | 3484 | 5674 | 3248 |
| chaos.teammateMoves | 5.8 | 6.1 | 5.9 | 5.7 |
| chaos.userMoves | 10.7 | 10.6 | 10.4 | 10.6 |
| clean.divergedMs | 0 | 0 | 0 | 0 |
| clean.finalMismatches | 0 | 0 | 0 | 0 |
| clean.jumpBacks | 0.4 | 0.6 | 0.4 | 0.4 |
| clean.latencyMs | 141 | 37 | 18.4 | 227 |
| clean.maxDivergedMs | 0 | 0 | 0 | 0 |
| clean.teammateMoves | 0.6 | 0.4 | 0.4 | 0.4 |
| clean.userMoves | 5 | 5.2 | 5.2 | 5.2 |

Most common bugs with GenClass Off:
- # card in the wrong column at the end (c#) (×4)
- # card stuck “syncing” (×1)
- # cards in the wrong column at the end (c#, c#) (×1)

## Runtime decisions (`decisions`)

- **off**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 0 ms clean, 0 ms chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 40% (2/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 8.8; detections per trial 5.9; model decision latency p50 333 ms, p95 3.31 s; user-visible latency p50 105 ms clean, 217 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×14.
- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 7.8; detections per trial 5.2; model decision latency p50 208 ms, p95 2.95 s; user-visible latency p50 119 ms clean, 202 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×13.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 40% (2/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 7.1; detections per trial 4.6; model decision latency p50 416 ms, p95 3.19 s; user-visible latency p50 118 ms clean, 108 ms chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×13.

| metric (mean) | off | observe | guard | heal |
|---|---|---|---|---|
| chaos.accuracy | 0.32 | 0.44 | 0.47 | 0.44 |
| chaos.answeredByGenClass | 0 | 3.1 | 3.1 | 3.1 |
| chaos.backup.n | 1.2 | 1.4 | 1.2 | 1.2 |
| chaos.backup.ok | 0 | 0.2 | 0 | 0 |
| chaos.decisions | 3.4 | 3.5 | 3.4 | 3.4 |
| chaos.health.n | 1 | 1 | 1 | 1 |
| chaos.health.ok | 0.4 | 0.4 | 0.4 | 0.4 |
| chaos.latencyMs | 0 | 397 | 411 | 372 |
| chaos.leave.n | 2 | 2 | 2 | 2 |
| chaos.leave.ok | 0.8 | 1.1 | 1.3 | 1.2 |
| chaos.quality.n | 1 | 1 | 1 | 1 |
| chaos.quality.ok | 0.33 | 0.33 | 0.33 | 0.33 |
| chaos.untilTimeouts | 1 | 1 | 1 | 1 |
| chaos.wrong | 2.3 | 2 | 1.8 | 1.9 |
| clean.accuracy | 1 | 0.88 | 0.93 | 0.88 |
| clean.answeredByGenClass | 0 | 3.2 | 3 | 3.2 |
| clean.backup.n | 1 | 1.2 | 1 | 1.2 |
| clean.backup.ok | 1 | 1 | 1 | 1 |
| clean.decisions | 3 | 3.2 | 3 | 3.2 |
| clean.health.n | 1 | 1 | 1 | 1 |
| clean.health.ok | 1 | 0.75 | 0.75 | 0.75 |
| clean.latencyMs | 0 | 104 | 130 | 137 |
| clean.leave.n | 1 | 1 | 1 | 1 |
| clean.leave.ok | 1 | 1 | 1 | 1 |
| clean.quality.n | 1 | 1 | 1 | 1 |
| clean.quality.ok | 1 | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – | – |
| clean.wrong | 0 | 0.4 | 0.2 | 0.4 |

Most common bugs with GenClass Off:
- leave: answered “let go” (default), right answer “warn” (×12)
- backup: answered “start now” (default), right answer “postpone” (×6)
- health: answered “good” (default), right answer “poor” (×2)
- quality: answered “full” (default), right answer “thumbnails” (×1)
- health: answered “good” (default), right answer “failing” (×1)

## How to reproduce

```bash
scripts/vm.sh run demos 'setsid nohup bash demos/scripts/vm-eval.sh > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
# or, on any machine: npm install && npm run build -w @genclass/runtime && cd demos && npm run fetch-model && npm run build && npm run eval
```
