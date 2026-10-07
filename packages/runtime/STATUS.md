# @genclass/runtime: status (CORE)

Updated: 2026-10-07 (batch 3: REVIEW fixes, SIM a–f, §8 gate, compact questions). Owner: CORE. SIM, DEMOS, UI and
MODEL read this file. Contract: docs/runtime/CONTRACT.md. API reference: docs/runtime/API.md.

## State

On the VM (`npm install` at the repo root; in packages/runtime with `GENCLASS_MODEL_DIR=~/gcl/model/.cache-model`
and `NODE_OPTIONS=--expose-gc`): `tsc --noEmit` clean, `tsup` build OK, `vitest run --exclude "test/browser/**"`:
**37 files, 300 tests, all passing**, including every `test/review-*.test.ts` (no review test was modified), UI's
53 and MODEL's 62. Measured on the shared VM (REVIEW's perf tests): keystroke write on a store with a 5,000-item
array 0.14 ms; gated async write 0.19 ms; redux-style dispatch on 5,000 entities 0.68 ms (user) / 0.58 ms (async);
settled point 0.2 ms (+1.4 ms with an unchanged 5,000-item adapter store).

| area | files | notes |
|---|---|---|
| public facade | `src/index.ts`, `src/types.ts`, `src/errors.ts` | `GenClass` (init never throws), `createRuntime`, all public types, model host + errors re-exported |
| clock | `src/clock.ts` | `browserClock` |
| trace | `src/trace/{events,ops,context}.ts` | ring buffer, ops registry, ambient-op propagation; lazy timer ops never chain |
| state | `src/state/{hub,fields,invariants}.ts` | incremental flattening, mutation pipeline, in-place-update protection, late revert, write logs, invariant miner |
| observers | `src/observe/*.ts` | fetch, XHR, DOM user actions, errors, nav, storage, perf, websocket, timers, response cache; all pass through after destroy |
| learn | `src/learn/{baselines,profiles}.ts` | baselines with real failure counts, transition profiles (bounded) |
| situation | `src/situation/*.ts` | facts, budget-shaped serializer, compact questions, triage, subject refs (shared with the sim) |
| decide | `src/decide/*.ts` | queue (deadlines, runtime-side timeout, cache, latency samples), §8 gate, reports |
| runtime | `src/runtime.ts` | wiring, actions (snapshot rollback, chain revert, resync, late revert, undo), settled points, plugins |

## Batch 3 (done)

**REVIEW findings (all 34; tests in `test/review-*.test.ts` pass unchanged)**
- Timers: a timer op links to the nearest op that exists (never to another lazy op) and drops its closure once
  created: recursive `setTimeout` loops no longer build chains (no stack overflow, no retention; the gc test runs).
- Patches: removals first, and a path is never removed when a change targets something beneath it (filling an empty
  object survives being held, queued, deferred, late-reverted and undone).
- Coalesce never hangs: opaque/status-0 responses are shared as clones; bodies are buffered only for 200–599
  readable responses, at most 1 s of streaming and 256 KB; a coalesced request waits at most 8 s; when the response
  cannot be shared the request is really sent (the ActionRecord says so).
- XHR: synchronous XHRs are never held; `abort()` while held means never sent (the app gets abort/loadend);
  faked values are removed on the next `open()` and respect `responseType`; listeners are added once per object.
- A throwing app setter/reducer/subscriber never strands a store's queue or settled points: reported as an error
  (`reportError`, source "the setter of X") and the queue continues; a synchronous `set()` still throws to its caller.
