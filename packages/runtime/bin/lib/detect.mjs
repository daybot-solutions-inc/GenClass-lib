// Project detection for `genclass-runtime init`: package manager, framework, TypeScript, entry files, state
// libraries. Reads files only.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const readText = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
export const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
export const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
export const readJson = (p) => {
  const t = readText(p);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

/** First existing file among candidates (relative to dir), as an absolute path, or null. */
export function firstFile(dir, candidates) {
  for (const c of candidates) {
    const p = join(dir, c);
    if (isFile(p)) return p;
  }
  return null;
}

const JS_EXT = ["tsx", "ts", "jsx", "js", "mts", "mjs"];
export const withExts = (base, exts = JS_EXT) => exts.map((e) => `${base}.${e}`);

// ------------------------------------------------------------------------------------------- walker

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", "dist", "build", "out", ".next", ".nuxt", ".output", ".svelte-kit", ".astro", ".vercel",
  ".netlify", "coverage", ".turbo", ".cache", ".parcel-cache", ".angular", ".vite", ".react-router", ".remix", "storybook-static",
  ".idea", ".vscode", "tmp", ".tmp",
]);
const SRC_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?)$/;

/** Source files under dir (skipping build output and dependencies), at most `max`. */
export function walkSources(dir, max = 20000) {
  const outFiles = [];
  const stack = [[dir, 0]];
  while (stack.length && outFiles.length < max) {
    const [d, depth] = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && depth < 10 && !e.name.startsWith(".")) stack.push([join(d, e.name), depth + 1]);
      } else if (e.isFile() && SRC_EXT.test(e.name)) {
        const p = join(d, e.name);
        try {
          if (statSync(p).size <= 1_000_000) outFiles.push(p);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return outFiles.sort();
}

// Generated or third-party directories even the full scan below skips: dependencies, version control and the
// frameworks' own caches (they are rebuilt from the sources).
const NEVER_SCAN = new Set([
  "node_modules", ".git", ".hg", ".svn", ".next", ".nuxt", ".output", ".svelte-kit", ".astro", ".vercel", ".netlify",
  ".turbo", ".cache", ".parcel-cache", ".angular", ".vite", ".react-router", ".remix", "coverage",
]);

/**
 * Source files walkSources leaves out (dot-directories such as .storybook, tmp, out, build, dist, deeper than 10
 * levels), read-only: `remove` checks them for imports before it uninstalls the package.
 */
export function walkSkipped(dir, max = 20000) {
  const seen = new Set(walkSources(dir));
  const outFiles = [];
  const stack = [[dir, 0]];
  while (stack.length && outFiles.length < max) {
    const [d, depth] = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!NEVER_SCAN.has(e.name) && depth < 30) stack.push([join(d, e.name), depth + 1]);
      } else if (e.isFile() && SRC_EXT.test(e.name)) {
        const p = join(d, e.name);
        if (seen.has(p)) continue;
        try {
          if (statSync(p).size <= 1_000_000) outFiles.push(p);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return outFiles.sort();
}

// -------------------------------------------------------------------------------------- package manager

/** npm | pnpm | yarn | bun, from lockfiles (this directory and its parents), packageManager, or the user agent. */
export function detectPackageManager(cwd, pkg) {
  let d = resolve(cwd);
  for (;;) {
    if (isFile(join(d, "pnpm-lock.yaml"))) return "pnpm";
    if (isFile(join(d, "bun.lockb")) || isFile(join(d, "bun.lock"))) return "bun";
    if (isFile(join(d, "yarn.lock"))) return "yarn";
    if (isFile(join(d, "package-lock.json")) || isFile(join(d, "npm-shrinkwrap.json"))) return "npm";
    if (isDir(join(d, ".git"))) break;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  const pmField = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
  if (["npm", "pnpm", "yarn", "bun"].includes(pmField)) return pmField;
  const ua = process.env.npm_config_user_agent || "";
  for (const pm of ["pnpm", "yarn", "bun"]) if (ua.startsWith(`${pm}/`)) return pm;
  return "npm";
}

// -------------------------------------------------------------------------------------------- versions

/** Major/minor of an installed package (node_modules) or of the declared range; null when unknown. */
export function versionOf(cwd, name, declared) {
  const installed = readJson(join(cwd, "node_modules", name, "package.json"))?.version;
  const v = installed || declared || "";
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v)) ?? /(\d+)/.exec(String(v));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), raw: v };
}

// --------------------------------------------------------------------------------------------- framework

