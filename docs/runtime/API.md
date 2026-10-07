# @genclass/runtime API reference

GenClass Runtime watches a web app from the inside (user actions, async operations, network, state changes,
errors, timing and causality) and asks a small local model, running in the browser, about situations that look
risky. Depending on the mode it reports what it saw, or prevents the failure with a minimal, reversible action.

```ts
import { GenClass } from "@genclass/runtime";

const rt = GenClass.init();                          // guard mode, local model, console reports
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
| `observe` | Watches and reports detections. Never changes execution: nothing is held, no action runs. |
| `guard` (default) | Also takes *guard-tier* actions at very high confidence: `discard`, `defer`, `coalesce`, `delay`. These withhold, deduplicate or slow something down; they never invent data or fail a request. |
| `heal` | Also takes *heal-tier* actions: `block`, `serve_cached`, `retry`, `hedge`, `rollback`, `resync`, plugin actions. |

Kill switch, for "is my app broken or did GenClass change something?":

- `?genclass=off` in the page URL, or `localStorage.genclass = "off"`: `init` installs nothing and logs one line.
- `?genclass=observe|guard|heal`: overrides the mode.

Outside a browser (no `window`/`document`, e.g. SSR), `GenClass.init()` returns an inert runtime: no observers,
no model. Use [`createRuntime`](#headless-use-tests-ssr-simulation) for headless work.

## Options

```ts
interface InitOptions {
  mode?: "observe" | "guard" | "heal";                 // default "guard"
  model?: {                                             // or false: no model (observe only)
    baseUrl?: string;                                   // directory with model.json (default: jsDelivr CDN)
    device?: "auto" | "webgpu" | "wasm";                // default "auto"
    worker?: boolean;                                   // default true
    preload?: "eager" | "idle" | "lazy";                // default "idle"
  } | false;
  decider?: DecisionProvider | null;                   // bring your own decision provider instead of the model
  report?: "console" | "silent" | ((r: Report) => void); // default "console"
  observe?: Partial<Record<"fetch"|"xhr"|"user"|"errors"|"nav"|"storage"|"perf"|"websocket"|"timers", boolean>>;
  triage?: "salient" | "always";                        // default "salient"
  policy?: PolicyOptions;                               // see Policy
  redact?: (path: string, value: unknown) => unknown;   // default redacts keys matching /pass|token|secret|card|cvv|ssn|auth/i
  plugins?: Plugin[];
  historySize?: number;                                 // events kept, default 500
  debug?: boolean;                                      // console.debug every decision
  learn?: { persist?: boolean };                        // keep transition profiles in localStorage
  vocabulary?: { diagnoses?: Record<string, string>; actions?: Record<string, string> };
  settleMs?: number;                                    // quiet time that makes a settled point, default 60
  situation?: { budget?: number | "auto" };             // size of what the model reads, in characters (default "auto")
}
```

Performance: GenClass computes cheap facts for every write and request, and asks the model only about salient ones.
The situation the model reads is sized to the device (`situation.budget: "auto"`): 3,200 characters on WebGPU,
2,000 on 4-thread WASM (crossOriginIsolated pages), 1,100 on single-thread WASM. Held writes and requests wait at
most the hold budget (`policy.holdBudgetMs: "auto"`: 1.5 × the model's recent median latency, 150 to 800 ms), then
proceed unchanged. Serving your page with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` enables WASM threads (about 3× faster without WebGPU).

Self-hosting the model: `npx genclass-runtime fetch-model public/genclass-model` then
`GenClass.init({ model: { baseUrl: "/genclass-model/" } })`.

## State

