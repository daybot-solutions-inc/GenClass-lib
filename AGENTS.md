# AGENTS.md

Guide for coding agents working in GenClass-lib. The code is the source of truth; `docs/runtime/CONTRACT.md` is binding.

## What this repo is

`@genclass/runtime` (`packages/runtime/`) is a browser library that observes a web app (fetch/XHR/WebSocket/
EventSource, user actions, timers, stores, errors, causality), computes generic facts, and for salient situations
asks a small local ONNX model (`packages/runtime-model/`, a Web Worker on WebGPU or WASM) for a diagnosis and an
action. Decisions happen at the network boundary (the `delivery` trigger); store writes are never held by default.
Default mode is `observe` (report only); `guard` is opt-in; `heal` is experimental. Without a model it only observes.

## Repo map

| path | what |
|---|---|
| `packages/runtime/` | the library: `src/` (incl. `auto.ts`, `cdn/`, `situation/`, `decide/`, `model/`, `devtools/`), `test/` (vitest; `test/install/`, `test/browser/`), `bin/` (CLI: `init`, `remove`, `fetch-model`, `info`), `CHANGELOG.md`, `TELEMETRY.md`, `INTERCEPTION.md` |
| `packages/runtime-model/` | the data-only model package (`files/` is gitignored, filled at release) and `MODEL_CARD.md` |
| `sim/` | deterministic training-data simulator driving the real runtime (`SEPARABILITY.md`, `README.md`) |
| `realapps/` | 128 real apps run in headless Chromium with the real runtime: training rows and the never-worse sweep |
| `training/` | vocabulary pruning, curriculum (`curriculum/rt.py` mirrors the runtime's situation renderer), Azure training, ONNX export, `EVAL.md` |
| `demos/` | six demo apps with a chaos backend and Playwright trials; `bench/heal/` runs them per mode |
| `compat/`, `templates/` | framework compatibility matrix (`RESULTS.md`) and starter templates; evaluation only |
| `site/`, `telemetry-worker/` | genclass.dev and the diagnostics collector (Cloudflare Workers) |
| `research/` | earlier Jev research: extension, `jev_local` (Python encoder the training scripts import), benchmarks |
| `docs/runtime/` | `CONTRACT.md` (binding), `API.md`, `ARCHITECTURE.md`, `OPTIONS-SPEC.md`, `THREAT-MODEL.md`, **`RESULTS.md`** (every measured number) |
| `scripts/` | Azure VM helpers (`vm.sh`, `azvm.sh`, `launch_run.sh`); `internal/` is gitignored working notes |

## Build and test

Node ≥ 20. CI (`.github/workflows/ci.yml`, Node 22) runs, in order:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run typecheck -w @genclass/runtime        # tsc on src/ only; tests are never type-checked
npm run build -w @genclass/runtime            # tsup: ESM entries, the script-tag IIFE, the CDN worker
cd packages/runtime
NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts
NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts --retry=2   # timing budgets; reported, not blocking
```

One test: `npx vitest run test/delivery.test.ts -t "<name>"`. The 14 skipped tests are model-parity tests that need
`GENCLASS_MODEL_DIR`. Not in CI, ask before running: Playwright (`npm run test:browser`), `test/smoke/smoke.sh`, the
install suite (`test/install/run-all.sh`), the sim and realapps generators, the demos' eval, training, anything on
Azure, `git push`, `npm publish`.

## Hard rules

1. **Never make a correct app worse.** Observe never holds, delays or changes anything. An action runs only when the
   policy gate (`src/decide/policy.ts`) clears and the top diagnosis is not `expected`; model missing, late or
   erroring means the passive action. Report FIR (false interventions on clean runs) next to every recall number.
2. **No hardcoded bug patterns.** The runtime computes facts and triages (`runtime.ts` → `trigger`); it never maps a
   fact pattern to a diagnosis or action with an if/then. `situation/build.ts` → `builtinApplicable` only says
   whether an action *can* run.
3. **Model-visible text is frozen** (tag `situation-v2.3`). Any change to `src/situation/*`, facts, question, action
   or diagnosis wording, `util.ts` formatting/redaction, op or event names means a new tag, regenerated data, an
   `rt.py` mirror and retraining. Do not make such a change without an explicit go-ahead; exact-text tests exist.
4. **`sim/` and `demos/` authors never read each other's code.** `sim/` and `realapps/` never read or model `demos/`
   or `compat/`; demos and compat apps are never tuned to the model and contain nothing beyond a normal integration.
5. **Determinism.** Runtime code uses the injected `Clock` (`src/clock.ts`); never `Math.random`, `Date.now`,
   `performance.now` or the global `setTimeout`. IDs come from counters. Same inputs give byte-identical situations.
6. **`test/review-*.test.ts` are a contract.** Fix `src/`, never the test.
7. **Dependencies.** `onnxruntime-web` is the only runtime dependency; ask before adding one. Keep the committed root
   `package-lock.json` in sync. TypeScript strict, ESM only, `src/` uses no Node APIs (`types: []`).
8. **Telemetry** stays disclosed (console notice, `TELEMETRY.md`, both READMEs, CHANGELOG), sends no page text
   unless the app opts in, keeps every opt-out (`telemetry: false`, `?genclass=no-telemetry`, localStorage, GPC) and
   never feeds a decision. Widening what is sent needs the owner's OK.
9. **Publish only through the release workflow** (`.github/workflows/release.yml`) on a `v*` tag whose version
   equals `packages/runtime/package.json`. Never `npm publish` by hand. Never push without being asked.

## Conventions and definition of done

- Modules open with a `//` header stating role and invariants; JSDoc on exports; named exports; relative imports
  with `.js`; 2 spaces, double quotes. Never throw into the host app: hooks and callbacks run in `try/catch`.
- Tests: one `<area>.test.ts` per area; `test/helpers.ts` → `setup()` gives a fake clock, server and scripted decider
  (default `mode: "guard"`; pass `mode: undefined` for observe). Name the CONTRACT section in the `describe`.
- Done means: `tsc` clean, `tsup` builds, both vitest steps pass with new tests, no review test edited, no
  model-visible text changed; public-surface changes update `docs/runtime/API.md`, the JSDoc in `src/types.ts` and
  `packages/runtime/CHANGELOG.md`; new numbers go to `docs/runtime/RESULTS.md` with the FIR next to the recall; say
  which checks you could not run and why.
