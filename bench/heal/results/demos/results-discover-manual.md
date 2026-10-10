# GenClass Runtime demos: trial results

Generated 2026-10-10T03:14:48.055Z on the build VM. Runtime: **real** (@genclass/runtime 0.1.0-beta.4, dist c21a94ca2f92). Model: genclass-runtime-r17 on wasm q8, cross-origin isolated (WASM threads available).

Driver: Playwright with real keyboard and mouse input in headless Chromium (no GPU, WASM inference). 5 chaos trials and 3 clean trials per mode per demo; the same seeds run in every mode. Bug rate = share of chaos trials where the demo's own oracle found a bug. False interventions = non-passive actions GenClass took on clean runs, where the app behaves correctly; every one is a false positive.

| Demo | Mode | Chaos bug rate | Fixed/introduced vs Off | Clean bugs | False interventions (clean) | False findings (clean) | Findings / chaos trial | Actions / chaos trial | Actions run | User latency p50 (clean) | Decision p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Cart & checkout | off | 80% (4/5) | – | 0/3 | 0 in 0/3 | 0 in 0/3 | 0.00 | 0.00 | – | 191 ms | – |
| Cart & checkout | observe | 80% (4/5) | 0/0 | 0/3 | 0 in 0/3 | 0 in 0/3 | 1.80 | 0.00 | – | 196 ms | 142 ms |
| Cart & checkout | guard | 80% (4/5) | 0/0 | 0/3 | 0 in 0/3 | 0 in 0/3 | 2.00 | 0.00 | – | 208 ms | 139 ms |
| Team board | off | 80% (4/5) | – | 0/3 | 0 in 0/3 | 0 in 0/3 | 0.00 | 0.00 | – | 47 ms | – |
| Team board | observe | 60% (3/5) | 1/0 | 0/3 | 0 in 0/3 | 0 in 0/3 | 2.80 | 0.00 | – | 47 ms | 161 ms |
| Team board | guard | 80% (4/5) | 0/0 | 0/3 | 0 in 0/3 | 0 in 0/3 | 2.80 | 0.00 | – | 33 ms | 164 ms |
| Notes autosave | off | 100% (5/5) | – | 0/3 | 0 in 0/3 | 0 in 0/3 | 0.00 | 0.00 | – | 776 ms | – |
| Notes autosave | observe | 100% (5/5) | 0/0 | 0/3 | 0 in 0/3 | 0 in 0/3 | 4.20 | 0.00 | – | 793 ms | 148 ms |
| Notes autosave | guard | 100% (5/5) | 0/0 | 0/3 | 0 in 0/3 | 0 in 0/3 | 4.00 | 0.00 | – | 790 ms | 150 ms |

## Cart & checkout (`checkout`)