GenClass protects state it can see. Register stores with `atom` (owned by GenClass), `guard` (owned by you) or an
adapter (Redux, Zustand, React hooks).

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
const res = await fetch(`/api/search?q=${q}`);
search.set((s) => ({ ...s, results: data }));                           // async write: may be held briefly
```

How writes flow: `set` proposes a mutation. Writes made while handling a user action (in the same task) and writes
made by GenClass itself apply immediately. Other writes are checked: if nothing about them is unusual they apply
immediately; otherwise they are held until the model answers (at most the hold budget, then they apply:
fail-open). If the model answers `discard` within 2 s after such a write applied, and nothing has overwritten it
since, GenClass reverts exactly that write (a "late revert", reported as such and undoable). Writes to one store apply in the order they were proposed. A functional update runs again
on the value at apply time; a held value write is re-applied as a patch of the fields it changed, so newer user
input to other fields of the same store is kept. Reading `get()` while a write is held returns the current value.

GenClass also learns, at *settled* points (no requests in flight, `settleMs` of quiet), generic relations between
your fields (`a == b`, `a == len(B)`, `a == sum(B[*].f)`, `a == sum(B[*].f * B[*].g)`, `a >= 0`, `a ∈ B[*].k`,
`B[*].k unique`, stable types, non-null) and each operation's usual effects on state. When a learned relation
breaks, or an operation changes state unlike it normally does, the model is consulted.

## Operations and user actions

The DOM, fetch, XHR, WebSocket and timers are observed automatically. These entry points cover anything else:

```ts
rt.op<T>(name: string, fn: () => Promise<T> | T, meta?: Record<string, unknown>): Promise<T>   // a named async task
rt.user<T>(action: UserAction, handler?: () => T): T | undefined   // a user action (cause of what follows)
rt.emit(name: string, data?: Record<string, unknown>): void        // a custom event in the timeline
rt.reportError(error: unknown, info?: { source?: string }): void   // a handled error worth knowing about

interface UserAction { kind: "click"|"type"|"change"|"submit"|"key"|"nav"|string; target?: string; value?: string; key?: string; sensitive?: boolean }
```

```ts
await rt.op("loadProfile", async () => profile.set(await (await fetch("/api/me")).json()));
rt.user({ kind: "click", target: 'button "Sync"' }, () => startSync());
```

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
rt.history(n?): RtEvent[]          // recent events, oldest first
rt.decisions(n?): Decision[]       // last 200 decisions
rt.interventions(n?): ActionRecord[]
rt.inflight(): Op[]
rt.setMode(mode); rt.pause(); rt.resume(); rt.destroy()
```

`pause()` stops consulting the model (everything proceeds unchanged, tracing continues); `destroy()` uninstalls
every observer and restores the globals it wrapped.

## Triggers and actions

| trigger | when | actions (passive first) |
|---|---|---|
| `mutation` | a state write is about to apply | `apply`, `discard`, `defer` |
| `request` | a fetch/XHR is about to be sent | `send`, `coalesce`, `delay`, `block`, `serve_cached` |
| `failure` | a request failed (network, timeout, 5xx, 429, 408) before the app sees it | `deliver`, `retry`, `serve_cached` |
| `stall` | a request is far past its usual latency | `wait`, `hedge`, `serve_cached` |
| `inconsistency` | a learned relation between fields broke | `ignore`, `rollback`, `resync` |
| `transition` | an operation changed state unlike it usually does | `ignore`, `rollback`, `resync` |
| `error` | an uncaught error or unhandled rejection | `ignore`, `rollback` |

| action | tier | effect |
|---|---|---|
| `discard` | guard | drop the write (undo: apply it now); decided after the write applied: revert exactly that write if nothing overwrote it (undo: re-apply) |
| `defer` | guard | hold the write until related requests finish, then decide again (twice at most) |
| `coalesce` | guard | do not send; reuse the response of the identical request in flight or just finished (`x-genclass: coalesced`) |
| `delay` | guard | wait min(250 ms · 2^failure streak, 8 s), then send |
| `block` | heal | do not send; answer 503 (`x-genclass: blocked`) |
| `serve_cached` | heal | answer with the last good response for this GET (`x-genclass: cached`; ≤ 256 KB, ≤ 64 entries, memory only) |
| `retry` | heal | re-send after min(200 ms · 2^(attempt-1), 5 s) when the body can be replayed |
| `hedge` | heal | send a second identical GET and use whichever answers first |
| `rollback` | heal | restore the affected stores to their last consistent snapshot (undo: restore the replaced values) |
| `resync` | heal | call the store's `resync` handler |

