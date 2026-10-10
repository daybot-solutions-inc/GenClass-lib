# Starter templates

Copy-paste starters with [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) already installed
the recommended way (the one line, the dev-only devtools overlay). Each is a fresh app from the framework's own
generator, trimmed to one page with a search box and a mock API that answers out of order, so you can see GenClass
work within a minute.

| template | the one line goes in | run |
|---|---|---|
| [react-vite](react-vite/) | `src/main.tsx` | `npm install && npm run dev` |
| [nextjs](nextjs/) (App Router) | `instrumentation-client.ts` | `npm install && npm run dev` |
| [vue-vite](vue-vite/) | `src/main.ts` | `npm install && npm run dev` |
| [sveltekit](sveltekit/) | `src/hooks.client.ts` | `npm install && npm run dev` |

Copy one without the rest of the repository:

```bash
npx degit daybot-solutions-inc/GenClass-lib/templates/react-vite my-app
cd my-app && npm install && npm run dev
```

Every template:

- **starts in observe mode**: GenClass reports what it finds (devtools overlay, one console line per finding) and
  changes nothing. Switch the import to `@genclass/runtime/auto/guard` to let it act when its model is confident;
- **loads the devtools overlay in development only**;
- **can be turned off per page load** with `?genclass=off` in the URL;
- sends anonymous, redacted diagnostics by default; each README shows the one-line opt-out.

They need `@genclass/runtime` 0.1.0-beta.4 or later (automatic state discovery). Each one builds, boots and passes
the checks in `compat/templates-check.mjs` (production build and dev server, Chromium) against the runtime packed
from this repository; the frameworks behind them are covered by the
[compatibility matrix](../compat/RESULTS.md).
