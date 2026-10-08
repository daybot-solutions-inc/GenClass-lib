# realapps: audited example rows (pilot, runtime `situation-v1`)

These rows come from the pilot (`~/gcl/real-out/pilot4` on the `train` VM):
- 230 trajectories over 26 apps (22 written for the corpus, 4 open-source RealWorld front-ends);
- 1,654 gold rows, of which 439 are ask rows and 171 diagnosis-only, plus 2,325 unlabeled rows;
- 0 prefix mismatches.

Every row is exactly what the real `@genclass/runtime` handed the decider inside headless Chromium. Situations are
shortened where marked `…` (timelines trimmed to the relevant lines). For each row:
- **Costs** are mean costs per action over the paired futures; the bracketed lists are per future.
- **Parts** are the cost terms of future 0.
- **Verdict** is my audit. "Correct" means I traced the run (DOM and state over time, forced-action reruns with
  `debug.js --force k:action`) and the label matches what happens.

The cost terms and label rule are the sim's (see `README.md`).

Summary of the audit (details per row below):

| # | app (framework) | trigger | diagnosis | best (label mass) | verdict |
|---|---|---|---|---|---|
| 1 | vanilla-checkout (vanilla) | failure | transient | retry (1.00) | correct |
| 2 | mobx-portfolio (React + MobX) | failure | failing | deliver (1.00) | correct |
| 3 | vue-editor (Vue + axios) | mutation | stale | discard (0.97) | correct |
| 4 | solid-settings (Solid) | mutation | stale | discard 0.72 / defer 0.28 | correct |
| 5 | rtk-todos (React + RTK) | request | duplicate | block (1.00) | correct |
| 6 | pinia-cart (Vue + Pinia) | request | duplicate | coalesce (1.00) | correct |
| 7 | preact-likes (Preact signals) | stall | slow | hedge (0.76) | correct, soft |
| 8 | pinia-cart (Vue + Pinia) | inconsistency | inconsistent | rollback (1.00) | correct |
| 9 | svelte-chat (Svelte 5), clean run | inconsistency | expected | ignore (1.00) | correct |
| 10 | svelte-chat (Svelte 5) | error | duplicate | ignore (1.00) | correct |
| 11 | zustand-board (React + Zustand + WS) | mutation | expected | apply (0.85) | correct |
| 12 | alpine-tasks (Alpine) | mutation | expected | defer (1.00) | gray: latency artefact |
| 13 | rtk-todos | ask | — | exact answers | correct |

Real-app phenomena the sim does not produce show up here:
- Svelte 5's `each_key_duplicate` render error (row 10).
- A blind full-object settings echo reverting a checkbox the user just ticked (row 4).
- Redux Toolkit thunks double-submitting from a button whose label changed to "Adding…" (row 5).
- A RealWorld front-end that GenClass v1 breaks with a perfect do-nothing model (end of this file).

---

### 1. Transient 500 on a profile prefetch → retry