- **off**: bug rate 80% (4/5, 95% CI 38%–96%) under chaos; 0% (0/3) on clean runs. False interventions on clean runs: **0** (in 0/3 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 191 ms clean, 513 ms chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 80% (4/5, 95% CI 38%–96%) under chaos; 0% (0/3) on clean runs. False interventions on clean runs: **0** (in 0/3 runs). Paired with Off: fixed 0, introduced 0 of 5. Interventions per chaos trial 0.00; decisions per trial 2.9; detections per trial 1.1; model decision latency p50 142 ms, p95 240 ms; user-visible latency p50 196 ms clean, 411 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×7.
- **guard**: bug rate 80% (4/5, 95% CI 38%–96%) under chaos; 0% (0/3) on clean runs. False interventions on clean runs: **0** (in 0/3 runs). Paired with Off: fixed 0, introduced 0 of 5. Interventions per chaos trial 0.00; decisions per trial 2.5; detections per trial 1.3; model decision latency p50 139 ms, p95 239 ms; user-visible latency p50 208 ms clean, 515 ms chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×1, gain # of coalesce over send is not above the guard margin # ×3, gain # of discard over apply is not above the guard margin # ×2.

| metric (mean) | off | observe | guard |
|---|---|---|---|
| chaos.driftMs | 2464 | 2422 | 2459 |
| chaos.duplicates | 0.4 | 0.4 | 0.4 |
| chaos.errorsShown | 0 | 0 | 0 |
| chaos.latencyMs | 1245 | 1192 | 1242 |
| chaos.maxDriftMs | 2464 | 2422 | 2459 |
| chaos.ordersCreated | 1.2 | 1.2 | 1.2 |
| chaos.untilTimeouts | 2 | 2 | 2 |
| chaos.wrongCharges | 1.2 | 1.2 | 1.2 |
| clean.driftMs | 0 | 0 | 0 |
| clean.duplicates | 0 | 0 | 0 |
| clean.errorsShown | 0 | 0 | 0 |
| clean.latencyMs | 195 | 201 | 206 |
| clean.maxDriftMs | 0 | 0 | 0 |
| clean.ordersCreated | 1 | 1 | 1 |
| clean.untilTimeouts | – | – | – |
| clean.wrongCharges | 0 | 0 | 0 |

Most common bugs with GenClass Off:
- displayed total ≠ sum of the lines for # s (×4)
- # orders created for # intended (×2)
- charged $#, $# for items worth a different amount (×2)
- charged $# for items worth a different amount (×2)

## Team board (`board`)

- **off**: bug rate 80% (4/5, 95% CI 38%–96%) under chaos; 0% (0/3) on clean runs. False interventions on clean runs: **0** (in 0/3 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 47 ms clean, 417 ms chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 60% (3/5, 95% CI 23%–88%) under chaos; 0% (0/3) on clean runs. False interventions on clean runs: **0** (in 0/3 runs). Paired with Off: fixed 1, introduced 0 of 5. Interventions per chaos trial 0.00; decisions per trial 9.5; detections per trial 1.8; model decision latency p50 161 ms, p95 331 ms; user-visible latency p50 47 ms clean, 498 ms chaos. Actions: none. Chosen but not run: observe mode never changes execution ×23.
- **guard**: bug rate 80% (4/5, 95% CI 38%–96%) under chaos; 0% (0/3) on clean runs. False interventions on clean runs: **0** (in 0/3 runs). Paired with Off: fixed 0, introduced 0 of 5. Interventions per chaos trial 0.00; decisions per trial 9.1; detections per trial 1.8; model decision latency p50 164 ms, p95 342 ms; user-visible latency p50 33 ms clean, 37 ms chaos. Actions: none. Chosen but not run: gain # of discard over apply is not above the guard margin # ×15, gain # of coalesce over send is not above the guard margin # ×2, gain # of discard over deliver is not above the guard margin # ×6.

| metric (mean) | off | observe | guard |
|---|---|---|---|
| chaos.divergedMs | 4562 | 4707 | 6428 |
| chaos.finalMismatches | 0.6 | 0.6 | 1 |
| chaos.jumpBacks | 4.6 | 4.4 | 4.6 |
| chaos.latencyMs | 417 | 498 | 37 |
| chaos.maxDivergedMs | 4222 | 4397 | 6148 |
| chaos.teammateMoves | 5 | 5 | 5 |
| chaos.userMoves | 11.2 | 11.2 | 11.2 |
| clean.divergedMs | 0 | 0 | 0 |
| clean.finalMismatches | 0 | 0 | 0 |
| clean.jumpBacks | 0.33 | 0 | 0.67 |
| clean.latencyMs | 526 | 348 | 25.67 |
| clean.maxDivergedMs | 0 | 0 | 0 |
| clean.teammateMoves | 0.33 | 0.33 | 0.33 |
| clean.userMoves | 5.67 | 5.67 | 5.67 |

Most common bugs with GenClass Off:
- # card in the wrong column at the end (c#) (×3)
- board disagreed with the server for # s (×1)
- # card stuck “syncing” (×1)

## Notes autosave (`editor`)

- **off**: bug rate 100% (5/5, 95% CI 57%–100%) under chaos; 0% (0/3) on clean runs. False interventions on clean runs: **0** (in 0/3 runs). Interventions per chaos trial 0.00; decisions per trial 0.0; detections per trial 0.0; model decision latency p50 –, p95 –; user-visible latency p50 776 ms clean, 2.46 s chaos. Actions: none. Chosen but not run: none.
- **observe**: bug rate 100% (5/5, 95% CI 57%–100%) under chaos; 0% (0/3) on clean runs. False interventions on clean runs: **0** (in 0/3 runs). Paired with Off: fixed 0, introduced 0 of 5. Interventions per chaos trial 0.00; decisions per trial 6.3; detections per trial 2.6; model decision latency p50 148 ms, p95 252 ms; user-visible latency p50 793 ms clean, 2.46 s chaos. Actions: none. Chosen but not run: observe mode never changes execution ×26.
- **guard**: bug rate 100% (5/5, 95% CI 57%–100%) under chaos; 0% (0/3) on clean runs. False interventions on clean runs: **0** (in 0/3 runs). Paired with Off: fixed 0, introduced 0 of 5. Interventions per chaos trial 0.00; decisions per trial 6.6; detections per trial 2.5; model decision latency p50 150 ms, p95 286 ms; user-visible latency p50 790 ms clean, 2.18 s chaos. Actions: none. Chosen but not run: guard mode does not allow heal-tier actions ×1, gain # of discard over deliver is not above the guard margin # ×16, gain # of discard over apply is not above the guard margin # ×4, gain # of coalesce over send is not above the guard margin # ×5.

| metric (mean) | off | observe | guard |
|---|---|---|---|
| chaos.finalLie | 0.2 | 0.2 | 0.2 |
| chaos.latencyMs | 2715 | 2710 | 2504 |
| chaos.lieMs | 12169 | 12231 | 12134 |
| chaos.lostLocal | 1 | 1 | 1 |
| chaos.lostServer | 0.2 | 0.2 | 0.2 |
| chaos.maxLieMs | 11738 | 11745 | 11728 |
| chaos.reverts | 1.6 | 1.6 | 1.6 |
| chaos.saves | 7.2 | 7.2 | 7.2 |
| clean.finalLie | 0 | 0 | 0 |
| clean.latencyMs | 784 | 793 | 797 |
| clean.lieMs | 0 | 0 | 0 |
| clean.lostLocal | 0 | 0 | 0 |
| clean.lostServer | 0 | 0 | 0 |
| clean.maxLieMs | 0 | 0 | 0 |
| clean.reverts | 0 | 0 | 0 |
| clean.saves | 13.67 | 13.67 | 13.67 |

Most common bugs with GenClass Off:
- the editor lost text the user typed (×5)
- the server copy differs from the editor (×1)
- “Saved” shown while the server holds older text (×1)

## How to reproduce

```bash
scripts/vm.sh run demos 'setsid nohup bash demos/scripts/vm-eval.sh > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
# or, on any machine: npm install && npm run build -w @genclass/runtime && cd demos && npm run fetch-model && npm run build && npm run eval
```
