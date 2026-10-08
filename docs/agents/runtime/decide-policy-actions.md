# @genclass/runtime: decision queue, policy gate, actions, delivery gate, reports, explain and undo

> **Scope:** `packages/runtime/src/decide/decider.ts`, `packages/runtime/src/decide/exec.ts`,
> `packages/runtime/src/decide/policy.ts`, `packages/runtime/src/decide/report.ts`; the decision flow, the delivery
> gate, action implementations, late revert, `explain`, undo and plugin action/question plumbing in
> `packages/runtime/src/runtime.ts`; `BUILTIN_ACTIONS` / `TRIGGER_ACTIONS` / `PASSIVE` / `TRIGGER_DESCRIPTIONS` /
> `DEFAULT_DIAGNOSES` in `packages/runtime/src/situation/questions.ts`; the action and delivery controllers in
> `packages/runtime/src/observe/fetch.ts`, `packages/runtime/src/observe/xhr.ts` and
> `packages/runtime/src/observe/messages.ts` (followed only as far as the actions); the hub's drop filter in
> `packages/runtime/src/state/hub.ts`.
> **Read this when:** changing what happens after a trigger is built (queueing, deadlines, hold budget, expected
> latency, stale-item dropping, fail-open), the delivery gate, the policy gate or its defaults, any built-in action's
> mechanics or `changed` text, custom actions / standing questions, the console report wording,
> `Decision` / `ActionRecord` / `Explanation` shapes, `explain()` or undo.
> **Source of truth:** the code. Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins.

## TL;DR

- **Default mode is `observe`** (`packages/runtime/src/runtime.ts` -> `RuntimeImpl` constructor, `o.mode ?? "observe"`,
  commit f3636b2): it permits no non-passive action, so nothing is ever held, delayed or changed; decisions still
  run in the background and detections are still reported. `guard` is opt-in; `heal` is experimental.
- **situation-v2 decides at the network boundary** (commit fcd1e68, frozen at tag `situation-v2` = 6e5e86e). A new
  trigger `delivery` fires when a fetch/XHR response or a WebSocket/EventSource message is about to reach the app and
  the fields its operation is predicted to write hold newer data that the body would change (any newer-data conflict
  when the body cannot be read in 100 ms), or a pending local change / typed text the body would overwrite. Actions: `deliver` (passive), `discard` (guard: deliver, but drop that chain's writes over newer
  data for 10 s), `defer` (guard: wait for related in-flight ops, decide again, ≤ 2). Holding a delivery is only
  latency; channel order is kept.
- **Store writes are not held by default** (`policy.holdWrites: false`). A salient write that no delivery decision
  covers raises a non-holdable `mutation` trigger (`runtime.ts` -> `observeWrite`); the write applies at once and a
  gate-passing `discard` becomes a **late revert** (≤ 2 s after it applied, nothing overwrote it). `holdWrites: true`
  restores held writes (`gateMutation`), which never reorder a store's writes.
- Every trigger goes through `runtime.ts` -> `RuntimeImpl.trigger(spec, ctl, opts)`: triage, then build, then the
  single-flight priority queue (`DeciderQueue`). The subject is **held** only if the trigger is holdable
  (`opts.hold`), at least one non-passive action is permitted by mode + policy, the runtime is not paused, **and**
  the expected model latency fits the hold budget (`expectedLatency() <= holdBudgetMs()`). Otherwise the passive
  action runs at once and the decision is still made in the background.
- **Fail-open everywhere:** no provider, provider not `ready`, provider error (any `code`), queue overflow, expired
  deadline, superseded subject (`Controller.stale`), runtime-side timeout, hold budget expiry, a throwing action ->
  the passive action runs. A missing model never blocks the app and never produces a `Decision`.