Actions are offered only when they apply (an identical request exists, a cached response exists, the body can be
replayed, a consistent snapshot exists, a `resync` handler exists). Responses are always cloned before the app
reads them. GenClass's own requests and writes are never gated.

## Policy

```ts
interface PolicyOptions {
  thresholds?: { report?: number; guard?: number; heal?: number };  // defaults 0.6 / 0.9 / 0.8
  allow?: string[];                 // only these non-passive actions may run
  deny?: string[];                  // these never run
  holdBudgetMs?: number | "auto";   // default "auto": clamp(1.5 × median recent model latency, 150, 800) ms
  holdUserWrites?: boolean;         // default false
  maxActionsPerMinute?: number;     // default 60
  requireDiagnosis?: boolean;       // default true
}
```

A non-passive action runs only if all of these hold, otherwise the passive action runs and the decision's
`reason` says why: the mode allows its tier; its calibrated probability `probabilities[action]` is at least the
tier's threshold; the model's top diagnosis is not `expected`; it is not denied (and is allowed, if `allow` is
set); fewer than `maxActionsPerMinute` actions ran in the last minute; the decision arrived within the hold
budget. While the model is loading, everything proceeds unchanged.

## Reports, explain and undo

With `report: "console"` every detection and intervention prints one line, followed by a collapsed group with the
evidence: the facts, the timeline, the exact situation text sent to the model, the answer probabilities, what
changed, how to undo it and how to deny that action. Repeats within a minute are summarised as "×N in the last
minute".

```
[GenClass] Prevented a stale write: search.results was written once by other operations since this write's cause (#6) started (v0 → v1), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later user action (#7). Dropped the write to search.results from GET /api/search?q=rea (#6); search stays at version 2. (stale, 0.97; discard 0.96)
```

```ts
const a = rt.interventions().at(-1)!;
a.changed;          // "Dropped the write to search.results from GET /api/search?q=rea (#6); search stays at version 2."
a.undo?.();         // discard: applies the dropped write now; rollback: restores the values it replaced
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
  app: () => ({ title: "Shop", route: "/cart" }),   // default: global.document.title and global.location.pathname
  hooks: { opCreated(op) {}, mutationProposed(m) {} },
});

interface DecisionProvider {
  readonly status: ModelStatus;
  ready(): Promise<void>;
  evaluate(req: { trigger; state; questions; priority?; subject?; timeoutMs? }): Promise<Record<string, Answer>>;
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
(`genclass(runtime, name)(stateCreator)`), `@genclass/runtime/devtools` (`mountDevtools(runtime, opts?)`). They are
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
  action: string; confidence: number /* probabilities[action] */; probabilities: Record<string, number>;
  executed: boolean; reason?: string; facts: string[];
  tier: "passive" | "guard" | "heal"; ran: string; answers: Record<string, Answer>; subjectRef?: SubjectRef;
}
type Detection = Decision;
interface ActionRecord { id: string; decisionId: string; action: string; tier; trigger; subject: string; at: number; ok: boolean; error?: string; changed: string; undo?: () => void; late?: boolean }
interface Explanation { message: string; decision: Decision; situationText: string; facts: string[]; timeline: string[]; answers: Record<string, Answer>; action?: ActionRecord; changed?: string }
interface RtEvent { seq: number; t: number; kind: "user"|"op.start"|"op.end"|"state"|"error"|"nav"|"perf"|"storage"|"custom"|"decision"|"action"; name: string; op?: number; cause?: number; data?: Record<string, unknown> }
interface Op { id: number; kind: "user"|"fetch"|"xhr"|"ws"|"task"|"timer"|"genclass"; name: string; detail?: string; start: number; end?: number; status?: "ok"|"error"|"aborted"|"blocked"; code?: number | string; cause?: number; root?: number; attempt: number; reads: Map<string, number>; identity?: string }
```

Privacy: values are summarised and redacted before they reach a situation (keys matching
`/pass|token|secret|card|cvv|ssn|auth/i`, password inputs, sensitive query parameters). Everything stays in the
browser; the model runs locally.
