# @genclass/sim: training-data generator for GenClass Runtime

A deterministic virtual world that creates random web apps, runs them with simulated users on a simulated network
and server, and drives the **real runtime** (`createRuntime` from `@genclass/runtime`) through it. Every time the
runtime asks its decider a question, the sim records the request verbatim (`state`, `questions`) and labels it by
**counterfactual outcome**: it re-runs the same world with each applicable action forced at that point and scores
every outcome against the user's intended outcome. Output is CONTRACT-D jsonl
(`{id, split, family, state, questions, labels, meta}`).

Observers on: `fetch`, `timers` and `websocket`. User actions go through `runtime.user()`, uncaught errors through
`runtime.reportError()`, and the route through `CreateOptions.app()`. Nothing in the runtime knows about the sim. The sim sees only the public API plus the seams CORE added for it:
`hooks.opCreated/mutationProposed` and `EvaluateRequest.subject`, which correlate decisions with app-level
operations, `vocabulary` (wording randomisation), and `policy.requireDiagnosis: false` (with gate thresholds of 0.5: the decider puts probability 1 on the forced action, so
exactly that action runs under the summed-mass gate). The demos (`demos/`) were
not read or modelled.

## Run it (on the VM; never on the Mac)

```bash
scripts/vm.sh run sim 'npm install --ignore-scripts && cd sim && npm run build:runtime-core && npx tsup'
scripts/vm.sh exec sim 'cd sim && SIM_RUNTIME=real npx vitest run'                 # tests on the real runtime
scripts/vm.sh exec sim 'cd sim && node dist/gen.js --rows 300000 --out out/r300k --seed 1 --workers 24'
scripts/vm.sh exec sim 'cd sim && node dist/gen.js --sample --workers 8'           # samples/sample.jsonl + EXAMPLES.md
scripts/vm.sh exec sim 'cd sim && node dist/smoke.js --seeds 40 --show mutation'   # inspect raw situations
scripts/vm.sh exec sim 'cd sim && python3 scripts/analyze.py out/r300k'            # per-trigger diagnosis x best action, budgets
```

Committed samples (`samples/`): `sample.jsonl` (200 rows, stratified over trigger × diagnosis × passive/act),
`EXAMPLES.md` (16 pretty-printed rows covering every trigger), `sample-stats.json`, and `stats-final-a.json` (stats of
final phase A: 600k rows on the frozen runtime). Regenerate all data whenever the runtime's situation text changes.

**Situation v2 (CORE batch 4, from 2026-10-08).** The runtime decides responses and WebSocket messages at the
network boundary (`delivery`: deliver / discard / defer), and `mutation` is non-blocking (late revert). The sim
correlates delivery subjects through `opCreated`: fetch ops via the ambient app op, and message ops via a push id
set while the virtual socket dispatches. It labels them like mutations, from the writes they cause. Labels use
S1 (diagnosis consistent with the action label) and S2 (futures re-draw what a runtime cannot observe); both are
described under The oracle. The v1 datasets below predate both and remain valid for situation v1 only. The
separability analysis behind S1/S2 and the CORE fact proposals is `SEPARABILITY.md` (probe mode:
`SIM_PROBE=1`, `meta.probe`; analysis only).

**Final datasets (runtime frozen at tag `situation-v1`).** `bash sim/scripts/final.sh a` writes phase A (600k rows,
seeds from 10,000,000) to `sim/out/final-a/{train,dev,test}.jsonl` (`sim/out` → `/data/sim-out` on the train VM) with `stats.json`. `bash sim/scripts/final.sh b`
writes phase B (1.4M rows, seeds from 50,000,000) as resumable parts: `sim/out/final-b/parts/part-NNNNNN.<split>.jsonl`,
each a complete, usable file, with a `part-NNNNNN.json` marker once finished. If B is interrupted (the VM shuts down
at 03:00 UTC), run `final.sh b` again: finished parts are skipped, half-written `*.tmp` parts are regenerated, and it
stops at 1.4M rows in total. `final.sh merge-b` concatenates the parts into `train/dev/test.jsonl`, or read
`parts/*.train.jsonl` directly. `python3 sim/scripts/analyze.py sim/out/final-b` works on parts too. The gate
thresholds and the correlation header (`x-request-id`, excluded from request identity) were adjusted for the frozen
runtime.

