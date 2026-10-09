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

export const REDACTED = "[redacted]";

export type Redactor = (path: string, value: unknown, kind?: "state" | "url" | "header" | "input") => unknown;

/** Words of an identifier: camelCase, snake_case, kebab-case and spaces split, lower-cased. */
export function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const SECRET_WORDS = new Set([
  "password",
  "passwd",
  "passcode",
  "passphrase",
  "pass",
  "pwd",
  "secret",
  "token",
  "cvv",
  "cvc",
  "csc",
  "ssn",
  "iban",
  "otp",
  "totp",
  "pin",
  "cookie",
  "authorization",
  "auth",
  "apikey",
  "creditcard",
  "cardnumber",
]);
/** Word pairs that name a secret ("card number", "api key", "session id", ...). */
const SECRET_PAIRS: [string, Set<string>][] = [
  ["card", new Set(["number", "num", "no", "cvc", "cvv", "code", "security"])],
  ["credit", new Set(["card"])],
  ["cc", new Set(["number", "num", "no", "exp", "csc"])],
  ["api", new Set(["key", "secret"])],
  ["private", new Set(["key"])],
  ["access", new Set(["key"])],
  ["secret", new Set(["key"])],
  ["session", new Set(["id", "token", "key"])],
  ["security", new Set(["code"])],
  ["one", new Set(["time"])],
  ["social", new Set(["security"])],
];

/**
 * Whether an identifier names a secret by its meaning (password, token, card number, cvv, ssn, iban, ...), not by
 * any substring: "author", "cards", "passengers" or a kanban "card" are not secrets.
 */
export function isSensitiveName(name: string): boolean {
  const hit = nameCache.get(name);
  if (hit !== undefined) return hit;
  const ws = words(name);
  let r = false;
  for (let i = 0; i < ws.length && !r; i++) {
    const w = ws[i];
    if (SECRET_WORDS.has(w)) r = true;
    else if (i + 1 < ws.length && isSecretPair(w, ws[i + 1])) r = true;
  }
  if (nameCache.size > 4096) nameCache.clear();
  nameCache.set(name, r);
  return r;
}
const nameCache = new Map<string, boolean>();

function isSecretPair(a: string, b: string): boolean {
  for (const [x, set] of SECRET_PAIRS) if (a === x && set.has(b)) return true;
  return false;
}

/** Container words that hold secrets and ordinary state alike (an `auth` slice: token, but also loading, user). */
const WEAK_CONTAINER = new Set(["auth", "authorization", "cookie", "session"]);
/** Opaque credential-looking strings (JWTs, API keys, session ids): ≥ 20 chars, letters and digits, no spaces. */
const OPAQUE = /^(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9_\-.+/=:]{20,}$/;
/** Field paths: dot-separated identifiers (free text such as 'input "Card number"' is matched by words). */
const PATH_LIKE = /^[^\s."']+(\.[^\s."']+)*$/;

/**
 * Whether the value at `path` is a secret, decided by the leaf field's name, never by the store's or a container's
 * name alone: `auth.token`, `form.password`, `payment.card.number` (a secret pair across the last two segments) are
 * secrets; `auth.loading`, `auth.user.name` are not. Array indices are skipped (`users.3.password`). Plain objects
 * are never redacted whole: their keys are judged one by one. Under a container whose name means a secret, strings,
 * numbers, bigints and arrays are redacted too (`credentials.password.value`, `payment.cvv.value = 123`,
 * `login.otp.code`, `account.password.history = [...]`), and under a broad one (`auth`, `session`, `cookie`) only
 * opaque credential-looking strings (`auth.tokens.access = "eyJ…"`). Booleans, null and undefined are never secrets.
 * Free text (an element description, a header line) is a secret when any of its words names one.
 */
export function isSensitivePath(path: string, value?: unknown): boolean {
  if (value === null || value === undefined || typeof value === "boolean") return false;
  if (!PATH_LIKE.test(path)) return isSensitiveName(path);
  const segs = path.split(".").filter((x) => !/^\d+$/.test(x));
  if (!segs.length) return false;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Map) && !(value instanceof Set)) return false;
  const leaf = segs[segs.length - 1];
  if (isSensitiveName(leaf)) return true;
  if (segs.length >= 2) {
    const a = words(segs[segs.length - 2]);
    const b = words(leaf);
    if (a.length && b.length && isSecretPair(a[a.length - 1], b[0])) return true;
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint" && !Array.isArray(value)) return false;
  for (let i = 0; i < segs.length - 1; i++) {
    if (!isSensitiveName(segs[i])) continue;
    const broad = words(segs[i]).every((w) => WEAK_CONTAINER.has(w) || !SECRET_WORDS.has(w));
    if (!broad) return true;
    if (typeof value === "string" && OPAQUE.test(value)) return true;
  }
  return false;
}

