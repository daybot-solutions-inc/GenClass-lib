// What `genclass-runtime init` changes in each kind of project. Pure: reads files, returns the changes
// ({ file, rel, kind: "create" | "modify", before, after }) without writing anything.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { firstFile, htmlFiles, htmlModuleEntry, isDir, isFile, readText, walkSources, withExts } from "./detect.mjs";
import { AUTO, MARK, MARK_INLINE, appendEnd, bodyTagEnd, codeStyle, indentOf, indentUnit, insertLineAt, insertTop, lineIndexAt, linesOf } from "./edit.mjs";

export { AUTO };
const HEADER = `${MARK} start: GenClass Runtime, added by \`npx @genclass/runtime init\` (\`npx @genclass/runtime remove\` takes it out)`;
const mark = (line) => `${line} // ${MARK}`;
const posix = (p) => p.split(sep).join("/");

/** Relative module specifier from a file to another file, without extension ("./genclass-init"). */
function specifier(fromFile, toFile) {
  let r = posix(relative(dirname(fromFile), toFile)).replace(/\.[cm]?[jt]sx?$/, "");
  if (!r.startsWith(".")) r = `./${r}`;
  return r;
}

const DEV = {
  vite: "import.meta.env.DEV",
  nuxt: "import.meta.dev",
  node: 'process.env.NODE_ENV === "development"',
};

/** The two snippets every JS entry gets: the auto import (top) and the dev-only overlay (end). */
function snippets(style, { mode, devtools, devCond }) {
  const { q, semi } = style;
  const auto = AUTO(mode);
  return {
    top: devtools ? `import genclass from ${q}${auto}${q}${semi}` : `import ${q}${auto}${q}${semi}`,
    dev: devtools ? `if (${devCond}) import(${q}@genclass/runtime/devtools${q}).then((d) => d.mountDevtools(genclass))${semi}` : null,
  };
}

/** Adds the auto import as the first statement and the dev-only overlay line at the end of an existing file. */
function editEntry(file, opts, extraTop = []) {
  const before = readText(file) ?? "";
  const style = codeStyle(before);
  const s = snippets(style, opts);
  let after = insertTop(before, [s.top, ...(s.dev ? extraTop.map((l) => l(style)) : [])].map(mark));
  if (s.dev) after = appendEnd(after, [mark(s.dev)]);
  return { file, kind: "modify", before, after };
}

/** A new file holding one marked block. */
function createFile(file, body, eol = "\n") {
  const lines = [`// ${HEADER}`, ...body, `// ${MARK} end`];
  return { file, kind: "create", before: "", after: lines.join(eol) + eol };
}

const DQ = { q: '"', semi: ";" };

// -------------------------------------------------------------------------------------------- frameworks

function planVite(p, o) {
  const notes = [];
  let entry = null;
  const html = firstFile(p.dir, ["index.html"]);
  if (html) {
    const src = htmlModuleEntry(readText(html) ?? "");
    if (src) {
      const clean = src.split(/[?#]/)[0];
      const candidate = clean.startsWith("/") ? join(p.dir, clean) : join(dirname(html), clean);
      if (isFile(candidate)) entry = candidate;
    }
  }
  entry ??= firstFile(p.dir, [...withExts("src/main"), ...withExts("src/index")]);
  if (!entry) return { changes: [], manual: "no entry file found (looked at index.html's module script, src/main.*, src/index.*)" };
  return { entry, changes: [editEntry(entry, { ...o, devCond: DEV.vite })], notes };
}

function planCra(p, o) {
  const entry = firstFile(p.dir, withExts("src/index"));
  if (!entry) return { changes: [], manual: "no src/index.* found" };
  return { entry, changes: [editEntry(entry, { ...o, devCond: DEV.node })] };
}

// Modules only Node code imports: a server framework, Node's built-ins, server-side rendering.
const NODE_IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])(node:[\w/]+|express|fastify|koa|@hapi\/hapi|@nestjs\/core|restify|polka|http|https|http2|net|tls|dgram|fs|fs\/promises|child_process|cluster|worker_threads|react-dom\/server|vue\/server-renderer)\1/m;

/** The Node-only module a file imports (it is a server or tool entry, not a browser entry), or null. */
export function nodeOnlyImport(text) {
  const m = NODE_IMPORT_RE.exec(text ?? "");
  return m ? m[2] : null;
}

