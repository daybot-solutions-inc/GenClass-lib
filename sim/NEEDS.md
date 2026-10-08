# SIM → CORE requests and observations (relayed by the lead)

Status legend: OPEN (needed), ASK (would help), DONE (landed; verified by the sim on the VM).

The sim drives the real runtime with `createRuntime({ clock, global, decider, observe: { fetch: true, timers: true,
others false }, triage: "salient", mode: "heal", report: "silent", policy: { thresholds: { report: 0, guard: 0,
heal: 0 }, holdBudgetMs: 1e9, maxActionsPerMinute: 1e9, requireDiagnosis: false }, vocabulary, hooks, app })`.

## Requests

1. DONE `EvaluateRequest.subject` (`SubjectRef`). Verified: 100% of decisions in a 20k-row run correlate with the
   app-level op/write/error. Transitions on user/timer ops are resolved through the causal chain from
   `hooks.opCreated` (`cause`).
2. DONE `hooks.opCreated` / `hooks.mutationProposed`. Both are synchronous inside `fetch(...)` / `atom.set`, as
   documented.
3. DONE `policy.requireDiagnosis: false`. Forced non-passive actions run even when the sim's label is `expected`.
4. DONE `vocabulary.diagnoses` / `vocabulary.actions`. Used per trajectory for paraphrases and subsets
   (`expected` kept first).
5. DONE `situation()` has no side effects. Verified: ask probes in the base run never break the byte-identical
   replay of counterfactual prefixes (0 prefix mismatches in 20k+ rows).

## OPEN (crash, found 2026-10-08 01:10 UTC by SIM feature smoke tests)

g. **`describe()` recurses forever on NaN** (`packages/runtime/src/util.ts:245`): `const r = redact(path, v); if (r !== v)
   return ... describe(r, "", () => r, max)`. For `v = NaN` the default redactor returns NaN, `NaN !== NaN` is true, and
   it recurses with the same NaN until `RangeError: Maximum call stack size exceeded`. Any app whose state holds a NaN
   (`parseFloat("")`, `0/0`, a renamed server field in a sum: common in real apps) crashes situation building, in
   production as well. Fix: `if (!Object.is(r, v))` (identical output for every non-NaN value, so `situation-v1` text
   is unchanged). Until it lands, sim trajectories that put NaN in state are dropped as internal errors (counted in
   `stats.json` drops).

## Observations from ~30k recorded situations (ASK; non-blocking, parity is unaffected)

a. **Values redacted because of the element description.** `user changed card "Incident spike" to "[redacted]"`.
   The default redactor matches `card` in the *target text* (a kanban card), not a sensitive field. Real
   kanban/board apps will lose all move values. Suggest applying `SENSITIVE_KEY` to field paths, query params and
   input types (password, cc-*), not to element descriptions.
b. **Parent paths of flattened objects print as `undefined`** in the `state` section, for example
   `monitorStats.kpis = undefined (v1, by #3 12.0s ago)`, next to `monitorStats.kpis.p95_latency = 343`.
c. **"changed … 6 → 6".** `order.itemCount changed since this write's cause (#25) started: 6 → 6, last by …`
   (it went 6 → 7 → 6). Wording like "changed 2 times and is back to 6" would avoid a self-contradictory fact.
d. **Element-change summaries hide the changed key.** `1 changed: {id: "…", +5} → {id: "…", +5}`. Showing the
   key that differs (`qty: 1 → 2`, `column: "todo" → "done"`) would make stale echoes and conflicting moves
   much easier to see.
e. **Short slug ids are not normalised in signatures** (`GET /api/tasks/tasks-1cam`), so each item gets its own
   baseline. This is realistic for slug routes and the sim keeps ~1/9 of programs that way; just noting it.
f. **A remote write that conflicts with a pending local change is never salient.** A write caused by a WebSocket
   message (now observed: the sim exposes a WebSocket and `observe.websocket: true`) has a just-started cause, so
   none of the triage facts fire. That holds even when an in-flight local op (an optimistic move/edit not yet
   confirmed) touches the same field. The conflict only becomes visible later, when the local echo lands. Consider
   making "an in-flight op from a user action touches a field this write changes" non-neutral, so the model can
   `defer` or `discard` the remote write when that is right.

## Notes (SIM side)

- `transient` (CONTRACT §6) is not yet in `src/situation/questions.ts` `DEFAULT_DIAGNOSES`. Until it is, the sim
  passes the contract's default vocabulary explicitly (same wording, `transient` last) on default-vocabulary
  trajectories, and switches back automatically once the runtime's defaults contain every contract label.

## Batch 4 / situation-v2 (`delivery` at the network boundary): what the sim needs (OPEN, 2026-10-08 01:35 UTC)

