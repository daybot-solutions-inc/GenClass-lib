import { readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { defineConfig, type Options } from "tsup";

// tsup runs in the package directory (the entries below are relative to it too).
const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };

// dist/cdn/ort-*.js bundle onnxruntime-web, and the runtime fetches the wasm for the version it bundled (from
// jsDelivr, or a self-hosted ortWasmPaths that `fetch-model` fills for package.json's version): the installed copy
// must be exactly the pinned one.
{
  const want = pkg.dependencies["onnxruntime-web"];
  const req = createRequire(resolve("package.json"));
  const main = req.resolve("onnxruntime-web"); // its exports hide ./package.json
  const dir = main.slice(0, main.lastIndexOf(`${sep}onnxruntime-web${sep}`) + `${sep}onnxruntime-web`.length);
  const have = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
  if (have !== want) throw new Error(`onnxruntime-web ${have} is installed, package.json pins ${want}: run npm install`);
}

// The script-tag builds write into dist/ next to the main build, whose clean leaves them alone (the configs run in
// parallel): remove their old outputs here, before any build starts.
try {
  for (const f of readdirSync("dist")) if (f.startsWith("genclass.global")) rmSync(join("dist", f), { force: true });
} catch {
  /* no dist yet */
}

// The CDN pieces bundle onnxruntime-web. The model worker's `import("onnxruntime-web/webgpu" | "/wasm")` is mapped
// to src/cdn/ort-*.ts (which import the real package and prepare it for a cross-origin script).
const cdnOrt = {
  name: "genclass-cdn-ort",
  setup(build: { onResolve(o: { filter: RegExp }, cb: (a: { path: string; importer: string }) => { path: string } | undefined): void }) {
    build.onResolve({ filter: /^onnxruntime-web\/(webgpu|wasm)$/ }, (args) =>
      args.importer.includes(`${sep}src${sep}cdn${sep}`) ? undefined : { path: resolve(`src/cdn/ort-${args.path.endsWith("/wasm") ? "wasm" : "webgpu"}.ts`) },
    );
  },
};

// Consumers' bundlers (webpack, Turbopack, Rollup/Vite, Parcel) emit every `new URL("<file>", import.meta.url)` they
// find as a static asset. onnxruntime-web's bundles hold four: its two .wasm builds (14 and 27 MB) and its own .mjs
// (for a proxy worker). The runtime never lets ORT fetch those (it hands ORT the wasm bytes itself, from
// `ortWasmPaths` or jsDelivr: src/model/backend.ts -> prefetchWasm), so they were 41 MB of dead weight in every app
// build (and the 27 MB file is over the 25 MiB per-file limit of some static hosts). Reading import.meta.url through a
// variable hides the pattern from every bundler; the value at runtime is the same. Not a plain alias
// (`const u = import.meta.url`): Turbopack propagates that constant and still resolves `new URL("<file>", u)`
// (found with Next 16.3 in a pilot app); an array element read is opaque to it, webpack and Rollup/Vite.
export const ORT_URL_VAR = "__genclassOrtUrl";
const ortNoAssets = {
  name: "genclass-ort-no-assets",
  setup(build: { onLoad(o: { filter: RegExp }, cb: (a: { path: string }) => Promise<{ contents: string; loader: "js" }>): void }) {
    build.onLoad({ filter: /[\\/]onnxruntime-web[\\/]dist[\\/][^\\/]+\.m?js$/ }, async (args) => {
      const src = await readFile(args.path, "utf8");
      return { contents: `const ${ORT_URL_VAR} = [import.meta.url][0];\n${src.split("import.meta.url").join(ORT_URL_VAR)}`, loader: "js" };
    });
  },
};

