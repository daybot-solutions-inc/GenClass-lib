# @genclass/runtime: baselines, profiles, facts, triggers, triage and situation serialisation

> **Scope:** `packages/runtime/src/learn/baselines.ts`, `packages/runtime/src/learn/profiles.ts`,
> `packages/runtime/src/situation/{build,facts,describe,env,questions,serialize}.ts`, the triage code in
> `packages/runtime/src/runtime.ts` (`RuntimeImpl.trigger`, `RuntimeImpl.settled`, `RuntimeImpl.situationBudget`,
> `RuntimeImpl.makeEnv`) and the text helpers they use in `packages/runtime/src/util.ts` and
> `packages/runtime/src/state/fields.ts` (`changeText`). Triage/salience lives only in `situation/facts.ts`
> (`neutral` flags), `situation/build.ts` (`salient`, `forced`) and `runtime.ts` -> `RuntimeImpl.trigger`; other
> hits for "salient" in `adapters/`, `observe/fetch.ts` and `devtools/index.ts` are comments or display.
> **Read this when:** you change any text the model reads (fact wording, timeline/state/stats lines, questions,
> action descriptions, diagnosis labels), the triage rule (what is salient), the situation budget or section limits,
> redaction, the latency/error/rate baselines, or transition profiles; or when you need to know why a trigger did or
> did not reach the model.
> **Source of truth:** the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

## TL;DR

- **Every byte here is model input.** The sim (`sim/`) generates training rows by running the real
  `createRuntime` from `@genclass/runtime` and recording exactly the `state`/`questions` this code produces
  (`sim/src/run/rt.ts` -> `realRuntimeFactory`). `training/curriculum/rt.py` is a hand-written Python port of the same
  modules. Changing wording, ordering, thresholds, budgets or formatters changes model inputs: the final-round
  training data (SIM phase A) is generated from the runtime frozen at git tag `situation-v1` (commit 1a77558), and
  final round 1 of R17/R32 was launched on it (`training/LOG.md`; results still "(in progress)" in
  `training/EVAL.md`, no model package published yet per `OPEN_TASKS.md`). `git diff situation-v1 HEAD --
  packages/runtime/src` is empty at 654d822.
- **Baselines** (`Baselines`): per op signature (`GET /api/items/:id`), for fetch/XHR only: last 64 non-failure
  latencies (nearest-rank median/p95, needs >= 5 samples), last 20 outcomes, failure streak, EWMA error rate
  (alpha 0.1; never read by facts, stats or devtools: only `Baselines.snapshot()` returns it, and nothing in `src/`
  calls `snapshot()`), last 128 start times (rate: starts in the last 10 s vs the usual rate), and per request
  identity the EWMA gap between identical requests.
- **Transition profiles** (`Profiles`): per op signature (user ops: `user <name>`), counts over completions of the
  written-field set, value kind per field, status class, write-count bucket and duration bucket. A completion is
  *unusual* when its set, a field's kind, its status class or its write count was seen in < 1% of >= 20 previous
  completions (duration is recorded but never checked).
- **Triggers** (`TriggerKind`): `mutation`, `request`, `failure`, `stall`, `inconsistency`, `transition`, `error`,
  `ask`. Each has a `SubjectSpec` (what the situation is about) and a `SubjectRef` (structured id for the sim/tests).
- **Facts** (`computeFacts`): uniform English sentences per trigger, each with a `kind` (ranked) and a `neutral`
  flag. Ordered non-neutral first, then by kind rank, stable; capped at 12 (`MAX_FACTS`).
- **Triage**: with `triage: "salient"` (default) the model is consulted only if some fact has `neutral: false`, or a
  standing question with `always: true` applies, or the trigger is `ask`. Otherwise the passive action runs with no
  model call and no decision record. Triage is a cost filter only; it never picks a diagnosis or an action.
- **Situation** = Jev state object with keys in fixed order `app`, `trigger`, `facts`, `in_flight`, `timeline`,
  `state`, `stats` (empty arrays become the string `"none"`), plus questions `diagnosis` (always, except `ask`) and
  `action` (only when > 1 action applies).
- **Budget** in characters: `STATE_CHAR_BUDGET = 3200` (full), `COMPACT_BUDGET = 1100` (compact limits), linear in
  between (`sectionLimits`); `MIN_BUDGET = 500`. Over budget: drop timeline (oldest first), then state, facts (keep
  >= 1), in-flight, stats; then shorten facts and the trigger. Questions are compact (bare labels) at <= 1400 chars.
- **Device sizing** ("auto"): WebGPU or unknown device 3200; WASM `1000 + round((threads - 1) * 1000 / 3)` for
  1..4 threads (1000/1333/1667/2000); scaled by 0.8 per `max_tokens_exceeded`, floor 0.5.
- **Deterministic and side-effect free**: only the injected clock is read; the only write is caching field versions
  in `op.reads`. Same inputs give byte-identical situations (tested at the default 3200 in `situation.test.ts` and at
  1100 in `budget.test.ts`).
- **Model text also comes from outside this folder**: action-effect sentences, hub write summaries (`changeText`) and
  observer op details reach the model through the timeline (see Invariants).

## Files

| path | role | key exports / entry points |
|---|---|---|
| `packages/runtime/src/learn/baselines.ts` | online per-signature latency, outcomes, failure streak, rate; identity gaps | `Baselines` (`start(sig, t, identity?)`, `end(sig, t, latency, ok, outcome, countsAsFailure)`, `noteIdentity`, `latency`, `rate(sig, now)`, `failureCounts`, `stats`, `identity`, `snapshot`; public maps `sigs`, `ids`), `SigStats`, `LatencyBaseline`, `RateBaseline`, `IdentityStats`, `isFailureOutcome`, `outcomeLabel` |
| `packages/runtime/src/learn/profiles.ts` | transition profiles and rarity check | `Profiles` (`check`, `add`, `get`, `toJSON`, `load`), `shapeOf`, `kindLabel`, `writesBucket`, `durBucket`, `Profile`, `Shape`, `Unusual`, `MIN_COMPLETIONS`, `RARE` |
| `packages/runtime/src/situation/env.ts` | what situation code may read from the runtime; trigger subjects | `SitEnv`, `SubjectSpec`, `ReqMeta`, `FailureInfo`, `Violation`, `ErrorInfo`, `CachedInfo`, `ChainWriteInfo` |
| `packages/runtime/src/situation/facts.ts` | fact computation per trigger, ordering | `computeFacts`, `orderFacts`, `MAX_FACTS` |
| `packages/runtime/src/situation/describe.ts` | how ops and events are phrased | `userPhrase`, `opPhrase`, `opLabel`, `statusText`, `eventLine` |
| `packages/runtime/src/situation/build.ts` | subject sentence, sections, applicable actions, questions, salience | `buildSituation`, `subjectOf`, `subjectRef`, `isTrigger` (exported, not used anywhere in `src/` or `sim/src`), `BuildOptions`, `BuiltSituation`, `ActionOption`; internal `subjectOp`, `involvedStores`, `involvedFields`, `inFlightLines`, `timelineLines`, `stateLines`, `statsLines`, `builtinApplicable`, `revertableChain`, `appText` |
| `packages/runtime/src/situation/questions.ts` | action catalogue, per-trigger actions, instructions, diagnosis vocabulary, question building | `BUILTIN_ACTIONS`, `BuiltinAction` (`{ name, tier, description }`), `TRIGGER_ACTIONS`, `PASSIVE`, `ACTION_INSTRUCTIONS`, `DIAGNOSIS_INSTRUCTIONS`, `DEFAULT_DIAGNOSES`, `COMPACT_QUESTIONS_BUDGET`, `diagnosisVocabulary`, `actionDescription`, `buildQuestions` |
| `packages/runtime/src/situation/serialize.ts` | budget-shaped Jev state | `toJevState`, `sectionLimits`, `stateChars`, `stateText`, `STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `MIN_BUDGET`, `LIMITS`, `SituationParts`, `SectionLimits` |
| `packages/runtime/src/runtime.ts` (parts) | owns the `Baselines`/`Profiles` instances, feeds them, implements `SitEnv`, runs triage | `RuntimeImpl.trigger`, `RuntimeImpl.settled`, `RuntimeImpl.situationBudget`, `RuntimeImpl.buildOpts`, `RuntimeImpl.makeEnv`, `RuntimeImpl.startOp`/`endOp`/`registerIdentity`/`onApplied`/`watchStall`, `RuntimeImpl.situation`, `normalizeError` |
| `packages/runtime/src/util.ts` (parts) | formatters and redaction used in every sentence | `secs`, `rel`, `fmtNum`, `ratio`, `plural`, `ordinal`, `truncate`, `describe`, `defaultRedact`, `isSensitiveName`, `words`, `REDACTED`, `Redactor`, `kindOf`, `normalizeFieldPath`, `requestSignature`, `normalizePath`, `isIdSegment` |
| `packages/runtime/src/state/fields.ts` (parts) | change sentences used in facts and timeline write summaries (owned by [state-and-adapters](state-and-adapters.md)) | `changeText` (re-exported by `state/hub.ts`), `elementDiff`, `addedElements`, `normalizeLeafKind` |
| `packages/runtime/src/index.ts` | public re-exports from this area | `stateText`, `stateChars`, `sectionLimits`, `STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `BUILTIN_ACTIONS`, `TRIGGER_ACTIONS`, `PASSIVE`, `DEFAULT_DIAGNOSES` |

Public types used here live in `packages/runtime/src/types.ts`: `TriggerKind`, `Fact`, `FactKind`, `Situation`,
`SituationDraft`, `SubjectRef`, `JevState`, `Question`, `Vocabulary`, `StandingQuestion`, `ActionDef`, `Tier`.

## Concepts and data structures

| term | meaning (code name) |
|---|---|
| op signature | `requestSignature(method, where)` in `util.ts`: upper-cased method + path with id-like segments replaced by `:id` (`normalizePath`, `isIdSegment`). It is `op.name` for fetch/XHR ops and the key of `Baselines`; `Profiles` key fetch/XHR/task/ws ops by `op.name` and user ops by `user <op.name>`. |
| request identity | `ReqMeta.identity`: hash of method + URL + semantic headers + body (computed by the fetch/XHR observers). Identities starting `uniq:` never match anything. |
| outcome | string recorded per completion in `SigStats.outcomes`: HTTP code (`"200"`, `"503"`), `"timeout"`, `"network"`, or an op status; failures are stored with a `!` prefix (`"!503"`). `"aborted"` is never recorded. Facts print the label without `!` (`outcomeLabel`), and `network` as `network error` (`outcomesText` in `facts.ts`). |
| failure (for baselines) | a completion whose `EndOpts.failure` is true: network error, timeout, HTTP 5xx, 429 or 408 (`FAILURE_STATUS` in `observe/fetch.ts`; same set in `observe/xhr.ts`). A 404 is *not* a failure. |
| chain | an op and its causal descendants (shared `root`). "Same chain" in facts = one op is an ancestor-or-self of the other (`sameChain` in `facts.ts`). |
| chain write | `ChainWrite { kind, len0, len1 }` accumulated in `OpRec.chain` (keyed by **normalised** field path) for profiled ops; `ChainWriteInfo { path, count, lastIsChain, before? }` from `SitEnv.chainWrites(op)` (real paths) for facts and rollback applicability. |
| shape | `Shape { set, fields, kinds, status, writes, dur }`: one completion's transition, built by `shapeOf`. |
| unusual | `Unusual { component: "set" or "kind" or "status" or "writes", field?, seen, of, usual, usualCount, observed }` from `Profiles.check`. |
| subject | what a situation is about: `SubjectSpec` (internal, rich) and `SubjectRef` (public, ids only; `EvaluateRequest.subject`, `Decision.subjectRef`; never serialised into `state`). |
| fact | `Fact { text: string; kind: FactKind; neutral: boolean }`. `neutral: false` = makes the situation salient. |
| salient | `BuiltSituation.salient` / `Situation.salient`: `triage === "always"` or trigger `ask` or some fact non-neutral. |
| forced | `BuiltSituation.forced`: a standing question with `always: true` is registered for this trigger; consults even when not salient. |
| draft | `SituationDraft`: structured view handed to plugin `facts()` and `ActionDef.applicable()`. |
| parts | `SituationParts { app, trigger, facts[], in_flight[], timeline[], state[], stats[] }`: unbudgeted section lines. |
| state (Jev) | `JevState` = `Record<string, unknown>` produced by `toJevState(parts, budget)`; what the model reads (the model host packs it; see [model-io-contract](../model-io-contract.md)). |
| budget | situation size in characters as measured by `stateChars` (sum over keys of `key.length + 2 + text.length + 1`, arrays joined by `"\n"`). |
| compact questions | `Situation.compact` (budget <= 1400): option descriptions are `null` (bare labels), except vocabulary overrides of <= 24 chars. |
| settled point | `RuntimeImpl.settled()`: no op started < 10 s ago is in flight and no write is pending, `settleMs` (default 60 ms) after the last write/op end. Profiles and invariants learn here. |
| storeWriters | `Map<signature, Map<store, count>>` learned in `RuntimeImpl.onApplied`: how often each signature's chain (writer + up to 8 ancestors) wrote each store. Used by facts, timeline relevance, `involvedStores`. |