**Throughput and the big run.** With adaptive K = 3 futures and 15% long sessions: about 245 rows/s on 56 workers
(train VM; phase A: 600k rows in 41 min). To split it across machines, give each one a
disjoint seed range, e.g. VM `--seed 1 --rows 500000` and a c-node `--seed 50000001 --rows 500000` (about 5.7 rows
per trajectory, so the ranges never meet). Concatenate the `train/dev/test.jsonl` files: splits are per scenario, so
they stay consistent across machines.

`npm run build:runtime-core` builds only the runtime's `src/index.ts`. The runtime's full tsup config also builds
the UI adapters, and that fails until those files exist. `gen.js` flags: `--rows N`, `--out DIR`, `--seed S`
(first scenario seed), `--workers W` (`worker_threads`), `--max-points K` (labelled decisions per trajectory,
default 6), `--test-keep F` (fraction of held-out trajectories kept, default 0.33), `--explore X` (exploration
scale, default 1), `--no-ask`, `--sample`, `--allow-fake` (test double, never for training). Outputs:
`train.jsonl`, `dev.jsonl`, `test.jsonl` and `stats.json`.

## The world

| part | file | what it does |
|---|---|---|
| event loop | `src/loop.ts` | Macrotasks ordered by (virtual time, seq). After each one, a real `setImmediate` turn drains all microtasks (undici `Response` body reads settle in microtasks; verified), then `afterTask` hooks run. No real time anywhere. |
| PRNG | `src/rng.ts` | sfc32 with *keyed* forks: `fork(label)` derives from the construction seed, never from draw order. Latency for a request is keyed by (seed, request identity, occurrence of that identity), so forcing an action never shifts unrelated draws. |
| server | `src/net/server.ts` | Collections, versioned documents, counters, sessions. Routed endpoints with real semantics: non-idempotent POSTs duplicate, versioned PUTs return 409, `Idempotency-Key` replay, partial-failure bulk ops, rotating refresh tokens, full-object echoes. Item ids are content-derived, so the same intent gets the same id in every run and a duplicate gets a new one. |
| network | `src/net/network.ts` | `fetch` returns real `Response` objects after virtual latency, honours `AbortSignal`, and network errors are `TypeError`. Latency is lognormal per endpoint kind, with per-endpoint personalities, spikes, slow periods, capacity overload (503/429/latency), per-endpoint rate limits with or without `retry-after`, outages (503/500/502, network error, hang until the gateway timeout, empty lists), replica lag, server bugs (dropped/null fields, empty lists, HTML instead of JSON) and transient 5xx (some after the write committed). Live updates use a `WebSocket` class on `global` (`wss://host/ws/<path>`, messages in order per topic), so the runtime's websocket observer attributes push-driven writes to their message. |
| apps | `src/app/**` | Programs built from 15 feature combinators: real `async` code against the runtime-instrumented `fetch`, runtime atoms and timers. |
| users | `src/app/feature.ts` (`UserModel`), `features/*.session` | Personas with per-key typing (lognormal, bursts, typos with backspace), think times, accidental double clicks, impatient re-clicks (only while the operation is still pending), intentional repeats (adding the same thing twice, quick corrections, rapid +1 clicks), navigation and idle stretches. |
| scenario | `src/world/scenario.ts` | seed → domain, 1–3 features (+30% background noise), naming, API envelope style, id style, chaos level, persona, session (20–75 s, or 2–5 min for 15% of scenarios, with a calm warm-up of 30–60% so baselines, invariants and transition profiles get learned), external events (other users, metric drift; some correlated with the user's own edits), ask-probe times, wording, and the situation size `situation.budget` (40% 3,200 chars for WebGPU, 30% 2,000 for WASM ≥ 4 threads, 30% 1,000 for single-thread WASM (compact questions at ≤ 1,400); recorded in `meta.budget`, with per-budget stats in `stats.json` under `by_budget`). |

### Program space

- **55 domains** (`src/app/vocab.ts`), each with 2 entities (fields, value words, numeric ranges, statuses, flags,
  verbs), documents, metrics, live topics, settings, bulk verbs and people. Commerce, chat, docs, project tools,
  finance, health, travel, IoT, games, media, CRM, HR, education, maps, analytics, social, support, inventory,
  logistics, banking, calendar, food, real estate, music, news, email, notes, todo, fitness, weather, rides,
  events, hotel, library, legal, insurance, energy, farm, fleet, pharmacy, devops, code hosting, marketing,
  surveys, nonprofit, permits, sports, photos, jobs, pets, auctions, wiki, procurement, payroll, invoicing.
- **Naming** (`src/app/naming.ts`). Route prefixes (`/api`, `/api/v1`, `/v1`, `/rest`, `/svc/<app>`, none) and
  casing. Store names come from domain words. Field names come from synonym pools (`items|results|rows|entries|…`,
  `loading|isLoading|busy|…`, and so on). Four response envelope styles (`{items}`, `{data, meta}`, bare arrays,
  `{results, count}`) and four id styles. Routes never collide across features of one program.
- **15 feature combinators** (`src/app/features/*`). Each has knobs that pick a correct guard or inject a defect:

| feature | guards | defects / risky variants |
|---|---|---|
| search (typeahead) | abort previous, request id, query check, cache, debounce, min length | no guard (out-of-order results), unhandled rejection |
| editor (autosave + echo) | serialize saves, apply echo only if unchanged, version-only echo, version check + 409 handling, apply live edits only when clean | overlapping saves, echo of an older save over newer typing, blind live edits, retry of old text |
| form (create) | disable while submitting, idempotency key, retry with the same key | double submit, retry without key after a timeout, optimistic append without rollback, count not kept on all paths |
| cart | add-button guard, rollback, full recompute, checkout disable / key / retry policy | server echo of the full cart (stale when several updates are in flight), totals not recomputed on rollback/echo/qty paths |
| toggle | per-item pending guard, rollback, absolute PATCH | relative toggle endpoint, echo flip-back, no rollback, count partial |
| counter | echo only for the latest click, absolute PUT | non-idempotent increment + retries, stale echo |
| poll (dashboard) | skip if in flight, exponential backoff, sequence guard | overlapping polls, tight retry loop (storm), unhandled errors after 2 failures, stale range responses |
| board (kanban + live) | version check, ignore pushes for pending cards, 409 handling | blind push application (conflicts), counts not updated on push |
| chat | dedupe by id / clientId, replace temp message by clientId, disable while sending | duplicate messages (response + push), draft cleared under the user |
| settings | sequence guard, serialized writes, rollback | full-object echo reverting a newer toggle |
| nav (views) | route guard, abort on navigation, SWR cache, allSettled | `Promise.all` unhandled rejection, previous view's data written into the current one |
| list (filters + infinite scroll) | request id / abort, load-more in-flight guard | stale page after a filter change, duplicate page appends |
| bulk | per-id results | assume all succeeded (client diverges from server), counts partial |
| auth (expiring tokens) | single-flight refresh | one refresh per 401 → rotated token → forced logout |
| benign (background) | — | presence heartbeats (identical requests by design), beacons whose failures the app ignores, config prefetch, harmless uncaught errors (`ResizeObserver loop…`, `Script error.`) |

A program's **family** is its sorted set of feature kinds, for example `cart+search`. A row's family is
`<program family>/<trigger>`. Its **patterns** are the variant tags, such as `search/guard:none`.

## The oracle

### Intended outcome

The **ideal run** is the same program and the same intended user actions at the same virtual times, with the same
external events, in an ideal environment: zero latency, no failures, no chaos, and no accidental or impatient
clicks. It is also exactly-once: a duplicate request the app itself generates, such as a second refresh started
by a concurrent 401, shares the original's result. The ideal run records the client state after every macrotask
and the server state after every write.

### Cost of a run

Implemented in `src/oracle/cost.ts`. A counterfactual run for decision *k* stops at `t_k + 15 s`. Its cost covers
only what happens after the decision:

```
cost = 1.0 · ∫ D(t) dt                                  t ∈ [t_k, t_k+10 s], seconds
     + 4.0 · D(t_k+15 s)                                client still wrong at the end
     + 25 · (extra/missing server items) + 6 · (changed server items, doc fields, counter units)
     + 0.8 · ∫ (#violated app relations) dt + 2.0 · (#violated at the end)
     + 1.5 · (user-visible error episodes) + 1.0 · (uncaught errors)            beyond the ideal run
     + 0.08 · (requests beyond the ideal run, per endpoint)
     + 0.25 · (seconds user-initiated operations were pending)
```

- `D` is the weighted divergence of every store field from the ideal state at the same time. Lists compare as
  multisets of item content (ids, versions and temp markers are ignored), scalars compare 0/1, and objects compare
  per key. Weights come from the feature: data 1, inputs and secondary values 0.3–0.6, flags 0.1–0.3, versions 0.
  Error-message fields are 0, because errors are charged as episodes and a branch must never win by hiding a
  message. The derived field of any violated app relation counts as fully wrong even when it equals the ideal
  value.
- The server term is persistent damage. A duplicate order or a lost create is weighted far above transient UI
  wrongness.
- **App relations** are executable checks declared by features: count = len(items), total = Σ price·qty,
  badge = cart count, per-column/per-status counts.

### Labels

- `action` is a soft label over **K = 2–3 paired futures**. Future 0 keeps every random draw. Futures 1–2
  re-draw everything a runtime cannot observe at the decision, with the same salt for every action (common
  random numbers). Re-drawn (**S2**, `src/run/latent.ts`, `SIM_S2=0` turns it off):
  - draws after the decision: network latencies and failures, push latencies, model latencies, other users'
    timing;
  - the user's own later steps: a per-future tempo and per-gap jitter; order and content are kept;
  - outage, offline, slow, socket-drop and server-bug windows: the remaining length of a window already running,
    and the start of later ones;
  - prefix latents the client has not observed:
    - whether an ambiguous failed write committed (a 500 on a write, posterior `pc/(pc + (1−pc)/3)`; a network
      error after processing, 0.5);
    - the remaining time of requests in flight at the decision, and the server-side draws of requests that
      arrive after it;
    - accidental vs intended for repeated activations before the decision, drawn from
      `REPEAT_PRIOR(gap)` (measured on the user model) — only the ideal run changes.

  A re-drawn latent that changes an observed prefix (a later read in the prefix would have seen the commit) is
  re-run with network/timing randomness only (`info:latent-fallback` in stats, about 6 % of re-seeded futures).
  The ideal run of every re-seeded future is re-run. Future 1 always runs. Future 2 runs only when some
  intervention beats passive by > 0.05 in a future seen so far.

  Each action's cost per future gets a tier premium (precision first: passive 0, guard 0.25, heal 0.5). An action
  whose mean cost is within 0.05 of passive is a practical tie and is pinned to passive + 1.5. Then
  `p_a ∝ exp(−gap_a/τ_a)`, where `gap_a` is the mean adjusted cost difference to the best action and
  `τ_a = 0.10 + 1.0·SE_a` (SE of that paired difference over futures). The label is therefore
  softmax(−E[cost]/τ) over what the runtime can observe. Clear cases stay sharp, outcomes that hinge on hidden
  state or the future stay soft, and cheap high-upside actions get mass when their expected gain is clearly
  positive. `meta.cost_futures` keeps the raw per-future costs, so labels or an expected-advantage target can be
  re-derived (`scripts/relabel.py`). Background in `SEPARABILITY.md`.
- `diagnosis` is a hard label from the sim's knowledge at decision time (`src/oracle/diagnose.ts`). It is omitted
  when the runtime's vocabulary for that trajectory lacks the gold label.
  - **S1: never `expected` where acting clearly wins.** When the subject looks normal but a non-passive action
    beats passive by ≥ 1 (premiums included), the diagnosis names what the action repairs or prevents
    (`diagnosisFromOutcome`):
    a) the verdict of the last non-`expected` write to a client field that is already wrong vs the ideal run;
    b) `duplicate` for a repeat of an accidental activation (any body, for example a toggle clicked back);
    c) `duplicate` for coalesce/block with an identical request in flight or just answered;
    d) `inconsistent` (inconsistency/transition) or `stale` when fields are already wrong with no named cause;
    e) `unusual` otherwise.

    `meta.diagnosis_s1` gives the rule letter and `meta.diagnosis_subject` the subject-only verdict.
  - delivery (situation v2): the verdict of the first write the delivered response or message makes (the mutation
    rules below, computed when the write is proposed).
  - mutation: a feature classifier first (content bookkeeping of which intent the displayed data reflects).
    Otherwise: partial-update write → `inconsistent`; server bug / outage-emptied data → `unusual`; repeat of
    an accidental click or app duplicate → `duplicate`; replica lag, or data of a superseded intent → `stale`;
    a late async write over fields the user changed after its operation started → `stale`; a remote push while
    a local change to the same key is in flight → `conflict`; else `expected`.
  - request: duplicate (accidental repeat, app duplicate, retry of a non-idempotent request that already
    committed); overload (storm code path, or ≥ 6 requests/s to that endpoint); stale (superseded intent);
    failing (streak ≥ 2); else expected.
  - failure: transient (an isolated random 5xx/network error, or a timeout caused by a latency spike: a retry
    would very likely succeed); failing (outage of any kind, including hangs; streak ≥ 2); slow (timeouts during a
    slow period/overload or repeated timeouts); overload (429/503 shedding while the client sends ≥ 3
    requests/s); unusual (server bug).
  - stall: failing (outage), overload (client-caused), else slow.
  - inconsistency: `inconsistent` only if an app relation is actually violated in the current client state and
    involves the flagged fields. Coincidental learned invariants ("values unique", "x != null",
    "count == len(items)" when every qty was 1) → `expected`.
  - transition: genuine deviations (server bug, outage-emptied data, replica lag, partial update) → `unusual`;
    failed ops → their failure diagnosis (transient / failing / slow / overload); benign changes (legitimately
    empty results, a new branch) → `expected`. User and timer ops are resolved through their causal chain.
  - error: from the failure that caused it (transient / failing / slow / overload / unusual). Harmless noise
    errors → `expected`.
