# @genclass/runtime: status (CORE)

Updated: 2026-10-07. Owner: CORE. SIM, DEMOS, UI and MODEL read this file. Contract: docs/runtime/CONTRACT.md.
API reference: docs/runtime/API.md.

## State

Everything in CORE's brief is implemented and tested (adapters and devtools moved to UI). On the VM:
`tsc --noEmit` clean for CORE files; `vitest run` (CORE tests, excluding test/model, test/browser, UI tests):
**14 files, 110 tests, all passing**.

| area | files | notes |
|---|---|---|
| public facade | `src/index.ts`, `src/types.ts`, `src/errors.ts` | `GenClass`, `createRuntime`, all public types, `GenClassUnavailableError` |
| clock | `src/clock.ts` | `browserClock` (performance.now, timers captured at load, setImmediate/MessageChannel afterTask) |
| trace | `src/trace/{events,ops,context}.ts` | ring buffer, ops registry (id-normalised signatures), ambient-op propagation (§3) incl. lazy timer ops |
| state | `src/state/{hub,fields,invariants}.ts` | atoms, guard, adapter seam, field versions + histories, mutation pipeline, invariant miner |
| observers | `src/observe/*.ts` | fetch, XHR, DOM user actions, errors, nav, storage, perf (longtask), websocket, timers, response cache |
| learn | `src/learn/{baselines,profiles}.ts` | latency median/p95, EWMA error rate, failure streaks, frequency vs usual, identical-request gaps, transition profiles |
| situation | `src/situation/*.ts` | facts, serializer (3,200-char budget), questions, triage, subject refs (shared with the sim) |
| decide | `src/decide/*.ts` | priority queue + cache, policy gate (§8), executor seam, console reports |
| runtime | `src/runtime.ts` | wiring, actions (rollback/resync/undo), settled points, plugins, ask/decide, explain |

## How to drive it headless (SIM, tests)

```ts
import { createRuntime } from "@genclass/runtime";
const rt = createRuntime({
  clock,                       // { now, setTimeout, clearTimeout, afterTask }
  global,                      // object whose fetch (and optionally XMLHttpRequest/WebSocket/document/...) is instrumented
  decider,                     // DecisionProvider; consulted only while status.state === "ready"
  observe: { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false },
  mode: "heal", triage: "salient", report: "silent",
  policy: { thresholds: { report: 0, guard: 0, heal: 0 }, holdBudgetMs: 1e9, maxActionsPerMinute: 1e9, requireDiagnosis: false },
  hooks: { opCreated(op) {}, mutationProposed(m) {} },
  vocabulary: { diagnoses: {...}, actions: {...} },   // optional wording overrides
});
```

- `global.fetch` is replaced at construction; `rt.destroy()` restores it (and every other wrapped global).
- `observe` defaults: every observer on, except `timers`, on only when `global.document` exists. Pass
  `timers: true` to get timer provenance ("timer 300ms", "interval 5.00s") and debounce causality headless.
- `createRuntime` has no model unless you pass `decider` or `model: {...}`. `GenClass.init()` creates the model host
  (`src/model/host.ts`, passing the native fetch captured at module load). Outside a browser (no `window` and
  `document`) `GenClass.init()` returns an inert runtime (no observers, no model): SSR-safe.
- User actions: `rt.user({ kind, target?, value?, key?, sensitive? }, handler?)`; `kind`: `click | type | change |
  submit | key | nav | navigate | <any>`. Typing on the same target within 1 s is one timeline event per burst; each
  keystroke is still its own user op. The user op stays ambient until `clock.afterTask`: every write in that task
  (and its microtasks, and in ops started from it synchronously) is a user write and is never held.
- `rt.op(name, fn)` records a task op (ambient in its body and when its promise settles); `rt.emit(name, data)` a
  custom event; `rt.reportError(e)` an error trigger.
- `app` in situations: `CreateOptions.app()` if given, else `global.document.title` and `global.location.pathname`
  (read when the situation is built; "unknown" when neither exists). `global.location.href` is the base for URLs.
- Settled points (invariants, transition profiles, consistent snapshots) need `settleMs` (default 60 ms) of quiet,
  no in-flight op younger than 10 s and no held write; scheduled with `clock.setTimeout`.
