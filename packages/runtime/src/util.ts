// Small deterministic helpers shared by every module: hashing, value descriptions, URL signatures, redaction.

/** FNV-1a 32-bit over a string, as 8 hex chars. Deterministic across runtimes. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

const STRINGIFY_CAP = 65536;

/** Deterministic JSON-like serialization (sorted keys, cycles and exotic values handled), capped in length. */
export function stableStringify(v: unknown, cap = STRINGIFY_CAP): string {
  const out: string[] = [];
  let len = 0;
  const seen = new Set<unknown>();
  const push = (s: string) => {
    out.push(s);
    len += s.length;
  };
  const walk = (x: unknown): void => {
    if (len > cap) return;
    if (x === null) return push("null");
    switch (typeof x) {
      case "undefined":
        return push("undefined");
      case "string":
        return push(JSON.stringify(x.length > cap ? x.slice(0, cap) : x));
      case "number":
        return push(Number.isFinite(x) ? String(x) : `"${String(x)}"`);
      case "boolean":
        return push(x ? "true" : "false");
      case "bigint":
        return push(`${x}n`);
      case "function":
        return push('"[fn]"');
      case "symbol":
        return push('"[symbol]"');
    }
    if (seen.has(x)) return push('"[cycle]"');
    seen.add(x);
    if (Array.isArray(x)) {
      push("[");
      for (let i = 0; i < x.length; i++) {
        if (i) push(",");
        walk(x[i]);
        if (len > cap) break;
      }
      push("]");
    } else if (x instanceof Map) {
      push("Map{");
      let i = 0;
      for (const [k, val] of x) {
        if (i++) push(",");
        walk(k);
        push(":");
        walk(val);
        if (len > cap) break;
      }
      push("}");
    } else if (x instanceof Set) {
      push("Set[");
      let i = 0;
      for (const val of x) {
        if (i++) push(",");
        walk(val);
        if (len > cap) break;
      }
      push("]");
    } else if (x instanceof Date) {
      push(Number.isNaN(x.getTime()) ? '"Invalid Date"' : JSON.stringify(x.toISOString()));
    } else {
      const keys = Object.keys(x as object).sort();
      push("{");
      let i = 0;
      for (const k of keys) {
        if (i++) push(",");
        push(JSON.stringify(k));
        push(":");
        walk((x as Record<string, unknown>)[k]);
        if (len > cap) break;
      }
      push("}");
    }
    seen.delete(x);
  };
  walk(v);
  const s = out.join("");
  return len > cap ? `${s.slice(0, cap)}…${len}` : s;
}

export function hashValue(v: unknown): string {
  return fnv1a(stableStringify(v));
}

/** "string" | "number" | "boolean" | "null" | "undefined" | "array" | "object" | ... */
export function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Map) return "map";
  if (v instanceof Set) return "set";
  if (v instanceof Date) return "date";
  return typeof v;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

/** Seconds with 2 decimals below 10 s, 1 decimal above: "0.42s", "12.3s". */
export function secs(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? `${s.toFixed(2)}s` : s < 1000 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/** Signed relative time for timelines: "-1.24s". */
export function rel(ms: number): string {
  const s = Math.abs(ms) / 1000;
  const txt = s < 10 ? s.toFixed(2) : s.toFixed(1);
  return `${ms <= 0 ? "-" : "+"}${txt}s`;
}

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  const a = Math.abs(n);
  const d = a >= 100 ? 1 : a >= 1 ? 2 : 4;
  return String(Number(n.toFixed(d)));
}

export function ratio(a: number, b: number): string {
  if (b <= 0) return "∞";
  const r = a / b;
  return r >= 10 ? `${Math.round(r)}×` : `${r.toFixed(1)}×`;
}

