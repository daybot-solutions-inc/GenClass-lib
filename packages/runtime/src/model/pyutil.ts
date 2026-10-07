// Python-semantics helpers for the ports of jev_local (serialize.py, confidence.py). The model was trained on
// text produced by Python from JSON rows, so wherever JS and Python format differently the Python behaviour (of the
// value after a JSON round trip) wins.

/** Characters Python's str.isspace() accepts (what str.strip() removes). JS trim() differs: it strips U+FEFF but
 * not U+001C..U+001F or U+0085. */
const PY_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Python str.strip() with no arguments. */
export function pyStrip(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && PY_SPACE.has(s.charCodeAt(a))) a++;
  while (b > a && PY_SPACE.has(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/**
 * Python's text for a JS number after a JSON round trip: JSON integers stay ints (`str(int)`), everything else is a
 * float and prints like `repr(float)` (shortest digits; exponent form when the exponent is < -4 or >= 16, with at
 * least two exponent digits). Non-finite numbers become JSON null; callers decide how null renders.
 */
export function pyNumber(x: number): string {
  const s = JSON.stringify(x);
  if (!/[.eE]/.test(s)) return s;
  return pyFloatRepr(x);
}

/** repr(float) for a finite double, from the shortest round-trip digits JS also uses. */
export function pyFloatRepr(x: number): string {
  let s = String(x);
  let sign = "";
  if (s[0] === "-") {
    sign = "-";
    s = s.slice(1);
  }
  let digits: string;
  let exp: number; // value = d.ddd x 10^exp
  const ei = s.indexOf("e");
  if (ei >= 0) {
    digits = s.slice(0, ei).replace(".", "");
    exp = Number(s.slice(ei + 1));
  } else {
    const dot = s.indexOf(".");
    const intPart = dot < 0 ? s : s.slice(0, dot);
    const all = intPart + (dot < 0 ? "" : s.slice(dot + 1));
    const nz = all.search(/[1-9]/);
    if (nz < 0) return `${sign}0.0`;
    exp = intPart.length - 1 - nz;
    digits = all.slice(nz);
  }
  digits = digits.replace(/0+$/, "") || "0";
  if (exp < -4 || exp >= 16) {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = Math.abs(exp);
    return `${sign}${mant}e${exp < 0 ? "-" : "+"}${e < 10 ? `0${e}` : e}`;
  }
  if (exp >= 0) {
    if (digits.length > exp + 1) return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
    return `${sign}${digits.padEnd(exp + 1, "0")}.0`;
  }
  return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
}

/** Python round(x, digits): half-even on exact binary ties (same as extension/core/pyutil.js). */
export function pyRound(x: number, digits = 2): number {
  const m = 10 ** digits;
  const y = x * m;
  const f = Math.floor(y);
  const d = y - f;
  const r = d === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(y);
  return r / m + 0;
}

/** Clip to [0, 1]; NaN -> 0; never -0. */
export const clip01 = (x: number): number => (Number.isNaN(x) ? 0 : Math.min(1, Math.max(0, x)) + 0);
