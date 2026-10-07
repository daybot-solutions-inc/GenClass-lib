# What the demos need from @genclass/runtime

Owner: DEMOS. Read by CORE, MODEL, UI and the lead. Evidence: `demos/results.json` (810 trials: 6 demos × Off/Guard/
Heal × 30 chaos + 15 clean, Playwright with real input, headless Chromium on the `train` VM, no GPU, v0.1 GenClass
q8 on WASM, pages cross-origin isolated so the model worker gets 4 WASM threads). Most important first.

## 1. Guard makes the board worse without taking any action (CORE)

Board, 30 chaos seeds per mode: Off 15/30 bugs, Guard 23/30, Heal 22/30. Paired by seed, Guard turned 9 seeds that
were clean with Off into bugs and fixed 1 (Heal: 9 and 2). If timing noise were the only cause, 9-of-10 discordant
pairs in one direction would have p ≈ 0.01. Guard executed **zero** actions on the board, so the difference comes
from holding writes. Visible jump-backs (a card the user moved shows its old column again) went from 2.9 to 3.9
(Guard) / 4.8 (Heal) per session.

Likely mechanism (from `src/state/hub.ts`: "User-sync writes ... bypass the queue and never wait"): a live-event
write for card X (older) is held for up to 300 ms; the user moves card X, and that write applies at once; the held
event then applies after it, re-running its functional update on top of the user's newer state and moving X back.
Without GenClass the event would have applied first and the user's move last.

Suggestion: fail-open must never change the order the app would have seen. When a user-sync write arrives for a
store with pending writes, apply the pending ones first (in proposal order), or treat them as superseded and decide
again, before the user write. A regression test: hold a functional write to `s.x`, apply a user write to `s.x`,
release the hold with `apply`; the final value must be the user's.

## 2. The default redaction hides ordinary fields such as kanban `cards` (CORE)

The default `redact` matches `/pass|token|secret|card|cvv|ssn|auth/i` anywhere in a path, so every field of the
board demo's store (`board.cards.*`) reaches the model as `[redacted]`. A real detection from the board page (Guard):
"Flagged an unusual write: board.cards.c2.column changed since #19 started: [redacted] → [redacted]". The model
cannot see that a live event moves a card back to an older column, which is exactly what it would need. The same
pattern also catches `author`, `authors`, `tokens` (design tokens), `passenger`, `compass`, `bypass`, `cardinality`.

Suggestion: match whole path segments (split on `.`, `_`, `-` and camelCase) against a list such as `password`,
`passwd`, `secret`, `token`/`accessToken`/`refreshToken`, `apiKey`, `cardNumber`/`ccNumber`, `cvv`/`cvc`, `ssn`,
`authorization`; keep password inputs redacted as today. The demos keep the runtime's default on purpose (a normal
integration would), so board results include this effect.

## 3. Decisions are slower than the hold budget (MODEL / lead)

Model decision latency p50 per demo: 300–520 ms (status dashboard 1.2 s, many concurrent polls); before the pages
were cross-origin isolated (single-threaded WASM) it was ~1.9 s. With the default `holdBudgetMs` of 300 ms,
663 decisions arrived too late to act. The ≤ 25 MB runtime model and WASM threads are what helps; the demos now serve
COOP/COEP from their Service Worker (`?coi=0` turns it off) and record `gc.isolated` per trial. Please document the
isolation recommendation in API.md (headers, or a Service Worker like `demos/src/server/sw.ts`).

## 4. Holds add user-visible latency when the model cannot answer in time (CORE)

Clean runs (no chaos, correct app behaviour), user-visible latency, mean: search final results 20 ms (Off) → 199 ms
(Guard); checkout order confirmation under chaos 811 ms → 1,141 ms; status change detection 1.51 s → 2.0 s (chaos).
Suggestion: do not hold when the recent decision latency (e.g. p50 of the last N decisions) is above
`holdBudgetMs`: fail open at once and still record/report the late decision. That removes the latency tax and the
ordering issue in §1 while the model is slow.

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
