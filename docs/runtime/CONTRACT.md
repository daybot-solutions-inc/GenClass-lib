# @genclass/runtime: build contract (binding)

GenClass Runtime is a client-side intelligence layer for web apps. It runs entirely in the browser. It
observes what the app is doing (user actions, async operations, network, state changes, errors, timing,
causality, recent history), turns the current situation into a typed-question request for the local GenClass
model (ONNX on WebGPU/WASM, cached in the browser), and acts on the answer through safe, generic, extensible
actions.

```ts
import { GenClass } from "@genclass/runtime";
GenClass.init();
```

This file binds every workstream. If something here is wrong, tell the lead; do not silently diverge.

## 0. Ground rules

1. **No hardcoded bugs, patterns, recoveries or demo rules in the runtime.** The runtime may compute *generic,
   uniform facts* (happens-before order, versions, repetition counts, failure streaks, latency vs learned
   baselines, learned invariants, value deltas) and it may decide *whether a situation is worth asking the
   model about* (triage). It must never map a fact pattern to a diagnosis or an action with an if/then.
   Diagnoses and actions come from the model. If the model is unavailable, the runtime observes only and
   always takes the passive action.
2. **Train/runtime parity.** The training data generator (`sim/`) drives the real runtime code (same trace,
   same facts, same serializer, same questions) in a deterministic virtual world. There is exactly one
   implementation of situation building and serialization: `packages/runtime/src/situation/*`.
3. **Determinism.** Runtime code never calls `Math.random`, `Date.now` or `performance.now` directly, and never
   schedules with the global `setTimeout`. It uses the injected `Clock` (section 3). IDs come from counters.
4. **Honest evaluation.** The demos (`demos/`) and the generator (`sim/`) are built by different people who do
   not read each other's code. The sim never models a demo; demos never contain hints for GenClass beyond what
   any app integration would contain (stores, optional resync handlers, optional custom actions/questions in
   the extensibility demo).
5. **Mac safety.** The Mac only edits files. Every build, test, browser and model run happens on the `train`
   VM via `scripts/vm.sh` (use your own slot). Never run `npm install`, `tsc`, `vitest`, Playwright or a model
   locally.
6. TypeScript, strict mode, ESM only. Node 22 on the VM. No new runtime dependencies besides
   `onnxruntime-web` without asking the lead.

## 0.5 Product principles (from the user, 2026-10-07; binding)

The narrow, real claim: **install one library; find and prevent runtime failures automatically, with low false
positives.** Three things kill the product, and the design answers each:

1. **False positives.** If GenClass "heals" correct code and creates a bug, developers uninstall it. So: the
   default mode only takes minimal, reversible *guard* actions at very high calibrated confidence; a non-passive
   action also requires the model's own diagnosis to say something is wrong; false-intervention rate on clean
   runs is a first-class metric in the sim test split and in every demo.
2. **Performance.** Tiered detection: generic facts and learned baselines run always and cost ~nothing; the
   model is consulted only for salient situations (triage), runs in a worker, loads at idle or lazily, and is
   cached. Target a small runtime-specialist model (pruned vocabulary + int8 embeddings, ≤ 25 MB q8).
3. **Magic without observability.** Developers must see exactly what GenClass observed and what it changed:
   one plain-English console line per detection/intervention with collapsible evidence, `explain(id)`, undo for
   reversible actions, responses marked with `x-genclass`, and a kill switch (`?genclass=off`).

Adoption path = modes: **observe** (find anomalies you didn't know existed) → **guard** (prevent only
extremely-high-confidence failures; default) → **heal** (broader autonomous recovery).

The console should read like:
```
[GenClass] Prevented a stale write: GET /api/search?q=rea (started 1.8 s ago) would have overwritten
           search.results written 0.4 s ago by a newer GET /api/search?q=react. Dropped it. (stale, 0.97)
[GenClass] Coalesced a duplicate: POST /api/orders was sent again 90 ms after an identical one from the
           same click. Reused the first response. (duplicate, 0.95)
[GenClass] Flagged: POST /api/cart usually writes cart.items and cart.total (317 of 317 times); this time it
           wrote only cart.items. (unusual, 0.88)
```

