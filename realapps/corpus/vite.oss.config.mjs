// Vite build for open-source apps that need their framework's compiler (Vue 3 and Vue 2 SFC, Solid JSX, Svelte 3;
// ReScript apps are compiled to ES modules first). One bundle (no code splitting: lazy chunks would load on real
// time), the runtime from source, production mode.
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SRC = process.env.RW_SRC;
const OUT = process.env.RW_OUT;
const RT = process.env.RW_RT;
const SHARED = process.env.RW_SHARED;
const KIND = process.env.RW_KIND;

/** Import a package installed in the app's own node_modules (this config file lives elsewhere). */
async function load(pkg, named) {
  const dir = resolve(SRC, "node_modules", pkg);
  const pj = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  const pick = (e) => (typeof e === "string" ? e : e && (e.import?.default ?? e.import ?? e.default ?? e.node));
  const rel = pick(pj.exports?.["."] ?? pj.exports) ?? pj.module ?? pj.main ?? "index.js";
  const mod = await import(pathToFileURL(resolve(dir, typeof rel === "string" ? rel : rel.default)).href);
  return named ? mod[named] : mod.default;
}
const plugins = [];
if (KIND === "vite-vue") plugins.push((await load("@vitejs/plugin-vue"))());
if (KIND === "vite-solid") plugins.push((await load("vite-plugin-solid"))({ extensions: [".js"], exclude: /node_modules/ }));
if (KIND === "vite-vue2") plugins.push((await load("@vitejs/plugin-vue2"))());
// Vite 4 (the newest @sveltejs/vite-plugin-svelte that compiles Svelte 3 needs it) does not map the runtime's
// `new Worker(new URL("./worker.js", import.meta.url))` onto worker.ts, as later Vite versions do; resolve it here.
const tsForJs = {
  name: "rw-ts-for-js",
  enforce: "pre",
  resolveId(id, importer) {
    if (!id.endsWith(".js") || !(id.startsWith(".") || id.startsWith("/"))) return null;
    const abs = resolve(importer ? dirname(importer) : SRC, id);
    const ts = abs.slice(0, -3) + ".ts";
    return !existsSync(abs) && existsSync(ts) ? ts : null;
  },
};
if (KIND === "vite-svelte3") {
  plugins.push(tsForJs);
  plugins.push((await load("@sveltejs/vite-plugin-svelte", "svelte"))());
  // the app's rollup build substitutes its API origin (@rollup/plugin-replace, production value); same here
  plugins.push({ name: "rw-replace-api-origin", transform: (code) => (code.includes("BASE__SERVER__URL") ? code.replaceAll("BASE__SERVER__URL", "http://realworld.huseung.me:8070") : null) });
}
// Stylesheets from an uninitialised git submodule (the RealWorld theme): styles never gate behaviour here.
plugins.push({
  name: "rw-missing-css",
  enforce: "pre",
  resolveId(id, importer) {
    if (id.endsWith(".css") && importer && id.startsWith(".") && !existsSync(resolve(dirname(importer), id))) return "\0rw-empty.css";
    return null;
  },
  load(id) {
    return id === "\0rw-empty.css" ? "" : null;
  },
});

export default {
  root: SRC,
  base: "/",
  logLevel: "warn",
  plugins,
  // the Svelte app's public/ holds its rollup-era index.html; the Vite entry page is written by patch_oss.py
  ...(KIND === "vite-svelte3" ? { publicDir: false } : {}),
  define: { "import.meta.env.VITE_API_HOST": JSON.stringify("") },
  resolve: {
    // the Vue 2 app imports SFCs without the .vue extension (Vue CLI legacy; its own vite.config does the same)
    ...(KIND === "vite-vue2" ? { extensions: [".mjs", ".js", ".ts", ".jsx", ".tsx", ".json", ".vue"] } : {}),
    alias: [
      { find: /^src\//, replacement: resolve(SRC, "src") + "/" },
      ...(KIND === "vite-vue2" ? [{ find: /^@\//, replacement: resolve(SRC, "src") + "/" }] : []),
      { find: "@genclass/runtime/redux", replacement: resolve(RT, "adapters/redux.ts") },
      { find: /^@genclass\/runtime$/, replacement: resolve(RT, "index.ts") },
      { find: "@realapps/genclass", replacement: SHARED },
      { find: /^onnxruntime-web(\/.*)?$/, replacement: resolve(SHARED, "../onnx-stub.ts") },
    ],
  },
  worker: { format: "es", ...(KIND === "vite-svelte3" ? { plugins: [tsForJs] } : {}), rollupOptions: { output: { inlineDynamicImports: true } } },
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
