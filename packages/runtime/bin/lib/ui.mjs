// Terminal helpers for `genclass-runtime init|remove`: colours, symbols, a line diff and a yes/no prompt.
// No dependencies (Node >= 20).

import { createInterface } from "node:readline";

const env = process.env;
const tty = !!process.stdout.isTTY;
export const useColor = env.FORCE_COLOR ? env.FORCE_COLOR !== "0" : !env.NO_COLOR && tty && env.TERM !== "dumb";
const unicode = process.platform !== "win32" || !!env.WT_SESSION || !!env.TERM_PROGRAM;

const wrap = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const sym = {
  ok: unicode ? "✔" : "+",
  arrow: unicode ? "→" : ">",
  dot: unicode ? "•" : "*",
  warn: unicode ? "▲" : "!",
  cross: unicode ? "✖" : "x",
  line: unicode ? "─" : "-",
};

export const out = (s = "") => process.stdout.write(`${s}\n`);
export const err = (s = "") => process.stderr.write(`${s}\n`);

export function banner(title) {
  out();
  out(`  ${c.bold(c.magenta("GenClass Runtime"))} ${c.gray(sym.dot)} ${c.bold(title)}`);
  out();
}

/** "  ✔ Label      value" rows. */
export function row(label, value, mark = c.green(sym.ok)) {
  out(`  ${mark} ${c.bold(label.padEnd(10))} ${value}`);
}

// ------------------------------------------------------------------------------------------------ diff

const splitLines = (s) => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** Line operations [" "|"-"|"+", text] turning a into b (LCS; prefix/suffix only for very large inputs). */
export function diffLines(a, b) {
  const A = splitLines(a);
  const B = splitLines(b);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const ops = A.slice(0, pre).map((l) => [" ", l]);
  const n = a2.length;
  const m = b2.length;
  if (n * m > 4_000_000) {
    for (const l of a2) ops.push(["-", l]);
    for (const l of b2) ops.push(["+", l]);
  } else {
    // dp[i][j] = LCS length of a2[i..] and b2[j..]
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a2[i] === b2[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) {
        ops.push([" ", a2[i]]);
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push(["-", a2[i++]]);
      else ops.push(["+", b2[j++]]);
    }
    while (i < n) ops.push(["-", a2[i++]]);
    while (j < m) ops.push(["+", b2[j++]]);
  }
  for (const l of A.slice(A.length - suf)) ops.push([" ", l]);
  return ops;
}

/** Unified-diff hunks (3 lines of context) as coloured lines. */
export function renderDiff(a, b, context = 3) {
  const ops = diffLines(a, b);
  const idx = [];
  ops.forEach((o, i) => o[0] !== " " && idx.push(i));
  // group changes closer than 2*context lines into one hunk
  const groups = [];
  for (const i of idx) {
    const g = groups[groups.length - 1];
    if (g && i - g[1] <= context * 2 + 1) g[1] = i;
    else groups.push([i, i]);
  }
  const lines = [];
  for (const [first, last] of groups) {
    const start = Math.max(0, first - context);
    const end = Math.min(ops.length, last + context + 1);
    let aLine = 1;
    let bLine = 1;
    for (let x = 0; x < start; x++) {
      if (ops[x][0] !== "+") aLine++;
      if (ops[x][0] !== "-") bLine++;
    }
    const slice = ops.slice(start, end);
    const aCount = slice.filter((o) => o[0] !== "+").length;
    const bCount = slice.filter((o) => o[0] !== "-").length;
    lines.push(c.cyan(`@@ -${aCount ? aLine : aLine - 1},${aCount} +${bCount ? bLine : bLine - 1},${bCount} @@`));
    for (const [op, text] of slice) {
      if (op === "+") lines.push(c.green(`+ ${text}`));
      else if (op === "-") lines.push(c.red(`- ${text}`));
      else lines.push(c.gray(`  ${text}`));
    }
  }
  return lines;
}

/** Prints one file change: a heading and its diff, indented. */
export function printChange(change) {
  const { file, kind } = change;
  const tag = kind === "create" ? c.green("new file") : kind === "delete" ? c.red("delete") : c.yellow("modify");
  out(`  ${c.bold(file)} ${c.gray("(")}${tag}${c.gray(")")}`);
  const lines = renderDiff(change.before ?? "", change.after ?? "");
  for (const l of lines) out(`    ${l}`);
  out();
}

// ------------------------------------------------------------------------------------------------ prompt

/** Asks a yes/no question. Returns null when stdin is not interactive. */
export async function confirm(question, def = true) {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const hint = def ? "Y/n" : "y/N";
  const answer = await new Promise((resolve) => {
    rl.question(`  ${c.bold(question)} ${c.gray(`(${hint})`)} `, resolve);
    rl.on("close", () => resolve(""));
  });
  rl.close();
  const a = String(answer).trim().toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes";
}
