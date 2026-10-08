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

## How eager should it be?

GenClass only acts when the model is confident enough. You choose how confident:

```ts
GenClass.init({ aggressiveness: "cautious" }); // "cautious" | "balanced" (default) | "eager", or a number 0–1
GenClass.runtime.setAggressiveness("eager");   // change it later (the devtools have a selector too)
```

`cautious` acts less often (fewer interventions, almost never a wrong one); `eager` fixes more problems at a
somewhat higher risk of acting when it did not need to. A number in between interpolates (0 = cautious,
0.5 = balanced, 1 = eager). Try a level without redeploying with `?genclass-aggr=eager` in the URL. The model ships
tuned thresholds for each level; explicit `policy.thresholds` still override them. `runtime.gates()` shows what is
in force.

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

## Configuration

GenClass runs with safe defaults (`mode: "guard"`, a `"balanced"` gate, circuit breaker on). The options below narrow where it acts, cap how much it does, and send findings to your tools. None of them tell the model what a bug looks like. They only scope and limit it.

- **Activation**: `enabled` (a boolean, a predicate, or a subscribable feature flag; while it is false the model is never downloaded), `rt.disable({ undo: true })` (remote kill that also rolls back recent actions), `sample` (the fraction of sessions allowed to act; the rest only observe).
- **Scope**: `routes` (per-route mode and aggressiveness, which can only be lowered), `requests.ignore` (analytics traffic), `requests.protect` (endpoints that are never held, retried, cached or discarded), `requests.labels` (endpoint names for reports), `requests.correlate` (attach your trace id to records).
- **Safety**: `breaker` (automatic downgrade after undos, or after errors that follow an action), `shadow` (records what a higher mode would have done), `onBeforeAction` + `vetoMode` (a synchronous veto, or a report-only trial of one), `policy.actionLimits` (per-minute, per-subject and per-session caps), `policy.holdBudgetMs` (a hard ceiling on added latency).
- **Telemetry**: `sinks` (structured, redacted records), `session` (id and tags, never shown to the model), `report: "interventions"` (a quiet production console), `rt.summary()`, `rt.on("shadow" | "breaker" | "limit" | "modelBudget", cb)`.
- **Loading and cost**: `model.loadIf`, `model.threads`, `model.timeoutMs`, `model.maxDecisionsPerMinute`, `model.unloadAfterIdleMs`.

URL overrides (`?genclass-mode`, `?genclass-aggr`, `?genclass-sample`) can only lower settings, unless `debug: true` is set.

```ts
import { GenClass } from "@genclass/runtime";

const rt = GenClass.init({
  mode: "guard",
  aggressiveness: "cautious",
  enabled: {                                         // live feature flag; flipping off disables mid-session
    get: () => flags.isEnabled("genclass") && consent.analytics,
    subscribe: (cb) => flags.onChange("genclass", cb),
  },
  sample: 0.1,                                       // 10% of sessions act, 90% observe
  routes: [
    { match: "/checkout/*", mode: "observe" },
    { match: /^\/admin/,    mode: "off" },
  ],
  requests: {
    ignore:  ["https://www.google-analytics.com/", /sentry\.io/, "*/rum/*"],
    protect: ["/api/auth/", "/api/payments/", (r) => r.method !== "GET" && r.url.includes("/billing")],
    crossOrigin: "observe",
    labels: [{ match: "/api/orders", label: "place order" }],   // reports only by default
    correlate: (r) => r.headers["x-request-id"],
  },
  breaker: { undos: 2, errorsAfterAction: 3, attributionMs: 5000, downgradeTo: "observe" },
  shadow: "heal",
  onBeforeAction: (a) => !(cart.isSubmitting && a.tier === "heal"),
  vetoMode: "enforce",
  policy: { actionLimits: { perMinute: 30, perSubject: 3, perSession: 100 }, holdBudgetMs: "auto" },
  report: import.meta.env.PROD ? "interventions" : "console",
  sinks: [
    { send: (r) => navigator.sendBeacon("/genclass", JSON.stringify(r)),
      kinds: ["intervention", "undo", "breaker", "summary"] },
    { send: (r) => Sentry.addBreadcrumb({ category: "genclass", data: r }), sampleRate: 0.2 },
  ],
  session: { tags: { release: __RELEASE__, tenant: tenantTier } },
  learn: { persist: "local", key: "genclass:shop" },  // version = session.tags.release at init
  model: {
    preload: "idle",
    loadIf: { minDeviceMemoryGB: 2, saveData: "lazy" },
    threads: 2,
    timeoutMs: 10_000,
    maxDecisionsPerMinute: 30,
    unloadAfterIdleMs: 300_000,
  },
});

rt.on("breaker", (e) => log.warn("genclass downgraded", e));
onLogin((u) => rt.setSession({ tags: { plan: u.plan } }));
onLogout(() => rt.learn.clear());
onIncident(() => rt.disable({ undo: true }));
```

**Recommended `requests.protect` starter** (it is not built in; adapt it to your endpoints):
`[/\/(auth|login|logout|oauth|token|session)\b/, /\/(payment|checkout|billing)\b/]`

**Rollout recipe:** start with `mode: "observe", shadow: "guard"`, and compare the shadow records with your undo and complaint rates. Then switch to `mode: "guard", sample: 0.05`. Watch `rt.summary().undos` and `breaker` events, and widen `sample` as they stay quiet. For QA, `?genclass-sample=1` together with `debug: true` forces a session into the acting group.

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