## 1. Repo layout (branch `runtime` of daybot-solutions-inc/GenClass-lib)

```
package.json                 npm workspaces: packages/*, sim, demos
tsconfig.base.json
packages/runtime/            @genclass/runtime (the library)          owner: CORE (+ MODEL for src/model/**)
  src/index.ts               public facade (GenClass, types, createRuntime)
  src/runtime.ts             Runtime class wiring
  src/types.ts               public types
  src/clock.ts               Clock + browserClock
  src/trace/                 events ring buffer, ops, context propagation
  src/state/                 store hub, atom, guard, diff/summaries, invariant miner, snapshots
  src/observe/               fetch, xhr, dom-user, errors, nav, storage, perf, websocket observers
  src/learn/                 online baselines (latency, error rate, frequency)
  src/situation/             facts, serializer, questions, triage   (SHARED WITH sim/)
  src/decide/                decider (queue, deadline, cache), policy, built-in actions, executor
  src/plugins.ts             plugin API
  src/adapters/              react.ts, redux.ts, zustand.ts                       owner: CORE
  src/devtools/              in-page overlay panel (shadow DOM, vanilla)          owner: CORE
  src/model/                 engine, packer, tokenizer, jev serializer, host, worker, loader   owner: MODEL
  bin/genclass-runtime.mjs   CLI: fetch-model                                     owner: MODEL
  test/                      vitest (+ happy-dom); test/browser Playwright
packages/runtime-model/      model card + files for the CDN package @genclass/runtime-model  owner: LEAD
sim/                         training-data generator (private package)            owner: SIM
training/                    Azure scripts: generate, train, export, calibrate, eval            owner: LEAD
demos/                       Vite multi-page demo site + Playwright eval          owner: DEMOS
docs/runtime/                CONTRACT.md (lead), ARCHITECTURE.md, API.md
scripts/vm.sh                VM helper
```

Existing GenClass content (jev_local/, extension/, docs/, etc.) stays as is. Do not edit it.

## 2. Public API (`@genclass/runtime`)

```ts
export const GenClass: {
  init(options?: InitOptions): Runtime;      // idempotent: a second call returns the same runtime
  readonly runtime: Runtime | null;
  destroy(): void;                           // uninstall observers, terminate worker
};
export function createRuntime(options?: CreateOptions): Runtime;   // advanced/headless (sim, tests, SSR-safe)

interface InitOptions {
  mode?: "observe" | "guard" | "heal";       // default "guard" (section 8). observe never changes execution.
  model?: {
    baseUrl?: string;                        // directory holding model.json (default: CDN of @genclass/runtime-model@<pinned>)
    device?: "auto" | "webgpu" | "wasm";     // default auto (webgpu+fp16 if shader-f16, else wasm+q8)
    worker?: boolean;                        // default true; inference in a module Worker, inline fallback
    preload?: "eager" | "idle" | "lazy";     // default "idle": download when the browser is idle after load (cached
                                             // afterwards); "lazy": only when the first salient situation appears
  } | false;                                 // false: no model (observe-only), or bring your own `decider`
  report?: "console" | "silent" | ((r: Report) => void);   // default "console" (section 8)
  observe?: Partial<Record<"fetch"|"xhr"|"user"|"errors"|"nav"|"storage"|"perf"|"websocket", boolean>>;  // default all true
  triage?: "salient" | "always";            // default "salient" (section 6)
  policy?: PolicyOptions;                    // section 8
  redact?: (path: string, value: unknown) => unknown;   // default redacts keys matching /pass|token|secret|card|cvv|ssn|auth/i
  plugins?: Plugin[];
  historySize?: number;                      // events kept, default 500
  debug?: boolean;                           // console logging of decisions
}

interface Runtime {
  readonly ready: Promise<void>;             // model loaded (rejects if model: false? no: resolves immediately with status "off")
  readonly status: ModelStatus;              // { state: "off"|"loading"|"ready"|"error", progress?: {loaded,total}, device?, variant?, error? }

  // state
  atom<T>(name: string, initial: T, opts?: StoreOptions<T>): Atom<T>;
  guard<T>(name: string, io: { get(): T; set(v: T): void; subscribe?(fn: () => void): () => void }, opts?: StoreOptions<T>): Guarded<T>;
  expect(name: string, predicate: () => boolean): () => void;     // optional developer invariant

  // questions and decisions
  ask<Q extends Question>(q: Q, opts?: AskOptions): Promise<AnswerOf<Q>>;
  decide<L extends string>(question: string, options: Record<L, string>, opts?: AskOptions): Promise<L>;

  // subscriptions
  on(type: "detect", fn: (d: Detection) => void): () => void;
  on(type: "decide", fn: (d: Decision) => void): () => void;
  on(type: "act", fn: (a: ActionRecord) => void): () => void;
  on(type: "event", fn: (e: RtEvent) => void): () => void;
  on(type: "status", fn: (s: ModelStatus) => void): () => void;

  // operations, custom events, user actions (DOM observer and sim use the same entry points)
  op<T>(name: string, fn: () => Promise<T> | T, meta?: Record<string, unknown>): Promise<T>;
  emit(name: string, data?: Record<string, unknown>): void;
  user<T>(action: UserAction, handler?: () => T): T | undefined;    // records a user op and runs handler inside its context
  reportError(error: unknown, info?: { source?: string }): void;

  // extension
  use(plugin: Plugin): () => void;
  action(def: ActionDef): () => void;
  question(def: StandingQuestion): () => void;   // extra standing question asked on given triggers

  // introspection and control
  situation(trigger?: TriggerKind): Situation;   // what the model would see right now
  explain(id: string): Explanation | null;       // decision/action id -> situation text, facts, timeline, answers, what changed
  history(n?: number): RtEvent[];
  decisions(n?: number): Decision[];
  interventions(n?: number): ActionRecord[];     // only the non-passive actions that ran
  setMode(mode: "observe" | "guard" | "heal"): void;
  pause(): void; resume(): void; destroy(): void;
}
```

