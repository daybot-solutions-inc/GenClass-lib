# GenClass Runtime: architecture

GenClass Runtime is a client-side intelligence layer. It runs inside the page, watches what the application does,
and uses a small local model to decide, in real time, whether something is going wrong and whether to step in.
This document explains how the parts fit together and why they are built this way. The binding spec is
[CONTRACT.md](CONTRACT.md) and the API is in [API.md](API.md).

## Design principles

1. **No hardcoded bugs.** The runtime contains no rule like "if a stale response arrives, drop it". It computes
   generic facts and asks the model. All runtimes compute the same facts: happens-before order, versions,
   repetition, failure streaks, latency against learned baselines, learned invariants and transition profiles.
   The diagnosis and the action come from the model.
2. **Precision first.** A false intervention costs more than a missed bug. The default `guard` mode takes only
   minimal, reversible actions, and only when the model is very confident and its own diagnosis says something
   is wrong.
3. **Observable.** Every detection and intervention is reported in plain English with its evidence, can be
   explained after the fact, and can be undone where possible. A kill switch rules GenClass out in one step.
4. **Cheap by default.** Facts are cheap and always on. The model runs only for salient situations, off the main
   thread, sized to the device.
5. **Train what you run.** The training data comes from the real runtime code, so the model sees exactly the text
   it will see in production.

## Data flow

```
 app code ──► observers ──► trace (events, ops, causality) ──► stores (versions, holds)
                                   │                                │
                                   ▼                                ▼
                        learned baselines, invariants, transition profiles
                                   │
          trigger (write about to apply, request about to be sent, failure, stall,
                   broken invariant, unusual transition, error, developer question)
                                   │
                                   ▼
                        facts ──► triage ──(salient)──► situation + questions
                                   │                                │
                             (not salient)                          ▼
                                   │                 model host (Web Worker, ONNX on WebGPU/WASM)
                                   ▼                                │
                            passive action                          ▼
                                                    answers: diagnosis + action probabilities
                                                                    │
                                                                    ▼
                                         policy gate (mode, tier, confidence, diagnosis, rate)
                                                                    │
                                                                    ▼
                                    action (or passive) ──► report / explain / undo / events
```

### Observers and the trace (`src/observe`, `src/trace`)

- **Instrumented sources:** `fetch`, `XMLHttpRequest`, `WebSocket`, DOM user events (capture phase, trusted
  events only), errors and unhandled rejections, history navigation, storage, and long tasks.
- **Operations:** every asynchronous operation becomes an *op* with a signature (`GET /api/items/:id`), a cause and
  a root. User actions are instantaneous ops, so they can be causes.
- **Causality across `await`:** an "ambient op" is set during user handlers and `rt.op`, re-established when a
  wrapped request or its body settles, and cleared after the task. State writes record the ambient op as their
  cause. This is best effort, and it is enough to say "this write comes from the response to the request the user
  started by typing *rea*".

### Stores and the mutation pipeline (`src/state`)

- **Field versions:** state registered through atoms, `guard` or the Redux/Zustand/React adapters gets per-field
  versions with writer history.
- **Proposals and holds:** each write is first a proposal. A salient proposal from asynchronous code is *held*
  until the model answers or the hold budget runs out, then applied, dropped or deferred. Writes made
  synchronously by a user handler are never held.
- **Invariant miner:** at settled points it learns relations that keep holding, such as `total == sum(price·qty)`,
  `count == len(items)` and membership. A learned relation that breaks raises an `inconsistency`.
- **Transition profiles:** these learn which fields each operation usually writes. A deviation such as "wrote only
  `cart.items`, unlike the last 317 times" raises a `transition`.

### Situations and triage (`src/situation`)

- **Situation:** a Jev-style state object with `app`, `trigger`, `facts`, `in_flight`, `timeline`, `state` and
  `stats`, plus two standing questions:
  - `diagnosis`: expected, stale, conflict, duplicate, inconsistent, failing, transient, slow, overload or unusual;
  - `action`: one option per applicable generic action, with its description.