The sim forces each applicable action at a decision and measures its counterfactual cost, and labels the diagnosis
from its own knowledge of the subject. For `delivery` (a fetch response or WebSocket message about to reach the app)
it needs:

1. **SubjectRef for `delivery`**: `{ kind: "delivery", op }`, where `op` is the fetch op (same id as `opCreated` gave)
   or the WebSocket *message* op. Optionally `paths` the op's chain is known to write (from profiles); not required.
2. **`hooks.opCreated` stays synchronous for WebSocket message ops**, fired inside the socket's `message` dispatch before
   any app listener runs (the sim sets an ambient tag around its own dispatch to map message op → which simulated
   push it was). Same for fetch ops (already the case).
3. **Deterministic holds**: a held delivery waits only on the injected clock/decider (no real timers, no
   `queueMicrotask` loops that depend on real time), and the app sees nothing of the response before the decision.
   `defer`/`delay`-like re-decisions must re-enter the decider (new decision index) so forced futures stay replayable.
4. **Action names, tiers and passive action per trigger** for `delivery` and the non-blocking `mutation` (late revert)
   listed in STATUS.md, and the same forcing semantics as today: with `thresholds` 0.5 and `requireDiagnosis: false`,
   probability 1 on an action runs exactly that action (passive with mass 0 runs passive).
5. **Observable effect of `discard` at delivery**: `ActionRecord.changed` (or a `data` field on the action event) naming
   the store paths whose writes were dropped, so sim tests can assert "dropped the stale write" vs "dropped nothing".
6. Keep `hooks.mutationProposed` synchronous (write correlation), `situation()` side-effect free, `vocabulary`,
   `situation.budget`, and `policy.requireDiagnosis` — all used by the generator.

How the sim will label `delivery` rows: action labels exactly as today (K = 3 paired futures, costs vs the
ideal run). Diagnosis = the label of the subject op's first data write in the passive branch (the writes the delivery
would have caused, classified by the existing per-write rules), else `expected`; failures keep their failure rules.

## Situation-v2 fact proposals from the separability analysis (ASK, 2026-10-08 02:50 UTC)

CORE left room for "SIM's separability proposals" (STATUS.md, batch 4). Full evidence is in `sim/SEPARABILITY.md`
§4 and §6, measured on 150k probe rows. The proposals, in order of measured effect, phrased for `delivery` as
response content vs current state on the paths in P:
- **F1 Cell-level revert of newer data.** Join response items to store items by id and say whether the response
  puts back the value a newer op replaced, or touches a different item than the newer op did. Rows where the write
  reverts a newer cell are clear 10.3 % of the time vs 2.6 % otherwise.
- **F2 Overwrite of user input.** Say that the write would overwrite text the user typed after the request started
  (and whether the user is still typing), with a **diff-centred preview**. Today both sides are truncated to the
  same prefix ("Guild page sword shield…" → "Guild page sword shield…"). Clear rate 12.6 % vs 3.6 %.
- **F3 No change.** "Response equals the current values of P": clear rate 0.6 % vs 4.2 %. This also makes the
  delivery non-salient, which saves a model call.
- **F9 Provenance of known-stale values.** Mark values written by a conflict that was delivered anyway, by a response
  that took more than 5× its usual time, by a rollback after an ambiguous failure, or by a push received after the
  channel had been down. State the mark when a later decision involves the path. This is the only computable route
  to "the client is already wrong", which separates inconsistency/transition rows (0.4 % clear when the client is
  right vs 12–16 % when it is diverged).
- **F6 Learned refresh and save cadence of the source** ("refreshes every 5.0 s, next in 0.4 s"): clear rate 2.1 %
  when the next refresh is ≤ 1 s away vs 12.4 % when it is 3–10 s away.
- **F5 Failure scope** (failures across other endpoints of the origin in the last few seconds; offline) and commit
  ambiguity (500 after the usual server time or network error after upload: "may have been applied").
- **F7 Repeat evidence:** `MouseEvent.detail`, same element, busy indicator visible at the second click.
- **F8 Relations:** no ∈/== relations between unrelated small integers or version counters; add count-by-group
  relations.
- **Read-your-writes:** the list response lacks, or duplicates, the item a recent create returned.

## Lead: `scripts/vm.sh` deletes symlinked outputs (FYI, 2026-10-08)

`sim/out` is now a symlink to `/data/sim-out` (train VM data disk). The sync's `--exclude '/sim/out/'` (trailing
slash) matches directories only, so every `vm.sh sync/run sim` deletes the link; the data on `/data` is safe. SIM
recreates the link after each sync (`ln -sfn /data/sim-out sim/out`). Changing the pattern to `--exclude '/sim/out'`
would fix it for good (lead-owned file).