### Key types (abridged)

```ts
// packages/runtime/src/situation/env.ts
type SubjectSpec =
  | { trigger: "mutation"; m: MutationRec }
  | { trigger: "request"; op: OpRec; req: ReqMeta }
  | { trigger: "failure"; op: OpRec; req: ReqMeta; failure: FailureInfo }
  | { trigger: "stall"; op: OpRec; req: ReqMeta }
  | { trigger: "inconsistency"; violations: Violation[] }
  | { trigger: "transition"; op: OpRec; unusual: Unusual[]; shape: Shape }
  | { trigger: "error"; error: ErrorInfo; op: OpRec | null }
  | { trigger: "ask"; about: "now" | number | string };

// packages/runtime/src/types.ts
type FactKind = "provenance" | "versions" | "inputs" | "concurrency" | "repetition" | "outcome" | "baseline"
  | "invariant" | "transition" | "error" | "delta" | "cache" | "request" | "plugin";
interface Situation { trigger; subject: string; state: JevState; questions: Record<string, Question>;
  actions: string[]; salient: boolean; facts: string[]; compact: boolean; budget: number }
```

`BuiltSituation` (`build.ts`) = `{ spec, draft, situation, actions: ActionOption[], facts: Fact[], parts, salient,
standing, forced, subjectRef }`. `ActionOption = { name, tier, description, custom? }`.

```ts
// packages/runtime/src/learn/baselines.ts
interface SigStats { sig; count; failures; lat: number[]; starts: number[]; errEwma; failStreak;
  outcomes: string[]; lastSuccess?; lastFailure?; firstStart }      // firstStart is set but never read
interface LatencyBaseline { n; median; p95 }
interface RateBaseline { recent: number; usual?: number }           // usual = starts per 10 s
interface IdentityStats { last; n; gapEwma? }

// packages/runtime/src/learn/profiles.ts
interface Profile { sig; n; sets: Record<setKey, count>; kinds: Record<field, Record<kind, count>>;
  wrote: Record<field, count>; status: Record<cls, count>; writes: Record<bucket, count>; dur: Record<bucket, count> }
interface Shape { set: string /* sorted fields joined "," ; "" = nothing */; fields: string[];
  kinds: Record<string, string>; status: string; writes: string; dur: string }
// packages/runtime/src/trace/ops.ts (accumulated on OpRec.chain)
interface ChainWrite { kind: string; len0: number /* -1 if not array */; len1: number }

// packages/runtime/src/situation/env.ts
interface ReqMeta { method; url; signature; identity; idempotent; replayable; bodyBytes?; transport: "fetch" | "xhr" }
interface FailureInfo { kind: "network" | "timeout" | "http"; status?; statusText?; message?; durMs }
interface Violation { id; text; fields: string[]; values: string; held: number; developer? }
interface ErrorInfo { name; message; source?; raw: unknown; key }   // built by runtime.ts -> normalizeError
interface CachedInfo { t; status }

// packages/runtime/src/situation/build.ts
interface BuildOptions { vocab?; diagnoses: Record<string, string>; customActions: ActionDef[];
  questions: StandingQuestion[]; pluginFacts: { name; fn: (d: SituationDraft) => string[] }[];
  triage: "salient" | "always"; budget?: number /* default 3200 */ }

// packages/runtime/src/situation/serialize.ts
interface SectionLimits { facts; in_flight; timeline; state; stats;
  line: { app; trigger; facts; in_flight; timeline; state; stats } }
```

`SituationDraft` (`types.ts`): `{ trigger, subject, now, op?, root?, stores, mutation?: { id, store, changes },
request?: { method, url, signature, identity, idempotent, replayable, identicalInFlight: number[], cached },
failure?: { kind, status?, message? }, error?: { name, message, source? }, invariants?: { id, text }[], facts: Fact[],
inFlight: Op[] }`. `SubjectRef` (`types.ts`): `{ kind, op?, mutation?, store?, paths?, cause?, error?, invariant? }`.
`ErrorInfo.key` = `normalizeError` key: `<name>:<message with every digit run -> "n", first 120 chars>`.

### SitEnv (read-only view of the runtime)

`SitEnv` is implemented by `RuntimeImpl.makeEnv`. Members: `now()`, `ops` (`OpRegistry`), `hub` (`StoreHub`),
`base` (`Baselines`), `profiles`, `events` (`EventLog`), `redact` (`Redactor`), `app()` (`RuntimeImpl.appInfo`:
`CreateOptions.app()` when given, else `global.document.title` and `global.location.pathname`), `cached(identity)`
(GET cache peek, `ResponseCache.peek`), `identical(identity)` (ops with that identity started in the last 10 s or
still in flight; `registerIdentity` keeps at most 12 ops per identity and 512 identities, FIFO),
`lastConsistent()`, `consistentBefore(seq)` (from the last 8 consistent snapshots), `storeWriters`,
`recentErrors()` (last 10 s; at most 64 kept), `violations()` (current learned violations), `previewInvariants?(m)`
(invariants the pending write would break), `canCoalesce(identity, selfId)` (`ResponseCache.shareable`),
`resyncable(store)`, `writable(store)`, `chainWrites(op)` (`RuntimeImpl.chainWrites`: fields written by the op's
root chain since the root started). `writtenByChain?(a, h)` is declared in `env.ts` but not implemented by
`makeEnv` and not called anywhere.

### Triggers and subjects

| trigger | raised by (file -> symbol) | hold | priority | subject sentence (`subjectOf`) | `SubjectRef` |
|---|---|---|---|---|---|
| `mutation` | `runtime.ts` -> `gateMutation` (a non-bypassed write, see [state-and-adapters](state-and-adapters.md)) | yes | 2 | `A write to <paths>[ from <opLabel(cause)>] is about to be applied.` (> 3 paths: first 3 + `and N more`; no paths: store name; ` from …` only when there is a cause op) | `{kind, mutation, store, paths, cause?}` |
| `request` | `observe/fetch.ts`, `observe/xhr.ts` request gate | yes | 2 | `<opLabel(op)> is about to be sent.` | `{kind, op}` |
| `failure` | fetch `failureGate` (hold yes, priority 2); XHR (hold no, priority 1) | fetch yes | 2 / 1 | `<opLabel> failed (<HTTP <status>, timed out, or network error>) and the app has not seen the failure yet.` | `{kind, op}` |
| `stall` | `runtime.ts` -> `watchStall` timer at `max(4 x median, 2 x p95, 500 ms)`, only with a latency baseline | no | 1 | `<opLabel> has been waiting <secs> for a response.` | `{kind, op}` |
| `inconsistency` | `runtime.ts` -> `settled` -> `raiseInconsistency` (fresh violations) | no | 1 | `The relation <text>[ (and N more)] no longer holds now that the app is settled.` | `{kind, paths, store?, invariant?}` |
| `transition` | `runtime.ts` -> `settled` -> `raiseTransition` | no | 0 | `<opLabel> completed with a state change unlike its usual ones.` | `{kind, op, paths, store?}` (paths are normalised chain keys) |
| `error` | `runtime.ts` -> `reportError` (also from the errors observer) | no | 0 | `An uncaught <name> was thrown: <message <= 120>` | `{kind, error (raw), op?}` |
| `ask` | `runtime.ts` -> `ask()` / `decide()` / `situation()` (not through `trigger()`) | n/a | 1 | `The developer asks about <opLabel(op)>` / `the store <name>` / `the app right now.` | `{kind, op?, store?}` |

The short `Situation.subject` string (`subjectOf(...).subject`; copied to `Decision.subject` and used by reports and
devtools; not part of `state`, except indirectly through the failed-action timeline text `Tried to <action>
<subject> but it failed; the passive action ran instead.` written by `RuntimeImpl`) is: mutation `write to <paths>[ from <opLabel>]` (e.g.
`write to search.results from GET /api/search?q=rea (#6)`); request `<opLabel>`; failure `<opLabel> (HTTP 503 |
timed out | network error)`; stall `<opLabel>, waiting <secs>`; inconsistency `relation <text>[ (and N more)]`;
transition `<opLabel> state change`; error `<name>: <message <= 80>`; ask `question about <opLabel>` /
`question about <store>` / `question about the app`. With no violation the inconsistency text uses `?`; an unknown
asked op prints `an earlier operation`.

Stall details: the fetch observer (primary request only) and the XHR observer (async only) call
`host.watchStall` at send time when `host.gated(op)`; with no latency baseline yet (< 5 samples) no timer is armed,
so the first requests of a signature can never stall. The timer fires at most once per op (`op.triggered` gets
`"stall"`), and not if the op already ended. Transitions are likewise marked once per op (`op.triggered` gets
`"transition"`).

The *subject op* (`subjectOp` in `build.ts`) is the
cause op for `mutation`, the request op for request/failure/stall/transition, the ambient op for `error`, the asked op
for `ask`, none for `inconsistency`. *Involved stores* (`involvedStores`): mutation -> its store; inconsistency ->
stores of violated fields; transition -> stores of chain keys; error -> stores changed since the op started;
request/failure/stall -> stores that this signature's chains wrote (`storeWriters`); ask -> the asked store. Only
registered stores are kept.

## How it works

### 1. Baselines (fed by op start/end)

1. `RuntimeImpl.startOp`: for `fetch`/`xhr` ops not owned by GenClass -> `Baselines.start(name, t)` (push start time,
   window 128). If the op has an identity -> `registerIdentity` -> `Baselines.noteIdentity(identity, op.start)`
   (skipped for `uniq:` identities): first sighting stores `{last, n: 1}`; later sightings update
   `gapEwma = gap` (first) then `0.8 * gapEwma + 0.2 * gap`. At most 1024 identities (FIFO eviction).
2. `RuntimeImpl.endOp`: for `fetch`/`xhr`, not synthetic (blocked/cached/coalesced answers), not GenClass ->
   `Baselines.end(sig, t, latency, ok, outcome, countsAsFailure)` with `outcome = "aborted"` or `String(code)` or the
   status, `ok = status "ok" and (code not a number or < 400)`, `countsAsFailure = !!EndOpts.failure`.
3. `Baselines.end`: returns early for `"aborted"` (the signature entry is still created). Otherwise `count++`, push
   outcome (`"!"` prefix when failure; keep last 20). Failure: `failures++`, `failStreak++`, `lastFailure = t`,
   `errEwma = errEwma * 0.9 + 0.1`. Non-failure: `failStreak = 0`, `lastSuccess = t` only if `ok`,
   `errEwma *= 0.9`, push latency (keep last 64). Latency samples therefore never include failures/timeouts.
4. Reads: `latency(sig)` -> `undefined` below 5 samples, else `{ n, median, p95 }` by nearest rank on the sorted
   window (`a[min(n-1, max(0, ceil(p*n) - 1))]`). `rate(sig, now)` -> `recent` = starts with `t > now - 10000`;
   `usual = older / span * 10000` only when `older >= 3` and `span = (now - 10000) - oldestOlder >= 20000`.
   `failureCounts(sig)` -> `{ failed, of }` over the last <= 20 outcomes (this is what facts and stats print).
   `errEwma` is returned only by `snapshot()` (as `errorRate`); no code in `src/` (devtools included) calls
   `snapshot()`, so the EWMA is currently unused (reachable only through `rt.internals.base`).