Kill switch: `?genclass=off` in the page URL or `localStorage.genclass = "off"` makes `init` install nothing
(one console line says so); `?genclass=observe|guard|heal` overrides the mode. This is for "is my app broken or
did GenClass change something?" debugging.

`StoreOptions<T>`: `{ resync?: () => Promise<unknown> | unknown; hold?: boolean (default true); describe?: (v: T) => string }`.
`resync` is an app capability ("reload this store from its source"); it enables the `resync` action for that store.

`Atom<T>`: `get(): T; set(next: T | ((prev: T) => T)): void; update(fn: (prev: T) => T): void; subscribe(fn: (v: T) => void): () => void; readonly name: string`.

Adapters (subpath exports): `@genclass/runtime/react` (`useGenClassState(name, initial, opts?)`, `useAtom(atom)`,
`useGenClass()`), `@genclass/runtime/redux` (`genclassEnhancer(runtime, { name })`), `@genclass/runtime/zustand`
(`genclass(runtime, name)(stateCreator)`), `@genclass/runtime/devtools` (`mountDevtools(runtime, opts?)`).

Typed questions use the Jev wire shape:

```ts
type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };
AnswerOf<{type:"noul"}>   = { type: "noul"; noul: number }                                  // P(true)
AnswerOf<{type:"choice", criteria: Record<L, …>}> = { type: "choice"; choice: L; confidence: number; probabilities: Record<L, number> }
AnswerOf<{type:"score"}>  = { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
AskOptions = { about?: "now" | number /* op id */ | string /* store name */; timeoutMs?: number }
```

`ask` uses the current situation (trigger `ask`) as the state. If the model is off it rejects with
`GenClassUnavailableError`.

## 3. Clock, context, events, ops

```ts
interface Clock {
  now(): number;                                   // ms, monotonic
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  afterTask(fn: () => void): void;                 // run fn after the current macrotask's microtasks drain
}
```
`browserClock` uses `performance.now`, the real timers captured at module load (so our own wrappers never
observe themselves), and a `MessageChannel` for `afterTask`. The sim supplies a virtual clock.

**Events.** `RtEvent = { seq: number; t: number; kind: EventKind; name: string; op?: number; cause?: number; data?: Record<string, unknown> }`
with `EventKind = "user" | "op.start" | "op.end" | "state" | "error" | "nav" | "perf" | "storage" | "custom" | "decision" | "action"`.
Kept in a ring buffer (`historySize`).

