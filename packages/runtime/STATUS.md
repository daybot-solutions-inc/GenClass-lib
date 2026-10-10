# @genclass/runtime: status (CORE)

Updated: 2026-10-08 (batch 11: aggressiveness; batch 10: gain gate kind; batch 9: EvaluateRequest.notOffered; batch 8: relation learner precision; batch 7: retry by HTTP semantics; batch 6: model gate thresholds, no-baseline stalls; batch 5: REAL's text fixes, SIM's separability facts). Owner: CORE. SIM, DEMOS, UI, REAL and
MODEL read this file. Contract: docs/runtime/CONTRACT.md. API reference: docs/runtime/API.md.

## State

On the VM (`npm install` at the repo root; in packages/runtime with `GENCLASS_MODEL_DIR=~/gcl/model/.cache-model`
and `NODE_OPTIONS=--expose-gc`): `tsc --noEmit` clean, `tsup` build OK, `vitest run`: **42 files, 348 tests, all
passing** (UI's devtools fix from the lead's batch-4 commit included). Every `test/review-*.test.ts` passes
unchanged; MODEL's pass. Perf (REVIEW's tests, shared VM): keystroke write with a 5,000-item array 0.22 ms; async
write 0.14 ms; redux-style dispatch on 5,000 entities 0.71 ms (user) / 0.70 ms (async); settled point 0.3 ms (+2.3 ms
with an unchanged 5,000-item adapter store).

**Never worse (REAL's harness, `realapps/`, built from this tree):** an all-passive model in heal mode against
observe mode on the same scenario (`debug.js --interference`):
- `oss-react-redux-conduit` (the app that never rendered under situation v1): 0/30 runs changed (clean) and 0/30
  (with chaos); `--seed 3 --clean --mode guard|heal` renders the home page exactly as `--mode observe`.
- Batch 5 code, all 66 apps, seeds 1–6, clean: **0/396 runs changed** (same requests, bodies, server state and DOM as
  observe mode). With chaos (seeds 1–3): 3/198 differ (preact-likes ×2, vanilla-spreadsheet), all from request-time
  holds (the `request` trigger, unchanged since batch 3) shifting a request by ~25 ms, which changes the chaos draws
  keyed on arrival order; conduit 0/30; determinism 198/198 identical. Earlier sweeps: batch 4 code 26/384 (23 only in server timestamps, 3 in the DOM from held
  deliveries landing a few ms later); batch 5 before the final salience rules 1/396 (valtio-ledger seed 2). The
  harness also changed in between (realapps commit fcb8189), so the numbers are not strictly comparable.
- New regression test `test/no-reorder.test.ts`: realworld's promise middleware (drops a result when
  `viewChangeCounter` changed between dispatch and resolution) through `genclassEnhancer`, with an always-passive
  model answering after 10 ms: guard and heal, triage salient and always, give the same dispatches in the same order
  and the same final state as observe mode.

| area | files | notes |
|---|---|---|
| public facade | `src/index.ts`, `src/types.ts`, `src/errors.ts` | `GenClass` (init never throws), `createRuntime`, all public types, model host + errors re-exported |
| clock | `src/clock.ts` | `browserClock` |
| trace | `src/trace/{events,ops,context}.ts` | ring buffer, ops registry, ambient-op propagation; lazy timer ops never chain |
| state | `src/state/{hub,fields,invariants}.ts` | incremental flattening, mutation pipeline (no holds by default), drop filter, write logs, late revert, invariant miner |
| observers | `src/observe/*.ts` | fetch, XHR, DOM user actions, errors, nav, storage, perf, WebSocket, EventSource, timers, response cache; message gate (`messages.ts`) |
| learn | `src/learn/{baselines,profiles,cadence}.ts` | baselines with real failure counts, transition profiles (bounded), schedules / debounces |
| situation | `src/situation/*.ts` | facts, version conflicts (`conflicts.ts`), response content vs store (`content.ts`), evidence facts (`evidence.ts`), budget-shaped serializer, compact questions, triage, subject refs |
| decide | `src/decide/*.ts` | queue (deadlines, stale drop, runtime-side timeout, cache, latency samples), §8 gate, reports |
| runtime | `src/runtime.ts` | wiring, delivery gate, actions (snapshot rollback, chain revert, resync, late revert, undo), settled points, plugins |

## SAFETY (2026-10-10): audit trail, interception inventory, invariant suite, money-flow guardrails

Response to the external review of 2026-10-10 (security 6.0, docs 6.0, production readiness 4.0). On the VM
(`vm-jev-train`, Node 22): `tsc` clean, `tsup` OK, unit tests **71 files passed, 1 skipped; 664 passed, 14 skipped**
(the 14 need `GENCLASS_MODEL_DIR`; was 64 files / 562 at 2f89fb5), no unhandled errors; `review-perf` 4/4; `sim`
with `SIM_RUNTIME=real` 20/20. No model-visible text changed (nothing in
`src/situation/*`, wording or `util.ts`); `review-*.test.ts` untouched.

- **Audit trail:** `rt.audit(n?)` and `InitOptions.audit { size, sink }` (`src/decide/audit.ts`): one JSON entry per
  decision, action, undo, breaker trip/reset and control change, with mode, profile, gate values and the model's
  name/version/variant/device/sha256 (`ModelStatus.sha256`, set by `model/backend.ts` from the card). Tests:
  `test/audit.test.ts` (incl. identical evaluation requests with and without a sink).
- **Interception inventory:** `packages/runtime/INTERCEPTION.md` (rendered at genclass.dev/docs/interception);
  `test/interception.test.ts` installs every observer and `autoState` on a synthetic browser global and fails when the
  patched globals, listeners, `destroy()` restoration or the per-file patch-site counts in `src/` differ from the doc.
- **Money flows:** `protectPreset("payments", "auth")`, `PROTECT_PRESETS`, `"preset:<name>"` strings in
  `requests.protect` (`src/presets.ts`); protection now covers the protected request's causal chain (see Deviations);
  `init` suggests the presets when the project uses a payment SDK or has checkout/payment source files.
- **Invariant suite** `test/invariants/*.test.ts` (adversarial providers: probability 1 on the most disruptive offered
  action, or never answering): observe never changes timing or content; deliberate repeats are coalesced only when
  everything allows it; non-idempotent unkeyed requests are never sent twice; out-of-vocabulary actions never run;
  protected endpoints (and their chains) are never acted on; hold budgets cap latency (responses, requests, held
  writes); an offline outbox is never reordered or duplicated; concurrent field writes are never dropped; optimistic
  update / rollback ends in an app-reachable state; `disable({ undo: true })` restores; the breaker demotes after
  undos; discovered React and Zustand state is observe-only. All pass. Residual risks they document: see
  `docs/runtime/THREAT-MODEL.md` T7.
- **Fixes found by the suite** (no model-visible text): (1) a deferred held write (`policy.holdWrites`) waited up to
  10 s per defer, measured 9.7 s with a 150 ms budget: now its re-decisions share one hold budget (`MutationRec.heldSince`,
  `waitRelated`); (2) a delivery's wait for its body (≤ 100 ms) and (3) a request's identity body read were not counted
  against the hold budget; (4) in observe mode (and for protected, cross-origin or no-ready-model requests) a fetch whose
  `Request`/`Blob` body is read for its identity was delayed until the read finished: now sent at once
  (`NetHost.mayHold`, `RuntimeImpl.requestHoldable`); (5) a delivery discard's mark counted GenClass's own writes (a late
  revert) as newer data, so one revert dropped every later write of the chain to that field (`writtenOver`).
- Docs: `SECURITY.md`, `docs/runtime/THREAT-MODEL.md`, API.md (audit, presets, URL-override exception), README
  (observability, presets, links), RELEASE.md (CI publishing with provenance, verifying a tarball),
  `.github/workflows/release.yml` (not run; owner configures npm trusted publishing first).
- Bundle: `/auto` 98.3 KB, main entry 91.1 KB gzip first load (+1.6 KB each); `test/bundle.test.ts` limit for `/auto`
  98 → 99 KB.

## feat/one-line (2026-10-10): automatic state discovery

The one line (`@genclass/runtime/auto*`, the script tag) now finds app state: `InitOptions.autoState` (default on
there, off in `GenClass.init`/`createRuntime`), `src/discover/*` (React DevTools hook + dispatcher tap + commit walk;
Redux DevTools compose/enhancer/connect shims), hub store kind `observed` (`StoreHub.observe`), no write actions on
observed stores (`builtinUnavailable`, `deliveryDroppable`), `runtime.stores()`, `@genclass/runtime/discover`,
telemetry omits situation text once discovered state was recorded. No situation text format change (purity and
exact-text tests unchanged). Tests: 64 files, 562 passed + 14 skipped; review-perf 4/4. Troy and demo numbers:
docs/runtime/RESULTS.md §5 and `bench/heal/README.md`.

## compat (2026-10-10): framework compatibility matrix

`compat/` (docs/agents/compat.md): seven apps installed with the one line from the packed tarball (React 19 + Vite 8
with useState, TanStack Query, Zustand ×2, RTK + RTK Query, Apollo; Next.js 16 App Router with useState and SWR;
Vue 3 + Pinia; SvelteKit 3; Angular 22 HttpClient on fetch and on XHR; Solid; plain HTML script tag with fetch and
WebSocket + EventSource), scenarios a-h, off/observe/guard/heal, 10 seeds, headless Chromium, model 0.2.0.
Result in `compat/RESULTS.md` (run at d04eff3): 350 of 351 cells ✓; 0 bugs introduced in 3,510 mode runs; 0
non-passive actions on correct apps; 10 double submits fixed (heal `block`, Angular on XHR); boot, kill switch,
devtools, CSP (page and every response) and SSR checks pass for every app. The ✗: observe was not identical to no
GenClass on one seed of SWR scenario d, an app race (SWR `rollbackOnError` with overlapping optimistic mutations)
that went wrong without GenClass and right with it, with no action taken (timing). Found and fixed: the "Model ready" console line repeated
after the first decision and every 5 s (`runtime.ts`, the decider `onStatus` listener; `test/status-report.test.ts`,
3 tests). Documented: Zustand `devtools` is off in production builds (no discovery without `enabled: true`);
the `?genclass=` URL mode limits. Tests: 65 files, 565 passed + 14 skipped; review-perf 4/4.

## heal/overnight (2026-10-09): healing benchmark fixes

Local benchmark `bench/heal/` (six demos + the Troy dev copy under injected faults; `NIGHT-REPORT.md`). No
situation text change (the purity and exact-text tests are unchanged).

- `state/hub.ts` -> `StoreHub.applyFilter`: a delivery `discard` applies a library write (Redux dispatch, Zustand
  `set()`) without the stale fields instead of whole (`test/discard-adapters.test.ts`).
- `runtime.ts` -> `runDelivery`, `fanOutSibling`: newer-data conflicts from fan-out siblings (same direct cause, same
  kind, started within `FANOUT_WINDOW_MS` = 100 ms) do not make a delivery salient (`test/fanout-triage.test.ts`).
  Triage only: what reaches the model changes, never the text of a situation.
- `policy.idempotencyBodyFields` (opt-in): `situation/build.ts` -> `repeatUnsafe` also accepts a named top-level
  JSON body field (`observe/fetch.ts` -> `jsonObjectKeys`, `ReqMeta.bodyKeys`); default none
  (`test/idempotency-body.test.ts`).

## 0.1.0-beta.3: default-on anonymous telemetry (privacy-relevant)

`InitOptions.telemetry` (`src/telemetry/*`; disclosure `TELEMETRY.md`; agent doc `docs/agents/telemetry.md`). On by
default with `GenClass.init()` in a browser, off in `createRuntime()` and outside a browser unless set. Opt-outs:
`telemetry: false`, `?genclass=no-telemetry|off`, `localStorage["genclass.telemetry"] = "off"`, Global Privacy
Control. Read-only: rt.on listeners, `RuntimeImpl.tap` (model errors, fail-opens), `decisionInfo(id)`; no change to
situation building or any model-visible text (a test compares the model input with and without telemetry).
`test/telemetry.test.ts`: 13 tests. Full suite after the change: 50 files passed, 1 skipped; 474 passed, 14 skipped;
review-perf 4 passed.