5. Signatures are capped at 1000 (FIFO by insertion, not LRU). Baselines are in memory only (never persisted).

### 2. Transition profiles (fed by writes, checked at settled points)

1. `RuntimeImpl.onApplied` (every applied write with a writer op): for the writer and up to 8 ancestors whose kind is
   in `PROFILED` (`fetch`, `xhr`, `user`, `task`, `ws`; not `timer`, not GenClass) and not yet profiled:
   `op.chainWrites += 1` per applied mutation, and for each changed path `op.chain.set(normalizeFieldPath(path),
   { kind: normalizeLeafKind(c.afterLeaf), len0: first-seen before length (-1 if not an array), len1: latest after
   length })` (`normalizeLeafKind` in `state/fields.ts` returns the leaf kind, or `"undefined"` for a removed field). It also bumps
   `storeWriters[sig][store]` once per signature per write (cap 1000 signatures).
2. Ops are queued for profiling (`queueProfile`, cap 2000) on `endOp` (not aborted, not synthetic) or at creation for
   instant ops.
3. `RuntimeImpl.settled()` (only when not busy): for each queued ended op not yet profiled:
   `shape = shapeOf(op.chain, op.chainWrites ?? 0, statusClass(op), op.end - op.start)`;
   `sig = op.kind === "user" ? "user " + op.name : op.name`; `unusual = profiles.check(sig, shape)` **then**
   `profiles.add(sig, shape)` (the current completion is not part of "previous N"). Flag it if `unusual.length` and
   no transition was raised for this op before.
4. "One anomaly, one trigger": a flagged op is skipped when another flagged op is its descendant (the most specific
   op wins; tested in `situation.test.ts` transition case). Each survivor -> `raiseTransition` -> `trigger(...)` with
   `hold: false`, priority 0.
5. `statusClass(op)`: numeric code -> `"<n>xx"` (`"2xx"`, `"5xx"`); `"timeout"`/`"network"`; else `op.status ?? "ok"`.
6. `Profiles.check(sig, s)` (returns `[]` while `p.n < 20`). `rare(seen, of) = of >= 20 && seen < 0.01 * of`
   (up to and including 100 completions that means "never seen"):
   - `set`: the sorted written-field set is rare **and** the most common set is not `""` (an op that usually writes
     nothing may start writing: not flagged).
   - `kind`: for each written field with `wrote[f] >= 20`, the observed kind is rare among that field's kinds.
   - `status`: the status class is rare.
   - `writes`: the write-count bucket is rare, the most common bucket is not `"0"`, and no `set` anomaly was found.
   - `dur` is counted but never checked.
   `usual`/`usualCount` come from `top()` (highest count; ties: lexicographically first key).
7. `Profiles.add`: increments counts; caps write sets at 64 and fields at 128 (drop least frequent, ties: oldest);
   at most 2000 signatures (FIFO). Persisted to `localStorage["genclass.profiles.v1"]` only with
   `learn: { persist: true }` (`saveProfilesSoon` saves 5000 ms after a settled point whose profile queue was
   non-empty, with at most one save pending; loaded in the constructor; `Profiles.load` only checks `sig` and `n`).
8. `kindLabel`: arrays -> `"empty array"` / `"non-empty array"` (length change deliberately ignored), objects ->
   `"object"`, else the leaf kind (`"string"`, `"number"`, `"boolean"`, `"null"`, `"undefined"`, `"map"`, `"set"`,
   `"date"`, ...). `normalizeFieldPath`: every segment after the store name that is id-like or contains a digit
   becomes `:id` (`chat.byId.m21` -> `chat.byId.:id`).

### 3. Trigger -> triage -> situation (`RuntimeImpl.trigger`)

1. Not consultable (paused, destroyed, no `DecisionProvider`, or provider state not `ready`/`off`) -> run passive,
   build nothing.
2. Cheap pass: `facts = computeFacts(env, spec)`; `forced = standing.some(q => q.always && q.on.includes(trigger))`.
   If `triage === "salient"` and not forced and **every fact is neutral** -> passive (no model call, no `Decision`,
   `lastBuilt` untouched).
3. `buildSituation(env, spec, buildOpts(), facts)` (reuses the facts, adds plugin facts, builds sections). Any throw in
   steps 2-3 -> logged (debug) and passive (fail open).
4. `lastBuilt[trigger] = built` (what `rt.situation(trigger)` returns later). If `!built.salient && !built.forced` ->
   passive.
5. Provider not `ready` (lazy model) -> start loading (`this.ready`), run passive.
6. Otherwise submit `{ trigger, state, questions, priority, subject }` to the decider queue; hold/deadline/gate
   handling is in [decide-policy-actions](decide-policy-actions.md).

`ask` bypasses `trigger()`: `rt.ask(q, {about})` builds an `ask` situation and **replaces** its questions with
`{ answer: q }`. `rt.situation(trigger?)` returns `lastBuilt[trigger].situation` when one exists, else builds
`{ trigger: "ask", about: "now" }` and relabels it with the requested trigger.

### 4. `buildSituation(env, spec, o, precomputed?)` step by step

1. `budget = o.budget ?? STATE_CHAR_BUDGET`; `L = sectionLimits(budget)`; `subjectOf`, `subjectOp`, `involvedStores`.
2. Facts: `precomputed` or `computeFacts`. Draft: `{ trigger, subject, now, stores, facts, inFlight (non-user),
   op?, root?, mutation?, request? (with identicalInFlight, cached), failure?, error?, invariants? }`.
3. Plugin facts: for each plugin with `facts(draft)`, every non-empty string -> `{ text: truncate(t.trim(), 240),
   kind: "plugin", neutral: true }`; a throwing plugin is ignored.
4. `facts = orderFacts(facts).slice(0, 12)` (kept in `Situation.facts`, reports and `explain()`; the budget decides
   how many reach the model).
5. Actions: `TRIGGER_ACTIONS[trigger]` filtered by `builtinApplicable` (table below), descriptions from
   `actionDescription`; then custom `ActionDef`s whose `on` includes the trigger, whose name is new, and whose
   `applicable(draft)` is true (throw = not applicable); tier default `"heal"`.
6. Questions: standing questions for this trigger -> `extra`; `compact = budget <= 1400`;
   `buildQuestions(trigger, actions, o.diagnoses, extra, compact, o.vocab)`.
7. Sections (`parts`): `app` = `appText` (`"<title> — <route>"`, either alone, or `"unknown"`), `trigger` = subject
   sentence, `facts` = texts, `in_flight` = `inFlightLines`, `timeline` = `timelineLines`, `state` = `stateLines`,
   `stats` = `statsLines`.
8. `state = toJevState(parts, budget)`; `salient = o.triage === "always" || trigger === "ask" || facts.some(f =>
   !f.neutral)`.

#### Applicable built-in actions (`builtinApplicable`)

| trigger | always | conditional |
|---|---|---|
| mutation | `apply`, `discard` | `defer` iff `m.defers < 2` |
| request | `send`, `delay`, `block` | `coalesce` iff transport fetch and `canCoalesce(identity, op.id)`; `serve_cached` iff GET and a cached response exists |
| failure | `deliver` | `retry` iff replayable, `attempt < 4`, fetch; `serve_cached` iff GET, cached, fetch |
| stall | `wait` | `hedge` iff idempotent, GET, replayable, fetch; `serve_cached` iff GET, cached, fetch |
| inconsistency | `ignore` | `rollback` iff `lastConsistent()` exists and some involved store is writable; `resync` iff some involved store has a resync handler |
| transition | `ignore` | `rollback` iff `revertableChain(op)`; `resync` iff a chain store is resyncable |
| error | `ignore` | `rollback` iff an ambient op exists and `revertableChain(op)` |
| ask | (none) | |

`revertableChain(op)` = some `chainWrites(op)` entry has `lastIsChain`, a known `before`, and a writable store.

#### Section builders (`build.ts`)

- **`inFlightLines`**: in-flight ops except user ops and the subject op; sorted by (same signature as subject = 0,
  same root = 1, else 2), then start time; first `L.in_flight`. Line: `<opPhrase <= 80> (#id) <secs> so far[, by #cause]`.
- **`timelineLines`**: the last 96 events (`env.events.last(96)`), each rendered by `eventLine` (null lines dropped).
  Relevant = `user`, `error`, `action`, `nav` events always; `state` events of involved stores; op events of the
  subject or its ancestors, of the same signature, of the same root or a descendant of the subject, or of a
  signature that wrote an involved store. Keep the last `L.timeline` relevant lines; if fewer, fill with the most
  recent non-relevant lines; output in event order.
- **`stateLines`**: first the involved fields (mutation change paths, violated fields, transition chain keys), then
  the fields of all involved stores pooled together, most recent write first; stops at `L.state`; paths with no current leaf are
  skipped. Line: `<path> = <describe(value, path, redact, 90)> (v<v>[, by #writer] <secs> ago)` or `(v0)` when never
  written. A store registered with `opts.describe` contributes one line `<store> = <describe() <= 110> (v<version>)`
  instead of its fields. `ask` about `now` with nothing involved -> all fields of all stores by recency.
- **`statsLines`**: signatures = the subject op's (if fetch/xhr/ws/task) + every in-flight fetch/xhr; first
  `L.stats` that have `count > 0`. Line: `<sig>: <count> done[, median <secs>, p95 <secs>], <failed> of last <of>
  failed, <recent> in last 10s[ (usual <fmtNum>)]`. (Baselines only exist for fetch/xhr, so ws/task subjects
  produce no line.)

### 5. `describe.ts` phrasing (also used for action effect texts)

`opLabel` is also imported by `runtime.ts`, `observe/fetch.ts` and `observe/xhr.ts` to write `ActionEffect.changed`
sentences (`Dropped the write to …`, `Retried … as attempt …`), which come back to the model as timeline `action`
lines. `decide/report.ts` and the devtools do not import `describe.ts`.

- `userPhrase(op)` from `op.meta.action` and `op.detail` (already redacted/quoted by `rt.user`): `user clicked
  <target or "the page">`, `user typed <value or "text">[ into <target>]`, `user changed <target or "a field">[ to
  <value>]`, `user submitted <target or "a form">`, `user pressed <key or "a key">[ in <target>]`, `user navigated
  to <target or value or "a page">` (kinds `nav` and `navigate`), else `user <kind or "action">[ <target>][ <value>]`.
- `opPhrase(op)`: user -> `userPhrase`; fetch/xhr -> `<signature><detail>` (detail is the observer's redacted query
  or body summary, e.g. `?q=re`, ` {items: [1], cardNumber: [redacted]}`); timer, ws -> name; task -> `task <name>[
  <detail>]`; genclass -> `GenClass <name>`.
- `opLabel(op)` -> `<opPhrase truncated to 90> (#id)`, or `an earlier operation` when unknown.
- `statusText(op)` -> `aborted`, `blocked`, numeric code, `timed out`, `network error`, `error[ (<errorText <= 40>)]`,
  else status or `pending`.
- `eventLine(e, now, op)` prefixes `rel(e.t - now)` (`-1.24s`; `-0.00s` for now):

| event kind | line |
|---|---|
| `user` | `<t> <userPhrase> (#id)` or `(<n> keystrokes, #first–#last)` for a merged typing burst |
| `op.start` | `<t> start <opPhrase <= 80> (#id[, by #cause][, attempt n])` (user ops: none) |
| `op.end` | `<t> end <opPhrase <= 80> (#id): <statusText>[ in <secs>]` |
| `state` | `<t> write <summary <= 110>[ (by #op[, user])]` (summary = first 3 `path: changeText`, joined `; `) |
| `error` | `<t> error <message <= 100>[ (during #op)]` |
| `nav` | `<t> navigate <route <= 60>` |
| `storage` | `<t> <name>[ <key <= 40>]` |
| `perf` | `<t> <name>[ <ms>ms]` |
| `custom` | `<t> event <name <= 60>[ <summary <= 60>][ (#op)]` |
| `action` | `<t> GenClass <text <= 100>` (past GenClass actions are visible to the model: `ActionEffect.changed`, or `undid <action> (<id>)` for an undo) |
| `decision` | never shown |

When the op is no longer in the registry: `user` prints the event name instead of the phrase, `op.start` is dropped,
`op.end` prints `<t> end <name>`. `rel` prints `+` for future times (not expected in practice).

