// Text edits for `genclass-runtime init|remove`. Everything init adds carries a marker:
//   - single lines:  `import genclass from "@genclass/runtime/auto"; // genclass:init`
//   - blocks (files init creates): from a line containing `genclass:init start` to one containing `genclass:init end`
//   - three inline forms, used only when the place to insert shares its line with other code (a one-line <head> or
//     <body>): `<GenClassInit />{/* genclass:inline */}`, `<script>... // genclass:inline</script>` (Astro) and
//     `<script ...></script><!-- genclass:inline -->` (HTML)
// `removeMarked` deletes exactly those (a marker line together with its line break), so a file init only added to
// comes back byte for byte.

export const MARK = "genclass:init";
export const MARK_INLINE = "genclass:inline";
const INLINE_RES = [
  /<GenClassInit \/>\{\/\* genclass:inline \*\/\}/g,
  /<script>(?:(?!<\/script>)[\s\S])*? \/\/ genclass:inline<\/script>/g,
  /<script\b[^>]*><\/script><!-- genclass:inline -->/g,
];

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

/** Removes every marker line, marker block and the inline JSX form. Returns the text without them. */
export function removeMarked(text) {
  let t = text;
  for (const re of INLINE_RES) t = t.replace(re, "");
  const parts = partsOf(t);
  const kept = [];
  let inBlock = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const isStart = p.includes(`${MARK} start`);
    const isEnd = p.includes(`${MARK} end`);
    let drop = false;
    if (inBlock) {
      drop = true;
      if (isEnd) inBlock = false;
    } else if (isStart) {
      drop = true;
      inBlock = !isEnd;
    } else if (p.includes(MARK)) drop = true;
    if (!drop) {
      kept.push(p);
      continue;
    }
    // the last line had no line break: take the break before it instead
    if (i === parts.length - 1 && !p.endsWith("\n") && kept.length) kept[kept.length - 1] = kept[kept.length - 1].replace(/\r?\n$/, "");
  }
  return kept.join("");
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
