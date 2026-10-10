// Text edits for `genclass-runtime init|remove`. Everything init adds carries a marker:
//   - single lines:  `import genclass from "@genclass/runtime/auto"; // genclass:init`
//   - blocks (files init creates): from a line containing `genclass:init start` to one containing `genclass:init end`
//   - three inline forms, used only when the place to insert shares its line with other code (a one-line <head> or
//     <body>): `<GenClassInit />{/* genclass:inline */}`, `<script>... // genclass:inline</script>` (Astro) and
//     `<script ...></script><!-- genclass:inline -->` (HTML)
// `planRemoval` deletes exactly those (a marked statement together with its line break), so a file init only added
// to comes back byte for byte, and refuses (reports a problem, deletes nothing there) when a marked line or block is
// not what init wrote. `switchMode` re-points the same marked code at another mode.

export const MARK = "genclass:init";
export const MARK_INLINE = "genclass:inline";

export const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

/** Lines with their terminators: "a\nb" -> ["a\n", "b"]. */
const partsOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

const PRAGMA = /@jsx|@flow|@ts-nocheck|@refresh|@vitest-environment|@jest-environment/;

/**
 * Offset where code may be inserted at the top of a JS/TS file: after a shebang, the directive prologue
 * ("use client", "use strict") and leading comments that carry pragmas (@jsx, @ts-nocheck, ...).
 */