- **Diagnosis-only rows**: decisions where only the passive action applies (for example a harmless uncaught error
  whose chain wrote nothing) carry only the `diagnosis` question; up to 3 per trajectory, no counterfactuals.
- **Ask rows** (`src/ask/questions.ts`) attach 1–3 programmatic questions to `runtime.situation("ask")`, with
  exact answers from the trace: write in flight, anything in flight, pending count (score), last failing
  endpoint (choice, "none of these"), failure in the last 5/10 s, failure count (score), user waiting more than
  N s, user acted in the last N s, last save succeeded, current route (choice), longest pending request (choice).
  Every generator checks that its evidence appears in the situation text and skips borderline timings.

### Decision points, replay and exploration

- The recording decider numbers `evaluate` calls in order. It answers with probability 1 for the chosen action and
  the sim's diagnosis, after a virtual model latency (lognormal, median 6–25 ms per scenario).
- **Base run.** Exploration ε per trajectory is 0 (4/9 of trajectories), 0.08 (3/9) or 0.2 (2/9) per decision
  where the sim sees a problem, and ε/4 elsewhere. The chosen action is a uniformly random non-passive applicable
  action, so later rows also cover post-intervention situations. Rows record how many explorations preceded them
  (`meta.explored_before`).
- **Counterfactuals.** For each sampled decision k (up to 6 per trajectory, weighted toward rare triggers and
  problem situations), for each applicable action a, and for each of up to 3 futures, the sim re-runs with the
  base run's choices before k, `a` at k, and the passive action after k. Each run stops at k + 15 s. Each re-run checks that every decision up to k is byte-identical to
  the base run (`prefix-mismatch` drops; 0 so far).