const VITE_FLAVORS = [
  ["@sveltejs/vite-plugin-svelte", "Svelte"],
  ["vite-plugin-solid", "Solid"],
  ["@preact/preset-vite", "Preact"],
  ["@vitejs/plugin-vue", "Vue"],
  ["@vitejs/plugin-react", "React"],
  ["@vitejs/plugin-react-swc", "React"],
  ["lit", "Lit"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["solid-js", "Solid"],
  ["preact", "Preact"],
  ["react", "React"],
];

/** The module script of an index.html (Vite's entry): `<script type="module" src="/src/main.tsx">`. */
export function htmlModuleEntry(html) {
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (!/\btype\s*=\s*["']?module/i.test(attrs)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (src && !/^(https?:)?\/\//.test(src[1])) return src[1];
  }
  return null;
}

/**
 * {
 *   dir, pkg, deps, pm, ts, name,
 *   framework: "next" | "nuxt" | "sveltekit" | "astro" | "angular" | "remix" | "react-router" | "cra" | "vite" | "webpack" | "html" | null,
 *   label, details: {...},
 *   refused?: why init will not edit this project (a bundler but no sign of a browser app)
 * }
 */
export function detectProject(cwd) {
  const dir = resolve(cwd);
  const pkg = readJson(join(dir, "package.json"));
  const deps = { ...(pkg?.peerDependencies ?? {}), ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) };
  const has = (n) => Object.prototype.hasOwnProperty.call(deps, n);
  const ts = isFile(join(dir, "tsconfig.json")) || has("typescript");
  const pm = pkg ? detectPackageManager(dir, pkg) : null;
  const p = { dir, pkg, deps, has, pm, ts, name: pkg?.name || dir.split(sep).pop(), framework: null, label: "", details: {} };

  if (!pkg) {
    if (htmlFiles(dir).length) return { ...p, framework: "html", label: "Plain HTML (no bundler)" };
    return p;
  }
  if (has("next")) {
    const srcDir = isDir(join(dir, "src", "app")) || isDir(join(dir, "src", "pages")) ? join(dir, "src") : dir;
    const appDir = isDir(join(srcDir, "app")) ? join(srcDir, "app") : null;
    const pagesDir = isDir(join(srcDir, "pages")) ? join(srcDir, "pages") : null;
    const v = versionOf(dir, "next", deps.next);
    const router = appDir ? "app" : "pages";
    return { ...p, framework: "next", label: `Next.js${v ? ` ${v.major}` : ""} (${router === "app" ? "App Router" : "Pages Router"})`, details: { srcDir, appDir, pagesDir, router, version: v } };
  }
  if (has("nuxt") || has("nuxt3")) {
    const v = versionOf(dir, "nuxt", deps.nuxt);
    const srcDir = isFile(join(dir, "app", "app.vue")) || (v && v.major >= 4 && isDir(join(dir, "app"))) ? join(dir, "app") : dir;
    return { ...p, framework: "nuxt", label: `Nuxt${v ? ` ${v.major}` : ""}`, details: { srcDir, version: v } };
  }
  if (has("@sveltejs/kit")) return { ...p, framework: "sveltekit", label: "SvelteKit" };
  if (has("astro")) return { ...p, framework: "astro", label: "Astro" };
  if (has("@angular/core")) return { ...p, framework: "angular", label: "Angular" };
  if (has("@react-router/dev")) return { ...p, framework: "react-router", label: "React Router (framework mode)", details: { vite: true } };
  if (has("@remix-run/dev") || has("@remix-run/react")) {
    const vite = has("vite") || !!firstFile(dir, withExts("vite.config", ["ts", "js", "mts", "mjs"]));
    return { ...p, framework: "remix", label: `Remix${vite ? " (Vite)" : ""}`, details: { vite } };
  }
  if (has("react-scripts")) return { ...p, framework: "cra", label: "Create React App" };
  if (has("vite") || firstFile(dir, withExts("vite.config", ["ts", "js", "mts", "mjs", "cts", "cjs"]))) {
    const flavor = VITE_FLAVORS.find(([n]) => has(n))?.[1] ?? "vanilla";
    return { ...p, framework: "vite", label: `Vite + ${flavor}`, details: { flavor } };
  }
  const bundler = ["webpack", "@rspack/core", "@rsbuild/core", "parcel", "esbuild", "rollup"].find((n) => has(n));
  if (bundler) {
    // a bundler alone does not make a browser app: Node servers, CLIs and libraries use them too
    const lib = libraryEvidence(pkg);
    if (lib) {
      return {
        ...p,
        refused:
          `${bundler} is a dependency, but this looks like a library or a CLI (${lib}), not an app: GenClass would start in ` +
          `every app that imports it. init only edits apps; run it in the app that uses this package`,
      };
    }
    const evidence = browserEvidence(dir, pkg);
    if (evidence) return { ...p, framework: "webpack", label: `${bundler} project`, details: { bundler, evidence } };
    return {
      ...p,
      refused:
        `${bundler} is a dependency, but nothing shows this is a browser app (no index.html in the project, src/ or public/, ` +
        `no UI framework such as react-dom or vue in dependencies, no HTML plugin or dev server). GenClass Runtime runs in the ` +
        `browser, so init does not edit a Node server's or a library's entry file`,
    };
  }
  if (htmlFiles(dir).length) return { ...p, framework: "html", label: "Plain HTML (no bundler)" };
  return p;
}

// UI libraries and browser-app tooling. Counted only from dependencies/devDependencies, not peerDependencies (a
// component library lists its framework as a peer).
const BROWSER_DEPS = [
  "react-dom", "vue", "svelte", "preact", "solid-js", "lit", "@angular/core", "jquery", "alpinejs", "@hotwired/turbo",
  "@hotwired/stimulus", "html-webpack-plugin", "webpack-dev-server", "@rsbuild/core", "@rspack/dev-server",
  "@web/dev-server", "esbuild-plugin-html", "@rollup/plugin-html", "rollup-plugin-serve", "rollup-plugin-livereload",
];

// UI frameworks a component library lists as peer dependencies.
const UI_PEERS = ["react", "react-dom", "vue", "svelte", "preact", "solid-js", "lit", "@angular/core"];

/**
 * Why a bundler project's package.json looks like a published library or a CLI, or null: a UI framework as a peer
 * dependency, or the fields packages publish ("exports", "module", "types", "bin"). Apps have none of them ("main"
 * alone is npm init's default, so it does not count).
 */
export function libraryEvidence(pkg) {
  const peer = UI_PEERS.find((n) => Object.prototype.hasOwnProperty.call(pkg?.peerDependencies ?? {}, n));
  if (peer) return `${peer} is a peer dependency`;
  const field = ["exports", "module", "types", "typings", "bin"].find((f) => pkg?.[f] !== undefined);
  return field ? `package.json has a "${field}" field` : null;
}

/** Why a bundler project looks like a browser app ("index.html", "react-dom", ...), or null. */
export function browserEvidence(dir, pkg) {
  for (const f of ["index.html", "src/index.html", "public/index.html"]) if (isFile(join(dir, f))) return f;
  const own = { ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) };
  const dep = BROWSER_DEPS.find((n) => Object.prototype.hasOwnProperty.call(own, n));
  if (dep) return dep;
  // Parcel apps name their HTML entry: "source": "src/index.html"
  const sources = [pkg?.source].flat().filter((x) => typeof x === "string");
  if (sources.some((x) => /\.html?$/i.test(x))) return "package.json source (HTML)";
  if (htmlFiles(dir).length) return "an .html page";
  return null;
}

