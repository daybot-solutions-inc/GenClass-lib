# @genclass/runtime: decision queue, policy gate, actions, reports, explain and undo

> **Scope:** `packages/runtime/src/decide/decider.ts`, `packages/runtime/src/decide/exec.ts`,
> `packages/runtime/src/decide/policy.ts`, `packages/runtime/src/decide/report.ts`; the decision flow, action
> implementations, late revert, `explain`, undo and plugin action/question plumbing in
> `packages/runtime/src/runtime.ts`; `BUILTIN_ACTIONS` / `TRIGGER_ACTIONS` / `PASSIVE` / `DEFAULT_DIAGNOSES` in
> `packages/runtime/src/situation/questions.ts`; the request-side action controllers in
> `packages/runtime/src/observe/fetch.ts` and `packages/runtime/src/observe/xhr.ts` (followed only as far as the actions).
> **Read this when:** changing what happens after a trigger is built (queueing, deadlines, hold budget, fail-open),
> the policy gate or its defaults, any built-in action's mechanics or `changed` text, custom actions / standing
> questions, the console report wording, `Decision` / `ActionRecord` / `Explanation` shapes, `explain()` or undo.
> **Source of truth:** the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

## TL;DR

- Every trigger goes through `packages/runtime/src/runtime.ts` -> `RuntimeImpl.trigger(spec, ctl, opts)`: triage
  first; if salient and the model is `ready`, the situation is submitted to a single-flight priority queue
  (`DeciderQueue`), and the subject is **held** only if the trigger is holdable (`opts.hold`) **and** at least one
  non-passive action is permitted by mode + policy. Otherwise the passive action runs at once and the decision is
  still made in the background (detection only).
- **Fail-open everywhere:** no provider, provider not `ready`, provider error (any `code`), queue overflow, expired
  deadline, runtime-side timeout, hold budget expiry, a throwing action -> the passive action runs. A missing model
  never blocks the app and never produces a `Decision`.
