# Interception surface

Everything `@genclass/runtime` wraps, replaces or listens to in a page, what each mode may change, what it never
does, how every action can be undone, and how everything is put back. The source is the code; each row names the file
and function. `test/interception.test.ts` checks this page against the code: it installs the runtime on a synthetic
browser global, compares what changed with the inventory at the end of this page, checks that `destroy()` restores it,
and counts the patch sites in `src/` (a new `addEventListener`, `defineProperty` or global assignment fails the test
until this page is updated).

Related: [THREAT-MODEL.md](../../docs/runtime/THREAT-MODEL.md) (what an attacker could do with this surface),
[SECURITY.md](../../SECURITY.md), [TELEMETRY.md](TELEMETRY.md) (what leaves the page),
[OPTIONS-SPEC.md](../../docs/runtime/OPTIONS-SPEC.md) (every option), [API.md](../../docs/runtime/API.md).

## Contents

- [At a glance](#at-a-glance)
- [Globals and prototypes it replaces](#globals-and-prototypes-it-replaces)
- [Event listeners it adds](#event-listeners-it-adds)
- [Objects it instruments after handing them to the app](#objects-it-instruments-after-handing-them-to-the-app)
- [Automatic state discovery (React, Redux, Zustand)](#automatic-state-discovery-react-redux-zustand)
- [Stores you register](#stores-you-register)
- [Other side effects](#other-side-effects)
- [What each mode may change](#what-each-mode-may-change)
- [What it never does](#what-it-never-does)
- [Actions: preconditions and reversibility](#actions-preconditions-and-reversibility)
- [Money and identity flows](#money-and-identity-flows)
- [Turning it off and restoring the page](#turning-it-off-and-restoring-the-page)
- [Audit trail](#audit-trail)
- [Machine-checked inventory](#machine-checked-inventory)

## At a glance

| Mode | Wraps and listens | Holds (adds latency) | Changes what the app sees |
|---|---|---|---|
| `?genclass=off`, `enabled: false` | nothing | never | never |
| `observe` (default) | everything below | never | never |
| `guard` (opt-in) | everything below | a salient request, response, failure or (with `policy.holdWrites`) store write, up to the hold budget (150 to 800 ms) | only through guard-tier actions: `discard`, `defer`, `coalesce`, `delay` |
| `heal` (experimental) | everything below | as guard | guard-tier plus `block`, `serve_cached`, `retry`, `hedge`, `rollback`, `resync`, custom actions |

Every action needs the model's calibrated probability over the permitted actions to reach the tier threshold, a
diagnosis other than `expected`, and must pass `requests.protect`, cross-origin, route scope, `policy.allow`/`deny`,
action limits, the breaker and `onBeforeAction` ([src/decide/policy.ts](src/decide/policy.ts) `gate`,
[src/runtime.ts](src/runtime.ts) `RuntimeImpl.onDecision`). The model never runs code: it picks a label from the list
of actions the runtime offered for that subject, and a label that was not offered is ignored.

Observers are installed by `RuntimeImpl.installObservers` ([src/runtime.ts](src/runtime.ts)); `observe: { fetch:
false, ... }` leaves any of them out (`timers` defaults to on only when a `document` exists). Each installer is wrapped
in `try/catch`: an installer that throws (a read-only global) is skipped, never fatal.

## Globals and prototypes it replaces

Each wrapper calls the original with the same `this` and arguments and returns its result. After `destroy()` a wrapper
is restored only if it is still the installed value; if another library wrapped it afterwards, GenClass's wrapper
stays in that chain as a pure pass-through (a `disabled` flag), so neither library breaks.

| Global | How | File, function | What it reads | What it may change (guard/heal only) | After `destroy()` |
|---|---|---|---|---|---|
| `window.fetch` | replaced by a wrapper | [src/observe/fetch.ts](src/observe/fetch.ts) `installFetch` | method, URL, header names, a hash of header values (tracing ids excluded), the request body (strings, form data, ≤ 64 KB of a Blob, BufferSource or a cloned `Request` stream) to compute an identity; a clone of each response (≤ 256 KB, ≤ 1 s; never `text/event-stream`) | hold before sending; `coalesce`, `delay`, `block`, `serve_cached` (request); hold a failure, `retry`, `serve_cached` (failure); `hedge`, `serve_cached` (stall); hold a response (delivery `defer`, `discard`) | restored |
| `XMLHttpRequest.prototype.open`, `send`, `abort`, `setRequestHeader` | replaced on the prototype | [src/observe/xhr.ts](src/observe/xhr.ts) `installXHR` | method, URL, header names and values (for the identity hash), the body (strings and BufferSource for the identity; Blobs are not read), the completed response's JSON | hold before `send`; `delay`, `block`, `serve_cached` (request); hold the completion events (delivery). XHR failures are detection only (no `retry`) | restored |
| `XMLHttpRequest.prototype.addEventListener`, `removeEventListener` | replaced on the prototype (completion listeners `readystatechange`, `progress`, `load`, `loadend` go through a thin wrapper so a held delivery can queue them) | same | nothing | the order and time at which completion listeners run while a delivery is held | restored, unless a wrapped listener was added: then both stay as pass-throughs so `removeEventListener` still finds the wrapper |
| `window.WebSocket` | replaced by a subclass of the native constructor | [src/observe/websocket.ts](src/observe/websocket.ts) `installWebSocket` | URL, message data (JSON-summarised for the situation), outgoing `send` summaries | hold an incoming message (and everything after it on the same socket, in order); never drops or changes one | restored; sockets created before stay subclass instances that pass everything through |
| `window.EventSource` | replaced by a subclass | [src/observe/eventsource.ts](src/observe/eventsource.ts) `installEventSource` | URL, event data | hold an incoming event (order kept) | restored, as above |
| `window.setTimeout`, `window.setInterval` | replaced by wrappers that wrap the callback (a lazy op carries the causal context) | [src/observe/timers.ts](src/observe/timers.ts) `installTimers` | the delay (for the op's label) | nothing: the delay, `this`, arguments, return value and the timer id are the native ones | restored |
| `history.pushState`, `history.replaceState` | replaced on the `history` object; the original runs first | [src/observe/nav.ts](src/observe/nav.ts) `installNav` | the new path, query and hash (redacted before the model) | nothing | restored |
| `Storage.prototype.setItem`, `removeItem`, `clear` | replaced on the prototype; the original runs first | [src/observe/storage.ts](src/observe/storage.ts) `installStorage` | the key name only (redacted when it names a secret); never the value | nothing | restored |
| `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` | installed when absent (a minimal DevTools hook); when React DevTools or React Refresh already installed one, its `inject`, `onCommitFiberRoot` and `onCommitFiberUnmount` are chained (theirs run first) | [src/discover/react.ts](src/discover/react.ts) `installReactDiscovery` | see [state discovery](#automatic-state-discovery-react-redux-zustand) | nothing (observed only) | chained functions restored; a hook GenClass installed stays (React keeps a reference to it) and is inert |
| `window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__`, `window.__REDUX_DEVTOOLS_EXTENSION__` | replaced by shims that call the real Redux DevTools extension first when it is installed | [src/discover/redux.ts](src/discover/redux.ts) `installReduxDiscovery` | see state discovery | Redux stores created through them become full adapters (their writes can be held, dropped, rolled back in guard/heal) | restored (deleted when they did not exist) |
| `window.GenClass` | the script-tag API object | [src/cdn/global.ts](src/cdn/global.ts) `install` | nothing | nothing | stays |
| `PerformanceObserver` (an instance, not a patch) | observes `longtask` entries | [src/observe/perf.ts](src/observe/perf.ts) `installPerf` | long task durations | nothing | disconnected |

Not wrapped or observed: `requestAnimationFrame`, `queueMicrotask`, `MessageChannel`, `postMessage`,
`BroadcastChannel`, IndexedDB, Cache Storage reads by the app, `navigator.sendBeacon`, `Worker`, Service Workers,
WebRTC, WebTransport, `document.cookie`, form navigation (a native `<form>` submit is recorded as a user action only).

## Event listeners it adds

All of them are passive observers: none calls `preventDefault`, `stopPropagation` or changes the event. Exception: the
devtools overlay's Alt+Shift+G hotkey (only when you mount the overlay).

| Target | Events | File, function | Why | Removed by `destroy()` |
|---|---|---|---|---|
| `window` (capture, passive) | `click`, `input`, `change`, `submit`, `keydown` (Enter and Escape only), plus `focusin`, `pointerdown`, `mousedown` to find open shadow roots | [src/observe/dom-user.ts](src/observe/dom-user.ts) `installDomUser` | user actions: the target's accessible name, the typed value (empty for password, card, one-time-code and secret-named fields: `isSensitiveField`), the option text | yes (also the per-shadow-root `change`/`submit` listeners) |
| `window` | `error`, `unhandledrejection` | [src/observe/errors.ts](src/observe/errors.ts) `installErrors` | errors become `error` triggers (message, file name and line) | yes |
| `window` | `popstate`, `hashchange` | [src/observe/nav.ts](src/observe/nav.ts) `installNav` | navigation (route scopes are recomputed) | yes |
| `window` / `document` | `pagehide` / `visibilitychange` | [src/runtime.ts](src/runtime.ts) constructor | the session summary for your `sinks` | yes |
| `window` / `document` | `pagehide` / `visibilitychange` | [src/telemetry/client.ts](src/telemetry/client.ts) `TelemetryClient` | the final telemetry flush (only while telemetry is on) | yes |
| `window` | `load` (once) | [src/model/host.ts](src/model/host.ts) `scheduleIdle` | start the model download at idle after the page loaded | yes |
| `document` | `securitypolicyviolation` (while the model loads) | [src/model/host.ts](src/model/host.ts) `watchCsp` | name a CSP-blocked model download in one warning | yes, when loading ends |
| `document` | `DOMContentLoaded` (once) | [src/cdn/config.ts](src/cdn/config.ts) `whenBody` | mount the devtools overlay when `<body>` exists | fires once |
| the model `Worker` | `message`, `error`, `messageerror` | [src/model/host.ts](src/model/host.ts), [src/cdn/global.ts](src/cdn/global.ts) `blobModuleWorker` | the worker GenClass started | terminated |
| inside the worker | `message`, `securitypolicyviolation` | [src/model/worker.ts](src/model/worker.ts) | the worker's own scope | terminated |
| the devtools overlay (only when mounted) | `keydown` on `document` (capture: Alt+Shift+G toggles the overlay and calls `preventDefault` on that combination only), clicks and keys inside its own shadow root, `matchMedia` theme changes | [src/devtools/index.ts](src/devtools/index.ts), [src/devtools/ui.ts](src/devtools/ui.ts) | the overlay | on unmount |

## Objects it instruments after handing them to the app

| Object | What | File | Mode | Effect |
|---|---|---|---|---|
| each `Response` the app receives from `fetch` | own properties `json`, `text`, `arrayBuffer`, `blob`, `formData`, `bytes` and `clone` that call the native methods and then restore the request's causal context | [src/observe/fetch.ts](src/observe/fetch.ts) `instrumentResponse` | all | same results, one extra microtask; `res.json !== Response.prototype.json` |
| a `Response` GenClass made (guard/heal actions only) | a new `Response` with the header `x-genclass: cached`, `coalesced` or `blocked` (503, empty body) | [src/observe/cache.ts](src/observe/cache.ts) `makeResponse`, `blockedResponse` | guard: `coalesce`; heal: `block`, `serve_cached` | the app can tell it apart by that header |
| each `XMLHttpRequest` the app uses | own accessor properties `onreadystatechange`, `onprogress`, `onload`, `onloadend` (the getter returns the wrapper around the app's function) | [src/observe/xhr.ts](src/observe/xhr.ts) `wrapHandlers` | all | same calls, possibly queued while a delivery is held |
| an `XMLHttpRequest` GenClass answered (heal: `block`, `serve_cached`) | own properties `readyState`, `status`, `statusText`, `response`, `responseText`, `getResponseHeader`, `getAllResponseHeaders`, then `readystatechange`, `load`, `loadend` are dispatched; all removed on the next `open()` | [src/observe/xhr.ts](src/observe/xhr.ts) `fake`, `unfake` | heal | the response carries `x-genclass` |
| each `WebSocket` created while installed | an own `send` that records a summary, then calls the native `send` with the same data; GenClass's own listeners for `message`, `close`, `error`, `open` | [src/observe/websocket.ts](src/observe/websocket.ts), [src/observe/messages.ts](src/observe/messages.ts) `MessageGate` | all; holding only in guard/heal | a held message is stopped (`stopImmediatePropagation`) and later re-dispatched as a copy (`isTrusted` false, same `data`, `origin`, `lastEventId`, `ports`), in order |
| each `EventSource` | `addEventListener` (subclass method) makes sure GenClass sees custom event types first | [src/observe/eventsource.ts](src/observe/eventsource.ts) | all; holding only in guard/heal | as WebSocket |

## Automatic state discovery (React, Redux, Zustand)

Installed with `autoState` (on by default for `@genclass/runtime/auto` and the script tag; `GenClass.init` needs
`import "@genclass/runtime/discover"` first), never under `?genclass=off`. Code: [src/discover/](src/discover/).

| Source | Hook point | What GenClass does there | Store kind | May GenClass change it? |
|---|---|---|---|---|
| React ≥ 16.8 (all renderers, dev and prod builds) | `__REACT_DEVTOOLS_GLOBAL_HOOK__` (above) | on each commit, walks only the fibers that re-rendered (≤ 1 ms, ≤ 20,000 fibers per commit) and records `useState`, `useReducer`, `useSyncExternalStore` and class-component state of named components (≤ 3 instances per component, ≤ 48 component stores, ≤ 16 hooks each). Functions, promises, elements, DOM nodes and class instances are skipped; a value equal to what a password, card or one-time-code input holds is redacted from then on | `observed` | **No.** Never held, dropped, reverted, rolled back or resynced (`state/hub.ts` `StoreHub.observe` only records; mutation `discard`/`defer` are not offered: `situation/build.ts` `builtinUnavailable`; rollback needs a writable store) |
| React renderers that inject after GenClass | the renderer's hooks dispatcher (`ReactSharedInternals.H` in React 19, `ReactCurrentDispatcher.current` before) becomes an accessor that returns an object inheriting from React's dispatcher with own `useState`/`useReducer` whose setters are wrapped; class instances' `updater` is wrapped | the wrapper calls the real setter unchanged and first notes which operation (request, timer, user action) called it | — | No. After `destroy()` the wrappers stay (React keeps the setters' identity) and pass through |
| Redux and Redux Toolkit stores created with the Redux DevTools compose or enhancer (RTK's default) | `__REDUX_DEVTOOLS_EXTENSION_COMPOSE__`, `__REDUX_DEVTOOLS_EXTENSION__()` | adds GenClass's Redux enhancer innermost (as the manual `genclassEnhancer`, [src/adapters/redux.ts](src/adapters/redux.ts)); the real extension stays outermost | `adapter` (full) | **Yes, in guard/heal**: like a registered store (a salient async dispatch may be held with `policy.holdWrites`, dropped, late-reverted within 800 ms, rolled back). Redux stores created before a runtime attached are observed only |
| Zustand `devtools()` middleware and other Redux DevTools `connect()` clients | `__REDUX_DEVTOOLS_EXTENSION__.connect` | records every state they send (functions left out), attributed to the operation that made the change | `observed` | **No** |

`test/invariants/discovery.test.ts` checks the "No" rows with a hostile model in heal mode.

## Stores you register

`rt.atom`, `rt.guard`, `rt.adapter`, `useGenClassState` ([src/adapters/react.ts](src/adapters/react.ts)), the Redux
enhancer ([src/adapters/redux.ts](src/adapters/redux.ts): wraps the store's `dispatch` and previews each action
through the reducer once) and the Zustand middleware ([src/adapters/zustand.ts](src/adapters/zustand.ts): replaces the
store's `set` and `api.setState`). These are the only stores GenClass can write: guard may drop or defer a held write
(`policy.holdWrites`, opt-in) or late-revert one within 800 ms; heal may roll back or resync. GenClass writes whole
states back to Redux with the visible action `@@genclass/REPLACE`. Store options: `hold: false` keeps a store's writes
from ever being held.

## Other side effects

| What | Where | When | File |
|---|---|---|---|
| Network: the model card, tokenizer, calibration, meta and the model variant (about 10 MB) from `model.baseUrl` (default jsDelivr `@genclass/runtime-model`), and onnxruntime-web's wasm from `model.ortWasmPaths` | with the page's fetch as it was when the module loaded (never through the wrapper) | at idle after load, `GenClass.init` in a browser with a model (lazy on Save-Data) | [src/model/loader.ts](src/model/loader.ts), [src/model/backend.ts](src/model/backend.ts) |
| Network: anonymous diagnostics to the GenClass collector (`DEFAULT_TELEMETRY_ENDPOINT`, a Cloudflare Worker) | native `fetch`/`sendBeacon` captured at module load, `text/plain`, `credentials: "omit"`, `referrerPolicy: "no-referrer"` | `GenClass.init` in a browser unless turned off ([TELEMETRY.md](TELEMETRY.md)); never in `createRuntime()` | [src/telemetry/](src/telemetry/) |
| Cache Storage | `genclass-model` cache (`model.cacheName`): model files, each checked against the card's size and sha256 | model load | [src/model/loader.ts](src/model/loader.ts) `fetchFile` |
| `sessionStorage` | `genclass:bucket` (`sample`), the breaker's trip state | `sample` < 1; breaker trips | [src/runtime.ts](src/runtime.ts) `sampleBucket`, [src/decide/breaker.ts](src/decide/breaker.ts) |
| `localStorage` / `sessionStorage` | `genclass:learn` (learned operation shapes) | only with `learn.persist` | [src/runtime.ts](src/runtime.ts) `saveProfilesSoon` |
| `localStorage` (read only) | `genclass` (kill switch), `genclass.telemetry` (opt-out) | init | [src/index.ts](src/index.ts) `killSwitch`, [src/telemetry/config.ts](src/telemetry/config.ts) |
| A module `Worker` (`genclass-model`) running onnxruntime-web; inline on the main thread only if the worker cannot start (`model.inlineFallback`) | | model load | [src/model/host.ts](src/model/host.ts) |
| Memory | ≤ 64 response bodies of ≤ 256 KB (last good GET per identity), ≤ 4 MB of recent responses for coalescing, a 500-event history, 200 decisions, 1,000 audit entries | always | [src/observe/cache.ts](src/observe/cache.ts) |
| Console | one line per detection or intervention (`report`), the telemetry notice, warnings | `report: "console"` (default) | [src/decide/report.ts](src/decide/report.ts) |

## What each mode may change

**observe** (the default) never holds, delays, drops, retries, replays or answers anything, and never writes app state.
In code: `permittedActions` is empty in observe ([src/decide/policy.ts](src/decide/policy.ts) `modeAllows`), so
`trigger()` never waits; `deliveryHoldable` is false, so a response is released synchronously before any body read
(`runDelivery`); `requestHoldable` is false, so a request whose body GenClass reads for its identity is sent first
([src/observe/fetch.ts](src/observe/fetch.ts) `runRequest`); store holds need `mode !== "observe"` (`hub.hooks.mayHold`).
What observe does cost: the wrappers above, a few extra microtask hops, response clones, CPU for situations and the
model (in its worker), the model download and, from `GenClass.init`, telemetry. `test/invariants/observe.test.ts`
compares everything the app observes, with virtual timestamps, against a run without GenClass while a hostile model
answers every situation.

**guard** (opt-in) adds holds and the guard-tier actions; **heal** (experimental) adds the heal tier. A hold never
exceeds the hold budget (`policy.holdBudgetMs`, "auto" = 1.5 × the model's median latency clamped to 150 to 800 ms),
including the time spent waiting for a body, deferred re-decisions and `onBeforeAction`
(`test/invariants/network.test.ts`, `test/invariants/state.test.ts` "the hold budget caps ..."). When the model is
not ready, slow, erroring or over its rate limit, the subject proceeds unchanged (fail open).

Every term can only lower the mode: `routes` rules, `sample`, the breaker (after 2 undos or 3 errors following actions,
the session drops to `observe`), a hidden tab (nothing new is held, background decisions are skipped) and
`?genclass-mode`. One
URL switch can raise it: `?genclass=guard` (or `localStorage.genclass = "guard"`) turns guard on when the app did not
set a mode; `heal` from the URL needs `debug: true` (see [THREAT-MODEL.md](../../docs/runtime/THREAT-MODEL.md)).

## What it never does

| Never | How it is ensured | Test |
|---|---|---|
| changes a request's URL, method, headers or body | the native `fetch`/`send` gets the app's own `input`/`init`/`body`; a replay (`retry`, `hedge`) sends a clone of the original `Request` or the same `init` | `test/fetch.test.ts`, `test/invariants/network.test.ts` |
| reads or writes cookies, or changes `credentials` | `document.cookie` is never accessed; `init` is passed through | static: no `cookie` access in `src/` outside redaction name lists |
| sends a non-idempotent request twice without an idempotency key | `retry` and `hedge` are only offered for GET/HEAD/OPTIONS/PUT/DELETE/TRACE or with an `Idempotency-Key`-style header (`policy.idempotencyHeaders`) or opt-in body field (`policy.idempotencyBodyFields`): `situation/build.ts` `repeatUnsafe`; `hedge` is GET only | `test/invariants/network.test.ts` "never sent twice" |
| serves a cached response to anything but an identical GET | `serve_cached` needs `method === "GET"` and a cached body for the same identity (method, URL, headers, body) | `test/review-fetch.test.ts`, `test/fetch.test.ts` |
| acts on a protected, cross-origin or off/observe-scoped subject | gate steps 1 to 3 (`blockOf` → reason `protected`, `cross-origin`, `scope`), checked before thresholds, `allow`, `eager` and shadow; `onBeforeAction` is not even asked; a protected request is never held and never waits for its body; its response's causal chain is protected too | `test/invariants/network.test.ts`, `test/presets.test.ts` |
| runs an action the runtime did not offer | `top` must be one of `built.actions`; the gate only considers permitted, offered actions | `test/invariants/network.test.ts` "out-of-vocabulary" |
| writes discovered React or Zustand state | observed stores are only recorded (`StoreHub.observe`) | `test/invariants/discovery.test.ts` |
| reorders writes to a store, or messages on a socket | held writes wait in the store's queue (`StoreHub.drain` applies in proposal order); held messages queue behind the head (`MessageGate`) | `test/no-reorder.test.ts`, `test/invariants/network.test.ts` "sync loop" |
| records password, card or one-time-code input values | `isSensitiveField` → empty value; the default redactor runs first and a custom `redact` can only redact more | `test/redaction-v2.test.ts`, `test/review-redaction.test.ts` |
| throws into the app | installers, hooks, listeners, sinks and plugins run in `try/catch`; a failed action runs the passive action | throughout |
| keeps acting after `disable()` | holds are released unchanged, observers uninstalled, the model worker terminated | `test/invariants/state.test.ts` "disable" |

## Actions: preconditions and reversibility

Holding (waiting for the decision) is not an action: it only adds latency, within the hold budget, and the subject then
proceeds or the chosen action runs. Every action is recorded (`rt.interventions()`, `rt.explain(id)`, the console,
`sinks`, `rt.audit()`) with one sentence saying exactly what changed. Undo: `record.undo()`, the devtools overlay, or
`rt.disable({ undo: true })` (actions of the last 60 s, newest first). Two undos within 10 minutes trip the breaker.

| Trigger | Action | Tier | What it does | Preconditions (besides the gate) | Undo |
|---|---|---|---|---|---|
| mutation | `discard` | guard | drops a held store write; decided after the write applied (hold budget expired), reverts exactly that write | registered store (not observed-only); held: `policy.holdWrites`; late revert ≤ 800 ms after it applied and nothing written since depends on it (`StoreHub.revertable`) | yes: the write is committed / re-applied |
| mutation | `defer` | guard | holds the write until related in-flight operations finish, then decides again | held write, at most 2 defers, within what is left of the hold budget | — (the write applies or is decided again) |
| request | `coalesce` | guard | does not send; answers with the response of the identical request in flight or finished ≤ 2 s ago (`x-genclass: coalesced`) | fetch; same identity (method, URL, headers, body); a shareable buffered response (≤ 256 KB) | no: the request was not sent. Any method, POST included (double submits): protect or `deny` it where repeats are deliberate |
| request | `delay` | guard | sends after 250 ms × 2^(recent failure streak), at most 8 s | fetch, XHR | no (latency only) |
| request | `block` | heal | does not send; answers 503 with `x-genclass: blocked` | fetch, XHR | no |
| request | `serve_cached` | heal | does not send; answers with the last good response for this identity (`x-genclass: cached`) | GET; a cached body (≤ 256 KB, this page's memory) | no |
| delivery | `discard` | guard | delivers the response, then for 10 s drops the writes its causal chain makes over newer data | the response would overwrite newer data; at least one target field in a registered store | yes: the dropped values are restored |
| delivery | `defer` | guard | holds the response until related in-flight operations finish, then decides again | related work in flight; at most 2 defers; within the hold budget | — |
| failure | `retry` | heal | sends the request again after 200 ms × 2^(attempt − 1) (≤ 5 s); the app gets that attempt's result | fetch; replayable body; fewer than 4 attempts; idempotent method or idempotency key | no |
| failure | `serve_cached` | heal | answers the failed request with the last good response | fetch; GET; cached body | no |
| stall | `hedge` | heal | sends a second identical request; the first good answer reaches the app | fetch; GET; replayable | no |
| stall | `serve_cached` | heal | answers with the cached response; the original continues in the background | fetch; GET; cached body | no |
| inconsistency | `rollback` | heal | restores the involved writable stores to the last consistent snapshot | a snapshot exists; an involved store is writable | yes: the replaced values are restored and the violation is muted |
| inconsistency, transition | `resync` | heal | calls the store's `resync` handler (your code) | a `resync` handler | your handler |
| transition, error | `rollback` | heal | restores only the fields the operation's own chain wrote (and nobody overwrote since) | such fields exist in writable stores | yes |
| any | custom (`rt.action`, plugins) | heal unless declared `guard` | your code; `ctx.builtin(name)` runs a built-in under the same gate | `on` triggers; `applicable()` | `ctx.onUndo(fn)` |

## Money and identity flows

Automatic intervention in payment, checkout and sign-in flows is not recommended. Keep them observe-only with
`requests.protect`, which is checked before everything else and covers the request, its response and everything its
response callbacks cause:

```js
import { GenClass, protectPreset } from "@genclass/runtime";
GenClass.init({ mode: "guard", requests: { protect: [...protectPreset("payments", "auth"), "/api/cart"] } });
// JSON configs (window.GENCLASS_CONFIG, the options file `init` writes, a meta tag):
window.GENCLASS_CONFIG = { requests: { protect: ["preset:payments", "preset:auth"] } };
```

`npx @genclass/runtime init` suggests the second form when the project depends on a payment SDK (Stripe, PayPal,
Braintree, Adyen, Square, Paddle, ...) or has source files named like a checkout or payments page. The presets
([src/presets.ts](src/presets.ts)) match URL words such as `checkout`, `payment(s)`, `payment_intents`, `billing`,
`invoice`, `charge`, `refund`, `subscription`, `order`, `transaction`, `transfer`, `payout`, `wallet` and provider
names (Stripe, PayPal, Braintree, Adyen, Klarna, Square); `auth` matches `login`, `logout`, `sign-in`, `sign-up`,
`oauth`, `token`, `session`, `sso`, `saml`, `oidc`, `mfa`, `otp`, `password`, `verify`. They over-match on purpose
(protection only removes interventions). Cross-origin requests (a payment provider's own API) are never acted on in
any case. Alternatively put the routes under a `routes` rule with `mode: "observe"`.

## Turning it off and restoring the page

| How | Effect | Code |
|---|---|---|
| `?genclass=off` or `localStorage.genclass = "off"` | nothing is installed: no observer, no discovery hooks, no model, no telemetry | [src/index.ts](src/index.ts) `initUnsafe`, [src/cdn/config.ts](src/cdn/config.ts) `isKilled` |
| `enabled: false` | installs nothing | `RuntimeImpl` constructor |
| `enabled` predicate / source turning false | pass-through: held subjects released, nothing decided | `followEnabled` |
| `rt.pause()` | nothing is held or acted on until `rt.resume()` | |
| `rt.disable()` | releases every held subject unchanged, then `destroy()` | `disable` |
| `rt.disable({ undo: true })` | also undoes the actions of the last 60 s, newest first (not counted by the breaker) | `disable` |
| `rt.destroy()` / `GenClass.destroy()` | telemetry's final flush, every uninstaller in reverse order (the "After `destroy()`" column above), plugins' cleanups, store subscriptions, the model worker | `destroy` |

Per-object instrumentation already handed to the app (a `Response`'s methods, an XHR's handler accessors, sockets
created while installed) stays attached and passes through.

## Audit trail

`rt.audit(n?)` returns JSON-serialisable entries for every decision, action, undo, breaker trip and reset, and control
change (`setMode`, `setAggressiveness`, `pause`, `resume`, `enabled`, `disable`), each with a timestamp, sequence
number, session id, the effective and requested mode, the aggressiveness profile, the gate kind, thresholds and their
source, the model's probabilities, the action proposed and the one that ran with the reason, the hold and the model
(name, version, variant, device and the sha256 its file was verified against). `InitOptions.audit` sets the in-memory
size (default 1,000) and a `sink` for your own logging. Query values in free text are replaced with "…". The trail is
built from values the runtime already has: it never feeds a decision, never changes what the model reads and is never
sent anywhere by GenClass ([src/decide/audit.ts](src/decide/audit.ts); API: [API.md](../../docs/runtime/API.md)).

## Machine-checked inventory

`test/interception.test.ts` parses this block. `patch` lines name what a runtime with every observer and `autoState`
changes on a browser global, and whether `destroy()` restores it or leaves it in place (inert). `listen` lines are the
listeners it adds to `window` and `document` (all removed by `destroy()`). `sites` lines count the patch sites per file
in `src/` (`addEventListener(` calls, `Object.defineProperty(`, `Reflect.set`/`defineProperty`, assignments to
global, prototype and hook objects): a change in a count fails the test until the rows above and this block are
updated.

<!-- inventory:start -->
```text
patch window.fetch restored
patch window.setTimeout restored
patch window.setInterval restored
patch window.WebSocket restored
patch window.EventSource restored
patch window.__REACT_DEVTOOLS_GLOBAL_HOOK__ stays
patch window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ restored
patch window.__REDUX_DEVTOOLS_EXTENSION__ restored
patch XMLHttpRequest.prototype.open restored
patch XMLHttpRequest.prototype.send restored
patch XMLHttpRequest.prototype.abort restored
patch XMLHttpRequest.prototype.setRequestHeader restored
patch XMLHttpRequest.prototype.addEventListener restored
patch XMLHttpRequest.prototype.removeEventListener restored
patch history.pushState restored
patch history.replaceState restored
patch Storage.prototype.setItem restored
patch Storage.prototype.removeItem restored
patch Storage.prototype.clear restored
observe PerformanceObserver longtask
listen window click
listen window input
listen window change
listen window submit
listen window keydown
listen window focusin
listen window pointerdown
listen window mousedown
listen window error
listen window unhandledrejection
listen window popstate
listen window hashchange
listen window pagehide
listen document visibilitychange
sites src/adapters/zustand.ts 1
sites src/cdn/config.ts 1
sites src/cdn/global.ts 3
sites src/devtools/index.ts 7
sites src/devtools/ui.ts 1
sites src/discover/react.ts 7
sites src/discover/redux.ts 2
sites src/model/backend.ts 2
sites src/model/host.ts 5
sites src/model/worker.ts 2
sites src/observe/cache.ts 1
sites src/observe/dom-user.ts 3
sites src/observe/errors.ts 2
sites src/observe/eventsource.ts 4
sites src/observe/fetch.ts 4
sites src/observe/nav.ts 6
sites src/observe/storage.ts 6
sites src/observe/timers.ts 4
sites src/observe/websocket.ts 4
sites src/observe/xhr.ts 15
sites src/runtime.ts 1
sites src/telemetry/client.ts 2
```
<!-- inventory:end -->
