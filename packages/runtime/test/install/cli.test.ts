// `genclass-runtime init|remove` on fixture projects (no network, no package manager: --no-install), plus the
// text-edit helpers and the page-config parser. The real-framework builds are in test/install/frameworks.sh (VM).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ESM module without types
import { appendEnd, bodyTagEnd, codeStyle, insertTop, planRemoval, removeMarked, switchMode, topOffset } from "../../bin/lib/edit.mjs";
// @ts-expect-error plain ESM module without types
import { integrityFor, nodeOnlyImport, scriptTag } from "../../bin/lib/plan.mjs";
// @ts-expect-error plain ESM module without types
import { libraryEvidence } from "../../bin/lib/detect.mjs";
import { assetBase } from "../../src/cdn/global.js";
import { GenClass } from "../../src/index.js";
import { DEFAULT_MODEL_BASE_URL } from "../../src/model/host.js";
import { devtoolsOptions, fromDataset, fromPairs, isKilled, isLocalHost, mergeConfig, parsePairs, readMetaConfig } from "../../src/cdn/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "..", "bin", "genclass-runtime.mjs");
const PKG_JSON = JSON.parse(readFileSync(resolve(HERE, "..", "..", "package.json"), "utf8")) as {
  version: string;
  exports: Record<string, string | { types?: string; import?: string }>;
  typesVersions?: Record<string, Record<string, string[]>>;
  sideEffects: string[];
  files: string[];
};
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gc-init-"));
  roots.push(dir);
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), content);
  }
  return dir;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

function cli(dir: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args, "--cwd", dir], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

/** init --yes, init again (no change), remove --yes (byte for byte). Returns the files after init. */
function roundTrip(dir: string, ...initArgs: string[]): Record<string, string> {
  const before = snapshot(dir);
  const r1 = cli(dir, "init", "--yes", "--no-install", ...initArgs);
  expect(r1.code, r1.out).toBe(0);
  const after = snapshot(dir);
  expect(after).not.toEqual(before);
  const r2 = cli(dir, "init", "--yes", "--no-install", ...initArgs);
  expect(r2.code, r2.out).toBe(0);
  expect(r2.out).toContain("Nothing to do");
  expect(snapshot(dir)).toEqual(after);
  const r3 = cli(dir, "remove", "--yes");
  expect(r3.code, r3.out).toBe(0);
  expect(snapshot(dir)).toEqual(before);
  const r4 = cli(dir, "remove", "--yes");
  expect(r4.out).toContain("Nothing to remove");
  return after;
}

const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "app", private: true, dependencies: deps, ...extra }, null, 2) + "\n";
const VITE_HTML = `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>Vite</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`;

