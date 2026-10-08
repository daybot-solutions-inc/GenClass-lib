# @genclass/runtime: status (CORE)

Updated: 2026-10-08 (batch 4: situation v2, "never make a correct app worse"). Owner: CORE. SIM, DEMOS, UI, REAL
and MODEL read this file. Contract: docs/runtime/CONTRACT.md. API reference: docs/runtime/API.md.

## State

On the VM (`npm install` at the repo root; in packages/runtime with `GENCLASS_MODEL_DIR=~/gcl/model/.cache-model`
and `NODE_OPTIONS=--expose-gc`): `tsc --noEmit` clean, `tsup` build OK, `vitest run`: **40 files, 326 tests, 325
passing**. The one failure is UI's `test/devtools-runtime.test.ts` "lists the runtime's interventions": the overlay
titles a delivery intervention "Prevented a stale delivery" because `src/devtools/ui.ts` `NOUN` has no `delivery`
entry (UI-owned; one line: `delivery: "response"`, and "message" for WebSocket/EventSource subjects, as
`src/decide/report.ts` does). Every `test/review-*.test.ts` passes unchanged; MODEL's 62 pass. Perf (REVIEW's tests,
shared VM): keystroke write with a 5,000-item array 0.30 ms; async write 0.15 ms; redux-style dispatch on 5,000
entities 0.69 ms (user) / 0.66 ms (async); settled point 0.2 ms (+1.8 ms with an unchanged 5,000-item adapter store).

**Never worse (REAL's harness, `realapps/`, built from this tree):** an all-passive model in heal mode against
observe mode on the same scenario (`debug.js --interference`):
- `oss-react-redux-conduit` (the app that never rendered under situation v1): 0/30 runs changed (clean) and 0/30
  (with chaos); `--seed 3 --clean --mode guard|heal` renders the home page exactly as `--mode observe`.
- All 64 apps, seeds 1–6 (384 runs), clean: 26 differ; 23 only in server-side `updatedAt` timestamps (requests held
  by request-time decisions arrive a few ms later: same requests, same order, same bodies, same DOM). 3 differ in the
  DOM, all from a held delivery landing a few ms later relative to a scripted user step (latency only; the app is
  correct under either timing): saga-chat seed 4 (a pushed customer message held while the agent's own reply was in
  flight lands after the agent switched conversation, so it counts as unread: "3 unread" vs "2"), valtio-ledger seed 2
  (entries are appended in response order; a later scripted delete hits a different row), rtkq-helpdesk seed 5
  (not reproducible on rerun). With chaos: 64/384 differ, 3 in the DOM (mobx-portfolio, preact-likes, saga-chat:
  quote polls and chaos draws at shifted times). An earlier sweep (37 apps, before the XHR delivery gate; saga-chat
  and valtio-ledger did not exist yet) had no DOM diffs in clean runs.
- New regression test `test/no-reorder.test.ts`: realworld's promise middleware (drops a result when
  `viewChangeCounter` changed between dispatch and resolution) through `genclassEnhancer`, with an always-passive
  model answering after 10 ms: guard and heal, triage salient and always, give the same dispatches in the same order
  and the same final state as observe mode.

| area | files | notes |
|---|---|---|
| public facade | `src/index.ts`, `src/types.ts`, `src/errors.ts` | `GenClass` (init never throws), `createRuntime`, all public types, model host + errors re-exported |
| clock | `src/clock.ts` | `browserClock` |
| trace | `src/trace/{events,ops,context}.ts` | ring buffer, ops registry, ambient-op propagation; lazy timer ops never chain |
| state | `src/state/{hub,fields,invariants}.ts` | incremental flattening, mutation pipeline (no holds by default), drop filter, write logs, late revert, invariant miner |
| observers | `src/observe/*.ts` | fetch, XHR, DOM user actions, errors, nav, storage, perf, WebSocket, EventSource, timers, response cache; message gate (`messages.ts`) |
| learn | `src/learn/{baselines,profiles}.ts` | baselines with real failure counts, transition profiles (bounded) |
| situation | `src/situation/*.ts` | facts, version conflicts (`conflicts.ts`), budget-shaped serializer, compact questions, triage, subject refs |
| decide | `src/decide/*.ts` | queue (deadlines, stale drop, runtime-side timeout, cache, latency samples), §8 gate, reports |
| runtime | `src/runtime.ts` | wiring, delivery gate, actions (snapshot rollback, chain revert, resync, late revert, undo), settled points, plugins |

