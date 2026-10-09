// What an app's bundler makes of the published dist/ (Troy trial, 2026-10-09: Next/Turbopack emitted 41 MB of
// onnxruntime-web .wasm/.mjs that the runtime never requests, and the first-load cost was ~97 KB gzip, not 83).
// Needs a build (`npx tsup`): skipped without dist/.
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const PKG = resolve(__dirname, "..");
const DIST = join(PKG, "dist");
const built = existsSync(join(DIST, "auto.js")) && existsSync(join(DIST, "cdn", "ort-webgpu.js"));

function files(dir: string): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else out.push({ path: p, bytes: statSync(p).size });
  }
  return out;
}

describe.skipIf(!built)("dist as an app bundles it", () => {
  it("no chunk in dist/ imports onnxruntime-web by name: the worker and the inline path load dist/cdn/ort-*.js", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of files(DIST).filter((x) => /\.js$/.test(x.path) && !x.path.includes(`${join("dist", "cdn")}`) && !/genclass\.global/.test(x.path))) {
      expect(readFileSync(f.path, "utf8"), f.path).not.toMatch(/["']onnxruntime-web(\/[\w-]+)?["']/);
    }
    // the prepared ORT copies keep no `new URL("<file>", import.meta.url)` a bundler would emit as an asset
    for (const f of ["ort-webgpu.js", "ort-wasm.js"]) {
      const src = readFileSync(join(DIST, "cdn", f), "utf8");
      expect(src).not.toMatch(/new\s+\w+\(\s*["'][^"']+["']\s*,\s*import\.meta\.url\s*\)/);
      expect(src).toContain("ort-wasm-simd-threaded"); // still the real ORT (it names its files)
    }
  });

  it("Vite: no .wasm and nothing over 25 MiB is emitted for `import \"@genclass/runtime/auto\"`", async () => {
    let vite: typeof import("vite");
    try {
      vite = await import("vite");
    } catch {
      return; // vite not installed here
    }
    const dir = mkdtempSync(join(tmpdir(), "genclass-vite-"));
    try {
      writeFileSync(join(dir, "index.html"), '<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>');
      writeFileSync(join(dir, "main.js"), `import genclass from ${JSON.stringify(join(DIST, "auto.js"))};\nconsole.log(genclass.mode);\n`);
      await vite.build({ root: dir, logLevel: "silent", configFile: false, build: { outDir: join(dir, "out"), emptyOutDir: true } });
      const out = files(join(dir, "out"));
      expect(out.filter((f) => /\.wasm$/.test(f.path))).toEqual([]);
      expect(out.filter((f) => f.bytes > 25 * 1024 * 1024)).toEqual([]);
      expect(out.reduce((n, f) => n + f.bytes, 0)).toBeLessThan(2_000_000); // was ~41 MB with the two ORT wasm builds
      expect(out.some((f) => /worker/.test(f.path))).toBe(true); // the model worker is still bundled
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("first-load cost of /auto and the main entry, minified + gzip: under 92 KB (README: about 89 KB)", async () => {
    const { build } = await import("esbuild");
    const uses: Record<string, string> = { "auto.js": "", "index.js": "GenClass.init({});" };
    for (const entry of ["auto.js", "index.js"]) {
      const spec = JSON.stringify(join(DIST, entry));
      const r = await build({
        stdin: { contents: uses[entry] ? `import { GenClass } from ${spec};\n${uses[entry]}` : `import ${spec};`, resolveDir: PKG, loader: "js" },
        bundle: true,
        splitting: true,
        format: "esm",
        minify: true,
        write: false,
        outdir: "/out",
        metafile: true,
        platform: "browser",
        external: ["react", "redux", "zustand"],
        logLevel: "silent",
      });
      const outs = r.metafile!.outputs;
      const byPath = new Map(r.outputFiles!.map((f) => [f.path, f.contents]));
      const first = new Set<string>();
      const walk = (k: string) => {
        if (first.has(k)) return;
        first.add(k);
        for (const i of outs[k].imports) if (i.kind === "import-statement" && outs[i.path]) walk(i.path);
      };
      walk(Object.keys(outs).find((k) => outs[k].entryPoint)!);
      const gz = [...first].reduce((n, k) => n + gzipSync(byPath.get(resolve("/", k))!, { level: 9 }).length, 0);
      expect(gz / 1024, entry).toBeLessThan(92);
      // the model's tokenizer, packer and engine are not in it (the worker has them; the inline path loads them lazily)
      const code = [...first].map((k) => new TextDecoder().decode(byPath.get(resolve("/", k))!)).join("\n");
      expect(code, entry).not.toContain("BPE dropout is not supported at inference"); // src/model/tokenizer.ts
      expect(code, entry).toContain("new Worker("); // the host itself is there
    }
  });
});
