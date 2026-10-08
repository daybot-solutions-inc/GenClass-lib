import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { defineConfig, type Options } from "tsup";

// tsup runs in the package directory (the entries below are relative to it too).
const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string };

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
      worker: "src/model/worker.ts",
    },
    format: ["esm"],
    dts: { entry: { index: "src/index.ts", auto: "src/auto.ts", "auto/observe": "src/cdn/auto-observe.ts", "auto/guard": "src/cdn/auto-guard.ts", "auto/heal": "src/cdn/auto-heal.ts", "adapters/react": "src/adapters/react.ts", "adapters/redux": "src/adapters/redux.ts", "adapters/zustand": "src/adapters/zustand.ts", "devtools/index": "src/devtools/index.ts" } },
    target: "es2022",
    platform: "browser",
    splitting: true,
    sourcemap: true,
    // the CDN builds below write into dist/ too, in parallel
    clean: ["!cdn/**", "!genclass.global*"],
    treeshake: true,
    external: ["onnxruntime-web", "onnxruntime-web/webgpu", "react", "redux", "zustand"],
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
    esbuildPlugins: [cdnOrt as never],
  },
]);
