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

> **Status: beta. `@genclass/runtime@0.1.0-beta.4` with the model `@genclass/runtime-model@0.2.0`.**
>
> - **Runtime:** works and is unit-tested (situation format tag `situation-v2.3`). Install with
>   `npx @genclass/runtime init`, one import (`@genclass/runtime/auto`) or one script tag.
> - **Default mode** is `observe`: the model diagnoses salient situations and the runtime reports likely problems,
>   without changing what the app does (it never holds or delays a response). `guard` is opt-in; `heal` is
>   experimental.
> - **How eager it acts** once you opt in: `aggressiveness: "cautious" | "balanced" (default) | "eager"`.
> - **Model:** `genclass-runtime-r17` 2.0.0-rc4t (`r17-v2dT`, gain gate, 10 MB, WASM or WebGPU), loaded from jsDelivr
>   at idle and cached. On held-out data ([RESULTS.md](docs/runtime/RESULTS.md) §1):
>
>   | profile | guard FIR | guard recall (clear / real) | heal FIR | heal recall (clear / real) | report threshold |
>   |---|---|---|---|---|---|
>   | `cautious` | 0.005% | 2.4% / 1.4% | 0.26% | 3.7% / 3.8% | 0.95 |
>   | `balanced` (default) | 0.13% | 7.8% / 7.5% | 0.59% | 7.1% / 10.4% | 0.90 |
>   | `eager` | 0.54% | 14.2% / 21.0% | 1.84% | 17.1% / 24.2% | 0.70 |
>
>   Our targets are guard FIR ≤ 0.1% and heal FIR ≤ 0.5%. `cautious` stays under both; `balanced` is slightly over
>   both (0.13% and 0.59% on simulated apps); `eager` is well over. FIR on held-out real apps was 0.00% for every
>   profile. Recall is still low: at `balanced`, guard acts on under 8% of the cases where acting would help.
>   Installed from the registry into a fresh app, guard mode fixed an out-of-order typeahead in 6 of 6 trials, and
>   clean typing made 0 model calls. See the [model card](packages/runtime-model/MODEL_CARD.md).
> - **Options** (activation, route scopes, protected endpoints, breaker, shadow, veto, action limits, sinks):
>   [OPTIONS-SPEC.md](docs/runtime/OPTIONS-SPEC.md).
> - **Older versions on npm:** `0.1.0-beta.1` (model 0.2.0 and the options, but `guard` by default and without the
>   observe-delivery, redaction and install fixes), `0.1.0-beta.0` (model 0.1.0), `0.1.0-alpha.1` and
>   `0.1.0-alpha.0` (no model). `0.1.0-beta.2` is `0.1.0-beta.3` without telemetry. `0.1.0-beta.3` lacks the
>   `0.1.0-beta.4` fixes from the Troy trial (no ONNX Runtime wasm in app builds, one clear warning for a CSP-blocked
>   model, `init --no-telemetry`, a smaller main entry). Use `0.1.0-beta.4`.
>
> - **Privacy notice (since `0.1.0-beta.3`): anonymous diagnostics are on by default** in browsers. GenClass sends
>   its decisions, including the redacted situation text the model read, to the GenClass maintainers to improve the
>   model. Opt out with `GenClass.init({ telemetry: false })` or `?genclass=no-telemetry`; Global Privacy Control is
>   honoured. See [Privacy and telemetry](#privacy-and-telemetry).
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
   | `observe` (default) | reports only; never holds, delays or changes anything |
   | `guard` (opt-in) | `discard`, `defer`, `coalesce`, `delay`, only when the model's gate for that trigger says acting beats doing nothing by the margin of the chosen `aggressiveness` profile |
   | `heal` (experimental) | also `retry`, `serve_cached`, `block`, `hedge`, `rollback`, `resync` and custom actions, at the heal margin of the profile |

   Detections are reported when the top diagnosis is not `expected` with probability at or above the profile's
   report threshold (0.95 / 0.90 / 0.70 for cautious / balanced / eager). `rt.gates()` shows what is in force.

6. **Explain.**
   - Every detection and intervention is logged in plain English, with the exact situation text the model read.
   - Reversible actions can be undone.
   - `?genclass=off` installs nothing.

## Privacy and telemetry

- **Decisions are local.** Situations are built and decided in the browser by the local model; nothing is sent
  anywhere to make a decision.
- **Anonymous diagnostics are on by default** with `GenClass.init()` in a browser (since `0.1.0-beta.3`; off in
  Node/SSR and in `createRuntime()` unless enabled). They go to the GenClass maintainers' collector
  ([`telemetry-worker/`](telemetry-worker), a Cloudflare Worker writing to a private R2 bucket) and are used to
  improve the model. Sent: a random per-page session id, versions, mode, device class, the app's hostname and
  id-normalised path, and for each decision the trigger, **the redacted situation text the model read**, its
  calibrated answers, the diagnosis, gate and outcome, plus action outcomes, detections, model errors and counts.
  Never sent: typed password/payment/secret values, cookies, headers, bodies, storage, query strings; the collector
  stores no IP address or user agent. One console notice per page says it is on.
- **Opt out:** `GenClass.init({ telemetry: false })`, `?genclass=no-telemetry`,
  `localStorage.setItem("genclass.telemetry", "off")`; browsers sending Global Privacy Control are never collected.
- Apps that ship GenClass may need to disclose this to their users (GDPR/CCPA). Full schema, storage and guidance:
  [packages/runtime/TELEMETRY.md](packages/runtime/TELEMETRY.md).

Full guide (modes, triggers, adapters, observability, performance, privacy, known limitations):
**[packages/runtime/README.md](packages/runtime/README.md)**. API: [docs/runtime/API.md](docs/runtime/API.md).

## Results so far

All numbers are on held-out data, with each recall reported next to its false-intervention rate (FIR). Source:
[docs/runtime/RESULTS.md](docs/runtime/RESULTS.md).

| what | result |
|---|---|
| Round 1 model, R17 (9.6 MB int8; **previous format** `situation-v1`), simulated apps | diagnosis 90.5%, action 81.9%, guard FIR 0.05%, heal FIR 0.24%, calibration error 0.009. Recall on clear stale/duplicate cases is only 7.7% (precise but timid). |
| Why round 1 was timid ([sim/SEPARABILITY.md](sim/SEPARABILITY.md)) | Many clear cases had benign twins with identical visible facts; 24% of clear rows were mislabelled `expected`; labels assumed knowledge a runtime cannot have. v2 adds measured facts and fixes the labels. |
| **r17-v2dT** (`situation-v2`; shipped as `@genclass/runtime-model@0.2.0`, default since `0.1.0-beta.1`) | Gain gate with three profiles (table above). `balanced`: guard FIR 0.13%, heal FIR 0.59% on simulated apps (slightly over the 0.1% / 0.5% targets); `cautious`: 0.005% / 0.26% (under). 0.00% on held-out real apps for every profile. Calibration error 0.009. |
| r17-v2b (shipped as `@genclass/runtime-model@0.1.0`) | Simulated apps: diagnosis 84.2%, action 77.8%. Real apps: diagnosis 83.6%, action 80.0%. Guard FIR 0.01%, heal FIR 0.07%; heal acts on 2.9% of clear simulated cases and 5.7% of actionable real-app cases; guard on 0.7%. |
| Training continues | teacher model, distillation, DAgger rounds; ~10M simulated gold rows, ~50M unlabeled rows, ~0.6M real-app rows |
| Never make a correct app worse (always-passive model, heal vs observe, 66 real apps × 6 seeds) | 0/396 clean runs changed: final page text (inputs and alerts excluded) and server state. Request timing and store contents are not compared, nor is observe mode against no runtime. With chaos: 3/198 changed. |
| Same check on the v1 runtime (store-write holds) | 4/198 clean runs changed; the React/Redux RealWorld app never rendered its home feed |
| Demos | Baseline only, with the untrained GenClass 0.1 model: guard took 0 actions. Not yet re-run with model 0.2.0. |

## What's in this repo

| path | what |
|---|---|
| [`packages/runtime`](packages/runtime) | `@genclass/runtime`, the library. Observers, causality, stores and adapters, learned baselines/relations/profiles, facts, triage, policy gate, actions, model host (Web Worker, ONNX Runtime Web on WebGPU/WASM), devtools overlay. [README](packages/runtime/README.md) · [STATUS](packages/runtime/STATUS.md) |
| [`packages/runtime-model`](packages/runtime-model) | `@genclass/runtime-model`, the default model package (data only; `files/` is gitignored and filled at release time) and its [model card](packages/runtime-model/MODEL_CARD.md) |
| [`sim`](sim) | Training-data simulator: random apps run on the real runtime in a deterministic virtual world, labelled by counterfactual outcomes |
| [`realapps`](realapps) | 128 real apps (written for the corpus, plus open-source ones) run with the real runtime in headless Chromium, labelled the same way; the never-worse sweep covered the first 66. [README](realapps/README.md) |
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

Last full local run (2026-10-09, branch `mvp-v2-b6`, version `0.1.0-beta.4`): 514 tests passed and 14 skipped, plus
the 4 perf tests run alone. The skips are model-parity tests, which need `GENCLASS_MODEL_DIR`. The perf tests time a
5,000-item store and can fail under parallel load.

Releasing: [RELEASE.md](RELEASE.md).

Not covered by CI:

- Playwright browser tests: `npm run test:browser` in `packages/runtime`.
- The npm tarball smoke test: `test/smoke/smoke.sh`.
- The sim, the real-app corpus, the demos' evaluation, and training.

These are heavier or need Azure; see [AGENTS.md](AGENTS.md) before running them.

**The training format is tagged.** The current tag is `situation-v2.3`; the shipped model was trained on data from
`situation-v2`. Any change to `packages/runtime/src/situation/*` (or other text the model reads) changes the model's
input and means a new tag and regenerated data. See
[docs/agents/model-io-contract.md](docs/agents/model-io-contract.md).

## License

Apache-2.0.
