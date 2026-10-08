// `genclass-runtime init|remove` on fixture projects (no network, no package manager: --no-install), plus the
// text-edit helpers and the page-config parser. The real-framework builds are in test/install/frameworks.sh (VM).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import { appendEnd, bodyTagEnd, codeStyle, insertTop, removeMarked, topOffset } from "../../bin/lib/edit.mjs";
import { assetBase } from "../../src/cdn/global.js";
import { devtoolsOptions, fromDataset, fromPairs, isKilled, isLocalHost, mergeConfig, parsePairs, readMetaConfig } from "../../src/cdn/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "..", "bin", "genclass-runtime.mjs");
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
    const wp = roundTrip(project({ "package.json": pkg({ webpack: "^5" }), "src/index.ts": `"use strict";\nconsole.log(1);\n` }));
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
    for (const t of ["a\nb\n", "a\nb", "a\r\nb\r\n", "a\r\nb", ""]) {
      const added = appendEnd(insertTop(t, ["x // genclass:init"]), ["y // genclass:init"]);
      expect(removeMarked(added)).toBe(t);
    }
  });
  it("removeMarked drops blocks and inline forms", () => {
    expect(removeMarked(`// genclass:init start\na\nb\n// genclass:init end\nkeep\n`)).toBe(`keep\n`);
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