export function topOffset(text) {
  const parts = partsOf(text);
  let off = 0;
  let i = 0;
  while (i < parts.length) {
    const line = parts[i];
    const t = line.trim();
    if (i === 0 && t.startsWith("#!")) {
      off += line.length;
      i++;
      continue;
    }
    if (/^(['"])use [\w -]+\1;?$/.test(t)) {
      off += line.length;
      i++;
      continue;
    }
    if (t.startsWith("//") && PRAGMA.test(t)) {
      off += line.length;
      i++;
      continue;
    }
    if (t.startsWith("/*")) {
      // a leading block comment: skip it only when it holds a pragma
      let j = i;
      let block = "";
      while (j < parts.length) {
        block += parts[j];
        if (parts[j].includes("*/")) break;
        j++;
      }
      if (PRAGMA.test(block) && j < parts.length) {
        for (let x = i; x <= j; x++) off += parts[x].length;
        i = j + 1;
        continue;
      }
    }
    break;
  }
  return off;
}

/** Inserts whole lines at the top of a JS/TS file (see topOffset). */
export function insertTop(text, lines) {
  const eol = eolOf(text);
  const off = topOffset(text);
  // a file whose header ends without a line break ("'use client'" alone): add one first
  const sep = off > 0 && !text.slice(0, off).endsWith("\n") ? eol : "";
  return text.slice(0, off) + sep + lines.map((l) => l + eol).join("") + text.slice(off);
}

/** Appends whole lines at the end; a file without a final line break keeps having none. */
export function appendEnd(text, lines) {
  const eol = eolOf(text);
  if (text === "") return lines.map((l) => l + eol).join("");
  if (text.endsWith("\n")) return text + lines.map((l) => l + eol).join("");
  return text + eol + lines.join(eol);
}

/** Inserts a line before line index `i` (0-based); i === number of lines appends. */
export function insertLineAt(text, i, line) {
  const eol = eolOf(text);
  const parts = partsOf(text);
  if (i >= parts.length) return appendEnd(text, [line]);
  return parts.slice(0, i).join("") + line + eol + parts.slice(i).join("");
}

export const indentOf = (line) => (/^[ \t]*/.exec(line) ?? [""])[0];

/** The file's indentation unit: a tab, or the smallest positive run of leading spaces (default 2). */
export function indentUnit(text) {
  let min = Infinity;
  for (const l of text.split("\n")) {
    if (/^\t+\S/.test(l)) return "\t";
    const m = /^( +)\S/.exec(l);
    if (m && m[1].length < min) min = m[1].length;
  }
  return Number.isFinite(min) ? " ".repeat(Math.min(min, 8)) : "  ";
}

export const lineIndexAt = (text, offset) => text.slice(0, offset).split("\n").length - 1;
export const linesOf = (text) => partsOf(text).map((p) => p.replace(/\r?\n$/, ""));

// ------------------------------------------------------------------------------------------- removal
//
// `remove` deletes only what init wrote. A marked line is taken out only when, alone or together with the lines a
// formatter wrapped it onto (Prettier: `if (import.meta.env.DEV)\n  import(...)...; // genclass:init`), it is one
// of the statements init writes (compared without whitespace, quote style, semicolons or trailing commas). A block
// is taken out only when its start and end markers pair up and everything between them is what init writes into
// the files it creates. Anything else (an edited line, code added inside a block, a lone start or end marker) is a
// problem: remove then changes nothing and says where.

/** The import specifier for a mode: no mode -> "/auto" (observe, the runtime's default); else "/auto/<mode>". */
export const AUTO = (mode) => (mode ? `@genclass/runtime/auto/${mode}` : "@genclass/runtime/auto");

const AUTO_SPEC = String.raw`"@genclass/runtime/auto(?:/(?:observe|guard|heal))?"`;
const DEVTOOLS_CALL = String.raw`import\("@genclass/runtime/devtools"\)\.then\(d=>d\.mountDevtools\(genclass\)\)`;
const COND = String.raw`[^;{}]+?`;
const IMPORT_AUTO = String.raw`import(?:genclassfrom)?${AUTO_SPEC};?`;
// the options file init writes with --no-telemetry / --telemetry / --model-url, imported right before /auto
const IMPORT_CONFIG = String.raw`import"(?:\.{1,2}/)+(?:[\w.-]+/)*genclass\.config(?:\.[cm]?[jt]s)?";?`;
const CONFIG_STATEMENT = String.raw`(?:\(globalThisas\{GENCLASS_CONFIG\?:\w+\}\)|globalThis)\.GENCLASS_CONFIG=\{[^;]*\};?`;
const META_CONFIG = String.raw`<metaname="genclass"content="[^"]*"/?>`;
const DEV_LINE = String.raw`if\(${COND}\)${DEVTOOLS_CALL};?`;
// the same with braces (ESLint's `curly` fix)
const DEV_BLOCK = String.raw`if\(${COND}\)\{${DEVTOOLS_CALL};?\}`;
/** Statements init writes on one marked line (normalised, see norm()). */
const LINE_RE = new RegExp(
  "^(?:" +
    [
      IMPORT_AUTO,
      IMPORT_CONFIG,
      META_CONFIG,
      DEV_LINE,
      DEV_BLOCK,
      String.raw`import\{isDevModeasgenclassDevMode\}from"@angular/core";?`,
      String.raw`import\{GenClassInit\}from"[^"]*genclass-init";?`,
      String.raw`<GenClassInit/>`,
      String.raw`<script[^<>]*></script>`,
      String.raw`<script>${IMPORT_AUTO}(?:${DEV_LINE})?</script>`,
    ].join("|") +
    ")$",
);
/** What the files init creates hold between their start and end markers (normalised, comment lines dropped). */
const BLOCK_RE = new RegExp(
  "^(?:" +
    [
      String.raw`"useclient";?`,
      IMPORT_AUTO,
      IMPORT_CONFIG,
      CONFIG_STATEMENT,
      DEV_LINE,
      DEV_BLOCK,
      String.raw`importtype\{AppProps\}from"next/app";?`,
      String.raw`exportfunctionGenClassInit\(\)\{returnnull;?\}`,
      String.raw`exportdefaultdefineNuxtPlugin\(\(\)=>\{(?:${DEV_LINE}|${DEV_BLOCK})?\}\);?`,
      String.raw`exportdefaultfunctionApp\(\{Component,pageProps\}(?::AppProps)?\)\{return\(?<Component\{\.\.\.pageProps\}/>\)?;?\}`,
    ].join("|") +
    ")*$",
);
// Inline forms (init puts them on a line shared with other code); whitespace a formatter adds between the element and
// its marker is taken out with them. `ok` checks the element is still what init wrote (an Astro <script> holds code).
const INLINE_SCRIPT_RE = new RegExp(String.raw`^<script>(?:${IMPORT_AUTO})(?:${DEV_LINE})?</script>$`);
const INLINE = [
  { re: /<GenClassInit\s*\/>\s*\{\s*\/\*\s*genclass:inline\s*\*\/\s*\}/g },
  { re: /<script>(?:(?!<\/script>)[\s\S])*?\/\/\s*genclass:inline\s*<\/script>/g, ok: (m) => INLINE_SCRIPT_RE.test(norm(m)) },
  { re: /<script\b[^>]*><\/script>\s*<!--\s*genclass:inline\s*-->/g },
];
const INLINE_RES = INLINE.map((x) => x.re);
// The only comment line init writes inside a block (planNext, the layout strategy's genclass-init component).
const BLOCK_COMMENT =
  /^\s*\/\/ (?:Starts GenClass Runtime when this module loads in the browser \(on the server it is inert\)\.|Read by @genclass\/runtime\/auto, imported right after this file: any GenClass\.init\(\) option works here \(see the README\)\.)\s*$/;
const MAX_UP = 8;
const MAX_DOWN = 4;

/** A statement compared without its marker, whitespace, quote style, trailing commas or arrow-parameter parens. */
function norm(s) {
  return s
    .replace(/\{\s*\/\*\s*genclass:(?:init|inline)\s*\*\/\s*\}/g, "")
    .replace(/<!--\s*genclass:(?:init|inline)\s*-->/g, "")
    .replace(/\/\/\s*genclass:(?:init|inline)\b/g, "")
    .replace(/\s+/g, "")
    .replace(/'/g, '"')
    .replace(/,(?=[)}\]])/g, "")
    .replace(/\((\w+)\)=>/g, "$1=>");
}

