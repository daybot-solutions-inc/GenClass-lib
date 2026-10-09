# @genclass/runtime

[![npm](https://img.shields.io/npm/v/@genclass/runtime/latest?label=npm)](https://www.npmjs.com/package/@genclass/runtime)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![model](https://img.shields.io/badge/model-runs%20in%20the%20browser-brightgreen)

### Your app's race conditions, stale responses and double submits, caught while they happen.

The bugs your tests never catch are the ones that depend on timing: a slow response landing after a fast one, a
button clicked twice, a save racing an edit, an endpoint that starts failing at 2 a.m.

GenClass Runtime records what your app does: user actions, async operations and their causes, fetch/XHR/WebSocket/
EventSource traffic, store writes with per-field versions, errors and timing. It computes generic facts about each
write, request and response. When a situation looks risky, a small GenClass model running in the browser (WebGPU or
WASM, in a Web Worker) answers two questions: what is happening, and which of the available actions is best. The
runtime has no list of known bugs: triage picks the situations, the model decides. By default it only reports; in
`guard` mode it can also stop the failure before your users see it.

```ts
import { GenClass } from "@genclass/runtime";

GenClass.init(); // observe mode: reports only, never takes an action (see Known limitations)
```

> **Privacy notice: anonymous diagnostics are on by default since `0.1.0-beta.3`.** `GenClass.init()` in a browser
> sends GenClass's decisions, including the redacted situation text the model read, to the GenClass maintainers to
> improve the model. Never typed passwords or payment fields, cookies, headers, bodies or IP addresses. Opt out with
> `GenClass.init({ telemetry: false })`, `?genclass=no-telemetry`, or `localStorage["genclass.telemetry"] = "off"`;
> browsers sending Global Privacy Control are never collected. Details: [Privacy and telemetry](#privacy-and-telemetry)
> and [TELEMETRY.md](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md).

> **Status: beta (`0.1.0-beta.2`), with model `@genclass/runtime-model@0.2.0`.**
>
> - **The model loads by default.** A default `GenClass.init()` loads `@genclass/runtime-model@0.2.0` (10.2 MB q8,
>   `genclass-runtime-r17` 2.0.0-rc4t, run `r17-v2dT`, with a gain gate and three aggressiveness profiles) from
>   jsDelivr at idle, in a Web Worker, and caches it. Self-hosting and `model: false` are under
>   [Performance](#performance).
> - **Observe is the default.** The model diagnoses salient situations and the runtime reports likely problems; it
>   never changes what your app does and never holds or delays a response. `guard` is opt-in and `heal` is
>   experimental. Once you opt in, `aggressiveness` (`"cautious"`, `"balanced"` (default), `"eager"`) sets how eager
>   it acts.
> - **The model is precise when it acts, but misses most problems.** On held-out simulated apps, at `balanced`:
>   guard intervened wrongly on 0.13% of cases and heal on 0.59%, slightly above our 0.1% / 0.5% targets; at
>   `cautious`, 0.005% and 0.26%, under them. No wrong interventions were seen on held-out real apps. At `balanced`,
>   guard acts on under 8% of the cases where acting would help. Details: [Model quality](#model-quality) and the
>   [model card](https://www.npmjs.com/package/@genclass/runtime-model).
> - **Older versions.** `0.1.0-beta.1` has model 0.2.0 and the new options but defaults to `guard`, and lacks the
>   observe-delivery, redaction and install fixes of `0.1.0-beta.0` (all back in `0.1.0-beta.2`). `0.1.0-beta.0`
>   ships model 0.1.0. `0.1.0-alpha.1` and `0.1.0-alpha.0` (v1 runtime: guard by default, holds store writes, `NaN`
>   crash) predate the model; do not use them.
>
> Progress: [OPEN_TASKS.md](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/OPEN_TASKS.md) ·
> measured results: [RESULTS.md](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/docs/runtime/RESULTS.md).

## Contents

[Install](#install) · [Why it's an easy yes](#why-its-an-easy-yes-measured) · [Modes](#modes) ·
[What it looks for](#what-it-looks-for) · [State it can protect](#state-it-can-protect) ·
[Ask it questions](#ask-it-questions) · [Observability](#observability) · [Extend it](#extend-it) ·
[Model quality](#model-quality) · [Performance](#performance) · [Privacy and telemetry](#privacy-and-telemetry) ·
[Known limitations](#known-limitations) · [API reference](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/docs/runtime/API.md)

## What it looks like

Run your app as usual. When the model flags something, the console gets one plain-English line per detection or
intervention, followed by a collapsed group with the evidence. Here a typeahead's slow response for "rea" lands
after the response for "reac". This is real output of `0.1.0-beta.0` with model 0.1.0 (q8 on WASM, in Node),
in the default observe mode. The response reaches the app at once, exactly as without GenClass, and the decision is
made in the background, for the report only:

```
[GenClass] Model ready (genclass-runtime-r17, wasm, q8, 0.43s). Mode: observe.
[GenClass] Flagged a stale response: search.results was written twice by other operations since its operation (#6)
started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later
user action (#7). (stale, 0.96)
```

The same run in guard mode. The model's `discard` (0.98) passed model 0.1.0's delivery gate (0.80), so the results
for "reac" stayed:

```
[GenClass] Prevented a stale response: search.results was written twice by other operations since its operation (#6)
started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later
user action (#7). Delivered the response to GET /api/search?q=rea (#6) and dropped the state changes it makes over
newer data (search.results). (stale, 0.97; discard 0.98)
```

## Install

Pick one. All of them start the same runtime, in observe mode unless you choose otherwise.

**1. One command.** `init` finds your framework and package manager, installs the package, adds one import as the
first line of your entry file (plus a line that loads the devtools overlay in development only), and shows you the
diff before writing anything. Running it again changes nothing; running it with another `--mode` switches the
import it added.

```bash
npx @genclass/runtime init               # observe; shows the diff, asks, then writes
npx @genclass/runtime init --mode guard  # let GenClass act (also: --mode heal); run again later to switch
npx @genclass/runtime init --yes         # no questions
npx @genclass/runtime init --dry-run     # show the diff, write nothing
npx @genclass/runtime remove             # undo exactly what init added
```

Other flags: `--no-install`, `--no-devtools`, `--cwd <dir>`, `--cdn <url>` and `--no-sri` (plain HTML),
`remove --keep-package`.

- **What `init` edits.** It only edits browser apps. It stops and says why for a Node server, a library (a UI
  framework as a peer dependency, or an `exports`, `module`, `types` or `bin` field), or an entry file that imports
  Node-only modules.
- **What `remove` deletes.** Only what `init` wrote, including lines a formatter rewrapped. If you edited a marked
  line or block, it changes nothing and lists where.

Tested end to end on fresh projects from each framework's own generator: Vite 8 (React with npm and pnpm, Vue,
Svelte), Next.js 16.4 (App and Pages Router, plus the paths for Next < 15.3), Create React App 5, SvelteKit, Astro,
Nuxt 4.6, React Router 8 (framework mode), Angular 20 and plain HTML. In all 15 projects:

- the app built and ran in Chromium after `init` (production build where the project has one);
- the model loaded in a worker, the overlay appeared only in development, and a warm load had no console errors;
- `remove` left every file byte-identical to the scaffold (node_modules, lockfiles and build output excluded).

Remix, Solid, Preact and Next.js before 15.3 are detected but were not scaffolded with their own generators.
Details: [test/install/RESULTS.md](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/packages/runtime/test/install/RESULTS.md).
Those runs predate observe becoming the default and the `init` / `remove` fixes in this version (`--mode`, formatter
handling, server and library detection). The fixes are covered by unit tests; the scaffolds have not been re-run.

**2. One import** (any bundler), first in your entry file so stores created at import time see the runtime:

```ts
import "@genclass/runtime/auto";          // observe (the default)
import "@genclass/runtime/auto/guard";    // or guard
import "@genclass/runtime/auto/heal";     // or heal (experimental)
import "@genclass/runtime/auto/observe";  // observe, explicitly

import rt from "@genclass/runtime/auto";  // the same, and the runtime it started
```

Optional page configuration, read once: `<meta name="genclass" content="mode=guard, devtools=local">` or
`window.GENCLASS_CONFIG = { mode: "guard", devtools: true }` (any `InitOptions`), set before the import runs. During
SSR or in Node, `/auto` installs nothing and returns an inert runtime.

**3. One script tag** (no build step), first in `<head>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime" data-mode="observe" data-devtools="local"></script>
```

It exposes `window.GenClass` and loads the model worker, ONNX Runtime Web and the overlay on demand from the same
version on the CDN. `data-mode` takes `observe` (the default), `guard` or `heal`; `data-devtools="local"` shows the
overlay only on localhost; `data-manual` skips the automatic `GenClass.init()`. Pin a version in production
(`https://cdn.jsdelivr.net/npm/@genclass/runtime@0.1.0-beta.2`); the plain-HTML path of `init` writes a pinned
jsDelivr URL with SRI.

**4. By hand:**

```bash
npm install @genclass/runtime
```

```ts
// first thing in your entry file
import { GenClass } from "@genclass/runtime";

const rt = GenClass.init(); // observe; GenClass.init({ mode: "guard" }) to let it act
```

The unscoped name `genclass-runtime` is not published; use `npx @genclass/runtime`.

## Why it's an easy yes (measured)

These hold for the runtime; whether the model's decisions are good is a separate question (see
[Model quality](#model-quality)).

- **It is not expected to make a working app worse.** Decisions about responses happen at the network boundary,
  which looks like ordinary latency to your app, and the default never holds or reorders your app's own store
  writes. With a model that never intervenes (heal mode, compared against observe mode), GenClass changed the
  outcome in **0 of 396** clean runs across **66 real apps in 23 frameworks** (React, Vue, Svelte, Solid, Angular,
  Ember, Elm, Lit, Redux, Zustand, MobX, TanStack Query and more, including 14 unmodified open-source RealWorld
  front-ends), 6 seeds each. What that check does and does not compare is under [Model quality](#model-quality).
- **Normal traffic costs little.** Facts are computed for every write and request; the model is consulted only for
  salient situations. Clean in-order typeahead makes no model calls and holds nothing. A keystroke write to a store
  holding a 5,000-item array takes about 0.22 ms.
- **The model runs in the browser.** It runs locally in a Web Worker on WebGPU or WASM and is cached after the
  first load: no inference server, no API key, and decisions never wait on the network. Anonymous diagnostics about
  its decisions (redacted situation text included) are sent to the GenClass maintainers by default; one option turns
  that off (see [Privacy and telemetry](#privacy-and-telemetry)). Typed values of password and payment fields are
  never recorded (other redaction has gaps).
- **You can see what it did.** Every detection and action gets one plain-English console line with the evidence
  behind it, and `rt.explain(id)` shows exactly what the model read. Discards and rollbacks can be undone; responses
  it changed carry an `x-genclass` header.
- **Off in one step.** `?genclass=off` in the URL installs nothing, and observe (the default) never changes
  execution.
- **Small.** The main entry is about 83 KB gzip (minified, without the optional devtools). The default model is
  10.2 MB on WASM (13.6 MB fp16 on WebGPU with `shader-f16`), downloaded once at idle and cached.

## Modes

| mode | what it does | non-passive actions |
|---|---|---|
| `observe` (**default**) | Finds and reports what it sees and what it would have done. Never holds a request or a response, never runs an action. | none |
| `guard` (opt-in) | Also prevents failures with minimal, reversible guard-tier actions: `discard`, `defer`, `coalesce`, `delay` (drop a stale response, reuse a duplicate's result, back off). Only when the model's gate says acting beats doing nothing (with model 0.2.0 at `balanced`: about 90% sure). | guard tier |
| `heal` (**experimental**) | Also recovers: `retry`, `serve_cached`, `block`, `hedge`, `rollback`, `resync`, plus your own actions. | guard + heal tier |

## How eager should it be?

Once you opt into `guard` or `heal`, GenClass only acts when the model is confident enough. You choose how confident:

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
GenClass.init({ mode: "guard" });
```

- **Where the thresholds come from.** They were fitted on held-out dev data, including the model's own on-policy
  traffic, and ship in the model's `meta.json`
  ([model card](https://www.npmjs.com/package/@genclass/runtime-model)). A model without a `gate` gets the
  runtime's defaults: report 0.6, guard 0.9, heal 0.8. `policy.thresholds: { report, guard, heal }` overrides both.
  `rt.gates(trigger)` shows the values in force and where each came from (`"policy"`, `"model"` or `"default"`).
- **Detections.** In every mode, a decision is reported as a detection when its top diagnosis is not `expected` and
  its probability is at least the report threshold of the active profile: 0.95 / 0.90 / 0.70 for cautious /
  balanced / eager with the default model.
- **Limits.** Actions are limited to 60 per minute overall, 10 per minute on the same subject and 200 per session
  (`policy.actionLimits`). A held decision that misses the
  hold budget runs the passive action; a background write decision can still revert the write late.
- **Control.** The `allow` / `deny` lists are in `policy`. Switch at runtime with `rt.setMode(mode)`, or stop
  consulting the model with `rt.pause()` / `rt.resume()`.

**The default changed.** `0.1.0-alpha.0` and `0.1.0-beta.1` defaulted to `guard`. Now `GenClass.init()` with no `mode` (and
`@genclass/runtime/auto`, and the script tag without `data-mode`) observes only; pass `mode: "guard"` to let it act.

**Kill switch.** Append `?genclass=off` to the URL, or set `localStorage.genclass = "off"`, and nothing is installed.
`?genclass=observe|guard|heal` (or the same localStorage value) overrides the mode, including the mode of the `/auto`
entries and the script tag.

`GenClass.init()` never throws, and a second call returns the first runtime (its options are ignored). Outside a
browser (SSR, Node) it returns a runtime with no observers and no model. For tests and headless use, call
`createRuntime(options)` instead.

## What it looks for

At a glance (actions other than flagging need `guard` or `heal`):

| situation | example | what GenClass can do |
|---|---|---|
| Stale response | an old search response lands after a newer one | deliver it but drop its writes over newer data, or defer it (guard) |
| Race / conflict | a server echo would overwrite what the user just typed | drop the stale part, defer (guard) |
| Duplicate | a double click sends the same order twice | reuse the first response (`coalesce`, guard) |
| Inconsistent state | the cart total no longer equals the sum of the lines | roll back or resync (heal) |
| Failure pattern | an endpoint fails 5 times in a row | serve the last good response (heal) |
| Transient failure | a one-off 503 | retry (heal) |
| Slow or flooding | 8× slower than usual; a render loop hammering an API | hedge (heal), delay (guard) |
| Unusual behaviour | an operation writes different fields than it usually does | flag; roll back (heal) |
| Your own question | "is now a good moment to start the upload?" | `rt.ask()` / `rt.decide()` |

The runtime decides at nine **triggers**. Only salient ones (a conflict, a repeat, a failure, an anomaly, a broken
relation, an error) reach the model; everything else is a cheap fact computation.

| trigger | when | passive action | other actions (tier) |
|---|---|---|---|
| `delivery` | a fetch/XHR response or a WebSocket/EventSource message is about to reach the app | `deliver` | `discard` (guard): deliver, but drop the writes it makes over newer data · `defer` (guard): wait for related in-flight work, then decide again |
| `request` | a request is about to be sent | `send` | `coalesce`, `delay` (guard) · `block`, `serve_cached` (heal) |
| `failure` | a request failed (network error, timeout, 5xx/429/408) | `deliver` | `retry`, `serve_cached` (heal) |
| `stall` | a request is far slower than usual | `wait` | `hedge`, `serve_cached` (heal) |
| `mutation` | a salient store write that no delivery decision covered | `apply` | `discard`, `defer` (guard), decided in the background |
| `inconsistency` | a learned relation (`total == sum(items[*].price × qty)`) broke at a settled point | `ignore` | `rollback`, `resync` (heal) |
| `transition` | an operation wrote different fields than it usually does | `ignore` | `rollback`, `resync` (heal) |
| `error` | an uncaught error or rejection | `ignore` | `rollback` (heal) |
| `ask` | your own question (`rt.ask`, `rt.decide`) | | |

The model also gives a diagnosis: `expected`, `stale`, `conflict`, `duplicate`, `inconsistent`, `failing`, `slow`,
`overload`, `unusual` or `transient`.

**Delivery decisions (the main change in this version).** GenClass decides about responses and messages *at the
network boundary*, before the app sees them, and never holds or reorders the app's store writes. A delivery is
salient only when:

- a field the response is predicted to write already holds **newer applied data** (an operation that started later
  wrote it since) and no newer request of the same kind is still in flight;
- or it would **revert a pending local change** (an optimistic update whose request is still in flight) to the value
  the user's change replaced;
- or it would **replace text the user typed** after the request started.

The runtime predicts the write set from what the same operation wrote before. For salient candidates it reads the
response body (a clone, at most 256 KB of JSON, waiting at most 100 ms). A response equal to the current values is not
salient. The model then reads facts such as these (real output from the example above):

```
The response has search.results = 1 item ["rea-1"]: neither the current value 1 item ["react-1"], nor the value when #4 started.
In 1 earlier completions of GET /api/search its chain wrote search.results (1 of 1 wrote state).
The response to GET /api/search?q=rea (#4) arrived after 1.80s (200); the app has not seen it yet.
This request comes from user typed "rea" into input "Search" (#3), started 1.80s ago.
```

Clean in-order typeahead and autosave make no model calls and hold nothing (covered by the unit tests). Other facts
cover:

- repeats and multi-clicks;
- failure streaks and failure scope (other endpoints, `navigator.onLine`);
- whether a failed POST may have been applied;
- learned cadences (polling, debounced saves);
- latency against learned baselines;
- values known to be stale;
- read-your-writes.

It catches runtime failures that leave evidence: ordering, staleness, duplicates, broken relations, failure patterns.
It does not catch logic that is consistently wrong, CSS or security bugs, and it never rewrites your code.

## State it can protect

Fetch, XHR, WebSocket, EventSource, DOM user events, errors, navigation, storage, long tasks and timers are observed
automatically, with no code. Store writes are traced (and can be dropped or reverted) only when the store goes
through GenClass. Each option is one line:

```ts
const rt = GenClass.init({ mode: "guard" });

// Built-in atom
const cart = rt.atom("cart", { items: [], total: 0 }, { resync: () => loadCart() });
cart.set((c) => ({ ...c, items: [...c.items, item] }));

// React (uses GenClass.runtime, or the runtime from <GenClassProvider runtime={…}>; plain useState without one)
import { useGenClassState } from "@genclass/runtime/react";
const [results, setResults] = useGenClassState("searchResults", []);

// Redux / Redux Toolkit (put the enhancer last in compose())
import { genclassEnhancer } from "@genclass/runtime/redux";
const store = configureStore({ reducer, enhancers: (e) => e().concat(genclassEnhancer(rt, { name: "app" })) });

// Zustand
import { genclass } from "@genclass/runtime/zustand";
const useBoard = create(genclass(rt, "board")((set) => ({ cards: [], move: () => set(/* … */) })));

// Any store with get/set (and optionally subscribe)
const prefs = rt.guard("prefs", { get: () => store.prefs, set: (v) => store.setPrefs(v) });
```

What each kind of protection needs:

| protection | how | works with |
|---|---|---|
| delivery `discard` | the response is delivered; its chain's writes to the protected fields are dropped synchronously inside each write, and its other fields (loading flags, counts) apply | atoms, `rt.guard`, React state. Redux/Zustand: only when every change of a dispatch is dropped (see [limitations](#known-limitations)) |
| late revert | a background `mutation` decision to `discard` reverts the write if it is at most 2 s old, its fields are unchanged since, and no later write of the same chain followed | any GenClass-aware store |
| `rollback` (heal) | restores the last settled snapshot where every learned relation held | stores GenClass can write (atoms, `rt.guard`, Redux and Zustand adapters) |
| `resync` (heal) | calls your `resync` handler | stores registered with `{ resync }` |

`{ hold: false }` on a store keeps its writes out of the opt-in write holds (`policy.holdWrites: true`, off by
default). The default never holds a store write: `set(x); get()` always returns `x`.

## Ask it questions

The model answers typed questions about what is happening now (the request shape of Jev's System One API):

```ts
const busy = await rt.ask({ type: "noul", instructions: "Is a save in flight or failing?" });
// { type: "noul", noul: <calibrated P(true)> }

const when = await rt.decide("Which upload strategy fits what is happening now?", {
  now: "start the upload immediately",
  later: "wait until the network is calm and the user is idle",
});
// "now" | "later"
```

Without a model (`model: false`, or when it cannot load) both reject with `GenClassUnavailableError` (`reason`:
`off`, `error`, `timeout` or `destroyed`). `{ timeoutMs }` bounds the wait. With the default model, short factual
questions about the current situation work best; it is not a general-purpose reasoner.

Standing questions ride along with built-in decisions: `rt.question({ id, on: ["failure"], question, onAnswer })`.

## Observability

- **Console:** one line per detection and per intervention, with the evidence collapsed below it. Identical repeats
  within a minute are summarised. `report: "silent"` or `report: (r) => …` to route them yourself.
- **Events:** `rt.on("detect" | "decide" | "act" | "event" | "status" | "report", fn)` returns an unsubscribe function.
- **`rt.explain(id)`:** the exact situation text the model read, its facts and timeline, every answer with
  probabilities, and what changed.
- **`rt.decisions()`, `rt.interventions()`, `rt.history()`, `rt.inflight()`, `rt.situation()`** for introspection.
- **Undo, where it exists:** `ActionRecord.undo()` is set for `discard` (delivery and write), late reverts,
  `rollback` and chain reverts, plus custom actions that register `onUndo`. `defer`, `coalesce`, `delay`, `block`,
  `serve_cached`, `retry`, `hedge` and `resync` cannot be undone; their record says what changed.
- **Altered responses** carry an `x-genclass` header: `coalesced`, `cached` or `blocked`.
- **Devtools overlay** with four views: **Interventions** (what GenClass did, with Undo where it exists),
  **Detections** (what it noticed but did not act on), **Activity** (a live log of requests, writes, user actions and
  errors with their causal links) and **Now** (what the model would see at this moment). About 52 KB minified /
  17 KB gzip, so load it in development only (`init` does this for you):

```ts
if (import.meta.env.DEV) {
  const { mountDevtools } = await import("@genclass/runtime/devtools");
  mountDevtools(rt);
}
```

## Extend it

Plugins can add their own observers, facts, actions and questions:

```ts
rt.use({
  name: "sync",
  actions: [{
    name: "pause_sync",
    description: "pause background sync until the page is visible again",
    on: ["failure", "stall"],
    tier: "heal",
    run: (ctx) => { sync.pause(); ctx.describe("Paused background sync."); ctx.onUndo(() => sync.resume()); },
  }],
});
```

Plugins can add observers (`setup`), facts, actions, standing questions and diagnosis labels. The model reads each
action's description. The goal is that clearly described actions work without retraining; this has not been
measured.

## Configuration

GenClass runs with safe defaults (`mode: "observe"`, a `"balanced"` gate that applies once you opt into guard or heal, circuit breaker on). The options below narrow where it acts, cap how much it does, and send findings to your tools. None of them tell the model what a bug looks like. They only scope and limit it.

- **Activation**: `enabled` (a boolean, a predicate, or a subscribable feature flag; while it is false the model is never downloaded), `rt.disable({ undo: true })` (remote kill that also rolls back recent actions), `sample` (the fraction of sessions allowed to act; the rest only observe).
- **Scope**: `routes` (per-route mode and aggressiveness, which can only be lowered), `requests.ignore` (analytics traffic), `requests.protect` (endpoints that are never held, retried, cached or discarded), `requests.labels` (endpoint names for reports), `requests.correlate` (attach your trace id to records).
- **Safety**: `breaker` (automatic downgrade after undos, or after errors that follow an action), `shadow` (records what a higher mode would have done), `onBeforeAction` + `vetoMode` (a synchronous veto, or a report-only trial of one), `policy.actionLimits` (per-minute, per-subject and per-session caps), `policy.holdBudgetMs` (a hard ceiling on added latency).
- **Your own telemetry**: `sinks` (structured, redacted records), `session` (id and tags, never shown to the model), `report: "interventions"` (a quiet production console), `rt.summary()`, `rt.on("shadow" | "breaker" | "limit" | "modelBudget", cb)`.
- **Loading and cost**: `model.loadIf`, `model.threads`, `model.timeoutMs`, `model.maxDecisionsPerMinute`, `model.unloadAfterIdleMs`.

Action limits default to 60 per minute overall, 10 per minute on the same subject (store field or endpoint), and 200 per session.

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

## Model quality

The default model is `genclass-runtime-r17` 2.0.0-rc4t (`@genclass/runtime-model@0.2.0`, run `r17-v2dT`): a
GenClass encoder trained on simulated apps and on real apps driven in headless Chromium. It ships a gain gate (act
only when the model's expected gain over doing nothing clears a margin) with one fitted profile per aggressiveness
level. Held-out test, from
[RESULTS.md §1](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/docs/runtime/RESULTS.md):

| profile | guard false interventions | guard recall (clear / real) | heal false interventions | heal recall (clear / real) | report threshold |
|---|---|---|---|---|---|
| `cautious` | 0.005% | 2.4% / 1.4% | 0.26% | 3.7% / 3.8% | 0.95 |
| **`balanced` (default)** | 0.13% | 7.8% / 7.5% | 0.59% | 7.1% / 10.4% | 0.90 |
| `eager` | 0.54% | 14.2% / 21.0% | 1.84% | 17.1% / 24.2% | 0.70 |

False interventions are on simulated apps; on held-out real apps they were 0.00% for every profile. Our targets are
0.1% (guard) and 0.5% (heal): `cautious` meets both, `balanced` is slightly over both, `eager` trades well over
them for about twice `balanced`'s recall. Pick `cautious` if a wrong intervention costs more than a missed one.

The observe-mode numbers below were measured on the previous model, 0.1.0 (`r17-v2b`, report threshold 0.85), and
have not been re-measured for 0.2.0:

| model 0.1.0 | Simulated apps | Real apps |
|---|---|---|
| Diagnosis accuracy | 84.2% | 83.6% |
| Action accuracy | 77.8% | 80.0% |
| **Observe:** decisions flagged where nothing was wrong (report 0.85) | 1.41% (149 / 10,582) | 3.78% (305 / 8,079); 1.05% without one app |
| Observe: problem decisions flagged | 65% | 61% |
| Observe: flags with the right diagnosis | 94% | 89% |

What this means in practice:

- **Observe (default).** Expect roughly 1 to 4 false flags per 100 decisions where nothing was wrong (model 0.1.0;
  `cautious` raises the report threshold to 0.95, `eager` lowers it to 0.70).
  - In one held-out real app, `oss-rtk-conduit`, the model flagged 25% of clean decisions as `stale`, all on its
    `article.inProgress` field. A single recurring pattern in your app can do the same.
  - Each flag names its evidence, and identical lines within a minute are summarised.
  - Raise `policy.thresholds.report` to see fewer flags. At 0.9: 0.9% (simulated) and 3.4% (real) false, with 58% and
    52% of problems flagged.
- **Guard (opt-in).** When it acts, it is almost always right, but it rarely acts. Expect it to miss most problems.
  `balanced` is slightly above the 0.1% false-intervention target; `cautious` is under it.
- **Heal (experimental).** At `balanced`, 0.59% of heal interventions were wrong on simulated apps (target 0.5%);
  with model 0.1.0, heal actions on failures (`retry`, `serve_cached`) were its least precise actions.
- **Not yet met:** diagnosis ≥ 95%, clear-case recall ≥ 80%, and false flags ≤ 1% on held-out data. Training
  continues (a larger teacher model, distillation, more real-app data).
- **Format.** The model was trained on situations rendered by the runtime at `situation-v2`. This version renders
  `situation-v2.3`:
  - an extra stall fact;
  - `retry` offered only when safe;
  - fewer learned relations;
  - redacted values printed differently.

  The retry change is accounted for in the numbers above; the others were not measured.

**Round 1** (previous format `situation-v1`, not compatible with this runtime): R17 reached 90.5% diagnosis and 81.9%
action accuracy on held-out simulated apps, with 0.05% / 0.24% guard / heal false interventions, but acted on only
7.7% of clear cases. The analysis found the limit was in the situation text and the labels, not the model size. The
v2 format adds measured facts for those cases, with relabelled data.

The "never make a correct app worse" check uses an always-passive model in heal mode, compared against observe mode,
on 66 real apps (6 seeds each), with the v2 runtime as of `0.1.0-alpha.1` (not re-run on this version).
**0 of 396 clean runs** changed, measured on final page text (inputs and alerts
excluded) and server state. The check does not compare request timing or store contents, and it does not compare
observe mode against running without GenClass. With network chaos, 3 of 198 runs differed: a request held about
25 ms changed the simulated network's draws. Details:
[RESULTS.md §4](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/docs/runtime/RESULTS.md).

## Performance

- **Most work never reaches the model.** Facts are computed for every write and request. Measured by the perf tests
  on a shared VM:

  | operation | time |
  |---|---|
  | keystroke write into a store holding a 5,000-item array | 0.22 ms |
  | Redux-style dispatch on 5,000 entities | about 0.7 ms |
  | settled-point check | 0.3 ms |

- **Bundle:** the main entry is about 240 KB minified / 83 KB gzip, measured with esbuild and onnxruntime-web
  external. ONNX Runtime Web (the only dependency) is loaded by the model worker on demand: about 2.7 MB brotli for
  the WASM-only path, 4.7 MB with WebGPU. The script-tag file is about 255 KB / 86 KB gzip without ONNX
  Runtime; its model worker (16 KB gzip) and ONNX Runtime glue (25–39 KB gzip) load on demand.
- **Model:** the default model is 9.6 MB (q8, pruned 16k vocabulary) on WASM and 13.6 MB (fp16) on WebGPU with
  `shader-f16`. With onnxruntime-web 1.30 on single-thread WASM, measured in Node on the training VM, a forward pass
  took about 176 / 320 / 583 ms at 500 / 780 / 1,170 tokens (p50 315 ms on runtime-sized requests). Single-thread
  WASM uses the smallest situation budget (1,000 characters, about 500 tokens with the questions).
- **Holds are bounded.** A held response or request waits at most the hold budget, then proceeds unchanged. The
  default `"auto"` budget is 1.5 × the median of the last 20 model latencies, clamped to 150–800 ms; it is 300 ms
  before any latency is known.
  - A hold happens only if the model is expected to answer within the budget.
  - Reading a response body for salience adds at most 100 ms.
  - Background (non-held) decisions have a 5 s deadline.
- **Situation size by device:** 2,400 characters on WebGPU; on WASM, 1,000 (1 thread) to 2,000 (4 threads).
  Override with `situation: { budget }`.
- **Threads:** serving the page with `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` enables WASM threads (about 3× faster with 4 threads in Chromium,
  measured with the round-1 model of the same size).
- **Loading:** the model loads at idle after page load (`model.preload: "idle"`) from
  `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.2.0/files/`. It is cached in Cache Storage and checked
  with sha256. To self-host, `npx @genclass/runtime fetch-model public/genclass-model` downloads it, and
  `model: { baseUrl: "/genclass-model/" }` points the runtime at it. `model: false` loads no model (nothing is
  detected or prevented then).

## Privacy and telemetry

- **The model runs locally.** Situations are built and decided in the browser; no app data is sent anywhere to make
  a decision. The default configuration downloads the model files (and ONNX Runtime's WASM when the model loads)
  from cdn.jsdelivr.net. `model.baseUrl` and `model.ortWasmPaths` self-host them; `model: false` loads nothing.
- **Anonymous diagnostics (telemetry) are on by default** with `GenClass.init()` in a browser (since
  `0.1.0-beta.3`; off in Node/SSR and with `createRuntime()` unless enabled). They go to the GenClass maintainers'
  collector (a Cloudflare Worker storing to a private R2 bucket) to measure and improve the model. The console says
  so once per page. Full list and schema: [TELEMETRY.md](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md).
  - **Sent:** a random per-page session id (not stored, no cookies), runtime and model versions, mode,
    aggressiveness, device class (WebGPU, cores, WASM threads, model load time), the page's hostname and its path
    with ids replaced (no query or fragment); for every decision the trigger, **the redacted situation text the model
    read**, its calibrated answers, the diagnosis, the gate threshold and its source, what ran, latency and whether
    the subject waited; action outcomes (applied, failed, undone, late revert, veto), detections, model errors,
    fail-open counts and periodic counts.
  - **Never sent:** typed values of password, payment or secret fields, cookies, headers, request or response
    bodies, storage contents, query strings, your app's error messages. The collector adds the receive time and a
    two-letter country, and stores no IP address or user agent.
  - **Situation text can still contain app data** the redactor does not recognise as secret (a product name, a
    search term). `telemetry: { include: { situation: false } }` keeps the text out; `redact` hides more.
  - **Opt out** (any one): `GenClass.init({ telemetry: false })` (also `telemetry=off` in the meta tag or
    `data-telemetry="off"` on the script tag), `?genclass=no-telemetry` (or `?genclass=off`) in the URL,
    `localStorage.setItem("genclass.telemetry", "off")`. Browsers that send **Global Privacy Control**
    (`navigator.globalPrivacyControl`) are never collected, as California's CCPA/CPRA requires for opt-out signals.
  - **If you ship GenClass**, the data comes from your users' browsers: you may need to mention it in your privacy
    policy and, where you need consent for analytics (GDPR/ePrivacy), start with `telemetry: false` until consent.
    Retention, the maintainers' privacy policy and data processing terms are not published yet.
  - `telemetry: { endpoint, sample, flushMs, maxBatch, include }` sends to your own collector, samples page loads,
    or tunes batching. `runtime.telemetry` tells whether it is on and why not.
- **Inputs:** typed values of password fields, `cc-*` / `one-time-code` / password autocomplete fields, and fields
  whose name or label names a secret are never recorded.
- **Redaction:** the default redactor (`redact` option) works by the leaf field's meaning, not by substring.
  - Redacted: `auth.token`, `form.password`, `users.3.password`, `payment.card.number`, `settings.apiKey`, and
    opaque credential-like strings under `auth` / `session` / `cookie`.
  - Under a container named for a secret, strings, numbers and arrays are all redacted: `payment.cvv.value = 123`,
    `login.otp.code`, `account.password.history = [...]`. A side effect: numbers under a container whose name is
    a secret word in another sense are hidden too (`map.pin.lat`).
  - Visible: `auth.loading`, `auth.user.name`, and a kanban `card`.
  - Booleans and null are never redacted.
  - Query parameters are redacted by the same rule.
  - The "would replace text the user typed" fact shows a character diff only when the redactor leaves both values
    unchanged; otherwise it prints `[redacted] → [redacted]` (or your redactor's replacement).
  - Pass your own `redact(path, value)` for app-specific secrets or PII. The default has gaps (see below).
  - The container rule for numbers and arrays and the typed-text rule are new in `0.1.0-beta.0` (missing from
    `0.1.0-beta.1`, back in `0.1.0-beta.2`).

## Known limitations

- **The model is new and imperfect.** The numbers are under [Model quality](#model-quality).
  - In observe mode, expect some false flags: 1–4 per 100 decisions where nothing was wrong, more in some apps.
  - It misses most problems.
  - It was not evaluated on your app.
  - Heal-mode actions on failures (`retry`, `serve_cached`) are its least precise actions.

  Watch observe mode before turning on `guard` or `heal`.
- **Redaction gaps (all modes with a model).**
  - A container named by a two-word secret (`cardNumber`, `apiKey`, `creditCard`) counts as broad, like `auth`.
    So `payment.cardNumber.value = "4111 1111 1111 1111"`, or the same number, is shown. It reaches the situation
    text, `explain()`, the console evidence and devtools, though never the network. A leaf with such a name
    (`settings.apiKey`) is redacted.
  - The fact "X changed since #N started and is back to V" compares the rendered text, so two different redacted
    values read as "back to [redacted]".

  Pass a custom `redact`, and avoid keeping secrets in observed stores.
- **Redux/Zustand discard.** If a stale response's dispatch also changes other fields, a delivery `discard` applies
  the whole dispatch. The `ActionRecord` still reports the stale fields as dropped. Atoms and `rt.guard` stores drop
  only the stale fields, as intended.
- **The discard mark lasts 10 s.** After a `discard`, writes by operations chained from the discarded one (a
  `setTimeout`-driven poll, a saga) to the protected fields are also dropped for 10 s, even when they carry fresh
  data. The marks also outlive `rt.pause()` and `setMode("observe")`.
- **`defer` can wait long.** A delivery may be deferred twice, each time until the related operations finish or
  10 s pass. A deferred WebSocket/EventSource message holds back the messages queued behind it.
- **Held messages after `close()`.** A WebSocket/EventSource message held for a decision is still dispatched if
  the app closed the socket meanwhile. EventSource `open` events are not kept in order behind held messages.
- **XHR listeners of a held response** run after the original dispatch, so `e.currentTarget` is `null`. Use the
  `xhr` object itself.
- **`retry` (heal) trusts HTTP semantics.** It is offered for idempotent methods, and for POST / PATCH only when
  the request carries an idempotency key (`policy.idempotencyHeaders`, default `Idempotency-Key`,
  `X-Idempotency-Key`). An endpoint that is not idempotent despite its method (a `PUT` that appends) can still be
  retried. HTTP 502 is described as usually not processed, which is not always true behind proxies.
- **Transport coverage.** `coalesce`, `retry`, `hedge` and failure/stall `serve_cached` are fetch-only. XHR
  failures and stalls are detection-only.
- **Synthetic events.** DOM events with `isTrusted === false` (`el.click()`, `dispatchEvent`, in-page test
  drivers) are not user actions unless you pass `observe: { untrustedEvents: true }`.
- **`policy.holdWrites: true` (opt-in).** A held write that a later write flushed early can be recorded as dropped
  while it stays applied.
- **Causality** across `await` is tracked by instrumenting fetch, XHR, timers, message events and Response bodies.
  This is best effort; wrap important work in `rt.op(name, fn)` for exact attribution.
- **Store state** is visible and protectable only through GenClass-aware stores. Other state is seen only through
  its effects.
- **Install and CDN.**
  - **Read the diff.** Always read the diff `init` and `remove` show before you confirm.
  - **SRI covers only the script-tag file.** The model worker, ONNX Runtime glue and overlay it loads from the CDN,
    and the model files, are not integrity-checked by the browser. The runtime checks the model files against the
    sha256 values in `model.json`. Pin a version, or self-host.
  - **Page configuration is read from every `<meta name="genclass">` in the document**, including the body, and it
    may set the mode and the model and ONNX Runtime URLs. On a page that renders untrusted HTML which can include
    `<meta>` tags, set those keys in `window.GENCLASS_CONFIG` (it overrides meta tags), or call
    `GenClass.init(options)` instead of importing `/auto`.
  - **React Router dev server.** On the very first dev start after `init`, Vite discovers the new imports late,
    re-optimizes and reloads the page, logging a few "Outdated Optimize Dep" errors once. Later loads are clean.
  - **Not re-run end to end.** The end-to-end scaffold runs predate this version's `init` / `remove` changes, which
    are covered by unit tests only.
- **The model can be wrong.** It is trained on simulated apps and real apps driven in a headless browser. It is not
  a substitute for tests. That is why the default only observes, guard acts only above thresholds fitted to keep
  false interventions at or below 0.1% on data the model never trained on, and every action is logged.

## License

Apache-2.0. The model package, `@genclass/runtime-model` (Apache-2.0), comes with its own
[model card](https://www.npmjs.com/package/@genclass/runtime-model).