export function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : many ?? one + "s"}`;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ------------------------------------------------------------------------------------------ redaction

export const SENSITIVE_KEY = /pass|token|secret|card|cvv|ssn|auth/i;
export const REDACTED = "[redacted]";

export type Redactor = (path: string, value: unknown) => unknown;

export const defaultRedact: Redactor = (path, value) => {
  const segs = path.split(".");
  for (const s of segs) if (SENSITIVE_KEY.test(s)) return REDACTED;
  return value;
};

// -------------------------------------------------------------------------------------- descriptions

const ID_KEYS = ["id", "_id", "key", "uuid", "slug", "name", "title", "label"];

function orderedKeys(o: Record<string, unknown>): string[] {
  const keys = Object.keys(o);
  const first = ID_KEYS.filter((k) => keys.includes(k));
  return [...first, ...keys.filter((k) => !first.includes(k))];
}

/** Compact one-line description of a value, redacting sensitive keys. */
export function describe(v: unknown, path: string, redact: Redactor, max = 80): string {
  const r = redact(path, v);
  if (r !== v) return typeof r === "string" ? r : describe(r, "", () => r, max);
  return truncate(desc(v, path, redact, 0, max), max);
}

function desc(v: unknown, path: string, redact: Redactor, depth: number, max: number): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(truncate(v, depth ? 24 : 48));
    case "number":
      return fmtNum(v);
    case "boolean":
      return String(v);
    case "bigint":
      return `${v}n`;
    case "function":
      return "function";
    case "symbol":
      return "symbol";
  }
  if (Array.isArray(v)) {
    if (depth > 0) return `[${v.length}]`;
    const n = v.length;
    if (n === 0) return "0 items";
    const parts: string[] = [];
    let used = 0;
    for (let i = 0; i < n && i < 3; i++) {
      const d = desc(v[i], `${path}.${i}`, redact, depth + 1, max);
      if (used + d.length > max - 16 && parts.length) break;
      parts.push(d);
      used += d.length + 2;
    }
    const more = n > parts.length ? ", …" : "";
    return `${plural(n, "item")} [${parts.join(", ")}${more}]`;
  }
  if (v instanceof Map) return `Map(${v.size})`;
  if (v instanceof Set) return `Set(${v.size})`;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
  const o = v as Record<string, unknown>;
  const keys = orderedKeys(o);
  if (keys.length === 0) return "{}";
  if (depth > 1) return `{${keys.length} keys}`;
  const parts: string[] = [];
  let used = 0;
  for (const k of keys) {
    const kp = path ? `${path}.${k}` : k;
    const rv = redact(kp, o[k]);
    const d = rv !== o[k] ? String(rv) : desc(o[k], kp, redact, depth + 1, max);
    const piece = `${k}: ${d}`;
    if (used + piece.length > (depth ? 40 : max - 12) && parts.length) break;
    parts.push(piece);
    used += piece.length + 2;
  }
  const rest = keys.length - parts.length;
  return `{${parts.join(", ")}${rest > 0 ? `, +${rest}` : ""}}`;
}

// -------------------------------------------------------------------------------------- URL signatures

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^(?=[0-9a-f]*\d)[0-9a-f]{8,}$/i;
const LONG_TOKEN = /^(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}$/;

/** True for path segments that look like ids (numbers, uuids, long hex, long mixed tokens). */
export function isIdSegment(seg: string): boolean {
  if (!seg) return false;
  return /^\d+$/.test(seg) || UUID.test(seg) || LONG_HEX.test(seg) || LONG_TOKEN.test(seg);
}

export function normalizePath(pathname: string): string {
  return pathname
    .split("/")
    .map((s) => {
      let d = s;
      try {
        d = decodeURIComponent(s);
      } catch {
        /* keep raw */
      }
      return isIdSegment(d) ? ":id" : s;
    })
    .join("/");
}

/** Normalise a dotted store path for profiles: id-like keys become ":id". */
export function normalizeFieldPath(path: string): string {
  return path
    .split(".")
    .map((s) => (isIdSegment(s) ? ":id" : s))
    .join(".");
}

export interface ParsedUrl {
  href: string;
  /** Path (or host+path when cross-origin). */
  where: string;
  search: string;
  sameOrigin: boolean;
}

export function parseUrl(raw: string, base: string | undefined): ParsedUrl {
  try {
    const u = new URL(raw, base ?? "http://localhost/");
    const b = base ? new URL(base) : null;
    const sameOrigin = !b || b.origin === u.origin;
    return {
      href: u.href,
      where: sameOrigin ? u.pathname : `${u.host}${u.pathname}`,
      search: u.search,
      sameOrigin,
    };
  } catch {
    const q = raw.indexOf("?");
    return { href: raw, where: q >= 0 ? raw.slice(0, q) : raw, search: q >= 0 ? raw.slice(q) : "", sameOrigin: true };
  }
}

/** "GET /api/items/:id" */
export function requestSignature(method: string, where: string): string {
  return `${method.toUpperCase()} ${normalizePath(where)}`;
}

/** Query string with sensitive parameter values redacted, truncated. */
export function redactSearch(search: string, redact: Redactor, max = 60): string {
  if (!search || search === "?") return "";
  try {
    const p = new URLSearchParams(search);
    const parts: string[] = [];
    p.forEach((v, k) => {
      const r = redact(`query.${k}`, v);
      parts.push(`${k}=${r !== v ? REDACTED : v}`);
    });
    return truncate("?" + parts.join("&"), max);
  } catch {
    return truncate(search, max);
  }
}

export const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"]);
