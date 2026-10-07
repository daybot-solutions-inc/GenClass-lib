# GenClass Runtime demos

Six small apps, each written the way real apps are (latent bugs included), running against a mock API that you can
make slow, flaky or down. Each page can switch GenClass between **Off**, **Guard** and **Heal**, shows what GenClass
observed and changed, and can run scripted trials that its own oracle scores. A Playwright script runs the same
trials headless with real keyboard and mouse input and writes `results.json` / `results.md`.

| demo | app | failure it is about | stack |
|---|---|---|---|
| `search/` | city typeahead | out-of-order responses (older answer lands last) | vanilla TS, `gc.atom` |
| `editor/` | notes with autosave | overlapping saves, echoes of older versions, a "Saved" badge that lies | vanilla TS, Redux + `genclassEnhancer` |
| `checkout/` | cart and checkout | double submit, retry after timeout, totals drifting after partial failures | React 19, `useGenClassState` (cart has a `resync`) |
| `status/` | service status dashboard | failure streaks, latency spikes, retry storms, false alarms | vanilla TS, `gc.guard` over the app's own store |
| `board/` | kanban with live events | out-of-order live events, conflicting moves, stale rollbacks | React 19, Zustand + `genclass` middleware |
| `decisions/` | field journal | the app asks GenClass (`ask` noul/score, `decide`) when to back up, which image quality to load, whether leaving loses work, how healthy the connection is; plus a custom plugin | vanilla TS, plugin with its own observer, facts and action |

## Run it

The Mac in this repo only edits files; builds, browsers and models run on the `train` VM (`scripts/vm.sh`, slot
`demos`). Everything below works on any machine with Node 22.

```bash
# from the repo root
npm install
npm run build -w @genclass/runtime          # the demos import the real runtime from packages/runtime/dist
cd demos
npm run fetch-model                         # v0.1 GenClass model into public/genclass-model/ (gitignored)
npm run dev                                 # http://localhost:5173/
npm run build                               # static site in dist/ (relative paths, any sub-path)
npm run preview                             # serves dist/ at http://127.0.0.1:4173/genclass/
npm run eval                                # 30 chaos + 15 clean trials per mode per demo, then screenshots
npm run eval:fast                           # 4 + 2 trials, for a quick check
```

On the VM the whole pipeline is one script (the model directory is kept outside the synced tree, because
`scripts/vm.sh` mirrors the repo with `rsync --delete`):

```bash
scripts/vm.sh run demos 'setsid nohup bash demos/scripts/vm-eval.sh --fast > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
scripts/vm.sh exec demos 'tail -f ~/gcl/logs/demos-eval.log'
scripts/vm.sh get demos demos/screenshots demos/      # then look at them
```

`e2e/eval.ts` options: `--fast`, `--n 30` (chaos trials per mode), `--clean 15`, `--demos search,editor`,
`--modes off,guard,heal`, `--workers 8`, `--model <url>|cdn`, `--model-dir <dir>`, `--tag <name>` (write
`results-<name>.*` instead of replacing `results.*`), `--budget <ms>` (experiment: `policy.holdBudgetMs`),
`--no-shots`, `--shots-only`, `--no-trials-ui`, `--seed-base 1000`. `vm-eval.sh` takes the model from
`GENCLASS_MODEL_FROM` / `GENCLASS_MODEL_DIR` / `GENCLASS_MODEL_URL` (see the script header) and refuses to measure
when `packages/runtime` does not build.

If `packages/runtime/dist` does not exist, Vite aliases a tiny observe-only stand-in (`src/dev/runtime-shim/`, or
force it with `GENCLASS_SHIM=1`) so the apps and harness can be developed; results say `runtime: shim` and only
count as the no-GenClass baseline.

### URL parameters

| parameter | effect |
|---|---|
| `?mode=off\|guard\|heal` | the demo's mode switch (also remembered in localStorage) |
| `?model=<url>` | model directory (default `<site>/genclass-model/`, or `VITE_GENCLASS_MODEL_URL` at build time); `cdn` = the runtime's default CDN |
| `?devtools=open` | start the runtime's devtools overlay open (Alt+Shift+G toggles it) |
| `?coi=0` | do not make the page cross-origin isolated (see below) |
| `?genclass=off\|observe\|guard\|heal` | the runtime's own kill switch / mode override (handled by the runtime, not the demo) |
| `?embed=trial&mode=…&kind=chaos\|clean&seed=…` | a bare trial page (what the trial runner and Playwright load) |

## How the pieces fit

**GenClass modes.** App code is identical in every mode; only the init differs (`src/shared/genclass.ts`):
Off = `GenClass.init({ mode: "observe", model: false })` (installed, observes, never decides or changes anything:
the baseline), Guard = `GenClass.init({ mode: "guard", model: { baseUrl } })`, Heal = the same with `"heal"`.

