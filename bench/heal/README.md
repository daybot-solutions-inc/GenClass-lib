# bench/heal: does GenClass make web apps heal at runtime?

A local, reproducible benchmark for `@genclass/runtime` with the shipped model (`@genclass/runtime-model@0.2.0`,
r17-v2dT, gain gate, profiles cautious / balanced / eager). It measures, per mode (off, observe, guard, heal):

- **bugs** the user would see (stale data, lost edits, duplicate orders, wrong charges...), scored by test oracles
  that read only the DOM and the server's truth, never GenClass;
- **fixed / introduced** bugs, paired per seed against `off` (the app with GenClass not acting);
- **false interventions**: any non-passive action GenClass ran on a clean run, where the app is correct;
- **false findings**: detections (reported problems) on clean runs;
- **latency** the user feels (clean runs) and model decision latency.

Everything runs on this machine. Nothing is published, pushed or deployed.

- **Telemetry is off in every run**: the demos pass `telemetry: false` in every mode
  (`demos/src/shared/genclass.ts`); the Troy harness forces `telemetry: false` through `window.GENCLASS_CONFIG`; and
  both harnesses abort every request to a host other than `127.0.0.1` and print the blocked origins (expected:
  none). The model and ONNX Runtime's wasm are served from a local directory.
- **Small samples.** 10 chaos + 5 clean seeds per demo and mode (demos) and 3 repetitions per scenario and mode
  (Troy) fit an overnight budget. Wilson intervals on 10 trials are about ±30 points: read single-digit differences
  as noise unless they repeat across seeds and runs.

## Setup

```sh
# runtime build (the demos bundle packages/runtime/dist)
(cd packages/runtime && npx tsup)
# local model + ORT wasm, once (or copy an existing fetch-model directory)
node packages/runtime/bin/genclass-runtime.mjs fetch-model .cache-model/runtime-model-0.2.0 --variant q8 --ort wasm
```

`.cache-model/` and `bench/heal/.dist/` are git-ignored.

## 1. The six demos (`demos/`)

`demos/` holds six small apps with deliberate, realistic latent bugs that show under network chaos (search
typeahead without ordering guard, notes autosave, cart and checkout, status dashboard, kanban board over SSE,
decisions journal); see [docs/agents/demos.md](../../docs/agents/demos.md). The Playwright harness
(`demos/e2e/eval.ts`) runs each seeded scenario with real keyboard and mouse input in a fresh page, with common
random numbers so every mode sees the same network draws.

Changes made for this benchmark (harness only; the apps are untouched):

- `demos/src/server/data/cities.ts` recreated (synthetic populations, real city names; exports `searchCities`,
  `TYPED_TARGETS`, as the code imports) and un-ignored (`.gitignore` negation `!demos/src/server/data/`).
- An **`observe` demo mode** (the runtime's default: model loaded, reports only) next to off / guard / heal.
- `telemetry: false` in every mode; `?aggr=` (aggressiveness profile) and `?ort=` (self-hosted ORT wasm) URL knobs;
  `eval.ts --aggr`, `--dist <dir>` (serve a fixed snapshot build), external requests blocked.
- Metrics: `falseFindings` (detections on clean trials), findings per chaos trial, per-trigger decision counts and
  per-decision gate gains (`gc.gates`: trigger, diagnosis, candidate, gain / margin, ran).
- The demos build against **this checkout's** runtime (`demos/vite.config.ts` aliases, `demos/tsconfig.json` paths),
  not whatever `node_modules/@genclass/runtime` links to.

Run:

```sh
bench/heal/snapshot-demos.sh baseline          # build the demos against the current runtime into .dist/baseline
bench/heal/run-demos.sh <tag> --dist bench/heal/.dist/baseline [--aggr eager] [--modes off,observe,guard,heal]
# N=10 CLEAN=5 WORKERS=5 by default; results: bench/heal/results/demos/results-<tag>.{json,md}
```

## 2. Troy (`~/troy-bot-genclass`, branch `dev/genclass`)

The troy.daybot.ca dev copy with GenClass `0.1.0-beta.4` installed. Its order state lives in React `useState`
(GenClass sees only the network). `troy/troy-bench.mjs` drives the production build in mobile Chromium and injects
faults with Playwright route interception:

| scenario | kind | what happens | bug when |
|---|---|---|---|
| `add-once` | clean | add one dish from the menu | server quantity ≠ 1, chip never updates |
| `add-two` | clean | add two different dishes | quantities ≠ 1 + 1, chip ≠ 2 |
| `order-remove` | clean | `/order` with two lines, remove one, ticket polls every 5 s | ticket ≠ server, removed line shown again ≥ 400 ms |
| `add-lost-commit` | fault | the add commits but the answer is lost (502); the guest taps Add again | **duplicate order** (qty 2), lost order, chip ≠ server |
| `add-transient-5xx` | fault | the add fails with 503 before the server handles it; the guest taps again | qty ≠ 1 |
| `add-slow-doubletap` | fault | the add takes 2.5 s; the guest double-taps | qty ≠ 1 |
| `order-poll-reorder` | fault | a ticket poll is answered 3 s late, after the removal's answer (out of order) | **stale ticket** shown, ticket ≠ server |
| `order-remove-5xx` | fault | the removal fails once with 503; the guest taps × again | ticket ≠ server, server ≠ 1 line |
| `slow-all` | fault | every order API answer is 900 ms slow; add two dishes | quantities, chip |

Server truth is read through the browser context's own request API (same visitor cookie, invisible to the page).

```sh
cd ~/troy-bot-genclass && NEXT_PUBLIC_GENCLASS_DEBUG=1 pnpm --filter web build
cd apps/web && npx next start -H 127.0.0.1 -p 3000 &
node bench/heal/troy/troy-bench.mjs --reps 3 --workers 2 --out bench/heal/results/troy/<tag>.json [--aggr eager]
```

To measure this checkout's runtime in Troy without touching its tracked files: `troy/swap-runtime.sh use` moves
the installed package's `dist/` aside (`dist.orig`), copies `packages/runtime/dist` in and rebuilds Troy;
`troy/swap-runtime.sh restore` puts the original back and rebuilds. Restart `next start` after either. The harness
also takes `--config '<json>'` (extra `GenClass.init` options, e.g. `{"policy":{"idempotencyBodyFields":["request_id"]}}`)
and `--browse <ms>` (reading time after each page load, default 2500: decisions before the model is loaded fail open).
`troy/summarize-troy.mjs <results.json>` prints the table.

## Results

See [../../NIGHT-REPORT.md](../../NIGHT-REPORT.md) for the baseline and final tables and what changed.