describe("init / remove on fixture projects", () => {
  it("Vite + React (TS, single quotes, no semicolons): one import on top, dev overlay at the end", () => {
    const dir = project({
      "package.json": pkg({ react: "^19.0.0", vite: "^7.0.0", "@vitejs/plugin-react": "^5" }),
      "tsconfig.json": "{}\n",
      "index.html": VITE_HTML,
      "src/main.tsx": `import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App.tsx'\n\ncreateRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)\n`,
      "src/App.tsx": `import { useState } from 'react'\nexport default function App() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button> }\n`,
    });
    const r = cli(dir, "init", "--dry-run", "--no-install");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Vite + React");
    expect(r.out).toContain("Dry run");
    expect(r.out).toContain("useGenClassState");
    const after = roundTrip(dir);
    const main = after["src/main.tsx"];
    expect(main.split("\n")[0]).toBe(`import genclass from '@genclass/runtime/auto' // genclass:init`);
    expect(main.trimEnd().split("\n").pop()).toBe(`if (import.meta.env.DEV) import('@genclass/runtime/devtools').then((d) => d.mountDevtools(genclass)) // genclass:init`);
  });

  it("--mode observe uses /auto/observe; --no-devtools adds a bare import only", () => {
    const dir = project({ "package.json": pkg({ vue: "^3", vite: "^7" }), "index.html": VITE_HTML.replace("main.tsx", "main.js"), "src/main.js": `import { createApp } from "vue";\nimport App from "./App.vue";\n\ncreateApp(App).mount("#app");\n` });
    const after = roundTrip(dir, "--mode", "observe", "--no-devtools");
    expect(after["src/main.js"]).toBe(`import "@genclass/runtime/auto/observe"; // genclass:init\nimport { createApp } from "vue";\nimport App from "./App.vue";\n\ncreateApp(App).mount("#app");\n`);
  });

  it("refuses to write without a terminal unless --yes, and asks nothing with --dry-run", () => {
    const dir = project({ "package.json": pkg({ vite: "^7" }), "index.html": VITE_HTML.replace("main.tsx", "main.ts"), "src/main.ts": `console.log(1);\n` });
    const r = cli(dir, "init", "--no-install");
    expect(r.code).toBe(1);
    expect(r.out).toContain("--yes");
    expect(readFileSync(join(dir, "src/main.ts"), "utf8")).toBe(`console.log(1);\n`);
  });

  it("Next.js 16: creates instrumentation-client.ts (src/ layout)", () => {
    const dir = project({
      "package.json": pkg({ next: "16.0.0", react: "^19" }),
      "tsconfig.json": "{}\n",
      "node_modules/next/package.json": JSON.stringify({ name: "next", version: "16.0.1" }),
      "src/app/layout.tsx": `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
      "src/app/page.tsx": `export default function Page() { return <main>hi</main>; }\n`,
    });
    const after = roundTrip(dir);
    const f = after["src/instrumentation-client.ts"];
    expect(f).toContain(`import genclass from "@genclass/runtime/auto";`);
    expect(f).toContain(`if (process.env.NODE_ENV === "development") {`);
    expect(after["src/app/layout.tsx"]).toBe(snapshotOf(dir, "src/app/layout.tsx"));
  });

  it("Next.js 15.1 App Router: GenClassInit client component in the root layout (multi-line and one-line <body>)", () => {
    for (const body of [`      <body\n        className={\`\${a.variable} \${b.variable} antialiased\`}\n      >\n        {children}\n      </body>`, `      <body className="x">{children}</body>`]) {
      const dir = project({
        "package.json": pkg({ next: "15.1.0" }),
        "tsconfig.json": "{}\n",
        "app/layout.tsx": `import type { Metadata } from "next";\nimport "./globals.css";\n\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {\n  return (\n    <html lang="en">\n${body}\n    </html>\n  );\n}\n`,
      });
      const after = roundTrip(dir);
      expect(after["app/genclass-init.tsx"]).toContain('"use client";');
      expect(after["app/layout.tsx"].split("\n")[0]).toBe(`import { GenClassInit } from "./genclass-init"; // genclass:init`);
      expect(after["app/layout.tsx"]).toMatch(/<GenClassInit \/>/);
    }
  });

  it("Next.js 14 Pages Router: pages/_app import; creates _app when missing", () => {
    const withApp = project({
      "package.json": pkg({ next: "14.2.0" }),
      "pages/_app.js": `import "../styles/globals.css";\n\nexport default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n`,
      "pages/index.js": `export default function Home() { return null; }\n`,
    });
    const a = roundTrip(withApp);
    expect(a["pages/_app.js"]).toContain(`typeof window !== "undefined"`);
    const noApp = project({ "package.json": pkg({ next: "14.2.0" }), "pages/index.js": `export default function Home() { return null; }\n` });
    const b = roundTrip(noApp);
    expect(b["pages/_app.jsx"]).toContain("export default function App");
  });

  it("SvelteKit: creates src/hooks.client.ts, or edits an existing one", () => {
    const dir = project({ "package.json": pkg({ "@sveltejs/kit": "^2" }), "tsconfig.json": "{}\n", "src/routes/+page.svelte": "<h1>hi</h1>\n" });
    expect(roundTrip(dir)["src/hooks.client.ts"]).toContain("import.meta.env.DEV");
    const dir2 = project({ "package.json": pkg({ "@sveltejs/kit": "^2" }), "src/hooks.client.js": `export const handleError = ({ error }) => console.error(error);` });
    const after = roundTrip(dir2); // no final newline: restored exactly
    expect(after["src/hooks.client.js"].split("\n")[0]).toBe(`import genclass from "@genclass/runtime/auto"; // genclass:init`);
  });

  it("Nuxt 3 and Nuxt 4 (app/): a .client plugin", () => {
    const n3 = project({ "package.json": pkg({ nuxt: "^3.13.0" }), "tsconfig.json": "{}\n", "app.vue": "<template><div/></template>\n" });
    expect(roundTrip(n3)["plugins/genclass.client.ts"]).toContain("defineNuxtPlugin");
    const n4 = project({ "package.json": pkg({ nuxt: "^4.0.0" }), "tsconfig.json": "{}\n", "app/app.vue": "<template><div/></template>\n" });
    expect(roundTrip(n4)["app/plugins/genclass.client.ts"]).toContain("import.meta.dev");
    // the plugins/ directory init created is gone again
    expect(() => statSync(join(n4, "app/plugins"))).toThrow();
  });

  it("Astro: a script line before </head> in each layout", () => {
    const dir = project({
      "package.json": pkg({ astro: "^5" }),
      "src/layouts/Layout.astro": `---\nconst { title } = Astro.props;\n---\n<html>\n\t<head>\n\t\t<title>{title}</title>\n\t</head>\n\t<body><slot /></body>\n</html>\n`,
      "src/pages/index.astro": `---\nimport Layout from "../layouts/Layout.astro";\n---\n<Layout title="x"><h1>hi</h1></Layout>\n`,
    });
    const after = roundTrip(dir);
    expect(after["src/layouts/Layout.astro"]).toContain(`\t\t<script>import genclass from "@genclass/runtime/auto"; if (import.meta.env.DEV)`);
    const one = project({ "package.json": pkg({ astro: "^5" }), "src/pages/index.astro": `<html><head><title>x</title></head><body>hi</body></html>\n` });
    expect(roundTrip(one)["src/pages/index.astro"]).toContain("// genclass:inline</script></head>");
  });

  it("Angular, CRA, Remix root, React Router entry.client, webpack", () => {
    const ng = roundTrip(project({ "package.json": pkg({ "@angular/core": "^20" }), "src/main.ts": `import { bootstrapApplication } from '@angular/platform-browser';\nimport { App } from './app/app';\n\nbootstrapApplication(App).catch((err) => console.error(err));\n` }));
    expect(ng["src/main.ts"]).toContain(`import { isDevMode as genclassDevMode } from '@angular/core'; // genclass:init`);
    const cra = roundTrip(project({ "package.json": pkg({ "react-scripts": "5.0.1", react: "^18" }), "src/index.js": `import React from 'react';\n` }));
    expect(cra["src/index.js"]).toContain(`process.env.NODE_ENV === "development"`);
    const remix = roundTrip(project({ "package.json": pkg({ "@remix-run/react": "^2", vite: "^5" }), "app/root.tsx": `export default function App() { return null; }\n` }));
    expect(remix["app/root.tsx"]).toContain(`import.meta.env.DEV && typeof window !== "undefined"`);
    const rr = roundTrip(project({ "package.json": pkg({ "@react-router/dev": "^7" }), "app/entry.client.tsx": `import { HydratedRouter } from "react-router/dom";\n`, "app/root.tsx": "x\n" }));
    expect(rr["app/entry.client.tsx"].split("\n")[0]).toContain("@genclass/runtime/auto");
    expect(rr["app/root.tsx"]).toBe("x\n");
    const wp = roundTrip(project({ "package.json": pkg({ webpack: "^5", "html-webpack-plugin": "^5" }), "src/index.ts": `"use strict";\nconsole.log(1);\n` }));
    expect(wp["src/index.ts"].split("\n")[1]).toContain("@genclass/runtime/auto");
  });

  it("plain HTML: the script tag first in <head> (every page), CRLF kept", () => {
    const dir = project({
      "index.html": `<!DOCTYPE html>\r\n<html>\r\n<head>\r\n  <meta charset="utf-8">\r\n  <script src="app.js"></script>\r\n</head>\r\n<body></body>\r\n</html>\r\n`,
      "about.html": `<html><head><title>About</title></head><body></body></html>`,
      "app.js": "fetch('/api');\n",
    });
    const after = roundTrip(dir, "--mode", "observe", "--cdn", "https://example.test/genclass.global.min.js", "--no-sri");
    expect(after["index.html"]).toContain(`<head>\r\n  <script src="https://example.test/genclass.global.min.js" data-mode="observe" data-devtools="local"></script> <!-- genclass:init -->\r\n  <meta charset="utf-8">`);
    expect(after["about.html"]).toContain(`<head><script src="https://example.test/genclass.global.min.js" data-mode="observe" data-devtools="local"></script><!-- genclass:inline --><title>`);
  });

  it("leaves a hand-written setup alone and keeps user edits outside the markers on remove", () => {
    const manual = project({ "package.json": pkg({ vite: "^7" }), "index.html": VITE_HTML.replace("main.tsx", "main.ts"), "src/main.ts": `import { GenClass } from "@genclass/runtime";\nGenClass.init();\n` });
    const r = cli(manual, "init", "--yes", "--no-install");
    expect(r.code).toBe(0);
    expect(r.out).toContain("already imported");
    const dir = project({ "package.json": pkg({ "@sveltejs/kit": "^2" }), "src/routes/+page.svelte": "x\n" });
    expect(cli(dir, "init", "--yes", "--no-install").code).toBe(0);
    const f = join(dir, "src/hooks.client.js");
    writeFileSync(f, readFileSync(f, "utf8") + `export const handleError = () => {};\n`);
    expect(cli(dir, "remove", "--yes").code).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(`export const handleError = () => {};\n`);
  });

  it("explains what to do when it cannot recognise the project", () => {
    const dir = project({ "README.md": "hi\n" });
    const r = cli(dir, "init", "--yes", "--no-install");
    expect(r.code).toBe(1);
    expect(r.out).toContain(`import "@genclass/runtime/auto";`);
  });
});

function snapshotOf(dir: string, f: string): string {
  return readFileSync(join(dir, f), "utf8");
}

describe("edit helpers", () => {
  it("topOffset skips shebang, directives and pragma comments only", () => {
    expect(topOffset(`#!/usr/bin/env node\n"use strict";\nx;\n`)).toBe(`#!/usr/bin/env node\n"use strict";\n`.length);
    expect(topOffset(`/** @jsxImportSource preact */\nimport x from "y";\n`)).toBe(`/** @jsxImportSource preact */\n`.length);
    expect(topOffset(`/* license */\nimport x from "y";\n`)).toBe(0);
    expect(insertTop(`'use client'\nexport {}\n`, ["a // genclass:init"])).toBe(`'use client'\na // genclass:init\nexport {}\n`);
  });
  it("appendEnd / removeMarked restore files with and without a final newline, and CRLF", () => {
    const top = `import genclass from "@genclass/runtime/auto"; // genclass:init`;
    const dev = `if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass)); // genclass:init`;
    for (const t of ["a\nb\n", "a\nb", "a\r\nb\r\n", "a\r\nb", ""]) {
      const added = appendEnd(insertTop(t, [top]), [dev]);
      expect(removeMarked(added)).toBe(t);
    }
  });
  it("removeMarked drops blocks and inline forms", () => {
    expect(removeMarked(`// genclass:init start: x\nimport genclass from "@genclass/runtime/auto";\n\nexport default defineNuxtPlugin(() => {});\n// genclass:init end\nkeep\n`)).toBe(`keep\n`);
    expect(removeMarked(`<body><GenClassInit />{/* genclass:inline */}{children}</body>\n`)).toBe(`<body>{children}</body>\n`);
  });
  it("codeStyle and bodyTagEnd", () => {
    expect(codeStyle(`import a from 'a'\nimport b from 'b'\n`)).toEqual({ q: "'", semi: "" });
    expect(codeStyle(``)).toEqual({ q: '"', semi: ";" });
    const t = `<body className={a > b ? "x" : "y"}>{children}</body>`;
    expect(t.slice(0, bodyTagEnd(t))).toBe(`<body className={a > b ? "x" : "y"}>`);
  });
});

describe("page config", () => {
  it("parses meta content and data attributes", () => {
    expect(parsePairs("mode=observe, devtools; model=off")).toEqual({ mode: "observe", devtools: "", model: "off" });
    expect(fromPairs(parsePairs("mode=heal devtools=local model=/m/ ort=/ort/ device=wasm"))).toEqual({ mode: "heal", devtools: "local", model: { baseUrl: "/m/", ortWasmPaths: "/ort/", device: "wasm" } });
    expect(fromPairs({ model: "off", mode: "bogus" })).toEqual({ model: false });
    expect(fromDataset({ mode: "observe", devtools: "", manual: "", base: "/x/", ortWasmPaths: "/o/" })).toEqual({ mode: "observe", devtools: true, model: { ortWasmPaths: "/o/" } });
    expect(fromDataset({ devtools: "bottom-left" })).toEqual({ devtools: { position: "bottom-left" } });
    expect(mergeConfig({ model: { baseUrl: "/a/" } }, { model: { device: "wasm" } }, { mode: "observe" })).toEqual({ model: { baseUrl: "/a/", device: "wasm" }, mode: "observe" });
    expect(mergeConfig({ model: { baseUrl: "/a/" } }, { model: false })).toEqual({ model: false });
    const doc = { querySelectorAll: () => [{ getAttribute: () => "mode=observe" }, { getAttribute: () => "devtools" }] };
    expect(readMetaConfig(doc)).toEqual({ mode: "observe", devtools: true });
  });
  it("devtools=local only on development hosts; kill switch", () => {
    expect(isLocalHost({ hostname: "localhost" })).toBe(true);
    expect(isLocalHost({ hostname: "app.localhost" })).toBe(true);
    expect(isLocalHost({ hostname: "127.0.0.1" })).toBe(true);
    expect(isLocalHost({ hostname: "example.com" })).toBe(false);
    expect(isLocalHost({ protocol: "file:", hostname: "" })).toBe(true);
    expect(devtoolsOptions("local", { hostname: "example.com" })).toBeNull();
    expect(devtoolsOptions("local", { hostname: "localhost" })).toEqual({});
    expect(devtoolsOptions(true, { hostname: "example.com" })).toEqual({});
    expect(isKilled({ location: { search: "?genclass=off" } })).toBe(true);
    expect(isKilled({ location: { search: "?genclass=observe" } })).toBe(false);
    expect(isKilled({ localStorage: { getItem: () => "OFF" } })).toBe(true);
  });
  it("assetBase pins jsDelivr/unpkg URLs to the script's version, else uses its directory", () => {
    const v = "0.0.0"; // __GENCLASS_VERSION__ is only defined in the built file
    expect(assetBase("https://cdn.jsdelivr.net/npm/@genclass/runtime")).toBe(`https://cdn.jsdelivr.net/npm/@genclass/runtime@${v}/dist/`);
    expect(assetBase("https://cdn.jsdelivr.net/npm/@genclass/runtime@latest/dist/genclass.global.min.js")).toBe(`https://cdn.jsdelivr.net/npm/@genclass/runtime@${v}/dist/`);
    expect(assetBase("https://unpkg.com/@genclass/runtime@0.1/dist/genclass.global.js")).toBe(`https://unpkg.com/@genclass/runtime@${v}/dist/`);
    expect(assetBase("https://static.example.com/js/genclass/genclass.global.min.js")).toBe("https://static.example.com/js/genclass/");
    expect(assetBase("https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/x.js")).toBe("https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/");
    expect(assetBase(null)).toBe(`https://cdn.jsdelivr.net/npm/@genclass/runtime@${v}/dist/`);
  });
});

const VITE_MAIN = `import { createApp } from "vue";\nimport App from "./App.vue";\n\ncreateApp(App).mount("#app");\n`;
const viteVue = () => project({ "package.json": pkg({ vue: "^3", vite: "^7" }), "index.html": VITE_HTML.replace("main.tsx", "main.js"), "src/main.js": VITE_MAIN });
const PAGE = `<!doctype html>\n<html>\n<head>\n  <title>x</title>\n</head>\n<body></body>\n</html>\n`;

describe("modes: observe is the default; --mode guard / heal install those modes", () => {
  it("init without --mode writes the plain /auto import (observe) and says so", () => {
    const dir = viteVue();
    const r = cli(dir, "init", "--yes", "--no-install", "--no-devtools");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Mode\s+observe \(default/);
    expect(readFileSync(join(dir, "src/main.js"), "utf8").split("\n")[0]).toBe(`import "@genclass/runtime/auto"; // genclass:init`);
  });

  it("--mode guard / heal write /auto/guard, /auto/heal and data-mode on the script tag", () => {
    for (const mode of ["guard", "heal"]) {
      const after = roundTrip(viteVue(), "--mode", mode);
      expect(after["src/main.js"].split("\n")[0]).toBe(`import genclass from "@genclass/runtime/auto/${mode}"; // genclass:init`);
      const html = roundTrip(project({ "index.html": PAGE }), "--mode", mode, "--no-sri");
      expect(html["index.html"]).toContain(` data-mode="${mode}" data-devtools="local"></script> <!-- genclass:init -->`);
    }
    const plain = roundTrip(project({ "index.html": PAGE }), "--no-sri");
    expect(plain["index.html"]).not.toContain("data-mode");
  });

  it("the default script URL is pinned to package.json's version", () => {
    const r = cli(project({ "index.html": PAGE }), "init", "--dry-run");
    expect(r.out).toContain(`https://cdn.jsdelivr.net/npm/@genclass/runtime@${PKG_JSON.version}/dist/genclass.global.min.js`);
  });

  it("fetch-model's default --from is the runtime's default model directory (npm via jsDelivr), not a GitHub release", () => {
    const src = readFileSync(BIN, "utf8");
    expect(src.match(/^const DEFAULT_FROM = "([^"]+)";$/m)?.[1]).toBe(DEFAULT_MODEL_BASE_URL);
    expect(DEFAULT_MODEL_BASE_URL).toBe("https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.1.0/files/");
    const r = cli(project({}), "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain(DEFAULT_MODEL_BASE_URL);
    expect(r.out).not.toContain("releases/download");
  });

  it("USAGE documents observe as the default", () => {
    const r = cli(project({}), "init", "--help");
    expect(r.out).toContain("observe (default");
    expect(r.out).not.toContain("guard (default)");
  });

  it("init again with another --mode switches the marked import in place; the same mode changes nothing", () => {
    const dir = viteVue();
    const before = snapshot(dir);
    expect(cli(dir, "init", "--yes", "--no-install").code).toBe(0);
    const main = () => readFileSync(join(dir, "src/main.js"), "utf8");
    const plainObserve = main();
    expect(cli(dir, "init", "--yes", "--no-install", "--mode", "observe").out).toContain("Nothing to do");
    expect(main()).toBe(plainObserve);
    const g = cli(dir, "init", "--yes", "--no-install", "--mode", "guard");
    expect(g.code, g.out).toBe(0);
    expect(g.out).not.toContain("Nothing to do");
    expect(main().split("\n")[0]).toBe(`import genclass from "@genclass/runtime/auto/guard"; // genclass:init`);
    expect(main().replace("/auto/guard", "/auto")).toBe(plainObserve);
    expect(cli(dir, "init", "--yes", "--no-install", "--mode", "guard").out).toContain("Nothing to do");
    // a dry run shows the switch and writes nothing
    expect(cli(dir, "init", "--dry-run", "--no-install", "--mode", "heal").out).toContain("auto/heal");
    expect(main()).toContain("/auto/guard");
    expect(cli(dir, "init", "--yes", "--no-install", "--mode", "heal").code).toBe(0);
    expect(main()).toContain(`"@genclass/runtime/auto/heal"`);
    expect(cli(dir, "remove", "--yes").code).toBe(0);
    expect(snapshot(dir)).toEqual(before);

    const site = project({ "index.html": PAGE });
    expect(cli(site, "init", "--yes", "--no-sri").code).toBe(0);
    expect(cli(site, "init", "--yes", "--mode", "heal").code).toBe(0);
    expect(readFileSync(join(site, "index.html"), "utf8")).toContain(`data-mode="heal" data-devtools="local"></script> <!-- genclass:init -->`);
    expect(cli(site, "remove", "--yes").code).toBe(0);
    expect(readFileSync(join(site, "index.html"), "utf8")).toBe(PAGE);
  });

  it("a later GenClass.init({ mode }) that cannot apply says so once (it used to be ignored silently)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const rt = GenClass.init({ model: false, report: "silent" });
      expect(rt.mode).toBe("observe");
      expect(GenClass.init({ mode: "guard" })).toBe(rt);
      expect(GenClass.init({ mode: "guard" })).toBe(rt);
      expect(GenClass.init({ mode: "observe" })).toBe(rt);
      expect(GenClass.init()).toBe(rt);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/Already running in observe mode.*setMode\("guard"\).*init --mode guard/);
    } finally {
      GenClass.destroy();
      warn.mockRestore();
    }
  });

  it("switchMode only touches code inside init's markers", () => {
    const t = `import "@genclass/runtime/auto"; // genclass:init\nimport rt from "@genclass/runtime/auto/heal";\n`;
    expect(switchMode(t, "guard")).toBe(`import "@genclass/runtime/auto/guard"; // genclass:init\nimport rt from "@genclass/runtime/auto/heal";\n`);
    expect(switchMode(t, "observe")).toBe(t);
    expect(switchMode(`<head><script src="x.js" data-mode="guard"></script><!-- genclass:inline --></head>`, "heal")).toBe(`<head><script src="x.js" data-mode="heal"></script><!-- genclass:inline --></head>`);
  });
});