**Mock server** (`src/server/`). A Service Worker answers `<site>/api/*` with real `fetch` responses and a real
`EventSource` stream, so the apps and GenClass see ordinary network traffic. Each page and each trial iframe gets its
own server session ("world"), bound to its Service Worker client id. Chaos (`src/shared/chaos.ts`): latency median and
jitter (log-normal), 5xx before handling (no side effects), lost responses after the server committed (502/504),
hangs, slowdown spikes, reordering pressure (requests and live events overtake each other), outage and offline, per
route if needed. The page controls the server only through `postMessage` (chaos, server truth, request log), never
through `fetch`, so GenClass never sees test traffic. The worker also adds COOP/COEP headers to our documents and
workers so pages are cross-origin isolated, which lets the model use WASM threads (`?coi=0` turns it off; the first
visit reloads once to get there).

**Pages** (`src/site/`). The demo page shows the app in a window frame with a live server log underneath, the mode
switch and model status, an Activity panel that mirrors every GenClass report line (`gc.on("report")`) with its
evidence (`gc.explain(id)`), an Undo button for reversible actions and a banner over the app whenever GenClass
changes something, chaos controls, an explanation of what can go wrong and how the app is wired, and the trial
runner. The runtime's own devtools overlay (`mountDevtools`) sits in the corner.

## Trials and oracles

A trial is a seeded scenario (`src/demos/<demo>/scenario.ts`): a list of steps (type with human rhythm and typos,
press keys, click, double-click, wait, wait-until, change chaos mid-session, trigger server events such as a
teammate moving a card or an incident), the chaos for the session, server parameters, and what the user intends.

- **chaos** trials: randomized environment chaos and stressed user behaviour (fast typing, double clicks, impatient
  re-clicks, quick re-moves);
- **clean** trials: no chaos (45 ± 15 ms, no failures) and a calm user; the apps behave correctly there, so any
  non-passive action GenClass takes is counted as a **false intervention**.

Every seed runs in all three modes. Each run is a fresh page (fresh runtime, fresh server session). The in-page
"Run trials" button runs them in iframes with synthetic DOM events; `e2e/eval.ts` runs them in fresh tabs with real
Playwright input. After the steps, the server's scripted activity is frozen, the harness waits for the network to go
quiet and the demo's oracle (`src/demos/<demo>/oracle.ts`, test code only; never passed to GenClass) scores what the
user saw against the server's truth:

| demo | a trial is a bug when | user-visible latency metric |
|---|---|---|
| search | the final list is not the results for the final query, or the list showed another query's results for ≥ 400 ms after the current query's answer had arrived (+350 ms grace for rendering or a held write) | last keystroke → correct list, stays correct |
| editor | the editor text differs from what the user typed, the server copy differs from the editor, "Saved" is shown while the server holds older text at the end, or "Saved" was untrue for > 1.5 s | last keystroke → "Saved" and true |
| checkout | more orders than intended, "Order placed" without an order, told it failed but it was placed, still "Placing…", an order charged a total that is not the sum of its lines, displayed total ≠ sum of displayed lines (at the end or for > 1 s), cart on screen ≠ server cart | first "Place order" click → confirmation |
| status | healthy services shown as failing for > 1.5 s, a real outage missed for > 1.5 s, another wrong status for > 3 s (3.5 s grace to notice a change), any error banner, or > 1.5× the requests of a steady poll | true status change → card shows it |
| board | any card in the wrong column once everything settles, the board disagreeing with the server for > 2 s (1.5 s window), or a card stuck "syncing" | last move → board equals server |
| decisions | any decision differs from the ground truth recomputed at the moment it was asked: backup now only if the user has not typed for 2.5 s, no save is in flight, no request failed in 8 s and the median latency is < 600 ms; quality thumbnails at ≥ 25% failures, reduced at median ≥ 450 ms, else full; "would leaving lose work" = editor text ≠ server copy or a save in flight; connection health level within ±1 of the level from recent failures and latency | time to answer a question |

## Latest results (v0.1 model, 2026-10-07)

810 trials on the `train` VM: 6 demos × Off/Guard/Heal × (30 chaos + 15 clean), Playwright with real input, the
v0.1 GenClass model (q8, WASM, pages cross-origin isolated). Full tables: [`results.md`](results.md).

| demo | bug rate Off | Guard | Heal | false interventions (clean) Guard / Heal | user latency p50 (clean) Off / Guard | model decision p50 |
|---|---|---|---|---|---|---|
| search | 13% (4/30) | 13% | 13% | 0 / 0 | 14 ms / 125 ms | 481 ms |
| editor | 83% (25/30) | 83% | 87% | 0 / 0 | 779 ms / 775 ms | 333 ms |
| checkout | 83% (25/30) | 90% | 90% | 0 / 0 | 205 ms / 204 ms | 363 ms |
| status | 100% (30/30) | 93% | 100% | 0 / 0 | 1.33 s / 1.26 s | 1.20 s |
| board | 50% (15/30) | 77% | 73% | 0 / 0 | 19 ms / 31 ms | 346 ms |
| decisions | 83% (25/30) | 90% | 93% | 0 / 0 | – | 308 ms |

What this says, plainly:

- The apps' latent bugs are real and only show under chaos: with GenClass Off every demo is bug-free on clean runs
  and fails often under chaos (lost edits, duplicate orders and wrong charges, false alarms and retry storms, a board
  that drifts from the server, wrong default decisions).
- With the v0.1 model (a general classifier, not trained for runtime decisions) GenClass did not prevent these bugs.
  It took no false interventions on clean runs, but mostly because its decisions did not clear the confidence
  thresholds (958 times) or arrived after the 300 ms hold budget (663 times); Guard executed nothing. Heal ran 92
  actions (30 retries, 62 blocks, 60 of them of a heartbeat request) and did not lower any bug rate. The one
  improvement (status under Guard, 100% → 93%) came without any executed action: requests held while the model
  thinks space out the app's immediate retries, so fewer of them land inside an outage.
- Holding writes has costs even when nothing is executed: the search list appears ~110 ms later on clean runs, and
  on the board Guard turned 9 clean seeds into bugs (likely a held write applied after a newer user write; see
  [`NEEDS.md`](NEEDS.md) §1). The default redaction also hides the board's `cards` from the model (§2).
- Developer questions (`ask`/`decide`) are answered by the model in ~0.3 s; accuracy under chaos went from 0.42 (app
  defaults) to 0.62, but on clean runs from 1.00 to 0.27: v0.1 answers as if something were always wrong.

These are the numbers to beat with the runtime-specialist model. To re-run with it:

```bash
# a model release directory (downloaded with the runtime CLI, served locally):
scripts/vm.sh run demos 'GENCLASS_MODEL_FROM=https://…/runtime-model-v0.1.0/ setsid nohup bash demos/scripts/vm-eval.sh --tag runtime-v0.1 > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
# or a URL the pages fetch directly (must send CORS headers):
scripts/vm.sh run demos 'GENCLASS_MODEL_URL=https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/ setsid nohup bash demos/scripts/vm-eval.sh > ~/gcl/logs/demos-eval.log 2>&1 < /dev/null &'
```

`--tag` writes `results-<tag>.json/.md` (not shipped with the site); without it the run replaces `results.json`,
`results.md` and the landing page's numbers. The model card actually served (name, version, file hashes) is
recorded in `results.json` under `model.card`. In a browser, `?model=<url>` points any page at another model.

## Reading the results

`results.md` has one summary table and a section per demo; `results.json` has the same summaries plus every raw
trial (`raw[]`: oracle verdict, reasons, metrics, and GenClass stats: model status, isolation, decisions,
detections, interventions with what they changed, decisions that were not executed and why, decision latencies).

- **Bug rate**: share of chaos trials with a bug, with a 95% Wilson interval. Clean-run bug rate is reported too.
- **False interventions**: non-passive actions on clean runs, and in how many clean runs they happened.
- **Fixed / introduced**: paired with Off on the same seed. Timing is not deterministic in a real browser, so a
  pair can differ by chance; read these together with the Off-vs-Off noise you see across seeds.
- **Latency**: the demo's user-visible metric (table above), median over clean runs, per mode. The difference to
  Off is what GenClass adds (holding a write while it waits for a decision costs time).
- **Model decision p50**: how long the runtime waited for the model. Writes and requests are held for at most
  `holdBudgetMs` (300 ms); a decision that arrives later runs the passive action ("arrived after the hold budget").

The v0.1 GenClass model is a general classifier, not trained for runtime situations; with it these demos measure
the runtime, the integration and the harness. `NEEDS.md` lists what the demos need from the runtime.

## Honesty rules the demos follow

- No hints for GenClass beyond a normal integration: stores created through the runtime or its adapters, `resync`
  handlers where the app already has a loader (cart, board, status), and, only in the decisions demo, a custom
  plugin and questions. Store names, routes and copy are what the apps would use anyway.
- The apps keep their latent bugs; nothing is tuned for GenClass. Oracles live in test code and only read the DOM
  and the mock server's truth.
- The demos were written without reading the training-data generator (`sim/`).

## Files

```
index.html, <demo>/index.html     pages (Vite multi-page, relative base)
src/site/                         landing page, demo page shell, activity panel, chaos panel, server log, trial runner
src/shared/                       settings, GenClass init, server link, scenario kit, driver, harness, aggregation
src/server/                       Service Worker mock server: core (sessions, chaos, streams, log) and one world per demo
src/demos/<demo>/                 app, scenario, oracle, styles, entry
src/dev/runtime-shim/             development stand-in for @genclass/runtime
e2e/eval.ts, e2e/serve.ts         headless evaluation and static server
scripts/build.mjs                 site + Service Worker build
scripts/fetch-model.sh            model download (runtime CLI, curl fallback)
scripts/vm-eval.sh                full VM pipeline
screenshots/                      captured by the eval (light, dark, full page, mobile, heal mode, trial runner)
results.json, results.md          latest measurements (raw trials in results.json)
results-summary.json              the same without raw trials; shipped with the site for the landing page
NEEDS.md                          what the demos need from the runtime, with evidence
```
