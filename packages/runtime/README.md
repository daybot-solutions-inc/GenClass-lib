# @genclass/runtime

[![npm](https://img.shields.io/npm/v/@genclass/runtime/latest?label=npm)](https://www.npmjs.com/package/@genclass/runtime)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![runs](https://img.shields.io/badge/runs-100%25%20in%20the%20browser-brightgreen)

### Your app's race conditions, stale responses and double submits, caught while they happen.

```bash
npx @genclass/runtime init
```

That's the whole setup. It finds your framework and package manager, installs the package, adds one line to your
entry file (plus the devtools overlay in development only), and shows you the diff before writing anything.
Prefer to do it by hand? It's one import:

```ts
import "@genclass/runtime/auto";
```

The bugs your tests never catch are the ones that depend on timing: a slow response landing after a fast one, a
button clicked twice, a save racing an edit, an endpoint that starts failing at 2 a.m. GenClass Runtime runs
inside your app, watches requests, state, user actions and errors, and works out what caused what. When
something goes wrong it tells you in plain English, and in guard mode it can stop the failure before your users
see it.

```
[GenClass] Prevented a stale response: GET /api/search?q=rea (started 1.8 s ago) would have overwritten
           search.results from a newer GET /api/search?q=react. Dropped it. (stale, 0.97)
[GenClass] Coalesced a duplicate: POST /api/orders was sent again 90 ms after an identical one from the
           same click. Reused the first response. (duplicate, 0.95)
[GenClass] Flagged: POST /api/cart usually writes cart.items and cart.total (317 of 317 times); this time it
           wrote only cart.items. (unusual, 0.88)
```

## Why it's an easy yes

- **It won't make a working app worse.** Holds happen only at the network boundary, which looks like ordinary
  latency to your app, and only when newer data is already in place. Your app's own writes are never delayed or
  reordered. With a model that never intervenes, GenClass changed the outcome in **0 of 396** clean runs across
  **66 real apps on 23 stacks**: React, Vue, Svelte, Solid, Angular, Ember, Elm, Lit, Redux, Zustand, MobX,
  TanStack Query and more, including 14 unmodified open-source RealWorld front-ends.
- **Normal traffic costs nothing.** Cheap facts are computed for every write and request. The model is consulted
  only when something looks wrong, so plain traffic makes no model calls. A keystroke write to a 5,000-item store
  costs about 0.3 ms.
- **Nothing leaves the browser.** The model runs locally in a Web Worker on WebGPU or WASM and is cached after the
  first load. No telemetry, no server, no API key. Password and payment fields are never recorded.
- **You can always see what it did.** Every detection and action gets one plain-English console line, with the
  evidence behind it, `explain(id)` and an Undo. Responses it changed carry an `x-genclass` header.
- **Off in one click.** Add `?genclass=off` to the URL to rule it out while debugging, or use
  `GenClass.init({ mode: "observe" })` to never change anything.
- **Small.** The library is 83 KB gzip (minified, without the optional devtools). The decision model is 9.6 MB, downloaded once when the browser is
  idle.

## Install

Pick whichever fits; all three are the same runtime.

**1. One command.** Tested end to end in fresh Vite (React, Vue, Svelte), Next.js (App and Pages Router), Create
React App, SvelteKit, Astro, Nuxt, React Router, Angular and plain-HTML projects. Each one builds and runs after
`init`, and `remove` restores every file byte for byte.

```bash
npx @genclass/runtime init                  # shows the diff, asks, then writes
npx @genclass/runtime init --yes            # no questions
npx @genclass/runtime init --mode observe   # report only, never change anything
npx @genclass/runtime remove                # undo exactly what init added
```

**2. One import** (any bundler):

```ts
import "@genclass/runtime/auto"; // at the top of your entry file
```

**3. One script tag** (no build step):

```html
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime" data-mode="observe" data-devtools></script>
```

To configure it from code:

```ts
import { GenClass } from "@genclass/runtime";

const gc = GenClass.init({ mode: "guard" }); // "observe" | "guard" | "heal"
```

## What it catches

GenClass has no hardcoded list of bugs. It computes generic facts about everything your app does: what caused
each write, which versions it was based on, what changed in between, repeats, failure streaks, latency compared
with what is normal for that endpoint, relations your state normally keeps, and how each operation usually
behaves. A small local model then decides what's happening.

| Situation | Example | What GenClass can do |
|---|---|---|
| Stale response | an old search response lands after a newer one | drop it before your app applies it |
| Race / conflict | a server echo would overwrite what the user just typed | drop the stale part, defer |
| Duplicate | a double click sends the same order twice | reuse the first response |
| Inconsistent state | the cart total no longer equals the sum of the lines | roll back or resync (heal) |
| Failure pattern | an endpoint fails 5 times in a row | back off, serve the last good response (heal) |
| Transient failure | a one-off 503 | retry (heal) |
| Slow or flooding | 8× slower than usual; a render loop hammering an API | hedge, delay |
| Unusual behaviour | an operation writes different fields than in its last 300 runs | flag, roll back (heal) |
| Your own question | "is now a good moment to start the upload?" | `gc.ask()` / `gc.decide()` |

## Modes

| Mode | What it does |
|---|---|
| `observe` | Finds and reports. Never changes execution. |
| `guard` (default) | Also prevents failures with minimal, reversible actions (drop a stale response, reuse a duplicate's result, back off), and only when the model is at least 90% sure acting beats doing nothing. |
| `heal` | Also recovers: retry, serve cached, roll back, resync, and your own actions (≥ 80%). |

## Connect your state (optional)

Network, user actions, errors and timing are observed with zero code. To let GenClass also protect your state
(roll back an inconsistent cart, revert a stale write), create it through GenClass or wrap the store you already
have. Each option is one line:

```ts
// React
import { useGenClassState } from "@genclass/runtime/react";
const [results, setResults] = useGenClassState("search.results", []);

// Redux / Redux Toolkit
import { genclassEnhancer } from "@genclass/runtime/redux";
const store = configureStore({ reducer, enhancers: (e) => e().concat(genclassEnhancer(gc, { name: "app" })) });

// Zustand
import { genclass } from "@genclass/runtime/zustand";
const useStore = create(genclass(gc, "board")((set) => ({ /* … */ })));

// Anything with get/set
const cart = gc.atom("cart", { items: [], total: 0 }, { resync: () => loadCart() });
```

## See what it sees

```ts
if (import.meta.env.DEV) {
  const { mountDevtools } = await import("@genclass/runtime/devtools");
  mountDevtools(gc);
}
```

The devtools overlay has four views:
- **Interventions**: what GenClass did, with an Undo button.
- **Detections**: what it noticed but didn't act on.
- **Activity**: a live log of requests, writes, user actions and errors, with their causal links.
- **Now**: what the model would see at this moment.

Elsewhere:

- `gc.on("detect" | "act" | "decide", fn)`: stream findings to your own logging.
- `gc.explain(id)`: the full evidence for any decision.

## Ask it things

```ts
const busy = await gc.ask({ type: "noul", instructions: "Is a save in flight or failing?" });
const plan = await gc.decide("Which upload strategy fits what is happening now?", {
  now: "start the upload immediately",
  later: "wait until the network is calm and the user is idle",
});
```

## Extend it

Plugins can add their own observers, facts, actions and questions. The model reads each action's description,
so a new action works without retraining:

```ts
gc.use({
  name: "sync",
  actions: [{
    name: "pause_sync",
    description: "pause background sync until the page is visible again",
    on: ["failure", "stall"],
    run: () => sync.pause(),
  }],
});
```

## Status

**Alpha.** The runtime, the observers, causality tracking, the devtools, the adapters and the install paths are
built and tested: 346 tests, a review of 34 findings with a regression test for each, and the never-worse sweep
over real apps.

The runtime-specialist model is still training on millions of simulated and real-browser examples. Until its
package, `@genclass/runtime-model`, is published, GenClass observes and records, and takes no actions. Follow
progress in [RESULTS.md](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/docs/runtime/RESULTS.md),
where every number sits next to its false-intervention rate.

## Good to know

- **Causality is best effort.** It follows fetch, XHR, WebSocket, EventSource, timers and response bodies. Wrap
  important work in `gc.op(name, fn)` for exact attribution.
- **Only state GenClass can see can be rolled back.** Everything else is observed through its effects.
- **It won't catch every bug.** It catches runtime failures that leave evidence: ordering, staleness, duplicates,
  broken relations, failure patterns. It won't catch logic that is consistently wrong, CSS, or security bugs, and
  it never rewrites your code.
- **Self-hosting the model:** `npx @genclass/runtime fetch-model public/genclass-model`, then
  `GenClass.init({ model: { baseUrl: "/genclass-model/" } })`.
- **Faster without WebGPU:** WASM threads are about 3× faster when your page sends
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.

Docs: [API](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/docs/runtime/API.md) ·
[Architecture](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/docs/runtime/ARCHITECTURE.md) ·
[Results](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/docs/runtime/RESULTS.md)

## License

Apache-2.0. The model is trained only on synthetic and simulated data from this project.
