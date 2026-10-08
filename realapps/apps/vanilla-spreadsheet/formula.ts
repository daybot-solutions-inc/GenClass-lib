// Formula engine of the budget sheet: literals, cell refs (A1..E7), + - * / ( ), and SUM/AVG/MIN/MAX over ranges.
// Errors propagate as strings ("#CYCLE", "#VALUE", "#ERR"). Shared by the app and its manifest (relation check).

export type Val = number | string;
export const COLS = ["A", "B", "C", "D", "E"];
export const ROWS = 7;
export const IDS = Array.from({ length: ROWS }, (_, r) => COLS.map((c) => `${c}${r + 1}`)).flat();

const isErr = (v: Val) => typeof v === "string" && v.startsWith("#");

export function literal(raw: string): Val {
  const t = raw.trim();
  if (t === "") return "";
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : t;
}

function expand(a: string, b: string): string[] {
  const c0 = COLS.indexOf(a[0]!.toUpperCase());
  const c1 = COLS.indexOf(b[0]!.toUpperCase());
  const r0 = Number(a.slice(1));
  const r1 = Number(b.slice(1));
  const out: string[] = [];
  for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) out.push(`${COLS[c]}${r}`);
  return out;
}

/** Cells a formula reads (ranges expanded). */
export function refsIn(raw: string): string[] {
  if (!raw.startsWith("=")) return [];
  const out = new Set<string>();
  const body = raw.slice(1).replace(/([A-E][1-7]):([A-E][1-7])/gi, (_m, a: string, b: string) => {
    for (const id of expand(a, b)) out.add(id);
    return "0";
  });
  for (const m of body.matchAll(/\b([A-E][1-7])\b/gi)) out.add(m[1]!.toUpperCase());
  return [...out];
}

/** Evaluate one cell's raw text, reading other cells through `get`. */
export function evaluate(raw: string, get: (id: string) => Val): Val {
  if (!raw.startsWith("=")) return literal(raw);
  let err: string | null = null;
  const fail = (e: string) => {
    if (!err) err = e;
    return "0";
  };
  let src = raw.slice(1).replace(/\b(SUM|AVG|MIN|MAX)\(\s*([A-E][1-7])\s*:\s*([A-E][1-7])\s*\)/gi, (_m, fn: string, a: string, b: string) => {
    const vals = expand(a, b).map(get);
    const bad = vals.find(isErr);
    if (bad !== undefined) return fail(bad as string);
    const nums = vals.filter((v): v is number => typeof v === "number");
    const f = fn.toUpperCase();
    const r = f === "SUM" ? nums.reduce((s, x) => s + x, 0) : f === "AVG" ? (nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : 0) : nums.length ? (f === "MIN" ? Math.min(...nums) : Math.max(...nums)) : 0;
    return `(${r})`;
  });
  src = src.replace(/\b([A-E][1-7])\b/gi, (_m, id: string) => {
    const v = get(id.toUpperCase());
    if (isErr(v)) return fail(v as string);
    if (v === "") return "0";
    if (typeof v !== "number") return fail("#VALUE");
    return `(${v})`;
  });
  if (err) return err;
  // recursive descent over numbers, + - * / and parentheses
  let i = 0;
  const s = src.replace(/\s+/g, "");
  const peek = () => s[i];
  const number = (): number => {
    if (peek() === "(") {
      i++;
      const v = expr();
      if (peek() !== ")") throw new Error("paren");
      i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      return -number();
    }
    const m = /^\d+(\.\d+)?(e-?\d+)?/i.exec(s.slice(i));
    if (!m) throw new Error("number");
    i += m[0].length;
    return Number(m[0]);
  };
  const term = (): number => {
    let v = number();
    while (peek() === "*" || peek() === "/") {
      const op = s[i++];
      const w = number();
      v = op === "*" ? v * w : v / w;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = s[i++];
      const w = term();
      v = op === "+" ? v + w : v - w;
    }
    return v;
  };
  try {
    const v = expr();
    if (i !== s.length || !Number.isFinite(v)) return "#ERR";
    return Math.round(v * 1e6) / 1e6;
  } catch {
    return "#ERR";
  }
}

/** Values of every cell from the raw texts (memoised, cycles reported). */
export function computeAll(raws: Record<string, string>): Record<string, Val> {
  const out: Record<string, Val> = {};
  const visiting = new Set<string>();
  const val = (id: string): Val => {
    if (id in out) return out[id]!;
    const raw = raws[id] ?? "";
    if (!raw.startsWith("=")) return (out[id] = literal(raw));
    if (visiting.has(id)) return "#CYCLE";
    visiting.add(id);
    const v = evaluate(raw, val);
    visiting.delete(id);
    return (out[id] = v);
  };
  for (const id of IDS) val(id);
  return out;
}

export const sameVal = (a: Val, b: Val) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : a === b);
