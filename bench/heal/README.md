# bench/heal: does GenClass make web apps heal at runtime?

A local, reproducible benchmark for `@genclass/runtime` with the shipped model (`@genclass/runtime-model@0.2.0`,
r17-v2dT, gain gate, profiles cautious / balanced / eager). It measures, per mode (off, observe, guard, heal):

- **bugs** the user would see (stale data, lost edits, duplicate orders, wrong charges...), scored by test oracles
  that read only the DOM and the server's truth, never GenClass;
- **fixed / introduced** bugs, paired per seed against `off` (the app with GenClass not acting);
- **false interventions**: any non-passive action GenClass ran on a clean run, where the app is correct;
- **false findings**: detections (reported problems) on clean runs;
- **latency** the user feels (clean runs) and model decision latency.

Everything runs on one machine. Nothing is published, pushed or deployed.

- **Telemetry is off in every run**: the demos pass `telemetry: false` in every mode
  (`demos/src/shared/genclass.ts`), and the harness aborts every request to a host other than `127.0.0.1` and
  prints the blocked origins (expected: none). The model and ONNX Runtime's wasm are served from a local directory.
- **Small samples.** 10 chaos + 5 clean seeds per demo and mode fit an overnight budget. Wilson intervals on 10
  trials are about ±30 points: read single-digit differences as noise unless they repeat across seeds and runs.

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
decisions journal); see [demos/README.md](../../demos/README.md). The Playwright harness
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

## 2. A pilot app (not in this repository)

The same measurements were taken on a pilot app: a production Next.js ordering site whose order state lives in
React `useState` (GenClass sees only the network), driven in mobile Chromium with Playwright route interception
injecting nine fault scenarios (lost commits with a re-tap, transient 5xx, slow double-taps, out-of-order polls).
The app and its harness are private; the results are summarised in
[docs/runtime/RESULTS.md](../../docs/runtime/RESULTS.md) §5.

## Results

`results/demos/` holds the demo runs (`results-<tag>.{json,md}` with a `-summary.json` each); the tables are in
[docs/runtime/RESULTS.md](../../docs/runtime/RESULTS.md) §5.

## 3. Automatic state discovery (2026-10-10)

- Demos without hand-registered stores: `GENCLASS_DISCOVER=1 DEMOS_OUT_DIR=bench/heal/.dist/discover npm run build`
  in `demos/` (aliases in `demos/vite.config.ts` to `discover/*.ts`; the app code is untouched), then
  `demos/e2e/eval.ts --dist ../bench/heal/.dist/discover/ ...`; `discover/summarize.mjs` compares runs.
- Results: `results/demos/results-discover-*.json`; summary in `docs/runtime/RESULTS.md` §5.
