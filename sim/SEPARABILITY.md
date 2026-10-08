# Separability: clear actionable rows vs benign look-alikes

SIM, 2026-10-08. Question from the lead: R17 is precise (guard FIR 0.05 %, heal FIR 0.24 %, ECE ≈ 0.01) but recalls
only 6–8 % of clear stale/duplicate rows, and R32 is no better. Is that missing **information** (and which facts
would add it) or **labels that depend on an unpredictable future** (and which label/cost changes fix that)?

## 1. Bottom line

1. **The ceiling comes from the data.** On phase A (what R17 trained on), a plain linear model on the visible
   situation text reaches **AUC 0.70–0.88** for clear vs benign, but only **5–20 % recall at a 1 % false-intervention
   rate** (§2). That is the same band as R17. Of the clear rows, **62–82 % have a benign row with the identical
   canonical fact set** at the request, failure, inconsistency and transition triggers. A calibrated model cannot be
   sure on these rows, so it stays timid.
2. **A quarter of the clear rows cannot fire by construction.** 6,532 of 26,822 clear rows (24 %) carry the gold
   diagnosis `expected` (65 % at inconsistency, 40 % at request, 27 % at mutation). The §8 gate never fires on
   `expected`, and these rows teach "expected, but act". The probe run shows what they are: in 89 % of them the
   client was already wrong before the decision (§4.4), and the action repairs it incidentally. This is a SIM labelling bug
   (S1).
3. **Facts the runtime can compute now help, but modestly.** With sim-measured versions of the proposed facts added,
   recall at 1 % FIR rises from 16 % to 27 % at mutation (gradient-boosted trees; AUC 0.834 → 0.916), from 5.6 % to
   9.4 % at failure, from 8.0 % to 9.4 % at request, and from 1.8 % to 9.1 % at stall (n = 55). The single strongest facts are cell-level "this reverts a value a newer operation set"
   (4× the clear rate), "this overwrites text the user typed after the request started" (3.5×) and "this changes
   nothing" (7× lower). These are proposals F1–F3 for situation v2.
4. **Most of the remaining gap is hidden state or the future, and the labels treat it as certain.** Even an oracle
   that also sees the hidden state at decision time and the probed future reaches only 18 % (failure, request) to
   44 % (mutation) recall at 1 % FIR. The
   reason is that the K = 3 paired futures re-draw only network and timing randomness. They do **not** re-draw:
   - what the user does next (the session steps are fixed per seed);
   - how long an outage or offline window lasts once it has started;
   - latent state that the client has not observed (whether a failed write committed, whether a repeat click was
     accidental).

   So a label is "clear" in hindsight while being a coin flip given the situation (pair P3: two identical situations,
   one with a random network error and one with an outage).
5. **The largest lever is the decision target, not the facts.** Hindsight-best labels teach P(best action). For
   cheap actions with a large upside (retrying an idempotent GET, serving a cached value), P(best) is below 0.5 almost
   everywhere, while the **expected** gain is clearly positive. On the same visible-text scores (§5):
   - **P(best) ≥ 0.5** fires on 0 % of failure, mutation, inconsistency and stall rows.
   - **E[gain] > 2** captures 29 % (failure), 33 % (request) and 17 % (stall) of the oracle's total gain. The fired
     action loses more than 1 cost unit on only 0.2–2.3 % of rows.

   TRAIN can train an expected-advantage head today from `meta.cost_futures`, with no new data (T1).

**Top proposals.** In order of expected impact on recall at fixed harm:
- **T1 (TRAIN)**: gate on expected advantage.
- **S1 (SIM)**: no `expected` diagnosis on rows where acting clearly wins.
- **S2 (SIM)**: the futures also re-draw the hidden and future variables a runtime cannot observe, so each label is
  the expected cost given what is observable.
- **F1–F3 and F9 (CORE, situation v2)**:
  - cell-level revert of newer data;
  - user-typed-text overwrite with a diff-centred preview;
  - "no change";
  - provenance of known-stale values.
