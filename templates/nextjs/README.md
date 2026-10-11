# GenClass + Next.js starter

A Next.js 16 App Router app with [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) installed the
recommended way: one import in `instrumentation-client.ts`.

```bash
npm install
npm run dev                  # http://localhost:3000, with the GenClass devtools overlay
npm run build && npm start   # production build (no overlay)
```

Type a city quickly in the search box. The API route (`app/api/search/route.ts`) answers in a random 50-900 ms, so
an older answer can overwrite a newer one: the classic stale typeahead. Open the overlay (bottom right) to see what
GenClass noticed; the browser console has one plain-English line per finding.

## The one line

`instrumentation-client.ts` (Next.js 15.3 and later runs it in the browser before your app's code):

```ts
import genclass from "@genclass/runtime/auto";
```

That is all the setup. GenClass runs in the browser only: on the server (SSR, route handlers) the import is inert,
so server rendering, hydration and your server's `fetch` are untouched. It watches fetch, XHR, WebSocket,
EventSource, user input and timers, and finds the state of your client components on its own (automatic state
discovery). `npx @genclass/runtime init` writes the same file into an existing app (for Next.js before 15.3 it uses a
small client component in the root layout instead).

## Observe, then guard

| mode | import | what it does |
|---|---|---|
| observe (default) | `@genclass/runtime/auto` | reports what it finds; never holds, drops or changes anything |
| guard | `@genclass/runtime/auto/guard` | also prevents failures with small, reversible actions (drop a stale response, reuse a duplicate's result) when its model is confident |
| heal (experimental) | `@genclass/runtime/auto/heal` | also retries, serves cached data, rolls back |

Start in observe, watch the overlay and the console for a while on real traffic, then switch the import to
`/auto/guard`. Every action is logged with its evidence, and the overlay can undo it.

## Devtools overlay

`instrumentation-client.ts` also loads the overlay when `NODE_ENV` is `development`:

```ts
if (process.env.NODE_ENV === "development") {
  import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));
}
```

## Turning it off

- For one page load: add `?genclass=off` to the URL (nothing is installed).
- For a browser: `localStorage.genclass = "off"`.
- For good: delete `instrumentation-client.ts` (or run `npx @genclass/runtime remove`).

## Privacy

In a browser, GenClass sends anonymous, redacted diagnostics by default
([TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md)).
To turn that off, add a meta tag through the root layout's metadata:

```ts
export const metadata: Metadata = { title: "…", other: { genclass: "telemetry=off" } };
```

or run `npx @genclass/runtime init --no-telemetry`.

## Content-Security-Policy

If you set a CSP (for example in `next.config.ts` headers), allow `https://cdn.jsdelivr.net` in `connect-src` (the
model is downloaded from there once and cached) and `'wasm-unsafe-eval'` in `script-src`, or self-host the model
([README](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#content-security-policy-and-self-hosting)).

## Compatibility

This setup is part of the public compatibility matrix (Next.js 16 App Router with client components and SWR, SSR
checked): see [compat/RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md).