**Ops.** Every async operation is an `Op`:
`{ id, kind: "user"|"fetch"|"xhr"|"ws"|"task"|"timer"|"genclass", name /* signature, e.g. "GET /api/items/:id" */,
detail /* e.g. "?q=rea" or a body summary */, start, end?, status?: "ok"|"error"|"aborted"|"blocked",
code?, cause?: number /* parent op */, root?: number /* root op of the causal chain */, attempt: number,
reads: Map<string /* store.path */, number /* field version at start */>, identity?: string /* hash of method+url+body */ }`.
User actions are instantaneous ops (kind "user") so they can be causes. Signatures normalise ids in paths
(numbers, uuids, long hex → `:id`).

**Context propagation (best effort, documented as such).** An ambient "current op" is set:
- synchronously while a user handler runs (`runtime.user`, DOM observer at capture phase),
- inside `runtime.op`,
- when a wrapped fetch/XHR settles and when its Response body methods (`json`, `text`, `arrayBuffer`, `blob`,
  `formData`) settle: the ambient op stays set for the rest of that macrotask's microtask checkpoint and is
  cleared by `clock.afterTask`,
- in timer callbacks scheduled while an op was ambient (when the timers observer is on).
A state write records `cause = ambient op`. Ops started while another op is ambient get it as `cause`.

## 4. State

`StoreHub` keeps every registered store: `name`, `version`, a per-field version map (`path → { v, writer: opId|null, t }`),
current value, and snapshots. Paths are dotted top-level-first (`cart.items`, `cart.total`); arrays are one
field (`cart.items`) with element summaries.

**Mutation pipeline.** `set` → `Mutation { id, store, changes: [{path, before, after}], cause, root, t }` → triage →
(if salient and holdable) **held** until a decision arrives or `policy.holdBudgetMs` expires (fail-open: apply) →
applied in proposal order per store (a later-decided mutation waits for earlier ones on the same store) → `state`
event. Functional updates re-run against the value at apply time. Writes made synchronously inside a user
handler are never held (`policy.holdUserWrites`, default false). Writes performed by GenClass actions are never
gated.

**Invariant miner (generic, learned online).** At *settled* points (no in-flight ops, `settleMs` after the last
mutation, default 60 ms) the hub records a snapshot of all stores, flattened to fields. Candidate templates over
fields of all stores (capped, e.g. 64 numeric fields):
`a == b`, `a == len(B)`, `a == sum(B[*].f)`, `a == sum(B[*].f * B[*].g)`, `a >= 0`, `a ∈ B[*].k`,
`B[*].k unique`, `typeof a stable`, `a != null`. A candidate becomes *learned* after it held at ≥ 3 settled
snapshots where at least one involved field changed, and was never violated at a settled point while learning.
Candidates falsified while learning are dropped. Developer `expect()` predicates are learned from the start.
When a learned invariant is violated at a settled point, the hub raises an `inconsistency` trigger (once per
violation episode). The hub keeps the last snapshot at which all learned invariants held (`lastConsistent`),
for `rollback`. Invariants have no domain knowledge; they are templates over whatever fields exist.

**Transition profiles (generic, learned online).** For every op signature (and every user-action target), keep
counts over its completions of: the set of store fields its causal chain wrote, each written value's kind
(type; array empty/non-empty; length delta sign; null), the response status class, the number of writes, and
a duration bucket. At settled points, a completed op whose transition shape was seen in < 1% of ≥ 20 previous
completions raises a `transition` trigger with facts like "In the previous 317 completions of POST /api/cart it
wrote cart.items and cart.total; this time it wrote only cart.items." Profiles are per app session (in memory),
optionally persisted to `localStorage` behind `learn: { persist: true }`.

## 5. Facts (generic, uniform per trigger)

