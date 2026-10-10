// `genclass-runtime init` and `genclass-runtime remove` (also `npx @genclass/runtime init|remove`).
//
// init: detects the project, installs @genclass/runtime, adds the auto import as the first statement of the entry
// file (plus a dev-only devtools line), shows the diff and asks before writing. Every added line or created file
// carries the marker `genclass:init`, so `remove` can take out exactly that and nothing else (and refuses when a
// marked line or block was edited). Running init twice changes nothing; running it again with another --mode
// switches the marked import (or the script tag's data-mode) to that mode in place.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCsp, detectProject, detectState, htmlFiles, isDir, isFile, readText, walkSkipped, walkSources } from "./detect.mjs";
import { MARK, hasMarker, isEmptyConfig, planRemoval, removeMarked, switchMetaConfig, switchMode, switchTagConfig, updateConfigText } from "./edit.mjs";
import { AUTO, configFileChange, configFileFor, planInit, scriptTag } from "./plan.mjs";
import { LOCAL_FILE, START_URL, TOKEN_RE, createProject, readLocal, saveLocal, tokenInFiles } from "./token.mjs";
import { banner, c, confirm, err, out, printChange, row, sym } from "./ui.mjs";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")).version;
  } catch {
    return "latest";
  }
})();
const CMD = "npx @genclass/runtime";
const PKG = "@genclass/runtime";
const MODES = ["observe", "guard", "heal"];

const REPO = "https://github.com/daybot-solutions-inc/GenClass-lib/blob/main";
export const TELEMETRY_URL = `${REPO}/packages/runtime/TELEMETRY.md`;
export const PRIVACY_URL = `${REPO}/PRIVACY.md`;

export const USAGE = `Usage:
  genclass-runtime init   [--mode observe|guard|heal] [--token <gc_...> | --no-token]
                          [--no-telemetry | --telemetry] [--model-url <url>]
                          [--yes] [--dry-run] [--no-install] [--no-devtools] [--cwd <dir>]
  genclass-runtime remove [--yes] [--dry-run] [--keep-package] [--cwd <dir>]

init     finds your framework, installs ${PKG}, adds one import to your entry file (and a dev-only devtools
         line), shows the diff and asks before writing. Running it again changes nothing; with another
         --mode it switches the import init added to that mode.
remove   takes out exactly what init added (the lines and blocks marked "${MARK}"; it changes nothing if
         one of them was edited) and uninstalls the package if nothing else imports it.

  --mode <m>       observe (default: reports, never changes anything), guard or heal
  --token <gc_...> use this app token (no network). By default init creates one for this app at
                   genclass.dev (named after package.json's name), writes it into what it adds, and
                   saves the token and your private dashboard link in ${LOCAL_FILE}
  --no-token       no token, no network (no dashboard; you can add one later: ${START_URL})
  --no-telemetry   turn off GenClass's anonymous diagnostics (on by default; see TELEMETRY.md and
                   PRIVACY.md). Written as an option file (genclass.config.ts/js, imported right before
                   the auto import), or data-telemetry="off" on a plain HTML script tag. Implies
                   --no-token (a dashboard only gets data while telemetry is on)
  --telemetry      keep them on, written explicitly (on an existing setup: undoes --no-telemetry)
  --model-url <u>  use a self-hosted model directory (made with \`fetch-model\`), e.g. /genclass-model/,
                   with ONNX Runtime from <u>ort/ (for a Content-Security-Policy without cdn.jsdelivr.net)
  --yes, -y        apply without asking
  --dry-run        show what would change; write nothing
  --no-install     do not run the package manager
  --no-devtools    do not add the dev-only devtools overlay
  --keep-package   remove: leave ${PKG} installed
  --cwd <dir>      the project directory (default: the current directory)
  --from <spec>    install ${PKG} from this spec (a version, tag or tarball path)
  --cdn <url>      plain HTML: the script URL (default: jsDelivr, this version, with an SRI hash; other
                   URLs get no hash)
  --no-sri         plain HTML: no integrity attribute`;

class UsageError extends Error {}