describe("remove after a formatter rewrapped init's lines", () => {
  it("takes out a Prettier-wrapped devtools statement whole (byte for byte)", () => {
    const dir = viteVue();
    const before = snapshot(dir);
    expect(cli(dir, "init", "--yes", "--no-install").code).toBe(0);
    const f = join(dir, "src/main.js");
    const added = readFileSync(f, "utf8");
    const wrapped = added.replace(
      `if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass)); // genclass:init`,
      `if (import.meta.env.DEV)\n  import("@genclass/runtime/devtools").then((d) =>\n    d.mountDevtools(genclass),\n  ); // genclass:init`,
    );
    expect(wrapped).not.toBe(added);
    writeFileSync(f, wrapped);
    const r = cli(dir, "remove", "--yes");
    expect(r.code, r.out).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });

  it("handles wrapped imports, single quotes, no semicolons and arrowParens: avoid", () => {
    const t = `import genclass from '@genclass/runtime/auto' // genclass:init\nimport {\n  isDevMode as genclassDevMode,\n} from '@angular/core' // genclass:init\nbootstrap()\nif (genclassDevMode())\n  import('@genclass/runtime/devtools').then(d => d.mountDevtools(genclass)) // genclass:init\n`;
    expect(planRemoval(t)).toEqual({ text: `bootstrap()\n`, problems: [] });
  });

  it("an ESLint curly fix (braces), alone or then wrapped by Prettier", () => {
    const one = `x();\nif (import.meta.env.DEV) { import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass)); } // genclass:init\n`;
    expect(planRemoval(one)).toEqual({ text: `x();\n`, problems: [] });
    const wrapped = `x();\nif (import.meta.env.DEV) {\n  import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));\n} // genclass:init\ny();\n`;
    expect(planRemoval(wrapped)).toEqual({ text: `x();\ny();\n`, problems: [] });
  });

  it("an inline form a formatter split onto lines of its own leaves no blank line behind", () => {
    const jsx = `      <body className="a">\n        <GenClassInit />\n        {/* genclass:inline */}\n        {children}\n      </body>\n`;
    expect(planRemoval(jsx)).toEqual({ text: `      <body className="a">\n        {children}\n      </body>\n`, problems: [] });
    const html = `<html>\n  <head>\n    <script\n      src="https://x.test/genclass.global.min.js"\n      data-devtools="local"\n    ></script>\n    <!-- genclass:inline -->\n    <title>One</title>\n  </head>\n</html>\n`;
    expect(planRemoval(html)).toEqual({ text: `<html>\n  <head>\n    <title>One</title>\n  </head>\n</html>\n`, problems: [] });
    // still on a line with other code: only the element goes
    expect(planRemoval(`<head><script src="x.js"></script><!-- genclass:inline --><title>a</title></head>`).text).toBe(`<head><title>a</title></head>`);
  });

  it("a multi-line script tag whose marker comment moved to its own line", () => {
    const t = `<head>\n  <script\n    src="https://x.test/genclass.global.min.js"\n    data-devtools="local"\n  ></script>\n  <!-- genclass:init -->\n  <title>x</title>\n</head>\n`;
    expect(planRemoval(t)).toEqual({ text: `<head>\n  <title>x</title>\n</head>\n`, problems: [] });
  });
});