- **Hold budget** (`policy.holdBudgetMs`, default `"auto"`): clamp(round(1.5 × median of the last 20 provider
  latencies, or the model's `warmupMs` before any), 150, 800) ms; 300 ms when nothing is known
  (`packages/runtime/src/decide/policy.ts` -> `holdBudget`).
- **Policy gate** (`policy.ts` -> `gate`, CONTRACT §8): A = applicable non-passive actions permitted by the mode
  (observe: none; guard: guard tier; heal: guard + heal) minus `deny` (only `allow` if set). Candidate = argmax of
  probability over A. It runs only if: not paused; Σ p(A) ≥ the candidate's tier threshold (guard 0.9, heal 0.8);
  the model's top diagnosis ≠ `expected` (unless `requireDiagnosis: false`); fewer than `maxActionsPerMinute` (60)
  actions in the last 60 s; and, for holdable triggers (mutation, request, fetch failure), the decision arrived while
  the subject was still held (else late-revert rules); non-holdable triggers (stall, inconsistency, transition, error,
  XHR failure) skip this check.
- **Built-in actions** are generic capabilities defined in `situation/questions.ts` -> `BUILTIN_ACTIONS` (name, tier,
  model-facing description) and implemented by per-subject `Controller`s (`decide/exec.ts`): mutation controller in
  `runtime.ts` -> `gateMutation`; request/failure/stall controllers in `observe/fetch.ts` and `observe/xhr.ts`;
  inconsistency/transition/error controllers in `runtime.ts` (`rollback`, `revertChain`, `resync`).
- Guard tier = withhold/deduplicate/slow down (`discard`, `defer`, `coalesce`, `delay`); heal tier = change what the
  app receives or restore state (`block`, `serve_cached`, `retry`, `hedge`, `rollback`, `resync`, custom actions by
  default). Passive per trigger (`PASSIVE`): mutation `apply`, request `send`, failure `deliver`, stall `wait`,
  inconsistency / transition / error `ignore`.
- **Custom actions** (`rt.action(def)`, `plugin.actions`) are offered next to the built-ins, gated at their own
  tier (default `heal`), run inside a GenClass op, may call `ctx.builtin(name)` (re-checked against mode/policy/rate,
  not thresholds), and are followed by the passive action unless a built-in took over. **Standing questions**
  (`rt.question`, `plugin.questions`) add questions to the request; `onAnswer` gets the answer before any action.
- **Late revert:** a held write that applied because its budget expired can still be reverted by a gate-passing
  `discard` that arrives within 2 s (`LATE_REVERT_MS`) of it applying, if nothing superseded it.
- Every model answer to a trigger produces a `Decision` (`d<n>`; `ask`/`decide` do not); every non-passive action attempt produces an `ActionRecord`
  (`a<n>`, also when it failed). Both rings keep 200. `explain(id)` accepts either id.
- Reports (`decide/report.ts`): one line per detection (`[GenClass] Flagged …`) and per intervention
  (`[GenClass] Prevented …`, `Reverted …`), console output deduplicated per 60 s window with a "×N more" summary.
- `ActionRecord.undo` exists only for reversible effects (discard, late revert, rollback, custom `onUndo`); it is
  idempotent, runs inside a GenClass op named `undo` and is never gated (a discard's re-applied write is still
  attributed to its original cause, see Drift 12).

## Files

| Path | Role | Key exports / entry points |
|---|---|---|
| `packages/runtime/src/decide/decider.ts` | Single-flight priority queue in front of the `DecisionProvider`: deadlines, runtime-side timeout, answer cache, latency samples, fail-open | `DeciderQueue` (`submit`, `latencies`, `clear`, `dispose`, `length`), `DecideResult`, `PROVIDER_TIMEOUT_MS` |
| `packages/runtime/src/decide/exec.ts` | Types only: the seam between the decision flow and the subject of a trigger | `ActionEffect`, `Controller`, `TriggerOpts`, `EndOpts`, `NetHost` |
| `packages/runtime/src/decide/policy.ts` | Policy config, mode/tier permission, the §8 gate, rate limiter, hold budget | `policyConfig`, `PolicyConfig`, `modeAllows`, `restriction`, `permittedActions`, `gate`, `GateInput`, `GateOutcome`, `RateLimiter`, `holdBudget`, `HOLD_MIN_MS`, `HOLD_MAX_MS`, `HOLD_FALLBACK_MS` |
| `packages/runtime/src/decide/report.ts` | Report sentences and console sink with dedupe | `interventionLine`, `detectionLine`, `decisionLine`, `Reporter` |
| `packages/runtime/src/runtime.ts` | Wiring: `trigger`, `onDecision`, `runCustom`, mutation controller (`gateMutation`, `waitRelated`), inconsistency/transition/error controllers (`raiseInconsistency`, `raiseTransition`, `reportError`), `watchStall`, `rollback`, `revertChain`, `resync`, `runAsGenClass`, `explain`, `decisions`, `interventions`, `holdBudgetMs`, `action`, `question`, `use`, `setMode`, `pause`, `resume`, `destroy`, `setReport`, `isPaused` | `RuntimeImpl` (exported publicly from `src/index.ts`, so its public members are reachable by apps) |
| `packages/runtime/src/situation/questions.ts` | Action catalogue and diagnosis vocabulary (model-facing wording, frozen at tag `situation-v1`) | `BuiltinAction`, `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS`, `PASSIVE`, `ACTION_INSTRUCTIONS`, `DIAGNOSIS_INSTRUCTIONS`, `DEFAULT_DIAGNOSES`, `diagnosisVocabulary`, `actionDescription`, `buildQuestions`, `COMPACT_QUESTIONS_BUDGET` |
| `packages/runtime/src/situation/build.ts` | Which actions are offered for a subject (applicability); custom action options | `buildSituation`, `ActionOption`, `BuiltSituation` (internal `builtinApplicable`, `revertableChain`) |
| `packages/runtime/src/observe/fetch.ts` | fetch controllers: request gate (`send`/`coalesce`/`delay`/`block`/`serve_cached`), failure gate (`deliver`/`retry`/`serve_cached`), stall (`wait`/`hedge`/`serve_cached`) | `installFetch` (internal `runRequest`, `failureGate`, `stallController`, `reqCtl`) |
| `packages/runtime/src/observe/xhr.ts` | XHR request gate (`send`/`delay`/`block`/`serve_cached`); XHR failures/stalls are passive-only | `installXHR` (internal `fake`, `passiveOnly`) |
| `packages/runtime/src/observe/cache.ts` | Response buffers used by `coalesce` / `serve_cached` | `ResponseCache`, `makeResponse`, `blockedResponse`, `MAX_BODY`, `MAX_ENTRIES`, `COALESCE_WINDOW_MS`, `BUFFER_WAIT_MS` |
| `packages/runtime/src/state/hub.ts` | Applies a mutation verdict (`apply`/`discard`/`defer`), late-revert checks and patches | `StoreHub.revertable`, `.revert`, `.reapply`, `.restoreFields`, `.commit`, `Verdict` |
| `packages/runtime/src/types.ts` | Public shapes | `Decision`, `Detection`, `ActionRecord`, `Report`, `Explanation`, `PolicyOptions`, `ActionDef`, `ActionContext`, `StandingQuestion`, `Plugin`, `EvaluateRequest`, `DecisionProvider`, `RuntimeEvents` |
| `packages/runtime/src/index.ts` | Re-exports `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS`, `PASSIVE`, `DEFAULT_DIAGNOSES` and `RuntimeImpl` publicly (not `decide/*`: `DeciderQueue`, `gate`, `policyConfig`, `PROVIDER_TIMEOUT_MS` etc. are internal) | — |
| `packages/runtime/test/helpers.ts` | Test doubles for this scope | `setup`, `ScriptedDecider`, `defaultScript`, `ManualDecider`, `choice`, `FakeClock`, `FakeServer`, `drain` |

## Concepts and data structures

**Terms introduced here** (beyond the shared glossary):

- **controller**: an object implementing `Controller` for one trigger subject; `passive()` lets it proceed unchanged,
  `run(action)` performs a built-in action and returns an `ActionEffect` (or throws/rejects when it cannot).
- **waits**: in `RuntimeImpl.trigger`, `opts.hold && permittedActions(...).length > 0 && !paused` — whether this
  subject is actually held. A holdable trigger with no permitted action is not held.
- **expired**: the hold-budget timer fired before the decision; the passive action already ran.
- **candidate / mass**: the gate's argmax permitted action and Σ p over the permitted set (`GateOutcome`).
- **detection**: a `Decision` whose diagnosis ≠ `expected` and whose diagnosis probability ≥ `thresholds.report`.
- **intervention**: a non-passive action that ran (an `ActionRecord`).
- **GenClass op**: an instant op of kind `"genclass"` started by `RuntimeImpl.runAsGenClass(name, fn)` (cause
  `null`); writes and requests made inside it are never gated (`StoreHub.propose` bypasses `genclass` causes,
  `NetHost.gated` is false for `op.genclass`) and are excluded from baselines and profiles.
- **sync verdict** (mutations only): the verdict `gateMutation` observed while `trigger` was still on the stack;
  `"apply"` there means the write is not held at all (see flow 1).

`decide/decider.ts` consumes `types.ts` -> `EvaluateRequest { trigger; state: JevState; questions; priority?;
subject?: SubjectRef; timeoutMs? }` (the runtime sets the first five; the queue adds `timeoutMs`).

`situation/questions.ts` -> `BuiltinAction { name: string; tier: Tier; description: string }`; `Tier = "passive" |
"guard" | "heal"`, `Mode = "observe" | "guard" | "heal"` (`types.ts`).

Action helpers on `RuntimeImpl` (public members, used by the controllers; no other caller in the repo):

```ts
runAsGenClass<T>(name: string, fn: () => T): T                         // run fn inside a GenClass op
rollback(stores: string[], violationIds: string[] = [], beforeSeq?: number): ActionEffect  // snapshot rollback
revertChain(op: OpRec, why: string): ActionEffect                       // chain revert (transition/error)
resync(stores: string[]): Promise<ActionEffect>                         // call StoreOptions.resync handlers
```

`decide/exec.ts`:

```ts
interface ActionEffect { changed: string; undo?: () => void }          // one sentence: exactly what GenClass altered
interface Controller {
  passive(): void;                                                      // must be idempotent in practice
  run(action: string): ActionEffect | Promise<ActionEffect>;            // throw/reject => passive runs, record ok:false
  revertable?(): string | null;                                         // late revert (held writes only): null = can revert
  revert?(): ActionEffect;
}
interface TriggerOpts { hold: boolean; priority: number }
```

`decide/decider.ts`: `DecideResult { answers; latencyMs /* provider time, 0 for cache hits */; waitMs; cached }`.
Internal `QueueItem { req; deadline?: number /* absolute clock ms */; resolve; seq; t0 }`. `submit()` resolves
`null` for every fail-open path, never rejects.

`decide/policy.ts`:

```ts
interface PolicyConfig { thresholds: { report: number; guard: number; heal: number }; allow?: Set<string>;
  deny: Set<string>; holdBudgetMs: number | "auto"; holdUserWrites: boolean; maxActionsPerMinute: number;
  requireDiagnosis: boolean }
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
```

Internal `runtime.ts` -> `ExplainRec { decision; situationText /* stateText(situation.state) */; facts; timeline; answers; action? }`,
stored in `explainMap` under both the decision id and (once it exists) the action id.

`state/hub.ts` -> `Verdict = "apply" | "discard" | "defer"` (what a held mutation's promise resolves to).

### Action catalogue (`situation/questions.ts`)

`TRIGGER_ACTIONS` (passive first) and `PASSIVE`:

| trigger | actions offered (before applicability) | passive |
|---|---|---|
| `mutation` | `apply`, `discard`, `defer` | `apply` |
| `request` | `send`, `coalesce`, `delay`, `block`, `serve_cached` | `send` |
| `failure` | `deliver`, `retry`, `serve_cached` | `deliver` |
| `stall` | `wait`, `hedge`, `serve_cached` | `wait` |
| `inconsistency` | `ignore`, `rollback`, `resync` | `ignore` |
| `transition` | `ignore`, `rollback`, `resync` | `ignore` |
| `error` | `ignore`, `rollback` | `ignore` |
| `ask` | (none) | `""` |

`ACTION_INSTRUCTIONS` (the `action` question's instructions): mutation "What should the runtime do with this write?",
request "… with this request?", failure "… with this failed request?", stall "… with this slow request?",
inconsistency "What should the runtime do about this inconsistent state?", transition "… about this unusual state
change?", error "… about this error?". `DIAGNOSIS_INSTRUCTIONS` = "What is happening here?".

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
| `runtime.ts` -> `gateMutation` (hub `gate` hook) | `mutation` | true | 2 |
| `observe/fetch.ts` -> `runRequest` request gate | `request` | true (`keepalive` requests raise no trigger at all: `gateRequest` is false and they are sent at once) | 2 |
| `observe/fetch.ts` -> `failureGate` | `failure` | true | 2 |
| `observe/xhr.ts` -> `wSend` (async XHR only) | `request` | true | 2 |
| `observe/xhr.ts` -> `onEnd` | `failure` | false (passive-only controller) | 1 |
| `runtime.ts` -> `watchStall` | `stall` | false | 1 |
| `runtime.ts` -> `raiseInconsistency` | `inconsistency` | false | 1 |
| `runtime.ts` -> `raiseTransition` | `transition` | false | 0 |
| `runtime.ts` -> `reportError` | `error` | false | 0 |

Network triggers are raised only when `NetHost.gated(op)` (not paused, not destroyed, not a GenClass op).
`watchStall` (registered by fetch with the stall controller and by async XHR with `passiveOnly`) fires once per op at
`max(4 × median, 2 × p95, STALL_MIN_MS 500)` ms, and only when the signature has a latency baseline
(`Baselines.latency`, ≥ 5 samples). Settled-point triggers (`inconsistency`, `transition`) are covered in
[state-and-adapters.md](state-and-adapters.md) and [learn-situation-triage.md](learn-situation-triage.md).

Steps:

1. `consultable()` must be true (not paused, not destroyed, a decider exists, its `status.state` is `"ready"` or
   `"off"`); else run passive and return (no record). `"loading"` and `"error"` fail open here.
2. `computeFacts(env, spec)` (cheap pass). If `triage === "salient"`, no standing question with `always` covers this
   trigger, and every fact is neutral -> passive, no record.
3. `buildSituation(...)` (a throw -> passive). Stored in `lastBuilt[trigger]` (what `rt.situation(trigger)` returns).
4. If `!built.salient && !built.forced` -> passive.
5. If the provider is not `"ready"` (i.e. `"off"`): read `this.ready` (starts the lazy load) and run passive.
6. `permitted = permittedActions(policy, mode, built.actions)`; `waits = opts.hold && permitted.length > 0 && !paused`.
   If `!waits`, run passive **now** (the subject proceeds) and keep deciding in the background.
7. `budget = holdBudgetMs()`. If `waits`, start a budget timer: on fire set `expired = true` and run passive.
8. Deadline: `waits` -> `t0 + budget + (ctl.revert ? LATE_REVERT_MS : 0)` (only mutation controllers have
   `revert`); not waiting -> `t0 + BACKGROUND_DEADLINE_MS` (5,000).
9. `queue.submit({ trigger, state, questions, priority: waits ? opts.priority : min(opts.priority, 1), subject }, deadline)`.
10. On result: clear the budget timer; destroyed or `null` -> passive; else `onDecision(...)`. Any throw -> passive.

The `passive` closure in `trigger` is guarded by `passiveRan`, so the controller's `passive()` runs at most once
through that path. `t0` is read after the situation is built, so `Decision.latencyMs` excludes build time.

Mutation specifics (`gateMutation`): it returns `{}` (no hold) when `consultable()` is false. Otherwise it calls
`trigger` synchronously; if the controller's `passive()` ran during that call (steps 1–6: triage-neutral, not
salient, provider `"off"`, nothing permitted), the sync verdict is `"apply"` and it returns `{}`, so the hub applies
the write in the caller's stack with no microtask delay. Only otherwise does it return `{ held: Promise<Verdict> }`.
The hub's separate `mayHold` hook (`consultable() && mode !== "observe"`) only decides whether a hold-safe preview is
prepared ([state-and-adapters.md](state-and-adapters.md)).

### 2. Queue (`decide/decider.ts` -> `DeciderQueue`)

1. `submit` pushes an item; if the queue exceeds `MAX_QUEUE` (32) the lowest-priority, oldest item is resolved
   `null` (fail-open).
2. `pump` (while not busy): take the highest priority, oldest (`seq`) item.
   - `now >= deadline` -> `null` (never computed).
   - provider missing or not `"ready"` -> `null`.
   - cache key `fnv1a(trigger + "\0" + stableStringify(state) + "\0" + stableStringify(questions))` (`util.ts`;
     `subject` and `priority` are not part of it); a hit with `now - t <= CACHE_TTL` (30,000 ms) resolves with
     `cached: true`, `latencyMs: 0` (no latency sample, no provider call). Hits are only served while the provider is
     `"ready"` (checked first).
   - else `dispatch`.
3. `dispatch`: `busy = true`; runtime-side timer `limit = deadline ? max(1, deadline - t1) : PROVIDER_TIMEOUT_MS`
   (10,000). The provider receives `timeoutMs = max(1, deadline - t1)` when a deadline exists.
4. Provider resolves an object -> cache it (insertion-order eviction beyond `CACHE_MAX` 64), push `t2 - t1` to the
   latency ring (last `LATENCY_SAMPLES` 20), resolve. Sync throw, rejection, or timer fire -> `onError` + `null`;
   a non-object answer -> `null` without `onError`. The timer passes `onError` an `Error("the decision provider did
   not answer in time")` with `code: "timeout"`. `done` is idempotent; it clears `busy` and pumps the next item
   (so after a runtime timeout the next request is dispatched while the abandoned call may still be running).
5. `onError` in `runtime.ts`: `code === "max_tokens_exceeded"` shrinks automatic situation budgets
   (`budgetScale = max(0.5, budgetScale × 0.8)`, never restored; only affects `situation.budget: "auto"`); every
   error is logged (`console.debug`) only with `debug: true`. Model-host error codes (`model/errors.ts` ->
   `ModelErrorCode`): `not_ready`, `max_tokens_exceeded`, `bad_request`, `unsupported`, `timeout`, `aborted`, `busy`,
   `disposed`, `load_failed`, `integrity`, `inference_failed`; all fail open the same way.
6. `clear()` resolves every queued item `null`; `dispose()` (from `RuntimeImpl.destroy`) sets `disposed` (no more
   pumping) and clears.

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
3. Hold checks when `run` is set: held trigger that did not wait -> `"the subject was not held"`; held and
   (`expired` or passive already ran) -> late-revert path (flow 5) for `discard` with `ctl.revert`, else
   `"the decision arrived after the hold budget expired"`. Non-holdable triggers (`opts.hold` false) skip these
   checks. "Not held" is only reachable when `setMode` widened the permitted set between trigger and answer
   (`waits` is false only when nothing was permitted, the policy is fixed after construction, and a paused runtime
   never reaches `submit`). These overrides never call `rate.take`.
4. A `rate limit` reason emits a status report at most once per 60,000 ms:
   `[GenClass] Rate limit reached (<N> actions/minute): running passive actions until it clears.`
5. Build `Decision` (`action = run ?? top`), push to `decisionsBuf` (keeps 200) and `explainMap` (after adding a
   decision id, if the map holds more than 400 ids the single oldest entry is evicted; action ids share the map and
   are added in `finish` without a size check), push an event-log entry `kind "decision"`, name = trigger, `data { id, diagnosis, action, executed }`.
6. Fire `decide`; if detected (`diagnosis !== "expected" && diagnosisConfidence >= thresholds.report`) fire `detect`.
7. Call each applicable standing question's `onAnswer(answers[q.id], { decision, situation: draft, runtime })`
   (errors logged, never thrown). Applicable = `q.on` includes the trigger (`BuiltSituation.standing`); skipped when
   the provider returned no answer for `q.id`. This runs before any action executes and also when nothing runs.
8. No `run`: passive; if detected, emit a `detect` report (`detectionLine`). Done.
9. `run`: `rate.take(now)`, then flow 4.

### 4. Executing an action (`runtime.ts` -> `onDecision` -> `finish`)

1. Choose the effect: late -> `ctl.revert()`; custom (`ActionOption.custom`) -> `runCustom`; else `ctl.run(action)`.
2. Resolve -> `finish(effect)`. Throw/reject -> run passive, then `finish(null, err)`.
3. `finish` builds the `ActionRecord`: `ok = !err`; `changed = effect.changed` or, on error,
   `"Tried to <action> <subject> but it failed; the passive action ran instead."` (or `"Ran <action>."`);
   `error` = message; `late: true` for late reverts; `undo` wrapper when the effect had one.
4. Push to `actionsBuf` (keeps 200), set `rec.action` and `explainMap[record.id]`, push event `kind "action"`,
   name = action, `data { text: changed, id, decision, ok }`, fire `act`, emit an `intervene` report
   (`interventionLine`).

`finish` runs when the effect settles, so `act` / the report arrive after the action's wait: `delay` ≤ 8 s,
`coalesce` ≤ 8 s (`COALESCE_MAX_WAIT_MS`), `retry` ≤ 5 s of backoff; `hedge` waits for the second request to settle
and `resync` for the store handlers, and a custom action until `def.run` resolves (no GenClass cap on those three).

Errors a controller throws (they become `ActionRecord.error`, `ok: false`, and `(failed: <error>)` in the line):

| Thrown by | Message |
|---|---|
| any controller | `unsupported action <name>` |
| `gateMutation` -> `revert` | `the write could not be reverted` (`hub.revert` returned null) |
| fetch request gate | `the request was already sent`, `no Response constructor`, `no cached response`, `no identical request to share`, `the response of #<id> could not be shared; sent the request instead` |
| fetch failure gate | `the failure was already delivered`, `the request body cannot be replayed`, `no cached response`, `aborted` (app aborted during the retry backoff) |
| fetch stall | `already answered`, `no cached response`, `not hedgeable` |
| XHR request gate | `already decided` (also after the app aborted the held XHR), `no cached response` |
| XHR failure/stall (`passiveOnly`) | `<action> is not available for XMLHttpRequest` (never reached: only the passive action is offered) |
| `rollback` | `no consistent snapshot`, `nothing to restore: the affected stores already match the snapshot` |
| `revertChain` | `the chain wrote nothing that can be restored`, `nothing to restore: the fields already hold their earlier values` |
| `resync` | `no resync handler` (or the handler's own rejection) |
| custom action | whatever `def.run` throws or rejects with |

### 5. Late revert (held mutations only)

1. Budget timer fires -> passive -> the hub applies the write (`MutationRec.appliedAt` set).
2. The queue keeps waiting until `t0 + budget + 2000`.
3. A decision with gate result `run === "discard"` -> `ctl.revertable()` in `gateMutation`:
   `"the write has not applied yet"`; `"too late to revert: decided <secs> after the write applied"` (age > 2,000 ms;
   a backstop: the queue deadline `t0 + budget + 2000` normally expires first, so an answer that late yields no
   `Decision` at all, as `test/atoms.test.ts` asserts); then `StoreHub.revertable(m)`: `"the store is gone"`, `"the write was not applied"`,
   `"<store> cannot be written by GenClass"`, `"the write changed nothing"`,
   `"superseded: <path> changed again after the write applied"`,
   `"the same operation chain wrote <paths> after this write applied; reverting only this write would leave them inconsistent"`.
   Any string becomes `Decision.reason` and nothing runs.
4. `null` -> `late = true`; `ctl.revert()` runs `hub.revert(m)` inside `runAsGenClass("revert")`:
   `changed` = `Reverted the write to <≤3 paths>[ and N more][ from <cause>] (decided <secs> after it applied)[; <path> is back to <value>…≤2].`;
   undo = `hub.reapply(m)`. Report lead is `Reverted`.

Any other late non-passive action (`defer`, or a custom action) or a late request/failure decision is recorded with
`"the decision arrived after the hold budget expired"` (`apply` is passive, so it is never a gate `run` and never
reaches this path). A late request/failure decision is rare: its queue deadline equals the budget, so the queue
abandons the item when the budget expires and usually no `Decision` is recorded.

### 6. Custom actions and standing questions (`runtime.ts` -> `action`, `question`, `use`, `runCustom`)

Registration: `rt.action(def)` / `rt.question(def)` append to `customActions` / `standing` and return an
unregister function (removes that exact object). `rt.use(plugin)` appends `plugin.actions` and `plugin.questions`,
runs `plugin.setup(pluginApi)` (a throw is logged; a returned function is the cleanup) and returns an unregister
function; calling `use` again with the same plugin object registers nothing. Unregister / `destroy()` removes the
plugin's actions and questions and runs its cleanup. `plugin.diagnoses` labels are appended after the base
vocabulary (never overriding a label) and `plugin.facts` add neutral facts, both read at every build
([learn-situation-triage.md](learn-situation-triage.md)). Standing questions with `always: true` bypass the
salient-triage early exit (flow 1 step 2/4); their answers are delivered in flow 3 step 7.

1. Offered (`build.ts`) when `def.on` includes the trigger, no earlier option has the same name, and
   `def.applicable(draft)` is true (a throw = false). Tier `def.tier ?? "heal"`; description
   `vocabulary.actions[name] ?? def.description`.
2. Gated like any action (its own tier's threshold), then `def.run(ctx)` runs inside `runAsGenClass(def.name)` on a
   microtask, so its writes and requests are GenClass ops (never gated).
3. `ctx.builtin(name)`: false unless `name` is a built-in **offered for this trigger**. The passive name calls
   `ctl.passive()` and returns true. Otherwise false when paused, `restriction(...)` blocks it (mode tier, deny,
   allow) or the rate limiter is full; else `rate.take` (a second slot), `await ctl.run(name)`, adopt its `changed`
   (if `describe` was not called yet) and `undo` (if `onUndo` was not called yet), return true. Thresholds and the
   diagnosis rule are **not** re-applied.
4. After `run` resolves: if no builtin took over, `ctl.passive()` runs (the held write applies, the request is
   sent). `changed = describe text || "Ran the custom action <name>."`.

### 7. Reporting (`decide/report.ts`)

Lines (exact templates):

```text
interventionLine: [GenClass] <lead> <noun>: <topFact> <changed>[ (failed: <error>)] (<diagnosis>, <pDiag>; <action> <confidence>)
detectionLine:    [GenClass] Flagged <noun>: <topFact>[ Not acted on (would have done <x>): <reason>.] (<diagnosis>, <pDiag>)
decisionLine:     [GenClass] Checked <subject>: <diagnosis> (<pDiag>); ran <ran>[ (the model chose <action>[; <reason>])].
```

- `lead`: `LEAD[action]` (`discard`/`coalesce` "Prevented", `defer` "Held back", `delay` "Slowed down", `block`
  "Stopped", `serve_cached`/`retry` "Recovered from", `hedge` "Worked around", `rollback`/`resync` "Repaired"),
  `"Reverted"` when `late`, `"Handled"` for custom actions.
- `noun`: `an(NOUN[trigger])` for `expected`; `"inconsistent state"` for inconsistency+inconsistent; else
  `an("<diagnosis> <NOUN>")`. `NOUN`: write, request, request failure, slow request, state, state change, error, question.
- `topFact`: first fact not matching `/^This (write|request) (comes from|has no known cause)/`, with a trailing period.
- Probabilities are `toFixed(2)`, `?` when undefined or not finite. The `Not acted on (…)` clause is added only when
  `Decision.reason` is set and `executed` is false. `<x>` = `"<candidate> <mass> for permitted actions"` when the
  candidate differs from `action` (and `mass` is set), else `"<action> <confidence>"`.

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
   Without `groupCollapsed`: `warn` (intervene) / `info` (detect).

Status lines emitted by `runtime.ts`: `[GenClass] Model ready (<model, device, variant>[, <secs>]). Mode: <mode>.`,
`[GenClass] Model unavailable (<error>); observing only.`, `[GenClass] Mode set to <mode>.`, and the rate-limit line.

### 8. explain and undo

- `explain(id)` (`runtime.ts` -> `RuntimeImpl.explain`): looks up `explainMap`; `message` = `interventionLine` if an
  action is attached, else `detectionLine` if detected, else `decisionLine`. Returns `null` for unknown/evicted ids.
  `facts` are all ordered facts (≤ 12); `situationText` is the budget-limited text the model read.
- `ActionRecord.undo()` wrapper: no-op after the first call; runs the effect's undo inside
  `runAsGenClass("undo")`; pushes event `kind "action"`, name `"undo"`, `data { text: "undid <action> (<id>)", id }`.
  It fires no `act` event, no report, and does not mark the record. An exception from the effect's undo propagates
  to the caller, after which the wrapper is already spent (`undone = true` is set first) and no event is pushed.
- `decisions(n = 200)` / `interventions(n = 200)` return the last `n` entries of the rings, oldest first
  (`slice(-n)`); records are the live objects (mutating them affects later `explain` output).
- `holdBudgetMs()` (public on `Runtime`) returns the budget the next held trigger would use.

### 9. Mode, pause, resume, destroy (decision-side effects)

| Call | Effect in this scope |
|---|---|
| `setMode(mode)` | ignored unless `"observe" \| "guard" \| "heal"`; sets the mode used by the next `trigger` / `gate` / `ctx.builtin`; emits status `[GenClass] Mode set to <mode>.` and fires `status` with the model status |
| `pause()` | `paused = true`, `hub.gating = false` (writes commit unheld), `NetHost.gated` false (no request/failure/stall triggers); `consultable()` false, so every other trigger runs passive with no record; decisions already queued still produce a `Decision` but never run (`gate` -> `"GenClass is paused"`, shown when the model's top was non-passive); tracing continues |
| `resume()` | undoes `pause()` (no-op after `destroy`) |
| `isPaused` | getter on `RuntimeImpl` only (not on `Runtime`) |
| `destroy()` | `destroyed = true`, `hub.gating = false`, `queue.dispose()` (pending decisions resolve `null` -> passive), `reporter.dispose()` (open dedupe windows are dropped: pending "×N more" summaries never print), observers uninstalled, plugins unregistered, an owned provider disposed |
| `setReport(sink)` | `RuntimeImpl` only (not on `Runtime`): swaps the report sink live (`Reporter.setSink`) |

### Events

| Event (`rt.on`) | Payload | When |
|---|---|---|
| `decide` | `Decision` | every model answer that reached `onDecision` |
| `detect` | `Decision` | diagnosis ≠ `expected` and p(diagnosis) ≥ `thresholds.report` (also when an action ran) |
| `act` | `ActionRecord` | every non-passive action attempt, `ok` true or false, after its effect settled |
| `report` | `Report` | every report (detect/intervene/status), before the sink, even when silent |
| `status` | `ModelStatus` | provider `onStatus`; also on `setMode` (payload is the model status, not the mode) |
| `event` | `RtEvent` | every event-log entry, including `decision`, `action` and `undo` entries |

`action` (and `undo`) event-log entries appear in later situations' timelines as `<rel> GenClass <changed text>`
(`situation/describe.ts` -> `eventLine`, text truncated to 100 chars); `decision` entries are not rendered.
Listener exceptions are caught and logged (`fire`), never thrown into the decision flow.

### 10. Built-in action reference

Tiers and descriptions come from `BUILTIN_ACTIONS`; applicability from `situation/build.ts` -> `builtinApplicable`.
`opLabel(op)` (`situation/describe.ts`) renders like `GET /api/x (#12)` (phrase truncated to 90 chars; `an earlier
operation` when missing); `secs(ms)` (`util.ts`) gives 2 decimals below 10 s (`0.30s`), 1 decimal below 1,000 s,
else whole seconds.

| action | tier | trigger(s) | offered when | mechanics (where) | `changed` (abridged) | undo |
|---|---|---|---|---|---|---|
| `apply` | passive | mutation | always | verdict `apply`: hub applies now or at drain (`gateMutation` -> `passive`) | — | — |
| `discard` | guard | mutation | always | verdict `discard`: hub drops it, `set` caller not notified (`gateMutation`) | `Dropped the write to <paths>[ from <cause>]; <store> stays at version <v>.` | apply the write now on top of the current value (`hub.commit(st, { ...m, userSync: false, genclass: true, state: "resolved" }, false)`: functional updaters re-run, value writes patched; bypasses `propose`, so never gated); recorded with the original cause as writer (see Drift 12) |
| `defer` | guard | mutation | `m.defers < 2` | verdict `defer`: hub waits for related in-flight ops (`waitRelated`, cap `LONG_RUNNING_MS` 10,000), re-proposes the write (new trigger); after 2 defers it applies (`StoreHub.drain`/`defer`) | `Held the write to <paths> until the related in-flight operations finish, to decide again.` | — |
| `send` | passive | request | always | send now (`sendNow` / XHR `doSend`) | — | — |
| `coalesce` | guard | request | fetch only, and `cache.shareable(identity, op.id)`: an older identical fetch in flight or settled ≤ 2,000 ms ago | wait ≤ `COALESCE_MAX_WAIT_MS` 8,000 for its buffered response, answer a copy marked `x-genclass: coalesced` (opaque responses: unmarked clone), end op synthetic; unshareable -> send and throw | `Did not send <op>; reused the <status> response of the identical request #<id>[ (x-genclass: coalesced)].` | — |
| `delay` | guard | request | always | wait `min(250 × 2^failStreak(signature), 8000)` ms, then send (fetch and XHR) | `Delayed <op> by <secs> before sending it.` | — |
| `block` | heal | request | always | do not send; 503 `Response`, statusText `Blocked by GenClass`, header `x-genclass: blocked`; op ends `blocked` (XHR: faked 503 + `load`/`loadend`) | `Did not send <op>; answered 503 (x-genclass: blocked).` | — |
| `serve_cached` | heal | request | GET and a cached good response exists (`cache.peek`) | answer the last good GET body (≤ 256 KB), `x-genclass: cached`; op ends `ok` synthetic (XHR: faked response) | `Did not send <op>; answered with the cached <status> response from <age> ago (x-genclass: cached).` | — |
| `deliver` | passive | failure | always | hand the original `Response` / rejection to the app | — | — |
| `retry` | heal | failure | fetch, replayable body, `op.attempt < 4` | after `min(200 × 2^(attempt-1), 5000)` ms start a new fetch op (`attempt + 1`, cause = failed op) and send it; it passes through the failure gate again; the app gets that attempt's result | `Retried <op> after <secs> as attempt <n> (#<id>); the app will receive that attempt's result.` | — |
| `serve_cached` | heal | failure | fetch, GET, cached | answer the cached response instead of the failure | `Replaced the failed response of <op> with the cached <status> response from <age> ago (x-genclass: cached).` | — |
| `wait` | passive | stall | always | nothing | — | — |
| `hedge` | heal | stall | fetch, GET, idempotent, replayable | send a second identical request (op detail `(hedge)`, cause = original); first good answer wins | `Sent a second identical request #<id> for <op>; it answered first (<status>) and the app received it.` / `…; the original answered first.` / `…; it failed, so the app keeps waiting for the original.` | — |
| `serve_cached` | heal | stall | fetch, GET, cached | answer the cached response now; the original continues in the background | `Answered <op> with the cached <status> response from <age> ago instead of waiting (x-genclass: cached); the original request continues in the background.` | — |
| `ignore` | passive | inconsistency, transition, error | always | nothing | — | — |
| `rollback` | heal | inconsistency | a consistent snapshot exists and an involved store is writable | `RuntimeImpl.rollback(stores, violationIds)`: write the last consistent snapshot (of ≤ 8 kept) back to the involved writable stores | `Restored <store (paths)>; … to the consistent state from <secs> ago.` | write back the pre-rollback values and mute those violation ids until they hold again |
| `rollback` | heal | transition, error | the op's chain wrote fields nobody overwrote since, with a known earlier value, in a writable store (error: an ambient op existed) | `RuntimeImpl.revertChain(op, why)`: restore exactly those fields to their values before the chain's first write | `Restored <≤4 paths>[ and N more] to their values before <root op> (the <why>'s chain wrote them).` (`why` = `transition` or `error`) | restore the replaced values |
| `resync` | heal | inconsistency, transition | an involved store has `StoreOptions.resync` | call each such store's `resync()` inside `runAsGenClass("resync")` | `Reloaded <stores> from its/their source (resync handler).` | — |

Notes:

- Other `changed` variants: coalesce when the app was answered meanwhile -> `Coalesced <op> with #<id>, but the app
  was already answered.`; retry when the app was answered during the backoff -> `Did not retry <op>: the request was
  already answered.` (both `ok: true`). A retry whose signal aborted during the backoff rejects the app's promise with
  the abort reason and records `ok: false`, error `aborted`.
- `defer`'s "related in-flight operations" (`runtime.ts` -> `waitRelated`): in-flight ops that are neither ancestors
  nor descendants of the write's cause and either share the cause's name and kind or have a signature whose chains
  have written this store before (`storeWriters`); none -> re-proposed at once.
- Store sets: inconsistency `rollback`/`resync` act on the first path segment of every violated field; transition
  `resync` on the first segment of the op chain's written fields that are registered stores. `rollback` skips stores
  that are unregistered, not writable or absent from the snapshot; snapshots are taken at settled points where
  nothing newly broke (last 8 kept, `runtime.ts` -> `settled`).
- XHR: `coalesce`, `retry`, `hedge` and failure/stall `serve_cached` are never offered (transport check);
  XHR failures and stalls use `passiveOnly()` and are detection only. Synchronous XHRs are never held.
- The response cache keeps the last good GET body per identity (`MAX_ENTRIES` 64 × `MAX_BODY` 256 KB, memory only);
  coalescing buffers expire `COALESCE_WINDOW_MS` 2,000 ms after settling (≤ 64 entries, ≤ 4 MB); a body still
  streaming after `BUFFER_WAIT_MS` 1,000 ms is not shareable (`observe/cache.ts`). Identity details:
  [observe-and-trace.md](observe-and-trace.md).
- `rollback`'s model-facing description says "last consistent snapshot" for every trigger, but transition/error
  rollback is a chain revert (see Drift).

## Configuration and constants

| Name | Type | Default / value | Defined in | Effect |
|---|---|---|---|---|
| `mode` | `"observe" \| "guard" \| "heal"` | `"guard"` | `runtime.ts` constructor | which tiers are permitted (`policy.ts` -> `modeAllows`); `setMode` changes it live |
| `policy.thresholds.report` | number | 0.6 | `policy.ts` -> `policyConfig` | min diagnosis probability for a detection |
| `policy.thresholds.guard` | number | 0.9 | `policyConfig` | min Σ p(A) when the candidate is guard tier |
| `policy.thresholds.heal` | number | 0.8 | `policyConfig` | min Σ p(A) when the candidate is heal tier |
| `policy.allow` | `string[]` | unset | `policyConfig` | only these non-passive actions may run |
| `policy.deny` | `string[]` | `[]` | `policyConfig` | these never run |
| `policy.holdBudgetMs` | `number \| "auto"` | `"auto"` | `policyConfig`, `holdBudget` | max hold; a number is used as `max(0, n)` |
| `HOLD_MIN_MS` / `HOLD_MAX_MS` / `HOLD_FALLBACK_MS` | ms | 150 / 800 / 300 | `policy.ts` | auto budget clamp and no-data fallback |
| `policy.holdUserWrites` | boolean | false | `policyConfig` -> `StoreHub.holdUserWrites` | hold writes made synchronously in a user handler |
| `policy.maxActionsPerMinute` | number | 60 | `policyConfig`, `RateLimiter` | sliding 60,000 ms window of non-passive actions |
| `policy.requireDiagnosis` | boolean | true | `policyConfig` | require top diagnosis ≠ `expected` |
| `report` | `"console" \| "silent" \| fn` | `"console"` | `runtime.ts` constructor; `setReport()` changes it | report sink |
| `MAX_QUEUE` | number | 32 | `decider.ts` | queue overflow drops lowest-priority, oldest |
| `CACHE_MAX` / `CACHE_TTL` | number / ms | 64 / 30,000 | `decider.ts` | identical-situation answer cache |
| `LATENCY_SAMPLES` | number | 20 | `decider.ts` | provider latencies kept for the auto hold budget |
| `PROVIDER_TIMEOUT_MS` | ms | 10,000 | `decider.ts` (exported) | runtime-side timeout when a request has no deadline |
| `LATE_REVERT_MS` | ms | 2,000 | `runtime.ts` | late-revert window; also extends held-mutation deadlines |
| `BACKGROUND_DEADLINE_MS` | ms | 5,000 | `runtime.ts` | deadline of non-held decisions |
| `DECISIONS_KEPT` | number | 200 (explainMap 400) | `runtime.ts` | `decisions()`, `interventions()`, explain retention |
| `LONG_RUNNING_MS` | ms | 10,000 | `runtime.ts` | cap on `defer`'s wait for related ops |
| `WINDOW_MS` | ms | 60,000 | `report.ts` | console dedupe window |
| rate-limit warning interval | ms | 60,000 | `runtime.ts` -> `onDecision` (literal) | at most one rate-limit status line per minute |
| `COALESCE_MAX_WAIT_MS` | ms | 8,000 | `observe/fetch.ts` | coalesce wait for the shared response |
| delay backoff | ms | `min(250 × 2^streak, 8000)` | `fetch.ts` / `xhr.ts` (literal) | `delay` |
| retry backoff | ms | `min(200 × 2^(attempt-1), 5000)` | `fetch.ts` (literal) | `retry` |
| max retry attempt | number | offered while `attempt < 4` | `build.ts` -> `builtinApplicable` | at most 3 retries |
| max defers | number | 2 | `build.ts`, `hub.ts` -> `drain` (literals) | then the write applies |
| `COMPACT_QUESTIONS_BUDGET` / `COMPACT_DESC_MAX` | chars | 1,400 / 24 | `questions.ts` | compact questions drop descriptions (custom ones too) |
| `STALL_MIN_MS` | ms | 500 | `runtime.ts` | floor of the stall delay `max(4 × median, 2 × p95, 500)` |
| `budgetScale` step / floor | factor | × 0.8 per `max_tokens_exceeded`, floor 0.5 | `runtime.ts` constructor (`onError`) | shrinks `"auto"` situation budgets |
| consistent snapshots kept | number | 8 | `runtime.ts` -> `settled` (literal) | how far back `rollback` (inconsistency) can restore |
| `MAX_FACTS` | number | 12 | `situation/facts.ts` | `Decision.facts` / `explain().facts` length cap |
| `debug` | boolean | false | `runtime.ts` constructor | `console.debug` of model errors, decisions, failed listeners/standing questions/passive actions |

## Invariants and gotchas

- **No rules.** Nothing in this scope may map a fact pattern to a diagnosis or action (CONTRACT §0 rule 1). The gate
  only filters what the model chose; triage only decides whether to ask.
- **Fail-open is total.** `submit()` never rejects; every failure is `null` -> passive. New code paths must keep
  calling the controller's `passive()` on every exit. Controllers must tolerate a second `passive()` call
  (`runCustom` calls `ctl.passive()` directly, outside the `passiveRan` guard, from `ctx.builtin(<passive>)` and
  after `run`). Existing ones do: the mutation `settle` resolves its promise once; fetch `sendNow`/`deliver` check
  `sent`/`answered`/`handled`; the XHR request controller checks `decided`.
- **Model wording is frozen.** `BUILTIN_ACTIONS` descriptions, `TRIGGER_ACTIONS` order, `ACTION_INSTRUCTIONS`,
  `DIAGNOSIS_INSTRUCTIONS`, `DEFAULT_DIAGNOSES` and `PASSIVE` are model input and are mirrored in
  `training/curriculum/rt.py`, `training/curriculum/fmt.py`, `training/eval_runtime.py` and the sim. The scope
  files are unchanged since tag `situation-v1` (`1a77558`). `ActionRecord.changed` is also model input: it appears in
  later timelines.
- **Threshold semantics:** the threshold is the candidate's tier's, applied to the mass of all permitted actions.
  Guard (0.9) is stricter than heal (0.8). With `thresholds` of 0 the gate runs the first permitted action even at
  probability 0 (`p(a) > p(candidate)` is strict); the sim therefore uses 0.5 (`sim/src/run/rt.ts`).
- **`Decision.action` may differ from the model's argmax** when a permitted candidate runs while a non-permitted
  action (passive or restricted) was top (only reachable with lowered thresholds or many actions: with the 0.9
  guard threshold a passive top would need ≥ 9 permitted actions). `executed` is true when an action ran,
  even if it then failed (`ok: false`).
- **Failed actions count:** `rate.take` happens before the effect, so failures consume rate slots; a custom action
  that calls `ctx.builtin` consumes two.
- **Holds can outlast the budget after a decision:** the budget timer is cleared when the answer arrives; `coalesce`
  (≤ 8 s), `delay` (≤ 8 s), `retry` backoff (≤ 5 s) and custom actions (unbounded) keep the subject waiting.
- **Runtime timeout does not cancel the provider.** After the timer fires the queue dispatches the next request;
  a late answer from the abandoned call is still cached and its latency still enters the hold-budget samples
  (code reading; the model host has its own queue and timeouts, see [model-host.md](model-host.md)).
- **Determinism:** only the injected `Clock` is used (timers, `now`); ids are counters (`d<n>`, `a<n>`). Do not add
  `Date.now`/`setTimeout` here (CONTRACT §0 rule 3).
- **Precision / harm:** nothing is held when no action is permitted (observe mode; failures in guard mode), so the
  default mode adds no latency for triggers it could not act on. Holding still delays salient writes/requests up to
  the budget (OPEN_TASKS: hold-induced harm).
- **Console hints** reference `GenClass.runtime`, which is `null` for runtimes made with `createRuntime`.
- **Devtools mirrors report wording** (`src/devtools/ui.ts` -> `LEAD`, `NOUN`, `splitReport` regexes for
  `Not acted on (…)` and `(diag, p; action p)`). Changing a line format can break the overlay.
- **Compact questions** (budget ≤ 1,400 chars) send custom action descriptions as `null` unless a vocabulary
  override ≤ 24 chars exists, so the model sees only the custom action's name.
- **Answer cache in tests:** identical `(trigger, state, questions)` within 30 s are answered from the queue cache,
  so `ScriptedDecider.calls` does not grow and a changed script does not apply to a repeated identical situation.
  Advance the fake clock past 30 s or vary the situation.
- **Undo is unguarded:** `ActionRecord.undo()` ignores mode, pause, policy and the rate limit, and never checks
  whether the state moved since (a discard's undo re-runs/patches the write over the current value; a rollback's
  undo writes back whole pre-rollback store values).
- **Dead surface:** `RuntimeImpl.rollback`'s `beforeSeq` parameter is never passed (only the last consistent
  snapshot is used); `RuntimeImpl.setReport` has no caller (Drift 13; devtools listens to `on("report")`).

## How to change it safely

Run tests with `npm test` / `vitest run` in `packages/runtime`. The team ran them on the VM (CONTRACT §0 rule 5).
Under the 2026-10-07 run policy in AGENTS.md, agents on other machines may run the unit tests locally (see
[build-test-release.md](build-test-release.md#where-to-run-things)).

1. **Change a default threshold, budget or rate:** edit `policy.ts` -> `policyConfig` / `HOLD_*`; update the JSDoc
   in `types.ts` -> `PolicyOptions`, `docs/runtime/API.md`, and assertions in `test/policy.test.ts`,
   `test/budget.test.ts`, `test/fetch.test.ts` ("request gate fails open after the hold budget" expects 300 ms; the
   failure-gate fail-open test also depends on the 300 ms fallback).
2. **Change gate logic:** edit `policy.ts` -> `gate` only; keep reason strings stable (asserted verbatim in
   `test/policy.test.ts`, `test/report.test.ts`, and parsed by devtools). Check the sim's forced-action contract
   (`sim/src/run/rt.ts` thresholds 0.5, `requireDiagnosis: false`).
3. **Change an action's mechanics:** edit its controller (table above). Keep: throw when it cannot run (passive then
   runs); return an exact `changed` sentence; provide `undo` only if truly reversible; end synthetic ops with
   `synthetic: true` so baselines ignore them. Coordinate `changed` wording with SIM (timeline input). Tests:
   `test/fetch.test.ts`, `test/xhr.test.ts`, `test/atoms.test.ts`, `test/review-fetch.test.ts`, `test/review-xhr.test.ts`.
4. **Add a built-in action:** add to `BUILTIN_ACTIONS` and `TRIGGER_ACTIONS` (passive stays first), applicability in
   `build.ts` -> `builtinApplicable`, implementation in the trigger's controller, `LEAD` in `report.ts` and
   `devtools/ui.ts`. This changes model input: it needs a new freeze tag, sim + training mirrors, new data and a
   retrained model. Do not do it inside the runtime alone.
5. **Change report wording:** `report.ts` templates; update `test/report.test.ts`, `test/atoms.test.ts` (late revert
   line), `test/review-misc.test.ts`, and `src/devtools/ui.ts` + `test/devtools*.test.ts`.
6. **Change queue behaviour:** `decider.ts`; tests `test/budget.test.ts` (timeoutMs, expired items not computed),
   `test/batch3.test.ts` and `test/review-misc.test.ts` (provider that never answers), `test/atoms.test.ts`
   (provider error codes fail open with no time passing).
7. **Custom action / standing question API:** `runtime.ts` -> `runCustom`, `action`, `question`, `use`; `build.ts`
   for offering; tests `test/plugins.test.ts`, `test/batch3.test.ts`, `test/review-misc.test.ts`.
8. **Write a test for this scope:** `test/helpers.ts` -> `setup({ mode, policy, script })` gives a headless
   `RuntimeImpl` on a `FakeClock` with a `FakeServer` fetch, `report: "silent"` and only the fetch observer.
   `defaultScript({ mutation: { diagnosis: "stale", action: "discard", p } })` answers per trigger (passive when the
   action is not offered) via `choice(label, labels, p = 0.97)`, which puts `p` on the label and splits the rest
   evenly. Use `ManualDecider` (`answer()` releases the oldest pending request) to control timing for budget
   expiry / late-revert tests. Advance time with `clock.advance(ms)` / `clock.runAll()` and flush with `drain()`.
9. **Add a new trigger kind's controller:** implement `Controller` (`decide/exec.ts`), call `host.trigger(spec,
   ctl, { hold, priority })`, and only add `revertable`/`revert` if the subject can be reverted exactly; a `revert`
   on the controller extends the queue deadline by `LATE_REVERT_MS`, and `onDecision` only uses it for a late
   `discard`. Adding the trigger kind itself changes model input (see 4).

## Tests

| Test file | What it asserts (scope-relevant) |
|---|---|
| `packages/runtime/test/policy.test.ts` | gate: mass split (discard 0.5 + defer 0.45 runs), mode tiers, thresholds 0.9/0.8 with exact reason text, no reason when top is passive, `requireDiagnosis`, deny/allow, pause, rate limit + sliding window, observe never holds, `setMode`, `pause/resume`, loading fails open with no record, detection threshold |
| `packages/runtime/test/report.test.ts` | intervention/detection line formats, `explain()` by action or decision id, console group contents, ×N summary at window end, `decide`/`detect`/`act`/`event` listeners |
| `packages/runtime/test/atoms.test.ts` | holds; fail-open at budget; late revert exact `changed` text, `Reverted` line and undo; refusals (superseded, same chain); an answer more than 2 s after the budget records no `Decision` (queue deadline); late `defer` only recorded; provider error codes `not_ready`/`max_tokens_exceeded`/`timeout`/`busy` fail open with no time passing; discard + undo; defer max 2 |
| `packages/runtime/test/budget.test.ts` | `holdBudget` auto values (300, 600, 800, 150, 345, fixed 50); adaptive budget from latencies; `timeoutMs` = budget + 2,000 for held writes and = budget for requests; expired queued items never computed; `max_tokens_exceeded` shrinks automatic situation budgets (queue `onError` path) |
| `packages/runtime/test/fetch.test.ts` | coalesce, block (heal), guard never runs heal, serve_cached, delay 250 ms, retry backoff 200 ms and attempts, retry not offered for streams, failure delivered, failure/request gates fail open at 300 ms, hedge |
| `packages/runtime/test/xhr.test.ts` | XHR block 503, failures detection-only, request gate hold and fail-open |
| `packages/runtime/test/review-fetch.test.ts` | coalesce never hangs (opaque, streaming), failure not held in guard mode, keepalive never held |
| `packages/runtime/test/review-hub.test.ts` | undo of a late revert restores the write exactly; a held in-place update is not visible before it applies, and `discard` really drops it |
| `packages/runtime/test/review-actions.test.ts` | error rollback offered only when the chain wrote state; other chains untouched |
| `packages/runtime/test/invariants.test.ts` | inconsistency rollback to snapshot, undo, one trigger per episode |
| `packages/runtime/test/learn.test.ts` | transition rollback restores the chain's fields (exact `changed`) |
| `packages/runtime/test/plugins.test.ts` | plugin facts/diagnoses/actions reach the model; custom action runs then passive; `ctx.builtin("discard")`; custom default heal tier; `applicable()`; standing question + `onAnswer`; vocabulary overrides |
| `packages/runtime/test/batch3.test.ts` | `ctx.builtin` obeys deny; rate-limit warning once; never-answering provider does not block; `transient` label |
| `packages/runtime/test/review-misc.test.ts` | every intervention reaches the console; rate warning once; denied heal builtin not run in guard; queue robustness; `ask()` after destroy |
| `packages/runtime/test/devtools-runtime.test.ts` | overlay undo applies a dropped write; report sentences in the overlay |
| `packages/runtime/test/smoke.test.ts` | end to end: held stale write discarded in guard mode; atoms apply synchronously when nothing is salient |
| `packages/runtime/test/review-xhr.test.ts` | sync XHR never held; an XHR the app aborts while held is never sent; XHR reused after a blocked answer shows the real state |
| `packages/runtime/test/adapters-react.test.ts`, `adapters-redux.test.ts`, `adapters-zustand.test.ts` | held async writes through adapters; `discard` drops them (no reducer/subscriber), recorded in `interventions()`; react undo |
| `packages/runtime/test/ask.test.ts` | `ask` sends a trigger-`ask` request with the single question `answer` and returns a typed answer; `decide` returns the label; `about` focuses the situation; no model -> rejects with `GenClassUnavailableError`; `timeoutMs` -> reason `timeout` |

## Drift and open issues

Doc-vs-code mismatches (code is authoritative):

1. `docs/runtime/CONTRACT.md` §8 says `holdBudgetMs` default 300; code default is `"auto"` (300 is only the no-data
   fallback). `demos/README.md` ("held for at most `holdBudgetMs` (300 ms)") and the `demos/src/shared/settings.ts`
   comment ("default: the runtime's 300 ms") repeat the stale number.
2. CONTRACT §7 retry backoff `min(200 ms · 2^attempt, 5 s)`; code `min(200 × 2^(attempt-1), 5000)` (STATUS deviation).
3. CONTRACT §7 `rollback` = "last consistent snapshot"; code does that only for `inconsistency`; transition/error
   restore only the op chain's fields. The model-facing description is unchanged for all triggers.
4. CONTRACT §8 `Decision`/`ActionRecord`/`Explanation` field lists omit `tier`, `ran`, `answers`, `subjectRef`,
   `candidate`, `mass`, `ActionRecord.late`, `Explanation.message`; `DecisionProvider.evaluate` omits `priority`,
   `timeoutMs`. §9 `ActionDef` omits `tier`; `StandingQuestion` omits `always`. `ActionDef.risk` is unused.
   (§13 does add `EvaluateRequest.subject` / `Decision.subjectRef` and `policy.requireDiagnosis`; STATUS
   "Deviations" lists the rest as extra public surface.)
5. `types.ts` JSDoc vs code: `Decision.action` ("the action the model chose (highest probability)") is `run ?? top`;
   `Decision.executed` ("true when `action` ran as chosen") is also true when the passive action was the top and when
   the action ran but failed; `EvaluateRequest.priority` ("held writes/requests use 2, background 0") is 2 held,
   `min(priority, 1)` when not held (1 for non-held mutation/request/failure/stall/inconsistency, 0 for
   transition/error) and 1 for `ask`.
6. CONTRACT §8 "summarised as ×N in the last minute"; code prints `(×N more in the last minute)` at window end and
   only for the `"console"` sink. CONTRACT §0.5 / `packages/runtime/README.md` example lines ("Coalesced a
   duplicate: …", "Flagged: …") do not match the real templates.
7. `packages/runtime/STATUS.md` and `sim/NEEDS.md` headless examples use thresholds `{ report: 0, guard: 0, heal: 0 }`;
   the sim actually uses `guard`/`heal` 0.5 (`sim/src/run/rt.ts`) because 0 runs a zero-probability action.
8. `src/devtools/ui.ts` templates differ from `report.ts`: `NOUN.failure` "failed request" vs "request failure",
   extra adjectives (`conflicting`, `excessive`), no `Reverted` lead.
9. CONTRACT §7 implies XHR parity; code never offers XHR `coalesce`/`retry`/`hedge` (STATUS deviation).
10. CONTRACT §7 calls guard-tier actions "minimal and reversible"; only `discard` (and a late revert) returns an
    `undo`. `defer`, `coalesce` and `delay` have none (`Undo: not reversible` in the console group).
11. CONTRACT §8 says an `ActionRecord` is emitted "for every non-passive action that ran"; code also records failed
    attempts (`ok: false`, `error`), and those consume a rate-limit slot.
12. `discard`'s undo builds a `MutationRec` with `genclass: true`, but `StoreHub.commit` writes under `m.cause`
    (ambient and writer), and `StoreHub.write`/`record` never read `m.genclass`, so the re-applied write is recorded
    as the original cause's write, not a GenClass op (code reading; no test asserts the writer). The comment in
    `test/atoms.test.ts` ("the undo write is a GenClass write: never gated") is half right: it is never gated only
    because `commit` bypasses `propose`.
13. `RuntimeImpl.setReport` JSDoc says "(devtools)", but nothing in the repo calls it; it is also absent from the
    `Runtime` interface, as is `isPaused`.

Open items (from `OPEN_TASKS.md`, `packages/runtime/STATUS.md`):

- The published alpha takes no actions until the runtime model package is published.
- Hold-induced harm and triage sensitivity (OPEN_TASKS item 6, v0.1 model: the board demo had 9 bugs introduced in
  guard mode with no interventions; search clean-run latency rose from 14 ms to 125 ms because salient writes were
  held; typeahead was salient about 6 times per trial on clean runs).
- Known risk (OPEN_TASKS): slow single-thread WASM leads to more fail-open decisions. Note from code: late revert only
  covers a `discard` of a held write; late request/failure decisions are never applied.
- Possible follow-ups seen in code reading (unverified at runtime): late provider answers after a runtime timeout
  still feed the cache and latency samples; custom actions can hold a subject indefinitely.

## Related docs

- [public-api-and-lifecycle.md](public-api-and-lifecycle.md): `GenClass.init`, options, kill switch, `ask`/`decide`.
- [observe-and-trace.md](observe-and-trace.md): fetch/XHR observers, request identity, ops and causality.
- [state-and-adapters.md](state-and-adapters.md): mutation pipeline, holds, defer, invariants, snapshots.
- [learn-situation-triage.md](learn-situation-triage.md): facts, triage, situation building, questions, budgets.
- [model-host.md](model-host.md): the default `DecisionProvider`, its queue, timeouts and error codes.
- [devtools.md](devtools.md): overlay views, report parsing, undo button.
- [build-test-release.md](build-test-release.md): running tests on the VM.
- [../overview.md](../overview.md#4-walkthrough-a-typeahead-stale-write): trigger -> queue -> gate -> discard end to end.
- [../model-io-contract.md](../model-io-contract.md), [../sim.md](../sim.md), [../training.md](../training.md).
- [../status-and-known-issues.md](../status-and-known-issues.md), [../glossary.md](../glossary.md).
- Binding spec: [../../runtime/CONTRACT.md](../../runtime/CONTRACT.md) §6–§9; human API: [../../runtime/API.md](../../runtime/API.md).
