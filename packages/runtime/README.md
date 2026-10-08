# @genclass/runtime

[![npm](https://img.shields.io/npm/v/@genclass/runtime/latest?label=npm)](https://www.npmjs.com/package/@genclass/runtime)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Install one library. Find and prevent runtime failures automatically.**

GenClass Runtime watches your web app from the inside: user actions, async operations, network requests, state
changes, errors, timing and causality. When something looks risky, it asks a small model that runs locally in the
browser (WebGPU or WASM, cached after the first load) what is happening and what to do. It then reports what it
saw, or prevents the failure with a minimal, reversible action. Nothing leaves the browser.

```bash
npm install @genclass/runtime
```

```ts
import { GenClass } from "@genclass/runtime";

GenClass.init();
```

> **Status: alpha (`0.1.0-alpha.0` on npm).** The runtime, model host, devtools and adapters work and are
> tested. The runtime-specialist model is still in training and not yet published, so this alpha observes and
> records but does not act yet: until the model ships, the runtime fails open and takes the passive action. To
> try decisions now, self-host a model with `npx genclass-runtime fetch-model`. Remaining work is listed in
> [OPEN_TASKS.md](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/OPEN_TASKS.md).

## What it looks like

Run your app as usual. The console starts saying things like this (example output):

```
[GenClass] Prevented a stale write: GET /api/search?q=rea (started 1.8 s ago) would have overwritten
           search.results written 0.4 s ago by a newer GET /api/search?q=react. Dropped it. (stale, 0.97)
[GenClass] Coalesced a duplicate: POST /api/orders was sent again 90 ms after an identical one from the
           same click. Reused the first response. (duplicate, 0.95)
[GenClass] Flagged: POST /api/cart usually writes cart.items and cart.total (317 of 317 times); this time it
           wrote only cart.items. (unusual, 0.88)
```

Each line expands into the evidence: the facts, the timeline, the exact text the model read, its answer
probabilities, exactly what GenClass changed, and how to undo it.

## What it handles

The runtime has no list of known bugs. It computes generic facts about every write and request: what caused it,
which versions it was based on, what happened in between, repeats, failure streaks, latency against learned
baselines, broken learned relations, and unusual transitions. The model decides what is going on.

| situation | example | what GenClass can do |
|---|---|---|
| stale overwrite | an old response lands after a newer one | drop or defer the write |
| race / conflict | two operations write the same state | defer, drop, roll back |
| duplicate | a double click sends the same order twice | coalesce with the first request |
| inconsistent state | `total` no longer equals the sum of the lines | roll back or resync (heal) |
| failure patterns | an endpoint fails 5 times in a row | back off, serve cached (heal) |
| transient failure | a one-off 503 | retry (heal) |
| slow / overload | a request is 8× slower than usual; a render loop floods an API | hedge, delay |
| unusual behaviour | an operation writes different fields than its last 300 runs | flag, roll back (heal) |
| your own questions | "is now a good moment to start the upload?" | `ask` / `decide` |

## Modes

| mode | behaviour |
|---|---|
| `observe` | Finds and reports anomalies. Never changes execution. |
| `guard` (default) | Also prevents failures with guard-tier actions only (`discard`, `defer`, `coalesce`, `delay`). These withhold, deduplicate or slow something down, and only run when the model is very sure (≥ 0.9) that acting beats doing nothing. |
| `heal` | Also recovers: `retry`, `serve_cached`, `block`, `hedge`, `rollback`, `resync`, plus your own actions (≥ 0.8). |

```ts
GenClass.init({ mode: "observe" });
```

**Kill switch:** append `?genclass=off` to the URL, or set `localStorage.genclass = "off"`, to rule GenClass out
while debugging. `?genclass=observe` switches to observe mode.

## State it can protect

Fetch, XHR, WebSocket, DOM events, errors, navigation and storage are observed automatically. To let GenClass
hold, drop or roll back writes, create state through it, or wrap the store you already have:

```ts
const rt = GenClass.init();

// Built-in atom
const cart = rt.atom("cart", { items: [], total: 0 }, { resync: () => loadCart() });
cart.set((c) => ({ ...c, items: [...c.items, item] }));

// React
import { useGenClassState } from "@genclass/runtime/react";
const [results, setResults] = useGenClassState("search.results", []);

// Redux
import { genclassEnhancer } from "@genclass/runtime/redux";
const store = createStore(reducer, genclassEnhancer(rt, { name: "app" }));

// Zustand
import { genclass } from "@genclass/runtime/zustand";
const useStore = create(genclass(rt, "board")((set) => ({ cards: [], move: () => set(/* … */) })));

// Any store with get/set/subscribe
const prefs = rt.guard("prefs", { get: () => store.prefs, set: (v) => store.setPrefs(v) });
```

`resync` is optional. It tells GenClass how to reload a store from its source, which enables the `resync`
recovery action.

## Ask it questions

The model answers typed questions about what is happening right now, using the same request shape as Jev's
System One API:

```ts
const busy = await rt.ask({ type: "noul", instructions: "Is a save in flight or failing?" });
// { type: "noul", noul: 0.91 }

const mode = await rt.decide("Which upload strategy fits what is happening now?", {
  now: "start the upload immediately",
  later: "wait until the network is calm and the user is idle",
});
// "later"
```

## Observability

- **Console:** one plain-English line per detection and per intervention, with collapsible evidence.
- **Events:** `rt.on("detect" | "decide" | "act" | "event" | "status" | "report", fn)`.
- **`rt.explain(id)`:** the situation text, facts, timeline, answers and what changed.
- **`rt.interventions()`:** every non-passive action that ran, with `undo()` where the action is reversible.
- **Devtools overlay:** interventions, detections, a live activity log, and a "what GenClass sees now" view. Load it
  in development only (52 KB minified, 17 KB gzip):

```ts
if (import.meta.env.DEV) {
  const { mountDevtools } = await import("@genclass/runtime/devtools");
  mountDevtools(rt);
}
```

Responses GenClass altered carry an `x-genclass` header: `coalesced`, `cached` or `blocked`.

## Extend it

```ts
rt.use({
  name: "visibility",
  setup(api) {
    const onChange = () => api.emit("visibility", { hidden: document.hidden });
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  },
  actions: [{
    name: "pause_sync",
    description: "pause background sync until the page is visible again",
    on: ["failure", "stall"],
    tier: "heal",
    run: () => sync.pause(),
  }],
});
```

Plugins can add observers, facts, actions, standing questions and diagnosis labels. The model reads each action's
description, so new actions work without retraining when the description is clear.

## Model, performance, privacy

- **Local inference:** a GenClass encoder running in a Web Worker on WebGPU when available, otherwise WASM. The
  model downloads at idle after page load (`model.preload: "idle"`) and is cached in Cache Storage.
- **Size:** the runtime models use a pruned vocabulary and int8 weights. Preview exports are 9.6 MB (17M
  parameters) and 22.5 MB (32M parameters). The ONNX Runtime WASM is about 2.7 MB brotli without WebGPU and 4.7 MB
  with it.
- **Tiered:** normal traffic never reaches the model. Cheap facts are computed for every write and request, and
  the model is asked only about salient situations. What it reads is sized to the device: 3,200 characters on
  WebGPU, 2,000 with WASM threads, 1,000 on single-thread WASM.
- **Latency:** held writes and requests wait at most the adaptive hold budget (150–800 ms), then proceed
  unchanged. A write GenClass decides about too late can still be reverted within 2 s if nothing has touched it
  since. On single-thread WASM the 17M model takes about 0.2 s per decision on a 500-token situation (preview
  build, measured in Node).
- **Threads:** serving your page with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` enables WASM threads, about 3× faster.
- **Self-hosting:** `npx genclass-runtime fetch-model public/genclass-model`, then
  `GenClass.init({ model: { baseUrl: "/genclass-model/" } })`.
- **Privacy:** nothing is sent anywhere. Values of password and payment fields are never recorded, and fields
  matching `pass|token|secret|card|cvv|ssn|auth` are redacted. Pass `redact` to add your own rules.

## Limits

- Causality across `await` is tracked by instrumenting fetch, XHR, timers and Response bodies. This is best
  effort; wrap important work in `rt.op(name, fn)` for exact attribution.
- Only writes that go through GenClass-aware stores can be held, dropped or rolled back. Other state is observed
  through its effects.
- The model is trained on a large simulated space of apps. It is not a substitute for tests, and it can be wrong.
  That is why the default mode only takes reversible actions at very high confidence, and every action is logged
  and undoable.

## License

Apache-2.0. The model weights are trained only on synthetic data from the GenClass project.