- **F5–F8 (CORE)**: smaller, cheap additions.

Details follow in §6–7.

## 2. Data and definitions

- **Rows.**
  - Phase A, as trained on by TRAIN: `train:/data/sim-out/final-a/`, 389,393 decision rows (ask and diagnosis-only
    rows excluded).
  - Probe run for this analysis: 150,540 rows (98,035 decision rows), `train:/data/sim-out/probe-150k/`. It uses the
    46-feature program space and the situation-v1 runtime, with `SIM_PROBE=1`, so `meta.probe` holds sim-only hidden
    facts (`sim/src/oracle/probe.ts`). It is not training data.
- **Classes.** Each future's cost of an action includes the tier premium (0.25 for guard, 0.5 for heal), exactly as
  in the label.
  - **Clear**: the best non-passive action beats passive by ≥ 2 on average, wins in every future, and is the same
    action in every future.
  - **Benign**: passive is best in every future.
  - **Mild**: everything else.
- **Look-alike.** Two rows are look-alikes when they have the same trigger template and the same set of canonical
  fact templates. Canonical means strings, numbers, `#ids`, URLs and store keys are abstracted (`separability.py`).
- **Classifier.** Logistic regression on hashed uni- and bigrams of the canonical situation text, with numbers
  bucketed by log2 and status codes kept exact. Train/test split by trajectory seed, 70/30. Recall is measured at
  the score that fires on 1 % (or 0.5 %) of benign test rows. The nonlinear check uses gradient-boosted trees on the
  out-of-fold text score plus the probe values (`separability_gbdt.py`).

**Phase A, per trigger.** "Twin" = share of clear rows that have a benign look-alike. "`expected`" = share of clear
rows whose gold diagnosis is `expected`.

| trigger | rows | clear | benign | mild | twin | linear AUC | recall @ 1 % / 0.5 % FIR | `expected` |
|---|---|---|---|---|---|---|---|---|
| failure | 88,076 | 9,408 | 57,670 | 20,998 | 72 % | 0.865 | 9.2 % / 5.9 % | 0 % |
| request | 103,330 | 7,855 | 68,371 | 27,104 | 82 % | 0.869 | 20.4 % / 14.6 % | 40 % |
| mutation | 140,119 | 5,439 | 121,520 | 13,160 | 20 % | 0.877 | 15.9 % / 8.3 % | 27 % |
| inconsistency | 33,149 | 2,802 | 26,911 | 3,436 | 62 % | 0.754 | 12.8 % / 7.5 % | 65 % |
| stall | 10,327 | 679 | 5,932 | 3,716 | 51 % | 0.771 | 4.7 % / 2.6 % | 0 % |
| transition | 11,200 | 617 | 9,313 | 1,270 | 76 % | 0.698 | 4.9 % / 0.5 % | 22 % |

**Largest clear groups** (gold diagnosis / best action). "Twin" = share with a benign look-alike. The last column
is the cost part that makes the action win (best action minus passive, in cost units, from `meta.cost_parts`).

| group | clear rows | twin | where the gain comes from |
|---|---|---|---|
| failure transient/retry | 6,003 | 85 % | server −8.1 (the write lands), area −4.5, errors −1.0 |
| request duplicate/coalesce | 3,119 | 90 % | server −13.8 (no duplicate item / counter), area −4.0 |
| request expected/coalesce | 2,120 | 87 % | server −5.9, area −2.1 |
| mutation stale/discard | 1,572 | 13 % | area −4.7, server −3.2, final client −1.2 |
| failure failing/retry | 1,185 | 51 % | server −8.9, area −2.4 |
| mutation expected/discard | 1,192 | 16 % | area −4.0, final client −1.3, server −1.2 |
| inconsistency expected/resync | 1,118 | 65 % | area −4.9, final client −1.8 |
| failure transient + failing/serve_cached | 2,088 | 31–61 % | area −3.8 to −4.4, errors −0.8 to −1.2 |
| inconsistency expected/rollback | 704 | 78 % | area −4.1, server −2.8 |
| mutation duplicate/discard | 694 | 28 % | area −4.2, server −2.2 |
| request expected/block + duplicate/block | 1,368 | 85–87 % | server −6 to −11, errors +1.2 |

