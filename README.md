# GenClass Runtime

[![npm](https://img.shields.io/npm/v/@genclass/runtime/latest?label=%40genclass%2Fruntime)](https://www.npmjs.com/package/@genclass/runtime)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**An AI runtime for self-healing web apps. Install one library. Find and prevent runtime failures automatically.**

```bash
npm install @genclass/runtime
```

```ts
import { GenClass } from "@genclass/runtime";

GenClass.init();
```

GenClass Runtime runs inside your web app and keeps track of what it is doing: user actions, async operations,
network requests, state changes, errors, timing, causality and recent history. When something looks risky, a
small GenClass model running locally in the browser (WebGPU or WASM, cached) judges what is happening and what to
do. It reports what it saw, or prevents the failure with a minimal, reversible action. It has no hardcoded list of
bugs; the model infers from runtime context.

```
[GenClass] Prevented a stale write: GET /api/search?q=rea (started 1.8 s ago) would have overwritten
           search.results written 0.4 s ago by a newer GET /api/search?q=react. Dropped it. (stale, 0.97)
```

> **Status: alpha.** [`@genclass/runtime@0.1.0-alpha.0`](https://www.npmjs.com/package/@genclass/runtime) is on
> npm. The runtime, model host, devtools and adapters are built and tested. The runtime-specialist model is still
> being trained and is not yet published, so for now the alpha observes and records but does not act yet. The
> demos will be evaluated with the trained model. See [OPEN_TASKS.md](OPEN_TASKS.md); contributors and agents continuing the work: [HANDOFF.md](HANDOFF.md).

## What's in this repo

| path | what |
|---|---|
| [`packages/runtime`](packages/runtime) | `@genclass/runtime`, the library: observers, causality, stores, learned invariants and profiles, facts, triage, policy, actions, model host (Web Worker, ONNX Runtime on WebGPU/WASM), devtools overlay, React/Redux/Zustand adapters. [README](packages/runtime/README.md) · [API](docs/runtime/API.md) |
| [`sim`](sim) | Training-data simulator: thousands of random apps run on the real runtime in a deterministic virtual world, labelled by counterfactual outcomes |
| [`training`](training) | Curriculum, vocabulary pruning, multi-node CPU training on Azure, int8 ONNX export, evaluation |
| [`demos`](demos) | Six demo apps (typeahead, autosave, checkout, flaky dashboard, live kanban, real-time decisions) with a Service Worker chaos backend and Playwright trials |
| [`docs/runtime`](docs/runtime) | [Architecture](docs/runtime/ARCHITECTURE.md) · [build contract](docs/runtime/CONTRACT.md) · [API](docs/runtime/API.md) |
| `jev_local`, `extension`, `bench`, … | The GenClass model, Jev-compatible server, voice harness, Chrome extension and benchmarks this runtime builds on ([details](docs/GENCLASS.md)) |

## How it works

1. **Observe.** Fetch, XHR, WebSocket, DOM events, errors, navigation and storage are instrumented, and async
   operations are linked into causal chains. State registered through GenClass gets per-field versions.
2. **Learn.** It learns latency, error and rate baselines per operation, invariants that keep holding (such as
   `total == sum(price·qty)`), and which fields each operation usually writes.
3. **Triage.** Generic facts are computed for every write and request. Only salient situations (concurrency,
   repeats, failures, anomalies, broken relations, errors) are passed to the model.
4. **Decide.** The local model reads the situation and answers two typed questions: what is happening, and which
   available action is best.
5. **Act carefully.**
   - `observe` mode reports only.
   - `guard` (the default) takes minimal, reversible actions (drop or defer a stale write, coalesce a duplicate,
     back off) when the model is ≥ 90% sure.
   - `heal` also retries, serves cached responses, and rolls back or resyncs inconsistent state.
6. **Explain.** Every detection and intervention is logged in plain English with its evidence, can be explained
   and undone, and `?genclass=off` turns everything off.

## License

Apache-2.0.
