// Re-bundle an open-source app that its own toolchain built (Angular CLI, elm make, ...) into the corpus layout:
// dist/apps/<name>/index.html + one bundle.js. esbuild follows the builder's output from its entry module, resolves
// the GenClass integration import the app kept external (@realapps/genclass -> apps/_shared/genclass.ts, the runtime
// from source) and inlines every dynamic import() of a lazy chunk (no splitting: lazy chunks would load on real
// time). The page is the app's own index.html with its <script>/<link> tags replaced by the one module script.
//   node corpus/rebundle.mjs <built dir> <entry js (relative to built dir)> <out dir> [index.html (default: built dir)]
//   node corpus/rebundle.mjs --scripts <built dir> <out dir>      classic page scripts (see concatScripts)
import * as esbuild from "esbuild";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RA = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// the runtime source, as in build.mjs: RW_RUNTIME_SRC (a frozen tag export) or the working tree
const RT = process.env.RW_RUNTIME_SRC ?? resolve(RA, "../packages/runtime/src");

/** Bundle `entry` into `<out>/bundle.js` and write `<out>/index.html` from the app's page `html`. */
export async function rebundle({ entry, out, html, plugins = [], nodePaths = [] }) {
  const stub = join(RA, "apps/_shared/onnx-stub.ts");
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    splitting: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: join(out, "bundle.js"),
    nodePaths: [...nodePaths, join(RA, "node_modules")],
    alias: {
      "@genclass/runtime/react": join(RT, "adapters/react.ts"),
      "@genclass/runtime/redux": join(RT, "adapters/redux.ts"),
      "@genclass/runtime/zustand": join(RT, "adapters/zustand.ts"),
      "@genclass/runtime": join(RT, "index.ts"),
      "@realapps/genclass": join(RA, "apps/_shared/genclass.ts"),
      "onnxruntime-web/webgpu": stub,
      "onnxruntime-web/wasm": stub,
      "onnxruntime-web": stub,
    },
    plugins,
    conditions: ["browser", "import", "module", "default"],
    mainFields: ["browser", "module", "main"],
    loader: { ".css": "empty", ".svg": "text", ".png": "empty" },
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
    logLevel: "warning",
    minify: false,
    legalComments: "none",
  });
  let page = html && existsSync(html) ? readFileSync(html, "utf8") : '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Conduit</title></head>\n<body></body></html>\n';
  page = page
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/\n\s*\n+/g, "\n");
  page = /<\/body>/i.test(page) ? page.replace(/<\/body>/i, '<script type="module" src="/bundle.js"></script>\n</body>') : `${page}\n<script type="module" src="/bundle.js"></script>\n`;
  writeFileSync(join(out, "index.html"), page);
  console.log(`rebundled ${entry} -> ${out}/bundle.js (${(statSync(join(out, "bundle.js")).size / 1024).toFixed(0)} KB in ${Date.now() - t0} ms)`);
}

/**
 * Apps whose builder emits classic scripts sharing globals (Ember: loader.js AMD `define`/`require` across vendor.js
 * and the app script): keep them classic and in page order, concatenated into one bundle.js, preceded by the GenClass
 * init (an IIFE), the way an SDK <script> placed before the app's scripts in index.html would load.
 */
export async function concatScripts({ dir, out }) {
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/gi)].map((m) => m[1]);
  const init = await esbuild.build({
    stdin: { contents: 'import "@realapps/genclass";', resolveDir: RA, loader: "js" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    nodePaths: [join(RA, "node_modules")],
    alias: { "@genclass/runtime": join(RT, "index.ts"), "@realapps/genclass": join(RA, "apps/_shared/genclass.ts"), "onnxruntime-web/webgpu": join(RA, "apps/_shared/onnx-stub.ts"), "onnxruntime-web/wasm": join(RA, "apps/_shared/onnx-stub.ts"), "onnxruntime-web": join(RA, "apps/_shared/onnx-stub.ts") },
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
    logLevel: "error",
    legalComments: "none",
  });
  const parts = [`/* GenClass init (realapps integration) */\n${init.outputFiles[0].text}`];
  for (const src of srcs) parts.push(`/* ${src} */\n${readFileSync(join(dir, src.replace(/^\//, "")), "utf8")}`);
  writeFileSync(join(out, "bundle.js"), parts.join("\n;\n"));
  let page = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/\n\s*\n+/g, "\n");
  page = page.replace(/<\/body>/i, '<script src="/bundle.js"></script>\n</body>');
  writeFileSync(join(out, "index.html"), page);
  console.log(`concatenated init + ${srcs.join(" + ")} -> ${out}/bundle.js (${(statSync(join(out, "bundle.js")).size / 1024).toFixed(0)} KB in ${Date.now() - t0} ms)`);
}

// realpath on both sides: the script may be reached through a symlinked directory (the train VM's /data slots)
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv[2] === "--scripts") {
    await concatScripts({ dir: resolve(process.argv[3]), out: resolve(process.argv[4]) });
    process.exit(0);
  }
  const [dir, entry, out, html] = process.argv.slice(2);
  if (!dir || !entry || !out) {
    console.error("usage: node corpus/rebundle.mjs <built dir> <entry> <out dir> [index.html]");
    process.exit(2);
  }
  await rebundle({ entry: resolve(dir, entry), out, html: html ? resolve(html) : join(dir, "index.html") });
}