- Only the injected clock is used (now/setTimeout/clearTimeout/afterTask); no Math.random/Date.now/performance.now
  or global timers in runtime code (the `browserClock` default aside). Ids come from per-runtime counters, so two
  runtimes fed the same inputs produce byte-identical situations (tested).

## SIM requests (sim/NEEDS.md): done

1. DONE `EvaluateRequest.subject?: SubjectRef` = `{ kind; op?; mutation?; store?; paths?; cause?; error?; invariant? }`,
   never serialized into `state`; also `Decision.subjectRef`. mutation: `{ mutation, store, paths, cause }`;
   request/failure/stall: `{ op }`; transition: `{ op, store, paths }`; inconsistency: `{ store, paths, invariant }`;
   error: `{ error (raw object), op }`; ask: `{ op | store }`.
2. DONE `createRuntime({ hooks: { opCreated(op), mutationProposed(m) } })`. `opCreated` runs synchronously whenever
   an op is created (inside the instrumented `fetch(...)` call before any await, inside `user()`, `op()`, timers...).
   `mutationProposed({ id, store, paths, cause, changes })` runs synchronously inside `atom.set`/`update`, guarded
   set and adapter `propose`, before gating.
3. DONE `policy.requireDiagnosis` (default true; false skips the "top diagnosis != expected" gate).
4. DONE `vocabulary: { diagnoses?, actions? }` on Create/InitOptions. `diagnoses` replaces labels and wording
   (`expected` is always kept and listed first; plugin labels are appended). `actions` replaces descriptions of
   built-in or custom actions by name. (The earlier `diagnoses` option was removed in favour of this.)
5. DONE `runtime.situation(trigger?)` consumes no ids and records no events (tested); for a trigger built before it
   returns the last situation built for it, otherwise an "ask about now" situation. Token counting: MODEL's
   `src/model/tokenizer.ts`; the runtime keeps the state ≤ 3,200 characters (`STATE_CHAR_BUDGET`, `stateChars`).

## For UI (adapters, devtools)

- Everything the devtools needs is public: `on("decide"|"detect"|"act"|"event"|"status"|"report")`, `decisions()`,
  `interventions()`, `explain(id)`, `situation()`, `history()`, `inflight()`, `status`, `mode`, `setMode()`,
  `pause()/resume()`. `on("report", r)` receives every report line even when `report: "silent"`.
  Note: reading `rt.ready` starts a lazy model load (`preload: "lazy"`); prefer `rt.status` + `on("status")`.
- `runtime.adapter(name, { get, set?, subscribe? }, opts)` returns `{ propose({ fn | value, commit }), dispose() }`:
  the write is previewed with `fn(prev)` (e.g. the reducer), held when salient, and `commit` (e.g. the original
  `dispatch(action)`) runs when it applies, never when it is discarded. Without `set`, rollback skips the store.
  `runtime.guard(name, io)` also works when replacing the whole state is fine.

## Triggers and triage

| trigger | raised when | waits? | actions offered (passive first) |
|---|---|---|---|
| mutation | a non-user, non-GenClass write to a holdable store | yes (≤ holdBudgetMs) | apply, discard, defer (if < 2 defers) |
| request | every instrumented fetch/XHR not issued by GenClass | yes | send, coalesce*, delay, block, serve_cached* |
| failure | network error, timeout (`TimeoutError` abort), 5xx/429/408 | fetch: yes; XHR: no | deliver, retry* (replayable, < 4 attempts), serve_cached* |
| stall | in flight > max(4×median, 2×p95, 500 ms), ≥ 5 latency samples | no | wait, hedge* (idempotent GET), serve_cached* |
| inconsistency | a learned invariant breaks at a settled point (once per episode) | no | ignore, rollback*, resync* |
| transition | a completed op's write set / value kind / status class / write count seen in < 1% of ≥ 20 completions | no | ignore, rollback* (to the snapshot before the op), resync* |
| error | uncaught error / unhandled rejection / `reportError` | no | ignore, rollback* (if its chain wrote state) |