function planWebpack(p, o) {
  const entry = firstFile(p.dir, [...withExts("src/main"), ...withExts("src/index"), ...withExts("src/app"), ...withExts("index")]);
  if (!entry) return { changes: [], manual: "no entry file found (src/main.*, src/index.*, index.*)" };
  // a bundler project with a page can still be a server (express serving public/index.html): never edit its entry
  const nodeOnly = nodeOnlyImport(readText(entry));
  if (nodeOnly) return { changes: [], manual: `${posix(relative(p.dir, entry))} imports "${nodeOnly}", so it is Node code (a server?), not the browser entry` };
  // webpack, rspack/rsbuild and parcel replace process.env.NODE_ENV; other bundlers may not define `process`
  const knowsNodeEnv = ["webpack", "@rspack/core", "@rsbuild/core", "parcel"].includes(p.details.bundler);
  const devtools = o.devtools && knowsNodeEnv;
  return {
    entry,
    changes: [editEntry(entry, { ...o, devtools, devCond: DEV.node })],
    notes: o.devtools && !knowsNodeEnv ? ["The devtools overlay was not added (unknown way to tell development builds). See the README's devtools snippet."] : [],
  };
}

function planAngular(p, o) {
  const entry = firstFile(p.dir, ["src/main.ts", "src/main.js"]);
  if (!entry) return { changes: [], manual: "no src/main.ts found" };
  const devImport = (st) => `import { isDevMode as genclassDevMode } from ${st.q}@angular/core${st.q}${st.semi}`;
  return { entry, changes: [editEntry(entry, { ...o, devCond: "genclassDevMode()" }, [devImport])] };
}

function planSvelteKit(p, o) {
  const existing = firstFile(p.dir, ["src/hooks.client.ts", "src/hooks.client.js"]);
  if (existing) return { entry: existing, changes: [editEntry(existing, { ...o, devCond: DEV.vite })] };
  const file = join(p.dir, "src", `hooks.client.${p.ts ? "ts" : "js"}`);
  const s = snippets(DQ, { ...o, devCond: DEV.vite });
  return { entry: file, changes: [createFile(file, [s.top, ...(s.dev ? [s.dev] : [])])] };
}

function planNuxt(p, o) {
  const pluginsDir = join(p.details.srcDir, "plugins");
  const file = join(pluginsDir, `genclass.client.${p.ts || isFile(join(p.dir, "tsconfig.json")) ? "ts" : "js"}`);
  if (isFile(file)) return { changes: [], manual: `${posix(relative(p.dir, file))} already exists` };
  const s = snippets(DQ, { ...o, devCond: DEV.nuxt });
  const body = s.dev
    ? [s.top, "", "export default defineNuxtPlugin(() => {", `  ${s.dev}`, "});"]
    : [s.top, "", "export default defineNuxtPlugin(() => {});"];
  return { entry: file, changes: [createFile(file, body)] };
}

function planRemix(p, o) {
  const app = join(p.dir, "app");
  const devCond = p.details.vite ? DEV.vite : DEV.node;
  const client = firstFile(app, withExts("entry.client", ["tsx", "jsx", "ts", "js"]));
  if (client) return { entry: client, changes: [editEntry(client, { ...o, devCond })] };
  const root = firstFile(app, withExts("root", ["tsx", "jsx", "ts", "js"]));
  if (!root) return { changes: [], manual: "no app/entry.client.* or app/root.* found" };
  // root runs on the server too: the auto entry is inert there; the overlay only loads in the browser
  return { entry: root, changes: [editEntry(root, { ...o, devCond: `${devCond} && typeof window !== "undefined"` })] };
}

