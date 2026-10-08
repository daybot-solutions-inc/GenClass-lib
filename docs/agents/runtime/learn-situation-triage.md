# @genclass/runtime: baselines, profiles, cadence, facts, triggers, triage and situation serialisation

> **Scope:** `packages/runtime/src/learn/{baselines,profiles,cadence}.ts`,
> `packages/runtime/src/situation/{build,facts,conflicts,content,evidence,describe,env,questions,serialize}.ts`, the
> triage and delivery-gate code in `packages/runtime/src/runtime.ts` (`RuntimeImpl.trigger`, `RuntimeImpl.runDelivery`,
> `RuntimeImpl.observeWrite`, `RuntimeImpl.gateMutation`, `RuntimeImpl.covered`, `RuntimeImpl.settled`,
> `RuntimeImpl.situationBudget`, `RuntimeImpl.makeEnv`, `RuntimeImpl.markWrites`, `RuntimeImpl.onChannel`,
> `RuntimeImpl.noteResponse`) and the text helpers they use in `packages/runtime/src/util.ts` and
> `packages/runtime/src/state/fields.ts` (`changeText`, `stringDiff`). Triage/salience lives in `situation/facts.ts`,
> `situation/content.ts`, `situation/conflicts.ts` (`neutral` flags and conflict rules), `situation/build.ts`
> (`salient`, `forced`), `runtime.ts` -> `RuntimeImpl.trigger` (cheap pass) and `runtime.ts` ->
> `RuntimeImpl.runDelivery` (the delivery pre-filter, which decides before any fact is computed); other hits for
> "salient" in `adapters/`, `observe/` and `devtools/` are comments or display.
> **Read this when:** you change any text the model reads (fact wording, timeline/state/stats lines, questions, action
> descriptions, diagnosis labels), the triage rule (what is salient), the delivery gate, the situation budget or
> section limits, redaction, the latency/error/rate/cadence baselines, or transition profiles; or when you need to know
> why a trigger did or did not reach the model.
> **Source of truth:** the code. Verified against branch `mvp-v2-merge` (mvp-v2 + origin/runtime eff18cb + observe/redaction fixes), 2026-10-08. If this doc and the code disagree, the code wins.

## TL;DR

- **Every byte here is model input, and the format is frozen.** The current training format is git tag
  `situation-v2` (commit 6e5e86e, "Runtime batch 5 … freeze situation-v2"). `git diff situation-v2 HEAD --
  packages/runtime/src` touches `runtime.ts` (default mode f3636b2; background deliveries 054da38, §4-§5; the
  purity fix to `recentErrors` 29b7f28), `types.ts` and `devtools/index.ts` (default-mode comments and labels),
  `trace/ops.ts` (`OpRegistry.peekNextId`, for tests), `observe/messages.ts` (`bodyNow`) and `observe/xhr.ts`
  (`body.now`), the install entries (`auto.ts`, `cdn/*`) and the redaction fix (commit f107013, §12):
  `situation/content.ts` (F2), `state/fields.ts` (`redactedStringDiff`) and `util.ts` (`isSensitivePath`). The
  redaction fix is the only change to what a given state renders to, and only for values the redactor hides;
  everything else renders byte-for-byte as at the freeze. 054da38 changes when a delivery that cannot be held
  (observe mode, no permitted action, model not ready or too slow) is released, analysed and decided, not the text;
  the sim and realapps' recorded (non-`ideal`) runs default to `mode: "heal"` with `holdBudgetMs: 1e9` and a ready
  decider, so their deliveries stay holdable (`sim/src/run/rt.ts` -> `createOptions`,
  `realapps/src/world/index.ts` -> `__GENCLASS_INIT__`). Nothing in `src/learn/`
  changed. Producers of training rows
  run this exact code: the sim (`sim/src/run/rt.ts` -> `realRuntimeFactory`), the real-browser corpus
  ([realapps](../realapps.md)) and the hand-written Python port `training/curriculum/rt.py` (its docstring says
  "FROZEN at git tag `situation-v2`"). No situation-v2 model exists yet ([HANDOFF.md](../../../HANDOFF.md), `training/NEEDS.md`); the old
  `situation-v1` tag (1a77558) and its R17 checkpoint do not match this code. Any wording/threshold/budget change
  means a new tag and regenerated data.
- **Decisions moved to the network boundary (batch 4).** New trigger `delivery`: a fetch/XHR response or a
  WebSocket/EventSource message is about to reach the app. Store writes are **not held by default**
  (`policy.holdWrites: false`): a salient write raises a non-blocking `mutation` that is decided in the background
  (late revert is the only enforcement), and writes already covered by a delivery decision raise nothing.
- **Version conflicts** (`situation/conflicts.ts`): a field's version fact is non-neutral only for a **newer-data
  conflict** (value changed since op X started, written by an op that started after X, outside X's chain, not itself
  a user action, and no newer request of X's signature still in flight) or a **pending local change** (a user
  action's chain wrote it in the last 10 s and an op of that chain with a different signature is still in flight).
  "Inputs that moved" (M5) and "same-signature op in flight" (M6) are now always neutral.
- **Delivery salience** (`RuntimeImpl.runDelivery`): predicted write set P from the op's transition profile (else what
  the last completion of its signature wrote, else unknown); salient iff a P field has a newer-data conflict that the
  response would actually change, or a pending local change the response would revert (F1), or text the user typed
  since the request started that the response would replace (F2). The body (a clone, JSON, <= 256 KB) is read only
  for candidates, waiting at most 100 ms.
- **New evidence facts (batch 5, all neutral unless stated):** F1 put-back-an-older-value (salient), F2 replace typed
  text (salient), F3 response changes nothing, F5 failure scope / offline / commit ambiguity, F6 learned cadence
  (`learn/cadence.ts`), F7 repeated-user-action evidence, F9 stale marks, read-your-writes (salient).
- **Baselines** (`Baselines`, unchanged): per op signature, fetch/XHR only: last 64 non-failure latencies (median/p95
  from 5 samples), last 20 outcomes, failure streak, EWMA error rate (unused), start times (rate), identity gaps.
- **Transition profiles** (`Profiles`, unchanged): unusual when write set, a field's kind, status class or write
  count was seen in < 1% of >= 20 previous completions. Profiles now also feed the delivery prediction.
- **Triggers** (`TriggerKind`): `mutation`, `request`, `delivery`, `failure`, `stall`, `inconsistency`, `transition`,
  `error`, `ask`.
- **Triage**: with `triage: "salient"` (default) the model is consulted only if some fact is non-neutral, a standing
  question with `always: true` applies, or the trigger is `ask`; `delivery` is additionally pre-filtered by
  `runDelivery`. Triage is a cost filter only.
- **Budget** in characters: `STATE_CHAR_BUDGET = 2400` (was 3200), `COMPACT_BUDGET = 1100`, linear in between;
  `MIN_BUDGET = 500`. "auto": WebGPU or unknown device 2400; WASM 1000/1333/1667/2000 for 1..4+ threads; x0.8 per
  `max_tokens_exceeded`, floor 0.5 (2400 -> 1920 -> 1536 -> 1229 -> 1200).
- **Deterministic and almost side-effect free**: only the injected clock is read; the only write inside fact code is
  `X.reads.set(path, vStart)` (the gate itself sets `op.delivery`, marks and buffers; see Invariants). Building a
  situation consumes no op ids, events, decisions or timers (`test/situation-purity.test.ts`); `SitEnv.recentErrors`
  only filters, pruning happens when an error is recorded.

## Files

