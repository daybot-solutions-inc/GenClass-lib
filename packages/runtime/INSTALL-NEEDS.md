# INSTALL → lead / CORE / MODEL / UI

Owner: INSTALL (`src/auto.ts`, `src/cdn/**`, `bin/lib/**`, the `init`/`remove` commands, `test/install/**`).

## Needs a decision (lead)

1. **`npx genclass-runtime init` (README) fails before install.** No unscoped `genclass-runtime` package exists on
   npm (registry 404), so npx cannot resolve it until `@genclass/runtime` is a dependency of the project. Two options:
   - document `npx @genclass/runtime init` (works today: the package has one bin, so npx picks it; tested with
     `npx file:<tarball> init`), or
   - publish a tiny unscoped `genclass-runtime` package whose bin forwards to `@genclass/runtime`'s CLI. This also
     reserves the name. Until then someone else can register it and run code on every `npx genclass-runtime init`.
   The snippet in `test/install/INSTALL-README-SNIPPET.md` uses `npx @genclass/runtime init`, and the CLI's own
   messages say `npx @genclass/runtime remove`.

## package.json changes (additive; please keep)

- `exports`: `./auto`, `./auto/observe`, `./auto/guard`, `./auto/heal`.
- `sideEffects`: was `false`, now `["./dist/auto.js", "./dist/auto/*.js", "./dist/genclass.global.js",
  "./dist/genclass.global.min.js", "./dist/cdn/*.js", "./src/model/worker.ts"]`. With `false`, bundlers drop
  `import "@genclass/runtime/auto"` entirely. `./src/model/worker.ts` is there only for our own build: without it,
  esbuild drops `import "../model/worker.js"` from `src/cdn/worker.ts` (src/ is not published).
- `unpkg` / `jsdelivr`: `./dist/genclass.global.min.js`, so `https://cdn.jsdelivr.net/npm/@genclass/runtime` (no
  path) serves the script-tag build.
- `bin` stays a single entry: with two bins, `npx @genclass/runtime` can no longer pick one.

## tsup.config.ts (new configs, same main build)

- Main ESM build: new entries `auto`, `auto/{observe,guard,heal}`; `clean` keeps `cdn/**` and `genclass.global*`,
  which the parallel configs write.
- `dist/genclass.global.js` and `.global.min.js` (IIFE, es2020). onnxruntime-web is kept out by a plugin (tsup
  ignores `external` for iife; the host's `import("onnxruntime-web/...")` stays a never-called dynamic import).
- `dist/cdn/{worker,ort-webgpu,ort-wasm}.js` (ESM, minified): the model worker with onnxruntime-web bundled in. A
  plugin maps the worker's `import("onnxruntime-web/webgpu" | "/wasm")` to `src/cdn/ort-*.ts`.

## Runtime behaviour INSTALL relies on (CORE / MODEL: please keep, or tell me)

- `GenClass.init({ model })` passes every model option through to `createModelHost` (`makeHost` spreads them). The
  script-tag build passes `workerFactory` (a Blob-URL module worker importing `dist/cdn/worker.js`) and `ortLoader`
  (imports `dist/cdn/ort-*.js`) that way. They are not in the public `ModelOptions` type. Adding them there as
  advanced options would make this explicit.
- The host sends `ortWasmPaths` in the worker's `load` message, and the backend leaves an existing
  `env.wasm.wasmPaths` alone when its wasm prefetch succeeds. On crossOriginIsolated pages, `src/cdn/ort-env.ts` sets
  `wasmPaths.mjs`. ORT refuses its embedded glue for a cross-origin script when it runs threads, so the glue comes
  from the ORT directory. Tested: 4 threads in the Blob worker.

## Nice to have

- MODEL: when CSP blocks workers, `status.workerError` reads `{"isTrusted":true}` (an ErrorEvent stringified). The
  inline fallback works.
- UI: devtools captures `setTimeout`/`requestAnimationFrame` when its module loads. Every lazy mount (the README's
  dev snippet, `/auto` with `devtools`, the script tag's `data-devtools`) loads it after `init`, so it captures the
  instrumented ones.
- Lead: until `@genclass/runtime-model@0.1.0` is published, every install logs `[GenClass] Model unavailable (model
  card download failed: HTTP 404 ...)`. The install tests serve the model from a local copy.