const BOOL = {
  yes: "yes",
  y: "yes",
  "dry-run": "dryRun",
  "no-install": "noInstall",
  "no-devtools": "noDevtools",
  "keep-package": "keepPackage",
  "no-sri": "noSri",
  "no-telemetry": "noTelemetry",
  telemetry: "telemetry",
  "no-token": "noToken",
  help: "help",
  h: "help",
};
const VALUE = { mode: "mode", from: "from", cdn: "cdn", cwd: "cwd", strategy: "strategy", "model-url": "modelUrl", token: "token" };

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) throw new UsageError(`unexpected argument ${a}`);
    const eq = a.indexOf("=");
    const key = (eq > 0 ? a.slice(0, eq) : a).replace(/^--?/, "");
    if (BOOL[key]) {
      o[BOOL[key]] = true;
      continue;
    }
    if (VALUE[key]) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`--${key} needs a value`);
      o[VALUE[key]] = v;
      continue;
    }
    throw new UsageError(`unknown option ${a}`);
  }
  if (o.mode && !MODES.includes(o.mode)) throw new UsageError(`--mode must be observe, guard or heal`);
  if (o.noTelemetry && o.telemetry) throw new UsageError(`--telemetry and --no-telemetry contradict each other`);
  if (o.token !== undefined && o.noToken) throw new UsageError(`--token and --no-token contradict each other`);
  if (o.token !== undefined && o.noTelemetry) throw new UsageError(`--no-telemetry means no token (a dashboard only gets data while telemetry is on): drop --token`);
  if (o.token !== undefined && !TOKEN_RE.test(o.token)) throw new UsageError(`--token must be "gc_" followed by 22 letters or digits (get one: ${START_URL})`);
  if (o.strategy && !["instrumentation", "layout", "pages"].includes(o.strategy)) throw new UsageError(`--strategy must be instrumentation, layout or pages`);
  return o;
}

// ------------------------------------------------------------------------------------- package manager

const runCmd = (pm, script) => (pm === "npm" ? `npm run ${script}` : pm === "yarn" ? `yarn ${script}` : `${pm} run ${script}`);

function installArgs(pm, spec) {
  if (pm === "pnpm") return ["pnpm", ["add", spec]];
  if (pm === "yarn") return ["yarn", ["add", spec]];
  if (pm === "bun") return ["bun", ["add", spec]];
  return ["npm", ["install", spec, "--no-audit", "--no-fund"]];
}

function uninstallArgs(pm) {
  if (pm === "pnpm") return ["pnpm", ["remove", PKG]];
  if (pm === "yarn") return ["yarn", ["remove", PKG]];
  if (pm === "bun") return ["bun", ["remove", PKG]];
  return ["npm", ["uninstall", PKG, "--no-audit", "--no-fund"]];
}

function spawn(cmd, args, cwd) {
  out(`  ${c.gray(sym.arrow)} ${c.gray([cmd, ...args].join(" "))}`);
  // Package managers rewrite package.json; keep one detail they change, a missing final newline, so remove can
  // give back the exact file.
  const pj = join(cwd, "package.json");
  const before = readText(pj);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.error) err(`  ${c.red(sym.cross)} ${r.error.message}`);
  const after = readText(pj);
  if (before !== null && after !== null && !before.endsWith("\n") && /\r?\n$/.test(after)) {
    try {
      writeFileSync(pj, after.replace(/(\r?\n)+$/, ""));
    } catch {
      /* leave it */
    }
  }
  return r.status === 0;
}

function installSpec(o) {
  if (o.from) {
    // a local tarball or directory: absolute, so the package manager resolves it from the project
    if (/^(\.{0,2}[\\/]|[a-zA-Z]:\\)/.test(o.from) || /\.tgz$/.test(o.from)) return resolve(o.from);
    return o.from.startsWith(PKG) || o.from.includes(":") ? o.from : `${PKG}@${o.from}`;
  }
  return /^\d+\.\d+\.\d+/.test(VERSION) ? `${PKG}@^${VERSION}` : PKG;
}

// ------------------------------------------------------------------------------------------- helpers

/** The project directory: --cwd, else the current directory, else the nearest parent with a package.json. */
function projectDir(o) {
  const start = resolve(o.cwd ?? process.cwd());
  if (o.cwd || isFile(join(start, "package.json")) || htmlFiles(start).length || isDir(join(start, ".git"))) return start;
  for (let d = dirname(start); d !== dirname(d); d = dirname(d)) {
    if (isFile(join(d, "package.json"))) return d;
    if (isDir(join(d, ".git"))) break;
  }
  return start;
}