function planNext(p, o) {
  const { srcDir, appDir, pagesDir, version } = p.details;
  const ext = p.ts ? "ts" : "js";
  const jsx = p.ts ? "tsx" : "jsx";
  const modern = !version || version.major > 15 || (version.major === 15 && version.minor >= 3);
  const strategy = o.strategy || (modern ? "instrumentation" : appDir ? "layout" : "pages");
  const s = snippets(DQ, { ...o, devCond: DEV.node });

  if (strategy === "instrumentation") {
    // Next.js >= 15.3 runs instrumentation-client before the app's own code, in the browser only.
    const existing = firstFile(srcDir, withExts("instrumentation-client", ["ts", "js", "mts", "mjs"]));
    if (existing) return { entry: existing, changes: [editEntry(existing, { ...o, devCond: DEV.node })] };
    const file = join(srcDir, `instrumentation-client.${ext}`);
    const body = s.dev ? [s.top, "", `if (process.env.NODE_ENV === "development") {`, `  import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));`, "}"] : [s.top];
    return { entry: file, changes: [createFile(file, body)] };
  }

  if (strategy === "layout") {
    if (!appDir) return { changes: [], manual: "no app/ directory" };
    const layout = firstFile(appDir, withExts("layout", ["tsx", "jsx", "js", "ts"]));
    if (!layout) return { changes: [], manual: "no app/layout.* found" };
    const comp = join(appDir, `genclass-init.${jsx}`);
    const body = [
      '"use client";',
      "",
      "// Starts GenClass Runtime when this module loads in the browser (on the server it is inert).",
      s.top,
      "",
      ...(s.dev ? [`if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {`, `  import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));`, "}", ""] : []),
      "export function GenClassInit() {",
      "  return null;",
      "}",
    ];
    const created = createFile(comp, body);
    const before = readText(layout) ?? "";
    const st = codeStyle(before);
    let after = insertTop(before, [mark(`import { GenClassInit } from ${st.q}${specifier(layout, comp)}${st.q}${st.semi}`)]);
    const pos = bodyTagEnd(after);
    if (pos < 0) return { changes: [], manual: `no <body> element found in ${posix(relative(p.dir, layout))}` };
    const li = lineIndexAt(after, pos);
    const lines = linesOf(after);
    const rest = lines[li].slice(pos - after.lastIndexOf("\n", pos - 1) - 1);
    if (rest.trim() === "") {
      const next = lines.slice(li + 1).find((l) => l.trim() !== "");
      const indent = next !== undefined && indentOf(next).length > indentOf(lines[li]).length ? indentOf(next) : indentOf(lines[li]) + indentUnit(after);
      after = insertLineAt(after, li + 1, `${indent}<GenClassInit /> {/* ${MARK} */}`);
    } else {
      after = after.slice(0, pos) + `<GenClassInit />{/* ${MARK_INLINE} */}` + after.slice(pos);
    }
    return { entry: layout, changes: [created, { file: layout, kind: "modify", before, after }] };
  }

  // pages router before 15.3: pages/_app
  const dir = pagesDir ?? join(srcDir, "pages");
  const existing = firstFile(dir, withExts("_app", ["tsx", "jsx", "js", "ts"]));
  const devCond = `${DEV.node} && typeof window !== "undefined"`;
  if (existing) return { entry: existing, changes: [editEntry(existing, { ...o, devCond })] };
  const file = join(dir, `_app.${jsx}`);
  const sd = snippets(DQ, { ...o, devCond });
  const body = [
    ...(p.ts ? ['import type { AppProps } from "next/app";'] : []),
    sd.top,
    "",
    ...(sd.dev ? [sd.dev, ""] : []),
    `export default function App({ Component, pageProps }${p.ts ? ": AppProps" : ""}) {`,
    "  return <Component {...pageProps} />;",
    "}",
  ];
  return { entry: file, changes: [createFile(file, body)] };
}

function planAstro(p, o) {
  const files = walkSources(join(p.dir, "src")).filter((f) => f.endsWith(".astro"));
  const withHead = (dirName) => files.filter((f) => posix(relative(join(p.dir, "src"), f)).startsWith(`${dirName}/`) && /<\/head>/i.test(readText(f) ?? ""));
  let targets = withHead("layouts");
  if (!targets.length) targets = withHead("pages");
  if (!targets.length) return { changes: [], manual: "no layout or page with a <head> found under src/" };
  const changes = [];
  for (const f of targets) {
    const before = readText(f) ?? "";
    const s = snippets(DQ, { ...o, devCond: DEV.vite });
    const code = s.dev ? `${s.top} ${s.dev}` : s.top;
    const lines = linesOf(before);
    const li = lines.findIndex((l) => /<\/head>/i.test(l));
    let after;
    if (/^\s*<\/head>/i.test(lines[li])) {
      const indent = indentOf(lines[li]) + indentUnit(before);
      after = insertLineAt(before, li, `${indent}<script>${code} // ${MARK}</script>`);
    } else {
      const at = before.search(/<\/head>/i);
      after = before.slice(0, at) + `<script>${code} // ${MARK_INLINE}</script>` + before.slice(at);
    }
    changes.push({ file: f, kind: "modify", before, after });
  }
  return { entry: targets[0], changes };
}

