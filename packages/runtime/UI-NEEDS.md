# UI → CORE requests

Owner: UI (devtools + adapters). Status of each item is kept up to date here.

## Open

1. **DOM user observer: ignore the devtools overlay.** Clicks and Enter/Escape keys inside the overlay reach the
   window capture listeners retargeted to its host element `<genclass-devtools data-genclass-ignore>`, so
   `src/observe/dom-user.ts` records them as app user actions ("click genclass-devtools"): they show up in
   timelines, become causes, and make "the last user action was …" facts wrong while a developer is looking at
   the overlay. Please skip events whose target (or `composedPath()[0]`) is inside `[data-genclass-ignore]`,
   e.g. `if ((e.target as Element)?.closest?.("[data-genclass-ignore]")) return;` in each handler. Generic: any app
   can mark its own debug UI the same way.

2. **Lead: `react-dom` (and `@types/react-dom`) as devDependencies of `@genclass/runtime`.** The React adapter
   tests render with `react-dom/client`; today it resolves only because the `demos` workspace hoists it.

## Nice to have

3. `Explanation.message` (the console line for that decision/action). `on("report")` now gives the overlay the
   sentence for everything that happens after it mounts; items recorded before mounting (e.g. the overlay is
   opened lazily) fall back to the overlay's own templates, which mirror `src/decide/report.ts`.

## Done (thanks)

- `on("report")` delivers every report line, also with `report: "silent"`.
- `runtime.adapter(name, { get, set?, subscribe? })` with `propose({ fn, commit })`: the Redux enhancer and the
  Zustand middleware use it (the original action / `set` arguments are committed when the write applies; whole
  states written by GenClass go through `set`).

## How the UI code uses the runtime (for reference)

- Devtools: only the public `Runtime` API (`status`, `mode`, `setMode`, `on(decide|detect|act|event|status|report)`,
  `decisions`, `interventions`, `history`, `explain`, `situation`, `inflight`, `ActionRecord.undo`). It registers a
  setup-only plugin (`use`) to read `api.clock`, so "4s ago" labels and its 1 s refresh use the runtime's clock
  (virtual in tests) and never go through instrumented timers. It renders with `requestAnimationFrame` captured
  at module load. `situation()` is polled once a second only while the Now view is visible.
- React hooks use `atom()`; Redux and Zustand use `adapter()`.