`real-vanilla-checkout-10034-d1`: vanilla TS + fetch + `rt.atom`, chaos normal, budget 1,000 (compact questions).
```
trigger: GET /api/docs/profile (#5) failed (HTTP 500) and the app has not seen the failure yet.
facts:
  The request #5 failed: HTTP 500 Internal Server Error after 0.09s; the app has not seen the failure yet.
  This is the 1st GET /api/docs/profile failure in a row (recent outcomes: 500; no success yet); error rate 100% over 1 request (1 failed).
  Before this failure its chain wrote checkout.rates.
  This request comes from GET /api/rates (#4), started 0.17s ago, ended 0.09s ago with 200.
  GET is idempotent.
action: deliver | retry
```
- **Labels:** action `{retry: 1}`, diagnosis `transient` (the mock server's own record: a random 500, not an outage).
- **Costs:** deliver 5.16 [5.23, 5.17, 5.08], retry 0.75 [0.81, 0.77, 0.68].
- **Parts:** deliver area 3.65 + final client 0.3 (the shipping form is never prefilled); retry area 0.34 + 1 wasted request.
- **Verdict: correct.** With `deliver`, the profile data never arrives within the horizon: the shipping form stays
  unfilled (area 3.65, final client 0.3). One retry succeeds in all three futures.

### 2. Network error during an outage → deliver

`real-mobx-portfolio-10018-d8`: React + MobX via `rt.guard`, flaky.
```
trigger: PATCH /api/holdings/:id {shares: 6} (#113) failed (network error) and the app has not seen the failure yet.
facts:
  The request #113 failed: network error (Failed to fetch) after 1.09s; the app has not seen the failure yet.
  This is the 1st PATCH /api/holdings/:id failure in a row (recent outcomes: 200, 503, 200, 200, network error; last success 3.59s ago); error rate 15% over 20 requests (3 failed).
  Before this failure its chain wrote portfolio.holdings, portfolio.totalValue.
  This request comes from user clicked button "+1" (#112), started 1.09s ago.
  PATCH is not idempotent; its body (12 bytes) can be replayed.
action: deliver | retry
```
- **Labels:** `{deliver: 1}`, diagnosis `failing`. The holdings endpoint is inside a network-error outage window,
  and that is the server's record, not something the runtime could see.
- **Costs:** deliver 67.38, retry 67.40, a tie. Retry costs one more wasted request and changes nothing, because the
  retry falls into the same outage.
- **Verdict: correct.** The facts make this look like a one-off error, and only the server knows it is an outage.
  The diagnosis label is therefore partly unobservable. That is the same property as the sim's outage labels.

### 3. Overlapping autosave echo over newer typing → discard

`real-vue-editor-10021-d9`: Vue templates + axios (XMLHttpRequest).
Flags: `save:overlap` (bug), `echo:blind` (bug), `versionCheck:false`.
```
trigger: A write to editor.body, editor.version, editor.dirty and 1 more from PUT /api/notes/:id {title: "Budget draft", +1} (#171) is about to be applied.
facts:
  editor.body was written twice by other operations since this write's cause (#171) started (version 144 → 146), last 0.02s ago by user typed "Budget draft: first draft. Owner bo. Sh…" into textarea "Note" (#174), which s…
  Applying this write would break the learned relation editor.version ∈ list.notes[*].version (editor.version = 5, not among list.notes[*].version); it held at 12 settled points.
  This write's cause (#171) took 0.43s, 1.5× its usual 0.29s (p95 0.43s).
action: apply: accept this change now | defer | discard: drop the incoming change
```
- **Labels:** `{apply: 0.02, discard: 0.97, defer: 0.01}`, diagnosis `stale` (superseded intent: the user kept typing
  after this save started).
- **Costs:** apply 33.4, discard 28.6, defer 33.5. Parts: area 15.4 vs 9.4, latency 2.6 vs 1.3.
- **Verdict: correct.** The blind echo puts the older text back into the textarea, so it is "un-typed" until the next
  save lands. Defer does not help, because it applies the same stale echo a moment later. The fact list shows both the
  newer typing and the relation break.

### 4. Full-object settings echo reverting a just-ticked checkbox → discard / defer

`real-solid-settings-10013-d3`: SolidJS (`solid-js/html`), signals mirrored from `rt.atom`, `saveMode:blind`.
```
trigger: A write to prefs.productNews from PUT /api/docs/settings {theme: "system", density: "comfortable", +8} (#50) is about to be applied.
facts:
  prefs.productNews was written once by other operations since this write's cause (#50) started (version 0 → 1), last 0.43s ago by user changed checkbox "Product news" to "checked" (#52), which started 0.36s after #50, from a later user action (#52).
  prefs.productNews has a pending local change: user changed checkbox "Product news" to "checked" (#52) wrote it 0.43s ago and its PUT /api/docs/settings {…} (#53) is still in flight; …
  This write would change prefs.productNews: true → false.
in_flight: PUT /api/docs/settings {…} (#53) 0.43s so far, by #52
```
- **Labels:** `{apply: 0, discard: 0.72, defer: 0.28}`, diagnosis `stale` (the user changed `prefs.productNews` after
  this save started).
- **Costs:** apply 43.3, discard 23.7, defer 24.8 [paired futures agree].
- **Verdict: correct.** Applying unticks the box the user just ticked, and the next echo (#53) re-ticks it, so the UI
  flickers and, in two of three futures, ends wrong. Discard and defer are both good; the label keeps both
  (summed non-passive mass 1.0), which is exactly what the runtime's summed-mass gate is for.

### 5. Double submit from a button whose label became "Adding…" → block

`real-rtk-todos-10010-d0`: React + Redux Toolkit (`createAsyncThunk`, `genclassEnhancer`) + axios. `addGuard:none`.
```
trigger: POST /api/todos {title: "Call the vendor", done: false, +1} (#25) is about to be sent.
facts:
  1 identical POST /api/todos request in the last 10s: #22 in flight (started 0.06s ago); #22 started 0.06s before this one; they come from separate user actions 0.06s apart.
  This request comes from user submitted form (#24), started 0.00s ago.
  POST is not idempotent; its body (57 bytes) can be replayed.
timeline: … -0.06s user clicked button "Add" (#20) · user submitted form (#21) · start POST /api/todos (#22) · -0.00s user clicked button "Adding…" (#23) · user submitted form (#24) · start POST /api/todos (#25)
action: block | send | delay
```
- **Labels:** `{block: 1}`, diagnosis `duplicate` (the second click is the scripted accidental double click).
- **Costs:** send 79.7, delay 79.7, block 36.9. Parts: final server 56 vs 25 (one duplicate todo created), area
  14.8 vs 4.2.
- **Verdict: correct.** The button only changes its label while submitting, so the double click posts twice. Blocking
  costs one shown error episode: the app shows the 503, and the label still prefers it by 43. The runtime did not offer
  `coalesce` for this request; the next row shows an accidental double add where it did.

### 6. Accidental double "Add" in a shared cart → coalesce

`real-pinia-cart-10048-d3`: Vue + Pinia via `rt.guard`, server full-cart echo, budget 1,000.
```
trigger: POST /api/cart {name: "Croissants (4)", productId: 102, +2} (#25) is about to be sent.
facts:
  1 identical POST /api/cart request in the last 10s: #23 answered 201 0.02s ago; #23 started 0.12s before this one; they come from separate user actions 0.12s apart.
  This request comes from user clicked button "Add" (#24), started 0.00s ago.
action: send | coalesce | block
```
- **Labels:** `{coalesce: 1}`, diagnosis `duplicate`.
- **Costs:** send 94.7, coalesce 87.5, block 89.1. Parts: final server 31 vs 25 (the cart merges by product, so the
  duplicate raises the quantity to 2); block also costs a shown error.
- **Verdict: correct.** Coalesce reuses #23's 201 response, so the app is answered and the server sees one add.
  Block is close but shows an error. The intentional-repeat case (the same click twice, seconds apart, as separate
  intents) is labelled `send`. See the request rows with diagnosis `expected` in `stats.json`: 75% of request rows
  are passive-best.

### 7. Feed poll stuck behind a latency spike → hedge (soft)

`real-preact-likes-10200-d10`: Preact + `@preact/signals`, poll every 3 s.
```
trigger: GET /api/articles?sort=-likes&limit=5 (#53) has been waiting 3.58s for a response.
facts:
  The request #53 has been in flight for 3.58s; GET /api/articles usually takes 0.90s (p95 1.34s, 6 samples), 4.0× the median.
  3 identical GET /api/articles requests in the last 10s: … #63 in flight (started 0.58s ago); #63 started 3.00s after this one, neither from a user action.
  A cached 200 response from 5.33s ago exists for this request.
action: wait | hedge | serve_cached
```
- **Labels:** `{wait: 0.12, hedge: 0.76, serve_cached: 0.12}`, diagnosis `slow` (a latency spike on this request
  only).
- **Costs:** wait 13.06 [20.4, 7.7, 11.1], hedge 11.55 [18.1, 6.9, 9.7], serve_cached 12.94.
- **Verdict: correct, and soft by design.** Hedging wins in every future but by varying margins (the SE is large),
  so `τ = 0.1 + SE` keeps the label soft. A newer identical poll (#63) is already in flight, which is why waiting is
  not much worse.

### 8. Server echo leaves a maintained subtotal wrong → rollback

`real-pinia-cart-10184-d5`: Vue + Pinia. `totals:local-only` (bug: totals are not recomputed on the echo path).
```
trigger: The relation cart.subtotal == sum(cart.items[*].price * cart.items[*].qty) (and 1 more) no longer holds now that the app is settled.
facts:
  The learned relation cart.subtotal == sum(cart.items[*].price * cart.items[*].qty) no longer holds: cart.subtotal = 131, sum(…) = 103.8. It held at 17 settled points before.
  The last consistent state is 1.91s old; 2 field writes happened since.
  cart.items was written 0.06s ago by GET /api/cart (#61): 5 items, 1 changed: {id: 2, qty: 9 → 2, …}.
action: ignore | rollback
```
- **Labels:** `{rollback: 1}`, diagnosis `inconsistent`. The manifest declares `subtotal = Σ price·qty`, it is
  broken now, and the flagged relation names its derived field.
- **Costs:** ignore 73.1, rollback 68.7. Parts: relation-violation seconds 9.5 vs 0.6; area slightly higher for
  rollback.
- **Verdict: correct.** Rollback restores the last consistent snapshot (older items, matching total). That cuts the
  relation-violation time from 9.5 s to 0.6 s at a small cost in divergence. This app registers no `resync` handler,
  so `resync` is not offered.

### 9. Clean run, coincidental learned invariant → ignore

`real-svelte-chat-10001-d0`: Svelte 5, **clean** run (calm network, every flag at its correct default, no accidental
clicks).
```
trigger: The relation chat.messages[*].text unique no longer holds now that the app is settled.
facts:
  The learned relation chat.messages[*].text unique no longer holds: chat.messages[*].text has duplicates. It held at 3 settled points before.
  chat.messages was written 0.06s ago by POST /api/messages {…} (#58): 9 items, 1 changed: {pending: true → undefined, id: undefined → 527083, …}
  chat.messages was written 0.13s ago by user submitted form (#57) (user): 8 → 9 items: added {channel: "general", author: "me", +3}.
action: rollback | ignore
```
- **Labels:** `{ignore: 1}`, diagnosis `expected`. Another user posted the same text; the ids are distinct, so this
  is not a duplicate.
- **Costs:** ignore 5.67, rollback 8.62.
- **Verdict: correct.** Learned uniqueness over free text is a coincidence. Across the pilot, rollback on
  passive-best inconsistency rows costs +16 on average: coincidental invariants are where a model that acts too
  eagerly would do the most damage.

### 10. Svelte 5 `each_key_duplicate` after a response+push duplicate → ignore

`real-svelte-chat-10015-d21`: Svelte 5. `dedupe:none` (bug: the WebSocket push of my own message is appended next to
the POST response, with the same id).
```
trigger: An uncaught Error was thrown: https://svelte.dev/e/each_key_duplicate
facts:
  Uncaught Error: https://svelte.dev/e/each_key_duplicate (at bundle.js:360).
  Its chain wrote chat.draft before the error.
  The same error happened 16 times in the last 10s.
  It was thrown while user typed "PR i" into input "Message" (#51) was active, 0.00s after it started.
action: ignore | rollback
```
- **Labels:** `{ignore: 1}`, diagnosis `duplicate`. The rendered state holds the same message id twice, which a
  generic structural check over the stores catches.
- **Costs:** ignore 4.13, rollback 5.17. Rolling back `chat.draft` (what this chain wrote) does not remove the
  duplicate, and it throws again.
- **Verdict: correct.** This is a real framework error the sim cannot produce: every keystroke re-renders the keyed
  list and throws. The right fix is upstream: discard the duplicate push write. The pilot has 8 mutation rows
  labelled `duplicate` with `discard` best.

### 11. Live push while my move is pending, different card → apply

`real-zustand-board-10022-d1`: React + Zustand (`genclass` middleware) + WebSocket, calm.
```
trigger: A write to board.cards from WS message app.example.com/ws/cards (#9) is about to be applied.
facts:
  board.cards has a pending local change: user clicked button "Move Login page redesign right" (#7) wrote it 0.05s ago and its PATCH /api/cards/:id {column: "doing"} (#8) is still in flight; …
  This write would change board.cards: 10 → 11 items: added {id: 866561, +6}.
in_flight: PATCH /api/cards/:id {column: "doing"} (#8) 0.05s so far, by #7
```
- **Labels:** `{apply: 0.85, defer: 0.15}`, diagnosis `expected`. A teammate created a different card, so the push
  does not touch the card the user is moving.
- **Costs:** apply 5.66, discard 12.67, defer 5.58 (a tie, pinned to passive).
- **Verdict: correct.** The diagnosis is element-aware: the harness compares which list elements, by id, the user's
  write and the incoming write change. Before that fix, any push into a list with a pending local edit was labelled
  `conflict`.

### 12. Gray case: a poll that is outdated on delivery → defer, diagnosis expected

`real-alpine-tasks-10031-d0`: Alpine.js store mirrored from `rt.atom`, calm.
```
trigger: A write to tasks.items, tasks.remaining from GET /api/tasks?project=work (#26) is about to be applied.
facts:
  tasks.items has a pending local change: user submitted form (#23) wrote it 0.09s ago and its PATCH /api/tasks/:id {title: …, version: 4} (#24) is still in flight; …
  This write would change tasks.items: 7 → 8 items: added {id: 4104, +6} and 1 more; removed 1 item.
```
- **Labels:** `{defer: 1}`, diagnosis `expected`.
- **Costs:** apply 12.7, discard 12.7, defer 2.9.
- **Diagnosis trace:** `tasks.items: user writes 4, overlapping 0`; `tasks.remaining: pending PATCH committed at
  6026, read at 6032`.
- **Verdict: gray.** The user's edit and the poll touch different tasks, and the poll was read after the PATCH
  committed, so there is no stale overwrite. A teammate changed two tasks between the poll's read (6032) and its
  delivery (6070). Applying shows that outdated list for one poll interval, while deferring until the PATCH settles
  lets the fresher list win. The action label is a real outcome but depends on information absent from the
  situation. The diagnosis stays `expected` because the situation gives the model no way to know. The runtime's gate
  (a non-passive action needs a non-`expected` diagnosis) keeps such a row from firing in production. TRAIN may want
  to down-weight rows with `diagnosis == expected` and a sharp non-passive label; they are about 4% of mutation rows.

### 13. Developer question (ask row)

`real-rtk-todos-10020-a2`. The situation is `runtime.situation("ask")`. Questions and exact answers come from the
sim's generators (`sim/src/ask/questions.ts`) with harness facts:
```
q_last_failed (choice): Which endpoint failed most recently?  [e1: GET /api/todos | e2: PATCH /api/todos/:id | e3: POST /api/todos | none: nothing failed recently]   → none
q_recent_failure (noul): Has any request failed in the last 10 seconds?                                                                                              → 0
q_write_inflight (noul): Is the app currently waiting on a request that changes data on the server?                                                                    → 0
```

---

### Runtime finding (no row): v1 write holds break a real Redux app

The open-source gothinkster `react-redux-realworld-example-app` (React 16, Redux 3, promise middleware), with
`genclassEnhancer` on its store, **never renders its home feed when GenClass runs in guard or heal mode**. This
happens on calm, clean runs where the recording decider answers `apply` to every decision. In observe mode it works.

Holding the `APP_LOAD` dispatch for about 10 ms reorders it against the app's other dispatches. The middleware then
drops results because `viewChangeCounter` changed.

`debug.js --interference` measures this class of problem: the same scenario in observe mode versus heal mode with an
all-passive model. On situation-v1, 6 of 78 clean runs changed:
- this app, 3 of 3;
- pinia-cart, 1 of 3;
- svelte-inventory, 2 of 3. In both of these, held requests shift timing and change the final server state.

The finding was reported to the coordinator for CORE's situation-v2, which drops write holds by default.