- **Hold budget** (`policy.holdBudgetMs`, default `"auto"`): clamp(round(1.5 × median of the last 20 provider
  latencies, or the model's `warmupMs` before any), 150, 800) ms; 300 ms when nothing is known
  (`packages/runtime/src/decide/policy.ts` -> `holdBudget`).
- **Policy gate** (`policy.ts` -> `gate`, unchanged since situation-v1): A = applicable non-passive actions
  permitted by the mode (observe: none; guard: guard tier; heal: guard + heal) minus `deny` (only `allow` if set).
  Candidate = argmax of probability over A. It runs only if: not paused; Σ p(A) ≥ the candidate's tier threshold
  (guard 0.9, heal 0.8); the model's top diagnosis ≠ `expected` (unless `requireDiagnosis: false`); fewer than
  `maxActionsPerMinute` (60) actions in the last 60 s; and the subject has not already proceeded
  (`Controller.proceeded`), except for a late-revert `discard` and for custom actions.
- **Built-in actions** are generic capabilities defined in `situation/questions.ts` -> `BUILTIN_ACTIONS` and
  implemented by per-subject `Controller`s (`decide/exec.ts`): mutation (`runtime.ts` -> `mutationController`),
  delivery (`runtime.ts` -> `runDelivery`), request/failure/stall (`observe/fetch.ts`, `observe/xhr.ts`),
  inconsistency/transition/error (`runtime.ts` -> `rollback`, `revertChain`, `resync`). Guard tier: `discard`,
  `defer`, `coalesce`, `delay`; heal tier: `block`, `serve_cached`, `retry`, `hedge`, `rollback`, `resync`, custom
  actions by default.
- **Custom actions** (`rt.action(def)`, `plugin.actions`) are gated at their own tier (default `heal`), run inside a
  GenClass op, may call `ctx.builtin(name)` (re-checked against mode/policy/rate and `proceeded`, not thresholds).
  **Standing questions** (`rt.question`, `plugin.questions`) add questions; `onAnswer` gets the answer first.
- Every model answer to a trigger produces a `Decision` (`d<n>`); every non-passive action attempt produces an
  `ActionRecord` (`a<n>`, also when it failed). Both rings keep 200. `explain(id)` accepts either id. Reports are
  one line per detection (`Flagged …`) and per intervention (`Prevented …`, `Reverted …`), deduplicated per 60 s.

## Files

| Path | Role | Key exports / entry points |
|---|---|---|
| `packages/runtime/src/decide/decider.ts` | Single-flight priority queue in front of the `DecisionProvider`: deadlines, superseded-item dropping, runtime-side timeout, answer cache, latency samples, stuck flag, fail-open | `DeciderQueue` (`submit`, `latencies`, `clear`, `dispose`, `length`, `waiting`, `computing`, `computingSince`, `stuck`), `DecideResult`, `PROVIDER_TIMEOUT_MS` |
| `packages/runtime/src/decide/exec.ts` | Types only: the seam between the decision flow and the subject of a trigger | `ActionEffect`, `Controller`, `TriggerOpts`, `EndOpts`, `NetHost` (incl. `deliver`, `noteResponse`) |
| `packages/runtime/src/decide/policy.ts` | Policy config, mode/tier permission, the §8 gate, rate limiter, hold budget | `policyConfig`, `PolicyConfig`, `modeAllows`, `restriction`, `permittedActions`, `gate`, `GateInput`, `GateOutcome`, `RateLimiter`, `holdBudget`, `HOLD_MIN_MS`, `HOLD_MAX_MS`, `HOLD_FALLBACK_MS` |
| `packages/runtime/src/decide/report.ts` | Report sentences and console sink with dedupe | `interventionLine`, `detectionLine`, `decisionLine`, `Reporter` |
| `packages/runtime/src/runtime.ts` | Wiring: `trigger`, `onDecision`, `runCustom`, `mutationController`, `gateMutation` (holdWrites), `observeWrite` (default), `covered`, `expectedLatency`, `runDelivery` (delivery gate), `dropFilter`, `writtenOver`, `onDropped`, `waitOps`, `noteResponse`, `onChannel`, `markWrites`, `waitRelated`, `raiseInconsistency`, `raiseTransition`, `reportError`, `watchStall`, `rollback`, `revertChain`, `resync`, `runAsGenClass`, `explain`, `decisions`, `interventions`, `holdBudgetMs`, `action`, `question`, `use`, `setMode`, `pause`, `resume`, `destroy`, `setReport`, `isPaused` | `RuntimeImpl` (exported publicly from `src/index.ts`; `runDelivery` is a public member) |
| `packages/runtime/src/situation/questions.ts` | Action catalogue and diagnosis vocabulary (model-facing wording, frozen at tag `situation-v2`) | `BuiltinAction`, `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS`, `PASSIVE`, `ACTION_INSTRUCTIONS`, `TRIGGER_DESCRIPTIONS`, `DIAGNOSIS_INSTRUCTIONS`, `DEFAULT_DIAGNOSES`, `diagnosisVocabulary`, `actionDescription`, `buildQuestions`, `COMPACT_QUESTIONS_BUDGET` |
| `packages/runtime/src/situation/build.ts` | Which actions are offered for a subject (applicability); delivery subject text and `SubjectRef` | `buildSituation`, `subjectOf`, `relatedInFlight`, `subjectRef`, `ActionOption`, `BuiltSituation` (internal `builtinApplicable`, `revertableChain`) |
| `packages/runtime/src/situation/conflicts.ts` | Delivery prediction and conflicts (salience inputs; see [learn-situation-triage.md](learn-situation-triage.md)) | `predictedWrites`, `matchFields`, `conflictsOn` |
| `packages/runtime/src/situation/content.ts` | Response-body analysis at delivery (does the body change / put back a value) | `analyzeBody`, `createdIds`, `vhash`, `parseJsonBody` |
| `packages/runtime/src/observe/fetch.ts` | fetch controllers: request gate (`send`/`coalesce`/`delay`/`block`/`serve_cached`), failure gate (`deliver`/`retry`/`serve_cached`), stall (`wait`/`hedge`/`serve_cached`); calls `host.deliver` for successful responses | `installFetch` (internal `runRequest`, `failureGate`, `stallController`, `reqCtl`, `jsonOfBuffered`) |
| `packages/runtime/src/observe/xhr.ts` | XHR request gate (`send`/`delay`/`block`/`serve_cached`); delivery gate for successful async responses (wraps the app's completion listeners); failures/stalls passive-only | `installXHR` (internal `arrive`, `gateCall`, `wrapHandlers`, `fake`, `passiveOnly`) |
| `packages/runtime/src/observe/messages.ts` | Delivery gate for push channels: per-channel ordered queue, re-dispatch of released messages | `MessageGate`, `MsgHost`, `messageSummary` |
| `packages/runtime/src/observe/websocket.ts`, `packages/runtime/src/observe/eventsource.ts` | Install a `MessageGate` per socket / event source; report channel down/up | `installWebSocket`, `installEventSource` |
| `packages/runtime/src/observe/cache.ts` | Response buffers used by `coalesce` / `serve_cached` | `ResponseCache`, `makeResponse`, `blockedResponse`, `MAX_BODY`, `MAX_ENTRIES`, `COALESCE_WINDOW_MS`, `BUFFER_WAIT_MS` |
| `packages/runtime/src/state/hub.ts` | Applies a mutation verdict (`apply`/`discard`/`defer`) when `holdWrites`; calls `observeWrite` otherwise; applies the delivery drop filter; late-revert checks and patches | `StoreHub.holdWrites`, `.revertable`, `.revert`, `.reapply`, `.restoreFields`, `.commit`, `.flushQueue`, `.pendingView`, `Verdict` (internal `applyFilter`) |
| `packages/runtime/src/types.ts` | Public shapes | `Decision`, `Detection`, `ActionRecord` (incl. `dropped`), `Report`, `Explanation`, `PolicyOptions` (incl. `holdWrites`), `ActionDef`, `ActionContext`, `StandingQuestion`, `Plugin`, `EvaluateRequest`, `DecisionProvider`, `RuntimeEvents`, `SubjectRef`, `SituationDraft` (incl. `delivery`) |
| `packages/runtime/src/index.ts` | Re-exports `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS`, `PASSIVE`, `DEFAULT_DIAGNOSES` and `RuntimeImpl` publicly (not `decide/*`: `DeciderQueue`, `gate`, `policyConfig`, `PROVIDER_TIMEOUT_MS` etc. are internal) | — |
| `packages/runtime/test/helpers.ts` | Test doubles for this scope; `setup()` defaults to `mode: "guard"` (the product default is observe) | `setup`, `ScriptedDecider`, `defaultScript`, `ManualDecider`, `choice`, `FakeClock`, `FakeServer`, `drain` |

## Concepts and data structures

**Terms introduced here** (beyond the shared glossary):

- **controller**: an object implementing `Controller` for one trigger subject; `passive()` lets it proceed unchanged,
  `run(action)` performs a built-in action and returns an `ActionEffect` (or throws/rejects when it cannot).
- **waits**: in `RuntimeImpl.trigger`, `opts.hold && permittedActions(...).length > 0 && !paused &&
  expectedLatency() <= holdBudgetMs()` — whether this subject is actually held.
- **expected latency** (`runtime.ts` -> `expectedLatency`): `base × (1 + queue.waiting) + current`, where `base` is
  the lower median of the queue's latency samples (else `status.warmupMs`, else 0) and `current` is
  `max(base, now - computingSince)` while an evaluation is computing (else 0). `Infinity` while `queue.stuck`.
- **stuck** (`DeciderQueue.stuck`): the provider's last evaluation was abandoned by the runtime-side timeout and none
  has answered since. While stuck nothing is held.
- **proceeded** (`Controller.proceeded`): the subject already went its way (write applied, request sent, failure or
  response delivered). An action decided after that is late. Controllers without it fall back to
  `hold && (expired || passiveRan)`.
- **stale** (`Controller.stale`): a queued decision about this subject is no longer worth computing; the queue drops
  it before dispatch (resolves `null`).
- **expired**: the hold-budget timer fired before the decision; the passive action already ran.
- **candidate / mass**: the gate's argmax permitted action and Σ p over the permitted set (`GateOutcome`).
- **detection**: a `Decision` whose diagnosis ≠ `expected` and whose diagnosis probability ≥ `thresholds.report`.
- **intervention**: a non-passive action that ran (an `ActionRecord`).
- **delivery gate**: `runtime.ts` -> `runDelivery(o, release, defers)`: decides whether a response/message reaches the
  app now (`release()`), after the model, or after related ops (defer). Sets `op.delivery = { patterns, known,
  salient, decided, overNewer? }` on the subject op (`trace/ops.ts` -> `OpRec.delivery`).
- **covered write**: `runtime.ts` -> `covered(m)`: the write's causal chain (≤ 16 ancestors) passed a delivery gate
  whose prediction was known and includes every changed path, and that delivery was not salient or was decided
  before it proceeded. Covered writes raise no `mutation` trigger (never with `triage: "always"`).
- **discard mark / drop filter**: a delivery `discard` sets `op.discardMark = { protect, until, dropped, onDrop? }`;
  for `DISCARD_MARK_MS` (10 s) `StoreHub.propose` asks `runtime.ts` -> `dropFilter(m)` which changes of each write in
  that op's chain to drop (`hub.ts` -> `applyFilter`).
- **GenClass op**: an instant op of kind `"genclass"` started by `RuntimeImpl.runAsGenClass(name, fn)` (cause
  `null`); writes and requests made inside it are never gated, filtered or observed and are excluded from baselines
  and profiles.
- **sync verdict** (held mutations only): the verdict `gateMutation` observed while `trigger` was still on the stack;
  `"apply"` there means the write is not held at all (see flow 1).

`decide/decider.ts` consumes `types.ts` -> `EvaluateRequest { trigger; state: JevState; questions; priority?;
subject?: SubjectRef; timeoutMs? }` (the runtime sets the first five; the queue adds `timeoutMs`).

`situation/questions.ts` -> `BuiltinAction { name: string; tier: Tier; description: string }`; `Tier = "passive" |
"guard" | "heal"`, `Mode = "observe" | "guard" | "heal"`, `TriggerKind` = `mutation | request | delivery | failure |
stall | inconsistency | transition | error | ask` (`types.ts`).

Action helpers on `RuntimeImpl` (public members, used by the controllers):

```ts
runAsGenClass<T>(name: string, fn: () => T): T                         // run fn inside a GenClass op
rollback(stores: string[], violationIds: string[] = [], beforeSeq?: number): ActionEffect  // snapshot rollback
revertChain(op: OpRec, why: string): ActionEffect                       // chain revert (transition/error)
resync(stores: string[]): Promise<ActionEffect>                         // call StoreOptions.resync handlers
runDelivery(o: { op; channel: "response" | "websocket" | "eventsource"; req?; status?; message?; queuedAhead?;
  body?: () => Promise<unknown> }, release: () => void, defers = 0): void  // the delivery gate
```

`decide/exec.ts`:

```ts
interface ActionEffect {
  changed: string;                                                      // one sentence: exactly what GenClass altered
  undo?: () => void;
  onRecord?: (r: ActionRecord) => void;                                 // gets the record once it exists (delivery discard)
}
interface Controller {
  passive(): void;                                                      // must be idempotent in practice
  run(action: string): ActionEffect | Promise<ActionEffect>;            // throw/reject => passive runs, record ok:false
  revertable?(): string | null;                                         // late revert (mutations): null = can revert
  revert?(): ActionEffect;
  proceeded?(): boolean;                                                // the subject already went its way
  stale?(): boolean;                                                    // drop a queued decision about it
}
interface TriggerOpts { hold: boolean; priority: number }
// NetHost additions (fetch/XHR -> runtime):
deliver(o: { op; req; status; body?: () => Promise<unknown> }, release: () => void): void;  // the delivery gate
noteResponse?(o: { op; req; status; body }): void;                      // created ids (read-your-writes facts)
```

Which controllers implement `proceeded` / `stale`:

| Controller | `proceeded()` | `stale()` |
|---|---|---|
| mutation (`runtime.ts` -> `mutationController`) | `m.state === "done"` | the write was discarded, or a field it applied was written again since |
| delivery (`runDelivery`) | released | released |
| fetch request gate (`reqCtl`) | `sent \|\| answered` | `!sent && signal.aborted` |
| fetch failure gate | `handled \|\| answered` | — |
| XHR request gate | `decided \|\| abortedWhileHeld` | `abortedWhileHeld` |
| fetch stall, XHR `passiveOnly`, inconsistency/transition/error | — (non-holdable: fallback false) | — |

`decide/decider.ts`: `DecideResult { answers; latencyMs /* provider time, 0 for cache hits */; waitMs; cached }`.
Internal `QueueItem { req; deadline?: number /* absolute clock ms */; stale?: () => boolean; resolve; seq; t0 }`.
`submit(req, deadline?, stale?)` resolves `null` for every fail-open path, never rejects.

`decide/policy.ts`:

```ts
interface PolicyConfig { thresholds: { report: number; guard: number; heal: number }; allow?: Set<string>;
  deny: Set<string>; holdBudgetMs: number | "auto"; holdUserWrites: boolean; holdWrites: boolean;
  maxActionsPerMinute: number; requireDiagnosis: boolean }
interface GateInput { actions: { name: string; tier: Tier }[] /* all offered, passive included */;
  probabilities: Record<string, number>; top: string /* model argmax over offered */; diagnosis: string;
  mode: Mode; paused: boolean; now: number }
interface GateOutcome { run: string | null; candidate: string | null; mass: number; reason: string | null }
```

`situation/build.ts` -> `ActionOption { name; tier; description; custom?: ActionDef }` — `BuiltSituation.actions`
is the offered list, built-ins first in `TRIGGER_ACTIONS` order (passive first), then applicable custom actions.

`types.ts` (public):

```ts
interface Decision {           // id "d<n>"; Detection = Decision
  id; trigger; subject /* short subject text */; at; latencyMs /* trigger -> decision, incl. queue wait */;
  model /* status.model ?? status.variant ?? "custom" */; diagnosis; diagnosisConfidence /* diagnosisProbabilities[diagnosis] ?? answer.confidence ?? 0 */;
  diagnosisProbabilities; action /* run ?? model top */; confidence /* probabilities[action] */; probabilities;
  executed /* run !== null || tier(action) === "passive" */; reason?; facts /* all ordered facts, ≤ 12 */;
  tier /* tier of action */; candidate?; mass?; ran /* action that actually ran: run ?? PASSIVE[trigger] */;
  answers /* every answer incl. standing questions */; subjectRef?;
}
interface ActionRecord {       // id "a<n>"
  id; decisionId; action; tier; trigger; subject; at; ok; error?; changed; undo?: () => void; late?: boolean;
  dropped?: string[];          // delivery discard: paths dropped so far (grows while the 10 s mark lasts)
}
interface Report { kind: "detect" | "intervene" | "status"; message: string; decision?: Decision; action?: ActionRecord }
interface Explanation { message; decision; situationText; facts; timeline; answers; action?; changed? }
interface ActionDef { name; description; on: TriggerKind[]; tier?: "guard" | "heal" /* default heal */;
  risk?: "low" | "medium" | "high" /* declared, unused */; applicable?(sit: SituationDraft): boolean;
  run(ctx: ActionContext): void | Promise<void> }
interface ActionContext { trigger; decision; situation /* SituationDraft */; runtime;
  builtin(name: string): Promise<boolean>; describe(changed: string): void; onUndo(fn: () => void): void }
interface StandingQuestion { id; on: TriggerKind[]; question: Question; always?: boolean;
  onAnswer?(a: Answer, ctx: { decision; situation; runtime }): void }
// SubjectRef for delivery: { kind: "delivery", op, paths?, store? } (paths = conflicting fields, else matched predicted)
// SituationDraft.delivery?: { channel: "response" | "websocket" | "eventsource"; predicted: string[]; conflicts: string[] }
```

Internal `runtime.ts` -> `ExplainRec { decision; situationText /* stateText(situation.state) */; facts; timeline; answers; action? }`,
stored in `explainMap` under both the decision id and (once it exists) the action id.

`state/hub.ts` -> `Verdict = "apply" | "discard" | "defer"` (what a held mutation's promise resolves to; held
mutations exist only with `holdWrites`).

### Action catalogue (`situation/questions.ts`)

`TRIGGER_ACTIONS` (passive first) and `PASSIVE`:

| trigger | actions offered (before applicability) | passive |
|---|---|---|
| `mutation` | `apply`, `discard`, `defer` | `apply` |
| `request` | `send`, `coalesce`, `delay`, `block`, `serve_cached` | `send` |
| `delivery` | `deliver`, `discard`, `defer` | `deliver` |
| `failure` | `deliver`, `retry`, `serve_cached` | `deliver` |
| `stall` | `wait`, `hedge`, `serve_cached` | `wait` |
| `inconsistency` | `ignore`, `rollback`, `resync` | `ignore` |
| `transition` | `ignore`, `rollback`, `resync` | `ignore` |
| `error` | `ignore`, `rollback` | `ignore` |
| `ask` | (none) | `""` |

`ACTION_INSTRUCTIONS` (the `action` question's instructions): mutation "What should the runtime do with this write?",
request "… with this request?", delivery "What should the runtime do with this response or message?", failure "…
with this failed request?", stall "… with this slow request?", inconsistency "What should the runtime do about this
inconsistent state?", transition "… about this unusual state change?", error "… about this error?".
`DIAGNOSIS_INSTRUCTIONS` = "What is happening here?".

`TRIGGER_DESCRIPTIONS` (new in v2) overrides built-in descriptions for one trigger; only `delivery` has entries:
`deliver` "pass it to the application now", `discard` "deliver it but drop the state changes it would make over
newer data", `defer` "hold it until the related in-flight operations finish, then decide again".
`actionDescription(name, vocab, custom?, trigger?)` resolves `vocab.actions[name]` → `custom` →
`TRIGGER_DESCRIPTIONS[trigger][name]` → `BUILTIN_ACTIONS[name].description` → `name`.

`DEFAULT_DIAGNOSES` (order matters; `expected` is always first via `diagnosisVocabulary`): `expected`, `stale`,
`conflict`, `duplicate`, `inconsistent`, `failing`, `slow`, `overload`, `unusual`, `transient`. Descriptions are the
exact strings in CONTRACT §6 (asserted for `transient` in `test/batch3.test.ts`).

The `action` question is only asked when more than one action is offered (`buildQuestions`); with a single
(passive) option the runtime treats the answer as `{ [passive]: 1 }`. Question building and compact questions are
documented in [learn-situation-triage.md](learn-situation-triage.md).

## How it works

### 1. Trigger -> queue (`runtime.ts` -> `RuntimeImpl.trigger`)

Call sites and their `TriggerOpts`:

| Raised by | trigger | hold | priority |
|---|---|---|---|
| `runtime.ts` -> `observeWrite` (hub hook, default: `holdWrites` false) | `mutation` | false | 1 |
| `runtime.ts` -> `gateMutation` (hub `gate` hook, only with `holdWrites: true`) | `mutation` | true | 2 |
| `runtime.ts` -> `runDelivery` (from fetch, XHR, WebSocket, EventSource) | `delivery` | true | 2 |
| `observe/fetch.ts` -> `runRequest` request gate | `request` | true (`keepalive` requests raise no trigger: sent at once) | 2 |
| `observe/fetch.ts` -> `failureGate` | `failure` | true | 2 |
| `observe/xhr.ts` -> `wSend` (async XHR only) | `request` | true | 2 |
| `observe/xhr.ts` -> `onEnd` | `failure` | false (passive-only controller) | 1 |
| `runtime.ts` -> `watchStall` | `stall` | false | 1 |
| `runtime.ts` -> `raiseInconsistency` | `inconsistency` | false | 1 |
| `runtime.ts` -> `raiseTransition` | `transition` | false | 0 |
| `runtime.ts` -> `reportError` | `error` | false | 0 |

`observeWrite` and `gateMutation` both return early (no trigger) when `consultable()` is false or the write is
`covered(m)`; `observeWrite` also skips GenClass writes. The hub calls neither for writes that bypass gating (user-sync
writes without `holdUserWrites`, GenClass writes, stores with `hold: false`, `!gating`), that change nothing, that the
delivery drop filter dropped entirely, or (with `holdWrites`) that are unholdable because the updater mutated the
stored value in place (`hub.ts` -> `propose`). Network triggers are raised only when `NetHost.gated(op)` (not paused, not destroyed, not a
GenClass op). `watchStall` fires once per op at `max(4 × median, 2 × p95, STALL_MIN_MS 500)` ms, only with a latency
baseline (≥ 5 samples). Settled-point triggers are covered in [state-and-adapters.md](state-and-adapters.md) and
[learn-situation-triage.md](learn-situation-triage.md).

Steps:

1. `consultable()` must be true (not paused, not destroyed, a decider exists, its `status.state` is `"ready"` or
   `"off"`); else run passive and return (no record). `"loading"` and `"error"` fail open here.
2. `computeFacts(env, spec)` (cheap pass). If `triage === "salient"`, no standing question with `always` covers this
   trigger, and every fact is neutral -> passive, no record.
3. `buildSituation(...)` (a throw -> passive). Stored in `lastBuilt[trigger]` (what `rt.situation(trigger)` returns).
4. If `!built.salient && !built.forced` -> passive.
5. If the provider is not `"ready"` (i.e. `"off"`): read `this.ready` (starts the lazy load) and run passive.
6. `permitted = permittedActions(policy, mode, built.actions)`; `waits = opts.hold && permitted.length > 0 && !paused
   && expectedLatency() <= holdBudgetMs()`. If `!waits`, run passive **now** and keep deciding in the background.
7. `budget = holdBudgetMs()`. If `waits`, start a budget timer: on fire set `expired = true` and run passive.
8. Deadline: `waits` -> `t0 + budget + (ctl.revert ? LATE_REVERT_MS : 0)` (only a held mutation has `revert` and
   waits); not waiting -> `t0 + BACKGROUND_DEADLINE_MS` (5,000), which includes default-mode background mutations.
9. `queue.submit({ trigger, state, questions, priority: waits ? opts.priority : min(opts.priority, 1), subject },
   deadline, ctl.stale)`.
10. On result: clear the budget timer; destroyed or `null` -> passive; else `onDecision(...)`. Any throw -> passive.

The `passive` closure in `trigger` is guarded by `passiveRan`, so the controller's `passive()` runs at most once
through that path. `t0` is read after the situation is built, so `Decision.latencyMs` excludes build time.

Held-mutation specifics (`gateMutation`, `holdWrites` only): it calls `trigger` synchronously; if the controller's
`passive()` ran during that call (steps 1–6), the sync verdict is `"apply"` and it returns `{}`, so the hub applies
the write in the caller's stack. Otherwise it returns `{ held: Promise<Verdict> }`. The hub's `mayHold` hook
(`hub.holdWrites && consultable() && mode !== "observe"`) only decides whether a hold-safe preview is prepared. A later
write to the same store that applies at once (bypass, no change, unholdable) first flushes that store's held writes in
order (`StoreHub.flushQueue`); a later gated write queues behind them (`drain` applies in proposal order); and inside the
writing chain `get()` returns the pending value (`StoreHub.pendingView`) ([state-and-adapters.md](state-and-adapters.md)).

Default-mode mutations (`observeWrite`): the hub calls it right before `commit`, so the situation is built as of the
proposal, then the write applies. The controller is `mutationController(m, null)`: `passive()` is a no-op and `run`
throws `the write was not held`; by the time the answer arrives `proceeded()` is true, so only the late-revert path
(flow 5) can act.

### 2. Queue (`decide/decider.ts` -> `DeciderQueue`)

1. `submit` pushes an item; if the queue exceeds `MAX_QUEUE` (32) the lowest-priority, oldest item is resolved
   `null` (fail-open).
2. `pump` (while not busy): take the highest priority, oldest (`seq`) item.
   - `now >= deadline` -> `null` (never computed).
   - `item.stale()` true (a throw counts as false) -> `null` (never computed). Asserted in `test/delivery.test.ts`
     ("drops a queued background decision whose write was superseded").
   - provider missing or not `"ready"` -> `null`.
   - cache key `fnv1a(trigger + "\0" + stableStringify(state) + "\0" + stableStringify(questions))` (`util.ts`;
     `subject` and `priority` are not part of it); a hit with `now - t <= CACHE_TTL` (30,000 ms) resolves with
     `cached: true`, `latencyMs: 0` (no latency sample, no provider call).
   - else `dispatch`.
3. `dispatch`: `busy = true`, `since = t1`; runtime-side timer `limit = deadline ? max(1, deadline - t1) :
   PROVIDER_TIMEOUT_MS` (10,000). The provider receives `timeoutMs = max(1, deadline - t1)` when a deadline exists.
4. Provider resolves an object -> `overdue = false`, cache it (insertion-order eviction beyond `CACHE_MAX` 64), push
   `t2 - t1` to the latency ring (last `LATENCY_SAMPLES` 20), resolve. Sync throw, rejection, or timer fire ->
   `onError` + `null`; a non-object answer -> `null` without `onError`. The timer sets `overdue = true` and passes
   `onError` an `Error("the decision provider did not answer in time")` with `code: "timeout"`. `done` is
   idempotent; it clears `busy` and pumps the next item.
5. `onError` in `runtime.ts`: `code === "max_tokens_exceeded"` shrinks automatic situation budgets
   (`budgetScale = max(0.5, budgetScale × 0.8)`, never restored); every error is logged (`console.debug`) only with
   `debug: true`. Model-host error codes (`model/errors.ts` -> `ModelErrorCode`) all fail open the same way.
6. `clear()` resolves every queued item `null`; `dispose()` (from `RuntimeImpl.destroy`) sets `disposed` and clears.

Read-only getters used by `expectedLatency`: `waiting` (= `length`, queued items excluding the one computing),
`computing` (busy), `computingSince`, `stuck` (= `overdue`).

`rt.ask()` / `rt.decide()` also use this queue: priority 1, deadline `now + timeoutMs` when given (else the 10 s
runtime timeout). They bypass triage, the gate and `Decision` records (see
[public-api-and-lifecycle.md](public-api-and-lifecycle.md)).

### 3. Gate and bookkeeping (`runtime.ts` -> `onDecision`, `policy.ts` -> `gate`)

1. Read `answers.action` / `answers.diagnosis` (`ChoiceAnswer`). Missing action answer -> `{ [passive]: 1 }`; a
   `choice` not among the offered actions -> top = passive; missing diagnosis -> `expected` with `{ expected: 1 }`.
2. `gate(policy, rate, { actions: offered, probabilities, top, diagnosis, mode, paused, now })`, in this order:
   1. `paused` -> `"GenClass is paused"`.
   2. A empty -> `restriction(top)` or `"no action is permitted"`.
   3. `mass < threshold(candidate tier)` -> `restriction(top)` when the top is non-passive and restricted, else
      `"probability <mass> for the permitted actions (<A>) is below the <tier> threshold <th>"`.
   4. `requireDiagnosis && diagnosis === "expected"` -> `"the model's diagnosis is expected"`.
   5. `rate.full(now)` -> `"rate limit: <N> actions in the last minute"`.
   6. Else `run = candidate`.
   Reasons 1–3 are reported only when the model's own top choice was non-passive; 4–5 are always set.
3. `proceeded = ctl.proceeded ? ctl.proceeded() : hold && (expired || passiveRan())`. For a `delivery` that has not
   proceeded, set `op.delivery.decided = true` (this is what makes its chain's writes `covered`).
4. If `run` is a built-in and `proceeded`: `discard` with `ctl.revert`/`ctl.revertable` -> late-revert path (flow 5);
   otherwise `run = null` with reason `"the decision arrived after the hold budget expired"` when the subject had
   waited, else `"the subject was not held (decided in the background)"`. Custom actions are exempt (they run even
   after the subject proceeded). These overrides never call `rate.take`.
5. A `rate limit` reason emits a status report at most once per 60,000 ms:
   `[GenClass] Rate limit reached (<N> actions/minute): running passive actions until it clears.`
6. Build `Decision` (`action = run ?? top`), push to `decisionsBuf` (keeps 200) and `explainMap` (if the map holds
   more than 400 ids after adding a decision id, the single oldest entry is evicted; action ids are added in
   `finish` without a size check), push an event-log entry `kind "decision"`, name = trigger, `data { id,
   diagnosis, action, executed }`.
7. Fire `decide`; if detected (`diagnosis !== "expected" && diagnosisConfidence >= thresholds.report`) fire `detect`.
8. Call each applicable standing question's `onAnswer(answers[q.id], { decision, situation: draft, runtime })`
   (errors logged, never thrown); skipped when the provider returned no answer for `q.id`. Runs before any action.
9. No `run`: passive; if detected, emit a `detect` report (`detectionLine`). Done.
10. `run`: `rate.take(now)`, then flow 4.

### 4. Executing an action (`runtime.ts` -> `onDecision` -> `finish`)

1. Choose the effect: late -> `ctl.revert()`; custom (`ActionOption.custom`) -> `runCustom`; else `ctl.run(action)`.
2. Resolve -> `finish(effect)`. Throw/reject -> run passive, then `finish(null, err)`.
3. `finish` builds the `ActionRecord`: `ok = !err`; `changed = effect.changed` or, on error,
   `"Tried to <action> <subject> but it failed; the passive action ran instead."` (or `"Ran <action>."`);
   `error` = message; `late: true` for late reverts; then calls `effect.onRecord(record)`; `undo` wrapper when the
   effect had one.
4. Push to `actionsBuf` (keeps 200), set `rec.action` and `explainMap[record.id]`, push event `kind "action"`,
   name = action, `data { text: changed, id, decision, ok }`, fire `act`, emit an `intervene` report.

`finish` runs when the effect settles, so `act` / the report arrive after the action's wait: `delay` ≤ 8 s,
`coalesce` ≤ 8 s, `retry` ≤ 5 s of backoff, delivery `defer` ≤ 10 s (`waitOps`); `hedge`, `resync` and custom
actions have no GenClass cap.

Errors a controller throws (they become `ActionRecord.error`, `ok: false`, and `(failed: <error>)` in the line):

| Thrown by | Message |
|---|---|
| any controller | `unsupported action <name>` |
| `mutationController` -> `run` | `the write was not held` (default mode; normally unreachable because `proceeded` is checked first) |
| `mutationController` -> `revert` | `the write could not be reverted` (`hub.revert` returned null) |
| delivery (`runDelivery`) | `already delivered` |
| fetch request gate | `the request was already sent`, `no Response constructor`, `no cached response`, `no identical request to share`, `the response of #<id> could not be shared; sent the request instead` |
| fetch failure gate | `the failure was already delivered`, `the request body cannot be replayed`, `no cached response`, `aborted` |
| fetch stall | `already answered`, `no cached response`, `not hedgeable` |
| XHR request gate | `already decided`, `no cached response` |
| XHR failure/stall (`passiveOnly`) | `<action> is not available for XMLHttpRequest` (never reached) |
| `rollback` | `no consistent snapshot`, `nothing to restore: the affected stores already match the snapshot` |
| `revertChain` | `the chain wrote nothing that can be restored`, `nothing to restore: the fields already hold their earlier values` |
| `resync` | `no resync handler` (or the handler's own rejection) |
| custom action | whatever `def.run` throws or rejects with |

### 5. Late revert (mutations)

Two ways a write reaches this path: (a) **default** (`holdWrites` off): every `mutation` decision arrives after the
write applied; (b) `holdWrites` on: the hold budget expired (or the write was not held because the model was not
expected in time) and the passive `apply` ran.

1. The write applies (`MutationRec.appliedAt` set, `m.state === "done"`).
2. The queue keeps the item until its deadline: `t0 + budget + 2000` for a held write, `t0 + 5000` otherwise.
3. A decision with gate result `run === "discard"` -> `ctl.revertable()` in `mutationController`:
   `"the write has not applied yet"`; `"too late to revert: decided <secs> after the write applied"` (age > 2,000 ms;
   reachable and recorded as `Decision.reason` for background decisions, asserted in `test/atoms.test.ts`); then
   `StoreHub.revertable(m)`: `"the store is gone"`, `"the write was not applied"`, `"<store> cannot be written by
   GenClass"`, `"the write changed nothing"`, `"superseded: <path> changed again after the write applied"`,
   `"the same operation chain wrote <paths> after this write applied; reverting only this write would leave them
   inconsistent"`. Any string becomes `Decision.reason` and nothing runs.
4. `null` -> `late = true`; `ctl.revert()` runs `hub.revert(m)` inside `runAsGenClass("revert")`:
   `changed` = `Reverted the write to <≤3 paths>[ and N more][ from <cause>] (decided <secs> after it applied)[; <path> is back to <value>…≤2].`;
   undo = `hub.reapply(m)`. Report lead is `Reverted`.

Any other late built-in action (`defer`, a late request/failure/delivery decision) is recorded with a reason and does
nothing. A superseded write's queued decision is usually never computed (`stale`), so no `Decision` is recorded.

### 6. Delivery gate (`runtime.ts` -> `runDelivery`)

Entry points: fetch -> `NetHost.deliver` for a non-failure response (any status except 5xx/429/408, so 4xx included)
of the primary request while `gated` and not yet answered (body = parsed JSON of the buffered clone, when the request
has an identity and a `Response` constructor exists); XHR ->
`arrive()` on the first completion event of a successful async response (`readyState 4`, status not 0/5xx/429/408;
body = `xhrJson`); WebSocket/EventSource -> `MessageGate.decide` for each incoming message (body =
`parseJsonBody(data)`). `release()` delivers: fetch resolves the app's promise, XHR runs the queued app completion
listeners in order with the op ambient, `MessageGate` re-dispatches a cloned event (later messages and close/error
events wait behind a held one).

1. Not consultable, paused, destroyed or a GenClass op -> release at once.
2. `predictedWrites` -> `matchFields` -> `conflictsOn` (`situation/conflicts.ts`) give the predicted paths, matched
   live fields and conflicts (`kind: "newer" | "pending"`). `op.delivery = { patterns, known, salient: newer.length >
   0, decided: false }`.
3. No conflicts, no typed-into text field and not forced (`triage: "always"` or an `always` standing question on
   `delivery`) -> release synchronously (no model call, no record).
4. With a body: wait at most `BODY_WAIT_MS` (100) for it, then `analyzeBody` decides salience: newer-data conflicts
   whose incoming value differs, pending changes the body would put back (`vhash` of the value the user replaced),
   typed text the body would replace. If every conflicting field is unchanged, an event `delivery.unchanged` is
   pushed. No body / timeout / analysis error -> salient iff newer-data conflicts exist. (Salience details:
   [learn-situation-triage.md](learn-situation-triage.md).)
5. Not salient and not forced -> release. Else `trigger(spec, ctl, { hold: true, priority: 2 })`.

Delivery controller: `passive()` releases and, when the delivery was salient over conflicts, sets
`op.delivery.overNewer` (later writes of that chain get a field mark "delivered over newer data", `markWrites`);
`discard` and `defer` are below. In observe mode nothing is permitted, so a salient delivery is released at once and
decided in the background; its writes are then not `covered` (not decided in time), so they raise background
`mutation` decisions too.

### 7. Custom actions and standing questions (`runtime.ts` -> `action`, `question`, `use`, `runCustom`)

Registration: `rt.action(def)` / `rt.question(def)` append to `customActions` / `standing` and return an
unregister function. `rt.use(plugin)` appends `plugin.actions` and `plugin.questions`, runs `plugin.setup(pluginApi)`
(a throw is logged; a returned function is the cleanup) and returns an unregister function; calling `use` again
with the same plugin object registers nothing. `plugin.diagnoses` labels are appended after the base vocabulary and
`plugin.facts` add neutral facts ([learn-situation-triage.md](learn-situation-triage.md)). Standing questions with
`always: true` bypass the salient-triage early exit (flow 1 step 2/4 and delivery step 3).

1. Offered (`build.ts`) when `def.on` includes the trigger, no earlier option has the same name, and
   `def.applicable(draft)` is true (a throw = false). Tier `def.tier ?? "heal"`; description
   `vocabulary.actions[name] ?? def.description`.
2. Gated like any action (its own tier's threshold), **not** blocked by `proceeded`; then `def.run(ctx)` runs inside
   `runAsGenClass(def.name)` on a microtask.
3. `ctx.builtin(name)`: false unless `name` is a built-in **offered for this trigger**. The passive name calls
   `ctl.passive()` and returns true. Otherwise false when paused, `restriction(...)` blocks it, `ctl.proceeded()` is
   true, or the rate limiter is full; else `rate.take` (a second slot), `await ctl.run(name)`, adopt its `changed`
   (if `describe` was not called yet) and `undo` (if `onUndo` was not called yet), return true. Thresholds and the
   diagnosis rule are **not** re-applied.
4. After `run` resolves: if no builtin took over, `ctl.passive()` runs. `changed = describe text || "Ran the custom
   action <name>."`.

### 8. Reporting (`decide/report.ts`)

Lines (exact templates):

```text
interventionLine: [GenClass] <lead> <noun>: <topFact> <changed>[ (failed: <error>)] (<diagnosis>, <pDiag>; <action> <confidence>)
detectionLine:    [GenClass] Flagged <noun>: <topFact>[ Not acted on (would have done <x>): <reason>.] (<diagnosis>, <pDiag>)
decisionLine:     [GenClass] Checked <subject>: <diagnosis> (<pDiag>); ran <ran>[ (the model chose <action>[; <reason>])].
```

- `lead`: `LEAD[action]` (`discard`/`coalesce` "Prevented", `defer` "Held back", `delay` "Slowed down", `block`
  "Stopped", `serve_cached`/`retry` "Recovered from", `hedge` "Worked around", `rollback`/`resync` "Repaired"),
  `"Reverted"` when `late`, `"Handled"` for custom actions.
- `noun`: `NOUN[trigger]` — write, request, **response** (delivery), request failure, slow request, state, state
  change, error, question; a delivery whose `Decision.subject` does not start with `response` (a push message) uses
  **message**. `an(noun)` for `expected`; `"inconsistent state"` for inconsistency+inconsistent; else
  `an("<diagnosis> <noun>")`.
- `Decision.subject` for delivery (`build.ts` -> `subjectOf`): `response to <opLabel>` or `WebSocket message <path>
  (#<id>) <summary>` / `server-sent message <path> (#<id>) <summary>`.
- `topFact`: first fact not matching `/^This (write|request) (comes from|has no known cause)/`, with a trailing period.
- Probabilities are `toFixed(2)`, `?` when undefined or not finite. The `Not acted on (…)` clause is added only when
  `Decision.reason` is set and `executed` is false.

`Reporter.emit(r)`:

1. Always call the listener -> runtime `report` event (also with `report: "silent"`).
2. `"silent"` -> stop. A function sink -> call it (errors swallowed), no dedupe, no grouping.
3. `"console"`: `status` -> `console.info(line)`. Others are deduped by key
   `kind|action|diagnosis|trigger|subject` (subject with `#\d+` -> `#`, numbers -> `n`): the first in a 60,000 ms
   window prints; repeats are counted; when the window ends `"<first line> (×N more in the last minute)"` prints via
   `warn` (intervene) or `info` (detect).
4. A printed line with an `explain()` record becomes `console.groupCollapsed(line)` with: `Facts:`, `Timeline:` (if
   any), `Situation sent to the model:` + exact text, `Answers:`, and for actions `Changed:`, an undo hint
   (`GenClass.runtime.interventions().find(a => a.id === "<id>").undo()` or `Undo: not reversible`), a deny hint
   (`GenClass.init({ policy: { deny: ["<action>"] } })`), then `explain: GenClass.runtime.explain("<id>")`.

Status lines emitted by `runtime.ts`: `[GenClass] Model ready (<model, device, variant>[, <secs>]). Mode: <mode>.`,
`[GenClass] Model unavailable (<error>); observing only.`, `[GenClass] Mode set to <mode>.`, and the rate-limit line.

### 9. explain and undo

- `explain(id)` (`runtime.ts` -> `RuntimeImpl.explain`): looks up `explainMap`; `message` = `interventionLine` if an
  action is attached, else `detectionLine` if detected, else `decisionLine`. Returns `null` for unknown/evicted ids.
- `ActionRecord.undo()` wrapper: no-op after the first call; runs the effect's undo inside
  `runAsGenClass("undo")`; pushes event `kind "action"`, name `"undo"`, `data { text: "undid <action> (<id>)", id }`.
  It fires no `act` event, no report, and does not mark the record. An exception from the effect's undo propagates.
- `decisions(n = 200)` / `interventions(n = 200)` return the last `n` entries of the rings, oldest first; records are
  the live objects (an `ActionRecord.dropped` array keeps growing while its discard mark lasts).
- `holdBudgetMs()` (public on `Runtime`) returns the budget the next held trigger would use.

### 10. Mode, pause, resume, destroy (decision-side effects)

| Call | Effect in this scope |
|---|---|
| constructor | `mode = o.mode ?? "observe"`; `hub.holdWrites = policy.holdWrites`; `GenClass.init` also honours `?genclass=` / `localStorage.genclass` ([public-api-and-lifecycle.md](public-api-and-lifecycle.md)) |
| `setMode(mode)` | ignored unless `"observe" \| "guard" \| "heal"`; sets the mode used by the next `trigger` / `gate` / `ctx.builtin`; emits status `[GenClass] Mode set to <mode>.` and fires `status` with the model status |
| `pause()` | `paused = true`, `hub.gating = false`, `NetHost.gated` false (no request/failure/stall/delivery triggers); `consultable()` false; decisions already queued still produce a `Decision` but never run (`"GenClass is paused"`) |
| `resume()` | undoes `pause()` (no-op after `destroy`) |
| `isPaused` | getter on `RuntimeImpl` only (not on `Runtime`) |
| `destroy()` | `destroyed = true`, `hub.gating = false`, `queue.dispose()` (pending decisions resolve `null` -> passive, which releases held deliveries), `reporter.dispose()`, observers uninstalled, plugins unregistered, an owned provider disposed |
| `setReport(sink)` | `RuntimeImpl` only: swaps the report sink live (`Reporter.setSink`) |

### Events

| Event (`rt.on`) | Payload | When |
|---|---|---|
| `decide` | `Decision` | every model answer that reached `onDecision` |
| `detect` | `Decision` | diagnosis ≠ `expected` and p(diagnosis) ≥ `thresholds.report` (also when an action ran) |
| `act` | `ActionRecord` | every non-passive action attempt, `ok` true or false, after its effect settled |
| `report` | `Report` | every report (detect/intervene/status), before the sink, even when silent |
| `status` | `ModelStatus` | provider `onStatus`; also on `setMode` |
| `event` | `RtEvent` | every event-log entry, including `decision`, `action`, `undo`, `dropped` and `delivery.unchanged` |

`action` event-log entries (including `undo` and `dropped`) appear in later situations' timelines as `<rel> GenClass
<text>` (`situation/describe.ts` -> `eventLine`, text truncated to 100 chars); `decision` entries are not rendered.
Listener exceptions are caught and logged (`fire`), never thrown into the decision flow.

### 11. Built-in action reference

Tiers and descriptions come from `BUILTIN_ACTIONS` (delivery: `TRIGGER_DESCRIPTIONS`); applicability from
`situation/build.ts` -> `builtinApplicable`. `opLabel(op)` renders like `GET /api/x (#12)`; `secs(ms)` gives 2
decimals below 10 s (`0.30s`).

| action | tier | trigger(s) | offered when | mechanics (where) | `changed` (abridged) | undo |
|---|---|---|---|---|---|---|
| `apply` | passive | mutation | always | default: no-op (already applying); `holdWrites`: verdict `apply` | — | — |
| `discard` | guard | mutation | always | default: late revert only (flow 5); `holdWrites`: verdict `discard`, hub drops the held write | held: `Dropped the write to <paths>[ from <cause>]; <store> stays at version <v>.`; late: `Reverted the write to …` | held: apply the write now (`hub.commit(st, { ...m, userSync: false, genclass: true, state: "resolved" }, false)`); late: `hub.reapply(m)` |
| `defer` | guard | mutation | `m.defers < 2` | `holdWrites` only: verdict `defer`, hub waits for related in-flight ops (`waitRelated`, cap 10 s) and re-proposes (new trigger); default: always late -> recorded with a reason only | `Held the write to <paths> until the related in-flight operations finish, to decide again.` | — |
| `deliver` | passive | delivery | always | `release()` (marks `overNewer` when it was salient over conflicts) | — | — |
| `discard` | guard | delivery | always | release now and set `op.discardMark` (protect = conflicting paths, 10 s): each later write of the op's chain drops its changes to protected paths or to paths a user action or newer op wrote since the op started (`dropFilter`, `writtenOver`); its other changes apply; a library-commit write (redux) cannot be applied in part and applies whole unless everything is dropped | `Delivered <the response to <op> \| message <op>> and dropped the state changes it makes over newer data[ (<≤3 protected paths>)].`; `ActionRecord.dropped` lists the dropped paths (filled via `onRecord`/`onDrop`) | end the mark and write the dropped values now (`hub.restoreFields`) |
| `defer` | guard | delivery | `defers < 2` and `relatedInFlight(env, op, matched)` is non-empty | wait for those ops (`waitOps`, cap `LONG_RUNNING_MS` 10 s), then `runDelivery(o, release, defers + 1)` decides again | `Held <what> for <secs> until <n> related operation(s) finished, then decided again.` | — |
| `send` | passive | request | always | send now (`sendNow` / XHR `doSend`) | — | — |
| `coalesce` | guard | request | fetch only, and `cache.shareable(identity, op.id)` | wait ≤ 8 s for the identical request's buffered response, answer a copy marked `x-genclass: coalesced` | `Did not send <op>; reused the <status> response of the identical request #<id>[ (x-genclass: coalesced)].` | — |
| `delay` | guard | request | always | wait `min(250 × 2^failStreak(signature), 8000)` ms, then send (fetch and XHR) | `Delayed <op> by <secs> before sending it.` | — |
| `block` | heal | request | always | do not send; 503 `Response`, statusText `Blocked by GenClass`, header `x-genclass: blocked` (XHR: faked 503) | `Did not send <op>; answered 503 (x-genclass: blocked).` | — |
| `serve_cached` | heal | request | GET and a cached good response exists | answer the last good GET body (≤ 256 KB), `x-genclass: cached` | `Did not send <op>; answered with the cached <status> response from <age> ago (x-genclass: cached).` | — |
| `deliver` | passive | failure | always | hand the original `Response` / rejection to the app | — | — |
| `retry` | heal | failure | fetch, replayable body, `op.attempt < 4` | after `min(200 × 2^(attempt-1), 5000)` ms start a new fetch op (`attempt + 1`) | `Retried <op> after <secs> as attempt <n> (#<id>); the app will receive that attempt's result.` | — |
| `serve_cached` | heal | failure | fetch, GET, cached | answer the cached response instead of the failure | `Replaced the failed response of <op> with the cached <status> response from <age> ago (x-genclass: cached).` | — |
| `wait` | passive | stall | always | nothing | — | — |
| `hedge` | heal | stall | fetch, GET, idempotent, replayable | send a second identical request; first good answer wins | `Sent a second identical request #<id> for <op>; …` | — |
| `serve_cached` | heal | stall | fetch, GET, cached | answer the cached response now; the original continues | `Answered <op> with the cached <status> response from <age> ago instead of waiting (x-genclass: cached); …` | — |
| `ignore` | passive | inconsistency, transition, error | always | nothing | — | — |
| `rollback` | heal | inconsistency | a consistent snapshot exists and an involved store is writable | `RuntimeImpl.rollback(stores, violationIds)` | `Restored <store (paths)>; … to the consistent state from <secs> ago.` | write back the pre-rollback values and mute those violation ids |
| `rollback` | heal | transition, error | the op's chain wrote fields nobody overwrote since (error: an ambient op existed) | `RuntimeImpl.revertChain(op, why)` | `Restored <≤4 paths>[ and N more] to their values before <root op> (the <why>'s chain wrote them).` | restore the replaced values |
| `resync` | heal | inconsistency, transition | an involved store has `StoreOptions.resync` | call each such store's `resync()` inside `runAsGenClass("resync")` | `Reloaded <stores> from its/their source (resync handler).` | — |

Notes:

- Each dropped write (delivery `discard`) pushes an event `kind "action"`, name `dropped`, `data { text: "dropped the
  write of <paths>[ by <cause op>] over newer data[ (its other changes applied)]", paths, op /* the marked op id or
  null */, mutation }` (`onDropped`).
  The drop filter skips GenClass and user-sync writes and searches ≤ 16 ancestors for an unexpired mark.
- Other `changed` variants: coalesce when the app was answered meanwhile -> `Coalesced <op> with #<id>, but the app
  was already answered.`; retry when the app was answered during the backoff -> `Did not retry <op>: the request was
  already answered.` (both `ok: true`).
- XHR: `coalesce`, `retry`, `hedge` and failure/stall `serve_cached` are never offered; XHR failures and stalls are
  detection only; synchronous XHRs are never held. An `abort()` while a delivery is held drops the response and fires
  `abort` + `loadend` (event `xhr.aborted-while-held`).
- `rollback`'s model-facing description says "last consistent snapshot" for every trigger, but transition/error
  rollback is a chain revert (see Drift).

## Configuration and constants

| Name | Type | Default / value | Defined in | Effect |
|---|---|---|---|---|
| `mode` | `"observe" \| "guard" \| "heal"` | `"observe"` (was `"guard"` before f3636b2) | `runtime.ts` constructor | which tiers are permitted (`policy.ts` -> `modeAllows`); `setMode` changes it live |
| `policy.thresholds.report` | number | 0.6 | `policy.ts` -> `policyConfig` | min diagnosis probability for a detection |
| `policy.thresholds.guard` | number | 0.9 | `policyConfig` | min Σ p(A) when the candidate is guard tier |
| `policy.thresholds.heal` | number | 0.8 | `policyConfig` | min Σ p(A) when the candidate is heal tier |
| `policy.allow` | `string[]` | unset | `policyConfig` | only these non-passive actions may run |
| `policy.deny` | `string[]` | `[]` | `policyConfig` | these never run |
| `policy.holdBudgetMs` | `number \| "auto"` | `"auto"` | `policyConfig`, `holdBudget` | max hold; a number is used as `max(0, n)` |
| `HOLD_MIN_MS` / `HOLD_MAX_MS` / `HOLD_FALLBACK_MS` | ms | 150 / 800 / 300 | `policy.ts` | auto budget clamp and no-data fallback |
| `policy.holdWrites` | boolean | false | `policyConfig` -> `StoreHub.holdWrites` | true: salient store writes wait for the model (`gateMutation`); false: decided in the background (`observeWrite`) |
| `policy.holdUserWrites` | boolean | false | `policyConfig` -> `StoreHub.holdUserWrites` | gate writes made synchronously in a user handler |
| `policy.maxActionsPerMinute` | number | 60 | `policyConfig`, `RateLimiter` | sliding 60,000 ms window of non-passive actions |
| `policy.requireDiagnosis` | boolean | true | `policyConfig` | require top diagnosis ≠ `expected` |
| `report` | `"console" \| "silent" \| fn` | `"console"` | `runtime.ts` constructor; `setReport()` | report sink |
| `MAX_QUEUE` | number | 32 | `decider.ts` | queue overflow drops lowest-priority, oldest |
| `CACHE_MAX` / `CACHE_TTL` | number / ms | 64 / 30,000 | `decider.ts` | identical-situation answer cache |
| `LATENCY_SAMPLES` | number | 20 | `decider.ts` | provider latencies kept for the hold budget and expected latency |
| `PROVIDER_TIMEOUT_MS` | ms | 10,000 | `decider.ts` (exported) | runtime-side timeout when a request has no deadline |
| `LATE_REVERT_MS` | ms | 2,000 | `runtime.ts` | late-revert window; also extends held-mutation deadlines |
| `BACKGROUND_DEADLINE_MS` | ms | 5,000 | `runtime.ts` | deadline of non-held decisions (incl. default-mode mutations) |
| `DISCARD_MARK_MS` | ms | 10,000 | `runtime.ts` | how long a delivery `discard` keeps dropping its chain's writes |
| `BODY_WAIT_MS` | ms | 100 | `runtime.ts` | max wait for a delivery's body before deciding salience without it |
| `DECISIONS_KEPT` | number | 200 (explainMap 400) | `runtime.ts` | `decisions()`, `interventions()`, explain retention |
| `LONG_RUNNING_MS` | ms | 10,000 | `runtime.ts` | cap on mutation `defer` (`waitRelated`) and delivery `defer` (`waitOps`) waits |
| ancestor search depth | number | 16 | `runtime.ts` -> `covered`, `dropFilter`, `onDropped` (literals) | how far up a write's chain a delivery / discard mark is looked for |
| `WINDOW_MS` | ms | 60,000 | `report.ts` | console dedupe window |
| rate-limit warning interval | ms | 60,000 | `runtime.ts` -> `onDecision` (literal) | at most one rate-limit status line per minute |
| `COALESCE_MAX_WAIT_MS` | ms | 8,000 | `observe/fetch.ts` | coalesce wait for the shared response |
| delay backoff | ms | `min(250 × 2^streak, 8000)` | `fetch.ts` / `xhr.ts` (literal) | `delay` |
| retry backoff | ms | `min(200 × 2^(attempt-1), 5000)` | `fetch.ts` (literal) | `retry` |
| max retry attempt | number | offered while `attempt < 4` | `build.ts` -> `builtinApplicable` | at most 3 retries |
| max defers | number | 2 | `build.ts` (mutation and delivery), `hub.ts` -> `drain` | then the write applies / the delivery is decided without `defer` |
| `COMPACT_QUESTIONS_BUDGET` / `COMPACT_DESC_MAX` | chars | 1,400 / 24 | `questions.ts` | compact questions drop descriptions |
| `STALL_MIN_MS` | ms | 500 | `runtime.ts` | floor of the stall delay |
| `budgetScale` step / floor | factor | × 0.8 per `max_tokens_exceeded`, floor 0.5 | `runtime.ts` constructor (`onError`) | shrinks `"auto"` situation budgets |
| `MAX_FACTS` | number | 12 | `situation/facts.ts` | `Decision.facts` / `explain().facts` length cap |
| `debug` | boolean | false | `runtime.ts` constructor | `console.debug` of model errors, decisions, failed listeners/standing questions/passive actions |

## Invariants and gotchas

- **No rules.** Nothing in this scope may map a fact pattern to a diagnosis or action (CONTRACT §0 rule 1). The gate
  only filters what the model chose; triage and delivery salience only decide whether to ask.
- **Holding is only latency.** A held delivery changes nothing about the response/event; a held request is only
  sent later; `holdWrites` never reorders a store's writes (`test/no-reorder.test.ts`). The "never worse" sweep
  (`docs/runtime/RESULTS.md`: 0/396 changed clean runs with an always-passive model) depends on this.
- **Fail-open is total.** `submit()` never rejects; every failure is `null` -> passive. New code paths must keep
  calling the controller's `passive()` on every exit. Controllers must tolerate a second `passive()` call
  (`runCustom` calls `ctl.passive()` outside the `passiveRan` guard). Existing ones do (`settle?.()`, `released`,
  `sent`/`answered`/`handled`, `decided`).
- **Model wording is frozen** at tag `situation-v2` (6e5e86e): `BUILTIN_ACTIONS` descriptions, `TRIGGER_ACTIONS`
  order, `ACTION_INSTRUCTIONS`, `TRIGGER_DESCRIPTIONS`, `DIAGNOSIS_INSTRUCTIONS`, `DEFAULT_DIAGNOSES`, `PASSIVE` are
  model input and are mirrored in `training/curriculum/rt.py` (header "FROZEN at git tag `situation-v2`") and the
  sim. `ActionRecord.changed` and the `dropped` event text are also model input (timelines). No file under
  `situation/` or `decide/` changed between `situation-v2` and b435acb.
- **Default mode cannot act.** In observe mode `permittedActions` is empty, so `waits` is always false and no gate
  `run` exists; only detections are reported. Tests that exercise actions get guard from `test/helpers.ts` ->
  `setup()`; `test/default-mode.test.ts` asserts the product default.
- **No hold when the model is late.** `expectedLatency()` > budget (e.g. `warmupMs` 2,000 with an 800 ms max
  budget, or a stuck provider) means nothing waits, even in guard mode (`test/delivery.test.ts` "does not hold when
  the model is not expected to answer within the hold budget").
- **Threshold semantics:** the threshold is the candidate's tier's, applied to the mass of all permitted actions.
  With `thresholds` of 0 the gate runs the first permitted action even at probability 0; the sim uses 0.5
  (`sim/src/run/rt.ts`).
- **`Decision.action` may differ from the model's argmax** when a permitted candidate runs while a non-permitted
  action was top. `executed` is true when an action ran, even if it then failed.
- **Failed actions count:** `rate.take` happens before the effect; a custom action that calls `ctx.builtin`
  consumes two slots.
- **Holds can outlast the budget after a decision:** `coalesce`, `delay` (≤ 8 s), `retry` (≤ 5 s), delivery `defer`
  (≤ 10 s, then a second decision) and custom actions (unbounded) keep the subject waiting.
- **Custom actions run late.** Unlike built-ins they are not nulled when the subject already proceeded (a custom
  action may act after a write applied); only `ctx.builtin` refuses then.
- **Covered writes skip the mutation trigger** only when the delivery was decided before release; a delivery
  released by budget expiry or in observe mode leaves its writes to background `mutation` decisions.
- **Runtime timeout does not cancel the provider.** A late answer from an abandoned call is still cached and its
  latency still sampled; it also clears `stuck`.
- **Determinism:** only the injected `Clock` is used (timers, `now`, body wait, discard mark); ids are counters. Do
  not add `Date.now`/`setTimeout` here (CONTRACT §0 rule 3).
- **Console hints** reference `GenClass.runtime`, which is `null` for runtimes made with `createRuntime`.
- **Devtools mirrors report wording** (`src/devtools/ui.ts` -> `LEAD`, `NOUN`, `actTitle`, `splitReport`). Changing
  a line format can break the overlay.
- **Answer cache in tests:** identical `(trigger, state, questions)` within 30 s are answered from the cache, so
  `ScriptedDecider.calls` does not grow. Advance the fake clock past 30 s or vary the situation.
- **Undo is unguarded:** `ActionRecord.undo()` ignores mode, pause, policy and the rate limit, and never checks
  whether the state moved since (a delivery discard's undo writes the dropped values over whatever is there now).
- **Dead surface:** `RuntimeImpl.rollback`'s `beforeSeq` is never passed; `RuntimeImpl.setReport` has no caller.

## How to change it safely

Light local checks are allowed on this machine (see [build-test-release.md](build-test-release.md)):
`NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts` in
`packages/runtime` (lead's run at b435acb: 332 passed, 14 skipped), then `test/review-perf.test.ts` alone (flaky under
parallel load). CI (`.github/workflows/ci.yml`) runs the same split. Do not run Playwright, the sim, realapps or demos
eval without asking.

1. **Change a default threshold, budget or rate:** edit `policy.ts` -> `policyConfig` / `HOLD_*`; update the JSDoc
   in `types.ts` -> `PolicyOptions`, `docs/runtime/API.md`, and `test/policy.test.ts`, `test/budget.test.ts`,
   `test/fetch.test.ts` (fail-open tests expect the 300 ms fallback).
2. **Change gate logic:** edit `policy.ts` -> `gate` only; keep reason strings stable (asserted in
   `test/policy.test.ts`, `test/report.test.ts`, parsed by devtools). Check the sim's forcing contract (thresholds
   0.5, `requireDiagnosis: false`; `test/delivery.test.ts` "forced actions").
3. **Change the hold decision** (`waits`, `expectedLatency`, `proceeded`/`stale`): `runtime.ts` -> `trigger`,
   `onDecision`, `decider.ts`; tests `test/delivery.test.ts`, `test/atoms.test.ts`, `test/budget.test.ts`,
   `test/default-mode.test.ts`.
4. **Change the delivery gate:** `runtime.ts` -> `runDelivery`, `dropFilter`, `writtenOver`, `onDropped`; channel
   plumbing in `observe/fetch.ts`, `observe/xhr.ts`, `observe/messages.ts`; salience in `situation/conflicts.ts` /
   `content.ts`. Salience changes alter which situations exist (sim/training data): coordinate with SIM/TRAIN.
   Tests `test/delivery.test.ts`, `test/content.test.ts`, `test/no-reorder.test.ts`, `test/smoke.test.ts`.
5. **Change an action's mechanics:** edit its controller. Keep: throw when it cannot run; return an exact `changed`
   sentence; provide `undo` only if truly reversible; end synthetic ops with `synthetic: true`. Coordinate `changed`
   wording with SIM (timeline input). Tests: `test/fetch.test.ts`, `test/xhr.test.ts`, `test/atoms.test.ts`,
   `test/delivery.test.ts`, `test/review-fetch.test.ts`, `test/review-xhr.test.ts`.
6. **Add a built-in action or trigger kind:** `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS` (passive first), `PASSIVE`,
   `ACTION_INSTRUCTIONS`, maybe `TRIGGER_DESCRIPTIONS`, `build.ts` -> `builtinApplicable`, the controller, `LEAD` /
   `NOUN` in `report.ts` and `devtools/ui.ts`. This changes model input: new freeze tag, sim + training mirrors, new
   data and a retrained model (the `delivery` addition is the worked example: commit fcd1e68 + tag `situation-v2`).
7. **Change report wording:** `report.ts`; update `test/report.test.ts`, `test/atoms.test.ts`,
   `test/review-misc.test.ts`, `src/devtools/ui.ts` + `test/devtools*.test.ts`.
8. **Change queue behaviour:** `decider.ts`; tests `test/budget.test.ts`, `test/batch3.test.ts`,
   `test/review-misc.test.ts`, `test/atoms.test.ts`, `test/delivery.test.ts` (superseded item dropped).
9. **Custom action / standing question API:** `runtime.ts` -> `runCustom`, `action`, `question`, `use`; tests
   `test/plugins.test.ts`, `test/batch3.test.ts`, `test/review-misc.test.ts`.
10. **Write a test for this scope:** `test/helpers.ts` -> `setup({ mode, policy, script })` gives a headless
    `RuntimeImpl` on a `FakeClock` with a `FakeServer` fetch, `mode: "guard"` unless overridden, `report: "silent"`
    and only the fetch observer. A passed `observe` object replaces the harness default wholesale (unlisted observers
    fall back to the runtime defaults), so list what you need, as `test/delivery.test.ts` does:
    `observe: { fetch: true, websocket: true }, extraGlobal: { WebSocket: FakeWS }` (EventSource and XHR likewise). Add
    `policy: { holdWrites: true }` to test held writes (as `test/atoms.test.ts` does for every test).
    `defaultScript({ delivery: { diagnosis: "stale", action: "discard" } })` answers per trigger; `ManualDecider`
    (`answer()` releases the oldest pending request; `pending[i].req.trigger`) controls timing. Advance time with
    `clock.advance(ms)` / `clock.flush()`.

## Tests

| Test file | What it asserts (scope-relevant) |
|---|---|
| `packages/runtime/test/delivery.test.ts` | typeahead makes zero model calls; stale out-of-order response -> delivery `discard` drops only the stale field; hold is only latency; no hold when the model cannot answer in time; default: read-after-write, background late revert, slow model (released at budget, writes late-reverted), superseded queued decision dropped; WebSocket order + discard; EventSource custom types; XHR held before completion listeners, abort during hold; forced actions |
| `packages/runtime/test/default-mode.test.ts` | `createRuntime` / `GenClass.init` default to observe (`?genclass=guard` opts in); observe never holds or delays even with a sure model or a model that never answers; findings still reported |
| `packages/runtime/test/no-reorder.test.ts` | an always-passive model changes nothing in any mode/triage (same dispatches, order, state); `holdWrites` never reorders a store's dispatches |
| `packages/runtime/test/policy.test.ts` | gate: mass split, mode tiers, thresholds with exact reasons, `requireDiagnosis`, deny/allow, pause, rate limit, observe never holds, `setMode`, `pause/resume`, loading fails open |
| `packages/runtime/test/report.test.ts` | line formats (held discard with `holdWrites`; default -> `Reverted a stale write …` late revert), `explain()`, console groups, ×N summary, listeners |
| `packages/runtime/test/atoms.test.ts` | (all with `holdWrites: true`) holds, fail-open at budget, late revert text and undo, refusals incl. `too late to revert` recorded as a reason, user write never overtakes a held write, read-your-writes, provider error codes fail open, discard + undo, defer max 2 |
| `packages/runtime/test/budget.test.ts` | `holdBudget` values; adaptive budget; `timeoutMs` = budget + 2,000 for held writes and = budget for requests; expired items never computed; situation budget 2,400 (webgpu) |
| `packages/runtime/test/fetch.test.ts`, `xhr.test.ts`, `review-fetch.test.ts`, `review-xhr.test.ts` | request/failure/stall actions and fail-open; XHR block, sync XHR never held, abort while held |
| `packages/runtime/test/smoke.test.ts` | atoms apply synchronously; a stale response is held and its stale writes dropped in guard mode |
| `packages/runtime/test/review-hub.test.ts`, `review-actions.test.ts`, `invariants.test.ts`, `learn.test.ts` | late-revert undo; error/transition rollback; inconsistency rollback |
| `packages/runtime/test/plugins.test.ts`, `batch3.test.ts`, `review-misc.test.ts` | custom actions, `ctx.builtin` policy, standing questions, rate warning, never-answering provider |
| `packages/runtime/test/devtools-runtime.test.ts` | overlay undo; delivery intervention titles |
| `packages/runtime/test/adapters-{react,redux,zustand}.test.ts` | held writes through adapters (`holdWrites: true`); `discard` drops them |
| `packages/runtime/test/ask.test.ts` | `ask` / `decide` through the queue |

## Drift and open issues

Doc-vs-code mismatches (code is authoritative):

1. `docs/runtime/CONTRACT.md` has no `delivery` trigger, no `policy.holdWrites`, and §4 still describes salient
   writes as held until a decision; §8 still says `holdBudgetMs` default 300 (code `"auto"`). The v2 contract deltas
   exist only in `packages/runtime/STATUS.md` ("Contract deltas (batch 4)" and "Contract deltas (batch 5)": delivery
   salience by body comparison, `NetHost.noteResponse`, `MsgHost.channel`). `docs/runtime/API.md` describes `delivery`
   and `holdWrites`.
   `demos/README.md` and `demos/src/shared/settings.ts` repeat "300 ms".
2. CONTRACT §7 retry backoff `min(200 ms · 2^attempt, 5 s)`; code `min(200 × 2^(attempt-1), 5000)`.
3. CONTRACT §7 `rollback` = "last consistent snapshot"; transition/error restore only the op chain's fields.
4. CONTRACT §8/§9 field lists omit `tier`, `ran`, `answers`, `candidate`, `mass`, `ActionRecord.late`,
   `ActionRecord.dropped`, `Explanation.message`, `ActionDef.tier`, `StandingQuestion.always`; `ActionDef.risk` is
   unused.
5. `types.ts` JSDoc vs code: `Decision.action` ("the action the model chose") is `run ?? top`; `Decision.executed`
   ("true when `action` ran as chosen") is also true for a passive top and for failed actions;
   `EvaluateRequest.priority` ("held writes/requests use 2, background 0") omits deliveries (2) and the
   `min(priority, 1)` background rule (default-mode mutations 1).
6. CONTRACT §8 "summarised as ×N in the last minute"; code prints `(×N more in the last minute)` at window end and
   only for the `"console"` sink.
7. `sim/NEEDS.md` headless example still uses thresholds `guard: 0`; the sim and `packages/runtime/STATUS.md` use 0.5.
8. `src/devtools/ui.ts` templates differ from `report.ts`: `NOUN.failure` "failed request" vs "request failure",
   extra adjectives (`conflicting`, `excessive`), and delivery is always "response" (the runtime says "message" for
   push channels). The `Reverted` lead now exists in both.
9. CONTRACT §7 implies XHR parity; code never offers XHR `coalesce`/`retry`/`hedge`.
10. CONTRACT §7 calls guard-tier actions "minimal and reversible"; `defer`, `coalesce`, `delay` have no `undo`.
11. CONTRACT §8 says an `ActionRecord` is emitted "for every non-passive action that ran"; failed attempts are
    recorded too and consume a rate slot.
12. `discard`'s held-write undo builds a `MutationRec` with `genclass: true`, but `StoreHub.commit` records it under
    the original cause (code reading; no test asserts the writer).
13. `RuntimeImpl.setReport` JSDoc says "(devtools)", but nothing calls it; it and `isPaused` are not on `Runtime`.

Open items (from `HANDOFF.md`, `OPEN_TASKS.md`, `packages/runtime/STATUS.md`, `docs/runtime/RESULTS.md`):

- No situation-v2 model exists yet; until `@genclass/runtime-model@0.1.0` ships, the published alphas
  (`@genclass/runtime` 0.1.0-alpha.1 = `latest`, default observe; the older 0.1.0-alpha.0, default guard; neither has a model) take no actions, and R17-final1 (situation-v1) does
  not match this runtime. SIM is generating v2 data on Azure (`training/NEEDS.md`).
- Hold-induced harm ([RESULTS.md](../../runtime/RESULTS.md) §5; rerun is OPEN_TASKS item 10) was measured with v0.1 on held store writes; v2 holds only deliveries, and the
  never-worse sweep over 66 real apps changed 0/396 clean runs ([../realapps.md](../realapps.md),
  [RESULTS.md](../../runtime/RESULTS.md)). Precision with a trained v2 model is unmeasured.
- Delivery salience (STATUS "SIM's v2 driver run: 45 of 65 stale deliveries had discard ≈ deliver") motivated
  batch 5's body-comparison salience rules (already in the code: flow 6 step 4); SIM's further separability
  proposals are in `sim/NEEDS.md` ("Situation-v2 fact proposals from the separability analysis"). Whether a trained
  v2 model separates `discard` from `deliver` is unmeasured.
- Slow single-thread WASM: with `expectedLatency` over the budget nothing is held; writes rely on late revert
  (≤ 2 s) and deliveries are decided too late to act.
- Code-reading follow-ups (unverified at runtime): late answers after a runtime timeout still feed the cache and
  latency samples; custom actions can hold a subject indefinitely and can run after it proceeded.

## Related docs

- [public-api-and-lifecycle.md](public-api-and-lifecycle.md): `GenClass.init`, options, default mode, kill switch, `ask`/`decide`.
- [observe-and-trace.md](observe-and-trace.md): fetch/XHR/WebSocket/EventSource observers, request identity, ops and causality.
- [state-and-adapters.md](state-and-adapters.md): mutation pipeline, `holdWrites`, drop filter, invariants, snapshots.
- [learn-situation-triage.md](learn-situation-triage.md): facts, triage, delivery salience, situation building, questions, budgets.
- [model-host.md](model-host.md): the default `DecisionProvider`, its queue, timeouts and error codes.
- [devtools.md](devtools.md): overlay views, report parsing, undo button.
- [build-test-release.md](build-test-release.md): running tests and CI.
- [../realapps.md](../realapps.md): the real-app corpus and the never-worse sweep.
- [HANDOFF.md](../../../HANDOFF.md), [RESULTS.md](../../runtime/RESULTS.md), [RELEASE.md](../../../RELEASE.md): live handoff, results log, release steps.
- [../overview.md](../overview.md), [../model-io-contract.md](../model-io-contract.md), [../sim.md](../sim.md), [../training.md](../training.md).
- [../status-and-known-issues.md](../status-and-known-issues.md), [../glossary.md](../glossary.md).
- Binding spec: [../../runtime/CONTRACT.md](../../runtime/CONTRACT.md) §6–§9 (stale on delivery, see Drift 1); human API: [../../runtime/API.md](../../runtime/API.md).