Facts are short English sentences produced by one module for every situation of a trigger kind, always the
same computations, ordered most-informative first, capped at 12. They state relations explicitly ("started
after this one", "newer", "identical", "in a row") and include the numbers. Examples of the *kinds* of facts:

- provenance: what caused the subject, its root user action/timer/load, how long ago it started;
- versions: for each written field, its version when the cause op started vs now, who wrote the versions in
  between, and whether those writers started after the cause op / came from later user actions;
- inputs moved: store fields that changed since the cause op started, and who changed them (e.g. user input);
- concurrency: other in-flight ops with the same signature or touching the same stores, with relative start order;
- repetition: identical requests (same identity) or identical changes (same store, paths and value) in the last
  10 s, how many, whether in flight, whether from the same user action or separate ones and how far apart;
- outcome history: failure streak for the signature, recent status codes/errors, time since last success;
- baselines: latency vs learned median/p95 (ratio), error rate, request frequency vs usual;
- invariants: which learned relation is violated, the values, which mutation broke it, age of last consistent state;
- value delta: compact `before → after` for each changed field (redacted).

## 6. Triggers, triage, questions

Trigger kinds and their **applicable built-in actions** (the first is the passive action):

| trigger | subject | actions |
|---|---|---|
| `mutation` | a state write about to apply (held) | `apply`, `discard`, `defer` |
| `request` | a fetch/XHR about to be sent | `send`, `coalesce`*, `delay`, `block`, `serve_cached`* |
| `failure` | a request failed (network error, timeout, 5xx, 429, 408) before the app sees it | `deliver`, `retry`*, `serve_cached`* |
| `stall` | an in-flight request is far past its learned latency | `wait`, `hedge`* , `serve_cached`* |
| `inconsistency` | a learned invariant broke at a settled point | `ignore`, `rollback`*, `resync`* |
| `transition` | a completed op's state transition differs from its learned profile | `ignore`, `rollback`*, `resync`* |
| `error` | uncaught error / unhandled rejection | `ignore`, `rollback`* |
| `ask` | developer question | (no actions) |

`*` = only offered when applicable (an identical request exists; a cached good response exists; the body is
replayable and the method idempotent for `hedge`; a consistent snapshot exists; a `resync` handler exists;
the failing op wrote state). Plugin actions are added to the triggers they declare.

**Triage** (`triage: "salient"`): the model is consulted only when at least one fact is non-neutral (e.g. a
field was written by another op since the cause op started, an identical request/change exists, a failure
streak or failure, a baseline ratio beyond 3×, an invariant violation, an error). Otherwise the passive action
runs with no model call and no decision record. `triage: "always"` consults on every trigger. Triage is a
cost filter, not a classifier: it never chooses a diagnosis or a non-passive action.

**Standing questions** (exact qids; plugins may add more):

- `action` (choice): one option per applicable action, `name: description` (descriptions in section 7).
  Instructions: "What should the runtime do with <subject>?" (wording owned by CORE, fixed per trigger).
- `diagnosis` (choice): the diagnosis vocabulary below (configurable, extensible via plugins).

Default diagnosis vocabulary:

| label | description |
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

**Situation** (Jev state object; keys in this order; arrays of strings render one per line):
`app` (title and route), `trigger` (one sentence naming the subject), `facts` (≤ 12), `in_flight` (≤ 6 or
"none"), `timeline` (≤ 16 most recent relevant events, oldest first, relative times like `-1.24s`), `state`
(≤ 8 relevant store fields, summarised and redacted), `stats` (relevant baselines or "none"). Budget: the
state must pack to ≤ 1,000 tokens with the GenClass tokenizer; truncate timeline first, then state, then facts.
`runtime.situation()` returns `{ trigger, subject, state, questions, actions }`.

## 7. Built-in actions (generic capabilities, never chosen by rule)

| action | tier | description given to the model | effect |
|---|---|---|---|
| `apply` | passive | let this write update the state now | apply |
| `discard` | guard | drop this write and keep the current state | drop; `set` caller is not notified; undo = apply it now |
| `defer` | guard | hold this write until the related in-flight operations finish, then decide again | re-trigger when they settle (max 2 defers, then apply) |
| `send` | passive | send the request now | pass through |
| `coalesce` | guard | do not send; reuse the result of the identical request that is in flight or just finished | share a clone of that response |
| `delay` | guard | wait before sending, backing off so the service can recover | wait min(250 ms · 2^streak, 8 s), then send |
| `block` | heal | do not send; fail this request immediately | resolve with a 503 `Response`, header `x-genclass: blocked` (XHR: status 503) |
| `serve_cached` | heal | answer with the last successful response for this request instead | cached clone, header `x-genclass: cached` |
| `deliver` | passive | pass the failure to the application as it is | pass through |
| `retry` | heal | retry the request after a short backoff | re-issue (same input), backoff min(200 ms · 2^attempt, 5 s); the retry is a new attempt |
| `wait` | passive | keep waiting for the request | none |
| `hedge` | heal | send a second identical request and use whichever answers first | idempotent GETs only |
| `ignore` | passive | leave the state as it is | none |
| `rollback` | heal | restore the affected state to its last consistent snapshot | write snapshot back (cause = genclass op); undo = restore the pre-rollback values |
| `resync` | heal | reload the affected state from its source | call the store's `resync` handler |

Guard-tier actions are minimal and reversible (they withhold, deduplicate or slow something down; they never
invent data or fail a request). Heal-tier actions change what the app receives or restore state. Plugin
actions declare their tier (default `heal`).

Responses are always cloned before the app reads them, so `coalesce`/`serve_cached` never consume a body twice.
The response cache keeps the last good response per GET identity (≤ 256 KB each, ≤ 64 entries, in memory only).

## 8. Policy, decisions, safety

```ts
interface PolicyOptions {
  thresholds?: { report?: number; guard?: number; heal?: number };  // defaults 0.6 / 0.9 / 0.8
  allow?: string[]; deny?: string[]; // action names
  holdBudgetMs?: number;             // default 300: max time a write/request waits for the model
  holdUserWrites?: boolean;          // default false
  maxActionsPerMinute?: number;      // default 60 non-passive actions; beyond it run passive and emit a warning
}
```
**Gate for a non-passive action** (all must hold, else the passive action runs and `reason` says why). Let
*A* = the applicable non-passive actions the mode permits (observe: none; guard: guard tier; heal: guard + heal),
minus denied ones (and only allowed ones, if `allow` is set). The candidate is the argmax of `probabilities` over
*A*; it runs only if the **summed calibrated probability of A** ≥ the candidate's tier threshold (i.e. the model
is that sure some permitted action beats doing nothing, which is robust when two good actions such as
`discard`/`defer` split the mass), the model's top diagnosis is not `expected` (unless `requireDiagnosis: false`),
it is under the rate limit, and the decision arrived within the hold budget (else late-revert rules apply).