- **Future policy = passive.** A single-point counterfactual still credits discarding one stale write when later
  stale writes also land, because divergence is time-integrated (tested). `defer` is evaluated as "defer, then
  apply on re-trigger".

### Wording randomisation

- Diagnosis labels and descriptions go through the runtime's `vocabulary.diagnoses`, per trajectory: 50% default;
  otherwise paraphrases (60% per label), and in 30% of those 1–2 droppable labels are removed (never `expected`).
- Action descriptions go through `vocabulary.actions`: 50% default; otherwise each action is paraphrased with
  p = 0.6 (`ACTION_PARA` in `src/run/transform.ts`).
- The post-transform (`src/run/transform.ts`, mirrored by the lead) does only what the runtime has no option for:
  50% of rows unchanged; otherwise action options are shuffled (p 0.5), and with p 0.12 one non-passive,
  non-best action is dropped (as with `policy.deny`) and the soft label renormalised.

## Row types, scale and the cluster (round 2)

| type | CLI | what | cost | `meta` |
|---|---|---|---|---|
| gold | `gen.js` (default) | Counterfactual action labels (K = 3 futures), gold diagnosis, ask rows | ~4.4 rows/s per worker | `costs`, `cost_futures`, `se`, `non_passive_mass`, `passive`, ... |
| unlabeled | `--unlabeled` | Base run only: every decision point (≤ 40 per trajectory) with state/questions and the gold diagnosis, no action label; ask rows | ~150 rows/s per worker (~13k rows/s per F80) | `unlabeled: true`, `ran`, `actions` |
| on-policy | `--on-policy <model dir> [--gate shipping\|explore]` | The model decides through the runtime's gate in heal mode: `shipping` = the runtime defaults (guard 0.9 / heal 0.8 on summed permitted mass, diagnosis gate; or the model's own `meta.json` `gate` once exports carry one), `explore` = 0.5 for guard and heal (diagnosis gate kept), which surfaces the interventions the model would make as thresholds come down. The model answers the first 80 decisions of a base run (later ones are passive and never labelled); points where it acted or stayed passive on a problem are counterfactual-labelled with S1 + S2 (DAgger) | ~0.4 rows/s per worker with native onnxruntime-node (~30–55 rows/s per F80; `SIM_ORT=web` forces WASM, 5× slower; parity on TRAIN's fixtures: 307/307 answers, max probability difference < 1e-4) | `on_policy: true`, `gate`, `policy_model`, `model_probs`, `model_choice`, `model_diagnosis`, `ran`, `false_intervention`, `miss`, `ran_harm` (mean cost of what ran minus passive) |

On-policy mode loads the runtime's own model host (MODEL's `src/model/host.ts`, built unmodified into
`sim/dist/model-host` by `npm run build:model-host`) inline in Node on onnxruntime-web WASM. A custom `fetch` serves
the export directory and the ORT wasm from disk. Real inference time is held out of virtual time (`loop.hold`). The
answer arrives after the scenario's virtual model latency, so runs stay deterministic. Replays force what the gate
actually ran at every earlier decision. Past decisions do not render in situations, so prefixes are byte-identical
(checked).

