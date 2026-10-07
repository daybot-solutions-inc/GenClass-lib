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

async function buildLibrary() {
  if (fullBuildPossible()) {
    execFileSync("npx", ["tsup"], { cwd: PKG, stdio: "inherit" });
    return { dist: join(PKG, "dist"), mode: "package" };
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
    external: ["onnxruntime-web", "onnxruntime-web/webgpu", "react", "redux", "zustand"],
    tsconfig: join(PKG, "tsconfig.json"),
    config: false,
  });
  return { dist: outDir, mode: "model-entries" };
}

export default async function globalSetup() {
  mkdirSync(BUILD, { recursive: true });
  process.chdir(PKG);
  const { dist, mode } = await buildLibrary();

  // The worker URL pattern must survive the build verbatim (bundlers key on it).
  const jsFiles = readdirSync(dist).filter((f) => f.endsWith(".js"));
  const withPattern = jsFiles.filter((f) => WORKER_URL_RE.test(readFileSync(join(dist, f), "utf8")));
  if (!withPattern.length) throw new Error(`no built file in ${dist} contains new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`);
  if (!existsSync(join(dist, "worker.js"))) throw new Error(`${dist}/worker.js was not built`);
  const workerSrc = readFileSync(join(dist, "worker.js"), "utf8");
  if (!/from\s*["']onnxruntime-web\/webgpu["']/.test(workerSrc)) throw new Error("dist/worker.js does not import onnxruntime-web/webgpu");

  const esbuild = await import("esbuild");
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });
  const common = { bundle: true, format: "esm", platform: "browser", target: "es2022", sourcemap: true, logLevel: "warning", external: ["node:*"] };
  await esbuild.build({ ...common, entryPoints: [join(HERE, "page", "main.ts")], outfile: join(APP, "main.js"), alias: { "genclass-dist": join(dist, "index.js") } });
  await esbuild.build({ ...common, entryPoints: [join(dist, "worker.js")], outfile: join(APP, "worker.js") });
  cpSync(join(HERE, "page", "index.html"), join(APP, "index.html"));
  const bundled = readFileSync(join(APP, "main.js"), "utf8");
  if (!WORKER_URL_RE.test(bundled)) throw new Error("the page bundle lost the worker URL pattern");
  writeFileSync(join(BUILD, "build-info.json"), JSON.stringify({ mode, dist, workerPatternIn: withPattern, at: new Date().toISOString() }, null, 2));
  console.log(`[browser tests] library build: ${mode} (${dist}); worker URL pattern in ${withPattern.join(", ")}`);
}
