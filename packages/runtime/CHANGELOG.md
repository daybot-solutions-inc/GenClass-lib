# Changelog

## 0.2.1 (2026-10-10)

- **Telemetry: no page text by default.** `telemetry.include.situation` now defaults to **false**: decision events
  carry the trigger, diagnosis, confidence, action, gate, outcome, latency and counts, but not the situation text
  the model read. Opt in with `GenClass.init({ telemetry: { include: { situation: true } } })`; TELEMETRY.md now
  says exactly what that text can contain (request names with query strings, route changes, the page title, short
  error messages, short typed values, short store values). The console notice changed accordingly.
- **Telemetry stays off on local and private hosts** (`localhost`, `*.localhost`, `*.local`, `*.test`,
  `*.internal`, loopback, private IPv4 ranges, link-local, `file:`); `runtime.telemetry.reason` is `local`. An
  explicit `telemetry: true` / `{ ... }` still sends from them.
- **Fix: the first salient request after the model loaded was never held in guard or heal mode.** The hold
  budget and the expected model latency used the first warm-up pass, which on WebGPU includes pipeline compilation
  and reads as seconds, so the first decision was taken in the background and could not act. They now use the
  warm pass timed after compilation (`status.latency`), so a duplicate submit right after `Model ready` can be
  coalesced.
- **Fix: the "Model ready" console line repeated** (every 5 s, with each latency notification). Printed once per
  transition into ready.
- Docs: Zustand's `devtools` middleware is off in production builds unless `enabled: true`, so production Zustand
  stores are not discovered without it; `?genclass=guard|heal` only raise the mode within limits.

### From the compatibility matrix (`compat/RESULTS.md`)

Seven framework apps (React + Vite, Next.js 16, Vue + Pinia, SvelteKit 3, Angular 22, Solid, plain HTML) and 15 data
layers, every mode, 10 seeds: no bug introduced; observe identical to no GenClass except one seed of an app race (SWR
optimistic rollback) that GenClass's timing tipped to the correct outcome. No situation text or other model-visible
text changes; no telemetry change.


## 0.2.0 (2026-10-10)

The first release without the beta label, versioned to match `@genclass/runtime-model@0.2.0`. It contains the safety
work below and everything listed under `0.1.0-beta.4`, which was never published.

### Safety: audit trail, interception inventory, money-flow guardrails

- **`rt.audit(n?)`** and `audit: { size, sink }`: a JSON-serialisable audit trail of every decision (acted on or not),
  action, undo, breaker trip and reset, and control change (`setMode`, `setAggressiveness`, `pause`, `resume`,
  `enabled`, `disable`), each with a timestamp, the effective and requested mode, the aggressiveness profile, the gate
  kind, thresholds and their source, the model's probabilities and the model's name, version, variant, device and
  sha256. Bounded in memory (1,000 entries by default); the sink gets every entry after the current task. It never
  changes what the model reads. `status.sha256`: the digest the loaded model variant was verified against.
- **`requests.protect` presets** for payment, checkout and sign-in endpoints: `protectPreset("payments", "auth")`,
  `PROTECT_PRESETS`, or `"preset:payments"` / `"preset:auth"` strings in JSON configs. Protection now also covers what
  a protected response causes (writes, timers and requests started from its callbacks). `npx @genclass/runtime init`
  suggests the presets when the project uses a payment SDK or has checkout or payment pages. Keeping money and identity
  flows observe-only is the documented recommendation.
- **Docs:** [INTERCEPTION.md](INTERCEPTION.md) lists every API GenClass wraps or listens to, what each mode may change,
  what it never does, every action's preconditions and undo, and how `disable()` and `?genclass=off` restore the page;
  a unit test keeps it in sync with the code. New: `SECURITY.md` (reporting, supported versions) and
  `docs/runtime/THREAT-MODEL.md`. The release workflow publishes from a tag with npm provenance (RELEASE.md: how to
  verify a tarball).

### Fixes (found by the new invariant suite, `test/invariants/`)