## Batch 4 (done): situation v2

**1. Decide at the network boundary, enforce synchronously at the store.** New trigger `delivery`: a fetch or XHR
response is about to reach the app (before the app's promise resolves / before `load` fires), or a WebSocket or
EventSource message is about to be dispatched (before any app listener runs).
- Predicted write set P of the delivering op: the store fields its signature's causal chain wrote in past
  completions (transition profile), else what the last completed op of that signature wrote, else unknown (never
  salient on version grounds). Paths are normalised (`board.cards.:id`) and matched against current fields.
- Salient iff a field in P has a **newer-data conflict** (its value now differs from when the op started and an op
  that started later, outside this op's chain and not a user action itself, wrote it since) or a **pending local
  change** (a user action's chain wrote it in the last 10 s and an op of that chain with a different signature is
  still in flight: an unconfirmed optimistic update). Inputs that moved, a newer same-signature request in flight, and
  user keystrokes that started newer requests of the same signature are never conflicts: in-order typeahead and
  autosave make zero model calls (tested with the DEMOS search app: input + loading written per keystroke, 150 ms
  debounce).
- Actions (passive first): `deliver` (passive); `discard` (guard): deliver, but drop the writes this op's chain makes
  over newer data, synchronously inside each write (other fields of the same write apply: loading flags, totals);
  `defer` (guard, offered when related ops are in flight, at most 2): hold until the related in-flight ops finish,
  then decide again. A dropped write is an event ("dropped the write of search.results by GET … over newer data (its
  other changes applied)") and the `ActionRecord.dropped` list (paths, updated as later writes of the chain are
  dropped; the mark lasts 10 s). Undo restores the dropped values.
- XHR: the app's completion listeners (`readystatechange`, `progress`, `load`, `loadend`, added with
  `addEventListener` before or after `open()`, or set as `on*` handlers) run through a thin wrapper; the first
  completion event of a successful response asks the gate synchronously, and while it holds the app's completion
  listeners are queued in order and run (op ambient) once delivered. `abort()` during the hold drops the response
  and fires `abort` + `loadend`. `on*` getters return the wrapper. Failures (status 0, 5xx/429/408) are not gated.
- Holding is only latency: the response object/event is unchanged; WebSocket/EventSource keep per-channel order
  (later messages and close/error events queue behind a held one; each held message gets its own decision when it
  reaches the head). Message ops are created synchronously inside the dispatch (`hooks.opCreated` fires before app
  listeners) and are ambient while the app's handlers run.
- Writes covered by a delivery decision (P known and covering the written fields, and the delivery was not salient or
  was decided in time) raise no `mutation` decision, except with `triage: "always"`.

