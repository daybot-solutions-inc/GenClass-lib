# Install test results

Run 2026-10-08 on the train VM (Node 22.22, Chromium 1243 headless, no GPU), `bash test/install/run-all.sh`,
against the locally packed `@genclass/runtime-0.1.0-alpha.0.tgz` (this tree), never the registry.

Per project: fresh scaffold from the framework's own generator → `npx file:<tgz> init --yes --from <tgz>` → `init`
again (must print "Nothing to do" and change no file) → production build → production server in Chromium → dev
server in Chromium → `npx file:<tgz> remove --yes` → every file compared with the scaffold (sha256, excluding
node_modules, lockfiles and build output).

In Chromium, the jsDelivr defaults are served from local copies, because `@genclass/runtime-model` is not published
yet: the model card and files, and onnxruntime-web's wasm. "Model ready" is the runtime's own
`[GenClass] Model ready (...)` console line, so it shows the framework bundled the model worker and the model loaded
in it.

| project (generator versions) | init changes | build | prod: model ready in a worker / fetch instrumented / no overlay / 0 console errors | dev: overlay + model ready, 0 errors | remove: files byte-identical (package.json too) |
|---|---|---|---|---|---|
| Vite 8 + React 19 TS (npm) | `src/main.tsx` | ok | yes / yes / yes / yes | yes | yes (yes) |
| Vite 8 + React 19 TS (pnpm 10) | `src/main.tsx` | ok | yes / yes / yes / yes | yes | yes (yes) |
| Vite 8 + Vue 3.5 JS | `src/main.js` | ok | yes / yes / yes / yes | yes | yes (yes) |
| Vite 8 + Svelte 5 TS | `src/main.ts` | ok | yes / yes / yes / yes | yes | yes (yes) |
| Next.js 16.4 App Router (Turbopack) | new `instrumentation-client.ts` | ok | yes / yes / yes / yes | yes | yes (yes) |
| Next.js 16.4 App Router, `--strategy layout` (the path for Next < 15.3) | new `app/genclass-init.tsx`, `app/layout.tsx` | ok | yes / yes / yes / yes | yes | yes (yes) |
| Next.js 16.4 Pages Router JS | new `instrumentation-client.js` | ok | yes / yes / yes / yes | yes | yes (yes) |
| Next.js 16.4 Pages Router, `--strategy pages` (Next < 15.3 path) | `pages/_app.js` | ok | yes / yes / yes / yes | not run | yes (yes) |
| Create React App 5.0.1 (React 19) | `src/index.js` | ok | yes / yes / yes / yes | yes | yes (yes) |
| SvelteKit 3 | new `src/hooks.client.ts` | ok | yes / yes / yes / yes | yes | yes (yes) |
| Astro 7 (minimal) | `src/pages/index.astro` | ok | yes / yes / yes / yes | yes | yes (yes, after the final-newline fix) |
| Nuxt 4.6 | new `app/plugins/genclass.client.ts` | ok | yes / yes / yes / yes | yes | yes (yes) |
| React Router 8 (framework mode) | `app/root.tsx` | ok | yes / yes / yes / yes | yes (see note) | yes (yes) |
| Angular 20.3 (application builder) | `src/main.ts` | ok | yes / yes / yes / yes | yes | yes (yes) |
| Plain HTML (2 pages, no package.json) | `index.html`, `about.html` | n/a | yes / yes / overlay shown (`data-devtools="local"` on 127.0.0.1) / yes | n/a | yes |

**15/15 pass.** CLI unit tests (`test/install/cli.test.ts`): 20/20. Browser checks for the script tag and `/auto`
(`test/install/cdn-check.mjs`): 26/26.

Notes:
- React Router, first dev start only: its Vite plugin does not pre-scan app files, so newly added dependencies
  (`@genclass/runtime/auto`, `/devtools`) are found on the first page load. Vite re-optimizes and reloads the page,
  and that first load logs five "504 (Outdated Optimize Dep)" / "Failed to fetch dynamically imported module"
  errors. Later loads and later dev starts are clean. A fresh React Router app also reloads once on its first dev
  load, without errors. The harness judges dev servers on a warm load and keeps cold-load errors in the results:
  React Router 5, every other framework 0.
- Angular: the latest CLI needs Node ≥ 22.22.3 (the VM has 22.22.0), so the scaffold uses `@angular/cli@20`.
- Astro: npm adds a final newline to a `package.json` that had none. init/remove now keep the original's
  final-newline state around package-manager calls, so the file comes back byte-identical.

Script tag and `/auto` (`cdn-check.mjs`): page on `http://localhost:A`, "CDN" on `http://127.0.0.1:B` with
jsDelivr's CORS headers. The model is ready in a Blob-URL module worker that imports `dist/cdn/worker.js`
cross-origin, and `decide()` answers through it. Also checked:
- crossOriginIsolated page: 4 WASM threads; ORT glue preloaded from the ORT directory.
- Default URLs.
- `?genclass=off`: nothing installed, native fetch.
- `data-manual` + `GenClass.init()`.
- CSP `worker-src 'none'`: inline fallback loads ORT from the CDN.
- `<meta name="genclass">` + `GENCLASS_CONFIG`.
- The tag twice: one runtime.
- Unversioned `https://cdn.jsdelivr.net/npm/@genclass/runtime`: worker pinned to this version.
- `/auto` bundled by esbuild: meta mode and devtools.
- SSR: importing `/auto` in Node leaves `fetch` alone and returns an inert runtime.

Sizes (this build):

| file | raw | gzip |
|---|---|---|
| `dist/genclass.global.min.js` (runtime + script-tag glue, no ORT) | 253 KB | 86 KB |
| `dist/genclass.global.js` (unminified) | 449 KB | 115 KB |
| `dist/cdn/worker.js` (loaded on demand) | 40 KB | 16 KB |
| `dist/cdn/ort-wasm.js` / `ort-webgpu.js` (one of them, on demand) | 73 / 118 KB | 25 / 39 KB |
| `dist/devtools/index.js` (only with `data-devtools`) | 69 KB | 20 KB |
| ORT wasm from jsDelivr onnxruntime-web (unchanged) | 14.2 / 26.8 MB | 3.1 / 5.5 MB br |
| npm tarball | 1.09 MB packed | (alpha.0: 1.6 MB unpacked, 26 files) |