Every row also has `meta.runtime_tag` (the runtime build, e.g. `situation-v2.1`), `meta.program_family`, `meta.passive`, `meta.clean` (5% clean runs: calm network, no failures,
no accidental clicks, correct guards; any non-passive answer there is a false positive), `meta.persona` and
`meta.chaos`.

**Cluster** (`sim/scripts/cluster/`):
1. `DIST=sim/dist bash sim/scripts/cluster/bundle.sh` on the train VM builds `~/xfer-sim/simbundle.tgz` (≈ 100 MB:
   Node 22, runtime dist, sim dist + model host, needed node_modules) and serves it on `10.0.0.4:8810`.
2. On the Mac: `orchestrate.sh start data c02 …` (one `az vm start` at a time, with timeouts), then
   `orchestrate.sh run RUN gold|unlabeled|onpolicy:<dir> ROWS_PER_NODE data c02 …`. Each node downloads the bundle,
   runs resumable parts with a disjoint seed range (node cNN: base + NN·10⁸; gold 10⁹, unlabeled 3·10⁹, on-policy
   5·10⁹; `data` = 12) and serves `~/simgen/out` on `<private ip>:8811`. `orchestrate.sh status RUN …` shows
   progress; `orchestrate.sh run …` again resumes after an interruption.
3. On the collector (`data`: 406 GB disk): `python3 collect.py RUN ~/simdata/RUN <node private IPs…>` pulls finished
   parts (re-runnable while nodes generate), dedupes globally over sha1(state + questions) with test first (no
   leakage), and writes `{train,dev,test}-NNNNN.jsonl.gz` (500k rows each) plus `manifest.json`. It processes about
   19k rows/s; gz is about 290 bytes per row.
