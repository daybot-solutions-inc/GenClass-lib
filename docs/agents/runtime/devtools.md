# @genclass/runtime: devtools overlay

> **Scope:** `packages/runtime/src/devtools/index.ts`, `packages/runtime/src/devtools/ui.ts`, `packages/runtime/src/devtools/css.ts`, `packages/runtime/UI-NEEDS.md`, `packages/runtime/test/devtools.test.ts`, `packages/runtime/test/devtools-runtime.test.ts`, `packages/runtime/test/browser/ui/*`, `packages/runtime/test/browser/ui-devtools.spec.ts`
> **Read this when:** you mount or unmount the overlay in an app or demo; change what a view shows; add an option, view, chip or evidence section; change report wording, theming or CSS; touch undo or mode switching from the UI; change a public `Runtime` API, event or type that the overlay reads; update the UI test harness (mock runtime, scenario, session, page) or the overlay screenshots; review whether the overlay may ship in production (bundle size, lazy import).
> **Source of truth:** the code. Verified against branch `mvp-v2` at b435acb (origin/runtime 74f17c0 = situation-v2, plus default mode observe and CI), 2026-10-08. If this doc and the code disagree, the code wins.

## TL;DR

- `mountDevtools(runtime, options?)` from `@genclass/runtime/devtools` adds one `<genclass-devtools>` host element with an **open shadow root**. All UI and CSS live inside that shadow root. It returns a `DevtoolsHandle` with `open`, `close`, `toggle`, `unmount` and `element`. With no DOM or no runtime it returns a no-op handle whose `element` is `null`. The runtime is the value of `GenClass.init()` / `GenClass.runtime` (`src/index.ts`) or of `createRuntime()`; passing `GenClass.runtime` while it is still `null` gives the no-op handle.
- It is **vanilla DOM** with no framework and no `innerHTML`: text is set with `textContent`, and SVG icons are built with `createElementNS` from constant markup, so it works under Trusted Types. It is a separate tsup entry, and the built bundle has **no runtime imports**: `../types.js` is imported for types only.
- It uses **only the public `Runtime` API**. Every way it affects the runtime, in one place: Reads: `status`, `mode`, `decisions`, `interventions`, `history`, `explain`, `situation`, `inflight` and `on(decide | detect | act | report | event | status)`. Writes: `setMode` and `ActionRecord.undo()`, nothing else. It registers one setup-only plugin with `use()` to get the runtime's `Clock`. Its host element carries `data-genclass-ignore` (`packages/runtime/src/devtools/index.ts` → `Devtools` constructor), so `packages/runtime/src/observe/dom-user.ts` → `ignoredEvent` does not record overlay clicks or keys as user ops. It never reads `rt.ready` (reading it starts a lazy model load).
- **Mode radios:** `MODES` in `src/devtools/index.ts` labels them Observe, Guard and Heal, with tooltips "Observe (default)", "Guard (opt-in)" and "Heal (experimental)", matching the runtime default `mode: "observe"` (`src/runtime.ts` → `o.mode ?? "observe"`, commit f3636b2). If reading `rt.mode` throws, the overlay assumes `observe` (`Devtools.mode`). With the default mode and a ready model, an app sees an empty Interventions tab ("No interventions in observe mode"), and every reportable finding (diagnosis not `expected`, probability at or above `policy.thresholds.report`) appears under Detections: a non-passive model choice with a "Would have run … in <tier> mode." note (the observe-mode reason contains the word "mode"), a passive one with "The model chose …: nothing was changed.".
- **Four views (tabs):** `interventions` (actions that ran), `detections` (findings GenClass did not act on), `activity` (the event log) and `now` (the live `runtime.situation()`). The collapsed state is a **pill** that shows the mode, the two counters, a model-status dot and a load progress bar.
- **Card routing:** an executed non-passive decision becomes an intervention card, keyed by `ActionRecord.id`. A reportable decision that did not act becomes a detection card, keyed by decision id. When an `act` arrives for a decision that is already shown as a detection, the card moves to Interventions. Identical detections that come within 60 s of each other fold into one card marked `×N`.
- **Evidence:** a card expands to show the facts, the model's answers (probability bars), the timeline, the exact situation text (`Explanation.situationText`, with a Copy button), and decision and action metadata. The data comes from `runtime.explain(id)`. When the explain buffer has dropped the entry, it falls back to the `Decision`.
- **Undo:** an Undo button appears only when `ActionRecord.undo` is a function. Clicking it calls `undo()` once and marks the card undone. If `undo()` throws, the card shows `Undo failed: <message>`. A runtime `action`/`undo` event marks the card undone even when the undo came from somewhere else.
- **Rendering is batched:** dirty bits (`STATUS | MODE | LISTS | EVENTS`) flush once per `requestAnimationFrame`, using the rAF captured at module load. Lists and activity render only while the panel is **open and not paused**. Counters and status always render.
- **Bounded memory:** at most 200 cards per feed and 400 activity rows. Internal maps have bounds of 500 to 2000 entries (see [constants](#configuration-and-constants)).
- **Isolation:** the host carries `data-genclass-ignore`, so the runtime's DOM user observer does not record clicks or keys inside the overlay. The host has the inline style `all:initial; position:fixed; z-index:2147483646`. Styles go into `adoptedStyleSheets`, or a `<style>` element inside the shadow root as a fallback. Nothing is added to the document.
- **Keyboard:** Alt+Shift+G toggles the panel (on by default). Escape closes it. Arrow, Home and End keys rove through the tabs and the mode radios. Enter or Space expands an activity row.
- Development-only use is **a documentation pattern, not code**: the README shows `if (import.meta.env.DEV) { const { mountDevtools } = await import("@genclass/runtime/devtools"); … }`. Nothing in the library stops a production app from mounting the overlay.

## Files

| Path | Role | Key exports / entry points |
|---|---|---|
| `packages/runtime/src/devtools/index.ts` | Public entry. The `Devtools` class does mount, subscribe, backfill, data intake, render scheduling, cards, evidence, activity, Now, controls, timing and unmount. | `mountDevtools`, `DevtoolsOptions`, `DevtoolsHandle`, `DevtoolsPosition`, `DevtoolsTab`. Internal: `Devtools`, `Entry`, `OpRow`, `bound`, `safe`, `fillMain`, `empty`, `sec`, `copyBtn` |
| `packages/runtime/src/devtools/ui.ts` | DOM helper, icons and display formatting. Report-wording templates for when no runtime report sentence is available. Classification and text of activity events. Reporting only: it decides nothing. | `setDoc`, `h`, `add`, `Kid`, `icon`, `IconName`, `mark`, `pct`, `mb`, `dur`, `clockT`, `ago`, `cap`, `phrase`, `actTitle`, `diagTitle`, `topFact`, `repeatKey`, `diagTone`, `splitReport`, `diagP`, `answerRows`, `Group`, `opKind`, `groupOf`, `kindLabel`, `eventText`, `opDuration`, `opStatus`, `dataLines`, `linesOf`, `safeJson` |
| `packages/runtime/src/devtools/css.ts` | The one stylesheet, as a string. Light and dark token sets on `.root` / `.root[data-theme=dark]`. Class selectors are unprefixed (`.pill`, `.card`, …) and a few element/attribute selectors (`*`, `button`, `input`, `svg`, `[hidden]`, `[tabindex]`, `code`) are unscoped, which is safe only because the sheet is applied inside the shadow root. | `CSS` (internal consts `LIGHT`, `DARK`) |
| `packages/runtime/UI-NEEDS.md` | UI to CORE request log, plus a summary of which runtime APIs the overlay uses. Partly stale: see [Drift](#drift-and-open-issues). | n/a |
| `packages/runtime/test/devtools.test.ts` | Unit tests against `MockRuntime` + `loadScenario`. Uses the `// @vitest-environment happy-dom` pragma (the vitest config default is `node`). | n/a |
| `packages/runtime/test/devtools-runtime.test.ts` | Integration tests (same happy-dom pragma): the overlay mounted on the real `createRuntime` after `runStoreSession()`. | n/a |
| `packages/runtime/test/browser/ui-devtools.spec.ts` | Playwright (Chromium). Checks real-browser style isolation, keyboard and undo, and writes the 18 screenshots in `test/browser/ui/screenshots/` (called "README screenshots" in its header, but no README embeds them: Drift 13). | n/a |
| `packages/runtime/test/browser/ui/mock-runtime.ts` | `MockRuntime`, a scripted `Runtime` implementation that records calls and emits what the test tells it to. Also models the store semantics (CONTRACT §4) used by `test/adapters-react.test.ts`, `test/adapters-redux.test.ts` and `test/adapters-zustand.test.ts`, so a change here can break those suites too. | `MockRuntime`, `MockClock`, `makeDecision`, `makeAction`, `choice` |
| `packages/runtime/test/browser/ui/scenario.ts` | `loadScenario(rt, opts)`: a scripted store session for the mock (3 interventions, 3 detections, events, explanations, a Now situation). | `loadScenario`, `ScenarioOptions` |
| `packages/runtime/test/browser/ui/session.ts` | `runStoreSession(opts)`: a store app on the **real** runtime under a virtual clock, a fake backend and a rule-based test decider. | `runStoreSession`, `Session`, `SessionOptions`, `VirtualClock`, `realTurn`, `SessionDecider`, `READY` |
| `packages/runtime/test/browser/ui/page.ts` | Browser page bundled by the spec. It renders a fake "Acme" store and exposes `window.__gc.start(opts)`. | `window.__gc` |
| `packages/runtime/test/browser/ui/playwright.config.ts` | Playwright config for `ui-*.spec.ts`. | default export |
| `packages/runtime/test/browser/ui/screenshots/*.png` | 18 tracked PNGs, rewritten by the spec. | n/a |

Wiring outside the scope:

| Path | Relevance |
|---|---|
| `packages/runtime/package.json` | `exports["./devtools"]` maps to `./dist/devtools/index.js` (+ `.d.ts`). `"sideEffects": false`. |
| `packages/runtime/tsup.config.ts` | Entry `"devtools/index": "src/devtools/index.ts"` (also in `dts.entry`). ESM, `es2022`, `splitting: true`. |
| `packages/runtime/src/observe/dom-user.ts` → `ignoredEvent`, `insideIgnored` | Skips user events whose `composedPath()[0]` or `target` is inside `[data-genclass-ignore]`, crossing shadow roots. |
| `packages/runtime/src/runtime.ts` → `fire`, `explain`, `setMode`, `decisions`, `interventions`, `history`, `inflight`, `situation` | The data the overlay reads. `setMode` fires `status`. `record.undo` pushes an `action`/`undo` event. |
| `packages/runtime/src/decide/report.ts` → `interventionLine`, `detectionLine`, `Reporter` | The report sentences that the overlay's `splitReport` parses and that `ui.ts` templates imitate. |
| `demos/src/site/demo-page.ts` | Demo mount: `mountDevtools(gc, { collapsed, theme, position: "bottom-right" })`, remounted on `gc-theme`, and `?devtools=open`. |
| `demos/src/dev/runtime-shim/devtools.ts` | A no-op stand-in that **duplicates `DevtoolsOptions`**. Update it when the options change. |
| `packages/runtime/test/smoke/smoke.sh` | Packs the tarball and checks that `document.querySelector("genclass-devtools")` exists in a Vite app. |

## Concepts and data structures

### Public types (`src/devtools/index.ts`)

```ts
type DevtoolsPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left";
type DevtoolsTab = "interventions" | "detections" | "activity" | "now";
interface DevtoolsOptions {
  position?: DevtoolsPosition;          // default "bottom-right"
  collapsed?: boolean;                  // default true (pill); false opens the panel at mount
  theme?: "auto" | "light" | "dark";    // default "auto" (live prefers-color-scheme)
  tab?: DevtoolsTab;                    // default "interventions"
  hotkey?: boolean;                     // default true: Alt+Shift+G toggles
  container?: HTMLElement;              // default document.body (then documentElement)
}
interface DevtoolsHandle { open(): void; close(): void; toggle(): void; unmount(): void; readonly element: HTMLElement | null }
function mountDevtools(runtime: Runtime, options?: DevtoolsOptions): DevtoolsHandle;
```

`handle.open/close/toggle` are "programmatic": they do not move focus. Clicking the pill, the minimize button, Escape and the hotkey are "user" actions and do move focus. `handle.element` is the host while mounted and `null` after `unmount()`.

### Runtime data the overlay consumes

| Runtime surface | Type | Used for |
|---|---|---|
| `on("decide")` | `Decision` | `addDecision`: cache the decision and refresh the card that refers to it |
| `on("detect")` | `Decision` (`Detection`) | `addDet`: create or fold a detection card |
| `on("act")` | `ActionRecord` | `addAct`: create an intervention card, or update a known one |
| `on("report")` | `Report` (`{kind, message, decision?, action?}`) | `addReport`: store the runtime's sentence for the card title and body (`kind: "status"` is ignored) |
| `on("event")` | `RtEvent` | `addEvent`: activity rows, op names and undo detection |
| `on("status")` | `ModelStatus` | marks `STATUS \| MODE`. The runtime also fires `status` from `setMode`. |
| `status` (getter) | `ModelStatus` | status strip, pill dot and progress, empty-state text |
| `mode` (getter) | `Mode` | mode radios, pill label, wording of "would have" notes |
| `decisions(200)`, `interventions(200)`, `history(400)` | arrays | backfill at mount |
| `explain(id)` | `Explanation \| null` | evidence (lazy, cached per card) |
| `situation()` | `Situation` (an "ask about now" situation) | Now view, polled once per second while visible |
| `inflight()` | `Op[]` | the "In flight" list in the Now view |
| `setMode(m)` | n/a | mode radios |
| `ActionRecord.undo()` | n/a | the Undo button |
| `use({ name, setup })` | `Plugin` → `PluginApi.clock` | the runtime `Clock` for "ago" labels and the overlay's own timers |

### Internal state (`Devtools` in `src/devtools/index.ts`)

```ts
interface Entry {            // one card
  kind: "act" | "det";
  id: string;                // ActionRecord.id (act) or Decision.id (det; for a folded card, the first decision's id)
  at: number;                // runtime-clock ms (det: updated to the latest repeat)
  action?: ActionRecord; decision?: Decision;
  open: boolean;             // evidence expanded
  dirty: boolean;            // re-render on next LISTS flush
  fresh: boolean;            // play the "new" animation once
  count: number;             // folded repeats (det); always 1 for act
  key?: string;              // repeatKey(d) for det
  undone?: boolean; undoErr?: string;
  ex?: Explanation | null;   // cached explain(); undefined = not fetched yet
  el?: HTMLElement;          // rendered <article>
}
interface OpRow { el: HTMLElement; x: HTMLElement; start: number }  // an activity row waiting for its op.end
```

| Field | Shape | Bound |
|---|---|---|
| `acts` | `Map<actionId, Entry>` (insertion order = render order, newest prepended) | 200 (`MAX_CARDS`), evicted cards removed from the DOM |
| `dets` | `Map<cardId, Entry>` | 200 (`MAX_CARDS`) |
| `detOf` | decision id → detection card id (repeats share one card) | 1000 |
| `actOf` | decision id → action id | 1000 |
| `decs` | decision id → `Decision` | 500 (only on the live `decide` path) |
| `msgs` | action id or decision id → report sentence | 500 |
| `evq` | `RtEvent[]` waiting to render | 400 (`MAX_ROWS`), oldest dropped |
| `rows`, `rowBySeq`, `rowEvents`, `opRows` | rendered activity rows; seq → row; row → events (start + end); op id → row in flight | 400 rows |
| `opNames` | op id → `eventText` of its `user`/`op.start` event (names the causes in expanded rows) | 2000 |
| `hide`, `query` | activity group filters and the text filter | n/a |
| `isOpen`, `tab`, `paused`, `dead`, `unseen`, `bits`, `scheduled`, `ticking`, `ticks`, `scrolledActivity`, `clock`, `lastT` | UI state | n/a |

### Terms introduced here

| Term | Meaning |
|---|---|
| overlay / host | The `<genclass-devtools data-genclass-devtools data-genclass-ignore>` element plus its shadow root. |
| pill | The collapsed button (`.pill`, `data-part="pill"`): brand mark, "GenClass", mode, intervention counter (`.pc.a`), detection counter (`.pc.d`), status dot (`.pd`), load progress (`.pb`). |
| panel | The expanded `section.panel[role=dialog]`: header (brand, mode radios, minimize), status strip, tabs and pause/clear buttons, pause banner, panes. |
| view / tab / pane | One of `DevtoolsTab`. Tab button `[data-tab]`, pane `[data-pane]`. |
| intervention card | `article.card.act[data-id=<actionId>]` for an `ActionRecord`. |
| detection card | `article.card.det[data-id=<decisionId>]` for a decision that was reported (`detect`) but did not run a non-passive action. |
| repeat folding | Detections with the same `repeatKey` (trigger, diagnosis, action, and subject with digits normalised) within 60 s of the card's latest repeat become one card with a `×N` badge. |
| report sentence | `Report.message` from `on("report")`, e.g. `[GenClass] Prevented a stale response: <fact> <changed> (stale, 0.97; discard 0.98)`. The overlay splits it into a title and body. |
| templates | `actTitle` and `diagTitle` in `ui.ts`, used when no report sentence is known (anything recorded before mount). |
| evidence | The expandable `.evd` block of a card. |
| render bits | `STATUS=1`, `MODE=2`, `LISTS=4`, `EVENTS=8`, `ALL=15`. They are OR'ed into `bits` and flushed together. |
| pause (feed) | Freezes the rendering of lists, activity and Now. Intake and counters continue. Unrelated to `runtime.pause()`. |
| clear (feeds) | Removes the overlay's cards and rows. The runtime's buffers are unaffected. |
| backfill | Replays `decisions`, `interventions` and `history` at mount. Report sentences from before mount are **not** available. |

### DOM hooks (stable selectors used by tests)

| Selector | Element |
|---|---|
| `genclass-devtools` | host (light DOM) |
| `.root[data-pos][data-theme]` | shadow root top container (theme tokens live here) |
| `[data-part="pill" \| "panel" \| "minimize" \| "status" \| "pause" \| "clear" \| "situation"]` | pill, panel, minimize button, status strip, pause and clear buttons, the situation `<pre>` in evidence |
| `[data-tab=<id>]` (role tab, id `gc-t-<id>`), `[data-pane=<id>]` (role tabpanel, id `gc-p-<id>`) | tabs and panes |
| `[data-mode=observe\|guard\|heal]` (role radio) | mode radios |
| `article.card[data-id]`, `.ct` title, `.cx` body, `.rep` ×N, `time.ago[data-at]`, `.chips .chip`, `.note` (`.chg` changed, `.fail`), `.evd` | card parts |
| `[data-act="evidence" \| "undo" \| "undone" \| "copy"]` | card and evidence controls (focus is restored by `data-act` after a re-render) |
| `.ans[data-q]`, `.bl`, `.bt2`, `.bp` (`.top` on the chosen label) | answer bars |
| `.f[data-g]` (aria-pressed), `input.q` | activity filters |
| `.ev[data-g][data-op]`, `.t`, `.k`, `.m` (+ `.id`), `.x` (+ `.spin`), `.evx` | activity row parts |
| `.now`, `.nh`, `.subj p`, `.op .m`, `.op .x`, `.facts li` | Now view |
| `.pc.a b`, `.pc.d b`, `.n` (tab counters), `.pm` (pill mode), `.pz` (pause banner), `.st b`, `.st .sm`, `.sb i`, `.empty b` | counters, status, pause banner, empty states |

### ARIA structure (`Devtools` constructor, `card`, `row`)

| Element | Role / ARIA |
|---|---|
| pill `button.pill` | `aria-haspopup="dialog"`, `aria-expanded` (true while open), `aria-label` = `Open GenClass devtools: N interventions, M detections, model <state>` |
| `section.panel` | `role=dialog`, `aria-label="GenClass devtools"` |
| `.modes` | `role=radiogroup` `aria-label="Mode"`; each button `role=radio`, `aria-checked`, roving `tabindex` (0 on the checked one), `title` = the `MODES` tooltip |
| `.st` | `role=status` |
| `.tabs-in` | `role=tablist` `aria-label="GenClass views"`; tabs `role=tab`, `aria-selected`, `aria-controls=gc-p-<id>`, roving `tabindex` |
| `.pane` | `role=tabpanel`, `aria-labelledby=gc-t-<id>` |
| `.list` (Interventions, Detections) | `role=feed` with `aria-label` |
| `.evs` (Activity) | `role=log` `aria-label="Runtime activity"`; rows `role=listitem`, `tabindex=0`, `aria-expanded` |
| `.fb` | `role=toolbar` `aria-label="Activity filters"`; filter buttons use `aria-pressed` (true = group shown) |
| pause button | `aria-pressed`, `aria-label` `Pause feed` / `Resume feed` |
| Evidence button | `aria-expanded`, `aria-controls=gc-ev-<kind>-<id>` |
| icons | `aria-hidden="true" focusable="false"`; spinners `role=img aria-label="in flight"` (activity rows only) |

### `ui.ts` helper reference (exact behaviour)

| Helper | Behaviour |
|---|---|
| `h(tag, props, ...kids)` | Creates in the module-global document `D`. Props: `null`/`false` skipped; `class` → `className`; `text` → `textContent`; `on<event>` with a function → `addEventListener("<event>")`; `true` → empty attribute; anything else → `setAttribute(k, String(v))`. Kids (`Kid`) may be nested arrays; `null`/`false`/`undefined` are skipped; strings and numbers become text nodes. |
| `svg(markup)` (private) / `icon(name, cls = "i")` | A regex mini-parser over **constant** markup: only elements and `key="value"` (double-quoted) attributes; text, comments and single-quoted attributes are dropped. `ICONS` names: `shield`, `eye`, `pulse`, `scan`, `pause`, `play`, `clear`, `min`, `chev`, `undo`, `copy`, `check`, `alert`, `info` (24×24 viewBox, stroked via the `.i` class). `scan` is currently unused. |
| `mark()` | The brand tile SVG (gradient `#2f6cf2` → `#7b3cf0`, white trace, `#ffd166` dot). Each call gets a unique gradient id `gcm<n>` from the module counter `markN`. |
| `pct(p)` | `Math.round(p*100)%`; `"–"` for `null`/non-finite. |
| `dur(ms)` | `""` for negative or non-finite; see the constants table for formats. |
| `phrase(diagnosis, trigger)` | Noun from `NOUN[trigger]` (`mutation` write, `delivery` response, `request` request, `failure` failed request, `stall` slow request, and so on; else the trigger, else `"event"`). No adjective for a missing or `expected` diagnosis. `failure` + `failing` → `"failing request"`. Adjective = `ADJ[diagnosis]` or the diagnosis with `_` → space, omitted when the noun already starts with it. |
| `actTitle(action, diagnosis, trigger, late = false)` | `` `${lead} ${article(phrase)}` `` where `lead` is `"Reverted"` when `late` is true (the overlay passes `!!ActionRecord.late`), else `LEAD[action]`; `article` adds `a`/`an` except when the phrase ends in `state`. Unknown action → `Ran <action with _ → space>`. `LEAD`: `discard`/`coalesce` Prevented, `defer` Held back, `delay` Slowed down, `block` Stopped, `serve_cached`/`retry` Recovered from, `hedge` Worked around, `rollback`/`resync` Repaired. |
| `diagTitle` | `cap(phrase(...))`. |
| `topFact(facts)` | First fact not matching `/^This (write\|request) (comes from\|has no known cause)/`; falls back to `facts[0]`. |
| `diagP(d)` | `d.diagnosisProbabilities?.[d.diagnosis] ?? d.diagnosisConfidence`. In the real runtime both are the same calibrated probability (`src/runtime.ts`). |
| `answerRows(a)` | `noul` → `[["true", noul], ["false", 1-noul]]`; otherwise `probabilities` entries sorted descending (non-numbers → 0). |
| `eventText(e)` | `op.start`/`op.end`: `name` + `data.detail` (no space when it starts with `?`; skipped when already in the name). `user`: `name = "<value>"` (a value not already starting with `"` is quoted, and cut to 39 chars + `…` when longer than 40; an already-quoted value is used as is) plus ` (N keystrokes)` when `data.count > 1`. `state`: up to 3 of `data.paths` (or `data.changes[].path`) plus ` +N`, else `name`. `error`: `name: message` unless the message already starts with the name. `decision`: `name · diagnosis → action`, plus ` (not run)` when `data.executed === false`. `action`: `name · data.text`. `storage`: `name key`. Other kinds: `name · data.summary` (only when the summary is not already in the name). |
| `opStatus(e)` | Code from `data.code ?? data.httpStatus` (number or string). Rules as in [Activity view](#8-activity-view-renderevents-row-endop-togglerow). |
| `linesOf(v)` | `null` → `[]`; array → each item (non-strings via `safeJson`); string → non-blank lines; other → `[safeJson(v)]`. |
| `safeJson(v, space?)` | `JSON.stringify`, falling back to `String(v)` on throw or `undefined`. |

## How it works

### 1. Mount (`mountDevtools` → `new Devtools`)

1. `mountDevtools` resolves `doc = options.container?.ownerDocument ?? globalThis.document`. If there is no `doc` or no `runtime`, it returns the no-op handle.
2. The `Devtools` constructor calls `setDoc(doc)` (`ui.ts`). This sets a **module-global** document that `h()`, `icon()` and `mark()` create elements in.
3. It creates the host `genclass-devtools` with `data-genclass-devtools` and `data-genclass-ignore` and the inline style `all:initial;display:block;position:fixed;z-index:2147483646;<vert>:16px;<horiz>:16px;`. `<vert>` and `<horiz>` come from splitting `position` on `-`. It then calls `attachShadow({ mode: "open" })`.
4. `adoptStyles` creates `new CSSStyleSheet()`, calls `replaceSync(CSS)` and sets `shadowRoot.adoptedStyleSheets`. If that is unsupported or throws, it appends `<style>` with `CSS` inside the shadow root.
5. It builds the pill, header (mode radios from `MODES`), status strip, tabs (from `TABS`) plus pause and clear, pause banner, the four panes and the panel. Everything goes under `.root[data-pos]`.
6. Theme: `"auto"` reads `matchMedia("(prefers-color-scheme: dark)")` and listens for `change` (removed on unmount). It sets `.root[data-theme]` to `light` or `dark`.
7. It appends the host to `container ?? doc.body ?? doc.documentElement`.
8. `subscribe()`, then `backfill()`, then (unless `hotkey === false`) a capture-phase `keydown` listener on `doc`.
9. `bits = ALL; flush()`. Since the panel is closed, this renders the status, mode and counters. If `collapsed === false`, `open(false)` follows.

### 2. Subscribe and backfill

1. `subscribe()` calls `rt.on(type, fn)` for `decide`, `detect`, `act`, `report`, `event` and `status`. Each callback is ignored once `dead`. Each unsubscribe function goes into `offs`. A runtime without an event is tolerated (try/catch).
2. `subscribe()` then calls `rt.use({ name: "genclass-devtools-<n>", setup: api => this.clock = api.clock })`. `<n>` is a module counter `instances`. The plugin adds no facts, actions or questions. Its disposer goes into `offs`.
3. `backfill()`:
   1. Calls `rt.decisions(200)`, sorts by `at`, and caches each decision in `decs`.
   2. Calls `rt.interventions(200)`, sorts by `at`, and runs `addAct(a, false)` on each (no pulse).
   3. For each cached decision with a non-empty `diagnosis`, `diagnosis !== "expected"` and `diagP(d) >= 0.6`, runs `addDet(d, false)`.
   4. Runs `addEvent(e)` for each event of `rt.history(400)`. An `action`/`undo` event here marks an already backfilled card undone.

### 3. Data intake and card routing

1. **`decide`** → `addDecision(d)`: `decs.set`, then `bound(decs, 500)`. If a det or act card already refers to `d.id`, it sets `entry.decision = d` and marks `LISTS`.
2. **`detect`** → `addDet(d, live=true)`:
   1. It returns early if `actOf.has(d.id)`, `detOf.has(d.id)`, or `d.executed && d.tier !== "passive"` (an intervention, whose `ActionRecord` follows).
   2. `key = repeatKey(d)` is `` `${trigger}|${diagnosis}|${action}|${subject with /#\d+/→"#", /\d+(\.\d+)?/→"n"}` ``. The **last** existing det card with the same key and `d.at - card.at <= 60_000` absorbs the decision: `count++`, `decision = d`, `at = d.at`, `ex = undefined`, its element is removed, and it is re-inserted at the end of `dets` so it renders on top. `detOf[d.id] = card.id`.
   3. Otherwise it creates a new card keyed by `d.id`.
   4. `bound(dets, 200, removeEl)`, `bound(detOf, 1000)`, then (live only, not during backfill) `notify("d")` (pill ring in warn colour), and mark `LISTS`.
3. **`act`** → `addAct(a, live=true)`:
   1. A known id updates `action` and marks dirty.
   2. Otherwise it creates an `Entry{kind:"act"}` with `decision = decs.get(a.decisionId)`, sets `actOf[a.decisionId] = a.id`, and applies `bound(acts, 200, removeEl)` and `bound(actOf, 1000)`.
   3. If that decision had a detection card, the card is decremented (when `count > 1`) or removed. The decision moves to Interventions.
   4. Then (live only, not during backfill) `notify("a")` (pill ring in brand colour), and mark `LISTS`.
4. **`report`** → `addReport(r)`:
   1. It skips `kind === "status"` and empty messages.
   2. The id is `r.action?.id ?? actOf[r.decision.id] ?? r.decision.id` for `intervene`, and `r.decision?.id` for `detect`.
   3. It stores `msgs.set(id, message)` (bounded to 500) and marks the matching card dirty.
5. **`event`** → `addEvent(e)`:
   1. `kind === "action" && name === "undo" && typeof data.id === "string"` marks that act card `undone`.
   2. A `user` or `op.start` event with an `op` records `opNames[op] = eventText(e)`.
   3. The event is pushed to `evq` (capped at 400) and `EVENTS` is marked.
6. **`status`** → `mark(STATUS | MODE)`.
7. `notify(kind)` increments `unseen` while paused. It restarts the pill's CSS `ring` animation with class `pa` (intervention) or `pdd` (detection). `animationend` with name `ring` removes the class.

### 4. Render scheduling (`mark` / `flush`)

1. `mark(bits)` ORs into `this.bits`. If no flush is scheduled (and not `dead`), it schedules one with `rawRaf(run)`. Without rAF it uses `after(16, run)`, which goes through the runtime clock when one is known.
2. `flush()` swaps `bits` to 0, then:
   1. `STATUS` → `renderStatus()`.
   2. `MODE` → `renderMode()`.
   3. Only if `isOpen && !paused`: `LISTS` → `renderList(acts, …)` and `renderList(dets, …)`, and `EVENTS` → `renderEvents()`. Otherwise those two bits are put back for later.
   4. `renderCounts()` always runs.
3. Undo, evidence toggling, pause, clear and open call `flush()` synchronously after setting bits.
4. `renderList(map, list, empty)`: for each entry in insertion order, a missing `el` is built by `card(e)` and **prepended** (newest on top). A `dirty` entry is rebuilt and swapped in with `replaceWith`. If focus was inside the old card, it is restored to the element with the same `data-act`. The empty state is hidden when the map is non-empty.
5. `renderCounts()`:
   1. The intervention count is `acts.size` (so at most 200). The detection count is the **sum of `count`** over the at most 200 det cards (folded repeats can push it above 200). Neither is a runtime total.
   2. It updates the pill counters and tab counters (adds class `.on` when > 0) and the pill `aria-label`, which reads `Open GenClass devtools: N interventions, M detections, model <state>`.
   3. It updates the pause banner: `Feed paused` or `Feed paused · N new`.

### 5. Card content (`card(e)`)

1. `d = e.decision ?? decs.get(a.decisionId)`.
2. `msg` is `msgs[e.id] ?? msgs[a.decisionId]` (act) or `msgs[d.id]` (det).
3. `splitReport(msg, a?.changed)` cleans the sentence:
   1. Takes the first line.
   2. Strips the `[GenClass]` prefix, a `(×N …)` suffix, the trailing `(diag, p; action p)` parenthetical, and any `Not acted on (…): …` tail.
   3. Strips a trailing `changed`, because the note already shows it.
   4. Splits at the first `": "` when it falls at index 3 to 63. Otherwise the whole text is the body.
4. **Title:** det cards always use `diagTitle(diagnosis, trigger)`, e.g. "Slow request" or "Unusual state change". Act cards use the report title, or `actTitle(action, diagnosis, trigger)`, e.g. "Prevented a stale response" (a `delivery` discard), "Reverted a duplicate write" (a late `mutation` discard, `ActionRecord.late`) or "Slowed down a failing request".
5. **Body:** the report body, or else `topFact(d.facts)` (the first fact that is not `This write|request comes from|has no known cause…`), or else `a.subject`, or else `d.subject`. CSS clamps it to 3 lines.
6. **Chips:**
   - Diagnosis chip, coloured `t-<diagTone>`: `ok` for expected; `bad` for failing or inconsistent; `warn` for slow or overload; `brand` otherwise. It shows the diagnosis and `pct(diagP(d))`.
   - Action chip (act cards only): `<code>action</code>` and the tier.
7. **Note:**
   - On an act card, `changedNote`:
     - `!a.ok` → `Action failed: <error ?? "it threw">`
     - undone → `Reversed: <changed || action>`
     - otherwise → `a.changed`
   - On a det card, `wouldNote(d)`:
     - `tier === "passive"` → `The model chose <action>: nothing was changed.`
     - Otherwise the note depends on `byMode`. With a reason, `byMode = /\bmode\b/.test(d.reason)`. Without one, `byMode = !(mode === "heal" || (mode === "guard" && d.tier === "guard"))`.
     - `byMode` true → `Would have run <action> in <tier> mode.`
     - `byMode` false → `Not acted on: <reason ?? "held back by policy">. The model chose <action> (<tier>).`
8. **Footer:** the undo control (act cards only) and the `Evidence` button (`aria-expanded`, `aria-controls="gc-ev-<kind>-<id>"`). After the first render `fresh` becomes `false`, so the `new` animation plays once.

### 6. Evidence (`toggleEvidence` → `evidence(e, id)`)

1. A click flips `e.open`, marks the card dirty, flushes, and `reveal()` scrolls the pane so the card fits.
2. `e.ex` is fetched once with `explain(e)`. It tries `rt.explain(id)` for `[action id, decision id]` (act) or `[decision id, card id]` (det) and caches the first non-null result. `null` is cached too.
3. Sources: `d = ex.decision ?? e.decision`, `a = e.action ?? ex.action`, `facts = ex.facts ?? d.facts`, `answers = ex.answers ?? d.answers`.
4. Sections in order:
   1. **Facts** (`ul.facts`).
   2. **Model answers**: one `.ans[data-q]` per question, ordered `diagnosis`, then `action`, then the rest. Each shows the top 6 `answerRows` (noul gives `true`/`false`; otherwise probabilities sorted in descending order). The highlighted row is the decision's chosen label when present.
   3. **Timeline** (`ex.timeline`).
   4. **Exact input sent to the model**: `ex.situationText` in `pre[data-part=situation]`, with a Copy button.
   5. When `explain` returned null: `The full situation is no longer in the runtime's decision buffer.`
   6. Metadata: decision id, action id, `<trigger> · answered in <dur(latencyMs)>`, model name.
   7. For a non-passive action, the hint `Never run this action: policy: { deny: ["<action>"] }`.
5. The runtime keeps explain records under both decision ids and action ids in `explainMap` (`src/runtime.ts`). It evicts the oldest entry when the map exceeds `DECISIONS_KEPT * 2` = 400 entries, checked on each new decision. Older cards fall back to the facts and answers stored on the `Decision`.
6. `copyBtn` writes with `navigator.clipboard.writeText`. The button shows `Copied` or `Copy failed` (also immediately when `navigator.clipboard` is missing, e.g. on a non-secure origin) and resets after 1400 ms via `rawSetTimeout`.

### 7. Undo from the UI (`undoCtl` / `undo`)

1. `undoCtl` renders:
   - `span.done[data-act=undone]` "Undone" when `e.undone`.
   - Nothing when `typeof a.undo !== "function"`. For example, `coalesce` and `delay` records in the scenario have no undo.
   - Otherwise `button.btn.u[data-act=undo]` "Undo", plus `.err` text when the last attempt failed.
2. `undo(e)` calls `e.action.undo()` synchronously. On success it sets `undone = true` and clears `undoErr`. On a throw it sets `undoErr = "Undo failed: <message>"` and does not mark the card undone. Then it flushes.
3. In the real runtime, `ActionRecord.undo` is idempotent (`src/runtime.ts`: an `undone` flag in the closure). It runs the effect's undo as a GenClass op (`runAsGenClass("undo", …)`) and pushes `RtEvent { kind: "action", name: "undo", data: { id, text } }`. Through step 3.5, that event also marks the card undone when the undo was triggered from the console or app code.
4. Undo state lives on the overlay's `Entry`. After a remount it is restored only if the `action`/`undo` event is still within the last 400 events that backfill reads (`history(MAX_ROWS)`). `clear()` drops the cards themselves; cleared interventions do not come back until a remount.

### 8. Activity view (`renderEvents`, `row`, `endOp`, `toggleRow`)

1. `renderEvents` drains `evq`:
   1. An event whose `seq` already has a row is a typing burst that the runtime re-notified via `EventLog.touch` (`src/trace/events.ts`). Only that row's `.m` text is refreshed.
   2. Any other event goes through `row(e, fresh)`.
   3. New rows are appended in a fragment. Rows are trimmed to 400 from the top, dropping their `rowBySeq` and `opRows` entries.
   4. The pane scrolls to the bottom when the user was within 32 px of it (or the Activity tab has never been shown, `scrolledActivity === false`) and the Activity tab is selected.
2. `row(e)`:
   1. An `op.end` whose `op` has a pending row is merged into the `op.start` row by `endOp` (status and duration in `.x`; main text updated if `name` differs). No new row is created.
   2. Otherwise it builds `div.ev.g-<group>[data-g][data-op][role=listitem][tabindex=0]` with columns `.t` = `clockT(e.t)`, `.k` = `kindLabel(e)`, `.m` = `fillMain` (`eventText(e)` plus `#op`, or `← #op` for `state` events), and `.x`.
   3. `.x` holds:
      - for `op.start`: a spinner, and the row is registered in `opRows`
      - for an unpaired `op.end`: `fillEnd`
      - otherwise: `held <dur>` when `data.heldMs` or `data.held` is a number, or `pct(data.confidence)` for `decision` events
   4. The row is hidden immediately if the current filters exclude it.
   5. New rows get class `fresh` (a 1.2 s brand-tint fade, CSS `@keyframes fresh`) only when the Activity tab has been visited before (`scrolledActivity`) **and** is the selected tab during that flush, so the initial backfill never flashes.
3. Groups (`groupOf`):

   | Event | Group |
   |---|---|
   | `user` | `user` |
   | `op.start` / `op.end` with `opKind` = `genclass` | `gc` |
   | other `op.start` / `op.end` | `op` |
   | `state` | `state` |
   | `error` | `error` |
   | `decision`, `action` | `gc` |
   | anything else (`nav`, `perf`, `storage`, `custom`) | `other` |

   Filter buttons are User, Ops, State, Errors, GenClass and Other. All are pressed (shown) at start. The text filter is a lowercase substring match on the row's `textContent`.
4. Labels (`kindLabel`):
   - For op events, by `data.kind ?? data.opKind`: `fetch` or `xhr` → `net`, `ws` → `ws`, `task`, `timer`, `genclass` → `gc`, `user`, anything else → `op`.
   - Otherwise: `storage` → `store`, `custom` → `event`, `decision` → `model`, `action` → `action`. Other kinds use their own name.
5. `opStatus(e)` returns text and a tone:
   - `status:"error"` → code or "error", tone `bad`
   - `aborted` → tone `dim`
   - `blocked` → `blocked <code>`, tone `brand`
   - a numeric `code >= 400` → tone `bad`
   - otherwise → code, status or "done", tone `ok`

   `opDuration` uses `data.ms ?? data.duration ?? data.durationMs ?? e.t - start`. The `.x` text concatenates the status and the duration, e.g. the textContent `2001.82 s` is `200` followed by `1.82 s`.
6. Clicking a row, or pressing Enter or Space on it, toggles `.evx`. It shows `dataLines` for every event in the row (start and end joined by `\n—\n`): `kind · name`, `op: #n`, `cause: #n <op name>`, each `data` key with its value truncated to 300 characters, and `seq`.

### 9. Now view (`renderNow`)

1. It runs only when the panel is open, `tab === "now"` and the overlay is not `dead`. It is triggered by `setTab("now")`, by `setPaused`, and by every 1 s tick unless paused.
2. `sit = rt.situation()` (no argument, so the real runtime builds a fresh `trigger: "ask"` "about now" situation each time; `src/runtime.ts` → `situation`). A throw becomes a `.note.fail` reading `situation() failed: <message>`, and then only the header and that note render. Next, `ops = safe(rt.inflight)`. `docs/runtime/CONTRACT.md` states `situation()` is side-effect free (no ids consumed, nothing recorded); the code comment on `RuntimeImpl.build` (`src/runtime.ts`) qualifies this as "apart from caching op.reads".
3. It renders, in order:
   - Header: `Live` or `Paused`, `state.app` or "What GenClass sees right now", and a `Copy state` button with the JSON of `sit.state`.
   - Subject block: chips `trigger <sit.trigger>` and either `salient: the model would be asked` (warn) or `quiet: no model call needed` (ok), followed by `sit.subject` (or, when it is empty, the first line of `state.trigger`).
   - Facts: `sit.facts`, or else `linesOf(state.facts)`, or else `No notable facts.`
   - In flight (section title `In flight · N` when N > 0): from `inflight()` as `name` + `detail` (no space when `detail` starts with `?`) and a spinner with `kind · dur(now - start)`. Only when `inflight()` throws or returns `null`/`undefined` does it fall back to `state.in_flight` lines without `none` (an empty array shows `none`).
   - Timeline (`state.timeline`), State (`state.state`) and Stats (`state.stats` without `none`).
   - Actions available (`sit.actions`, the first chip labelled `passive`).

   `Situation.state` is typed `JevState` (`Record<string, unknown>`); its keys are the serializer's `SituationParts` keys `app`, `trigger`, `facts`, `in_flight`, `timeline`, `state`, `stats` (`src/situation/serialize.ts`), and an empty section is serialised as the string `"none"` (which is why the view filters `none`). See [learn-situation-triage.md](./learn-situation-triage.md).

### 10. Controls

| Control | Code | Effect |
|---|---|---|
| Pill click | `open(true)` | Shows the panel and hides the pill. `bits = ALL` and flush, then `setTab(tab, focus)` and `startTicking()`. |
| Minimize / Escape in panel | `close(true)` | Hides the panel, shows the pill and focuses it. Escape calls `stopPropagation`. |
| Alt+Shift+G | `toggle(true)` | Capture listener on `doc`. Requires `altKey && shiftKey && !ctrlKey && !metaKey` and `code === "KeyG"` or `key` `G`/`g`. Calls `preventDefault()` (not `stopPropagation`). |
| Tab click / arrows | `setTab(t, focus)` | Updates `aria-selected` and the roving `tabindex`, and shows the pane. Selecting `now` calls `renderNow()`. The first visit to `activity` scrolls to the bottom. |
| Mode radio click / arrows | `setMode(m, focus)` | `rt.setMode(m)` (errors swallowed), `renderMode()`, all det cards marked dirty (the wording of "would have" notes depends on the mode), mark `LISTS`. **Arrow keys change the runtime mode immediately** (selection follows focus). |
| Pause / Resume | `setPaused(p)` | Toggles `aria-pressed`, the label and the icon. Resuming resets `unseen`. Then flushes `LISTS \| EVENTS` and re-renders Now. |
| Clear | `clear()` | Removes all cards and rows and empties `acts`, `dets`, `rows`, `rowBySeq`, `detOf`, `opRows`, `evq` and `unseen`. **Keeps** `decs`, `actOf`, `msgs` and `opNames`. Shows the empty states. |
| Roving keys (`roving`) | tabs and mode radios | ArrowRight/ArrowDown → next, ArrowLeft/ArrowUp → previous (both wrap), Home → first, End → last. |

Timing:
- `startTicking()` runs while the panel is open, every 1000 ms through `after()`. `after()` uses `clock.setTimeout` from the plugin API, or `rawSetTimeout` when no plugin clock is known.
- Each tick re-renders Now when it is visible and not paused. Every 5th tick it rewrites every `time.ago` label from `now() - data-at`.
- The tick loop stops on the first tick after the panel closes or the overlay is unmounted.
- `now()` is `clock.now()`, or else the largest `at`/`t` seen (`lastT`).

### 11. Unmount

`unmount()` is idempotent. It sets `dead = true`, which makes pending rAF flushes, ticks and listener callbacks no-ops. It calls every `offs` entry: runtime listeners, the plugin disposer, the `matchMedia` listener and the hotkey listener. Then it removes the host. `handle.element` becomes `null`. Remounting creates a fresh `Devtools`, which backfills from the runtime buffers again.

### 12. Packaging, bundle size and dev-only loading

1. Build: `packages/runtime/tsup.config.ts` has the entry `"devtools/index": "src/devtools/index.ts"` (ESM, `target: "es2022"`, `splitting: true`, also listed in `dts.entry`). `packages/runtime/package.json` → `exports["./devtools"]` = `{ types: "./dist/devtools/index.d.ts", import: "./dist/devtools/index.js" }`; the package sets `"sideEffects": false`.
2. The entry imports only `type`s from `../types.js` plus its own `./css.js` and `./ui.js`, so `dist/devtools/index.js` is self-contained: it pulls no runtime chunk and no ONNX code. It does have module-load side effects (captures `rawRaf` / `rawSetTimeout`, module counters `instances` and `markN`, and the `D` document slot in `ui.ts`) but touches no DOM until `mountDevtools` runs.
3. Size: the README claims **52 KB minified / 17 KB gzip**. `tsup.config.ts` sets no `minify` option (it does set `sourcemap: true` and `treeshake: true`), so `dist/devtools/index.js` from `npm run build` is unminified and larger; the 52 KB figure presumably assumes the app's bundler minifies it (unverified). See Drift item 7 for the size of the unminified build.
4. Recommended loading (documentation only, `packages/runtime/README.md`): import lazily in development so production bundles never include it:

   ```ts
   if (import.meta.env.DEV) {
     const { mountDevtools } = await import("@genclass/runtime/devtools");
     mountDevtools(rt);
   }
   ```

   There is no `NODE_ENV` / `DEV` check inside the library (Drift item 8). `OPEN_TASKS.md` item 13 (**Docs**) now only says whether a dev-only lazy import is still needed is (unverified).
5. Mounting reads `rt.status` but never `rt.ready`. In the real runtime, reading `ready` starts a lazy model load (`src/runtime.ts` → `get ready`), so opening the overlay does not by itself download the model.
6. SSR: with no `document` (and no `options.container`), `mountDevtools` returns the no-op handle, so the call is safe in server code. Importing the module server-side is also safe because module load only reads `globalThis.requestAnimationFrame` / `setTimeout` optionally.

## Configuration and constants

| Name | Type | Value | Defined in | Effect |
|---|---|---|---|---|
| `position` option | `DevtoolsPosition` | `"bottom-right"` | `index.ts` → constructor | host offset `16px` from those two edges, `.root[data-pos]` alignment and pop-in animation |
| `collapsed` option | boolean | `true` | `index.ts` → constructor | `false` → `open(false)` at mount |
| `theme` option | `"auto" \| "light" \| "dark"` | `"auto"` | `index.ts` → constructor | `.root[data-theme]`. `auto` follows `prefers-color-scheme` live. |
| `tab` option | `DevtoolsTab` | `"interventions"` | `index.ts` → constructor | initially selected view |
| `hotkey` option | boolean | `true` | `index.ts` → constructor | Alt+Shift+G toggle listener |
| `container` option | `HTMLElement` | `document.body` (fallback `documentElement`) | `index.ts` → constructor | DOM parent and document. The host stays `position:fixed`. |
| `MAX_CARDS` | number | `200` | `index.ts` | per-feed card bound, also `interventions(MAX_CARDS)` at backfill |
| `MAX_ROWS` | number | `400` | `index.ts` | activity rows, `evq` cap, `history(MAX_ROWS)` at backfill |
| backfill decisions | literal | `200` | `index.ts` → `backfill` | `rt.decisions(200)` |
| backfill detection threshold | literal | `0.6` | `index.ts` → `backfill` | `diagP(d) >= 0.6`. Hard-coded: it does not read `policy.thresholds.report`. |
| repeat window | literal | `60_000` ms | `index.ts` → `addDet` | detection folding (measured from the card's latest repeat) |
| map bounds | literals | `decs` 500, `msgs` 500, `actOf` 1000, `detOf` 1000, `opNames` 2000 | `index.ts` | memory caps via `bound()` |
| render bits | consts | `STATUS=1`, `MODE=2`, `LISTS=4`, `EVENTS=8`, `ALL=15` | `index.ts` | dirty flags |
| rAF fallback | literal | `16` ms | `index.ts` → `mark` | used when `requestAnimationFrame` is missing |
| tick | literal | `1000` ms; "ago" labels every 5 ticks | `index.ts` → `startTicking` | Now refresh, relative times |
| auto-scroll slack | literal | `32` px | `index.ts` → `renderEvents` | stick-to-bottom threshold |
| answer rows | literal | top `6` | `index.ts` → `answer` | bars per question |
| copy feedback | literal | `1400` ms | `index.ts` → `copyBtn` | label reset |
| host z-index / offset | literals | `2147483646` / `16px` | `index.ts` → constructor | stacking and placement |
| panel size | CSS | `width:min(444px,calc(100vw - 24px))`, `height:min(660px,calc(100vh - 24px))` | `css.ts` → `.panel` | panel box |
| card body clamp | CSS | 3 lines | `css.ts` → `.cx` | body truncation |
| code block max height | CSS | `220px` | `css.ts` → `.code` | evidence and Now blocks scroll |
| `ago` "just now" | literal | `< 1500` ms (or non-finite) | `ui.ts` → `ago` | relative-time wording; otherwise `Ns ago`, `Nm ago` or `Nh ago` |
| `dur` formats | literals | `<1000` → `N ms`; `<10000` → `N.NN s`; `<60000` → `N.N s`; else `Mm SSs` | `ui.ts` → `dur` | durations |
| `clockT` | literal | `<100 s` → `12.48s`, else `m:ss.s` | `ui.ts` → `clockT` | activity timestamps |
| `mb` | literal | bytes/1048576, 1 decimal below 100 MB | `ui.ts` → `mb` | status strip sizes |
| user value quote | literal | 40 characters (39 + `…`) | `ui.ts` → `eventText` | activity text for user events |
| state paths shown | literal | 3 + `+N` | `ui.ts` → `eventText` | activity text for state events |
| expanded data value | literal | 300 characters (299 + `…`) | `ui.ts` → `dataLines` | expanded activity rows |
| `LEAD`, `NOUN`, `ADJ` | records | see source | `ui.ts` | title templates (`actTitle`, `diagTitle`, `phrase`) |
| `TABS`, `MODES`, `FILTERS`, `QLABEL` | arrays/records | 4 tabs; 3 modes with tooltips ("Observe (default): never changes execution; …", "Guard (opt-in): … minimal actions (drop, defer, coalesce, delay)", "Heal (experimental): broader autonomous recovery …"); 6 filter groups; `{diagnosis: "Diagnosis", action: "Action"}` | `index.ts` | labels |
| runtime: `DECISIONS_KEPT` | number | `200` | `src/runtime.ts` | size of `decisions()` / `interventions()` buffers; the explain map evicts its oldest entry when it exceeds `DECISIONS_KEPT * 2` = 400 (checked only when a decision is added) |
| runtime: `historySize` | `InitOptions` (inherited by `CreateOptions`) | `500` | `src/runtime.ts` (`new EventLog(o.historySize ?? 500)`) | how far back `history()` can backfill |
| runtime: `thresholds.report` | `PolicyOptions` | `0.6` | `src/decide/policy.ts` | when the runtime fires `detect` |

Status strip strings (`renderStatus`):

| State | Title | Meta |
|---|---|---|
| `ready` | `Model ready` | `WebGPU` or `WASM`, then `variant`, then `<mb(progress.total)> MB`, then `loaded in <dur(loadMs)>`, joined by ` · ` (only the parts that are present) |
| `loading` | `Loading model` | `<loaded> / <total> MB · <pct>`, or `starting…` |
| `error` | `Model unavailable` | `observing only · <error>`, or just `observing only` when `status.error` is unset |
| `off` | `No model` | `observing only · no decisions` |

The tooltip also shows `status.model`.

Empty Interventions text (`renderEmpty`), checked in this order:

| Condition | Title |
|---|---|
| status `loading` | `Model loading` |
| status `off` or `error` | `Observing only` |
| mode `observe` | `No interventions in observe mode` |
| mode `heal` | `No interventions yet` (with the heal explanation) |
| otherwise (guard) | `No interventions yet` (with the guard explanation) |

The mode comes from `Devtools.mode()`, which falls back to `observe` (the runtime default since f3636b2) when `rt.mode` throws. On a runtime created with no `mode`, the empty Interventions state is therefore `No interventions in observe mode`.

The Detections empty state is fixed: `Nothing flagged`. The Activity empty state is `Waiting for activity`.

Theme tokens (`css.ts` → `LIGHT` on `.root`, `DARK` on `.root[data-theme=dark]`; there is no `@media (prefers-color-scheme)` in the sheet, the `theme` option drives `data-theme`):

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg` / `--bg2` / `--bg3` | `#fff` / `#f8f8fa` / `#f0f0f3` | `#111215` / `#16171b` / `#202127` | surfaces, status strip and code blocks, chips/tracks |
| `--hover` | `#f6f6f8` | `#1a1b20` | row hover, expanded row |
| `--line` / `--line2` | `#e7e7ec` / `#d8d8df` | `#26272e` / `#34353e` | borders, scrollbars, idle bars |
| `--fg` / `--fg2` / `--fg3` | `#15161b` / `#4d505c` / `#868a97` | `#ececf1` / `#a3a6b3` / `#6d707e` | text levels |
| `--brand` / `--brand2` | `#5145e6` / `#7a5cf5` | `#958dff` / `#b19bff` | interventions, GenClass group, focus ring, progress gradient end |
| `--brand-bg` / `--brand-line` | `#f1f0ff` / `#dddaff` | `rgba(149,141,255,.13)` / `rgba(149,141,255,.3)` | intervention tints, `new` card border |
| `--warn` / `--warn-bg` / `--warn-line` | `#b45d09` / `#fff6e5` / `#f8dfb3` | `#f4b552` / `rgba(244,181,82,.11)` / `rgba(244,181,82,.26)` | detections, `×N`, pause banner and pressed pause button |
| `--ok` / `--ok-bg` | `#15803d` / `#eaf8ef` | `#51d28e` / `rgba(81,210,142,.11)` | ready dot, state group, `Undone`, Live |
| `--bad` / `--bad-bg` | `#d12f22` / `#fff0ee` | `#ff6f64` / `rgba(255,111,100,.11)` | error dot, failed notes, error group |
| `--blue` / `--blue-bg` | `#2563eb` / `#eef4ff` | `#6ea4ff` / `rgba(110,164,255,.12)` | user group, observe dot, progress gradient start |
| `--note` | `#f5f5f8` | `#1a1b20` | note background |
| `--seg` | `#fff` | `#2c2d35` | checked mode segment |
| `--sh` / `--sh-sm` | layered light shadows | layered dark shadows | panel / pill shadows |
| `color-scheme` | `light` | `dark` | native controls (search input, scrollbars) |
| `--font` | `Inter, "Inter Variable", ui-sans-serif, system-ui, …` | same | UI font (13px/1.45, tabular numerals) |
| `--mono` | `"JetBrains Mono", "JetBrains Mono Variable", ui-monospace, …` | same | code, timestamps, answer labels |
| `--ring` | set per class on `.pill.pa::after` (`--brand`) / `.pill.pdd::after` (`--warn`) | same | pill pulse colour |

Animations (all disabled under `prefers-reduced-motion: reduce`): `ring` 1.5 s pill pulse, `bump` 0.5 s counter, `blink` (loading dot 1.1 s, Live dot 1.6 s), `spin` 0.8 s, `pop`/`popd` 0.22 s panel entry (bottom / top positions), `enter` 0.45 s new card, `fresh` 1.2 s new activity row.

## Invariants and gotchas

- **Read-only except two writes.** The overlay may only call `setMode` and `ActionRecord.undo`. Its only other runtime-visible effects are the setup-only `use()` plugin (for the `Clock`) and the `data-genclass-ignore` host attribute (next invariant). Never add calls that hold, act or ask the model from the overlay. Every runtime read is wrapped in `safe()` or try/catch, so a broken runtime method degrades a view instead of throwing into the app.
- **`data-genclass-ignore` is load-bearing.** Without it, overlay clicks, Enter/Escape keys and typing in the activity filter box (`input`/`change`) become `user` ops (the DOM user observer listens to `click`, `input`, `change`, `submit` and `keydown`). They would then appear in timelines, become causes, and corrupt "the last user action was …" facts. The skip lives in `src/observe/dom-user.ts` → `ignoredEvent` and is tested in `test/dom.test.ts`. Keep the attribute on the host, and keep interactive UI inside the host.
- **No trace pollution from timers.** The overlay's timers go through the runtime `Clock` from the plugin API. Browsers use the runtime's `browserClock`, which captured the real `setTimeout` before the timers observer wrapped it.
  - `rawRaf` and `rawSetTimeout` are captured when the **devtools module** loads. `requestAnimationFrame` is never wrapped (`src/observe/timers.ts` wraps only `setTimeout`/`setInterval`).
  - With the recommended lazy import after `GenClass.init`, `rawSetTimeout` may be the wrapped one. It is used only by the Copy-button reset and by the no-plugin fallback. A wrapped timer only materialises an op if its callback writes state or starts a request, and these callbacks do neither.
- **Virtual clocks.** Under a virtual clock (the sim's, or `VirtualClock` in `session.ts`), ticks and "ago" labels advance only when the clock advances. Scheduled list flushes use the real rAF, so they still render in tests. If an environment has no rAF, scheduled flushes go through `after(16)` on the plugin clock, so with a non-advancing clock they never run; only the synchronous flushes (open, undo, evidence, pause, clear) render then.
- **`setDoc` is module-global.** Two overlays in different documents loaded from one module instance (e.g. iframes) share `D`. Elements are created in whichever document was mounted last. One overlay per document per module instance is the supported case.
- **Reports from before mount are lost.** The runtime has no report history API, so cards backfilled at mount use the `ui.ts` templates. `Explanation.message` exists now but the overlay does not use it (see Drift). Template wording differs from `src/decide/report.ts` in places.
- **Detections in backfill and live can disagree.** Live detections are whatever the runtime fires on `detect` (`diagnosisConfidence >= policy.thresholds.report`). Backfill re-derives them with the literal `0.6`. An app that sets `policy.thresholds.report` sees a different Detections list after a remount.
- **Repeat folding is not the console's rule.** The overlay slides its window to the latest repeat (`same.at = d.at`). The `Reporter` uses a fixed 60 s window from the first report. Counts can differ from the console's `×N more` summaries.
- **Counters are bounded.** The intervention counter is `acts.size` (≤ 200). The detection counter is the sum of fold counts over ≤ 200 cards. Neither is a runtime total. `clear()` resets both.
- **Pause freezes rendering, not intake.** While paused, `flush` skips lists and events, and **that includes the Undo and Evidence clicks**. The undo itself runs, but the card is not redrawn until Resume (code reading; no test). Counters, status and mode still update.
- **The mode can change outside the overlay.** The `status` event updates the radios and the pill. Detection notes are refreshed only when the change came through the overlay's `setMode`, which marks det cards dirty. A console `rt.setMode()` leaves "Would have run … in X mode" notes stale until another update touches those cards (code reading).
- **Arrow keys on mode radios switch the runtime mode immediately.** This is tested (`ArrowLeft` from guard calls `setMode("observe")`). Do not "fix" it without updating `devtools.test.ts` and `ui-devtools.spec.ts`.
- **A failed action's body can repeat the failure.** `interventionLine` puts `(failed: …)` after `changed`. `splitReport` strips `changed` only when it is the exact suffix, so for a failed action with a live report sentence the body keeps `changed` plus `(failed: …)`, next to the `Action failed: …` note (code reading; no test).
- **Several v2 fields are not rendered.** `Decision.candidate`, `Decision.mass`, `Decision.subjectRef`, `ActionRecord.dropped`, `Situation.compact` / `budget`, and every `ModelStatus` field other than `state`, `progress`, `device`, `variant`, `model`, `loadMs` and `error` (for example `phase`, `version`, `bytes`, `fromCache`, `threads`, `warmupMs`, `worker`, `gpu`, `attempts`, `ort`) never appear in the overlay. `ActionRecord.late` is used only for the title: `card()` passes `!!a.late` to `actTitle`, so a late revert reads "Reverted …" both from the live report sentence and from the template. It has no badge or evidence row of its own.
- **Write discards are usually late reverts in situation-v2.** Since runtime batch 4 (fcd1e68) store writes are not held unless `policy.holdWrites` is set (`src/types.ts` → `PolicyOptions.holdWrites`, default false), so a `discard` of a write usually lands after the write applied (`ActionRecord.late`, title "Reverted …"). A stale response is decided earlier, at the network boundary, as a `delivery` decision (title "Prevented a stale response"). Its `ActionRecord.changed` reads `Delivered <what> and dropped the state changes it makes over newer data (<up to 3 conflicting paths>).`, and the paths actually dropped are collected in `ActionRecord.dropped` (`src/runtime.ts`, the delivery controller's `discard` branch), which the overlay does not show. Do not assume a stale-result intervention has trigger `mutation`.
- **Activity decision rows show no percentage for the real runtime.** The runtime's `decision` event data is `{ id, diagnosis, action, executed }`, with no `confidence` (`src/runtime.ts`). Only the mock scenario includes `confidence`.
- **CSS isolation rules:**
  - The stylesheet must never target `html`, `body` or `:root`. A regex test enforces this.
  - Every custom property the sheet reads is defined on `.root`, except `--ring`, which is set on `.pill.pa::after` / `.pill.pdd::after` where the `ring` keyframes read it. Inherited page variables with the same names (custom properties cross the shadow boundary, and `all:initial` does not reset them) are therefore shadowed. Keep that true when you add tokens.
  - No `::part()` hooks or theming API are exposed. The page can only position or hide the host.
  - The overlay does not load fonts. It names `Inter` and `JetBrains Mono` with system fallbacks. Only the Playwright page embeds the font files.
  - `prefers-reduced-motion: reduce` disables all animations and transitions inside `.root`.
- **No `innerHTML`.** Use `h()` with `text:` and `icon()`. App-controlled strings (subjects, facts, event data) are rendered only through `textContent`.
- **The SVG mini-parser is not an HTML parser.** `ui.ts` → `svg()` understands only elements with double-quoted attributes. New icon markup with text, comments, single quotes or `>` inside attribute values renders wrong silently. Never pass app data to `svg()`.
- **Mounting must not start a model load.** The overlay reads `rt.status` and never `rt.ready` (reading `ready` starts a lazy load in `src/runtime.ts` → `get ready`). Keep it that way so `preload: "lazy"` apps stay lazy while the overlay is open.
- **The hotkey does not swallow the key.** The capture listener on `doc` only calls `preventDefault()`, so app handlers still see Alt+Shift+G. The runtime's DOM user observer records only Enter and Escape keydowns (`src/observe/dom-user.ts` → `onKey`), so the hotkey never becomes a `user` op. Escape inside the panel is stopped from bubbling and, being inside the ignored host, is not recorded either.
- **The overlay's token names collide with typical app names.** `page.ts` defines `--bg`, `--line`, `--fg` and `--fg2` on the app's `:root`. Because `.root` redefines every token it reads (`--ring` is set on the pill pseudo-elements instead), those inherited values never reach the overlay. A new `var(--x)` without a `.root` definition would silently inherit the app's value.
- **Performance budget.** Intake is O(1) per event (plus `bound()` eviction and the `evq` splice), except `addDet`, which scans up to 200 det cards for a matching `repeatKey`. Rendering is at most one flush per frame, and a list flush walks ≤ 200 entries per feed. `situation()` is called only while the Now tab is visible and the panel is open (1 Hz). `explain()` is called only when an evidence block is first opened.
- **Bundle.** The devtools entry must keep importing only `type`s from `../types.js`. A value import would pull runtime chunks into the dynamic `import("@genclass/runtime/devtools")` (tsup `splitting: true`).

## How to change it safely

Light local checks (`npm ci`, `tsc`, `tsup`, vitest unit tests) are fine on this machine; HANDOFF.md's "never run npm/tsc/vitest on the Mac" rule is about the colleague's 8 GB Mac. Ask the user before the Playwright UI spec ([where to run things](./build-test-release.md#where-to-run-things)). CI (`.github/workflows/ci.yml`, commit b435acb) runs both devtools vitest files on pushes to `main`, `runtime`, `mvp` and `mvp-v2`, on every pull request and on manual dispatch, but not the Playwright spec (its unit-test step passes `--exclude "test/browser/**"`).

### Add a mount option

1. Add it to `DevtoolsOptions` in `src/devtools/index.ts` with a JSDoc default, and read it in the `Devtools` constructor.
2. Mirror the field in `demos/src/dev/runtime-shim/devtools.ts`, which duplicates the interface.
3. If the option affects layout or theme, add an assertion like the "honours theme and position" test in `test/devtools.test.ts`.
4. `test/browser/ui/page.ts` passes the full options object through, so the spec can exercise it.

### Add or change a view (tab)

1. Extend `DevtoolsTab` and `TABS`, and add a pane in the constructor's `panes` record (`pane(id, …)`). `setTab` and the roving keys pick it up automatically. Keep `interventions` and `detections` as the first two `TABS` entries: the tab counters `nA`/`nD` are looked up as `tabBtns[0]` and `tabBtns[1]`. Also widen the `tab` union in `demos/src/dev/runtime-shim/devtools.ts`.
2. If it polls the runtime, gate it like `renderNow` (open, tab selected, not paused, not dead) and refresh it from `startTicking`.
3. Add a `data-pane` assertion test and a screenshot entry in the loop over `["detections", "activity", "now"]` in `ui-devtools.spec.ts`.

### Show a new `Decision` or `ActionRecord` field on cards or in evidence

1. Render it in `card()` (chips or note) or `evidence()` (a new `sec(title, extra, …)`). Use `h()` with `text`.
2. Add the field to `makeDecision` or `makeAction` in `test/browser/ui/mock-runtime.ts` and set it in `scenario.ts`. Assert it in `devtools.test.ts`.
3. When the field comes from a CORE change, coordinate through `UI-NEEDS.md` / `STATUS.md`. If it changes the situation text, SIM must be involved (see [model-io-contract.md](../model-io-contract.md)).

### Change report wording or templates

1. The runtime sentences come from `src/decide/report.ts` (`interventionLine`, `detectionLine`). If you change their shape, check that `splitReport`'s regexes in `ui.ts` still strip:
   - the `[GenClass]` prefix
   - the `(diag, p; action p)` tail
   - `Not acted on (…): …`
   - a `(×N …)` suffix
2. Keep `LEAD` and `NOUN` in `ui.ts` aligned with `report.ts` when you intend the same wording (the current differences are listed in Drift). A new `TriggerKind` in `src/types.ts` needs a `NOUN` entry in both files; without one, `phrase` falls back to the raw trigger name.
3. Update the expected titles in `devtools.test.ts` and `devtools-runtime.test.ts`. The latter's titles come from the templates, because the session runs before mount.

### Use the runtime sentence for cards recorded before mount (UI-NEEDS item 3)

In `card()`, when `msg` is undefined, fall back to `safe(() => this.rt.explain(id)?.message, undefined)` for the action id or decision id. Then update the assertion under the comment "reports emitted before mounting are not replayed" in the `devtools.test.ts` test "renders interventions, detections, status and counters from the runtime"; it currently expects the lead fact as the `.cx` body. Also re-check the title and `.cx` body expectations in `devtools-runtime.test.ts` (its first test matches the body of the "Prevented a stale response" card against a regex). `MockRuntime.explain` returns `scenario.ts` explanations, which lack `message`. Add it there.

### Change styling or theme

1. Edit `css.ts` only. Add tokens to both `LIGHT` and `DARK`, and use them via `var(--x)` inside `.root` selectors.
2. Do not add selectors for `html`, `body` or `:root` (a test checks this).
3. Run `ui-devtools.spec.ts`, review the regenerated PNGs in `test/browser/ui/screenshots/` (there is no pixel diff), and commit them if intended.

### Add an icon

1. Add the inner SVG markup to `ICONS` in `src/devtools/ui.ts` (24×24 coordinate space, stroke-only paths, double-quoted attributes, no text). `IconName` picks it up automatically.
2. Use it with `icon("name")` (or `icon("name", "i chev")` for an extra class). The `.i` class in `css.ts` sets 16×16, `fill:none`, `stroke:currentColor`, `stroke-width:1.8`.

### Add or change an activity event kind, label or filter group

1. Labels: `KIND_LABEL` (non-op kinds) and `OP_LABEL` (op kinds from `data.kind ?? data.opKind`) in `ui.ts` → `kindLabel`.
2. Row text: a `case` in `ui.ts` → `eventText`. Groups: `ui.ts` → `groupOf` and the `Group` type.
3. A new group also needs an entry in `FILTERS` (`index.ts`) and, for a coloured badge, `.g-<group> .k` and `.f.g-<group>[aria-pressed=true]` rules in `css.ts`.
4. If the runtime adds a new `EventKind` (`src/types.ts`), it falls into `other` until you map it. Extend the activity assertions in `devtools.test.ts` (`rows.length`, group filters) and, for real-runtime events, `devtools-runtime.test.ts`.

### Change the Now view

1. Edit `renderNow` in `index.ts`. Section sources are `Situation` fields (`trigger`, `salient`, `subject`, `facts`, `actions`) and `Situation.state` keys from `src/situation/serialize.ts` (`app`, `trigger`, `facts`, `in_flight`, `timeline`, `state`, `stats`). If those keys are renamed (a SIM-coordinated change to the situation format, which is frozen at tag `situation-v2`; see [learn-situation-triage.md](./learn-situation-triage.md)), update `renderNow` and `scenario.ts`'s scripted `sit.state`.
2. Keep the gating: Now polls `situation()` only when open, on the Now tab, not paused and not dead.
3. Tests: "renders the Now view from runtime.situation() and reports failures" (`devtools.test.ts`) and "renders runtime.situation() in the Now view" (`devtools-runtime.test.ts`).

### Subscribe to a new runtime event

1. Add it to `RuntimeEvents` in `src/types.ts` (CORE) and to `subscribe()` through the local `on()` wrapper, which handles the dead-guard and the unsubscribe.
2. Extend `MockRuntime` if needed. Update the unmount test's list `["event", "act", "detect", "decide", "status", "report"]` so that it asserts zero listeners afterwards.

### Change the `Runtime` interface the overlay uses

`MockRuntime implements Runtime`, but test files are not type-checked (`packages/runtime/tsconfig.json` has `include: ["src"]`). Update `mock-runtime.ts` and `demos/src/dev/runtime-shim/*` by hand, then run both devtools vitest files.

### Commands (from `packages/runtime`)

- Unit and integration: `npx vitest run test/devtools.test.ts test/devtools-runtime.test.ts`. Also run `test/dom.test.ts` if you touch the ignore attribute, and `test/adapters-*.test.ts` if you touch `mock-runtime.ts`. Plain `npm test` (`vitest run`, `include: ["test/**/*.test.ts"]`, `exclude: ["test/browser/**"]`) runs all of them.
- Browser: from the repo root, `npx playwright test --config packages/runtime/test/browser/ui/playwright.config.ts`. `npm run test:browser` also picks up `ui-devtools.spec.ts`, because the main `test/browser/playwright.config.ts` matches every `*.spec.ts`.

## Tests

`npx vitest run test/devtools.test.ts test/devtools-runtime.test.ts` (from `packages/runtime`) passes on mvp-v2 at b435acb: 2 files, 27 tests (20 in `devtools.test.ts`: 4 mount, 12 feeds, 4 controls; 7 in `devtools-runtime.test.ts`), run 2026-10-08. The Playwright spec was not run.

| Test file | What it asserts |
|---|---|
| `test/devtools.test.ts`, "devtools: mount" | Host tag, parent and open shadow root. `data-genclass-ignore` is set. One listener each for `event` and `act` (the only two counted at mount) and one plugin. No `<style>`/`<link>` or stylesheet added to the document. Unmount removes the host, all 6 listeners and the plugin, `element` becomes `null`, and a second unmount is safe. Styles live only in the shadow root, and `CSS` never targets `html`, `body` or `:root`. The host is `fixed` with z-index `2147483646`. A null runtime gives a no-op handle. `theme: "dark"` and `position: "top-left"` give `data-theme`, `data-pos` and `top`/`left` of `16px`. |
| `test/devtools.test.ts`, "devtools: feeds" | Counters (3 and 3), status "Model ready" with WebGPU. Intervention order `a3, a2, a1` and template titles. The body is the lead fact (pre-mount reports are not replayed). The diagnosis chip shows `stale 97%`. Undo is shown for discard and hidden for coalesce. Detection titles and "Would have run hedge in heal mode.". Activity pairing (row count = events − min(starts, ends)), `2001.82 s`, `#3`, an in-flight spinner, `← #n` on state rows, group and text filters, row expansion (`value: 3`, `op: #17`). A typing-burst re-emit updates a single row. Evidence content equals `explain("a1")` (facts, situation text, top answers, deny hint) and collapses. Undo calls `undo` once and shows Undone. A throwing undo shows `Undo failed: store gone`. A live act pulses the pill (`pa`), updates the counter and `aria-label`, and a later report sentence replaces the body minus `changed`. Detections fold ×3 with the passive note. An executed non-passive decision never becomes a detection. The 200-card cap holds while the panel is closed (newest `a210`, oldest `a11`). The policy-held note text. Pause shows `Feed paused · 1 new` while counters stay correct, and resume renders. Clear empties everything. The Now view comes from `situation()`, and a throw shows `situation() failed`. |
| `test/devtools.test.ts`, "devtools: controls" | A click on the heal radio records `calls.setMode` = `["heal"]` and updates the radio and pill. The would-have note switches wording with the mode when no reason is given. Keyboard: the pill is a `<button>`, focus moves to the tab, ArrowRight and End work, ArrowLeft on the mode radio calls `setMode("observe")`, Escape closes and focuses the pill, Alt+Shift+G reopens. Empty-state text by model state: "Model loading", `4.8 / 19.1 MB · 25%` with the bar at 25%, then "No interventions yet" and `WASM · q8`. |
| `test/devtools-runtime.test.ts` | Mounted after `runStoreSession()` on the real runtime (explicit `mode: "guard"`). Interventions are, newest first: Prevented a stale response (the typeahead `delivery` decision, situation-v2), Reverted a duplicate write (late `mutation` discard), Prevented a duplicate request, Slowed down a failing request. The stale card's body matches `/^search\.results was written \w+ by other operations since its operation/` and its chip is `stale97%`. `.chg` equals `ActionRecord.changed`. Undo is present for discard and absent for coalesce. Detections are: Slow request, Unusual state change, Inconsistent state, Failing request ×3, with their notes. The detection count matches the runtime's decisions. Evidence equals `explain()` (situation text contains `trigger: The response to GET /api/search?q=rea`, top labels `stale`/`discard`). Activity has more than 60 rows, `2001.82 s`, the typing burst `= "react" (2 keystrokes)`, an in-flight spinner, `model` rows and error rows. The Now subject equals `situation().subject`, and "Acme Store" appears. Undo really applies the dropped write (results 4 → 8) and records an `action`/`undo` event. A new live stale intervention uses the runtime's report sentence (`[GenClass] Prevented a stale response: …`) without duplication. |
| `test/browser/ui-devtools.spec.ts` | Real Chromium: style isolation (stylesheet count, app CTA background and body font unchanged; shadow root and ignore attribute present; only 2 `<style>` tags, fonts and app). Real keyboard flow (Enter on the pill, ArrowRight, End, ArrowRight on radios gives `heal`, Escape, Alt+Shift+G). Undo marks the card. Screenshots for light and dark: `pill`, `overlay`, `interventions`, `evidence`, `evidence-answers`, `detections`, `activity`, `now`, `loading`. They are written only, never compared. |
| `test/dom.test.ts` (outside the scope, related) | Events inside `[data-genclass-ignore]`, including inside a `genclass-devtools` shadow root, are not recorded as user actions. |

Harness details:

- **`MockRuntime`** (`mock-runtime.ts`):
  - Test controls: `emitTo(type, v)`, `setStatus(s)` (emits `status`), `event(kind, name, {t, op, cause, data})` (emits `event`; `seq` auto-increments, `t` defaults to `clock.t`), `decision(d)` (emits `decide`, plus `detect` when `diagnosis !== "expected"` and `diagnosisProbabilities[diagnosis] ?? diagnosisConfidence` ≥ 0.6), `act(a)`, `report(r)`, `listenerCount(type)`.
  - Inspectable fields: `plugins`, `calls.{setMode, situation, explain, sets}`, `explanations` (Map), `sit`, `ops`, `events`, `decs`, `acts`, `mode` (starts `"guard"`, unlike the real runtime's `observe` default, so the mock-based tests keep exercising guard wording), `status` (starts `{ state: "off" }`).
  - Runtime API behaviour: `situation()` throws `no situation scripted` while `sit` is `null` (how the "situation() failed" test is driven). `explain(id)` returns `explanations.get(id) ?? null`. `history(n=500)`, `decisions(n=200)`, `interventions(n=200)` slice the recorded arrays. `use()` calls `setup` synchronously with a `PluginApi` whose `clock` is the `MockClock`, and its disposer removes the plugin. `setMode` records and sets `mode` but does **not** emit `status` (unlike the real runtime). `ask()` rejects (`mock runtime: no model`), `decide()` resolves the first option, `holdBudgetMs()` → `300`, `situationBudget()` → `2400` (equal to `STATE_CHAR_BUDGET` in `src/situation/serialize.ts`, the real webgpu/unknown-device default), `destroy()` clears listeners.
  - Store semantics for the adapter tests: `holdWrites` (hold every write made outside a synchronous `user()` handler unless `opts.hold === false`), `heldCount`, `flushHeld()` (apply in proposal order; functional updates re-run against the value at apply time), `dropHeld()` (the `discard` action: nothing applied, nobody notified), `genclassWrite(store, v)`, `subscribers(store)`. Applied writes emit a `state` event.
  - `MockClock`: mutable `t` (starts `0`; `now()` returns it), real `setTimeout`/`clearTimeout`, `afterTask` = `setTimeout(fn, 0)`.
  - `choice(probs)` returns a `ChoiceAnswer` whose `confidence` is `(k·p−1)/(k−1)` for k labels.
  - `makeDecision(p)` (requires `diagnosisProbabilities` and `probabilities`) defaults: id `d<n>`, `trigger "mutation"`, `subject ""`, `at 0`, `latencyMs 31`, `model "genclass-runtime-0.1"`, diagnosis and action = the top labels, `diagnosisConfidence` = the choice confidence above (**not** a probability), `confidence = probabilities[action]`, `executed false`, `tier "passive"`, `ran = action`, `facts []`, `answers = { diagnosis, action }` built with `choice`.
  - `makeAction(d, p)` defaults: id `a<n>`, fields copied from `d`, `at = d.at + 1`, `ok true`, `changed ""`, `undo` only when given.
- **`loadScenario(rt, { onUndo?, now? })`** (`scenario.ts`):
  - Status `ready`, `device "webgpu"`, `variant "fp16"`, `model "genclass-runtime-0.1"`, `progress.total 24_740_000` bytes (rendered as `23.6 MB` by `mb()`), `loadMs 1240`. Decisions carry `model "genclass-runtime-0.1 · fp16"`.
  - Interventions: `a1` discard (stale search write, undo calls `onUndo("a1")`), `a2` coalesce (double POST /api/orders, no undo), `a3` delay (failing GET /api/status, no undo). The mock also emits `detect` for their decisions `d1`, `d2`, `d4` (before mount in the tests, so nobody listens); at backfill `addDet` skips them because `actOf` already has them and they are executed non-passive.
  - Detections: `d3` unusual transition → rollback (heal), `d6` inconsistent → rollback (heal), `d5` slow stall → hedge (heal). All three carry `reason: "guard mode does not allow heal-tier actions"`, so their notes read "Would have run … in heal mode.".
  - Report sentences for all six are emitted **before** the test mounts, so the overlay never sees them (that is what "reports emitted before mounting are not replayed" relies on).
  - Explanations exist for `a1`, `a2`, `a3`, `d3` and `d6`, but not `d5` (its evidence shows the "no longer in the runtime's decision buffer" line). They are built by a local `explanation()` and `stateText()` (`key:\nvalue` blocks), and omit `message`.
  - Events: 48 scripted `RtEvent`s (nav, fetch op pairs with `data.kind "fetch"`, user, state with `data.paths`, decision events **with** `confidence`, action events, one `TypeError` error). `GET /api/search?q=rea` (#3) takes 2214 → 4031, i.e. the `2001.82 s` assertion is `200` + `1.82 s`. Op `#15` (`GET /api/recommendations?for=cart`, start 22100) never ends, so it shows a spinner.
  - The Now situation: `trigger "ask"`, `salient true`, 4 facts, `actions []`, `questions {}`, `state` with all seven `SituationParts` keys; `rt.ops` holds op `#15`. `rt.clock.t = now ?? 27_400` (so op #15 is `5.30 s` in flight).
- **`runStoreSession(opts)`** (`session.ts`):
  - Uses `createRuntime({ clock, global: { fetch: backend.fetch, Response, location }, decider, mode: "guard", report: "silent", observe: OBSERVE, app: () => ({ title: "Acme Store", route }) })`. `OBSERVE` sets `fetch: true` and `xhr`, `user`, `errors`, `nav`, `storage`, `perf`, `websocket`, `timers` to `false`. It does not list `eventsource`, which defaults to on, but the session's `global` object has no `EventSource`, so `installEventSource` installs nothing. User ops therefore come only from explicit `rt.user()` calls and errors from `rt.reportError()`. `mode: "guard"` is explicit since f3636b2 (the runtime default is now `observe`, which would act on nothing).
  - Stores (atoms): `session`, `search`, `cart`, `orders`, `status`, `recs`.
  - Warm-up (clock starts at `400`): `GET /api/session` and `GET /api/cart`, then 24 alternating cart add/remove ops 560 ms apart with a status poll every 4th and recommendations every 5th, so baselines, profiles and invariants are learned.
  - Story: (1) 4 failing polls 2 s apart, then a held poll (`delay`); (2) a partial `POST /api/cart` response without `total` (unusual transition, broken total invariant); (3) double "Place order" 90 ms apart (`coalesce` and a duplicate write); (4) recommendations latency 9000 ms (stall → hedge, not run in guard); (5) typeahead `rea` (1820 ms) vs `react` (210 ms): the late `rea` response is a `delivery` decision (stale → `discard`, dropping its `search.results` write); (6) a `TypeError` reported from a `change input "Qty"` handler.
  - `SessionOptions`: `warmupOnly` (return after the warm-up; used by the `loading` page scenario), `status` (initial decider status, default `READY`), `turn` (task-boundary function, default `realTurn()`).
  - `Session`: `rt`, `clock` (`VirtualClock`), `backend` (knobs `statusDown`, `partialCart`, `recsLatency` default 300, `searchLatency` map with a 180 ms default, `cart`), `decider`, `stores.search`, `app.{typeSearch, placeOrder, poll}` to keep driving the app after the story (the last `devtools-runtime.test.ts` test does this).
  - `VirtualClock`: `setTimeout` queues by virtual time; `advance(ms)` runs due timers in `(at, id)` order and calls `settle()` after each; `settle()` runs up to 64 rounds of 4 real turns, then the queued `afterTask` hooks, until none remain. `realTurn()` uses `setImmediate` (Node) or a `MessageChannel` (browsers).
  - `SessionDecider` (`DecisionProvider` test double): `judge(req)` maps `req.trigger` plus fact regexes to `[diagnosis, p, action, pa]`, e.g. `stall` → `slow 0.84 / hedge 0.71`, `transition` → `unusual 0.88 / rollback 0.64`, `inconsistency` → `inconsistent 0.9 / rollback 0.58`, stale `mutation` or `delivery` (facts match `by other operations since` and `later user action`) → `stale 0.97 / discard 0.98`; a `delivery` otherwise → `expected`. Remaining mass is spread over the other labels (62% of what is left each step, the last label takes the rest). It answers after `22 + (length of the facts joined with "\n") % 17` virtual ms (`factsOf(req).length`, a character count, not the number of facts). `READY` = `{ state: "ready", device: "webgpu", variant: "fp16", model: "genclass-runtime-0.1", loadMs: 1240, progress: { loaded: 24_740_000, total: 24_740_000 } }`.
- **`page.ts`**: `window.__gc = { start(opts), rt?, dt?, undos }`. `start({ scenario?, mode?, status?, ...DevtoolsOptions })` unmounts the previous overlay, destroys the previous runtime, re-injects `<style id="app-css">` and the Acme HTML, builds the runtime, applies `mode` via `setMode`, and calls `mountDevtools(rt, opts)` (the whole options object is passed through). Scenarios:

  | `scenario` | Runtime |
  |---|---|
  | `live` (default) | real runtime after the full `runStoreSession()` |
  | `loading` | real runtime after `runStoreSession({ warmupOnly: true, status: { state: "loading", progress: { loaded: 9_830_000, total: 24_740_000 } } })` |
  | `mock` | `MockRuntime` + `loadScenario`, undos pushed to `window.__gc.undos` |
  | `empty` | `MockRuntime` with `clock.t = 2600` and one `GET /api/session` op (start 1130, end 1342) |

  `status` is applied only to the mock scenarios (`mock`, `empty`). The app CSS defines `--bg`, `--line`, `--fg`, `--fg2` (plus `--card`, `--accent`) on `:root`, the same names as overlay tokens (see Invariants).
- **`ui-devtools.spec.ts`**: `beforeAll` bundles `page.ts` with esbuild (`iife`, `es2022`, external `onnxruntime-web` and `onnxruntime-web/webgpu`) into one HTML string with Inter and JetBrains Mono woff2 inlined from `<repo>/node_modules/@fontsource-variable/*`. Its `start()` emulates the colour scheme **and `reducedMotion: "reduce"`**, waits for both fonts and two animation frames. `shotPanel` clips the host's box plus 28 px (24 px for the pill). Screenshot sources: `pill` (live, collapsed), `overlay` (live, full 1280×800 viewport), `interventions`, `evidence` and `evidence-answers` (live, stale card: in situation-v2 the "Prevented a stale response" delivery card; the tracked PNGs were last committed in a53dd38, before batch 4, so they still show the old stale-write card: Drift 17), `detections`, `activity`, `now` (live), `loading` (loading scenario). The keyboard and undo tests use `scenario: "mock"`.
- **UI Playwright config**:
  - `testDir: ".."`, `testMatch: /ui-.*\.spec\.ts$/`
  - Chromium, viewport 1280×800, `deviceScaleFactor: 2`
  - timeout 90 s, 1 worker, `reporter: list`, `outputDir: ../../../test-results/ui`
  - The main `test/browser/playwright.config.ts` (`testMatch: /.*\.spec\.ts$/`, `globalSetup: ./build.mjs`, 600 s timeout) also runs `ui-devtools.spec.ts` in its `chromium` project.

## Drift and open issues

| # | Item | Docs say | Code says |
|---|---|---|---|
| 1 | DOM observer ignoring the overlay | `UI-NEEDS.md` lists it under **Open** (item 1) | Done. `src/observe/dom-user.ts` → `ignoredEvent` / `insideIgnored` checks `composedPath()[0]` and `target` across shadow roots. Tested in `test/dom.test.ts`. (The rewritten `STATUS.md` "For UI" section no longer mentions it; it now notes that synthetic events need `observe.untrustedEvents: true`, which does not affect the ignore check.) |
| 2 | `react-dom` devDependency | `UI-NEEDS.md` item 2 (Open). `packages/runtime/STATUS.md` "Open issues": "`react-dom` is not a devDependency" | `packages/runtime/package.json` devDependencies include `react-dom ^19.3.0` and `@types/react-dom ^19.0.0`. |
| 3 | `Explanation.message` (UI-NEEDS item 3) | "Nice to have"; pre-mount items fall back to templates | CORE has implemented it (`src/types.ts` → `Explanation.message`, `src/runtime.ts` → `explain`). The **overlay still ignores it**: `card()` reads only `msgs` from `on("report")`. This is open UI work (recipe above). |
| 4 | Mock budget methods | The old `STATUS.md` (654d822) said mock-runtime "needs `holdBudgetMs()` and `situationBudget()`"; the current `STATUS.md` "For UI" says batch 4's devtools items (NOUN `delivery`, "Reverted" for late reverts, mock budget) were done by the lead | Resolved: `MockRuntime` returns `300` and `2400` (the v2 default budget; it returned `3200` at 654d822). No open drift; kept for agents reading older notes. |
| 5 | Ownership | `docs/runtime/CONTRACT.md` layout table: `src/devtools/` "owner: CORE" | The same CONTRACT's later rule and `UI-NEEDS.md` say UI owns `src/devtools/**`. |
| 6 | Templates "mirror" `report.ts` | `ui.ts` comment: templates "mirror the runtime's console wording" | Differences: failure noun `failed request` (UI) vs `request failure` (report). UI-only adjectives `conflict→conflicting` and `overload→excessive`, plus the special case `failing request`. An unknown action is `Ran <action>` (UI) vs `Handled` (report). Both now use `Reverted` for a late revert. `delivery` noun: UI always `response`; report uses `message` when the subject does not start with `response` (WebSocket / EventSource deliveries, `src/decide/report.ts` → `noun`), so a pre-mount WebSocket card reads "… stale response" where the console says "… stale message". Detection cards use `diagTitle` ("Slow request"), never the report's "Flagged …". |
| 7 | Bundle size | `packages/runtime/README.md`: "52 KB minified, 17 KB gzip" (`OPEN_TASKS.md` no longer quotes a size) | The 52/17 KB figures are unverified: `tsup.config.ts` sets no `minify` and no minified build is checked in. The `tsup` build in the working tree on 2026-10-08 (mvp-v2) gives an unminified `dist/devtools/index.js` of 69,260 bytes, 20,310 bytes gzip (about 20.3 KB); 654d822 gave 69,191 / 20,276. |
| 8 | "dev-only lazy import" | `OPEN_TASKS.md` item 13 (**Docs**, under "Next") questions whether a dev-only lazy import is still needed, marking it (unverified) | The README already shows `if (import.meta.env.DEV) { … await import("@genclass/runtime/devtools") … }`. It is a documentation item only: there is no code-level dev guard in the library. |
| 9 | Folding "like the console's rate limiting" | comment in `addDet` | Sliding window (latest repeat) vs the `Reporter`'s fixed 60 s window from the first report. |
| 10 | Detection threshold | Runtime uses `policy.thresholds.report` (default 0.6, configurable) | Overlay backfill hard-codes `0.6`. |
| 11 | `scenario.ts` data shapes | `Situation` requires `compact` and `budget`; `Explanation` requires `message` (`src/types.ts`) | The scripted `sit` omits `compact`/`budget`, and the scripted explanations omit `message`. This compiles only because tests are not type-checked. |
| 12 | Font dependency of the UI spec | n/a | `ui-devtools.spec.ts` reads `node_modules/@fontsource-variable/{inter,jetbrains-mono}`, which are declared only in `demos/package.json` and resolve through workspace hoisting (the same class of issue as UI-NEEDS item 2). |
| 13 | "README screenshots" | `ui-devtools.spec.ts` header comment ("the README screenshots") and `session.ts` header comment ("the README screenshots") | No README or doc in the repo references `test/browser/ui/screenshots/*.png`: `git grep "screenshots/"` finds only the spec's own header comment plus unrelated `demos/` and `extension/` paths, and no file names `pill-light`, `overlay-light` or `interventions-light`. The 18 PNGs are tracked but unused by docs. |
| 14 | Mock vs real `setMode` | `index.ts` → `subscribe` comment: "setMode() is announced as a status change too" | True for `RuntimeImpl.setMode` (fires `status` and a `status` report). `MockRuntime.setMode` emits nothing, so unit tests cover the overlay's own `renderMode` path, not the `on("status")` path for mode changes. |
| 15 | Default mode | `docs/runtime/CONTRACT.md` §13 and `docs/runtime/API.md` (updated in f3636b2) say observe is the default | Code agrees: `src/runtime.ts` → `o.mode ?? "observe"`, `MODES` tooltips, `Devtools.mode` fallback. Only the test doubles still start in guard on purpose: `MockRuntime.mode = "guard"` and `runStoreSession` passes `mode: "guard"`. Older text elsewhere (e.g. the published 0.1.0-alpha.0, whose default is guard) still describes guard as the default. |
| 16 | Guard empty-state wording | `renderEmpty` guard text: "minimal, reversible actions" | The guard tooltip now lists "drop, defer, coalesce, delay"; `coalesce` and `delay` have no `undo` (the Undo button is absent on those cards), so "reversible" is not true of every guard action. Wording only. |
| 17 | Screenshots after batch 4 | `ui-devtools.spec.ts` writes 18 PNGs | Tracked PNGs were last committed in a53dd38 (before fcd1e68, batch 4), so `interventions`/`evidence` images show "Prevented a stale write", not the current "Prevented a stale response". The spec was not re-run on mvp-v2 (Playwright needs the user's go-ahead). |

Status of every `UI-NEEDS.md` item, verified against the code:

| UI-NEEDS item | File says | Verified status | Remaining work |
|---|---|---|---|
| 1. DOM user observer ignores the overlay | Open | Done in CORE (`src/observe/dom-user.ts` → `ignoredEvent`), tested in `test/dom.test.ts` | Move the item to "Done" in `UI-NEEDS.md` |
| 2. `react-dom` + `@types/react-dom` devDependencies | Open | Done (`packages/runtime/package.json`) | Move to "Done"; also fix `packages/runtime/STATUS.md` "Open issues" |
| 3. `Explanation.message` | Nice to have | CORE done (`src/runtime.ts` → `explain` builds `message` with `interventionLine` / `detectionLine` / `decisionLine`) | **UI open:** use it in `card()` for pre-mount items (recipe "Use the runtime sentence for cards recorded before mount") |
| Done: `on("report")` also with `report: "silent"` | Done | Verified: `src/decide/report.ts` → `Reporter.emit` calls the listener before the `silent` sink check | none |
| Done: `runtime.adapter()` with `propose({ fn, commit })` | Done | Out of scope here; see [state-and-adapters.md](./state-and-adapters.md) | none |

Open UI behaviours found by code reading (no tests):
- Undo and Evidence do not redraw while the feed is paused.
- Detection notes go stale after a mode change made outside the overlay.
- Failed-action bodies built from a live report sentence keep `changed` and `(failed: …)`, repeating the `Action failed: …` note.
- `Decision.candidate`/`mass` (what GenClass *would* run under the current policy) is not shown. The overlay's "would have run" note uses `d.action` and `d.tier`.

## Related docs

- [HANDOFF.md](../../../HANDOFF.md): the live handoff (current state and next steps)
- [../realapps.md](../realapps.md): the real-app corpus harness
- [public-api-and-lifecycle.md](./public-api-and-lifecycle.md): `Runtime` API, `on()` events, `explain`, `situation`, `setMode`, `use()`
- [observe-and-trace.md](./observe-and-trace.md): `RtEvent`, `EventLog` (`touch` for typing bursts), the DOM user observer and `data-genclass-ignore`, the timers observer
- [decide-policy-actions.md](./decide-policy-actions.md): `Decision`, `ActionRecord.undo`, report sentences (`src/decide/report.ts`), thresholds, tiers
- [learn-situation-triage.md](./learn-situation-triage.md): `Situation`, `SituationParts` keys rendered by the Now view, salience
- [model-host.md](./model-host.md): `ModelStatus` fields shown in the status strip
- [state-and-adapters.md](./state-and-adapters.md): the store semantics `MockRuntime` models for the adapter tests, and the adapters half of `UI-NEEDS.md`
- [build-test-release.md](./build-test-release.md): tsup entries, `exports["./devtools"]`, vitest and Playwright configs, VM-only builds
- [../overview.md](../overview.md)
- [../glossary.md](../glossary.md): devtools terms (pill, backfill, repeat folding, render bits) and runtime terms
- [../model-io-contract.md](../model-io-contract.md): what `situationText` is relative to the packed model request
- [../demos.md](../demos.md): how the demos mount the overlay (`?devtools=open`) and the runtime shim
- [../status-and-known-issues.md](../status-and-known-issues.md): UI-NEEDS, STATUS and OPEN_TASKS in context
- Source request log: [`packages/runtime/UI-NEEDS.md`](../../../packages/runtime/UI-NEEDS.md)