Triage (`"salient"`): facts are computed first (cheap); the full situation is built and the model consulted only if
a fact is non-neutral or a standing question has `always: true`. Non-neutral: a written field was written by
another chain since the cause op started; a field of the same store moved since then; a newer op with the cause's
signature is in flight; an identical *additive* change (numeric delta, added/removed items) in the last 10 s; an
identical request in flight or sent within min(2 s, half its usual gap); failure streak ≥ 2 (request); rate ≥ 3×
usual with ≥ 5 in 10 s; cause latency > 3× median; every failure/stall/inconsistency/transition/error. Plain
traffic makes no model call (tested). A trigger with only the passive action applicable omits the `action`
question (diagnosis only). While the model is loading or failed, every trigger fails open at once (passive, no
record); with `preload: "lazy"` the first salient situation starts the load. In `observe` mode nothing waits;
decisions are still made, recorded and reported.

Precision rules (beyond the policy gate): invariant candidates count only snapshots where they hold
non-trivially (e.g. membership among ≥ 2 items, non-zero equal values) and skip id-keyed collections; an op whose
usual write set is empty (a poll of stable data) is not "unusual" for writing something; an op and its descendant
flagged for the same anomaly raise one transition trigger (the descendant); undoing a rollback mutes that
violation until it holds again.

## Example situations (from test/situation.test.ts; the model gets the Jev state object, shown with `stateText`)

Diagnosis criteria (identical in every row, omitted below): expected, stale, conflict, duplicate, inconsistent,
failing, slow, overload, unusual with the §6 descriptions.

### mutation

```
app: /search
trigger: A write to search.results from GET /api/search?q=rea (#6) is about to be applied.
facts:
  search.results was written once by other operations since this write's cause (#6) started (version 0 → 1), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after it, from a later user action (#7).
  search.query changed since this write's cause (#6) started: "rea" → "reac", last by user typed "reac" into input "Search" (#7) 0.09s after it started.
  This write comes from GET /api/search?q=rea (#6), which started 0.90s ago and ended 0.00s ago (200); its chain began with user typed "rea" into input "Search" (#5) 0.90s ago.
  This write would change search.results: 2 items ["reac-1", "reac-2"] → 2 items ["rea-1", "rea-2"].
in_flight: none
timeline:
  -1.05s user typed "reac" into input "Search" (4 keystrokes, #1–#7)
  -1.05s write search.query: "" → "r" (by #1, user)
  -1.05s start GET /api/search?q=r (#2, by #1)
  -0.97s write search.query: "r" → "re" (by #3, user)
  -0.97s start GET /api/search?q=re (#4, by #3)
  -0.93s end GET /api/search?q=r (#2): 200 in 0.12s
  -0.93s GenClass Dropped the write to search.results from GET /api/search?q=r (#2); search stays at version 2.
  -0.90s write search.query: "re" → "rea" (by #5, user)
  -0.90s start GET /api/search?q=rea (#6, by #5)
  -0.85s end GET /api/search?q=re (#4): 200 in 0.12s
  -0.85s GenClass Dropped the write to search.results from GET /api/search?q=re (#4); search stays at version 3.
  -0.81s write search.query: "rea" → "reac" (by #7, user)
  -0.81s start GET /api/search?q=reac (#8, by #7)
  -0.69s end GET /api/search?q=reac (#8): 200 in 0.12s
  -0.69s write search.results: 0 items → 2 items ["reac-1", "reac-2"] (by #8)
  -0.00s end GET /api/search?q=rea (#6): 200 in 0.90s
state:
  search.results = 2 items ["reac-1", "reac-2"] (v1, by #8 0.69s ago)
  search.query = "reac" (v4, by #7 0.81s ago)
stats:
  GET /api/search: 4 done, errors 0%, 4 in last 10s
questions:
  diagnosis (choice): What is happening here?
  action (choice): What should the runtime do with this write?
    apply: let this write update the state now
    discard: drop this write and keep the current state
    defer: hold this write until the related in-flight operations finish, then decide again
```

### request

