// `genclass-runtime init` and `genclass-runtime remove` (also `npx @genclass/runtime init|remove`).
//
// init: detects the project, installs @genclass/runtime, adds the auto import as the first statement of the entry
// file (plus a dev-only devtools line), shows the diff and asks before writing. Every added line or created file
// carries the marker `genclass:init`, so `remove` can take out exactly that and nothing else. Running init twice
// changes nothing.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { detectProject, detectState, htmlFiles, isDir, isFile, readText, walkSources } from "./detect.mjs";
import { MARK, hasMarker, removeMarked } from "./edit.mjs";
import { AUTO, planInit, scriptTag } from "./plan.mjs";
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

export const USAGE = `Usage:
  genclass-runtime init   [--mode observe|guard|heal] [--yes] [--dry-run] [--no-install] [--no-devtools] [--cwd <dir>]
  genclass-runtime remove [--yes] [--dry-run] [--keep-package] [--cwd <dir>]

init     finds your framework, installs ${PKG}, adds one import to your entry file (and a dev-only devtools
         line), shows the diff and asks before writing. Running it again changes nothing.
remove   takes out exactly what init added (every line marked "${MARK}") and uninstalls the package if
         nothing else uses it.

  --mode <m>       observe (never changes anything), guard (default) or heal
  --yes, -y        apply without asking
  --dry-run        show what would change; write nothing
  --no-install     do not run the package manager
  --no-devtools    do not add the dev-only devtools overlay
  --keep-package   remove: leave ${PKG} installed
  --cwd <dir>      the project directory (default: the current directory)
  --from <spec>    install ${PKG} from this spec (a version, tag or tarball path)
  --cdn <url>      plain HTML: the script URL (default: jsDelivr, this version)`;

class UsageError extends Error {}

const BOOL = {
  yes: "yes",
  y: "yes",
  "dry-run": "dryRun",
  "no-install": "noInstall",
  "no-devtools": "noDevtools",
  "keep-package": "keepPackage",
  "no-sri": "noSri",
  help: "help",
  h: "help",
};
const VALUE = { mode: "mode", from: "from", cdn: "cdn", cwd: "cwd", strategy: "strategy" };

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
  if (state.redux) {
    const line =
      state.redux.kind === "toolkit"
        ? `configureStore({ reducer, enhancers: (getDefault) => getDefault().concat(genclassEnhancer(GenClass.runtime, { name: "app" })) })`
        : `createStore(reducer, genclassEnhancer(GenClass.runtime, { name: "app" }))`;
    recs.push({
      title: `Redux store in ${state.redux.file}`,
      lines: [`import { GenClass } from "${PKG}";`, `import { genclassEnhancer } from "${PKG}/redux";`, line],
    });
  }
  if (state.zustand) {
    recs.push({
      title: `Zustand store in ${state.zustand.file}`,
      lines: [`import { GenClass } from "${PKG}";`, `import { genclass } from "${PKG}/zustand";`, `create(genclass(GenClass.runtime, "store")((set) => ({ /* your store */ })))`],
    });
  }
  if (project.has("react") && state.useState > 0 && !state.redux && !state.zustand) {
    recs.push({
      title: `React state (${state.useState} useState call${state.useState === 1 ? "" : "s"} in ${state.useStateFiles} file${state.useStateFiles === 1 ? "" : "s"}): for state worth protecting (carts, results, saved forms)`,
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
  out(`  ${c.bold("Recommended")} ${c.gray("(not applied: lets GenClass hold, drop or roll back writes to your state)")}`);
  for (const r of recs) {
    out(`    ${sym.dot} ${r.title}:`);
    for (const l of r.lines) out(`        ${c.cyan(l)}`);
  }
  out();
}

// ------------------------------------------------------------------------------------------------ init

async function init(o) {
  const cwd = projectDir(o);
  banner("init");
  const project = detectProject(cwd);
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
  const needsPackage = !!project.pkg && project.framework !== "html" && !project.has(PKG);
  const install = needsPackage && !o.noInstall;
  const spec = installSpec(o);

  if (marked.length || manualRefs(files).length) {
    const where = (marked.length ? marked : manualRefs(files)).map((f) => posix(relative(cwd, f)));
    row("Setup", marked.length ? `already added by init in ${where.join(", ")}` : `GenClass is already imported in ${where.join(", ")}; init leaves your code alone`);
    if (!install) {
      out();
      out(`  ${c.green("Nothing to do.")}${marked.length ? ` To take it out: ${c.cyan(`${CMD} remove`)}` : ""}`);
      out();
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
  const plan = planInit(project, { mode: o.mode, devtools, cdn: o.cdn, sri: !o.noSri, strategy: o.strategy }, { pkgDir: PKG_DIR, version: VERSION });
  if (plan.manual || !plan.changes.length) {
    out(`  ${c.yellow(sym.warn)} Could not add GenClass automatically: ${plan.manual ?? "nothing to change"}.`);
    out();
    manualHelp(project);
    return 1;
  }
  row("Entry", posix(relative(cwd, plan.entry)));
  row("Mode", `${o.mode ?? "guard"}${o.mode ? "" : c.gray(" (default; --mode observe never changes anything)")}`);
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
      return 1;
    }
    if (!ok) {
      out(`  Nothing changed.`);
      out();
      return 0;
    }
    out();
  }

  if (install && !spawn(...installArgs(project.pm, spec), cwd)) {
    err(`  ${c.red(sym.cross)} Installing ${PKG} failed, so no files were changed.`);
    return 1;
  }
  for (const ch of plan.changes) writeChange(ch);

  out();
  out(`  ${c.green(sym.ok)} ${c.bold("GenClass Runtime is set up.")} ${c.gray(`(${plan.changes.map((ch) => ch.rel).join(", ")})`)}`);
  out();
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
  for (const f of files) {
    const before = readText(f);
    if (before === null || !hasMarker(before)) continue;
    const next = removeMarked(before);
    if (next === before) continue;
    const rel = posix(relative(cwd, f));
    const created = before.includes(`${MARK} start`) && next.trim() === "";
    changes.push(created ? { file: f, rel, kind: "delete", before, after: "" } : { file: f, rel, kind: "modify", before, after: next });
    after.set(f, created ? "" : next);
  }
  const stillUsed = files.some((f) => REF_RE.test(after.has(f) ? after.get(f) : readText(f) ?? ""));
  const uninstall = !!project.pkg && project.has(PKG) && !o.keepPackage && !stillUsed && !o.noInstall;

  if (!changes.length && !uninstall) {
    out(`  Nothing to remove: no lines marked ${c.bold(MARK)} in ${c.bold(cwd)}.`);
    out();
    return 0;
  }
  if (changes.length) {
    out(`  ${c.bold("Changes")}`);
    out();
    for (const ch of changes) printChange({ ...ch, file: ch.rel });
  }
  if (uninstall) out(`  ${c.bold("Uninstall")}  ${c.cyan(uninstallArgs(project.pm).flat().join(" "))}`);
  else if (project.pkg && project.has(PKG)) out(`  ${c.gray(`${PKG} stays installed${stillUsed ? " (your code still uses it)" : ""}.`)}`);
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
