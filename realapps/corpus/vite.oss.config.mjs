// Vite build for open-source apps that need their framework's compiler (Vue SFC, Solid JSX). One bundle (no code
// splitting: lazy chunks would load on real time), the runtime from source, production mode.
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.RW_SRC;
const OUT = process.env.RW_OUT;
const RT = process.env.RW_RT;
const SHARED = process.env.RW_SHARED;
const KIND = process.env.RW_KIND;

/** Import a package installed in the app's own node_modules (this config file lives elsewhere). */
async function load(pkg) {
  const dir = resolve(SRC, "node_modules", pkg);
  const pj = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  const pick = (e) => (typeof e === "string" ? e : e && (e.import?.default ?? e.import ?? e.default ?? e.node));
  const rel = pick(pj.exports?.["."] ?? pj.exports) ?? pj.module ?? pj.main ?? "index.js";
  return (await import(pathToFileURL(resolve(dir, typeof rel === "string" ? rel : rel.default)).href)).default;
}
const plugins = [];
if (KIND === "vite-vue") plugins.push((await load("@vitejs/plugin-vue"))());
if (KIND === "vite-solid") plugins.push((await load("vite-plugin-solid"))({ extensions: [".js"], exclude: /node_modules/ }));

export default {
  root: SRC,
  base: "/",
  logLevel: "warn",
  plugins,
  define: { "import.meta.env.VITE_API_HOST": JSON.stringify("") },
  resolve: {
    alias: [
      { find: /^src\//, replacement: resolve(SRC, "src") + "/" },
      { find: "@genclass/runtime/redux", replacement: resolve(RT, "adapters/redux.ts") },
      { find: /^@genclass\/runtime$/, replacement: resolve(RT, "index.ts") },
      { find: "@realapps/genclass", replacement: SHARED },
      { find: /^onnxruntime-web(\/.*)?$/, replacement: resolve(SHARED, "../onnx-stub.ts") },
    ],
  },
  worker: { format: "es", rollupOptions: { output: { inlineDynamicImports: true } } },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    minify: false,
    target: "es2022",
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true, entryFileNames: "bundle.js", assetFileNames: "assets/[name][extname]" } },
  },
};