## Batch 11 (done): aggressiveness

`InitOptions.aggressiveness` ("cautious" | "balanced" | "eager" | number 0–1, default "balanced"), URL override
`?genclass-aggr=…` (wins over the option), `runtime.setAggressiveness(x)`, `runtime.aggressiveness`. meta.json
`gate.profiles: { cautious, balanced, eager }` (each a full gate, mass or gain, report included; parsed per profile):
a named level uses its profile; a number interpolates thresholds/margins (per trigger), report and tauGain linearly
between the neighbouring profiles; profiles of different kinds → the nearer one. No profiles: the single gate (or the
defaults) shifted by (0.5 − level) × 2 × 0.05 on thresholds / × 1 on margins, clamped ([0, 1] / ≥ 0). `policy.thresholds`
still win. Exposed in `runtime.gates()` (`aggressiveness`, `level`, `levelSource`: profiles | scaled), `status.aggressiveness`,
`explain(id).gates`, the devtools (a cautious/balanced/eager selector next to the mode switch; the Gates section shows
the level), API.md and the README ("How eager should it be?"). Tests: `test/gates.test.ts` (parsing, interpolation,
fallback shift and clamp, override precedence, option/URL/setAggressiveness/status), `test/gates-devtools.test.ts`
(selector).

## Batch 10 (done): gain gate kind (selected by the model's meta.json)

- TRAIN's T1 models are trained on expected-advantage labels and need a per-action gain gate. meta.json `gate.kind`
  selects it: `"mass"` (default, also when `kind` is absent: today's rule, the permitted actions' summed probability
  vs the candidate tier's threshold) or `"gain"`: for the most probable permitted action a,
  ĝ(a) = tauGain · ln(p(a) / p(passive)), with the trigger's passive action, probabilities clamped to ≥ 1e-6, and, when
  the model gave no probability for the passive action, the mass it left over (1 − Σ others). a runs iff ĝ(a) > the
  margin of a's tier for that trigger kind, the top diagnosis is not `expected` (unless `requireDiagnosis: false`),
  and the usual mode / allow / deny / rate-limit / hold-budget rules pass.
- Meta shape: `gate: { kind: "gain", tauGain, guard: { default, byTrigger }, heal: { default, byTrigger }, report }`;
  guard/heal are margins in cost units (any finite number; defaults 2 / 2 when absent; tauGain default 1, must be
  > 0). `parseGate` validates per kind (mass: probabilities in [0, 1]).
- `policy.thresholds` overrides still win and are read in the active kind (margins under "gain"); `report` is always
  a probability.
- Exposed: `runtime.gates()` → `{ kind, tauGain?, guard, heal, report, source }`; `Decision.gateKind`, `threshold`
  (mass) or `gain` + `margin` (gain), `thresholdSource`; `explain(id).gates`; the devtools Now view's Gates section
  shows the kind and τ ("kind: gain (per-action gain over the passive action, τ 1.5)", "guard margin 3 (model)").
  Gain reasons read "gain 0.27 of discard over apply is not above the guard margin 1".
- Tests (`test/gates.test.ts`, `test/gates-devtools.test.ts`): parsing per kind; mass stays the default without a
  kind; the gain gate acts where the mass gate would not and records gain/margin; below the margin with the reason; an
  app override read as a margin; a missing passive probability (left-over mass; clamped); `expected` diagnosis still
  blocks; the Now view. All suites on the VM: 47 files, 394 tests, passing; tsc and tsup clean.

## Batch 9 (done): `EvaluateRequest.notOffered` (SIM seam)

`EvaluateRequest.notOffered` (action → reason, a copy of `Situation.notOffered`) is passed to every decision provider
so non-model providers (sim, realapps, tests) can record which built-in actions were withheld and why. It is never
part of the state the model reads, and the model host does not forward it to its worker (only state and questions
cross). No text or format change. Test: `test/idempotency.test.ts` (the provider receives the same reasons as
`situation().notOffered`; absent when everything is offered; not in the serialized state).

## Batch 8 (done): relation learner precision (situation-v2.3)

From REAL's wave-5 authors (158 real apps): false `inconsistency` triggers on correct apps. All generic; the text of
existing facts is unchanged, only when inconsistency (and transition) triggers fire.
1. **Sentinel selections.** `a ∈ B[*].k` is vacuous while `a` is 0, a negative number (-1), "", null or undefined
   ("nothing selected"); so are `a == b`, `a >= 0` and `typeof a stable` when a field is an id/selection (`*Id`, `id`,
   `key`, `slug`, `selected*`, `active*`, `current*`); selection fields never get `!= null`; no candidate is proposed
   from a sentinel value.
2. **`unique` needs evidence:** the row's own id column (`id`, `_id`, `uuid`, `key`, `slug`) with ≥ 3 rows, or a
   column whose values are all id-shaped (uuids, long hex, slug ids) with ≥ 5 rows. Ordinary columns (`name`,
   `title`, `text`, `status`, `qty`) and foreign keys (`partId`, `user_id`) never.
3. **Envelope / pagination metadata** never enters a relation: fields named page, pages, offset, limit, cursor, pager,
   pagination, skip, take, next, prev/previous, has more, per page, page size; and total/count fields (`total`,
   `articlesCount`) next to such a field (a response envelope's total is not this page's size). Name compatibility,
   generically: `a == b` needs a shared meaningful word (`cart.count == badge.itemCount`; batch 5 allowed unrelated
   names after 3 distinct values, no longer); `a == len(B)` and sums need an aggregate-like name for `a` (count, total,
   sum, size, amount, balance, qty, nX, ...) or a word shared with the list or column (`ill.active == len(ill.hits)`
   is a coincidence); sums never run over id or version columns (`sum(options[*].pollId * votes)`,
   `sum(loans[*].version)`); count-by-group only for a counter named after the group (`counts.done`, `doneCount`; not
   `counts.waitingParts` for status "waiting"); membership `a ∈ B[*].k` only for a selection field (named selected /
   active / current / focused / editing / ..., or under such a parent) into the list's own id column (`id`, `_id`,
   `uuid`, `key`, `slug`): a filter equal to an item's kind, a title found in a list of titles, a draft's id, a foreign
   key or an id from another entity are coincidences.
4. **Typing bursts.** At a settled point, stores written by a `type` user action within the last 1 s are neither
   checked nor learned on (candidates touching them are skipped, their pending changes kept, a lingering episode is not
   restarted); another settled point is scheduled 1 s after the last keystroke, so a real divergence is still reported
   once typing stops. Clicks are unaffected.
5. **Busy counters.** A number field that changed in ≥ 80 % of its store's writes (over ≥ 10 writes since it first
   changed) is busy (`hub.busy`). Unless it is explicitly derived (the left side of a learned len / sum / sum of
   products / count-by-group relation; `miner.derived`), it is kept out of equality and membership relations (existing
   candidates are dropped) and out of transition write-set shapes (`miner.busyCounter`).
- **Measured on REAL's apps** (`realapps`, 148 of the 158 apps built in my slot (10 Vite/OSS builds were not), seeds
  1–3, clean scenarios: no chaos, correct apps, so every inconsistency is a false alarm unless an app variant has a
  deliberate bug), batch-7 runtime vs this one: **inconsistency decisions 745 → 45 (−94 %)**, runs with any 229 → 21
  of 444, apps with any 105 → 15; transition decisions 58 → 54; all decisions 2,927 → 2,086. Rules 1–5 alone gave
  745 → 305; the rest came from name compatibility for aggregates, selection-only membership, no sums over id/version
  columns, group-named counters and no unique foreign keys. Remaining top relations: `gym.count == len(gym.classes)`,
  `cart.total == sum(price * qty)` (4; possibly variant bugs), `log.rows[*].call unique` (id-shaped values),
  per-person / per-station counters named after their group (`lunch.perPerson.Lena == count(person == "Lena")`).
- Tests: `test/relations.test.ts` (one synthetic store per case, each with a control showing the old false positive
  where applicable, plus checks that real defects still fire: a dangling selection, a divergence after typing stops).
  Updated: `test/invariants.test.ts` (badge → badgeCount for name compatibility; ≥ 3 rows for id uniqueness),
  `test/situation.test.ts` transition example (the total is now a learned sum of the items, so it stays in the shape),
  `test/review-redaction.test.ts` (REVIEW's: advances 1.2 s after the keystroke instead of 0.2 s, since relations on a
  store being typed into are checked after the burst).

## Batch 7 (done): retry by HTTP semantics (situation-v2.2)

- SIM's on-policy round: the most harmful exploratory action was `retry` of a POST after a 500 the situation itself
  said "may have applied" (a duplicate order). `retry` is now offered only when repeating is safe by HTTP semantics:
  idempotent methods (GET, HEAD, OPTIONS, PUT, DELETE; TRACE too) always; any other method (POST, PATCH, ...) only
  when the request carries an idempotency key header, from `policy.idempotencyHeaders` (default `Idempotency-Key`,
  `X-Idempotency-Key`; case-insensitive; request ids and tracing headers such as `X-Request-Id` are not keys).
  Headers are read from `init.headers` and Request objects (fetch) and `setRequestHeader` (XHR). `hedge` was already
  GET-only and also goes through the same check. No other action repeats a request (`block`, `delay`, `coalesce`,
  `serve_cached` never re-send).
- Every built-in action that is not offered is listed with its reason in `Situation.notOffered` (debugging; never
  sent to the model), e.g. `{ retry: "POST is not idempotent and the request has no idempotency key header
  (idempotency-key, x-idempotency-key)" }`, `{ hedge: "only GET requests are hedged (POST)" }`, `{ serve_cached: "no
  cached response exists for this request" }`. `SituationDraft.request.idempotencyKey` is set for plugins.
- No new facts; situation text is unchanged. What changes is the action list: a failed POST/PATCH without a key now
  offers only `deliver` (`serve_cached` is GET-only), so it is not held in heal mode (nothing could be done) and is
  decided in the background.
- Tests: `test/idempotency.test.ts` (POST without a key: no retry, one request, the reason; X-Request-Id is not a
  key; Idempotency-Key on a headers object or a Request and x-idempotency-key on PATCH: retried; PUT/DELETE/GET
  retried without a key; `policy.idempotencyHeaders` replaces the list; hedge reason for a POST stall). All suites on
  the VM: 46 files, 381 tests, passing; tsc and tsup clean.

## Batch 6 (done): data-derived gate thresholds; no-baseline stalls

- **Gate thresholds from the model.** The model host passes meta.json `gate` (`{ report?, guard: { default,
  byTrigger? }, heal: { default, byTrigger? } }`) through in its ready status (`status.gate`; one line in
  `src/model/backend.ts`, MODEL's file). The runtime validates it (`parseGate`: numbers in [0, 1], known trigger kinds,
  a bare number = the tier default) and gates with: the app's `policy.thresholds` value when set, else the model's
  value for the trigger kind, else its tier default, else report 0.6 / guard 0.9 / heal 0.8 (`effectiveGates`, per
  tier). The detection/report threshold follows the same rule.
- **Exposed:** `runtime.gates(trigger?)` → `{ trigger?, report, guard, heal, source: { report, guard, heal } }` with
  sources `policy` / `model` / `default`; `Decision.threshold` (what the permitted mass was compared with: the
  candidate's tier for that trigger) and `Decision.thresholdSource`; `explain(id).gates` (the full set at decision
  time); the devtools Now view has a "Gates" section (defaults and every trigger kind the model gives its own value;
  a few lines in `src/devtools/index.ts`, UI's file). Gate reasons print the threshold rounded to 2 decimals.
- **No-baseline stall fallback (REAL wave 4: a hung non-GET request with no baseline produced no decision).** A
  request whose signature has no latency baseline yet (fewer than 5 completions) raises `stall` once it has been in
  flight 10 s. Its situation adds one neutral fact: "POST /api/upload has no latency baseline yet (0 completed
  requests); requests without one are checked after 10.0s in flight." Situation text of every existing trigger is
  unchanged; what changes is that such requests now produce stall situations (new rows for SIM/REAL), and in heal
  mode a hung idempotent GET without a baseline can now be hedged or served from cache. Every request without a
  baseline schedules one more 10 s timer (cleared when it ends).