```
app: /search
trigger: POST /api/orders {items: [1], card: [redacted]} (#4) is about to be sent.
facts:
  1 identical POST /api/orders request in the last 10s: #2 in flight (started 0.12s ago); #2 started 0.12s before this one; they come from separate user actions 0.12s apart.
  This request comes from user clicked button "Place order" (#3), which started 0.00s ago.
  POST is not idempotent; its body (46 bytes) can be replayed.
in_flight:
  POST /api/orders {items: [1], card: [redacted]} (#2) 0.12s so far, by #1
timeline:
  -0.12s user clicked button "Place order" (#1)
  -0.12s start POST /api/orders {items: [1], card: [redacted]} (#2, by #1)
  -0.00s user clicked button "Place order" (#3)
  -0.00s start POST /api/orders {items: [1], card: [redacted]} (#4, by #3)
state: none
stats: none
questions:
  diagnosis (choice): What is happening here?
  action (choice): What should the runtime do with this request?
    send: send the request now
    coalesce: do not send; reuse the result of the identical request that is in flight or just finished
    delay: wait before sending, backing off so the service can recover
    block: do not send; fail this request immediately
```

### failure

```
app: /search
trigger: GET /api/status (#12) failed (HTTP 503) and the app has not seen the failure yet.
facts:
  The request #12 failed: HTTP 503 after 0.06s; the app has not seen the failure yet.
  4 identical GET /api/status requests in the last 10s (latest 3: #6 answered 200 6.00s ago; #8 ended 503 4.00s ago; #10 ended 503 2.00s ago); #10 started 2.00s before this one, neither from a user action.
  This is the 3rd GET /api/status failure in a row (recent outcomes: 200, 200, 503, 503, 503; last success 6.00s ago); error rate 27% over 6 requests.
  GET /api/status was requested 5 times in the last 10s (no usual rate learned yet).
  This request comes from task poll (#11), which started 0.06s ago.
  GET is idempotent.
  A cached 200 response from 6.00s ago exists for this request.
in_flight:
  task poll (#11) 0.06s so far
timeline:
  -6.06s start task poll (#5)
  -6.06s start GET /api/status (#6, by #5)
  -6.00s end GET /api/status (#6): 200 in 0.06s
  -6.00s end task poll (#5): ok in 0.06s
  -6.00s write status.checked: 1 → 2 (by #6)
  -4.06s start task poll (#7)
  -4.06s start GET /api/status (#8, by #7)
  -4.00s end GET /api/status (#8): 503 in 0.06s
  -4.00s end task poll (#7): ok in 0.06s
  -2.06s start task poll (#9)
  -2.06s start GET /api/status (#10, by #9)
  -2.00s end GET /api/status (#10): 503 in 0.06s
  -2.00s end task poll (#9): ok in 0.06s
  -0.06s start task poll (#11)
  -0.06s start GET /api/status (#12, by #11)
  -0.00s end GET /api/status (#12): 503 in 0.06s
state:
  status.checked = 2 (v2, by #6 6.00s ago)
  status.up = true (v1, by #2 10.0s ago)
stats:
  GET /api/status: 6 done, errors 27%, 5 in last 10s
questions:
  diagnosis (choice): What is happening here?
  action (choice): What should the runtime do with this failed request?
    deliver: pass the failure to the application as it is
    retry: retry the request after a short backoff
    serve_cached: answer with the last successful response for this request instead
```

### stall