describe("remove never deletes code init did not write", () => {
  it("refuses (and changes nothing) when code was added inside a file init created", () => {
    const dir = project({ "package.json": pkg({ "@sveltejs/kit": "^2" }), "src/routes/+page.svelte": "x\n" });
    expect(cli(dir, "init", "--yes", "--no-install").code).toBe(0);
    const f = join(dir, "src/hooks.client.js");
    const edited = readFileSync(f, "utf8").replace(`import genclass from "@genclass/runtime/auto";\n`, `import genclass from "@genclass/runtime/auto";\nexport const handleError = () => {};\n`);
    writeFileSync(f, edited);
    const snap = snapshot(dir);
    const r = cli(dir, "remove", "--yes");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Not removing anything");
    expect(r.out).toContain("src/hooks.client.js:1");
    expect(snapshot(dir)).toEqual(snap);
  });

  it("refuses when a block's end marker is gone, or a marked line is not init's", () => {
    const lost = project({ "package.json": pkg({ "@sveltejs/kit": "^2" }), "src/routes/+page.svelte": "x\n" });
    expect(cli(lost, "init", "--yes", "--no-install").code).toBe(0);
    const f = join(lost, "src/hooks.client.js");
    writeFileSync(f, readFileSync(f, "utf8").replace(/\/\/ genclass:init end\n/, "") + `export const handleError = () => {};\n`);
    const snap = snapshot(lost);
    const r = cli(lost, "remove", "--yes");
    expect(r.code).toBe(1);
    expect(r.out).toContain("without its");
    expect(snapshot(lost)).toEqual(snap);

    const mention = project({ "package.json": pkg({ vite: "^7" }), "index.html": VITE_HTML.replace("main.tsx", "main.js"), "src/main.js": `start(); // genclass:init is documented in the README\n` });
    const r2 = cli(mention, "remove", "--yes");
    expect(r2.code).toBe(1);
    expect(readFileSync(join(mention, "src/main.js"), "utf8")).toBe(`start(); // genclass:init is documented in the README\n`);
    expect(planRemoval(`// genclass:init end\nx();\n`).problems).toHaveLength(1);
  });

  it("keeps code added after the block of a file init created (the file stays, holding only that code)", () => {
    const dir = project({ "package.json": pkg({ "@sveltejs/kit": "^2" }), "src/routes/+page.svelte": "x\n" });
    expect(cli(dir, "init", "--yes", "--no-install").code).toBe(0);
    const f = join(dir, "src/hooks.client.js");
    writeFileSync(f, readFileSync(f, "utf8") + `export const handleError = () => {};\n`);
    const r = cli(dir, "remove", "--yes");
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(`export const handleError = () => {};\n`);
  });

  it("an edited inline <script> (Astro), a comment added in a block or a same-line statement is a problem, never deleted", () => {
    const astro = `<head><title>x</title><script>import genclass from "@genclass/runtime/auto"; track(); // genclass:inline</script></head>\n`;
    const a = planRemoval(astro);
    expect(a.text).toBe(astro);
    expect(a.problems).toEqual([{ line: 1, reason: expect.stringContaining("edited") }]);
    const ok = `<head><title>x</title><script>import genclass from "@genclass/runtime/auto"; if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass)); // genclass:inline</script></head>\n`;
    expect(planRemoval(ok)).toEqual({ text: `<head><title>x</title></head>\n`, problems: [] });
    const block = `// genclass:init start: x\n// GenClass: our team's note\nimport genclass from "@genclass/runtime/auto";\n// genclass:init end\n`;
    expect(planRemoval(block).text).toBe(block);
    expect(planRemoval(block).problems).toHaveLength(1);
    for (const line of [`foo(); import "@genclass/runtime/auto"; // genclass:init\n`, `const x = foo(\n  import("@genclass/runtime/auto"), // genclass:init\n);\n`]) {
      expect(planRemoval(line).text).toBe(line);
      expect(planRemoval(line).problems).toHaveLength(1);
    }
  });
});