**Probe run (46 features).** The programs are more diverse, so look-alikes are rarer, but the picture is the same.

| trigger | clear / benign / mild | twin | linear: visible | + facts computable now | + latent/future |
|---|---|---|---|---|---|
| mutation | 1,292 / 27,871 / 2,667 | 8 % | AUC 0.846, 17.7 % | 0.885, **23.7 %** | 0.912, 34.9 % |
| failure | 2,232 / 17,410 / 6,030 | 40 % | 0.846, 5.9 % | 0.852, 8.2 % | 0.889, 10.5 % |
| failure (trees) | | | 0.834, 5.6 % | 0.850, **9.4 %** | 0.911, 18.1 % |
| mutation (trees) | | | 0.834, 16.0 % | 0.916, **27.0 %** | 0.944, 44.0 % |
| request | 1,498 / 15,580 / 7,650 | 48 % | 0.793, 11.4 % | 0.792, 11.2 % | 0.807, 12.3 % |
| request (trees) | | | 0.775, 8.0 % | 0.793, 9.4 % | 0.826, 18.5 % |
| inconsistency | 653 / 8,042 / 1,009 | 42 % | 0.729, 10.2 % | (no probe) | 0.846, 11.4 % |
| stall | 209 / 1,333 / 814 | 31 % | 0.699, 10.9 % | 0.814, **14.5 %** | 0.812, 12.7 % |
| stall (trees) | | | 0.580, 1.8 % | 0.753, 9.1 % | 0.788, 16.4 % |
| transition | 157 / 2,852 / 341 | 43 % | 0.637, 8.0 % | 0.638, 8.0 % | 0.719, 10.0 % |

Recall is at 1 % FIR. "Trees" rows use gradient-boosted trees on the out-of-fold text score plus the probe values;
the other rows are the linear model. "Computable now" means the `n_*` probes: cell-level diff and provenance of the write, user
edits since the request, duplicate ids, periodic-refresh period, the app's own earlier retries, the observable gap
between repeated user actions, and background vs user-initiated. "Latent/future" means the `l_*` probes:
- hidden user intent (accidental repeat);
- whether a failed request committed;
- the failure's cause, and whether the outage is still on 1 s and 5 s later;
- whether the app or the user retries later;
- whether the same cells are overwritten again within 10 s;
- how far the client already is from the ideal state at decision time.

## 3. Concrete pairs: same facts, opposite labels

Each pair is a clear actionable row (best non-passive action wins by ≥ 2 in every future) and its nearest benign row
(passive best in every future) with the **same canonical fact set** (strings, numbers, ids and paths abstracted),
from phase A (`/data/sim-out/sep/a/pairs_full.jsonl`). "Why" comes from the sim's knowledge of both runs.

**P1. Repeated vote, request trigger (`duplicate/coalesce` vs passive).**
`sim-10030877-d20`: `POST /api/v1/videos/:id/like {}` with the fact "3 identical … requests in the last 10s … they
come from separate user actions 0.08s apart"; coalesce wins by 9.3 (one server like instead of two: −6 server
field, −2.3 area). `sim-10006586-d36`: `POST /api/players/:id/vote {}`, the same facts with "0.27s apart";
coalescing gains nothing. Why: the first user's second click was an accidental double click (the sim's user model
fires those 45–190 ms after the first), the second user meant to vote twice. **(b) hidden user intent**, with an
observable proxy the model has to read off a number (0.08 vs 0.27 s). A runtime can add evidence (§6 F7): both clicks
on the same element, the click interval in the browser's double-click window (`MouseEvent.detail = 2`), whether the
app showed a busy indicator when the user clicked again.