4. `orchestrate.sh stop …` deallocates nodes one at a time. With no shutdown backstop, every node is deallocated as
   soon as it is idle.
5. Situation-v2 runs use `bigrun.sh`, which wraps the steps above:
   - `start NODES` (`az vm start --no-wait`, one call at a time, then waits for ssh);
   - `unl RUN ROWS NODES` / `gold RUN ROWS NODES` (seed bases 16·10⁹ / 11·10⁹ + NN·10⁸, disjoint from v1;
     re-fetches the bundle);
   - `wait RUN NODES`;
   - `ips NODES` (the addresses collect.py needs).

   On-policy: `MODEL_DIR=<export> MODEL_NAME=<name> bash sim/scripts/cluster/bundle.sh` ships the export (q8 +
   tokenizer, calibration, meta) and onnxruntime-node (linux-x64 only) in the bundle; then
   `bigrun.sh onpol RUN shipping|explore ROWS NODES` (seed bases 22·10⁹ / 24·10⁹ + NN·10⁸, `MAXP` points per
   trajectory, default 10). `drain.sh RUN OUT host=ip …` pulls each node's parts as soon as it finishes, deallocates
   it, then builds the merged shards and `scripts/onpolicy_report.py` (acts, false interventions, harm, misses by
   gate and trigger, with the worst row ids).

   Collect on the train VM into `/data/sim-out/<run>` (1 TB disk). Measured on one F80 (c12, batch-4 runtime):
   gold about 200–250 rows/s, unlabeled about 11k rows/s.