- The hold budget is now a hard ceiling in three more places: a held store write that the model deferred
  (`policy.holdWrites`) could wait up to 10 s per defer (now its re-decisions share one budget); a response's wait for
  its body and a request's identity body read were not counted against the budget.
- `observe` mode never delays a `fetch` whose `Request` or `Blob` body GenClass reads to identify it (it was sent
  after the read, a few microtasks to 100 ms later); protected and cross-origin requests neither.
- After a late revert, a delivery `discard` no longer drops every later write of the same chain to that field (the
  revert counted as newer data).
- First-load size: `/auto` about 98 KB gzip, the main entry about 91 KB (+1.6 KB each).

## 0.1.0-beta.4 (never published; shipped in 0.2.0)

### One line covers the whole app (automatic state discovery)

`<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime"></script>` or `import "@genclass/runtime/auto"` now
also finds the app's state, so delivery decisions (a response that would overwrite newer data) work in apps that
register no store. In a pilot app (Next.js 16, React state) GenClass had made no state-based decision at all,
because it saw only the network. No situation text or other model-visible text format changes (discovered fields
are ordinary data); telemetry now includes discovered state (below).

- **`InitOptions.autoState`** (`boolean | { react?, redux?, zustand?, pinia? }`): on by default in
  `@genclass/runtime/auto*` and the script tag, off in `GenClass.init()` / `createRuntime()` so explicit setups do
  not change. Installed synchronously when the entry is evaluated, before the framework. Off with
  `autostate=off` (meta tag, `data-autostate`), `window.GENCLASS_CONFIG.autoState = false`, or the kill switch.
- **React ≥ 16.8** (development and production builds) through the React DevTools global hook, installed when absent
  or chained onto an existing one (the extension and React Refresh keep working). Renderers that inject before they
  render get stable wrapped setters that record the op that called `setState` (fetch callback, timer, user handler),
  so a commit that happens later in React's scheduler keeps its cause. Commits are walked over re-rendered fibers only,
  with a 1 ms budget. One observed store per component instance (`Comp.state0`, `Comp.external0`, class state keys;
  production builds: named after the rendered element), 3 instances per component and 48 stores at most; framework
  internals, error boundaries and non-data values are skipped; values equal to a password/card/one-time-code input
  are redacted.
- **Redux / Redux Toolkit** through `window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__` / `__REDUX_DEVTOOLS_EXTENSION__`
  shims (forwarding to the real extension): stores created with them get GenClass's Redux enhancer, a full adapter.
  **Zustand** `devtools` stores (and other Redux DevTools `connect` clients) become observed stores.
- **Observed-only stores** (new hub store kind `observed`): writes are recorded with their writer, versions and
  history and decided in the background (detection), never held, dropped, reverted or rolled back. A mutation of an
  observed store offers no write action, and a delivery `discard` is not offered when every field it would write is
  observed only (`defer` still is). Not-offered reasons are not model-visible.
- **`@genclass/runtime/discover`**: the discovery code for `GenClass.init({ autoState: true })` setups (the main
  entry stays without it). Importing it first installs the hooks at once; a runtime started later attaches.
- **`runtime.stores()`** lists registered and discovered stores; the devtools overlay's Now view shows them.
- **Telemetry:** discovered state is sent like registered stores, in the redacted situation text; decisions made
  after discovered state was recorded carry `autoState: true`. PRIVACY.md says so.
- **Cost:** `/auto` first load about 96 KB gzip (was 89 KB; the main entry is unchanged at 89 KB); the script-tag
  file about 110 KB gzip. Commit-walk and pilot-app measurements: README "Costs".

### Fixes from the local healing benchmark (`bench/heal/`)

No situation text or other
model-visible text changes; no telemetry change.

- **Fix: delivery `discard` on Redux and Zustand stores.** A response whose chain writes stale fields *and* other
  fields in one dispatch / `set()` was applied whole (the discard was a silent no-op while its record named the
  fields as dropped). The write now applies without the stale fields, as it already did for atoms and guarded stores.