/** Default redactor: values whose leaf field names a secret (see isSensitivePath). */
export const defaultRedact: Redactor = (path, value) => (isSensitivePath(path, value) ? REDACTED : value);

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
  if (!Object.is(r, v)) return typeof r === "string" ? r : describe(r, "", () => r, max);
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

/**
 * Short slug ids (conservative): ≥ 4 chars of [A-Za-z0-9_-] with letters and digits where a part starts with a
 * digit ("tasks-1cam"), letters and digits alternate at least twice ("x7k2p", "ab12cd") or, from 6 chars, both
 * letter cases mix with digits ("PPBqWA9"). Words with a number suffix ("sha256", "oauth2", "ipv4", "item42")
 * and versions ("v1", "v2beta1") are not ids.
 */
function isSlugId(seg: string): boolean {
  if (seg.length < 4 || !/^[A-Za-z0-9_-]+$/.test(seg) || !/\d/.test(seg) || !/[A-Za-z]/.test(seg)) return false;
  if (/^v\d+([a-z]+\d*)?$/i.test(seg)) return false;
  for (const part of seg.split(/[-_]/)) {
    if (!part || !/\d/.test(part) || !/[A-Za-z]/.test(part)) continue;
    if (/^\d/.test(part)) return true;
    const transitions = (part.match(/[A-Za-z](?=\d)|\d(?=[A-Za-z])/g) ?? []).length;
    if (transitions >= 2) return true;
  }
  return seg.length >= 6 && /[a-z]/.test(seg) && /[A-Z]/.test(seg) && /\d/.test(seg);
}

/** True for path segments that look like ids (numbers, uuids, long hex, long mixed tokens, short slug ids). */
export function isIdSegment(seg: string): boolean {
  if (!seg) return false;
  return /^\d+$/.test(seg) || UUID.test(seg) || LONG_HEX.test(seg) || LONG_TOKEN.test(seg) || isSlugId(seg);
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

/**
 * Normalise a dotted store path for transition profiles: keys that look like ids, or contain a digit (entity keys
 * such as "m21", "u3x", "row7"), become ":id", so adding a new entity is the same shape as adding the previous one.
 */
export function normalizeFieldPath(path: string): string {
  return path
    .split(".")
    .map((s, i) => (i > 0 && (isIdSegment(s) || /\d/.test(s)) ? ":id" : s))
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
    // ws:// and wss:// on the page's host count as same-origin (WebSocket URLs use their own scheme)
    const sameOrigin = !b || b.origin === u.origin || (/^wss?:$/.test(u.protocol) && u.host === b.host);
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
  if (search.length > 4096) search = search.slice(0, 4096);
  if (!search || search === "?") return "";
  try {
    const p = new URLSearchParams(search);
    const parts: string[] = [];
    p.forEach((v, k) => {
      const r = redact(`query.${k}`, v);
      parts.push(`${k}=${!Object.is(r, v) ? REDACTED : v}`);
    });
    return truncate("?" + parts.join("&"), max);
  } catch {
    return truncate(search, max);
  }
}

export const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE"]);