- In-place updaters: a write that may be held never changes live state before the decision: if the updater
  mutated the stored value, the result is detached into a copy and the live value restored exactly; when that is
  impossible the write applies at once with a fact ("could not be held: the update changed the stored value in
  place"). Change summaries use the recorded pre-change values ("2 → 3 items").
- keepalive requests are never held (sent inside the `fetch()` call).
- Init never throws: every observer installer is wrapped (read-only globals are skipped), `GenClass.init` falls back
  to an inert runtime with one console line.
- Request identity = method + URL + semantic headers (all except tracing ids: traceparent, tracestate, baggage,
  sentry-trace, x-request-id, x-correlation-id, request-id, b3/x-b3-*, x-datadog-*, x-amzn-trace-id,
  x-cloud-trace-context, newrelic, date, x-request-start, x-genclass) + body content: strings (≤ 1 MB),
  URLSearchParams, FormData without files, ArrayBuffer/views and Blobs ≤ 64 KB, Request bodies ≤ 64 KB (read from
  a clone before the gate, ≤ 100 ms). Anything else gets a unique identity (never "identical"). Range splits identity.
- Error-trigger rollback is offered only when the failing op's own chain wrote state, and restores only what that
  chain wrote (fields nobody overwrote since, to their values before the chain's first write). Transition rollback
  works the same way. Inconsistency rollback still restores the last consistent snapshot of the involved stores.
- Plugin `ctx.builtin()` goes through the same policy (mode tier, deny/allow, rate limit).
- Late revert (contract §8 "late-revert rules"), all must hold: the decision is a gate-passing `discard` (guard
  tier); the write applied ≤ 2 s ago; none of its fields changed since; no other write since in the same causal
  chain (including writes made synchronously by subscribers of that store, which now run with the write's cause as
  the ambient op). Otherwise the decision records the reason ("superseded: …", "the same operation chain wrote … ").
  The runtime stops waiting for an answer 2 s after the hold budget, so later answers are never recorded.
- Facts: "started 0.10s after/before this one" uses the real direction; failure facts report real counts
  ("error rate 60% over 5 requests (3 failed)", over the last 20 outcomes; the EWMA stays internal); write counts
  and versions come from a 512-entry log per field ("written 20 times … (version 0 → 20)").
- Arrays: every element counts (element hashes are incremental by reference, with a sampled re-hash of elements
  that kept their reference); plain objects with more than 32 keys are one field (a keyed collection).
- Redaction: invariant facts use the configured redactor; unlabeled password inputs are never named by their value.
- Precision: a short last page is not "unusual" (array kinds are empty / non-empty, no grew/shrank); entity keys
  with digits (`m21`, `u3x`) are `:id` in transition profiles; profiles are capped (64 write sets, 128 fields);
  `a != null` needs 6 supporting snapshots and is never proposed for a field ever seen null (initial value
  included); a consistent snapshot is taken at every settled point where nothing newly broke (a lingering, already
  reported violation no longer blocks snapshots); events dispatched by app code while an op runs (or untrusted
  events while a non-user op is ambient) are not user actions.
- Memory: coalescing buffers expire after 2 s and are capped (64 entries, 4 MB) next to the GET cache (64 × 256 KB);
  the abort listener is removed when the request settles; XHR listeners once per object.
- Never hold when the mode and policy permit no non-passive action for the trigger (e.g. failures in guard mode):
  the subject proceeds at once and the decision is still made in the background for detection.
- Big stores: incremental flattening (unchanged arrays/collections cost reference comparisons only), per-array
  statistics cached for the invariant miner, snapshots reuse unchanged stores and top-level keys, size caps before
  `JSON.parse` of bodies and WebSocket messages (16 KB).
- Runtime-side provider timeout: a provider that never answers is abandoned at the request deadline (10 s without
  one) so later decisions are not blocked.
- Console reports: the first of a series is printed, identical repeats in the next minute are counted and printed
  as one line when the minute ends ("(×N more in the last minute)"); the rate-limit warning once per minute.
- `destroy()`: wrappers that another library may still call become pass-throughs; `ask()` after destroy rejects with
  reason "destroyed".

**SIM requests (sim/NEEDS.md a–f)**
- a. Redaction by field semantics, not substrings: default redactor and typed values use word-level names
  (password, passcode, pin, token, secret, cvv/cvc/csc, ssn, iban, otp, cookie, authorization/auth, and pairs such
  as card number, credit card, api key, private key, session id, security code). "card", "cards", "author",
  "tokens", "pinned" are not secrets. DOM fields are also sensitive by type=password and autocomplete cc-* /
  one-time-code / current-password / new-password. (Deviation from §2's regex, approved in this batch.)
- b. State lines list only current leaves (no `parent = undefined`).
- c. "x changed 2 times since … and is back to 6" instead of "6 → 6".
- d. Item changes show the changed keys: `3 items, 1 changed: {id: 3, qty: 1 → 2}`; collections:
  `added m21: {…}`, `changed u3x: {age: 20 → 21}`.
- e. Short slug ids normalised in signatures, conservatively: ≥ 4 chars with letters and digits where a part starts
  with a digit (`tasks-1cam`), letters and digits alternate twice (`x7k2p`, `ab12cd`), or from 6 chars mixed case
  with digits (`PPBqWA9`). Not ids: `sha256`, `oauth2`, `ipv4`, `item42`, `v1beta1`, `x86_64`.
- f. New non-neutral fact for a write over a pending local change: "board.card7 has a pending local change: user
  clicked button "Move to done" (#1) wrote it 0.10s ago and its PATCH /api/cards/:id {…} (#2) is still in flight;
  this write comes from task ws message (#3), which started after that user action."

**Contract changes**
- §8 gate: A = applicable non-passive actions the mode permits, minus denied (only allowed when `allow` is set);
  candidate = argmax of probabilities over A; it runs iff Σ_{a∈A} p(a) ≥ the candidate's tier threshold, the top
  diagnosis is not `expected` (unless `requireDiagnosis: false`), under the rate limit, within the hold budget (else
  late-revert rules). `Decision.action` = the action that ran, else the model's own top choice; new fields
  `Decision.candidate` and `Decision.mass`. `reason` is given only when the model's own choice did not run.
  Reports: "Not acted on (would have done discard 0.70): …".
- New diagnosis label `transient` ("a one-off failure that is likely to succeed if tried again"), after `unusual`.
- Compact questions: when the situation budget is ≤ 1,400 chars, diagnosis options are bare labels and action
  options bare names (null descriptions), same instructions; a vocabulary override description is kept only if ≤ 24
  chars. `Situation.compact` and `Situation.budget` are recorded.
- Auto situation budget: webgpu 3,200; wasm 1,000 at 1 thread to 2,000 at 4 threads (1,333 at 2, 1,667 at 3);
  unknown device 3,200.

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
  situation: { budget: 1000 },                        // sample budgets (e.g. 1000 / 1333 / 2000 / 3200); ≤ 1400 = compact questions
  hooks: { opCreated(op) {}, mutationProposed(m) {} },
  vocabulary: { diagnoses: {...}, actions: {...} },   // optional wording overrides
});
```

- `global.fetch` is replaced at construction; `rt.destroy()` restores it (and every other wrapped global).
- `observe` defaults: every observer on, except `timers`, on only when `global.document` exists.
- `createRuntime` has no model unless you pass `decider` or `model: {...}`. Outside a browser `GenClass.init()` returns
  an inert runtime.
- With `thresholds: 0` every permitted candidate runs when the model's top diagnosis is not `expected` (or with
  `requireDiagnosis: false`). In guard mode only guard-tier actions are permitted; triggers with no permitted action
  are not held (decided in the background).
- User actions: `rt.user({ kind, target?, value?, key?, sensitive? }, handler?)`. Values are redacted when
  `sensitive` or when the target names a secret (`input "Password"`, `input "Card number"`); a kanban `card "…"`
  keeps its value. Typing on the same target within 1 s is one timeline event per burst.
- `app`: `CreateOptions.app()` if given, else `global.document.title` and `global.location.pathname`.
- Only the injected clock is used; same inputs → byte-identical situations at any budget (tested).
- Request identities for `Request` bodies are computed after a microtask read of a clone (≤ 100 ms of clock time);
  the op exists synchronously (opCreated) with `identity` filled in just before the request gate.

## SIM requests (sim/NEEDS.md): done

1–5 (batch 1): DONE (`EvaluateRequest.subject`, `hooks`, `policy.requireDiagnosis`, `vocabulary`, side-effect-free
`situation()`). 6 (batch 2): DONE `situation: { budget }`. a–f (batch 3): DONE (see above).

Fact and question wording changed again in batch 3 (versions "version a → b", real failure counts, compact
questions, item-level change summaries, `transient` label, pending-local-change fact): regenerate rows.

## For UI (adapters, devtools)

- Public API as before, plus `Decision.candidate`/`Decision.mass`, `Situation.compact`/`budget`, `Runtime.holdBudgetMs()`
  / `situationBudget()`. Detection lines now read "Not acted on (would have done X p): reason." (UI's splitReport
  regex for "Not acted on (...)" still matches.) Repeats of a report are printed as one summary line when the minute
  ends. `test/browser/ui/mock-runtime.ts` needs `holdBudgetMs()` and `situationBudget()` (not type-checked today).
- DOM observer ignores `[data-genclass-ignore]` subtrees (incl. shadow roots) and events dispatched by app code while
  an op runs.

## Triggers and triage

| trigger | raised when | waits? | actions offered (passive first) |
|---|---|---|---|
| mutation | a non-user, non-GenClass write to a holdable store | yes, when an action is permitted (hold budget; late revert ≤ 2 s after) | apply, discard, defer (if < 2 defers) |
| request | every instrumented fetch/XHR not issued by GenClass (keepalive and sync XHR never held) | yes, when permitted | send, coalesce*, delay, block, serve_cached* |
| failure | network error, timeout (`TimeoutError` abort), 5xx/429/408 | fetch: when permitted (heal); XHR: no | deliver, retry* (replayable, < 4 attempts), serve_cached* |
| stall | in flight > max(4×median, 2×p95, 500 ms), ≥ 5 latency samples | no | wait, hedge* (idempotent GET), serve_cached* |
| inconsistency | a learned invariant breaks at a settled point (once per episode) | no | ignore, rollback* (snapshot), resync* |
| transition | a completed op's write set / value kind / status class / write count seen in < 1% of ≥ 20 completions | no | ignore, rollback* (its chain's writes), resync* |
| error | uncaught error / unhandled rejection / `reportError` | no | ignore, rollback* (only if its chain wrote state) |

Triage (`"salient"`): facts first (cheap); the model is consulted only for a non-neutral fact or an `always`
standing question. Non-neutral: a written field was written by another chain since the cause started; a field of
the same store moved since then; a newer op with the cause's signature is in flight; a pending local change (a user
action's write whose request is still in flight) is being overwritten; an identical additive change in 10 s; an
identical request in flight or sent within min(2 s, half its usual gap); failure streak ≥ 2 (request); rate ≥ 3×
usual with ≥ 5 in 10 s; cause latency > 3× median; every failure/stall/inconsistency/transition/error.

## Example situations: compact budgets (from test/budget.test.ts)

The same stale-write situation at 1,000 chars (1-thread WASM: compact questions) and 2,000 chars (4-thread WASM:
full questions). Questions are shown on one line each.

### mutation at 1000 chars (998)

```
app: /search
trigger: A write to search.results from GET /api/search?q=rea (#6) is about to be applied.
facts:
  search.results was written once by other operations since this write's cause (#6) started (version 0 → 1), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later user action (#7).
  search.query changed since this write's cause (#6) started: "rea" → "reac", last by user typed "reac" into input "Search" (#7) 0.09s after #6 started.
  This write comes from GET /api/search?q=rea (#6), started 0.90s ago, ended 0.00s ago with 200; its chain began with user typed "rea" into input "Search" (#5).
  This write would change search.results: 2 items ["reac-1", "reac-2"] → 2 items ["rea-1", "rea-2"].
in_flight: none
timeline:
  -0.00s end GET /api/search?q=rea (#6): 200 in 0.90s
state:
  search.results = 2 items ["reac-1", "reac-2"] (v1, by #8 0.69s ago)
  search.query = "reac" (v4, by #7 0.81s ago)
stats:
  GET /api/search: 4 done, 0 of last 4 failed, 4 in last 10s
questions:
  diagnosis: What is happening here? expected | stale | conflict | duplicate | inconsistent | failing | slow | overload | unusual | transient
  action: What should the runtime do with this write? apply | discard | defer
```

### mutation at 2000 chars (1494)

```
app: /search
trigger: A write to search.results from GET /api/search?q=rea (#6) is about to be applied.
facts:
  search.results was written once by other operations since this write's cause (#6) started (version 0 → 1), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later user action (#7).
  search.query changed since this write's cause (#6) started: "rea" → "reac", last by user typed "reac" into input "Search" (#7) 0.09s after #6 started.
  This write comes from GET /api/search?q=rea (#6), started 0.90s ago, ended 0.00s ago with 200; its chain began with user typed "rea" into input "Search" (#5).
  This write would change search.results: 2 items ["reac-1", "reac-2"] → 2 items ["rea-1", "rea-2"].
in_flight: none
timeline:
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
  GET /api/search: 4 done, 0 of last 4 failed, 4 in last 10s
questions:
  diagnosis: What is happening here? expected: normal behaviour, nothing is wrong | stale: outdated data or an older operation is about to replace newer state | conflict: concurrent operations are competing over the same state or resource | duplicate: the same change or request is happening again without a new intent | inconsistent: the state contradicts itself or relationships it normally keeps | failing: an operation keeps failing or its failures follow a pattern | slow: an operation is far slower than usual | overload: work is being triggered far more often than usual | unusual: this differs from how the same operation normally behaves | transient: a one-off failure that is likely to succeed if tried again
  action: What should the runtime do with this write? apply: let this write update the state now | discard: drop this write and keep the current state | defer: hold this write until the related in-flight operations finish, then decide again
```


## Example situations: full budget, one per trigger (from test/situation.test.ts)

The model gets the Jev state object, shown with `stateText`. Diagnosis criteria (identical in every row, omitted):
expected, stale, conflict, duplicate, inconsistent, failing, slow, overload, unusual, transient with their descriptions.

### mutation

```
app: /search
trigger: A write to search.results from GET /api/search?q=rea (#6) is about to be applied.
facts:
  search.results was written once by other operations since this write's cause (#6) started (version 0 → 1), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later user action (#7).
  search.query changed since this write's cause (#6) started: "rea" → "reac", last by user typed "reac" into input "Search" (#7) 0.09s after #6 started.
  This write comes from GET /api/search?q=rea (#6), started 0.90s ago, ended 0.00s ago with 200; its chain began with user typed "rea" into input "Search" (#5).
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
  GET /api/search: 4 done, 0 of last 4 failed, 4 in last 10s
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
trigger: POST /api/orders {items: [1], cardNumber: [redacted]} (#4) is about to be sent.
facts:
  1 identical POST /api/orders request in the last 10s: #2 in flight (started 0.12s ago); #2 started 0.12s before this one; they come from separate user actions 0.12s apart.
  This request comes from user clicked button "Place order" (#3), started 0.00s ago.
  POST is not idempotent; its body (52 bytes) can be replayed.
in_flight:
  POST /api/orders {items: [1], cardNumber: [redacted]} (#2) 0.12s so far, by #1
timeline:
  -0.12s user clicked button "Place order" (#1)
  -0.12s start POST /api/orders {items: [1], cardNumber: [redacted]} (#2, by #1)
  -0.00s user clicked button "Place order" (#3)
  -0.00s start POST /api/orders {items: [1], cardNumber: [redacted]} (#4, by #3)
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
  This is the 3rd GET /api/status failure in a row (recent outcomes: 200, 200, 503, 503, 503; last success 6.00s ago); error rate 50% over 6 requests (3 failed).
  GET /api/status was requested 5 times in the last 10s (no usual rate learned yet).
  This request comes from task poll (#11), started 0.06s ago.
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
  GET /api/status: 6 done, 3 of last 6 failed, 5 in last 10s
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
  This request comes from task refresh (#15), started 0.96s ago.
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
  GET /api/report/:id: 7 done, median 0.24s, p95 0.27s, 0 of last 7 failed, 2 in last 10s (usual 2.31)
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
  cart.items was written 0.06s ago by PATCH /api/cart/:id {qty: 2} (#5): 3 items, 1 changed: {id: 3, qty: 1 → 2}.
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
  -0.06s write cart.items: 3 items, 1 changed: {id: 3, qty: 1 → 2} (by #5)
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
  The completed operation #46 comes from user clicked button "Add" (#45), started 0.14s ago.
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
  POST /api/cart: 23 done, median 0.08s, p95 0.08s, 0 of last 20 failed, 23 in last 10s
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
  Its chain wrote profile.name, profile.loaded before the error.
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
  GET /api/profile: 1 done, 0 of last 1 failed, 1 in last 10s
questions:
  diagnosis (choice): What is happening here?
  action (choice): What should the runtime do about this error?
    ignore: leave the state as it is
    rollback: restore the affected state to its last consistent snapshot
```


## Deviations from the contract (and why)

- `retry` backoff is `min(200 ms · 2^(attempt-1), 5 s)`: the first retry waits 200 ms.
- `coalesce` is not offered for XHR; XHR failures/stalls are detection-only (the app receives XHR events directly).
- Transition profiles compare array kinds as empty / non-empty only (§4 also lists the length delta sign; dropped for
  precision: a short last page or a removal is ordinary).
- Error/transition `rollback` restores only the fields the op's own chain wrote (the contract's "last consistent
  snapshot" would also revert other chains' writes, e.g. user input); inconsistency rollback uses the snapshot.
- Default redaction is by word-level secret names (approved SIM request a), not the §2 regex.
- `situation(trigger)` returns the last situation built for that trigger (an "ask about now" one otherwise).
- Extra public surface: `Runtime.adapter()/inflight()/holdBudgetMs()/situationBudget()`, `on("report")`,
  `Situation.salient/facts/compact/budget`, `Decision.tier/ran/answers/subjectRef/candidate/mass`,
  `ActionRecord.late`, `Explanation.message`, `StandingQuestion.always`,
  `InitOptions.vocabulary/settleMs/learn/situation`, `CreateOptions.app/hooks`, `ActionDef.tier`,
  `ActionContext.builtin/describe/onUndo`, `EvaluateRequest.timeoutMs/subject`.

## Open issues

- In-place mutation detection is best effort: arrays by reference/length plus 8 sampled elements, collections by key
  count, last key and 8 sampled values; a deep in-place change outside the samples can go unseen (subscribers are
  still notified on every `set()`).
- Lead (UI-NEEDS item 2): `react-dom` is not a devDependency of `@genclass/runtime`.
- Any change to situation wording must be coordinated with SIM (one implementation, `src/situation/*`).