- Tests: `test/gates.test.ts` (parseGate validation; precedence policy > model per trigger > model default >
  defaults; the runtime records `threshold`/`thresholdSource` and acts at the model's 0.6 where the old 0.9 would not;
  overrides win; the model host's ready status carries `gate` into `runtime.gates()`; the no-baseline stall at 10 s
  with its fact), `test/gates-devtools.test.ts` (Now view), `test/model/loader.test.ts` (one test, MODEL's file: the
  backend's ready status carries meta.json `gate`; absent without it). All suites on the VM: 45 files, 375 tests; one
  run failed `review-perf`'s 1 ms redux-dispatch bound at load average ~50 (1.44 ms); A/B against the committed code
  in the same minute gave equal times (0.64–0.70 ms both), and the rerun passes (0.64 ms).

## Fix after 0.1.0-alpha.1: two redaction leaks (privacy)

Model-visible text changes only for values the redactor hides; everything else renders byte-for-byte as before.
- F2 ("would replace text the user typed"): `src/situation/content.ts` -> `contentFacts` diffed the raw strings, so
  the diff-centred preview printed characters of a redacted field. It now uses the shared helper
  `src/state/fields.ts` -> `redactedStringDiff` (also used by `changeText`): a diff only when both values pass the
  redactor unchanged (`Object.is(redact(path, v), v)`), otherwise both sides render through `describe()`
  (`[redacted] → [redacted]`, or a custom redactor's replacement).
- Default redactor (`src/util.ts` -> `isSensitivePath` / `defaultRedact`): under a strong (non-broad) secret-named
  container, numbers, bigints and arrays are now redacted as well as strings (`payment.cvv.value = 123`,
  `login.otp.code = 123456`, `lock.pin.value = 1234`, `account.password.history = [...]`). Booleans, null and
  undefined stay visible, plain objects are still judged key by key, and broad containers (`auth`, `session`,
  `cookie`) still redact only opaque credential-looking strings. Side effect: numbers under a container whose name
  is a secret word in another sense are hidden too (`map.pin.lat`, `boarding.pass.seat`), as their strings already
  were.
- Tests: `test/redaction-v2.test.ts` (F2 on a secret field with the default and a custom redactor, an unredacted
  field keeps its diff, the container cases above).
- Training data: SIM rows are rendered by the runtime itself and follow automatically. The curriculum's Python
  port (`training/curriculum/rt.py` -> `content_facts`, `string_diff`, `change_text`) has the F2 diff but no
  redactor anywhere (every fact prints the scenario's value summaries), so it was not changed: gating only F2 would
  not make it match the runtime. Secret names there (`training/curriculum/vocab.py` -> `DOMAINS`): the banking
  domain's `iban` text field, and the nouns `pin` (maps) and `pass` (bike sharing), which become store names
  through `training/curriculum/app.py` -> `App.item` (`pin.total`, `pass.content`, ...); the runtime renders
  values under those as `[redacted]` (strings before this fix, now numbers and arrays too), the curriculum prints
  them. Porting `isSensitivePath` or renaming those words is a curriculum follow-up.
- Known gaps, not changed here (they would change other model-visible text): a container named by a secret
  word pair (`cardNumber`, `apiKey`, `creditCard`) counts as broad, so `payment.cardNumber.value = "4111 1111 ..."`
  (or a number) is still shown; and the "changed since X started ... is back to V" fact (`src/situation/facts.ts`)
  compares rendered text, so two different redacted values read as "back to [redacted]".

## Fix after batch 5: situation() purity (REAL report, oss-svelte-conduit)

- New regression test `test/situation-purity.test.ts`: a mixed app raises every trigger kind (triage "always":
  delivery with a buffered JSON body, WebSocket message, mutation, request, failure, stall, inconsistency,
  transition, error); at every probe point (inside a user handler, a timer callback with its lazy op ambient, a
  fetch continuation, a message dispatch, a task) it calls `situation()`, `situation(kind)` for every kind and
  rebuilds each kind's last situation from scratch, and asserts that the next op id, op count, event seq, decisions,
  interventions, hub sequence, scheduled timers and provider calls are unchanged; the whole run (op ids, events,
  decisions, provider requests, store values) is identical with and without probes. It fails if situation building
  materialises a lazy timer op (checked by injecting `ctx.op()`). A second test polls the UI's store session like
  the devtools overlay (situation, inflight, explain, interventions, history on every microtask turn): identical
  decisions, holds, interventions, ops and events.
- The runtime was already side-effect free on every path; one strictness fix: pruning of the recent-errors list no
  longer happens inside situation building (it happens when errors are recorded). Facts still cache field versions
  in `op.reads` (allowed by the contract; no ids, no events).
- The oss-svelte-conduit id shift is harness nondeterminism, not the probe: with no ask probes, 2 of 3 identical base
  runs of seed 24 differ from the first (an extra `GET /api/articles?tag=react&limit=10&offset=10` at t0 = 7,483 ms in
  one run and 5,557 ms in another, absent in the first), which shifts every later op id by one; `--det 24-24` reports
  a mismatch on some runs; and `--ask-check` over seeds 1–29 differs only on seed 24, at t = 13,183 ms, before its
  only probe (32,259 ms).

## Batch 5 (done): situation text from REAL's apps, SIM's separability facts

**REAL's text fixes**
- Shadow DOM (Lit, native custom elements): the user observer describes the first node of `event.composedPath()`
  (the real target in open shadow roots), `closest()` for the interactive element crosses shadow boundaries, labels /
  `aria-labelledby` / `label[for]` resolve in the element's own tree, rendered text follows slots and open shadow
  roots, and a control without a name inside a custom element is named by its host (`<x-field label="Email">`).
  `change` and `submit` (not composed) are observed by listeners added to each open shadow root the first time a
  composed event (focusin, pointerdown, click, input, keydown) comes from inside it. Was "user clicked inbox-app",
  now `li "Sofia · Size exchange"`, `button "Send reply"`, `change select "Status"`.
- A control nested in its `<label>`: the label's own text, without the text of descendant form controls (options,
  values, button captions): `select "Stops"` (was `select "Stops AnyNonstop1 stop2 stops"`).
- Redaction by the leaf field, never by the store name: `auth.loading`, `auth.status`, `auth.user.name` are visible,
  `auth.token`, `auth.refreshToken`, `users.3.password`, `payment.card.number` (a secret pair across the last two
  segments) are redacted. A store holding a primitive is judged by its name (its name is the leaf). Plain objects are
  judged key by key. Under a container whose name means a secret (`credentials.password.value`) strings are
  redacted; under a broad one (`auth`, `session`, `cookie`) only opaque credential-like strings (≥ 20 chars of
  letters and digits without spaces: JWTs, API keys). Booleans and null are never redacted. Free text (element
  descriptions) is redacted when any word names a secret.

**Delivery salience (SIM's v2 driver run: 45 of 65 stale deliveries had discard ≈ deliver).** A delivery asks the
model only when the response would replace data that is newer and already applied:
- a newer-data conflict counts only when no newer request of the same signature is still in flight (that request will
  write the fields again); while one is, the conflict is not reported (the in-flight request stays a neutral fact:
  "1 other GET /api/search operation is in flight (1 newer than …)"). Applies to `mutation` triggers too;
- the body is read and compared: a response equal to the current value of every conflicting field is not salient
  (F3); a field not found in the body counts as changed;
- a pending local change (an optimistic write whose request is in flight) is salient only when the body puts back the
  value the user's change replaced ("This message has board.cards.c1 = "todo", the value before user clicked button
  "Move c1 to done" (#3) changed it to "done" 0.05s ago (its PATCH /api/cards/c1 {col: "done"} (#4) is still in
  flight); delivering it would undo the user's change."); a third value is left to the pending request;
- text the user typed after the request started is salient only when the body would replace it (F2).

  Measured in tests: clean typeahead (in-order, DEMOS loading flags, debounce) and a debounced search whose timer
  writes its own `fetching` flag with older responses landing while newer requests are in flight: 0 delivery calls,
  0 ms held. Push messages about other items than a pending change are delivered at once.

**SIM's facts** (sim/SEPARABILITY.md §6; all generic, deterministic, bounded; most informative first: non-neutral,
then by kind)
- **Response bodies at delivery.** When a delivery is salient (a conflict, or a typed-into text field in P, or
  `triage: "always"`), the gate reads the body before deciding: fetch from the buffered clone the runtime already
  keeps (≤ 256 KB, JSON content type or JSON text), XHR from `responseText`/`response`, WebSocket/EventSource from
  the message data. The app's body is never read. The wait is bounded (100 ms of clock time, then the decision is
  made without it). Non-salient deliveries read nothing (no latency).
- Values are located in the body generically: by item id (`board.cards.c1.status` → the object with id `c1`), by
  the longest key-path suffix outside arrays (`search.results` → `results`), or the one array of compatible items
  (same id key or ≥ 50 % shared keys; the most shared ids when several fit). Ambiguous → not located (no fact).
  Statements are about the response's content, so an app that transforms data can only make them uninformative.
- **F1** "would put back a value a newer operation replaced": per field ("The response has card.status = "open",
  the value that PATCH /api/card {} (#6) replaced with "closed" 0.74s ago (it started after #4); delivering it
  would put the older value back.") and per item cell, joined on the id key ("The response would put back done =
  false for item 2 of list.items: the store has true, changed since #4 started; …"), plus "the newer writes to X
  changed only item 3; this response's copy of it equals the store" and a third value ("… neither the current value
  …, nor the value when #4 started"). Also for `mutation` (the write's own value: "This write …").
- **F2** "would replace text the user typed after the request started", with a diff-centred preview: `"…e sword
  shield market lib" → "…e sword shield" (removes " market lib")`. A delivery whose predicted string field was
  typed into after the request started is salient when the body would change that text (even without a newer
  operation). All long string changes (timeline, deltas, state) now use the diff-centred preview.
- **F3** "The response matches the current values of everything it is predicted to write (…): delivering it
  changes nothing." When the body equals the current value of every conflicting field the delivery is not salient
  (no model call; an event `delivery.unchanged`).
- **F9** provenance of known-stale values: a write is marked when its chain's response was delivered over newer data
  (or over a pending local change) without a decision to drop it, when its response took ≥ 5× the usual time (and
  ≥ 300 ms more), or when it followed an ambiguous failure (F5); fields last written by WebSocket/EventSource
  messages are marked when that channel comes back after being down. The mark is stated whenever a later decision
  involves the field ("list.items holds a value written 0.42s ago by the response to GET /api/items?q=a (#4), which
  was delivered over newer data from GET /api/items?q=ab (#6); nothing has rewritten it since.") in delivery,
  mutation, inconsistency, transition and error situations. The next write clears it.
- **F6** learned cadence per signature: on a schedule ("GET /api/feed runs on a schedule: every 1.00s (last 5
  intervals); the next run is due in 0.95s.", from requests not caused by user actions, ≥ 4 runs, ≥ 75 % of
  intervals within ±25 %, stops after 3 missed periods) or debounced ("PUT /api/note is usually sent 0.30s after the
  user's last input (4 of the last 4): a later edit is followed by a new request.", from requests a timer started
  after a user action). In delivery, mutation (the chain's request), failure and stall situations.
- **F5** failure scope: "2 other endpoints of this origin failed in the last 10s (2 failures, latest: GET /api/a
  500, GET /api/b 503)" or "The other endpoints of this origin answered normally …", and "The browser reports that it
  is offline (navigator.onLine is false)." Commit ambiguity of failed non-GET requests: "This POST failed with HTTP
  500 after 0.60s (usual 0.50s): the server may have applied it before failing." (5xx other than 502/503, or a
  network error / timeout no earlier than half the usual time) vs "… HTTP 503, a status servers and gateways usually
  return without processing the request." In failure and stall situations.
- **F7** repeat evidence, a separate fact next to the repetition fact (request and mutation): "User actions #1 and
  #3, 0.08s apart: both are clicks on button "Like"; the browser counted #3 as click 2 of a multi-click
  (MouseEvent.detail); the request of #1 (#2) was still in flight at #3; between them the app wrote
  video.pending." `UserAction.clicks` (MouseEvent.detail) is recorded by the DOM observer.
- **F8** relation quality: `a == b` between fields whose names share no word needs 3 distinct values while holding
  (small-number coincidences rarely get there) and is never learned between version counters / offsets / pages;
  numeric `a ∈ B[*].k` needs an id column (`selectedId ∈ items[*].id`) or related names, never versions. New
  template count-by-group: `board.counts.done == count(board.items[*].lane == "done")` (badges, per-lane counters),
  proposed when a number equals the size of one group of a string/boolean column with ≤ 8 values; learned like the
  others (3 distinct counts when the names do not relate).
- **Read-your-writes**: create responses (POST, or 201) are parsed in the background from the clone (ids of the
  object, a single wrapped object `{article: {slug}}`, or items). "lists.hits was loaded by GET /api/lists (#5),
  which started 0.05s after POST /api/lists {name: "Weekend"} (#3) created item "weekend" 0.10s ago (201), and does
  not contain it." / "… contains item "weekend" twice; …". For lists in delivery bodies, mutation values,
  inconsistency and transition fields.

**Contract deltas (batch 5)**
- §5 delivery salience: newer data must be applied and final (no newer same-signature request in flight) and changed
  by the response (body compared when readable); a pending local change only when the response reverts it; typed text
  only when the response replaces it. Bodies are read only for these candidates (a clone, ≤ 256 KB JSON, ≤ 100 ms).
- §5 facts: F1, F2, F3, F5, F6, F7, F9 and read-your-writes as above; long string changes use diff-centred previews.
- §4 invariants: unrelated `a == b` needs 3 distinct values; no equality/membership on version counters; numeric
  membership only in id columns; new count-by-group template.
- §2 redaction: by the leaf field (container rules above), never by the store's name; DOM: shadow DOM targets and
  label text without nested controls; `UserAction.clicks`.
- Types: `UserAction.clicks?`; `SitEnv.creates/cadence/outcomes/online` (internal); `NetHost.noteResponse`,
  `MsgHost.channel` (observer hooks).

**Tests.** `test/content.test.ts` (14): F3 (no call when unchanged, one when different), F1 field and item cells,
F2 salience and the diff preview, F9 (delivered over newer data, 5× slow, ambiguous failure, channel down), F6
(schedule, debounce), F5 (scope, offline, commit), F7, F8, read-your-writes. `test/dom.test.ts`: nested labels,
shadow DOM descriptions and observation (click, input, non-composed change). `test/batch3.test.ts`: redaction of an
`auth` store. `test/delivery.test.ts`: the salience rules above (debounced search with its own loading flag, a
message that puts back the value a pending change replaced vs a third value). All suites: **41 files, 346 tests, all
passing** (VM). Perf: dispatch on 5,000 entities 0.67 / 0.66
ms; settled point 0.3 ms (+2.3 ms with an unchanged 5,000-item adapter store: count-by-group candidates).

## Batch 4 (done): situation v2

**1. Decide at the network boundary, enforce synchronously at the store.** New trigger `delivery`: a fetch or XHR
response is about to reach the app (before the app's promise resolves / before `load` fires), or a WebSocket or
EventSource message is about to be dispatched (before any app listener runs).
- Predicted write set P of the delivering op: the store fields its signature's causal chain wrote in past
  completions (transition profile), else what the last completed op of that signature wrote, else unknown (never
  salient on version grounds). Paths are normalised (`board.cards.:id`) and matched against current fields.
- Salient iff a field in P has a **newer-data conflict** (its value now differs from when the op started and an op
  that started later, outside this op's chain and not a user action itself, wrote it since) or a **pending local
  change** (a user action's chain wrote it in the last 10 s and an op of that chain with a different signature is
  still in flight: an unconfirmed optimistic update). Inputs that moved, a newer same-signature request in flight, and
  user keystrokes that started newer requests of the same signature are never conflicts: in-order typeahead and
  autosave make zero model calls (tested with the DEMOS search app: input + loading written per keystroke, 150 ms
  debounce).
- Actions (passive first): `deliver` (passive); `discard` (guard): deliver, but drop the writes this op's chain makes
  over newer data, synchronously inside each write (other fields of the same write apply: loading flags, totals);
  `defer` (guard, offered when related ops are in flight, at most 2): hold until the related in-flight ops finish,
  then decide again. A dropped write is an event ("dropped the write of search.results by GET … over newer data (its
  other changes applied)") and the `ActionRecord.dropped` list (paths, updated as later writes of the chain are
  dropped; the mark lasts 10 s). Undo restores the dropped values.
- XHR: the app's completion listeners (`readystatechange`, `progress`, `load`, `loadend`, added with
  `addEventListener` before or after `open()`, or set as `on*` handlers) run through a thin wrapper; the first
  completion event of a successful response asks the gate synchronously, and while it holds the app's completion
  listeners are queued in order and run (op ambient) once delivered. `abort()` during the hold drops the response
  and fires `abort` + `loadend`. `on*` getters return the wrapper. Failures (status 0, 5xx/429/408) are not gated.
- Holding is only latency: the response object/event is unchanged; WebSocket/EventSource keep per-channel order
  (later messages and close/error events queue behind a held one; each held message gets its own decision when it
  reaches the head). Message ops are created synchronously inside the dispatch (`hooks.opCreated` fires before app
  listeners) and are ambient while the app's handlers run.
- Writes covered by a delivery decision (P known and covering the written fields, and the delivery was not salient or
  was decided in time) raise no `mutation` decision, except with `triage: "always"`.

**2. No store-write holds by default** (`policy.holdWrites: false`). A salient write not covered by a delivery
decision raises `mutation`, triaged when proposed and decided in the background after the write applies (never
blocks the app; `set(x); get()` returns x). A gate-passing `discard` becomes a late revert under the strict rules
(≤ 2 s, fields unchanged since, no later write in the same chain). Background decisions have a 5 s deadline.
`holdWrites: true` (opt-in) restores held writes with: (a) a later write to a store first applies that store's
earlier held writes, in order (a hold never reorders a store's writes); (b) inside the writing op's chain `get()`
returns the pending value (read-your-writes), elsewhere the applied one. Note: held writes are invisible to reads that
bypass the runtime (a redux middleware's `store.getState()`); keep `holdWrites` off for such stores, or pass
`hold: false` per store.

**3. Hold only when it can help.** A trigger holds only if the expected model latency fits the hold budget: expected
= usual provider latency × (1 + decisions queued ahead) + the decision being computed (at least as long as it has run
so far); infinite while the provider is not answering (its last evaluation timed out and none answered since). Queued
decisions whose subject was superseded (response already released, write overwritten, request aborted) are dropped
before they reach the model.

**4. `observe.untrustedEvents`** (default false): synthetic DOM events (`isTrusted === false`) are recorded as user
actions only when this is on (test harnesses; REAL already passes it). Events dispatched while an app operation's code
runs are never user actions.

**5. Request-time decisions** unchanged.

**Add-ons.** WebGPU (and unknown-device) situation budget 2,400 chars (TRAIN measured 2.4 chars/token: ≈ 1,000
tokens); 4-thread WASM 2,000, 1-thread 1,000 (linear between). Section limits are now full at 2,400 (12 facts, 6
in-flight, 16 timeline, 8 state, 4 stats) and compact at 1,100. The predicted write set is stated in the trigger
sentence; a separate fact is added only for a transition profile (its counts). Room is left in the fact set for
SIM's separability proposals (≤ 12 facts at full budget; delivery situations use 4–6 today).

**Tests.** `test/delivery.test.ts` (14): typeahead zero calls; stale out-of-order response → delivery `discard` drops
only `search.items` (the field with newer data) while the same write's other change (`search.loaded.a`) applies; holding is only latency; no hold when the model cannot
answer in time; read-after-write; late revert path; slow model (released at budget, writes decided in background);
superseded queued decision dropped; WebSocket order under a held message + discard; push messages touching nothing
pending deliver at once with no model call; EventSource custom event types; XHR: a stale response held before any completion listener (pre-`open()`
listener, `onload`, `loadend`; order kept), discard drops only the stale field; XHR hold = latency, op ambient,
`removeEventListener` of a wrapped listener, `abort()` during the hold; forced actions with probability 1.
`test/atoms.test.ts` runs with `holdWrites: true` and adds: user write never overtakes an earlier held write (DEMOS
regression), read-your-writes. `test/no-reorder.test.ts` (6, above). `test/dom.test.ts`: untrustedEvents.
Existing tests that assumed store holds now pass `policy: { holdWrites: true }` or were rewritten for `delivery`
(smoke, situation, budget, report, plugins, batch3). Touched outside my files (minimal, for the record):
`test/adapters-{react,redux,zustand}.test.ts` (`holdWrites: true` on real-runtime setups; react: answer the
delivery decision before the mutation one), `test/devtools-runtime.test.ts` (titles/regexes for the delivery
intervention), `test/browser/ui/session.ts` (its rule-based judge answers `delivery` like a stale `mutation`).

**Contract deltas (batch 4)**
- §5 triggers: new `delivery` (above). `mutation` is non-blocking by default; held only with `policy.holdWrites`.
- §5 salience: a version conflict is "newer data" (net change + a writer that started after X, outside X's chain,
  that is not itself a user action) or a "pending local change" (user-rooted write whose request of another
  signature is in flight). A plain user action that changed the field is NOT salient by itself (the batch-4 brief
  said "by a newer op or a user action"; counting every user write made DEMOS-style typeahead ask the model on
  every response, because keystrokes write `loading`).
- §6 budgets: full = 2,400 chars (was 3,200).
- §8: holds require expected latency ≤ hold budget; superseded queued decisions are dropped; late revert is the only
  enforcement path for writes when `holdWrites` is off.
- §2 observers: `eventsource` observer; `observe.untrustedEvents`.
- Types: `TriggerKind` + `delivery`; `SubjectRef {kind:"delivery", op, paths?, store?}` (paths = conflicting fields, else the matched predicted ones); `ActionRecord.dropped?: string[]`;
  `SituationDraft.delivery?: {channel, predicted, conflicts}`; `PolicyOptions.holdWrites?`; `ObserverName` +
  `eventsource`.

## Batch 3 (done)

**REVIEW findings (all 34; tests in `test/review-*.test.ts` pass unchanged)**
- Timers: a timer op links to the nearest op that exists (never to another lazy op) and drops its closure once
  created: recursive `setTimeout` loops no longer build chains (no stack overflow, no retention; the gc test runs).
- Patches: removals first, and a path is never removed when a change targets something beneath it (filling an empty
  object survives being held, queued, deferred, late-reverted and undone).
- Coalesce never hangs: opaque/status-0 responses are shared as clones; bodies are buffered only for 200–599
  readable responses, at most 1 s of streaming and 256 KB; a coalesced request waits at most 8 s; when the response
  cannot be shared the request is really sent (the ActionRecord says so).
- XHR: synchronous XHRs are never held; `abort()` while held means never sent (the app gets abort/loadend);
  faked values are removed on the next `open()` and respect `responseType`; listeners are added once per object.
- A throwing app setter/reducer/subscriber never strands a store's queue or settled points: reported as an error
  (`reportError`, source "the setter of X") and the queue continues; a synchronous `set()` still throws to its caller.
- In-place updaters: a write that may be held never changes live state before the decision: if the updater
  mutated the stored value, the result is detached into a copy and the live value restored exactly; when that is
  impossible the write applies at once with a fact ("could not be held: the update changed the stored value in
  place"). Change summaries use the recorded pre-change values ("2 → 3 items").
- keepalive requests are never held (sent inside the `fetch()` call).
- Init never throws: every observer installer is wrapped (read-only globals are skipped), `GenClass.init` falls back
  to an inert runtime with one console line.
- Request identity = method + URL + semantic headers (all except tracing ids: traceparent, tracestate, baggage,
  sentry-trace, x-request-id, x-correlation-id, request-id, b3/x-b3-*, x-datadog-*, x-amzn-trace-id,
  x-cloud-trace-context, newrelic, date, x-request-start, x-genclass) + body content: strings (≤ 1 MB),
  URLSearchParams, FormData without files, ArrayBuffer/views and Blobs ≤ 64 KB, Request bodies ≤ 64 KB (read from
  a clone before the gate, ≤ 100 ms). Anything else gets a unique identity (never "identical"). Range splits identity.
- Error-trigger rollback is offered only when the failing op's own chain wrote state, and restores only what that
  chain wrote (fields nobody overwrote since, to their values before the chain's first write). Transition rollback
  works the same way. Inconsistency rollback still restores the last consistent snapshot of the involved stores.
- Plugin `ctx.builtin()` goes through the same policy (mode tier, deny/allow, rate limit).
- Late revert (contract §8 "late-revert rules"), all must hold: the decision is a gate-passing `discard` (guard
  tier); the write applied ≤ 2 s ago; none of its fields changed since; no other write since in the same causal
  chain (including writes made synchronously by subscribers of that store, which now run with the write's cause as
  the ambient op). Otherwise the decision records the reason ("superseded: …", "the same operation chain wrote … ").
  The runtime stops waiting for an answer 2 s after the hold budget, so later answers are never recorded.
- Facts: "started 0.10s after/before this one" uses the real direction; failure facts report real counts
  ("error rate 60% over 5 requests (3 failed)", over the last 20 outcomes; the EWMA stays internal); write counts
  and versions come from a 512-entry log per field ("written 20 times … (version 0 → 20)").
- Arrays: every element counts (element hashes are incremental by reference, with a sampled re-hash of elements
  that kept their reference); plain objects with more than 32 keys are one field (a keyed collection).
- Redaction: invariant facts use the configured redactor; unlabeled password inputs are never named by their value.
- Precision: a short last page is not "unusual" (array kinds are empty / non-empty, no grew/shrank); entity keys
  with digits (`m21`, `u3x`) are `:id` in transition profiles; profiles are capped (64 write sets, 128 fields);
  `a != null` needs 6 supporting snapshots and is never proposed for a field ever seen null (initial value
  included); a consistent snapshot is taken at every settled point where nothing newly broke (a lingering, already
  reported violation no longer blocks snapshots); events dispatched by app code while an op runs (or untrusted
  events while a non-user op is ambient) are not user actions.
- Memory: coalescing buffers expire after 2 s and are capped (64 entries, 4 MB) next to the GET cache (64 × 256 KB);
  the abort listener is removed when the request settles; XHR listeners once per object.
- Never hold when the mode and policy permit no non-passive action for the trigger (e.g. failures in guard mode):
  the subject proceeds at once and the decision is still made in the background for detection.
- Big stores: incremental flattening (unchanged arrays/collections cost reference comparisons only), per-array
  statistics cached for the invariant miner, snapshots reuse unchanged stores and top-level keys, size caps before
  `JSON.parse` of bodies and WebSocket messages (16 KB).
- Runtime-side provider timeout: a provider that never answers is abandoned at the request deadline (10 s without
  one) so later decisions are not blocked.
- Console reports: the first of a series is printed, identical repeats in the next minute are counted and printed
  as one line when the minute ends ("(×N more in the last minute)"); the rate-limit warning once per minute.
- `destroy()`: wrappers that another library may still call become pass-throughs; `ask()` after destroy rejects with
  reason "destroyed".

**SIM requests (sim/NEEDS.md a–f)**
- a. Redaction by field semantics, not substrings: default redactor and typed values use word-level names
  (password, passcode, pin, token, secret, cvv/cvc/csc, ssn, iban, otp, cookie, authorization/auth, and pairs such
  as card number, credit card, api key, private key, session id, security code). "card", "cards", "author",
  "tokens", "pinned" are not secrets. DOM fields are also sensitive by type=password and autocomplete cc-* /
  one-time-code / current-password / new-password. (Deviation from §2's regex, approved in this batch.)
- b. State lines list only current leaves (no `parent = undefined`).
- c. "x changed 2 times since … and is back to 6" instead of "6 → 6".
- d. Item changes show the changed keys: `3 items, 1 changed: {id: 3, qty: 1 → 2}`; collections:
  `added m21: {…}`, `changed u3x: {age: 20 → 21}`.
- e. Short slug ids normalised in signatures, conservatively: ≥ 4 chars with letters and digits where a part starts
  with a digit (`tasks-1cam`), letters and digits alternate twice (`x7k2p`, `ab12cd`), or from 6 chars mixed case
  with digits (`PPBqWA9`). Not ids: `sha256`, `oauth2`, `ipv4`, `item42`, `v1beta1`, `x86_64`.
- f. New non-neutral fact for a write over a pending local change: "board.card7 has a pending local change: user
  clicked button "Move to done" (#1) wrote it 0.10s ago and its PATCH /api/cards/:id {…} (#2) is still in flight;
  this write comes from task ws message (#3), which started after that user action."

**Contract changes**
- §8 gate: A = applicable non-passive actions the mode permits, minus denied (only allowed when `allow` is set);
  candidate = argmax of probabilities over A; it runs iff Σ_{a∈A} p(a) ≥ the candidate's tier threshold, the top
  diagnosis is not `expected` (unless `requireDiagnosis: false`), under the rate limit, within the hold budget (else
  late-revert rules). `Decision.action` = the action that ran, else the model's own top choice; new fields
  `Decision.candidate` and `Decision.mass`. `reason` is given only when the model's own choice did not run.
  Reports: "Not acted on (would have done discard 0.70): …".
- New diagnosis label `transient` ("a one-off failure that is likely to succeed if tried again"), after `unusual`.
- Compact questions: when the situation budget is ≤ 1,400 chars, diagnosis options are bare labels and action
  options bare names (null descriptions), same instructions; a vocabulary override description is kept only if ≤ 24
  chars. `Situation.compact` and `Situation.budget` are recorded.
- Auto situation budget: webgpu 3,200; wasm 1,000 at 1 thread to 2,000 at 4 threads (1,333 at 2, 1,667 at 3);
  unknown device 3,200. (Batch 4: webgpu and unknown device 2,400.)

## How to drive it headless (SIM, tests)

```ts
import { createRuntime } from "@genclass/runtime";
const rt = createRuntime({
  clock,                       // { now, setTimeout, clearTimeout, afterTask }
  global,                      // object whose fetch (and optionally XMLHttpRequest/WebSocket/EventSource/document/...) is instrumented
  decider,                     // DecisionProvider; consulted only while status.state === "ready"
  observe: { fetch: true, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false },
  mode: "heal", triage: "salient", report: "silent",
  policy: { thresholds: { report: 0, guard: 0.5, heal: 0.5 }, holdBudgetMs: 1e9, maxActionsPerMinute: 1e9, requireDiagnosis: false },
  situation: { budget: 1000 },                        // sample budgets (1000 / 1333 / 2000 / 2400); ≤ 1400 = compact questions
  hooks: { opCreated(op) {}, mutationProposed(m) {} },
  vocabulary: { diagnoses: {...}, actions: {...} },   // optional wording overrides
});
```

- `global.fetch` (and WebSocket, EventSource, …) are replaced at construction; `rt.destroy()` restores them.
- `observe` defaults: every observer on, except `timers`, on only when `global.document` exists. Synthetic DOM events
  are user actions only with `observe.untrustedEvents: true`.
- Holds are fully deterministic under the injected clock: a held response/message/request is released only by the
  decision (clock-timed provider), the hold budget timer, or `defer`'s wait (which re-enters the decider). Only the
  injected clock is used; same inputs → byte-identical situations at any budget (tested).
- Forcing (the sim's semantics, kept): thresholds 0.5, `requireDiagnosis: false`, an answer with probability 1 on an
  action runs exactly that action when the mode permits it (tested for `delivery` too).
- Observable effect of a delivery `discard`: `ActionRecord.dropped` (paths), plus an `action`/`dropped` event per
  dropped write (`data.paths`, `data.mutation`, `data.op`).
- `createRuntime` has no model unless you pass `decider` or `model: {...}`. Outside a browser `GenClass.init()` returns
  an inert runtime.
- User actions: `rt.user({ kind, target?, value?, key?, sensitive? }, handler?)`. Values are redacted when
  `sensitive` or when the target names a secret (`input "Password"`, `input "Card number"`); a kanban `card "…"`
  keeps its value. Typing on the same target within 1 s is one timeline event per burst.
- `app`: `CreateOptions.app()` if given, else `global.document.title` and `global.location.pathname`.
- Request identities for `Request` bodies are computed after a microtask read of a clone (≤ 100 ms of clock time);
  the op exists synchronously (opCreated) with `identity` filled in just before the request gate.
- WebSocket/EventSource message ops are created synchronously inside the message dispatch, before any app listener
  (opCreated fires there), and are ambient while the app's handlers run.

### Actions per trigger (exported as `TRIGGER_ACTIONS`, `PASSIVE`, `BUILTIN_ACTIONS`)

| trigger | passive | other actions (tier) | blocking? |
|---|---|---|---|
| delivery | deliver | discard (guard), defer (guard; only with related ops in flight, ≤ 2) | yes, when salient and an action is permitted and the model can answer within the hold budget |
| mutation | apply | discard (guard), defer (guard; < 2 defers) | no by default (background; discard = late revert ≤ 2 s); yes with `policy.holdWrites` |
| request | send | coalesce (guard, fetch), delay (guard), block (heal), serve_cached (heal, GET with a cached answer) | yes, when permitted |
| failure | deliver | retry (heal, replayable fetch, < 4 attempts, and an idempotent method or an idempotency key header), serve_cached (heal) | fetch: when permitted; XHR: no |
| stall | wait | hedge (heal, idempotent GET), serve_cached (heal) | no |
| inconsistency | ignore | rollback (heal), resync (heal) | no |
| transition | ignore | rollback (heal), resync (heal) | no |
| error | ignore | rollback (heal, only if its chain wrote state) | no |

With `holdWrites` off, a non-blocking `mutation` decision's `defer` is recorded only (nothing to hold).

## SIM requests (sim/NEEDS.md): done

1–5 (batch 1), 6 (batch 2), a–f (batch 3): DONE. Batch 4 / situation-v2: DONE: `SubjectRef {kind:"delivery", op,
paths?, store?}`; `hooks.opCreated` synchronous inside WebSocket and EventSource dispatch; deterministic holds;
action names/tiers/passive per trigger (table above; exported); forcing semantics kept; `ActionRecord.dropped` and
the `dropped` event; `hooks.mutationProposed` still synchronous; `situation()` side-effect free; `vocabulary`,
`situation.budget`, `requireDiagnosis` unchanged.

Batch 5 / separability proposals (sim/NEEDS.md, SEPARABILITY.md §6): DONE: F1, F2, F3 (non-salient), F9, F6, F5,
F7, F8, read-your-writes (see Batch 5). Wording changed in batch 5: new facts listed above, diff-centred previews of
long strings in deltas and the timeline, F7 is a separate fact after the repetition fact, element descriptions inside
shadow roots and nested labels, redaction by leaf field. Regenerate rows.

Wording changed in batch 4: new `delivery` trigger sentences ("The response to GET … (#6) arrived and is about to be
delivered; its operation last wrote search.results."), version facts take the op as reference ("since its operation
(#6) started", "this message (#5) started after that user action"), the pending-change fact ends with "<ref> started
after/before that user action", full budget 2,400. Regenerate rows.

## For UI (adapters, devtools)

- Batch 4's devtools items were done by the lead (NOUN `delivery`, "Reverted" for late reverts, mock budget).
- Adapters: with `holdWrites` off (default) `propose()` commits synchronously in the caller's stack (redux dispatch,
  zustand set); the model decides in the background. The hold paths of the adapters are exercised with
  `policy: { holdWrites: true }`.
- DOM observer: synthetic events need `observe.untrustedEvents: true`; `UserAction.clicks` (MouseEvent.detail).

## Triggers and triage

| trigger | raised when |
|---|---|
| delivery | a fetch/XHR response (2xx–4xx not handled as a failure) or a WebSocket/EventSource message is about to reach the app; asked only when salient (see below) |
| mutation | a non-user, non-GenClass write to a store, not covered by a delivery decision |
| request | every instrumented fetch/XHR not issued by GenClass (keepalive and sync XHR never held) |
| failure | network error, timeout (`TimeoutError` abort), 5xx/429/408 |
| stall | in flight > max(4×median, 2×p95, 500 ms), ≥ 5 latency samples |
| inconsistency | a learned invariant breaks at a settled point (once per episode) |
| transition | a completed op's write set / value kind / status class / write count seen in < 1% of ≥ 20 completions |
| error | uncaught error / unhandled rejection / `reportError` |

Triage (`"salient"`): facts first (cheap); the model is consulted only for a non-neutral fact or an `always`
standing question. Delivery: newer data that is applied (no newer same-signature request in flight) and that the
response would change; a pending local change the response would revert; text the user typed that the response would
replace (see Batch 5). Non-neutral facts: a newer-data conflict or a pending local change on a predicted/written field
(delivery, mutation); a write/response that puts back a value a newer write or a pending user change replaced (F1)
or replaces text the user typed (F2); a list reloaded after a create that lacks the item or holds it twice; an
identical additive change in 10 s; an identical request in flight or sent within min(2 s, half its usual gap); failure
streak ≥ 2 (request); rate ≥ 3× usual with ≥ 5 in 10 s; cause latency > 3× median; every failure, stall,
inconsistency, transition and error. Neutral (never asks by itself): inputs that moved, user writes alone, a newer
request of the same signature in flight (it also makes newer-data conflicts neutral), stale marks (F9), cadence (F6),
failure scope and commit ambiguity (F5), repeat evidence (F7).

## Example situations: compact budgets (from test/budget.test.ts)

The stale typeahead response (delivery) at 1,000 chars (1-thread WASM: compact questions) and 2,000 chars (4-thread
WASM: full questions). Questions are shown on one line each.

### delivery at 1000 chars (951)

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

### delivery at 2000 chars (1760)

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
timeline:
  -0.97s start GET /api/search?q=re (#4, by #3)
  -0.93s end GET /api/search?q=r (#2): 200 in 0.12s
  -0.93s write search.results: 0 items → 2 items ["r-1", "r-2"] (by #2)
  -0.90s write search.query: "re" → "rea" (by #5, user)
  -0.90s start GET /api/search?q=rea (#6, by #5)
  -0.85s end GET /api/search?q=re (#4): 200 in 0.12s
  -0.85s write search.results: 2 items ["r-1", "r-2"] → 2 items ["re-1", "re-2"] (by #4)
  -0.81s write search.query: "rea" → "reac" (by #7, user)
  -0.81s start GET /api/search?q=reac (#8, by #7)
  -0.69s end GET /api/search?q=reac (#8): 200 in 0.12s
  -0.69s write search.results: 2 items ["re-1", "re-2"] → 2 items ["reac-1", "reac-2"] (by #8)
  -0.00s end GET /api/search?q=rea (#6): 200 in 0.90s
state:
  search.results = 2 items ["reac-1", "reac-2"] (v3, by #8 0.69s ago)
  search.query = "reac" (v4, by #7 0.81s ago)
stats:
  GET /api/search: 4 done, 0 of last 4 failed, 4 in last 10s
questions:
  diagnosis: What is happening here? expected: normal behaviour, nothing is wrong | stale: outdated data or an older operation is about to replace newer state | conflict: concurrent operations are competing over the same state or resource | duplicate: the same change or request is happening again without a new intent | inconsistent: the state contradicts itself or relationships it normally keeps | failing: an operation keeps failing or its failures follow a pattern | slow: an operation is far slower than usual | overload: work is being triggered far more often than usual | unusual: this differs from how the same operation normally behaves | transient: a one-off failure that is likely to succeed if tried again
  action: What should the runtime do with this response or message? deliver: pass it to the application now | discard: deliver it but drop the state changes it would make over newer data
```

## Example situations: full budget (2,400), one per trigger and per new fact (test/situation.test.ts, test/delivery.test.ts, test/content.test.ts)

### delivery: a stale out-of-order response (F1: a third value)

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
timeline:
  -1.05s user typed "reac" into input "Search" (4 keystrokes, #1–#7)
  -1.05s write search.query: "" → "r" (by #1, user)
  -1.05s start GET /api/search?q=r (#2, by #1)
  -0.97s write search.query: "r" → "re" (by #3, user)
  -0.97s start GET /api/search?q=re (#4, by #3)
  -0.93s end GET /api/search?q=r (#2): 200 in 0.12s
  -0.93s write search.results: 0 items → 2 items ["r-1", "r-2"] (by #2)
  -0.90s write search.query: "re" → "rea" (by #5, user)
  -0.90s start GET /api/search?q=rea (#6, by #5)
  -0.85s end GET /api/search?q=re (#4): 200 in 0.12s
  -0.85s write search.results: 2 items ["r-1", "r-2"] → 2 items ["re-1", "re-2"] (by #4)
  -0.81s write search.query: "rea" → "reac" (by #7, user)
  -0.81s start GET /api/search?q=reac (#8, by #7)
  -0.69s end GET /api/search?q=reac (#8): 200 in 0.12s
  -0.69s write search.results: 2 items ["re-1", "re-2"] → 2 items ["reac-1", "reac-2"] (by #8)
  -0.00s end GET /api/search?q=rea (#6): 200 in 0.90s
state:
  search.results = 2 items ["reac-1", "reac-2"] (v3, by #8 0.69s ago)
  search.query = "reac" (v4, by #7 0.81s ago)
stats:
  GET /api/search: 4 done, 0 of last 4 failed, 4 in last 10s
questions:
  diagnosis (choice): What is happening here?
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
  action (choice): What should the runtime do with this response or message?
    deliver: pass it to the application now
    discard: deliver it but drop the state changes it would make over newer data
```

### delivery: F1, a stale list would undo a newer item change

```
app: /search
trigger: The response to GET /api/items?q=old (#4) arrived and is about to be delivered; its operation usually writes list.items.
facts:
  list.items was written once by other operations since its operation (#4) started (version 1 → 2), last 0.79s ago by task push (#5), which started 0.01s after #4.
  The response would put back done = false for item 2 of list.items: the store has true, changed since #4 started; delivering it would undo that change.
  In 1 earlier completions of GET /api/items its chain wrote list.items (1 of 1 wrote state).
  The response to GET /api/items?q=old (#4) arrived after 0.80s (200); the app has not seen it yet.
  This request comes from user typed "old" into input "Filter" (#3), started 0.80s ago.
  Joined by id with list.items, the response would change 1 cell in 1 item.
in_flight: none
timeline:
  -1.00s user typed "old" into input "Filter" (2 keystrokes, #1–#3)
  -1.00s start GET /api/items?q=first (#2, by #1)
  -0.95s end GET /api/items?q=first (#2): 200 in 0.05s
  -0.95s write list.items: 0 items → 3 items [{id: 1, done: false}, …] (by #2)
  -0.80s start GET /api/items?q=old (#4, by #3)
  -0.79s start task push (#5)
  -0.79s write list.items: 3 items, 1 changed: {id: 2, done: false → true} (by #5)
  -0.79s end task push (#5): ok in 0.00s
  -0.00s end GET /api/items?q=old (#4): 200 in 0.80s
state:
  list.items = 3 items [{id: 1, done: false}, {id: 2, done: true}, {id: 3, done: false}] (v2, by #5 0.79s ago)
stats:
  GET /api/items: 2 done, 0 of last 2 failed, 2 in last 10s
```

### delivery: F2, an autosave response over text the user typed

```
app: /search
trigger: The response to PUT /api/doc {text: "Guild page sword shield"} (#4) arrived and is about to be delivered; its operation usually writes doc.text.
facts:
  The response would replace text the user typed into doc.text after #4 started (2 user writes, the last 0.22s ago): "…e sword shield market lib" → "…e sword shield" (removes " market lib").
  In 1 earlier completions of PUT /api/doc its chain wrote doc.text (1 of 1 wrote state).
  doc.text was written twice by other operations since its operation (#4) started (version 1 → 3), last 0.22s ago by user typed "Guild page sword shield market lib" into textarea "Page" (#6), which started 0.18s after #4, from a later user action (#6).
  The response to PUT /api/doc {text: "Guild page sword shield"} (#4) arrived after 0.40s (200); the app has not seen it yet.
  This request comes from task autosave (#3), started 0.40s ago.
in_flight:
  task autosave (#3) 0.40s so far
timeline:
  -1.00s start task autosave (#1)
  -1.00s start PUT /api/doc {text: "Guild page sword shield "} (#2, by #1)
  -0.60s end PUT /api/doc {text: "Guild page sword shield "} (#2): 200 in 0.40s
  -0.60s write doc.text: "Guild page sword shield " → "Guild page sword shield" (by #2)
  -0.60s end task autosave (#1): ok in 0.40s
  -0.40s start task autosave (#3)
  -0.40s start PUT /api/doc {text: "Guild page sword shield"} (#4, by #3)
  -0.30s user typed "Guild page sword shield market lib" into textarea "Page" (2 keystrokes, #5–#6)
  -0.30s write doc.text: "Guild page sword shield" → "Guild page sword shield m" (by #5, user)
  -0.22s write doc.text: "…sword shield m" → "…sword shield market lib" (inserts "arket lib") (by #6, user)
  -0.00s end PUT /api/doc {text: "Guild page sword shield"} (#4): 200 in 0.40s
state:
  doc.text = "Guild page sword shield market lib" (v3, by #6 0.22s ago)
stats:
  PUT /api/doc: 2 done, 0 of last 2 failed, 2 in last 10s
```

### delivery: a WebSocket message that would revert a pending local change

```
app: /search
trigger: A WebSocket message /live (#5) arrived and is about to be delivered; messages like it last wrote board.cards.:id.
facts:
  board.cards.c1 has a pending local change: user clicked button "Move c1 to done" (#3) wrote it 0.05s ago and its PATCH /api/cards/c1 {col: "done"} (#4) is still in flight; this message (#5) started after that user action.
  This message has board.cards.c1 = "todo", the value before user clicked button "Move c1 to done" (#3) changed it to "done" 0.05s ago (its PATCH /api/cards/c1 {col: "done"} (#4) is still in flight); delivering it would undo the user's change.
  A WebSocket message (#5) {n: 2, card: "c1", col: "todo"} arrived on /live; the app has not seen it yet.
in_flight:
  WS /live (#1) 0.10s so far
  PATCH /api/cards/c1 {col: "done"} (#4) 0.05s so far, by #3
timeline:
  -0.10s start WS /live (#1)
  -0.10s event ws.message {n: 1, card: "c2", col: "doing"} (#2)
  -0.10s write board.cards.c2: "todo" → "doing" (by #2)
  -0.05s user clicked button "Move c1 to done" (#3)
  -0.05s write board.cards.c1: "todo" → "done" (by #3, user)
  -0.05s start PATCH /api/cards/c1 {col: "done"} (#4, by #3)
  -0.00s event ws.message {n: 2, card: "c1", col: "todo"} (#5)
  -0.00s event ws.message {n: 3, card: "c2", col: "review"} (#6)
state:
  board.cards.c1 = "done" (v1, by #3 0.05s ago)
  board.cards.c2 = "doing" (v1, by #2 0.10s ago)
stats: none
```

### mutation: an older task's write over a newer task's

```
app: /search
trigger: A write to profile.name from task load profile (#1) is about to be applied.
facts:
  profile.name was written once by other operations since this write's cause (#1) started (version 0 → 1), last 0.30s ago by task save profile (#2), which started 0.10s after #1.
  This write has profile.name = "Ada (cached)": neither the current value "Grace", nor the value when #1 started.
  profile.saved changed since this write's cause (#1) started: 0 → 1, last by task save profile (#2) 0.10s after #1 started.
  This write comes from task load profile (#1), started 0.40s ago.
  This write would change profile.name: "Grace" → "Ada (cached)".
in_flight: none
timeline:
  -0.40s start task load profile (#1)
  -0.30s start task save profile (#2)
  -0.30s write profile.name: "Ada" → "Grace"; profile.saved: 0 → 1 (by #2)
  -0.30s end task save profile (#2): ok in 0.00s
state:
  profile.name = "Grace" (v1, by #2 0.30s ago)
  profile.saved = 1 (v1, by #2 0.30s ago)
stats: none
questions:
  diagnosis (choice): What is happening here?
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
  action (choice): What should the runtime do with this write?
    apply: let this write update the state now
    discard: drop this write and keep the current state
    defer: hold this write until the related in-flight operations finish, then decide again
```

### request

```
app: /search
trigger: POST /api/orders {items: [1], cardNumber: [redacted]} (#4) is about to be sent.
facts:
  1 identical POST /api/orders request in the last 10s: #2 in flight (started 0.12s ago); #2 started 0.12s before this one; they come from separate user actions 0.12s apart.
  User actions #1 and #3, 0.12s apart: both are clicks on button "Place order"; the request of #1 (#2) was still in flight at #3; the app changed no state between them.
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
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
  action (choice): What should the runtime do with this request?
    send: send the request now
    coalesce: do not send; reuse the result of the identical request that is in flight or just finished
    delay: wait before sending, backing off so the service can recover
    block: do not send; fail this request immediately
```

### failure: F5 scope, commit ambiguity, F6 cadence

```
app: /search
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
in_flight: none
timeline:
  -3.70s start POST /api/orders {n: 0} (#1)
  -3.20s end POST /api/orders {n: 0} (#1): 201 in 0.50s
  -3.10s start POST /api/orders {n: 1} (#2)
  -2.60s end POST /api/orders {n: 1} (#2): 201 in 0.50s
  -2.50s start POST /api/orders {n: 2} (#3)
  -2.00s end POST /api/orders {n: 2} (#3): 201 in 0.50s
  -1.90s start POST /api/orders {n: 3} (#4)
  -1.40s end POST /api/orders {n: 3} (#4): 201 in 0.50s
  -1.30s start POST /api/orders {n: 4} (#5)
  -0.80s end POST /api/orders {n: 4} (#5): 201 in 0.50s
  -0.70s start GET /api/a (#6)
  -0.70s start GET /api/b (#7)
  -0.68s end GET /api/a (#6): 500 in 0.02s
  -0.68s end GET /api/b (#7): 503 in 0.02s
  -0.60s start POST /api/orders {} (#8)
  -0.00s end POST /api/orders {} (#8): 500 in 0.60s
state: none
stats:
  POST /api/orders: 6 done, median 0.50s, p95 0.50s, 1 of last 6 failed, 6 in last 10s
```

### failure: a polled endpoint failing (F6 schedule)

```
app: /search
trigger: GET /api/status (#12) failed (HTTP 503) and the app has not seen the failure yet.
facts:
  The request #12 failed: HTTP 503 after 0.06s; the app has not seen the failure yet.
  4 identical GET /api/status requests in the last 10s (latest 3: #6 answered 200 6.00s ago; #8 ended 503 4.00s ago; #10 ended 503 2.00s ago); #10 started 2.00s before this one, neither from a user action.
  This is the 3rd GET /api/status failure in a row (recent outcomes: 200, 200, 503, 503, 503; last success 6.00s ago); error rate 50% over 6 requests (3 failed).
  GET /api/status runs on a schedule: every 2.00s (last 5 intervals); the next run is due in 1.94s.
  GET /api/status was requested 5 times in the last 10s (no usual rate learned yet).
  This request comes from task poll (#11), started 0.06s ago.
  GET is idempotent.
  A cached 200 response from 6.00s ago exists for this request.
in_flight:
  task poll (#11) 0.06s so far
timeline:
  -6.06s start task poll (#5)
  -6.06s start GET /api/status (#6, by #5)
  -6.00s end GET /api/status (#6): 200 in 0.06s
  -6.00s write status.checked: 1 → 2 (by #6)
  -6.00s end task poll (#5): ok in 0.06s
  -4.06s start task poll (#7)
  -4.06s start GET /api/status (#8, by #7)
  -4.00s end GET /api/status (#8): 503 in 0.06s
  -4.00s end task poll (#7): ok in 0.06s
  -2.06s start task poll (#9)
  -2.06s start GET /api/status (#10, by #9)
  -2.00s end GET /api/status (#10): 503 in 0.06s
  -2.00s end task poll (#9): ok in 0.06s
  -0.06s start task poll (#11)
  -0.06s start GET /api/status (#12, by #11)
  -0.00s end GET /api/status (#12): 503 in 0.06s
state:
  status.checked = 2 (v2, by #6 6.00s ago)
  status.up = true (v1, by #2 10.0s ago)
stats:
  GET /api/status: 6 done, 3 of last 6 failed, 5 in last 10s
questions:
  diagnosis (choice): What is happening here?
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
  action (choice): What should the runtime do with this failed request?
    deliver: pass the failure to the application as it is
    retry: retry the request after a short backoff
    serve_cached: answer with the last successful response for this request instead
```

### stall

```
app: /search
trigger: GET /api/report/:id (#16) has been waiting 0.96s for a response.
facts:
  The request #16 has been in flight for 0.96s; GET /api/report/:id usually takes 0.24s (p95 0.27s, 7 samples), 4.0× the median.
  1 identical GET /api/report/:id request in the last 10s: #14 answered 200 5.69s ago; #14 started 5.00s before this one, neither from a user action.
  Recent GET /api/report/:id outcomes: 200, 200, 200, 200, 200.
  GET /api/report/:id runs on a schedule: every 5.00s (last 7 intervals); the next run is due in 4.04s.
  This request comes from task refresh (#15), started 0.96s ago.
  GET is idempotent.
  A cached 200 response from 5.69s ago exists for this request.
in_flight:
  task refresh (#15) 0.96s so far
timeline:
  -36.0s start GET /api/report/:id (#2, by #1)
  -35.8s end GET /api/report/:id (#2): 200 in 0.21s
  -31.0s start GET /api/report/:id (#4, by #3)
  -30.7s end GET /api/report/:id (#4): 200 in 0.22s
  -26.0s start GET /api/report/:id (#6, by #5)
  -25.7s end GET /api/report/:id (#6): 200 in 0.23s
  -21.0s start GET /api/report/:id (#8, by #7)
  -20.7s end GET /api/report/:id (#8): 200 in 0.24s
  -16.0s start GET /api/report/:id (#10, by #9)
  -15.7s end GET /api/report/:id (#10): 200 in 0.25s
  -11.0s start GET /api/report/:id (#12, by #11)
  -10.7s end GET /api/report/:id (#12): 200 in 0.26s
  -5.96s start GET /api/report/:id (#14, by #13)
  -5.69s end GET /api/report/:id (#14): 200 in 0.27s
  -0.96s start task refresh (#15)
  -0.96s start GET /api/report/:id (#16, by #15)
state: none
stats:
  GET /api/report/:id: 7 done, median 0.24s, p95 0.27s, 0 of last 7 failed, 2 in last 10s (usual 2.31)
questions:
  diagnosis (choice): What is happening here?
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
  action (choice): What should the runtime do with this slow request?
    wait: keep waiting for the request
    hedge: send a second identical request and use whichever answers first
    serve_cached: answer with the last successful response for this request instead
```

### inconsistency

```
app: /search
trigger: The relation cart.total == sum(cart.items[*].price * cart.items[*].qty) no longer holds now that the app is settled.
facts:
  The learned relation cart.total == sum(cart.items[*].price * cart.items[*].qty) no longer holds: cart.total = 22, sum(cart.items[*].price * cart.items[*].qty) = 29. It held at 3 settled points before.
  The last consistent state is 0.45s old; 1 field write happened since.
  cart.items was written 0.06s ago by PATCH /api/cart/:id {qty: 2} (#5): 3 items, 1 changed: {id: 3, qty: 1 → 2}.
  No operations are in flight (the app is settled).
in_flight: none
timeline:
  -1.11s user clicked button "Add to cart" (#1)
  -1.11s write cart.items: 0 items → 1 item [{id: 1, price: 10, qty: 1}]; cart.total: 0 → 10 (by #1, user)
  -0.81s user clicked button "Add to cart" (#2)
  -0.81s write cart.items: 1 → 2 items: added {id: 2, price: 5, qty: 1}; cart.total: 10 → 15 (by #2, user)
  -0.51s user clicked button "Add to cart" (#3)
  -0.51s write cart.items: 2 → 3 items: added {id: 3, price: 7, qty: 1}; cart.total: 15 → 22 (by #3, user)
  -0.21s user clicked button "+" (#4)
  -0.21s start PATCH /api/cart/:id {qty: 2} (#5, by #4)
  -0.06s end PATCH /api/cart/:id {qty: 2} (#5): 200 in 0.15s
  -0.06s write cart.items: 3 items, 1 changed: {id: 3, qty: 1 → 2} (by #5)
state:
  cart.total = 22 (v3, by #3 0.51s ago)
  cart.items = 3 items [{id: 1, price: 10, qty: 1}, {id: 2, price: 5, qty: 1}, …] (v4, by #5 0.06s ago)
stats: none
questions:
  diagnosis (choice): What is happening here?
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
  action (choice): What should the runtime do about this inconsistent state?
    ignore: leave the state as it is
    rollback: restore the affected state to its last consistent snapshot
```

### transition

```
app: /search
trigger: POST /api/cart {} (#46) completed with a state change unlike its usual ones.
facts:
  In the previous 22 completions of POST /api/cart its chain wrote cart.items and cart.total (22 of 22 times); this time it wrote only cart.items.
  The last consistent state from before #45 started is 0.40s old; 1 field write happened since.
  It ended 0.06s ago with 200 after 0.08s (usual 0.08s).
  The completed operation #46 comes from user clicked button "Add" (#45), started 0.14s ago.
  cart.items is now 23 items [1, 2, 3, …].
in_flight: none
timeline:
  -1.34s user clicked button "Add" (#39)
  -1.34s start POST /api/cart {} (#40, by #39)
  -1.26s end POST /api/cart {} (#40): 200 in 0.08s
  -1.26s write cart.items: 19 items [1, 2, 3, …] → 20 items [1, 2, 3, …]; cart.total: 57 → 60 (by #40)
  -0.94s user clicked button "Add" (#41)
  -0.94s start POST /api/cart {} (#42, by #41)
  -0.86s end POST /api/cart {} (#42): 200 in 0.08s
  -0.86s write cart.items: 20 items [1, 2, 3, …] → 21 items [1, 2, 3, …]; cart.total: 60 → 63 (by #42)
  -0.54s user clicked button "Add" (#43)
  -0.54s start POST /api/cart {} (#44, by #43)
  -0.46s end POST /api/cart {} (#44): 200 in 0.08s
  -0.46s write cart.items: 21 items [1, 2, 3, …] → 22 items [1, 2, 3, …]; cart.total: 63 → 66 (by #44)
  -0.14s user clicked button "Add" (#45)
  -0.14s start POST /api/cart {} (#46, by #45)
  -0.06s end POST /api/cart {} (#46): 200 in 0.08s
  -0.06s write cart.items: 22 items [1, 2, 3, …] → 23 items [1, 2, 3, …] (by #46)
state:
  cart.items = 23 items [1, 2, 3, …] (v23, by #46 0.06s ago)
  cart.total = 66 (v22, by #44 0.46s ago)
stats:
  POST /api/cart: 23 done, median 0.08s, p95 0.08s, 0 of last 20 failed, 23 in last 10s
questions:
  diagnosis (choice): What is happening here?
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
  action (choice): What should the runtime do about this unusual state change?
    ignore: leave the state as it is
    rollback: restore the affected state to its last consistent snapshot
```

### error

```
app: /search
trigger: An uncaught TypeError was thrown: Cannot read properties of null (reading 'toUpperCase')
facts:
  Uncaught TypeError: Cannot read properties of null (reading 'toUpperCase').
  No consistent snapshot from before #1 started exists.
  Its chain wrote profile.name, profile.loaded before the error.
  It was thrown while GET /api/profile (#2) was active, 0.10s after it started; that chain began with user clicked link "Profile" (#1).
in_flight: none
timeline:
  -0.10s user clicked link "Profile" (#1)
  -0.10s start GET /api/profile (#2, by #1)
  -0.00s end GET /api/profile (#2): 200 in 0.10s
  -0.00s write profile.name: "Ada" → null; profile.loaded: false → true (by #2)
  -0.00s error TypeError: Cannot read properties of null (reading 'toUpperCase') (during #2)
state:
  profile.name = null (v1, by #2 0.00s ago)
  profile.loaded = true (v1, by #2 0.00s ago)
stats:
  GET /api/profile: 1 done, 0 of last 1 failed, 1 in last 10s
questions:
  diagnosis (choice): What is happening here?
    expected: normal behaviour, nothing is wrong
    stale: outdated data or an older operation is about to replace newer state
    conflict: concurrent operations are competing over the same state or resource
    duplicate: the same change or request is happening again without a new intent
    inconsistent: the state contradicts itself or relationships it normally keeps
    failing: an operation keeps failing or its failures follow a pattern
    slow: an operation is far slower than usual
    overload: work is being triggered far more often than usual
    unusual: this differs from how the same operation normally behaves
    transient: a one-off failure that is likely to succeed if tried again
  action (choice): What should the runtime do about this error?
    ignore: leave the state as it is
    rollback: restore the affected state to its last consistent snapshot
```

## Batch 12: configuration options (docs/runtime/OPTIONS-SPEC.md)

Implemented: `enabled` + `rt.disable({undo})`, `sample`, `routes`, `requests` {ignore, protect, crossOrigin, labels,
labelsToModel, correlate}, `breaker` + `rt.breaker.reset()`, `shadow`, `onBeforeAction`/`vetoMode`,
`policy.actionLimits` (`maxActionsPerMinute` alias), `holdBudgetMs` as a hard ceiling (defers and the veto hook count;
the defer wait is capped at the remaining budget), `redact(path, value, kind)` (built-in redaction runs first),
`sinks` + `rt.summary()`, `session`/`rt.setSession()`, `report: "interventions"`, `learn` {persist local|session, key,
version} + `rt.learn.clear()`, `model.loadIf/threads/timeoutMs/maxDecisionsPerMinute/unloadAfterIdleMs`, events
`shadow/breaker/limit/modelBudget`, hidden-tab skipping, the §0 gate order and the §8 defaults. New files:
`src/util/match.ts`, `src/decide/breaker.ts`, `src/decide/summary.ts`, `test/options.test.ts` (27 tests). Suite: 413
passed, 14 skipped; tsc clean.

Behaviour changes (all toward safety): breaker on by default; `perSubject: 10` per subject per rolling 60 s (beta.1: was 5, too low for a typeahead) / `perSession: 200` absolute cap; reasons
`rate limit` → `limit:perMinute`; URL overrides (`?genclass`, `?genclass-mode`, `?genclass-aggr`) only demote unless
`debug: true`; cross-origin requests are always passive; ops created under an off/observe route scope are never
action targets.

Deviations / not done:
- **Query-value redaction in situation text (spec §8 item 6) is NOT implemented**: it changes model input and needs a
  format-tag decision from the coordinator. Only sink evidence redacts URLs.
- The scope block only adds `notOffered` entries; the action questions sent to the model are unchanged.
- `enabled` source turning off mid-session is a soft disable (observers stay installed as pass-through);
  `rt.disable()` is permanent (destroy).
- `model.inlineFallback: false` is passed through to the host as `inlineFallback`, but `src/model/host.ts` (not CORE)
  does not read it yet: the MODEL owner needs to honour it (state `skipped`, reason `worker-unavailable`).
- `unloadAfterIdleMs` is a provider wrapper in `index.ts`: the evaluation that triggers the reload is rejected (fails
  open, held items released unchanged); hidden time counts as idle because the timer is wall time.
- Labels/tags/correlation ids never reach the model; with `labelsToModel: true` an op label shows as
  `label (METHOD /path) (#id)`.

## Deviations from the contract (and why)

- `retry` backoff is `min(200 ms · 2^(attempt-1), 5 s)`: the first retry waits 200 ms.
- `coalesce` is not offered for XHR; XHR failures/stalls are detection-only (the app receives XHR events directly).
- Transition profiles compare array kinds as empty / non-empty only (§4 also lists the length delta sign; dropped for
  precision: a short last page or a removal is ordinary).
- Error/transition `rollback` restores only the fields the op's own chain wrote (the contract's "last consistent
  snapshot" would also revert other chains' writes, e.g. user input); inconsistency rollback uses the snapshot.
- Default redaction is by word-level secret names (approved SIM request a), not the §2 regex, and (batch 5) by the
  leaf field only, with the container rules above; booleans and null are never redacted. After 0.1.0-alpha.1, a
  strong secret-named container hides numbers, bigints and arrays too, and F2 never diffs a redacted value.
- `situation(trigger)` returns the last situation built for that trigger (an "ask about now" one otherwise).
- Batch 4 salience: a user action that changed a field is not, by itself, a version conflict (see Batch 4, contract
  deltas). XHR `on*` getters return GenClass's wrapper of the app's handler (needed so XHR implementations that call
  `this.onload(e)` themselves are gated too).
- With `holdWrites` off (default) `mutation` `defer` cannot do anything (the write already applied): it is recorded only.
- `requests.protect` (OPTIONS-SPEC §4.4 says "writes to the store caused by delivering its response are gated
  normally"): since SAFETY 2026-10-10 an op created while a protected op is ambient inherits `scope.protected`
  (`RuntimeImpl.startOp`), so writes, timers and follow-up requests caused by a protected response are never acted on
  either. Writes made directly in the response callback were already blocked before (their subject op is the
  protected request). Narrowing only, not model-visible (`notOffered` is not part of the model's input); needs the
  owner's confirmation for CONTRACT §13.
- Extra public surface: `Runtime.adapter()/inflight()/holdBudgetMs()/situationBudget()`, `on("report")`,
  `Situation.salient/facts/compact/budget`, `Decision.tier/ran/answers/subjectRef/candidate/mass`,
  `ActionRecord.late/dropped`, `Explanation.message`, `StandingQuestion.always`, `PolicyOptions.holdWrites`,
  `observe.untrustedEvents`, `SituationDraft.delivery`,
  `InitOptions.vocabulary/settleMs/learn/situation`, `CreateOptions.app/hooks`, `ActionDef.tier`,
  `ActionContext.builtin/describe/onUndo`, `EvaluateRequest.timeoutMs/subject`.

## Open issues

- SAFETY (2026-10-10), documented residual risks (THREAT-MODEL.md, tests in `test/invariants/`): in guard, an
  identical POST within 2 s can be coalesced (the double-submit action; no undo); with `triage: "always"` a late revert
  of an app's own bookkeeping write can make a sync loop resend an item (bounded by `actionLimits.perSubject`); an
  inconsistency `rollback` (heal) restores whole stores, including fields a protected flow wrote; `serve_cached` (heal)
  does not key on cookies (another user's cached GET after an in-page sign-out/sign-in); when the app sets no `mode`,
  `?genclass=guard` / `localStorage.genclass = "guard"` opt a visitor into guard (by design, `test/default-mode.test.ts`;
  an explicit `mode` makes it demote-only); the model card is not pinned by an app-supplied hash and its meta gate
  sets thresholds unless `policy.thresholds` is set; onnxruntime-web's wasm is checked by version tag, not sha256.
- SAFETY: the runtime does not release holds when the tab becomes hidden (it only skips new holds and background
  evaluations); `API.md` says hidden tabs "release held items unevaluated". Bounded by the hold budget either way.

- In-place mutation detection is best effort: arrays by reference/length plus 8 sampled elements, collections by key
  count, last key and 8 sampled values; a deep in-place change outside the samples can go unseen (subscribers are
  still notified on every `set()`).
- Lead (UI-NEEDS item 2): `react-dom` is not a devDependency of `@genclass/runtime`.
- Any change to situation wording must be coordinated with SIM (one implementation, `src/situation/*`).
- Locating a field in a response body is heuristic (item id, key-path suffix, the one compatible array); ambiguous
  bodies give no content facts, and an app that maps response data to different values makes them uninformative
  (statements are about the response's own content, so they stay true). Bodies are compared only when the delivery
  is already salient, and only JSON ≤ 256 KB.
- Count-by-group candidates add about 0.5 ms to a settled point with large adapter stores (bounded: 24 arrays × 8
  columns × 8 values × 64 numbers).
- Predicted write sets are normalised paths (`board.cards.:id`): while one item of a collection has a pending local
  change, a message about another item of the same collection is salient too (extra latency, never a wrong drop:
  `discard` drops only fields with newer data or the pending change).
- `holdWrites: true` with adapter stores whose state is read directly (`store.getState()` in redux middleware):
  those reads do not see held writes (only the runtime's own `get()` does). Default off; per-store `hold: false`.
- Content comparison facts (response/write value vs current value: identical / older / newer version) are not
  implemented yet; waiting for SIM's separability proposals (room is left in the fact budget).
- **Zustand discovery in production builds (compat, 2026-10-10).** Zustand's `devtools` middleware connects only when
  `enabled ?? import.meta.env.MODE !== "production"`, so a production build never calls the Redux DevTools `connect`
  shim and its stores are not discovered (`compat/apps/react-vite`, layer `zustand`: 0/240 runs; with
  `enabled: true`, layer `zustand-on`: 240/240). Nothing in the runtime can see such a store without patching Zustand;
  documented in the README. Repro: `node compat/run.mjs --apps react-vite --layers zustand,zustand-on --seeds 1`.
- **Query caches (TanStack Query, SWR, Apollo) are not stores (compat, 2026-10-10).** React discovery records what
  components read from them (`useQuery` / `useSWR` snapshots as `Comp.externalN`, observed only), not the caches.
  Design note, not built: `docs/runtime/QUERY-CACHE-ADAPTERS.md`.
- **Guard/heal holds can change which stale answer wins on an already-buggy page (compat, 2026-10-10).** In the
  stale-typeahead scenario, guard and heal held deliveries while the model decided (only where state is discovered:
  the React, Redux and Zustand layers), and on 3 to 4 of 10 seeds per layer a different stale answer ended on screen
  than without GenClass (no fix, no new bug; observe never holds). Expected from holding; listed in
  `compat/RESULTS.md`.
- **Observe changes timing on racy apps (compat, 2026-10-10).** SWR's `rollbackOnError` with two overlapping
  optimistic mutations (scenario d, seed 7) left the first toggle unchecked while the server had it checked in 3 of 4
  runs without GenClass, and in 0 of 6 with GenClass in any mode, with no action taken. Observe never holds or
  delays a delivery, but its main-thread work can shift which side of an app's own race wins. The matrix reports it
  as the only observe ✗; not traced further.
