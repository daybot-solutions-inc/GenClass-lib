# @genclass/runtime: observers, ops and causality

> **Scope:** `packages/runtime/src/observe/*.ts` (fetch, xhr, dom-user, errors, nav, storage, perf, websocket, timers, cache), `packages/runtime/src/trace/*.ts` (events, ops, context), and the parts of `packages/runtime/src/runtime.ts` that install/uninstall observers and route their events (`installObservers`, `netHost`, `timerHost`, `wsHost`, `onStorage`, `startOp`, `endOp`, `registerIdentity`, `user`, `reportError`, `op`, `emit`, `watchStall`, `destroy`). Also the helpers they depend on in `packages/runtime/src/util.ts`, `packages/runtime/src/clock.ts` and `packages/runtime/src/decide/exec.ts`.
> **Read this when:** you change or debug how GenClass patches `fetch` / `XMLHttpRequest` / `WebSocket` / timers / DOM events / history / Storage / errors / long tasks; how requests are held, faked, coalesced or served from cache; how ops, op signatures, request identities and cause/root links are produced; how the ambient op is propagated across `await`; or what lands in the event ring buffer.
> **Source of truth:** the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

## TL;DR

- Observers are installed by `RuntimeImpl`'s constructor (`packages/runtime/src/runtime.ts` -> `installObservers`). Each installer returns an uninstall function or `null` (API missing). Installers are wrapped in try/catch, so init never throws. `destroy()` runs the uninstalls in reverse order.
- Each wrapper keeps a `disabled` flag. After `destroy()` it is a pure pass-through. A global is restored only if it still holds GenClass's wrapper; if another library wrapped on top, GenClass leaves that library's wrapper in place. Exceptions: objects created *before* `destroy()` keep their per-instance hooks (a `GenClassWebSocket` keeps recording ops and events, a timer scheduled earlier still sticks a lazy op when it fires), see "After destroy: what still runs" under Invariants.
- Everything the app does async is an **op** (`OpRec` in `packages/runtime/src/trace/ops.ts`). An op has a sequential `id`, a `kind`, a `name` (= op signature, e.g. `GET /api/items/:id`), an optional `detail` (e.g. `?q=rea`), and `cause`/`root` links. User actions, WS messages and sends, timer ticks and GenClass actions are *instant* ops.
- The **ambient op** (`packages/runtime/src/trace/context.ts` -> `Context`) is the op whose work is running. `startOp` uses it as the `cause` and state writes use it as their writer. GenClass sets it in three ways. `run` sets it synchronously. `stick` sets it until `clock.afterTask` clears it at the end of the macrotask; `stick` happens when a wrapped fetch/XHR/Response body settles, a user action is recorded, a timer fires, a WS message arrives, or `rt.op` settles. GenClass does **not** propagate context through arbitrary promises.
- Timer callbacks get a **`LazyOp`**. It becomes a real `timer` op only when something calls `ctx.op()`. A `LazyOp`'s parent is always a real op or `null`, never another `LazyOp`, so recursive `setTimeout` loops never build a chain.
- fetch is the only fully *controllable* transport. Its request gate offers send / coalesce / delay / block / serve_cached; its failure gate offers deliver / retry / serve_cached; its stall watch offers wait / hedge / serve_cached. The app's promise always settles, and a failed action falls back to sending.
- XHR supports send / delay / block / serve_cached at the request gate (block and cached answers are faked onto the XHR). XHR failures and stalls are detection-only. Synchronous XHRs and `keepalive` fetches never raise a request trigger at all.
- **Request identity** = FNV-1a of method + absolute URL + non-volatile headers + body content key. Bodies that cannot be read cheaply get a unique `uniq:N` key and so never match.
- The response cache (`packages/runtime/src/observe/cache.ts` -> `ResponseCache`) has two parts:
  - a GET cache of the last good 2xx body per identity (≤ 256 KB each, ≤ 64 entries, LRU);
  - a coalescing table of in-flight or recently finished (≤ 2 s) requests (≤ 64 entries, ≤ 4 MiB).
  The app always reads its own `Response`; GenClass reads a clone.
- Every response GenClass synthesises carries the header `x-genclass: blocked | cached | coalesced`. Opaque responses shared by coalescing are the exception: they are unmarked clones.
- The DOM observer records click / input (typing) / change / submit / Enter / Escape at the capture phase on `window`. It skips `[data-genclass-ignore]` subtrees (shadow roots included) and events dispatched by app code while a non-user op runs. It never records sensitive field values.
- Events go to a ring buffer (`packages/runtime/src/trace/events.ts` -> `EventLog`) of `historySize` entries (default 500, minimum 16). Op names, details and event names feed the situation text the model reads and the sim's training data. The format is frozen at tag `situation-v1`, so any wording change needs coordination with SIM and TRAIN.

## Files

| Path | Role | Key exports / entry points |
|---|---|---|
| `packages/runtime/src/observe/fetch.ts` | Wraps `global.fetch`: op creation, request identity, request gate, failure gate, stall controller, Response instrumentation | `installFetch`, `bodyInfo`, `headersKey`, `parseRequest`, `instrumentResponse`, `IDENTITY_BODY_MAX`, `ParsedRequest` |
| `packages/runtime/src/observe/cache.ts` | GET response cache, coalescing table, bounded response buffering, synthetic responses | `ResponseCache`, `bufferResponse`, `makeResponse`, `blockedResponse`, `isOpaque`, `Buffered`, `RecentEntry`, `MAX_BODY`, `MAX_ENTRIES`, `COALESCE_WINDOW_MS`, `BUFFER_WAIT_MS` |
| `packages/runtime/src/observe/xhr.ts` | Patches `XMLHttpRequest.prototype.{open,send,abort,setRequestHeader}` | `installXHR` |
| `packages/runtime/src/observe/dom-user.ts` | Capture-phase DOM user-action listeners and element descriptions | `installDomUser`, `describeElement` (public, re-exported from `packages/runtime/src/index.ts`), `isSensitiveField`, `ignoredEvent` |
| `packages/runtime/src/observe/errors.ts` | `error` and `unhandledrejection` listeners | `installErrors` |
| `packages/runtime/src/observe/nav.ts` | Wraps `history.pushState/replaceState` and listens to `popstate`/`hashchange` | `installNav` |
| `packages/runtime/src/observe/storage.ts` | Wraps `Storage.prototype.{setItem,removeItem,clear}` | `installStorage` |
| `packages/runtime/src/observe/perf.ts` | `PerformanceObserver` for `longtask` | `installPerf` |
| `packages/runtime/src/observe/websocket.ts` | Replaces `global.WebSocket` with a subclass | `installWebSocket`, `WsHost` |
| `packages/runtime/src/observe/timers.ts` | Wraps `setTimeout`/`setInterval` to carry context into callbacks | `installTimers`, `TimerHost` |
| `packages/runtime/src/trace/events.ts` | Event ring buffer | `EventLog` |
| `packages/runtime/src/trace/ops.ts` | Op registry | `OpRegistry`, `OpRec`, `StartOpts`, `ChainWrite` |
| `packages/runtime/src/trace/context.ts` | Ambient-op propagation | `Context`, `LazyOp`, `Ambient` |
| `packages/runtime/src/runtime.ts` | Wiring: installs observers, builds hosts, creates and ends ops, routes events and triggers | `RuntimeImpl.installObservers`, `netHost`, `timerHost`, `wsHost`, `onStorage`, `startOp`, `endOp`, `registerIdentity`, `user`, `reportError`, `op`, `emit`, `watchStall`, `runAsGenClass`, `destroy` |
| `packages/runtime/src/decide/exec.ts` | Seam between observers and decisions | `NetHost`, `Controller`, `ActionEffect`, `EndOpts`, `TriggerOpts` |
| `packages/runtime/src/util.ts` | URL parsing, signature normalisation, hashing, redaction | `parseUrl`, `normalizePath`, `isIdSegment`, `requestSignature`, `redactSearch`, `fnv1a`, `stableStringify`, `IDEMPOTENT_METHODS`, `isSensitiveName`, `defaultRedact` |
| `packages/runtime/src/clock.ts` | Real clock: timers captured at module load, `afterTask` | `browserClock` |
| `packages/runtime/src/types.ts` | Public types | `Op`, `OpKind`, `OpStatus`, `RtEvent`, `EventKind`, `UserAction`, `ObserverName`, `Clock`, `RuntimeHooks` |
| `packages/runtime/src/situation/env.ts` | Request/failure subject types the observers fill in | `ReqMeta`, `FailureInfo`, `SubjectSpec`, `SitEnv` (`cached`, `identical`, `canCoalesce`) |
| `packages/runtime/src/situation/describe.ts` | How ops are worded in situations and `ActionEffect.changed` sentences | `opPhrase`, `opLabel`, `userPhrase` (out of scope; see [learn-situation-triage.md](learn-situation-triage.md)) |
| `packages/runtime/src/index.ts` | Entry: kill-switch observe map and the model host's un-observed fetch | `ALL_OFF`, `NATIVE_FETCH` (module-private), re-export of `describeElement` |

## Concepts and data structures

Terms specific to this doc (see also [../glossary.md](../glossary.md)):

| Term | Meaning |
|---|---|
| op | An `OpRec`: an async operation, user action, timer tick, WS event or GenClass action. It has an id, kind, signature (`name`), cause and root. |
| op signature | `OpRec.name`. For requests it is `METHOD normalisedPath` (see "Signature normalisation"). |
| instant op | An op created already ended (`instant: true`, `end = start`, `status = "ok"`) and never put in `inFlight`. Used for user actions, timer ticks, WS messages and sends, and GenClass actions. |
| ambient op | `Context.cur`, read by `ctx.op()` (materialises a lazy timer op) or `ctx.peek()` (does not). |
| running op | `Context.running`: set only while `Context.run(op, fn)` executes `fn` synchronously. The DOM observer uses it to detect programmatic events. |
| lazy timer op | A `LazyOp` made for each wrapped timer callback. `materialize()` creates a real `timer` op on first use. |
| request identity | `ReqMeta.identity` / `OpRec.identity`: the hash that defines "identical requests". `""` while the body is still being read. A key starting `uniq:` (or hashed from one) matches nothing. |
| held | A request or failure waiting for a decision (the request gate or failure gate with `hold: true`). It fails open after the hold budget. |
| controller | A `Controller` from `packages/runtime/src/decide/exec.ts`. `passive()` lets the subject proceed. `run(action)` performs a built-in action and returns `ActionEffect.changed`, or throws, in which case passive runs instead. |
| gated | `NetHost.gated(op)`: `!paused && !destroyed && !op.genclass`. fetch and XHR raise request/failure/stall triggers only for gated ops (the `error` trigger from `reportError` does not use `gated`). |
| synthetic end | `endOp(..., { synthetic: true })`: the op was answered by GenClass (block, cache or coalesce). It is kept out of latency baselines and transition profiles. |

`OpRec` (`packages/runtime/src/trace/ops.ts`; extends `Op` from `packages/runtime/src/types.ts`):

| Field | Type | Set by / meaning |
|---|---|---|
| `id` | number | Sequential from 1 per `OpRegistry` (per runtime), never reused |
| `kind` | `OpKind` = `"user" \| "fetch" \| "xhr" \| "ws" \| "task" \| "timer" \| "genclass"` | Creator |
| `name` | string | Op signature |
| `detail?` | string | Query string or body summary (requests), quoted typed value (user), message summary (ws) |
| `start`, `end?` | number (clock ms) | `start` at creation, `end` at `OpRegistry.end` (instant ops: `end = start`) |
| `status?` | `"ok" \| "error" \| "aborted" \| "blocked"` | At end |
| `code?` | number \| string | HTTP status, `"timeout"`, `"network"`, `"aborted"`, or a WS close code |
| `cause?`, `root?` | number | `cause` = id of the parent op. `root` = `cause.root ?? cause.id`, or the op's own id when it has no cause |
| `attempt` | number | Default 1. A fetch retry gets `attempt + 1`; a hedge keeps the attempt |
| `reads` | `Map<string, number>` | Always created empty; filled lazily by situation building |
| `identity?` | string | Request identity (fetch/xhr) |
| `meta?` | object | User ops: `{ action: UserAction }` (value already redacted). Tasks: the `meta` passed to `rt.op` |
| `startSeq` | number | `hub.seq` (the global applied-mutation sequence) at start |
| `method?`, `url?` | string | Requests |
| `errorText?` | string | e.g. `HTTP 503`, the network error message |
| `instant?` | boolean | See the terms table |
| `wrote`, `storesWritten?`, `chain?`, `chainWrites?`, `profiled?` | — | Written by the state and learn code (see [state-and-adapters.md](state-and-adapters.md), [learn-situation-triage.md](learn-situation-triage.md)) |
| `triggered?` | `Set<TriggerKind>` | Triggers already raised for this op. A stall is raised once per op |
| `genclass?` | boolean | `kind === "genclass"`, or inherited from a cause that is `genclass`. Such ops are never gated, profiled, baselined or identity-registered |
| `children` | number | Count of ops that name this op as `cause` (diagnostic) |