const isStart = (l) => l.includes(`${MARK} start`);
const isEnd = (l) => l.includes(`${MARK} end`);

/**
 * The line ranges init wrote, in a text whose inline forms are already handled: { ranges: [[first, last]] (line
 * indices, inclusive), problems: [{ line (1-based), reason }] }.
 */
function markedRanges(parts) {
  const lines = parts.map((p) => p.replace(/\r?\n$/, ""));
  const ranges = [];
  const problems = [];
  const taken = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (taken.has(i) || !lines[i].includes(MARK)) continue;
    if (isEnd(lines[i]) && !isStart(lines[i])) {
      problems.push({ line: i + 1, reason: `"${MARK} end" without a matching "${MARK} start" above it` });
      continue;
    }
    if (isStart(lines[i])) {
      let e = i + 1;
      while (e < lines.length && !lines[e].includes(MARK)) e++;
      if (isEnd(lines[i]) || e >= lines.length || !isEnd(lines[e]) || isStart(lines[e])) {
        problems.push({ line: i + 1, reason: `"${MARK} start" without its "${MARK} end" (or another marker inside the block)` });
        if (e < lines.length) taken.add(e);
        continue;
      }
      const inner = lines.slice(i + 1, e).filter((l) => !BLOCK_COMMENT.test(l));
      if (!BLOCK_RE.test(norm(inner.join("\n")))) {
        problems.push({ line: i + 1, reason: `the block init created (lines ${i + 1}-${e + 1}) was edited; code in it is not what init wrote` });
      } else ranges.push([i, e]);
      for (let x = i; x <= e; x++) taken.add(x);
      i = e;
      continue;
    }
    let found = null;
    for (let size = 1; size <= MAX_UP + MAX_DOWN + 1 && !found; size++) {
      for (let up = Math.min(size - 1, MAX_UP); up >= 0 && !found; up--) {
        const down = size - 1 - up;
        if (down > MAX_DOWN) break;
        const a = i - up;
        const b = i + down;
        if (a < 0 || b >= lines.length) continue;
        let free = true;
        for (let x = a; x <= b; x++) if (taken.has(x) || (x !== i && (isStart(lines[x]) || isEnd(lines[x])))) free = false;
        if (free && LINE_RE.test(norm(lines.slice(a, b + 1).join("\n")))) found = [a, b];
      }
    }
    if (!found) {
      problems.push({ line: i + 1, reason: `this line has the "${MARK}" marker but is not a statement init writes (edited?)` });
      continue;
    }
    ranges.push(found);
    for (let x = found[0]; x <= found[1]; x++) taken.add(x);
  }
  return { ranges, problems };
}

