# GenClass Runtime demos: trial results

Generated 2026-10-07T19:30:09.513Z on the build VM. Runtime: **real**. Model: GenClass v0.1 (self-hosted copy) on wasm q8, cross-origin isolated (WASM threads available). The v0.1 GenClass model is a general classifier that was not trained for runtime decisions; these numbers measure the runtime and the demos with it, not the runtime-specialist model.

Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). 30 chaos trials and 15 clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.

| Demo | Bug rate Off | Guard | Heal | False interventions (clean) Guard | Heal | Fixed/introduced vs Off: Guard | Heal | User latency p50 (clean) Off / Guard / Heal | Model decision p50 Guard / Heal |
|---|---|---|---|---|---|---|---|---|---|
| Search typeahead | 13% (4/30) | 13% (4/30) | 13% (4/30) | 0 in 0/15 | 0 in 0/15 | 0/0 | 0/0 | 14 ms / 125 ms / 126 ms | 481 ms / 495 ms |
| Notes autosave | 83% (25/30) | 83% (25/30) | 87% (26/30) | 0 in 0/15 | 0 in 0/15 | 1/1 | 0/1 | 779 ms / 775 ms / 783 ms | 333 ms / 340 ms |
| Cart & checkout | 83% (25/30) | 90% (27/30) | 90% (27/30) | 0 in 0/15 | 0 in 0/15 | 0/2 | 0/2 | 205 ms / 204 ms / 206 ms | 363 ms / 366 ms |
| Service status | 100% (30/30) | 93% (28/30) | 100% (30/30) | 0 in 0/15 | 0 in 0/15 | 2/0 | 0/0 | 1.33 s / 1.26 s / 1.28 s | 1.20 s / 1.25 s |
| Team board | 50% (15/30) | 77% (23/30) | 73% (22/30) | 0 in 0/15 | 0 in 0/15 | 1/9 | 2/9 | 19 ms / 31 ms / 33 ms | 346 ms / 360 ms |
| Runtime decisions | 83% (25/30) | 90% (27/30) | 93% (28/30) | 0 in 0/15 | 0 in 0/15 | 3/5 | 2/5 | 0 ms / 151 ms / 157 ms | 308 ms / 304 ms |

## Search typeahead (`search`)