/** Top-level .html files with a <head> (plain sites). */
export function htmlFiles(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => /\.html?$/i.test(n)).sort();
  } catch {
    return [];
  }
  return names.map((n) => join(dir, n)).filter((f) => /<head[\s>]/i.test(readText(f) ?? ""));
}

// ------------------------------------------------------------------------------------------- state usage

/** Redux / Zustand / React state and other stores, for the adapter recommendations. */
export function detectState(project, files) {
  const found = { redux: null, zustand: null, useState: 0, useStateFiles: 0, others: [] };
  const rel = (f) => relative(project.dir, f).split(sep).join("/");
  for (const f of files) {
    if (!/\.[cm]?[jt]sx?$|\.vue$|\.svelte$/.test(f)) continue;
    const t = readText(f) ?? "";
    if (!found.redux && /from\s+['"](@reduxjs\/toolkit|redux)['"]/.test(t)) {
      if (/\bconfigureStore\s*\(/.test(t)) found.redux = { file: rel(f), kind: "toolkit" };
      else if (/\b(?:legacy_)?createStore\s*\(/.test(t)) found.redux = { file: rel(f), kind: "createStore" };
    }
    if (!found.zustand && /from\s+['"]zustand(?:\/[a-z]+)?['"]/.test(t) && /\bcreate(?:Store)?\s*(?:<[^>]*>)?\s*\(/.test(t)) found.zustand = { file: rel(f) };
    const n = (t.match(/\buseState\s*(?:<[^>]*>)?\s*\(/g) ?? []).length;
    if (n) {
      found.useState += n;
      found.useStateFiles++;
    }
  }
  const h = project.has ?? (() => false);
  for (const [dep, label] of [["pinia", "Pinia"], ["vuex", "Vuex"], ["mobx", "MobX"], ["jotai", "Jotai"], ["valtio", "Valtio"], ["@ngrx/store", "NgRx"], ["recoil", "Recoil"], ["xstate", "XState"]]) {
    if (h(dep)) found.others.push(label);
  }
  return found;
}
