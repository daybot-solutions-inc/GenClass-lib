# GenClass Runtime

[![npm](https://img.shields.io/npm/v/@genclass/runtime/latest?label=%40genclass%2Fruntime)](https://www.npmjs.com/package/@genclass/runtime)
[![CI](https://github.com/daybot-solutions-inc/GenClass-lib/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**A runtime for web apps. It watches the app from the inside and uses a small local model to flag, and optionally
prevent, stale responses, races, duplicate requests, inconsistent state and failure storms.**

```bash
npm install @genclass/runtime
```

```ts
import { GenClass } from "@genclass/runtime";

GenClass.init(); // observe mode by default: reports only; pass { mode: "guard" } to let it act
```

GenClass Runtime records what the app does: user actions, async operations and their causal chains, network
traffic (fetch, XHR, WebSocket, EventSource), store writes with per-field versions, errors and timing. It computes
generic facts about each write, request and response, and asks a small GenClass model only about salient situations.
The model runs in the browser (WebGPU or WASM, in a Web Worker). It answers two questions: what is happening, and
which available action is best. There is no list of known bugs in the code.

> **Status: alpha. The runtime is built; its model is still in training.**
>
> - **Runtime:** works and is unit-tested (situation format `situation-v2`, tag `situation-v2`).
> - **Default mode** is `observe`. `guard` is opt-in; `heal` is experimental.
> - **No model is published for this format yet.** `@genclass/runtime-model` is not on npm, so a default
>   `GenClass.init()` prints `[GenClass] Model unavailable (...); observing only.` and finds nothing.
> - **Round 1 models** (format `situation-v1`) exist but do not match this runtime.
> - **`@genclass/runtime@0.1.0-alpha.0` on npm** is the older v1 runtime. It defaults to guard, holds store writes,
>   and has a `NaN` crash that has since been fixed.
>
> What's next: [OPEN_TASKS.md](OPEN_TASKS.md). Picking up the work: [HANDOFF.md](HANDOFF.md). AI coding agents:
> start at [AGENTS.md](AGENTS.md).

## How it works

1. **Observe.** Fetch, XHR, WebSocket, EventSource, DOM events, errors, navigation, storage, long tasks and timers
   are instrumented. Async work is linked into causal chains. Stores created through GenClass, or wrapped with its
   Redux, Zustand, React or generic adapters, get per-field versions and write histories.
2. **Learn.** The runtime learns per-operation baselines (latency, failure rate, request rate) and which fields each
   operation usually writes. It also learns cadences (polling, debounced saves) and relations that keep holding
   (`total == sum(items[*].price × qty)`, `selectedId ∈ items[*].id`).
3. **Triage.** Cheap facts are computed for every write and request. Only salient situations reach the model: a
   response landing over newer data, a repeated request, a failure streak, a broken relation, an error.
4. **Decide at the network boundary.** Responses and push messages are judged *before the app sees them*:
   - `deliver` (passive);
   - `discard` (deliver, but drop the writes it makes over newer data);
   - `defer` (wait for related in-flight work).

   Store writes are never held or reordered by default. Salient writes that no delivery decision covered are
   decided in the background, and can be reverted within 2 s under strict rules.
5. **Act by mode.**

   | mode | behaviour |
   |---|---|
   | `observe` (default) | reports only |
   | `guard` (opt-in) | `discard`, `defer`, `coalesce`, `delay`, only when the permitted actions' summed probability is ≥ 0.9 |
   | `heal` (experimental) | also `retry`, `serve_cached`, `block`, `hedge`, `rollback`, `resync` and custom actions (≥ 0.8) |

6. **Explain.**
   - Every detection and intervention is logged in plain English, with the exact situation text the model read.
   - Reversible actions can be undone.
   - `?genclass=off` installs nothing.

Full guide (modes, triggers, adapters, observability, performance, privacy, known limitations):
**[packages/runtime/README.md](packages/runtime/README.md)**. API: [docs/runtime/API.md](docs/runtime/API.md).

## Results so far

All numbers are on held-out data, with each recall reported next to its false-intervention rate (FIR). Source:
[docs/runtime/RESULTS.md](docs/runtime/RESULTS.md).

| what | result |
|---|---|
| Round 1 model, R17 (9.6 MB int8; **previous format** `situation-v1`), simulated apps | diagnosis 90.5%, action 81.9%, guard FIR 0.05%, heal FIR 0.24%, calibration error 0.009. Recall on clear stale/duplicate cases is only 7.7% (precise but timid). |
| Why round 1 was timid ([sim/SEPARABILITY.md](sim/SEPARABILITY.md)) | Many clear cases had benign twins with identical visible facts; 24% of clear rows were mislabelled `expected`; labels assumed knowledge a runtime cannot have. v2 adds measured facts and fixes the labels. |
| Round 2 (`situation-v2`, this runtime) | **in progress**: ~10M simulated gold rows, ~50M unlabeled rows for teacher labelling, ~0.5M rows from real apps in headless Chromium |
| Never make a correct app worse (always-passive model, heal vs observe, 66 real apps × 6 seeds) | 0/396 clean runs changed: final page text (inputs and alerts excluded) and server state. Request timing and store contents are not compared, nor is observe mode against no runtime. With chaos: 3/198 changed. |
| Same check on the v1 runtime (store-write holds) | 4/198 clean runs changed; the React/Redux RealWorld app never rendered its home feed |
| Demos | Baseline only, with the untrained GenClass 0.1 model: guard took 0 actions. Rerun when the v2 model exists. |

## What's in this repo

| path | what |
|---|---|
| [`packages/runtime`](packages/runtime) | `@genclass/runtime`, the library. Observers, causality, stores and adapters, learned baselines/relations/profiles, facts, triage, policy gate, actions, model host (Web Worker, ONNX Runtime Web on WebGPU/WASM), devtools overlay. [README](packages/runtime/README.md) · [STATUS](packages/runtime/STATUS.md) |
| [`packages/runtime-model`](packages/runtime-model) | Model card for the not-yet-published `@genclass/runtime-model` |
| [`sim`](sim) | Training-data simulator: random apps run on the real runtime in a deterministic virtual world, labelled by counterfactual outcomes |
| [`realapps`](realapps) | About 90 real apps (written for the corpus, plus open-source ones) run with the real runtime in headless Chromium, labelled the same way; the never-worse sweep covered the first 66. [README](realapps/README.md) |
| [`training`](training) | Vocabulary pruning, curriculum (`curriculum/rt.py` mirrors the runtime's renderer), multi-node CPU training on Azure, int8 ONNX export, evaluation |
| [`demos`](demos) | Six demo apps (typeahead, autosave, checkout, flaky dashboard, live kanban, real-time decisions) with a Service Worker chaos backend and Playwright trials |
| [`docs/runtime`](docs/runtime) | [Results](docs/runtime/RESULTS.md) · [Architecture](docs/runtime/ARCHITECTURE.md) · [Build contract](docs/runtime/CONTRACT.md) · [API](docs/runtime/API.md) |
| [`docs/agents`](docs/agents/README.md), [`AGENTS.md`](AGENTS.md) | Docs for AI coding agents: subsystem guides with code pointers (runtime, sim, [realapps](docs/agents/realapps.md), training, model I/O contract, demos) and the rules for working here |
| `jev_local`, `extension`, `bench`, … | The GenClass model, Jev-compatible server, voice harness, Chrome extension and benchmarks this runtime builds on ([details](docs/GENCLASS.md)) |

## Development

Node ≥ 20. From the repo root:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm ci   # the root lockfile is committed; skip onnxruntime-node's CUDA download
npm run typecheck -w @genclass/runtime
npm run build -w @genclass/runtime
cd packages/runtime
NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts
NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts --retry=2   # timing budgets, run alone
```

The same steps run in CI ([.github/workflows/ci.yml](.github/workflows/ci.yml), Node 22) on pushes to `main`,
`runtime`, `mvp` and `mvp-v2`, on pull requests, and on manual dispatch.

Last full local run (2026-10-08): 336 tests passed and 14 skipped. The skips are model-parity tests, which need
`GENCLASS_MODEL_DIR`. The perf tests time a 5,000-item store and can fail under parallel load.

Releasing: [RELEASE.md](RELEASE.md).

Not covered by CI:

- Playwright browser tests: `npm run test:browser` in `packages/runtime`.
- The npm tarball smoke test: `test/smoke/smoke.sh`.
- The sim, the real-app corpus, the demos' evaluation, and training.

These are heavier or need Azure; see [AGENTS.md](AGENTS.md) before running them.

**The training format is frozen** at tag `situation-v2`. Any change to `packages/runtime/src/situation/*` (or other
text the model reads) changes the model's input and means a new tag and regenerated data. See
[docs/agents/model-io-contract.md](docs/agents/model-io-contract.md).

## License

Apache-2.0.