- **off**: bug rate 13% (4/30, 95% CI 5%–30%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 14 ms clean, 168 ms chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 13% (4/30, 95% CI 5%–30%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 0, introduced 0 of 30. Interventions per chaos trial 0.00; decisions per trial 6.5; detections per trial 0.1; model decision latency p50 481 ms, p95 1.28 s; user-visible latency p50 125 ms clean, 642 ms chaos. Actions: none. Chosen but not run: the decision arrived after the hold budget expired ×45, probability # is below the guard threshold # ×42, guard mode does not allow heal-tier actions ×5.
- **heal**: bug rate 13% (4/30, 95% CI 5%–30%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 0, introduced 0 of 30. Interventions per chaos trial 0.00; decisions per trial 6.7; detections per trial 0.1; model decision latency p50 495 ms, p95 1.42 s; user-visible latency p50 126 ms clean, 711 ms chaos. Actions: none. Chosen but not run: the decision arrived after the hold budget expired ×45, probability # is below the heal threshold # ×3, probability # is below the guard threshold # ×36.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.finalWrong | 0.13 | 0.13 | 0.13 |
| chaos.latencyMs | 383 | 810 | 799 |
| chaos.requests | 7.77 | 7.73 | 7.73 |
| chaos.staleMs | 196 | 202 | 188 |
| chaos.staleShare | 0.04 | 0.04 | 0.04 |
| chaos.wrongVisibleMs | 2915 | 3386 | 3273 |
| clean.finalWrong | 0 | 0 | 0 |
| clean.latencyMs | 20.33 | 199 | 189 |
| clean.requests | 9.27 | 9.27 | 9.27 |
| clean.staleMs | 0 | 21.33 | 14.67 |
| clean.staleShare | 0 | 0 | 0 |
| clean.wrongVisibleMs | 1370 | 1970 | 1973 |

Most common bugs with GenClass Off:
- showed other results for # ms after the right answer arrived (×4)
- final list does not match “Tall” (×1)
- final list does not match “dakar” (×1)
- final list does not match “nagoy” (×1)
- final list does not match “bucharest” (×1)

## Notes autosave (`editor`)

- **off**: bug rate 83% (25/30, 95% CI 66%–93%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 779 ms clean, 1.40 s chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 83% (25/30, 95% CI 66%–93%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 1, introduced 1 of 30. Interventions per chaos trial 0.00; decisions per trial 8.3; detections per trial 0.4; model decision latency p50 333 ms, p95 501 ms; user-visible latency p50 775 ms clean, 1.46 s chaos. Actions: none. Chosen but not run: probability # is below the guard threshold # ×23, guard mode does not allow heal-tier actions ×21, the decision arrived after the hold budget expired ×2.
- **heal**: bug rate 87% (26/30, 95% CI 70%–95%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 0, introduced 1 of 30. Interventions per chaos trial 0.33; decisions per trial 8.3; detections per trial 0.5; model decision latency p50 340 ms, p95 539 ms; user-visible latency p50 783 ms clean, 1.50 s chaos. Actions: block ×2, retry ×8. Chosen but not run: probability # is below the guard threshold # ×17, probability # is below the heal threshold # ×13, the decision arrived after the hold budget expired ×7.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.finalLie | 0.07 | 0.07 | 0.07 |
| chaos.latencyMs | 1476 | 1551 | 1636 |
| chaos.lieMs | 2256 | 2225 | 2315 |
| chaos.lostLocal | 0.83 | 0.83 | 0.87 |
| chaos.lostServer | 0.1 | 0.1 | 0.07 |
| chaos.maxLieMs | 1227 | 1205 | 1246 |
| chaos.reverts | 1.73 | 1.63 | 1.53 |
| chaos.saves | 13.27 | 13.27 | 13.4 |
| clean.finalLie | 0 | 0 | 0 |
| clean.latencyMs | 736 | 735 | 735 |
| clean.lieMs | 72.2 | 69.07 | 66.8 |
| clean.lostLocal | 0 | 0 | 0 |
| clean.lostServer | 0 | 0 | 0 |
| clean.maxLieMs | 60.13 | 44.07 | 43.47 |
| clean.reverts | 0 | 0 | 0 |
| clean.saves | 13.8 | 13.8 | 13.87 |

Most common bugs with GenClass Off:
- the editor lost text the user typed (×25)
- the server copy differs from the editor (×3)
- “Saved” shown while the server holds older text (×2)

## Cart & checkout (`checkout`)

- **off**: bug rate 83% (25/30, 95% CI 66%–93%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 205 ms clean, 624 ms chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 90% (27/30, 95% CI 74%–97%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 0, introduced 2 of 30. Interventions per chaos trial 0.00; decisions per trial 3.9; detections per trial 0.1; model decision latency p50 363 ms, p95 863 ms; user-visible latency p50 204 ms clean, 865 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×33, probability # is below the guard threshold # ×62, the decision arrived after the hold budget expired ×20.
- **heal**: bug rate 90% (27/30, 95% CI 74%–97%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 0, introduced 2 of 30. Interventions per chaos trial 0.10; decisions per trial 3.9; detections per trial 0.1; model decision latency p50 366 ms, p95 836 ms; user-visible latency p50 206 ms clean, 878 ms chaos. Actions: retry ×3. Chosen but not run: the decision arrived after the hold budget expired ×21, probability # is below the heal threshold # ×29, probability # is below the guard threshold # ×62.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.driftMs | 2822 | 2424 | 2384 |
| chaos.duplicates | 0.33 | 0.4 | 0.37 |
| chaos.errorsShown | 0 | 0 | 0 |
| chaos.latencyMs | 811 | 1141 | 1255 |
| chaos.maxDriftMs | 2759 | 2362 | 2326 |
| chaos.ordersCreated | 1.23 | 1.3 | 1.27 |
| chaos.untilTimeouts | 2 | 2 | 2 |
| chaos.wrongCharges | 1.1 | 1.17 | 1.13 |
| clean.driftMs | 0 | 0 | 0 |
| clean.duplicates | 0 | 0 | 0 |
| clean.errorsShown | 0 | 0 | 0 |
| clean.latencyMs | 199 | 203 | 202 |
| clean.maxDriftMs | 0 | 0 | 0 |
| clean.ordersCreated | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – |
| clean.wrongCharges | 0 | 0 | 0 |

Most common bugs with GenClass Off:
- displayed total ≠ sum of the lines for # s (×24)
- charged $# for items worth a different amount (×15)
- # orders created for # intended (×10)
- charged $#, $# for items worth a different amount (×9)

## Service status (`status`)

- **off**: bug rate 100% (30/30, 95% CI 89%–100%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 1.33 s clean, 1.24 s chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 93% (28/30, 95% CI 79%–98%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 2, introduced 0 of 30. Interventions per chaos trial 0.00; decisions per trial 38.9; detections per trial 3.9; model decision latency p50 1.20 s, p95 2.33 s; user-visible latency p50 1.26 s clean, 1.77 s chaos. Actions: none. Chosen but not run: the decision arrived after the hold budget expired ×204, guard mode does not allow heal-tier actions ×48, probability # is below the guard threshold # ×156.
- **heal**: bug rate 100% (30/30, 95% CI 89%–100%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 0, introduced 0 of 30. Interventions per chaos trial 0.00; decisions per trial 39.7; detections per trial 3.9; model decision latency p50 1.25 s, p95 2.34 s; user-visible latency p50 1.28 s clean, 1.62 s chaos. Actions: none. Chosen but not run: probability # is below the heal threshold # ×41, probability # is below the guard threshold # ×166, the decision arrived after the hold budget expired ×247.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.banners | 4.83 | 2.93 | 3.5 |
| chaos.falseAlarmMs | 6500 | 3688 | 4495 |
| chaos.latencyMs | 1511 | 2006 | 1951 |
| chaos.missedMs | 0 | 38.33 | 1.67 |
| chaos.otherWrongMs | 0 | 11.67 | 0 |
| chaos.requestRatio | 1.34 | 1.32 | 1.34 |
| chaos.requests | 75.9 | 74.93 | 76.03 |
| clean.banners | 0 | 0 | 0 |
| clean.falseAlarmMs | 0 | 0 | 0 |
| clean.latencyMs | 1141 | 1283 | 1212 |
| clean.missedMs | 0 | 0 | 0 |
| clean.otherWrongMs | 0 | 0 | 0 |
| clean.requestRatio | 0.95 | 0.98 | 0.98 |
| clean.requests | 44.4 | 45.6 | 45.6 |

Most common bugs with GenClass Off:
- # error banners shown (×28)
- showed healthy services as failing for # s (×27)
- # error banner shown (×2)

## Team board (`board`)

- **off**: bug rate 50% (15/30, 95% CI 33%–67%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 19 ms clean, 199 ms chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 77% (23/30, 95% CI 59%–88%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 1, introduced 9 of 30. Interventions per chaos trial 0.00; decisions per trial 5.2; detections per trial 0.3; model decision latency p50 346 ms, p95 718 ms; user-visible latency p50 31 ms clean, 315 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×24, probability # is below the guard threshold # ×54, the decision arrived after the hold budget expired ×9.
- **heal**: bug rate 73% (22/30, 95% CI 56%–86%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 2, introduced 9 of 30. Interventions per chaos trial 0.30; decisions per trial 6.2; detections per trial 0.4; model decision latency p50 360 ms, p95 810 ms; user-visible latency p50 33 ms clean, 608 ms chaos. Actions: retry ×9. Chosen but not run: probability # is below the heal threshold # ×24, probability # is below the guard threshold # ×54, the decision arrived after the hold budget expired ×16.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.divergedMs | 1381 | 2259 | 2586 |
| chaos.finalMismatches | 1.5 | 1.83 | 0.97 |
| chaos.jumpBacks | 2.9 | 3.9 | 4.83 |
| chaos.latencyMs | 517 | 586 | 1577 |
| chaos.maxDivergedMs | 1247 | 1948 | 2152 |
| chaos.teammateMoves | 5.1 | 5.33 | 4.2 |
| chaos.untilTimeouts | 1 | 1 | – |
| chaos.userMoves | 8.53 | 8.5 | 9.47 |
| clean.divergedMs | 0 | 0 | 0 |
| clean.finalMismatches | 0 | 0 | 0 |
| clean.jumpBacks | 0.27 | 0.27 | 0.33 |
| clean.latencyMs | 168 | 88 | 32.47 |
| clean.maxDivergedMs | 0 | 0 | 0 |
| clean.teammateMoves | 0.47 | 0.67 | 0.67 |
| clean.untilTimeouts | – | – | – |
| clean.userMoves | 5.13 | 5.13 | 5.13 |

Most common bugs with GenClass Off:
- # card in the wrong column at the end (c#) (×8)
- # cards in the wrong column at the end (c#, c#, c#, c#, c#, c#, c#, c#, c#, c#) (×3)
- # card stuck “syncing” (×3)
- # cards in the wrong column at the end (c#, c#) (×2)
- board disagreed with the server for # s (×1)

## Runtime decisions (`decisions`)

- **off**: bug rate 83% (25/30, 95% CI 66%–93%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 0 ms clean, 0 ms chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 90% (27/30, 95% CI 74%–97%) under chaos; 100% (15/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 3, introduced 5 of 30. Interventions per chaos trial 0.00; decisions per trial 6.7; detections per trial 1.0; model decision latency p50 308 ms, p95 619 ms; user-visible latency p50 151 ms clean, 196 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×146, probability # is below the guard threshold # ×28, the decision arrived after the hold budget expired ×25.
- **heal**: bug rate 93% (28/30, 95% CI 79%–98%) under chaos; 100% (15/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 2, introduced 5 of 30. Interventions per chaos trial 2.33; decisions per trial 7.5; detections per trial 1.0; model decision latency p50 304 ms, p95 605 ms; user-visible latency p50 157 ms clean, 202 ms chaos. Actions: block ×60, retry ×10. Chosen but not run: probability # is below the heal threshold # ×118, probability # is below the guard threshold # ×30, the decision arrived after the hold budget expired ×22.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.accuracy | 0.42 | 0.62 | 0.59 |
| chaos.answeredByGenClass | 0 | 4.03 | 4.03 |
| chaos.backup.n | 1.19 | 2.43 | 2.43 |
| chaos.backup.ok | 0.24 | 2.19 | 2.1 |
| chaos.decisions | 3.17 | 4.03 | 4.03 |
| chaos.health.n | 1 | 1 | 1 |
| chaos.health.ok | 0.55 | 0.36 | 0.36 |
| chaos.latencyMs | 0 | 214 | 232 |
| chaos.leave.n | 1.61 | 1.61 | 1.61 |
| chaos.leave.ok | 0.79 | 0.79 | 0.71 |
| chaos.quality.n | 1 | 1 | 1 |
| chaos.quality.ok | 0.43 | 0.43 | 0.43 |
| chaos.untilTimeouts | 1 | 1 | 1 |
| chaos.wrong | 1.87 | 1.43 | 1.57 |
| clean.accuracy | 1 | 0.27 | 0.27 |
| clean.answeredByGenClass | 0 | 3.47 | 3.47 |
| clean.backup.n | 1 | 1.58 | 1.58 |
| clean.backup.ok | 1 | 0.5 | 0.5 |
| clean.decisions | 3 | 3.47 | 3.47 |
| clean.health.n | 1 | 1 | 1 |
| clean.health.ok | 1 | 0 | 0 |
| clean.latencyMs | 0 | 156 | 161 |
| clean.leave.n | 1 | 1 | 1 |
| clean.leave.ok | 1 | 1 | 1 |
| clean.quality.n | 1 | 1 | 1 |
| clean.quality.ok | 1 | 0 | 0 |
| clean.untilTimeouts | – | – | – |
| clean.wrong | 0 | 2.47 | 2.47 |

Most common bugs with GenClass Off:
- leave: answered “let go” (default), right answer “warn” (×23)
- backup: answered “start now” (default), right answer “postpone” (×20)
- quality: answered “full” (default), right answer “reduced” (×6)
- health: answered “good” (default), right answer “failing” (×3)
- quality: answered “full” (default), right answer “thumbnails” (×2)

## How to reproduce

```bash
scripts/vm.sh run demos 'npm install && npm run build -w @genclass/runtime && cd demos && npm run fetch-model && npm run build && npm run eval'
```
