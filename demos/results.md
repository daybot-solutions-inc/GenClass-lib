# GenClass Runtime demos: trial results

Generated 2026-10-08T00:49:05.420Z on the build VM. Runtime: **real** (@genclass/runtime 0.1.0, dist 5155180d4baf). Model: genclass-model on wasm q8, cross-origin isolated (WASM threads available). The v0.1 GenClass model is a general classifier that was not trained for runtime decisions; these numbers measure the runtime and the demos with it, not the runtime-specialist model.

Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). 30 chaos trials and 15 clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.

| Demo | Bug rate Off | Guard | Heal | False interventions (clean) Guard | Heal | Fixed/introduced vs Off: Guard | Heal | User latency p50 (clean) Off / Guard / Heal | Model decision p50 Guard / Heal |
|---|---|---|---|---|---|---|---|---|---|
| Search typeahead | 23% (7/30) | 23% (7/30) | 27% (8/30) | 0 in 0/15 | 0 in 0/15 | 1/1 | 2/3 | 10 ms / 234 ms / 335 ms | 805 ms / 791 ms |
| Notes autosave | 83% (25/30) | 90% (27/30) | 87% (26/30) | 0 in 0/15 | 0 in 0/15 | 1/3 | 2/3 | 784 ms / 783 ms / 783 ms | 505 ms / 499 ms |
| Cart & checkout | 70% (21/30) | 77% (23/30) | 83% (25/30) | 0 in 0/15 | 0 in 0/15 | 1/3 | 0/4 | 207 ms / 211 ms / 215 ms | 581 ms / 503 ms |
| Service status | 100% (30/30) | 100% (30/30) | 100% (30/30) | 0 in 0/15 | 0 in 0/15 | 0/0 | 0/0 | 1.32 s / 1.66 s / 1.54 s | 1.75 s / 1.78 s |
| Team board | 57% (17/30) | 63% (19/30) | 77% (23/30) | 0 in 0/15 | 0 in 0/15 | 3/5 | 2/8 | 10 ms / 27 ms / 26 ms | 1.10 s / 1.14 s |
| Runtime decisions | 83% (25/30) | 97% (29/30) | 97% (29/30) | 0 in 0/15 | 0 in 0/15 | 1/5 | 1/5 | 0 ms / 215 ms / 219 ms | 413 ms / 424 ms |

## Search typeahead (`search`)

