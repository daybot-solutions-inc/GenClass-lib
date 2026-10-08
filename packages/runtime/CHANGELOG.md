# Changelog

## 0.1.0-beta.0

- **Ships with a model.** A default `GenClass.init()` now loads `@genclass/runtime-model@0.1.0`
  (`genclass-runtime-r17` 2.0.0-rc2, checkpoint `r17-v2b`) from jsDelivr. The model is 9.6 MB (q8, WASM) and is
  cached after the first load. On held-out data:
  - Diagnosis: 84.2% on simulated apps and 83.6% on real apps.
  - False interventions: 0.02% (guard) and 0.23% (heal) on simulated apps; none were seen on held-out real apps.
  - Recall is low: guard acts on 1.2% of clear simulated cases; heal on 5.7% of them and on 8.5% of actionable
    real-app cases.
  - In observe mode, 1.4% (simulated) to 3.8% (real) of decisions where nothing was wrong get flagged.

  Numbers, gates and limits are in the model card (`@genclass/runtime-model`, `MODEL_CARD.md`).
- **The model sets the gate thresholds** (runtime batch 6). The model's `meta.json` `gate` provides the report,
  guard and heal thresholds per trigger kind; `policy.thresholds` still overrides them. The shipped model uses:
  - report 0.85;
  - guard 0.75–0.95;
  - heal 0.55–1.0.

  `rt.gates(trigger)` shows the values in force and where each came from. Decisions record the threshold and its
  source, and the devtools overlay shows the gates. Also in batch 6: a request with no latency baseline counts as a
  stall after 10 s.
- **Observe stays the default**, and in this version it never holds or delays a response. The delivery decision is
  made in the background and recorded with `executed: false`. A later `GenClass.init({ mode })` that cannot apply
  (the runtime is already running) now logs one warning instead of being ignored silently.
- **`retry` only when repeating is safe** (runtime batch 7). It is offered for idempotent methods, and for POST /
  PATCH only with an idempotency-key header (`policy.idempotencyHeaders`). `Situation.notOffered` says why an action
  was left out.
- **Fewer false `inconsistency` triggers** (runtime batch 8, relation learner precision):
  - sentinel "nothing selected" values are understood;
  - uniqueness is learned only for id columns;
  - pagination and envelope fields are ignored;
  - nothing is checked during typing bursts;
  - busy counters are excluded;
  - equality, count and sum relations need compatible field names.

  On 444 clean runs of 148 real apps, inconsistency decisions fell from 745 to 45. The situation format tag is now
  `situation-v2.3`.
- **One-command install** (new in this version; not in 0.1.0-alpha.1): `npx @genclass/runtime init` detects your
  framework and installs GenClass, and `remove` undoes it. In end-to-end runs on fresh Vite (React, Vue, Svelte),
  Next.js App and Pages Router, Create React App, SvelteKit, Astro, Nuxt, React Router, Angular and plain-HTML
  projects, `remove` restored every file byte for byte. Those runs predate the install fixes below.
- **One import:** `import "@genclass/runtime/auto"` (also `/auto/observe`, `/auto/guard` and `/auto/heal`).
- **One script tag:** `<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime"></script>`, which loads the model
  worker cross-origin.
- **Install fixes:**
  - `init` without `--mode` writes the observe import. `--mode guard|heal|observe` writes `/auto/<mode>` (or
    `data-mode` on the script tag), and running `init` again with another `--mode` switches it in place.
  - `remove` deletes only what `init` wrote, including lines a formatter rewrapped (Prettier, ESLint `curly`). If you
    edited inside a marked block, it reports where and changes nothing. It keeps the package installed while
    dot-folders or `tmp` / `out` / `build` still import it.
  - Node servers and libraries that merely list a bundler are refused instead of edited.
  - An SRI hash is added only for this version's own jsDelivr / unpkg file.
  - `typesVersions` makes the subpath types resolve under TypeScript `"moduleResolution": "node"`.
  - `fetch-model` downloads from `@genclass/runtime-model@0.1.0` on jsDelivr by default, the runtime's own default
    model.
- **Redaction fixes:**
  - The "would replace text the user typed" fact no longer prints characters of a redacted field.
  - Numbers and arrays under a secret-named container (`payment.cvv.value`, `login.otp.code`) are redacted.

## 0.1.0-alpha.1

- **Never reorders your app's writes.** Decisions now happen at the network boundary (the new `delivery` trigger
  for fetch, XHR, WebSocket and EventSource), which looks like latency to the app. Store holds are opt-in
  (`policy.holdWrites`). With a model that never intervenes, GenClass changed 0 of 396 clean runs across 66 real
  apps.
- **Observe is the default mode**; `guard` is opt-in and `heal` is experimental.
- **New facts:** "would put back a value a newer write replaced", "would replace text the user typed", "response
  changes nothing", stale-value provenance, refresh/save cadence, failure scope, commit ambiguity, repeat-click
  evidence, and count-by-group relations.
- **Fixes:**
  - an infinite recursion when app state contains `NaN`;
  - clicks inside shadow DOM were described as the host element;
  - nested-label element names included the text of their options;
  - redaction is now by field name, so a store named `auth` is no longer hidden wholesale;
  - 34 review findings, each with a regression test.

No model for this runtime was published with this version.

## 0.1.0-alpha.0

First alpha.