Every model decision produces a `Decision { id, trigger, subject, at, latencyMs, model, diagnosis,
diagnosisConfidence, diagnosisProbabilities, action, confidence (= probabilities[action]), probabilities,
executed, reason?, facts }`. A `Detection` (same fields) is emitted when the top diagnosis is not `expected` and
its probability ≥ `thresholds.report`. An `ActionRecord { id, decisionId, action, tier, trigger, subject, at, ok,
error?, changed: string /* exactly what GenClass altered, in one sentence */, undo?: () => void }` is emitted for
every non-passive action that ran. Decisions are kept in a ring buffer (200).

**Reporting.** `report: "console"` prints one line per detection and per intervention, in the style of §0.5,
built from the decision's facts with generic templates per action/diagnosis (reporting only, never decisions),
followed by a collapsed group with the evidence (facts, timeline, the exact situation text sent to the model,
answer probabilities, the ActionRecord's `changed`, how to undo, and how to deny that action). Repeated
identical reports are rate-limited (summarised as "×N in the last minute"). A custom function receives
`Report { kind: "detect" | "intervene" | "status"; message: string; decision?: Decision; action?: ActionRecord }`.
`explain(id)` returns `Explanation { decision, situationText, facts, timeline, answers, action?, changed? }`.

`DecisionProvider` (the seam between runtime and model; the sim plugs in here):
```ts
interface DecisionProvider {
  readonly status: ModelStatus;
  ready(): Promise<void>;
  evaluate(req: { trigger: TriggerKind; state: JevState; questions: Record<string, Question> }): Promise<Record<string, Answer>>;
  onStatus?(fn: (s: ModelStatus) => void): () => void;
  dispose?(): void;
}
```
`createRuntime({ clock, global, decider, observe, ... })` lets tests and the sim run headless: `global` is the
object whose `fetch`/`XMLHttpRequest`/`addEventListener` are instrumented (default `globalThis`).

## 9. Plugins

```ts
interface Plugin {
  name: string;
  setup?(api: PluginApi): void | (() => void);   // api: emit, recordOp/endOp, user, reportError, on, clock, stores
  facts?(sit: SituationDraft): string[];          // extra facts (generic to the plugin's domain)
  actions?: ActionDef[];
  questions?: StandingQuestion[];
  diagnoses?: Record<string, string>;             // extra diagnosis labels
}
interface ActionDef { name: string; description: string; on: TriggerKind[]; risk?: "low"|"medium"|"high";
  applicable?(sit: SituationDraft): boolean; run(ctx: ActionContext): void | Promise<void>; }
interface StandingQuestion { id: string; on: TriggerKind[]; question: Question; onAnswer?(a: Answer, ctx): void }
```

## 10. Model (`src/model/**`, owner MODEL)

Port of the GenClass extension engine (`extension/genclass/src/core/{engine,packer,tokenizer,serialize,pyutil,runtime}.js`
in the parent jev repo, read-only reference at `/Users/meharkhanna/jev/extension/genclass/src/`) to TypeScript,
bit-for-bit compatible with the PyTorch packer (parity fixtures exist in the GenClass repo export flow).
- `ModelHost implements DecisionProvider`: worker by default (`new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`),
  inline fallback; one request at a time per session; queue with priority (held writes first).
- Loader: fetch `model.json` (card: name, version, variants {q8, fp16} with file/bytes/sha256, tokenizer,
  calibration, meta) from `baseUrl`; Cache Storage `genclass-runtime-v1`; verify sha256; progress events;
  plans: webgpu+fp16 (needs `shader-f16`) → webgpu+q8 → wasm+q8; warm-up pass.
- `onnxruntime-web` is a dependency; the worker imports `onnxruntime-web/webgpu`; wasm files default to the
  ORT CDN path for the installed version (overridable `model.ortWasmPaths`).
- CLI `npx genclass-runtime fetch-model <dir> [--from <url>]` downloads a model directory (Node fetch, follows
  redirects) so apps can self-host (`model: { baseUrl: "/genclass-model/" }`).
- Preload modes (`eager` | `idle` via `requestIdleCallback` with a timeout fallback | `lazy` on the first
  `evaluate`/`ready`); a decision requested while the model is still loading fails open immediately (passive).
- Size target for the runtime model: ≤ 25 MB q8 (lead prunes the vocabulary and quantises embeddings at export;
  the tokenizer/packer must work with a pruned `tokenizer.json`, i.e. no hardcoded vocab size or marker ids:
  read them from the files).
- Until the runtime model exists, develop against the v0.1 GenClass ONNX
  (`https://github.com/MeharPro/GenClass/releases/download/v0.1.0/`, files listed in `extension/genclass/src/model/model.json`).

## 11. Training data generator (`sim/`, owner SIM)

Node, deterministic, seeded. It creates random apps and runs them on the **real runtime** (`createRuntime`
with a virtual `Clock`, a virtual `global.fetch`, and a recording `DecisionProvider`) to produce CONTRACT-D
jsonl rows `{id, split, family, state, questions, labels, meta}` where `state`/`questions` are exactly what the
runtime handed to the decider. Requirements:

- **Virtual world**: event loop over virtual time (macrotasks ordered by time, microtasks drained between them),
  a virtual server (resources, collections, counters, documents; idempotent and non-idempotent endpoints;
  latency distributions with spikes and outages; error codes, timeouts), random user sessions (typing bursts,
  clicks, double clicks, rapid repeats, navigation, idle).
- **Random app programs** built from combinators (not text codegen), running real `async`/`await` against the
  instrumented fetch and runtime stores: fetch-then-set, debounce, polling, optimistic update with
  confirm/rollback, retries, `Promise.all`, dependent chains, client caches, derived fields maintained by app
  code, correct guards (abort, request ids, version checks) and injected defects, many domains/vocabularies
  (≥ 40 domains, randomised names for routes, stores, fields, labels).
- **Ground truth by counterfactual outcome, not by detector**: the intended outcome is the same user session
  run in an ideal environment (serial, zero latency, exactly-once, no failures). At a sampled decision point,
  re-run the scenario deterministically with each applicable action forced there; cost = divergence of final
  client+server state from the intended outcome + user-visible errors + wasted requests + added latency (weights
  documented). The `action` label is a soft distribution from costs (ties favour the passive action).
  The `diagnosis` label comes from the sim's own knowledge of intents (superseded intent → stale; competing
  intents → conflict; repeated intent effect → duplicate; broken derived relation → inconsistent; failure
  streak → failing; an isolated transient failure (5xx/network/timeout that would succeed if tried again) →
  transient; latency anomaly → slow; rate anomaly → overload; an op behaving unlike its usual transition shape →
  unusual; otherwise expected).