/**
 * What remove does to a file: { text, problems }. `text` is the file without init's lines, blocks and inline forms
 * (marked lines it does not recognise stay); `problems` lists what it could not take out safely.
 */
export function planRemoval(text) {
  const { lines: segs, problems } = stripInline(text);
  const parts = segs.map((s) => s.text);
  const marked = markedRanges(parts);
  for (const p of marked.problems) problems.push({ line: segs[p.line - 1].line, reason: p.reason });
  const flagged = new Set(problems.map((p) => p.line));
  segs.forEach((s) => {
    if (s.text.includes(MARK_INLINE) && !flagged.has(s.line)) problems.push({ line: s.line, reason: `the "${MARK_INLINE}" marker is not next to the element init added (edited?)` });
  });
  const drop = new Set(segs.flatMap((s, i) => (s.drop ? [i] : [])));
  for (const [a, b] of marked.ranges) for (let x = a; x <= b; x++) drop.add(x);
  const kept = [];
  for (let i = 0; i < parts.length; i++) {
    if (!drop.has(i)) {
      kept.push(parts[i]);
      continue;
    }
    // the last line had no line break: take the break before it instead
    if (i === parts.length - 1 && !parts[i].endsWith("\n") && kept.length) kept[kept.length - 1] = kept[kept.length - 1].replace(/\r?\n$/, "");
  }
  problems.sort((x, y) => x.line - y.line);
  return { text: kept.join(""), problems };
}

/**
 * The text's lines with init's inline forms cut out: [{ text, line (1-based, in `text`), drop }]. A line holding only
 * an inline form once it is cut (a formatter moved the element onto lines of its own) is dropped whole. An inline
 * form that is no longer what init wrote stays, as a problem.
 */
function stripInline(text) {
  const problems = [];
  const cuts = [];
  for (const { re, ok } of INLINE) {
    for (const m of text.matchAll(re)) {
      if (ok && !ok(m[0])) problems.push({ line: lineIndexAt(text, m.index) + 1, reason: `the element init added inline was edited; it is not what init wrote` });
      else cuts.push([m.index, m.index + m[0].length]);
    }
  }
  cuts.sort((x, y) => x[0] - y[0]);
  const parts = partsOf(text);
  const starts = [];
  let off = 0;
  for (const p of parts) {
    starts.push(off);
    off += p.length;
  }
  const lineOf = (o) => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1] <= o) i++;
    return i;
  };
  const lines = [];
  let c = 0;
  for (let i = 0; i < parts.length; ) {
    let end = starts[i] + parts[i].length;
    if (c >= cuts.length || cuts[c][0] >= end) {
      lines.push({ text: parts[i], line: i + 1, drop: false });
      i++;
      continue;
    }
    let j = i;
    let pos = starts[i];
    let s = "";
    while (c < cuts.length && cuts[c][0] < end) {
      s += text.slice(pos, cuts[c][0]);
      pos = cuts[c][1];
      j = Math.max(j, lineOf(pos - 1));
      end = starts[j] + parts[j].length;
      c++;
    }
    s += text.slice(pos, end);
    lines.push({ text: s, line: i + 1, drop: s.trim() === "" });
    i = j + 1;
  }
  return { lines, problems };
}

/** The text without what init added (see planRemoval; unrecognised marked lines are kept). */
export const removeMarked = (text) => planRemoval(text).text;

