# @genclass/runtime API reference

GenClass Runtime watches a web app from the inside (user actions, async operations, network, state changes,
errors, timing and causality) and asks a small local model, running in the browser, about situations that look
risky. Depending on the mode it reports what it saw, or prevents the failure with a minimal, reversible action.

```ts
import { GenClass } from "@genclass/runtime";

const rt = GenClass.init();                          // observe mode, local model, console reports
const cart = rt.atom("cart", { items: [], total: 0 }); // state GenClass can protect
```

Contents: [init and modes](#init-and-modes) · [options](#options) · [state](#state) ·
[operations and user actions](#operations-and-user-actions) · [questions](#asking-the-model) ·
[events](#events) · [introspection](#introspection-and-control) · [triggers and actions](#triggers-and-actions) ·
[policy](#policy) · [reports](#reports-explain-and-undo) · [plugins](#plugins) · [headless use](#headless-use-tests-ssr-simulation) ·
[adapters and devtools](#adapters-and-devtools) · [types](#types)

## Init and modes

```ts
GenClass.init(options?: InitOptions): Runtime   // idempotent: a second call returns the same runtime
GenClass.runtime: Runtime | null
GenClass.destroy(): void                        // uninstall observers, restore globals, terminate the model worker
```

| mode | what it does |
|---|---|
| `observe` (default) | Watches and reports detections. Never changes execution: nothing is held, no action runs. |
| `guard` (opt-in) | Also takes *guard-tier* actions at very high confidence: `discard`, `defer`, `coalesce`, `delay`. These withhold, deduplicate or slow something down; they never invent data or fail a request. |
| `heal` (experimental) | Also takes *heal-tier* actions: `block`, `serve_cached`, `retry`, `hedge`, `rollback`, `resync`, plugin actions. |

Kill switch, for "is my app broken or did GenClass change something?":

- `?genclass=off` in the page URL, or `localStorage.genclass = "off"`: `init` installs nothing and logs one line.
- `?genclass=observe|guard|heal`: overrides the mode, within limits (`src/index.ts` -> `initUnsafe`; a missing
  `mode` counts as `guard` there): `observe` always; `guard` when no mode, `guard` or `heal` is configured (the
  default `/auto` and script tag included, not `/auto/observe`); `heal` only when `heal` is configured, or with
  `debug: true`.

Outside a browser (no `window`/`document`, e.g. SSR), `GenClass.init()` returns an inert runtime: no observers,
no model. Use [`createRuntime`](#headless-use-tests-ssr-simulation) for headless work.

**Telemetry (since 0.1.0-beta.3; privacy-relevant).** In a browser `GenClass.init()` sends anonymous diagnostics
(decisions with the redacted situation text, action outcomes, detections, model status and counts) to
`DEFAULT_TELEMETRY_ENDPOINT` and prints one console notice per page. Off with `telemetry: false`,
`?genclass=no-telemetry` (or `?genclass=off`), `localStorage["genclass.telemetry"] = "off"`, or Global Privacy
Control; off by default outside a browser and in `createRuntime()`. Schema and details:
[packages/runtime/TELEMETRY.md](../../packages/runtime/TELEMETRY.md).

## Options

```ts
interface InitOptions {
  mode?: "observe" | "guard" | "heal";                 // default "observe"; "guard" is opt-in, "heal" experimental
  model?: {                                             // or false: no model (observe only)
    baseUrl?: string;                                   // directory with model.json (default: jsDelivr CDN)
    device?: "auto" | "webgpu" | "wasm";                // default "auto"
    worker?: boolean;                                   // default true
    preload?: "eager" | "idle" | "lazy";                // default "idle"
  } | false;
  decider?: DecisionProvider | null;                   // bring your own decision provider instead of the model
  report?: "console" | "silent" | ((r: Report) => void); // default "console"
  observe?: Partial<Record<"fetch"|"xhr"|"user"|"errors"|"nav"|"storage"|"perf"|"websocket"|"eventsource"|"timers"|"untrustedEvents", boolean>>;
                                                        // untrustedEvents (default false): record synthetic DOM events (isTrusted false) as user actions (test harnesses)
  triage?: "salient" | "always";                        // default "salient"
  policy?: PolicyOptions;                               // see Policy
  redact?: (path: string, value: unknown) => unknown;   // default: values whose leaf field names a secret (password, token, card number, cvv, ssn, iban, ...); never a whole store by its name
  plugins?: Plugin[];
  historySize?: number;                                 // events kept, default 500
  debug?: boolean;                                      // console.debug every decision
  learn?: { persist?: boolean };                        // keep transition profiles in localStorage
  aggressiveness?: "cautious" | "balanced" | "eager" | number; // how eagerly to act (default "balanced"; see Policy)
  vocabulary?: { diagnoses?: Record<string, string>; actions?: Record<string, string> };
  settleMs?: number;                                    // quiet time that makes a settled point, default 60
  situation?: { budget?: number | "auto" };             // size of what the model reads, in characters (default "auto")
  telemetry?: boolean | {                               // anonymous diagnostics (TELEMETRY.md); default: on in GenClass.init in a browser, else off
    endpoint?: string;                                  // [DEFAULT_TELEMETRY_ENDPOINT]
    sample?: number;                                    // [1] fraction of page loads that send
    flushMs?: number;                                   // [10000] batch interval; also sent on pagehide / hidden tab (sendBeacon)
    maxBatch?: number;                                  // [100] events per request (requests also ≤ 60 KB)
    include?: { situation?: boolean };                  // [true] include the redacted situation text
    transport?: { send(url: string, body: string, o: { beacon: boolean }): void | Promise<unknown> }; // tests / custom pipelines
  };
  autoState?: boolean | { react?: boolean; redux?: boolean; zustand?: boolean; pinia?: boolean };
                                                        // automatic state discovery: default on in @genclass/runtime/auto* and the script tag,
                                                        // off in GenClass.init / createRuntime (there it needs import "@genclass/runtime/discover" first)

  // batch 12 (docs/runtime/OPTIONS-SPEC.md); defaults in brackets
  enabled?: boolean | (() => boolean | Promise<boolean>) | { get(): boolean | Promise<boolean>; subscribe?(cb: () => void): () => void };
                                                        // [true]; false: nothing installed, model never downloaded; a predicate/source forces preload "lazy"
  sample?: number;                                      // [1] fraction of sessions that act (stable per session); the rest observe
  routes?: { match: string | RegExp | ((route: string) => boolean); mode?: Mode | "off"; aggressiveness?: Aggressiveness }[];
                                                        // first match wins; demote only
  requests?: {
    ignore?: RequestMatcher[];                          // not observed at all (native pass-through)
    protect?: RequestMatcher[];                         // observed, never held/retried/cached/discarded; a throwing predicate = protected
    crossOrigin?: "observe" | "ignore";                 // ["observe"]; cross-origin is always passive
    labels?: { match: RequestMatcher; label: string }[];// names for reports/sinks ([A-Za-z0-9 _-], ≤ 5 words, ≤ 40 chars)
    labelsToModel?: boolean;                            // [false] labels appear in situation text only when true
    correlate?: (r: { url: string; method: string; headers: Record<string, string> }) => string | undefined; // redacted, ≤ 128 chars
  };
  breaker?: { undos?: number; errorsAfterAction?: number; attributionMs?: number; windowMs?: number; downgradeTo?: "observe" | "guard"; persist?: "session" | false } | false;
                                                        // [{2, 3, 5000, 600000, "observe", "session"}]
  shadow?: "guard" | "heal" | false;                    // [false] dry-run gate at a higher mode; Decision.shadow, "shadow" event
  onBeforeAction?: (a: ActionRequest) => boolean | void;// final sync veto (false or throw); counts against the hold budget
  vetoMode?: "enforce" | "report";                      // ["enforce"]; "report" records would-veto and runs the action
  sinks?: (SinkFn | { send: SinkFn; kinds?: SinkKind[]; sampleRate?: number; evidence?: boolean; flush?(): Promise<void> })[];
  session?: { id?: string; tags?: Record<string, string | number | boolean> }; // never shown to the model
  redact?: (path: string, value: unknown, kind?: "state" | "url" | "header" | "input") => unknown; // runs after built-in redaction; a throw → "[redacted]"
  report?: "console" | "interventions" | "silent" | ((r: Report) => void);    // "interventions": console prints interventions, undos, breaker only
  learn?: { persist?: boolean | "local" | "session"; key?: string; version?: string }; // version defaults to session.tags.release; mismatch discards
  // model: also loadIf [{ saveData: "lazy" }], inlineFallback [true], threads ["auto"], timeoutMs [10000],
  //        maxDecisionsPerMinute [30], unloadAfterIdleMs [false]
}
```

Runtime additions: `rt.disable({ undo? })` (permanent; `undo: true` rolls back the last minute's actions),
`rt.summary(): SessionSummary`, `rt.setSession({ id?, tags? })`, `rt.breaker.{tripped, reset()}`, `rt.learn.clear()`,
events `shadow`, `breaker`, `limit`, `modelBudget`. `status` adds `effectiveMode`, `sampled`, `breaker`, `scope`,
`modelBudget`, and states `"disabled" | "skipped" | "unloaded"`. `status.scope` is what is in force on the current
route: `mode` is the effective mode there (equal to `effectiveMode`: the requested mode demoted by sampling, the breaker
and the matching `routes[]` rule) and `aggressiveness` the effective level; with a matching rule it also has `rule`
(its index) and `ceiling` (the mode that rule caps the route at; rules only lower the mode). Before 0.1.0-beta.4,
`scope.mode` was that ceiling ("heal" when no rule matched). `rt.gates()` carries `mode` (the same effective mode).
`status.blocked` (state "error"): `{ url, origin, csp, directive? }` when the browser blocked a model or ORT download.

Gate order (each request/decision): protected → cross-origin → op scope (created under off/observe) →
mode/allow/deny/requireDiagnosis (at the effective mode) → thresholds → `policy.actionLimits`
(`limit:perMinute|perSubject|perSession`; defaults 60/min global, 10/min per subject, 200 per session) → `onBeforeAction` (`vetoed`, `would-veto`, or
`limit:hold` past the budget) → execute. effectiveMode = min(mode, sample cap, breaker cap, route rule); URL overrides
(`?genclass`, `?genclass-mode`, `?genclass-aggr`, `?genclass-sample`) only demote unless `debug: true`.
`policy.holdBudgetMs` is a hard ceiling that includes defers and the veto hook. Hidden tabs skip background
evaluation and release held items unevaluated.

Performance: GenClass computes cheap facts for every write and request, and asks the model only about salient ones.
The situation the model reads is sized to the device (`situation.budget: "auto"`): 2,400 characters (about 1,000
tokens) on WebGPU, 2,000 on 4-thread WASM (crossOriginIsolated pages), 1,000 on single-thread WASM; at 1,400
characters or less the questions are compact (bare diagnosis labels and action names). State writes are never held
by default. Held responses, messages and requests wait at most the hold budget (`policy.holdBudgetMs: "auto"`: 1.5 ×
the model's recent median latency, 150 to 800 ms), then proceed unchanged; nothing is held when the model is not
expected to answer within that budget. Serving your page with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` enables WASM threads (about 3× faster without WebGPU).

Self-hosting the model: `npx @genclass/runtime fetch-model public/genclass-model` then
`GenClass.init({ model: { baseUrl: "/genclass-model/" } })`.

## State

GenClass protects state it can see. Register stores with `atom` (owned by GenClass), `guard` (owned by you) or an
adapter (Redux, Zustand, React hooks).

**Automatic state discovery** (`autoState`, on with the one line: `import "@genclass/runtime/auto"` or the script tag)
finds React component state (`useState`, `useReducer`, `useSyncExternalStore`, class state; through the React
DevTools hook), Redux / Redux Toolkit stores (through the Redux DevTools compose and enhancer globals) and Zustand
`devtools` stores (through the Redux DevTools `connect` API; Zustand disables `devtools` in production builds unless
`enabled: true` is passed, so such builds are not discovered). Each write is recorded with the operation that made it.
Discovered Redux stores get the Redux adapter (controllable, kind `adapter`). Discovered React and Zustand state is
**observed only** (kind `observed`): it feeds facts, triage, detections and delivery decisions (`deliver` / `defer`),
but GenClass never holds, drops, reverts or rolls back its writes, so `discard` and `rollback` are not offered for it.
React stores are named after the component (`SearchPage.state0`, `SearchPage.external0`, class state keys; in
production builds after the element the component renders). Opt out with `autoState: false` or
`<meta name="genclass" content="autostate=off">`; `?genclass=off` installs nothing. With `GenClass.init`, import
`@genclass/runtime/discover` before React / Redux / Zustand and pass `autoState: true`.

```ts
rt.atom<T>(name: string, initial: T, opts?: StoreOptions<T>): Atom<T>
rt.guard<T>(name: string, io: { get(): T; set(v: T): void; subscribe?(fn: () => void): () => void }, opts?): Guarded<T>
rt.expect(name: string, predicate: () => boolean): () => void   // developer invariant, checked at settled points

interface Atom<T> {
  readonly name: string;
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  update(fn: (prev: T) => T): void;
  subscribe(fn: (v: T) => void): () => void;
}
interface StoreOptions<T> {
  resync?: () => Promise<unknown> | unknown;   // "reload this store from its source": enables the resync action
  hold?: boolean;                              // default true; false: writes are never held
  describe?: (v: T) => string;                 // one-line description used in situations
}
```

```ts
const search = rt.atom("search", { query: "", results: [] as Item[] }, {
  resync: async () => search.set({ ...search.get(), results: await api.search(search.get().query) }),
});
input.oninput = () => search.set((s) => ({ ...s, query: input.value }));   // user write: applied at once
const res = await fetch(`/api/search?q=${q}`);                          // a stale response may be held briefly
search.set((s) => ({ ...s, results: data }));                           // applied at once (stale fields may be dropped)
```

How writes flow: GenClass decides at the network boundary and enforces synchronously at the store. A response
(fetch or XHR) or a pushed message (WebSocket, EventSource) is checked before the app sees it: GenClass predicts
which fields it will write (from what the same operation wrote before) and consults the model only when it would
overwrite newer data (an operation that started later already wrote it, and no newer request of the same kind is
still on its way), put back the value of an unconfirmed local change (a user action's optimistic write whose own
request is still in flight), or replace text the user typed meanwhile. The model may let it through (`deliver`), let it
through but drop the writes it makes over newer data (`discard`: each later `set()` of that response's chain applies
its other fields and skips those), or hold it until the related requests finish and decide again (`defer`). Holding
only adds latency; messages of one socket or stream keep their order. Before asking, it reads the response (a
clone, ≤ 256 KB of JSON) and compares it with the store: a response that equals the current values changes nothing and is let through without
a model call. The situation then says what the response would do: put back a value a newer operation replaced (per
field, or per item cell of a list joined by id), replace text the user typed since the request started (with a
preview centred on the difference), or reload a list without the item a recent create returned.

`set()` always applies at once (`set(x); get()` returns x) and notifies subscribers; writes to one store apply in the
order they were made. A write that looks wrong on its own (not covered by a delivery decision) is decided in the
background: if the model answers `discard` within 2 s after the write applied, nothing has overwritten it and the
same operation made no other write since, GenClass reverts exactly that write (a "late revert", reported as such and
undoable).

`policy.holdWrites: true` (opt-in) holds salient writes until the model answers (at most the hold budget): a later
write to the same store first applies the earlier held ones in order, and `get()` inside the writing operation
returns the pending value. An updater that changes the stored value in place never changes live state before the
decision (GenClass works on a detached copy, or applies at once when it cannot restore the live value exactly); a
functional update runs again on the value at apply time; a held value write is re-applied as a patch of the fields
it changed. Reads that bypass GenClass (a Redux middleware's `store.getState()`) do not see held writes: keep
`holdWrites` off for such stores or pass `hold: false`.

GenClass also learns, at *settled* points (no requests in flight, `settleMs` of quiet), generic relations between
your fields (`a == b` for fields with related names, `a == len(B)`, `a == sum(B[*].f)`, `a == sum(B[*].f * B[*].g)`,
`a == count(B[*].k == v)`, `a >= 0`, `a ∈ B[*].k`, `B[*].id unique`, stable types, non-null) and each operation's usual
effects on state. When a learned relation breaks, or an operation changes state unlike it normally does, the model is
consulted. To avoid false alarms on correct apps: a selection holding 0, -1, "" or null means nothing is selected;
uniqueness is only learned for id columns; pagination metadata (page, offset, limit, cursor, and a total next to them)
never enters a relation; stores you are typing into are checked once typing pauses for a second; counters that change
on nearly every write are left out unless they are a learned sum or count of a list.

## Operations and user actions

The DOM, fetch, XHR, WebSocket and timers are observed automatically. These entry points cover anything else:

```ts
rt.op<T>(name: string, fn: () => Promise<T> | T, meta?: Record<string, unknown>): Promise<T>   // a named async task
rt.user<T>(action: UserAction, handler?: () => T): T | undefined   // a user action (cause of what follows)
rt.emit(name: string, data?: Record<string, unknown>): void        // a custom event in the timeline
rt.reportError(error: unknown, info?: { source?: string }): void   // a handled error worth knowing about

interface UserAction { kind: "click"|"type"|"change"|"submit"|"key"|"nav"|string; target?: string; value?: string; key?: string; sensitive?: boolean; clicks?: number /* MouseEvent.detail */ }
```

```ts
await rt.op("loadProfile", async () => profile.set(await (await fetch("/api/me")).json()));
rt.user({ kind: "click", target: 'button "Sync"' }, () => startSync());
```

The DOM observer describes the element the user actually interacted with, also inside open shadow roots (Lit,
custom elements): `button "Send reply"`, `select "Status"`. Names come from `aria-label`, `aria-labelledby`, the
label (its own text, without the options or values of controls nested in it), rendered text (following slots),
placeholder, title, name, or the custom element host's `label`/`aria-label`.

Causality is tracked through `await` on a best-effort basis: the operation that is running is "ambient" while a
user handler or `rt.op` body runs, after a fetch/XHR settles and when its body (`json()`, `text()`, ...) is read,
and inside timers scheduled during an operation; it is cleared at the end of the task. Writes record the ambient
operation as their cause; operations started while another is ambient get it as their parent.

## Asking the model

```ts
rt.ask<Q extends Question>(q: Q, opts?: { about?: "now" | number /* op id */ | string /* store */; timeoutMs?: number }): Promise<AnswerOf<Q>>
rt.decide<L extends string>(question: string, options: Record<L, string>, opts?): Promise<L>
```

The question is answered against the current situation (what the app is doing now, or about one op or store).

```ts
const mode = await rt.decide("How should the editor save right now?", {
  now: "save immediately, the user paused",
  later: "wait, the user is still typing quickly",
});
const busy = await rt.ask({ type: "score", instructions: "How busy is the app right now?", criteria: ["idle", "light", "busy"] });
const risky = await rt.ask({ type: "noul", instructions: "Did the last checkout request fail?" });   // risky.noul = P(true)
```

`ask`/`decide` wait for the model to load (bounded by `timeoutMs`) and reject with `GenClassUnavailableError`
(`reason`: `"off" | "error" | "timeout" | "destroyed"`) when no model can answer.

Question shapes (Jev wire format):

```ts
type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };
// AnswerOf: noul -> { noul }, choice -> { choice, confidence, probabilities }, score -> { score, confidence, probabilities }
```

## Events

```ts
rt.on("detect", (d: Detection) => void)      // the model diagnosed a problem (diagnosis != expected, p >= thresholds.report)
rt.on("decide", (d: Decision) => void)       // every model decision
rt.on("act", (a: ActionRecord) => void)      // every non-passive action that ran
rt.on("event", (e: RtEvent) => void)         // every traced event
rt.on("status", (s: ModelStatus) => void)    // model loading progress and state
rt.on("report", (r: Report) => void)         // every report line (even with report: "silent")
// each returns an unsubscribe function
```

## Introspection and control

```ts
rt.status: ModelStatus             // { state: "off"|"loading"|"ready"|"error", progress?, device?, variant?, threads?, phase?, error?, ... }
rt.ready: Promise<void>            // resolves when the model is ready (immediately with no model); reading it starts a lazy load
rt.mode: "observe" | "guard" | "heal"
rt.situation(trigger?): Situation  // what the model would see: { trigger, subject, state, questions, actions, salient, facts }
rt.explain(id): Explanation | null // a decision ("d3") or action ("a1") id -> { message, decision, situationText, facts, timeline, answers, action?, changed? }
rt.holdBudgetMs(): number          // the current hold budget
rt.situationBudget(): number       // the current situation size in characters
rt.gates(trigger?): EffectiveGates // the gate thresholds in force (see Policy)
rt.history(n?): RtEvent[]          // recent events, oldest first
rt.decisions(n?): Decision[]       // last 200 decisions
rt.interventions(n?): ActionRecord[]
rt.inflight(): Op[]
rt.stores(): StoreInfo[]           // registered and discovered stores: { name, kind: "atom"|"guard"|"adapter"|"observed", source?, writable, fields, version }
rt.setMode(mode); rt.pause(); rt.resume(); rt.destroy()
rt.telemetry?: { enabled; reason?; endpoint?; sessionId?; flush(): Promise<void> } // reason when off: option, headless, url, localStorage, gpc, sampled-out, kill-switch, disabled, ...
```

`pause()` stops consulting the model (everything proceeds unchanged, tracing continues); `destroy()` uninstalls
every observer and restores the globals it wrapped.

## Triggers and actions

| trigger | when | actions (passive first) |
|---|---|---|
| `delivery` | a response (fetch/XHR) or a WebSocket/EventSource message is about to reach the app and, judged from its body (read from a clone), would change newer data already applied (no newer request of the same signature in flight), put back the value of an unconfirmed local change, or replace text the user typed since the request started | `deliver`, `discard`, `defer` |
| `mutation` | a salient state write not covered by a delivery decision (decided in the background unless `holdWrites`) | `apply`, `discard`, `defer` |
| `request` | a fetch/XHR is about to be sent | `send`, `coalesce`, `delay`, `block`, `serve_cached` |
| `failure` | a request failed (network, timeout, 5xx, 429, 408) before the app sees it | `deliver`, `retry`, `serve_cached` |
| `stall` | a request is far past its usual latency, or has been in flight 10 s without a latency baseline yet | `wait`, `hedge`, `serve_cached` |
| `inconsistency` | a learned relation between fields broke | `ignore`, `rollback`, `resync` |
| `transition` | an operation changed state unlike it usually does | `ignore`, `rollback`, `resync` |
| `error` | an uncaught error or unhandled rejection | `ignore`, `rollback` |

| action | tier | effect |
|---|---|---|
| `discard` | guard | delivery: deliver it, but drop the state changes its operation makes over newer data (`ActionRecord.dropped` lists them; undo: apply them now). mutation: revert exactly that write if decided ≤ 2 s after it applied, nothing overwrote it and its operation wrote nothing else since (undo: re-apply); with `holdWrites`, drop the held write |
| `defer` | guard | hold the response/message (or held write) until related requests finish, then decide again (twice at most) |
| `coalesce` | guard | do not send; reuse the response of the identical request in flight or just finished (`x-genclass: coalesced`) |
| `delay` | guard | wait min(250 ms · 2^failure streak, 8 s), then send |
| `block` | heal | do not send; answer 503 (`x-genclass: blocked`) |
| `serve_cached` | heal | answer with the last good response for this GET (`x-genclass: cached`; ≤ 256 KB, ≤ 64 entries, memory only) |
| `retry` | heal | re-send after min(200 ms · 2^(attempt-1), 5 s) when the body can be replayed and repeating is safe by HTTP semantics: GET, HEAD, OPTIONS, PUT, DELETE, or another method (POST, PATCH, ...) only when the request carries an idempotency key header (`policy.idempotencyHeaders`; request ids and tracing headers are not keys) or, opt-in, a JSON body field named in `policy.idempotencyBodyFields` |
| `hedge` | heal | send a second identical GET and use whichever answers first |
| `rollback` | heal | inconsistency: restore the involved stores to their last consistent snapshot; error/transition: restore only the fields the operation's own chain wrote to their earlier values (undo: restore the replaced values) |
| `resync` | heal | call the store's `resync` handler |

Diagnoses the model chooses from (`vocabulary.diagnoses` replaces them; plugins add labels): `expected` (normal
behaviour), `stale` (outdated data about to replace newer state), `conflict` (concurrent operations competing),
`duplicate` (the same change or request again without a new intent), `inconsistent` (state contradicts itself),
`failing` (keeps failing), `slow` (far slower than usual), `overload` (triggered far more often than usual),
`unusual` (unlike how the same operation normally behaves), `transient` (a one-off failure likely to succeed if
tried again).

Actions are offered only when they apply (`situation().notOffered` lists the built-in actions left out and why;
an identical request exists, a cached response exists, the body can be
replayed, a consistent snapshot exists, a `resync` handler exists, the failing operation wrote state). Responses
are always cloned before the app reads them. GenClass's own requests and writes are never gated; `keepalive`
requests and synchronous XHRs are never held; nothing is held when the mode and policy permit no action for it or
when the model is not expected to answer within the hold budget. A queued decision whose subject was superseded (the
response was released, the write overwritten, the request aborted) is dropped before the model computes it. XHR:
the app's completion listeners (`readystatechange`, `progress`, `load`, `loadend`, and the matching `on*`
handlers) are wrapped so a held response reaches them, in order, once delivered; `on*` getters return that wrapper.

Two requests are "identical" when method, URL, headers (tracing ids such as `traceparent` or `x-request-id`
excluded) and body content match. Bodies GenClass cannot read cheaply (streams, files, bodies over 64 KB) never
match anything.

## Policy

```ts
interface PolicyOptions {
  thresholds?: { report?: number; guard?: number; heal?: number };  // overrides; else the model's own gate, else 0.6 / 0.9 / 0.8
  allow?: string[];                 // only these non-passive actions may run
  deny?: string[];                  // these never run
  holdBudgetMs?: number | "auto";   // default "auto": clamp(1.5 × median recent model latency, 150, 800) ms
  holdUserWrites?: boolean;         // default false
  idempotencyHeaders?: string[];    // default ["Idempotency-Key", "X-Idempotency-Key"]: a POST/PATCH carrying one may be retried
  idempotencyBodyFields?: string[]; // opt-in, default []: top-level JSON body fields (e.g. "request_id") the server dedupes on
  holdWrites?: boolean;             // default false: state writes apply at once (decided at the network boundary)
  maxActionsPerMinute?: number;     // default 60
  requireDiagnosis?: boolean;       // default true
}
```

Thresholds: the model's action probabilities are calibrated against the gate it ships with (`gate` in its
meta.json, visible as `runtime.status.gate`). Two gate kinds exist:
- `kind: "mass"` (the default, also when meta.json has no kind): the most probable permitted action runs when the
  summed probability of the permitted actions reaches its tier's threshold (`{ report?, guard: { default,
  byTrigger? }, heal: {...} }`, probabilities; defaults 0.9 / 0.8).
- `kind: "gain"` (`{ kind: "gain", tauGain, guard: { default, byTrigger? }, heal: {...}, report? }`): for the most
  probable permitted action a, ĝ(a) = tauGain · ln(p(a) / p(passive)) estimates its gain over the passive action in
  cost units; a runs when ĝ(a) is above its tier's margin (defaults 2 / 2; tauGain default 1). Probabilities are
  clamped to ≥ 1e-6; when the model gives no probability for the passive action, the mass it left over is used.
Aggressiveness (`InitOptions.aggressiveness`: "cautious" | "balanced" | "eager" | 0–1, default "balanced";
`runtime.setAggressiveness(x)`; URL `?genclass-aggr=…`) selects the gate: when meta.json has `gate.profiles: {
cautious, balanced, eager }` (each a gate of either kind, report included), a named level uses its profile and a
number interpolates thresholds/margins, report and tauGain linearly between the neighbouring profiles (the nearer
profile's kind when they differ). Without profiles the single gate (or the defaults) is shifted: cautious +0.05 on
thresholds / +1 on margins, eager −0.05 / −1 (linear in between, clamped). `runtime.aggressiveness`,
`runtime.status.aggressiveness` and `runtime.gates()` (`aggressiveness`, `level`, `levelSource`) show the level.
For each trigger kind the effective value is your `policy.thresholds` value when set, read in the active kind
(probabilities for "mass", margins for "gain"; `report` is always a probability), else the model's value for that
trigger kind, else its tier default, else the defaults. `runtime.gates(trigger?)` returns the kind, values and where
each comes from (`policy`, `model`, `default`); every decision records `gateKind`, and `threshold` (mass) or `gain`
and `margin` (gain), with `thresholdSource`; `explain(id).gates` has the full set.

The permitted actions are the applicable non-passive actions the mode allows (observe: none; guard: guard tier;
heal: both), minus denied ones (only allowed ones when `allow` is set). GenClass runs the most probable permitted
action only if all of these hold, otherwise the passive action runs and the decision's `reason` says why: the
summed probability of the permitted actions reaches that action's tier threshold; the model's top diagnosis is not
`expected` (unless `requireDiagnosis: false`); fewer than `maxActionsPerMinute` actions ran in the last minute; the
decision arrived within the hold budget (a late `discard` may still revert the write, see State). While the model is
loading, everything proceeds unchanged.

## Reports, explain and undo

With `report: "console"` every detection and intervention prints one line, followed by a collapsed group with the
evidence: the facts, the timeline, the exact situation text sent to the model, the answer probabilities, what
changed, how to undo it and how to deny that action. Identical repeats within a minute are folded into one line
printed when the minute ends ("×N more in the last minute"). A detection that did not act says what GenClass would
have done and why not.

```
[GenClass] Prevented a stale response: search.results was written twice by other operations since its operation (#6) started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later user action (#7). Delivered the response to GET /api/search?q=rea (#6) and dropped the state changes it makes over newer data (search.results). (stale, 0.97; discard 0.97)
```

```ts
const a = rt.interventions().at(-1)!;
a.changed;          // "Delivered the response to GET /api/search?q=rea (#6) and dropped the state changes it makes over newer data (search.results)."
a.dropped;          // ["search.results"]
a.undo?.();         // discard: applies the dropped values now; late revert: re-applies the write; rollback: restores the values it replaced
rt.explain(a.id);   // { decision, situationText, facts, timeline, answers, action, changed }
```

A custom `report` function receives `{ kind: "detect" | "intervene" | "status", message, decision?, action? }`.
`explain(id).message` is the same line for any decision or action, also when it was not printed.

Your own debug UI: GenClass ignores user events from inside any element marked `data-genclass-ignore` (the devtools
overlay uses it), so debugging tools never become causes in situations.

## Plugins

```ts
rt.use(plugin: Plugin): () => void
rt.action(def: ActionDef): () => void
rt.question(def: StandingQuestion): () => void

interface Plugin {
  name: string;
  setup?(api: PluginApi): void | (() => void);   // api: emit, recordOp/endOp, runInOp, user, reportError, on, clock, stores, runtime
  facts?(sit: SituationDraft): string[];          // extra facts about your domain, added to every situation
  actions?: ActionDef[];
  questions?: StandingQuestion[];
  diagnoses?: Record<string, string>;             // extra diagnosis labels
}
interface ActionDef {
  name: string; description: string; on: TriggerKind[];
  tier?: "guard" | "heal";                        // default "heal"
  applicable?(sit: SituationDraft): boolean;
  run(ctx: ActionContext): void | Promise<void>;
}
interface ActionContext {
  trigger; decision; situation; runtime;
  builtin(name: string): Promise<boolean>;        // run a built-in action, e.g. "discard" or "retry"
  describe(changed: string): void;                // what this action altered (shown in reports)
  onUndo(fn: () => void): void;
}
interface StandingQuestion { id: string; on: TriggerKind[]; question: Question; always?: boolean; onAnswer?(a: Answer, ctx): void }
```

```ts
rt.use({
  name: "presence",
  setup(api) {
    const ws = new WebSocket("/presence");
    ws.onmessage = (e) => api.emit("presence", { users: JSON.parse(e.data).length });
    return () => ws.close();
  },
  facts: (s) => (s.trigger === "mutation" ? [`${onlineUsers()} other users are editing this document.`] : []),
  actions: [{
    name: "ask_to_reload", description: "keep the write and ask the user to reload the document", on: ["inconsistency"], tier: "heal",
    run: (ctx) => { showReloadBanner(); ctx.describe("Showed the reload banner."); },
  }],
});
```

If a custom action does not call `ctx.builtin(...)`, the passive action runs after it (the held write applies,
the request is sent).

## Headless use (tests, SSR, simulation)

```ts
import { createRuntime } from "@genclass/runtime";
const rt = createRuntime({
  clock,      // { now(), setTimeout(fn, ms), clearTimeout(h), afterTask(fn) }; default: the real clock
  global,     // the object whose fetch / XMLHttpRequest / WebSocket / addEventListener / ... are instrumented; default globalThis
  decider,    // any DecisionProvider; default none (createRuntime never loads the model unless model: {...} is given)
              // telemetry is off in createRuntime unless telemetry: true / {...} is given
  app: () => ({ title: "Shop", route: "/cart" }),   // default: global.document.title and global.location.pathname
  hooks: { opCreated(op) {}, mutationProposed(m) {} },
});

interface DecisionProvider {
  readonly status: ModelStatus;
  ready(): Promise<void>;
  evaluate(req: { trigger; state; questions; priority?; subject?; notOffered?; timeoutMs? }): Promise<Record<string, Answer>>;
  onStatus?(fn): () => void;
  dispose?(): void;
}
```

The runtime only uses the injected clock (no `Date.now`, `Math.random` or global timers), so a virtual clock makes
runs deterministic: the same inputs give byte-identical situations. Pass `situation: { budget }` to fix the
situation size.

The local model host is exported for direct use: `createModelHost(options)` (a `DecisionProvider` with `measure()`,
`evaluateDetailed()`, `stats`), `DEFAULT_MODEL_BASE_URL`, and the model errors (`ModelNotReadyError`,
`MaxTokensExceededError`, `ModelTimeoutError`, `ModelBusyError`, `ModelLoadError`, ...; each has a `code`). Any
provider error makes the runtime fail open.

## Adapters and devtools

Subpath exports: `@genclass/runtime/react` (`useGenClassState(name, initial, opts?)`, `useAtom(atom)`,
`useGenClass()`), `@genclass/runtime/redux` (`genclassEnhancer(runtime, { name })`), `@genclass/runtime/zustand`
(`genclass(runtime, name)(stateCreator)`), `@genclass/runtime/devtools` (`mountDevtools(runtime, opts?)`),
`@genclass/runtime/discover` (automatic state discovery for `GenClass.init({ autoState: true })`; import it first). They are
documented with their source. To integrate another state library use:

```ts
rt.adapter<T>(name: string, io: { get(): T; set?(v: T): void; subscribe?(fn: () => void): () => void }, opts?): {
  propose(w: { fn?: (prev: T) => T; value?: T; commit: (next: T) => void }): void;   // commit runs when (and if) the write applies
  dispose(): void;
}
```

## Types

```ts
interface Decision {
  id: string; trigger: TriggerKind; subject: string; at: number; latencyMs: number; model: string;
  diagnosis: string; diagnosisConfidence: number; diagnosisProbabilities: Record<string, number>;
  action: string /* the action that ran, else the model's choice */; confidence: number /* probabilities[action] */;
  probabilities: Record<string, number>; executed: boolean; reason?: string; facts: string[];
  tier: "passive" | "guard" | "heal"; ran: string; answers: Record<string, Answer>; subjectRef?: SubjectRef;
  candidate?: string /* most probable permitted action */; mass?: number /* summed probability of the permitted actions */;
  gateKind?: "mass" | "gain"; threshold?: number /* mass gate: what mass was compared with */;
  gain?: number; margin?: number /* gain gate: ĝ of the candidate and its tier margin */; thresholdSource?: "policy" | "model" | "default";
}
type Detection = Decision;
interface ActionRecord { id: string; decisionId: string; action: string; tier; trigger; subject: string; at: number; ok: boolean; error?: string; changed: string; undo?: () => void; late?: boolean; dropped?: string[] /* delivery discard: fields dropped */ }
type SubjectRef = { kind: "delivery"; op: number; paths?: string[]; store?: string } | { kind: "mutation"; ... } | ...
interface Explanation { message: string; decision: Decision; situationText: string; facts: string[]; timeline: string[]; answers: Record<string, Answer>; action?: ActionRecord; changed?: string; gates?: EffectiveGates }
interface EffectiveGates { kind: "mass" | "gain"; tauGain?: number; trigger?: TriggerKind; report: number; guard: number; heal: number; source: { report: "policy" | "model" | "default"; guard: …; heal: … } }
interface RtEvent { seq: number; t: number; kind: "user"|"op.start"|"op.end"|"state"|"error"|"nav"|"perf"|"storage"|"custom"|"decision"|"action"; name: string; op?: number; cause?: number; data?: Record<string, unknown> }
interface Op { id: number; kind: "user"|"fetch"|"xhr"|"ws"|"task"|"timer"|"genclass"; name: string /* e.g. "GET /api/x", "WS message /live", "SSE update /stream" */; detail?: string; start: number; end?: number; status?: "ok"|"error"|"aborted"|"blocked"; code?: number | string; cause?: number; root?: number; attempt: number; reads: Map<string, number>; identity?: string }
```

Privacy: values are summarised and redacted before they reach a situation. A value is redacted when its leaf field
names a secret (password, passcode, pin, token, secret, cvv/cvc, ssn, iban, otp, cookie, authorization, card number,
credit card, api key, session id, ...; `payment.card.number` counts), never because of the store's name: in an `auth`
store, `auth.token` is redacted and `auth.loading` or `auth.user.name` are not. Under a container that names a secret
(`credentials.password.value`) strings are redacted too, and under `auth`/`session`/`cookie` only opaque
credential-like strings (JWTs, API keys). Query parameters and body keys follow the same rule; password inputs and
inputs with `autocomplete` cc-* / one-time-code are never recorded. Element text such as a kanban "card" is not a
secret. Response bodies are read only from a clone the runtime already keeps (≤ 256 KB) and only to compare them with
the store. Decisions are made in the browser by the local model; the only data GenClass sends is its anonymous
telemetry (on by default with `GenClass.init()` in a browser; [TELEMETRY.md](../../packages/runtime/TELEMETRY.md)),
which includes the redacted situation text.