export const cdnUrl = (version, min = true) => `https://cdn.jsdelivr.net/npm/@genclass/runtime@${version}/dist/genclass.global${min ? ".min" : ""}.js`;
const unpkgUrl = (version, min) => `https://unpkg.com/@genclass/runtime@${version}/dist/genclass.global${min ? ".min" : ""}.js`;

/**
 * SRI for the script URL, only when the URL is exactly this version's file on jsDelivr or unpkg, whose bytes are the
 * CLI's own copy. Any other URL (another version, @latest, no version, a mirror, a self-hosted copy) may serve
 * different bytes, and a wrong hash makes the browser refuse the script: no integrity attribute then.
 */
export function integrityFor(url, pkgDir, version) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(String(version))) return null;
  const min = [true, false].find((m) => url === cdnUrl(version, m) || url === unpkgUrl(version, m));
  if (min === undefined) return null;
  try {
    const buf = readFileSync(join(pkgDir, "dist", `genclass.global${min ? ".min" : ""}.js`));
    return `sha384-${createHash("sha384").update(buf).digest("base64")}`;
  } catch {
    return null;
  }
}

export function scriptTag(o, pkgDir, version) {
  const url = o.cdn || cdnUrl(version);
  const sri = o.sri === false ? null : integrityFor(url, pkgDir, version);
  const attrs = [`src="${url}"`];
  if (sri) attrs.push(`integrity="${sri}"`, 'crossorigin="anonymous"');
  // no data-mode: observe, the runtime's default
  if (o.mode) attrs.push(`data-mode="${o.mode}"`);
  if (o.devtools) attrs.push('data-devtools="local"');
  return `<script ${attrs.join(" ")}></script>`;
}

function planHtml(p, o, ctx) {
  const files = htmlFiles(p.dir);
  if (!files.length) return { changes: [], manual: "no .html file with a <head> in this directory" };
  const tag = scriptTag(o, ctx.pkgDir, ctx.version);
  const changes = [];
  for (const f of files) {
    const before = readText(f) ?? "";
    const lines = linesOf(before);
    const li = lines.findIndex((l) => /<head[\s>]/i.test(l));
    const line = lines[li];
    let after;
    if (/<\/head>/i.test(line)) {
      // a one-line head: put the tag right after <head ...>
      const m = /<head[^>]*>/i.exec(before);
      const at = m.index + m[0].length;
      after = before.slice(0, at) + `${tag}<!-- ${MARK_INLINE} -->` + before.slice(at);
    } else {
      const next = lines.slice(li + 1).find((l) => l.trim() !== "");
      const indent = next !== undefined ? indentOf(next) : indentOf(line) + indentUnit(before);
      after = insertLineAt(before, li + 1, `${indent}${tag} <!-- ${MARK} -->`);
    }
    changes.push({ file: f, kind: "modify", before, after });
  }
  const notes = [];
  if (o.sri !== false && !/ integrity="/.test(tag)) {
    notes.push(
      o.cdn
        ? `No integrity (SRI) attribute: --cdn is not ${cdnUrl(ctx.version)}, so the CLI cannot know the bytes it serves. Pin a version and add the hash yourself if you want one.`
        : `No integrity (SRI) attribute: this copy of the CLI has no built dist/genclass.global.min.js to hash.`,
    );
  }
  return { entry: files[0], changes, notes };
}

const PLANNERS = {
  vite: planVite,
  cra: planCra,
  webpack: planWebpack,
  angular: planAngular,
  sveltekit: planSvelteKit,
  nuxt: planNuxt,
  remix: planRemix,
  "react-router": planRemix,
  next: planNext,
  astro: planAstro,
  html: planHtml,
};

/** { entry?, changes, notes?, manual? } for the detected project. */
export function planInit(project, opts, ctx) {
  const planner = PLANNERS[project.framework];
  if (!planner) return { changes: [], manual: "the project type was not recognised" };
  const r = planner(project, opts, ctx);
  for (const ch of r.changes) ch.rel = posix(relative(project.dir, ch.file));
  return r;
}