// The ESM build's model worker and inline fallback load onnxruntime-web through the prepared copies in dist/cdn/
// (ort-webgpu.js, ort-wasm.js: the bundles above, built once by the CDN config below), never from the app's
// node_modules: so an app's bundler only ever sees those, as two lazy chunks, and no wasm. Every chunk that imports
// them sits in dist/ (tsup puts split chunks at the root of outDir).
const ortFromCdnDir = {
  name: "genclass-ort-from-cdn-dir",
  setup(build: { onResolve(o: { filter: RegExp }, cb: (a: { path: string }) => { path: string; external: boolean }): void }) {
    build.onResolve({ filter: /^onnxruntime-web\/(webgpu|wasm)$/ }, (args) => ({ path: `./cdn/ort-${args.path.endsWith("/wasm") ? "wasm" : "webgpu"}.js`, external: true }));
  },
};

// The script-tag build never contains onnxruntime-web: the host's inline-fallback `import("onnxruntime-web/...")` is
// left as is (never called there: the global build passes its own ortLoader). tsup ignores `external` for iife.
const ortExternal = {
  name: "genclass-ort-external",
  setup(build: { onResolve(o: { filter: RegExp }, cb: (a: { path: string }) => { path: string; external: boolean }): void }) {
    build.onResolve({ filter: /^onnxruntime-web(\/.*)?$/ }, (args) => ({ path: args.path, external: true }));
  },
};

// Script-tag build (INSTALL): window.GenClass, auto-init from data attributes. onnxruntime-web stays out of it; the
// worker and the inline fallback load dist/cdn/* on demand.
const globalBuild = (minify: boolean): Options => ({
  entry: { genclass: "src/cdn/global.ts" },
  format: ["iife"],
  outExtension: () => ({ js: minify ? ".global.min.js" : ".global.js" }),
  target: "es2020",
  platform: "browser",
  minify,
  // the unminified file is its own source; the .min.js gets a map
  sourcemap: minify,
  clean: false,
  dts: false,
  treeshake: true,
  define: { __GENCLASS_VERSION__: JSON.stringify(pkg.version) },
  esbuildPlugins: [ortExternal as never],
});

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      auto: "src/auto.ts",
      "auto/observe": "src/cdn/auto-observe.ts",
      "auto/guard": "src/cdn/auto-guard.ts",
      "auto/heal": "src/cdn/auto-heal.ts",
      "adapters/react": "src/adapters/react.ts",
      "adapters/redux": "src/adapters/redux.ts",
      "adapters/zustand": "src/adapters/zustand.ts",
      "devtools/index": "src/devtools/index.ts",
      discover: "src/discover/entry.ts",
      worker: "src/model/worker.ts",
    },
    format: ["esm"],
    dts: { entry: { index: "src/index.ts", auto: "src/auto.ts", "auto/observe": "src/cdn/auto-observe.ts", "auto/guard": "src/cdn/auto-guard.ts", "auto/heal": "src/cdn/auto-heal.ts", "adapters/react": "src/adapters/react.ts", "adapters/redux": "src/adapters/redux.ts", "adapters/zustand": "src/adapters/zustand.ts", "devtools/index": "src/devtools/index.ts", discover: "src/discover/entry.ts" } },
    target: "es2022",
    platform: "browser",
    splitting: true,
    sourcemap: true,
    // the CDN builds below write into dist/ too, in parallel
    clean: ["!cdn/**", "!genclass.global*"],
    treeshake: true,
    external: ["react", "redux", "zustand"],
    // onnxruntime-web is a dependency, which tsup would leave external as is: ortFromCdnDir rewrites it instead
    noExternal: [/^onnxruntime-web/],
    esbuildPlugins: [ortFromCdnDir as never],
  },
  globalBuild(false),
  globalBuild(true),
  {
    // CDN module worker + onnxruntime-web (INSTALL): dist/cdn/{worker,ort-webgpu,ort-wasm}.js and shared chunks.
    entry: { worker: "src/cdn/worker.ts", "ort-webgpu": "src/cdn/ort-webgpu.ts", "ort-wasm": "src/cdn/ort-wasm.ts" },
    outDir: "dist/cdn",
    format: ["esm"],
    target: "es2022",
    platform: "browser",
    splitting: true,
    minify: true,
    sourcemap: false,
    clean: true,
    dts: false,
    treeshake: true,
    noExternal: [/^onnxruntime-web/],
    esbuildPlugins: [cdnOrt as never, ortNoAssets as never],
  },
]);
