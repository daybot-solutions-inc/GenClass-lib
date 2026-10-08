# demos/: six demo apps, chaos backend and trial harness

> **Scope:** `demos/` (`README.md`, `NEEDS.md`, `results.md`, `results*.json`, `package.json`, `vite.config.ts`, `tsconfig*.json`, `scripts/**`, `e2e/**`, `src/**`, `index.html`, `*/index.html`).
> **Read this when:** you change a demo app, its scenario or oracle; touch the Service Worker mock server or chaos model; run or change the Playwright eval; read or regenerate `results.*`; update the runtime API the demos use (shim); or work on a `demos/NEEDS.md` item.
> **Source of truth:** the code. Verified against commit 654d822 (2026-10-07). If this doc and the code disagree, the code wins.

## TL;DR

- `@genclass/demos` (private workspace) is a Vite multi-page static site: a landing page plus six small apps (`search`, `editor`, `checkout`, `status`, `board`, `decisions`), each with a deliberate, realistic latent bug that only shows under network chaos.
- The backend is a **mock API inside a Service Worker** (`src/server/`): real `fetch` and a real `EventSource` from the page's point of view. Each page or trial gets its own server session (**world**). The page controls the server only via `postMessage`, never `fetch`, so GenClass never observes test traffic.
- GenClass is created in exactly one place, `src/shared/genclass.ts` -> `startGenClass`. Demo **Off** = `GenClass.init({ mode: "observe", model: false })` (the baseline; nothing is held or decided). **Guard** / **Heal** = `GenClass.init({ mode, model: { baseUrl, preload: "eager" } })`. App code is identical in all three.
- A **trial** = seeded scenario (scripted user steps + chaos + server params + intent) run in a fresh page, then scored by the demo's **oracle** (test code that reads only the DOM and the mock server's truth). **Chaos** trials measure bug rate; **clean** trials (calm network, calm user, app is correct) count **false interventions** (any non-passive action that ran).
- Two drivers run the same steps: the in-page "Run trials" panel (iframes, synthetic DOM events, `src/shared/driver.ts`) and the headless eval (`e2e/eval.ts`, Playwright, real keyboard and mouse).
- Fairness devices: **common random numbers** (the n-th identical request/event gets the same latency and failure draws in every mode) and **native timers** captured before `GenClass.init` for all test code. Known gap: scripted world activity is timed from world creation, which precedes the Guard/Heal model wait (`gc.loadMs` 0.67–2.08 s in the shipped run), see [Invariants](#invariants-and-gotchas).
- Shipped results (`results.md`, 810 trials, the v0.1 GenClass model, which was not trained for runtime decisions, q8 WASM): no executed action lowered a bug rate (the only drop, status under Guard 100% -> 93%, came with zero actions executed), 0 false interventions (mostly because decisions missed thresholds or the hold budget), and holding writes cost latency (search) and introduced bugs (board, 9 of 30 seeds under both Guard and Heal).
- Open runtime work for CORE is in `demos/NEEDS.md`; at HEAD §1 (held write lands after a newer user write), §2 (holds cost latency), §5 (`retry` offered for non-idempotent requests) and §6 (no EventSource observer) are still open in code.
- **Blocking gotcha:** `demos/src/server/data/cities.ts` is imported by the search world, scenario and oracle but is **not in git** (the root `.gitignore` line `data/` ignores it). A fresh clone cannot build the Service Worker or the search page until it is recreated. See [Drift](#drift-and-open-issues).
- Ground rules: the original team ran every build, browser and model run on the `train` VM through `scripts/vm.sh` (slot `demos`), because the author's Mac has 8 GB. Under the current agent policy ([../../AGENTS.md](../../AGENTS.md) §4), ask the user before the demos' eval (`npm run eval*`, `scripts/vm-eval.sh`), model downloads (`npm run fetch-model`) or anything on Azure. Demos and `sim/` must not read each other, and oracles are never passed to GenClass.

## Files

| Path | Role | Key exports / entry points |
|---|---|---|
| `demos/package.json` | workspace `@genclass/demos` (private, ESM). Deps: `@genclass/runtime` `*` (workspace), `react`/`react-dom` ^19.3.0, `redux` ^5.0.1, `zustand` ^5.0.15, `@fontsource-variable/{inter,jetbrains-mono}`. Dev: `@playwright/test` 1.63.0, `vite` ^8.3.3, `@vitejs/plugin-react` ^6.1.2, TS ~5.9.3 | scripts `dev`, `build`, `preview`, `typecheck`, `typecheck:shim`, `fetch-model`, `eval`, `eval:fast`, `shots` |
| `demos/vite.config.ts` | multi-page build (`base: "./"`), shim aliasing, dev Service Worker middleware, defines | `PAGES`, plugin `genclass-demo-dev-sw`, defines `__BUILD_ID__`, `__RUNTIME_KIND__` |
| `demos/tsconfig.json` | app code (`src`, excludes `src/server/sw.ts` and the shim) | |
| `demos/tsconfig.sw.json` | Service Worker code (`lib: WebWorker`): `src/server/**`, `src/shared/{chaos,rng,protocol}.ts` | |
| `demos/tsconfig.node.json` | `e2e/**/*.ts`, `vite.config.ts` | |
| `demos/tsconfig.shim.json` | like `tsconfig.json` with `paths` mapping `@genclass/runtime*` to the shim | |
| `demos/.gitignore` | ignores `node_modules/`, `dist/`, `public/genclass-model/`, `test-results/`, `playwright-report/`, `e2e/.out/` | |
| `demos/public/favicon.svg` | site icon (copied to `dist/` by the site build) | |
| `demos/index.html`, `demos/<demo>/index.html` | pages; `<meta name="gc-root">` is `./` (landing) or `../` (demos); inline theme bootstrap from `localStorage["gc-demo-theme"]` | `src/site/landing.ts`, `src/demos/<demo>/main.ts` |
| `demos/scripts/build.mjs` | builds the site, then `dist/sw.js` as one classic IIFE (`name: "GenClassDemoServer"`) with the same `BUILD_ID`; copies `results-summary.json`; writes `dist/build.json`, `dist/.nojekyll` | |
| `demos/scripts/fetch-model.sh` | downloads a model directory (runtime CLI `packages/runtime/bin/genclass-runtime.mjs fetch-model`, curl fallback) | args `[dir] [baseUrl] [variant]` |
| `demos/scripts/vm-eval.sh` | full VM pipeline: install, build runtime, model, build demos, typecheck, eval | env `GENCLASS_MODEL_FROM/DIR/URL/VARIANT`, `ALLOW_BROKEN_RUNTIME`, `SKIP_EVAL` |
| `demos/e2e/eval.ts` | headless Playwright eval: trials, reports, screenshots | CLI options (see Configuration) |
| `demos/e2e/serve.ts` | static server for `dist/` under a sub-path, with extra mounts | `serveStatic(rootDir, base, port, mounts)` |
| `demos/e2e/trace-report.ts` | analyses `--trace` runs (held writes, apply order); prints Markdown to stdout. Sections: "Board: what holding writes does" (per mode/kind: writes, held = waited > 2 ms, median hold, held writes applied after a newer user write to the same card), A/A flips (with the optional 2nd file), per-seed card timelines for seeds clean in Off but buggy in Guard/Heal plus "mechanism counts"; "Search: where the latency goes" (held response writes, decision latency, holds released before their decision arrived) | `node --experimental-strip-types e2e/trace-report.ts [traces.json (default e2e/.out/traces.json)] [offB.json]` |
| `demos/src/shared/genclass.ts` | the only place the runtime is created; session stats | `startGenClass`, `collectStats`, `statusText`, `RUNTIME_KIND`, `GcSession` |
| `demos/src/shared/settings.ts` | URL params and localStorage | `getMode`, `setMode`, `modelBaseUrl`, `trialParams` (`TrialParams { seed, kind, mode, run }`), `traceOn`, `holdBudget`, `sessionId`, `loadChaos`, `saveChaos`, `siteRoot`, `getTheme`/`setTheme`, `urlParams` |
| `demos/src/shared/chaos.ts` | chaos model (shared by page and Service Worker) | `RouteChaos`, `Chaos`, `CALM`, `PresetId` (`calm\|busy\|flaky\|storm\|outage`), `PRESETS`, `withPreset`, `matchPreset`, `mergeChaos`, `resolveChaos`, `Timing { up, down, spike }`, `sampleTiming`, `sampleEventDelay`, `describeChaos` |
| `demos/src/shared/protocol.ts` | page <-> Service Worker control protocol | `DemoId`, `ControlMessage`, `ControlReply`, `LogEntry`, `EventEntry`, `ServerInfo` (exported, unused) |
| `demos/src/shared/server.ts` | page side of the mock server | `ensureServiceWorker`, `ServerLink`, `ServerTruth`, `ServerError`, `epochNow`, `wait` |
| `demos/src/shared/native.ts` | timers captured at module load, before `GenClass.init` wraps globals | `nativeSetTimeout`, `nativeClearTimeout`, `nativeSetInterval`, `nativeClearInterval`, `sleep` |
| `demos/src/shared/rng.ts` | seeded PRNG (sfc32, seeded from a number or `hashString` of a string, 12 warm-up draws) and distributions | `Rng` (`float`, `range`, `int`, `chance`, `pick`, `weighted`, `normal`, `lognormal(median, sigma)`, `exp(mean)`, `shuffle`, `fork` (unused)), `hashString` (FNV-1a 32-bit), `clamp` |
| `demos/src/shared/scenario-kit.ts` | human typing rhythm with typos, chaos sampling | `TypingStyle { median, sigma, typoRate, pauseRate, pauseMs }`, `typeSteps(rng, sel, text, style)`, `keyDelay`, `CALM_TYPIST`, `FAST_TYPIST`, `ChaosRanges`, `sampleChaos(rng, ranges, extra)` (uniform per key, rounded to 3 decimals), `CLEAN_CHAOS` |
| `demos/src/shared/types.ts` | trial types | `GcMode`, `MODES`, `TrialKind`, `Step`, `Scenario`, `Score`, `GcStats`, `InterventionSummary`, `TrialResult` |
| `demos/src/shared/demo-def.ts` | demo contract | `DemoDefinition`, `AppContext`, `OracleContext`, `Oracle` |
| `demos/src/shared/driver.ts` | synthetic in-page user (dispatches keyboard/input/pointer/mouse events) | `runSteps`, `DriverHooks` |
| `demos/src/shared/harness.ts` | trial harness inside a trial page (`bootTrial` assigns it to `window.__trial`; this file declares the `__trial`/`__trialReady`/`__trialError` globals) | `TrialHarness` |
| `demos/src/shared/aggregate.ts` | aggregation (no DOM; used by panel and eval) | `wilson`, `quantile`, `summarizeMode`, `summarizeDemo`, `ModeSummary`, `DemoSummary`, `Rate` |
| `demos/src/shared/trace.ts` | investigation tracing (`?trace=1`) via `hooks.mutationProposed` and runtime events | `newTrace`, `traceHooks`, `attachTrace`, `Trace` |
| `demos/src/shared/demos.ts` | copy for landing/topbar/explain cards | `DEMOS`, `DEMO_BY_ID`, `REPO_URL`, `DemoInfo` |
| `demos/src/shared/api.ts` | API base URL (`<siteRoot>api/`) | `api(path)` |
| `demos/src/server/sw.ts` | Service Worker: sessions, control messages, `/api/*` routing, COOP/COEP headers, GC of worlds | listeners `install`, `activate`, `message`, `fetch` |
| `demos/src/server/core.ts` | world (session) class: router, chaos/latency pipeline, SSE streams, request log, quiescence | `World`, `WorldDef`, `Route`, `Req`, `Res`, `json`, `now`, `sleep` |
| `demos/src/server/worlds/<demo>.ts` | one server world per demo (state, routes, scripted activity, snapshot) | `searchWorld`, `editorWorld` (`ServerNote`), `checkoutWorld` (`PRODUCTS`, `ServerOrder`), `statusWorld` (`SERVICES`, `truthAt`, `Incident`, `Health`), `boardWorld` (`COLUMNS`, `BOARD_SEED`, `TEAMMATES`, `teammateMove`, `Card`), `decisionsWorld` (`BACKUP_MS`, `JournalVersion`) |
| `demos/src/server/data/cities.ts` | **missing from git** (ignored by root `.gitignore` `data/`); must export `searchCities(q)` and `TYPED_TARGETS` | used by `worlds/search.ts`, `demos/search/{scenario,oracle}.ts` |
| `demos/src/demos/<demo>/main.ts` | `bootDemo({...})` with the demo's `DemoDefinition` | |
| `demos/src/demos/<demo>/app.ts(x)`, `store.ts` | the app (with its latent bug) and its store wiring | `mountSearch`, `mountEditor`/`createNotesStore`, `mountCheckout`, `mountStatus`, `mountBoard`/`createBoardStore`, `mountDecisions` |
| `demos/src/demos/<demo>/scenario.ts` | seeded scenario generator | `<demo>Scenario(seed, kind)` |
| `demos/src/demos/<demo>/oracle.ts` | scorer (test code only) | `<demo>Oracle(ctx)` |
| `demos/src/demos/decisions/{plugin,jobs}.ts` | custom plugin; background job controller | `backgroundWorkPlugin`, `BackgroundJobs`, `jobs` |
| `demos/src/site/demo-page.ts` | boots an interactive demo page or a bare trial page | `bootDemo` |
| `demos/src/site/activity.ts` | "GenClass activity" panel (reports, evidence via `gc.explain`, Undo, banner) | `mountActivity(gc, mode, overlayHost)` -> `ActivityPanel { el, counts: { prevented, flagged } }` |
| `demos/src/site/chaos-panel.ts` | chaos presets, sliders, toggles, demo extras | `mountChaosPanel(demo, link, initial, extras)` -> `ChaosPanel { el, get(), set(c) }`; `SLIDERS` (module-private) |
| `demos/src/site/trials-panel.ts` | in-page trial runner (iframes) | `mountTrials` |
| `demos/src/site/netlane.ts` | live waterfall of the server log (last 10 s) | `mountNetLane` |
| `demos/src/site/landing.ts` | landing page (hero, modes, demo cards, results table from `results-summary.json`) | module side effects |
| `demos/src/site/{chrome,dom,icons,art,highlight}.ts` | top bar (brand, demo nav, theme toggle that dispatches the `gc-theme` window event, GitHub link) and theme; DOM helpers; SVG icons; per-demo card art; tiny TS/JS syntax highlighter for the `code` snippets | `renderTopbar(active)`, `applyTheme`; `h(tag, attrs, ...children)` (`class`, `html`, `style`, `on*` keys), `append`, `esc`, `ago`, `fmtMs`, `pct`, `toast(msg, ms = 3200)`, `svg` (unused); `icon(name, attrs)`, `BRAND_MARK`, `IconName`; `ART: Record<DemoId, string>`; `highlight(code)` |
| `demos/src/styles/{system,site}.css` | design tokens (light/dark, `--mode-off/guard/heal`) and site chrome | |
| `demos/src/dev/runtime-shim/*.ts` | observe-only stand-in for `@genclass/runtime`, `/react`, `/redux`, `/zustand`, `/devtools`; re-exports all types from `packages/runtime/src/types.ts` by relative path | `index.ts`: `GenClass` (singleton `init`, `runtime` getter, `destroy`), `createRuntime`, `GenClassUnavailableError` (no `reason` field); `react.ts`: `useGenClass`, `useAtom`, `useGenClassState`; `redux.ts`: `genclassEnhancer` (identity); `zustand.ts`: `genclass` (identity); `devtools.ts`: `mountDevtools` (no-op handle), `DevtoolsOptions` |
| `demos/README.md` | human README (run, URL params, oracles table, latest results, honesty rules) | |
| `demos/NEEDS.md` | what DEMOS needs from CORE/MODEL, with evidence | |
| `demos/results.md`, `results.json`, `results-summary.json` | latest measurements (raw trials only in `results.json`); summary ships with the site | |
| `demos/screenshots/*.png` | captured by the eval's screenshot tour | |

## Concepts and data structures

Additional terms used in this doc (repo-wide terms such as op, trigger, situation, hold, mode, tier, late revert, budget follow the glossary):

| Term | Meaning here |
|---|---|
| demo mode | `GcMode = "off" \| "guard" \| "heal"` (`src/shared/types.ts`). Demo **Off** maps to runtime mode `observe` with `model: false`. Do not confuse demo Off with `?genclass=off` (the runtime's kill switch, which installs nothing). |
| world | one mock-server session (`src/server/core.ts` -> `World`), keyed by a session id (`sid`): `live-<demo>-<rand>` for an interactive page (sessionStorage `gc-demo-sid-<demo>`), `trial-<demo>-<run>` for a trial. Owns state, chaos, request log, event log, SSE streams, timers. |
| chaos | `RouteChaos` (global knobs) + `Chaos.routes` per-route overrides. Environment only, never app logic. |
| route key | string naming a route for chaos rules and logs, e.g. `search`, `notes/item`, `status/payments`, `board/events`. `resolveChaos` applies global, then each prefix (`status`), then the exact key. |
| common random numbers (CRN) | `World.rngFor(key)`: the n-th occurrence of the same logical request (`"<METHOD> <path><query> <raw body>"`) or live event gets `new Rng(hashString("<seed>\|<key>\|<n>"))`, so timing/failure draws do not shift when GenClass changes timing. |
| freeze | control action `world` / `"freeze"`: sets `World.frozen`, stopping scripted activity (`World.script` timers: teammates, random incidents); deliveries continue. |
| quiet | `World.quiet(idleMs, timeoutMs, ignoreStreams)`: no request in flight and (unless ignored) no pending SSE delivery for `idleMs`. |
| scenario | `Scenario { seed, kind, chaos, params, steps, intent, label }`; `intent` is read only by the oracle. |
| step | `Step` union discriminated by **`k`**: `{k:"type", sel, text, delays[]}` (one delay per char), `{k:"key", sel, key: "Backspace"\|"Enter"\|"Escape"\|"Tab"\|"ArrowLeft"\|"ArrowRight", delays[]}` (one press per delay), `{k:"click", sel, count?, gap?, unless?}` (`unless` = oracle condition that skips the click), `{k:"focus", sel}`, `{k:"caret", sel, pos: "end"\|"start"\|number}`, `{k:"wait", ms}`, `{k:"until", cond, timeout}` (named oracle condition), `{k:"chaos", patch}`, `{k:"server", action, args?}` (world action), `{k:"mark", name}` (epoch timestamp in `OracleContext.marks`). |
| world clock | scripted world activity (status incidents at `w.created + at`, board teammates, random incidents) is timed from world creation (`hello`), not from the session start `t0`. See the fairness gotcha in [Invariants](#invariants-and-gotchas). |
| demo host | `DemoDefinition.host`, the fake address in the app's window chrome: search `wander.example/search`, editor `notes.example/workspace`, checkout `fieldsupply.example/cart`, status `status.acme.example`, board `tasks.example/sprint-14`, decisions `journal.example/day-3`. |
| oracle | `Oracle { start?(), check?(cond), finish(): Promise<Score> }` built from `OracleContext { link, doc, el, scenario, marks, t0, tEnd }`. Samples the DOM with native timers; reads truth via `ServerLink.truth()` / `.log()`. Never given to GenClass or the app. |
| `Score` | `{ bug, reasons[], metrics: Record<string, number>, details? }`. `metrics.latencyMs` is the demo's user-visible latency metric. |
| `TrialResult` | `Score` + `{ demo, mode, kind, seed, label, durationMs, gc: GcStats, driver: "synthetic"\|"playwright", error?, trace? }`. |
| `GcStats` | `{ runtime: "real"\|"shim", isolated?, status, model?, device?, variant?, loadMs?, decisions, detections, notExecuted, interventions: InterventionSummary[], decisionLatencyMs[], diagnoses }`. `notExecuted` keys are `Decision.reason` with digits replaced by `#`. |
| false intervention | one `act` event (an executed non-passive action, including failed attempts and late reverts) on a clean trial. |
| fixed / introduced | paired with Off on the same chaos seed: Off bug -> mode ok / Off ok -> mode bug (`summarizeMode`). |
| A/A noise | flips between two Off runs of the same seeds; the floor for reading fixed/introduced (board: 1 of 30 after CRN, per `NEEDS.md` §4). |
| jump-back | board oracle metric: a card the user moved shows its previous column again 400 ms–5 s after the server accepted the move, before any newer move of that card. |
| trace run | `?trace=1` / `eval.ts --trace`: records every proposed write (`hooks.mutationProposed`), each `state` event (applied write), ops and decisions into `window.__gcTrace`. Off by default; never in published results. |
| runtime shim | `src/dev/runtime-shim/`: observe-only stand-in aliased when `packages/runtime/dist/index.js` is missing or `GENCLASS_SHIM=1`; results then say `runtime: "shim"`. |
| COI | cross-origin isolation: the Service Worker adds COOP/COEP/CORP headers so `crossOriginIsolated` is true and WASM threads are available to the model. |

Key types (abridged; field names exact):

```ts
// src/shared/demo-def.ts
interface DemoDefinition {
  id: DemoId; host: string;                     // fake address in the window chrome
  mount(ctx: AppContext): void | Promise<void>; // AppContext { gc: Runtime; el; mode: GcMode; embed: boolean }
  scenario(seed: number, kind: TrialKind): Scenario;
  oracle(ctx: OracleContext): Oracle;
  chaosExtras?(link: ServerLink): HTMLElement;  // demo-specific server controls
  code: string;                                  // highlighted integration snippet (HTML)
  plugins?(): Plugin[];
  settle?: { idleMs: number; timeoutMs: number; ignoreStreams?: boolean } | false; // default { idleMs: 700, timeoutMs: 20000 }
  serverParams?: Record<string, unknown>;        // world params for the interactive page
  loaded?: string;                               // oracle condition awaited before the session
}

// src/shared/protocol.ts (page -> Service Worker, each with a MessagePort for the reply)
type ControlMessage =
  | { type: "hello"; sid; demo; reset?; seed?; chaos?; params? } | { type: "ping"; sid? }
  | { type: "chaos"; sid; patch; replace? } | { type: "state"; sid } | { type: "log"; sid; since? }
  | { type: "quiet"; sid; idleMs; timeoutMs; ignoreStreams? } | { type: "world"; sid; action; args? } | { type: "bye"; sid };
// plus the untyped { type: "claim" } used by ensureServiceWorker
interface LogEntry { id; method; path; query; route; t0; tHandled?; tEnd?; status?;
  outcome: "pending" | "ok" | "client-error" | "rejected" | "lost" | "network"; effect?; aborted?; spike?; body? }
```

`LogEntry.outcome`: `rejected` = 5xx before handling (or outage 503), `lost` = handled then 502/504 (side effects stay), `network` = offline (`Response.error()`), `client-error` = handler returned ≥ 400 or 404 route. All times (`t0`, `tHandled`, `tEnd`, `EventEntry.t`, `deliveredAt[]`) are epoch ms = `performance.timeOrigin + performance.now()` of the Service Worker (`core.ts` -> `now`); the page side uses the same formula (`server.ts` -> `epochNow`).

Control messages and their replies (`src/server/sw.ts` -> `control`; every reply has `ok`, failures `ok: false, error`; `ServerLink.send` throws `ServerError` when `ok` is false and `error` is set):

| `type` | Effect | Reply fields |
|---|---|---|
| `claim` | `clients.claim()` (sent by `ensureServiceWorker` to an uncontrolled page) | `{ ok: true }` |
| `ping` | binds client id -> `sid` if given | `buildId`, `epoch` (random per worker instance), `known` (world exists) |
| `hello` | creates a world when none exists, `reset` is set, or the existing world is for another demo (old one disposed); binds client | `buildId`, `epoch`, `created`, `chaos`, `t` |
| `chaos` | `World.setChaos(patch, replace)` | `chaos` |
| `state` | `WorldDef.snapshot(w)` | `t`, `created`, `state`, `chaos`, `events` (count) |
| `log` | request log entries with `id > since`, all events | `t`, `log`, `events` |
| `quiet` | `World.quiet(idleMs, timeoutMs, ignoreStreams)` | `quiet`, `waited` |
| `world` | `"freeze"` sets `frozen`; other names go to `WorldDef.action` | `result` (`ok` is false when the action returned `undefined`) |
| `bye` | disposes `trial-*` worlds only; unbinds this client | `{ ok: true }` |

Page side (`src/shared/server.ts` -> `ServerLink(sid, demo)`): `send(msg, timeoutMs = 10000)` (waits up to 5 s for a controller), `hello(opts)` (remembers opts for re-binding), `startHeartbeat()` (ping every 5 s with a 4 s timeout; re-`hello`s with the remembered opts and `reset: false` in three cases: on `{type:"identify"}` (re-hello only, never `onRestart`), on `controllerchange` (`onRestart` if the reply says `created`), or when `ping` says `known: false` (`onRestart` always)), `stop()`, `setChaos(patch, replace = false)`, `truth<S>()` -> `ServerTruth<S> { t, created, state: S, chaos, events }`, `log(since = 0)`, `quiet(idleMs, timeoutMs, ignoreStreams = false)` (control timeout `timeoutMs + 5000`), `world(action, args)` -> `result`, `bye()` (2 s timeout, errors ignored).

World API (`src/server/core.ts`):

| Member | Meaning |
|---|---|
| `WorldDef<S> { demo, create(rng, params), routes, snapshot(w), start?(w), action?(w, name, args) }` | one per demo in `src/server/worlds/`; registered in `sw.ts` -> `DEFS` |
| `Route<S> { method, pattern: RegExp, key(m), handle?(w, req), stream? }` | `pattern` matches the path after `<scope>api` (e.g. `/notes/n1`); capture groups become `req.params` |
| `Req { method, path, query: URLSearchParams, body, raw, headers, params, entry }` / `Res { status, json?, headers?, work?, effect? }` | `body` is parsed JSON (or the raw string); `work` = extra server ms (× `spikeFactor` on a spike); `effect` is logged |
| `rng` / `scriptRng` / `rngFor(key)` | handler RNG (per request: `new Rng(handlerSeed)`; outside requests the base RNG `Rng(seed ^ 0x5eed)`); script RNG `Rng(seed ^ 0xc0ffee)`; CRN generator |
| `after(ms, fn)`, `every(ms, fn)` (unused), `script(ms, fn)` | world-owned timers (cleared on `dispose`); `script` skips when `frozen` |
| `publish(type, data, key?)`, `openStream(clientId)`, `openStreams` (unused) | SSE |
| `inflight`, `pendingDeliveries`, `lastActivity`, `frozen`, `disposed`, `created`, `log`, `events`, `state`, `chaos`, `params`, `seed`, `sid` | bookkeeping read by `quiet`, `sw.ts` and snapshots |

Aggregation output (`src/shared/aggregate.ts`): `Rate { n, k, rate, lo, hi }`; `ModeSummary { mode, chaos: Rate, clean: Rate, falseInterventions, cleanTrialsWithIntervention, cleanTrials, interventionsPerChaosTrial, decisionsPerTrial, detectionsPerTrial, latencyMs, latencyChaosMs, decisionP50, decisionP95, fixed, introduced, paired, notExecuted, actions, errors, runtime, modelStatus, metrics }`; `DemoSummary { demo, modes: Partial<Record<GcMode, ModeSummary>>, trials }`. `results*.json` `demos.<id>` is `DemoSummary.modes`.

Trace shape (`src/shared/trace.ts`, stored in `window.__gcTrace` and `TrialResult.trace`): `Trace { origin (performance.timeOrigin), proposals: TraceProposal[], applies: TraceApply[], decisions: TraceDecision[], ops: Record<opId, TraceOp> }`. `TraceProposal { id, t, store, paths (≤ 12), cause?, changes (≤ 12, values shortened to 60/160 chars) }` from `hooks.mutationProposed`; `TraceApply { t, mutation, store, paths, user, op?, summary }` from `event` kind `state`; `TraceOp { kind, name, t, cause? }` from the first `op.start`/`user` event per op; `TraceDecision { id, trigger, subject (≤ 160 chars), at, latencyMs, action, candidate?, mass?, executed, reason?, diagnosis, mutation?, op? }` from `decide` (`mutation`/`op` from `Decision.subjectRef`). Times `t` are page `performance.now()`.

## How it works

### 1. Page boot (`src/site/demo-page.ts` -> `bootDemo`)

1. `applyTheme()`; `trialParams()` decides the page kind (`?embed=trial` -> trial page).
2. `ensureServiceWorker(siteRoot())` (`src/shared/server.ts`): registers `<root>sw.js` (`type: "module"` in dev, `"classic"` in prod, `scope: root.pathname`, `updateViaCache: "none"`); up to 3 attempts to get control (posts `{type:"claim"}`, waits for `controllerchange` 3 s / 5 s); if still uncontrolled, reloads once (sessionStorage `gc-demo-sw-reload`) then throws. If the top-level page is not `crossOriginIsolated` and `?coi=0` is absent, reloads once (`gc-demo-coi-reload`). If the controller's `buildId` differs from `__BUILD_ID__` (non-dev), calls `reg.update()` and waits up to 6 s.
3. **Interactive page** (`bootInteractive`): `ServerLink(sessionId(demo))`, `hello({ chaos: loadChaos(demo), params: def.serverParams, seed: 7 })` (re-applies saved chaos with `replace` if the world already existed), `startHeartbeat()`; `link.onRestart` = toast "The mock server restarted and its data was reset" then `location.reload()` after 1,500 ms; `pagehide` -> `link.stop()`; `startGenClass(getMode(), { baseUrl: modelBaseUrl(root), plugins: def.plugins?.(), holdBudgetMs: holdBudget() })`; renders top bar, hero, mode card (segmented Off/Guard/Heal + model status), app frame + net lane, explain cards (`DEMO_BY_ID[id].wrong/scored` + `def.code`), Try it, Activity, Chaos panel, Trials; `await def.mount(...)`; exposes `window.__demo = { scenario, setChaos, world }` for the screenshot tour; mounts `mountDevtools(gc, { collapsed: ?devtools !== "open", theme, position: "bottom-right" })` (`theme` = forced `data-theme` or `"auto"`; mount errors only `console.warn`) and remounts it collapsed on the `gc-theme` event. The mode card (`modeCard`) shows `MODE_HINT[mode]`, or a kill-switch hint when `?genclass=` is present, or the `?budget` experiment; the model status line repaints on `gc.on("status")` and every 400 ms while loading ("Model ready · wasm · q8 · threads|1 thread · loaded in N s", "Model unavailable … · acting passively", "No model · observing only", or "Development stand-in runtime · no model" for the shim).
4. **Trial page** (`bootTrial`): `body.embed`; `scenario = def.scenario(seed, kind)`; `ServerLink("trial-<demo>-<run>")`, `hello({ reset: true, seed, chaos: scenario.chaos, params: scenario.params })`; `startHeartbeat()` (no `onRestart` handler on trial pages); `pagehide` -> `link.bye()`; `startGenClass(mode, { ..., trace: traceOn() })`; for Guard/Heal waits for `gc.ready` (max 120 s; a rejected `ready` is ignored) **before mounting the app** (the world, and its clock, already exist at this point); mounts; creates `TrialHarness`; waits for `def.loaded` (`harness.check`, max 15 s) or `link.quiet(250, 10000, true)`; `harness.start()` (oracle starts sampling); sets `window.__trial`. `window.__trialReady` resolves to it; failures set `window.__trialError`.
5. Boot failures on either page kind (no Service Worker support, the worker never takes control, any exception) go to `fatal`: an error card ("This demo could not start") replaces the page and `window.__trialError` is set, which the in-page runner and the eval turn into an error result.

### 2. Mock server request path (`src/server/sw.ts` + `src/server/core.ts` -> `World.handle`)

1. `fetch` listener: same origin only. Paths under `<scope>api/` are API calls; other `GET`s with destination `document|iframe|worker|sharedworker` are re-fetched and get `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin` unless `?coi=0` (document URL, or referrer for workers).
2. `resolveSid(clientId)`: the binding from `hello`/`ping`; unknown clients get `{type:"identify"}` and up to 5 s for the page to re-`hello`. No world -> `503 "The demo server lost this session. Reload the page."`
3. `World.handle`: route match by method + regex; log entry (`route` = route key or `"unknown"`; 404 for no route). `c = resolveChaos(chaos, entry.route)`.
4. Stream routes (`stream: true`): offline -> `Response.error()`; outage -> 503; else `openStream` (SSE, first chunk `retry: 1000`, keep-alive comment every 15 s).
5. Normal routes: read body; draw everything up front from `rngFor("<METHOD> <path><search> <raw>")`: timing `sampleTiming`, `fail`, `failCode` ∈ {500, 502, 503}, `commitFail`, `commitCode` ∈ {502, 504}, `hang`, `handlerSeed`.
6. Order: offline -> wait `min(up, 150)` -> network error. Wait `up`. Outage -> wait `down` -> 503. `fail < failRate` -> wait `down` -> 5xx, **no side effects**. Run the handler (world `rng` = `new Rng(handlerSeed)` during the call; exceptions -> 500). `down += res.work × (spikeFactor if spike)`. If `status < 400` and `commitFail < commitFailRate` -> 504 after `max(down, hangMs × 0.5)` or 502 after `down`, outcome `lost`, **side effects stay**. If `hang < timeoutRate` -> `down += hangMs`. Wait `down`, respond JSON (`cache-control: no-store`).
7. `World.publish(type, data, key?)` (live events): one `rngFor("event <type> <key>")` per logical event (`key` defaults to `JSON.stringify(data)`); each open stream gets an independent delay `sampleEventDelay(erng, resolveChaos(chaos, "<demo>/events"))`, so events can overtake each other. Payload `id: <seq>\ndata: {"seq","type",...data}`.
8. Housekeeping: log capped at 6,000 entries, events at 2,000; every 10 s, worlds with no live bound client are disposed once `lastSeen` (last `hello`/`ping`/API call) is more than 15 s (`trial-*`) or 120 s (live) old. `bye` disposes only `trial-*` worlds.
9. Worker lifecycle: `install` -> `skipWaiting()`, `activate` -> `clients.claim()`. Worlds, bindings and `lastSeen` live only in the worker's memory; if the browser stops and restarts the worker, every world is gone. Whichever comes first decides what the page does: a heartbeat `ping` gets `known: false`, the page re-`hello`s (fresh world) and the interactive page reloads via `onRestart`; an API call triggers `identify`, the page re-`hello`s and gets a fresh world silently (no `onRestart`, and the next ping then says `known: true`). A stream route (`board/events`) is logged as `ok` the moment the stream opens.

### 3. Chaos timing model (`src/shared/chaos.ts`)

1. `sampleTiming(rng, c)`: `median = max(1, latency)`, `sigma = ln(1 + jitter / median)`, `total = clamp(lognormal(median, sigma), 2, 30000)`; spike with probability `spikeRate` multiplies `total` by `max(1, spikeFactor)`; `up = total × U(0.25, 0.5)`, `down = total − up`; if `reorder > 0`, `up += Exp(reorder × max(median, 40))`, `down += Exp(that × 0.5)`.
2. `sampleEventDelay(rng, c)`: `median = max(4, latency × 0.4)`, `sigma = ln(1 + jitter / max(1, latency))`, `clamp(lognormal, 1, 20000)`, plus `Exp(reorder × max(latency, 40))` when `reorder > 0`.
3. Interactive chaos is changed by `mountChaosPanel` (debounced 120 ms; `setChaos(chaos, true)` and `saveChaos` to `localStorage["gc-demo-chaos-<demo>"]`). Preset buttons apply `withPreset(id)` but keep the current `routes`; "Reset" goes back to `{ ...CALM, routes: {} }`; the pressed preset is `matchPreset(chaos)` (compares every global key, ignores routes); the summary line is `describeChaos`. `hangMs` has no slider (the "Hangs (6–8 s)" label assumes the preset/CALM values). Trials set chaos in `hello` and may patch it mid-session with `chaos` steps.
4. Merge semantics (`mergeChaos(base, patch)`): global keys are shallow-replaced; `patch.routes[k]` is merged into the existing rule for `k`; `patch.routes[k] = null` deletes that rule. `World.setChaos(patch, replace)` merges into the current chaos, or into a fresh `CALM` when `replace` is true.

### 4. Trial lifecycle (`src/shared/harness.ts` -> `TrialHarness`)

1. Driver calls `begin()` (sets `ctx.t0`), then runs `steps` (synthetic: `runSynthetic()` -> `runSteps(document, steps, hooks)`; Playwright: `e2e/eval.ts` -> `runSteps(page, steps, true)` calling `__trial.check/mark/chaos/server` through `page.evaluate`). `until` timeouts are recorded as `metrics.untilTimeouts`.
2. `finish(driver)`: `tEnd`; `link.world("freeze")`; if `settle !== false`, `link.quiet(idleMs, timeoutMs, ignoreStreams)` (default `{ idleMs: 700, timeoutMs: 20000 }`); then waits **2,500 ms** (350 ms when `settle === false`) so held writes and late reverts land; `oracle.finish()`; oracle exceptions become `{ bug: false, reasons: ["oracle failed"] }` with `error` set (excluded from rates).
3. Returns `TrialResult` with `gc: collectStats(gcs)` and, in trace runs, `trace`.

### 5. Drivers

- **Synthetic** (`src/shared/driver.ts` -> `runSteps`): per typed char `keydown` (`code` `KeyX`/`DigitN`/`Space`), `keypress`, `beforeinput` + `setRangeText` + `input` (`insertText`; `\n` -> Enter), `keyup`; Backspace -> `deleteContentBackward`; Enter in `<input>` -> `form.requestSubmit()`; clicks fire `pointerover/enter`, `mouseover`, `pointerdown`, `mousedown`, focus, `pointerup`, `mouseup`, `click` (+ `dblclick` when `count === 2 && gap < 300`); clicks on disabled controls do nothing; selectors are awaited up to 5 s (clicks 4 s). All waits use native timers. The runtime's DOM observer keeps untrusted events when no app op is running (`packages/runtime/src/observe/dom-user.ts` -> `programmatic`).
- **Playwright** (`e2e/eval.ts` -> `runSteps`): `page.keyboard.type/press` (one char at a time after its delay; missing delays default to 90 ms in both drivers), `locator.click` (click waits up to 1,500 ms for an enabled, visible element on the first click, 200 ms on repeats; `click` timeout 2,000 ms, errors ignored), `waitForFunction` for `until` (polling 25 ms); `wait` is `page.waitForTimeout` (Node side, invisible to the runtime). With `harness = false` (screenshot tour on the interactive page) `mark` is skipped, `chaos`/`server` go through `window.__demo`, `until` just waits `min(1500, timeout)` and `unless` is never true.
- `TrialHarness.check(cond)` returns `false` when the oracle has no `check` or throws, so a broken condition makes `until` steps time out (counted in `metrics.untilTimeouts`) instead of failing the trial.

### 6. In-page trial runner (`src/site/trials-panel.ts` -> `mountTrials`)

1. Plan: `n` chaos seeds `1000..1000+n−1` and `clean = max(2, ceil(n/2))` clean seeds `1500..` (checkbox can disable clean), each × Off/Guard/Heal; `n` ∈ {3, 6, 10, 20, 30}, default 6.
2. Each job loads `?embed=trial&mode&kind&seed&run` in one iframe (keeps `budget`, `model`, `coi` from the page URL), polls every 50 ms for `__trialReady`, calls `harness.runSynthetic()`; 150 s timeout per trial; errors are recorded as error results.
3. Job order: every chaos seed with Off, Guard, Heal in turn, then every clean seed; one iframe at a time. "Stop" finishes the current trial first. Errored trials get a placeholder result (`label: "–"`, `gc.runtime: "real"`, `gc.status: "error"`).
4. Table via `summarizeMode` (columns: bug rate with meter, false interventions / clean runs, clean bugs, fixed / new, clean latency p50 with delta to Off, model decision p50) plus a per-trial log; "Copy JSON" copies raw results. The placeholder asks to keep the tab visible while trials run (background tabs throttle timers).

### 7. Headless eval (`e2e/eval.ts`)

1. Requires `dist/index.html` (exit 2 otherwise). Model: `--model` default `genclass-model/` when `dist/genclass-model/model.json` or `<--model-dir|GENCLASS_MODEL_DIR>/model.json` exists, else `cdn`.
2. `serveStatic(dist, "/genclass/", 4173, { "genclass-model": MODEL_DIR })` (the mount only when `MODEL_DIR` is set; with `--model genclass-model/` and no local model it logs a warning and Guard/Heal run without a model); Chromium headless. Before the trials it records `servedCard()` (the served `model.json` name/version/variants, or `{ source }` for `cdn` / unreachable URLs) and `runtimeBuild()`; `IS_V01` (card name `genclass-model`, version `0.1*`) adds the "general classifier, not trained for runtime decisions" sentence to the results note.
3. `planJobs()`: for `i < max(N, CLEAN)`, for each demo: chaos seed `SEED_BASE + i` (if `i < N`) and clean seed `SEED_BASE + 500 + i` (if `i < CLEAN`), each × modes. `WORKERS` browser contexts (1280×900) pull from one queue; each context first `warmUp` (opens `search/?mode=off`, waits for `crossOriginIsolated` and a mounted app, 30 s).
4. `runTrial`: new page at the trial URL (`embed=trial`, `mode`, `kind`, `seed`, random `run`, `model=<MODEL>`, plus `budget`/`trace=1` when set; `goto` 60 s), wait for `__trial` or `__trialError` (150 s), `begin`, real-input steps, `__trial.finish("playwright")`; adds `metrics.untilTimeouts` and `metrics.pageErrors`; whole trial capped at `--trial-timeout` (180 s); any failure becomes an error result (`failed`). Partial results every 12 trials to `e2e/.out/partial.json`. Results are written to `--out` (default `demos/`); `e2e/.out/` is always under `demos/`. The run then prints the first 16 lines of `results<SUFFIX>.md`.
5. `writeReports`: `results<SUFFIX>.json` (summaries + `raw`), `results<SUFFIX>-summary.json` (no raw; copied to `dist/` only when `SUFFIX` is empty, i.e. no `--tag` and no `--budget`), `results<SUFFIX>.md`; with `--trace`, `e2e/.out/traces<SUFFIX>.json`. Records `model.card` (served `model.json`), `runtimeBuild` (`packages/runtime` version + sha256 of `dist/**/*.js`, 12 hex), `policy`, seeds, definitions. JSON top-level keys: `generatedAt`, `runtime`, `model { name, note, status, baseUrl, card, tag? }`, `runtimeBuild`, `driver`, `policy` (`"runtime defaults"` or `{ holdBudgetMs, note }`), `trials { chaos, clean }`, `modes`, `seeds { chaos: "a..b", clean: "a..b" }`, `definitions`, `demos` (`<id>` -> `DemoSummary.modes`), `raw` (`TrialResult[]` without `trace`). `results.md` = header (runtime, model note), driver line, summary table (`mdTable`), one section per demo (`mdDemo`: per-mode sentence with Wilson CI, false interventions, fixed/introduced, actions and "chosen but not run" reasons; a table of mean metrics `chaos.*`/`clean.*` per mode; the top 5 Off bug reasons with digits masked as `#`), then "How to reproduce".
6. Screenshot tour (unless `--no-shots`; `--shots-only` skips the trials): light and dark contexts (1440×1000): `index.png` / `index-dark.png` (+ `index-full.png` light), `<demo>.png` / `<demo>-dark.png` (Guard, devtools open, waits up to 90 s for the model status to leave `loading`, clicks the preset button named by `SHOT_PRESET` = search/editor/board/decisions `Busy`, checkout/status `Flaky`, then the first 40 steps of `scenario(1003, "chaos")` via `window.__demo`), light only: `<demo>-page.png` and `<demo>-full.png` (devtools collapsed; viewport / full page), `decisions-heal.png` (Heal, Storm), `search-trials.png` (in-page runner with 3 chaos + 2 clean seeds per mode; skip with `--no-trials-ui`); mobile 390×844: `index-mobile.png`, `search-mobile.png`.

### 8. Aggregation (`src/shared/aggregate.ts` -> `summarizeMode`)

1. Bug rate: `wilson(k, n)` (z = 1.96) over non-error chaos trials; clean bug rate likewise.
2. `falseInterventions` = sum of `gc.interventions.length` on clean trials; `cleanTrialsWithIntervention`.
3. Paired fixed/introduced vs Off on the same chaos seed (skips pairs with errors).
4. `latencyMs` / `latencyChaosMs` = median (`quantile(…, 0.5)`, linear interpolation) of `metrics.latencyMs` over clean / chaos trials; `decisionP50`/`P95` over all `decisionLatencyMs`; `metrics` = mean of each metric key, prefixed `chaos.` / `clean.`.

### 9. GenClass wiring (`src/shared/genclass.ts` -> `startGenClass`)

1. `policy = holdBudgetMs ? { holdBudgetMs } : undefined` (`?budget=<ms>`).
2. Trace runs pass `hooks: traceHooks(trace)` (cast through `Partial<InitOptions>`; `GenClass.init` spreads options into `createRuntime`) and `attachTrace` subscribes to `event` (`state`, `op.start`, `user`) and `decide`.
3. Off: `GenClass.init({ mode: "observe", model: false, plugins, policy })`. Guard/Heal: `GenClass.init({ mode, model: { baseUrl?, preload: "eager" }, plugins, debug, policy })`.
4. Session arrays fed by `gc.on("decide" | "detect" | "act" | "report")`; `readyAt` from `gc.ready`.
5. `collectStats(session)` -> `GcStats`: `runtime` = `RUNTIME_KIND` (from the `__RUNTIME_KIND__` define), `isolated` = `crossOriginIsolated`, `status`/`model`/`device`/`variant` from `gc.status`, `loadMs` = `status.loadMs` or `readyAt − initAt`, `diagnoses` counted over all decisions, `notExecuted` over decisions with `!executed && reason`, `interventions` = every `act` record (`{ action, tier, trigger, changed, at }`), `decisionLatencyMs` rounded to 0.1 ms. `statusText(gc)` formats `gc.status` for compact display.

### 10. The six demos

Common: each `main.ts` calls `bootDemo` with `host`, `mount`, `scenario`, `oracle`, `code` and optional `loaded`, `settle`, `chaosExtras`, `serverParams`, `plugins`. Scenario RNG: `new Rng("<demo>:<kind>:<seed>")`; server world RNG: the numeric trial seed (`state` from `Rng(seed)`, request handlers from CRN, scripts from `Rng(seed ^ 0xc0ffee)`). Clean chaos is always `CLEAN_CHAOS` (45 ± 15 ms, no failures, no spikes, no reorder).

#### search: city typeahead (`src/demos/search/`)

| Aspect | Detail |
|---|---|
| App | `app.ts` -> `mountSearch`: input -> atom `input`/`loading`, 150 ms debounce (`setTimeout`), `GET /api/search?q=` -> `search.set({ query, items, total })`. |
| Latent bug | no ordering guard (no AbortController, no request id): an older, slower answer can overwrite newer results. |
| Store | `gc.atom<SearchState>("search", { input, query, items, total, loading, error })`. |
| Server | `worlds/search.ts`: route `GET /search` (key `search`), `searchCities(q)` from the missing `data/cities.ts`; `work = 20 + min(total, 60) × 9` ms (short prefixes slower). |
| Scenario | 1 round, or 2 with P 0.45 (chaos) / 0.3 (clean); city from `TYPED_TARGETS`, 70% lowercased, 50% typed in full else stopped at 4..len (min 3); round 2 clears with one Backspace per char (40–90 ms); chaos: 60% "glance" pause after 2–3 chars if > 4 chars; marks `typed<r>`, `lastKey`; waits 1.6–2.6 s. Intent `{ finalQuery, queries }`. Typist: clean `CALM_TYPIST`, chaos `FAST_TYPIST` with median 110–210 ms. Chaos ranges: latency 120–650, jitter 80–550, reorder 0–0.7, spikeRate 0–0.12, failRate 0–0.04, spikeFactor 4. Settle: default. |
| Oracle | samples every 20 ms; `ok` = shown ids equal `searchCities(input).items` ids. Bug if final list wrong, or `staleMs ≥ STALE_BUG_MS` (400) where stale time counts only while an answer for the current text (sent since the text changed) arrived ≥ `GRACE_MS` (350) earlier. Metrics `finalWrong`, `staleMs`, `wrongVisibleMs`, `staleShare`, `latencyMs` (last keystroke -> list correct and stays correct), `requests`. Condition `settled`. |

#### editor: notes autosave (`src/demos/editor/`)

| Aspect | Detail |
|---|---|
| App | `app.ts` -> `mountEditor`: `DEBOUNCE_MS` 700, `MAX_WAIT_MS` 3000 (save immediately if the first unsaved edit is ≥ 3 s old), `TYPING_GUARD_MS` 300, `REFRESH_MS` 5000 background refresh (skipped unless status `saved`/`idle` and no key in 2 s), retry after a failed save 2000 ms. |
| Latent bugs | saves not serialised (overlap, out-of-order at server); echo applied unless a key was pressed in the last 300 ms (`applyBody`); any success shows "Saved"; refresh checks local edits when it starts, not when it answers. |
| Store | Redux `legacy_createStore(reducer, initial, genclassEnhancer(gc, { name: "notes" }))` (`store.ts` -> `createNotesStore`). Actions `notes/listed`, `note/loaded`, `note/selected`, `note/edited`, `save/started`, `save/succeeded {note, applyBody}`, `save/failed`. `SaveStatus = "idle" \| "dirty" \| "saving" \| "saved" \| "error"` is rendered as `save-status[data-state]`; `save/succeeded` with `applyBody: false` keeps the local body but takes the server's `version`. |
| Server | `worlds/editor.ts`: `GET /notes` (`notes`), `GET /notes/:id`, `PUT /notes/:id` (both `notes/item`); PUT bumps `version`, appends `history` (cap 400, keeps entry 0), `work = 15 + body.length × 0.02`. Seed notes `n1` Launch checklist, `n2`, `n3`. |
| Scenario | click body, caret end, 2–4 bursts of sentences (first prefixed `\n`); pauses clean 0.9–2.6 s, chaos 0.25–2.2 s; mark `lastKey`; wait 1.2–2.0 s. Chaos typist `FAST_TYPIST` median 120–200, typoRate 0.04. Chaos: latency 100–900, jitter 60–700, reorder 0–0.8, failRate 0–0.1, spikeRate 0–0.1, spikeFactor 4. `loaded: "loaded"`, settle `{ idleMs: 900, timeoutMs: 25000 }`. Intent `{ noteId: "n1", typed }`. |
| Oracle | samples text + `data-state` every 25 ms. Bug if editor text ≠ seed body + typed (`lostLocal`), server body ≠ editor (`lostServer`), final "saved"/"idle" while server differs (`finalLie`), else a "Saved" lie run > `LIE_BUG_MS` (1500). Metrics `lieMs`, `maxLieMs`, `reverts` (text shrank to a prefix by > 1 char), `saves`, `latencyMs` (last key -> saved and true). |

#### checkout: cart and checkout (`src/demos/checkout/`)

| Aspect | Detail |
|---|---|
| App | React 19 `app.tsx` -> `Store`: optimistic add/qty/remove with `fetchWithTimeout` 4,000 ms; `placeOrder` posts `{ lines, total }` with 5,000 ms timeout, retries 5xx/timeouts/network up to 3 attempts with `600 × attempt` ms backoff (a 4xx shows the server's error and stops). `place-order` is disabled only when the cart is empty and no order is placing (class `busy` while placing); `add-<sku>`/`inc-<sku>` disable at stock; in-app toast 3,500 ms. Test ids: `add-`, `inc-`, `dec-`, `remove-<sku>`, `cart`, `cart-count`, `cart-line[data-sku]`, `line-qty`, `line-price`, `cart-total`, `place-order`, `order-error`, `order-confirmation`, `placed-order`, `app-toast`. |
| Latent bugs | Place order stays clickable while placing; retries without an idempotency key; total maintained incrementally (failed changes revert the line but not the total; a revert restores the quantity captured at click time). |
| Store | `useGenClassState<Cart>("cart", EMPTY, { resync: () => reloadCart() })`, `useGenClassState<Orders>("orders", …)`; products in plain `useState`. No provider (adapter falls back to `GenClass.runtime`). |
| Server | `worlds/checkout.ts`: `PRODUCTS` (mug 1800¢ stock 8, tee 2900/5, cap 2400/3, tote 1600/10, notebook 1200/6, stickers 600/4); `GET /products`, `GET /cart`, `POST /cart/lines` and `PATCH\|DELETE /cart/lines/:sku` (key `cart/lines`, clamp to stock), `POST /orders` (key `orders`, 201, id `A-1041…`, `work` 120, total taken from the client, clears cart), `GET /orders` (`orders/list`). Snapshot includes `cartHistory`. |
| Scenario | until `loaded`; 2–4 products (chaos: 25% double add); 1–3 `+` clicks on 1–2 lines; 30% one `−`; mark `order`; click style clean `once`, chaos weighted double 0.35 (gap 70–180 ms) / impatient 0.3 (re-click after 1.2–2.6 s `unless: "orderDone"`) / once 0.35; until `orderDone` (20 s); wait 900 ms. Intent `{ orders: 1, qty }`. Conditions: `loaded` (any `add-<sku>` button), `orderDone` (confirmation or error shown and not placing). Chaos: latency 150–700, jitter 100–500, failRate 0.03–0.2, commitFailRate 0.02–0.12, timeoutRate 0–0.06, spikeRate 0–0.1, hangMs 6500, spikeFactor 5. Settle `{ 900, 25000 }`. |
| Oracle | samples every 30 ms. Bug if orders > intended (1), "Order placed" without an order, error shown but order placed, still placing, any order whose `total ≠ Σ qty × price` (wrong charge), displayed total ≠ sum of displayed lines at the end or for > `DRIFT_BUG_MS` (1000), or (no order) screen cart ≠ server cart. Metrics `ordersCreated`, `duplicates`, `wrongCharges`, `driftMs`, `maxDriftMs`, `errorsShown`, `latencyMs` (`order` mark -> first confirmation). |

#### status: service status dashboard (`src/demos/status/`)

| Aspect | Detail |
|---|---|
| App | `app.ts` -> `mountStatus`: `POLL_MS` 2000 `setInterval(refreshAll)` (never waits), per-service `GET /api/status/:id` with 4,000 ms timeout, up to 3 attempts with no backoff, then status `unreachable` + banner (last 3 kept); render every 1 s; Refresh button. |
| Latent bugs | overlapping poll rounds; immediate retries (retry storm); one failed poll = "Unreachable" + error banner. |
| Store | the app's own `createStore` handed over with `gc.guard("services", raw, { resync: () => refreshAll() })`. |
| Server | `worlds/status.ts`: `SERVICES` api, auth, payments, search, notify, cdn; route `GET /status/:id`, key `status/<id>`; `truthAt(incidents, svc, t)`; reply `latencyMs` 35–95 (operational), 400–1200 (degraded), null (down); `work` 4. Random incidents (interactive): first after 6–15 s, then every 20–45 s, 35% down, 8–20 s. Actions `incident {svc, status, dur}`, `resolveAll`. Extras panel: "Real incidents (12 s)". |
| Scenario | params `{ incidents, randomIncidents: false }`: 1–2 incidents (40% down) at 3–9 s for 3.5–7 s. Clean: Refresh once, wait 9–12 s. Chaos: 1–3 routes with `failRate` 0.25–0.6, one route `spikeRate` 0.15–0.4 × 5–9; global latency 80–320, jitter 50–260, failRate 0–0.06, timeoutRate 0.02, hangMs 6000; Refresh 1–3× (gap 150–450 ms); 70%: one route `outage: true` for 4–8 s (the status API is down, the service is fine). Both kinds start with `until loaded` (10 s) then wait 2–3.5 s. `loaded: "loaded"` (no card shows `unknown`), `settle: false`, interactive `serverParams: { randomIncidents: true }`. Note: a status route keeps answering **200** while the service is `down`; only chaos produces HTTP failures. |
| Oracle | samples every 50 ms, ignores the first `GRACE_MS` (3500) after t0. A card may show any truth from `[t − 3500, t]`. Bug if `falseAlarmMs > 1500` (red while no red allowed), `missedMs > 1500` (true `down` not shown), `otherMs > 3000` (including `unknown`), any banner, or requests > 1.5 × ideal (`6 × (session / 2000 + refresh clicks)`, counting `status/*` requests between `t0` and `tEnd`). Metrics `falseAlarmMs`, `missedMs`, `otherWrongMs`, `banners`, `requests`, `requestRatio`, `latencyMs` (mean delay from a true transition inside `[t0, tEnd − 3500]` to the card first showing it). |

#### board: team kanban (`src/demos/board/`)

| Aspect | Detail |
|---|---|
| App | React 19 + Zustand; `EventSource(api("board/events"))` -> `applyEvent`; optimistic `move` with `pending: true` ("syncing"), confirmation replaces the card; failure restores the whole `before` snapshot + notice (auto-dismiss 4 s). `applyEvent` replaces the card with the event's copy and sets `pending: false`, so any echo ends "syncing". Arrow buttons `mv-left-<id>`/`mv-right-<id>`, drag and drop; `live` indicator from `EventSource.onopen/onerror`. |
| Latent bugs | events applied with no version check; echo of your own move can land after your next move; whole-board rollback discards updates that arrived meanwhile. |
| Store | `create<BoardState>()(genclass(gc, "board", { resync })(creator))` (`store.ts` -> `createBoardStore`); `resync` calls the store's own `load()`. |
| Server | `worlds/board.ts`: `COLUMNS` backlog/doing/review/done; `BOARD_SEED` c1–c10; `GET /board` (`board`, work 20), `POST /cards/:id/move` (`board/move`), SSE `GET /board/events` (`board/events`). Every move bumps `version` and publishes `card.moved` with CRN key `<id>:v<version>:<column>:<by>`. Teammates (Ana, Kofi, Mei) move a card every `Exp(teamEveryMs) + 1500` ms (first `+3000`), to a column ≤ 2 away. Action `teammateMove {card?, column?, recent?}` (`recent` = the card the user last moved). Interactive `teamEveryMs` 9000 (`≤ 0` disables teammates); the extras panel has "Teammate moves a card" and "…the one you just moved". Snapshot: `cards` (`{ column, version, updatedBy }` per id) and `moves[]` (`{ t, card, column, by, version }`, `by: "you"` for user moves). |
| Scenario | until `loaded`; 2–3 focus cards (60% of moves); clean 4–6 moves, waits 0.9–1.6 s, `teamEveryMs` 7000; chaos 6–10 moves, 35% immediate re-move (110–260 ms), 30% simultaneous `teammateMove` of the same card, waits 0.15–0.9 s, `teamEveryMs` 2000–4000; mark `lastMove`, wait 1.5 s. Chaos: latency 150–600, jitter 100–500, reorder 0.3–0.9, failRate 0.03–0.15, spikeRate 0–0.08, spikeFactor 4. Settle `{ 800, 25000 }`. |
| Oracle | samples columns and `data-pending` every 50 ms. Allowed column at t: server column at `t ± WINDOW_MS` (1500) or any move in that window. Bug if any card's final column ≠ server, else a divergence run > 2000 ms; plus cards still pending at the end. Metrics `finalMismatches`, `divergedMs`, `maxDivergedMs`, `jumpBacks`, `userMoves`, `teammateMoves`, `latencyMs` (last move -> board equals server). `details` carries mismatched cards for `trace-report.ts`. |

#### decisions: field journal (`src/demos/decisions/`)

| Aspect | Detail |
|---|---|
| App | `app.ts` -> `mountDecisions`: four typed questions with `{ timeoutMs: 2500 }`, each falling back to an app default on rejection: backup `gc.ask({ type: "noul", … })` (`noul ≥ 0.5` -> start; default start now; a postponed click retries once after 6 s); photo quality `gc.decide(…, { full, reduced, thumbnails })` (default `full`); leave `gc.ask noul` (default: the `dirty` flag, cleared when a save starts); connection health `gc.ask({ type: "score", criteria: failing…excellent })` rounded to a level (default `good` if `navigator.onLine`). Journal autosave 800 ms after typing; heartbeat `GET /api/ping` every 2,500 ms. Decisions log rendered as `[data-testid="decision"]` with `data-q/answer/source/asked-at/ms`. |
| Latent bug | the fixed defaults are wrong exactly when it matters (typing, struggling network, failed save). |
| Store | `gc.atom("journal", …)`, `gc.atom("gallery", …)`; plugin `backgroundWorkPlugin(jobs)` passed through `plugins()`. |
| Plugin | `plugin.ts`: `setup` listens to `visibilitychange`, `online`/`offline`, Battery API, and `jobs` events; records the backup as an op `api.recordOp("task", "background photo backup", …)` / `endOp`; `facts()` (backup progress, background tab, offline, battery < 20% discharging); action `pause_background` (`on: ["failure", "stall"]`, tier `heal`, risk `low`, `applicable` while a job runs, `ctx.describe(...)`, `ctx.onUndo` resumes). Plugin name `background-work`; custom events via `api.emit`: `page.visibility`, `network.online`, `network.offline`, `battery`, `backup.paused`, `backup.resumed`. |
| Jobs | `jobs.ts` -> `BackgroundJobs extends EventTarget` (singleton `jobs`): `start()` (`POST /api/backup`, then polls `GET /api/backup` every 1,000 ms), `pause()`/`resume()` (`POST /api/backup/pause\|resume`), `running()`, `current: JobInfo \| null` (`{ id, name, startedAt, progress, paused }`); dispatches `start`, `progress`, `end`, `pause`, `resume`, each followed by `change`. |
| Server | `worlds/decisions.ts`: `GET/PUT /journal` (`journal`, `journal/save`), `GET /photos?quality=` (`photos`; bytes full 2.4 MB / reduced 380 KB / thumbnails 24 KB; work 420/150/30 ms), `POST /backup` (`backup`, 202, `BACKUP_MS` 8000), `POST /backup/(pause\|resume)` (`backup/control`), `GET /backup` (`backup/status`), `GET /ping` (`ping`). While an unpaused backup runs (`backupActive`), `journal`, `journal/save` (base work 20), `photos`, `backup/status` get +350 ms `work` and `ping` +175 ms; `POST /backup` (work 40) and `backup/control` get none. Pause/resume with no running job -> 409; resume extends `endsAt` by the paused time. Snapshot: `body`, `version`, `history`, `backups`, `photoLoads`. |
| Scenario | until `loaded`, wait 2.5–4 s. Chaos condition uniform over healthy (latency 50–140, jitter 10–60), slow (650–1300, 150–450, spikeRate 0.05–0.15 × 3), flaky (150–400, 80–250, failRate 0.25–0.45), failing (200–500, 100–300, failRate 0.6–0.85). Moments: clean 3 of {backup-idle, photos, health, leave-saved}; chaos 3–4 of those plus backup-busy, leave-inflight (leave 850–1050 ms after typing, while the save is in flight), leave-failed (`journal/save` failRate 1 during the moment). Leave moments sorted last; a leave moment clicks Leave, waits `until leaveAnswered` (6 s), then clicks Stay `unless: "noConfirm"` and Reopen `unless: "notClosed"`. Typist: clean `CALM_TYPIST`, chaos `FAST_TYPIST` with typoRate 0.02. Intent `{ condition, moments }`. `loaded: "loaded"`, settle `{ 600, 15000, ignoreStreams: true }`. |
| Oracle | recomputes the right answer at each `askedAt` from keys (keydown/input), sampled text, server log and history. Backup = "start now" only if no key in 2.5 s, no `journal/save` in flight, no failure in 8 s and median ok latency over 10 s < 600 ms. Quality over 15 s: failRate ≥ 0.25 -> thumbnails, median ≥ 450 -> reduced, else full. Leave = "warn" if text ≠ stored body or a save in flight. Health over 15 s: level 3 if no requests; failRate ≥ 0.5 -> 0; ≥ 0.2 or median ≥ 900 -> 1; > 0 or ≥ 350 -> 2; ≥ 120 -> 3; else 4; correct within ±1. The backup's own `backup`/`backup/control` routes are excluded. Bug if any decision is wrong. Metrics `decisions`, `wrong`, `accuracy`, `answeredByGenClass`, `latencyMs` (mean ask time), `<q>.n`, `<q>.ok`. Conditions: `loaded` (journal text non-empty), `leaveAnswered`, `noConfirm`, `notClosed`. "Failure" = outcome `rejected`, `lost` or `network`; latency = `tEnd − t0` of `ok` requests. |

### 11. Site shell (`src/site/`)

1. **Landing** (`index.html` -> `src/site/landing.ts`, module side effects, no GenClass runtime on this page): `applyTheme()`, then replaces `#page` with `renderTopbar("home")` and sections `hero` (install snippet with Copy; the three "[GenClass]" console lines are **illustrative copy, not real output**), `modes` (Observe / Guard (default) / Heal adoption path), `demos` (cards from `DEMOS` + `ART`, links `<root><id>/`), `results` (fetches `<root>results-summary.json` with `cache: "no-store"`; reads `demos.<id>.<mode>.chaos.{rate,k,n}`, `falseInterventions`, `cleanTrials`, `decisionP50`, `actions`, plus `model.note`, `trials`, `generatedAt`; shows "No measurements ship with this build yet" when absent), `how`, `observability`, footer (Apache-2.0, `REPO_URL`).
2. **Demo page layout** (`bootInteractive`): top bar; hero (`DEMO_BY_ID[id]` `n`, `tagline`, `title`, `summary`, `stack` badges) + mode card; main column = app frame (`.app-frame` with fake window chrome, `def.host`, mode chip, `.app-body` where the app mounts) + net lane + explain cards (`wrong`, `scored`, `def.code`); side column = Try it (`tryIt` HTML), Activity, Network chaos; then Run trials; footer.
3. **Activity panel** (`activity.ts` -> `mountActivity`): one row per `gc.on("report")` (`kind: "intervene"` counts as "prevented", anything else non-status as "flagged"; `kind: "status"` updates one status row in place). Titles from `ACTION_TITLE` (`discard`, `defer`, `coalesce`, `delay`, `block`, `serve_cached`, `retry`, `hedge`, `rollback`, `resync`) and `DIAG_TITLE` (`stale`, `conflict`, `duplicate`, `inconsistent`, `failing`, `slow`, `transient`, `overload`, `unusual`). "Evidence" calls `gc.explain(id)` and shows `changed`, `facts`, diagnosis and action probability bars, `timeline`, and a toggle for `situationText`. "Undo" calls `ActionRecord.undo()`. Each intervention flashes the app frame (`gc-flash` class) and adds a shield toast over it (max 3, auto-close 7 s). A "Model consulted N× (median …)" line classifies every `decide`: executed with a non-passive tier -> acted, executed passive -> "chose to let it be", otherwise by `reason` substring (`"hold budget"` -> late, `"below the"` -> low confidence, `"expected"` -> judged expected, else not allowed in this mode); an "Observed …" line counts `event`s (`op.start` named like an HTTP method = request, `state` = write, `user`).
4. **Net lane** (`netlane.ts` -> `mountNetLane(link)`): polls `link.log(since)` every 300 ms (re-polling from the oldest pending entry; paused while the tab is hidden) and renders a 10 s waterfall on `requestAnimationFrame` (every ≥ 70 ms): 8 rows of 12 px, label `METHOD path?query` (≤ 34 chars), labels dropped when > 22 bars are visible, class per `LogEntry.outcome` and `spike`, tooltip with status, duration, `effect` and "aborted by the page".
5. **Chaos panel extras**: `DemoDefinition.chaosExtras(link)` renders demo-specific server controls under the sliders: status "Real incidents (12 s)" (service select, Degrade / Start outage -> `world("incident", { svc, status, dur: 12000 })`, Resolve all -> `world("resolveAll")`); board teammate buttons (see the board table).

### 12. Build, dev server and scripts

1. `npm run dev` -> Vite dev server (port 5173, `host: true`); plugin `genclass-demo-dev-sw` (`apply: "serve"`) answers any URL ending in `/sw.js` with `server.transformRequest("/src/server/sw.ts")` (headers `Service-Worker-Allowed: /`, `Cache-Control: no-store`); `ensureServiceWorker` registers it as `type: "module"` because `import.meta.env.DEV`.
2. `npm run build` -> `scripts/build.mjs`: sets `BUILD_ID` (env or `Date.now().toString(36)`), (a) `vite build` with `vite.config.ts` (`base: "./"`, `outDir: "dist"`, `emptyOutDir: true`, `target: "es2022"`, `sourcemap: true`, `chunkSizeWarningLimit: 1500`, `rolldownOptions.input` = `index.html` + each `PAGES` entry whose `<page>/index.html` exists, `worker.format: "es"`), (b) a second `build` (`configFile: false`) of `src/server/sw.ts` as a minified IIFE library (`name: "GenClassDemoServer"`, `fileName: "sw.js"`, `emptyOutDir: false`, `copyPublicDir: false`, only `__BUILD_ID__` defined), then copies `results-summary.json`, writes `dist/build.json` (`{ buildId, at }`) and `dist/.nojekyll`.
3. `npm run preview` -> `e2e/serve.ts`: binds `127.0.0.1`; `/` and the bare base redirect (302) to the base; paths outside the base 404; `mounts` map a sub-path to another directory (eval: `genclass-model/` -> `MODEL_DIR`); path traversal -> 403; directories -> 301 with a trailing slash; `Cache-Control: no-cache` for `sw.js` and `.html`, else `public, max-age=600`; content types include `.wasm` and `.onnx`; **no COOP/COEP headers** (isolation comes from the Service Worker).
4. `npm run fetch-model` -> `scripts/fetch-model.sh public/genclass-model` (args `[dir] [baseUrl] [variant]`, defaults `public/genclass-model`, `https://github.com/MeharPro/GenClass/releases/download/v0.1.0/`, `q8`): runs `node ../packages/runtime/bin/genclass-runtime.mjs fetch-model <dir> --from <url> --variant <v>` then `info <dir>`; if the CLI is missing or fails, curl downloads `model.json` and every file it lists (`variants` matching the variant or `all`, `files`, `bundled`; else `tokenizer.json`, `calibration.json`, `meta.json`), skipping non-empty existing files.
5. `scripts/vm-eval.sh [eval.ts args]` (run from a `scripts/vm.sh` slot, `cd` to the repo root): `npm install` -> `npm run build -w @genclass/runtime` (failure prints `RUNTIME_BUILD_FAILED` and exits unless `ALLOW_BROKEN_RUNTIME=1`) -> model (`GENCLASS_MODEL_URL` set: pass `--model <url>` and download nothing; else download `GENCLASS_MODEL_FROM` (default v0.1 release) into `GENCLASS_MODEL_DIR` (default `~/gcl/models/genclass-v0.1`, or `~/gcl/models/<sanitised url, ≤ 90 chars>` for another source) unless `model.json` exists, variant `GENCLASS_MODEL_VARIANT` default `q8`) -> `npm run build` -> `npm run typecheck` (failure only prints `TYPECHECK_FAILED`) -> `eval.ts` with `GENCLASS_MODEL_DIR` (skipped when `SKIP_EVAL=1`).

## Configuration and constants

### URL parameters and storage (`src/shared/settings.ts`, `src/site/*`)

| Name | Type | Default | Defined in | Effect |
|---|---|---|---|---|
| `?mode=` | `off\|guard\|heal` | localStorage `gc-demo-mode`, else `guard` | `getMode` | demo mode; `setMode` stores it and reloads without the param |
| `?model=` | URL or `cdn` | `VITE_GENCLASS_MODEL_URL`, else `genclass-model/` (relative to site root) | `modelBaseUrl` | model directory; `cdn`/empty -> runtime default `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/` (`packages/runtime/src/model/host.ts` -> `DEFAULT_MODEL_BASE_URL`) |
| `?embed=trial&kind=&seed=&mode=&run=` | | `kind` chaos, `seed` 1, `mode` guard, `run` random | `trialParams` | bare trial page |
| `?trace=1` | flag | off | `traceOn` | trace instrumentation on trial pages |
| `?budget=<ms>` | number > 0 | unset (runtime default) | `holdBudget` | `policy.holdBudgetMs` experiment |
| `?coi=0` | flag | isolation on | `server.ts`, `sw.ts` | no COOP/COEP; no isolation reload |
| `?devtools=open` | flag | collapsed | `demo-page.ts` | devtools overlay starts open (Alt+Shift+G toggles, per README) |
| `?genclass=` | `off\|observe\|guard\|heal` | none | runtime (`killSwitch`) | runtime kill switch / mode override; the mode card shows a hint |
| localStorage | `gc-demo-mode`, `gc-demo-chaos-<demo>`, `gc-demo-theme` | | `settings.ts` | per-browser settings |
| sessionStorage | `gc-demo-sid-<demo>`, `gc-demo-sw-reload`, `gc-demo-coi-reload` | | `settings.ts`, `server.ts` | live session id; one-shot reload guards |

### Chaos (`src/shared/chaos.ts`)

| Name | Value | Effect |
|---|---|---|
| `CALM` | latency 45, jitter 15, all rates 0, hangMs 8000, spikeFactor 5, reorder 0, outage/offline false | base for every world (`mergeChaos({...CALM, routes: {}}, patch)`) |
| `PRESETS.busy` | latency 350, jitter 320, spikeRate 0.08, spikeFactor 5, reorder 0.35 | slow, jittery, reordering |
| `PRESETS.flaky` | latency 160, jitter 120, failRate 0.15, commitFailRate 0.04, spikeRate 0.06, spikeFactor 6 | random 5xx, lost responses |
| `PRESETS.storm` | latency 450, jitter 450, failRate 0.2, commitFailRate 0.05, timeoutRate 0.04, hangMs 6000, spikeRate 0.12, spikeFactor 6, reorder 0.6 | everything |
| `PRESETS.outage` | `outage: true` | 503 for everything |
| `CLEAN_CHAOS` (`scenario-kit.ts`) | latency 45, jitter 15, rates 0, reorder 0 | clean trials |
| Slider ranges (`chaos-panel.ts` -> `SLIDERS`) | latency 5–2000, jitter 0–1500, failures 0–60%, lost 0–30%, slowdowns 0–40%, factor 2–12, reorder 0–100%, hangs 0–20% | interactive controls (push debounced 120 ms) |

### Typing and scenario kit (`src/shared/scenario-kit.ts`)

| Name | Value |
|---|---|
| `CALM_TYPIST` | median 210 ms, sigma 0.28, typoRate 0.03, pauseRate 0.04, pauseMs 500–1100 |
| `FAST_TYPIST` | median 120 ms, sigma 0.4, typoRate 0.06, pauseRate 0.05, pauseMs 400–1200 |
| `keyDelay` | `clamp(lognormal(median, sigma), 35, 900)` |
| `typeSteps` | per char: `keyDelay`, plus a `pauseMs` pause with P `pauseRate` (or P `3 × pauseRate` on a space); typo (letters only, P `typoRate`) = a `NEIGHBOURS` key, then a Backspace `key` step after 160–420 ms, then the right char with a fresh `keyDelay` |

### Harness, eval and server

| Name | Value | Defined in | Effect |
|---|---|---|---|
| default settle | `{ idleMs: 700, timeoutMs: 20000 }` | `harness.ts` -> `finish` | quiescence before scoring |
| post-settle wait | 2500 ms (350 ms when `settle === false`) | `harness.ts` -> `finish` | lets held writes (hold budget up to 800 ms) and late reverts (~2 s) land |
| trial page `gc.ready` wait | 120,000 ms | `demo-page.ts` -> `bootTrial` | Guard/Heal mount after the model is ready |
| `loaded` wait | 15,000 ms (else `quiet(250, 10000, true)`) | `bootTrial` | |
| interactive world seed | 7 | `bootInteractive` | |
| ServerLink heartbeat | ping every 5,000 ms (4,000 ms timeout); control timeout 10,000 ms | `server.ts` | re-`hello` when the worker forgot the session |
| world GC | every 10 s; a world with no live bound client is disposed when its `lastSeen` (last `hello`/`ping`/API call) is older than 15 s (`trial-*`) or 120 s (live) | `sw.ts` | |
| log caps | 6,000 requests, 2,000 events; body logged up to 400 chars | `core.ts` | |
| SSE | `retry: 1000`; keep-alive every 15,000 ms | `core.ts` -> `openStream` | |
| `--n` | 30 (`--fast`: 4) | `eval.ts` | chaos trials per mode per demo |
| `--clean` | `ceil(N / 2)` (`--fast`: 2) | `eval.ts` | clean trials per mode per demo |
| `--demos`, `--modes`, `--kinds` | all six; `off,guard,heal`; `chaos,clean` | `eval.ts` | |
| `--workers` | 8 | `eval.ts` | parallel browser contexts |
| `--seed-base` | 1000 (clean = base + 500) | `eval.ts` | |
| `--base`, `--port` | `/genclass/`, 4173 | `eval.ts` | static server sub-path and port |
| `--trial-timeout` | 180,000 ms | `eval.ts` | |
| `--model`, `--model-dir` | `genclass-model/` if a local model exists else `cdn`; `GENCLASS_MODEL_DIR` | `eval.ts` | |
| `--tag`, `--budget` | none | `eval.ts` | `SUFFIX` = `-<tag>` and/or `-budget<ms>`; writes `results<SUFFIX>.*` (not copied to `dist/`); `--budget` also adds `budget=<ms>` to trial URLs |
| `--trace`, `--out`, `--no-shots`, `--shots-only`, `--no-trials-ui` | flags; `--out` default `demos/` | `eval.ts` | `--trace` adds `trace=1` to trial URLs and writes `e2e/.out/traces<SUFFIX>.json`; `--out` = directory for `results<SUFFIX>.*` |
| eval exit / warm-up | exit code 2 when `dist/index.html` is missing; warm-up 30 s (`crossOriginIsolated` and `.app-body > *`) | `eval.ts` | a failed warm-up is only logged |
| trial runner (in-page) | `n` ∈ {3, 6, 10, 20, 30}, default 6; clean `max(2, ceil(n/2))`; seeds 1000.. / 1500..; poll 50 ms; 150,000 ms per trial | `trials-panel.ts` | |
| net lane | window 10,000 ms, 8 rows × 12 px, poll 300 ms, render ≥ 70 ms apart, labels off above 22 bars | `netlane.ts` | |
| activity | shield toasts max 3, auto-close 7,000 ms; row "fresh" highlight 2,500 ms; prevented/flagged badges update on each report; "Model consulted" and "Observed" lines repaint every 500 ms; relative times every 5,000 ms | `activity.ts` | |
| site toast | 3,200 ms default | `dom.ts` -> `toast` | |
| `onRestart` reload delay | 1,500 ms | `demo-page.ts` | |
| `npm run dev` / `build` / `preview` | `vite` / `node scripts/build.mjs` / `node --experimental-strip-types e2e/serve.ts dist --base /genclass/ --port 4173` | `package.json` | see [How it works §12](#12-build-dev-server-and-scripts) |
| `npm run typecheck` / `typecheck:shim` | `tsc --noEmit` over `tsconfig.json` (or `tsconfig.shim.json`), `tsconfig.sw.json`, `tsconfig.node.json` | `package.json` | the root `npm run typecheck` (`--workspaces --if-present`) also runs the demos' one |
| `npm run fetch-model` / `eval` / `eval:fast` / `shots` | `bash scripts/fetch-model.sh public/genclass-model` / `e2e/eval.ts` / `e2e/eval.ts --fast` / `e2e/eval.ts --shots-only` (the three eval scripts via `node --experimental-strip-types`) | `package.json` | |
| `VITE_GENCLASS_MODEL_URL` | build-time env, unset by default | `settings.ts` -> `modelBaseUrl` | default model directory when `?model=` is absent |
| dev server | port 5173, `host: true` | `vite.config.ts` | |
| `GENCLASS_SHIM` | `1` force shim, `0` force real; default shim iff `packages/runtime/dist/index.js` missing | `vite.config.ts` | |
| `BUILD_ID` | env or `Date.now().toString(36)` | `vite.config.ts`, `build.mjs` | page/worker version match |
| `vm-eval.sh` model | default `https://github.com/MeharPro/GenClass/releases/download/v0.1.0/` -> `~/gcl/models/genclass-v0.1`, variant `q8` | `scripts/vm-eval.sh` | `GENCLASS_MODEL_FROM`, `GENCLASS_MODEL_DIR`, `GENCLASS_MODEL_URL` (pass `--model`, serve nothing), `GENCLASS_MODEL_VARIANT` |
| runtime policy defaults (not demos code) | thresholds report 0.6 / guard 0.9 / heal 0.8; `holdBudgetMs: "auto"` = clamp(1.5 × median latency, 150, 800), 300 when unknown | `packages/runtime/src/decide/policy.ts` -> `policyConfig`, `holdBudget` | explains `notExecuted` reasons |

## Invariants and gotchas

- **Test code must use native timers.** The six oracles, `driver.ts`, `server.ts` (whose `wait` the harness uses) and the site files `activity.ts`, `chaos-panel.ts`, `demo-page.ts`, `dom.ts` (`toast`), `netlane.ts`, `trials-panel.ts` import from `src/shared/native.ts`. Using `setInterval`/`setTimeout` there makes the runtime's timer observer see test ops (e.g. "interval 0.05s") that can become the cause of app writes (`NEEDS.md` §4). App code must keep using the normal globals.
- **Control traffic never goes through `fetch`.** Everything test-side (chaos, truth, log, quiet, world actions) uses `ServerLink.send` (`postMessage` + `MessagePort`). Adding a test-side `fetch` makes GenClass observe it.
- **CRN keys must be run-independent.** `rngFor` keys include method, path, query and raw body; event keys exclude timestamps (board uses `<id>:v<version>:<column>:<by>`). Putting a timestamp or random id in a request body or event key re-rolls the network per mode and breaks paired comparisons (the board's "9 introduced" was partly this before CRN, per `NEEDS.md` §4).
- **World scripts use `scriptRng` and `World.script`**, so request timing does not shift teammates/incidents, and `freeze` stops them before scoring.
- **Same wait in every mode.** The 2.5 s post-settle wait applies to Off too; do not make it mode-dependent.
- **Oracles read only the DOM and server truth.** They rely on `data-testid` and `data-*` attributes (`search-results [data-id]`, `note-body`, `save-status[data-state]`, `cart-line[data-sku]`, `line-qty`, `line-price`, `cart-total`, `placed-order`, `order-error`, `place-order.busy`, `svc-<id>[data-state]`, `banner`, `col-<id>`, `[data-card][data-pending]`, `decision[data-q][data-answer][data-asked-at]`, `leave-confirm`, `closed`). Renaming any of these silently changes scores.
- **Latent bugs are the point.** Do not fix app bugs (ordering guards, idempotency keys, version checks) and do not tune apps for GenClass; that invalidates the evaluation (`docs/runtime/CONTRACT.md` §0 rule 4 and §12).
- **Honesty rule:** demos never import or read `sim/` and vice versa (verified: no code references either way; `sim/README.md` mentions `demos/` only to say it was not read). Allowed hints are stores via runtime/adapters, `resync` where the app already has a loader (cart, board, status), and the decisions demo's plugin and questions.
- **Trial pages wait for the model** in Guard/Heal before mounting; Off mounts immediately. Decision latency includes queueing: the model host answers one request at a time, and 8 parallel eval workers share the VM's CPU (impact on latency unmeasured).
- **Clean trials of a seed differ from chaos trials of the same seed** (scenario RNG includes `kind`); clean seeds also start at base + 500.
- **Status uses `settle: false`** because polling never stops; it gets only 350 ms after freeze.
- **The world clock starts before the model wait (fairness risk, inferred from code; impact unmeasured).** `bootTrial` sends `hello` (world created, `WorldDef.start` runs) and only then waits for `gc.ready` in Guard/Heal, while Off mounts at once. Status incidents (`from = w.created + at`, at 3–9 s), board teammate moves (`Exp(teamEveryMs) + 3000` ms after start) and anything else scheduled with `World.script`/`after` therefore happen earlier relative to the session `t0` in Guard/Heal, by roughly the model load time (`gc.loadMs` 672–2,077 ms over the 540 Guard/Heal trials in `results.json`, median ~834 ms). Per-request CRN draws are unaffected. Moving `hello` after the model wait, or scheduling scripts from a `start` world action sent at `begin()`, would remove the offset; either changes every seed's results.
- **Clocks across contexts.** Oracles compare page `epochNow()` with Service Worker log times (both `performance.timeOrigin + performance.now()`, but of different globals); the decisions app stamps `askedAt` with `Date.now()`. These agree to within clock skew, which matters only for windows close to the boundary (e.g. "no key in 2.5 s").
- **The activity panel parses runtime reason strings** (`"hold budget"`, `"below the"`, `"expected"`) to classify decisions; rewording `Decision.reason` in the runtime silently moves counts between buckets (the same applies to `notExecuted` keys in results).
- **Mock-server state is in worker memory only.** A Service Worker restart loses every world. The interactive page reloads (`onRestart`) only if its heartbeat `ping` notices first (`known: false`); if an app request arrives first, `identify` makes it re-`hello` into a fresh, reset world without reloading. A trial in flight gets a fresh, empty world the same way and will usually be scored as a bug or fail its `until` steps.
- **Isolation needs the worker.** `e2e/serve.ts` and the Vite dev server send no COOP/COEP; the first visit is not isolated and reloads once (`gc-demo-coi-reload`); iframes (`window.top !== window`) never reload, they rely on the worker adding headers to `iframe` requests.
- **`hello` for an existing `sid` with a different `demo` replaces the world** (disposes the old one). Session ids are per demo (`live-<demo>-…`, `trial-<demo>-…`), so this only happens if ids are reused by hand.
- **The landing page's three "[GenClass]" console lines are hand-written examples** in `landing.ts` -> `hero`, not captured runtime output. (Its "x-genclass header" claim does match the runtime, which sets `x-genclass` on responses it synthesises, e.g. `packages/runtime/src/observe/xhr.ts` blocked responses.)
- **`react-dom` hoisting:** `packages/runtime/UI-NEEDS.md` notes that the runtime's React adapter tests resolve `react-dom/client` only because the `demos` workspace hoists it; removing `react`/`react-dom` from `demos/package.json` can break runtime tests.
- **Unused helpers** (safe to delete or use): `World.every`, `World.openStreams`, `Rng.fork`, `dom.ts` -> `svg`, `icons.ts` -> `IconName`, `protocol.ts` -> `ServerInfo`.
- **The Service Worker build is separate.** `scripts/build.mjs` builds `dist/sw.js` as a classic IIFE; in dev, `vite.config.ts` serves `/src/server/sw.ts` at any `*/sw.js` as a module worker. `tsconfig.sw.json` includes only `src/server/**` and `src/shared/{chaos,rng,protocol}.ts`: the worker must not import DOM code.
- **`build.mjs` uses `emptyOutDir: false` for the worker** and copies `public/` (including a fetched `public/genclass-model/`) into `dist/`, so a self-hosted model ships with the site.
- **`vm-eval.sh` refuses to measure a half-built runtime** (tsup cleans `dist/` first) unless `ALLOW_BROKEN_RUNTIME=1`; typecheck failures only print `TYPECHECK_FAILED`.
- **Two Off notions:** demo Off (`observe`, `model: false`, stats still collected) vs `?genclass=off` (runtime kill switch: nothing installed).
- **`act` counts as an intervention** even when the action failed (`ok: false`) or was a late revert; `notExecuted` is keyed by the runtime's reason string with numbers masked, so changing reason wording in the runtime changes report keys.
- **Off has `ask`/`decide` reject immediately** (`GenClassUnavailableError` reason `off`), so decisions latency is 0 ms in Off. The decisions app labels every `GenClassUnavailableError` (including the runtime's `"timeout"` reason) as "no model: app default"; any other rejection is labelled "no answer in time: app default".
- **Redaction:** the runtime's default redactor drops any path segment that is a secret word (`packages/runtime/src/util.ts` -> `isSensitiveName`, `SECRET_WORDS` includes `auth`). The status store keys services by id, so `services.services.auth.*` is redacted from situations (inferred from code; not observed in a trace).

## How to change it safely

The original team ran all builds, browsers and model runs on the `train` VM (`scripts/vm.sh`, slot `demos`), because the author's Mac has 8 GB. Under the current agent policy ([runtime/build-test-release.md](runtime/build-test-release.md#where-to-run-things)), ask the user before the demos' eval (`npm run eval*`, `scripts/vm-eval.sh`), model downloads (`npm run fetch-model`) or anything on Azure.

1. **Recreate the missing city data (prerequisite for any build).** Add `demos/src/server/data/cities.ts` exporting `searchCities(q: string): { total: number; items: { id: number; name: string; country: string; population: number }[] }` (deterministic, short prefixes match more) and `TYPED_TARGETS: string[]`. Either rename the directory or add a negation (`!demos/src/server/data/`) to the root `.gitignore`, otherwise it will be ignored again. The UI copy says 340 cities.
2. **Add a demo.** Add `DemoId` in `src/shared/protocol.ts`; a world `src/server/worlds/<id>.ts` and register it in `sw.ts` -> `DEFS`; `src/demos/<id>/{main,app,scenario,oracle}.ts` + `app.css`; `<id>/index.html` (copy one, `gc-root` `../`); add to `PAGES` (`vite.config.ts`), `ALL_DEMOS`/`TITLES`/`SHOT_PRESET` (`e2e/eval.ts`), `DEMOS` (`src/shared/demos.ts`: `n`, `title`, `tagline`, `stack`, `summary`, `wrong`, `scored`, `failure`, `tryIt`), `ART` (`src/site/art.ts`). `DEFS`, `ART`, `TITLES` and `SHOT_PRESET` are `Record<DemoId, …>` literals, so `tsc` flags a missing entry there; it does **not** flag `DEMOS` (an array; `DEMO_BY_ID` is built from it with a cast), `PAGES` or `ALL_DEMOS`, so add those by hand. Keep oracles on native timers and `data-testid`s. Run `npm run typecheck`, `npm run build`, `npm run eval:fast -- --demos <id>` (ask first).
3. **Change a scenario or oracle threshold.** Edit `scenario.ts` / `oracle.ts`; keep the scenario RNG label `"<demo>:<kind>:<seed>"` stable (changing it changes every seed). Update `src/shared/demos.ts` (`scored` copy) and the README oracle table. Results are not comparable to older `results.*`: re-run all modes.
4. **Add a chaos knob.** Add the field to `RouteChaos` and `CALM`; apply it in `World.handle` (draw any randomness from the request's `rrng` up front, not lazily); add a slider in `chaos-panel.ts` -> `SLIDERS` and text in `describeChaos`; include it in `ChaosRanges` usage in scenarios. Typecheck both `tsconfig.json` and `tsconfig.sw.json`.
5. **Add a server route or world action.** Add a `Route` with a stable `key` (chaos rules and oracles use it); use `w.rng` inside handlers and `w.scriptRng` / `w.script` for scripted activity; add oracle-relevant data to `snapshot`. World actions return `undefined` for unknown names (the control reply is then `ok: false`).
6. **The demos need a new runtime API.** Use only the public API (`@genclass/runtime`, `/react`, `/redux`, `/zustand`, `/devtools`). Mirror it in `src/dev/runtime-shim/*` (and `tsconfig.shim.json` paths / `vite.config.ts` aliases for new entry points), then run `npm run typecheck:shim`.
7. **Evaluate a new model (ask first).** `GENCLASS_MODEL_FROM=<release dir url> bash demos/scripts/vm-eval.sh --tag <name>` (or `GENCLASS_MODEL_URL=<url>|cdn`). Tagged runs write `results-<tag>.*` and do not replace the shipped results; untagged runs replace `results.json/.md/-summary.json` and the landing page numbers. Check `model.card` and `runtimeBuild` in the JSON.
8. **Investigate a hold-induced regression (ask first).** Run `eval.ts --trace --demos board --modes off,guard,heal --tag <t>` (and a second Off-only run for A/A), then `node --experimental-strip-types e2e/trace-report.ts e2e/.out/traces-<t>.json [e2e/.out/traces-<offB>.json]`. It reports held writes, median holds, held writes applied after a newer user write, and per-card timelines for introduced bugs.
9. **Change the GenClass init.** Only edit `src/shared/genclass.ts` -> `startGenClass`; the mode mapping must stay identical for every demo and app code must not branch on mode.
10. **Change the results schema or aggregation.** `ModeSummary` feeds three consumers: `trials-panel.ts` -> `renderTable`, `eval.ts` -> `mdTable`/`mdDemo`/`writeReports`, and `landing.ts` -> `results` (its local `ResultsFile` type reads `demos.<id>.<mode>.chaos.{rate,k,n}`, `falseInterventions`, `cleanTrials`, `decisionP50`, `actions`, plus `model.note`, `trials`, `generatedAt`). Keep those fields or update all three; an old `results-summary.json` keeps shipping until an untagged eval replaces it.
11. **Change the activity panel or devtools wiring.** Use only `Report`, `Decision`, `ActionRecord`, `Explanation` fields from the public types; if you add a decision bucket, match on `Decision.reason` text from `packages/runtime/src/decide/` and expect it to drift. Theme changes must dispatch `gc-theme` so the devtools overlay remounts.
12. **Fix the world-clock offset (if wanted).** Either move `link.hello(...)` in `bootTrial` after the `gc.ready` wait, or start scripted activity from a world action sent at `TrialHarness.begin()`. Then re-run all modes and both kinds; numbers are not comparable with the shipped `results.*`.

## Tests

There are no unit tests under `demos/`. The oracles and the eval are the tests; type checking covers the rest.

| Test / check | What it asserts |
|---|---|
| `src/demos/search/oracle.ts` | final list equals results for the final text; stale results not visible ≥ 400 ms after the right answer (350 ms grace) |
| `src/demos/editor/oracle.ts` | no lost keystrokes; server copy equals editor; "Saved" never untrue at the end or for > 1.5 s |
| `src/demos/checkout/oracle.ts` | orders = intended; truthful confirmation/error; charged total = sum of lines; displayed total = sum of displayed lines (≤ 1 s drift); cart matches server |
| `src/demos/status/oracle.ts` | no false alarm > 1.5 s, no missed outage > 1.5 s, no other wrong status > 3 s, no banners, ≤ 1.5× steady request volume |
| `src/demos/board/oracle.ts` | final board equals server; no divergence run > 2 s (1.5 s window); no card stuck syncing |
| `src/demos/decisions/oracle.ts` | every answer equals the ground truth recomputed at ask time (health within ±1 level) |
| `e2e/eval.ts` | runs every oracle with real input in all modes; warm-up checks that pages reach cross-origin isolation (a failure is only logged, the run continues); screenshot tour exercises the interactive pages and the in-page runner |
| `npm run typecheck` | `tsc` over `tsconfig.json`, `tsconfig.sw.json`, `tsconfig.node.json` (needs `packages/runtime/dist/*.d.ts` and the missing `src/server/data/cities.ts`) |
| `npm run typecheck:shim` | the same against the shim |
| `e2e/eval.ts` -> `shootTrialsUI` | the in-page runner (iframes, synthetic events) on `search`, Guard page, selector set to 3 (3 chaos + 2 clean seeds per mode, 15 trials) finishes within 900 s; logs row and error counts (not a pass/fail gate: a timeout is caught and logged) |
| `e2e/trace-report.ts` | diagnostic only: quantifies held writes and write reordering on traced board/search runs |
| `scripts/vm-eval.sh` | end-to-end gate: refuses to evaluate when `@genclass/runtime` does not build (unless `ALLOW_BROKEN_RUNTIME=1`) |

### Results so far (v0.1 model, not trained for runtime decisions)

Source: `demos/results.md` / `results-summary.json`, generated 2026-10-07T19:30:09Z, 810 trials (6 demos × 3 modes × (30 chaos + 15 clean)), seeds chaos 1000–1029, clean 1500–1514, Playwright real input, model "GenClass v0.1 (self-hosted copy)" on WASM q8, all 540 Guard/Heal runs cross-origin isolated, 0 errored trials.

| Demo | Bug rate Off | Guard | Heal | False interventions Guard / Heal | Fixed/introduced Guard; Heal | User latency p50 clean Off / Guard / Heal | Decision p50 Guard / Heal |
|---|---|---|---|---|---|---|---|
| search | 13% (4/30) | 13% | 13% | 0 / 0 | 0/0; 0/0 | 14 ms / 125 ms / 126 ms | 481 / 495 ms |
| editor | 83% (25/30) | 83% | 87% | 0 / 0 | 1/1; 0/1 | 779 / 775 / 783 ms | 333 / 340 ms |
| checkout | 83% (25/30) | 90% | 90% | 0 / 0 | 0/2; 0/2 | 205 / 204 / 206 ms | 363 / 366 ms |
| status | 100% (30/30) | 93% | 100% | 0 / 0 | 2/0; 0/0 | 1.33 / 1.26 / 1.28 s | 1.20 / 1.25 s |
| board | 50% (15/30) | 77% | 73% | 0 / 0 | 1/9; 2/9 | 19 / 31 / 33 ms | 346 / 360 ms |
| decisions | 83% (25/30) | 90% | 93% | 0 / 0 | 3/5; 2/5 | 0 / 151 / 157 ms | 308 / 304 ms |

How to read it (aggregated from `results.json` `raw`):

- Off is bug-free on all clean runs and fails often under chaos: the latent bugs are real.
- Chosen but not run (all modes): below a threshold 958 (reason "below the guard threshold" 730 + "below the heal threshold" 228), arrived after the hold budget 663, "guard mode does not allow heal-tier actions" 277. Diagnoses: `unusual` 6,328, `inconsistent` 58, never `expected`, so the "diagnosis ≠ expected" gate never blocked.
- Guard executed nothing. Heal executed 92 actions: `retry` 30 (decisions 10, board 9, editor 8, checkout 3), `block` 62 (60 of the decisions heartbeat `GET /api/ping`, 2 editor autosaves `PUT /api/notes/:id`). No Heal bug rate dropped below Off.
- Status Guard 100% -> 93% came without any action; the README's explanation (held requests spaced out the immediate retries) is a hypothesis, not traced.
- Holds cost latency (search clean p50 14 -> 125 ms) and introduced board bugs (9/30); `NEEDS.md` §1 attributes the board effect to the write-ordering issue using traced runs from a later runtime (batch 3), not this run.
- Decisions: accuracy under chaos 0.42 (defaults) -> 0.62 (Guard) / 0.59 (Heal); on clean runs 1.00 -> 0.27 (Guard and Heal clean bug rate 15/15): v0.1 answers as if something were always wrong.
- Fixed/introduced are noisy: read them against A/A flips (1/30 on the board after CRN). Wilson 95% intervals are in `results.md`.
- These numbers measure the runtime, integration and harness, not the runtime-specialist model; re-run with the trained model is `OPEN_TASKS.md` item 6.

## Drift and open issues

Doc-vs-code mismatches:

1. **`demos/src/server/data/cities.ts` is missing from the repo.** Imported by `src/server/worlds/search.ts`, `src/demos/search/scenario.ts`, `src/demos/search/oracle.ts`; `git check-ignore -v` attributes it to the root `.gitignore` pattern `data/`; it never appears in `git log --all`. The SW bundle (imports all worlds) and the search page cannot build from a clean clone.
2. **Hold budget "300 ms".** `demos/README.md` (results text and "Model decision p50" bullet), `src/shared/settings.ts` -> `holdBudget` comment and `e2e/eval.ts` (`policy.note`, results header) say the default is 300 ms. HEAD runtime default is `"auto"` = clamp(1.5 × median, 150, 800) with 300 only as fallback (`packages/runtime/src/decide/policy.ts`). The shipped results were measured when the default was a fixed 300 ms (commit 353b0a4 `holdBudgetMs ?? 300`); `NEEDS.md` and `harness.ts` already assume the 800 ms ceiling.
3. **Shipped results predate the current eval and runtime.** `results.json` has no `model.card` or `runtimeBuild` (README says the card is recorded there); `results.md` "How to reproduce" differs from what `eval.ts` writes now; `screenshots/` lacks `decisions-heal.png`. Results were generated 19:30Z, before commits a53dd38 and 1a77558 (batch 3); `NEEDS.md`'s traced numbers (board Guard 19/30) come from a different, later run than `results.md` (23/30).
4. README says the harness waits for quiet + 2.5 s; for `status` (`settle: false`) there is no quiet wait and only 350 ms.
5. UI copy in `src/shared/demos.ts`: board "beyond a 1 s grace" (code: 1.5 s window, bug at > 2 s); status "beyond one poll of grace" (code: 3.5 s grace); decisions "Bug rate = share of wrong decisions" (code: a trial is a bug when any one decision is wrong, so bug rate is the share of trials with at least one wrong decision; per-decision accuracy is the `accuracy` metric). Its header also claims it is imported by `vite.config.ts` and injected at build time; it is not.
6. `src/demos/status/scenario.ts` comment says incidents are the same in clean and chaos runs of a seed; the RNG label includes `kind`, so they differ.
7. `eval.ts` options `--trace`, `--kinds`, `--base`, `--port`, `--trial-timeout`, `--out` are not listed in the README or the file header.
8. The runtime shim is behind the `Runtime` interface: `ShimRuntime implements Runtime` lacks `adapter()`, `holdBudgetMs()` and `situationBudget()` (`packages/runtime/src/types.ts` -> `Runtime`), so `npm run typecheck:shim` likely fails (unverified). The shim's `GenClassUnavailableError(message)` also lacks the real class's `reason` field (`"off" | "error" | "timeout" | "destroyed"`, `packages/runtime/src/errors.ts`).
9. README example `GENCLASS_MODEL_URL=https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/` lacks the `files/` suffix of the runtime's `DEFAULT_MODEL_BASE_URL`; the model package is not published yet (`OPEN_TASKS.md` item 8), so `?model=cdn` currently cannot load a model.
10. README results table shows decisions latency "–"; `results.md` has 0 / 151 / 157 ms.
11. README ("Latest results") says the default redaction hides the board's `cards` from the model "(§2)". In `NEEDS.md` redaction is §3 and is marked resolved in batch 3; the README sentence describes the pre-batch-3 measured run and points at the wrong section.
12. README "Files" block and the `eval.ts` header omit `e2e/trace-report.ts`.
13. Not drift but an open risk found while reviewing: the world-clock offset between Off and Guard/Heal trials (see [Invariants](#invariants-and-gotchas)); none of `README.md`, `NEEDS.md` or `results.md` mention it.

Open `NEEDS.md` items for CORE (checked against HEAD):

| § | Item | State at 654d822 |
|---|---|---|
| 1 | A held write lands after the user's newer write (board jump-backs +56%, 9 introduced bugs) | **open**: `packages/runtime/src/state/hub.ts` -> `StoreHub.propose` still commits user-sync bypass writes immediately while earlier writes wait in `s.queue`; see [state-and-adapters](runtime/state-and-adapters.md) |
| 2 | Holds cost interactive latency while the model is slower than the budget; decision requests queue | **open**: holds depend only on `mayHold` (`consultable() && mode !== "observe"`), no latency-based skip or superseded-request drop |
| 3 | Redaction of ordinary fields (`board.cards`) | resolved in batch 3 (word-level `isSensitiveName`); note the new `auth` segment case above |
| 4 | Demos-side fixes (CRN, native timers) | done, for the record |
| 5 | `retry` offered for non-idempotent requests | **open**: `packages/runtime/src/situation/build.ts` -> `builtinApplicable` offers `retry` for any replayable fetch with `attempt < 4`; idempotency is only a fact |
| 6 | Observe EventSource (and BroadcastChannel) messages as ops | **open**: no EventSource observer in `packages/runtime/src/observe/` |
| 7 | Keep observing synthetic DOM events | satisfied: `observe/dom-user.ts` keeps untrusted events unless an app op is running |
| 8 | Notes on the v0.1 model | informational |

Other open items: `OPEN_TASKS.md` item 2 (demos in progress), item 6 (re-evaluate with the trained model; investigate hold-induced harm and triage sensitivity on typeahead, salient about 6 times per clean trial), and "Needs the user: public demo hosting (GitHub Pages) OK to publish?".

## Related docs

- [demos/README.md](../../demos/README.md), [demos/NEEDS.md](../../demos/NEEDS.md), [demos/results.md](../../demos/results.md)
- [docs/runtime/CONTRACT.md](../runtime/CONTRACT.md) (§0 ground rules, §12 demos, §13 hooks)
- [runtime/public-api-and-lifecycle.md](runtime/public-api-and-lifecycle.md): `GenClass.init`, options, kill switch
- [runtime/state-and-adapters.md](runtime/state-and-adapters.md): holds, `propose` ordering risk, React/Redux/Zustand adapters, redaction
- [runtime/decide-policy-actions.md](runtime/decide-policy-actions.md): policy gate, thresholds, hold budget, `retry`/`block`, late revert
- [runtime/observe-and-trace.md](runtime/observe-and-trace.md): DOM/fetch/timer observers, ops
- [runtime/model-host.md](runtime/model-host.md): model loading, `fetch-model` CLI, WASM threads
- [runtime/devtools.md](runtime/devtools.md): the overlay mounted by the demo page
- [runtime/build-test-release.md](runtime/build-test-release.md): workspace build order, `scripts/vm.sh`
- [sim.md](sim.md) (independent from demos by rule), [model-io-contract.md](model-io-contract.md), [training.md](training.md)
- [status-and-known-issues.md](status-and-known-issues.md), [glossary.md](glossary.md), [playbooks.md](playbooks.md), [repo-map.md](repo-map.md), [overview.md](overview.md), [../../AGENTS.md](../../AGENTS.md)
