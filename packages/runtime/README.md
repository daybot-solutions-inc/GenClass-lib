# @genclass/runtime

[![npm](https://img.shields.io/npm/v/@genclass/runtime/latest?label=npm)](https://www.npmjs.com/package/@genclass/runtime)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![runs](https://img.shields.io/badge/runs-100%25%20in%20the%20browser-brightgreen)

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

> **Status: alpha. No trained model is published yet, so today the runtime finds nothing.**
>
> - The runtime, model host, devtools overlay and React/Redux/Zustand adapters are built and unit-tested.
> - The model for this runtime's situation format (`situation-v2`) is still in training.
>   `@genclass/runtime-model` is not on npm, so the default model URL returns 404. A default `GenClass.init()`
>   prints `[GenClass] Model unavailable (...); observing only.`, consults no model, records no detections and takes
>   no actions. It still traces, learns baselines and answers `rt.situation()`; `rt.ask()` / `rt.decide()` reject
>   with `GenClassUnavailableError`.
> - The only trained models so far (round 1) read the previous format (`situation-v1`) and do not match this
>   runtime. Do not self-host them with this version.
> - **Versions.** `0.1.0-alpha.1` is the current `latest` on npm: the v2 runtime, observe by default, with the
>   `NaN` fix. It does **not** include the one-command install, the `@genclass/runtime/auto` entries or the script
>   tag described under [Install](#install). It also lacks two fixes made since: observe mode no longer holds or
>   delays any response, and two redaction leaks are closed (see [Privacy](#privacy)). All of these are in this
>   repository and ship in the next release: `0.1.0-beta.0` with the model, or `0.1.0-alpha.2` if a release
>   without the model goes out first.
>   `0.1.0-alpha.0`, the first version on npm, is the older v1 runtime: guard by default, holds store writes, and
>   can crash when app state contains `NaN`. Do not use it.
>
> Progress: [OPEN_TASKS.md](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/OPEN_TASKS.md) ·
> measured results: [RESULTS.md](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/docs/runtime/RESULTS.md).

## Contents

[Install](#install) · [Why it's an easy yes](#why-its-an-easy-yes-measured) · [Modes](#modes) ·
[What it looks for](#what-it-looks-for) · [State it can protect](#state-it-can-protect) ·
[Ask it questions](#ask-it-questions) · [Observability](#observability) · [Extend it](#extend-it) ·
[Model quality](#model-quality) · [Performance](#performance) · [Privacy](#privacy) ·
[Known limitations](#known-limitations) · [API reference](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/docs/runtime/API.md)

## What it looks like

Run your app as usual. When the model flags something, the console gets one plain-English line per detection or
intervention, followed by a collapsed group with the evidence. This is real output of the runtime in guard mode for
an out-of-order search response. A scripted stand-in decider supplied the answer (`stale`, `discard`, 0.97), since no
trained model exists yet:

```
[GenClass] Prevented a stale response: search.results was written once by other operations since its operation (#4)
started (version 1 → 2), last 0.40s ago by GET /api/search?q=react (#6), which started 1.30s after #4, from a later
user action (#5). Delivered the response to GET /api/search?q=rea (#4) and dropped the state changes it makes over
newer data (search.results). (stale, 0.97; discard 0.97)
```

In observe mode the response reaches the app at once, exactly as without GenClass, and the same decision is made
in the background, for the report only:

```
[GenClass] Flagged a stale response: search.results was written once by other operations since its operation (#4)
started (version 1 → 2), … Not acted on (would have done discard 0.97): observe mode never changes execution. (stale, 0.97)
```

## Install

### Today: `0.1.0-alpha.1` (npm `latest`)

```bash
npm install @genclass/runtime
```

```ts
// first thing in your entry file
import { GenClass } from "@genclass/runtime";

const rt = GenClass.init(); // observe; GenClass.init({ mode: "guard" }) to let it act once a model exists
```

### Next release: one command, one import or one script tag

These three paths are built and tested in this repository but are **not in `0.1.0-alpha.1`**; they ship in the next
release. All three start the same runtime, in observe mode unless you choose otherwise.

**1. One command.** `init` finds your framework and package manager, installs the package, adds one import as the
first line of your entry file (plus a line that loads the devtools overlay in development only), and shows you the
diff before writing anything. Running it again changes nothing.

```bash
npx @genclass/runtime init            # shows the diff, asks, then writes
npx @genclass/runtime init --yes      # no questions
npx @genclass/runtime init --dry-run  # show the diff, write nothing
npx @genclass/runtime remove          # undo exactly what init added
```

Other flags: `--no-install`, `--no-devtools`, `--cwd <dir>`, `remove --keep-package`. `init` sets up observe mode;
to let GenClass act, change the import it added to `@genclass/runtime/auto/guard` (see the next path). Do this by
hand for now: `init --mode guard` still writes the observe import (see
[Known limitations](#known-limitations)).

Tested end to end on fresh projects from each framework's own generator: Vite 8 (React with npm and pnpm, Vue,
Svelte), Next.js 16.4 (App and Pages Router, plus the paths for Next < 15.3), Create React App 5, SvelteKit, Astro,
Nuxt 4.6, React Router 8 (framework mode), Angular 20 and plain HTML. In all 15 projects the app built and ran in
Chromium after `init` (production build where the project has one; model loaded in a worker, overlay only in
development, no console errors on a warm load), and `remove` left every file byte-identical to the scaffold
(node_modules, lockfiles and build output excluded).
Remix, Solid, Preact and Next.js before 15.3 are detected but were not scaffolded with their own generators.
Details: [test/install/RESULTS.md](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/packages/runtime/test/install/RESULTS.md).
Those runs predate the switch to observe as the default; the files `init` writes are the same.

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
overlay only on localhost; `data-manual` skips the automatic `GenClass.init()`. Pin a version in production (the
plain-HTML path of `init` writes a pinned jsDelivr URL with SRI). Until the next release, the unversioned URL serves
`0.1.0-alpha.1`, which has no script-tag build.

`npx genclass-runtime init` will be a short alias for the same CLI (the `genclass-runtime` package, not on npm yet).

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
- **No app data leaves the browser.** The model runs locally in a Web Worker on WebGPU or WASM and is cached after
  the first load. No telemetry, no server, no API key. Typed values of password and payment fields are never
  recorded (other redaction has gaps; see [Privacy](#privacy)).
- **You can see what it did.** Every detection and action gets one plain-English console line with the evidence
  behind it, and `rt.explain(id)` shows exactly what the model read. Discards and rollbacks can be undone; responses
  it changed carry an `x-genclass` header.
- **Off in one step.** `?genclass=off` in the URL installs nothing, and observe (the default) never changes
  execution.
- **Small.** The main entry is about 83 KB gzip (minified, without the optional devtools). The only round-1 model
  export so far is 9.6 MB; the size of the coming `situation-v2` model is not known yet.

## Modes

| mode | what it does | non-passive actions | gate |
|---|---|---|---|
| `observe` (**default**) | Reports what it sees and what it would have done. Never holds a request, never runs an action. | none | n/a |
| `guard` (opt-in) | Also prevents failures with guard-tier actions: `discard`, `defer`, `coalesce`, `delay`. These withhold, deduplicate or slow something down. | guard tier | summed probability of the permitted actions ≥ 0.9, and the top diagnosis is not `expected` |
| `heal` (**experimental**) | Also recovers: `retry`, `serve_cached`, `block`, `hedge`, `rollback`, `resync`, plus your own actions. | guard + heal tier | guard actions ≥ 0.9, heal actions ≥ 0.8, diagnosis not `expected` |

```ts
GenClass.init({ mode: "guard" });
```

In every mode, a decision is reported as a detection when its diagnosis is not `expected` at confidence ≥ 0.6. Actions
are also limited to 60 per minute (`policy.maxActionsPerMinute`). A held decision that misses the hold budget runs
the passive action; a background write decision can still revert the write late. Thresholds and the `allow` / `deny`
lists are in `policy`. Switch at runtime with `rt.setMode(mode)`, or stop consulting the model with `rt.pause()` / `rt.resume()`.

**The default changed.** `0.1.0-alpha.0` defaulted to `guard`. Now `GenClass.init()` with no `mode` (and
`@genclass/runtime/auto`, and the script tag without `data-mode`) observes only; pass `mode: "guard"` to let it act.

**Kill switch.** Append `?genclass=off` to the URL, or set `localStorage.genclass = "off"`, and nothing is installed.
`?genclass=observe|guard|heal` (or the same localStorage value) overrides the mode, including the mode of the `/auto`
entries and the script tag.

`GenClass.init()` never throws, and a second call returns the first runtime (its options are ignored). Outside a
browser (SSR, Node) it returns a runtime with no observers and no model. For tests and headless use, call
`createRuntime(options)` instead.

## What it looks for

At a glance (actions other than flagging need `guard` or `heal`, and a published model):

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

Without a model (today, or with `model: false`) both reject with `GenClassUnavailableError` (`reason`: `off`,
`error`, `timeout` or `destroyed`). `{ timeoutMs }` bounds the wait.

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

## Model quality

There are no numbers yet for a model that matches this runtime.

**Round 1 (previous format, `situation-v1`)**, R17 on held-out simulated apps:

| metric | value |
|---|---|
| diagnosis accuracy | 90.5% |
| action accuracy | 81.9% |
| guard false-intervention rate | 0.05% |
| heal false-intervention rate | 0.24% |
| calibration error | 0.009 |
| recall on clear stale/duplicate cases | 7.7% |

R17 was precise but timid. The analysis found the limit was in the situation text and the labels, not the model
size: many clear cases had benign twins with identical visible facts, and some labels were wrong.

**Round 2 (`situation-v2`, this runtime)** adds measured facts aimed at those twins, plus relabelled data. The data is
generated from simulated apps (10.4M labelled rows and 51.3M unlabeled rows for teacher labelling), rows from real
apps driven in headless Chromium are being added, and the models are training now. Results will be published with the model package.

The "never make a correct app worse" check uses an always-passive model in heal mode, compared against observe mode,
on 66 real apps (6 seeds each). **0 of 396 clean runs** changed, measured on final page text (inputs and alerts
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
  the WASM-only path, 4.7 MB with WebGPU. The script-tag file (next release) is 255 KB / 86 KB gzip without ONNX
  Runtime; its model worker (16 KB gzip) and ONNX Runtime glue (25–39 KB gzip) load on demand.
- **Model size:** the round-1 R17 export (pruned 16k vocabulary, int8) is 9.6 MB. On single-thread WASM it took about
  0.18 s per decision on a 500-token situation, measured in Node.
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
  measured with a round-1 model).
- **Loading:** the model loads at idle after page load (`model.preload: "idle"`). It is cached in Cache Storage and
  checked with sha256. `model: { baseUrl }` points at a self-hosted model directory
  (`npx @genclass/runtime fetch-model <dir>` downloads one); there is none for this runtime yet.

## Privacy

- **No app data leaves the browser.** No telemetry, and the model runs locally. The default configuration downloads
  the model files (and ONNX Runtime's WASM when the model loads) from cdn.jsdelivr.net. `model.baseUrl` and
  `model.ortWasmPaths` self-host them; `model: false` loads nothing.
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
  - The container rule for numbers and arrays and the typed-text rule are fixes made after `0.1.0-alpha.1`; they
    ship in the next release.

## Known limitations

**Today.** Without a published model nothing is detected or prevented (see Status). The bullets below matter once a
model ships and you opt into `guard` or `heal`, unless a bullet says otherwise.

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
- **`retry` (heal) does not check idempotency.** It is offered for any replayable fetch, POST included. The model
  sees whether the method is idempotent and whether the failed request may have been applied. HTTP 502 is
  described as usually not processed, which is not always true behind proxies.
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
- **Next-release install (`init`, `remove`, `/auto`, script tag).** Known issues, to be fixed before or in that
  release. Always read the diff `init` and `remove` show before you confirm.
  - **`init --mode guard` installs observe.** It prints `Mode guard`, but writes the plain `@genclass/runtime/auto`
    import (or a script tag without `data-mode`), which observes. Plain `init` also prints `guard` as the
    default. Change the import to `@genclass/runtime/auto/guard` yourself.
  - **Running `init` again with another `--mode`** reports "Nothing to do" and leaves the existing import alone.
  - **TypeScript with `"moduleResolution": "node"`** (Create React App TypeScript, older templates) cannot find the
    types of `@genclass/runtime/auto`, `/devtools` or `/react` (TS2307), so the type check, and with it a CRA
    build, fails after `init`. `"moduleResolution": "bundler"` works.
  - **Server and library projects.** A project that lists esbuild, rollup, parcel or webpack is treated as a
    browser app, so `init` can add the import to a Node server's or a library's entry file.
  - **Formatters.** If a formatter rewraps a line `init` added (the dev-only devtools line, or the one-line form
    in a Next.js layout), `remove` takes out only part of it and leaves code that does not compile. Fix the file
    by hand.
  - **What `remove` deletes.** Code you added inside a block `init` marked goes with the block; a file `init`
    created is one such block and is deleted whole. If a block's end marker is missing, everything after its start
    marker goes. Any other line that contains `genclass:init` goes too. It uninstalls the package unless it finds
    an import in your sources, and it does not look in dot-folders (`.storybook`), `tmp`, `out` or `build`. Use
    `remove --keep-package` when you import GenClass there.
  - **`init --cdn <url>`** adds an SRI hash of the CLI's own copy of the file, whatever version the URL names. With
    `@latest` or another version, the browser refuses the script. Pass `--no-sri`.
  - **SRI covers only the script-tag file.** The model worker, ONNX Runtime glue and overlay it loads from the CDN
    are not integrity-checked.
  - **Page configuration is read from every `<meta name="genclass">` in the document**, including the body,
    and it may set the mode and the model and ONNX Runtime URLs. On a page that renders untrusted HTML which can
    include `<meta>` tags, set those keys in `window.GENCLASS_CONFIG` (it overrides meta tags), or call
    `GenClass.init(options)` instead of importing `/auto`.
  - **React Router dev server.** On the very first dev start after `init`, Vite discovers the new imports late,
    re-optimizes and reloads the page, logging a few "Outdated Optimize Dep" errors once. Later loads are clean.
- **The model can be wrong.** It is trained on simulated apps and real apps driven in a headless browser. It is not
  a substitute for tests. That is why the default only observes, guard acts only at ≥ 0.9, and every action is
  logged.

## License

Apache-2.0. The model package, once published, comes with its own model card.