**Program space, round 2.**
- 115 domains (`vocab.ts` + `vocab2.ts`).
- 46 feature combinators: the 15 above plus 31 new ones. These cover cursor pagination, upload queues, offline
  queues, websocket reconnect, undo toasts, drag-reorder, query caches, GraphQL batching, sagas, wizards,
  ETag/If-Match, presence, badges, facets, master–detail, rate limits with Retry-After, CDN and service-worker
  caches, countdowns with clock skew, money fields, permission changes, feature flags, schema drift, clock skew,
  long tasks, cascading selects, export jobs, payments, inventory, prefetch and multi-tab sync.
- Personas: casual, power, mobile (fat fingers, slow radio), keyboard (Enter/Space activation), novice. Tab
  switches fire blur/visibilitychange/focus events.
- Chaos regimes: calm, normal, flaky, degraded, storm, mobile (offline windows, socket drops, high variance), peak
  (capacity and rate limits), deploy (502 burst, schema bugs, replica lag).
- Platform: a global EventTarget (online/offline/focus/visibility/storage), `navigator.onLine`, `localStorage`
  (storage observer on) with other-tab writes, BroadcastChannel, socket drops, long tasks (`loop.advance`) and
  client clock skew.

**Held-out plan (generalisation to unseen app patterns).** Any program using one of `TEST_FEATURES` (swcache,
presence, cascade, saga, prefetch, permissions: 6/31 new features) is test only. So are 19/115 domains, 17% of
families by hash, and the `TEST_PATTERNS` variants. Report train-vs-test per feature (`meta.features`).
`SIM_FEATURE_HOLDOUT=off` turns the feature hold-out off for a final train-on-everything model.

## Splits

Splits are per trajectory, so all of a scenario's rows share one split (`src/world/scenario.ts`).

