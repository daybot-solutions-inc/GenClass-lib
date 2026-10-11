---
name: False flag or false intervention
about: GenClass flagged, or acted on, code that was correct
title: "False flag: "
labels: false-flag
---

GenClass should be precise before it is thorough. A flag or an action on correct behaviour is a bug we want to
hear about, with enough context to turn it into a test or a training row.

**Versions**

- `@genclass/runtime`:
- model: (the `[GenClass] Model ready (...)` console line)
- mode and `aggressiveness`:

**What GenClass said**

Paste the whole console group for the detection or intervention: the `[GenClass] Flagged ...` or
`[GenClass] Prevented ...` line and the collapsed evidence below it.

**`rt.explain(id)`**

Paste the output of `GenClass.runtime.explain(id)` for that decision (the id is in the console group). It contains
the exact situation text the model read, redacted by field meaning; check it for anything you do not want to share
before posting.

**Why the app was right**

What the app was doing at that moment and why the flagged behaviour was correct (a deliberate repeat, polling, an
optimistic update, a retry of your own, ...).

**If GenClass acted (guard / heal):** what changed for the user, and whether `undo()` restored it.

**State involved** (if any): a registered store, discovered React / Redux / Zustand state, or network only.