- **Precision first.** Benign situations that still look salient (concurrency that resolves correctly,
  intentional repeats, expected failures the app handles, legitimate changes in an op's behaviour) must be
  well represented, so the model learns when NOT to intervene. Report, per trigger, the fraction of rows whose
  best action is passive, and the harm (cost increase) of each non-passive action on rows where passive is best.
- Also generate `ask`-trigger rows: programmatic questions about the trace with exact answers (choice/noul/score,
  randomised phrasings), so developer questions work.
- Randomise the action option order/subsets and the diagnosis description paraphrases/subsets per row so the
  model reads descriptions instead of memorising positions.
- Splits by held-out domains and held-out program families (≥ 15% of each only in test). Report label
  distributions and cost statistics. Scale target: ≥ 300k rows in < 1 h on the 64-vCPU VM.

## 12. Demos (`demos/`, owner DEMOS)

A Vite multi-page site (works as static files, deployable to GitHub Pages). The backend is a Service Worker
mock server (real `fetch` from the page's point of view) with chaos controls (latency, jitter, failure rate,
outages, slowdowns). Each demo: a real small app, a GenClass on/off switch, chaos controls, the devtools
overlay, and a "Run trials" button that drives scripted user sessions and reports the bug rate measured by the
demo's own oracle, GenClass off vs on (observe = off baseline, guard = default, heal), plus **false
interventions on clean runs** (no chaos, correct behaviour: any non-passive action there is a false positive)
as a headline number next to the bug rate. A Playwright script on the VM
runs all trials headless and writes `demos/results.json`. Demos use only the public API. Required demos (all
genuinely different failures or decisions):

1. `search` typeahead (out-of-order responses);
2. `editor` notes editor with autosave and server echo (overlapping saves, echo of older versions);
3. `checkout` cart and checkout (double submit, retry after timeout, totals drifting after partial failures);
4. `status` service dashboard polling flaky services (failure streaks, latency spikes, retry storms);
5. `board` kanban with optimistic moves and a live update channel (out-of-order events, conflicting moves), using the React or Zustand adapter;
6. `decisions` real-time decisions with `ask`/`decide`, plus a custom plugin (its own observer and action).

## 13. Additions (approved 2026-10-07)

- `EvaluateRequest.subject?: { kind; op?; mutation?; store?; paths?; cause?; error?; invariant? }`: a structured
  reference to what is being decided, for non-model providers (tests, sim). Never serialized into `state`.
  Exposed on `Decision` as `subjectRef`.
- `createRuntime({ hooks?: { opCreated?(op), mutationProposed?(m) } })`: called synchronously inside the
  instrumented `fetch(...)` call (before any await) and inside store `set`. Advanced/test use.
- `policy.requireDiagnosis?: boolean` (default `true`): `false` skips the "top diagnosis ≠ expected" gate (the
  sim forces actions on benign situations to measure their cost).
- `vocabulary?: { diagnoses?: Record<string, string>; actions?: Partial<Record<string, string>> }`: override the
  diagnosis labels/descriptions and the action descriptions given to the model.
- `runtime.situation(trigger)` is side-effect free (no ids consumed, nothing recorded).
- The runtime model uses a pruned vocabulary (first 16,000 BPE merges; 16,364 tokens incl. markers). Marker and
  special ids are read from `tokenizer.json`/`meta.json`, never hardcoded.
- Devtools and adapters are owned by UI (`src/devtools/**`, `src/adapters/**`).