describe("remove keeps the package while anything still imports it", () => {
  it("looks in dot-folders and other skipped folders (read-only) before uninstalling", () => {
    const files = {
      "package.json": pkg({ vue: "^3", vite: "^7", "@genclass/runtime": "^0.1.0" }),
      "index.html": VITE_HTML.replace("main.tsx", "main.js"),
      "src/main.js": VITE_MAIN,
    };
    const clean = project(files);
    expect(cli(clean, "init", "--yes", "--no-install").code).toBe(0);
    const r1 = cli(clean, "remove", "--dry-run");
    expect(r1.out).toContain("Uninstall");
    for (const extra of [".storybook/preview.ts", "tmp/demo.ts", "build/check.mjs"]) {
      const dir = project({ ...files, [extra]: `import { GenClass } from "@genclass/runtime";\nGenClass.init();\n` });
      expect(cli(dir, "init", "--yes", "--no-install").code).toBe(0);
      const r = cli(dir, "remove", "--dry-run");
      expect(r.code, r.out).toBe(0);
      expect(r.out).not.toContain("Uninstall");
      expect(r.out).toContain(`stays installed: still imported in ${extra}`);
      expect(readFileSync(join(dir, extra), "utf8")).toContain("@genclass/runtime");
    }
  });
});

describe("init only edits browser apps", () => {
  it("refuses a Node server or a library that merely lists a bundler", () => {
    const server = project({ "package.json": pkg({ express: "^5" }, { devDependencies: { esbuild: "^0.25" } }), "src/index.ts": `import express from "express";\nexpress().listen(3000);\n` });
    const snap = snapshot(server);
    const r = cli(server, "init", "--yes", "--no-install");
    expect(r.code).toBe(1);
    expect(r.out).toContain("nothing shows this is a browser app");
    expect(snapshot(server)).toEqual(snap);
    const lib = project({ "package.json": pkg({}, { peerDependencies: { react: ">=18" }, devDependencies: { rollup: "^4", react: "^19" } }), "src/index.ts": `export const Button = () => null;\n` });
    expect(cli(lib, "init", "--yes", "--no-install").code).toBe(1);
    expect(readFileSync(join(lib, "src/index.ts"), "utf8")).toBe(`export const Button = () => null;\n`);
  });

  it("refuses a server that serves an index.html (its entry imports express) and a library with react-dom in devDependencies", () => {
    const ssr = project({
      "package.json": pkg({ express: "^5", react: "^19", "react-dom": "^19" }, { devDependencies: { webpack: "^5" } }),
      "public/index.html": PAGE,
      "src/index.ts": `import express from "express";\nimport { renderToString } from "react-dom/server";\nexpress().use(express.static("public")).listen(3000);\n`,
    });
    const snap = snapshot(ssr);
    const r = cli(ssr, "init", "--yes", "--no-install");
    expect(r.code).toBe(1);
    expect(r.out).toContain(`src/index.ts imports "express", so it is Node code`);
    expect(snapshot(ssr)).toEqual(snap);
    const lib = project({
      "package.json": pkg({}, { exports: { ".": "./dist/index.js" }, peerDependencies: { react: ">=18", "react-dom": ">=18" }, devDependencies: { rollup: "^4", react: "^19", "react-dom": "^19" } }),
      "src/index.ts": `export { Button } from "./Button";\n`,
    });
    const r2 = cli(lib, "init", "--yes", "--no-install");
    expect(r2.code).toBe(1);
    expect(r2.out).toContain("looks like a library or a CLI (react is a peer dependency)");
    expect(readFileSync(join(lib, "src/index.ts"), "utf8")).toBe(`export { Button } from "./Button";\n`);
    expect(libraryEvidence({ module: "dist/x.js", devDependencies: { "react-dom": "^19" } })).toBe(`package.json has a "module" field`);
    expect(libraryEvidence({ main: "index.js", private: true })).toBeNull();
    expect(nodeOnlyImport(`import { readFile } from "node:fs/promises";`)).toBe("node:fs/promises");
    expect(nodeOnlyImport(`const http = require('http');`)).toBe("http");
    expect(nodeOnlyImport(`import { createRoot } from "react-dom/client";\nhistory.listen(() => {});`)).toBeNull();
  });

  it("accepts a bundler project with an index.html or a UI framework", () => {
    const withHtml = project({ "package.json": pkg({ esbuild: "^0.25" }), "public/index.html": PAGE, "src/index.ts": `console.log(1);\n` });
    expect(roundTrip(withHtml)["src/index.ts"].split("\n")[0]).toContain("@genclass/runtime/auto");
    const withReact = project({ "package.json": pkg({ rollup: "^4", "react-dom": "^19" }), "src/main.tsx": `console.log(1);\n` });
    expect(roundTrip(withReact)["src/main.tsx"].split("\n")[0]).toContain("@genclass/runtime/auto");
  });
});