- **Fewer model calls on fan-out polling (delivery triage).** Requests started together by the same operation (one
  timer tick or user action fetching several items) no longer count as "newer data" for each other, so a correct
  dashboard that writes a shared `updatedAt` from each response is not asked about (or, in guard/heal, held) on every
  poll. Overlapping rounds stay salient.
- **`policy.idempotencyBodyFields`** (opt-in, default none): top-level JSON body fields that carry an idempotency
  key the server deduplicates on (e.g. `["request_id"]`), so `retry` may be offered for such a POST.

### Fixes from the first real-app trial

Found in the pilot trial ( a Next.js 16 site with a strict Content-Security-Policy, observe mode,
`0.1.0-beta.3`). No change to what the model sees (no situation or model-visible text change) and none to the
telemetry payload.

- **No ONNX Runtime wasm in app builds.** Bundlers (Next/Turbopack, webpack, Vite) copied onnxruntime-web's two
  `.wasm` builds and two `.mjs` bundles (41 MB, one file 26.8 MB, over Cloudflare's 25 MiB per-file limit) into every
  app's build output, unused: the runtime fetches the wasm itself. The model worker and the inline fallback now
  import the prepared ORT copies in `dist/cdn/ort-*.js`, whose `new URL("<file>", import.meta.url)` patterns are
  hidden from bundlers (same value at runtime). A minimal Vite app went from 40 MB to 772 KB of output.
  onnxruntime-web is pinned to exactly `1.30.0` (the version bundled and fetched).
- **Smaller first load.** The inline (no-Worker) fallback loads the tokenizer, packer, engine and loader on first
  use. `/auto` is about 89 KB gzip (was 99 KB), the main entry with `GenClass.init()` 88 KB (was 98 KB). The README
  said 83 KB before; it now gives the measured number, and `test/bundle.test.ts` keeps it under 92 KB.
- **A CSP-blocked model says so, once.** When the model or ORT download is blocked (a `securitypolicyviolation`
  in the page or the worker, or a network-type failure of a cross-origin URL), the runtime prints one
  `console.warn` naming the blocked origin and the fix (self-host with `fetch-model` + `model.baseUrl` /
  `ortWasmPaths`, or allow the origin in `connect-src`) instead of a bare "Failed to fetch" at info level.
  `status.blocked` = `{ url, origin, csp, directive? }`. A failed ORT wasm download is named in the load error.
- **`fetch-model` self-hosts ONNX Runtime too** (`--ort all|wasm|webgpu|none`, default all, into `<dir>/ort/`, with
  `ort/ort.json`), and prints the options to pass, so `connect-src 'self'` is enough.
- **`init --no-telemetry`, `--telemetry`, `--model-url <url>`** write options without hand-editing: a marked
  `genclass.config.(ts|js)` that sets `window.GENCLASS_CONFIG`, imported right before the `/auto` import (plain HTML:
  `data-telemetry="off"` etc. on the script tag; Astro: a `<meta name="genclass">` line). Re-running `init` with
  them changes the options in place; `remove` takes everything out.
- **`init` discloses telemetry** (on by default, what it sends, how to turn it off, links to TELEMETRY.md and
  PRIVACY.md), and **detects a Content-Security-Policy** (next.config/proxy/middleware headers, meta tags, helmet,
  hosting header files) and prints the self-host steps.
- **ORT warnings no longer hit `console.error`.** Sessions are created with ORT's log cut to errors
  (`logSeverityLevel: 3`): the two benign WebGPU lines ("Some nodes were not assigned to the preferred execution
  providers ...") are gone; real failures still reject and are reported.
- **`status.scope` reports the effective mode.** `status.scope.mode` was the route ceiling ("heal" with no `routes`
  rule) and read as if the page ran in heal mode; it is now the effective mode on the current route (as
  `effectiveMode`), with `rule` and `ceiling` when a rule matches. `rt.gates()` carries `mode`.
- `DeviceEnv.mobile` (from `navigator.userAgentData.mobile`) for `model.loadIf` predicates, and a README "Costs"
  section with the trial's measurements (+190 to 280 MB renderer memory with the model worker, 12.7 MB first-visit
  download) and the options for phones.

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