- **Facts:** short sentences with explicit relations and numbers, for example "written once by other operations
  since this write's cause started (v0 → v1), last 0.69 s ago by GET …?q=reac, which started 0.09 s after it,
  from a later user action".
- **Triage:** the model is asked only when some fact is non-neutral (concurrency, repetition, failure, an anomaly
  against a baseline, a broken relation, an error). Plain traffic never reaches it.
- **Device-sized budget:** 3,200 characters on WebGPU, 2,000 with WASM threads, 1,000 on single-thread WASM. Small
  budgets also use compact questions (bare labels).

### Decisions and actions (`src/decide`, `src/runtime.ts`)

- **Actions are capabilities, not rules.**
  - Guard tier: `discard`, `defer`, `coalesce`, `delay`.
  - Heal tier: `block`, `serve_cached`, `retry`, `hedge`, `rollback`, `resync`.
  - Passive: `apply`, `send`, `deliver`, `wait`, `ignore`.
  - Plugins can add their own; the model reads each action's description.
- **Gate:** let *A* be the permitted non-passive actions. GenClass acts only if three things hold:
  - the model's summed probability over *A* reaches the tier threshold (guard 0.9, heal 0.8);
  - its top diagnosis is not `expected`;
  - the decision is within the rate limit and the hold budget.

  The chosen action is the most likely action in *A*.
- **Late revert:** a decision that arrives after a held write already applied can revert exactly that write. That
  is allowed only within 2 s, if nothing has touched the write since, and if no other write from the same chain
  happened.

### Model host (`src/model`)

- **Engine:** a TypeScript port of the GenClass engine (byte-level BPE tokenizer, packer, calibration). It is
  bit-exact with the Python packer.
- **Inference:** runs in a module Web Worker with an inline fallback. WebGPU (fp16 when the GPU has `shader-f16`,
  int8 otherwise) is preferred; WASM is the fallback. The WASM-only ONNX Runtime build is used when WebGPU is
  unavailable.
- **Loading:** the model loads at idle and is verified with sha256 and cached in Cache Storage. While it loads,
  every decision fails open at once.

## The model and how it is trained

GenClass is a Jev-style typed-decision encoder: one forward pass reads the state and answers several typed
questions (choice, yes/no, score). Each option attends only to the state and its own question, so option order
cannot change the answer. The runtime model is a specialist fine-tuned from the GenClass base. There are two
sizes, R17 (17M parameters) and R32 (32M), both with a pruned 16k vocabulary and int8 weights.

Training data (`sim/`, `training/`):

1. **Simulator.** Thousands of random apps across 55 domains are built from 15 feature combinators: search,
   lists, forms, carts, boards, chat, autosave, polling, uploads and more. They mix correct guards with realistic
   defects, and run real `async` code against the **real runtime** in a deterministic virtual world (clock,
   network with latency, failures and outages, push channels, users who type, double-click and change their
   minds).
2. **Labels from outcomes, not rules.** At a sampled decision point, the sim re-runs the scenario with each
   applicable action forced there, scored over several sampled futures. The cost of each run is how far the app
   drifts from what the user intended, which is the same session in an ideal serial, zero-latency, exactly-once
   world. It also counts persistent server damage, user-visible errors, wasted requests and added latency. The
   action label is a soft distribution over those costs: ties go to doing nothing, and labels are sharp only when
   outcomes agree across futures. The diagnosis label comes from the simulator's knowledge of user intents.
3. **Curriculum.** Programmatic error-detection-and-fixing exercises: ordering, causality, versions, duplicates,
   streaks, baselines, invariants, and HTTP/JS error semantics.
4. **Held out for testing.** Domains and program families that never appear in training. The demos are written
   independently of the simulator and act as an external test.

## Evaluation

- **Simulator test split:** action and diagnosis accuracy, plus the false-intervention rate and precision of the
  guard and heal gates, per trigger and per device budget.
- **Demos:** six real small apps covering typeahead, autosave, checkout, a flaky dashboard, a live kanban board,
  and real-time decisions. Each is driven by Playwright under chaos and on clean runs with GenClass off, in guard
  and in heal. Reports cover bug rate, false interventions on clean runs, and added latency.