describe("SRI on the script tag", () => {
  const pkgDir = () => project({ "dist/genclass.global.min.js": "min\n", "dist/genclass.global.js": "full\n" });
  it("only for exactly this version's file on jsDelivr / unpkg", () => {
    const d = pkgDir();
    const v = "1.2.3-beta.0";
    expect(integrityFor(`https://cdn.jsdelivr.net/npm/@genclass/runtime@${v}/dist/genclass.global.min.js`, d, v)).toMatch(/^sha384-/);
    expect(integrityFor(`https://unpkg.com/@genclass/runtime@${v}/dist/genclass.global.js`, d, v)).toMatch(/^sha384-/);
    for (const url of [
      `https://cdn.jsdelivr.net/npm/@genclass/runtime@latest/dist/genclass.global.min.js`,
      `https://cdn.jsdelivr.net/npm/@genclass/runtime@1.2.2/dist/genclass.global.min.js`,
      `https://cdn.jsdelivr.net/npm/@genclass/runtime/dist/genclass.global.min.js`,
      `https://static.example.test/genclass.global.min.js`,
      `https://cdn.jsdelivr.net/npm/@genclass/runtime@${v}/dist/genclass.global.min.js?x=1`,
    ]) {
      expect(integrityFor(url, d, v), url).toBeNull();
      expect(scriptTag({ cdn: url }, d, v)).not.toContain("integrity");
    }
    expect(scriptTag({}, d, v)).toContain(`integrity="sha384-`);
    expect(scriptTag({}, d, "latest")).not.toContain("integrity");
  });
  it("init --cdn with another URL writes no integrity attribute and says so", () => {
    const dir = project({ "index.html": PAGE });
    const r = cli(dir, "init", "--yes", "--cdn", "https://cdn.jsdelivr.net/npm/@genclass/runtime@latest/dist/genclass.global.min.js");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("No integrity (SRI) attribute");
    expect(readFileSync(join(dir, "index.html"), "utf8")).not.toContain("integrity=");
  });
});