```
app: /search
trigger: GET /api/report/:id (#16) has been waiting 0.96s for a response.
facts:
  The request #16 has been in flight for 0.96s; GET /api/report/:id usually takes 0.24s (p95 0.27s, 7 samples), 4.0× the median.
  1 identical GET /api/report/:id request in the last 10s: #14 answered 200 5.69s ago; #14 started 5.00s before this one, neither from a user action.
  Recent GET /api/report/:id outcomes: 200, 200, 200, 200, 200.
  This request comes from task refresh (#15), which started 0.96s ago.
  GET is idempotent.
  A cached 200 response from 5.69s ago exists for this request.
in_flight:
  task refresh (#15) 0.96s so far
timeline:
  -36.0s start GET /api/report/:id (#2, by #1)
  -35.8s end GET /api/report/:id (#2): 200 in 0.21s
  -31.0s start GET /api/report/:id (#4, by #3)
  -30.7s end GET /api/report/:id (#4): 200 in 0.22s
  -26.0s start GET /api/report/:id (#6, by #5)
  -25.7s end GET /api/report/:id (#6): 200 in 0.23s
  -21.0s start GET /api/report/:id (#8, by #7)
  -20.7s end GET /api/report/:id (#8): 200 in 0.24s
  -16.0s start GET /api/report/:id (#10, by #9)
  -15.7s end GET /api/report/:id (#10): 200 in 0.25s
  -11.0s start GET /api/report/:id (#12, by #11)
  -10.7s end GET /api/report/:id (#12): 200 in 0.26s
  -5.96s start GET /api/report/:id (#14, by #13)
  -5.69s end GET /api/report/:id (#14): 200 in 0.27s
  -0.96s start task refresh (#15)
  -0.96s start GET /api/report/:id (#16, by #15)
state: none
stats:
  GET /api/report/:id: 7 done, median 0.24s, p95 0.27s, errors 0%, 2 in last 10s (usual 2.31)
questions:
  diagnosis (choice): What is happening here?
  action (choice): What should the runtime do with this slow request?
    wait: keep waiting for the request
    hedge: send a second identical request and use whichever answers first
    serve_cached: answer with the last successful response for this request instead
```

### inconsistency

```
app: /search
trigger: The relation cart.total == sum(cart.items[*].price * cart.items[*].qty) no longer holds now that the app is settled.
facts:
  The learned relation cart.total == sum(cart.items[*].price * cart.items[*].qty) no longer holds: cart.total = 22, sum(cart.items[*].price * cart.items[*].qty) = 29. It held at 3 settled points before.
  The last consistent state is 0.45s old; 1 field write happened since.
  cart.items was written 0.06s ago by PATCH /api/cart/:id {qty: 2} (#5): 3 items, 1 changed: {id: 3, price: 7, qty: 1} → {id: 3, price: 7, qty: 2}.
  No operations are in flight (the app is settled).
in_flight: none
timeline:
  -1.11s user clicked button "Add to cart" (#1)
  -1.11s write cart.items: 0 items → 1 item [{id: 1, price: 10, qty: 1}]; cart.total: 0 → 10 (by #1, user)
  -0.81s user clicked button "Add to cart" (#2)
  -0.81s write cart.items: 1 → 2 items: added {id: 2, price: 5, qty: 1}; cart.total: 10 → 15 (by #2, user)
  -0.51s user clicked button "Add to cart" (#3)
  -0.51s write cart.items: 2 → 3 items: added {id: 3, price: 7, qty: 1}; cart.total: 15 → 22 (by #3, user)
  -0.21s user clicked button "+" (#4)
  -0.21s start PATCH /api/cart/:id {qty: 2} (#5, by #4)
  -0.06s end PATCH /api/cart/:id {qty: 2} (#5): 200 in 0.15s
  -0.06s write cart.items: 3 items, 1 changed: {id: 3, price: 7, qty: 1} → {id: 3, price: 7, qty: 2} (by #5)
state:
  cart.total = 22 (v3, by #3 0.51s ago)
  cart.items = 3 items [{id: 1, price: 10, qty: 1}, {id: 2, price: 5, qty: 1}, …] (v4, by #5 0.06s ago)
stats: none
questions:
  diagnosis (choice): What is happening here?
  action (choice): What should the runtime do about this inconsistent state?
    ignore: leave the state as it is
    rollback: restore the affected state to its last consistent snapshot
```

### transition