`changeText(c, redact)` (`state/fields.ts`; used by M15, I2 and the hub's timeline `write` summaries): same-length
arrays -> `N items, unchanged` / `N items, reordered` / `N items, K changed: {id: 3, qty: 1 → 2}[, and K-1 more]` (at
most half the items changed; `elementDiff` lists the id key and up to 3 changed keys, `+N more changed`), else the
full `before → after` when <= 90 chars, else `N items, K changed`; other arrays -> full `before → after` when <= 70 chars, else `B → A items: added
<first>[ and N more]; removed N item(s)`; objects compared by key hash -> `B → A entries: added k: v; changed k:
…; removed k1, k2[ and N more]`; anything else -> `<describe 36> → <describe 36>`.

Formatters (`util.ts`): `secs` = 2 decimals below 10 s (`0.42s`), 1 decimal below 1000 s, else integer;
`fmtNum` = integers as is, else 1 decimal (>= 100), 2 (>= 1), 4 (< 1), trailing zeros dropped; `ratio(a, b)` =
`∞` if `b <= 0`, `<round>×` if >= 10, else `<1 decimal>×`; `times(n)` (facts.ts) = `once`, `twice`, `N times`;
`truncate(s, n)` cuts to `n - 1` chars + `…`. `plural(n, one)` = `<n> <one>` or `<n> <one>s`; `ordinal(n)` =
`1st`, `2nd`, `3rd`, `11th`. `describe(v, path, redact, max)`: strings quoted (48 chars, 24
nested), arrays `N items [a, b, c, …]` (at most 3 elements, stopping before `max - 16` chars; nested `[N]`, empty
`0 items`), objects `{id: …, name: …, k: v, +N}` with
id-like keys first (`id`, `_id`, `key`, `uuid`, `slug`, `name`, `title`, `label`), depth > 1 `{N keys}`, empty
`{}`, `Map(n)`, `Set(n)`, dates ISO (`Invalid Date`), bigint `<n>n`, `function`, `symbol`; the whole result is
truncated to `max`.

### 6. Facts catalogue (`facts.ts` -> `computeFacts`)

**Salient** = `neutral: false`. `C` = the write's cause op, `#C` its id; `<times>` = once/twice/N times; "other
chain" = writer not ancestor-or-self of `C` and vice versa. `<writer>` = `<opLabel(w)>, which started <secs>
after #C` (or `before #C`, or `started at the same time as #C`) + optional `, from the same user action (#u)`,
`, from a later user action (#u)`, `, from an earlier user action (#u)`; or `a user action` / `an operation that is no
longer tracked`. Provenance (shared helper `provenance`): `<What> comes from <opLabel(op)>, started <secs> ago[,
ended <secs> ago with <status>][; its chain began with <opLabel(root)>].` or `<What> has no known cause: no
operation was active when it started.`

**mutation** (`mutationFacts`)

| id | kind | salient when | condition and text |
|---|---|---|---|
| M1 | provenance | never | always: provenance of `This write` |
| M2 | versions | always | `C` set, for each of the first 3 written paths written by another chain since `C` started: `<path> was written <times> by other operations since this write's cause (#C) started (version <vStart> → <vNow>), last <secs> ago by <writer>.` (counts from the 512-entry field log) |
| M3 | versions | never | only `C`'s own chain wrote it: `<path> was written <times> by this write's own chain since this write's cause (#C) started (version a → b).` |
| M4 | versions | never | untouched: `<path> has not changed since this write's cause (#C) started (version <v>).` Side effect for every one of the first 3 paths (M2, M3 or M4): `C.reads.set(path, vStart)` with `vStart = hub.versionAt(path, C.startSeq)` |
| M5 | inputs | field is in the **same store** as the write | up to 2 other existing fields changed by other chains since `C` started (order: same store, user-written, most recent): `<path> changed <times> since … started (now <v>)` (first write no longer in the 16-entry history), or `… changed since … started: <before> → <now>[ (<n> writes)]`, or `… changed <times> since … started and is back to <v>` (values described at 40 chars), then `, last by <opLabel(w)> <secs> after #C started.` (or `, last by an untracked writer.`) |
| M6 | concurrency | at least one listed op started **after** `C` | in-flight ops outside `C`'s chain with `C`'s name and kind: `<N> other <C.name> operation(s) is/are in flight (<k> newer than this write's cause (#C)): #id <detail> started …; …` (up to 3 listed) |
| M7 | concurrency | never | other in-flight ops whose signature's chains wrote this store: `<opLabel> is in flight and its chain wrote <store> <times> before[ (<n> more such ops in flight)].` |
| M8 | baseline | `lat > 3 × median` **and** `lat − median >= 100 ms` | `C` is an ended fetch/xhr with a latency baseline: `This write's cause (#C) took <secs>, <ratio> its usual <median> (p95 <p95>).` |
| M9 | outcome | never | `C` fetch/xhr ended with status error: `This write's cause (#C) failed (<status>) before this write.` |
| M10 | versions | always | for each of the first 3 written paths: a write in the last 10 s from another chain rooted in a user op whose non-user op is still in flight: `<path> has a pending local change: <opLabel(user)> wrote it <secs> ago and its <opLabel(pending)> is still in flight; this write comes from <opLabel(C)>, which started after (or before) that user action.` (or `has no known cause`) |
| M11 | outcome | never | `m.unholdable`: `This write could not be held: <reason>.` (appears unreachable, see Drift) |
| M12 | repetition | some change is **additive** (numeric delta `n:` or array add/remove `a:`) | same change key (sorted paths + deltas) applied in the last 10 s (`hub.recent`): `An identical change to <paths> (<delta>) was applied [<n> times in the last 10s, last ]<secs> ago by <opLabel(w)>[; both come from the same user action (#u)][; they come from separate user actions <secs> apart].` `<delta>` = `+N`/`-N`, `added N item(s) <first>`, `removed N item(s)`, or `set to <value>` (first change only) |
| M13 | concurrency | never | earlier queued writes on the store: `<N> earlier write(s) to <store> is/are still waiting for a decision.` |
| M14 | invariant | never | up to 2 learned relations the write would break (`previewInvariants`): `Applying this write would break the learned relation <text> (<values>); it held at <n> settled points.` |
| M15 | delta | never | first 3 changes: `This write would change <path>: <changeText>.` |
| M16 | outcome | never | `m.defers > 0`: `This write was already deferred <times>.` |

**request / failure / stall common part** (`requestCommon`; `<self>` = `This request (#id)` for request, `The
request (#id)` otherwise)

| id | kind | salient when | condition and text |
|---|---|---|---|
| R1 | provenance | never | provenance of `This request` (cause op) |
| R2 | outcome | never | `attempt > 1`: `<self> is attempt <n>: it was already retried <times>.` |
| R3 | repetition | **request only**: `close` | identical-identity ops (not this one, started <= 10 s ago, `attempt === 1`): `<N> identical <sig> request(s) in the last 10s: <items>` (or `(latest 3: <items>)` when N > 3; items, last 3 only, joined `; `: `#id in flight (started <secs> ago)` or `#id answered <statusText> <secs> ago` (status ok) / `#id ended <statusText> <secs> ago`) `; #<last> started <secs> after (or before) this one` + `, from the same user action (#u)` / `; they come from separate user actions <secs> apart` / `, neither from a user action` (nothing when only one side has a user action). `close` = one of them is in flight, or the start gap to the latest `< min(2000, 0.5 × gapEwma)` (gapEwma used only when the identity was seen more than 3 times; else `< 2000` ms) |
| R4 | concurrency | never | same signature, different identity, in flight: `<N> other <sig> request(s) with different input is/are in flight: #id <detail> (started …); …` |
| R5 | outcome | **request only**: `failStreak >= 2` | not on failure; `failStreak > 0`: `The last <N> <sig> request(s) failed in a row (<last 5 outcomes>); last success <secs> ago` (or `no success yet`) |
| R6 | outcome | never | stall with `failStreak 0` and `count > 0`: `Recent <sig> outcomes: <last 5>.` |
| R7 | baseline | `recent >= 5` **and** `recent >= 3 × usual` (any of the three triggers) | usual rate known, `recent >= 3`: `<sig> was requested <times> in the last 10s; usually <usual> per 10s (<ratio>).` |
| R8 | baseline | never | no usual rate yet, `recent >= 3`: `… (no usual rate learned yet).` |
| R9 | baseline | never | not stall, latency baseline exists: `<sig> usually answers in <median> (p95 <p95>, <n> samples); error rate <x>% over <of> request(s) (<failed> failed).` (`x = round(failed / of × 100)` over the last <= 20 outcomes; `no completed requests yet` when there are none) |
| R10 | cache | never | GET with a cached response: `A cached <status> response from <secs> ago exists for this request.` |
| R11 | request | never | always: `<METHOD> is idempotent` or `is not idempotent`, then `; its body (<n> bytes) can be replayed.` or `; its body cannot be replayed.` (no body clause for GET/HEAD) |

**request** = R1-R11. **failure** = F1-F3 then R1-R11:

| id | kind | salient when | text |
|---|---|---|---|
| F1 | outcome | always | `The request #id failed: <HTTP <status>[ <statusText>] or timed out or network error[ (<msg <= 50>)]> after <secs>; the app has not seen the failure yet.` |
| F2 | outcome | never | only when the signature has baseline stats: `This is the <ordinal> <sig> failure in a row (recent outcomes: <last 5>; <last success <secs> ago or no success yet>); error rate <x>% over <of> request(s) (<failed> failed).` with `ordinal(max(1, failStreak))`. The failing op was already ended and recorded by `Baselines.end` before the trigger, so the streak, outcomes and counts include it (example C: 3rd, three 503s) |
| F3 | outcome | never | chain already wrote state (`chainWrites(op)` non-empty): `Before this failure its chain wrote <up to 4 paths>.` |

**stall** = S1, S2 then R1-R11 (R9 omitted):

| id | kind | salient when | text |
|---|---|---|---|
| S1 | baseline | always | `The request #id has been in flight for <secs>; <sig> usually takes <median> (p95 <p95>, <n> samples), <ratio> the median.` (without baseline: `… has been in flight for <secs>.`) |
| S2 | concurrency | never | other same-name in-flight requests past `3 × median`: `<N> other <sig> request(s) is/are also running past 3× the usual latency.` |

**inconsistency** (`inconsistencyFacts`), per violation (first 3): I1 (invariant, **always salient**) `The developer
invariant "<text>" no longer holds.` or `The learned relation <text> no longer holds: <values>. It held at <n> settled
points before.`; then I2 (versions, never) for the 2 latest writes to its fields since the last consistent snapshot:
`<path> was written <secs> ago by <opLabel(w)>[ (user)]: <changeText>.` After the loop: I3 (invariant, never)
`The last consistent state is <secs> old; <n> field write(s) happened since.` or `No consistent snapshot has been
recorded yet.`; I4 (concurrency, never) `<n> operation(s) is/are in flight.` or `No operations are in flight (the app
is settled).`

**transition** (`transitionFacts`): T1 (transition, **always salient**), first 3 `Unusual` (`<sig>` = `op.name`, or
`opPhrase` for user ops):
- set: `In the previous <of> completions of <sig> its chain wrote <usual fields> (<usualCount> of <of> times); this
  time it wrote [only ]<observed fields>[ (seen <times> before)].` (`only` when observed is a strict subset;
  `nothing` for an empty set; fields joined `a, b and c`)
- kind: `In the previous <of> completions of <sig> that wrote <field>, it wrote a/an <usual> (<usualCount> of <of>
  times); this time it wrote a/an <observed>.`
- status: `… it ended with <usual> (<usualCount> of <of> times); this time it ended with <observed>.`
- writes: `… its chain made <usual> write(s) (<usualCount> of <of> times); this time it made <observed>.`

Then T2 (provenance, never) of `The completed operation #id` / `The completed user action #id` (cause op, or the op
itself when it has no cause); T3 (baseline, never, fetch/xhr) `It ended <secs> ago with <status> after <secs>[
(usual <median>)].`; T4 (delta, never) for each of the first 3 chain keys (insertion order) that has a current value
or field record: `<field> is now <describe 60>.`; T5 (invariant,
never) `The last consistent state from before #<root> started is …` / `No consistent snapshot from before #<root>
started exists.`

**error** (`errorFacts`): E1 (error, **always salient**) `Uncaught <name>: <message <= 120>[ (at <source <= 60>)].`;
with an ambient op: E2 (provenance) `It was thrown while <opLabel(op)> was active, <secs> after it started[; that
chain began with <opLabel(root)>].` and E3 (versions) `Its chain wrote <up to 4 paths> before the error[ (<k> of them
overwritten since by other operations)].` or `Its chain wrote no state before the error.`; without: E4 (provenance)
`No operation was active when it was thrown.`; E5 (repetition) `The same error happened <times> in the last 10s.`
when the error key (`normalizeError`: `<name>:<message with digits -> n, 120 chars>`) occurred more than once (the
current error is already in `recentErrors`, so "twice" means one earlier occurrence); E6 (invariant) last-consistent
fact relative to the op's root (`The last consistent state from before #<root> started is …` / `No consistent
snapshot from before #<root> started exists.`), or the plain `The last consistent state is …` / `No consistent
snapshot has been recorded yet.` when no op was active. E2-E6 never salient.

**ask** (`askFacts`, all neutral; `ask` is salient anyway): about an op id -> `Operation #N is not known.` when
missing, else provenance of `Operation #id (<opPhrase <= 60>)`, `It has been in flight for <secs>.` or `It ended
<secs> ago with <status> after <secs>.`, `<name> usually takes <median> (p95 <p95>).`, `Its chain wrote <up to 5
normalised keys>.`; about a store -> `Store <name> is not registered.` when missing, else up to 6 most recent fields
`<path> is at version <v>[, last written <secs> ago by <opLabel>]`; about now -> `<N> operation(s) is/are in flight;
the oldest is <opLabel> (<secs>).` or `No operations are in flight.`, `The last <N> <sig> request(s) failed in a row
(<outcomes>).` for streaks whose last failure is < 30 s old, `<N> error(s) happened in the last 10s.`, up to 2
`The learned relation <text> does not hold: <values>.`, and `An identical change to <paths> was applied <times> in
the last 10s.` for change keys seen more than once in 10 s.

**Ordering** (`orderFacts`): non-neutral first, then `RANK` (`invariant`, `transition`, `error` 0; `versions` 1;
`repetition` 2; `inputs` 3; `outcome` 4; `baseline` 5; `concurrency` 6; `provenance` 7; `request` 8; `cache` 9;
`delta` 10; `plugin` 11), then original position.

### 7. Triage: exact salience conditions

A trigger reaches the model iff the runtime is consultable, the provider is `ready` (otherwise the first salient
situation starts the lazy load and fails open), and one of:
1. `triage: "always"`; or
2. trigger is `ask`; or
3. a standing question with `always: true` lists the trigger (`forced`); or
4. at least one computed fact is non-neutral. Per trigger:
   - **failure, stall, inconsistency, transition, error**: always (F1, S1, I1, T1, E1 are non-neutral).
   - **mutation**: M2 (a written field was written by another chain since the cause started), M5 (a field of the
     same store moved since then), M6 (a newer op with the cause's signature is in flight), M8 (the cause took
     > 3× its median and >= 100 ms over it), M10 (a pending local change is being overwritten), M12 (an identical
     additive change in the last 10 s). A write with no cause op can only be salient through M10 or M12.
   - **request**: R3 with `close`, R5 with `failStreak >= 2`, R7 hot rate.

Plugin facts are always neutral and are only computed after the cheap pass, so plugins can never make a trigger
salient. Because the sim runs with `triage: "salient"`, sim decision rows exist only for salient situations (its ask
probes come separately from `rt.situation("ask")`); changing triage changes the training distribution, not just
runtime cost.

### 8. Questions (`questions.ts` -> `buildQuestions`)

- `ask`: only standing questions registered for `ask` (and `rt.ask()` replaces them with `{ answer }`).
- `diagnosis` (always otherwise): `{ type: "choice", instructions: "What is happening here?", criteria }` over
  `o.diagnoses` = `diagnosisVocabulary(vocab, pluginLabels)`: `vocab.diagnoses` replaces `DEFAULT_DIAGNOSES`
  entirely, `expected` is re-added if missing and always first, plugin labels are appended if new.
- `action` (only when more than one action applies): instructions `ACTION_INSTRUCTIONS[trigger]`, one option per
  applicable action in offer order (passive first), description from `actionDescription` = `vocab.actions[name]` ??
  custom description ?? built-in description ?? name.
- Compact (`budget <= COMPACT_QUESTIONS_BUDGET` = 1400): every description becomes `null` except a vocabulary
  override of <= 24 chars (`COMPACT_DESC_MAX`); custom-action and plugin-label descriptions are dropped too.
- Standing questions are added under their ids unless the id is already used (`diagnosis`/`action` cannot be
  overridden).

| label (`DEFAULT_DIAGNOSES`, in order) | description |
|---|---|
| `expected` | normal behaviour, nothing is wrong |
| `stale` | outdated data or an older operation is about to replace newer state |
| `conflict` | concurrent operations are competing over the same state or resource |
| `duplicate` | the same change or request is happening again without a new intent |
| `inconsistent` | the state contradicts itself or relationships it normally keeps |
| `failing` | an operation keeps failing or its failures follow a pattern |
| `slow` | an operation is far slower than usual |
| `overload` | work is being triggered far more often than usual |
| `unusual` | this differs from how the same operation normally behaves |
| `transient` | a one-off failure that is likely to succeed if tried again |

| trigger | `TRIGGER_ACTIONS` (passive first) | `PASSIVE` | `ACTION_INSTRUCTIONS` |
|---|---|---|---|
| mutation | apply, discard, defer | apply | What should the runtime do with this write? |
| request | send, coalesce, delay, block, serve_cached | send | What should the runtime do with this request? |
| failure | deliver, retry, serve_cached | deliver | What should the runtime do with this failed request? |
| stall | wait, hedge, serve_cached | wait | What should the runtime do with this slow request? |
| inconsistency | ignore, rollback, resync | ignore | What should the runtime do about this inconsistent state? |
| transition | ignore, rollback, resync | ignore | What should the runtime do about this unusual state change? |
| error | ignore, rollback | ignore | What should the runtime do about this error? |
| ask | (none) | `""` | `""` |

Built-in action descriptions and tiers (`BUILTIN_ACTIONS`): apply (passive) "let this write update the state now";
discard (guard) "drop this write and keep the current state"; defer (guard) "hold this write until the related
in-flight operations finish, then decide again"; send (passive) "send the request now"; coalesce (guard) "do not
send; reuse the result of the identical request that is in flight or just finished"; delay (guard) "wait before
sending, backing off so the service can recover"; block (heal) "do not send; fail this request immediately";
serve_cached (heal) "answer with the last successful response for this request instead"; deliver (passive) "pass
the failure to the application as it is"; retry (heal) "retry the request after a short backoff"; wait (passive)
"keep waiting for the request"; hedge (heal) "send a second identical request and use whichever answers first";
ignore (passive) "leave the state as it is"; rollback (heal) "restore the affected state to its last consistent
snapshot"; resync (heal) "reload the affected state from its source". Effects: [decide-policy-actions](decide-policy-actions.md).

### 9. Serialiser (`serialize.ts` -> `toJevState(parts, budget)`)

1. `b = max(500, round(budget))`; `L = sectionLimits(b)` with `r = clamp((b - 1100) / (3200 - 1100), 0, 1)` and
   `lerp(a, z) = Math.round(a + (z - a) * r)`.
2. Pre-shape: `app` (or `"unknown"`) and `trigger` truncated to their line limits; `facts`, `in_flight`, `state`,
   `stats` keep their **first** `L.<section>` lines, `timeline` keeps its **last** `L.timeline` lines; every line
   truncated to `L.line.<section>` (`…` suffix).
3. Build the object with keys in order `app, trigger, facts, in_flight, timeline, state, stats`; empty arrays ->
   `"none"`.
4. While `stateChars > b`: drop timeline lines from the start (oldest) down to 0, then state lines from the end to 0,
   then facts from the end down to **1**, then in_flight from the end to 0, then stats from the end to 0.
5. Still over: shorten every fact by the excess (not below 60 chars), then the trigger (not below 60 chars).

| budget | facts | in_flight | timeline | state | stats | line limits app / trigger / facts / in_flight / timeline / state / stats |
|---|---|---|---|---|---|---|
| 500-1100 | 6 | 2 | 3 | 3 | 1 | 60 / 180 / 220 / 90 / 100 / 100 / 110 |
| 1333 (WASM 2 threads) | 7 | 2 | 4 | 4 | 1 | 67 / 187 / 224 / 93 / 104 / 106 / 113 |
| 1400 (compact-questions edge) | 7 | 3 | 5 | 4 | 1 | 69 / 189 / 226 / 94 / 106 / 107 / 114 |
| 1667 (WASM 3 threads) | 8 | 3 | 7 | 4 | 2 | 76 / 196 / 231 / 98 / 111 / 114 / 118 |
| 2000 (WASM 4 threads) | 9 | 4 | 9 | 5 | 2 | 86 / 206 / 237 / 103 / 117 / 121 / 123 |
| 2560 (WebGPU after 1 overflow) | 10 | 5 | 12 | 6 | 3 | 102 / 222 / 248 / 111 / 128 / 135 / 131 |
| 3200+ (WebGPU) | 12 | 6 | 16 | 8 | 4 | 120 / 240 / 260 / 120 / 140 / 150 / 140 |

(Counts at 1100/2000/3200 and the 500 = 1100 equivalence are asserted in `test/budget.test.ts`; the line limits and
the other rows are computed from the same formula, not tested.) A 1-line-per-section minimum does not exist: the
counts are maxima, sections may be `"none"`, and only `facts` keeps at least 1 line under shrinking. `stateText(state)` renders `key: value` or `key:` plus
two-space-indented lines; it is for logs, `explain()` and devtools. `stateChars` does not count that indentation.
What the model actually tokenises is produced from the `JevState` by the model host's packer
(`packages/runtime/src/model/serialize.ts`), see [model-io-contract](../model-io-contract.md).

### 10. Redaction

- `Redactor = (path, value) => unknown`; default `defaultRedact` returns `"[redacted]"` when **any dotted segment**
  of the path names a secret by meaning: `isSensitiveName` splits camelCase/snake/kebab into lower-case words and
  matches `SECRET_WORDS` (password, passwd, passcode, passphrase, pass, pwd, secret, token, cvv, cvc, csc, ssn,
  iban, otp, totp, pin, cookie, authorization, auth, apikey, creditcard, cardnumber) or `SECRET_PAIRS` (card +
  number/num/no/cvc/cvv/code/security; credit card; cc + number/num/no/exp/csc; api key/secret; private key; access
  key; secret key; session id/token/key; security code; one time; social security). `card`, `cards`, `author`,
  `passengers`, `tokens`, `pinned`, `session`, `key` are not secrets.
- Situation code applies it through `describe(v, path, env.redact, max)` (state lines, inputs-moved values, deltas,
  `is now` facts) and `changeText(c, redact)` (`state/fields.ts`; timeline write summaries are produced by the hub
  with the same redactor). Nested object keys are checked at `path.key`. Op details (query strings, request bodies,
  typed values) are redacted earlier by the observers and `rt.user`; invariant `values` by the invariant miner.
- A custom `redact` option replaces the default everywhere (tested for invariant facts in
  `test/review-redaction.test.ts`).

### 11. Device-sized situations (`RuntimeImpl.situationBudget`)

`situation.budget` number -> used as is. `"auto"` (default): decider `status.device === "wasm"` ->
`1000 + round((min(4, max(1, threads)) - 1) * 1000 / 3)`; otherwise (webgpu or unknown) 3200; times
`budgetScale`, which starts at 1 and becomes `max(0.5, budgetScale * 0.8)` on each `max_tokens_exceeded` error from
the decider (`DeciderQueue` error callback in the constructor). Example: 3200 -> 2560 -> 2048 -> 1638 -> 1600
(floor); WASM 1 thread 1000 -> 800 -> 640 -> 512 -> 500. The scale is per runtime instance, never resets, and does
not apply to a numeric `situation.budget`. `env.ts` holds no sizing logic. `Runtime.situationBudget()` is public
(`types.ts` -> `Runtime`) and is what `buildOpts()` passes as `BuildOptions.budget` on every build. The sim samples
budgets 3200/2000/1000 with weights 40/30/30 (`sim/src/world/scenario.ts`, `R.fork("budget")`) and passes them as a
fixed `situation.budget`; the Python curriculum samples the same three at 35/30/35 (`training/curriculum/rt.py` ->
`BUDGETS`, override env `GC_RT_BUDGET`). Neither generates 1333/1667 or overflow-scaled budgets: at runtime those
sizes are interpolations the model never saw in training.

### 12. Annotated examples (copied from `packages/runtime/STATUS.md`, produced by the tests)

**A. mutation at a 1000-char budget (compact, from `test/budget.test.ts`, 998 chars).**

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

- Fact 1 is M2 (versions, salient: another chain wrote `search.results` after the cause started); fact 2 is M5
  (inputs, salient because `search.query` is in the same store). Non-neutral facts come first, then provenance
  (rank 7) and delta (rank 10).
- The timeline limit at 1000 chars is 3 lines, but timeline is the first thing dropped when over budget, so only the
  newest line survives. `in_flight` is empty -> `"none"`.
- `stats` has no median/p95: only 4 latency samples (< 5). Compact questions (budget <= 1400) carry bare labels
  (every criterion is `null`); the `questions:` lines are the test's printout, the model receives the `questions`
  object and the packer renders it.

**B. request at the full budget (from `test/situation.test.ts`).**

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

- R3 is salient because the identical request #2 is still in flight (`close`). `cardNumber` is redacted
  (`card` + `number` pair) in the op detail by the fetch observer. `serve_cached` is not offered (not a GET);
  `coalesce` is offered because `canCoalesce` found #2. No baseline facts yet (no completions). `state` is `"none"`
  because no store has been written by this signature.

**C. failure at the full budget (from `test/situation.test.ts`; `app`, `in_flight`, `timeline`, `state` and the
questions are omitted here, see STATUS.md for the full text).**

```
trigger: GET /api/status (#12) failed (HTTP 503) and the app has not seen the failure yet.
facts:
  The request #12 failed: HTTP 503 after 0.06s; the app has not seen the failure yet.
  4 identical GET /api/status requests in the last 10s (latest 3: #6 answered 200 6.00s ago; #8 ended 503 4.00s ago; #10 ended 503 2.00s ago); #10 started 2.00s before this one, neither from a user action.
  This is the 3rd GET /api/status failure in a row (recent outcomes: 200, 200, 503, 503, 503; last success 6.00s ago); error rate 50% over 6 requests (3 failed).
  GET /api/status was requested 5 times in the last 10s (no usual rate learned yet).
  This request comes from task poll (#11), started 0.06s ago.
  GET is idempotent.
  A cached 200 response from 6.00s ago exists for this request.
stats:
  GET /api/status: 6 done, 3 of last 6 failed, 5 in last 10s
```

- F1 is the only salient fact; the rest follow `RANK`: repetition (2), outcome F2 (4), baseline R8 (5),
  provenance (7), request R11 (8), cache (9). R3 is neutral on `failure`. R9 is absent and stats show no median:
  only 3 non-failure latency samples. The error rate uses real counts over the last <= 20 outcomes, the outcome list
  shows the last 5.

**D. transition at the full budget (from `test/situation.test.ts`; facts and stats only, see STATUS.md for the rest).**

```
trigger: POST /api/cart {} (#46) completed with a state change unlike its usual ones.
facts:
  In the previous 22 completions of POST /api/cart its chain wrote cart.items and cart.total (22 of 22 times); this time it wrote only cart.items.
  The last consistent state from before #45 started is 0.40s old; 1 field write happened since.
  It ended 0.06s ago with 200 after 0.08s (usual 0.08s).
  The completed operation #46 comes from user clicked button "Add" (#45), started 0.14s ago.
  cart.items is now 23 items [1, 2, 3, …].
stats:
  POST /api/cart: 23 done, median 0.08s, p95 0.08s, 0 of last 20 failed, 23 in last 10s
```

- T1 (`set` component, salient) is first; `only` because `{cart.items}` is a strict subset of the usual set. The
  profile had 22 previous completions (>= 20) and the observed set was seen 0 times (< 1% of 22).
- Neutral facts follow `RANK`: T5 invariant (0), T3 baseline (5), T2 provenance (7, cause = the user click #45),
  T4 delta (10). T4 printed because `cart.items` has no id-like segment, so the normalised chain key is also a
  real path.
- The click #45 is profiled too (key `user <name>`, its chain includes #46's writes) and is equally unusual, but it
  is an ancestor of #46, so only #46 (the descendant) is raised; the test asserts exactly one transition call.
- `stats` shows `0 of last 20 failed` although 23 are done: outcomes keep only the last 20 (`OUTCOMES`).
- Actions offered: `ignore`, `rollback` (the chain's write is the latest and its previous value is known); no
  `resync` because the test store has no resync handler.

## Configuration and constants

| name | type | value | defined in | effect |
|---|---|---|---|---|
| `LAT_WINDOW` | const | 64 | `learn/baselines.ts` | latency samples kept per signature |
| `START_WINDOW` | const | 128 | `learn/baselines.ts` | start times kept per signature (rate) |
| `WINDOW_MS` | const | 10000 | `learn/baselines.ts` | "recent" window for `rate()` |
| `ERR_ALPHA` | const | 0.1 | `learn/baselines.ts` | EWMA weight of the error rate |
| `MIN_LAT_SAMPLES` | const | 5 | `learn/baselines.ts` | latency baseline exists from 5 samples (also gates stall watching) |
| `OUTCOMES` | const | 20 | `learn/baselines.ts` | outcomes kept; failure counts are over these, facts list the last 5 |
| `MAX_SIGS` | const | 1000 | `learn/baselines.ts` | signatures kept (FIFO) |
| identity cap / gap EWMA | inline | 1024 ids; `0.8 * old + 0.2 * gap` | `Baselines.noteIdentity` | identical-request gap baseline |
| usual-rate guard | inline | `older >= 3`, `span >= 20000` ms | `Baselines.rate` | when `usual` is reported |
| `MIN_COMPLETIONS` | const | 20 | `learn/profiles.ts` | completions before any profile anomaly; also per-field minimum for kind anomalies |
| `RARE` | const | 0.01 | `learn/profiles.ts` | rarity threshold (`seen < 0.01 * of`) |
| `MAX_SETS` / `MAX_FIELDS` | const | 64 / 128 | `learn/profiles.ts` | per-profile caps |
| profile signature cap | inline | 2000 | `Profiles.add` | profiles kept (FIFO) |
| write buckets | fn | `0`, `1`, `2`, `3-4`, `5+` | `writesBucket` | shape component |
| duration buckets | fn | `<50ms`, `50-200ms`, `0.2-1s`, `1-5s`, `>5s` | `durBucket` | recorded, never checked |
| `PROFILED` | const | fetch, xhr, user, task, ws | `runtime.ts` | op kinds that get profiles |
| `PROFILE_KEY` | const | `"genclass.profiles.v1"` | `runtime.ts` | localStorage key with `learn.persist` |
| `STALL_MIN_MS` | const | 500 | `runtime.ts` | stall fires at `max(4 × median, 2 × p95, 500)` ms |
| `LONG_RUNNING_MS` | const | 10000 | `runtime.ts` | in-flight ops older than this do not block settled points |
| `settleMs` | option | 60 ms | `InitOptions.settleMs` | quiet time before a settled point |
| `triage` | option | `"salient"` | `InitOptions.triage` | `"always"` consults on every trigger |
| `situation.budget` | option | `"auto"` | `InitOptions.situation` | situation size in chars |
| `learn.persist` | option | false | `InitOptions.learn` | persist transition profiles |
| `MAX_FACTS` | const | 12 | `situation/facts.ts` | facts kept after ordering |
| `WINDOW` | const | 10000 | `situation/facts.ts` | repetition / pending-local-change window |
| plugin fact length | inline | 240 | `buildSituation` | plugin fact truncation |
| timeline source | inline | last 96 events | `timelineLines` | events considered for the timeline |
| `STATE_CHAR_BUDGET` | const | 3200 | `situation/serialize.ts` | full budget; default when no budget given. The `serialize.ts` comment assumes ≈ 3.2 chars/token (≈ 1,000 tokens); TRAIN measured ≈ 2.4 (`training/NEEDS.md` item 6a), i.e. ≈ 1,300–1,400 tokens ([model-io-contract](../model-io-contract.md)) |
| `COMPACT_BUDGET` | const | 1100 | `situation/serialize.ts` | budget at and below which section limits are smallest |
| `MIN_BUDGET` | const | 500 | `situation/serialize.ts` | smallest budget honoured |
| `LIMITS` | const | facts 12, in_flight 6, timeline 16, state 8, stats 4 | `situation/serialize.ts` | full-budget section counts |
| compact counts | inline | facts 6, in_flight 2, timeline 3, state 3, stats 1 | `sectionLimits` | compact section counts |
| line limits | inline | compact -> full: app 60->120, trigger 180->240, facts 220->260, in_flight 90->120, timeline 100->140, state 100->150, stats 110->140 | `sectionLimits` | per-line truncation |
| fact/trigger shortening floor | inline | 60 chars | `toJevState` | last-resort shortening |
| `COMPACT_QUESTIONS_BUDGET` | const | 1400 | `situation/questions.ts` | compact questions at or below |
| `COMPACT_DESC_MAX` | const | 24 | `situation/questions.ts` | vocabulary overrides kept in compact questions |
| auto budget | fn | webgpu/unknown 3200; wasm 1000/1333/1667/2000 for 1/2/3/4+ threads | `RuntimeImpl.situationBudget` | device sizing |
| `budgetScale` | field | 1, `× 0.8` per `max_tokens_exceeded`, floor 0.5 | `RuntimeImpl` constructor | shrinks auto budgets |
| `REDACTED` | const | `"[redacted]"` | `util.ts` | redaction marker |
| `redact` | option | `defaultRedact` | `InitOptions.redact` | replaces the redactor for every situation sentence |
| `app` | option | `document.title` + `location.pathname` | `CreateOptions.app` (`RuntimeImpl.appInfo`) | source of the `app` section (`"<title> — <route>"`) |
| `vocabulary` | option | none | `InitOptions.vocabulary` | `diagnoses` replaces `DEFAULT_DIAGNOSES`; `actions` overrides descriptions |
| `historySize` | option | 500 | `InitOptions.historySize` (`EventLog`) | events kept; the timeline reads the last 96 of them |
| `HIST` / `LOG` | const | 16 / 512 per field | `state/hub.ts` | rich history (before/after, used by M5 before-values, M10, I2) / version log (M2/M3 counts, `versionAt`) |
| `RECENT_MS` / `RECENT_MAX` | const | 10000 ms / 256 | `state/hub.ts` | `hub.recent` window for identical-change facts (M12, ask) |
| identical-request registry | inline | 12 ops per identity, 512 identities | `RuntimeImpl.registerIdentity` | `SitEnv.identical`, R3 |
| recent errors | inline | 64 kept, 10 s window | `RuntimeImpl.reportError` / `makeEnv` | E5, ask |
| consistent snapshots | inline | 8 kept | `RuntimeImpl.settled` | `lastConsistent`, `consistentBefore`, I3/T5/E6, rollback |
| `storeWriters` caps | inline | 1000 signatures; writer + 8 ancestors | `RuntimeImpl.onApplied` | M7, timeline relevance, involved stores |
| profile queue | inline | 2000 ops | `RuntimeImpl.queueProfile` | ops waiting for a settled point |
| profile save delay | inline | 5000 ms | `RuntimeImpl.saveProfilesSoon` | with `learn.persist` |
| `defer` limit | inline | `m.defers < 2` | `builtinApplicable` | defer offered at most twice per write |
| `retry` limit | inline | `op.attempt < 4` | `builtinApplicable` | retry offered for attempts 1-3 |
| fact list caps | inline | M2-M4/M10/M15: first 3 paths; M5: 2 fields; M6: 3 ops listed; M14: 2; R3: last 3; R4: 3; F3/E3: 4 paths; I1: 3 violations, I2: 2 writes each; T1: 3; T4: 3; ask: 5 chain keys, 6 fields, 2 violations | `facts.ts` | sentence counts per trigger |
| per-sentence truncations | inline | `opLabel` 90; in-flight/timeline op phrase 80; error message 120 (subject, E1), 80 (short subject), 100 (timeline); error source 60; network message 50; `statusText` error text 40; op detail in M6/R4 30; plugin fact 240; store `describe()` 110 (90 when the store path itself is involved) | `describe.ts`, `facts.ts`, `build.ts` | applied before section line limits |

## Invariants and gotchas

- **Train/runtime parity.** Any change to `src/situation/*`, `src/learn/*`, the formatters in `src/util.ts`
  (`secs`, `rel`, `fmtNum`, `ratio`, `truncate`, `describe`, `normalizePath`), `changeText` in
  `src/state/fields.ts`, or op details produced by observers changes model inputs. The final-round training data
  comes from tag `situation-v1` (no model is deployed yet: the 0.1.0-alpha.0 runtime takes no actions until the model
  package is published, per `OPEN_TASKS.md`); a change needs new sim data (`sim/`), an update of
  `training/curriculum/rt.py` (Python port
  of facts/describe/build/serialize/questions), retraining and new eval. Coordinate with SIM and TRAIN (STATUS.md:
  "Any change to situation wording must be coordinated with SIM").
- **Model input also lives outside `src/situation/`.** Timeline lines include `ActionEffect.changed` sentences
  (`runtime.ts`, `observe/fetch.ts`, `observe/xhr.ts`, e.g. `Dropped the write to …; search stays at version 3.`),
  the undo text `undid <action> (<id>)`, the failed-action text `Tried to <action> <subject> but it failed; …`,
  hub write summaries (`changeText`), op details produced by observers (`redactSearch`, body summaries), and
  `rt.user` target/value strings. Rewording any of these changes training inputs exactly like a fact change does.
- **What the sim exercises.** `sim/src/run/rt.ts` -> `createOptions` runs the real runtime with `model: false`, a
  scripted `decider`, `mode: "heal"`, `triage: "salient"`, `historySize: 500`, observers `fetch`, `timers`,
  `websocket` only (xhr, user DOM, errors, nav, storage, perf off), a fixed `situation.budget`, and the module named
  by env `GENCLASS_RUNTIME` (default `@genclass/runtime`). User actions and errors are fed directly through
  `runtime.user(...)` and `runtime.reportError(...)` (`sim/src/run/runner.ts`). XHR request/failure/stall
  situations and `nav`/`storage`/`perf` timeline lines come only from disabled observers, so sim rows should not
  contain them (inferred from `createOptions`; not checked against generated data).
- **Determinism.** Read time only from `env.now()` (injected clock). No `Date.now`, `Math.random`, locale formatting
  or iteration over unordered structures. Sorts must be stable with explicit tie-breaks (as in `orderFacts`,
  `inFlightLines`). Tests assert byte-identical situations.
- **Side-effect free.** Situation code must not create ops, push events or write stores. The single allowed write is
  `C.reads.set(path, vStart)` in `mutationFacts`. (On the runtime side, the `SitEnv.recentErrors()` implementation in
  `RuntimeImpl.makeEnv` also prunes entries older than 10 s from `RuntimeImpl.errorsRecent`; this only drops expired
  entries.) The sim relies on `rt.situation()` not perturbing counterfactual replays (sim/NEEDS.md item 5).
- **Fail open.** Exceptions in `computeFacts`/`buildSituation` run the passive action; plugin `facts()` and
  `applicable()` throws are swallowed.
- **Triage is cost, not policy.** A `neutral` flag must never encode "this is a bug". Making facts non-neutral
  increases model calls and **holds** (writes/requests wait up to the hold budget): OPEN_TASKS lists hold-induced
  latency (search clean-run latency 14 -> 125 ms with v0.1) and typeahead being salient about 6 times per clean trial.
- **Neutral is per trigger for R3/R5.** The same repetition/streak fact is salient on `request` but neutral on
  `failure`/`stall`; R7 (hot rate) is salient on all three.
- **Fact order matters beyond the model.** The budget keeps the first facts; `decide/report.ts` and devtools
  `topFact` (`devtools/ui.ts`) pick the first fact not matching `^This (write|request) (comes from|has no known
  cause)` as the headline. Renaming provenance wording breaks that regex.
- **Two fact lists.** `Situation.facts`/`Decision.facts`/`explain()` hold up to 12 ordered facts; `state.facts`
  holds what fits the budget (at least 1). Plugin facts rank last and are the first to be cut.
- **No action question with a single action.** E.g. `error` without a revertable chain offers only `ignore`, so
  `questions.action` is absent and the gate sees no action answer (passive).
- **Compact thresholds differ.** Section limits bottom out at 1100 chars; compact questions start at <= 1400.
- **Budget is characters, not tokens.** Overflow in the model host raises `max_tokens_exceeded`, which permanently
  shrinks auto budgets for the runtime instance (fixed numeric budgets are not scaled).
- **`opts.describe` bypasses redaction.** A store's custom `describe()` output is printed as is in state lines.
- **Normalised chain keys.** `OpRec.chain` keys are normalised (`:id`), and transition `involvedFields`,
  `transitionFacts` (T4) and `SubjectRef.paths` use them; such paths have no leaf, so their state lines and
  `is now` facts are silently skipped.
- **Baselines cover fetch/XHR only.** WebSocket/task subjects get no stats line, and M8 (cause latency) is only
  computed for fetch/XHR causes.
  4xx responses are non-failures (they reset the streak and add latency samples) but do not update `lastSuccess`.
  Latency baselines never include failed/timed-out requests, so they underestimate slowness during outages.
- **Rarity needs `seen == 0` up to 100 completions** (`seen < 0.01 * of`). Profiles check before adding, and
  descendants win over ancestors when both are unusual.
- **Eviction is FIFO** for baselines (1000 signatures), identities (1024), profiles (2000): a long-lived hot
  signature can be evicted by many new ones.
- **`lastBuilt` only updates past the cheap pass**, so `rt.situation("mutation")` can return an old situation or a
  relabelled "ask about now" one.
- **`rt.situation()` is always `salient: true`.** With no argument (or no stored situation for the trigger) it builds
  an `ask` situation, and `ask` is salient by definition. The devtools Now view (`devtools/index.ts`, which calls
  `rt.situation()`) therefore always shows the "salient: the model would be asked" chip. To judge triage of a real
  trigger, check whether any fact is non-neutral (`computeFacts`) or use `rt.situation(trigger)` after that trigger
  was built.
- **Facts are computed before the subject proceeds.** For `failure`, the failed op is already ended and in the
  baselines (fetch and XHR call `endOp` before raising the trigger; streak/outcome counts include it); for `mutation`, the write is not yet applied (M15 describes the
  pending change, state lines show the current value).
- **`Profiles.load` trusts its input.** It only checks `sig` (string) and `n` (number) per entry and does not apply
  the 2000-signature cap; a corrupt `genclass.profiles.v1` entry with missing maps can throw later in `check`/`add`
  (inside `settled()`, unguarded) (unverified: not tested).
- **Dead declarations.** `SigStats.firstStart` and `SigStats.failures` (lifetime failure count) are written but
  never read; `SigStats.errEwma` is read only by `Baselines.snapshot()`, which nothing in `src/` calls;
  `SitEnv.writtenByChain` is never implemented; `isTrigger` is never imported. Removing them changes no model input.
- **Past bugs fixed in batch 3 (keep fixed):** "started X after/before" uses the real direction
  (`test/review-fetch.test.ts`); failure facts use real counts, not the EWMA; version counts come from the 512-entry
  log, not the 16-entry history (`test/review-hub.test.ts`); "changed twice and is back to 6" instead of "6 → 6";
  parent paths never print `= undefined`; array kinds are empty/non-empty only (short last page is not unusual);
  digit-containing entity keys normalise to `:id` (`test/review-precision.test.ts`); redaction by word meaning.

## How to change it safely

**Change a fact's wording or add a fact**
1. Edit the relevant function in `packages/runtime/src/situation/facts.ts`; pick `kind` (sets rank) and `neutral`
   deliberately (see Triage). Keep numbers explicit and relations stated ("after", "newer", "in a row").
2. Check consumers of the wording: `decide/report.ts` and `devtools/ui.ts` regex on provenance; tests that match
   text (`grep -rn "state.facts" packages/runtime/test`).
3. Update the Python port `training/curriculum/rt.py` (same computation and ordering).
4. Update tests: `test/situation.test.ts`, `test/batch3.test.ts`, `test/budget.test.ts`, plus any review test
   matching the text. Update the example blocks in `packages/runtime/STATUS.md`.
5. Run locally (lead policy, [where to run things](build-test-release.md#where-to-run-things)) or on the VM: `cd packages/runtime && npx vitest run test/situation.test.ts test/budget.test.ts
   test/learn.test.ts test/batch3.test.ts test/review-*.test.ts` (then the full suite; see
   [build-test-release](build-test-release.md)).
6. Flag the parity break: new sim data, retraining, a new freeze tag (after `situation-v1`).

**Change a triage threshold** (e.g. 3× latency in M8, `close` in R3, hot rate in R7): edit the `neutral` expression
in `facts.ts`; add a test that a benign case stays quiet (pattern: `test/review-precision.test.ts`) and a positive
case reaches `decider.calls`; mirror in `training/curriculum/rt.py`; regenerate sim data (the set of rows changes).

**Change budgets or section limits**: `serialize.ts` (`STATE_CHAR_BUDGET`, `COMPACT_BUDGET`, `LIMITS`, the `lerp`
endpoints) and/or `RuntimeImpl.situationBudget`; update `test/budget.test.ts` expectations, `section_limits` /
`to_state` in `training/curriculum/rt.py`, sim budget sampling in `sim/src/world/scenario.ts`, the doc comment on
`InitOptions.situation` in `types.ts`, and `docs/runtime/API.md`. Check the model host's maximum sequence length.

**Add a trigger kind**: `TriggerKind` (`types.ts`), `SubjectSpec` (`env.ts`), `subjectOf`, `subjectOp`,
`involvedStores`, `involvedFields`, `builtinApplicable`, `subjectRef` (`build.ts`), `computeFacts` (`facts.ts`),
`TRIGGER_ACTIONS`, `PASSIVE`, `ACTION_INSTRUCTIONS` (`questions.ts`), a raise site with a `Controller` in
`runtime.ts`/observers, the sim and the Python port. `isTrigger` derives from `TRIGGER_ACTIONS`.

**Add or reword a built-in action**: `BUILTIN_ACTIONS` (tier + description), `TRIGGER_ACTIONS` (order: passive
first), `builtinApplicable`, the controller's `run()` for that trigger in `runtime.ts`/observers, policy tiers
([decide-policy-actions](decide-policy-actions.md)), `ACTIONS`/`TRIGGER_ACTIONS` in `training/curriculum/rt.py`, the
fake runtime in `sim/src/run/fake-runtime.ts`, `TIER` in `sim/src/oracle/cost.ts`, `ACTION_PARA` in
`sim/src/run/transform.ts`, `PASSIVE` in `sim/src/types.ts` (passive actions), `ACTION_DESC`/`TRIGGER_ACTIONS`/`TIER`
in `training/curriculum/fmt.py`, `TIER`/`PASSIVE` in `training/eval_runtime.py`; full list:
[model-io-contract recipes](../model-io-contract.md#recipes).

**Change the diagnosis vocabulary**: `DEFAULT_DIAGNOSES` (keep `expected` first; `test/batch3.test.ts` asserts
`unusual`, `transient` are last), `DEFAULT_DIAGNOSES` in `sim/src/world/scenario.ts` (the sim passes it explicitly
when the runtime lacks a label), `DIAG_PARA` in `sim/src/world/scenario.ts`, `DIAGNOSES` in `sim/src/types.ts`, the
rules in `sim/src/oracle/diagnose.ts`, `DIAGNOSES` in `training/curriculum/rt.py`, `DIAG_DESC` in
`training/curriculum/fmt.py`, CONTRACT §6; full list: [model-io-contract recipes](../model-io-contract.md#recipes).

**Change baseline estimators or profile rarity**: `baselines.ts` / `profiles.ts`; update `test/learn.test.ts`,
`test/review-precision.test.ts`, `test/situation.test.ts` (stall timing depends on median/p95). Note that
`watchStall` timing and facts R7-R9, S1, M8 all read these values.

**Change redaction**: `isSensitiveName`/`SECRET_WORDS`/`SECRET_PAIRS` in `util.ts`; update `test/batch3.test.ts`
(SIM a) and `test/review-redaction.test.ts`; `docs/runtime/API.md` "Privacy".

**Add a fact kind**: `FactKind` in `types.ts`, its rank in `RANK` (`facts.ts`; typed `Record<FactKind, number>`, so
the compiler forces an entry), `RANK` in `training/curriculum/rt.py`. Rank decides which facts survive the budget,
and the report/devtools headline skips only provenance.

**Change timeline or action-effect wording**: `eventLine` (`describe.ts`), the hub's write summary
(`state/hub.ts`, `changeText` in `state/fields.ts`), `ActionEffect.changed` strings (`runtime.ts`,
`observe/fetch.ts`, `observe/xhr.ts`), `event_lines` / `phrase` in `training/curriculum/rt.py`; update the STATUS.md
example blocks; treat it as a parity break like a fact change.

**Change what `stats` or `in_flight` show**: `statsLines` / `inFlightLines` (`build.ts`). Keep the sort keys
explicit (score, then start time) for determinism; budget tests assert per-section maxima.

## Tests

| test file | what it asserts |
|---|---|
| `packages/runtime/test/situation.test.ts` | one situation per trigger (except `ask`): key order, <= 12 facts, <= 16 timeline, <= 8 state lines, `stateChars <= 3200`, `diagnosis` present; first-fact text for mutation (stale write, M2), stall (`has been in flight for …; GET /api/report/:id usually takes`), inconsistency (relation values), transition ("only cart.items") and error (`Uncaught TypeError: `); some fact matches for request (identical POST in flight) and failure (`3rd GET /api/status failure in a row`); the card number value `4242` never appears in the state; inconsistency offers exactly `ignore, rollback`; transition raised once (descendant wins); `situation()` side-effect free and `trigger: "ask"`; serializer: an over-budget input ends with `timeline: "none"`, an under-budget one keeps all 16 timeline lines and empty sections become `"none"`; byte-identical determinism at the default budget |
| `packages/runtime/test/learn.test.ts` | baselines: no latency before 5 samples, nearest-rank median/p95, EWMA, streak, `!` outcomes, aborted ignored, `rate` recent/usual, identity `gapEwma`; profiles: < 1% of >= 20, op that usually writes nothing, kind and status anomalies, end-to-end transition with chain rollback |
| `packages/runtime/test/budget.test.ts` | `sectionLimits` at 1100/2000/3200/500; budgets 1000/1100/2000 respected per section with the stale-write fact first; compact questions at <= 1400 and overrides <= 24 chars; determinism at 1100; auto budget by device/threads; `max_tokens_exceeded` -> 2560; hold budget |
| `packages/runtime/test/batch3.test.ts` | `isSensitiveName` positives/negatives; no `= undefined` state lines; item change summary; "changed twice … and is back to 6"; slug-id signatures; pending-local-change fact (M10) is first and salient; `transient` label last |
| `packages/runtime/test/review-precision.test.ts` | short last page and `m<n>` keys are not unusual transitions; closing a selection is not an inconsistency |
| `packages/runtime/test/review-redaction.test.ts` | a custom `redact` also applies to invariant facts |
| `packages/runtime/test/review-hub.test.ts` ("field versions in facts") | "written 20 times by other operations" and "(version 0 → 20)" past the 16-entry history |
| `packages/runtime/test/review-fetch.test.ts` ("request facts") | "started 0.10s after this one" direction; error-rate text matches listed outcomes |
| `packages/runtime/test/review-actions.test.ts` | "Its chain wrote no state before the error." and rollback not offered then |
| `packages/runtime/test/invariants.test.ts` | learned-relation fact values; developer invariant fact text |
| `packages/runtime/test/dom.test.ts` | error fact `Uncaught TypeError: boom (at app.js:12).` |
| `packages/runtime/test/plugins.test.ts` | plugin facts reach the model; vocabulary overrides; `applicable()` gating; standing questions |
| `packages/runtime/test/atoms.test.ts`, `smoke.test.ts`, `review-xhr.test.ts` | identical additive change is salient (held); nothing salient applies synchronously; identical XHR just sent is salient |
| `packages/runtime/test/ask.test.ts` | `ask()` sends trigger `ask` with questions replaced by `{ answer }` and trigger sentence `The developer asks about the app right now.`; `about: opId` -> `The developer asks about GET /api/x (#n).`, `about: "cart"` -> `The developer asks about the store cart.` |
| `packages/runtime/test/review-precision.test.ts` ("design risk") | a lingering benign violation must not freeze the latest consistent snapshot (snapshot `seq` keeps advancing) |
| `packages/runtime/test/devtools-runtime.test.ts` | the Now view renders `runtime.situation()`; evidence view shows `explain()` facts and situation text |

## Drift and open issues

- **Auto budget doc comment** (`types.ts` -> `InitOptions.situation`): says "wasm 1,100 + 300 per extra thread up to
  4 threads: 2,000". Code (`RuntimeImpl.situationBudget`) and tests: `1000 + round((threads - 1) * 1000 / 3)` ->
  1000/1333/1667/2000. API.md and STATUS.md match the code.
- **Default redactor doc comment** (`types.ts` -> `InitOptions.redact`): says regex
  `/pass|token|secret|card|cvv|ssn|auth/i`. Code uses word-level `isSensitiveName` (approved deviation; API.md is
  correct; CONTRACT §2 still has the regex).
- **CONTRACT §4 transition profiles**: lists value kind with "length delta sign; null" and a duration bucket as part
  of the shape. Code: arrays are only empty/non-empty (documented deviation in STATUS.md), duration is never checked,
  and two precision rules are not in the contract (no `set` anomaly when the usual set is empty; no `writes` anomaly
  when the usual bucket is `"0"` or a `set` anomaly exists).
- **CONTRACT §6 budget**: "≤ 1,000 tokens; truncate timeline first, then state, then facts". Code: characters
  (3200 chars, ≈ 1,300–1,400 tokens at the measured 2.4 chars/token), device-sized, then in_flight, stats, and fact/trigger shortening. CONTRACT §6's
  `runtime.situation()` shape omits `salient`, `facts`, `compact`, `budget`.
- **`rollback` description vs effect**: `BUILTIN_ACTIONS.rollback` says "restore the affected state to its last
  consistent snapshot" for `inconsistency`, `transition` and `error`, but transition/error rollback restores only the
  op chain's own writes (`RuntimeImpl.revertChain`). The model reads a description that does not match the effect on
  2 of 3 triggers; fixing it changes model inputs.
- **Unreachable fact M11**: `This write could not be held: …` is emitted only for `m.unholdable`, but
  `StoreHub.propose` (`state/hub.ts`) commits unholdable writes immediately without calling `hooks.gate`, and
  `RuntimeImpl.gateMutation` is the only place that raises `mutation` triggers. STATUS.md (batch 3) says such writes
  apply "with a fact".
- **STATUS.md triage summary** says "cause latency > 3× median"; code also requires `lat − median >= 100 ms`. It says
  identical requests within "min(2 s, half its usual gap)"; code uses the usual gap only after more than 3 sightings
  of the identity.
- **ARCHITECTURE.md** lists diagnoses as "…failing, transient, slow, overload or unusual"; code order puts
  `transient` last. Its fact example shows "(v0 → v1)"; code prints "(version 0 → 1)".
- **API.md** says plugin facts are "added to every situation": they are added only to situations that are built
  (past the cheap triage pass, or `situation()`/`ask`), are neutral, rank last and may be cut by `MAX_FACTS` or the
  budget.
- **sim/NEEDS.md** note "`transient` is not yet in `DEFAULT_DIAGNOSES`" is stale; it is (last).
- **CONTRACT §6 applicability footnote** is looser than `builtinApplicable`: `coalesce` also needs fetch transport
  and a shareable in-flight/just-finished response (`canCoalesce`); `retry` needs replayable, `attempt < 4` and
  fetch; `hedge` also needs GET and fetch; `serve_cached` on failure/stall needs fetch; error `rollback` needs an
  ambient op whose chain write is still the latest with a known previous value in a writable store. XHR therefore
  never gets `coalesce`/`retry`/`hedge` or failure/stall `serve_cached` (request-trigger `serve_cached` has no
  transport check); STATUS.md "Deviations" states the XHR part.
- **CONTRACT §6 timeline** says "≤ 16 most recent relevant events"; `timelineLines` tops up with recent
  non-relevant events when fewer relevant ones exist.
- **CONTRACT §6 triage examples** ("a baseline ratio beyond 3×", "written by another op") are coarser than code:
  M8 also needs `lat − median >= 100 ms`, R7 needs `recent >= 5`, M2 counts other *chains* (not other ops), and
  failure-streak/repetition facts are salient only on `request`.
- **API.md `rt.situation()`** lists `{ trigger, subject, state, questions, actions, salient, facts }`; the
  `Situation` type also has `compact` and `budget`.
- **API.md / README "cheap facts are computed for every write and request"**: facts are computed only when the
  runtime is consultable (a `DecisionProvider` exists, its state is `ready` or `off`, not paused or destroyed) and
  only for gated writes/requests (GenClass-owned ops and bypassed writes never trigger).
- **Sim vs Python budget mix**: the sim samples 3200/2000/1000 at 40/30/30 (`sim/src/world/scenario.ts`), the
  Python curriculum at 35/30/35 (`training/curriculum/rt.py` -> `BUDGETS`). Not a parity bug for a single row, but
  the two data sources have different budget distributions.
- **Python port drift** (`training/curriculum/rt.py` -> `to_state`): last-resort fact shortening floor is 40 chars
  (runtime 60) and the trigger is never shortened. Only reached when one fact or the trigger alone exceeds the
  budget. Also: `secs`/`rel`/`fmt_num` round exact binary ties half-even (Python format) vs `toFixed` half-up
  (125 ms -> `0.12s` vs `0.13s`); `secs` >= 1000 s and `ratio` >= 10× use Python `round()` vs `Math.round`; rt.py
  `truncate` counts code points, `util.truncate` UTF-16 units (see
  [model-io-contract gotchas](../model-io-contract.md#invariants-and-gotchas)).
- **`Situation.subject` doc comment** (`types.ts` -> `Situation`): says "One sentence naming the subject"; code
  (`buildSituation`) fills it with the short subject phrase from `subjectOf` (e.g. `write to search.results from GET
  /api/search?q=rea (#6)`), while the full sentence goes to `state.trigger`.
- **Open (OPEN_TASKS.md)**: "Next" item 6 lists hold-induced harm and triage sensitivity on naturally concurrent apps
  (typeahead salient about 6 times per clean trial) to investigate with the trained model; "Known risks" lists thin
  `conflict` and `transition` rows.

## Related docs

- [public-api-and-lifecycle](public-api-and-lifecycle.md): `InitOptions` (`triage`, `situation.budget`, `learn`,
  `redact`, `vocabulary`), `rt.situation()`, `rt.ask()`.
- [observe-and-trace](observe-and-trace.md): ops, signatures, identities, op details, events.
- [state-and-adapters](state-and-adapters.md): mutation pipeline (which writes are gated), invariant miner,
  settled points, consistent snapshots.
- [decide-policy-actions](decide-policy-actions.md): what happens after a situation is submitted (queue, hold,
  gate, actions, reports, explain).
- [model-host](model-host.md) and [model-io-contract](../model-io-contract.md): how the `JevState` and questions
  become packed model input and calibrated answers.
- [devtools](devtools.md): where facts and situations are displayed.
- [sim](../sim.md), [training](../training.md): consumers of this exact output; parity and regeneration.
- [status-and-known-issues](../status-and-known-issues.md), [glossary](../glossary.md).
- Existing human docs: [CONTRACT.md](../../runtime/CONTRACT.md) §4-§7, [API.md](../../runtime/API.md),
  [ARCHITECTURE.md](../../runtime/ARCHITECTURE.md), [packages/runtime/STATUS.md](../../../packages/runtime/STATUS.md)
  (example situations per trigger).
