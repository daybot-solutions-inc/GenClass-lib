# GenClass Runtime demos: trial results

Generated 2026-10-09T07:03:13.541Z on the build VM. Runtime: **real** (@genclass/runtime 0.1.0-beta.4, dist d0fd6e20ecfc). Model: genclass-runtime-r17 on wasm q8, cross-origin isolated (WASM threads available).

Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). 10 chaos trials and 5 clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.

| Demo | Mode | Chaos bug rate | Fixed/introduced vs Off | Clean bugs | False interventions (clean) | False findings (clean) | Findings / chaos trial | Actions / chaos trial | Actions run | User latency p50 (clean) | Decision p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search typeahead | off | 20% (2/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 25 ms | – |
| Search typeahead | guard | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 3 in 3/5 | 1.10 | 0.20 | discard 2 | 32 ms | 171 ms |
| Search typeahead | heal | 20% (2/10) | 0/0 | 0/5 | 0 in 0/5 | 2 in 2/5 | 1.00 | 0.30 | discard 3 | 21 ms | 158 ms |
| Notes autosave | off | 100% (10/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 783 ms | – |
| Notes autosave | guard | 90% (9/10) | 1/0 | 0/5 | 0 in 0/5 | 1 in 1/5 | 4.90 | 0.00 | – | 794 ms | 139 ms |
| Notes autosave | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 5.10 | 0.00 | – | 790 ms | 133 ms |
| Cart & checkout | off | 70% (7/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 205 ms | – |
| Cart & checkout | guard | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 1.90 | 0.00 | – | 199 ms | 145 ms |
| Cart & checkout | heal | 70% (7/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.00 | 0.00 | – | 205 ms | 138 ms |
| Service status | off | 100% (10/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 1.52 s | – |
| Service status | guard | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 8.40 | 0.00 | – | 960 ms | 629 ms |
| Service status | heal | 100% (10/10) | 0/0 | 0/5 | 0 in 0/5 | 0 in 0/5 | 8.30 | 0.00 | – | 997 ms | 816 ms |
| Team board | off | 40% (4/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 21 ms | – |
| Team board | guard | 60% (6/10) | 0/2 | 0/5 | 0 in 0/5 | 0 in 0/5 | 2.80 | 0.00 | – | 11 ms | 182 ms |
| Team board | heal | 60% (6/10) | 0/2 | 0/5 | 0 in 0/5 | 0 in 0/5 | 3.00 | 0.00 | – | 21 ms | 152 ms |
| Runtime decisions | off | 100% (10/10) | – | 0/5 | 0 in 0/5 | 0 in 0/5 | 0.00 | 0.00 | – | 0 ms | – |
| Runtime decisions | guard | 90% (9/10) | 1/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 7.80 | 0.00 | – | 91 ms | 122 ms |
| Runtime decisions | heal | 90% (9/10) | 1/0 | 1/5 | 0 in 0/5 | 0 in 0/5 | 6.80 | 0.00 | – | 67 ms | 123 ms |

## Search typeahead (`search`)

- **off**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 25 ms clean, 106 ms chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.20; decisions per trial 1.7; detections per trial 0.9; model decision latency p50 171 ms, p95 370 ms; user-visible latency p50 32 ms clean, 93 ms chaos. Actions: discard ×2. Chosen but not run: gain # of discard over deliver is not above the guard margin # ×4, gain # of discard over apply is not above the guard margin # ×4, gain # of coalesce over send is not above the guard margin # ×1, guard mode does not allow heal-tier actions ×2, superseded: search.query changed again after the write applied ×1.
- **heal**: bug rate 20% (2/10, 95% CI 6%–51%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.30; decisions per trial 1.7; detections per trial 0.8; model decision latency p50 158 ms, p95 275 ms; user-visible latency p50 21 ms clean, 89 ms chaos. Actions: discard ×3. Chosen but not run: gain # of discard over deliver is not above the guard margin # ×5, superseded: search.query changed again after the write applied ×1, gain # of discard over apply is not above the guard margin # ×2, gain # of coalesce over send is not above the guard margin # ×1, gain # of retry over deliver is not above the heal margin # ×1, gain # of defer over apply is not above the guard margin # ×1.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.finalWrong | 0.1 | 0.1 | 0.1 |
| chaos.latencyMs | 461 | 469 | 475 |
| chaos.requests | 10.5 | 10.5 | 10.7 |
| chaos.staleMs | 484 | 483 | 482 |
| chaos.staleShare | 0.09 | 0.09 | 0.09 |
| chaos.wrongVisibleMs | 4254 | 4216 | 4190 |
| clean.finalWrong | 0 | 0 | 0 |
| clean.latencyMs | 74.2 | 105 | 76 |
| clean.requests | 10.8 | 10.8 | 10.8 |
| clean.staleMs | 56.2 | 63.6 | 60 |
| clean.staleShare | 0.01 | 0.01 | 0.01 |
| clean.wrongVisibleMs | 1971 | 1970 | 1956 |

Most common bugs with GenClass Off:
- showed other results for # ms after the right answer arrived (×2)
- final list does not match “Portl” (×1)

## Notes autosave (`editor`)

- **off**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 783 ms clean, 1.89 s chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 7.4; detections per trial 3.3; model decision latency p50 139 ms, p95 277 ms; user-visible latency p50 794 ms clean, 1.69 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×9, gain # of discard over deliver is not above the guard margin # ×25, gain # of discard over apply is not above the guard margin # ×6, gain # of coalesce over send is not above the guard margin # ×8.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 7.7; detections per trial 3.4; model decision latency p50 133 ms, p95 318 ms; user-visible latency p50 790 ms clean, 1.83 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×6, gain # of discard over deliver is not above the guard margin # ×26, gain # of discard over apply is not above the guard margin # ×7, gain # of coalesce over send is not above the guard margin # ×9.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.finalLie | 0.1 | 0.1 | 0.1 |
| chaos.latencyMs | 2632 | 2685 | 2631 |
| chaos.lieMs | 6611 | 6726 | 6443 |
| chaos.lostLocal | 1 | 0.9 | 1 |
| chaos.lostServer | 0.1 | 0.1 | 0.1 |
| chaos.maxLieMs | 6066 | 6046 | 5974 |
| chaos.reverts | 1.1 | 1 | 1.3 |
| chaos.saves | 10.6 | 10.6 | 10.7 |
| clean.finalLie | 0 | 0 | 0 |
| clean.latencyMs | 650 | 656 | 657 |
| clean.lieMs | 44.6 | 41.6 | 45 |
| clean.lostLocal | 0 | 0 | 0 |
| clean.lostServer | 0 | 0 | 0 |
| clean.maxLieMs | 44.6 | 41.6 | 45 |
| clean.reverts | 0 | 0 | 0 |
| clean.saves | 13.6 | 13.6 | 13.6 |

Most common bugs with GenClass Off:
- the editor lost text the user typed (×10)
- the server copy differs from the editor (×1)
- “Saved” shown while the server holds older text (×1)

## Cart & checkout (`checkout`)

- **off**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 205 ms clean, 599 ms chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 2.8; detections per trial 1.3; model decision latency p50 145 ms, p95 402 ms; user-visible latency p50 199 ms clean, 595 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×2, gain # of coalesce over send is not above the guard margin # ×8, gain # of discard over apply is not above the guard margin # ×4, gain # of discard over deliver is not above the guard margin # ×2.
- **heal**: bug rate 70% (7/10, 95% CI 40%–89%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 2.9; detections per trial 1.3; model decision latency p50 138 ms, p95 284 ms; user-visible latency p50 205 ms clean, 514 ms chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×2, gain # of coalesce over send is not above the guard margin # ×8, gain # of discard over apply is not above the guard margin # ×5, gain # of discard over deliver is not above the guard margin # ×3.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.driftMs | 2568 | 2576 | 2567 |
| chaos.duplicates | 0.5 | 0.5 | 0.5 |
| chaos.errorsShown | 0 | 0 | 0 |
| chaos.latencyMs | 956 | 968 | 945 |
| chaos.maxDriftMs | 2568 | 2576 | 2567 |
| chaos.ordersCreated | 1.3 | 1.3 | 1.3 |
| chaos.untilTimeouts | 2 | 2 | 2 |
| chaos.wrongCharges | 1.2 | 1.2 | 1.2 |
| clean.driftMs | 0 | 0 | 0 |
| clean.duplicates | 0 | 0 | 0 |
| clean.errorsShown | 0 | 0 | 0 |
| clean.latencyMs | 206 | 201 | 204 |
| clean.maxDriftMs | 0 | 0 | 0 |
| clean.ordersCreated | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – |
| clean.wrongCharges | 0 | 0 | 0 |

Most common bugs with GenClass Off:
- displayed total ≠ sum of the lines for # s (×7)
- # orders created for # intended (×4)
- charged $#, $# for items worth a different amount (×3)
- charged $# for items worth a different amount (×3)
- charged $#, $#, $# for items worth a different amount (×1)

## Service status (`status`)

- **off**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 1.52 s clean, 1.55 s chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 23.5; detections per trial 5.6; model decision latency p50 629 ms, p95 3.16 s; user-visible latency p50 960 ms clean, 1.90 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×50, gain # of delay over send is not above the guard margin # ×8, gain # of coalesce over send is not above the guard margin # ×35, gain # of discard over deliver is not above the guard margin # ×2.
- **heal**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 23.1; detections per trial 5.5; model decision latency p50 816 ms, p95 3.61 s; user-visible latency p50 997 ms clean, 1.59 s chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×18, gain # of delay over send is not above the guard margin # ×6, gain # of coalesce over send is not above the guard margin # ×28, gain # of serve_cached over send is not above the heal margin # ×23, gain # of serve_cached over deliver is not above the heal margin # ×14, gain # of discard over apply is not above the guard margin # ×1, gain # of discard over deliver is not above the guard margin # ×1.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.banners | 4.2 | 4.1 | 3.8 |
| chaos.falseAlarmMs | 4430 | 4892 | 4357 |
| chaos.latencyMs | 1951 | 1936 | 1746 |
| chaos.missedMs | 0 | 0 | 0 |
| chaos.otherWrongMs | 0 | 0 | 0 |
| chaos.requestRatio | 1.31 | 1.31 | 1.33 |
| chaos.requests | 70 | 70.1 | 71.2 |
| clean.banners | 0 | 0 | 0 |
| clean.falseAlarmMs | 0 | 0 | 0 |
| clean.latencyMs | 1363 | 960 | 993 |
| clean.missedMs | 0 | 0 | 0 |
| clean.otherWrongMs | 0 | 0 | 0 |
| clean.requestRatio | 0.95 | 0.95 | 0.95 |
| clean.requests | 45.6 | 45.6 | 45.6 |

Most common bugs with GenClass Off:
- # error banners shown (×10)
- showed healthy services as failing for # s (×9)

## Team board (`board`)

- **off**: bug rate 40% (4/10, 95% CI 17%–69%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 21 ms clean, 43 ms chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 60% (6/10, 95% CI 31%–83%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 2 of 10. Interventions per chaos trial 0.00; decisions per trial 7.7; detections per trial 1.9; model decision latency p50 182 ms, p95 540 ms; user-visible latency p50 11 ms clean, 32 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×15, gain # of discard over deliver is not above the guard margin # ×4, gain # of coalesce over send is not above the guard margin # ×2.
- **heal**: bug rate 60% (6/10, 95% CI 31%–83%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 0, introduced 2 of 10. Interventions per chaos trial 0.00; decisions per trial 8.2; detections per trial 2.0; model decision latency p50 152 ms, p95 446 ms; user-visible latency p50 21 ms clean, 60 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×18, gain # of coalesce over send is not above the guard margin # ×3, gain # of discard over deliver is not above the guard margin # ×6.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.divergedMs | 2644 | 3872 | 3942 |
| chaos.finalMismatches | 0.5 | 0.8 | 0.7 |
| chaos.jumpBacks | 4.2 | 4.2 | 4.5 |
| chaos.latencyMs | 219 | 300 | 303 |
| chaos.maxDivergedMs | 2264 | 3524 | 3548 |
| chaos.teammateMoves | 5.1 | 5 | 5 |
| chaos.userMoves | 10.6 | 10.7 | 10.6 |
| clean.divergedMs | 0 | 0 | 0 |
| clean.finalMismatches | 0 | 0 | 0 |
| clean.jumpBacks | 0.2 | 0.2 | 0.2 |
| clean.latencyMs | 328 | 19.2 | 237 |
| clean.maxDivergedMs | 0 | 0 | 0 |
| clean.teammateMoves | 0.4 | 0.4 | 0.4 |
| clean.userMoves | 5.2 | 5.2 | 5.2 |

Most common bugs with GenClass Off:
- # card in the wrong column at the end (c#) (×3)
- # card stuck “syncing” (×3)
- # cards in the wrong column at the end (c#, c#) (×1)

## Runtime decisions (`decisions`)

- **off**: bug rate 100% (10/10, 95% CI 72%–100%) under chaos; 0% (0/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 0 ms clean, 0 ms chaos. Actions: none. Chosen but not run: none.
- **guard**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 8.2; detections per trial 5.2; model decision latency p50 122 ms, p95 220 ms; user-visible latency p50 91 ms clean, 85 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×15.
- **heal**: bug rate 90% (9/10, 95% CI 60%–98%) under chaos; 20% (1/5) on clean runs. False interventions on clean runs: **0** (in 0/5 runs). Paired with Off: fixed 1, introduced 0 of 10. Interventions per chaos trial 0.00; decisions per trial 7.5; detections per trial 4.5; model decision latency p50 123 ms, p95 199 ms; user-visible latency p50 67 ms clean, 84 ms chaos. Actions: none. Chosen but not run: gain # of retry over deliver is not above the heal margin # ×14, gain # of coalesce over send is not above the guard margin # ×1.

| metric (mean) | off | guard | heal |
|---|---|---|---|
| chaos.accuracy | 0.32 | 0.47 | 0.47 |
| chaos.answeredByGenClass | 0 | 3.4 | 3.3 |
| chaos.backup.n | 1.2 | 1.2 | 1.2 |
| chaos.backup.ok | 0 | 0 | 0 |
| chaos.decisions | 3.4 | 3.4 | 3.4 |
| chaos.health.n | 1 | 1 | 1 |
| chaos.health.ok | 0.4 | 0.4 | 0.4 |
| chaos.latencyMs | 0 | 92.7 | 82.4 |
| chaos.leave.n | 2 | 2 | 2 |
| chaos.leave.ok | 0.8 | 1.3 | 1.3 |
| chaos.quality.n | 1 | 1 | 1 |
| chaos.quality.ok | 0.33 | 0.33 | 0.33 |
| chaos.untilTimeouts | 1 | 1 | 1 |
| chaos.wrong | 2.3 | 1.8 | 1.8 |
| clean.accuracy | 1 | 0.93 | 0.93 |
| clean.answeredByGenClass | 0 | 3 | 3 |
| clean.backup.n | 1 | 1 | 1 |
| clean.backup.ok | 1 | 1 | 1 |
| clean.decisions | 3 | 3 | 3 |
| clean.health.n | 1 | 1 | 1 |
| clean.health.ok | 1 | 0.75 | 0.75 |
| clean.latencyMs | 0 | 86.2 | 70.6 |
| clean.leave.n | 1 | 1 | 1 |
| clean.leave.ok | 1 | 1 | 1 |
| clean.quality.n | 1 | 1 | 1 |
| clean.quality.ok | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – |
| clean.wrong | 0 | 0.2 | 0.2 |

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
