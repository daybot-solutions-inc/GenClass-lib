# Changelog

## 0.1.0-beta.3 (2026-10-09)

> **Privacy-relevant change: anonymous telemetry is now on by default.** Review
> [TELEMETRY.md](TELEMETRY.md) before upgrading; apps that ship GenClass may need to disclose it to their users.

- **Default-on anonymous diagnostics (`telemetry` option).** `GenClass.init()` in a browser (and `/auto`, the
  script tag, `init` setups) now sends GenClass's own diagnostics to the GenClass maintainers' collector
  (`DEFAULT_TELEMETRY_ENDPOINT`, a Cloudflare Worker storing to a private R2 bucket) to improve the model: a session
  event (runtime/model versions, mode, aggressiveness, device class, model load, the page's hostname and
  id-normalised path), every decision (trigger, **the redacted situation text the model read**, calibrated answers,
  diagnosis, gate threshold and source, what ran, latency, held or background), action outcomes (applied, failed,
  undone, late revert, veto), detections, model status and errors, fail-open counts and periodic summaries. Never
  typed password/payment/secret values, cookies, headers, bodies, storage, query strings or app error messages; the
  collector stores no IP address or user agent. A random per-page session id (not persisted, no cookies). One
  console notice per page.
- **Opt-outs:** `telemetry: false` (also `telemetry=off` in `<meta name="genclass">` / `data-telemetry="off"`),
  `?genclass=no-telemetry` or `?genclass=off`, `localStorage["genclass.telemetry"] = "off"`, and Global Privacy
  Control (`navigator.globalPrivacyControl === true`) is always honoured. Off in Node/SSR and in `createRuntime()`
  unless enabled. `telemetry: { endpoint, sample, flushMs, maxBatch, include: { situation } }` for your own
  collector, sampling or leaving the situation text out; `runtime.telemetry` says whether it is on and why not.
- Telemetry is read-only: it never changes what the model sees (no situation or model-visible text change), never
  delays a decision, uses the fetch/sendBeacon captured at load (GenClass never observes its own requests), keeps a
  bounded queue and drops failed batches without retrying or throwing.
- New exports: `DEFAULT_TELEMETRY_ENDPOINT`, `TELEMETRY_SCHEMA`, `TELEMETRY_NOTICE`, `RUNTIME_VERSION`; types
  `TelemetryOptions`, `TelemetryTransport`, `TelemetryStatus`. `TELEMETRY.md` ships in the package.

## 0.1.0-beta.2 (2026-10-08)

Merges the 0.1.0-beta.1 work (model 0.2.0, aggressiveness, batch 12 options) with the fixes that shipped in
0.1.0-beta.0 but were missing from 0.1.0-beta.1, which was published from a branch without them.

- **Default mode is `observe` again.** `GenClass.init()` with no `mode` reports what it sees and never changes
  execution; `guard` is opt-in and `heal` is experimental (0.1.0-beta.1 defaulted to `guard`). `aggressiveness`
  still defaults to `"balanced"`; its action gates apply once you opt into `guard` or `heal` (in observe mode it
  only picks the profile's report threshold for detections: 0.95 / 0.90 / 0.70 for cautious / balanced / eager). `shadow: "guard"` in observe mode records what guard
  would have done, background delivery decisions included.
- **Observe never holds or delays a delivery.** A response or push message is released synchronously, before any
  body read, whenever no hold is possible (observe, sample cap, breaker downgrade, an observe / off route scope, a
  protected or cross-origin subject, no permitted action, or a model too slow for the remaining hold budget). The
  delivery decision is still made in the background and recorded (`executed: false`), on the state the delivery was
  released into; while it is pending it covers its chain's writes, so they are not decided twice.
- **Redaction fixes:** the "would replace text the user typed" fact no longer prints characters of a redacted
  field, and numbers and arrays under a secret-named container (`payment.cvv.value`, `login.otp.code`) are redacted.
- **Install CLI fixes:** `init` without `--mode` writes the observe import, and `--mode guard|heal|observe` writes
  `/auto/<mode>` (or `data-mode` on the script tag) and switches it in place when run again; `remove` deletes only
  what `init` wrote, including formatter-rewrapped lines, and changes nothing when you edited inside a marked block;
  Node servers and libraries are refused; SRI only for this version's own jsDelivr / unpkg file; `typesVersions`
  for `"moduleResolution": "node"`.
- **`fetch-model` downloads from jsDelivr by default:** `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.2.0/files/`,
  the same directory as the runtime's `DEFAULT_MODEL_BASE_URL` (a test keeps them equal).
- **CI:** GitHub Actions runs typecheck, build, the unit tests and review-perf (separately, with retries) against a
  committed root `package-lock.json`.

## 0.1.0-beta.1 (2026-10-08)

Published from the `runtime` branch; it did not include the 0.1.0-beta.0 observe default, delivery, redaction and
install fixes listed above (0.1.0-beta.2 restores them).

- **Model 0.2.0** (`@genclass/runtime-model@0.2.0`, `genclass-runtime-r17` 2.0.0-rc4t, run `r17-v2dT`) is the
  default model: a gain gate and three aggressiveness profiles in `meta.json`. Numbers in `docs/runtime/RESULTS.md`.
- **`aggressiveness`** (runtime batch 11): `"cautious" | "balanced" | "eager"` or a number 0–1, per route too;
  `rt.setAggressiveness()`, `?genclass-aggr` (demote only unless `debug`), a devtools selector, `rt.gates()`.
- **Batch 12, 19 options** (`docs/runtime/OPTIONS-SPEC.md`): `enabled`, `rt.disable({ undo })`, `sample`, `routes`,
  `requests.{ignore, protect, labels, correlate, crossOrigin}`, `breaker`, `shadow`, `onBeforeAction` + `vetoMode`,
  `policy.actionLimits` (60/min, 10/min per subject, 200 per session), `policy.holdBudgetMs` as a hard ceiling,
  `sinks`, `session`, `report: "interventions"`, `rt.summary()`, typed `rt.on()` events, and `model.{loadIf,
  threads, timeoutMs, maxDecisionsPerMinute, unloadAfterIdleMs}`.

## 0.1.0-beta.0 (2026-10-08)

- **Ships with a model.** A default `GenClass.init()` now loads `@genclass/runtime-model@0.1.0`
  (`genclass-runtime-r17` 2.0.0-rc2, checkpoint `r17-v2b`) from jsDelivr. The model is 9.6 MB (q8, WASM) and is
  cached after the first load. On held-out data:
  - Diagnosis: 84.2% on simulated apps and 83.6% on real apps.
  - False interventions: 0.01% (guard) and 0.07% (heal) on simulated apps; none were seen on held-out real apps.
  - Recall is low: guard acts on 0.7% of clear simulated cases; heal on 2.9% of them and on 5.7% of actionable
    real-app cases.
  - In observe mode, 1.4% (simulated) to 3.8% (real) of decisions where nothing was wrong get flagged (3.1% on the
    model's own on-policy simulated traffic).

  Numbers, gates and limits are in the model card (`@genclass/runtime-model`, `MODEL_CARD.md`).
- **The model sets the gate thresholds** (runtime batch 6). The model's `meta.json` `gate` provides the report,
  guard and heal thresholds per trigger kind; `policy.thresholds` still overrides them. The shipped model uses:
  - report 0.85;
  - guard 0.80 (mutation 0.95);
  - heal 0.85 (failure 0.95).

  These were refit on the model's own on-policy traffic before release.

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