**2. No store-write holds by default** (`policy.holdWrites: false`). A salient write not covered by a delivery
decision raises `mutation`, triaged when proposed and decided in the background after the write applies (never
blocks the app; `set(x); get()` returns x). A gate-passing `discard` becomes a late revert under the strict rules
(≤ 2 s, fields unchanged since, no later write in the same chain). Background decisions have a 5 s deadline.
`holdWrites: true` (opt-in) restores held writes with: (a) a later write to a store first applies that store's
earlier held writes, in order (a hold never reorders a store's writes); (b) inside the writing op's chain `get()`
returns the pending value (read-your-writes), elsewhere the applied one. Note: held writes are invisible to reads that
bypass the runtime (a redux middleware's `store.getState()`); keep `holdWrites` off for such stores, or pass
`hold: false` per store.

**3. Hold only when it can help.** A trigger holds only if the expected model latency fits the hold budget: expected
= usual provider latency × (1 + decisions queued ahead) + the decision being computed (at least as long as it has run
so far); infinite while the provider is not answering (its last evaluation timed out and none answered since). Queued
decisions whose subject was superseded (response already released, write overwritten, request aborted) are dropped
before they reach the model.

**4. `observe.untrustedEvents`** (default false): synthetic DOM events (`isTrusted === false`) are recorded as user
actions only when this is on (test harnesses; REAL already passes it). Events dispatched while an app operation's code
runs are never user actions.

**5. Request-time decisions** unchanged.

**Add-ons.** WebGPU (and unknown-device) situation budget 2,400 chars (TRAIN measured 2.4 chars/token: ≈ 1,000
tokens); 4-thread WASM 2,000, 1-thread 1,000 (linear between). Section limits are now full at 2,400 (12 facts, 6
in-flight, 16 timeline, 8 state, 4 stats) and compact at 1,100. The predicted write set is stated in the trigger
sentence; a separate fact is added only for a transition profile (its counts). Room is left in the fact set for
SIM's separability proposals (≤ 12 facts at full budget; delivery situations use 4–6 today).

**Tests.** `test/delivery.test.ts` (14): typeahead zero calls; stale out-of-order response → delivery `discard` drops
only `search.items` (the field with newer data) while the same write's other change (`search.loaded.a`) applies; holding is only latency; no hold when the model cannot
answer in time; read-after-write; late revert path; slow model (released at budget, writes decided in background);
superseded queued decision dropped; WebSocket order under a held message + discard; push messages touching nothing
pending deliver at once with no model call; EventSource custom event types; XHR: a stale response held before any completion listener (pre-`open()`
listener, `onload`, `loadend`; order kept), discard drops only the stale field; XHR hold = latency, op ambient,
`removeEventListener` of a wrapped listener, `abort()` during the hold; forced actions with probability 1.
`test/atoms.test.ts` runs with `holdWrites: true` and adds: user write never overtakes an earlier held write (DEMOS
regression), read-your-writes. `test/no-reorder.test.ts` (6, above). `test/dom.test.ts`: untrustedEvents.
Existing tests that assumed store holds now pass `policy: { holdWrites: true }` or were rewritten for `delivery`
(smoke, situation, budget, report, plugins, batch3). Touched outside my files (minimal, for the record):
`test/adapters-{react,redux,zustand}.test.ts` (`holdWrites: true` on real-runtime setups; react: answer the
delivery decision before the mutation one), `test/devtools-runtime.test.ts` (titles/regexes for the delivery
intervention), `test/browser/ui/session.ts` (its rule-based judge answers `delivery` like a stale `mutation`).

**Contract deltas (batch 4)**
- §5 triggers: new `delivery` (above). `mutation` is non-blocking by default; held only with `policy.holdWrites`.
- §5 salience: a version conflict is "newer data" (net change + a writer that started after X, outside X's chain,
  that is not itself a user action) or a "pending local change" (user-rooted write whose request of another
  signature is in flight). A plain user action that changed the field is NOT salient by itself (the batch-4 brief
  said "by a newer op or a user action"; counting every user write made DEMOS-style typeahead ask the model on
  every response, because keystrokes write `loading`).
- §6 budgets: full = 2,400 chars (was 3,200).
- §8: holds require expected latency ≤ hold budget; superseded queued decisions are dropped; late revert is the only
  enforcement path for writes when `holdWrites` is off.
- §2 observers: `eventsource` observer; `observe.untrustedEvents`.
- Types: `TriggerKind` + `delivery`; `SubjectRef {kind:"delivery", op, paths?, store?}` (paths = conflicting fields, else the matched predicted ones); `ActionRecord.dropped?: string[]`;
  `SituationDraft.delivery?: {channel, predicted, conflicts}`; `PolicyOptions.holdWrites?`; `ObserverName` +
  `eventsource`.

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
  unknown device 3,200. (Batch 4: webgpu and unknown device 2,400.)

## How to drive it headless (SIM, tests)

```ts
import { createRuntime } from "@genclass/runtime";
const rt = createRuntime({
  clock,                       // { now, setTimeout, clearTimeout, afterTask }
  global,                      // object whose fetch (and optionally XMLHttpRequest/WebSocket/EventSource/document/...) is instrumented
  decider,                     // DecisionProvider; consulted only while status.state === "ready"
  observe: { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false },
  mode: "heal", triage: "salient", report: "silent",
  policy: { thresholds: { report: 0, guard: 0.5, heal: 0.5 }, holdBudgetMs: 1e9, maxActionsPerMinute: 1e9, requireDiagnosis: false },
  situation: { budget: 1000 },                        // sample budgets (1000 / 1333 / 2000 / 2400); ≤ 1400 = compact questions
  hooks: { opCreated(op) {}, mutationProposed(m) {} },
  vocabulary: { diagnoses: {...}, actions: {...} },   // optional wording overrides
});
```

- `global.fetch` (and WebSocket, EventSource, …) are replaced at construction; `rt.destroy()` restores them.
- `observe` defaults: every observer on, except `timers`, on only when `global.document` exists. Synthetic DOM events
  are user actions only with `observe.untrustedEvents: true`.
- Holds are fully deterministic under the injected clock: a held response/message/request is released only by the
  decision (clock-timed provider), the hold budget timer, or `defer`'s wait (which re-enters the decider). Only the
  injected clock is used; same inputs → byte-identical situations at any budget (tested).
- Forcing (the sim's semantics, kept): thresholds 0.5, `requireDiagnosis: false`, an answer with probability 1 on an
  action runs exactly that action when the mode permits it (tested for `delivery` too).
- Observable effect of a delivery `discard`: `ActionRecord.dropped` (paths), plus an `action`/`dropped` event per
  dropped write (`data.paths`, `data.mutation`, `data.op`).
- `createRuntime` has no model unless you pass `decider` or `model: {...}`. Outside a browser `GenClass.init()` returns
  an inert runtime.
- User actions: `rt.user({ kind, target?, value?, key?, sensitive? }, handler?)`. Values are redacted when
  `sensitive` or when the target names a secret (`input "Password"`, `input "Card number"`); a kanban `card "…"`
  keeps its value. Typing on the same target within 1 s is one timeline event per burst.
- `app`: `CreateOptions.app()` if given, else `global.document.title` and `global.location.pathname`.
- Request identities for `Request` bodies are computed after a microtask read of a clone (≤ 100 ms of clock time);
  the op exists synchronously (opCreated) with `identity` filled in just before the request gate.
- WebSocket/EventSource message ops are created synchronously inside the message dispatch, before any app listener
  (opCreated fires there), and are ambient while the app's handlers run.

### Actions per trigger (exported as `TRIGGER_ACTIONS`, `PASSIVE`, `BUILTIN_ACTIONS`)

| trigger | passive | other actions (tier) | blocking? |
|---|---|---|---|
| delivery | deliver | discard (guard), defer (guard; only with related ops in flight, ≤ 2) | yes, when salient and an action is permitted and the model can answer within the hold budget |
| mutation | apply | discard (guard), defer (guard; < 2 defers) | no by default (background; discard = late revert ≤ 2 s); yes with `policy.holdWrites` |
| request | send | coalesce (guard, fetch), delay (guard), block (heal), serve_cached (heal, GET with a cached answer) | yes, when permitted |
| failure | deliver | retry (heal, replayable fetch, < 4 attempts), serve_cached (heal) | fetch: when permitted; XHR: no |
| stall | wait | hedge (heal, idempotent GET), serve_cached (heal) | no |
| inconsistency | ignore | rollback (heal), resync (heal) | no |
| transition | ignore | rollback (heal), resync (heal) | no |
| error | ignore | rollback (heal, only if its chain wrote state) | no |

With `holdWrites` off, a non-blocking `mutation` decision's `defer` is recorded only (nothing to hold).

## SIM requests (sim/NEEDS.md): done

1–5 (batch 1), 6 (batch 2), a–f (batch 3): DONE. Batch 4 / situation-v2: DONE: `SubjectRef {kind:"delivery", op,
paths?, store?}`; `hooks.opCreated` synchronous inside WebSocket and EventSource dispatch; deterministic holds;
action names/tiers/passive per trigger (table above; exported); forcing semantics kept; `ActionRecord.dropped` and
the `dropped` event; `hooks.mutationProposed` still synchronous; `situation()` side-effect free; `vocabulary`,
`situation.budget`, `requireDiagnosis` unchanged.

Wording changed in batch 4: new `delivery` trigger sentences ("The response to GET … (#6) arrived and is about to be
delivered; its operation last wrote search.results."), version facts take the op as reference ("since its operation
(#6) started", "this message (#5) started after that user action"), the pending-change fact ends with "<ref> started
after/before that user action", full budget 2,400. Regenerate rows.

## For UI (adapters, devtools)

- `src/devtools/ui.ts` `NOUN` needs `delivery: "response"` ("message" when the decision subject is a WebSocket or
  EventSource message, as `src/decide/report.ts` does), and `actTitle` should lead with "Reverted" when
  `ActionRecord.late` (the runtime's console line does). This is the one failing test.
- `test/browser/ui/mock-runtime.ts` `situationBudget()` returns 3200; the runtime's full budget is now 2,400.
- Adapters: with `holdWrites` off (default) `propose()` commits synchronously in the caller's stack (redux dispatch,
  zustand set); the model decides in the background. The hold paths of the adapters are exercised with
  `policy: { holdWrites: true }` (I added it to the real-runtime setups of your adapter tests).
- DOM observer: synthetic events need `observe.untrustedEvents: true`.

## Triggers and triage

| trigger | raised when |
|---|---|
| delivery | a fetch/XHR response (2xx–4xx not handled as a failure) or a WebSocket/EventSource message is about to reach the app |
| mutation | a non-user, non-GenClass write to a store, not covered by a delivery decision |
| request | every instrumented fetch/XHR not issued by GenClass (keepalive and sync XHR never held) |
| failure | network error, timeout (`TimeoutError` abort), 5xx/429/408 |
| stall | in flight > max(4×median, 2×p95, 500 ms), ≥ 5 latency samples |
| inconsistency | a learned invariant breaks at a settled point (once per episode) |
| transition | a completed op's write set / value kind / status class / write count seen in < 1% of ≥ 20 completions |
| error | uncaught error / unhandled rejection / `reportError` |

Triage (`"salient"`): facts first (cheap); the model is consulted only for a non-neutral fact or an `always`
standing question. Non-neutral: a newer-data conflict or a pending local change on a predicted/written field
(delivery, mutation); a newer op with the cause's signature in flight (mutation); an identical additive change in
10 s; an identical request in flight or sent within min(2 s, half its usual gap); failure streak ≥ 2 (request); rate
≥ 3× usual with ≥ 5 in 10 s; cause latency > 3× median; every failure/stall/inconsistency/transition/error. Neutral
(never asks by itself): inputs that moved, user writes alone, a newer same-signature request in flight at delivery.

## Example situations: compact budgets (from test/budget.test.ts)

The stale typeahead response (delivery) at 1,000 chars (1-thread WASM: compact questions) and 2,000 chars (4-thread
WASM: full questions). Questions are shown on one line each.

### delivery at 1000 chars (956)

```
app: /search
trigger: The response to GET /api/search?q=rea (#6) arrived and is about to be delivered; its operation last wrote search.results.
facts:
  search.results was written twice by other operations since its operation (#6) started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later user action (#7).
  search.query changed since its operation (#6) started: "rea" → "reac", last by user typed "reac" into input "Search" (#7) 0.09s after #6 started.
  The response to GET /api/search?q=rea (#6) arrived after 0.90s (200); the app has not seen it yet.
  This request comes from user typed "rea" into input "Search" (#5), started 0.90s ago.
in_flight: none
timeline:
  -0.00s end GET /api/search?q=rea (#6): 200 in 0.90s
state:
  search.results = 2 items ["reac-1", "reac-2"] (v3, by #8 0.69s ago)
  search.query = "reac" (v4, by #7 0.81s ago)
stats:
  GET /api/search: 4 done, 0 of last 4 failed, 4 in last 10s
questions:
  diagnosis: What is happening here? expected | stale | conflict | duplicate | inconsistent | failing | slow | overload | unusual | transient
  action: What should the runtime do with this response or message? deliver | discard
```

### delivery at 2000 chars (1611)

```
app: /search
trigger: The response to GET /api/search?q=rea (#6) arrived and is about to be delivered; its operation last wrote search.results.
facts:
  search.results was written twice by other operations since its operation (#6) started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later user action (#7).
  search.query changed since its operation (#6) started: "rea" → "reac", last by user typed "reac" into input "Search" (#7) 0.09s after #6 started.
  The response to GET /api/search?q=rea (#6) arrived after 0.90s (200); the app has not seen it yet.
  This request comes from user typed "rea" into input "Search" (#5), started 0.90s ago.
in_flight: none
timeline:
  -0.97s start GET /api/search?q=re (#4, by #3)
  -0.93s end GET /api/search?q=r (#2): 200 in 0.12s
  -0.93s write search.results: 0 items → 2 items ["r-1", "r-2"] (by #2)
  -0.90s write search.query: "re" → "rea" (by #5, user)
  -0.90s start GET /api/search?q=rea (#6, by #5)
  -0.85s end GET /api/search?q=re (#4): 200 in 0.12s
  -0.85s write search.results: 2 items ["r-1", "r-2"] → 2 items ["re-1", "re-2"] (by #4)
  -0.81s write search.query: "rea" → "reac" (by #7, user)
  -0.81s start GET /api/search?q=reac (#8, by #7)
  -0.69s end GET /api/search?q=reac (#8): 200 in 0.12s
  -0.69s write search.results: 2 items ["re-1", "re-2"] → 2 items ["reac-1", "reac-2"] (by #8)
  -0.00s end GET /api/search?q=rea (#6): 200 in 0.90s
state:
  search.results = 2 items ["reac-1", "reac-2"] (v3, by #8 0.69s ago)
  search.query = "reac" (v4, by #7 0.81s ago)
stats:
  GET /api/search: 4 done, 0 of last 4 failed, 4 in last 10s
questions:
  diagnosis: What is happening here? expected: normal behaviour, nothing is wrong | stale: outdated data or an older operation is about to replace newer state | conflict: concurrent operations are competing over the same state or resource | duplicate: the same change or request is happening again without a new intent | inconsistent: the state contradicts itself or relationships it normally keeps | failing: an operation keeps failing or its failures follow a pattern | slow: an operation is far slower than usual | overload: work is being triggered far more often than usual | unusual: this differs from how the same operation normally behaves | transient: a one-off failure that is likely to succeed if tried again
  action: What should the runtime do with this response or message? deliver: pass it to the application now | discard: deliver it but drop the state changes it would make over newer data
```

## Example situations: full budget (2,400), one per trigger (from test/situation.test.ts, test/delivery.test.ts)

### delivery: a stale out-of-order response

```
app: /search
trigger: The response to GET /api/search?q=rea (#6) arrived and is about to be delivered; its operation last wrote search.results.
facts:
  search.results was written twice by other operations since its operation (#6) started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later user action (#7).
  search.query changed since its operation (#6) started: "rea" → "reac", last by user typed "reac" into input "Search" (#7) 0.09s after #6 started.
  The response to GET /api/search?q=rea (#6) arrived after 0.90s (200); the app has not seen it yet.
  This request comes from user typed "rea" into input "Search" (#5), started 0.90s ago.
in_flight: none
timeline:
  -1.05s user typed "reac" into input "Search" (4 keystrokes, #1–#7)
  -1.05s write search.query: "" → "r" (by #1, user)
  -1.05s start GET /api/search?q=r (#2, by #1)
  -0.97s write search.query: "r" → "re" (by #3, user)
  -0.97s start GET /api/search?q=re (#4, by #3)
  -0.93s end GET /api/search?q=r (#2): 200 in 0.12s
  -0.93s write search.results: 0 items → 2 items ["r-1", "r-2"] (by #2)
  -0.90s write search.query: "re" → "rea" (by #5, user)
  -0.90s start GET /api/search?q=rea (#6, by #5)
  -0.85s end GET /api/search?q=re (#4): 200 in 0.12s
  -0.85s write search.results: 2 items ["r-1", "r-2"] → 2 items ["re-1", "re-2"] (by #4)
  -0.81s write search.query: "rea" → "reac" (by #7, user)
  -0.81s start GET /api/search?q=reac (#8, by #7)
  -0.69s end GET /api/search?q=reac (#8): 200 in 0.12s
  -0.69s write search.results: 2 items ["re-1", "re-2"] → 2 items ["reac-1", "reac-2"] (by #8)
  -0.00s end GET /api/search?q=rea (#6): 200 in 0.90s
state:
  search.results = 2 items ["reac-1", "reac-2"] (v3, by #8 0.69s ago)
  search.query = "reac" (v4, by #7 0.81s ago)
stats:
  GET /api/search: 4 done, 0 of last 4 failed, 4 in last 10s
questions:
  diagnosis (choice): What is happening here?
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
  action (choice): What should the runtime do with this response or message?
    deliver: pass it to the application now
    discard: deliver it but drop the state changes it would make over newer data
```

### delivery: a WebSocket message over a pending local change

```
app: /search
trigger: A WebSocket message /live (#5) arrived and is about to be delivered; messages like it last wrote board.cards.:id.
facts:
  board.cards.c1 has a pending local change: user clicked button "Move c1 to done" (#3) wrote it 0.05s ago and its PATCH /api/cards/c1 {col: "done"} (#4) is still in flight; this message (#5) started after that user action.
  A WebSocket message (#5) {n: 2, card: "c1", col: "doing"} arrived on /live; the app has not seen it yet.
in_flight:
  WS /live (#1) 0.10s so far
  PATCH /api/cards/c1 {col: "done"} (#4) 0.05s so far, by #3
timeline:
  -0.10s start WS /live (#1)
  -0.10s event ws.message {n: 1, card: "c2", col: "doing"} (#2)
  -0.10s write board.cards.c2: "todo" → "doing" (by #2)
  -0.05s user clicked button "Move c1 to done" (#3)
  -0.05s write board.cards.c1: "todo" → "done" (by #3, user)
  -0.05s start PATCH /api/cards/c1 {col: "done"} (#4, by #3)
  -0.00s event ws.message {n: 2, card: "c1", col: "doing"} (#5)
state:
  board.cards.c1 = "done" (v1, by #3 0.05s ago)
  board.cards.c2 = "doing" (v1, by #2 0.10s ago)
stats: none
```

### mutation: an older task's write over a newer task's (no delivery decision covers it)

```
app: /search
trigger: A write to profile.name from task load profile (#1) is about to be applied.
facts:
  profile.name was written once by other operations since this write's cause (#1) started (version 0 → 1), last 0.30s ago by task save profile (#2), which started 0.10s after #1.
  profile.saved changed since this write's cause (#1) started: 0 → 1, last by task save profile (#2) 0.10s after #1 started.
  This write comes from task load profile (#1), started 0.40s ago.
  This write would change profile.name: "Grace" → "Ada (cached)".
in_flight: none
timeline:
  -0.40s start task load profile (#1)
  -0.30s start task save profile (#2)
  -0.30s write profile.name: "Ada" → "Grace"; profile.saved: 0 → 1 (by #2)
  -0.30s end task save profile (#2): ok in 0.00s
state:
  profile.name = "Grace" (v1, by #2 0.30s ago)
  profile.saved = 1 (v1, by #2 0.30s ago)
stats: none
questions:
  diagnosis (choice): What is happening here?
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
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
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
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
  -6.00s write status.checked: 1 → 2 (by #6)
  -6.00s end task poll (#5): ok in 0.06s
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
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
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
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
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
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
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
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
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
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
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
- Batch 4 salience: a user action that changed a field is not, by itself, a version conflict (see Batch 4, contract
  deltas). XHR `on*` getters return GenClass's wrapper of the app's handler (needed so XHR implementations that call
  `this.onload(e)` themselves are gated too).
- With `holdWrites` off (default) `mutation` `defer` cannot do anything (the write already applied): it is recorded only.
- Extra public surface: `Runtime.adapter()/inflight()/holdBudgetMs()/situationBudget()`, `on("report")`,
  `Situation.salient/facts/compact/budget`, `Decision.tier/ran/answers/subjectRef/candidate/mass`,
  `ActionRecord.late/dropped`, `Explanation.message`, `StandingQuestion.always`, `PolicyOptions.holdWrites`,
  `observe.untrustedEvents`, `SituationDraft.delivery`,
  `InitOptions.vocabulary/settleMs/learn/situation`, `CreateOptions.app/hooks`, `ActionDef.tier`,
  `ActionContext.builtin/describe/onUndo`, `EvaluateRequest.timeoutMs/subject`.

## Open issues

- In-place mutation detection is best effort: arrays by reference/length plus 8 sampled elements, collections by key
  count, last key and 8 sampled values; a deep in-place change outside the samples can go unseen (subscribers are
  still notified on every `set()`).
- Lead (UI-NEEDS item 2): `react-dom` is not a devDependency of `@genclass/runtime`.
- Any change to situation wording must be coordinated with SIM (one implementation, `src/situation/*`).
- Predicted write sets are normalised paths (`board.cards.:id`): while one item of a collection has a pending local
  change, a message about another item of the same collection is salient too (extra latency, never a wrong drop:
  `discard` drops only fields with newer data or the pending change).
- `holdWrites: true` with adapter stores whose state is read directly (`store.getState()` in redux middleware):
  those reads do not see held writes (only the runtime's own `get()` does). Default off; per-store `hold: false`.
- Content comparison facts (response/write value vs current value: identical / older / newer version) are not
  implemented yet; waiting for SIM's separability proposals (room is left in the fact budget).
