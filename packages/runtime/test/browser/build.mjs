// Playwright global setup: build the library with tsup (as published) and bundle a tiny test app with esbuild the
// way an app bundler would: the page bundle contains the library's
// `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`, and dist/worker.js (with
// onnxruntime-web inlined) is emitted next to it as worker.js.
//
// Uses the package build (tsup.config.ts -> dist/) when every entry exists; until CORE's src/index.ts etc. land it
// builds the model entries only (index <- src/model/index.ts, worker <- src/model/worker.ts) with the same options.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..", "..");
export const BUILD = join(HERE, ".build");
export const APP = join(BUILD, "app");

const WORKER_URL_RE = /new Worker\(\s*new URL\(\s*["']\.\/worker\.js["']\s*,\s*import\.meta\.url\s*\)\s*,\s*\{\s*type:\s*["']module["']\s*\}\s*\)/;

function fullBuildPossible() {
  const cfg = readFileSync(join(PKG, "tsup.config.ts"), "utf8");
  const entries = [...cfg.matchAll(/"(src\/[^"]+\.tsx?)"/g)].map((m) => m[1]);
  return entries.length > 0 && entries.every((e) => existsSync(join(PKG, e)));
}

function checkWorkerPattern(dist) {
  const jsFiles = readdirSync(dist).filter((f) => f.endsWith(".js"));
  const withPattern = jsFiles.filter((f) => WORKER_URL_RE.test(readFileSync(join(dist, f), "utf8")));
  if (!withPattern.length) throw new Error(`no built file in ${dist} contains new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`);
  if (!existsSync(join(dist, "worker.js"))) throw new Error(`${dist}/worker.js was not built`);
  // onnxruntime-web is loaded on demand: the WebGPU bundle or the WASM-only one, both as static import() strings
  const workerJs = [join(dist, "worker.js"), ...jsFiles.filter((f) => f.startsWith("chunk-")).map((f) => join(dist, f))].map((f) => readFileSync(f, "utf8")).join("\n");
  for (const spec of ["onnxruntime-web/webgpu", "onnxruntime-web/wasm"]) {
    if (!new RegExp(`import\\(\\s*["']${spec.replace("/", "\\/")}["']\\s*\\)`).test(workerJs)) throw new Error(`${dist}: the worker does not import("${spec}")`);
  }
  return withPattern;
}

/**
 * The package build (tsup.config.ts -> dist/) when it is possible: its output must keep the worker URL pattern.
 * The test app uses it when dist/index.js exports createModelHost; otherwise (or if the package build fails) it
 * uses a build of the model entries with the same options.
 */
async function buildLibrary() {
  const notes = [];
  if (fullBuildPossible()) {
    try {
      execFileSync("npx", ["tsup"], { cwd: PKG, stdio: "inherit" });
      const dist = join(PKG, "dist");
      const files = checkWorkerPattern(dist);
      notes.push(`package build: worker URL pattern kept in dist/${files.join(", dist/")}`);
      if (/\bcreateModelHost\b/.test(readFileSync(join(dist, "index.js"), "utf8"))) return { dist, mode: "package", notes };
      notes.push("package dist/index.js does not export createModelHost: the test app uses the model-entries build");
    } catch (e) {
      notes.push(`package build unusable (${e.message.split("\n")[0]}): the test app uses the model-entries build`);
    }
  }
  const { build } = await import("tsup");
  const outDir = join(BUILD, "dist");
  rmSync(outDir, { recursive: true, force: true });
  await build({
    entry: { index: "src/model/index.ts", worker: "src/model/worker.ts" },
    outDir,
    format: ["esm"],
    target: "es2022",
    platform: "browser",
    splitting: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    dts: false,
    silent: true,
    external: ["onnxruntime-web", "onnxruntime-web/webgpu", "onnxruntime-web/wasm", "react", "redux", "zustand"],
    tsconfig: join(PKG, "tsconfig.json"),
    config: false,
  });
  const files = checkWorkerPattern(outDir);
  notes.push(`model-entries build: worker URL pattern kept in ${files.join(", ")}`);
  return { dist: outDir, mode: "model-entries", notes };
}

export default async function globalSetup() {
  mkdirSync(BUILD, { recursive: true });
  process.chdir(PKG);
  // The worker URL pattern must survive the build verbatim (bundlers key on it): checked in buildLibrary.
  const { dist, mode, notes } = await buildLibrary();

  const esbuild = await import("esbuild");
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });
  // One build, two entries (the page and the worker) with code splitting, like an app bundler: each onnxruntime-web
  // bundle becomes its own chunk, loaded only by the path that needs it.
  const result = await esbuild.build({
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    logLevel: "warning",
    external: ["node:*"],
    splitting: true,
    outdir: APP,
    entryPoints: { main: join(HERE, "page", "main.ts"), worker: join(dist, "worker.js") },
    entryNames: "[name]",
    chunkNames: "chunks/[name]-[hash]",
    alias: { "genclass-dist": join(dist, "index.js") },
    metafile: true,
  });
  cpSync(join(HERE, "page", "index.html"), join(APP, "index.html"));
  const appJs = Object.keys(result.metafile.outputs).filter((f) => f.endsWith(".js"));
  if (!appJs.some((f) => WORKER_URL_RE.test(readFileSync(f, "utf8")))) throw new Error("the page bundle lost the worker URL pattern");
  writeFileSync(join(BUILD, "app-files.json"), JSON.stringify(appJs.map((f) => ({ file: f.replace(/^.*\/app\//, ""), inputs: Object.keys(result.metafile.outputs[f].inputs).filter((i) => i.includes("onnxruntime-web")) })), null, 2));
  writeFileSync(join(BUILD, "build-info.json"), JSON.stringify({ mode, dist, notes, at: new Date().toISOString() }, null, 2));
  for (const n of notes) console.log(`[browser tests] ${n}`);
  console.log(`[browser tests] test app built against ${mode} (${dist})`);
}
