# Install (draft for the README; the lead merges it)

Pick one. All three start the same runtime.

**1. One command** (Vite, Next.js, Create React App, Remix / React Router, Nuxt, SvelteKit, Astro, Angular, plain HTML)

```bash
npx @genclass/runtime init
```

It finds your framework and package manager, installs `@genclass/runtime`, and adds one import as the first line of
your entry file, plus a line that loads the devtools overlay in development only. It shows the diff and asks before
writing anything. Running it again changes nothing; running it with another `--mode` switches the import it added to
that mode. It sets up observe mode (reports only, never changes anything) unless you pass `--mode guard` or `--mode heal`.

```bash
npx @genclass/runtime init --yes            # no questions
npx @genclass/runtime init --mode guard     # let GenClass act (also: --mode heal); again later to switch
npx @genclass/runtime init --dry-run        # show the diff, write nothing
npx @genclass/runtime remove                # undo exactly what init added (refuses if you edited those lines)
```

Other flags: `--no-install` (don't run the package manager), `--no-devtools`, `--cwd <dir>`, `--cdn <url>` and
`--no-sri` (plain HTML), `remove --keep-package`.

`init` only edits browser apps: a project whose only build tool is esbuild, rollup, parcel or webpack needs an
`index.html`, a UI framework such as `react-dom` or `vue`, or an HTML plugin / dev server, else `init` stops and says
why (Node servers and libraries are left alone). It also stops for a package that looks like a library (a UI
framework as a peer dependency, or an `exports`, `module`, `types` or `bin` field) and for an entry file that imports
Node-only modules (`express`, `node:*`, `react-dom/server`, ...). `remove` takes out a line a formatter rewrapped as a whole; if a
line or block `init` marked was edited, it changes nothing and lists where. It keeps the package installed while
anything still imports it, including in dot-folders such as `.storybook`, `tmp`, `out` or `build`.

What it adds, by framework:

| framework | where |
|---|---|
| Vite (React, Vue, Svelte, Solid, Preact, vanilla), Create React App, Angular | top of the entry file (`src/main.tsx`, `src/index.js`, `src/main.ts`) |
| Next.js 15.3+ (App and Pages Router) | a new `instrumentation-client.ts`, which Next runs before your app's code |
| Next.js before 15.3 | App Router: a `'use client'` `<GenClassInit />` component in the root layout. Pages Router: `pages/_app` |
| Remix, React Router (framework mode) | `app/entry.client.tsx`, else `app/root.tsx` (inert on the server) |
| SvelteKit | `src/hooks.client.ts` |
| Nuxt 3 and 4 | a new `plugins/genclass.client.ts` |
| Astro | a `<script>` line in each layout's `<head>` |
| Plain HTML | a `<script>` tag first in each page's `<head>` (jsDelivr, pinned version, with SRI; a `--cdn` URL gets no SRI hash) |

In a Vite app the result is:

```ts
import genclass from "@genclass/runtime/auto"; // genclass:init
import { StrictMode } from "react";
// ... your code ...
if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass)); // genclass:init
```

If it uses Redux, Zustand or React state, init prints the one-line adapter change that lets GenClass hold, drop or
roll back writes to that state. It never rewrites your store code.

**2. One import** (any bundler)

```ts
import "@genclass/runtime/auto"; // first line of your entry file
```

`/auto` starts GenClass while your entry's imports load, so stores created at import time already see
`GenClass.runtime`. It is a no-op on the server (SSR). `import rt from "@genclass/runtime/auto"` also gives you the
runtime. It observes (the default); to let GenClass act, import `@genclass/runtime/auto/guard` (or `/auto/heal`). The
subpaths have types under every TypeScript `moduleResolution`, `"node"` included. Configure it from the page if you
like:

```html
<meta name="genclass" content="mode=observe, devtools=local">
<script>window.GENCLASS_CONFIG = { policy: { deny: ["delay"] } };</script>
```

**3. One script tag** (no build step)

```html
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime/dist/genclass.global.min.js" data-mode="observe" data-devtools="local"></script>
```

Put it first in `<head>` so it sees the page's first requests. It sets `window.GenClass` (`GenClass.runtime`,
`GenClass.init(options)`, `GenClass.devtools()`). The model worker, onnxruntime-web and the devtools overlay load on
demand from the same CDN, at the same version as the tag, also when the URL has no version.

| attribute | |
|---|---|
| `data-mode` | `observe` (default), `guard` or `heal` |
| `data-devtools` | show the overlay; `="local"`: only on localhost, `*.localhost`, `*.local`, `*.test` |
| `data-model` | your model directory (`npx @genclass/runtime fetch-model public/genclass-model`), or `off` |
| `data-ort` | onnxruntime-web's `dist/` directory, if you self-host its wasm |
| `data-manual` | only define `window.GenClass`; call `GenClass.init({...})` yourself |
| `data-base` | where the package's `dist/` is, if you self-host this file |

The same keys work in `<meta name="genclass" content="...">`, and `window.GENCLASS_CONFIG` takes any `init`
option. In every form, `?genclass=off` in the URL turns GenClass off.

Every `<meta name="genclass">` in the document is read; on a page that renders untrusted HTML, set the options in
`window.GENCLASS_CONFIG` (it wins) or call `GenClass.init(options)` instead. The tag's SRI hash covers that file only:
the worker, ONNX Runtime and overlay it loads later come from the same CDN version without one, so pin a version (as
`init` does) or self-host with `data-base`, `data-ort` and `data-model`.
