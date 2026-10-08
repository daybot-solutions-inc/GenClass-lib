# What the demos need from @genclass/runtime

Owner: DEMOS. Read by CORE, MODEL, UI and the lead. Runtime: frozen batch 3 (commit 1a77558). Model: v0.1 GenClass
q8 on WASM (pages cross-origin isolated, 4 threads), so decisions take ~0.5–1.5 s and the "auto" hold budget sits
at its 800 ms ceiling. Evidence: Playwright with real input on the `train` VM; traced runs (`eval.ts --trace`) record
every proposed write (CORE's `hooks.mutationProposed`), when it really applied (`state` events), its cause op and
the decision about it. The mock server uses common random numbers (each logical request and live event gets the
same latency/failure in every mode), and test code uses native timers, so GenClass sees only the app.

## 1. Holding a write lets it land after the user's newer write (CORE, product risk)

GenClass makes the board demo visibly worse **without executing a single action** (Guard: 0 actions in 30
sessions). Board, 30 chaos seeds, traced:

| run | bugs | jump-backs per session | writes held (median hold) | held write applied after a newer user write to the same card | of which put the card back | cards stuck "syncing" |
|---|---|---|---|---|---|---|
| Off, run A | 17/30 | 3.07 | 1 of 1,058 | 0 | 0 | 6 |
| Off, run B | 16/30 | 3.00 | 1 of 1,059 | 0 | 0 | 6 |
| Guard | 19/30 | 4.80 | 408 of 1,081 (681 ms) | 50 | 11 | 9 |
| Heal | 21/30 | 4.80 | 434 of 1,078 (688 ms) | 65 | 20 | 10 |

The A/A pair (Off twice, same seeds) flips 1 seed, so Guard's 5 introduced / 3 fixed and Heal's 7 / 3 are a small
real effect on the bug rate; the large effect is the +56% visible jump-backs (a card the user moved snaps back).

Mechanism (`src/state/hub.ts`, `propose`): a user-sync write bypasses the store's queue and applies at once, while
an earlier non-user write to the same store waits in the queue for its decision (up to the hold budget). When the
held write is released (`apply`, or the budget expires), its functional update re-runs on the current state, which
now contains the user's newer change, and overwrites it. Without GenClass the older write would have applied first.
Not involved: executed actions, late reverts, `defer` (never ran), subscriber timing.

Concrete trace (Guard, seed 1007, card c8; seconds since the session's first write):

```
4.813  #13  live event                      review → doing   applied 5.477, held 664 ms  (model: unusual, chose apply, 1,527 ms)
4.842  #14  user clicks "Move right"        review → done    applied 4.842
4.919  #15  live event                      done → review    applied 5.583, held 663 ms
```

The user moves c8 to Done; 635 ms later the held event (proposed 29 ms before the click) moves it back to Doing, then
another held event to Review. More examples from the same run: seed 1001 c2 (event held 790 ms lands 0.3 s after the
user's move), seed 1002 c6 (server confirmation held 608 ms reverses a move to Done for 302 ms), seed 1007 c8 (held
confirmation reverses a move to Doing for 523 ms).

The same ordering problem can defeat app-level guards (expected from the mechanism; traced editor run pending):
the editor decides "is the user typing?" when a save response arrives (`applyBody`), then GenClass may hold that
write for up to 800 ms; keystrokes typed during the hold would be overwritten when it applies. The board's whole-board rollback also captures snapshots that miss writes GenClass is
holding, so restoring them erases more (cards stuck "syncing": 6 → 9/10).

Suggestions: fail-open must never change the order the app would have seen. When a user-sync write arrives for a
store with pending (held or queued) writes, apply the pending ones first in proposal order (or treat the overlapping
ones as superseded and decide again) before the user write. Regression test: hold a functional write to `s.x`, make a
user-sync write to `s.x`, release the hold with `apply`: the final value must be the user's.

## 2. Holds cost interactive latency while the model is slower than the budget (CORE / MODEL)

Search typeahead, clean runs (no chaos, calm typist, 15 seeds): final results p50 **6 ms with Off, 389 ms with
Guard**. 127 of 148 result writes were held (median 543 ms): every response is "salient" because the user keeps
typing (the input moved since the request started), which is normal for a typeahead. Decisions also queue: the
median decision took 826 ms and slowed from 504 ms (first of a session) to 941 ms (last), because the model host
answers one request at a time and a typing burst produces one decision request per response.

Suggestions: do not hold when the recent decision latency is above the budget (fail open immediately, still decide
in the background for reporting); drop queued decision requests that a newer write to the same fields has
superseded; consider a lower ceiling than 800 ms for writes the user is waiting on.

## 3. Resolved in batch 3: redaction of ordinary fields

The default redactor used to hide every `board.cards.*` field ("[redacted] → [redacted]"). Batch 3's word-level
redaction fixed it; the board's situations now show columns and versions.

## 4. Demos-side fixes that changed earlier numbers (for the record)

- Earlier runs reported Guard introducing 9 board bugs (vs 1 fixed). Most of that was my mock server: it drew all
  chaos from one random stream in request-arrival order, so any timing shift re-rolled every later latency and
  failure. Common random numbers fixed it (A/A flips: 1 of 30).
- Oracle samplers and other test timers used the page's `setInterval`, so the runtime's timer observer saw them as
  ops ("interval 0.05s") and could attribute app writes to them. Test code now uses timers captured before
  `GenClass.init`.

## 5. `retry` is offered for non-idempotent requests (CORE / policy)

Heal retried non-idempotent requests after failures: `POST /api/orders` (1), `POST /api/cart/lines` (2),
`POST /api/cards/:id/move` (6), plus idempotent `PUT`/`GET` retries (21). A 502/504 can come after the server
committed (the demos' "lost responses" chaos), so retrying a non-idempotent POST can create a duplicate order or add
an item twice. Consider offering `retry` only for idempotent methods, or for non-idempotent ones only when the
failure happened before the request reached the server (network error) or carried an idempotency key; and say so in
the action description the model reads.

## 6. Observe EventSource (and BroadcastChannel) messages as ops (CORE)

The board receives live updates through a real `EventSource`. Writes in `onmessage` have no ambient op, so situations
cannot say "this write comes from live event #12, older than the write it replaces". WebSocket messages already get
this; the same for `EventSource` (message, `lastEventId`, stream URL) would let the model see out-of-order events.

## 7. Keep observing synthetic DOM events (CORE)

The in-page "Run trials" button drives the apps with synthetic DOM events; the DOM observer records them today (no
`isTrusted` filter). Please keep that (or make it an option). The headless eval uses real input.

## 8. Notes on the v0.1 model (no action for CORE)

- Diagnosis: `unusual` for 6,328 of 6,386 decisions (`inconsistent` 58, never `expected`), so the "diagnosis is not
  expected" gate never blocks anything; Guard was stopped by the 0.9 threshold (730×) and the budget (663×).
- Heal's actions were `retry` on failures (30×), `block` of the decisions demo's heartbeat `GET /api/ping` (60×) and
  `block` of two editor autosaves (`PUT /api/notes/:id`).
- False interventions on clean runs: 0 in every demo and mode, but only because v0.1 rarely clears the thresholds
  in time, not because it recognised clean situations.
- `ask`/`decide` in the decisions demo: decision accuracy under chaos 0.42 (app defaults) → 0.62 (Guard), on clean
  runs 1.00 (defaults) → 0.27: v0.1 answers as if something were always wrong.