| path | role | key exports / entry points |
|---|---|---|
| `packages/runtime/src/learn/baselines.ts` | online per-signature latency, outcomes, failure streak, rate; identity gaps | `Baselines` (`start`, `end`, `noteIdentity`, `latency`, `rate`, `failureCounts`, `stats`, `identity`, `snapshot`), `SigStats`, `LatencyBaseline`, `RateBaseline`, `IdentityStats`, `isFailureOutcome`, `outcomeLabel` |
| `packages/runtime/src/learn/profiles.ts` | transition profiles and rarity check | `Profiles` (`check`, `add`, `get`, `toJSON`, `load`), `shapeOf`, `kindLabel`, `writesBucket`, `durBucket`, `Profile`, `Shape`, `Unusual`, `MIN_COMPLETIONS`, `RARE` |
| `packages/runtime/src/learn/cadence.ts` (new, batch 5) | learned schedule (polling) or debounce per request signature (F6) | `Cadence` (`note`, `get`), `CadenceInfo` |
| `packages/runtime/src/situation/env.ts` | what situation code may read; trigger subjects | `SitEnv`, `SubjectSpec`, `DeliverySpec`, `ReqMeta`, `FailureInfo`, `Violation`, `ErrorInfo`, `CachedInfo`, `ChainWriteInfo`, `CreateRec`, `OutcomeRec` |
| `packages/runtime/src/situation/conflicts.ts` (new, batch 4) | predicted write set, newer-data and pending-local-change conflicts | `predictedWrites`, `matchFields`, `newerConflict`, `pendingConflict`, `conflictsOn`, `newerSameSignature`, `Predicted`, `Conflict`, `PENDING_WINDOW_MS` |
| `packages/runtime/src/situation/content.ts` (new, batch 5) | response/write content vs store (F1-F3), read-your-writes | `indexBody`, `parseJsonBody`, `locate`, `compareField`, `analyzeBody`, `contentFacts`, `pendingRevertFacts`, `createdIds`, `rywFacts`, `vhash`, `Cmp`, `ItemCmp`, `ContentResult`, `Located`, `BodyIndex`, `RYW_WINDOW_MS` |
| `packages/runtime/src/situation/evidence.ts` (new, batch 5) | F9 stale marks, F6 cadence, F5 scope/commit ambiguity, F7 repeat evidence | `markFacts`, `cadenceFact`, `scopeFacts`, `commitAmbiguity`, `failureOf`, `hostOfSig`, `repeatEvidence` |
| `packages/runtime/src/situation/facts.ts` | fact computation per trigger, ordering | `computeFacts`, `orderFacts`, `predictedText`, `MAX_FACTS`; internal `versionFacts`, `movedFacts`, `concurrencyFacts`, `mutationFacts`, `deliveryFacts`, `requestCommon`, `failureFacts`, `stallFacts`, `inconsistencyFacts`, `transitionFacts`, `errorFacts`, `askFacts`, `netOf`, `storeLists` |
| `packages/runtime/src/situation/describe.ts` | how ops and events are phrased (unchanged) | `userPhrase`, `opPhrase`, `opLabel`, `statusText`, `eventLine` |
| `packages/runtime/src/situation/build.ts` | subject sentence, sections, applicable actions, questions, salience | `buildSituation`, `subjectOf`, `subjectRef`, `relatedInFlight` (new), `isTrigger` (unused), `BuildOptions`, `BuiltSituation`, `ActionOption`; internal `subjectOp`, `involvedStores`, `involvedFields`, `builtinApplicable`, `revertableChain`, section builders |
| `packages/runtime/src/situation/questions.ts` | action catalogue, per-trigger actions and descriptions, diagnosis vocabulary | `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS`, `PASSIVE`, `ACTION_INSTRUCTIONS`, `TRIGGER_DESCRIPTIONS` (new), `DIAGNOSIS_INSTRUCTIONS`, `DEFAULT_DIAGNOSES`, `COMPACT_QUESTIONS_BUDGET`, `diagnosisVocabulary`, `actionDescription`, `buildQuestions` |
| `packages/runtime/src/situation/serialize.ts` | budget-shaped Jev state | `toJevState`, `sectionLimits`, `stateChars`, `stateText`, `STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `MIN_BUDGET`, `LIMITS` |
| `packages/runtime/src/runtime.ts` (parts) | owns `Baselines`/`Profiles`/`Cadence`, feeds them, implements `SitEnv`, runs the delivery gate and triage, sets stale marks | `RuntimeImpl.trigger`, `runDelivery`, `deliveryHoldable`, `writesCanAct`, `finalizeDeliveries`, `observeWrite`, `gateMutation`, `mutationController`, `covered`, `expectedLatency`, `noteResponse`, `onChannel`, `markWrites`, `dropFilter`, `writtenOver`, `onDropped`, `waitOps`, `settled`, `situationBudget`, `buildOpts`, `makeEnv`, `startOp`/`endOp`/`onApplied`/`watchStall` |
| `packages/runtime/src/util.ts` (parts) | formatters and redaction | `secs`, `rel`, `fmtNum`, `ratio`, `plural`, `ordinal`, `truncate`, `describe`, `defaultRedact`, `isSensitivePath` (new), `isSensitiveName`, `words`, `REDACTED`, `Redactor`, `kindOf`, `normalizeFieldPath`, `requestSignature`, `normalizePath`, `isIdSegment`, `parseUrl` |
| `packages/runtime/src/state/fields.ts` (parts) | change sentences ([state-and-adapters](state-and-adapters.md) owns it) | `changeText`, `stringDiff` (new), `redactedStringDiff` (redaction fix), `elementDiff`, `addedElements`, `normalizeLeafKind` |
| `packages/runtime/src/state/hub.ts` (parts) | stale marks on fields | `FieldState.mark`, `StaleMark`, `StoreHub.markField` (cleared by the next write) |
| `packages/runtime/src/index.ts` | public re-exports from this area | `stateText`, `stateChars`, `sectionLimits`, `STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS`, `PASSIVE`, `DEFAULT_DIAGNOSES` |

Delivery raise sites (see [observe-and-trace](observe-and-trace.md)): `observe/fetch.ts` and `observe/xhr.ts` call
`host.deliver(...)` (-> `runDelivery` with `channel: "response"`) and `host.noteResponse(...)` for non-GET/HEAD 2xx;
`observe/messages.ts` (used by `observe/websocket.ts` and `observe/eventsource.ts`) calls `host.deliverMessage(...)`
(-> `runDelivery`); `observe/websocket.ts` and `observe/eventsource.ts` themselves call `h.channel?.("down" | "up",
...)` (-> `RuntimeImpl.onChannel`). All of these are wired in `RuntimeImpl.wsHost` / the fetch-XHR host in `runtime.ts`.

Public types in `packages/runtime/src/types.ts`: `TriggerKind` (now with `delivery`), `Fact`, `FactKind`, `Situation`,
`SituationDraft` (now with `delivery?: { channel, predicted, conflicts }`), `SubjectRef`, `JevState`, `Question`,
`Vocabulary`, `StandingQuestion`, `ActionDef`, `Tier`, `UserAction.clicks?` (MouseEvent.detail, read by F7).

## Concepts and data structures

| term | meaning (code name) |
|---|---|
| op signature | `requestSignature(method, where)` in `util.ts`: upper-cased method + path with id-like segments replaced by `:id`. It is `op.name` for fetch/XHR ops and the key of `Baselines` and `Cadence`. Message ops are named `WS message <path>`, `SSE message <path>` or `SSE <type> <path>` (`observe/messages.ts`). `Profiles` key ops by `op.name`, user ops by `user <op.name>`. |
| request identity | `ReqMeta.identity`: hash of method + URL + semantic headers + body. `uniq:` identities never match. |
| outcome | string per completion in `SigStats.outcomes`: HTTP code, `"timeout"`, `"network"`, or a status; failures stored with a `!` prefix. `"aborted"` is never recorded. |
| failure (baselines) | a completion with `EndOpts.failure`: network error, timeout, HTTP 5xx, 429, 408. A 404 is not a failure. |
| chain | an op and its causal descendants. "Same chain" = one op is ancestor-or-self of the other (`sameChain` in `facts.ts`/`content.ts`, `inChain` in `conflicts.ts`). |
| predicted write set P | `Predicted { patterns, source: "profile" or "last" or "unknown", seen, of }` from `predictedWrites(env, op)`: the normalised fields in the signature's profile `wrote` map, else `SitEnv.lastChain(op.name)` (the normalised fields the latest chain of that signature wrote; `RuntimeImpl.lastChainMap`, overwritten in `onApplied` on every write of a non-user op's chain, so a chain still running counts too, although the `env.ts` comment says "last completed"), else unknown. |
| matched fields | concrete current leaf paths matching P (`matchFields`, at most 64). |
| newer-data conflict | `Conflict { kind: "newer" }` from `newerConflict(env, X, path)`: no newer same-signature fetch/XHR in flight (`newerSameSignature`), some write since X started by an op outside X's chain that is not a user op, not a user write, and started after X; and the value changed net (`netChanged`; unknown history counts as changed). |
| pending local change | `Conflict { kind: "pending" }` from `pendingConflict(env, X, path, now)`: in the last 10 s (`PENDING_WINDOW_MS`) a chain rooted at a user op (not X's root) wrote the field, and a non-user op of that root with a name different from X's is in flight (`x` null: any name). |
| delivery spec | `DeliverySpec { op, channel, req?, status?, message?, predicted, matched, conflicts, defers, queuedAhead, body?, content? }` (`env.ts`). |
| `op.delivery` | set by `runDelivery` on the op: `{ patterns, known, salient, decided, overNewer? }`; read by `covered` (skip `mutation` triggers for covered writes) and `markWrites` (F9 "delivered over newer data"). |
| covered write | `RuntimeImpl.covered(m)`: walking up to 16 causes from `m.cause`, the first op with `op.delivery`: covered iff P was known, every changed path is in P (raw or normalised), and the delivery was not salient, was decided in time, or has a background decision pending (`deliveryPending`, observe or no permitted action; since 054da38). Never covered with `triage: "always"`. |
| content comparison | `Cmp` (`content.ts` -> `compareField`): incoming vs current value by value hash, the value when X started (if the 16-entry history covers it), other chains' writes since X, `revertOf` (newest such write whose replaced value equals the incoming one), typed-text writes (`user`), and `items` (`ItemCmp`, list joined on `id`/`_id`/`uuid`/`slug`/`key`). |
| stale mark | `StaleMark { t, op, why }` on `FieldState.mark`, set by `RuntimeImpl.markWrites` / `onChannel`, cleared on the next write; stated by F9 (`markFacts`). |
| cadence | `CadenceInfo`: `periodic { period, intervals, last, next }` or `debounced { delay, matching, of }` (`Cadence.get`). |
| creates | `CreateRec { op, t, status, ids, keys }`: ids returned by recent create responses (POST or 201), parsed in the background by `noteResponse` -> `createdIds`; read by `rywFacts`. |
| outcomes buffer | `OutcomeRec { t, sig, host, ok, outcome }` for every non-aborted fetch/XHR completion in the last 30 s (max 128), for F5 scope. |
| subject | `SubjectSpec` (internal) / `SubjectRef` (public ids only; never serialised into `state`). |
| fact | `Fact { text, kind: FactKind, neutral }`. `neutral: false` = makes the situation salient. |
| salient / forced | `BuiltSituation.salient` (`triage === "always"`, trigger `ask`, or a non-neutral fact) / `forced` (an `always` standing question for this trigger). |
| draft | `SituationDraft`: structured view for plugin `facts()` and `ActionDef.applicable()`. |
| parts / state (Jev) / budget | `SituationParts` (unbudgeted lines) -> `JevState` via `toJevState(parts, budget)`; budget measured by `stateChars`. |
| compact questions | `Situation.compact` (budget <= 1400): descriptions `null` except vocabulary overrides <= 24 chars. |
| settled point | `RuntimeImpl.settled()`: profiles and invariants learn here. |
| storeWriters | `Map<signature, Map<store, count>>` learned in `onApplied` (writer + up to 8 ancestors). Used by M7, `relatedInFlight`, timeline relevance, `involvedStores`. |

### Key types (abridged)

```ts
// packages/runtime/src/situation/env.ts
type SubjectSpec =
  | { trigger: "mutation"; m: MutationRec }
  | { trigger: "request"; op: OpRec; req: ReqMeta }
  | DeliverySpec                                   // { trigger: "delivery"; op; channel; predicted; matched; conflicts; ... }
  | { trigger: "failure"; op: OpRec; req: ReqMeta; failure: FailureInfo }
  | { trigger: "stall"; op: OpRec; req: ReqMeta }
  | { trigger: "inconsistency"; violations: Violation[] }
  | { trigger: "transition"; op: OpRec; unusual: Unusual[]; shape: Shape }
  | { trigger: "error"; error: ErrorInfo; op: OpRec | null }
  | { trigger: "ask"; about: "now" | number | string };

// packages/runtime/src/situation/conflicts.ts
interface Predicted { patterns: string[]; source: "profile" | "last" | "unknown"; seen: number; of: number }
interface Conflict { path; kind: "newer" | "pending"; writer?: OpRec; pendingOp?: OpRec; count: number; t: number }

// packages/runtime/src/learn/cadence.ts
type CadenceInfo =
  | { kind: "periodic"; period: number; intervals: number; last: number; next: number }
  | { kind: "debounced"; delay: number; matching: number; of: number };