```
app: /search
trigger: POST /api/cart {} (#46) completed with a state change unlike its usual ones.
facts:
  In the previous 22 completions of POST /api/cart its chain wrote cart.items and cart.total (22 of 22 times); this time it wrote only cart.items.
  The last consistent state from before #45 started is 0.40s old; 1 field write happened since.
  It ended 0.06s ago with 200 after 0.08s (usual 0.08s).
  The completed operation #46 comes from user clicked button "Add" (#45), which started 0.14s ago.
  cart.items is now 23 items [1, 2, 3, …].
in_flight: none
timeline:
  -1.34s user clicked button "Add" (#39)
  -1.34s start POST /api/cart {} (#40, by #39)
  -1.26s end POST /api/cart {} (#40): 200 in 0.08s
  -1.26s write cart.items: 19 items [1, 2, 3, …] → 20 items [1, 2, 3, …]; cart.total: 57 → 60 (by #40)
  -0.94s user clicked button "Add" (#41)
  -0.94s start POST /api/cart {} (#42, by #41)
  -0.86s end POST /api/cart {} (#42): 200 in 0.08s
  -0.86s write cart.items: 20 items [1, 2, 3, …] → 21 items [1, 2, 3, …]; cart.total: 60 → 63 (by #42)
  -0.54s user clicked button "Add" (#43)
  -0.54s start POST /api/cart {} (#44, by #43)
  -0.46s end POST /api/cart {} (#44): 200 in 0.08s
  -0.46s write cart.items: 21 items [1, 2, 3, …] → 22 items [1, 2, 3, …]; cart.total: 63 → 66 (by #44)
  -0.14s user clicked button "Add" (#45)
  -0.14s start POST /api/cart {} (#46, by #45)
  -0.06s end POST /api/cart {} (#46): 200 in 0.08s
  -0.06s write cart.items: 22 items [1, 2, 3, …] → 23 items [1, 2, 3, …] (by #46)
state:
  cart.items = 23 items [1, 2, 3, …] (v23, by #46 0.06s ago)
  cart.total = 66 (v22, by #44 0.46s ago)
stats:
  POST /api/cart: 23 done, median 0.08s, p95 0.08s, errors 0%, 23 in last 10s
questions:
  diagnosis (choice): What is happening here?
  action (choice): What should the runtime do about this unusual state change?
    ignore: leave the state as it is
    rollback: restore the affected state to its last consistent snapshot
```

### error

```
app: /search
trigger: An uncaught TypeError was thrown: Cannot read properties of null (reading 'toUpperCase')
facts:
  Uncaught TypeError: Cannot read properties of null (reading 'toUpperCase').
  No consistent snapshot from before #1 started exists.
  Its chain wrote profile.name, profile.loaded before the error (last 0.00s ago).
  It was thrown while GET /api/profile (#2) was active, 0.10s after it started; that chain began with user clicked link "Profile" (#1).
in_flight: none
timeline:
  -0.10s user clicked link "Profile" (#1)
  -0.10s start GET /api/profile (#2, by #1)
  -0.00s end GET /api/profile (#2): 200 in 0.10s
  -0.00s write profile.name: "Ada" → null; profile.loaded: false → true (by #2)
  -0.00s error TypeError: Cannot read properties of null (reading 'toUpperCase') (during #2)
state:
  profile.name = null (v1, by #2 0.00s ago)
  profile.loaded = true (v1, by #2 0.00s ago)
stats:
  GET /api/profile: 1 done, errors 0%, 1 in last 10s
questions:
  diagnosis (choice): What is happening here?
```


## Deviations from the contract (and why)

- `retry` backoff is `min(200 ms · 2^(attempt-1), 5 s)`: the first retry waits 200 ms (the contract's formula with a
  1-based attempt would start at 400 ms).
- `coalesce` is not offered for XHR, and XHR failures/stalls are detection-only (the app receives XHR events
  directly, so they cannot be held). XHR `serve_cached` uses responses cached by fetch.
- `situation(trigger)` returns the last situation built for that trigger (an "ask about now" one otherwise).
- Extra public surface: `Runtime.adapter()`, `Runtime.inflight()`, `on("report")`, `Situation.salient/facts`,
  `Decision.tier/ran/answers/subjectRef`, `StandingQuestion.always`, `InitOptions.vocabulary/settleMs/learn`,
  `CreateOptions.app/hooks`, `ActionDef.tier`, `ActionContext.builtin/describe/onUndo`.
- Token budget: characters (3,200 ≈ 1,000 tokens), not the tokenizer, so the runtime does not need the model
  files to build situations. MODEL's packer still rejects anything over the position limit.

## Open issues

- UI's `src/adapters/redux.ts` currently has one type error (`prev` implicit any, line ~102); not CORE's file.
- Situations are tuned for the sim's training distribution; wording changes must be coordinated with SIM (one
  implementation, `src/situation/*`).
