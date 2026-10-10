# GenClass + React + Vite starter

A React 19 + Vite app with [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) installed the
recommended way: one import, first in the entry file.

```bash
npm install
npm run dev        # http://localhost:5173, with the GenClass devtools overlay
npm run build && npm run preview   # production build (no overlay)
```

Type a city quickly in the search box. The mock API (`mock-api.ts`, served by Vite) answers in a random
50-900 ms, so an older answer can overwrite a newer one: the classic stale typeahead. Open the overlay (bottom right)
to see what GenClass noticed; the browser console has one plain-English line per finding.

## The one line

`src/main.tsx` starts with:

```ts
import genclass from "@genclass/runtime/auto";
```

It goes first so GenClass is installed before React and your state exist. That is all the setup: GenClass watches
fetch, XHR, WebSocket, EventSource, user input and timers, and finds React state on its own (automatic state
discovery). `npx @genclass/runtime init` writes the same line into an existing app.

## Observe, then guard

| mode | import | what it does |
|---|---|---|
| observe (default) | `@genclass/runtime/auto` | reports what it finds; never holds, drops or changes anything |
| guard | `@genclass/runtime/auto/guard` | also prevents failures with small, reversible actions (drop a stale response, reuse a duplicate's result) when its model is confident |
| heal (experimental) | `@genclass/runtime/auto/heal` | also retries, serves cached data, rolls back |

Start in observe, watch the overlay and the console for a while on real traffic, then switch the import to
`/auto/guard`. Every action is logged with its evidence, and the overlay can undo it.

## Devtools overlay

The last line of `src/main.tsx` loads the overlay in development only:

```ts
if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));
```

It lists detections and actions, explains each decision and lets you switch modes while you develop.

## Turning it off

- For one page load: add `?genclass=off` to the URL (nothing is installed).
- For a browser: `localStorage.genclass = "off"`.
- For good: remove the import (or run `npx @genclass/runtime remove`).

## Privacy

In a browser, GenClass sends anonymous, redacted diagnostics by default
([TELEMETRY.md](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md)).
To turn that off, set the option before the import runs, for example in `index.html`:

```html
<meta name="genclass" content="telemetry=off">
```

## Compatibility

This setup is part of the public compatibility matrix (React 19 + Vite 8 with plain state, TanStack Query, Zustand,
Redux Toolkit and Apollo): see
[compat/RESULTS.md](https://github.com/daybot-solutions-inc/GenClass-lib/blob/main/compat/RESULTS.md).