Op kinds as produced in practice:

| kind | Created by | `name` format | Instant | Default cause | Pushes `op.start`? | Profiled (`PROFILED`) | Baselines + identity |
|---|---|---|---|---|---|---|---|
| `user` | `RuntimeImpl.user` (DOM observer, `rt.user`, plugin `api.user`, the sim) | `${kind} ${target}` (or bare `kind` with no target), e.g. `click button "Add to cart"`, `type input "Search"`, `key input "Search"` (the key itself is only in `meta.action.key`) | yes | `null` (always a root) | no (has its own `user` event) | yes | no |
| `fetch` | `installFetch` (also retry and hedge ops) | `GET /api/items/:id` | no | ambient (retry and hedge: explicit) | yes | yes | yes, unless `genclass` |
| `xhr` | `installXHR` | same as fetch | no | ambient | yes | yes | yes, unless `genclass` |
| `ws` | `installWebSocket` | `WS <path>` (connect), `WS message <path>`, `WS send <path>`; `<path>` is `host/path` for an absolute `ws(s):` URL on a page with a `location` (see WebSocket step 2) | message and send: yes | connect and send: ambient; message: `null` (root) | connect only (message and send push `custom` events) | yes | no |
| `task` | `rt.op(name, fn, meta)`; plugin `api.recordOp(kind, …)` can create any kind | the given name | no | ambient | yes | yes | no |
| `timer` | `LazyOp.materialize` via `RuntimeImpl.timerHost().lazyTimer` | `timer 300ms`, `timer 1.50s`, `interval 5.00s` | yes | the op that was ambient when the timer was scheduled (nearest real op) | yes (`data.instant: true`) | no | no |
| `genclass` | `RuntimeImpl.runAsGenClass(name, fn)` | `undo`, `revert`, `rollback`, `resync`, or a custom action name | yes | `null` | no (has `action` events) | no | no |

`StartOpts` (`packages/runtime/src/trace/ops.ts`): `{ detail?; cause?: OpRec | null; identity?; attempt?; meta?; instant?; method?; url?; startSeq; t }`. `RuntimeImpl.startOp` takes `Omit<StartOpts, "startSeq" | "t">` and fills those two. `cause: undefined` means "use the ambient op"; `cause: null` forces a root. An empty `detail`/`identity`/`method`/`url` is not stored (truthiness checks). `ChainWrite` (`{ kind; len0; len1 }`, array lengths `-1` for non-arrays) belongs to transition profiles (see [learn-situation-triage.md](learn-situation-triage.md)).

`OpRegistry` API (`packages/runtime/src/trace/ops.ts`, one per runtime, exposed as `rt.internals.ops`):

| Member | Behaviour |
|---|---|
| `byId: Map<number, OpRec>` | Every op not yet pruned |
| `inFlight: Set<OpRec>` | Non-instant ops not yet ended. `rt.inflight()` returns a copy. Never pruned |
| `start(kind, name, o)` | Creates the op (see "Op lifecycle") |
| `end(op, t, status, code?, errorText?)` | No-op if the op already has `end` and is not in flight (so instant ops and already-ended ops cannot be re-ended; first end wins). Notifies `onEnd` listeners; listener throws are swallowed |
| `onEnd(fn)` | Returns an unsubscribe function |
| `get(id)` | `undefined` for `null`/`undefined`/pruned ids |
| `ancestors(op, max = 12)` | Direct cause upwards; stops at the first pruned ancestor |
| `isAncestorOrSelf(a, b)` | Walks at most 16 hops up from `b` |
| `userOf(op)` | Nearest `user` op in the chain, self included, ≤ 16 hops |
| `rootOf(op)` | `get(op.root) ?? op` (falls back to the op itself when the root was pruned) |

Request `detail` format (`fetch.ts` -> `parseRequest`): the redacted query string (`?k=v&…`, ≤ 60 chars, `""` when none) followed, for methods other than GET/HEAD, by a **space** and the body summary, e.g. `?draft=1 {title: "x"}` (body `{"title":"x"}`, worded by `util.ts` -> `describe`) or ` 42 bytes` (leading space when there is no query). The leading space is deliberate: `situation/describe.ts` -> `opPhrase` renders fetch/xhr ops as `name + detail` with no separator (`GET /api/search?q=re`, `POST /api/orders {…}`). Retry ops copy `failedOp.detail`; hedge ops use `` `${op.detail ?? ""} (hedge)`.trim() ``.

`ReqMeta` (`packages/runtime/src/situation/env.ts`): `{ method (upper case); url (absolute href); signature; identity; idempotent; replayable; bodyBytes?; transport: "fetch" | "xhr" }`. `idempotent` means the method is in `IDEMPOTENT_METHODS` = GET, HEAD, OPTIONS, PUT, DELETE, TRACE. `replayable` is false only for `ReadableStream` bodies, and for `Request` bodies that could not be cloned.

`FailureInfo`: `{ kind: "network" | "timeout" | "http"; status?; statusText?; message?; durMs }`.

`RtEvent` (`packages/runtime/src/types.ts`): `{ seq; t; kind: EventKind; name; op?; cause?; data? }`. Which events each producer emits:

| `kind` | Producer | `name` | `op` | `data` |
|---|---|---|---|---|
| `user` | `RuntimeImpl.user` | op name | user op id (a typing burst points at the latest keystroke's op) | `{ kind, target, value? (JSON-quoted, redacted), count, first (first op id), lastT? }` |
| `op.start` | `RuntimeImpl.startOp` for non-instant ops, plus instant `timer`/`task` ops | op name | op id (`cause` set when the op has one) | `{ kind, detail?, instant? }` |
| `op.end` | `RuntimeImpl.endOp` | op name | op id | `{ status, code?, synthetic? }` |
| `state` | state hub (see [state-and-adapters.md](state-and-adapters.md)) | store | writer op | — |
| `error` | `RuntimeImpl.reportError` (errors observer, hub, app) | error name, e.g. `TypeError` | ambient op | `{ message: "Name: msg≤120", source? }` |
| `nav` | nav observer | route (`pathname+search+hash`, ≤ 80 chars) | — | `{ route }` |
| `perf` | perf observer | `long task` | — | `{ duration }` |
| `storage` | `RuntimeImpl.onStorage` | `localStorage.setItem` / `sessionStorage.removeItem` / `storage.clear` … | ambient op | `{ key }` (`[redacted]` when the redactor changes it) |
| `custom` | `rt.emit` (data redacted per key plus `summary` ≤ 80 chars), `ws.message` / `ws.send` (`{ path, summary }`), `xhr.send-failed` (`{ error }`) via `NetHost.emit` | event name | ambient op / message op / xhr op | as listed |
| `decision`, `action` | decision flow (see [decide-policy-actions.md](decide-policy-actions.md)) | trigger / action name | — | — |

`EventLog` API (`packages/runtime/src/trace/events.ts`, exposed as `rt.internals.events`):

| Member | Behaviour |
|---|---|
| `constructor(size)` | `size` is kept as given (readonly); the buffer length is `Math.max(16, size)` |
| `push(t, kind, name, { op?, cause?, data? })` | Assigns `seq = ++seq` (starts at 1), overwrites the oldest slot when full, calls every listener synchronously (throws swallowed), returns the event object (kept by reference, so callers can mutate it: typing bursts) |
| `touch(e)` | Re-notifies listeners after an in-place update; does not change `seq` or position |
| `last(n = length)` | The last `n` events, oldest first. `rt.history(n)` = `events.last(n)` |
| `since(t)` | Events with `t >= since`, oldest first |
| `length` | Number of events held (≤ buffer length) |
| `onEvent(fn)` | Returns an unsubscribe. `RuntimeImpl`'s constructor wires `events.onEvent(e => fire("event", e))`, so every push and touch reaches `rt.on("event")` listeners (devtools) |
| `clear()` | Empties the buffer; `seq` is **not** reset |

Response buffering types (`packages/runtime/src/observe/cache.ts`):

```ts
type Buffered =
  | { kind: "body"; status; statusText; headers: [string, string][]; body: ArrayBuffer; url; t }
  | { kind: "opaque"; res: Response /* a clone */; status; t };
interface RecentEntry { op: OpRec; body: Promise<Buffered | null>; settledAt?: number; bytes: number }
```

`XhrState` (module-private in `packages/runtime/src/observe/xhr.ts`, kept in a module-level `WeakMap` keyed by XHR object): `{ method; url; async; headers: Map; op?; failed?: "error"|"timeout"|"abort"; held; abortedWhileHeld; faked: string[]; onEnd? }`.

`BodyInfo` (module-private in `fetch.ts`, returned by the exported `bodyInfo`): `{ key?: string ("" = no body; undefined while pending); pending?: Promise<string>; bytes; replayable; summary }`.

Host interfaces (what each installer receives; all built in `packages/runtime/src/runtime.ts`):

| Interface | Defined in | Members |
|---|---|---|
| `NetHost` (fetch, XHR) | `packages/runtime/src/decide/exec.ts` | `clock`, `ctx`, `global`, `cache`, `redact()`, `baseHref()`, `startOp(kind, name, o)`, `endOp(op, status, o?)`, `gated(op)`, `trigger(spec, ctl, opts)`, `watchStall(op, req, ctl)`, `failureStreak(sig)`, `emit(name, data?, op?)`, `uniqueId()`, `setIdentity(op, req, identity)` |
| `TimerHost` | `packages/runtime/src/observe/timers.ts` | `global`, `ctx`, `lazyTimer(parent, label)` |
| `WsHost` | `packages/runtime/src/observe/websocket.ts` | `global`, `ctx`, `redact()`, `baseHref()`, `startOp(name, o)` (kind fixed to `ws`), `endOp(op, status, o?)`, `event(name, data, op?)` (a `custom` event) |
| `UserSink` (module-private) | `packages/runtime/src/observe/dom-user.ts` | `user(action, handler?)`, `ambientKind?()`, `runningKind?()` |
| `ErrorSink` (module-private) | `packages/runtime/src/observe/errors.ts` | `reportError(error, info?)` (the `RuntimeImpl` itself is passed) |
| nav / storage / perf | their files | plain callbacks: `onNav(route)`, `cb(area, op, key)`, `cb(name, duration)` |

Decision seam types (`packages/runtime/src/decide/exec.ts`): `Controller { passive(): void /* called at most once */; run(action): ActionEffect | Promise<ActionEffect> /* throw = passive runs */; revertable?(); revert?() /* held writes only */ }`, `ActionEffect { changed: string; undo? }`, `TriggerOpts { hold: boolean; priority: number }`, `EndOpts { code?; errorText?; failure? /* counts as a failure in baselines */; synthetic? }`.

## How it works

### 1. Install, route and uninstall (`packages/runtime/src/runtime.ts`)

1. The constructor creates `EventLog(o.historySize ?? 500)`, `Context(clock)`, `ResponseCache(clock)` and an `OpRegistry` (`clock = o.clock ?? browserClock`, `global = o.global ?? globalThis`). It wires `events.onEvent(e => fire("event", e))` and the decider's `onStatus` (its unsubscribe goes into the same `uninstall` list as the observers). It then calls `loadProfiles()` (only when `learn.persist` is set), then `installObservers(o.observe ?? {})`, then `use()` for each plugin.
2. `installObservers` reads each `observe[name]` flag. The default is `true`, except `timers`, which defaults to `typeof global.document === "object" && global.document !== null`. The install order is timers, fetch, xhr, websocket, user, errors, nav, storage, perf. Each install goes through `tryAdd`, which catches a throw (e.g. a read-only global) and logs it (only with `debug`).
3. Hosts:
   - `netHost()` (`NetHost`) serves fetch and XHR. It provides `gated`, `trigger` (`RuntimeImpl.trigger`), `watchStall`, `failureStreak(sig)` (= `base.stats(sig)?.failStreak ?? 0`), `uniqueId()` (= `uniq:${++n}`), `setIdentity` (updates `op.identity` and `req.identity`, then re-registers), `emit` (a `custom` event) and `baseHref()` (= `global.location.href`).
   - `timerHost()` provides `lazyTimer(parent, label)` = `new LazyOp(parent, cause => startOp("timer", label, { cause, instant: true }))`.
   - `wsHost()` maps `startOp` to kind `ws` and `event` to a `custom` event.
4. Routing:
   - DOM user actions go to `RuntimeImpl.user`, with `ambientKind` and `runningKind` callbacks (a `LazyOp` reports as `"timer"`).
   - Errors go to `RuntimeImpl.reportError`. It creates an `error` event and raises the `error` trigger (`hold: false`, `priority: 0`).
   - Nav, perf and storage become events only. They never raise triggers.
5. `destroy()` sets `destroyed` and runs every uninstall in reverse order, then unregisters plugins and calls `ctx.clear()`. It does **not** clear `ResponseCache`. Full order (`RuntimeImpl.destroy`, idempotent):
   1. `destroyed = true`, `hub.gating = false`;
   2. `queue.dispose()` (`packages/runtime/src/decide/decider.ts` -> `DeciderQueue`): every *queued* decision resolves `null`, so `RuntimeImpl.trigger` runs the controller's `passive()` (it checks `destroyed` first). The one decision already being evaluated ends when the provider answers or its deadline timer fires, and the hold-budget timer is not cleared by `destroy()`, so it also runs `passive()`. Either way a held fetch or XHR is **sent** (not dropped) and a held failure is delivered;
   3. `reporter.dispose()`, clear the settle and persist timers;
   4. run `uninstall` in reverse (observers, decider status listener);
   5. `unuse` every plugin, `unsubscribeIO` every store, `ctx.clear()`, dispose the decider if the runtime owns it.
   From then on `gated(op)` is false and `consultable()` is false, so any trigger an existing object still raises runs its passive action at once.
6. `GenClass.init` (`packages/runtime/src/index.ts`) passes `observe: ALL_OFF` in three cases: outside a browser (no `window`/`document`), with the `?genclass=off` kill switch, and in the init-failure fallback. The model host downloads with `NATIVE_FETCH`, captured at module load (or `global.fetch` bound before the runtime wraps it), so GenClass never observes its own model download.

### 2. Op lifecycle (`RuntimeImpl.startOp` / `RuntimeImpl.endOp`)

1. `startOp(kind, name, o)`. `cause` is `o.cause` when given (including an explicit `null`); otherwise it is `ctx.op()`, which materialises a lazy timer op if one is ambient. It then calls `ops.start(kind, name, { ...o, cause, startSeq: hub.seq, t })`.
2. `OpRegistry.start`:
   - assigns the id;
   - sets `cause`/`root`, increments `cause.children`, and inherits `genclass`;
   - for instant ops, sets `end = t` and `status = "ok"`; otherwise adds the op to `inFlight`.
   It prunes when `byId.size > 2000`: the oldest non-in-flight ops are deleted until the size is ≤ 1500.
3. Back in `startOp`:
   - pushes `op.start` (see the event table);
   - for non-`genclass` fetch/xhr ops, calls `base.start(name, t)` and `registerIdentity(op)`;
   - queues instant ops of profiled kinds for profiling;
   - calls `hooks.opCreated(op)` synchronously.
4. `endOp(op, status, { code, errorText, failure, synthetic })` does nothing if the op has already ended. Otherwise it:
   - calls `ops.end` (sets `end`, `status`, `code`, `errorText`; notifies `onEnd` listeners);
   - pushes `op.end`;
   - for non-synthetic, non-`genclass` fetch/xhr ops, calls `base.end(name, t, dur, ok, outcome, failure)`;
   - queues profiled kinds that are neither aborted nor synthetic;
   - calls `scheduleSettle()`.
5. `registerIdentity(op)` skips `genclass` ops and identities starting with `uniq:`. It calls `base.noteIdentity` and keeps `identicalMap[identity]`: at most 12 ops, dropping entries that ended and started more than 10 s ago, across at most 512 identities (oldest identity evicted). Situations read it through `SitEnv.identical`.

### 3. fetch: a call through the wrapper (`packages/runtime/src/observe/fetch.ts` -> `installFetch` -> `wrapped`)

1. If `disabled` (after destroy), call `nativeFetch(input, init)`. This is `native.call(global, ...)`; the app's `this` is ignored.
2. Parse the request:
   - From a `Request` input: `method`, `url`, `keepalive`. `bodyKnown = false` when there is no `init.body`, the method is not GET/HEAD, and `input.body` is set.
   - From a string/URL input: `rawUrl = String(input)`.
   - `init.method`, `init.body` and `init.keepalive` override.
   - Any exception means `nativeFetch` with no op.
3. Body key:
   - `bodyKnown`: `bodyInfo(body, host)` (rules below).
   - A `Request` with a body: `template = req.clone()` keeps a pristine copy for replays. If `content-length > 64 KB` or cloning failed, the key is `uniqueId()`. Otherwise a second clone's stream goes to `readKey`, which hashes ≤ 64 KB or falls back to `uniqueId()`; the key is then `pending`.
4. `parseRequest(host, method, rawUrl, b, headersKey(input, init))` returns `ReqMeta` (`transport: "fetch"`) plus `detail` and maybe `pendingIdentity`.
5. `host.startOp("fetch", req.signature, { detail, method, url, identity? })` runs **synchronously inside the `fetch()` call**. The cause is the ambient op.
6. `runRequest(op, parsed, input, init, template, gateRequest = !keepalive)` returns a **new Promise** owned by GenClass:
   - If `signal.aborted` already: `endOp(op, "aborted", { code: "aborted" })` and reject with `signal.reason` (or `DOMException("…", "AbortError")`). Native fetch is never called.
   - Otherwise add a one-shot `abort` listener. It is active only until the request is sent or answered.
7. Identity resolution. If the identity is pending and the request is not `keepalive`, `within(host, pendingIdentity, IDENTITY_READ_MS = 100, "")` waits for it (falling back to `uniqueId()` on timeout), then calls `setIdentity` and `gate()`. If the request is `keepalive`, it calls `setIdentity(uniqueId())` now, `gate()` at once, and the real identity later.
8. `gate()`:
   - If `!gateRequest` (keepalive) or `!host.gated(op)`, it calls `sendNow()` synchronously. **No request trigger is raised.**
   - Otherwise it calls `host.trigger({ trigger: "request", op, req }, reqCtl, { hold: true, priority: 2 })`. `RuntimeImpl.trigger` runs the passive action (`sendNow`) synchronously in these cases: the runtime is not consultable, all facts are neutral (triage `salient`), the situation is not salient, the provider is not ready, or the mode/policy permits no non-passive action. In all those cases native fetch is called inside the `fetch()` call. The exception is a pending identity (step 7): then the gate runs only after the body read, so the send is always asynchronous. Otherwise the request is **held** until the decision arrives or `holdBudgetMs()` expires; on expiry the passive action runs (fail-open).
9. `send(sendOp, primary)`:
   - Each attempt is sent at most once (`WeakSet`).
   - `primary` sets `sent = true` and removes the abort listener; native fetch now owns the app's signal.
   - The first send uses the original `input`. Later sends (retries) use `template.clone()`.
   - If `Response` exists and the identity is non-empty, `cache.track(identity, sendOp, bodyPromise)`.
   - If gated, `watchStall` starts.
   - Every call site passes `primary = true`; the `!primary` branches are unused.
10. On a response:
    - `failed = status >= 500 || 429 || 408`.
    - `tracked.settledAt = now`. `bufferResponse(res)` reads a **clone**. A `body` result for a non-failed, `res.ok` GET is put in the GET cache. The coalescing entry resolves to `null` if the request failed.
    - `endOp(sendOp, failed ? "error" : "ok", { code: status, failure? })`.
    - If failed and gated and not yet answered, `failureGate(...)`; else `answer(res)`.
11. On a rejection:
    - `TimeoutError` (the error's name, or `signal.reason.name`) is a failure with `code: "timeout"`.
    - Any other `AbortError` or aborted signal gives `endOp(..., "aborted")` and rejects with the original error.
    - Everything else is `code: "network"` with `failure: true`. It goes to the failure gate if gated, else rejects with the original error.
12. `answer(res, err)` runs once. It removes the abort listener, cancels the stall watch, calls `host.ctx.stick(op)`, then resolves `instrumentResponse(host, res, op)` or rejects `err`. Because the stick comes first, the app's `await fetch()` continuation runs with this op ambient.
13. `instrumentResponse` replaces `json`, `text`, `arrayBuffer`, `blob`, `formData` and `bytes` on the Response instance with versions that call `ctx.stick(op)` on resolve and on reject. It also replaces `clone()` so that clones are instrumented too. Frozen responses are left as they are.
14. Other details of `installFetch`:
    - `within(host, p, ms, fallback)` resolves with `p`'s value, or with `fallback` after `ms` on the host clock **or as soon as `p` rejects**.
    - `R = g.Response ?? globalThis.Response`. Without it, responses are never tracked or buffered, and `block`, `serve_cached` and `coalesce` throw (so passive runs).
    - Retries and hedges reuse the app's `init` object, including `init.signal`, so aborting the app's signal aborts them too. Without a `template` (no `Request` body) the original `input` is passed again.
    - The wrapper function is tagged `__genclass = true`; nothing in the repo reads that tag.

Body key rules (`bodyInfo`). The identity key is prefixed, then hashed together with method, URL and headers:

| Body | Key | `replayable` | Summary (`detail` for non-GET/HEAD) |
|---|---|---|---|
| none / `null` | `""` | yes | — |
| string ≤ 256 chars | `s:<string>` | yes | JSON ≤ 16,384 chars: `describe(parsed, "body", redact, 60)`; else `<length> bytes` |
| string ≤ 1,048,576 chars | `S:<fnv1a>:<length>` | yes | as above |
| longer string | `uniq:N` | yes | as above |
| `URLSearchParams` | `q:<toString>` | yes | `redactSearch("?"+s, redact, 60)` |
| `FormData` without files | `f:<fnv1a(k=v&…)>` | yes | `form N fields` |
| `FormData` with a file | `uniq:N` | yes | `form N fields` (files count as one) |
| `Blob` ≤ 64 KB | pending: `b:<fnv32>:<len>` of its bytes | yes | `<size> bytes` |
| `Blob` > 64 KB | `uniq:N` | yes | `<size> bytes` |
| `ArrayBuffer` / view ≤ 64 KB | `b:<fnv32>:<len>` | yes | `<n> bytes` |
| > 64 KB | `uniq:N` | yes | `<n> bytes` |
| `ReadableStream` | `uniq:N` | **no** | `stream` |
| anything else | `j:<fnv1a(stableStringify(body, 4096))>` | yes | `stableStringify` truncated to 40 chars |

`headersKey`: headers from the `Request` input, then `init.headers` (later values win), keys lower-cased. `VOLATILE_HEADERS` are dropped, the rest are sorted, and the key is `fnv1a("k:v\n…")`, or `""` when no headers remain. `parseRequest`:

```ts
identity = fnv1a(`${METHOD} ${absoluteHref} ${hdrKey} ` + bodyKey)   // "" while the body key is pending
detail   = redactSearch(url.search, redact /*≤60 chars*/) + (body summary, only when method is not GET/HEAD)
```

### 4. fetch actions: request gate, failure gate, stall

Request gate (`reqCtl`; `passive` = `sendNow`, which sends unless the request was already answered, sent or aborted):

| Action | Effect | Op end | Marking |
|---|---|---|---|
| `send` (passive) | `send(op, true)` | real | — |
| `block` | answer `blockedResponse(R)`: status 503, statusText `Blocked by GenClass`, null body | `blocked`, code 503, synthetic | `x-genclass: blocked` |
| `serve_cached` | `cache.get(identity)` (LRU touch) -> `makeResponse(R, b, "cached")`; throws `no cached response` | `ok`, code `b.status`, synthetic | `x-genclass: cached` |
| `delay` | wait `min(250 · 2^failStreak(signature), 8000)` ms on the host clock, then `sendNow()` | real | — |
| `coalesce` | `cache.shareable(identity, op.id, now)` returns the newest **earlier** (lower op id) identical request that is in flight or settled ≤ 2 s ago. Waits `within(..., COALESCE_MAX_WAIT_MS = 8000, null)` for its buffered body. If that body is `null` or the response cannot be built, it calls `sendNow()` and throws (the ActionRecord records the error) | `ok`, code `b.status`, synthetic | `x-genclass: coalesced` (opaque: unmarked clone) |

Failure gate (`failureGate`: `host.trigger({ trigger: "failure", op: failedOp, req, failure }, ctl, { hold: true, priority: 2 })`):

| Action | Effect |
|---|---|
| `deliver` (passive) | The app gets the original failed `Response` or the original rejection |
| `retry` | Requires `req.replayable`. Waits `min(200 · 2^(failedOp.attempt − 1), 5000)` ms, then starts `retryOp = startOp("fetch", sig, { attempt: failedOp.attempt + 1, cause: failedOp, … })`, reassigns the closure's `op = retryOp` and sends it as primary. The retry is **not** re-gated at the request gate; its own failure goes through the failure gate again. `situation/build.ts` offers `retry` only when `attempt < 4`, so there are at most 3 retries (backoffs 200, 400, 800 ms). From then on the closure's `op` is the retry op: `answer()` sticks it, the app's `Response` is instrumented with it, and the stall watch is re-armed for it. If the app's signal aborted during the backoff, the app gets `signal.reason` and the action rejects (`aborted`) |
| `serve_cached` | Answer with the cached GET body (`x-genclass: cached`) |

Whether the failure is held depends on the policy. In `guard` mode no failure action is permitted, so the failure is delivered at once and the decision is made in the background (`RuntimeImpl.trigger`: `waits = opts.hold && permitted.length > 0`).

Stall (`RuntimeImpl.watchStall`, armed by `send` for gated primary sends):
- It needs a latency baseline (≥ 5 samples, `MIN_LAT_SAMPLES` in `packages/runtime/src/learn/baselines.ts`).
- It fires `max(4 × median, 2 × p95, STALL_MIN_MS = 500)` ms **after the send** (not after op start; a held request starts the clock late) if the op has not ended, at most once per op (`op.triggered`), with `{ hold: false, priority: 1 }`.
- `stallController` actions:
  - `wait` (passive): no-op.
  - `serve_cached`: answers with the cached response; the original request keeps running in the background.
  - `hedge`: requires `replayable && idempotent`; `build.ts` additionally limits it to GET. It sends `hedgeOp` (cause `op`, same attempt) through `nativeFetch(replayInput)` directly; it is not `cache.track`ed, so its body never enters the GET cache or the coalescing table. It is still an ordinary `fetch` op: it gets `op.start`/`op.end` events, latency baselines and an `identicalMap` entry. If the hedge returns a non-failure first, the app gets it. Otherwise the app keeps waiting for the original.

The app's promise always settles. Every action that throws or rejects makes `RuntimeImpl.onDecision` call the controller's `passive()`. Once a request has been sent, GenClass stops listening to the app's `AbortSignal`. A failure held at that point is delivered or retried at decision/budget time (retry checks `signal.aborted`).

### 5. Response cache and buffering (`packages/runtime/src/observe/cache.ts`)

1. `bufferResponse(res, clock)` never throws. It returns:
   - `opaque` (`res.clone()`) when `isOpaque(res)`: `type` is `opaque`/`opaqueredirect`/`error`, or status is 0, < 200 or > 599;
   - `null` for `text/event-stream`, for `content-length > 262,144`, when the stream exceeds 262,144 bytes (the reader is cancelled), or when it is still streaming after `BUFFER_WAIT_MS = 1000` ms;
   - `body` otherwise, with all headers.
   The fetch wrapper buffers **every** tracked response this way, whether or not anything later shares it. The 1 s bound applies only when `clone.body` is a readable stream; otherwise it falls back to `await clone.arrayBuffer()` with no time bound and checks the size afterwards. `Buffered.t` is the clock time when buffering finished; it is the age shown in `serve_cached` sentences ("from 1.20s ago") and in `SitEnv.cached`.
2. `good` (the GET cache) is a `Map` used as an LRU. `put` accepts only `body` buffers and evicts beyond `MAX_ENTRIES = 64`. `get` refreshes recency. `peek` does not, and is used for the facts that `SitEnv.cached` reports.
3. `recent` (the coalescing table) maps identity to at most 8 `RecentEntry` items. `prune(now)` drops entries settled more than `COALESCE_WINDOW_MS = 2000` ms ago. It then evicts the oldest *settled* entries until the table holds ≤ `MAX_RECENT = 64` entries and ≤ `MAX_RECENT_BYTES = 4 MiB`. In-flight entries are never evicted. `settledAt` is set when the response headers arrive, not when buffering finishes. `RecentEntry.bytes` stays 0 until the body is buffered (and for opaque or failed entries), so the byte bound only counts finished `body` buffers. `track()` and `shareable()` both call `prune()`; so does `SitEnv.canCoalesce` (`runtime.ts` -> `makeEnv`), which situation building uses to decide whether to offer `coalesce`.
4. `makeResponse(R, b, mark)` handles the two buffer kinds:
   - `opaque` returns `b.res.clone()` (unmarked);
   - `body` builds `new R(body copy, { status, statusText, headers + x-genclass: mark })`. The body is `null` for 101/103/204/205/304. `url` is set with `Object.defineProperty`. The headers object is built with the module-scope `Headers` constructor, not `host.global.Headers`.
5. `blockedResponse(R)` = `new R(null, { status: 503, statusText: "Blocked by GenClass", headers: { "x-genclass": "blocked" } })`.

### 6. XHR (`packages/runtime/src/observe/xhr.ts` -> `installXHR`)

1. `wOpen`:
   - `stateOf(xhr)` creates the state and listeners **once per object**: `readystatechange` (readyState 4 sticks `s.op`), `error`/`timeout`/`abort` (set `failed`) and `loadend` (runs `onEnd` once).
   - `unfake` deletes the properties faked by a previous answer.
   - Records `method`, `url`, `async` (false only when the third argument is `false`) and resets per-request state, then calls the native `open`.
2. `wSetHeader` records lower-cased header names. A repeated name overwrites the earlier value; the identity does not see the comma-joined value the browser actually sends.
3. `wSend`:
   - With no state (send before `open`, `open` called before install, or any call after `destroy()`), it calls the native `send`.
   - `bodyInfo(body)`; a Blob key is never read for XHR, so a Blob body gets `uniqueId()`.
   - Headers are filtered by the `VOLATILE` regex.
   - `parseRequest(...)` with `transport = "xhr"`, then `startOp("xhr", signature, { detail, identity, method, url })`.
4. `onEnd` (on `loadend`):
   - `failed = "abort"` gives `aborted`.
   - `timeout`, `error` or status 0 give `error` with code `timeout`/`network`, plus a `failure` trigger.
   - Status ≥ 500, 429 or 408 gives `error` with the HTTP code, plus a `failure` trigger.
   - Anything else is `ok`.
   - Failure triggers use the `passiveOnly()` controller with `{ hold: false, priority: 1 }`: detection only, because the app already sees XHR failures directly.
5. Not gated, or synchronous: `doSend()` at once. **Synchronous XHRs raise no request trigger, are never held and get no stall watch.** `doSend()` arms the (detection-only) stall watch for gated async requests, then calls native `send`. If native `send` throws, it clears `onEnd`, ends the op `error` (`code: "network"`, `failure: true`) and rethrows. On this un-held path the app sees the exception exactly as without GenClass.
6. Otherwise `held = true` and `host.trigger({ trigger: "request", … }, ctl, { hold: true, priority: 2 })`:
   - `passive`: `doSend()`. A throw from native `send` becomes a `custom` event `xhr.send-failed`.
   - `block`: `fake(xhr, st, 503, "Blocked by GenClass", "", [["x-genclass","blocked"]])`; op ends `blocked`, synthetic.
   - `serve_cached`: uses only `body` buffers, decoded as UTF-8; headers are the cached ones plus `x-genclass: cached`.
   - `delay`: same formula as fetch. A throw from native `send` after the delay is swallowed (the op records it).
   - `coalesce` throws `unsupported action`; `situation/build.ts` only offers it for `transport === "fetch"`.
7. `fake()` defines own-property getters for `readyState` 4, `status`, `statusText`, `response` and (for `responseType` `""`/`"text"` only) `responseText`. `response` follows `responseType`: `json` gives parsed JSON or `null`; `arraybuffer` gives UTF-8 bytes; `blob` gives a `Blob`; `document` gives `null`. It also overrides `getResponseHeader`/`getAllResponseHeaders`, then dispatches `readystatechange`, `load` and `loadend` as plain `Event`s. No progress events are fired and `responseURL` is not faked. The `block` and `serve_cached` callers set `onEnd = undefined`, end the op as synthetic and call `ctx.stick(op)` *before* `fake()`, so the app's load handlers run with the op ambient.
8. `wAbort` while held: it sets `abortedWhileHeld`, ends the op `aborted`, dispatches `abort` and `loadend`, and **never calls native `send`** (a later decision or delay is ignored). When not held, it calls the native `abort`. The held-abort path dispatches plain `Event`s only: no `readystatechange`, and `readyState`/`status` keep their native values (`OPENED`, 0), unlike a real abort of a sent request.
9. XHR responses are never buffered: XHR never populates the GET cache or the coalescing table. XHR `serve_cached` can only replay a body that fetch cached under the same identity. Identities match across transports when method, URL, headers and body match.

### 7. DOM user actions (`packages/runtime/src/observe/dom-user.ts` -> `installDomUser`)

1. Listeners are added on `global` if it has `addEventListener` (i.e. `window`), else on `document`, with `{ capture: true, passive: true }`, for `click`, `input`, `change`, `submit` and `keydown`.
2. Guard: an event is skipped when `ignoredEvent(e) || programmatic(e)`.
   - `ignoredEvent`: `composedPath()[0]` (when `composedPath` exists) or `e.target` is inside an element with `data-genclass-ignore`; both are checked. The walk goes up `parentNode` and crosses shadow roots through `host`, for at most 1000 steps.
   - `programmatic`: true if `runningKind()` is non-null and not `"user"`, i.e. app code running inside `ctx.run` of a task, GenClass, fetch or other op dispatched the event. Otherwise trusted events (`isTrusted !== false`) are kept. Untrusted events are dropped when the ambient kind (`peek`, where a `LazyOp` counts as `"timer"`) is non-null and not `"user"`. **Untrusted events with no ambient op, or with a user ambient op, are kept** (test drivers, `el.click()` inside a user handler).
3. Handlers:

| Event | Records | Value |
|---|---|---|
| `click` | `{ kind: "click", target: describeElement(interactive(e.target)) }` | — |
| `input` | text-like targets only: `textarea`, contenteditable, or `input` whose type is one of `text search email number tel url password date time datetime-local month week ""` | `""` if `isSensitiveField`, else `textContent` (contenteditable) or `value`; plus `sensitive` |
| `change` | `select` (selected option text, ≤ 40 chars), checkbox/radio (`checked`/`unchecked`), range/color/file (`file` for file inputs) | sensitive -> `""` |
| `submit` | `form "<aria-label \| name \| id \| first h1/h2/h3/legend text>"`, or `form` | — |
| `keydown` | only `Enter` and `Escape`: `{ kind: "key", key, target }`. Auto-repeat is not filtered (`e.repeat` is not checked), so a held key records one user op per repeat | — |

   `interactive(t)` uses the parent element for text nodes, then takes the closest element matching `button,a,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[role=switch],[contenteditable=''],[contenteditable=true]`, falling back to the element itself.
4. `RuntimeImpl.user(action, handler?)`:
   - `kind` is `action.kind ?? action.action ?? "action"`.
   - The value becomes `[redacted]` when `sensitive` is set or `redact(target, value) !== value`.
   - `detail = JSON.stringify(truncate(value, 40))`. Only `detail` is truncated: `op.meta.action.value` keeps the whole (possibly redacted) value.
   - It creates an instant root op, `startOp("user", name, { cause: null, instant: true, detail, meta: { action } })`.
   - **Typing bursts:** a `type` action is merged into the previous `user` event when the target is the same, the gap is ≤ `TYPING_BURST_MS = 1000` ms since the last keystroke, and that event is still the latest user event. The merge updates `count`, `value`, `lastT` and `e.op` in place and calls `events.touch(e)`. Every keystroke still creates its own user op.
   - It then calls `ctx.stickUser(op)`, and runs `ctx.run(op, handler)` if a handler was given. The DOM observer passes none. Its capture listener on `window` runs before the app's handlers (except `window` capture listeners registered earlier), so they run with the user op ambient and recorded as the task's user op (`taskUser`).
5. `describeElement(el)` returns `'role "name"'`, or a bare role, or `page` for `null`.
   - Name, first non-empty of:
     1. `aria-label`;
     2. `aria-labelledby` texts;
     3. fields only (input/select/textarea): `labels[0]`, then `label[for=id]`, then the closest `label`;
     4. non-fields only: `innerText ?? textContent`;
     5. `placeholder`;
     6. `title`;
     7. `name`;
     8. the `value` of an input of type button/submit/reset (never a typed value);
     9. `id`.
   - Each name has whitespace collapsed and is truncated to 40 chars.
   - Role: the `role` attribute; else `a` -> `link`; input button/submit/reset/image -> `button`; checkbox/radio/range/file/color -> that type; any other input -> `input`; else the tag name.
   - Examples from `test/dom.test.ts`: `button "Place order"`, `input "Search"`, `link "Home"`, `checkbox "remember"`, `select "Size"`.
6. `isSensitiveField` is true for any of: `type=password`; `autocomplete` whose last token matches `/^(cc-|one-time-code$|current-password$|new-password$)/i`; or `name`/`id`/`aria-label`/`placeholder`/label text that `isSensitiveName` flags (word-level secret names in `packages/runtime/src/util.ts`).

### 8. Timers and lazy timer ops (`packages/runtime/src/observe/timers.ts`, `packages/runtime/src/trace/context.ts`)

1. `installTimers` wraps `setTimeout`/`setInterval` on the runtime's `global` option (`RuntimeImpl.timerHost().global` = `o.global ?? globalThis`), not on Node's `globalThis` when a custom `global` is passed. It returns `null` and installs nothing when `global.setTimeout` is not a function. In Node tests the observer is off by default (no `document`). `packages/runtime/test/helpers.ts` -> `makeGlobal` has no `setTimeout`, so `setup({ observe: { timers: true } })` alone wraps nothing. Use the recipe from `packages/runtime/test/context.test.ts` ("timers observer carries the cause into timer callbacks (debounce)"): `const holder = {}; const s = setup({ observe: { fetch: true, timers: true }, extraGlobal: { setTimeout: (fn, ms) => holder.clock.setTimeout(fn, ms), clearTimeout: (h) => holder.clock.clearTimeout(h), setInterval: () => 0 } }); holder.clock = s.clock;`. Schedule through `s.g.setTimeout`, not the Node global. A passed `observe` replaces `setup`'s all-off map, so unlisted observers return to their defaults (on, except `timers`).
2. `setTimeout` and `setInterval` are wrapped. `clearTimeout`/`clearInterval` are not; the native handle is returned unchanged. A non-function callback (a string) passes through untouched.
3. At schedule time: `amb = ctx.peek()` and `parent = amb instanceof LazyOp ? amb.nearest : amb`. `nearest` is the materialised op if there is one, else the lazy op's own parent. `label` is `timer ${delay < 1000 ? Math.round(delay) + "ms" : secs(delay)}` or `interval ${secs(delay)}`, with `delay = max(0, Number(ms) || 0)`.
4. When the callback fires (every tick, for intervals): `ctx.stick(lazyTimer(parent, label))`, then the app's callback runs (with its original `this` and arguments). The native timer receives the app's original `ms` and extra arguments; only the label uses the clamped `delay`.
   - `parent` and `label` are captured once per `setTimeout`/`setInterval` call. Every tick of an interval therefore gets a fresh `LazyOp` with the **same** parent: all ticks descend from the op that was ambient when `setInterval` was called (same `root`), however long the interval runs.
   - With no ambient op at schedule time, `parent` is `null` and a materialised timer op is a root (no cause).
5. Anything in the callback that calls `ctx.op()` materialises a `timer` op (instant, `cause = parent`) and replaces `cur` with it. That includes `startOp` without an explicit cause (fetch, XHR, `rt.op`, WS connect/send, plugin `recordOp`), state writes (`StoreHub.propose`), `rt.emit`, `reportError` and the storage observer. Idle callbacks create nothing (`test/context.test.ts`).
6. Why lazy ops never chain: a `LazyOp` is only ever constructed with a real op or `null` as its parent, and `materialize()` nulls its `make` and `parentOp`. A recursive `setTimeout` loop that never uses its op therefore keeps pointing at the same real ancestor. No closure chain builds up and materialising never recurses (`test/review-timers.test.ts`: 200,000 ticks, then a write). A loop that *does* materialise before it reschedules links each tick to the previous tick's real op by numeric id only (the `LazyOp` drops `parentOp` once materialised), so registry pruning can free old ticks. The gc test ("a polling loop does not retain every past tick's op forever") schedules the next tick *before* writing, so its ticks are roots; it asserts that a pruned tick op is garbage-collected, not the materialise-first linking case (untested).
7. The runtime's own scheduling uses `Clock` (`browserClock` captures the real `setTimeout`/`clearTimeout`/`setImmediate`/`MessageChannel` at module load), so the timers observer never sees GenClass's own timers.

### 9. Ambient-op propagation rules (`packages/runtime/src/trace/context.ts` -> `Context`)

| Mechanism | Sets `cur` to | Duration | Call sites |
|---|---|---|---|
| `run(op, fn)` | `op` (also `running`) | Synchronously during `fn`; restores the previous `cur` and `running` in `finally` | `RuntimeImpl.user` (with handler), `RuntimeImpl.op` (body), `runAsGenClass`, plugin `runInOp`, the hub applying a held write (`ctx.run(m.cause, write)`) |
| `stick(op)` | `op` or a `LazyOp` | Until `clock.afterTask` runs. It clears `cur` only if `cur` is still that op (or the op it materialised into) | fetch `answer()` and body methods; XHR readyState 4 and fake answers; WS message; timer callbacks; `rt.op` settle; `stickUser` |
| `stickUser(op)` | `op`, plus `taskUser = op` | Until afterTask | `RuntimeImpl.user` |
| `clear()` | `null` | — | `destroy()` |

- `isUserSync(op)` is true when `op === taskUser`, or `op.root === taskUser.root || op.root === taskUser.id`. The hub uses it: user-sync writes are never held unless `policy.holdUserWrites` (default `false`) is set.
- `stick` is last-writer-wins within a task. A later stick in the same task (two responses settling in one task, `Promise.all`) overrides the earlier one.
- Context is lost across `await` on any promise GenClass did not instrument. For example, inside `rt.op(name, async () => { await somethingUninstrumented(); x.set(1) })`, the write after the await has no ambient op. It is regained only at the next instrumented settle point.
- `browserClock.afterTask` picks the first available of: `setImmediate` when there is no `window` (Node); `MessageChannel`; `setImmediate`; `setTimeout(0)`. It batches callbacks and flushes them once per posted task. The test `FakeClock` models this explicitly (`flush()` drains microtasks, then runs the afterTask hooks).

### 10. WebSocket (`packages/runtime/src/observe/websocket.ts` -> `installWebSocket`)

1. `global.WebSocket = class GenClassWebSocket extends Native`. Instances made after destroy (through a kept reference) skip all tracing.
2. The path is `normalizePath(parseUrl(url, baseHref).where)`. An absolute `ws:`/`wss:` URL never has the same origin as an `http(s)` page (the scheme differs), so `where` is `host + pathname` and the op name includes the host, e.g. `WS message app.example.test/ws/board` (seen in `sim/samples`). Two exceptions follow from `parseUrl`: with no `global.location` (`baseHref()` undefined) every URL counts as same-origin, and a relative URL resolves against the page's `http(s)` origin; in both cases `where` is the bare `pathname` (e.g. `WS /ws`).
3. The connect op is `WS <path>` with detail `connect` and the ambient op as cause. It ends `ok` on `open`, `error` with `{ code: "network", failure: true }` on `error`, or `error` with `{ code: CloseEvent.code }` on `close`. Only the first of these counts. Errors and closes **after** `open` are not recorded at all (the connect op has already ended; there is no disconnect op or event). If the native constructor throws (bad URL), the exception reaches the app and nothing is recorded.
4. Each `message`:
   - creates an instant **root** op `WS message <path>` (`cause: null`) whose detail is the summary;
   - pushes a `custom` event `ws.message` `{ path, summary }`;
   - calls `ctx.stick(m)`. The listener is registered in the constructor, before any app listener or `onmessage`, so the app's handlers run with the message op ambient.
5. `send` is replaced per instance (own property). It creates an instant op `WS send <path>` (ambient cause) and a `custom` event `ws.send`, then calls the original.
6. Summary:
   - strings > 16 KB or blank: `<len> chars`;
   - JSON (starts with `{` or `[`): `describe(parsed, "message", redact, 60)`;
   - other strings: `JSON.stringify(truncate(t, 40))`;
   - Blob/ArrayBuffer: `<n> bytes`;
   - else `binary`.
   WS ops are neither baselined nor identity-registered.

### 11. errors, nav, storage, perf

- **errors** (`installErrors`):
  - On `window` `error`, events with neither a string `message` nor an `error` are skipped (resource load errors). `source` is `<basename(filename)>:<lineno ?? 0>`, and is omitted when `filename` is empty.
  - On `unhandledrejection`, `source` is `"unhandledrejection"`.
  - Both listeners are bubble-phase listeners on `global` (`null` when it has no `addEventListener`). The value reported is `ev.error ?? ev.message` (for an `error` event) or `ev.reason`. `reportError` returns at once after `destroy()`; its ambient-op lookup (`ctx.op()`) materialises a lazy timer op.
  - Both call `RuntimeImpl.reportError(error, { source })`. `normalizeError` sets the key to `Name:` + the message with each digit run replaced by `n`, message part cut to 120 chars. `errorsRecent` keeps ≤ 64 entries; the facts window is 10 s. The `error` trigger's `rollback` calls `revertChain(ambientOp)`.
- **nav** (`installNav`): the original `pushState`/`replaceState` is called first, then the route is recorded. `popstate` and `hashchange` are recorded too. The route is `truncate(pathname + search + hash, 80)` and is **not redacted**. The output is a `nav` event only; no op. Requires `global.history`, `global.location` and `addEventListener`. If the native `pushState` throws, nothing is recorded (the original runs first). The second parameter (`_rt`) is unused. A fragment navigation normally fires both `popstate` and `hashchange`, giving two `nav` events (unverified: browser behaviour; no test).
- **storage** (`installStorage`): `setItem`/`removeItem`/`clear` are wrapped on `Storage.prototype`. The area (`localStorage`, `sessionStorage` or `storage`) is found by comparing `this`. Property-assignment writes (`localStorage.k = v`) and `delete` are not observed. The event's `op` is the ambient op (`ctx.op()`, which materialises a lazy timer op). The native method runs first; if it throws (e.g. quota exceeded) no event is recorded. Cross-tab `storage` events on `window` are not observed. `clear` records key `""`.
- **perf** (`installPerf`): returns `null` when `PerformanceObserver` is missing, when `supportedEntryTypes` exists without `longtask`, or when `observe()` throws. It observes `{ type: "longtask", buffered: false }`. Each entry becomes a `perf` event `long task` with `{ duration }`.

### 12. Signature normalisation (`packages/runtime/src/util.ts`)

1. `parseUrl(raw, base)` evaluates `new URL(raw, base ?? "http://localhost/")`.
   - `sameOrigin = !base || base.origin === url.origin`.
   - `where = sameOrigin ? pathname : host + pathname`. Query and fragment never enter the signature; the query goes to `detail`.
   - If parsing throws (including an invalid `base`), the fallback is `{ href: raw, where: raw before "?", search: raw from "?" (or ""), sameOrigin: true }`.
   - `base` comes from `NetHost.baseHref()` = `global.location.href` when it is a string, else `undefined`. `WsHost.baseHref()` returns `global.location?.href` without the string check.
2. `requestSignature(method, where)` = `` `${METHOD} ${normalizePath(where)}` ``. The method is upper-cased here (and in `parseRequest`), so `fetch(u, { method: "post" })` gives `POST …`.
3. `normalizePath` splits on `/`. Each segment is `decodeURIComponent`'d (the raw segment is used if decoding throws) and tested with `isIdSegment`. Matches become `:id`; other segments are kept **raw** (not decoded).
4. `isIdSegment(seg)` is true if `seg` is non-empty and any of these hold:
   - all digits `/^\d+$/`;
   - a UUID (8-4-4-4-12 hex, case-insensitive);
   - long hex: ≥ 8 hex chars containing a digit;
   - long token: ≥ 16 chars of `[A-Za-z0-9_-]` containing a digit and a letter;
   - `isSlugId`. This requires ≥ 4 chars of `[A-Za-z0-9_-]` with both a digit and a letter, and not a version (`/^v\d+([a-z]+\d*)?$/i`). Then, for any `-`/`_` part containing letters and digits: the part starts with a digit, **or** it has ≥ 2 letter↔digit transitions. Failing that, the whole segment is ≥ 6 chars and mixes lower case, upper case and digits.

   Exact patterns (module-private in `util.ts`):

   ```ts
   const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
   const LONG_HEX = /^(?=[0-9a-f]*\d)[0-9a-f]{8,}$/i;
   const LONG_TOKEN = /^(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}$/;
   // isSlugId transitions: part.match(/[A-Za-z](?=\d)|\d(?=[A-Za-z])/g).length >= 2
   ```

| Input | Output |
|---|---|
| `/api/items/42` | `/api/items/:id` |
| `/api/tasks/tasks-1cam` | `/api/tasks/:id` |
| `/api/u/x7k2p/orders/ab12cd` | `/api/u/:id/orders/:id` |
| `/api/v2/items/PPBqWA9` | `/api/v2/items/:id` |
| `sha256`, `oauth2`, `ipv4`, `item42`, `v1beta1`, `html5`, `x86_64`, `utf-8` | unchanged (not ids) |
| `https://api.other.com/items/7` from page `http://app.test/` | `GET api.other.com/items/:id` |
| `/api/items/` vs `/api/items` | different signatures (trailing empty segment kept) |
| `/reports/2024-10-07` | unchanged: no letters, so not an id |
| `/reports/2024` | `/reports/:id` (any all-digit segment, years included) |
| `/api/items/%31%32` | `/api/items/:id` (tested after decoding: `12`) |
| `/files/My%20Doc` | unchanged, kept encoded (non-id segments are never decoded in the output) |
| `/blobs/cafe1234` vs `/blobs/deadbeef` | `/blobs/:id` vs unchanged (`LONG_HEX` needs a digit) |

Transition profiles use a different normaliser, `normalizeFieldPath`, for store paths (out of scope).

## Configuration and constants

| Name | Type | Default / value | Defined in | Effect |
|---|---|---|---|---|
| `observe` (`ObserverName` = `fetch xhr user errors nav storage perf websocket timers`) | `Partial<Record<…, boolean>>` | all `true`; `timers` = `global.document` is a non-null object | `packages/runtime/src/runtime.ts` -> `installObservers` | Which observers install |
| `historySize` | number | 500 (buffer min 16) | `packages/runtime/src/runtime.ts` constructor, `packages/runtime/src/trace/events.ts` -> `EventLog` | Ring-buffer size. The timeline reads the last 96 events (`situation/build.ts` -> `timelineLines`) |
| `IDENTITY_BODY_MAX` | bytes | 65,536 | `packages/runtime/src/observe/fetch.ts` | Max Blob/ArrayBuffer/view/Request body hashed for identity |
| `STRING_BODY_MAX` | chars | 1,048,576 (strings ≤ 256 chars are used verbatim) | `packages/runtime/src/observe/fetch.ts` | Longer string bodies get a unique identity |
| `IDENTITY_READ_MS` | ms | 100 | `packages/runtime/src/observe/fetch.ts` | Max wait for a Request/Blob body identity before the gate |
| `COALESCE_MAX_WAIT_MS` | ms | 8,000 | `packages/runtime/src/observe/fetch.ts` | A coalesced request waits at most this long, then sends itself |
| `SUMMARY_PARSE_MAX` | chars | 16,384 | `packages/runtime/src/observe/fetch.ts` | JSON body summaries are parsed only up to this size |
| object-body stringify cap | chars | 4,096 | `packages/runtime/src/observe/fetch.ts` -> `bodyInfo` | `j:` key input |
| `VOLATILE_HEADERS` | Set | `traceparent tracestate baggage sentry-trace x-request-id x-correlation-id request-id x-amzn-trace-id x-cloud-trace-context b3 x-b3-traceid x-b3-spanid x-b3-parentspanid x-b3-sampled x-b3-flags x-datadog-trace-id x-datadog-parent-id x-datadog-sampling-priority x-datadog-origin newrelic date x-request-start x-genclass` | `packages/runtime/src/observe/fetch.ts` | Excluded from fetch identity |
| `VOLATILE` | RegExp | same list, but `x-b3-.*` and `x-datadog-.*` are wildcards | `packages/runtime/src/observe/xhr.ts` | Excluded from XHR identity |
| `FAILURE_STATUS` | predicate | status ≥ 500, 429, 408 | `packages/runtime/src/observe/fetch.ts` (inline copy in `xhr.ts` `onEnd`) | Failure classification |
| `BODY_METHODS` | list | `json text arrayBuffer blob formData bytes` (+ `clone`) | `packages/runtime/src/observe/fetch.ts` | Instrumented for context |
| delay | ms | `min(250 · 2^failStreak, 8000)` | `fetch.ts` `reqCtl`, `xhr.ts` `ctl` | `delay` action |
| retry backoff | ms | `min(200 · 2^(attempt−1), 5000)` | `fetch.ts` `failureGate` | `retry` action |
| `MAX_BODY` | bytes | 262,144 | `packages/runtime/src/observe/cache.ts` | Max buffered response body |
| `MAX_ENTRIES` | count | 64 | `packages/runtime/src/observe/cache.ts` | GET cache entries (LRU) |
| `COALESCE_WINDOW_MS` | ms | 2,000 | `packages/runtime/src/observe/cache.ts` | A settled request stays shareable this long |
| `BUFFER_WAIT_MS` | ms | 1,000 | `packages/runtime/src/observe/cache.ts` | A still-streaming body is not buffered |
| `MAX_RECENT` / `MAX_RECENT_BYTES` | count / bytes | 64 / 4,194,304 | `packages/runtime/src/observe/cache.ts` | Coalescing table bounds |
| per-identity recent list | count | 8 | `cache.ts` -> `ResponseCache.track` | Oldest dropped |
| `NULL_BODY` | statuses | 101, 103, 204, 205, 304 | `packages/runtime/src/observe/cache.ts` | Synthetic response gets a `null` body |
| `MAX_OPS` / `KEEP_OPS` | count | 2,000 / 1,500 | `packages/runtime/src/trace/ops.ts` | Registry pruning (in-flight ops are never pruned) |
| `ancestors` max / walk limits | count | 12 / 16 (`isAncestorOrSelf`, `userOf`) | `packages/runtime/src/trace/ops.ts` | Bounded chain walks |
| `TYPING_BURST_MS` | ms | 1,000 | `packages/runtime/src/runtime.ts` | Typing-burst merge window (from the last keystroke) |
| `STALL_MIN_MS` | ms | 500 | `packages/runtime/src/runtime.ts` | Stall at `max(4×median, 2×p95, 500)` |
| `MIN_LAT_SAMPLES` | count | 5 | `packages/runtime/src/learn/baselines.ts` | No stall watch before 5 latency samples |
| `LONG_RUNNING_MS` | ms | 10,000 | `packages/runtime/src/runtime.ts` | In-flight ops younger than this block settled points (`busy`) |
| `identicalMap` | count / ms | ≤ 12 per identity, 10 s, ≤ 512 identities | `packages/runtime/src/runtime.ts` -> `registerIdentity` | Identical-request facts |
| hold budget | ms | `"auto"` = clamp(1.5 × median of the last 20 model latencies (else the model's `warmupMs`), `HOLD_MIN_MS` = 150, `HOLD_MAX_MS` = 800); `HOLD_FALLBACK_MS` = 300 when neither is known; a number `policy.holdBudgetMs` is used as is (≥ 0) | `packages/runtime/src/decide/policy.ts` -> `holdBudget` | How long a held request or failure waits |
| `BACKGROUND_DEADLINE_MS` | ms | 5,000 | `packages/runtime/src/runtime.ts` | Deadline for decisions on non-held triggers (stalls, XHR failures, failures in guard mode, errors) |
| `PROFILED` | `Set<OpKind>` | `fetch xhr user task ws` | `packages/runtime/src/runtime.ts` | Op kinds whose causal chains feed transition profiles (`timer` and `genclass` never) |
| `errorsRecent` | count / ms | ≤ 64 entries; facts window 10,000 | `packages/runtime/src/runtime.ts` -> `reportError`, `makeEnv.recentErrors` | Recent-error facts |
| error key | chars | `Name:` + message with digit runs -> `n`, message part ≤ 120 | `packages/runtime/src/runtime.ts` -> `normalizeError` | Groups repeated errors |
| `uniq` counter | `uniq:N` | per runtime, from 1 | `packages/runtime/src/runtime.ts` -> `netHost().uniqueId` | Identity that matches nothing |
| timer label | string | `timer ${ms<1000 ? round(ms)+"ms" : secs(ms)}`, `interval ${secs(ms)}` (`secs`: 2 decimals < 10 s, 1 decimal < 1000 s, else integer) | `packages/runtime/src/observe/timers.ts`, `util.ts` -> `secs` | Timer op names (situation text) |
| `policy.holdUserWrites` | boolean | `false` | `packages/runtime/src/decide/policy.ts` | When false, user-sync writes are never held |
| WS JSON summary cap | chars | 16,384 | `packages/runtime/src/observe/websocket.ts` -> `summary` | Larger messages are summarised as `<len> chars` |
| element name length | chars | 40 | `dom-user.ts` -> `clean` | `describeElement` names |
| user value in `detail` | chars | 40 | `runtime.ts` -> `user` | `detail` truncation |
| nav route | chars | 80 | `nav.ts` | Route truncation |
| `insideIgnored` walk | nodes | 1,000 | `dom-user.ts` | `[data-genclass-ignore]` search |
| `redactSearch` | chars | output ≤ 60, input capped at 4,096 | `packages/runtime/src/util.ts` | Request `detail` |

## Invariants and gotchas

**Safety. The app must never break.**
- Every wrapper has to behave exactly like the native API when GenClass fails.
  - Parsing errors fall back to `nativeFetch`.
  - Tracing code inside wrapped methods (nav `pushState`/`replaceState`, storage methods, WebSocket `message` listener and `send`, the WebSocket connect `startOp`) is wrapped in try/catch. The DOM-user, XHR-state and error listeners are **not**; they are separate listeners, so a throw there is reported as an uncaught error rather than stopping the app's own handlers.
  - Installers that throw are skipped (`tryAdd`).
  - The app's fetch promise always settles: every controller path ends in `answer`, `sendNow` or the original rejection.
- Keep these properties when you edit.

**Pass-through after destroy.**
- Keep the `disabled` flag check in every wrapper (fetch, XHR, timers and the WebSocket constructor check it first; nav and storage call the native method first and then check it), and restore a global only if it still holds GenClass's wrapper.
- `test/review-fetch.test.ts` checks that a fetch through an APM-style wrapper installed on top creates no ops and no cache entries after `destroy()`.

**After destroy: what still runs** (from code reading; no test covers these). `RuntimeImpl.startOp`, `endOp`, `events.push` and `Context` do not check `destroyed`, so per-object hooks created earlier keep working:
- A `GenClassWebSocket` constructed before `destroy()` keeps its listeners and its own-property `send`: messages and sends still create `ws` ops and `custom` events, and messages still `stick`. Only sockets constructed afterwards (via a kept class reference) skip tracing.
- A timer callback scheduled before `destroy()` still calls `ctx.stick(lazyTimer(...))` when it fires; anything that then calls `ctx.op()` creates a `timer` op.
- An XHR object keeps its once-per-object listeners. After `destroy()` `open`/`send` are native again, so `st.op` is never refreshed, but a later readyState-4 still sticks that object's last op.
- Fetches already inside `runRequest` finish normally (held ones are released by `queue.dispose()`, see "Install, route and uninstall" step 5). New triggers from these objects run passive at once (`consultable()` is false).

**Op registry.**
- Ending is idempotent: `OpRegistry.end` and `RuntimeImpl.endOp` both ignore an op that already has `end` and is not in flight. Instant ops can never be re-ended (a plugin `api.endOp` on one is a no-op).
- Pruning removes ops from `byId` only. Links are numeric ids, so `ops.get(cause)` can return `undefined`; `ancestors`/`userOf` stop early and `rootOf` falls back to the op itself. Strong references still keep a pruned op alive: a `LazyOp` parent, an interval's captured `parent` (for the interval's lifetime), an XHR's `st.op`, `identicalMap`, `RecentEntry.op`.
- Ids, `uniq:N` and event `seq` are per runtime and never reset (`EventLog.clear` keeps `seq`).

**Multiple runtimes in one page** (from code reading; no test). Each runtime installs its own wrappers on top of the previous ones: two runtimes mean every fetch creates one op in each, and the outer runtime sees the inner wrapper as "native". `xhr.ts` -> `states` is a module-level `WeakMap`, shared by all runtimes from the same bundle. `NATIVE_FETCH` is captured at module load, so a bundle loaded after another library (or another GenClass bundle) wrapped `fetch` downloads its model through that wrapper.

**Never observe yourself.**
- The runtime schedules only through `Clock` (timers captured at module load in `packages/runtime/src/clock.ts`).
- The model host downloads with the module-load `fetch`.
- GenClass actions run in `runAsGenClass`. Their ops, and any op caused by them, are `genclass`, so they are never gated.
- Do not call `global.setTimeout` or `global.fetch` from runtime code.

**Determinism and sim parity.**
- Observers must use `host.clock`. No `Date.now`, `Math.random` or global timers.
- Op ids and `uniq:N` counters are sequential, so identical inputs give byte-identical situations (`test/situation.test.ts` -> "determinism").
- The sim runs the real `fetch`, `timers` and `websocket` observers on a virtual global (`sim/src/run/rt.ts` -> `createOptions`). It drives user actions through `runtime.user(act, handler)` (`sim/src/run/runner.ts`), with targets written in the same `role "name"` format that `describeElement` produces.
- Op names, details, event names, timer labels, signature normalisation and causal links all appear in situation text. Changing any of them changes training data. The format is frozen at tag `situation-v1`, and runtime `src` is unchanged since that tag. Coordinate with SIM and TRAIN (see [../model-io-contract.md](../model-io-contract.md)).

**No request trigger at all.**
- `keepalive` fetches are sent synchronously inside `fetch()`, so they survive unload (`test/review-fetch.test.ts` -> keepalive).
- Synchronous XHRs complete inside `send()`.
- Both skip the request trigger entirely, so there is no background decision either.
- A failed `keepalive` fetch still goes through the failure gate, and may be held in heal mode.

**Request identities and coalescing.**
- Holding requires the identity before the gate. That is why `Request` bodies are read from a clone, bounded to 64 KB and 100 ms. Before this fix, two different `Request` POSTs coalesced into one order (`test/review-fetch.test.ts` -> "two different POST bodies sent as Request objects…").
- Headers are part of the identity, so `Range` requests for different byte ranges are never identical.
- `headersKey` *merges* a `Request` input's headers with `init.headers`, whereas `fetch(request, { headers })` sends only `init.headers`. Identity can therefore include headers that are never sent (follows from the Fetch spec; no test). XHR identity sees only `setRequestHeader` calls, so a fetch and an XHR match only when their explicit headers match.
- Coalescing must never hang:
  - opaque or status-0 responses are shared as clones;
  - streaming bodies are given up after 1 s;
  - the wait is capped at 8 s, after which the request really sends.
  (`test/review-fetch.test.ts` -> describe "review: coalesce never hangs the app's fetch".)
- `shareable` only returns an *earlier* op (lower id).
- `settledAt` is set when the response headers arrive.
- 4xx responses are shareable by coalesce; only 5xx, 429 and 408 resolve to `null`. The GET cache keeps 2xx only.

**Memory bounds.**
- Buffers are bounded by 64 × 256 KB for the GET cache plus 64 entries / 4 MiB for the coalescing table. `test/review-fetch.test.ts` -> "buffered response bodies stay within the contract's cache bound (64 x 256 KB)" asserts that the bytes held by both together stay ≤ 64 × 256 KB in its 20-URL scenario.
- The abort listener is removed at send or answer. Without that, a long-lived `AbortSignal` would accumulate listeners.
- XHR listeners are added once per object.
- In-flight ops are never pruned. A request that never settles keeps its op forever.
- `ResponseCache.clear()` is never called, not even by `destroy()`.

**Cost.**
- Every request with a non-empty identity has a clone of its response buffered: up to 256 KB and up to 1 s of streaming.
- Each keystroke creates a user op, even though typing bursts share one event.
- In-flight ops (a connecting WebSocket, a long poll) delay settled points for up to 10 s each.

**XHR.**
- Faked properties are own properties, and `unfake()` must remove them on the next `open()`. Otherwise a reused XHR shows the stale 503 (`test/review-xhr.test.ts`).
- `abort()` while held must not call native `send`.
- An app `onreadystatechange` assigned *before* the first `open()` runs before GenClass's readyState-4 listener, so it does not see the XHR op ambient. Later listeners (`onload`, `loadend`) do. (unverified: follows from listener registration order; no test)
- `states` is a module-level `WeakMap` shared by every runtime created from the same bundle.

**Context.**
- `stick` is last-writer-wins.
- Context does not cross un-instrumented `await`s.
- The afterTask clear runs in a posted task. A non-instrumented callback that runs before that task could see a stale ambient op. (unverified: depends on the browser's task ordering; no test)
- The hub applies held writes inside `ctx.run(m.cause, …)`. Subscribers therefore run with the write's cause as the *running* op, and the DOM observer treats events they dispatch as programmatic.

**Signatures.**
- With no `global.location` (headless runtimes without one), every URL counts as same-origin, so cross-origin hosts drop out of signatures.
- Identity uses the full `href`, including any `#fragment`.
- A `data:` URL puts its whole payload into the op name, because `pathname` is the data. (unverified: follows from `parseUrl` and WHATWG URL semantics; no test)

**Privacy.**
- Sensitive field values are never recorded. This holds for unlabelled password inputs too (`test/review-dom.test.ts`).
- Values whose target name looks secret are redacted in `RuntimeImpl.user`.
- Request query values go through `redactSearch`.
- Nav routes are recorded and shown in timelines without redaction, and GenClass's own `learn.persist` writes (`localStorage.setItem("genclass.profiles.v1")`) appear as `storage` events. Both are also listed under open issues.

**Past bugs and their regression tests** (the REVIEW batch; STATUS.md "Batch 3" says all 34 review findings are fixed and the `test/review-*.test.ts` files pass unchanged). Do not regress these:

| Bug that existed | Fix (where) | Regression test (`packages/runtime/test/…` -> `it(...)`) |
|---|---|---|
| Two different `Request` POST bodies had the same identity and were coalesced into one order | Read a clone of the `Request` body before the gate (`fetch.ts` -> `wrapped`, `readKey`, `IDENTITY_READ_MS`) | `review-fetch.test.ts` -> "two different POST bodies sent as Request objects are not 'identical' (no coalesce of distinct orders)" |
| `Range` requests for different byte ranges counted as identical | Headers in the identity (`headersKey`) | `review-fetch.test.ts` -> "contract gap: concurrent Range requests for different byte ranges of one URL are not 'identical'" |
| Coalescing with an opaque / status-0 response hung the second fetch | `isOpaque` -> share a clone (`cache.ts`) | `review-fetch.test.ts` -> "coalescing with an opaque (status 0) response still settles the second fetch" |
| Coalescing waited for a whole streaming body | `BUFFER_WAIT_MS`, `COALESCE_MAX_WAIT_MS`, fall back to `sendNow()` | `review-fetch.test.ts` -> "coalescing with a still-streaming identical response does not wait for the whole stream" |
| Unbounded buffering | `MAX_BODY`, `MAX_ENTRIES`, `MAX_RECENT`, `MAX_RECENT_BYTES`, `COALESCE_WINDOW_MS` | `review-fetch.test.ts` -> "buffered response bodies stay within the contract's cache bound (64 x 256 KB)" |
| An `abort` listener left on a long-lived `AbortSignal` per request | `unlisten()` at send and at answer | `review-fetch.test.ts` -> "does not leave an abort listener on a long-lived AbortSignal for every finished request" |
| Work after `destroy()` when another library wrapped fetch on top | `disabled` flag; restore only if still ours | `review-fetch.test.ts` -> "after destroy, GenClass does no work even if another library wrapped fetch on top of it" |
| Failures held in guard mode although no failure action was permitted | `RuntimeImpl.trigger`: `waits = opts.hold && permitted.length > 0` | `review-fetch.test.ts` -> "a failed response is not held for the model when the mode allows no failure action" |
| A `keepalive` (unload) save could be held, so it was not on the wire before the page went away | `gateRequest = !keepalive` | `review-fetch.test.ts` -> "a keepalive request (page-unload save) reaches the network inside the fetch() call, even when salient" |
| A sync XHR was held (cannot be: it completes inside `send()`) | `!st.async` -> `doSend()` | `review-xhr.test.ts` -> "a synchronous XHR is never held: send() returns with the response" |
| An XHR aborted while held was sent later anyway | `wAbort` -> `abortedWhileHeld` | `review-xhr.test.ts` -> "an XHR the app aborts while GenClass holds it is never sent" |
| Listeners accumulated on a reused XHR | `stateOf` adds listeners once per object | `review-xhr.test.ts` -> "reusing one XHR object for many requests does not accumulate listeners (work per request stays constant)" |
| A reused XHR showed the stale faked 503 | `unfake()` in `wOpen` | `review-xhr.test.ts` -> "after a blocked answer, reusing the same XHR shows the real state and response" |
| Recursive `setTimeout` loops built lazy-op chains (stack overflow on the first write, retention) | `LazyOp` parent is always a real op; `materialize()` drops closures | `review-timers.test.ts` -> "a long idle loop (e.g. a clock/heartbeat) does not make the next state write throw", "a polling loop does not retain every past tick's op forever" (gc; needs `NODE_OPTIONS=--expose-gc`, otherwise it logs a skip and passes) |
| An unlabelled password input's value was recorded | `isSensitiveField` (`type=password`) | `review-dom.test.ts` -> "never records a password field's value, even when the field has no label/placeholder/name" |
| `el.click()` by app code inside an op was recorded as a user action | `programmatic(e)` via `runningKind` | `review-dom.test.ts` -> "a programmatic element.click() made by app code inside an op is not recorded as a user action" |
| Init threw on hardened pages with read-only globals | `tryAdd` | `review-misc.test.ts` -> "createRuntime does not throw when a global it would wrap is read-only (frozen/hardened pages)"; `batch3.test.ts` -> "createRuntime never throws on read-only globals (the observer is skipped)" |

## How to change it safely

1. **Add a new observer** (e.g. `EventSource`, `BroadcastChannel`).
   - Create `packages/runtime/src/observe/<name>.ts` exporting `install<Name>(host)`. It returns an uninstall function, or `null` when the API is missing.
   - Use a `disabled` flag, restore the global only if it is still yours, wrap all tracing in try/catch, and use `host.clock`.
   - Register it in `RuntimeImpl.installObservers` via `tryAdd` and `on("<name>")`.
   - Add the name to `ObserverName` in `packages/runtime/src/types.ts`, to `ALL_OFF` in `packages/runtime/src/index.ts`, and to the observe maps in `packages/runtime/test/helpers.ts` -> `setup`, `packages/runtime/test/browser/ui/session.ts`, `packages/runtime/test/review-*.test.ts` (`ONLY_*` constants) and `sim/src/run/rt.ts` (set it explicitly to `false` unless SIM wants it).
   - Reuse an existing `OpKind` if you can. A new kind touches `OpKind`, `opPhrase` in `packages/runtime/src/situation/describe.ts`, `PROFILED` in `runtime.ts`, and situation text (which needs SIM/TRAIN sign-off).
   - Tests to add: install and record; `destroy()` restores the global; pass-through after destroy; a read-only global does not throw.
   - App-specific sources can instead use a plugin with `api.recordOp`, `api.endOp` and `api.runInOp` (`RuntimeImpl.pluginApi`).
2. **Change signature normalisation.**
   - Edit `isIdSegment`/`isSlugId` in `packages/runtime/src/util.ts`.
   - Signatures key the baselines, `storeWriters`, the transition profiles persisted under `genclass.profiles.v1` (old keys stop matching), WS op names and situation text. (`identicalMap` is keyed by request identity, which hashes the full `href`, not the signature.)
   - Update `packages/runtime/test/batch3.test.ts` (SIM e). Run the full runtime suite and the sim tests, and re-freeze the situation tag with SIM.
3. **Add a volatile header.** Add it to both `VOLATILE_HEADERS` in `fetch.ts` and `VOLATILE` in `xhr.ts`, so identities stay equal across transports. Update STATUS.md's identity line.
4. **Change cache or buffer limits.**
   - Edit the constants in `packages/runtime/src/observe/cache.ts` and `fetch.ts`.
   - `test/fetch.test.ts` imports `MAX_BODY`/`MAX_ENTRIES`, and `test/review-fetch.test.ts` asserts the 64 × 256 KB bound.
   - Update `docs/runtime/API.md` (`serve_cached` row) and CONTRACT §7.
5. **Add or change a request/failure/stall action.**
   - Implement it in the controller (`reqCtl` / `failureGate` / `stallController` in `fetch.ts`, and `ctl` in `xhr.ts`, or throw `unsupported action`).
   - Register it in `packages/runtime/src/situation/questions.ts` (`BUILTIN_ACTIONS`, `TRIGGER_ACTIONS`) and gate when it is offered in `packages/runtime/src/situation/build.ts` -> `builtinApplicable`.
   - The action set is part of the model's questions, so retraining is needed. See [decide-policy-actions.md](decide-policy-actions.md).
   - Always set `synthetic: true` when GenClass answers instead of the network, and mark the response with `x-genclass`.
6. **Carry context across a new async boundary** (`requestAnimationFrame`, `queueMicrotask`, `MessagePort`).
   - Copy the timers pattern: capture `ctx.peek()` at schedule time, resolve a `LazyOp` to `.nearest`, and call `ctx.stick(lazyTimer(parent, label))` in the callback.
   - Never give a `LazyOp` a `LazyOp` parent, and never keep closures alive after materialisation.
   - Re-run `test/review-timers.test.ts`, including the gc test under `NODE_OPTIONS=--expose-gc`.
7. **Change DOM recording.**
   - Edit the handler table in `installDomUser`. Keep the `ignoredEvent(e) || programmatic(e)` guard, and the rule that sensitive fields record `""`.
   - Run `test/dom.test.ts` and `test/review-dom.test.ts` (happy-dom).
   - If `describeElement` output changes, coordinate with SIM: its synthetic targets mimic that format.
8. **Add an event kind or change an event's `data` keys.**
   - `EventKind` lives in `packages/runtime/src/types.ts` (public API).
   - Event `data` keys are load-bearing: `situation/describe.ts` -> `eventLine` reads `count`, `first` (user), `route` (nav), `key` (storage), `duration` (perf), `summary` (custom), `message` (error); `situation/build.ts` -> `timelineLines` decides relevance by `kind` (`user`, `error`, `action`, `nav` always relevant) and by `e.op` causality; `devtools/index.ts` and `devtools/ui.ts` switch on `kind`.
   - Changing any of these changes situation text (`situation-v1`): coordinate with SIM and TRAIN. Re-run `test/situation.test.ts`, `test/dom.test.ts`, `test/devtools.test.ts` and `test/devtools-runtime.test.ts`.
9. **Change op names, `detail` or causality** (timer labels, WS names, user op names, the leading-space body summary, `cause: null` roots).
   - These strings reach the model through `opPhrase`/`eventLine`, are mirrored by the sim (`sim/src/run/runner.ts` calls `runtime.user(act, handler)` with `role "name"` targets; `sim/src/run/rt.ts` turns on the real fetch/timers/websocket observers), and key baselines and profiles.
   - Re-run `test/context.test.ts`, `test/situation.test.ts`, `test/batch3.test.ts` and the sim's tests; re-freeze with SIM.
10. **Where to run tests.** The project contract (`docs/runtime/CONTRACT.md` §0 rule 5) says every build and test runs on the `train` VM via `scripts/vm.sh`. Under the 2026-10-07 run policy in AGENTS.md, agents on machines other than the original 8 GB Mac may run the build and unit tests locally. Ask the user before Playwright or the sim. The runtime unit tests run with `vitest run` (`npm test`) from `packages/runtime` (config `packages/runtime/vitest.config.ts`: `environment: "node"`, browser specs excluded). See [build-test-release.md](build-test-release.md).

## Tests

All paths are under `packages/runtime/test/`.

| Test file | What it asserts (this scope) |
|---|---|
| `helpers.ts` | `FakeClock` (timers plus a macrotask/microtask/afterTask model), `FakeServer` (virtual fetch), `ScriptedDecider`, `ManualDecider`, and `setup()`, which turns only the fetch observer on |
| `fetch.test.ts` | Neutral traffic makes no model call. The app reads its own body while GenClass reads a clone. `coalesce` reuses an in-flight POST (`x-genclass: coalesced`). `block` returns 503 `blocked` in heal mode, and guard never runs heal actions. `serve_cached` works. `delay` = 250 ms at streak 0. `retry` backs off 200 ms and the app gets attempt 2. `retry` is not offered for stream bodies. A network error is delivered as the original `TypeError`. Failure and request gates fail open at 300 ms. `hedge` wins a stall. Abort before send records `aborted`. `TimeoutError` gives `code: "timeout"`. The GET cache keeps ≤ 64 entries and skips > 256 KB. `destroy()` restores fetch |
| `review-fetch.test.ts` | `Request` bodies are part of the identity. `Range` splits the identity. Coalescing with opaque or streaming responses settles. Buffer memory ≤ 64 × 256 KB. No abort-listener leak. No work after destroy even when wrapped on top. Failures are not held in guard mode (app sees the 503 at +50 ms). `keepalive` is sent synchronously. Identical-request "after/before" direction and error-rate facts |
| `xhr.test.ts` | Op name, detail and cause. The op is ambient in `onload` (the write is attributed to it). `block` fakes a 503 `blocked` without sending. A failure is observed with no action question. The request gate holds and fails open at 300 ms. `destroy()` restores `open`/`send` |
| `review-xhr.test.ts` | A sync XHR is never held. `abort()` while held means never sent. A reused object does not accumulate listeners. Faked values are cleared on the next `open()` |
| `context.test.ts` | user -> fetch -> json -> set gives cause = fetch and root = user. Concurrent chains keep their own causes. `rt.op` is ambient in its body and after it settles. Nested fetch causes. afterTask clears the ambient op. A debounce timer carries the cause (`timer 300ms`). Idle timers create no ops |
| `review-timers.test.ts` | A 200,000-tick recursive `setTimeout` loop followed by a write does not throw. A polling loop does not retain past ticks' ops (gc test) |
| `dom.test.ts` (happy-dom) | `describeElement` names. Clicks are user writes and never held. Typing is one event per burst (`count: 3`, `value: "\"rea\""`). Passwords are never recorded. submit/change/Enter names. `[data-genclass-ignore]` is ignored, including in shadow roots. `destroy()` removes the listeners and restores fetch/XHR/history/Storage/WebSocket/timers. Nav and storage events are recorded. An `ErrorEvent` becomes an `error` trigger (`Uncaught TypeError: boom (at app.js:12).`) |
| `review-dom.test.ts` (happy-dom) | Unlabelled password values are never recorded. A programmatic `el.click()` inside `rt.op` is not a user action |
| `smoke.test.ts` | Context propagates through real awaits (user -> fetch -> json -> set) |
| `batch3.test.ts` | SIM e slug normalisation cases; `createRuntime` never throws on a read-only `fetch` global (the observer is skipped); `GenClass.init` never throws (a plugin whose `setup` throws) |
| `review-misc.test.ts` | `createRuntime` with a non-writable `fetch` does not throw |
| `situation.test.ts` | Determinism: the same scripted inputs on a fake clock give identical situations (depends on sequential op ids and identities) |
| `review-perf.test.ts` | Cost of `rt.user` keystroke writes on large stores (< 1 ms/write) |

Coverage gaps: there are no unit tests for WebSocket ops and causality, the perf observer, `sessionStorage` area detection, XHR `serve_cached`/`delay`, XHR `responseType` faking, or nav redaction. Also untested: stall `serve_cached`, interval-tick causality, what existing WebSockets/timers do after `destroy()`, two runtimes on one page, and `EventLog`/`OpRegistry` in isolation (they are exercised only through the runtime). The Playwright specs under `test/browser/` cover the model host and the devtools UI, not the observers.

## Drift and open issues

Doc-vs-code mismatches (the code is right):

| What | Doc says | Code does |
|---|---|---|
| Trusted-event filtering | `docs/runtime/ARCHITECTURE.md`: "DOM user events (capture phase, trusted events only)" | Untrusted events are kept unless a non-user op is running or ambient (`dom-user.ts` -> `programmatic`); test drivers rely on this |
| Signature normalisation | `docs/runtime/CONTRACT.md` §3: "numbers, uuids, long hex → `:id`" | Also long mixed tokens (≥ 16 chars) and short slug ids (`util.ts` -> `isIdSegment`, approved SIM e; STATUS.md records it) |
| Body methods that propagate context | CONTRACT §3 lists `json, text, arrayBuffer, blob, formData` | Also `bytes`, and `clone()` returns an instrumented clone (`fetch.ts` -> `instrumentResponse`) |
| Retry backoff | CONTRACT §7: `min(200 ms · 2^attempt, 5 s)` | `min(200 · 2^(attempt−1), 5000)`. STATUS "Deviations" and API.md are correct |
| What never matches | `docs/runtime/API.md`: "Bodies GenClass cannot read cheaply (streams, files, bodies over 64 KB) never match anything" | String bodies up to 1,048,576 chars are hashed and can match; the 64 KB limit applies only to Blob/ArrayBuffer/view/Request bodies (`fetch.ts` -> `bodyInfo`) |
| Identity definition | CONTRACT §3 and the `Op.identity` comment in `types.ts`: "hash of method+url+body" | Also non-volatile headers (`headersKey`) |
| Keepalive / sync XHR | API.md and STATUS: "never held" | They raise no request trigger at all (no background decision); the failure gate still applies to keepalive fetches |
| Observe defaults | `types.ts` `InitOptions.observe` comment: "Default: all true" | `timers` defaults to true only when `global.document` is an object (STATUS.md is correct) |
| Timer op materialisation | `timers.ts` header: "only materializes if the callback starts a request or writes state" | Also on `rt.emit`, `reportError`, storage writes, `rt.op`, WS send and plugin `recordOp`: anything that calls `ctx.op()` |
| `stick` call sites | `trace/context.ts` header: stick happens "after a wrapped fetch/XHR/body method settles, a user action is recorded, or a propagated timer fires" | Also on every WS message (`websocket.ts`) and when `rt.op` settles (`RuntimeImpl.op`) |
| `x-genclass` marking | `packages/runtime/README.md`: "Responses GenClass altered carry an `x-genclass` header" | Opaque responses shared by `coalesce` are unmarked clones. `retry`/`hedge` answers are real network responses (unmarked) |
| UI request | `packages/runtime/UI-NEEDS.md` item 1 (ignore the devtools overlay) is listed as **Open** | Implemented: `ignoredEvent` crosses shadow roots; tested in `test/dom.test.ts` |
| Instrumented sources list | ARCHITECTURE.md omits timers | Timers are an observer (browser-like globals only by default) |
| Pass-through after destroy | `packages/runtime/STATUS.md` module table: observers "all pass through after destroy" | True for the patched globals and prototypes. WebSocket instances and timer callbacks created before `destroy()` keep tracing (`websocket.ts` constructor listeners, `timers.ts` callback wrapper) |
| `Op.code` values | `types.ts` `Op.code` comment: "HTTP status, or an error name such as "TypeError" / "timeout"" | Observers set only HTTP status numbers, `"timeout"`, `"network"`, `"aborted"` and WS close codes; no error names (`fetch.ts`, `xhr.ts`, `websocket.ts`). Only plugin `api.endOp` can set arbitrary codes |
| `afterTask` mechanism | CONTRACT §3: `browserClock` uses "a `MessageChannel` for `afterTask`" | `clock.ts` -> `makeAfterTask`: `setImmediate` when there is no `window` (Node), else `MessageChannel`, else `setImmediate`, else `setTimeout(0)` |
| Which timer callbacks get context | CONTRACT §3 and API.md: "timer callbacks scheduled while an op was ambient" / "inside timers scheduled during an operation" | Every wrapped timer callback gets a `LazyOp`; with no ambient op at schedule time it materialises as a root `timer` op (`timers.ts`) |
| Abort-listener removal | STATUS "Memory": "the abort listener is removed when the request settles" | Removed when the request is **sent** (`send`, primary) or answered (`answer`), whichever comes first (`fetch.ts` -> `runRequest` -> `unlisten`) |
| Observed sources list | `packages/runtime/README.md`: "Fetch, XHR, WebSocket, DOM events, errors, navigation and storage are observed automatically" | Also long tasks (`perf`) and, in browsers, timers |

Open issues (from code reading; none has a test):
- Nav routes, including query strings and fragments, are not redacted. They go into `nav` events and are always "relevant" in situation timelines (`situation/build.ts` -> `timelineLines`).
- `ResponseCache` is not cleared on `destroy()`.
- `data:` URL fetches produce op names that contain the payload (unverified).
- XHR: an app `onreadystatechange` assigned before `open()` misses the ambient op (unverified).
- Header parity between `VOLATILE_HEADERS` and `VOLATILE` is not exact (e.g. `x-datadog-tags` is volatile only for XHR).
- `learn.persist` writes show up as `storage` events.
- Existing `GenClassWebSocket` instances and already-scheduled timer callbacks keep tracing after `destroy()` (see "After destroy: what still runs").
- WebSocket disconnects after `open` (error or close) are invisible: no op, no event, no trigger.
- `setInterval` ticks all keep the scheduling op as their parent, so a long-running interval started inside a user action keeps attributing its writes to that action's causal chain.
- Hedge op detail for a GET without a query is `(hedge)`, so `opPhrase` prints `GET /api/x(hedge)` with no space (`.trim()` removes the separator). Changing it touches situation text (`situation-v1`).
- Two runtimes on one page double-wrap every global (one op per runtime per request).
- `wrappedFetch.__genclass = true` is set but never read anywhere in the repo.
- Enter/Escape auto-repeat is not filtered, so holding Enter records many `key` user ops.

From STATUS.md / OPEN_TASKS.md (relevant here):
- The `situation-v1` freeze: OPEN_TASKS "Done" records runtime fix batch 3 as frozen at tag `situation-v1`, and STATUS "Open issues" says any change to situation wording must be coordinated with SIM. Op names, details and event names reach situation text (see "Determinism and sim parity"), so they fall under the same rule.
- OPEN_TASKS #6 "hold-induced harm": with model v0.1, search clean-run latency rose from 14 ms to 125 ms because salient *writes* were held. "Triage sensitivity on naturally concurrent apps": typeahead was salient about 6 times per trial on clean runs. Whether request-gate holds contribute is not stated there (unverified).
- Known risk: on slow devices, hold budgets expire more often (more fail-open decisions).

## Related docs

- [public-api-and-lifecycle.md](public-api-and-lifecycle.md): `GenClass.init`, `createRuntime`, options, kill switch, `destroy`
- [state-and-adapters.md](state-and-adapters.md): how state writes use the ambient op (`StoreHub.propose`, user-sync bypass, held writes)
- [learn-situation-triage.md](learn-situation-triage.md): baselines, identical-request facts, timeline lines from events, triage
- [decide-policy-actions.md](decide-policy-actions.md): `RuntimeImpl.trigger`, hold budget, policy gate, action records, late revert
- [model-host.md](model-host.md): model download with the native `fetch`
- [devtools.md](devtools.md): overlay under `data-genclass-ignore`; consumes `on("event")`
- [build-test-release.md](build-test-release.md): where and how to run the tests
- [../model-io-contract.md](../model-io-contract.md), [../sim.md](../sim.md): parity of situation text and the sim's use of these observers
- [../overview.md](../overview.md#3-runtime-data-flow-end-to-end) (where observers sit in the end-to-end flow), [../status-and-known-issues.md](../status-and-known-issues.md), [../glossary.md](../glossary.md), [../playbooks.md](../playbooks.md), [../repo-map.md](../repo-map.md), [../../../AGENTS.md](../../../AGENTS.md)
- Original specs: [../../runtime/CONTRACT.md](../../runtime/CONTRACT.md) (§3, §6, §7), [../../runtime/API.md](../../runtime/API.md), [../../runtime/ARCHITECTURE.md](../../runtime/ARCHITECTURE.md), [../../../packages/runtime/STATUS.md](../../../packages/runtime/STATUS.md)
