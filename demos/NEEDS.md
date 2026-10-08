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

The same mechanism shows up in every demo with user writes (traced runs, 30 chaos seeds each, counting only held
writes that applied after a newer user write and then changed that same field; Off: 0 in every demo):

| demo | Guard | what the held write did |
|---|---|---|
| board | 50 held writes after a newer move of the same card, 11 visibly put it back | live events and confirmations moved cards back (jump-backs 3.07 → 4.80 per session) |
| editor | 37 | save echoes rewrote `notes.n1.body` after newer keystrokes (typed text overwritten; visible text reverts 1.10 → 1.57 per session in the full run) |
| checkout | 24 | cart confirmations set a line's quantity back after the user's newer +/− click (e.g. "Dad cap qty 2 → 1"); the app keeps its total incrementally, so the total and the lines drift apart |

In the editor this also defeats the app's own guard: the app decides "is the user typing?" (`applyBody`) when the
save response arrives; GenClass then holds that write up to 800 ms, and keystrokes typed meanwhile are overwritten
when it applies. The board's whole-board rollback captures snapshots that miss writes GenClass is still holding, so
restoring them erases more (cards stuck "syncing": 6 → 9/10).

Full evaluation (810 trials, no traces): Guard introduced more bugs than it fixed in editor (3/1), checkout (3/1)
and board (5/3), with zero actions executed in Guard (decisions 5/1 comes from v0.1's answers to `ask`, not holds). On clean runs Guard took no actions, but holds
still produced one search bug (older results on screen ≥ 400 ms after the right answer arrived).

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

## 5. Heal acts on non-idempotent writes (CORE / policy)

Final run, Heal (all actions executed in chaos runs; none on clean runs): `block` ×124, `retry` ×29,
`serve_cached` ×3. Blocks hit writes the user is waiting on: `POST /api/orders` ×5 (the order fails at once with
503), `POST /api/cart/lines` ×8, autosave `PUT /api/notes/:id` ×5 and `PUT /api/journal` ×4 (the save fails and
the text stays unsaved), board moves ×2; plus 88 blocks of the decisions demo's heartbeat `GET /api/ping`. One
non-idempotent `POST /api/cards/:id/move` was retried. A 502/504 can arrive after the server committed (the demos'
"lost responses" chaos), so retrying a POST can duplicate it. Suggestion: never offer `block` for a write the user
initiated in the last few seconds without the diagnosis being `overload`/`failing`; offer `retry` for non-idempotent
methods only for failures before the request reached the server (network errors) or with an idempotency key.

## 6. Observe EventSource (and BroadcastChannel) messages as ops (CORE)

The board receives live updates through a real `EventSource`. Writes in `onmessage` have no ambient op, so situations
cannot say "this write comes from live event #12, older than the write it replaces". WebSocket messages already get
this; the same for `EventSource` (message, `lastEventId`, stream URL) would let the model see out-of-order events.

## 7. Keep observing synthetic DOM events (CORE)

The in-page "Run trials" button drives the apps with synthetic DOM events; the DOM observer records them today (no
`isTrusted` filter). Please keep that (or make it an option). The headless eval uses real input.

## 8. Notes on the v0.1 model (no action for CORE)

Final run (810 trials): the model's diagnosis was almost always `unusual` at 0.4–0.7. Guard's gate never passed
(non-passive mass below 0.9: 854 times for discard/defer), so Guard executed nothing; Heal executed 156 actions, all
in chaos runs. False interventions on clean runs: 0 in every demo and mode, because v0.1 rarely clears the
thresholds, not because it recognises clean situations. `ask`/`decide` accuracy in the decisions demo: 0.37 (app
defaults) → 0.61 under chaos, 1.00 → 0.27 on clean runs (it answers as if something were always wrong). Decision
latency p50: 0.4–0.8 s (status dashboard 1.7 s, many concurrent polls).
