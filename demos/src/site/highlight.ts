// Minimal TS/JS highlighter for the integration snippets (keywords, strings, comments, calls).
import { esc } from "./dom.ts";

const KW = new Set(
  "import from export const let var function async await return if else for of in new try catch finally throw typeof await while break continue default class extends interface type as".split(
    " ",
  ),
);

export function highlight(code: string): string {
  const out: string[] = [];
  const re = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|([A-Za-z_$][\w$]*)(\s*\()?|(\s+|[^\sA-Za-z_$"'`/]+|\/)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[1]) out.push(`<span class="c">${esc(m[1])}</span>`);
    else if (m[2]) out.push(`<span class="s">${esc(m[2])}</span>`);
    else if (m[3]) {
      const word = m[3];
      if (KW.has(word)) out.push(`<span class="k">${word}</span>${m[4] ? esc(m[4]) : ""}`);
      else if (m[4]) out.push(`<span class="f">${esc(word)}</span>${esc(m[4])}`);
      else out.push(esc(word));
    } else out.push(esc(m[0]));
  }
  return out.join("");
}