```

`SitEnv` (implemented by `RuntimeImpl.makeEnv`) keeps every member listed before (`now`, `ops`, `hub`, `base`,
`profiles`, `events`, `redact`, `app`, `cached`, `identical`, `lastConsistent`, `consistentBefore`, `storeWriters`,
`recentErrors`, `violations`, `previewInvariants?`, `canCoalesce`, `resyncable`, `writable`, `chainWrites`;
`writtenByChain?` is still declared and never implemented) and adds `lastChain(sig)`, `creates()`, `cadence(sig,
now)`, `outcomes()`, `online()` (`navigator.onLine` when boolean, else undefined).

`BuiltSituation` = `{ spec, draft, situation, actions, facts, parts, salient, standing, forced, subjectRef }`.
`BuildOptions.budget` doc comment now says "default 2,400" (the code default is `STATE_CHAR_BUDGET`).

### Triggers and subjects

| trigger | raised by (file -> symbol) | hold | priority | subject sentence (`subjectOf`) | `SubjectRef` |
|---|---|---|---|---|---|
| `delivery` | `runtime.ts` -> `runDelivery` (from fetch/XHR `host.deliver`, messages `deliverMessage`), only when its pre-filter finds it salient (or `always`) | yes | 2 | response: `The response to <opLabel> arrived and is about to be delivered; <predictedText>.`; message: `A WebSocket message <path> (#id) arrived …` / `A server-sent message …` | `{kind, op, paths?, store?}` (paths = conflicting fields, else matched P fields) |
| `mutation` | default: `observeWrite` (hub hook `observeWrite`, `holdWrites` off); opt-in: `gateMutation` (`policy.holdWrites: true`). Not raised for bypassed writes (`StoreHub.propose`: synchronous user writes unless `holdUserWrites`, GenClass writes, stores with `hold: false`), unholdable writes, or covered writes | default no / opt-in yes | default 1 / opt-in 2 | `A write to <paths>[ from <opLabel(cause)>] is about to be applied.` | `{kind, mutation, store, paths, cause?}` |
| `request` | `observe/fetch.ts`, `observe/xhr.ts` request gate | yes | 2 | `<opLabel(op)> is about to be sent.` | `{kind, op}` |
| `failure` | fetch `failureGate` (hold yes, 2); XHR (hold no, 1) | fetch yes | 2 / 1 | `<opLabel> failed (<HTTP n / timed out / network error>) and the app has not seen the failure yet.` | `{kind, op}` |
| `stall` | `watchStall` timer at `max(4 x median, 2 x p95, 500 ms)` | no | 1 | `<opLabel> has been waiting <secs> for a response.` | `{kind, op}` |
| `inconsistency` | `settled` -> `raiseInconsistency` | no | 1 | `The relation <text>[ (and N more)] no longer holds now that the app is settled.` | `{kind, paths, store?, invariant?}` |
| `transition` | `settled` -> `raiseTransition` | no | 0 | `<opLabel> completed with a state change unlike its usual ones.` | `{kind, op, paths, store?}` |
| `error` | `reportError` | no | 0 | `An uncaught <name> was thrown: <message <= 120>` | `{kind, error, op?}` |
| `ask` | `ask()` / `decide()` / `situation()` | n/a | 1 | `The developer asks about …` | `{kind, op?, store?}` |

`predictedText(s)` (`facts.ts`): `its operation usually writes <fields>` (profile) / `its operation last wrote
<fields>` (last) / `no earlier completion shows which state it writes`; for messages `messages like it usually write
…` / `… last wrote …` / `no earlier message shows which state it writes`. Fields: up to 4, `a, b and c`, then
`(+N more)`; they are normalised patterns (`board.cards.:id`).

Short `Situation.subject`: delivery response `response to <opLabel>`; message `<WebSocket|server-sent> message
<path> (#id) <summary>`; others as before (mutation `write to <paths>[ from <opLabel>]`, request `<opLabel>`,
failure `<opLabel> (HTTP 503 | timed out | network error)`, stall `<opLabel>, waiting <secs>`, inconsistency
`relation <text>…`, transition `<opLabel> state change`, error `<name>: <message <= 80>`, ask `question about …`).

*Subject op* (`subjectOp`): the cause op for `mutation`; the op for request/delivery/failure/stall/transition; the
ambient op for `error`; the asked op for `ask`. *Involved stores*: delivery -> stores of P patterns; others as before
(mutation its store; inconsistency stores of violated fields; transition stores of chain keys; error stores changed
since the op started; request/failure/stall stores this signature's chains wrote; ask the asked store).
*Involved fields*: delivery -> conflicting paths, then matched fields; mutation -> changed paths; inconsistency ->
violated fields; transition -> chain keys.

## How it works

### 1. Baselines (fed by op start/end)

Unchanged in behaviour (verify with `git diff 654d822 b435acb -- packages/runtime/src/learn/baselines.ts`: empty).
1. `RuntimeImpl.startOp`: for fetch/XHR not owned by GenClass -> `Baselines.start(name, t)`; with an identity ->
   `registerIdentity` -> `noteIdentity` (gap EWMA `0.8 * old + 0.2 * gap`, 1024 identities FIFO). **New:** the same
   branch calls `Cadence.note(name, t, { user, userDelay? })` (section 3).
2. `RuntimeImpl.endOp`: for fetch/XHR, not synthetic, not GenClass -> `Baselines.end(sig, t, latency, ok, outcome,
   countsAsFailure)`. **New:** every non-aborted completion is also pushed to `outcomesBuf` (`{t, sig, host:
   hostOfSig(sig), ok: !failure, outcome}`, max 128, 30 s).
3. `Baselines.end`: ignores `"aborted"`; pushes the outcome (`!` prefix on failure, last 20); failure: streak++,
   `lastFailure`, `errEwma = errEwma * 0.9 + 0.1`; non-failure: streak 0, `lastSuccess` only if `ok`, latency pushed
   (last 64). Latency samples never include failures.
4. Reads: `latency(sig)` from 5 samples, nearest rank; `rate(sig, now)` = starts in the last 10 s, `usual` per 10 s
   only when `older >= 3` and the older span >= 20 s; `failureCounts(sig)` over the last <= 20 outcomes. `errEwma`
   is only returned by `snapshot()`, which nothing in `src/` calls.
5. Signatures capped at 1000 (FIFO). In memory only.

### 2. Transition profiles (fed by writes, checked at settled points)

Unchanged rules (`profiles.ts` has no diff). `RuntimeImpl.onApplied` accumulates `op.chain` for the writer and up to
8 PROFILED ancestors (`fetch`, `xhr`, `user`, `task`, `ws`). **New in batch 4:** a change without an `afterLeaf`
(a container that became expanded, or a removed field) is skipped (`if (!c.afterLeaf) continue`), and for non-user
ops `lastChainMap.set(op.name, [...chain keys])` (cap 1000) feeds `SitEnv.lastChain` (delivery prediction, F9
channel marks). At settled points: `shape = shapeOf(...)`, `profiles.check` then `profiles.add`; descendants win
over ancestors; `raiseTransition` with hold false, priority 0. Rarity: `of >= 20 && seen < 0.01 * of`; `set` not
flagged when the usual set is `""`; `writes` not flagged when the usual bucket is `"0"` or a set anomaly exists;
`dur` never checked. Persistence with `learn: { persist: true }` under `localStorage["genclass.profiles.v1"]`.

The profile is now model input twice: transition facts (T1) and the delivery prediction (`predictedWrites` reads
`Profile.wrote`, `Profile.sets[""]`, `Profile.n`), stated in the delivery trigger sentence and in fact D4.

### 3. Cadence (`learn/cadence.ts`, F6)

1. `Cadence.note(sig, t, { user, userDelay? })` from `startOp` for fetch/XHR: `user` = the op has a user ancestor
   (`ops.userOf`); `userDelay = t - user.start` only when the direct cause is a `timer` op (a debounce).
   Background starts (no user): keep the last 9 (`KEEP`). User starts with a delay: keep the last 8 delays.
   `userStarts` is counted but never read.
2. `Cadence.get(sig, now)`:
   - **periodic**: >= 4 background starts; median interval `m >= 250 ms` (`MIN_PERIOD_MS`); >= 75% of intervals
     within +-25% (`TOLERANCE`) of `m`; and the last run is no older than `3 * m` (a stopped schedule is forgotten).
     Returns `{ period: m, intervals, last, next: last + m }`.
   - **debounced**: >= 3 delays; median `m >= 100 ms`; >= 75% within `max(50, 0.25 * m)`.
3. At most 500 signatures (FIFO). In memory only. WebSocket/EventSource ops are not noted.

### 4. Trigger -> triage -> situation (`RuntimeImpl.trigger`)

1. Not consultable (paused, destroyed, no `DecisionProvider`, provider state not `ready`/`off`) -> passive.
2. Cheap pass: `facts = computeFacts(env, spec)`; `forced` = an `always` standing question for the trigger. With
   `triage: "salient"`, not forced and every fact neutral -> passive (no model call, no `Decision`, `lastBuilt`
   untouched).
3. `buildSituation(env, spec, buildOpts(), facts)`. Throws in 2-3 -> logged, passive (fail open).
4. `lastBuilt[trigger] = built`. Not salient and not forced -> passive.
5. Provider not `ready` -> start the lazy load, passive.
6. **Hold only when it can help (batch 4):** `waits = opts.hold && permittedActions(...).length > 0 && !paused &&
   expectedLatency() <= holdBudgetMs()`. `expectedLatency` = median recent provider latency (warm-up time before
   any) x (1 + decisions waiting) + the one computing (at least its elapsed time); `Infinity` while `queue.stuck`.
   If not waiting, passive runs now and the decision is made in the background (deadline 5 s). In the default
   `observe` mode (commit f3636b2, `o.mode ?? "observe"`) no action is permitted, so nothing is ever held; salient
   situations are still built and decided in the background for detection. A `delivery` that does not wait (commit
   054da38): if its chain's writes can still act on their own (`writesCanAct`: discard permitted, not paused, i.e.
   guard/heal with a model too slow to hold for), it is passive and not decided unless forced or `triage: "always"`;
   otherwise (observe, no permitted action) its op goes into `deliveryPending` before `passive()` and the
   background decision covers its chain's predicted writes (`covered`) until it returns.
7. Submit to the decider queue with `ctl.stale` (queued decisions whose subject was superseded are dropped before
   the model sees them), except for a `delivery` that does not wait: its controller is stale as soon as it is
   released, so it gets no stale check and is still decided (detection, reports, standing questions); `onDecision`
   only records it (a released delivery can only take the passive action). Gate/apply:
   [decide-policy-actions](decide-policy-actions.md).

`ask` bypasses `trigger()`. `rt.situation(trigger?)` returns `lastBuilt[trigger]` or an "ask about now" situation
relabelled with the trigger.

### 5. The delivery gate (`RuntimeImpl.runDelivery`)

Called with `{ op, channel, req?, status?, message?, queuedAhead?, body?, bodyNow? }` and a `release` callback
(lets the response/message through). Holding is only latency; the response object is unchanged. `bodyNow` is the
body read synchronously when it is already in memory (WebSocket/EventSource `MessageGate`, XHR `body.now`; fetch
has none).
1. Not consultable, paused, destroyed or a GenClass op -> release.
2. `predicted = predictedWrites(env, op)`, `matched = matchFields(env, predicted.patterns)`, `conflicts =
   conflictsOn(env, op, matched, now)` (per field: newer conflict, else pending conflict; newer first).
3. `op.delivery = { patterns, known: source !== "unknown", salient: newer.length > 0, decided: false }`.
4. `typed` = matched string fields that a user write (outside the op's chain) changed since the op started.
   `always` = `triage: "always"` or an `always` standing question on `delivery`.
5. No conflict, nothing typed, not `always` -> release (no body read, no latency).
5b. Background delivery (commit 054da38): when `deliveryHoldable(op, matched, defers)` is false (observe mode,
   paused, decider not `ready`, no permitted non-passive delivery action or permitted custom action, or
   `expectedLatency() > holdBudgetMs()`), the delivery is released now, before any body read. Steps 6-8 still
   run, but settling marks `overNewer` and, if salient or `always`, calls `trigger(spec, ctl, { hold: false,
   priority: 2 })` (decided for detection only). A `bodyNow` body is analysed synchronously; otherwise the body
   wait is cut short when the delivery's chain is about to write (`finalizeDeliveries` from the hub's `proposed`
   hook): with a newer conflict or `always` it is decided without the body, else it is marked salient and left
   undecided, so its writes get their own `mutation` decisions.
6. No body reader -> salient iff a newer conflict exists.
7. Else read the body (`o.body()`: fetch's buffered clone or XHR text/response; messages' data), wait at most
   `BODY_WAIT_MS = 100` (clock time; on timeout decide as in 6). With a body: `spec.content = analyzeBody(env, op,
   body, matched)`, then salient iff
   - a newer conflict whose field the body would change (`!cmp.same`; a field not located counts as changed), or
   - a pending conflict whose field the body would set back to the value the user's change replaced (F1), or
   - a typed field the body would change (F2).
   All conflicts equal to the body -> custom event `delivery.unchanged` (shows in the timeline as `event
   delivery.unchanged`). Analysis throw -> logged, decide as in 6.
8. Holdable delivery: not salient and not `always` -> release. Else `trigger(spec, ctl, { hold: true, priority: 2 })`
   (which runs the cheap pass again on `computeFacts`).

Controller: `passive` releases; if released over salient conflicts it records `op.delivery.overNewer` (used by F9).
`discard`: releases now and sets `op.discardMark = { protect: conflicting paths, until: now + 10 s }`; while the mark
lasts, `dropFilter` drops each later write of the op's chain to a protected field or to a field written since the op
started by a user action or a newer op (`writtenOver`); other fields of the same write apply. Effect text:
`Delivered <the response to …> and dropped the state changes it makes over newer data (<paths>).`; each drop pushes
an `action` event `dropped the write of <paths> by <opLabel> over newer data[ (its other changes applied)]`; undo
restores the dropped values. `defer`: waits for `relatedInFlight` ops (max 10 s) then runs the gate again with
`defers + 1`; text `Held <what> for <secs> until N related operation(s) finished, then decided again.`.

### 6. `buildSituation(env, spec, o, precomputed?)`

1. `budget = o.budget ?? STATE_CHAR_BUDGET` (2400); `L = sectionLimits(budget)`; subject, subject op, stores.
2. Facts (precomputed or `computeFacts`). Draft adds `delivery: { channel, predicted: patterns, conflicts: paths }`
   and, for a delivery with `req`, the `request` block.
3. Plugin facts: neutral, kind `plugin`, 240 chars; throwing plugins ignored.
4. `orderFacts(facts).slice(0, 12)`.
5. Actions: `TRIGGER_ACTIONS[trigger]` filtered by `builtinApplicable`, descriptions from `actionDescription(name,
   vocab, undefined, trigger)` (vocabulary > custom > `TRIGGER_DESCRIPTIONS[trigger]` > built-in > name); then
   custom `ActionDef`s.
6. Questions (`compact = budget <= 1400`), sections, `toJevState`, `salient`.

#### Applicable built-in actions (`builtinApplicable`)

| trigger | always | conditional |
|---|---|---|
| delivery | `deliver`, `discard` | `defer` iff `defers < 2` and `relatedInFlight(env, op, matched)` is non-empty (in-flight non-user ops outside the op's chain with the same name, or whose signature's chains wrote a store of the matched fields) |
| mutation | `apply`, `discard` | `defer` iff `m.defers < 2` (with `holdWrites` off a `defer` is recorded only: nothing is held) |
| request | `send`, `delay`, `block` | `coalesce` iff fetch and `canCoalesce`; `serve_cached` iff GET and cached |
| failure | `deliver` | `retry` iff replayable, `attempt < 4`, fetch; `serve_cached` iff GET, cached, fetch |
| stall | `wait` | `hedge` iff idempotent GET, replayable, fetch; `serve_cached` iff GET, cached, fetch |
| inconsistency | `ignore` | `rollback` iff a consistent snapshot exists and an involved store is writable; `resync` iff a store has a resync handler |
| transition | `ignore` | `rollback` iff `revertableChain(op)`; `resync` iff a chain store is resyncable |
| error | `ignore` | `rollback` iff an ambient op and `revertableChain(op)` |
| ask | (none) | |

#### Section builders (`build.ts`, unchanged)

- **`inFlightLines`**: in-flight non-user ops except the subject op, sorted by (same signature, same root, other),
  then start; line `<opPhrase <= 80> (#id) <secs> so far[, by #cause]`.
- **`timelineLines`**: last 96 events through `eventLine`; relevant = user/error/action/nav, state events of
  involved stores, op events of the subject's chain, signature or store writers; last `L.timeline` relevant lines,
  topped up with recent non-relevant ones.
- **`stateLines`**: involved fields first, then involved stores' fields by recency; `<path> = <describe 90> (v<n>[,
  by #w] <secs> ago)`; a store with `opts.describe` gives one line.
- **`statsLines`**: the subject op's signature (fetch/xhr/ws/task) + in-flight fetch/xhr; `<sig>: <count> done[,
  median, p95], <failed> of last <of> failed, <recent> in last 10s[ (usual …)]`.

### 7. `describe.ts` phrasing and change texts

`describe.ts` is unchanged (`opLabel`, `opPhrase`, `userPhrase`, `statusText`, `eventLine`; see the table in
[observe-and-trace](observe-and-trace.md) for event kinds). New timeline content reaching the model: message
events `event ws.message <summary> (#id)` / `event sse.message …`, `event delivery.unchanged (#id)`, and GenClass
`action` lines from delivery `discard`/`defer` and drops.

`changeText(c, redact)` (`state/fields.ts`) gained one branch before the generic `<describe 36> → <describe 36>`:
two strings whose redaction leaves them unchanged (`redactedStringDiff`, shared with F2 since commit f107013) and
at least one longer than 30 chars use `stringDiff`: both sides
previewed from 14 chars before the first difference, 30 chars wide, plus `(removes "…")`, `(inserts "…")` or
`(replaces "…" with "…")` (each <= 28 chars). Example asserted in `test/content.test.ts`: `"…e sword shield market
lib" → "…e sword shield" (removes " market lib")`. This changes timeline write summaries, M15 deltas and I2 too.

Formatters (`util.ts`) are unchanged: `secs` (2 decimals < 10 s, 1 < 1000 s, else integer), `fmtNum`, `ratio`,
`truncate` (`n - 1` chars + `…`), `plural`, `ordinal`, `describe` (strings quoted 48/24 chars, arrays `N items [a,
b, c, …]`, objects with id-like keys first). `describe` now compares the redactor result with `Object.is` (a `NaN`
value is no longer treated as redacted; the NaN fix, commit ad24804).

### 8. Facts catalogue (`facts.ts` -> `computeFacts`)

**Salient** = `neutral: false`. Helpers: `provenance` (`<What> comes from <opLabel>, started <secs> ago[, ended <secs>
ago with <status>][; its chain began with <opLabel(root)>].` or `… has no known cause: no operation was active when it
started.`), `writerOpText`, `times` (once/twice/N times). The F-numbers are SIM's separability proposals
(`sim/SEPARABILITY.md` §6) as named in `packages/runtime/STATUS.md`.

#### Shared building blocks (used by mutation and delivery)

`versionFacts(env, X, paths, ref, now)` (X = the write's cause or the delivering op; `ref` = `this write's cause
(#C)` / `its operation (#X)` / `this message (#X)`), per path (side effect `X.reads.set(path, vStart)`):

| id | kind | salient when | text |
|---|---|---|---|
| V-pending | versions | always (emitted only for a pending conflict) | `<path> has a pending local change: <opLabel(user)> wrote it <secs> ago and its <opLabel(pending)> is still in flight; <ref> started after (or before) that user action.` |
| V-others (old M2) | versions | iff `newerConflict(env, X, path)` | `<path> was written <times> by other operations since <ref> started (version a → b), last <secs> ago by <writer>.` |
| V-own (old M3) | versions | never | `<path> was written <times> by <ref>'s own chain since it started (version a → b).` |
| V-none (old M4) | versions | never | `<path> has not changed since <ref> started (version v).` (omitted when V-pending was emitted) |

`movedFacts` (old M5, **always neutral now**): up to 2 other fields (any store; fields of the given stores first,
then fields a user wrote, then the most recently written) changed by other chains since X started (`… changed since <ref> started: <before> → <now>[ (n writes)], last by <opLabel> <secs> after #X
started.` / `… changed <times> … (now v)` / `… and is back to v`). `concurrencyFacts` (**always neutral**, user ops
excluded): M6 `<N> other <X.name> operation(s) is/are in flight (<k> newer than <ref>): #id <detail> started …` and,
per store (up to 2), M7 `<opLabel> is in flight and its chain wrote <store> <times> before[ (n more such ops in
flight)].`

#### mutation (`mutationFacts`), in emission order

| id | kind | salient when | condition and text |
|---|---|---|---|
| M1 | provenance | never | provenance of `This write` |
| V-* | versions | see above | with a cause `C`: `versionFacts` over the first 3 written paths |
| F1/F3 (write) | versions / delta | F1 yes | `contentFacts(env, C, cmps, "This write")` over the first 6 changes that have an after-leaf (see content facts) |
| RYW | versions | always | `rywFacts` over array changes, loaded by `netOf(C)` (nearest fetch/xhr/ws op up the cause chain) |
| F6 | baseline | never | `cadenceFact` for `netOf(C)` when it is not a user op |
| M5 | inputs | never | `movedFacts(env, C, written, [m.store])` |
| M6, M7 | concurrency | never | `concurrencyFacts(env, C, [m.store])` |
| M8 | baseline | `lat > 3 x median` and `lat - median >= 100 ms` | `This write's cause (#C) took <secs>, <ratio> its usual <median> (p95 <p95>).` |
| M9 | outcome | never | `This write's cause (#C) failed (<status>) before this write.` |
| M10 | versions | always | **no cause only:** `pendingConflict(env, null, path)` for the first 3 paths: `… has a pending local change: …; this write has no known cause.` |
| M11 | outcome | never | `This write could not be held: <reason>.` (unreachable, see Drift) |
| F9 | versions | never | `markFacts(env, written)` (max 2) |
| F7 | repetition | never | before M12, when the two identical changes come from separate user actions: `repeatEvidence` |
| M12 | repetition | some change is additive | `An identical change to <paths> (<delta>) was applied …` |
| M13 | concurrency | never | `<N> earlier write(s) to <store> is/are still waiting for a decision.` (only with `holdWrites`) |
| M14 | invariant | never | `Applying this write would break the learned relation …` (2 max) |
| M15 | delta | never | `This write would change <path>: <changeText>.` (first 3) |
| M16 | outcome | never | `This write was already deferred <times>.` |

#### delivery (`deliveryFacts`), in emission order

| id | kind | salient | text |
|---|---|---|---|
| D1 | provenance | never | response: `The response to <opLabel(X)> arrived after <secs>[ (<status>)][ and was held <times> already]; the app has not seen it yet.`; message: `A WebSocket|server-sent message (#id) <summary> arrived on <path>[ and was held …]; the app has not seen it yet.` |
| D2 | provenance | never | response with a cause: provenance of `This request` |
| D3 | concurrency | never | message with `queuedAhead`: `<N> earlier message(s) of this channel is/are held ahead of it (order is kept).` |
| D4 | transition | never | profile prediction only: `In <of> earlier completions of <X.name> its chain wrote <fields> (<seen> of <of> wrote state).` |
| V-* | versions | see above | `versionFacts` over conflicting paths, then matched fields written since X started (first 3) |
| F1-pending | versions | always | `pendingRevertFacts` (max 2): `<The response|This message> has <path> = <v>, the value before <user op> changed it to <v'> <secs> ago (its <pending op> is still in flight); delivering it would undo the user's change.` |
| F1/F2/F3 | see content | | `contentFacts(env, X, content.cmps, subject, now, { fields: matched })` |
| RYW | versions | always | lists located in the body, `fromResponse` (`This response's list …`) |
| F9 | versions | never | `markFacts` over conflicting + matched fields |
| F6 | baseline | never | `cadenceFact(env, X.name)` |
| M5, M6, M7 | inputs / concurrency | never | `movedFacts` / `concurrencyFacts` over the stores of the matched fields |
| D5 | baseline | never | `<sig> usually answers in <median> (p95 <p95>).` (response with a latency baseline) |
| D6 | outcome | never | `The <N> <sig> request(s) before this one failed in a row.` (`failStreak > 0`) |

Content facts need `spec.content` (or `spec.body`): the body is read only for candidates (a conflict, typed text or
`always`, see section 5), so a delivery that reaches the model without a body reader or after the 100 ms body
timeout has no F1-F3/RYW content facts.

#### content facts (`content.ts`)

`analyzeBody(env, X, body, fields)` indexes the body (`indexBody`: max 20,000 nodes, depth 8, 2,000 items per array,
at most 64 objects outside arrays) and locates each of the first 32 fields (`locate`): (1) by item id (a path segment,
searched from the leaf up, that equals the `id`/`_id`/`uuid`/`slug`/`key` value of a body object; the first segment
after the store name only when it is id-like or has a digit; all candidates must agree by value hash); (1b) a keyed update object
(`{card: "c1", col: "done"}` for `board.cards.c1`); (2) the longest key-path suffix outside arrays; (3) the one body
array of compatible items (same id key or >= 50% shared keys; most shared ids wins); (4) a primitive body for a
primitive store. Ambiguous or kind-incompatible -> not located (no fact). `noChange` = every field located and
equal.

`contentFacts` (at most 3 shown, conflicts first; subject `The response` / `This message` / `This write`):

| fact | kind | salient | text |
|---|---|---|---|
| F1 item cell | versions | yes | `<S> would put back <key> = <v> for item <id> of <path>[ and N more cells]: the store has <cur>, changed since #X started; delivering (applying) it would undo that change.` |
| item newer-same | versions | no | `The newer writes to <path> changed only N item(s) (<ids>); this response's copy of it/them equals the store.` |
| item join delta | delta | no | `Joined by <idKey> with <path>, <s> would change N cell(s) in M item(s), add …, remove ….` |
| F2 | versions | yes | `<S> would replace text the user typed into <path> after #X started (N user write(s), the last <secs> ago): <stringDiff text or a → b>.` The diff comes from `redactedStringDiff` (only when both values pass the redactor unchanged), else both sides go through `describe()` (`[redacted] → [redacted]`, or a custom redactor's replacement); before commit f107013 it diffed the raw strings and leaked characters of a redacted field. |
| F1 field | versions | yes | `<S> has <path> = <v>, the value that <writer> replaced with <v'> <secs> ago[ (it started after/before #X)]; delivering (applying) it would put the older value back.` |
| third value | versions | no | `<S> has <path> = <v>: neither the current value <cur>[, nor the value when #X started].` |
| F3 | delta | no | `<S> matches the current values of everything it is predicted to write (<list>): delivering it changes nothing.` or `<S> has the current value of <list>.` |

`rywFacts` (read-your-writes, max 2, creates of the last 10 s, `RYW_WINDOW_MS`, first 5 ids each, shape fit >= 40%
shared keys): `<path> contains item "<id>" twice|N times; <opLabel(create)> created item "<id>" <secs> ago (<status>).`
or `<path> was loaded by <opLabel>, which started <secs> after <opLabel(create)> created item "<id>" … , and does not
contain it.` Both salient. Also used by inconsistency and transition facts (`storeLists`).

#### evidence facts (`evidence.ts`, all neutral)

- **F9** `markFacts`: `<path> holds a value written <secs> ago <why>; nothing has rewritten it since.` Marks come from
  `RuntimeImpl.markWrites` (on every applied write by a non-GenClass writer, checking the writer and 8 ancestors):
  `by the response to <op>, which was delivered over newer data from|a pending local change of <writer>` (`by the
  message <op>, …` when the op is a WebSocket/EventSource message); `by the response to <op>, which took <secs> (<ratio> its usual <median>)` (ok, `>= 5 x median` and `>= 300 ms` over it);
  `after <op> failed (…), although the server may have applied it` (ambiguous commit). And from
  `RuntimeImpl.onChannel` when a WebSocket/EventSource channel comes back up: fields last written by that channel's
  messages before it went down get `by WebSocket|server-sent messages on <path>; the channel then was down for <secs>
  (<how>), so updates sent meanwhile may be missing`. Used in mutation, delivery, inconsistency, transition, error.
- **F6** `cadenceFact`: `<sig> runs on a schedule: every <period> (last N intervals); the next run is due in <secs>|<secs>
  overdue.` or `<sig> is usually sent <delay> after the user's last input (k of the last n): a later edit is followed
  by a new request.` Used in mutation, delivery, failure, stall.
- **F5** `scopeFacts` (failure, stall): same host (`hostOfSig`: `same-origin` or the host of a cross-origin
  signature), other signatures, last 10 s: `N other endpoint(s) of this origin|<host> failed in the last 10s (N
  failure(s), latest: <sig> <outcome>, …)[; N other request(s) succeeded].` or `The other endpoints of … answered
  normally in the last 10s (…).`; plus `The browser reports that it is offline (navigator.onLine is false).`
  `commitAmbiguity` (failure, non-GET/HEAD/OPTIONS): 502/503/429/408 -> `… a status servers and gateways usually
  return without processing the request.`; other 4xx -> none; 5xx or network/timeout faster than half the usual
  latency -> `… well before its usual …`; otherwise `…: the server may have applied it before failing.` /
  `…: the server may have received and applied it.` (ambiguous; also drives F9 marks).
- **F7** `repeatEvidence(env, u1, u2, firstReq?)`: `User actions #a and #b, <secs> apart: both are <kind>s on
  <target>; the browser counted #b as click N of a multi-click (MouseEvent.detail); the request of #a (#r) was still
  in flight at #b; between them the app wrote <fields> | the app changed no state between them.` Emitted next to R3
  (request/failure/stall) and M12 when the two come from separate user actions.

#### request / failure / stall

`requestCommon` (R1-R11) is unchanged except that R3, when the two requests come from separate user actions, is
preceded by an F7 fact. Salience: R3 on `request` only when `close`; R5 on `request` only when `failStreak >= 2`; R7
when `recent >= 5` and `>= 3 x usual` (all three triggers). **failure** = F1 (outcome, salient), F2 streak, F3
chain writes, then commit ambiguity, F5 scope/offline, F6 cadence, then R1-R11. **stall** = S1 (salient), S2, F5
scope/offline, F6 cadence, then R1-R11 (R9 omitted).

#### inconsistency, transition, error, ask

- **inconsistency**: I1 (salient) and I2 per violation as before; then **new** F9 marks and RYW over the violated
  fields; then I3 last consistent state, I4 in-flight count.
- **transition**: T1 (salient) per `Unusual`, T2 provenance, T3 baseline, T4 `is now`; **new** F9 marks and RYW over
  the concrete fields matching the chain keys (`matchFields`); then T5.
- **error**: E1 (salient), E2/E3 (with ambient op; **new** F9 marks over the chain's written paths after E3) or E4,
  E5, E6.
- **ask**: unchanged (all neutral).

**Ordering** (`orderFacts`, unchanged): non-neutral first, then `RANK` (invariant/transition/error 0, versions 1,
repetition 2, inputs 3, outcome 4, baseline 5, concurrency 6, provenance 7, request 8, cache 9, delta 10, plugin 11),
then emission order. D4 has kind `transition` (rank 0), so among neutral delivery facts it comes first.

### 9. Triage: exact salience conditions

A trigger reaches the model iff the runtime is consultable, the provider is `ready`, and one of: `triage:
"always"`; trigger `ask`; a `forced` standing question; or a non-neutral fact. Per trigger:
- **delivery**: first the `runDelivery` pre-filter (section 5) must pass; then a non-neutral fact: V-others with a
  newer conflict, V-pending, F1 (field, cell or pending revert), F2, RYW. A pending conflict whose body showed a third
  value, or whose body could not be compared (no body reader, the 100 ms timeout, a non-JSON or > 256 KB body, an
analysis throw), is released by the pre-filter even though V-pending would be non-neutral; only newer-data
conflicts decide in those fallback cases.
- **mutation** (only when not covered): V-others with a newer conflict, V-pending (cause op present) or M10 (no
  cause), F1 / F2 on the write's own value, RYW, M8, M12 additive. **No longer salient:** M5 inputs that moved, M6
  same-signature op in flight, a plain user write.
- **request**: R3 `close`, R5 streak >= 2, R7 hot rate.
- **failure, stall, inconsistency, transition, error**: always (F1, S1, I1, T1, E1).

Plugin facts are always neutral and computed only after the cheap pass. The sim runs `triage: "salient"`, so sim
decision rows exist only for salient situations; changing triage changes the training distribution.

### 10. Questions (`questions.ts`)

- `diagnosis` (all triggers but `ask`): `What is happening here?` over `DEFAULT_DIAGNOSES` (expected, stale,
  conflict, duplicate, inconsistent, failing, slow, overload, unusual, transient; unchanged) or the vocabulary.
- `action` (only with > 1 applicable action): `ACTION_INSTRUCTIONS[trigger]`; descriptions via `actionDescription`.
- Compact (budget <= 1400): bare labels except vocabulary overrides <= 24 chars.

| trigger | `TRIGGER_ACTIONS` (passive first) | `ACTION_INSTRUCTIONS` |
|---|---|---|
| mutation | apply, discard, defer | What should the runtime do with this write? |
| request | send, coalesce, delay, block, serve_cached | What should the runtime do with this request? |
| delivery | deliver, discard, defer | What should the runtime do with this response or message? |
| failure | deliver, retry, serve_cached | What should the runtime do with this failed request? |
| stall | wait, hedge, serve_cached | What should the runtime do with this slow request? |
| inconsistency | ignore, rollback, resync | What should the runtime do about this inconsistent state? |
| transition | ignore, rollback, resync | What should the runtime do about this unusual state change? |
| error | ignore, rollback | What should the runtime do about this error? |
| ask | (none) | `""` |

`BUILTIN_ACTIONS` descriptions and tiers are unchanged (apply, discard, defer, send, coalesce, delay, block,
serve_cached, deliver, retry, wait, hedge, ignore, rollback, resync). `TRIGGER_DESCRIPTIONS.delivery` overrides
three of them for `delivery` only: deliver "pass it to the application now"; discard "deliver it but drop the state
changes it would make over newer data"; defer "hold it until the related in-flight operations finish, then decide
again". Tiers stay the built-in ones (deliver passive, discard guard, defer guard).

### 11. Serialiser (`serialize.ts` -> `toJevState`)

Algorithm unchanged; only the full budget moved from 3200 to 2400 (`r = clamp((b - 1100) / (2400 - 1100), 0, 1)`).
Over budget: drop timeline (oldest first), then state, facts (keep >= 1), in_flight, stats; then shorten facts and
the trigger (floor 60 chars).

| budget | facts | in_flight | timeline | state | stats | line limits app / trigger / facts / in_flight / timeline / state / stats |
|---|---|---|---|---|---|---|
| 500-1100 | 6 | 2 | 3 | 3 | 1 | 60 / 180 / 220 / 90 / 100 / 100 / 110 |
| 1200 (auto floor after overflows) | 6 | 2 | 4 | 3 | 1 | 65 / 185 / 223 / 92 / 103 / 104 / 112 |
| 1333 (WASM 2 threads) | 7 | 3 | 5 | 4 | 2 | 71 / 191 / 227 / 95 / 107 / 109 / 115 |
| 1400 (compact-questions edge) | 7 | 3 | 6 | 4 | 2 | 74 / 194 / 229 / 97 / 109 / 112 / 117 |
| 1667 (WASM 3 threads) | 9 | 4 | 9 | 5 | 2 | 86 / 206 / 237 / 103 / 117 / 122 / 123 |
| 1750 (tested) | 9 | 4 | 10 | 6 | 3 | 90 / 210 / 240 / 105 / 120 / 125 / 125 |
| 1920 (WebGPU after 1 overflow) | 10 | 5 | 11 | 6 | 3 | 98 / 218 / 245 / 109 / 125 / 132 / 129 |
| 2000 (WASM 4 threads) | 10 | 5 | 12 | 6 | 3 | 102 / 222 / 248 / 111 / 128 / 135 / 131 |
| 2400+ (WebGPU) | 12 | 6 | 16 | 8 | 4 | 120 / 240 / 260 / 120 / 140 / 150 / 140 |

`test/budget.test.ts` asserts the counts at 1100, 1750, 2400, 3200 (= 2400) and 500 (= 1100); the other rows and all
line limits are computed from the formula. A budget above 2400 keeps full section counts but allows more characters
(the sim and realapps still sample 3200, see Drift).

### 12. Redaction

`defaultRedact` now uses `isSensitivePath(path, value)` (`util.ts`), batch 5, plus the post-0.1.0-alpha.1 fix
(commit f107013, `packages/runtime/STATUS.md` "Fix after 0.1.0-alpha.1: two redaction leaks"):
- Never secret: `null`, `undefined`, booleans; plain objects (judged key by key, never redacted whole).
- Not a dotted path (free text such as `input "Card number"`, header lines) -> `isSensitiveName` on its words.
- Array-index segments are skipped (`users.3.password`). The **leaf** segment decides (`isSensitiveName`), or a
  secret pair across the last two segments (`payment.card.number`).
- A non-leaf container that names a secret: strings, numbers, bigints and arrays under it are secret if the
  container is not "broad" (`payment.cvv.value = 123`, `login.otp.code`, `lock.pin.value`,
  `account.password.history = [...]`; before the fix only strings); under a broad container (`auth`,
  `authorization`, `cookie`, `session`) only opaque credential-looking strings (`OPAQUE`:
  >= 20 chars of letters, digits and `_-.+/=:`, containing both a letter and a digit) are secret.
- A store holding a primitive is judged by its name (its name is the leaf). The container rule above also covers the
  store segment: a broad store name never redacts its fields (`auth.loading`, `auth.user.name` visible), but a
  store or container named by a non-broad secret word (`token`, `secret`, `password`, ...) redacts every string,
  number, bigint and array leaf under it (`credentials.password.value`). Side effect: numbers under a container
  that is a secret word in another sense are hidden too (`map.pin.lat`, `boarding.pass.seat`). The code comment
  ("never by the store's or a container's name alone") describes the broad case only.
- Known gaps (unchanged, they would change other model-visible text): a container named by a secret pair
  (`cardNumber`, `apiKey`, `creditCard`) counts as broad, so `payment.cardNumber.value` is shown; the "is back to V"
  fact (`situation/facts.ts`) compares rendered text, so two different redacted values read as "back to
  [redacted]".
`isSensitiveName` (word lists `SECRET_WORDS`, `SECRET_PAIRS`) is unchanged but now memoised (`nameCache`, cleared
above 4096 entries). `describe` and `redactSearch` compare with `Object.is`. A custom `redact` option replaces the
default everywhere; `opts.describe` output bypasses it. Every diff-centred string preview (`changeText`, F2) goes
through `state/fields.ts` -> `redactedStringDiff`, so a redacted value is never diffed.
Training parity: sim and realapps rows are rendered by the runtime and follow automatically; the Python port
`training/curriculum/rt.py` has no redactor at all and was not changed (secret-looking curriculum names such as
`iban`, `pin`, `pass` print in the curriculum but render as `[redacted]` in the runtime; a curriculum follow-up,
see `packages/runtime/STATUS.md`).

### 13. Device-sized situations (`RuntimeImpl.situationBudget`)

Numeric `situation.budget` -> as is. `"auto"` (default): WASM `1000 + round((min(4, max(1, threads)) - 1) * 1000 / 3)`;
otherwise (webgpu or unknown) `STATE_CHAR_BUDGET` = 2400; times `budgetScale` (x0.8 per `max_tokens_exceeded`,
floor 0.5; per instance, never resets; not applied to numeric budgets). Examples: 2400 -> 1920 -> 1536 -> 1229 ->
1200; WASM 1 thread 1000 -> 800 -> 640 -> 512 -> 500. Training budgets: the sim samples 3200/2000/1000 at 40/30/30
(`sim/src/world/scenario.ts`), realapps the same (`realapps/src/harness/scenario.ts`), the Python curriculum
2400/2000/1667/1333/1000 at 35/20/5/5/35 (`training/curriculum/rt.py` -> `BUDGETS`, override `GC_RT_BUDGET`).

### 14. Annotated examples (copied from `packages/runtime/STATUS.md`, produced by the tests)

**A. delivery at a 1000-char budget (compact; `test/budget.test.ts`, 951 chars).**

```
app: /search
trigger: The response to GET /api/search?q=rea (#6) arrived and is about to be delivered; its operation last wrote search.results.
facts:
  search.results was written twice by other operations since its operation (#6) started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later user action (#7).
  The response has search.results = 2 items ["rea-1", "rea-2"]: neither the current value 2 items ["reac-1", "reac-2"], nor the value when #6 started.
  search.query changed since its operation (#6) started: "rea" → "reac", last by user typed "reac" into input "Search" (#7) 0.09s after #6 started.
  The response to GET /api/search?q=rea (#6) arrived after 0.90s (200); the app has not seen it yet.
  This request comes from user typed "rea" into input "Search" (#5), started 0.90s ago.
in_flight: none
timeline: none
state: none
stats:
  GET /api/search: 4 done, 0 of last 4 failed, 4 in last 10s
questions:
  diagnosis: What is happening here? expected | stale | conflict | duplicate | inconsistent | failing | slow | overload | unusual | transient
  action: What should the runtime do with this response or message? deliver | discard
```

- Typeahead: four keystrokes; the `rea` response (#6, 900 ms) arrives after the newer `reac` (#8). In-order
  responses never asked (`situation.test.ts` asserts exactly one delivery call). P comes from `last` (the trigger
  says `last wrote`, so no profile for the signature existed yet), hence no D4 fact.
- Fact 1 is V-others, salient: #8 started after #6, is outside #6's chain, no newer `GET /api/search` is in flight.
  Fact 2 is the neutral third-value content fact (the body was read because the delivery was a candidate). Fact 3 is
  M5 (neutral now). Then D1, D2 (provenance, rank 7).
- `defer` is not offered (nothing related in flight). Over budget, timeline and state were dropped entirely.

**B. delivery: a WebSocket message that would revert a pending local change (full budget, `test/delivery.test.ts`).**

```
trigger: A WebSocket message /live (#5) arrived and is about to be delivered; messages like it last wrote board.cards.:id.
facts:
  board.cards.c1 has a pending local change: user clicked button "Move c1 to done" (#3) wrote it 0.05s ago and its PATCH /api/cards/c1 {col: "done"} (#4) is still in flight; this message (#5) started after that user action.
  This message has board.cards.c1 = "todo", the value before user clicked button "Move c1 to done" (#3) changed it to "done" 0.05s ago (its PATCH /api/cards/c1 {col: "done"} (#4) is still in flight); delivering it would undo the user's change.
  A WebSocket message (#5) {n: 2, card: "c1", col: "todo"} arrived on /live; the app has not seen it yet.
```

- The value was located by the keyed-update rule (`{card: "c1", col: "todo"}` for `board.cards.c1`). A message with a
  third value (`"review"`) is released without a model call (the pending PATCH decides; second WebSocket test). P is
  the normalised pattern `board.cards.:id`, so while `c1` is pending every message on this channel is a candidate
  (c1's pending conflict is on a matched field): a message about `c2` only (#3 in the first WebSocket test) still
  has its body read, `c1` is not located in it, and it is released with no decision. STATUS.md "Open issues" says
  such a message "is salient too"; with the batch-5 body rule it only pays the body read.

**C. mutation not covered by a delivery (full budget, `test/situation.test.ts`; facts only).**

```
trigger: A write to profile.name from task load profile (#1) is about to be applied.
facts:
  profile.name was written once by other operations since this write's cause (#1) started (version 0 → 1), last 0.30s ago by task save profile (#2), which started 0.10s after #1.
  This write has profile.name = "Ada (cached)": neither the current value "Grace", nor the value when #1 started.
  profile.saved changed since this write's cause (#1) started: 0 → 1, last by task save profile (#2) 0.10s after #1 started.
  This write comes from task load profile (#1), started 0.40s ago.
  This write would change profile.name: "Grace" → "Ada (cached)".
```

- Tasks are not network ops, so no delivery gate covers the write; with `holdWrites` off the write applies at once
  and the model's `discard` becomes a late revert (the test asserts `late: true` and the final value `Grace`).

**D. failure with F5 scope, commit ambiguity and F6 cadence (full budget, `test/content.test.ts`; facts only).**

```
trigger: POST /api/orders {} (#8) failed (HTTP 500) and the app has not seen the failure yet.
facts:
  The request #8 failed: HTTP 500 after 0.60s; the app has not seen the failure yet.
  This is the 1st POST /api/orders failure in a row (recent outcomes: 201, 201, 201, 201, 500; last success 0.80s ago); error rate 17% over 6 requests (1 failed).
  This POST failed with HTTP 500 after 0.60s (usual 0.50s): the server may have applied it before failing.
  2 other endpoints of this origin failed in the last 10s (2 failures, latest: GET /api/a 500, GET /api/b 503).
  The browser reports that it is offline (navigator.onLine is false).
  POST /api/orders runs on a schedule: every 0.60s (last 5 intervals); the next run is due in 0.00s.
  POST /api/orders was requested 6 times in the last 10s (no usual rate learned yet).
  POST /api/orders usually answers in 0.50s (p95 0.50s, 5 samples); error rate 17% over 6 requests (1 failed).
  This request has no known cause: no operation was active when it started.
  POST is not idempotent; its body (2 bytes) can be replayed.
```

- Only F1 is salient; the outcome facts (F2, commit, scope, offline) follow in emission order (all rank 4), then
  baselines (5), provenance (7), request (8).

**E. request with F7 (full budget, `test/situation.test.ts`; facts only).**

```
trigger: POST /api/orders {items: [1], cardNumber: [redacted]} (#4) is about to be sent.
facts:
  1 identical POST /api/orders request in the last 10s: #2 in flight (started 0.12s ago); #2 started 0.12s before this one; they come from separate user actions 0.12s apart.
  User actions #1 and #3, 0.12s apart: both are clicks on button "Place order"; the request of #1 (#2) was still in flight at #3; the app changed no state between them.
  This request comes from user clicked button "Place order" (#3), started 0.00s ago.
  POST is not idempotent; its body (52 bytes) can be replayed.
```

STATUS.md also has full-budget examples for F1 item cells, F2 autosave over typed text, a polled failing endpoint,
stall, inconsistency, transition and error.

## Configuration and constants

| name | type | value | defined in | effect |
|---|---|---|---|---|
| `LAT_WINDOW` / `START_WINDOW` / `WINDOW_MS` | const | 64 / 128 / 10000 | `learn/baselines.ts` | latency samples, start times, rate window |
| `ERR_ALPHA` / `MIN_LAT_SAMPLES` / `OUTCOMES` / `MAX_SIGS` | const | 0.1 / 5 / 20 / 1000 | `learn/baselines.ts` | EWMA (unused), latency baseline minimum (also gates stalls), outcomes kept, signatures |
| `MIN_COMPLETIONS` / `RARE` / `MAX_SETS` / `MAX_FIELDS` | const | 20 / 0.01 / 64 / 128 | `learn/profiles.ts` | rarity rule and caps; 2000 profiles (inline) |
| `KEEP` / `MAX_SIGS` / `TOLERANCE` / `MIN_PERIOD_MS` | const | 9 / 500 / 0.25 / 250 | `learn/cadence.ts` | cadence history, signatures, interval fit, smallest period |
| cadence thresholds | inline | periodic >= 4 starts, >= 75% fit, stale after 3 periods; debounced >= 3 delays, median >= 100 ms, fit `max(50, 25%)` | `Cadence.get` | F6 |
| `PENDING_WINDOW_MS` | const | 10000 | `situation/conflicts.ts` | pending-local-change window |
| `MAX_MATCHED` | const | 64 | `situation/conflicts.ts` | matched fields per delivery |
| `ITEM_ID` | const | id, _id, uuid, slug, key | `situation/content.ts` | item id keys for joins/locating |
| `MAX_NODES` / `MAX_DEPTH` / `MAX_ITEMS` | const | 20000 / 8 / 2000 | `situation/content.ts` | body index bounds |
| `RYW_WINDOW_MS` | const | 10000 | `situation/content.ts` | creates considered by RYW |
| `parseJsonBody` max | default arg | 256 KB | `situation/content.ts` | bodies larger or non-JSON are ignored |
| analyzed fields / shown content facts | inline | 32 / 3 | `analyzeBody` / `contentFacts` | bounds |
| `SCOPE_MS` | const | 10000 | `situation/evidence.ts` | F5 window |
| `NOT_PROCESSED` | const | 502, 503, 429, 408 | `situation/evidence.ts` | statuses that mean "not applied" |
| `BODY_WAIT_MS` | const | 100 | `runtime.ts` | max wait for a delivery body |
| `DISCARD_MARK_MS` | const | 10000 | `runtime.ts` | how long a delivery `discard` keeps dropping writes |
| `LONG_RUNNING_MS` | const | 10000 | `runtime.ts` | also the max wait of delivery `defer` (`waitOps`) |
| `BACKGROUND_DEADLINE_MS` / `LATE_REVERT_MS` | const | 5000 / 2000 | `runtime.ts` | background decision deadline; late revert window |
| creates / outcomes buffers | inline | 16 entries, 30 s / 128 entries, 30 s | `noteResponse` / `endOp` | RYW, F5 |
| `lastChainMap` cap | inline | 1000 signatures | `onApplied` | `SitEnv.lastChain` |
| F9 slow mark | inline | ok, `>= 5 x median` and `>= 300 ms` over it | `markWrites` | stale mark |
| delivery `defer` limit | inline | `defers < 2` | `builtinApplicable` | at most two defers |
| covered walk | inline | 16 causes | `covered`, `dropFilter` | how far up the chain a delivery is looked for |
| `STALL_MIN_MS` / `PROFILED` / `PROFILE_KEY` | const | 500 / fetch, xhr, user, task, ws / `genclass.profiles.v1` | `runtime.ts` | unchanged |
| `MAX_FACTS` / `WINDOW` | const | 12 / 10000 | `situation/facts.ts` | facts kept; repetition window |
| `STATE_CHAR_BUDGET` | const | **2400** (was 3200) | `situation/serialize.ts` | full budget, default; comment: ≈ 2.4 chars/token measured, ≈ 1,000 tokens |
| `COMPACT_BUDGET` / `MIN_BUDGET` | const | 1100 / 500 | `situation/serialize.ts` | compact limits; smallest budget |
| `LIMITS` | const | facts 12, in_flight 6, timeline 16, state 8, stats 4 | `situation/serialize.ts` | full counts |
| `COMPACT_QUESTIONS_BUDGET` / `COMPACT_DESC_MAX` | const | 1400 / 24 | `situation/questions.ts` | compact questions |
| auto budget | fn | webgpu/unknown 2400; wasm 1000/1333/1667/2000 | `RuntimeImpl.situationBudget` | device sizing |
| `budgetScale` | field | x0.8 per overflow, floor 0.5 | `RuntimeImpl` | shrinks auto budgets |
| `stringDiff` width | default arg | 30 chars, 14 before the difference, change text 28 | `state/fields.ts` | long string previews |
| `OPAQUE` / `WEAK_CONTAINER` | const | >= 20 credential-like chars / auth, authorization, cookie, session | `util.ts` | container redaction rules |
| `policy.holdWrites` | option | false | `PolicyOptions.holdWrites` | true restores held `mutation` triggers (`gateMutation`) |
| `mode` | option | `"observe"` (was guard; commit f3636b2) | `InitOptions.mode` (inherited by `CreateOptions`); default applied in the `RuntimeImpl` constructor | observe never holds or acts; decisions still made for detection |
| `triage`, `situation.budget`, `learn.persist`, `redact`, `vocabulary`, `historySize`, `settleMs`, `app` | options | as before | `InitOptions` / `CreateOptions` | see [public-api-and-lifecycle](public-api-and-lifecycle.md) |
| `observe.eventsource`, `observe.untrustedEvents` | options | on / false | `InitOptions.observe` | EventSource messages become delivery candidates; synthetic DOM events count as user actions |

## Invariants and gotchas

- **Train/runtime parity.** Any change to `src/situation/*`, `src/learn/*`, the formatters and redaction in
  `src/util.ts`, `changeText`/`stringDiff` in `src/state/fields.ts`, the delivery gate rules in `runtime.ts`
  (`runDelivery`, `covered`, `markWrites`, `onChannel`), message summaries (`observe/messages.ts`) or op details
  changes model inputs or which rows exist. [HANDOFF.md](../../../HANDOFF.md): "The training format is frozen at `situation-v2` …
  Coordinate before touching it." A change needs a new tag, regenerated sim/realapps data, an update of
  `training/curriculum/rt.py` and retraining.
- **Delivery salience is decided twice.** `runDelivery` pre-filters (conflicts + body comparison) and only then
  calls `trigger()`, whose cheap pass recomputes facts. Both must agree: a fact that is non-neutral when the
  pre-filter released the delivery is never seen; a candidate whose facts are all neutral is released by the cheap
  pass. When you change one rule, change both (`conflicts.ts`/`content.ts` and `runDelivery`).
- **Body reads are bounded and only for candidates.** Non-salient deliveries read nothing and add no latency; a
  candidate waits at most 100 ms of clock time for its body. The app's own body is never consumed (fetch uses the
  runtime's buffered clone).
- **No store holds by default.** `mutation` is non-blocking (priority 1, background, 5 s deadline); discard is a late
  revert (<= 2 s, fields unchanged since). Writes covered by a delivery decision raise no `mutation` at all, except
  with `triage: "always"`. M13 and `defer` only mean something with `holdWrites: true`. Since commit 054da38 a
  delivery that cannot be held (observe mode included) is released synchronously before any body read, and its
  background decision reaches the model and is recorded (§4 steps 6-7, §5 step 5b; `test/observe-delivery.test.ts`).
- **Newer same-signature request in flight neutralises newer-data conflicts** (`newerSameSignature`, fetch/XHR
  only): in-order typeahead and autosave make zero model calls; the in-flight request is still stated (M6, neutral).
- **A plain user write is not a conflict.** Only a user-rooted write whose request of another signature is in flight
  (pending) counts, and for delivery only when the body would revert it. Typed text counts only via F2.
- **Predicted sets are normalised patterns** (`board.cards.:id`): any message about the same collection becomes a
  candidate while one item is pending (extra latency, never a wrong drop; `discard` drops only protected or
  written-over fields).
- **Statements are about the response's content**, located heuristically; an app that transforms data can make
  content facts uninformative but not false. Ambiguous bodies produce no content facts.
- **Side effects of the gate (outside fact code).** `runDelivery` sets `op.delivery` and, through the controller,
  `op.discardMark`; `markWrites` and `onChannel` set field marks; `noteResponse` parses create bodies in the
  background. Fact code itself still writes only `X.reads`. `rt.situation()` stays side-effect free (`test/situation-purity.test.ts`: probes for every trigger kind
  from handlers, timers, fetch continuations, message dispatch and tasks, and devtools-style polling, change no op
  id, event, decision, timer or provider call). Keep `SitEnv` callbacks read-only (`recentErrors` used to prune
  `errorsRecent` while building; since 29b7f28 that happens in `RuntimeImpl.reportError`).
- **Determinism.** Read time only from `env.now()`; body reads and create parsing are promise-based but timed by the
  injected clock (`BODY_WAIT_MS` uses `clock.setTimeout`). Tests assert byte-identical situations
  (`situation.test.ts`, `budget.test.ts`).
- **Fail open.** Throws in `computeFacts`/`buildSituation` are logged and the passive path runs; an `analyzeBody`
  throw is logged and the gate decides on newer-data conflicts alone; a `markWrites` throw is logged (the write has
  already applied, it just gets no mark).
- **Triage is cost, not policy.** A `neutral` flag must never encode "this is a bug".
- **Fact order matters beyond the model.** The budget keeps the first facts; `decide/report.ts` and devtools
  `topFact` skip provenance matching `^This (write|request) (comes from|has no known cause)`. D1 (`The response to …
  arrived …`) is provenance-kind but does not match that regex, so it can become a report headline.
- **Budget is characters.** Full budget is now 2400; budgets above it give the same section counts but more room.
- **`opts.describe` bypasses redaction**; booleans/null are never redacted; store names never redact fields.
- **Normalised chain keys** have no leaf: their state lines and `is now` facts are skipped; transition F9/RYW use
  `matchFields` to get concrete paths.
- **Baselines and cadence cover fetch/XHR only**; WebSocket/task subjects get no stats line.
- **Eviction is FIFO** for baselines (1000), identities (1024), profiles (2000), cadence (500), `lastChainMap`
  (1000).
- **`rt.situation()` is always `salient: true`** when it falls back to an `ask` situation.
- **`Profiles.load` trusts its input** (unverified: a corrupt entry may throw later inside `settled()`).
- **Dead declarations.** `SigStats.firstStart`, `SigStats.failures`, `SigStats.errEwma` (only `snapshot()`),
  `SitEnv.writtenByChain`, `isTrigger`, `SigCadence.userStarts`.
- **Past bugs fixed (keep fixed):** batch 3 items (direction of "started after/before", real failure counts,
  512-entry version log, "is back to", no `= undefined`, empty/non-empty array kinds, digit keys -> `:id`, word-level
  redaction); NaN store values no longer recurse forever (commit ad24804, `test/nan.test.ts`); F2 never diffs a
  redacted value and strong secret containers hide numbers/bigints/arrays (commit f107013,
  `test/redaction-v2.test.ts`); situation building prunes nothing (commit 29b7f28, `test/situation-purity.test.ts`).

## How to change it safely

**Change a fact's wording or add a fact**
1. Edit the function in `situation/facts.ts`, `content.ts` or `evidence.ts`; pick `kind` (rank) and `neutral`
   deliberately. For delivery, also check the `runDelivery` pre-filter.
2. Check consumers: `decide/report.ts` and `devtools/ui.ts` provenance regex; tests matching text
   (`grep -rn "state.facts" packages/runtime/test`).
3. Mirror in `training/curriculum/rt.py` (facts, conflicts, content, evidence are ported there).
4. Update tests (`situation.test.ts`, `delivery.test.ts`, `content.test.ts`, `budget.test.ts`, `batch3.test.ts`,
   review tests) and the example blocks in `packages/runtime/STATUS.md`.
5. Run: `cd packages/runtime && NODE_OPTIONS=--expose-gc npx vitest run test/situation.test.ts test/delivery.test.ts
   test/content.test.ts test/budget.test.ts test/learn.test.ts test/batch3.test.ts test/review-*.test.ts`, then the
   unit suite (see [build-test-release](build-test-release.md); light local runs are fine on the lead's machine).
6. Flag the parity break: a new freeze tag after `situation-v2`, new sim and realapps data, retraining.

**Change the delivery gate or conflict rules**: `conflicts.ts` (`newerConflict`, `pendingConflict`,
`newerSameSignature`, `predictedWrites`), `RuntimeImpl.runDelivery` (pre-filter, body wait), `RuntimeImpl.covered`
(which writes skip `mutation`), `dropFilter`/`writtenOver` (what `discard` drops). Keep `test/delivery.test.ts`
typeahead cases at zero model calls, and `test/no-reorder.test.ts` passing (never-worse: same dispatch order and
final state as observe mode). Re-run the realapps never-worse sweep before freezing (needs the user's go-ahead; see
[realapps](../realapps.md)).

**Change a triage threshold** (M8 3x latency, R3 `close`, R7 hot rate, F9 5x slow mark): edit the expression; add a
benign case that stays quiet (pattern: `test/review-precision.test.ts`) and a positive one that reaches
`decider.calls`; mirror in `rt.py`; regenerate data.

**Change budgets or section limits**: `serialize.ts` and/or `RuntimeImpl.situationBudget`; update
`test/budget.test.ts`, `section_limits`/`to_state`/`BUDGETS` in `rt.py`, budget sampling in
`sim/src/world/scenario.ts` and `realapps/src/harness/scenario.ts`, the `InitOptions.situation` doc comment in
`types.ts`, `docs/runtime/API.md`, ARCHITECTURE.md and CONTRACT §6. Check the model host's maximum sequence length.

**Add a trigger kind**: `TriggerKind`, `SubjectSpec`, `subjectOf`, `subjectOp`, `involvedStores`, `involvedFields`,
`builtinApplicable`, `subjectRef`, `computeFacts`, `TRIGGER_ACTIONS`, `PASSIVE`, `ACTION_INSTRUCTIONS` (and
`TRIGGER_DESCRIPTIONS` if wording differs), `buildSituation` draft, a raise site with a `Controller`, devtools
nouns, the sim, `rt.py`, `fmt.py`. `delivery` (batch 4) is the worked example: `git show fcd1e68 --
packages/runtime/src/situation`.

**Add or reword a built-in action**: `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS`, `TRIGGER_DESCRIPTIONS`,
`builtinApplicable`, the controller's `run()`, policy tiers, and the sim/training lists
([model-io-contract recipes](../model-io-contract.md#recipes)).

**Change the diagnosis vocabulary**: `DEFAULT_DIAGNOSES` (keep `expected` first) plus the sim and training copies
([model-io-contract recipes](../model-io-contract.md#recipes)).

**Change baselines, profiles or cadence**: `baselines.ts` / `profiles.ts` / `cadence.ts`; update `test/learn.test.ts`,
`test/review-precision.test.ts`, `test/content.test.ts` (F6), `test/situation.test.ts` (stall timing). Profiles now
also drive delivery prediction (`predictedWrites`).

**Change redaction**: `isSensitivePath`/`isSensitiveName`/`SECRET_WORDS`/`SECRET_PAIRS`/`WEAK_CONTAINER`/`OPAQUE` in
`util.ts`, `redactedStringDiff` in `state/fields.ts`; update `test/batch3.test.ts` (auth store),
`test/review-redaction.test.ts`, `test/redaction-v2.test.ts`, API.md "Privacy". Any new diff or preview of a field
value must go through the redactor first (use `redactedStringDiff`).

**Change timeline or action-effect wording**: `eventLine` (`describe.ts`), `changeText`/`stringDiff`
(`state/fields.ts`), effect strings in `runtime.ts` (`runDelivery` discard/defer, `onDropped`) and observers,
`event_lines`/`phrase` in `rt.py`; treat as a parity break.

## Tests

| test file | what it asserts |
|---|---|
| `packages/runtime/test/situation.test.ts` | one situation per trigger: key order, <= 12 facts, <= 16 timeline, <= 8 state lines, `stateChars <= STATE_CHAR_BUDGET` (2400); delivery: exactly one call for the out-of-order typeahead response, the trigger sentence, the V-others text "written twice … (version 1 → 3)", `subject.kind === "delivery"`; mutation: older task over newer task, late `discard`; request, failure, stall, inconsistency, transition (descendant wins), error, ask; serializer; byte-identical determinism |
| `packages/runtime/test/delivery.test.ts` (16 cases, new) | typeahead zero calls (incl. a debounced search with its own loading flag); stale out-of-order response -> `discard` drops only the stale field; holding is only latency; no hold when the model cannot answer in time; read-after-write; late revert; slow model; superseded queued decision dropped; WebSocket order + pending revert vs third value; messages touching nothing pending; EventSource; XHR holds and `abort()`; forced actions |
| `packages/runtime/test/content.test.ts` (14, new) | F3 (no call when unchanged), F1 field and item cells, F2 salience and diff preview, F9 (over newer data, 5x slow, ambiguous failure, channel down), F6 schedule and debounce, F5 scope/offline/commit, F7, F8 relation quality, read-your-writes, STATUS.md example printouts |
| `packages/runtime/test/budget.test.ts` | `sectionLimits` at 1100/1750/2400/3200/500; budgets 1000/1100/2000 on the delivery situation; compact questions; determinism; auto budget 2400 / wasm 1000/1333/2000; `max_tokens_exceeded` -> 1920; hold budget |
| `packages/runtime/test/no-reorder.test.ts` (new) | realworld promise middleware through `genclassEnhancer` with an always-passive model: guard/heal x salient/always give the same dispatches, order and final state as observe (with `always`, `delivery` and `mutation` were consulted); `holdWrites: true` never reorders a store's dispatches |
| `packages/runtime/test/default-mode.test.ts` (new, commit f3636b2) | `createRuntime` and `GenClass.init` without a mode start in observe (guard via option or `?genclass=guard`); observe never holds writes or requests even when the model is sure, findings still reported; a model that never answers delays nothing |
| `packages/runtime/test/batch3.test.ts` | redaction (now incl. the `auth` store rules), no `= undefined`, item change summary, "is back to 6", slug ids, pending-local-change fact first and salient on a default (unheld, background) `mutation` (now worded "this write's cause (#n) started after that user action"), `transient` after `unusual`; only its plugin-gate case sets `holdWrites: true` |
| `packages/runtime/test/atoms.test.ts` | runs with `holdWrites: true`: held writes never reordered, read-your-writes |
| `packages/runtime/test/learn.test.ts` | baselines and profiles (unchanged) |
| `packages/runtime/test/review-precision.test.ts`, `review-redaction.test.ts`, `review-hub.test.ts`, `review-fetch.test.ts`, `review-actions.test.ts`, `invariants.test.ts`, `plugins.test.ts`, `ask.test.ts`, `dom.test.ts`, `devtools-runtime.test.ts`, `nan.test.ts` | as before (precision, custom redactor, version counts past 16 entries, direction texts, error facts, plugin facts, ask sentences, error fact text, devtools Now view); `dom.test.ts` adds `untrustedEvents` and shadow-DOM descriptions; `nan.test.ts` the NaN fix |
| `packages/runtime/test/redaction-v2.test.ts` (10, new, commit f107013) | F2 on a secret field renders `[redacted] → [redacted]` with the default redactor and the replacement with a custom one, never characters of the raw text; an unredacted field keeps the diff-centred preview; `redactedStringDiff` returns null unless both sides pass the redactor; strong secret containers hide numbers, bigints and arrays (booleans/null/undefined visible, plain objects judged key by key); broad containers and unrelated paths unchanged; `changeText` and `describe()` hide those values |
| `packages/runtime/test/situation-purity.test.ts` (2, new, commit 29b7f28) | a mixed app raising every trigger kind (`triage: "always"`), probed with `situation()`, `situation(kind)` and from-scratch rebuilds inside handlers, timers, fetch continuations, message dispatch and tasks: next op id (`OpRegistry.peekNextId`), op count, event seq, decisions, interventions, in-flight count, hub seq, timers and provider calls unchanged, and the whole run identical with and without probes; devtools-style polling (`situation`, `inflight`, `explain`, `interventions`, `history` on every `setImmediate` turn of `test/browser/ui/session.ts` -> `runStoreSession`) changes no decision, intervention, op or event |
| `packages/runtime/test/observe-delivery.test.ts` (11, new, commit 054da38) | observe: a conflicting fetch response with a slow body resolves at network time and is decided once in the background on the state it was delivered into; an app write before the body is read decides it at that write; F1 is not lost; standing questions on `delivery` answered; XHR body analysed before the listeners run; WebSocket/EventSource messages delivered synchronously and in order, still decided; guard: stale response held and discarded, a too-slow model releases at once and the write is late-reverted on its own |

Full unit run on `mvp-v2-merge` (f107013, 2026-10-08, `npx vitest run` in `packages/runtime`, no model
directory): 45 files passed + 1 skipped, 379 passed + 14 skipped (393), `review-perf` included (see
[build-test-release](build-test-release.md)). The earlier mvp-v2 run at b435acb was 40 + 1 files, 332 + 14 tests;
the uncommitted `state/hub.ts` held-write-verdict change mentioned there is not in this branch.

## Drift and open issues

Resolved since 654d822 (removed from this list): the `InitOptions.situation` doc comment now matches the code
(webgpu 2,400; wasm 1,000-2,000); the `InitOptions.redact` doc comment now describes leaf-field redaction; the
`sim/NEEDS.md` `transient` note is no longer relevant.

- **CONTRACT.md not updated for v2.** It never mentions `delivery`; the §6 trigger table still describes `mutation`
  as "a state write about to apply (held)"; §6 still says "≤ 1,000 tokens; truncate timeline first, then state, then facts"; the batch-4/5 deltas exist only in
  STATUS.md ("Contract deltas"). §2 still has the regex redactor; §4 still lists length-delta and duration in the
  profile shape.
- **ARCHITECTURE.md** says "3,200 characters on WebGPU"; code 2400. Its diagnosis order and "(v0 → v1)" example
  were already off.
- **Training budgets exceed the runtime's full budget.** `sim/src/world/scenario.ts` (comment "3,200 WebGPU") and
  `realapps/src/harness/scenario.ts` sample 3200 at 40%; production auto budgets never exceed 2400. Sections are the
  same (limits saturate at 2400) but rows can be up to 800 chars longer than anything the deployed runtime emits.
  The Python port samples 2400/2000/1667/1333/1000.
- **STATUS.md "Open issues"** still says content comparison facts are "not implemented yet"; batch 5 implemented
  them (F1-F3).
- **`rollback` description vs effect** (transition/error restore only the chain's writes) and **unreachable M11**
  (`StoreHub.propose` commits unholdable writes without `observeWrite` or `hooks.gate`) are unchanged.
- **API.md**: plugin facts "added to every situation" (only built situations, neutral, may be cut); "computes cheap
  facts for every write and request" (only when consultable, and covered/GenClass/user writes never trigger);
  `rt.situation()` shape omits `compact` and `budget`.
- **`Situation.subject` doc comment** ("One sentence naming the subject") vs the short subject phrase in code.
- **STATUS.md triage summary** "cause latency > 3x median" omits the `>= 100 ms` condition; "identical request …
  within min(2 s, half its usual gap)" omits the "> 3 sightings" condition.
- **Python port drift** (`training/curriculum/rt.py` -> `to_state`): fact shortening floor 40 (runtime 60), trigger
  never shortened; Python rounding (`f"{x:.2f}"`, `round()`) vs `toFixed`/`Math.round` on exact ties; code points vs
  UTF-16 in `truncate`. Its docstring also says it does not model learned cadence, stale marks, click counts, create
  responses or list item joins (those come from optional `spec` keys or are absent).
- **Sim coverage**: `sim/src/run/rt.ts` -> `createOptions` enables `fetch`, `timers`, `websocket`, `storage` (storage
  is new since 654d822) and disables `xhr`, `user`, `errors`, `nav`, `perf`; `eventsource` is left at its default
  (on), but nothing in `sim/src` references `EventSource`. XHR/EventSource deliveries and DOM-derived evidence (F7
  click counts) therefore come only from realapps (inferred from options and a grep, not checked against data).
- **Open (OPEN_TASKS.md, [HANDOFF.md](../../../HANDOFF.md); release order in [RELEASE.md](../../../RELEASE.md))**: no situation-v2 model yet; the demo items "hold-induced harm" and "typeahead
  salient about 6 times per trial" were measured with v0.1 store holds (situation-v1) and need re-measuring with a
  v2 model; STATUS.md reports 0/396 clean real-app runs changed with an always-passive model.

## Related docs

- [RESULTS.md](../../runtime/RESULTS.md): §3 separability, §4 never-worse sweep.
- [public-api-and-lifecycle](public-api-and-lifecycle.md): `InitOptions` (`mode`, `triage`, `situation.budget`,
  `learn`, `redact`, `vocabulary`, `observe`), `PolicyOptions.holdWrites`, `rt.situation()`, `rt.ask()`.
- [observe-and-trace](observe-and-trace.md): ops, signatures, identities, the delivery hooks in fetch/XHR/messages.
- [state-and-adapters](state-and-adapters.md): mutation pipeline (`observeWrite`, drop filter, `holdWrites`), marks,
  invariant miner, settled points.
- [decide-policy-actions](decide-policy-actions.md): queue, hold, gate, late revert, actions, reports.
- [model-host](model-host.md) and [model-io-contract](../model-io-contract.md): how the `JevState` and questions
  become model input.
- [devtools](devtools.md): where facts and situations are displayed.
- [sim](../sim.md), [realapps](../realapps.md), [training](../training.md): producers and consumers of this exact
  output; parity and regeneration.
- [status-and-known-issues](../status-and-known-issues.md), [glossary](../glossary.md).
- Human docs: [CONTRACT.md](../../runtime/CONTRACT.md) §4-§8 (pre-v2 in places), [API.md](../../runtime/API.md),
  [ARCHITECTURE.md](../../runtime/ARCHITECTURE.md), [packages/runtime/STATUS.md](../../../packages/runtime/STATUS.md)
  (batches 4-5, example situations per trigger and per new fact), `sim/SEPARABILITY.md` §6 (F-numbers).