- **test**: the domain is one of 10/55 held-out domains (weather, legal, pets, auction, farm, permits, music,
  hotel, payroll, survey: 18%); or the family hash falls in the held-out 17% of families; or the program uses a
  held-out combinator pattern (`search/guard:check`, `settings/serialize`, `toggle/pending-guard`,
  `list/guard:abort`, `cart/recompute:items-only-qty`, `editor/echo:version-only`, `poll/fail:throw`). Only 33%
  of test trajectories are kept (`--test-keep`), to bound the test volume.
- **dev**: 3% of the remaining families (by hash). **train**: the rest.

## Tests (`SIM_RUNTIME=real npx vitest run`; 19 tests)

- Loop ordering, microtask draining, `Response` bodies within one macrotask, keyed RNG independence.
- Determinism: same seed → identical rows and final client/server states; forced replays reproduce every
  decision prefix byte for byte.
- Oracle sanity on hand-built programs:
  - stale out-of-order response → `delivery` decision, `stale`, `discard` (situation v2);
  - one stale response among later stale responses still credited;
  - intentional double add → `send`, `expected`;
  - duplicate non-idempotent POST after a timeout whose first attempt committed → `block`/`coalesce` beat `send`,
    `duplicate`;
  - outage failure streak → `delay`/`serve_cached` beat `send`, `failing`;
  - benign concurrency → no question (v2), or passive and `expected` when asked;
  - partial-update invariant break → `rollback`/`resync` beat `ignore`, `inconsistent`;
  - duplicate token refresh → `coalesce` beats `send`;
  - labels are sharp when futures agree, soft when they disagree, and passive-heavy when interventions are
    slightly harmful;
  - exact ties → passive.
- S2 futures (`test/latent.test.ts`): windows and user steps re-drawn only after the decision; hidden repeat intent
  drawn from its posterior for prefix repeats only.
- Row validity over 40 random trajectories: labels reference real options, distributions sum to 1, no sim
  correlation header (`x-request-id`) value in any state, passive is best on a healthy share of rows.

## Known limitations (label-quality risks)

1. **Three futures, not many.** K = 3 paired futures estimate each action's advantage and its standard error.
   Rows whose futures disagree stay soft by design: in a 20k-row validation run, every high-gain (≥ 2) row whose
   futures agree reaches ≥ 0.95 on non-passive actions, against 22% of those whose futures disagree. With 3
   samples the SE is itself noisy. Raw per-future costs are kept in `meta.cost_futures`, so labels can be
   re-derived (e.g. with a larger K for a subset).
2. **The failure-free ideal can be unreachable.** After a real failure, the intended state contains effects that
   cannot happen without a retry, so some branches get partial credit for matching it. Relation terms remove that
   credit from internally inconsistent states. Still, on about 10% of inconsistency rows the flagged invariant is
   coincidental (`expected`) while resync/rollback is cheapest, because it repairs unrelated divergence.
3. **Diagnosis and action are labelled independently.** "expected → coalesce" (an identical GET already in
   flight) is about 11% of request rows. The runtime's gate (non-passive needs a non-`expected` diagnosis) keeps
   those passive. Isolated failures are now `transient` (54% of failure rows); retry is best on about 30% of them.
4. **`defer` is scored as defer-then-apply** (the future policy is passive). A real model re-decides on re-trigger.
5. **Few conflicts.** The runtime's triage does not yet flag a remote write that conflicts with a pending local
   change (sim/NEEDS.md f; CORE is adding it), so `conflict` rows come only from the local echo that lands
   later (under 1% of mutation rows).
6. **Thin classes.** Transitions are about 3% of decision rows (15% of sessions now last 2–5 min). Inconsistency
   triggers are mostly coincidental invariants (about 90% `expected`); genuine relation breaks are about 10% of
   inconsistency rows and about 4% of mutation rows.
7. **Ask answers** are exact with respect to the trace. Evidence checks are heuristic (endpoint path in the
   situation text), and borderline timings are skipped.
8. **Token lengths are estimates** (characters/3.6). The situation budget (1,000 / 2,000 / 3,200 characters) bounds
   the state.
