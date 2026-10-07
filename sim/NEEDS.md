# SIM → CORE requests (relayed by the lead)

Status legend: OPEN (needed), ASK (would help), DONE (landed; verified by the sim).

The sim drives the real runtime with `createRuntime({ clock, global, decider, observe: { fetch: true, others false },
triage: "salient", mode: "heal", policy: { thresholds: { report: 0, guard: 0, heal: 0 }, holdBudgetMs: 1e9,
maxActionsPerMinute: 1e9 } })` and records every `decider.evaluate(req)` call. To label a decision the sim must
know *which* app-level write/request/error the runtime is asking about (the label comes from the sim's knowledge of
intents, never from the text). These are the minimal seams that make that possible.

## 1. OPEN: structured subject on `EvaluateRequest` (and `Decision.subject`)

```ts
interface EvaluateRequest {
  trigger: TriggerKind; state: JevState; questions: Record<string, Question>; priority?: number;
  /** For non-model providers (tests, sim). Never serialized into `state`. */
  subject?: {
    kind: TriggerKind;
    op?: number;          // request / failure / stall / transition: the op id; error: the op that threw, if known
    mutation?: number;    // mutation: the held mutation id
    store?: string;       // mutation / inconsistency / transition: store name
    paths?: string[];     // fields involved
    cause?: number;       // cause op of the mutation
    error?: unknown;      // error trigger: the raw error object (identity preserved)
    invariant?: string;   // inconsistency: the violated relation, as text
  };
}
```

## 2. OPEN: synchronous creation hooks (sim/tests only)

```ts
createRuntime({ ..., hooks?: {
  opCreated?(op: { id: number; kind: string; name: string; cause?: number; root?: number }): void;
  mutationProposed?(m: { id: number; store: string; paths: string[]; cause?: number }): void;
} })
```
Called synchronously *inside* the instrumented `fetch(...)` call (before any await) and *inside* `atom.set(...)`.
The sim sets an ambient tag around its own calls, so `op id → app request` and `mutation id → app write` become
exact. (Equivalent alternative: guarantee `on("event")` delivers `op.start` synchronously inside the fetch call,
and add the mutation hook.)

## 3. OPEN: let forced actions run regardless of the diagnosis gate

The guard/heal gate requires the model's top diagnosis ≠ `expected`. The sim forces each applicable action at a
decision point to measure its counterfactual cost, including on benign situations. Please add
`policy.requireDiagnosis?: boolean` (default `true`); the sim passes `false`. Without it the sim must return a fake
non-`expected` diagnosis whenever it forces a non-passive action, and if decisions appear in later timelines that
fake label leaks into later training rows.

## 4. ASK: vocabulary/description overrides

`createRuntime({ vocabulary?: { diagnoses?: Record<string, string>; actions?: Partial<Record<string, string>> } })`:
replace descriptions and (for diagnoses) the label subset. The sim would randomise paraphrases/subsets per
trajectory *through the runtime*, so `questions` stay byte-identical to what the runtime builds. Fallback if not
added: a documented post-transform in `sim/src/run/transform.ts` (default wording kept on ≥ 50% of rows).

## 5. ASK: guarantees the sim relies on

- `runtime.situation(trigger)` is side-effect free (no id counters consumed, no events recorded), so ask probes
  never perturb a run. The sim checks prefix equality and will report violations.
- No real timers/`queueMicrotask`-only assumptions beyond the injected `Clock`; `afterTask` is honoured.
- Export the token counter used for the 1,000-token state budget (e.g. `countStateTokens(state)`) so the sim's
  stats report exact lengths.
- Document how headless `app` (title, route) is derived; the sim provides `global.location` (`href`, `pathname`,
  `search`) and `global.document.title`, updated on navigation, and records navigation with
  `runtime.user({ action: "navigate", target: route })`.