**P2. Accidental toggle-back labelled `expected` (request trigger, `expected/block`).**
`sim-10011594-d31`: the user clicks "Feature drive" twice (0.18 s apart); the second click sends
`PATCH {featured: false}` right after `PATCH {featured: true}`. The second click was accidental, so `block` wins by
3.4, but the request bodies differ, so SIM's duplicate rule (identical requests) labels it `expected`. **SIM label
bug** (§7 S1): the production gate never fires on an `expected` diagnosis, and the row teaches "expected + act".

**P3. Initial load fails with a network error (failure trigger, `transient/retry`).**
`sim-10084029-d0` and `sim-10020234-d0` have **identical** situations (Jaccard 1.0 over canonical tokens): `GET
/api/<list>` failed (network error) 0.2–0.8 s into the page, first failure, no history. Retrying wins by 19 in the
first (chaos regime `flaky`: a random network error, the retry succeeds and the page fills in seconds earlier, −14.8
area). In the second (regime `degraded`, where outage windows are common) the retry changes nothing except a
wasted request (+0.08). **(b) unpredictable future** (whether
the failure persists); nothing observable separates them. Retry of an idempotent GET costs 0.08 when useless, so the
expected gain is large and positive, yet "is retry the best action?" is a coin flip: §5 shows this is exactly where
probability-of-best labels make the model timid.