- **off**: bug rate 23% (7/30, 95% CI 12%–41%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 10 ms clean, 329 ms chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 23% (7/30, 95% CI 12%–41%) under chaos; 7% (1/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 1, introduced 1 of 30. Interventions per chaos trial 0.00; decisions per trial 6.7; detections per trial 0.0; model decision latency p50 805 ms, p95 1.85 s; user-visible latency p50 234 ms clean, 950 ms chaos. Actions: none. Chosen but not run: probability # for the permitted actions (discard, defer) is below the guard threshold # ×122, guard mode does not allow heal-tier actions ×7, probability # for the permitted actions (coalesce, delay) is below the guard threshold # ×1.
- **heal**: bug rate 27% (8/30, 95% CI 14%–44%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 2, introduced 3 of 30. Interventions per chaos trial 0.00; decisions per trial 6.6; detections per trial 0.0; model decision latency p50 791 ms, p95 1.58 s; user-visible latency p50 335 ms clean, 961 ms chaos. Actions: none. Chosen but not run: probability # for the permitted actions (discard, defer) is below the guard threshold # ×118, probability # for the permitted actions (hedge) is below the heal threshold # ×2, probability # for the permitted actions (coalesce, delay, block) is below the guard threshold # ×1, probability # for the permitted actions (retry) is below the heal threshold # ×2.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.finalWrong | 0.17 | 0.17 | 0.13 |
| chaos.latencyMs | 424 | 970 | 1009 |
| chaos.requests | 7.97 | 8 | 7.83 |
| chaos.staleMs | 355 | 353 | 349 |
| chaos.staleShare | 0.07 | 0.06 | 0.06 |
| chaos.wrongVisibleMs | 3009 | 3647 | 3685 |
| clean.finalWrong | 0 | 0.07 | 0 |
| clean.latencyMs | 13.67 | 241 | 367 |
| clean.requests | 9.33 | 9.33 | 9.33 |
| clean.staleMs | 0 | 155 | 65.33 |
| clean.staleShare | 0 | 0.02 | 0.01 |
| clean.wrongVisibleMs | 1402 | 2313 | 2263 |

Most common bugs with GenClass Off:
- showed other results for # ms after the right answer arrived (×7)
- final list does not match “Tall” (×1)
- final list does not match “Port Mores” (×1)
- final list does not match “nagoy” (×1)
- final list does not match “Vilni” (×1)

## Notes autosave (`editor`)

- **off**: bug rate 83% (25/30, 95% CI 66%–93%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 784 ms clean, 1.48 s chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 90% (27/30, 95% CI 74%–97%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 1, introduced 3 of 30. Interventions per chaos trial 0.00; decisions per trial 9.1; detections per trial 0.0; model decision latency p50 505 ms, p95 854 ms; user-visible latency p50 783 ms clean, 1.64 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×27, probability # for the permitted actions (discard, defer) is below the guard threshold # ×19, probability # for the permitted actions (coalesce, delay) is below the guard threshold # ×4.
- **heal**: bug rate 87% (26/30, 95% CI 70%–95%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 2, introduced 3 of 30. Interventions per chaos trial 0.47; decisions per trial 9.8; detections per trial 0.1; model decision latency p50 499 ms, p95 853 ms; user-visible latency p50 783 ms clean, 1.74 s chaos. Actions: retry ×9, block ×5. Chosen but not run: probability # for the permitted actions (retry) is below the heal threshold # ×13, probability # for the permitted actions (discard, defer) is below the guard threshold # ×22, probability # for the permitted actions (coalesce, delay, block) is below the guard threshold # ×1, probability # for the permitted actions (retry, serve_cached) is below the heal threshold # ×1, probability # for the permitted actions (coalesce, delay, block) is below the heal threshold # ×2, probability # for the permitted actions (delay, block) is below the heal threshold # ×1.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.finalLie | 0.1 | 0.1 | 0.07 |
| chaos.latencyMs | 1904 | 1754 | 1951 |
| chaos.lieMs | 3925 | 3883 | 3387 |
| chaos.lostLocal | 0.83 | 0.9 | 0.87 |
| chaos.lostServer | 0.13 | 0.1 | 0.07 |
| chaos.maxLieMs | 2944 | 2897 | 2339 |
| chaos.reverts | 1.1 | 1.57 | 1.67 |
| chaos.saves | 12.67 | 12.73 | 12.97 |
| clean.finalLie | 0 | 0 | 0 |
| clean.latencyMs | 737 | 738 | 734 |
| clean.lieMs | 110 | 81.33 | 83.93 |
| clean.lostLocal | 0 | 0 | 0 |
| clean.lostServer | 0 | 0 | 0 |
| clean.maxLieMs | 96.73 | 79.67 | 75.53 |
| clean.reverts | 0 | 0 | 0 |
| clean.saves | 14 | 14 | 14 |

Most common bugs with GenClass Off:
- the editor lost text the user typed (×25)
- the server copy differs from the editor (×4)
- “Saved” shown while the server holds older text (×3)
- “Saved” was untrue for # s (×1)

## Cart & checkout (`checkout`)

- **off**: bug rate 70% (21/30, 95% CI 52%–83%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 207 ms clean, 679 ms chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 77% (23/30, 95% CI 59%–88%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 1, introduced 3 of 30. Interventions per chaos trial 0.00; decisions per trial 4.2; detections per trial 0.0; model decision latency p50 581 ms, p95 1.65 s; user-visible latency p50 211 ms clean, 909 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×55, probability # for the permitted actions (coalesce, delay) is below the guard threshold # ×11, probability # for the permitted actions (discard, defer) is below the guard threshold # ×40.
- **heal**: bug rate 83% (25/30, 95% CI 66%–93%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 0, introduced 4 of 30. Interventions per chaos trial 0.57; decisions per trial 4.1; detections per trial 0.0; model decision latency p50 503 ms, p95 1.25 s; user-visible latency p50 215 ms clean, 843 ms chaos. Actions: retry ×4, block ×13. Chosen but not run: probability # for the permitted actions (retry) is below the heal threshold # ×30, probability # for the permitted actions (discard, defer) is below the guard threshold # ×46, probability # for the permitted actions (coalesce, delay, block) is below the guard threshold # ×8, probability # for the permitted actions (coalesce, delay, block) is below the heal threshold # ×1.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.driftMs | 2582 | 2638 | 2639 |
| chaos.duplicates | 0.33 | 0.37 | 0.3 |
| chaos.errorsShown | 0 | 0.03 | 0.1 |
| chaos.latencyMs | 971 | 1222 | 920 |
| chaos.maxDriftMs | 2519 | 2534 | 2607 |
| chaos.ordersCreated | 1.17 | 1.17 | 1.17 |
| chaos.untilTimeouts | 2 | 1.83 | 2 |
| chaos.wrongCharges | 1.03 | 1 | 0.97 |
| clean.driftMs | 0 | 0 | 0 |
| clean.duplicates | 0 | 0 | 0 |
| clean.errorsShown | 0 | 0 | 0 |
| clean.latencyMs | 210 | 212 | 216 |
| clean.maxDriftMs | 0 | 0 | 0 |
| clean.ordersCreated | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – |
| clean.wrongCharges | 0 | 0 | 0 |

Most common bugs with GenClass Off:
- displayed total ≠ sum of the lines for # s (×21)
- charged $# for items worth a different amount (×12)
- # orders created for # intended (×9)
- charged $#, $# for items worth a different amount (×8)
- charged $#, $#, $# for items worth a different amount (×1)

## Service status (`status`)

- **off**: bug rate 100% (30/30, 95% CI 89%–100%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 1.32 s clean, 1.41 s chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 100% (30/30, 95% CI 89%–100%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 0, introduced 0 of 30. Interventions per chaos trial 0.00; decisions per trial 28.4; detections per trial 0.0; model decision latency p50 1.75 s, p95 2.60 s; user-visible latency p50 1.66 s clean, 1.69 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×28, probability # for the permitted actions (discard, defer) is below the guard threshold # ×140, probability # for the permitted actions (coalesce, delay) is below the guard threshold # ×1.
- **heal**: bug rate 100% (30/30, 95% CI 89%–100%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 0, introduced 0 of 30. Interventions per chaos trial 0.47; decisions per trial 28.5; detections per trial 0.0; model decision latency p50 1.78 s, p95 2.58 s; user-visible latency p50 1.54 s clean, 1.57 s chaos. Actions: block ×12, retry ×1, serve_cached ×1. Chosen but not run: probability # for the permitted actions (retry) is below the heal threshold # ×11, probability # for the permitted actions (discard, defer) is below the guard threshold # ×160, probability # for the permitted actions (coalesce, delay, block) is below the guard threshold # ×1, probability # for the permitted actions (retry, serve_cached) is below the heal threshold # ×2, probability # for the permitted actions (coalesce, delay, block, serve_cached) is below the heal threshold # ×1, probability # for the permitted actions (coalesce, delay, block, serve_cached) is below the guard threshold # ×1.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.banners | 4.57 | 3.83 | 3.63 |
| chaos.falseAlarmMs | 5646 | 5009 | 4151 |
| chaos.latencyMs | 1530 | 2113 | 1768 |
| chaos.missedMs | 0 | 13.33 | 0 |
| chaos.otherWrongMs | 0 | 88.37 | 125 |
| chaos.requestRatio | 1.32 | 1.36 | 1.36 |
| chaos.requests | 75.23 | 77.17 | 77.33 |
| clean.banners | 0 | 0 | 0 |
| clean.falseAlarmMs | 0 | 0 | 0 |
| clean.latencyMs | 1146 | 1561 | 1493 |
| clean.missedMs | 0 | 0 | 0 |
| clean.otherWrongMs | 0 | 0 | 0 |
| clean.requestRatio | 0.95 | 0.98 | 0.99 |
| clean.requests | 44.4 | 45.6 | 46 |

Most common bugs with GenClass Off:
- # error banners shown (×29)
- showed healthy services as failing for # s (×28)
- # requests, #× a steady poll (×1)
- # error banner shown (×1)

## Team board (`board`)

- **off**: bug rate 57% (17/30, 95% CI 39%–73%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 10 ms clean, 178 ms chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 63% (19/30, 95% CI 46%–78%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 3, introduced 5 of 30. Interventions per chaos trial 0.00; decisions per trial 8.2; detections per trial 0.2; model decision latency p50 1.10 s, p95 2.57 s; user-visible latency p50 27 ms clean, 1.04 s chaos. Actions: none. Chosen but not run: probability # for the permitted actions (discard, defer) is below the guard threshold # ×77, guard mode does not allow heal-tier actions ×22, probability # for the permitted actions (coalesce, delay) is below the guard threshold # ×4.
- **heal**: bug rate 77% (23/30, 95% CI 59%–88%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 2, introduced 8 of 30. Interventions per chaos trial 0.10; decisions per trial 8.6; detections per trial 0.2; model decision latency p50 1.14 s, p95 2.47 s; user-visible latency p50 26 ms clean, 650 ms chaos. Actions: retry ×1, block ×2. Chosen but not run: probability # for the permitted actions (discard, defer) is below the guard threshold # ×75, probability # for the permitted actions (retry) is below the heal threshold # ×10, probability # for the permitted actions (coalesce, delay, block) is below the guard threshold # ×7.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.divergedMs | 1980 | 2353 | 2933 |
| chaos.finalMismatches | 1.4 | 1.33 | 1.7 |
| chaos.jumpBacks | 3.1 | 4.6 | 5.03 |
| chaos.latencyMs | 466 | 1034 | 764 |
| chaos.maxDivergedMs | 1841 | 1941 | 2586 |
| chaos.teammateMoves | 4.63 | 5.2 | 5.2 |
| chaos.untilTimeouts | 1 | 1 | 1 |
| chaos.userMoves | 8.7 | 8.57 | 8.67 |
| clean.divergedMs | 0 | 0 | 0 |
| clean.finalMismatches | 0 | 0 | 0 |
| clean.jumpBacks | 0.27 | 0.13 | 0.2 |
| clean.latencyMs | 172 | 110 | 50.53 |
| clean.maxDivergedMs | 0 | 0 | 0 |
| clean.teammateMoves | 0.53 | 0.93 | 1 |
| clean.untilTimeouts | – | – | – |
| clean.userMoves | 5.13 | 5.13 | 5.13 |

Most common bugs with GenClass Off:
- # card in the wrong column at the end (c#) (×9)
- # cards in the wrong column at the end (c#, c#) (×5)
- # card stuck “syncing” (×5)
- # cards in the wrong column at the end (c#, c#, c#, c#, c#, c#, c#, c#, c#, c#) (×2)
- # cards in the wrong column at the end (c#, c#, c#) (×1)

## Runtime decisions (`decisions`)

- **off**: bug rate 83% (25/30, 95% CI 66%–93%) under chaos; 0% (0/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 0 ms clean, 0 ms chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 97% (29/30, 95% CI 83%–99%) under chaos; 100% (15/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 1, introduced 5 of 30. Interventions per chaos trial 0.00; decisions per trial 9.2; detections per trial 0.1; model decision latency p50 413 ms, p95 925 ms; user-visible latency p50 215 ms clean, 301 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×276, probability # for the permitted actions (discard, defer) is below the guard threshold # ×13.
- **heal**: bug rate 97% (29/30, 95% CI 83%–99%) under chaos; 100% (15/15) on clean runs. False interventions on clean runs: **0** (in 0/15 runs). Paired with Off: fixed 1, introduced 5 of 30. Interventions per chaos trial 3.60; decisions per trial 6.8; detections per trial 0.1; model decision latency p50 424 ms, p95 805 ms; user-visible latency p50 219 ms clean, 282 ms chaos. Actions: retry ×14, block ×92, serve_cached ×2. Chosen but not run: probability # for the permitted actions (retry) is below the heal threshold # ×38, probability # for the permitted actions (discard, defer) is below the guard threshold # ×22, probability # for the permitted actions (retry, serve_cached) is below the heal threshold # ×5, probability # for the permitted actions (delay, block) is below the heal threshold # ×13, probability # for the permitted actions (coalesce, delay, block, serve_cached) is below the heal threshold # ×2, probability # for the permitted actions (hedge, serve_cached) is below the heal threshold # ×1.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.accuracy | 0.37 | 0.61 | 0.6 |
| chaos.answeredByGenClass | 0 | 4.03 | 4.03 |
| chaos.backup.n | 1.24 | 2.43 | 2.43 |
| chaos.backup.ok | 0.19 | 2.24 | 2.14 |
| chaos.decisions | 3.2 | 4.03 | 4.03 |
| chaos.health.n | 1 | 1 | 1 |
| chaos.health.ok | 0.45 | 0.27 | 0.27 |
| chaos.latencyMs | 0 | 315 | 297 |
| chaos.leave.n | 1.61 | 1.61 | 1.61 |
| chaos.leave.ok | 0.75 | 0.75 | 0.79 |
| chaos.quality.n | 1 | 1 | 1 |
| chaos.quality.ok | 0.43 | 0.36 | 0.36 |
| chaos.untilTimeouts | 1 | 1 | 1 |
| chaos.wrong | 2 | 1.5 | 1.53 |
| clean.accuracy | 1 | 0.27 | 0.27 |
| clean.answeredByGenClass | 0 | 3.47 | 3.47 |
| clean.backup.n | 1 | 1.58 | 1.58 |
| clean.backup.ok | 1 | 0.5 | 0.5 |
| clean.decisions | 3 | 3.47 | 3.47 |
| clean.health.n | 1 | 1 | 1 |
| clean.health.ok | 1 | 0 | 0 |
| clean.latencyMs | 0.4 | 215 | 229 |
| clean.leave.n | 1 | 1 | 1 |
| clean.leave.ok | 1 | 1 | 1 |
| clean.quality.n | 1 | 1 | 1 |
| clean.quality.ok | 1 | 0 | 0 |
| clean.untilTimeouts | – | – | – |
| clean.wrong | 0 | 2.47 | 2.47 |

Most common bugs with GenClass Off:
- leave: answered “let go” (default), right answer “warn” (×24)
- backup: answered “start now” (default), right answer “postpone” (×22)
- quality: answered “full” (default), right answer “reduced” (×5)
- health: answered “good” (default), right answer “poor” (×3)
- quality: answered “full” (default), right answer “thumbnails” (×3)

## How to reproduce

```bash
scripts/vm.sh run demos 'setsid nohup bash demos/scripts/vm-eval.sh > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
# or, on any machine: npm install && npm run build -w @genclass/runtime && cd demos && npm run fetch-model && npm run build && npm run eval
```