describe("package.json", () => {
  it("typesVersions maps every subpath export with types (TypeScript moduleResolution node)", () => {
    const map = PKG_JSON.typesVersions?.["*"] ?? {};
    for (const [key, v] of Object.entries(PKG_JSON.exports)) {
      if (key === "." || typeof v !== "object" || !v.types) continue;
      expect(map[key.slice(2)], key).toEqual([v.types]);
    }
    expect(Object.keys(map).length).toBeGreaterThanOrEqual(8);
    for (const v of Object.values(PKG_JSON.exports)) if (typeof v === "object") for (const k of Object.keys(v)) expect(["types", "import"]).toContain(k);
  });
  it("sideEffects names the published model worker, and every source file the build imports for its side effects", () => {
    expect(PKG_JSON.sideEffects).toContain("./dist/worker.js");
    expect((PKG_JSON.exports["./worker"] as { import: string }).import).toBe("./dist/worker.js");
    for (const f of PKG_JSON.sideEffects) expect(/^\.\/(dist|src)\//.test(f), f).toBe(true);
    // esbuild applies this package.json while tsup builds it: a bare `import "../model/worker.js"` (src/cdn/worker.ts)
    // of a file missing here is dropped, and dist/cdn/worker.js would ship without the model worker
    const SRC = resolve(HERE, "..", "..", "src");
    const bare: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) for (const m of readFileSync(p, "utf8").matchAll(/^import\s+["'](\.[^"']+)["'];?\s*$/gm)) bare.push(`./${relative(resolve(SRC, ".."), resolve(dirname(p), m[1])).split("\\").join("/").replace(/\.js$/, ".ts")}`);
      }
    };
    walk(SRC);
    expect(bare).toContain("./src/model/worker.ts");
    for (const f of bare) expect(PKG_JSON.sideEffects, f).toContain(f);
  });
});
