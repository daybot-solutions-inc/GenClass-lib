import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export const PAGES = ["search", "editor", "checkout", "status", "board", "decisions"] as const;

// The demos import the real @genclass/runtime (workspace package, built to packages/runtime/dist). While that
// package is still being written, GENCLASS_SHIM=1 (or a missing dist) swaps in a tiny observe-only stand-in so the
// apps, the mock server and the trial harness can be developed. Results record which one was used.
const runtimeBuilt = existsSync(here("../packages/runtime/dist/index.js"));
const useShim = process.env.GENCLASS_SHIM === "1" || (!runtimeBuilt && process.env.GENCLASS_SHIM !== "0");
const BUILD_ID = process.env.BUILD_ID || Date.now().toString(36);

const shimAlias = useShim
  ? [
      { find: /^@genclass\/runtime$/, replacement: here("./src/dev/runtime-shim/index.ts") },
      { find: /^@genclass\/runtime\/react$/, replacement: here("./src/dev/runtime-shim/react.ts") },
      { find: /^@genclass\/runtime\/redux$/, replacement: here("./src/dev/runtime-shim/redux.ts") },
      { find: /^@genclass\/runtime\/zustand$/, replacement: here("./src/dev/runtime-shim/zustand.ts") },
      { find: /^@genclass\/runtime\/devtools$/, replacement: here("./src/dev/runtime-shim/devtools.ts") },
    ]
  : [
      // Always build against THIS checkout's runtime (node_modules may be a symlink into another worktree, whose
      // @genclass/runtime link points at that worktree's packages/runtime).
      { find: /^@genclass\/runtime$/, replacement: here("../packages/runtime/dist/index.js") },
      { find: /^@genclass\/runtime\/react$/, replacement: here("../packages/runtime/dist/adapters/react.js") },
      { find: /^@genclass\/runtime\/redux$/, replacement: here("../packages/runtime/dist/adapters/redux.js") },
      { find: /^@genclass\/runtime\/zustand$/, replacement: here("../packages/runtime/dist/adapters/zustand.js") },
      { find: /^@genclass\/runtime\/devtools$/, replacement: here("../packages/runtime/dist/devtools/index.js") },
    ];

// bench/heal (GENCLASS_DISCOVER=1): the same apps with NO store registered by hand, as a plain app with the one line
// would be. useGenClassState is plain React useState, genclassEnhancer is the Redux DevTools enhancer
// (window.__REDUX_DEVTOOLS_EXTENSION__), the zustand middleware is zustand's devtools(); each demo's main.ts gets
// `import "@genclass/runtime/discover"` first and GenClass.init gets autoState: true. The app code is untouched.
const discover = !useShim && process.env.GENCLASS_DISCOVER === "1";
const discoverAlias = discover
  ? [
      { find: /^@genclass\/runtime$/, replacement: here("../bench/heal/discover/runtime.ts") },
      { find: /^@genclass\/runtime\/react$/, replacement: here("../bench/heal/discover/react.ts") },
      { find: /^@genclass\/runtime\/redux$/, replacement: here("../bench/heal/discover/redux.ts") },
      { find: /^@genclass\/runtime\/zustand$/, replacement: here("../bench/heal/discover/zustand.ts") },
      { find: /^@genclass\/runtime\/discover$/, replacement: here("../packages/runtime/dist/discover.js") },
      { find: /^@genclass-real\/runtime$/, replacement: here("../packages/runtime/dist/index.js") },
      { find: /^@genclass-real\/runtime\/react$/, replacement: here("../packages/runtime/dist/adapters/react.js") },
    ]
  : [];

/** GENCLASS_DISCOVER=1: `import "@genclass/runtime/discover"` first in every demo's main.ts. */
function discoverFirst(): Plugin {
  return {
    name: "genclass-bench-discover-first",
    enforce: "pre",
    transform(code, id) {
      if (!discover || !/[\\/]src[\\/]demos[\\/][^\\/]+[\\/]main\.ts$/.test(id)) return null;
      return { code: `import "@genclass/runtime/discover";\n${code}`, map: null };
    },
  };
}

/** Dev only: serve the mock server at /sw.js as a module service worker (production builds a classic IIFE). */
function devServiceWorker(): Plugin {
  return {
    name: "genclass-demo-dev-sw",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.split("?")[0].endsWith("/sw.js")) return next();
        try {
          const out = await server.transformRequest("/src/server/sw.ts");
          res.setHeader("Content-Type", "text/javascript");
          res.setHeader("Service-Worker-Allowed", "/");
          res.setHeader("Cache-Control", "no-store");
          res.end(out?.code ?? "");
        } catch (e) {
          next(e);
        }
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [discoverFirst(), react(), devServiceWorker()],
  resolve: { alias: [...discoverAlias, ...shimAlias] },
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    __RUNTIME_KIND__: JSON.stringify(useShim ? "shim" : "real"),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      input: {
        index: here("./index.html"),
        ...Object.fromEntries(PAGES.filter((p) => existsSync(here(`./${p}/index.html`))).map((p) => [p, here(`./${p}/index.html`)])),
      },
    },
  },
  worker: { format: "es" },
  server: { port: 5173, host: true },
});
