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