**P4. Rollback after a failed toggle (mutation trigger, `expected/discard`).**
`sim-10093044-d11` vs `sim-10093044-d7` (same session): the app rolls back an optimistic toggle because
`POST /shipments/:id/toggle` failed. Identical facts except the status: **500** in the clear row, **502** in the
benign one. In the sim a 500 on a write may come after the server committed (the network's `postCommitP`), a 502/503
never does; the costs show this 500 had committed, so the rollback makes the client disagree with the server
(discard wins by 3.2), while after the 502 the rollback is right. **(b) hidden server state with a partial observable** (status
class, failure time vs usual latency); a runtime can state the ambiguity explicitly (§6 F5). The row is also labelled
`expected`, which the gate cannot act on (§7 S1).

**P5. Autosave response over newer typing (mutation trigger, `stale/discard`).**
`sim-10079144-d30` (discard wins by 20.6: lost characters, a stale server copy, an error banner) vs `sim-10098619-d2`
(all actions within 0.3): both "write … from PUT/PATCH … (#N); X was written twice by other operations since …, last
0.08s ago by user typed …". The fact "This write would change pageDoc.name: \"Guild page sword shield…\" →
\"Guild page sword shield…\"" shows two identical prefixes: the truncated preview hides the change (the last
characters the user typed). The cost differs because in the first app saves run on an interval (the clobbered text
stays and the next save persists it) and in the second saves are debounced (a newer save is already due and its echo
restores the text within 0.3 s). **(a) computable now**: a diff-centred preview ("would remove 'ket lib' typed by the
user 0.25 s ago"), "overwrites input the user typed after this request started", and the learned save cadence of the
endpoint (§6 F1, F3, F6). The remaining part (how long the clobber lasts) is **(b)**.

**P6. Learned "names unique" relation broken after create + refetch (inconsistency trigger, `expected/resync`).**
`sim-10100419-d0` (resync wins by 12.9) vs `sim-10070951-d0` (passive best), identical canonical facts: POST creates
an item, the app removes its optimistic copy, a refetch adds the server copy, and the learned relation
"`lists.hits[*].name` unique" breaks. The passive cost already differs before anything is decided (15.6 vs 0.6): in
the first the client state is wrong at the decision (the refetch answered 1.28 s later with a list that does not
match the server's), in the second the two items really share a name (the ideal state breaks the relation too).
**Mostly (b) hidden divergence**, partly **(a)**: a read-your-writes check ("this list response does not contain the
item POST #45 created 1.3 s ago" / "contains it twice") is computable from the two responses (§6 F4); the broken
relation itself carries no signal.

**P7. Spurious relation at the inconsistency trigger.** `sim-10005232-d5` vs `sim-10073890-d4`: the trigger is the
learned relation "`tally.approved ∈ items[*].days`" (a coincidence of small integers). Both are `expected` by sim
knowledge. Resync wins by 6.8 in the first because the client is already wrong for a different reason (passive cost
21.7 vs 13.8; that app's push handler applies without version checks and recomputes counts partially), invisible in
the facts, which only talk about the spurious relation. **(a)**: count-by-group relations ("`counts.k` = number of
items with `lane = k`") would flag the real defect; ∈-relations between unrelated small integers are noise (§6 F8).

## 4. What the hidden facts show

Probe run, all decision rows of the trigger. The tables give the share of rows that are clear and benign under each
condition (`separability_extra.py`, full tables in `train:/data/sim-out/sep/p150-extra.md`).

### 4.1 Mutation (write about to be applied): computable-now facts carry real signal

| condition (computable now unless marked) | rows | clear | benign |
|---|---|---|---|
| write sets a cell (item field) that a **newer** operation set, `n_revert_newer > 0` | 5,971 | **10.3 %** | 71.9 % |
| … no such cell | 25,859 | 2.6 % | 91.2 % |
| write overwrites cells the **user edited after the request started** | 1,686 | **12.6 %** | 62.4 % |
| … no | 30,144 | 3.6 % | 89.0 % |
| write is a **no-op** at cell level | 1,628 | **0.6 %** | 93.7 % |
| periodic refresh of the source observed, next one due in ≤ 1 s | 1,926 | 2.1 % | 87.2 % |
| … next one due in 3–10 s | 966 | 12.4 % | 70.1 % |
| (future) the same cells are rewritten again within 0.5 s | 10,749 | 2.8 % | 87.9 % |
| (future) … not within 10 s | 5,084 | 8.0 % | 86.1 % |
| adds an item whose id or content is already in the list | 2,341 | 0–5 % | 77–97 % |

V1 states conflicts per store field ("X was written twice by other operations since …"). It does not say whether
*this* write touches the same item and field the newer operation changed, or whether it puts back the older value.
Its change previews truncate both values from the left, so a write that removes the last characters the user typed
shows as `"Guild page sword shield…" → "Guild page sword shield…"` (pair P5). Duplicate ids at write level do not
separate the classes (the duplicate diagnosis comes from repeated requests, §4.3).

### 4.2 Failure: persistence decides, and it is mostly hidden at the first failure

| condition | rows | clear | benign |
|---|---|---|---|
| (hidden) cause = random 5xx / random network error | 10,369 | 14.2–14.9 % | 54 % |
| (hidden) cause = outage / offline window | 10,187 | 4.2–5.2 % | 77–80 % |
| (hidden) outage still on 1 s later | 8,292 | 3.6 % | 80.5 % |
| … not | 17,380 | 11.1 % | 61.8 % |
| (hidden) failed write committed on the server | 4,268 | 4.9 % | 77.6 % |
| … did not commit | 10,644 | 6.0 % | 80.8 % |
| (observable) user-initiated | 15,735 | 11.2 % | 59.1 % |
| … background (poll, timer) | 9,937 | 4.7 % | 81.6 % |
| (observable) the app retried earlier failures of this endpoint itself | 2,796 | 9.7 % | 56.8 % |

Whether a failed write committed matters far less than expected: 4.9 % vs 6.0 % clear. What matters is whether
the failure persists, which the paired futures do not re-draw (S2). The observable proxies are cross-endpoint
failure bursts (several endpoints failing in the same seconds point to an outage), offline state, and the streak.
The model sees the streak and the per-endpoint error rate today, but not failures of *other* endpoints (F5).

### 4.3 Request: repeated actions hinge on hidden intent

| non-GET request repeating an identical earlier one from another user action | rows | clear | benign |
|---|---|---|---|
| (hidden) the repeat was accidental (double click, impatient re-click) | 2,118 | 21.2 % | 41.4 % |
| (hidden) intended | 5,343 | 7.9 % | 64.4 % |
| (observable) ≤ 0.2 s between the two user actions | 2,593 | 16.9 % | 52.8 % |
| (observable) 0.2–5 s | 4,591 | 8.2–9.5 % | 54–65 % |
| ≤ 0.2 s and accidental / ≤ 0.2 s and intended | 1,254 / 1,339 | 23.9 % / 10.2 % | 44 % / 61 % |

Inside look-alike sets, 52.8 % of clear rows are accidental repeats against 20.5 % of benign rows. The observable
gap already appears in the facts ("… 0.08s apart") and carries part of that signal. Even when the hidden intent is
known, only 21 % of accidental repeats are clear: whether a repeat does damage also depends on the endpoint (an
increment vs an idempotent set, server-side dedupe), which the runtime cannot see. Hidden intent is the textbook
case for S2 (marginalise the label over the intent posterior) and T1.

### 4.4 Inconsistency and transition: the client was already wrong, and nothing says so

| client divergence from the ideal at decision time (hidden) | inconsistency clear / benign | transition clear / benign |
|---|---|---|
| 0 (client is right) | **0.4 %** / 96.6 % (4,802 rows) | 0.5 % / 96.5 % (1,072) |
| 0.25–1 | 12.5 % / 71.8 % (2,191) | 7.2 % / 79.4 % (778) |
| > 1 | 16.2 % / 63.6 % (2,173) | 7.9 % / 77.0 % (1,196) |

The inconsistency trigger fires on learned relations. Many of these are spurious, for example
`tally.approved ∈ items[*].days` or `revision == goalsTable.offset`. Resync and rollback win when the client
happens to be wrong for another reason, which the facts never mention (pairs P6, P7).

Clear rows labelled `expected`, probe run:
- inconsistency: 348 of 653; the client was already diverged in 327 of them;
- mutation: 357 of 1,292; diverged in 296;
- request: 488 of 1,498; diverged in 437;
- transition: 74 of 157; diverged in 71.

The action repairs a divergence that existed before the decision, and SIM's diagnosis rules, which look only at
the subject, call it `expected`.

## 5. Expected advantage vs probability of being best

Held-out phase-A rows of all classes, binned into 40 quantiles of the visible-text linear score (a stand-in for
what a model can know from the situation). Within a bin:
- **P(best) ≥ 0.5** fires the action most often best when that share is ≥ 0.5. Hindsight-best labels with a
  calibrated model teach this rule.
- **E[gain] > m** fires the action with the highest mean gain when that mean exceeds m, where
  gain = passive cost − action cost − tier premium, averaged over futures.

Columns: "recall" is the share of clear rows fired with their best action; "benign fired" is the share of benign
rows fired; "harmful" is the share of all rows where the fired action loses more than 1 cost unit; "gain" is the
share of the oracle's total gain captured.

| trigger | rule | recall | benign fired | harmful | gain |
|---|---|---|---|---|---|
| failure | P(best) ≥ 0.5 | 0 % | 0 % | 0 % | 0 % |
| failure | E[gain] > 2 | **35.4 %** | 7.7 % | 2.3 % | **28.7 %** |
| failure | E[gain] > 4 | 14.4 % | 2.6 % | 0.8 % | 13.4 % |
| request | P(best) ≥ 0.5 | 16.0 % | 0.7 % | 0.25 % | 24.8 % |
| request | E[gain] > 2 | **25.2 %** | 2.0 % | 0.7 % | **33.3 %** |
| mutation | P(best) ≥ 0.5 | 0 % | 0 % | 0 % | 0 % |
| mutation | E[gain] > 1 | 18.3 % | 1.3 % | 0.5 % | 7.9 % |
| stall | P(best) ≥ 0.5 | 0 % | 0 % | 0 % | 0 % |
| stall | E[gain] > 2 | 15.3 % | 2.4 % | 0.2 % | 17.4 % |
| inconsistency | E[gain] > 1 | 7.4 % | 1.1 % | 0.4 % | 5.8 % |

The probe run gives the same pattern. For example, at mutation, E[gain] > 1 has 19.4 % recall, 1.2 % benign
fired and 0.4 % harmful, while P(best) ≥ 0.5 fires on nothing.

The asymmetry is the point. Retrying a failed idempotent GET gains about 14 when the failure was random and costs
0.08 when it was not. Serving a cached value during a stall saves seconds of spinner and costs little when the
response would have come anyway. "Is this action best?" is a coin flip on these rows, but "is it worth doing?" is
clearly yes. Most of the "benign fired" rows here are harmless (gain between −1 and 0): a useless retry or a cached
value that equals the fresh one. A false-intervention metric that counts them as failures will always push the
model towards timidity, so harm (cost) is the better product metric.

## 6. Fact proposals for CORE (situation v2)

V2 decides at `delivery`. The response body is known, the app's write is not yet, and the predicted write set P is.
So these are phrased as **response content vs current state** for the paths in P. They are given in order of
measured effect, and they fit in the room CORE left (≤ 12 facts; delivery situations use 4–6 today).

- **F1. Cell-level revert of newer data (measured: 4× the clear rate).** For each conflicting path, join the
  response's items to the current items by id and compare values. State whether the response would put back the
  value a newer operation replaced, or set a third value. Example: "The response has `status: open` for card
  `car_7l…`; the store has `closed`, set 0.03 s ago by WS message #96, which started after this request." Also
  state when the conflict is on a different item than the one the newer operation touched: "the newer write changed
  only card `car_3x…`; this response's copy of it equals the store". This turns "the field was written twice since"
  into "this would undo X".
- **F2. Overwrite of user input with a diff-centred preview (measured: 3.5×).** "The response would replace
  'ket lib' (7 characters the user typed after this request started; last keystroke 0.08 s ago, still typing)."
  Previews should centre on the first differing position instead of truncating both sides to the same prefix.
- **F3. No change (measured: 7× lower clear rate).** "The response matches the current values of everything it is
  predicted to write." This should also make the delivery non-salient, which saves the model call.
- **F9. Provenance of known-stale values (the hidden divergence of §4.4).** Record when a value was written by a
  delivery or write that the runtime knew was suspicious:
  - delivered despite a newer-data conflict;
  - written by a response that took more than 5× its usual time;
  - written by a failed chain's rollback whose request returned 500 or a network error after the usual server time
    (it may have been applied, see F5);
  - written by a push received while the live channel had been down.

  Then state it when a later decision involves that path: "`board.counts` was last written by a response that
  overwrote newer data (3.2 s ago; not resynced since)". This is the only computable route to the "client already
  wrong" signal that drives inconsistency, transition, and the clear rows labelled `expected`.
- **F6. Learned refresh and save cadence of the source (measured: clear 2.1 % when the next refresh is ≤ 1 s away
  vs 12.4 % when it is 3–10 s away).** "GET /x refreshes this data every 5.0 s (next expected in 0.4 s)", and for
  writes, "this endpoint saves on an interval / after typing pauses". This tells the model whether a stale value
  will heal by itself.
- **F5. Failure scope and commit ambiguity.**
  - Scope: "3 of the last 4 requests to this origin failed in the last 5 s (2 endpoints)" (outage vs random) and
    "the device went offline 2.1 s ago". Persistence is what separates failure rows, and today the facts are
    per-endpoint only.
  - Commit ambiguity: "this POST failed with 500 after 0.63 s (usual 0.54 s), so it may have been applied" vs "502
    from the gateway / network error before the upload finished: not applied". Measured effect is small, but cheap.
- **F7. Repeat-action evidence.**
  - The second click happened within the double-click interval on the same element (`MouseEvent.detail = 2`).
  - The page showed a busy indicator from the first action when the user clicked again (impatience).
  - The UI counted both clicks (`count 33 → 34 → 35`).
- **F8. Relation quality.**
  - Do not learn ∈ or == relations between unrelated small integers or version counters. Examples seen in facts:
    `tally.approved ∈ items[*].days`, `revision == goalsTable.offset`, `rev ∈ data[*].version`.
  - Do learn count-by-group relations (`counts.k = #items with lane = k`), which catch the real counter defects.

  Spurious relations appear as facts in mutation situations too ("Applying this write would break the learned
  relation …"), and there they are noise.
- **Read-your-writes (not probed).** "This list response does not contain item `weekend`, which POST #45 created
  1.3 s ago (201)" or "contains it twice". This is computable from the two responses and would decide pair P6.

## 7. Label, cost and training proposals

- **T1 (TRAIN, no new data). Expected-advantage target and gate.** Add a per-action regression head on the
  clipped gain from `meta.cost_futures`: passive cost − action cost − premium, mean over futures, clipped to
  ±30, so its prediction is E[gain | situation]. Fire when the predicted gain exceeds a tier margin. Keep the choice
  head for display and diagnosis. Evaluate on harm (realised cost of fired actions) and on gain captured, next to
  FIR. §5 shows that on the same information this rule captures 8–33 % of the available gain where P(best) ≥ 0.5
  captures 0–25 %.
- **S1 (SIM). Diagnosis consistent with the action label.**
  - When a non-passive action wins clearly because it repairs a divergence that existed before the decision
    (`l_div_now > 0`), label the diagnosis by that divergence's cause (`stale`, `inconsistent`, `duplicate`), not
    `expected`.
  - Label accidental repeats with different bodies (toggle-back, pair P2) `duplicate`.

  This removes 24 % of the clear rows from the unfireable set. It goes into the v2 generator.
- **S2 (SIM). Futures that re-draw what a runtime cannot observe.** Today's three paired futures re-draw network
  and timing randomness only. Add:
  - **(i)** the user's own next steps: timing jitter, plus the session model's alternative next actions, in both the
    real and the ideal run;
  - **(ii)** the remaining length of an outage, offline or slow window that has already started (re-drawn from the
    regime's prior conditional on its elapsed time);
  - **(iii)** unobserved prefix latents, drawn from their posterior given the observable:
    - for an ambiguous failed write, whether it committed (server-only, so the client prefix stays identical);
    - for a repeat action, accidental vs intended (only the ideal run changes).

  Labels then become expected costs given the situation, the SE is larger exactly where the outcome is uncertain,
  and τ = 0.1 + SE keeps clear cases sharp. Cost: about 1.3× generation time (the extra ideal runs are cheap).
- **S3 (SIM, minor). Credit immediate wrongness.** For delivery and mutation decisions, split the area term into
  the divergence the write creates in the first 0.5 s, which is decidable from the facts, and the rest. This matters
  only if TRAIN wants a "harm now" signal that does not depend on when the next refresh lands. Lower priority than
  S2.
- **What not to change.** The horizon (10 s area, 15 s final) is not the problem. The mutation rows whose cells are
  rewritten within 0.5 s are mostly benign (2.8 % clear), and a shorter horizon would only relabel slow-healing
  clobbers as benign.

## 8. Reproduce

All of this runs on the train VM from `~/gcl/sim`. Outputs are in `/data/sim-out/sep/`.

```
python3 sim/scripts/separability.py /data/sim-out/final-a/{train,dev,test}.jsonl --out /data/sim-out/sep/a   # stage 1 + pairs
~/jev/.venv/bin/python sim/scripts/separability_probe.py <rows> --out <dir>      # classifiers, probes, §5 policies
python3 sim/scripts/separability_extra.py <probe rows>                         # §4 tables
~/jev/.venv/bin/python sim/scripts/separability_gbdt.py <probe rows>            # nonlinear check
SIM_PROBE=1 node sim/dist/gen.js --rows 150000 --out out/probe-150k --seed 7100000000 --workers 44   # probe rows
```

`SIM_PROBE` is analysis-only. It records the `meta.probe` facts (cell-level write diffs and provenance, hidden
intent, commit, outage, post-run overwrite and redo, and client divergence at decision time), and it never changes
labels or runtime behaviour. Run with thread caps (`OMP_NUM_THREADS=2`) on the shared VM.
