// Builds the demo site: the multi-page app (vite.config.ts) and the Service Worker mock server as one classic
// script at dist/sw.js. Both get the same BUILD_ID so a page can tell when an old worker is still in control.
import { build } from "vite";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const BUILD_ID = process.env.BUILD_ID || Date.now().toString(36);
process.env.BUILD_ID = BUILD_ID;

await build({ root, configFile: `${root}vite.config.ts`, logLevel: "warn" });

await build({
  root,
  configFile: false,
  logLevel: "warn",
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    minify: true,
    sourcemap: false,
    target: "es2022",
    lib: {
      entry: `${root}src/server/sw.ts`,
      formats: ["iife"],
      name: "GenClassDemoServer",
      fileName: () => "sw.js",
    },
  },
});

// Ship the latest measured results with the site so the landing page can show them.
mkdirSync(`${root}dist`, { recursive: true });
if (existsSync(`${root}results-summary.json`)) copyFileSync(`${root}results-summary.json`, `${root}dist/results-summary.json`);
writeFileSync(`${root}dist/build.json`, JSON.stringify({ buildId: BUILD_ID, at: new Date().toISOString() }));
// GitHub Pages: do not run Jekyll over the output.
writeFileSync(`${root}dist/.nojekyll`, "");
console.log(`demos built: dist/ (build ${BUILD_ID})`);