// ------------------------------------------------------------------------------------------ mode switch

const SPEC_RE = /@genclass\/runtime\/auto(?:\/(observe|guard|heal))?(?=["'])/g;
const SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=[^>]*>/gi;
const DATA_MODE_RE = /\s+data-mode\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Modes the init-written code in a segment starts with (no mode written = observe, the runtime's default). */
function modesIn(seg) {
  const modes = [];
  for (const m of seg.matchAll(SPEC_RE)) modes.push(m[1] ?? "observe");
  for (const m of seg.matchAll(SCRIPT_SRC_RE)) {
    const dm = DATA_MODE_RE.exec(m[0]);
    modes.push((dm ? dm[1] ?? dm[2] ?? dm[3] : "observe").toLowerCase());
  }
  return modes;
}

function rewriteMode(seg, mode) {
  return seg.replace(SPEC_RE, AUTO(mode)).replace(SCRIPT_SRC_RE, (tag) => {
    const attr = `data-mode="${mode}"`;
    if (DATA_MODE_RE.test(tag)) return tag.replace(DATA_MODE_RE, (m) => m.replace(/data-mode[\s\S]*$/i, attr));
    const dev = /\s+data-devtools\b/i.exec(tag);
    if (dev) return `${tag.slice(0, dev.index)} ${attr}${tag.slice(dev.index)}`;
    const close = /\s*\/?>$/.exec(tag);
    return `${tag.slice(0, close.index)} ${attr}${tag.slice(close.index)}`;
  });
}

/**
 * Re-points what init added (the /auto import or the script tag's data-mode) at `mode`, in place. Returns the new
 * text, or the same text when everything init added already runs in that mode. Code outside init's markers is
 * never touched.
 */
export function switchMode(text, mode) {
  const segs = [];
  let t = text;
  for (const re of INLINE_RES) t = t.replace(re, (m) => (segs.push(m), m));
  const parts = partsOf(t);
  const { ranges } = markedRanges(parts);
  for (const [a, b] of ranges) segs.push(parts.slice(a, b + 1).join(""));
  const modes = segs.flatMap(modesIn);
  if (!modes.length || modes.every((m) => m === mode)) return text;
  for (const re of INLINE_RES) t = t.replace(re, (m) => rewriteMode(m, mode));
  const out = partsOf(t);
  for (const [a, b] of ranges) {
    out[a] = rewriteMode(out.slice(a, b + 1).join(""), mode);
    for (let x = a + 1; x <= b; x++) out[x] = "";
  }
  return out.join("");
}

export const hasMarker = (text) => text.includes(MARK) || text.includes(MARK_INLINE);

// --------------------------------------------------------------------------------------------- code style

/** Quote and semicolon style of a file's import statements (default: double quotes, semicolons). */
export function codeStyle(text) {
  let single = 0;
  let double = 0;
  let semi = 0;
  let bare = 0;
  for (const l of text.split("\n")) {
    const m = /^\s*(?:import|export)\b.*?\bfrom\s+(['"])[^'"]*\1(;?)\s*$/.exec(l) ?? /^\s*import\s+(['"])[^'"]*\1(;?)\s*$/.exec(l);
    if (!m) continue;
    if (m[1] === "'") single++;
    else double++;
    if (m[2]) semi++;
    else bare++;
  }
  return { q: single > double ? "'" : '"', semi: bare > semi ? "" : ";" };
}

// ------------------------------------------------------------------------------------------- JSX helpers

/**
 * The offset just after the `>` that closes the first `<body ...>` opening tag (attributes may span lines and hold
 * JSX expressions), or -1.
 */
export function bodyTagEnd(text) {
  const re = /<body(?=[\s>/])/g;
  let m;
  while ((m = re.exec(text))) {
    let i = m.index + 5;
    let depth = 0;
    let quote = "";
    for (; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) return text[i - 1] === "/" ? -1 : i + 1;
    }
  }
  return -1;
}

// ------------------------------------------------------------------------------------------- options
//
// init --no-telemetry / --telemetry / --model-url write options without hand-editing. An ES module's imports run
// before its own code, so options cannot be set in the entry file above the /auto import: init writes them to a
// file of their own, genclass.config.(ts|js), which sets window.GENCLASS_CONFIG (read by /auto), and imports it
// right before the /auto import. A plain HTML page gets data attributes on the script tag instead, an Astro layout
// a `<meta name="genclass">` line. All of it is marked, so `remove` takes it out.

export const CONFIG_COMMENT = "// Read by @genclass/runtime/auto, imported right after this file: any GenClass.init() option works here (see the README).";

const isEmptyConfig = (cfg) => !cfg || (cfg.telemetry === undefined && !cfg.model && !cfg.token);
export { isEmptyConfig };

const modelLiteral = (m) => `model: { baseUrl: ${JSON.stringify(m.baseUrl)}, ortWasmPaths: ${JSON.stringify(m.ortWasmPaths)}${m.device ? `, device: ${JSON.stringify(m.device)}` : ""} }`;

/** The object init writes: `{ token: "gc_...", telemetry: false, model: { baseUrl: "/genclass-model/", ortWasmPaths: "..." } }`. */
export function configLiteral(cfg) {
  const parts = [];
  if (cfg.token) parts.push(`token: ${JSON.stringify(cfg.token)}`);
  if (cfg.telemetry !== undefined) parts.push(`telemetry: ${cfg.telemetry ? "true" : "false"}`);
  if (cfg.model) parts.push(modelLiteral(cfg.model));
  return parts.length ? `{ ${parts.join(", ")} }` : "{}";
}

/** The statement in genclass.config.(ts|js). */
export const configStatement = (cfg, ts) => `${ts ? "(globalThis as { GENCLASS_CONFIG?: object })" : "globalThis"}.GENCLASS_CONFIG = ${configLiteral(cfg)};`;

/** Sets token / telemetry / model in an existing GENCLASS_CONFIG statement (other keys a user added stay). */
export function updateConfigText(text, cfg) {
  return text.replace(/(GENCLASS_CONFIG\s*=\s*\{)([^;]*)(\}\s*;?)/, (_m, open, body, close) => {
    let b = body;
    if (cfg.token) {
      const v = `token: ${JSON.stringify(cfg.token)}`;
      b = /\btoken\s*:\s*(?:"[^"]*"|'[^']*')/.test(b) ? b.replace(/\btoken\s*:\s*(?:"[^"]*"|'[^']*')/, v) : `${v}, ${b.trim()}`;
    }
    if (cfg.telemetry !== undefined) {
      const v = `telemetry: ${cfg.telemetry ? "true" : "false"}`;
      b = /\btelemetry\s*:\s*(?:true|false)/.test(b) ? b.replace(/\btelemetry\s*:\s*(?:true|false)/, v) : `${v}, ${b.trim()}`;
    }
    if (cfg.model) b = /\bmodel\s*:\s*\{[^}]*\}/.test(b) ? b.replace(/\bmodel\s*:\s*\{[^}]*\}/, modelLiteral(cfg.model)) : `${b.trim().replace(/,\s*$/, "")}, ${modelLiteral(cfg.model)}`;
    b = b.trim().replace(/^,\s*/, "").replace(/,\s*$/, "");
    return b ? `${open} ${b} ${close.trimStart()}` : `${open}${close.trimStart()}`;
  });
}

/** `telemetry=off, model=/genclass-model/, ort=/genclass-model/ort/` (meta content), "" when nothing to say. */
export function metaContent(cfg) {
  const parts = [];
  if (cfg.token) parts.push(`token=${cfg.token}`);
  if (cfg.telemetry === false) parts.push("telemetry=off");
  if (cfg.model) parts.push(`model=${cfg.model.baseUrl}`, `ort=${cfg.model.ortWasmPaths}`, ...(cfg.model.device ? [`device=${cfg.model.device}`] : []));
  return parts.join(", ");
}

const TAG_ATTRS = { token: "data-token", telemetry: "data-telemetry", model: "data-model", ort: "data-ort", device: "data-device" };
const attrRe = (name) => new RegExp(String.raw`\s+${name}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)`, "i");

/** A script tag with data-token / data-telemetry / data-model / data-ort set for cfg (telemetry true removes the opt-out). */
export function tagWithConfig(tag, cfg) {
  const set = (t, name, value) => {
    const re = attrRe(name);
    if (value === null) return t.replace(re, "");
    const attr = ` ${name}="${value}"`;
    if (re.test(t)) return t.replace(re, attr);
    const close = /\s*\/?>$/.exec(t);
    return `${t.slice(0, close.index)}${attr}${t.slice(close.index)}`;
  };
  let t = tag;
  if (cfg.token) t = set(t, TAG_ATTRS.token, cfg.token);
  if (cfg.telemetry !== undefined) t = set(t, TAG_ATTRS.telemetry, cfg.telemetry ? null : "off");
  if (cfg.model) {
    t = set(t, TAG_ATTRS.model, cfg.model.baseUrl);
    t = set(t, TAG_ATTRS.ort, cfg.model.ortWasmPaths);
    if (cfg.model.device) t = set(t, TAG_ATTRS.device, cfg.model.device);
  }
  return t;
}

/** Applies cfg to the script tags init added (inline or on marked lines). Same text when nothing changes. */
export function switchTagConfig(text, cfg) {
  let t = text;
  for (const re of INLINE_RES) t = t.replace(re, (m) => m.replace(SCRIPT_SRC_RE, (tag) => tagWithConfig(tag, cfg)));
  const parts = partsOf(t);
  const { ranges } = markedRanges(parts);
  for (const [a, b] of ranges) {
    const seg = parts.slice(a, b + 1).join("");
    if (!/<script\b[^>]*\bsrc\s*=/i.test(seg)) continue;
    parts[a] = seg.replace(SCRIPT_SRC_RE, (tag) => tagWithConfig(tag, cfg));
    for (let x = a + 1; x <= b; x++) parts[x] = "";
  }
  return parts.join("");
}

/**
 * Astro: the marked `<meta name="genclass">` line (before init's `<script>` line) carries cfg; added, rewritten, or
 * dropped when it would be empty. Same text when nothing changes or init's script line is not found.
 */
export function switchMetaConfig(text, cfg) {
  const lines = partsOf(text);
  const metaAt = lines.findIndex((l) => l.includes(MARK) && /<meta\s+name=["']genclass["']/i.test(l));
  if (metaAt >= 0) {
    const cur = /content=["']([^"']*)["']/i.exec(lines[metaAt])?.[1] ?? "";
    const pairs = Object.fromEntries(cur.split(/[,;]\s*/).filter(Boolean).map((p) => [p.split("=")[0].trim(), p.slice(p.indexOf("=") + 1).trim()]));
    if (cfg.token) pairs.token = cfg.token;
    if (cfg.telemetry === false) pairs.telemetry = "off";
    if (cfg.telemetry === true) delete pairs.telemetry;
    if (cfg.model) Object.assign(pairs, { model: cfg.model.baseUrl, ort: cfg.model.ortWasmPaths, ...(cfg.model.device ? { device: cfg.model.device } : {}) });
    const content = Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join(", ");
    if (!content) {
      lines[metaAt] = "";
      return lines.join("");
    }
    lines[metaAt] = lines[metaAt].replace(/content=["'][^"']*["']/i, `content="${content}"`);
    return lines.join("");
  }
  const content = metaContent(cfg);
  if (!content) return text;
  const scriptAt = lines.findIndex((l) => l.includes(`// ${MARK}</script>`));
  if (scriptAt < 0) return text;
  return insertLineAt(text, scriptAt, `${indentOf(lines[scriptAt])}<meta name="genclass" content="${content}" /> <!-- ${MARK} -->`);
}
