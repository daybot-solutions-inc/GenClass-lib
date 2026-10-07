# What the demos need from @genclass/runtime

Owner: DEMOS. Read by CORE, MODEL, UI and the lead. Evidence: `demos/results.json` (810 trials: 6 demos × Off/Guard/
Heal × 30 chaos + 15 clean, Playwright with real input, headless Chromium on the `train` VM, no GPU, v0.1 GenClass
q8 on WASM, pages cross-origin isolated so the model worker gets 4 WASM threads). Most important first.

## 1. Holding a write reorders it after newer user writes (CORE, harm with zero actions)

`StoreHub.propose` lets user-sync writes bypass the per-store queue (`hub.ts`, "User-sync writes ... bypass the
queue and never wait"), while an earlier non-user write may be held. When the held write fails open (budget expired,
or the model says `apply`), it is applied after the user's newer write and, being a functional update, re-runs on
top of it. Without GenClass the order would have been: older write, then the user's write.

Seen in the board demo: a live event for card X (older) is held for up to 300 ms; the user moves card X (applied at
once); the held event then lands and moves X back. With **no action executed**, Guard turned 9 of 30 chaos seeds
that were clean with Off into bugs (Off 15/30 → Guard 23/30, Heal 22/30; fixed 1–2) and raised visible jump-backs
from 2.9 to 3.9 (Guard) / 4.8 (Heal) per session.

Suggestion: when a user-sync write is proposed for a store with pending (held or queued) writes, either release the
pending writes first (apply them in proposal order before the user write), or keep proposal order by queueing the
user write behind them with a tiny bound, or mark the held write stale and re-decide. Fail-open must never change the
order the app would have seen.

## 2. Decisions are slower than the hold budget (MODEL / lead)

Model decision latency p50 per demo: 300–520 ms (status dashboard 1.2 s, many concurrent polls); before the pages
were cross-origin isolated (single-threaded WASM) it was ~1.9 s. With the default `holdBudgetMs` of 300 ms,
663 decisions arrived too late to act. The ≤ 25 MB runtime model and WASM threads are what helps; the demos now serve
COOP/COEP from their Service Worker (`?coi=0` turns it off) and record `gc.isolated` per trial. Please document the
isolation recommendation in API.md (headers, or a Service Worker like `demos/src/server/sw.ts`).

## 3. Holds add user-visible latency when the model cannot answer in time (CORE)

Clean runs (no chaos, correct app behaviour), user-visible latency, mean: search final results 20 ms (Off) → 199 ms
(Guard); checkout order confirmation under chaos 811 ms → 1,141 ms; status change detection 1.51 s → 2.0 s (chaos).
Suggestion: do not hold when the recent decision latency (e.g. p50 of the last N decisions) is above
`holdBudgetMs`: fail open at once and still record/report the late decision. That removes the latency tax and the
ordering issue in §1 while the model is slow.

## 4. `retry` is offered for non-idempotent requests (CORE / policy)

Heal retried non-idempotent requests after failures: `POST /api/orders` (1), `POST /api/cart/lines` (2),
`POST /api/cards/:id/move` (6), plus idempotent `PUT`/`GET` retries (21). A 502/504 can come after the server
committed (the demos' "lost responses" chaos), so retrying a non-idempotent POST can create a duplicate order or add
an item twice. Consider offering `retry` only for idempotent methods, or for non-idempotent ones only when the
failure happened before the request reached the server (network error) or carried an idempotency key; and say so in
the action description the model reads.

## 5. Observe EventSource (and BroadcastChannel) messages as ops (CORE)

The board receives live updates through a real `EventSource`. Writes in `onmessage` have no ambient op, so situations
cannot say "this write comes from live event #12, older than the write it replaces". WebSocket messages already get
this; the same for `EventSource` (message, `lastEventId`, stream URL) would let the model see out-of-order events.

## 6. Keep observing synthetic DOM events (CORE)

The in-page "Run trials" button drives the apps with synthetic DOM events; the DOM observer records them today (no
`isTrusted` filter). Please keep that (or make it an option). The headless eval uses real input.

## 7. Notes on the v0.1 model (no action for CORE)

- Diagnosis: `unusual` for 6,328 of 6,386 decisions (`inconsistent` 58, never `expected`), so the "diagnosis is not
  expected" gate never blocks anything; Guard was stopped by the 0.9 threshold (730×) and the budget (663×).
- Heal's actions were `retry` on failures (30×), `block` of the decisions demo's heartbeat `GET /api/ping` (60×) and
  `block` of two editor autosaves (`PUT /api/notes/:id`).
- False interventions on clean runs: 0 in every demo and mode, but only because v0.1 rarely clears the thresholds
  in time, not because it recognised clean situations.
- `ask`/`decide` in the decisions demo: decision accuracy under chaos 0.42 (app defaults) → 0.62 (Guard), on clean
  runs 1.00 (defaults) → 0.27: v0.1 answers as if something were always wrong.