const posix = (p) => p.split(sep).join("/");
const REF_RE = /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)['"]@genclass\/runtime(?:\/[\w/-]+)?['"]|genclass\.global(?:\.min)?\.js/;

/** Files that use GenClass outside init's markers (a hand-written setup). */
function manualRefs(files) {
  const found = [];
  for (const f of files) {
    const t = readText(f);
    if (t === null || !REF_RE.test(t)) continue;
    if (REF_RE.test(removeMarked(t))) found.push(f);
  }
  return found;
}

function writeChange(ch) {
  if (ch.kind === "delete") {
    rmSync(ch.file, { force: true });
    return;
  }
  mkdirSync(dirname(ch.file), { recursive: true });
  writeFileSync(ch.file, ch.after);
}

/** Removes directories left empty by deleted files, up to (not including) root. */
function pruneEmptyDirs(file, root) {
  let d = dirname(file);
  while (d.startsWith(root + sep) && d !== root) {
    try {
      if (readdirSync(d).length) break;
      rmdirSync(d);
    } catch {
      break;
    }
    d = dirname(d);
  }
}

function manualHelp(project) {
  out(`  Add GenClass by hand: one import as the ${c.bold("first")} line of your entry file`);
  out(`    ${c.cyan(`import "${AUTO()}";`)}`);
  out(`  or, without a bundler, one tag first in <head>`);
  out(`    ${c.cyan(scriptTag({ devtools: true }, PKG_DIR, VERSION).replace(/ integrity="[^"]*" crossorigin="anonymous"/, ""))}`);
  if (project?.pkg) out(`  and install it: ${c.cyan(installArgs(project.pm ?? "npm", PKG).flat().join(" "))}`);
  out();
}

function recommendations(project, state) {
  const recs = [];
  // Redux Toolkit (devTools on by default) and createStore + the Redux DevTools compose/enhancer are discovered by the
  // auto import (autoState) as full adapters: the manual enhancer is for stores created without them
  if (state.redux) {
    const line =
      state.redux.kind === "toolkit"
        ? `configureStore({ reducer, enhancers: (getDefault) => getDefault().concat(genclassEnhancer(GenClass.runtime, { name: "app" })) })`
        : `createStore(reducer, genclassEnhancer(GenClass.runtime, { name: "app" }))`;
    recs.push({
      title: `Redux store in ${state.redux.file} (found automatically when created with Redux Toolkit or the Redux DevTools compose; otherwise)`,
      lines: [`import { GenClass } from "${PKG}";`, `import { genclassEnhancer } from "${PKG}/redux";`, line],
    });
  }
  if (state.zustand) {
    recs.push({
      title: `Zustand store in ${state.zustand.file} (a devtools() store is observed automatically; to let GenClass hold or drop its writes)`,
      lines: [`import { GenClass } from "${PKG}";`, `import { genclass } from "${PKG}/zustand";`, `create(genclass(GenClass.runtime, "store")((set) => ({ /* your store */ })))`],
    });
  }
  if (project.has("react") && state.useState > 0 && !state.redux && !state.zustand) {
    recs.push({
      title: `React state (${state.useState} useState call${state.useState === 1 ? "" : "s"} in ${state.useStateFiles} file${state.useStateFiles === 1 ? "" : "s"}) is observed automatically; for state GenClass should be able to protect (carts, results, saved forms)`,
      lines: [`import { useGenClassState } from "${PKG}/react";`, `const [cart, setCart] = useGenClassState("cart", initialCart); // instead of useState(initialCart)`],
    });
  }
  for (const other of state.others) {
    recs.push({
      title: `${other} store`,
      lines: [`GenClass.runtime.guard("store", { get: () => /* read it */, set: (v) => /* write it */, subscribe: (fn) => /* listen */ });`],
    });
  }
  return recs;
}

function printRecommendations(recs) {
  if (!recs.length) return;
  out(`  ${c.bold("Optional")} ${c.gray("(not applied: the auto import already finds your app state; these let GenClass hold, drop or roll back writes to it)")}`);
  for (const r of recs) {
    out(`    ${sym.dot} ${r.title}:`);
    for (const l of r.lines) out(`        ${c.cyan(l)}`);
  }
  out();
}

// ----------------------------------------------------------------------------------------- options

/** The options init writes: { token?, telemetry?, model? } (empty: none). */
export function configOf(o, token) {
  const c = {};
  if (token) c.token = token;
  if (o.noTelemetry) c.telemetry = false;
  else if (o.telemetry) c.telemetry = true;
  if (o.modelUrl) {
    const u = o.modelUrl.endsWith("/") ? o.modelUrl : `${o.modelUrl}/`;
    c.model = { baseUrl: u, ortWasmPaths: `${u}ort/` };
  }
  return c;
}

/** Telemetry disclosure: it is on by default, what it sends, how to turn it off, where the policy is. */
function telemetryNotice(cfg, where) {
  if (cfg.telemetry === false) {
    row("Telemetry", `off ${c.gray(`(--no-telemetry${where ? `, written to ${where}` : ""})`)}`);
    return;
  }
  row("Telemetry", `${c.bold("on")}${cfg.telemetry ? c.gray(" (--telemetry)") : c.gray(" (the default)")}`);
  out(`             GenClass sends anonymous diagnostics to its maintainers: its decisions with the redacted`);
  out(`             situation text the model read, action outcomes, model status and counts (never input values,`);
  out(`             cookies or IP addresses). Turn it off: ${c.cyan(`${CMD} init --no-telemetry`)}`);
  out(`             (or GenClass.init({ telemetry: false }), ?genclass=no-telemetry in the URL).`);
  out(`             What is sent: ${TELEMETRY_URL}`);
  out(`             Privacy policy: ${PRIVACY_URL}`);
}

/** Where to put the self-hosted model: the folder the framework serves as-is. */
const publicDir = (project) => (project.framework === "sveltekit" ? "static" : project.framework === "angular" && isDir(join(project.dir, "src", "assets")) && !isDir(join(project.dir, "public")) ? "src/assets" : "public");

/** A Content-Security-Policy that may block the default model download: say so and print the self-host steps. */
function cspAdvice(project, files, cfg) {
  const csp = detectCsp(project.dir, files, project.pkg);
  if (!csp) return;
  out();
  out(`  ${c.yellow(sym.warn)} ${c.bold("Content-Security-Policy found")} ${c.gray(`(${csp.files.slice(0, 4).join(", ")}${csp.files.length > 4 ? ", ..." : ""})`)}`);
  if (!cfg.model) {
    out(`    By default GenClass downloads its model and ONNX Runtime's wasm from https://cdn.jsdelivr.net, at idle,`);
    out(
      csp.cdnMentioned
        ? `    which your policy mentions: make sure its connect-src allows https://cdn.jsdelivr.net where it runs.`
        : `    which your policy does not allow (connect-src). The model would then not load (GenClass only observes and`,
    );
    if (!csp.cdnMentioned) out(`    says so once in the console). Self-host it instead:`);
    else out(`    Or self-host it (no third-party origin at all):`);
    const pub = publicDir(project);
    out(`      1. ${c.cyan(`${CMD} fetch-model ${pub}/genclass-model`)} ${c.gray("(model and ONNX Runtime files: about 64 MB; --variant q8 --ort wasm: about 24 MB)")}`);
    out(`      2. ${c.cyan(`${CMD} init --model-url /genclass-model/`)} ${c.gray("(writes model.baseUrl and ortWasmPaths)")}`);
    out(`    or add https://cdn.jsdelivr.net to connect-src.`);
  } else {
    out(`    The model loads from ${cfg.model.baseUrl} (same origin): connect-src 'self' is enough.`);
  }
  if (!csp.wasmEval) out(`    The model runs WebAssembly: script-src needs 'wasm-unsafe-eval'.`);
}

/**
 * init with options on a project init already set up: the options file (or the script tag's attributes, or the
 * Astro meta line) changes in place, or is added next to the marked auto import. Returns the changes (may be empty).
 */
function planConfigSwitch(project, cwd, marked, cfg, readText) {
  const changes = [];
  const rel = (f) => posix(relative(cwd, f));
  const cfgFile = marked.find((f) => /genclass\.config\.[cm]?[jt]s$/.test(f));
  if (cfgFile) {
    const before = readText(cfgFile) ?? "";
    const after = updateConfigText(before, cfg);
    if (after !== before) changes.push({ file: cfgFile, rel: rel(cfgFile), kind: "modify", before, after });
    return { changes, where: rel(cfgFile) };
  }
  let where = null;
  for (const f of marked) {
    const before = readText(f) ?? "";
    let after = before;
    if (/\.html?$/.test(f)) after = switchTagConfig(before, cfg);
    else if (/\.astro$/.test(f)) after = switchMetaConfig(before, cfg);
    else if (!isEmptyConfig({ ...cfg, telemetry: cfg.telemetry === true && !cfg.model ? undefined : cfg.telemetry })) {
      // the JS line init wrote: put the options import right before it
      const lines = before.split("\n");
      // (a marked line, or a line inside a block init created)
      const at = lines.findIndex((l) => /^\s*import\b[^;]*["']@genclass\/runtime\/auto(?:\/\w+)?["']/.test(l));
      if (at < 0) continue;
      const file = configFileFor(project, f);
      if (isFile(file)) continue;
      const q = lines[at].includes("'") ? "'" : '"';
      const semi = /;\s*(?:\/\/.*)?\r?$/.test(lines[at]) ? ";" : "";
      let spec = posix(relative(dirname(f), file)).replace(/\.[cm]?[jt]sx?$/, "");
      if (!spec.startsWith(".")) spec = `./${spec}`;
      const indent = /^\s*/.exec(lines[at])[0];
      lines.splice(at, 0, `${indent}import ${q}${spec}${q}${semi}${lines[at].includes(`// ${MARK}`) ? ` // ${MARK}` : ""}`);
      after = lines.join("\n");
      const ch = configFileChange(file, cfg);
      changes.push({ ...ch, rel: rel(file) });
      where = rel(file);
    }
    if (after !== before) {
      changes.push({ file: f, rel: rel(f), kind: "modify", before, after });
      where ??= rel(f);
    }
  }
  return { changes, where };
}

// ------------------------------------------------------------------------------------------------ init

/** init --mode <m> / --no-telemetry / ... on a project init already set up: rewrite the marked code in place. */
async function switchModes(o, project, changes, install, spec, cwd, what) {
  if (what.mode) row("Mode", `${o.mode} ${c.gray("(switching what init added)")}`);
  if (what.options) row("Options", `${what.options} ${c.gray("(changing what init added)")}`);
  out();
  out(`  ${c.bold("Changes")}`);
  out();
  for (const ch of changes) printChange({ ...ch, file: ch.rel });
  if (install) out(`  ${c.bold("Install")}  ${c.cyan(installArgs(project.pm, spec).flat().join(" "))}`);
  out();
  if (o.dryRun) {
    out(`  ${c.gray("Dry run: nothing was written.")}`);
    out();
    return { code: 0, applied: false };
  }
  if (!o.yes) {
    const ok = await confirm(what.mode ? `Switch to ${o.mode} mode${what.options ? ` (${what.options})` : ""}?` : `Apply ${what.options}?`);
    if (ok === null) {
      out(`  Not a terminal, so nothing was written. Re-run with ${c.bold("--yes")} to apply.`);
      out();
      return { code: 1, applied: false };
    }
    if (!ok) {
      out(`  Nothing changed.`);
      out();
      return { code: 0, applied: false };
    }
    out();
  }
  if (install && !spawn(...installArgs(project.pm, spec), cwd)) {
    err(`  ${c.red(sym.cross)} Installing ${PKG} failed, so no files were changed.`);
    return { code: 1, applied: false };
  }
  for (const ch of changes) writeChange(ch);
  const done = [what.mode ? `now starts in ${o.mode} mode` : null, what.options ? `options: ${what.options}` : null].filter(Boolean).join("; ");
  out(`  ${c.green(sym.ok)} ${c.bold(`GenClass Runtime ${done}.`)} ${c.gray(`(${changes.map((ch) => ch.rel).join(", ")})`)}`);
  out();
  return { code: 0, applied: true };
}

/** "telemetry off, model /genclass-model/" */
const describeConfig = (cfg) => [cfg.token ? `token ${cfg.token}` : null, cfg.telemetry === false ? "telemetry off" : cfg.telemetry ? "telemetry on" : null, cfg.model ? `model ${cfg.model.baseUrl}` : null].filter(Boolean).join(", ");

/** Telemetry as the marked files set it (an existing setup): false when init wrote the opt-out. */
function currentConfig(files) {
  for (const f of files) {
    const t = readText(f) ?? "";
    if (/GENCLASS_CONFIG\s*=\s*\{[^;]*\btelemetry\s*:\s*false/.test(t) || /data-telemetry=["']?off/.test(t) || /<meta[^>]*name=["']genclass["'][^>]*telemetry=off/.test(t)) return { telemetry: false };
  }
  return {};
}

/**
 * --model-url pointing into the app's public folder that `fetch-model --ort wasm` filled: no WebGPU ONNX Runtime
 * there, so the model must run on WASM (device "wasm"), else WebGPU devices would fail to load it.
 */
function withLocalDevice(cfg, project) {
  if (!cfg.model || !/^\//.test(cfg.model.baseUrl)) return cfg;
  try {
    const rec = JSON.parse(readFileSync(join(project.dir, publicDir(project), cfg.model.baseUrl, "ort", "ort.json"), "utf8"));
    const files = Object.keys(rec?.files ?? {});
    if (files.length && !files.some((f) => /asyncify\.wasm$/.test(f))) return { ...cfg, model: { ...cfg.model, device: "wasm" } };
  } catch {
    /* not fetched there (yet): leave the device to the runtime */
  }
  return cfg;
}

// ------------------------------------------------------------------------------------- token, dashboard

/**
 * The app token init writes: { token?, write (put it into what init adds), source, created? (a new project:
 * { token, dashboardUrl, name, created }), why? (no token), failed? }. Network only to create a new project, and
 * never with --token, --no-token, --no-telemetry or --dry-run, or when this project already has a token.
 */
async function chooseToken(o, project, cwd, marked) {
  if (o.noTelemetry) return { why: "--no-telemetry" };
  if (o.noToken) return { why: "--no-token" };
  const inFiles = tokenInFiles(marked);
  const local = readLocal(cwd);
  if (o.token) return { token: o.token, write: o.token !== inFiles, source: "--token", local: local?.token === o.token ? local : null };
  if (inFiles) return { token: inFiles, write: false, source: "already in your setup", local: local?.token === inFiles ? local : null };
  if (local) return { token: local.token, write: true, source: LOCAL_FILE, local };
  if (!o.telemetry && currentConfig(marked).telemetry === false) return { why: "telemetry is off in your setup" };
  if (o.dryRun) return { why: "dry run", wouldCreate: true };
  const r = await createProject(project.pkg?.name || project.name);
  if (!r.ok) return { why: r.reason, failed: true };
  return { token: r.token, write: true, source: "new", created: r };
}

function tokenRow(tk) {
  if (tk.token) {
    row("Token", `${tk.token} ${c.gray(`(${tk.source === "new" ? "created for this app at genclass.dev" : tk.source})`)}`);
    out(`             Public (it ships in your page). The diagnostics above also feed this app's private dashboard.`);
    return;
  }
  if (tk.wouldCreate) {
    row("Token", `${c.gray("a new one would be created at genclass.dev (dry run: no network)")}`);
    return;
  }
  if (tk.failed) {
    row("Token", `none: could not create one (${tk.why})`, c.yellow(sym.warn));
    out(`             GenClass works without it; you only miss the dashboard. Get a token at ${c.cyan(START_URL)}`);
    out(`             and run ${c.cyan(`${CMD} init --token gc_...`)}`);
    return;
  }
  row("Token", c.gray(`none (${tk.why})`));
}

/** After init: the dashboard link (saved to .genclass.local when init wrote its changes). */
function dashboardNotice(tk, cwd, applied) {
  const link = tk.created?.dashboardUrl ?? tk.local?.dashboardUrl;
  if (!tk.token || !link) return;
  let saved = null;
  if (tk.created && applied) {
    try {
      saved = saveLocal(cwd, { token: tk.token, dashboardUrl: link, name: tk.created.name, created: tk.created.created });
    } catch (e) {
      err(`  ${c.yellow(sym.warn)} Could not write ${LOCAL_FILE} (${e?.message ?? e}): copy the link below now.`);
    }
  }
  out(`  ${c.bold("Your dashboard")}  ${c.bold(c.cyan(link))}`);
  out(`  ${c.yellow("Keep this link private; it is the only way to open your dashboard.")}`);
  if (saved) out(`  ${c.gray(`Saved in ${LOCAL_FILE}${saved.gitignore === "added" ? " (added to .gitignore)" : saved.gitignore === "listed" ? " (already in .gitignore)" : " (no .gitignore here: keep it out of version control)"}.`)}`);
  else if (tk.created) out(`  ${c.gray(`Nothing was written. To use this app's token later: ${CMD} init --token ${tk.token}`)}`);
  else if (tk.local) out(`  ${c.gray(`(from ${LOCAL_FILE})`)}`);
  out(`  ${c.gray("It shows data once your app runs with telemetry on (visitors who opt out or send Global Privacy Control are not counted).")}`);
  out();
}

async function init(o) {
  const cwd = projectDir(o);
  banner("init");
  const project = detectProject(cwd);
  let cfg = withLocalDevice(configOf(o), project);
  if (project.refused) {
    out(`  ${c.yellow(sym.warn)} Not adding GenClass to ${c.bold(cwd)}: ${project.refused}.`);
    out(`  If this is a browser app, add the import as the first line of its browser entry file yourself:`);
    out(`    ${c.cyan(`import "${AUTO()}";`)}`);
    out();
    return 1;
  }
  if (!project.framework) {
    out(`  ${c.yellow(sym.warn)} Could not recognise the project in ${c.bold(cwd)}.`);
    if (project.pkg?.workspaces) out(`  It looks like a monorepo root: run init inside your app's directory (or pass --cwd apps/web).`);
    out();
    manualHelp(project);
    return 1;
  }
  row("Project", `${c.bold(project.name)} ${c.gray(`(${project.label}${project.ts ? ", TypeScript" : ""})`)}`);
  if (project.pm) row("Packages", project.pm);

  const files = walkSources(cwd);
  const marked = files.filter((f) => hasMarker(readText(f) ?? ""));
  // a hand-written setup (no init markers): init leaves the code alone, so no token is created for it
  const handWritten = !marked.length && manualRefs(files).length > 0;
  const tk = handWritten ? { why: "GenClass is set up by hand here: pass token to GenClass.init()" } : await chooseToken(o, project, cwd, marked);
  if (tk.write) cfg = { token: tk.token, ...cfg };
  const needsPackage = !!project.pkg && project.framework !== "html" && !project.has(PKG);
  const install = needsPackage && !o.noInstall;
  const spec = installSpec(o);

  if (marked.length || manualRefs(files).length) {
    const where = (marked.length ? marked : manualRefs(files)).map((f) => posix(relative(cwd, f)));
    row("Setup", marked.length ? `already added by init in ${where.join(", ")}` : `GenClass is already imported in ${where.join(", ")}; init leaves your code alone`);
    // `init --mode <m>` again: switch what init added to that mode, in place (GenClass.init() keeps the first
    // runtime's options, so a later GenClass.init({ mode }) in app code would not change it)
    const switches = o.mode
      ? marked
          .map((f) => {
            const before = readText(f) ?? "";
            return { file: f, rel: posix(relative(cwd, f)), kind: "modify", before, after: switchMode(before, o.mode) };
          })
          .filter((ch) => ch.after !== ch.before)
      : [];
    // --no-telemetry / --telemetry / --model-url again: change (or add) the options init wrote, on top of a mode switch
    if (marked.length && !isEmptyConfig(cfg)) {
      const byFile = new Map(switches.map((ch) => [ch.file, ch]));
      const sw = planConfigSwitch(project, cwd, marked, cfg, (f) => byFile.get(f)?.after ?? readText(f));
      for (const ch of sw.changes) {
        const prev = byFile.get(ch.file);
        byFile.set(ch.file, prev ? { ...ch, before: prev.before } : ch);
      }
      switches.splice(0, switches.length, ...[...byFile.values()].filter((ch) => ch.after !== ch.before));
    }
    const optionsChanged = switches.some((ch) => !o.mode || ch.kind === "create" || switchMode(ch.before, o.mode) !== ch.after);
    out();
    telemetryNotice(isEmptyConfig(cfg) ? currentConfig(marked) : { ...currentConfig(marked), ...cfg }, null);
    tokenRow(tk);
    cspAdvice(project, files, cfg);
    out();
    if (switches.length) {
      const r = await switchModes(o, project, switches, install, spec, cwd, { mode: !!o.mode && switches.some((ch) => switchMode(ch.before, o.mode) !== ch.before), options: optionsChanged && !isEmptyConfig(cfg) ? describeConfig(cfg) : null });
      dashboardNotice(tk, cwd, r.applied);
      return r.code;
    }
    if (!install) {
      out(`  ${c.green("Nothing to do.")}${marked.length ? ` To take it out: ${c.cyan(`${CMD} remove`)}` : ""}`);
      out();
      dashboardNotice(tk, cwd, false);
      return 0;
    }
    out();
    out(`  ${PKG} is not in package.json yet. Will run: ${c.cyan(installArgs(project.pm, spec).flat().join(" "))}`);
    if (o.dryRun) return 0;
    if (!o.yes) {
      const ok = await confirm("Install it?");
      if (ok === null) {
        out(`  Not a terminal: re-run with ${c.bold("--yes")}.`);
        return 1;
      }
      if (!ok) return 0;
    }
    return spawn(...installArgs(project.pm, spec), cwd) ? 0 : 1;
  }

  const devtools = !o.noDevtools;
  const plan = planInit(project, { mode: o.mode, devtools, cdn: o.cdn, sri: !o.noSri, strategy: o.strategy, config: cfg }, { pkgDir: PKG_DIR, version: VERSION });
  if (plan.manual || !plan.changes.length) {
    out(`  ${c.yellow(sym.warn)} Could not add GenClass automatically: ${plan.manual ?? "nothing to change"}.`);
    out();
    manualHelp(project);
    return 1;
  }
  row("Entry", posix(relative(cwd, plan.entry)));
  row("Mode", `${o.mode ?? "observe"}${o.mode ? "" : c.gray(" (default: reports only, never changes anything; --mode guard lets it act)")}`);
  const cfgAt = plan.changes.find((ch) => /genclass\.config\.[cm]?[jt]s$/.test(ch.file))?.rel ?? (cfg.telemetry === false ? plan.changes[0]?.rel : null);
  telemetryNotice(cfg, cfgAt);
  tokenRow(tk);
  cspAdvice(project, files, cfg);
  out();
  out(`  ${c.bold("Changes")}`);
  out();
  for (const ch of plan.changes) printChange({ ...ch, file: ch.rel });
  if (install) out(`  ${c.bold("Install")}  ${c.cyan(installArgs(project.pm, spec).flat().join(" "))}`);
  else if (needsPackage) out(`  ${c.yellow(sym.warn)} --no-install: add ${PKG} to your dependencies yourself.`);
  for (const n of plan.notes ?? []) out(`  ${c.yellow(sym.warn)} ${n}`);
  out();

  const recs = recommendations(project, detectState(project, files));
  if (o.dryRun) {
    printRecommendations(recs);
    out(`  ${c.gray("Dry run: nothing was written.")}`);
    out();
    return 0;
  }
  if (!o.yes) {
    const ok = await confirm("Apply these changes?");
    if (ok === null) {
      out(`  Not a terminal, so nothing was written. Re-run with ${c.bold("--yes")} to apply (or ${c.bold("--dry-run")} to preview).`);
      out();
      dashboardNotice(tk, cwd, false);
      return 1;
    }
    if (!ok) {
      out(`  Nothing changed.`);
      out();
      dashboardNotice(tk, cwd, false);
      return 0;
    }
    out();
  }

  if (install && !spawn(...installArgs(project.pm, spec), cwd)) {
    err(`  ${c.red(sym.cross)} Installing ${PKG} failed, so no files were changed.`);
    dashboardNotice(tk, cwd, false);
    return 1;
  }
  for (const ch of plan.changes) writeChange(ch);

  out();
  out(`  ${c.green(sym.ok)} ${c.bold("GenClass Runtime is set up.")} ${c.gray(`(${plan.changes.map((ch) => ch.rel).join(", ")})`)}`);
  out();
  dashboardNotice(tk, cwd, true);
  out(`  ${c.bold("Next")}`);
  const script = project.pkg?.scripts?.dev ? "dev" : project.pkg?.scripts?.start ? "start" : null;
  if (project.framework === "html") out(`    ${sym.dot} Open your page. GenClass starts before your other scripts.`);
  else if (script) out(`    ${sym.dot} Run ${c.cyan(runCmd(project.pm, script))} and open the app.`);
  out(`    ${sym.dot} Detections and actions appear in the browser console as ${c.cyan("[GenClass] ...")} lines.`);
  if (devtools && plan.changes.some((ch) => /devtools/.test(ch.after))) out(`    ${sym.dot} In development an overlay shows what GenClass sees (bottom-right, ${c.bold("Alt+Shift+G")}).`);
  out(`    ${sym.dot} Rule it out while debugging: add ${c.cyan("?genclass=off")} to the URL.`);

  out();
  printRecommendations(recs);
  out(`  Undo: ${c.cyan(`${CMD} remove`)}`);
  out();
  return 0;
}

// ---------------------------------------------------------------------------------------------- remove

async function remove(o) {
  const cwd = projectDir(o);
  banner("remove");
  const project = detectProject(cwd);
  const files = walkSources(cwd);
  const changes = [];
  const after = new Map();
  const problems = [];
  for (const f of files) {
    const before = readText(f);
    if (before === null || !hasMarker(before)) continue;
    const { text: next, problems: p } = planRemoval(before);
    for (const x of p) problems.push(`${posix(relative(cwd, f))}:${x.line}: ${x.reason}`);
    if (next === before) continue;
    const rel = posix(relative(cwd, f));
    const created = before.includes(`${MARK} start`) && next.trim() === "";
    changes.push(created ? { file: f, rel, kind: "delete", before, after: "" } : { file: f, rel, kind: "modify", before, after: next });
    after.set(f, created ? "" : next);
  }
  if (problems.length) {
    out(`  ${c.yellow(sym.warn)} Not removing anything: these places carry init's marker but are not what init wrote, so`);
    out(`  taking them out could delete your code or leave half a statement behind.`);
    for (const p of problems) out(`    ${sym.dot} ${p}`);
    out();
    out(`  Restore them to what init wrote, or delete GenClass's lines there by hand (and their "${MARK}" markers), then`);
    out(`  run ${c.cyan(`${CMD} remove`)} again.`);
    out();
    return 1;
  }
  const users = files.filter((f) => REF_RE.test(after.has(f) ? after.get(f) : readText(f) ?? ""));
  // also the places walkSources skips (.storybook, tmp, out, build, ...): read only, never edited
  const hasPkg = !!project.pkg && project.has(PKG);
  if (hasPkg && !users.length && !o.keepPackage) for (const f of walkSkipped(cwd)) if (REF_RE.test(readText(f) ?? "")) users.push(f);
  const stillUsed = users.length > 0;
  const uninstall = hasPkg && !o.keepPackage && !stillUsed && !o.noInstall;

  const keptBecause = () =>
    out(`  ${c.gray(`${PKG} stays installed${stillUsed ? `: still imported in ${users.slice(0, 10).map((f) => posix(relative(cwd, f))).join(", ")}${users.length > 10 ? ` and ${users.length - 10} more` : ""}` : ""}.`)}`);

  if (!changes.length && !uninstall) {
    out(`  Nothing to remove: no lines marked ${c.bold(MARK)} in ${c.bold(cwd)}.`);
    if (hasPkg && stillUsed) keptBecause();
    out();
    return 0;
  }
  if (changes.length) {
    out(`  ${c.bold("Changes")}`);
    out();
    for (const ch of changes) printChange({ ...ch, file: ch.rel });
  }
  if (uninstall) out(`  ${c.bold("Uninstall")}  ${c.cyan(uninstallArgs(project.pm).flat().join(" "))}`);
  else if (hasPkg) keptBecause();
  out();
  if (o.dryRun) {
    out(`  ${c.gray("Dry run: nothing was written.")}`);
    out();
    return 0;
  }
  if (!o.yes) {
    const ok = await confirm("Remove GenClass?");
    if (ok === null) {
      out(`  Not a terminal, so nothing was changed. Re-run with ${c.bold("--yes")}.`);
      out();
      return 1;
    }
    if (!ok) {
      out(`  Nothing changed.`);
      out();
      return 0;
    }
    out();
  }
  for (const ch of changes) {
    writeChange(ch);
    if (ch.kind === "delete") pruneEmptyDirs(ch.file, cwd);
  }
  if (uninstall && !spawn(...uninstallArgs(project.pm), cwd)) {
    err(`  ${c.red(sym.cross)} The files were restored, but uninstalling ${PKG} failed; run ${uninstallArgs(project.pm).flat().join(" ")} yourself.`);
    return 1;
  }
  out();
  out(`  ${c.green(sym.ok)} ${c.bold("GenClass Runtime is removed.")}${changes.length ? ` ${c.gray(`(${changes.map((ch) => ch.rel).join(", ")})`)}` : ""}`);
  if (isFile(join(cwd, LOCAL_FILE))) out(`  ${c.gray(`${LOCAL_FILE} stays (your token and private dashboard link); delete it when you no longer need the dashboard.`)}`);
  out();
  return 0;
}

/** Entry from bin/genclass-runtime.mjs. Returns the exit code. */
export async function run(cmd, argv) {
  let o;
  try {
    o = parse(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`genclass-runtime ${cmd}: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (o.help) {
    out(USAGE);
    return 0;
  }
  return cmd === "remove" ? remove(o) : init(o);
}
